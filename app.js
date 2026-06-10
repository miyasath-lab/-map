/* 研修医 症例・手技ログ — 端末内のみ保存・匿名化版 */
'use strict';

const KEY_CASE = 'kenshu_cases';       // 症例記録
const KEY_PROC = 'kenshu_procs';       // 手技ログ
const KEY_MAP  = 'kenshu_idmap';       // IDハッシュ -> 匿名コード（コードのみ。生IDは保持しない）
const KEY_SEQ  = 'kenshu_seq';         // 連番カウンタ

/* 手技プリセット（類似でグループ化） */
const PROC_GROUPS = [
  { label: '穿刺',      items: ['腰椎穿刺', '胸腔穿刺', '腹腔穿刺', '骨髄穿刺'] },
  { label: '血管',      items: ['中心静脈カテーテル', '動脈採血'] },
  { label: '挿入・留置', items: ['胃管挿入', '導尿'] },
  { label: 'その他',    items: ['創縫合'] }
];

/* ---------- ユーティリティ ---------- */
const $ = (id) => document.getElementById(id);
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,10); };

async function sha256(text){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
}

/* 生ID -> 匿名コード（同じ患者は同じコード。生IDは保存しない） */
async function anonymize(rawId){
  const clean = (rawId || '').trim();
  if(!clean) return null;
  const hash = await sha256(clean);
  const map = load(KEY_MAP, {});
  if(map[hash]) return map[hash];
  let seq = load(KEY_SEQ, 0) + 1;
  const code = 'P' + String(seq).padStart(3, '0');
  map[hash] = code;
  save(KEY_MAP, map); save(KEY_SEQ, seq);
  return code;
}

/* ---------- 状態 ---------- */
const anonState = { case: null, proc: null };  // 各タブの匿名コード
let selectedProc = null;                        // 選択中の手技チップ

/* ---------- 初期化 ---------- */
function init(){
  $('caseDate').value = todayISO();
  $('procDate').value = todayISO();
  renderProcChips();
  refreshDatalists();

  document.querySelectorAll('nav button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));

  // 患者IDブロック（症例・手技で共通の仕掛け）
  setupIdBlock('case');
  setupIdBlock('proc');

  // 手技その他
  $('procOther').oninput = () => { if($('procOther').value){ selectedProc = null; renderProcChips(); } };

  // 保存
  $('btnSaveCase').onclick = saveCase;
  $('btnSaveProc').onclick = saveProc;

  // 検索・書き出し
  $('searchCase').oninput = renderCaseList;
  $('searchProc').oninput = renderProcList;
  $('btnExportCase').onclick = () => exportCSV('case');
  $('btnExportProc').onclick = () => exportCSV('proc');

  // モーダル
  $('dlgClose').onclick = () => $('dlg').close();

  // QR共有
  setupShare();

  renderCaseList();
}

/* ---------- QRコード共有 ---------- */
function setupShare(){
  const btn = $('btnShowQR');
  if(!btn) return;
  btn.onclick = () => {
    const url = location.href.split('#')[0];
    const wrap = $('qrWrap');
    wrap.innerHTML = '';
    if(typeof qrcode === 'undefined'){ wrap.textContent = 'QRライブラリ未読み込み（通信環境を確認）'; return; }
    try{
      const qr = qrcode(0, 'M');     // typeNumber=0(自動), 誤り訂正レベルM
      qr.addData(url);
      qr.make();
      wrap.innerHTML = qr.createImgTag(5, 8);  // cellSize=5, margin=8
      wrap.querySelector('img').style.maxWidth = '240px';
      $('qrUrl').textContent = url;
    }catch(e){ wrap.textContent = 'QR生成に失敗しました'; }
  };
}

/* 患者IDブロックの配線（prefix = 'case' | 'proc'） */
function setupIdBlock(prefix){
  $('btnCam_'+prefix).onclick = () => $('fileCam_'+prefix).click();
  $('fileCam_'+prefix).onchange = (e) => onPhoto(e, prefix);
  $('btnManual_'+prefix).onclick = () => { const i = $('rawId_'+prefix); i.classList.toggle('hide'); i.focus(); };
  $('rawId_'+prefix).oninput = async (e) => setAnon(prefix, await anonymize(e.target.value));
}

function setAnon(prefix, code){
  anonState[prefix] = code;
  $('anonCode_'+prefix).textContent = code || '未設定';
}

function switchTab(name){
  ['case','proc','stat','sync'].forEach(t => $('tab-'+t).classList.toggle('hide', t !== name));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  if(name === 'case') renderCaseList();
  if(name === 'proc') renderProcList();
  if(name === 'stat') renderStat();
  if(name === 'sync' && window.renderSync) renderSync();
}

/* ---------- 手技チップ（グループ表示） ---------- */
function renderProcChips(){
  const wrap = $('procChips');
  wrap.innerHTML = '';
  PROC_GROUPS.forEach(g => {
    const grp = document.createElement('div');
    grp.className = 'grp';
    grp.innerHTML = `<div class="gl">${g.label}</div>`;
    const chips = document.createElement('div');
    chips.className = 'chips';
    g.items.forEach(p => {
      const c = document.createElement('div');
      c.className = 'chip' + (selectedProc === p ? ' on' : '');
      c.textContent = p;
      c.onclick = () => { selectedProc = (selectedProc === p ? null : p); $('procOther').value=''; renderProcChips(); };
      chips.appendChild(c);
    });
    grp.appendChild(chips);
    wrap.appendChild(grp);
  });
}

/* ---------- 写メOCR ---------- */
async function onPhoto(e, prefix){
  const file = e.target.files[0];
  if(!file) return;
  const line = $('ocrLine_'+prefix);
  line.textContent = '🔎 画像から読み取り中…（数秒〜十数秒）';
  try{
    const { data } = await Tesseract.recognize(file, 'eng', {
      tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-'
    });
    const cand = (data.text.match(/[A-Z0-9][A-Z0-9\-]{3,}/g) || [])
      .sort((a,b) => (b.replace(/\D/g,'').length) - (a.replace(/\D/g,'').length))[0];
    const input = $('rawId_'+prefix);
    if(cand){
      line.textContent = '読取候補：' + cand + '（必要なら手入力で修正）';
      input.classList.remove('hide'); input.value = cand;
      setAnon(prefix, await anonymize(cand));
    }else{
      line.textContent = '⚠️ IDを読み取れませんでした。手入力してください。';
      input.classList.remove('hide');
    }
  }catch(err){
    line.textContent = '⚠️ 読取エラー：手入力してください。';
    $('rawId_'+prefix).classList.remove('hide');
  }finally{
    e.target.value = '';   // 画像は保持しない
  }
}

/* ---------- 保存：症例 ---------- */
function saveCase(){
  const dx = $('dxCase').value.trim();
  if(!anonState.case){ alert('患者ID（写メ or 手入力）を設定してください'); return; }
  if(!dx){ alert('疾患名を入力してください'); return; }

  const rec = {
    id: Date.now(),
    anon: anonState.case,
    dx,
    caseDate: $('caseDate').value,
    memo: $('memoCase').value.trim(),
    createdAt: new Date().toISOString()
  };
  const recs = load(KEY_CASE, []); recs.unshift(rec); save(KEY_CASE, recs);

  setAnon('case', null);
  $('rawId_case').value = ''; $('rawId_case').classList.add('hide');
  $('ocrLine_case').textContent = '';
  $('dxCase').value = ''; $('memoCase').value = '';
  $('caseDate').value = todayISO();
  refreshDatalists(); renderCaseList();
  flash('✅ 症例を登録（' + rec.anon + ' / ' + rec.dx + '）');
}

/* ---------- 保存：手技 ---------- */
function saveProc(){
  const proc = selectedProc || $('procOther').value.trim();
  if(!proc){ alert('手技を選択または入力してください'); return; }

  const rec = {
    id: Date.now(),
    proc,
    procDate: $('procDate').value,
    supervisor: $('supervisor').value.trim(),
    anon: anonState.proc || '',
    memo: $('memoProc').value.trim(),
    createdAt: new Date().toISOString()
  };
  const recs = load(KEY_PROC, []); recs.unshift(rec); save(KEY_PROC, recs);

  selectedProc = null; $('procOther').value = ''; renderProcChips();
  $('supervisor').value = '';
  setAnon('proc', null);
  $('rawId_proc').value = ''; $('rawId_proc').classList.add('hide');
  $('ocrLine_proc').textContent = '';
  $('memoProc').value = '';
  $('procDate').value = todayISO();
  refreshDatalists(); renderProcList();
  flash('✅ 手技を登録（' + rec.proc + '）');
}

function flash(msg){
  const b = document.createElement('div');
  b.textContent = msg;
  b.style.cssText = 'position:fixed;left:50%;bottom:84px;transform:translateX(-50%);background:#198754;color:#fff;padding:10px 18px;border-radius:999px;font-size:14px;z-index:50;box-shadow:0 4px 12px rgba(0,0,0,.2)';
  document.body.appendChild(b);
  setTimeout(() => b.remove(), 2200);
}

/* ---------- 入力補助 ---------- */
function refreshDatalists(){
  const fill = (id, vals) => { $(id).innerHTML = [...new Set(vals.filter(Boolean))].map(v => `<option value="${esc(v)}">`).join(''); };
  fill('dxList', load(KEY_CASE, []).map(r => r.dx));
  fill('supList', load(KEY_PROC, []).map(r => r.supervisor));
}

/* ---------- 一覧：症例 ---------- */
function renderCaseList(){
  const q = $('searchCase').value.trim().toLowerCase();
  let recs = load(KEY_CASE, []);
  if(q) recs = recs.filter(r => [r.dx, r.anon, r.memo].join(' ').toLowerCase().includes(q));
  const area = $('listCase');
  if(!recs.length){ area.innerHTML = '<div class="empty">症例がありません</div>'; return; }
  area.innerHTML = recs.map(r => `
    <div class="rec" data-id="${r.id}" data-type="case">
      <div class="top">
        <span class="pcode">${esc(r.anon)}</span>
        <span class="meta">${esc(r.caseDate || '')}</span>
      </div>
      <div class="dx">${esc(r.dx)}</div>
      ${r.memo ? `<div class="meta">${esc(r.memo)}</div>` : ''}
    </div>`).join('');
  bindDetail(area);
}

/* ---------- 一覧：手技 ---------- */
function renderProcList(){
  const q = $('searchProc').value.trim().toLowerCase();
  let recs = load(KEY_PROC, []);
  if(q) recs = recs.filter(r => [r.proc, r.supervisor, r.anon, r.memo].join(' ').toLowerCase().includes(q));
  const area = $('listProc');
  if(!recs.length){ area.innerHTML = '<div class="empty">手技がありません</div>'; return; }
  area.innerHTML = recs.map(r => `
    <div class="rec" data-id="${r.id}" data-type="proc">
      <div class="top">
        <div class="proc">${esc(r.proc)}</div>
        <span class="meta">${esc(r.procDate || '')}</span>
      </div>
      <div class="meta">${r.supervisor ? '監督者：'+esc(r.supervisor) : '監督者：—'}${r.anon ? '｜'+esc(r.anon) : ''}</div>
    </div>`).join('');
  bindDetail(area);
}

function bindDetail(area){
  area.querySelectorAll('.rec').forEach(el => el.onclick = () => openDetail(el.dataset.type, Number(el.dataset.id)));
}

/* ---------- 詳細・削除 ---------- */
function openDetail(type, id){
  const key = type === 'case' ? KEY_CASE : KEY_PROC;
  const r = load(key, []).find(x => x.id === id);
  if(!r) return;
  if(type === 'case'){
    $('dlgTitle').textContent = r.anon + '｜' + r.dx;
    $('dlgBody').innerHTML = `<div style="line-height:1.9">
      <div><b>匿名コード：</b>${esc(r.anon)}</div>
      <div><b>疾患名：</b>${esc(r.dx)}</div>
      <div><b>記録日：</b>${esc(r.caseDate) || '—'}</div>
      <div><b>メモ：</b>${esc(r.memo) || '—'}</div>
      <div style="color:#6b7280;font-size:12px;margin-top:8px">登録：${new Date(r.createdAt).toLocaleString('ja-JP')}</div></div>`;
  }else{
    $('dlgTitle').textContent = r.proc;
    $('dlgBody').innerHTML = `<div style="line-height:1.9">
      <div><b>手技：</b>${esc(r.proc)}</div>
      <div><b>施行日：</b>${esc(r.procDate) || '—'}</div>
      <div><b>監督者：</b>${esc(r.supervisor) || '—'}</div>
      <div><b>患者：</b>${esc(r.anon) || '—'}</div>
      <div><b>メモ：</b>${esc(r.memo) || '—'}</div>
      <div style="color:#6b7280;font-size:12px;margin-top:8px">登録：${new Date(r.createdAt).toLocaleString('ja-JP')}</div></div>`;
  }
  $('dlgDel').onclick = () => {
    if(!confirm('この記録を削除しますか？')) return;
    save(key, load(key, []).filter(x => x.id !== id));
    $('dlg').close();
    type === 'case' ? renderCaseList() : renderProcList();
    refreshDatalists();
  };
  $('dlg').showModal();
}

/* ---------- 集計 ---------- */
function renderStat(){
  const cases = load(KEY_CASE, []);
  const procs = load(KEY_PROC, []);
  $('statCaseTotal').textContent = cases.length;
  $('statProcTotal').textContent = procs.length;
  const count = (arr, key) => {
    const m = {};
    arr.forEach(r => { const v = r[key] || '（未入力）'; m[v] = (m[v]||0)+1; });
    return Object.entries(m).sort((a,b) => b[1]-a[1]);
  };
  const html = (rows) => rows.length
    ? rows.map(([k,v]) => `<div class="stat"><span>${esc(k)}</span><b>${v}件</b></div>`).join('')
    : '<div class="empty">データなし</div>';
  $('statProc').innerHTML = html(count(procs, 'proc'));
  $('statDx').innerHTML   = html(count(cases, 'dx'));
  $('statSup').innerHTML  = html(count(procs, 'supervisor'));
}

/* ---------- CSV書き出し ---------- */
function exportCSV(type){
  if(type === 'case'){
    const recs = load(KEY_CASE, []);
    if(!recs.length){ alert('書き出す症例がありません'); return; }
    const head = ['匿名コード','疾患名','記録日','メモ','登録日時'];
    const rows = recs.map(r => [r.anon, r.dx, r.caseDate, r.memo, r.createdAt]);
    download('症例記録_' + todayISO() + '.csv', head, rows);
  }else{
    const recs = load(KEY_PROC, []);
    if(!recs.length){ alert('書き出す手技がありません'); return; }
    const head = ['手技','施行日','監督者','患者','メモ','登録日時'];
    const rows = recs.map(r => [r.proc, r.procDate, r.supervisor, r.anon, r.memo, r.createdAt]);
    download('手技ログ_' + todayISO() + '.csv', head, rows);
  }
}

function download(name, head, rows){
  const csv = '﻿' + head.join(',') + '\n' +
    rows.map(r => r.map(v => `"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
  a.download = name; a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- PWA ---------- */
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('sw.js').catch(()=>{});
}

init();
