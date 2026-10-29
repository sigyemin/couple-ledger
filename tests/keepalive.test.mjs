// keepalive 워크플로 검사 (외부 패키지 없음: YAML 파서 대신 줄 단위로 본다)
// 1) 정적 검사: 권한 최소화, 외부 액션 없음, ${{ }}는 env 대입에만, 로그 노출·커밋 금지
// 2) 동작 검사: run 본문을 실제 셸 옵션(bash -eo pipefail)으로 실행. curl·git은 가짜로 바꿔 네트워크 호출 없음.
//    격리: 작업 폴더는 새 임시 폴더, PATH는 가짜 도구(curl·git·sed·head)만, 환경 변수는 시험 값만
//    (HOME·GIT_*·GH_*·GITHUB_* 등 실제 환경을 넘기지 않는다)
//    실행 전 관문: PATH·cwd 격리는 절대 경로(/usr/bin/git)나 /proc/$PPID 로 우회할 수 있으므로,
//    워크플로 본문은 assertSafeBody(명령 허용 목록)를 통과해야만 실행한다. 통과 못 하면 실행 없이 throw
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
// 가짜 git: 받은 인자를 기록하고 바로 실패한다(커밋·push가 실제로 일어나지 않게).
const FAKE_CURL = [
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
].join('\n');
const FAKE_GIT = ['#!/bin/sh', 'echo "$*" >> "$GIT_LOG"', 'echo "fake git: blocked" >&2', 'exit 97'].join('\n');

const which = (t) => execFileSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim();
const BASH = which('bash');

// 가짜 sed·head: 워크플로가 쓰는 인자 형태와 정확히 같을 때만 실제 도구를 (고정 인자로) 실행한다.
// 다른 인자(sed의 e·w 명령, 파일 경로 등)는 기록하고 98로 실패 → 허용 명령의 인자를 통한 우회 차단
const SED_SCRIPT = 's/^ *"state": *"\\([a-z_]*\\)".*/\\1/p';
const guardedTool = (name, cond, realArgs) => [
  '#!/bin/sh',
  'echo "$*" >> "$TOOL_LOG"',
  `if ${cond}; then exec ${which(name)} ${realArgs}; fi`,
  `echo "fake ${name}: 허용되지 않은 인자" >&2`,
  'exit 98',
].join('\n');
const FAKE_SED = guardedTool('sed', `[ "$#" -eq 2 ] && [ "$1" = -n ] && [ "$2" = '${SED_SCRIPT}' ]`, `-n '${SED_SCRIPT}'`);
const FAKE_HEAD = guardedTool('head', '[ "$#" -eq 2 ] && [ "$1" = -n ] && [ "$2" = 1 ]', '-n 1');

function withFakeCurl(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'keepalive-test-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    mkdirSync(join(dir, 'work'));
    for (const [t, text] of [['curl', FAKE_CURL], ['git', FAKE_GIT], ['sed', FAKE_SED], ['head', FAKE_HEAD]]) {
      writeFileSync(join(bin, t), text);
      chmodSync(join(bin, t), 0o755);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 실행 전 관문: 워크플로 run 본문이 쓰는 셸 문법·명령만 허용한다.
// - 따옴표 안 내용은 지우고 본다. 단 큰따옴표 안의 $( 와 백틱, ${! 간접 참조는 금지
// - 어디서든 금지: /proc, PPID, $$, BASHPID, 백틱
// - 리다이렉트(<, >) 금지. 절대 경로 인자는 /dev/null만
// - 명령 위치의 첫 단어는 허용 목록만 (if/then/else/fi 와 VAR=값 대입은 건너뜀)
const SAFE_COMMANDS = new Set(['echo', 'exit', 'curl', 'sed', 'head', '[', 'fi']);
function assertSafeBody(body) {
  const fail = (why) => { throw new Error(`실행 거부(${why})`); };
  if (/\/proc|PPID|\$\$|BASHPID|`/.test(body)) fail('/proc·PPID·$$·백틱');
  let t = body.replace(/\\\n/g, ' ').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  // 왼쪽부터 읽으며 따옴표 안 내용을 Q로 바꾼다 (작은따옴표 안은 그대로 문자, 큰따옴표 안은 치환 검사)
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\') { i++; out += '_'; continue; }
    if (c !== "'" && c !== '"') { out += c; continue; }
    let j = i + 1;
    let inner = '';
    while (j < t.length && t[j] !== c) {
      if (c === '"' && t[j] === '\\') { inner += t[j] + (t[j + 1] ?? ''); j += 2; continue; }
      inner += t[j++];
    }
    if (j >= t.length) fail('닫히지 않은 따옴표');
    if (c === '"' && /\$\(|\$\{!/.test(inner)) fail('따옴표 안 명령 치환·간접 참조');
    out += 'Q';
    i = j;
  }
  t = out;
  if (/\$\{!/.test(t)) fail('간접 참조');
  if (/[<>]/.test(t)) fail('리다이렉트');
  for (const w of t.split(/\s+/)) if (w.startsWith('/') && w !== '/dev/null') fail(`절대 경로 ${w}`);
  for (let seg of t.split(/\n|;|&&|\|\||\||\$\(|\(|\)/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    while (words.length && (/^(if|then|else|elif|!)$/.test(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words.shift();
    if (words.length && !SAFE_COMMANDS.has(words[0])) fail(`허용되지 않은 명령 ${words[0]}`);
  }
}

// 워크플로 본문 실행: 관문 통과 후에만 격리 환경에서 실행
function runStep(body, env, dir) {
  assertSafeBody(body);
  return runIsolated(body, env, dir);
}

// 격리 환경 실행 (관문 없음). 이 파일에 직접 쓴 고정 문자열(격리 자체 점검용)에만 쓴다
function runIsolated(body, env, dir) {
  const curlLog = join(dir, 'curl.log');
  const gitLog = join(dir, 'git.log');
  const toolLog = join(dir, 'tool.log');
  for (const f of [curlLog, gitLog, toolLog]) writeFileSync(f, '');
  const r = spawnSync(BASH, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', body], {
    encoding: 'utf8',
    cwd: join(dir, 'work'),
    env: { PATH: join(dir, 'bin'), CURL_LOG: curlLog, GIT_LOG: gitLog, TOOL_LOG: toolLog, ...env }, // process.env는 넘기지 않는다
  });
  const read = (f) => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  return { code: r.status, out: r.stdout + r.stderr, calls: read(curlLog), gitCalls: read(gitLog), toolCalls: read(toolLog) };
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

// ---------------------------------------------------------------------
// 격리 검사: 동작 시험이 실제 저장소·환경을 건드리지 못한다
// ---------------------------------------------------------------------
test('격리: 작업 폴더는 임시 폴더, 환경 변수는 시험 값만 (HOME·GIT_*·GH_*·GITHUB_* 없음)', () => withFakeCurl((dir) => {
  const r = runIsolated('pwd; compgen -e', {}, dir);
  assert.equal(r.code, 0, r.out);
  const [cwd, ...names] = r.out.trim().split('\n');
  assert.equal(cwd, join(dir, 'work'));
  const auto = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']); // bash가 스스로 만드는 것
  assert.deepEqual(names.filter((n) => !auto.has(n)).sort(), ['CURL_LOG', 'GIT_LOG', 'PATH', 'TOOL_LOG']);
}));

test('격리: curl·git은 가짜, 그 밖의 네트워크·실행 도구는 PATH에 없다', () => withFakeCurl((dir) => {
  const r = runIsolated([
    '[ "$(command -v curl)" = "' + join(dir, 'bin', 'curl') + '" ]',
    '[ "$(command -v git)" = "' + join(dir, 'bin', 'git') + '" ]',
    'for t in wget nc ncat ssh scp python3 python perl node gh; do if command -v "$t" >/dev/null; then echo "found $t"; exit 9; fi; done',
    'if git status; then exit 8; fi',
  ].join('\n'), {}, dir);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.gitCalls, ['status']);
}));

const REPO = fileURLToPath(new URL('..', import.meta.url));
function repoState() {
  const g = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' });
  return { head: g('rev-parse', 'HEAD'), reflog: g('reflog', '--format=%H').split('\n').length, status: g('status', '--porcelain') };
}

// 리뷰 PR #5의 우회 변형들: 관문이 실행 전에 막아야 한다
const ANCHOR = 'echo "keepalive RPC: HTTP $code"';
const ESCAPES = {
  'M8 git commit·push': 'git commit --allow-empty -m x && git push',
  'P1 /proc/$PPID/cwd + 절대 경로 git': 'cd "/proc/$PPID/cwd" && /usr/bin/git commit -q --allow-empty -m LEAK && /usr/bin/git push -q origin HEAD || true',
  'P2 부모 환경 읽기': "while IFS= read -r -d '' l; do echo \"$l\"; done < /proc/$PPID/environ || true",
  'P3 /usr/bin/env': '/usr/bin/env',
  '절대 경로 curl': '/usr/bin/curl -sS https://example.test',
  'cd': 'cd ..',
  'eval': 'eval "$KEY"',
  'exec': 'exec bash',
  'source': 'source x',
  '. (source)': '. ./x',
  '백틱': 'echo `id`',
  '따옴표 안 명령 치환': 'echo "$(id)"',
  '간접 참조 A6': 't=GH_; t="${t}TOKEN"; echo "${!t}"',
  '$$': 'echo $$',
  '파일 쓰기 리다이렉트': 'echo x > ../../leak',
  '함수 정의 뒤 실행': 'f() { :; }; f',
  'bash 재실행': 'bash -c true',
};

test('관문: 워크플로의 실제 본문 두 개는 통과한다', () => {
  assertSafeBody(pingBody);
  assertSafeBody(kaBody);
});

for (const [name, line] of Object.entries(ESCAPES)) {
  test(`관문: 우회 변형은 실행 전에 거부 (${name})`, () => withFakeCurl((dir) => {
    let before = null;
    try { before = repoState(); } catch { /* git 저장소가 아니면 상태 비교만 생략 */ }
    for (const mutated of [pingBody.replace(ANCHOR, () => `${ANCHOR}\n${line}`), `${pingBody}\n${line}\necho after`]) {
      assert.notEqual(mutated, pingBody);
      assert.throws(() => runStep(mutated, { URL: 'https://db.example.test', KEY: 'pk' }, dir), /실행 거부/);
    }
    assert.ok(!existsSync(join(dir, 'curl.log'))); // 실행 준비 전에 멈췄다
    if (before) assert.deepEqual(repoState(), before);
  }));
}

// 재검토 R1: 관문은 명령 이름만 본다 → 허용 명령(sed·head)의 인자로 파일 읽기·쓰기·명령 실행을 시도하는 변형.
// 관문은 통과하지만 가짜 sed·head가 워크플로와 다른 인자를 거부해야 한다
const ARG_ESCAPES = {
  'sed e 명령(명령 실행)': "echo x | sed 'e git push'",
  'sed w 명령(파일 쓰기)': "echo x | sed -n 'w ../leak'",
  'sed 파일 읽기': 'sed -n p ../../../etc/passwd',
  'sed -i(파일 수정)': "sed -i 's/a/b/' ../x",
  'head 파일 읽기': 'head -c 100 ../curl.log',
  'head 인자 추가': 'echo x | head -n 1 ../x',
};

test('가짜 sed·head: 워크플로와 같은 인자면 실제 도구 결과를 낸다', () => withFakeCurl((dir) => {
  const r = runIsolated(`printf '  "state": "active",\\n' | sed -n '${SED_SCRIPT}' | head -n 1`, {}, dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, 'active\n');
}));

for (const [name, line] of Object.entries(ARG_ESCAPES)) {
  test(`가짜 sed·head: 다른 인자는 거부 (${name})`, () => withFakeCurl((dir) => {
    assertSafeBody(line); // 관문은 통과하는 변형이다
    let before = null;
    try { before = repoState(); } catch { /* git 저장소가 아니면 상태 비교만 생략 */ }
    const r = runStep(line, {}, dir);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /fake (sed|head): 허용되지 않은 인자/);
    assert.equal(r.toolCalls.length, 1);
    assert.deepEqual(r.gitCalls, []);
    assert.ok(!existsSync(join(dir, 'leak')));
    if (before) assert.deepEqual(repoState(), before);
  }));
}
