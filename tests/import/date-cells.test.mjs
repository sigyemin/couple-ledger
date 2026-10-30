// 날짜형 셀·엑셀 행 번호 (CL-049) — 합성 파일만. 실제 기관 형식이 아니다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGrid, parseFile, cellText } from '../../app/import/pipeline.js';
import { looksLikeDate } from '../../app/import/normalize.js';
import { previewOf } from '../../app/screens/upload-model.js';
import { XLSX, SOURCE } from './fixtures.mjs';

// 가상 카드 형식: 날짜·시각 두 칸, 날짜 형식은 점 구분
const FMT = {
  id: 'f0000000-0000-4000-8000-0000000000d1', institution: '가상기관D', kind: 'credit_card', version: 1, file_types: ['xlsx', 'xls'],
  header_row: null, header_scan_limit: 10,
  column_map: { occurred_on: '이용일', occurred_time: '이용시각', merchant: '가맹점', amount: '금액' },
  sensitive_headers: [], date_format: 'YYYY.MM.DD', time_format: 'HH24:MI', amount_sign: 'expense_positive', row_rules: [],
};
const SERIAL = 46268; // 2026-09-03 (1900 체계)

/** 헤더 위에 빈 줄·제목·빈 줄을 둔 합성 시트. 날짜 칸 4가지: 사용자 서식 / 기본 날짜(번호 14) / 서식 없는 숫자 / 글자 + 꼬리 합계 */
function book(bookType) {
  const ws = XLSX.utils.aoa_to_sheet([
    [],
    ['가상 카드 이용내역'],
    [],
    ['이용일', '이용시각', '가맹점', '금액'],
    [SERIAL, 0.5, '가짜식당', '10,000'],
    [SERIAL + 1, 0.75, '가짜마트', '20,000'],
    [SERIAL + 2, '09:30', '가짜분식', '30,000'],
    ['2026.09.06', '10:15', '가짜카페', '4,000'],
    ['합 계', '', '', '64,000'],
  ]);
  ws.A5.z = 'yyyy\\.mm\\.dd';
  ws.A6.z = XLSX.SSF._table[14]; // 엑셀 기본 날짜 서식 → SheetJS 표시 'm/d/yy'
  ws.B5.z = 'hh:mm';
  ws.B6.z = 'h:mm';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType }));
}

test('cellText: 날짜형 셀은 서식과 상관없이 ISO, 시각만 있는 셀은 HH:MI, 그 밖은 표시 글자', () => {
  assert.equal(cellText(XLSX, { t: 'n', v: SERIAL, z: 'm/d/yy', w: '9/3/26' }), '2026-09-03');
  assert.equal(cellText(XLSX, { t: 'n', v: SERIAL, z: 'yyyy\\.mm\\.dd' }), '2026-09-03');
  assert.equal(cellText(XLSX, { t: 'n', v: SERIAL + 0.75, z: 'm/d/yy' }), '2026-09-03 18:00');
  assert.equal(cellText(XLSX, { t: 'n', v: SERIAL, z: 'yyyy-mm-dd hh:mm:ss' }), '2026-09-03 00:00:00');
  assert.equal(cellText(XLSX, { t: 'n', v: 0.5, z: 'hh:mm' }), '12:00');
  assert.equal(cellText(XLSX, { t: 'n', v: 0.25, z: 'h:mm:ss' }), '06:00:00');
  assert.equal(cellText(XLSX, { t: 'n', v: SERIAL - 1462, z: 'yyyy-mm-dd' }, true), '2026-09-03'); // 1904 체계
  assert.equal(cellText(XLSX, { t: 'n', v: SERIAL, z: 'General', w: '46268' }), '46268');
  assert.equal(cellText(XLSX, { t: 's', v: '가짜', w: '가짜' }), '가짜');
  assert.equal(cellText(XLSX, { t: 'n', v: 1000, z: '#,##0', w: '1,000' }), '1,000');
  assert.equal(cellText(XLSX, null), '');
});

test('날짜처럼 보이는 글자: 숫자·구분자만', () => {
  for (const v of ['46268', '9/3/26', '2026.02.30', '2026-09-03 25:00']) assert.equal(looksLikeDate(v), true, v);
  for (const v of ['합 계', '총 3건', '', null, '조회기간']) assert.equal(looksLikeDate(v), false, String(v));
});

for (const bookType of ['xlsx', 'biff8']) {
  test(`날짜형 셀 4가지 + 엑셀 행 번호 (${bookType})`, async () => {
    const bytes = book(bookType);
    const { grid, rowNums } = readGrid(XLSX, bytes);
    assert.deepEqual(rowNums, [2, 4, 5, 6, 7, 8, 9]); // 빈 줄(1·3행)은 빼고, 번호는 엑셀 행 그대로
    assert.equal(grid.length, rowNums.length);

    const r = await parseFile(XLSX, bytes, { format: FMT, sourceId: SOURCE });
    const got = r.rows.map((x) => [x.merchant_raw, x.occurred_on, x.occurred_time]);
    assert.deepEqual(got, [
      ['가짜식당', '2026-09-03', '12:00'], // 사용자 서식 날짜형 셀
      ['가짜마트', '2026-09-04', '18:00'], // 기본 날짜 서식(번호 14) — 전에는 '9/3/26'으로 읽혀 버려짐
      ['가짜카페', '2026-09-06', '10:15'], // 글자 날짜
    ]);
    // 서식 없는 숫자(일련번호)는 날짜인지 알 수 없어 행 오류 — 엑셀 7행
    assert.deepEqual(r.errors, [{ rowNo: 7, reason: 'date' }]);
    assert.equal(r.skipped, 1); // 꼬리 합계 줄만 건너뜀(제목 줄은 헤더 위라 세지 않음)
    const p = previewOf(r, new Set());
    assert.deepEqual(p.errorLines, ['날짜를 읽지 못함 1줄']);
    assert.deepEqual(p.errorRows, [7]);
    // 성공 행의 rowNo도 엑셀 행
    assert.deepEqual(r.rows.map((x) => x.rowNo), [5, 6, 8]);
  });
}

test('html은 셀 글자를 그대로(SheetJS가 날짜로 해석해도 원문 유지), 행 번호는 이어 붙인 순번', () => {
  const html = '<html><body><table><tr><td>일시</td><td>금액</td></tr><tr><td>2026-09-24 09:00:00</td><td>1,000</td></tr></table></body></html>';
  const { grid, rowNums } = readGrid(XLSX, new TextEncoder().encode(html));
  assert.deepEqual(grid, [['일시', '금액'], ['2026-09-24 09:00:00', '1,000']]);
  assert.deepEqual(rowNums, [1, 2]);
});
