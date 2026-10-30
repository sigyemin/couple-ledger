// =====================================================================
// 거래 상세 › 연말정산 카드 (CL-062 ② E3)
// 조회: transactions(이 거래의 deduction_kind·beneficiary_member_id — v_transaction_detail은 v0.20 칸이 없음),
//       v_deduction_txn(이 거래의 자동 판정: 공제 항목·세액공제 항목·대상자)
// 쓰기: transactions update(deduction_kind: 자동 = null, beneficiary_member_id: 결제수단 주인 = null) — 정산 값이 아님
// - 대상자 칸은 의료비(세액공제 항목 medical) 거래만(D8)
// - 조회가 실패하면 이 카드만 오류 줄(상세는 그대로)
// 의존: ui/dom.js, core/errors.js, screens/deduction-edit-model.js
// =====================================================================
import { h } from '../ui/dom.js';
import { STAGES } from '../core/errors.js';
import { TXN_KINDS, autoView, deductionPatch, beneficiaryNote } from './deduction-edit-model.js';

const eq = (col, value) => ({ col, op: 'eq', value });

export async function loadTxnDeduction(db, id) {
  const [cur, parts] = await Promise.all([
    db.select('transactions', { columns: 'id,deduction_kind,beneficiary_member_id', filters: [eq('id', id)] }),
    db.select('v_deduction_txn', { columns: 'txn_id,deduction_kind,tax_credit_kind,beneficiary_member_id,signed_amount', filters: [eq('txn_id', id)] }),
  ]);
  const error = cur.error ?? parts.error;
  if (error) return { error };
  return { data: { cur: cur.data?.[0] ?? null, parts: parts.data ?? [] } };
}

/**
 * @param {{ db, row, members, member, reload(), onError, say(msg, isError) }} ctx  row = v_transaction_detail 행
 * @returns {Promise<HTMLElement>}
 */
export async function renderTxnDeduction({ db, row, members, member, reload, onError, say }, doc = globalThis.document) {
  const title = h('h2', { class: 'card-title', text: '연말정산' }, [], doc);
  const res = await loadTxnDeduction(db, row.id);
  if (res.error) {
    onError?.(res.error, { txnId: row.id });
    return h('section', { class: 'card' }, [title, h('p', { class: 'notice small', text: '연말정산 판정을 불러오지 못했어요.' }, [], doc)], doc);
  }
  const { cur, parts } = res.data;
  const auto = autoView(parts);
  const kind = h('select', { class: 'field', attrs: { 'aria-label': '공제 항목' } }, [
    h('option', { text: '자동(카테고리·결제수단 따라)', attrs: { value: '' } }, [], doc),
    ...TXN_KINDS.map(([k, label]) => h('option', { text: label, attrs: { value: k } }, [], doc)),
  ], doc);
  kind.value = cur?.deduction_kind ?? '';
  const sorted = [...(members ?? [])].sort((a, b) => a.member_slot - b.member_slot);
  const ben = auto.medical ? h('select', { class: 'field', attrs: { 'aria-label': '의료비 대상자' } }, [
    h('option', { text: `결제수단 주인(${row.payer_name ?? ''})`, attrs: { value: '' } }, [], doc),
    ...sorted.map((m) => h('option', { text: m.display_name, attrs: { value: m.id } }, [], doc)),
  ], doc) : null;
  if (ben) ben.value = cur?.beneficiary_member_id ?? '';
  const note = h('p', { class: 'notice small', attrs: { hidden: true } }, [], doc);
  const showNote = () => {
    const t = ben ? beneficiaryNote(ben.value || null, row.payer_member_id, members) : null;
    note.textContent = t ?? '';
    note.hidden = !t;
  };
  ben?.addEventListener('change', showNote);
  showNote();
  const save = h('button', { class: 'btn secondary', text: '연말정산 칸 저장', attrs: { type: 'button' } }, [], doc);
  save.addEventListener('click', async () => {
    const form = { kind: kind.value };
    if (ben) form.beneficiary = ben.value;
    const patch = deductionPatch(cur, form, member.memberId, (members ?? []).map((m) => m.id));
    if (!patch) { say('바뀐 내용이 없어요'); return; }
    save.disabled = true;
    const r = await db.update('transactions', row.id, patch);
    save.disabled = false;
    if (r.error || !r.data?.length) {
      const code = r.error ? onError?.(r.error, { txnId: row.id, stage: STAGES.db_update }) : null;
      say(r.error ? `${r.error.message}${code ? ` (오류 번호 ${code})` : ''}` : '저장하지 못했어요. 새로고침해 주세요.', true);
      return;
    }
    reload();
  });
  return h('section', { class: 'card form' }, [
    title,
    h('p', { class: 'muted small', text: `지금 판정: ${auto.text}${cur?.deduction_kind ? ' (직접 고친 값)' : ''}` }, [], doc),
    h('span', { class: 'field-label', text: '공제 항목' }, [], doc), kind,
    ben ? h('span', { class: 'field-label', text: '의료비 대상자(누구를 위한 지출)' }, [], doc) : null, ben,
    note,
    save,
    h('p', { class: 'muted small', text: '정산·월 확인과는 상관없어요. 가계부 기준 추정에만 쓰여요.' }, [], doc),
  ], doc);
}
