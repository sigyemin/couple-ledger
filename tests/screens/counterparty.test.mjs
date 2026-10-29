// 이체 상대 규칙 모델 (가짜 이름만: 김가짜·이시험·박샘플)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryIndex, choiceOf, scopeText, cpList, choiceValues, checkNames, cpPatch, cpPreview, cpChangeLine, cpApplyResult, cpErrorText,
} from '../../app/screens/counterparty-model.js';
import { createDb, INSERT_COLUMNS, UPDATE_COLUMNS, DELETE_TABLES } from '../../app/core/db.js';
import { parseHash } from '../../app/router.js';
import { activeTab } from '../../app/screens/shell.js';

const ID = (n) => ['00000000', '0000', '4000', '8000', String(n).padStart(12, '0')].join('-');
const G_HOME = ID(1);
const C_RENT = ID(11);
const G_PERS = ID(2);
const C_ALLOW = ID(21);
const G_INC = ID(9);
const C_OTHER = ID(93);
const C_SAL = ID(91);
const cats = categoryIndex([
  { id: G_HOME, parent_id: null, name: '주거', code: 'housing', is_active: true },
  { id: C_RENT, parent_id: G_HOME, name: '월세', code: null, is_active: true },
  { id: G_PERS, parent_id: null, name: '개인', code: 'personal', is_active: true },
  { id: C_ALLOW, parent_id: G_PERS, name: '용돈', code: 'allowance', is_active: true },
  { id: G_INC, parent_id: null, name: '수입', code: 'income', is_active: true },
  { id: C_SAL, parent_id: G_INC, name: '급여', code: 'salary', is_active: true },
  { id: C_OTHER, parent_id: G_INC, name: '기타수입', code: 'income_other', is_active: true },
]);
const A = ID(71);
const B = ID(72);
const SRC = ID(801);
const sources = [{ id: SRC, label: '가 시험통장', kind: 'bank_account', owner_member_id: A }];
const members = [{ id: A, display_name: '가람' }, { id: B, display_name: '나리' }];
const rule = (id, o) => ({ id: ID(id), match_text: '김가짜', match_type: 'exact', source_id: SRC, direction: 'out', alias: null, member_id: null,
  suggested_kind: null, suggested_exclude_reason: null, suggested_category_id: null, suggested_is_shared: null, is_active: true, ...o });

test('선택 ↔ 규칙 값: 다섯 선택지가 같은 값으로 돌아온다', () => {
  for (const [choice, extra, label, tag] of [
    ['expense', { categoryId: C_RENT }, '주거 · 월세', '공동'],
    ['allowance', {}, '용돈', '개인'],
    ['saving', {}, '저축·내 계좌', '집계 제외'],
    ['couple', {}, '두 사람 간 송금', '집계 제외'],
    ['income', { direction: 'in' }, '수입 · 기타수입', null],
  ]) {
    const v = choiceValues({ choice, direction: 'out', sourceOwnerId: A, members, ...extra }, cats);
    assert.ok(v.ok, choice);
    const c = choiceOf(v.value, cats);
    assert.deepEqual([c.key, c.label, c.tag], [choice, label, tag], choice);
  }
});

test('선택 값 세부: 두 사람 간 송금은 통장 주인이 아닌 구성원, 모든 통장이면 나 아닌 사람. 이체 ⇔ 제외 사유', () => {
  assert.equal(choiceValues({ choice: 'couple', sourceOwnerId: A, members }, cats).value.member_id, B);
  assert.equal(choiceValues({ choice: 'couple', sourceOwnerId: null, meId: B, members }, cats).value.member_id, A);
  const s = choiceValues({ choice: 'saving' }, cats).value;
  assert.deepEqual([s.suggested_kind, s.suggested_exclude_reason, s.suggested_category_id, s.suggested_is_shared], ['transfer', 'internal_transfer', null, null]);
  const e = choiceValues({ choice: 'expense', categoryId: C_RENT }, cats).value;
  assert.deepEqual([e.suggested_kind, e.suggested_exclude_reason, e.suggested_is_shared], ['expense', null, true]);
  assert.equal(choiceValues({ choice: 'income', categoryId: C_SAL, direction: 'in' }, cats).value.suggested_category_id, C_SAL);
});

test('선택 막기: 카테고리 없음, 지출에 수입 카테고리, 보낼 때 수입, 수입에 지출 카테고리, 선택 없음', () => {
  assert.equal(choiceValues({ choice: 'expense' }, cats).ok, false);
  assert.equal(choiceValues({ choice: 'expense', categoryId: C_SAL }, cats).ok, false);
  assert.equal(choiceValues({ choice: 'income', direction: 'out' }, cats).ok, false);
  assert.equal(choiceValues({ choice: 'income', direction: 'in', categoryId: C_RENT }, cats).ok, false);
  assert.equal(choiceValues({ choice: null }, cats).ok, false);
});

test('표에 없는 조합은 값 그대로, 보일 이름만', () => {
  assert.equal(choiceOf(rule(1, { alias: '집주인' }), cats).label, '보일 이름만');
  assert.equal(choiceOf(rule(1, { suggested_is_shared: false }), cats).label, '개인');
  assert.equal(choiceOf(rule(1, { suggested_kind: 'expense', suggested_category_id: C_ALLOW, suggested_is_shared: true }), cats).label, '개인 · 용돈');
});

test('목록: 포함 표시·보일 이름·범위(모든 통장·방향), 켜진 것 먼저', () => {
  const rows = cpList([
    rule(1, { match_text: '박샘플', is_active: false }),
    rule(2, { match_text: '청년', match_type: 'contains', alias: '가 저축', suggested_kind: 'transfer', suggested_exclude_reason: 'internal_transfer' }),
    rule(3, { match_text: '이시험', source_id: null, direction: null, suggested_kind: 'transfer', suggested_exclude_reason: 'personal_transfer' }),
  ], cats, sources);
  assert.deepEqual(rows.map((r) => [r.name, r.alias, r.scope, r.choice, r.off]), [
    ['이시험', null, '모든 통장 · 주고받을 때', '두 사람 간 송금', false],
    ['“청년” 포함', '“가 저축”', '가 시험통장 · 보낼 때', '저축·내 계좌', false],
    ['박샘플', null, '가 시험통장 · 보낼 때', '보일 이름만', true],
  ]);
  assert.equal(scopeText(rule(1, { direction: 'in' }), sources), '가 시험통장 · 받을 때');
});

test('이름 검사: 필수·길이·민감번호, 보일 이름은 선택(빈 값 → null)', () => {
  assert.deepEqual(checkNames({ matchText: ' 김가짜 ', alias: '' }), { ok: true, value: { match_text: '김가짜', alias: null } });
  assert.equal(checkNames({ matchText: '  ' }).field, 'name');
  assert.equal(checkNames({ matchText: 'x'.repeat(101) }).field, 'name');
  const digits = Array.from({ length: 11 }, () => String(1 + Math.floor(Math.random() * 9))).join('');
  assert.equal(checkNames({ matchText: `송금${digits}` }).ok, false);
  assert.equal(checkNames({ matchText: null, alias: 'y'.repeat(51) }).field, 'alias');
  assert.deepEqual(checkNames({ matchText: null, alias: '집주인' }).value, { alias: '집주인' });
});

test('바뀐 칸만, 제안 값이 바뀌면 적용 미리보기로, 보일 이름만 바꾸면 목록으로', () => {
  const o = rule(1, { suggested_kind: 'expense', suggested_category_id: C_RENT, suggested_is_shared: true });
  assert.deepEqual(cpPatch(o, { alias: '집주인' }), { patch: { alias: '집주인' }, apply: false });
  const v = choiceValues({ choice: 'allowance' }, cats).value;
  assert.deepEqual(cpPatch(o, { alias: null, ...v }), { patch: { suggested_category_id: C_ALLOW, suggested_is_shared: false }, apply: true });
});

test('적용 미리보기·결과: 바뀜 수, 결과별 문구, 종류 → 종류(공동/개인), 변경 묶음', () => {
  const rows = [
    { txn_id: ID(31), result: 'updated', old_kind: 'expense', new_kind: 'transfer', old_exclude_reason: null, new_exclude_reason: 'personal_transfer', new_is_shared: true },
    { txn_id: ID(32), result: 'updated', old_kind: 'expense', new_kind: 'expense', new_is_shared: false },
    { txn_id: ID(33), result: 'skipped_direction' }, { txn_id: ID(34), result: 'skipped_has_refund' }, { txn_id: ID(35), result: 'skipped_priority' },
  ];
  const s = cpPreview(rows);
  assert.deepEqual([s.changeCount, s.headline], [2, '검토 대기 2건이 바뀌어요']);
  assert.deepEqual(s.counts.map((c) => c.label), ['바뀜', '다른 규칙이 먼저라 그대로', '방향이 안 맞아 그대로', '연결된 환불이 있어 그대로']);
  assert.equal(cpPreview([]).headline, '바뀌는 검토 대기 거래가 없어요');
  const d = { occurred_on: '2026-10-05', amount: '300000', merchant_raw: '김가짜' };
  assert.deepEqual(cpChangeLine(rows[0], d), { id: ID(31), merchant: '김가짜', sub: '10월 5일 (월) · 300,000원', from: '지출', to: '이체(두 사람 간)' });
  assert.equal(cpChangeLine(rows[1], null).to, '지출 · 개인');
  assert.deepEqual(cpApplyResult([{ ...rows[0], change_batch_id: ID(601) }]).batchId, ID(601));
  assert.equal(cpErrorText({ code: 'duplicate' }), '이미 같은 이름·범위 규칙이 있어요');
});

test('쓰기 허용: insert는 이름·범위·제안 값, update는 이름·범위 빼고, 삭제 없음', () => {
  assert.ok(INSERT_COLUMNS.counterparty_rules.includes('match_text') && INSERT_COLUMNS.counterparty_rules.includes('created_by'));
  assert.ok(!INSERT_COLUMNS.counterparty_rules.includes('priority') && !INSERT_COLUMNS.counterparty_rules.includes('txn_type'));
  for (const k of ['match_text', 'match_type', 'match_field', 'source_id', 'direction', 'created_by']) assert.ok(!UPDATE_COLUMNS.counterparty_rules.includes(k), k);
  assert.ok(!DELETE_TABLES.includes('counterparty_rules'));
});

test('주소: 이체 상대 화면들, id가 틀리면 목록, 탭은 더보기', () => {
  assert.equal(parseHash(`#/cprule/${ID(1)}`).screen, 'cprule');
  assert.equal(parseHash('#/cpapply/x').screen, 'cprules');
  assert.deepEqual(['cprules', 'cprule', 'cprulenew', 'cpapply'].map(activeTab), ['more', 'more', 'more', 'more']);
});

test('insert match_type은 일치·포함만(DB CHECK와 같게) — 아니면 요청을 보내지 않는다', async () => {
  let called = 0;
  const db = createDb({ from: () => { called += 1; return {}; }, rpc: () => {} });
  for (const v of ['regex', null, 'EXACT']) {
    const r = await db.insert('counterparty_rules', { match_text: '김가짜', match_type: v, alias: 'x' });
    assert.equal(r.error?.code, 'invalid', String(v));
  }
  assert.equal(called, 0);
});
