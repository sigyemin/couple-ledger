// =====================================================================
// 월 검토 — 화면 없이 계산하는 부분 (화면 설계 v0.1 4-5, 시안 7)
// 항목: 진행률 · 분류가 필요해요 · 같은 거래일 수도 있어요 · 원거래를 못 찾은 환불(준비 중 — 사용자 결정 U-13 대기)
//       · 아직 안 정한 이체 상대(준비 중 — 규칙 화면 필요) · 나눈 금액이 안 맞는 거래
// - 숫자 기준은 DB 뷰(v_monthly_summary·v_possible_duplicates·v_line_mismatch)와 같게, 거래 목록은 그 달 내역(휴지통·테스트 결제수단 제외)
// 의존: core/format.js, router.js
// =====================================================================
import { won, day } from '../core/format.js';
import { currentMonth } from '../router.js';

/** 월 검토 기본 달 — 지금은 이번 달. 사용자 결정 대기(권장 지난달): 바꾸려면 이 줄을 addMonths(currentMonth(now), -1)로 */
export function defaultReviewMonth(now = new Date()) {
  return currentMonth(now);
}

/** 진행률: 그 달 거래 중 검토 대기가 아닌 비율 (v_monthly_summary.txn_count·needs_review_count) */
export function progress(summary) {
  const total = Number(summary?.txn_count) || 0;
  const pending = Number(summary?.needs_review_count) || 0;
  const done = Math.max(0, total - pending);
  return { total, pending, done, ratio: total ? done / total : 1, text: total ? `${total}건 중 ${done}건 확인 · 검토 대기 ${pending}건` : '이 달 거래가 없어요' };
}

/**
 * 분류가 필요해요: 검토 대기 + 미분류(이체 제외). 가맹점 정리값별로 묶음(수입과 지출은 따로 — 카테고리 그룹이 다름)
 * @returns {{ key, merchant, kind: 'income'|'expense', count, amountText, ids }[]} 건수 많은 순
 */
export function uncategorizedGroups(rows) {
  const map = new Map();
  for (const r of rows) {
    if (r.review_status !== 'needs_review' || r.is_uncategorized !== true || r.kind === 'transfer') continue;
    const kind = r.kind === 'income' ? 'income' : 'expense';
    const key = `${kind}|${r.merchant_norm ?? r.merchant_raw}`;
    if (!map.has(key)) map.set(key, { key, merchant: r.merchant_raw, kind, ids: [], sum: 0 });
    const g = map.get(key);
    g.ids.push(r.id);
    g.sum += r.kind === 'refund' ? -Number(r.amount) : Number(r.amount);
  }
  return [...map.values()]
    .sort((a, b) => b.ids.length - a.ids.length || a.merchant.localeCompare(b.merchant))
    .map((g) => ({ key: g.key, merchant: g.merchant, kind: g.kind, count: g.ids.length, amountText: won(g.sum), ids: g.ids }));
}

/**
 * 같은 거래일 수도 있어요: v_possible_duplicates(결제수단·날짜·가맹점·금액·종류가 같은 2건 이상) 중
 * 그 달 거래에 2건 이상 있고 아직 검토 대기가 있는 묶음만(둘 다 맞음 = 확인함으로 바꾸면 사라짐 [판단: 뷰에는 "맞음" 표시 칸이 없음])
 */
export function duplicateGroups(dupRows, rows) {
  const out = [];
  for (const d of dupRows) {
    const same = rows.filter((r) => r.source_id === d.source_id && r.occurred_on === d.occurred_on
      && (r.merchant_norm ?? '') === (d.merchant_norm ?? '') && Number(r.amount) === Number(d.amount) && r.kind === d.kind);
    if (same.length < 2 || !same.some((r) => r.review_status === 'needs_review')) continue;
    out.push({
      title: `${same[0].merchant_raw} · ${day(d.occurred_on)} · ${won(Number(d.amount))} · ${same.length}건`,
      items: same.map((r) => ({ id: r.id, text: `${r.source_label}${r.occurred_time ? ` · ${String(r.occurred_time).slice(0, 5)}` : ''}${r.memo ? ` · ${r.memo}` : ''}` })),
      pendingIds: same.filter((r) => r.review_status === 'needs_review').map((r) => r.id),
    });
  }
  return out;
}

/** 원거래를 못 찾은 환불 수 (v_monthly_summary.unlinked_refund_count와 같은 기준) */
export function unlinkedRefundCount(summary) {
  return Number(summary?.unlinked_refund_count) || 0;
}

/** 나눈 금액이 안 맞는 거래: v_line_mismatch 중 그 달 거래 */
export function mismatchItems(mismatchRows, rows) {
  const inMonth = new Set(rows.map((r) => r.id));
  return mismatchRows.filter((m) => inMonth.has(m.id)).map((m) => ({
    id: m.id,
    text: `${m.merchant_raw} · ${day(m.occurred_on)}`,
    sub: `거래 ${won(Number(m.amount))} · 나눈 합계 ${won(Number(m.lines_amount))}`,
  }));
}

/** 둘 다 맞음 patch */
export function confirmBothPatch(memberId) {
  return { review_status: 'confirmed', updated_by: memberId };
}
