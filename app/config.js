// =====================================================================
// 앱 설정 — 공개 저장소에 둘 수 있는 값만 (CLAUDE.md 보안 원칙)
// - SUPABASE_URL: Supabase 프로젝트 주소 (https://<프로젝트 ref>.supabase.co)
// - SUPABASE_PUBLISHABLE_KEY: publishable(또는 legacy anon) 키 한 개. 이 파일 한 곳에만 둔다
//   service_role·secret 키, DB 비밀번호, 토큰은 절대 넣지 않는다
// 운영 프로젝트 값(2026-10-29 설정, README "배포 설정"). publishable 키는 공개값이다(브라우저에 그대로 내려감)
// 주소를 바꾸면 index.html의 CSP connect-src도 같은 주소로 바꾼다(단위 시험이 둘이 같은지 본다).
// 비어 있으면 앱은 "설정이 필요해요" 화면만 보여 준다.
// =====================================================================

export const SUPABASE_URL = 'https://tzjumnxlsadllpsclhoi.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_6SmgLMZpY3CkUCsXUWA30g_dMoujRtQ';

// 앱이 localStorage·sessionStorage에 쓰는 키 접두 (로그아웃 때 이 접두만 지운다)
export const APP_STORAGE_PREFIX = 'cl-';
