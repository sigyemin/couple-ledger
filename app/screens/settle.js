// =====================================================================
// 화면 9 정산 → 명의별 사용 (CL-058, 사용자 결정 10-30: 연말정산용. 5:5 몫·차이·누가 더 냈는지는 표시하지 않는다)
//   사람(결제수단 주인)마다 신용카드 · 체크카드 · 그 밖 사용액, 그 달 + 올해 1월~그 달 누계 · 월 확인 · 지난 달
// 조회: transactions(올해 1월~그 달, 휴지통·집계 제외 빼고 지출·환불만, 쪽 단위), payment_sources, members, v_monthly_review_status(모든 달)
//       + 공제 현황 카드(deduction-card.js — v_deduction_status·v_deduction_txn, CL-062)
// 쓰기: confirm_month(p_month) / unconfirm_month(p_month) — 기록 값은 서버가 정한다(v0.16 Q4)
// - 확인 후 변경됨이면 "바뀐 거래 보기" → 내역(changed=1)
// 의존: ui/dom.js, router.js, core/confirm.js, core/errors.js, screens/settle-model.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { addMonths, buildHash } from '../router.js';
import { month, won } from '../core/format.js';
import { confirmDialog } from '../core/confirm.js';
import { STAGES, ACTIONS } from '../core/errors.js';
import { ownerSpend, reviewView, confirmMonthText, unconfirmMonthText, pastMonths } from './settle-model.js';
import { errorView } from './shell.js';
import { renderDeductionCard } from './deduction-card.js';

const PAGE_SIZE = 1000;
const MAX_ROWS = 20000;

/**
 * 올해 1월 ~ 그 달 지출·환불 거래를 쪽 단위로 끝까지(list.js readMonthRows와 같은 방식 — 빈 쪽까지, id로 중복 거름)
 * @returns {{ data: { rows, capped } } | { error }}
 */
export async function readSpendRows(db, monthStart, { pageSize = PAGE_SIZE, max = MAX_ROWS } = {}) {
  const rows = [];
  const seen = new Set();
  let offset = 0;
  while (rows.length <= max) {
    const r = await db.select('transactions', {
      columns: 'id,source_id,kind,amount,card_kind,period_month',
      filters: [
        { col: 'period_month', op: 'gte', value: `${monthStart.slice(0, 4)}-01-01` }, { col: 'period_month', op: 'lte', value: monthStart },
        { col: 'deleted_at', op: 'is', value: null }, { col: 'is_excluded', op: 'eq', value: false }, { col: 'kind', op: 'in', value: ['expense', 'refund'] },
      ],
      order: [{ col: 'id', ascending: true }],
      range: { from: offset, to: offset + Math.min(pageSize, max + 1 - rows.length) - 1 },
    });
    if (r.error) return { error: r.error };
    const page = r.data ?? [];
    if (page.length === 0) break;
    offset += page.length;
    for (const row of page) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  return { data: { rows: rows.slice(0, max), capped: rows.length > max } };
}

export async function loadSettle(db, monthStart) {
  const [spend, sources, status, members] = await Promise.all([
    readSpendRows(db, monthStart),
    db.select('payment_sources', { columns: 'id,owner_member_id,kind,is_test' }),
    db.select('v_monthly_review_status', {
      columns: 'period_month,review_state,reviewed_by,reviewed_at,needs_review_count,changed_txn_count',
      order: [{ col: 'period_month', ascending: false }],
    }),
    db.select('members', { columns: 'id,member_slot,display_name' }),
  ]);
  const error = [spend, sources, status, members].find((r) => r.error)?.error;
  if (error) return { error };
  return { data: { spend: spend.data, sources: sources.data ?? [], status: status.data ?? [], members: members.data ?? [] } };
}

/**
 * @param {{ db, monthStart, reload(), isCurrent(), onError(err, extra) → string }} ctx
 */
export async function renderSettle({ db, monthStart, reload, isCurrent, onError }, doc = globalThis.document) {
  // 공제 현황 카드(CL-062)는 함께 읽는다(실패해도 그 카드만 오류 줄)
  const deduction = renderDeductionCard({ db, monthStart, onError }, doc);
  const res = await loadSettle(db, monthStart);
  if (!isCurrent()) return null;
  const ym = (m) => m.slice(0, 7);
  const nav = (n, label, text) => h('a', { class: 'icon-btn', text, attrs: { href: buildHash('settle', { query: { month: ym(addMonths(monthStart, n)) } }), 'aria-label': label } }, [], doc);
  const head = h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav', attrs: { 'aria-label': '달 선택' } }, [
      nav(-1, '이전 달', '‹'),
      h('h1', { class: 'title', text: `${month(monthStart).replace(/^[0-9]+년 /, '')} 명의별 사용` }, [], doc),
      nav(1, '다음 달', '›'),
    ], doc),
  ], doc);
  if (res.error) {
    deduction.catch(() => null); // 화면 전체가 오류면 공제 카드는 버린다
    onError?.(res.error);
    return h('main', { class: 'screen' }, [head, errorView(res.error.message, res.error.detail?.sqlState ?? res.error.code, doc)], doc);
  }
  const { spend, sources, status, members } = res.data;
  const sum = ownerSpend(spend.rows, sources, members, monthStart);
  const st = status.find((r) => r.period_month === monthStart) ?? null;
  const rv = reviewView(monthStart, st, members);

  const statusLine = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  const fail = (err, extra) => {
    const code = onError?.(err, extra);
    statusLine.textContent = `${err.message}${code ? ` (오류 번호 ${code})` : ''}`;
    statusLine.className = 'status-line error';
  };

  const mLabel = month(monthStart).replace(/^[0-9]+년 /, '');
  const people = sum.people.map((p) => h('section', { class: 'card' }, [
    h('h2', { class: 'card-title', text: `${p.name} 명의` }, [], doc),
    h('table', { class: 'settle-table' }, [
      h('thead', {}, [h('tr', {}, ['', mLabel, sum.ytdLabel].map((t) => h('th', { text: t, attrs: { scope: 'col' } }, [], doc)), doc)], doc),
      h('tbody', {}, p.lines.map((l) => h('tr', l.key === 'total' ? { class: 'total' } : {}, [
        h('th', { text: l.label, attrs: { scope: 'row' } }, [], doc),
        h('td', { text: won(l.month) }, [], doc), h('td', { text: won(l.ytd) }, [], doc),
      ], doc)), doc),
    ], doc),
  ], doc));
  const info = h('section', { class: 'card' }, [
    h('p', { class: 'muted', text: '명의 = 결제수단 주인. 공동·개인 구분 없이, 지출에서 환불을 뺀 금액이에요(홈 지출과 같은 기준). 집계 제외·휴지통·시험 결제수단은 빼요. 그 밖 = 통장 출금·현금.' }, [], doc),
    spend.capped ? h('p', { class: 'notice small', text: '거래가 너무 많아 일부만 더했어요.' }, [], doc) : null,
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

  const past = pastMonths(status, { exclude: monthStart });
  const pastCard = h('section', { class: 'card' }, [
    h('h2', { class: 'card-title', text: '지난 달' }, [], doc),
    past.length === 0 ? h('p', { class: 'muted', text: '다른 달 기록이 없어요' }, [], doc)
      : h('ul', { class: 'todo-list' }, past.map((p) => h('li', {}, [
        h('a', { class: 'todo', attrs: { href: buildHash('settle', { query: { month: ym(p.month) } }) } }, [
          h('span', { class: 'todo-text' }, [h('span', { text: `${p.label} · ${p.state}` }, [], doc)], doc),
          h('span', { class: 'chev', text: '›', attrs: { 'aria-hidden': 'true' } }, [], doc),
        ], doc),
      ], doc)), doc),
  ], doc);

  // 공제 카드는 기다리지 않는다(홈과 같이): 자리만 먼저 그리고, 오면 바꿔 끼운다. 다른 화면으로 넘어갔으면 그대로 둔다
  const dedCard = h('section', { class: 'card ded', attrs: { 'aria-live': 'polite' } }, [
    h('h2', { class: 'card-title', text: `공제 현황 · ${monthStart.slice(0, 4)}` }, [], doc),
    h('p', { class: 'muted', text: '확인하는 중…' }, [], doc),
  ], doc);
  deduction.then((card) => {
    if (isCurrent()) dedCard.replaceWith(card);
  }, (err) => {
    if (!isCurrent()) return;
    onError?.(err);
    dedCard.lastChild.textContent = '공제 현황을 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.';
  });
  return h('main', { class: 'screen' }, [head, statusLine, dedCard, ...people, info, review, pastCard], doc);
}
