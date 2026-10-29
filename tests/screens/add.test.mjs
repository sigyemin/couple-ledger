// 거래 직접 추가 모델 (DB·브라우저 없이, 가짜 이름·가짜 가맹점만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceOptions, buildManualRow, monthOf, addConfirmText } from '../../app/screens/add-model.js';
import { INSERT_COLUMNS } from '../../app/core/db.js';

const U = (n) => ['a0000000', '0000', '4000', '8000', String(n).padStart(12, '0')].join('-');
const members = [{ id: 'm1', display_name: '가람' }, { id: 'm2', display_name: '나리' }];
const sources = [
  { id: U(1), label: '시험카드', kind: 'credit_card', owner_member_id: 'm1', is_active: true, is_test: false },
  { id: U(2), label: '현금', kind: 'cash', owner_member_id: 'm2', is_active: true, is_test: false },
  { id: U(3), label: '꺼진 통장', kind: 'bank_account', owner_member_id: 'm1', is_active: false, is_test: false },
  { id: U(4), label: 'QA 카드', kind: 'credit_card', owner_member_id: 'm1', is_active: true, is_test: true },
];
const ctx = { sourceIds: new Set([U(1), U(2)]), categoryIds: new Set([U(9)]), memberId: 'm1', newId: () => U(77) };
const form = { sourceId: U(2), kind: 'expense', date: '2026-10-29', time: '', merchant: ' 동네 시장 ', amountText: '12,300', categoryId: U(9), isShared: true, memo: '' };

test('결제수단: 켜진 것만, 결제자(주인) 이름 붙임, 시험 결제수단은 뒤에 표시', () => {
  assert.deepEqual(sourceOptions(sources, members).map((o) => o.text), ['시험카드 · 신용카드 · 가람', '현금 · 현금 · 나리', 'QA 카드 · 신용카드 · 가람 · 시험']);
});

test('buildManualRow: 허용 칸만으로 한 행, 수동·확인함·manual|uuid 중복 키', () => {
  const b = buildManualRow(form, ctx);
  assert.equal(b.ok, true);
  assert.deepEqual(b.row, {
    source_id: U(2), origin: 'manual', occurred_on: '2026-10-29', occurred_time: null, merchant_raw: '동네 시장', merchant_norm: b.row.merchant_norm,
    amount: 12300, kind: 'expense', is_shared: true, review_status: 'confirmed', memo: null, dedup_key: `manual|${U(77)}`, created_by: 'm1',
  });
  assert.match(b.row.dedup_key, /^manual\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, '스키마 ck_txn_dedup_key_format');
  assert.ok(Object.keys(b.row).every((k) => INSERT_COLUMNS.transactions.includes(k)));
  assert.deepEqual([b.categoryId, b.amount], [U(9), 12300]);
  assert.equal(buildManualRow({ ...form, time: '09:05' }, ctx).row.occurred_time, '09:05:00');
});

test('buildManualRow: 입력 오류(결제수단·종류·날짜·시각·가맹점·금액·민감번호·카테고리)', () => {
  const msg = (patch) => buildManualRow({ ...form, ...patch }, ctx);
  assert.equal(msg({ sourceId: U(3) }).field, 'source', '꺼진 결제수단');
  assert.equal(msg({ kind: 'transfer' }).field, 'kind');
  assert.equal(msg({ date: '2026-02-30' }).field, 'date');
  assert.equal(msg({ time: '25:00' }).field, 'time');
  assert.equal(msg({ merchant: '  ' }).field, 'merchant');
  assert.equal(msg({ amountText: '0' }).message, '0원은 넣을 수 없어요');
  assert.equal(msg({ amountText: '-5' }).field, 'amount');
  const digits = Array.from({ length: 10 }, () => 1 + Math.floor(Math.random() * 9)).join('');
  assert.equal(msg({ merchant: `송금 ${digits}` }).field, 'merchant');
  assert.equal(msg({ memo: `메모 ${digits}` }).field, 'memo');
  assert.equal(msg({ categoryId: U(8) }).field, 'category');
  assert.equal(msg({ categoryId: '' }).categoryId, null);
  assert.throws(() => buildManualRow(form, { ...ctx, newId: () => 'x' }));
});

test('확인한 달에 추가하면 저장 전 알림', () => {
  assert.equal(monthOf('2026-10-29'), '2026-10-01');
  const row = { occurred_on: '2026-09-30' };
  assert.equal(addConfirmText(row, 'not_reviewed'), null);
  assert.equal(addConfirmText(row, undefined), null);
  assert.match(addConfirmText(row, 'reviewed').message, /^2026년 9월은 확인을 마친 달/);
  assert.ok(addConfirmText(row, 'changed_after_review'));
});
