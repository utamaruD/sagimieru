// 金融庁の無登録業者リスト（エクセル）から fsa-list.json の中身を作る部品。
// 使い方は scripts/update-fsa-list.mjs を参照。追加のパッケージを使わず、Node.js だけで動く。
import { inflateRawSync } from 'node:zlib';

// ───────── エクセル（.xlsx）の読み込み ─────────
// .xlsx は ZIP の中に XML が入ったもの。必要な分だけ読む。

/** ZIP の中のファイルを { 名前: 中身 } で返す */
export function unzip(buf) {
  const files = {};
  // 末尾の「中央ディレクトリの終わり」を探す
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP（.xlsx）として読めませんでした');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP の目次が壊れています');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compSize);
    if (method === 0) files[name] = Buffer.from(data);
    else if (method === 8) files[name] = inflateRawSync(data);
  }
  return files;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** <t> の中身をつなげる（ふりがな <rPh> は除く） */
function textOf(xml) {
  const noPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  return [...noPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');
}

function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** .xlsx のすべてのシートを、行（セルの文字列の配列）の配列にする */
export function readXlsx(buf) {
  const files = unzip(buf);
  const shared = files['xl/sharedStrings.xml']
    ? [...files['xl/sharedStrings.xml'].toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]))
    : [];
  const sheetNames = Object.keys(files)
    .filter((n) => /^xl\/worksheets\/sheet[0-9]+\.xml$/.test(n))
    .sort((a, b) => Number(/([0-9]+)\.xml$/.exec(a)[1]) - Number(/([0-9]+)\.xml$/.exec(b)[1]));

  return sheetNames.map((name) => {
    const xml = files[name].toString('utf8');
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const body = c[2] ?? '';
        const ref = /\br="([A-Z]+[0-9]+)"/.exec(attrs)?.[1];
        const type = /\bt="([a-zA-Z]+)"/.exec(attrs)?.[1];
        let value = '';
        if (type === 's') value = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1])] ?? '';
        else if (type === 'inlineStr') value = textOf(body);
        else value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        row[ref ? columnIndex(ref) : row.length] = value;
      }
      rows.push(Array.from(row, (v) => (v ?? '').trim()));
    }
    return rows;
  });
}

// ───────── 一覧の行から業者の情報を取り出す ─────────

/** extension/src/engine/normalize.ts の normalize と同じ処理（ページの本文と同じ形にそろえる） */
export function normalize(text) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s​]+/g, '')
    .replace(/(\d),(?=\d{3})/g, '$1')
    .replace(/[〜～]/g, '~');
}

/** 照合に使わない会社の種類などの言葉 */
const CORPORATE_WORDS = [
  /株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|特定非営利活動法人|\(株\)|\(有\)|\(合\)|㈱|㈲/g,
  /\b(co\.?,?\s*ltd|company\s+limited|limited|ltd|l\.?l\.?c|inc|incorporated|corporation|corp|co|pte|pty|plc|s\.?a|gmbh|llp|lp|group|holdings?)\b\.?/gi,
];

/** 業者名のうち、代表者などの部分を除いた名前 */
export function companyName(raw) {
  return raw
    .split(/\n/)[0]
    .split(/\s*(?:代表取締役|代表社員|代表理事|代表者|代表(?=\s)|(?<![a-z])(?:CEO|Director)(?![a-z]))/i)[0]
    .replace(/[（(]\s*(?:旧|元)[^）)]*[）)]/g, '')
    .trim();
}

/** 照合に使う名前（会社の種類などを除いて正規化したもの） */
export function matchName(name) {
  let s = name.normalize('NFKC');
  for (const re of CORPORATE_WORDS) s = s.replace(re, ' ');
  return normalize(s).replace(/^[-・.,、。()]+|[-・.,、。()]+$/g, '');
}

/** ドメインを取り出さない大きなサービス（業者がアカウントを持っていただけのことが多い） */
export const IGNORED_DOMAINS = [
  'go.jp', 'lg.jp', 'line.me', 'lin.ee', 'instagram.com', 'facebook.com', 'fb.com', 'x.com', 'twitter.com',
  'youtube.com', 'youtu.be', 'tiktok.com', 'threads.net', 'note.com', 'note.mu', 'ameblo.jp', 'ameba.jp',
  'google.com', 'goo.gl', 'apple.com', 't.me', 'telegram.org', 'telegram.me', 'wa.me', 'whatsapp.com',
  'discord.gg', 'discord.com', 'linktr.ee', 'lit.link', 'bit.ly', 'wixsite.com', 'jimdofree.com',
  'fc2.com', 'hatenablog.com', 'livedoor.jp', 'yahoo.co.jp', 'gmail.com', 'outlook.com', 'hotmail.com',
  'icloud.com', 'zoom.us', 'peraichi.com', 'utage-system.com', 'myasp.jp', 'medium.com', 'substack.com',
  'chatgpt.com', 'openai.com', 'gemini.google.com', 'github.io', 'notion.site',
  // 「On the Forex.com」のように、別の会社の正規のサービス名と同じ文字列が書かれていることがある
  'forex.com',
];

/**
 * 照合に使わない名前：ふつうの言葉や、正規の金融機関の名前・サービス名と紛らわしいもの。
 * これらが書かれているだけで「金融庁が警告した業者」と出ると、正規のページを誤って警告してしまう。
 * （その業者のドメインが一覧にあれば、ドメインでの照合はこれまでどおり行う）
 */
export const GENERIC_NAMES = new Set([
  'advance', 'channel', 'master', 'morning', 'number', 'project', 'success', 'vision', 'liberty', 'growing',
  'prosper', 'utopia', 'index', 'frontier', 'oriental', 'izakaya', 'kizuna', 'willbe', 'redream',
  'インデックス', 'フロンティア', 'オリエンタル', 'フロントライン', 'ニューライフ', 'ライフサイクル', 'ライフステージ',
  'トランジット', 'プラチナ会員', '約款・規定集', '投資助言業者', 'アセットリンク', 'ゴールドマイン', 'ダブルボトム',
  'ドリームシティ', 'ビジネスゲート', 'ゲートオープン', 'テクノシステム', 'マルチセレクト', 'セブンサポート', 'サポートケアー',
  'dmmサポート', 'セゾングループ', '大和ファンド', '日興ファンド', '大和サポート', '日本アジア証券', '新生キャピタル',
  '日本セントラル', '学資積立プラン', '株式ジャーナル', '株ステーション', 'ストックラボ',
]);

/** 照合に使ってよい名前か */
export function isUsableMatchName(n) {
  return n.length > 0 && !GENERIC_NAMES.has(n);
}

/**
 * 備考の「なお、上記海外FX会社には当局が警告を行った以下の業者が含まれている」から後ろは
 * 別の業者の紹介なので、その業者のドメインやサービス名として取り出さない
 */
export function ownText(text) {
  return text.normalize('NFKC').split(/なお、?上記[^。\n]*(?:以下|次)の業者|当局が警告を行った以下の業者/)[0];
}

const URL_RE = /\bhttps?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
// 「www.」から始まるもの、またはよく使われるトップレベルドメインで終わるものだけをドメインとみなす
// （.ltd は「Pte.Ltd」「Solution.Ltd」など会社名の書き方と区別できないので、https:// 付きのときだけ取り出す）
const BARE_DOMAIN_RE =
  /(?<![@a-z0-9.-])((?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|info|biz|pro|io|co|jp|asia|xyz|top|vip|cc|me|online|site|club|app|ai|tech|trade|exchange|finance|global|world|live|hk|sg|uk|au|vc|sc|vu|mu|bz|ae|tw|cn|kr|us|ca|eu|de|fr|ch|cy|my|ph|th|vn|id|in))(?![a-z0-9-])/gi;

function isIgnored(domain) {
  return IGNORED_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d));
}

/** セルの文字列からウェブサイトのドメインを取り出す（メールアドレスは除く） */
export function extractDomains(text) {
  const found = new Set();
  const s = text.normalize('NFKC');
  for (const m of s.matchAll(URL_RE)) found.add(m[1].toLowerCase());
  for (const m of s.replace(URL_RE, ' ').matchAll(BARE_DOMAIN_RE)) found.add(m[1].toLowerCase());
  return [...found]
    .map((d) => d.replace(/^www\./, '').replace(/\.$/, ''))
    .filter((d) => d.includes('.') && !isIgnored(d));
}

/** 備考などから「当該業者が提供するサービスの名称は「○○」」のような名前を取り出す */
export function extractServiceNames(text) {
  const names = [];
  for (const sentence of text.normalize('NFKC').split(/[。\n]/)) {
    if (!/(名称|名前|サービス|ブランド|商号|屋号|アプリ|サイト)/.test(sentence)) continue;
    for (const m of sentence.matchAll(/「([^」]{2,60})」/g)) names.push(m[1].trim());
  }
  return names;
}

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const filled = rows[i].filter((c) => c).length;
    const nameCol = rows[i].findIndex((c) => /商号|名称又は氏名|名称/.test(c ?? ''));
    if (nameCol >= 0 && filled >= 3) {
      const col = (re) => rows[i].findIndex((c) => re.test(c ?? ''));
      return { index: i, nameCol, listedCol: col(/掲載/) };
    }
  }
  return null;
}

/**
 * シート（行の配列）から業者の一覧を作る。
 * 見出しの行（「商号、名称又は氏名等」など）を探し、その下の行を1件ずつ読む。
 * セルが改行で分かれている場合（PDF と同じ形）や、1件が複数の行に分かれている場合もあるので、
 * 名前の列が空の行は直前の業者の続きとして扱う。
 */
export function entriesFromRows(rows, kind) {
  const header = findHeader(rows);
  if (!header) return [];
  const entries = [];
  let current = null;
  for (const row of rows.slice(header.index + 1)) {
    const cells = row.map((c) => c ?? '');
    const rawName = cells[header.nameCol]?.trim() ?? '';
    if (!rawName && !current) continue;
    // 「（注）」「※」の注意書きや、英語の見出しの行（「（Trade Name or Name, etc.）」）は業者として扱わない
    if (/^[（(※]/.test(rawName)) {
      current = null;
      continue;
    }
    if (rawName) {
      current = { name: companyName(rawName), texts: [], kind };
      if (header.listedCol >= 0 && cells[header.listedCol]) current.listedAt = cells[header.listedCol].trim();
      entries.push(current);
    }
    if (current) current.texts.push(cells.join('\n'));
  }
  return entries
    .filter((e) => e.name && e.name !== '不明' && !/^不明/.test(e.name))
    .map((e) => {
      const all = ownText(e.texts.join('\n'));
      const names = new Set([matchName(e.name), ...extractServiceNames(all).map(matchName)]);
      const entry = {
        name: e.name,
        matchNames: [...names].filter(isUsableMatchName),
        domains: extractDomains(all),
        kind: e.kind,
      };
      if (e.listedAt) entry.listedAt = e.listedAt;
      return entry;
    });
}

/** 同じ業者（名前と種類が同じ）をまとめ、名前の順に並べる */
export function mergeEntries(entries) {
  const byKey = new Map();
  for (const e of entries) {
    const key = `${e.kind}:${normalize(e.name)}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...e, matchNames: [...new Set(e.matchNames)], domains: [...new Set(e.domains)] });
    } else {
      prev.matchNames = [...new Set([...prev.matchNames, ...e.matchNames])];
      prev.domains = [...new Set([...prev.domains, ...e.domains])];
    }
  }
  return [...byKey.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'ja'));
}

/** 金融庁のページの HTML から、エクセルへのリンクを取り出す */
export function findXlsxLinks(html, baseUrl) {
  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]+\.xlsx)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = new URL(m[1], baseUrl).href;
    if (!links.some((l) => l.url === url)) links.push({ url, label: m[2].replace(/<[^>]+>/g, '').trim() });
  }
  return links;
}
