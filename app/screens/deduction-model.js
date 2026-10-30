// =====================================================================
// 연말정산 공제 현황 — 화면 없이 계산하는 부분 (CL-062, 설계 outbox/2026-10-30-설계-연말정산-제안.md 3장·4-1 E1·E2·E5·E6·E7)
// - 숫자는 DB 뷰 v_deduction_status가 계산한다(공식은 뷰 한 곳). 앱은 고르기·문구만
// - "가장 유리" = 두 사람 × 결제수단(일반: 신용·체크, 대중교통: 대중교통) 한계 공제율 최고.
//   같으면 최저사용금액까지 남은 금액이 작은 쪽(둘 다 넘기는 게 이득) — 시안 README
// - 모든 숫자는 '가계부 기준 추정'. 공제율은 소득공제율이지 세금 절약률이 아니다(E6)
// - 총급여·기준값은 민감 정보: 이 모듈은 값을 기록·주소에 남기지 않는다(화면이 보여 주기만)
// 의존: core/format.js
// =====================================================================
import { won } from '../core/format.js';

export const MAN = 10000;
export const BASELINE_KINDS = Object.freeze([
  ['credit_card', '신용카드'], ['check_card', '체크카드(직불·선불)'], ['cash_receipt', '현금영수증'],
  ['traditional_market', '전통시장'], ['public_transit', '대중교통'], ['culture', '도서·공연·체육시설 등(문화체육)'],
]);
export const CHIPS = Object.freeze([['general', '일반'], ['transit', '대중교통'], ['medical', '의료비'], ['rent', '월세']]);
// 한계 공제율 표의 줄: [키, 이름, v_deduction_status 칸]
export const RATE_ROWS = Object.freeze([
  ['credit', '신용카드', 'marginal_credit_rate'],
  ['check', '체크카드·현금영수증', 'marginal_check_rate'],
  ['transit', '대중교통(카드)', 'marginal_public_transit_rate'],
]);

const num = (v) => (v == null || v === '' ? null : Math.round(Number(v)));
const pct = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);

/** 금액 → '420만 원'(만 원 단위 반올림), 1만 원 미만은 원 그대로 */
export function manWon(n) {
  const v = num(n);
  if (v == null) return '-';
  if (Math.abs(v) < MAN) return won(v);
  return `${(Math.round(v / MAN)).toLocaleString('ko-KR')}만 원`;
}

/** 공제율 글자: 30 → '30%', null → '-' */
export function rateText(r) {
  return r == null ? '-' : `${pct(r)}%`;
}

/**
 * 사람별 보기 모델(자리 순)
 * @param rows v_deduction_status(그 연도) 행들
 */
export function peopleView(rows, members) {
  const byId = new Map((rows ?? []).map((r) => [r.member_id, r]));
  return [...(members ?? [])].sort((a, b) => a.member_slot - b.member_slot).map((m) => {
    const r = byId.get(m.id) ?? null;
    const hasSalary = r?.total_salary_amount != null;
    return {
      id: m.id, name: m.display_name, row: r, hasSalary,
      rates: Object.fromEntries(RATE_ROWS.map(([k, , col]) => [k, hasSalary ? pct(r[col]) : null])),
      remaining: hasSalary ? num(r.remaining_to_minimum_amount) : null,
      pastMinimum: hasSalary && num(r.remaining_to_minimum_amount) === 0 && num(r.total_spend_amount) > num(r.minimum_spend_amount),
    };
  });
}

const MEDIUM = { credit: '신용카드', check: '체크카드', transit: '대중교통(카드)' };

/**
 * 지금 가장 유리한 결제 — 일반: 신용·체크 중, 대중교통: 대중교통 칸
 * @returns {{ who, medium, mediumText, rate, text } | { none: true, text }}
 */
export function bestChoice(people, chip = 'general') {
  const keys = chip === 'transit' ? ['transit'] : ['credit', 'check'];
  const cands = people.filter((p) => p.hasSalary).flatMap((p) => keys.map((k) => ({ p, k, rate: p.rates[k] ?? 0 })));
  if (!cands.length) return { none: true, text: '총급여를 넣으면 누구의 어떤 카드가 유리한지 계산해요.' };
  cands.sort((a, b) => b.rate - a.rate || (a.p.remaining ?? 0) - (b.p.remaining ?? 0) || (a.k === 'check' ? -1 : 1));
  const top = cands[0];
  if (top.rate === 0) {
    // 둘 다 최저사용금액 전: 어느 카드든 지금은 0% — 최저에 가까운 사람부터 채우기
    const near = [...people].filter((p) => p.hasSalary && p.remaining != null).sort((a, b) => a.remaining - b.remaining)[0];
    return {
      none: true,
      text: near ? `지금은 누구 카드든 공제 0%예요(최저사용금액 전). ${near.name}${josa(near.name, '이', '가')} 최저까지 ${manWon(near.remaining)} 남아 가장 가까워요.`
        : '지금은 누구 카드든 공제 0%예요(최저사용금액 전).',
    };
  }
  const mediumText = chip === 'transit' ? MEDIUM.transit : MEDIUM[top.k];
  return { who: top.p.name, whoId: top.p.id, medium: top.k, mediumText, rate: top.rate, text: `${top.p.name} ${mediumText} (공제율 ${rateText(top.rate)})` };
}

/** 받침에 따라 조사 */
export function josa(word, withBatchim, without) {
  const c = String(word ?? '').slice(-1).charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 === 0 ? without : withBatchim;
  return withBatchim;
}

/** 한계율 칸 아래 글: 최저 전이면 '최저까지 ○○만 원' */
export function rateSub(p, key) {
  if (!p.hasSalary) return '총급여 없음';
  if ((p.rates[key] ?? 0) === 0 && p.remaining > 0) return `최저까지 ${manWon(p.remaining)}`;
  return null;
}

// 카드 소득공제 사용액으로 세는 공제 항목(none·excluded 빼고)
const CARD_KINDS = new Set(['credit_card', 'check_card', 'cash_receipt', 'public_transit', 'traditional_market', 'culture']);

/**
 * E5: 최근 3개월(고른 달 포함, 그 연도 안) 두 사람 카드 사용 월평균 — '공동 지출을 몰면 언제 넘는지' 어림
 * @param txns v_deduction_txn 행 { member_id, deduction_kind, signed_amount, occurred_on }
 * @returns {number} 월평균(원), 자료 없으면 0
 */
export function monthlyCardAverage(txns, months) {
  const set = new Set(months.map((m) => m.slice(0, 7)));
  const sum = (txns ?? []).filter((t) => CARD_KINDS.has(t.deduction_kind) && set.has(String(t.occurred_on).slice(0, 7)))
    .reduce((s, t) => s + Number(t.signed_amount), 0);
  return months.length ? Math.max(0, Math.round(sum / months.length)) : 0;
}

/** 최저까지 남은 금액 ÷ 월평균 → 개월(올림). 계산 못 하면 null */
export function monthsToMinimum(remaining, average) {
  if (!remaining || remaining <= 0) return 0;
  if (!average || average <= 0) return null;
  return Math.ceil(remaining / average);
}

/** 사람 한 명의 최저사용금액 안내 한 줄 */
export function minimumLine(p, average) {
  if (!p.hasSalary) return `${p.name}: 총급여를 넣으면 계산해요(더보기 › 연말정산 설정).`;
  if (p.remaining > 0) {
    const n = monthsToMinimum(p.remaining, average);
    return `${p.name}${josa(p.name, '은', '는')} 최저사용금액까지 ${manWon(p.remaining)} 남음${n ? ` — 두 사람 카드 사용(최근 월평균 ${manWon(average)})을 ${p.name} 카드로 몰면 약 ${n}개월 뒤 넘음` : ''}`;
  }
  return `${p.name}${josa(p.name, '은', '는')} 최저사용금액을 넘었어요.`;
}

/** 의료비 칩: 사람별 줄 */
export function medicalLines(people) {
  return people.map((p) => {
    const r = p.row;
    if (!r) return { name: p.name, text: '자료 없음', warn: null };
    const own = num(r.medical_amount) ?? 0;
    const other = num(r.medical_other_amount) ?? 0;
    const parts = [`본인 의료비 ${manWon(own)}`];
    if (!p.hasSalary) parts.push('총급여를 넣으면 세액공제 계산');
    else {
      const left = num(r.medical_remaining_to_threshold_amount);
      parts.push(left > 0 ? `문턱(총급여 3%)까지 ${manWon(left)}` : `예상 세액공제 ${won(num(r.medical_credit_amount) ?? 0)}`);
    }
    return {
      name: p.name, text: parts.join(' · '),
      warn: other > 0 ? `${p.name} 카드로 낸 다른 사람 의료비 ${manWon(other)}은 공제되지 않을 수 있어요.` : null,
    };
  });
}

/**
 * 월세 칩: 사람별 줄 + E7 안내(요건을 켠 사람이 아닌 사람 명의 결제수단에서 월세가 나감)
 */
export function rentLines(people) {
  const eligible = people.filter((p) => p.row?.is_rent_eligible);
  const lines = people.map((p) => {
    const r = p.row;
    if (!r) return { name: p.name, text: '자료 없음' };
    const amount = num(r.rent_amount) ?? 0;
    if (!r.is_rent_eligible) return { name: p.name, text: `월세 ${manWon(amount)} · 월세 공제 요건 꺼짐` };
    if (!p.hasSalary) return { name: p.name, text: `월세 ${manWon(amount)} · 총급여를 넣으면 계산` };
    return { name: p.name, text: `월세 ${manWon(amount)} · 예상 세액공제 ${won(num(r.rent_credit_amount) ?? 0)}` };
  });
  const misplaced = people.filter((p) => !p.row?.is_rent_eligible && (num(p.row?.rent_amount) ?? 0) > 0);
  const note = eligible.length && misplaced.length
    ? `${misplaced.map((p) => p.name).join('·')} 명의 결제수단에서 월세가 나갔어요. 계약자(${eligible.map((p) => p.name).join('·')}) 계좌에서 이체하면 증빙이 쉬울 수 있어요(추정).`
    : null;
  return { lines, note };
}

/**
 * 접힌 상세(사람별) — 금액 줄
 * 총급여에서 바로 나오는 금액(최저사용금액 = 총급여 25%)은 '보기'를 눌렀을 때만(revealed). 가림 상태에서는 남은 금액만 — 리뷰 #51(중)
 */
export function detailRows(r, { revealed = false } = {}) {
  if (!r) return [];
  const rows = [
    ['신용카드', won(num(r.credit_card_amount) ?? 0)],
    ['체크카드·현금영수증', won(num(r.check_card_amount) ?? 0)],
    ['대중교통', won(num(r.public_transit_amount) ?? 0)],
    ['전통시장', won(num(r.traditional_market_amount) ?? 0)],
    ['문화체육', won(num(r.culture_amount) ?? 0)],
    ['공제 제외(공과금·통신 등)', won(num(r.excluded_amount) ?? 0)],
  ];
  if (r.total_salary_amount != null) {
    rows.push(
      revealed ? ['최저사용금액(총급여 25%)', won(num(r.minimum_spend_amount))] : ['최저사용금액까지 남은 금액', won(num(r.remaining_to_minimum_amount) ?? 0)],
      ['예상 카드 소득공제', won(num(r.card_deduction_amount))],
      ['기본 한도 · 남음', `${won(num(r.base_limit_amount))} · ${won(num(r.base_remaining_amount))}`],
      ['추가 한도 · 남음', `${won(num(r.extra_limit_amount))} · ${won(num(r.extra_remaining_amount))}`],
    );
  }
  return rows;
}

/** 출처 줄: 기준값이 있으면 '○월 ○일까지 국세청 값(넣은 항목) + 그 뒤 가계부' */
export function sourceLine(r) {
  if (!r?.baseline_as_of_on) return '모두 가계부 기준 추정이에요.';
  const d = String(r.baseline_as_of_on);
  return `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일까지 국세청 값(넣은 항목) + 그 뒤 가계부 추정이에요.`;
}

/**
 * 최저사용금액 막대의 글·읽어 주기 글. 최저사용금액 금액은 '보기'일 때만(가림 상태: 비율·사용액·남은 금액)
 * @returns {{ text, aria }}
 */
export function minimumBarView(r, revealed = false) {
  const pctUsed = Math.round(minimumRatio(r) * 100);
  const used = won(num(r?.total_spend_amount) ?? 0);
  if (revealed) {
    const min = won(num(r?.minimum_spend_amount) ?? 0);
    return { text: `최저사용금액 ${min} · 사용 ${used}`, aria: `최저사용금액 ${min} 중 ${used} 사용(${pctUsed}%)` };
  }
  // 가림 상태: 만 원 단위 한 숫자만(사용액 원 단위는 빼기 — 총괄 10-30, '언뜻 보기 방지' 수준)
  const left = manWon(num(r?.remaining_to_minimum_amount) ?? 0);
  return { text: `최저까지 ${left} 남음(${pctUsed}%)`, aria: `최저사용금액의 ${pctUsed}% 사용, ${left} 남음` };
}

/** 최저사용금액 막대 비율(0~1) */
export function minimumRatio(r) {
  const m = num(r?.minimum_spend_amount);
  if (!m) return 0;
  return Math.max(0, Math.min(1, (num(r.total_spend_amount) ?? 0) / m));
}

// ---------------------------------------------------------------- 홈 '지금 누구 카드가 유리' (사용자 결정 10-30)

/** 사람별 '공제 시작까지' 이유 한 줄(최저 전인 사람만, 총급여 없는 사람은 그 말) */
function startReason(people) {
  const parts = people.map((p) => {
    if (!p.hasSalary) return `${p.name} 총급여 없음`;
    if (p.remaining > 0) return `${p.name}${josa(p.name, '은', '는')} 공제 시작까지 ${manWon(p.remaining)} 남음`;
    return null;
  }).filter(Boolean);
  return parts.length ? parts.join(' · ') : '두 사람 모두 공제가 시작됐어요(최저사용금액 넘음)';
}

/**
 * 홈 카드 줄: 공제 항목별(일반 지출·대중교통·의료비·월세) "누구의 무엇이 유리" + 짧은 이유
 * 총급여가 둘 다 없으면 needSalary(입력 화면 링크를 보여 줌)
 * @returns {{ needSalary: boolean, rows: { key, label, text, reason }[] }}
 */
export function homeAdvice(people) {
  if (!people.some((p) => p.hasSalary)) return { needSalary: true, rows: [] };
  const rows = [];
  for (const [key, label] of [['general', '일반 지출'], ['transit', '대중교통']]) {
    const b = bestChoice(people, key);
    rows.push({ key, label, text: b.none ? '지금은 누구 카드든 0%' : `${b.who} ${b.mediumText} ${rateText(b.rate)}`, reason: startReason(people) });
  }
  const med = people.filter((p) => p.row).map((p) => {
    if (!p.hasSalary) return `${p.name} 총급여 없음`;
    const left = num(p.row.medical_remaining_to_threshold_amount);
    return left > 0 ? `${p.name} 문턱까지 ${manWon(left)}` : `${p.name} 문턱 넘음`;
  });
  rows.push({ key: 'medical', label: '의료비', text: '진료받는 사람 본인 카드', reason: `본인 의료비 세액공제 + 카드 공제 · ${med.join(' · ')}` });
  const eligible = people.filter((p) => p.row?.is_rent_eligible);
  rows.push(eligible.length
    ? {
      key: 'rent', label: '월세', text: `${eligible.map((p) => p.name).join('·')} 명의 통장`,
      reason: eligible.map((p) => (p.hasSalary ? `${p.name} 예상 세액공제 ${won(num(p.row.rent_credit_amount) ?? 0)}` : `${p.name} 총급여 없음`)).join(' · '),
    }
    : { key: 'rent', label: '월세', text: '월세 공제 요건을 켠 사람이 없어요', reason: '연말정산 설정에서 켤 수 있어요' });
  return { needSalary: false, rows };
}

// ---------------------------------------------------------------- 설정 입력 검사 (E2)

const RE_INT = /^[0-9]+$/;
const digits = (s) => String(s ?? '').normalize('NFKC').replace(/[,\s]/g, '');

/**
 * 본인 설정 → member_tax_profiles 행
 * @param form { salaryMan: '4200'(만 원, 빈 칸 = 모름), childCount, rentEligible, reimbursed(원) }
 * @returns {{ ok: true, row } | { ok: false, field, message }}
 */
export function checkProfile(form, memberId, taxYear) {
  const bad = (field, message) => ({ ok: false, field, message });
  const s = digits(form.salaryMan);
  if (s && (!RE_INT.test(s) || s.length > 5)) return bad('salary', '총급여는 만 원 단위 숫자로 넣어 주세요(최대 99,999만 원)');
  const c = digits(form.childCount || '0');
  if (!RE_INT.test(c) || Number(c) > 20) return bad('child', '자녀 등 수는 0~20이에요');
  const m = digits(form.reimbursed || '0');
  if (!RE_INT.test(m) || m.length > 10) return bad('reimbursed', '실손보험금은 원 단위 숫자로 넣어 주세요');
  return {
    ok: true,
    row: {
      member_id: memberId, tax_year: taxYear,
      total_salary_amount: s ? Number(s) * MAN : null,
      child_count: Number(c), is_rent_eligible: Boolean(form.rentEligible), medical_reimbursed_amount: Number(m),
    },
  };
}

/**
 * 국세청 기준값 → deduction_baselines 6행 (재리뷰 P-6: 한 기준일에 6개 항목을 모두 — 빈 칸 없음)
 * @param form { asOf: 'YYYY-MM-DD', amounts: { credit_card: '…', … } }
 */
export function checkBaselines(form, memberId, taxYear, today) {
  const bad = (field, message) => ({ ok: false, field, message });
  const d = String(form.asOf ?? '');
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(d)) return bad('asOf', '기준일을 골라 주세요');
  if (Number(d.slice(0, 4)) !== taxYear) return bad('asOf', `기준일은 ${taxYear}년 안이어야 해요`);
  if (today && d > today) return bad('asOf', '기준일은 오늘까지만 돼요');
  const rows = [];
  for (const [kind, label] of BASELINE_KINDS) {
    const v = digits(form.amounts?.[kind]);
    if (!v) return bad(kind, `${label} 칸이 비었어요. 국세청 값 그대로 6칸을 모두 넣어 주세요(없으면 0)`);
    if (!RE_INT.test(v) || v.length > 10) return bad(kind, `${label}은 원 단위 숫자로 넣어 주세요`);
    rows.push({ member_id: memberId, tax_year: taxYear, as_of_on: d, deduction_kind: kind, amount: Number(v) });
  }
  return { ok: true, rows };
}

/** 기준값 행들 → 기준일별 묶음(늦은 날부터) { asOf, values: Map(kind → amount) } */
export function baselineGroups(rows) {
  const by = new Map();
  for (const r of rows ?? []) {
    const k = String(r.as_of_on);
    if (!by.has(k)) by.set(k, new Map());
    by.get(k).set(r.deduction_kind, num(r.amount));
  }
  return [...by].sort((a, b) => b[0].localeCompare(a[0])).map(([asOf, values]) => ({ asOf, values, complete: values.size === BASELINE_KINDS.length }));
}

/** 가림 안내(총괄 10-30: 가림은 '언뜻 보기 방지' 수준 — D3 두 사람 조회와 같은 취지) */
export const MASK_NOTE = '총급여는 가려 두었어요. 다른 숫자로 짐작할 수 있어요(두 사람 모두 볼 수 있는 정보).';

/** 총급여 가림 글: '●●●●만 원' / 없으면 '넣지 않음' */
export function maskedSalary(amount) {
  return amount == null ? '넣지 않음' : '●●●●만 원';
}
