// 통장에 찍히는 이름 · 통장끼리 이체 짝 (v0.23 CL-077) — 가짜 이름만
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memberTransferReason, toRpcRows } from '../../app/import/normalize.js';
import { parseFile } from '../../app/import/pipeline.js';
import { XLSX, SOURCE, FORMAT_A, FORMAT_B, bookBytes, sheetA, sheetB } from '../import/fixtures.mjs';
import {
  checkName, nameErrorText, namesByMember, nameApplySummary, nameApplyText, pairGroups, pickedPairs, pairApplyText, txnLine, CONTAINS_HINT,
} from '../../app/screens/transfer-names-model.js';
import { previewLines, previewOf } from '../../app/screens/upload-model.js';
import { KIND_NAME } from '../../app/screens/changes-model.js';
import { INSERT_TABLES, INSERT_COLUMNS, DELETE_TABLES, COLUMN_VALUES } from '../../app/core/db.js';

const src = (p) => readFileSync(new URL(`../../app/${p}`, import.meta.url), 'utf8');
const N = (member_id, pattern_norm, match_type = 'exact') => ({ member_id, pattern_norm, match_type });

test('이름 판정: DB member_transfer_reason과 같은 규칙(정확히·포함, 설명·상대 칸, 주인 = 내 계좌 / 다른 사람 = 두 사람 간, 둘 다 맞으면 모호)', () => {
  const names = [N('mA', '도가짜'), N('mB', '표시험', 'contains')];
  assert.equal(memberTransferReason(names, 'mA', '도가짜', ''), 'internal_transfer');
  assert.equal(memberTransferReason(names, 'mB', '도 가짜', ''), 'personal_transfer', '띄어쓰기 무시(정리값)');
  assert.equal(memberTransferReason(names, 'mA', '도가짜네식당', ''), null, '정확히는 칸 전체가 같아야');
  assert.equal(memberTransferReason(names, 'mA', '가상은행표시험0101', ''), 'personal_transfer', '포함');
  assert.equal(memberTransferReason(names, 'mA', '이체', '도가짜'), 'internal_transfer', '상대 칸도');
  assert.equal(memberTransferReason(names, 'mA', '도가짜', '표시험용돈'), 'ambiguous', '두 사람 다 맞으면');
  assert.equal(memberTransferReason([], 'mA', '도가짜', ''), null);
  assert.equal(memberTransferReason(names, 'mA', '', ''), null);
});

test('업로드 판정: 행 규칙 → 이체 상대 규칙 → 이름 → 기본값, 이름이면 이체·집계 제외·확인함, 새 이체 상대 후보에서 빠짐, RPC로 표시 안 보냄', async () => {
  const base = { format: FORMAT_A, sourceId: SOURCE };
  const plain = await parseFile(XLSX, bookBytes(sheetA(), 'xlsx'), base);
  const target = plain.rows.find((r) => r.merchant_raw.startsWith('이시험'));
  const names = [N('mA', '이시험', 'contains')];
  const r = await parseFile(XLSX, bookBytes(sheetA(), 'xlsx'), { ...base, memberNames: names, ownerId: 'mA' });
  const hit = r.rows.filter((x) => x.merchant_raw.startsWith('이시험'));
  assert.ok(hit.length >= 1 && target);
  for (const x of hit) {
    assert.deepEqual([x.kind, x.exclude_reason, x.is_excluded, x.review_status, x.category_id ?? null, x.nameTransfer, x.newCounterparty],
      ['transfer', 'internal_transfer', true, 'confirmed', null, 'internal_transfer', undefined]);
  }
  const other = await parseFile(XLSX, bookBytes(sheetA(), 'xlsx'), { ...base, memberNames: names, ownerId: 'mB' });
  assert.ok(other.rows.filter((x) => x.merchant_raw.startsWith('이시험')).every((x) => x.exclude_reason === 'personal_transfer'), '다른 사람 통장이면 두 사람 간 송금');
  // 이체 상대 규칙이 먼저
  const cp = [{ match_field: 'merchant', match_text: '이시험', suggested_kind: 'expense', suggested_category_id: null, suggested_is_shared: true }];
  const withCp = await parseFile(XLSX, bookBytes(sheetA(), 'xlsx'), { ...base, counterpartyRules: cp, memberNames: names, ownerId: 'mA' });
  assert.ok(withCp.rows.filter((x) => x.merchant_raw.startsWith('이시험') && x.kind !== 'income').every((x) => x.kind === 'expense' && !x.nameTransfer));
  // 카드 형식은 이름 판정 안 함
  const card = await parseFile(XLSX, bookBytes(sheetB(), 'xls'), { format: FORMAT_B, sourceId: SOURCE, memberNames: [N('mA', '가', 'contains')], ownerId: 'mA' });
  assert.ok(card.rows.every((x) => !x.nameTransfer));
  for (const row of toRpcRows(r.rows)) assert.ok(!('nameTransfer' in row));
  // 미리보기 건수(동명이인 확인용)
  const p = previewOf(r, new Set());
  assert.equal(p.nameInternal, hit.length);
  assert.ok(previewLines(p).some(([k, v]) => k.startsWith('이름으로 이체') && v.startsWith(`${hit.length}건`)));
});

test('이름 입력 검사: DB CHECK와 같게(2~20자·글자 포함·긴 숫자 금지·포함은 3자 이상·30자)', () => {
  assert.deepEqual(checkName({ pattern: ' 도가짜 ', matchType: 'exact' }, 'm1'), { ok: true, row: { member_id: 'm1', pattern: '도가짜', match_type: 'exact' } });
  assert.equal(checkName({ pattern: '가', matchType: 'exact' }, 'm1').ok, false);
  assert.equal(checkName({ pattern: '12-34', matchType: 'exact' }, 'm1').ok, false);
  assert.equal(checkName({ pattern: `도가짜${'0'.repeat(10)}`, matchType: 'exact' }, 'm1').ok, false);
  assert.match(checkName({ pattern: '도가', matchType: 'contains' }, 'm1').message, /3글자 이상/);
  assert.equal(checkName({ pattern: '도가짜', matchType: 'contains' }, 'm1').row.match_type, 'contains');
  assert.equal(checkName({ pattern: '가'.repeat(31) }, 'm1').ok, false);
  assert.match(nameErrorText({ detail: { sqlState: '23505' } }), /이미 등록된 이름/);
  assert.match(nameErrorText({ detail: { sqlState: '23514' } }), /2글자 이상/);
  assert.equal(nameErrorText({ detail: { sqlState: '42501' } }), null);
  assert.match(CONTAINS_HINT, /붙어 찍히는 경우가 많아요/);
});

test('사람별 이름 목록·지난 거래 적용 요약·문구(이름 없음)', () => {
  const g = namesByMember([{ member_id: 'm2', pattern: '표시험', created_at: '2' }, { member_id: 'm1', pattern: '도가짜', created_at: '1' }],
    [{ id: 'm2', member_slot: 2, display_name: '나리' }, { id: 'm1', member_slot: 1, display_name: '가람' }], 'm1');
  assert.deepEqual(g.map((x) => [x.name, x.mine, x.rows.length]), [['가람', true, 1], ['나리', false, 1]]);
  const rows = ['updated', 'updated', 'updated', 'skipped_edited', 'skipped_ambiguous', 'skipped_counterparty_rule', 'skipped_has_refund']
    .map((result, i) => ({ result, new_exclude_reason: result === 'updated' ? (i ? 'personal_transfer' : 'internal_transfer') : null }));
  const s = nameApplySummary(rows);
  assert.deepEqual([s.updated, s.internal, s.personal, s.skipped_edited, s.skipped_ambiguous, s.skipped_counterparty_rule, s.skipped_has_refund], [3, 1, 2, 1, 1, 1, 1]);
  const t = nameApplyText(s, 1);
  assert.match(t.message, /3건을 이체로 바꿔요\(내 계좌 이동 1 · 두 사람 간 송금 2\)/);
  assert.match(t.message, /같은 이름의 다른 사람/);
  assert.match(nameApplyText(s, 3).undoNote, /기간을 3개로/);
});

test('짝 묶음: 모호하지 않은 짝은 체크 목록, 모호한 짝은 출금마다 후보, 같은 거래 두 번은 빼고 보냄', () => {
  const rows = [
    { out_txn_id: 'o1', in_txn_id: 'i1', amount: '300000', out_on: '2026-10-02', in_on: '2026-10-02', suggested_exclude_reason: 'internal_transfer', is_ambiguous: false },
    { out_txn_id: 'o2', in_txn_id: 'i2', amount: '50000', out_on: '2026-10-05', in_on: '2026-10-06', suggested_exclude_reason: 'personal_transfer', is_ambiguous: true },
    { out_txn_id: 'o2', in_txn_id: 'i3', amount: '50000', out_on: '2026-10-05', in_on: '2026-10-05', suggested_exclude_reason: 'personal_transfer', is_ambiguous: true },
  ];
  const d = new Map([['o1', { occurred_on: '2026-10-02', source_label: '시험통장', merchant_raw: '김가짜' }]]);
  const g = pairGroups(rows, d);
  assert.deepEqual(g.clear.map((x) => [x.outId, x.label, x.amount]), [['o1', '내 계좌 이동', 300000]]);
  assert.deepEqual(g.choose.map((c) => [c.outId, c.items.map((x) => x.inId)]), [['o2', ['i3', 'i2']]], '후보는 입금 날짜 순');
  assert.equal(txnLine(d.get('o1'), '2026-10-02'), '10월 2일 (금) · 시험통장 · 김가짜');
  assert.match(txnLine(null, '2026-10-02'), /불러오지 못함/);
  assert.deepEqual(pickedPairs([g.clear[0], g.choose[0].items[0], { outId: 'o1', inId: 'i9' }]), [{ out_txn_id: 'o1', in_txn_id: 'i1' }, { out_txn_id: 'o2', in_txn_id: 'i3' }]);
  assert.match(pairApplyText([g.clear[0], g.choose[0].items[0]]).message, /2쌍\(내 계좌 이동 1 · 두 사람 간 송금 1\)/);
});

test('허용 칸·변경 기록 이름표·되돌리기 확인', async () => {
  assert.ok(INSERT_TABLES.includes('member_transfer_names') && DELETE_TABLES.includes('member_transfer_names'));
  assert.deepEqual(INSERT_COLUMNS.member_transfer_names, ['member_id', 'pattern', 'match_type']);
  assert.deepEqual(COLUMN_VALUES.member_transfer_names.match_type, ['exact', 'contains']);
  assert.equal(KIND_NAME.member_name_apply, '이름으로 이체 정리');
  assert.equal(KIND_NAME.transfer_pair, '내 계좌 이동 짝');
  const { revertView } = await import('../../app/screens/changes-model.js').catch(() => ({}));
  const c = src('screens/changes-model.js');
  assert.match(c, /const KIND_CHANGING = new Set\(\['counterparty_apply', 'member_name_apply', 'transfer_pair'\]\);/);
  assert.match(c, /needsConfirm: KIND_CHANGING\.has\(batch\.kind\)/);
  void revertView;
});

test('이름은 화면에만: p_description은 기간만, 기록·콘솔·localStorage 없음, 업로드는 정리값만 읽음', () => {
  const s = src('screens/transfer-names.js');
  assert.match(s, /p_description: `이름으로 이체 정리 · \$\{rangeText\(r\)\}`/);
  assert.match(s, /p_description: `통장끼리 이체 짝 · \$\{ym\(monthStart\)\}`/);
  assert.doesNotMatch(s, /console\.\w|localStorage\.|innerHTML/);
  assert.doesNotMatch(s, /onError\?\.\([^)]*pattern/, '오류 기록에 이름 없음');
  assert.match(src('screens/upload.js'), /db\.select\('member_transfer_names', \{ columns: 'member_id,pattern_norm,match_type' \}\)/);
  assert.doesNotMatch(src('import/normalize.js'), /console\./);
});
