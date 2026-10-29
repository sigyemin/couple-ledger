// =====================================================================
// 화면 5 내역 — 화면 없이 계산하는 부분 (화면 설계 v0.1 4-3, v0.2 2-1 연결 환불 표시)
// - 필터는 해시 쿼리에서 읽는다(뒤로 가기·새로고침에도 남음). 모르는 값은 버린다
// - 한 달 거래를 (쪽 단위로) 모두 읽어 와서 앱이 거른다(가맹점·메모 검색을 한 번에 하려고. 한 달 수백 건 [추정])
// - 집계 제외 거래는 기본으로 숨기고 회색으로만 보인다(제외 포함·검토 대기·환불 필터 때 보임 — 홈 숫자와 맞추려고)
// 의존: core/format.js
// =====================================================================
import { won, day } from '../core/format.js';

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS = ['auto', 'needs_review', 'confirmed'];
const KINDS = ['expense', 'refund', 'income', 'transfer', 'refund_unlinked'];
export const MAX_ROWS = 2000;

/** 쿼리(Map) → 필터. 형식이 틀린 값은 없는 것으로 */
export function parseListFilter(query) {
  const get = (k) => query.get(k) ?? '';
  const pick = (v, allowed) => (allowed.includes(v) ? v : null);
  const cat = get('cat');
  return {
    payer: pick(get('payer'), ['1', '2']),
    status: pick(get('status'), STATUS),
    kind: pick(get('kind'), KINDS),
    cat: cat === 'none' || RE_UUID.test(cat) ? cat : null,
    src: RE_UUID.test(get('src')) ? get('src') : null,
    share: pick(get('share'), ['shared', 'personal']),
    excluded: get('excluded') === '1',
    changed: get('changed') === '1',
    q: get('q').normalize('NFKC').trim().slice(0, 50),
  };
}

/** 필터 → 쿼리 객체 (buildHash에 넘김). 빈 값은 빠진다 */
export function filterQuery(month, f) {
  return {
    month,
    payer: f.payer, status: f.status, kind: f.kind, cat: f.cat, src: f.src, share: f.share,
    excluded: f.excluded ? '1' : null, changed: f.changed ? '1' : null, q: f.q || null,
  };
}

/** 카테고리 행 → { byId: Map(id → { name, parentId, groupName }) } */
export function categoryIndex(categories) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out = new Map();
  for (const c of categories) {
    const parent = c.parent_id ? byId.get(c.parent_id) : null;
    out.set(c.id, { id: c.id, name: c.name, parentId: c.parent_id ?? null, groupName: parent?.name ?? c.name });
  }
  return out;
}

const lineList = (row) => (Array.isArray(row.lines) ? row.lines : []);
const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase();

/** 카테고리 필터: 라인의 항목·그룹, 또는 라인 없는 연결 환불이 따르는 원거래 카테고리(v0.2 2-1 — 리포트와 맞춤) */
function matchesCategory(row, catId, cats) {
  if (catId === 'none') return row.is_uncategorized === true;
  const hit = (id) => id === catId || cats.get(id)?.parentId === catId;
  if (lineList(row).some((l) => hit(l.category_id))) return true;
  return lineList(row).length === 0 && row.inherited_category_id != null && hit(row.inherited_category_id);
}

/**
 * 거르기. ctx = { cats: categoryIndex, slotOf: Map(member_id → member_slot) }
 */
export function filterRows(rows, f, ctx) {
  const showExcluded = f.excluded || f.status != null || f.kind != null;
  const q = norm(f.q);
  return rows.filter((r) => {
    if (r.is_excluded && !showExcluded) return false;
    if (f.payer && String(ctx.slotOf.get(r.payer_member_id) ?? '') !== f.payer) return false;
    if (f.status && r.review_status !== f.status) return false;
    if (f.kind === 'refund_unlinked') {
      if (!(r.kind === 'refund' && r.refund_of_txn_id == null)) return false;
    } else if (f.kind && r.kind !== f.kind) return false;
    if (f.cat && !matchesCategory(r, f.cat, ctx.cats)) return false;
    if (f.src && r.source_id !== f.src) return false;
    if (f.share === 'shared' && !r.is_shared) return false;
    if (f.share === 'personal' && r.is_shared) return false;
    if (f.changed && r.is_changed_after_review !== true) return false;
    if (q && !norm(r.merchant_raw).includes(q) && !norm(r.memo).includes(q)) return false;
    return true;
  });
}

/** 합계: 지출(지출 − 환불), 수입, 건수. 집계 제외는 금액에 넣지 않는다 */
export function summarize(rows) {
  let expense = 0;
  let income = 0;
  for (const r of rows) {
    if (r.is_excluded) continue;
    const a = Number(r.amount);
    if (r.kind === 'expense') expense += a;
    else if (r.kind === 'refund') expense -= a;
    else if (r.kind === 'income') income += a;
  }
  return { expense: won(expense), income: won(income), count: `${rows.length}건` };
}

/** 둘째 줄의 카테고리 글자 (v0.2 2-1 A·B·C·D) */
export function categoryLabel(row, cats) {
  const lines = lineList(row);
  if (row.kind === 'transfer') return '이체';
  if (lines.length === 0) {
    if (row.kind === 'refund' && row.refund_of_txn_id && row.inherited_category_id) {
      return `${cats.get(row.inherited_category_id)?.name ?? '?'}(원거래)`;
    }
    return '미분류';
  }
  const first = lines[0].category ?? '미분류';
  return lines.length > 1 ? `${first} 외 ${lines.length - 1}` : first;
}

const REVIEW_TAG = { needs_review: '검토 대기' };

/** 목록 한 줄 */
export function rowView(r, ctx) {
  const a = Number(r.amount);
  let amountText = won(a);
  let tone = 'expense';
  if (r.kind === 'refund') { amountText = won(-a); tone = 'refund'; }
  else if (r.kind === 'income') { amountText = `+${won(a)}`; tone = 'income'; }
  else if (r.kind === 'transfer') tone = 'transfer';
  if (r.is_excluded) tone = 'excluded';
  const tags = [];
  if (REVIEW_TAG[r.review_status]) tags.push(REVIEW_TAG[r.review_status]);
  if (r.is_excluded) tags.push('제외');
  else if (!r.is_shared) tags.push('개인');
  if (r.is_changed_after_review) tags.push('확인 후 변경');
  const slot = ctx.slotOf.get(r.payer_member_id);
  return {
    id: r.id,
    merchant: r.merchant_raw,
    sub: `${categoryLabel(r, ctx.cats)} · ${r.source_label}`,
    amountText,
    tone,
    tags,
    payer: { initial: String(r.payer_name ?? '').slice(0, 1), name: r.payer_name ?? '', slot: slot === 1 || slot === 2 ? slot : 0 },
  };
}

/** 날짜별 묶음(최근 날짜 먼저, 같은 날은 늦은 시각 먼저) */
export function groupByDay(rows) {
  const sorted = [...rows].sort((x, y) => (y.occurred_on.localeCompare(x.occurred_on)
    || String(y.occurred_time ?? '').localeCompare(String(x.occurred_time ?? ''))
    || String(x.id).localeCompare(String(y.id))));
  const groups = [];
  for (const r of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.date === r.occurred_on) last.rows.push(r);
    else groups.push({ date: r.occurred_on, label: day(r.occurred_on), rows: [r] });
  }
  return groups;
}

/** 상한을 넘어 잘렸으면 알린다(조용히 자르지 않음). 합계·검색도 읽은 것 안에서만 맞다 */
export function capNotice(capped) {
  return capped
    ? `이 달 거래가 많아 앞 ${MAX_ROWS.toLocaleString('ko-KR')}건만 보여요. 합계·검색도 이 안에서만 맞아요.`
    : null;
}

/** 필터가 하나라도 걸렸는지(검색 제외) — "필터 지우기" 표시용 */
export function hasFilter(f) {
  return Boolean(f.payer || f.status || f.kind || f.cat || f.src || f.share || f.excluded || f.changed || f.q);
}
