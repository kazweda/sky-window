const test = require('node:test');
const assert = require('node:assert/strict');
require('../places.js');
const P = globalThis.Places;

const feature = (title, lon, lat, props = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { title, addressCode: '', ...props },
});

test('入力の一部しか合わない地名を除き、一致する地名を上にする', () => {
  const results = P.rankGsiResults([
    feature('千葉県成田市高', 140.37, 35.88),
    feature('奈良県香芝市高', 135.70, 34.55),
    feature('高縄半島', 132.87, 33.98, { addressCode: '38201', dataSource: '4' }),
    feature('高縄山', 132.85, 33.94, { addressCode: '38201', dataSource: '4' }),
  ], '高縄山');
  assert.deepEqual(results, [{ name: '高縄山', label: '高縄山、愛媛県', lat: 33.94, lon: 132.85, strong: true }]);
});

test('市を最上位にし、同じ地点の重複をまとめる', () => {
  const results = P.rankGsiResults([
    feature('青森県横浜', 141.247, 41.083),
    feature('青森県上北郡横浜町', 141.247, 41.083),
    feature('神奈川県横浜市', 139.634, 35.45),
    feature('横浜水道', 139.506, 35.366, { addressCode: '14110', dataSource: '4' }),
  ], '横浜');
  assert.deepEqual(results.map((r) => r.label), ['神奈川県横浜市', '青森県横浜', '横浜水道、神奈川県']);
  assert.equal(results[0].name, '横浜市');
});

test('住所の末尾が一致する地名を同名の別の地名より上にし、約1km以内の施設はまとめる', () => {
  const results = P.rankGsiResults([
    feature('野辺山原', 138.462, 35.966, { addressCode: '20305', dataSource: '4' }),
    feature('野辺山', 141.779, 39.918, { addressCode: '3484', dataSource: '4' }),
    feature('長野県南牧村野辺山', 138.467, 35.949),
    feature('野辺山駅', 138.475, 35.955, { addressCode: '20305', dataSource: '1' }),
  ], '野辺山');
  assert.deepEqual(results.map((r) => r.label), ['長野県南牧村野辺山', '野辺山、岩手県', '野辺山原、長野県']);
});

test('施設名は地名より下にし、施設しか合わないときは弱い一致とする', () => {
  const results = P.rankGsiResults([
    feature('ハッピーバレーＧＣ札幌', 141.5, 42.9, { addressCode: '1217', dataSource: '1' }),
    feature('札幌岳', 141.201, 42.9, { addressCode: '1106', dataSource: '4' }),
  ], '札幌');
  assert.deepEqual(results.map((r) => [r.label, r.strong]), [['札幌岳、北海道', true], ['ハッピーバレーGC札幌、北海道', false]]);
});

test('全角英数字や空白の違いを無視し、件数を絞る', () => {
  const many = Array.from({ length: 10 }, (_, i) => feature(`八ヶ岳ＣＣ${i}`, 138 + i, 36, { dataSource: '1' }));
  assert.equal(P.rankGsiResults(many, ' 八ヶ岳CC ').length, 6);
  assert.deepEqual(P.rankGsiResults(many, ''), []);
});

test('市区町村コードから都道府県を求める', () => {
  assert.equal(P.prefFromCode('3203'), '岩手県');
  assert.equal(P.prefFromCode(1106), '北海道');
  assert.equal(P.prefFromCode('47201'), '沖縄県');
  assert.equal(P.prefFromCode(''), '');
});
