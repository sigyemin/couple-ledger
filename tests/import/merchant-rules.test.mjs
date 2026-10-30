// 업로드 때 가맹점 규칙 적용(CL-044, 사용자 결정 U-16 A안) — 합성 값만
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortCategoryRules, categoryRuleMatches, pickCategoryRule, toRpcRows } from '../../app/import/normalize.js';
import { parseFile } from '../../app/import/pipeline.js';
import { previewOf, previewLines, reviewText } from '../../app/screens/upload-model.js';
import { XLSX, SOURCE, CAT_ID, FORMAT_A, FORMAT_B, bookBytes, sheetA, sheetB } from './fixtures.mjs';

const CAT_2 = 'c0000000-0000-4000-8000-0000000000c2';
const CAT_3 = 'c0000000-0000-4000-8000-0000000000c3';
const rule = (id, pattern, extra = {}) => ({
  id, pattern, match_type: 'contains', category_id: CAT_ID, is_ambiguous: false, priority: 100,
  is_active: true, created_at: '2026-10-01T00:00:00Z', categoryActive: true, ...extra,
});

test('일치 판정은 DB category_rule_matches와 같다(공백·전각 정리, 빈 패턴, 비활성, regex 판정 안 함)', () => {
  assert.equal(categoryRuleMatches(rule('r1', '가짜 식당'), '가짜식당본점'), true);
  assert.equal(categoryRuleMatches(rule('r1', 'ＡＢＣ'), '가짜ABC'), true); // NFKC
  assert.equal(categoryRuleMatches(rule('r1', 'abc'), '가짜ABC'), false); // 대소문자 그대로(DB도 lower 없음)
  assert.equal(categoryRuleMatches(rule('r1', ' \t'), '가짜식당'), false); // 정리하면 빈 패턴 → 안 맞음
  assert.equal(categoryRuleMatches(rule('r1', '가짜식당', { match_type: 'exact' }), '가짜식당'), true);
  assert.equal(categoryRuleMatches(rule('r1', '가짜식당', { match_type: 'exact' }), '가짜식당본점'), false);
  assert.equal(categoryRuleMatches(rule('r1', '가짜 식당', { match_type: 'exact' }), '가짜 식당'), true); // NBSP → NFKC 공백 → 제거
  assert.equal(categoryRuleMatches(rule('r1', '가짜', { is_active: false }), '가짜식당'), false);
  assert.equal(categoryRuleMatches(rule('r1', '가짜.*', { match_type: 'regex' }), '가짜식당'), null);
});

test('여러 규칙이 맞으면 (priority, created_at, id) 순 첫 규칙', () => {
  const rules = sortCategoryRules([
    rule('r3', '가짜', { category_id: CAT_3, created_at: '2026-10-02T00:00:00Z' }),
    rule('r2', '가짜', { category_id: CAT_2, created_at: '2026-10-01T00:00:00Z' }),
    rule('r1', '가짜', { category_id: CAT_ID, created_at: '2026-10-01T00:00:00Z' }),
    rule('r9', '가짜', { category_id: CAT_3, priority: 200, created_at: '2026-09-01T00:00:00Z' }),
  ]);
  assert.deepEqual(rules.map((r) => r.id), ['r1', 'r2', 'r3', 'r9']);
  assert.deepEqual(pickCategoryRule(rules, '가짜식당'), { category_id: CAT_ID, source: 'rule' });
  const pri = sortCategoryRules([rule('a', '가짜', { priority: 50, category_id: CAT_2 }), ...rules]);
  assert.equal(pickCategoryRule(pri, '가짜식당').category_id, CAT_2);
});

test('모호 규칙 → suggestion, 앞선 규칙의 카테고리가 꺼졌으면 분류 안 함, regex는 건너뛰고 다음 규칙', () => {
  assert.deepEqual(pickCategoryRule([rule('r1', '가짜', { is_ambiguous: true })], '가짜식당'), { category_id: CAT_ID, source: 'suggestion' });
  const off = sortCategoryRules([rule('r1', '가짜', { categoryActive: false }), rule('r2', '가짜식당', { category_id: CAT_2, priority: 200 })]);
  assert.equal(pickCategoryRule(off, '가짜식당'), null);
  const rx = sortCategoryRules([rule('r1', '.*', { match_type: 'regex', priority: 1 }), rule('r2', '가짜', { category_id: CAT_2 })]);
  assert.equal(pickCategoryRule(rx, '가짜식당').category_id, CAT_2);
  assert.equal(pickCategoryRule([], '가짜식당'), null);
});

test('카드 파일: 확정 규칙 → rule + 확인함, 모호 → suggestion + 검토 대기, 환불 행은 그대로, RPC로 표시값 안 감', async () => {
  const categoryRules = sortCategoryRules([
    rule('r1', '가짜식당'),
    rule('r2', '가짜전자', { category_id: CAT_2, is_ambiguous: true }),
    rule('r3', '부분취소', { category_id: CAT_3 }),
  ]);
  const r = await parseFile(XLSX, bookBytes(sheetB(), 'xls'), { format: FORMAT_B, sourceId: SOURCE, categoryRules });
  const by = (m, kind) => r.rows.find((x) => x.merchant_raw === m && x.kind === kind);
  assert.equal(by('가짜식당', 'expense').category_id, CAT_ID);
  assert.equal(by('가짜식당', 'expense').category_source, 'rule');
  assert.equal(by('가짜식당', 'expense').review_status, 'confirmed');
  assert.equal(by('가짜전자', 'expense').category_id, CAT_2);
  assert.equal(by('가짜전자', 'expense').category_source, 'suggestion');
  assert.equal(by('가짜전자', 'expense').review_status, 'needs_review');
  for (const ref of r.rows.filter((x) => x.kind === 'refund')) {
    assert.equal(ref.category_id, null);
    assert.equal(ref.review_status, 'needs_review');
    assert.equal(ref.merchantRule, undefined);
  }
  assert.equal(by('부분취소상점', 'expense').category_id, CAT_3);
  for (const x of toRpcRows(r.rows)) assert.equal('merchantRule' in x, false);

  const p = previewOf(r, new Set());
  assert.equal(p.merchantRule, 2);
  assert.equal(p.merchantSuggest, 1);
  assert.equal(p.confirmed, 2);
  assert.deepEqual(previewLines(p).find(([k]) => k === '가맹점 규칙으로 분류'), ['가맹점 규칙으로 분류', '3건(확인 필요 1건)']);
  // 이미 DB에 있는 행은 세지 않는다
  const dup = previewOf(r, new Set([by('가짜식당', 'expense').dedup_key]));
  assert.equal(dup.merchantRule, 1);
});

test('통장 파일: 형식 행 규칙 분류는 그대로, 집계 제외·환불은 건너뜀, 이체 상대 규칙이 이긴다', async () => {
  const categories = new Map([['interest', CAT_3]]);
  const categoryRules = sortCategoryRules([
    rule('r1', '가짜마트'), rule('r2', '이자'), rule('r3', '카드대금'), rule('r4', '이시험'),
  ]);
  const counterpartyRules = [{
    id: 'p1', match_field: 'merchant', match_text: '이시험', match_type: 'exact', source_id: SOURCE, direction: 'out', txn_type: null,
    suggested_kind: 'expense', suggested_exclude_reason: null, suggested_category_id: CAT_2, suggested_is_shared: null,
    priority: 100, is_active: true, created_at: '2026-10-01T00:00:00Z',
  }];
  const r = await parseFile(XLSX, bookBytes(sheetA(), 'xlsx'), { format: FORMAT_A, sourceId: SOURCE, categories, categoryRules, counterpartyRules });
  const mart = r.rows.filter((x) => x.merchant_raw === '가짜마트');
  assert.equal(mart.find((x) => x.kind === 'expense').category_id, CAT_ID);
  assert.equal(mart.find((x) => x.kind === 'expense').review_status, 'confirmed');
  assert.equal(mart.find((x) => x.kind === 'refund').category_id, null);
  const interest = r.rows.find((x) => x.merchant_raw === '예금이자');
  assert.equal(interest.category_id, CAT_3); // 형식 행 규칙(category_code) 그대로
  assert.equal(interest.review_status, 'needs_review');
  assert.equal(interest.merchantRule, undefined);
  const bill = r.rows.find((x) => x.merchant_raw.startsWith('가짜카드대금'));
  assert.equal(bill.is_excluded, true);
  assert.equal(bill.category_id, null);
  for (const x of r.rows.filter((y) => y.merchant_raw === '이시험')) {
    assert.equal(x.category_id, CAT_2);
    assert.equal(x.review_status, 'needs_review');
  }
});

test('규칙이 없으면 이전과 같다(모두 검토 대기), 안내 문장', async () => {
  const r = await parseFile(XLSX, bookBytes(sheetB(), 'xls'), { format: FORMAT_B, sourceId: SOURCE });
  assert.ok(r.rows.every((x) => x.review_status === 'needs_review' && !x.merchantRule));
  const p = previewOf(r, new Set());
  assert.equal(p.confirmed, 0);
  assert.equal(previewLines(p).some(([k]) => k === '가맹점 규칙으로 분류'), false);
  assert.equal(reviewText(5, 0), '모두 검토 대기로 들어가요');
  assert.equal(reviewText(5, 2), '가맹점 규칙으로 분류된 2건은 확인함, 나머지 3건은 검토 대기로 들어가요');
  assert.equal(reviewText(2, 2), '가맹점 규칙으로 분류돼 모두 확인함으로 들어가요');
});
