const test = require('node:test');
const assert = require('node:assert/strict');
require('../forecast.js');
const F = globalThis.Forecast;

test('格子は北西から南東へ並び、中心が目的地になる', () => {
  const g = F.buildGrid(36, 138, 9, 1);
  assert.equal(g.points.length, 81);
  assert.equal(g.points[0].lat, 37);
  assert.ok(g.points[0].lon < 138);
  assert.deepEqual(g.points[40], { lat: 36, lon: 138 });
  assert.equal(g.points[80].lat, 35);
  assert.ok(g.points[80].lon > 138);
});

test('日付変更線をまたぐ格子は経度が折り返される', () => {
  const g = F.buildGrid(0, 179.5, 3, 1);
  for (const p of g.points) assert.ok(p.lon >= -180 && p.lon <= 180);
  assert.ok(g.points[2].lon < 0);
});

test('時刻の補間は欠測を飛ばす', () => {
  assert.equal(F.valueAt([0, 100], 0.25), 25);
  assert.equal(F.valueAt([null, 100], 0.5), 100);
  assert.equal(F.valueAt([40, null], 0.5), 40);
  assert.equal(F.valueAt([null, null], 0.5), null);
  assert.equal(F.valueAt([1, 2], 5), 2);
});

test('格子の補間は角と中間の値を返し、欠測を除外する', () => {
  const v = [0, 100, 100, 0];
  assert.equal(F.sampleGrid(v, 2, 0, 0), 0);
  assert.equal(F.sampleGrid(v, 2, 1, 0), 100);
  assert.equal(F.sampleGrid(v, 2, 0.5, 0.5), 50);
  assert.equal(F.sampleGrid([null, 80, null, 80], 2, 0.5, 0.5), 80);
  assert.equal(F.sampleGrid([null, null, null, null], 2, 0.5, 0.5), null);
});

test('西風の雲は東へ流れる', () => {
  const f = F.windFlow(270);
  assert.equal(f.from, '西');
  assert.equal(f.to, '東');
  assert.equal(f.arrowDeg, 90);
  assert.equal(F.windFlow(null), null);
  assert.equal(F.compassName(359), '北');
});

test('現地時刻をエポックへ変換する', () => {
  assert.equal(F.localToEpoch('2026-11-07T09:00', 32400), Date.UTC(2026, 10, 7, 0, 0));
});

test('太陽高度はAPIの日の出・日の入り時刻と整合する', () => {
  // Open-Meteo: 36N 138E 2026-11-07 日の出06:15 日の入り16:47 (JST)
  const at = (s) => F.sunAltitude(F.localToEpoch(s, 32400), 36, 138);
  assert.ok(Math.abs(at('2026-11-07T06:15') + 0.83) < 0.6);
  assert.ok(Math.abs(at('2026-11-07T16:47') + 0.83) < 0.6);
  assert.ok(at('2026-11-07T12:00') > 30);
  assert.ok(at('2026-11-07T23:59') < -18);
});

test('観測候補は夜ごとに最長の晴れ間を選び、日をまたいでも同じ夜として扱う', () => {
  const times = ['2026-11-07T20:00', '2026-11-07T21:00', '2026-11-07T22:00', '2026-11-07T23:00',
    '2026-11-08T00:00', '2026-11-08T01:00', '2026-11-08T12:00', '2026-11-08T20:00'];
  const clouds = [10, 90, 20, 20, 20, 90, 0, 5];
  const sunAlts = [-30, -30, -30, -30, -30, -30, 40, -30];
  const w = F.findObservingWindows({ times, clouds, sunAlts });
  assert.equal(w.length, 2);
  assert.deepEqual([w[0].night, w[0].start, w[0].end, w[0].hours], ['2026-11-07', 2, 4, 3]);
  assert.deepEqual([w[1].night, w[1].start], ['2026-11-08', 7]);
});

test('観測候補は昼と欠測を除外し、開始位置を守る', () => {
  const times = ['2026-11-07T20:00', '2026-11-07T21:00', '2026-11-07T22:00'];
  const sunAlts = [-30, -30, 10];
  assert.deepEqual(F.findObservingWindows({ times, clouds: [null, 50, 0], sunAlts }), []);
  const w = F.findObservingWindows({ times, clouds: [0, 0, 0], sunAlts, fromIndex: 1 });
  assert.equal(w[0].start, 1);
  assert.equal(w[0].hours, 1);
});
