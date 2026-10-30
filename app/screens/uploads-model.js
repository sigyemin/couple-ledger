// =====================================================================
// 업로드 현황 — 달마다 안 올린 파일 (CL-056, 사용자 결정 10-30 B4). 화면 없이 계산하는 부분
// - 대상 결제수단: missing_uploads와 같은 조건(사용 중·시험 아님·형식 있음·매달 올림)
// - 범위: 지난달이 속한 해의 1월과 가장 이른 거래 달 중 이른 달 ~ 지난달. 길면 최근 MAX_MONTHS달만
//   (1월에는 지난달 = 작년 12월 → 작년 1~12월)
//   (모든 결제수단이 1·2월에 거래가 없어도 1·2월을 안 올림으로 보여야 한다 — 총괄 결정 10-30)
// - 칸: 그 달 missing_uploads에 나오면 '안 올림', 아니면 '올림'(판정은 DB 함수 그대로)
// 의존: router.js
// =====================================================================
import { addMonths, buildHash } from '../router.js';

export const MAX_MONTHS = 12;

/** missing_uploads 대상 결제수단만, 구성원·이름 순(DB 함수 정렬과 같게) */
export function monthlySources(sources) {
  return (sources ?? [])
    .filter((s) => s.is_active && !s.is_test && s.import_format_id != null && s.is_monthly_upload)
    .sort((a, b) => String(a.owner_member_id ?? '').localeCompare(String(b.owner_member_id ?? ''))
      || String(a.label).localeCompare(String(b.label)));
}

/**
 * 확인할 달 목록(오래된 달부터)
 * @param {string|null} earliestDate 가장 이른 거래 날짜 'YYYY-MM-DD'(없으면 null)
 * @param {string} thisMonth 이번 달 'YYYY-MM-01'(서울)
 */
export function uploadRange(earliestDate, thisMonth, max = MAX_MONTHS) {
  const last = addMonths(thisMonth, -1);
  const jan = `${last.slice(0, 4)}-01-01`;
  const early = earliestDate ? `${String(earliestDate).slice(0, 7)}-01` : jan;
  const first = early < jan ? early : jan;
  const floor = addMonths(last, -(max - 1));
  const months = [];
  for (let m = first < floor ? floor : first; m <= last; m = addMonths(m, 1)) months.push(m);
  return months;
}

/** 'YYYY-MM-01' → '1월'(이번 해) 또는 '2025년 12월' */
export function monthShort(m, thisMonth) {
  const label = `${Number(m.slice(5, 7))}월`;
  return m.slice(0, 4) === thisMonth.slice(0, 4) ? label : `${m.slice(0, 4)}년 ${label}`;
}

/**
 * 홈 할 일 한 줄. 안 올린 칸이 없으면 null
 * @param {{ month, rows }[]} missing 달마다 missing_uploads 결과
 * @returns {{ total, text }|null} text 예) '1월 2개, 2월 1개'
 */
export function missingSummary(missing, thisMonth, maxMonths = 4) {
  const months = (missing ?? []).filter((x) => x.rows.length > 0);
  if (!months.length) return null;
  const total = months.reduce((s, x) => s + x.rows.length, 0);
  const shown = months.slice(0, maxMonths).map((x) => `${monthShort(x.month, thisMonth)} ${x.rows.length}개`);
  const rest = months.length - shown.length;
  return { total, text: rest > 0 ? `${shown.join(', ')} 외 ${rest}달` : shown.join(', ') };
}

/**
 * 표 모델: 행 = 결제수단, 열 = 달
 * 안 올린 결제수단이 대상 목록에 없으면(조회 사이에 바뀜) 행을 더한다
 * @returns {{ months: {month, label}[], rows: {id, label, cells: {month, missing, text, href}[]}[], missingCount }}
 */
export function uploadTable(sources, missing, thisMonth) {
  const list = monthlySources(sources).map((s) => ({ id: s.id, label: s.label }));
  const sets = new Map();
  for (const x of missing ?? []) {
    sets.set(x.month, new Set(x.rows.map((r) => r.source_id)));
    for (const r of x.rows) if (!list.some((s) => s.id === r.source_id)) list.push({ id: r.source_id, label: r.label });
  }
  const months = (missing ?? []).map((x) => x.month);
  let missingCount = 0;
  const rows = list.map((s) => ({
    id: s.id,
    label: s.label,
    cells: months.map((month) => {
      const miss = sets.get(month)?.has(s.id) ?? false;
      if (miss) missingCount += 1;
      return { month, missing: miss, text: miss ? '안 올림' : '올림', href: miss ? buildHash('upload') : null };
    }),
  }));
  return { months: months.map((month) => ({ month, label: monthShort(month, thisMonth) })), rows, missingCount };
}
