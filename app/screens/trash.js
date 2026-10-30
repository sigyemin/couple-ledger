// =====================================================================
// 휴지통 (화면 설계 v0.3 2-1 시안 20, 2-2 시안 21): 지운 거래 목록 · 고른 거래 되살리기
// 조회: v_transaction_detail(지운 것, 테스트 결제수단 제외, 최근 200건), members / 되살리기 전: v_monthly_review_status
// 쓰기: transactions update(deleted_at·deleted_by = null, updated_by = 나) 한 건씩 — 원거래 먼저, 환불 나중
// 비우기는 두지 않는다(v0.3 2-4: 지운 기록이 있어야 같은 파일을 다시 올려도 되살아나지 않음)
// 의존: ui/dom.js, router.js, core/confirm.js, core/errors.js, screens/trash-model.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { buildHash } from '../router.js';
import { confirmDialog } from '../core/confirm.js';
import { STAGES } from '../core/errors.js';
import {
  TRASH_LIMIT, trashGroups, restorePlan, restoreOrder, restoreConfirmText, restorePatch, restoreResultText,
} from './trash-model.js';
import { errorView } from './shell.js';

const COLUMNS = 'id,occurred_on,merchant_raw,amount,kind,origin,payer_member_id,payer_name,source_label,deleted_at,deleted_by,refund_of_txn_id,period_month';
// db 래퍼에는 "is not null"이 없어 아주 이른 시각보다 큰 값으로 거른다(= deleted_at이 있음)
const DELETED = { col: 'deleted_at', op: 'gt', value: '1970-01-01T00:00:00Z' };

let trashNotice = null;

export async function loadTrash(db) {
  const [rows, members] = await Promise.all([
    db.select('v_transaction_detail', {
      columns: COLUMNS,
      filters: [DELETED, { col: 'is_test_source', op: 'eq', value: false }],
      order: [{ col: 'deleted_at', ascending: false }, { col: 'id', ascending: true }],
      range: { from: 0, to: TRASH_LIMIT },
    }),
    db.select('members', { columns: 'id,member_slot,display_name' }),
  ]);
  const error = [rows, members].find((r) => r.error)?.error;
  if (error) return { error };
  const all = rows.data ?? [];
  return { data: { rows: all.slice(0, TRASH_LIMIT), more: all.length > TRASH_LIMIT, members: members.data ?? [] } };
}

/**
 * @param {{ db, member, reload(), isCurrent(), onError(err, extra) → string }} ctx
 */
export async function renderTrash({ db, member, reload, isCurrent, onError }, doc = globalThis.document) {
  const res = await loadTrash(db);
  if (!isCurrent()) return null;
  const head = h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav' }, [
      h('a', { class: 'icon-btn', text: '‹', attrs: { href: buildHash('more'), 'aria-label': '더보기로' } }, [], doc),
      h('h1', { class: 'title', text: '휴지통' }, [], doc),
    ], doc),
  ], doc);
  if (res.error) {
    onError?.(res.error);
    return h('main', { class: 'screen' }, [head, errorView(res.error.message, res.error.detail?.sqlState ?? res.error.code, doc)], doc);
  }
  const { rows, more, members } = res.data;
  const status = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  const say = (msg, isError = false) => {
    status.textContent = msg;
    status.className = `status-line${isError ? ' error' : ''}`;
  };
  if (trashNotice) { say(trashNotice.text, trashNotice.isError); trashNotice = null; }

  const intro = h('section', { class: 'card' }, [
    h('p', { class: 'label', text: `지운 거래 ${rows.length}${more ? '+' : ''}건 · 집계에서 빠져 있어요` }, [], doc),
    h('p', { class: 'muted small', text: '휴지통은 비우지 않아요. 같은 파일을 다시 올려도 지운 거래가 되살아나지 않도록 기록을 남겨 둬요.' }, [], doc),
  ], doc);

  const picked = new Set();
  const count = h('strong', { text: '0건 고름' }, [], doc);
  const apply = h('button', { class: 'btn primary', text: '되살리기', attrs: { type: 'button' } }, [], doc);
  apply.disabled = true;
  const refresh = () => {
    count.textContent = `${picked.size}건 고름`;
    apply.textContent = picked.size ? `${picked.size}건 되살리기` : '되살리기';
    apply.disabled = picked.size === 0;
  };

  const groups = trashGroups(rows, members);
  const list = groups.length === 0
    ? h('p', { class: 'card muted', text: '휴지통이 비어 있어요' }, [], doc)
    : h('div', { class: 'day-groups' }, groups.map((g) => h('section', { class: 'card day' }, [
      h('h2', { class: 'day-title', text: g.label }, [], doc),
      h('ul', { class: 'txn-list' }, g.items.map((it) => {
        const box = h('input', { attrs: { type: 'checkbox', 'aria-label': `${it.merchant} ${it.amount} 고르기` } }, [], doc);
        box.addEventListener('change', () => { if (box.checked) picked.add(it.id); else picked.delete(it.id); refresh(); });
        return h('li', { class: 'trash-row' }, [
          h('label', { class: 'txn pick tone-excluded' }, [
            box,
            h('span', { class: `payer payer-${it.payer.slot}`, text: it.payer.initial, attrs: { 'aria-label': `결제자 ${it.payer.name}` } }, [], doc),
            h('span', { class: 'txn-main' }, [
              h('span', { class: 'txn-merchant', text: it.merchant }, [], doc),
              h('span', { class: 'sub' }, [it.sub, ...it.tags.map((t) => h('span', { class: 'tag', text: t }, [], doc)),
                it.together ? h('span', { class: 'tag', text: it.together }, [], doc) : null], doc),
            ], doc),
            h('span', { class: 'txn-amount', text: it.amount }, [], doc),
          ], doc),
          h('a', { class: 'icon-btn', text: '›', attrs: { href: buildHash('txn', { id: it.id }), 'aria-label': `${it.merchant} 상세` } }, [], doc),
        ], doc);
      }), doc),
    ], doc)), doc);

  apply.addEventListener('click', async () => {
    apply.disabled = true; // 누르자마자 끈다 — 대화상자가 두 번 뜨지 않게(PR #19 리뷰 2). 그만두면 다시 켠다
    const stop = () => { apply.disabled = picked.size === 0; };
    const plan = restorePlan([...picked], rows);
    let include = [];
    if (plan.askOriginals.length) {
      const yes = await confirmDialog({
        title: '원거래도 함께',
        message: `고른 환불의 원거래(${plan.askOriginals.map((o) => o.text).join(', ')})도 휴지통에 있어요. 함께 되살릴까요? 아니면 그 환불은 건너뛰어요.`,
        confirmLabel: '함께 되살리기', cancelLabel: '환불은 건너뛰기', doc,
      });
      include = yes ? plan.askOriginals.map((o) => o.id) : [];
    }
    const { order, skipped } = restoreOrder(plan, rows, include);
    if (order.length === 0) { say(restoreResultText([], skipped.length), true); stop(); return; }
    const byId = new Map(rows.map((r) => [r.id, r]));
    const toRestore = order.map((id) => byId.get(id));
    const months = [...new Set(toRestore.map((r) => r.period_month))];
    const rs = await db.select('v_monthly_review_status', { columns: 'period_month,review_state', filters: [{ col: 'period_month', op: 'in', value: months }] });
    const states = new Map((rs.data ?? []).map((r) => [r.period_month, r.review_state]));
    const text = restoreConfirmText(toRestore, states, { statesUnknown: Boolean(rs.error) });
    if (!(await confirmDialog({ ...text, confirmLabel: '되살리기', doc }))) { stop(); return; }

    const patch = restorePatch(member.memberId);
    const results = [];
    for (const id of order) {
      const r = await db.update('transactions', id, patch);
      if (r.error) onError?.(r.error, { stage: STAGES.db_update, txnId: id });
      results.push({ id, ok: !r.error && (r.data?.length ?? 0) > 0, code: r.error?.code });
    }
    const failed = results.some((r) => !r.ok);
    trashNotice = { text: restoreResultText(results, skipped.length), isError: failed };
    reload();
  });

  const bar = h('section', { class: 'bulk-bar', attrs: { 'aria-label': '고른 거래 되살리기' } }, [count, apply], doc);
  return h('main', { class: 'screen selecting' }, [
    head, status, intro, list,
    more ? h('p', { class: 'muted small', text: `최근 ${TRASH_LIMIT}건만 보여요` }, [], doc) : null,
    groups.length ? bar : null,
  ], doc);
}
