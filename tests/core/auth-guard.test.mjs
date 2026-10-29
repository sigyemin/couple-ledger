import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthGuard, clearLocalData } from '../../app/core/auth-guard.js';

const MEMBER = 'a0000000-0000-4000-8000-000000000001';

function setup({ session = { user: { id: 'u1', email: 'x@example.com' } }, memberId = MEMBER, rows, rpcError } = {}) {
  const log = [];
  const auth = {
    async getSession() { return { data: { session }, error: null }; },
    async signInWithOAuth(arg) { log.push(['signIn', arg]); return { data: {}, error: null }; },
    async signOut() { log.push(['signOut']); return { error: null }; },
  };
  const db = {
    async rpc(name, args, opts) {
      log.push(['rpc', name, opts]);
      return rpcError ? { data: null, error: rpcError } : { data: memberId, error: null };
    },
    async select(view, opts) {
      log.push(['select', view, opts]);
      return { data: rows ?? [{ id: memberId, member_slot: 1, display_name: '민' }], error: null };
    },
  };
  const clear = async () => log.push(['clear']);
  return { guard: createAuthGuard({ auth, db, redirectTo: 'https://example.invalid/app/', clear }), log };
}

test('구성원이면 별칭·슬롯만 준다 (이메일·토큰 없음)', async () => {
  const { guard, log } = setup();
  const m = await guard.requireMember();
  assert.deepEqual(m, { memberId: MEMBER, memberSlot: 1, displayName: '민' });
  assert.deepEqual(guard.current(), m);
  assert.ok(!JSON.stringify(m).includes('example.com'));
  assert.deepEqual(log[0], ['rpc', 'my_member_id', { retry: true }]);
  // 두 번째 호출은 캐시
  await guard.requireMember();
  assert.equal(log.filter((x) => x[0] === 'rpc').length, 1);
});

test('세션이 없으면 not_login', async () => {
  const { guard } = setup({ session: null });
  await assert.rejects(guard.requireMember(), { code: 'not_login' });
});

test('미등록 계정이면 로그아웃 + 로컬 정리 후 not_member', async () => {
  const { guard, log } = setup({ memberId: null });
  await assert.rejects(guard.requireMember(), { code: 'not_member' });
  assert.deepEqual(log.slice(-2), [['signOut'], ['clear']]);
  assert.equal(guard.current(), null);
});

test('구성원 행이 안 보이면 not_member', async () => {
  const { guard, log } = setup({ rows: [] });
  await assert.rejects(guard.requireMember(), { code: 'not_member' });
  assert.ok(log.some((x) => x[0] === 'clear'));
});

test('구성원 확인 RPC 오류는 그대로 올리고 로그아웃하지 않는다', async () => {
  const { guard, log } = setup({ rpcError: { code: 'network' } });
  await assert.rejects(guard.requireMember());
  assert.ok(!log.some((x) => x[0] === 'signOut'));
});

test('로그인은 구글 + redirectTo', async () => {
  const { guard, log } = setup();
  await guard.signIn();
  assert.deepEqual(log[0], ['signIn', { provider: 'google', options: { redirectTo: 'https://example.invalid/app/' } }]);
});

test('clearLocalData: IndexedDB·Cache Storage를 지운다. 없거나 실패해도 throw 안 함', async () => {
  const deleted = [];
  const env = {
    indexedDB: {
      async databases() { return [{ name: 'a' }, { name: 'b' }]; },
      deleteDatabase(name) {
        deleted.push(`idb:${name}`);
        const req = {};
        queueMicrotask(() => req.onsuccess?.());
        return req;
      },
    },
    caches: {
      async keys() { return ['shell-v1']; },
      async delete(k) { deleted.push(`cache:${k}`); return true; },
    },
  };
  await clearLocalData(env);
  assert.deepEqual(deleted.sort(), ['cache:shell-v1', 'idb:a', 'idb:b']);
  await clearLocalData({});
  await clearLocalData({ indexedDB: { databases() { throw new Error('x'); } } });
});
