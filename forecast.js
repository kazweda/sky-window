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
  // Open-Meteo は1地点ごとに API の利用回数を数えるため、点の数(size×size)を抑えている。
  function buildGrid(lat, lon, size = 7, latRadius = 1.2) {
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

  // 1時間ごとの時刻(エポックミリ秒)のうち、nowMs を含む時刻の番号。予報の範囲外なら端に寄せる。
  function currentIndex(epochs, nowMs) {
    if (!epochs.length) return 0;
    return clamp(Math.floor((nowMs - epochs[0]) / 3600000), 0, epochs.length - 1);
  }

  // 予報を取り直したとき、見ていた時刻が新しい時刻軸の何番目かを返す。見つからなければ null。
  // 時刻軸は「今日の0時」から始まるので、日付が変わると同じ時刻でも番号がずれる。
  function reindexTime(oldTimes, newTimes, t) {
    const i = Math.round(t);
    const j = newTimes.indexOf(oldTimes[i]);
    return j < 0 ? null : j + (t - i);
  }

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

  // 月の地心での黄経・黄緯(ラジアン)と距離(地球半径)。主な摂動項を加えた簡略式で、誤差は数分角程度。
  // 出典: Paul Schlyter "How to compute planetary positions"。
  function moonEcliptic(epochMs) {
    const d = epochMs / 86400000 + 2440587.5 - 2451543.5;
    const N = (125.1228 - 0.0529538083 * d) * RAD;
    const inc = 5.1454 * RAD;
    const w = (318.0634 + 0.1643573223 * d) * RAD;
    const e = 0.0549;
    const M = (115.3654 + 13.0649929509 * d) * RAD;
    let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
    for (let k = 0; k < 3; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const xv = 60.2666 * (Math.cos(E) - e);
    const yv = 60.2666 * Math.sqrt(1 - e * e) * Math.sin(E);
    const v = Math.atan2(yv, xv);
    let r = Math.hypot(xv, yv);
    const xh = r * (Math.cos(N) * Math.cos(v + w) - Math.sin(N) * Math.sin(v + w) * Math.cos(inc));
    const yh = r * (Math.sin(N) * Math.cos(v + w) + Math.cos(N) * Math.sin(v + w) * Math.cos(inc));
    const zh = r * Math.sin(v + w) * Math.sin(inc);
    let lon = Math.atan2(yh, xh) / RAD;
    let lat = Math.atan2(zh, Math.hypot(xh, yh)) / RAD;

    const Ms = (356.047 + 0.9856002585 * d) * RAD;
    const Ls = Ms + (282.9404 + 4.70935e-5 * d) * RAD;
    const Lm = M + w + N;
    const D = Lm - Ls;
    const F = Lm - N;
    const s = Math.sin;
    lon += -1.274 * s(M - 2 * D) + 0.658 * s(2 * D) - 0.186 * s(Ms) - 0.059 * s(2 * M - 2 * D)
      - 0.057 * s(M - 2 * D + Ms) + 0.053 * s(M + 2 * D) + 0.046 * s(2 * D - Ms) + 0.041 * s(M - Ms)
      - 0.035 * s(D) - 0.031 * s(M + Ms) - 0.015 * s(2 * F - 2 * D) + 0.011 * s(M - 4 * D);
    lat += -0.173 * s(F - 2 * D) - 0.055 * s(M - F - 2 * D) - 0.046 * s(M + F - 2 * D)
      + 0.033 * s(F + 2 * D) + 0.017 * s(2 * M + F);
    r += -0.58 * Math.cos(M - 2 * D) - 0.46 * Math.cos(2 * D);
    return { lon: lon * RAD, lat: lat * RAD, r, sunLon: Ls + 1.915 * RAD * s(Ms) + 0.02 * RAD * s(2 * Ms) };
  }

  // 月の高度(度)。地表から見た値(視差を補正した値)で、大気差は含まない。
  function moonAltitude(epochMs, lat, lon) {
    const m = moonEcliptic(epochMs);
    const d = epochMs / 86400000 + 2440587.5 - 2451545.0;
    const ecl = (23.439 - 0.00000036 * d) * RAD;
    const ra = Math.atan2(
      Math.sin(m.lon) * Math.cos(ecl) - Math.tan(m.lat) * Math.sin(ecl), Math.cos(m.lon));
    const dec = Math.asin(Math.sin(m.lat) * Math.cos(ecl) + Math.cos(m.lat) * Math.sin(ecl) * Math.sin(m.lon));
    const gmstDeg = (18.697374558 + 24.06570982441908 * d) * 15;
    const ha = (gmstDeg + lon) * RAD - ra;
    const phi = lat * RAD;
    const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
    return (alt - Math.asin(1 / m.r) * Math.cos(alt)) / RAD;
  }

  // 月の輝面比(光っている割合、0〜1)。太陽と月の離角から求める。
  function moonIllumination(epochMs) {
    const m = moonEcliptic(epochMs);
    const cosElong = Math.cos(m.lat) * Math.cos(m.lon - m.sunLon);
    return (1 - cosElong) / 2;
  }

  // 時間帯 [start, end] の月の条件。moonDown は月が沈んでいる時間帯(intervalsBelow の結果)。
  // 'none': ずっと沈んでいる / 'up': ずっと出ている /
  // 'partial': 一部だけ沈んでいる。沈んでいる最も長い時間帯を from〜to で返す(端と同じなら null)。
  function moonCondition({ start, end }, moonDown) {
    let best = null;
    for (const d of moonDown) {
      const a = Math.max(start, d.start);
      const b = Math.min(end, d.end);
      if (b - a >= 60000 && (!best || b - a > best.to - best.from)) best = { from: a, to: b };
    }
    if (!best) return { kind: 'up' };
    if (best.from <= start && best.to >= end) return { kind: 'none' };
    return { kind: 'partial', from: best.from > start ? best.from : null, to: best.to < end ? best.to : null };
  }

  // 高度 f(ms) が level を横切る時刻を返す。step ごとの値で境目をはさむ区間を見つけ、
  // 二分法で1秒まで詰める。step の間に2回横切る(すぐ戻る)場合は見逃す。
  // 太陽にも月にも使えるよう、高度を返す関数を受け取る。
  function findCrossings(f, fromMs, toMs, level, stepMs = 3600000) {
    const out = [];
    let a = fromMs;
    let fa = f(a) - level;
    while (a < toMs) {
      const b = Math.min(a + stepMs, toMs);
      const fb = f(b) - level;
      if ((fa < 0) !== (fb < 0)) {
        let lo = a;
        let hi = b;
        let flo = fa;
        while (hi - lo > 1000) {
          const mid = (lo + hi) / 2;
          const fm = f(mid) - level;
          if ((fm < 0) === (flo < 0)) {
            lo = mid;
            flo = fm;
          } else {
            hi = mid;
          }
        }
        out.push({ ms: Math.round((lo + hi) / 2), rising: fb >= 0 });
      }
      a = b;
      fa = fb;
    }
    return out;
  }

  // 高度が level より下にある時間帯を [{ start, end }] で返す。範囲の端で切る。
  // 一日中沈まなければ空、一日中昇らなければ範囲全体になる。
  function intervalsBelow(f, fromMs, toMs, level, stepMs) {
    const result = [];
    let start = f(fromMs) < level ? fromMs : null;
    for (const x of findCrossings(f, fromMs, toMs, level, stepMs)) {
      if (!x.rising) {
        start = x.ms;
      } else if (start != null) {
        result.push({ start, end: x.ms });
        start = null;
      }
    }
    if (start != null) result.push({ start, end: toMs });
    return result;
  }

  // 正午で区切った「夜」ごとに、暗くて雲の少ない連続時間のうち最良のものを返す。
  // 雲量は1時間ごとの値で、各時刻の前後30分を代表するとみなす。暗さは dark(intervalsBelow の結果)で
  // 分単位に区切る。撮影に使えない minMinutes 未満の時間帯は除く。
  // 時刻はエポックミリ秒で、夜の日付は times(現地時刻)から求める。
  function findObservingWindows({ times, epochs, clouds, dark, fromMs = -Infinity, maxCloud = 30, minMinutes = 30 }) {
    const half = 1800000;
    const offset = times.length ? Date.parse(`${times[0]}:00Z`) - epochs[0] : 0;
    const best = new Map();
    let i = 0;
    while (i < times.length) {
      if (clouds[i] == null || clouds[i] > maxCloud) { i++; continue; }
      const a = i;
      while (i + 1 < times.length && clouds[i + 1] != null && clouds[i + 1] <= maxCloud) i++;
      const b = i++;
      const runStart = Math.max(epochs[a] - half, fromMs);
      const runEnd = epochs[b] + half;
      for (const d of dark) {
        const start = Math.max(runStart, d.start);
        const end = Math.min(runEnd, d.end);
        if (end - start < minMinutes * 60000) continue;
        let sum = 0;
        let count = 0;
        for (let k = a; k <= b; k++) {
          if (epochs[k] + half > start && epochs[k] - half < end) { sum += clouds[k]; count++; }
        }
        const night = new Date(start + offset - 12 * 3600000).toISOString().slice(0, 10);
        const item = { night, start, end, hours: (end - start) / 3600000, avgCloud: sum / count };
        const cur = best.get(night);
        if (!cur || item.hours > cur.hours || (item.hours === cur.hours && item.avgCloud < cur.avgCloud)) {
          best.set(night, item);
        }
      }
    }
    return [...best.values()].sort((x, y) => x.start - y.start);
  }

  root.Forecast = {
    buildGrid, valueAt, sampleGrid, windFlow, compassName, localToEpoch,
    sunAltitude, moonAltitude, moonIllumination, moonCondition, findCrossings, intervalsBelow, findObservingWindows, wrapLon, currentIndex, reindexTime,
  };
})(globalThis);
