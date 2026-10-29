// 부팅·라우터·홈 화면 모델·DOM 도우미·index.html 규칙 (DB·브라우저 없이)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHash, buildHash, monthParam, addMonths, currentMonth } from '../../app/router.js';
import { buildHomeModel, compareText, settlementText, topGroups, subjectParticle } from '../../app/screens/home-model.js';
import { h, widthClass } from '../../app/ui/dom.js';
import { activeTab, TABS } from '../../app/screens/shell.js';
import * as config from '../../app/config.js';

const ID = 'a0000000-0000-4000-8000-0000000000a1';

test('parseHash: 화면·id·쿼리 형식 검사', () => {
  assert.deepEqual(parseHash('#/home?month=2026-10'), { screen: 'home', id: null, query: new Map([['month', '2026-10']]) });
  assert.equal(parseHash('').screen, 'home');
  assert.equal(parseHash('#/nope').screen, 'home');
  assert.deepEqual(parseHash(`#/txn/${ID}`), { screen: 'txn', id: ID, query: new Map() });
  assert.equal(parseHash('#/txn/../../x').screen, 'list');
  const q = parseHash('#/list?status=needs_review&BAD=1&__proto__=x&status=again&q=%E0%A4%A');
  assert.deepEqual([...q.query], [['status', 'needs_review']]);
  assert.equal(parseHash(`#/list?q=${'a'.repeat(101)}`).query.size, 0);
});

test('buildHash·monthParam·addMonths·currentMonth', () => {
  assert.equal(buildHash('list', { query: { month: '2026-10', q: '가 짜&x' } }), '#/list?month=2026-10&q=%EA%B0%80%20%EC%A7%9C%26x');
  assert.equal(buildHash('txn', { id: ID }), `#/txn/${ID}`);
  assert.equal(parseHash(buildHash('list', { query: { q: '가 짜&x' } })).query.get('q'), '가 짜&x');
  assert.equal(monthParam('2026-10', 'x'), '2026-10-01');
  assert.equal(monthParam('2026-13', 'x'), 'x');
  assert.equal(addMonths('2026-01-01', -1), '2025-12-01');
  assert.equal(addMonths('2026-12-01', 1), '2027-01-01');
  assert.equal(currentMonth(new Date('2026-10-31T15:30:00Z')), '2026-11-01'); // 서울은 이미 11월
});

const members = [{ id: 'm1', member_slot: 1, display_name: '가람' }, { id: 'm2', member_slot: 2, display_name: '나리' }];

test('홈 모델: 지출·비교·정산 문구·할 일·많이 쓴 곳', () => {
  const m = buildHomeModel('2026-10-01', {
    summary: { expense_amount: '1325400', needs_review_count: 18, unlinked_refund_count: 1 },
    prevSummary: { expense_amount: 1407400 },
    settlement: [{ member_id: 'm1', balance_amount: '52300' }, { member_id: 'm2', balance_amount: '-52300' }],
    members,
    missing: [{ label: '시험 카드' }, { label: '시험 통장' }],
    changedMonths: [{ period_month: '2026-09-01', changed_txn_count: 2 }],
    categories: [
      { group_category_id: 'g1', total_amount: '650000' }, { group_category_id: 'g2', total_amount: 300000 },
      { group_category_id: 'g2', total_amount: 12400 }, { group_category_id: null, total_amount: 98300 },
      { group_category_id: 'g3', total_amount: 5000 },
    ],
    categoryNames: new Map([['g1', '주거'], ['g2', '식비'], ['g3', '생활']]),
  });
  assert.equal(m.title, '2026년 10월');
  assert.equal(m.expense, '1,325,400원');
  assert.equal(m.compare, '지난달보다 82,000원 적게 썼어요');
  assert.equal(m.settlement, '가람이 52,300원 더 냄');
  assert.deepEqual(m.todos.map((t) => [t.text, t.href]), [
    ['안 올린 파일 2개', '#/upload'],
    ['검토할 것 18건', '#/list?month=2026-10&status=needs_review'],
    ['원거래를 못 찾은 환불 1건', '#/list?month=2026-10&kind=refund_unlinked'],
    ['9월 확인 후 변경됨', '#/settle?month=2026-09'],
  ]);
  assert.equal(m.todos[0].sub, '시험 카드 · 시험 통장');
  assert.deepEqual(m.groups.map((g) => [g.name, g.amountText, Math.round(g.ratio * 100)]), [['주거', '650,000원', 100], ['식비', '312,400원', 48], ['미분류', '98,300원', 15]]);
});

test('홈 모델: 자료 없음·할 일 없음·같은 금액', () => {
  const m = buildHomeModel('2026-10-01', { summary: null, prevSummary: null, settlement: [], members, missing: [], changedMonths: [], categories: [] });
  assert.deepEqual([m.expense, m.compare, m.settlement, m.todos.length, m.groups.length], ['0원', null, '정산 차이 없어요', 0, 0]);
  assert.equal(compareText(1000, 1000), '지난달과 같게 썼어요');
  assert.equal(compareText(2000, 1000), '지난달보다 1,000원 많이 썼어요');
  assert.equal(settlementText([{ member_id: 'm2', balance_amount: 10 }], members), '나리가 10원 더 냄');
  assert.deepEqual([subjectParticle('민'), subjectParticle('뽀'), subjectParticle('A')], ['이', '가', '이']);
  assert.deepEqual(topGroups([{ group_category_id: 'x', total_amount: -5 }], new Map()), []);
});

test('DOM 도우미: style·on* 속성과 외부 링크를 거부한다', () => {
  const made = [];
  const doc = {
    createElement(tag) {
      const el = { tag, attrs: {}, kids: [], setAttribute(k, v) { this.attrs[k] = v; }, append(c) { this.kids.push(c); }, addEventListener() {} };
      made.push(el);
      return el;
    },
    createTextNode(t) { return { text: t }; },
  };
  const el = h('a', { class: 'x', text: '<b>글</b>', attrs: { href: '#/home', 'aria-label': '홈' } }, ['둘', null], doc);
  assert.equal(el.textContent, '<b>글</b>');
  assert.equal(el.attrs.href, '#/home');
  assert.throws(() => h('a', { attrs: { href: 'https://example.invalid' } }, [], doc));
  assert.throws(() => h('a', { attrs: { href: 'javascript:alert(1)' } }, [], doc));
  assert.throws(() => h('div', { attrs: { style: 'color:red' } }, [], doc));
  assert.throws(() => h('div', { attrs: { onclick: 'x()' } }, [], doc));
  assert.deepEqual([widthClass(0.48), widthClass(2), widthClass(-1), widthClass('x')], ['w-50', 'w-100', 'w-0', 'w-0']);
});

test('탭 5개, 거래 상세는 내역 탭', () => {
  assert.deepEqual(TABS.map((t) => t.label), ['홈', '내역', '올리기', '정산', '더보기']);
  assert.equal(activeTab('txn'), 'list');
});

test('index.html: CSP가 head 첫 요소, 인라인 스크립트·스타일 없음, vendor SRI 일치', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const head = html.split('<head>')[1];
  assert.match(head.trimStart(), /^<meta http-equiv="Content-Security-Policy"/);
  const csp = /content="([^"]+)"/.exec(head)[1];
  for (const d of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "worker-src 'self'", "require-trusted-types-for 'script'",
    'trusted-types cl-worker', "base-uri 'none'", "object-src 'none'", "form-action 'none'"]) {
    assert.ok(csp.includes(d), d);
  }
  assert.ok(!/unsafe-|\*/.test(csp));
  assert.ok(!/<script>(?!<\/script>)|<script(?![^>]*\bsrc=)/.test(html), '인라인 스크립트 없음');
  assert.ok(!/<style|style=|\son[a-z]+=/i.test(html), '인라인 스타일·이벤트 속성 없음');
  const sri = JSON.parse(readFileSync(new URL('../../vendor/integrity.json', import.meta.url), 'utf8'))['supabase-js-2.118.0/supabase.js'].sri;
  assert.ok(html.includes(`integrity="${sri}"`));
});

test('app/ 소스: innerHTML·eval·new Function·style 속성 문자열 없음', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(`${d}/${n}`).isDirectory() ? walk(`${d}/${n}`) : [`${d}/${n}`]));
  const appDir = new URL('../../app', import.meta.url).pathname;
  for (const f of walk(appDir).filter((p) => p.endsWith('.js'))) {
    const src = readFileSync(f, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|\beval\(|new Function\(|document\.write/.test(src), f);
  }
});

test('config.js: 주소는 https supabase.co, 키는 공개용(publishable)만 (비어 있으면 사용자가 아직 안 넣음)', () => {
  assert.equal(typeof config.SUPABASE_URL, 'string');
  if (config.SUPABASE_URL) assert.match(config.SUPABASE_URL, /^https:\/\/[a-z0-9]+\.supabase\.co$/);
  // CSP connect-src의 Supabase 주소: 설정 전에는 자리표시자, 설정 뒤에는 config와 같은 주소 하나
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const hosts = html.match(/https:\/\/[a-z0-9-]+\.supabase\.co/g);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0], config.SUPABASE_URL || 'https://project-ref.supabase.co');
  if (config.SUPABASE_PUBLISHABLE_KEY) assert.match(config.SUPABASE_PUBLISHABLE_KEY, /^sb_publishable_/);
  assert.equal(config.APP_STORAGE_PREFIX, 'cl-');
});
