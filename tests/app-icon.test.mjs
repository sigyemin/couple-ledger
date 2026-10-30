// 앱 아이콘·설치(manifest) — CL-043. 서비스 워커·오프라인 캐시는 두지 않는다(데이터 기기 저장 금지 원칙)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root));

/** PNG 머리에서 가로·세로 */
function pngSize(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG 서명');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

test('manifest: 이름·standalone·start_url·scope·색·아이콘(192·512·maskable 512) 실제 크기 일치', () => {
  const m = JSON.parse(read('manifest.webmanifest').toString('utf8'));
  assert.deepEqual([m.name, m.display, m.start_url, m.scope], ['공동 가계부', 'standalone', './', './']);
  assert.match(m.theme_color, /^#[0-9A-F]{6}$/);
  assert.match(m.background_color, /^#[0-9A-F]{6}$/);
  const want = [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']];
  assert.deepEqual(m.icons.map((i) => [i.sizes, i.purpose]), want);
  for (const i of m.icons) {
    assert.equal(i.type, 'image/png');
    assert.match(i.src, /^icons\/[a-z0-9-]+\.png$/);
    assert.deepEqual(pngSize(read(i.src)).join('x'), i.sizes);
  }
  assert.deepEqual(pngSize(read('icons/apple-touch-icon-180.png')), [180, 180]);
});

test('index.html: manifest·icon·apple-touch-icon·theme-color 연결, CSP manifest-src·img-src self', () => {
  const html = read('index.html').toString('utf8');
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /<link rel="icon" type="image\/png" sizes="192x192" href="icons\/icon-192\.png">/);
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="icons\/apple-touch-icon-180\.png">/);
  assert.match(html, /<meta name="theme-color" content="#F2F4F6">/);
  assert.match(html, /manifest-src 'self'/);
  assert.match(html, /img-src 'self'/);
});

test('서비스 워커 없음: 앱 코드에 serviceWorker 등록이 없다', () => {
  const walk = (dir) => readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(`${dir}${d.name}/`) : [`${dir}${d.name}`]));
  const hits = walk('app/').filter((p) => p.endsWith('.js') && /serviceWorker/.test(read(p).toString('utf8')));
  assert.deepEqual(hits, []);
});
