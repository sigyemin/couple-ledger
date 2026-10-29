// =====================================================================
// 오류 처리·기록 (공통 컴포넌트 설계 v0.1 3장 + PM 회신 P7, schema.sql 8장)
// - AppError: 화면에 보여 줄 문장(message)과 분류(code)만 갖는다.
//   DB·네트워크의 원본 오류 메시지는 담지 않는다(입력 값이 섞일 수 있음). 남기는 것은 SQLSTATE뿐.
// - 기록: 내용 대신 번호로 추적. 코드·단계·동작·참조 번호·trace id·앱 버전·브라우저만 보낸다.
//   C(구성원 오류) → log_member_error, A(로그인 전 오류) → log_auth_error.
//   B(미등록 계정)는 따로 기록하지 않는다(관리자가 admin_unbound_auth_users()로 조회).
// - 기록 실패는 화면 동작을 막지 않는다(삼킨다).
// 의존: sensitive.js
// =====================================================================
import { hasSensitiveNumber } from './sensitive.js';

export const APP_VERSION = '0.1.0';

// SQLSTATE → 분류·안내 문구 (설계 3장 표, 데이터 표준 사전 6장)
const BY_SQLSTATE = Object.freeze({
  LG002: ['sensitive', '카드·계좌·전화번호로 보이는 숫자가 있어 저장하지 않았습니다'],
  LG003: ['refund_invalid', '원거래와 맞지 않는 환불입니다'],
  LG004: ['delete_blocked', '삭제는 휴지통으로만 됩니다'],
  LG005: ['immutable', '이 값은 바꿀 수 없습니다'],
  LG006: ['revert_invalid', '이미 되돌렸거나 없는 변경입니다'],
  LG007: ['bulk_invalid', '없거나 휴지통에 있는 거래가 있어 아무것도 바꾸지 않았습니다'],
  42501: ['forbidden', '접근 권한이 없습니다'],
  23505: ['duplicate', '이미 있는 항목입니다'],
  23514: ['invalid', '입력값을 확인해 주세요'],
  22023: ['invalid', '입력값을 확인해 주세요'],
});

const NETWORK = ['network', '연결이 원활하지 않습니다. 잠시 후 다시 시도해 주세요'];
const UNKNOWN = ['unknown', '잠시 후 다시 시도해 주세요'];

export class AppError extends Error {
  /**
   * @param {string} code    분류 (sensitive, forbidden, network, unknown …)
   * @param {string} message 사용자에게 보여 줄 문장
   * @param {{ sqlState?: string }} [detail] 개발용. SQLSTATE만
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail.sqlState ? { sqlState: detail.sqlState } : {};
  }
}

const RE_SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * supabase-js의 error 객체(또는 throw된 예외)를 AppError로 바꾼다.
 * - code가 SQLSTATE 5자면 표로 분류
 * - code가 없고 fetch 실패(TypeError·AbortError·메시지에 fetch/network)면 네트워크 오류, 아니면 unknown
 *   [추정: postgrest-js는 fetch 실패 시 code를 빈 문자열, message를 'TypeError: Failed to fetch' 꼴로 준다. 실환경 미확인]
 */
export function toAppError(err) {
  if (err instanceof AppError) return err;
  const raw = typeof err?.code === 'string' ? err.code : '';
  if (!raw) {
    // 원문 메시지는 분류에만 쓰고 담지 않는다
    const net = err instanceof TypeError || err?.name === 'AbortError'
      || /fetch|network/i.test(String(err?.message ?? ''));
    const [code, message] = net ? NETWORK : UNKNOWN;
    return new AppError(code, message);
  }
  const sqlState = RE_SQLSTATE.test(raw) ? raw : undefined;
  const [code, message] = (sqlState && BY_SQLSTATE[sqlState]) || UNKNOWN;
  return new AppError(code, message, { sqlState });
}

/** 네트워크 오류인지 (읽기 재시도 판단용) */
export function isNetworkError(err) {
  return toAppError(err).code === 'network';
}

// ---------------------------------------------------------------------
// 기록
// ---------------------------------------------------------------------
// stage_code·action_code 목록은 앱이 상수로 관리한다(데이터 표준 사전 5장). 화면이 늘면 여기에 추가
export const STAGES = Object.freeze({
  auth_login: 'auth_login',
  auth_member: 'auth_member',
  boot: 'boot',
  db_select: 'db_select',
  db_rpc: 'db_rpc',
  db_update: 'db_update',
  import_parse: 'import_parse',
  import_save: 'import_save',
  list: 'list',
  settle: 'settle',
});

export const ACTIONS = Object.freeze({
  login: 'login',
  upload: 'upload',
  bulk_edit: 'bulk_edit',
  revert: 'revert',
  confirm_month: 'confirm_month',
  link_refund: 'link_refund',
});

const RE_ERROR_CODE = /^[A-Z0-9_]{2,24}$/;
const RE_STAGE = /^[a-z][a-z0-9_]{0,31}$/;
const RE_VERSION = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** userAgent → browser_kind (chrome_desktop | chrome_android | samsung | other) */
export function browserKind(userAgent = globalThis.navigator?.userAgent ?? '') {
  const ua = String(userAgent);
  if (/SamsungBrowser\//.test(ua)) return 'samsung';
  if (!/Chrome\//.test(ua) || /Edg\/|OPR\/|Whale\//.test(ua)) return 'other';
  return /Android/.test(ua) ? 'chrome_android' : 'chrome_desktop';
}

/** 사용자 동작 1회(업로드 1회 등)마다 하나 발급 */
export function newTraceId() {
  return globalThis.crypto.randomUUID();
}

/** 화면에 보여 줄 오류 번호 (사용자가 캡처로 전달). 예: 'LG002 · 3f2a9c1e' */
export function displayCode(err, traceId) {
  const e = toAppError(err);
  const head = e.detail.sqlState ?? e.code.toUpperCase();
  return traceId ? `${head} · ${String(traceId).slice(0, 8)}` : head;
}

/** AppError → DB에 보낼 error_code (SQLSTATE가 있으면 그것, 없으면 분류를 대문자로) */
export function errorCode(err) {
  const e = toAppError(err);
  return e.detail.sqlState ?? e.code.toUpperCase();
}

function fieldsValid({ error_code, stage_code, action_code }) {
  return RE_ERROR_CODE.test(error_code)
    && RE_STAGE.test(stage_code)
    && (action_code == null || RE_STAGE.test(action_code))
    && !hasSensitiveNumber(error_code) && !hasSensitiveNumber(stage_code) && !hasSensitiveNumber(action_code);
}

const optUuid = (v) => (typeof v === 'string' && RE_UUID.test(v) ? v : null);

/**
 * 기록기. rpc(name, args)는 supabase client.rpc와 같은 모양({ data, error })이면 된다.
 * 반환 함수들은 throw하지 않고 true(기록) / false(버림·실패)를 돌려준다.
 */
export function createErrorLogger({ rpc, appVersion = APP_VERSION, userAgent, onDevLog } = {}) {
  if (typeof rpc !== 'function') throw new TypeError('rpc 함수가 필요합니다');
  if (!RE_VERSION.test(appVersion)) throw new TypeError('앱 버전 형식이 맞지 않습니다');
  const browser = browserKind(userAgent);

  async function send(name, args) {
    try {
      const { data, error } = await rpc(name, args);
      if (error) {
        onDevLog?.('log_failed', name);
        return false;
      }
      return data === true;
    } catch {
      onDevLog?.('log_failed', name);
      return false;
    }
  }

  return {
    /** C: 로그인 후 구성원 오류 */
    async member(err, { stage, action = null, traceId, txnId, batchId, rowNo, changeBatchId } = {}) {
      const e = toAppError(err);
      const fields = { error_code: errorCode(e), stage_code: stage, action_code: action };
      if (!fieldsValid(fields) || !RE_UUID.test(traceId ?? '')) return false;
      const row = Number.isInteger(rowNo) && rowNo >= 1 && rowNo <= 100000 ? rowNo : null;
      return send('log_member_error', {
        p_error_code: fields.error_code,
        p_sql_state: e.detail.sqlState ?? null,
        p_stage_code: stage,
        p_action_code: action,
        p_browser_kind: browser,
        p_app_version: appVersion,
        p_trace_id: traceId,
        p_txn_id: optUuid(txnId),
        p_batch_id: optUuid(batchId),
        p_row_no: row,
        p_change_batch_id: optUuid(changeBatchId),
      });
    },
    /** A: 로그인 전 오류 (신원 없음) */
    async auth(err, { stage, traceId } = {}) {
      const fields = { error_code: errorCode(err), stage_code: stage, action_code: null };
      if (!fieldsValid(fields) || !RE_UUID.test(traceId ?? '')) return false;
      return send('log_auth_error', {
        p_error_code: fields.error_code,
        p_stage_code: stage,
        p_browser_kind: browser,
        p_app_version: appVersion,
        p_trace_id: traceId,
      });
    },
  };
}
