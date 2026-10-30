// =====================================================================
// 홈 데이터 → 화면 모델 (화면 설계 v0.1 4-1, 시안 1). DB 호출 없는 순수 함수
// 입력(조회 결과 그대로)
//   summary, prevSummary : v_monthly_summary 행(그 달, 지난달) 또는 null
//   missing              : 지난 달들의 missing_uploads [{ month, rows }] (uploads.js, CL-056 — 보고 있는 달과 상관없음)
//   missingState         : 'loading'(아직 조회 중) | 'error'(조회 실패 — 이 줄만 '확인 못 함') | 없음(missing 사용)
//   thisMonth            : 이번 달 'YYYY-MM-01'(달 이름에 해를 붙일지)
//   changedMonths        : v_monthly_review_status 중 review_state = 'changed_after_review' 행들
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

/**
 * @param {string} monthStart 'YYYY-MM-01'
 * @returns {{ title, expense, compare, todos: {key, text, sub, href, tone}[], pending }}
 *   pending: 안 올린 파일을 아직 확인하는 중
 */
export function buildHomeModel(monthStart, d) {
  const expense = num(d.summary?.expense_amount);
  const todos = [];
  const missing = d.missingState ? null : missingSummary(d.missing, d.thisMonth ?? monthStart);
  if (d.missingState === 'error') {
    todos.push({ key: 'missing', tone: 'warn', href: '#/uploads', text: '안 올린 파일을 확인하지 못했어요', sub: '업로드 현황에서 다시 확인해요' });
  } else if (missing) {
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
      text: `${Number(ym.slice(5))}월 확인 후 변경됨`, sub: `확인 뒤 바뀐 거래 ${num(c.changed_txn_count)}건`,
    });
  }
  return {
    title: monthLabel(monthStart),
    expense: won(expense),
    compare: compareText(expense, d.prevSummary ? num(d.prevSummary.expense_amount) : null),
    todos,
    pending: d.missingState === 'loading',
  };
}
