// =====================================================================
// 인증 가드 (공통 컴포넌트 설계 v0.1 1장, 보안 리뷰 v0.1 2.4)
// - 로그인: Supabase Auth 구글 로그인(클라이언트는 flowType 'pkce'로 만들어 넘긴다)
// - 구성원 확인: rpc('my_member_id'). null이면 미등록 계정 → 로그아웃 + 로컬 저장소 정리
//   (DB 판정은 auth.uid() 기준, R9). 미등록 계정 접근은 따로 기록하지 않는다(B분류, 보안 리뷰 D5)
// - 다른 모듈에는 { memberId, memberSlot, displayName }만 준다. 이메일·토큰은 넘기지 않는다
// - 로그아웃·구성원 확인 실패 시 IndexedDB와 Cache Storage를 정리한다(거래 데이터가 남지 않게)
// 의존: db.js (createDb 결과), errors.js
// =====================================================================
import { AppError, toAppError } from './errors.js';

export const NOT_MEMBER = new AppError('not_member', '이 계정은 사용할 수 없습니다. 등록된 구글 계정으로 로그인해 주세요');

// localStorage·sessionStorage에서 지울 키 접두. 'sb-' = supabase-js 세션 토큰·PKCE code verifier
// [추정: supabase-js v2 브라우저 기본 저장 키 sb-<ref>-auth-token. vendor 고정 PR에서 확인],
// 'cl-' = 이 앱이 쓰는 키(앱 코드는 이 접두만 쓴다).
// clear()는 쓰지 않는다: GitHub Pages 프로젝트 사이트는 같은 계정의 다른 페이지와 출처를 함께 쓴다.
// 같은 출처에 다른 Supabase 앱이 있으면 'sb-'가 그 앱 키까지 지울 수 있다 → 클라이언트를 만드는 곳에서
// 프로젝트 ref를 넣은 접두('sb-<ref>-')를 prefixes로 넘긴다(vendor·config PR에서 연결)
export const STORAGE_PREFIXES = Object.freeze(['sb-', 'cl-']);

function clearStorage(store, prefixes) {
  if (!store) return;
  const keys = [];
  for (let i = 0; i < store.length; i++) keys.push(store.key(i));
  for (const k of keys) {
    if (typeof k === 'string' && prefixes.some((p) => k.startsWith(p))) store.removeItem(k);
  }
}

/**
 * 브라우저 로컬 저장소 정리: localStorage·sessionStorage(접두 키만), IndexedDB 전체, Cache Storage 전체.
 * 실패해도 계속하고, 모두 지웠으면 true. 다른 탭이 DB를 열고 있어 막히면(onblocked) false
 */
export async function clearLocalData(env = globalThis, prefixes = STORAGE_PREFIXES) {
  let clean = true;
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      clearStorage(env[name], prefixes);
    } catch {
      clean = false;
    }
  }
  try {
    const dbs = (await env.indexedDB?.databases?.()) ?? [];
    const results = await Promise.all(dbs.map((d) => d?.name && new Promise((resolve) => {
      const req = env.indexedDB.deleteDatabase(d.name);
      req.onsuccess = () => resolve(true);
      req.onerror = req.onblocked = () => resolve(false);
    })));
    if (results.includes(false)) clean = false;
  } catch {
    clean = false;
  }
  try {
    const keys = (await env.caches?.keys?.()) ?? [];
    await Promise.all(keys.map((k) => env.caches.delete(k)));
  } catch {
    clean = false;
  }
  return clean;
}

/**
 * @param {object} p
 * @param p.auth    supabase client.auth (getSession, signInWithOAuth, signOut)
 * @param p.db      createDb(client) 결과
 * @param p.redirectTo 로그인 후 돌아올 주소 (Supabase Redirect URL과 같아야 함)
 * @param p.clear   로컬 데이터 정리 함수 (기본 clearLocalData). 테스트에서 바꿔 끼운다
 */
export function createAuthGuard({ auth, db, redirectTo, clear = clearLocalData } = {}) {
  if (!auth || !db) throw new TypeError('auth와 db가 필요합니다');
  let member = null;
  // 로그아웃·계정 변경 등 세션이 바뀌면 확인된 구성원을 버린다(다음 화면 진입 때 다시 확인)
  // [추정: 다른 탭의 로그아웃도 supabase-js가 이 이벤트로 알려 준다. 실환경 미확인]
  auth.onAuthStateChange?.((event) => {
    if (event !== 'TOKEN_REFRESHED' && event !== 'INITIAL_SESSION') member = null;
  });

  async function signOut() {
    member = null;
    try {
      await auth.signOut();
    } catch { /* 네트워크가 끊겨도 로컬 정리는 한다 */ }
    await clear();
  }

  return {
    /** 구글 로그인 화면으로 이동 */
    async signIn() {
      const { error } = await auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
      if (error) throw toAppError(error);
    },

    signOut,

    /**
     * 화면을 열기 전에 거친다. 성공하면 { memberId, memberSlot, displayName }.
     * 실패: AppError — not_login(로그인 필요) / not_member(미등록, 이미 로그아웃함) / network 등
     */
    async requireMember() {
      if (member) return { ...member };
      const { data: s, error: se } = await auth.getSession();
      if (se) throw toAppError(se);
      if (!s?.session) throw new AppError('not_login', '로그인이 필요합니다');

      const { data: memberId, error: me } = await db.rpc('my_member_id', {}, { retry: true });
      if (me) {
        // 구성원인지 확인할 수 없으면 막는 쪽으로: 로그아웃·정리 후 오류(네트워크 오류 포함, 총괄 결정)
        await signOut();
        throw me;
      }
      if (!memberId) {
        await signOut();
        throw NOT_MEMBER;
      }
      const { data: rows, error: re } = await db.select('members', {
        columns: 'id,member_slot,display_name',
        filters: [{ col: 'id', op: 'eq', value: memberId }],
      });
      if (re) throw re;
      const row = rows?.[0];
      if (!row) {
        await signOut();
        throw NOT_MEMBER;
      }
      member = Object.freeze({ memberId: row.id, memberSlot: row.member_slot, displayName: row.display_name });
      return { ...member };
    },

    /** 확인된 구성원 (없으면 null) */
    current() {
      return member ? { ...member } : null;
    },
  };
}
