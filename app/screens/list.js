// =====================================================================
// 화면 5 내역 (화면 설계 v0.1 4-3, 시안 5): 달 선택, 검색, 칩·필터, 합계, 날짜별 목록
// 조회: v_transaction_detail(그 귀속월, 휴지통·테스트 결제수단 제외), members, categories
// - 필터는 해시 쿼리로만 바꾼다(go) → 라우터가 다시 그린다
// - 다중 선택(sel=1) → bulk_set_category, + 직접 추가(#/add)
// 의존: ui/dom.js, router.js, screens/list-model.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { confirmDialog } from '../core/confirm.js';
import { STAGES, ACTIONS } from '../core/errors.js';
import { categoryOptions } from './detail-model.js';
import { addMonths, buildHash } from '../router.js';
import { month } from '../core/format.js';
import {
  bulkPlan, bulkConfirmText, changedTxnCount, selectable,
  capNotice, MAX_ROWS, parseListFilter, filterQuery, categoryIndex, filterRows, summarize, rowView, groupByDay, hasFilter,
} from './list-model.js';
import { errorView } from './shell.js';

export const LIST_COLUMNS = [
  'id', 'source_id', 'occurred_on', 'occurred_time', 'merchant_raw', 'merchant_norm', 'amount', 'kind', 'is_shared', 'is_excluded',
  'review_status', 'memo', 'refund_of_txn_id', 'source_label', 'payer_member_id', 'payer_name', 'lines',
  'is_uncategorized', 'inherited_category_id', 'is_changed_after_review', 'card_kind',
].join(',');

const eq = (col, value) => ({ col, op: 'eq', value });

// 다시 그린 목록에 한 번 보여 줄 안내(일괄 변경 결과)
let listNotice = null;

export const PAGE_SIZE = 1000;

/**
 * 한 달 거래를 쪽 단위로 끝까지 읽는다(최대 MAX_ROWS + 1건 — 넘는지 알려고 한 건 더).
 * - 서버(PostgREST max-rows)가 요청한 range보다 적게 줄 수 있어, 쪽 크기와 비교하지 않고 빈 쪽이 올 때까지 읽는다
 * - 쪽이 어긋나지 않게 id로 끝 정렬을 고정한다
 * - 읽는 도중 거래가 추가되면 쪽 경계의 행이 두 번 올 수 있어 id로 거른다(PR #12 재리뷰 ④).
 *   읽는 도중 지워진 거래 때문에 한 건이 빠지는 경우는 막지 못한다(다시 열면 맞음) [한계]
 * @returns {{ data: { rows, capped } } | { error }}
 */
export async function readMonthRows(db, monthStart, { pageSize = PAGE_SIZE, max = MAX_ROWS } = {}) {
  const rows = [];
  const seen = new Set();
  let offset = 0;
  while (rows.length <= max) {
    const from = offset;
    const r = await db.select('v_transaction_detail', {
      columns: LIST_COLUMNS,
      filters: [eq('period_month', monthStart), { col: 'deleted_at', op: 'is', value: null }, eq('is_test_source', false)],
      order: [{ col: 'occurred_on', ascending: false }, { col: 'id', ascending: true }],
      range: { from, to: from + Math.min(pageSize, max + 1 - rows.length) - 1 },
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

export async function loadList(db, monthStart) {
  const [txns, members, categories] = await Promise.all([
    readMonthRows(db, monthStart),
    db.select('members', { columns: 'id,member_slot,display_name' }),
    db.select('categories', { columns: 'id,parent_id,name,code,sort_order,is_active' }),
  ]);
  const error = [txns, members, categories].find((r) => r.error)?.error;
  if (error) return { error };
  return { data: { rows: txns.data.rows, capped: txns.data.capped, members: members.data ?? [], categories: categories.data ?? [] } };
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
    h('nav', { class: 'head-actions', attrs: { 'aria-label': '내역 동작' } }, [
      h('a', { class: `chip${f.sel ? ' on' : ''}`, text: f.sel ? '선택 끝' : '선택',
        attrs: { href: buildHash('list', { query: filterQuery(ym(monthStart), { ...f, sel: !f.sel }) }), 'aria-current': f.sel ? 'true' : null } }, [], doc),
      h('a', { class: 'chip', text: '+ 직접 추가', attrs: { href: buildHash('add', { query: { month: ym(monthStart) } }) } }, [], doc),
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
  const { rows, capped: isCapped, members, categories } = res.data;
  const ctx = { cats: categoryIndex(categories), slotOf: new Map(members.map((m) => [m.id, m.member_slot])) };
  const set = (patch) => go(buildHash('list', { query: filterQuery(ym, { ...f, ...patch }) }));
  const status = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  const say = (msg, isError = false) => {
    status.textContent = msg;
    status.className = `status-line${isError ? ' error' : ''}`;
  };
  if (listNotice) {
    say(listNotice.text, listNotice.isError);
    listNotice = null;
  }

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
  const cap = capNotice(isCapped);
  const capped = cap ? h('p', { class: 'card notice', text: cap, attrs: { role: 'status' } }, [], doc) : null;
  const summary = h('section', { class: 'card sum-row', attrs: { 'aria-label': '합계' } }, [
    h('p', {}, [h('span', { class: 'sub', text: '지출' }, [], doc), h('strong', { text: sum.expense }, [], doc)], doc),
    h('p', {}, [h('span', { class: 'sub', text: '수입' }, [], doc), h('strong', { text: sum.income }, [], doc)], doc),
    h('p', {}, [h('span', { class: 'sub', text: '건수' }, [], doc), h('strong', { text: sum.count }, [], doc)], doc),
  ], doc);

  // 다중 선택: 고른 id (화면을 다시 그리면 비워진다)
  const picked = new Set();
  const bar = f.sel ? bulkBar() : null;
  const rowLink = (r, v) => {
    const inner = [
      h('span', { class: `payer payer-${v.payer.slot}`, text: v.payer.initial, attrs: { title: v.payer.name, 'aria-label': `결제자 ${v.payer.name}` } }, [], doc),
      h('span', { class: 'txn-main' }, [
        h('span', { class: 'txn-merchant', text: v.merchant }, [], doc),
        h('span', { class: 'sub' }, [
          v.sub,
          ...v.tags.map((t) => h('span', { class: 'tag', text: t }, [], doc)),
        ], doc),
      ], doc),
      h('span', { class: 'txn-amount', text: v.amountText }, [], doc),
    ];
    if (!f.sel) return h('a', { class: `txn tone-${v.tone}`, attrs: { href: buildHash('txn', { id: v.id }) } }, inner, doc);
    const box = h('input', { attrs: { type: 'checkbox', 'aria-label': `${v.merchant} ${v.amountText} 고르기` } }, [], doc);
    box.disabled = !selectable(r);
    box.addEventListener('change', () => {
      if (box.checked) picked.add(r.id); else picked.delete(r.id);
      bar.refresh();
    });
    return h('label', { class: `txn pick tone-${v.tone}` }, [box, ...inner], doc);
  };

  /** 아래 고정 막대: N건 · 모두 고르기 · 카테고리 · 바꾸기 */
  function bulkBar() {
    const count = h('strong', { text: '0건 고름' }, [], doc);
    const cat = h('select', { class: 'field', attrs: { 'aria-label': '바꿀 카테고리' } }, [], doc);
    const apply = h('button', { class: 'btn primary', text: '바꾸기', attrs: { type: 'button' } }, [], doc);
    const all = h('button', { class: 'btn secondary small-btn', text: '모두 고르기', attrs: { type: 'button' } }, [], doc);
    let kindShown = null;
    const fillCats = (kind) => {
      if (kind === kindShown) return;
      kindShown = kind;
      cat.replaceChildren(h('option', { text: '카테고리 고르기', attrs: { value: '' } }, [], doc),
        ...categoryOptions(categories, kind).map((g) => h('optgroup', { attrs: { label: g.group } },
          g.items.map((it) => h('option', { text: it.name, attrs: { value: it.id } }, [], doc)), doc)));
    };
    const pickedRows = () => shown.filter((r) => picked.has(r.id));
    const el = h('section', { class: 'bulk-bar', attrs: { 'aria-label': '고른 거래 바꾸기' } }, [count, all, cat, apply], doc);
    el.refresh = () => {
      const plan = bulkPlan(pickedRows());
      count.textContent = `${picked.size}건 고름`;
      fillCats(plan.ok ? plan.kind : 'expense');
      apply.disabled = !plan.ok;
    };
    all.addEventListener('click', () => {
      for (const box of doc.querySelectorAll('label.pick input[type=checkbox]:not(:disabled)')) {
        if (!box.checked) { box.checked = true; box.dispatchEvent(new Event('change')); }
      }
    });
    apply.addEventListener('click', async () => {
      const plan = bulkPlan(pickedRows());
      if (!plan.ok) { say(plan.message, true); return; }
      if (!cat.value) { say('바꿀 카테고리를 골라 주세요', true); return; }
      const name = ctx.cats.get(cat.value)?.name ?? '';
      if (!(await confirmDialog({ ...bulkConfirmText(plan, name), confirmLabel: '바꾸기', doc }))) return;
      apply.disabled = true;
      const r = await db.rpc('bulk_set_category', {
        p_txn_ids: plan.ids, p_category_id: cat.value, p_description: `내역 일괄 · ${plan.ids.length}건 → ${name}`.slice(0, 200),
      });
      if (r.error) {
        apply.disabled = false;
        const code = onError?.(r.error, { stage: STAGES.db_rpc, action: ACTIONS.bulk_edit });
        say(`${r.error.message}${code ? ` (오류 번호 ${code})` : ''}`, true);
        return;
      }
      listNotice = { text: `${changedTxnCount(r.data)}건의 카테고리를 '${name}'(으)로 바꿨어요. 더보기 › 변경 기록에서 되돌릴 수 있어요.`, isError: false };
      set({ sel: false });
    });
    el.refresh();
    return el;
  }

  const list = shown.length === 0
    ? h('p', { class: 'card muted', text: rows.length === 0 ? '이 달에 거래가 없어요' : '조건에 맞는 거래가 없어요' }, [], doc)
    : h('div', { class: 'day-groups' }, groupByDay(shown).map((g) => h('section', { class: 'card day' }, [
      h('h2', { class: 'day-title', text: g.label }, [], doc),
      h('ul', { class: 'txn-list' }, g.rows.map((r) => {
        const v = rowView(r, ctx);
        return h('li', {}, [rowLink(r, v)], doc);
      }), doc),
    ], doc)), doc);

  return h('main', { class: `screen${f.sel ? ' selecting' : ''}` }, [head, status, search, chips, more, capped, summary, list, bar], doc);
}
