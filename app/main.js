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
import { renderList } from './screens/list.js';
import { renderDetail } from './screens/detail.js';
import { renderAdd } from './screens/add.js';
import { renderSettle } from './screens/settle.js';
import { defaultSettleMonth } from './screens/settle-model.js';
import { renderMore } from './screens/more.js';
import { renderUploads } from './screens/uploads.js';
import { renderCategories } from './screens/categories.js';
import { renderRules, renderRuleEdit, renderReapply } from './screens/rules.js';
import { renderCounterparties, renderCounterpartyEdit, renderCounterpartyApply } from './screens/counterparty.js';
import { renderSources, renderSourceEdit } from './screens/sources.js';
import { renderTrash } from './screens/trash.js';
import { renderChanges, renderChange } from './screens/changes.js';
import { renderReview } from './screens/review.js';
import { renderUpload } from './screens/upload.js';
import { renderRefundFind } from './screens/refund.js';
import { renderReport, renderReportGroup, renderReportItem } from './screens/report.js';
import { defaultReportMonth } from './screens/report-model.js';
import { defaultReviewMonth } from './screens/review-model.js';

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

  // 화면의 링크·쓰기 뒤 다시 그리기. 첫 화면을 그릴 때는 아직 router가 없지만, 이 둘은 사용자 동작 뒤에만 불린다
  let router = null;
  const go = (hash) => router?.go(hash);
  const reload = () => router?.reload();

  router = startRouter(async (route, isCurrent) => {
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
    // 기록하고 화면에 보일 오류 번호를 돌려준다
    const onError = (err, extra = {}) => {
      const traceId = newTraceId();
      logger.member(err, { stage: route.screen === 'home' ? STAGES.boot : STAGES.list, traceId, ...extra });
      return displayCode(err, traceId);
    };
    let view;
    try {
      const monthStart = monthParam(route.query.get('month'), currentMonth());
      if (route.screen === 'home') {
        view = await renderHome({ db, member, monthStart, isCurrent, onError });
      } else if (route.screen === 'list') {
        view = await renderList({ db, monthStart, query: route.query, go, isCurrent, onError });
      } else if (route.screen === 'more') {
        const signOut = async () => { await guard.signOut(); replaceChildren(root, loginView('로그아웃했어요.')); };
        view = await renderMore({ db, member, monthStart: defaultReviewMonth(), signOut, isCurrent, onError });
      } else if (route.screen === 'review') {
        view = await renderReview({ db, member, monthStart: monthParam(route.query.get('month'), defaultReviewMonth()), reload, isCurrent, onError });
      } else if (route.screen === 'report') {
        view = await renderReport({ db, monthStart: monthParam(route.query.get('month'), defaultReportMonth()), view: route.query.get('view') === 'income' ? 'income' : 'expense', query: route.query, isCurrent, onError });
      } else if (route.screen === 'rgroup') {
        view = await renderReportGroup({ db, id: route.id, monthStart: monthParam(route.query.get('month'), defaultReportMonth()), isCurrent, onError });
      } else if (route.screen === 'ritem') {
        view = await renderReportItem({ db, id: route.id, monthStart: monthParam(route.query.get('month'), defaultReportMonth()), isCurrent, onError });
      } else if (route.screen === 'trash') {
        view = await renderTrash({ db, member, reload, isCurrent, onError });
      } else if (route.screen === 'changes') {
        view = await renderChanges({ db, isCurrent, onError });
      } else if (route.screen === 'change') {
        view = await renderChange({ db, id: route.id, reload, isCurrent, onError });
      } else if (route.screen === 'rules') {
        view = await renderRules({ db, isCurrent, onError });
      } else if (route.screen === 'rule' || route.screen === 'rulenew') {
        view = await renderRuleEdit({ db, member, id: route.id, go, isCurrent, onError });
      } else if (route.screen === 'reapply') {
        view = await renderReapply({ db, id: route.id, query: route.query, go, isCurrent, onError });
      } else if (route.screen === 'cprules') {
        view = await renderCounterparties({ db, isCurrent, onError });
      } else if (route.screen === 'cprule' || route.screen === 'cprulenew') {
        view = await renderCounterpartyEdit({ db, member, id: route.id, go, isCurrent, onError });
      } else if (route.screen === 'cpapply') {
        view = await renderCounterpartyApply({ db, id: route.id, isCurrent, onError });
      } else if (route.screen === 'sources') {
        view = await renderSources({ db, isCurrent, onError });
      } else if (route.screen === 'source' || route.screen === 'sourcenew') {
        view = await renderSourceEdit({ db, id: route.id, go, isCurrent, onError });
      } else if (route.screen === 'uploads') {
        view = await renderUploads({ db, isCurrent, onError });
      } else if (route.screen === 'categories') {
        view = await renderCategories({ db, reload, isCurrent, onError });
      } else if (route.screen === 'settle') {
        view = await renderSettle({ db, monthStart: monthParam(route.query.get('month'), defaultSettleMonth()), reload, isCurrent, onError });
      } else if (route.screen === 'upload') {
        view = await renderUpload({ db, guard, member, fallbackMonth: defaultSettleMonth(), isCurrent, onError }); // ?month는 무시(CL-051)
      } else if (route.screen === 'refund') {
        view = await renderRefundFind({ db, member, id: route.id, query: route.query, go, isCurrent, onError });
      } else if (route.screen === 'add') {
        view = await renderAdd({ db, member, query: route.query, go, isCurrent, onError });
      } else if (route.screen === 'txn') {
        view = await renderDetail({ db, member, id: route.id, go, reload, isCurrent, onError });
      } else {
        const titles = { upload: '올리기' };
        view = comingSoon(titles[route.screen]);
      }
    } catch (err) {
      onError(err);
      view = h('main', { class: 'screen' }, [errorView('화면을 그리지 못했어요.', displayCode(err))]);
    }
    if (!view || !isCurrent()) return;
    replaceChildren(root, tabBar(route.screen), view); // 메뉴를 먼저(읽기 순서·키보드 이동). 위치는 CSS가 정함
  });
}

// 놓기 영역 밖에 파일을 떨어뜨려도 브라우저가 그 파일을 열지 않게(CL-051). 파일 끌기만 막고, 놓기 영역은 자기가 처리한다
for (const type of ['dragover', 'drop']) {
  globalThis.addEventListener?.(type, (e) => {
    if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault();
  });
}

boot();
