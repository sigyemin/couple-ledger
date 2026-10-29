import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, likeContains } from '../../app/core/db.js';
import { AppError } from '../../app/core/errors.js';

// supabase-js 쿼리 빌더 흉내: 호출을 기록하고, 마지막에 results에서 하나씩 꺼내 돌려준다
function fakeClient(results) {
  const calls = [];
  const next = () => {
    const r = results.shift();
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r);
  };
  const builder = (path) => {
    const b = {};
    for (const m of ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'ilike', 'order', 'range', 'update']) {
      b[m] = (...args) => {
        path.push([m, ...args]);
        return b;
      };
    }
    b.then = (res, rej) => next().then(res, rej);
    return b;
  };
  return {
    calls,
    from(name) {
      const path = [['from', name]];
      calls.push(path);
      return builder(path);
    },
    rpc(name, args) {
      calls.push([['rpc', name, args]]);
      return next();
    },
  };
}

const NET = { data: null, error: { code: '', message: 'TypeError: Failed to fetch' } };

test('select: 필터·정렬·쪽을 빌더 호출로만 만든다', async () => {
  const c = fakeClient([{ data: [{ id: 'a' }], error: null }]);
  const db = createDb(c);
  const r = await db.select('v_transaction_detail', {
    filters: [
      { col: 'period_month', op: 'eq', value: '2026-10-01' },
      { col: 'merchant_norm', op: 'ilike', value: likeContains('50%_할인') },
    ],
    order: [{ col: 'occurred_on', ascending: false }],
    range: { from: 0, to: 49 },
  });
  assert.deepEqual(r, { data: [{ id: 'a' }], error: null });
  assert.deepEqual(c.calls[0], [
    ['from', 'v_transaction_detail'], ['select', '*'],
    ['eq', 'period_month', '2026-10-01'], ['ilike', 'merchant_norm', '%50\\%\\_할인%'],
    ['order', 'occurred_on', { ascending: false }], ['range', 0, 49],
  ]);
});

test('likeContains: \\ % _ 이스케이프', () => {
  assert.equal(likeContains('a\\b%c_d'), '%a\\\\b\\%c\\_d%');
});

test('형식이 틀린 호출은 DB에 보내지 않고 invalid', async () => {
  const c = fakeClient([]);
  const db = createDb(c);
  const bad = [
    db.select('v; drop table x'),
    db.select('members', { filters: [{ col: 'id', op: 'or', value: 'x' }] }),
    db.select('members', { filters: [{ col: 'name)', op: 'eq', value: 'x' }] }),
    db.select('members', { filters: [{ col: 'merchant_norm', op: 'ilike', value: 'raw%' }] }),
    db.select('members', { filters: [{ col: 'id', op: 'is', value: 'null' }] }),
    db.select('members', { columns: 'id,*' }),
    db.select('members', { range: { from: 5, to: 1 } }),
    db.rpc('drop-all'),
    db.rpc('find_x', { 'p bad': 1 }),
    db.update('transactions', '', { memo: 'x' }),
    db.update('transactions', 'id1', {}),
  ];
  for (const r of await Promise.all(bad)) {
    assert.ok(r.error instanceof AppError);
    assert.equal(r.error.code, 'invalid');
  }
  assert.equal(c.calls.length, 0);
});

test('읽기는 네트워크 오류만 1회 재시도', async () => {
  const c = fakeClient([NET, { data: [1], error: null }]);
  const r = await createDb(c).select('members');
  assert.deepEqual(r, { data: [1], error: null });
  assert.equal(c.calls.length, 2);

  const c2 = fakeClient([NET, NET, { data: [1], error: null }]);
  const r2 = await createDb(c2).select('members');
  assert.equal(r2.error.code, 'network');
  assert.equal(c2.calls.length, 2);

  const c3 = fakeClient([{ data: null, error: { code: '42501' } }]);
  const r3 = await createDb(c3).select('members');
  assert.equal(r3.error.code, 'forbidden');
  assert.equal(c3.calls.length, 1);
});

test('쓰기 RPC·update는 재시도하지 않는다', async () => {
  const c = fakeClient([NET]);
  const r = await createDb(c).rpc('bulk_set_category', { p_txn_ids: [], p_category_id: 'x' });
  assert.equal(r.error.code, 'network');
  assert.equal(c.calls.length, 1);

  const c2 = fakeClient([new TypeError('Failed to fetch')]);
  const r2 = await createDb(c2).update('transactions', 'id1', { memo: '커피' });
  assert.equal(r2.error.code, 'network');
  assert.equal(c2.calls.length, 1);
  assert.deepEqual(c2.calls[0], [['from', 'transactions'], ['update', { memo: '커피' }], ['eq', 'id', 'id1'], ['select']]);

  const c3 = fakeClient([NET, { data: 'm1', error: null }]);
  const r3 = await createDb(c3).rpc('my_member_id', {}, { retry: true });
  assert.deepEqual(r3, { data: 'm1', error: null });
});

test('DB 오류는 AppError로 (SQLSTATE만 남김)', async () => {
  const c = fakeClient([{ data: null, error: { code: 'LG002', message: '값 포함 메시지' } }]);
  const r = await createDb(c).rpc('import_transactions', {});
  assert.equal(r.error.code, 'sensitive');
  assert.deepEqual(r.error.detail, { sqlState: 'LG002' });
});

test('클라이언트가 없으면 만들지 않는다', () => {
  assert.throws(() => createDb(null));
  assert.throws(() => createDb({ from() {} }));
});
