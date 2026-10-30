// =====================================================================
// 카테고리 관리 (화면 설계 v0.2 3-9, 시안 18): 보기 · 순서 · 이름 · 항목/그룹 추가 · 끄기/켜기 · 지우기 · 다른 그룹으로
// 조회: categories / 끄기 전: 켜진 category_rules(category_id)·counterparty_rules(suggested_category_id) 수
// 쓰기: categories insert(부모·이름·순서) · update(이름·순서·켜짐·부모) · delete(사용자가 만든 것만, 쓰는 곳 있으면 DB 거부)
// - 기본(code) 항목은 지우기·옮기기 없음. 2단계까지만
// - 여러 행을 바꾸는 일(순서 다시 매기기·그룹 끄기)은 한 건씩 update → 중간 실패면 멈추고 다시 읽음
// 의존: ui/dom.js, router.js, core/confirm.js, core/errors.js, screens/categories-model.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { buildHash } from '../router.js';
import { confirmDialog } from '../core/confirm.js';
import { STAGES } from '../core/errors.js';
import {
  categoryTree, checkName, moveUpdates, moveTargets, nextSortOrder, offTargets, offConfirmText, moveGroupText, deleteErrorText, nameErrorText, categoryErrorText,
} from './categories-model.js';
import { errorView, rulesTabs } from './shell.js';

let catNotice = null;

/**
 * @param {{ db, reload(), isCurrent(), onError(err, extra) → string }} ctx
 */
export async function renderCategories({ db, reload, isCurrent, onError }, doc = globalThis.document) {
  const r = await db.select('categories', { columns: 'id,parent_id,name,code,sort_order,is_active' });
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
  const all = () => main.querySelectorAll('button, input, select');
  const busy = (on) => { for (const el of all()) el.disabled = on; };
  const btn = (text, label, onClick, cls = 'mini') => h('button', { class: `btn ${cls}`, text, attrs: { type: 'button', 'aria-label': label }, on: { click: onClick } }, [], doc);

  /** 여러 행 update를 차례로. 실패하면 멈추고 다시 읽는다 */
  const updateMany = async (updates, okText) => {
    busy(true);
    for (const u of updates) {
      const { id, ...patch } = u;
      const res = await db.update('categories', id, patch);
      if (res.error || !res.data?.length) {
        busy(false);
        if (res.error) failed(res.error, nameErrorText(res.error));
        else say('저장하지 못했어요. 새로고침해 주세요.', true);
        catNotice = { text: status.textContent, isError: true };
        reload();
        return;
      }
    }
    done(okText);
  };

  const rename = (node, line) => {
    const input = h('input', { class: 'field', attrs: { 'aria-label': `${node.name} 새 이름`, maxlength: '20' } }, [], doc);
    input.value = node.name;
    const save = btn('저장', '이름 저장', async () => {
      const v = checkName(input.value, siblingsOf(node.parentId), node.id);
      if (!v.ok) { say(v.message, true); return; }
      if (v.value === node.name) { reload(); return; }
      await updateMany([{ id: node.id, name: v.value }], `이름을 '${v.value}'(으)로 바꿨어요.`);
    }, 'mini primary');
    const cancel = btn('취소', '이름 바꾸기 취소', () => reload());
    line.replaceChildren(input, save, cancel);
    input.focus();
  };

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
    const g = moveTargets(tree, node).find((x) => x.id === groupId);
    if (!g) return;
    if (!(await confirmDialog({ ...moveGroupText(node, g.name), confirmLabel: '옮기기', doc }))) { reload(); return; }
    if (checkName(node.name, siblingsOf(g.id)).ok === false) { say(`'${g.name}'에 같은 이름이 있어 옮길 수 없어요`, true); return; }
    await updateMany([{ id: node.id, parent_id: g.id, sort_order: nextSortOrder(siblingsOf(g.id)) }], `'${node.name}'을(를) '${g.name}'(으)로 옮겼어요.`);
  };

  const addForm = (label, parentId, place) => {
    const input = h('input', { class: 'field', attrs: { 'aria-label': `${label} 이름`, placeholder: '이름', maxlength: '20' } }, [], doc);
    const add = btn('추가', label, async () => {
      const siblings = siblingsOf(parentId);
      const v = checkName(input.value, siblings);
      if (!v.ok) { say(v.message, true); return; }
      const incomeGroup = tree.income[0];
      const sortOrder = parentId == null
        ? nextSortOrder(tree.expense.map((g) => ({ sort_order: g.sortOrder })), { before: incomeGroup?.sortOrder })
        : nextSortOrder(siblings);
      busy(true);
      const res = await db.insert('categories', { parent_id: parentId, name: v.value, sort_order: sortOrder });
      busy(false);
      if (res.error) { failed(res.error, nameErrorText(res.error)); return; }
      done(`'${v.value}'을(를) ${place}에 더했어요.`);
    }, 'mini primary');
    return h('div', { class: 'cat-add' }, [input, add], doc);
  };

  const line = (node, siblings, isGroup) => {
    const tags = node.tags.map((t) => h('span', { class: 'tag', text: t }, [], doc));
    const nameLine = h('span', { class: 'cat-name' }, [h(isGroup ? 'strong' : 'span', { text: node.name }, [], doc), ...tags], doc);
    const i = siblings.findIndex((s) => s.id === node.id);
    const controls = [
      btn('↑', `${node.name} 위로`, () => updateMany(moveUpdates(siblings.map((s) => ({ id: s.id, name: s.name, sort_order: s.sortOrder })), node.id, 'up'), '순서를 바꿨어요.')),
      btn('↓', `${node.name} 아래로`, () => updateMany(moveUpdates(siblings.map((s) => ({ id: s.id, name: s.name, sort_order: s.sortOrder })), node.id, 'down'), '순서를 바꿨어요.')),
      btn('이름', `${node.name} 이름 바꾸기`, () => rename(node, row)),
      btn(node.isActive ? '끄기' : '켜기', `${node.name} ${node.isActive ? '끄기' : '켜기'}`, () => toggle(node)),
    ];
    controls[0].disabled = i === 0;
    controls[1].disabled = i === siblings.length - 1;
    const groups = node.canMove ? moveTargets(tree, node) : [];
    if (groups.length) {
      const sel = h('select', { class: 'field mini-select', attrs: { 'aria-label': `${node.name} 다른 그룹으로` } }, [
        h('option', { text: '옮기기…', attrs: { value: '' } }, [], doc),
        ...groups.map((g) => h('option', { text: g.name, attrs: { value: g.id } }, [], doc)),
      ], doc);
      sel.addEventListener('change', () => sel.value && moveTo(node, sel.value));
      controls.push(sel);
    }
    if (node.canDelete) controls.push(btn('지우기', `${node.name} 지우기`, () => remove(node), 'mini danger-text'));
    const row = h('div', { class: `cat-line${node.isActive ? '' : ' off'}` }, [nameLine, h('span', { class: 'cat-controls' }, controls, doc)], doc);
    return row;
  };

  const groupCard = (g, list) => h('section', { class: 'card cat-group' }, [
    line(g, list, true),
    h('ul', { class: 'cat-items' }, g.items.map((it) => h('li', {}, [line(it, g.items, false)], doc)), doc),
    addForm(`${g.name}에 항목 추가`, g.id, g.name),
  ], doc);

  const main = h('main', { class: 'screen' }, [
    head, tabs, status,
    h('p', { class: 'muted small', text: '고르기 화면에는 켜진 것만 보여요. 기본 항목은 지우거나 옮길 수 없어요.' }, [], doc),
    h('h2', { class: 'section-title', text: '지출' }, [], doc),
    ...tree.expense.map((g) => groupCard(g, tree.expense)),
    h('section', { class: 'card' }, [h('p', { class: 'label', text: '지출 그룹 추가' }, [], doc), addForm('지출 그룹 추가', null, '지출 그룹')], doc),
    h('h2', { class: 'section-title', text: '수입' }, [], doc),
    ...tree.income.map((g) => groupCard(g, tree.income)),
  ], doc);
  return main;
}
