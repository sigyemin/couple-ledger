// =====================================================================
// 리포트 — 화면 없이 계산하는 부분 (화면 설계 v0.2 3-2 시안 11, 3-3 시안 12, 3-4 시안 13, 5장 차트 규칙)
// - 지출: v_monthly_summary(합계·6개월) + v_monthly_category(그룹·항목) → 합계 = 홈의 그 달 지출
// - 항목 거래: v_monthly_category_txn(거래별 그 카테고리 몫) + v_transaction_detail(표시) → 합계 = 리포트 숫자
// - 수입: v_monthly_summary.income_amount + v_monthly_income(카테고리별만, 결정 C6) — v0.17 S2로 합이 맞다
// - 행이 없는 달은 0. 지난달 요약 행이 없으면 비교하지 않는다(홈과 같게)
// - 늘어남 = 주황 "+", 줄어듦 = 파랑 "−", 같음 = 회색 (빨강·초록 안 씀)
// 의존: core/format.js, router.js(addMonths, buildHash), screens/home-model.js(compareText)
// =====================================================================
import { won } from '../core/format.js';
import { addMonths, buildHash } from '../router.js';
import { compareText } from './home-model.js';

export { compareText };
// 기본 달 = 지난달(서울 기준, 1월이면 전년 12월) — 정산·월 검토와 같은 함수 (사용자 결정 10-30)
export { defaultSettleMonth as defaultReportMonth } from './settle-model.js';

const num = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const ym = (m) => m.slice(0, 7);
const monthNo = (m) => `${Number(m.slice(5, 7))}월`;
const NONE = 'none';
const MAN = 10000;
const BIG = 100 * MAN; // 100만 이상은 정수 만, 아래는 소수 한 자리

/** 차트 글자용 축약: 1,325,400 → '133만', 298,000 → '29.8만', 4,500 → '0.5만', 0 → '0' */
export function shortWon(n) {
  const v = num(n);
  if (v === 0) return '0';
  const a = Math.abs(v);
  const body = a >= BIG ? `${Math.round(a / MAN)}만` : `${Math.round(a / (MAN / 10)) / 10}만`;
  return v < 0 ? `−${body}` : body;
}

/** 고른 달 포함 최근 6개월(오래된 달부터) */
export function sixMonths(monthStart) {
  return [-5, -4, -3, -2, -1, 0].map((n) => addMonths(monthStart, n));
}

/** 달별 값 → 6개월 계열(없는 달 0) */
export function series(months, valueOf) {
  return months.map((m) => ({ month: m, value: num(valueOf(m)) }));
}

/** 차이 표시: { text, tone: up|down|same|none } */
export function diffView(d, hasPrev = true) {
  if (!hasPrev) return { text: '', tone: 'none' };
  if (d === 0) return { text: '같음', tone: 'same' };
  return d > 0 ? { text: `+${won(d)}`, tone: 'up' } : { text: won(d), tone: 'down' };
}

// 6개월 막대 차트 크기(시안 11: viewBox 330×150, 바닥선 120)
export const CHART = Object.freeze({ width: 330, height: 150, base: 120, top: 18, x0: 15, step: 53, barW: 32 });

/**
 * 6개월 막대 → 그릴 값. 음수 달은 높이 0(글자는 그대로)
 * @returns {{ bars: {x, y, h, valueText, monthText, on}[], aria }}
 */
export function barChart(points, selected, title) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const room = CHART.base - CHART.top;
  const bars = points.map((p, i) => {
    const hgt = p.value > 0 ? Math.max(2, Math.round((p.value / max) * room)) : 0;
    return {
      x: CHART.x0 + i * CHART.step, y: CHART.base - hgt, h: hgt,
      valueText: shortWon(p.value), monthText: monthNo(p.month), on: p.month === selected,
    };
  });
  const aria = `${title} 최근 6개월: ${points.map((p) => `${monthNo(p.month)} ${won(p.value)}`).join(', ')}`;
  return { bars, aria };
}

// 차이 막대(시안 11: 폭 120, 가운데 60 기준 양쪽)
export const DIFF_BAR = Object.freeze({ width: 120, half: 58 });

function diffBar(d, maxAbs) {
  if (!maxAbs || d === 0) return { x: DIFF_BAR.width / 2 - 1, w: 2, tone: 'same' };
  const w = Math.max(2, Math.round((Math.abs(d) / maxAbs) * DIFF_BAR.half));
  return d > 0 ? { x: DIFF_BAR.width / 2, w, tone: 'up' } : { x: DIFF_BAR.width / 2 - w, w, tone: 'down' };
}

function sumBy(rows, keyOf) {
  const out = new Map();
  for (const r of rows ?? []) {
    const k = keyOf(r);
    out.set(k, (out.get(k) ?? 0) + num(r.total_amount));
  }
  return out;
}

/** 이름 찾기: categories 행 → Map(id → { name, parentId, isActive }) */
export function categoryMap(categories) {
  return new Map((categories ?? []).map((c) => [c.id, { name: c.name, parentId: c.parent_id ?? null, isActive: c.is_active !== false }]));
}

/**
 * 지난달과 비교(그룹별). 이번 달 금액 큰 순, 미분류는 맨 끝, 두 달 다 0이면 숨김
 * @param cur/prev v_monthly_category 행(그 달/지난달)
 */
export function compareGroups(cur, prev, cats, monthStart, { hasPrev = true } = {}) {
  const a = sumBy(cur, (r) => r.group_category_id ?? NONE);
  const b = sumBy(prev, (r) => r.group_category_id ?? NONE);
  const keys = [...new Set([...a.keys(), ...b.keys()])].filter((k) => (a.get(k) ?? 0) !== 0 || (b.get(k) ?? 0) !== 0);
  const rows = keys.map((k) => {
    const amount = a.get(k) ?? 0;
    const d = amount - (b.get(k) ?? 0);
    const isNone = k === NONE;
    return {
      id: isNone ? null : k,
      name: isNone ? '미분류' : (cats.get(k)?.name ?? '이름 없음'),
      off: !isNone && cats.get(k)?.isActive === false,
      amount, amountText: won(amount), d,
      href: isNone
        ? buildHash('list', { query: { month: ym(monthStart), cat: 'none' } })
        : buildHash('rgroup', { id: k, query: { month: ym(monthStart) } }),
    };
  });
  rows.sort((x, y) => (x.id === null) - (y.id === null) || y.amount - x.amount || x.name.localeCompare(y.name));
  const maxAbs = hasPrev ? Math.max(0, ...rows.map((r) => Math.abs(r.d))) : 0;
  return rows.map((r) => ({ ...r, diff: diffView(r.d, hasPrev), bar: hasPrev ? diffBar(r.d, maxAbs) : null }));
}

/**
 * 그룹 펼치기(시안 12)
 * @param rows v_monthly_category 행(그 그룹, 6개월)
 * @param totalExpense 그 달 전체 지출(v_monthly_summary.expense_amount)
 */
export function groupView(rows, groupId, monthStart, cats, { totalExpense = 0, hasPrev = true } = {}) {
  const prevMonth = addMonths(monthStart, -1);
  const byMonth = sumBy(rows, (r) => r.period_month);
  const cur = byMonth.get(monthStart) ?? 0;
  const prev = byMonth.get(prevMonth) ?? 0;
  const groupName = cats.get(groupId)?.name ?? '이름 없음';
  const a = sumBy(rows.filter((r) => r.period_month === monthStart), (r) => r.category_id);
  const b = sumBy(rows.filter((r) => r.period_month === prevMonth), (r) => r.category_id);
  const keys = [...new Set([...a.keys(), ...b.keys()])].filter((k) => k && ((a.get(k) ?? 0) !== 0 || (b.get(k) ?? 0) !== 0));
  const items = keys.map((k) => {
    const amount = a.get(k) ?? 0;
    const ratio = cur > 0 && amount > 0 ? amount / cur : 0;
    return {
      id: k,
      name: k === groupId ? `${groupName}(그룹 전체)` : (cats.get(k)?.name ?? '이름 없음'),
      off: cats.get(k)?.isActive === false,
      amount, amountText: won(amount), ratio, pctText: `${Math.round(ratio * 100)}%`,
      diff: diffView(amount - (b.get(k) ?? 0), hasPrev),
      href: buildHash('ritem', { id: k, query: { month: ym(monthStart) } }),
    };
  }).sort((x, y) => y.amount - x.amount || x.name.localeCompare(y.name));
  const total = num(totalExpense);
  const parts = [];
  const cmp = hasPrev ? compareText(cur, prev) : null;
  if (cmp) parts.push(cmp);
  if (total > 0 && cur > 0) parts.push(`전체 지출의 ${Math.round((cur / total) * 100)}%`);
  return {
    name: groupName, off: cats.get(groupId)?.isActive === false,
    amount: cur, amountText: won(cur), sub: parts.join(' · '),
    points: series(sixMonths(monthStart), (m) => byMonth.get(m) ?? 0),
    items,
  };
}

const lineList = (row) => (Array.isArray(row?.lines) ? row.lines : []);

/**
 * 항목 거래(시안 13). 금액은 그 카테고리 몫(v_monthly_category_txn.signed_amount)
 * @param shares v_monthly_category_txn 행(그 달·그 카테고리) { txn_id, signed_amount }
 * @param detailRows v_transaction_detail 행(그 귀속월) — 연결 환불 찾기에도 쓴다
 * @returns {{ total, totalText, count, missing, rows: [{ row, view }] }}
 */
export function itemTxns(shares, detailRows, catId, cats, slotOf) {
  const byId = new Map((detailRows ?? []).map((r) => [r.id, r]));
  const name = cats.get(catId)?.name ?? '이름 없음';
  const refundsOf = new Map();
  for (const r of detailRows ?? []) {
    if (r.kind === 'refund' && r.refund_of_txn_id && !r.is_excluded) {
      refundsOf.set(r.refund_of_txn_id, (refundsOf.get(r.refund_of_txn_id) ?? 0) + num(r.amount));
    }
  }
  let total = 0;
  let missing = 0;
  const rows = [];
  for (const sh of shares ?? []) {
    const amt = num(sh.signed_amount);
    total += amt;
    const r = byId.get(sh.txn_id);
    if (!r) { missing += 1; continue; }
    const tags = [];
    let sub;
    if (r.kind === 'refund') {
      tags.push('환불');
      sub = lineList(r).length === 0 ? `${name}(원거래) · ${r.source_label}` : `${name} · ${r.source_label}`;
    } else if (Math.abs(amt) !== num(r.amount)) {
      tags.push('나눈 거래');
      sub = `${name} 몫 · 거래 전체 ${won(num(r.amount))}`;
    } else {
      sub = `${name} · ${r.source_label}`;
    }
    const refunded = refundsOf.get(r.id);
    if (r.kind !== 'refund' && refunded) sub += ` · 환불 ${won(refunded)} 있음`;
    const slot = slotOf.get(r.payer_member_id);
    rows.push({
      row: r,
      view: {
        id: r.id, merchant: r.merchant_raw, sub, tags, amountText: won(amt), tone: amt < 0 ? 'refund' : 'expense',
        payer: { initial: String(r.payer_name ?? '').slice(0, 1), name: r.payer_name ?? '', slot: slot === 1 || slot === 2 ? slot : 0 },
      },
    });
  }
  return { name, total, totalText: won(total), count: (shares ?? []).length, missing, rows };
}

/** 수입 비교 문구 */
export function incomeCompareText(cur, prev) {
  if (prev == null) return null;
  const d = cur - prev;
  if (d === 0) return '지난달과 같아요';
  return `지난달보다 ${won(Math.abs(d))} ${d > 0 ? '더' : '덜'} 들어왔어요`;
}

/**
 * 수입 칸: 카테고리별(미분류 맨 끝). 구성원별 줄은 두지 않는다(결정 C6)
 * @param cur/prev v_monthly_income 행(그 달/지난달) — 구성원 칸은 카테고리로 합친다
 */
export function incomeView(cur, prev, cats, { hasPrev = true } = {}) {
  const a = sumBy(cur, (r) => r.category_id ?? NONE);
  const b = sumBy(prev, (r) => r.category_id ?? NONE);
  const keys = [...new Set([...a.keys(), ...b.keys()])].filter((k) => (a.get(k) ?? 0) !== 0 || (b.get(k) ?? 0) !== 0);
  const byCategory = keys.map((k) => {
    const amount = a.get(k) ?? 0;
    const isNone = k === NONE;
    return {
      id: isNone ? null : k,
      name: isNone ? '미분류' : (cats.get(k)?.name ?? '이름 없음'),
      off: !isNone && cats.get(k)?.isActive === false,
      amount, amountText: won(amount), diff: diffView(amount - (b.get(k) ?? 0), hasPrev),
    };
  }).sort((x, y) => (x.id === null) - (y.id === null) || y.amount - x.amount || x.name.localeCompare(y.name));
  return { byCategory };
}
