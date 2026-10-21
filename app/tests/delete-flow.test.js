/**
 * 删除人员流程回归 · tests/delete-flow.test.js
 * ---------------------------------------------------------------
 * 跑法：node scripts/launch.js tests/delete-flow.test.js
 *
 * 覆盖两个已修的故障：
 *
 * ① 「删除人员后无法继续编辑、输入框打不进字、内容也无法删除」（2026-10-09）
 *    根因：ui/dialog.js 的删除处理器无条件 close()，而 deletePerson
 *    有「根本没删成」的提前返回路径 —— 弹窗被关掉，填的内容全丢。
 *
 * ② 同名现象的**真正元凶**（2026-10-10）
 *    根因：二次确认用的是**原生 confirm()**。Electron 渲染层的原生模态框
 *    关闭之后，Windows 的键盘输入链路不会干净地交还给渲染进程 ——
 *    实测：insertText 这类程序注入有效，但**真实物理按键全部失效**，
 *    且会一直持续到应用重启。用户看到的正是「点完确认框就再也打不进字」。
 *    修法：全项目禁用原生 confirm，改用 ui/dialog.js 的 confirmOverlay。
 *
 * ② 只能用 **user32.keybd_event 系统级物理按键**守住 ——
 *    webContents.sendInputEvent 和 CDP 的 Input.* 都直接把事件投递给渲染层，
 *    完全绕过 Windows 原生 accelerator / 键盘路由表，测不到这个故障。
 *    本文件末尾第 5 组就是干这个的（约需 30~60 秒）。
 *
 * ⚠️ 数据写在临时目录（GENOGRAM_DATA_DIR），绝不碰用户真实的那份库。
 * ⚠️⚠️ 本文件**顶端绝对不能有 await** ⚠️⚠️（与 electron-smoke.js 同一个坑）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import electron from 'electron';
const { app, BrowserWindow } = electron;

/* ---------- 1. 沙箱（必须在 import main 之前设置） ---------- */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'genogram_del_'));
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

const mouseClick = async (x, y) => {
  WC.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  WC.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await tick(140);
};

/** 真实鼠标点击某个元素 */
const clickSel = async (sel) => {
  const r = await js(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  if (!r) return false;
  await mouseClick(r.x, r.y);
  return true;
};

/** 点树上一个节点（真实鼠标），返回该人 id */
const clickNode = async (id) => {
  const r = await js(`(() => {
    const el = document.querySelector('.node[data-id=' + ${JSON.stringify(JSON.stringify(id))} + ']')
      || document.querySelector('.node[data-id="' + ${JSON.stringify(id)} + '"]');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  if (!r) return false;
  await mouseClick(r.x, r.y);
  return true;
};

const val = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? String(el.value) : null; })()`);
const ime = async (text) => { WC.insertText(text); await tick(140); };

/** 弹窗 / 遮罩 / 焦点 的联合快照 */
const snap = () => js(`(() => {
  const o = document.getElementById('overlay');
  const a = document.activeElement;
  const cf = document.querySelector('.confirm-layer');
  return {
    on: o.classList.contains('on'),
    pe: getComputedStyle(o).pointerEvents,
    modal: !!o.querySelector('.modal'),
    confirm: !!cf,
    confirmTitle: cf ? cf.querySelector('.modal-title')?.textContent.trim() : null,
    confirmText: cf ? cf.querySelector('.confirm-text')?.textContent.trim().slice(0, 30) : null,
    title: document.querySelector('.modal:not(.confirm-layer .modal) .modal-title')?.textContent.trim()
      || document.querySelector('.modal-title')?.textContent.trim() || null,
    name: (document.getElementById('f-name') || {}).value ?? null,
    note: (document.getElementById('f-note') || {}).value ?? null,
    active: a ? (a.id || a.getAttribute('data-cf') || a.tagName) : null,
  };
})()`);

/** 打开某人的编辑弹窗 */
const openEdit = async (id) => {
  await clickNode(id);
  await tick(450);
  return clickSel('[data-act="edit"]');
};

/** 找出视角人物（面板上显示「我」的那个） */
const findViewpoint = async () => {
  const ns = await js(`[...document.querySelectorAll('.node')].map(n => {
    const b = n.getBoundingClientRect();
    return { id: n.dataset.id, x: Math.round(b.left+b.width/2), y: Math.round(b.top+b.height/2),
             vis: b.left>0 && b.top>0 && b.right<innerWidth && b.bottom<innerHeight };
  })`);
  for (const n of ns) {
    if (!n.vis) continue;
    await mouseClick(n.x, n.y);
    const self = await js(`(() => { const e = document.querySelector('.panel .call-main');
      return e ? e.textContent.trim() : null; })()`);
    if (self === '我') return n.id;
  }
  return null;
};

/* ---------- 3b. 系统级物理按键（唯一能守住 ② 的手段） ---------- */

const PS_PRELUDE = [
  '$ErrorActionPreference = \'Stop\'',
  'Add-Type -Namespace AccProbe -Name U -MemberDefinition @"',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);',
  '"@',
];

/** 用 user32.keybd_event 发一个真实物理按键（走 Windows 键盘路由，能被原生框/accelerator 拦到） */
function pressPhysicalKey(hwnd, vk) {
  const script = PS_PRELUDE.concat([
    '$h = [IntPtr]::new([int64]$env:ACC_HWND)',
    '[void][AccProbe.U]::BringWindowToTop($h)',
    '[void][AccProbe.U]::SetForegroundWindow($h)',
    'Start-Sleep -Milliseconds 300',
    '[AccProbe.U]::keybd_event([byte]$env:ACC_VK, 0, 0, [UIntPtr]::Zero)',
    'Start-Sleep -Milliseconds 60',
    '[AccProbe.U]::keybd_event([byte]$env:ACC_VK, 0, 2, [UIntPtr]::Zero)',
    'Start-Sleep -Milliseconds 140',
    'Write-Output "ok"',
  ]).join('\r\n');
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ACC_HWND: hwnd.toString(), ACC_VK: String(vk) } });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { child.kill(); reject(new Error('powershell 60s 未返回 ' + err.slice(0, 200))); }, 60000);
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('exit', (c) => { clearTimeout(t); c === 0 ? resolve(out.trim()) : reject(new Error('退出码' + c + ' ' + err.slice(0, 200))); });
  });
}

async function waitForWindow(timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) return w;
    await tick(100);
  }
  throw new Error('20 秒内没有窗口被创建');
}

/* ---------- 4. 主体 ---------- */

async function run() {
  let win = null;
  try {
    await import('../electron/main.js');
    win = await waitForWindow();
    WC = win.webContents;
    if (WC.isLoading()) await new Promise((r) => WC.once('did-finish-load', r));
    await tick(3000);
    win.show();
    await tick(600);
  } catch (e) {
    console.error('\x1b[31m启动阶段失败\x1b[0m', e);
    app.exit(1);
    return;
  }

  // 原生 confirm 一旦被调用就说明又有人用了 —— 直接炸掉，别让它悄悄回归
  await js(`(() => {
    window.__nativeConfirmUsed = 0;
    const orig = window.confirm;
    window.confirm = function (msg) {
      window.__nativeConfirmUsed++;
      window.__lastNativeConfirmMsg = String(msg).slice(0, 80);
      console.error('[native-confirm] 检测到原生 confirm 调用：' + String(msg).slice(0, 80));
      return orig.call(window, msg);
    };
    return true;
  })()`);

  try {
    /* ===================================================== */
    head('1. 二次确认走自绘确认框（不是原生 confirm）');
    /* ===================================================== */
    const vp = await findViewpoint();
    ok(!!vp, `找到视角人物（${vp || '没找到'}）`);

    // 找一个非视角人
    const victim = await js(`(() => { for (const n of document.querySelectorAll('.node'))
      if (n.dataset.id !== ${JSON.stringify(vp)}) return n.dataset.id; return null; })()`);
    ok(!!victim, `找一个可删除的人（${victim}）`);

    await openEdit(victim);
    await tick(600);
    ok((await snap()).modal, '编辑弹窗已打开');

    await clickSel('[data-act="delete"]');
    await tick(600);
    const c1 = await snap();
    ok(c1.confirm, '点「删除此人」后弹出的是**自绘确认框**');
    ok(c1.confirmTitle === '删除这个人', `确认框标题正确（${c1.confirmTitle}）`);
    ok(/确定删除/.test(c1.confirmText || ''), `确认框正文正确（${c1.confirmText}…）`);
    ok((await snap()).modal, '确认框是**叠在编辑弹窗之上**的，编辑弹窗还在');
    const nativeUsed = await js(`window.__nativeConfirmUsed`);
    ok(nativeUsed === 0, `原生 confirm 调用次数 = ${nativeUsed}（必须是 0）`);
    // 先把确认关掉，否则后面所有点击都会落在 confirm-layer 上（= 取消）
    await clickSel('.confirm-layer [data-cf="0"]');
    await tick(500);

    /* ===================================================== */
    head('2. 确认框点「取消」：弹窗留着，内容一个字都不能少');
    /* ===================================================== */
    // 填点东西再取消
    await clickSel('#f-note');
    await ime('取消也不能丢');
    const before = await snap();
    note(`取消前：name=${JSON.stringify(before.name)} note=${JSON.stringify(before.note)}`);

    await clickSel('.confirm-layer [data-cf="0"]');
    await tick(600);
    const after = await snap();
    ok(!after.confirm, '确认框已关闭');
    ok(after.modal, '点「取消」后编辑弹窗**没有被关掉**');
    ok(after.on && after.pe === 'auto', '遮罩仍是激活态（弹窗还在正常工作）');
    ok(after.name === before.name, `姓名没丢（${JSON.stringify(after.name)}）`);
    ok(after.note === before.note, `备注没丢（${JSON.stringify(after.note)}）`);
    ok(after.active === 'f-note', `焦点回到刚才在填的备注框（实际 ${after.active}）`);

    // 取消之后必须还能接着改
    const midNote = await val('#f-note');
    await ime('接着改');
    const endNote = await val('#f-note');
    ok(endNote !== midNote && endNote.includes('接着改') && endNote.includes(midNote),
      `取消删除后仍能继续输入（${JSON.stringify(midNote)} → ${JSON.stringify(endNote)}）`);

    // 确认框的键盘：Esc = 取消、Enter = 确认
    await clickSel('[data-act="delete"]');
    await tick(500);
    ok((await snap()).confirm, '再次打开确认框');
    WC.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    WC.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await tick(500);
    const escState = await snap();
    ok(!escState.confirm && escState.modal, '确认框里按 Esc = 取消（而不是把编辑弹窗一起关掉）');
    ok(escState.active === 'f-note', `Esc 之后焦点回到备注框（实际 ${escState.active}）`);

    /* ===================================================== */
    head('3. 删除视角人物（本人）：代码拒绝删除，弹窗必须留着');
    /* ===================================================== */
    if (vp) {
      // 上一步的编辑弹窗还开着（点 Esc 只关了确认框），先归位再切人
      if (await js(`!!document.getElementById('f-name')`)) {
        await clickSel('[data-act="cancel"]');
        await tick(600);
      }
      await clickNode(vp);
      await tick(500);
      ok(await clickSel('[data-act="edit"]'), `已打开视角人物 ${vp} 的编辑弹窗`);
      await tick(700);
      await clickSel('#f-name');
      await ime('X');
      const b3 = await snap();
      await clickSel('[data-act="delete"]');
      await tick(600);
      ok((await snap()).confirm, '点删除也先弹确认框');
      await clickSel('.confirm-layer [data-cf="1"]');
      await tick(800);
      const a3 = await snap();
      ok(!a3.confirm, '确认框已关闭');
      ok(a3.modal, '删除本人被拒绝后编辑弹窗**没有被关掉**');
      ok(a3.name === b3.name, `姓名没丢（${JSON.stringify(a3.name)}）`);
      const toastTxt = await js(`document.getElementById('toastWrap').textContent`);
      ok(/不能删除视角人物/.test(toastTxt),
        '仍然给出了「不能删除视角人物」的提示');
    }

    /* ===================================================== */
    head('4. 真的删掉：确认 → 弹窗关闭、人真的没了');
    /* ===================================================== */
    await clickSel('[data-act="cancel"]');
    await tick(500);
    await js(`window.__c = true`);

    const victim2 = await js(`(() => { for (const n of document.querySelectorAll('.node'))
      if (n.dataset.id !== ${JSON.stringify(vp)}) return n.dataset.id; return null; })()`);
    await openEdit(victim2);
    await tick(600);
    const nodesBefore = await js(`document.querySelectorAll('.node').length`);
    await clickSel('[data-act="delete"]');
    await tick(500);
    ok(await clickSel('.confirm-layer [data-cf="1"]'), '确认框点「删除」');
    await tick(900);
    const a4 = await snap();
    ok(!a4.modal && !a4.on && !a4.confirm, '删除成功后弹窗正常关闭、遮罩已撤');
    const nodesAfter = await js(`document.querySelectorAll('.node').length`);
    ok(nodesAfter < nodesBefore, `人真的被删掉了（节点 ${nodesBefore} → ${nodesAfter}）`);

    /* ===================================================== */
    head('5. ⚠️ 关键回归：确认框之后**真实物理按键**必须仍然有效');
    /* ===================================================== */
    /* 这一项守的是 2026-10-10 那个真正元凶：
       原生 confirm() 关闭后，真实键盘输入链路不会交还给渲染进程，
       程序注入（insertText）照样有效 —— 只有物理按键测得出来。 */
    const raw = win.getNativeWindowHandle();
    const hwnd = typeof raw === 'bigint' ? raw
      : (typeof raw === 'number' ? BigInt(raw) : BigInt(raw.readBigUInt64LE(0)));

    // 对照：随便找个还活着的人，编辑弹窗里直接打物理键（此时还没弹过确认框）
    const other = await js(`(() => { for (const n of document.querySelectorAll('.node'))
      if (n.dataset.id !== ${JSON.stringify(vp)}) return n.dataset.id; return null; })()`);
    await openEdit(other);
    await tick(700);
    ok((await snap()).modal, `已打开 ${other} 的编辑弹窗（作对照基准）`);

    const typePhysical = async (sel, label) => {
      await js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
        if (el) { el.focus(); el.value = ''; } return true; })()`);
      await tick(350);
      const b = await val(sel);
      try { await pressPhysicalKey(hwnd, 0x41 /* A */); }   // A
      catch (e) { note(`注入物理键失败：${e?.message || e}`); return null; }
      await tick(500);
      const a = await val(sel);
      note(`${label}：${JSON.stringify(b)} → ${JSON.stringify(a)}`);
      return a !== b;
    };

    const baseline = await typePhysical('#f-name', '对照·删除前打物理键 A');
    ok(baseline === true, '基准：还没弹过确认框时，物理按键能打进姓名框');

    // 现在走一遍「删除 → 确认」，紧接着**重新打开另一个人的编辑弹窗**再打物理键
    // （这就是用户报的场景：删完人再去改另一个人，这时打不进字）
    await clickSel('[data-act="cancel"]');
    await tick(500);
    const victim3 = await js(`(() => { for (const n of document.querySelectorAll('.node'))
      if (n.dataset.id !== ${JSON.stringify(vp)}) return n.dataset.id; return null; })()`);
    await openEdit(victim3);
    await tick(600);
    await clickSel('[data-act="delete"]');
    await tick(500);
    ok(await clickSel('.confirm-layer [data-cf="1"]'), '走了一遍完整的「删除 → 确认」');
    await tick(900);
    ok(!(await snap()).modal, '删除后编辑弹窗已关闭（与用户场景一致）');

    // 关键：重新打开**另一个人**的编辑弹窗
    const survivor = await js(`(() => { for (const n of document.querySelectorAll('.node'))
      if (n.dataset.id !== ${JSON.stringify(vp)}) return n.dataset.id; return null; })()`);
    ok(await openEdit(survivor), `重新打开 ${survivor} 的编辑弹窗`);
    await tick(800);
    ok((await snap()).modal, '编辑弹窗已重新打开');

    const afterKey = await typePhysical('#f-name', '删除确认之后打物理键 A');
    ok(afterKey === true,
      '⚠️ 走完确认框之后，**真实物理按键仍然能打进输入框**（原生 confirm 那次是 ❌）');

    const noteKey = await typePhysical('#f-note', '确认框之后打物理键 A（备注框）');
    ok(noteKey === true, '备注框同样不受影响');

    // 再确认一次：全流程没碰过原生 confirm
    ok(await js(`window.__nativeConfirmUsed`) === 0,
      `整轮下来原生 confirm 调用次数 = ${await js(`window.__nativeConfirmUsed`)}（必须是 0）`);

    /* ===================================================== */
    head('6. 删除之后界面仍然可用');
    /* ===================================================== */
    // 第 5 组结束时编辑弹窗还开着，先关掉再检查遮罩是否干净
    if (await js(`!!document.getElementById('f-name')`)) {
      await clickSel('[data-act="cancel"]');
      await tick(700);
    }
    await tick(300);
    const ov = await js(`(() => { const o = document.getElementById('overlay');
      return { on: o.classList.contains('on'), htmlLen: o.innerHTML.length,
               layers: o.querySelectorAll('.confirm-layer').length,
               pe: getComputedStyle(o).pointerEvents }; })()`);
    ok(!ov.on && ov.htmlLen === 0, `遮罩已彻底清干净（on=${ov.on} htmlLen=${ov.htmlLen}）`);
    ok(ov.layers === 0, `没有残留的确认框叠层（layers=${ov.layers}）`);
    ok(ov.pe === 'none', `遮罩不再拦截点击（pointer-events=${ov.pe}）`);

    await clickSel('#searchInput');
    await tick(200);
    await js(`document.getElementById('searchInput').value = ''`);
    await ime('林');
    ok((await val('#searchInput')) === '林', '删除后顶栏搜索框仍能正常输入');
  } catch (e) {
    fails++;
    console.error('\x1b[31m异常\x1b[0m', e);
  }

  console.log('');
  console.log(fails === 0 ? '\x1b[32m===== ALL PASSED =====\x1b[0m' : `\x1b[31m===== ${fails} FAILED =====\x1b[0m`);
  console.log(`沙箱：${sandbox}`);
  app.exit(fails === 0 ? 0 : 1);
}

run();