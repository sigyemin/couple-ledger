// 스키마 v0.22 앱 영향 (CL-072 A1~A4) — 합성 값만
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UPDATE_COLUMNS } from '../../app/core/db.js';
import { loadTxnDeduction } from '../../app/screens/detail-deduction.js';
import { TRASHED_EDIT_TEXT } from '../../app/screens/detail-model.js';

const src = (p) => readFileSync(new URL(`../../app/${p}`, import.meta.url), 'utf8');

test('A1: 한 번에 분류는 reapply_all_category_rules 미리보기 → 적용, 규칙마다 부르지 않음, 설명에 규칙 이름 없음, 나눠 부르기', () => {
  const c = src('screens/merchant-classify.js');
  assert.doesNotMatch(c, /reapply_category_rule'/, '규칙마다 부르던 RPC를 쓰지 않음');
  assert.match(c, /db\.rpc\('reapply_all_category_rules', \{ p_apply: false, p_from_month: r\.from \?\? null, p_to_month: r\.to \?\? null \}, \{ retry: true \}\)/);
  assert.match(c, /p_apply: true, p_from_month: r\.from, p_to_month: r\.to, p_description: `켜진 규칙 한 번에 분류 · \$\{rangeText\(r\)\}`/);
  assert.doesNotMatch(c, /p_description: `[^`]*rule\.pattern/, '설명에 규칙 패턴(가맹점 글자)을 넣지 않음');
  assert.match(c, /const halves = shouldSplit\(pv\.error\) \? splitRange\(r\) : null;/);
});

test('A2: 상세 연말정산은 고친 값을 상세 행에서 읽고 v_deduction_txn만 조회', async () => {
  const calls = [];
  const db = { async select(view, o) { calls.push([view, o.filters]); return { data: [{ txn_id: 't1', deduction_kind: 'check_card' }] }; } };
  const r = await loadTxnDeduction(db, { id: 't1', deduction_kind: 'culture', beneficiary_member_id: null });
  assert.deepEqual(calls.map((x) => x[0]), ['v_deduction_txn']);
  assert.deepEqual(r.data.cur, { id: 't1', deduction_kind: 'culture', beneficiary_member_id: null });
  assert.equal(r.data.parts.length, 1);
  const e = await loadTxnDeduction({ async select() { return { error: { code: 'x' } }; } }, { id: 't1' });
  assert.deepEqual(e, { error: { code: 'x' } });
  assert.match(src('screens/detail.js'), /'deduction_kind', 'beneficiary_member_id',/);
});

test('A3: 거래 수정 허용 칸에 출처·업로드 원본 칸이 없음', () => {
  for (const col of ['origin', 'dedup_key', 'batch_id', 'row_seq', 'raw', 'source_id', 'approval_no']) {
    assert.ok(!UPDATE_COLUMNS.transactions.includes(col), col);
  }
});

test('A4: LG005 문구가 원본 칸도 말함', () => {
  assert.match(TRASHED_EDIT_TEXT, /휴지통에 있는 거래이거나 바꿀 수 없는 칸\(거래의 출처·업로드 원본\)/);
});
