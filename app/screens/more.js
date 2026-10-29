// =====================================================================
// 더보기 (화면 설계 v0.2 3-1, 시안 10) · 카테고리 보기 (3-9 "보기")
// 조회: v_monthly_summary(이번 달 검토 대기 수), categories
// 로그아웃: 인증 가드 signOut(이 앱 저장 키만 지움) → 로그인 화면
// 의존: ui/dom.js, router.js, core/confirm.js, screens/more-model.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { buildHash } from '../router.js';
import { confirmDialog } from '../core/confirm.js';
import { moreMenu, categoryTree } from './more-model.js';
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

/** 카테고리 보기(읽기만) */
export async function renderCategories({ db, isCurrent, onError }, doc = globalThis.document) {
  const r = await db.select('categories', { columns: 'id,parent_id,name,code,sort_order,is_active' });
  if (!isCurrent()) return null;
  const top = head('카테고리', buildHash('more'), doc);
  if (r.error) {
    onError?.(r.error);
    return h('main', { class: 'screen' }, [top, errorView(r.error.message, r.error.detail?.sqlState ?? r.error.code, doc)], doc);
  }
  const tree = categoryTree(r.data ?? []);
  const tagEls = (tags) => tags.map((t) => h('span', { class: 'tag', text: t }, [], doc));
  const groupCard = (g) => h('details', { class: 'card cat-group', attrs: { open: true } }, [
    h('summary', {}, [h('span', { text: g.name }, [], doc), ...tagEls(g.tags), h('span', { class: 'sub', text: ` ${g.items.length}개` }, [], doc)], doc),
    g.items.length === 0 ? h('p', { class: 'muted', text: '항목이 없어요' }, [], doc)
      : h('ul', { class: 'cat-items' }, g.items.map((it) => h('li', {}, [h('span', { text: it.name }, [], doc), ...tagEls(it.tags)], doc)), doc),
  ], doc);
  return h('main', { class: 'screen' }, [
    top,
    h('p', { class: 'muted', text: '이름 바꾸기·추가·끄기·순서는 다음 단계에서 열어요.' }, [], doc),
    h('h2', { class: 'section-title', text: '지출' }, [], doc),
    ...tree.expense.map(groupCard),
    h('h2', { class: 'section-title', text: '수입' }, [], doc),
    ...tree.income.map(groupCard),
  ], doc);
}
