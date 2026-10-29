// =====================================================================
// 해시 라우터 (공통 컴포넌트 설계 v0.1 0장: GitHub Pages는 서버 쪽 경로 재작성이 없어 해시를 쓴다)
// 주소: #/<화면>[/<id>][?키=값&…]  예) #/home?month=2026-10, #/list?status=needs_review, #/txn/<uuid>
// - 화면 이름·id·쿼리 값은 형식 검사 후에만 넘긴다(모르는 화면은 홈)
// - 필터 상태는 쿼리에 담아 뒤로 가기·새로고침에도 남는다(설계 8장)
// 의존 없음.
// =====================================================================

export const SCREENS = Object.freeze(['home', 'list', 'txn', 'add', 'upload', 'settle', 'more', 'categories', 'trash', 'changes', 'change', 'review', 'rules', 'rule', 'rulenew', 'reapply']);
// id를 받는 화면 → id가 틀리면 갈 목록 화면
const ID_SCREENS = Object.freeze({ txn: 'list', change: 'changes', rule: 'rules', reapply: 'rules' });
const RE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RE_KEY = /^[a-z][a-z_]{0,23}$/;
const MAX_VALUE = 100;

/** 해시 문자열 → { screen, id, query(Map) } */
export function parseHash(hash) {
  const raw = String(hash ?? '').replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?', 2);
  const [name, id] = path.split('/');
  const query = new Map();
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=', 2);
    let key;
    let value;
    try {
      key = decodeURIComponent(k);
      value = decodeURIComponent(v);
    } catch {
      continue;
    }
    if (RE_KEY.test(key) && value.length <= MAX_VALUE && !query.has(key)) query.set(key, value);
  }
  if (!SCREENS.includes(name)) return { screen: 'home', id: null, query };
  if (name in ID_SCREENS) return RE_ID.test(id ?? '') ? { screen: name, id, query } : { screen: ID_SCREENS[name], id: null, query };
  return { screen: name, id: null, query };
}

/** { screen, id, query(Map|object) } → '#/…' */
export function buildHash(screen, { id = null, query = {} } = {}) {
  const entries = query instanceof Map ? [...query] : Object.entries(query);
  const qs = entries
    .filter(([k, v]) => RE_KEY.test(k) && v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `#/${screen}${id ? `/${id}` : ''}${qs ? `?${qs}` : ''}`;
}

const RE_MONTH = /^([0-9]{4})-(0[1-9]|1[0-2])$/;

/** 'YYYY-MM' → 'YYYY-MM-01' (형식이 틀리면 fallback) */
export function monthParam(v, fallback) {
  return RE_MONTH.test(v ?? '') ? `${v}-01` : fallback;
}

/** 'YYYY-MM-01' 기준으로 n달 앞뒤 */
export function addMonths(monthStart, n) {
  const [y, m] = monthStart.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}-01`;
}

/** 오늘(서울 시각)의 달 'YYYY-MM-01' */
export function currentMonth(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit' }).formatToParts(now);
  const get = (t) => p.find((x) => x.type === t).value;
  return `${get('year')}-${get('month')}-01`;
}

/**
 * 라우터 시작. render(route)는 화면을 그린다(비동기 가능). 빠르게 바뀌면 앞 화면 결과는 버린다
 * @returns {{ go(hash), reload(), stop() }}
 */
export function startRouter(render, env = globalThis) {
  let seq = 0;
  const onChange = async () => {
    const mine = ++seq;
    await render(parseHash(env.location.hash), () => mine === seq);
  };
  env.addEventListener('hashchange', onChange);
  onChange();
  return {
    go(hash) {
      if (env.location.hash === hash) onChange(); // 같은 주소면 hashchange가 없어 직접 다시 그린다
      else env.location.hash = hash;
    },
    reload() {
      onChange();
    },
    stop() {
      env.removeEventListener('hashchange', onChange);
    },
  };
}
