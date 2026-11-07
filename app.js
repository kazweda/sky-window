(function () {
  'use strict';

  const { buildGrid, valueAt, sampleGrid, windFlow, localToEpoch, sunAltitude, findObservingWindows, wrapLon } = window.Forecast;

  const API = 'https://api.open-meteo.com/v1/forecast';
  const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
  const FORECAST_DAYS = 3;
  const MAX_ZOOM = 11; // 市全体を一望できる範囲まで
  const OVERLAY_PX = 180;
  const LABEL_W = 34;
  const DEFAULT_PLACE = { name: '野辺山', lat: 35.953, lon: 138.473 };

  const LAYERS = [
    { key: 'cloud_cover_low', label: '下層', windLevel: '850hPa', height: '約1.5km' },
    { key: 'cloud_cover_mid', label: '中層', windLevel: '500hPa', height: '約5.5km' },
    { key: 'cloud_cover_high', label: '上層', windLevel: '300hPa', height: '約9km' },
  ];
  const HOURLY_VARS = ['cloud_cover', ...LAYERS.map((l) => l.key),
    ...LAYERS.flatMap((l) => [`wind_speed_${l.windLevel}`, `wind_direction_${l.windLevel}`])];

  const $ = (id) => document.getElementById(id);
  const el = {
    place: $('place'), time: $('time'), status: $('status'), total: $('total'), layers: $('layers'),
    flow: $('flow'), winds: $('winds'), windows: $('windows'), timeline: $('timeline'),
    slider: $('slider'), play: $('play'), now: $('now'),
    search: $('search'), searchInput: $('search-input'), searchResults: $('search-results'),
  };

  const state = { place: null, center: null, grid: null, gridValues: null, t: 0, nowIndex: 0, sunAlts: [], timer: null };
  const cache = new Map();
  let loadController = null;
  let debounceTimer = null;

  // --- 地図 ---
  const map = L.map('map', { worldCopyJump: false, maxZoom: MAX_ZOOM }).setView([DEFAULT_PLACE.lat, DEFAULT_PLACE.lon], 8);
  L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
    minZoom: 2, maxZoom: MAX_ZOOM, className: 'base-tiles',
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
  }).addTo(map);

  const pinIcon = L.divIcon({ className: 'pin', html: '<div class="arrow" hidden></div><div class="dot"></div>', iconSize: [0, 0] });
  let marker = null;
  let overlay = null;
  let outline = null;

  const offscreen = document.createElement('canvas');
  offscreen.width = offscreen.height = OVERLAY_PX;
  const offCtx = offscreen.getContext('2d');
  const offImage = offCtx.createImageData(OVERLAY_PX, OVERLAY_PX);

  map.on('click', (e) => {
    const { lat } = e.latlng;
    const lon = wrapLon(e.latlng.lng);
    selectPlace({ name: `北緯 ${lat.toFixed(2)}°, 東経 ${lon.toFixed(2)}°`.replace('北緯 -', '南緯 ').replace('東経 -', '西経 '), lat, lon });
  });

  // --- データ取得 ---
  async function fetchJson(url, signal) {
    const res = await fetch(url, { signal });
    if (res.status === 429) throw new Error('リクエストが多すぎます。少し待ってからお試しください。');
    if (!res.ok) throw new Error(`データを取得できませんでした(HTTP ${res.status})。`);
    return res.json();
  }

  function forecastUrl(latitude, longitude, hourly, timezone) {
    const params = new URLSearchParams({
      latitude, longitude, hourly: hourly.join(','), timezone,
      forecast_days: FORECAST_DAYS, wind_speed_unit: 'ms',
    });
    return `${API}?${params}`;
  }

  async function fetchForecast(place, signal) {
    const key = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached;

    const center = await fetchJson(forecastUrl(place.lat, place.lon, HOURLY_VARS, 'auto'), signal);
    // 全地点の時刻軸を揃えるため、中心地点のタイムゾーンで周辺を取得する。
    const grid = buildGrid(place.lat, place.lon);
    const list = await fetchJson(forecastUrl(
      grid.points.map((p) => p.lat).join(','),
      grid.points.map((p) => p.lon).join(','),
      ['cloud_cover'], center.timezone,
    ), signal);
    const length = center.hourly.time.length;
    if (!Array.isArray(list) || list.length !== grid.points.length || list.some((p) => p.hourly.time.length !== length)) {
      throw new Error('周辺の雲データの形式が想定と異なります。');
    }
    const gridValues = list.map((p) => p.hourly.cloud_cover);
    const entry = { center, grid, gridValues, at: Date.now() };
    cache.set(key, entry);
    return entry;
  }

  // --- 目的地の選択 ---
  function selectPlace(place, { pan = false } = {}) {
    stopPlayback();
    state.place = place;
    el.place.textContent = place.name;
    location.hash = `${place.lat.toFixed(3)},${place.lon.toFixed(3)}`;
    if (!marker) marker = L.marker([place.lat, place.lon], { icon: pinIcon, keyboard: false, interactive: false }).addTo(map);
    else marker.setLatLng([place.lat, place.lon]);
    if (pan) map.setView([place.lat, place.lon], 8);
    showStatus('雲の予報を読み込んでいます…');

    // 連続クリックでAPIを消費しないよう少し待つ。
    clearTimeout(debounceTimer);
    if (loadController) loadController.abort();
    debounceTimer = setTimeout(() => load(place), 300);
  }

  async function load(place) {
    const controller = new AbortController();
    loadController = controller;
    try {
      const data = await fetchForecast(place, controller.signal);
      if (controller.signal.aborted) return;
      apply(place, data);
      hideStatus();
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error(err);
      const offline = err instanceof TypeError;
      showStatus(offline ? '通信できませんでした。接続を確認してください。' : err.message, true);
    }
  }

  function apply(place, data) {
    state.center = data.center;
    state.grid = data.grid;
    state.gridValues = data.gridValues;
    const { time } = data.center.hourly;
    const offset = data.center.utc_offset_seconds;
    const epochs = time.map((t) => localToEpoch(t, offset));
    state.sunAlts = epochs.map((e) => sunAltitude(e, place.lat, place.lon));
    state.nowIndex = Math.max(0, Math.min(time.length - 1, Math.floor((Date.now() - epochs[0]) / 3600000)));

    el.slider.max = time.length - 1;
    for (const control of [el.slider, el.play, el.now]) control.disabled = false;

    if (outline) outline.remove();
    if (overlay) overlay.remove();
    overlay = L.imageOverlay(offscreen.toDataURL(), data.grid.bounds, { className: 'cloud-layer', opacity: 1, interactive: false }).addTo(map);
    outline = L.rectangle(data.grid.bounds, { color: '#8fc7ff', weight: 1, dashArray: '4 4', fill: false, interactive: false }).addTo(map);

    renderWindows();
    setTime(state.nowIndex);
  }

  // --- 描画 ---
  function setTime(t) {
    if (!state.center) return;
    state.t = t;
    el.slider.value = Math.round(t);
    renderReadout();
    renderOverlay();
    renderTimeline();
  }

  function formatTime(iso, withDate = true) {
    const [date, clock] = iso.split('T');
    const [, m, d] = date.split('-').map(Number);
    if (!withDate) return clock;
    const day = '日月火水木金土'[new Date(`${date}T00:00:00Z`).getUTCDay()];
    return `${m}/${d}(${day}) ${clock}`;
  }

  function renderReadout() {
    const { hourly, timezone_abbreviation: tz } = state.center;
    const i = Math.round(state.t);
    el.time.textContent = `${formatTime(hourly.time[i])} ${tz}`;

    const total = hourly.cloud_cover[i];
    el.total.textContent = total == null ? '—' : `${Math.round(total)}%`;

    el.layers.replaceChildren(...[...LAYERS].reverse().map((layer) => {
      const value = hourly[layer.key][i];
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = layer.label;
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = `${value ?? 0}%`;
      bar.append(fill);
      const dd = document.createElement('dd');
      dd.textContent = value == null ? '—' : `${Math.round(value)}%`;
      row.append(dt, bar, dd);
      return row;
    }));

    el.winds.replaceChildren(...[...LAYERS].reverse().map((layer) => {
      const speed = hourly[`wind_speed_${layer.windLevel}`][i];
      const flow = windFlow(hourly[`wind_direction_${layer.windLevel}`][i]);
      const li = document.createElement('li');
      const arrow = document.createElement('span');
      arrow.className = 'dir';
      arrow.textContent = '↑';
      arrow.setAttribute('aria-hidden', 'true');
      if (flow) arrow.style.transform = `rotate(${flow.arrowDeg}deg)`;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = `${layer.label} ${layer.height}`;
      const text = document.createElement('span');
      text.textContent = flow ? `${flow.from} → ${flow.to}` : '—';
      const sp = document.createElement('span');
      sp.className = 'speed';
      sp.textContent = speed == null ? '' : `${Math.round(speed)} m/s`;
      li.append(arrow, name, text, sp);
      return li;
    }));

    // 最も雲の多い層の風を、目的地の雲の動きの目安として示す。
    const dominant = LAYERS.reduce((best, layer) => ((hourly[layer.key][i] ?? -1) > (hourly[best.key][i] ?? -1) ? layer : best));
    const dominantValue = hourly[dominant.key][i];
    const arrowEl = marker && marker.getElement() && marker.getElement().querySelector('.arrow');
    if (dominantValue == null || dominantValue < 10) {
      el.flow.textContent = dominantValue == null ? '' : '目的地の上空に目立つ雲はありません。';
      if (arrowEl) arrowEl.hidden = true;
    } else {
      const flow = windFlow(hourly[`wind_direction_${dominant.windLevel}`][i]);
      const speed = hourly[`wind_speed_${dominant.windLevel}`][i];
      el.flow.textContent = flow && speed != null
        ? `${dominant.label}の雲が中心で、${flow.from}から${flow.to}へ約${Math.round(speed)} m/sで流れる見込みです。`
        : `${dominant.label}の雲が中心です。`;
      if (arrowEl) {
        arrowEl.hidden = !flow;
        if (flow) arrowEl.style.transform = `rotate(${flow.arrowDeg}deg)`;
      }
    }
  }

  function renderOverlay() {
    if (!overlay) return;
    const { size } = state.grid;
    const frame = state.gridValues.map((series) => valueAt(series, state.t));
    const px = offImage.data;
    for (let y = 0; y < OVERLAY_PX; y++) {
      for (let x = 0; x < OVERLAY_PX; x++) {
        const c = sampleGrid(frame, size, x / (OVERLAY_PX - 1), y / (OVERLAY_PX - 1));
        const p = (y * OVERLAY_PX + x) * 4;
        px[p] = px[p + 1] = px[p + 2] = 255;
        px[p + 3] = c == null ? 0 : Math.round(235 * Math.pow(c / 100, 0.85));
      }
    }
    offCtx.putImageData(offImage, 0, 0);
    overlay.setUrl(offscreen.toDataURL());
  }

  function renderTimeline() {
    const canvas = el.timeline;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;
    ctx.clearRect(0, 0, W, H);

    const { hourly } = state.center;
    const n = hourly.time.length;
    const cellW = (W - LABEL_W) / n;
    const dateH = 18;
    const darkH = 8;
    const rows = [
      { label: '全体', key: 'cloud_cover' },
      { label: '上層', key: 'cloud_cover_high' },
      { label: '中層', key: 'cloud_cover_mid' },
      { label: '下層', key: 'cloud_cover_low' },
    ];
    const rowH = (H - dateH - darkH - 6) / rows.length;
    const xOf = (i) => LABEL_W + i * cellW;

    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // 日付の区切り
    ctx.fillStyle = '#9aa8b8';
    hourly.time.forEach((iso, i) => {
      if (iso.endsWith('T00:00')) {
        const [, m, d] = iso.split('T')[0].split('-').map(Number);
        ctx.fillText(`${m}/${d}`, xOf(i) + 2, dateH / 2);
      }
    });

    // 空の暗さ(昼・薄明・夜)
    for (let i = 0; i < n; i++) {
      const alt = state.sunAlts[i];
      ctx.fillStyle = alt > -0.83 ? '#d9b36a' : alt > -18 ? '#4a5f86' : '#10151f';
      ctx.fillRect(xOf(i), dateH, Math.ceil(cellW), darkH);
    }

    // 雲量のヒートマップ
    rows.forEach((row, r) => {
      const y = dateH + darkH + 6 + r * rowH;
      ctx.fillStyle = '#9aa8b8';
      ctx.fillText(row.label, 0, y + rowH / 2);
      for (let i = 0; i < n; i++) {
        const v = hourly[row.key][i];
        if (v == null) {
          ctx.fillStyle = '#000';
        } else {
          const shade = Math.round(42 + (255 - 42) * (v / 100));
          ctx.fillStyle = `rgb(${shade} ${Math.min(255, shade + 8)} ${Math.min(255, shade + 20)})`;
        }
        ctx.fillRect(xOf(i), y, Math.ceil(cellW), rowH - 2);
      }
    });

    // 選択中の時刻
    ctx.fillStyle = '#ffc27a';
    ctx.fillRect(xOf(state.t + 0.5) - 1, dateH, 2, H - dateH);
  }

  function renderWindows() {
    const { hourly } = state.center;
    const found = findObservingWindows({
      times: hourly.time, clouds: hourly.cloud_cover, sunAlts: state.sunAlts, fromIndex: state.nowIndex,
    });
    if (!found.length) {
      const li = document.createElement('li');
      li.className = 'none';
      li.textContent = '予報の期間内に条件を満たす時間帯はありません。';
      el.windows.replaceChildren(li);
      return;
    }
    el.windows.replaceChildren(...found.map((w) => {
      const li = document.createElement('li');
      const btn = document.createElement('span');
      const start = formatTime(hourly.time[w.start]);
      const end = formatTime(hourly.time[w.end], false);
      btn.textContent = w.hours === 1 ? start : `${start}〜${end}`;
      const small = document.createElement('small');
      small.textContent = `平均雲量 ${Math.round(w.avgCloud)}%`;
      li.append(btn, small);
      return li;
    }));
  }

  // --- 操作 ---
  function showStatus(message, isError = false) {
    el.status.textContent = message;
    el.status.hidden = false;
    el.status.classList.toggle('error', isError);
  }
  function hideStatus() { el.status.hidden = true; }

  function stopPlayback() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    el.play.textContent = '▶ 再生';
  }

  function startPlayback() {
    el.play.textContent = '■ 停止';
    const last = state.center.hourly.time.length - 1;
    if (state.t >= last) state.t = state.nowIndex;
    state.timer = setInterval(() => {
      const next = state.t + 0.25;
      if (next > last) { stopPlayback(); return; }
      setTime(next);
    }, 120);
  }

  el.play.addEventListener('click', () => (state.timer ? stopPlayback() : startPlayback()));
  el.now.addEventListener('click', () => { stopPlayback(); setTime(state.nowIndex); });
  el.slider.addEventListener('input', () => { stopPlayback(); setTime(Number(el.slider.value)); });

  function seekFromPointer(e) {
    if (!state.center) return;
    const rect = el.timeline.getBoundingClientRect();
    const n = state.center.hourly.time.length;
    const i = Math.floor(((e.clientX - rect.left - LABEL_W) / (rect.width - LABEL_W)) * n);
    stopPlayback();
    setTime(Math.max(0, Math.min(n - 1, i)));
  }
  el.timeline.addEventListener('pointerdown', (e) => {
    el.timeline.setPointerCapture(e.pointerId);
    seekFromPointer(e);
  });
  el.timeline.addEventListener('pointermove', (e) => {
    if (e.buttons) seekFromPointer(e);
  });
  window.addEventListener('resize', () => { if (state.center) renderTimeline(); });

  // --- 地名検索 ---
  async function geocode(name) {
    const params = new URLSearchParams({ name, count: 6, language: 'ja', format: 'json' });
    const data = await fetchJson(`${GEOCODE}?${params}`);
    return data.results || [];
  }

  // APIは「札幌市」で見つかっても「札幌」では0件になるため、行政区分を補って再検索する。
  async function searchPlaces(name) {
    const direct = await geocode(name);
    if (direct.length) return direct;
    const retried = await Promise.all(['市', '都', '府', '県'].map((suffix) => geocode(name + suffix)));
    const byId = new Map(retried.flat().map((r) => [r.id, r]));
    return [...byId.values()];
  }

  el.search.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el.searchInput.value.trim();
    if (!name) return;
    const list = el.searchResults;
    const addEmpty = (text) => {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = text;
      list.replaceChildren(li);
      list.hidden = false;
    };
    try {
      const results = await searchPlaces(name);
      if (!results.length) { addEmpty('見つかりませんでした。別の表記で検索するか、地図をタップしてください。'); return; }
      list.replaceChildren(...results.map((r) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = [r.name, r.admin1, r.country].filter(Boolean).join('、');
        btn.addEventListener('click', () => {
          list.hidden = true;
          selectPlace({ name: r.name, lat: r.latitude, lon: r.longitude }, { pan: true });
        });
        li.append(btn);
        return li;
      }));
      list.hidden = false;
    } catch (err) {
      console.error(err);
      addEmpty(err instanceof TypeError ? '通信できませんでした。' : err.message);
    }
  });

  // --- 起動 ---
  function placeFromHash() {
    const match = location.hash.match(/^#(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
    return { name: `${lat.toFixed(2)}, ${lon.toFixed(2)}`, lat, lon };
  }
  selectPlace(placeFromHash() || DEFAULT_PLACE, { pan: true });
})();
