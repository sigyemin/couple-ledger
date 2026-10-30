// =====================================================================
// 리포트 — '어디에 얼마나 썼나' 비중 차트, 화면 없이 계산하는 부분 (CL-059, 사용자 요청 10-30)
// - 지출 기준 = v_monthly_summary와 같음: 공동 + 개인, 집계 제외·휴지통·시험 결제수단 제외, 환불 차감(지출 +, 환불 −)
// - 기준(by): group 대분류 / item 세부분류 — v_monthly_category, source 결제수단 / owner 명의 — 거래(transactions)를 결제수단으로 묶음
// - 기간(span): month 그 달 / ytd 올해 1월 ~ 그 달
// - 도넛·범례: 큰 순 상위 TOP개 + '그 밖' 하나, '분류 안 됨'은 묶지 않고 따로(맨 끝). 0원 이하(환불이 더 큼) 항목은 원에 넣지 않고 따로 알린다
// 의존: core/format.js, router.js
// =====================================================================
import { won } from '../core/format.js';
import { buildHash } from '../router.js';

export const BYS = Object.freeze([['group', '대분류'], ['item', '세부분류'], ['source', '결제수단'], ['owner', '명의']]);
export const SPANS = Object.freeze([['month', '그 달'], ['ytd', '올해 누계']]);
export const TOP = 7;
const NONE = 'none';

const num = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const ym = (m) => m.slice(0, 7);

/** 주소 값 → 기준·기간(모르는 값은 기본) */
export function shareParams(query) {
  const by = query?.get?.('by');
  const span = query?.get?.('span');
  return {
    by: BYS.some(([k]) => k === by) ? by : 'group',
    span: span === 'ytd' ? 'ytd' : 'month',
  };
}

/** 기간의 첫 달·끝 달 */
export function spanRange(monthStart, span) {
  return { from: span === 'ytd' ? `${monthStart.slice(0, 4)}-01-01` : monthStart, to: monthStart };
}

/** 기간 이름: '10월' / '1~10월' */
export function spanLabel(monthStart, span) {
  const m = Number(monthStart.slice(5, 7));
  return span === 'ytd' && m > 1 ? `1~${m}월` : `${m}월`;
}

const add = (map, key, v) => map.set(key, (map.get(key) ?? 0) + v);

/**
 * 기준별 합계 → 항목 [{ key, name, amount, href, none }]
 * @param d { categoryRows: v_monthly_category, cats: Map(id → {name, parentId}), txns: [{source_id, kind, amount}], sources, members }
 */
export function shareEntries(by, d, monthStart) {
  const month = ym(monthStart);
  const sums = new Map();
  if (by === 'group' || by === 'item') {
    for (const r of d.categoryRows ?? []) add(sums, (by === 'group' ? r.group_category_id : r.category_id) ?? NONE, num(r.total_amount));
    return [...sums].map(([k, amount]) => {
      if (k === NONE) return { key: NONE, name: '분류 안 됨', amount, none: true, href: buildHash('list', { query: { month, cat: 'none' } }) };
      const c = d.cats.get(k);
      const parent = c?.parentId ? d.cats.get(c.parentId)?.name : null;
      return {
        key: k,
        name: by === 'item' && parent ? `${parent} › ${c?.name ?? '이름 없음'}` : (c?.name ?? '이름 없음'),
        amount, none: false,
        href: buildHash(by === 'group' ? 'rgroup' : 'ritem', { id: k, query: { month } }),
      };
    });
  }
  const src = new Map((d.sources ?? []).map((s) => [s.id, s]));
  const slot = new Map((d.members ?? []).map((m) => [m.id, m]));
  for (const t of d.txns ?? []) {
    const s = src.get(t.source_id);
    if (!s || s.is_test) continue;
    const v = t.kind === 'refund' ? -num(t.amount) : (t.kind === 'expense' ? num(t.amount) : 0);
    add(sums, by === 'source' ? s.id : s.owner_member_id, v);
  }
  return [...sums].map(([k, amount]) => {
    if (by === 'source') {
      return { key: k, name: src.get(k)?.label ?? '이름 없음', amount, none: false, href: buildHash('list', { query: { month, src: k } }) };
    }
    const m = slot.get(k);
    const payer = m?.member_slot === 1 || m?.member_slot === 2 ? String(m.member_slot) : null;
    return { key: k, name: m?.display_name ?? '이름 없음', amount, none: false, href: payer ? buildHash('list', { query: { month, payer } }) : null };
  });
}

/**
 * 비중 조각: 큰 순 상위 top개 + '그 밖'(나머지 합), '분류 안 됨'은 따로 맨 끝
 * @returns {{ total, totalText, slices: { key, name, amount, amountText, ratio, pctText, tone, href, members? }[], negatives: { count, amount } }}
 *   tone: 'c0'~'c6'(색 순서) | 'etc' | 'none'. members: '그 밖'에 묶인 이름들
 */
export function shareSlices(entries, { top = TOP } = {}) {
  const pos = (entries ?? []).filter((e) => e.amount > 0);
  const neg = (entries ?? []).filter((e) => e.amount < 0);
  const none = pos.find((e) => e.none) ?? null;
  const rest = pos.filter((e) => !e.none).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  // 묶을 게 한 개뿐이면 그대로 보여 준다(그 밖 1개 = 이름만 가림)
  const cut = rest.length > top + 1 ? top : rest.length;
  const shown = rest.slice(0, cut);
  const etc = rest.slice(cut);
  const total = pos.reduce((s, e) => s + e.amount, 0);
  const view = (e, tone) => {
    const ratio = total > 0 ? e.amount / total : 0;
    return { ...e, amountText: won(e.amount), ratio, pctText: pctText(ratio), tone };
  };
  const slices = shown.map((e, i) => view(e, `c${i}`));
  if (etc.length) {
    slices.push({
      ...view({ key: 'etc', name: `그 밖 ${etc.length}개`, amount: etc.reduce((s, e) => s + e.amount, 0), href: null }, 'etc'),
      members: etc.map((e) => e.name),
    });
  }
  if (none) slices.push(view(none, 'none'));
  return {
    total, totalText: won(total), slices,
    negatives: { count: neg.length, amount: neg.reduce((s, e) => s + e.amount, 0) },
  };
}

/** 비율 글자: 0.5% 미만은 '1% 미만', 그 밖은 반올림 정수 % */
export function pctText(ratio) {
  if (ratio <= 0) return '0%';
  if (ratio < 0.005) return '1% 미만';
  return `${Math.round(ratio * 100)}%`;
}

// 도넛(원 둘레를 stroke-dasharray로 나눔). 반지름 r의 둘레 = 2πr
export const DONUT = Object.freeze({ size: 160, r: 60, stroke: 26 });

/**
 * 조각 → 원 위 위치(12시 방향부터 시계 방향). 각 조각 { dash, gap, offset } (둘레 단위)
 * 조각 사이 1 단위 틈(두 조각 이상일 때)
 */
export function donutArcs(slices) {
  const c = 2 * Math.PI * DONUT.r;
  const gap = slices.length > 1 ? 1 : 0;
  let start = 0;
  return slices.map((sl) => {
    const len = sl.ratio * c;
    const arc = { tone: sl.tone, dash: Math.max(0, len - gap), rest: c - Math.max(0, len - gap), offset: -start };
    start += len;
    return arc;
  });
}

/** 차트 읽어 주기 글: '대분류별 10월 지출 1,234,000원: 식비 45% 555,000원, …' */
export function shareAria(byLabel, spanText, s) {
  if (!s.slices.length) return `${byLabel}별 ${spanText} 지출 없음`;
  return `${byLabel}별 ${spanText} 지출 ${s.totalText}: ${s.slices.map((x) => `${x.name} ${x.pctText} ${x.amountText}`).join(', ')}`;
}
