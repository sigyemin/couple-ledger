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
//   글 검사 (CL-012 5번 — 파일이 아닌 글에도 같은 규칙: 비밀값·10자리 이상 숫자. .scan-allow는 적용하지 않는다)
//   node scripts/scan.mjs --text LABEL [FILE|-]  FILE(없거나 '-'면 표준입력)의 글 (.githooks/commit-msg: 커밋 메시지)
//   node scripts/scan.mjs --event FILE           GitHub 이벤트 JSON(GITHUB_EVENT_PATH)의 PR 제목·본문
//   node scripts/scan.mjs --commits BASE HEAD    BASE..HEAD 커밋들의 메시지(한 커밋씩)
//   글은 셸 인자로 넘기지 않는다(파일·표준입력·이벤트 파일로만 — 명령 삽입·길이 제한 방지)
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
import {
  hasSensitiveNumber, normalizeForCheck, removeKnownPatterns, RUN_SEPARATORS, MIN_SENSITIVE_DIGITS,
} from '../app/core/sensitive.js';

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
// 3) 민감번호 — 규칙은 app/core/sensitive.js 하나(DB has_sensitive_number와 같은 규칙).
//    앱 입력 검증과 이 검사가 같은 구현을 쓴다(구현 이중화 방지)
// ---------------------------------------------------------------------
export { hasSensitiveNumber };

// 저장소 파일에서만 쓰는 사전 처리: 개인정보가 아닌 식별자(UUID, 16진 해시·커밋 SHA)를 먼저 지운다.
// 예: 'c0000000-0000-0000-0000-000000000020'은 하이픈이 구분자라 숫자 덩어리로 보이지만 카테고리 id다.
// DB 함수에는 없는 단계다(DB의 검사 칸에는 UUID·해시가 들어가지 않는다).
// 우회 방지: 16진 글자는 숫자만으로도 채워지므로, 식별자와 그 앞뒤로 이어진 숫자·구분자까지 합쳐
// (날짜·시각·천 단위 금액은 뺀 뒤) 16진 글자에서 끊은 각 조각의 숫자가 10자리 이상이면 지우지 않는다.
// 단 0이 아닌 숫자가 4개 이하인 조각은 0으로 채운 고정 id로 보고 지운다
// (0으로 채운 테스트·시드 id. 10자리 이상 카드·계좌·전화번호에 0 아닌 숫자가 4개 이하일 가능성은 낮음 — 추정).
// 무작위 UUID·SHA도 드물게 숫자가 10자리 이상 이어져 걸릴 수 있다 → 오탐이면 PR에 사유를 적는다.
const RE_UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const RE_HEX = /(?<![0-9a-zA-Z])[0-9a-fA-F]{32,}(?![0-9a-zA-Z])/g;
const RE_RUN_CHAR = new RegExp(`[0-9${RUN_SEPARATORS}]`);
const RE_NOT_RUN = new RegExp(`[^0-9${RUN_SEPARATORS}]+`);

function hidesLongNumber(segment) {
  return removeKnownPatterns(segment).split(RE_NOT_RUN).some((piece) => {
    const d = piece.replace(/[^0-9]/g, '');
    const nonZero = d.replace(/0/g, '').length;
    return d.length >= MIN_SENSITIVE_DIGITS && nonZero > 4;
  });
}

function stripWithContext(line, re) {
  return line.replace(re, (m, offset, str) => {
    let s = offset;
    let e = offset + m.length;
    while (s > 0 && RE_RUN_CHAR.test(str[s - 1])) s--;
    while (e < str.length && RE_RUN_CHAR.test(str[e])) e++;
    return hidesLongNumber(str.slice(s, e)) ? m : ' ';
  });
}

export function stripIdentifiers(line) {
  return stripWithContext(stripWithContext(normalizeForCheck(line), RE_UUID), RE_HEX);
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

/**
 * 내용 검사용 문자열 목록으로 바꾼다. NUL 포함 파일(BOM 없음)은 null.
 * UTF-16 BOM(FF FE / FE FF)으로 시작하면 UTF-16으로 푼 것과 바이트 그대로(UTF-8) 읽은 것을 둘 다 검사한다
 * (BOM처럼 보이지만 UTF-16이 아닌 파일에서 숫자가 깨져 빠지지 않게).
 */
export function decodeTexts(buf) {
  const bom = buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
  if (bom) {
    const body = Buffer.from(buf.subarray(2, buf.length - (buf.length % 2))); // 홀수 길이면 끝 1바이트는 버린다
    if (buf[0] === 0xfe) body.swap16();
    return [body.toString('utf16le'), buf.subarray(2).toString('utf8').replace(/\0/g, '')];
  }
  if (buf.includes(0)) return null;
  return [buf.toString('utf8')];
}

/**
 * 글 검사(커밋 메시지·PR 제목·본문). 파일과 같은 규칙, 허용 목록 없음, JWT는 어디서든 막는다(config 밖)
 * 결과: [{ label, line, rule }] (찾은 값은 담지 않는다)
 */
export function checkText(label, text) {
  return checkContent(`<${label}>`, String(text ?? ''), []).map((f) => ({ label, ...f }));
}

/** GitHub pull_request 이벤트 JSON → 검사할 글 [label, text] */
export function eventTexts(json) {
  const pr = json?.pull_request ?? {};
  return [['pr_title', pr.title ?? ''], ['pr_body', pr.body ?? '']];
}

/** 이전 이름 호환: 첫 번째 해석만 */
export function decodeText(buf) {
  return decodeTexts(buf)?.[0] ?? null;
}

// ---------------------------------------------------------------------
// git 연동
// ---------------------------------------------------------------------
function git(args) {
  return execFileSync('git', args, { maxBuffer: 2 ** 26 }); // 64MB
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
  throw new Error('모드를 지정하세요: --staged | --range BASE HEAD | --all | --text LABEL [FILE] | --event FILE | --commits BASE HEAD');
}

function textJobs(mode, rest) {
  if (mode === '--text') {
    const [label, file] = rest;
    if (!label || !/^[a-z0-9_-]{1,40}$/.test(label)) throw new Error('--text LABEL [FILE] 가 필요합니다 (LABEL은 영소문자·숫자·_-)');
    return [[label, readFileSync(file && file !== '-' ? file : 0, 'utf8')]];
  }
  if (mode === '--event') {
    const [file] = rest;
    if (!file) throw new Error('--event FILE 가 필요합니다');
    return eventTexts(JSON.parse(readFileSync(file, 'utf8')));
  }
  if (mode === '--commits') {
    const [base, head] = rest;
    if (!base || !head) throw new Error('--commits BASE HEAD 가 필요합니다');
    const shas = git(['rev-list', `${base}..${head}`]).toString('utf8').split('\n').filter(Boolean);
    return shas.map((sha) => [`commit_${sha.slice(0, 7)}`, git(['log', '-1', '--format=%B', sha]).toString('utf8')]);
  }
  return null;
}

/** 글 검사 모드 실행. 값은 출력하지 않는다 */
function runText(jobs) {
  const problems = jobs.flatMap(([label, text]) => checkText(label, text)).map((f) => `${f.label}:${f.line}: ${f.rule}`);
  if (problems.length) {
    console.error(`유출 검사 실패 ${problems.length}건 (값은 출력하지 않음):`);
    for (const p of [...new Set(problems)]) console.error(`  ${p}`);
    console.error('커밋 메시지·PR 제목·본문에서 그 값을 빼 주세요. 오탐이면 PR에 사유를 적고 리뷰를 받으세요.');
    return 1;
  }
  console.log(`유출 검사 통과: 글 ${jobs.length}개`);
  return 0;
}

export function run(argv) {
  const args = [...argv];
  const jobs = textJobs(args[0], args.slice(1));
  if (jobs) return runText(jobs);
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
    const texts = decodeTexts(read(f));
    if (texts === null) {
      if (!BINARY_ALLOWED.some((re) => re.test(f.replace(/\\/g, '/')))) problems.push(`${f}: binary_file`);
      continue;
    }
    const seen = new Set();
    for (const text of texts) {
      for (const { line, rule } of checkContent(f, text, allowList)) {
        const p = `${f}:${line}: ${rule}`;
        if (!seen.has(p)) problems.push(p);
        seen.add(p);
      }
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
