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

const READ_OPTS = Object.freeze({ cellFormula: false, cellHTML: false, cellStyles: false, cellDates: false, dense: true });
export const MAX_ROWS = 20000;

function sheetRows(XLSX, ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false })
    .map((row) => row.map((c) => (c == null ? '' : String(c))));
}

/** 바이트 → { fileType, grid } (판별 실패 시 throw) */
export function readGrid(XLSX, bytes) {
  const fileType = detectFileType(bytes);
  if (!fileType) throw new Error('unsupported_file');
  let wb;
  if (fileType === 'html') {
    const text = decodeUtf8Strict(bytes);
    wb = XLSX.read(text.replace(/^﻿/, ''), { ...READ_OPTS, type: 'string' });
  } else {
    wb = XLSX.read(bytes, { ...READ_OPTS, type: 'array' });
  }
  const names = fileType === 'html' ? wb.SheetNames : wb.SheetNames.slice(0, 1);
  const grid = names.flatMap((n) => sheetRows(XLSX, wb.Sheets[n]));
  if (grid.length > MAX_ROWS) throw new Error('too_many_rows');
  return { fileType, grid };
}

/** 파일이 맞는 형식 id 목록 */
export function detectFormats(XLSX, bytes, formats) {
  const { fileType, grid } = readGrid(XLSX, bytes);
  return { fileType, formatIds: matchFormats(grid, formats, fileType).map((m) => m.format.id) };
}

/**
 * 고른 형식으로 정규화
 * @param {{ format: object, sourceId: string, categories?: Map<string,string>, counterpartyRules?: object[] }} p
 */
export async function parseFile(XLSX, bytes, { format, sourceId, categories, counterpartyRules }) {
  const { fileType, grid } = readGrid(XLSX, bytes);
  const m = matchFormats(grid, [format], fileType)[0];
  if (!m) throw new Error('format_mismatch');
  const result = await normalizeRows(grid, format, m.header, { sourceId, categories, counterpartyRules });
  return { fileType, ...result };
}
