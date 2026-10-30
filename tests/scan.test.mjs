// scripts/scan.mjs 단위 테스트 (node --test)
// 숫자·키 값은 모두 실행 중에 만든 가짜 값이다. 이 파일 자체가 유출 검사를 통과해야 하므로
// 10자리 이상 숫자나 키 모양 문자열을 소스에 그대로 쓰지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPath, checkContent, hasSensitiveNumber, stripIdentifiers, loadAllowList, decodeText, decodeTexts } from '../scripts/scan.mjs';

const digits = (n, start = 1) => Array.from({ length: n }, (_, i) => String((start + i) % 10)).join('');
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const fakeJwt = (role) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ iss: 'test', role, ref: 'fakeref00' })}.${'s'.repeat(20)}`;

// ---------------------------------------------------------------- 파일 종류
test('막는 파일 종류', () => {
  for (const p of ['a.xlsx', 'x/b.XLS', 'c.csv', 'd.pdf', 'e.png', 'f.html', 'dump.sql', 'db/old.sql',
                   'backup.sql.gz', '.env', '.env.local', 'cert.pem', 'net.har', 'samples/readme.md',
                   'x/exports/a.json', 'bank.htm', 'ledger.db', 'a.sqlite', 'a.sqlite3', 'page.mhtml',
                   'page.mht', 'bank.ofx', 'bank.qif', 'a.docx', 'a.doc', 'a.hwp', 'a.hwpx', 'a.numbers', 'a.rtf']) {
    assert.notEqual(checkPath(p), null, p);
  }
});

test('허용 경로', () => {
  for (const p of ['index.html', 'icons/icon-192.png', 'db/schema.sql', 'db/migrations/001_init.sql',
                   'README.md', 'app/main.js', 'scripts/scan.mjs', 'tests/sensitive-cases.json', '.gitignore']) {
    assert.equal(checkPath(p), null, p);
  }
});

test('예외 경로를 벗어나면 막는다', () => {
  assert.notEqual(checkPath('app/index.html'), null);
  assert.notEqual(checkPath('icons/sub/a.png'), null);
  assert.notEqual(checkPath('db/migrations/sub/a.sql'), null);
  assert.notEqual(checkPath('schema.sql'), null);
});

// ---------------------------------------------------------------- 민감번호 (schema.sql has_sensitive_number와 같은 규칙)
test('날짜·시각은 걸리지 않는다', () => {
  for (const s of ['2026-10-06', '2026.10.06 12:30:45', '2026/10/06 12:30', '2026-10-06 12:30:45 결제',
                   'packed 202610061230', 'packed 20261006123045', '금액 1,234,567원', '버전 0.20.3']) {
    assert.equal(hasSensitiveNumber(s), false, s);
  }
});

test('10자리 이상 숫자 덩어리는 걸린다', () => {
  const d = digits(16);
  const cases = [
    d,
    `${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8, 12)}-${d.slice(12)}`,   // 카드번호 모양
    `${d.slice(0, 3)} ${d.slice(3, 7)} ${d.slice(7, 11)}`,                  // 전화번호 모양(공백)
    `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 12)}`,                  // 점 구분
    `(${d.slice(0, 3)})${d.slice(3, 6)}/${d.slice(6, 12)}`,                 // 괄호·슬래시
    `${d.slice(0, 5)}_${d.slice(5, 10)}`,                                    // 밑줄
    digits(10),
  ];
  for (const s of cases) assert.equal(hasSensitiveNumber(`이체 ${s} 메모`), true);
});

test('9자리는 통과, 10자리는 걸림 (경계)', () => {
  assert.equal(hasSensitiveNumber(digits(9)), false);
  assert.equal(hasSensitiveNumber(digits(10)), true);
});

test('전각 숫자도 NFKC로 바꿔 검사한다', () => {
  const full = [...digits(12)].map((c) => String.fromCharCode(0xff10 + Number(c))).join('');
  assert.equal(hasSensitiveNumber(full), true);
});

test('날짜 바로 뒤에 붙은 긴 숫자는 날짜가 지워진 뒤에도 걸린다', () => {
  assert.equal(hasSensitiveNumber(`2026-10-06 ${digits(12)}`), true);
});

test('UUID·16진 해시는 저장소 검사에서 제외한다', () => {
  const uuid = 'c0000000-0000-0000-0000-000000000020';
  const hex = 'e7e58c8d5e4dc8ec7cd9e38cbac82df818a496e2';  // 커밋 SHA 모양(숫자가 길게 이어지지 않음)
  assert.equal(hasSensitiveNumber(uuid), true);              // DB 규칙 그대로면 걸리지만
  assert.equal(hasSensitiveNumber(stripIdentifiers(uuid)), false);  // 저장소 검사는 식별자를 먼저 지운다
  assert.equal(hasSensitiveNumber(stripIdentifiers(hex)), false);
  assert.equal(checkContent('db/schema.sql', `('${uuid}', '식비')`).length, 0);
});

test('UUID·16진 모양 안에 숨긴 10자리 이상 숫자는 지우지 않고 걸어낸다', () => {
  const d = digits(32);
  const uuidOf = (x) => `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
  const cases = [
    uuidOf(d),                                        // 숫자로만 채운 UUID 모양
    `${digits(13)} ${uuidOf(digits(32, 5))}`,         // 13자리 숫자 + 숫자로 채운 UUID 모양
    digits(40),                                       // 숫자만 32자 이상
    `abcd${digits(16)}${'ef'.repeat(8)}`,             // 16진 글자 + 16자리 숫자 + 16진 글자
    `${'ab'.repeat(11)}${digits(11)}${'cd'.repeat(6)}`, // 16진 글자 + 11자리 숫자 + 16진 글자
  ];
  for (const s of cases) {
    assert.equal(checkContent('app/x.js', `const v = '${s}';`).length, 1, s);
  }
});

test('BOM 있는 UTF-16 텍스트는 풀어서 검사하고, 그 밖의 NUL 포함 파일은 null', () => {
  const text = `날짜,금액,메모\n2026-10-06,1000,${digits(16)}\n`;
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
  assert.equal(decodeText(le), text);
  assert.equal(decodeText(be), text);
  assert.equal(checkContent('data.txt', decodeText(le)).length, 1);
  assert.equal(decodeText(Buffer.from('SQLite format 3\0abc', 'latin1')), null);
  assert.equal(decodeText(Buffer.from('보통 텍스트', 'utf8')), '보통 텍스트');
});

// ---------------------------------------------------------------- 비밀값
test('Supabase secret 키는 막는다', () => {
  const r = checkContent('app/config.js', `const k = 'sb_${'secret'}_${'a'.repeat(30)}';`);
  assert.deepEqual(r.map((x) => x.rule), ['supabase_secret_key']);
});

test('publishable 키는 통과', () => {
  const r = checkContent('app/config.js', `const k = 'sb_publishable_${'a'.repeat(30)}';`);
  assert.equal(r.length, 0);
});

test('anon JWT는 app/config.js에서만 허용', () => {
  assert.equal(checkContent('app/config.js', `key: '${fakeJwt('anon')}'`).length, 0);
  assert.deepEqual(checkContent('app/main.js', `key: '${fakeJwt('anon')}'`).map((x) => x.rule), ['jwt_outside_config']);
});

test('service_role JWT는 어디서든 막는다', () => {
  assert.deepEqual(checkContent('app/config.js', `key: '${fakeJwt('service_role')}'`).map((x) => x.rule), ['jwt_not_anon']);
});

test('개인 키 블록·비밀번호 든 DB 주소는 막는다', () => {
  const pk = `-----BEGIN ${'PRIVATE'} KEY-----`;
  const url = `${'postgresql'}://postgres:${'pw'}x@db.example.supabase.co:5432/postgres`;
  assert.deepEqual(checkContent('docs/a.md', pk).map((x) => x.rule), ['private_key']);
  assert.deepEqual(checkContent('docs/a.md', url).map((x) => x.rule), ['db_url_with_password']);
});

test('결과에 찾은 값을 담지 않는다', () => {
  const secret = `sb_${'secret'}_${'z'.repeat(30)}`;
  const r = checkContent('a.js', `x = '${secret}'`);
  assert.ok(!JSON.stringify(r).includes('zzzz'));
  assert.deepEqual(Object.keys(r[0]).sort(), ['line', 'rule']);
});

test('줄 번호를 정확히 알려준다', () => {
  const r = checkContent('a.md', ['첫 줄', '둘째 줄', `셋째 ${digits(12)}`].join('\n'));
  assert.deepEqual(r, [{ line: 3, rule: 'sensitive_number' }]);
});

// ---------------------------------------------------------------- 허용 목록
test('.scan-allow 경로는 숫자 검사만 건너뛴다', () => {
  const allow = loadAllowList('# 주석\nvendor/\ntests/sensitive-cases.json\n');
  assert.deepEqual(allow, ['vendor/', 'tests/sensitive-cases.json']);
  assert.equal(checkContent('vendor/x.mjs', digits(16), allow).length, 0);
  assert.equal(checkContent('tests/sensitive-cases.json', digits(16), allow).length, 0);
  assert.equal(checkContent('tests/other.json', digits(16), allow).length, 1);
  // 비밀값 검사는 허용 목록과 무관
  assert.equal(checkContent('vendor/x.mjs', `sb_${'secret'}_${'a'.repeat(30)}`, allow).length, 1);
});

// ---------------------------------------------------------------- 리뷰 후속 (CL-012 A·B)
test('0000이 든 숫자나 식별자 경계에 걸친 숫자도 지우지 않는다 (A)', () => {
  const uuidOf = (x) => `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
  const card = `1234${'0'.repeat(4)}${digits(8, 5)}`; // 16자리, 가운데 0000
  const cases = [
    uuidOf(`${card}${'a'.repeat(16)}`),                 // 0000 든 카드번호를 UUID 모양 안에
    `${'ab'.repeat(4)}${card}${'cd'.repeat(8)}`,         // 0000 든 카드번호를 16진 덩어리 안에
    `${digits(6)} ${digits(6, 3)}${'ef'.repeat(15)}`,   // 공백 앞은 밖, 뒤는 16진 덩어리 안
    `${digits(6)}-${uuidOf(`${digits(6, 3)}${'a'.repeat(26)}`)}`, // 하이픈 앞은 밖, 뒤는 UUID 안
  ];
  // 0이 절반 넘는 13자리(0 아닌 숫자 6개)를 UUID 모양에 넣은 것
  const zeroish = `1${'0'.repeat(3)}23${'0'.repeat(4)}456`;
  cases.push(uuidOf(`${zeroish}${'b'.repeat(19)}`));
  for (const s of cases) assert.equal(checkContent('app/x.js', `v = '${s}';`).length, 1, s);
  // 0으로 채운 고정 id·평범한 SHA·날짜 옆 SHA는 여전히 제외
  for (const s of ['c0000000-0000-0000-0000-000000000020', 'e7e58c8d5e4dc8ec7cd9e38cbac82df818a496e2',
                   '2026-10-29 e7e58c8d5e4dc8ec7cd9e38cbac82df818a496e2']) {
    assert.equal(checkContent('app/x.js', `v = '${s}';`).length, 0, s);
  }
});

test('FF FE로 시작하지만 UTF-16이 아닌 파일도 숫자를 찾는다 (B)', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`memo ${digits(16)}\n`, 'utf8')]);
  const texts = decodeTexts(buf);
  assert.equal(texts.length, 2);
  assert.ok(texts.some((t) => checkContent('a.txt', t).length === 1));
  assert.equal(decodeTexts(Buffer.from('SQLite format 3\0', 'latin1')), null);
  assert.deepEqual(decodeTexts(Buffer.from('abc')), ['abc']);
});

// ---------------------------------------------------------------- 글 검사 (CL-012 5번: 커밋 메시지·PR 제목·본문)
import { checkText, eventTexts } from '../scripts/scan.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCAN = new URL('../scripts/scan.mjs', import.meta.url).pathname;

test('글 검사: 같은 규칙(숫자·비밀값), 줄 번호·이름만, 허용 목록 없음, 식별자는 통과', () => {
  const clean = ['fix(upload): 2,000건 상한', 'head 9f9a61e · main 6b841ab', 'id a0000000-0000-4000-8000-000000000001', '2026-10-30 09:41'].join('\n');
  assert.deepEqual(checkText('pr_body', clean), []);
  const bad = checkText('commit_abc1234', `첫 줄\n번호 ${digits(12)}\nsb_secret_${'x'.repeat(12)}`);
  assert.deepEqual(bad, [{ label: 'commit_abc1234', line: 2, rule: 'sensitive_number' }, { label: 'commit_abc1234', line: 3, rule: 'supabase_secret_key' }]);
  assert.ok(!JSON.stringify(bad).includes(digits(12)));
  assert.deepEqual(checkText('pr_body', fakeJwt('anon')).map((f) => f.rule), ['jwt_outside_config']); // 글에서는 anon JWT도 막는다
  assert.deepEqual(checkText('x', null), []);
});

test('글 검사: 줄이 나뉜 번호는 이어 붙여 한 번 더(줄 0, sensitive_number_joined), 백틱으로 끊어도 걸림, 줄에서 이미 걸리면 중복 없음', () => {
  const n = digits(12);
  assert.deepEqual(checkText('pr_body', `번호 ${n.slice(0, 6)}\n${n.slice(6)} 끝`), [{ label: 'pr_body', line: 0, rule: 'sensitive_number_joined' }]);
  assert.deepEqual(checkText('pr_body', `\`${n.slice(0, 5)}\`\`${n.slice(5)}\``).map((f) => f.rule), ['sensitive_number_joined']);
  assert.deepEqual(checkText('pr_body', `x ${n}\ny`).map((f) => f.rule), ['sensitive_number']);
  assert.deepEqual(checkText('pr_body', '합계 2,000건\n2026-10-30 기준\nhead 74b7bfd'), []); // 날짜·짧은 숫자는 이어 붙여도 통과
  assert.deepEqual(checkText('pr_body', '  - 10-31T14:59Z → 2026-10\n  - 10-31T15:00Z → 2026-10\n  - 2027-01-01T00:30 → 2026-12'), []); // 목록 줄끼리는 안 붙임
  assert.deepEqual(checkText('pr_body', `a ${n.slice(0, 6)}\`\n\`${n.slice(6)}`).map((f) => f.rule), ['sensitive_number_joined']);
});

test('--modes: 글 검사 모드 목록', () => {
  const r = spawnSync(process.execPath, [SCAN, '--modes'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.trim().split('\n'), ['text', 'event', 'commits']);
});

test('이벤트 JSON에서 PR 제목·본문, 없는 칸은 빈 글', () => {
  assert.deepEqual(eventTexts({ pull_request: { title: 't', body: null } }), [['pr_title', 't'], ['pr_body', '']]);
  assert.deepEqual(eventTexts({}), [['pr_title', ''], ['pr_body', '']]);
});

test('명령줄: --text 파일·--event·--commits — 걸리면 종료 코드 1, 출력에 값 없음 (임시 폴더·임시 git 저장소)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-text-'));
  try {
    const secret = digits(13, 3);
    const run = (args) => spawnSync(process.execPath, [SCAN, ...args], { cwd: dir, encoding: 'utf8' });
    writeFileSync(join(dir, 'ok.txt'), 'feat: 화면 추가\n');
    writeFileSync(join(dir, 'bad.txt'), `feat: 화면\n\n번호 ${secret}\n`);
    assert.equal(run(['--text', 'commit_msg', join(dir, 'ok.txt')]).status, 0);
    const bad = run(['--text', 'commit_msg', join(dir, 'bad.txt')]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /commit_msg:3: sensitive_number/);
    assert.ok(!bad.stderr.includes(secret) && !bad.stdout.includes(secret));
    assert.equal(run(['--text', 'Bad Label', join(dir, 'ok.txt')]).status, 2); // 이름 형식이 틀리면 실행 오류

    writeFileSync(join(dir, 'event.json'), JSON.stringify({ pull_request: { title: 'feat: 규칙', body: `본문\n${secret}` } }));
    const ev = run(['--event', join(dir, 'event.json')]);
    assert.equal(ev.status, 1);
    assert.match(ev.stderr, /pr_body:2: sensitive_number/);
    assert.ok(!ev.stderr.includes(secret));

    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'base');
    const base = git('rev-parse', 'HEAD').toString().trim();
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'ok commit');
    assert.equal(run(['--commits', base, 'HEAD']).status, 0);
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '--no-verify', '-m', `bad ${secret}`);
    const cm = run(['--commits', base, 'HEAD']);
    assert.equal(cm.status, 1);
    assert.match(cm.stderr, /commit_[0-9a-f]{7}:1: sensitive_number/);
    assert.ok(!cm.stderr.includes(secret));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
