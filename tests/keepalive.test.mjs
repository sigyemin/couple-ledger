// keepalive 워크플로 정적 검사 (외부 패키지 없음: YAML 파서 대신 줄 단위로 본다)
// - 권한 최소화, 외부 액션·checkout 없음, run 안에 ${{ }} 직접 삽입 없음, secret 키 미사용
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../.github/workflows/keepalive.yml', import.meta.url), 'utf8');
const lines = src.split('\n');
const code = lines.filter((l) => !/^\s*#/.test(l)).join('\n'); // 주석 줄 제외

// run: | 블록의 줄들(들여쓰기가 run: 보다 깊은 줄)
function runBlocks() {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?run:\s*\|?\s*$/);
    if (!m) continue;
    const indent = lines[i].search(/\S/);
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() !== '' && lines[j].search(/\S/) <= indent) break;
      body.push(lines[j]);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

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

test('최상위 권한은 비어 있고 쓰기 권한은 actions: write 하나뿐', () => {
  assert.match(src, /^permissions: \{\}$/m);
  const writes = [...src.matchAll(/^\s+([a-z-]+):\s*write\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(writes, ['actions']);
  assert.ok(!/write-all|contents:\s*write/.test(src));
});

test('외부 액션·checkout을 쓰지 않는다', () => {
  assert.ok(!/^\s*-?\s*uses:/m.test(src));
});

test('run 안에 ${{ }}를 직접 넣지 않는다 (env로만)', () => {
  const blocks = runBlocks();
  assert.equal(blocks.length, 2);
  for (const b of blocks) assert.ok(!b.includes('${{'), b);
});

test('Supabase 값은 vars에서만, secret 키·비밀은 쓰지 않는다', () => {
  assert.ok(!/secrets\./.test(code));
  assert.ok(!/service_role|sb_secret_/i.test(code));
  assert.match(src, /URL: \$\{\{ vars\.SUPABASE_URL \}\}/);
  assert.match(src, /KEY: \$\{\{ vars\.SUPABASE_PUBLISHABLE_KEY \}\}/);
});

test('변수가 비면 건너뛰고 성공 종료', () => {
  const ping = runBlocks()[0];
  assert.match(ping, /if \[ -z "\$URL" \] \|\| \[ -z "\$KEY" \]; then[\s\S]*?건너뜀[\s\S]*?exit 0/);
});

test('keep-active는 이 워크플로의 enable API를 호출한다', () => {
  assert.match(src, /WORKFLOW_FILE: keepalive\.yml/);
  assert.match(runBlocks()[1], /-X PUT[\s\S]*"\$api\/enable"/);
});
