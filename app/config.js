// =====================================================================
// 앱 설정 — 공개 저장소에 둘 수 있는 값만 (CLAUDE.md 보안 원칙)
// - SUPABASE_URL: Supabase 프로젝트 주소 (https://<프로젝트 ref>.supabase.co)
// - SUPABASE_PUBLISHABLE_KEY: publishable(또는 legacy anon) 키 한 개. 이 파일 한 곳에만 둔다
//   service_role·secret 키, DB 비밀번호, 토큰은 절대 넣지 않는다
// 두 값은 사용자가 Supabase 대시보드에서 확인해 넣는다(README "배포 전 설정").
// 비어 있으면 앱은 "설정이 필요해요" 화면만 보여 준다.
// index.html의 CSP connect-src 자리표시자(https://project-ref.supabase.co)도 같은 주소로 바꾼다(단위 시험이 둘이 같은지 본다).
// =====================================================================

export const SUPABASE_URL = '';
export const SUPABASE_PUBLISHABLE_KEY = '';

// 앱이 localStorage·sessionStorage에 쓰는 키 접두 (로그아웃 때 이 접두만 지운다)
export const APP_STORAGE_PREFIX = 'cl-';
