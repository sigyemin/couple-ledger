// 리포트 모델·SVG 도우미 (합성 이름만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shortWon, sixMonths, series, barChart, diffView, categoryMap, compareGroups, groupView, itemTxns, incomeView, incomeCompareText, CHART,
} from '../../app/screens/report-model.js';
import { s, SVG_NS } from '../../app/ui/svg.js';
import { parseHash } from '../../app/router.js';
import { activeTab } from '../../app/screens/shell.js';

const ID = (n) => ['00000000', '0000', '4000', '8000', String(n).padStart(12, '0')].join('-');
const G_FOOD = ID(1);
const G_LIFE = ID(2);
const C_DINE = ID(11);
const C_GROC = ID(12);
const C_OLD = ID(13);
const G_INC = ID(9);
const C_PAY = ID(91);
const cats = categoryMap([
  { id: G_FOOD, parent_id: null, name: '식비', is_active: true },
  { id: G_LIFE, parent_id: null, name: '생활', is_active: true },
  { id: C_DINE, parent_id: G_FOOD, name: '외식', is_active: true },
  { id: C_GROC, parent_id: G_FOOD, name: '식재료', is_active: true },
  { id: C_OLD, parent_id: G_FOOD, name: '야식', is_active: false },
  { id: G_INC, parent_id: null, name: '수입', is_active: true },
  { id: C_PAY, parent_id: G_INC, name: '급여', is_active: true },
]);
const OCT = '2026-10-01';
const SEP = '2026-09-01';
const K = 1000;
const row = (period_month, category_id, group_category_id, total_amount) => ({ period_month, category_id, group_category_id, total_amount: String(total_amount) });

test('차트 글자 축약: 100만 이상 정수 만, 아래는 소수 한 자리, 0, 음수', () => {
  const big = 1325 * K + 400;
  assert.deepEqual([shortWon(big), shortWon(298000), shortWon(4500), shortWon(0), shortWon(-12900)], ['133만', '29.8만', '0.5만', '0', '−1.3만']);
});

test('6개월: 해 넘김, 없는 달 0, 막대 높이는 최대 기준·음수는 0, 고른 달 표시, 읽기 글에 모든 값', () => {
  const months = sixMonths('2026-02-01');
  assert.deepEqual(months, ['2025-09-01', '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01']);
  const pts = series(months, (m) => ({ '2025-10-01': 50000, '2026-02-01': 100000, '2025-12-01': -3000 })[m]);
  const c = barChart(pts, '2026-02-01', '지출');
  assert.deepEqual(c.bars.map((b) => b.h), [0, (CHART.base - CHART.top) / 2, 0, 0, 0, CHART.base - CHART.top]);
  assert.deepEqual(c.bars.map((b) => b.on), [false, false, false, false, false, true]);
  assert.equal(c.bars[5].y, CHART.top);
  assert.match(c.aria, /^지출 최근 6개월: 9월 0원, 10월 50,000원, 11월 0원, 12월 −3,000원, 1월 0원, 2월 100,000원$/);
});

test('차이 글자: 늘어남 +, 줄어듦 −, 같음, 지난달 자료 없음', () => {
  assert.deepEqual([diffView(2200), diffView(-28800), diffView(0), diffView(5, false)].map((d) => [d.text, d.tone]),
    [['+2,200원', 'up'], ['−28,800원', 'down'], ['같음', 'same'], ['', 'none']]);
});

test('지난달과 비교: 그룹 합산, 큰 순, 미분류 맨 끝(내역 미분류로), 둘 다 0이면 숨김, 막대는 가장 큰 차이 기준', () => {
  const cur = [row(OCT, C_DINE, G_FOOD, 96500), row(OCT, C_GROC, G_FOOD, 168900), row(OCT, null, null, 4500), row(OCT, ID(21), G_LIFE, 0)];
  const prev = [row(SEP, C_DINE, G_FOOD, 110200), row(SEP, C_GROC, G_FOOD, 176000), row(SEP, ID(21), G_LIFE, 0)];
  const g = compareGroups(cur, prev, cats, OCT);
  assert.deepEqual(g.map((x) => [x.name, x.amountText, x.diff.text]), [['식비', '265,400원', '−20,800원'], ['미분류', '4,500원', '+4,500원']]);
  assert.equal(g[0].href, `#/rgroup/${G_FOOD}?month=2026-10`);
  assert.equal(g[1].href, '#/list?month=2026-10&cat=none');
  assert.deepEqual([g[0].bar.tone, g[0].bar.w, g[0].bar.x + g[0].bar.w], ['down', 58, 60]);
  assert.equal(g[1].bar.tone, 'up');
  assert.equal(compareGroups(cur, [], cats, OCT, { hasPrev: false })[0].bar, null);
});

test('그룹 펼치기: 6개월 합, 지난달 비교·전체 비율, 그룹 자체 라인은 "(그룹 전체)", 꺼진 항목 꼬리표, 항목 링크', () => {
  const rows = [
    row(OCT, C_DINE, G_FOOD, 96500), row(OCT, C_GROC, G_FOOD, 168900), row(OCT, G_FOOD, G_FOOD, 20000), row(OCT, C_OLD, G_FOOD, 5000),
    row(SEP, C_DINE, G_FOOD, 110200), row(SEP, C_GROC, G_FOOD, 176000),
    row('2026-05-01', C_DINE, G_FOOD, 1000),
  ];
  const v = groupView(rows, G_FOOD, OCT, cats, { totalExpense: 1000000 });
  assert.equal(v.amountText, '290,400원');
  assert.equal(v.sub, '지난달보다 4,200원 많이 썼어요 · 전체 지출의 29%');
  assert.deepEqual(v.points.map((p) => p.value), [K, 0, 0, 0, 286.2 * K, 290.4 * K]);
  assert.deepEqual(v.items.map((i) => [i.name, i.pctText, i.diff.text, i.off]), [
    ['식재료', '58%', '−7,100원', false], ['외식', '33%', '−13,700원', false], ['식비(그룹 전체)', '7%', '+20,000원', false], ['야식', '2%', '+5,000원', true]]);
  assert.equal(v.items[0].href, `#/ritem/${C_GROC}?month=2026-10`);
  assert.equal(groupView(rows, G_FOOD, OCT, cats, { hasPrev: false }).sub, '');
});

test('항목 거래: 몫 금액·합계, 나눈 거래, 원거래 따르는 환불, 환불 있는 원거래, 못 찾은 행 수', () => {
  const PAYER = ID(70);
  const d = (id, kind, amount, extra = {}) => ({
    id, kind, amount: String(amount), merchant_raw: `가게${id.slice(-2)}`, source_label: '시험카드', payer_member_id: PAYER, payer_name: '가람',
    occurred_on: '2026-10-05', lines: [], refund_of_txn_id: null, is_excluded: false, ...extra,
  });
  const detail = [
    d(ID(31), 'expense', 38000, { lines: [{ category_id: C_DINE, amount: 38000 }] }),
    d(ID(32), 'expense', 52000, { lines: [{ category_id: C_DINE, amount: 36000 }, { category_id: C_GROC, amount: 16000 }] }),
    d(ID(33), 'expense', 15000, { lines: [{ category_id: C_DINE, amount: 15000 }] }),
    d(ID(34), 'refund', 5000, { refund_of_txn_id: ID(33) }),
  ];
  const shares = [
    { txn_id: ID(31), signed_amount: '38000' }, { txn_id: ID(32), signed_amount: '36000' },
    { txn_id: ID(33), signed_amount: '15000' }, { txn_id: ID(34), signed_amount: '-5000' }, { txn_id: ID(35), signed_amount: '1000' },
  ];
  const it = itemTxns(shares, detail, C_DINE, cats, new Map([[PAYER, 1]]));
  assert.deepEqual([it.totalText, it.count, it.missing], ['85,000원', 5, 1]);
  assert.deepEqual(it.rows.map((r) => [r.view.amountText, r.view.sub, r.view.tags, r.view.tone]), [
    ['38,000원', '외식 · 시험카드', [], 'expense'],
    ['36,000원', '외식 몫 · 거래 전체 52,000원', ['나눈 거래'], 'expense'],
    ['15,000원', '외식 · 시험카드 · 환불 5,000원 있음', [], 'expense'],
    ['−5,000원', '외식(원거래) · 시험카드', ['환불'], 'refund'],
  ]);
  assert.deepEqual(it.rows[0].view.payer, { initial: '가', name: '가람', slot: 1 });
});

test('수입: 카테고리별(미분류 끝)·차이, 구성원별(자리 순, 0원 숨김), 비교 문구', () => {
  const A = ID(71);
  const B = ID(72);
  const cur = [
    { period_month: OCT, category_id: C_PAY, member_id: A, total_amount: '60000' },
    { period_month: OCT, category_id: null, member_id: A, total_amount: '40000' },
    { period_month: OCT, category_id: C_PAY, member_id: B, total_amount: '50000' },
  ];
  const prev = [{ period_month: SEP, category_id: C_PAY, member_id: A, total_amount: '110000' }];
  const members = [{ id: B, member_slot: 2, display_name: '나리' }, { id: A, member_slot: 1, display_name: '가람' }, { id: ID(73), member_slot: 3, display_name: '다솜' }];
  const v = incomeView(cur, prev, cats, members);
  assert.deepEqual(v.byCategory.map((c) => [c.name, c.amountText, c.diff.text]), [['급여', '110,000원', '같음'], ['미분류', '40,000원', '+40,000원']]);
  assert.deepEqual(v.byMember.map((m) => [m.name, m.amountText]), [['가람', '100,000원'], ['나리', '50,000원']]);
  assert.deepEqual([incomeCompareText(150 * K, 110 * K), incomeCompareText(1, 2), incomeCompareText(5, 5), incomeCompareText(5, null)],
    ['지난달보다 40,000원 더 들어왔어요', '지난달보다 1원 덜 들어왔어요', '지난달과 같아요', null]);
});

test('주소: 리포트 세 화면, id가 틀리면 리포트로, 탭은 더보기', () => {
  assert.deepEqual(parseHash(`#/rgroup/${G_FOOD}?month=2026-10`).screen, 'rgroup');
  assert.deepEqual(parseHash(`#/ritem/${C_DINE}`).id, C_DINE);
  assert.deepEqual(parseHash('#/ritem/not-an-id').screen, 'report');
  assert.deepEqual(['report', 'rgroup', 'ritem'].map(activeTab), ['more', 'more', 'more']);
});

test('SVG 도우미: 네임스페이스로 만들고, 허용 안 한 태그·속성은 거부', () => {
  const made = [];
  const doc = {
    createElementNS(ns, tag) {
      const el = { ns, tag, attrs: {}, kids: [], setAttribute(k, v) { this.attrs[k] = v; }, append(c) { this.kids.push(c); } };
      made.push(el);
      return el;
    },
    createTextNode: (t) => ({ text: t }),
  };
  const el = s('text', { x: 3, class: 'v', 'text-anchor': 'middle' }, ['12만'], doc);
  assert.deepEqual([el.ns, el.tag, el.attrs, el.kids], [SVG_NS, 'text', { x: '3', class: 'v', 'text-anchor': 'middle' }, [{ text: '12만' }]]);
  assert.throws(() => s('script', {}, [], doc), /태그/);
  assert.throws(() => s('a', {}, [], doc), /태그/);
  for (const k of ['onload', 'style', 'href', 'xlink:href']) assert.throws(() => s('rect', { [k]: 'x' }, [], doc), /속성/);
});
