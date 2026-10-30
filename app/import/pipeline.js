// =====================================================================
// 파일 한 개 처리: 바이트 → 셀 표 → 형식 찾기 → 정규화 (Worker 안에서 쓴다)
// - SheetJS는 인자로 받는다(Worker는 vendor 모듈을, 테스트는 같은 파일을 import해 넘긴다)
// - 파싱 옵션: 수식·HTML·스타일 읽지 않음(보안 리뷰 9장)
// - html은 문서 안 모든 표의 행을 순서대로 이어 본다(SheetJS는 표마다 시트를 만든다).
//   xlsx·xls는 첫 시트만 [추정: 내보내기 파일은 시트 1개. 실제 파일은 QA가 확인]
// - 셀 표(원문)는 이 함수 밖으로 내보내지 않는다. 내보내는 것은 형식 id·건수·정규화한 행뿐
// 의존: ./detect.js, ./formats.js, ./normalize.js
// =====================================================================
import { detectFileType, decodeUtf8Strict } from './detect.js';
import { matchFormats } from './formats.js';
import { normalizeRows } from './normalize.js';

export const MAX_ROWS = 20000;
// 압축 폭탄 대비: 시트당 MAX_ROWS + 1줄까지만 읽는다(넘으면 too_many_rows). xlsx·xls는 첫 시트만 푼다(sheets: 0)
// cellNF: 셀의 숫자 서식(z)을 읽어 날짜형 셀을 알아본다(CL-049)
const READ_OPTS = Object.freeze({
  cellFormula: false, cellHTML: false, cellStyles: false, cellDates: false, cellNF: true, dense: true, sheetRows: MAX_ROWS + 1,
});

const pad = (n) => String(n).padStart(2, '0');

/**
 * 셀 하나 → 글자. 날짜형 셀(숫자 + 날짜 서식)은 표시 서식과 상관없이 'YYYY-MM-DD[ HH:MI[:SS]]' 또는 'HH:MI[:SS]'(시각만)로
 * 바꾼다(CL-049: 엑셀 기본 날짜 서식은 SheetJS가 'm/d/yy'로 내서 형식의 date_format에 안 맞았다).
 * 엑셀 일련번호를 SheetJS SSF로 바로 풀므로 시간대가 끼지 않는다. 그 밖의 셀은 SheetJS 표시 글자 그대로
 * html은 셀 글자가 곧 파일 원문(SheetJS가 날짜로 해석해도 w에 원문을 남긴다)이라 바꾸지 않는다(convertDates = false)
 */
export function cellText(XLSX, c, date1904 = false, convertDates = true) {
  if (!c || c.v == null) return '';
  if (convertDates && c.t === 'n' && typeof c.z === 'string' && XLSX.SSF.is_date(c.z)) {
    const p = XLSX.SSF.parse_date_code(c.v, { date1904 });
    if (p) {
      const fmt = c.z.replace(/"[^"]*"|\[[^\]]*\]/g, '');
      const withTime = /[hs]/i.test(fmt) || c.v % 1 !== 0;
      const withSec = /s/i.test(fmt) || p.S !== 0;
      const time = `${pad(p.H)}:${pad(p.M)}${withSec ? `:${pad(p.S)}` : ''}`;
      if (Math.floor(c.v) === 0) return time; // 시각만 있는 셀(날짜 부분 0)
      const date = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
      return withTime ? `${date} ${time}` : date;
    }
  }
  return String(c.w ?? XLSX.utils.format_cell(c) ?? '');
}

/**
 * 시트 → { rows, rowNums }. 빈 줄(값 있는 셀이 없는 줄)은 뺀다(sheet_to_json blankrows:false와 같은 기준).
 * rowNums = 각 줄의 시트 행 번호(1부터, 빈 줄 포함 — 엑셀에서 보이는 행 번호, CL-049 D2)
 */
function sheetRows(XLSX, ws, date1904, convertDates) {
  const rows = [];
  const rowNums = [];
  if (!ws?.['!ref']) return { rows, rowNums };
  const range = XLSX.utils.decode_range(ws['!ref']);
  const dense = ws['!data'];
  const at = (r, c) => (dense ? dense[r]?.[c] : ws[XLSX.utils.encode_cell({ r, c })]);
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    let filled = false;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = at(r, c);
      if (cell && cell.t !== 'z' && cell.v != null) filled = true;
      row.push(cellText(XLSX, cell, date1904, convertDates));
    }
    if (!filled) continue;
    rows.push(row);
    rowNums.push(r + 1);
  }
  return { rows, rowNums };
}

/** 바이트 → { fileType, grid, rowNums } (판별 실패 시 throw). rowNums[i] = grid[i]의 파일 행 번호 */
export function readGrid(XLSX, bytes) {
  const fileType = detectFileType(bytes);
  if (!fileType) throw new Error('unsupported_file');
  let wb;
  if (fileType === 'html') {
    const text = decodeUtf8Strict(bytes);
    wb = XLSX.read(text.replace(/^﻿/, ''), { ...READ_OPTS, type: 'string' });
  } else {
    wb = XLSX.read(bytes, { ...READ_OPTS, type: 'array', sheets: 0 });
  }
  const names = fileType === 'html' ? wb.SheetNames : wb.SheetNames.slice(0, 1);
  const date1904 = Boolean(wb.Workbook?.WBProps?.date1904);
  const sheets = names.map((n) => sheetRows(XLSX, wb.Sheets[n], date1904, fileType !== 'html'));
  const grid = sheets.flatMap((x) => x.rows);
  if (grid.length > MAX_ROWS) throw new Error('too_many_rows');
  // html은 표 여러 개를 이어 보므로 엑셀 행 번호가 없다 → 이어 붙인 순번(이전과 같음)
  const rowNums = fileType === 'html' ? grid.map((_, i) => i + 1) : sheets[0]?.rowNums ?? [];
  return { fileType, grid, rowNums };
}

/** 파일이 맞는 형식 id 목록 */
export function detectFormats(XLSX, bytes, formats) {
  const { fileType, grid } = readGrid(XLSX, bytes);
  return { fileType, formatIds: matchFormats(grid, formats, fileType).map((m) => m.format.id) };
}

/**
 * 고른 형식으로 정규화
 * @param {{ format: object, sourceId: string, categories?: Map<string,string>, counterpartyRules?: object[], categoryRules?: object[] }} p
 */
export async function parseFile(XLSX, bytes, { format, sourceId, categories, counterpartyRules, categoryRules }) {
  const { fileType, grid, rowNums } = readGrid(XLSX, bytes);
  const m = matchFormats(grid, [format], fileType)[0];
  if (!m) throw new Error('format_mismatch');
  const result = await normalizeRows(grid, format, m.header, { sourceId, categories, counterpartyRules, categoryRules, rowNums });
  return { fileType, ...result };
}
