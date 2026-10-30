// =====================================================================
// 화면 1 홈 (화면 설계 v0.1 4-1, 시안 1): 달 선택, 이번 달 지출, 정산 차이, 할 일, 많이 쓴 곳
// 조회: v_monthly_summary(그 달·지난달), v_monthly_settlement, members, 업로드 현황(uploads.js — 지난 달들의 missing_uploads, CL-056),
//       v_monthly_review_status(확인 후 변경됨), v_monthly_category(그 달), categories(그룹 이름)
//       지난달 체크카드 취소 연결 제안 수(refund.js suggestionCount — 미연결 체크카드 취소가 있을 때만 후보 RPC, 실패해도 홈은 그대로)
// 의존: ui/dom.js, router.js, screens/home-model.js, screens/shell.js
// =====================================================================
import { h, widthClass } from '../ui/dom.js';
import { addMonths, buildHash, currentMonth } from '../router.js';
import { buildHomeModel } from './home-model.js';
import { suggestionCount } from './refund.js';
import { errorView } from './shell.js';
import { loadUploadStatus } from './uploads.js';

/** 홈에 필요한 조회를 한 번에 (실패한 조회가 있으면 첫 오류를 돌려준다) */
export async function loadHome(db, monthStart) {
  const prev = addMonths(monthStart, -1);
  const thisMonth = currentMonth();
  const eq = (col, value) => ({ col, op: 'eq', value });
  const [summary, prevSummary, settlement, members, missing, changed, categories, names, suggest] = await Promise.all([
    db.select('v_monthly_summary', { filters: [eq('period_month', monthStart)] }),
    db.select('v_monthly_summary', { filters: [eq('period_month', prev)] }),
    db.select('v_monthly_settlement', { filters: [eq('period_month', monthStart)] }),
    db.select('members', { columns: 'id,member_slot,display_name' }),
    loadUploadStatus(db, thisMonth),
    db.select('v_monthly_review_status', {
      columns: 'period_month,changed_txn_count',
      filters: [eq('review_state', 'changed_after_review')],
      order: [{ col: 'period_month', ascending: false }],
    }),
    db.select('v_monthly_category', { filters: [eq('period_month', monthStart)] }),
    db.select('categories', { columns: 'id,name', filters: [{ col: 'parent_id', op: 'is', value: null }] }),
    suggestionCount(db, prev),
  ]);
  const error = [summary, prevSummary, settlement, members, missing, changed, categories, names].find((r) => r.error)?.error;
  if (error) return { error };
  return {
    data: {
      summary: summary.data?.[0] ?? null,
      prevSummary: prevSummary.data?.[0] ?? null,
      settlement: settlement.data ?? [],
      members: members.data ?? [],
      missing: missing.data.missing,
      thisMonth,
      changedMonths: changed.data ?? [],
      categories: categories.data ?? [],
      suggest: suggest.error ? null : { month: prev, count: suggest.data.count },
      categoryNames: new Map((names.data ?? []).map((c) => [c.id, c.name])),
    },
  };
}

/**
 * @param {{ db, member, monthStart, isCurrent: () => boolean, onError(err) }} ctx
 * @returns {Promise<HTMLElement|null>} 다른 화면으로 넘어갔으면 null
 */
export async function renderHome({ db, member, monthStart, isCurrent, onError }, doc = globalThis.document) {
  const res = await loadHome(db, monthStart);
  if (!isCurrent()) return null;
  const ym = (m) => m.slice(0, 7);
  const head = h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav', attrs: { 'aria-label': '달 선택' } }, [
      h('a', { class: 'icon-btn', text: '‹', attrs: { href: buildHash('home', { query: { month: ym(addMonths(monthStart, -1)) } }), 'aria-label': '이전 달' } }, [], doc),
      h('h1', { class: 'title', text: res.data ? buildHomeModel(monthStart, res.data).title : '' }, [], doc),
      h('a', { class: 'icon-btn', text: '›', attrs: { href: buildHash('home', { query: { month: ym(addMonths(monthStart, 1)) } }), 'aria-label': '다음 달' } }, [], doc),
    ], doc),
    h('span', { class: 'avatar', text: String(member.displayName ?? '').slice(0, 1), attrs: { 'aria-label': `로그인: ${member.displayName}` } }, [], doc),
  ], doc);

  if (res.error) {
    onError?.(res.error);
    return h('main', { class: 'screen' }, [head, errorView(res.error.message, res.error.detail?.sqlState ?? res.error.code, doc)], doc);
  }
  const m = buildHomeModel(monthStart, res.data);

  const summary = h('section', { class: 'card hero' }, [
    h('p', { class: 'label', text: '이번 달 지출' }, [], doc),
    h('p', { class: 'amount-xl', text: m.expense }, [], doc),
    m.compare ? h('p', { class: 'muted', text: m.compare }, [], doc) : null,
    h('a', { class: 'row-link soft', attrs: { href: buildHash('settle', { query: { month: ym(monthStart) } }) } }, [
      h('span', { text: '정산 차이' }, [], doc),
      h('strong', { text: `${m.settlement} ›` }, [], doc),
    ], doc),
  ], doc);

  const todos = h('section', { class: 'card' }, [
    h('h2', { class: 'card-title', text: '할 일' }, [], doc),
    m.todos.length === 0
      ? h('p', { class: 'muted done', text: '이번 달 할 일을 다 했어요' }, [], doc)
      : h('ul', { class: 'todo-list' }, m.todos.map((t) => h('li', {}, [
        h('a', { class: 'todo', attrs: { href: t.href } }, [
          h('span', { class: `dot ${t.tone}`, attrs: { 'aria-hidden': 'true' } }, [], doc),
          h('span', { class: 'todo-text' }, [
            h('span', { text: t.text }, [], doc),
            t.sub ? h('span', { class: 'sub', text: t.sub }, [], doc) : null,
          ], doc),
          h('span', { class: 'chev', text: '›', attrs: { 'aria-hidden': 'true' } }, [], doc),
        ], doc),
      ], doc)), doc),
  ], doc);

  const groups = h('section', { class: 'card' }, [
    h('h2', { class: 'card-title', text: '많이 쓴 곳' }, [], doc),
    m.groups.length === 0
      ? h('p', { class: 'muted', text: '아직 쓴 돈이 없어요' }, [], doc)
      : h('ul', { class: 'bars' }, m.groups.map((g) => h('li', { class: 'bar-row' }, [
        h('span', { class: 'bar-name', text: g.name }, [], doc),
        h('span', { class: 'bar-track', attrs: { 'aria-hidden': 'true' } }, [
          h('span', { class: `bar-fill ${widthClass(g.ratio)}` }, [], doc),
        ], doc),
        h('span', { class: 'bar-amount', text: g.amountText }, [], doc),
      ], doc)), doc),
  ], doc);

  return h('main', { class: 'screen' }, [head, summary, todos, groups], doc);
}
