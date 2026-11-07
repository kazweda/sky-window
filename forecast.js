// UIに依存しない計算処理。ブラウザでは globalThis.Forecast として使う。
(function (root) {
  'use strict';

  const COMPASS = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
    '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];
  const RAD = Math.PI / 180;

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

  // 目的地を中心とした格子を、北西から南東へ行優先で返す。
  // 経度方向の幅は緯度で補正し、地図上でおおよそ正方形にする。
  function buildGrid(lat, lon, size = 9, latRadius = 1.2) {
    const lonRadius = latRadius / Math.max(Math.cos(lat * RAD), 0.2);
    const north = clamp(lat + latRadius, -85, 85);
    const south = clamp(lat - latRadius, -85, 85);
    const west = lon - lonRadius;
    const east = lon + lonRadius;
    const points = [];
    for (let row = 0; row < size; row++) {
      const pLat = north + ((south - north) * row) / (size - 1);
      for (let col = 0; col < size; col++) {
        const pLon = west + ((east - west) * col) / (size - 1);
        points.push({ lat: +pLat.toFixed(4), lon: +wrapLon(pLon).toFixed(4) });
      }
    }
    return { size, points, bounds: [[south, west], [north, east]] };
  }

  // 1時間ごとの値を線形補間する。片方が欠測なら、もう片方を使う。
  function valueAt(series, t) {
    const i = clamp(Math.floor(t), 0, series.length - 1);
    const j = Math.min(i + 1, series.length - 1);
    const a = series[i];
    const b = series[j];
    if (a == null) return b ?? null;
    if (b == null) return a;
    return a + (b - a) * (t - i);
  }

  // 格子を u,v(0〜1)で双線形補間する。欠測点は除いて重みを配分する。
  function sampleGrid(values, size, u, v) {
    const x = clamp(u, 0, 1) * (size - 1);
    const y = clamp(v, 0, 1) * (size - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, size - 1);
    const y1 = Math.min(y0 + 1, size - 1);
    const fx = x - x0;
    const fy = y - y0;
    const corners = [
      [values[y0 * size + x0], (1 - fx) * (1 - fy)],
      [values[y0 * size + x1], fx * (1 - fy)],
      [values[y1 * size + x0], (1 - fx) * fy],
      [values[y1 * size + x1], fx * fy],
    ];
    let sum = 0;
    let weight = 0;
    for (const [value, w] of corners) {
      if (value == null) continue;
      sum += value * w;
      weight += w;
    }
    return weight > 0 ? sum / weight : null;
  }

  const compassName = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

  // 気象の風向は「吹いてくる方角」なので、雲が流れる向きは180度反対になる。
  function windFlow(direction) {
    if (direction == null) return null;
    const toward = (direction + 180) % 360;
    return { from: compassName(direction), to: compassName(toward), arrowDeg: toward };
  }

  // APIの現地時刻文字列をエポックミリ秒へ変換する。
  const localToEpoch = (time, utcOffsetSeconds) =>
    Date.parse(`${time}:00Z`) - utcOffsetSeconds * 1000;

  // 太陽高度(度)の近似計算。観測可能な時間帯の判定に十分な精度。
  function sunAltitude(epochMs, lat, lon) {
    const d = epochMs / 86400000 + 2440587.5 - 2451545.0;
    const g = (357.529 + 0.98560028 * d) * RAD;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
    const e = (23.439 - 0.00000036 * d) * RAD;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const gmstDeg = (18.697374558 + 24.06570982441908 * d) * 15;
    const ha = (gmstDeg + lon) * RAD - ra;
    const phi = lat * RAD;
    return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha)) / RAD;
  }

  // 正午で区切った「夜」ごとに、暗くて雲の少ない連続時間のうち最良のものを返す。
  function findObservingWindows({ times, clouds, sunAlts, fromIndex = 0, maxCloud = 30, darkBelow = -18 }) {
    const runs = [];
    let run = null;
    for (let i = fromIndex; i < times.length; i++) {
      const ok = clouds[i] != null && clouds[i] <= maxCloud && sunAlts[i] < darkBelow;
      if (ok) {
        if (!run) run = { start: i, end: i, sum: 0 };
        run.end = i;
        run.sum += clouds[i];
      } else if (run) {
        runs.push(run);
        run = null;
      }
    }
    if (run) runs.push(run);

    const best = new Map();
    for (const r of runs) {
      const night = new Date(Date.parse(`${times[r.start]}:00Z`) - 12 * 3600000).toISOString().slice(0, 10);
      const item = { night, start: r.start, end: r.end, hours: r.end - r.start + 1, avgCloud: r.sum / (r.end - r.start + 1) };
      const cur = best.get(night);
      if (!cur || item.hours > cur.hours || (item.hours === cur.hours && item.avgCloud < cur.avgCloud)) {
        best.set(night, item);
      }
    }
    return [...best.values()].sort((a, b) => a.start - b.start);
  }

  root.Forecast = {
    buildGrid, valueAt, sampleGrid, windFlow, compassName, localToEpoch,
    sunAltitude, findObservingWindows, wrapLon,
  };
})(globalThis);
