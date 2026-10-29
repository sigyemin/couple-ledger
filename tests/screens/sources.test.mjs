// 결제수단 관리 모델 (합성 이름만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkLast4, formatOptions, sourceGroups, checkSource, sourcePatch, usageText, deleteSourceErrorText, lockErrorText, CASH_INSTITUTION,
} from '../../app/screens/sources-model.js';
import { createDb, INSERT_COLUMNS, UPDATE_COLUMNS, DELETE_TABLES } from '../../app/core/db.js';
import { subjectParticle } from '../../app/screens/home-model.js';
import { parseHash } from '../../app/router.js';
import { activeTab } from '../../app/screens/shell.js';

const ID = (n) => ['00000000', '0000', '4000', '8000', String(n).padStart(12, '0')].join('-');
const A = ID(71);
const B = ID(72);
const members = [{ id: B, member_slot: 2, display_name: '나리' }, { id: A, member_slot: 1, display_name: '가람' }];
const F_CARD = ID(31);
const F_BANK = ID(32);
const formats = [
  { id: F_CARD, institution: '가상카드', kind: 'credit_card', version: 1, file_types: ['xls'] },
  { id: F_BANK, institution: '시험은행', kind: 'bank_account', version: 1, file_types: ['xlsx', 'html'] },
];
const src = (n, o) => ({ id: ID(n), owner_member_id: A, kind: 'credit_card', institution: '가상카드', label: `카드${n}`, last4: null,
  import_format_id: F_CARD, is_active: true, is_test: false, is_monthly_upload: true, ...o });
const randDigits = (n) => Array.from({ length: n }, () => String(Math.floor(Math.random() * 10))).join('');

test('끝 4자리: 빈칸 = 없음, 숫자 정확히 4개만, 5자리 이상·숫자 아님·공백 섞임·전각은 거부', () => {
  assert.deepEqual(checkLast4(''), { ok: true, value: null });
  assert.deepEqual(checkLast4(' 0042 '), { ok: true, value: '0042' });
  for (const v of ['123', randDigits(5), randDigits(16), '12a4', '12 34', '１２３４', '12-34']) assert.equal(checkLast4(v).ok, false, v);
});

test('형식 고르기: 같은 종류만, 현금은 없음', () => {
  assert.deepEqual(formatOptions(formats, 'bank_account'), [{ id: F_BANK, label: '시험은행 (xlsx·html)' }]);
  assert.deepEqual(formatOptions(formats, 'cash'), []);
});

test('목록: 구성원 자리 순 묶음 + 시험용 따로, 사용 중 먼저·이름 순, 꼬리표(형식 없음·가끔 올림·꺼짐·테스트), 끝 4자리 표시', () => {
  const g = sourceGroups([
    src(1, { label: '나 카드', owner_member_id: B }),
    src(2, { label: '다 통장', kind: 'bank_account', import_format_id: F_BANK, is_monthly_upload: false }),
    src(3, { label: '가 카드', last4: '0042' }),
    src(4, { label: '라 카드', import_format_id: null }),
    src(5, { label: '마 현금', kind: 'cash', import_format_id: null, is_monthly_upload: false }),
    src(6, { label: '바 카드', is_active: false }),
    src(7, { label: '시험 카드', is_test: true, owner_member_id: B }),
  ], formats, members);
  assert.deepEqual(g.map((x) => [x.title, x.rows.map((r) => r.label)]), [
    ['가람', ['가 카드 ··0042', '다 통장', '라 카드', '마 현금', '바 카드']], ['나리', ['나 카드']], ['시험용', ['시험 카드']]]);
  const rows = g[0].rows;
  assert.deepEqual(rows.map((r) => r.tags), [[], ['가끔 올림'], ['형식 없음'], [], ['꺼짐']]);
  assert.deepEqual(rows.map((r) => r.sub), ['신용카드 · 가상카드 형식 · 매달 올림', '통장 · 시험은행 형식 · 직접 쓴 달만', '신용카드 · 파일을 아직 못 읽어요', '현금 · 직접 추가만', '신용카드 · 가상카드 형식 · 매달 올림']);
  assert.deepEqual([g[2].rows[0].tags, g[2].rows[0].sub], [['테스트'], '나리 · 집계·정산·리포트에 안 들어가요']);
});

test('입력 검사: 이름 필수·20자·민감번호, 끝 4자리, 형식은 종류에 맞게, 형식 없음이면 기관 이름, 현금은 기관 고정·매달 올림 끔, 시험용 칸 없음', () => {
  const base = { label: '새 카드', last4: '', ownerId: A, kind: 'credit_card', formatId: F_CARD, institution: '', isMonthly: true, isActive: true };
  const v = checkSource(base, formats);
  assert.deepEqual(v.value, { owner_member_id: A, kind: 'credit_card', institution: '가상카드', label: '새 카드', last4: null, import_format_id: F_CARD, is_monthly_upload: true, is_active: true });
  assert.ok(!('is_test' in v.value));
  assert.equal(checkSource({ ...base, label: ' ' }, formats).field, 'label');
  assert.equal(checkSource({ ...base, label: 'x'.repeat(21) }, formats).field, 'label');
  assert.equal(checkSource({ ...base, label: `카드${randDigits(12)}` }, formats).field, 'label');
  assert.equal(checkSource({ ...base, last4: randDigits(6) }, formats).field, 'last4');
  assert.equal(checkSource({ ...base, formatId: F_BANK }, formats).field, 'format');
  assert.equal(checkSource({ ...base, formatId: '' }, formats).field, 'institution');
  assert.deepEqual([checkSource({ ...base, formatId: '', institution: '새 은행' }, formats).value.institution, checkSource({ ...base, formatId: '', institution: '새 은행' }, formats).value.import_format_id], ['새 은행', null]);
  const cash = checkSource({ ...base, kind: 'cash', formatId: F_CARD }, formats).value;
  assert.deepEqual([cash.institution, cash.import_format_id, cash.is_monthly_upload], [CASH_INSTITUTION, null, false]);
  assert.equal(checkSource({ ...base, kind: 'check_card' }, formats).field, 'kind');
  assert.equal(checkSource({ ...base, ownerId: '' }, formats).field, 'owner');
});

test('잠금: 거래가 있으면 결제자·종류는 원래 값, 바뀐 칸만(잠긴 칸 제외)', () => {
  const o = src(1, {});
  const v = checkSource({ label: '이름 바꿈', last4: '1234', ownerId: B, kind: 'cash', formatId: F_CARD, isMonthly: false, isActive: true }, formats, { locked: true, original: o }).value;
  assert.deepEqual([v.owner_member_id, v.kind], [A, 'credit_card']);
  assert.deepEqual(sourcePatch(o, v, { locked: true }), { label: '이름 바꿈', last4: '1234', is_monthly_upload: false });
  assert.deepEqual(sourcePatch(o, { ...o, owner_member_id: B }, { locked: false }), { owner_member_id: B });
});

test('아래 정보·오류 안내', () => {
  const nameOf = new Map([[A, '가람']]);
  assert.equal(usageText(37, false, { target_month: '2026-09-01', uploaded_by: A, uploaded_at: '2026-10-03T01:00:00Z' }, nameOf, subjectParticle),
    '거래 37건 · 마지막 파일 9월분 (10월 3일 가람이 올림)');
  assert.equal(usageText(0, false, null, nameOf, subjectParticle), '거래 0건 · 올린 파일 없음');
  assert.match(usageText(2000, true, null, nameOf, subjectParticle), /2,000건 넘음/);
  assert.match(deleteSourceErrorText({ detail: { sqlState: '23503' } }), /꺼 주세요/);
  assert.match(lockErrorText({ detail: { sqlState: 'LG005' } }), /새 결제수단/);
});

test('쓰기 허용: is_test는 insert·update 칸에 없음, kind·last4 값 검사는 요청 전에', async () => {
  for (const cols of [INSERT_COLUMNS.payment_sources, UPDATE_COLUMNS.payment_sources]) assert.ok(!cols.includes('is_test'));
  assert.ok(DELETE_TABLES.includes('payment_sources'));
  const calls = [];
  const client = { from: () => { calls.push(1); return {}; }, rpc: () => {} };
  const db = createDb(client);
  for (const r of await Promise.all([
    db.insert('payment_sources', { owner_member_id: A, kind: 'credit_card', institution: 'x', label: 'x', is_test: true }),
    db.insert('payment_sources', { owner_member_id: A, kind: 'check_card', institution: 'x', label: 'x' }),
    db.insert('payment_sources', { owner_member_id: A, kind: 'cash', institution: 'x', label: 'x', last4: randDigits(16) }),
    db.update('payment_sources', ID(1), { last4: '12345' }),
    db.update('payment_sources', ID(1), { is_test: true }),
  ])) assert.equal(r.error?.code, 'invalid');
  assert.equal(calls.length, 0);
});

test('주소·탭', () => {
  assert.equal(parseHash(`#/source/${ID(1)}`).screen, 'source');
  assert.equal(parseHash('#/source/x').screen, 'sources');
  assert.deepEqual(['sources', 'source', 'sourcenew'].map(activeTab), ['more', 'more', 'more']);
});
