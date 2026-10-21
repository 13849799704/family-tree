import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';

import { DEFAULT_DATA_DIR, dbFile, bookDir } from '../electron/paths.js';
import { readLibrary, currentBook } from '../electron/library.js';
import { normalizeDataset, withResolvedGen, buildIndex } from '../src/core/model.js';

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

const people = rows('SELECT id,name,sex,gen FROM people').map((r) => ({ id: r.id, name: r.name, sex: r.sex, gen: r.gen }));
const relationships = rows('SELECT a,b,type FROM relationships').map((r) => ({ a: r.a, b: r.b, type: r.type }));
const meta = {};
for (const m of rows('SELECT key,value FROM meta')) meta[m.key] = m.value;
const ds = withResolvedGen(normalizeDataset({ version: '1.0', viewpoint: meta.viewpoint, people, relationships }));
const idx = buildIndex(ds);
const name = (id) => (idx.byId.get(id) || {}).name || id;

/* 检测父子环：从每个人往上走，看能不能回到自己 */
let cycles = 0;
for (const p of ds.people) {
  const seen = new Set([p.id]);
  const queue = [...(idx.parentsOf.get(p.id) || [])];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === p.id) {
      cycles++;
      console.log('★ 成环：' + (p.name || p.id) + ' 的祖先链走回了自己');
      console.log('   祖先链：' + [...seen].map((x) => name(x)).join(' ← '));
      break;
    }
    if (seen.has(cur)) continue;
    seen.add(cur);
    queue.push(...(idx.parentsOf.get(cur) || []));
  }
}
console.log('环的数量：' + cycles);

/* 检测：既是自己的父亲 / 自己是自己的父亲 */
for (const r of relationships.filter((x) => x.type === 'parent')) {
  if (r.a === r.b) console.log('★ 自己就是自己的父亲：' + name(r.a));
  if (r.b === meta.viewpoint) console.log('★ 视角人 ' + name(r.b) + ' 被设成了 ' + name(r.a) + ' 的父亲');
}

/* 主家族划分结果 */
const fam = ds.people.length;
console.log('\n视角人：' + name(meta.viewpoint) + '  总人数：' + fam);
console.log('视角人的父母：' + (idx.parentsOf.get(meta.viewpoint) || []).map((x) => name(x)).join(',') || '(无)');
console.log('视角人的子女：' + (idx.kidsOf.get(meta.viewpoint) || []).map((x) => name(x)).join(',') || '(无)');
db.close();