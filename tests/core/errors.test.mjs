import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AppError, toAppError, isNetworkError, browserKind, newTraceId, displayCode, errorCode, createErrorLogger, STAGES, ACTIONS,
} from '../../app/core/errors.js';

const TRACE = '3f2a9c1e-0000-4000-8000-000000000001';

test('SQLSTATE → 분류·문구. 원본 메시지는 담지 않는다', () => {
  const e = toAppError({ code: 'LG002', message: '원본에 값 김가짜 포함', details: 'x', hint: '' });
  assert.ok(e instanceof AppError);
  assert.equal(e.code, 'sensitive');
  assert.equal(e.detail.sqlState, 'LG002');
  assert.ok(!e.message.includes('김가짜'));
  assert.ok(!JSON.stringify(e.detail).includes('김가짜'));
  assert.equal(toAppError({ code: 'LG007' }).code, 'bulk_invalid');
  assert.equal(toAppError({ code: '42501' }).code, 'forbidden');
  assert.equal(toAppError({ code: '23505' }).code, 'duplicate');
});

test('모르는 코드는 unknown, code 없는 fetch 실패는 network', () => {
  assert.equal(toAppError({ code: 'PGRST116', message: 'x' }).code, 'unknown');
  assert.equal(toAppError({ code: 'ZZ999' }).code, 'unknown');
  assert.equal(toAppError({ code: '', message: 'TypeError: Failed to fetch' }).code, 'network');
  assert.equal(toAppError(new TypeError('Failed to fetch')).code, 'network');
  assert.equal(toAppError({ message: 'something else' }).code, 'unknown');
  assert.equal(isNetworkError(new TypeError('x')), true);
  const same = new AppError('forbidden', 'x');
  assert.equal(toAppError(same), same);
});

test('browserKind', () => {
  const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const android = 'Mozilla/5.0 (Linux; Android 15; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
  const samsung = 'Mozilla/5.0 (Linux; Android 15; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36';
  const edge = `${desktop} Edg/141.0.0.0`;
  assert.equal(browserKind(desktop), 'chrome_desktop');
  assert.equal(browserKind(android), 'chrome_android');
  assert.equal(browserKind(samsung), 'samsung');
  assert.equal(browserKind(edge), 'other');
  assert.equal(browserKind('Mozilla/5.0 Firefox/140.0'), 'other');
});

test('trace id·화면 표시 번호', () => {
  assert.match(newTraceId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(displayCode({ code: 'LG002' }, TRACE), 'LG002 · 3f2a9c1e');
  assert.equal(displayCode(new TypeError('x')), 'NETWORK');
  assert.equal(errorCode({ code: 'LG005' }), 'LG005');
});

function fakeRpc(result = { data: true, error: null }) {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (result instanceof Error) throw result;
    return result;
  };
  return { rpc, calls };
}

test('구성원 오류 기록: 정해진 칸만 보낸다', async () => {
  const { rpc, calls } = fakeRpc();
  const log = createErrorLogger({ rpc, userAgent: 'SamsungBrowser/28.0 Chrome/130' });
  const ok = await log.member({ code: 'LG002', message: '원본 메시지 김가짜' }, {
    stage: STAGES.import_save, action: ACTIONS.upload, traceId: TRACE, batchId: TRACE, rowNo: 7, txnId: 'not-uuid',
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'log_member_error');
  assert.deepEqual(calls[0].args, {
    p_error_code: 'LG002', p_sql_state: 'LG002', p_stage_code: 'import_save', p_action_code: 'upload',
    p_browser_kind: 'samsung', p_app_version: '0.1.0', p_trace_id: TRACE,
    p_txn_id: null, p_batch_id: TRACE, p_row_no: 7, p_change_batch_id: null,
  });
  assert.ok(!JSON.stringify(calls[0].args).includes('김가짜'));
});

test('형식이 틀리면 보내지 않고 false', async () => {
  const { rpc, calls } = fakeRpc();
  const log = createErrorLogger({ rpc, userAgent: '' });
  assert.equal(await log.member({ code: 'LG002' }, { stage: 'Bad-Stage', traceId: TRACE }), false);
  assert.equal(await log.member({ code: 'LG002' }, { stage: 'list', traceId: 'x' }), false);
  assert.equal(await log.auth(new TypeError('x'), { stage: 'auth_login' }), false);
  assert.equal(calls.length, 0);
});

test('로그인 전 오류 기록 (신원 없음)', async () => {
  const { rpc, calls } = fakeRpc();
  const log = createErrorLogger({ rpc, userAgent: '' });
  assert.equal(await log.auth(new TypeError('x'), { stage: STAGES.auth_login, traceId: TRACE }), true);
  assert.deepEqual(calls[0], {
    name: 'log_auth_error',
    args: { p_error_code: 'NETWORK', p_stage_code: 'auth_login', p_browser_kind: 'other', p_app_version: '0.1.0', p_trace_id: TRACE },
  });
});

test('기록 실패는 throw하지 않는다', async () => {
  const thrown = createErrorLogger({ rpc: fakeRpc(new Error('down')).rpc });
  assert.equal(await thrown.auth({ code: 'LG002' }, { stage: 'boot', traceId: TRACE }), false);
  const refused = createErrorLogger({ rpc: fakeRpc({ data: null, error: { code: '22023' } }).rpc });
  assert.equal(await refused.auth({ code: 'LG002' }, { stage: 'boot', traceId: TRACE }), false);
  const capped = createErrorLogger({ rpc: fakeRpc({ data: false, error: null }).rpc });
  assert.equal(await capped.auth({ code: 'LG002' }, { stage: 'boot', traceId: TRACE }), false);
  assert.throws(() => createErrorLogger({ rpc: () => {}, appVersion: 'v1' }));
});
