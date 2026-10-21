/**
 * =========================================================
 * 族谱库清单自测 · tests/library.test.js
 * ---------------------------------------------------------
 * 直接 `node tests/library.test.js`，**不需要 Electron**。
 * 与 db.test.js 一样，library.js / paths.js 都不 import electron，
 * 所以能在纯 Node 里秒级验证清单逻辑。
 *
 * 覆盖：
 *   1. 全新安装 → 自动建出第一本谱
 *   2. 老版本升级 → 根目录那份 genogram.db 被迁进 books/<id>/（**不删原件**）
 *   3. 迁移只做一次（反复启动也不会一遍遍重复复制）
 *   4. 建 / 改名 / 删除，以及它们各自该守的边界
 *   5. 清单损坏、current 指到不存在的谱这类异常输入
 *   6. 网页版回落：`src/store.js` 在没有 Electron 桥时那套 localStorage 实现
 *      —— 多谱的功能不能只在桌面版能用，`npm run web` 调试时也得一样。
 *
 * ⚠️ 全部跑在临时沙箱 / 内存里，绝不碰用户真实的数据目录。
 * =========================================================
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ensureLibrary, readLibrary, writeLibrary, currentBook, createBook,
  renameBook, deleteBook, setCurrent, setPeopleCount, uniqueName,
  migrateLegacy, DEFAULT_BOOK_NAME,
} from '../electron/library.js';
import { ensureLayout, bookDir, DB_NAME, trashRoot, libraryFile } from '../electron/paths.js';

/* ========================================================= */
/* 极简测试框架（与 tests/db.test.js 同款）                     */
/* ========================================================= */

let passed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failures.push({ group: currentGroup, name, message: e.message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${String(e.message).split('\n')[0]}\x1b[0m`);
  }
}

/* ========================================================= */
/* 临时沙箱                                                    */
/* ========================================================= */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'genogram_libtest_'));
const cleanup = () => {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* 忽略 */ }
};
process.on('exit', cleanup);

/** 每个用例一个干净的数据根目录 */
const fresh = (name) => path.join(sandbox, name);

/** 造一份「老版本遗留」的库：根目录下直接躺着 genogram.db */
function legacyRoot(name, bytes = 4096) {
  const root = fresh(name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, DB_NAME), Buffer.alloc(bytes, 1));
  return root;
}

/* ========================================================= */
/* 1. 全新安装                                                  */
/* ========================================================= */

group('1. 全新安装：自动建出第一本谱');

await test('没有清单也没有老库时，ensureLibrary 建出「我的家族」', () => {
  const root = fresh('install-1');
  const r = ensureLibrary(root);
  assert.equal(r.created, true);
  assert.equal(r.migrated, false);
  assert.equal(r.book.name, DEFAULT_BOOK_NAME);
  assert.equal(readLibrary(root).current, r.book.id);
  // 谱目录要有它自己的 photos / backups —— 每本谱独立携带
  assert.ok(fs.existsSync(path.join(bookDir(root, r.book.id), 'photos')));
});

await test('多次调用 ensureLibrary 是幂等的（不会每次都多一本）', () => {
  const root = fresh('install-2');
  const first = ensureLibrary(root);
  const second = ensureLibrary(root);
  assert.equal(second.created, false);
  assert.equal(readLibrary(root).books.length, 1);
  assert.equal(second.book.id, first.book.id);
});

/* ========================================================= */
/* 2. 老库迁移                                                  */
/* --------------------------------------------------------- */
/* 这一节是整个多谱改造里唯一动到用户已有文件的地方，
   所以它必须经得起「反复启动」「半路失败」这两件事。 */
/* ========================================================= */

group('2. 老库迁移（v0.2.23 → v0.2.24）');

await test('根目录的老 genogram.db 被复制进 books/<id>/', () => {
  const root = legacyRoot('mig-1');
  const oldBytes = fs.readFileSync(path.join(root, DB_NAME));
  const r = ensureLibrary(root);

  assert.equal(r.migrated, true, '应走迁移分支');
  const moved = path.join(bookDir(root, r.book.id), DB_NAME);
  assert.ok(fs.existsSync(moved), '新位置要有库文件');
  assert.deepEqual(fs.readFileSync(moved), oldBytes, '内容必须逐字节相同');
});

await test('迁移不动原件：原 genogram.db 被改名保留，而不是删除', () => {
  const root = legacyRoot('mig-2');
  const raw = fs.readFileSync(path.join(root, DB_NAME));
  ensureLibrary(root);

  // 原文件名已经不存在
  assert.equal(fs.existsSync(path.join(root, DB_NAME)), false);
  // 但有一份 .migrated-* 的副本，内容一模一样
  const kept = fs.readdirSync(root).find((f) => f.startsWith(DB_NAME + '.migrated-'));
  assert.ok(kept, '应留下 .migrated-* 备份');
  assert.deepEqual(fs.readFileSync(path.join(root, kept)), raw);
});

await test('已经迁过一次就不会再迁（否则每次启动都把老备份复制一遍）', () => {
  const root = legacyRoot('mig-3');
  const first = ensureLibrary(root);
  const nAfter1 = readLibrary(root).books.length;

  // 就算有人手贱把老备份复制回根目录，也不该再产生新谱
  fs.writeFileSync(path.join(root, DB_NAME), Buffer.alloc(1024, 2));
  const second = ensureLibrary(root);

  assert.equal(second.migrated, false);
  assert.equal(readLibrary(root).books.length, nAfter1);
  assert.equal(second.book.id, first.book.id);
});

await test('0 字节的老库不迁（多半是上次写入被打断的残骸）', () => {
  const root = legacyRoot('mig-4', 0);
  const r = ensureLibrary(root);
  assert.equal(r.migrated, false);
  assert.equal(r.created, true, '退化成「全新安装」');
});

await test('没有老库也没清单时走全新安装，migrated = false', () => {
  const root = fresh('mig-5');
  assert.deepEqual(migrateLegacy(root), { migrated: false });
});

/* ========================================================= */
/* 3. 建 / 改名 / 删除                                          */
/* ========================================================= */

group('3. 谱的增删改');

await test('新建谱会生成独立目录，且写进清单', () => {
  const root = fresh('crud-1');
  ensureLibrary(root);
  const r = createBook(root, '张家庄');
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(bookDir(root, r.book.id)));
  assert.equal(readLibrary(root).books.length, 2);
});

await test('重名自动加序号，替换成内存中同一个对象不会有两条同名', () => {
  const root = fresh('crud-2');
  ensureLibrary(root);
  const a = createBook(root, '张家庄');
  const b = createBook(root, '张家庄');
  assert.equal(a.book.name, '张家庄');
  assert.equal(b.book.name, '张家庄 (2)');
  assert.notEqual(a.book.id, b.book.id);
});

await test('改谱名不动目录（这正是用短 id 做目录名的好处）', () => {
  const root = fresh('crud-3');
  ensureLibrary(root);
  const made = createBook(root, '李家');
  const dirBefore = bookDir(root, made.book.id);

  const r = renameBook(root, made.book.id, '李家2026修订');
  assert.equal(r.ok, true);
  assert.equal(r.book.name, '李家2026修订');
  assert.equal(bookDir(root, made.book.id), dirBefore);
  assert.ok(fs.existsSync(dirBefore));
});

await test('改成一个已存在的名字也会被消歧', () => {
  const root = fresh('crud-4');
  ensureLibrary(root);
  createBook(root, '甲');
  const second = createBook(root, '乙');
  const r = renameBook(root, second.book.id, '甲');
  assert.equal(r.book.name, '甲 (2)');
});

await test('删谱把目录挪进 trash\\，不是真的删除', () => {
  const root = fresh('crud-5');
  ensureLibrary(root);
  const made = createBook(root, '待删');
  fs.writeFileSync(path.join(bookDir(root, made.book.id), DB_NAME), 'x');

  const r = deleteBook(root, made.book.id);
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(bookDir(root, made.book.id)), false, '原位置应清空');
  const trashed = fs.readdirSync(trashRoot(root));
  assert.ok(trashed.some((f) => f.startsWith(made.book.id)), 'trash\\ 里应能找到它');
});

await test('删的是当前谱 → current 自动落到剩下那本', () => {
  const root = fresh('crud-6');
  ensureLibrary(root);
  const keep = currentBook(root);
  const doomed = createBook(root, '丙');
  setCurrent(root, doomed.book.id);
  assert.equal(readLibrary(root).current, doomed.book.id);

  deleteBook(root, doomed.book.id);
  assert.equal(readLibrary(root).current, keep.id);
});

await test('只剩一本谱时拒绝删除（至少得留一本，否则应用开天窗）', () => {
  const root = fresh('crud-7');
  ensureLibrary(root);
  const only = currentBook(root);
  const r = deleteBook(root, only.id);
  assert.equal(r.ok, false);
  assert.match(r.error, /至少得留一本/);
});

await test('删一本不存在的谱要报错而不是静默成功', () => {
  const root = fresh('crud-8');
  ensureLibrary(root);
  const r = deleteBook(root, 'book-nope');
  assert.equal(r.ok, false);
  assert.match(r.error, /不存在/);
});

/* ========================================================= */
/* 4. 健壮性                                                    */
/* ========================================================= */

group('4. 异常输入');

await test('清单文件损坏时退化成空清单，不抛异常', () => {
  const root = fresh('robust-1');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(libraryFile(root), '{ 这不是 JSON');
  assert.deepEqual(readLibrary(root).books, []);
  // 并且能被 ensureLibrary 修回来
  assert.equal(ensureLibrary(root).created, true);
});

await test('current 指向一本已被删掉的谱时，ensureLibrary 兜到第一本', () => {
  const root = fresh('robust-2');
  ensureLibrary(root);
  const first = currentBook(root);
  createBook(root, '第二本');
  writeLibrary(root, { version: 1, current: 'book-gone', books: readLibrary(root).books });
  assert.equal(ensureLibrary(root).book.id, first.id);
});

await test('清单里混入了缺 id 的脏记录会被过滤掉', () => {
  const root = fresh('robust-3');
  fs.mkdirSync(root, { recursive: true });
  writeLibrary(root, {
    version: 1,
    current: null,
    books: [{ id: 'book-a', name: '好的' }, { name: '没有 id' }, null],
  });
  const lib = readLibrary(root);
  assert.equal(lib.books.length, 1);
  assert.equal(lib.books[0].id, 'book-a');
});

await test('人数快照会写回清单（列表要显示人数，但不值得为它打开库）', () => {
  const root = fresh('robust-4');
  ensureLibrary(root);
  const b = currentBook(root);
  assert.equal(readLibrary(root).books[0].people, 0);
  setPeopleCount(root, b.id, 42);
  assert.equal(readLibrary(root).books[0].people, 42);
});

/* ========================================================= */
/* 5. 工具                                                      */
/* ========================================================= */

group('5. 谱名消歧');

await test('没重名就原样返回', () => {
  assert.equal(uniqueName(['甲'], '乙'), '乙');
});

await test('空名字回退到默认名', () => {
  assert.equal(uniqueName([], '   '), DEFAULT_BOOK_NAME);
});

await test('重名递增到第一个空位', () => {
  assert.equal(uniqueName(['甲', '甲 (2)'], '甲'), '甲 (3)');
});

/* ========================================================= */
/* 6. 网页版回落（src/store.js 的 localStorage 分支）            */
/* --------------------------------------------------------- */
/* ⚠️ store.js 的 bridge() 检测的是 window：Node 里没有 window，
      所以它自然走 localStorage 分支 —— 只要给它一个内存版 localStorage 即可。
      刻意**不 mock window**，测的才真的是网页版那条路径。 */
/* ========================================================= */

group('6. 网页版（localStorage）也要支持多谱');

/** 够用的 localStorage 替身 */
class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key(i) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}

globalThis.localStorage = new MemStorage();

const personA = (id, name) => ({
  version: '1.0', viewpoint: id, people: [{ id, name, sex: 'M' }], relationships: [],
});

/** 每个用例一套干净的 localStorage（store.js 里有模块级状态，所以它是新的份） */
const freshStore = async () => {
  localStorage.clear();
  // 加个随机后缀让 query 变成新模块实例，避免上一个用例的模块级 currentId 泄漏
  return import(`../src/store.js?web=${Math.random()}`);
};

await test('老的无后缀 key 会被自动迁到第一本谱名下，内容不丢', async () => {
  const S = await freshStore();
  localStorage.setItem('genogram.dataset.v1', JSON.stringify(personA('p_x', '张三')));
  const r = S.listBooks();
  assert.equal(r.books.length, 1);
  assert.equal(r.books[0].name, DEFAULT_BOOK_NAME);
  assert.equal(S.loadDataset().people[0].name, '张三');
  assert.equal(localStorage.getItem('genogram.dataset.v1'), JSON.stringify(personA('p_x', '张三')),
    '老 key 保留不动（用户退回旧版本也还能用）');
});

await test('网页版新建谱 → 切过去 → 两本谱的数据互不影响', async () => {
  const S = await freshStore();
  localStorage.setItem('genogram.dataset.v1', JSON.stringify(personA('p_a', '甲')));

  const made = await S.createBook({ name: '乙谱', seedDataset: personA('p_b', '乙') });
  assert.equal(made.ok, true);
  assert.equal(S.loadDataset().people[0]?.name, '乙', '当前已切到新谱');
  assert.equal(S.listBooks().books.length, 2);

  await S.switchBook(S.listBooks().books[0].id);
  const back = S.loadDataset();
  assert.equal(back.people[0]?.name, '甲', '切回第一本，还是原来那个人');
  assert.equal(back.people.some((p) => p.name === '乙'), false, '乙谱的人绝不能混进来');
});

await test('网页版重名也会加序号，且 current 跟着走到新谱', async () => {
  const S = await freshStore();
  await S.createBook({ name: '李家' });
  const second = await S.createBook({ name: '李家' });
  assert.equal(second.book.name, '李家 (2)');
  assert.equal(S.listBooks().current, second.book.id);
});

await test('网页版改名只动名字，不改数据', async () => {
  const S = await freshStore();
  const made = await S.createBook({ name: '原名', seedDataset: personA('p_c', '丙') });
  const r = await S.renameBook(made.book.id, '新名');
  assert.equal(r.ok, true);
  assert.equal(S.listBooks().current, made.book.id, '改名不会把人踢走');
  assert.equal(S.loadDataset().people[0]?.name, '丙');
});

await test('网页版删谱：删的是当前谱 → current 自动挪窝；删的是别的谱 → current 不动', async () => {
  const S = await freshStore();
  /* ⚠️ 数量不能写死：ensureWebLib() 会先兜出默认的「我的家族」一本
     （与桌面版 ensureLibrary 全新安装的行为一致），只能用相对数字。 */
  const before = S.listBooks().books.length;
  const keep = await S.createBook({ name: '留着', seedDataset: personA('p_k', 'K') });
  const drop = await S.createBook({ name: '删掉', seedDataset: personA('p_d', 'D') });

  // 场景 A：被删的正是当前这本
  await S.switchBook(drop.book.id);
  const r = await S.deleteBook(drop.book.id);
  assert.equal(r.ok, true);
  let lib = S.listBooks();
  assert.equal(lib.books.length, before + 1);
  assert.notEqual(lib.current, drop.book.id, 'current 不能停在一本已被删掉的谱上');
  assert.ok(lib.books.some((b) => b.id === lib.current), 'current 指向一本真实存在的谱');
  assert.equal(localStorage.getItem(`genogram.dataset.v1.${drop.book.id}`), null, '被删谱的数据已清除');

  // 场景 B：被删的不是当前这本
  await S.switchBook(keep.book.id);
  const temp = await S.createBook({ name: '临时' });
  await S.switchBook(keep.book.id);            // 再切回来，让它成为「非当前」的那本
  const r2 = await S.deleteBook(temp.book.id);
  assert.equal(r2.ok, true);
  lib = S.listBooks();
  assert.equal(lib.current, keep.book.id, '删的不是当前谱 → current 保持不动');
  assert.equal(S.loadDataset().people[0]?.name, 'K', '界面显示的仍是当前谱的内容');
});

await test('只剩一本谱时网页版同样拒绝删除', async () => {
  const S = await freshStore();
  const only = S.listBooks().books[0];      // 就是兜出来的那本默认谱
  assert.ok(only, '应已兜出第一本谱');
  const r = await S.deleteBook(only.id);
  assert.equal(r.ok, false);
  assert.match(r.error, /至少得留一本/);
});

await test('网页版的人数快照：listBooks 能数出每本谱各自有多少人', async () => {
  const S = await freshStore();
  await S.createBook({ name: 'A', seedDataset: personA('p_1', '一') });
  await S.createBook({
    name: 'B',
    seedDataset: {
      version: '1.0', viewpoint: 'p_2',
      people: [{ id: 'p_2', name: '二' }, { id: 'p_3', name: '三' }], relationships: [],
    },
  });
  const counts = S.listBooks().books.map((b) => b.people);
  assert.ok(counts.includes(1) && counts.includes(2), `实际人数快照：${JSON.stringify(counts)}`);
});

/* ========================================================= */
/* 汇总                                                        */
/* ========================================================= */

console.log(
  `\n${failures.length === 0 ? '\x1b[32m' : '\x1b[31m'}` +
  `${passed} 通过 / ${failures.length} 失败\x1b[0m\n`
);
if (failures.length) {
  for (const f of failures) console.log(`✗ [${f.group}] ${f.name}\n   ${f.message}`);
  process.exitCode = 1;
}
