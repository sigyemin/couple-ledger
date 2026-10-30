// v0.18 앱 후속 (CL-053) — 합성 값만
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAppError } from '../../app/core/errors.js';
import { buildManualRow, manualRpcArgs, rpcRowId } from '../../app/screens/add-model.js';
import { linkOne } from '../../app/screens/refund.js';
import { categoryErrorText, deleteErrorText, nameErrorText } from '../../app/screens/categories-model.js';
import { lockErrorText } from '../../app/screens/sources-model.js';
import { restoreResultText } from '../../app/screens/trash-model.js';
import { valuesErrorText } from '../../app/screens/detail-edit-model.js';

const U = (n) => ['a0000000', '0000', '4000', '8000', String(n).padStart(12, '0')].join('-');

test('오류 hint: DB 식별자 모양만 남긴다(already_linked)', () => {
  const e = toAppError({ code: 'LG003', message: '이미 원거래에 연결된 환불입니다', hint: 'already_linked' });
  assert.deepEqual([e.code, e.detail], ['refund_invalid', { sqlState: 'LG003', hint: 'already_linked' }]);
  assert.equal(toAppError({ code: 'LG003', hint: 'Try 김가짜 1234' }).detail.hint, undefined);
  assert.equal(toAppError({ code: 'LG003', hint: null }).detail.hint, undefined);
});

test('직접 추가 RPC 인자(A1): 정해진 키만, 카테고리면 한 줄, dedup은 DB가', () => {
  const ctx = { sourceIds: new Set([U(1)]), categoryIds: new Set([U(9)]), memberId: U(5), newId: () => U(77) };
  const b = buildManualRow({ sourceId: U(1), kind: 'expense', date: '2026-10-29', time: '09:05', merchant: '가짜식당', amountText: '12,300', categoryId: U(9), isShared: false, memo: '점심' }, ctx);
  const a = manualRpcArgs(b, U(77));
  assert.deepEqual(Object.keys(a.p_row).sort(), ['amount', 'entry_key', 'is_shared', 'kind', 'memo', 'merchant_raw', 'occurred_on', 'occurred_time', 'source_id']);
  assert.deepEqual(a.p_row, { entry_key: U(77), source_id: U(1), occurred_on: '2026-10-29', occurred_time: '09:05:00', merchant_raw: '가짜식당', amount: 12300, kind: 'expense', is_shared: false, memo: '점심' });
  assert.deepEqual(a.p_lines, [{ category_id: U(9), amount: 12300, item_note: null }]);
  assert.equal(b.row.dedup_key, `manual|${U(77)}`); // 23505 때 찾는 키 = DB가 만드는 키
  const noCat = buildManualRow({ sourceId: U(1), kind: 'income', date: '2026-10-29', time: '', merchant: '가짜회사', amountText: '1000', categoryId: '', isShared: true, memo: '' }, ctx);
  const a2 = manualRpcArgs(noCat, U(78));
  assert.deepEqual([a2.p_lines, a2.p_row.occurred_time, a2.p_row.memo], [[], null, null]);
  assert.equal(rpcRowId({ id: U(3) }), U(3));
  assert.equal(rpcRowId([{ id: U(4) }]), U(4));
  assert.equal(rpcRowId(null), null);
});

function fakeDb({ linkError = null } = {}) {
  const calls = [];
  return {
    calls,
    async select() { return { data: [{ id: U(1), refund_of_txn_id: null, deleted_at: null }], error: null }; },
    async rpc(name, args) { calls.push([name, args]); return linkError ? { data: null, error: linkError } : { data: { id: U(1) }, error: null }; },
    async update(t, id, patch) { calls.push(['update', id, patch]); return { data: [{ id }], error: null }; },
  };
}

test('환불 연결(A3): 제안·일괄은 p_only_unlinked, 이미 연결됨(hint)이면 건너뜀, 원거래 바꾸기는 인자 2개', async () => {
  const db = fakeDb();
  assert.deepEqual(await linkOne(db, U(5), U(1), U(2), { onlyIfUnlinked: true }), { ok: true, linked: true });
  assert.deepEqual(db.calls[0], ['link_refund', { p_refund_id: U(1), p_original_id: U(2), p_only_unlinked: true }]);
  const db2 = fakeDb();
  await linkOne(db2, U(5), U(1), U(2));
  assert.deepEqual(db2.calls[0], ['link_refund', { p_refund_id: U(1), p_original_id: U(2) }]);
  const db3 = fakeDb({ linkError: toAppError({ code: 'LG003', hint: 'already_linked' }) });
  assert.deepEqual(await linkOne(db3, U(5), U(1), U(2), { onlyIfUnlinked: true }), { ok: false, linked: false, skipped: true });
  assert.equal(db3.calls.filter((c) => c[0] === 'update').length, 0); // 확인함으로 바꾸지 않음
  const other = toAppError({ code: 'LG003' });
  const db4 = fakeDb({ linkError: other });
  assert.deepEqual(await linkOne(db4, U(5), U(1), U(2), { onlyIfUnlinked: true }), { ok: false, linked: false, error: other });
});

test('새 오류 문구(A5): 카테고리 LG004·LG005·23514, 결제수단 LG005, 휴지통 LG005', () => {
  const e = (code) => toAppError({ code });
  assert.match(categoryErrorText(e('LG004')), /기본 카테고리는 지울 수 없어요/);
  assert.match(categoryErrorText(e('LG005')), /다른 그룹으로 옮기거나/);
  assert.match(categoryErrorText(e('23514')), /2단계까지만.*지출과 수입/);
  assert.equal(categoryErrorText(e('42501')), null);
  assert.match(deleteErrorText(e('LG004')), /끄기/);
  assert.match(deleteErrorText(e('23503')), /끌 수만/);
  assert.match(nameErrorText(e('23514')), /2단계/);
  assert.match(lockErrorText(e('LG005')), /시험용 여부는 관리자만/);
  assert.match(valuesErrorText(e('LG005'), { kind: 'expense' }), /휴지통에 있는 거래라/);
  assert.equal(restoreResultText([{ id: 'a', ok: true }, { id: 'b', ok: false, code: 'immutable' }], 0),
    '1건 되살렸어요. 1건은 휴지통에서 바꿀 수 없는 값이 있어 되살리지 못했어요. 새로고침해 주세요.');
});
