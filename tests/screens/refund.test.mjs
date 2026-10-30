// 환불 원거래 연결·제안 모델 (합성 값만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSuggestTarget, suggestFrom, monthSuggestions, suggestionText, candidateView, reviewedNote, linkConfirmText, bulkPlan, bulkConfirmText,
  bulkResultText, confirmPatch, MAX_BULK,
} from '../../app/screens/refund-model.js';
import { parseHash } from '../../app/router.js';
import { activeTab } from '../../app/screens/shell.js';

const ID = (n) => ['00000000', '0000', '4000', '8000', String(n).padStart(12, '0')].join('-');
const R = (n, o = {}) => ({ id: ID(n), kind: 'refund', refund_of_txn_id: null, deleted_at: null, card_kind: 'check_card', review_status: 'needs_review',
  is_test_source: false, merchant_raw: '커피집', amount: '4500', occurred_on: '2026-10-08', ...o });
const C = (n, o = {}) => ({ txn_id: ID(n), occurred_on: '2026-10-07', merchant_raw: '커피집', amount: '4500', remaining_amount: '4500',
  merchant_rank: 1, match_reasons: ['same_merchant', 'same_amount'], is_current_link: false, ...o });

test('조건 1: 체크카드 취소·연결 없음·검토 대기·휴지통 아님·테스트 아님만 (신용카드 취소는 제안 안 함 — F3)', () => {
  assert.equal(isSuggestTarget(R(1)), true);
  for (const o of [{ card_kind: 'credit_card' }, { card_kind: null }, { refund_of_txn_id: ID(9) }, { deleted_at: 'x' }, { review_status: 'confirmed' }, { is_test_source: true }, { kind: 'expense' }]) {
    assert.equal(isSuggestTarget(R(1, o)), false, JSON.stringify(o));
  }
});

test('조건 3: 같은 가맹점(rank 1)·같은 금액이 정확히 하나면 제안, 둘이면 없음, 비슷한 가맹점·금액 다름은 안 셈', () => {
  assert.equal(suggestFrom([C(11), C(12, { merchant_rank: 3, match_reasons: [] })]).suggest.txn_id, ID(11));
  const two = suggestFrom([C(11), C(12, { occurred_on: '2026-10-03' })]);
  assert.deepEqual([two.suggest, two.same.length], [null, 2]);
  assert.equal(suggestFrom([C(11, { merchant_rank: 2, match_reasons: ['similar_merchant', 'same_amount'] })]).suggest, null);
  assert.equal(suggestFrom([C(11, { match_reasons: ['same_merchant'] })]).suggest, null);
  assert.equal(suggestFrom([]).suggest, null);
});

test('조건 4: 같은 달 두 환불이 같은 원거래를 제안받으면 둘 다 제안 없음(겹침 표시)', () => {
  const s = monthSuggestions(new Map([[ID(1), [C(11)]], [ID(2), [C(11)]], [ID(3), [C(13)]]]));
  assert.deepEqual([s.get(ID(1)).suggest, s.get(ID(1)).conflict, s.get(ID(3)).suggest.txn_id], [null, true, ID(13)]);
});

test('제안 상자 문구: 제안 / 겹침 / 같은 금액 여럿(날짜들) / 없음', () => {
  assert.deepEqual(suggestionText({ suggest: C(11), same: [C(11)] }), {
    kind: 'suggest', title: '이 결제와 연결할까요?', what: '10월 7일 커피집 4,500원', why: '같은 결제수단 · 같은 가맹점 · 같은 금액은 이 결제 하나뿐이에요' });
  assert.equal(suggestionText({ suggest: null, same: [C(11)], conflict: true }).text, '같은 결제가 다른 환불에도 맞아 고르셔야 해요');
  assert.equal(suggestionText({ suggest: null, same: [C(11, { occurred_on: '2026-10-10' }), C(12, { occurred_on: '2026-10-03' })] }).text,
    '같은 금액 결제가 2건이라 고르셔야 해요 (10월 10일 · 10월 3일)');
  assert.equal(suggestionText({ suggest: null, same: [] }), null);
});

test('후보 한 줄: 제안·지금 연결·이유 꼬리표, 남은 금액은 다를 때만, 원거래 달', () => {
  const v = candidateView(C(11, { remaining_amount: '2000', amount: '4500', is_current_link: true, occurred_on: '2026-09-28' }), ID(11));
  assert.deepEqual([v.tags, v.sub, v.amountText, v.month], [['제안', '지금 연결', '같은 가맹점', '같은 금액'], '9월 28일 · 남은 2,000원', '4,500원', '2026-09-01']);
  assert.deepEqual(candidateView(C(12)).tags, ['같은 가맹점', '같은 금액']);
});

test('확인 완료 달 안내·연결 확인 문구', () => {
  const states = new Map([['2026-09-01', 'reviewed'], ['2026-10-01', 'not_reviewed']]);
  assert.equal(reviewedNote(['2026-09-01', '2026-10-01', '2026-09-01'], states), '9월은 확인 완료한 달이라 연결하면 "확인 후 변경됨"으로 바뀌어요.');
  assert.equal(reviewedNote(['2026-10-01'], states), null);
  const t = linkConfirmText(R(1), C(11, { occurred_on: '2026-09-28' }), states);
  assert.match(t.message, /^9월 28일 4,500원 결제와 연결해요\. 9월 정산에 반영되고 이 환불은 확인함이 돼요\. 9월은 확인 완료한 달/);
});

test('일괄 연결: 제안된 것만, 확인 창에 (환불 → 원거래) 전체, 상한, 결과 문장', () => {
  const refunds = [R(1), R(2, { merchant_raw: '동네마트', amount: '12000', occurred_on: '2026-10-12' }), R(3, { occurred_on: '2026-10-20' })];
  const sug = new Map([[ID(1), { suggest: C(11) }], [ID(2), { suggest: null }], [ID(3), { suggest: C(13, { occurred_on: '2026-09-30' }) }]]);
  const plan = bulkPlan(refunds, sug);
  assert.deepEqual(plan.pairs.map((p) => [p.refund.id, p.original.txn_id]), [[ID(1), ID(11)], [ID(3), ID(13)]]);
  const t = bulkConfirmText(plan, new Map([['2026-09-01', 'reviewed']]));
  assert.equal(t.title, '제안 2건 모두 연결');
  assert.deepEqual(t.message.split('\n').slice(1, 3), ['10월 8일 커피집 −4,500원 → 10월 7일 커피집 4,500원', '10월 20일 커피집 −4,500원 → 9월 30일 커피집 4,500원']);
  assert.match(t.message, /9월은 확인 완료한 달/);
  const many = Array.from({ length: MAX_BULK + 2 }, (_, i) => R(100 + i));
  const big = bulkPlan(many, new Map(many.map((r, i) => [r.id, { suggest: C(5000 + i) }])));
  assert.deepEqual([big.pairs.length, big.over], [MAX_BULK, 2]);
  assert.equal(bulkResultText(3, 3, null), '3건 연결했어요.');
  assert.equal(bulkResultText(1, 3, { merchant_raw: '동네마트' }), '1건 연결했고, 동네마트 환불에서 멈춰 나머지 2건은 연결하지 않았어요.');
  assert.deepEqual(confirmPatch(ID(71)), { review_status: 'confirmed', updated_by: ID(71) });
});

test('주소·탭: 원거래 찾기', () => {
  assert.equal(parseHash(`#/refund/${ID(1)}?widen=1`).query.get('widen'), '1');
  assert.equal(parseHash('#/refund/x').screen, 'list');
  assert.equal(activeTab('refund'), 'list');
});

import { linkOne } from '../../app/screens/refund.js';

function fakeDb(now) {
  const calls = [];
  return {
    calls,
    async select(view, o) { calls.push(['select', view, o.filters[0].value]); return { data: now === undefined ? [] : [now], error: null }; },
    async rpc(name, args) { calls.push(['rpc', name, args.p_refund_id]); return { data: {}, error: null }; },
    async update(t, id, patch) { calls.push(['update', t, patch.review_status]); return { data: [{ id }], error: null }; },
  };
}

test('제안·일괄 연결 직전 다시 읽기: 이미 연결됐거나 휴지통·없으면 건너뜀(link_refund 안 부름), 아니면 연결 + 확인함', async () => {
  for (const now of [{ id: ID(1), refund_of_txn_id: ID(9), deleted_at: null }, { id: ID(1), refund_of_txn_id: null, deleted_at: '2026-10-30T00:00:00Z' }, undefined]) {
    const db = fakeDb(now);
    const r = await linkOne(db, ID(71), ID(1), ID(11), { onlyIfUnlinked: true });
    assert.deepEqual([r.ok, r.linked, r.skipped], [false, false, true]);
    assert.ok(!db.calls.some((c) => c[0] === 'rpc'));
  }
  const db = fakeDb({ id: ID(1), refund_of_txn_id: null, deleted_at: null });
  assert.deepEqual(await linkOne(db, ID(71), ID(1), ID(11), { onlyIfUnlinked: true }), { ok: true, linked: true });
  assert.deepEqual(db.calls.map((c) => c.slice(0, 2)), [['select', 'v_transaction_detail'], ['rpc', 'link_refund'], ['update', 'transactions']]);
  // 찾기 화면(원거래 바꾸기 허용)은 다시 읽지 않는다
  const db2 = fakeDb();
  await linkOne(db2, ID(71), ID(1), ID(11));
  assert.deepEqual(db2.calls.map((c) => c[1]), ['link_refund', 'transactions']);
});

test('일괄 결과 문장: 건너뛴 수', () => {
  assert.equal(bulkResultText(2, 2, null, 1), '2건 연결했어요. 1건은 다른 사람이 먼저 연결했거나 휴지통으로 옮겨 건너뛰었어요.');
});

import { suggestionCount } from '../../app/screens/refund.js';
import { buildHomeModel } from '../../app/screens/home-model.js';
import { checkCancelMonths, suggestLineText } from '../../app/screens/upload-model.js';

function countDb(refunds, cands) {
  const calls = [];
  return {
    calls,
    async select(view, o) { calls.push(['select', view, o.filters.map((f) => f.col).join(',')]); return { data: refunds, error: null }; },
    async rpc(name, a) { calls.push(['rpc', name]); return { data: cands[a.p_refund_id] ?? [], error: null }; },
  };
}

test('연결 제안 수(홈·올리기): 미연결 체크카드 취소가 없으면 후보 RPC 0번, 있으면 그 수만큼, 조건 3·4 적용', async () => {
  const none = countDb([], {});
  assert.deepEqual(await suggestionCount(none, '2026-09-01'), { data: { count: 0, refunds: 0 } });
  assert.deepEqual(none.calls.map((c) => c[0]), ['select']);
  assert.match(none.calls[0][2], /period_month.*kind.*card_kind.*review_status.*refund_of_txn_id.*deleted_at.*is_test_source/);
  const db = countDb([R(1), R(2), R(3), R(4)], { [ID(1)]: [C(11)], [ID(2)]: [C(12), C(13)], [ID(3)]: [C(14)], [ID(4)]: [C(14)] });
  assert.deepEqual(await suggestionCount(db, '2026-09-01'), { data: { count: 1, refunds: 4 } }); // 1만 제안(2 여럿, 3·4 겹침)
  assert.equal(db.calls.filter((c) => c[0] === 'rpc').length, 4);
});

test('홈 할 일: 지난달 연결 제안이 있으면 그 달 월 검토로', () => {
  const m = buildHomeModel('2026-10-01', { summary: null, suggest: { month: '2026-09-01', count: 2 } });
  const t = m.todos.find((x) => x.key === 'refund-suggest');
  assert.deepEqual([t.text, t.href], ['9월 환불 연결 제안 2건', '#/review?month=2026-09']);
  assert.equal(buildHomeModel('2026-10-01', { summary: null, suggest: { month: '2026-09-01', count: 0 } }).todos.length, 0);
  assert.equal(buildHomeModel('2026-10-01', { summary: null, suggest: null }).todos.length, 0);
});

test('올리기 결과: 저장한 파일의 체크카드 취소 달(최대 3), 제안 줄', () => {
  const f = (rows) => ({ parsed: { rows } });
  const r = (occurred_on, o = {}) => ({ kind: 'refund', card_kind: 'check_card', occurred_on, ...o });
  assert.deepEqual(checkCancelMonths([f([r('2026-09-08'), r('2026-08-30'), r('2026-09-12'), r('2026-09-01', { card_kind: 'credit_card' }), { kind: 'expense', card_kind: 'check_card', occurred_on: '2026-07-01' }])]),
    ['2026-08-01', '2026-09-01']);
  assert.deepEqual(checkCancelMonths([f([r('2026-01-01'), r('2026-02-01'), r('2026-03-01'), r('2026-04-01')])]).length, 3);
  assert.deepEqual(suggestLineText([{ month: '2026-08-01', count: 0 }, { month: '2026-09-01', count: 2 }]), { text: '체크카드 취소 연결 제안 2건이 있어요. 월 검토에서 연결해요.', month: '2026-09-01' });
  assert.equal(suggestLineText([{ month: '2026-09-01', count: 0 }]), null);
});
