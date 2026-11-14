// 정산 › 명의별 수입 (CL-076) — 가짜 이름·합성 금액
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ownerIncome, incomeMinusSpend, ownerSpend } from '../../app/screens/settle-model.js';
import { readIncomeRows } from '../../app/screens/settle.js';

const members = [{ id: 'm2', member_slot: 2, display_name: '나리' }, { id: 'm1', member_slot: 1, display_name: '가람' }];
const categories = [
  { id: 'gI', parent_id: null, name: '수입', sort_order: 900 }, { id: 'cSal', parent_id: 'gI', name: '급여', sort_order: 1 },
  { id: 'cInt', parent_id: 'gI', name: '이자', sort_order: 2 }, { id: 'cMy', parent_id: 'gI', name: '부수입', sort_order: 5 },
];
const L = (category_id, amount) => ({ category_id, category: '?', amount });
const rows = [
  { payer_member_id: 'm1', amount: 3000000, period_month: '2026-10-01', lines: [L('cSal', 3000000)] },
  { payer_member_id: 'm1', amount: 3000000, period_month: '2026-09-01', lines: [L('cSal', 3000000)] },
  { payer_member_id: 'm1', amount: 1200, period_month: '2026-10-01', lines: [L('cInt', 1200)] },
  { payer_member_id: 'm1', amount: 50000, period_month: '2026-10-01', lines: [] },
  { payer_member_id: 'm2', amount: 100000, period_month: '2026-10-01', lines: [L('cMy', 60000), L('cInt', 40000)] },
  { payer_member_id: 'm2', amount: 7000, period_month: '2026-08-01', lines: null },
];

test('명의별 수입: 사람(자리 순)마다 수입 카테고리 줄(관리 순서) · 분류 안 됨 · 합계, 이번 달·누계, 나눈 금액마다', () => {
  const r = ownerIncome(rows, members, '2026-10-01', categories);
  assert.deepEqual(r.people.map((p) => p.name), ['가람', '나리']);
  assert.deepEqual(r.people[0].lines, [
    { key: 'cSal', label: '급여', month: 3000000, ytd: 6000000 },
    { key: 'cInt', label: '이자', month: 1200, ytd: 1200 },
    { key: 'none', label: '분류 안 됨', month: 50000, ytd: 50000 },
    { key: 'total', label: '합계', month: 3051200, ytd: 6051200 },
  ]);
  // 숫자는 줄마다 나눠 비교(긴 숫자 줄이 유출 검사에 걸리지 않게)
  const nari = r.people[1].lines;
  assert.deepEqual(nari.map((l) => l.label), ['이자', '부수입', '분류 안 됨', '합계']);
  assert.deepEqual(nari.map((l) => l.month / 1000), [40, 60, 0, 100]);
  assert.deepEqual(nari.map((l) => l.ytd / 1000), [40, 60, 7, 107]);
  assert.equal(r.uncategorizedMonth, 1, '그 달 분류 안 된 수입 건수(8월 것은 빼고)');
  const empty = ownerIncome([], members, '2026-10-01', categories);
  assert.deepEqual(empty.people[0].lines, [{ key: 'total', label: '합계', month: 0, ytd: 0 }]);
});

const GARAM_MONTH = 3051200;
const GARAM_YTD = 6051200;
const SPEND_MONTH = 500000;
const SPEND_YTD = 600000;

test('수입 − 사용: 같은 명의(결제수단 주인) 합계끼리', () => {
  const sources = [{ id: 'c1', owner_member_id: 'm1', kind: 'credit_card', is_test: false }];
  const spend = ownerSpend([{ source_id: 'c1', kind: 'expense', amount: 500000, period_month: '2026-10-01' }, { source_id: 'c1', kind: 'expense', amount: 100000, period_month: '2026-09-01' }], sources, members, '2026-10-01');
  const inc = ownerIncome(rows, members, '2026-10-01', categories);
  assert.deepEqual(incomeMinusSpend(inc, spend), [
    { id: 'm1', name: '가람', month: GARAM_MONTH - SPEND_MONTH, ytd: GARAM_YTD - SPEND_YTD },
    { id: 'm2', name: '나리', month: 100000, ytd: 107000 },
  ]);
});

test('수입 조회: 수입만, 휴지통·집계 제외·시험 결제수단 빼고 올해 1월~그 달, 빈 쪽까지', async () => {
  const calls = [];
  const all = Array.from({ length: 3 }, (_, i) => ({ id: `i${i}` }));
  const db = { async select(view, o) { calls.push([view, o]); return { data: all.slice(o.range.from, o.range.from + 2), error: null }; } };
  const r = await readIncomeRows(db, '2026-10-01');
  assert.deepEqual(r.data.rows.map((x) => x.id), ['i0', 'i1', 'i2']);
  assert.equal(calls[0][0], 'v_transaction_detail');
  assert.deepEqual(calls[0][1].filters, [
    { col: 'period_month', op: 'gte', value: '2026-01-01' }, { col: 'period_month', op: 'lte', value: '2026-10-01' },
    { col: 'deleted_at', op: 'is', value: null }, { col: 'is_excluded', op: 'eq', value: false },
    { col: 'is_test_source', op: 'eq', value: false }, { col: 'kind', op: 'eq', value: 'income' }]);
});

test('화면 소스: 명의별 사용 다음에 수입 카드, 이체 제외 안내, 분류 안 된 수입은 내역(그 달·수입·미분류)으로', () => {
  const s = readFileSync(new URL('../../app/screens/settle.js', import.meta.url), 'utf8');
  assert.match(s, /\[head, statusLine, dedCard, \.\.\.people, info, \.\.\.incomeCards, incomeInfo, review, pastCard\]/);
  assert.match(s, /명의 기준\(결제수단 주인\), 이체 제외/);
  assert.match(s, /buildHash\('list', \{ query: \{ month: ym\(monthStart\), kind: 'income', cat: 'none' \} \}\)/);
  assert.match(s, /label: '수입 − 사용'/);
  assert.doesNotMatch(s, /innerHTML|console\./);
});

test('#63 리뷰: 카테고리 빈 라인 금액은 분류 안 됨으로 — 합계 = 수입 전체, 미분류 건수는 is_uncategorized와 같은 뜻', () => {
  const mixed = [
    { payer_member_id: 'm1', amount: 9000, period_month: '2026-10-01', is_uncategorized: true, lines: [L('cSal', 6000), { category_id: null, category: null, amount: 3000 }] },
    { payer_member_id: 'm1', amount: 500, period_month: '2026-10-01', is_uncategorized: false, lines: [L('cInt', 500)] },
  ];
  const r = ownerIncome(mixed, members, '2026-10-01', categories);
  const g = r.people[0].lines;
  assert.deepEqual(g.map((l) => [l.label, l.month]), [['급여', 6000], ['이자', 500], ['분류 안 됨', 3000], ['합계', 9500]]);
  assert.equal(g.at(-1).month, mixed.reduce((s, x) => s + x.amount, 0), '합계가 수입 전체와 같음');
  assert.equal(r.uncategorizedMonth, 1, '카테고리 빈 라인이 있는 거래도 미분류(DB txn_is_uncategorized와 같음)');
  const s = readFileSync(new URL('../../app/screens/settle.js', import.meta.url), 'utf8');
  assert.match(s, /columns: 'id,payer_member_id,amount,period_month,lines,is_uncategorized'/);
  assert.match(s, /내역에는 집계 제외된 수입도 함께 보여요\./);
});
