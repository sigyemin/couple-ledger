// =====================================================================
// 형식 찾기 (스키마 import_formats 주석 "파서 규칙")
// - 형식 정의(헤더 이름·열 구조)는 코드에 두지 않는다. DB import_formats 행을 받아 쓴다(데이터 주도)
// - 헤더 비교: 셀 값과 column_map 값을 모두 NFKC 정규화 + 공백 문자(스페이스·탭·줄바꿈·CR·FF·VT) 제거 후 같으면 일치
// - 헤더 행: 위에서 header_scan_limit줄 안에서 column_map의 헤더 이름이 모두 있는 첫 줄
// - 헤더 이름을 객체 키로 쓰지 않는다(프로토타입 오염 방지, 보안 리뷰 4.4) → Map만 쓴다
// - column_map의 헤더가 sensitive_headers(매핑 금지 열)와 겹치는 형식은 거부한다(DB CHECK와 같은 조건, 같은 비교로 한 번 더)
// 의존 없음.
// =====================================================================

/** DB match_norm과 같은 정리: NFKC + 공백 문자 제거 */
export function matchNorm(t) {
  return String(t ?? '').normalize('NFKC').replace(/[ \t\n\r\f\v]/g, '');
}

/** column_map 헤더가 매핑 금지 헤더와 겹치는지 */
export function mapsSensitiveHeader(format) {
  const banned = new Set((Array.isArray(format?.sensitive_headers) ? format.sensitive_headers : []).map(matchNorm));
  return Object.values(format?.column_map ?? {}).some((h) => banned.has(matchNorm(h)));
}

/**
 * 헤더 행을 찾는다. 매핑 금지 헤더와 겹치는 형식이면 null
 * @param {string[][]} grid  셀 문자열 2차원 배열
 * @param {{ column_map: object, sensitive_headers?: string[], header_scan_limit?: number }} format
 * @returns {{ headerIndex: number, columns: Map<string, number> } | null}
 *   columns: 표준 키(또는 키 전용 키) → 열 번호
 */
export function findHeader(grid, format) {
  const wanted = Object.entries(format?.column_map ?? {});
  if (!wanted.length || mapsSensitiveHeader(format)) return null;
  const limit = Math.min(grid.length, format.header_scan_limit ?? 20);
  for (let r = 0; r < limit; r++) {
    const cells = new Map();
    (grid[r] ?? []).forEach((c, i) => {
      const k = matchNorm(c);
      if (k && !cells.has(k)) cells.set(k, i);
    });
    const columns = new Map();
    for (const [key, header] of wanted) {
      const idx = cells.get(matchNorm(header));
      if (idx === undefined) break;
      columns.set(key, idx);
    }
    if (columns.size === wanted.length) return { headerIndex: r, columns };
  }
  return null;
}

/**
 * 파일 종류와 헤더가 맞는 형식 목록
 * @returns {{ format: object, header: { headerIndex, columns } }[]}
 */
export function matchFormats(grid, formats, fileType) {
  const out = [];
  for (const f of formats ?? []) {
    if (!Array.isArray(f.file_types) || !f.file_types.includes(fileType)) continue;
    const header = findHeader(grid, f);
    if (header) out.push({ format: f, header });
  }
  return out;
}
