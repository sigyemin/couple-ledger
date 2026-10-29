// 월 검토 모델 (가짜 가맹점만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultReviewMonth, progress, uncategorizedGroups, duplicateGroups, unlinkedRefundCount, mismatchItems, confirmBothPatch } from '../../app/screens/review-model.js';
import { parseHash } from '../../app/router.js';
import { activeTab } from '../../app/screens/shell.js';

const base = { source_id: 's1', source_label: '시험카드', occurred_time: null, memo: null, kind: 'expense', review_status: 'needs_review', is_uncategorized: true };
const rows = [
  { ...base, id: 'a', merchant_raw: '가상마트', merchant_norm: '가상마트', occurred_on: '2026-10-03', amount: 10000 },
  { ...base, id: 'b', merchant_raw: '가상마트 ', merchant_norm: '가상마트', occurred_on: '2026-10-09', amount: 5000 },
  { ...base, id: 'c', merchant_raw: '가상마트', merchant_norm: '가상마트', occurred_on: '2026-10-11', amount: 2000, kind: 'refund' },
  { ...base, id: 'd', merchant_raw: '시험회사', merchant_norm: '시험회사', occurred_on: '2026-10-25', amount: 900, kind: 'income' },
  { ...base, id: 'e', merchant_raw: '카드대금', merchant_norm: '카드대금', occurred_on: '2026-10-25', amount: 1, kind: 'transfer' },
  { ...base, id: 'f', merchant_raw: '샘플카페', merchant_norm: '샘플카페', occurred_on: '2026-10-12', amount: 4500, review_status: 'confirmed' },
  { ...base, id: 'g', merchant_raw: '샘플카페', merchant_norm: '샘플카페', occurred_on: '2026-10-12', amount: 4500, occurred_time: '09:30:00', is_uncategorized: false },
  { ...base, id: 'h', merchant_raw: '시험상점', merchant_norm: '시험상점', occurred_on: '2026-10-13', amount: 700, review_status: 'confirmed', is_uncategorized: false },
  { ...base, id: 'i', merchant_raw: '시험상점', merchant_norm: '시험상점', occurred_on: '2026-10-13', amount: 700, review_status: 'auto', is_uncategorized: false },
];

test('진행률: v_monthly_summary 숫자 그대로', () => {
  assert.deepEqual(progress({ txn_count: '40', needs_review_count: 10 }), { total: 40, pending: 10, done: 30, ratio: 0.75, text: '40건 중 30건 확인 · 검토 대기 10건' });
  assert.deepEqual([progress(null).text, progress(null).ratio], ['이 달 거래가 없어요', 1]);
});

test('분류가 필요해요: 검토 대기·미분류·이체 제외, 가맹점 정리값별, 수입은 따로, 건수 많은 순', () => {
  const g = uncategorizedGroups(rows);
  assert.deepEqual(g.map((x) => [x.merchant, x.kind, x.count, x.amountText, x.ids]), [
    ['가상마트', 'expense', 3, '13,000원', ['a', 'b', 'c']],
    ['시험회사', 'income', 1, '900원', ['d']],
  ], '환불은 빼서 합계, 확인한 것·분류된 것·이체는 빠짐');
});

test('같은 거래 의심: 뷰 묶음 중 그 달에 2건 이상 + 검토 대기가 있는 것만', () => {
  const dups = [
    { source_id: 's1', occurred_on: '2026-10-12', merchant_norm: '샘플카페', amount: '4500', kind: 'expense', txn_count: 2 },
    { source_id: 's1', occurred_on: '2026-10-13', merchant_norm: '시험상점', amount: 700, kind: 'expense', txn_count: 2 },
    { source_id: 's9', occurred_on: '2026-10-12', merchant_norm: '샘플카페', amount: 4500, kind: 'expense', txn_count: 2 },
  ];
  const g = duplicateGroups(dups, rows);
  assert.equal(g.length, 1, '시험상점은 둘 다 검토 대기가 아님, s9는 이 달 거래에 없음');
  assert.deepEqual([g[0].title, g[0].items.map((i) => i.text), g[0].pendingIds], ['샘플카페 · 10월 12일 (월) · 4,500원 · 2건', ['시험카드', '시험카드 · 09:30'], ['g']]);
  assert.deepEqual(confirmBothPatch('m1'), { review_status: 'confirmed', updated_by: 'm1' });
});

test('미연결 환불 수·나눈 금액 불일치(그 달만)·라우트', () => {
  assert.equal(unlinkedRefundCount({ unlinked_refund_count: '2' }), 2);
  assert.deepEqual(mismatchItems([{ id: 'a', merchant_raw: '가상마트', occurred_on: '2026-10-03', amount: 10000, lines_amount: '9000' }, { id: 'zz', merchant_raw: 'x', occurred_on: '2026-09-01', amount: 1, lines_amount: 0 }], rows),
    [{ id: 'a', text: '가상마트 · 10월 3일 (토)', sub: '거래 10,000원 · 나눈 합계 9,000원' }]);
  assert.deepEqual([parseHash('#/review?month=2026-10').screen, activeTab('review')], ['review', 'more']);
});

test('월 검토 기본 달: 지금은 이번 달(서울)', () => {
  assert.equal(defaultReviewMonth(new Date('2026-10-31T15:30:00Z')), '2026-11-01');
});
