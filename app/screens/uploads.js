// =====================================================================
// 더보기 › 업로드 현황 (CL-056): 결제수단 × 달 표, 안 올린 칸을 누르면 올리기 화면으로
// 조회: payment_sources, transactions(대상 결제수단의 가장 이른 거래 날짜 1건), 달마다 missing_uploads(병렬·재시도)
// 홈 할 일 '안 올린 파일'도 같은 조회를 쓴다(loadUploadStatus)
// 의존: ui/dom.js, router.js, screens/uploads-model.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { buildHash, currentMonth } from '../router.js';
import { monthlySources, uploadRange, uploadTable } from './uploads-model.js';
import { errorView } from './shell.js';

const SRC_COLUMNS = 'id,owner_member_id,label,import_format_id,is_active,is_test,is_monthly_upload';

/**
 * @returns {Promise<{ data: { sources, missing: {month, rows}[] } } | { error }>}
 */
export async function loadUploadStatus(db, thisMonth = currentMonth()) {
  const src = await db.select('payment_sources', { columns: SRC_COLUMNS });
  if (src.error) return { error: src.error };
  const sources = src.data ?? [];
  const ids = monthlySources(sources).map((s) => s.id);
  if (!ids.length) return { data: { sources, missing: [] } };
  const first = await db.select('transactions', {
    columns: 'occurred_on',
    filters: [{ col: 'source_id', op: 'in', value: ids }, { col: 'deleted_at', op: 'is', value: null }],
    order: [{ col: 'occurred_on', ascending: true }],
    range: { from: 0, to: 0 },
  });
  if (first.error) return { error: first.error };
  const months = uploadRange(first.data?.[0]?.occurred_on ?? null, thisMonth);
  const res = await Promise.all(months.map((m) => db.rpc('missing_uploads', { p_month: m }, { retry: true })));
  const error = res.find((r) => r.error)?.error;
  if (error) return { error };
  return { data: { sources, missing: months.map((month, i) => ({ month, rows: res[i].data ?? [] })) } };
}

/**
 * @param {{ db, isCurrent(), onError(err) }} ctx
 */
export async function renderUploads({ db, isCurrent, onError }, doc = globalThis.document) {
  const thisMonth = currentMonth();
  const res = await loadUploadStatus(db, thisMonth);
  if (!isCurrent()) return null;
  const head = h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav' }, [
      h('a', { class: 'icon-btn', text: '‹', attrs: { href: buildHash('more'), 'aria-label': '더보기로' } }, [], doc),
      h('h1', { class: 'title', text: '업로드 현황' }, [], doc),
    ], doc),
  ], doc);
  if (res.error) {
    onError?.(res.error);
    return h('main', { class: 'screen' }, [head, errorView(res.error.message, res.error.detail?.sqlState ?? res.error.code, doc)], doc);
  }
  const t = uploadTable(res.data.sources, res.data.missing, thisMonth);
  let body;
  if (!t.rows.length) {
    body = h('p', { class: 'muted', text: '매달 올리는 결제수단이 없어요. 결제수단 화면에서 정할 수 있어요.' }, [], doc);
  } else if (!t.months.length) {
    body = h('p', { class: 'muted', text: '확인할 지난 달이 아직 없어요.' }, [], doc);
  } else {
    body = h('div', { class: 'table-scroll' }, [
      h('table', { class: 'upload-table' }, [
        h('caption', { class: 'sr-only', text: '결제수단별 달마다 파일을 올렸는지' }, [], doc),
        h('thead', {}, [h('tr', {}, [
          h('th', { text: '결제수단', attrs: { scope: 'col' } }, [], doc),
          ...t.months.map((m) => h('th', { text: m.label, attrs: { scope: 'col' } }, [], doc)),
        ], doc)], doc),
        h('tbody', {}, t.rows.map((r) => h('tr', {}, [
          h('th', { text: r.label, attrs: { scope: 'row' } }, [], doc),
          ...r.cells.map((c) => h('td', { class: c.missing ? 'miss' : 'done' }, [
            c.missing
              ? h('a', { text: c.text, attrs: { href: c.href, 'aria-label': `${r.label} ${c.month.slice(0, 7)} 안 올림 — 올리러 가기` } }, [], doc)
              : h('span', { text: c.text }, [], doc),
          ], doc)),
        ], doc)), doc),
      ], doc),
    ], doc);
  }
  const lead = t.missingCount
    ? `안 올린 칸 ${t.missingCount}개 — 누르면 올리기 화면으로 가요.`
    : (t.rows.length && t.months.length ? '모든 달을 올렸어요.' : null);
  return h('main', { class: 'screen' }, [
    head,
    h('section', { class: 'card' }, [
      lead ? h('p', { class: 'muted', text: lead }, [], doc) : null,
      body,
      h('p', { class: 'muted small', text: '그 달 파일을 올렸거나, 다른 달 파일에 그 달 거래가 들어 있으면 올림이에요. 이번 달은 아직 세지 않아요.' }, [], doc),
    ], doc),
  ], doc);
}
