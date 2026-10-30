// 거래 상세·카테고리의 연말정산 칸 (CL-062 ② E3·E4) — 합성 값만
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TXN_KINDS, CATEGORY_KINDS, TAX_CREDIT_KINDS, kindLabel, canEditDeduction, autoView, deductionPatch, beneficiaryNote,
  categoryDeductionPatch, categoryDeductionTag,
} from '../../app/screens/deduction-edit-model.js';
import { UPDATE_COLUMNS, COLUMN_VALUES, createDb } from '../../app/core/db.js';

const members = [{ id: 'm1', member_slot: 1, display_name: '가람' }, { id: 'm2', member_slot: 2, display_name: '나리' }];

test('보일 거래: 지출·환불, 휴지통·집계 제외·시험 결제수단 아님', () => {
  const r = { kind: 'expense', deleted_at: null, is_excluded: false, is_test_source: false };
  assert.equal(canEditDeduction(r), true);
  assert.equal(canEditDeduction({ ...r, kind: 'refund' }), true);
  for (const o of [{ kind: 'income' }, { kind: 'transfer' }, { deleted_at: 'x' }, { is_excluded: true }, { is_test_source: true }]) {
    assert.equal(canEditDeduction({ ...r, ...o }), false, JSON.stringify(o));
  }
  assert.equal(canEditDeduction(null), false);
});

test('지금 판정: 하나·나눈 금액마다, 의료비면 대상자', () => {
  assert.deepEqual(autoView([]), { text: '판정 없음(금액 0 또는 대상 아님)', medical: false, beneficiaryId: null });
  assert.equal(autoView([{ deduction_kind: 'check_card' }]).text, '체크카드');
  assert.equal(autoView([{ deduction_kind: 'none' }]).text, '공제 대상 아님');
  assert.equal(autoView([{ deduction_kind: 'credit_card' }, { deduction_kind: 'excluded' }]).text, '신용카드 · 공제 제외(나눈 금액마다)');
  assert.deepEqual(autoView([{ deduction_kind: 'credit_card', tax_credit_kind: 'medical', beneficiary_member_id: 'm2' }]).beneficiaryId, 'm2');
  assert.equal(kindLabel('culture'), '문화체육');
  assert.equal(kindLabel('x'), '-');
});

test('거래 고친 값: 바뀐 칸만 + updated_by, 자동 = null, 모르는 값 거부, 대상자는 의료비일 때만 보냄', () => {
  const cur = { deduction_kind: null, beneficiary_member_id: null };
  assert.equal(deductionPatch(cur, { kind: '' }, 'm1'), null);
  assert.deepEqual(deductionPatch(cur, { kind: 'cash_receipt' }, 'm1'), { deduction_kind: 'cash_receipt', updated_by: 'm1' });
  assert.deepEqual(deductionPatch({ deduction_kind: 'excluded' }, { kind: '' }, 'm1'), { deduction_kind: null, updated_by: 'm1' });
  assert.deepEqual(deductionPatch(cur, { kind: '', beneficiary: 'm2' }, 'm1'), { beneficiary_member_id: 'm2', updated_by: 'm1' });
  assert.deepEqual(deductionPatch({ beneficiary_member_id: 'm2' }, { kind: '', beneficiary: '' }, 'm1'), { beneficiary_member_id: null, updated_by: 'm1' });
  assert.equal(deductionPatch(cur, { kind: 'bogus' }, 'm1'), null);
  assert.equal(deductionPatch(cur, { kind: '', beneficiary: 'zz' }, 'm1', ['m1', 'm2']), null); // 구성원이 아닌 대상자
  assert.deepEqual(deductionPatch(cur, { kind: '', beneficiary: 'm2' }, 'm1', ['m1', 'm2']), { beneficiary_member_id: 'm2', updated_by: 'm1' });
  // 모든 칸이 update 허용 목록 안
  const p = deductionPatch(cur, { kind: 'culture', beneficiary: 'm2' }, 'm1');
  for (const k of Object.keys(p)) assert.ok(UPDATE_COLUMNS.transactions.includes(k), k);
});

test('대상자 안내: 결제수단 주인과 다르면만', () => {
  assert.equal(beneficiaryNote(null, 'm1', members), null);
  assert.equal(beneficiaryNote('m1', 'm1', members), null);
  assert.match(beneficiaryNote('m2', 'm1', members), /^나리의 의료비를 다른 사람 명의 결제수단으로 냈어요/);
});

test('카테고리 기본값: 바뀐 칸만, 없음 = null, 모르는 값 거부, 꼬리표', () => {
  const cat = { default_deduction_kind: null, tax_credit_kind: 'medical' };
  assert.equal(categoryDeductionPatch(cat, { defaultKind: '', taxCredit: 'medical' }), null);
  assert.deepEqual(categoryDeductionPatch(cat, { defaultKind: 'culture', taxCredit: '' }), { default_deduction_kind: 'culture', tax_credit_kind: null });
  assert.equal(categoryDeductionPatch(cat, { defaultKind: 'credit_card' }), null); // 카테고리 기본값에 결제 매체는 없음
  assert.equal(categoryDeductionPatch(cat, { taxCredit: 'gift' }), null);
  assert.equal(categoryDeductionTag({ default_deduction_kind: 'public_transit', tax_credit_kind: 'medical' }), '대중교통 · 의료비');
  assert.equal(categoryDeductionTag({}), null);
  for (const k of ['default_deduction_kind', 'tax_credit_kind']) assert.ok(UPDATE_COLUMNS.categories.includes(k));
});

test('DB 값 검사: DB CHECK와 같은 목록 + null, 그 밖은 보내지 않음', async () => {
  for (const [k] of TXN_KINDS) assert.equal(COLUMN_VALUES.transactions.deduction_kind(k), true);
  assert.equal(COLUMN_VALUES.transactions.deduction_kind(null), true);
  assert.equal(COLUMN_VALUES.transactions.deduction_kind('gift'), false);
  for (const [k] of CATEGORY_KINDS) assert.equal(COLUMN_VALUES.categories.default_deduction_kind(k), true);
  for (const [k] of TAX_CREDIT_KINDS) assert.equal(COLUMN_VALUES.categories.tax_credit_kind(k), true);
  assert.equal(COLUMN_VALUES.categories.default_deduction_kind('credit_card'), false);
  let calls = 0;
  const b = { update() { calls += 1; return b; }, eq() { return b; }, select() { return Promise.resolve({ data: [{}], error: null }); } };
  const db = createDb({ from: () => b, rpc() {} });
  assert.equal((await db.update('transactions', 't1', { deduction_kind: 'gift' })).error.code, 'invalid');
  assert.equal((await db.update('categories', 'c1', { tax_credit_kind: 'gift' })).error.code, 'invalid');
  assert.equal((await db.update('transactions', 't1', { beneficiary_member_id: 'zzz' })).error.code, 'invalid');
  assert.equal(COLUMN_VALUES.transactions.beneficiary_member_id(null), true);
  assert.equal(COLUMN_VALUES.transactions.beneficiary_member_id(['a0000000', '0000', '4000', '8000', `${'0'.repeat(10)}e1`].join('-')), true);
  assert.equal(calls, 0);
  assert.equal((await db.update('transactions', 't1', { deduction_kind: null, updated_by: 'm1' })).error, null);
  assert.equal(calls, 1);
});
