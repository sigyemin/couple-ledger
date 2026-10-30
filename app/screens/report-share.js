// =====================================================================
// 리포트 › '어디에 얼마나 썼나' 비중 카드 (CL-059). 읽기만 한다
// 조회: 대분류·세부분류 = v_monthly_category(기간), 결제수단·명의 = transactions(기간, 쪽 단위) + payment_sources + members
//       (거래 조건은 v_monthly_summary 지출과 같게: 휴지통·집계 제외 빼고 지출·환불, 시험 결제수단은 앱에서 뺌)
// 그리기: 도넛(svg.js circle, innerHTML 없음) + 범례(이름·금액·비율 글자), 가운데 총액. role="img" + aria-label에 모든 값
// 의존: ui/dom.js, ui/svg.js, router.js, core/format.js, screens/report-share-model.js, screens/report-model.js(categoryMap)
// =====================================================================
import { h } from '../ui/dom.js';
import { s } from '../ui/svg.js';
import { buildHash } from '../router.js';
import { won } from '../core/format.js';
import { BYS, SPANS, DONUT, spanRange, spanLabel, shareEntries, shareSlices, donutArcs, shareAria } from './report-share-model.js';
import { categoryMap } from './report-model.js';

const PAGE_SIZE = 1000;
const MAX_ROWS = 20000;

/** 기간 안 지출·환불 거래를 쪽 단위로 끝까지(빈 쪽까지, id로 중복 거름) */
export async function readShareTxns(db, from, to, { pageSize = PAGE_SIZE, max = MAX_ROWS } = {}) {
  const rows = [];
  const seen = new Set();
  let offset = 0;
  while (rows.length <= max) {
    const r = await db.select('transactions', {
      columns: 'id,source_id,kind,amount',
      filters: [
        { col: 'period_month', op: 'gte', value: from }, { col: 'period_month', op: 'lte', value: to },
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

/** 기준·기간에 맞는 조회만 */
export async function loadShare(db, monthStart, by, span) {
  const { from, to } = spanRange(monthStart, span);
  if (by === 'group' || by === 'item') {
    const [rows, cats] = await Promise.all([
      db.select('v_monthly_category', { columns: 'period_month,category_id,group_category_id,total_amount', filters: [{ col: 'period_month', op: 'gte', value: from }, { col: 'period_month', op: 'lte', value: to }] }),
      db.select('categories', { columns: 'id,parent_id,name,is_active' }),
    ]);
    const error = [rows, cats].find((r) => r.error)?.error;
    if (error) return { error };
    return { data: { categoryRows: rows.data ?? [], cats: categoryMap(cats.data ?? []), capped: false } };
  }
  const [txns, sources, members] = await Promise.all([
    readShareTxns(db, from, to),
    db.select('payment_sources', { columns: 'id,label,owner_member_id,is_test' }),
    db.select('members', { columns: 'id,member_slot,display_name' }),
  ]);
  const error = [txns, sources, members].find((r) => r.error)?.error;
  if (error) return { error };
  return { data: { txns: txns.data.rows, sources: sources.data ?? [], members: members.data ?? [], capped: txns.data.capped } };
}

function donutSvg(sl, aria, doc) {
  const c = DONUT.size / 2;
  const arcs = donutArcs(sl.slices);
  return s('svg', { class: 'donut', viewBox: `0 0 ${DONUT.size} ${DONUT.size}`, role: 'img', 'aria-label': aria }, [
    s('circle', { class: 'donut-track', cx: c, cy: c, r: DONUT.r }, [], doc),
    s('g', { transform: `rotate(-90 ${c} ${c})` }, arcs.map((a) => s('circle', {
      class: `donut-arc ${a.tone}`, cx: c, cy: c, r: DONUT.r,
      'stroke-dasharray': `${a.dash.toFixed(2)} ${a.rest.toFixed(2)}`, 'stroke-dashoffset': a.offset.toFixed(2),
    }, [], doc)), doc),
    s('text', { class: 'donut-label', x: c, y: c - 6, 'text-anchor': 'middle' }, ['합계'], doc),
    s('text', { class: 'donut-total', x: c, y: c + 14, 'text-anchor': 'middle' }, [sl.totalText], doc),
  ], doc);
}

/**
 * @param {{ db, monthStart, by, span, onError }} ctx
 * @returns {Promise<HTMLElement|null>} 카드(조회 실패면 오류 줄이 든 카드)
 */
export async function renderShareCard({ db, monthStart, by, span, onError }, doc = globalThis.document) {
  const res = await loadShare(db, monthStart, by, span);
  const byLabel = BYS.find(([k]) => k === by)[1];
  const spanText = spanLabel(monthStart, span);
  const link = (q, text, on) => h('a', {
    class: on ? 'on' : '', text,
    attrs: { href: buildHash('report', { query: { month: monthStart.slice(0, 7), by: q.by === 'group' ? null : q.by, span: q.span === 'month' ? null : q.span } }), 'aria-current': on ? 'page' : null },
  }, [], doc);
  const bySeg = h('nav', { class: 'seg small', attrs: { 'aria-label': '차트 기준' } }, BYS.map(([k, t]) => link({ by: k, span }, t, k === by)), doc);
  const spanSeg = h('nav', { class: 'seg small', attrs: { 'aria-label': '기간' } }, SPANS.map(([k, t]) => link({ by, span: k }, t, k === span)), doc);
  const title = h('h2', { class: 'card-title', text: `어디에 얼마나 썼나 · ${spanText}` }, [], doc);
  if (res.error) {
    onError?.(res.error);
    return h('section', { class: 'card' }, [title, bySeg, spanSeg, h('p', { class: 'notice small', attrs: { role: 'alert' }, text: '차트 자료를 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.' }, [], doc)], doc);
  }
  const sl = shareSlices(shareEntries(by, res.data, monthStart));
  const body = sl.slices.length === 0
    ? h('p', { class: 'muted', text: `${spanText}에 쓴 돈이 없어요` }, [], doc)
    : h('div', { class: 'share' }, [
      donutSvg(sl, shareAria(byLabel, spanText, sl), doc),
      h('ul', { class: 'share-legend' }, sl.slices.map((x) => {
        const inner = [
          h('span', { class: `swatch ${x.tone}`, attrs: { 'aria-hidden': 'true' } }, [], doc),
          h('span', { class: 'share-name' }, [
            h('span', { text: x.name }, [], doc),
            x.members ? h('span', { class: 'sub', text: x.members.join(' · ') }, [], doc) : null,
          ], doc),
          h('span', { class: 'share-pct', text: x.pctText }, [], doc),
          h('span', { class: 'share-amount', text: x.amountText }, [], doc),
        ];
        return h('li', {}, [x.href ? h('a', { class: 'share-row', attrs: { href: x.href } }, inner, doc) : h('div', { class: 'share-row' }, inner, doc)], doc);
      }), doc),
    ], doc);
  const notes = [
    sl.negatives.count ? `환불이 더 많은 ${sl.negatives.count}개(${won(sl.negatives.amount)})는 원에서 뺐어요.` : null,
    res.data.capped ? '거래가 너무 많아 일부만 더했어요.' : null,
    span === 'ytd' ? '항목을 누르면 고른 달의 화면으로 가요.' : null,
  ].filter(Boolean);
  return h('section', { class: 'card' }, [
    title, bySeg, spanSeg, body,
    ...notes.map((t) => h('p', { class: 'muted small', text: t }, [], doc)),
    h('p', { class: 'muted small', text: '공동·개인 합친 지출에서 환불을 뺀 금액이에요. 집계 제외·휴지통·시험 결제수단은 빼요.' }, [], doc),
  ], doc);
}
