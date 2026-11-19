// 公開サイト（utamaruD/sagimieru）の rules/latest.json を、rules/ の中身から作り直す。
// サイトの GitHub Actions が、金融庁の一覧を作り直したあとに動かす。
// 元は utamaruD/scam-guard の scripts/site-tools/make-latest.mjs（scripts/publish-rules.mjs がサイトの tools/ に写す）。
//
//   node tools/make-latest.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** アプリが読めるルールの形式（scam-guard の extension/src/rules/remote.ts の SUPPORTED_SCHEMA と合わせる） */
const SCHEMA = 1;
/** これより少ない金融庁の一覧は、作り直しに失敗したとみなして止める（アプリ側でも同じ確かめをする） */
const MIN_FSA_ENTRIES = 100;

const dir = fileURLToPath(new URL('../rules/', import.meta.url));
const readJson = (name) => JSON.parse(readFileSync(dir + name, 'utf8'));

const rules = readJson('rules.json');
const fsa = readJson('fsa-list.json');
if (!Array.isArray(fsa.entries) || fsa.entries.length < MIN_FSA_ENTRIES) {
  throw new Error(`金融庁の一覧が ${fsa.entries?.length ?? 0} 件しかありません。作り直しに失敗した可能性があります`);
}

const latest = { schema: SCHEMA, rulesVersion: rules.version, rulesUpdatedAt: rules.updatedAt, fsaUpdatedAt: fsa.updatedAt };
writeFileSync(dir + 'latest.json', JSON.stringify(latest, null, 2) + '\n');
console.log('latest.json：', latest);
