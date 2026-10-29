// scripts/scan.mjs 단위 테스트 (node --test)
// 숫자·키 값은 모두 실행 중에 만든 가짜 값이다. 이 파일 자체가 유출 검사를 통과해야 하므로
// 10자리 이상 숫자나 키 모양 문자열을 소스에 그대로 쓰지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPath, checkContent, hasSensitiveNumber, stripIdentifiers, loadAllowList } from '../scripts/scan.mjs';

const digits = (n, start = 1) => Array.from({ length: n }, (_, i) => String((start + i) % 10)).join('');
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const fakeJwt = (role) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ iss: 'test', role, ref: 'fakeref00' })}.${'s'.repeat(20)}`;

// ---------------------------------------------------------------- 파일 종류
test('막는 파일 종류', () => {
  for (const p of ['a.xlsx', 'x/b.XLS', 'c.csv', 'd.pdf', 'e.png', 'f.html', 'dump.sql', 'db/old.sql',
                   'backup.sql.gz', '.env', '.env.local', 'cert.pem', 'net.har', 'samples/readme.md',
                   'x/exports/a.json', 'bank.htm']) {
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
  const hex = '0'.repeat(40) + '1'.repeat(24);
  assert.equal(hasSensitiveNumber(uuid), true);              // DB 규칙 그대로면 걸리지만
  assert.equal(hasSensitiveNumber(stripIdentifiers(uuid)), false);  // 저장소 검사는 식별자를 먼저 지운다
  assert.equal(hasSensitiveNumber(stripIdentifiers(hex)), false);
  assert.equal(checkContent('db/schema.sql', `('${uuid}', '식비')`).length, 0);
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
