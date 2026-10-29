// =====================================================================
// 확인 대화상자 (공통 컴포넌트 설계 v0.1 9장)
// - HTML 표준 <dialog> + showModal(). Esc = 취소, 첫 포커스는 취소 버튼
// - 문구: 무엇이 · 몇 건 · 어떻게 바뀌는지 + 되돌릴 수 있는지
// - 글자는 textContent로만 넣는다(innerHTML 금지). 인라인 style 없음(CSP style-src 'self') → 모양은 클래스로
// 의존 없음.
// =====================================================================

let seq = 0;

/**
 * @param {object} o
 * @param {string} o.title       제목 (예: '카테고리 일괄 변경')
 * @param {string} o.message     본문 (예: "거래 12건의 카테고리를 '식비'로 바꿉니다.")
 * @param {string} [o.undoNote]  되돌리기 안내 (예: '일괄 수정 기록에서 되돌릴 수 있어요.'). 없으면 생략
 * @param {string} [o.confirmLabel='확인']
 * @param {string} [o.cancelLabel='취소']
 * @param {boolean} [o.danger=false] 확인 버튼을 위험 동작 모양으로
 * @param {Document} [o.doc=document]
 * @returns {Promise<boolean>} 확인 = true, 취소·Esc = false
 */
export function confirmDialog({
  title, message, undoNote, confirmLabel = '확인', cancelLabel = '취소', danger = false, doc = globalThis.document,
} = {}) {
  if (!doc) return Promise.reject(new TypeError('document가 필요합니다'));
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };

  const dialog = el('dialog', 'confirm-dialog');
  const titleId = `confirm-title-${++seq}`;
  dialog.setAttribute('aria-labelledby', titleId);
  const h = el('h2', 'confirm-title', title ?? '');
  h.id = titleId;
  dialog.append(h, el('p', 'confirm-message', message ?? ''));
  if (undoNote) dialog.append(el('p', 'confirm-undo', undoNote));

  const actions = el('div', 'confirm-actions');
  const cancel = el('button', 'btn btn-secondary', cancelLabel);
  cancel.type = 'button';
  const ok = el('button', danger ? 'btn btn-danger' : 'btn btn-primary', confirmLabel);
  ok.type = 'button';
  actions.append(cancel, ok);
  dialog.append(actions);

  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(result);
    };
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', (e) => { // Esc
      e.preventDefault();
      finish(false);
    });
    dialog.addEventListener('close', () => finish(false));
    doc.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}
