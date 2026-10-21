#!/usr/bin/env node
/**
 * 排障脚本：拿**真实数据**验一遍「只导当前家族」到底裁掉了谁。
 *
 *   node scripts/check-export-scope.js            # 当前谱
 *   node scripts/check-export-scope.js "<某本谱的 data 目录>"
 *
 * 为什么需要它：导出走的是内存里的 state.dataset，而「主树成员」
 * 是按族源推导出来的（父系后代 + 配偶），不是用户在界面上看到的页签数。
 * 想知道自己的库里「只导主树」到底带走了谁、漏了谁，只能拿真数据算一遍。
 *
 * ⚠️ **只读**：全程只 open + readDataset，不写、不 save。
 */
import fs from 'node:fs';
import path from 'node:path';

import { GenogramStore } from '../electron/db.js';
import { DEFAULT_DATA_DIR, bookDir } from '../electron/paths.js';
import { readLibrary, currentBook } from '../electron/library.js';
import {
  normalizeDataset, buildIndex, displayName,
} from '../src/core/model.js';
import {
  buildMainTree, detectExpandableFamilies, buildFamilyTree, scopeToTree,
} from '../src/core/family.js';

const arg = process.argv[2];
const dataDir = arg ? path.resolve(arg) : DEFAULT_DATA_DIR;

if (!fs.existsSync(dataDir)) {
  console.error(`✗ 数据目录不存在：${dataDir}`);
  process.exit(1);
}

const lib = readLibrary(dataDir);
const book = currentBook(dataDir, lib);
if (!book) {
  console.error(`✗ ${dataDir} 里没有 library.json / 没有当前谱`);
  process.exit(1);
}

const dir = bookDir(dataDir, book.id);
const store = await GenogramStore.open(dir);
const raw = store.readDataset();
store.close?.();

const ds = normalizeDataset(raw);
const idx = buildIndex(ds);
const nameOf = (id) => displayName(idx.byId.get(id));

console.log(`谱名   : ${book.name}`);
console.log(`库     : ${dir}`);
console.log(`视角人 : ${ds.viewpoint || '(未设)'} = ${nameOf(ds.viewpoint) || '(查无此人)'}`);
console.log(`全谱   : ${ds.people.length} 人 / ${ds.relationships.length} 条关系`);

/* 配偶 / 父母各是谁 —— 用来核对「该被排除的到底排没排掉」 */
const vp = ds.viewpoint;
const parents = (idx.parentsOf.get(vp) || []).map(nameOf);
const spouses = (idx.spouseOf.get(vp) || []).map(nameOf);
console.log(`视角人的父母 : ${parents.join('、') || '(无)'}`);
console.log(`视角人的配偶 : ${spouses.join('、') || '(无)'}`);

const main = buildMainTree(ds, vp);
const pages = detectExpandableFamilies(ds, main);

console.log('\n—— 顶部页签 ——');
console.log(`  [main] ${main.label.padEnd(18)} ${String(main.people.length).padStart(4)} 人  (root=${nameOf(main.rootId)})`);
for (const p of pages) {
  console.log(`  [${p.key}] ${p.label.padEnd(18)} ${String(p.size).padStart(4)} 人  (root=${nameOf(p.rootId)}${p.pending ? ', 待补父母' : ''})`);
}

/* --- 逐页模拟「只导当前家族」，看裁掉了谁 --- */
for (const target of [{ key: 'main', ...main }, ...pages.map((p) => ({
  key: p.key, label: p.label, rootId: p.rootId, anchorId: p.anchorId,
  ...buildFamilyTree(ds, { rootId: p.rootId, anchorId: p.anchorId, key: p.key, label: p.label }),
}))]) {
  const sub = scopeToTree(ds, target);
  const kept = new Set(sub.people.map((p) => p.id));
  const dropped = ds.people.filter((p) => !kept.has(p.id));

  console.log(`\n—— 只导「${target.label}」 ——`);
  console.log(`  留下 ${sub.people.length} 人 / ${sub.relationships.length} 条关系（视角人 ${nameOf(sub.viewpoint) || '(空)'}）`);
  console.log(`  排除 ${dropped.length} 人：${dropped.length ? dropped.map((p) => displayName(p)).join('、') : '(无)'}`);

  /* 悬空引用自查：关系两端必须都在文件里 */
  const ids = new Set(sub.people.map((p) => p.id));
  const bad = sub.relationships.filter((r) => !ids.has(r.a) || !ids.has(r.b));
  console.log(`  悬空关系 ${bad.length} 条${bad.length ? ' ← 有问题！' : '（干净）'}`);

  /* 关键校验：配偶本人的父母、外祖父母，必须出现在「被排除」名单里 */
  const mustDrop = [];
  for (const s of (idx.spouseOf.get(vp) || [])) {
    for (const p of (idx.parentsOf.get(s) || [])) mustDrop.push({ who: nameOf(p), why: '配偶的父母' });
  }
  const mo = (idx.parentsOf.get(vp) || []).find((x) => idx.byId.get(x)?.sex === 'F');
  if (mo) {
    for (const p of (idx.parentsOf.get(mo) || [])) mustDrop.push({ who: nameOf(p), why: '母亲的父母' });
  }
  if (mustDrop.length) {
    for (const m of mustDrop) {
      const okDrop = !kept.has(idx.byId.size && ds.people.find((x) => displayName(x) === m.who)?.id);
      console.log(`  ${okDrop ? '✓' : '✗'} ${m.why}「${m.who}」已排除`);
    }
  }
  /* 配偶本人必须留下 */
  for (const s of (idx.spouseOf.get(vp) || [])) {
    console.log(`  ${kept.has(s) ? '✓' : '✗'} 配偶本人「${nameOf(s)}」${kept.has(s) ? '已保留' : '被排掉了 ← 不对'}`);
  }
}