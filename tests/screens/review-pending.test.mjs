// 월 검토 '준비 중' 정리 (CL-066) — 가짜 가맹점·가짜 이체 상대 이름만
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uncategorizedGroups, classifyConfirmText, unmatchedCounterparties } from '../../app/screens/review-model.js';
import { ruleFor } from '../../app/screens/merchant-classify-model.js';
import { saveMerchantRule } from '../../app/screens/merchant-rule.js';

const src = (p) => readFileSync(new URL(`../../app/screens/${p}`, import.meta.url), 'utf8');

const card = { source_id: 'c1', source_kind: 'credit_card', source_label: '시험카드', kind: 'expense', review_status: 'needs_review', is_uncategorized: true, card_kind: 'credit_card' };
const bank = { source_id: 'b1', source_kind: 'bank_account', source_label: '시험통장', kind: 'expense', review_status: 'needs_review', is_uncategorized: true, card_kind: null };

test('분류 묶음: 지출 카드 행만 규칙 가능, 통장 이체·수입은 불가 — ruleFor가 같은 판단', () => {
  const g = uncategorizedGroups([
    { ...card, id: 'a', merchant_raw: '가상마트', merchant_norm: '가상마트', amount: 1000 },
    { ...card, id: 'b', merchant_raw: '가상마트', merchant_norm: '가상마트', amount: 2000 },
    { ...bank, id: 'c', merchant_raw: '김가짜', merchant_norm: '김가짜', amount: 3000 },
    { ...card, id: 'd', merchant_raw: '시험회사', merchant_norm: '시험회사', amount: 900, kind: 'income' },
  ]);
  const by = Object.fromEntries(g.map((x) => [x.merchant, x]));
  assert.deepEqual([by['가상마트'].canRule, by['김가짜'].canRule, by['김가짜'].transferLike, by['시험회사'].canRule], [true, false, true, false]);
  assert.equal(by['가상마트'].norm, '가상마트');
  const rv = ruleFor(by['가상마트'], 'cat1');
  assert.equal(rv.ok, true);
  assert.deepEqual([rv.value.pattern, rv.value.match_type, rv.value.category_id], ['가상마트', 'exact', 'cat1']);
  assert.match(ruleFor(by['김가짜'], 'cat1').message, /이체 상대 규칙/);
});

test('분류 확인 문구: 규칙을 만들면 알림, 안 만들면 그대로', () => {
  const g = { merchant: '가상마트', count: 2, total: 2, splitCount: 0, toConfirm: ['a'] };
  const on = classifyConfirmText(g, '식재료', true);
  assert.equal(on.message, "가상마트 2건을 '식재료'(으)로 분류해요. 1건은 확인함으로 바뀌어요. 앞으로 '가상마트' 거래는 올릴 때 '식재료'(으)로 자동 분류돼요(가맹점 규칙).");
  assert.match(on.undoNote, /규칙은 규칙·카테고리에서/);
  const off = classifyConfirmText(g, '식재료');
  assert.doesNotMatch(off.message, /가맹점 규칙/);
  assert.doesNotMatch(off.undoNote, /규칙은/);
});

function fakeDb({ rules = [], selectError = null, insertError = null } = {}) {
  const calls = [];
  return {
    calls,
    async select(table, opts) { calls.push(['select', table, opts.filters]); return selectError ? { error: selectError } : { data: rules }; },
    async insert(table, row) { calls.push(['insert', table, row]); return insertError ? { error: insertError } : { data: [{ id: 'new' }] }; },
  };
}
const value = { pattern: '가상마트', match_type: 'exact', category_id: 'cat1', is_ambiguous: false, priority: 100 };
const member = { memberId: 'm1' };
const categories = [{ id: 'cat1', name: '식재료' }, { id: 'cat2', name: '외식' }];

test('규칙 저장: 없으면 만듦(created_by), 같은 규칙이면 건너뜀, 다른 카테고리면 링크로 안내', async () => {
  let db = fakeDb();
  let r = await saveMerchantRule({ db, member, value, categories });
  assert.deepEqual(r, { ok: true, note: ' 앞으로 올릴 때 자동 분류돼요.', link: null });
  assert.deepEqual(db.calls[1], ['insert', 'category_rules', { ...value, created_by: 'm1' }]);
  db = fakeDb({ rules: [{ id: 'r1', pattern: '가상 마트', match_type: 'exact', category_id: 'cat1', is_active: true }] });
  r = await saveMerchantRule({ db, member, value, categories });
  assert.equal(r.note, ' 같은 규칙이 이미 있어요.');
  assert.equal(db.calls.filter((c) => c[0] === 'insert').length, 0, '같은 패턴(정리값) 규칙이 있으면 만들지 않음');
  db = fakeDb({ rules: [{ id: 'r2', pattern: '가상마트', match_type: 'exact', category_id: 'cat2', is_active: true }] });
  r = await saveMerchantRule({ db, member, value, categories });
  assert.match(r.note, /'외식'\(으\)로 있어 새 규칙은 만들지 않았어요/);
  assert.equal(r.link.href, '#/rule/r2');
  assert.equal(db.calls.filter((c) => c[0] === 'insert').length, 0);
});

test('규칙 저장: 조회 실패면 만들지 않음, 중복 거부는 이미 있음, 그 밖 실패는 오류 번호', async () => {
  let r = await saveMerchantRule({ db: fakeDb({ selectError: { message: 'x' } }), member, value, categories, onError: () => 'E1' });
  assert.deepEqual([r.ok, r.text], [false, '같은 규칙이 있는지 확인하지 못해 규칙은 만들지 않았어요. 규칙·카테고리에서 만들어 주세요. (오류 번호 E1)']);
  r = await saveMerchantRule({ db: fakeDb({ insertError: { code: 'duplicate' } }), member, value, categories });
  assert.deepEqual([r.ok, r.note], [true, ' 같은 규칙이 이미 있어요.']);
  r = await saveMerchantRule({ db: fakeDb({ insertError: { code: 'x', message: 'y' } }), member, value, categories, onError: () => 'E2' });
  assert.deepEqual([r.ok, r.text], [false, '규칙은 만들지 못했어요. 규칙·카테고리에서 만들어 주세요. (오류 번호 E2)']);
});

test('아직 안 정한 이체 상대: 검토 대기 통장 지출·수입 중 규칙에 안 맞는 것만, 통장·방향·이름별 묶음', () => {
  const rows = [
    { ...bank, id: '1', merchant_raw: '김가짜', amount: 30000 },
    { ...bank, id: '2', merchant_raw: '김가짜 ', amount: 20000 },
    { ...bank, id: '3', merchant_raw: '김가짜', amount: 5000, kind: 'income' },
    { ...bank, id: '4', merchant_raw: '이시험', amount: 70000 },
    { ...bank, id: '5', merchant_raw: '박샘플', amount: 1000 }, // 규칙에 맞음
    { ...bank, id: '6', merchant_raw: '김가짜', amount: 1, review_status: 'confirmed' },
    { ...bank, id: '7', merchant_raw: '김가짜', amount: 1, kind: 'transfer' },
    { ...bank, id: '8', merchant_raw: '가상마트', amount: 1, card_kind: 'check_card' },
    { ...card, id: '9', merchant_raw: '가상마트', amount: 1 },
  ];
  const rules = [{ id: 'r1', match_field: 'merchant', match_text: '박샘플', match_type: 'exact', source_id: null, direction: 'out', txn_type: null, suggested_kind: 'transfer', is_active: true }];
  const { groups, unsure } = unmatchedCounterparties(rows, rules);
  assert.equal(unsure, 0);
  assert.deepEqual(groups.map((g) => [g.name, g.sourceLabel, g.direction, g.count, g.amountText, g.ids]), [
    ['김가짜', '시험통장', 'out', 2, '50,000원', ['1', '2']],
    ['이시험', '시험통장', 'out', 1, '70,000원', ['4']],
    ['김가짜', '시험통장', 'in', 1, '5,000원', ['3']],
  ]);
});

test('아직 안 정한 이체 상대: 방향 안 맞는 제안 규칙은 안 맞음 취급, 거래 종류·상대 칸 규칙은 판정 불가로 뺌', () => {
  const rows = [
    { ...bank, id: '1', merchant_raw: '김가짜', amount: 100 },
    { ...bank, id: '2', source_id: 'b2', merchant_raw: '이시험', amount: 100 },
  ];
  const wrongDir = [{ id: 'r1', match_field: 'merchant', match_text: '김가짜', match_type: 'exact', source_id: null, direction: null, txn_type: null, suggested_kind: 'income', is_active: true }];
  assert.deepEqual(unmatchedCounterparties(rows, wrongDir).groups.map((g) => g.name), ['김가짜', '이시험'], '출금에 수입 제안 규칙은 업로드도 건너뜀');
  const raw = [{ id: 'r2', match_field: 'counterparty', match_text: '무엇', match_type: 'exact', source_id: 'b1', direction: null, txn_type: null, suggested_kind: 'transfer', is_active: true }];
  const r = unmatchedCounterparties(rows, raw);
  assert.deepEqual([r.unsure, r.groups.map((g) => g.name)], [1, ['이시험']], '범위(통장 b1)가 맞는 행만 판정 불가');
});

test('화면 소스: 준비 중 문구 없음, 규칙 저장 재사용, 이체 상대 이름은 주소에 넣지 않음, 정산 공제 카드는 기다리지 않음', () => {
  const review = src('review.js');
  assert.doesNotMatch(review, /준비 중/);
  assert.match(review, /saveMerchantRule\(\{ db, member, value: rv\.value, categories, onError \}\)/);
  assert.match(review, /href: buildHash\('cprulenew'\)/);
  assert.doesNotMatch(review, /buildHash\('cprulenew', \{/, '이름을 주소 쿼리로 넘기지 않음');
  assert.match(review, /startCounterpartyDraft\(\{ matchText: g\.name/);
  assert.doesNotMatch(src('review-model.js'), /준비 중/);
  const classify = src('merchant-classify.js');
  assert.match(classify, /saveMerchantRule\(/);
  assert.doesNotMatch(classify, /db\.insert\('category_rules'/, '규칙 insert는 merchant-rule.js 한 곳');
  const settle = src('settle.js');
  assert.doesNotMatch(settle, /준비 중/);
  assert.doesNotMatch(settle, /await deduction/);
  assert.match(settle, /deduction\.then\(\(card\) => \{\s*if \(isCurrent\(\)\) dedCard\.replaceWith\(card\);/);
  for (const f of ['review.js', 'merchant-rule.js', 'counterparty.js', 'settle.js']) assert.doesNotMatch(src(f), /innerHTML/, f);
});

test('이체 상대 직접 추가: 미리 채울 값은 한 번만 쓰고 지운다', () => {
  const cp = src('counterparty.js');
  assert.match(cp, /const draft = id \? null : cpDraft;\n {2}if \(!id\) cpDraft = null;/);
  assert.match(cp, /export function startCounterpartyDraft/);
});
