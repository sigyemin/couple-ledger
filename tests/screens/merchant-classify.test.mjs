// 가맹점별로 분류하기 (CL-061) — 합성 거래만, 이름은 가짜
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merchantGroups, groupSub, ruleFor, classifyText, classifyDescription, isTransferLike } from '../../app/screens/merchant-classify-model.js';
import { readUncategorized } from '../../app/screens/merchant-classify.js';
import { MAX_BULK } from '../../app/screens/list-model.js';
import { parseHash } from '../../app/router.js';
import { activeTab } from '../../app/screens/shell.js';

let n = 0;
const row = (merchant, o = {}) => ({
  id: `t${++n}`, merchant_raw: merchant, merchant_norm: merchant.replace(/\s+/g, ''), kind: 'expense', amount: 1000,
  lines: [], review_status: 'needs_review', source_kind: 'credit_card', card_kind: null, period_month: '2026-09-01',
  is_uncategorized: true, is_test_source: false, ...o,
});

test('묶음: 수입/지출 × 정리값, 건수 큰 순, 환불은 −, 분류된·이체·시험 행 제외, 달 범위', () => {
  const rows = [
    row('가짜 식당'), row('가짜식당', { amount: 3000, period_month: '2026-03-01' }), row('가짜식당', { kind: 'refund', amount: 500 }),
    row('가짜마트', { amount: 9000 }), row('가짜마트', { amount: 1000, review_status: 'confirmed' }),
    row('가짜회사', { kind: 'income', amount: 50000, source_kind: 'bank_account' }),
    row('가짜식당', { is_uncategorized: false }), row('카드대금', { kind: 'transfer' }), row('시험용', { is_test_source: true }),
  ];
  const g = merchantGroups(rows);
  assert.deepEqual(g.map((x) => [x.merchant, x.kind, x.total, x.amount]), [
    ['가짜 식당', 'expense', 3, 3500], ['가짜마트', 'expense', 2, 10000], ['가짜회사', 'income', 1, 50000]]);
  assert.deepEqual(g[0].months, ['2026-03', '2026-09']);
  assert.equal(groupSub(g[0]), '3건 · 3,500원 · 3~9월');
  assert.equal(groupSub(g[2]), '1건 · 50,000원 · 9월');
  assert.deepEqual(g[1].toConfirm.length, 1);
  assert.equal(g[0].canRule, true);
  assert.equal(g[2].canRule, false); // 수입
});

test('통장 이체 행: 이름은 보이되 가맹점 규칙 끔(체크카드 행은 가맹점)', () => {
  assert.equal(isTransferLike({ source_kind: 'bank_account', card_kind: null }), true);
  assert.equal(isTransferLike({ source_kind: 'bank_account', card_kind: 'check_card' }), false);
  assert.equal(isTransferLike({ source_kind: 'credit_card' }), false);
  const g = merchantGroups([row('김가짜', { source_kind: 'bank_account' }), row('가짜카페', { source_kind: 'bank_account', card_kind: 'check_card' })]);
  const kim = g.find((x) => x.merchant === '김가짜');
  assert.deepEqual([kim.transferLike, kim.canRule], [true, false]);
  assert.equal(ruleFor(kim, 'c1').ok, false);
  assert.match(ruleFor(kim, 'c1').message, /이체 상대 규칙/);
  assert.equal(g.find((x) => x.merchant === '가짜카페').canRule, true);
});

test('한 번에 MAX_BULK건까지, 나머지는 안내', () => {
  const many = Array.from({ length: MAX_BULK + 3 }, () => row('가짜편의점'));
  const [g] = merchantGroups(many);
  assert.deepEqual([g.count, g.total, g.ids.length], [MAX_BULK, MAX_BULK + 3, MAX_BULK]);
  assert.match(classifyText(g, '생활용품', false).message, /나머지 3건은 다음에/);
});

test('규칙 값: 원래 이름 · 똑같으면 · 확정 · 기본 우선, 확인 문구·설명', () => {
  const [g] = merchantGroups([row('가짜 식당'), row('가짜식당', { lines: [{}, {}] })]);
  assert.deepEqual(ruleFor(g, 'c1'), { ok: true, warning: null, value: { pattern: '가짜 식당', match_type: 'exact', category_id: 'c1', is_ambiguous: false, priority: 100 } });
  // 줄여 쓰기: 들어가면 모두(같은 브랜드 다른 지점). 이 이름 안의 글자만, 한 글자는 경고
  const br = merchantGroups([row('가짜커피 역삼점')])[0];
  assert.deepEqual(ruleFor(br, 'c1', { contains: '가짜 커피' }).value, { pattern: '가짜 커피', match_type: 'contains', category_id: 'c1', is_ambiguous: false, priority: 100 });
  assert.match(ruleFor(br, 'c1', { contains: '다른가게' }).message, /안에 있는 글자로/);
  assert.equal(ruleFor(br, 'c1', { contains: '  ' }).ok, false);
  assert.ok(ruleFor(br, 'c1', { contains: '커' }).warning);
  assert.match(classifyText(br, '카페', true, ruleFor(br, 'c1', { contains: '가짜커피' }).value).message, /'가짜커피'이\(가\) 들어간 가맹점은 모두/);
  assert.equal(ruleFor(g, '').ok, false);
  const t = classifyText(g, '외식', true);
  assert.match(t.message, /가짜 식당 2건을 '외식'\(으\)로 분류해요/);
  assert.match(t.message, /나눈 거래 1건/);
  assert.match(t.message, /2건은 확인함으로/);
  assert.match(t.message, /자동 분류돼요\(가맹점 규칙\)/);
  assert.doesNotMatch(classifyText(g, '외식', false).message, /가맹점 규칙/);
  assert.equal(classifyDescription(g, '외식'), '가맹점별 분류 · 가짜 식당 2건 → 외식');
  assert.ok(classifyDescription({ ...g, merchant: '가'.repeat(300) }, '외식').length <= 200);
});

test('조회: 미분류·휴지통·시험 수단 조건, 쪽 단위, 넘치면 capped. 주소 #/classify는 더보기 탭', async () => {
  const calls = [];
  const all = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}` }));
  const db = { async select(v, o) { calls.push(o); return { data: all.slice(o.range.from, Math.min(o.range.to + 1, o.range.from + 2)), error: null }; } };
  const r = await readUncategorized(db);
  assert.equal(r.data.rows.length, 5);
  assert.deepEqual(calls[0].filters, [
    { col: 'is_uncategorized', op: 'eq', value: true }, { col: 'deleted_at', op: 'is', value: null }, { col: 'is_test_source', op: 'eq', value: false }]);
  assert.equal((await readUncategorized(db, { max: 3 })).data.capped, true);
  const bad = { async select() { return { data: null, error: { code: 'network' } }; } };
  assert.equal((await readUncategorized(bad)).error.code, 'network');
  assert.equal(parseHash('#/classify').screen, 'classify');
  assert.equal(activeTab('classify'), 'more');
});
