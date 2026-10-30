// 전세자금대출 원리금 상환액 소득공제 화면 (CL-065) — 합성 값만
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb } from '../../app/core/db.js';
import { checkHousing, housingLoanLine, HOUSING_REQUIREMENTS, HOUSING_INTEREST_NOTE, HOUSING_SAVINGS_NOTE } from '../../app/screens/deduction-model.js';
import { TAX_CREDIT_KINDS, autoView, categoryDeductionPatch, categoryDeductionTag } from '../../app/screens/deduction-edit-model.js';

const src = (p) => readFileSync(new URL(`../../app/${p}`, import.meta.url), 'utf8');
const BIG = Number('9'.repeat(10)); // DB 상한(열 자리 9)

function fakeClient() {
  const calls = [];
  const b = (path) => {
    const o = {};
    for (const m of ['upsert', 'select']) o[m] = (...a) => { path.push([m, ...a]); return o; };
    o.then = (res) => Promise.resolve({ data: [{}], error: null }).then(res);
    return o;
  };
  return { calls, from(n) { const p = [['from', n]]; calls.push(p); return b(p); }, rpc: () => Promise.resolve({ data: null, error: null }) };
}

test('db.upsert: 전세자금대출 4칸 허용, 값 검사(0~상한 정수, 증명서는 null도, 요건은 참·거짓)', async () => {
  const c = fakeClient();
  const db = createDb(c);
  const row = {
    member_id: 'm1', tax_year: 2026, is_housing_loan_eligible: true,
    housing_loan_principal_amount: 0, housing_loan_certified_amount: null, housing_savings_deduction_amount: BIG,
  };
  assert.equal((await db.upsert('member_tax_profiles', row)).error, null);
  assert.equal((await db.upsert('member_tax_profiles', { ...row, housing_loan_certified_amount: 1200000 })).error, null);
  assert.equal(c.calls.length, 2);
  for (const bad of [
    { housing_loan_principal_amount: -1 }, { housing_loan_principal_amount: BIG + 1 }, { housing_loan_principal_amount: 1.5 },
    { housing_loan_principal_amount: '100' }, { housing_loan_principal_amount: null }, { housing_savings_deduction_amount: null },
    { housing_loan_certified_amount: -5 }, { is_housing_loan_eligible: 'yes' }, { is_housing_loan_eligible: null },
  ]) assert.equal((await db.upsert('member_tax_profiles', { ...row, ...bad })).error?.code, 'invalid', JSON.stringify(bad));
  assert.equal(c.calls.length, 2, '거부한 값은 보내지 않음');
});

test('입력 검사: 원금·청약은 비우면 0, 증명서는 비우면 null, 쉼표·전각 허용, 11자리 이상 거부, 키 + 4칸만', () => {
  const ok = checkHousing({ eligible: true, principal: '1,200,000', certified: '', savings: '' }, 'm1', 2026);
  assert.deepEqual(ok, { ok: true, row: {
    member_id: 'm1', tax_year: 2026, is_housing_loan_eligible: true,
    housing_loan_principal_amount: 1200000, housing_loan_certified_amount: null, housing_savings_deduction_amount: 0,
  } });
  assert.equal(checkHousing({ eligible: false, principal: '', certified: '３００００００', savings: '480000' }, 'm1', 2026).row.housing_loan_certified_amount, 3000000);
  assert.equal(checkHousing({ principal: '1'.repeat(11) }, 'm1', 2026).field, 'principal');
  assert.equal(checkHousing({ certified: '-3' }, 'm1', 2026).field, 'certified');
  assert.equal(checkHousing({ savings: '1.5' }, 'm1', 2026).field, 'savings');
  assert.equal(checkHousing({}, 'm1', 2026).row.is_housing_loan_eligible, false);
});

const base = {
  is_housing_loan_eligible: true, housing_loan_interest_amount: '1500000', housing_loan_principal_amount: '2000000',
  housing_loan_certified_amount: null, housing_loan_repaid_amount: '3500000', housing_savings_deduction_amount: '0', housing_loan_deduction_amount: '1400000',
};

test('사람별 한 줄: 요건 켬 → 상환액·예상 소득공제, 출처(가계부 이자 + 원금 / 증명서 우선), 이자 안내, 청약 안내', () => {
  const l = housingLoanLine(base);
  assert.equal(l.text, '전세자금대출 상환 3,500,000원 → 예상 소득공제 1,400,000원');
  assert.deepEqual(l.sub, ['가계부 이자 1,500,000원 + 원금(입력) 2,000,000원', HOUSING_INTEREST_NOTE, HOUSING_SAVINGS_NOTE]);
  const cert = housingLoanLine({ ...base, housing_loan_certified_amount: '4000000', housing_savings_deduction_amount: '480000' });
  assert.equal(cert.sub[0], '상환증명서 원리금 4,000,000원(가계부보다 우선)');
  assert.equal(cert.sub[2], '청약(주택마련저축) 공제 480,000원만큼 한도가 줄었어요.');
});

test('사람별 한 줄: 요건 꺼짐 → 계산 안내, 규칙 없음 → 안내, 아무것도 없으면 줄 없음', () => {
  const off = housingLoanLine({ ...base, is_housing_loan_eligible: false, housing_loan_deduction_amount: '0' });
  assert.equal(off.text, '전세자금대출 상환 · 요건을 확인하면 계산해요');
  assert.ok(off.sub.includes(HOUSING_INTEREST_NOTE));
  assert.equal(housingLoanLine({ ...base, housing_loan_deduction_amount: null }).text, '전세자금대출 상환 · 올해 공제 규칙이 없어요');
  assert.equal(housingLoanLine({ is_housing_loan_eligible: false, housing_loan_interest_amount: '0', housing_loan_principal_amount: '0', housing_loan_certified_amount: null, housing_loan_deduction_amount: null }), null);
  assert.equal(housingLoanLine(null), null);
});

test('소득공제라 부름(세액공제 아님 — 리뷰 P-1), 요건 4가지', () => {
  assert.equal(HOUSING_REQUIREMENTS.length, 4);
  const all = [housingLoanLine(base).text, ...housingLoanLine(base).sub, HOUSING_INTEREST_NOTE, HOUSING_SAVINGS_NOTE].join(' ');
  assert.doesNotMatch(all, /세액공제/);
  assert.match(housingLoanLine(base).text, /소득공제/);
  for (const f of ['screens/taxset.js', 'screens/detail-deduction.js', 'screens/deduction-edit-model.js']) {
    for (const line of src(f).split('\n').filter((l) => l.includes('전세자금대출') && !l.trim().startsWith('//'))) {
      assert.doesNotMatch(line, /세액공제/, `${f}: ${line.trim()}`);
    }
  }
});

test('카테고리 공제 표시: 전세자금대출 선택지가 있어 저장해도 지워지지 않음, 꼬리표', () => {
  assert.ok(TAX_CREDIT_KINDS.some(([k]) => k === 'housing_rent_loan'));
  const cat = { default_deduction_kind: null, tax_credit_kind: 'housing_rent_loan' };
  assert.equal(categoryDeductionPatch(cat, { defaultKind: '', taxCredit: 'housing_rent_loan' }), null, '그대로 저장하면 바뀐 것 없음');
  assert.deepEqual(categoryDeductionPatch(cat, { defaultKind: '', taxCredit: '' }), { tax_credit_kind: null }, '비우기는 사용자가 고를 때만');
  assert.equal(categoryDeductionTag(cat), '전세자금대출(소득공제)');
});

test('거래 상세: 전세자금대출 표시 거래 판정, 화면에 대상 표시·다른 대출 안내', () => {
  assert.equal(autoView([{ deduction_kind: 'none', tax_credit_kind: 'housing_rent_loan' }]).housingLoan, true);
  assert.equal(autoView([{ deduction_kind: 'credit_card', tax_credit_kind: 'medical' }]).housingLoan, false);
  const d = src('screens/detail-deduction.js');
  assert.match(d, /auto\.housingLoan \? h\('p', \{ class: 'ded-loan-tag', text: HOUSING_TXN_TEXT \}/);
  assert.match(d, /auto\.housingLoan \? h\('p', \{ class: 'muted small', text: HOUSING_TXN_OTHER \}/);
});

test('화면 소스: 정산 상세에 한 줄(카드 표 아님), 설정은 본인 행 upsert, 값은 기록·콘솔에 안 남김', () => {
  const card = src('screens/deduction-card.js');
  for (const c of ['is_housing_loan_eligible', 'housing_loan_interest_amount', 'housing_loan_principal_amount', 'housing_loan_certified_amount',
    'housing_loan_repaid_amount', 'housing_savings_deduction_amount', 'housing_loan_deduction_amount']) assert.ok(card.includes(`'${c}'`), c);
  assert.match(card, /const loan = housingLoanLine\(r\);/);
  assert.doesNotMatch(src('screens/deduction-model.js').match(/export const RATE_ROWS[^;]+;/)[0], /housing/, '카드 선택 표에는 없음');
  const tax = src('screens/taxset.js');
  assert.match(tax, /checkHousing\(\{ eligible: loanOk\.checked, principal: principal\.value, certified: certified\.value, savings: savings\.value \}, me, taxYear\)/);
  assert.match(tax, /await db\.upsert\('member_tax_profiles', v\.row\)/);
  for (const f of ['screens/taxset.js', 'screens/deduction-card.js', 'screens/detail-deduction.js']) {
    assert.doesNotMatch(src(f), /console\.|innerHTML/, f);
  }
});
