// =====================================================================
// 리포트 (화면 설계 v0.2 3-2 시안 11 · 3-3 시안 12 · 3-4 시안 13). 읽기만 한다
// 11 #/report?month&view=income : v_monthly_summary(6개월), v_monthly_category | v_monthly_income(그 달·지난달)
// - 수입 칸은 카테고리별만(결정 C6: 구성원별 줄 없음)
// 12 #/rgroup/<그룹 id>?month   : v_monthly_category(그 그룹, 6개월), v_monthly_summary(그 달·지난달)
// 13 #/ritem/<카테고리 id>?month : v_monthly_category_txn(그 달·그 카테고리), v_transaction_detail(그 귀속월, 내역과 같은 읽기)
// - 공동/개인 합친 금액(V6). 테스트 결제수단·휴지통은 뷰가 뺀다
// - 차트는 svg.js로(innerHTML 없음), 값은 글자로 함께, role="img" + aria-label에 모든 값
// 의존: ui/dom.js, ui/svg.js, router.js, core/format.js, screens/report-model.js, screens/list.js(readMonthRows), screens/list-model.js(groupByDay), screens/shell.js
// =====================================================================
import { h, widthClass } from '../ui/dom.js';
import { s } from '../ui/svg.js';
import { addMonths, buildHash } from '../router.js';
import { month, won } from '../core/format.js';
import {
  CHART, DIFF_BAR, barChart, series, sixMonths, categoryMap, compareGroups, compareText, groupView, itemTxns,
  incomeCompareText, incomeView,
} from './report-model.js';
import { readMonthRows } from './list.js';
import { capNotice, groupByDay } from './list-model.js';
import { errorView } from './shell.js';

const ym = (m) => m.slice(0, 7);
const eq = (col, value) => ({ col, op: 'eq', value });
const between = (from, to) => [{ col: 'period_month', op: 'gte', value: from }, { col: 'period_month', op: 'lte', value: to }];
const MAX_SHARES = 2000;

function firstError(list) {
  return list.find((r) => r.error)?.error ?? null;
}

function failView(head, err, onError, doc) {
  onError?.(err);
  return h('main', { class: 'screen' }, [head, errorView(err.message, err.detail?.sqlState ?? err.code, doc)], doc);
}

function backHead(href, label, title, doc, nav = null) {
  return h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav' }, [
      h('a', { class: 'icon-btn', text: '‹', attrs: { href, 'aria-label': label } }, [], doc),
      ...(nav ?? [h('h1', { class: 'title', text: title }, [], doc)]),
    ], doc),
  ], doc);
}

/** 6개월 막대 SVG */
function barSvg(points, selected, title, doc) {
  const c = barChart(points, selected, title);
  const mid = CHART.barW / 2;
  return s('svg', { class: 'chart', viewBox: `0 0 ${CHART.width} ${CHART.height}`, role: 'img', 'aria-label': c.aria }, [
    s('line', { class: 'axis', x1: 0, y1: CHART.base, x2: CHART.width, y2: CHART.base }, [], doc),
    ...c.bars.flatMap((b) => [
      s('rect', { class: b.on ? 'bar on' : 'bar', x: b.x, y: b.y, width: CHART.barW, height: b.h, rx: 4 }, [], doc),
      s('text', { class: b.on ? 'v on' : 'v', x: b.x + mid, y: b.y - 6, 'text-anchor': 'middle' }, [b.valueText], doc),
      s('text', { class: b.on ? 'm on' : 'm', x: b.x + mid, y: CHART.base + 18, 'text-anchor': 'middle' }, [b.monthText], doc),
    ]),
  ], doc);
}

/** 차이 막대(가운데 기준 양쪽) */
function diffSvg(bar, doc) {
  if (!bar) return null;
  return s('svg', { class: 'diff-bar', width: DIFF_BAR.width, height: 6, viewBox: `0 0 ${DIFF_BAR.width} 6`, 'aria-hidden': 'true' }, [
    s('rect', { class: 'track', x: 0, y: 2, width: DIFF_BAR.width, height: 2 }, [], doc),
    s('rect', { class: `d ${bar.tone}`, x: bar.x, y: 0, width: bar.w, height: 6, rx: 2 }, [], doc),
  ], doc);
}

const nameSpan = (r, cls, doc) => h('span', { class: cls }, [
  r.name, r.off ? h('span', { class: 'tag', text: '꺼짐' }, [], doc) : null,
], doc);

// ---------------------------------------------------------------- 11 리포트
export async function loadReport(db, monthStart, view) {
  const months = sixMonths(monthStart);
  const prevMonth = addMonths(monthStart, -1);
  const reads = [
    db.select('v_monthly_summary', { columns: 'period_month,expense_amount,income_amount', filters: between(months[0], monthStart) }),
    db.select('categories', { columns: 'id,parent_id,name,is_active' }),
    view === 'income'
      ? db.select('v_monthly_income', { columns: 'period_month,category_id,total_amount', filters: between(prevMonth, monthStart) })
      : db.select('v_monthly_category', { columns: 'period_month,category_id,group_category_id,total_amount', filters: between(prevMonth, monthStart) }),
  ];
  const res = await Promise.all(reads);
  const error = firstError(res);
  if (error) return { error };
  return { data: { summary: res[0].data ?? [], categories: res[1].data ?? [], rows: res[2].data ?? [] } };
}

/**
 * @param {{ db, monthStart, view: 'expense'|'income', isCurrent(), onError }} ctx
 */
export async function renderReport({ db, monthStart, view = 'expense', isCurrent, onError }, doc = globalThis.document) {
  const res = await loadReport(db, monthStart, view);
  if (!isCurrent()) return null;
  const query = (n) => ({ month: ym(addMonths(monthStart, n)), view: view === 'income' ? 'income' : null });
  const nav = (n, label, text) => h('a', { class: 'icon-btn', text, attrs: { href: buildHash('report', { query: query(n) }), 'aria-label': label } }, [], doc);
  const head = backHead(buildHash('more'), '더보기로', '', doc, [
    nav(-1, '이전 달', '‹'),
    h('h1', { class: 'title', text: `${month(monthStart)} 리포트` }, [], doc),
    nav(1, '다음 달', '›'),
  ]);
  if (res.error) return failView(head, res.error, onError, doc);
  const { summary, categories, rows } = res.data;
  const cats = categoryMap(categories);
  const prevMonth = addMonths(monthStart, -1);
  const sumOf = (m) => summary.find((r) => r.period_month === m) ?? null;
  const cur = sumOf(monthStart);
  const prev = sumOf(prevMonth);
  const hasPrev = prev != null;
  const isIncome = view === 'income';
  const key = isIncome ? 'income_amount' : 'expense_amount';
  const curAmount = Number(cur?.[key] ?? 0);
  const label = isIncome ? '수입' : '지출';
  const mNo = `${Number(monthStart.slice(5, 7))}월`;

  const seg = h('nav', { class: 'seg', attrs: { 'aria-label': '보기' } }, [
    ['expense', '지출'], ['income', '수입'],
  ].map(([v, text]) => h('a', {
    class: (isIncome ? 'income' : 'expense') === v ? 'on' : '',
    text,
    attrs: {
      href: buildHash('report', { query: { month: ym(monthStart), view: v === 'income' ? 'income' : null } }),
      'aria-current': (isIncome ? 'income' : 'expense') === v ? 'page' : null,
    },
  }, [], doc)), doc);

  const cmp = hasPrev ? (isIncome ? incomeCompareText : compareText)(curAmount, Number(prev[key] ?? 0)) : null;
  const points = series(sixMonths(monthStart), (m) => sumOf(m)?.[key] ?? 0);
  const hero = h('section', { class: 'card' }, [
    h('p', { class: 'label', text: `${mNo} ${label}` }, [], doc),
    h('p', { class: 'amount-xl', text: won(points[points.length - 1].value) }, [], doc),
    cmp ? h('p', { class: 'muted', text: cmp }, [], doc) : null,
    barSvg(points, monthStart, label, doc),
  ], doc);

  const prevNo = `${Number(prevMonth.slice(5, 7))}월`;
  const legend = h('span', { class: 'legend' }, hasPrev ? [
    `${prevNo} 대비 · `, h('span', { class: 'up', text: '늘어남' }, [], doc), ' · ', h('span', { class: 'down', text: '줄어듦' }, [], doc),
  ] : ['지난달 자료 없음'], doc);
  const cardHead = (title) => h('div', { class: 'card-head' }, [h('h2', { class: 'card-title', text: title }, [], doc), legend], doc);

  let body;
  if (!isIncome) {
    const groups = compareGroups(rows.filter((r) => r.period_month === monthStart), rows.filter((r) => r.period_month === prevMonth), cats, monthStart, { hasPrev });
    body = h('section', { class: 'card' }, [
      cardHead('지난달과 비교'),
      groups.length === 0 ? h('p', { class: 'muted', text: '이 달과 지난달에 쓴 돈이 없어요' }, [], doc)
        : h('ul', { class: 'cmp-list' }, groups.map((g) => h('li', {}, [
          h('a', { class: 'cmp', attrs: { href: g.href } }, [
            nameSpan(g, g.id ? 'cmp-name' : 'cmp-name none', doc),
            h('span', { class: 'cmp-amount', text: g.amountText }, [], doc),
            h('span', { class: 'cmp-diff' }, [h('span', { class: g.diff.tone, text: g.diff.text }, [], doc), diffSvg(g.bar, doc)], doc),
          ], doc),
        ], doc)), doc),
      h('p', { class: 'muted small', text: '합계는 홈의 이번 달 지출과 같아요. 집계 제외는 빼고, 환불은 원거래 달·카테고리에서 뺐어요.' }, [], doc),
    ], doc);
  } else {
    const iv = incomeView(rows.filter((r) => r.period_month === monthStart), rows.filter((r) => r.period_month === prevMonth), cats, { hasPrev });
    body = h('div', { class: 'stack' }, [
      h('section', { class: 'card' }, [
        cardHead('카테고리별'),
        iv.byCategory.length === 0 ? h('p', { class: 'muted', text: '이 달과 지난달에 들어온 돈이 없어요' }, [], doc)
          : h('ul', { class: 'cmp-list' }, iv.byCategory.map((g) => h('li', {}, [
            h('div', { class: 'cmp' }, [
              nameSpan(g, g.id ? 'cmp-name' : 'cmp-name none', doc),
              h('span', { class: 'cmp-amount', text: g.amountText }, [], doc),
              h('span', { class: 'cmp-diff' }, [h('span', { class: g.diff.tone, text: g.diff.text }, [], doc)], doc),
            ], doc),
          ], doc)), doc),
      ], doc),
      h('p', { class: 'muted small', text: '집계 제외는 뺐어요.' }, [], doc),
    ], doc);
  }
  return h('main', { class: 'screen' }, [head, seg, hero, body], doc);
}

// ---------------------------------------------------------------- 12 그룹 펼치기
export async function renderReportGroup({ db, id, monthStart, isCurrent, onError }, doc = globalThis.document) {
  const months = sixMonths(monthStart);
  const prevMonth = addMonths(monthStart, -1);
  const res = await Promise.all([
    db.select('v_monthly_category', { columns: 'period_month,category_id,group_category_id,total_amount', filters: [eq('group_category_id', id), ...between(months[0], monthStart)] }),
    db.select('v_monthly_summary', { columns: 'period_month,expense_amount', filters: between(prevMonth, monthStart) }),
    db.select('categories', { columns: 'id,parent_id,name,is_active' }),
  ]);
  if (!isCurrent()) return null;
  const back = buildHash('report', { query: { month: ym(monthStart) } });
  const error = firstError(res);
  if (error) return failView(backHead(back, '리포트로', '리포트', doc), error, onError, doc);
  const cats = categoryMap(res[2].data ?? []);
  const summary = res[1].data ?? [];
  const cur = summary.find((r) => r.period_month === monthStart);
  const hasPrev = summary.some((r) => r.period_month === prevMonth);
  const g = groupView(res[0].data ?? [], id, monthStart, cats, { totalExpense: cur?.expense_amount ?? 0, hasPrev });
  const head = backHead(back, '리포트로', `${g.name} · ${month(monthStart)}`, doc);

  const hero = h('section', { class: 'card' }, [
    h('p', { class: 'label' }, [g.name, g.off ? h('span', { class: 'tag', text: '꺼짐' }, [], doc) : null], doc),
    h('p', { class: 'amount-xl', text: g.amountText }, [], doc),
    g.sub ? h('p', { class: 'muted', text: g.sub }, [], doc) : null,
    barSvg(g.points, monthStart, g.name, doc),
  ], doc);
  const items = h('section', { class: 'card' }, [
    g.items.length === 0 ? h('p', { class: 'muted', text: '이 달과 지난달에 이 그룹에 쓴 돈이 없어요' }, [], doc)
      : h('ul', { class: 'item-list' }, g.items.map((it) => h('li', {}, [
        h('a', { class: 'item', attrs: { href: it.href } }, [
          h('span', { class: 'item-top' }, [
            nameSpan(it, 'item-name', doc),
            h('span', { class: 'item-amount', text: it.amountText }, [], doc),
            h('span', { class: 'chev', text: '›', attrs: { 'aria-hidden': 'true' } }, [], doc),
          ], doc),
          h('span', { class: 'item-bottom' }, [
            h('span', { class: 'bar-track', attrs: { 'aria-hidden': 'true' } }, [h('span', { class: `bar-fill ${widthClass(it.ratio)}` }, [], doc)], doc),
            h('span', { class: 'item-pct', text: it.pctText }, [], doc),
            h('span', { class: `item-diff ${it.diff.tone}`, text: it.diff.text }, [], doc),
          ], doc),
        ], doc),
      ], doc)), doc),
  ], doc);
  const note = h('p', { class: 'muted small', text: hasPrev ? `오른쪽 금액은 ${Number(prevMonth.slice(5, 7))}월과 비교한 차이예요. 항목을 누르면 그 달 거래를 봐요.` : '항목을 누르면 그 달 거래를 봐요.' }, [], doc);
  return h('main', { class: 'screen' }, [head, hero, items, note], doc);
}

// ---------------------------------------------------------------- 13 항목 거래
/** 그 달·그 카테고리 몫을 쪽 단위로 끝까지(빈 쪽까지 — 서버 max-rows 대비, readMonthRows와 같은 방식) */
export async function readShares(db, monthStart, catId, { pageSize = 1000, max = MAX_SHARES } = {}) {
  const shares = [];
  const seen = new Set();
  let offset = 0;
  while (shares.length <= max) {
    const r = await db.select('v_monthly_category_txn', {
      columns: 'txn_id,signed_amount',
      filters: [eq('period_month', monthStart), eq('category_id', catId)],
      order: [{ col: 'txn_id', ascending: true }],
      range: { from: offset, to: offset + Math.min(pageSize, max + 1 - shares.length) - 1 },
    });
    if (r.error) return { error: r.error };
    const page = r.data ?? [];
    if (page.length === 0) break;
    offset += page.length;
    for (const row of page) {
      if (seen.has(row.txn_id)) continue;
      seen.add(row.txn_id);
      shares.push(row);
    }
  }
  return { data: { shares: shares.slice(0, max), capped: shares.length > max } };
}

export async function renderReportItem({ db, id, monthStart, isCurrent, onError }, doc = globalThis.document) {
  const [shares, detail, categories, members] = await Promise.all([
    readShares(db, monthStart, id),
    readMonthRows(db, monthStart),
    db.select('categories', { columns: 'id,parent_id,name,is_active' }),
    db.select('members', { columns: 'id,member_slot' }),
  ]);
  if (!isCurrent()) return null;
  const cats = categoryMap(categories.data ?? []);
  const groupId = cats.get(id)?.parentId ?? id;
  const back = buildHash('rgroup', { id: groupId, query: { month: ym(monthStart) } });
  const error = firstError([shares, detail, categories, members]);
  if (error) return failView(backHead(back, '그룹으로', '리포트', doc), error, onError, doc);
  const slotOf = new Map((members.data ?? []).map((m) => [m.id, m.member_slot]));
  const it = itemTxns(shares.data.shares, detail.data.rows, id, cats, slotOf);
  const head = backHead(back, '그룹으로', `${it.name} · ${Number(monthStart.slice(5, 7))}월`, doc);
  const capped = shares.data.capped || detail.data.capped || it.missing > 0;

  const top = h('section', { class: 'card' }, [
    h('p', { class: 'amount-xl', text: it.totalText }, [], doc),
    h('p', { class: 'muted', text: `거래 ${it.count}건 · 리포트 숫자와 같은 기준` }, [], doc),
    h('p', { class: 'muted small', text: '나눈 거래는 이 카테고리 몫만, 환불은 −로 셌어요.' }, [], doc),
    capped ? h('p', { class: 'notice small', text: capNotice(true) }, [], doc) : null,
  ], doc);
  const viewOf = new Map(it.rows.map((x) => [x.row.id, x.view]));
  const list = it.rows.length === 0
    ? h('p', { class: 'card muted', text: '이 달에 이 카테고리 거래가 없어요' }, [], doc)
    : h('div', { class: 'day-groups' }, groupByDay(it.rows.map((x) => x.row)).map((g) => h('section', { class: 'card day' }, [
      h('h2', { class: 'day-title', text: g.label }, [], doc),
      h('ul', { class: 'txn-list' }, g.rows.map((r) => {
        const v = viewOf.get(r.id);
        return h('li', {}, [h('a', { class: `txn tone-${v.tone}`, attrs: { href: buildHash('txn', { id: v.id }) } }, [
          h('span', { class: `payer payer-${v.payer.slot}`, text: v.payer.initial, attrs: { title: v.payer.name, 'aria-label': `결제자 ${v.payer.name}` } }, [], doc),
          h('span', { class: 'txn-main' }, [
            h('span', { class: 'txn-merchant', text: v.merchant }, [], doc),
            h('span', { class: 'sub' }, [v.sub, ...v.tags.map((t) => h('span', { class: 'tag', text: t }, [], doc))], doc),
          ], doc),
          h('span', { class: 'txn-amount', text: v.amountText }, [], doc),
        ], doc)], doc);
      }), doc),
    ], doc)), doc);
  return h('main', { class: 'screen' }, [head, top, list], doc);
}
