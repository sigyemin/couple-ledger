// 올리기 화면 모델·휴대폰 판별 (합성 값만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPhone } from '../../app/import/env.js';
import {
  applySourceChoice, counterpartyGroups, counterpartyRule, draftRule, matchSources, previewOf, previewLines, readErrorText, resultLines, failedRows, monthTitle,
} from '../../app/screens/upload-model.js';
import { parseHash } from '../../app/router.js';

const ID = (n) => ['00000000', '0000', '4000', '8000', String(n).padStart(12, '0')].join('-');

test('휴대폰 판별: userAgentData.mobile 값이 먼저, 없으면 pointer: coarse, 오류면 PC', () => {
  const mq = (coarse) => () => ({ matches: coarse });
  assert.equal(isPhone({ navigator: { userAgentData: { mobile: true } }, matchMedia: mq(false) }), true);
  assert.equal(isPhone({ navigator: { userAgentData: { mobile: false } }, matchMedia: mq(true) }), false);
  assert.equal(isPhone({ navigator: {}, matchMedia: mq(true) }), true); // 삼성 인터넷(값 없음) + 터치
  assert.equal(isPhone({ navigator: {}, matchMedia: mq(false) }), false);
  assert.equal(isPhone({ navigator: {}, matchMedia: () => { throw new Error('x'); } }), false);
  assert.equal(isPhone({}), false);
});

test('결제수단 맞춤: 켜진 것·형식 일치만, 1개면 자동(시험용은 자동 아님), 여러 개면 고르기(시험용은 뒤·표시), 없으면 빈 목록', () => {
  const F1 = ID(31);
  const F2 = ID(32);
  const s = (n, o) => ({ id: ID(n), label: `카드${n}`, import_format_id: F1, is_active: true, is_test: false, institution: '가상기관', ...o });
  const sources = [s(1), s(2, { import_format_id: F2 }), s(3, { is_active: false }), s(4, { is_test: true, label: '시험' }), s(5, { import_format_id: null })];
  assert.deepEqual(matchSources([F2], sources), { choices: [{ id: ID(2), label: '카드2', formatId: F2, institution: '가상기관', isTest: false }], autoId: ID(2) });
  const m = matchSources([F1], sources);
  assert.deepEqual([m.choices.map((c) => c.label), m.autoId], [['카드1', '시험 (시험용)'], null]);
  assert.deepEqual(matchSources([], sources), { choices: [], autoId: null });
  // 시험용 하나에만 맞아도 자동으로 고르지 않는다(실제 파일이 시험용으로 들어가는 것 막기)
  const onlyTest = matchSources([F1], [s(4, { is_test: true, label: '시험' })]);
  assert.deepEqual([onlyTest.choices.length, onlyTest.autoId, onlyTest.choices[0].isTest], [1, null, true]);
});

test('미리보기: 이미 있는 키는 빼고 셈, 행 오류 사유별, 집계 제외·체크카드·환불·숫자 가림·꼬리 줄, 지출 합계(제외 빼고 환불은 −)', () => {
  const r = (k, o) => ({ dedup_key: k, kind: 'expense', amount: 1000, is_excluded: false, card_kind: null, ...o });
  const parsed = {
    rows: [r('k1'), r('k2', { amount: 2500 }), r('k3', { kind: 'refund', amount: 500 }), r('k4', { kind: 'transfer', is_excluded: true, amount: 90000 }),
      r('k5', { card_kind: 'check_card', amount: 300 }), r('k6')],
    errors: [{ rowNo: 7, reason: 'amount' }, { rowNo: 9, reason: 'amount' }, { rowNo: 12, reason: 'duplicate_key' }],
    skipped: 3, maskedCells: 2,
  };
  const p = previewOf(parsed, new Set(['k6']));
  assert.deepEqual([p.newCount, p.dupCount, p.errorCount, p.excluded, p.checkCard, p.refunds, p.masked, p.skipped, p.spendText],
    [5, 1, 3, 1, 1, 1, 2, 3, '3,300원']);
  assert.deepEqual(p.errorLines, ['금액을 읽지 못함 2줄', '같은 승인번호가 두 번 1줄']);
  assert.deepEqual(p.errorRows, [7, 9, 12]);
  assert.deepEqual(previewLines(p).map((x) => x[0]), ['이미 들어온 행(건너뜀)', '집계 제외(카드대금·이체 등)', '체크카드 사용', '환불', '숫자 가림(카드·계좌번호로 보이는 칸)', '합계·빈 줄(읽지 않음)']);
  assert.deepEqual(previewLines(previewOf({ rows: [r('a')], errors: [], skipped: 0, maskedCells: 0 })), []);
});

test('읽기 실패 안내: 코드별 문구, 휴대폰이면 PC에서 다시', () => {
  assert.equal(readErrorText('unsupported_file'), '엑셀(xls·xlsx)이나 은행 html 파일이 아니에요.');
  assert.equal(readErrorText('worker_error', true), '파일을 읽지 못했어요. PC에서 다시 올려 주세요.');
});

test('저장 결과 문장: 넣음·건너뜀·못 넣음·원거래 못 찾은 환불·환불 금액 다름·멈춤', () => {
  const res = {
    counts: { inserted: 10, duplicate: 3, sensitive: 1, invalid: 1, refund_invalid: 0 },
    failures: [{ rowNo: 4, result: 'sensitive' }, { rowNo: 8, result: 'invalid' }, { rowNo: 9, result: 'refund_unlinked' }],
    notices: [{ rowNo: 5, kind: 'refund_amount_changed', oldAmount: 5000, newAmount: 3000 }], noticeCheckFailed: false, sentRows: 15, error: null,
  };
  assert.deepEqual(resultLines(res), [
    '새로 10건 넣었어요.', '이미 있던 3건은 건너뛰었어요.', '2건은 넣지 못했어요(행 번호는 아래).',
    '환불 1건은 원거래를 못 찾아 따로 넣었어요(월 검토에서 확인).', '5행: 이미 있는 환불 금액 5,000원과 파일 값 3,000원이 달라요. 거래를 확인해 주세요.',
  ]);
  assert.deepEqual(failedRows(res), [4, 8]);
  assert.match(resultLines({ counts: {}, sentRows: 200, error: new Error('x') }).at(-1), /200행까지 보내고 멈췄어요/);
});

test('주소·제목', () => {
  assert.equal(parseHash('#/upload?month=2026-09').query.get('month'), '2026-09');
  assert.equal(monthTitle('2026-09-01'), '9월 파일');
});

test('새 이체 상대 묶음: 표시된 통장 행만, (방향, 띄어쓰기 무시한 설명)으로, 건수 많은 순, 빈 설명은 뺌', () => {
  const r = (merchant, kind, amount, o = {}) => ({ newCounterparty: true, merchant_raw: merchant, kind, amount, ...o });
  const g = counterpartyGroups([
    r('김가짜', 'expense', 50000), r('이시험', 'expense', 1000), r('이 시험', 'expense', 1000), r('이시험', 'income', 300),
    r('', 'expense', 10), r('박샘플', 'expense', 9, { newCounterparty: false }),
  ]);
  assert.deepEqual(g.map((x) => [x.text, x.direction, x.count, x.totalText]), [
    ['이시험', 'out', 2, '2,000원'], ['김가짜', 'out', 1, '50,000원'], ['이시험', 'in', 1, '300원']]);
});

test('규칙 행: 기본 범위 = 그 통장 + 같은 방향 + 이름이 똑같으면, 미리보기용은 기존 규칙 뒤에 오도록', () => {
  const SRC = ID(804);
  const rule = counterpartyRule({ text: '이시험', direction: 'out' }, SRC, { suggested_kind: 'transfer', suggested_exclude_reason: 'personal_transfer', member_id: ID(72) }, '나리');
  assert.deepEqual(rule, { match_field: 'merchant', match_text: '이시험', match_type: 'exact', source_id: SRC, direction: 'out', alias: '나리',
    suggested_kind: 'transfer', suggested_exclude_reason: 'personal_transfer', member_id: ID(72) });
  const d = draftRule(rule, 3);
  assert.deepEqual([d.id, d.priority, d.is_active, d.created_at > '2100'], ['draft-3', 100, true, true]);
});

test('결제수단 고르기를 빈 값으로 되돌리면 고른 값·미리보기를 지우고 고르기 상태(저장 불가) — 시험용·일반 모두', () => {
  for (const id of [ID(4), ID(1)]) {
    const f = { sourceId: id, parsed: { rows: [1] }, preview: { newCount: 1 }, state: 'ready', result: { x: 1 } };
    assert.equal(applySourceChoice(f, ''), 'cleared');
    assert.deepEqual([f.sourceId, f.parsed, f.preview, f.state, f.result, f.cards], [null, null, null, 'choose', null, []]);
    assert.equal(applySourceChoice(f, id), 'prepare');
    assert.equal(f.sourceId, id);
  }
});
