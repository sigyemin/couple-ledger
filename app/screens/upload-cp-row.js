// =====================================================================
// 올리기 미리보기 › 새 이체 상대 한 줄 (CL-069 ②, 사용자 지적 10-30 "너무 늘어져 있고 잘 안 보인다")
// - [이름 · 보냄/받음 · 건수 · 금액] + 고르기(기본 '나중에(검토 대기)'). 선택지는 이체 상대 편집과 같은 표(CHOICES)
// - '일반 지출'을 고를 때만 카테고리 고르기가 아래에 나타난다. 수입은 기본 '기타수입'(choiceValues)
// - '보일 이름'은 '이름 바꾸기'를 눌렀을 때만(나중에가 아닐 때)
// - choiceCard와 같은 모양으로 읽는다: read() → { choice, categoryId, alias }, onChange, setDisabled
// - 이름(이체 상대 원문)은 화면에만 — 글자는 textContent로만
// 의존: ui/dom.js, screens/counterparty-model.js(CHOICES), screens/category-picker.js
// =====================================================================
import { h } from '../ui/dom.js';
import { CHOICES } from './counterparty-model.js';
import { categoryPicker } from './category-picker.js';

export const LATER = Object.freeze({ key: 'later', label: '나중에(검토 대기)' });

/**
 * @param {{ g: { text, direction, count, totalText, ruleAllowed, variantCount }, categories }} o
 * @returns {{ el, read(), onChange(fn), onAliasChange(fn), setDisabled(on), readonly choice: string }}
 */
export function cpRow({ g, categories }, doc = globalThis.document) {
  const out = g.direction === 'out';
  const select = h('select', { class: 'field cp-select', attrs: { 'aria-label': `${g.text} 어떻게 볼까요` } }, [
    h('option', { text: LATER.label, attrs: { value: LATER.key } }, [], doc),
    ...CHOICES.map((c) => h('option', { text: c.label, attrs: { value: c.key, disabled: !g.ruleAllowed || (c.key === 'income' && out) ? true : null } }, [], doc)),
  ], doc);
  select.value = LATER.key;
  const cat = categoryPicker({ categories, kind: 'expense', label: `${g.text} 카테고리`, doc });
  const catBox = h('div', { class: 'cp-row-cat' }, [cat], doc);
  const alias = h('input', { class: 'field', attrs: { 'aria-label': `${g.text} 보일 이름(선택)`, maxlength: '50', placeholder: '보일 이름(예: 집주인)' } }, [], doc);
  const aliasBox = h('div', { class: 'cp-row-alias' }, [alias], doc);
  const rename = h('button', { class: 'btn mini', text: '이름 바꾸기', attrs: { type: 'button', 'aria-expanded': 'false', 'aria-label': `${g.text} 보일 이름 바꾸기` } }, [], doc);
  rename.addEventListener('click', () => {
    aliasBox.hidden = !aliasBox.hidden;
    rename.setAttribute('aria-expanded', String(!aliasBox.hidden));
    if (!aliasBox.hidden) alias.focus();
  });
  aliasBox.hidden = true;

  const refresh = () => {
    const c = select.value;
    catBox.hidden = c !== 'expense';
    rename.hidden = c === LATER.key;
    if (c === LATER.key) aliasBox.hidden = true;
  };
  const listeners = [];
  const fire = () => listeners.forEach((fn) => fn());
  select.addEventListener('change', () => { refresh(); fire(); });
  cat.addEventListener('change', fire);
  // 보일 이름은 미리보기 숫자와 상관없어 다시 정규화하지 않는다(그러면 입력 직후 저장 첫 클릭이 잠긴 버튼에 버려짐 — #59 재리뷰).
  // 값 검사만 다시(aliasListeners). 저장 때는 saveAll이 카드 값을 다시 읽는다
  const aliasListeners = [];
  alias.addEventListener('change', () => aliasListeners.forEach((fn) => fn()));

  const meta = `${out ? '보냄' : '받음'} · ${g.count}건 · ${g.totalText}`;
  const el = h('div', { class: 'cp-row' }, [
    h('div', { class: 'cp-row-line' }, [
      h('span', { class: 'cp-row-name' }, [h('strong', { text: g.text }, [], doc), h('span', { class: 'cp-row-meta', text: meta }, [], doc)], doc),
      select,
    ], doc),
    catBox,
    h('div', { class: 'cp-row-tools' }, [
      rename,
      g.ruleAllowed ? null : h('span', { class: 'cp-row-note', text: '이름이 너무 짧아 규칙 없이 검토 대기로 들어가요.' }, [], doc),
      g.variantCount > 1 ? h('span', { class: 'cp-row-note', text: `숫자를 가려 같아진 설명 ${g.variantCount}개에 함께 적용돼요.` }, [], doc) : null,
    ], doc),
    aliasBox,
  ], doc);
  refresh();

  return {
    el,
    // 카테고리는 '일반 지출'일 때만(다른 것으로 바꾸면 숨은 지출 카테고리가 남지 않게)
    read: () => ({ choice: select.value, categoryId: select.value === 'expense' ? (cat.value || null) : null, alias: aliasBox.hidden ? '' : alias.value }),
    onChange(fn) { listeners.push(fn); },
    /** 보일 이름이 바뀔 때(다시 정규화하지 않고 값 검사만) */
    onAliasChange(fn) { aliasListeners.push(fn); },
    setDisabled(on) { select.disabled = !!on; cat.setDisabled(on); alias.disabled = !!on; rename.disabled = !!on; },
    get choice() { return select.value; },
  };
}
