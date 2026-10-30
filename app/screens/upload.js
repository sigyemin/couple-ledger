// =====================================================================
// 화면 2·4 올리기 (화면 설계 v0.1 4-2 ①·③·④, 보정 CL-029 2판)
// ① 파일 고르기: 여러 파일, 고르기 버튼 또는 끌어다 놓기(같은 경로 addFiles). 대상 달은 고르지 않는다(CL-051) —
//    묶음의 target_month = 그 파일 거래 중 가장 늦은 달(없으면 지난달), 거래는 각자 날짜의 달로 들어간다. 주소 ?month는 무시
//    '아직 안 올린 결제수단'은 홈 할 일에서만 보인다. 휴대폰이면 "PC에서 올리는 것을 권해요" 띠(막지 않음)
// 판별: 파일 바이트 → SHA-256 → Worker detect(형식 id) → 그 형식을 쓰는 켜진 결제수단(1개면 자동, 여러 개면 고르기, 없으면 건너뜀)
// ③ 미리보기: Worker parse(정규화 행) + DB에 이미 있는 중복 키 조회 → 새로 넣을 건수·이미 있음·행 오류·집계 제외 등
// ④ 저장: 확인 대화상자 → 파일마다 묶음 찾기/만들기(ensureBatch) → import_transactions 200행씩(uploadRows) → 결과
// - 파일은 이 기기 밖으로 나가지 않는다. DB에는 정규화한 행과 앱이 만든 묶음 이름만 간다(원본 파일 이름은 화면에만)
// ② 새 이체 상대: 통장 행 중 규칙에 안 맞은 행을 (방향, 설명)으로 묶어 카드(counterparty-card.js, 기본 '나중에').
//    고르면 그 값을 임시 규칙으로 넣어 다시 정규화 → 미리보기에 바로 반영. 저장 때 그 파일을 올리기 전에 counterparty_rules insert
//    (같은 이름·범위 규칙이 이미 있으면 DB가 거부 → 그대로 진행). '나중에'는 규칙 없이 검토 대기로 들어간다
// - 원거래 못 찾은 환불 연결은 다음 단계(사용자 결정 U-13 대기)
// 의존: ui/dom.js, router.js, core/confirm.js, core/errors.js, core/parse-worker.js, import/*, screens/upload-model.js, screens/shell.js
// =====================================================================
import { h } from '../ui/dom.js';
import { buildHash } from '../router.js';
import { confirmDialog } from '../core/confirm.js';
import { STAGES, ACTIONS, AppError } from '../core/errors.js';
import { runParseWorker } from '../core/parse-worker.js';
import { MAX_FILE_BYTES } from '../import/detect.js';
import { isPhone } from '../import/env.js';
import { ensureBatch, uploadRows, batchFileName } from '../import/upload.js';
import { fileHash } from '../import/dedup.js';
import {
  MAX_FILES, KEY_CHUNK, LOGGED_READ_ERRORS, progressText, TEST_SOURCE_WARNING, checkCancelMonths, suggestLineText, reviewText, applySourceChoice, counterpartyGroups, counterpartyRule, draftRule, withDrafts, matchSources, previewOf, previewLines, readErrorText, resultLines, failedRows, targetMonthOf, isFileDrag,
  nomatchLines, decisionCount, laterSummary, headParts,
} from './upload-model.js';
import { errorView } from './shell.js';
import { cpRow } from './upload-cp-row.js';
import { suggestionCount } from './refund.js';
import { categoryIndex, choiceValues, checkNames } from './counterparty-model.js';

const FORMAT_COLUMNS = [
  'id', 'institution', 'kind', 'version', 'file_types', 'text_encoding', 'header_row', 'header_scan_limit', 'column_map',
  'sensitive_headers', 'date_format', 'time_format', 'amount_sign', 'row_rules',
].join(',');
const CP_COLUMNS = [
  'id', 'match_field', 'match_text', 'match_type', 'source_id', 'direction', 'txn_type', 'suggested_kind',
  'suggested_exclude_reason', 'suggested_category_id', 'suggested_is_shared', 'priority', 'is_active', 'created_at',
].join(',');
const RULE_COLUMNS = 'id,pattern,match_type,category_id,is_ambiguous,priority,is_active,created_at';
const ACCEPT = '.xls,.xlsx,.html,.htm,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/html';

export async function loadUpload(db) {
  const res = await Promise.all([
    db.select('payment_sources', { columns: 'id,label,kind,institution,import_format_id,owner_member_id,is_active,is_test' }),
    db.select('import_formats', { columns: FORMAT_COLUMNS }),
    db.select('categories', { columns: 'id,parent_id,name,code,sort_order,is_active' }),
    // 순서는 서버 정렬 그대로 쓴다(DB apply_counterparty_rule의 앞선 규칙 순서와 같음 — CL-046)
    db.select('counterparty_rules', { columns: CP_COLUMNS, filters: [{ col: 'is_active', op: 'eq', value: true }],
      order: [{ col: 'priority' }, { col: 'created_at' }, { col: 'id' }] }),
    db.select('members', { columns: 'id,member_slot,display_name' }),
    // 순서는 서버 정렬 그대로 쓴다(DB reapply_category_rule의 앞선 규칙 순서와 같음)
    db.select('category_rules', { columns: RULE_COLUMNS, filters: [{ col: 'is_active', op: 'eq', value: true }],
      order: [{ col: 'priority' }, { col: 'created_at' }, { col: 'id' }] }),
  ]);
  const error = res.find((r) => r.error)?.error;
  if (error) return { error };
  return {
    data: {
      sources: res[0].data ?? [], formats: res[1].data ?? [], categories: res[2].data ?? [],
      cpRules: res[3].data ?? [], members: res[4].data ?? [], categoryRules: res[5].data ?? [],
    },
  };
}

/** DB에 이미 있는 중복 키(쪽 단위 in 조회) */
export const LOOKUP_TIMEOUT_MS = 30 * 1000; // 조회 요청 하나의 시간 제한(응답이 없으면 화면이 '읽는 중'에 머물지 않게, CL-051)

/** 요청이 ms 안에 끝나지 않으면 { error: { code: 'lookup_timeout' } } */
export function withTimeout(promise, ms, env = globalThis) {
  let timer;
  const late = new Promise((resolve) => { timer = env.setTimeout(() => resolve({ data: null, error: { code: 'lookup_timeout', message: 'lookup_timeout' } }), ms); });
  return Promise.race([promise, late]).finally(() => env.clearTimeout(timer));
}

async function existingKeys(db, rows, onStep = () => {}, env = globalThis) {
  const keys = [...new Set(rows.map((r) => r.dedup_key))];
  const found = new Set();
  const chunks = Math.ceil(keys.length / KEY_CHUNK);
  for (let i = 0; i < keys.length; i += KEY_CHUNK) {
    onStep(i / KEY_CHUNK + 1, chunks);
    const r = await withTimeout(db.select('transactions', { columns: 'dedup_key', filters: [{ col: 'dedup_key', op: 'in', value: keys.slice(i, i + KEY_CHUNK) }] }), LOOKUP_TIMEOUT_MS, env);
    if (r.error) return { error: r.error };
    for (const x of r.data ?? []) found.add(x.dedup_key);
  }
  return { data: found };
}

/**
 * @param {{ db, guard, member, fallbackMonth, isCurrent(), onError(err, extra) → string }} ctx
 *   fallbackMonth = 거래 0건 파일의 묶음 대상 달(지난달)
 */
export async function renderUpload({ db, guard, member, fallbackMonth, isCurrent, onError }, doc = globalThis.document, env = globalThis) {
  const res = await loadUpload(db);
  if (!isCurrent()) return null;
  const ym = (m) => m.slice(0, 7);
  const head = h('header', { class: 'screen-head' }, [h('h1', { class: 'title', text: '파일 올리기' }, [], doc)], doc);
  const phone = isPhone(env);
  const banner = phone ? h('section', { class: 'card banner', attrs: { role: 'note' } }, [
    h('strong', { text: 'PC에서 올리는 것을 권해요.' }, [], doc),
    h('p', { class: 'small', text: '휴대폰에서는 큰 파일을 처리하다 멈출 수 있어요. 그래도 여기서 올릴 수 있어요.' }, [], doc),
  ], doc) : null;
  if (res.error) {
    onError?.(res.error, { stage: STAGES.db_select });
    return h('main', { class: 'screen' }, [head, banner, errorView(res.error.message, res.error.detail?.sqlState ?? res.error.code, doc)], doc);
  }
  const { sources, formats, categories, cpRules, members } = res.data;
  // 가맹점 규칙(U-16 A안): 켜진 규칙 + 그 카테고리가 켜져 있는지(꺼졌으면 정규화가 분류하지 않음 — DB 재적용과 같게)
  const catActive = new Map(categories.map((c) => [c.id, c.is_active !== false]));
  const categoryRules = res.data.categoryRules.map((r) => ({ ...r, categoryActive: catActive.get(r.category_id) ?? false }));
  const cats = categoryIndex(categories);
  const formatById = new Map(formats.map((f) => [f.id, f]));
  const catCodes = categories.filter((c) => c.code).map((c) => [c.code, c.id]);

  const status = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  const say = (msg, isError = false) => { status.textContent = msg; status.className = `status-line${isError ? ' error' : ''}`; };
  const files = []; // { key, name, bytes, hash, fileType, choices, sourceId, parsed, preview, resumed, state, message, result }
  const list = h('div', { class: 'upload-files' }, [], doc);
  const save = h('button', { class: 'btn primary', text: '저장', attrs: { type: 'button' } }, [], doc);
  let busy = false;

  // 읽기 실패: 사용자 파일 문제가 아닌 것(시간 초과·Worker 멈춤 등)은 오류 기록 + 오류 번호(CL-051)
  const fail = (f, code) => {
    f.state = 'error'; f.step = null;
    f.message = readErrorText(code, phone);
    if (LOGGED_READ_ERRORS.includes(code)) {
      // 분류 코드 그대로(TIMEOUT·LOOKUP_TIMEOUT·WORKER_ERROR·PARSE_FAILED) — 어느 단계에서 멈췄는지 오류 번호로 구분
      const num = onError?.(new AppError(code, f.message), { stage: STAGES.import_parse });
      if (num) f.message = `${f.message} (오류 번호 ${num})`;
    }
  };
  // 진행 문구(파일 카드 + 상태 줄, aria-live) — 읽는 동안 화면이 멈춘 것처럼 보이지 않게
  const step = (f, text) => {
    f.step = text;
    say(progressText(files.indexOf(f) + 1, files.length, f.name, text));
    draw();
  };

  async function prepare(f) {
    f.state = 'reading';
    step(f, '거래 읽는 중…');
    const src = sources.find((s) => s.id === f.sourceId);
    const format = src && formatById.get(src.import_format_id);
    if (!format) { fail(f, 'format_mismatch'); draw(); return; }
    try {
      f.parsed = await runParseWorker({
        op: 'parse', bytes: f.bytes.slice().buffer, format, sourceId: src.id, categories: catCodes, counterpartyRules: cpRules, categoryRules,
      }, { env });
    } catch (e) {
      fail(f, e?.message); draw(); return;
    }
    step(f, '이미 들어온 거래 확인 중…');
    const [batch, keys] = await Promise.all([
      withTimeout(db.select('import_batches', { columns: 'id', filters: [{ col: 'source_id', op: 'eq', value: src.id }, { col: 'file_hash', op: 'eq', value: f.hash }] }), LOOKUP_TIMEOUT_MS, env),
      existingKeys(db, f.parsed.rows, (n, m) => { if (m > 1) step(f, `이미 들어온 거래 확인 중… ${n}/${m}`); }, env),
    ]);
    const err = batch.error ?? keys.error;
    if (err?.code === 'lookup_timeout') { fail(f, 'lookup_timeout'); draw(); return; }
    if (err) {
      const code = onError?.(err, { stage: STAGES.db_select });
      f.state = 'error'; f.message = `${err.message}${code ? ` (오류 번호 ${code})` : ''}`;
      draw(); return;
    }
    f.resumed = Boolean(batch.data?.length);
    f.keys = keys.data;
    f.step = null;
    say(`${f.name} 미리보기를 만들었어요.`);
    f.preview = previewOf(f.parsed, f.keys);
    f.cards = src.kind === 'bank_account' ? counterpartyGroups(f.parsed.rows).map((g) => {
      const card = cpRow({ g, categories }, doc);
      const c = { g, card, error: null, rule: null, get choice() { return card.choice; } };
      card.onChange(() => reparse(f));
      return c;
    }) : [];
    f.cardsBuilt = false;
    f.state = 'ready';
    draw();
  }

  /** 카드에서 고른 값 → 규칙(나중에 = null). 고른 값이 모자라면 error */
  function readCard(f, c) {
    const src = sources.find((s) => s.id === f.sourceId);
    const input = c.card.read();
    c.error = null;
    c.rule = null;
    if (input.choice === 'later') return;
    const names = checkNames({ matchText: c.g.text, alias: input.alias }); // 이름도 길이(100자)·민감번호 검사(리뷰 PR #30 낮음 1)
    if (!names.ok) { c.error = names.message; return; }
    const v = choiceValues({
      choice: input.choice, categoryId: input.categoryId, direction: c.g.direction,
      sourceOwnerId: src?.owner_member_id ?? null, meId: member?.memberId ?? null, members,
    }, cats);
    if (!v.ok) { c.error = v.message; return; }
    c.rule = counterpartyRule(c.g, f.sourceId, v.value, names.value.alias);
  }

  /**
   * 카드 값으로 다시 정규화(미리보기 숫자 반영). 한 파일에 Worker는 한 번에 하나만(리뷰 PR #30 낮음 2):
   * 도는 중에 또 바뀌면 끝난 뒤 마지막 값으로 한 번 더. 도는 동안 저장 버튼은 꺼진다
   */
  async function reparse(f) {
    f.cards.forEach((c) => readCard(f, c));
    if (f.reparsing) { f.reparseAgain = true; draw(); return; }
    f.reparsing = true;
    draw();
    try {
      do {
        f.reparseAgain = false;
        await reparseOnce(f);
      } while (f.reparseAgain);
    } finally {
      f.reparsing = false;
      draw();
    }
  }

  async function reparseOnce(f) {
    f.cards.forEach((c) => readCard(f, c));
    const drafts = f.cards.filter((c) => c.rule).map((c, i) => draftRule(c.rule, i));
    const src = sources.find((s) => s.id === f.sourceId);
    const format = formatById.get(src.import_format_id);
    const token = (f.token ?? 0) + 1;
    f.token = token;
    try {
      const parsed = await runParseWorker({
        op: 'parse', bytes: f.bytes.slice().buffer, format, sourceId: src.id, categories: catCodes, counterpartyRules: withDrafts(cpRules, drafts), categoryRules,
      }, { env });
      if (f.token !== token) return;
      f.parsed = parsed;
      f.preview = previewOf(parsed, f.keys);
    } catch (e) {
      if (f.token !== token) return;
      fail(f, e?.message);
    }
  }

  async function addFiles(fileList) {
    // 상한은 넣을 때마다 다시 본다(읽는 중에 또 고른 파일까지 세려고). 읽는 동안에는 고르기 버튼도 꺼진다
    for (const file of [...fileList]) {
      if (files.length >= MAX_FILES) { say(`한 번에 ${MAX_FILES}개까지 올릴 수 있어요.`, true); break; }
      const f = { key: `${files.length}-${file.name}`, name: file.name, state: 'reading', choices: [] };
      files.push(f);
      if (file.size > MAX_FILE_BYTES) { fail(f, 'too_big'); draw(); continue; }
      try {
        step(f, '파일 여는 중…');
        f.bytes = new Uint8Array(await file.arrayBuffer());
        f.hash = await fileHash(f.bytes);
        step(f, '어느 카드·통장 파일인지 확인 중…');
        const d = await runParseWorker({ op: 'detect', bytes: f.bytes.slice().buffer, formats }, { env });
        f.fileType = d.fileType;
        f.detect = { fileType: d.fileType, formatIds: d.formatIds ?? [], diagnosis: d.diagnosis ?? null }; // 형식 쪽 이름·숫자만(셀 값 없음)
        const m = matchSources(d.formatIds, sources);
        f.choices = m.choices;
        f.step = null;
        if (!m.choices.length) { f.state = 'nomatch'; say(''); draw(); continue; }
        if (!m.autoId) { f.state = 'choose'; say(`${f.name}: 어느 결제수단 파일인지 골라 주세요.`); draw(); continue; }
        f.sourceId = m.autoId;
      } catch (e) {
        fail(f, e?.message); draw(); continue;
      }
      await prepare(f);
    }
  }

  // ---------------------------------------------------------------- 파일 카드 (CL-069)
  // 카드는 파일마다 한 번 만들고 그 안의 글자만 고친다(선택 하나에 목록 전체를 다시 그리면 스크롤·초점이 튐 — ①)
  // 머리 한 줄: 파일 이름 · 결제수단 · 새로 N건 · 지출, 정할 것이 있으면 '결정 N개'. 정할 것이 없으면 처음엔 접힘(펼치기 가능)
  // 빨간 안내는 카드 맨 위 한 곳(warn)에 모은다
  function ensureUi(f) {
    if (f.ui) return f.ui;
    const toggle = h('button', { class: 'upload-toggle', attrs: { type: 'button', 'aria-expanded': 'true' } }, [], doc);
    const remove = h('button', { class: 'btn mini', text: '빼기', attrs: { type: 'button', 'aria-label': `${f.name} 빼기` } }, [], doc);
    remove.addEventListener('click', () => { files.splice(files.indexOf(f), 1); f.ui.section.remove(); draw(); });
    toggle.addEventListener('click', () => { f.open = !isOpen(f); draw(); });
    const ui = {
      toggle, remove,
      warn: h('div', { class: 'upload-warn', attrs: { role: 'alert' } }, [], doc),
      dest: h('div', { class: 'upload-dest' }, [], doc),
      sourceBox: h('div', {}, [], doc),
      body: h('div', { class: 'upload-body' }, [], doc),
      stats: h('div', {}, [], doc),
      cpBox: h('div', { class: 'cp-new' }, [], doc),
      result: h('div', {}, [], doc),
      sel: null,
    };
    ui.body.append(ui.stats, ui.cpBox, ui.result);
    ui.section = h('section', { class: 'card upload-file' }, [
      h('div', { class: 'card-head upload-head' }, [toggle, remove], doc), ui.warn, ui.dest, ui.sourceBox, ui.body,
    ], doc);
    f.ui = ui;
    return ui;
  }
  const isOpen = (f) => f.open ?? (f.state !== 'ready' || decisionCount(f) > 0);
  const put = (el, kids) => el.replaceChildren(...kids.filter(Boolean));

  function sourceSelect(f) {
    const ui = f.ui;
    const need = f.state === 'choose' || ((f.choices.length > 1 || f.choices[0]?.isTest) && f.state !== 'reading' && f.state !== 'saved');
    if (!need) { ui.sourceBox.replaceChildren(); return; }
    if (!ui.sel) {
      ui.sel = h('select', { class: 'field', attrs: { 'aria-label': `${f.name} 결제수단` } }, [
        h('option', { text: '어느 결제수단 파일인가요?', attrs: { value: '' } }, [], doc),
        ...f.choices.map((c) => h('option', { text: c.label, attrs: { value: c.id } }, [], doc)),
      ], doc);
      ui.sel.addEventListener('change', () => {
        // 결제수단을 바꾸면 이체 상대 줄도 새로(그 통장 기준)
        f.cardsBuilt = false;
        if (applySourceChoice(f, ui.sel.value) === 'prepare') prepare(f); else draw();
      });
    }
    ui.sel.value = f.sourceId ?? '';
    ui.sel.disabled = busy;
    if (ui.sel.parentNode !== ui.sourceBox) ui.sourceBox.replaceChildren(ui.sel);
  }

  function updateCard(f) {
    const ui = ensureUi(f);
    const src = sources.find((s) => s.id === f.sourceId);
    const p = f.preview;
    const ready = f.state === 'ready' || f.state === 'saved';
    const open = isOpen(f);
    ui.section.className = `card upload-file ${f.state}`;
    // 머리 한 줄
    const n = decisionCount(f);
    put(ui.toggle, [
      h('span', { class: 'upload-chev', text: open ? '▾' : '▸', attrs: { 'aria-hidden': 'true' } }, [], doc),
      h('span', { class: 'upload-name', text: f.name }, [], doc),
      ready ? h('span', { class: 'upload-head-sub', text: headParts(f, src?.label ?? '').join(' · ') }, [], doc) : null,
      ready && n ? h('span', { class: 'tag warn', text: `결정 ${n}개` }, [], doc) : null,
    ]);
    ui.toggle.setAttribute('aria-expanded', String(open));
    ui.toggle.setAttribute('aria-label', `${f.name}${ready ? ` · ${headParts(f, src?.label ?? '').join(' · ')}` : ''}${n ? ` · 결정 ${n}개` : ''} — ${open ? '접기' : '펼치기'}`);
    ui.remove.disabled = busy || f.state === 'reading' || f.state === 'saved';
    ui.remove.hidden = f.state === 'saved';
    // 빨간 안내 한 곳
    const warns = [];
    if (f.state === 'error') warns.push(f.message);
    if (f.state === 'nomatch') warns.push('맞는 결제수단이 없어 건너뛰어요.');
    if (f.choices.find((c) => c.id === f.sourceId)?.isTest) warns.push(TEST_SOURCE_WARNING);
    if (ready && p.errorCount) warns.push(`읽지 못한 행 ${p.errorCount}줄: ${p.errorLines.join(', ')} (행 ${p.errorRows.join(', ')}${p.errorCount > p.errorRows.length ? ' …' : ''})`);
    for (const c of f.cards ?? []) if (c.error) warns.push(`${c.g.text}: ${c.error}`);
    put(ui.warn, warns.map((t) => h('p', { text: t }, [], doc)));
    ui.warn.hidden = !warns.length;
    // 어느 결제수단으로 들어가는지 크게(④) + 진단(③)
    const dest = [];
    if (f.state === 'reading') dest.push(h('p', { class: 'upload-step', text: f.step ?? '읽는 중…' }, [], doc));
    if (f.state === 'nomatch') {
      dest.push(...nomatchLines(f.detect, formats, sources).map((t) => h('p', { class: 'upload-diag', text: t }, [], doc)));
      dest.push(h('p', { class: 'upload-hint', text: '이 화면을 캡처해 알려 주시면 형식을 고칠 수 있어요(파일 내용은 보이지 않아요).' }, [], doc));
    }
    if (ready && src) {
      dest.push(h('p', { class: 'upload-into' }, ['→ ', h('strong', { text: src.label }, [], doc), '(으)로 들어가요'], doc));
      if (f.resumed) dest.push(h('p', { class: 'upload-hint', text: '이미 올린 파일이라 빠진 행만 넣어요.' }, [], doc));
      if (f.state === 'ready' && f.choices.length <= 1) dest.push(h('p', { class: 'upload-hint', text: '같은 기관의 다른 계좌(예: 연금·적금) 파일이면 이 결제수단이 아니에요 — 빼기를 눌러 주세요.' }, [], doc));
    }
    put(ui.dest, dest);
    sourceSelect(f);
    // 본문(접기 대상)
    ui.body.hidden = !open || !ready;
    if (ready) {
      put(ui.stats, [
        h('p', { class: 'upload-sum', text: `새로 ${p.newCount}건 · 지출 합계(집계 제외 빼고) ${p.spendText}` }, [], doc),
        h('p', { class: 'upload-hint', text: reviewText(p.newCount, p.confirmed) }, [], doc),
        h('dl', { class: 'kv upload-kv' }, previewLines(p).flatMap(([k, v]) => [h('dt', { text: k }, [], doc), h('dd', { text: v }, [], doc)]), doc),
      ]);
      if (f.cards?.length && !f.cardsBuilt) {
        put(ui.cpBox, [
          h('h3', { class: 'card-title', text: `새 이체 상대 ${f.cards.length}` }, [], doc),
          h('p', { class: 'upload-hint', text: '고르면 규칙으로 저장돼 다음부터 자동으로 적용돼요. 나중에 두면 검토 대기로 들어가요.' }, [], doc),
          ...f.cards.map((c) => c.card.el),
        ]);
        f.cardsBuilt = true;
      }
      ui.cpBox.hidden = !f.cards?.length;
      f.cards?.forEach((c) => c.card.setDisabled(busy || f.state === 'saved'));
    }
    put(ui.result, f.result ? [h('div', { class: 'upload-result', attrs: { role: 'status' } }, [
      ...resultLines(f.result).map((t) => h('p', { class: f.result.error ? 'notice' : 'upload-sum', text: t }, [], doc)),
      failedRows(f.result).length ? h('p', { class: 'upload-hint', text: `넣지 못한 행: ${failedRows(f.result).join(', ')}` }, [], doc) : null,
    ], doc)] : []);
    if (f.result) ui.body.hidden = false;
    return ui.section;
  }

  function draw() {
    // 파일이 더해지거나 빠졌을 때만 목록 순서를 다시 놓는다(있는 카드는 옮기지 않음)
    const sections = files.map((f) => ensureUi(f).section);
    if (sections.length !== list.children.length || sections.some((el, i) => list.children[i] !== el)) list.replaceChildren(...sections);
    files.forEach(updateCard);
    const ready = files.filter((f) => f.state === 'ready' && f.sourceId);
    const total = ready.reduce((s, f) => s + f.preview.newCount, 0);
    save.textContent = ready.length ? `${ready.length}개 파일 · 새로 ${total}건 저장` : '저장';
    const cardErrors = ready.some((f) => f.cards?.some((c) => c.error));
    save.disabled = busy || ready.length === 0 || cardErrors || files.some((f) => f.state === 'reading' || f.reparsing);
    saveNote.textContent = cardErrors ? '새 이체 상대에서 고를 값을 마저 골라 주세요(카드 위 빨간 글).' : laterSummary(files);
    saveNote.className = `savebar-note${cardErrors ? ' error' : ''}`;
    saveBar.hidden = files.length === 0;
    picker.disabled = busy || files.some((f) => f.state === 'reading');
  }

  async function saveAll() {
    const ready = files.filter((f) => f.state === 'ready' && f.sourceId);
    const total = ready.reduce((s, f) => s + f.preview.newCount, 0);
    const confirmed = ready.reduce((s, f) => s + (f.preview.confirmed ?? 0), 0);
    if (!(await confirmDialog({
      title: '올리기',
      message: `${ready.length}개 파일에서 새로 ${total}건을 넣어요. 거래는 각자 날짜의 달로 들어가요. ${reviewText(total, confirmed)}.`,
      undoNote: '잘못 넣은 거래는 거래 상세에서 휴지통으로 옮길 수 있어요.',
      confirmLabel: '저장', doc,
    }))) return;
    busy = true; draw();
    for (const f of ready) {
      const src = sources.find((s) => s.id === f.sourceId);
      try {
        say(`${f.name} 저장 중…`);
        for (const c of f.cards ?? []) {
          if (!c.rule) continue;
          const r = await db.insert('counterparty_rules', { ...c.rule, created_by: member.memberId });
          if (r.error && r.error.code !== 'duplicate') throw r.error; // 같은 이름·범위 규칙이 이미 있으면 그대로 진행
        }
        const targetMonth = targetMonthOf(f.parsed.rows, fallbackMonth);
        f.targetMonth = targetMonth;
        const { batchId } = await ensureBatch(db, guard, {
          sourceId: src.id, targetMonth, fileHash: f.hash,
          fileName: batchFileName(src.institution, targetMonth, f.fileType),
        });
        f.result = await uploadRows(db, batchId, f.parsed.rows, {
          onProgress: ({ sentRows, total: n }) => say(`${f.name} 저장 중… ${sentRows}/${n}`),
        });
        if (f.result.error) onError?.(f.result.error, { stage: STAGES.import_save, action: ACTIONS.upload });
      } catch (e) {
        const code = onError?.(e, { stage: STAGES.import_save, action: ACTIONS.upload });
        f.result = { counts: {}, failures: [], notices: [], sentRows: 0, error: e };
        f.message = `${e.message ?? '저장하지 못했어요'}${code ? ` (오류 번호 ${code})` : ''}`;
      }
      f.state = f.result.error ? 'error' : 'saved';
      if (f.result.error && !f.message) f.message = '저장하다 멈췄어요.';
      draw();
    }
    busy = false;
    const okCount = files.filter((f) => f.state === 'saved').length;
    say(okCount === ready.length ? `${okCount}개 파일을 저장했어요.` : `${okCount}/${ready.length}개 파일을 저장했어요. 멈춘 파일은 다시 올리면 이어서 넣어요.`, okCount !== ready.length);
    draw();
    // 내역에서 보기: 저장한 파일들 중 가장 늦은 달의 검토 대기
    const lastMonth = files.filter((f) => f.state === 'saved').map((f) => f.targetMonth).sort().pop() ?? fallbackMonth;
    done.setAttribute('href', buildHash('list', { query: { month: ym(lastMonth), status: 'needs_review' } }));
    done.hidden = okCount === 0;
    // 체크카드 취소가 들어갔으면 그 달들의 연결 제안 수(실패하면 줄을 보이지 않음 — 결과에는 영향 없음)
    const months = checkCancelMonths(files.filter((f) => f.state === 'saved'));
    if (months.length) {
      const counts = [];
      for (const m of months) {
        const c = await suggestionCount(db, m);
        if (!c.error) counts.push({ month: m, count: c.data.count });
      }
      const t = suggestLineText(counts);
      if (t) {
        suggestLine.replaceChildren(h('a', { class: 'todo', attrs: { href: buildHash('review', { query: { month: ym(t.month) } }) } }, [
          h('span', { class: 'todo-text' }, [h('span', { text: t.text }, [], doc)], doc),
          h('span', { class: 'chev', text: '›', attrs: { 'aria-hidden': 'true' } }, [], doc),
        ], doc));
        suggestLine.hidden = false;
      }
    }
  }
  save.addEventListener('click', saveAll);
  // 저장은 아래에 붙어 있다(긴 미리보기에서도 보이게 — ②) + 결정 안 한 이체 상대 요약
  const saveNote = h('p', { class: 'savebar-note', attrs: { 'aria-live': 'polite' } }, [], doc);
  const saveBar = h('div', { class: 'upload-savebar' }, [saveNote, save], doc);

  const input = h('input', { class: 'visually-hidden', attrs: { type: 'file', multiple: true, accept: ACCEPT, id: 'upload-input', 'aria-label': '파일 고르기' } }, [], doc);
  input.addEventListener('change', () => { const fl = input.files; if (fl?.length) addFiles(fl); input.value = ''; });
  const picker = h('button', { class: 'btn secondary', text: '+ 파일 고르기', attrs: { type: 'button' } }, [], doc);
  picker.addEventListener('click', () => input.click());
  const suggestLine = h('div', { class: 'card', attrs: { role: 'status' } }, [], doc);
  suggestLine.hidden = true;
  const done = h('a', { class: 'btn secondary', text: '내역에서 보기', attrs: { href: buildHash('list', { query: { month: ym(fallbackMonth), status: 'needs_review' } }) } }, [], doc);
  done.hidden = true;

  // 끌어다 놓기(CL-051): 고르기 카드가 놓기 영역. 놓은 파일은 고르기와 같은 경로(addFiles)
  const dropZone = h('section', { class: 'card drop-zone', attrs: { 'aria-label': '파일 놓는 곳' } }, [
    h('p', { text: '카드·통장 파일을 여기에 끌어다 놓거나 골라 주세요. 여러 개를 한 번에 올려도 돼요.' }, [], doc),
    h('p', { class: 'muted small', text: '거래는 각자 날짜의 달로 들어가요. 파일은 이 기기 밖으로 나가지 않고, 읽은 거래만 저장해요.' }, [], doc),
    picker, input,
  ], doc);
  let dragDepth = 0;
  const setDragging = (on) => dropZone.classList.toggle('dragging', on);
  dropZone.addEventListener('dragenter', (e) => { if (!isFileDrag(e.dataTransfer)) return; e.preventDefault(); dragDepth++; setDragging(true); });
  dropZone.addEventListener('dragover', (e) => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = picker.disabled ? 'none' : 'copy';
  });
  dropZone.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) setDragging(false); });
  dropZone.addEventListener('drop', (e) => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth = 0; setDragging(false);
    if (picker.disabled) { say('지금은 파일을 더할 수 없어요. 읽기·저장이 끝난 뒤 다시 놓아 주세요.', true); return; }
    const fl = e.dataTransfer?.files;
    if (fl?.length) addFiles(fl);
  });

  draw();
  return h('main', { class: 'screen upload-screen' }, [head, banner, status, dropZone, list, saveBar, suggestLine, done], doc);
}
