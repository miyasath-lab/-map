/* GAS（Google Apps Script）Web App へ匿名化データを送信して集計 */
'use strict';

const KEY_GAS_URL  = 'kenshu_gas_url';
const KEY_GAS_KEY  = 'kenshu_gas_key';
const KEY_GAS_USER = 'kenshu_user';

function renderGas(){
  $('gasUrl').value  = localStorage.getItem(KEY_GAS_URL)  || '';
  $('gasKey').value  = localStorage.getItem(KEY_GAS_KEY)  || '';
  $('gasUser').value = localStorage.getItem(KEY_GAS_USER) || '';
}

function setupGas(){
  if(!$('btnSendGas')) return;

  $('btnSaveGas').onclick = () => {
    localStorage.setItem(KEY_GAS_URL,  $('gasUrl').value.trim());
    localStorage.setItem(KEY_GAS_KEY,  $('gasKey').value.trim());
    localStorage.setItem(KEY_GAS_USER, $('gasUser').value.trim());
    flash('✅ GAS設定を保存しました');
  };

  $('btnSendGas').onclick = async () => {
    const s = $('gasStatus');
    const url = ($('gasUrl').value || localStorage.getItem(KEY_GAS_URL) || '').trim();
    const key = ($('gasKey').value || localStorage.getItem(KEY_GAS_KEY) || '').trim();
    if(!url){ s.textContent = '⚠️ GAS Web App URLを入力・保存してください'; return; }

    const payload = {
      key,
      user:  ($('gasUser').value || localStorage.getItem(KEY_GAS_USER) || '').trim(),
      cases: load(KEY_CASE, []),   // 匿名化済み（生IDなし）
      procs: load(KEY_PROC, [])
    };

    s.textContent = '📤 送信中…';
    try{
      // GASのCORS制約を避けるため text/plain + no-cors で送信（応答は読めないため成功はシートで確認）
      await fetch(url, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      });
      s.textContent = '✅ 送信しました（症例' + payload.cases.length + '件／手技' + payload.procs.length +
        '件）。スプレッドシートをご確認ください。';
      flash('✅ シートへ送信');
    }catch(err){
      s.textContent = '⚠️ 送信に失敗しました（URL・通信環境を確認）：' + err.message;
    }
  };

  // 設定QRを作る（配布用）：アプリURL＋設定を1枚のQRに（普通のカメラで開く＆自動設定）
  $('btnShowGasQR').onclick = () => {
    const wrap = $('gasQrWrap');
    wrap.innerHTML = '';
    const url = $('gasUrl').value.trim() || localStorage.getItem(KEY_GAS_URL) || '';
    const key = $('gasKey').value.trim() || localStorage.getItem(KEY_GAS_KEY) || '';
    if(!url){ wrap.textContent = '⚠️ 先にURLを入力してください'; return; }
    if(typeof qrcode === 'undefined'){ wrap.textContent = 'QRライブラリ未読み込み'; return; }
    const base = location.origin + location.pathname;       // このアプリの公開URL
    const cfg = encodeURIComponent(JSON.stringify({ url, key }));
    const full = base + '#gas=' + cfg;                       // URLに設定を埋め込む
    try{
      const qr = qrcode(0, 'M');
      qr.addData(full);
      qr.make();
      const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
      const note = local
        ? '⚠️ 今はlocalhostのURLです。公開（https）後に作り直してください'
        : 'このQRを研修医に配ってください（普通のカメラでOK）';
      wrap.innerHTML = qr.createImgTag(5, 8) + '<div class="hint" style="margin-top:6px">' + note + '</div>';
      wrap.querySelector('img').style.maxWidth = '240px';
    }catch(e){ wrap.textContent = 'QR生成に失敗しました（URLが長すぎる可能性）'; }
  };

  // 設定QRを読み取る（カメラ）
  $('btnScanGas').onclick = () => startScan(applyScannedConfig);
  $('btnScanCancel').onclick = stopScan;
}

/* ---------- QRカメラスキャン ---------- */
let _scanStream = null, _scanRAF = null;

async function startScan(onResult){
  const overlay = $('scanOverlay');
  const video = $('scanVideo');
  if(typeof jsQR === 'undefined'){ alert('QR読み取りライブラリが読み込めません（通信環境を確認）'); return; }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    alert('このブラウザ/環境ではカメラが使えません。URLは手入力してください。'); return;
  }
  overlay.classList.remove('hide');
  try{
    _scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  }catch(err){
    overlay.classList.add('hide');
    alert('カメラを起動できませんでした：' + err.message + '\n（https接続とカメラ許可が必要です）');
    return;
  }
  video.srcObject = _scanStream;
  video.setAttribute('playsinline', 'true');
  await video.play();

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tick = () => {
    if(video.readyState === video.HAVE_ENOUGH_DATA){
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if(code && code.data){ stopScan(); onResult(code.data); return; }
    }
    _scanRAF = requestAnimationFrame(tick);
  };
  _scanRAF = requestAnimationFrame(tick);
}

function stopScan(){
  if(_scanRAF){ cancelAnimationFrame(_scanRAF); _scanRAF = null; }
  if(_scanStream){ _scanStream.getTracks().forEach(t => t.stop()); _scanStream = null; }
  $('scanOverlay').classList.add('hide');
}

/* QRの中身（URL＋#gas / JSON / 生URL）から設定を取り出す */
function parseConfig(text){
  let url = '', key = '';
  const m = String(text).match(/[#&]gas=([^&]+)/);   // アプリURL＋#gas=... 形式
  if(m){
    try{ const o = JSON.parse(decodeURIComponent(m[1])); if(o && o.url){ url = o.url; key = o.key || ''; } }catch(e){}
  }
  if(!url){
    try{
      const obj = JSON.parse(text);                   // 旧JSON形式
      if(obj && (obj.t === 'kenshu-gas' || obj.url)){ url = obj.url || ''; key = obj.key || ''; }
    }catch(e){
      if(/^https?:\/\//.test(String(text).trim())) url = String(text).trim(); // 生URL
    }
  }
  return { url, key };
}

function applyScannedConfig(text){
  const { url, key } = parseConfig(text);
  if(!url){ flash('⚠️ 設定QRではありませんでした'); return; }
  $('gasUrl').value = url;
  if(key) $('gasKey').value = key;
  localStorage.setItem(KEY_GAS_URL, url);
  if(key) localStorage.setItem(KEY_GAS_KEY, key);
  $('gasStatus').textContent = '✅ QRから設定を読み込みました（URL' + (key ? '＋合言葉' : '') + '）';
  flash('✅ QRから設定を読み込みました');
}

/* 普通のカメラで設定QR（アプリURL＋#gas=...）を読んで開いた時、自動で設定を反映 */
function applyConfigFromHash(){
  if(!/[#&]gas=/.test(location.hash)) return;
  const { url, key } = parseConfig(location.hash);
  if(!url) return;
  localStorage.setItem(KEY_GAS_URL, url);
  if(key) localStorage.setItem(KEY_GAS_KEY, key);
  history.replaceState(null, '', location.pathname + location.search);  // URLから設定を消す
  if(typeof flash === 'function') flash('✅ 設定を自動で読み込みました');
}

window.renderGas = renderGas;
setupGas();
applyConfigFromHash();   // 普通のカメラで設定QRから開かれた場合に自動設定
