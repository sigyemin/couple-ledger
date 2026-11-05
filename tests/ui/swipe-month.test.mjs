// 좌우로 밀어 달 넘기기 (CL-074) — 부품 단위(가짜 요소·가짜 문서)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { swipeDecision, isBlockedTarget, monthLinks, installMonthSwipe, MIN_RATIO, VERTICAL_FACTOR, MAX_MS } from '../../app/ui/swipe-month.js';

const W = 390;

test('넘기기 판정: 폭의 20% 이상·가로가 세로의 2배 이상·짧은 시간, 왼쪽 = 다음 달, 오른쪽 = 이전 달', () => {
  const min = W * MIN_RATIO;
  assert.equal(swipeDecision({ dx: -min, dy: 0, ms: 200, width: W }), 'next');
  assert.equal(swipeDecision({ dx: min, dy: 0, ms: 200, width: W }), 'prev');
  assert.equal(swipeDecision({ dx: -(min - 1), dy: 0, ms: 200, width: W }), null, '임계값 미만');
  assert.equal(swipeDecision({ dx: -120, dy: 120 / VERTICAL_FACTOR + 1, ms: 200, width: W }), null, '세로가 크면(세로 스크롤 우선)');
  assert.equal(swipeDecision({ dx: -120, dy: 120 / VERTICAL_FACTOR, ms: 200, width: W }), 'next', '딱 2배면 넘김');
  assert.equal(swipeDecision({ dx: -200, dy: 0, ms: MAX_MS + 1, width: W }), null, '느린 끌기는 아님');
  assert.equal(swipeDecision({ dx: -200, dy: 0, ms: 100, width: 0 }), null);
});

// 가짜 요소: matches(선택자 목록 중 자기 태그·속성), 부모, 스크롤 크기
function el(tag, { parent = null, attrs = {}, cls = [], scroll = null, ox = 'visible' } = {}) {
  const e = {
    nodeType: 1, tagName: tag, parentElement: parent, attrs, cls, ox,
    scrollWidth: scroll ? scroll[0] : 100, clientWidth: scroll ? scroll[1] : 100,
    matches(sel) {
      return sel.split(',').map((x) => x.trim()).some((x) => {
        if (x === tag) return true;
        if (x.startsWith('.') && cls.includes(x.slice(1))) return true;
        if (x === `${tag}.${cls[0]}` && cls.length) return true;
        if (x === '[data-no-swipe]' && 'data-no-swipe' in attrs) return true;
        if (x.startsWith('[contenteditable') && attrs.contenteditable === 'true') return true;
        return false;
      });
    },
  };
  return e;
}
const win = { getComputedStyle: (n) => ({ overflowX: n.ox }) };

test('막는 곳: 입력칸·select·textarea·대화상자 안·끌기 손잡이·차트·가로 스크롤 영역·data-no-swipe, 보통 글·카드는 넘김', () => {
  const main = el('main');
  const card = el('section', { parent: main });
  assert.equal(isBlockedTarget(el('p', { parent: card }), win), false);
  for (const t of ['input', 'select', 'textarea', 'svg', 'canvas']) assert.equal(isBlockedTarget(el(t, { parent: card }), win), true, t);
  assert.equal(isBlockedTarget(el('rect', { parent: el('svg', { parent: card }) }), win), true, '차트 안');
  assert.equal(isBlockedTarget(el('button', { parent: el('dialog', { parent: main }) }), win), true, '대화상자 안');
  assert.equal(isBlockedTarget(el('span', { parent: card, cls: ['cat-handle'] }), win), true, '끌기 손잡이');
  assert.equal(isBlockedTarget(el('div', { parent: card, attrs: { 'data-no-swipe': '' } }), win), true);
  const table = el('div', { parent: card, scroll: [800, 300], ox: 'auto' });
  assert.equal(isBlockedTarget(el('td', { parent: table }), win), true, '가로로 스크롤되는 표 안');
  const chipsFit = el('div', { parent: card, scroll: [300, 300], ox: 'auto' });
  assert.equal(isBlockedTarget(el('a', { parent: chipsFit }), win), false, '넘치지 않는 칩 줄은 넘김');
  const clipped = el('div', { parent: card, scroll: [800, 300], ox: 'hidden' });
  assert.equal(isBlockedTarget(el('p', { parent: clipped }), win), false, '스크롤 안 되는 넘침은 넘김');
});

// 가짜 문서: 터치 리스너 모음 + 달 링크
function fakeDoc({ hasNav = true, dialogOpen = false } = {}) {
  const ls = {};
  const link = (href) => ({ getAttribute: (k) => (k === 'href' ? href : null) });
  const prev = link('#/home?month=2026-10');
  const next = link('#/home?month=2026-12');
  const mainEl = { classList: { set: new Set(), toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, remove(...c) { c.forEach((x) => this.set.delete(x)); } } };
  const nav = { querySelector: (s) => (s.includes('이전 달') ? prev : next) };
  return {
    ls, mainEl,
    addEventListener(t, fn, o) { ls[t] = fn; assert.equal(o.passive, true, '터치는 passive(preventDefault 안 함)'); },
    removeEventListener(t) { delete ls[t]; },
    querySelector(s) {
      if (s === 'dialog[open]') return dialogOpen ? {} : null;
      if (s.includes('month-nav')) return hasNav ? nav : null;
      if (s === 'main.screen') return mainEl;
      return null;
    },
  };
}
function fakeWin(now) {
  return { innerWidth: W, location: { hash: '#/home' }, getSelection: () => '', matchMedia: () => ({ matches: false }), getComputedStyle: () => ({ overflowX: 'visible' }), setTimeout: () => 0, now };
}
const target = el('p', { parent: el('main') });
const touch = (x, y) => ({ clientX: x, clientY: y });

test('설치: 왼쪽으로 밀면 다음 달 링크 주소로(뒤로가기 같은 흐름), 미는 동안 기울기 클래스, 놓으면 지움', () => {
  const doc = fakeDoc();
  const w = fakeWin();
  installMonthSwipe(doc, w);
  doc.ls.touchstart({ touches: [touch(300, 400)], target });
  doc.ls.touchmove({ touches: [touch(250, 405)] });
  assert.ok(doc.mainEl.classList.set.has('swipe-left'));
  doc.ls.touchend({ changedTouches: [touch(200, 410)] });
  assert.equal(w.location.hash, '#/home?month=2026-12');
  assert.equal(doc.mainEl.classList.set.size, 0);
  doc.ls.touchstart({ touches: [touch(100, 400)], target });
  doc.ls.touchend({ changedTouches: [touch(220, 400)] });
  assert.equal(w.location.hash, '#/home?month=2026-10', '오른쪽 = 이전 달');
});

test('설치: 세로 스크롤·짧은 밀기·막는 곳·대화상자·달 링크 없는 화면·두 손가락·글자 선택이면 그대로', () => {
  const run = (o, start, end, extra = {}) => {
    const doc = fakeDoc(o);
    const w = { ...fakeWin(), ...extra };
    installMonthSwipe(doc, w);
    doc.ls.touchstart({ touches: start.touches ?? [start], target: start.target ?? target });
    doc.ls.touchend({ changedTouches: [end] });
    return w.location.hash;
  };
  assert.equal(run({}, touch(300, 100), touch(200, 400)), '#/home', '세로가 큼');
  assert.equal(run({}, touch(300, 400), touch(260, 400)), '#/home', '짧음');
  assert.equal(run({}, { ...touch(300, 400), target: el('input', { parent: target }) }, touch(100, 400)), '#/home', '입력칸');
  assert.equal(run({ dialogOpen: true }, touch(300, 400), touch(100, 400)), '#/home', '대화상자 열림');
  assert.equal(run({ hasNav: false }, touch(300, 400), touch(100, 400)), '#/home', '달 링크 없는 화면');
  assert.equal(run({}, { touches: [touch(300, 400), touch(320, 420)] }, touch(100, 400)), '#/home', '두 손가락');
  assert.equal(run({}, touch(300, 400), touch(100, 400), { getSelection: () => '글자' }), '#/home', '글자 선택 중');
});

test('움직임 줄이기면 기울지 않음, 넘긴 뒤 새 화면 달 이름 강조', () => {
  const doc = fakeDoc();
  const w = { ...fakeWin(), matchMedia: () => ({ matches: true }) };
  const sw = installMonthSwipe(doc, w);
  doc.ls.touchstart({ touches: [touch(300, 400)], target });
  doc.ls.touchmove({ touches: [touch(200, 400)] });
  assert.equal(doc.mainEl.classList.set.size, 0);
  doc.ls.touchend({ changedTouches: [touch(150, 400)] });
  const added = [];
  const title = { classList: { add: (c) => added.push(c), remove() {} } };
  sw.rendered({ querySelector: () => title });
  assert.deepEqual(added, ['month-flash']);
  sw.rendered({ querySelector: () => title });
  assert.deepEqual(added, ['month-flash'], '넘긴 직후 한 번만');
});

test('소스: 인라인 style·innerHTML 없음, main.js가 한 번 달고 그린 뒤 알림', () => {
  const s = readFileSync(new URL('../../app/ui/swipe-month.js', import.meta.url), 'utf8');
  assert.doesNotMatch(s, /\.style\b|innerHTML|preventDefault\(/);
  const m = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  assert.match(m, /const swipe = installMonthSwipe\(document, window\);/);
  assert.match(m, /swipe\.rendered\(view\);/);
});
