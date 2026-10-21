/**
 * 复现「删除当前族谱后界面卡住」· tests/repro-delete-current.test.js
 * ---------------------------------------------------------------
 * 跑法：node scripts/launch.js tests/repro-delete-current.test.js
 *
 * 【为什么单独写这个文件，而不是往 book-flow.test.js 里加一条】
 *   book-flow 那套是从**空沙箱**起步、自己一本一本建出来的，
 *   删当前谱时清单里只有 2 本、每本都只有 36 人 —— 它覆盖不到用户现场：
 *     · 4 本谱
 *     · 有一本 158 人的大谱
 *     · 删掉的那本是当前这本
 *   这几项叠在一起才是用户报的场景。所以这里直接把**用户真实数据目录整份
 *   拷进沙箱**再跑，删的是副本，原库一个字节都不碰。
 *
 * ⚠️ 数据写在临时目录（GENOGRAM_DATA_DIR），绝不碰用户真实的那份库。
 * ⚠️⚠️ 本文件**顶端绝对不能有 await** ⚠️⚠️（与 electron-smoke.js 同一个坑）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electron from 'electron';
const { app, BrowserWindow } = electron;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

/* ---------- 1. 把真实数据目录整份拷进沙箱 ---------- */

/** 真实数据目录。跟 electron/paths.js 的 DEFAULT_DATA_DIR 保持一致。 */
const REAL_DATA_DIR = process.env.GENOGRAM_REAL_DATA_DIR
  || 'D:\\族谱pc端项目\\数据';

if (!fs.existsSync(REAL_DATA_DIR)) {
  console.error(`✗ 找不到真实数据目录：${REAL_DATA_DIR}`);
  console.error('  可以用 GENOGRAM_REAL_DATA_DIR 环境变量指过去。');
  app.exit(1);
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'genogram_delrepro_'));

/** 只拷 books\ 与 library.json 就够复现了；trash\ / backups\ 是历史垃圾，不拷。 */
for (const sub of ['books', 'library.json']) {
  const from = path.join(REAL_DATA_DIR, sub);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(sandbox, sub), { recursive: true });
}

process.env.GENOGRAM_DATA_DIR = sandbox;
process.env.GENOGRAM_NO_DIALOG = '1';
process.env.GENOGRAM_DEBUG = '1';

try {
  app.setPath('userData', path.join(sandbox, 'userdata'));
  fs.mkdirSync(path.join(sandbox, 'userdata'), { recursive: true });
} catch { /* 忽略 */ }

/* ---------- 2. 极简断言框架 ---------- */

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) fails++;
  console.log((cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + msg);
};
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 用户视角的「点得动吗」。
 *
 * ⚠️ 千万不能直接 `el.click()` 了事 —— 那是 DOM 层的合成事件，**不做命中测试**，
 * 哪怕有个铺满全屏的遮罩盖在上面它照样能触发。实测正是这样：删除谱之后
 * `el.click()` 照样成功、控制台一切正常，而真实用户用鼠标点上去什么都不发生。
 * 真实的鼠标事件只会命中 `document.elementFromPoint(x, y)` 返回的那个元素，
 * 所以判据必须是它。
 */
const canHit = (selector) => js(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    found: true,
    reachable: el.contains(hit) || hit === el,
    hitTag: hit ? (hit.id || hit.className || hit.tagName) : '(null)',
  };
})()`);

/* ---------- 3. 工具 ---------- */

let WC = null;
const js = (code) => WC.executeJavaScript(code, true);

async function libNow() {
  const { readLibrary } = await import('../electron/library.js');
  return readLibrary(sandbox);
}

/**
 * 界面到底还能不能用。
 * 「卡住」在 Electron 里最常见的形态就是**有个铺满全屏的遮罩没被摘掉** ——
 * 那种情况下用户看到的现象是「鼠标点不动、界面没反应」，
 * 而控制台一切正常。所以每次操作后都要问一遍这三件事。
 */
const uiState = () => js(`(() => ({
  overlayOn: document.getElementById('overlay').classList.contains('on'),
  overlayHTML: (document.getElementById('overlay').innerHTML || '').trim().length,
  bookMenuHidden: document.getElementById('bookMenu')?.hidden,
  chip: (document.getElementById('bookChipName')?.textContent || '').trim(),
  nodes: document.querySelectorAll('.node').length,
  toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()),
}))()`);

/* ---------- 4. 主体 ---------- */

async function run() {
  let win = null;

  try {
    await import('../electron/main.js');
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      win = BrowserWindow.getAllWindows()[0];
      if (win) break;
      await tick(100);
    }
    if (!win) throw new Error('30 秒内没有窗口被创建');
    WC = win.webContents;
    if (WC.isLoading()) await new Promise((r) => WC.once('did-finish-load', r));
    await tick(3000);
  } catch (e) {
    console.error('\x1b[31m启动阶段失败\x1b[0m', e);
    app.exit(1);
    return;
  }

  /* 渲染层没抛异常？先钉住这条 —— 「卡住」常常是异常打断了某个 await 链 */
  const renderErr = await js(`(window.__errs || []).join(' | ') || ''`);
  ok(!renderErr, `渲染层无未捕获异常${renderErr ? '：' + renderErr : ''}`);

  try {
    head('1. 现场：真实数据拷进沙箱后的初始状态');
    const lib = await libNow();
    const cur = lib.books.find((b) => b.id === lib.current);
    console.log(`沙箱：${sandbox}`);
    console.log(`谱清单：${lib.books.length} 本 —— ` + lib.books.map((b) => b.name).join(' / '));
    console.log(`当前这本：${cur?.name}（${cur?.people} 人）`);

    const s0 = await uiState();
    ok(s0.overlayOn === false, `启动后没有残留遮罩（overlay.on=${s0.overlayOn}）`);
    ok(s0.nodes > 0, `启动后画布有 ${s0.nodes} 个节点`);

    head('2. 打开谱菜单 → 点「删除本谱」');
    await js(`document.getElementById('bookChip').click()`);
    await tick(300);
    const m = await js(`(() => ({
      hidden: document.getElementById('bookMenu').hidden,
      acts: [...document.querySelectorAll('[data-book-act]')].map((x) => x.dataset.bookAct),
    }))()`);
    ok(!m.hidden, '谱下拉已打开');
    console.log(`      下拉里的动作：${m.acts.join('、')}`);

    if (!m.acts.includes('delete')) {
      console.error('\x1b[31m下拉里没有「删除本谱」，场景不成立\x1b[0m');
      app.exit(1);
      return;
    }
    await js(`document.querySelector('[data-book-act="delete"]').click()`);
    await tick(400);

    head('3. 二次确认框');
    const dlg = await js(`(() => {
      const l = document.querySelector('.confirm-layer');
      if (!l) return null;
      return { text: l.textContent.replace(/\\s+/g, ' ').trim().slice(0, 90) };
    })()`);
    ok(!!dlg, `弹出二次确认：${dlg ? dlg.text : '(没弹)'}`);

    head('4. 点确认 → 这才是会「卡住」的那一步');
    const t1 = Date.now();
    await js(`(() => {
      const b = document.querySelector('.confirm-layer [data-cf="1"]');
      if (b) b.click();
      return !!b;
    })()`);
    console.log('      已点确认，开始盯界面状态…');

    /* 卡住的话，多半是这一步之后就再也不动了。每 500ms 看一眼。
       ⚠️ 判定顺序有讲究：**先**认「正常完成」（切到了别的谱 + 遮罩摘了），
       **再**认「卡住」。反过来的话，修复之后界面一切正常、状态自然稳定，
       反而会被「连着 3 次不变」判成卡住——这是我第一版就踩的坑。 */
    let prev = null;
    let stuck = 0;
    let settled = false;
    for (let i = 0; i < 40; i++) {
      await tick(500);
      const s = await uiState();
      const sig = JSON.stringify([s.chip, s.nodes, s.overlayOn, s.overlayHTML]);
      if (sig === prev) stuck++; else { stuck = 0; prev = sig; }

      // 正常完成：谱切走了，且遮罩摘干净了
      if (!s.overlayOn && s.chip && s.chip !== cur?.name) { settled = true; break; }

      if (stuck >= 3) {
        console.error('\x1b[31m← 界面状态连续 1.5 秒不变，且谱没切走，判定为卡住\x1b[0m');
        break;
      }
      if (i < 3) {
        console.log(`      [${((Date.now() - t1) / 1000).toFixed(1)}s] 谱=${s.chip} 节点=${s.nodes} `
          + `遮罩=${s.overlayOn} 遮罩内容长度=${s.overlayHTML} toast=${JSON.stringify(s.toasts)}`);
      }
    }
    ok(settled, `删除流程走完了（谱已切换、遮罩已摘），耗时约 ${((Date.now() - t1) / 1000).toFixed(1)}s`);

    const after = await uiState();
    head('5. 判定');
    ok(after.overlayOn === false,
      `删除后遮罩已摘除（overlay.on=${after.overlayOn}，残留内容 ${after.overlayHTML} 字）`);
    ok(after.overlayHTML === 0, '遮罩里没有残留 DOM（否则鼠标点不动 = 用户说的「卡住」）');
    ok(after.bookMenuHidden !== false, '谱下拉已关闭');
    ok(after.chip && after.chip !== cur?.name, `已切到别的谱：${after.chip}`);
    ok(after.nodes > 0, `画布重新渲染出 ${after.nodes} 个节点`);

    head('6. 卡住之后的界面还能不能操作（真实鼠标命中，不是合成事件）');
    const hitChip = await canHit('#bookChip');
    ok(hitChip.reachable,
      `顶栏那颗谱胶囊点得动（命中的是：${hitChip.hitTag}）`
      + (hitChip.reachable ? '' : ' ← 被 overlay 挡住了，这就是用户说的「卡住」'));
    const hitRail = await canHit('#rail');
    ok(hitRail.reachable, `左侧导航轨点得动（命中的是：${hitRail.hitTag}）`);
    await js(`document.getElementById('bookChip').click()`);
    await tick(300);
    ok(await js(`!document.getElementById('bookMenu').hidden`), '谱下拉能正常弹出');
    await js(`document.body.click()`);
    await tick(200);

    const lib2 = await libNow();
    ok(lib2.books.length === lib.books.length - 1,
      `清单从 ${lib.books.length} 本变成 ${lib2.books.length} 本`);
    ok(lib2.current && lib2.current !== lib.current, 'current 已指向还活着的那本');
    ok(fs.existsSync(path.join(sandbox, 'trash')), '被删的谱目录挪进了 trash\\（可手工找回）');
  } catch (e) {
    console.error('\x1b[31m执行期异常\x1b[0m', e);
    fails++;
  }

  console.log(fails === 0 ? '\n===== ALL PASSED =====\n' : `\n===== ${fails} FAILED =====\n`);
  console.log(`沙箱保留在：${sandbox}`);
  app.exit(fails === 0 ? 0 : 1);
}

/* ⚠️ 只挂调用，不在顶层 await，也不套 app.whenReady().then() ——
   main.js 里有一句 app.disableHardwareAcceleration()，它**必须在 app ready 之前**调用；
   一旦等 whenReady 就会抛「can only be called before app is ready」，启动直接失败。 */
run();