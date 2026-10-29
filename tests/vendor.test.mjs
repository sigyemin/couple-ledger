// vendor/ 무결성 + supabase-client 래퍼
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVendor } from '../scripts/vendor-check.mjs';
import { createSupabaseClient, authStoragePrefix } from '../app/core/supabase-client.js';

const VENDOR = fileURLToPath(new URL('../vendor', import.meta.url));

test('vendor/ 파일의 sha256·sha384가 integrity.json과 같다', () => {
  assert.deepEqual(checkVendor(VENDOR), []);
});

test('파일이 바뀌거나 목록에 없는 파일이 있으면 실패한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-'));
  cpSync(VENDOR, dir, { recursive: true });
  writeFileSync(join(dir, 'xlsx-0.20.3', 'LICENSE'), 'changed');
  mkdirSync(join(dir, 'extra'));
  writeFileSync(join(dir, 'extra', 'x.js'), '//');
  const problems = checkVendor(dir);
  assert.ok(problems.includes('xlsx-0.20.3/LICENSE: sha256 불일치'));
  assert.ok(problems.includes('xlsx-0.20.3/LICENSE: sha384 불일치'));
  assert.ok(problems.includes('extra/x.js: integrity.json에 없는 파일'));
});

test('authStoragePrefix: supabase-js 기본 저장 키 접두', () => {
  assert.equal(authStoragePrefix('https://fakeref00.supabase.co'), 'sb-fakeref00-');
});

test('createSupabaseClient: PKCE, https만, 전역이 없으면 오류', () => {
  const calls = [];
  const lib = { createClient: (...a) => { calls.push(a); return { ok: true }; } };
  assert.deepEqual(createSupabaseClient({ url: 'https://fakeref00.supabase.co/', key: 'sb_publishable_fake', lib }), { ok: true });
  assert.equal(calls[0][0], 'https://fakeref00.supabase.co');
  assert.equal(calls[0][2].auth.flowType, 'pkce');
  assert.throws(() => createSupabaseClient({ url: 'http://fakeref00.supabase.co', key: 'k', lib }));
  assert.throws(() => createSupabaseClient({ url: 'https://fakeref00.supabase.co', key: '', lib }));
  assert.throws(() => createSupabaseClient({ url: 'https://fakeref00.supabase.co', key: 'k', lib: undefined }));
});
