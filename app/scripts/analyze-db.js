#!/usr/bin/env node
/**
 * 真实数据的只读体检台 · analyze-db.js
 * ---------------------------------------------------------
 * 与 `inspect-db.js` 的分工：
 *   inspect-db.js  只看**库文件本身**（人数、关系条数、世次分布、前 8 人）
 *   analyze-db.js  把库读进 core 层跑一遍**产品逻辑**，回答四个问题：
 *
 *     ① 数据完整不完整        —— 无姓名 / 无性别 / 无出生年 / 无父无母
 *     ② 称谓覆盖得怎么样      —— 多少人能推导、多少人「关系待确认」、缺的是哪些路径形状
 *     ③ 三棵树装得下吗        —— 有没有人录进去了却在任何一棵树里都看不见
 *     ④ 世次有没有被固化      —— 库里存的 gen 与「纯推导」是否一致（不一致 = 关系改了树不跟着变）
 *
 * ⚠️ **全程只读**：只 SELECT，不写库、不动 `数据/`。
 * ⚠️ 这个脚本**不会**改任何代码路径，也不会被 `npm test` 引用；
 *    它的价值是「拿真实 178 人谱子跑一遍，看产品逻辑的真实表现」。
 *
 * 用法：
 *   node scripts/analyze-db.js                  # 当前谱
 *   node scripts/analyze-db.js "E:\某处\x.db"    # 指定库文件
 *   node scripts/analyze-db.js --quiet          # 只出结论，不出明细
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';

import { DEFAULT_DATA_DIR, dbFile, bookDir } from '../electron/paths.js';
import { readLibrary, currentBook } from '../electron/library.js';
import { normalizeDataset, withResolvedGen, buildIndex, deriveGen } from '../src/core/model.js';
import { buildMainTree, detectExpandableFamilies, buildFamilyTree } from '../src/core/family.js';
import { layoutAllTrees } from '../src/core/layout.js';
import { deriveAllKinships } from '../src/core/kinship.js';
import { diagnose } from '../src/core/diagnose.js';

const require = createRequire(import.meta.url);

/* ---------- 定位库文件 ---------- */
function resolveDefaultDb() {
  const lib = readLibrary(DEFAULT_DATA_DIR);
  const book = currentBook(DEFAULT_DATA_DIR, lib);
  if (book) {
    const f = dbFile(bookDir(DEFAULT_DATA_DIR, book.id));
    if (fs.existsSync(f)) return { file: f, book };
  }
  return { file: dbFile(DEFAULT_DATA_DIR), book: null };   // 还没迁移的老布局
}

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const dbArg = args.find((a) => !a.startsWith('--'));
const picked = dbArg ? { file: dbArg, book: null } : resolveDefaultDb();
const file = picked.file;

if (!fs.existsSync(file)) {
  console.error(`✗ 库文件不存在：${file}`);
  process.exit(1);
}

/* ---------- 读库（只读） ---------- */
const SQL = await initSqlJs({
  locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f),
});
const db = new SQL.Database(new Uint8Array(fs.readFileSync(file)));
const rows = (sql) => {
  const st = db.prepare(sql);
  const out = [];
  try { while (st.step()) out.push(st.getAsObject()); } finally { st.free(); }
  return out;
};

const people = rows(`SELECT id, name, sex, birth, death, alive, avatar, photos, note,
                            place, gen, order_no, privacy, expand FROM people`).map((r) => ({
  id: r.id, name: r.name, sex: r.sex, birth: r.birth, death: r.death,
  alive: !!r.alive, avatar: r.avatar, photos: JSON.parse(r.photos || '[]'),
  note: r.note, place: r.place, gen: r.gen, order: r.order_no,
  privacy: r.privacy, expand: r.expand ?? null,
}));
const rels = rows(`SELECT a, b, type, from_date, to_date, source, confidence, note
                     FROM relationships`).map((r) => ({
  a: r.a, b: r.b, type: r.type, from: r.from_date, to: r.to_date,
  source: r.source, confidence: r.confidence, note: r.note,
}));
const meta = Object.fromEntries(rows('SELECT key, value FROM meta').map((m) => [m.key, m.value]));
db.close();

/* ---------- ① 数据规模与完整性 ---------- */
let ds = simplify(normalizeDataset({
  version: meta.version, viewpoint: meta.viewpoint, people, relationships: rels,
}));
const idx = buildIndex(ds);

console.log(`库文件：${file}${picked.book ? `（当前谱「${picked.book.name}」）` : ''}`);
console.log(`人数 ${ds.people.length} · 关系 ${ds.relationships.length}` +
  `（血缘 ${ds.relationships.filter((r) => r.type === 'parent').length}` +
  ` / 婚配 ${ds.relationships.filter((r) => r.type === 'spouse').length}）`);
console.log(`视角人：${ds.people.find((p) => p.id === ds.viewpoint)?.name || '(空)'}`);

const noName = ds.people.filter((p) => !p.name);
const noSex = ds.people.filter((p) => !p.sex);
const noBirth = ds.people.filter((p) => !p.birth);
const noParent = ds.people.filter((p) => !(idx.parentsOf.get(p.id) || []).length);
console.log(`\n== ① 数据完整性 ==`);
console.log(`无姓名 ${noName.length} · 无性别 ${noSex.length} · 无出生年 ${noBirth.length} · 无父无母 ${noParent.length}`);

/* ---------- ④ 世次有没有被固化 ---------- */
const derivedRaw = deriveGen({ ...ds, people: ds.people.map((p) => ({ ...p, gen: null })) });
let storedGen = 0;
let genMismatch = 0;
for (const p of ds.people) {
  if (p.gen == null) continue;
  storedGen++;
  const d = derivedRaw.get(p.id);
  if (d == null || d !== p.gen) genMismatch++;
}
console.log(`\n== ④ 世次固化检查 ==`);
console.log(`库里有显式 gen ${storedGen} 人 · 与纯推导不一致 ${genMismatch} 人`);
if (storedGen && storedGen === ds.people.length && !genMismatch) {
  console.log('  ⚠️ 全员都带显式 gen：数值目前与推导一致，但**推导已不参与** ——');
  console.log('     以后改父母关系，世次不会跟着变（只会在体检 F8.3 里报矛盾）。');
}

/* ---------- ② 称谓覆盖 ---------- */
ds = withResolvedGen(ds);
const idx2 = buildIndex(ds);
const kins = deriveAllKinships(ds, ds.viewpoint);
const all = [...kins.values()];
const unknown = all.filter((k) => !k.ok && k.kind !== 'self');
const pct = all.length ? ((all.length - unknown.length) / all.length) * 100 : 0;
console.log(`\n== ② 称谓覆盖 ==`);
console.log(`可推导 ${all.length - unknown.length} / ${all.length}（${pct.toFixed(1)}%）· 未覆盖 ${unknown.length}`);

const byPath = new Map();
for (const k of unknown) {
  const key = k.symbols?.length ? k.symbols.join(' ') : '(无路径)';
  if (!byPath.has(key)) byPath.set(key, []);
  byPath.get(key).push(k);
}
if (byPath.size && !quiet) {
  console.log(`未覆盖路径形状（${byPath.size} 种）:`);
  for (const [p, arr] of [...byPath].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(arr.length).padStart(3)} 人  ${p}   例：${arr[0].desc || arr[0].reason || ''}`);
  }
}

/* ---------- ③ 三棵树装得下吗 ---------- */
const mainTree = buildMainTree(ds, ds.viewpoint);
const expandable = detectExpandableFamilies(ds, mainTree);
const layouts = layoutAllTrees(ds, mainTree, expandable, buildFamilyTree);
const seen = new Set();
for (const v of Object.values(layouts)) for (const id of v.tree.memberIds) seen.add(id);
const invisible = ds.people.filter((p) => !seen.has(p.id));

console.log(`\n== ③ 家族树覆盖 ==`);
for (const [k, v] of Object.entries(layouts)) {
  console.log(`  ${k.padEnd(18)} ${String(v.tree.people.length).padStart(3)} 人`);
}
console.log(`三棵树合计可见 ${seen.size} / ${ds.people.length} · 看不见 ${invisible.length}`);
if (invisible.length && !quiet) {
  for (const p of invisible.slice(0, 20)) {
    const nm = (id) => idx2.byId.get(id)?.name || '(无名)';
    console.log(`  ${(p.name || '(无名)').padEnd(6)} ${p.id}` +
      `  父母[${(idx2.parentsOf.get(p.id) || []).map(nm).join(',')}]` +
      ` 配偶[${(idx2.spouseOf.get(p.id) || []).map(nm).join(',')}]`);
  }
}

/* ---------- 体检 F8 ---------- */
const rep = diagnose(ds, { viewpoint: ds.viewpoint });
console.log(`\n== 体检 F8：共 ${rep.issueCount} 条 ==`);
for (const g of rep.groups) {
  if (!g.items.length) continue;
  console.log(`  ${g.code} ${g.title}：${g.items.length}`);
  if (!quiet) {
    for (const it of g.items.slice(0, 3)) console.log('     - ' + it.text);
    if (g.items.length > 3) console.log(`     ……另 ${g.items.length - 3} 条`);
  }
}

/** 把内部字段（_genRaw 等）剔掉，让本脚本看到的就是「落盘形态」 */
function simplify(d) {
  return {
    version: d.version,
    viewpoint: d.viewpoint,
    people: d.people.map((p) => {
      const o = { ...p };
      delete o._genRaw;
      return o;
    }),
    relationships: d.relationships,
    _orphans: d._orphans,
  };
}
