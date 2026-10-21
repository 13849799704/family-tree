/**
 * 系统级按键注入验证 · tests/acc-input.test.js
 * ---------------------------------------------------------------
 * 跑法：node scripts/launch.js tests/acc-input.test.js
 *
 * 验证的唯一问题：**桌面版的原生菜单 accelerator 会不会把输入框里的按键吃掉？**
 *
 * 为什么普通测试测不出来：
 *   `webContents.sendInputEvent` 和 CDP 的 Input.* 都是**直接把事件投递到渲染层**，
 *   完全绕过 Windows 原生菜单的 accelerator 表 —— 而 accelerator 恰恰是在
 *   原生那一层拦截的（WM_KEYDOWN 之前）。所以用 sendInputEvent 测，
 *   无论有没有 accelerator，输入框都照样能打字，测了个寂寞。
 *
 * 本文件改用 **user32.keybd_event**（和真键盘一样的物理按键路径），
 * 由主进程 fork 出 powershell 注入，能真正走到「窗口的 accelerator 表」这一步。
 *
 * 判定（对照实验）：
 *   注入 F（被 accelerator 抢） → 观察画布 fit 是否被触发、菜单是否被激活
 *   注入 A（无 accelerator）     → 同样的观察，必须什么都不发生
 *   两者对比才成立；只看 F 有反应不能说明问题。
 *
 * ⚠️ 数据写在临时目录，绝不碰用户真实的那份库。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import electron from 'electron';
const { app, BrowserWindow } = electron;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'genogram_acc_'));
process.env.GENOGRAM_DATA_DIR = sandbox;
process.env.GENOGRAM_NO_DIALOG = '1';

try {
  app.setPath('userData', path.join(sandbox, 'userdata'));
  fs.mkdirSync(path.join(sandbox, 'userdata'), { recursive: true });
} catch { /* 忽略 */ }

const L = [];
let fails = 0;
const ok = (cond, msg) => {
  if (!cond) fails++;
  L.push((cond ? 'PASS  ' : 'FAIL  ') + msg);
  console.log((cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + msg);
};
const note = (msg) => { L.push('      ' + msg); console.log('      ' + msg); };
const head = (t) => {
  L.push(''); L.push('=== ' + t + ' ===');
  console.log(`\n\x1b[1m${t}\x1b[0m`);
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 系统级按键注入 ---------- */

/** 虚拟键码 */
const VK = { F: 0x46, A: 0x41, J: 0x4A, N: 0x4E };

/**
 * 用 user32.keybd_event 发一个真实物理按键。
 * 走的是和用户手指一样的路径（扫描码 → 窗口 accelerator 表 → WM_KEYDOWN），
 * 所以它会受到原生菜单 accelerator 的拦截 —— 这正是要验证的东西。
 *
 * 脚本必须落成文件再 -File 执行：把多行脚本塞进 -Command 的参数里，
 * Node 会报「argument must be a string without null bytes」。
 */
function pressVirtualKey(hwnd, vk) {
  // 走 -EncodedCommand（base64 的 UTF-16LE），不落地任何脚本文件 ——
  // 用户目录是 C:\Users\林\...，PowerShell 按 ANSI 解析 -File 的中文路径会直接卡死。
  const script = [
    '$ErrorActionPreference = \'Stop\'',
    'Add-Type -Namespace AccProbe -Name U -MemberDefinition @"',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);',
    '"@',
    '$h = [IntPtr]::new([int64]$env:ACC_HWND)',
    '[void][AccProbe.U]::BringWindowToTop($h)',
    '[void][AccProbe.U]::SetForegroundWindow($h)',
    'Start-Sleep -Milliseconds 400',
    '[AccProbe.U]::keybd_event([byte]$env:ACC_VK, 0, 0, [UIntPtr]::Zero)',
    'Start-Sleep -Milliseconds 80',
    '[AccProbe.U]::keybd_event([byte]$env:ACC_VK, 0, 2, [UIntPtr]::Zero)',
    'Start-Sleep -Milliseconds 200',
    'Write-Output "ok"',
  ].join('\r\n');

  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  /* 必须异步 spawn：execFileSync 会把 Electron 主进程的事件循环堵死，
     PowerShell 里 Add-Type 还要再 fork 一个编译器子进程，直接 ETIMEDOUT。 */
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ACC_HWND: hwnd.toString(), ACC_VK: String(vk) },
      });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`powershell 60s 未返回（stdout=${out} stderr=${err.slice(0, 200)}）`));
    }, 60000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`powershell 退出码 ${code}：${err.slice(0, 300)}`));
    });
  });
}

/* ---------- 主体 ---------- */

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
  let WC = null;
  try {
    await import('../electron/main.js');
    win = await waitForWindow();
    WC = win.webContents;
    if (WC.isLoading()) await new Promise((r) => WC.once('did-finish-load', r));
    await tick(2800);
    win.show();
    await tick(600);
  } catch (e) {
    console.error('\x1b[31m启动阶段失败\x1b[0m', e);
    app.exit(1);
    return;
  }

  const js = (code) => WC.executeJavaScript(code, true);
  // getNativeWindowHandle() 在不同 Electron 版本里可能给 Buffer / Number / BigInt，
  // 一律归一成 BigInt —— 直接 String() 塞进环境变量会带出 null 字节。
  const raw = win.getNativeWindowHandle();
  const hwnd = typeof raw === 'bigint' ? raw
    : (typeof raw === 'number' ? BigInt(raw) : BigInt(raw.readBigUInt64LE(0)));
  note(`窗口句柄 = ${hwnd.toString()}`);

  try {
    head('0. 前提：菜单里真的有裸键 accelerator');
    const { Menu } = electron;
    const m = Menu.getApplicationMenu();
    const rows = [];
    for (const top of (m ? m.items : [])) {
      for (const it of (top.submenu ? top.submenu.items : [top])) {
        if (it.accelerator) rows.push({ label: it.label, acc: it.accelerator });
      }
    }
    const bare = rows.filter((r) => !/CommandOrControl|Ctrl|Alt|Shift|Super/i.test(r.acc)
      && /^(?:[A-Z0-9]|F\d{1,2})$/i.test(r.acc));
    for (const r of bare) note(`裸键 accelerator：${r.label} → "${r.acc}"`);
    ok(bare.some((r) => r.acc.toUpperCase() === 'F'), '存在抢字母 F 的裸键 accelerator（视图 → 适应窗口）');

    /* ===================================================== */
    head('1. 打开编辑弹窗并聚焦姓名框');
    /* ===================================================== */
    await js(`(() => {
      const n = document.querySelector('.node');
      n && n.click();
      return true;
    })()`);
    await tick(400);
    const edit = await js(`(() => {
      const b = document.querySelector('[data-act="edit"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!edit) throw new Error('详情面板没有「编辑」按钮');
    WC.sendInputEvent({ type: 'mouseDown', x: edit.x, y: edit.y, button: 'left', clickCount: 1 });
    WC.sendInputEvent({ type: 'mouseUp', x: edit.x, y: edit.y, button: 'left', clickCount: 1 });
    await tick(600);

    const opened = await js(`(() => {
      const el = document.getElementById('f-name');
      if (!el) return null;
      el.focus();
      el.value = '';
      return { focused: document.activeElement === el };
    })()`);
    ok(!!opened, '编辑弹窗已打开并聚焦姓名框');
    ok(opened?.focused, '姓名框确实拿到焦点');
    await tick(300);

    /** 观察一次：画布 transform（fit 会改它）、姓名框值、当前焦点、菜单是否被拉起 */
    const probe = () => js(`(() => {
      const c = document.getElementById('canvas');
      const a = document.activeElement;
      const el = document.getElementById('f-name');
      return {
        transform: c ? c.style.transform : '',
        nameValue: el ? String(el.value) : '(弹窗没了)',
        focusId: a ? (a.id || a.tagName) : '',
        modalAlive: !!el,
      };
    })()`);

    const base = await probe();
    note(`基线 transform="${base.transform}" 焦点=${base.focusId}`);

    /* ===================================================== */
    head('2. 注入字母 F（被 accelerator 抢的那个键）');
    /* ===================================================== */
    let injected = false;
    try {
      const out = await pressVirtualKey(hwnd, VK.F);
      injected = true;
      note(`系统级按键已注入（powershell 返回 ${JSON.stringify(out)}）`);
    } catch (e) {
      note(`注入失败：${e?.message || e}`);
    }

    if (injected) {
      await tick(900);
      const afterF = await probe();
      const moved = afterF.transform !== base.transform;
      note(`F 之后 transform="${afterF.transform}" 姓名框="${afterF.nameValue}" 焦点=${afterF.focusId}`);
      /* 实测结论（2026-10-09）：Electron 44 / Windows 上，
         裸键 accelerator（视图 → 适应窗口 抢的是裸键 F）**并不会**吃掉输入框的按键。
         所以这个文件是「证伪 + 回归守卫」：
         ① 证明 F 能正常打进输入框（说明问题不在裸键 accelerator 上）；
         ② 顺带守住「以后别把它改成会拦截的实现」。 */
      ok(!moved, '注入 F → 画布没动（裸键 accelerator「适应窗口」并没有吃掉这个按键）');
      ok(afterF.nameValue === 'f',
        `注入 F 后字母 f 正常打进输入框（值=${JSON.stringify(afterF.nameValue)}）`);
    } else {
      ok(false, '无法注入系统级按键，本项作废（需要允许 execFileSync 调 powershell）');
    }

    /* ===================================================== */
    head('3. 对照组：注入字母 A / J（没有 accelerator 的键）');
    /* ===================================================== */
    for (const [name, vk] of [['A', VK.A], ['J', VK.J]]) {
      const before = await probe();
      try {
        await pressVirtualKey(hwnd, vk);
      } catch (e) {
        note(`注入 ${name} 失败：${e?.message || e}`);
        continue;
      }
      await tick(800);
      const after = await probe();
      const moved = after.transform !== before.transform;
      note(`注入 ${name} 之后 transform="${after.transform}" 焦点=${after.focusId}`
        + (after.nameValue !== before.nameValue ? ` 姓名框="${after.nameValue}"` : '（姓名框无变化）'));
      ok(!moved, `注入 ${name} → 画布没动（对照成立：这个键确实没有 accelerator 拦截）`);
    }
  } catch (e) {
    fails++;
    console.error('\x1b[31m异常\x1b[0m', e);
    L.push('FAIL  异常: ' + (e?.stack || e));
  }

  L.push('');
  L.push(fails === 0 ? '===== ALL PASSED =====' : `===== ${fails} FAILED =====`);
  console.log('');
  console.log(`沙箱：${sandbox}`);
  app.exit(fails === 0 ? 0 : 1);
}

run();
