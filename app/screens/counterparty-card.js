// =====================================================================
// 이체 상대 "어떻게 볼까요" 카드 (v0.1 4-2 "새 이체 상대"와 같은 선택지) — 화면 하나에 여러 장 둘 수 있게 독립 부품
// - 이체 상대 편집(v0.2 3-8)에서 쓰고, 업로드 미리보기에서도 같은 부품을 쓰도록 분리(총괄 지시 10-29)
// - 값 ↔ 규칙 변환은 counterparty-model.js(choiceValues·choiceOf)가 한다. 이 부품은 화면 입력만 모은다
// - 보낼 때(direction out)는 '수입'을 고를 수 없다. 카테고리 칸은 일반 지출·수입일 때만 보인다
// 의존: ui/dom.js, screens/counterparty-model.js, screens/detail-model.js
// =====================================================================
import { h } from '../ui/dom.js';
import { CHOICES, choiceOf } from './counterparty-model.js';
import { categoryOptions } from './detail-model.js';

let seq = 0;

/**
 * @param {{ categories, cats(categoryIndex), initial?: 규칙 행, direction?: 'out'|'in'|null, later?: boolean }} o
 *   labelPrefix = 한 화면에 카드가 여러 장일 때 칸 이름 앞에 붙이는 말(예: 상대 이름)
 *   later = 맨 앞에 '나중에'(규칙 만들지 않음 — 업로드 미리보기, v0.1 4-2) 선택지를 두고 기본으로 고른다
 * @returns {{ el, read(): { choice, categoryId, alias }, setDirection(dir), setDisabled(on) }}
 */
export function choiceCard({ categories, cats, initial = null, direction = null, later = false, labelPrefix = '' }, doc = globalThis.document) {
  const name = `cp-choice-${++seq}`;
  const now = initial ? choiceOf(initial, cats) : { key: later ? 'later' : 'expense', label: '' };
  let dir = direction ?? '';
  const options = later ? [{ key: 'later', label: '나중에(검토 대기로)' }, ...CHOICES] : CHOICES;
  const radios = options.map((c) => {
    const r = h('input', { attrs: { type: 'radio', name, value: c.key } }, [], doc);
    r.checked = c.key === now.key;
    return { key: c.key, input: r, label: h('label', { class: 'radio' }, [r, c.label], doc) };
  });
  const pre = labelPrefix ? `${labelPrefix} ` : '';
  const catSel = h('select', { class: 'field', attrs: { 'aria-label': `${pre}카테고리` } }, [], doc);
  const catWrap = h('div', { class: 'form' }, [h('label', { class: 'field-label', text: '카테고리' }, [], doc), catSel], doc);
  const alias = h('input', { class: 'field', attrs: { 'aria-label': `${pre}보일 이름(선택)`, maxlength: '50', placeholder: '예: 집주인' } }, [], doc);
  alias.value = initial?.alias ?? '';
  let catKind = null;
  let disabled = false;

  const picked = () => radios.find((r) => r.input.checked)?.key ?? null;
  const refresh = () => {
    const income = radios.find((r) => r.key === 'income').input;
    income.disabled = disabled || dir === 'out';
    if (dir === 'out' && income.checked) income.checked = false;
    const c = picked();
    const kind = c === 'income' ? 'income' : 'expense';
    if (catKind !== kind) {
      catKind = kind;
      catSel.replaceChildren(
        h('option', { text: '카테고리 고르기', attrs: { value: '' } }, [], doc),
        ...categoryOptions(categories, kind).map((g) => h('optgroup', { attrs: { label: g.group } },
          g.items.map((it) => h('option', { text: it.name, attrs: { value: it.id } }, [], doc)), doc)),
      );
      const cur = initial?.suggested_category_id;
      if (cur && [...catSel.options].some((o) => o.value === cur)) catSel.value = cur;
    }
    catWrap.hidden = !(c === 'expense' || c === 'income');
  };
  const listeners = [];
  for (const r of radios) r.input.addEventListener('change', () => { refresh(); listeners.forEach((fn) => fn()); });
  catSel.addEventListener('change', () => listeners.forEach((fn) => fn()));

  const el = h('div', { class: 'form cp-card' }, [
    h('p', { class: 'field-label', text: '어떻게 볼까요' }, [], doc),
    initial && now.key === 'custom' ? h('p', { class: 'muted small', text: `지금 값: ${now.label}. 고르지 않으면 그대로 둬요.` }, [], doc) : null,
    h('div', { class: 'radio-group', attrs: { role: 'radiogroup', 'aria-label': `${pre}어떻게 볼까요` } }, radios.map((r) => r.label), doc),
    catWrap,
    h('label', { class: 'field-label', text: '보일 이름(선택)' }, [], doc), alias,
  ], doc);
  refresh();

  return {
    el,
    read: () => ({ choice: picked(), categoryId: catSel.value || null, alias: alias.value }),
    setDirection(d) { dir = d ?? ''; refresh(); },
    setDisabled(on) {
      disabled = on;
      for (const x of [...radios.map((r) => r.input), catSel, alias]) x.disabled = on;
      refresh();
    },
    /** 선택·카테고리가 바뀔 때 부를 함수(업로드 미리보기 다시 계산) */
    onChange(fn) { listeners.push(fn); },
    /** 처음 값이 표에 없는 조합이었는지(고르지 않으면 제안 값을 그대로 둔다) */
    isCustom: now.key === 'custom',
  };
}
