// =====================================================================
// 정산 탭 › 공제 현황 카드 (CL-062 E1·E5·E6·E7, 시안 current/2026-10-30-화면시안-연말정산)
// 조회: v_deduction_status(그 연도, 두 사람), v_deduction_txn(최근 3개월 — '언제 넘는지' 월평균, 쪽 단위), members
// - "지금 가장 유리: ○ ○카드(공제율 ○%)" 한 줄 + 사람 × 결제수단 한계 공제율 표, 지출 종류 칩(일반·대중교통·의료비·월세)
// - 접힌 사람별 상세(최저사용금액 막대·항목별 사용액·예상 공제·한도·세액공제, 출처)
// - 총급여는 기본 가림(●●●●만 원), 눌러야 보임. 값은 기록·주소·콘솔에 남기지 않는다
// - 조회가 실패해도 정산 탭은 그대로(이 카드만 오류 줄)
// 의존: ui/dom.js, router.js, core/format.js, screens/deduction-model.js
// =====================================================================
import { h, widthClass } from '../ui/dom.js';
import { addMonths, buildHash } from '../router.js';
import { won } from '../core/format.js';
import {
  CHIPS, RATE_ROWS, peopleView, bestChoice, rateText, rateSub, monthlyCardAverage, minimumLine, medicalLines, rentLines,
  detailRows, sourceLine, minimumRatio, minimumBarView, maskedSalary,
} from './deduction-model.js';

const PAGE_SIZE = 1000;
const MAX_ROWS = 5000;
const STATUS_COLUMNS = [
  'tax_year', 'member_id', 'total_salary_amount', 'child_count', 'baseline_as_of_on',
  'credit_card_amount', 'check_card_amount', 'culture_amount', 'traditional_market_amount', 'public_transit_amount', 'excluded_amount',
  'minimum_spend_amount', 'total_spend_amount', 'remaining_to_minimum_amount', 'deduction_before_limit_amount',
  'base_limit_amount', 'base_remaining_amount', 'extra_limit_amount', 'extra_remaining_amount', 'card_deduction_amount',
  'marginal_credit_rate', 'marginal_check_rate', 'marginal_culture_rate', 'marginal_traditional_market_rate', 'marginal_public_transit_rate',
  'medical_amount', 'medical_other_amount', 'medical_threshold_amount', 'medical_remaining_to_threshold_amount', 'medical_credit_amount',
  'rent_amount', 'is_rent_eligible', 'rent_credit_amount',
].join(',');

/** 최근 3개월(그 연도 안, 고른 달 포함) */
export function recentMonths(monthStart) {
  return [-2, -1, 0].map((n) => addMonths(monthStart, n)).filter((m) => m.slice(0, 4) === monthStart.slice(0, 4));
}

/** v_deduction_txn 최근 달들을 쪽 단위로 */
export async function readRecentTxns(db, taxYear, months, { max = MAX_ROWS } = {}) {
  const rows = [];
  let offset = 0;
  const from = months[0];
  const to = addMonths(months[months.length - 1], 1);
  while (rows.length <= max) {
    const r = await db.select('v_deduction_txn', {
      columns: 'txn_id,member_id,deduction_kind,signed_amount,occurred_on',
      filters: [{ col: 'tax_year', op: 'eq', value: taxYear }, { col: 'occurred_on', op: 'gte', value: from }, { col: 'occurred_on', op: 'lt', value: to }],
      order: [{ col: 'txn_id', ascending: true }, { col: 'deduction_kind', ascending: true }],
      range: { from: offset, to: offset + PAGE_SIZE - 1 },
    });
    if (r.error) return { error: r.error };
    const page = r.data ?? [];
    if (!page.length) break;
    offset += page.length;
    rows.push(...page);
  }
  // 상한에서 멈추면 월평균이 작게 나와 '약 N개월'이 길어진다 → capped로 알림(리뷰 #51 참고 1)
  return { data: { rows: rows.slice(0, max), capped: rows.length > max } };
}

export async function loadDeduction(db, monthStart) {
  const taxYear = Number(monthStart.slice(0, 4));
  const months = recentMonths(monthStart);
  const [status, txns, members] = await Promise.all([
    db.select('v_deduction_status', { columns: STATUS_COLUMNS, filters: [{ col: 'tax_year', op: 'eq', value: taxYear }] }),
    readRecentTxns(db, taxYear, months),
    db.select('members', { columns: 'id,member_slot,display_name' }),
  ]);
  const error = [status, txns, members].find((r) => r.error)?.error;
  if (error) return { error };
  return { data: { taxYear, months, status: status.data ?? [], txns: txns.data.rows, capped: txns.data.capped, members: members.data ?? [] } };
}

/**
 * @param {{ db, monthStart, onError }} ctx
 * @returns {Promise<HTMLElement>}
 */
export async function renderDeductionCard({ db, monthStart, onError }, doc = globalThis.document) {
  const res = await loadDeduction(db, monthStart);
  const taxYear = Number(monthStart.slice(0, 4));
  const title = h('h2', { class: 'card-title', text: `공제 현황 · ${taxYear}` }, [], doc);
  const tag = h('p', { class: 'muted small', text: '가계부 기준 추정 — 최종은 홈택스 간소화 자료' }, [], doc);
  const settings = h('a', { class: 'row-link soft', attrs: { href: buildHash('taxset') } }, [
    h('span', { text: '연말정산 설정(총급여·자녀 수·월세 요건·국세청 기준값)' }, [], doc), h('strong', { text: '›' }, [], doc),
  ], doc);
  if (res.error) {
    onError?.(res.error);
    return h('section', { class: 'card ded' }, [title, tag, h('p', { class: 'notice small', attrs: { role: 'alert' }, text: '공제 현황을 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.' }, [], doc), settings], doc);
  }
  if (!res.data.status.length) {
    return h('section', { class: 'card ded' }, [title, h('p', { class: 'muted', text: `${taxYear}년 공제 규칙이 아직 없어요.` }, [], doc)], doc);
  }
  const people = peopleView(res.data.status, res.data.members);
  const average = monthlyCardAverage(res.data.txns, res.data.months);

  const best = h('div', { class: 'ded-best', attrs: { 'aria-live': 'polite' } }, [], doc);
  const body = h('div', { class: 'ded-body' }, [], doc);
  let chip = 'general';
  const chipNav = h('div', { class: 'chips', attrs: { role: 'radiogroup', 'aria-label': '지출 종류' } }, [], doc);
  const drawChips = () => chipNav.replaceChildren(...CHIPS.map(([k, label]) => h('button', {
    class: k === chip ? 'chip on' : 'chip', text: label,
    attrs: { type: 'button', role: 'radio', 'aria-checked': k === chip ? 'true' : 'false' },
    on: { click: () => { chip = k; draw(); } },
  }, [], doc)));

  const rateTable = (keys) => h('table', { class: 'settle-table ded-rates' }, [
    h('caption', { class: 'sr-only', text: '1원 더 쓰면 공제되는 비율(사람 × 결제수단)' }, [], doc),
    h('thead', {}, [h('tr', {}, [
      h('th', { text: '1원 더 쓰면 공제', attrs: { scope: 'col' } }, [], doc),
      ...people.map((p) => h('th', { text: p.name, attrs: { scope: 'col' } }, [], doc)),
    ], doc)], doc),
    h('tbody', {}, RATE_ROWS.filter(([k]) => keys.includes(k)).map(([k, label]) => h('tr', {}, [
      h('th', { text: label, attrs: { scope: 'row' } }, [], doc),
      ...people.map((p) => {
        const sub = rateSub(p, k);
        return h('td', { class: (p.rates[k] ?? 0) > 0 ? 'on' : 'zero' }, [
          h('span', { class: 'ded-rate', text: rateText(p.hasSalary ? (p.rates[k] ?? 0) : null) }, [], doc),
          sub ? h('span', { class: 'sub', text: sub }, [], doc) : null,
        ], doc);
      }),
    ], doc)), doc),
  ], doc);

  const put = (el, ...kids) => el.replaceChildren(...kids.filter(Boolean));
  function draw() {
    drawChips();
    if (chip === 'general' || chip === 'transit') {
      const b = bestChoice(people, chip);
      best.className = b.none ? 'ded-best none' : 'ded-best';
      put(best,
        b.none ? h('p', { text: b.text }, [], doc)
          : h('p', {}, ['지금 가장 유리: ', h('strong', { text: b.text }, [], doc)], doc),
      );
      put(body,
        rateTable(chip === 'transit' ? ['transit'] : ['credit', 'check', 'transit']),
        ...people.map((p) => h('p', { class: 'muted small', text: minimumLine(p, average) }, [], doc)),
        chip === 'transit' ? h('p', { class: 'muted small', text: '대중교통은 최저사용금액을 넘은 사람의 카드면 40%(체크·신용 같음). 국세청은 카드사 가맹점 정보로 판정해 택시 등은 빠질 수 있어요.' }, [], doc) : null,
        res.data.capped ? h('p', { class: 'notice small', text: '최근 거래가 많아 일부만 더해 월평균을 냈어요(약 N개월은 실제보다 길 수 있어요).' }, [], doc) : null,
        h('p', { class: 'muted small', text: '이 %는 소득공제율이에요. 실제로 줄어드는 세금은 각자의 세율에 따라 달라요.' }, [], doc),
      );
    } else if (chip === 'medical') {
      best.className = 'ded-best none';
      put(best, h('p', { text: '의료비는 대상자 본인 명의 결제수단으로 내는 것이 유리해요(본인 의료비 세액공제 + 카드 공제).' }, [], doc));
      const lines = medicalLines(people);
      put(body,
        h('ul', { class: 'ded-lines' }, lines.map((l) => h('li', {}, [h('strong', { text: l.name }, [], doc), ` ${l.text}`], doc)), doc),
        ...lines.filter((l) => l.warn).map((l) => h('p', { class: 'notice small', text: l.warn }, [], doc)),
        h('p', { class: 'muted small', text: '의료비 세액공제 = 본인 의료비 − 실손보험금 중 총급여 3%를 넘는 부분 × 15%. 건강기능식품·미용은 빠져요(앱은 몰라요).' }, [], doc),
      );
    } else {
      best.className = 'ded-best none';
      put(best, h('p', { text: '월세는 월세 공제 요건(무주택 세대주·계약서 명의)이 맞는 사람 통장에서 내는 것이 좋아요.' }, [], doc));
      const r = rentLines(people);
      put(body,
        h('ul', { class: 'ded-lines' }, r.lines.map((l) => h('li', {}, [h('strong', { text: l.name }, [], doc), ` ${l.text}`], doc)), doc),
        r.note ? h('p', { class: 'notice small', text: r.note }, [], doc) : null,
        h('p', { class: 'muted small', text: '월세 세액공제 = 월세(연 1,000만 원까지) × 17%(총급여 5,500만 원 이하) 또는 15%. 총급여 8,000만 원 넘으면 없음.' }, [], doc),
      );
    }
  }
  draw();

  // 사람별 상세: 총급여와 총급여에서 바로 나오는 금액(최저사용금액)은 '보기'를 눌러야 보인다(가림 — 리뷰 #51 중)
  const details = people.map((p) => {
    const r = p.row;
    const box = h('div', { class: 'ded-person-body' }, [], doc);
    let shown = false;
    const draw = () => {
      const bar = p.hasSalary ? minimumBarView(r, shown) : null;
      const ratio = minimumRatio(r);
      box.replaceChildren(...[
        h('p', { class: 'muted small' }, [
          '총급여 ',
          h('span', { class: 'ded-salary', text: shown && r?.total_salary_amount != null ? `${(Number(r.total_salary_amount) / 10000).toLocaleString('ko-KR')}만 원` : maskedSalary(r?.total_salary_amount) }, [], doc),
          ' ',
          r?.total_salary_amount != null ? h('button', {
            class: 'btn mini', text: shown ? '가리기' : '보기',
            attrs: { type: 'button', 'aria-label': `${p.name} 총급여·최저사용금액 ${shown ? '가리기' : '보기'}` },
            on: { click: () => { shown = !shown; draw(); box.querySelector('button')?.focus(); } },
          }, [], doc) : null,
        ], doc),
        bar ? h('div', { class: 'ded-min' }, [
          h('span', { class: 'bar-track', attrs: { role: 'img', 'aria-label': bar.aria } }, [h('span', { class: `bar-fill ${widthClass(ratio)}` }, [], doc)], doc),
          h('p', { class: 'muted small', text: bar.text }, [], doc),
        ], doc) : h('p', { class: 'muted small', text: '총급여를 넣으면 최저사용금액·예상 공제를 계산해요.' }, [], doc),
        h('table', { class: 'settle-table' }, [h('tbody', {}, detailRows(r, { revealed: shown }).map(([k, v]) => h('tr', {}, [
          h('th', { text: k, attrs: { scope: 'row' } }, [], doc), h('td', { text: v }, [], doc),
        ], doc)), doc)], doc),
        h('p', { class: 'muted small', text: sourceLine(r) }, [], doc),
      ].filter(Boolean));
    };
    draw();
    return h('details', { class: 'card ded-person' }, [h('summary', { text: `${p.name} · 공제 현황` }, [], doc), box], doc);
  });

  return h('section', { class: 'ded-wrap' }, [
    h('section', { class: 'card ded' }, [title, tag, best, chipNav, body], doc),
    ...details,
    h('section', { class: 'card' }, [settings], doc),
  ], doc);
}
