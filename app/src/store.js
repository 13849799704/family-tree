/**
 * =========================================================
 * 存储层 · store.js
 * ---------------------------------------------------------
 * 职责：把数据集存到某处、从某处读回来。**上层不需要知道存在哪。**
 *
 * 【两种运行形态，同一套接口】
 *   桌面版（Electron）：宿主注入 `window.genogramFS`（preload 提供），
 *       背后是 SQLite 库 `D:\族谱pc端项目\数据\genogram.db`。
 *   网页版（开发调试用，`node dev-server.js`）：退回 localStorage。
 *   两者对外都是 load / save / export / import，UI 层一行都不用改
 *   —— 这正是当初留这个口子的目的。
 *
 * 【写入是异步的（v0.2 起）】
 *   桌面版写库要过 IPC，本质是异步。所以 saveDataset 返回 Promise。
 *   调用方可以「先渲染再等落盘」（乐观更新），落盘失败再弹提示。
 *
 * ⚠️ 隐私：PRD §8 要求「数据只存本地、不上传」。
 *    本文件不存在任何网络请求 —— 请保持这一点。
 * =========================================================
 */

import { normalizeDataset, serialize } from './core/model.js';

const STORAGE_KEY = 'genogram.dataset.v1';
const AUTOSAVE_KEY = 'genogram.autosave.at';

/* ---------------------------------------------------------- */
/* v0.2.24：多本谱                                              */
/* --------------------------------------------------------- */
/* 桌面版的权限在主进程（它持有多个 GenogramStore），这里只是转发；
   网页版没有主进程，所以用 localStorage 自己实现一套同形状的：
     清单            → genogram.books.v1
     某本谱的数据    → genogram.dataset.v1.<bookId>

   ⚠️ 老用户的数据已经在 genogram.dataset.v1 里（没有后缀），
      首次进入时由 ensureWebLib() 迁到第一本谱名下，老 key 保留不动。 */
const LIB_KEY = 'genogram.books.v1';
const BOOK_KEY = (id) => `genogram.dataset.v1.${id}`;
const DEFAULT_BOOK_NAME = '我的家族';

/** 网页版当前谱 id（桌面版由主进程说了算，这里是 null） */
let webCurrent = null;

/** 取宿主桥（桌面版注入的 genogramFS），没有则 null */
const bridge = () =>
  typeof window !== 'undefined' &&
  window.genogramFS &&
  typeof window.genogramFS.read === 'function'
    ? window.genogramFS
    : null;

/* ========================================================= */
/* 读                                                          */
/* ========================================================= */

/**
 * 读取数据集。
 * **同步**：桌面版的桥在 preload 阶段就把整份数据取回缓存了，
 * 浏览器版读 localStorage 本来就是同步的。
 * 这样 boot() 不必为了桌面版改成 async。
 *
 * 失败一律降级为 null（由上层决定回落到示例数据），不抛异常 ——
 * 一份格式错误的存档不该让整个应用打不开。
 *
 * @returns {object|null} 规范化后的数据集
 */
export function loadDataset() {
  try {
    const b = bridge();
    let text;
    if (b) {
      const boot = b.boot?.();
      if (boot && boot.ok === false) {
        console.error('[store] 桌面桥启动失败：', boot.error);
      }
      text = b.read();
    } else {
      const id = ensureWebLib().current;
      // 老 key 优先：迁移会把值复制到新 key，两者都在时以新的为准
      text = localStorage.getItem(BOOK_KEY(id)) ?? localStorage.getItem(STORAGE_KEY);
    }
    if (!text) return null;

    const ds = normalizeDataset(JSON.parse(text));

    /* ⚠️ 这里**不能**因为「没有一个人」就返回 null。
       空数据集是一个合法且必须保持的状态 —— 用户点了「清空数据」之后就是这个状态。
       一旦在这里返回 null，app.js 会把它当成「首次运行」，重启又把示例家族灌回来，
       清空按钮等于失灵。
       「有没有存档」只看上面 text 是否为空；「存档里有几个人」是另一回事。 */
    return ds;
  } catch (e) {
    console.warn('[store] 读取存档失败，将回落到示例数据：', e);
    return null;
  }
}

/* ========================================================= */
/* 网页版的谱清单（localStorage 版）                            */
/* --------------------------------------------------------- */
/* 桌面版不需要这一段 —— 那边由 electron/library.js 管，主进程是权威。
   但网页版必须自己记账，否则 v0.2.24 的多谱功能在开发调试时是坏的。 */
/* ========================================================= */

const nowMs = () => Date.now();

function readWebLib() {
  try {
    const raw = localStorage.getItem(LIB_KEY);
    if (raw) {
      const lib = JSON.parse(raw);
      if (lib && Array.isArray(lib.books)) return lib;
    }
  } catch { /* 损坏就重建 */ }
  return null;
}

function writeWebLib(lib) {
  localStorage.setItem(LIB_KEY, JSON.stringify(lib));
  webCurrent = lib.current;
  return lib;
}

/** 幂等地准备好清单：老的裸 STORAGE_KEY 会被迁进第一本谱 */
function ensureWebLib() {
  if (webCurrent) {
    const lib = readWebLib();
    if (lib) return lib;
  }
  const existing = readWebLib();
  if (existing) { webCurrent = existing.current; return existing; }

  const legacy = localStorage.getItem(STORAGE_KEY);
  const first = {
    id: 'book-web-1',
    name: DEFAULT_BOOK_NAME,
    createdAt: nowMs(),
    updatedAt: nowMs(),
    people: 0,
  };
  if (legacy) {
    // 复制而非剪切：老 key 留着，用户退回旧版本也能用
    localStorage.setItem(BOOK_KEY(first.id), legacy);
  }
  return writeWebLib({ version: 1, current: first.id, books: [first] });
}

/** 更新 ubdatedAt + 人数快照 */
function touchWebCurrent(id) {
  const lib = readWebLib();
  if (!lib) return;
  const b = lib.books.find((x) => x.id === id);
  if (b) { b.updatedAt = nowMs(); }
  lib.current = id;
  writeWebLib(lib);
}

/**
 * 当前谱 {id, name}。
 * 桌面版从 bootstrap 缓存读；网页版从清单读。
 * @returns {{id:string, name:string}|null}
 */
export function currentBook() {
  const b = bridge();
  if (b) return b.book?.() || null;
  const lib = ensureWebLib();
  return lib.books.find((x) => x.id === lib.current) || null;
}

/**
 * 谱清单 + 人数。
 * @returns {{current:string|null, books:{id,name,people}[]}}
 */
export function listBooks() {
  const b = bridge();
  if (b) {
    const lib = b.library?.();
    if (lib?.books) return { current: lib.current, books: lib.books };
    return { current: null, books: [] };
  }
  const lib = ensureWebLib();
  return {
    current: lib.current,
    books: lib.books.map((x) => ({
      ...x,
      people: countWebPeople(x.id),
    })),
  };
}

function countWebPeople(id) {
  try {
    const t = localStorage.getItem(BOOK_KEY(id));
    if (!t) return 0;
    const ds = JSON.parse(t);
    return Array.isArray(ds?.people) ? ds.people.length : 0;
  } catch { return 0; }
}

/**
 * 新建一本谱并切过去。
 * @param {{name:string, seedDataset?:object}} opts
 *        seedDataset 是新谱的初始内容（示例家族 / 导入的数据）；不传则是空谱。
 * @returns {Promise<{ok:boolean, dataset?:object, book?:object, library?:object, error?:string}>}
 */
export async function createBook({ name, seedDataset } = {}) {
  const b = bridge();
  if (b?.bookLib) {
    const r = await b.bookLib.create({
      name: name || DEFAULT_BOOK_NAME,
      seed: seedDataset ? serialize(seedDataset) : null,
    });
    if (!r?.ok) return { ok: false, error: r?.error || '新建失败' };
    return {
      ok: true,
      book: r.book,
      library: r.library,
      dataset: r.json ? normalizeDataset(JSON.parse(r.json)) : null,
    };
  }

  /* ---- 网页版 ---- */
  const lib = ensureWebLib();
  const clean = String(name || '').trim() || DEFAULT_BOOK_NAME;
  const base = lib.books.some((x) => x.name === clean)
    ? uniqueWebName(lib.books.map((x) => x.name), clean)
    : clean;
  const book = {
    id: 'book-web-' + (lib.books.length + 1) + '-' + nowMs().toString(36),
    name: base,
    createdAt: nowMs(),
    updatedAt: nowMs(),
    people: seedDataset?.people?.length || 0,
  };
  lib.books.push(book);
  lib.current = book.id;
  writeWebLib(lib);
  const dataset = seedDataset
    ? normalizeDataset(seedDataset)
    : normalizeDataset({ version: '1.0', viewpoint: '', people: [], relationships: [] });
  localStorage.setItem(BOOK_KEY(book.id), serialize(dataset));
  localStorage.setItem(AUTOSAVE_KEY, String(nowMs()));
  return { ok: true, book, library: lib, dataset };
}

function uniqueWebName(existing, wanted) {
  if (!existing.includes(wanted)) return wanted;
  let i = 2;
  while (existing.includes(`${wanted} (${i})`)) i++;
  return `${wanted} (${i})`;
}

/**
 * 切到另一本谱。
 * @param {string} id
 * @returns {Promise<{ok:boolean, dataset?:object|null, book?:object, library?:object, error?:string}>}
 */
export async function switchBook(id) {
  const b = bridge();
  if (b?.bookLib) {
    const r = await b.bookLib.switch(id);
    if (!r?.ok) return { ok: false, error: r?.error || '切换失败' };
    return {
      ok: true,
      book: r.book || currentBook(),
      library: r.library,
      dataset: r.json ? normalizeDataset(JSON.parse(r.json)) : null,
    };
  }

  /* ---- 网页版 ---- */
  const lib = ensureWebLib();
  if (!lib.books.some((x) => x.id === id)) return { ok: false, error: '这本谱不存在' };
  const text = localStorage.getItem(BOOK_KEY(id));
  touchWebCurrent(id);
  const book = lib.books.find((x) => x.id === id);
  return {
    ok: true,
    book,
    library: readWebLib(),
    dataset: text ? normalizeDataset(JSON.parse(text)) : null,
  };
}

/** 改谱名 */
export async function renameBook(id, name) {
  const clean = String(name || '').trim();
  if (!clean) return { ok: false, error: '谱名不能为空' };

  const b = bridge();
  if (b?.bookLib) {
    const r = await b.bookLib.rename(id, clean);
    return r?.ok ? { ok: true, book: r.book, library: r.library } : { ok: false, error: r?.error || '重命名失败' };
  }

  const lib = ensureWebLib();
  const target = lib.books.find((x) => x.id === id);
  if (!target) return { ok: false, error: '这本谱不存在' };
  target.name = clean;
  target.updatedAt = nowMs();
  writeWebLib(lib);
  return { ok: true, book: target, library: readWebLib() };
}

/**
 * 删除一本谱。
 * ⚠️ 网页版会真的 removeItem（浏览器里没有 trash 目录可挪），
 *    所以调用方必须先让用户导出备份。桌面版由主进程挪进 trash/，可恢复。
 */
export async function deleteBook(id) {
  const b = bridge();
  if (b?.bookLib) {
    const r = await b.bookLib.remove(id);
    if (!r?.ok) return { ok: false, error: r?.error || '删除失败' };
    return {
      ok: true,
      library: r.library,
      book: r.book || currentBook(),
      dataset: r.json ? normalizeDataset(JSON.parse(r.json)) : null,
    };
  }

  const lib = ensureWebLib();
  if (lib.books.length <= 1) return { ok: false, error: '至少得留一本谱' };
  const i = lib.books.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, error: '这本谱不存在' };
  lib.books.splice(i, 1);
  localStorage.removeItem(BOOK_KEY(id));
  if (lib.current === id) lib.current = lib.books[0].id;
  writeWebLib(lib);
  const text = localStorage.getItem(BOOK_KEY(lib.current));
  return {
    ok: true,
    library: readWebLib(),
    book: lib.books.find((x) => x.id === lib.current),
    dataset: text ? normalizeDataset(JSON.parse(text)) : null,
  };
}

/** 上次保存时间（顶栏提示用） */
export function lastSavedAt() {
  try {
    const b = bridge();
    if (b?.boot) return b.boot()?.info?.savedAt ?? null;
    const t = localStorage.getItem(AUTOSAVE_KEY);
    return t ? Number(t) : null;
  } catch {
    return null;
  }
}

/* ========================================================= */
/* 写                                                          */
/* ========================================================= */

/**
 * 保存数据集。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function saveDataset(dataset) {
  const text = serialize(dataset);
  const b = bridge();

  /* ---- 桌面版：写 SQLite（IPC → 主进程 → 表 → 原子落盘） ---- */
  if (b) {
    try {
      const res = await b.write(text);
      return res && res.ok === false
        ? { ok: false, error: res.error || '写库失败' }
        : { ok: true };
    } catch (e) {
      return { ok: false, error: '写库失败：' + (e?.message || e) };
    }
  }

  /* ---- 网页版：localStorage ---- */
  try {
    const id = ensureWebLib().current;
    localStorage.setItem(BOOK_KEY(id), text);
    localStorage.setItem(AUTOSAVE_KEY, String(Date.now()));
    touchWebCurrent(id);
    return { ok: true };
  } catch (e) {
    console.error('[store] 保存失败：', e);
    const quota =
      e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
    return {
      ok: false,
      error: quota
        ? '浏览器存储空间已满（照片太多会占空间），请先导出备份并清理部分照片'
        : '保存失败：' + (e?.message || e),
    };
  }
}

/** 清空存档（危险操作，调用方必须二次确认） */
export async function clearDataset() {
  const b = bridge();
  try {
    if (b) {
      const r = await b.clear();
      return r && r.ok === false ? r : { ok: true };
    }
    /* 网页版也一样：**写入一份空数据集**，而不是把 key 删掉。
       删掉 key = 下次启动认为「从没存过」→ 又把示例家族灌回来。
       写空数据集 = 「存过，只是现在是空的」，语义才对。 */
    const empty = normalizeDataset({
      version: '1.0', viewpoint: '', people: [], relationships: [],
    });
    const id = ensureWebLib().current;
    localStorage.setItem(BOOK_KEY(id), serialize(empty));
    localStorage.setItem(AUTOSAVE_KEY, String(Date.now()));
    touchWebCurrent(id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/* ========================================================= */
/* 文件导入 / 导出                                             */
/* ========================================================= */

/**
 * 导出。
 * 桌面版走系统「另存为」对话框（默认落数据目录）；
 * 网页版退回浏览器下载。
 *
 * @param {object} dataset 要导出的数据集（可能是 scopeToTree 裁剪后的副本）
 * @param {string} [filename]
 * @param {Object<string,string>|null} [photoMap] 「包含照片」时传 {文件名: dataUrl}；
 *         会以顶层 `_photos` 嵌进 JSON，使文件自包含。不传 = 只存文件名。
 * @returns {Promise<{ok:boolean, name?:string, path?:string, error?:string, canceled?:boolean}>}
 */
export async function exportFile(dataset, filename, photoMap = null) {
  const name = filename || defaultFilename();
  const b = bridge();

  /* _photos 是**导出专用**的顶层字段：db:write 的 writeDataset 只读
     people/relationships/version/viewpoint，天然忽略它 —— 所以这份文件
     重新导入时，照片恢复与数据写入互不干扰（见 app.js 的导入流程）。 */
  const text = photoMap ? serializeWithPhotos(dataset, photoMap) : serialize(dataset);

  if (b?.exportTo) {
    const r = await b.exportTo(text, name);
    if (!r?.ok) return { ok: false, canceled: !!r?.canceled, error: r?.error };
    return { ok: true, name: baseName(r.path), path: r.path };
  }

  const blob = new Blob([text], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return { ok: true, name };
}

/** 带内联照片的导出文本（只在导出路径出现，不进库、不进 state.dataset） */
function serializeWithPhotos(dataset, photoMap) {
  const base = JSON.parse(serialize(dataset));
  base._photos = photoMap;
  return JSON.stringify(base, null, 2);
}

/**
 * 导出 PNG（桌面版走系统「另存为」，网页版退回浏览器下载）。
 * 与 exportFile 同一套双通道，别再开第三种写法。
 *
 * @param {string} dataUrl  形如 data:image/png;base64,...
 * @param {string} filename
 * @returns {Promise<{ok:boolean, name?:string, path?:string, error?:string, canceled?:boolean}>}
 */
export async function exportImageFile(dataUrl, filename) {
  const name = filename || '家族谱.png';
  const b = bridge();

  if (b?.exportImage) {
    const r = await b.exportImage(dataUrl, name);
    if (!r?.ok) return { ok: false, canceled: !!r?.canceled, error: r?.error };
    return { ok: true, name: baseName(r.path), path: r.path };
  }

  /* 网页版：把 dataUrl 变回 Blob 再触发下载 */
  const blob = await (await fetch(dataUrl)).blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return { ok: true, name };
}

/** 桌面版：弹系统「打开」对话框并读文件；网页版返回不支持 */
export async function importFromDisk() {
  const b = bridge();
  if (!b?.importFrom) return { ok: false, error: '当前环境不支持（请在桌面版里用）' };
  const r = await b.importFrom();
  if (!r?.ok) return { ok: false, canceled: !!r?.canceled, error: r?.error };
  return parseText(r.json, r.name);
}

/**
 * 网页版：从 <input type=file> 拿到的 File 导入。
 * @param {File} file
 * @returns {Promise<{ok:boolean, dataset?:object, error?:string}>}
 */
export function importFile(file) {
  return new Promise((resolve) => {
    if (!file) return resolve({ ok: false, error: '没有选择文件' });
    const reader = new FileReader();
    reader.onerror = () => resolve({ ok: false, error: '文件读取失败' });
    reader.onload = () => resolve(parseText(String(reader.result), file.name));
    reader.readAsText(file, 'utf-8');
  });
}

/** 解析并规范化一份 JSON 文本（导入的两条路径共用） */
function parseText(text, name) {
  try {
    const raw = JSON.parse(text);
    if (!raw || !Array.isArray(raw.people)) {
      return { ok: false, error: '文件格式不对：缺少 people 数组' };
    }
    /* 内联照片先摘下来：normalizeDataset 不认识 _photos，会被无声丢掉。
       它跟着结果往下走，到「目的地谱就位」之后再落盘（app.js offerImport）。
       形状不对（不是纯对象）就当没有，不报错 —— 旧版导出没有这个字段。 */
    const photos = (raw._photos && typeof raw._photos === 'object' && !Array.isArray(raw._photos))
      ? raw._photos
      : null;
    const ds = normalizeDataset(raw);
    if (!ds.people.length) {
      return { ok: false, error: '文件里没有任何人物记录' };
    }
    return { ok: true, dataset: ds, name, photos };
  } catch (e) {
    return { ok: false, error: 'JSON 解析失败：' + (e?.message || e) };
  }
}

/* ========================================================= */
/* 环境信息                                                    */
/* ========================================================= */

/**
 * 当前存储形态。
 * @returns {'sqlite'|'local'} sqlite = 桌面版本地数据库；local = 浏览器 localStorage
 */
export function storageMode() {
  const b = bridge();
  if (!b) return 'local';
  return b.boot?.()?.info?.kind === 'sqlite' ? 'sqlite' : 'local';
}

/** 数据文件位置（仅桌面版有）+ 规模信息 */
export function storageInfo() {
  const b = bridge();
  if (!b?.boot) return null;
  return b.boot()?.info || null;
}

/** 在资源管理器里打开数据目录（仅桌面版） */
export async function openDataDir() {
  const b = bridge();
  if (!b?.openDataDir) return { ok: false, error: '当前环境不支持' };
  return b.openDataDir();
}

/* ========================================================= */
/* 小工具                                                      */
/* ========================================================= */

function defaultFilename() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `家族谱-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
}

const baseName = (p) => String(p || '').split(/[\\/]/).pop() || '';
