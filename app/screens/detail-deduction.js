// =====================================================================
// 거래 상세 › 연말정산 카드 (CL-062 ② E3)
// 조회: 고친 값(deduction_kind·beneficiary_member_id)은 상세 행(v_transaction_detail, v0.22부터 칸이 있음 — CL-072 A2),
//       v_deduction_txn(이 거래의 자동 판정: 공제 항목·공제 표시·대상자)
// 쓰기: transactions update(deduction_kind: 자동 = null, beneficiary_member_id: 결제수단 주인 = null) — 정산 값이 아님
// - 대상자 칸은 의료비(세액공제 항목 medical) 거래만(D8)
// - 전세자금대출 표시(tax_credit_kind housing_rent_loan — 소득공제) 거래는 '공제 대상' 표시 + 다른 대출이면 카테고리 표시를 비우라는 안내(CL-065 H3)
// - 조회가 실패하면 이 카드만 오류 줄(상세는 그대로)
// 의존: ui/dom.js, core/errors.js, screens/deduction-edit-model.js
// =====================================================================
import { h } from '../ui/dom.js';
import { STAGES } from '../core/errors.js';
import { TXN_KINDS, autoView, deductionPatch, beneficiaryNote, HOUSING_TXN_TEXT, HOUSING_TXN_OTHER } from './deduction-edit-model.js';

const eq = (col, value) => ({ col, op: 'eq', value });

/** 이 거래의 자동 판정 조각(v_deduction_txn). 고친 값(deduction_kind·beneficiary_member_id)은 v0.22부터 상세 행(v_transaction_detail)에 있다 */
export async function loadTxnDeduction(db, row) {
  const parts = await db.select('v_deduction_txn', { columns: 'txn_id,deduction_kind,tax_credit_kind,beneficiary_member_id,signed_amount', filters: [eq('txn_id', row.id)] });
  if (parts.error) return { error: parts.error };
  return { data: { cur: { id: row.id, deduction_kind: row.deduction_kind ?? null, beneficiary_member_id: row.beneficiary_member_id ?? null }, parts: parts.data ?? [] } };
}

/**
 * @param {{ db, row, members, member, reload(), onError, say(msg, isError) }} ctx  row = v_transaction_detail 행
 * @returns {Promise<HTMLElement>}
 */
export async function renderTxnDeduction({ db, row, members, member, reload, onError, say }, doc = globalThis.document) {
  const title = h('h2', { class: 'card-title', text: '연말정산' }, [], doc);
  const res = await loadTxnDeduction(db, row);
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
    // 전세자금대출 거래는 '공제 대상 아님'(카드 공제)과 '공제 대상'(전세자금대출)이 함께 보여 헷갈리지 않게 어느 공제인지 밝힌다
    h('p', { class: 'muted small', text: `지금 판정${auto.housingLoan ? '(카드 공제)' : ''}: ${auto.text}${cur?.deduction_kind ? ' (직접 고친 값)' : ''}` }, [], doc),
    auto.housingLoan ? h('p', { class: 'ded-loan-tag', text: HOUSING_TXN_TEXT }, [], doc) : null,
    auto.housingLoan ? h('p', { class: 'muted small', text: HOUSING_TXN_OTHER }, [], doc) : null,
    h('span', { class: 'field-label', text: '공제 항목' }, [], doc), kind,
    ben ? h('span', { class: 'field-label', text: '의료비 대상자(누구를 위한 지출)' }, [], doc) : null, ben,
    note,
    save,
    h('p', { class: 'muted small', text: '정산·월 확인과는 상관없어요. 가계부 기준 추정에만 쓰여요.' }, [], doc),
  ], doc);
}
