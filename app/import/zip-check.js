// =====================================================================
// xlsx(ZIP) 압축 해제 크기 선검사 — SheetJS에 넘기기 전에 (CL-033, 리뷰 PR6 남은 낮음 "첫 시트 폭탄")
// - 중앙 디렉터리: 항목 수·압축 해제 크기 합계·암호화·압축 방식을 본다(값싼 1차 검사)
// - 실제 크기: 머리에 적힌 크기는 믿지 않는다. 항목마다 실제로 풀면서 바이트를 세고, 합계가 상한을 넘는 순간 멈춘다
//   [사실: vendor/xlsx-0.20.3/xlsx.mjs parse_local_file — 로컬 머리 크기가 0(데이터 디스크립터)이면 출력 버퍼를 끝없이 늘린다]
//   그래서 중앙 디렉터리 숫자만 보는 검사는 우회된다 → 브라우저 내장 DecompressionStream('deflate-raw')로 센다(풀어 낸 내용은 버림)
// - ZIP64·여러 디스크·암호화·deflate/저장 외 방식은 받지 않는다(5MB 이하 내보내기 파일에는 필요 없음 [추정])
// - 오류: 'zip_too_large'(상한 넘음), 'unsupported_file'(구조가 깨졌거나 지원하지 않는 ZIP)
// 의존 없음.
// =====================================================================

// 상한 근거: 행 수 상한(MAX_ROWS 2만 행)을 채운 합성 xlsx(SheetJS로 씀)를 풀면 10열 7.1MB · 15열 10.2MB · 20열 13.6MB
//   [사실: 2026-10-29 측정. 20열은 파일 5.09MB로 파일 상한 5MB 근처]. 실제 엑셀은 칸마다 스타일 속성이 붙어 더 클 수 있다 [추정 1.5배]
//   → 20열 기준 약 20MB의 2.5배인 50MB [제안 값]
export const MAX_UNZIPPED_BYTES = 50 * 2 ** 20;
// 내보내기 xlsx는 보통 항목 10~30개 [추정: 시트 1개 + 스타일·공유 문자열·메타]. 넉넉히
export const MAX_ZIP_ENTRIES = 500;

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const EOCD_MIN = 22;
const COMMENT_MAX = 0xffff;

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function fail(code) {
  return new Error(code);
}

/**
 * 끝 레코드(EOCD) 찾기. SheetJS parse_zip과 같게 "끝에서부터 처음 만난 시그니처"를 쓰고,
 * 그 레코드의 주석 길이가 파일 끝과 정확히 맞아야 받는다(주석 안에 가짜 레코드를 숨겨 검사와 SheetJS가
 * 서로 다른 중앙 디렉터리를 보게 하는 우회를 막음 — 리뷰 PR13 B)
 */
function findEocd(dv) {
  let found = -1;
  for (let i = dv.byteLength - 4; i >= 0; i--) {
    if (dv.getUint32(i, true) !== SIG_EOCD) continue;
    if (found < 0) {
      if (!(i + EOCD_MIN <= dv.byteLength && i + EOCD_MIN + dv.getUint16(i + 20, true) === dv.byteLength)) return -1;
      found = i;
    } else if (i >= dv.byteLength - EOCD_MIN - COMMENT_MAX) {
      return -1; // 끝 64KB+22 안에 끝 레코드 시그니처가 둘 이상 — 애매하면 거부
    } else {
      break;
    }
  }
  return found;
}

/** extra 영역에 ZIP64(0x0001) 항목이 있는지 */
function hasZip64Extra(dv, start, len) {
  for (let p = start; p + 4 <= start + len;) {
    if (dv.getUint16(p, true) === 0x0001) return true;
    p += 4 + dv.getUint16(p + 2, true);
  }
  return false;
}

/** 브라우저·Node 내장 압축 해제로 실제 길이를 센다. limit을 넘으면 그 자리에서 멈추고 Infinity */
export async function inflatedLength(data, limit, env = globalThis) {
  if (typeof env.DecompressionStream !== 'function') throw fail('unsupported_file');
  let ds;
  try {
    ds = new env.DecompressionStream('deflate-raw');
  } catch {
    throw fail('unsupported_file');
  }
  const writer = ds.writable.getWriter();
  writer.write(data).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return n;
      n += value.byteLength;
      if (n > limit) {
        reader.cancel().catch(() => {});
        return Infinity;
      }
    }
  } catch {
    throw fail('unsupported_file'); // 끝이 잘렸거나 뒤에 쓰레기가 붙은 압축 자료
  }
}

/**
 * 중앙 디렉터리 읽기. 항목마다 { method, flags, csz, usz, localOffset }
 * @throws 'unsupported_file' | 'zip_too_large'
 */
export function readCentralDirectory(bytes, { maxEntries = MAX_ZIP_ENTRIES, maxBytes = MAX_UNZIPPED_BYTES } = {}) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.byteLength < EOCD_MIN) throw fail('unsupported_file');
  const e = findEocd(dv);
  if (e < 0) throw fail('unsupported_file');
  const disk = dv.getUint16(e + 4, true);
  const cdDisk = dv.getUint16(e + 6, true);
  const onDisk = dv.getUint16(e + 8, true);
  const total = dv.getUint16(e + 10, true);
  const cdSize = dv.getUint32(e + 12, true);
  const cdOffset = dv.getUint32(e + 16, true);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw fail('unsupported_file');
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw fail('unsupported_file'); // ZIP64
  if (total > maxEntries) throw fail('zip_too_large');
  if (cdOffset + cdSize > e) throw fail('unsupported_file');

  const entries = [];
  let p = cdOffset;
  let sum = 0;
  for (let i = 0; i < total; i++) {
    if (p + 46 > e || dv.getUint32(p, true) !== SIG_CEN) throw fail('unsupported_file');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csz = dv.getUint32(p + 20, true);
    const usz = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    if (flags & 0x41) throw fail('unsupported_file'); // 암호화(0x01)·강한 암호화(0x40)
    if (method !== 0 && method !== 8) throw fail('unsupported_file');
    if (csz === 0xffffffff || usz === 0xffffffff || localOffset === 0xffffffff) throw fail('unsupported_file'); // ZIP64
    if (p + 46 + nameLen + extraLen > e || hasZip64Extra(dv, p + 46 + nameLen, extraLen)) throw fail('unsupported_file');
    sum += usz;
    if (sum > maxBytes) throw fail('zip_too_large');
    entries.push({ method, flags, csz, usz, localOffset, name: bytes.subarray(p + 46, p + 46 + nameLen) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p > e) throw fail('unsupported_file');
  return entries;
}

/**
 * xlsx 바이트의 압축 해제 크기 선검사. 통과하면 실제 합계(바이트)를 돌려준다
 * @throws Error('zip_too_large' | 'unsupported_file')
 */
export async function checkZipSize(bytes, { maxEntries = MAX_ZIP_ENTRIES, maxBytes = MAX_UNZIPPED_BYTES, env = globalThis } = {}) {
  const entries = readCentralDirectory(bytes, { maxEntries, maxBytes });
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let total = 0;
  for (const it of entries) {
    const o = it.localOffset;
    if (o + 30 > dv.byteLength || dv.getUint32(o, true) !== SIG_LOC) throw fail('unsupported_file');
    // SheetJS는 로컬 머리의 방식·플래그를 쓴다("trust local file header instead of CD entry") → 중앙 값과 다르면 거부(리뷰 PR13 A)
    const flags = dv.getUint16(o + 6, true);
    const method = dv.getUint16(o + 8, true);
    const nameLen = dv.getUint16(o + 26, true);
    if (flags & 0x2041) throw fail('unsupported_file'); // SheetJS와 같은 암호화 비트
    if (method !== it.method || (flags & 0x41) !== (it.flags & 0x41) || !sameBytes(bytes.subarray(o + 30, o + 30 + nameLen), it.name)) {
      throw fail('unsupported_file');
    }
    const extraLen = dv.getUint16(o + 28, true);
    if (o + 30 + nameLen + extraLen > dv.byteLength || hasZip64Extra(dv, o + 30 + nameLen, extraLen)) throw fail('unsupported_file');
    // 데이터 디스크립터(플래그 8)가 아니면 로컬 크기도 중앙과 같아야 한다
    if (!(flags & 8) && (dv.getUint32(o + 18, true) !== it.csz || dv.getUint32(o + 22, true) !== it.usz)) throw fail('unsupported_file');
    const start = o + 30 + nameLen + extraLen;
    const end = start + it.csz;
    if (end > dv.byteLength) throw fail('unsupported_file');
    const data = bytes.subarray(start, end);
    const n = method === 0 ? it.csz : await inflatedLength(data, maxBytes - total, env);
    total += n;
    if (total > maxBytes) throw fail('zip_too_large');
  }
  return total;
}
