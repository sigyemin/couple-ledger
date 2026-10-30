// =====================================================================
// 화면 9 정산 — 화면 없이 계산하는 부분 (화면 설계 v0.1 4-7)
// - 숫자: 명의별 사용액(CL-058, 사용자 결정 10-30). 5:5 몫·차이 표시는 없앴다(DB 뷰 v_monthly_settlement는 그대로)
// - 확인: v_monthly_review_status(review_state: not_reviewed | reviewed | changed_after_review), confirm_month / unconfirm_month
// - 검토 대기가 남아도 확인 완료를 누를 수 있다(남은 건수만 안내 — 확정 S2)
// 의존: core/format.js, router.js, screens/home-model.js(subjectParticle)
// =====================================================================
import { won, month, dateTime } from '../core/format.js';
import { subjectParticle } from './home-model.js';
import { addMonths, currentMonth } from '../router.js';

/** 정산 탭 기본 달 = 지난달(사용자 결정 10-29. 홈은 이번 달). 1월이면 전년 12월 */
export function defaultSettleMonth(now = new Date()) {
  return addMonths(currentMonth(now), -1);
}

const shortMonth = (monthStart) => month(monthStart).replace(/^[0-9]+년 /, '');
const num = (v) => Math.round(Number(v) || 0);

export const SPEND_KINDS = Object.freeze([['credit', '신용카드'], ['check', '체크카드'], ['other', '그 밖']]);

/** 거래 → 종류: 신용카드 결제수단 = credit, 체크카드 결제수단·통장의 체크카드 사용 행 = check, 나머지(통장 출금·현금) = other */
export function spendKind(row, source) {
  if (source?.kind === 'credit_card') return 'credit';
  if (source?.kind === 'check_card' || row.card_kind === 'check_card') return 'check';
  return 'other';
}

/**
 * 명의별 사용액(CL-058, 사용자 결정 10-30 — 연말정산용, 5:5 정산 표시 대신)
 * - 명의 = 결제수단 주인(owner_member_id). 공동·개인 구분 없이 전부
 * - 사용액 = 지출 − 원거래에 연결된 환불. 달은 period_month(연결 환불은 원거래 달 — DB 트리거)
 * - 시험 결제수단 제외. 집계 제외·휴지통·수입·이체는 조회에서 이미 뺐다(loadSettle)
 * - 원거래를 못 찾은 환불은 빼지 않고 건수·금액만 따로 알린다
 * @param rows transactions { source_id, kind, amount, card_kind, period_month, refund_of_txn_id } (올해 1월 ~ 그 달)
 * @returns {{ people: { id, name, lines: { key, label, month, ytd }[] }[], unlinked: { month: {count, amount}, ytd: {count, amount} }, ytdLabel }}
 *   lines 끝 줄은 합계(key 'total'), 금액은 숫자(원)
 */
export function ownerSpend(rows, sources, members, monthStart) {
  const src = new Map((sources ?? []).map((s) => [s.id, s]));
  const zero = () => Object.fromEntries(SPEND_KINDS.map(([k]) => [k, { month: 0, ytd: 0 }]));
  const byOwner = new Map();
  const unlinked = { month: { count: 0, amount: 0 }, ytd: { count: 0, amount: 0 } };
  for (const r of rows ?? []) {
    const s = src.get(r.source_id);
    if (!s || s.is_test) continue;
    const amount = num(r.amount);
    const inMonth = r.period_month === monthStart;
    if (r.kind === 'refund' && r.refund_of_txn_id == null) {
      for (const k of inMonth ? ['month', 'ytd'] : ['ytd']) { unlinked[k].count += 1; unlinked[k].amount += amount; }
      continue;
    }
    const signed = r.kind === 'refund' ? -amount : (r.kind === 'expense' ? amount : 0);
    if (!signed) continue;
    if (!byOwner.has(s.owner_member_id)) byOwner.set(s.owner_member_id, zero());
    const cell = byOwner.get(s.owner_member_id)[spendKind(r, s)];
    cell.ytd += signed;
    if (inMonth) cell.month += signed;
  }
  const people = [...(members ?? [])].sort((a, b) => a.member_slot - b.member_slot).map((m) => {
    const t = byOwner.get(m.id) ?? zero();
    const lines = SPEND_KINDS.map(([key, label]) => ({ key, label, month: t[key].month, ytd: t[key].ytd }));
    lines.push({ key: 'total', label: '합계', month: lines.reduce((x, l) => x + l.month, 0), ytd: lines.reduce((x, l) => x + l.ytd, 0) });
    return { id: m.id, name: m.display_name, lines };
  });
  const mm = Number(monthStart.slice(5, 7));
  return { people, unlinked, ytdLabel: mm === 1 ? '1월' : `1~${mm}월` };
}

/** 원거래를 못 찾은 환불 안내(없으면 null) */
export function unlinkedNote(unlinked) {
  if (!unlinked.ytd.count) return null;
  return `원거래를 못 찾은 환불은 빼지 않았어요 — 이 달 ${unlinked.month.count}건 ${won(unlinked.month.amount)}, 올해 ${unlinked.ytd.count}건 ${won(unlinked.ytd.amount)}. 원거래에 연결하면 빠져요.`;
}

/**
 * 확인 상태 줄과 할 수 있는 동작
 * @param {object|null} st v_monthly_review_status 한 행(없으면 그 달 거래·확인 기록이 없음)
 */
export function reviewView(monthStart, st, members) {
  const m = shortMonth(monthStart);
  const nameOf = (id) => members.find((x) => x.id === id)?.display_name ?? '-';
  const pending = num(st?.needs_review_count);
  const pendingNote = pending > 0 ? `검토 대기 ${pending}건이 남았어요. 그래도 확인할 수 있어요.` : null;
  const state = st?.review_state ?? 'not_reviewed';
  if (state === 'reviewed') {
    return { state, title: `${m} 확인 완료`, sub: `${nameOf(st.reviewed_by)} · ${dateTime(st.reviewed_at)}`, pendingNote: null, canConfirm: false, canUnconfirm: true, changedCount: 0 };
  }
  if (state === 'changed_after_review') {
    return {
      state, title: `${m} 확인 후 변경됨`, sub: `${nameOf(st.reviewed_by)}${subjectParticle(nameOf(st.reviewed_by))} ${dateTime(st.reviewed_at)}에 확인한 뒤 정산에 영향 주는 거래 ${num(st.changed_txn_count)}건이 바뀌었어요`,
      pendingNote, canConfirm: true, canUnconfirm: true, changedCount: num(st.changed_txn_count), confirmLabel: `${m} 다시 확인 완료`,
    };
  }
  return { state: 'not_reviewed', title: `${m} 확인 전`, sub: null, pendingNote, canConfirm: true, canUnconfirm: false, changedCount: 0, confirmLabel: `${m} 확인 완료` };
}

/** 확인·확인 취소 대화상자 문구 */
export function confirmMonthText(monthStart, pending) {
  return {
    title: `${shortMonth(monthStart)} 확인 완료`,
    message: `${month(monthStart)} 정산 숫자를 확인했다고 남겨요.${pending > 0 ? ` 검토 대기 ${pending}건이 남아 있어요.` : ''} 확인한 뒤 정산에 영향 주는 거래가 바뀌면 '확인 후 변경됨'으로 알려 드려요.`,
  };
}

export function unconfirmMonthText(monthStart) {
  return {
    title: '확인 취소',
    message: `${month(monthStart)} 확인 기록을 지워요. 다시 확인 완료를 누를 수 있어요.`,
  };
}

const STATE_LABEL = { not_reviewed: '확인 전', reviewed: '확인 완료', changed_after_review: '확인 후 변경됨' };

/**
 * 지난 달 목록(최근 순, 최대 n달): 달 · 확인 상태
 * @param statusRows v_monthly_review_status 모든 달
 */
export function pastMonths(statusRows, { exclude, n = 12 } = {}) {
  return [...statusRows]
    .filter((r) => r.period_month !== exclude)
    .sort((a, b) => b.period_month.localeCompare(a.period_month))
    .slice(0, n)
    .map((r) => ({ month: r.period_month, label: month(r.period_month), state: STATE_LABEL[r.review_state ?? 'not_reviewed'] }));
}
