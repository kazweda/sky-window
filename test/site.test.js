const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// index.html とマニフェストが参照するファイルが存在し、配信(pages.yml)でコピーされるかを確かめる。
// 配信では決めたファイルだけをコピーするので、ファイルを足したときにコピーの対象から漏れやすい。
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('index.html');
const manifest = JSON.parse(read('manifest.webmanifest'));
const workflow = read('.github/workflows/pages.yml');

const localRefs = [
  ...[...html.matchAll(/(?:src|href)="(?!https?:|\/\/|#)([^"?]+)(?:\?[^"]*)?"/g)].map((m) => m[1]),
  ...manifest.icons.map((i) => i.src),
];

// pages.yml の cp の行から、コピーするファイルとディレクトリを取り出す。
const copied = workflow.split('\n')
  .filter((line) => /^\s*cp\s/.test(line))
  .flatMap((line) => line.trim().split(/\s+/).slice(1).filter((w) => !w.startsWith('-') && w !== '_site/'));

test('index.html とマニフェストが参照するファイルがすべて存在する', () => {
  assert.ok(localRefs.length >= 8);
  for (const ref of localRefs) assert.ok(fs.existsSync(path.join(root, ref)), `${ref} がない`);
});

test('参照するファイルはすべて配信でコピーされる', () => {
  for (const ref of ['index.html', ...localRefs]) {
    const ok = copied.some((c) => ref === c || ref.startsWith(`${c.replace(/\/$/, '')}/`));
    assert.ok(ok, `${ref} が pages.yml でコピーされていない`);
  }
});

// robots.txt は HTML から参照されないので、上のテストでは漏れに気づけない。
// ないと GitHub Pages がまれに 503 を返し、Facebook が共有のプレビューを取れなくなる。
test('robots.txt があり、配信でコピーされる', () => {
  assert.ok(fs.existsSync(path.join(root, 'robots.txt')));
  assert.ok(copied.includes('robots.txt'), 'robots.txt が pages.yml でコピーされていない');
});

test('共有のプレビュー画像は絶対 URL で、公開サイトの配信先を指す', () => {
  const image = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1];
  assert.equal(image, 'https://skywindow.netplan.jp/assets/og-image.png');
  assert.ok(fs.existsSync(path.join(root, 'assets/og-image.png')));
});
