#!/usr/bin/env node
// =====================================================================
// 공개 저장소 유출 검사 (위험 R4·R10, 보안 리뷰 v0.1 6장 1·2층)
//
// 사용법
//   node scripts/scan.mjs --staged            커밋 전: 스테이징된 파일 (.githooks/pre-commit)
//   node scripts/scan.mjs --range BASE HEAD   PR 검사: BASE..HEAD 사이에 바뀐 파일 (HEAD 시점 내용)
//   node scripts/scan.mjs --all               저장소의 모든 추적 파일 (작업 트리 내용)
//   --allow-file PATH                         .scan-allow 대신 이 파일을 허용 목록으로 쓴다
//                                             (PR 검사는 base 쪽 허용 목록을 넘긴다)
//
// 막는 것
//   1) 파일 종류: 엑셀·CSV·PDF·캡처 이미지·DB 덤프·.env·인증서 등 (.gitignore와 같은 목록)
//   2) 비밀값: Supabase secret 키(sb_secret_), 개인 키 블록, 비밀번호가 든 DB 접속 문자열,
//      JWT(역할이 anon이 아니면 금지, anon이어도 app/config.js 밖에서는 금지)
//   3) 카드·계좌·전화번호로 보이는 10자리 이상 숫자 덩어리
//      (schema.sql has_sensitive_number와 같은 규칙. .scan-allow에 적은 경로는 이 검사만 건너뜀)
//
// 출력에는 파일 경로·줄 번호·규칙 이름만 남기고 찾은 값은 절대 출력하지 않는다
// (PR 검사 로그는 공개 저장소에서 누구나 볼 수 있다).
// 사람 이름은 자동으로 찾을 수 없다 → 시험 데이터는 스크립트로 만든 가짜 이름만 쓴다(README).
// 외부 패키지 없음 (Node 20 이상 표준 모듈만).
// =====================================================================
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------
// 1) 파일 종류
// ---------------------------------------------------------------------
const BLOCKED_EXTENSIONS = new Set([
  'xlsx', 'xls', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods', 'pdf', 'zip', '7z',
  'html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic',
  'sql', 'gz', 'dump', 'backup', 'bak', 'enc',
  'pem', 'key', 'p12', 'pfx', 'har', 'log',
  // DB 파일, 웹 페이지 저장본, 금융 내보내기 형식, 문서 형식
  'db', 'sqlite', 'sqlite3', 'mhtml', 'mht', 'ofx', 'qif',
  'docx', 'doc', 'hwp', 'hwpx', 'numbers', 'rtf',
]);
const BLOCKED_DIRS = new Set(['dumps', 'exports', 'backups', 'samples', 'private', 'tmp', 'node_modules']);

// 예외로 허용하는 경로 (.gitignore의 ! 규칙과 같다)
const ALLOWED_PATHS = [
  /^index\.html$/,
  /^icons\/[^/]+\.png$/,
  /^db\/schema\.sql$/,
  /^db\/migrations\/[^/]+\.sql$/,
];

/** 경로 하나를 검사한다. 막아야 하면 규칙 이름, 아니면 null */
export function checkPath(path) {
  const p = path.replace(/\\/g, '/');
  if (ALLOWED_PATHS.some((re) => re.test(p))) return null;
  const parts = p.split('/');
  const name = parts[parts.length - 1].toLowerCase();
  if (parts.slice(0, -1).some((d) => BLOCKED_DIRS.has(d.toLowerCase()))) return 'blocked_dir';
  if (name === '.env' || name.startsWith('.env.')) return 'env_file';
  if (name.endsWith('.sql.gz')) return 'blocked_extension';
  const dot = name.lastIndexOf('.');
  if (dot > 0 && BLOCKED_EXTENSIONS.has(name.slice(dot + 1))) return 'blocked_extension';
  return null;
}

// ---------------------------------------------------------------------
// 3) 민감번호 — schema.sql has_sensitive_number(t)를 그대로 옮긴 것
//   0) NFKC 정규화
//   1) 날짜(2026-10-06 / 2026.10.06 / 2026/10/06), 시각(12:30, 12:30:45), 붙여 쓴 일시(12·14자리)를 지운다
//   2) 숫자와 구분자(공백 - . / _ ( ))로 이어진 덩어리의 숫자 개수가 10 이상이면 true
//   \d, \s 같은 약칭은 쓰지 않는다(엔진마다 뜻이 다름). DB 규칙이 바뀌면 여기도 같이 바꾼다.
//   (공통 컴포넌트 단계에서 app/core의 검증 모듈로 옮겨 이 스크립트가 그 모듈을 쓰게 한다)
// ---------------------------------------------------------------------
const RE_DATE = /(?<![0-9])(19|20)[0-9]{2}[-./][0-9]{1,2}[-./][0-9]{1,2}(?![0-9])/g;
const RE_TIME = /(?<![0-9])[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?(?![0-9])/g;
const RE_PACKED_DATETIME =
  /(?<![0-9])(19|20)[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])([01][0-9]|2[0-3])[0-5][0-9]([0-5][0-9])?(?![0-9])/g;
const RE_DIGIT_RUN = /[0-9](?:[0-9 ./_()-]*[0-9])?/g;

export function hasSensitiveNumber(t) {
  if (t == null) return false;
  let s = String(t).normalize('NFKC');
  s = s.replace(RE_DATE, ' ').replace(RE_TIME, ' ').replace(RE_PACKED_DATETIME, ' ');
  for (const tok of s.match(RE_DIGIT_RUN) ?? []) {
    if (tok.replace(/[^0-9]/g, '').length >= 10) return true;
  }
  return false;
}

// 저장소 파일에서만 쓰는 사전 처리: 개인정보가 아닌 식별자(UUID, 16진 해시·커밋 SHA)를 먼저 지운다.
// 예: 'c0000000-0000-0000-0000-000000000020'은 하이픈이 구분자라 숫자 덩어리로 보이지만 카테고리 id다.
// DB 함수에는 없는 단계다(DB의 검사 칸에는 UUID·해시가 들어가지 않는다).
// 우회 방지: 16진 글자는 숫자만으로도 채워지므로, 하이픈을 뺀 덩어리 안에 숫자가 10자리 이상
// 이어지면 지우지 않는다. 단 0이 4개 이상 이어진 곳은 끊긴 것으로 본다(위 예처럼 0으로 채운 고정 id).
// 무작위 UUID·SHA도 드물게 숫자가 10자리 이상 이어져 걸릴 수 있다 → 오탐이면 PR에 사유를 적는다.
const RE_UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const RE_HEX = /(?<![0-9a-zA-Z])[0-9a-fA-F]{32,}(?![0-9a-zA-Z])/g;

function hidesLongNumber(m) {
  return m.replace(/-/g, '').replace(/0{4,}/g, ' ').split(/[^0-9]+/).some((run) => run.length >= 10);
}

export function stripIdentifiers(line) {
  const strip = (m) => (hidesLongNumber(m) ? m : ' ');
  return line.replace(RE_UUID, strip).replace(RE_HEX, strip);
}

// ---------------------------------------------------------------------
// 2) 비밀값
// ---------------------------------------------------------------------
const RE_SB_SECRET = /sb_secret_[A-Za-z0-9_-]{8,}/;
const RE_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const RE_DB_URL_PASSWORD = /postgres(?:ql)?:\/\/[^\s:/@]+:[^\s@]+@/i;
const RE_JWT = /eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g;
const JWT_ALLOWED_PATH = 'app/config.js';

function jwtRole(payloadB64) {
  try {
    const json = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const role = JSON.parse(json).role;
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// 내용 검사
// ---------------------------------------------------------------------
export function loadAllowList(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/\\/g, '/'));
}

function isAllowedForNumbers(path, allowList) {
  return allowList.some((a) => (a.endsWith('/') ? path.startsWith(a) : path === a));
}

/** 파일 내용 검사. 결과: [{ line, rule }] (찾은 값은 담지 않는다) */
export function checkContent(path, text, allowList = []) {
  const p = path.replace(/\\/g, '/');
  const findings = [];
  const skipNumbers = isAllowedForNumbers(p, allowList);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const n = i + 1;
    if (RE_SB_SECRET.test(line)) findings.push({ line: n, rule: 'supabase_secret_key' });
    if (RE_PRIVATE_KEY.test(line)) findings.push({ line: n, rule: 'private_key' });
    if (RE_DB_URL_PASSWORD.test(line)) findings.push({ line: n, rule: 'db_url_with_password' });
    for (const m of line.matchAll(RE_JWT)) {
      const role = jwtRole(m[1]);
      if (role !== 'anon') findings.push({ line: n, rule: 'jwt_not_anon' });
      else if (p !== JWT_ALLOWED_PATH) findings.push({ line: n, rule: 'jwt_outside_config' });
    }
    if (!skipNumbers && hasSensitiveNumber(stripIdentifiers(line))) {
      findings.push({ line: n, rule: 'sensitive_number' });
    }
  });
  return findings;
}

// NUL 바이트가 있는 파일은 내용 검사를 할 수 없으므로 아래 경로 밖에서는 막는다.
// (ALLOWED_PATHS의 아이콘 PNG, 외부 라이브러리 폴더)
const BINARY_ALLOWED = [/^icons\/[^/]+\.png$/, /^vendor\//];

/** 내용 검사용 문자열로 바꾼다. UTF-16(BOM 있음)은 풀어서 검사하고, 그 밖의 NUL 포함 파일은 null */
export function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.subarray(2, buf.length - (buf.length % 2)); // 홀수 길이면 끝 1바이트는 버린다
    return Buffer.from(body).swap16().toString('utf16le');
  }
  if (buf.includes(0)) return null;
  return buf.toString('utf8');
}

// ---------------------------------------------------------------------
// git 연동
// ---------------------------------------------------------------------
function git(args) {
  return execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
}
function splitZ(buf) {
  return buf.toString('utf8').split('\0').filter(Boolean);
}

function collect(mode, args) {
  if (mode === '--staged') {
    return {
      files: splitZ(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])),
      read: (f) => git(['show', `:${f}`]),
    };
  }
  if (mode === '--range') {
    const [base, head] = args;
    if (!base || !head) throw new Error('--range BASE HEAD 가 필요합니다');
    return {
      // 세 점(...) = 공통 조상 기준. main이 그사이 앞서 나가도 PR에서 바뀐 파일만 본다
      files: splitZ(git(['diff', '--name-only', '--diff-filter=ACMR', '-z', `${base}...${head}`])),
      read: (f) => git(['show', `${head}:${f}`]),
    };
  }
  if (mode === '--all') {
    return { files: splitZ(git(['ls-files', '-z'])), read: (f) => readFileSync(f) };
  }
  throw new Error('모드를 지정하세요: --staged | --range BASE HEAD | --all');
}

export function run(argv) {
  const args = [...argv];
  let allowFile = '.scan-allow';
  const ai = args.indexOf('--allow-file');
  if (ai !== -1) {
    allowFile = args[ai + 1];
    if (!allowFile) throw new Error('--allow-file PATH 가 필요합니다');
    args.splice(ai, 2);
  }
  const [mode, ...rest] = args;
  const { files, read } = collect(mode, rest);
  const allowList = existsSync(allowFile) ? loadAllowList(readFileSync(allowFile, 'utf8')) : [];
  const problems = [];
  for (const f of files) {
    const pathRule = checkPath(f);
    if (pathRule) {
      problems.push(`${f}: ${pathRule}`);
      continue;
    }
    const text = decodeText(read(f));
    if (text === null) {
      if (!BINARY_ALLOWED.some((re) => re.test(f.replace(/\\/g, '/')))) problems.push(`${f}: binary_file`);
      continue;
    }
    for (const { line, rule } of checkContent(f, text, allowList)) {
      problems.push(`${f}:${line}: ${rule}`);
    }
  }
  if (problems.length) {
    console.error(`유출 검사 실패 ${problems.length}건 (값은 출력하지 않음):`);
    for (const p of problems) console.error(`  ${p}`);
    console.error('실데이터·비밀값이면 파일에서 빼고 다시 커밋하세요. 오탐이면 PR에 사유를 적고 리뷰를 받으세요.');
    return 1;
  }
  console.log(`유출 검사 통과: 파일 ${files.length}개`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
