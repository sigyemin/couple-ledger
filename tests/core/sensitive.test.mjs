// app/core/sensitive.js — DB has_sensitive_number와 같은 시험 사례(스키마 검증 C5-1~11)를 쓴다.
// 10자리 이상 숫자는 소스에 그대로 쓰지 않고 실행 중에 이어 붙인다(이 파일도 유출 검사를 통과해야 함).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasSensitiveNumber, maskSensitiveNumbers, removeKnownPatterns, approvalNoValid, MASK_TEXT,
} from '../../app/core/sensitive.js';

const j = (...parts) => parts.join('');

test('C5-1~11: DB 검증과 같은 판정', () => {
  const cases = [
    ['C5-1 일시', '2026-10-06 12:30:45', false],
    ['C5-2 일시 점', '2026.10.06 12:30', false],
    ['C5-3 붙여 쓴 일시', j('20261006', '123045'), false],
    ['C5-4 카드번호 하이픈', j('1234-5678', '-9012-3456'), true],
    ['C5-5 카드번호 공백', j('1234 5678', ' 9012 3456'), true],
    ['C5-6 휴대폰', j('010-1234', '-5678'), true],
    ['C5-7 계좌번호', j('110-123', '-456789'), true],
    ['C5-8 날짜 뒤 계좌번호', j('2026-10-06 110-123', '-456789'), true],
    ['C5-9 금액 콤마', '1,234,567원', false],
    ['C5-10 일반 가맹점', 'GS25 강남2호점', false],
    ['C5-11 날짜 + 금액', '2026-10-06 15000', false],
  ];
  for (const [name, s, want] of cases) assert.equal(hasSensitiveNumber(s), want, name);
});

test('null·빈 값은 false', () => {
  assert.equal(hasSensitiveNumber(null), false);
  assert.equal(hasSensitiveNumber(undefined), false);
  assert.equal(hasSensitiveNumber(''), false);
});

test('붙여 쓴 일시 단계를 끄면 20xx로 시작하는 12자리 숫자도 걸린다', () => {
  const packed = j('202610', '061230');
  assert.equal(hasSensitiveNumber(packed), false);
  assert.equal(hasSensitiveNumber(packed, { packedDateTime: false }), true);
});

test('removeKnownPatterns는 날짜·시각·천 단위 금액만 지운다', () => {
  assert.equal(removeKnownPatterns('2026-10-06 12:30 abc 15,000원').replace(/ +/g, ' ').trim(), 'abc 원');
  const same = removeKnownPatterns('2026-10-06 x', { sameLength: true });
  assert.equal(same.length, '2026-10-06 x'.length);
});

// 설계 문서 v0.17 민감번호 규칙 — 스키마 검증 L1-1~15와 같은 입력·기대값
// (10자리 이상은 실행 중에 이어 붙인다. 구분자를 사이에 끼워 넣는 방식)
const card = (sep) => ['1234', '5678', '9012', '3456'].join(sep);
test('L1-1~10: 새 구분자·정규화로 잡힌다', () => {
  const cases = [
    ['L1-1 쉼표로 끊은 카드번호', card(',')],
    ['L1-2 콜론', card(':')],
    ['L1-3 엔대시 U+2013', card('\u2013')],
    ['L1-4 폭 없는 공백 U+200B', card('\u200B')],
    ['L1-5 별표', card('*')],
    ['L1-6 아랍-인도 숫자 10자', '\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u0660'],
    ['L1-6b 동아랍 숫자 10자', '\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9\u06F0'],
    ['L1-7 빼기 기호 U+2212', ['110', '123', '456789'].join('\u2212')],
    ['L1-7 가운뎃점 U+00B7', ['1234', '5678', '9012'].join('\u00B7')],
    ['L1-7 전각 쉼표', ['1234', '5678', '9012'].join('\uFF0C')],
    ['L1-8 더하기로 이은 전화번호', `+${['82', '10', '1234', '5678'].join('+')}`],
    ['L1-9 쉼표 4자리 묶음 계좌', ['110', '123', '456789'].join(',')],
    ['L1-10 가운데를 가린 6+4 카드번호(설계 판단: 거부)', ['1234', '56**', '****', '7890'].join('-')],
    ['기타 구분자 • ‧ ・ ㆍ', ['1234', '5678', '90'].join('\u2022') + j('\u2027', '1', '\u30FB', '2', '\u318D', '3')],
    ['서식 문자 U+FEFF·U+2066', j('12345', '\uFEFF', '67890', '\u2066')],
  ];
  for (const [name, s] of cases) assert.equal(hasSensitiveNumber(s), true, name);
});

test('L1-11~14: 금액·일시·나열·이미 가린 번호는 오탐 없음', () => {
  const cases = [
    '1,234,567원', '999,999,999', '1,200,000 / 3,400,000', '12,000원, 30,000원',
    '2026-10-06 12:30, 15,000원', '09:00~18:30', '12:30:45',
    '2개 \u00B7 15,000원', '3건 12,000 34,000 56,000', '1+1 행사',
    ['1234', '****', '****', '3456'].join('-'),
  ];
  for (const s of cases) assert.equal(hasSensitiveNumber(s), false, s);
});

test('L1-15: 알려진 오탐(문서화) — 10억 원 이상 금액은 잡힌다', () => {
  assert.equal(hasSensitiveNumber(j('1,234,567', ',890원')), true);
});

test('승인번호 형식 (스키마 검증 M1-1·M1-2)', () => {
  for (const ok of ['12345678', 'AB12CD34', j('1234AB', '567890'), j('A123456789', 'BC')]) {
    assert.equal(approvalNoValid(ok), true, ok);
  }
  for (const bad of [j('12345', '67890'), j('123456', '789012'), j('A12345', '67890'), '123', 'ABCDEFGHIJKLM', '1234-5678', null]) {
    assert.equal(approvalNoValid(bad), false, String(bad));
  }
});

test('maskSensitiveNumbers: 긴 숫자만 가리고 날짜·금액은 남긴다', () => {
  const phone = j('010-1234', '-5678');
  assert.equal(maskSensitiveNumbers(`2026-10-06 12:30 김가짜 ${phone}, 15,000원`),
    `2026-10-06 12:30 김가짜 ${MASK_TEXT}, 15,000원`);
  // 공백은 구분자라 바로 뒤 숫자까지 한 덩어리로 가린다 (DB 판정 단위와 같음)
  assert.equal(maskSensitiveNumbers(`${phone} 15`), MASK_TEXT);
  assert.equal(maskSensitiveNumbers('GS25 강남2호점'), 'GS25 강남2호점');
  assert.equal(hasSensitiveNumber(maskSensitiveNumbers(`메모 ${j('1234 5678', ' 9012 3456')}`)), false);
});

test('마스킹은 검출과 같은 덩어리를 가린다 (날짜를 사이에 둔 숫자)', () => {
  const s = `메모 ${j('12345')} 2026-10-06 ${j('67890')}`;
  assert.equal(hasSensitiveNumber(s), true);
  const masked = maskSensitiveNumbers(s);
  assert.equal(hasSensitiveNumber(masked), false);
  assert.equal(masked, `메모 ${MASK_TEXT}`);
});

test('마스킹도 v0.17 규칙을 따른다: 새 구분자는 가리고 천 단위 금액은 남긴다', () => {
  const masked = maskSensitiveNumbers(`김가짜 ${card(',')} 1,200,000원`);
  assert.equal(masked, `김가짜 ${MASK_TEXT} 1,200,000원`);
  assert.equal(hasSensitiveNumber(masked), false);
  assert.equal(maskSensitiveNumbers(card('\u200B')), MASK_TEXT);
});

test('사용 영역 문자가 있어도 글자를 망가뜨리지 않는다', () => {
  const s = `\uE000\uE0010\uE001 ${j('010-1234', '-5678')}`;
  const masked = maskSensitiveNumbers(s);
  assert.equal(masked, `\uE000\uE0010\uE001 ${MASK_TEXT}`);
  assert.ok(!masked.includes('undefined'));
});
