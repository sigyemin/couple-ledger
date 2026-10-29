// =====================================================================
// 화면 9 정산 — 화면 없이 계산하는 부분 (화면 설계 v0.1 4-7, 결정사항 "정산": 송금 없는 기록용, 월별만 표시·누적 표시 안 함)
// - 숫자: v_monthly_settlement(낸 공동지출 paid · 몫 share · 차이 balance = paid − share)
// - 확인: v_monthly_review_status(review_state: not_reviewed | reviewed | changed_after_review), confirm_month / unconfirm_month
// - 검토 대기가 남아도 확인 완료를 누를 수 있다(남은 건수만 안내 — 확정 S2)
// 의존: core/format.js, screens/home-model.js(subjectParticle)
// =====================================================================
import { won, signedWon, month, dateTime } from '../core/format.js';
import { subjectParticle } from './home-model.js';

const shortMonth = (monthStart) => month(monthStart).replace(/^[0-9]+년 /, '');
const num = (v) => Math.round(Number(v) || 0);

/** 그 달 요약: 큰 문장, 공동지출 합계, 사람별 표 */
export function settleSummary(rows, members) {
  const bySlot = [...members].sort((a, b) => a.member_slot - b.member_slot);
  const byId = new Map(rows.map((r) => [r.member_id, r]));
  const table = bySlot.map((m) => {
    const r = byId.get(m.id) ?? {};
    return { name: m.display_name, paid: won(num(r.paid_amount)), share: won(num(r.share_amount)), balance: signedWon(num(r.balance_amount)), balanceValue: num(r.balance_amount) };
  });
  const total = bySlot.reduce((s, m) => s + num(byId.get(m.id)?.paid_amount), 0);
  const top = [...table].sort((a, b) => b.balanceValue - a.balanceValue)[0];
  const headline = !top || top.balanceValue <= 0
    ? '두 사람이 낸 공동지출이 같아요'
    : `${top.name}${subjectParticle(top.name)} ${won(top.balanceValue)} 더 냈어요`;
  return { headline, total: won(total), table, empty: rows.length === 0 };
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
 * 지난 달 목록(최근 순, 최대 n달): 달 · 상태 · 차이 문장
 * @param settleRows v_monthly_settlement 모든 달
 * @param statusRows v_monthly_review_status 모든 달
 */
export function pastMonths(settleRows, statusRows, members, { exclude, n = 12 } = {}) {
  const months = [...new Set([...settleRows.map((r) => r.period_month), ...statusRows.map((r) => r.period_month)])]
    .filter((m) => m !== exclude)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, n);
  const st = new Map(statusRows.map((r) => [r.period_month, r]));
  return months.map((m) => {
    const s = settleSummary(settleRows.filter((r) => r.period_month === m), members);
    return { month: m, label: month(m), state: STATE_LABEL[st.get(m)?.review_state ?? 'not_reviewed'], diff: s.empty ? '공동지출 없음' : s.headline };
  });
}
