// 연말정산 공제 현황 (CL-062) — 가짜 값만(총급여·금액 모두 합성)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  manWon, rateText, peopleView, bestChoice, rateSub, monthlyCardAverage, monthsToMinimum, minimumLine, medicalLines, rentLines,
  detailRows, sourceLine, minimumRatio, minimumBarView, checkProfile, checkBaselines, baselineGroups, maskedSalary, josa, BASELINE_KINDS, MAN,
} from '../../app/screens/deduction-model.js';
import { recentMonths, readRecentTxns } from '../../app/screens/deduction-card.js';
import { defaultAsOf } from '../../app/screens/taxset.js';
import { parseHash } from '../../app/router.js';
import { activeTab } from '../../app/screens/shell.js';

const members = [{ id: 'm2', member_slot: 2, display_name: '나리' }, { id: 'm1', member_slot: 1, display_name: '가람' }];
const SAL = 30 * 1000 * MAN; // 가짜 총급여
const st = (member_id, o = {}) => ({
  member_id, tax_year: 2026, total_salary_amount: String(SAL), remaining_to_minimum_amount: '0', total_spend_amount: '9000000', minimum_spend_amount: '7500000',
  marginal_credit_rate: '15', marginal_check_rate: '30', marginal_public_transit_rate: '40', ...o,
});

test('글자: 만 원, 공제율, 조사', () => {
  assert.deepEqual([manWon(4200000), manWon(9999), manWon(null), manWon('15000')], ['420만 원', '9,999원', '-', '2만 원']);
  assert.deepEqual([rateText(30), rateText('15.0'), rateText(null)], ['30%', '15%', '-']);
  assert.deepEqual([josa('가람', '은', '는'), josa('나리', '은', '는')], ['은', '는']);
});

test('사람별 모델: 자리 순, 총급여 없으면 공제율 null, 최저 넘음 여부', () => {
  const p = peopleView([st('m2'), st('m1', { total_salary_amount: null })], members);
  assert.deepEqual(p.map((x) => [x.name, x.hasSalary, x.rates.check, x.pastMinimum]), [['가람', false, null, false], ['나리', true, 30, true]]);
  assert.equal(rateSub(p[0], 'check'), '총급여 없음');
});

test('가장 유리: 최고 공제율, 같으면 최저까지 남은 금액 작은 쪽, 대중교통 칩, 둘 다 최저 전, 총급여 없음', () => {
  const both = peopleView([
    st('m1', { remaining_to_minimum_amount: '4200000', total_spend_amount: '3300000', marginal_credit_rate: '0', marginal_check_rate: '0', marginal_public_transit_rate: '0' }),
    st('m2'),
  ], members);
  assert.equal(bestChoice(both).text, '나리 체크카드 (공제율 30%)');
  assert.equal(bestChoice(both, 'transit').text, '나리 대중교통(카드) (공제율 40%)');
  assert.equal(rateSub(both[0], 'credit'), '최저까지 420만 원');
  // 같은 30%: 둘 다 넘었으면 남은 금액 0 같음 → 체크 먼저, 같은 율이면 남은 금액 작은 쪽
  const tie = peopleView([st('m1', { remaining_to_minimum_amount: '0' }), st('m2', { marginal_check_rate: '30' })], members);
  assert.equal(bestChoice(tie).medium, 'check');
  const zero = { marginal_credit_rate: '0', marginal_check_rate: '0', marginal_public_transit_rate: '0' };
  const before = peopleView([
    st('m1', { ...zero, remaining_to_minimum_amount: '1000000' }), st('m2', { ...zero, remaining_to_minimum_amount: '3000000' }),
  ], members);
  const b = bestChoice(before);
  assert.equal(b.none, true);
  assert.match(b.text, /가람이 최저까지 100만 원 남아 가장 가까워요/);
  assert.match(bestChoice(peopleView([], members)).text, /총급여를 넣으면/);
});

test('언제 넘는지(E5): 최근 3개월 그 연도만, 카드 공제 항목만 월평균 → 개월 올림', () => {
  assert.deepEqual(recentMonths('2026-10-01'), ['2026-08-01', '2026-09-01', '2026-10-01']);
  assert.deepEqual(recentMonths('2026-02-01'), ['2026-01-01', '2026-02-01']); // 지난해는 빼고
  const txns = [
    { deduction_kind: 'credit_card', signed_amount: '900000', occurred_on: '2026-08-03' },
    { deduction_kind: 'check_card', signed_amount: 300000, occurred_on: '2026-09-03' },
    { deduction_kind: 'none', signed_amount: 5000000, occurred_on: '2026-09-03' },
    { deduction_kind: 'excluded', signed_amount: 5000000, occurred_on: '2026-09-03' },
    { deduction_kind: 'public_transit', signed_amount: -100000, occurred_on: '2026-10-03' },
    { deduction_kind: 'credit_card', signed_amount: 9000000, occurred_on: '2026-07-31' },
  ];
  const avg = monthlyCardAverage(txns, recentMonths('2026-10-01'));
  assert.equal(avg, 366667);
  assert.deepEqual([monthsToMinimum(0, avg), monthsToMinimum(1000000, avg), monthsToMinimum(1000000, 0)], [0, 3, null]);
  const p = peopleView([st('m1', { remaining_to_minimum_amount: '1000000', total_spend_amount: '6500000' }), st('m2', { total_salary_amount: null })], members);
  assert.match(minimumLine(p[0], avg), /^가람은 최저사용금액까지 100만 원 남음 — .*약 3개월 뒤 넘음$/);
  assert.match(minimumLine(p[1], avg), /총급여를 넣으면/);
});

test('의료비·월세 칩: 본인 의료비·문턱·세액공제, 다른 사람 의료비 경고, 월세 요건·E7 안내', () => {
  const p = peopleView([
    st('m1', { medical_amount: '300000', medical_other_amount: '400000', medical_remaining_to_threshold_amount: '600000', rent_amount: '1200000', is_rent_eligible: false }),
    st('m2', { medical_amount: '2000000', medical_other_amount: '0', medical_remaining_to_threshold_amount: '0', medical_credit_amount: '165000', rent_amount: '0', is_rent_eligible: true, rent_credit_amount: '0' }),
  ], members);
  const med = medicalLines(p);
  assert.equal(med[0].text, '본인 의료비 30만 원 · 문턱(총급여 3%)까지 60만 원');
  assert.match(med[0].warn, /가람 카드로 낸 다른 사람 의료비 40만 원/);
  assert.equal(med[1].text, '본인 의료비 200만 원 · 예상 세액공제 165,000원');
  const r = rentLines(p);
  assert.equal(r.lines[0].text, '월세 120만 원 · 월세 공제 요건 꺼짐');
  assert.equal(r.lines[1].text, '월세 0원 · 예상 세액공제 0원');
  assert.match(r.note, /가람 명의 결제수단에서 월세가 나갔어요\. 계약자\(나리\) 계좌에서/);
  assert.equal(rentLines(peopleView([st('m1', { is_rent_eligible: false, rent_amount: '100' })], members)).note, null); // 요건 켠 사람이 없으면 안내 없음
});

test('상세·출처·막대', () => {
  const r = st('m1', { credit_card_amount: '100', check_card_amount: '200', public_transit_amount: '0', traditional_market_amount: '0', culture_amount: '0', excluded_amount: '50',
    card_deduction_amount: '0', base_limit_amount: '3000000', base_remaining_amount: '3000000', extra_limit_amount: '3000000', extra_remaining_amount: '3000000' });
  assert.deepEqual(detailRows(r).slice(0, 2), [['신용카드', '100원'], ['체크카드·현금영수증', '200원']]);
  assert.equal(detailRows({ ...r, total_salary_amount: null }).length, 6);
  assert.equal(sourceLine(r), '모두 가계부 기준 추정이에요.');
  assert.equal(sourceLine({ baseline_as_of_on: '2026-09-30' }), '9월 30일까지 국세청 값(넣은 항목) + 그 뒤 가계부 추정이에요.');
  assert.equal(minimumRatio(r), 1);
  assert.equal(minimumRatio({ minimum_spend_amount: '1000', total_spend_amount: '250' }), 0.25);
  assert.equal(minimumRatio(null), 0);
  assert.deepEqual([maskedSalary(null), maskedSalary(SAL)], ['넣지 않음', '●●●●만 원']);
});

test('내 설정 검사: 만 원 단위, 비우면 null, 자녀 0~20, 실손보험금 원', () => {
  const ok = checkProfile({ salaryMan: '3,000', childCount: '1', rentEligible: true, reimbursed: '50000' }, 'm1', 2026);
  assert.deepEqual(ok.row, { member_id: 'm1', tax_year: 2026, total_salary_amount: 3000 * MAN, child_count: 1, is_rent_eligible: true, medical_reimbursed_amount: 50000 });
  assert.equal(checkProfile({ salaryMan: '', childCount: '', reimbursed: '' }, 'm1', 2026).row.total_salary_amount, null);
  assert.equal(checkProfile({ salaryMan: '123456' }, 'm1', 2026).field, 'salary');
  assert.equal(checkProfile({ salaryMan: '30.5' }, 'm1', 2026).field, 'salary');
  assert.equal(checkProfile({ salaryMan: '1', childCount: '21' }, 'm1', 2026).field, 'child');
  assert.equal(checkProfile({ salaryMan: '1', reimbursed: '-1' }, 'm1', 2026).field, 'reimbursed');
});

test('국세청 기준값 검사: 6칸 모두(재리뷰 P-6), 그해 안, 오늘까지, 원 단위', () => {
  const amounts = Object.fromEntries(BASELINE_KINDS.map(([k], i) => [k, String(i * 1000)]));
  const ok = checkBaselines({ asOf: '2026-09-30', amounts }, 'm1', 2026, '2026-10-30');
  assert.equal(ok.rows.length, 6);
  assert.deepEqual(ok.rows[1], { member_id: 'm1', tax_year: 2026, as_of_on: '2026-09-30', deduction_kind: 'check_card', amount: 1000 });
  assert.match(checkBaselines({ asOf: '2026-09-30', amounts: { ...amounts, culture: '' } }, 'm1', 2026, '2026-10-30').message, /6칸을 모두/);
  assert.equal(checkBaselines({ asOf: '2025-12-31', amounts }, 'm1', 2026, '2026-10-30').field, 'asOf');
  assert.equal(checkBaselines({ asOf: '2026-11-01', amounts }, 'm1', 2026, '2026-10-30').field, 'asOf');
  assert.equal(checkBaselines({ asOf: '', amounts }, 'm1', 2026, '2026-10-30').field, 'asOf');
  assert.equal(checkBaselines({ asOf: '2026-09-30', amounts: { ...amounts, credit_card: '1.5' } }, 'm1', 2026, '2026-10-30').field, 'credit_card');
  const g = baselineGroups([...ok.rows, { as_of_on: '2026-06-30', deduction_kind: 'cash_receipt', amount: '7' }]);
  assert.deepEqual(g.map((x) => [x.asOf, x.complete, x.values.size]), [['2026-09-30', true, 6], ['2026-06-30', false, 1]]);
  assert.deepEqual([defaultAsOf(2026, '2026-10-30'), defaultAsOf(2026, '2026-05-02')], ['2026-09-30', '2026-05-02']);
});

test('주소: #/taxset은 더보기 탭', () => {
  assert.equal(parseHash('#/taxset').screen, 'taxset');
  assert.equal(activeTab('taxset'), 'more');
});

test('총급여 가림(리뷰 #51 중): 최저사용금액 금액·막대 읽어 주기 글은 보기일 때만, 가림 상태는 남은 금액·비율만', () => {
  const r = st('m1', { minimum_spend_amount: '10500000', total_spend_amount: '5250000', remaining_to_minimum_amount: '5250000',
    credit_card_amount: '0', check_card_amount: '0', public_transit_amount: '0', traditional_market_amount: '0', culture_amount: '0', excluded_amount: '0',
    card_deduction_amount: '0', base_limit_amount: '3000000', base_remaining_amount: '3000000', extra_limit_amount: '3000000', extra_remaining_amount: '3000000' });
  const hidden = detailRows(r).map(([k, v]) => `${k} ${v}`).join(' | ');
  assert.doesNotMatch(hidden, /10,500,000/);
  assert.match(hidden, /최저사용금액까지 남은 금액 5,250,000원/);
  assert.match(detailRows(r, { revealed: true }).map(([k, v]) => `${k} ${v}`).join(' | '), /최저사용금액\(총급여 25%\) 10,500,000원/);
  const bar = minimumBarView(r);
  assert.doesNotMatch(`${bar.text} ${bar.aria}`, /10,500,000/);
  assert.equal(bar.aria, '최저사용금액의 50% 사용, 5,250,000원 남음');
  assert.match(minimumBarView(r, true).aria, /^최저사용금액 10,500,000원 중 5,250,000원 사용\(50%\)$/);
});

test('최근 3개월 읽기 상한: 넘으면 capped(일부만 계산 안내)', async () => {
  const all = Array.from({ length: 7 }, (_, i) => ({ txn_id: `t${i}`, deduction_kind: 'credit_card', signed_amount: 1, occurred_on: '2026-10-01' }));
  const db = { async select(v, o) { return { data: all.slice(o.range.from, Math.min(o.range.to + 1, o.range.from + 2)), error: null }; } };
  const a = await readRecentTxns(db, 2026, ['2026-10-01'], { max: 3 });
  assert.deepEqual([a.data.rows.length, a.data.capped], [3, true]);
  const b = await readRecentTxns(db, 2026, ['2026-10-01'], { max: 100 });
  assert.deepEqual([b.data.rows.length, b.data.capped], [7, false]);
});
