// =====================================================================
// 부팅: 클릭재킹 방어 → 설정 확인 → Supabase 클라이언트 → 인증 가드 → 라우터 → 화면
// - iframe 안에서 열리면 아무것도 그리지 않는다(body는 CSS로 기본 숨김, 최상위 창일 때만 보임 — 보안 리뷰 2.3)
// - 로그아웃·미등록 정리는 이 앱의 저장 키(sb-<ref>-, cl-)만 지운다(PR #4 리뷰 L3)
// - 화면마다 구성원 확인(requireMember)을 거친다
// 의존: config.js, core/*, router.js, screens/*
// =====================================================================
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, APP_STORAGE_PREFIX } from './config.js';
import { createSupabaseClient, authStoragePrefix } from './core/supabase-client.js';
import { createDb } from './core/db.js';
import { createAuthGuard, clearLocalData } from './core/auth-guard.js';
import { createErrorLogger, newTraceId, displayCode, STAGES } from './core/errors.js';
import { startRouter, monthParam, currentMonth } from './router.js';
import { h, replaceChildren } from './ui/dom.js';
import { tabBar, comingSoon, errorView } from './screens/shell.js';
import { renderHome } from './screens/home.js';

const doc = globalThis.document;
const root = doc.getElementById('app');

function showMessage(title, text, extra = []) {
  replaceChildren(root, h('main', { class: 'screen center' }, [
    h('h1', { class: 'title', text: title }),
    h('p', { class: 'muted', text }),
    ...extra,
  ]));
}

async function boot() {
  if (globalThis.top !== globalThis.self) return; // iframe 안: 그리지 않음
  doc.documentElement.classList.add('top-ok');

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    showMessage('설정이 필요해요', 'app/config.js에 Supabase 주소와 공개 키를 넣어 주세요.');
    return;
  }

  let client;
  try {
    client = createSupabaseClient({ url: SUPABASE_URL, key: SUPABASE_PUBLISHABLE_KEY });
  } catch {
    showMessage('앱을 불러오지 못했어요', '새로고침해 주세요. 계속되면 오류 번호를 알려 주세요.', [h('p', { class: 'muted small', text: '오류 번호 BOOT_LIB' })]);
    return;
  }
  const prefixes = [authStoragePrefix(SUPABASE_URL), APP_STORAGE_PREFIX];
  const db = createDb(client);
  const guard = createAuthGuard({
    auth: client.auth,
    db,
    redirectTo: new URL('./', globalThis.location.href).href,
    clear: () => clearLocalData(globalThis, prefixes),
  });
  const logger = createErrorLogger({ rpc: (name, args) => client.rpc(name, args) });

  const loginView = (notice) => {
    const btn = h('button', { class: 'btn primary', text: '구글로 로그인', attrs: { type: 'button' } });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await guard.signIn();
      } catch (err) {
        const traceId = newTraceId();
        logger.auth(err, { stage: STAGES.auth_login, traceId });
        btn.disabled = false;
        replaceChildren(root, loginView(`로그인하지 못했어요. 오류 번호 ${displayCode(err, traceId)}`));
      }
    });
    return h('main', { class: 'screen center' }, [
      h('h1', { class: 'title', text: '공동 가계부' }),
      notice ? h('p', { class: 'notice', text: notice, attrs: { role: 'alert' } }) : null,
      btn,
    ]);
  };

  startRouter(async (route, isCurrent) => {
    let member;
    try {
      member = await guard.requireMember();
    } catch (err) {
      if (!isCurrent()) return;
      if (err.code === 'not_login') return replaceChildren(root, loginView());
      if (err.code === 'not_member') return replaceChildren(root, loginView(err.message));
      const traceId = newTraceId();
      logger.auth(err, { stage: STAGES.auth_member, traceId });
      return replaceChildren(root, loginView(`${err.message} (오류 번호 ${displayCode(err, traceId)})`));
    }
    if (!isCurrent()) return;
    const onError = (err) => logger.member(err, { stage: route.screen === 'home' ? STAGES.boot : STAGES.list, traceId: newTraceId() });
    let view;
    try {
      if (route.screen === 'home') {
        const monthStart = monthParam(route.query.get('month'), currentMonth());
        view = await renderHome({ db, member, monthStart, isCurrent, onError });
      } else {
        const titles = { list: '내역', txn: '거래 상세', upload: '올리기', settle: '정산', more: '더보기' };
        view = comingSoon(titles[route.screen]);
      }
    } catch (err) {
      onError(err);
      view = h('main', { class: 'screen' }, [errorView('화면을 그리지 못했어요.', displayCode(err))]);
    }
    if (!view || !isCurrent()) return;
    replaceChildren(root, view, tabBar(route.screen));
  });
}

boot();
