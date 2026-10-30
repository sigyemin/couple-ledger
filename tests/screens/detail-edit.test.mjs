// 거래 상세 금액·날짜·가맹점 고치기 (CL-045) — 합성 값만
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { UPDATE_COLUMNS } from '../../app/core/db.js';
import {
  canEditValues, valuesDraft, linesPlan, buildValuesPatch, valuesConfirmText, chosenLines, valuesErrorText, editedFromFile, linesMismatch,
} from '../../app/screens/detail-edit-model.js';
import { trashPatch, sharePatch, excludePatch, confirmPatch } from '../../app/screens/detail-model.js';
import { restorePatch } from '../../app/screens/trash-model.js';
import { confirmBothPatch } from '../../app/screens/review-model.js';
import { confirmPatch as refundConfirmPatch } from '../../app/screens/refund-model.js';
import { j } from '../import/fixtures.mjs';

const ME = 'a0000000-0000-4000-8000-0000000000e1';
const CAT = 'c0000000-0000-4000-8000-0000000000c1';
const CAT2 = 'c0000000-0000-4000-8000-0000000000c2';
const base = {
  id: 't1', kind: 'expense', origin: 'import', occurred_on: '2026-10-06', occurred_time: '12:30:00', merchant_raw: '가짜식당',
  amount: 30000, period_month: '2026-10-01', is_shared: true, is_excluded: false, refund_of_txn_id: null, deleted_at: null, lines: [],
};
const row = (o = {}) => ({ ...base, ...o });
const form = (o = {}) => ({ ...valuesDraft(base), ...o });

test('허용 칸 목록: 거래 update는 이 15칸만(+ 연말정산 2칸, CL-062), 기존 쓰기(상세·휴지통·월 검토·환불)와 새 수정 값 모두 목록 안', () => {
  const allowed = UPDATE_COLUMNS.transactions;
  assert.deepEqual([...allowed].sort(), ['amount', 'beneficiary_member_id', 'deduction_kind', 'deleted_at', 'deleted_by', 'exclude_reason', 'is_excluded', 'is_shared', 'memo',
    'merchant_norm', 'merchant_raw', 'occurred_on', 'occurred_time', 'review_status', 'updated_by']);
  const patches = [
    trashPatch(ME), sharePatch(true, ME), excludePatch(true, ME), excludePatch(false, ME), confirmPatch(ME), restorePatch(ME),
    confirmBothPatch(ME), refundConfirmPatch(ME), { memo: null, updated_by: ME },
    buildValuesPatch(row(), form({ date: '2026-11-02', time: '', merchant: '가짜 식당', amountText: '31,000' }), ME).patch,
  ];
  for (const p of patches) for (const k of Object.keys(p)) assert.ok(allowed.includes(k), k);
  // 화면 코드에서 transactions update에 넘기는 값이 위 함수들(또는 메모·고친 값)뿐인지 — 새 호출이 생기면 이 시험을 고친다
  const dir = new URL('../../app/screens/', import.meta.url);
  const calls = readdirSync(dir).filter((f) => f.endsWith('.js'))
    .flatMap((f) => [...readFileSync(new URL(f, dir), 'utf8').matchAll(/db\.update\('transactions', [^,]+, ([^)]+\)?)\)/g)].map((m) => `${f}: ${m[1]}`));
  assert.deepEqual(calls.sort(), [
    'detail-deduction.js: patch', 'detail.js: patch', 'detail.js: patch', 'detail.js: v.patch', 'merchant-classify.js: confirmBothPatch(member.memberId)', 'refund.js: confirmPatch(member.memberId)', 'refund.js: confirmPatch(memberId)',
    'review.js: confirmBothPatch(member.memberId)', 'review.js: confirmBothPatch(member.memberId)', 'trash.js: patch',
  ]);
});

test('고칠 수 있는 거래: 이체·휴지통은 안 됨', () => {
  assert.equal(canEditValues(row()), true);
  assert.equal(canEditValues(row({ kind: 'refund' })), true);
  assert.equal(canEditValues(row({ origin: 'manual', kind: 'income' })), true);
  assert.equal(canEditValues(row({ kind: 'transfer' })), false);
  assert.equal(canEditValues(row({ deleted_at: '2026-10-07T00:00:00Z' })), false);
});

test('바뀐 칸만 update, 가맹점은 업로드와 같은 정리값, 시각은 비울 수 있음, dedup_key·검토 상태는 넣지 않음', () => {
  const v = buildValuesPatch(row(), form({ merchant: ' 가짜　식당 ', time: '' }), ME);
  assert.equal(v.ok, true);
  assert.deepEqual(v.patch, { occurred_time: null, merchant_raw: '가짜 식당', merchant_norm: '가짜식당', updated_by: ME }); // 글자 칸 검사가 NFKC·앞뒤 공백 정리
  assert.deepEqual(v.changed, ['time', 'merchant']);
  assert.equal(v.monthFrom, null);
  const v2 = buildValuesPatch(row(), form({ time: '09:05' }), ME);
  assert.deepEqual(v2.patch, { occurred_time: '09:05:00', updated_by: ME });
  assert.deepEqual(buildValuesPatch(row(), form(), ME), { ok: false, field: null, message: '바뀐 내용이 없어요' });
});

test('입력 검사: 날짜·시각·빈 가맹점·200자·민감번호·0원', () => {
  assert.equal(buildValuesPatch(row(), form({ date: '2026-02-30' }), ME).field, 'date');
  assert.equal(buildValuesPatch(row(), form({ time: '25:00' }), ME).field, 'time');
  assert.equal(buildValuesPatch(row(), form({ merchant: '  ' }), ME).field, 'merchant');
  assert.equal(buildValuesPatch(row(), form({ merchant: '가'.repeat(201) }), ME).field, 'merchant');
  assert.equal(buildValuesPatch(row(), form({ merchant: `가짜 ${j('4829', '1736', '5512')}` }), ME).field, 'merchant');
  assert.equal(buildValuesPatch(row(), form({ amountText: '0' }), ME).field, 'amount');
  assert.equal(buildValuesPatch(row(), form({ amountText: '-5' }), ME).field, 'amount');
});

test('라인 계획: 없음 / 1줄이고 옛 금액과 같으면 자동 / 그 밖은 고르기', () => {
  assert.deepEqual(linesPlan(row(), 31000), { type: 'none' });
  const one = row({ lines: [{ category_id: CAT, amount: 30000, item_note: '점심' }] });
  assert.deepEqual(linesPlan(one, 31000), { type: 'auto', lines: [{ category_id: CAT, amount: 31000, item_note: '점심' }] });
  assert.deepEqual(linesPlan(one, 30000), { type: 'none' });
  const off = row({ lines: [{ category_id: CAT, amount: 20000 }] });
  assert.deepEqual(linesPlan(off, 31000), { type: 'choose', count: 1 });
  const two = row({ lines: [{ category_id: CAT, amount: 20000 }, { category_id: CAT2, amount: 10000 }] });
  assert.deepEqual(linesPlan(two, 31000), { type: 'choose', count: 2 });
  assert.deepEqual(chosenLines('merge', CAT2, 31000), { ok: true, lines: [{ category_id: CAT2, amount: 31000, item_note: null }] });
  assert.equal(chosenLines('merge', '', 31000).ok, false);
  assert.deepEqual(chosenLines('resplit', '', 31000), { ok: true, lines: null });
  assert.equal(chosenLines(null, '', 31000).ok, false);
});

test('날짜 변경: 달이 바뀌면 확인 창(연결 환불도 옮겨짐, 확인한 달 안내), 연결된 환불은 달이 그대로', () => {
  const states = new Map([['2026-10-01', 'reviewed'], ['2026-11-01', 'not_reviewed']]);
  const v = buildValuesPatch(row(), form({ date: '2026-11-02' }), ME);
  assert.deepEqual([v.monthFrom, v.monthTo], ['2026-10-01', '2026-11-01']);
  const t = valuesConfirmText(row(), v, states, [{ id: 'r1' }]);
  assert.match(t.message, /10월에서 11월/);
  assert.match(t.message, /연결된 환불 1건도 11월로 옮겨져요/);
  assert.match(t.message, /10월은 확인을 마친 달이라 '확인 후 변경됨'/);
  // 개인 거래는 정산 안내 없음
  assert.doesNotMatch(valuesConfirmText(row({ is_shared: false }), v, states).message, /확인을 마친/);
  // 같은 달 안 날짜만 → 확인 창 없음
  assert.equal(valuesConfirmText(row(), buildValuesPatch(row(), form({ date: '2026-10-20' }), ME), states), null);
  // 연결된 환불: 달은 원거래를 따름
  const ref = row({ kind: 'refund', refund_of_txn_id: 'o1', occurred_on: '2026-11-03', period_month: '2026-10-01' });
  const vr = buildValuesPatch(ref, { ...valuesDraft(ref), date: '2026-12-01' }, ME);
  assert.equal(vr.monthFrom, null);
  assert.match(valuesConfirmText(ref, vr, states).message, /원거래의 달\(10월\)에 집계돼요/);
});

test('금액 변경 확인 문구: 자동 라인, 확인한 달 안내 / 가맹점만 바꾸면 확인 창 없음', () => {
  const states = new Map([['2026-10-01', 'changed_after_review']]);
  const one = row({ lines: [{ category_id: CAT, amount: 30000 }] });
  const v = buildValuesPatch(one, form({ amountText: '25000' }), ME);
  const t = valuesConfirmText(one, v, states);
  assert.match(t.message, /30,000원에서 25,000원/);
  assert.match(t.message, /카테고리 금액도 새 금액으로/);
  assert.match(t.message, /10월은 확인을 마친 달/);
  assert.equal(valuesConfirmText(row(), buildValuesPatch(row(), form({ merchant: '가짜분식' }), ME), states), null);
  const two = row({ lines: [{ category_id: CAT, amount: 20000 }, { category_id: CAT2, amount: 10000 }] });
  const v2 = buildValuesPatch(two, form({ amountText: '31000' }), ME);
  assert.match(valuesConfirmText(two, v2, states, [], 'merge').message, /나눈 2줄을 한 카테고리로 합쳐요/);
  assert.match(valuesConfirmText(two, v2, states, [], 'resplit').message, /다시 나눠 주세요/);
});

test('오류 안내: LG003(원거래·환불), LG002, 그 밖은 null', () => {
  const e = (code) => ({ code: 'x', detail: { sqlState: code } });
  assert.match(valuesErrorText(e('LG003'), row()), /연결된 환불 합계보다 작은/);
  assert.match(valuesErrorText(e('LG003'), row({ kind: 'refund' })), /원거래 금액을 넘는/);
  assert.match(valuesErrorText({ code: 'LG002' }, row()), /숫자가 있어/);
  assert.equal(valuesErrorText(e('42501'), row()), null);
});

test('파일 값에서 고침: 업로드 거래 + 수정 기록 칸, 직접 추가는 표시 안 함 / 나눈 금액 불일치', () => {
  const edits = [{ changed_fields: ['amount', 'updated_by'] }, { changed_fields: ['merchant_norm', 'merchant_raw'] }, { changed_fields: ['memo'] }];
  assert.deepEqual(editedFromFile(row(), edits), ['금액', '가맹점']);
  assert.deepEqual(editedFromFile(row({ origin: 'manual' }), edits), []);
  assert.deepEqual(editedFromFile(row(), []), []);
  assert.equal(linesMismatch(row()), false);
  assert.equal(linesMismatch(row({ lines: [{ amount: 30000 }] })), false);
  assert.equal(linesMismatch(row({ lines: [{ amount: 20000 }, { amount: 5000 }] })), true);
});

test('날짜 범위(CL-047): 날짜를 바꿀 때만 직접 추가와 같은 범위를 본다', () => {
  const T = '2026-10-30';
  assert.equal(buildValuesPatch(row(), form({ date: '1999-12-31' }), ME, T).field, 'date');
  assert.equal(buildValuesPatch(row(), form({ date: '2027-10-31' }), ME, T).field, 'date');
  assert.equal(buildValuesPatch(row(), form({ date: '2027-10-30' }), ME, T).ok, true);
  // 이미 범위 밖 날짜로 들어온 거래도 다른 칸은 고칠 수 있다
  const old = row({ occurred_on: '1999-05-01', period_month: '1999-05-01' });
  assert.equal(buildValuesPatch(old, { ...valuesDraft(old), merchant: '가짜분식' }, ME, T).ok, true);
});
