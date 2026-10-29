// =====================================================================
// 입력 검증 (공통 컴포넌트 설계 v0.1 6장)
// 화면 검증은 안내용이고 최종 판정은 DB 제약·트리거다. 규칙은 데이터 표준 사전 도메인·schema.sql CHECK와 맞춘다.
// 결과: { ok: true, value } 또는 { ok: false, reason, message }
//   reason: required | invalid | too_long | sensitive
// 의존: sensitive.js, format.js (둘 다 의존 없음)
// =====================================================================
import { hasSensitiveNumber } from './sensitive.js';
import { parseDateOnly } from './format.js';

const ok = (value) => ({ ok: true, value });
const fail = (reason, message) => ({ ok: false, reason, message });

export const MESSAGES = Object.freeze({
  required: '값을 입력해 주세요',
  invalid: '입력값을 확인해 주세요',
  too_long: '글자 수가 너무 많습니다',
  sensitive: '카드·계좌·전화번호로 보이는 숫자가 있어 저장할 수 없습니다',
  amount: '금액은 0 이상의 정수(14자리 이하)로 입력해 주세요',
  ratio: '비율은 0~100, 소수 둘째 자리까지 입력해 주세요',
  date: '실제 있는 날짜(YYYY-MM-DD)를 입력해 주세요',
  transfer_reason: '이체는 이체 성격의 제외 사유(카드대금·계좌 간 이동·개인 송금)가 필요합니다',
  exclude_reason: '제외하려면 사유를 골라 주세요',
});

// AMT: numeric(14, 0), 0 이상
const MAX_AMOUNT = 10 ** 14 - 1; // 14자리 최댓값

/** 금액: 0 이상 정수, 14자리 이하. 문자열이면 콤마·공백·'원'을 지운 뒤 판단 */
export function amount(v) {
  let n = v;
  if (typeof v === 'string') {
    const s = v.normalize('NFKC').replace(/[, 원]/g, '');
    if (!/^[0-9]+$/.test(s)) return fail('invalid', MESSAGES.amount);
    n = Number(s);
  }
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_AMOUNT) return fail('invalid', MESSAGES.amount);
  return ok(n);
}

/** 비율(RT): numeric(5, 2), 0~100 */
export function ratio(v) {
  const s = typeof v === 'number' ? String(v) : String(v ?? '').trim();
  if (!/^[0-9]{1,3}(\.[0-9]{1,2})?$/.test(s)) return fail('invalid', MESSAGES.ratio);
  const n = Number(s);
  if (n < 0 || n > 100) return fail('invalid', MESSAGES.ratio);
  return ok(n);
}

/** 일자(DT): 실제 있는 날짜만 (2026-02-30 거부) */
export function date(v) {
  return parseDateOnly(v) ? ok(v) : fail('invalid', MESSAGES.date);
}

// 자유 입력 길이 (설계 v0.1 6장 [제안] + schema.sql CHECK가 있는 칸은 그 값)
export const TEXT_LIMITS = Object.freeze({
  merchant: 200,
  memo: 500,
  alias: 50, // counterparty_rules.alias
  display_name: 20, // members.display_name
  description: 200, // change_batches.description
  match_text: 100, // counterparty_rules.match_text
});

/**
 * 자유 입력 텍스트: 길이 + 민감번호 검사.
 * kind: TEXT_LIMITS의 키. required = true면 빈 값 거부.
 */
export function text(v, kind, { required = false } = {}) {
  const limit = TEXT_LIMITS[kind];
  if (limit === undefined) throw new TypeError(`알 수 없는 입력 종류: ${kind}`);
  const s = String(v ?? '').normalize('NFKC').trim();
  if (!s) return required ? fail('required', MESSAGES.required) : ok('');
  if ([...s].length > limit) return fail('too_long', `${MESSAGES.too_long} (${limit}자 이하)`);
  if (hasSensitiveNumber(s)) return fail('sensitive', MESSAGES.sensitive);
  return ok(s);
}

// 코드 값 (데이터 표준 사전 5장)
export const CODES = Object.freeze({
  source_kind: ['credit_card', 'check_card', 'bank_account', 'cash'],
  txn_kind: ['expense', 'refund', 'income', 'transfer'],
  review_status: ['auto', 'needs_review', 'confirmed'],
  exclude_reason: ['card_bill', 'check_card', 'internal_transfer', 'personal_transfer', 'other'],
  origin: ['import', 'manual'],
  browser_kind: ['chrome_desktop', 'chrome_android', 'samsung', 'other'],
  member_slot: [1, 2],
});

export const TRANSFER_REASONS = Object.freeze(['card_bill', 'internal_transfer', 'personal_transfer']);

/** 코드(CD): 값 목록 안의 값만 */
export function code(v, domain) {
  const list = CODES[domain];
  if (!list) throw new TypeError(`알 수 없는 코드 종류: ${domain}`);
  return list.includes(v) ? ok(v) : fail('invalid', MESSAGES.invalid);
}

/**
 * C9 규칙 (schema.sql ck_txn_excluded_reason, ck_txn_transfer_reason과 같은 조건)
 *   제외 ⇔ 사유 있음, 이체 ⇔ 이체 성격 사유
 */
export function exclusion({ kind, isExcluded, excludeReason }) {
  const reason = excludeReason ?? null;
  if (reason !== null && !CODES.exclude_reason.includes(reason)) return fail('invalid', MESSAGES.invalid);
  if (kind === 'transfer' && !TRANSFER_REASONS.includes(reason)) return fail('invalid', MESSAGES.transfer_reason);
  if (kind !== 'transfer' && TRANSFER_REASONS.includes(reason)) return fail('invalid', MESSAGES.transfer_reason);
  if (Boolean(isExcluded) !== (reason !== null)) return fail('invalid', MESSAGES.exclude_reason);
  return ok({ kind, isExcluded: Boolean(isExcluded), excludeReason: reason });
}
