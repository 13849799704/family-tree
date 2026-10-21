/**
 * =========================================================
 * 渲染层 ↔ 主进程 桥 · electron/preload.cjs
 * ---------------------------------------------------------
 * 安全模型（Electron 官方推荐的那套）：
 *   contextIsolation: true + nodeIntegration: false
 *   → 页面里没有 require / fs / process，只有一个我们精心挑选的 API 对象。
 *   preload 是唯一能同时看到 Node 和页面的地方，所有能力都从这一处白名单出去。
 *
 * ⚠️ 用 .cjs 而不是 .mjs：
 *     package.json 里是 "type": "module"，.js 会被当成 ESM，
 *     而 ESM preload 在 Electron 里限制更多（要求 sandbox:false、加载时机更脆）。
 *     .cjs 后缀永远走 CommonJS，是最省事的路径。
 *
 * 暴露的 API 形状刻意**与旧的 genogramFS 桥一致**（read/write/clear），
 * 这样 store.js 几乎不用改 —— 换存储不动上层，是当初留这个口子的目的。
 * =========================================================
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 启动时**一次性同步**取回整份数据。
 * 为什么同步：src/store.js 的 loadDataset() 是同步函数，而 boot() 也是同步流程。
 * 把这一次启动读盘做成 sendSync，就不用为了「桌面版」把整个启动流程改成 async。
 * 只发生在启动那一瞬，阻塞可以忽略；之后的保存全部走异步 invoke。
 *
 * v0.2.24：里面多了一个 `library` 字段（谱清单），同样是同步拿到的 ——
 * 渲染层首帧就要显示「当前谱名」，等异步就没必要地复杂了。
 */
let boot = { ok: false, error: 'unknown', json: null, info: null, library: null };
try {
  boot = ipcRenderer.sendSync('db:bootstrap') || boot;
} catch (e) {
  boot = { ok: false, error: String(e && e.message || e), json: null, info: null, library: null };
}

/**
 * 切换 / 新建谱之后，同步缓存必须跟着换。
 *
 * ⚠️ 不这么做会怎样：read() 返回的是**启动那一刻**的数据快照，
 *    切谱后如果缓存不动，下一次 loadDataset() 拿到的还是上一本谱 ——
 *    界面上表现为「切过去了、数据却是旧的」。
 *    这里统一更新，渲染层的同步读路径（loadDataset）依旧成立。
 *
 * ⚠️ 但**只更新 payload 里真的带了的字段**：
 *    lib:rename 只返回 {ok, book, library}，没有 json 也没有 info ——
 *    若无条件照抄，改名之后 boot.json 会被抹成 null，
 *    下一次 loadDataset() 就真的读到「空」了（改个名把家底清空，没比这更糟的）。
 */
function absorb(payload) {
  if (payload && payload.ok) {
    boot = {
      ok: true,
      error: null,
      json: 'json' in payload ? (payload.json ?? null) : boot.json,
      info: payload.info || boot.info,
      library: payload.library || boot.library,
    };
  }
  return payload;
}

contextBridge.exposeInMainWorld('genogramFS', {
  /* ---- 与旧桥同名，store.js 直接复用 ---- */

  /** 同步读：返回 JSON 字符串或 null */
  read: () => (boot.ok ? boot.json : null),

  /** 写：解析成表并落盘。返回 Promise<{ok, error?}> */
  write: (json) => ipcRenderer.invoke('db:write', json),

  /** 清空数据 */
  clear: () => ipcRenderer.invoke('db:clear'),

  /* ---- 桌面版新增 ---- */

  /** 启动信息：{ ok, error, info:{path, people, relationships, bytes, savedAt, ...} } */
  boot: () => ({
    ok: boot.ok,
    error: boot.error,
    info: boot.info || null,
  }),

  /** 当前这本谱 {id, name}；网页版没有这个概念时为 null */
  book: () => (boot.info && boot.info.book ? boot.info.book : null),

  /** 谱清单快照：{ ok, current, books:[{id,name,people,...}] } */
  library: () => (boot.library || null),

  /* ---- v0.2.24：族谱库（多本谱） ----
     主进程侧的实现见 electron/main.js 的 lib:* handler。
     三项「改」操作（create / switch / remove）都会返回新谱的整份数据，
     并由 absorb() 顺手刷新同步缓存 —— 渲染层无需再单独读一次。 */
  bookLib: {
    /** 清单 + 各谱人数 */
    list: () => ipcRenderer.invoke('lib:list'),

    /** 新建并切过去。seed = 数据集 JSON 字符串（可选，用于「从示例/导入起步」） */
    create: async ({ name, seed } = {}) => absorb(await ipcRenderer.invoke('lib:create', { name, seed })),

    /** 切换。返回 {ok, json, info, library} */
    switch: async (id) => absorb(await ipcRenderer.invoke('lib:switch', { id })),

    /** 重命名 */
    rename: async (id, name) => absorb(await ipcRenderer.invoke('lib:rename', { id, name })),

    /** 删除（主进程只挪进 trash，不真删）。删的是当前谱时会自动切到剩下那本 */
    remove: async (id) => absorb(await ipcRenderer.invoke('lib:remove', { id })),
  },

  /** 库信息（人数 / 路径 / 大小 / 上次保存时间） */
  info: () => ipcRenderer.invoke('db:info'),

  /** 用系统「另存为」导出 JSON。返回 {ok, path?, canceled?} */
  exportTo: (json, suggestedName) => ipcRenderer.invoke('db:export', { json, suggestedName }),

  /** 用系统「另存为」导出 PNG。dataUrl 形如 data:image/png;base64,... */
  exportImage: (dataUrl, suggestedName) => ipcRenderer.invoke('db:export-image', { dataUrl, suggestedName }),

  /** 用系统「打开」选 JSON 导入。返回 {ok, json?, name?, canceled?} */
  importFrom: () => ipcRenderer.invoke('db:import'),

  /** 在资源管理器里打开数据目录 */
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),

  /** 告诉主进程「现在正在弹窗里编辑」，让它禁用会捣乱的原生菜单项。
   *  单向通知，没有返回值 —— 只在 overlay 的 .on 类变化时才发。 */
  setEditing: (on) => ipcRenderer.send('ui:editing', !!on),

  /** 让主进程窗口执行菜单动作（适应窗口 / 体检 等） */
  onMenu: (handler) => {
    const wrapped = (_evt, action) => handler(action);
    ipcRenderer.on('menu:action', wrapped);
    return () => ipcRenderer.off('menu:action', wrapped);
  },

  /** 打包信息 */
  versions: {
    app: process.env.npm_package_version || '',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
