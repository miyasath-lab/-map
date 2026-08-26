/* 医療機関CSV → アプリ内データ形式への変換（ブラウザ / Node 共用）
 *
 * 想定入力：厚労省「医療情報ネット」や沖縄県 医療機能情報提供制度 の公開CSV、
 *           あるいは各医師会の会員名簿を表計算で整形したCSV。
 * 列名は施設・年度で揺れるため、代表的な別名をまとめて吸収する。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CsvMap = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 地区の定義（南部保健所管内＋那覇市）----------
     構成を変えたいときはここだけ直せばよい。 */
  const REGION_GROUPS = [
    { label: '那覇市',       members: ['那覇市'] },
    { label: '南部（本島）', members: ['豊見城市', '糸満市', '南城市', '南風原町', '八重瀬町', '与那原町'] },
    { label: '南部（離島）', members: ['渡嘉敷村', '座間味村', '粟国村', '渡名喜村', '南大東村', '北大東村', '久米島町'] }
  ];
  const ALL_MUNI = REGION_GROUPS.flatMap(g => g.members);

  /* 市町村役場付近のおおよその座標（現在地からの距離計算のフォールバック用） */
  const MUNI_LATLNG = {
    '那覇市':   [26.2124, 127.6809],
    '豊見城市': [26.1770, 127.6860],
    '糸満市':   [26.1246, 127.6663],
    '南城市':   [26.1436, 127.7686],
    '南風原町': [26.1900, 127.7250],
    '八重瀬町': [26.1330, 127.7250],
    '与那原町': [26.2020, 127.7530],
    '渡嘉敷村': [26.1930, 127.3610],
    '座間味村': [26.2280, 127.3020],
    '粟国村':   [26.5850, 127.2320],
    '渡名喜村': [26.3700, 127.1400],
    '南大東村': [25.8290, 131.2320],
    '北大東村': [25.9450, 131.3020],
    '久米島町': [26.3400, 126.8050]
  };

  /* ---------- 列名の別名テーブル ---------- */
  const FIELD_ALIASES = {
    name:        ['医療機関名称', '医療機関名', '施設名称', '施設名', '名称', '病院・診療所名'],
    kana:        ['医療機関名称カナ', '医療機関名カナ', '名称カナ', 'カナ', 'ふりがな', 'フリガナ'],
    type:        ['医療機関の種類', '施設種別', '種別', '区分'],
    zip:         ['郵便番号', '〒'],
    address:     ['所在地', '住所', '医療機関所在地', '所在地（住所）'],
    tel:         ['電話番号', 'TEL', '電話', '代表電話番号'],
    fax:         ['FAX番号', 'FAX', 'ファクシミリ番号'],
    url:         ['ホームページアドレス', 'ホームページ', 'URL', 'ＵＲＬ', 'ウェブサイト'],
    departments: ['診療科目', '標榜診療科', '診療科', '診療科名'],
    lat:         ['緯度', 'lat', 'latitude'],
    lng:         ['経度', 'lng', 'lon', 'longitude'],
    muni:        ['市区町村', '市町村', '所在地市区町村', '郡市'],
    beds:        ['病床数', '許可病床数', '一般病床数'],
    features:    ['特徴', '対応', '備考タグ'],
    note:        ['備考', 'コメント', '特記事項'],
    hours:       ['診療時間', '診療曜日・時間', '受付時間']
  };

  const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAY_LABELS = { mon: '月', tue: '火', wed: '水', thu: '木', fri: '金', sat: '土', sun: '日' };

  /* ---------- CSVパーサ（引用符・改行込みに対応）---------- */
  function parseCSV(text) {
    const src = String(text).replace(/^﻿/, '');
    const rows = [];
    let row = [], cell = '', i = 0, quoted = false;
    while (i < src.length) {
      const c = src[i];
      if (quoted) {
        if (c === '"') {
          if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        cell += c; i++; continue;
      }
      if (c === '"') { quoted = true; i++; continue; }
      if (c === ',') { row.push(cell); cell = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
      cell += c; i++;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(v => String(v).trim() !== ''));
  }

  /* 全角英数記号をゆるく半角へ（列名の照合と電話番号の正規化に使う） */
  function toHalf(s) {
    return String(s ?? '')
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[－ー―‐]/g, '-')
      .replace(/　/g, ' ')
      .trim();
  }

  /* ヘッダ行から「項目名 → 列番号」を作る */
  function mapHeader(header) {
    const norm = header.map(h => toHalf(h).replace(/[\s()（）]/g, ''));
    const idx = {};
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      for (const alias of aliases) {
        const a = toHalf(alias).replace(/[\s()（）]/g, '');
        const hit = norm.findIndex(h => h === a || (h.length > 1 && h.includes(a)));
        if (hit >= 0) { idx[field] = hit; break; }
      }
    }
    return idx;
  }

  function splitList(v) {
    return toHalf(v).split(/[、,，\/／・|｜\n]+/).map(s => s.trim()).filter(Boolean);
  }

  function normalizeTel(v) {
    const t = toHalf(v).replace(/[^0-9\-+]/g, '');
    return t;
  }

  /* 住所から市町村を拾う（列が無いCSV向け） */
  function muniFromAddress(address) {
    const a = String(address ?? '');
    return ALL_MUNI.find(m => a.includes(m)) || '';
  }

  function regionOf(muni) {
    const g = REGION_GROUPS.find(g => g.members.includes(muni));
    return g ? g.label : 'その他';
  }

  /* 「月火水木金 9:00-12:30,14:00-18:00」程度の自由記述を控えめに構造化する。
     解釈できない場合は hoursText として原文を残し、時間帯検索の対象外にする。 */
  function parseHours(text) {
    const t = toHalf(text);
    if (!t) return null;
    const ranges = [...t.matchAll(/(\d{1,2}):?(\d{2})\s*[-~〜]\s*(\d{1,2}):?(\d{2})/g)]
      .map(m => [`${m[1].padStart(2, '0')}:${m[2]}`, `${m[3].padStart(2, '0')}:${m[4]}`]);
    if (!ranges.length) return null;
    const dayHit = { mon: /月/, tue: /火/, wed: /水/, thu: /木/, fri: /金/, sat: /土/, sun: /日/ };
    const hours = {};
    let any = false;
    for (const k of DAY_KEYS) {
      if (dayHit[k].test(t)) { hours[k] = ranges.slice(); any = true; }
      else hours[k] = [];
    }
    return any ? hours : null;
  }

  /* ---------- 本体：CSV行 → 施設オブジェクト ---------- */
  function rowsToFacilities(rows, opts) {
    opts = opts || {};
    const warnings = [];
    if (!rows.length) return { facilities: [], warnings: ['CSVが空です'] };

    const idx = mapHeader(rows[0]);
    if (idx.name === undefined) {
      return { facilities: [], warnings: ['「医療機関名称」にあたる列が見つかりませんでした。1行目をヘッダ行にしてください。'] };
    }
    if (idx.address === undefined) warnings.push('住所の列が見つかりません（地区の絞り込みが効かなくなります）。');

    const pick = (row, field) => (idx[field] === undefined ? '' : String(row[idx[field]] ?? '').trim());
    const facilities = [];

    rows.slice(1).forEach((row, n) => {
      const name = pick(row, 'name');
      if (!name) return;
      const address = pick(row, 'address');
      const muni = pick(row, 'muni') || muniFromAddress(address);
      const region = regionOf(muni);
      if (opts.onlyKnownRegions && region === 'その他') return;

      const lat = parseFloat(pick(row, 'lat'));
      const lng = parseFloat(pick(row, 'lng'));
      const fallback = MUNI_LATLNG[muni];
      const hoursText = pick(row, 'hours');

      facilities.push({
        id: `csv-${n + 1}`,
        name,
        kana: pick(row, 'kana'),
        type: pick(row, 'type') || (/病院/.test(name) ? '病院' : '診療所'),
        muni,
        region,
        zip: pick(row, 'zip'),
        address,
        tel: normalizeTel(pick(row, 'tel')),
        fax: normalizeTel(pick(row, 'fax')),
        url: toHalf(pick(row, 'url')),
        lat: Number.isFinite(lat) ? lat : (fallback ? fallback[0] : null),
        lng: Number.isFinite(lng) ? lng : (fallback ? fallback[1] : null),
        approxLatLng: !(Number.isFinite(lat) && Number.isFinite(lng)),
        departments: splitList(pick(row, 'departments')),
        features: splitList(pick(row, 'features')),
        beds: parseInt(pick(row, 'beds'), 10) || 0,
        hours: parseHours(hoursText),
        hoursText,
        note: pick(row, 'note')
      });
    });

    if (!facilities.length) warnings.push('取り込める行がありませんでした。');
    return { facilities, warnings };
  }

  return {
    REGION_GROUPS, ALL_MUNI, MUNI_LATLNG, DAY_KEYS, DAY_LABELS,
    parseCSV, mapHeader, rowsToFacilities,
    muniFromAddress, regionOf, parseHours, normalizeTel, splitList, toHalf
  };
});
