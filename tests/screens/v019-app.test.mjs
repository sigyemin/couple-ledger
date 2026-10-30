// v0.19 앱 후속 (CL-055) — 합성 값만
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAppError } from '../../app/core/errors.js';
import { unlinkConfirmText } from '../../app/screens/refund-model.js';
import { categoryErrorText } from '../../app/screens/categories-model.js';
import { valuesErrorText } from '../../app/screens/detail-edit-model.js';
import { RANGE_TEXT } from '../../app/screens/detail-model.js';

const refund = (o = {}) => ({ occurred_on: '2026-10-03', period_month: '2026-09-01', is_shared: true, is_excluded: false, ...o });

test('연결 끊기 확인 문구: 달이 바뀌는지, 확인한 달 정산, 다시 연결 안내', () => {
  const t = unlinkConfirmText(refund(), new Map([['2026-09-01', 'reviewed']]));
  assert.equal(t.title, '연결 끊기');
  assert.match(t.message, /검토 대기가 되고 미연결 환불 목록에/);
  assert.match(t.message, /9월에서 환불일의 달인 10월로/);
  assert.match(t.message, /9월은 확인을 마친 달이라 정산이 바뀌고/);
  assert.match(t.message, /다시 연결할 수 있어요/);
  const same = unlinkConfirmText(refund({ period_month: '2026-10-01' }), new Map());
  assert.match(same.message, /10월에 그대로 집계돼요/);
  assert.match(same.message, /정산 금액이 바뀔 수 있어요/);
  assert.doesNotMatch(unlinkConfirmText(refund({ is_shared: false }), new Map()).message, /정산/);
});

test('unlink_refund 이미 끊김: hint not_linked가 남는다', () => {
  assert.equal(toAppError({ code: 'LG003', hint: 'not_linked' }).detail.hint, 'not_linked');
});

test('새 오류 문구: 23514(날짜·메모), 카테고리 id LG005', () => {
  const e = (code) => toAppError({ code });
  assert.match(valuesErrorText(e('23514'), { kind: 'expense' }), /2000-01-01부터 오늘에서 1년 뒤까지/);
  assert.match(RANGE_TEXT, /메모는 500자까지/);
  assert.match(categoryErrorText(e('LG005')), /카테고리 번호는 바꿀 수 없어요/);
});
