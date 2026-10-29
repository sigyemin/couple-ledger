// =====================================================================
// 엑셀 파싱 Worker (같은 출처 module Worker, 공통 컴포넌트 설계 4장)
// 파일은 브라우저 밖으로 나가지 않는다. 메인 스레드에는 정규화한 행·건수만 돌려준다.
// 메시지
//   { id, op: 'detect', bytes, formats }                         → { id, ok, fileType, formatIds }
//   { id, op: 'parse',  bytes, format, sourceId, categories, counterpartyRules }
//                                                              → { id, ok, fileType, rows, errors, skipped, maskedCells }
//   실패: { id, ok: false, code }  (code만. 셀 값·원본 메시지는 보내지 않는다)
// =====================================================================
import * as XLSX from '../../vendor/xlsx-0.20.3/xlsx.mjs';
import { detectFormats, parseFile } from '../import/pipeline.js';

const CODES = new Set(['unsupported_file', 'too_many_rows', 'format_mismatch']);

self.onmessage = async (e) => {
  const { id, op } = e.data ?? {};
  try {
    const bytes = new Uint8Array(e.data.bytes);
    if (op === 'detect') {
      self.postMessage({ id, ok: true, ...detectFormats(XLSX, bytes, e.data.formats) });
    } else if (op === 'parse') {
      const categories = new Map(Array.isArray(e.data.categories) ? e.data.categories : []);
      const counterpartyRules = Array.isArray(e.data.counterpartyRules) ? e.data.counterpartyRules : [];
      const r = await parseFile(XLSX, bytes, { format: e.data.format, sourceId: e.data.sourceId, categories, counterpartyRules });
      self.postMessage({ id, ok: true, ...r });
    } else {
      self.postMessage({ id, ok: false, code: 'bad_request' });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, code: CODES.has(err?.message) ? err.message : 'parse_failed' });
  }
};
