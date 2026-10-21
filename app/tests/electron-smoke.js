/**
 * =========================================================
 * 桌面版端到端冒烟测试 · tests/electron-smoke.js
 * ---------------------------------------------------------
 * 跑法：npm run test:e2e
 *   （即 `electron tests/electron-smoke.js`）
 *
 * 它跑的是**真实生产路径**，不 mock 任何东西：
 *   electron/main.js → 建窗 → preload 桥 → IPC → sql.js → 真的 .db 文件
 *
 * 与 tests/e2e.html 的分工：
 *   e2e.html     = 渲染层回归（浏览器里跑，42 项，快）
 *   本文件        = 「装进 Electron 还能不能跑」+「数据真的落进 SQLite 了吗」
 * 前端逻辑细节交给 e2e.html，这里只盯桌面版的接缝。
 *
 * ⚠️⚠️ 本文件**顶端绝对不能有 await** ⚠️⚠️
 *   Electron 用 ESM 作主入口时，要等**入口模块的顶层求值全部结束**
 *   才会发出 `ready` 事件。如果顶层 `await waitForWindow()`，
 *   就变成「等窗口 → 窗口要 ready → ready 要等入口求值完 → 入口在等窗口」，
 *   **自己把自己锁死**，而且没有任何报错，表现就是「窗口永远不出现」。
 *   所以：模块顶层只挂一个 .then()，所有等待都放进普通 async 函数里。
 *   （这个坑我实测踩了一轮：isReady 永远 false，事件循环却是活的。）
 *
 * ⚠️ 数据写在临时目录（GENOGRAM_DATA_DIR），绝不碰用户真实的那份库。
 * =========================================================
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electron from 'electron';
const { app, BrowserWindow } = electron;

/* ---------- 1. 数据目录指向临时沙箱（必须在 import main 之前设置） ---------- */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'genogram_e2e_'));
process.env.GENOGRAM_DATA_DIR = sandbox;
process.env.GENOGRAM_NO_DIALOG = '1';   // 关掉阻塞式错误框（否则测试假死）
process.env.GENOGRAM_DEBUG = '1';       // 打开主进程分步日志

const BOOT_LOG = path.join(sandbox, 'boot.log');
process.env.GENOGRAM_BOOT_LOG = BOOT_LOG;

/* ---------- 2. 极简断言框架 ---------- */

const L = [];
let fails = 0;

const ok = (cond, msg) => {
  if (!cond) fails++;
  L.push((cond ? 'PASS  ' : 'FAIL  ') + msg);
  console.log((cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + msg);
};

const head = (t) => {
  L.push('');
  L.push('=== ' + t + ' ===');
  console.log(`\n\x1b[1m${t}\x1b[0m`);
};

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等窗口出现 */
async function waitForWindow(timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) return w;
    await tick(100);
  }
  throw new Error('20 秒内没有窗口被创建');
}

const dumpBootLog = () => {
  try {
    if (fs.existsSync(BOOT_LOG)) {
      console.error('\n----- 主进程启动日志 -----');
      console.error(fs.readFileSync(BOOT_LOG, 'utf-8').trim());
      console.error('--------------------------');
    }
  } catch { /* 忽略 */ }
};

/* ---------- 3. 主体（普通 async 函数，不是顶层 await） ---------- */

async function runSmoke() {
  let win = null;
  let wc = null;

  try {
    await import('../electron/main.js');   // 这里才真正启动主进程
    win = await waitForWindow();
    wc = win.webContents;
    if (wc.isLoading()) {
      await new Promise((r) => wc.once('did-finish-load', r));
    }
    await tick(2600);   // 等 boot() 跑完、首次示例数据落库
  } catch (e) {
    console.error('\x1b[31m启动阶段失败\x1b[0m', e);
    dumpBootLog();
    app.exit(1);
    return;
  }

  const js = (code) => wc.executeJavaScript(code, true);

  try {
    head('1. 进程与壳');
    ok(win.getTitle().includes('家族谱'), `窗口标题「${win.getTitle()}」`);
    ok(wc.getURL().startsWith('file://'), `通过 file:// 加载本地页面（${wc.getURL().slice(0, 46)}…）`);
    const b = win.getBounds();
    ok(b.width > 0 && b.height > 0, `窗口已布局 ${b.width}x${b.height}`);

    head('2. preload 桥接（contextIsolation 生效下仍能通信）');
    const bridge = await js(`(() => {
      const b = window.genogramFS;
      return b ? {
        hasRead: typeof b.read === 'function',
        hasWrite: typeof b.write === 'function',
        hasInfo: typeof b.info === 'function',
        boot: b.boot(),
        nodeVisible: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
      } : null;
    })()`);
    ok(!!bridge, 'window.genogramFS 已注入');
    ok(!!bridge?.hasRead && !!bridge?.hasWrite && !!bridge?.hasInfo, 'read / write / info 三个方法都在');
    ok(bridge?.boot?.ok === true, `启动同步取数成功（kind=${bridge?.boot?.info?.kind}）`);
    ok(bridge?.boot?.info?.kind === 'sqlite', '存储形态识别为 sqlite（不是 localStorage）');
    ok(bridge?.nodeVisible === false, '页面里看不到 require / process（隔离有效）');

    head('3. 界面渲染（与浏览器版一致）');
    const ui = await js(`(() => {
      const q = (s) => document.querySelector(s);
      const qa = (s) => [...document.querySelectorAll(s)];
      return {
        nodes: qa('.node').length,
        wires: qa('.wires path, .wires line').length,
        chips: qa('.view-tab').length,
        callMain: (q('.call-main')?.textContent || '').trim(),
        zoom: (q('#zoomVal')?.textContent || '').trim(),
      };
    })()`);
    ok(ui.nodes === 20, `主树节点 ${ui.nodes} 个（期望 20）`);
    ok(ui.wires > 10, `连线 ${ui.wires} 条`);
    ok(ui.chips === 3, `家族 chips ${ui.chips} 个`);
    ok(ui.callMain === '我', `视角人面板称谓 = ${ui.callMain}`);
    ok(parseInt(ui.zoom, 10) > 35, `初始缩放 ${ui.zoom}（桌面窗口 1380x880，不该落在 35% 下界）`);

    head('3a. 回到当前视角（我居中 · 100%）');
    /* 用户原话：「刚开的族谱时会找不到自己在哪」。这个动作要同时保证两件事：
       ① 倍率被**定死**成 100%（focusOn 的 zoomTarget 语义是「至少放大到」，不能直接用）；
       ② 视角人真的落在画布正中（不只是改了倍率）。
       「我」的节点 class 是 anchor（不是 is-self，见 tree.js 的 _drawNodes）。 */
    await js(`(() => { document.querySelector('[data-act="to-me"]').click(); return true; })()`);
    await tick(400);      // goToViewpoint 内部 80ms 才开始 setZoom + focusOn，再留出 240ms 过渡
    const me = await js(`(() => {
      const n = document.querySelector('.node.anchor');
      const st = document.getElementById('stage').getBoundingClientRect();
      const r = n ? n.getBoundingClientRect() : null;
      return {
        zoom: (document.getElementById('zoomVal')?.textContent || '').trim(),
        dx: r ? Math.round(r.left + r.width / 2 - st.left - st.width / 2) : -999,
        dy: r ? Math.round(r.top + r.height / 2 - st.top - st.height / 2) : -999,
      };
    })()`);
    ok(me.zoom === '100%', `倍率被定成 ${me.zoom}（期望 100%，不是「至少 100%」）`);
    ok(Math.abs(me.dx) <= 12 && Math.abs(me.dy) <= 12,
      `视角人在画布正中（偏移 ${me.dx}, ${me.dy} px，容差 12）`);

    head('3a-2. 家族页里点「回到当前视角」不许跳回主族');
    /* 用户纠正过一次：切到「妻子家族 / 母亲家族」后，这个按钮要在**当前这棵树**里定位，
       0.2.52 初版却 `setFamily('main')`，把他刚做的切族操作直接作废了。
       这里只守一条：切到哪棵树，就还停在哪棵树（具体定位到谁由「我」在不在那棵树决定）。 */
    const famKey = await js(`(() => {
      const t = document.querySelectorAll('.view-tab')[1];
      if (!t) return '';
      t.click();
      return t.dataset.family || '';
    })()`);
    ok(!!famKey && famKey !== 'main', `已切到第 2 个家族：${famKey || '(没有第二个家族)'}`);
    await tick(200);
    await js(`(() => { document.querySelector('[data-act="to-me"]').click(); return true; })()`);
    await tick(400);
    const after = await js(`(() => {
      const on = document.querySelector('.view-tab.on');
      const n = document.querySelector('.node.sel');
      const st = document.getElementById('stage').getBoundingClientRect();
      const r = n ? n.getBoundingClientRect() : null;
      return {
        key: on ? on.dataset.family : '',
        zoom: (document.getElementById('zoomVal')?.textContent || '').trim(),
        seen: !!(r && r.left < st.right && r.right > st.left && r.top < st.bottom && r.bottom > st.top),
      };
    })()`);
    ok(after.key === famKey, `仍停在「${famKey}」页（实际 ${after.key}，没被拽回主族）`);
    ok(after.zoom === '100%', `家族页里倍率也是 100%（${after.zoom}）`);
    ok(after.seen, '定位到的那个人确实在视野里');
    // 收尾切回主族：后面 3b 的导出范围断言（「只导当前家族 林然的家族」）依赖主族视角
    await js(`(() => { document.querySelector('.view-tab[data-family="main"]').click(); return true; })()`);
    await tick(200);

    head('3b. 导出范围选择弹窗（只导当前家族）');
    /* 弹窗是纯 DOM，单测（core 层，跑在 Node 里）碰不到它。
       这里点开看一眼再按 Esc 关掉 —— 绝不点「导出」，
       那会拉起系统的另存为框把整个测试卡住。
       点开是同步的：doExport 里 exportScopeDialog 先把 DOM 铺出来才 await。 */
    await js(`(() => { document.querySelector('[data-act="export"]').click(); return true; })()`);
    const dlg = await js(`(() => {
      const m = document.querySelector('.modal[aria-label="导出范围"]');
      if (!m) return { on: false };
      const txt = (k) => (m.querySelector('[data-pick="' + k + '"]')?.textContent || '')
        .replace(/\\s+/g, ' ').trim();
      return { on: true, all: txt('all'), tree: txt('tree') };
    })()`);
    ok(dlg.on, '点「导出」弹出范围选择框');
    ok(/全部成员/.test(dlg.all || ''), `第一张卡片是「全部成员」：${dlg.all}`);
    ok(/只导当前家族/.test(dlg.tree || ''), `第二张卡片是「只导当前家族」：${dlg.tree}`);
    /* 主树 20 人（上面 ui.nodes 数过同一棵树），卡片上的数字必须对得上，
       否则用户是照着一个错数字决定要不要把文件发出去的。 */
    ok(new RegExp(`只导当前家族.*${ui.nodes} 人`).test(dlg.tree || ''),
      `「只导当前家族」的人数 = 当前树人数 ${ui.nodes}：${dlg.tree}`);
    /* 它必须讲清楚「排除了谁」—— 这是隐私取舍，只有数字是不够的 */
    ok(/不含/.test(dlg.tree || ''), `卡片写明了排除了谁：${dlg.tree}`);

    await js(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    })()`);
    /* close() 是先摘 overlay.on、220ms 后才清 innerHTML（弹层淡出动画）。
       所以「关掉了」看 class，「DOM 清干净了」得等一下再看 ——
       同一次求值里查两件事会把动画当成 bug。 */
    ok(await js(`!document.getElementById('overlay').classList.contains('on')`),
      'Esc 能关掉弹窗（取消不会去拉另存为框）');
    await tick(320);
    ok(await js(`!document.querySelector('.modal[aria-label="导出范围"]')`),
      '淡出结束后弹窗 DOM 已清干净');

    head('3c. 「只显示姓名」开关（默认关 = 与以前一模一样）');
    /* 这是纯 DOM + localStorage 的显示偏好，core 层单测覆盖不到「按钮点了会怎样」。
       真 Electron 里点一遍，顺便守住两件容易退化的事：
         ① 默认必须是「显示称谓」，不能因为加了开关就把老用户的大字弄没了；
         ② 关掉只改显示，称谓一个字都不许少（切回来要逐字相同）。 */
    const base = await js(`(() => {
      const b = document.getElementById('callToggle');
      const n = document.querySelector('.node.anchor');
      return {
        hasBtn: !!b,
        pressed: b ? b.getAttribute('aria-pressed') : null,
        on: b ? b.classList.contains('on') : null,
        call: n?.querySelector('.node-call')?.textContent.trim() || '',
        name: n?.querySelector('.node-name')?.textContent.trim() || '',
      };
    })()`);
    ok(base.hasBtn, '顶栏有「只显示姓名」按钮');
    ok(base.pressed === 'false' && base.on === false, `默认是关的（aria-pressed=${base.pressed}）`);
    ok(base.call === '我' && !!base.name, `默认卡片是「称谓 ${base.call}」+ 小字「${base.name}」`);

    /* 关掉：卡片大字换成姓名，小字不再重复；面板只剩姓名 */
    await js(`(() => { document.getElementById('callToggle').click(); return true; })()`);
    await tick(220);
    const off = await js(`(() => {
      const b = document.getElementById('callToggle');
      const n = document.querySelector('.node.anchor');
      n?.click();
      return {
        pressed: b.getAttribute('aria-pressed'),
        on: b.classList.contains('on'),
        call: n?.querySelector('.node-call')?.textContent.trim() || '',
        hasSmall: !!n?.querySelector('.node-name'),
        unknownCards: document.querySelectorAll('.node-call.unknown').length,
        main: document.querySelector('.call-main')?.textContent.trim() || '',
        hasStd: !!document.querySelector('.call-std'),
        hasPath: !!document.querySelector('.call-path'),
        hasChain: !!document.querySelector('.rel-chain'),
        father: document.querySelector('.panel-body .field .v a')?.textContent.trim() || '',
        pref: localStorage.getItem('genogram.ui.v1') || '',
      };
    })()`);
    ok(off.pressed === 'true' && off.on, '点一下就切到「只显示姓名」（高亮 + 实心点）');
    ok(off.call === base.name, `卡片大字 = 姓名「${off.call}」`);
    ok(!off.hasSmall, '原来那行姓名小字不再重复画');
    ok(off.unknownCards === 0, '全部卡片都不再挂「关系待确认」的样式');
    ok(off.main === base.name, `面板大字 = 姓名「${off.main}」`);
    ok(!off.hasStd && !off.hasPath && !off.chain, '标准称呼 / 推导路径 / 称谓推导整块都藏起来了');
    ok(off.father === '林志远', `父亲行只剩姓名：${off.father}`);
    ok(/"showCall":false/.test(off.pref), `偏好存到本机：${off.pref}`);

    /* 再点回来：必须逐字恢复（称谓还在，没被开关改掉） */
    await js(`(() => { document.getElementById('callToggle').click(); return true; })()`);
    await tick(220);
    const back = await js(`(() => {
      const b = document.getElementById('callToggle');
      const n = document.querySelector('.node.anchor');
      n?.click();
      return {
        pressed: b.getAttribute('aria-pressed'),
        call: n?.querySelector('.node-call')?.textContent.trim() || '',
        hasSmall: !!n?.querySelector('.node-name'),
        main: document.querySelector('.call-main')?.textContent.trim() || '',
        hasChain: !!document.querySelector('.rel-chain'),
      };
    })()`);
    ok(back.pressed === 'false', '再点一下回到默认态');
    ok(back.call === base.call && back.main === base.call, `称谓逐字恢复：「${back.call}」`);
    ok(back.hasSmall && back.hasChain, '姓名小字与称谓推导都回来了');

    head('4. 数据真的落进 SQLite 了吗（读文件，不看内存）');
    const { GenogramStore } = await import('../electron/db.js');
    // 期望值从示例数据本身算出来，别写死数字（写死的迟早和样本对不上）
    const { SAMPLE_DATA } = await import('../src/data/sample.js');
    const { normalizeDataset } = await import('../src/core/model.js');
    const expect = normalizeDataset(SAMPLE_DATA);

    /* v0.2.24：库不再直接躺在数据根目录下，而是 books/<id>/genogram.db。
       这里用清单去问「当前谱在哪」，而不是写死路径 ——
       应用那里也是同一套函数决定的。 */
    const { bookDir: bDir } = await import('../electron/paths.js');
    const { ensureLibrary } = await import('../electron/library.js');
    const activeDir = bDir(sandbox, ensureLibrary(sandbox).book.id);

    const fresh = await GenogramStore.open(activeDir);
    const onDisk = fresh.readDataset();
    const diskInfo = fresh.info();
    ok(diskInfo.people === expect.people.length,
       `磁盘上 people 表 ${diskInfo.people} 行（示例数据 ${expect.people.length} 人）`);
    ok(diskInfo.relationships === expect.relationships.length,
       `磁盘上 relationships 表 ${diskInfo.relationships} 行（示例 ${expect.relationships.length} 条）`);
    ok(!!onDisk && onDisk.people.length === expect.people.length,
       `readDataset() 能还原出 ${expect.people.length} 人`);
    const meRow = fresh.selectAll('SELECT id, name, sex FROM people WHERE id = ?', ['p_me'])[0];
    ok(meRow?.name === '林然' && meRow?.sex === 'M', `直接 SQL 查表拿到「${meRow?.name}」`);
    const magic = fs.readFileSync(path.join(activeDir, 'genogram.db')).subarray(0, 15).toString('latin1');
    ok(magic === 'SQLite format 3', '文件头是标准 SQLite 格式（第三方工具可直接打开）');
    fresh.close();

    head('5. 界面操作 → 落库（表单 → IPC → 表 → 落盘）');
    const before = diskInfo.people;
    await js(`document.querySelector('[data-act="add"]').click()`);
    await tick(500);
    ok(await js(`!!document.querySelector('.modal') && !!document.querySelector('#f-name')`), '录入弹窗打开');

    await js(`(() => {
      document.querySelector('#f-name').value = '桌面版测试员';
      document.querySelector('[data-sex="F"]').click();
      document.querySelector('#f-birth').value = '1990';
      document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await tick(900);   // 等异步写库

    const fresh2 = await GenogramStore.open(activeDir);
    const added = fresh2.selectAll('SELECT id, name, sex, birth FROM people WHERE name = ?', ['桌面版测试员']);
    const afterInfo = fresh2.info();
    ok(added.length === 1, `表里查到了新录入的人（${added.length} 行）`);
    ok(added[0]?.sex === 'F', `性别列写对 = ${added[0]?.sex}`);
    ok(added[0]?.birth === '1990', `出生列写对 = ${added[0]?.birth}`);
    ok(afterInfo.people === before + 1, `people 行数 ${before} → ${afterInfo.people}`);
    fresh2.close();

    head('6. 重开数据库后数据还在（真持久化，不是内存幻觉）');
    const fresh3 = await GenogramStore.open(activeDir);
    ok(fresh3.selectAll('SELECT name FROM people WHERE name = ?', ['桌面版测试员']).length === 1,
       '重新打开数据库，刚才录的人仍在该文件里');
    fresh3.close();

    head('7. 主进程菜单 → 渲染层动作');
    wc.send('menu:action', 'view-check');
    await tick(500);
    ok(await js(`document.querySelector('#viewCheck').classList.contains('on')`), '菜单「数据体检」切到体检视图');
    wc.send('menu:action', 'view-tree');
    await tick(400);
    ok(await js(`document.querySelector('#viewTree').classList.contains('on')`), '菜单「家谱树」切回树视图');
    wc.send('menu:action', 'fit');
    await tick(400);
    const fitZoom = await js(`document.querySelector('#zoomVal').textContent.trim()`);
    ok(/^\d+%$/.test(fitZoom), `菜单「适应窗口」执行成功（当前 ${fitZoom}）`);

    head('8. 错误提示区应当是干净的');
    // app.js 有运行时错误兜底：未捕获异常会在 toast 区冒出来。直接读这个「错误出口」。
    const toastText = await js(`document.querySelector('#toastWrap').textContent.trim().replace(/\\s+/g, ' ')`);
    ok(!/Uncaught|Error|错误|失败|undefined/i.test(toastText), `toast 区内容：${toastText || '（空，符合预期）'}`);

    head('9. 导出图片（依赖就位 → 弹窗 → 出图）');
    ok(await js(`typeof html2canvas === 'function'`), 'html2canvas 已随页面加载（导出图片全靠它）');

    wc.send('menu:action', 'export-image');
    await tick(600);
    ok(await js(`!!document.querySelector('[aria-label="导出图片"]')`), '菜单「导出图片…」打开了确认弹窗');
    const imgDlg = await js(`(document.querySelector('.modal')||{}).textContent || ''`);
    ok(/\d+\s*×\s*\d+\s*像素/.test(imgDlg),
       `弹窗给出了两档清晰度的实际像素尺寸（实得：${imgDlg.slice(0, 50).replace(/\s+/g, ' ')}…）`);
    ok(/姓名/.test(imgDlg) && /婚配/.test(imgDlg),
       '弹窗讲清楚了图上有什么（隐私取舍要说在前面，不能只字不提）');

    /* 取消不得污染现场：导出是「把现在这份原样拿走」，不该动用户的视图 */
    const zoomBefore = await js(`document.querySelector('#zoomVal').textContent.trim()`);
    const nodeBefore = await js(`document.querySelectorAll('#canvas .node').length`);
    await js(`document.querySelector('[data-img="cancel"]').click()`);
    await tick(500);
    ok(await js(`!document.querySelector('.modal')`), '取消后弹窗关闭');
    ok(await js(`document.querySelectorAll('#canvas .node').length`) === nodeBefore, '节点数没变（导出没动数据）');
    ok(await js(`document.querySelector('#zoomVal').textContent.trim()`) === zoomBefore,
       `缩放倍率没被改（仍是 ${zoomBefore}）`);

    /* 出图本身。
       ⚠️ 这里**不走完整链路**：最后一步是系统「另存为」，那个模态框会把
         测试挂死（GENOGRAM_NO_DIALOG 只关错误框，不管另存为）。
         只验最要紧的一环 —— html2canvas 在真 Electron 里能拍出合法 PNG。
         克隆的几步照抄 tree.js 的 mountExportSnapshot（同样清 id / tabindex、
         同样补负坐标落点），所以那几个坑顺带也被钉住了。 */
    const shot = await js(`(async () => {
      const src = document.getElementById('canvas');
      const cnt = () => ({
        sel: src.querySelectorAll('.node.sel').length,
        anchor: src.querySelectorAll('.node.anchor').length,
      });
      const before = cnt();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of src.querySelectorAll('.node')) {
        const x = parseFloat(n.style.left) || 0, y = parseFloat(n.style.top) || 0;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + n.offsetWidth); maxY = Math.max(maxY, y + n.offsetHeight);
      }
      const PAD = 32;
      const W = Math.ceil(maxX - minX) + PAD * 2;
      const H = Math.ceil(maxY - minY) + PAD * 2;
      const root = document.createElement('div');
      root.style.cssText = 'position:fixed;left:0;top:0;z-index:-99999;background:#fff;'
        + 'width:' + W + 'px;height:' + H + 'px;';
      const clone = src.cloneNode(true);
      clone.removeAttribute('id');
      clone.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
      clone.querySelectorAll('[tabindex]').forEach((e) => e.removeAttribute('tabindex'));

      /* ★ 与 tree.js 的 mountExportSnapshot 同步（三类都别漏）：
         ① 角标（「展开」/「待补」）+ 视角人「我」标记 —— 静态图里点不动、第一人称也没意义；
         ② 选中/视角光晕 —— 别人看的图里没有「你刚点了谁」。 */
      const hadFlag = clone.querySelectorAll('.anchor-flag').length;
      const removedTags = clone.querySelectorAll('.tag-expand, .tag-todo').length;
      clone.querySelectorAll('.anchor-flag, .tag-expand, .tag-todo').forEach((e) => e.remove());
      const leftFlag = clone.querySelectorAll('.anchor-flag').length;
      let interactive = 0;
      clone.querySelectorAll('.node.sel, .node.anchor').forEach((e) => {
        e.classList.remove('sel', 'anchor');
        interactive++;
      });

      /* ★ 与 tree.js 的 mountExportSnapshot 同步（v0.2.71）：导出的图**一律
         不显示称呼** —— 卡片大字位改写成姓名、小字姓名行删掉。
         姓名从「小字姓名行」本身取：屏幕上开着称谓时，那行就是标准答案，
         不用在测试里再引一次数据集。 */
      const screenCallBefore = [...src.querySelectorAll('.node')]
        .map((n) => n.querySelector('.node-call')?.textContent.trim() || '').join('|');
      let rewritten = 0, callLeaked = 0, smallLeft = 0, unknownLeft = 0;
      for (const n of clone.querySelectorAll('.node')) {
        const callEl = n.querySelector('.node-call');
        const nameEl = n.querySelector('.node-name');
        const name = nameEl ? nameEl.textContent.trim() : '';
        const call = callEl ? callEl.textContent.trim() : '';
        if (callEl && name && name !== call) {
          callEl.textContent = name;
          callEl.classList.remove('unknown');
          callEl.classList.add('node-call-name');
          rewritten++;
        }
        if (callEl && name && callEl.textContent.trim() !== name) callLeaked++;
        if (n.querySelector('.node-name')) smallLeft++;
        if (clone.querySelectorAll('.node-call.unknown').length) unknownLeft++;
      }
      const screenCallAfter = [...src.querySelectorAll('.node')]
        .map((n) => n.querySelector('.node-call')?.textContent.trim() || '').join('|');
      clone.style.transform = 'none';
      clone.style.transition = 'none';
      clone.style.left = (PAD - minX) + 'px';
      clone.style.top = (PAD - minY) + 'px';
      root.appendChild(clone);

      /* ★ 与 tree.js 的 mountExportSnapshot 同步：家族页导出时，
         配色要按「该页锚点」重算（分享是客观呈现，不替谁划分立场）。
         屏幕上分毫不动 —— 下面会拿原画布的配色对拍验证这一点。 */
      const before2 = src.querySelectorAll('.node.paternal, .node.maternal, .node.affinal').length;
      const kinMod = await import('./src/core/kinship.js');
      const modelMod = await import('./src/core/model.js');
      const famMod = await import('./src/core/family.js');
      /* ⚠️ genogramFS.read() 是**启动那一刻的快照**；e2e 启动时示例数据还没灌进去，
         read() 可能是 null，直接 JSON.parse 会炸。 */
      const sampleMod = await import('./src/data/sample.js');
      const dsx = modelMod.withResolvedGen(modelMod.normalizeDataset(
        JSON.parse(JSON.stringify(sampleMod.SAMPLE_DATA))));
      const mainTree = famMod.buildMainTree(dsx, dsx.viewpoint);
      const exList = famMod.detectExpandableFamilies(dsx, mainTree);
      const ANCHOR = exList.length ? exList[0].anchorId : '';
      const MAP = { direct: 'paternal', paternal: 'paternal', maternal: 'maternal', affinal: 'affinal' };
      let paletteChanged = 0;
      if (ANCHOR) {
        const k2 = kinMod.deriveAllKinships(dsx, ANCHOR);
        for (const n of clone.querySelectorAll('.node')) {
          const was = [...n.classList].find((c) => ['paternal', 'maternal', 'affinal'].includes(c));
          const now = MAP[k2.get(n.dataset.id)?.branch] || 'paternal';
          if (was !== now) paletteChanged++;
          n.classList.remove('paternal', 'maternal', 'affinal');
          n.classList.add(now);
        }
      }
      const after2 = src.querySelectorAll('.node.paternal, .node.maternal, .node.affinal').length;

      /* ★ 与 tree.js 的 mountExportSnapshot 同步：内联 SVG 必须先光栅化成 PNG，
         否则 html2canvas 会大面积漏画（婚配线几乎消失、箭头错位）。
         这一步借用浏览器原生渲染，所以和屏幕上看到的一致。 */
      const svgIn = clone.querySelector('svg.wires');
      let rasterised = false;
      if (svgIn) {
        const url = 'data:image/svg+xml;charset=utf-8,'
          + encodeURIComponent(new XMLSerializer().serializeToString(svgIn));
        const im = new Image();
        await new Promise((r) => { im.onload = r; im.onerror = r; im.src = url; });
        im.style.position = 'absolute';
        im.style.left = svgIn.style.left;
        im.style.top = svgIn.style.top;
        im.style.width = svgIn.getAttribute('width') + 'px';
        im.style.height = svgIn.getAttribute('height') + 'px';
        svgIn.replaceWith(im);
        rasterised = im.naturalWidth > 0;
      }
      document.body.appendChild(root);

      /* ★ 与 app.js 的 doExportImage 同步：一律 2x 渲染，1x 再缩小。
         头像那圈投影在 scale=1 时相对更重，会让「标准清晰度」整张图偏暗。 */
      let cv = await html2canvas(root, {
        scale: 2, backgroundColor: '#ffffff', width: W, height: H, logging: false,
      });
      const small = document.createElement('canvas');
      small.width = W; small.height = H;
      small.getContext('2d').drawImage(cv, 0, 0, small.width, small.height);
      cv = small;

      /* 越界自检：有没有卡片被容器切掉 */
      let over = 0;
      const rr = root.getBoundingClientRect();
      for (const n of clone.querySelectorAll('.node')) {
        const b = n.getBoundingClientRect();
        if (b.right - rr.left > W + 0.5 || b.left - rr.left < -0.5) over++;
      }
      const count = clone.querySelectorAll('.node').length;

      /* SVG 的视口属性 + 元素位置（v0.2.64 回归的根因所在） */
      const svg = src.querySelector('svg.wires');
      const svgAttr = {
        w: svg.getAttribute('width'),
        h: svg.getAttribute('height'),
        viewBox: svg.getAttribute('viewBox'),
        left: svg.style.left,
        top: svg.style.top,
        spanW: maxX - minX, spanH: maxY - minY, minX, minY,
      };

      /* 连线**是否真的对上了人**（v0.2.64 回归的判据）。
         ⚠️ 只能查垂直方向：折线起点是**夫妻对的中心**（tree.js 的 unitCenter
         =(父x + 配偶x + 卡宽)/2），本来就不等于任何一张卡片的 x，
         查水平必然误判「全错」。
         垂直方向才是硬的：起点 y 必须正好落在某张卡片的出线口（y+OUT_Y），
         终点 y 必须落在某张卡片的入线口（y+IN_Y）。 */
      const nodeYs = [...clone.querySelectorAll('.node')].map((n) => parseFloat(n.style.top));
      const OUT_Y = 88, IN_Y = 2;
      const foldRe = /M(-?[\\d.]+) (-?[\\d.]+) L(-?[\\d.]+) (-?[\\d.]+) L(-?[\\d.]+) (-?[\\d.]+) L(-?[\\d.]+) (-?[\\d.]+)/;
      let foldOk = 0, foldBad = 0;
      /* 从**原 SVG** 取路径：clone 里的 SVG 已经被换成 PNG 了。
         这里查的是「屏幕上的线对不对齐」，与导出路径无关。 */
      for (const p of src.querySelectorAll('svg.wires path')) {
        const m = foldRe.exec(p.getAttribute('d') || '');
        if (!m) continue;                       // 3 段的箭头跳过
        const sHit = nodeYs.some((y) => Math.abs(y + OUT_Y - (+m[2])) < 0.01);
        const eHit = nodeYs.some((y) => Math.abs(y + IN_Y - (+m[8])) < 0.01);
        if (sHit && eHit) foldOk++; else foldBad++;
      }

      /* 读回像素验四件事：
         ① 全白 = 拍砸了；
         ② 血亲线没了 = SVG 没画出来；
         ③ **婚配线没了** —— 这是 v0.2.65 的真 bug：html2canvas 直接渲染
            内联 SVG 会漏画（屏幕却完全正常），血亲线还剩一半、婚配线几乎全没，
            必须**分色统计**，混在一起数根本发现不了；
         ④ 每段都要有（只看总数的话，右半边有线就能掩盖左半边全丢）。 */
      const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let ink = 0, blood = 0, marry = 0, lum = 0, lumN = 0;
      const segs = [0, 0, 0, 0];
      for (let p = 0; p < px.length / 4; p++) {
        const i = p * 4;
        lum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        lumN++;
        if (px[i] < 240) ink++;
        const isBlood = Math.abs(px[i] - 168) < 14 && Math.abs(px[i + 1] - 178) < 14
          && Math.abs(px[i + 2] - 192) < 14;                      // 血缘线 #a8b2c0
        const isMarry = Math.abs(px[i] - 208) < 18 && Math.abs(px[i + 1] - 138) < 18
          && Math.abs(px[i + 2] - 46) < 26;                       // 婚配线 #d08a2e
        if (isBlood) blood++;
        if (isMarry) marry++;
        if (isBlood || isMarry) segs[Math.min(3, ((p % cv.width) / cv.width * 4) | 0)]++;
      }

      const b64 = cv.toDataURL('image/png').split(',')[1];
      root.remove();
      const after = cnt();
      return { w: cv.width, h: cv.height, nodes: count, over, ink, blood, marry,
               segs, svgAttr, foldOk, foldBad, rasterised, interactive,
               before, after, removedTags, hadFlag, leftFlag, luma: lum / lumN,
               paletteChanged, paletteScreenKept: before2 === after2,
               rewritten, callLeaked, smallLeft, unknownLeft,
               screenCallKept: screenCallBefore === screenCallAfter, b64 };
    })()`);

    const png = Buffer.from(shot.b64, 'base64');
    ok(png.length > 10000, `导出的 PNG 有内容（${(png.length / 1024).toFixed(0)} KB，${shot.w}×${shot.h}）`);
    ok(png.subarray(0, 4).toString('hex') === '89504e47',
       `PNG 魔数正确（实得 ${png.subarray(0, 4).toString('hex')}，应为 89504e47）`);
    ok(shot.nodes > 0 && shot.over === 0,
       `${shot.nodes} 张卡片全部落在图内，没有被裁掉`);
    ok(shot.ink > 2000, `图里有内容（${shot.ink} 个非白像素，不是白纸）`);

    /* ★ 分色统计：血亲线和婚配线必须分别存在。
       v0.2.65 的真 bug 就是「血亲线还剩一半、婚配线几乎全没」，
       两者混在一起数根本发现不了 —— 这条断言就是为它立的。 */
    ok(shot.rasterised, '内联 SVG 已先光栅化成 PNG 再交给 html2canvas（绕开它的 SVG 漏画）');

    /* ★ 静态图不该带交互状态：选中光晕 / 视角人光晕会让整张图发暗。
       顺带用「导出前后对拍原画布」盯住只改副本 —— 不预设界面上一定有 sel，
       只要求导出这个动作**没有**动到它。 */
    ok(shot.interactive > 0,
       `导出副本摘掉了 ${shot.interactive} 处交互描边（选中态 / 视角人头像光晕）`);
    ok(shot.before.sel === shot.after.sel && shot.before.anchor === shot.after.anchor,
       `原画布的交互态未被改动（sel ${shot.before.sel}→${shot.after.sel}，`
       + `anchor ${shot.before.anchor}→${shot.after.anchor}）`);

    /* ★ 角标：「展开」是纯交互暗示、「待补」是录入提示，静态图里都没意义 */
    ok(shot.removedTags > 0,
       `导出副本去掉了 ${shot.removedTags} 个「展开 / 待补」角标`);
    /* ★ 视角人「我」：第一人称对看图的人没有意义，整块去掉（不是换成人名） */
    ok(shot.hadFlag > 0 && shot.leftFlag === 0,
       `导出副本去掉了 ${shot.hadFlag} 处视角人「我」标记`);

    /* ★ v0.2.71：导出的图一律不显示称呼 —— 大字位是姓名、小字姓名行不留，
       「称谓待确认」的橙色也不该出现（那是没有称呼才谈不上的事）。 */
    ok(shot.rewritten > 0,
      `导出副本把 ${shot.rewritten} 张卡片的称呼换成了姓名`);
    ok(shot.callLeaked === 0, `没有卡片漏下称呼（漏了 ${shot.callLeaked} 张）`);
    ok(shot.smallLeft === 0, `没有卡片还留着小字姓名行（还剩 ${shot.smallLeft} 张）`);
    ok(shot.unknownLeft === 0, '没有卡片挂着「称谓待确认」的样式');
    ok(shot.screenCallKept, '原画布的称呼没被动（屏幕显示不受导出影响）');

    /* ★ 亮度：用户反馈「标准清晰度暗很多」。根因是头像投影在 scale=1 时
       相对更重（1x 亮度 249.3 vs 2x 250.9），统一 2x 渲染后应回到 250+。
       这条盯的是「观感」，阈值留了余量，配色调整时不必立刻改它。 */
    ok(shot.luma > 250, `画面平均亮度 ${shot.luma.toFixed(1)}（>250，统一 2x 渲染后不该发暗）`);

    /* ★ 家族页导出的配色按「该页锚点」重算，且**只发生在副本上** */
    ok(shot.paletteChanged > 0,
       `家族页导出副本按锚点视角重换了 ${shot.paletteChanged} 张卡片的配色`);
    ok(shot.paletteScreenKept,
       '原画布的配色数量未变（屏幕仍按「我」的远近上色，不受导出影响）');
    ok(shot.blood > 200, `血缘线画出来了（${shot.blood} 个像素）`);
    ok(shot.marry > 60, `婚配线画出来了（${shot.marry} 个像素）`
       + '　⚠️ 这条为 0 就说明 html2canvas 又在漏画内联 SVG');

    /* SVG 视口必须**罩住**整棵树（bounds 往往比卡片跨度大一点 ——
   连线的出线口、箭头都要地方站，所以只要求「不小于」），起点要是内容左上角而不是 0 */
    const a = shot.svgAttr;
    ok(Number(a.w) >= a.spanW - 0.5 && Number(a.h) >= a.spanH - 0.5,
       `SVG 视口罩住了内容（视口 ${a.w}×${a.h}，卡片跨度 ${a.spanW}×${a.spanH}）`);
    const vb = String(a.viewBox || '').split(/[ ,]+/).map(Number);
    ok(vb.length === 4 && vb[0] === a.minX && vb[1] === a.minY,
       `SVG viewBox 起点 = 内容左上角（"${a.viewBox}"，minX=${a.minX} minY=${a.minY}）`
       + '　⚠️ 起点写成 0，负坐标那半边的连线在导出图里会整片消失');

    /* viewBox 改了之后，SVG **元素本身**必须跟着挪 —— 不挪就是 v0.2.64 那个回归：
       线整体平移 minX/minY，屏幕上「线没对上人」，导出图里「线不全」。 */
    ok(parseFloat(a.left) === a.minX && parseFloat(a.top) === a.minY,
       `SVG 元素位置 = 内容原点（left=${a.left} top=${a.top}）`
       + '　⚠️ 不补偿的话线和卡片会整体错位');

    ok(shot.foldOk > 0 && shot.foldBad === 0,
       `${shot.foldOk} 条血缘折线全部落在卡片的出线口/入线口上`
       + (shot.foldBad ? `，错位 ${shot.foldBad} 条` : ''));

    /* 分区数连线：四段都得有 */
    const segNames = ['最左 1/4', '左中 1/4', '右中 1/4', '最右 1/4'];
    const dead = shot.segs.map((v, i) => (v < 20 ? segNames[i] : null)).filter(Boolean);
    ok(dead.length === 0,
       `四段里都有连线（${shot.segs.join(' / ')}）`
       + (dead.length ? `　✗ 缺：${dead.join('、')}` : ''));
    const imgToast = await js(`document.querySelector('#toastWrap').textContent.trim().replace(/\\s+/g, ' ')`);
    ok(!/导出图片失败|Error|失败/.test(imgToast), `导出过程无报错（toast：${imgToast || '空'}）`);

    head('10. 截图存档');
    const pngShot = await wc.capturePage();
    const out = path.join(APP_ROOT, 'preview-desktop.png');
    fs.writeFileSync(out, pngShot.toPNG());
    ok(fs.statSync(out).size > 10000, `截图已保存（${(fs.statSync(out).size / 1024).toFixed(0)} KB）→ ${out}`);

    head('11. 主进程启动日志（分步留痕）');
    const steps = fs.existsSync(BOOT_LOG)
      ? fs.readFileSync(BOOT_LOG, 'utf-8').split('\n').filter((l) => /^\S*\[.*\]\s*\d/.test(l))
      : [];
    ok(steps.length >= 8, `启动走了 ${steps.length} 个步骤（0~9 全部留痕）`);
  } catch (e) {
    fails++;
    L.push('EXCEPTION: ' + (e && e.stack || e));
    console.error('\x1b[31mEXCEPTION\x1b[0m', e);
    dumpBootLog();
  }

  console.log(`\n===== ${fails ? fails + ' FAILED' : 'ALL PASSED'} =====`);
  const failed = fails > 0;
  const code = failed ? 1 : 0;

  // 失败时保留沙箱（便于复盘），成功就清掉
  if (!failed) {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* 忽略 */ }
  } else {
    console.log(`数据沙箱保留在：${sandbox}`);
  }

  process.exitCode = code;
  app.exit(code);
}

/* ---------- 4. 在模块顶层只挂一个 .then()，绝不 await ---------- */

import('../electron/main.js')
  .then(runSmoke)
  .catch((err) => {
    console.error('\x1b[31m主进程 import 失败\x1b[0m', err);
    dumpBootLog();
    app.exit(1);
  });
