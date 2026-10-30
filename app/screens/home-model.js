// =====================================================================
// 홈 데이터 → 화면 모델 (화면 설계 v0.1 4-1, 시안 1). DB 호출 없는 순수 함수
// 입력(조회 결과 그대로)
//   summary, prevSummary : v_monthly_summary 행(그 달, 지난달) 또는 null
//   settlement           : v_monthly_settlement 행들(그 달)
//   members              : members 행들 { id, member_slot, display_name }
//   missing              : 지난 달들의 missing_uploads [{ month, rows }] (uploads.js, CL-056 — 보고 있는 달과 상관없음)
//   thisMonth            : 이번 달 'YYYY-MM-01'(달 이름에 해를 붙일지)
//   changedMonths        : v_monthly_review_status 중 review_state = 'changed_after_review' 행들
//   categories           : v_monthly_category 행들(그 달) + categoryNames(Map id → 이름)
// 금액은 DB numeric이 문자열로 올 수 있어 Number로 바꾼다
// 의존: core/format.js
// =====================================================================
import { won, month as monthLabel } from '../core/format.js';
import { missingSummary } from './uploads-model.js';

const num = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/** "지난달보다 82,000원 적게 썼어요" (지난달 자료가 없으면 null) */
export function compareText(cur, prev) {
  if (prev == null) return null;
  const d = cur - prev;
  if (d === 0) return '지난달과 같게 썼어요';
  return `지난달보다 ${won(Math.abs(d))} ${d < 0 ? '적게' : '많이'} 썼어요`;
}

/** 주격 조사: 받침이 있으면 '이', 없으면 '가' (한글이 아니면 '이') */
export function subjectParticle(name) {
  const c = String(name ?? '').slice(-1).charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 === 0 ? '가' : '이';
  return '이';
}

/** 정산 차이 한 줄: 더 낸 사람 기준. 차이가 없으면 '정산 차이 없어요' */
export function settlementText(rows, members) {
  const name = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const payer = (rows ?? []).map((r) => ({ id: r.member_id, bal: num(r.balance_amount) })).sort((a, b) => b.bal - a.bal)[0];
  if (!payer || payer.bal <= 0) return '정산 차이 없어요';
  const who = name.get(payer.id) ?? '한 사람';
  return `${who}${subjectParticle(who)} ${won(payer.bal)} 더 냄`;
}

/** 많이 쓴 곳: 그룹별 합계 상위 n개 (미분류는 '미분류'), 막대 비율 = 1등 대비 */
export function topGroups(categoryRows, categoryNames, n = 3) {
  const sums = new Map();
  for (const r of categoryRows ?? []) {
    const key = r.group_category_id ?? null;
    sums.set(key, (sums.get(key) ?? 0) + num(r.total_amount));
  }
  const list = [...sums]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, amount]) => ({ id, name: id ? (categoryNames.get(id) ?? '이름 없음') : '미분류', amount }));
  const max = list[0]?.amount ?? 0;
  return list.map((g) => ({ ...g, ratio: max ? g.amount / max : 0 }));
}

/**
 * @param {string} monthStart 'YYYY-MM-01'
 * @returns {{ title, expense, compare, settlement, todos: {key, text, sub, href, tone}[], groups }}
 */
export function buildHomeModel(monthStart, d) {
  const expense = num(d.summary?.expense_amount);
  const todos = [];
  const missing = missingSummary(d.missing, d.thisMonth ?? monthStart);
  if (missing) {
    todos.push({ key: 'missing', tone: 'warn', href: '#/uploads', text: `안 올린 파일 ${missing.total}개`, sub: missing.text });
  }
  const review = num(d.summary?.needs_review_count);
  if (review > 0) {
    todos.push({ key: 'review', tone: 'info', href: `#/list?month=${monthStart.slice(0, 7)}&status=needs_review`, text: `검토할 것 ${review}건`, sub: null });
  }
  const refunds = num(d.summary?.unlinked_refund_count);
  if (refunds > 0) {
    todos.push({ key: 'refund', tone: 'info', href: `#/list?month=${monthStart.slice(0, 7)}&kind=refund_unlinked`, text: `원거래를 못 찾은 환불 ${refunds}건`, sub: null });
  }
  // 지난달 체크카드 취소 연결 제안(CL-042) → 그 달 월 검토
  if (d.suggest?.count > 0) {
    const ym = d.suggest.month.slice(0, 7);
    todos.push({ key: 'refund-suggest', tone: 'info', href: `#/review?month=${ym}`, text: `${Number(ym.slice(5))}월 환불 연결 제안 ${d.suggest.count}건`, sub: '체크카드 취소 · 월 검토에서 연결해요' });
  }
  for (const c of d.changedMonths ?? []) {
    const ym = String(c.period_month).slice(0, 7);
    todos.push({
      key: `changed-${ym}`, tone: 'warn', href: `#/settle?month=${ym}`,
      text: `${Number(ym.slice(5))}월 확인 후 변경됨`, sub: `정산 숫자가 바뀐 거래 ${num(c.changed_txn_count)}건`,
    });
  }
  return {
    title: monthLabel(monthStart),
    expense: won(expense),
    compare: compareText(expense, d.prevSummary ? num(d.prevSummary.expense_amount) : null),
    settlement: settlementText(d.settlement, d.members),
    todos,
    groups: topGroups(d.categories, d.categoryNames ?? new Map()).map((g) => ({ ...g, amountText: won(g.amount) })),
  };
}
