// 업로드: 묶음 만들기·이어 올리기, 200행씩 보내기, 결과 모으기 (가짜 db)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureBatch, uploadRows, batchFileName, CHUNK_ROWS } from '../../app/import/upload.js';
import { AppError } from '../../app/core/errors.js';
import { createDb } from '../../app/core/db.js';

const SRC = 'a0000000-0000-4000-8000-0000000000a1';
const MEMBER = 'a0000000-0000-4000-8000-0000000000e1';
const HASH = 'ab'.repeat(32);
const guard = { async requireMember() { return { memberId: MEMBER, memberSlot: 1, displayName: '사용자A' }; } };

function fakeDb({ existing = null, insertError = null, rpc } = {}) {
  const calls = [];
  return {
    calls,
    async select(view, opts) {
      calls.push(['select', view, opts]);
      return { data: existing ? [{ id: existing }] : [], error: null };
    },
    async insert(table, row) {
      calls.push(['insert', table, row]);
      if (insertError) return { data: null, error: insertError };
      return { data: [{ id: 'b-new' }], error: null };
    },
    async rpc(name, args) {
      calls.push(['rpc', name, args]);
      return rpc(args);
    },
  };
}

test('batchFileName: 앱이 만든 이름만, 60자 이하', () => {
  assert.equal(batchFileName('가상 기관(A)', '2026-10-01', 'xlsx'), '가상기관A_2026-10.xlsx');
  assert.equal(batchFileName('', '2026-10-01', 'xls'), 'file_2026-10.xls');
  assert.ok(batchFileName('가'.repeat(80), '2026-10-01', 'html').length <= 60);
});

test('ensureBatch: 새 묶음 / 같은 해시면 이어 올리기', async () => {
  const db = fakeDb();
  assert.deepEqual(await ensureBatch(db, guard, { sourceId: SRC, targetMonth: '2026-10-01', fileHash: HASH, fileName: 'x_2026-10.xlsx'}),
    { batchId: 'b-new', resumed: false });
  assert.deepEqual(db.calls[0][2].filters, [{ col: 'source_id', op: 'eq', value: SRC }, { col: 'file_hash', op: 'eq', value: HASH }]);
  assert.deepEqual(db.calls[1], ['insert', 'import_batches',
    { source_id: SRC, target_month: '2026-10-01', file_name: 'x_2026-10.xlsx', file_hash: HASH, uploaded_by: MEMBER }]);

  const db2 = fakeDb({ existing: 'b-old' });
  assert.deepEqual(await ensureBatch(db2, guard, { sourceId: SRC, targetMonth: '2026-10-01', fileHash: HASH, fileName: 'x'}),
    { batchId: 'b-old', resumed: true });
  assert.equal(db2.calls.length, 1);
});

test('ensureBatch: 형식 오류·DB 오류', async () => {
  await assert.rejects(ensureBatch(fakeDb(), guard, { sourceId: SRC, targetMonth: '2026-10-02', fileHash: HASH }), TypeError);
  await assert.rejects(ensureBatch(fakeDb(), guard, { sourceId: SRC, targetMonth: '2026-10-01', fileHash: 'xyz' }), TypeError);
  const err = new AppError('forbidden', 'x', { sqlState: '42501' });
  await assert.rejects(ensureBatch(fakeDb({ insertError: err }), guard, { sourceId: SRC, targetMonth: '2026-10-01', fileHash: HASH, fileName: 'x'}), { code: 'forbidden' });
});

const rows = (n) => Array.from({ length: n }, (_, i) => ({ rowNo: i + 10, dedup_key: `k${i}`, amount: i }));

test('uploadRows: 200행씩, rowNo는 보내지 않고 결과를 파일 줄 번호로', async () => {
  const sent = [];
  const db = fakeDb({
    rpc(args) {
      sent.push(args.p_rows);
      const data = args.p_rows.map((r, i) => ({
        row_no: i + 1,
        result: r.amount === 3 ? 'sensitive' : r.amount === 4 ? 'duplicate' : 'inserted',
        detail: r.amount === 3 ? 'LG002' : r.amount === 5 ? 'LG003' : null,
      }));
      return { data, error: null };
    },
  });
  const progress = [];
  const r = await uploadRows(db, 'b1', rows(450), { onProgress: (p) => progress.push(p.sentRows) });
  assert.deepEqual(sent.map((p) => p.length), [CHUNK_ROWS, CHUNK_ROWS, 50]);
  assert.ok(sent.flat().every((x) => !('rowNo' in x)));
  assert.equal(db.calls[0][2].p_batch_id, 'b1');
  assert.deepEqual(r.counts, { inserted: 448, duplicate: 1, sensitive: 1, refund_invalid: 0, invalid: 0 });
  assert.deepEqual(r.failures, [
    { rowNo: 13, result: 'sensitive', sqlState: 'LG002' },
    { rowNo: 15, result: 'refund_unlinked', sqlState: 'LG003' },
  ]);
  assert.deepEqual(progress, [200, 400, 450]);
  assert.equal(r.error, null);
});

test('uploadRows: RPC 실패면 재시도 없이 멈추고 지금까지 결과', async () => {
  let n = 0;
  const db = fakeDb({
    rpc(args) {
      n++;
      if (n === 2) return { data: null, error: new AppError('network', 'x') };
      return { data: args.p_rows.map((_, i) => ({ row_no: i + 1, result: 'inserted', detail: null })), error: null };
    },
  });
  const r = await uploadRows(db, 'b1', rows(300), { chunkRows: 100 });
  assert.equal(n, 2);
  assert.equal(r.sentRows, 100);
  assert.equal(r.counts.inserted, 100);
  assert.equal(r.error.code, 'network');
});

test('db.insert: 형식 검사·재시도 없음', async () => {
  const calls = [];
  const client = {
    from(t) {
      const b = { insert(row) { calls.push(['insert', t, row]); return b; }, select() { calls.push(['select']); return b; } };
      b.then = (res) => Promise.resolve({ data: null, error: { code: '', message: 'TypeError: Failed to fetch' } }).then(res);
      return b;
    },
    rpc() {},
  };
  const db = createDb(client);
  const r = await db.insert('import_batches', { source_id: SRC });
  assert.equal(r.error.code, 'network');
  assert.equal(calls.filter((c) => c[0] === 'insert').length, 1);
  for (const bad of [db.insert('x;', { a: 1 }), db.insert('t', {}), db.insert('t', [{ a: 1 }]), db.insert('t', { 'a b': 1 })]) {
    assert.equal((await bad).error.code, 'invalid');
  }
});

test('D3: 환불 행이 duplicate인데 DB 금액과 다르면 알림, 같으면 없음, 조회 실패는 표시만', async () => {
  const rows = [
    { rowNo: 3, kind: 'expense', amount: 20000, dedup_key: 'a' },
    { rowNo: 3, kind: 'refund', amount: 6000, dedup_key: 'b' },
    { rowNo: 4, kind: 'refund', amount: 9000, dedup_key: 'c' },
  ];
  const selects = [];
  const db = {
    async rpc(_, args) {
      return { data: args.p_rows.map((r, i) => ({ row_no: i + 1, result: 'duplicate', txn_id: `t-${r.dedup_key}`, detail: null })), error: null };
    },
    async select(view, opts) {
      selects.push([view, opts]);
      return { data: [{ id: 't-b', amount: '5000' }, { id: 't-c', amount: 9000 }], error: null };
    },
  };
  const r = await uploadRows(db, 'b1', rows);
  assert.deepEqual(r.notices, [{ rowNo: 3, kind: 'refund_amount_changed', oldAmount: 5000, newAmount: 6000 }]);
  assert.equal(r.noticeCheckFailed, false);
  assert.deepEqual(selects[0], ['transactions', { columns: 'id,amount', filters: [{ col: 'id', op: 'in', value: ['t-b', 't-c'] }] }]);

  const failing = { ...db, async select() { return { data: null, error: new AppError('network', 'x') }; } };
  const r2 = await uploadRows(failing, 'b1', rows);
  assert.deepEqual([r2.notices, r2.noticeCheckFailed, r2.counts.duplicate], [[], true, 3]);
});

test('db.insert: 허용 목록 밖의 표는 보내지 않는다', async () => {
  const sent = [];
  const client = { from(t) { sent.push(t); return {}; }, rpc() {} };
  const db = createDb(client);
  for (const t of ['members', 'transactions', 'categories']) {
    assert.equal((await db.insert(t, { a: 1 })).error.code, 'invalid');
  }
  assert.deepEqual(sent, []);
});

test('ensureBatch: uploaded_by는 인증 가드의 구성원 id만, 호출자 값은 무시, 구성원 아니면 만들지 않음', async () => {
  const db = fakeDb();
  await ensureBatch(db, guard, { sourceId: SRC, targetMonth: '2026-10-01', fileHash: HASH, fileName: 'x', memberId: 'OTHER-MEMBER-ID', uploaded_by: 'OTHER' });
  assert.equal(db.calls[1][2].uploaded_by, MEMBER);
  const db2 = fakeDb();
  const noMember = { async requireMember() { throw new AppError('not_member', 'x'); } };
  await assert.rejects(ensureBatch(db2, noMember, { sourceId: SRC, targetMonth: '2026-10-01', fileHash: HASH, fileName: 'x' }), { code: 'not_member' });
  assert.equal(db2.calls.filter((c) => c[0] === 'insert').length, 0);
});
