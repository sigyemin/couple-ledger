// xlsx 압축 해제 크기 선검사 (CL-033). ZIP은 모두 실행 중에 만든 합성 자료
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { XLSX } from './fixtures.mjs';
import { checkZipSize, readCentralDirectory, MAX_UNZIPPED_BYTES, MAX_ZIP_ENTRIES } from '../../app/import/zip-check.js';
import { readGrid } from '../../app/import/pipeline.js';

const MB = 2 ** 20;

/**
 * 작은 ZIP 작성기. 항목: { name, data(Uint8Array), method = 8, cenUsz?, locUsz?, flags = 0, dd = false, cenCsz? }
 * dd = true면 로컬 머리의 크기를 0으로 두고 데이터 디스크립터를 붙인다
 */
function zip(items, { zip64Count = false } = {}) {
  const parts = [];
  const cen = [];
  let off = 0;
  for (const it of items) {
    const method = it.method ?? 8;
    const comp = method === 8 ? deflateRawSync(it.data) : it.data;
    const name = Buffer.from(it.name);
    const flags = (it.flags ?? 0) | (it.dd ? 8 : 0);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(flags, 6); loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(it.dd ? 0 : comp.length, 18); loc.writeUInt32LE(it.dd ? 0 : (it.locUsz ?? it.data.length), 22);
    loc.writeUInt16LE(name.length, 26);
    const desc = it.dd ? Buffer.alloc(16) : Buffer.alloc(0);
    if (it.dd) { desc.writeUInt32LE(0x08074b50, 0); desc.writeUInt32LE(comp.length, 8); desc.writeUInt32LE(it.data.length, 12); }
    parts.push(loc, name, comp, desc);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(flags, 8); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(it.cenCsz ?? comp.length, 20); c.writeUInt32LE(it.cenUsz ?? it.data.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(off, 42);
    cen.push(c, name);
    off += 30 + name.length + comp.length + desc.length;
  }
  const cd = Buffer.concat(cen);
  const e = Buffer.alloc(22);
  const n = zip64Count ? 0xffff : items.length;
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(n, 8); e.writeUInt16LE(n, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, e]));
}

const zeros = (n) => new Uint8Array(n);
const text = (s) => new Uint8Array(Buffer.from(s));

test('상한 근거: 2만 행 × 15열 합성 xlsx는 풀어도 상한의 1/4 아래이고 통과', async () => {
  const rows = [Array.from({ length: 15 }, (_, i) => `열${i}`)];
  for (let r = 0; r < 20000; r++) rows.push(Array.from({ length: 15 }, (_, c) => (c % 3 === 0 ? `가맹점${(r * 7 + c) % 997}` : (r * 13 + c) % 100000)));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S');
  const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }));
  const total = await checkZipSize(bytes);
  assert.ok(total > 2 * MB && total < MAX_UNZIPPED_BYTES / 4, `${(total / MB).toFixed(1)}MB`);
  assert.equal(readCentralDirectory(bytes).length < 30, true);
});

test('정상: 작은 xlsx·저장(무압축) 항목·데이터 디스크립터 항목', async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 1]]), 'S');
  assert.ok(await checkZipSize(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }))) > 0);
  assert.equal(await checkZipSize(zip([{ name: 'a.xml', data: text('<a/>'), method: 0 }, { name: 'b.xml', data: text('<b>bb</b>'), dd: true }])), 13);
});

test('폭탄: 머리에 적힌 크기가 커도, 작게 속여도 실제로 세어 막는다', async () => {
  const big = zeros(MAX_UNZIPPED_BYTES + 1);
  const honest = zip([{ name: 'xl/worksheets/sheet1.xml', data: big }]);
  assert.ok(honest.length < MB, '압축하면 작다');
  assert.throws(() => readCentralDirectory(honest), { message: 'zip_too_large' });
  await assert.rejects(checkZipSize(honest), { message: 'zip_too_large' });
  // 중앙 디렉터리·로컬 머리 크기를 작게 속임(SheetJS가 믿는 로컬 크기 포함)
  await assert.rejects(checkZipSize(zip([{ name: 's.xml', data: big, cenUsz: 10, locUsz: 10 }])), { message: 'zip_too_large' });
  // 데이터 디스크립터(로컬 크기 0 → SheetJS가 출력 버퍼를 끝없이 늘리는 경우)
  await assert.rejects(checkZipSize(zip([{ name: 's.xml', data: big, dd: true, cenUsz: 10 }])), { message: 'zip_too_large' });
  // 항목 여러 개의 합계
  const half = zeros(MAX_UNZIPPED_BYTES / 2 + 1);
  await assert.rejects(checkZipSize(zip([{ name: 'a', data: half, cenUsz: 1 }, { name: 'b', data: half, cenUsz: 1 }])), { message: 'zip_too_large' });
});

test('구조: 항목 수 상한, 암호화·모르는 방식·ZIP64·잘림·쓰레기 붙음은 거부', async () => {
  const many = zip(Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `f${i}`, data: text('x'), method: 0 })));
  assert.throws(() => readCentralDirectory(many), { message: 'zip_too_large' });
  const one = { name: 'a.xml', data: text('<a>가나다</a>'.repeat(50)) };
  await assert.rejects(checkZipSize(zip([{ ...one, flags: 1 }])), { message: 'unsupported_file' });
  await assert.rejects(checkZipSize(zip([{ ...one, method: 12 }])), { message: 'unsupported_file' });
  await assert.rejects(checkZipSize(zip([one], { zip64Count: true })), { message: 'unsupported_file' });
  await assert.rejects(checkZipSize(zip([{ ...one, dd: true, cenCsz: 5 }])), { message: 'unsupported_file' }, '압축 자료가 잘림');
  const ok = zip([one]);
  await assert.rejects(checkZipSize(ok.subarray(0, ok.length - 30)), { message: 'unsupported_file' }, '끝 레코드 없음');
  await assert.rejects(checkZipSize(text('PK\u0003\u0004 not a zip at all, just text padding....')), { message: 'unsupported_file' });
});

test('DecompressionStream이 없으면 통과시키지 않는다', async () => {
  await assert.rejects(checkZipSize(zip([{ name: 'a', data: text('<a/>') }]), { env: {} }), { message: 'unsupported_file' });
});

test('SheetJS 경로와 같이: 선검사를 통과한 파일은 readGrid가 읽는다', async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['날짜', '금액'], ['2026-10-01', '1000']]), 'S');
  const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }));
  await checkZipSize(bytes);
  assert.equal(readGrid(XLSX, bytes).grid.length, 2);
});
