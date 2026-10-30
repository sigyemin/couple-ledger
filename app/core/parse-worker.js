// =====================================================================
// 파싱 Worker 만들기·부르기 (보안 리뷰 v0.1 4.4, PR #4 리뷰 ④)
// - 같은 출처 module Worker만. blob:·data: 주소는 쓰지 않는다
// - Trusted Types: 이름 붙인 정책 하나('cl-worker')가 정확한 URL 하나(app/workers/parse.js)만 허용한다.
//   default 정책·allow-duplicates는 쓰지 않는다. CSP에는 `trusted-types cl-worker`를 넣는다
// - 한 번 부를 때마다 Worker를 새로 만들고, 끝나거나 60초가 지나면 terminate한다(ReDoS·압축 폭탄 대비).
//   여러 달이 든 큰 파일·느린 PC를 감안해 20초 → 60초(CL-051). 합성 3,000행은 1초 안팎
// 의존 없음.
// =====================================================================

export const WORKER_URL = new URL('../workers/parse.js', import.meta.url).href;
export const TIMEOUT_MS = 60 * 1000;
export const POLICY_NAME = 'cl-worker';

let policy = null;

/** WORKER_URL만 통과시키는 Trusted Types 값. trustedTypes가 없는 환경이면 문자열 그대로 */
export function trustedWorkerUrl(env = globalThis) {
  const tt = env.trustedTypes;
  if (!tt?.createPolicy) return WORKER_URL;
  policy ??= tt.createPolicy(POLICY_NAME, {
    createScriptURL(u) {
      if (u !== WORKER_URL) throw new TypeError('허용하지 않은 Worker 주소입니다');
      return u;
    },
  });
  return policy.createScriptURL(WORKER_URL);
}

/**
 * Worker에 한 번 일을 시킨다. 응답의 ok가 false면 Error(code)로 reject
 * @param {object} message  { op, bytes(ArrayBuffer), ... } — bytes는 복사해서 넘긴다(원본 파일 버퍼 유지)
 */
export function runParseWorker(message, { env = globalThis, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new env.Worker(trustedWorkerUrl(env), { type: 'module' });
    const id = 1;
    const done = (fn, v) => {
      clearTimeout(timer);
      worker.terminate();
      fn(v);
    };
    const timer = setTimeout(() => done(reject, new Error('timeout')), timeoutMs);
    worker.onmessage = (e) => {
      if (e.data?.id !== id) return;
      if (e.data.ok) done(resolve, e.data);
      else done(reject, new Error(e.data.code ?? 'parse_failed'));
    };
    worker.onerror = () => done(reject, new Error('worker_error'));
    worker.onmessageerror = () => done(reject, new Error('worker_error')); // 응답 복제 실패: 기다리지 않고 바로 실패
    worker.postMessage({ ...message, id });
  });
}
