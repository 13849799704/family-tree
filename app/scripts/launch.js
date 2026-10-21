/**
 * =========================================================
 * 启动包装 · scripts/launch.js
 * ---------------------------------------------------------
 * 为什么不能直接 `electron .`：
 *
 *  Electron 有一个隐藏开关 `ELECTRON_RUN_AS_NODE`。只要它在环境里存在，
 *  Electron 会**退化成纯 Node**，不启动浏览器进程、不建窗口，
 *  而 `import electron from 'electron'` 拿到的是「二进制路径字符串」而不是 API 对象，
 *  于是报一个极难懂的错：
 *
 *      TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')
 *
 *  更坑的是报错栈里写着 `Node.js vXX` —— 看起来像 Node 把 Electron 跑挂了，
 *  实际上是压根没进 Electron。
 *
 *  某些开发终端 / IDE / 自动化环境会带上这个变量，用户完全无感。
 *  所以统一从这里启动：先删掉它，再拉真正的 Electron。
 *
 * 用法（package.json 里已经接好）：
 *   npm start             → node scripts/launch.js
 *   npm run test:e2e      → node scripts/launch.js tests/electron-smoke.js
 * =========================================================
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';   // 在普通 Node 里，这个包导出的就是可执行文件路径

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

if (process.env.ELECTRON_RUN_AS_NODE) {
  console.log('[launch] 检测到 ELECTRON_RUN_AS_NODE，已清除（否则 Electron 会退化成 Node）');
  delete process.env.ELECTRON_RUN_AS_NODE;
}

/* 第一个参数是要 Electron 打开的入口；
   不给就用当前项目（读 package.json 的 main 字段）。 */
const extra = process.argv.slice(2);
const args = extra.length ? extra : [APP_ROOT];

const child = spawn(electronPath, args, {
  stdio: 'inherit',
  env: process.env,
  cwd: APP_ROOT,
});

child.on('error', (e) => {
  console.error('[launch] 启动 Electron 失败：', e.message);
  console.error('        electron 路径：', electronPath);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});
