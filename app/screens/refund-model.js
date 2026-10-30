// =====================================================================
// 환불 원거래 — 화면 없이 계산하는 부분
//   원거래 찾기(화면 설계 v0.1 4-6, 시안 8) + 체크카드 취소 연결 제안(CL-034 설계, 시안 27) + 일괄 연결(사용자 결정 U-13 F1, 10-30)
// 제안 조건(설계 2장, 사용자 결정 F2 = 90일, F3 = 체크카드 취소만):
//   1 환불: 휴지통 아님·kind refund·연결 없음·card_kind = check_card·검토 대기(테스트 결제수단 아님)
//   2 후보: find_refund_candidates 기본 범위(같은 결제수단·지출·환불일 전 90일·남은 금액 ≥ 환불액). 넓히기(1년)는 제안에 쓰지 않음
//   3 그중 merchant_rank = 1 이고 match_reasons에 same_amount인 행이 정확히 1개
//   4 같은 달의 다른 미연결 환불이 같은 원거래를 제안받으면 둘 다 제안 없음
// 연결 = link_refund 다음 review_status = confirmed(link_refund는 검토 상태를 바꾸지 않음 — 설계 2-1 [사실])
// 원거래 없음 = review_status = confirmed (환불일 달에 둔다)
// 일괄 연결: 제안된 건만, 확인 창에 (환불 → 원거래) 전체 목록, 건마다 link + confirmed, 재시도 없음, 중간 실패면 멈춤, 상한 MAX_BULK
// 의존: core/format.js, screens/list-model.js(MAX_BULK)
// =====================================================================
import { won, day, month } from '../core/format.js';
import { MAX_BULK } from './list-model.js';

export { MAX_BULK };
export const SUGGEST_CALL_LIMIT = 50; // 한 달에 후보를 물어볼 체크카드 취소 수 상한(월 약 3건 — QA O4)

const REASON = { same_merchant: '같은 가맹점', similar_merchant: '비슷한 가맹점', same_amount: '같은 금액' };
const monthOf = (d) => `${String(d).slice(0, 7)}-01`;
const shortDay = (d) => day(d).replace(/ \(.\)$/, '');

/** 제안 대상 환불인지(조건 1) */
export function isSuggestTarget(r) {
  return r?.kind === 'refund' && !r.refund_of_txn_id && !r.deleted_at && r.card_kind === 'check_card'
    && r.review_status === 'needs_review' && !r.is_test_source;
}

/** 후보 목록 → 조건 3. { suggest: 후보|null, same: 같은 가맹점·같은 금액 후보들 } */
export function suggestFrom(candidates) {
  const same = (candidates ?? []).filter((c) => Number(c.merchant_rank) === 1 && (c.match_reasons ?? []).includes('same_amount'));
  return { suggest: same.length === 1 ? same[0] : null, same };
}

/**
 * 한 달 묶음의 제안(조건 3 + 4)
 * @param byRefund Map(환불 id → 후보 목록)
 * @returns Map(환불 id → { suggest, same, conflict })
 */
export function monthSuggestions(byRefund) {
  const out = new Map();
  const count = new Map();
  for (const [id, cands] of byRefund) {
    const s = suggestFrom(cands);
    out.set(id, { ...s, conflict: false });
    if (s.suggest) count.set(s.suggest.txn_id, (count.get(s.suggest.txn_id) ?? 0) + 1);
  }
  for (const v of out.values()) {
    if (v.suggest && count.get(v.suggest.txn_id) > 1) { v.suggest = null; v.conflict = true; }
  }
  return out;
}

/** 제안 상자 문구 */
export function suggestionText(s) {
  if (s?.suggest) {
    return {
      kind: 'suggest',
      title: '이 결제와 연결할까요?',
      what: `${shortDay(s.suggest.occurred_on)} ${s.suggest.merchant_raw} ${won(Number(s.suggest.amount))}`,
      why: '같은 결제수단 · 같은 가맹점 · 같은 금액은 이 결제 하나뿐이에요',
    };
  }
  if (s?.conflict) return { kind: 'note', text: '같은 결제가 다른 환불에도 맞아 고르셔야 해요' };
  if ((s?.same ?? []).length > 1) {
    return { kind: 'note', text: `같은 금액 결제가 ${s.same.length}건이라 고르셔야 해요 (${s.same.slice(0, 3).map((c) => shortDay(c.occurred_on)).join(' · ')}${s.same.length > 3 ? ' …' : ''})` };
  }
  return null;
}

/** 후보 한 줄 */
export function candidateView(c, suggestedId = null) {
  const reasons = (c.match_reasons ?? []).map((r) => REASON[r]).filter(Boolean);
  const remaining = Number(c.remaining_amount);
  const amount = Number(c.amount);
  const sub = [shortDay(c.occurred_on)];
  if (remaining !== amount) sub.push(`남은 ${won(remaining)}`);
  return {
    id: c.txn_id, merchant: c.merchant_raw, amountText: won(amount), sub: sub.join(' · '),
    tags: [...(c.txn_id === suggestedId ? ['제안'] : []), ...(c.is_current_link ? ['지금 연결'] : []), ...reasons],
    month: monthOf(c.occurred_on),
  };
}

/**
 * 환불 연결 끊기 확인 문구(v0.19 unlink_refund, 사용자 결정 D5)
 * 끊으면 귀속월 = 환불일의 달, 검토 대기, 공동 여부는 그대로(원거래에서 받은 값) — DB 함수 정의
 * @param refund 상세 행 { occurred_on, period_month, is_shared, is_excluded }
 */
export function unlinkConfirmText(refund, reviewStates) {
  const from = refund.period_month;
  const to = monthOf(refund.occurred_on);
  const short = (m) => month(m).replace(/^[0-9]+년 /, '');
  const parts = ['원거래와의 연결을 끊어요. 이 환불은 검토 대기가 되고 미연결 환불 목록에 다시 보여요.'];
  parts.push(from === to ? `${short(to)}에 그대로 집계돼요.` : `집계하는 달이 ${short(from)}에서 환불일의 달인 ${short(to)}로 바뀌어요.`);
  if (!refund.is_excluded && refund.is_shared) {
    const hit = [...new Set([from, to])].sort().filter((m) => reviewStates.get(m) === 'reviewed' || reviewStates.get(m) === 'changed_after_review');
    parts.push(hit.length ? `${hit.map(short).join(', ')}은 확인을 마친 달이라 '확인 후 변경됨'으로 표시돼요.` : '달별 지출 합계가 바뀔 수 있어요.');
  }
  parts.push('끊은 뒤에도 원거래 찾기로 다시 연결할 수 있어요.');
  return { title: '연결 끊기', message: parts.join(' ') };
}

/** 확인 완료한 달이면 '확인 후 변경됨'이 된다는 안내(원거래 달 기준) */
export function reviewedNote(months, reviewStates) {
  const hit = [...new Set(months)].sort().filter((m) => reviewStates.get(m) === 'reviewed');
  return hit.length ? `${hit.map((m) => month(m).replace(/^[0-9]+년 /, '')).join(', ')}은 확인 완료한 달이라 연결하면 "확인 후 변경됨"으로 바뀌어요.` : null;
}

/** 하나 연결 확인 문구 */
export function linkConfirmText(refund, cand, reviewStates) {
  const m = monthOf(cand.occurred_on);
  const parts = [`${shortDay(cand.occurred_on)} ${won(Number(cand.amount))} 결제와 연결해요. ${month(m).replace(/^[0-9]+년 /, '')} 지출 합계에 반영되고 이 환불은 확인함이 돼요.`];
  const note = reviewedNote([m], reviewStates);
  if (note) parts.push(note);
  return { title: `${refund.merchant_raw} 환불 연결`, message: parts.join(' ') };
}

/** 일괄 연결 계획: 제안된 것만, 상한 MAX_BULK */
export function bulkPlan(refunds, suggestions) {
  const pairs = (refunds ?? []).map((r) => ({ refund: r, original: suggestions.get(r.id)?.suggest ?? null }))
    .filter((p) => p.original);
  return { pairs: pairs.slice(0, MAX_BULK), over: Math.max(0, pairs.length - MAX_BULK) };
}

/** 일괄 연결 확인 창: (환불 → 원거래) 목록 전체 */
export function bulkConfirmText(plan, reviewStates) {
  const lines = plan.pairs.map((p) => `${shortDay(p.refund.occurred_on)} ${p.refund.merchant_raw} −${won(Number(p.refund.amount))} → ${shortDay(p.original.occurred_on)} ${p.original.merchant_raw} ${won(Number(p.original.amount))}`);
  const note = reviewedNote(plan.pairs.map((p) => monthOf(p.original.occurred_on)), reviewStates);
  return {
    title: `제안 ${plan.pairs.length}건 모두 연결`,
    message: [`아래 ${plan.pairs.length}건을 각각 제안된 결제와 연결하고 확인함으로 바꿔요.`, ...lines, note,
      plan.over ? `${plan.over}건은 한 번에 할 수 있는 수(${MAX_BULK})를 넘어 남겨 둬요.` : null].filter(Boolean).join('\n'),
  };
}

/** 일괄 결과 문장 */
export function bulkResultText(done, total, failedAt, skipped = 0) {
  const skip = skipped ? ` ${skipped}건은 다른 사람이 먼저 연결했거나 휴지통으로 옮겨 건너뛰었어요.` : '';
  if (failedAt == null) return `${done}건 연결했어요.${skip}`;
  return `${done}건 연결했고, ${failedAt.merchant_raw} 환불에서 멈춰 나머지 ${total - done}건은 연결하지 않았어요.${skip}`;
}

export function confirmPatch(memberId) {
  return { review_status: 'confirmed', updated_by: memberId };
}
