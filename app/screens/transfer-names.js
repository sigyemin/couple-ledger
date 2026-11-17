// =====================================================================
// 통장에 찍히는 이름 #/tnames · 통장끼리 이체 짝 #/pairs (v0.23 CL-077 A2·A3·A4)
// #/tnames: 본인 이름 추가·지우기(여러 개, 방식 정확히/다른 글자와 붙어 찍힘), 상대 이름은 보기만.
//           '지난 거래에 적용' = apply_member_name_transfers 미리보기(결과별 건수) → 확인 → 적용(기간 나눔 — split-rpc.js)
// #/pairs:  find_internal_transfer_pairs(그 달) → 모호하지 않은 짝은 체크 목록(기본 체크), 모호한 짝은 출금마다 후보 중 하나 →
//           apply_internal_transfer_pairs(200쌍씩). 그사이 바뀐 거래가 있으면(LG007) 다시 불러오기 안내
// - 이름·설명(이체 상대 원문)은 화면에만: 오류 기록(코드만)·주소·콘솔·localStorage·p_description(기간만)에 넣지 않는다
// 의존: ui/dom.js, router.js, core/confirm.js, core/errors.js, core/format.js, screens/transfer-names-model.js,
//       screens/split-rpc.js, screens/merchant-classify-model.js(rangeText), screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { addMonths, buildHash } from '../router.js';
import { confirmDialog } from '../core/confirm.js';
import { STAGES } from '../core/errors.js';
import { month, won } from '../core/format.js';
import {
  MATCH_TYPES, CONTAINS_HINT, checkName, nameErrorText, namesByMember, nameApplySummary, nameApplyText,
  pairGroups, txnLine, pickedPairs, pairApplyText, pairStopText, PAIR_CHUNK,
} from './transfer-names-model.js';
import { previewSplit, applySplit } from './split-rpc.js';
import { rangeText } from './merchant-classify-model.js';
import { errorView } from './shell.js';

const eq = (col, value) => ({ col, op: 'eq', value });
let tnNotice = null;
let pairNotice = null;

function backHead(title, doc, nav = null) {
  return h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav' }, nav ?? [
      h('a', { class: 'icon-btn', text: '‹', attrs: { href: buildHash('more'), 'aria-label': '더보기로' } }, [], doc),
      h('h1', { class: 'title', text: title }, [], doc),
    ], doc),
  ], doc);
}

function statusLine(doc) {
  const el = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  el.say = (msg, isError = false) => { el.textContent = msg; el.className = `status-line${isError ? ' error' : ''}`; };
  return el;
}

/**
 * @param {{ db, member, reload(), isCurrent(), onError }} ctx
 */
export async function renderTransferNames({ db, member, reload, isCurrent, onError }, doc = globalThis.document) {
  const [names, members] = await Promise.all([
    db.select('member_transfer_names', { columns: 'id,member_id,pattern,match_type,created_at' }),
    db.select('members', { columns: 'id,member_slot,display_name' }),
  ]);
  if (!isCurrent()) return null;
  const head = backHead('통장에 찍히는 이름', doc);
  const err = names.error ?? members.error;
  if (err) {
    onError?.(err);
    return h('main', { class: 'screen' }, [head, errorView(err.message, err.detail?.sqlState ?? err.code, doc)], doc);
  }
  const status = statusLine(doc);
  if (tnNotice) { status.say(tnNotice.text, tnNotice.isError); tnNotice = null; }
  const done = (text, isError = false) => { tnNotice = { text, isError }; reload(); };
  const fail = (e, text = null) => {
    const code = onError?.(e, { stage: STAGES.db_update }); // 오류 객체만(이름 값 없음)
    status.say(`${text ?? e.message}${code ? ` (오류 번호 ${code})` : ''}`, true);
  };
  const groups = namesByMember(names.data, members.data, member.memberId);

  // ---- 추가(본인)
  const input = h('input', { class: 'field', attrs: { 'aria-label': '통장에 찍히는 내 이름', maxlength: '30', autocomplete: 'off', placeholder: '예: 통장에 보이는 그대로' } }, [], doc);
  const radio = (value, label, checked) => {
    const r = h('input', { attrs: { type: 'radio', name: 'tn-match', value } }, [], doc);
    r.checked = checked;
    return h('label', { class: 'radio' }, [r, label], doc);
  };
  const radios = h('div', { class: 'radio-group', attrs: { role: 'radiogroup', 'aria-label': '비교 방식' } }, MATCH_TYPES.map(([k, l]) => radio(k, l, k === 'exact')), doc);
  const add = h('button', { class: 'btn primary', text: '이름 추가', attrs: { type: 'button' } }, [], doc);
  add.addEventListener('click', async () => {
    const matchType = radios.querySelector('input:checked')?.value ?? 'exact';
    const v = checkName({ pattern: input.value, matchType }, member.memberId);
    if (!v.ok) { status.say(v.message, true); return; }
    add.disabled = true;
    const r = await db.insert('member_transfer_names', v.row);
    add.disabled = false;
    if (r.error) { fail(r.error, nameErrorText(r.error)); return; }
    done('이름을 추가했어요. 다음 업로드부터 적용돼요. 이미 들어온 거래는 아래 "지난 거래에 적용"으로 바꿀 수 있어요.');
  });

  const listOf = (g) => h('ul', { class: 'todo-list' }, g.rows.length ? g.rows.map((row) => {
    const kids = [
      h('span', { class: 'todo-text' }, [
        h('span', { text: row.pattern }, [], doc),
        h('span', { class: 'sub', text: row.match_type === 'contains' ? '다른 글자와 붙어 찍힘' : '정확히' }, [], doc),
      ], doc),
    ];
    if (g.mine) {
      const del = h('button', { class: 'btn mini', text: '지우기', attrs: { type: 'button', 'aria-label': `${row.pattern} 지우기` } }, [], doc);
      del.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: '이름 지우기', message: '다음 업로드부터 이 이름으로 이체를 알아보지 않아요. 이미 바뀐 거래는 그대로예요(변경 기록에서 되돌릴 수 있어요).', confirmLabel: '지우기', danger: true, doc }))) return;
        del.disabled = true;
        const r = await db.delete('member_transfer_names', row.id);
        del.disabled = false;
        if (r.error) { fail(r.error); return; }
        done('이름을 지웠어요.');
      });
      kids.push(del);
    }
    return h('li', {}, [h('div', { class: 'todo' }, kids, doc)], doc);
  }) : [h('li', {}, [h('p', { class: 'muted', text: g.mine ? '아직 없어요' : '등록한 이름이 없어요' }, [], doc)], doc)], doc);

  const cards = groups.map((g) => h('section', { class: g.mine ? 'card form' : 'card' }, [
    h('h2', { class: 'card-title', text: g.mine ? `내 이름 (${g.name})` : `${g.name}의 이름 (보기만)` }, [], doc),
    listOf(g),
    ...(g.mine ? [
      h('label', { class: 'field-label', text: '이름 추가' }, [], doc), input, radios,
      h('p', { class: 'muted small', text: CONTAINS_HINT }, [], doc),
      add,
    ] : []),
  ], doc));

  // ---- 지난 거래에 적용 (A3)
  const applyBtn = h('button', { class: 'btn secondary', text: '지난 거래에 적용', attrs: { type: 'button' } }, [], doc);
  const lockAll = (on) => { for (const el of main.querySelectorAll('button, input')) el.disabled = on; };
  const call = (apply) => (r) => db.rpc('apply_member_name_transfers', {
    p_apply: apply, p_from_month: r.from ?? null, p_to_month: r.to ?? null,
    ...(apply ? { p_description: `이름으로 이체 정리 · ${rangeText(r)}` } : {}), // 기간만(이름 넣지 않음 — 리뷰 v0.23 P-5)
  }, apply ? {} : { retry: true });
  applyBtn.addEventListener('click', async () => {
    lockAll(true);
    status.say('미리 보는 중…');
    const pv = await previewSplit(db, call(false), (t) => status.say(t));
    if (pv.error) { lockAll(false); fail(pv.error, `미리보기에서 멈췄어요(${rangeText(pv.range)}): ${pv.error.message}`); return; }
    const per = pv.ranges.map((r) => ({ ...r, sum: nameApplySummary(r.rows) }));
    const total = nameApplySummary(pv.ranges.flatMap((r) => r.rows));
    if (!total.updated) {
      lockAll(false);
      status.say(`바꿀 거래가 없어요.${total.skipped_counterparty_rule + total.skipped_edited + total.skipped_has_refund + total.skipped_ambiguous ? ` (그대로 두는 ${total.skipped_counterparty_rule + total.skipped_edited + total.skipped_has_refund + total.skipped_ambiguous}건)` : ''}`);
      return;
    }
    status.say('');
    const todo = per.filter((r) => r.sum.updated > 0);
    if (!(await confirmDialog({ ...nameApplyText(total, todo.length), confirmLabel: '적용', doc }))) { lockAll(false); return; }
    const res = await applySplit(db, call(true), todo, (t) => status.say(t));
    const changed = nameApplySummary(res.rows).updated;
    if (res.error) {
      const code = onError?.(res.error, { stage: STAGES.db_rpc });
      done(`${res.done ? `${res.done}개 기간을 적용했어요(${changed}건). ` : ''}${rangeText(res.range)}에서 멈췄어요: ${res.error.message}${code ? ` (오류 번호 ${code})` : ''}`, true);
      return;
    }
    done(`${changed}건을 이체로 바꿨어요. 변경 기록에서 되돌릴 수 있어요.`);
  });

  const main = h('main', { class: 'screen' }, [
    head, status,
    h('section', { class: 'card' }, [
      h('p', { class: 'muted', text: '통장 내역의 설명·상대 칸에 아래 이름이 보이면, 그 통장 주인 이름은 내 계좌 이동, 다른 사람 이름은 두 사람 간 송금으로 알아봐요(집계 제외). 이체 상대 규칙이 있으면 그 규칙이 먼저예요.' }, [], doc),
    ], doc),
    ...cards,
    h('section', { class: 'card' }, [
      h('h2', { class: 'card-title', text: '이미 들어온 거래' }, [], doc),
      h('p', { class: 'muted small', text: '등록한 이름으로 지난 통장 거래를 다시 봐요. 미리 몇 건이 바뀌는지 보여 드려요. 직접 고친 거래·이체 상대 규칙이 맞는 거래는 그대로예요.' }, [], doc),
      applyBtn,
      h('a', { class: 'row-link soft', attrs: { href: buildHash('pairs') } }, [h('span', { text: '이름이 안 찍힌 이체는 통장끼리 짝으로' }, [], doc), h('strong', { text: '›' }, [], doc)], doc),
    ], doc),
  ], doc);
  return main;
}

/**
 * @param {{ db, monthStart, reload(), isCurrent(), onError }} ctx
 */
export async function renderPairs({ db, monthStart, reload, isCurrent, onError }, doc = globalThis.document) {
  const found = await db.rpc('find_internal_transfer_pairs', { p_from_month: monthStart, p_to_month: monthStart }, { retry: true });
  const ids = found.error ? [] : [...new Set((found.data ?? []).flatMap((p) => [p.out_txn_id, p.in_txn_id]))];
  const details = new Map();
  let detailErr = null;
  for (let i = 0; i < ids.length && !detailErr; i += 100) {
    const r = await db.select('v_transaction_detail', { columns: 'id,occurred_on,merchant_raw,amount,source_label,payer_name', filters: [{ col: 'id', op: 'in', value: ids.slice(i, i + 100) }] });
    if (r.error) detailErr = r.error;
    for (const d of r.data ?? []) details.set(d.id, d);
  }
  if (!isCurrent()) return null;
  const ym = (m) => m.slice(0, 7);
  const nav = (n, label, text) => h('a', { class: 'icon-btn', text, attrs: { href: buildHash('pairs', { query: { month: ym(addMonths(monthStart, n)) } }), 'aria-label': label } }, [], doc);
  const head = backHead('', doc, [
    nav(-1, '이전 달', '‹'),
    h('h1', { class: 'title', text: `${month(monthStart).replace(/^[0-9]+년 /, '')} 통장끼리 이체 짝` }, [], doc),
    nav(1, '다음 달', '›'),
  ]);
  const err = found.error ?? detailErr;
  if (err) {
    onError?.(err);
    return h('main', { class: 'screen' }, [head, errorView(err.message, err.detail?.sqlState ?? err.code, doc)], doc);
  }
  const status = statusLine(doc);
  if (pairNotice) { status.say(pairNotice.text, pairNotice.isError); pairNotice = null; }
  const g = pairGroups(found.data, details);

  const side = (label, d, on) => h('span', { class: 'pair-side' }, [
    h('span', { class: 'pair-tag', text: label }, [], doc), h('span', { text: txnLine(d, on) }, [], doc),
  ], doc);
  const clearBoxes = g.clear.map((it) => {
    const box = h('input', { attrs: { type: 'checkbox', 'aria-label': `${it.label} ${won(it.amount)} 짝` } }, [], doc);
    box.checked = true;
    return { it, box };
  });
  const clearCard = h('section', { class: 'card' }, [
    h('h2', { class: 'card-title', text: `짝 ${g.clear.length}쌍` }, [], doc),
    g.clear.length === 0 ? h('p', { class: 'muted', text: '같은 금액·하루 안의 출금↔입금 짝이 없어요' }, [], doc)
      : h('ul', { class: 'pair-list' }, clearBoxes.map(({ it, box }) => h('li', {}, [
        h('label', { class: 'pair-item' }, [
          box,
          h('span', { class: 'pair-body' }, [
            h('strong', { text: `${it.label} · ${won(it.amount)}` }, [], doc),
            side('출금', it.out, it.outOn), side('입금', it.in, it.inOn),
          ], doc),
        ], doc),
      ], doc)), doc),
  ], doc);

  // 모호한 짝: 출금마다 후보 중 하나(또는 짝 아님)
  const chooseRows = g.choose.map((c, gi) => {
    const name = `pair-choose-${gi}`;
    const opts = [{ value: '', label: '짝 아님(그대로)' }, ...c.items.map((it, i) => ({ value: String(i), label: `${txnLine(it.in, it.inOn)} (${it.label})` }))];
    const radios = opts.map((o) => {
      const r = h('input', { attrs: { type: 'radio', name, value: o.value } }, [], doc);
      r.checked = o.value === '';
      return { o, r };
    });
    return { c, radios };
  });
  const chooseCard = g.choose.length ? h('section', { class: 'card' }, [
    h('h2', { class: 'card-title', text: `헷갈리는 짝 ${g.choose.length}건 — 하나 골라 주세요` }, [], doc),
    h('p', { class: 'muted small', text: '같은 금액의 상대가 여러 개예요. 맞는 입금을 고르거나 그대로 두세요.' }, [], doc),
    ...chooseRows.map(({ c, radios }) => h('div', { class: 'pair-choose' }, [
      h('p', {}, [h('strong', { text: `출금 · ${won(c.items[0].amount)}` }, [], doc), h('span', { class: 'sub', text: ` ${txnLine(c.items[0].out, c.items[0].outOn)}` }, [], doc)], doc),
      h('div', { class: 'radio-group', attrs: { role: 'radiogroup', 'aria-label': '맞는 입금' } }, radios.map(({ o, r }) => h('label', { class: 'radio' }, [r, o.label], doc)), doc),
    ], doc)),
  ], doc) : null;

  const apply = h('button', { class: 'btn primary', text: '고른 짝을 이체로', attrs: { type: 'button' } }, [], doc);
  apply.disabled = !g.clear.length && !g.choose.length;
  apply.addEventListener('click', async () => {
    const items = [
      ...clearBoxes.filter((x) => x.box.checked).map((x) => x.it),
      ...chooseRows.map(({ c, radios }) => { const v = radios.find((x) => x.r.checked)?.o.value; return v ? c.items[Number(v)] : null; }).filter(Boolean),
    ];
    const pairs = pickedPairs(items);
    if (!pairs.length) { status.say('고른 짝이 없어요.', true); return; }
    const chosen = items.filter((it) => pairs.some((p) => p.out_txn_id === it.outId && p.in_txn_id === it.inId));
    if (!(await confirmDialog({ ...pairApplyText(chosen), confirmLabel: '이체로', doc }))) return;
    for (const el of main.querySelectorAll('button, input')) el.disabled = true;
    let doneN = 0;
    for (let i = 0; i < pairs.length; i += PAIR_CHUNK) {
      const r = await db.rpc('apply_internal_transfer_pairs', { p_pairs: pairs.slice(i, i + PAIR_CHUNK), p_description: `통장끼리 이체 짝 · ${ym(monthStart)}` }); // 기간만
      if (r.error) {
        const code = onError?.(r.error, { stage: STAGES.db_rpc });
        const changed = r.error.detail?.sqlState === 'LG007';
        pairNotice = {
          text: `${pairStopText({ done: doneN, rest: pairs.length - doneN, changed, message: r.error.message })}${code ? ` (오류 번호 ${code})` : ''}`,
          isError: true,
        };
        reload();
        return;
      }
      doneN += Math.min(PAIR_CHUNK, pairs.length - i);
    }
    pairNotice = { text: `${doneN}쌍을 이체로 바꿨어요. 변경 기록에서 되돌릴 수 있어요.`, isError: false };
    reload();
  });

  const main = h('main', { class: 'screen' }, [
    head, status,
    h('section', { class: 'card' }, [
      h('p', { class: 'muted', text: '올린 통장끼리 같은 금액이 하루 안에 나가고 들어온 것을 짝으로 보여 드려요. 같은 사람 통장끼리면 내 계좌 이동, 다른 사람 통장이면 두 사람 간 송금이에요. 고른 짝만 이체로 바뀌어요(집계 제외).' }, [], doc),
      h('a', { class: 'row-link soft', attrs: { href: buildHash('tnames') } }, [h('span', { text: '통장에 찍히는 이름으로 먼저 정리하기' }, [], doc), h('strong', { text: '›' }, [], doc)], doc),
    ], doc),
    clearCard, chooseCard, apply,
  ], doc);
  return main;
}
