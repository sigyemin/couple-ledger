// =====================================================================
// 홈 › '지금 누구 카드가 유리' 카드 (CL-062, 사용자 결정 10-30 — '많이 쓴 곳' 대신)
// 조회: v_deduction_status(올해, 두 사람), members
// - 공제 항목별 줄(일반 지출·대중교통·의료비·월세): "○○ 체크카드 30%" + 짧은 이유. 숫자는 '가계부 기준 추정'
// - 총급여가 둘 다 없으면 '총급여를 넣으면 알려 줘요' + 연말정산 설정 링크. 상세는 정산 탭(공제 현황)
// - 조회가 실패해도 홈은 그대로(이 카드만 안내 줄). 총급여 값은 보여 주지 않는다
// 의존: ui/dom.js, router.js, screens/deduction-model.js
// =====================================================================
import { h } from '../ui/dom.js';
import { buildHash } from '../router.js';
import { peopleView, homeAdvice } from './deduction-model.js';

const COLUMNS = 'tax_year,member_id,total_salary_amount,remaining_to_minimum_amount,total_spend_amount,minimum_spend_amount,'
  + 'marginal_credit_rate,marginal_check_rate,marginal_public_transit_rate,medical_remaining_to_threshold_amount,is_rent_eligible,rent_credit_amount';

export async function loadHomeDeduction(db, taxYear) {
  const [status, members] = await Promise.all([
    db.select('v_deduction_status', { columns: COLUMNS, filters: [{ col: 'tax_year', op: 'eq', value: taxYear }] }),
    db.select('members', { columns: 'id,member_slot,display_name' }),
  ]);
  const error = status.error ?? members.error;
  if (error) return { error };
  return { data: { status: status.data ?? [], members: members.data ?? [] } };
}

/**
 * @param {{ db, taxYear, onError }} ctx
 * @returns {Promise<HTMLElement>}
 */
export async function renderHomeDeduction({ db, taxYear, onError }, doc = globalThis.document) {
  const res = await loadHomeDeduction(db, taxYear).catch((err) => ({ error: err }));
  const title = h('h2', { class: 'card-title', text: '지금 누구 카드가 유리' }, [], doc);
  const tag = h('p', { class: 'muted small', text: `${taxYear} 연말정산 · 가계부 기준 추정` }, [], doc);
  const more = h('a', { class: 'row-link soft', attrs: { href: buildHash('settle') } }, [
    h('span', { text: '공제 현황 자세히' }, [], doc), h('strong', { text: '›' }, [], doc),
  ], doc);
  if (res.error) {
    onError?.(res.error);
    return h('section', { class: 'card home-ded' }, [title, h('p', { class: 'muted', text: '공제 정보를 불러오지 못했어요.' }, [], doc)], doc);
  }
  if (!res.data.status.length) {
    return h('section', { class: 'card home-ded' }, [title, h('p', { class: 'muted', text: `${taxYear}년 공제 규칙이 아직 없어요.` }, [], doc)], doc);
  }
  const a = homeAdvice(peopleView(res.data.status, res.data.members));
  if (a.needSalary) {
    return h('section', { class: 'card home-ded' }, [
      title, tag,
      h('a', { class: 'row-link soft', attrs: { href: buildHash('taxset') } }, [
        h('span', { text: '총급여를 넣으면 알려 줘요' }, [], doc), h('strong', { text: '연말정산 설정 ›' }, [], doc),
      ], doc),
    ], doc);
  }
  return h('section', { class: 'card home-ded' }, [
    title, tag,
    h('ul', { class: 'ded-advice' }, a.rows.map((r) => h('li', {}, [
      h('span', { class: 'ded-advice-label', text: r.label }, [], doc),
      h('span', { class: 'ded-advice-body' }, [
        h('strong', { text: r.text }, [], doc),
        h('span', { class: 'sub', text: r.reason }, [], doc),
      ], doc),
    ], doc)), doc),
    more,
  ], doc);
}
