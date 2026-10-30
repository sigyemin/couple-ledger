// =====================================================================
// 화면 틀: 아래 탭 5개 (화면 설계 v0.1 3장: 홈 · 내역 · 올리기 · 정산 · 더보기)
// 휴대폰에서 '올리기' 탭을 보일지(E1)는 사용자 답 대기 → 지금은 보인다
// 의존: ui/dom.js
// =====================================================================
import { h } from '../ui/dom.js';

export const TABS = Object.freeze([
  { screen: 'home', label: '홈' },
  { screen: 'list', label: '내역' },
  { screen: 'upload', label: '올리기' },
  { screen: 'settle', label: '정산' },
  { screen: 'more', label: '더보기' },
]);

/** 현재 화면에 맞는 탭 표시 (거래 상세는 내역 탭) */
export function activeTab(screen) {
  if (screen === 'txn' || screen === 'add' || screen === 'refund') return 'list';
  return ['categories', 'trash', 'changes', 'change', 'review', 'report', 'rgroup', 'ritem', 'rules', 'rule', 'rulenew', 'reapply',
    'cprules', 'cprule', 'cprulenew', 'cpapply', 'sources', 'source', 'sourcenew'].includes(screen) ? 'more' : screen;
}

export function tabBar(screen, doc = globalThis.document) {
  const on = activeTab(screen);
  return h('nav', { class: 'tabbar', attrs: { 'aria-label': '화면 이동' } }, TABS.map((t) => h('a', {
    class: t.screen === on ? 'tab on' : 'tab',
    text: t.label,
    attrs: { href: `#/${t.screen}`, 'aria-current': t.screen === on ? 'page' : null },
  }, [], doc)), doc);
}

/** 아직 만들지 않은 화면 */
export function comingSoon(title, doc = globalThis.document) {
  return h('main', { class: 'screen' }, [
    h('header', { class: 'screen-head' }, [h('h1', { class: 'title', text: title }, [], doc)], doc),
    h('section', { class: 'card' }, [h('p', { class: 'muted', text: '이 화면은 준비 중이에요.' }, [], doc)], doc),
  ], doc);
}

/** 오류 안내 (오류 번호는 사용자가 캡처로 전달할 수 있게 보인다) */
export function errorView(message, code, doc = globalThis.document) {
  return h('section', { class: 'card error', attrs: { role: 'alert' } }, [
    h('p', { text: message }, [], doc),
    code ? h('p', { class: 'muted small', text: `오류 번호 ${code}` }, [], doc) : null,
  ], doc);
}

/** 규칙·카테고리 세 칸 전환(각자 주소 — 뒤로 가기가 탭을 되돌림, 설계 v0.2 5장). 아직 없는 칸은 누를 수 없다 */
export const RULE_TABS = Object.freeze([
  { screen: 'rules', label: '가맹점 규칙' },
  { screen: 'cprules', label: '이체 상대' },
  { screen: 'categories', label: '카테고리' },
]);

export function rulesTabs(current, doc = globalThis.document) {
  return h('nav', { class: 'rule-tabs', attrs: { 'aria-label': '규칙·카테고리 탭' } }, RULE_TABS.map((t) => (t.screen
    ? h('a', { class: t.screen === current ? 'on' : '', text: t.label, attrs: { href: `#/${t.screen}`, 'aria-current': t.screen === current ? 'page' : null } }, [], doc)
    : h('span', { class: 'off', text: t.label, attrs: { title: t.sub, 'aria-disabled': 'true' } }, [], doc))), doc);
}
