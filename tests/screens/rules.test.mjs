// 가맹점 규칙 모델 (합성 이름만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchNorm, categoryLabels, ruleList, ruleCategoryOptions, checkRule, rulePatch, periodRange, previewSummary, changeLine, applyResult,
  reapplyErrorText, PRIORITY_MAX,
} from '../../app/screens/rules-model.js';
import { INSERT_COLUMNS, UPDATE_COLUMNS, INSERT_TABLES, UPDATE_TABLES, DELETE_TABLES } from '../../app/core/db.js';
import { parseHash } from '../../app/router.js';
import { activeTab, RULE_TABS } from '../../app/screens/shell.js';

const ID = (n) => ['00000000', '0000', '4000', '8000', String(n).padStart(12, '0')].join('-');
const G_FOOD = ID(1);
const C_DINE = ID(11);
const C_CAFE = ID(12);
const C_OFF = ID(13);
const G_INC = ID(9);
const C_PAY = ID(91);
const categories = [
  { id: G_FOOD, parent_id: null, name: '식비', code: 'food', sort_order: 1, is_active: true },
  { id: C_DINE, parent_id: G_FOOD, name: '외식', code: null, sort_order: 2, is_active: true },
  { id: C_CAFE, parent_id: G_FOOD, name: '카페', code: null, sort_order: 1, is_active: true },
  { id: C_OFF, parent_id: G_FOOD, name: '야식', code: null, sort_order: 3, is_active: false },
  { id: G_INC, parent_id: null, name: '수입', code: 'income', sort_order: 9, is_active: true },
  { id: C_PAY, parent_id: G_INC, name: '급여', code: null, sort_order: 1, is_active: true },
];
const cats = categoryLabels(categories);
const rule = (id, o) => ({ id: ID(id), pattern: '커피', match_type: 'contains', category_id: C_CAFE, is_ambiguous: false, priority: 100, is_active: true, created_at: '2026-10-01T00:00:00Z', ...o });

test('정리: DB match_norm과 같게 NFKC + 공백 제거', () => {
  assert.equal(matchNorm(' 동네　커피\t집 '), '동네커피집');
  assert.equal(matchNorm('ＡＢ１'), 'AB1');
});

test('목록: 켜진 것 먼저, 우선 → 만든 순 → id, 꼬리표·제안만·카테고리 꺼짐, 찾기(띄어쓰기 무시·카테고리 이름)', () => {
  const rules = [
    rule(1, { pattern: '꽃집', is_active: false, priority: 1 }),
    rule(2, { pattern: '동네 마트', match_type: 'exact', category_id: C_DINE, created_at: '2026-10-02T00:00:00Z' }),
    rule(3, { pattern: '온라인몰', is_ambiguous: true, category_id: C_DINE }),
    rule(4, { pattern: '쿠팡', priority: 50 }),
    rule(5, { pattern: '야간', category_id: C_OFF }),
    rule(6, { pattern: '^a+$', match_type: 'regex', created_at: '2026-10-03T00:00:00Z' }),
  ];
  const rows = ruleList(rules, cats);
  assert.deepEqual(rows.map((r) => r.title), ['“쿠팡” 포함', '“온라인몰” 포함', '“야간” 포함', '“동네 마트” 일치', '“^a+$” 정규식', '“꽃집” 포함']);
  assert.deepEqual(rows[1].tags, ['검토 대기로']);
  assert.equal(rows[1].target, '→ 식비 · 외식 (제안만)');
  assert.deepEqual(rows[2].tags, ['카테고리 꺼짐']);
  assert.deepEqual([rows[5].tags, rows[5].off], [['꺼짐'], true]);
  assert.deepEqual(ruleList(rules, cats, '동네마트').map((r) => r.title), ['“동네 마트” 일치']);
  assert.deepEqual(ruleList(rules, cats, '외식').map((r) => r.title), ['“온라인몰” 포함', '“동네 마트” 일치']);
});

test('카테고리 고르기: 켜진 지출 항목만, 지금 값이 목록 밖이면 맨 앞에 남김', () => {
  assert.deepEqual(ruleCategoryOptions(categories), [{ group: '식비', items: [{ id: C_CAFE, name: '카페' }, { id: C_DINE, name: '외식' }] }]);
  assert.deepEqual(ruleCategoryOptions(categories, C_OFF)[0], { group: '지금 값', items: [{ id: C_OFF, name: '식비 · 야식 (꺼짐)' }] });
  assert.deepEqual(ruleCategoryOptions(categories, C_PAY)[0].items[0].name, '수입 · 급여');
});

test('입력 검사: 빈 값·공백만·민감번호·방식·카테고리·우선 순서, 한 글자 포함은 경고, 정규식은 원래 패턴·방식', () => {
  const base = { pattern: '커피', matchType: 'contains', categoryId: C_CAFE, isAmbiguous: false, priority: '100' };
  assert.deepEqual(checkRule(base).value, { pattern: '커피', match_type: 'contains', category_id: C_CAFE, is_ambiguous: false, priority: 100 });
  assert.equal(checkRule({ ...base, pattern: '   ' }).field, 'pattern');
  assert.equal(checkRule({ ...base, pattern: '　' }).field, 'pattern');
  const digits = Array.from({ length: 12 }, () => String(1 + Math.floor(Math.random() * 9))).join('');
  assert.equal(checkRule({ ...base, pattern: `송금${digits}` }).ok, false);
  assert.equal(checkRule({ ...base, matchType: 'regex' }).field, 'match');
  assert.equal(checkRule({ ...base, categoryId: '' }).field, 'category');
  for (const p of ['', '-1', '1.5', 'a', String(PRIORITY_MAX + 1)]) assert.equal(checkRule({ ...base, priority: p }).field, 'priority', p);
  assert.equal(checkRule({ ...base, priority: '0' }).value.priority, 0);
  assert.equal(checkRule({ ...base, pattern: '빵' }).warning, '한 글자 규칙은 많은 가맹점에 맞을 수 있어요');
  assert.equal(checkRule({ ...base, pattern: '빵', matchType: 'exact' }).warning, null);
  const re = rule(6, { pattern: '^a+$', match_type: 'regex' });
  const v = checkRule({ ...base, pattern: '바꾸려 함', matchType: 'contains', categoryId: C_DINE }, re);
  assert.deepEqual([v.value.pattern, v.value.match_type, v.value.category_id], ['^a+$', 'regex', C_DINE]);
});

test('바뀐 칸만, 패턴·방식·카테고리가 바뀌면 과거 적용으로', () => {
  const o = rule(1, {});
  assert.deepEqual(rulePatch(o, { pattern: '커피', match_type: 'contains', category_id: C_CAFE, is_ambiguous: false, priority: 50 }), { patch: { priority: 50 }, reapply: false });
  assert.deepEqual(rulePatch(o, { pattern: '커피', match_type: 'exact', category_id: C_CAFE, is_ambiguous: true, priority: 100 }),
    { patch: { match_type: 'exact', is_ambiguous: true }, reapply: true });
});

test('기간: 전체 null, 올해 1월부터, 최근 3개월 = 이번 달 포함 3개월(해 넘김)', () => {
  assert.deepEqual(periodRange('all', '2026-10-01'), { from: null, to: null });
  assert.deepEqual(periodRange('year', '2026-10-01'), { from: '2026-01-01', to: null });
  assert.deepEqual(periodRange('3m', '2026-02-01'), { from: '2025-12-01', to: null });
});

test('미리보기: 바뀌는 수 = 새로 분류 + 바뀜, 결과별 문구, 바뀌는 줄(같은 카테고리 출처만 바뀜은 제안 → 확정)', () => {
  const rows = [
    { txn_id: ID(31), result: 'created', old_category_id: null, new_category_id: C_CAFE, merchant_norm: '커피집' },
    { txn_id: ID(32), result: 'updated', old_category_id: C_DINE, new_category_id: C_CAFE, merchant_norm: '커피로스터리' },
    { txn_id: ID(33), result: 'updated', old_category_id: C_CAFE, new_category_id: C_CAFE, merchant_norm: '동네커피' },
    { txn_id: ID(34), result: 'unchanged', old_category_id: C_CAFE, new_category_id: C_CAFE },
    { txn_id: ID(35), result: 'manual_kept' }, { txn_id: ID(36), result: 'skipped_priority' }, { txn_id: ID(37), result: 'skipped_priority' },
  ];
  const s = previewSummary(rows, cats, rule(1, {}));
  assert.deepEqual([s.changeCount, s.headline], [3, '3건이 바뀌어요']);
  assert.deepEqual(s.counts.map((c) => [c.label, c.count]), [
    ['새로 분류', '1건'], ['다른 카테고리에서 바뀜', '2건'], ['이미 카페', '1건'], ['직접 고친 거래라 그대로', '1건'], ['다른 규칙이 먼저라 그대로', '2건']]);
  assert.equal(previewSummary([], cats, rule(1, {})).headline, '바뀌는 거래가 없어요');
  const detail = { id: ID(31), occurred_on: '2026-10-28', amount: '4500', kind: 'expense', merchant_raw: '커피 집' };
  assert.deepEqual(changeLine(rows[0], detail, cats), { id: ID(31), merchant: '커피 집', sub: '10월 28일 (수) · 4,500원', from: '미분류', to: '카페' });
  assert.deepEqual([changeLine(rows[1], null, cats).merchant, changeLine(rows[1], null, cats).from], ['커피로스터리', '외식']);
  assert.deepEqual([changeLine(rows[2], null, cats).from, changeLine(rows[2], null, cats).to], ['제안', '카페 확정']);
  assert.equal(changeLine(rows[0], { ...detail, kind: 'refund' }, cats).sub, '10월 28일 (수) · −4,500원');
});

test('적용 결과는 적용 반환값으로, 변경 묶음 id, LG007 안내', () => {
  const B = ID(601);
  assert.deepEqual(applyResult([{ result: 'created', change_batch_id: B }, { result: 'unchanged', change_batch_id: B }]), { count: 1, batchId: B, text: '1건 바꿨어요.' });
  assert.deepEqual(applyResult([]), { count: 0, batchId: null, text: '바뀐 거래가 없어요.' });
  assert.match(reapplyErrorText({ code: 'bulk_invalid' }), /기간을 좁혀/);
  assert.equal(reapplyErrorText({ code: 'network' }), null);
});

test('쓰기 허용: category_rules insert·update 칸만(삭제 없음), 정규식은 화면 검사가 막음', () => {
  assert.ok(INSERT_TABLES.includes('category_rules') && UPDATE_TABLES.includes('category_rules'));
  assert.ok(!DELETE_TABLES.includes('category_rules'));
  assert.deepEqual(INSERT_COLUMNS.category_rules, ['pattern', 'match_type', 'category_id', 'is_ambiguous', 'priority', 'created_by']);
  assert.deepEqual(UPDATE_COLUMNS.category_rules, ['pattern', 'match_type', 'category_id', 'is_ambiguous', 'priority', 'is_active']);
});

test('주소·탭: 규칙 화면들, id가 틀리면 목록, 탭은 더보기, 이체 상대 칸은 아직 누를 수 없음', () => {
  assert.equal(parseHash(`#/rule/${ID(1)}`).screen, 'rule');
  assert.equal(parseHash('#/rule/x').screen, 'rules');
  assert.equal(parseHash(`#/reapply/${ID(1)}?period=3m`).query.get('period'), '3m');
  assert.equal(parseHash('#/rulenew').screen, 'rulenew');
  assert.deepEqual(['rules', 'rule', 'rulenew', 'reapply'].map(activeTab), ['more', 'more', 'more', 'more']);
  assert.deepEqual(RULE_TABS.map((t) => t.screen), ['rules', null, 'categories']);
});
