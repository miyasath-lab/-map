/* 那覇市・南部地区 医療機関検索 — 静的サイト版
 * 検索・絞り込み・並べ替えはすべてブラウザ内で完結する（入力は外部送信しない）。
 */
'use strict';

const KEY_FAV    = 'cf_favorites';    // お気に入り（医療機関名の配列）
const KEY_IMPORT = 'cf_import';       // CSVから取り込んだデータセット

const DAY_KEYS   = CsvMap.DAY_KEYS;
const DAY_LABELS = CsvMap.DAY_LABELS;

/* ---------- ユーティリティ ---------- */
const $ = (id) => document.getElementById(id);
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uniq = (a) => [...new Set(a)];

/* 検索用の正規化（全角/半角・カナ/かな・大文字小文字の揺れを吸収） */
function normalize(s){
  return CsvMap.toHalf(s).toLowerCase()
    .replace(/[ァ-ン]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

function haversine(a, b, c, d){
  const R = 6371, r = Math.PI / 180;
  const dLat = (c - a) * r, dLng = (d - b) * r;
  const h = Math.sin(dLat/2)**2 + Math.cos(a*r) * Math.cos(c*r) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------- 状態 ---------- */
const state = {
  meta: {},
  facilities: [],
  favorites: load(KEY_FAV, []),
  geo: null,                 // {lat,lng}
  imported: load(KEY_IMPORT, null),
  filters: { q:'', area:'', course:'', feats:[], open:false, fav:false, hospital:false, sort:'name' },
  results: []
};

/* ---------- 診療時間 ---------- */
const toMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + (m || 0); };

/** 指定日時に診療しているか。判定できないときは null（＝不明）。 */
function isOpenAt(fac, when){
  if (!fac.hours) return null;
  const key = DAY_KEYS[(when.getDay() + 6) % 7];   // getDay: 0=日 → mon始まりへ
  const ranges = fac.hours[key];
  if (!Array.isArray(ranges) || !ranges.length) return false;
  const now = when.getHours() * 60 + when.getMinutes();
  return ranges.some(([s, e]) => now >= toMin(s) && now < toMin(e));
}

function hoursTable(fac){
  if (!fac.hours){
    return fac.hoursText ? `<div style="font-size:14px">${esc(fac.hoursText)}</div>` : '<div class="hint">診療時間の登録がありません</div>';
  }
  const todayKey = DAY_KEYS[(new Date().getDay() + 6) % 7];
  const rows = DAY_KEYS.map(k => {
    const r = fac.hours[k];
    const txt = (Array.isArray(r) && r.length)
      ? r.map(([s, e]) => `${s}–${e === '24:00' ? '24:00' : e}`).join('　')
      : '休診';
    return `<tr class="${k === todayKey ? 'today' : ''}"><th>${DAY_LABELS[k]}</th><td>${esc(txt)}</td></tr>`;
  }).join('');
  return `<table class="htab">${rows}</table>`;
}

/* ---------- データ読み込み ---------- */
async function loadData(){
  if (state.imported && Array.isArray(state.imported.facilities) && state.imported.facilities.length){
    state.meta = state.imported.meta || {};
    state.facilities = state.imported.facilities;
    return;
  }
  const res = await fetch('data/facilities.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('data/facilities.json を読み込めませんでした');
  const json = await res.json();
  state.meta = json.meta || {};
  state.facilities = json.facilities || [];
}

/* ---------- 絞り込みUIの組み立て ---------- */
function buildAreaSelect(){
  const groups = state.meta.regionGroups || CsvMap.REGION_GROUPS;
  const counts = {};
  state.facilities.forEach(f => { counts[f.muni] = (counts[f.muni] || 0) + 1; });

  let html = `<option value="">すべての地区</option>`;
  groups.forEach(g => {
    const total = g.members.reduce((n, m) => n + (counts[m] || 0), 0);
    if (!total) return;
    html += `<optgroup label="${esc(g.label)}">`;
    html += `<option value="region:${esc(g.label)}">${esc(g.label)}すべて（${total}）</option>`;
    g.members.forEach(m => {
      if (!counts[m]) return;
      html += `<option value="muni:${esc(m)}">　${esc(m)}（${counts[m]}）</option>`;
    });
    html += `</optgroup>`;
  });
  const known = groups.flatMap(g => g.members);
  const others = uniq(state.facilities.map(f => f.muni).filter(m => m && !known.includes(m)));
  if (others.length){
    html += `<optgroup label="その他">` +
      others.map(m => `<option value="muni:${esc(m)}">${esc(m)}（${counts[m]}）</option>`).join('') + `</optgroup>`;
  }
  $('area').innerHTML = html;
}

function buildCourseSelect(){
  const counts = {};
  state.facilities.forEach(f => (f.departments || []).forEach(d => { counts[d] = (counts[d] || 0) + 1; }));
  const list = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b, 'ja'));
  $('course').innerHTML = `<option value="">すべての診療科</option>` +
    list.map(d => `<option value="${esc(d)}">${esc(d)}（${counts[d]}）</option>`).join('');
}

function buildFeatureChips(){
  const counts = {};
  state.facilities.forEach(f => (f.features || []).forEach(v => { counts[v] = (counts[v] || 0) + 1; }));
  const list = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b, 'ja')).slice(0, 14);
  $('featChips').innerHTML = list.length
    ? list.map(v => `<button class="chip" data-feat="${esc(v)}">${esc(v)}</button>`).join('')
    : '<span class="hint">特徴の登録がありません</span>';
}

/* ---------- 絞り込み本体 ---------- */
function applyFilters(){
  const f = state.filters;
  const q = normalize(f.q);
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];
  const now = new Date();

  let list = state.facilities.filter(fac => {
    if (f.area.startsWith('region:') && fac.region !== f.area.slice(7)) return false;
    if (f.area.startsWith('muni:')   && fac.muni   !== f.area.slice(5)) return false;
    if (f.course && !(fac.departments || []).includes(f.course)) return false;
    if (f.hospital && fac.type !== '病院') return false;
    if (f.fav && !state.favorites.includes(fac.name)) return false;
    if (f.feats.length && !f.feats.every(v => (fac.features || []).includes(v))) return false;
    if (f.open && isOpenAt(fac, now) !== true) return false;
    if (terms.length){
      const hay = normalize([fac.name, fac.kana, fac.address, fac.muni, fac.type,
        (fac.departments || []).join(' '), (fac.features || []).join(' '), fac.note].join(' '));
      if (!terms.every(t => hay.includes(t))) return false;
    }
    return true;
  });

  if (state.geo){
    list.forEach(fac => {
      fac._dist = (fac.lat != null && fac.lng != null)
        ? haversine(state.geo.lat, state.geo.lng, fac.lat, fac.lng) : null;
    });
  }

  const byName = (a, b) => (a.kana || a.name).localeCompare(b.kana || b.name, 'ja');
  if (f.sort === 'dist' && state.geo){
    list.sort((a, b) => (a._dist ?? 1e9) - (b._dist ?? 1e9) || byName(a, b));
  } else if (f.sort === 'region'){
    const order = (state.meta.regionGroups || CsvMap.REGION_GROUPS).map(g => g.label);
    list.sort((a, b) => (order.indexOf(a.region) - order.indexOf(b.region)) ||
      a.muni.localeCompare(b.muni, 'ja') || byName(a, b));
  } else {
    list.sort(byName);
  }

  state.results = list;
  render();
  syncUrl();
}

/* ---------- 描画 ---------- */
function facCard(fac){
  const open = isOpenAt(fac, new Date());
  const status = open === true ? '<span class="open-now">● 診療中</span>'
    : open === false ? '<span class="closed-now">● 時間外</span>' : '';
  const fav = state.favorites.includes(fac.name);
  const deps = (fac.departments || []).slice(0, 6)
    .map(d => `<span class="tag">${esc(d)}</span>`).join('');
  const feats = (fac.features || []).slice(0, 4)
    .map(v => `<span class="tag g">${esc(v)}</span>`).join('');
  const dist = (fac._dist != null)
    ? `<span class="tag n">約${fac._dist < 10 ? fac._dist.toFixed(1) : Math.round(fac._dist)}km</span>` : '';
  const mapQ = encodeURIComponent(fac.address || fac.name);

  return `<article class="fac" data-id="${esc(fac.id)}">
    <div class="top">
      <div>
        <div class="nm">${esc(fac.name)}</div>
        <div class="meta">${esc(fac.type || '')}｜${esc(fac.muni || '')}　${status}</div>
        <div class="meta">${esc(fac.address || '')}</div>
      </div>
      <button class="fav" data-fav="${esc(fac.name)}" aria-label="お気に入り">${fav ? '⭐' : '☆'}</button>
    </div>
    <div class="deps">${deps}${feats}${dist}</div>
    <div class="acts">
      ${fac.tel ? `<a href="tel:${esc(fac.tel)}" data-stop>📞 ${esc(fac.tel)}</a>` : ''}
      <a href="https://www.google.com/maps/search/?api=1&query=${mapQ}" target="_blank" rel="noopener" data-stop>🗺 地図</a>
    </div>
  </article>`;
}

function render(){
  $('hitCount').textContent = state.results.length;
  $('list').innerHTML = state.results.length
    ? state.results.map(facCard).join('')
    : `<div class="empty">条件に合う医療機関が見つかりませんでした。<br>キーワードを減らすか、地区・診療科の指定を外してみてください。</div>`;
  renderFavTab();
}

function renderFavTab(){
  const favs = state.facilities.filter(f => state.favorites.includes(f.name));
  $('favList').innerHTML = favs.length
    ? favs.map(facCard).join('')
    : `<div class="empty">お気に入りはまだありません。<br>一覧の ☆ を押すと登録できます。</div>`;
}

function renderDataTab(){
  const m = state.meta;
  const src = state.imported ? 'この端末に取り込んだCSV' : 'data/facilities.json';
  $('dataInfo').innerHTML = `
    <div class="kv"><span class="k">データ源</span><span class="v">${esc(src)}</span></div>
    <div class="kv"><span class="k">出典</span><span class="v">${esc(m.source || '未設定')}</span></div>
    <div class="kv"><span class="k">更新日</span><span class="v">${esc(m.updated || '未設定')}</span></div>
    <div class="kv"><span class="k">件数</span><span class="v">${state.facilities.length} 件</span></div>`;
  $('sourceInfo').innerHTML = `${esc(m.source || '未設定')}<br>更新日：${esc(m.updated || '未設定')}` +
    (m.notice ? `<br><br>${esc(m.notice)}` : '');
}

/* ---------- 詳細ダイアログ ---------- */
let dlgFac = null;
function openDetail(fac){
  dlgFac = fac;
  $('dlgName').textContent = fac.name;
  const open = isOpenAt(fac, new Date());
  $('dlgSub').innerHTML = `${esc(fac.type || '')}｜${esc(fac.muni || '')}` +
    (open === true ? '　<span class="open-now">● 診療中</span>' : open === false ? '　<span class="closed-now">● 時間外</span>' : '');
  const mapQ = encodeURIComponent(fac.address || fac.name);
  const kv = [];
  if (fac.address) kv.push(['住所', `${esc(fac.zip ? '〒' + fac.zip + ' ' : '')}${esc(fac.address)}<br>
    <a href="https://www.google.com/maps/search/?api=1&query=${mapQ}" target="_blank" rel="noopener">地図で開く</a>`]);
  if (fac.tel) kv.push(['電話', `<a href="tel:${esc(fac.tel)}">${esc(fac.tel)}</a>`]);
  if (fac.fax) kv.push(['FAX', esc(fac.fax)]);
  if (fac.url) kv.push(['サイト', `<a href="${esc(fac.url)}" target="_blank" rel="noopener">${esc(fac.url)}</a>`]);
  if ((fac.departments || []).length) kv.push(['診療科', (fac.departments).map(d => `<span class="tag">${esc(d)}</span>`).join(' ')]);
  if ((fac.features || []).length) kv.push(['特徴', (fac.features).map(v => `<span class="tag g">${esc(v)}</span>`).join(' ')]);
  if (fac.beds) kv.push(['病床数', `${fac.beds} 床`]);
  if (fac.note) kv.push(['備考', esc(fac.note)]);
  if (fac._dist != null) kv.push(['距離', `現在地から約 ${fac._dist.toFixed(1)} km` + (fac.approxLatLng ? '（座標は市町村中心の概算）' : '')]);

  $('dlgBody').innerHTML =
    `<div style="margin-bottom:12px">${kv.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')}</div>` +
    `<div class="seclabel" style="margin:6px 2px">診療時間</div>${hoursTable(fac)}` +
    `<div class="hint">診療時間・休診日は変更されることがあります。受診前に医療機関へご確認ください。</div>`;
  $('dlg').showModal();
}

function copyDetail(){
  if (!dlgFac) return;
  const f = dlgFac;
  const text = [f.name, f.address, f.tel ? `TEL ${f.tel}` : '', (f.departments || []).join('、'), f.url]
    .filter(Boolean).join('\n');
  const done = () => { $('dlgCopy').textContent = '✅ コピーしました'; setTimeout(() => { $('dlgCopy').textContent = '📋 情報をコピー'; }, 1600); };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => {});
  else {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } finally { ta.remove(); }
  }
}

/* ---------- CSV書き出し ---------- */
function download(filename, text, mime){
  const blob = new Blob([`﻿${text}`], { type: mime || 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

function exportCsv(){
  if (!state.results.length) return;
  const head = ['医療機関名称', '種別', '市町村', '所在地', '電話番号', '診療科目', '特徴', 'ホームページアドレス'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = state.results.map(f => [f.name, f.type, f.muni, f.address, f.tel,
    (f.departments || []).join('、'), (f.features || []).join('、'), f.url].map(cell).join(','));
  download(`医療機関一覧_${new Date().toISOString().slice(0, 10)}.csv`, [head.map(cell).join(','), ...body].join('\r\n'));
}

/* ---------- CSV取り込み ---------- */
function importCsv(file){
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const { facilities, warnings } = CsvMap.rowsToFacilities(CsvMap.parseCSV(reader.result));
      if (!facilities.length){
        $('csvLine').innerHTML = `<span style="color:var(--danger)">${esc(warnings.join(' / '))}</span>`;
        return;
      }
      const data = {
        meta: { version: '1.0.0', updated: new Date().toISOString().slice(0, 10),
                source: `取り込みCSV：${file.name}`, isSample: false, regionGroups: CsvMap.REGION_GROUPS },
        facilities
      };
      save(KEY_IMPORT, data);
      state.imported = data; state.meta = data.meta; state.facilities = facilities;
      buildAreaSelect(); buildCourseSelect(); buildFeatureChips();
      applyFilters(); renderDataTab(); showSampleBanner();
      $('csvLine').innerHTML = `✅ ${facilities.length} 件を取り込みました。` +
        (warnings.length ? `<br><span style="color:#8a6d3b">${esc(warnings.join(' / '))}</span>` : '');
    } catch (e){
      $('csvLine').innerHTML = `<span style="color:var(--danger)">取り込みに失敗しました：${esc(e.message)}</span>`;
    }
  };
  reader.readAsText(file, 'UTF-8');
}

/* ---------- URL同期（検索条件を共有できるようにする）---------- */
function syncUrl(){
  const f = state.filters;
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.area) p.set('area', f.area);
  if (f.course) p.set('course', f.course);
  if (f.feats.length) p.set('feat', f.feats.join(','));
  if (f.open) p.set('open', '1');
  if (f.fav) p.set('fav', '1');
  if (f.hospital) p.set('hospital', '1');
  if (f.sort !== 'name') p.set('sort', f.sort);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function readUrl(){
  const p = new URLSearchParams(location.search);
  const f = state.filters;
  f.q = p.get('q') || '';
  f.area = p.get('area') || '';
  f.course = p.get('course') || '';
  f.feats = (p.get('feat') || '').split(',').filter(Boolean);
  f.open = p.get('open') === '1';
  f.fav = p.get('fav') === '1';
  f.hospital = p.get('hospital') === '1';
  f.sort = p.get('sort') || 'name';
}

function reflectUi(){
  const f = state.filters;
  $('q').value = f.q;
  $('area').value = f.area;
  $('course').value = f.course;
  $('sort').value = f.sort;
  document.querySelectorAll('#toggleChips .chip').forEach(el => {
    el.classList.toggle('on', !!f[el.dataset.toggle]);
  });
  document.querySelectorAll('#featChips .chip').forEach(el => {
    el.classList.toggle('on', f.feats.includes(el.dataset.feat));
  });
  reflectFeatCount();
}

/* 折りたたんだ「特徴」の選択数を見出しに出す */
function reflectFeatCount(){
  const n = state.filters.feats.length;
  $('featCount').textContent = n ? `（${n}件選択中）` : '';
  if (n) $('featBox').open = true;
}

/* ---------- 現在地 ---------- */
function useGeo(){
  if (!navigator.geolocation){ $('geoLine').textContent = 'この端末では現在地を取得できません。'; return; }
  $('geoLine').textContent = '現在地を取得しています…';
  navigator.geolocation.getCurrentPosition(pos => {
    state.geo = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    state.filters.sort = 'dist'; $('sort').value = 'dist';
    $('geoLine').textContent = '📍 現在地を取得しました（近い順に並べ替えます）。座標が未登録の施設は市町村中心からの概算です。';
    applyFilters();
  }, err => {
    $('geoLine').textContent = `現在地を取得できませんでした（${esc(err.message)}）。`;
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
}

/* ---------- サンプルデータの告知 ---------- */
function showSampleBanner(){
  const el = $('sampleBanner');
  if (state.meta.isSample){
    el.innerHTML = `⚠️ <b>これはサンプルデータです。</b>掲載されている医療機関はすべて架空で、実在しません。` +
      `実データへの差し替え方法は「🗂 データ」タブをご覧ください。`;
    el.classList.remove('hide');
  } else {
    el.classList.add('hide');
  }
}

/* ---------- イベント ---------- */
function bind(){
  document.querySelectorAll('nav button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b === btn));
      ['search', 'fav', 'data', 'info'].forEach(t => $(`tab-${t}`).classList.toggle('hide', t !== btn.dataset.tab));
      if (btn.dataset.tab === 'data') renderDataTab();
      window.scrollTo(0, 0);
    });
  });

  let timer = null;
  $('q').addEventListener('input', e => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.filters.q = e.target.value.trim(); applyFilters(); }, 180);
  });
  $('area').addEventListener('change', e => { state.filters.area = e.target.value; applyFilters(); });
  $('course').addEventListener('change', e => { state.filters.course = e.target.value; applyFilters(); });
  $('sort').addEventListener('change', e => {
    state.filters.sort = e.target.value;
    if (e.target.value === 'dist' && !state.geo) useGeo(); else applyFilters();
  });
  $('btnGeo').addEventListener('click', useGeo);
  $('btnReset').addEventListener('click', () => {
    state.filters = { q:'', area:'', course:'', feats:[], open:false, fav:false, hospital:false, sort:'name' };
    state.geo = null; $('geoLine').textContent = '';
    reflectUi(); applyFilters();
  });

  $('toggleChips').addEventListener('click', e => {
    const el = e.target.closest('.chip'); if (!el) return;
    const k = el.dataset.toggle;
    state.filters[k] = !state.filters[k];
    el.classList.toggle('on', state.filters[k]);
    applyFilters();
  });
  $('featChips').addEventListener('click', e => {
    const el = e.target.closest('.chip'); if (!el) return;
    const v = el.dataset.feat;
    const i = state.filters.feats.indexOf(v);
    if (i < 0) state.filters.feats.push(v); else state.filters.feats.splice(i, 1);
    el.classList.toggle('on', i < 0);
    reflectFeatCount();
    applyFilters();
  });

  /* 一覧のクリック（お気に入り／電話・地図リンク／詳細） */
  document.addEventListener('click', e => {
    const favBtn = e.target.closest('[data-fav]');
    if (favBtn){
      e.stopPropagation();
      const name = favBtn.dataset.fav;
      const i = state.favorites.indexOf(name);
      if (i < 0) state.favorites.push(name); else state.favorites.splice(i, 1);
      save(KEY_FAV, state.favorites);
      applyFilters();
      return;
    }
    if (e.target.closest('[data-stop]')) return;      // 電話・地図はそのまま開く
    const card = e.target.closest('.fac');
    if (card){
      const fac = state.facilities.find(f => f.id === card.dataset.id);
      if (fac) openDetail(fac);
    }
  });

  $('dlgClose').addEventListener('click', () => $('dlg').close());
  $('dlgCopy').addEventListener('click', copyDetail);
  $('btnExport').addEventListener('click', exportCsv);
  $('csvFile').addEventListener('change', e => { if (e.target.files[0]) importCsv(e.target.files[0]); });
  $('btnClearImport').addEventListener('click', async () => {
    if (!state.imported){ $('csvLine').textContent = '取り込みデータはありません。'; return; }
    localStorage.removeItem(KEY_IMPORT);
    state.imported = null;
    await loadData();
    buildAreaSelect(); buildCourseSelect(); buildFeatureChips();
    applyFilters(); renderDataTab(); showSampleBanner();
    $('csvLine').textContent = '取り込みデータを削除し、同梱データに戻しました。';
  });
  $('btnDumpJson').addEventListener('click', () => {
    const data = { meta: state.meta, facilities: state.facilities };
    download('facilities.json', JSON.stringify(data, null, 2), 'application/json');
  });
}

/* ---------- 起動 ---------- */
(async function init(){
  bind();
  try {
    await loadData();
  } catch (e){
    $('list').innerHTML = `<div class="empty">データを読み込めませんでした。<br>${esc(e.message)}<br><br>
      ファイルを直接開いた場合は、簡易サーバー（例：<code>python3 -m http.server</code>）経由で開いてください。</div>`;
    return;
  }
  readUrl();
  buildAreaSelect(); buildCourseSelect(); buildFeatureChips();
  reflectUi(); showSampleBanner(); renderDataTab();
  applyFilters();

  if ('serviceWorker' in navigator && location.protocol === 'https:'){
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
