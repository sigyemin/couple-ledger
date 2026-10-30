// =====================================================================
// 카테고리 관리 (화면 설계 v0.2 3-9, 시안 18 → CL-064 다듬기, 사용자 요청 10-30)
//   위에 '추가' 버튼 하나 → 대화상자(대카테고리 고르기 + 이름). 줄은 모두 같은 모양: [끌기 손잡이] 이름 꼬리표 … [↑][↓][⋯]
//   ⋯ 메뉴(대화상자): 이름 바꾸기 · 끄기/켜기 · 다른 그룹으로 · 연말정산 기본값 · 지우기(기본 항목은 옮기기·지우기를 이유와 함께 막음)
//   순서: ↑↓(키보드) + 끌어 놓기(pointer events — 마우스·터치). 끄는 동안 줄이 놓일 자리로 실제로 옮겨져 미리 보이고(다른 줄이 밀려남),
//   놓으면 저장. 같은 그룹 안 순서, 대분류끼리 순서, 사용자가 만든 항목은 다른 그룹(같은 쪽)으로도. 기본 항목을 다른 그룹 위로
//   끌면 그 자리에 '기본 카테고리는 다른 그룹으로 옮길 수 없어요'를 보이고 놓아도 저장하지 않는다(원래 자리로)
//   터치: 손잡이(⠿)는 바로 끌기, 이름 영역은 잠깐 누른 뒤 끌기(그냥 밀면 화면 스크롤)
// 조회: categories / 끄기 전: 켜진 category_rules(category_id)·counterparty_rules(suggested_category_id) 수
// 쓰기: categories insert(부모·이름·순서) · update(이름·순서·켜짐·부모·연말정산 기본값) · delete(사용자가 만든 것만, 쓰는 곳 있으면 DB 거부)
// - 연말정산 기본값(CL-062 ② E4): default_deduction_kind · tax_credit_kind
// - 여러 행을 바꾸는 일(순서 다시 매기기·그룹 끄기)은 한 건씩 update → 저장 중 잠금, 중간 실패면 멈추고 다시 읽음(앞쪽은 이미 저장됐을 수 있음)
// 의존: ui/dom.js, router.js, core/confirm.js, core/errors.js, screens/categories-model.js, screens/deduction-edit-model.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { buildHash } from '../router.js';
import { confirmDialog } from '../core/confirm.js';
import { STAGES } from '../core/errors.js';
import {
  categoryTree, checkName, moveUpdates, offTargets, offConfirmText, moveGroupText, deleteErrorText, nameErrorText, categoryErrorText,
  dropPlan, addPlan, menuActions, nextSortOrder, NEW_GROUP, BASIC_MOVE_TEXT,
} from './categories-model.js';
import { CATEGORY_KINDS, TAX_CREDIT_KINDS, categoryDeductionPatch, categoryDeductionTag } from './deduction-edit-model.js';
import { errorView, rulesTabs } from './shell.js';

let catNotice = null;
let dialogSeq = 0;
const HOLD_MS = 250;
const MOVE_PX = 6;

/**
 * 입력 대화상자(<dialog>): 제목·본문·오류 줄·[취소][저장]. onSave가 { ok:false, message }면 닫지 않고 오류를 보인다
 * ref.close() 로 밖에서 닫을 수 있다(⋯ 메뉴에서 다른 대화상자로 넘어갈 때)
 * @returns {Promise<boolean>} 저장했으면 true
 */
function formDialog({ title, body, saveLabel = '저장', onSave = null, ref = {}, doc }) {
  const id = `cat-form-${++dialogSeq}`;
  const err = h('p', { class: 'status-line error', attrs: { role: 'alert', hidden: true } }, [], doc);
  const cancel = h('button', { class: 'btn secondary', text: onSave ? '취소' : '닫기', attrs: { type: 'button' } }, [], doc);
  const save = onSave ? h('button', { class: 'btn primary', text: saveLabel, attrs: { type: 'button' } }, [], doc) : null;
  const dialog = h('dialog', { class: 'cat-dialog form', attrs: { 'aria-labelledby': `${id}-t` } }, [
    h('h2', { class: 'confirm-title', text: title, attrs: { id: `${id}-t` } }, [], doc),
    ...body.filter(Boolean), err,
    h('div', { class: 'confirm-actions' }, [cancel, save].filter(Boolean), doc),
  ], doc);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (v) => {
      if (finished) return;
      finished = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(v);
    };
    ref.close = () => finish(false);
    cancel.addEventListener('click', () => finish(false));
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });
    save?.addEventListener('click', async () => {
      save.disabled = true;
      const r = await onSave();
      save.disabled = false;
      if (r?.ok === false) { err.textContent = r.message; err.hidden = false; return; }
      finish(true);
    });
    doc.body.append(dialog);
    dialog.showModal();
    (dialog.querySelector('input, select, button:not([disabled])') ?? cancel).focus();
  });
}

/**
 * @param {{ db, reload(), isCurrent(), onError(err, extra) → string }} ctx
 */
export async function renderCategories({ db, reload, isCurrent, onError }, doc = globalThis.document) {
  const r = await db.select('categories', { columns: 'id,parent_id,name,code,sort_order,is_active,default_deduction_kind,tax_credit_kind' });
  if (!isCurrent()) return null;
  const head = h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav' }, [
      h('a', { class: 'icon-btn', text: '‹', attrs: { href: buildHash('more'), 'aria-label': '더보기로' } }, [], doc),
      h('h1', { class: 'title', text: '규칙·카테고리' }, [], doc),
    ], doc),
  ], doc);
  const tabs = rulesTabs('categories', doc);
  if (r.error) {
    onError?.(r.error);
    return h('main', { class: 'screen' }, [head, tabs, errorView(r.error.message, r.error.detail?.sqlState ?? r.error.code, doc)], doc);
  }
  const rows = r.data ?? [];
  const tree = categoryTree(rows);
  const groupName = new Map([...tree.expense, ...tree.income].map((g) => [g.id, g.name]));
  const siblingsOf = (parentId) => rows.filter((c) => (c.parent_id ?? null) === parentId);

  const status = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  const say = (msg, isError = false) => {
    status.textContent = msg;
    status.className = `status-line${isError ? ' error' : ''}`;
  };
  if (catNotice) { say(catNotice.text, catNotice.isError); catNotice = null; }
  const done = (text) => { catNotice = { text, isError: false }; reload(); };
  const failed = (err, special = categoryErrorText(err)) => {
    const code = onError?.(err, { stage: STAGES.db_update });
    say(special ?? `${err.message}${code ? ` (오류 번호 ${code})` : ''}`, true);
  };
  let main = null;
  const busy = (on) => {
    for (const el of main.querySelectorAll('button, input, select')) el.disabled = on;
    main.classList.toggle('saving', on);
  };
  const btn = (text, label, onClick, cls = 'mini') => h('button', { class: `btn ${cls}`, text, attrs: { type: 'button', 'aria-label': label }, on: { click: onClick } }, [], doc);

  /** 여러 행 update를 차례로(저장 중 잠금). 실패하면 멈추고 다시 읽는다(앞서 저장된 줄은 그대로 남을 수 있음) */
  const updateMany = async (updates, okText) => {
    if (!updates.length) { reload(); return; }
    busy(true);
    for (const u of updates) {
      const { id, ...patch } = u;
      const res = await db.update('categories', id, patch);
      if (res.error || !res.data?.length) {
        busy(false);
        if (res.error) failed(res.error, nameErrorText(res.error));
        else say('저장하지 못했어요. 새로고침해 주세요.', true);
        catNotice = { text: `${status.textContent} 일부만 저장됐을 수 있어요. 다시 읽었어요.`, isError: true };
        reload();
        return;
      }
    }
    done(okText);
  };

  // ---------------------------------------------------------------- 추가 · 이름 바꾸기 (대화상자)
  const label = (text) => h('span', { class: 'field-label', text }, [], doc);
  const nameInput = (aria, value = '') => {
    const el = h('input', { class: 'field', attrs: { 'aria-label': aria, maxlength: '20', placeholder: '이름', autocomplete: 'off' } }, [], doc);
    el.value = value;
    return el;
  };
  const openAdd = () => {
    const group = h('select', { class: 'field', attrs: { 'aria-label': '대카테고리' } }, [
      h('option', { text: '대카테고리 고르기', attrs: { value: '' } }, [], doc),
      h('optgroup', { attrs: { label: '지출' } }, tree.expense.map((g) => h('option', { text: g.name, attrs: { value: g.id } }, [], doc)), doc),
      h('optgroup', { attrs: { label: '수입' } }, tree.income.map((g) => h('option', { text: g.name, attrs: { value: g.id } }, [], doc)), doc),
      h('option', { text: '+ 새 대분류로 만들기(지출)', attrs: { value: NEW_GROUP } }, [], doc),
    ], doc);
    const name = nameInput('이름');
    return formDialog({
      title: '카테고리 추가', saveLabel: '추가', doc,
      body: [label('대카테고리'), group, label('이름'), name],
      onSave: async () => {
        const p = addPlan(rows, tree, { groupId: group.value, name: name.value });
        if (!p.ok) return p;
        const res = await db.insert('categories', p.row);
        if (res.error) return { ok: false, message: nameErrorText(res.error) ?? res.error.message };
        done(`'${p.row.name}'을(를) ${p.place}에 더했어요.`);
        return { ok: true };
      },
    });
  };
  const openRename = (node) => {
    const name = nameInput(`${node.name} 새 이름`, node.name);
    return formDialog({
      title: '이름 바꾸기', doc, body: [name],
      onSave: async () => {
        const v = checkName(name.value, siblingsOf(node.parentId), node.id);
        if (!v.ok) return { ok: false, message: v.message };
        if (v.value === node.name) return { ok: true };
        const res = await db.update('categories', node.id, { name: v.value });
        if (res.error) return { ok: false, message: nameErrorText(res.error) ?? res.error.message };
        done(`이름을 '${v.value}'(으)로 바꿨어요.`);
        return { ok: true };
      },
    });
  };

  // ---------------------------------------------------------------- 끄기 · 지우기 · 옮기기 · 연말정산 기본값
  const toggle = async (node) => {
    if (!node.isActive) { await updateMany([{ id: node.id, is_active: true }], `'${node.name}'을(를) 켰어요.`); return; }
    const ids = offTargets(node);
    const [rules, cps] = await Promise.all([
      db.select('category_rules', { columns: 'id', filters: [{ col: 'category_id', op: 'in', value: ids }, { col: 'is_active', op: 'eq', value: true }] }),
      db.select('counterparty_rules', { columns: 'id', filters: [{ col: 'suggested_category_id', op: 'in', value: ids }] }),
    ]);
    const err = rules.error ?? cps.error;
    if (err) { failed(err); return; }
    const t = offConfirmText(node, rules.data?.length ?? 0, cps.data?.length ?? 0);
    if (!(await confirmDialog({ ...t, confirmLabel: '끄기', doc }))) return;
    await updateMany(ids.map((id) => ({ id, is_active: false })), `'${node.name}'을(를) 껐어요.`);
  };
  const remove = async (node) => {
    if (!(await confirmDialog({ title: `'${node.name}' 지우기`, message: '사용자가 만든 카테고리를 지워요. 쓰는 거래·규칙이 있으면 지울 수 없고 끌 수만 있어요.', confirmLabel: '지우기', danger: true, doc }))) return;
    busy(true);
    const res = await db.delete('categories', node.id);
    busy(false);
    if (res.error) { failed(res.error, deleteErrorText(res.error)); return; }
    if (!res.data?.length) { say('지우지 못했어요. 새로고침해 주세요.', true); return; }
    done(`'${node.name}'을(를) 지웠어요.`);
  };
  const moveTo = async (node, groupId) => {
    const name = groupName.get(groupId);
    if (!name) return;
    if (!(await confirmDialog({ ...moveGroupText(node, name), confirmLabel: '옮기기', doc }))) return;
    if (checkName(node.name, siblingsOf(groupId)).ok === false) { say(`'${name}'에 같은 이름이 있어 옮길 수 없어요`, true); return; }
    await updateMany([{ id: node.id, parent_id: groupId, sort_order: nextSortOrder(siblingsOf(groupId)) }], `'${node.name}'을(를) '${name}'(으)로 옮겼어요.`);
  };
  const openDeduction = (node) => {
    const cat = rows.find((c) => c.id === node.id) ?? {};
    const sel = (aria, opts, value) => {
      const el = h('select', { class: 'field', attrs: { 'aria-label': `${node.name} ${aria}` } }, [
        h('option', { text: '없음', attrs: { value: '' } }, [], doc),
        ...opts.map(([k, t]) => h('option', { text: t, attrs: { value: k } }, [], doc)),
      ], doc);
      el.value = value ?? '';
      return el;
    };
    const d = sel('카드 공제 기본 항목', CATEGORY_KINDS, cat.default_deduction_kind);
    const t = sel('공제 표시', TAX_CREDIT_KINDS, cat.tax_credit_kind);
    return formDialog({
      title: `'${node.name}' 연말정산 기본값`, doc,
      body: [label('카드로 냈을 때 공제 항목'), d, label('공제 표시(의료비·월세·보험료·전세자금대출)'), t, h('p', { class: 'muted small', text: '거래에서 직접 고친 값은 그대로예요.' }, [], doc)],
      onSave: async () => {
        const patch = categoryDeductionPatch(cat, { defaultKind: d.value, taxCredit: t.value });
        if (!patch) return { ok: true };
        const res = await db.update('categories', node.id, patch);
        if (res.error) return { ok: false, message: categoryErrorText(res.error) ?? res.error.message };
        done(`'${node.name}' 연말정산 기본값을 바꿨어요.`);
        return { ok: true };
      },
    });
  };
  /** ⋯ 메뉴: 할 수 없는 일은 막고 이유를 보인다 */
  const openMenu = (node) => {
    const a = menuActions(node, tree);
    const ref = {};
    const act = (text, aria, fn, ok = true, reason = null) => h('div', { class: 'cat-menu-item' }, [
      h('button', {
        class: 'btn secondary', text, attrs: { type: 'button', 'aria-label': aria, disabled: ok ? null : true },
        on: { click: () => { ref.close?.(); fn(); } },
      }, [], doc),
      reason ? h('span', { class: 'muted small', text: reason }, [], doc) : null,
    ], doc);
    const moveSel = a.move.ok ? h('select', { class: 'field', attrs: { 'aria-label': `${node.name} 옮길 그룹` } }, [
      h('option', { text: '옮길 그룹 고르기', attrs: { value: '' } }, [], doc),
      ...a.move.targets.map((g) => h('option', { text: g.name, attrs: { value: g.id } }, [], doc)),
    ], doc) : null;
    moveSel?.addEventListener('change', () => { if (moveSel.value) { const v = moveSel.value; ref.close?.(); moveTo(node, v); } });
    return formDialog({
      title: node.name, ref, doc,
      body: [
        act('이름 바꾸기', `${node.name} 이름 바꾸기`, () => openRename(node)),
        act(a.toggle.label, `${node.name} ${a.toggle.label}`, () => toggle(node)),
        h('div', { class: 'cat-menu-item' }, [label('다른 그룹으로'), moveSel ?? h('span', { class: 'muted small', text: a.move.reason }, [], doc)], doc),
        act('연말정산 기본값', `${node.name} 연말정산 기본값`, () => openDeduction(node)),
        act('지우기', `${node.name} 지우기`, () => remove(node), a.remove.ok, a.remove.ok ? null : a.remove.reason),
      ],
    });
  };

  // ---------------------------------------------------------------- 끌어 놓기
  // 끄는 동안 그 줄(항목 li 또는 그룹 카드)을 놓일 자리로 실제로 옮겨 미리 보인다. 놓으면 dropPlan → 저장
  let drag = null;
  const listKids = (list) => [...list.children].filter((c) => !c.classList.contains('cat-drop-note'));
  function cancelDrag(restore) {
    if (!drag) return;
    clearTimeout(drag.timer);
    drag.unlisten?.();
    drag.note?.remove();
    drag.el.classList.remove('dragging', 'bad');
    if (restore && drag.started) drag.origin.parent.insertBefore(drag.el, drag.origin.next);
    drag = null;
  }
  function dragOver(x, y) {
    const isGroup = drag.node.parentId == null;
    const under = doc.elementFromPoint(x, y);
    const list = isGroup
      ? under?.closest?.(`[data-groups="${drag.origin.parent.dataset.groups}"]`)
      : under?.closest?.('.cat-group')?.querySelector('ul.cat-items');
    if (!list) return;
    const others = listKids(list).filter((c) => c !== drag.el);
    const before = others.find((c) => { const b = c.getBoundingClientRect(); return y < b.top + b.height / 2; }) ?? null;
    if (before) list.insertBefore(drag.el, before); else list.append(drag.el);
    const groupId = isGroup ? null : list.closest('.cat-group')?.dataset.groupId;
    const plan = isGroup ? { ok: true } : dropPlan(rows, tree, drag.node, { groupId, index: 0 });
    drag.el.classList.toggle('bad', !plan.ok);
    drag.note?.remove();
    drag.note = null;
    if (!plan.ok) {
      drag.note = h('li', { class: 'cat-drop-note', text: plan.message ?? BASIC_MOVE_TEXT, attrs: { role: 'alert' } }, [], doc);
      drag.el.after(drag.note);
    }
  }
  async function dropHere() {
    const d = drag;
    if (!d.started) { cancelDrag(false); return; }
    const isGroup = d.node.parentId == null;
    const list = d.el.parentElement;
    const index = listKids(list).indexOf(d.el); // 자기 앞에 있는 줄 수 = 자기를 뺀 목록에서의 자리
    const groupId = isGroup ? null : list.closest('.cat-group')?.dataset.groupId;
    const plan = dropPlan(rows, tree, d.node, { groupId, index });
    cancelDrag(false);
    if (!plan.ok) { catNotice = { text: plan.message, isError: true }; reload(); return; } // 원래 자리로
    if (!plan.updates.length) { say(''); return; }
    const moved = groupId && groupId !== d.node.parentId ? groupName.get(groupId) : null;
    await updateMany(plan.updates, moved ? `'${d.node.name}'을(를) '${moved}'(으)로 옮겼어요.` : '순서를 바꿨어요.');
  }
  // 끄는 동안의 움직임·놓기는 문서에서 듣는다(줄을 다른 목록으로 옮기면 그 요소의 포인터 붙잡기가 풀리므로)
  function onMove(e) {
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (gone()) { cancelDrag(false); return; }
    if (e.pointerType === 'mouse' && e.buttons === 0) { onCancel(); return; } // 버튼을 뗐는데 pointerup이 안 옴
    if (!drag.started) {
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < MOVE_PX) return;
      if (!drag.ready) { cancelDrag(false); return; } // 터치로 바로 밀면 화면 스크롤
      drag.started = true;
      drag.el.classList.add('dragging');
      say('놓을 자리로 끌어 주세요. 놓으면 저장해요.');
    }
    e.preventDefault();
    dragOver(e.clientX, e.clientY);
  }
  // 화면을 떠났으면 놓기도 저장도 하지 않는다
  const gone = () => !isCurrent() || !main.isConnected;
  function onUp(e) {
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (gone()) { cancelDrag(false); return; }
    dropHere();
  }
  function onCancel() { cancelDrag(!gone()); }
  // 놓기(pointerup)를 못 받은 채 끝난 끌기(창 밖에서 놓음·창 전환·다시 누름)는 원래 자리로 되돌리고 저장하지 않는다
  function onDown(e) { if (drag && e !== drag.downEvent) onCancel(); }
  function onHidden() { if (doc.visibilityState === 'hidden') onCancel(); }
  function attachDrag(rowEl, grips, node) {
    for (const grip of grips) {
      grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || main.classList.contains('saving') || drag) return;
        const el = node.parentId == null ? rowEl.closest('.cat-group') : rowEl.closest('li');
        doc.addEventListener('pointermove', onMove, { passive: false });
        doc.addEventListener('pointerup', onUp);
        doc.addEventListener('pointercancel', onCancel);
        doc.addEventListener('pointerdown', onDown, true);
        doc.addEventListener('visibilitychange', onHidden);
        doc.defaultView?.addEventListener('blur', onCancel);
        drag = {
          node, el, pointerId: e.pointerId, downEvent: e, x: e.clientX, y: e.clientY, started: false, note: null,
          origin: { parent: el.parentElement, next: el.nextElementSibling },
          ready: e.pointerType !== 'touch' || grip.classList.contains('cat-handle'), timer: null,
          unlisten: () => {
            doc.removeEventListener('pointermove', onMove);
            doc.removeEventListener('pointerup', onUp);
            doc.removeEventListener('pointercancel', onCancel);
            doc.removeEventListener('pointerdown', onDown, true);
            doc.removeEventListener('visibilitychange', onHidden);
            doc.defaultView?.removeEventListener('blur', onCancel);
          },
        };
        if (!drag.ready) drag.timer = setTimeout(() => { if (drag) drag.ready = true; }, HOLD_MS);
      });
    }
  }

  // ---------------------------------------------------------------- 줄 (모두 같은 모양)
  const line = (node, siblings, isGroup) => {
    const dedTag = categoryDeductionTag(rows.find((c) => c.id === node.id) ?? {});
    const tags = [...node.tags, ...(dedTag ? [`연말정산: ${dedTag}`] : [])].map((t) => h('span', { class: 'tag', text: t }, [], doc));
    const i = siblings.findIndex((s) => s.id === node.id);
    const sortList = siblings.map((s) => ({ id: s.id, name: s.name, sort_order: s.sortOrder }));
    const up = btn('↑', `${node.name} 위로`, () => updateMany(moveUpdates(sortList, node.id, 'up'), '순서를 바꿨어요.'));
    const down = btn('↓', `${node.name} 아래로`, () => updateMany(moveUpdates(sortList, node.id, 'down'), '순서를 바꿨어요.'));
    up.disabled = i === 0;
    down.disabled = i === siblings.length - 1;
    const handle = h('span', { class: 'cat-handle', text: '⠿', attrs: { 'aria-hidden': 'true', title: '끌어서 순서 바꾸기' } }, [], doc);
    const name = h('span', { class: 'cat-name' }, [h(isGroup ? 'strong' : 'span', { class: 'cat-label', text: node.name }, [], doc), ...tags], doc);
    const rowEl = h('div', { class: `cat-line${node.isActive ? '' : ' off'}` }, [
      handle, name,
      h('span', { class: 'cat-controls' }, [up, down, btn('⋯', `${node.name} 더 보기`, () => openMenu(node))], doc),
    ], doc);
    attachDrag(rowEl, [handle, name], node);
    return rowEl;
  };

  // ---------------------------------------------------------------- 화면
  const groupCard = (g, list) => h('section', { class: 'card cat-group', attrs: { 'data-group-id': g.id } }, [
    line(g, list, true),
    h('ul', { class: 'cat-items' }, g.items.map((it) => h('li', {}, [line(it, g.items, false)], doc)), doc),
  ], doc);

  main = h('main', { class: 'screen cat-screen' }, [
    head, tabs,
    h('div', { class: 'cat-top' }, [
      h('p', { class: 'muted small', text: '⠿를 끌거나 ↑↓로 순서를 바꿔요. ⋯에서 이름·끄기·옮기기·지우기. 기본 카테고리는 지우기 대신 끄기를 써 주세요.' }, [], doc),
      h('button', { class: 'btn primary cat-add-btn', text: '+ 추가', attrs: { type: 'button' }, on: { click: () => openAdd() } }, [], doc),
    ], doc),
    status,
    h('h2', { class: 'section-title', text: '지출' }, [], doc),
    h('div', { class: 'cat-group-list', attrs: { 'data-groups': 'expense' } }, tree.expense.map((g) => groupCard(g, tree.expense)), doc),
    h('h2', { class: 'section-title', text: '수입' }, [], doc),
    h('div', { class: 'cat-group-list', attrs: { 'data-groups': 'income' } }, tree.income.map((g) => groupCard(g, tree.income)), doc),
  ], doc);
  return main;
}
