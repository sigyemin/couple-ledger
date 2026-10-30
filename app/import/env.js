// =====================================================================
// 업로드 환경 (화면 설계 보정 CL-029 2판, 사용자 결정 10-29·10-30)
// - 휴대폰에서도 올리기를 막지 않는다. 휴대폰(태블릿 포함)이면 올리기 화면에 "PC에서 올리는 것을 권해요" 안내만
// - 휴대폰 판별: userAgentData.mobile이 true/false 값이면 그 값, 없으면(삼성 인터넷 등) matchMedia('(pointer: coarse)')
//   화면 폭·UA 문자열·hover는 쓰지 않는다(설계 2-1). 안내 전용이라 틀려도 띠가 보이거나 안 보일 뿐
// 결과: canUpload → { ok: boolean, reason: string | null } — 지금은 항상 허용
// =====================================================================

export function canUpload(/* env = globalThis */) {
  return { ok: true, reason: null };
}

/** 휴대폰(태블릿 포함)인지. 안내 띠·읽기 실패 안내에만 쓴다 */
export function isPhone(env = globalThis) {
  const mobile = env.navigator?.userAgentData?.mobile;
  if (mobile === true || mobile === false) return mobile;
  try {
    return Boolean(env.matchMedia?.('(pointer: coarse)')?.matches);
  } catch {
    return false;
  }
}
