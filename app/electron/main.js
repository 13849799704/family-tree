/**
 * =========================================================
 * 主进程 · electron/main.js
 * ---------------------------------------------------------
 * 它是这个桌面应用的「大脑」：
 *   1. 定位并打开本地 SQLite 库（D:\族谱pc端项目\数据\genogram.db）
 *   2. 建窗口，把 index.html 装进去（渲染层仍是那套 HTML/CSS/JS，一行没白写）
 *   3. 用 IPC 把「读写数据 / 导入导出 / 打开数据目录」这几件事关起来，
 *      只从 preload 的白名单出去
 *
 * 进程分工：
 *   主进程  = Node 环境，能碰文件系统 → 只有它碰数据库
 *   渲染进程 = 浏览器环境，只画界面 → 想要数据必须开口要
 * 这条界线是 Electron 安全模型的地基，别为了省事打通它。
 * =========================================================
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import electron from 'electron';
import { GenogramStore } from './db.js';
import {
  resolveDataDir, dataDirCandidates, ensureLayout, backupOnOpen, photosDir, bookDir, booksRoot,
} from './paths.js';
import {
  addPhotos, readDataUrl, readMany, removePhotos, restoreMap, squareThumb,
} from './photoStore.js';
import { isValidPhotoName } from '../src/core/photoNames.js';
import {
  ensureLibrary, createBook, renameBook, deleteBook, setCurrent,
  readLibrary, currentBook, setPeopleCount,
} from './library.js';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage } = electron;

/* 兜底：如果 ELECTRON_RUN_AS_NODE 没被清掉，Electron 会退化成纯 Node，
   此时 `electron` 拿到的是「二进制路径字符串」，app 是 undefined。
   原生报错是 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`，
   栈里还写着 Node.js vXX —— 完全看不出真因，所以这里给一句人话。 */
if (!process.versions.electron || !app) {
  console.error(
    '\n[启动失败] 没有运行在 Electron 里。\n' +
    '原因通常是环境变量 ELECTRON_RUN_AS_NODE 被设置了（某些 IDE / 终端会自动带）。\n' +
    '处理：用 `npm start` 启动（它会先清掉这个变量），或手动 `unset ELECTRON_RUN_AS_NODE`。\n'
  );
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');   // app/
const INDEX_HTML = path.join(APP_ROOT, 'index.html');

/** 数据根目录（不再是某一本谱的目录） */
let dataDir = '';

/* ---------------------------------------------------------- */
/* 多本谱                                                      */
/* --------------------------------------------------------- */
/* v0.2.24 起一个进程里可以有多本谱：每本谱一个 GenogramStore 实例，
   用 Map 按 bookId 惰性打开 —— 切走的不 close（族谱量级下内存不是问题），
   但 MAP 里保留的实例在退出前统一落盘。

   `currentStore()` 是给现有的 db:* IPC 用的：它们只认「当前这本」，
   所以这里的切换对上层是透明的。 */
/** @type {Map<string, GenogramStore>} */
const stores = new Map();
/** @type {object|null} 清单 { version, current, books } */
let library = null;
/** @type {string|null} 当前谱 id */
let currentId = null;

const currentStore = () => (currentId ? stores.get(currentId) || null : null);

/** @type {BrowserWindow|null} */
let win = null;

/* ========================================================= */
/* 启动日志                                                    */
/* --------------------------------------------------------- */
/* 主进程出问题时最糟的情况是「窗口都没出现，也没有任何提示」。
   Electron 在 Windows 上遇到未捕获异常会弹一个**阻塞式**错误框，
   自动化跑测试时会直接挂死。
   所以：① 每一步都留痕；② 用 GENOGRAM_NO_DIALOG=1 关掉弹框，
   让错误以日志形式暴露出来（CI / 冒烟测试用）。 */

const DEBUG = !!process.env.GENOGRAM_DEBUG;
const NO_DIALOG = !!process.env.GENOGRAM_NO_DIALOG;
/* 打包后自检：不显示窗口，把渲染层的实际渲染结果写成 JSON 再退出。
  用来回答「打包出来的应用到底能不能跑」，而不是只看「文件生成了」。
  Windows 下 Electron 是 GUI 子系统程序，stdout 常常抓不到，所以结果落文件。 */
const SELFTEST = !!process.env.GENOGRAM_SELFTEST;

/** 当前写入的日志文件 */
let bootLog = null;
/** 早期日志（数据目录还没定下来时的落脚点），并进数据目录后清空 */
let earlyLog = null;

/**
 * 立刻给日志找个落点。
 * 以前日志要等数据目录解析完才开始写 —— 于是「崩在第 4 步之前」的情况一个字都没有，
 * 别人电脑双击打不开时只能靠猜（真正的一次：崩在单实例锁那行，什么都没记）。
 * 现在第一时间落 %TEMP%，事后再搬进数据目录。
 */
function pickBootLog() {
  try {
    if (process.env.GENOGRAM_BOOT_LOG) {
      bootLog = process.env.GENOGRAM_BOOT_LOG;
      return;
    }
    earlyLog = path.join(app.getPath('temp'), '族谱-boot.log');
    bootLog = earlyLog;
  } catch { /* 连 temp 都拿不到就算了，只走 stderr */ }
}

/** 数据目录定下来后：把早期日志并进 `数据目录\boot.log`，之后只写那里 */
function adoptBootLog(dir) {
  const dest = path.join(dir, 'boot.log');
  if (earlyLog && bootLog === earlyLog) {
    try {
      if (fs.existsSync(earlyLog)) {
        fs.appendFileSync(
          dest,
          `--- 以下是本次启动的早期日志（数据目录定下来之前，先落在 %TEMP%） ---\n`
            + fs.readFileSync(earlyLog, 'utf-8'),
        );
        fs.unlinkSync(earlyLog);
      }
    } catch { /* 搬不动就继续留在 %TEMP%，总比没有强 */ }
  }
  bootLog = dest;
}

pickBootLog();

/** 本地时间 `2026-10-12 10:37:58.640`。
 *  ⚠️ 以前这里用 `toISOString()`，输出的是 UTC（末尾那个 Z 就是「零时区」）。
 *     日志是给人看的，本地时间才是「几点出的事」—— UTC 有两个真实的坑：
 *     上午 8 点前启动，日期会写成**前一天**；深夜看又以为是白天出的事。
 *     排查启动顺序时毫秒有用，所以保留三位。 */
function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `.${p(d.getMilliseconds(), 3)}`;
}

function blog(step, extra) {
  const line = `[${stamp()}] ${step}` + (extra ? ' — ' + extra : '');
  if (DEBUG) console.error('[boot] ' + line);
  try {
    if (bootLog) fs.appendFileSync(bootLog, line + '\n');
  } catch { /* 日志失败不该影响启动 */ }
}

/* ---------------------------------------------------------- */
/* 崩溃留痕                                                     */
/* --------------------------------------------------------- */
/* Electron 在 Windows 上崩溃时没有控制台，进程可能直接消失。
   这几个钩子保证「崩了也有痕迹」：出问题时让对方把日志发回来就能定位，
   不用再靠「双击没反应」猜是安装、杀软、显卡还是数据目录。 */

process.on('uncaughtException', (e) => {
  blog('X. 主进程未捕获异常', e?.stack || String(e));
  console.error('[boot] 未捕获异常：', e);
  if (!NO_DIALOG) {
    dialog.showErrorBox(
      '族谱意外出错',
      `${e?.message || e}\n\n出错日志：\n${bootLog || '(未确定)'}`
    );
  }
  app.exit(1);
});

process.on('unhandledRejection', (e) => {
  blog('X. 未处理的 Promise 拒绝', e?.stack || String(e));
});

app.on('render-process-gone', (_e, _wc, details) => {
  blog('X. 渲染进程退出', JSON.stringify(details));
});

app.on('child-process-gone', (_e, details) => {
  // type=gpu 就是显卡加速进程崩了 —— 「只在我这能开、别人那打不开」的常见原因
  blog('X. 子进程退出', JSON.stringify(details));
});

/* ========================================================= */
/* 图形后端                                                    */
/* --------------------------------------------------------- */
/* 本机实测：Electron 的 GPU 进程会反复崩溃，最后
     FATAL:content\browser\gpu\gpu_data_manager_impl_private.cc:417]
     GPU process isn't usable. Goodbye.
   应用直接退出，连窗口都建不出来（症状极具误导性：什么都不报，就是没窗口）。

   本应用是纯 2D（DOM + SVG），不依赖硬件加速，所以默认走软件渲染 ——
   换来「在任何机器上都能打开」，代价只是大范围拖拽时没那么丝滑。
   想开回硬件加速：设 GENOGRAM_HW_ACCEL=1。 */

if (!process.env.GENOGRAM_HW_ACCEL) {
  app.disableHardwareAcceleration();
  blog('0. 已关闭硬件加速（软件渲染）');
}

/* ========================================================= */
/* 启动                                                        */
/* ========================================================= */

/* 诊断心跳：只在 GENOGRAM_DEBUG=1 时开。
   用来区分「ready 事件压根没发」和「whenReady() 的 promise 有问题」——
   这两种情况的表象一模一样（就是没窗口），但修法完全不同。 */
app.on('ready', () => blog('E. 收到 app ready 事件'));

if (DEBUG) {
  let hb = 0;
  const timer = setInterval(() => {
    blog(`heartbeat#${++hb}`, `isReady=${app.isReady()}`);
    if (hb >= 10) clearInterval(timer);
  }, 2000);
}

// 单实例：族谱是单机应用，开两个窗口写同一个库没有意义
/* ⚠️ 自动化测试要能跟真应用**并存**：冒烟跑的是独立沙箱目录（GENOGRAM_DATA_DIR），
   跟用户真库毫无关系，却被单实例锁挡在门外 —— 应用开着的时候冒烟只能秒退，
   看起来像「什么都没发生」。所以给测试一个开关：跳过单实例锁。 */
const NO_SINGLE_INSTANCE = !!process.env.GENOGRAM_NO_SINGLE_INSTANCE;
if (!NO_SINGLE_INSTANCE && !app.requestSingleInstanceLock()) {
  /* ⚠️ 这里以前只有一行 console.error，然后 app.quit() ——
     Windows 上 GUI 程序没有控制台，用户什么都看不见：
     「双击没反应、也没有任何提示」就是这么来的（真出现过一次）。
     现在给一句人话，并把这行写进日志。 */
  blog('X. 已有实例在运行，本实例退出');
  console.error('[boot] 已有实例在运行，本实例退出');
  if (NO_DIALOG) {
    app.exit(0);
  } else {
    app
      .whenReady()
      .then(() =>
        dialog.showMessageBox({
          type: 'info',
          title: '族谱已经在运行了',
          message: '族谱已经在运行了。',
          detail:
            '请在任务栏里找一下已经打开的族谱窗口。\n'
            + '如果找不到，说明上次没关干净：打开「任务管理器」→「详细信息」，\n'
            + '结束所有名为「家族谱」的进程，再重新打开本程序。',
          buttons: ['知道了'],
          noLink: true,
          defaultId: 0,
        })
      )
      .catch(() => {})
      .finally(() => app.exit(0));
  }
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  boot().catch((e) => {
    blog('boot() 抛出未捕获异常', e?.stack || String(e));
    console.error('[boot] 启动失败：', e);
    if (!NO_DIALOG) {
      dialog.showErrorBox('启动失败', String(e?.stack || e));
    }
    app.exit(1);
  });
}

async function boot() {
  blog('1. 等待 app ready');
  await app.whenReady();
  blog('2. app ready', `electron=${process.versions.electron} node=${process.versions.node}`);

  try {
    blog('3. 解析数据目录');
    dataDir = resolveDataDir({ fallback: app.getPath('userData') });
    blog('4. 数据目录', dataDir);
    adoptBootLog(dataDir);   // 早期日志从 %TEMP% 并进这里，之后只写这一份
    // 用的是备用位置（D 盘不可用 → C 盘）就留一行说明，免得以后找不到数据在哪
    {
      const first = dataDirCandidates({ fallback: app.getPath('userData') })[0];
      if (dataDir !== first) blog('4.1 说明', `首选位置不可用，改用 ${dataDir}`);
    }

    ensureLayout(dataDir);
    backupOnOpen(dataDir);
    /* ⚠️ 备份必须在 ensureLibrary 之前：如果这次是老版本升级上来的，
       根目录那份 genogram.db 正是要被迁移的原件，先备份再动它。 */
    blog('5. 备份完成（老目录）');
    fs.mkdirSync(booksRoot(dataDir), { recursive: true });

    /* 族谱库清单：没有清单就迁移老库 / 建默认那一本。
       ⚠️ 这一步必须在打开任何谱之前 —— ensureLibrary 决定了 currentId，
       而所有 db:* 访问都跟着 currentId 走。 */
    const prep = ensureLibrary(dataDir);
    library = prep.library;
    blog('5.1 谱清单', `${library.books.length} 本${prep.migrated ? '（已从老库迁移）' : ''}`);

    currentId = prep.book.id;
    await ensureStore(prep.book.id);
    blog('6. 数据库已打开', JSON.stringify(currentStore().info()));

    fs.mkdirSync(photosDir(bookDir(dataDir, prep.book.id)), { recursive: true });
  } catch (e) {
    blog('X. 打开数据库失败', e?.stack || String(e));
    if (!NO_DIALOG) {
      dialog.showErrorBox(
        '打不开数据库',
        `${e?.message || e}\n\n数据目录：${dataDir || '(未确定)'}\n\n` +
          `可以把该目录里的 backups\\ 复制出来手动恢复。`
      );
    }
    app.exit(1);
    return;
  }

  registerIpc();
  blog('7. IPC 已注册');
  buildMenu();
  blog('8. 菜单已建');
  createWindow();
  blog('9. 窗口已创建');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('window-all-closed', () => {
  // 桌面版按惯例：关掉窗口就退出（macOS 除外）
  if (process.platform !== 'darwin') app.quit();
});

/* 退出前把内存里的库落盘。渲染层本来每次操作都存了，
   这里是最后一道保险（例如关窗时正好有一次异步保存在路上）。

   ⚠️ v0.2.24：所有打开过的谱都要落，不只是当前这本 ——
   用户可能刚从 A 切到 B，A 的最后一次编辑还躺在内存里。 */
app.on('before-quit', () => {
  for (const [id, s] of stores) {
    try { s.persist(); } catch (e) { console.error(`[db] 退出前落盘失败（${id}）：`, e); }
  }
});

/* ========================================================= */
/* 窗口                                                        */
/* ========================================================= */

function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    title: '家族谱 · 称谓自动推导',
    backgroundColor: '#eef1f6',
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,     // 页面看不到 Node
      nodeIntegration: false,     // 更别想直接 require
      spellcheck: false,
    },
  });

  // 首帧画完再显示，避免白屏闪一下（自检模式不显示窗口）
  if (!SELFTEST) win.once('ready-to-show', () => win.show());
  win.loadFile(INDEX_HTML);
  if (SELFTEST) runSelfTest();

  // 外链一律丢给系统浏览器，别在应用窗口里开网页
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* --------------------------------------------------------- */
/* 打包后自检（GENOGRAM_SELFTEST=1）                            */
/* --------------------------------------------------------- */
/* 这套检查的存在意义：asar 打包、WASM 定位、ES Module 走 file:// 加载，
   这三个环节任何一个在打包后坏掉，应用都会「窗口能开但界面空白」。
   只检查文件存在是发现不了的 —— 必须真的把渲染层跑一遍，数出节点。 */
function runSelfTest() {
  const started = Date.now();
  const outFile = process.env.GENOGRAM_SELFTEST_OUT
    || path.join(dataDir || process.cwd(), 'selftest.json');
  let done = false;
  let timer = null;

  const finish = (payload, code) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    const body = {
      ...payload,
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      packaged: app.isPackaged,
      dataDir,
      elapsedMs: Date.now() - started,
    };
    try {
      fs.writeFileSync(outFile, JSON.stringify(body, null, 2));
    } catch (e) {
      console.error('[selftest] 写结果失败：', e);
    }
    process.stdout.write('\nGENOGRAM_SELFTEST ' + JSON.stringify(body) + '\n');
    setTimeout(() => app.exit(code), 200);
  };

  timer = setTimeout(() => finish({ ok: false, error: '超时：渲染层没在 30s 内画出节点' }, 3), 30000);

  const wc = win.webContents;
  wc.on('did-fail-load', (_e, code, desc, url) =>
    finish({ ok: false, error: `did-fail-load ${code} ${desc}`, url }, 4));
  wc.on('render-process-gone', (_e, details) =>
    finish({ ok: false, error: 'render-process-gone', details }, 5));
  wc.on('console-message', (...args) => {
    try { console.error('[renderer]', args.map(String).join(' ')); } catch { /* 忽略 */ }
  });

  wc.once('did-finish-load', async () => {
    // 探测脚本用 toString() 拼，避免和外面的模板字符串互相干扰
    const probe = '(' + function () {
      return new Promise((resolve) => {
        const t0 = Date.now();
        const read = () => {
          const nodes = document.querySelectorAll('.node').length;
          // boot() 用双 rAF + 最多 20 帧重试，给它时间把首帧算出来
          if (nodes === 0 && Date.now() - t0 < 9000) { setTimeout(read, 120); return; }
          const el = (s) => document.querySelector(s);
          const qa = (s) => [...document.querySelectorAll(s)];
          resolve({
            title: document.title,
            url: location.href,
            hasBridge: !!window.genogramFS,
            bridgeNodeVisible: window.genogramFS ? window.genogramFS.nodeVisible : undefined,
            requireVisible: typeof require !== 'undefined',
            processVisible: typeof process !== 'undefined',
            nodes,
            wires: qa('.wires path, .wires line').length,
            viewTabs: qa('.view-tab').length,
            zoom: (el('#zoomVal') || {}).textContent || null,
            toast: (el('#toastWrap') || {}).textContent || null,
            bodyHead: ((document.body && document.body.innerText) || '')
              .replace(/\s+/g, ' ').trim().slice(0, 240),
          });
        };
        read();
      });
    }.toString() + ')()';

    try {
      const r = await wc.executeJavaScript(probe, true);
      finish({ ok: r.nodes > 0, ...r }, r.nodes > 0 ? 0 : 7);
    } catch (e) {
      finish({ ok: false, error: 'executeJavaScript 失败：' + (e?.message || e) }, 6);
    }
  });
}

/* ========================================================= */
/* 谱的打开 / 切换                                              */
/* --------------------------------------------------------- */
/* 这一段是 v0.2.24 多谱能力的全部「服务端」。对外只暴露两件事：
     ensureStore(id)  —— 保证这本谱已打开
     switchBook(id)   —— 换一本当前谱（返回它的整份数据）
   其余 db:* IPC 全部作用于 currentStore()，因此对上层是透明的。 */
/* ========================================================= */

/**
 * 打开（或复用已打开的）一本谱。
 * 顺带把人数快照写回清单 —— 列表上要显示人数，但不值得为它把每本谱都打开一遍。
 */
async function ensureStore(id) {
  const hit = stores.get(id);
  if (hit) return hit;

  const dir = bookDir(dataDir, id);
  ensureLayout(dir);
  backupOnOpen(dir);

  const s = await GenogramStore.open(dir);
  stores.set(id, s);
  try { setPeopleCount(dataDir, id, s.info().people); } catch { /* 快照失败无所谓 */ }
  return s;
}

/** 清单 + 每本谱的人数快照（给渲染层的下拉列表用） */
function libraryPayload() {
  const lib = readLibrary(dataDir);
  return {
    ok: true,
    current: lib.current,
    books: lib.books.map((b) => {
      const live = stores.get(b.id);
      return { ...b, people: live ? live.info().people : b.people };
    }),
  };
}

/** 把某本谱的当前内容打包成 bootstrap 形状（启动和切换共用） */
function bookPayload(store, book) {
  const ds = store.readDataset();
  return {
    ok: true,
    error: null,
    json: ds ? JSON.stringify(ds) : null,   // 空库给 null，交给上层走首次运行分支
    info: { ...store.info(), book: { id: book.id, name: book.name } },
  };
}

/**
 * 切到另一本谱。
 *
 * ⚠️ 切之前必须先把当前这本落盘：`commit()` 是乐观的异步写入，
 *    直接切会让最后一次编辑连同 switched book 一起丢失。
 */
async function switchBook(id) {
  const prev = currentStore();
  if (prev && id !== currentId) {
    try { prev.persist(); } catch (e) { console.warn('[lib] 切谱前落盘失败：', e?.message || e); }
  }

  const s = await ensureStore(id);
  currentId = id;

  const r = setCurrent(dataDir, id);
  if (!r.ok) return r;
  library = r.library;

  const lib = readLibrary(dataDir);
  const book = lib.books.find((b) => b.id === id) || currentBook(dataDir, lib);
  return bookPayload(s, book);
}

/* ========================================================= */
/* IPC                                                         */
/* ========================================================= */

function registerIpc() {
  /** 启动同步取数据（preload 用 sendSync 调它） */
  ipcMain.on('db:bootstrap', (event) => {
    let payload = { ok: false, error: 'store not ready', json: null, info: null };
    try {
      const s = currentStore();
      if (!s) throw new Error('谱还没有打开');
      const lib = readLibrary(dataDir);
      const book = lib.books.find((b) => b.id === currentId) || { id: currentId, name: '' };
      payload = { ...bookPayload(s, book), library: libraryPayload() };
    } catch (e) {
      payload = { ok: false, error: String(e?.message || e), json: null, info: null };
    }
    event.returnValue = payload;
  });

  ipcMain.handle('db:write', (_e, json) => {
    const s = currentStore();
    if (!s) return { ok: false, error: '谱还没有打开' };
    try {
      const ds = JSON.parse(json);
      const r = s.writeDataset(ds);
      // 人数变了，列表上得跟着变
      if (r?.ok) { try { setPeopleCount(dataDir, currentId, s.info().people); } catch { /* ignore */ } }
      return r;
    } catch (e) {
      return { ok: false, error: '数据解析失败：' + (e?.message || e) };
    }
  });

  ipcMain.handle('db:clear', () => {
    const s = currentStore();
    if (!s) return { ok: false, error: '谱还没有打开' };
    const r = s.clearAll();
    if (r?.ok) { try { setPeopleCount(dataDir, currentId, 0); } catch { /* ignore */ } }
    return r;
  });

  ipcMain.handle('db:info', () => {
    const s = currentStore();
    return s ? s.info() : { ok: false, error: '谱还没有打开' };
  });

  /* ---------------- 族谱库（多本谱） ---------------- */

  ipcMain.handle('lib:list', () => libraryPayload());

  /** 新建一本谱。seed 是一份数据集 JSON 字符串（可选）—— 由渲染层给出，
      主进程不认识 SAMPLE_DATA，也不该认识（那是渲染层的资产）。 */
  ipcMain.handle('lib:create', async (_e, { name, seed } = {}) => {
    const made = createBook(dataDir, name);
    if (!made.ok) return made;

    const s = await ensureStore(made.book.id);
    if (seed) {
      try {
        const r = s.writeDataset(JSON.parse(seed));
        if (r && r.ok === false) return { ok: false, error: r.error, book: made.book };
      } catch (e) {
        return { ok: false, error: '种子数据写入失败：' + (e?.message || e), book: made.book };
      }
    } else {
      /* 空白谱也必须打上 seeded 标记。
         ⚠️ 不打会怎样：readDataset() 靠它区分「全新库 → 灌示例」和
         「用户清空 → 保持为空」（见 db.js 的 META_SEEDED 注释）。
         新建一本空白谱如果没这个标记，重启示例家族就回来了，
         等于「新建」这个动作直接失灵。 */
      s.writeDataset({ version: '1.0', viewpoint: '', people: [], relationships: [] });
    }

    /* 建完就切过去 —— 用户新建一本谱，想的就是「现在我要填它」，
       不是「藏在列表里待会儿再说」。 */
    const payload = await switchBook(made.book.id);
    return { ...payload, book: made.book, library: libraryPayload() };
  });

  ipcMain.handle('lib:switch', async (_e, { id } = {}) => {
    if (!id) return { ok: false, error: '没有指定谱' };
    try {
      const payload = await switchBook(id);
      if (payload.ok === false) return payload;
      return { ...payload, library: libraryPayload() };
    } catch (e) {
      return { ok: false, error: '切换失败：' + (e?.message || e) };
    }
  });

  ipcMain.handle('lib:rename', (_e, { id, name } = {}) => {
    const r = renameBook(dataDir, id, name);
    if (!r.ok) return r;
    return { ok: true, book: r.book, library: libraryPayload() };
  });

  ipcMain.handle('lib:remove', async (_e, { id } = {}) => {
    const r = deleteBook(dataDir, id);
    if (!r.ok) return r;

    // 被删的正是当前这本 → 必须立刻切到剩下的那一本，否则 db:* 会打空
    if (id === currentId) {
      stores.delete(id);
      const next = currentBook(dataDir, r.library);
      if (!next) return { ok: false, error: '没有谱可用了' };
      try {
        const payload = await switchBook(next.id);
        if (payload.ok === false) return payload;
        return { ...payload, library: libraryPayload() };
      } catch (e) {
        return { ok: false, error: '切换失败：' + (e?.message || e) };
      }
    }

    stores.delete(id);
    return { ok: true, library: libraryPayload() };
  });

  /** 导出：系统「另存为」对话框 */
  ipcMain.handle('db:export', async (_e, { json, suggestedName } = {}) => {
    const name = suggestedName || defaultExportName();
    const book = currentBook(dataDir, readLibrary(dataDir));
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出族谱数据',
      defaultPath: path.join(book ? bookDir(dataDir, book.id) : dataDir, name),
      filters: [{ name: '族谱数据 (JSON)', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(filePath, json, 'utf-8');
      return { ok: true, path: filePath };
    } catch (e) {
      return { ok: false, error: '写文件失败：' + (e?.message || e) };
    }
  });

  /**
   * 导出图片：系统「另存为」对话框 + 把 base64 写回 PNG。
   *
   * dataUrl 是渲染层用 html2canvas 生成的 `data:image/png;base64,...`。
   * ⚠️ 解码前一定要校验前缀：base64 串里出现别的内容时，Buffer.from
   * 不会报错，只会写出一个损坏的 PNG，用户拿到的是「双击打不开」。
   */
  ipcMain.handle('db:export-image', async (_e, { dataUrl, suggestedName } = {}) => {
    const name = suggestedName || '家族谱.png';
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) return { ok: false, error: '图片数据不对（不是 PNG）' };

    const book = currentBook(dataDir, readLibrary(dataDir));
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出族谱图片',
      defaultPath: path.join(book ? bookDir(dataDir, book.id) : dataDir, name),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(filePath, Buffer.from(m[1], 'base64'));
      return { ok: true, path: filePath };
    } catch (e) {
      return { ok: false, error: '写文件失败：' + (e?.message || e) };
    }
  });

  /** 导入：系统「打开」对话框 */
  ipcMain.handle('db:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '导入族谱数据',
      defaultPath: dataDir,
      properties: ['openFile'],
      filters: [{ name: '族谱数据 (JSON)', extensions: ['json'] }],
    });
    if (canceled || !filePaths?.length) return { ok: false, canceled: true };
    try {
      const text = fs.readFileSync(filePaths[0], 'utf-8');
      return { ok: true, json: text, name: path.basename(filePaths[0]), path: filePaths[0] };
    } catch (e) {
      return { ok: false, error: '读文件失败：' + (e?.message || e) };
    }
  });

  ipcMain.handle('app:open-data-dir', async () => {
    // 打开**当前这本谱**的目录（里面就是它的 genogram.db 和 photos），
    // 比打开根目录更贴合「我要备份这本谱」的真实意图。
    const dir = currentId ? bookDir(dataDir, currentId) : dataDir;
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true, path: dir };
  });

  /* ---------------- 照片（F12） ----------------
     一律走**当前这本谱**的 photos/ 目录。删除 / 读取的路径安全性
     由 photoStore 的 assertInside 把守（挡 `..\` 逃逸与脏数据）。 */

  /** 当前谱的 photos 目录；没开谱时 null */
  const photoDir = () => {
    if (!currentId) return null;
    const dir = photosDir(bookDir(dataDir, currentId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  /** 添加：系统多选对话框 → 复制 + 校验 + 缩略图（photoStore.addPhotos） */
  ipcMain.handle('photo:add', async (_e, { personId } = {}) => {
    const dir = photoDir();
    if (!dir) return { ok: false, error: '谱还没有打开' };
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择照片（可多选）',
      defaultPath: dir,
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }],
    });
    if (canceled || !filePaths?.length) return { ok: false, canceled: true };
    return addPhotos(dir, personId, filePaths, nativeImage);
  });

  /** 读方形缩略图（头像 / 网格格都用它）。
   *  旧版缩略图是「等比缩放」不是「方形裁切」→ 读的时候就地重生成（见 photoStore.squareThumb）。 */
  ipcMain.handle('photo:thumb', (_e, { name }) => {
    const dir = photoDir();
    return dir ? squareThumb(dir, name, nativeImage) : { ok: false, error: '谱还没有打开' };
  });

  /** 读原图 */
  ipcMain.handle('photo:original', (_e, { name }) => {
    const dir = photoDir();
    return dir ? readDataUrl(dir, name, false) : { ok: false, error: '谱还没有打开' };
  });

  /** 删（连缩略图；EPERM 进 errors，调用方保留数据库引用） */
  ipcMain.handle('photo:remove', (_e, { names }) => {
    const dir = photoDir();
    return dir ? removePhotos(dir, names) : { ok: false, error: '谱还没有打开' };
  });

  /** 批量读（导出「包含照片」用；缺失进 missing） */
  ipcMain.handle('photo:readMany', (_e, { names }) => {
    const dir = photoDir();
    return dir ? readMany(dir, names) : { ok: false, error: '谱还没有打开' };
  });

  /** 批量查存在性（导入后报「缺失数」用；不读文件内容，只 stat） */
  ipcMain.handle('photo:exists', (_e, { names }) => {
    const dir = photoDir();
    if (!dir) return { ok: false, error: '谱还没有打开' };
    const existing = [];
    for (const n of names || []) {
      try {
        if (isValidPhotoName(n) && fs.existsSync(path.join(dir, n))) existing.push(n);
      } catch { /* 单个名字有问题不影响其他 */ }
    }
    return { ok: true, existing };
  });

  /** 恢复内联照片（导入用；已存在跳过，不覆盖） */
  ipcMain.handle('photo:restore', (_e, { map }) => {
    const dir = photoDir();
    return dir ? restoreMap(dir, map) : { ok: false, error: '谱还没有打开' };
  });

  /* 弹窗打开 / 关闭 → 禁用 / 恢复那些会捣乱的原生菜单项。
     accelerator 拦在原生层，渲染层的 keydown 守卫管不到它们，只能主进程出手。 */
  ipcMain.on('ui:editing', (_e, on) => setEditingMode(!!on));
}

/* ========================================================= */
/* 菜单                                                        */
/* ========================================================= */

/**
 * 弹窗（编辑成员 / 添加亲属 / 关于）打开时必须禁用的菜单项。
 *
 * ⚠️ 为什么渲染层拦不住（2026-10-09 修复）：
 *   accelerator 是**原生菜单**在 Windows 的 accelerator 表里处理的，
 *   优先级高于网页层的 keydown —— 渲染层根本收不到这些按键，
 *   也就没法 preventDefault。所以在编辑途中按 Ctrl+S 会真的弹出系统「另存为」
 *   （主进程模态，整个窗口失活，看起来就像「界面卡死、改不动了」），
 *   Ctrl+N 会弹出一个新窗盖掉正在填的表单。
 *
 *   已实测确认裸键 accelerator 本身不抢输入框的字母（见 tests/acc-input.test.js），
 *   所以这里只需要处理带 Ctrl 的这几个。
 */
const EDITING_BLOCKED = [
  'mi-add', 'mi-import', 'mi-export', 'mi-export-image', 'mi-clear',
  'mi-view-tree', 'mi-view-check', 'mi-fit', 'mi-to-me', 'mi-devtools', 'mi-zoom-in', 'mi-zoom-out', 'mi-zoom-reset',
  'mi-reload',
  // v0.2.24：多谱切换同样会在弹窗编辑时把上层内容整个换掉
  'mi-book-new', 'mi-book-rename', 'mi-book-delete',
];

/** 切到/离开编辑态：禁用那些会捣乱的菜单项 */
function setEditingMode(on) {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  for (const id of EDITING_BLOCKED) {
    const item = menu.getMenuItemById(id);
    if (item) item.enabled = !on;
  }
}

function buildMenu() {
  const send = (action) => () => win?.webContents.send('menu:action', action);

  const template = [
    {
      label: '文件',
      submenu: [
        { id: 'mi-add', label: '添加成员', accelerator: 'CmdOrCtrl+N', click: send('add') },
        { type: 'separator' },
        /* v0.2.24：多本谱。三项的**真正实现都在渲染层**（那里才知道
           现在有几本谱、要不要二次确认），菜单只发动作名 —— 与既有惯例一致。 */
        { id: 'mi-book-new', label: '新建族谱…', click: send('book-new') },
        { id: 'mi-book-rename', label: '重命名本谱…', click: send('book-rename') },
        { id: 'mi-book-delete', label: '删除本谱…', click: send('book-delete') },
        { type: 'separator' },
        { id: 'mi-import', label: '导入数据…', accelerator: 'CmdOrCtrl+O', click: send('import') },
        { id: 'mi-export', label: '导出数据…', accelerator: 'CmdOrCtrl+S', click: send('export') },
        /* v0.2.63 导出图片（PNG）。与「导出数据」刻意分开，而且**不给快捷键**：
           Ctrl+S 是本软件唯一的备份途径，再挂一个形似的组合键，按错一次
           就以为备份过了 —— 这种错没人会发现，直到需要备份那天。 */
        { id: 'mi-export-image', label: '导出图片…', click: send('export-image') },
        { type: 'separator' },
        {
          label: '打开本谱目录',
          click: () => shell.openPath(currentId ? bookDir(dataDir, currentId) : dataDir),
        },
        { type: 'separator' },
        /* 危险操作：真正的二次确认在渲染层做（那里才知道有多少人、
           也才能提示先导出备份）。菜单只负责发动作名，保持只有一处实现。 */
        { id: 'mi-clear', label: '清空全部数据…', click: send('clear') },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { id: 'mi-view-tree', label: '家谱树', accelerator: 'CmdOrCtrl+1', click: send('view-tree') },
        { id: 'mi-view-check', label: '数据体检', accelerator: 'CmdOrCtrl+2', click: send('view-check') },
        { type: 'separator' },
        { id: 'mi-fit', label: '适应窗口', accelerator: 'F', click: send('fit') },
        { id: 'mi-to-me', label: '回到当前视角（我居中 · 100%）', accelerator: 'V', click: send('to-me') },
        { type: 'separator' },
        { id: 'mi-zoom-in', label: '放大', role: 'zoomIn' },
        { id: 'mi-zoom-out', label: '缩小', role: 'zoomOut' },
        { id: 'mi-zoom-reset', label: '重置缩放', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
        /* 重新加载（Ctrl+R）。为什么必须有这一项：Electron 里 Ctrl+R/F5 这类
           浏览器快捷键是靠菜单的 accelerator 表分发的 —— 自定义菜单不登记
           reload，这个组合键就是空的（F12 好使是因为上面明确写了）。
           开发期改完渲染层代码，不用重启进程，Ctrl+R 就能拿到新代码。
           编辑弹窗打开时同样禁用（见 EDITING_BLOCKED）：半截表单被刷掉最恼人。 */
        { id: 'mi-reload', label: '重新加载', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { id: 'mi-devtools', label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '数据与隐私',
          click: send('about'),
        },
        { type: 'separator' },
        {
          label: '数据库位置',
          click: () => {
            const lib = readLibrary(dataDir);
            const book = lib.books.find((b) => b.id === currentId) || currentBook(dataDir, lib);
            const dir = book ? bookDir(dataDir, book.id) : dataDir;
            return dialog.showMessageBox(win, {
              type: 'info',
              title: '数据库位置',
              message: '数据只存在你自己的硬盘上',
              detail: [
                `当前谱：${book?.name || '（未知）'}`,
                `数据库：${path.join(dir, 'genogram.db')}`,
                `照片目录：${photosDir(dir)}`,
                `每日备份：${path.join(dir, 'backups')}`,
                '',
                `一共 ${lib.books.length} 本谱，各自独立存放于 ${path.join(dataDir, 'books')}`,
                '不上传、不联网。整份备份 = 直接拷贝对应谱的文件夹。',
              ].join('\n'),
              buttons: ['打开文件夹', '知道了'],
              defaultId: 1,
            }).then((r) => { if (r.response === 0) shell.openPath(dir); });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function defaultExportName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `家族谱-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
}
