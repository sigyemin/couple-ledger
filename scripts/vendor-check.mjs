#!/usr/bin/env node
// =====================================================================
// vendor/ 무결성 검사 (보안 리뷰 v0.1 9장)
// - vendor/integrity.json에 적힌 파일마다 sha256과 SRI(sha384)를 다시 계산해 대조한다
// - vendor/ 아래에 목록에 없는 파일이 있으면 실패한다(문서·목록 파일 제외)
// 사용법: node scripts/vendor-check.mjs   (단위 테스트 tests/vendor.test.mjs도 이 함수를 쓴다)
// 외부 패키지 없음.
// =====================================================================
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const NOT_LISTED_OK = new Set(['integrity.json', 'VERSIONS.md', '.gitkeep']);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** 문제 목록을 돌려준다(빈 배열 = 통과) */
export function checkVendor(vendorDir) {
  const problems = [];
  const list = JSON.parse(readFileSync(join(vendorDir, 'integrity.json'), 'utf8'));
  for (const [file, want] of Object.entries(list)) {
    let buf;
    try {
      buf = readFileSync(join(vendorDir, file));
    } catch {
      problems.push(`${file}: 파일 없음`);
      continue;
    }
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const sri = `sha384-${createHash('sha384').update(buf).digest('base64')}`;
    if (sha256 !== want.sha256) problems.push(`${file}: sha256 불일치`);
    if (sri !== want.sri) problems.push(`${file}: sha384 불일치`);
  }
  for (const p of walk(vendorDir)) {
    const rel = relative(vendorDir, p).split(sep).join('/');
    if (!NOT_LISTED_OK.has(rel) && !(rel in list)) problems.push(`${rel}: integrity.json에 없는 파일`);
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = fileURLToPath(new URL('../vendor', import.meta.url));
  const problems = checkVendor(dir);
  if (problems.length) {
    console.error(`vendor 검사 실패 ${problems.length}건:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
  } else {
    console.log('vendor 검사 통과');
  }
}
