// =====================================================================
// 화면 9 정산 (화면 설계 v0.1 4-7, 시안 9): 요약 · 사람별 표 · 월 확인 · 지난 달
// 조회: v_monthly_settlement(모든 달), v_monthly_review_status(모든 달), members
// 쓰기: confirm_month(p_month) / unconfirm_month(p_month) — 기록 값은 서버가 정한다(v0.16 Q4)
// - 누적 차이는 표시하지 않는다(결정사항 10-29 "정산은 월별만 표시")
// - 확인 후 변경됨이면 "바뀐 거래 보기" → 내역(changed=1)
// 의존: ui/dom.js, router.js, core/confirm.js, core/errors.js, screens/settle-model.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { addMonths, buildHash } from '../router.js';
import { month } from '../core/format.js';
import { confirmDialog } from '../core/confirm.js';
import { STAGES, ACTIONS } from '../core/errors.js';
import { settleSummary, reviewView, confirmMonthText, unconfirmMonthText, pastMonths } from './settle-model.js';
import { errorView } from './shell.js';

export async function loadSettle(db) {
  const [settle, status, members] = await Promise.all([
    db.select('v_monthly_settlement', { columns: 'period_month,member_id,paid_amount,share_amount,balance_amount' }),
    db.select('v_monthly_review_status', {
      columns: 'period_month,review_state,reviewed_by,reviewed_at,needs_review_count,changed_txn_count',
      order: [{ col: 'period_month', ascending: false }],
    }),
    db.select('members', { columns: 'id,member_slot,display_name' }),
  ]);
  const error = [settle, status, members].find((r) => r.error)?.error;
  if (error) return { error };
  return { data: { settle: settle.data ?? [], status: status.data ?? [], members: members.data ?? [] } };
}

/**
 * @param {{ db, monthStart, reload(), isCurrent(), onError(err, extra) → string }} ctx
 */
export async function renderSettle({ db, monthStart, reload, isCurrent, onError }, doc = globalThis.document) {
  const res = await loadSettle(db);
  if (!isCurrent()) return null;
  const ym = (m) => m.slice(0, 7);
  const nav = (n, label, text) => h('a', { class: 'icon-btn', text, attrs: { href: buildHash('settle', { query: { month: ym(addMonths(monthStart, n)) } }), 'aria-label': label } }, [], doc);
  const head = h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav', attrs: { 'aria-label': '달 선택' } }, [
      nav(-1, '이전 달', '‹'),
      h('h1', { class: 'title', text: `${month(monthStart).replace(/^[0-9]+년 /, '')} 정산` }, [], doc),
      nav(1, '다음 달', '›'),
    ], doc),
  ], doc);
  if (res.error) {
    onError?.(res.error);
    return h('main', { class: 'screen' }, [head, errorView(res.error.message, res.error.detail?.sqlState ?? res.error.code, doc)], doc);
  }
  const { settle, status, members } = res.data;
  const sum = settleSummary(settle.filter((r) => r.period_month === monthStart), members);
  const st = status.find((r) => r.period_month === monthStart) ?? null;
  const rv = reviewView(monthStart, st, members);

  const statusLine = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  const fail = (err, extra) => {
    const code = onError?.(err, extra);
    statusLine.textContent = `${err.message}${code ? ` (오류 번호 ${code})` : ''}`;
    statusLine.className = 'status-line error';
  };

  const hero = h('section', { class: 'card hero' }, [
    h('p', { class: 'label', text: `공동지출 ${sum.total} · 5:5` }, [], doc),
    h('p', { class: 'amount-l', text: sum.empty ? '이 달은 공동지출이 없어요' : sum.headline }, [], doc),
    h('p', { class: 'muted', text: '주고받지 않아요. 기록만 해요.' }, [], doc),
  ], doc);

  const table = h('section', { class: 'card' }, [
    h('h2', { class: 'card-title', text: '사람별' }, [], doc),
    h('table', { class: 'settle-table' }, [
      h('thead', {}, [h('tr', {}, ['', '낸 공동지출', '몫', '차이'].map((t) => h('th', { text: t, attrs: { scope: 'col' } }, [], doc)), doc)], doc),
      h('tbody', {}, sum.table.map((r) => h('tr', {}, [
        h('th', { text: r.name, attrs: { scope: 'row' } }, [], doc),
        h('td', { text: r.paid }, [], doc), h('td', { text: r.share }, [], doc),
        h('td', { class: r.balanceValue > 0 ? 'plus' : (r.balanceValue < 0 ? 'minus' : ''), text: r.balance }, [], doc),
      ], doc)), doc),
    ], doc),
  ], doc);

  const btn = (text, cls, onClick) => h('button', { class: `btn ${cls}`, text, attrs: { type: 'button' }, on: { click: onClick } }, [], doc);
  const run = async (name, text) => {
    if (!(await confirmDialog({ ...text, confirmLabel: name === 'confirm_month' ? '확인 완료' : '확인 취소', danger: name === 'unconfirm_month', doc }))) return;
    for (const b of review.querySelectorAll('button')) b.disabled = true;
    const r = await db.rpc(name, { p_month: monthStart });
    for (const b of review.querySelectorAll('button')) b.disabled = false;
    if (r.error) { fail(r.error, { stage: STAGES.settle, action: ACTIONS.confirm_month }); return; }
    reload();
  };
  const review = h('section', { class: `card review ${rv.state}` }, [
    h('h2', { class: 'card-title', text: rv.title }, [], doc),
    rv.sub ? h('p', { class: 'muted', text: rv.sub }, [], doc) : null,
    rv.pendingNote ? h('p', { class: 'notice small', text: rv.pendingNote }, [], doc) : null,
    rv.changedCount > 0 ? h('a', { class: 'row-link soft', attrs: { href: buildHash('list', { query: { month: ym(monthStart), changed: '1' } }) } }, [
      h('span', { text: '바뀐 거래 보기' }, [], doc), h('strong', { text: `${rv.changedCount}건 ›` }, [], doc),
    ], doc) : null,
    rv.canConfirm ? btn(rv.confirmLabel, 'primary', () => run('confirm_month', confirmMonthText(monthStart, Number(st?.needs_review_count) || 0))) : null,
    rv.canUnconfirm ? btn('확인 취소', 'secondary', () => run('unconfirm_month', unconfirmMonthText(monthStart))) : null,
  ], doc);

  const past = pastMonths(settle, status, members, { exclude: monthStart });
  const pastCard = h('section', { class: 'card' }, [
    h('h2', { class: 'card-title', text: '지난 달' }, [], doc),
    past.length === 0 ? h('p', { class: 'muted', text: '다른 달 기록이 없어요' }, [], doc)
      : h('ul', { class: 'todo-list' }, past.map((p) => h('li', {}, [
        h('a', { class: 'todo', attrs: { href: buildHash('settle', { query: { month: ym(p.month) } }) } }, [
          h('span', { class: 'todo-text' }, [
            h('span', { text: `${p.label} · ${p.state}` }, [], doc),
            h('span', { class: 'sub', text: p.diff }, [], doc),
          ], doc),
          h('span', { class: 'chev', text: '›', attrs: { 'aria-hidden': 'true' } }, [], doc),
        ], doc),
      ], doc)), doc),
  ], doc);

  return h('main', { class: 'screen' }, [head, statusLine, hero, table, review, pastCard], doc);
}
