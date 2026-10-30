// =====================================================================
// 환불 원거래 찾기 (화면 설계 v0.1 4-6, 시안 8) + 연결 공통 동작(월 검토·거래 상세가 같이 쓴다)
// #/refund/<환불 id>[?widen=1] : find_refund_candidates(id, widen) → 후보 고르기 → 확인 → link_refund → review_status confirmed
//   - 체크카드 취소면 제안 원거래에 "제안" 꼬리표(설계 CL-034 조건 1~3. 한 화면이라 같은 달 다른 환불과의 겹침(조건 4)은 월 검토에서만 본다)
//   - 원거래 없음 = review_status confirmed (환불일 달에 둔다)
//   - 원거래 달이 확인 완료면 '확인 후 변경됨' 안내
// 의존: ui/dom.js, router.js, core/confirm.js, core/errors.js, screens/refund-model.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { buildHash } from '../router.js';
import { won, day } from '../core/format.js';
import { confirmDialog } from '../core/confirm.js';
import { STAGES } from '../core/errors.js';
import {
  SUGGEST_CALL_LIMIT, isSuggestTarget, suggestFrom, monthSuggestions, candidateView, linkConfirmText, reviewedNote, confirmPatch,
} from './refund-model.js';
import { errorView } from './shell.js';

export const REFUND_COLUMNS = [
  'id', 'occurred_on', 'merchant_raw', 'amount', 'kind', 'card_kind', 'refund_of_txn_id', 'review_status', 'deleted_at',
  'period_month', 'source_label', 'payer_member_id', 'payer_name', 'is_test_source',
].join(',');

/** 후보 읽기(재시도 가능한 읽기 RPC) */
export function readCandidates(db, refundId, { widen = false, limit = 50 } = {}) {
  return db.rpc('find_refund_candidates', { p_refund_id: refundId, p_widen: widen, p_limit: limit }, { retry: true });
}

/**
 * 그 달 체크카드 취소 연결 제안 수(월 검토와 같은 조건 1~4). 홈 할 일·올리기 결과용 (CL-042)
 * 호출 최소화: 먼저 미연결 체크카드 취소만 한 번 읽고, 있을 때만 그 수만큼 후보 RPC
 * @returns {{ data: { count, refunds } } | { error }}
 */
export async function suggestionCount(db, monthStart) {
  const eq = (col, value) => ({ col, op: 'eq', value });
  const r = await db.select('v_transaction_detail', {
    columns: 'id,kind,card_kind,refund_of_txn_id,review_status,deleted_at,is_test_source',
    filters: [eq('period_month', monthStart), eq('kind', 'refund'), eq('card_kind', 'check_card'), eq('review_status', 'needs_review'),
      { col: 'refund_of_txn_id', op: 'is', value: null }, { col: 'deleted_at', op: 'is', value: null }, eq('is_test_source', false)],
    range: { from: 0, to: SUGGEST_CALL_LIMIT - 1 },
  });
  if (r.error) return { error: r.error };
  const targets = (r.data ?? []).filter(isSuggestTarget);
  if (!targets.length) return { data: { count: 0, refunds: 0 } };
  const cands = await Promise.all(targets.map((t) => readCandidates(db, t.id)));
  const failed = cands.find((c) => c.error);
  if (failed) return { error: failed.error };
  const s = monthSuggestions(new Map(targets.map((t, i) => [t.id, cands[i].data ?? []])));
  return { data: { count: [...s.values()].filter((v) => v.suggest).length, refunds: targets.length } };
}

/** 확인 상태(모든 달) → Map(달 → review_state). 실패해도 연결은 막지 않는다(안내만 빠짐) */
export async function readReviewStates(db) {
  const r = await db.select('v_monthly_review_status', { columns: 'period_month,review_state' });
  return new Map((r.data ?? []).map((x) => [x.period_month, x.review_state]));
}

/**
 * 연결 한 건: link_refund → 확인함. 두 번째가 실패하면 연결은 된 채 검토 대기로 남는다(해 없음 — 설계 4장)
 * onlyIfUnlinked(제안 연결·일괄 연결): 직전에 그 환불을 다시 읽어 아직 연결 없고 휴지통도 아닐 때만 연결한다.
 *   link_refund는 이미 연결된 환불도 덮어쓰므로(스키마) 그사이 다른 사람이 연결했으면 건너뛴다(PR #31 리뷰)
 * @returns {{ ok: boolean, linked: boolean, skipped?: boolean, error?: AppError }}
 */
export async function linkOne(db, memberId, refundId, originalId, { onlyIfUnlinked = false } = {}) {
  if (onlyIfUnlinked) {
    const now = await db.select('v_transaction_detail', { columns: 'id,refund_of_txn_id,deleted_at', filters: [{ col: 'id', op: 'eq', value: refundId }] });
    if (now.error) return { ok: false, linked: false, error: now.error };
    const r = now.data?.[0];
    if (!r || r.refund_of_txn_id || r.deleted_at) return { ok: false, linked: false, skipped: true };
  }
  const l = await db.rpc('link_refund', { p_refund_id: refundId, p_original_id: originalId });
  if (l.error) return { ok: false, linked: false, error: l.error };
  const u = await db.update('transactions', refundId, confirmPatch(memberId));
  if (u.error || !u.data?.length) return { ok: false, linked: true, error: u.error ?? null };
  return { ok: true, linked: true };
}

/**
 * @param {{ db, member, id, query(Map), go(hash), isCurrent(), onError }} ctx
 */
export async function renderRefundFind({ db, member, id, query, go, isCurrent, onError }, doc = globalThis.document) {
  const widen = query?.get('widen') === '1';
  const back = buildHash('txn', { id });
  const head = h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav' }, [
      h('a', { class: 'icon-btn', text: '‹', attrs: { href: back, 'aria-label': '거래 상세로' } }, [], doc),
      h('h1', { class: 'title', text: '원거래 찾기' }, [], doc),
    ], doc),
  ], doc);
  const [refundRes, candRes, states] = await Promise.all([
    db.select('v_transaction_detail', { columns: REFUND_COLUMNS, filters: [{ col: 'id', op: 'eq', value: id }] }),
    readCandidates(db, id, { widen }),
    readReviewStates(db),
  ]);
  if (!isCurrent()) return null;
  const err = refundRes.error ?? candRes.error;
  if (err) {
    onError?.(err, { txnId: id });
    return h('main', { class: 'screen' }, [head, errorView(err.message, err.detail?.sqlState ?? err.code, doc)], doc);
  }
  const refund = (refundRes.data ?? [])[0];
  if (!refund || refund.kind !== 'refund') {
    return h('main', { class: 'screen' }, [head, h('p', { class: 'card muted', text: '환불 거래를 찾지 못했어요' }, [], doc)], doc);
  }
  // 휴지통 환불: 연결(DB가 거부)·원거래 없음(DB가 막지 않음) 모두 두지 않는다(PR #31 리뷰)
  if (refund.deleted_at) {
    return h('main', { class: 'screen' }, [head, h('p', { class: 'card notice', text: '휴지통에 있는 거래예요. 되살린 뒤 원거래를 찾아 주세요.' }, [], doc)], doc);
  }
  const cands = candRes.data ?? [];
  const suggested = !widen && isSuggestTarget(refund) ? suggestFrom(cands).suggest : null;
  const status = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  const say = (msg, isError = false) => { status.textContent = msg; status.className = `status-line${isError ? ' error' : ''}`; };
  const fail = (e) => { const code = onError?.(e, { stage: STAGES.db_rpc, txnId: id }); say(`${e.message}${code ? ` (오류 번호 ${code})` : ''}`, true); };

  const top = h('section', { class: 'card' }, [
    h('p', { class: 'muted small', text: `환불 · ${refund.source_label} · ${day(refund.occurred_on)}` }, [], doc),
    h('p', { class: 'rule-title', text: refund.merchant_raw }, [], doc),
    h('p', { class: 'amount-l tone-refund', text: won(-Number(refund.amount)) }, [], doc),
    h('p', { class: 'muted small', text: refund.refund_of_txn_id ? '지금 연결된 원거래를 바꿀 수 있어요.' : '어떤 결제를 돌려받은 건가요? 연결하면 원래 결제한 달에 반영돼요.' }, [], doc),
  ], doc);

  const note = h('p', { class: 'notice small' }, [], doc);
  const linkBtn = h('button', { class: 'btn primary', text: '결제를 골라 주세요', attrs: { type: 'button' } }, [], doc);
  linkBtn.disabled = true;
  let picked = null;
  const views = cands.map((c) => ({ c, v: candidateView(c, suggested?.txn_id) }));
  const choose = (c) => {
    picked = c;
    note.textContent = reviewedNote([candidateView(c).month], states) ?? '';
    linkBtn.textContent = `${day(c.occurred_on).replace(/ \(.\)$/, '')} 결제와 연결`;
    linkBtn.disabled = false;
  };
  const list = h('ul', { class: 'cand-list', attrs: { role: 'radiogroup', 'aria-label': '원거래 후보' } }, views.map(({ c, v }) => {
    const radio = h('input', { attrs: { type: 'radio', name: 'cand', value: c.txn_id, 'aria-label': `${v.merchant} ${v.amountText} ${v.sub}` } }, [], doc);
    radio.addEventListener('change', () => choose(c));
    return h('li', {}, [h('label', { class: `cand${v.tags.includes('제안') ? ' suggested' : ''}` }, [
      radio,
      h('span', { class: 'txn-main' }, [
        h('span', { class: 'txn-merchant' }, [v.merchant, ...v.tags.map((t) => h('span', { class: t === '제안' ? 'tag blue' : 'tag', text: t }, [], doc))], doc),
        h('span', { class: 'sub', text: v.sub }, [], doc),
      ], doc),
      h('span', { class: 'txn-amount', text: v.amountText }, [], doc),
    ], doc)], doc);
  }), doc);
  if (suggested) {
    const r = list.querySelector(`input[value="${suggested.txn_id}"]`);
    if (r) { r.checked = true; choose(suggested); }
  }

  const lock = (on) => { for (const b of main.querySelectorAll('button, input')) b.disabled = on; if (!on && !picked) linkBtn.disabled = true; };
  linkBtn.addEventListener('click', async () => {
    if (!picked) return;
    if (!(await confirmDialog({ ...linkConfirmText(refund, picked, states), confirmLabel: '연결', doc }))) return;
    lock(true);
    const r = await linkOne(db, member.memberId, id, picked.txn_id);
    lock(false);
    if (!r.ok && !r.linked) { fail(r.error); return; }
    if (!r.ok) { say('연결했지만 확인함으로는 바꾸지 못했어요. 거래 상세에서 "확인했어요"를 눌러 주세요.', true); return; }
    go(back);
  });
  const none = h('button', { class: 'btn secondary', text: '원거래 없음', attrs: { type: 'button' } }, [], doc);
  none.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: '원거래 없음', message: '원거래 없이 확인함으로 바꿔요. 환불은 환불한 달에 그대로 둬요.', confirmLabel: '확인함으로', doc }))) return;
    lock(true);
    const u = await db.update('transactions', id, confirmPatch(member.memberId));
    lock(false);
    if (u.error) { fail(u.error); return; }
    if (!u.data?.length) { say('바꾸지 못했어요. 새로고침해 주세요.', true); return; }
    go(back);
  });
  const widenLink = widen ? null : h('a', { class: 'btn secondary', text: '조건 넓히기(1년·가맹점 무관)', attrs: { href: buildHash('refund', { id, query: { widen: '1' } }) } }, [], doc);

  const main = h('main', { class: 'screen' }, [
    head, status, top,
    h('section', { class: 'card' }, [
      h('div', { class: 'card-head' }, [h('h2', { class: 'card-title', text: `후보 ${cands.length}건` }, [], doc)], doc),
      h('p', { class: 'muted small', text: widen ? '같은 결제수단 · 환불일 전 1년 · 환불액 이상' : '같은 결제수단 · 환불일 전 90일 · 환불액 이상 · 가맹점이 비슷한 순' }, [], doc),
      cands.length ? list : h('p', { class: 'muted', text: '후보가 없어요' }, [], doc),
      note,
    ], doc),
    widenLink, none, linkBtn,
  ], doc);
  return main;
}
