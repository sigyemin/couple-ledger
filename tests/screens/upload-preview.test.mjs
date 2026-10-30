// 올리기 미리보기 개선 (CL-069) — 합성 파일·가짜 이름만
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diagnoseFormats } from '../../app/import/formats.js';
import { detectFormats } from '../../app/import/pipeline.js';
import { nomatchLines, decisionCount, laterSummary, headParts, formatName } from '../../app/screens/upload-model.js';
import { XLSX, FORMAT_A, FORMAT_B, FORMAT_C, bookBytes } from '../import/fixtures.mjs';

const src = (p) => readFileSync(new URL(`../../app/${p}`, import.meta.url), 'utf8');
const SECRET = '가상식당비밀값';

test('진단: 같은 파일 종류 형식마다 가장 많이 맞은 머리글 수·못 찾은 머리글(형식 쪽 이름만, 셀 값 없음)', () => {
  const heads = Object.values(FORMAT_B.column_map);
  const grid = [['안내', SECRET], [...heads.slice(0, 3), '엉뚱한머리글'], [SECRET, '12,000']];
  const d = diagnoseFormats(grid, [FORMAT_A, FORMAT_B, FORMAT_C], 'xls');
  assert.equal(d.fileType, 'xls');
  const b = d.sameType.find((x) => x.formatId === FORMAT_B.id);
  assert.deepEqual([b.matched, b.total, b.missing], [3, heads.length, heads.slice(3)]);
  assert.deepEqual(d.otherTypes.map((o) => o.formatId), [FORMAT_C.id], 'xls를 안 받는 형식');
  assert.equal(d.sameType[0].formatId, FORMAT_B.id, '많이 맞은 순');
  const json = JSON.stringify(d);
  assert.ok(!json.includes(SECRET) && !json.includes('엉뚱한머리글') && !json.includes('12,000'), '파일 셀 값이 진단에 없음');
});

test('판별: 맞으면 진단 없음, 못 맞으면 진단(형식 쪽 이름만)', () => {
  const ok = detectFormats(XLSX, bookBytes([Object.values(FORMAT_B.column_map), ['x']], 'xls'), [FORMAT_B]);
  assert.deepEqual(ok, { fileType: 'xls', formatIds: [FORMAT_B.id] });
  const no = detectFormats(XLSX, bookBytes([[SECRET, '아무거나'], ['1', '2']], 'xls'), [FORMAT_B, FORMAT_C]);
  assert.deepEqual(no.formatIds, []);
  assert.equal(no.diagnosis.sameType[0].matched, 0);
  assert.ok(!JSON.stringify(no).includes(SECRET));
});

test('진단 줄: 가장 비슷한 형식·맞은 수·못 찾은 머리글 / 파일 종류가 달라 후보 없음 / 형식은 맞는데 켜진 결제수단 없음', () => {
  const formats = [FORMAT_A, FORMAT_B, FORMAT_C];
  const best = nomatchLines({ fileType: 'xls', formatIds: [], diagnosis: { sameType: [{ formatId: FORMAT_B.id, matched: 5, total: 8, missing: ['가게', '할부'], sensitive: false }], otherTypes: [] } }, formats, []);
  assert.deepEqual(best, ['파일 종류: xls', `가장 비슷한 형식: ${formatName(FORMAT_B)} — 머리글 8개 중 5개 맞음`, '못 찾은 머리글: 가게, 할부']);
  const html = nomatchLines({ fileType: 'html', formatIds: [], diagnosis: { sameType: [], otherTypes: [{ formatId: FORMAT_B.id, fileTypes: ['xls'] }] } }, formats, []);
  assert.equal(html[1], `이 파일은 html이에요 — ${formatName(FORMAT_B)}은 xls만 받아요.`);
  const off = nomatchLines({ fileType: 'xls', formatIds: [FORMAT_B.id] }, formats, [{ import_format_id: FORMAT_B.id, is_active: false }]);
  assert.match(off[1], /켜진 결제수단이 없어요\. 꺼진 결제수단을 켜면/);
  assert.equal(formatName(FORMAT_B), '가상기관B 카드 형식');
});

test('결정 수·요약·머리 한 줄', () => {
  const card = (choice, ruleAllowed = true) => ({ g: { ruleAllowed }, choice });
  const f = { state: 'ready', cards: [card('later'), card('later'), card('expense'), card('later', false)], preview: { newCount: 36, spendText: '343,800원' } };
  assert.equal(decisionCount(f), 2, '규칙을 못 만드는 짧은 이름은 결정할 것에서 뺌');
  assert.equal(decisionCount({ state: 'choose', choices: [] }), 1);
  assert.equal(laterSummary([f]), '결정 안 한 이체 상대 3개는 검토 대기로 들어가요.');
  assert.equal(laterSummary([{ state: 'ready', cards: [card('saving')] }]), '');
  assert.deepEqual(headParts(f, '시험통장'), ['시험통장', '새로 36건', '지출 343,800원']);
});

test('화면 소스: 카드는 한 번 만들고 고침(목록 전체 다시 그리기 없음), 이체 상대 한 줄, 아래 붙은 저장, 셀 값 기록 없음', () => {
  const u = src('screens/upload.js');
  assert.doesNotMatch(u, /list\.replaceChildren\(\.\.\.files\.map\(fileCard\)\)/);
  assert.match(u, /if \(sections\.length !== list\.children\.length \|\| sections\.some\(\(el, i\) => list\.children\[i\] !== el\)\) list\.replaceChildren\(\.\.\.sections\);/);
  assert.match(u, /if \(f\.cards\?\.length && !f\.cardsBuilt\)/, '이체 상대 줄은 한 번만 넣음');
  assert.doesNotMatch(u, /choiceCard/);
  assert.match(u, /cpRow\(\{ g, categories \}, doc\)/);
  assert.match(u, /class: 'upload-savebar'/);
  assert.match(u, /nomatchLines\(f\.detect, formats, sources\)/);
  assert.doesNotMatch(u, /innerHTML|console\./);
  const row = src('screens/upload-cp-row.js');
  assert.match(row, /catBox\.hidden = c !== 'expense';/, "카테고리는 '일반 지출'일 때만");
  assert.match(row, /aliasBox\.hidden = true;/, '보일 이름은 누를 때만');
  assert.doesNotMatch(row, /innerHTML/);
  const css = src('styles.css');
  assert.match(css, /\.upload-savebar \{ position: sticky;/);
  assert.match(css, /\.upload-screen \.small, \.upload-screen \.muted \{ font-size: 14px; color: var\(--sub\); \}/);
});
