// 地名検索の結果と、地点を表す URL を扱う処理。UIに依存しない。ブラウザでは globalThis.Places として使う。
(function (root) {
  'use strict';

  const PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
    '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
    '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
    '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
    '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];

  // 市区町村コードは先頭の0が落ちて返ることがある(「3203」は岩手県)。
  function prefFromCode(code) {
    const s = String(code || '');
    if (s.length < 4) return '';
    return PREFS[Number(s.slice(0, s.length - 3)) - 1] || '';
  }

  const normalize = (s) => String(s).normalize('NFKC').replace(/\s+/g, '');
  const stripPref = (title) => {
    const pref = PREFS.find((p) => title.startsWith(p));
    return pref ? title.slice(pref.length) : title;
  };
  // 住所(dataSource なし)を先に、施設や郵便局を後にする。
  const SOURCE_ORDER = { '': 0, 4: 1, 5: 2, 1: 3, 3: 4 };

  // 施設(1)と郵便局(3)は、名前の一部が合うだけのことが多い(「ハッピーバレーGC札幌」など)。
  const isFacility = (source) => source === '1' || source === '3';
  // 4以下なら入力と合う地名として扱う。
  const STRONG_KEY = 4;

  function rankKey(title, isAddress, source, q) {
    if (isAddress && title.endsWith(`${q}市`)) return 0;
    if (title === q || (isAddress && title.endsWith(q))) return 1;
    if (isAddress && /[区町村]$/.test(title) && title.slice(0, -1).endsWith(q)) return 2;
    if (isFacility(source)) return 5;
    if (title.endsWith(q)) return 3;
    if (title.startsWith(q)) return 4;
    return 5;
  }

  // 国土地理院の地名検索は、入力の一部(「高縄山」に対する「高」など)だけが合う地名も返す。
  // 入力をそのまま含むものに絞り、市や名前が一致する地名を上にして、ほぼ同じ地点の重複を除く。
  function rankGsiResults(features, query, limit = 6) {
    const q = normalize(query);
    if (!q) return [];
    const ranked = (features || [])
      .map((f, i) => {
        const props = f.properties || {};
        const title = normalize(props.title || '');
        const isAddress = props.dataSource == null;
        const [lon, lat] = f.geometry.coordinates;
        return {
          title, isAddress, lat, lon, i,
          key: rankKey(title, isAddress, props.dataSource, q),
          source: SOURCE_ORDER[props.dataSource ?? ''] ?? 5,
          pref: isAddress ? '' : prefFromCode(props.addressCode),
        };
      })
      .filter((r) => r.title.includes(q) && Number.isFinite(r.lat) && Number.isFinite(r.lon))
      .sort((a, b) => a.key - b.key || a.source - b.source || a.i - b.i);

    const picked = [];
    for (const r of ranked) {
      if (picked.some((p) => Math.abs(p.lat - r.lat) < 0.01 && Math.abs(p.lon - r.lon) < 0.01)) continue;
      picked.push({
        name: r.isAddress ? stripPref(r.title) : r.title,
        label: r.isAddress ? r.title : [r.title, r.pref].filter(Boolean).join('、'),
        lat: r.lat,
        lon: r.lon,
        strong: r.key <= STRONG_KEY,
      });
      if (picked.length >= limit) break;
    }
    return picked;
  }

  // --- 地点の URL ---
  // ?lat=35.953&lon=138.473&name=野辺山&z=8 の形式。name と z は省略できる。
  // 以前の #35.953,138.473 の形式も読めるようにする(ブックマーク済みの URL のため)。
  const ZOOM_MIN = 2;
  const ZOOM_MAX = 11;
  const NAME_MAX = 100;
  const NUMBER = /^-?\d+(?:\.\d+)?$/;

  function parsePlaceUrl(search, hash) {
    const q = new URLSearchParams(search || '');
    let lat;
    let lon;
    if (q.has('lat') || q.has('lon')) {
      if (!NUMBER.test(q.get('lat') || '') || !NUMBER.test(q.get('lon') || '')) return null;
      lat = Number(q.get('lat'));
      lon = Number(q.get('lon'));
    } else {
      const m = (hash || '').match(/^#(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
      if (!m) return null;
      lat = Number(m[1]);
      lon = Number(m[2]);
    }
    if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
    const name = (q.get('name') || '').trim().slice(0, NAME_MAX) || null;
    const z = q.get('z');
    const zoom = z != null && /^\d+$/.test(z) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(z))) : null;
    return { lat, lon, name, zoom };
  }

  function placeQuery({ lat, lon, name }, zoom) {
    const q = new URLSearchParams({ lat: lat.toFixed(3), lon: lon.toFixed(3) });
    if (name) q.set('name', name);
    if (zoom != null) q.set('z', String(zoom));
    return `?${q}`;
  }

  // --- 地点を外で使う ---
  // 小数点以下4桁(約10m)。観測地の位置を地図で確かめるのに十分な精度。
  const formatCoords = (lat, lon) => `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

  // Google の公開している URL の形式(API キー不要)。スマホでは Google マップのアプリで開く。
  const googleMapsUrl = (lat, lon) =>
    `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(4)},${lon.toFixed(4)}`;

  root.Places = { rankGsiResults, prefFromCode, parsePlaceUrl, placeQuery, formatCoords, googleMapsUrl };
})(globalThis);
