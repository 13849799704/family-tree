/**
 * 多本谱端到端回归 · tests/book-flow.test.js
 * ---------------------------------------------------------------
 * 跑法：node scripts/launch.js tests/book-flow.test.js
 *
 * 【为什么必须有这个文件】
 *   library.test.js 验证的是**清单**，db.test.js 验证的是**单本谱的存储**。
 *   但这两个都对 ≠ 多谱真的能用。真正决定成败的是中间那段接缝：
 *     · 新建谱之后，后续的「保存」到底写进了哪个文件？
 *     · 切走再切回来，两本谱的数据会不会互相污染？
 *     · 删掉当前这本，界面还有没有数据可用？
 *   这三件事只有把真 Electron 跑起来、读完 .db 文件才能下结论。
 *
 * 【覆盖的场景（正是用户提的原始诉求）】
 *   「我自己填了一套，系统自带一套默认的，我想再建个新的」——
 *   所以断言的重点是**隔离**：在 B 谱里录的人，A 谱里绝不能出现。
 *
 * ⚠️ 数据写在临时目录（GENOGRAM_DATA_DIR），绝不碰用户真实的那份库。
 * ⚠️⚠️ 本文件**顶端绝对不能有 await** ⚠️⚠️（与 electron-smoke.js 同一个坑：
 *    顶层 await 会让 ready 事件永远等不到，表现为「窗口不出现且无报错」）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electron from 'electron';
const { app, BrowserWindow } = electron;

/* ---------- 1. 沙箱（必须在 import main 之前设置） ---------- */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'genogram_book_'));
process.env.GENOGRAM_DATA_DIR = sandbox;
process.env.GENOGRAM_NO_DIALOG = '1';

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
const note = (msg) => console.log('      ' + msg);
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 3. 工具 ---------- */

let WC = null;
const js = (code) => WC.executeJavaScript(code, true);

/** 顶栏那颗谱胶囊的当前显示 */
const chipState = () => js(`(() => ({
  name: document.getElementById('bookChipName').textContent.trim(),
  count: document.getElementById('bookChipCount').textContent.trim(),
  nodes: document.querySelectorAll('.node').length,
}))()`);

/** 菜单 / 弹窗当前有没有开 */
const menuOpen = () => js(`(() => {
  const m = document.getElementById('bookMenu');
  return { hidden: m.hidden, items: m.querySelectorAll('[data-book-id]').length };
})()`);

/** 读一本谱的磁盘文件，看里面有几个人 */
async function peopleInDisk(bookId) {
  const { GenogramStore } = await import('../electron/db.js');
  const { bookDir } = await import('../electron/paths.js');
  const s = await GenogramStore.open(bookDir(sandbox, bookId));
  const n = s.info().people;
  s.close();
  return n;
}

/** 清单里当前有几本书、现在用的哪本 */
async function libNow() {
  const { readLibrary } = await import('../electron/library.js');
  return readLibrary(sandbox);
}

/* ---------- 4. 主体 ---------- */

async function run() {
  let win = null;

  try {
    await import('../electron/main.js');
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      win = BrowserWindow.getAllWindows()[0];
      if (win) break;
      await tick(100);
    }
    if (!win) throw new Error('20 秒内没有窗口被创建');
    WC = win.webContents;
    if (WC.isLoading()) await new Promise((r) => WC.once('did-finish-load', r));
    await tick(2600);      // 等 boot() 把示例数据落库
  } catch (e) {
    console.error('\x1b[31m启动阶段失败\x1b[0m', e);
    app.exit(1);
    return;
  }

  try {
    head('1. 启动：自动建出第一本谱');
    let lib = await libNow();
    ok(lib.books.length === 1, `清单里 1 本谱（${lib.books.length}）`);
    const firstId = lib.books[0].id;
    ok(lib.books[0].name === '我的家族', `默认谱名「${lib.books[0].name}」`);
    ok(lib.current === firstId, 'current 指向它');

    const s0 = await chipState();
    ok(s0.name === '我的家族', `顶栏显示「${s0.name}」`);
    ok(await peopleInDisk(firstId) === 36, '首次运行已把示例家族（36 人）落进它自己的 .db');

    head('2. 通过 UI 新建一本空白谱');
    await js(`document.getElementById('bookChip').click()`);
    await tick(260);
    let m = await menuOpen();
    ok(m.hidden === false, '点击胶囊弹出下拉');
    ok(m.items === 1, `下拉里列出 ${m.items} 本谱`);

    await js(`document.querySelector('[data-book-act="new"]').click()`);
    await tick(420);
    ok(await js(`!!document.querySelector('#bk-name')`), '新建弹窗打开');

    await js(`(() => {
      document.querySelector('#bk-name').value = '测试谱';
      document.querySelector('[data-book-act], [data-book="ok"]');
      return true;
    })()`);
    await js(`document.querySelector('[data-book="ok"]').click()`);
    await tick(900);

    lib = await libNow();
    ok(lib.books.length === 2, `清单变成 2 本（${lib.books.length}）`);
    const secondId = lib.books.find((b) => b.name === '测试谱')?.id;
    ok(!!secondId, '新谱在清单里');
    ok(lib.current === secondId, '自动切到了新建的这本（用户想的就是「现在我要填它」）');

    const s1 = await chipState();
    ok(s1.name === '测试谱', `顶栏已切到「${s1.name}」`);
    ok(s1.nodes === 0, `界面是空的（${s1.nodes} 个节点）—— 用户要的正是空白谱`);
    ok(await peopleInDisk(secondId) === 0, '磁盘上这本谱确实是空的');

    head('3. 在空白谱里录一个人');
    await js(`document.querySelector('[data-act="add"]').click()`);
    await tick(420);
    await js(`(() => {
      document.querySelector('#f-name').value = '测试谱的人';
      document.querySelector('[data-sex="M"]').click();
      document.querySelector('#f-birth').value = '1980';
      document.querySelector('form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await tick(900);

    ok(await peopleInDisk(secondId) === 1, '人写进了**测试谱**的 .db');
    ok(await peopleInDisk(firstId) === 36, '第一本谱仍是 36 人 —— 没有被刚才的录入碰到');

    head('4. 切回第一本：数据要原封不动');
    await js(`document.getElementById('bookChip').click()`);
    await tick(260);
    await js(`document.querySelector('[data-book-id="${firstId}"]').click()`);
    await tick(900);

    const s2 = await chipState();
    ok(s2.name === '我的家族', `已切回「${s2.name}」`);
    ok(await peopleInDisk(firstId) === 36, '第一本谱还是那 36 个人');

    const names = await js(`(() => {
      const ids = [...document.querySelectorAll('.node')].map(n => n.dataset.id);
      return { n: ids.length };
    })()`);
    ok(names.n === 20, `主树重新渲染出 ${names.n} 个节点（示例数据的主树规模）`);

    head('5. 重命名当前谱：改的是名字，数据一个都不能少');
    await js(`document.getElementById('bookChip').click()`);
    await tick(260);
    await js(`document.querySelector('[data-book-act="rename"]').click()`);
    await tick(420);
    ok(await js(`!!document.querySelector('#bk-name')`), '改名弹窗打开');

    await js(`(() => { document.querySelector('#bk-name').value = '我的家族（改过名）'; return true; })()`);
    await js(`document.querySelector('[data-book="ok"]').click()`);
    await tick(800);

    const rn = await chipState();
    ok(rn.name === '我的家族（改过名）', `顶栏已显示「${rn.name}」`);
    /* ⚠️ 这条盯着一个真实存在的坑：preload 的 absorb() 若把「没带 json 的响应」
       照抄进同步缓存，改名会把 boot.json 抹成 null —— 改个名等于清空家底。
       library.test.js 够不到它（那边没有 preload），只能在这儿守。 */
    ok(rn.nodes === 20, `改名后数据仍在：${rn.nodes} 个节点`);
    ok(await peopleInDisk(firstId) === 36, '磁盘上还是那 36 个人');

    head('6. 删除当前谱 → 自动落到剩下那本');
    await js(`document.getElementById('bookChip').click()`);
    await tick(260);
    await js(`document.querySelector('[data-book-act="delete"]').click()`);
    await tick(420);
    ok(await js(`!!document.querySelector('.confirm-layer')`), '弹出二次确认（自绘，非原生 confirm）');

    const clicked = await js(`(() => {
      const b = document.querySelector('.confirm-layer [data-cf="1"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    ok(clicked === true, '点了确认按钮');
    await tick(1100);

    lib = await libNow();
    ok(lib.books.length === 1, `只剩 1 本（${lib.books.length}）`);
    ok(lib.current === secondId, 'current 已自动切到剩下的「测试谱」');

    const s3 = await chipState();
    ok(s3.name === '测试谱', `界面跟着切到「${s3.name}」`);
    ok(s3.nodes === 1, `渲染出 ${s3.nodes} 个节点（刚录的那个人）`);

    const trashed = fs.existsSync(path.join(sandbox, 'trash'));
    ok(trashed, '被删的谱目录挪进了 trash\\（不是真的删除，可手工找回）');

    /* ⚠️⚠️ 盯一个真实故障（用户报「删除当前族谱后界面卡住了」）。
       删除谱这条流程里，`confirmOverlay` 是整个交互中**唯一**碰过 `#overlay`
       的弹窗 —— 它在 658 行 `classList.add('on')`，却没有配对的 remove。
       于是关掉之后那个铺满全屏、`pointer-events: auto` 的**空**遮罩留在原地：
       不报错、不白屏、界面看着一切正常，但鼠标点不动任何东西。
       平时不暴露，是因为 confirmOverlay 多数时候叠在别的弹窗上，
       下层那个弹窗 close() 时顺手摘了 `.on`。

       ⚠️ 判据必须用 `elementFromPoint`（真实鼠标命中），**不能用 `el.click()`**：
       合成事件不做命中测试，遮罩盖在上面它照样触发 —— 那样这条断言会假通过，
       我第一版就是这么被骗过去的。 */
    const ov = await js(`(() => ({
      on: document.getElementById('overlay').classList.contains('on'),
      html: (document.getElementById('overlay').innerHTML || '').trim().length,
    }))()`);
    ok(ov.on === false, `删除后遮罩已摘除（overlay.on=${ov.on}）—— 这一条以前一直是红的`);
    ok(ov.html === 0, '遮罩里没有残留 DOM');

    const hit = await js(`(() => {
      const el = document.getElementById('bookChip');
      const r = el.getBoundingClientRect();
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { reachable: el.contains(h) || h === el, tag: h ? (h.id || h.className || h.tagName) : '(null)' };
    })()`);
    ok(hit.reachable,
      `顶栏谱胶囊真实鼠标点得动（命中：${hit.tag}）—— 挂在这里就等于「界面卡住」`);

    /* 同样别用合成 click —— 故障代码上它照样「通过」，骗人。
       先用 elementFromPoint 证明鼠标真能落到胶囊上，再点、再验证弹出。 */
    const hit2 = await js(`(() => {
      const el = document.getElementById('bookChip');
      const r = el.getBoundingClientRect();
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el.contains(h) || h === el;
    })()`);
    ok(hit2, '鼠标命中仍是谱胶囊本身');
    await js(`document.getElementById('bookChip').click()`);
    await tick(260);
    ok(await js(`!document.getElementById('bookMenu').hidden`), '谱下拉能正常弹出');
    await js(`document.body.click()`);
    await tick(200);
    note(`沙箱保留在：${sandbox}`);
  } catch (e) {
    console.error('\x1b[31m执行期异常\x1b[0m', e);
    fails++;
  }

  console.log(fails === 0 ? '\n===== ALL PASSED =====\n' : `\n===== ${fails} FAILED =====\n`);
  app.exit(fails === 0 ? 0 : 1);
}

// ⚠️ 只挂 .then()，不在顶层 await（注释见文件头）
run();
