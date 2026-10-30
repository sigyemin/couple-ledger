// 리포트 비중 차트 (CL-059) — 합성 값만, 이름은 가짜
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shareParams, spanRange, spanLabel, shareEntries, shareSlices, pctText, donutArcs, shareAria, DONUT, TOP,
} from '../../app/screens/report-share-model.js';
import { readShareTxns, loadShare } from '../../app/screens/report-share.js';
import { categoryMap } from '../../app/screens/report-model.js';
import { s } from '../../app/ui/svg.js';

const cats = categoryMap([
  { id: 'g1', parent_id: null, name: '식비' }, { id: 'i1', parent_id: 'g1', name: '외식' }, { id: 'i2', parent_id: 'g1', name: '식재료' },
  { id: 'g2', parent_id: null, name: '생활' }, { id: 'i3', parent_id: 'g2', name: '생활용품' },
]);
const crow = (category_id, group_category_id, total_amount, period_month = '2026-10-01') => ({ period_month, category_id, group_category_id, total_amount });

test('주소 값: 기준·기간 기본값, 모르는 값은 기본', () => {
  assert.deepEqual(shareParams(new Map()), { by: 'group', span: 'month' });
  assert.deepEqual(shareParams(new Map([['by', 'owner'], ['span', 'ytd']])), { by: 'owner', span: 'ytd' });
  assert.deepEqual(shareParams(new Map([['by', 'x'], ['span', 'y']])), { by: 'group', span: 'month' });
  assert.deepEqual(spanRange('2026-10-01', 'ytd'), { from: '2026-01-01', to: '2026-10-01' });
  assert.deepEqual(spanRange('2026-10-01', 'month'), { from: '2026-10-01', to: '2026-10-01' });
  assert.deepEqual([spanLabel('2026-10-01', 'ytd'), spanLabel('2026-01-01', 'ytd'), spanLabel('2026-10-01', 'month')], ['1~10월', '1월', '10월']);
});

test('대분류·세부분류 합계: 여러 달 더함(누계), 미분류는 분류 안 됨, 링크', () => {
  const rows = [crow('i1', 'g1', '30000'), crow('i2', 'g1', 20000), crow('i1', 'g1', 10000, '2026-09-01'), crow('i3', 'g2', 5000), crow(null, null, 7000)];
  const g = shareEntries('group', { categoryRows: rows, cats }, '2026-10-01');
  assert.deepEqual(g.map((e) => [e.name, e.amount, e.href]).sort(), [
    ['생활', 5000, '#/rgroup/g2?month=2026-10'], ['식비', 60000, '#/rgroup/g1?month=2026-10'], ['분류 안 됨', 7000, '#/list?month=2026-10&cat=none']].sort());
  const it = shareEntries('item', { categoryRows: rows, cats }, '2026-10-01');
  assert.deepEqual(it.find((e) => e.key === 'i1'), { key: 'i1', name: '식비 › 외식', amount: 40000, none: false, href: '#/ritem/i1?month=2026-10' });
});

test('결제수단·명의 합계: 지출 + 환불 −, 시험·모르는 결제수단 제외, 내역 링크', () => {
  const sources = [
    { id: 's1', label: '가짜카드', owner_member_id: 'm1', is_test: false }, { id: 's2', label: '시험통장', owner_member_id: 'm2', is_test: false },
    { id: 's3', label: '테스트용', owner_member_id: 'm1', is_test: true },
  ];
  const members = [{ id: 'm1', member_slot: 1, display_name: '가람' }, { id: 'm2', member_slot: 2, display_name: '나리' }];
  const txns = [
    { source_id: 's1', kind: 'expense', amount: '50000' }, { source_id: 's1', kind: 'refund', amount: 5000 },
    { source_id: 's2', kind: 'expense', amount: 30000 }, { source_id: 's3', kind: 'expense', amount: 99000 }, { source_id: 'zz', kind: 'expense', amount: 1 },
  ];
  const d = { txns, sources, members };
  assert.deepEqual(shareEntries('source', d, '2026-10-01').map((e) => [e.name, e.amount, e.href]), [
    ['가짜카드', 45000, '#/list?month=2026-10&src=s1'], ['시험통장', 30000, '#/list?month=2026-10&src=s2']]);
  assert.deepEqual(shareEntries('owner', d, '2026-10-01').map((e) => [e.name, e.amount, e.href]), [
    ['가람', 45000, '#/list?month=2026-10&payer=1'], ['나리', 30000, '#/list?month=2026-10&payer=2']]);
});

test('비중 조각: 큰 순, 상위 7 + 그 밖, 분류 안 됨은 따로 맨 끝, 0원 이하는 원에서 빼고 알림', () => {
  const e = (key, amount, none = false) => ({ key, name: `항목${key}`, amount, none, href: `#/x/${key}` });
  const many = [...Array.from({ length: 10 }, (_, i) => e(String(i), (i + 1) * 1000)), e('n', 3000, true), e('neg', -2000)];
  const sl = shareSlices(many);
  assert.equal(sl.slices.length, TOP + 2);
  assert.deepEqual(sl.slices.slice(0, 3).map((x) => [x.name, x.tone]), [['항목9', 'c0'], ['항목8', 'c1'], ['항목7', 'c2']]);
  const etc = sl.slices[TOP];
  assert.deepEqual([etc.name, etc.amount, etc.tone, etc.href, etc.members], ['그 밖 3개', 6000, 'etc', null, ['항목2', '항목1', '항목0']]);
  assert.deepEqual([sl.slices.at(-1).name, sl.slices.at(-1).tone], ['항목n', 'none']);
  assert.equal(sl.total, 58000);
  assert.equal(sl.totalText, '58,000원');
  assert.deepEqual(sl.negatives, { count: 1, amount: -2000 });
  assert.ok(Math.abs(sl.slices.reduce((x, y) => x + y.ratio, 0) - 1) < 1e-9);
  // 묶을 게 하나뿐이면 묶지 않는다(8개 → 8개 그대로)
  const eight = shareSlices(Array.from({ length: 8 }, (_, i) => e(String(i), 1000 + i)));
  assert.equal(eight.slices.some((x) => x.tone === 'etc'), false);
  assert.equal(eight.slices.length, 8);
  assert.deepEqual(shareSlices([]), { total: 0, totalText: '0원', slices: [], negatives: { count: 0, amount: 0 } });
});

test('비율 글자·도넛 위치·읽어 주기 글', () => {
  assert.deepEqual([pctText(0), pctText(0.004), pctText(0.005), pctText(0.456)], ['0%', '1% 미만', '1%', '46%']);
  const sl = shareSlices([{ key: 'a', name: '식비', amount: 75000 }, { key: 'b', name: '생활', amount: 25000 }]);
  const c = 2 * Math.PI * DONUT.r;
  const arcs = donutArcs(sl.slices);
  assert.ok(Math.abs(arcs[0].dash - (c * 0.75 - 1)) < 1e-9);
  assert.ok(Math.abs(arcs[0].dash + arcs[0].rest - c) < 1e-9);
  assert.equal(arcs[0].offset === 0 || Object.is(arcs[0].offset, -0), true);
  assert.ok(Math.abs(arcs[1].offset + c * 0.75) < 1e-9);
  assert.equal(donutArcs([{ ratio: 1, tone: 'c0' }])[0].dash, c); // 하나면 틈 없음
  assert.equal(shareAria('대분류', '10월', sl), '대분류별 10월 지출 100,000원: 식비 75% 75,000원, 생활 25% 25,000원');
  assert.equal(shareAria('명의', '1~10월', shareSlices([])), '명의별 1~10월 지출 없음');
});

test('svg.js: 도넛용 circle·dash 속성 허용, 그 밖은 계속 거부', () => {
  const doc = { createElementNS: (ns, tag) => ({ tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, append() {} }), createTextNode: (t) => t };
  const el = s('circle', { cx: 1, cy: 1, r: 2, 'stroke-dasharray': '1 2', 'stroke-dashoffset': '0', class: 'donut-arc c0' }, [], doc);
  assert.equal(el.attrs['stroke-dasharray'], '1 2');
  assert.throws(() => s('circle', { style: 'x' }, [], doc));
  assert.throws(() => s('path', {}, [], doc));
});

test('조회: 분류 기준은 v_monthly_category(기간), 결제수단·명의는 거래 쪽 읽기(같은 지출 조건)', async () => {
  const calls = [];
  const db = {
    async select(view, o) {
      calls.push([view, o]);
      if (view === 'transactions') return { data: o.range.from === 0 ? [{ id: 't1', source_id: 's1', kind: 'expense', amount: 1 }] : [], error: null };
      return { data: [], error: null };
    },
  };
  await loadShare(db, '2026-10-01', 'item', 'ytd');
  assert.deepEqual(calls[0][1].filters, [{ col: 'period_month', op: 'gte', value: '2026-01-01' }, { col: 'period_month', op: 'lte', value: '2026-10-01' }]);
  assert.equal(calls.some(([v]) => v === 'transactions'), false);
  calls.length = 0;
  const r = await loadShare(db, '2026-10-01', 'owner', 'month');
  assert.deepEqual(r.data.txns.map((x) => x.id), ['t1']);
  assert.deepEqual(calls.find(([v]) => v === 'transactions')[1].filters, [
    { col: 'period_month', op: 'gte', value: '2026-10-01' }, { col: 'period_month', op: 'lte', value: '2026-10-01' },
    { col: 'deleted_at', op: 'is', value: null }, { col: 'is_excluded', op: 'eq', value: false }, { col: 'kind', op: 'in', value: ['expense', 'refund'] }]);
  const bad = { async select(v) { return v === 'transactions' ? { data: null, error: { code: 'network' } } : { data: [], error: null }; } };
  assert.equal((await readShareTxns(bad, '2026-10-01', '2026-10-01')).error.code, 'network');
  assert.equal((await loadShare(bad, '2026-10-01', 'source', 'month')).error.code, 'network');
});
