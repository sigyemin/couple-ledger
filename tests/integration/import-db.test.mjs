// 통합 시험: 정규화 → 업로드(묶음·import_transactions) → 로컬 PostgreSQL에 설치한 스키마
// 스키마 파일은 이 저장소에 없다. 로컬에서 새 DB에 Supabase 흉내 + 스키마(v0.17)를 설치한 뒤
//   CL_PG_DB='host=/var/tmp/pgsock port=5433 dbname=cl_import user=postgres' node --test tests/integration/import-db.test.mjs
// 로 실행한다. CL_PG_DB가 없으면 건너뛴다(CI). 매번 새로 만든 빈 DB에서 돌린다. 합성 데이터만.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { normalizeRows } from '../../app/import/normalize.js';
import { findHeader } from '../../app/import/formats.js';
import { parseFile } from '../../app/import/pipeline.js';
import { fileHash } from '../../app/import/dedup.js';
import { ensureBatch, uploadRows, batchFileName } from '../../app/import/upload.js';
import { toAppError } from '../../app/core/errors.js';
import { XLSX, SOURCE, FORMAT_A, FORMAT_B, bookBytes, sheetA, sheetB } from '../import/fixtures.mjs';

const CONN = process.env.CL_PG_DB;
const skip = CONN ? false : 'CL_PG_DB 없음 (로컬 PostgreSQL 통합 시험)';

const UID = '00000000-0000-4000-8000-0000000000f1';
const MEMBER = 'a0000000-0000-4000-8000-0000000000e1';
const SOURCE_B = 'a0000000-0000-4000-8000-0000000000b1';
const CLAIMS = JSON.stringify({ sub: UID, role: 'authenticated' });

/** psql 실행. vars는 :'name'으로 안전하게 인용된다. 결과 첫 줄(JSON) 또는 { error } */
function psql(sql, vars = {}, { asMember = true } = {}) {
  const args = ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate'];
  for (const [k, v] of Object.entries({ ...vars, claims: CLAIMS })) args.push('-v', `${k}=${v}`);
  args.push(CONN);
  const pre = asMember ? "\\set VERBOSITY sqlstate\nset role authenticated;\nset request.jwt.claims = :'claims';\n" : '\\set VERBOSITY sqlstate\n';
  const r = spawnSync('psql', args, { input: `${pre}${sql}\n`, encoding: 'utf8' });
  if (r.status !== 0) {
    const code = /ERROR:\s+([0-9A-Z]{5})/.exec(r.stderr)?.[1] ?? '';
    return { error: { code, message: r.stderr } };
  }
  return { out: r.stdout.trim() };
}

const json = (r) => (r.error ? { data: null, error: toAppError(r.error) } : { data: JSON.parse(r.out || 'null'), error: null });

// upload.js가 쓰는 db 모양(select·insert·rpc)만 psql로 흉내 낸다 (PostgREST 대신)
const pgDb = {
  async select(view, { filters }) {
    assert.equal(view, 'import_batches');
    const [s, h] = filters.map((f) => f.value);
    return json(psql("select coalesce(json_agg(json_build_object('id', id)), '[]') from import_batches where source_id = :'s'::uuid and file_hash = :'h';", { s, h }));
  },
  async insert(table, row) {
    assert.equal(table, 'import_batches');
    return json(psql(`insert into import_batches (source_id, target_month, file_name, file_hash, uploaded_by)
      values (:'s'::uuid, :'m'::date, :'n', :'h', :'u'::uuid) returning json_build_array(json_build_object('id', id));`,
    { s: row.source_id, m: row.target_month, n: row.file_name, h: row.file_hash, u: row.uploaded_by }));
  },
  async rpc(name, args) {
    assert.equal(name, 'import_transactions');
    return json(psql("select coalesce(json_agg(r), '[]') from import_transactions(:'b'::uuid, :'rows'::jsonb) r;",
      { b: args.p_batch_id, rows: JSON.stringify(args.p_rows) }));
  },
};

const q = (sql, vars) => {
  const r = psql(sql, vars, { asMember: false });
  if (r.error) throw new Error(r.error.message);
  return r.out;
};

async function upload(bytes, format, sourceId, categories, counterpartyRules = []) {
  const parsed = await parseFile(XLSX, bytes, { format, sourceId, categories, counterpartyRules });
  const hash = await fileHash(bytes);
  const { batchId, resumed } = await ensureBatch(pgDb, {
    sourceId, targetMonth: '2026-10-01', fileHash: hash, fileName: batchFileName(format.institution, '2026-10-01', parsed.fileType), memberId: MEMBER,
  });
  const res = await uploadRows(pgDb, batchId, parsed.rows, { chunkRows: 3 });
  return { parsed, batchId, resumed, ...res };
}

test('통합: 업로드·재업로드·겹치는 파일·카드 취소 자동 연결', { skip }, async () => {
  // 준비 (관리자 시점): 로그인 계정·구성원·결제수단·카테고리. 합성 값만
  q(`insert into auth.users (id, email) values (:'uid'::uuid, 'user-a@example.com');
     insert into members (id, member_slot, email, auth_user_id, display_name) values (:'mem'::uuid, 1, 'user-a@example.com', :'uid'::uuid, '사용자A');
     insert into payment_sources (id, owner_member_id, kind, institution, label, is_test)
       values (:'sa'::uuid, :'mem'::uuid, 'bank_account', '가상기관A', '시험 통장', true),
              (:'sb'::uuid, :'mem'::uuid, 'credit_card', '가상기관B', '시험 카드', true);
     insert into categories (name, code) values ('시험 이자', 'interest') on conflict do nothing;`,
  { uid: UID, mem: MEMBER, sa: SOURCE, sb: SOURCE_B });
  const catId = q("select id from categories where code = 'interest'");
  const categories = new Map([['interest', catId]]);
  // 이체 상대 규칙 1개(두 사람 간 송금)를 DB에 넣고, 앱이 읽는 모양(구성원 권한 select) 그대로 넘긴다
  q(`insert into counterparty_rules (match_field, match_text, match_type, source_id, direction, suggested_kind, suggested_exclude_reason, created_by)
     values ('merchant', '이시험', 'exact', :'sa'::uuid, 'out', 'transfer', 'personal_transfer', :'mem'::uuid)`, { sa: SOURCE, mem: MEMBER });
  const cpRules = JSON.parse(psql('select json_agg(r) from counterparty_rules r where is_active;').out);

  // 1) 형식 A(통장) 업로드: 정규화한 7행이 모두 들어간다
  const a = await upload(bookBytes(sheetA(), 'xlsx'), FORMAT_A, SOURCE, categories, cpRules);
  assert.equal(a.error, null);
  assert.equal(a.resumed, false);
  assert.deepEqual(a.counts, { inserted: 7, duplicate: 0, sensitive: 0, refund_invalid: 0, invalid: 0 });
  assert.equal(q("select row_count from import_batches where id = :'b'", { b: a.batchId }), '7');
  // DB 값이 정규화 결과와 같다 (키·금액·종류·제외·카드 구분·가림·raw 키)
  const db = JSON.parse(q(`select json_agg(json_build_object('k', dedup_key, 'amount', amount, 'kind', kind, 'card', card_kind,
      'ex', exclude_reason, 'm', merchant_raw, 'time', occurred_time::text, 'raw', raw) order by created_at, id)
      from transactions where batch_id = :'b'`, { b: a.batchId }));
  const byKey = new Map(db.map((x) => [x.k, x]));
  for (const row of a.parsed.rows) {
    const d = byKey.get(row.dedup_key);
    assert.ok(d, row.dedup_key);
    assert.equal(Number(d.amount), row.amount);
    assert.equal(d.kind, row.kind);
    assert.equal(d.card, row.card_kind);
    assert.equal(d.ex, row.exclude_reason);
    assert.equal(d.m, row.merchant_raw);
    assert.deepEqual(d.raw, row.raw);
  }
  assert.ok(db.some((x) => x.m === '김가짜 [숫자 가림]'));
  assert.deepEqual(db.filter((x) => x.m === '이시험').map((x) => [x.kind, x.ex]), [['transfer', 'personal_transfer'], ['transfer', 'personal_transfer']]);
  assert.equal(q("select count(*) from transactions where batch_id = :'b' and review_status <> 'needs_review'", { b: a.batchId }), '0');
  assert.equal(q("select count(*) from transaction_lines l join transactions t on t.id = l.txn_id where t.batch_id = :'b' and l.category_id = :'c'::uuid",
    { b: a.batchId, c: catId }), '1');

  // 2) 같은 파일 다시: 같은 묶음으로 이어 올리고 모두 duplicate
  const a2 = await upload(bookBytes(sheetA(), 'xlsx'), FORMAT_A, SOURCE, categories, cpRules);
  assert.equal(a2.resumed, true);
  assert.equal(a2.batchId, a.batchId);
  assert.deepEqual(a2.counts, { inserted: 0, duplicate: 7, sensitive: 0, refund_invalid: 0, invalid: 0 });

  // 3) 기간이 겹치는 다른 파일(앞 4줄 + 새 1줄): 새 묶음, 겹친 줄은 duplicate
  const sheet = sheetA();
  const overlap = [...sheet.slice(0, 7), ['2026.10.20 08:00', '이체', '박샘플', '7,000', '', '641,000', '']];
  const a3 = await upload(bookBytes(overlap, 'xlsx'), FORMAT_A, SOURCE, categories);
  assert.equal(a3.resumed, false);
  assert.deepEqual(a3.counts, { inserted: 1, duplicate: 4, sensitive: 0, refund_invalid: 0, invalid: 0 });

  // 4) 형식 B(카드, xls): 취소 행의 환불이 같은 승인번호 지출에 자동 연결된다
  const b = await upload(bookBytes(sheetB(), 'biff8'), FORMAT_B, SOURCE_B, categories);
  assert.deepEqual(b.counts, { inserted: 5, duplicate: 0, sensitive: 0, refund_invalid: 0, invalid: 0 });
  assert.deepEqual(b.failures, []);
  const links = JSON.parse(q(`select json_agg(json_build_object('a', r.approval_no, 'amt', r.amount, 'linked', o.approval_no) order by r.approval_no)
      from transactions r join transactions o on o.id = r.refund_of_txn_id where r.batch_id = :'b' and r.kind = 'refund'`, { b: b.batchId }));
  assert.deepEqual(links.map((x) => [x.a, Number(x.amt), x.linked]), [['87654321', 5000, '87654321'], ['AB12CD34', 600000, 'AB12CD34']]);

  // 5) 원거래가 먼저 들어가 있고 나중 파일에서 취소가 보이면: 원거래 duplicate, 환불만 새로 들어가 연결
  const later = sheetB().map((row) => (row[6] === '12345678' ? row.map((c, i) => (i === 7 ? '취소' : i === 8 ? '32,000' : c)) : row));
  const b2 = await upload(bookBytes(later, 'biff8'), FORMAT_B, SOURCE_B, categories);
  assert.deepEqual(b2.counts, { inserted: 1, duplicate: 5, sensitive: 0, refund_invalid: 0, invalid: 0 });
  assert.equal(q(`select count(*) from transactions r join transactions o on o.id = r.refund_of_txn_id
      where r.batch_id = :'b' and r.approval_no = '12345678' and o.kind = 'expense'`, { b: b2.batchId }), '1');

  // 6) DB가 거부하는 행은 결과로 돌아오고 파일 줄 번호로 바뀐다(정규화를 거치지 않은 행을 일부러 보냄)
  const bad = [{ ...a.parsed.rows[0], rowNo: 99, dedup_key: `k2:${'0'.repeat(63)}1`, merchant_raw: ['010', '1234', '5678'].join('-') }];
  const r6 = await uploadRows(pgDb, a.batchId, bad);
  assert.deepEqual(r6.failures, [{ rowNo: 99, result: 'sensitive', sqlState: 'LG002' }]);
});
