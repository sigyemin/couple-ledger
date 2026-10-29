// 휴지통·변경 기록 모델 (가짜 이름·가짜 가맹점만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trashGroups, restorePlan, restoreOrder, restoreConfirmText, restorePatch, restoreResultText } from '../../app/screens/trash-model.js';
import { batchRow, batchDetail, revertResultText, since90, KIND_NAME } from '../../app/screens/changes-model.js';
import { parseHash } from '../../app/router.js';
import { activeTab } from '../../app/screens/shell.js';

const U = (n) => ['a0000000', '0000', '4000', '8000', String(n).padStart(12, '0')].join('-');
const members = [{ id: 'm1', member_slot: 1, display_name: '가람' }, { id: 'm2', member_slot: 2, display_name: '나리' }];
const base = { kind: 'expense', origin: 'import', payer_member_id: 'm1', payer_name: '가람', source_label: '시험카드', refund_of_txn_id: null, period_month: '2026-10-01' };
const rows = [
  { ...base, id: U(1), occurred_on: '2026-10-05', merchant_raw: '가상식당', amount: 32000, deleted_at: '2026-10-28T03:00:00Z', deleted_by: 'm2' },
  { ...base, id: U(2), occurred_on: '2026-10-07', merchant_raw: '가상식당', amount: 8000, kind: 'refund', refund_of_txn_id: U(1), deleted_at: '2026-10-28T02:59:00Z', deleted_by: 'm2' },
  { ...base, id: U(3), occurred_on: '2026-09-20', merchant_raw: '시험상점', amount: 4500, origin: 'manual', deleted_at: '2026-10-27T15:30:00Z', deleted_by: 'm1', period_month: '2026-09-01' },
];

test('휴지통 목록: 지운 날(서울)별, 최근 순, 꼬리표, 누가 지움, 원거래+환불 함께', () => {
  const g = trashGroups(rows, members);
  assert.deepEqual(g.map((x) => [x.label, x.items.map((i) => i.id.slice(-1))]), [['10월 28일 (수) 지움', ['1', '2', '3']]], '10-27 15:30Z = 서울 10-28 00:30');
  const [o, r, m] = g[0].items;
  assert.deepEqual([o.amount, o.together, o.sub], ['32,000원', '환불 1건과 함께', '10월 5일 (월) · 시험카드 · 나리가 지움']);
  assert.deepEqual([r.amount, r.tags], ['−8,000원', ['환불']]);
  assert.deepEqual([m.tags, m.sub.endsWith('가람이 지움')], [['직접 추가'], true]);
});

test('되살리기: 원거래 먼저·환불 나중, 원거래가 휴지통이면 함께 할지 묻고 아니면 건너뜀', () => {
  const p = restorePlan([U(2), U(3)], rows);
  assert.deepEqual(p.askOriginals, [{ id: U(1), text: '가상식당 32,000원' }]);
  assert.deepEqual(restoreOrder(p, rows, [U(1)]), { order: [U(3), U(1), U(2)], skipped: [] });
  assert.deepEqual(restoreOrder(p, rows, []), { order: [U(3)], skipped: [U(2)] });
  const both = restorePlan([U(2), U(1)], rows);
  assert.deepEqual([both.askOriginals, restoreOrder(both, rows, []).order], [[], [U(1), U(2)]]);
  const t = restoreConfirmText([rows[0], rows[1], rows[2]], new Map([['2026-10-01', 'reviewed'], ['2026-09-01', 'not_reviewed']]));
  assert.match(t.message, /^3건을 되살릴까요\? 2026년 9월, 2026년 10월 집계·정산에 다시 들어가요\. 2026년 10월이 '확인 후 변경됨'이 돼요\. 원거래를 먼저/);
  assert.match(restoreConfirmText([rows[2]], new Map()).message, /^시험상점 4,500원을 되살릴까요\?/);
  assert.deepEqual(restorePatch('m1'), { deleted_at: null, deleted_by: null, updated_by: 'm1' });
  assert.equal(restoreResultText([{ ok: true }, { ok: false, code: 'refund_invalid' }, { ok: false, code: 'network' }], 1),
    '1건 되살렸어요. 1건은 원거래가 휴지통에 있어 되살리지 못했어요. 1건은 오류로 되살리지 못했어요. 환불 1건은 원거래가 휴지통에 있어 건너뛰었어요.');
});

test('변경 기록: 목록 줄, 상세 미리보기(원래대로/그대로), 결과 문장', () => {
  assert.equal(KIND_NAME.bulk_edit, '카테고리 바꾸기');
  assert.equal(since90(new Date('2026-10-29T00:00:00Z')), '2026-07-31T00:00:00.000Z');
  const b = { id: 'b1', kind: 'bulk_edit', description: '내역 일괄 · 2건 → 외식', created_by: 'm1', created_at: '2026-10-29T03:00:00Z', reverted_at: null, txn_count: 2 };
  assert.deepEqual(batchRow(b, members), { id: 'b1', title: '카테고리 바꾸기 · 내역 일괄 · 2건 → 외식', sub: '거래 2건 · 2026-10-29 12:00 · 가람', reverted: false, revertedText: null });
  assert.equal(batchRow({ ...b, reverted_at: '2026-10-30T00:00:00Z', reverted_by: 'm2' }, members).revertedText, '되돌림 · 나리가 2026-10-30 09:00');
  const cats = new Map([['g', { id: 'g', parent_id: null, name: '식비' }], ['c1', { id: 'c1', parent_id: 'g', name: '식재료' }], ['c2', { id: 'c2', parent_id: 'g', name: '외식' }]]);
  const txns = new Map([
    [U(1), { merchant_raw: '가상식당', occurred_on: '2026-10-05', amount: 32000, lines: [{ line_id: 'l1', category_id: 'c2' }] }],
    [U(3), { merchant_raw: '시험상점', occurred_on: '2026-10-06', amount: 4500, lines: [{ line_id: 'l3', category_id: 'c1' }] }],
    [U(4), { merchant_raw: '샘플카페', occurred_on: '2026-10-07', amount: 5000, lines: [{ line_id: 'l4', category_id: 'c2' }] }],
  ]);
  const items = [
    { txn_id: U(1), target_kind: 'line', line_id: 'l1', old_category_id: 'c1', new_category_id: 'c2', is_created_line: false, is_revertible: true, revert_action: 'revert' },
    { txn_id: U(3), target_kind: 'line', line_id: 'l3', old_category_id: null, new_category_id: 'c2', is_created_line: false, is_revertible: false, revert_action: 'conflict' },
    { txn_id: U(4), target_kind: 'line', line_id: 'l4', old_category_id: null, new_category_id: 'c2', is_created_line: true, is_revertible: true, revert_action: 'delete' },
  ];
  const d = batchDetail(b, items, txns, cats);
  assert.equal(d.preview, '되돌리면 2건이 원래대로, 1건은 그 뒤에 다시 바뀌어 그대로 둬요');
  assert.equal(batchDetail(b, [{ ...items[1], line_id: 'gone' }], txns, cats).rows[0].changes[0], '분류: 그 뒤 다시 바뀌어 그대로');
  assert.deepEqual(d.rows.map((r) => [r.tag, r.changes[0]]), [
    ['원래대로', '분류: 식비 · 외식 → 식비 · 식재료'], ['그대로', '분류: 그 뒤 직접 식비 · 식재료(으)로 고쳐 그대로'], ['원래대로', '분류: 식비 · 외식 → 분류 지움']]);
  assert.deepEqual([d.canRevert, d.buttonLabel, d.needsConfirm], [true, '2건 되돌리기', false]);
  assert.match(d.notes[0], /정산 숫자는 그대로/);
  const tx = batchDetail({ ...b, kind: 'counterparty_apply' }, [{ txn_id: U(1), target_kind: 'txn', old_kind: 'expense', new_kind: 'transfer', old_is_shared: true, new_is_shared: false,
    old_exclude_reason: null, new_exclude_reason: 'personal_transfer', old_review_status: 'needs_review', new_review_status: 'confirmed', is_revertible: true, revert_action: 'revert' }], txns, cats);
  assert.equal(tx.rows[0].changes[0], '종류 이체 → 지출, 개인 → 공동, 제외 두 사람 사이 송금 → 없음, 확인함 → 검토 대기');
  assert.equal(tx.needsConfirm, true);
  const done = batchDetail({ ...b, reverted_at: 'x' }, items, txns, cats);
  assert.deepEqual([done.preview, done.canRevert, done.rows[0].tag], [null, false, '되돌림']);
  assert.equal(revertResultText([{ txn_id: 'a', result: 'reverted' }, { txn_id: 'b', result: 'conflict' }, { txn_id: 'c', result: 'deleted' }, { txn_id: 'a', result: 'conflict' }]), '2건을 되돌렸어요. 1건은 그대로 뒀어요.');
});

test('라우트: change는 uuid만, 틀리면 목록. 더보기 탭', () => {
  assert.deepEqual(parseHash(`#/change/${U(9)}`), { screen: 'change', id: U(9), query: new Map() });
  assert.equal(parseHash('#/change/../x').screen, 'changes');
  assert.deepEqual(['trash', 'changes', 'change'].map(activeTab), ['more', 'more', 'more']);
});
