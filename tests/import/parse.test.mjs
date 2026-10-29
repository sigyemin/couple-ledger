// 가져오기: 판별·날짜 형식·헤더 찾기·정규화·중복 키·파이프라인 (가상 형식, 합성 파일만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { detectFileType, MAX_FILE_BYTES } from '../../app/import/detect.js';
import { compileFormat, parseWith } from '../../app/import/datetime.js';
import { findHeader, matchFormats, matchNorm } from '../../app/import/formats.js';
import { normalizeRows, parseAmount, parseInstallment, matchRowRule, toRpcRows } from '../../app/import/normalize.js';
import { hashKey, fileHash } from '../../app/import/dedup.js';
import { readGrid, detectFormats, parseFile } from '../../app/import/pipeline.js';
import { hasSensitiveNumber } from '../../app/core/sensitive.js';
import { XLSX, j, SOURCE, CAT_ID, FORMAT_A, FORMAT_B, FORMAT_C, bookBytes, sheetA, sheetB } from './fixtures.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------- 판별
test('파일 종류는 내용으로 판별한다', () => {
  assert.equal(detectFileType(bookBytes([['a']], 'xlsx')), 'xlsx');
  assert.equal(detectFileType(bookBytes([['a']], 'biff8')), 'xls');
  const html = new TextEncoder().encode('﻿  <html><table><tr><td>a</td></tr></table></html>');
  assert.equal(detectFileType(html), 'html');
  assert.equal(detectFileType(new TextEncoder().encode('<html><p>표 없음</p></html>')), null);
  assert.equal(detectFileType(new TextEncoder().encode('날짜,금액\n')), null); // csv
  assert.equal(detectFileType(new Uint8Array([0x3c, 0x74, 0xff, 0xfe])), null); // UTF-8 아님
  assert.equal(detectFileType(new Uint8Array(0)), null);
  const big = new Uint8Array(MAX_FILE_BYTES + 1);
  big.set([0x50, 0x4b, 0x03, 0x04]);
  assert.equal(detectFileType(big), null);
});

// ---------------------------------------------------------------- 날짜 형식
test('날짜·시각 형식: [ ]는 선택, 실제 있는 값만', () => {
  const f = compileFormat('YYYY.MM.DD HH24:MI[:SS]');
  assert.deepEqual(parseWith(f, '2026.10.06 12:30'), { date: '2026-10-06', time: '12:30' });
  assert.deepEqual(parseWith(f, ' 2026.10.06 09:05:07 '), { date: '2026-10-06', time: '09:05:07' });
  assert.equal(parseWith(f, '2026.02.30 12:30'), null);
  assert.equal(parseWith(f, '2026.10.06 24:00'), null);
  assert.equal(parseWith(f, '합 계'), null);
  assert.equal(parseWith(f, '2026-10-06 12:30'), null);
  assert.deepEqual(parseWith(compileFormat('HH24:MI'), '7:05'), { date: null, time: '07:05' });
  assert.deepEqual(parseWith(compileFormat('YYYY-MM-DD'), '2026-10-06'), { date: '2026-10-06', time: null });
  for (const bad of ['', 'YYYY-MM-DD]', '[YYYY', 'YYYY-QQ', 'YYYY YYYY']) assert.throws(() => compileFormat(bad), bad);
});

// ---------------------------------------------------------------- 헤더
test('헤더 찾기: NFKC·공백·줄바꿈 차이 흡수, 탐색 줄 수 제한, Map만 사용', () => {
  const grid = sheetA();
  const h = findHeader(grid, FORMAT_A);
  assert.equal(h.headerIndex, 2);
  assert.equal(h.columns.get('amount_out'), 3); // '나간\n돈'
  assert.equal(h.columns.get('occurred_at'), 0); // '거래일시' ↔ '거래 일시'
  assert.ok(h.columns instanceof Map);
  assert.equal(findHeader(grid, { ...FORMAT_A, header_scan_limit: 2 }), null);
  assert.equal(findHeader([['__proto__', 'constructor']], { column_map: { merchant: '__proto__' } }).columns.get('merchant'), 0);
  assert.equal(matchNorm('ａ b\tc\nd'), 'abcd');
});

test('형식 찾기: 파일 종류와 헤더가 모두 맞아야 한다', () => {
  const grid = sheetA();
  assert.deepEqual(matchFormats(grid, [FORMAT_A, FORMAT_B, FORMAT_C], 'xlsx').map((m) => m.format.id), [FORMAT_A.id]);
  assert.deepEqual(matchFormats(grid, [FORMAT_A], 'html'), []);
  assert.deepEqual(matchFormats(sheetB(), [FORMAT_A, FORMAT_B], 'xls').map((m) => m.format.id), [FORMAT_B.id]);
});

// ---------------------------------------------------------------- 작은 함수
test('금액·할부·규칙 일치', () => {
  assert.equal(parseAmount('1,234원'), 1234);
  assert.equal(parseAmount(' -15,000 '), -15000);
  assert.equal(parseAmount(''), null);
  assert.ok(Number.isNaN(parseAmount('12.5')));
  assert.ok(Number.isNaN(parseAmount('abc')));
  assert.equal(parseInstallment('3개월'), 3);
  assert.equal(parseInstallment('일시불'), null);
  assert.equal(parseInstallment('1'), null);
  const rules = [{ field: 'txn_type', match: 'contains', value: '이 체', direction: 'in' }, { field: 'merchant', match: 'any' }];
  assert.equal(matchRowRule(rules, (k) => (k === 'txn_type' ? '타행이체' : null), 'in'), rules[0]);
  assert.equal(matchRowRule(rules, (k) => (k === 'txn_type' ? '타행이체' : null), 'out'), rules[1]);
  assert.equal(matchRowRule([], () => 'x', 'out'), null);
});

test('k2 해시: 키 문자열 UTF-8의 SHA-256', async () => {
  const key = `${SOURCE}|out|2026-10-06 12:30|가짜마트|15000|985000|1`;
  assert.equal(await hashKey(key), `k2:${sha(key)}`);
  assert.equal(await fileHash(new TextEncoder().encode('abc')), sha('abc'));
});

// ---------------------------------------------------------------- 정규화 (형식 A: 통장)
async function normA() {
  const grid = sheetA();
  return normalizeRows(grid, FORMAT_A, findHeader(grid, FORMAT_A), { sourceId: SOURCE, categories: new Map([['interest', CAT_ID]]) });
}

test('형식 A: 방향·금액·제안·꼬리 줄·오류 행', async () => {
  const r = await normA();
  assert.equal(r.skipped, 1); // 합 계
  assert.deepEqual(r.errors, [{ rowNo: 11, reason: 'amount' }]);
  assert.equal(r.rows.length, 7);
  const [use, cancel, transfer, bill, a1, a2, interest] = r.rows;
  assert.deepEqual([use.kind, use.card_kind, use.amount, use.occurred_on, use.occurred_time], ['expense', 'check_card', 15000, '2026-10-06', '12:30']);
  assert.deepEqual([cancel.kind, cancel.card_kind], ['refund', 'check_card']);
  assert.deepEqual([transfer.kind, transfer.occurred_time], ['expense', '09:00:05']);
  assert.deepEqual([bill.kind, bill.is_excluded, bill.exclude_reason], ['transfer', true, 'card_bill']);
  assert.deepEqual([interest.kind, interest.category_id, interest.category_source], ['income', CAT_ID, 'rule']);
  assert.equal(a1.review_status, 'needs_review');
  // 같은 일시·내용·금액이어도 잔액이 달라 n은 1
  assert.deepEqual([a1.row_seq, a2.row_seq], [1, 1]);
  assert.notEqual(a1.dedup_key, a2.dedup_key);
  // 체크카드 사용(out)과 취소(in): 방향이 달라 키가 다르다
  assert.notEqual(use.dedup_key, cancel.dedup_key);
  for (const row of r.rows) assert.match(row.dedup_key, /^k2:[0-9a-f]{64}$/);
  assert.equal(use.dedup_key, `k2:${sha(`${SOURCE}|out|2026-10-06 12:30|가짜마트|15000|985000|1`)}`);
});

test('형식 A: 민감번호는 가리고, 매핑 금지·매핑 안 한 열·잔액은 결과에 없다', async () => {
  const r = await normA();
  const transfer = r.rows[2];
  assert.equal(transfer.merchant_raw, '김가짜 [숫자 가림]');
  assert.equal(transfer.merchant_norm, '김가짜[숫자가림]');
  assert.equal(r.maskedCells, 1);
  // 글자 칸마다 검사(JSON 전체를 이어 보면 쉼표·콜론이 구분자라 숫자 칸끼리 이어진다)
  for (const row of r.rows) {
    for (const v of [row.merchant_raw, row.merchant_norm, ...Object.values(row.raw)]) {
      assert.equal(hasSensitiveNumber(v), false, v);
    }
  }
  const all = JSON.stringify(r);
  assert.ok(!all.includes('456789'), '매핑 금지 열(가짜 계좌번호) 없음');
  assert.ok(!all.includes('조회 계좌'));
  for (const row of r.rows) {
    assert.deepEqual(Object.keys(row.raw).sort().filter((k) => !['occurred_at', 'amount_out', 'amount_in', 'merchant', 'txn_type'].includes(k)), []);
    assert.equal(row.raw.balance_after, undefined);
  }
});

test('형식 A: 잔액이 같으면 n번째로 구분하고, 같은 파일을 다시 처리하면 키가 같다', async () => {
  const grid = sheetA().map((row, r) => row.map((c, i) => (r > 2 && i === 5 ? '' : c))); // 데이터 줄의 잔액 칸 비움
  const h = findHeader(grid, FORMAT_A);
  const r1 = await normalizeRows(grid, FORMAT_A, h, { sourceId: SOURCE });
  const r2 = await normalizeRows(grid, FORMAT_A, h, { sourceId: SOURCE });
  const [a1, a2] = [r1.rows[4], r1.rows[5]];
  assert.deepEqual([a1.row_seq, a2.row_seq], [1, 2]);
  assert.notEqual(a1.dedup_key, a2.dedup_key);
  assert.deepEqual(r1.rows.map((x) => x.dedup_key), r2.rows.map((x) => x.dedup_key));
  // 결제수단이 다르면 키가 다르다
  const r3 = await normalizeRows(grid, FORMAT_A, h, { sourceId: 'a0000000-0000-4000-8000-0000000000a2' });
  assert.notEqual(r3.rows[0].dedup_key, r1.rows[0].dedup_key);
  // 카테고리 표가 없으면 category_id 없음
  assert.equal(r1.rows[6].category_id, null);
  assert.equal(r1.rows[6].category_source, undefined);
});

// ---------------------------------------------------------------- 정규화 (형식 B: 카드)
test('형식 B: 승인번호 1순위 키, 취소 → 원거래 + 환불 행, 승인번호 형식 오류', async () => {
  const grid = sheetB();
  const r = await normalizeRows(grid, FORMAT_B, findHeader(grid, FORMAT_B), { sourceId: SOURCE });
  assert.deepEqual(r.errors, [{ rowNo: 6, reason: 'approval_no' }]);
  assert.equal(r.skipped, 1); // 빈 줄
  const [n, orig, refund, pOrig, pRefund] = r.rows;
  assert.equal(r.rows.length, 5);
  assert.deepEqual([n.kind, n.card_kind, n.occurred_time, n.installment_months, n.row_seq], ['expense', 'credit_card', '18:20', null, 1]);
  assert.equal(n.dedup_key, `k2:${sha(`${SOURCE}|12345678|expense`)}`);
  assert.deepEqual([orig.kind, orig.amount, orig.installment_months], ['expense', 600000, 3]);
  assert.deepEqual([refund.kind, refund.amount, refund.approval_no, refund.rowNo], ['refund', 600000, 'AB12CD34', orig.rowNo]);
  assert.equal(refund.dedup_key, `k2:${sha(`${SOURCE}|AB12CD34|refund`)}`);
  assert.deepEqual([pOrig.amount, pRefund.amount], [20000, 5000]); // 부분취소: 취소금액
  assert.ok(r.rows.indexOf(orig) < r.rows.indexOf(refund)); // 원거래가 먼저
  assert.ok(!JSON.stringify(r).includes('9012')); // 카드 번호 열은 읽지 않음
});

test('toRpcRows: rowNo를 빼고 RPC 칸만', async () => {
  const grid = sheetB();
  const r = await normalizeRows(grid, FORMAT_B, findHeader(grid, FORMAT_B), { sourceId: SOURCE });
  const allowed = new Set(['dedup_key', 'occurred_on', 'occurred_time', 'merchant_raw', 'merchant_norm', 'amount', 'kind',
    'card_kind', 'approval_no', 'row_seq', 'installment_months', 'refund_of_txn_id', 'is_shared', 'share_ratio',
    'is_excluded', 'exclude_reason', 'review_status', 'raw', 'category_id', 'category_source']);
  for (const row of toRpcRows(r.rows)) for (const k of Object.keys(row)) assert.ok(allowed.has(k), k);
  await assert.rejects(normalizeRows([], FORMAT_B, { headerIndex: 0, columns: new Map() }, {}), TypeError);
});

// ---------------------------------------------------------------- 파이프라인 (실제 SheetJS로 합성 파일 읽기)
test('파이프라인: xlsx·xls 합성 파일 → 형식 판별 → 정규화', async () => {
  const xlsx = bookBytes(sheetA(), 'xlsx');
  assert.deepEqual(detectFormats(XLSX, xlsx, [FORMAT_A, FORMAT_B, FORMAT_C]), { fileType: 'xlsx', formatIds: [FORMAT_A.id] });
  const fromFile = await parseFile(XLSX, xlsx, { format: FORMAT_A, sourceId: SOURCE });
  const direct = await normA();
  assert.deepEqual(fromFile.rows.map((x) => x.dedup_key), direct.rows.map((x) => x.dedup_key));
  const xls = bookBytes(sheetB(), 'biff8');
  const b = await parseFile(XLSX, xls, { format: FORMAT_B, sourceId: SOURCE });
  assert.equal(b.fileType, 'xls');
  assert.equal(b.rows.length, 5);
  await assert.rejects(parseFile(XLSX, xlsx, { format: FORMAT_B, sourceId: SOURCE }), { message: 'format_mismatch' });
  assert.throws(() => readGrid(XLSX, new TextEncoder().encode('a,b\n1,2')), { message: 'unsupported_file' });
});

test('파이프라인: html은 모든 표의 행을 이어 본다, 부호 금액', async () => {
  const html = `<html><body><p>${j('조회 ', '계좌 ', '110-123', '-456789')}</p>
    <table><tr><td>일시</td><td>적요</td><td>금액</td></tr>
    <tr><td>2026-10-06 12:30:00</td><td>가짜상점</td><td>-15,000원</td></tr></table>
    <table><tr><td>2026-10-07 09:00:00</td><td>가짜급여</td><td>2,000,000원</td></tr>
    <tr><td>합계</td><td></td><td>1,985,000</td></tr></table></body></html>`;
  const bytes = new TextEncoder().encode(html);
  assert.deepEqual(detectFormats(XLSX, bytes, [FORMAT_A, FORMAT_C]), { fileType: 'html', formatIds: [FORMAT_C.id] });
  const r = await parseFile(XLSX, bytes, { format: FORMAT_C, sourceId: SOURCE });
  assert.deepEqual(r.rows.map((x) => [x.kind, x.amount, x.merchant_raw]), [['expense', 15000, '가짜상점'], ['income', 2000000, '가짜급여']]);
  assert.equal(r.skipped, 1);
});
