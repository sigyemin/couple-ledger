// 업로드 현황·홈 '안 올린 파일' 달마다 (CL-056) — 합성 값만, 결제수단 이름은 가짜
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlySources, uploadRange, monthShort, missingSummary, uploadTable, MAX_MONTHS } from '../../app/screens/uploads-model.js';
import { loadUploadStatus } from '../../app/screens/uploads.js';
import { parseHash } from '../../app/router.js';
import { activeTab } from '../../app/screens/shell.js';

const src = (id, label, o = {}) => ({
  id, label, owner_member_id: 'm1', import_format_id: 'f1', is_active: true, is_test: false, is_monthly_upload: true, ...o,
});
const SOURCES = [
  src('s2', '시험 통장'), src('s1', '시험 카드'), src('s3', '나중 카드', { owner_member_id: 'm2' }),
  src('x1', '꺼진 카드', { is_active: false }), src('x2', '시험용', { is_test: true }),
  src('x3', '형식 없음', { import_format_id: null }), src('x4', '가끔 올림', { is_monthly_upload: false }),
];

test('대상 결제수단: missing_uploads와 같은 조건, 구성원·이름 순', () => {
  assert.deepEqual(monthlySources(SOURCES).map((s) => s.id), ['s1', 's2', 's3']);
  assert.deepEqual(monthlySources(null), []);
});

test('범위: 가장 이른 거래 달 ~ 지난달, 거래 없으면 올해 1월, 여러 해, 최근 12달까지', () => {
  assert.deepEqual(uploadRange('2026-03-15', '2026-06-01'), ['2026-03-01', '2026-04-01', '2026-05-01']);
  assert.deepEqual(uploadRange(null, '2026-04-01'), ['2026-01-01', '2026-02-01', '2026-03-01']);
  assert.deepEqual(uploadRange(null, '2026-01-01'), []); // 1월에 거래 없음 → 지난 달 없음
  assert.deepEqual(uploadRange('2026-10-02', '2026-10-01'), []); // 이번 달 거래만
  assert.deepEqual(uploadRange('2025-11-30', '2026-02-01'), ['2025-11-01', '2025-12-01', '2026-01-01']);
  const long = uploadRange('2023-01-01', '2026-10-01');
  assert.equal(long.length, MAX_MONTHS);
  assert.deepEqual([long[0], long.at(-1)], ['2025-10-01', '2026-09-01']);
});

test('달 이름·홈 요약 문구', () => {
  assert.equal(monthShort('2026-01-01', '2026-10-01'), '1월');
  assert.equal(monthShort('2025-12-01', '2026-10-01'), '2025년 12월');
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ source_id: `s${i}`, label: '시험 카드' }));
  assert.equal(missingSummary([], '2026-10-01'), null);
  assert.equal(missingSummary([{ month: '2026-01-01', rows: [] }], '2026-10-01'), null);
  assert.deepEqual(missingSummary([
    { month: '2025-12-01', rows: rows(1) }, { month: '2026-01-01', rows: rows(2) }, { month: '2026-02-01', rows: [] },
  ], '2026-02-01'), { total: 3, text: '2025년 12월 1개, 1월 2개' });
  const many = ['01', '02', '03', '04', '05', '06'].map((m) => ({ month: `2026-${m}-01`, rows: rows(1) }));
  assert.deepEqual(missingSummary(many, '2026-10-01'), { total: 6, text: '1월 1개, 2월 1개, 3월 1개, 4월 1개 외 2달' });
});

test('표 모델: 행 = 결제수단, 열 = 달, 칸 = 글자(올림/안 올림) + 안 올림만 올리기 링크', () => {
  const missing = [
    { month: '2026-01-01', rows: [{ source_id: 's1', label: '시험 카드' }, { source_id: 's2', label: '시험 통장' }] },
    { month: '2026-02-01', rows: [{ source_id: 's1', label: '시험 카드' }, { source_id: 'z9', label: '새 카드' }] },
    { month: '2026-03-01', rows: [] },
  ];
  const t = uploadTable(SOURCES, missing, '2026-10-01');
  assert.deepEqual(t.months.map((m) => m.label), ['1월', '2월', '3월']);
  assert.deepEqual(t.rows.map((r) => r.label), ['시험 카드', '시험 통장', '나중 카드', '새 카드']); // 목록에 없던 결제수단도 행으로
  assert.deepEqual(t.rows.map((r) => r.cells.map((c) => c.text)), [
    ['안 올림', '안 올림', '올림'], ['안 올림', '올림', '올림'], ['올림', '올림', '올림'], ['올림', '안 올림', '올림'],
  ]);
  for (const r of t.rows) for (const c of r.cells) assert.equal(c.href, c.missing ? '#/upload' : null);
  assert.equal(t.missingCount, 4);
  assert.deepEqual(uploadTable([], [], '2026-10-01'), { months: [], rows: [], missingCount: 0 });
});

test('주소: #/uploads는 더보기 탭', () => {
  assert.equal(parseHash('#/uploads').screen, 'uploads');
  assert.equal(activeTab('uploads'), 'more');
});

/** 가짜 db: 호출을 기록 */
function fakeDb({ sources = SOURCES, earliest = '2026-07-20', missing = {}, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async select(view, opts) {
      calls.push(['select', view, opts]);
      if (fail === view) return { data: null, error: { code: 'network', message: '연결 오류' } };
      if (view === 'payment_sources') return { data: sources, error: null };
      return { data: earliest ? [{ occurred_on: earliest }] : [], error: null };
    },
    async rpc(name, args, o) {
      calls.push(['rpc', name, args, o]);
      if (fail === name) return { data: null, error: { code: 'network', message: '연결 오류' } };
      return { data: missing[args.p_month] ?? [], error: null };
    },
  };
}

test('loadUploadStatus: 가장 이른 거래 1건 → 달마다 missing_uploads(재시도), 대상이 없으면 RPC 안 부름, 오류는 그대로', async () => {
  const db = fakeDb({ missing: { '2026-08-01': [{ source_id: 's1', label: '시험 카드' }] } });
  const r = await loadUploadStatus(db, '2026-10-01');
  assert.deepEqual(r.data.missing, [
    { month: '2026-07-01', rows: [] }, { month: '2026-08-01', rows: [{ source_id: 's1', label: '시험 카드' }] }, { month: '2026-09-01', rows: [] },
  ]);
  const first = db.calls.find((c) => c[1] === 'transactions')[2];
  assert.deepEqual(first.filters, [{ col: 'source_id', op: 'in', value: ['s1', 's2', 's3'] }, { col: 'deleted_at', op: 'is', value: null }]);
  assert.deepEqual([first.order, first.range], [[{ col: 'occurred_on', ascending: true }], { from: 0, to: 0 }]);
  assert.deepEqual(db.calls.filter((c) => c[0] === 'rpc').map((c) => [c[2].p_month, c[3].retry]), [['2026-07-01', true], ['2026-08-01', true], ['2026-09-01', true]]);

  const none = fakeDb({ sources: [SOURCES[3]] });
  assert.deepEqual((await loadUploadStatus(none, '2026-10-01')).data.missing, []);
  assert.equal(none.calls.length, 1);

  const empty = fakeDb({ earliest: null });
  assert.equal((await loadUploadStatus(empty, '2026-04-01')).data.missing.length, 3); // 거래 없음 → 1~3월

  assert.equal((await loadUploadStatus(fakeDb({ fail: 'missing_uploads' }), '2026-10-01')).error.code, 'network');
  assert.equal((await loadUploadStatus(fakeDb({ fail: 'transactions' }), '2026-10-01')).error.code, 'network');
});
