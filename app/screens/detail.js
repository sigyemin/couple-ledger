// =====================================================================
// 화면 6 거래 상세 (화면 설계 v0.1 4-4, 시안 6·19): 조회, 분류 바꾸기, 메모, 휴지통으로
// 조회: v_transaction_detail(이 거래, 원거래, 연결된 환불), members, categories
// 쓰기: bulk_set_category([id], …) · set_transaction_lines(나누기·원거래 카테고리로 되돌리기)
//       transactions update(memo · review_status · is_shared · is_excluded/exclude_reason · deleted_at/deleted_by, 항상 updated_by = 나)
// - 쓰기는 재시도하지 않는다. 끝나면 다시 읽어 그린다(reload). 0행이 바뀌면 실패로 본다
// - 정산에 영향 주는 변경(공동/개인·집계 제외)은 확인 대화상자를 거친다(확인 완료 달이면 '확인 후 변경됨' 안내)
// - 원거래 찾기는 다음 단계(사용자 결정 대기)
// 의존: ui/dom.js, router.js, core/confirm.js, core/validate.js, core/errors.js, screens/detail-model.js, screens/list-model.js, screens/shell.js
// =====================================================================
import { h, replaceChildren } from '../ui/dom.js';
import { buildHash } from '../router.js';
import { confirmDialog } from '../core/confirm.js';
import { text as checkText, amount as checkAmount } from '../core/validate.js';
import { STAGES, ACTIONS } from '../core/errors.js';
import { categoryIndex } from './list-model.js';
import {
  buildDetailModel, categoryOptions, categoryChangeText, changeDescription, trashPlan, trashPatch,
  editability, settlementChangeText, sharePatch, excludePatch, confirmPatch, linesDraft, validateLines, MAX_LINES,
} from './detail-model.js';
import { errorView } from './shell.js';

export const DETAIL_COLUMNS = [
  'id', 'source_id', 'origin', 'occurred_on', 'occurred_time', 'merchant_raw', 'amount', 'period_month',
  'installment_months', 'kind', 'is_shared', 'share_ratio', 'is_excluded', 'exclude_reason', 'review_status', 'memo',
  'refund_of_txn_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'deleted_at', 'source_label',
  'payer_member_id', 'payer_name', 'lines', 'other_share_amount', 'month_reviewed_at', 'is_changed_after_review',
  'is_uncategorized', 'inherited_category_id',
].join(',');
const MINI = 'id,occurred_on,merchant_raw,amount';

const eq = (col, value) => ({ col, op: 'eq', value });

// 다시 읽은 뒤에도 보여 줄 오류 안내(거래 id → 문구). 한 번 보여 주면 지운다
const carryNotice = new Map();

/** 다른 화면에서 이 거래 상세로 넘어갈 때 보여 줄 오류 안내를 남긴다(직접 추가 뒤 분류 실패 등) */
export function noteForTxn(id, message) {
  carryNotice.set(id, message);
}

export async function loadDetail(db, id) {
  const [txn, members, categories, refunds] = await Promise.all([
    db.select('v_transaction_detail', { columns: DETAIL_COLUMNS, filters: [eq('id', id)] }),
    db.select('members', { columns: 'id,member_slot,display_name' }),
    db.select('categories', { columns: 'id,parent_id,name,code,sort_order,is_active' }),
    db.select('v_transaction_detail', {
      columns: MINI,
      filters: [eq('refund_of_txn_id', id), { col: 'deleted_at', op: 'is', value: null }],
      order: [{ col: 'occurred_on', ascending: true }],
    }),
  ]);
  const error = [txn, members, categories, refunds].find((r) => r.error)?.error;
  if (error) return { error };
  const row = txn.data?.[0] ?? null;
  let original = null;
  if (row?.refund_of_txn_id) {
    const o = await db.select('v_transaction_detail', { columns: MINI, filters: [eq('id', row.refund_of_txn_id)] });
    if (o.error) return { error: o.error };
    original = o.data?.[0] ?? null;
  }
  return { data: { row, members: members.data ?? [], categories: categories.data ?? [], refunds: refunds.data ?? [], original } };
}

const rows = (pairs, doc) => h('dl', { class: 'kv' }, pairs.flatMap(([k, v]) => [
  h('dt', { text: k }, [], doc), h('dd', { text: v }, [], doc),
]), doc);

/**
 * @param {{ db, member, id, go(hash), reload(), isCurrent(), onError(err, extra) → string }} ctx
 *   onError는 오류를 기록하고 화면에 보일 오류 번호를 돌려준다
 */
export async function renderDetail({ db, member, id, go, reload, isCurrent, onError }, doc = globalThis.document) {
  const res = await loadDetail(db, id);
  if (!isCurrent()) return null;
  const back = h('a', { class: 'icon-btn', text: '‹', attrs: { href: buildHash('list'), 'aria-label': '내역으로' } }, [], doc);
  const headOf = (title) => h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav' }, [back, h('h1', { class: 'title', text: title }, [], doc)], doc),
  ], doc);
  if (res.error) {
    onError?.(res.error, { txnId: id });
    return h('main', { class: 'screen' }, [headOf('거래 상세'), errorView(res.error.message, res.error.detail?.sqlState ?? res.error.code, doc)], doc);
  }
  const { row, members, categories, refunds, original } = res.data;
  if (!row) {
    return h('main', { class: 'screen' }, [headOf('거래 상세'), h('p', { class: 'card muted', text: '거래를 찾을 수 없어요' }, [], doc)], doc);
  }
  back.setAttribute('href', buildHash('list', { query: { month: row.period_month.slice(0, 7) } }));
  const cats = categoryIndex(categories);
  const m = buildDetailModel(row, { cats, members, original, refunds });

  const status = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  const say = (msg, isError = false) => {
    status.textContent = msg;
    status.className = `status-line${isError ? ' error' : ''}`;
  };
  if (carryNotice.has(row.id)) {
    say(carryNotice.get(row.id), true);
    carryNotice.delete(row.id);
  }
  const fail = (err, extra) => {
    const code = onError?.(err, { txnId: row.id, ...extra });
    say(`${err.message}${code ? ` (오류 번호 ${code})` : ''}`, true);
  };
  const busy = (on) => {
    for (const el of main.querySelectorAll('button, select, textarea, input')) el.disabled = on;
  };
  /** 이 거래 한 행 update → 성공하면 다시 읽기 */
  const updateRow = async (patch) => {
    busy(true);
    const r = await db.update('transactions', row.id, patch);
    busy(false);
    if (r.error) { fail(r.error, { stage: STAGES.db_update }); return; }
    if (!r.data?.length) { say('저장하지 못했어요. 새로고침해 주세요.', true); return; }
    reload();
  };
  const ed = editability(row, refunds);
  const button = (text, cls, onClick) => h('button', { class: `btn ${cls}`, text, attrs: { type: 'button' }, on: { click: onClick } }, [], doc);

  // 머리: 가맹점 · 금액 · 상태
  const hero = h('section', { class: 'card hero' }, [
    h('p', { class: 'label', text: `${m.title} · ${m.kindLabel}` }, [], doc),
    h('p', { class: `amount-xl tone-${m.tone}`, text: m.amount }, [], doc),
    h('p', { class: 'muted', text: m.status }, [], doc),
  ], doc);

  const info = h('section', { class: 'card' }, [h('h2', { class: 'card-title', text: '기본 정보' }, [], doc), rows(m.info, doc)], doc);

  // 원거래·연결된 환불
  const links = [];
  if (m.original) {
    links.push(h('a', { class: 'row-link soft', attrs: { href: buildHash('txn', { id: m.original.id }) } }, [
      h('span', { text: `원거래 · ${m.original.text}` }, [], doc), h('strong', { text: `${m.original.amount} ›` }, [], doc),
    ], doc));
  }
  for (const r of m.refunds) {
    links.push(h('a', { class: 'row-link soft', attrs: { href: buildHash('txn', { id: r.id }) } }, [
      h('span', { text: `연결된 ${r.text}` }, [], doc), h('strong', { text: `${r.amount} ›` }, [], doc),
    ], doc));
  }
  const linkCard = links.length ? h('section', { class: 'card' }, [h('h2', { class: 'card-title', text: '연결' }, [], doc), ...links], doc) : null;

  // 분류
  const c = m.classification;
  const classCard = h('section', { class: 'card' }, [
    h('h2', { class: 'card-title', text: '분류' }, [], doc),
    c.lines.length === 0 && !c.note ? h('p', { class: 'muted', text: '미분류' }, [], doc) : null,
    c.lines.length ? h('ul', { class: 'line-list' }, c.lines.map((l) => h('li', { class: 'line' }, [
      h('span', { text: l.name }, [], doc),
      c.tag ? h('span', { class: 'tag', text: c.tag }, [], doc) : (l.source ? h('span', { class: 'tag', text: l.source }, [], doc) : null),
      h('span', { class: 'line-amount', text: l.amount }, [], doc),
    ], doc)), doc) : null,
    c.note ? h('p', { class: 'muted small', text: c.note }, [], doc) : null,
  ], doc);
  if (m.canChangeCategory) {
    const options = categoryOptions(categories, row.kind);
    const pick = h('select', { class: 'field', attrs: { 'aria-label': '카테고리 고르기' } }, [
      h('option', { text: '카테고리 바꾸기…', attrs: { value: '' } }, [], doc),
      ...options.map((g) => h('optgroup', { attrs: { label: g.group } }, g.items.map((it) => h('option', { text: it.name, attrs: { value: it.id } }, [], doc)), doc)),
    ], doc);
    pick.addEventListener('change', async () => {
      const catId = pick.value;
      if (!catId) return;
      const name = cats.get(catId)?.name ?? '';
      const t = categoryChangeText(row, name);
      const yes = await confirmDialog({ ...t, confirmLabel: '바꾸기', doc });
      if (!yes) { pick.value = ''; return; }
      busy(true);
      const r = await db.rpc('bulk_set_category', { p_txn_ids: [row.id], p_category_id: catId, p_description: changeDescription(row, name) });
      busy(false);
      if (r.error) { pick.value = ''; fail(r.error, { stage: STAGES.db_rpc, action: ACTIONS.bulk_edit }); return; }
      reload();
    });
    classCard.append(h('label', { class: 'filter-field' }, [pick], doc));
  }
  if (ed.canSplit) classCard.append(splitEditor());
  if (ed.canRevertToOriginal) {
    classCard.append(button('원거래 카테고리로 되돌리기', 'secondary', async () => {
      const yes = await confirmDialog({
        title: '원거래 카테고리로', message: '이 환불의 분류를 지우고 원거래 카테고리를 따르게 해요.', confirmLabel: '되돌리기', doc,
      });
      if (!yes) return;
      busy(true);
      const r = await db.rpc('set_transaction_lines', { p_txn_id: row.id, p_lines: [] });
      busy(false);
      if (r.error) { fail(r.error, { stage: STAGES.db_rpc }); return; }
      reload();
    }));
  }

  /** 금액 나누기(set_transaction_lines — 한 번에 전부 바뀌거나 전부 안 바뀜) */
  function splitEditor() {
    const options = categoryOptions(categories, row.kind);
    const allowed = new Set(options.flatMap((g) => g.items.map((it) => it.id)));
    const draft = linesDraft(row);
    const box = h('div', { class: 'split', attrs: { hidden: true } }, [], doc);
    const sumLine = h('p', { class: 'muted small split-sum', attrs: { 'aria-live': 'polite' } }, [], doc);
    const check = () => validateLines(draft, row.amount, allowed, { amount: checkAmount, text: checkText });
    const showSum = () => {
      const v = check();
      sumLine.textContent = v.ok ? v.sumText : `${v.sumText} · ${v.message}`;
    };
    const lineRow = (d, i) => {
      const sel = h('select', { class: 'field', attrs: { 'aria-label': `${i + 1}번째 줄 카테고리` } }, [
        h('option', { text: '카테고리', attrs: { value: '' } }, [], doc),
        ...options.map((g) => h('optgroup', { attrs: { label: g.group } }, g.items.map((it) => {
          const o = h('option', { text: it.name, attrs: { value: it.id } }, [], doc);
          if (it.id === d.categoryId) o.selected = true;
          return o;
        }), doc)),
      ], doc);
      sel.addEventListener('change', () => { d.categoryId = sel.value; showSum(); });
      const amt = h('input', { class: 'field', attrs: { inputmode: 'numeric', 'aria-label': `${i + 1}번째 줄 금액`, maxlength: '20' } }, [], doc);
      amt.value = d.amountText;
      amt.addEventListener('input', () => { d.amountText = amt.value; showSum(); });
      const note = h('input', { class: 'field', attrs: { 'aria-label': `${i + 1}번째 줄 품목`, placeholder: '품목(선택)', maxlength: '100' } }, [], doc);
      note.value = d.note;
      note.addEventListener('input', () => { d.note = note.value; });
      const del = draft.length > 1
        ? button('빼기', 'secondary small-btn', () => { draft.splice(i, 1); draw(); })
        : null;
      return h('div', { class: 'split-row' }, [sel, amt, note, del], doc);
    };
    const draw = () => {
      const add = draft.length < MAX_LINES
        ? button('줄 더하기', 'secondary small-btn', () => { draft.push({ categoryId: '', amountText: '', note: '' }); draw(); })
        : null;
      const save = button('나눈 대로 저장', 'primary', async () => {
        const v = check();
        if (!v.ok) { say(v.message, true); return; }
        busy(true);
        const r = await db.rpc('set_transaction_lines', { p_txn_id: row.id, p_lines: v.lines });
        busy(false);
        if (r.error) { fail(r.error, { stage: STAGES.db_rpc }); return; }
        reload();
      });
      replaceChildren(box, ...draft.map(lineRow), add, sumLine, save);
      showSum();
    };
    draw();
    const toggle = button('금액 나누기', 'secondary', () => {
      box.hidden = !box.hidden;
      toggle.setAttribute('aria-expanded', String(!box.hidden));
    });
    toggle.setAttribute('aria-expanded', 'false');
    return h('div', { class: 'split-wrap' }, [toggle, box], doc);
  }

  const settleCard = h('section', { class: 'card' }, [h('h2', { class: 'card-title', text: '정산' }, [], doc), rows(m.settle, doc)], doc);
  const settleChange = async (change, patch) => {
    const t = settlementChangeText(row, change, refunds);
    if (!(await confirmDialog({ ...t, confirmLabel: '바꾸기', doc }))) return;
    await updateRow(patch);
  };
  if (ed.canShare) {
    const to = !row.is_shared;
    settleCard.append(button(to ? '공동 지출로 바꾸기' : '개인 지출로 바꾸기', 'secondary',
      () => settleChange({ type: 'share', to }, sharePatch(to, member.memberId))));
  }
  if (ed.canExclude) {
    const to = !row.is_excluded;
    if (ed.excludeBlocked) settleCard.append(h('p', { class: 'muted small', text: ed.excludeBlocked }, [], doc));
    else {
      settleCard.append(button(to ? '집계에서 빼기' : '집계에 다시 넣기', 'secondary',
        () => settleChange({ type: 'exclude', to }, excludePatch(to, member.memberId))));
    }
  }

  // 메모
  const memo = h('textarea', { class: 'field memo', attrs: { 'aria-label': '메모', maxlength: '500', rows: '3', placeholder: '메모 (500자 이하)' } }, [], doc);
  memo.value = m.memo;
  const memoSave = h('button', { class: 'btn secondary', text: '메모 저장', attrs: { type: 'button' } }, [], doc);
  memoSave.addEventListener('click', async () => {
    const v = checkText(memo.value, 'memo');
    if (!v.ok) { say(v.message, true); return; }
    if (v.value === (row.memo ?? '')) { say('바뀐 내용이 없어요'); return; }
    await updateRow({ memo: v.value || null, updated_by: member.memberId });
  });
  const memoCard = h('section', { class: 'card' }, [h('h2', { class: 'card-title', text: '메모' }, [], doc), memo, memoSave], doc);

  const historyCard = h('section', { class: 'card' }, [h('h2', { class: 'card-title', text: '기록' }, [], doc), rows(m.history, doc)], doc);

  // 휴지통으로 (환불 먼저)
  const trash = h('button', { class: 'btn danger-text', text: '휴지통으로', attrs: { type: 'button' } }, [], doc);
  trash.addEventListener('click', async () => {
    const plan = trashPlan(row, refunds);
    const yes = await confirmDialog({ title: plan.title, message: plan.message, undoNote: plan.undoNote, confirmLabel: '휴지통으로', danger: true, doc });
    if (!yes) return;
    busy(true);
    const patch = trashPatch(member.memberId);
    let done = 0;
    for (const tid of plan.ids) {
      const r = await db.update('transactions', tid, patch);
      if (r.error || !r.data?.length) {
        busy(false);
        if (r.error) fail(r.error, { stage: STAGES.db_update, txnId: tid });
        else say('휴지통으로 옮기지 못했어요.', true);
        if (done > 0) say(`${status.textContent} (연결된 환불 ${done}건은 이미 휴지통으로 갔어요)`, true);
        // 화면을 실제 상태로 다시 읽는다(이미 옮긴 환불은 연결 목록에서 빠짐). 안내는 다시 그린 화면에 남긴다
        carryNotice.set(row.id, status.textContent);
        reload();
        return;
      }
      done += 1;
    }
    go(buildHash('list', { query: { month: row.period_month.slice(0, 7) } }));
  });

  const confirmBtn = ed.canConfirm
    ? button('확인했어요', 'primary', () => updateRow(confirmPatch(member.memberId)))
    : null;

  const main = h('main', { class: 'screen' }, [
    headOf('거래 상세'), hero, status, info, linkCard, classCard, settleCard, memoCard, historyCard, confirmBtn,
    m.deleted
      ? h('a', { class: 'row-link soft', attrs: { href: buildHash('trash') } }, [
        h('span', { text: '휴지통에 있는 거래예요' }, [], doc), h('strong', { text: '휴지통에서 되살리기 ›' }, [], doc),
      ], doc)
      : trash,
  ], doc);
  return main;
}
