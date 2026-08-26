/* 医療機関CSV → アプリ内データ形式への変換（ブラウザ / Node 共用）
 *
 * 想定入力：
 *   - 厚労省「医療情報ネット（ナビイ）」のオープンデータ（都道府県別CSV）
 *   - 沖縄県 医療機能情報提供制度／G-MIS 由来のCSV
 *   - 医師会名簿などを表計算で整形したCSV
 *
 * 公的CSVは年度・様式で列構成が変わるため、次の揺れを吸収する。
 *   - 列名の別名（医療機関名称／施設名称／名称 …）
 *   - 住所が「都道府県」「市区町村」「町字・番地」に分かれている
 *   - 診療科目が「診療科目1」「診療科目2」… と横に並ぶ
 *   - 診療時間が「診療曜日／開始時間／終了時間」の3列、または曜日ごとの列
 *   - 1施設が複数行に分かれている（医療機関コードで束ねる）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CsvMap = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 地区の定義（那覇市＋南部保健所管内）----------
     構成を変えたいときはここだけ直せばよい。 */
  const REGION_GROUPS = [
    { label: '那覇市',       members: ['那覇市'] },
    { label: '南部（本島）', members: ['豊見城市', '糸満市', '南城市', '南風原町', '八重瀬町', '与那原町'] },
    { label: '南部（離島）', members: ['渡嘉敷村', '座間味村', '粟国村', '渡名喜村', '南大東村', '北大東村', '久米島町'] }
  ];
  const ALL_MUNI = REGION_GROUPS.flatMap(g => g.members);

  /* 市町村役場付近のおおよその座標（緯度経度が無いデータの距離計算に使う） */
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
    facilityId:  ['保険医療機関コード', '医療機関コード', '施設コード', '医療機関ID', '薬局コード'],
    name:        ['医療機関名称', '医療機関名', '施設名称', '病院・診療所名', '薬局名称', '施設名', '名称'],
    kana:        ['医療機関名称カナ', '医療機関名カナ', '名称カナ', 'ふりがな', 'フリガナ', 'カナ'],
    type:        ['医療機関の種類', '医療機関種別', '施設種別', '種別', '区分'],
    zip:         ['郵便番号', '〒'],
    address:     ['所在地', '住所', '医療機関所在地'],
    addrPref:    ['所在地（都道府県）', '所在地(都道府県)', '都道府県名', '都道府県'],
    addrCity:    ['所在地（市区町村）', '所在地(市区町村)', '市区町村名', '市区町村', '市町村名', '市町村', '郡市'],
    addrRest:    ['所在地（町字・番地）', '所在地(町字・番地)', '町字・番地', '所在地（詳細）', '番地'],
    tel:         ['電話番号', '代表電話番号', 'TEL', '電話'],
    fax:         ['FAX番号', 'ファクシミリ番号', 'FAX'],
    url:         ['ホームページアドレス', 'ホームページ', 'ウェブサイト', 'URL', 'ＵＲＬ'],
    lat:         ['緯度', 'latitude', 'lat'],
    lng:         ['経度', 'longitude', 'lng', 'lon'],
    beds:        ['病床数', '許可病床数', '一般病床数'],
    features:    ['特徴', '対応', '備考タグ'],
    note:        ['備考', '特記事項', 'コメント'],
    hoursText:   ['診療時間', '診療曜日・時間', '受付時間', '外来受付時間'],
    dayName:     ['診療曜日', '曜日', '診療日'],
    startTime:   ['診療開始時間', '開始時間', '受付開始時間'],
    endTime:     ['診療終了時間', '終了時間', '受付終了時間']
  };

  const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAY_LABELS = { mon: '月', tue: '火', wed: '水', thu: '木', fri: '金', sat: '土', sun: '日' };
  const DAY_OF_CHAR = { '月': 'mon', '火': 'tue', '水': 'wed', '木': 'thu', '金': 'fri', '土': 'sat', '日': 'sun' };

  /* ---------- CSVパーサ（引用符・セル内改行に対応）---------- */
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

  const squash = (s) => toHalf(s).replace(/[\s()（）「」【】]/g, '');

  /* ---------- ヘッダ解析 ---------- */
  function analyzeHeader(header) {
    const norm = header.map(squash);
    const used = new Set();
    const idx = {};

    /* 曜日ごとの診療時間列（「月曜日」「診療時間月」…）を先に確保する。
       あとの別名照合で「診療時間」に食われないよう、順序が重要。 */
    const dayCols = {};
    norm.forEach((h, i) => {
      const m = h.match(/([月火水木金土日])曜/) ||
                h.match(/^(?:診療時間|受付時間|外来時間|診療受付時間)([月火水木金土日])$/);
      if (!m) return;
      const key = DAY_OF_CHAR[m[1]];
      (dayCols[key] = dayCols[key] || []).push(i);
      used.add(i);
    });

    /* 診療科目：「診療科目」「診療科目1」「標榜診療科(内科)」… をまとめて拾う */
    const deptCols = [];
    norm.forEach((h, i) => {
      if (used.has(i)) return;
      if (/^(診療科目|標榜診療科|診療科|取扱診療科)/.test(h)) { deptCols.push(i); used.add(i); }
    });

    /* 別名が長いものから当てて、短い別名の誤爆（「所在地」が「所在地（市区町村）」を食う等）を避ける */
    const fields = Object.entries(FIELD_ALIASES)
      .map(([field, aliases]) => ({ field, aliases: aliases.slice().sort((a, b) => b.length - a.length) }));

    for (const pass of ['exact', 'partial']) {
      for (const { field, aliases } of fields) {
        if (idx[field] !== undefined) continue;
        for (const alias of aliases) {
          const a = squash(alias);
          const hit = norm.findIndex((h, i) =>
            !used.has(i) && (pass === 'exact' ? h === a : (h.length > 1 && h.includes(a))));
          if (hit >= 0) { idx[field] = hit; used.add(hit); break; }
        }
      }
    }

    const unmatched = norm.map((h, i) => ({ col: i, name: header[i] })).filter(x => !used.has(x.col));
    return { idx, deptCols, dayCols, unmatched };
  }

  /* 旧APIとの互換（項目名 → 列番号のみ返す） */
  function mapHeader(header) { return analyzeHeader(header).idx; }

  function splitList(v) {
    return toHalf(v).split(/[、,，\/／・|｜\n]+/).map(s => s.trim()).filter(Boolean);
  }

  function normalizeTel(v) {
    return toHalf(v).replace(/[^0-9\-+]/g, '');
  }

  /* '9:00' '0900' '9時00分' → '09:00' */
  function normalizeTime(v) {
    const t = toHalf(v).replace(/時/, ':').replace(/分/, '');
    let m = t.match(/^(\d{1,2}):(\d{1,2})$/);
    if (m) return `${m[1].padStart(2, '0')}:${m[2].padStart(2, '0')}`;
    m = t.match(/^(\d{3,4})$/);
    if (m) { const s = m[1].padStart(4, '0'); return `${s.slice(0, 2)}:${s.slice(2)}`; }
    return '';
  }

  const emptyHours = () => DAY_KEYS.reduce((o, k) => (o[k] = [], o), {});

  function addRange(hours, dayKey, start, end) {
    if (!dayKey || !start || !end || start === end) return false;
    const list = hours[dayKey];
    if (list.some(([s, e]) => s === start && e === end)) return true;
    list.push([start, end]);
    list.sort((a, b) => a[0].localeCompare(b[0]));
    return true;
  }

  /* 「月火水木金 9:00-12:30, 14:00-18:00」程度の自由記述を控えめに構造化する。
     解釈できない場合は null を返し、原文を hoursText として残す。 */
  function parseHours(text) {
    const t = toHalf(text);
    if (!t) return null;
    const ranges = [...t.matchAll(/(\d{1,2}):?(\d{2})\s*[-~〜–]\s*(\d{1,2}):?(\d{2})/g)]
      .map(m => [`${m[1].padStart(2, '0')}:${m[2]}`, `${m[3].padStart(2, '0')}:${m[4]}`]);
    if (!ranges.length) return null;
    const hours = emptyHours();
    let any = false;
    for (const k of DAY_KEYS) {
      if (new RegExp(DAY_LABELS[k]).test(t)) { ranges.forEach(r => addRange(hours, k, r[0], r[1])); any = true; }
    }
    return any ? hours : null;
  }

  /* 1セルに時間帯だけが入った曜日別列（例「9:00-12:30 14:00-18:00」） */
  function rangesInCell(text) {
    const t = toHalf(text);
    if (!t || (/休|なし|×/.test(t) && !/\d/.test(t))) return [];
    return [...t.matchAll(/(\d{1,2}):?(\d{2})\s*[-~〜–]\s*(\d{1,2}):?(\d{2})/g)]
      .map(m => [`${m[1].padStart(2, '0')}:${m[2]}`, `${m[3].padStart(2, '0')}:${m[4]}`]);
  }

  function muniFromAddress(address) {
    const a = toHalf(address);
    const known = ALL_MUNI.find(m => a.includes(m));
    if (known) return known;
    /* 対象外の市町村も拾えるよう、都道府県名と郡名を落としてから先頭の市区町村を切り出す */
    const rest = a.replace(/^.{2,3}?[都道府県]/, '').replace(/^.{1,4}?郡/, '');
    const m = rest.match(/^([^\s、0-9]{1,6}?[市区町村])/);
    return m ? m[1] : '';
  }

  function regionOf(muni) {
    const g = REGION_GROUPS.find(g => g.members.includes(muni));
    return g ? g.label : 'その他';
  }

  function guessType(name, raw) {
    const s = `${raw || ''} ${name}`;
    if (/病院/.test(s)) return '病院';
    if (/薬局/.test(s)) return '薬局';
    if (/歯科/.test(s)) return '歯科診療所';
    if (/助産/.test(s)) return '助産所';
    return '診療所';
  }

  /* ---------- 本体：CSV行 → 施設オブジェクト ---------- */
  function rowsToFacilities(rows, opts) {
    opts = opts || {};
    const warnings = [];
    if (!rows.length) return { facilities: [], warnings: ['CSVが空です'], header: null };

    const head = analyzeHeader(rows[0]);
    const { idx, deptCols, dayCols } = head;
    if (idx.name === undefined) {
      return {
        facilities: [], header: head,
        warnings: ['「医療機関名称」にあたる列が見つかりませんでした。1行目をヘッダ行にしてください。']
      };
    }
    const hasAddress = idx.address !== undefined || idx.addrRest !== undefined || idx.addrCity !== undefined;
    if (!hasAddress) warnings.push('住所の列が見つかりません（地区の絞り込みが効かなくなります）。');

    const pick = (row, field) => (idx[field] === undefined ? '' : String(row[idx[field]] ?? '').trim());
    const merged = new Map();   // 1施設が複数行に分かれるCSVを束ねる
    let rowsUsed = 0;

    rows.slice(1).forEach(row => {
      const name = pick(row, 'name');
      if (!name) return;

      const address = pick(row, 'address') ||
        [pick(row, 'addrPref'), pick(row, 'addrCity'), pick(row, 'addrRest')].filter(Boolean).join('');
      /* 「島尻郡八重瀬町」のような郡つき表記も市町村名に揃える */
      const muni = muniFromAddress(pick(row, 'addrCity')) || muniFromAddress(address);
      const key = pick(row, 'facilityId') || `${name}|${address}`;

      let fac = merged.get(key);
      if (!fac) {
        const lat = parseFloat(pick(row, 'lat'));
        const lng = parseFloat(pick(row, 'lng'));
        const fallback = MUNI_LATLNG[muni];
        fac = {
          id: '',
          code: pick(row, 'facilityId'),
          name,
          kana: pick(row, 'kana'),
          type: pick(row, 'type') || guessType(name, ''),
          muni,
          region: regionOf(muni),
          zip: toHalf(pick(row, 'zip')).replace(/^〒/, ''),
          address,
          tel: normalizeTel(pick(row, 'tel')),
          fax: normalizeTel(pick(row, 'fax')),
          url: toHalf(pick(row, 'url')),
          lat: Number.isFinite(lat) ? lat : (fallback ? fallback[0] : null),
          lng: Number.isFinite(lng) ? lng : (fallback ? fallback[1] : null),
          approxLatLng: !(Number.isFinite(lat) && Number.isFinite(lng)),
          departments: [],
          features: splitList(pick(row, 'features')),
          beds: parseInt(toHalf(pick(row, 'beds')).replace(/[^0-9]/g, ''), 10) || 0,
          hours: emptyHours(),
          hoursText: '',
          note: pick(row, 'note')
        };
        fac._hasHours = false;
        merged.set(key, fac);
      }
      rowsUsed++;

      /* 診療科目（複数列 + 区切り文字の両方に対応） */
      deptCols.forEach(c => splitList(row[c]).forEach(d => {
        if (d && !fac.departments.includes(d)) fac.departments.push(d);
      }));

      /* 診療時間：①曜日／開始／終了の3列 ②曜日ごとの列 ③自由記述 */
      const dayName = pick(row, 'dayName');
      const start = normalizeTime(pick(row, 'startTime'));
      const end = normalizeTime(pick(row, 'endTime'));
      if (dayName && start && end) {
        [...dayName].forEach(ch => {
          if (DAY_OF_CHAR[ch] && addRange(fac.hours, DAY_OF_CHAR[ch], start, end)) fac._hasHours = true;
        });
      }
      Object.entries(dayCols).forEach(([k, cols]) => {
        cols.forEach(c => rangesInCell(row[c]).forEach(r => {
          if (addRange(fac.hours, k, r[0], r[1])) fac._hasHours = true;
        }));
      });
      const freeText = pick(row, 'hoursText');
      if (freeText) {
        const parsed = parseHours(freeText);
        if (parsed) {
          DAY_KEYS.forEach(k => parsed[k].forEach(r => {
            if (addRange(fac.hours, k, r[0], r[1])) fac._hasHours = true;
          }));
        } else if (!fac.hoursText) {
          fac.hoursText = freeText;
        }
      }
    });

    let facilities = [...merged.values()];
    if (opts.onlyKnownRegions) facilities = facilities.filter(f => f.region !== 'その他');
    if (opts.typePattern) facilities = facilities.filter(f => opts.typePattern.test(`${f.type} ${f.name}`));

    facilities.forEach(f => {
      if (!f._hasHours) f.hours = null;
      delete f._hasHours;
      if (!f.code) delete f.code;
    });

    if (!facilities.length) warnings.push('取り込める行がありませんでした。');
    const noHours = facilities.filter(f => !f.hours).length;
    if (noHours) warnings.push(`${noHours} 件は診療時間を構造化できませんでした（「今診療中」の判定対象外になります）。`);

    return { facilities, warnings, header: head, rowsUsed };
  }

  return {
    REGION_GROUPS, ALL_MUNI, MUNI_LATLNG, DAY_KEYS, DAY_LABELS, FIELD_ALIASES,
    parseCSV, analyzeHeader, mapHeader, rowsToFacilities,
    muniFromAddress, regionOf, guessType, parseHours, normalizeTel, normalizeTime, splitList, toHalf
  };
});
