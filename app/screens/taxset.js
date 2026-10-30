// =====================================================================
// 더보기 › 연말정산 설정 #/taxset (CL-062 E2)
// 조회: deduction_rules(올해 규칙 있는지), member_tax_profiles·deduction_baselines(본인 행, 올해)
// 쓰기(본인 행만 — RLS): member_tax_profiles upsert(총급여 만 원 단위·자녀 수·월세 요건·실손보험금),
//                       deduction_baselines upsert(기준일 하나 × 6개 항목 한 번에 — 재리뷰 P-6),
//                       전세자금대출(CL-065 H2): member_tax_profiles upsert(키 + 요건 확인·원금·상환증명서·청약 공제액만 — 다른 칸은 그대로)
// - 총급여는 기본 가림(●●●●만 원). 고칠 때만 입력칸. 값은 오류 기록·주소·콘솔에 남기지 않는다(오류는 코드만 기록)
// - 기준값 지우기는 두지 않는다(같은 기준일로 다시 넣으면 덮어씀)
// 의존: ui/dom.js, router.js, core/confirm.js, core/format.js, core/errors.js, screens/deduction-model.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { buildHash, currentMonth } from '../router.js';
import { confirmDialog } from '../core/confirm.js';
import { todaySeoul, won } from '../core/format.js';
import { STAGES } from '../core/errors.js';
import {
  BASELINE_KINDS, MAN, checkProfile, checkBaselines, baselineGroups, maskedSalary, checkHousing, HOUSING_REQUIREMENTS, HOUSING_SAVINGS_NOTE,
} from './deduction-model.js';
import { errorView } from './shell.js';

const eq = (col, value) => ({ col, op: 'eq', value });
let taxNotice = null;

/** 기준일 기본값: 그해 9월 30일(연말정산 미리보기 1~9월), 아직 안 왔으면 오늘 */
export function defaultAsOf(taxYear, today) {
  const sep = `${taxYear}-09-30`;
  return today >= sep ? (today.slice(0, 4) > String(taxYear) ? `${taxYear}-12-31` : sep) : today;
}

/**
 * @param {{ db, member, reload(), isCurrent(), onError }} ctx
 */
export async function renderTaxSettings({ db, member, reload, isCurrent, onError }, doc = globalThis.document) {
  const taxYear = Number(currentMonth().slice(0, 4));
  const me = member.memberId;
  const [rules, prof, base] = await Promise.all([
    db.select('deduction_rules', { columns: 'tax_year', filters: [eq('tax_year', taxYear)] }),
    db.select('member_tax_profiles', {
      columns: 'member_id,tax_year,total_salary_amount,child_count,is_rent_eligible,medical_reimbursed_amount,'
        + 'is_housing_loan_eligible,housing_loan_principal_amount,housing_loan_certified_amount,housing_savings_deduction_amount',
      filters: [eq('member_id', me), eq('tax_year', taxYear)],
    }),
    db.select('deduction_baselines', {
      columns: 'as_of_on,deduction_kind,amount', filters: [eq('member_id', me), eq('tax_year', taxYear)],
      order: [{ col: 'as_of_on', ascending: false }],
    }),
  ]);
  if (!isCurrent()) return null;
  const head = h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav' }, [
      h('a', { class: 'icon-btn', text: '‹', attrs: { href: buildHash('more'), 'aria-label': '더보기로' } }, [], doc),
      h('h1', { class: 'title', text: `연말정산 설정 · ${taxYear}` }, [], doc),
    ], doc),
  ], doc);
  const error = rules.error ?? prof.error ?? base.error;
  if (error) {
    onError?.(error);
    return h('main', { class: 'screen' }, [head, errorView(error.message, error.detail?.sqlState ?? error.code, doc)], doc);
  }
  if (!rules.data?.length) {
    return h('main', { class: 'screen' }, [head, h('section', { class: 'card' }, [h('p', { class: 'muted', text: `${taxYear}년 공제 규칙이 아직 없어요.` }, [], doc)], doc)], doc);
  }
  const p = prof.data?.[0] ?? null;

  const status = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  const say = (msg, isError = false) => {
    status.textContent = msg;
    status.className = `status-line${isError ? ' error' : ''}`;
  };
  if (taxNotice) { say(taxNotice.text, taxNotice.isError); taxNotice = null; }
  // 오류 코드만 기록(값은 담지 않음 — AppError는 문장·코드만)
  const fail = (err) => {
    const code = onError?.(err, { stage: STAGES.db_update });
    say(`${err.message}${code ? ` (오류 번호 ${code})` : ''}`, true);
  };
  const done = (text) => { taxNotice = { text, isError: false }; reload(); };

  const input = (label, attrs, value = '') => {
    const el = h('input', { class: 'field', attrs: { 'aria-label': label, autocomplete: 'off', ...attrs } }, [], doc);
    el.value = value;
    return el;
  };
  const field = (label, el, note = null) => h('label', { class: 'form-row' }, [
    h('span', { class: 'field-label', text: label }, [], doc), el, note ? h('span', { class: 'muted small', text: note }, [], doc) : null,
  ], doc);

  // ---- 내 설정
  const salary = input('총급여(만 원)', { inputmode: 'numeric', maxlength: '6', placeholder: '예: 4200' });
  const salaryBox = h('div', { class: 'tax-salary', attrs: { hidden: p?.total_salary_amount != null ? true : null } }, [salary], doc);
  const salaryShown = h('div', { class: 'tax-salary-mask', attrs: { hidden: p?.total_salary_amount == null ? true : null } }, [
    h('span', { text: maskedSalary(p?.total_salary_amount) }, [], doc),
    h('button', {
      class: 'btn mini', text: '고치기', attrs: { type: 'button', 'aria-label': '총급여 고치기' },
      on: {
        click: () => {
          salary.value = String(Number(p.total_salary_amount) / MAN);
          salaryBox.hidden = false;
          salaryShown.hidden = true;
          salary.focus();
        },
      },
    }, [], doc),
  ], doc);
  const child = input('자녀 등 수', { inputmode: 'numeric', maxlength: '2' }, String(p?.child_count ?? 0));
  const rent = h('input', { attrs: { type: 'checkbox', 'aria-label': '월세 공제 요건 해당' } }, [], doc);
  rent.checked = Boolean(p?.is_rent_eligible);
  const reimbursed = input('실손보험금 받은 액(원)', { inputmode: 'numeric', maxlength: '13' }, String(Number(p?.medical_reimbursed_amount ?? 0)));
  const saveProfile = h('button', { class: 'btn primary', text: '내 설정 저장', attrs: { type: 'button' } }, [], doc);
  saveProfile.addEventListener('click', async () => {
    // 총급여를 고치지 않았으면(가림 상태) 지금 값 그대로
    const salaryMan = salaryBox.hidden ? (p?.total_salary_amount != null ? String(Number(p.total_salary_amount) / MAN) : '') : salary.value;
    const v = checkProfile({ salaryMan, childCount: child.value, rentEligible: rent.checked, reimbursed: reimbursed.value }, me, taxYear);
    if (!v.ok) { say(v.message, true); return; }
    saveProfile.disabled = true;
    const r = await db.upsert('member_tax_profiles', v.row);
    saveProfile.disabled = false;
    if (r.error) { fail(r.error); return; }
    done('내 설정을 저장했어요. 정산 탭 공제 현황에 바로 반영돼요.');
  });
  const profileCard = h('section', { class: 'card form' }, [
    h('h2', { class: 'card-title', text: `내 설정 (${member.displayName})` }, [], doc),
    h('p', { class: 'muted small', text: '본인 것만 고칠 수 있어요. 두 사람 모두 정산 탭에서 볼 수 있어요. 총급여는 가려 두지만 다른 숫자로 짐작할 수 있어요.' }, [], doc),
    h('div', { class: 'form-row' }, [h('span', { class: 'field-label', text: '총급여(만 원, 연)' }, [], doc), salaryShown, salaryBox,
      h('span', { class: 'muted small', text: '원천징수영수증의 총급여. 비우면 공제를 계산하지 않아요.' }, [], doc)], doc),
    field('자녀 등 수(카드 공제 한도)', child),
    h('label', { class: 'filter-check' }, [rent, h('span', { text: '월세 공제 요건 해당(무주택 세대주 · 임대차계약서 명의 본인)' }, [], doc)], doc),
    field('실손보험금 받은 액(원, 의료비에서 뺌)', reimbursed),
    saveProfile,
  ], doc);

  // ---- 전세자금대출 원리금 상환액 소득공제 (CL-065 H2) — 본인 행만, 요건은 본인이 읽고 켠다
  const loanOk = h('input', { attrs: { type: 'checkbox', 'aria-label': '전세자금대출 공제 요건을 모두 확인했어요' } }, [], doc);
  loanOk.checked = Boolean(p?.is_housing_loan_eligible);
  const amountText = (v, blankIfNull = false) => (v == null ? (blankIfNull ? '' : '0') : String(Number(v)));
  const principal = input('원금 상환액(원)', { inputmode: 'numeric', maxlength: '13', placeholder: '0' }, amountText(p?.housing_loan_principal_amount));
  const certified = input('상환증명서 원리금 합계(원)', { inputmode: 'numeric', maxlength: '13', placeholder: '없으면 비워 두기' }, amountText(p?.housing_loan_certified_amount, true));
  const savings = input('주택마련저축 공제액(원)', { inputmode: 'numeric', maxlength: '13', placeholder: '모르면 비워 두기(0)' }, amountText(p?.housing_savings_deduction_amount));
  const saveLoan = h('button', { class: 'btn primary', text: '전세자금대출 저장', attrs: { type: 'button' } }, [], doc);
  saveLoan.addEventListener('click', async () => {
    const v = checkHousing({ eligible: loanOk.checked, principal: principal.value, certified: certified.value, savings: savings.value }, me, taxYear);
    if (!v.ok) { say(v.message, true); return; }
    saveLoan.disabled = true;
    const r = await db.upsert('member_tax_profiles', v.row);
    saveLoan.disabled = false;
    if (r.error) { fail(r.error); return; }
    done('전세자금대출 공제 설정을 저장했어요. 정산 탭 공제 현황(사람별)에 반영돼요.');
  });
  const loanCard = h('section', { class: 'card form' }, [
    h('h2', { class: 'card-title', text: '전세자금대출 원리금 상환(소득공제)' }, [], doc),
    h('p', { class: 'muted small', text: '카드 선택과는 상관없어요. 가계부의 대출이자 거래 + 아래 원금으로 계산하고, 상환증명서 값을 넣으면 그 값을 써요.' }, [], doc),
    h('p', { class: 'field-label', text: '요건(모두 맞아야 해요)' }, [], doc),
    h('ul', { class: 'req-list' }, HOUSING_REQUIREMENTS.map((t) => h('li', { text: t }, [], doc)), doc),
    h('label', { class: 'filter-check' }, [loanOk, h('span', { text: '위 요건을 모두 확인했어요(본인)' }, [], doc)], doc),
    field('원금 상환액(원, 올해)', principal, '이자만 냈으면 0. 가계부는 원금 상환을 몰라요.'),
    field('상환증명서 원리금 합계(원)', certified, '연말에 은행에서 받은 증명서 값. 넣으면 가계부보다 우선해요.'),
    field('주택마련저축(청약) 공제액(원)', savings, `납입액이 아니라 공제액이에요. ${HOUSING_SAVINGS_NOTE}`),
    saveLoan,
  ], doc);

  // ---- 국세청 기준값
  const today = todaySeoul();
  const asOf = input('기준일', { type: 'date', min: `${taxYear}-01-01`, max: today < `${taxYear}-12-31` ? today : `${taxYear}-12-31` }, defaultAsOf(taxYear, today));
  const amounts = Object.fromEntries(BASELINE_KINDS.map(([k, label]) => [k, input(`${label}(원)`, { inputmode: 'numeric', maxlength: '13', placeholder: '0' })]));
  const groups = baselineGroups(base.data);
  const saveBase = h('button', { class: 'btn primary', text: '기준값 저장', attrs: { type: 'button' } }, [], doc);
  saveBase.addEventListener('click', async () => {
    const v = checkBaselines({ asOf: asOf.value, amounts: Object.fromEntries(Object.entries(amounts).map(([k, el]) => [k, el.value])) }, me, taxYear, today);
    if (!v.ok) { say(v.message, true); return; }
    const over = groups.some((g) => g.asOf === asOf.value);
    const ok = await confirmDialog({
      title: '국세청 기준값 저장',
      message: `${asOf.value}까지의 6개 항목을 저장해요.${over ? ' 같은 기준일 값이 있어 덮어써요.' : ''} 공제 현황은 항목마다 이 날까지 국세청 값, 다음 날부터 가계부로 계산해요.`,
      confirmLabel: '저장', doc,
    });
    if (!ok) return;
    saveBase.disabled = true;
    const r = await db.upsert('deduction_baselines', v.rows);
    saveBase.disabled = false;
    if (r.error) { fail(r.error); return; }
    done(`${asOf.value} 국세청 기준값을 저장했어요.`);
  });
  const fillFrom = (g) => {
    asOf.value = g.asOf;
    for (const [k, el] of Object.entries(amounts)) el.value = g.values.has(k) ? String(g.values.get(k)) : '';
    say(`${g.asOf} 값을 칸에 넣었어요. 고친 뒤 저장하면 덮어써요.`);
  };
  const baseCard = h('section', { class: 'card form' }, [
    h('h2', { class: 'card-title', text: '국세청 기준값(선택)' }, [], doc),
    h('p', { class: 'muted small', text: '가계부가 모르는 현금영수증·전통시장 등을 메워요. 홈택스 연말정산 미리보기(1~9월) 또는 간소화(1~12월)의 사용액을 그대로 넣어 주세요.' }, [], doc),
    h('p', { class: 'notice small', text: '한 기준일에 6개 항목을 모두 국세청 값 그대로 넣어 주세요(없는 항목은 0). 일부만 넣으면 가계부와 국세청의 분류가 다른 거래가 두 번 셀 수 있어요.' }, [], doc),
    h('p', { class: 'muted small', text: '잘못 넣었으면 같은 기준일로 다시 넣어 덮어써 주세요(지우기는 아직 없어요).' }, [], doc),
    field('기준일(이 날까지의 합계)', asOf),
    ...BASELINE_KINDS.map(([k, label]) => field(`${label}(원)`, amounts[k])),
    saveBase,
    groups.length ? h('h3', { class: 'section-title', text: '넣은 기준값' }, [], doc) : null,
    groups.length ? h('ul', { class: 'todo-list' }, groups.map((g) => h('li', {}, [
      h('div', { class: 'todo' }, [
        h('span', { class: 'todo-text' }, [
          h('span', { text: `${g.asOf}까지${g.complete ? '' : ' (일부 항목만)'}` }, [], doc),
          h('span', { class: 'sub', text: BASELINE_KINDS.filter(([k]) => g.values.has(k)).map(([k, label]) => `${label.replace(/\(.*\)$/, '')} ${won(g.values.get(k))}`).join(' · ') }, [], doc),
        ], doc),
        h('button', { class: 'btn mini', text: '칸에 넣기', attrs: { type: 'button', 'aria-label': `${g.asOf} 값 고치기` }, on: { click: () => fillFrom(g) } }, [], doc),
      ], doc),
    ], doc)), doc) : null,
  ], doc);

  return h('main', { class: 'screen' }, [
    head, status, profileCard, loanCard, baseCard,
    h('p', { class: 'muted small', text: '모든 공제 숫자는 가계부 기준 추정이에요. 최종은 홈택스 간소화 자료로 확인해 주세요.' }, [], doc),
  ], doc);
}
