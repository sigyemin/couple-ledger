// =====================================================================
// 거래 상세 — 금액·날짜·시각·가맹점 고치기, 화면 없이 계산하는 부분 (사용자 결정 U-17 D2, CL-045 J1~J9)
// - 고칠 수 있는 거래: 휴지통에 없고 이체가 아닌 것(직접 추가·업로드 모두)
// - 쓰기 = transactions update(바뀐 칸만 + updated_by). dedup_key는 바꾸지 않는다(같은 파일을 다시 올려도 다시 안 들어옴)
// - 가맹점: 업로드와 같은 정리 함수(matchNorm)로 merchant_norm도 함께. 민감번호면 앱이 막는다(자동 가림 안 함), 200자, 빈 값 금지
// - 금액: 라인 1개이고 그 금액이 옛 금액과 같으면 라인도 새 금액으로(set_transaction_lines, 두 번째 요청).
//         그 밖에 라인이 있으면 저장 전에 '한 카테고리로 합치기 / 저장 뒤 나누기 다시' 중 고른다
// - 날짜: 귀속월 = coalesce(attributed_on, occurred_on). 연결된 환불은 원거래의 달을 따른다(트리거) → 날짜를 바꿔도 달은 그대로
//         원거래 날짜를 바꾸면 연결된 환불도 그 달로 옮겨진다(로컬 DB 확인)
// - 검토 상태는 바꾸지 않는다
// - '파일 값에서 고침': 업로드 거래이고 수정 기록(txn_edit_log)에 그 칸이 있으면(값은 기록에 없어 비교하지 않음 — 되돌려도 남는다)
// 의존: core/validate.js, core/format.js, import/formats.js
// =====================================================================
import { amount as checkAmount, text as checkText, date as checkDate } from '../core/validate.js';
import { won, month } from '../core/format.js';
import { matchNorm } from '../import/formats.js';

const RE_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const shortMonth = (m) => month(m).replace(/^[0-9]+년 /, '');
const monthOfDate = (d) => `${String(d).slice(0, 7)}-01`;

/** 금액·날짜·가맹점을 고칠 수 있는가 (이체·휴지통은 안 됨) */
export function canEditValues(row) {
  return row.deleted_at == null && row.kind !== 'transfer';
}

/** 편집 칸의 처음 값 */
export function valuesDraft(row) {
  return {
    date: row.occurred_on,
    time: row.occurred_time ? String(row.occurred_time).slice(0, 5) : '',
    merchant: row.merchant_raw ?? '',
    amountText: String(Number(row.amount)),
  };
}

/** 라인 처리 계획 (J3) */
export function linesPlan(row, newAmount) {
  const lines = Array.isArray(row.lines) ? row.lines : [];
  if (newAmount === Number(row.amount) || lines.length === 0) return { type: 'none' };
  if (lines.length === 1 && Number(lines[0].amount) === Number(row.amount)) {
    const l = lines[0];
    return { type: 'auto', lines: [{ category_id: l.category_id, amount: newAmount, item_note: l.item_note ?? null }] };
  }
  return { type: 'choose', count: lines.length };
}

/**
 * 입력 검사 → update 값
 * form: { date, time, merchant, amountText }, today: 'YYYY-MM-DD'(서울, 날짜 범위 검사)
 * @returns {{ ok: true, patch, changed: string[], amount, plan, monthFrom, monthTo } | { ok: false, field, message }}
 *   changed: 'amount' | 'date' | 'time' | 'merchant'
 *   monthFrom·monthTo: 귀속월이 바뀌면 둘 다, 아니면 null
 */
export function buildValuesPatch(row, form, memberId, today = null) {
  const bad = (field, message) => ({ ok: false, field, message });
  // 날짜 범위(직접 추가와 같은 규칙)는 날짜를 바꿀 때만 본다 — 이미 들어온 범위 밖 거래도 다른 칸은 고칠 수 있게
  const d = checkDate(form.date, { today: form.date !== row.occurred_on ? today : null });
  if (!d.ok) return bad('date', d.message);
  const time = String(form.time ?? '').trim();
  if (time && !RE_TIME.test(time)) return bad('time', '시각은 HH:MM으로 입력해 주세요');
  const m = checkText(form.merchant, 'merchant', { required: true });
  if (!m.ok) return bad('merchant', m.message);
  const a = checkAmount(form.amountText);
  if (!a.ok) return bad('amount', a.message);
  if (a.value === 0) return bad('amount', '0원으로는 바꿀 수 없어요');

  const patch = {};
  const changed = [];
  if (a.value !== Number(row.amount)) { patch.amount = a.value; changed.push('amount'); }
  if (d.value !== row.occurred_on) { patch.occurred_on = d.value; changed.push('date'); }
  const oldTime = row.occurred_time ? String(row.occurred_time).slice(0, 5) : '';
  if (time !== oldTime) { patch.occurred_time = time ? `${time}:00` : null; changed.push('time'); }
  if (m.value !== row.merchant_raw) {
    patch.merchant_raw = m.value;
    patch.merchant_norm = matchNorm(m.value);
    changed.push('merchant');
  }
  if (changed.length === 0) return bad(null, '바뀐 내용이 없어요');
  patch.updated_by = memberId;
  // 연결된 환불의 달은 원거래를 따른다(attributed_on) → 날짜를 바꿔도 달은 그대로
  const follows = row.kind === 'refund' && row.refund_of_txn_id != null;
  const monthTo = monthOfDate(d.value);
  const moved = !follows && changed.includes('date') && monthTo !== row.period_month;
  return {
    ok: true, patch, changed, amount: a.value, plan: linesPlan(row, a.value),
    monthFrom: moved ? row.period_month : null, monthTo: moved ? monthTo : null,
  };
}

/**
 * 저장 전 확인 문구. 확인이 필요 없으면 null(가맹점·시각만 바꾸고 정산 영향이 없을 때)
 * @param v buildValuesPatch 결과(ok)
 * @param reviewStates Map(period_month → review_state)
 * @param refunds 이 거래에 연결된 환불(원거래일 때)
 * @param choice 라인 고르기(choose)에서 고른 값 'merge' | 'resplit'
 */
export function valuesConfirmText(row, v, reviewStates, refunds = [], choice = null) {
  const parts = [];
  const follows = row.kind === 'refund' && row.refund_of_txn_id != null;
  if (v.changed.includes('amount')) parts.push(`금액을 ${won(Number(row.amount))}에서 ${won(v.amount)}(으)로 바꿔요.`);
  if (v.monthFrom) {
    parts.push(`집계하는 달이 ${shortMonth(v.monthFrom)}에서 ${shortMonth(v.monthTo)}(으)로 바뀌어요.`);
    if (refunds.length) parts.push(`연결된 환불 ${refunds.length}건도 ${shortMonth(v.monthTo)}로 옮겨져요.`);
  } else if (follows && v.changed.includes('date')) {
    parts.push(`이 환불은 원거래의 달(${shortMonth(row.period_month)})에 집계돼요. 날짜를 바꿔도 달은 그대로예요.`);
  }
  if (v.plan.type === 'auto') parts.push('카테고리 금액도 새 금액으로 맞춰요.');
  if (v.plan.type === 'choose' && choice === 'merge') parts.push(`나눈 ${v.plan.count}줄을 한 카테고리로 합쳐요.`);
  if (v.plan.type === 'choose' && choice === 'resplit') parts.push('저장한 뒤 금액 나누기로 다시 나눠 주세요.');
  // 정산 영향(F10): 공동·비제외 거래의 금액·달이 바뀌면 확인 완료 달은 '확인 후 변경됨'
  const settles = row.is_shared && !row.is_excluded && (row.kind === 'expense' || row.kind === 'refund');
  if (settles && (v.changed.includes('amount') || v.monthFrom)) {
    const months = [...new Set([row.period_month, v.monthTo].filter(Boolean))].sort()
      .filter((x) => reviewStates.get(x) === 'reviewed' || reviewStates.get(x) === 'changed_after_review');
    if (months.length) parts.push(`${months.map(shortMonth).join(', ')}은 확인을 마친 달이라 정산이 바뀌고 '확인 후 변경됨'으로 표시돼요.`);
  }
  const needs = v.changed.includes('amount') || v.monthFrom || (follows && v.changed.includes('date'));
  if (!needs) return null;
  return { title: '거래 값 고치기', message: parts.join(' ') };
}

/** 선택(choose)일 때 라인 값: 'merge' + 카테고리 → 한 줄, 'resplit' → 라인은 그대로(저장 뒤 나누기) */
export function chosenLines(choice, categoryId, amount) {
  if (choice === 'merge') return categoryId ? { ok: true, lines: [{ category_id: categoryId, amount, item_note: null }] } : { ok: false, message: '합칠 카테고리를 골라 주세요' };
  if (choice === 'resplit') return { ok: true, lines: null };
  return { ok: false, message: '나눈 금액을 어떻게 할지 골라 주세요' };
}

/** 저장 오류 안내(LG003: 환불·원거래 금액 제약, LG002: 민감번호) */
export function valuesErrorText(err, row) {
  const code = err?.detail?.sqlState ?? err?.code;
  if (code === 'LG003') {
    return row.kind === 'refund'
      ? '원거래 금액을 넘는 환불 금액은 저장할 수 없어요.'
      : '연결된 환불 합계보다 작은 금액으로는 바꿀 수 없어요. 환불을 먼저 정리해 주세요.';
  }
  if (code === 'LG002') return '가맹점에 카드·계좌·전화번호로 보이는 숫자가 있어 저장하지 않았어요.';
  if (code === 'LG005') return '휴지통에 있는 거래라 바꿀 수 없어요. 새로고침해 확인해 주세요.'; // v0.18
  return null;
}

const FILE_FIELDS = [['amount', '금액'], ['occurred_on', '날짜'], ['occurred_time', '시각'], ['merchant_raw', '가맹점']];

/** 업로드 거래에서 고친 칸 이름(J2): 수정 기록에 그 칸이 있으면. 직접 추가 거래는 빈 목록 */
export function editedFromFile(row, edits) {
  if (row.origin !== 'import') return [];
  const seen = new Set((edits ?? []).flatMap((e) => e.changed_fields ?? []));
  return FILE_FIELDS.filter(([f]) => seen.has(f)).map(([, label]) => label);
}

/** 라인 합계가 거래 금액과 다른가(나눈 금액이 안 맞음 — 월 검토 불일치 목록에도 나옴) */
export function linesMismatch(row) {
  const lines = Array.isArray(row.lines) ? row.lines : [];
  if (lines.length === 0) return false;
  return lines.reduce((s, l) => s + Number(l.amount), 0) !== Number(row.amount);
}
