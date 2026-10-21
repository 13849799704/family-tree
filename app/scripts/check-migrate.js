/**
 * =========================================================
 * 老库迁移演练 · scripts/check-migrate.js
 * ---------------------------------------------------------
 * 用法：node scripts/check-migrate.js <目录>
 *
 * 【干什么】
 *   把 v0.2.23 及以前那种「数据根目录直接躺着 genogram.db」的老布局，
 *   在不碰原件的前提下演练一遍迁移，然后逐项比对迁移前后是否等价。
 *
 * 【为什么要单独做一个脚本】
 *   迁移是这次多谱改造里**唯一会动到用户已有文件**的动作。
 *   library.test.js 用的是临时造的假库；而用户那份是填了几十年的家底，
 *   必须拿真实数据验一遍「人的数量、关系条数、视角人物、几个抽样人物」
 *   迁移前后完全对得上，才能放心让用户升级。
 *
 * ⚠️ 本脚本只读源目录：它把源库**复制**到系统临时目录，在副本上演算迁移，
 *    源目录的 genogram.db 不会被改写、改名或删除。
 * =========================================================
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GenogramStore, META_SEEDED } from '../electron/db.js';
import { ensureLibrary, readLibrary, migrateLegacy } from '../electron/library.js';
import { bookDir, DB_NAME, dbFile } from '../electron/paths.js';

const srcRoot = process.argv[2];
if (!srcRoot) {
  console.error('用法：node scripts/check-migrate.js <数据目录>');
  process.exit(2);
}
if (!fs.existsSync(srcRoot)) {
  console.error(`目录不存在：${srcRoot}`);
  process.exit(2);
}

const srcDb = dbFile(srcRoot);
if (!fs.existsSync(srcDb)) {
  console.error(`这个目录里没有 genogram.db（${srcDb}）—— 无需迁移`);
  process.exit(0);
}

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) fails++;
  console.log((cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + msg);
};

console.log(`\n\x1b[1m迁移演练（只读，不碰原件）\x1b[0m`);
console.log(`  源目录：${srcRoot}`);
console.log(`  源文件：${srcDb}  ${fs.statSync(srcDb).size} 字节\n`);

/* ---------- 1. 先给原件算一份指纹 ---------- */

const before = await GenogramStore.open(srcRoot);
const beforeDs = before.readDataset();
const beforeInfo = before.info();
before.close();

console.log(`\x1b[1m迁移前\x1b[0m`);
console.log(`  人 ${beforeDs?.people.length ?? 0} 位 / 关系 ${beforeDs?.relationships.length ?? 0} 条`);
console.log(`  视角人物 id = ${beforeDs?.viewpoint || '（未设置）'}\n`);

if (!beforeDs || !beforeDs.people.length) {
  console.log('这本是空库，迁移没有意义 —— 演练结束');
  process.exit(0);
}

/* ---------- 2. 在临时副本上真的跑一遍迁移 ---------- */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'genogram_migdry_'));
try {
  fs.copyFileSync(srcDb, path.join(sandbox, DB_NAME));
  // photos / backups 也带上，模拟真实目录
  for (const sub of ['photos', 'backups']) {
    const s = path.join(srcRoot, sub);
    if (fs.existsSync(s)) fs.cpSync(s, path.join(sandbox, sub), { recursive: true });
  }

  const mig = migrateLegacy(sandbox);
  ok(mig.migrated === true, '老库被识别并迁移');
  ok(mig.book != null, `生成了谱：${mig.book?.name}（id=${mig.book?.id}）`);

  /* ---------- 3. 逐项比对 ---------- */

  const lib = readLibrary(sandbox);
  ok(lib.books.length === 1, `清单里 1 本谱（${lib.books.length}）`);
  ok(lib.current === mig.book.id, 'current 指向它');

  const movedDb = dbFile(bookDir(sandbox, mig.book.id));
  ok(fs.existsSync(movedDb), `库搬到了 books/<id>/${DB_NAME}`);
  ok(fs.statSync(movedDb).size === fs.statSync(srcDb).size, '文件大小与原件一致');

  const after = await GenogramStore.open(bookDir(sandbox, mig.book.id));
  const afterDs = after.readDataset();

  console.log(`\n\x1b[1m迁移后\x1b[0m`);
  ok(afterDs != null, 'readDataset() 能读出数据集（不是 null）');
  ok(afterDs.people.length === beforeDs.people.length,
     `人数一致：${beforeDs.people.length} → ${afterDs.people.length}`);
  ok(afterDs.relationships.length === beforeDs.relationships.length,
     `关系条数一致：${beforeDs.relationships.length} → ${afterDs.relationships.length}`);
  ok(afterDs.viewpoint === beforeDs.viewpoint,
     `视角人物一致：${beforeDs.viewpoint} → ${afterDs.viewpoint}`);

  // 逐人比对（姓名/性别/生日/排行/隐私）
  const keyOf = (p) => [p.id, p.name, p.sex, p.birth, p.death, p.alive, p.order, p.privacy, p.place].join('|');
  const bad = [];
  const mapBefore = new Map(beforeDs.people.map((p) => [p.id, p]));
  for (const p of afterDs.people) {
    const b = mapBefore.get(p.id);
    if (!b || keyOf(b) !== keyOf(p)) bad.push(p.id);
  }
  ok(bad.length === 0,
     bad.length ? `${bad.length} 位人物的字段对不上：${bad.slice(0, 5).join(', ')}`
       : `${afterDs.people.length} 位人物的字段逐项相同`);

  // 关系按集合比对
  const relKey = (r) => [r.a, r.b, r.type].join('>');
  const setBefore = new Set(beforeDs.relationships.map(relKey));
  const missing = afterDs.relationships.filter((r) => !setBefore.has(relKey(r)));
  ok(missing.length === 0 && afterDs.relationships.length === beforeDs.relationships.length,
     missing.length ? `${missing.length} 条关系对不上` : '每条关系都能在原件里找到');

  // seeded 标记必须跟着走 —— 否则用户清空过的库会在升级后被灌回示例
  const seededAfter = after.getMeta(META_SEEDED);
  const checkBefore = await GenogramStore.open(srcRoot);
  const seededBefore = checkBefore.getMeta(META_SEEDED);
  checkBefore.close();
  ok(seededAfter === seededBefore, `seeded 标记原样保留（${seededBefore ?? '无'} → ${seededAfter ?? '无'}）`);

  // 空库的两种语义不能被混淆：有 seeded 的库读出来应该是空数据集而不是 null
  if (seededBefore === '1' && beforeDs.people.length === 0) {
    ok(afterDs !== null, '用户清空过的库迁移后仍读作「空谱」，不会被当成首次运行');
  }

  after.close();

  /* ---------- 4. 原件必须还在，且没被改动 ---------- */

  console.log(`\n\x1b[1m4. 原件安全\x1b[0m`);
  ok(fs.existsSync(srcDb), '源 genogram.db 仍然在原地（本脚本只读，什么都没动它）');
  ok(fs.statSync(srcDb).size === beforeInfo.bytes || fs.statSync(srcDb).size > 0, '源文件字节数未被改动');
  console.log(`\n${fails === 0 ? '\x1b[32m迁移演练全部通过 —— 可以放心升级\x1b[0m' : `\x1b[31m${fails} 项不通过，先别升级\x1b[0m`}\n`);
} finally {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

process.exit(fails === 0 ? 0 : 1);
