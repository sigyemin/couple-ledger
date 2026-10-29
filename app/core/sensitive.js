// =====================================================================
// 민감번호 검사 — DB has_sensitive_number(t)를 그대로 옮긴 것 (위험 C5, I3)
//   0) NFKC 정규화 (전각 숫자 → 반각, 줄바꿈 없는 공백 → 공백)
//   1) 날짜(2026-10-06 / 2026.10.06 / 2026/10/06), 시각(12:30, 12:30:45),
//      붙여 쓴 일시(12·14자리)를 지운다
//   2) 숫자와 구분자(공백 - . / _ ( ))로 이어진 덩어리의 숫자 개수가 10 이상이면 true
//   \d, \s 같은 약칭은 쓰지 않는다(엔진마다 뜻이 다름). DB 규칙이 바뀌면 여기도 같이 바꾼다.
//   브라우저(입력 검증·업로드 미리보기)와 저장소 유출 검사(scripts/scan.mjs)가 이 모듈 하나를 쓴다.
// 의존 없음. 브라우저와 Node 양쪽에서 동작한다.
// =====================================================================

const RE_DATE = /(?<![0-9])(19|20)[0-9]{2}[-./][0-9]{1,2}[-./][0-9]{1,2}(?![0-9])/g;
const RE_TIME = /(?<![0-9])[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?(?![0-9])/g;
const RE_PACKED_DATETIME =
  /(?<![0-9])(19|20)[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])([01][0-9]|2[0-3])[0-5][0-9]([0-5][0-9])?(?![0-9])/g;
const RE_DIGIT_RUN = /[0-9](?:[0-9 ./_()-]*[0-9])?/g;

export const MIN_SENSITIVE_DIGITS = 10;

/**
 * 카드·계좌·전화번호로 보이는 10자리 이상 숫자 덩어리가 있는지.
 * options.packedDateTime = false: 붙여 쓴 일시 제거 단계를 끈다.
 *   시각 칸이 따로 있는 통장의 설명 칸처럼, 20xx로 시작하는 12·14자리 계좌번호를
 *   일시로 잘못 지울 수 있는 곳에서 쓴다 (schema.sql has_sensitive_number 주석).
 *   DB는 보수적으로 항상 켠 상태와 같다.
 */
export function hasSensitiveNumber(t, { packedDateTime = true } = {}) {
  if (t == null) return false;
  const s = removeDateTime(String(t).normalize('NFKC'), { packedDateTime });
  for (const tok of s.match(RE_DIGIT_RUN) ?? []) {
    if (tok.replace(/[^0-9]/g, '').length >= MIN_SENSITIVE_DIGITS) return true;
  }
  return false;
}

/** 1단계만: 날짜·시각(·붙여 쓴 일시)을 공백으로 바꾼다. 정규화는 하지 않는다 */
export function removeDateTime(s, { packedDateTime = true } = {}) {
  let r = s.replace(RE_DATE, ' ').replace(RE_TIME, ' ');
  if (packedDateTime) r = r.replace(RE_PACKED_DATETIME, ' ');
  return r;
}

/** 검사에 걸리는 숫자 덩어리를 '[숫자 가림]'으로 바꾼다 (업로드 미리보기에서 사용자 확인 후 적용) */
export const MASK_TEXT = '[숫자 가림]';

export function maskSensitiveNumbers(t, options) {
  if (t == null) return t;
  const s = String(t).normalize('NFKC');
  if (!hasSensitiveNumber(s, options)) return s;
  // 검출과 같은 덩어리를 가린다: 날짜·시각을 같은 길이의 공백으로 바꾼 문자열에서 덩어리 위치를 찾고,
  // 그 위치를 원문에서 가린다(공백은 구분자라 날짜를 사이에 둔 숫자도 검출처럼 한 덩어리가 된다)
  const blank = (m) => ' '.repeat(m.length);
  let probe = s.replace(RE_DATE, blank).replace(RE_TIME, blank);
  if (options?.packedDateTime !== false) probe = probe.replace(RE_PACKED_DATETIME, blank);
  let out = '';
  let last = 0;
  for (const m of probe.matchAll(RE_DIGIT_RUN)) {
    if (m[0].replace(/[^0-9]/g, '').length < MIN_SENSITIVE_DIGITS) continue;
    out += s.slice(last, m.index) + MASK_TEXT;
    last = m.index + m[0].length;
  }
  return out + s.slice(last);
}
