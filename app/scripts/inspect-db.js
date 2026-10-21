#!/usr/bin/env node
/**
 * 查一眼某个 .db 里到底有什么（不依赖 Electron，纯 Node + sql.js）。
 *
 *   node scripts/inspect-db.js                      # 默认查「当前谱」的库
 *   node scripts/inspect-db.js "E:\某处\x.db"        # 指定库文件
 *
 * 用途：
 *   - 打包后验证「数据真的落进了磁盘上的库」
 *   - 平时想确认自家数据录了多少人、关系对不对
 *   - 排查「应用打不开」时，先在这儿确认库文件本身是不是好的
 *
 * ⚠️ v0.2.24 起一个数据目录里可以有多本谱，`数据\genogram.db` 这个老路径
 *    已经不存在了 —— 不指定文件时，按 `library.json` 的 current 去找当前谱，
 *    找不到（比如还没迁移）才退回老路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';

import { DEFAULT_DATA_DIR, dbFile, bookDir } from '../electron/paths.js';
import { readLibrary, currentBook } from '../electron/library.js';

const require = createRequire(import.meta.url);

/** 当前谱的库文件 */
function resolveDefaultDb() {
  const lib = readLibrary(DEFAULT_DATA_DIR);
  const book = currentBook(DEFAULT_DATA_DIR, lib);
  if (book) {
    const f = dbFile(bookDir(DEFAULT_DATA_DIR, book.id));
    if (fs.existsSync(f)) return { file: f, book };
  }
  // 还没迁移的老布局
  return { file: dbFile(DEFAULT_DATA_DIR), book: null };
}

const picked = process.argv[2]
  ? { file: process.argv[2], book: null }
  : resolveDefaultDb();
const file = picked.file;

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(file)) {
  fail(`库文件不存在：${file}\n`
    + '（v0.2.24 起每本谱独立存放在 books\\<id>\\genogram.db；'
    + '没有 library.json 说明还没跑过新版本）');
}

const stat = fs.statSync(file);
if (stat.size === 0) fail(`库文件是 0 字节（损坏或被别的程序占用）：${file}`);

const wasmDir = path.dirname(require.resolve('sql.js'));
const SQL = await initSqlJs({ locateFile: (f) => path.join(wasmDir, f) });
const db = new SQL.Database(new Uint8Array(fs.readFileSync(file)));

function scalar(sql, params) {
  const stmt = db.prepare(sql);
  try {
    if (params) stmt.bind(params);
    return stmt.step() ? stmt.get()[0] : null;
  } finally {
    stmt.free();
  }
}

function rows(sql, params) {
  const stmt = db.prepare(sql);
  const out = [];
  try {
    if (params) stmt.bind(params);
    while (stmt.step()) out.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return out;
}

// 顺手列一下这个数据目录里一共有几本谱，方便核对「到底查的是哪一本」
const allBooks = readLibrary(DEFAULT_DATA_DIR).books;
if (allBooks.length > 1) {
  console.log(`本目录共 ${allBooks.length} 本谱：` + allBooks
    .map((b) => `${b.id === currentBook(DEFAULT_DATA_DIR)?.id ? '→' : ' '}${b.name}`).join('  '));
}

console.log(`库文件 : ${file}${picked.book ? `（当前谱「${picked.book.name}」）` : ''}`);
console.log(`体积   : ${(stat.size / 1024).toFixed(1)} KB`);
console.log(`改动于 : ${stat.mtime.toLocaleString()}`);

const tables = rows(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
).map((r) => r.name);
console.log(`表     : ${tables.join(', ') || '(空库)'}`);

if (!tables.includes('people')) {
  console.log('\n⚠️ 没有 people 表 —— 这是个空库或非本应用的库。');
  process.exit(0);
}

const people = scalar('SELECT COUNT(*) FROM people');
const rels = scalar('SELECT COUNT(*) FROM relationships');
const parent = scalar("SELECT COUNT(*) FROM relationships WHERE type='parent'");
const spouse = scalar("SELECT COUNT(*) FROM relationships WHERE type='spouse'");

console.log('');
console.log(`人数       : ${people}`);
console.log(`关系总条数 : ${rels}  （血缘 ${parent} / 婚配 ${spouse}）`);

const gens = rows(
  'SELECT gen, COUNT(*) AS n FROM people WHERE gen IS NOT NULL GROUP BY gen ORDER BY gen DESC'
);
if (gens.length) {
  console.log('世次分布   : ' + gens.map((g) => `gen${g.gen}:${g.n}人`).join('  '));
}

const meta = rows('SELECT key, value FROM meta');
if (meta.length) {
  console.log('meta       : ' + meta.map((m) => `${m.key}=${m.value}`).join('  '));
}

console.log('\n前 8 人：');
for (const p of rows('SELECT id, name, sex, gen, birth FROM people LIMIT 8')) {
  console.log(`  ${p.id.padEnd(10)} ${String(p.name).padEnd(6)} ${p.sex || '?'}  gen=${p.gen ?? '-'}  ${p.birth || ''}`);
}

db.close();
