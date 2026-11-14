const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// バージョン番号の正本は CHANGELOG.md の最新の版。フッターの表示がそれと一致しているかを確かめる。
// キャッシュ対策のクエリは版の番号とは別で、配信のときに ?v=__BUILD__ をコミットの ID に置き換える(pages.yml)。
const root = path.join(__dirname, '..');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const latest = (changelog.match(/^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/m) || [])[1];

test('CHANGELOG に [Unreleased] と、日付付きの最新の版がある', () => {
  assert.match(changelog, /^## \[Unreleased\]$/m);
  assert.ok(latest, '「## [x.y.z] - YYYY-MM-DD」の見出しが見つからない');
  assert.ok(changelog.indexOf('## [Unreleased]') < changelog.indexOf(`## [${latest}]`), '[Unreleased] は最新の版より上に置く');
  assert.match(changelog, new RegExp(`^\\[${latest.replace(/\./g, '\\.')}\\]: .+/v${latest}$`, 'm'), '最新の版へのリンクがない');
});

test('自前の JS と CSS は、すべて ?v=__BUILD__ 付きで読み込む', () => {
  const refs = [...html.matchAll(/(?:src|href)="(?!https?:|\/\/)([^"]+\.(?:js|css))(?:\?v=([^"]*))?"/g)];
  const files = refs.map((m) => m[1]).sort();
  assert.deepEqual(files, ['app.js', 'forecast.js', 'places.js', 'style.css']);
  for (const [, file, v] of refs) assert.equal(v, '__BUILD__', `${file} に ?v=__BUILD__ が付いていない`);
});

test('フッターに最新の版の番号を表示する', () => {
  assert.match(html, new RegExp(`<p class="version">FineStella v${latest.replace(/\./g, '\\.')} `));
});
