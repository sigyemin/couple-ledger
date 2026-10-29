import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmDialog } from '../../app/core/confirm.js';

// 최소한의 DOM 흉내. innerHTML은 쓰면 바로 실패하게 만든다
function fakeDoc() {
  let focused = null;
  const make = (tag) => {
    const listeners = {};
    const n = {
      tagName: tag.toUpperCase(), children: [], attrs: {}, className: '', id: '', type: '', open: false, removed: false,
      _text: '',
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set textContent(v) { this._text = v; },
      set innerHTML(_) { throw new Error('innerHTML 사용 금지'); },
      append(...c) { this.children.push(...c); },
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(t, f) { (listeners[t] ??= []).push(f); },
      dispatch(t) {
        const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        (listeners[t] ?? []).forEach((f) => f(ev));
        return ev;
      },
      click() { this.dispatch('click'); },
      focus() { focused = n; },
      showModal() { this.open = true; },
      close() { this.open = false; this.dispatch('close'); },
      remove() { this.removed = true; },
    };
    return n;
  };
  const body = make('body');
  return { doc: { createElement: make, body }, body, focused: () => focused };
}

const find = (n, pred) => (pred(n) ? n : n.children.map((c) => find(c, pred)).find(Boolean));

function open(opts = {}) {
  const f = fakeDoc();
  const p = confirmDialog({
    title: '카테고리 일괄 변경',
    message: "거래 12건의 카테고리를 '식비'로 바꿉니다.",
    undoNote: '일괄 수정 기록에서 되돌릴 수 있어요.',
    doc: f.doc,
    ...opts,
  });
  const dialog = f.body.children[0];
  const buttons = find(dialog, (n) => n.className === 'confirm-actions').children;
  return { f, p, dialog, cancel: buttons[0], ok: buttons[1] };
}

test('구조·문구·첫 포커스(취소)', () => {
  const { f, dialog, cancel, ok } = open({ danger: true, confirmLabel: '적용' });
  assert.equal(dialog.tagName, 'DIALOG');
  assert.equal(dialog.open, true);
  assert.equal(f.focused(), cancel);
  assert.equal(cancel.textContent, '취소');
  assert.equal(ok.textContent, '적용');
  assert.equal(ok.className, 'btn btn-danger');
  assert.equal(cancel.type, 'button');
  assert.ok(dialog.textContent.includes("거래 12건의 카테고리를 '식비'로 바꿉니다."));
  assert.ok(dialog.textContent.includes('되돌릴 수 있어요'));
  const h = find(dialog, (n) => n.tagName === 'H2');
  assert.equal(dialog.attrs['aria-labelledby'], h.id);
});

test('확인 = true, 닫히고 제거됨', async () => {
  const { p, dialog, ok } = open();
  ok.click();
  assert.equal(await p, true);
  assert.equal(dialog.open, false);
  assert.equal(dialog.removed, true);
});

test('취소 = false', async () => {
  const { p, cancel } = open();
  cancel.click();
  assert.equal(await p, false);
});

test('Esc(cancel 이벤트) = false', async () => {
  const { p, dialog } = open();
  const ev = dialog.dispatch('cancel');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(await p, false);
});

test('HTML 같은 문구도 글자 그대로 넣는다', async () => {
  const { p, dialog, cancel } = open({ message: '<img src=x onerror=alert(1)>' });
  assert.ok(find(dialog, (n) => n.className === 'confirm-message')._text === '<img src=x onerror=alert(1)>');
  cancel.click();
  await p;
});

test('되돌리기 안내가 없으면 문단을 만들지 않는다', async () => {
  const { p, dialog, cancel } = open({ undoNote: undefined });
  assert.equal(find(dialog, (n) => n.className === 'confirm-undo'), undefined);
  cancel.click();
  await p;
});
