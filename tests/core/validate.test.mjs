import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../../app/core/validate.js';

const j = (...parts) => parts.join('');

test('amount: 0 이상 정수, 14자리 이하', () => {
  assert.deepEqual(v.amount(15000), { ok: true, value: 15000 });
  assert.deepEqual(v.amount('1,234,567원'), { ok: true, value: 1234567 });
  assert.equal(v.amount(0).ok, true);
  assert.equal(v.amount(-1).ok, false);
  assert.equal(v.amount(1.5).ok, false);
  assert.equal(v.amount('12.5').ok, false);
  assert.equal(v.amount(Number('1' + '0'.repeat(14))).ok, false); // 15자리
  assert.equal(v.amount('').ok, false);
});

test('ratio: 0~100, 소수 둘째 자리까지', () => {
  assert.equal(v.ratio(50).ok, true);
  assert.equal(v.ratio('33.33').value, 33.33);
  assert.equal(v.ratio('100').ok, true);
  assert.equal(v.ratio('100.01').ok, false);
  assert.equal(v.ratio('33.333').ok, false);
  assert.equal(v.ratio(-1).ok, false);
});

test('date: 실제 있는 날짜만', () => {
  assert.equal(v.date('2026-10-06').ok, true);
  assert.equal(v.date('2026-02-30').ok, false);
});

test('text: 길이·민감번호·필수', () => {
  assert.deepEqual(v.text('  커피  ', 'memo'), { ok: true, value: '커피' });
  assert.equal(v.text('', 'memo').ok, true);
  assert.equal(v.text('', 'merchant', { required: true }).reason, 'required');
  assert.equal(v.text('가'.repeat(51), 'alias').reason, 'too_long');
  assert.equal(v.text('가'.repeat(50), 'alias').ok, true);
  assert.equal(v.text(`김가짜 ${j('010-1234', '-5678')}`, 'memo').reason, 'sensitive');
  assert.equal(v.text('2026-10-06 15000원', 'memo').ok, true);
  assert.throws(() => v.text('x', 'unknown_kind'));
});

test('code: 값 목록 안의 값만', () => {
  assert.equal(v.code('expense', 'txn_kind').ok, true);
  assert.equal(v.code('gift', 'txn_kind').ok, false);
  assert.equal(v.code(2, 'member_slot').ok, true);
  assert.equal(v.code(3, 'member_slot').ok, false);
});

test('exclusion: C9 규칙 (DB CHECK와 같은 조건)', () => {
  assert.equal(v.exclusion({ kind: 'expense', isExcluded: false, excludeReason: null }).ok, true);
  assert.equal(v.exclusion({ kind: 'transfer', isExcluded: true, excludeReason: 'card_bill' }).ok, true);
  assert.equal(v.exclusion({ kind: 'expense', isExcluded: true, excludeReason: 'other' }).ok, true);
  // 이체인데 이체 성격 사유 없음
  assert.equal(v.exclusion({ kind: 'transfer', isExcluded: true, excludeReason: 'other' }).ok, false);
  assert.equal(v.exclusion({ kind: 'transfer', isExcluded: false, excludeReason: null }).ok, false);
  // 이체 성격 사유인데 이체 아님
  assert.equal(v.exclusion({ kind: 'expense', isExcluded: true, excludeReason: 'personal_transfer' }).ok, false);
  // 제외 ⇔ 사유
  assert.equal(v.exclusion({ kind: 'expense', isExcluded: true, excludeReason: null }).ok, false);
  assert.equal(v.exclusion({ kind: 'expense', isExcluded: false, excludeReason: 'other' }).ok, false);
  assert.equal(v.exclusion({ kind: 'expense', isExcluded: true, excludeReason: 'nope' }).ok, false);
});

test('approvalNo: 승인번호 형식, 빈 값은 null', () => {
  assert.deepEqual(v.approvalNo('AB12CD34'), { ok: true, value: 'AB12CD34' });
  assert.deepEqual(v.approvalNo(''), { ok: true, value: null });
  assert.equal(v.approvalNo(j('12345', '67890')).ok, false);
  assert.equal(v.approvalNo('12-34').ok, false);
});

test('거래 날짜 범위(CL-047): 2000-01-01 ~ 오늘+1년, 2월 29일 → 다음 해 2월 28일, today가 없으면 범위 검사 안 함', () => {
  assert.deepEqual(v.dateRange('2026-10-30'), { min: '2000-01-01', max: '2027-10-30' });
  assert.deepEqual(v.dateRange('2028-02-29'), { min: '2000-01-01', max: '2029-02-28' });
  assert.throws(() => v.dateRange('2026-13-01'));
  const t = { today: '2026-10-30' };
  assert.equal(v.date('2000-01-01', t).ok, true);
  assert.equal(v.date('1999-12-31', t).ok, false);
  assert.equal(v.date('2027-10-30', t).ok, true);
  assert.equal(v.date('2027-10-31', t).message, v.MESSAGES.date_range);
  assert.equal(v.date('1999-12-31').ok, true);
  assert.equal(v.date('2026-02-30', t).message, v.MESSAGES.date);
});
