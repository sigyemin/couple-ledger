// =====================================================================
// 화면 2·4 올리기 (화면 설계 v0.1 4-2 ①·③·④, 보정 CL-029 2판)
// ① 파일 고르기: 여러 파일, 대상 달(기본 지난달 — 주소 ?month), 그 달 안 올린 결제수단(missing_uploads)
//    휴대폰이면 "PC에서 올리는 것을 권해요" 띠(막지 않음)
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
import { addMonths, buildHash } from '../router.js';
import { confirmDialog } from '../core/confirm.js';
import { STAGES, ACTIONS } from '../core/errors.js';
import { runParseWorker } from '../core/parse-worker.js';
import { MAX_FILE_BYTES } from '../import/detect.js';
import { isPhone } from '../import/env.js';
import { ensureBatch, uploadRows, batchFileName } from '../import/upload.js';
import { fileHash } from '../import/dedup.js';
import {
  MAX_FILES, KEY_CHUNK, counterpartyGroups, counterpartyRule, draftRule, matchSources, previewOf, previewLines, readErrorText, resultLines, failedRows, monthTitle,
} from './upload-model.js';
import { errorView } from './shell.js';
import { choiceCard } from './counterparty-card.js';
import { categoryIndex, choiceValues, checkNames } from './counterparty-model.js';

const FORMAT_COLUMNS = [
  'id', 'institution', 'kind', 'version', 'file_types', 'text_encoding', 'header_row', 'header_scan_limit', 'column_map',
  'sensitive_headers', 'date_format', 'time_format', 'amount_sign', 'row_rules',
].join(',');
const CP_COLUMNS = [
  'id', 'match_field', 'match_text', 'match_type', 'source_id', 'direction', 'txn_type', 'suggested_kind',
  'suggested_exclude_reason', 'suggested_category_id', 'suggested_is_shared', 'priority', 'is_active', 'created_at',
].join(',');
const ACCEPT = '.xls,.xlsx,.html,.htm,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/html';

export async function loadUpload(db, monthStart) {
  const res = await Promise.all([
    db.select('payment_sources', { columns: 'id,label,kind,institution,import_format_id,owner_member_id,is_active,is_test' }),
    db.select('import_formats', { columns: FORMAT_COLUMNS }),
    db.select('categories', { columns: 'id,parent_id,name,code,sort_order,is_active' }),
    db.select('counterparty_rules', { columns: CP_COLUMNS, filters: [{ col: 'is_active', op: 'eq', value: true }] }),
    db.rpc('missing_uploads', { p_month: monthStart }, { retry: true }),
    db.select('members', { columns: 'id,member_slot,display_name' }),
  ]);
  const error = res.find((r) => r.error)?.error;
  if (error) return { error };
  return {
    data: {
      sources: res[0].data ?? [], formats: res[1].data ?? [], categories: res[2].data ?? [],
      cpRules: res[3].data ?? [], missing: res[4].data ?? [], members: res[5].data ?? [],
    },
  };
}

/** DB에 이미 있는 중복 키(쪽 단위 in 조회) */
async function existingKeys(db, rows) {
  const keys = [...new Set(rows.map((r) => r.dedup_key))];
  const found = new Set();
  for (let i = 0; i < keys.length; i += KEY_CHUNK) {
    const r = await db.select('transactions', { columns: 'dedup_key', filters: [{ col: 'dedup_key', op: 'in', value: keys.slice(i, i + KEY_CHUNK) }] });
    if (r.error) return { error: r.error };
    for (const x of r.data ?? []) found.add(x.dedup_key);
  }
  return { data: found };
}

/**
 * @param {{ db, guard, member, monthStart, isCurrent(), onError(err, extra) → string }} ctx
 */
export async function renderUpload({ db, guard, member, monthStart, isCurrent, onError }, doc = globalThis.document, env = globalThis) {
  const res = await loadUpload(db, monthStart);
  if (!isCurrent()) return null;
  const ym = (m) => m.slice(0, 7);
  const nav = (n, label, text) => h('a', { class: 'icon-btn', text, attrs: { href: buildHash('upload', { query: { month: ym(addMonths(monthStart, n)) } }), 'aria-label': label } }, [], doc);
  const head = h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav', attrs: { 'aria-label': '대상 달' } }, [
      nav(-1, '이전 달', '‹'), h('h1', { class: 'title', text: `${monthTitle(monthStart)} 올리기` }, [], doc), nav(1, '다음 달', '›'),
    ], doc),
  ], doc);
  const phone = isPhone(env);
  const banner = phone ? h('section', { class: 'card banner', attrs: { role: 'note' } }, [
    h('strong', { text: 'PC에서 올리는 것을 권해요.' }, [], doc),
    h('p', { class: 'small', text: '휴대폰에서는 큰 파일을 처리하다 멈출 수 있어요. 그래도 여기서 올릴 수 있어요.' }, [], doc),
  ], doc) : null;
  if (res.error) {
    onError?.(res.error, { stage: STAGES.db_select });
    return h('main', { class: 'screen' }, [head, banner, errorView(res.error.message, res.error.detail?.sqlState ?? res.error.code, doc)], doc);
  }
  const { sources, formats, categories, cpRules, missing, members } = res.data;
  const cats = categoryIndex(categories);
  const formatById = new Map(formats.map((f) => [f.id, f]));
  const catCodes = categories.filter((c) => c.code).map((c) => [c.code, c.id]);

  const status = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  const say = (msg, isError = false) => { status.textContent = msg; status.className = `status-line${isError ? ' error' : ''}`; };
  const files = []; // { key, name, bytes, hash, fileType, choices, sourceId, parsed, preview, resumed, state, message, result }
  const list = h('div', { class: 'upload-files' }, [], doc);
  const save = h('button', { class: 'btn primary', text: '저장', attrs: { type: 'button' } }, [], doc);
  let busy = false;

  const fail = (f, code) => { f.state = 'error'; f.message = readErrorText(code, phone); };

  async function prepare(f) {
    f.state = 'reading'; draw();
    const src = sources.find((s) => s.id === f.sourceId);
    const format = src && formatById.get(src.import_format_id);
    if (!format) { fail(f, 'format_mismatch'); draw(); return; }
    try {
      f.parsed = await runParseWorker({
        op: 'parse', bytes: f.bytes.slice().buffer, format, sourceId: src.id, categories: catCodes, counterpartyRules: cpRules,
      }, { env });
    } catch (e) {
      fail(f, e?.message); draw(); return;
    }
    const [batch, keys] = await Promise.all([
      db.select('import_batches', { columns: 'id', filters: [{ col: 'source_id', op: 'eq', value: src.id }, { col: 'file_hash', op: 'eq', value: f.hash }] }),
      existingKeys(db, f.parsed.rows),
    ]);
    const err = batch.error ?? keys.error;
    if (err) {
      const code = onError?.(err, { stage: STAGES.db_select });
      f.state = 'error'; f.message = `${err.message}${code ? ` (오류 번호 ${code})` : ''}`;
      draw(); return;
    }
    f.resumed = Boolean(batch.data?.length);
    f.keys = keys.data;
    f.preview = previewOf(f.parsed, f.keys);
    f.cards = src.kind === 'bank_account' ? counterpartyGroups(f.parsed.rows).map((g) => {
      const card = choiceCard({ categories, cats, direction: g.direction, later: true, labelPrefix: g.text }, doc);
      const c = { g, card, error: null, rule: null };
      card.onChange(() => reparse(f));
      return c;
    }) : [];
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
    const names = checkNames({ matchText: null, alias: input.alias });
    if (!names.ok) { c.error = names.message; return; }
    const v = choiceValues({
      choice: input.choice, categoryId: input.categoryId, direction: c.g.direction,
      sourceOwnerId: src?.owner_member_id ?? null, meId: member?.memberId ?? null, members,
    }, cats);
    if (!v.ok) { c.error = v.message; return; }
    c.rule = counterpartyRule(c.g, f.sourceId, v.value, names.value.alias);
  }

  /** 카드 값으로 다시 정규화(미리보기 숫자 반영). 늦게 온 앞 결과는 버린다 */
  async function reparse(f) {
    f.cards.forEach((c) => readCard(f, c));
    const drafts = f.cards.filter((c) => c.rule).map((c, i) => draftRule(c.rule, i));
    const src = sources.find((s) => s.id === f.sourceId);
    const format = formatById.get(src.import_format_id);
    const token = (f.token ?? 0) + 1;
    f.token = token;
    try {
      const parsed = await runParseWorker({
        op: 'parse', bytes: f.bytes.slice().buffer, format, sourceId: src.id, categories: catCodes, counterpartyRules: [...cpRules, ...drafts],
      }, { env });
      if (f.token !== token) return;
      f.parsed = parsed;
      f.preview = previewOf(parsed, f.keys);
    } catch (e) {
      if (f.token !== token) return;
      fail(f, e?.message);
    }
    draw();
  }

  async function addFiles(fileList) {
    const picked = [...fileList].slice(0, MAX_FILES - files.length);
    if (fileList.length > picked.length) say(`한 번에 ${MAX_FILES}개까지 올릴 수 있어요.`, true);
    for (const file of picked) {
      const f = { key: `${files.length}-${file.name}`, name: file.name, state: 'reading', choices: [] };
      files.push(f);
      draw();
      if (file.size > MAX_FILE_BYTES) { fail(f, 'too_big'); draw(); continue; }
      try {
        f.bytes = new Uint8Array(await file.arrayBuffer());
        f.hash = await fileHash(f.bytes);
        const d = await runParseWorker({ op: 'detect', bytes: f.bytes.slice().buffer, formats }, { env });
        f.fileType = d.fileType;
        const m = matchSources(d.formatIds, sources);
        f.choices = m.choices;
        if (!m.choices.length) { f.state = 'nomatch'; draw(); continue; }
        if (!m.autoId) { f.state = 'choose'; draw(); continue; }
        f.sourceId = m.autoId;
      } catch (e) {
        fail(f, e?.message); draw(); continue;
      }
      await prepare(f);
    }
  }

  function fileCard(f) {
    const title = h('p', { class: 'upload-name', text: f.name }, [], doc);
    const body = [];
    if (f.state === 'reading') body.push(h('p', { class: 'muted small', text: '읽는 중…' }, [], doc));
    if (f.state === 'error') body.push(h('p', { class: 'notice small', text: f.message }, [], doc));
    if (f.state === 'nomatch') body.push(h('p', { class: 'notice small', text: '맞는 결제수단이 없어 건너뛰어요. 결제수단의 파일 형식을 확인해 주세요.' }, [], doc));
    if (f.state === 'choose' || (f.choices.length > 1 && f.state !== 'reading' && f.state !== 'saved')) {
      const sel = h('select', { class: 'field', attrs: { 'aria-label': `${f.name} 결제수단` } }, [
        h('option', { text: '어느 결제수단 파일인가요?', attrs: { value: '' } }, [], doc),
        ...f.choices.map((c) => h('option', { text: c.label, attrs: { value: c.id } }, [], doc)),
      ], doc);
      sel.value = f.sourceId ?? '';
      sel.disabled = busy;
      sel.addEventListener('change', () => { if (sel.value) { f.sourceId = sel.value; f.result = null; prepare(f); } });
      body.push(sel);
    }
    if (f.state === 'ready' || f.state === 'saved') {
      const src = sources.find((s) => s.id === f.sourceId);
      const p = f.preview;
      body.push(
        h('p', { class: 'muted small', text: `${src?.label ?? ''}${f.resumed ? ' · 이미 올린 파일이라 빠진 행만 넣어요' : ''}` }, [], doc),
        h('p', { class: 'amount-l', text: `새로 ${p.newCount}건` }, [], doc),
        h('p', { class: 'muted small', text: `지출 합계(집계 제외 빼고) ${p.spendText} · 모두 검토 대기로 들어가요` }, [], doc),
        h('dl', { class: 'kv' }, previewLines(p).flatMap(([k, v]) => [h('dt', { text: k }, [], doc), h('dd', { text: v }, [], doc)]), doc),
      );
      if (f.cards?.length) {
        body.push(h('div', { class: 'cp-new' }, [
          h('h3', { class: 'card-title', text: `새 이체 상대 ${f.cards.length}` }, [], doc),
          h('p', { class: 'muted small', text: '고른 값은 규칙으로 저장돼 다음 달부터 자동으로 적용돼요. 나중에 고르면 검토 대기로 들어가요.' }, [], doc),
          ...f.cards.map((c) => h('div', { class: 'cp-new-item' }, [
            h('p', { class: 'rule-title', text: c.g.text }, [], doc),
            h('p', { class: 'muted small', text: `${c.g.direction === 'out' ? '보낼 때' : '받을 때'} · ${c.g.count}건 · ${c.g.totalText}` }, [], doc),
            c.card.el,
            c.error ? h('p', { class: 'notice small', text: c.error }, [], doc) : null,
          ], doc)),
        ], doc));
        f.cards.forEach((c) => c.card.setDisabled(busy || f.state === 'saved'));
      }
      if (p.errorCount) {
        body.push(h('p', { class: 'notice small', text: `읽지 못한 행 ${p.errorCount}줄: ${p.errorLines.join(', ')} (행 ${p.errorRows.join(', ')}${p.errorCount > p.errorRows.length ? ' …' : ''})` }, [], doc));
      }
    }
    if (f.result) {
      body.push(h('div', { class: 'upload-result', attrs: { role: 'status' } }, [
        ...resultLines(f.result).map((t) => h('p', { class: f.result.error ? 'notice small' : 'small', text: t }, [], doc)),
        failedRows(f.result).length ? h('p', { class: 'muted small', text: `넣지 못한 행: ${failedRows(f.result).join(', ')}` }, [], doc) : null,
      ], doc));
    }
    const remove = h('button', { class: 'btn mini', text: '빼기', attrs: { type: 'button', 'aria-label': `${f.name} 빼기` } }, [], doc);
    remove.disabled = busy || f.state === 'reading' || f.state === 'saved';
    remove.addEventListener('click', () => { files.splice(files.indexOf(f), 1); draw(); });
    return h('section', { class: `card upload-file ${f.state}` }, [h('div', { class: 'card-head' }, [title, f.state === 'saved' ? null : remove], doc), ...body], doc);
  }

  function draw() {
    list.replaceChildren(...files.map(fileCard));
    const ready = files.filter((f) => f.state === 'ready');
    const total = ready.reduce((s, f) => s + f.preview.newCount, 0);
    save.textContent = ready.length ? `${ready.length}개 파일 · 새로 ${total}건 저장` : '저장';
    const cardErrors = ready.some((f) => f.cards?.some((c) => c.error));
    save.disabled = busy || ready.length === 0 || cardErrors || files.some((f) => f.state === 'reading');
    if (cardErrors) say('새 이체 상대에서 고를 값을 마저 골라 주세요.', true);
    picker.disabled = busy;
  }

  async function saveAll() {
    const ready = files.filter((f) => f.state === 'ready');
    const total = ready.reduce((s, f) => s + f.preview.newCount, 0);
    if (!(await confirmDialog({
      title: '올리기',
      message: `${ready.length}개 파일에서 새로 ${total}건을 ${monthTitle(monthStart).replace(' 파일', '')}분으로 넣어요. 모두 검토 대기로 들어가요.`,
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
        const { batchId } = await ensureBatch(db, guard, {
          sourceId: src.id, targetMonth: monthStart, fileHash: f.hash,
          fileName: batchFileName(src.institution, monthStart, f.fileType),
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
    done.hidden = okCount === 0;
  }
  save.addEventListener('click', saveAll);

  const input = h('input', { class: 'visually-hidden', attrs: { type: 'file', multiple: true, accept: ACCEPT, id: 'upload-input', 'aria-label': '파일 고르기' } }, [], doc);
  input.addEventListener('change', () => { const fl = input.files; if (fl?.length) addFiles(fl); input.value = ''; });
  const picker = h('button', { class: 'btn secondary', text: '+ 파일 고르기', attrs: { type: 'button' } }, [], doc);
  picker.addEventListener('click', () => input.click());
  const done = h('a', { class: 'btn secondary', text: '내역에서 보기', attrs: { href: buildHash('list', { query: { month: ym(monthStart), status: 'needs_review' } }) } }, [], doc);
  done.hidden = true;

  const missingCard = h('section', { class: 'card' }, [
    h('h2', { class: 'card-title', text: missing.length ? `아직 안 올린 결제수단 ${missing.length}개` : '이 달 파일은 다 올렸어요' }, [], doc),
    missing.length ? h('ul', { class: 'plain-list' }, missing.map((m) => h('li', { text: m.label }, [], doc)), doc) : null,
  ], doc);

  draw();
  return h('main', { class: 'screen' }, [
    head, banner, status,
    h('section', { class: 'card' }, [
      h('p', { text: `${monthTitle(monthStart)}을 골라 주세요. 여러 개를 한 번에 골라도 돼요.` }, [], doc),
      h('p', { class: 'muted small', text: '파일은 이 기기 밖으로 나가지 않아요. 읽은 거래만 저장해요.' }, [], doc),
      picker, input,
    ], doc),
    missingCard, list, save, done,
  ], doc);
}
