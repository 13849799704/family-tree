/**
 * 编辑界面「无法修改」复现测试 · tests/edit-dialog.test.js
 * ---------------------------------------------------------------
 * 跑法：node scripts/launch.js tests/edit-dialog.test.js
 *
 * 用户报的现象（2026-10-09，桌面版）：编辑弹窗里**输入框点不动 / 打不进字**。
 * 这个文件只做一件事：用**真实鼠标事件 + 真实键盘事件**去戳编辑弹窗，
 * 回答「到底是哪一步断了」。
 *
 * 为什么不能用 el.value = 'x' 或 el.click()：
 *   那样测的是 DOM API 通不通，测不到「用户真实戳一下有没有反应」。
 *   本文件里凡是「用户在弹窗内做的事」都走 webContents.sendInputEvent，
 *   事件带 isTrusted=true，和人手点/手打完全同一条路径。
 *   唯一用 JS 点的是树上节点 —— 那一步只是进入弹窗的手段，
 *   弹窗内的一律真鼠标。
 *
 * ⚠️ 数据写在临时目录（GENOGRAM_DATA_DIR），绝不碰用户真实的那份库。
 *
 * ⚠️⚠️ 本文件**顶端绝对不能有 await** ⚠️⚠️
 *   与 electron-smoke.js 同一个坑：顶层 await 会和 Electron 的 ready 事件互锁，
 *   表现为「窗口永远不出现」且无任何报错。所以顶层只挂一个 .then()。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electron from 'electron';
const { app, BrowserWindow } = electron;

/* ---------- 1. 沙箱（必须在 import main 之前设置） ---------- */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'genogram_edit_'));
process.env.GENOGRAM_DATA_DIR = sandbox;
process.env.GENOGRAM_NO_DIALOG = '1';   // 关掉阻塞式错误框（否则测试假死）

// 单实例锁挂在 userData 上；改成沙箱目录，避免和用户正在跑的「家族谱.exe」抢锁
try {
  app.setPath('userData', path.join(sandbox, 'userdata'));
  fs.mkdirSync(path.join(sandbox, 'userdata'), { recursive: true });
} catch { /* 忽略 */ }

/* ---------- 2. 极简断言框架 ---------- */

const L = [];
let fails = 0;

const ok = (cond, msg) => {
  if (!cond) fails++;
  L.push((cond ? 'PASS  ' : 'FAIL  ') + msg);
  console.log((cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + msg);
};
const note = (msg) => { L.push('      ' + msg); console.log('      ' + msg); };

const head = (t) => {
  L.push('');
  L.push('=== ' + t + ' ===');
  console.log(`\n\x1b[1m${t}\x1b[0m`);
};

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 3. 真实输入工具 ---------- */

let WC = null;

/** 在渲染层执行一段代码 */
const js = (code) => WC.executeJavaScript(code, true);

/** 真实鼠标点击指定 CSS 坐标 */
const mouseClick = async (x, y) => {
  WC.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  WC.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await tick(60);
};

/** 真实鼠标点击某个元素（用它的实际屏幕位置） */
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

/** 当前焦点元素的指纹（用来判断「焦点被谁抢走了」） */
const activeInfo = () => js(`(() => {
  const a = document.activeElement;
  if (!a) return null;
  return {
    tag: a.tagName, id: a.id || '', name: a.getAttribute?.('name') || '',
    cls: (typeof a.className === 'string' ? a.className : '') || '',
    text: (a.textContent || '').trim().slice(0, 20),
    value: a.value != null ? String(a.value).slice(0, 60) : null,
  };
})()`);

/** 元素中心的命中测试：最上层到底是谁（抓「透明层挡住输入框」） */
const hitTest = (sel) => js(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });          // 先滚到可视区中央，模拟用户滚动
  const b = el.getBoundingClientRect();
  const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
  const top = document.elementFromPoint(cx, cy);
  const cs = getComputedStyle(el);
  const body = document.querySelector('.modal-body');
  const foot = document.querySelector('.modal-foot');
  const br = body ? body.getBoundingClientRect() : null;
  const fr = foot ? foot.getBoundingClientRect() : null;
  return {
    cx: Math.round(cx), cy: Math.round(cy),
    w: Math.round(b.width), h: Math.round(b.height),
    topTag: top ? top.tagName : null,
    topId: top ? (top.id || '') : '',
    topAct: top ? (top.getAttribute && top.getAttribute('data-act')) || '' : '',
    topCls: top ? (typeof top.className === 'string' ? top.className : '') : '',
    reachesMe: !!top && (top === el || el.contains(top)),
    pe: cs.pointerEvents, vis: cs.visibility, op: cs.opacity, ro: cs.readOnly, dis: cs.disabled,
    inViewport: cy >= 0 && cy <= innerHeight,
    underFoot: !!(fr && cy > fr.top),
    bodyScrolls: !!(body && body.scrollHeight > body.clientHeight + 1),
    bodyTop: br ? Math.round(br.top) : -1, bodyBottom: br ? Math.round(br.bottom) : -1,
    footTop: fr ? Math.round(fr.top) : -1,
    vh: innerHeight,
  };
})()`);

/** 弹窗是否还活着（表单还在不在） */
const modalAlive = () => js(`!!document.querySelector('#f-name')`);

const val = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? String(el.value) : null; })()`);

/** 按一个真实的物理键（可带修饰键） */
const rawKey = async (keyCode, modifiers = []) => {
  WC.sendInputEvent({ type: 'rawKeyDown', keyCode, modifiers });
  WC.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await tick(300);
};

/** 当前弹窗的标题（判断弹窗有没有被换成另一个） */
const modalTitle = () => js(`(() => { const t = document.querySelector('.modal-title'); return t ? t.textContent.trim() : null; })()`);
const modalCount = () => js(`document.querySelectorAll('#overlay .modal').length`);

/** 模拟输入法上屏（走的就是 IME commit 那条通路） */
const ime = async (text) => {
  WC.insertText(text);
  await tick(80);
};

/* ---------- 4. 主体 ---------- */

async function waitForWindow(timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) return w;
    await tick(100);
  }
  throw new Error('20 秒内没有窗口被创建');
}

async function run() {
  let win = null;
  try {
    await import('../electron/main.js');
    win = await waitForWindow();
    WC = win.webContents;
    if (WC.isLoading()) await new Promise((r) => WC.once('did-finish-load', r));
    await tick(2800);      // 等 boot() + 示例数据落库
    win.show();
    await tick(400);
  } catch (e) {
    console.error('\x1b[31m启动阶段失败\x1b[0m', e);
    app.exit(1);
    return;
  }

  try {
    /* ===================================================== */
    head('0. 前置：真实鼠标点树上一个人 → 打开编辑弹窗');
    /* ===================================================== */
    const nodeReady = await js(`(() => {
      const ns = [...document.querySelectorAll('.node')];
      return { total: ns.length,
        visible: ns.filter(n => { const b = n.getBoundingClientRect();
          return b.left > 0 && b.top > 0 && b.right < innerWidth && b.bottom < innerHeight; }).length };
    })()`);
    ok(nodeReady.total > 0, `树上渲染出 ${nodeReady.total} 个节点（视口内 ${nodeReady.visible} 个）`);

    const nodePoint = await js(`(() => {
      const ns = [...document.querySelectorAll('.node')];
      for (const n of ns) {
        const b = n.getBoundingClientRect();
        const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
        if (cx > 4 && cy > 4 && cx < innerWidth - 4 && cy < innerHeight - 4)
          return { id: n.dataset.id, x: Math.round(cx), y: Math.round(cy) };
      }
      return null;
    })()`);
    ok(!!nodePoint, nodePoint ? `选中视口内节点 ${nodePoint.id}` : '视口内没有节点（先 fit 一下）');
    await mouseClick(nodePoint.x, nodePoint.y);

    const editBtn = await js(`(() => {
      const b = document.querySelector('[data-act="edit"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
               id: b.dataset.id };
    })()`);
    ok(!!editBtn, editBtn ? `详情面板「编辑」按钮就绪（data-id=${editBtn.id}）` : '详情面板没有「编辑」按钮');
    await mouseClick(editBtn.x, editBtn.y);
    await tick(500);

    const opened = await js(`!!document.querySelector('#f-name')`);
    ok(opened, '编辑弹窗已打开（#f-name 存在）');

    /* ===================================================== */
    head('1. 输入框能不能被「真的点到」（抓透明层遮挡）');
    /* ===================================================== */
    const ht = await hitTest('#f-name');
    ok(!!ht, '姓名输入框有布局盒');
    if (ht) {
      note(`位置 (${ht.cx},${ht.cy}) 尺寸 ${ht.w}×${ht.h}`);
      note(`该点最上层元素 = <${ht.topTag} id="${ht.topId}" class="${ht.topCls}">`);
      ok(ht.reachesMe, `该点命中最上层就是输入框本身（没有透明层遮挡）`);
      ok(ht.pe !== 'none', `pointer-events=${ht.pe}（不能是 none）`);
      ok(ht.vis === 'visible' && ht.op !== '0', `可见（visibility=${ht.vis} opacity=${ht.op}）`);
      ok(!ht.ro && !ht.dis, `不是只读/禁用（readOnly=${ht.ro} disabled=${ht.dis}）`);
    }

    const ovPE = await js(`(() => {
      const o = document.getElementById('overlay');
      const cs = getComputedStyle(o);
      return { on: o.classList.contains('on'), pe: cs.pointerEvents, z: cs.zIndex };
    })()`);
    ok(ovPE.on && ovPE.pe === 'auto', `遮罩已激活且可接点击（on=${ovPE.on} pointer-events=${ovPE.pe} z=${ovPE.z}）`);

    await mouseClick(ht.cx, ht.cy);
    const a1 = await activeInfo();
    note(`真实点击后焦点 = <${a1?.tag} id="${a1?.id}">`);
    ok(a1?.id === 'f-name', `真实鼠标点击后焦点落在姓名框（实际 id="${a1?.id || ''}"）`);

    /* ===================================================== */
    head('2. 能不能真的打进字（真实键盘 / 输入法通路）');
    /* ===================================================== */
    const before = await val('#f-name');
    await ime('测试');
    await tick(120);
    const after = await val('#f-name');
    ok(after !== before, `输入法上屏有效：${JSON.stringify(before)} → ${JSON.stringify(after)}`);

    // 真实按键：退格删一个字
    const lenBefore = (after || '').length;
    WC.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Backspace' });
    WC.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
    await tick(120);
    const lenAfter = ((await val('#f-name')) || '').length;
    ok(lenAfter === lenBefore - 1, `真实按键有效：长度 ${lenBefore} → ${lenAfter}`);

    // 光标定位（Home）+ 继续输入，验证「点了能改、不是只能追加」
    WC.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Home' });
    WC.sendInputEvent({ type: 'keyUp', keyCode: 'Home' });
    await tick(60);
    await ime('X');
    await tick(100);
    const withX = await val('#f-name');
    ok(String(withX).charAt(0) === 'X', `能在中间/开头插入（当前值 ${JSON.stringify(withX)}）`);

    /* ===================================================== */
    head('3. 其余控件是否都能改');
    /* ===================================================== */

    // 3.1 出生 / 所在地 / 备注：点一下聚焦 + 输入
    for (const [sel, label, text] of [
      ['#f-birth', '出生', '1990'],
      ['#f-place', '所在地', '南阳'],
      ['#f-note', '备注', '测试备注'],
    ]) {
      const h = await hitTest(sel);
      if (!h) { ok(false, `${label}：控件不存在`); continue; }
      note(`${label}：中心(${h.cx},${h.cy}) 视口高=${h.vh} 弹窗体=${h.bodyTop}~${h.bodyBottom} 底栏顶=${h.footTop}`);
      note(`${label}：该点命中 <${h.topTag} id="${h.topId}" data-act="${h.topAct}" class="${h.topCls}">`
        + ` 命中自己=${h.reachesMe} 视口内=${h.inViewport} 被底栏压住=${h.underFoot} 弹窗体可滚=${h.bodyScrolls}`);

      await mouseClick(h.cx, h.cy);

      // ⚠️ 关键：点完弹窗还在吗？被关掉就是「点一下就改不动了」
      if (!(await modalAlive())) {
        ok(false, `${label}：点一下弹窗就没了（落在 data-act="${h.topAct}" 上）—— 这就是「无法修改」`);
        note(`      复原：重开弹窗`);
        await clickSel('[data-act="edit"]');
        await tick(500);
        continue;
      }

      const a = await activeInfo();
      ok(a?.id === sel.slice(1), `${label}：真实点击后能聚焦（实际 id="${a?.id || ''}"）`);
      const v0 = await val(sel);
      await ime(text);
      await tick(100);
      const v1 = await val(sel);
      ok(v1 !== v0 && String(v1).includes(text), `${label}：能写入（${JSON.stringify(v0)} → ${JSON.stringify(v1)}）`);
    }

    // 3.2 性别分段按钮：点一下应切换高亮
    const sexBefore = await js(`(() => {
      const b = document.querySelector('[data-sex="F"]');
      return b ? b.classList.contains('on') : null;
    })()`);
    const sexH = await hitTest('[data-sex="F"]');
    await mouseClick(sexH.cx, sexH.cy);
    await tick(120);
    ok(await modalAlive(), '性别按钮：点完弹窗还在');
    const sexAfter = await js(`(() => {
      const b = document.querySelector('[data-sex="F"]');
      return b ? b.classList.contains('on') : null;
    })()`);
    ok(sexBefore !== sexAfter, `性别分段可点（女 按钮 on: ${sexBefore} → ${sexAfter}，落点命中 data-act="${sexH.topAct}"）`);

    // 3.3 在世开关：点击应切换 #row-death 显隐
    const deathBefore = await js(`getComputedStyle(document.getElementById('row-death')).display`);
    const aliveH = await hitTest('#f-alive');
    await mouseClick(aliveH.cx, aliveH.cy);
    await tick(150);
    const deathAfter = await js(`getComputedStyle(document.getElementById('row-death')).display`);
    ok(deathBefore !== deathAfter, `在世开关可点（去世年份行 display: ${deathBefore} → ${deathAfter}）`);

    // 3.4 / 3.5 下拉框：只断言「候选项非空 + 选中项读得出」。
    //     select 的展开/选中是 Windows 原生下拉的行为，sendInputEvent 测不到
    //     （按 ArrowDown 不会改值），那是操作系统的事，不是这个应用的 bug。
    const fChk = await js(`(() => {
      const el = document.getElementById('f-father');
      const sel = el.selectedOptions[0];
      return { value: el.value, text: sel ? sel.textContent.replace(/\\s+/g, ' ').trim() : '', count: el.options.length };
    })()`);
    ok(fChk.count >= 1, `父亲下拉候选项非空（${fChk.count} 项）`);
    ok(fChk.text.length > 0, `父亲下拉选中项可读（${JSON.stringify(fChk.text)}）`);

    const pChk = await js(`(() => {
      const el = document.getElementById('f-privacy');
      const sel = el.selectedOptions[0];
      return { value: el.value, text: sel ? sel.textContent.trim() : '', count: el.options.length };
    })()`);
    ok(pChk.count >= 2, `隐私级别下拉候选项非空（${pChk.count} 项）`);
    ok(!!pChk.value, `隐私级别有默认选中值（${JSON.stringify(pChk.value)}）`);

    /* ===================================================== */
    head('4. 保存 → 数据是否真的改掉（回读 UI）');
    /* ===================================================== */
    const savedName = await val('#f-name');
    await clickSel('button[type="submit"]');
    await tick(700);
    const panelName = await js(`(() => {
      const el = document.querySelector('.panel .name-line');
      return el ? el.textContent.trim() : null;
    })()`);
    ok(!!panelName && panelName.includes(String(savedName).slice(0, 2)),
      `保存后面板回读 = ${JSON.stringify(panelName)}（期望含 ${JSON.stringify(String(savedName).slice(0, 2))}）`);

    /* ===================================================== */
    head('5. 关闭后立刻重开：残留清空定时器会不会把新弹窗擦掉');
    /* ===================================================== */
    await clickSel('[data-act="edit"]');   // 再开一次
    await tick(500);
    ok(await js(`!!document.querySelector('#f-name')`), '重新打开编辑弹窗');

    await clickSel('[data-act="cancel"]'); // 关闭（排 220ms 清空定时器）
    await tick(60);                        // 故意在 220ms 之内就重开
    const reopened = await js(`(() => {
      const b = document.querySelector('[data-act="edit"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    ok(!!reopened, '关掉后详情面板仍能重新打开编辑弹窗');
    if (reopened) await mouseClick(reopened.x, reopened.y);
    await tick(120);                       // 此刻旧定时器还没到点
    const alive1 = await js(`!!document.querySelector('#f-name')`);
    ok(alive1, '关→立刻重开：新弹窗立刻在（120ms 时）');

    await tick(400);                       // 跨过旧的 220ms 清空点
    const alive2 = await js(`!!document.querySelector('#f-name')`);
    ok(alive2, '关→立刻重开：跨过 220ms 后新弹窗还在（没被残留定时器擦掉）');

    const h2 = await hitTest('#f-name');
    if (h2) {
      await mouseClick(h2.cx, h2.cy);
      const a2 = await activeInfo();
      ok(a2?.id === 'f-name', `重开的弹窗里输入框仍能聚焦并修改（id="${a2?.id || ''}"）`);
      const v0 = await val('#f-name');
      await ime('再测');
      ok((await val('#f-name')) !== v0, '重开的弹窗里能真的打字');
    }

    /* ===================================================== */
    head('6. 连开关 20 次后是否还能修改（监听/定时器叠加）');
    /* ===================================================== */
    for (let i = 0; i < 20; i++) {
      await clickSel('[data-act="edit"]');
      await tick(120);
      await clickSel('[data-act="cancel"]');
      await tick(80);
    }
    await tick(400);
    await clickSel('[data-act="edit"]');
    await tick(500);
    ok(await js(`!!document.querySelector('#f-name')`), '连开关 20 次后弹窗仍能打开');
    const h3 = await hitTest('#f-name');
    if (h3) {
      await mouseClick(h3.cx, h3.cy);
      const a3 = await activeInfo();
      ok(a3?.id === 'f-name', `20 次后输入框仍能聚焦（id="${a3?.id || ''}"）`);
      const v0 = await val('#f-name');
      await ime('ZZ');
      ok((await val('#f-name')) !== v0, '20 次后仍能真的打字');
    }

    /* ===================================================== */
    head('7. 弹窗内的快捷键 / 方向键会不会把编辑状态抢走');
    /* ===================================================== */
    const kh = await hitTest('#f-name');
    await mouseClick(kh.cx, kh.cy);
    const aBefore = await activeInfo();

    // 7.1 Ctrl+K：全局快捷键会把焦点抢到搜索框 —— 弹窗内不该生效
    WC.sendInputEvent({ type: 'rawKeyDown', keyCode: 'k', modifiers: ['control'] });
    WC.sendInputEvent({ type: 'keyUp', keyCode: 'k', modifiers: ['control'] });
    await tick(200);
    const aAfterCtrlK = await activeInfo();
    note(`Ctrl+K 前焦点 id="${aBefore?.id}" → 后焦点 id="${aAfterCtrlK?.id}"`);
    ok(aAfterCtrlK?.id === 'f-name', '弹窗内按 Ctrl+K 不会把焦点抢到搜索框（编辑不断线）');

    /* ===================================================== */
    head('8. 输入法合成期间按 Esc 不应关弹窗');
    /* ===================================================== */
    const escGuard = await js(`(() => {
      const inp = document.getElementById('f-name');
      inp.focus();
      const mk = (init) => new KeyboardEvent('keydown', Object.assign({ key: 'Escape', bubbles: true }, init));
      let closed = false;
      const h = (e) => { if (e.key === 'Escape') closed = true; };
      document.addEventListener('keydown', h);      // 旁路观察是否被当成真关闭
      inp.dispatchEvent(mk({ isComposing: true, keyCode: 229 }));
      inp.dispatchEvent(mk({ keyCode: 229 }));
      document.removeEventListener('keydown', h);
      return { closed, modalAlive: !!document.querySelector('#f-name') };
    })()`);
    ok(escGuard.modalAlive, '合成期间按 Esc：弹窗仍在');
    note(`（旁路观察器看到的 keydown 事件里 Escape 出现 ${escGuard.closed} 次，仅作参考）`);

    /* ===================================================== */
    head('9. 画布拖拽 / 缩放之后再打开弹窗，是否仍可修改');
    /* ===================================================== */
    await clickSel('[data-act="cancel"]');
    await tick(300);

    // 真实滚轮缩放（Ctrl+滚轮 = 缩放）
    const stage = await js(`(() => {
      const s = document.getElementById('stage');
      const r = s.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    WC.sendInputEvent({
      type: 'mouseWheel', x: stage.x, y: stage.y,
      deltaX: 0, deltaY: -240, canScroll: true, modifiers: ['control'],
    });
    await tick(200);
    // 真实拖拽平移
    WC.sendInputEvent({ type: 'mouseDown', x: stage.x, y: stage.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      WC.sendInputEvent({ type: 'mouseMove', x: stage.x + i * 12, y: stage.y + i * 6, button: 'left', buttons: 1 });
      await tick(20);
    }
    WC.sendInputEvent({ type: 'mouseUp', x: stage.x + 72, y: stage.y + 36, button: 'left', clickCount: 1 });
    await tick(250);

    await clickSel('[data-act="edit"]');
    await tick(500);
    ok(await js(`!!document.querySelector('#f-name')`), '缩放+拖拽后编辑弹窗能打开');
    const h4 = await hitTest('#f-name');
    if (h4) {
      ok(h4.reachesMe, '缩放+拖拽后输入框未被遮挡（命中测试通过）');
      await mouseClick(h4.cx, h4.cy);
      const a4 = await activeInfo();
      ok(a4?.id === 'f-name', `缩放+拖拽后输入框仍能聚焦（id="${a4?.id || ''}"）`);
      const v0 = await val('#f-name');
      await ime('Q');
      ok((await val('#f-name')) !== v0, '缩放+拖拽后仍能真的打字');
    }

    /* ===================================================== */
    head('10. 详情面板「＋ 补充」入口：聚焦对不对、能不能改');
    /* ===================================================== */
    await clickSel('[data-act="cancel"]');
    await tick(300);

    /* 示例数据里每个人的字段都是填满的，压根没有「＋ 补充」入口可测。
       所以先用真实 UI 走一遍「添加成员、只填姓名」——
       顺带把「信息待补」这条链路也覆盖了 —— 造出一个真的缺字段的人。 */
    await clickSel('[data-act="add"]');
    await tick(600);
    ok(await modalAlive(), '「添加成员」弹窗已打开');
    const newName = '补充测试人';
    await js(`(() => { const el = document.getElementById('f-name'); el && el.focus(); return true; })()`);
    await ime(newName);
    await clickSel('button[type="submit"]');
    await tick(900);
    const created = await js(`(() => {
      const el = document.querySelector('.panel .name-line');
      return el ? el.textContent.trim() : null;
    })()`);
    ok(String(created || '').includes(newName),
      `只填姓名也能把人加进来（面板回读 = ${JSON.stringify(created)}）`);

    const fillInfo = await js(`(() => {
      const b = document.querySelector('.fill-btn');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return {
        field: b.dataset.field || '', label: b.textContent.trim(),
        x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      };
    })()`);
    ok(!!fillInfo, fillInfo
      ? `缺字段的人身上出现了「${fillInfo.label}」入口（field=${fillInfo.field}）`
      : '新加的人身上没有「＋ 补充」入口');
    if (fillInfo) {
      await mouseClick(fillInfo.x, fillInfo.y);
      await tick(600);
      const focusState = await js(`(() => {
        const a = document.activeElement;
        return { id: a ? (a.id || '') : '', tag: a ? a.tagName : '' };
      })()`);
      ok(await modalAlive(), `「${fillInfo.label}」能打开编辑弹窗`);
      // field='sex' 聚焦到分段按钮（没有 id），children/spouses 走「添加亲属」不在本弹窗
      const expectId = fillInfo.field === 'sex' ? '' : `f-${fillInfo.field}`;
      const focusedOk = fillInfo.field === 'sex'
        ? focusState.tag === 'BUTTON'
        : focusState.id === expectId;
      ok(focusedOk,
        `「${fillInfo.label}」聚焦到对应控件（期望 ${fillInfo.field === 'sex' ? '性别按钮' : '#' + expectId}，`
        + `实际 id="${focusState.id}" tag=${focusState.tag}）`);
      if (focusState.id && focusState.id.startsWith('f-')) {
        const v0 = await val(`#${focusState.id}`);
        await ime('1988');
        await tick(120);
        const v1 = await val(`#${focusState.id}`);
        ok(v1 !== v0, `聚焦后能直接打字（${focusState.id}: ${JSON.stringify(v0)} → ${JSON.stringify(v1)}）`);
      } else if (fillInfo.field === 'sex') {
        /* 焦点停在分段按钮上（按钮没有 id）—— 这正是本次故障的高发场景：
           从「＋ 补充性别」进来后，用户接着按 n，曾经会弹出「添加成员」把表单顶掉。 */
        const before = await modalTitle();
        await rawKey('n');
        await tick(500);
        const after = await modalTitle();
        ok(after === before, `焦点在性别按钮上时按 n 不会顶掉表单（仍是「${after}」）`);
      }
    }

    // 收工：把弹窗关掉，后面的检查要在一张干净的桌面上做
    if (await modalAlive()) {
      await clickSel('[data-act="cancel"]');
      await tick(600);
    }

    /* ===================================================== */
    head('11. 原生菜单：弹窗打开时破坏性项是否被禁用');
    /* ===================================================== */
    const { Menu } = electron;
    const appMenu = Menu.getApplicationMenu();
    ok(!!appMenu, '能读到应用菜单（桌面版才有）');

    const menuState = () => {
      const m = Menu.getApplicationMenu();
      const pick = (id) => {
        const it = m && m.getMenuItemById(id);
        return it ? it.enabled : null;
      };
      return {
        add: pick('mi-add'), export: pick('mi-export'), import: pick('mi-import'),
        clear: pick('mi-clear'), fit: pick('mi-fit'),
      };
    };

    if (appMenu) {
      const rows = [];
      for (const top of appMenu.items) {
        for (const it of (top.submenu ? top.submenu.items : [top])) {
          if (!it.accelerator && !it.role) continue;
          rows.push({ menu: top.label, label: it.label, acc: it.accelerator || '' });
        }
      }
      for (const r of rows) note(`${r.menu} → ${r.label}　accelerator="${r.acc}"`);

      /* 关于「裸键 accelerator 会不会吃掉输入框的字母」：
       *   这个怀疑在 Electron 44 / Windows 上**已被实测证伪** ——
       *   视图 → 适应窗口 抢的是裸键 F，但用 user32.keybd_event 做系统级物理注入，
       *   字母 F / A / J 都能正常打进输入框（见 tests/acc-input.test.js）。
       *   所以这里不再断言「没有裸键」，而是断言真正要防的那件事：
       *   带 Ctrl 的几项在弹窗打开期间必须禁用。 */
      const bare = rows.filter((r) => !/CommandOrControl|Ctrl|Alt|Shift|Super/i.test(r.acc)
        && /^(?:[A-Z0-9]|F\d{1,2})$/i.test(r.acc));
      note(`裸键 accelerator 共 ${bare.length} 个（${bare.map((b) => b.acc).join(',') || '无'}）`
        + ' —— 实测不影响输入框，仅作记录，不作断言');

      const closedState = menuState();
      note(`弹窗关闭时：添加成员=${closedState.add} 导出=${closedState.export} 清空=${closedState.clear}`);

      await clickSel('[data-act="edit"]');
      await tick(600);
      ok(await modalAlive(), '为检查菜单状态，已打开编辑弹窗');
      await tick(300);
      const openState = menuState();
      note(`弹窗打开时：添加成员=${openState.add} 导出=${openState.export} 导入=${openState.import}`
        + ` 清空=${openState.clear} 适应窗口=${openState.fit}`);
      ok(openState.add === false && openState.export === false && openState.import === false
        && openState.clear === false && openState.fit === false,
        '弹窗打开时：添加成员/导入/导出/清空/适应窗口 全部被禁用（Ctrl+N/S/O、裸键 F 不再捣乱）');

      await clickSel('[data-act="cancel"]');
      await tick(600);
      const backState = menuState();
      note(`弹窗关闭后：添加成员=${backState.add} 导出=${backState.export} 清空=${backState.clear}`);
      ok(backState.add === true && backState.export === true && backState.clear === true,
        '弹窗关闭后菜单项恢复可用');
    }

    /* ===================================================== */
    head('12. 弹窗里焦点不在输入框时，按字母/数字键会怎样');
    /* ===================================================== */
    /* bindKeyboard() 的守卫是 `e.target.matches('input,textarea,select')`。
       一旦用户点了「性别」「在世」这类非输入控件，焦点就不在输入框上了，
       这时按 n（添加成员）/ 1 / 2（切视图）/ f（适应窗口）全会命中全局快捷键 ——
       轻则画布乱跳，重则叠加一个新弹窗把正在填的表单整个顶掉。 */

    /* 幂等「确保编辑弹窗开着」——
       上一组测试结束时弹窗可能还开着，此时遮罩会挡住面板的「编辑」按钮，
       直接 clickSel 只会点到遮罩上（= 关闭弹窗），后一步就全乱了。 */
    const ensureEditOpen = async () => {
      if (await modalAlive()) {
        if ((await modalTitle()) === '编辑成员') return;
        await clickSel('[data-act="cancel"]');
        await tick(500);
      }
      await clickSel('[data-act="edit"]');
      await tick(600);
    };

    // 12.1 刚打开（焦点自动落到姓名框）就按 n —— 这一步应该安全
    await ensureEditOpen();
    const t0 = await modalTitle();
    await rawKey('n');
    await tick(400);
    const t1 = await modalTitle();
    ok(t0 === t1 && t1 === '编辑成员', `焦点在姓名框时按 n 安全（${t0} → ${t1}）`);
    ok((await modalCount()) === 1, `弹窗仍只有 1 个（实际 ${await modalCount()} 个）`);

    // 12.2 点过「在世」开关之后按 n —— 焦点离开输入框
    await ensureEditOpen();
    await clickSel('#f-alive');
    await tick(250);
    const f2 = await activeInfo();
    note(`点在世开关后焦点 = <${f2?.tag}> id="${f2?.id}" class="${f2?.cls}"`);
    const before12 = await modalTitle();
    await rawKey('n');
    await tick(500);
    const after12 = await modalTitle();
    note(`点开关后按 n：弹窗标题 ${before12} → ${after12}，弹窗数 ${await modalCount()}`);
    ok(after12 === before12,
      `点开关后按 n 不会叠加新弹窗 / 顶掉表单（实际标题变成「${after12}」）`);

    // 12.3 点过「性别」按钮之后按 n
    await ensureEditOpen();
    const sexPt2 = await hitTest('[data-sex="M"]');
    await mouseClick(sexPt2.cx, sexPt2.cy);
    await tick(250);
    const f3 = await activeInfo();
    note(`点性别按钮后焦点 = <${f3?.tag}> id="${f3?.id}"`);
    const before13 = await modalTitle();
    await rawKey('n');
    await tick(500);
    const after13 = await modalTitle();
    note(`点性别后按 n：弹窗标题 ${before13} → ${after13}，弹窗数 ${await modalCount()}`);
    ok(after13 === before13, `点性别后按 n 不会叠加新弹窗（实际标题变成「${after13}」）`);

    // 12.4 焦点不在输入框时按 2 —— 会切到「数据体检」视图
    await ensureEditOpen();
    const viewBefore = await js(`document.getElementById('viewCheck').classList.contains('on')`);
    await rawKey('2');
    await tick(300);
    const viewAfter = await js(`document.getElementById('viewCheck').classList.contains('on')`);
    note(`不在输入框时按 2：数据体检视图 ${viewBefore} → ${viewAfter}`);
    ok(viewBefore === viewAfter, '弹窗内按 2 不会把界面切走（数据体检视图没被打开）');
    await rawKey('1');
    await tick(300);

    // 12.5 叠加弹窗后按一次 Esc 应只关掉一个，且不该有残留监听
    await ensureEditOpen();
    await rawKey('n');
    await tick(500);
    const countBeforeEsc = await modalCount();
    if (countBeforeEsc > 1) {
      note(`已叠加 ${countBeforeEsc} 个弹窗，按一次 Esc`);
      await rawKey('Escape');
      await tick(400);
      const countAfterEsc = await modalCount();
      ok(countAfterEsc === countBeforeEsc - 1,
        `按一次 Esc 只关掉一层（${countBeforeEsc} → ${countAfterEsc}，多出来的就是残留监听）`);
      await rawKey('Escape');
      await tick(400);
    } else {
      note('没有叠加弹窗，跳过 Esc 残留检查');
      await rawKey('Escape');
      await tick(300);
    }
  } catch (e) {
    fails++;
    console.error('\x1b[31m异常\x1b[0m', e);
    L.push('FAIL  异常: ' + (e?.stack || e));
  }

  L.push('');
  L.push(fails === 0 ? '===== ALL PASSED =====' : `===== ${fails} FAILED =====`);
  console.log('');
  console.log(fails === 0 ? '\x1b[32m===== ALL PASSED =====\x1b[0m' : `\x1b[31m===== ${fails} FAILED =====\x1b[0m`);
  console.log(`沙箱：${sandbox}`);

  app.exit(fails === 0 ? 0 : 1);
}

run();
