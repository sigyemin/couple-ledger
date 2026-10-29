// =====================================================================
// 더보기 (화면 설계 v0.2 3-1, 시안 10)
// 조회: v_monthly_summary(이번 달 검토 대기 수)
// 로그아웃: 인증 가드 signOut(이 앱 저장 키만 지움) → 로그인 화면
// 의존: ui/dom.js, core/confirm.js, screens/more-model.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { confirmDialog } from '../core/confirm.js';
import { moreMenu } from './more-model.js';
import { errorView } from './shell.js';

const head = (title, back, doc) => h('header', { class: 'screen-head' }, [
  h('nav', { class: 'month-nav' }, [
    back ? h('a', { class: 'icon-btn', text: '‹', attrs: { href: back, 'aria-label': '더보기로' } }, [], doc) : null,
    h('h1', { class: 'title', text: title }, [], doc),
  ], doc),
], doc);

/**
 * @param {{ db, member, monthStart, signOut(): Promise, isCurrent(), onError(err) }} ctx
 */
export async function renderMore({ db, member, monthStart, signOut, isCurrent, onError }, doc = globalThis.document) {
  const r = await db.select('v_monthly_summary', { columns: 'period_month,needs_review_count', filters: [{ col: 'period_month', op: 'eq', value: monthStart }] });
  if (!isCurrent()) return null;
  if (r.error) onError?.(r.error); // 숫자만 못 보여 줄 뿐 메뉴는 그린다
  const items = moreMenu({ member, monthStart, needsReview: r.data?.[0]?.needs_review_count });
  const list = h('ul', { class: 'todo-list' }, items.map((it) => h('li', {}, [
    it.href
      ? h('a', { class: 'todo', attrs: { href: it.href } }, [
        h('span', { class: 'todo-text' }, [h('span', { text: it.label }, [], doc), h('span', { class: 'sub', text: it.sub }, [], doc)], doc),
        h('span', { class: 'chev', text: '›', attrs: { 'aria-hidden': 'true' } }, [], doc),
      ], doc)
      : h('div', { class: 'todo off' }, [
        h('span', { class: 'todo-text' }, [h('span', { text: it.label }, [], doc), h('span', { class: 'sub', text: it.sub }, [], doc)], doc),
      ], doc),
  ], doc)), doc);
  const out = h('button', { class: 'btn danger-text', text: '로그아웃', attrs: { type: 'button' } }, [], doc);
  out.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: '로그아웃', message: '이 기기에서 로그아웃해요. 이 앱이 저장한 로그인 정보도 지워요.', confirmLabel: '로그아웃', doc }))) return;
    out.disabled = true;
    await signOut(); // 네트워크가 끊겨도 로컬 정리는 한다(인증 가드)
  });
  return h('main', { class: 'screen' }, [
    head('더보기', null, doc),
    r.error ? errorView('검토할 것 수를 불러오지 못했어요.', r.error.detail?.sqlState ?? r.error.code, doc) : null,
    h('section', { class: 'card' }, [list], doc),
    out,
  ], doc);
}
