// 정산 화면 모델 (DB·브라우저 없이, 가짜 이름만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleSummary, reviewView, confirmMonthText, unconfirmMonthText, pastMonths } from '../../app/screens/settle-model.js';

const members = [{ id: 'm2', member_slot: 2, display_name: '나리' }, { id: 'm1', member_slot: 1, display_name: '가람' }];
const oct = [
  { period_month: '2026-10-01', member_id: 'm1', paid_amount: '900000', share_amount: '847700', balance_amount: '52300' },
  { period_month: '2026-10-01', member_id: 'm2', paid_amount: 795400, share_amount: 847700, balance_amount: -52300 },
];

test('요약: 더 낸 사람 문장, 공동지출 합계, 사람별 표(자리 순)', () => {
  const s = settleSummary(oct, members);
  assert.equal(s.headline, '가람이 52,300원 더 냈어요');
  assert.equal(s.total, '1,695,400원');
  assert.deepEqual(s.table.map((r) => [r.name, r.paid, r.share, r.balance]), [
    ['가람', '900,000원', '847,700원', '+52,300원'], ['나리', '795,400원', '847,700원', '−52,300원']]);
  assert.equal(settleSummary([{ ...oct[0], balance_amount: 0 }, { ...oct[1], balance_amount: 0 }], members).headline, '두 사람이 낸 공동지출이 같아요');
  const empty = settleSummary([], members);
  assert.deepEqual([empty.empty, empty.total, empty.table.map((r) => r.balance)], [true, '0원', ['0원', '0원']]);
  assert.equal(settleSummary([{ ...oct[0], balance_amount: -10 }, { ...oct[1], balance_amount: 10 }], members).headline, '나리가 10원 더 냈어요');
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

test('지난 달: 지금 달 빼고 최근 순, 상태·차이 문장, 최대 12달', () => {
  const sep = [{ period_month: '2026-09-01', member_id: 'm2', paid_amount: 100, share_amount: 50, balance_amount: 50 }];
  const status = [{ period_month: '2026-09-01', review_state: 'reviewed' }, { period_month: '2026-08-01', review_state: 'changed_after_review' }];
  const p = pastMonths([...oct, ...sep], status, members, { exclude: '2026-10-01' });
  assert.deepEqual(p.map((x) => [x.label, x.state, x.diff]), [['2026년 9월', '확인 완료', '나리가 50원 더 냈어요'], ['2026년 8월', '확인 후 변경됨', '공동지출 없음']]);
  const many = Array.from({ length: 20 }, (_, i) => ({ period_month: `20${25 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`, review_state: 'reviewed' }));
  assert.equal(pastMonths([], many, members).length, 12);
});
