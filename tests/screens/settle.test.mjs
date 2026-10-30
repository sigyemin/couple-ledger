// 정산 화면 모델 (DB·브라우저 없이, 가짜 이름만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerSpend, spendKind, reviewView, confirmMonthText, unconfirmMonthText, pastMonths, defaultSettleMonth } from '../../app/screens/settle-model.js';
import { readSpendRows, loadSettle } from '../../app/screens/settle.js';

const members = [{ id: 'm2', member_slot: 2, display_name: '나리' }, { id: 'm1', member_slot: 1, display_name: '가람' }];
const SOURCES = [
  { id: 'c1', owner_member_id: 'm1', kind: 'credit_card', is_test: false },
  { id: 'b1', owner_member_id: 'm1', kind: 'bank_account', is_test: false },
  { id: 'k2', owner_member_id: 'm2', kind: 'check_card', is_test: false },
  { id: 'h2', owner_member_id: 'm2', kind: 'cash', is_test: false },
  { id: 't1', owner_member_id: 'm1', kind: 'credit_card', is_test: true },
];
// 한 줄 = '종류 이달N 누계N'(숫자가 이어져 민감번호 검사에 걸리지 않게 글자로 비교)
const show = (p) => p.lines.map((l) => `${l.key} 이달${l.month} 누계${l.ytd}`);
const tx = (source_id, kind, amount, period_month = '2026-10-01', o = {}) => ({ source_id, kind, amount, card_kind: null, period_month, refund_of_txn_id: null, ...o });

test('종류: 신용카드 결제수단 / 체크카드 결제수단·통장의 체크카드 행 / 나머지', () => {
  assert.equal(spendKind({}, SOURCES[0]), 'credit');
  assert.equal(spendKind({ card_kind: 'check_card' }, SOURCES[1]), 'check');
  assert.equal(spendKind({}, SOURCES[2]), 'check');
  assert.equal(spendKind({}, SOURCES[1]), 'other');
  assert.equal(spendKind({}, SOURCES[3]), 'other');
});

test('명의별 사용액: 종류별 합계, 연결 환불 차감, 시험 수단 제외, 그 달 + 올해 누계, 자리 순', () => {
  const rows = [
    tx('c1', 'expense', '100000'), tx('c1', 'expense', 50000, '2026-03-01'),
    tx('c1', 'refund', 20000, '2026-10-01', { refund_of_txn_id: 'o1' }), // 연결 환불: 원거래 달(10월)에서 뺀다
    tx('b1', 'expense', 30000, '2026-10-01', { card_kind: 'check_card' }), tx('b1', 'expense', 700000, '2026-09-01'), // 통장: 체크카드 행 / 이체 출금
    tx('k2', 'expense', 12000), tx('h2', 'expense', 8000, '2026-01-01'),
    tx('t1', 'expense', 999000), // 시험 결제수단
    tx('zz', 'expense', 5000), // 모르는 결제수단(조회 사이 바뀜) → 건너뜀
    tx('c1', 'income', 40000), // 수입은 사용액 아님(조회에서도 빠짐)
  ];
  const s = ownerSpend(rows, SOURCES, members, '2026-10-01');
  assert.equal(s.ytdLabel, '1~10월');
  assert.deepEqual(s.people.map((p) => p.name), ['가람', '나리']);
  assert.deepEqual(show(s.people[0]), ['credit 이달80000 누계130000', 'check 이달30000 누계30000', 'other 이달0 누계700000', 'total 이달110000 누계860000']);
  assert.deepEqual(show(s.people[1]), ['credit 이달0 누계0', 'check 이달12000 누계12000', 'other 이달0 누계8000', 'total 이달12000 누계20000']);
  assert.equal(ownerSpend([], SOURCES, members, '2026-01-01').ytdLabel, '1월');
  assert.deepEqual(ownerSpend([], SOURCES, members, '2026-01-01').people[0].lines.at(-1), { key: 'total', label: '합계', month: 0, ytd: 0 });
});

test('원거래를 못 찾은 환불도 그 결제수단·그 귀속월에서 뺀다(홈 지출과 같은 기준, 총괄 결정 10-30)', () => {
  const rows = [tx('c1', 'expense', 50000), tx('c1', 'refund', 7000), tx('k2', 'refund', 3000, '2026-02-01')];
  const s = ownerSpend(rows, SOURCES, members, '2026-10-01');
  assert.deepEqual(show(s.people[0])[0], 'credit 이달43000 누계43000');
  assert.deepEqual(show(s.people[1])[1], 'check 이달0 누계-3000'); // 체크카드 2월 환불: 누계에서만
  assert.equal('unlinked' in s, false);
});

test('조회: 올해 1월~그 달, 휴지통·집계 제외 빼고 지출·환불만, 빈 쪽까지 읽음', async () => {
  const calls = [];
  const all = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, source_id: 'c1', kind: 'expense', amount: 1000, period_month: '2026-10-01' }));
  const db = {
    async select(view, o) {
      calls.push([view, o]);
      if (view !== 'transactions') return { data: view === 'payment_sources' ? SOURCES : (view === 'members' ? members : []), error: null };
      const page = all.slice(o.range.from, Math.min(o.range.to + 1, o.range.from + 2)); // 서버가 2건씩만 준다
      return { data: page, error: null };
    },
  };
  const r = await readSpendRows(db, '2026-10-01');
  assert.deepEqual(r.data.rows.map((x) => x.id), ['t0', 't1', 't2', 't3', 't4']);
  assert.equal(r.data.capped, false);
  assert.deepEqual(calls[0][1].filters, [
    { col: 'period_month', op: 'gte', value: '2026-01-01' }, { col: 'period_month', op: 'lte', value: '2026-10-01' },
    { col: 'deleted_at', op: 'is', value: null }, { col: 'is_excluded', op: 'eq', value: false }, { col: 'kind', op: 'in', value: ['expense', 'refund'] }]);
  assert.equal((await readSpendRows(db, '2026-10-01', { max: 3 })).data.capped, true);
  const l = await loadSettle(db, '2026-10-01');
  assert.deepEqual(Object.keys(l.data).sort(), ['members', 'sources', 'spend', 'status']);
  assert.equal(calls.some(([v]) => v === 'v_monthly_settlement'), false); // 5:5 정산 뷰는 더 안 읽는다
  const bad = { async select(v) { return v === 'transactions' ? { data: null, error: { code: 'network' } } : { data: [], error: null }; } };
  assert.equal((await loadSettle(bad, '2026-10-01')).error.code, 'network');
});

test('확인 상태: 확인 전·확인 완료·확인 후 변경됨, 검토 대기 안내', () => {
  const a = reviewView('2026-10-01', null, members);
  assert.deepEqual([a.state, a.title, a.canConfirm, a.canUnconfirm, a.confirmLabel, a.pendingNote], ['not_reviewed', '10월 확인 전', true, false, '10월 확인 완료', null]);
  const b = reviewView('2026-10-01', { review_state: 'not_reviewed', needs_review_count: 3 }, members);
  assert.equal(b.pendingNote, '검토 대기 3건이 남았어요. 그래도 확인할 수 있어요.');
  const c = reviewView('2026-10-01', { review_state: 'reviewed', reviewed_by: 'm2', reviewed_at: '2026-10-31T12:00:00Z', needs_review_count: 2 }, members);
  assert.deepEqual([c.title, c.sub, c.canConfirm, c.canUnconfirm], ['10월 확인 완료', '나리 · 2026-10-31 21:00', false, true]);
  const d = reviewView('2026-09-01', { review_state: 'changed_after_review', reviewed_by: 'm1', reviewed_at: '2026-10-01T00:00:00Z', changed_txn_count: '2' }, members);
  assert.deepEqual([d.title, d.changedCount, d.canConfirm, d.canUnconfirm, d.confirmLabel], ['9월 확인 후 변경됨', 2, true, true, '9월 다시 확인 완료']);
  assert.match(d.sub, /^가람이 2026-10-01 09:00에 확인한 뒤 정산에 영향 주는 거래 2건이 바뀌었어요$/);
  assert.match(confirmMonthText('2026-10-01', 3).message, /^2026년 10월 정산 숫자를 확인했다고 남겨요\. 검토 대기 3건이 남아 있어요\./);
  assert.doesNotMatch(confirmMonthText('2026-10-01', 0).message, /검토 대기/);
  assert.match(unconfirmMonthText('2026-10-01').message, /확인 기록을 지워요/);
});

test('지난 달: 지금 달 빼고 최근 순, 확인 상태만, 최대 12달', () => {
  const status = [{ period_month: '2026-08-01', review_state: 'changed_after_review' }, { period_month: '2026-09-01', review_state: 'reviewed' }, { period_month: '2026-10-01', review_state: 'not_reviewed' }];
  assert.deepEqual(pastMonths(status, { exclude: '2026-10-01' }).map((x) => [x.label, x.state]), [['2026년 9월', '확인 완료'], ['2026년 8월', '확인 후 변경됨']]);
  const many = Array.from({ length: 20 }, (_, i) => ({ period_month: `20${25 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`, review_state: 'reviewed' }));
  assert.equal(pastMonths(many).length, 12);
});

test('정산 기본 달 = 지난달(서울 기준), 1월이면 전년 12월', () => {
  assert.equal(defaultSettleMonth(new Date('2026-10-29T03:00:00Z')), '2026-09-01');
  assert.equal(defaultSettleMonth(new Date('2026-01-15T03:00:00Z')), '2025-12-01');
  assert.equal(defaultSettleMonth(new Date('2026-01-31T15:30:00Z')), '2026-01-01', '서울은 이미 2월 1일');
  assert.equal(defaultSettleMonth(new Date('2025-12-31T14:59:00Z')), '2025-11-01', '서울 12월 31일 23:59');
});
