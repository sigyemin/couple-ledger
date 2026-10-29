// =====================================================================
// DB 호출 래퍼 (공통 컴포넌트 설계 v0.1 2장)
// - 화면은 supabase 클라이언트를 직접 쓰지 않고 이 모듈만 쓴다.
// - 필터는 { col, op, value } 목록으로만 받는다. 문자열로 필터를 조합하지 않는다(.or()에 사용자 입력 금지).
// - 이름(뷰·테이블·컬럼·RPC)은 형식 검사 후에만 넘긴다.
// - 결과는 항상 { data, error }. error는 AppError(errors.js).
// - 재시도: 네트워크 오류만 1회. 쓰기 RPC·update는 재시도하지 않는다(중복 쓰기 방지 — 결과를 다시 조회해 확인).
// - 여러 행·여러 테이블을 함께 바꾸는 작업은 RPC로만(원자성).
// 클라이언트는 밖에서 만들어 넘긴다(supabase-js v2 createClient, flowType 'pkce'). 키는 app/config.js 한 곳.
// 의존: errors.js
// =====================================================================
import { AppError, toAppError } from './errors.js';

const RE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const FILTER_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'ilike']);
const IS_VALUES = new Set([null, true, false]);

function assertName(kind, name) {
  if (typeof name !== 'string' || !RE_NAME.test(name)) throw new TypeError(`${kind} 이름 형식이 맞지 않습니다`);
}

/** ilike 인자용: 사용자 입력의 \ % _ 를 이스케이프한 뒤 앞뒤에 %를 붙인다 (부분 일치) */
export function likeContains(s) {
  return `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function checkFilters(filters) {
  if (!Array.isArray(filters)) throw new TypeError('filters는 배열이어야 합니다');
  for (const f of filters) {
    const { col, op, value } = f ?? {};
    assertName('컬럼', col);
    if (!FILTER_OPS.has(op)) throw new TypeError('허용하지 않는 필터 연산입니다');
    if (op === 'in' && !Array.isArray(value)) throw new TypeError('in 필터 값은 배열이어야 합니다');
    if (op === 'is' && !IS_VALUES.has(value)) throw new TypeError('is 필터 값은 null·true·false만 됩니다');
    if (op === 'ilike' && (typeof value !== 'string' || !/^%.*%$/s.test(value))) {
      throw new TypeError('ilike 값은 likeContains()로 만들어야 합니다');
    }
  }
}

function applyFilters(q, filters) {
  for (const { col, op, value } of filters) q = q[op](col, value);
  return q;
}

const ok = (data) => ({ data, error: null });
// 호출 형식이 틀린 경우(앱 버그). 원인 문장은 개발용으로만 쓰고 사용자에게는 일반 문구
const misuse = () => Promise.resolve({ data: null, error: new AppError('invalid', '입력값을 확인해 주세요') });

/**
 * @param client supabase-js v2 클라이언트 (from, rpc를 쓴다)
 */
export function createDb(client) {
  if (!client || typeof client.from !== 'function' || typeof client.rpc !== 'function') {
    throw new TypeError('supabase 클라이언트가 필요합니다');
  }

  async function run(fn, { retry }) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fn();
      } catch (e) {
        res = { data: null, error: e };
      }
      if (!res?.error) return ok(res?.data ?? null);
      const error = toAppError(res.error);
      if (retry && attempt === 0 && error.code === 'network') continue;
      return { data: null, error };
    }
  }

  return {
    /**
     * 조회. view: 뷰·테이블 이름
     * opts: { columns = '*', filters = [], order = [{ col, ascending }], range: { from, to } }
     */
    select(view, { columns = '*', filters = [], order = [], range } = {}) {
      try {
        assertName('뷰', view);
        checkFilters(filters);
        if (columns !== '*') String(columns).split(',').forEach((c) => assertName('컬럼', c.trim()));
        for (const o of order) assertName('컬럼', o?.col);
        if (range && !(Number.isInteger(range.from) && Number.isInteger(range.to) && range.from >= 0 && range.to >= range.from)) {
          throw new TypeError('range 값이 올바르지 않습니다');
        }
      } catch {
        return misuse();
      }
      return run(() => {
        let q = applyFilters(client.from(view).select(columns), filters);
        for (const o of order) q = q.order(o.col, { ascending: o.ascending !== false });
        if (range) q = q.range(range.from, range.to);
        return q;
      }, { retry: true });
    },

    /**
     * RPC 호출. 읽기 전용 RPC(find_*, missing_*, my_member_id 등)만 { retry: true }를 준다.
     */
    rpc(name, args = {}, { retry = false } = {}) {
      try {
        assertName('RPC', name);
        Object.keys(args).forEach((k) => assertName('인자', k));
      } catch {
        return misuse();
      }
      return run(() => client.rpc(name, args), { retry });
    },

    /** 한 행 수정 (id 기준). 재시도 없음 */
    update(table, id, patch) {
      try {
        assertName('테이블', table);
        if (typeof id !== 'string' || !id) throw new TypeError('id가 필요합니다');
        const keys = Object.keys(patch ?? {});
        if (!keys.length) throw new TypeError('바꿀 값이 없습니다');
        keys.forEach((k) => assertName('컬럼', k));
      } catch {
        return misuse();
      }
      return run(() => client.from(table).update(patch).eq('id', id).select(), { retry: false });
    },
  };
}
