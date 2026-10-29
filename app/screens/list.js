// =====================================================================
// 화면 5 내역 (화면 설계 v0.1 4-3, 시안 5): 달 선택, 검색, 칩·필터, 합계, 날짜별 목록
// 조회: v_transaction_detail(그 귀속월, 휴지통·테스트 결제수단 제외), members, categories
// - 필터는 해시 쿼리로만 바꾼다(go) → 라우터가 다시 그린다
// - 다중 선택·직접 추가는 다음 단계
// 의존: ui/dom.js, router.js, screens/list-model.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { addMonths, buildHash } from '../router.js';
import { month } from '../core/format.js';
import {
  MAX_ROWS, parseListFilter, filterQuery, categoryIndex, filterRows, summarize, rowView, groupByDay, hasFilter,
} from './list-model.js';
import { errorView } from './shell.js';

export const LIST_COLUMNS = [
  'id', 'source_id', 'occurred_on', 'occurred_time', 'merchant_raw', 'amount', 'kind', 'is_shared', 'is_excluded',
  'review_status', 'memo', 'refund_of_txn_id', 'source_label', 'payer_member_id', 'payer_name', 'lines',
  'is_uncategorized', 'inherited_category_id', 'is_changed_after_review',
].join(',');

const eq = (col, value) => ({ col, op: 'eq', value });

export async function loadList(db, monthStart) {
  const [txns, members, categories] = await Promise.all([
    db.select('v_transaction_detail', {
      columns: LIST_COLUMNS,
      filters: [eq('period_month', monthStart), { col: 'deleted_at', op: 'is', value: null }, eq('is_test_source', false)],
      order: [{ col: 'occurred_on', ascending: false }],
      range: { from: 0, to: MAX_ROWS - 1 },
    }),
    db.select('members', { columns: 'id,member_slot,display_name' }),
    db.select('categories', { columns: 'id,parent_id,name,code,sort_order,is_active' }),
  ]);
  const error = [txns, members, categories].find((r) => r.error)?.error;
  if (error) return { error };
  return { data: { rows: txns.data ?? [], members: members.data ?? [], categories: categories.data ?? [] } };
}

function monthHead(monthStart, f, doc) {
  const ym = (m) => m.slice(0, 7);
  const link = (n, label, text) => h('a', {
    class: 'icon-btn', text, attrs: { href: buildHash('list', { query: filterQuery(ym(addMonths(monthStart, n)), f) }), 'aria-label': label },
  }, [], doc);
  return h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav', attrs: { 'aria-label': '달 선택' } }, [
      link(-1, '이전 달', '‹'),
      h('h1', { class: 'title', text: `${month(monthStart).replace(/^[0-9]+년 /, '')} 내역` }, [], doc),
      link(1, '다음 달', '›'),
    ], doc),
  ], doc);
}

function select(label, name, value, options, onChange, doc) {
  const el = h('select', { class: 'field', attrs: { name, 'aria-label': label } }, options.map(([v, text]) => {
    const o = h('option', { text, attrs: { value: v } }, [], doc);
    if (v === (value ?? '')) o.selected = true;
    return o;
  }), doc);
  el.addEventListener('change', () => onChange(el.value || null));
  return h('label', { class: 'filter-field' }, [h('span', { class: 'sub', text: label }, [], doc), el], doc);
}

function checkbox(label, checked, onChange, doc) {
  const el = h('input', { attrs: { type: 'checkbox' } }, [], doc);
  el.checked = checked;
  el.addEventListener('change', () => onChange(el.checked));
  return h('label', { class: 'filter-check' }, [el, h('span', { text: label }, [], doc)], doc);
}

/**
 * @param {{ db, monthStart, query: Map, go(hash), isCurrent(), onError(err) }} ctx
 */
export async function renderList({ db, monthStart, query, go, isCurrent, onError }, doc = globalThis.document) {
  const f = parseListFilter(query);
  const ym = monthStart.slice(0, 7);
  const res = await loadList(db, monthStart);
  if (!isCurrent()) return null;
  const head = monthHead(monthStart, f, doc);
  if (res.error) {
    onError?.(res.error);
    return h('main', { class: 'screen' }, [head, errorView(res.error.message, res.error.detail?.sqlState ?? res.error.code, doc)], doc);
  }
  const { rows, members, categories } = res.data;
  const ctx = { cats: categoryIndex(categories), slotOf: new Map(members.map((m) => [m.id, m.member_slot])) };
  const set = (patch) => go(buildHash('list', { query: filterQuery(ym, { ...f, ...patch }) }));

  // 검색 (form-action 'none'이라 제출은 막고 해시만 바꾼다)
  const input = h('input', { class: 'field search', attrs: { type: 'search', name: 'q', placeholder: '가맹점·메모 검색', 'aria-label': '가맹점·메모 검색', maxlength: '50' } }, [], doc);
  input.value = f.q;
  const search = h('form', { class: 'search-form', attrs: { role: 'search' } }, [input], doc);
  search.addEventListener('submit', (e) => {
    e.preventDefault();
    set({ q: input.value.normalize('NFKC').trim().slice(0, 50) });
  });

  // 칩: 전체 · 결제자 둘 · 검토 대기 · 미분류
  const chip = (text, active, patch) => h('a', {
    class: `chip${active ? ' on' : ''}`, text,
    attrs: { href: buildHash('list', { query: filterQuery(ym, { ...f, ...patch }) }), 'aria-current': active ? 'true' : null },
  }, [], doc);
  const bySlot = [...members].sort((a, b) => a.member_slot - b.member_slot);
  const chips = h('nav', { class: 'chips', attrs: { 'aria-label': '빠른 필터' } }, [
    chip('전체', !f.payer && !f.status && f.cat !== 'none', { payer: null, status: null, cat: null }),
    ...bySlot.map((m) => chip(m.display_name, f.payer === String(m.member_slot), { payer: f.payer === String(m.member_slot) ? null : String(m.member_slot) })),
    chip('검토 대기', f.status === 'needs_review', { status: f.status === 'needs_review' ? null : 'needs_review' }),
    chip('미분류', f.cat === 'none', { cat: f.cat === 'none' ? null : 'none' }),
  ], doc);

  // 더 많은 필터
  const sources = [...new Map(rows.map((r) => [r.source_id, r.source_label])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const groups = categories.filter((c) => !c.parent_id).sort((a, b) => a.sort_order - b.sort_order);
  const moreOn = Boolean(f.src || (f.cat && f.cat !== 'none') || f.share || f.kind || f.excluded || f.changed);
  const more = h('details', { class: 'card filters', attrs: { open: moreOn } }, [
    h('summary', { text: '필터' }, [], doc),
    select('결제수단', 'src', f.src, [['', '전체'], ...sources], (v) => set({ src: v }), doc),
    select('카테고리', 'cat', f.cat === 'none' ? '' : f.cat, [['', '전체'], ...groups.map((g) => [g.id, g.name])], (v) => set({ cat: v }), doc),
    select('공동·개인', 'share', f.share, [['', '전체'], ['shared', '공동'], ['personal', '개인']], (v) => set({ share: v }), doc),
    select('종류', 'kind', f.kind, [['', '전체'], ['expense', '지출'], ['refund', '환불'], ['refund_unlinked', '원거래 못 찾은 환불'], ['income', '수입'], ['transfer', '이체']], (v) => set({ kind: v }), doc),
    checkbox('집계 제외도 보기', f.excluded, (v) => set({ excluded: v }), doc),
    checkbox('확인 후 변경된 것만', f.changed, (v) => set({ changed: v }), doc),
    hasFilter(f) ? h('a', { class: 'text-link', text: '필터 모두 지우기', attrs: { href: buildHash('list', { query: { month: ym } }) } }, [], doc) : null,
  ], doc);

  const shown = filterRows(rows, f, ctx);
  const sum = summarize(shown);
  const summary = h('section', { class: 'card sum-row', attrs: { 'aria-label': '합계' } }, [
    h('p', {}, [h('span', { class: 'sub', text: '지출' }, [], doc), h('strong', { text: sum.expense }, [], doc)], doc),
    h('p', {}, [h('span', { class: 'sub', text: '수입' }, [], doc), h('strong', { text: sum.income }, [], doc)], doc),
    h('p', {}, [h('span', { class: 'sub', text: '건수' }, [], doc), h('strong', { text: sum.count }, [], doc)], doc),
  ], doc);

  const list = shown.length === 0
    ? h('p', { class: 'card muted', text: rows.length === 0 ? '이 달에 거래가 없어요' : '조건에 맞는 거래가 없어요' }, [], doc)
    : h('div', { class: 'day-groups' }, groupByDay(shown).map((g) => h('section', { class: 'card day' }, [
      h('h2', { class: 'day-title', text: g.label }, [], doc),
      h('ul', { class: 'txn-list' }, g.rows.map((r) => {
        const v = rowView(r, ctx);
        return h('li', {}, [
          h('a', { class: `txn tone-${v.tone}`, attrs: { href: buildHash('txn', { id: v.id }) } }, [
            h('span', { class: `payer payer-${v.payer.slot}`, text: v.payer.initial, attrs: { title: v.payer.name, 'aria-label': `결제자 ${v.payer.name}` } }, [], doc),
            h('span', { class: 'txn-main' }, [
              h('span', { class: 'txn-merchant', text: v.merchant }, [], doc),
              h('span', { class: 'sub' }, [
                v.sub,
                ...v.tags.map((t) => h('span', { class: 'tag', text: t }, [], doc)),
              ], doc),
            ], doc),
            h('span', { class: 'txn-amount', text: v.amountText }, [], doc),
          ], doc),
        ], doc);
      }), doc),
    ], doc)), doc);

  const capped = rows.length >= MAX_ROWS ? h('p', { class: 'muted small', text: `앞 ${MAX_ROWS}건만 보여요` }, [], doc) : null;
  return h('main', { class: 'screen' }, [head, search, chips, more, summary, list, capped], doc);
}
