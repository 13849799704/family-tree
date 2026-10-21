/**
 * =========================================================
 * 族谱库清单 · electron/library.js
 * ---------------------------------------------------------
 * 一本谱 = 一个目录，目录列表记在 {数据目录}/library.json 里。
 *
 * 【只管三件事】
 *   1. 清单的增删改查（到底有几本谱、当前在用哪本）
 *   2. 把**老版本遗留的** genogram.db 迁进来（不删原件）
 *   3. 给每本谱生成短 id 与唯一名字
 *
 * 【刻意不做】
 *   不碰 SQLite（那是 db.js 的事），不知道数据长什么样。
 *   这里唯一会写进谱目录的东西是目录本身 —— 内容永远由 db.js 写。
 *
 * ⚠️ 本文件不 import electron，能在纯 Node 里单测（tests/library.test.js）。
 * =========================================================
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  libraryFile, booksRoot, bookDir, trashRoot, ensureLayout, DB_NAME,
} from './paths.js';

export const LIB_VERSION = 1;
export const DEFAULT_BOOK_NAME = '我的家族';

/** 新谱 id：book- 前缀 + 时间序（36 进制压短），不用中文名做目录名 */
export function makeBookId(now = Date.now()) {
  return 'book-' + now.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

/* ========================================================= */
/* 读 / 写清单                                                 */
/* ========================================================= */

/** 一份合法的空清单 */
const emptyLib = (current = null) => ({
  version: LIB_VERSION,
  current,
  books: [],
});

/**
 * 读清单。不存在 / 损坏都返回空清单（不抛，交给 ensureLibrary 去建）。
 * @param {string} root 数据根目录
 * @returns {{version:number, current:string|null, books:object[]}}
 */
export function readLibrary(root) {
  try {
    const text = fs.readFileSync(libraryFile(root), 'utf-8');
    const lib = JSON.parse(text);
    if (!lib || !Array.isArray(lib.books)) return emptyLib();
    return {
      version: Number(lib.version) || LIB_VERSION,
      current: lib.current || null,
      books: lib.books.filter((b) => b && typeof b.id === 'string' && b.id),
    };
  } catch {
    return emptyLib();
  }
}

/** 写清单（先写 .tmp 再 rename，避免中途断电留下半个清单） */
export function writeLibrary(root, lib) {
  const file = libraryFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(lib, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  return lib;
}

/**
 * current 指向的那一本。没有就退回第一本 —— 清单里的 current 可能
 * 指向一本已经被删掉的谱（比如用户手动删了目录），这时不能让应用开天窗。
 */
export function currentBook(root, lib = readLibrary(root)) {
  return lib.books.find((b) => b.id === lib.current) || lib.books[0] || null;
}

/** 在既有名字里消歧：重名就加 (2)、(3)… */
export function uniqueName(existing, wanted, fallback = DEFAULT_BOOK_NAME) {
  const base = String(wanted || '').trim() || fallback;
  if (!existing.includes(base)) return base;
  let i = 2;
  while (existing.includes(`${base} (${i})`)) i++;
  return `${base} (${i})`;
}

/* ========================================================= */
/* 老库迁移                                                    */
/* --------------------------------------------------------- */
/* v0.2.23 及以前是「一个数据目录 = 一本谱」：root/genogram.db 直接躺在根目录。
   升级后必须是 root/books/<id>/genogram.db。

   ⚠️ 用**复制**不动原件：迁移只做一次，但凡是动到用户几十年家底的操作，
   宁可多留一份也不要省那点空间。复制成功后把原件改名为
   genogram.db.migrated-<日期>，不做删除 —— 用户哪天想回滚还能拷回来。
   ========================================================= */

export const LEGACY_SUFFIX = '.migrated';

/**
 * 迁移根节点上的老 genogram.db。
 * @returns {{migrated:boolean, book?:object, backupPath?:string, error?:string}}
 */
export function migrateLegacy(root, { now = Date.now() } = {}) {
  const legacy = path.join(root, DB_NAME);
  if (!fs.existsSync(legacy)) return { migrated: false };

  // 0 字节的老库不值得迁 —— 多半是上次写入被打断的残骸
  let size = 0;
  try { size = fs.statSync(legacy).size; } catch { /* 读不到就当不存在 */ }
  if (!size) return { migrated: false };

  const existing = readLibrary(root);
  if (existing.books.length) return { migrated: false };   // 已经迁过了，别重复

  const book = touchBook({ name: DEFAULT_BOOK_NAME, now });
  const dir = bookDir(root, book.id);
  ensureLayout(dir);

  fs.copyFileSync(legacy, path.join(dir, DB_NAME));

  writeLibrary(root, {
    version: LIB_VERSION,
    current: book.id,
    books: [book],
  });

  // 原件改名保留
  let backupPath = null;
  try {
    const stamp = stampOf(now);
    backupPath = `${legacy}${LEGACY_SUFFIX}-${stamp}`;
    // 万一同名备份已存在（同一天反复触发），加序号
    let n = 1;
    while (fs.existsSync(backupPath)) backupPath = `${legacy}${LEGACY_SUFFIX}-${stamp}-${++n}`;
    fs.renameSync(legacy, backupPath);
  } catch (e) {
    // 改名失败不影响迁移本身 —— 谱已经在那儿了，只是原件还在原地。
    // 下一次启动因为 books 已经非空，不会再迁一次。
    backupPath = null;
    console.warn('[library] 老库改名失败（不影响使用）：', e?.message || e);
  }

  return { migrated: true, book, backupPath };
}

/* ========================================================= */
/* 增删改                                                      */
/* ========================================================= */

/** 造一条新的谱记录（不动磁盘） */
export function touchBook({ name, now = Date.now(), extra = {} }) {
  return {
    id: makeBookId(now),
    name: String(name || '').trim() || DEFAULT_BOOK_NAME,
    createdAt: now,
    updatedAt: now,
    people: 0,
    ...extra,
  };
}

/**
 * 准备一本新谱：建目录、写进清单。**还没打开数据库**（那是主进程的事）。
 * @param {string} root
 * @param {string} name
 * @returns {{ok:boolean, book?:object, library?:object, error?:string}}
 */
export function createBook(root, name, { now = Date.now() } = {}) {
  const lib = readLibrary(root);
  const book = touchBook({
    name: uniqueName(lib.books.map((b) => b.name), name),
    now,
  });

  try {
    ensureLayout(bookDir(root, book.id));
  } catch (e) {
    return { ok: false, error: '建谱目录失败：' + (e?.message || e) };
  }

  lib.books.push(book);
  writeLibrary(root, lib);
  return { ok: true, book, library: lib };
}

/** 改谱名（目录不动，这就是用短 id 的好处） */
export function renameBook(root, id, name, { now = Date.now() } = {}) {
  const lib = readLibrary(root);
  const b = lib.books.find((x) => x.id === id);
  if (!b) return { ok: false, error: '这本谱不存在' };
  b.name = uniqueName(
    lib.books.filter((x) => x.id !== id).map((x) => x.name),
    name
  );
  b.updatedAt = now;
  writeLibrary(root, lib);
  return { ok: true, book: b, library: lib };
}

/**
 * 删谱。
 *
 * ⚠️ **不真的删除**：整个谱目录挪到 {root}/trash/<id>-<时间戳>，
 * 用户随时能手工捞回来。族谱是几十年家底，「删除」必须是可反悔的。
 *
 * @returns {{ok:boolean, current?:string|null, library?:object, error?:string}}
 */
export function deleteBook(root, id, { now = Date.now() } = {}) {
  const lib = readLibrary(root);
  const i = lib.books.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, error: '这本谱不存在' };
  if (lib.books.length === 1) return { ok: false, error: '至少得留一本谱' };

  const [book] = lib.books.splice(i, 1);

  // 挪进回收站
  try {
    const src = bookDir(root, id);
    if (fs.existsSync(src)) {
      const dest = path.join(trashRoot(root), `${id}-${stampOf(now)}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
    }
  } catch (e) {
    console.warn('[library] 谱目录移入回收站失败（清单已更新）：', e?.message || e);
  }

  lib.current = lib.books.some((b) => b.id === lib.current)
    ? lib.current
    : (lib.books[0]?.id ?? null);

  writeLibrary(root, lib);
  return { ok: true, current: lib.current, library: lib };
}

/** 把「当前在用哪本」写回清单 */
export function setCurrent(root, id, { now = Date.now() } = {}) {
  const lib = readLibrary(root);
  if (!lib.books.some((b) => b.id === id)) return { ok: false, error: '这本谱不在清单里' };
  lib.current = id;
  const b = lib.books.find((x) => x.id === id);
  if (b) b.updatedAt = now;
  writeLibrary(root, lib);
  return { ok: true, library: lib };
}

/** 更新某本谱的人数缓存（列表上要显示，但不必为它打开库） */
export function setPeopleCount(root, id, count) {
  const lib = readLibrary(root);
  const b = lib.books.find((x) => x.id === id);
  if (!b || b.people === count) return lib;
  b.people = count;
  writeLibrary(root, lib);
  return lib;
}

/**
 * 启动时的幂等准备：确保清单存在、至少有一本谱。
 * 顺序：① 有清单直接用；② 有老库就迁移；③ 都没有就建默认的那一本。
 *
 * @returns {{library:object, book:object, migrated:boolean, created:boolean}}
 */
export function ensureLibrary(root, { now = Date.now() } = {}) {
  let lib = readLibrary(root);
  if (lib.books.length) {
    // current 可能指向被删掉的谱，兜一下
    if (!lib.books.some((b) => b.id === lib.current)) {
      lib.current = lib.books[0].id;
      writeLibrary(root, lib);
    }
    return { library: lib, book: currentBook(root, lib), migrated: false, created: false };
  }

  const mig = migrateLegacy(root, { now });
  if (mig.migrated) {
    lib = readLibrary(root);
    return { library: lib, book: currentBook(root, lib), migrated: true, created: false };
  }

  const made = createBook(root, DEFAULT_BOOK_NAME, { now });
  if (!made.ok) throw new Error(made.error || '建默认谱失败');
  lib = made.library;
  lib.current = made.book.id;
  writeLibrary(root, lib);

  return { library: lib, book: made.book, migrated: false, created: true };
}

/* ========================================================= */
/* 小工具                                                      */
/* ========================================================= */

/** YYYYMMDD（迁移文件名 / 回收站目录名用） */
function stampOf(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
