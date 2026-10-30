// =====================================================================
// 거래 직접 추가 (화면 설계 v0.1 4-3 머리 "+ 직접 추가", 4-4 "수동 추가는 같은 양식")
// 조회: payment_sources(켜진 것), members, categories / 저장 전: v_monthly_review_status(그 달)
// 쓰기: transactions insert 한 행(허용 칸만 — core/db.js INSERT_COLUMNS) → (카테고리를 골랐으면) set_transaction_lines 한 줄
// 끝나면 새 거래 상세로 간다. 쓰기는 재시도하지 않는다
// 의존: ui/dom.js, router.js, core/confirm.js, core/errors.js, screens/add-model.js, screens/detail-model.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { buildHash, currentMonth } from '../router.js';
import { confirmDialog } from '../core/confirm.js';
import { STAGES } from '../core/errors.js';
import { todaySeoul } from '../core/format.js';
import { dateRange } from '../core/validate.js';
import { ADD_KINDS, sourceOptions, buildManualRow, monthOf, addConfirmText } from './add-model.js';
import { categoryOptions } from './detail-model.js';
import { noteForTxn } from './detail.js';
import { errorView } from './shell.js';

const eq = (col, value) => ({ col, op: 'eq', value });

export async function loadAdd(db) {
  const [sources, members, categories] = await Promise.all([
    db.select('payment_sources', { columns: 'id,label,kind,owner_member_id,is_active,is_test' }),
    db.select('members', { columns: 'id,member_slot,display_name' }),
    db.select('categories', { columns: 'id,parent_id,name,code,sort_order,is_active' }),
  ]);
  const error = [sources, members, categories].find((r) => r.error)?.error;
  if (error) return { error };
  return { data: { sources: sources.data ?? [], members: members.data ?? [], categories: categories.data ?? [] } };
}

/**
 * @param {{ db, member, query: Map, go(hash), isCurrent(), onError(err, extra) → string }} ctx
 */
export async function renderAdd({ db, member, query, go, isCurrent, onError }, doc = globalThis.document) {
  const res = await loadAdd(db);
  if (!isCurrent()) return null;
  const backMonth = /^[0-9]{4}-[0-9]{2}$/.test(query.get('month') ?? '') ? query.get('month') : currentMonth().slice(0, 7);
  const head = h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav' }, [
      h('a', { class: 'icon-btn', text: '‹', attrs: { href: buildHash('list', { query: { month: backMonth } }), 'aria-label': '내역으로' } }, [], doc),
      h('h1', { class: 'title', text: '직접 추가' }, [], doc),
    ], doc),
  ], doc);
  if (res.error) {
    onError?.(res.error);
    return h('main', { class: 'screen' }, [head, errorView(res.error.message, res.error.detail?.sqlState ?? res.error.code, doc)], doc);
  }
  const { sources, members, categories } = res.data;
  const srcOpts = sourceOptions(sources, members);
  // 이 화면에서 쓸 중복 키 하나. 응답이 끊겨 다시 눌러도 같은 키로 보내므로 두 번 들어가지 않는다(unique 위반 → 이미 추가됨)
  const entryKey = globalThis.crypto.randomUUID();
  let firstSent = null; // 이 키로 처음 보낸 내용(응답이 끊긴 뒤 고쳐서 다시 눌렀는지 알려고)

  const status = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  const say = (msg, isError = false) => {
    status.textContent = msg;
    status.className = `status-line${isError ? ' error' : ''}`;
  };
  const field = (label, control) => h('label', { class: 'filter-field' }, [h('span', { class: 'sub', text: label }, [], doc), control], doc);
  const select = (label, options, value) => {
    const el = h('select', { class: 'field', attrs: { 'aria-label': label } }, options.map(([v, text]) => {
      const o = h('option', { text, attrs: { value: v } }, [], doc);
      if (v === value) o.selected = true;
      return o;
    }), doc);
    return el;
  };
  const input = (label, attrs = {}) => h('input', { class: 'field', attrs: { 'aria-label': label, ...attrs } }, [], doc);

  if (srcOpts.length === 0) {
    return h('main', { class: 'screen' }, [head, h('p', { class: 'card muted', text: '켜진 결제수단이 없어요. 더보기 › 결제수단에서 먼저 만들어 주세요.' }, [], doc)], doc);
  }
  const src = select('결제수단', [['', '결제수단 고르기'], ...srcOpts.map((o) => [o.id, o.text])], '');
  const kind = select('종류', ADD_KINDS, 'expense');
  const today = todaySeoul();
  const range = dateRange(today);
  const date = input('날짜', { type: 'date', min: range.min, max: range.max });
  date.value = today;
  const time = input('시각(선택)', { type: 'time' });
  const merchant = input('가맹점·내용', { maxlength: '200', placeholder: '예: 동네 시장' });
  const amount = input('금액', { inputmode: 'numeric', maxlength: '20', placeholder: '원' });
  const cat = h('select', { class: 'field', attrs: { 'aria-label': '카테고리(선택)' } }, [], doc);
  const fillCats = () => {
    const keep = cat.value;
    cat.replaceChildren(
      h('option', { text: '미분류로 두기', attrs: { value: '' } }, [], doc),
      ...categoryOptions(categories, kind.value).map((g) => h('optgroup', { attrs: { label: g.group } },
        g.items.map((it) => h('option', { text: it.name, attrs: { value: it.id } }, [], doc)), doc)),
    );
    cat.value = keep;
    if (cat.value !== keep) cat.value = '';
  };
  fillCats();
  kind.addEventListener('change', fillCats);
  const shared = h('input', { attrs: { type: 'checkbox' } }, [], doc);
  shared.checked = true;
  const memo = h('textarea', { class: 'field memo', attrs: { 'aria-label': '메모(선택)', maxlength: '500', rows: '2' } }, [], doc);

  const save = h('button', { class: 'btn primary', text: '추가하기', attrs: { type: 'button' } }, [], doc);
  const form = h('section', { class: 'card add-form' }, [
    field('결제수단 (결제자 = 결제수단 주인)', src), field('종류', kind), field('날짜', date), field('시각(선택)', time),
    field('가맹점·내용', merchant), field('금액', amount), field('카테고리(선택)', cat),
    h('label', { class: 'filter-check' }, [shared, h('span', { text: '공동 지출(정산에 넣기)' }, [], doc)], doc),
    field('메모(선택)', memo), save,
  ], doc);
  const busy = (on) => {
    for (const el of form.querySelectorAll('button, select, input, textarea')) el.disabled = on;
  };

  save.addEventListener('click', async () => {
    const allowedCats = new Set(categoryOptions(categories, kind.value).flatMap((g) => g.items.map((it) => it.id)));
    const b = buildManualRow({
      sourceId: src.value, kind: kind.value, date: date.value, time: time.value, merchant: merchant.value,
      amountText: amount.value, categoryId: cat.value, isShared: shared.checked, memo: memo.value,
    }, { sourceIds: new Set(srcOpts.map((o) => o.id)), categoryIds: allowedCats, memberId: member.memberId, newId: () => entryKey, today: todaySeoul() });
    if (!b.ok) { say(b.message, true); return; }

    busy(true);
    const rs = await db.select('v_monthly_review_status', { columns: 'period_month,review_state', filters: [eq('period_month', monthOf(b.row.occurred_on))] });
    if (rs.error) { busy(false); say(`${rs.error.message} (오류 번호 ${onError?.(rs.error) ?? ''})`, true); return; }
    const warn = addConfirmText(b.row, rs.data?.[0]?.review_state);
    if (warn && !(await confirmDialog({ ...warn, confirmLabel: '추가하기', doc }))) { busy(false); return; }

    const sent = JSON.stringify([b.row, b.categoryId]);
    firstSent ??= sent;
    const ins = await db.insert('transactions', b.row);
    if (ins.error?.code === 'duplicate') {
      // 앞서 보낸 요청이 이미 들어감(응답만 끊김) → 그 거래로 간다 (transactions의 unique는 dedup_key뿐 — 스키마)
      const found = await db.select('transactions', { columns: 'id', filters: [eq('dedup_key', b.row.dedup_key)] });
      const prev = found.data?.[0]?.id;
      if (!prev) {
        busy(false);
        const code = onError?.(found.error ?? ins.error, { stage: STAGES.db_select });
        say(`추가하지 못했어요. 내역에서 같은 거래가 이미 있는지 확인해 주세요. (오류 번호 ${code ?? ins.error.code})`, true);
        return;
      }
      noteForTxn(prev, sent === firstSent
        ? '이미 추가된 거래예요. 내용을 확인해 주세요.'
        : '이전에 저장된 내용이 열렸어요. 고친 값은 반영되지 않았으니 다시 확인해 주세요.');
      go(buildHash('txn', { id: prev }));
      return;
    }
    if (ins.error || !ins.data?.[0]?.id) {
      busy(false);
      if (ins.error) say(`${ins.error.message} (오류 번호 ${onError?.(ins.error, { stage: STAGES.db_update }) ?? ''})`, true);
      else say('추가하지 못했어요. 새로고침해 주세요.', true);
      return;
    }
    const id = ins.data[0].id;
    if (b.categoryId) {
      const r = await db.rpc('set_transaction_lines', { p_txn_id: id, p_lines: [{ category_id: b.categoryId, amount: b.amount, item_note: null }] });
      if (r.error) { // 거래는 들어갔고 미분류로 남음 → 상세에서 고친다
        const code = onError?.(r.error, { stage: STAGES.db_rpc, txnId: id });
        noteForTxn(id, `거래는 추가했지만 카테고리는 넣지 못했어요. 여기서 다시 골라 주세요. (오류 번호 ${code ?? r.error.code})`);
      }
    }
    go(buildHash('txn', { id }));
  });

  return h('main', { class: 'screen' }, [head, status, form], doc);
}
