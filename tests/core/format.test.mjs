import { test } from 'node:test';
import assert from 'node:assert/strict';
import { won, signedWon, month, day, dateTime, ratio, parseDateOnly } from '../../app/core/format.js';

test('won: 천 단위 콤마 + 원, 정수만', () => {
  assert.equal(won(0), '0원');
  assert.equal(won(1234567), '1,234,567원');
  assert.equal(won(-4000), '−4,000원');
  assert.throws(() => won(1.5));
  assert.throws(() => won('1000'));
});

test('signedWon: 0은 부호 없음', () => {
  assert.equal(signedWon(4000), '+4,000원');
  assert.equal(signedWon(-4000), '−4,000원');
  assert.equal(signedWon(0), '0원');
});

test('month·day: 문자열을 나눠 쓴다(시간대 영향 없음)', () => {
  assert.equal(month('2026-10-01'), '2026년 10월');
  assert.equal(day('2026-10-06'), '10월 6일 (화)');
  assert.equal(day('2026-01-01'), '1월 1일 (목)');
  assert.throws(() => day('2026-02-30'));
  assert.throws(() => month('2026-10'));
});

test('parseDateOnly: 실제 있는 날짜만', () => {
  assert.deepEqual(parseDateOnly('2028-02-29'), { y: 2028, m: 2, d: 29 });
  assert.equal(parseDateOnly('2026-02-29'), null);
  assert.equal(parseDateOnly('2026-13-01'), null);
  assert.equal(parseDateOnly(20261006), null);
});

test('dateTime: 서울 시각으로 표시', () => {
  assert.equal(dateTime('2026-10-06T03:30:00Z'), '2026-10-06 12:30');
  assert.equal(dateTime('2026-10-06T15:05:00Z'), '2026-10-07 00:05');
  assert.equal(dateTime(new Date(Date.UTC(2026, 0, 1, 0, 0))), '2026-01-01 09:00');
  assert.throws(() => dateTime('아님'));
});

test('ratio', () => {
  assert.equal(ratio(50), '50%');
  assert.equal(ratio(33.333), '33.33%');
  assert.throws(() => ratio(NaN));
});
