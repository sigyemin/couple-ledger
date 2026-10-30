// 파싱 Worker 만들기: Trusted Types 정책, 시간 제한, 오류 코드
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 모듈 안의 정책 캐시를 테스트마다 새로 쓰기 위해 쿼리를 붙여 따로 불러온다
let n = 0;
const load = () => import(`../../app/core/parse-worker.js?t=${++n}`);

function fakeTT() {
  const created = [];
  return {
    created,
    createPolicy(name, rules) {
      created.push(name);
      return { createScriptURL: (u) => ({ trusted: rules.createScriptURL(u) }) };
    },
  };
}

class FakeWorker {
  static last = null;
  static reply = null;
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.terminated = false;
    FakeWorker.last = this;
  }
  postMessage(msg) {
    this.msg = msg;
    const r = FakeWorker.reply;
    if (r) queueMicrotask(() => this.onmessage?.({ data: { ...r, id: msg.id } }));
  }
  terminate() { this.terminated = true; }
}

test('정책은 WORKER_URL 하나만 허용하고 한 번만 만든다', async () => {
  const m = await load();
  const tt = fakeTT();
  const env = { trustedTypes: tt };
  assert.deepEqual(m.trustedWorkerUrl(env), { trusted: m.WORKER_URL });
  m.trustedWorkerUrl(env);
  assert.deepEqual(tt.created, ['cl-worker']);
  assert.match(m.WORKER_URL, /\/app\/workers\/parse\.js$/);
  assert.equal(m.trustedWorkerUrl({}), m.WORKER_URL); // trustedTypes 없는 환경
});

test('정책은 다른 주소를 거부한다', async () => {
  const m = await load();
  let rules;
  m.trustedWorkerUrl({ trustedTypes: { createPolicy: (name, r) => { rules = r; return { createScriptURL: r.createScriptURL }; } } });
  assert.throws(() => rules.createScriptURL('blob:https://x/1'));
  assert.throws(() => rules.createScriptURL(`${m.WORKER_URL}?x`));
});

test('runParseWorker: module Worker, 성공·실패 코드, 끝나면 terminate', async () => {
  const m = await load();
  const env = { Worker: FakeWorker };
  FakeWorker.reply = { ok: true, fileType: 'xlsx', formatIds: ['a'] };
  const r = await m.runParseWorker({ op: 'detect', bytes: new ArrayBuffer(1), formats: [] }, { env });
  assert.equal(r.fileType, 'xlsx');
  assert.deepEqual(FakeWorker.last.opts, { type: 'module' });
  assert.equal(FakeWorker.last.terminated, true);
  FakeWorker.reply = { ok: false, code: 'unsupported_file' };
  await assert.rejects(m.runParseWorker({ op: 'detect' }, { env }), { message: 'unsupported_file' });
  assert.equal(FakeWorker.last.terminated, true);
});

test('runParseWorker: 시간이 지나면 terminate하고 timeout', async () => {
  const m = await load();
  FakeWorker.reply = null;
  await assert.rejects(m.runParseWorker({ op: 'parse' }, { env: { Worker: FakeWorker }, timeoutMs: 20 }), { message: 'timeout' });
  assert.equal(FakeWorker.last.terminated, true);
});

test('runParseWorker: 응답 복제 실패(messageerror)면 기다리지 않고 바로 실패 + terminate', async () => {
  const m = await load();
  class BadClone extends FakeWorker {
    postMessage(msg) { this.msg = msg; queueMicrotask(() => this.onmessageerror?.({})); }
  }
  // 주 판정 = 동작: 시간 제한(timeout)이 아니라 worker_error로 끝남(= 시간 제한을 기다리지 않았다). 시간은 넉넉한 보조 상한만(CL-072 ③)
  const t = Date.now();
  await assert.rejects(m.runParseWorker({ op: 'parse' }, { env: { Worker: BadClone }, timeoutMs: 60000 }), { message: 'worker_error' });
  const ms = Date.now() - t;
  assert.ok(ms < 5000, `messageerror: ${ms}ms (시간 제한 60000ms를 기다리면 안 됨, 상한 5000ms)`);
  assert.equal(FakeWorker.last.terminated, true);
});
