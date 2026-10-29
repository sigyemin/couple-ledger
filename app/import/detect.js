// =====================================================================
// 파일 종류 판별 (스키마 import_formats 주석 "파서 규칙", 보안 리뷰 v0.1 4.4)
// - 확장자가 아니라 내용(시그니처)으로 판별한다
//     ZIP 'PK\x03\x04' = xlsx, OLE 'D0 CF 11 E0 A1 B1 1A E1' = xls,
//     html = (BOM·공백 뒤) '<'로 시작 + UTF-8 엄격 디코딩 성공 + '<table' 포함
// - 그 밖은 null(거부). 크기 상한 5MB (공통 컴포넌트 결정 P6)
// 의존 없음.
// =====================================================================

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const startsWith = (b, sig) => b.length >= sig.length && sig.every((x, i) => b[i] === x);

/** UTF-8로 엄격하게 풀 수 있으면 문자열, 아니면 null */
export function decodeUtf8Strict(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * @param {Uint8Array} bytes
 * @returns {'xlsx'|'xls'|'html'|null}
 */
export function detectFileType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_FILE_BYTES) return null;
  if (startsWith(bytes, ZIP)) return 'xlsx';
  if (startsWith(bytes, OLE)) return 'xls';
  const text = decodeUtf8Strict(bytes);
  if (text === null) return null;
  const head = text.replace(/^﻿/, '').trimStart();
  if (head.startsWith('<') && /<table[\s>]/i.test(text)) return 'html';
  return null;
}
