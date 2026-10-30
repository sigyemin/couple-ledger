// 날짜형 셀·엑셀 행 번호 (CL-049) — 합성 파일만. 실제 기관 형식이 아니다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGrid, parseFile, cellText, cellDateIso } from '../../app/import/pipeline.js';
import { normalizeRows } from '../../app/import/normalize.js';
import { findHeader } from '../../app/import/formats.js';
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
const HOUR = 60 * 60;
const DAY = 24 * HOUR;

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

test('cellDateIso: 날짜형 셀 값 → ISO(초 단위 반올림, 시각은 서식에 시·초 자리가 있을 때만), 아니면 null', () => {
  const iso = (c, d1904) => cellDateIso(XLSX, c, d1904);
  assert.equal(iso({ t: 'n', v: SERIAL, z: 'm/d/yy', w: '9/3/26' }), '2026-09-03');
  assert.equal(iso({ t: 'n', v: SERIAL, z: 'yyyy\\.mm\\.dd' }), '2026-09-03');
  assert.equal(iso({ t: 'n', v: SERIAL + 0.6, z: 'yyyy\\.mm\\.dd' }), '2026-09-03'); // 날짜만 보이는 서식이면 시각을 붙이지 않음(표시와 같게)
  assert.equal(iso({ t: 'n', v: SERIAL + 0.75, z: 'yyyy-mm-dd hh:mm' }), '2026-09-03 18:00');
  assert.equal(iso({ t: 'n', v: SERIAL, z: 'yyyy-mm-dd hh:mm:ss' }), '2026-09-03 00:00:00');
  // 소수 초는 반올림(엑셀 표시와 같게): 10:15:59.6 → 10:16:00, 23:59:59.7 → 다음 날 00:00:00
  assert.equal(iso({ t: 'n', v: SERIAL + (10 * HOUR + 15 * 60 + 59.6) / DAY, z: 'yyyy.mm.dd hh:mm:ss' }), '2026-09-03 10:16:00');
  assert.equal(iso({ t: 'n', v: SERIAL + (DAY - 0.3) / DAY, z: 'yyyy.mm.dd hh:mm:ss' }), '2026-09-04 00:00:00');
  assert.equal(iso({ t: 'n', v: SERIAL + 1 - 1e-8, z: 'yyyy.mm.dd hh:mm:ss' }), '2026-09-04 00:00:00');
  assert.equal(iso({ t: 'n', v: 0.5, z: 'hh:mm' }), '12:00');
  assert.equal(iso({ t: 'n', v: 0.25, z: 'h:mm:ss' }), '06:00:00');
  assert.equal(iso({ t: 'n', v: SERIAL - 1462, z: 'yyyy-mm-dd' }, true), '2026-09-03'); // 1904 체계
  assert.equal(iso({ t: 'n', v: SERIAL, z: 'General', w: '46268' }), null);
  assert.equal(iso({ t: 's', v: '2026-09-03', w: '2026-09-03' }), null);
  assert.equal(iso(null), null);
});

test('cellText: 표시 글자 그대로, 오류 셀은 빈 칸', () => {
  assert.equal(cellText(XLSX, { t: 'n', v: SERIAL, z: 'm/d/yy', w: '9/3/26' }), '9/3/26');
  assert.equal(cellText(XLSX, { t: 'n', v: 1000, z: '#,##0', w: '1,000' }), '1,000');
  assert.equal(cellText(XLSX, { t: 's', v: '가짜', w: '가짜' }), '가짜');
  assert.equal(cellText(XLSX, { t: 'e', v: 42, w: '#N/A' }), '');
  assert.equal(cellText(XLSX, null), '');
});

test('표시 글자로 읽히는 행은 셀 값을 쓰지 않는다(전에 올린 행의 날짜·시각·중복 키 그대로)', async () => {
  // 날짜 칸은 글자로 읽히고, 시각 칸 표시가 형식에 안 맞음(오후 표기) → 이전처럼 시각 없음
  const grid = [['이용일', '이용시각', '가맹점', '금액'], ['2026.09.03', '2:24 PM', '가짜식당', '1,000']];
  const alts = [null, { 1: '14:24' }];
  const r = await normalizeRows(grid, FMT, findHeader(grid, FMT), { sourceId: SOURCE, dateAlts: alts });
  assert.deepEqual([r.rows[0].occurred_on, r.rows[0].occurred_time], ['2026-09-03', null]);
  // 날짜를 셀 값으로 읽은 행만 시각도 셀 값으로
  const grid2 = [['이용일', '이용시각', '가맹점', '금액'], ['9/3/26', '2:24 PM', '가짜식당', '1,000']];
  const r2 = await normalizeRows(grid2, FMT, findHeader(grid2, FMT), { sourceId: SOURCE, dateAlts: [null, { 0: '2026-09-03', 1: '14:24' }] });
  assert.deepEqual([r2.rows[0].occurred_on, r2.rows[0].occurred_time], ['2026-09-03', '14:24']);
});

test('날짜처럼 보이는 글자: 연·월·일 세 부분 또는 2000~2099년 일련번호', () => {
  for (const v of ['46268', '46268.75', '9/3/26', '2026.02.30', '2026-09-03 25:00', '9/3/26 2:24 PM']) assert.equal(looksLikeDate(v), true, v);
  for (const v of ['합 계', '총 3건', '', null, '조회기간', '1/1', '3', '12:00:00', '12345', '99999',
    '2026.09.01 ~ 2026.09.30', '2026.10.01 기준']) assert.equal(looksLikeDate(v), false, String(v));
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
