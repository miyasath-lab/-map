/* Google Drive 連携（匿名化済みデータのバックアップ/復元） */
'use strict';

const DRIVE_FILE = 'kenshu_backup.json';
const KEY_GID    = 'kenshu_gid';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

let _tokenClient = null;
let _accessToken = null;

const getClientId = () => (localStorage.getItem(KEY_GID) || '').trim();

/* 現在の全データ（匿名化済み）のスナップショット */
function snapshot(){
  return {
    app: 'kenshu', version: 1,
    cases: load(KEY_CASE, []),
    procs: load(KEY_PROC, []),
    idmap: load(KEY_MAP, {}),   // 中身はハッシュ->コードのみ（生IDなし）
    seq:   load(KEY_SEQ, 0),
    savedAt: new Date().toISOString()
  };
}

/* スナップショットをこの端末に反映（上書き） */
function applySnapshot(d){
  if(!d || d.app !== 'kenshu') throw new Error('バックアップ形式が違います');
  save(KEY_CASE, Array.isArray(d.cases) ? d.cases : []);
  save(KEY_PROC, Array.isArray(d.procs) ? d.procs : []);
  save(KEY_MAP, d.idmap && typeof d.idmap === 'object' ? d.idmap : {});
  save(KEY_SEQ, Number(d.seq) || 0);
  refreshDatalists(); renderCaseList(); renderProcList();
}

/* ---------- OAuthトークン取得（Google Identity Services） ---------- */
function getToken(){
  return new Promise((resolve, reject) => {
    const cid = getClientId();
    if(!cid) return reject(new Error('先にクライアントIDを保存してください'));
    if(typeof google === 'undefined' || !google.accounts){
      return reject(new Error('Googleライブラリ未読み込み（通信環境を確認）'));
    }
    if(!_tokenClient || _tokenClient._cid !== cid){
      _tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cid, scope: DRIVE_SCOPE, callback: () => {}
      });
      _tokenClient._cid = cid;
    }
    _tokenClient.callback = (resp) => {
      if(resp && resp.error) return reject(new Error('認証エラー：' + resp.error));
      _accessToken = resp.access_token;
      resolve(_accessToken);
    };
    _tokenClient.requestAccessToken({ prompt: _accessToken ? '' : 'consent' });
  });
}

/* ---------- Drive REST ---------- */
async function findBackupFile(token){
  const q = encodeURIComponent(`name='${DRIVE_FILE}' and trashed=false`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,modifiedTime)`,
    { headers: { Authorization: 'Bearer ' + token } });
  if(!r.ok) throw new Error('Drive検索失敗：' + r.status);
  const j = await r.json();
  return (j.files && j.files[0]) || null;
}

async function uploadBackup(){
  const token = await getToken();
  const payload = JSON.stringify(snapshot());
  let file = await findBackupFile(token);
  if(!file){
    const cr = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: DRIVE_FILE, mimeType: 'application/json' })
    });
    if(!cr.ok) throw new Error('ファイル作成失敗：' + cr.status);
    file = await cr.json();
  }
  const up = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=media`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: payload
  });
  if(!up.ok) throw new Error('アップロード失敗：' + up.status);
}

async function downloadBackup(){
  const token = await getToken();
  const file = await findBackupFile(token);
  if(!file) throw new Error('Drive上にバックアップが見つかりません');
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
    { headers: { Authorization: 'Bearer ' + token } });
  if(!r.ok) throw new Error('ダウンロード失敗：' + r.status);
  return r.json();
}

/* ---------- UI ---------- */
function renderSync(){
  $('gid').value = getClientId();
  $('gidStatus').textContent = getClientId() ? '✅ クライアントID設定済み' : '⚠️ 未設定（連携には設定が必要）';
}

function setupSync(){
  $('btnSaveGid').onclick = () => {
    const v = $('gid').value.trim();
    localStorage.setItem(KEY_GID, v);
    _tokenClient = null; _accessToken = null;
    renderSync();
    flash('✅ クライアントIDを保存しました');
  };

  $('btnBackup').onclick = async () => {
    const s = $('syncStatus');
    s.textContent = '☁️ バックアップ中…';
    try{
      await uploadBackup();
      s.textContent = '✅ Driveへバックアップしました（' + new Date().toLocaleString('ja-JP') + '）';
      flash('✅ バックアップ完了');
    }catch(err){ s.textContent = '⚠️ ' + err.message; }
  };

  $('btnRestore').onclick = async () => {
    if(!confirm('Driveの内容でこの端末のデータを上書きします。よろしいですか？')) return;
    const s = $('syncStatus');
    s.textContent = '⬇️ 復元中…';
    try{
      const data = await downloadBackup();
      applySnapshot(data);
      s.textContent = '✅ Driveから復元しました（症例' + (data.cases||[]).length + '件／手技' + (data.procs||[]).length + '件）';
      flash('✅ 復元完了');
    }catch(err){ s.textContent = '⚠️ ' + err.message; }
  };
}

window.renderSync = renderSync;
setupSync();
