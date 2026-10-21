/**
 * =========================================================
 * SQLite 存储 · electron/db.js
 * ---------------------------------------------------------
 * v1 的存储是「整个数据集序列化成一个 JSON 字符串」。
 * 桌面版要的是**本地数据库**，所以这里把它落成真正的 SQLite 库：
 *
 *   people         一人一行（14 列）
 *   relationships  一条关系一行（parent / spouse 一张表）
 *   meta           版本、视角人、保存时间
 *
 * 【设计取舍：为什么 IPC 上仍然传 JSON】
 *   渲染层（src/）只认 `read()` / `write(json)` 这一对函数，
 *   它**不需要知道背后是 SQLite 还是 localStorage**。
 *   所以 SQL 完全留在主进程：换驱动不动 UI，也避免把 SQL 拼串
 *   的能力暴露给渲染层（注入风险）。
 *   换来的是 .db 文件本身是**标准 SQLite 库** —— 任何 SQLite 工具都能直接查。
 *
 * 【为什么用 sql.js（WASM）而不是 better-sqlite3】
 *   better-sqlite3 是原生模块，要针对 Electron 的 ABI 重编译，
 *   Windows 上没有 VS Build Tools 就会卡住。
 *   sql.js 是 SQLite 编译成 WASM，**零编译**，代价是整库常驻内存
 *   —— 对族谱这种量级（几百人 / 几 MB）完全无感。
 *
 * 【持久化】
 *   sql.js 的库活在内存里，`db.export()` 出来是完整文件字节。
 *   写入走「写 .tmp → rename 覆盖」，同卷 rename 是原子的，
 *   断电 / 崩溃最多丢掉最后一次保存，**不会写出半个损坏的库**。
 *
 * ⚠️ 本文件不 import electron，所以能在纯 Node 里单测（见 tests/db.test.js）。
 * =========================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';

import { dbFile, tmpFile } from './paths.js';

const require = createRequire(import.meta.url);

export const SCHEMA_VERSION = 1;

/**
 * meta 表的「已播种」标记。
 *
 * 【为什么需要它】
 *   空库有两种截然不同的含义，混淆会出事：
 *     A. 全新库，从未写入过      → 应该载入示例家族（首次运行的友好体验）
 *     B. 用户主动清空了数据      → 应该**保持为空**，等他录自己的人
 *   只靠「people 表是不是空的」区分不了这两者 —— 以前就是这么判断的，
 *   结果是：用户清空 → 重启 → 示例家族又灌回来了，等于清空按钮失灵。
 *   所以写过的库一律打上这个标记，之后空着就是真的空着。
 */
export const META_SEEDED = 'seeded';

/**
 * 表结构。
 * 注意几个字段名的坑：
 *   - `order` / `from` / `to` / `group` 都是 SQL 关键字，列名加后缀避开（order_no / from_date / to_date）
 *   - 布尔存 0/1（SQLite 没有原生布尔）
 *   - photos 暂存 JSON 文本；v2 若照片变多，再拆 photos 表 + 文件存磁盘
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id       TEXT PRIMARY KEY,
  name     TEXT    NOT NULL DEFAULT '',
  sex      TEXT    NOT NULL DEFAULT '',
  birth    TEXT    NOT NULL DEFAULT '',
  death    TEXT    NOT NULL DEFAULT '',
  alive    INTEGER NOT NULL DEFAULT 1,
  avatar   TEXT    NOT NULL DEFAULT '',
  photos   TEXT    NOT NULL DEFAULT '[]',
  note     TEXT    NOT NULL DEFAULT '',
  place    TEXT    NOT NULL DEFAULT '',
  gen      INTEGER,
  order_no INTEGER,
  privacy  TEXT    NOT NULL DEFAULT 'family',
  expand   TEXT
);

CREATE TABLE IF NOT EXISTS relationships (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  a          TEXT NOT NULL,
  b          TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('parent','spouse')),
  from_date  TEXT NOT NULL DEFAULT '',
  to_date    TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'high',
  note       TEXT NOT NULL DEFAULT '',
  UNIQUE (a, b, type)
);

-- 查询索引：按父母找子女、按子女找父母、按配偶找
CREATE INDEX IF NOT EXISTS idx_rel_a      ON relationships (a, type);
CREATE INDEX IF NOT EXISTS idx_rel_b      ON relationships (b, type);
CREATE INDEX IF NOT EXISTS idx_people_name ON people (name);
`;

/* ========================================================= */
/* 初始化                                                      */
/* ========================================================= */

let SQL = null;

/** 初始化 sql.js 运行时（WASM 只加载一次，进程内复用） */
export async function initSql() {
  if (SQL) return SQL;
  SQL = await initSqlJs({
    // 必须显式告诉它在哪找 .wasm，否则打包后（asar）会找不到
    locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f),
  });
  return SQL;
}

/* ========================================================= */
/* Store                                                       */
/* ========================================================= */

export class GenogramStore {
  /**
   * @param {import('sql.js').Database} db
   * @param {string} filePath .db 的绝对路径
   */
  constructor(db, filePath) {
    this.db = db;
    this.file = filePath;
    /** @type {number|null} 上次落盘时间 */
    this.savedAt = null;
    this.bytes = 0;
    this._openExisting = fs.existsSync(filePath);
  }

  /**
   * 打开（或新建）数据库。
   * @param {string} dir 数据目录
   * @returns {Promise<GenogramStore>}
   */
  static async open(dir) {
    const sql = await initSql();
    const file = dbFile(dir);

    let db;
    if (fs.existsSync(file)) {
      const buf = fs.readFileSync(file);
      // 0 字节 / 半截文件：不要硬塞给 SQLite，会抛得莫名其妙
      if (buf.length === 0) {
        throw new Error(`数据库文件是空的：${file}\n（应该是上次写入被打断，删掉它或从 backups/ 恢复）`);
      }
      db = new sql.Database(new Uint8Array(buf));
    } else {
      db = new sql.Database();
    }

    const store = new GenogramStore(db, file);
    db.run(SCHEMA);

    // schema 版本，留给以后迁移用
    const v = store.getMeta('schema_version');
    if (v == null) store.setMeta('schema_version', String(SCHEMA_VERSION));

    if (store._openExisting) {
      store.bytes = fs.statSync(file).size;
      store.savedAt = fs.statSync(file).mtimeMs;
    } else {
      // 新建：立刻落一个空库，让用户马上就能看到自己的数据文件
      store.persist();
    }
    return store;
  }

  /* ---------- meta ---------- */

  getMeta(key) {
    const stmt = this.db.prepare('SELECT value FROM meta WHERE key = ?');
    try {
      stmt.bind([key]);
      return stmt.step() ? stmt.getAsObject().value : null;
    } finally {
      stmt.free();
    }
  }

  setMeta(key, value) {
    this.db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, String(value)]);
  }

  /* ---------- 读：表 → 数据集 ---------- */

  /**
   * 读出与 `model.js#serialize()` **同构**的数据集对象。
   * 渲染层不需要知道它是从表里拼出来的。
   * @returns {{version:string, viewpoint:string, people:object[], relationships:object[]}|null}
   */
  readDataset() {
    const people = this.selectAll(
      `SELECT id, name, sex, birth, death, alive, avatar, photos, note, place,
              gen, order_no, privacy, expand
         FROM people
        ORDER BY id`
    ).map((r) => ({
      id: r.id,
      name: r.name,
      sex: r.sex,
      birth: r.birth,
      death: r.death,
      alive: !!r.alive,
      avatar: r.avatar,
      photos: safeJsonArray(r.photos),
      note: r.note,
      place: r.place,
      gen: r.gen,
      order: r.order_no,      // ← 列名 order_no 映射回对象的 order
      privacy: r.privacy,
      expand: r.expand ?? null,
    }));

    const relationships = this.selectAll(
      `SELECT a, b, type, from_date, to_date, source, confidence, note
         FROM relationships
        ORDER BY id`
    ).map((r) => ({
      a: r.a,
      b: r.b,
      type: r.type,
      from: r.from_date,
      to: r.to_date,
      source: r.source,
      confidence: r.confidence,
      note: r.note,
    }));

    /* 空表有两种可能，靠 seeded 标记区分（见 META_SEEDED 的说明）：
         seeded = 1 → 用户主动清空过，返回**空数据集**（不再是 null）
         seeded 无   → 全新库，返回 null，让上层走「首次运行 → 载入示例」分支 */
    if (!people.length) {
      if (this.getMeta(META_SEEDED) === '1') {
        return {
          version: this.getMeta('version') || '1.0',
          viewpoint: this.getMeta('viewpoint') || '',
          people: [],
          relationships: [],
        };
      }
      return null;
    }

    return {
      version: this.getMeta('version') || '1.0',
      viewpoint: this.getMeta('viewpoint') || '',
      people,
      relationships,
    };
  }

  /* ---------- 写：数据集 → 表 ---------- */

  /**
   * 整份数据集写回表里。
   * 一个事务内「清空 + 重建」：族谱量级下比逐行 diff 简单得多，而且天然一致
   * —— 不会出现「人删了、关系还在」这种半截状态。
   * @returns {{ok:boolean, error?:string}}
   */
  writeDataset(ds) {
    if (!ds || !Array.isArray(ds.people)) {
      return { ok: false, error: '数据集格式不对：缺少 people 数组' };
    }

    this.db.run('BEGIN');
    try {
      this.db.run('DELETE FROM people');
      this.db.run('DELETE FROM relationships');
      this.db.run('DELETE FROM meta');

      const insP = this.db.prepare(
        `INSERT INTO people
           (id, name, sex, birth, death, alive, avatar, photos, note, place,
            gen, order_no, privacy, expand)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      try {
        for (const p of ds.people) {
          insP.run([
            s(p.id),
            s(p.name),
            s(p.sex),
            s(p.birth),
            s(p.death),
            p.alive === false ? 0 : 1,
            s(p.avatar),
            JSON.stringify(Array.isArray(p.photos) ? p.photos : []),
            s(p.note),
            s(p.place),
            n(p.gen),
            n(p.order),
            s(p.privacy) || 'family',
            p.expand == null ? null : s(p.expand),
          ]);
        }
      } finally {
        insP.free();
      }

      const insR = this.db.prepare(
        `INSERT OR IGNORE INTO relationships
           (a, b, type, from_date, to_date, source, confidence, note)
         VALUES (?,?,?,?,?,?,?,?)`
      );
      try {
        for (const r of ds.relationships || []) {
          if (!r?.a || !r?.b || r.a === r.b) continue;
          insR.run([
            s(r.a),
            s(r.b),
            r.type === 'spouse' ? 'spouse' : 'parent',
            s(r.from),
            s(r.to),
            s(r.source),
            s(r.confidence) || 'high',
            s(r.note),
          ]);
        }
      } finally {
        insR.free();
      }

      this.setMeta('version', s(ds.version) || '1.0');
      this.setMeta('viewpoint', s(ds.viewpoint));
      this.setMeta('schema_version', String(SCHEMA_VERSION));
      this.setMeta('saved_at', String(Date.now()));
      // 只要写过一次，这个库就是「已播种」的：
      // 之后即便被清空，也保持为空，不再回落示例数据（见 META_SEEDED）
      this.setMeta(META_SEEDED, '1');

      this.db.run('COMMIT');
    } catch (e) {
      try { this.db.run('ROLLBACK'); } catch { /* 尽力而为 */ }
      return { ok: false, error: '写库失败：' + (e?.message || e) };
    }

    try {
      this.persist();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: '落盘失败：' + (e?.message || e) };
    }
  }

  /** 清空全部数据（危险操作，调用方必须二次确认） */
  clearAll() {
    return this.writeDataset({ version: '1.0', viewpoint: '', people: [], relationships: [] });
  }

  /* ---------- 落盘 ---------- */

  /**
   * 内存库 → 磁盘文件。
   * 先写 .tmp 再 rename：同卷 rename 是原子的，不会留下半个损坏的库。
   */
  persist() {
    const bytes = this.db.export();
    const tmp = tmpFile(path.dirname(this.file));
    fs.writeFileSync(tmp, Buffer.from(bytes));
    fs.renameSync(tmp, this.file);   // 原子替换
    this.bytes = bytes.length;
    this.savedAt = Date.now();
    return this.bytes;
  }

  /* ---------- 查询（给体检 / 搜索等只读场景用） ---------- */

  /**
   * 通用查询。**只读用途**，不要拿它改数据（改数据走 writeDataset，才有事务保证）。
   * @returns {object[]}
   */
  selectAll(sql, params = []) {
    const stmt = this.db.prepare(sql);
    const rows = [];
    try {
      stmt.bind(params);
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }

  /* ---------- 信息 ---------- */

  info() {
    const count = (t) => {
      const stmt = this.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`);
      try { return stmt.step() ? stmt.getAsObject().c : 0; } finally { stmt.free(); }
    };
    return {
      kind: 'sqlite',
      path: this.file,
      people: count('people'),
      relationships: count('relationships'),
      bytes: this.bytes,
      savedAt: this.savedAt,
      schemaVersion: Number(this.getMeta('schema_version') || SCHEMA_VERSION),
      isNew: !this._openExisting,
    };
  }

  close() {
    try { this.persist(); } catch { /* 关不成就关不成，别阻塞退出 */ }
    try { this.db.close(); } catch { /* 同上 */ }
  }
}

/* ========================================================= */
/* 小工具                                                      */
/* ========================================================= */

const s = (v) => (v == null ? '' : String(v));

/** 数值或 null（SQLite 的 INTEGER 列不接受 undefined） */
function n(v) {
  if (v == null || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? Math.trunc(x) : null;
}

function safeJsonArray(text) {
  try {
    const v = JSON.parse(text || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
