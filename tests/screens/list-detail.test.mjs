// 내역·거래 상세 모델 (DB·브라우저 없이, 가짜 이름·가짜 가맹점만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capNotice, MAX_ROWS, parseListFilter, filterQuery, categoryIndex, filterRows, summarize, categoryLabel, rowView, groupByDay, hasFilter,
} from '../../app/screens/list-model.js';
import {
  buildDetailModel, categoryOptions, keptLineCategories, categoryChangeText, changeDescription, trashPlan, trashPatch, monthState, classification,
  editability, settlementChangeText, sharePatch, excludePatch, confirmPatch, linesDraft, validateLines, MAX_LINES,
} from '../../app/screens/detail-model.js';
import { amount as checkAmount, text as checkText, exclusion } from '../../app/core/validate.js';
import { buildHash, parseHash } from '../../app/router.js';
import { readMonthRows } from '../../app/screens/list.js';

const U = (n) => ['a0000000', '0000', '4000', '8000', String(n).padStart(12, '0')].join('-');
const G_FOOD = U(901);
const C_DINING = U(902);
const G_INCOME = U(903);
const C_SALARY = U(904);
const categories = [
  { id: G_FOOD, parent_id: null, name: '식비', code: 'food', sort_order: 100, is_active: true },
  { id: C_DINING, parent_id: G_FOOD, name: '외식', code: 'dining_out', sort_order: 2, is_active: true },
  { id: U(905), parent_id: G_FOOD, name: '꺼진항목', code: null, sort_order: 3, is_active: false },
  { id: G_INCOME, parent_id: null, name: '수입', code: 'income', sort_order: 900, is_active: true },
  { id: C_SALARY, parent_id: G_INCOME, name: '급여', code: 'salary', sort_order: 1, is_active: true },
];
const members = [{ id: 'm1', member_slot: 1, display_name: '가람' }, { id: 'm2', member_slot: 2, display_name: '나리' }];
const ctx = { cats: categoryIndex(categories), slotOf: new Map(members.map((m) => [m.id, m.member_slot])) };

const base = {
  source_id: U(801), source_label: '시험 카드', payer_member_id: 'm1', payer_name: '가람', occurred_time: null,
  kind: 'expense', is_shared: true, is_excluded: false, review_status: 'auto', memo: null, refund_of_txn_id: null,
  lines: [], is_uncategorized: true, inherited_category_id: null, is_changed_after_review: false,
};
const rows = [
  { ...base, id: U(1), occurred_on: '2026-10-05', occurred_time: '12:30:00', merchant_raw: '가상식당', amount: '12000',
    lines: [{ category_id: C_DINING, category: '외식', parent: '식비', amount: 12000, category_source: 'rule' }], is_uncategorized: false },
  { ...base, id: U(2), occurred_on: '2026-10-05', occurred_time: '09:00:00', merchant_raw: '시험마트', amount: 30000,
    review_status: 'needs_review', memo: '장보기 메모', payer_member_id: 'm2', payer_name: '나리' },
  { ...base, id: U(3), occurred_on: '2026-10-07', merchant_raw: '가상식당', amount: 5000, kind: 'refund',
    refund_of_txn_id: U(1), inherited_category_id: C_DINING, is_uncategorized: false },
  { ...base, id: U(4), occurred_on: '2026-10-08', merchant_raw: '카드대금', amount: 99000, kind: 'transfer',
    is_excluded: true, review_status: 'needs_review' },
  { ...base, id: U(5), occurred_on: '2026-10-09', merchant_raw: '시험상점', amount: 3000, kind: 'refund', review_status: 'needs_review' },
  { ...base, id: U(6), occurred_on: '2026-10-10', merchant_raw: '시험회사', amount: 2000000, kind: 'income',
    lines: [{ category_id: C_SALARY, category: '급여', parent: '수입', amount: 2000000, category_source: 'manual' }], is_uncategorized: false },
];
const q = (s) => parseHash(`#/list?${s}`).query;

test('parseListFilter: 아는 값만, 해시로 왕복', () => {
  const f = parseListFilter(q('payer=2&status=needs_review&kind=refund_unlinked&cat=none&share=x&excluded=1&q=%20%EA%B0%80%EC%83%81%20'));
  assert.deepEqual([f.payer, f.status, f.kind, f.cat, f.share, f.excluded, f.changed, f.q], ['2', 'needs_review', 'refund_unlinked', 'none', null, true, false, '가상']);
  assert.equal(parseListFilter(q('payer=3&cat=../x&src=1')).payer, null);
  assert.equal(parseListFilter(q('cat=../x')).cat, null);
  assert.equal(hasFilter(parseListFilter(new Map())), false);
  const back = parseHash(buildHash('list', { query: filterQuery('2026-10', f) })).query;
  assert.deepEqual(parseListFilter(back), f);
  assert.equal(back.get('month'), '2026-10');
});

test('filterRows: 제외는 기본 숨김, 검토 대기·환불 필터에서는 보임(홈 숫자와 같게)', () => {
  const ids = (s) => filterRows(rows, parseListFilter(q(s)), ctx).map((r) => r.id.slice(-1));
  assert.deepEqual(ids(''), ['1', '2', '3', '5', '6']);
  assert.deepEqual(ids('excluded=1'), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(ids('status=needs_review'), ['2', '4', '5']);
  assert.deepEqual(ids('kind=refund_unlinked'), ['5']);
  assert.deepEqual(ids('payer=2'), ['2']);
  assert.deepEqual(ids('cat=none'), ['2', '5']);
  assert.deepEqual(ids(`cat=${G_FOOD}`), ['1', '3'], '그룹으로 거르면 항목 라인·원거래를 따르는 환불 포함');
  assert.deepEqual(ids(`cat=${C_DINING}`), ['1', '3']);
  assert.deepEqual(ids('q=%EB%A9%94%EB%AA%A8'), ['2'], '메모 검색');
  assert.deepEqual(ids('q=%EA%B0%80%EC%83%81'), ['1', '3'], '가맹점 검색');
  assert.deepEqual(ids('share=personal'), []);
});

test('summarize: 지출 − 환불, 수입, 제외는 금액에서 빠짐', () => {
  const s = summarize(filterRows(rows, parseListFilter(q('excluded=1')), ctx));
  assert.deepEqual(s, { expense: '34,000원', income: '2,000,000원', count: '6건' });
});

test('categoryLabel·rowView: 연결 환불 A·B·D, 나눈 거래, 이체', () => {
  const lab = (r) => categoryLabel(r, ctx.cats);
  assert.equal(lab(rows[2]), '외식(원거래)');
  assert.equal(lab({ ...rows[2], inherited_category_id: null }), '미분류');
  assert.equal(lab(rows[4]), '미분류');
  assert.equal(lab(rows[3]), '이체');
  assert.equal(lab({ ...rows[0], lines: [rows[0].lines[0], { category: '배달' }, { category: '카페' }] }), '외식 외 2');
  const v = rowView(rows[2], ctx);
  assert.deepEqual([v.amountText, v.tone, v.sub, v.payer.slot, v.payer.initial], ['−5,000원', 'refund', '외식(원거래) · 시험 카드', 1, '가']);
  const x = rowView(rows[3], ctx);
  assert.deepEqual([x.tone, x.tags], ['excluded', ['검토 대기', '제외']]);
  assert.equal(rowView(rows[5], ctx).amountText, '+2,000,000원');
  assert.equal(rowView({ ...rows[1], payer_member_id: 'zz' }, ctx).payer.slot, 0);
});

test('capNotice: 잘렸을 때만 알림', () => {
  assert.equal(capNotice(false), null);
  assert.equal(capNotice(true), '이 달 거래가 많아 앞 2,000건만 보여요. 합계·검색도 이 안에서만 맞아요.');
});

/** 서버 max-rows(serverCap)를 흉내 내는 가짜 db: range를 받아도 serverCap건까지만 준다 */
function pagedDb(total, serverCap) {
  const calls = [];
  return {
    calls,
    async select(view, { range, order }) {
      calls.push({ ...range, order: order.map((o) => o.col).join(',') });
      const to = Math.min(range.to, range.from + serverCap - 1, total - 1);
      return { data: Array.from({ length: Math.max(0, to - range.from + 1) }, (_, i) => ({ id: range.from + i })), error: null };
    },
  };
}

test('readMonthRows: 서버가 1000·500건씩만 줘도 끝까지 읽고, 2,000건을 넘으면 잘렸다고 알림', async () => {
  for (const cap of [1000, 500]) {
    const small = await readMonthRows(pagedDb(1500, cap), '2026-10-01');
    assert.deepEqual([small.data.rows.length, small.data.capped], [1500, false], `cap ${cap}`);
    const exact = await readMonthRows(pagedDb(MAX_ROWS, cap), '2026-10-01');
    assert.deepEqual([exact.data.rows.length, exact.data.capped], [MAX_ROWS, false], `cap ${cap}`);
    const db = pagedDb(5000, cap);
    const big = await readMonthRows(db, '2026-10-01');
    assert.deepEqual([big.data.rows.length, big.data.capped], [MAX_ROWS, true], `cap ${cap}`);
    assert.deepEqual(big.data.rows.map((r) => r.id), Array.from({ length: MAX_ROWS }, (_, i) => i), '빠짐·겹침 없음');
    assert.ok(db.calls.every((c) => c.order === 'occurred_on,id'), '쪽이 어긋나지 않게 id로 끝 정렬');
    assert.ok(db.calls.at(-1).to <= MAX_ROWS, '상한 + 1건까지만 요청');
  }
  // 읽는 도중 맨 앞에 거래 1건이 추가됨 → 둘째 쪽 첫 행이 첫 쪽 마지막 행과 같음 → id로 걸러 한 번만
  let calls = 0;
  const shifting = {
    async select(view, { range }) {
      const shift = calls++ === 0 ? 0 : 1;
      const all = Array.from({ length: 1500 + shift }, (_, i) => ({ id: i - shift }));
      return { data: all.slice(range.from, Math.min(range.to + 1, range.from + 1000)), error: null };
    },
  };
  const dup = await readMonthRows(shifting, '2026-10-01');
  assert.equal(new Set(dup.data.rows.map((r) => r.id)).size, dup.data.rows.length, '중복 없음');
  assert.equal(dup.data.rows.length, 1500, '앞에 새로 들어온 1건은 이번 읽기에는 없음(다시 열면 보임)');
  const failing = { async select() { return { data: null, error: { code: 'network' } }; } };
  assert.deepEqual(await readMonthRows(failing, '2026-10-01'), { error: { code: 'network' } });
});

test('groupByDay: 최근 날짜 먼저, 같은 날은 늦은 시각 먼저, 요일 계산', () => {
  const g = groupByDay(rows.slice(0, 3));
  assert.deepEqual(g.map((x) => [x.label, x.rows.map((r) => r.id.slice(-1))]), [['10월 7일 (수)', ['3']], ['10월 5일 (월)', ['1', '2']]]);
});

const detailRow = {
  ...rows[0], origin: 'import', period_month: '2026-10-01', installment_months: 3, share_ratio: '50', exclude_reason: null,
  other_share_amount: '6000', month_reviewed_at: null, created_at: '2026-10-06T03:00:00Z', created_by: 'm2',
  updated_at: null, updated_by: null, deleted_at: null,
};

test('상세 모델: 머리·기본 정보·분류·정산·기록', () => {
  const m = buildDetailModel(detailRow, { cats: ctx.cats, members, refunds: [{ id: U(3), occurred_on: '2026-10-07', amount: 5000 }] });
  assert.deepEqual([m.title, m.amount, m.status], ['가상식당', '12,000원', '자동 분류 · 10월 확인 전']);
  assert.deepEqual(m.info, [['이용일', '10월 5일 (월) 12:30'], ['결제수단', '시험 카드 · 가람'], ['할부', '3개월'], ['들어온 길', '파일에서 올림']]);
  assert.deepEqual(m.classification.lines.map((l) => [l.name, l.amount, l.source]), [['식비 · 외식', '12,000원', '규칙']]);
  assert.deepEqual(m.settle, [['공동', '공동']]); // 5:5 분담·상대 몫 줄 없음(사용자 결정 10-30)
  assert.deepEqual(m.history, [['올림', '나리 · 2026-10-06 12:00']]);
  assert.deepEqual(m.refunds, [{ id: U(3), text: '10월 7일 (수) · 환불', amount: '−5,000원' }]);
  assert.equal(m.canChangeCategory, true);
});

test('상세 모델: 연결 환불(원거래 카테고리)·미연결 환불·제외·달 상태', () => {
  const refund = { ...detailRow, ...rows[2], period_month: '2026-09-01', occurred_on: '2026-10-07', month_reviewed_at: '2026-10-01T00:00:00Z', is_changed_after_review: true };
  const m = buildDetailModel(refund, { cats: ctx.cats, members, original: { id: U(1), occurred_on: '2026-09-28', merchant_raw: '가상식당', amount: 12000 } });
  assert.equal(m.amount, '−5,000원');
  assert.equal(m.status, '자동 분류 · 9월 확인 후 변경됨');
  assert.ok(m.info.some(([k, v]) => k === '집계하는 달' && v === '2026년 9월'));
  assert.equal(m.info[0][0], '환불일');
  assert.equal(m.classification.tag, '원거래 카테고리');
  assert.equal(m.classification.lines[0].name, '식비 · 외식');
  assert.equal(m.settle[0][1], '원거래를 따라요 · 공동');
  assert.deepEqual(m.original, { id: U(1), text: '9월 28일 (월) · 가상식당', amount: '12,000원' });
  assert.equal(classification({ ...rows[4] }, ctx.cats).note, '원거래를 아직 못 찾았어요');
  assert.equal(classification({ ...rows[2], inherited_category_id: null }, ctx.cats).note, '원거래가 아직 분류되지 않았어요');
  const ex = buildDetailModel({ ...detailRow, ...rows[3], exclude_reason: 'card_bill' }, { cats: ctx.cats, members });
  assert.deepEqual([ex.settle, ex.canChangeCategory, ex.tone], [[['집계', '제외 · 카드 대금']], false, 'excluded']);
  assert.equal(monthState({ period_month: '2026-10-01', month_reviewed_at: 'x', is_changed_after_review: false }), '10월 확인 완료');
});

test('나누기 줄의 고를 수 없는 지금 카테고리 → 지금 값 묶음(꺼짐 표시), 고를 수 있는 것은 빼고', () => {
  const rows = [
    { id: 'g1', parent_id: null, name: '식비', is_active: true }, { id: 'c1', parent_id: 'g1', name: '야식', is_active: false },
    { id: 'c2', parent_id: 'g1', name: '외식', is_active: true }, { id: 'g9', parent_id: null, name: '수입', is_active: true },
    { id: 'c9', parent_id: 'g9', name: '급여', is_active: true },
  ];
  const draft = [{ categoryId: 'c1' }, { categoryId: 'c2' }, { categoryId: 'c9' }, { categoryId: 'c1' }, { categoryId: '' }, { categoryId: 'gone' }];
  assert.deepEqual(keptLineCategories(draft, new Set(['c2']), rows), [{ id: 'keep', name: '지금 값', items: [
    { id: 'c1', name: '(꺼짐) 야식', label: '(꺼짐) 식비 > 야식' }, { id: 'c9', name: '(지금 값) 급여', label: '(지금 값) 수입 > 급여' }] }]);
  assert.deepEqual(keptLineCategories([{ categoryId: 'c2' }], new Set(['c2']), rows), []);
});

test('카테고리 고르기: 켜진 것만, 수입은 수입 그룹만', () => {
  const strip = (gs) => gs.map(({ id, ...g }) => (assert.ok(id), g)); // 그룹 id(카테고리 고르기 부품용)는 있기만 확인
  assert.deepEqual(strip(categoryOptions(categories, 'expense')), [{ group: '식비', items: [{ id: C_DINING, name: '외식' }] }]);
  assert.deepEqual(strip(categoryOptions(categories, 'income')), [{ group: '수입', items: [{ id: C_SALARY, name: '급여' }] }]);
  assert.match(categoryChangeText({ lines: [{}, {}] }, '외식').message, /2개로 나눈 금액이 모두 '외식'/);
  assert.match(categoryChangeText({ lines: [] }, '외식').message, /'외식'\(으\)로 분류/);
  assert.equal(changeDescription({ merchant_raw: '가'.repeat(300) }, '외식').length, 200);
});

test('휴지통: 연결된 환불 먼저, 원거래 나중 + 확인한 달 안내', () => {
  const refunds = [{ id: U(3), amount: 5000 }, { id: U(7), amount: '3000' }];
  const p = trashPlan({ ...detailRow, month_reviewed_at: '2026-11-01T00:00:00Z' }, refunds);
  assert.deepEqual(p.ids, [U(3), U(7), U(1)]);
  assert.match(p.message, /연결된 환불 2건\(−8,000원\)도 함께/);
  assert.match(p.message, /2026년 10월은 확인을 마친 달/);
  assert.deepEqual(trashPlan(detailRow, []).ids, [U(1)]);
  assert.deepEqual(trashPatch('m1', new Date('2026-10-29T00:00:00Z')), { deleted_at: '2026-10-29T00:00:00.000Z', deleted_by: 'm1', updated_by: 'm1' });
});

test('editability: 공동/개인·제외·나누기·되돌리기 가능 여부', () => {
  const e = editability(detailRow);
  assert.deepEqual(e, { canConfirm: true, canShare: true, canExclude: true, excludeBlocked: null, canSplit: true, canRevertToOriginal: false });
  assert.match(editability(detailRow, [{ id: U(3), amount: 5000 }]).excludeBlocked, /연결된 환불이 있어/);
  assert.equal(editability({ ...detailRow, is_excluded: true }, [{ id: U(3) }]).excludeBlocked, null, '다시 넣기는 막지 않음');
  const linked = editability({ ...detailRow, ...rows[2] });
  assert.deepEqual([linked.canShare, linked.canRevertToOriginal], [false, false], '연결 환불은 원거래를 따름, 라인 없으면 되돌릴 것 없음');
  assert.equal(editability({ ...detailRow, ...rows[2], lines: rows[0].lines }).canRevertToOriginal, true);
  assert.equal(editability({ ...detailRow, ...rows[4] }).canShare, true, '미연결 환불은 바꿀 수 있음');
  const tr = editability({ ...detailRow, ...rows[3] });
  assert.deepEqual([tr.canExclude, tr.canSplit, tr.canShare], [false, false, false]);
  assert.equal(editability({ ...detailRow, review_status: 'confirmed' }).canConfirm, false);
  assert.deepEqual(Object.values(editability({ ...detailRow, deleted_at: 'x' })).filter(Boolean), []);
});

test('정산 변경 문구·patch (C9 제외 규칙과 맞음)', () => {
  assert.match(settlementChangeText(detailRow, { type: 'share', to: false }).message, /^이 거래를 개인 지출로/);
  assert.match(settlementChangeText(detailRow, { type: 'share', to: false }, [{ id: U(3) }]).message, /연결된 환불 1건도 함께 바뀌어요/);
  assert.match(settlementChangeText({ ...detailRow, month_reviewed_at: 'x' }, { type: 'exclude', to: true }).message, /2026년 10월은 확인을 마친 달/);
  assert.deepEqual(sharePatch(false, 'm1'), { is_shared: false, updated_by: 'm1' });
  for (const to of [true, false]) {
    const p = excludePatch(to, 'm1');
    assert.equal(exclusion({ kind: 'expense', isExcluded: p.is_excluded, excludeReason: p.exclude_reason }).ok, true);
  }
  assert.deepEqual(confirmPatch('m1'), { review_status: 'confirmed', updated_by: 'm1' });
});

test('나누기: 처음 값과 입력 검사(카테고리·금액·품목 민감번호·합계)', () => {
  const allowed = new Set([C_DINING, U(905)]);
  const checks = { amount: checkAmount, text: checkText };
  assert.deepEqual(linesDraft({ amount: '30000', lines: [] }), [{ categoryId: '', amountText: '30000', note: '' }]);
  assert.deepEqual(linesDraft(rows[0]), [{ categoryId: C_DINING, amountText: '12000', note: '' }]);
  const ok = validateLines([{ categoryId: C_DINING, amountText: '10,000', note: ' 점심 ' }, { categoryId: U(905), amountText: '2000', note: '' }], 12000, allowed, checks);
  assert.deepEqual(ok, { ok: true, sumText: '합계 12,000원 / 거래 12,000원', lines: [
    { category_id: C_DINING, amount: 10000, item_note: '점심' }, { category_id: U(905), amount: 2000, item_note: null }] });
  const v = (draft) => validateLines(draft, 12000, allowed, checks).message;
  assert.match(v([{ categoryId: '', amountText: '12000', note: '' }]), /1번째 줄의 카테고리/);
  assert.match(v([{ categoryId: G_FOOD, amountText: '12000', note: '' }]), /카테고리를 골라/, '고를 수 없는 카테고리');
  assert.match(v([{ categoryId: C_DINING, amountText: '-1', note: '' }]), /금액은/);
  assert.match(v([{ categoryId: C_DINING, amountText: '10000', note: '' }]), /2,000원이 남았어요/);
  assert.match(v([{ categoryId: C_DINING, amountText: '13000', note: '' }]), /1,000원이 넘쳐요/);
  const digits = Array.from({ length: 10 }, () => 1 + Math.floor(Math.random() * 9)).join('');
  assert.match(v([{ categoryId: C_DINING, amountText: '12000', note: `번호 ${digits}` }]), /품목: 카드·계좌/);
  assert.match(v([{ categoryId: C_DINING, amountText: '12000', note: '' }, { categoryId: C_DINING, amountText: '0', note: '' }]), /2번째 줄 금액은 1원 이상/);
  assert.match(v([]), /1~50줄/);
  assert.match(v(Array.from({ length: MAX_LINES + 1 }, () => ({ categoryId: C_DINING, amountText: '1', note: '' }))), /1~50줄/);
});

test('일괄 분류: 이체 빼고, 수입·지출 섞이면 거부, 500건 상한, 나눈 거래 알림', async () => {
  const { bulkPlan, bulkConfirmText, changedTxnCount, selectable, MAX_BULK } = await import('../../app/screens/list-model.js');
  assert.equal(selectable(rows[3]), false);
  const p = bulkPlan([rows[0], rows[1], rows[3], { ...rows[1], id: U(9), lines: [{}, {}] }]);
  assert.deepEqual([p.ok, p.ids.length, p.kind, p.splitCount], [true, 3, 'expense', 1]);
  assert.match(bulkConfirmText(p, '외식').message, /^거래 3건의 카테고리를 '외식'\(으\)로 바꿔요\. 그중 나눈 거래 1건은/);
  assert.equal(bulkPlan([rows[5]]).kind, 'income');
  assert.match(bulkPlan([rows[0], rows[5]]).message, /함께 바꿀 수 없어요/);
  assert.match(bulkPlan([rows[3]]).message, /골라 주세요/);
  assert.match(bulkPlan(Array.from({ length: MAX_BULK + 1 }, (_, i) => ({ ...rows[0], id: String(i) }))).message, /500건까지/);
  assert.equal(changedTxnCount([{ txn_id: 'a', result: 'updated' }, { txn_id: 'a', result: 'created' }, { txn_id: 'b', result: 'unchanged' }, { txn_id: 'c', result: 'created' }]), 2);
  assert.equal(parseListFilter(q('sel=1')).sel, true);
  assert.equal(parseHash(buildHash('list', { query: filterQuery('2026-10', parseListFilter(q('sel=1'))) })).query.get('sel'), '1');
});
