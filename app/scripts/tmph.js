import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';

import { DEFAULT_DATA_DIR, dbFile, bookDir } from '../electron/paths.js';
import { readLibrary, currentBook } from '../electron/library.js';

const require = createRequire(import.meta.url);
const lib = readLibrary(DEFAULT_DATA_DIR);
const book = currentBook(DEFAULT_DATA_DIR, lib);
const file = dbFile(bookDir(DEFAULT_DATA_DIR, book.id));
const wasmDir = path.dirname(require.resolve('sql.js'));
const SQL = await initSqlJs({ locateFile: (f) => path.join(wasmDir, f) });
const db = new SQL.Database(new Uint8Array(fs.readFileSync(file)));

function rows(sql) {
  const st = db.prepare(sql);
  const out = [];
  while (st.step()) out.push(st.getAsObject());
  st.free();
  return out;
}

const names = new Set();
for (const r of rows('SELECT name FROM people')) {
  const n = (r.name || '').trim();
  if (n.length >= 2) names.add(n);
}
console.log('数据里的真实姓名：' + names.size + ' 个');

const readme = fs.readFileSync(path.resolve('README.md'), 'utf8');
const lines = readme.split(/\r?\n/);
const start = lines.findIndex((l) => l.includes('九、更新日志'));
if (start < 0) { console.log('没找到更新日志章节'); db.close(); process.exit(0); }
/* 更新日志是最后一章，但万一以后加了新章节，这里按「下一个 ## 标题」截断 */
let end = lines.length;
for (let i = start + 2; i < lines.length; i++) {
  if (/^##\s/.test(lines[i])) { end = i; break; }
}
console.log('更新日志章节：第 ' + (start + 1) + ' 行 ~ 第 ' + end + ' 行\n');

const hits = [];
for (let i = start; i < end; i++) {
  for (const n of names) {
    if (lines[i].includes(n)) {
      hits.push({ line: i + 1, name: n, text: lines[i].trim().slice(0, 110) });
      break;   // 一行只报一次
    }
  }
}
console.log('★ 更新日志里残留的真实姓名：' + hits.length + ' 处');
for (const h of hits) console.log('  L' + h.line + '  [' + h.name + ']  ' + h.text);

/* 顺带把内部 id 也扫一遍（p_xxx 形式） */
const idHits = [];
for (let i = start; i < end; i++) {
  const m = lines[i].match(/\bp_[0-9a-z]{5,}\b/g);
  if (m) idHits.push('  L' + (i + 1) + '  ' + m.join(', ') + '   ' + lines[i].trim().slice(0, 90));
}
console.log('\n★ 更新日志里残留的内部 id：' + idHits.length + ' 处');
idHits.forEach((x) => console.log(x));
db.close();
