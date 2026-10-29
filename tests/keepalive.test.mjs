// keepalive 워크플로 검사 (외부 패키지 없음: YAML 파서 대신 줄 단위로 본다)
// 1) 정적 검사: 권한 최소화, 외부 액션 없음, ${{ }}는 env 대입에만, 로그 노출·커밋 금지
// 2) 동작 검사: run 본문을 실제 셸 옵션(bash -eo pipefail)으로 실행. curl은 가짜로 바꿔 네트워크 호출 없음
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const src = readFileSync(new URL('../.github/workflows/keepalive.yml', import.meta.url), 'utf8');
const lines = src.split('\n');
const codeLines = lines.filter((l) => !/^\s*#/.test(l)); // 주석 줄 제외
const code = codeLines.join('\n');
const indentOf = (l) => l.search(/\S/);

// jobs: 아래 job별 텍스트 { ping: '...', 'keep-active': '...' }
function jobs() {
  const out = {};
  const start = codeLines.findIndex((l) => /^jobs:\s*$/.test(l));
  let name = null;
  for (const l of codeLines.slice(start + 1)) {
    if (l.trim() !== '' && indentOf(l) === 0) break;
    const m = l.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (m) { name = m[1]; out[name] = []; continue; }
    if (name) out[name].push(l);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n');
  return out;
}

// run 본문: 블록(|, |-, >, >- 등)과 한 줄 형태 모두
function runBodies(text) {
  const ls = text.split('\n');
  const bodies = [];
  for (let i = 0; i < ls.length; i++) {
    const m = ls[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!m) continue;
    if (m[2] !== '' && !/^[|>][-+]?\s*$/.test(m[2])) { bodies.push(m[2]); continue; }
    const indent = indentOf(ls[i]);
    const body = [];
    for (let j = i + 1; j < ls.length; j++) {
      if (ls[j].trim() !== '' && indentOf(ls[j]) <= indent) break;
      body.push(ls[j]);
    }
    const min = Math.min(...body.filter((l) => l.trim()).map(indentOf));
    bodies.push(body.map((l) => l.slice(min)).join('\n'));
  }
  return bodies;
}

// 줄 끝 \ 로 이어진 명령을 한 줄로
const joinContinued = (s) => s.replace(/\\\n\s*/g, ' ');

const J = jobs();
const allRuns = Object.values(J).flatMap(runBodies);

// ---------------------------------------------------------------------
// 정적 검사
// ---------------------------------------------------------------------
test('job은 ping, keep-active 두 개이고 각각 run 단계 1개', () => {
  assert.deepEqual(Object.keys(J).sort(), ['keep-active', 'ping']);
  assert.equal(runBodies(J.ping).length, 1);
  assert.equal(runBodies(J['keep-active']).length, 1);
  // jobs 밖 run 단계 없음 (defaults: run: 은 제외)
  const runKeys = codeLines.filter((l) => /^\s*(- )?run:/.test(l) && !/^ {2}run:\s*$/.test(l));
  assert.equal(allRuns.length, runKeys.length);
});

test('탭 문자가 없다 (YAML 들여쓰기)', () => {
  assert.ok(!src.includes('\t'));
});

test('예약 실행은 정각이 아닌 하루 1회 + 수동 실행', () => {
  const crons = [...src.matchAll(/cron:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(crons.length, 1);
  const [min, hour, dom, mon, dow] = crons[0].split(/\s+/);
  assert.match(min, /^\d+$/);
  assert.notEqual(Number(min), 0);
  assert.match(hour, /^\d+$/);
  assert.deepEqual([dom, mon, dow], ['*', '*', '*']);
  assert.match(src, /^\s+workflow_dispatch:/m);
});

test('트리거는 schedule, workflow_dispatch 두 개뿐', () => {
  const start = codeLines.findIndex((l) => /^on:\s*$/.test(l));
  assert.ok(start >= 0);
  const keys = [];
  for (const l of codeLines.slice(start + 1)) {
    if (l.trim() !== '' && indentOf(l) === 0) break;
    const m = l.match(/^ {2}([a-z_]+):/);
    if (m) keys.push(m[1]);
  }
  assert.deepEqual(keys, ['schedule', 'workflow_dispatch']);
  assert.equal((code.match(/^\S*on:/gm) || []).length, 1);
});

test('실패를 성공으로 바꾸는 continue-on-error가 없다', () => {
  assert.ok(!/continue-on-error/.test(code));
});

test('기본 셸은 bash (pipefail 켜짐)', () => {
  assert.match(code, /^defaults:\n {2}run:\n {4}shell: bash\s*$/m);
  assert.ok(!/^\s+shell:(?! bash\s*$)/m.test(code));
});

test('권한: 최상위 {}, ping {}, keep-active는 actions: write 하나뿐', () => {
  assert.match(code, /^permissions: \{\}$/m);
  assert.match(J.ping, /^ {4}permissions: \{\}\s*$/m);
  const ka = J['keep-active'].split('\n');
  const at = ka.findIndex((l) => /^ {4}permissions:\s*$/.test(l));
  assert.ok(at >= 0);
  const perms = [];
  for (const l of ka.slice(at + 1)) {
    if (l.trim() !== '' && indentOf(l) <= 4) break;
    if (l.trim()) perms.push(l.trim());
  }
  assert.deepEqual(perms, ['actions: write']);
  assert.equal((code.match(/permissions:/g) || []).length, 3);
  assert.ok(!/write-all|read-all/.test(code));
});

test('외부 액션·checkout을 쓰지 않는다', () => {
  assert.ok(!/^\s*-?\s*uses:/m.test(code));
});

test('${{ }}는 env 대입 줄(KEY: ${{ vars.X }} / ${{ github.token }})에만 있다', () => {
  for (const l of codeLines) {
    if (!l.includes('${{')) continue;
    assert.match(l, /^\s+[A-Z_]+: \$\{\{ (vars\.[A-Z_]+|github\.token) \}\}\s*$/, l);
  }
  for (const b of allRuns) assert.ok(!b.includes('${{'), b);
});

test('Supabase 값은 vars에서만, secret 키·비밀은 쓰지 않는다', () => {
  assert.ok(!/secrets\./.test(code));
  assert.ok(!/service_role|sb_secret_/i.test(code));
  assert.match(J.ping, /^ {6}URL: \$\{\{ vars\.SUPABASE_URL \}\}$/m);
  assert.match(J.ping, /^ {6}KEY: \$\{\{ vars\.SUPABASE_PUBLISHABLE_KEY \}\}$/m);
  assert.match(J.ping, /^ {6}REQUIRED: \$\{\{ vars\.KEEPALIVE_REQUIRED \}\}$/m);
});

test('run 본문: 명령 추적·curl 상세 출력·git(커밋·push)·인코딩 도구 금지', () => {
  for (const b of allRuns) {
    assert.ok(!/\bset\s+[-+][a-z]*x|xtrace/.test(b), 'set -x');
    assert.ok(!/(?:^|\s)-[a-zA-Z]*v[a-zA-Z]*(?=\s|$)|--verbose|--trace|--libcurl/.test(b), 'curl -v/--trace');
    assert.ok(!/(?:^|\s)-[a-zA-Z]*[kD][a-zA-Z]*(?=\s|$)|--insecure|--dump-header/.test(b), 'curl -k/-D');
    assert.ok(!/\bgit\b/.test(b), 'git');
    assert.ok(!/\b(base64|xxd|od|hexdump|rev|openssl|printenv|env)\b/.test(b), '인코딩·환경 출력 도구');
  }
});

test('토큰·키는 정해진 줄에서만 쓴다', () => {
  for (const b of allRuns) {
    for (const l of b.split('\n')) {
      if (l.includes('GH_TOKEN')) assert.match(l, /^\s*-H "Authorization: Bearer \$GH_TOKEN" \\$/, l);
      if (/\$\{?KEY\b/.test(l)) {
        assert.ok(/^\s*-H "apikey: \$KEY" \\$/.test(l) || /\[ -z "\$KEY" \]/.test(l), l);
      }
    }
  }
});

test('curl 응답 본문을 로그에 남기지 않는다 (-o /dev/null 또는 state 값만 추출)', () => {
  const curls = allRuns
    .flatMap((b) => joinContinued(b).split('\n'))
    .filter((l) => /\bcurl\b/.test(l));
  assert.equal(curls.length, 3);
  for (const c of curls) {
    assert.ok(/--fail\b/.test(c), c);
    const quiet = /\s-o \/dev\/null\s/.test(c);
    const stateOnly = c.endsWith(`| sed -n 's/^ *"state": *"\\([a-z_]*\\)".*/\\1/p' | head -n 1)`);
    assert.ok(quiet || stateOnly, c);
  }
});

test('keep-active는 이 워크플로의 enable API를 PUT으로 호출한다', () => {
  assert.match(J['keep-active'], /^ {6}WORKFLOW_FILE: keepalive\.yml$/m);
  assert.match(runBodies(J['keep-active'])[0], /-X PUT[\s\S]*"\$api\/enable"/);
});

// ---------------------------------------------------------------------
// 동작 검사 (가짜 curl, 네트워크 없음)
// ---------------------------------------------------------------------
// 가짜 curl: 받은 인자를 기록하고, 메서드별로 정해진 값을 출력한다.
// CURL_FAIL=GET|PUT|POST 이면 그 요청에서 curl --fail처럼 22로 끝난다.
function withFakeCurl(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'keepalive-test-'));
  try {
    writeFileSync(join(dir, 'curl'), [
      '#!/bin/sh',
      'echo "$*" >> "$CURL_LOG"',
      'method=GET',
      'case " $* " in *" -X PUT "*) method=PUT ;; *" -X POST "*) method=POST ;; esac',
      'if [ "$CURL_FAIL" = "$method" ]; then echo "curl: (22) error" >&2; exit 22; fi',
      'case $method in',
      '  GET) printf \'{\\n  "id": 1,\\n  "state": "active",\\n  "path": "x"\\n}\\n\' ;;',
      '  PUT) printf 204 ;;',
      '  POST) printf 200 ;;',
      'esac',
    ].join('\n'));
    chmodSync(join(dir, 'curl'), 0o755);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runStep(body, env, dir) {
  const log = join(dir, 'log');
  writeFileSync(log, '');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', body], {
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH}`, CURL_LOG: log, ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

const pingBody = runBodies(J.ping)[0];
const kaBody = runBodies(J['keep-active'])[0];
const KA_ENV = {
  GH_TOKEN: 'test-token',
  WORKFLOW_FILE: 'keepalive.yml',
  GITHUB_API_URL: 'https://api.example.test',
  GITHUB_REPOSITORY: 'owner/repo',
};

test('ping: 변수 없음 + KEEPALIVE_REQUIRED 없음 → 건너뜀, 성공, curl 호출 없음', () => withFakeCurl((dir) => {
  for (const env of [{}, { URL: 'https://db.example.test' }, { KEY: 'pk' }, { REQUIRED: '0' }]) {
    const r = runStep(pingBody, env, dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /::notice::.*건너뜀/);
    assert.deepEqual(r.calls, []);
  }
}));

test('ping: 변수 없음 + KEEPALIVE_REQUIRED=1 → ::error, 실패', () => withFakeCurl((dir) => {
  const r = runStep(pingBody, { REQUIRED: '1', KEY: 'pk' }, dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /::error::/);
  assert.deepEqual(r.calls, []);
}));

test('ping: 변수 있음 → keepalive RPC POST 1회, 키 값은 출력하지 않음', () => withFakeCurl((dir) => {
  const r = runStep(pingBody, { URL: 'https://db.example.test/', KEY: 'pk-test-value', REQUIRED: '1' }, dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /HTTP 200/);
  assert.ok(!r.out.includes('pk-test-value'));
  assert.equal(r.calls.length, 1);
  assert.match(r.calls[0], /-X POST https:\/\/db\.example\.test\/rest\/v1\/rpc\/keepalive /);
  assert.match(r.calls[0], /-H apikey: pk-test-value /);
}));

test('ping: RPC 실패 → 단계 실패', () => withFakeCurl((dir) => {
  const r = runStep(pingBody, { URL: 'https://db.example.test', KEY: 'pk', CURL_FAIL: 'POST' }, dir);
  assert.notEqual(r.code, 0, r.out);
}));

test('keep-active: GET 상태 → PUT enable, 토큰은 출력하지 않음', () => withFakeCurl((dir) => {
  const r = runStep(kaBody, KA_ENV, dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /현재 상태: active/);
  assert.match(r.out, /enable: HTTP 204/);
  assert.ok(!r.out.includes('test-token'));
  assert.equal(r.calls.length, 2);
  assert.match(r.calls[0], /https:\/\/api\.example\.test\/repos\/owner\/repo\/actions\/workflows\/keepalive\.yml$/);
  assert.match(r.calls[1], /-X PUT .*https:\/\/api\.example\.test\/repos\/owner\/repo\/actions\/workflows\/keepalive\.yml\/enable$/);
}));

test('keep-active: GET 실패도 단계 실패 (pipefail), PUT까지 가지 않음', () => withFakeCurl((dir) => {
  const r = runStep(kaBody, { ...KA_ENV, CURL_FAIL: 'GET' }, dir);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(r.calls.length, 1);
}));

test('keep-active: PUT 실패 → 단계 실패', () => withFakeCurl((dir) => {
  const r = runStep(kaBody, { ...KA_ENV, CURL_FAIL: 'PUT' }, dir);
  assert.notEqual(r.code, 0, r.out);
}));
