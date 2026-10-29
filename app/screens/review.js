// =====================================================================
// 월 검토 (화면 설계 v0.1 4-5, 시안 7)
// 조회: v_monthly_summary(그 달), 그 달 거래(list.js readMonthRows), v_possible_duplicates(그 달 이용일), v_line_mismatch, categories
// 쓰기: 분류 → bulk_set_category(가맹점 묶음) / 둘 다 맞음 → transactions update(review_status = confirmed) 한 건씩
// 준비 중: 원거래를 못 찾은 환불(원거래 찾기 — 사용자 결정 U-13 대기), 아직 안 정한 이체 상대(규칙 화면 필요),
//          분류 뒤 "같은 가맹점 규칙 저장"(규칙 화면 필요)
// 의존: ui/dom.js, router.js, core/format.js, core/errors.js, screens/list.js, screens/review-model.js, screens/detail-model.js, screens/shell.js
// =====================================================================
import { h, widthClass } from '../ui/dom.js';
import { addMonths, buildHash } from '../router.js';
import { month } from '../core/format.js';
import { STAGES, ACTIONS } from '../core/errors.js';
import { readMonthRows } from './list.js';
import { progress, uncategorizedGroups, duplicateGroups, unlinkedRefundCount, mismatchItems, confirmBothPatch } from './review-model.js';
import { categoryOptions } from './detail-model.js';
import { errorView } from './shell.js';

let reviewNotice = null;

export async function loadReview(db, monthStart) {
  const eq = (col, value) => ({ col, op: 'eq', value });
  const [summary, rows, dups, mismatch, categories] = await Promise.all([
    db.select('v_monthly_summary', { columns: 'period_month,txn_count,needs_review_count,uncategorized_count,unlinked_refund_count', filters: [eq('period_month', monthStart)] }),
    readMonthRows(db, monthStart),
    db.select('v_possible_duplicates', {
      columns: 'source_id,occurred_on,merchant_norm,amount,kind,txn_count',
      filters: [{ col: 'occurred_on', op: 'gte', value: monthStart }, { col: 'occurred_on', op: 'lt', value: addMonths(monthStart, 1) }],
    }),
    db.select('v_line_mismatch', { columns: 'id,occurred_on,merchant_raw,amount,lines_amount' }),
    db.select('categories', { columns: 'id,parent_id,name,code,sort_order,is_active' }),
  ]);
  const error = [summary, rows, dups, mismatch, categories].find((r) => r.error)?.error;
  if (error) return { error };
  return {
    data: {
      summary: summary.data?.[0] ?? null, rows: rows.data.rows, capped: rows.data.capped,
      dups: dups.data ?? [], mismatch: mismatch.data ?? [], categories: categories.data ?? [],
    },
  };
}

/**
 * @param {{ db, member, monthStart, reload(), isCurrent(), onError(err, extra) → string }} ctx
 */
export async function renderReview({ db, member, monthStart, reload, isCurrent, onError }, doc = globalThis.document) {
  const res = await loadReview(db, monthStart);
  if (!isCurrent()) return null;
  const ym = (m) => m.slice(0, 7);
  const nav = (n, label, text) => h('a', { class: 'icon-btn', text, attrs: { href: buildHash('review', { query: { month: ym(addMonths(monthStart, n)) } }), 'aria-label': label } }, [], doc);
  const head = h('header', { class: 'screen-head' }, [
    h('nav', { class: 'month-nav', attrs: { 'aria-label': '달 선택' } }, [
      nav(-1, '이전 달', '‹'),
      h('h1', { class: 'title', text: `${month(monthStart).replace(/^[0-9]+년 /, '')} 검토` }, [], doc),
      nav(1, '다음 달', '›'),
    ], doc),
  ], doc);
  if (res.error) {
    onError?.(res.error);
    return h('main', { class: 'screen' }, [head, errorView(res.error.message, res.error.detail?.sqlState ?? res.error.code, doc)], doc);
  }
  const { summary, rows, capped, dups, mismatch, categories } = res.data;
  const status = h('p', { class: 'status-line', attrs: { role: 'status', 'aria-live': 'polite' } }, [], doc);
  const say = (msg, isError = false) => {
    status.textContent = msg;
    status.className = `status-line${isError ? ' error' : ''}`;
  };
  if (reviewNotice) { say(reviewNotice.text, reviewNotice.isError); reviewNotice = null; }
  const fail = (err, extra) => {
    const code = onError?.(err, extra);
    say(`${err.message}${code ? ` (오류 번호 ${code})` : ''}`, true);
  };
  const card = (title, children) => h('section', { class: 'card' }, [h('h2', { class: 'card-title', text: title }, [], doc), ...children], doc);
  const link = (text, href, sub) => h('a', { class: 'todo', attrs: { href } }, [
    h('span', { class: 'todo-text' }, [h('span', { text }, [], doc), sub ? h('span', { class: 'sub', text: sub }, [], doc) : null], doc),
    h('span', { class: 'chev', text: '›', attrs: { 'aria-hidden': 'true' } }, [], doc),
  ], doc);

  // 진행률
  const p = progress(summary);
  const progressCard = card('진행률', [
    h('p', { class: 'muted', text: p.text }, [], doc),
    h('span', { class: 'bar-track progress', attrs: { role: 'img', 'aria-label': `확인 ${Math.round(p.ratio * 100)}%` } }, [
      h('span', { class: `bar-fill ${widthClass(p.ratio)}` }, [], doc),
    ], doc),
    p.pending ? link('검토 대기 거래 보기', buildHash('list', { query: { month: ym(monthStart), status: 'needs_review' } })) : null,
    capped ? h('p', { class: 'muted small', text: '이 달 거래가 많아 앞 2,000건 안에서만 묶었어요.' }, [], doc) : null,
  ]);

  // 분류가 필요해요
  const groups = uncategorizedGroups(rows);
  const classifyCard = card(`분류가 필요해요${groups.length ? ` · ${groups.reduce((s, g) => s + g.count, 0)}건` : ''}`, [
    groups.length === 0 ? h('p', { class: 'muted', text: '검토 대기 중 분류가 필요한 거래가 없어요' }, [], doc)
      : h('ul', { class: 'review-groups' }, groups.map((g) => {
        const sel = h('select', { class: 'field', attrs: { 'aria-label': `${g.merchant} 카테고리` } }, [
          h('option', { text: '카테고리 고르기', attrs: { value: '' } }, [], doc),
          ...categoryOptions(categories, g.kind).map((grp) => h('optgroup', { attrs: { label: grp.group } },
            grp.items.map((it) => h('option', { text: it.name, attrs: { value: it.id } }, [], doc)), doc)),
        ], doc);
        const go = h('button', { class: 'btn secondary small-btn', text: `${g.count}건 바꾸기`, attrs: { type: 'button' } }, [], doc);
        go.addEventListener('click', async () => {
          if (!sel.value) { say('카테고리를 골라 주세요', true); return; }
          const name = sel.selectedOptions[0]?.textContent ?? '';
          go.disabled = true;
          const r = await db.rpc('bulk_set_category', { p_txn_ids: g.ids, p_category_id: sel.value, p_description: `월 검토 · ${g.merchant} → ${name}`.slice(0, 200) });
          if (r.error) { go.disabled = false; fail(r.error, { stage: STAGES.db_rpc, action: ACTIONS.bulk_edit }); return; }
          reviewNotice = { text: `${g.merchant} ${g.count}건을 '${name}'(으)로 분류했어요. 더보기 › 변경 기록에서 되돌릴 수 있어요.`, isError: false };
          reload();
        });
        return h('li', { class: 'review-group' }, [
          h('p', {}, [h('strong', { text: g.merchant }, [], doc), h('span', { class: 'sub', text: ` ${g.count}건 · ${g.amountText}` }, [], doc)], doc),
          h('div', { class: 'review-pick' }, [sel, go], doc),
        ], doc);
      }), doc),
    h('p', { class: 'muted small', text: '같은 가맹점 규칙으로 저장하기는 규칙 화면과 함께 열어요(준비 중).' }, [], doc),
  ]);

  // 같은 거래일 수도 있어요
  const dupGroups = duplicateGroups(dups, rows);
  const dupCard = card(`같은 거래일 수도 있어요${dupGroups.length ? ` · ${dupGroups.length}묶음` : ''}`, [
    dupGroups.length === 0 ? h('p', { class: 'muted', text: '겹쳐 보이는 거래가 없어요' }, [], doc)
      : h('ul', { class: 'review-groups' }, dupGroups.map((g) => {
        const ok = h('button', { class: 'btn secondary small-btn', text: '둘 다 맞음', attrs: { type: 'button' } }, [], doc);
        ok.addEventListener('click', async () => {
          ok.disabled = true;
          let done = 0;
          for (const id of g.pendingIds) {
            const r = await db.update('transactions', id, confirmBothPatch(member.memberId));
            if (r.error || !r.data?.length) {
              ok.disabled = false;
              if (r.error) fail(r.error, { stage: STAGES.db_update, txnId: id });
              else say('저장하지 못했어요. 새로고침해 주세요.', true);
              if (done) reload();
              return;
            }
            done += 1;
          }
          reviewNotice = { text: '둘 다 맞는 거래로 확인했어요.', isError: false };
          reload();
        });
        return h('li', { class: 'review-group' }, [
          h('p', {}, [h('strong', { text: g.title }, [], doc)], doc),
          h('ul', {}, g.items.map((it) => h('li', {}, [link(it.text, buildHash('txn', { id: it.id }), '하나가 잘못 들어왔으면 상세에서 휴지통으로')], doc)), doc),
          ok,
        ], doc);
      }), doc),
  ]);

  // 원거래를 못 찾은 환불 (준비 중)
  const unlinked = unlinkedRefundCount(summary);
  const refundCard = card(`원거래를 못 찾은 환불${unlinked ? ` · ${unlinked}건` : ''}`, [
    h('p', { class: 'muted', text: unlinked ? '원거래 찾기 화면은 준비 중이에요.' : '못 찾은 환불이 없어요' }, [], doc),
    unlinked ? link('환불 목록 보기', buildHash('list', { query: { month: ym(monthStart), kind: 'refund_unlinked' } })) : null,
  ]);

  // 아직 안 정한 이체 상대 (준비 중)
  const counterpartyCard = card('아직 안 정한 이체 상대', [h('p', { class: 'muted', text: '이체 상대 지정은 규칙 화면과 함께 열어요(준비 중).' }, [], doc)]);

  // 나눈 금액이 안 맞는 거래
  const mm = mismatchItems(mismatch, rows);
  const mismatchCard = card(`나눈 금액이 안 맞는 거래${mm.length ? ` · ${mm.length}건` : ''}`, [
    mm.length === 0 ? h('p', { class: 'muted', text: '없어요' }, [], doc)
      : h('ul', { class: 'todo-list' }, mm.map((m) => h('li', {}, [link(m.text, buildHash('txn', { id: m.id }), m.sub)], doc)), doc),
  ]);

  return h('main', { class: 'screen' }, [head, status, progressCard, classifyCard, dupCard, refundCard, counterpartyCard, mismatchCard], doc);
}
