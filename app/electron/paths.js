/**
 * =========================================================
 * 数据目录解析 · paths.js
 * ---------------------------------------------------------
 * 桌面版和网页版最大的区别：数据落在**用户自己的磁盘目录**，
 * 而不是浏览器缓存里（清个缓存就没了 —— 这在族谱场景是不可接受的）。
 *
 * 解析顺序：
 *   1. 环境变量 GENOGRAM_DATA_DIR（测试 / 多库切换用）
 *   2. D:\族谱pc端项目\数据\      ← 有 D 盘就用它（用户指定，不放 C 盘）
 *   3. C:\Users\<用户名>\族谱数据\  ← 没有 D 盘时放这里（打包给别人用时的常态）
 *   4. 宿主给的 fallback（Electron 的 userData），仅当上面都不可写
 *
 * ⚠️ 本文件不 import electron，所以能在纯 Node 里单测。
 * =========================================================
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 首选数据目录（D 盘）—— 用户指定，能放 D 盘就不放 C 盘 */
export const DEFAULT_DATA_DIR = 'D:\\族谱pc端项目\\数据';

/** D 盘根：用来判断「这台机器到底有没有 D 盘」 */
export const D_DRIVE_ROOT = 'D:\\';

/** 没有 D 盘时用的文件夹名（放在用户目录下，一定可写、也一眼能找到） */
export const C_DRIVE_DIR_NAME = '族谱数据';

/** 数据文件与子目录名 */
export const DB_NAME = 'genogram.db';

export const dbFile = (dir) => path.join(dir, DB_NAME);
export const tmpFile = (dir) => path.join(dir, DB_NAME + '.tmp');
export const bakFile = (dir) => path.join(dir, DB_NAME + '.bak');
export const photosDir = (dir) => path.join(dir, 'photos');
export const backupsDir = (dir) => path.join(dir, 'backups');

/* ---------------------------------------------------------- */
/* 族谱库（多本谱）                                            */
/* --------------------------------------------------------- */
/* 一本谱 = 一个目录，目录里放它自己的 genogram.db / photos / backups。
   这样 photos、备份快照、ensureLayout 全都是「per-book」的，逻辑一行都不用改；
   而且一本谱可以直接整个文件夹拷给亲戚。

   目录名用**短 id**（book-xxxx），不用中文名 —— 重命名谱时不必动磁盘上的目录，
   也避开跨系统的文件名编码 / 长度坑。真正的谱名存在 library.json 里。 */

/** 清单文件名 */
export const LIB_NAME = 'library.json';
/** 谱容器目录名 */
export const BOOKS_DIR = 'books';
/** 「删除」时挪进去的回收站目录名（不真的删，数据几十年的家底） */
export const TRASH_DIR = 'trash';

export const libraryFile = (root) => path.join(root, LIB_NAME);
export const booksRoot = (root) => path.join(root, BOOKS_DIR);
export const bookDir = (root, id) => path.join(booksRoot(root), id);
export const trashRoot = (root) => path.join(root, TRASH_DIR);

/**
 * 候选数据目录（按优先级）。
 *
 * 有 D 盘就用 D 盘，没有就退到 C 盘用户目录 —— 这是打包后给别人用时的常态：
 * 别人的机器不一定有 D 盘，硬绑 D 盘的结果就是「装得上、打不开」。
 * 兜底放在 `C:\Users\<用户名>\族谱数据`，不用管理员权限、
 * 不用猜 `%APPDATA%` 藏在哪，资源管理器里点两下就能进去备份。
 *
 * @param {{env?:object, fallback?:string, home?:string|null, hasD?:boolean}} opts
 * @returns {string[]} 绝对路径，已去重、已剔除不存在的候选
 */
export function dataDirCandidates({ env = process.env, fallback, home, hasD } = {}) {
  const dOk = hasD ?? fs.existsSync(D_DRIVE_ROOT);
  const homeDir = home ?? os.homedir();
  const raw = [
    env.GENOGRAM_DATA_DIR,          // 1. 显式指定（测试 / 多库切换）
    dOk ? DEFAULT_DATA_DIR : null,  // 2. 有 D 盘就用它
    homeDir ? path.join(homeDir, C_DRIVE_DIR_NAME) : null,  // 3. C 盘用户目录
    fallback,                       // 4. Electron 给的 userData，兜底
  ];
  const out = [];
  for (const c of raw.filter(Boolean).map((c) => path.resolve(c))) {
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * 解析（并在需要时创建）数据目录：逐个候选试 mkdir + 可写测试。
 * @param {{env?:object, fallback?:string, home?:string|null, hasD?:boolean}} opts
 * @returns {string} 绝对路径
 */
export function resolveDataDir(opts = {}) {
  const candidates = dataDirCandidates(opts);

  const tried = [];
  for (const dir of candidates) {
    tried.push(dir);
    try {
      fs.mkdirSync(dir, { recursive: true });
      // mkdir 成功 ≠ 可写（只读盘 / 权限），实测一下
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (e) {
      lastError = e;
    }
  }
  const detail = tried.map((d) => `  · ${d}`).join('\n');
  throw new Error(
    `找不到可写的数据目录，已尝试：\n${detail}\n最后错误：${lastError?.message || '未知'}`
  );
}

let lastError = null;

/** 确保数据目录下的子目录都存在 */
export function ensureLayout(dir) {
  for (const d of [dir, photosDir(dir), backupsDir(dir)]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return dir;
}

/**
 * 备份策略（打开库时执行一次）：
 *   1. 上一份库 → `genogram.db.bak`（等于「上次退出时的状态」）
 *   2. 每天一份快照 → `backups/genogram-YYYYMMDD.db`（同一天只做一份）
 *   3. 快照超过 30 份 → 删最旧的
 * 族谱数据是用户几十年的家底，备份不值得省。
 */
export function backupOnOpen(dir) {
  const src = dbFile(dir);
  if (!fs.existsSync(src)) return { made: [] };

  const made = [];

  // 1) 上一版
  try {
    fs.copyFileSync(src, bakFile(dir));
    made.push(path.basename(bakFile(dir)));
  } catch { /* 备份失败不该阻止打开 */ }

  // 2) 当天快照
  try {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const name = `genogram-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.db`;
    const dest = path.join(backupsDir(dir), name);
    fs.mkdirSync(backupsDir(dir), { recursive: true });
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
      made.push('backups/' + name);
    }
  } catch { /* 同上 */ }

  // 3) 清理：只留最近 30 份快照
  try {
    const bdir = backupsDir(dir);
    const files = fs
      .readdirSync(bdir)
      .filter((f) => /^genogram-\d{8}\.db$/.test(f))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - 30))) {
      fs.unlinkSync(path.join(bdir, f));
    }
  } catch { /* 同上 */ }

  return { made };
}
