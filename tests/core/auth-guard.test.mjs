import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthGuard, clearLocalData } from '../../app/core/auth-guard.js';
import { AppError } from '../../app/core/errors.js';

function fakeStorage(keys) {
  const m = new Map(keys.map((k) => [k, 'v']));
  return {
    get length() { return m.size; },
    key(i) { return [...m.keys()][i] ?? null; },
    removeItem(k) { m.delete(k); },
    clear() { throw new Error('clear() 사용 금지'); },
    keys: () => [...m.keys()],
  };
}

const MEMBER = 'a0000000-0000-4000-8000-000000000001';

function setup({ session = { user: { id: 'u1', email: 'x@example.com' } }, memberId = MEMBER, rows, rpcError } = {}) {
  const log = [];
  let listener = null;
  const auth = {
    onAuthStateChange(fn) { listener = fn; return { data: { subscription: {} } }; },
    emit(event) { listener?.(event, null); },
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
      return { data: rows ?? [{ id: memberId, member_slot: 1, display_name: '사용자A' }], error: null };
    },
  };
  const clear = async () => log.push(['clear']);
  return { guard: createAuthGuard({ auth, db, redirectTo: 'https://example.invalid/app/', clear }), log, auth };
}

test('구성원이면 별칭·슬롯만 준다 (이메일·토큰 없음)', async () => {
  const { guard, log } = setup();
  const m = await guard.requireMember();
  assert.deepEqual(m, { memberId: MEMBER, memberSlot: 1, displayName: '사용자A' });
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

test('구성원 확인 RPC가 네트워크 오류여도 로그아웃 + 정리 후 오류 (막는 쪽)', async () => {
  const { guard, log } = setup({ rpcError: new AppError('network', 'x') });
  await assert.rejects(guard.requireMember(), { code: 'network' });
  assert.deepEqual(log.slice(-2), [['signOut'], ['clear']]);
  assert.equal(guard.current(), null);
});

test('구성원 확인 RPC가 권한 거부면 로그아웃 + 정리 후 forbidden', async () => {
  const { guard, log } = setup({ rpcError: new AppError('forbidden', 'x', { sqlState: '42501' }) });
  await assert.rejects(guard.requireMember(), { code: 'forbidden' });
  assert.deepEqual(log.slice(-2), [['signOut'], ['clear']]);
});

test('세션이 바뀌면(로그아웃 등) 확인된 구성원을 버리고 다시 확인한다', async () => {
  const { guard, log, auth } = setup();
  await guard.requireMember();
  auth.emit('TOKEN_REFRESHED');
  assert.notEqual(guard.current(), null);
  auth.emit('SIGNED_OUT');
  assert.equal(guard.current(), null);
  await guard.requireMember();
  assert.equal(log.filter((x) => x[0] === 'rpc').length, 2);
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
  env.localStorage = fakeStorage(['sb-fakeref-auth-token', 'sb-fakeref-auth-token-code-verifier', 'cl-draft', 'other-app-key']);
  env.sessionStorage = fakeStorage(['cl-filter', 'other-app-session']);
  assert.equal(await clearLocalData(env), true);
  assert.deepEqual(deleted.sort(), ['cache:shell-v1', 'idb:a', 'idb:b']);
  // 이 앱·supabase 키만 지우고 같은 출처의 다른 페이지 키는 남긴다
  assert.deepEqual(env.localStorage.keys(), ['other-app-key']);
  assert.deepEqual(env.sessionStorage.keys(), ['other-app-session']);
  assert.equal(await clearLocalData({}), true);
  const blocked = {
    indexedDB: {
      async databases() { return [{ name: 'a' }]; },
      deleteDatabase() { const req = {}; queueMicrotask(() => req.onblocked?.()); return req; },
    },
  };
  assert.equal(await clearLocalData(blocked), false);
  assert.equal(await clearLocalData({ indexedDB: { databases() { throw new Error('x'); } } }), false);
});
