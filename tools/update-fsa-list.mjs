// 金融庁が「無登録で営業している」として警告書を出した業者の一覧を取り込み、
// extension/rules/fsa-list.json を作り直す。月1回のルール更新のときに実行する。
//
//   node scripts/update-fsa-list.mjs [出力先]
//
// 出力先を省くと extension/rules/fsa-list.json。
// 公開サイト（utamaruD/sagimieru）でも GitHub Actions が毎月このスクリプトの写しを動かし、
// rules/fsa-list.json を作り直している（アプリは1日1回それを取りに行く。extension/src/rules/remote.ts）。
//
// 取り込むもの（どちらも金融庁のページに載っているエクセル）：
// - 無登録で金融商品取引業を行う者（国内・海外所在業者）… FX・投資など
// - 無登録で暗号資産交換業を行う者（国内・海外所在業者）
//
// 作った一覧はアプリに同梱し、照合はすべて iPhone の中で行う（閲覧中のページの情報は外に送らない）。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { entriesFromRows, findXlsxLinks, mergeEntries, readXlsx } from './fsa-list-lib.mjs';

const OUT = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL('../extension/rules/fsa-list.json', import.meta.url));

const PAGES = [
  {
    title: '金融庁「無登録で金融商品取引業を行う者の名称等について」',
    url: 'https://www.fsa.go.jp/ordinary/chuui/mutouroku.html',
    kind: 'fx',
    // 01：無登録業者、03：無登録の海外所在業者（02 は適格機関投資家等特例業務届出者なので使わない）
    pick: (links) => {
      const main = links.filter((l) => /\/mutouroku\/0[13]\.xlsx$/.test(l.url));
      return main.length ? main : links.filter((l) => !/\/02\.xlsx$/.test(l.url));
    },
  },
  {
    title: '金融庁「無登録で暗号資産交換業を行う者の名称等について」',
    url: 'https://www.fsa.go.jp/ordinary/chuui/angoushisan_mutouroku.html',
    kind: 'crypto',
    // 無登録業者の一覧だけを使う（同じページに「登録済みの暗号資産交換業者」の一覧 kasoutuka.xlsx へのリンクもあるので除く）
    pick: (links) => links.filter((l) => /angoushisan_mutouroku[^/]*\.xlsx$/.test(l.url)),
  },
];

const HEADERS = { 'User-Agent': 'sagimieru-rules-updater' };

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${url} を取得できませんでした（${res.status}）`);
  return { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') ?? '' };
}

function decodeHtml(buf, contentType) {
  const head = buf.subarray(0, 2048).toString('latin1');
  const charset = (/charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8').toLowerCase();
  return new TextDecoder(charset === 'shift_jis' || charset === 'sjis' || charset === 'x-sjis' ? 'shift_jis' : charset).decode(buf);
}

const all = [];
const sources = [];
for (const page of PAGES) {
  const { buf, type } = await fetchBuffer(page.url);
  const links = page.pick(findXlsxLinks(decodeHtml(buf, type), page.url));
  if (links.length === 0) throw new Error(`${page.url} にエクセルのリンクが見つかりませんでした。ページの作りが変わった可能性があります`);
  sources.push({ title: page.title, url: page.url });
  for (const link of links) {
    const { buf: xlsx } = await fetchBuffer(link.url);
    const entries = readXlsx(xlsx).flatMap((rows) => entriesFromRows(rows, page.kind));
    console.log(`${link.url}：${entries.length}件（${link.label || 'エクセル'}）`);
    if (entries.length === 0) throw new Error(`${link.url} から業者を読み取れませんでした。表の作りが変わった可能性があります`);
    all.push(...entries);
  }
}

const entries = mergeEntries(all);
const today = new Date();
const pad = (n) => String(n).padStart(2, '0');
const updatedAt = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

let before = 0;
try {
  before = JSON.parse(readFileSync(OUT, 'utf8')).entries.length;
} catch {}

writeFileSync(OUT, JSON.stringify({ updatedAt, sources, entries }, null, 2) + '\n');
const withDomain = entries.filter((e) => e.domains.length).length;
console.log(`\n${OUT} を更新しました：${entries.length}件（前回 ${before}件）／うちドメインあり ${withDomain}件`);
