// =====================================================================
// 중복 판정 키 k2 (스키마 4장 "중복 판정 규칙, v0.14 k2")
// 키 문자열은 앱 메모리 안에서만 만들고, DB에는 'k2:' + SHA-256 hex(키 문자열 UTF-8)만 보낸다.
//   칸 구분자 '|', 없는 값은 빈 문자열
//   1순위(카드, 승인번호 있음): source_id | approval_no | kind            (kind = expense / refund)
//   2순위(그 밖):               source_id | 방향 | 일시 | 설명 정리값 | 금액 | 거래 후 잔액 | n번째
//     방향 = out / in, 일시 = 'YYYY-MM-DD HH:MI'(분 단위, 초는 넣지 않음 — 사용자 결정 D1), 설명 정리값 = merchant_norm,
//     잔액 = balance_after(키 전용 열, 없으면 빈 값), n번째 = 한 파일 안에서 앞 칸이 모두 같은 행의 순번(1부터)
// 의존 없음 (crypto.subtle: 브라우저·Worker·Node 20+)
// =====================================================================

export const KEY_VERSION = 'k2';

/** 1순위 키 문자열 */
export function primaryKey({ sourceId, approvalNo, kind }) {
  return [sourceId, approvalNo, kind].join('|');
}

/** 2순위 키에서 n번째를 뺀 앞부분 */
export function secondaryPrefix({ sourceId, direction, occurredAt, merchantNorm, amount, balanceAfter }) {
  return [sourceId, direction, occurredAt, merchantNorm, String(amount), balanceAfter ?? ''].join('|');
}

/** 키 문자열 → 'k2:' + SHA-256 hex */
export async function hashKey(keyString) {
  const bytes = new TextEncoder().encode(keyString);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${KEY_VERSION}:${hex}`;
}

/** 파일 바이트 → SHA-256 hex (import_batches.file_hash) */
export async function fileHash(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
