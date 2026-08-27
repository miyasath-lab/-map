#!/usr/bin/env node
/* CSV → data/facilities.json 変換ツール
 *
 *   node tools/build-facilities.js 入力.csv [オプション]
 *
 * オプション
 *   -o, --out <path>       出力先（既定: data/facilities.json）
 *   -e, --encoding <enc>   入力の文字コード utf-8 | sjis（既定: utf-8）
 *       --source <text>    出典の表記（meta.source に入る）
 *       --updated <date>   更新日（既定: 実行日）
 *       --only-nanbu       那覇市・南部地区以外の行を捨てる
 *       --merge            既存の出力ファイルに追記し、名称＋住所が同じものは上書き
 */
'use strict';

const fs = require('fs');
const path = require('path');
const CsvMap = require('../csvmap.js');

function parseArgs(argv) {
  const opt = { out: null, encoding: 'utf-8', source: '', sourceUrl: '', updated: null,
                onlyNanbu: false, merge: false, inspect: false, type: '', input: null, inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') opt.out = argv[++i];
    else if (a === '-e' || a === '--encoding') opt.encoding = argv[++i];
    else if (a === '--source') opt.source = argv[++i];
    else if (a === '--source-url') opt.sourceUrl = argv[++i];
    else if (a === '--updated') opt.updated = argv[++i];
    else if (a === '--type') opt.type = argv[++i];
    else if (a === '--only-nanbu') opt.onlyNanbu = true;
    else if (a === '--merge') opt.merge = true;
    else if (a === '--inspect') opt.inspect = true;
    else if (a === '-h' || a === '--help') opt.help = true;
    else opt.inputs.push(a);
  }
  opt.input = opt.inputs[0] || null;
  return opt;
}

/* 自治体の公開CSVはShift_JISのことが多いので切り替えられるようにする */
function decode(buf, encoding) {
  const enc = /^(sjis|shift[-_]?jis|cp932|ms932)$/i.test(encoding) ? 'shift_jis' : 'utf-8';
  return new TextDecoder(enc).decode(buf);
}

function usage() {
  console.log([
    'CSV → data/facilities.json 変換ツール',
    '',
    '  node tools/build-facilities.js 入力.csv [入力2.csv ...] [オプション]',
    '',
    '  -o, --out <path>       出力先（既定: data/facilities.json）',
    '  -e, --encoding <enc>   入力の文字コード utf-8 | sjis（既定: utf-8）',
    '      --source <text>    出典の表記（meta.source に入る）',
    '      --source-url <url> 出典ページのURL（情報タブにリンク表示）',
    '      --updated <date>   更新日（既定: 実行日）',
    '      --only-nanbu       那覇市・南部地区以外の行を捨てる',
    '      --type <正規表現>  施設種別で絞る（例: --type "病院|診療所"）',
    '      --merge            既存の出力に追記し、名称＋住所が同じものは上書き',
    '      --inspect          変換せず、列の対応づけだけを表示する',
    '',
    '例）沖縄県分の医療機関CSV（Shift_JIS）を那覇市・南部だけに絞って変換',
    '  node tools/build-facilities.js 47_okinawa.csv -e sjis --only-nanbu \\',
    '    --source "厚生労働省 医療情報ネット オープンデータ（沖縄県）"'
  ].join('\n'));
}

/* 列の対応づけを人間が確認できる形で出す（実データを初めて流すときに使う） */
function inspect(rows, label) {
  const head = CsvMap.analyzeHeader(rows[0]);
  console.log(`\n=== ${label} ===`);
  console.log(`列数: ${rows[0].length} / データ行数: ${rows.length - 1}`);
  console.log('-- 認識した列 --');
  Object.entries(head.idx).forEach(([field, col]) => {
    console.log(`  ${field.padEnd(12)} <- [${col}] ${rows[0][col]}`);
  });
  if (head.deptCols.length) {
    console.log(`  departments  <- ${head.deptCols.map(c => `[${c}] ${rows[0][c]}`).join(' , ')}`);
  }
  Object.entries(head.dayCols).forEach(([k, cols]) => {
    console.log(`  hours(${k})    <- ${cols.map(c => `[${c}] ${rows[0][c]}`).join(' , ')}`);
  });
  if (head.unmatched.length) {
    console.log('-- 未対応の列（無視されます） --');
    console.log('  ' + head.unmatched.map(u => `[${u.col}] ${u.name}`).join(' / '));
    console.log('  ※ 使いたい列があれば csvmap.js の FIELD_ALIASES に列名を足してください。');
  }
  if (rows[1]) {
    console.log('-- 1件目の変換結果 --');
    const { facilities } = CsvMap.rowsToFacilities([rows[0], rows[1]]);
    console.log(JSON.stringify(facilities[0], null, 2).split('\n').map(l => '  ' + l).join('\n'));
  }
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || !opt.input) {
    usage();
    process.exit(opt.help ? 0 : 1);
  }

  const root = path.resolve(__dirname, '..');
  const outPath = path.resolve(opt.out || path.join(root, 'data', 'facilities.json'));
  const parsed = opt.inputs.map(p => ({
    label: path.basename(p),
    rows: CsvMap.parseCSV(decode(fs.readFileSync(path.resolve(p)), opt.encoding))
  }));

  if (opt.inspect) {
    parsed.forEach(f => inspect(f.rows, f.label));
    return;
  }

  const facilities = [];
  parsed.forEach(f => {
    const res = CsvMap.rowsToFacilities(f.rows, {
      onlyKnownRegions: opt.onlyNanbu,
      typePattern: opt.type ? new RegExp(opt.type) : null
    });
    res.warnings.forEach(w => console.warn(`[warn] ${f.label}: ${w}`));
    console.log(`${f.label}: ${res.facilities.length} 件（データ行 ${res.rowsUsed || 0}）`);
    facilities.push(...res.facilities);
  });

  if (!facilities.length) {
    console.error('変換できる行がありませんでした。--inspect で列の対応づけと文字コード（--encoding sjis）を確認してください。');
    process.exit(1);
  }

  const key = (f) => f.code || `${f.name} ${f.address}`;
  let merged = [...new Map(facilities.map(f => [key(f), f])).values()];
  if (opt.merge && fs.existsSync(outPath)) {
    const prev = JSON.parse(fs.readFileSync(outPath, 'utf8')).facilities || [];
    const map = new Map(prev.filter(f => !f.sample).map(f => [key(f), f]));
    merged.forEach(f => map.set(key(f), f));
    merged = [...map.values()];
  }

  merged.sort((a, b) => (a.kana || a.name).localeCompare(b.kana || b.name, 'ja'));
  merged.forEach((f, i) => { f.id = `f-${String(i + 1).padStart(4, '0')}`; });

  const data = {
    meta: {
      version: '1.0.0',
      updated: opt.updated || new Date().toISOString().slice(0, 10),
      title: '那覇市・南部地区 医療機関検索',
      source: opt.source || opt.inputs.map(p => path.basename(p)).join(' / '),
      sourceUrl: opt.sourceUrl,
      isSample: false,
      notice: '',
      regionGroups: CsvMap.REGION_GROUPS
    },
    facilities: merged
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n');

  const byRegion = {};
  merged.forEach(f => { byRegion[f.region] = (byRegion[f.region] || 0) + 1; });
  console.log(`${merged.length} 件を書き出しました -> ${path.relative(process.cwd(), outPath)}`);
  Object.entries(byRegion).forEach(([r, n]) => console.log(`  ${r}: ${n} 件`));
  const approx = merged.filter(f => f.approxLatLng).length;
  if (approx) console.log(`  ※ ${approx} 件は緯度経度が無いため市町村中心の概算座標を使用`);
}

main();
