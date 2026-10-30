// 업로드 때 이체 상대 규칙이 맞은 행 = 확인함 (CL-050, 사용자 결정 O2) — 합성 값만
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRows } from '../../app/import/normalize.js';
import { findHeader } from '../../app/import/formats.js';
import { counterpartyRule, counterpartyGroups, draftRule, withDrafts } from '../../app/screens/upload-model.js';
import { SOURCE, CAT_ID, FORMAT_A } from './fixtures.mjs';

const CAT_2 = 'c0000000-0000-4000-8000-0000000000c2';
const cp = (id, text, extra = {}) => ({
  id, match_field: 'merchant', match_text: text, match_type: 'exact', source_id: null, direction: null, txn_type: null,
  suggested_kind: null, suggested_exclude_reason: null, suggested_category_id: null, suggested_is_shared: null,
  priority: 100, is_active: true, created_at: '2026-10-01T00:00:00Z', ...extra,
});
// 가상 통장 시트(FORMAT_A): 헤더 + 행들
const grid = [
  ['거래일시', '구분', '내용', '나간 돈', '들어온 돈', '남은 돈'],
  ['2026.10.01 09:00', '이체', '김가짜', '50,000', '', '950,000'], // 지출 규칙
  ['2026.10.02 09:00', '이체', '이시험', '30,000', '', '920,000'], // 이체(집계 제외) 규칙
  ['2026.10.03 09:00', '이체', '박샘플', '', '100,000', '1,020,000'], // 수입 규칙
  ['2026.10.04 09:00', '카드사용', '가짜마트', '15,000', '', '1,005,000'], // row_rules(체크카드)만
  ['2026.10.04 10:00', '카드사용', '가짜마트', '', '15,000', '1,020,000'], // row_rules 환불
  ['2026.10.05 09:00', '이체', '최샘플', '7,000', '', '1,013,000'], // 규칙 없음
];
const rules = [
  cp('p1', '김가짜', { suggested_kind: 'expense', suggested_category_id: CAT_ID }),
  cp('p2', '이시험', { suggested_kind: 'transfer', suggested_exclude_reason: 'personal_transfer' }),
  cp('p3', '박샘플', { suggested_kind: 'income', suggested_category_id: CAT_2 }),
];

test('이체 상대 규칙이 맞은 지출·이체(집계 제외)·수입 → 확인함, row_rules만·규칙 없음·환불 → 검토 대기', async () => {
  const r = await normalizeRows(grid, FORMAT_A, findHeader(grid, FORMAT_A), { sourceId: SOURCE, counterpartyRules: rules });
  const st = (m, kind) => r.rows.find((x) => x.merchant_raw === m && (!kind || x.kind === kind));
  assert.deepEqual([st('김가짜').kind, st('김가짜').review_status], ['expense', 'confirmed']);
  assert.deepEqual([st('이시험').kind, st('이시험').is_excluded, st('이시험').review_status], ['transfer', true, 'confirmed']);
  assert.deepEqual([st('박샘플').kind, st('박샘플').review_status], ['income', 'confirmed']);
  assert.equal(st('가짜마트', 'expense').review_status, 'needs_review');
  assert.equal(st('가짜마트', 'refund').review_status, 'needs_review');
  assert.equal(st('최샘플').review_status, 'needs_review');
});

test('이체 상대 규칙 행에 모호 가맹점 규칙(제안)이 붙으면 검토 대기, 확정 가맹점 규칙이면 확인함 그대로', async () => {
  const noCat = [cp('p1', '김가짜', { suggested_kind: 'expense' })];
  const amb = [{ id: 'm1', pattern: '김가짜', match_type: 'exact', category_id: CAT_ID, is_ambiguous: true, is_active: true, categoryActive: true }];
  const r = await normalizeRows(grid, FORMAT_A, findHeader(grid, FORMAT_A), { sourceId: SOURCE, counterpartyRules: noCat, categoryRules: amb });
  const row = r.rows.find((x) => x.merchant_raw === '김가짜');
  assert.deepEqual([row.category_source, row.review_status], ['suggestion', 'needs_review']);
  const sure = [{ ...amb[0], is_ambiguous: false }];
  const r2 = await normalizeRows(grid, FORMAT_A, findHeader(grid, FORMAT_A), { sourceId: SOURCE, counterpartyRules: noCat, categoryRules: sure });
  assert.equal(r2.rows.find((x) => x.merchant_raw === '김가짜').review_status, 'confirmed');
});

test('미리보기에서 새 이체 상대를 골라 만든 규칙(draft)으로 다시 정규화해도 같은 결과(확인함)', async () => {
  const first = await normalizeRows(grid, FORMAT_A, findHeader(grid, FORMAT_A), { sourceId: SOURCE, counterpartyRules: [] });
  const g = counterpartyGroups(first.rows).find((x) => x.text === '최샘플');
  assert.equal(first.rows.find((x) => x.merchant_raw === '최샘플').review_status, 'needs_review');
  const rule = counterpartyRule(g, SOURCE, { suggested_kind: 'expense', suggested_category_id: CAT_ID, suggested_is_shared: true });
  const again = await normalizeRows(grid, FORMAT_A, findHeader(grid, FORMAT_A), {
    sourceId: SOURCE, counterpartyRules: withDrafts(rules, [draftRule(rule, 0)]),
  });
  const row = again.rows.find((x) => x.merchant_raw === '최샘플');
  assert.deepEqual([row.kind, row.category_id, row.review_status, row.newCounterparty], ['expense', CAT_ID, 'confirmed', undefined]);
  // 기존 규칙 행도 그대로 확인함
  assert.equal(again.rows.find((x) => x.merchant_raw === '김가짜').review_status, 'confirmed');
});
