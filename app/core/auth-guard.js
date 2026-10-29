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

/** 브라우저 로컬 저장소 정리 (IndexedDB 전체, Cache Storage 전체). 실패해도 계속 */
export async function clearLocalData(env = globalThis) {
  try {
    const dbs = (await env.indexedDB?.databases?.()) ?? [];
    await Promise.all(dbs.map((d) => d?.name && new Promise((resolve) => {
      const req = env.indexedDB.deleteDatabase(d.name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    })));
  } catch { /* 정리 실패는 무시 */ }
  try {
    const keys = (await env.caches?.keys?.()) ?? [];
    await Promise.all(keys.map((k) => env.caches.delete(k)));
  } catch { /* 정리 실패는 무시 */ }
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
      if (me) throw me;
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
