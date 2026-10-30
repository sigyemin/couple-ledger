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
import { XLSX, j, SOURCE, CAT_ID, FORMAT_A, FORMAT_B, FORMAT_C, FAKE, bookBytes, sheetA, sheetB } from './fixtures.mjs';

// 결과 JSON(중복 키 해시는 뺌)에 가짜 번호가 원문으로 남았는지
const plain = (r) => JSON.stringify(r, (k, v) => (k === 'dedup_key' ? undefined : v));
const hasRaw = (r, fake) => plain(r).includes(fake) || plain(r).includes(fake.replace(/-/g, ''));

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
  assert.ok(!hasRaw(r, FAKE.acct), '매핑 금지 열·메타 줄(가짜 계좌번호) 없음');
  assert.ok(!hasRaw(r, FAKE.phone), '가린 전화번호 원문 없음');
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
  assert.ok(!hasRaw(r, FAKE.card)); // 카드 번호 열은 읽지 않음
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
  const html = `<html><body><p>${`조회 계좌 ${FAKE.acct}`}</p>
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

// ---------------------------------------------------------------- 설계 확인(가져오기 판단) 반영
import { matchCounterpartyRule, sortCounterpartyRules, parseDirection } from '../../app/import/normalize.js';

const gridOf = (header, ...rows) => [header, ...rows];

test('카드형(모두 양수) 금액이 음수·0원이면 행 오류, 카드 형식의 입금 → 환불 규칙 없음', async () => {
  const grid = gridOf(['쓴 날', '가게', '금액'], ['2026-10-03', '가짜식당', '-32,000'], ['2026-10-04', '가짜해외', '0'], ['2026-10-05', '가짜카페', '4,500']);
  const f = { ...FORMAT_B, column_map: { occurred_on: '쓴 날', merchant: '가게', amount: '금액' }, time_format: null, row_rules: [] };
  const r = await normalizeRows(grid, f, findHeader(grid, f), { sourceId: SOURCE });
  assert.deepEqual(r.errors, [{ rowNo: 2, reason: 'amount' }, { rowNo: 3, reason: 'amount' }]);
  assert.deepEqual(r.rows.map((x) => [x.kind, x.amount]), [['expense', 4500]]);
});

test('방향(입금/출금) 열이 매핑돼 있으면 부호와 대조해 다르면 행 오류', async () => {
  const f = { ...FORMAT_C, column_map: { ...FORMAT_C.column_map, direction: '구분' } };
  const grid = gridOf(['일시', '구분', '금액', '적요'],
    ['2026-10-06 12:30:00', '출금', '-15,000', '가짜상점'],
    ['2026-10-06 13:00:00', '입금', '-1,000', '가짜상점'],
    ['2026-10-07 09:00:00', '입금', '2,000', '가짜급여'],
    ['2026-10-07 10:00:00', '기타', '3,000', '가짜'],
  );
  const r = await normalizeRows(grid, f, findHeader(grid, f), { sourceId: SOURCE });
  assert.deepEqual(r.errors, [{ rowNo: 3, reason: 'direction' }, { rowNo: 5, reason: 'direction' }]);
  assert.deepEqual(r.rows.map((x) => x.kind), ['expense', 'income']);
  assert.equal(parseDirection(' 출 금 '), 'out');
  assert.equal(parseDirection('x'), null);
});

test('카드 취소: 환불 금액 칸이 정해져 있는데 비었거나 0이면 행 오류 (원금액으로 대신하지 않음)', async () => {
  const grid = sheetB().map((row) => (row[6] === '87654321' ? row.map((c, i) => (i === 8 ? '' : c)) : row));
  grid.push(['', '2026-10-07', '12:00', '전액취소상점', '9,000', '', 'ZZ990011', '취소', '0']);
  const r = await normalizeRows(grid, FORMAT_B, findHeader(grid, FORMAT_B), { sourceId: SOURCE });
  assert.deepEqual(r.errors, [{ rowNo: 5, reason: 'refund_amount' }, { rowNo: 6, reason: 'approval_no' }, { rowNo: 8, reason: 'refund_amount' }]);
  // 환불 금액 칸을 쓰지 않는 취소 규칙은 원금액
  const f = { ...FORMAT_B, row_rules: [{ field: 'status', match: 'exact', value: '취소', also_refund: true }] };
  const r2 = await normalizeRows(sheetB(), f, findHeader(sheetB(), f), { sourceId: SOURCE });
  assert.deepEqual(r2.rows.filter((x) => x.kind === 'refund').map((x) => x.amount), [6e5, 2e4]);
});

test('이체 상대 규칙: row_rules 다음, priority 순, 조건(결제수단·방향·구분·칸), 방향과 안 맞는 제안은 건너뜀', async () => {
  const other = 'a0000000-0000-4000-8000-0000000000a9';
  const cat = 'c0000000-0000-4000-8000-0000000000c2';
  const rules = [
    { id: 'r-late', match_field: 'merchant', match_text: '이 시험', match_type: 'exact', priority: 100, created_at: '2026-10-02',
      suggested_kind: 'expense', suggested_category_id: cat, suggested_is_shared: false },
    { id: 'r-first', match_field: 'merchant', match_text: '이시험', match_type: 'exact', priority: 100, created_at: '2026-10-01',
      suggested_kind: 'transfer', suggested_exclude_reason: 'personal_transfer', direction: 'out' },
    { id: 'r-other-src', match_field: 'merchant', match_text: '박샘플', source_id: other, priority: 1, suggested_kind: 'transfer', suggested_exclude_reason: 'internal_transfer' },
    { id: 'r-income-out', match_field: 'merchant', match_text: '박샘플', priority: 2, suggested_kind: 'income' },
    { id: 'r-contains', match_field: 'merchant', match_text: '샘플', match_type: 'contains', priority: 3, suggested_kind: 'expense', suggested_category_id: cat, suggested_is_shared: false },
    { id: 'r-cardbill', match_field: 'merchant', match_text: '가짜카드대금', match_type: 'contains', priority: 0, suggested_kind: 'expense' },
    { id: 'r-off', match_field: 'merchant', match_text: '가짜마트', priority: 0, is_active: false, suggested_kind: 'transfer', suggested_exclude_reason: 'internal_transfer' },
    { id: 'r-type', match_field: 'merchant', match_text: '김가짜', match_type: 'contains', txn_type: '자동이체', priority: 0, suggested_kind: 'transfer', suggested_exclude_reason: 'internal_transfer' },
  ];
  const grid = sheetA();
  grid.splice(9, 0, ['2026.10.20 08:00', '이체', '박샘플', '7,000', '', '641,000', '']);
  const r = await normalizeRows(grid, FORMAT_A, findHeader(grid, FORMAT_A), { sourceId: SOURCE, counterpartyRules: rules });
  const by = (m) => r.rows.find((x) => x.merchant_raw === m);
  // 같은 priority → 먼저 만든 규칙
  assert.deepEqual([by('이시험').kind, by('이시험').exclude_reason, by('이시험').is_excluded], ['transfer', 'personal_transfer', true]);
  // 다른 결제수단 규칙·출금에 수입 제안은 건너뛰고 contains 규칙
  assert.deepEqual([by('박샘플').kind, by('박샘플').category_id, by('박샘플').is_shared, by('박샘플').category_source], ['expense', cat, false, 'rule']);
  // row_rules가 먼저 맞으면 이체 상대 규칙은 보지 않음
  assert.deepEqual([by('가짜카드대금 10월').kind, by('가짜카드대금 10월').exclude_reason], ['transfer', 'card_bill']);
  // 꺼진 규칙·구분 조건 불일치는 무시 → row_rules(체크카드) 또는 기본값
  assert.equal(r.rows.filter((x) => x.merchant_raw === '가짜마트')[0].card_kind, 'check_card');
  assert.equal(by('김가짜 [숫자 가림]').kind, 'expense');
  // 모두 검토 대기
  assert.ok(r.rows.every((x) => x.review_status === 'needs_review'));
  // 카드 형식에는 이체 상대 규칙을 쓰지 않는다
  const b = await normalizeRows(sheetB(), FORMAT_B, findHeader(sheetB(), FORMAT_B), {
    sourceId: SOURCE, counterpartyRules: [{ match_field: 'merchant', match_text: '가짜식당', suggested_kind: 'transfer', suggested_exclude_reason: 'internal_transfer' }],
  });
  assert.equal(b.rows[0].kind, 'expense');
});

test('이체 상대 규칙: 상대 예금주명 칸·정렬', () => {
  const rules = sortCounterpartyRules([{ id: 'b', priority: 5, created_at: '2026-01-02' }, { id: 'a', priority: 5, created_at: '2026-01-01' }, { id: 'c' }]);
  assert.deepEqual(rules.map((x) => x.id), ['a', 'b', 'c']);
  const hit = matchCounterpartyRule([{ match_field: 'counterparty', match_text: '최 가짜', suggested_kind: 'income' }],
    { sourceId: SOURCE, direction: 'in', txnType: null, merchantRaw: '타행입금', counterparty: '최가짜' });
  assert.equal(hit.suggested_kind, 'income');
  assert.equal(matchCounterpartyRule([{ match_field: 'merchant', match_text: '  ', suggested_kind: 'income' }],
    { sourceId: SOURCE, direction: 'in', merchantRaw: '' }), null);
});

test('파이프라인: 이체 상대 규칙을 넘기면 적용된다', async () => {
  const rules = [{ match_field: 'merchant', match_text: '이시험', suggested_kind: 'transfer', suggested_exclude_reason: 'personal_transfer' }];
  const r = await parseFile(XLSX, bookBytes(sheetA(), 'xlsx'), { format: FORMAT_A, sourceId: SOURCE, counterpartyRules: rules });
  assert.deepEqual(r.rows.filter((x) => x.merchant_raw === '이시험').map((x) => x.exclude_reason), ['personal_transfer', 'personal_transfer']);
});

test('새 이체 상대 후보: 통장 행 중 행 규칙·이체 상대 규칙에 안 맞은 행만 표시, RPC로는 안 보냄', async () => {
  const none = await parseFile(XLSX, bookBytes(sheetA(), 'xlsx'), { format: FORMAT_A, sourceId: SOURCE, counterpartyRules: [] });
  assert.deepEqual(none.rows.filter((x) => x.newCounterparty).map((x) => x.merchant_raw.slice(0, 3)), ['김가짜', '이시험', '이시험']);
  const rules = [{ match_field: 'merchant', match_text: '이시험', suggested_kind: 'transfer', suggested_exclude_reason: 'personal_transfer' }];
  const some = await parseFile(XLSX, bookBytes(sheetA(), 'xlsx'), { format: FORMAT_A, sourceId: SOURCE, counterpartyRules: rules });
  assert.equal(some.rows.filter((x) => x.newCounterparty).length, 1);
  const card = await parseFile(XLSX, bookBytes(sheetB(), 'xls'), { format: FORMAT_B, sourceId: SOURCE });
  assert.equal(card.rows.filter((x) => x.newCounterparty).length, 0); // 카드는 대상 아님
  for (const row of toRpcRows(none.rows)) assert.ok(!('newCounterparty' in row) && !('merchantVariant' in row));
  // 가림 전 설명별 번호: 김가짜 + 가짜 번호(가려짐) 1개, 이시험 2행은 같은 번호
  const v = none.rows.filter((x) => x.newCounterparty).map((x) => x.merchantVariant);
  assert.deepEqual([v[0] !== v[1], v[1] === v[2]], [true, true]);
});

// ---------------------------------------------------------------- 리뷰 반영 (PR #6)
import { readGrid as readGridAgain, MAX_ROWS } from '../../app/import/pipeline.js';
import { mapsSensitiveHeader } from '../../app/import/formats.js';

test('압축 폭탄: 쓰지 않는 둘째 시트(대량 행)는 풀지 않는다', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['일시', '금액', '적요'], ['2026-10-06 12:30:00', '-1,000', '가짜']]), 'A');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(Array.from({ length: 60000 }, () => ['2026-10-06 12:30:00', '-1,000', '가짜상점'])), 'B');
  const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }));
  const t = Date.now();
  const { grid } = readGridAgain(XLSX, bytes);
  const ms = Date.now() - t;
  assert.equal(grid.length, 2);
  assert.ok(ms < 500, `${ms}ms`); // 고치기 전에는 둘째 시트까지 풀어 수백 ms~초 단위
});

test('첫 시트가 MAX_ROWS를 넘으면 too_many_rows (넘는 줄은 읽지 않음)', () => {
  const rows = Array.from({ length: MAX_ROWS + 5 }, (_, i) => [`2026-10-06 12:30:00`, '-1,000', `가짜${i % 7}`]);
  const bytes = bookBytes([['일시', '금액', '적요'], ...rows], 'xlsx');
  assert.throws(() => readGridAgain(XLSX, bytes), { message: 'too_many_rows' });
});

test('column_map이 매핑 금지 헤더와 겹치는 형식은 거부한다', () => {
  const bad = { ...FORMAT_A, sensitive_headers: ['상대 번호', ' 내 용 '] }; // merchant ← '내용'과 겹침(공백 차이)
  assert.equal(mapsSensitiveHeader(bad), true);
  assert.equal(mapsSensitiveHeader(FORMAT_A), false);
  assert.equal(findHeader(sheetA(), bad), null);
  assert.deepEqual(matchFormats(sheetA(), [bad], 'xlsx'), []);
});

// ---------------------------------------------------------------- 결정 반영 (D1·D2, PC 전용 자리)
import { canUpload } from '../../app/import/env.js';

test('D1: 2순위 키 일시는 분 단위 — 초가 있는 형식·없는 형식의 같은 거래는 같은 키', async () => {
  const withSec = { ...FORMAT_A, date_format: 'YYYY.MM.DD HH24:MI:SS' };
  const noSec = { ...FORMAT_A, date_format: 'YYYY.MM.DD HH24:MI' };
  const head = ['거래일시', '구분', '내용', '나간 돈', '들어온 돈', '남은 돈'];
  const g1 = [head, ['2026.10.06 12:30:41', '이체', '가짜상점', '1,000', '', '9,000']];
  const g2 = [head, ['2026.10.06 12:30', '이체', '가짜상점', '1,000', '', '9,000']];
  const r1 = await normalizeRows(g1, withSec, findHeader(g1, withSec), { sourceId: SOURCE });
  const r2 = await normalizeRows(g2, noSec, findHeader(g2, noSec), { sourceId: SOURCE });
  assert.equal(r1.rows[0].dedup_key, r2.rows[0].dedup_key);
  assert.equal(r1.rows[0].dedup_key, `k2:${sha(`${SOURCE}|out|2026-10-06 12:30|가짜상점|1000|9000|1`)}`);
  assert.deepEqual([r1.rows[0].occurred_time, r2.rows[0].occurred_time], ['12:30:41', '12:30']); // 저장하는 시각은 그대로
});

test('D2: 한 파일 안에서 같은 1순위 키가 두 번째로 나오면 행 오류(duplicate_key)', async () => {
  const grid = sheetB();
  grid.push(['', '2026-10-08', '10:00', '같은승인번호', '7,000', '', '12345678', '정상', '']);
  grid.push(['', '2026-10-09', '10:00', '같은승인번호 취소', '7,000', '', '12345678', '취소', '7,000']);
  const r = await normalizeRows(grid, FORMAT_B, findHeader(grid, FORMAT_B), { sourceId: SOURCE });
  assert.deepEqual(r.errors.filter((e) => e.reason === 'duplicate_key').map((e) => e.rowNo), [8, 9]);
  assert.equal(r.rows.filter((x) => x.approval_no === '12345678').length, 1);
  assert.ok(r.rows.every((x) => x.row_seq === 1 || x.approval_no === null));
});

test('canUpload: 자리만 있음(판별은 화면 작업에서)', () => {
  assert.deepEqual(canUpload(), { ok: true, reason: null });
});
