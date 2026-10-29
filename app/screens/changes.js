// =====================================================================
// 변경 기록 (화면 설계 v0.3 4-1 시안 24 목록, 4-2 시안 25 상세·되돌리기)
// 조회: v_change_batch_summary(최근 90일), members / 상세: v_change_batch_items, v_transaction_detail(그 거래들), categories
// 쓰기: revert_change_batch(id) — 미리보기가 확인 단계라 대화상자 없음. 이체 상대 적용은 정산 영향이 있어 확인 시트
// 의존: ui/dom.js, router.js, core/confirm.js, core/errors.js, screens/changes-model.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { buildHash } from '../router.js';
import { confirmDialog } from '../core/confirm.js';
import { STAGES, ACTIONS } from '../core/errors.js';
import { since90, batchRow, batchDetail, revertResultText } from './changes-model.js';
import { errorView } from './shell.js';

const LIST_LIMIT = 100;
const SUMMARY = 'id,kind,description,created_by,created_at,reverted_at,reverted_by,txn_count,line_count,is_reverted';
const ITEMS = 'change_batch_id,target_kind,history_id,txn_id,line_id,old_category_id,new_category_id,is_created_line,'
  + 'old_kind,new_kind,old_exclude_reason,new_exclude_reason,old_is_shared,new_is_shared,old_review_status,new_review_status,is_revertible,revert_action';

let changeNotice = null;

const header = (title, back, doc) => h('header', { class: 'screen-head' }, [
  h('nav', { class: 'month-nav' }, [
    h('a', { class: 'icon-btn', text: '‹', attrs: { href: back, 'aria-label': '뒤로' } }, [], doc),
    h('h1', { class: 'title', text: title }, [], doc),
  ], doc),
], doc);

/** 목록 */
export async function renderChanges({ db, isCurrent, onError }, doc = globalThis.document) {
  const [list, members] = await Promise.all([
    db.select('v_change_batch_summary', {
      columns: SUMMARY,
      filters: [{ col: 'created_at', op: 'gte', value: since90() }],
      order: [{ col: 'created_at', ascending: false }],
      range: { from: 0, to: LIST_LIMIT },
    }),
    db.select('members', { columns: 'id,member_slot,display_name' }),
  ]);
  if (!isCurrent()) return null;
  const head = header('변경 기록', buildHash('more'), doc);
  const error = list.error ?? members.error;
  if (error) {
    onError?.(error);
    return h('main', { class: 'screen' }, [head, errorView(error.message, error.detail?.sqlState ?? error.code, doc)], doc);
  }
  const rows = (list.data ?? []).slice(0, LIST_LIMIT).map((b) => batchRow(b, members.data ?? []));
  return h('main', { class: 'screen' }, [
    head,
    h('p', { class: 'muted', text: '여러 거래를 한 번에 바꾼 기록이에요. 누르면 무엇이 바뀌었는지 보고 되돌릴 수 있어요. (최근 90일)' }, [], doc),
    rows.length === 0 ? h('p', { class: 'card muted', text: '최근 90일에 한 번에 바꾼 기록이 없어요' }, [], doc)
      : h('section', { class: 'card' }, [h('ul', { class: 'todo-list' }, rows.map((r) => h('li', {}, [
        h('a', { class: `todo${r.reverted ? ' off' : ''}`, attrs: { href: buildHash('change', { id: r.id }) } }, [
          h('span', { class: 'todo-text' }, [
            h('span', { text: r.title }, [], doc),
            h('span', { class: 'sub', text: r.sub }, [], doc),
            r.revertedText ? h('span', { class: 'sub', text: r.revertedText }, [], doc) : null,
          ], doc),
          h('span', { class: 'chev', text: '›', attrs: { 'aria-hidden': 'true' } }, [], doc),
        ], doc),
      ], doc)), doc)], doc),
    (list.data ?? []).length > LIST_LIMIT ? h('p', { class: 'muted small', text: `최근 ${LIST_LIMIT}개만 보여요` }, [], doc) : null,
  ], doc);
}

/** 상세·되돌리기 */
export async function renderChange({ db, id, reload, isCurrent, onError }, doc = globalThis.document) {
  const [batchR, itemsR, catsR, membersR] = await Promise.all([
    db.select('v_change_batch_summary', { columns: SUMMARY, filters: [{ col: 'id', op: 'eq', value: id }] }),
    db.select('v_change_batch_items', { columns: ITEMS, filters: [{ col: 'change_batch_id', op: 'eq', value: id }] }),
    db.select('categories', { columns: 'id,parent_id,name' }),
    db.select('members', { columns: 'id,member_slot,display_name' }),
  ]);
  const head = header('변경 기록', buildHash('changes'), doc);
  let error = [batchR, itemsR, catsR, membersR].find((r) => r.error)?.error;
  const batch = batchR.data?.[0] ?? null;
  const items = itemsR.data ?? [];
  let txns = new Map();
  if (!error && items.length) {
    const ids = [...new Set(items.map((i) => i.txn_id))];
    const t = await db.select('v_transaction_detail', {
      columns: 'id,occurred_on,merchant_raw,amount,lines', filters: [{ col: 'id', op: 'in', value: ids }],
    });
    if (t.error) error = t.error;
    txns = new Map((t.data ?? []).map((r) => [r.id, r]));
  }
  if (!isCurrent()) return null;
  if (error) {
    onError?.(error);
    return h('main', { class: 'screen' }, [head, errorView(error.message, error.detail?.sqlState ?? error.code, doc)], doc);
  }
  if (!batch) return h('main', { class: 'screen' }, [head, h('p', { class: 'card muted', text: '변경 기록을 찾을 수 없어요' }, [], doc)], doc);

  const row = batchRow(batch, membersR.data ?? []);
  const d = batchDetail(batch, items, txns, new Map((catsR.data ?? []).map((c) => [c.id, c])));
  const status = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  if (changeNotice?.id === id) {
    status.textContent = changeNotice.text;
    status.className = `status-line${changeNotice.isError ? ' error' : ''}`;
    changeNotice = null;
  }

  const btn = d.canRevert ? h('button', { class: 'btn primary', text: d.buttonLabel, attrs: { type: 'button' } }, [], doc) : null;
  btn?.addEventListener('click', async () => {
    if (d.needsConfirm && !(await confirmDialog({ title: '되돌리기', message: `${d.preview}. ${d.notes[0]}`, confirmLabel: '되돌리기', doc }))) return;
    btn.disabled = true;
    const r = await db.rpc('revert_change_batch', { p_change_batch_id: id });
    if (r.error) {
      btn.disabled = false;
      const code = onError?.(r.error, { stage: STAGES.db_rpc, action: ACTIONS.revert, changeBatchId: id });
      const text = `${r.error.message}${code ? ` (오류 번호 ${code})` : ''}`;
      if (r.error.code === 'revert_invalid') { // LG006: 그사이 누가 되돌렸음 → 다시 읽어 지금 상태를 보인다(PR #19 리뷰 1)
        changeNotice = { id, text, isError: true };
        reload();
        return;
      }
      status.textContent = text;
      status.className = 'status-line error';
      return;
    }
    changeNotice = { id, text: revertResultText(r.data ?? []), isError: false };
    reload();
  });

  return h('main', { class: 'screen' }, [
    head, status,
    h('section', { class: 'card' }, [
      h('h2', { class: 'card-title', text: row.title }, [], doc),
      h('p', { class: 'muted', text: row.sub }, [], doc),
      row.revertedText ? h('p', { class: 'notice small', text: row.revertedText }, [], doc) : null,
      d.preview ? h('p', { class: 'label', text: d.preview }, [], doc) : null,
    ], doc),
    h('section', { class: 'card' }, [h('ul', { class: 'change-items' }, d.rows.map((r) => h('li', {}, [
      h('a', { class: 'change-txn', text: r.title, attrs: { href: buildHash('txn', { id: r.txnId }) } }, [], doc),
      h('span', { class: `tag${r.tag === '그대로' ? ' keep' : ''}`, text: r.tag }, [], doc),
      ...r.changes.map((c) => h('p', { class: 'sub', text: c }, [], doc)),
    ], doc)), doc)], doc),
    ...d.notes.map((n) => h('p', { class: 'muted small', text: n }, [], doc)),
    btn,
  ], doc);
}
