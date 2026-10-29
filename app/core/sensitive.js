// =====================================================================
// 민감번호 검사 — DB has_sensitive_number(t)와 같은 규칙 (설계 문서 v0.17 민감번호 규칙)
//   0) 값이 없으면 false
//   1) NFKC 정규화 (전각 숫자·쉼표 → 반각, 줄바꿈 없는 공백 → 공백)
//   2) 서식 문자 삭제: U+00AD, U+180E, U+200B~U+200F, U+202A~U+202E, U+2060~U+2064, U+2066~U+2069, U+FEFF
//   3) 아랍-인도 숫자(U+0660~U+0669, U+06F0~U+06F9) → 0~9
//   4) 대시류(U+2010~U+2015, U+2212) → '-'
//   5) 날짜(2026-10-06 / 2026.10.06 / 2026/10/06) → 공백
//   6) 시각(12:30, 12:30:45) → 공백
//   7) 붙여 쓴 일시(12·14자리) → 공백
//   8) 쉼표 천 단위 금액(9자리 이하: 1,234 / 1,234,567) → 공백
//   9) 숫자 덩어리: [0-9]로 시작·끝나고 사이가 [0-9] 또는 구분자
//      구분자 = 공백 . / _ ( ) - * + , : · • ‧ ・ ㆍ
//  10) 덩어리 하나의 숫자 개수 ≥ 10 이면 true
//   \d, \s 같은 약칭은 쓰지 않는다(엔진마다 뜻이 다름). DB 규칙이 바뀌면 여기도 같이 바꾼다.
//   브라우저(입력 검증·업로드 미리보기)와 저장소 유출 검사(scripts/scan.mjs)가 이 모듈 하나를 쓴다.
// 의존 없음. 브라우저와 Node 양쪽에서 동작한다.
// =====================================================================

const RE_FORMAT_CHARS = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const RE_ARABIC_DIGITS = /[٠-٩۰-۹]/g;
const RE_DASHES = /[‐-―−]/g;
const RE_DATE = /(?<![0-9])(19|20)[0-9]{2}[-./][0-9]{1,2}[-./][0-9]{1,2}(?![0-9])/g;
const RE_TIME = /(?<![0-9])[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?(?![0-9])/g;
const RE_PACKED_DATETIME =
  /(?<![0-9])(19|20)[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])([01][0-9]|2[0-3])[0-5][0-9]([0-5][0-9])?(?![0-9])/g;
const RE_COMMA_AMOUNT = /(?<![0-9,])[0-9]{1,3}(,[0-9]{3}){1,2}(?![0-9,])/g;

/** 9단계 구분자 (정규식 문자 집합 안에 넣는 모양). 하이픈은 맨 끝 */
export const RUN_SEPARATORS = ' ./_()*+,:·•‧・ㆍ-';
const RE_DIGIT_RUN = new RegExp(`[0-9](?:[0-9${RUN_SEPARATORS}]*[0-9])?`, 'g');

export const MIN_SENSITIVE_DIGITS = 10;

/** 1~4단계: 정규화. 결과 길이는 원문과 다를 수 있다 */
export function normalizeForCheck(t) {
  return String(t)
    .normalize('NFKC')
    .replace(RE_FORMAT_CHARS, '')
    .replace(RE_ARABIC_DIGITS, (c) => {
      const code = c.charCodeAt(0);
      return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
    })
    .replace(RE_DASHES, '-');
}

/**
 * 5~8단계: 날짜·시각·붙여 쓴 일시·쉼표 천 단위 금액을 지운다.
 * sameLength = true면 같은 길이의 공백으로 바꿔 위치를 보존한다(마스킹용). 판정 결과는 같다(공백은 구분자)
 */
export function removeKnownPatterns(s, { packedDateTime = true, sameLength = false } = {}) {
  const blank = sameLength ? (m) => ' '.repeat(m.length) : () => ' ';
  let r = s.replace(RE_DATE, blank).replace(RE_TIME, blank);
  if (packedDateTime) r = r.replace(RE_PACKED_DATETIME, blank);
  return r.replace(RE_COMMA_AMOUNT, blank);
}

const countDigits = (tok) => tok.replace(/[^0-9]/g, '').length;

/**
 * 카드·계좌·전화번호로 보이는 10자리 이상 숫자 덩어리가 있는지.
 * options.packedDateTime = false: 붙여 쓴 일시 제거 단계를 끈다.
 *   시각 칸이 따로 있는 통장의 설명 칸처럼, 20xx로 시작하는 12·14자리 계좌번호를
 *   일시로 잘못 지울 수 있는 곳에서 쓴다. DB는 보수적으로 항상 켠 상태와 같다.
 */
export function hasSensitiveNumber(t, { packedDateTime = true } = {}) {
  if (t == null) return false;
  const s = removeKnownPatterns(normalizeForCheck(t), { packedDateTime });
  for (const tok of s.match(RE_DIGIT_RUN) ?? []) {
    if (countDigits(tok) >= MIN_SENSITIVE_DIGITS) return true;
  }
  return false;
}

/** 검사에 걸리는 숫자 덩어리를 '[숫자 가림]'으로 바꾼다 (업로드 미리보기에서 사용자 확인 후 적용) */
export const MASK_TEXT = '[숫자 가림]';

/**
 * 검출과 같은 덩어리를 가린다. 결과는 1~4단계 정규화를 거친 글자다(서식 문자 삭제 등).
 * 5~8단계를 같은 길이의 공백으로 바꾼 문자열에서 덩어리 위치를 찾고, 그 위치를 가린다
 * (공백은 구분자라 날짜를 사이에 둔 숫자도 검출처럼 한 덩어리가 된다).
 */
export function maskSensitiveNumbers(t, { packedDateTime = true } = {}) {
  if (t == null) return t;
  const s = normalizeForCheck(t);
  const probe = removeKnownPatterns(s, { packedDateTime, sameLength: true });
  let out = '';
  let last = 0;
  for (const m of probe.matchAll(RE_DIGIT_RUN)) {
    if (countDigits(m[0]) < MIN_SENSITIVE_DIGITS) continue;
    out += s.slice(last, m.index) + MASK_TEXT;
    last = m.index + m[0].length;
  }
  return out + s.slice(last);
}

/**
 * 승인번호 형식 (DB approval_no_valid와 같음): 영숫자 4~12자 + 숫자가 10개 이상 이어지지 않음
 */
export function approvalNoValid(t) {
  return typeof t === 'string' && /^[0-9A-Za-z]{4,12}$/.test(t) && !/[0-9]{10}/.test(t);
}
