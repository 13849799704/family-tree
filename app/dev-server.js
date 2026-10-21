/**
 * 零依赖开发服务器
 * ---------------------------------------------------------------
 * 为什么需要它：应用的源码用 ES Module（`import` / `export`）组织，
 * 浏览器出于 CORS 限制，不允许从 `file://` 加载模块。
 * 所以本地开发需要一个静态服务器。
 *
 * 不依赖任何 npm 包 —— 只用 Node 内置模块，所以不需要 npm install。
 *
 * 用法：
 *   node dev-server.js
 *   然后浏览器打开 http://localhost:5173
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5173;
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 把 URL 路径安全地解析到磁盘路径，禁止跳出 ROOT（防目录穿越） */
function resolveSafe(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = decoded === '/' ? '/index.html' : decoded;
  const abs = path.resolve(ROOT, '.' + rel);
  if (!abs.startsWith(ROOT)) return null;
  return abs;
}

const server = http.createServer((req, res) => {
  const abs = resolveSafe(req.url || '/');

  if (!abs) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 越权路径');
    return;
  }

  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<meta charset="utf-8"><h2>404</h2><p>找不到：<code>${req.url}</code></p>` +
          `<p>根目录：<code>${ROOT}</code></p>`
      );
      return;
    }

    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      // 开发期禁用缓存，改完刷新即生效
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(abs).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  族谱软件 · 开发服务器已启动');
  console.log('  ────────────────────────────────');
  console.log(`  地址：  http://${HOST}:${PORT}`);
  console.log(`  根目录：${ROOT}`);
  console.log('');
  console.log('  按 Ctrl+C 停止');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 已被占用。换个端口：PORT=5174 node dev-server.js\n`);
  } else {
    console.error('\n  服务器启动失败：', e.message, '\n');
  }
  process.exit(1);
});
