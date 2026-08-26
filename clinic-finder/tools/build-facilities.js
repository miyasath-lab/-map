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
  const opt = { out: null, encoding: 'utf-8', source: '', updated: null, onlyNanbu: false, merge: false, input: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') opt.out = argv[++i];
    else if (a === '-e' || a === '--encoding') opt.encoding = argv[++i];
    else if (a === '--source') opt.source = argv[++i];
    else if (a === '--updated') opt.updated = argv[++i];
    else if (a === '--only-nanbu') opt.onlyNanbu = true;
    else if (a === '--merge') opt.merge = true;
    else if (a === '-h' || a === '--help') opt.help = true;
    else if (!opt.input) opt.input = a;
  }
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
    '  node tools/build-facilities.js 入力.csv [オプション]',
    '',
    '  -o, --out <path>       出力先（既定: data/facilities.json）',
    '  -e, --encoding <enc>   入力の文字コード utf-8 | sjis（既定: utf-8）',
    '      --source <text>    出典の表記（meta.source に入る）',
    '      --updated <date>   更新日（既定: 実行日）',
    '      --only-nanbu       那覇市・南部地区以外の行を捨てる',
    '      --merge            既存の出力に追記し、名称＋住所が同じものは上書き'
  ].join('\n'));
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || !opt.input) {
    usage();
    process.exit(opt.help ? 0 : 1);
  }

  const root = path.resolve(__dirname, '..');
  const outPath = path.resolve(opt.out || path.join(root, 'data', 'facilities.json'));
  const text = decode(fs.readFileSync(path.resolve(opt.input)), opt.encoding);
  const { facilities, warnings } = CsvMap.rowsToFacilities(CsvMap.parseCSV(text), { onlyKnownRegions: opt.onlyNanbu });

  warnings.forEach(w => console.warn('[warn]', w));
  if (!facilities.length) {
    console.error('変換できる行がありませんでした。ヘッダ行と文字コード（--encoding sjis）を確認してください。');
    process.exit(1);
  }

  let merged = facilities;
  if (opt.merge && fs.existsSync(outPath)) {
    const prev = JSON.parse(fs.readFileSync(outPath, 'utf8')).facilities || [];
    const key = (f) => `${f.name} ${f.address}`;
    const map = new Map(prev.filter(f => !f.sample).map(f => [key(f), f]));
    facilities.forEach(f => map.set(key(f), f));
    merged = [...map.values()];
  }

  merged.sort((a, b) => (a.kana || a.name).localeCompare(b.kana || b.name, 'ja'));
  merged.forEach((f, i) => { f.id = `f-${String(i + 1).padStart(4, '0')}`; });

  const data = {
    meta: {
      version: '1.0.0',
      updated: opt.updated || new Date().toISOString().slice(0, 10),
      title: '那覇市・南部地区 医療機関検索',
      source: opt.source || path.basename(opt.input),
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
