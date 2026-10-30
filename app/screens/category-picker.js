// =====================================================================
// 카테고리 고르기 부품 (CL-060): <select> 대신 쓰는 버튼 + 대화상자
// - 버튼에 지금 고른 '대분류 > 소분류'. 누르면 <dialog>(showModal): 위에 검색칸, 최근 쓴 것, 대분류 목록(누르면 그 아래 소분류 펼침)
// - <select>처럼 쓴다: el.value(읽기·쓰기, 고를 수 없는 id는 ''), el.selectedName(소분류 이름), 고르면 el에 'change' 이벤트,
//   el.setKind(kind), el.setDisabled(on), el.open(focusBack) — 다른 요소(예: 거래 상세의 카테고리 줄)에서 대화상자를 열 때.
//   닫히면 focusBack(없으면 부품 버튼)으로 초점을 돌린다
// - 키보드: Tab으로 이동, Enter·Space로 고르기, Esc로 닫기(고르지 않음). 대분류 버튼은 aria-expanded, 고른 항목은 aria-current
// - 글자는 textContent로만(innerHTML 금지). 최근 목록은 이 기기 저장소(키 접두 cl- — 로그아웃 때 지워짐), 실패해도 동작
// 의존: ui/dom.js, config.js(APP_STORAGE_PREFIX), screens/category-pick-model.js
// =====================================================================
import { h } from '../ui/dom.js';
import { APP_STORAGE_PREFIX } from '../config.js';
import { pickGroups, searchCategories, labelOf, recentItems, pushRecent } from './category-pick-model.js';

const RECENT_KEY = `${APP_STORAGE_PREFIX}recent-categories`;
let seq = 0;

function readRecent(storage) {
  try {
    const v = JSON.parse(storage?.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeRecent(storage, ids) {
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(ids));
  } catch { /* 저장 못 해도 고르기는 된다 */ }
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {object} o
 * @param {object[]} o.categories categories 행 { id, parent_id, name, code, sort_order, is_active }
 * @param {string} [o.kind='expense'] 거래 종류(수입이면 수입 그룹만)
 * @param {string} [o.value=''] 처음 고른 id
 * @param {string} [o.label='카테고리'] 대화상자 제목·버튼 이름
 * @param {string|null} [o.emptyLabel] 값 없음도 고를 수 있으면 그 이름(예: '미분류로 두기')
 * @param {string} [o.placeholder='카테고리 고르기']
 * @param {{ id, name, items: {id, name, label}[] }[]} [o.extra] 목록 맨 앞에 더할 묶음(예: 규칙의 '지금 값' — 꺼진 카테고리도 그대로 둘 수 있게)
 * @returns {HTMLElement & { value: string, readonly selectedName: string, setKind(kind): void, setDisabled(on): void, open(focusBack?): void }}
 */
export function categoryPicker({
  categories, kind = 'expense', value = '', label = '카테고리', emptyLabel = null, placeholder = '카테고리 고르기',
  extra = [], storage = defaultStorage(), doc = globalThis.document,
} = {}) {
  let groups = [...extra, ...pickGroups(categories, kind)];
  let current = labelOf(groups, value) ? value : '';
  const id = `cat-pick-${++seq}`;
  let focusBack = null; // el.open(focusBack)로 열었을 때 닫힌 뒤 초점 둘 곳

  const text = () => (current ? labelOf(groups, current) : (emptyLabel ?? placeholder));
  const trigger = h('button', {
    class: 'field cat-pick-btn', text: text(),
    attrs: { type: 'button', 'aria-haspopup': 'dialog', 'aria-label': `${label}: ${text()}` },
  }, [], doc);
  const el = h('div', { class: 'cat-pick' }, [trigger], doc);
  const refresh = () => {
    trigger.textContent = text();
    trigger.setAttribute('aria-label', `${label}: ${text()}`);
    trigger.classList.toggle('empty', !current);
  };
  refresh();

  const fire = () => {
    const E = doc.defaultView?.Event ?? globalThis.Event;
    el.dispatchEvent(new E('change', { bubbles: true }));
  };

  function open() {
    const dialog = h('dialog', { class: 'cat-dialog', attrs: { 'aria-labelledby': `${id}-t` } }, [], doc);
    const title = h('h2', { class: 'confirm-title', text: label, attrs: { id: `${id}-t` } }, [], doc);
    const search = h('input', { class: 'field', attrs: { type: 'search', 'aria-label': `${label} 검색`, placeholder: '이름으로 찾기 (예: 외식)', autocomplete: 'off', 'aria-controls': `${id}-list` } }, [], doc);
    const list = h('div', { class: 'cat-list', attrs: { id: `${id}-list`, 'aria-live': 'polite' } }, [], doc);
    const close = h('button', { class: 'btn secondary', text: '닫기', attrs: { type: 'button' } }, [], doc);
    dialog.append(title, search, list, h('div', { class: 'confirm-actions' }, [close], doc));

    let done = false;
    const finish = (pickedId) => {
      if (done) return;
      done = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      if (pickedId !== undefined && pickedId !== current) {
        current = pickedId;
        if (pickedId) writeRecent(storage, pushRecent(readRecent(storage), pickedId));
        refresh();
        fire();
      }
      const back = focusBack ?? trigger;
      focusBack = null;
      back.focus();
    };
    const itemBtn = (it, text = it.label) => h('button', {
      class: it.id === current ? 'cat-item on' : 'cat-item', text,
      attrs: { type: 'button', 'aria-current': it.id === current ? 'true' : null },
      on: { click: () => finish(it.id) },
    }, [], doc);
    const openGroups = new Set(groups.filter((g) => g.items.some((it) => it.id === current)).map((g) => g.id));

    const draw = () => {
      const q = search.value;
      const kids = [];
      if (q.trim()) {
        const found = searchCategories(groups, q);
        kids.push(found.length
          ? h('ul', { class: 'cat-items', attrs: { 'aria-label': `찾은 카테고리 ${found.length}개` } }, found.map((it) => h('li', {}, [itemBtn(it)], doc)), doc)
          : h('p', { class: 'muted', text: '맞는 카테고리가 없어요' }, [], doc));
      } else {
        if (emptyLabel) {
          kids.push(h('button', {
            class: current ? 'cat-item' : 'cat-item on', text: emptyLabel,
            attrs: { type: 'button', 'aria-current': current ? null : 'true' }, on: { click: () => finish('') },
          }, [], doc));
        }
        const recent = recentItems(readRecent(storage), groups);
        if (recent.length) {
          kids.push(h('p', { class: 'section-title', text: '최근 쓴 것' }, [], doc));
          kids.push(h('ul', { class: 'cat-items' }, recent.map((it) => h('li', {}, [itemBtn(it)], doc)), doc));
        }
        kids.push(h('p', { class: 'section-title', text: '전체' }, [], doc));
        kids.push(h('ul', { class: 'cat-groups' }, groups.map((g) => {
          const isOpen = openGroups.has(g.id);
          const sub = `${id}-g-${g.id}`;
          const head = h('button', {
            class: 'cat-group-btn', text: `${g.name} (${g.items.length})`,
            attrs: { type: 'button', 'aria-expanded': isOpen ? 'true' : 'false', 'aria-controls': sub },
            on: {
              click: () => {
                if (openGroups.has(g.id)) openGroups.delete(g.id); else openGroups.add(g.id);
                draw();
                list.querySelector(`[aria-controls="${sub}"]`)?.focus();
              },
            },
          }, [], doc);
          return h('li', {}, [
            head,
            isOpen ? h('ul', { class: 'cat-items sub', attrs: { id: sub } }, g.items.map((it) => h('li', {}, [itemBtn(it, it.name)], doc)), doc) : null,
          ], doc);
        }), doc));
        if (!groups.length) kids.push(h('p', { class: 'muted', text: '고를 수 있는 카테고리가 없어요. 카테고리 관리에서 만들어 주세요.' }, [], doc));
      }
      list.replaceChildren(...kids);
    };
    search.addEventListener('input', draw);
    close.addEventListener('click', () => finish(undefined));
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(undefined); });
    dialog.addEventListener('close', () => finish(undefined));
    draw();
    doc.body.append(dialog);
    dialog.showModal();
    search.focus();
  }
  trigger.addEventListener('click', open);

  Object.defineProperty(el, 'value', {
    get: () => current,
    set: (v) => {
      current = labelOf(groups, v) ? v : '';
      refresh();
    },
  });
  Object.defineProperty(el, 'selectedName', {
    get: () => groups.flatMap((g) => g.items).find((it) => it.id === current)?.name ?? '',
  });
  el.setKind = (k) => {
    groups = [...extra, ...pickGroups(categories, k)];
    if (!labelOf(groups, current)) current = '';
    refresh();
  };
  el.setDisabled = (on) => { trigger.disabled = !!on; };
  el.open = (back = null) => { if (trigger.disabled) return; focusBack = back; open(); };
  return el;
}
