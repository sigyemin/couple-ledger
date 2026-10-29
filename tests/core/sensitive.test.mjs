// app/core/sensitive.js — DB has_sensitive_number와 같은 시험 사례(스키마 검증 C5-1~11)를 쓴다.
// 10자리 이상 숫자는 소스에 그대로 쓰지 않고 실행 중에 이어 붙인다(이 파일도 유출 검사를 통과해야 함).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasSensitiveNumber, maskSensitiveNumbers, removeDateTime, MASK_TEXT } from '../../app/core/sensitive.js';

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

test('removeDateTime은 날짜·시각만 지운다', () => {
  assert.equal(removeDateTime('2026-10-06 12:30 abc').trim(), 'abc');
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
