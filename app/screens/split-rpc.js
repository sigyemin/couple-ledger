// =====================================================================
// 기간을 나눠 다시 부르기 — 미리보기(p_apply=false) → 적용(p_apply=true) RPC 공통 (CL-077, CL-072와 같은 방식)
// - 모든 달로 한 번 부르고, 시간 초과(57014)·대상 상한 초과(LG007)면 귀속월 기간(처음·끝 달)을 반씩 나눠 다시(한 달까지)
// - 적용도 같은 오류면 그 기간을 반씩 나눠 이어 적용(이미 적용한 기간은 다시 부르지 않음)
// - p_description은 부르는 쪽이 기간 글자만 넣는다(이름·가맹점 등 값 금지)
// 의존: screens/merchant-classify-model.js(splitRange·shouldSplit·rangeText)
// =====================================================================
import { splitRange, shouldSplit, rangeText } from './merchant-classify-model.js';

/** 거래가 든 귀속월 처음·끝(기간을 나눌 때만 읽는다) */
export async function monthSpan(db) {
  const one = (ascending) => db.select('v_transaction_detail', {
    columns: 'period_month', filters: [{ col: 'deleted_at', op: 'is', value: null }, { col: 'is_test_source', op: 'eq', value: false }],
    order: [{ col: 'period_month', ascending }], range: { from: 0, to: 0 },
  });
  const [a, b] = await Promise.all([one(true), one(false)]);
  if (a.error || b.error) return { error: a.error ?? b.error };
  const from = a.data?.[0]?.period_month;
  const to = b.data?.[0]?.period_month;
  return from && to ? { data: { from: String(from).slice(0, 10), to: String(to).slice(0, 10) } } : { data: null };
}

/**
 * 미리보기를 기간 나눔과 함께
 * @param call (range) → Promise<{ data, error }>  range = { from, to } (전체면 둘 다 null)
 * @param onStep (text) → void  진행 글
 * @returns {{ ranges: { from, to, rows }[] } | { error, range }}
 */
export async function previewSplit(db, call, onStep = () => {}) {
  const first = await call({ from: null, to: null });
  if (!first.error) return { ranges: [{ from: null, to: null, rows: first.data ?? [] }] };
  if (!shouldSplit(first.error)) return { error: first.error, range: {} };
  const span = await monthSpan(db);
  if (span.error) return { error: span.error, range: {} };
  const queue = span.data ? (splitRange(span.data) ?? []) : [];
  if (!queue.length) return { error: first.error, range: span.data ?? {} };
  const ranges = [];
  while (queue.length) {
    const r = queue.shift();
    onStep(`거래가 많아 기간을 나눠 미리 보는 중… ${rangeText(r)}`);
    const pv = await call(r);
    if (!pv.error) { ranges.push({ ...r, rows: pv.data ?? [] }); continue; }
    const halves = shouldSplit(pv.error) ? splitRange(r) : null;
    if (!halves) return { error: pv.error, range: r };
    queue.unshift(...halves);
  }
  return { ranges };
}

/**
 * 적용을 기간마다(미리보기에서 바뀌는 것이 있던 기간만 넘긴다). 같은 오류면 그 기간을 반씩 나눠 이어 적용
 * @returns {{ rows: object[], done: number, error?, range? }}  done = 적용을 마친 기간 수, rows = 적용 결과 행 모두
 */
export async function applySplit(db, call, ranges, onStep = () => {}) {
  const queue = ranges.map(({ from, to }) => ({ from: from ?? null, to: to ?? null }));
  const rows = [];
  let done = 0;
  while (queue.length) {
    const r = queue.shift();
    if (done > 0 || queue.length > 0 || r.from) onStep(`적용하는 중 ${done + 1}/${done + queue.length + 1} · ${rangeText(r)}`);
    const res = await call(r);
    if (res.error && shouldSplit(res.error)) {
      let halves = r.from ? splitRange(r) : null;
      if (!r.from) {
        const span = await monthSpan(db);
        halves = span.data ? splitRange(span.data) : null;
      }
      if (halves) { queue.unshift(...halves); continue; }
    }
    if (res.error) return { rows, done, error: res.error, range: r };
    rows.push(...(res.data ?? []));
    done += 1;
  }
  return { rows, done };
}
