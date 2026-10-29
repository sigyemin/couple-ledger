// =====================================================================
// Supabase 클라이언트 만들기 (공통 컴포넌트 설계 v0.1 1·2장)
// - supabase-js는 vendor/supabase-js-2.118.0/supabase.js(공식 UMD 묶음)를 index.html에서 먼저 읽어
//   전역 supabase가 생긴 뒤에 쓴다. 이 모듈 밖에서는 전역 supabase를 쓰지 않는다
// - 로그인은 PKCE, 세션은 기본 저장소(localStorage). 키는 publishable(또는 anon)만 — app/config.js 한 곳
// - authStoragePrefix(url): supabase-js가 쓰는 저장 키 접두 'sb-<프로젝트 ref>-'
//   (2.118.0 소스 SupabaseClient.ts: 기본 storageKey = `sb-${hostname 첫 부분}-auth-token`,
//    PKCE code verifier = `${storageKey}-code-verifier` 등). 로그아웃 정리(clearLocalData)에 넘긴다
// 의존: 전역 supabase (vendor)
// =====================================================================

/** 'https://abcdref.supabase.co' → 'sb-abcdref-' */
export function authStoragePrefix(url) {
  const host = new URL(url).hostname;
  return `sb-${host.split('.')[0]}-`;
}

/**
 * @param {{ url: string, key: string, lib?: { createClient: Function } }} p
 *   lib: 테스트에서 바꿔 끼운다. 기본은 전역 supabase
 */
export function createSupabaseClient({ url, key, lib = globalThis.supabase } = {}) {
  if (!lib || typeof lib.createClient !== 'function') {
    throw new Error('supabase-js가 로드되지 않았습니다 (vendor 스크립트 순서 확인)');
  }
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new TypeError('Supabase 주소는 https여야 합니다');
  if (typeof key !== 'string' || !key) throw new TypeError('공개 키가 필요합니다');
  return lib.createClient(u.origin, key, {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}
