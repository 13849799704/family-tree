/**
 * 校验「打包产物 asar」与「当前源码」是否字节级一致
 * ---------------------------------------------------------
 * 为什么需要：asar 打包发生在某个时间点，之后如果源码被改动（或误删后恢复），
 * 安装包就和源码脱节了 —— 只看文件存在与否、只看大小都验不出来。
 * 本脚本只读 asar + 只读源码，输出一律写临时目录，绝不往项目目录写任何东西。
 *
 * 用法：
 *   node scripts/verify-asar.js                        # 用默认路径
 *   node scripts/verify-asar.js <asar路径> <源码目录>
 *
 * 退出码：0 = 全部一致；1 = 有文件不一致；2 = 参数/解析错误
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const INSTALLED_ASAR = 'D:\\族谱pc端项目\\程序\\resources\\app.asar';
const UNPACKED_ASAR = 'D:\\族谱pc端项目\\dist\\win-unpacked\\resources\\app.asar';
const DEFAULT_SRC = path.resolve(import.meta.dirname, '..');

/**
 * 默认验「用户实际装上的那个」，打包目录只是备胎。
 * 因为最该回答的问题从来不是「打包成功了吗」，而是「用户跑的是不是这份代码」。
 * （真出过一次：用户说装好了，实际装的是旧版，5 个修复文件全都不在里面。）
 */
const DEFAULT_ASAR = [INSTALLED_ASAR, UNPACKED_ASAR].find((p) => fs.existsSync(p)) || INSTALLED_ASAR;

// electron-builder 打包时会重写 package.json（剥掉 devDependencies / build 配置 / scripts），
// 所以这些文件的差异是预期的，不算「包与源码不同步」。
const EXPECTED_DIFF = [/^package\.json$/, /(^|\/)node_modules\/[^/]+\/package\.json$/];

const asarPath = process.argv[2] || DEFAULT_ASAR;
const srcDir = process.argv[3] || DEFAULT_SRC;

if (!fs.existsSync(asarPath)) {
  console.error(`找不到 asar: ${asarPath}`);
  process.exit(2);
}

/* ---------- 1. 解析 asar 头 ---------- */
/**
 * asar 布局（@electron/asar 写出来的 pickle 格式）：
 *   [0..3]   uint32 = 4
 *   [4..7]   uint32 = headerBuf.length            ← 整个 header pickle 的字节数
 *   [8..11]  uint32 = headerBuf 的 payload 长度
 *   [12..15] uint32 = header JSON 的字节长度
 *   [16...]  header JSON（后面可能跟 4 字节对齐填充）
 *
 * ⚠️ 坑：数据区起点 = 8 + headerBuf.length，**不是** 16 + JSON 长度。
 *    JSON 后面有对齐填充，用 16+jsonLen 算会整体偏移 1 字节，
 *    表现极具迷惑性：提取出来的文件大小完全正确、内容只差一个换行，
 *    哈希对不上但肉眼看 diff 几乎看不出问题。
 */
const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerBufLen = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
const header = JSON.parse(jsonBuf.toString('utf8'));
const DATA_BASE = 8 + headerBufLen;

/* ---------- 2. 收集 asar 内的文件清单 ---------- */
function walk(node, prefix, out) {
  if (!node || !node.files) return;
  for (const [name, entry] of Object.entries(node.files)) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) { walk(entry, p, out); continue; }
    // asarUnpack 出去的文件（如 sql.js 的 wasm）在包里没有 offset，数据在 app.asar.unpacked 下
    if (entry.unpacked || entry.offset === undefined || entry.offset === null) {
      out.push({ path: p, unpacked: true, size: entry.size });
      continue;
    }
    out.push({ path: p, offset: Number(entry.offset), size: entry.size });
  }
}
const entries = [];
walk(header, '', entries);

/* ---------- 3. 逐个比对 ---------- */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-verify-'));
const results = { same: 0, diff: [], missingInSrc: [], missingInAsar: [], skipped: 0 };

for (const e of entries) {
  if (e.unpacked) { results.skipped++; continue; }
  const srcFile = path.join(srcDir, e.path);
  if (!fs.existsSync(srcFile)) {
    results.missingInSrc.push(e.path);
    continue;
  }
  const srcStat = fs.statSync(srcFile);
  if (srcStat.size !== e.size) {
    results.diff.push({ path: e.path, reason: `大小不同 asar=${e.size} src=${srcStat.size}` });
    continue;
  }
  // 小文件直接读；大文件（如 wasm）用流式哈希，避免占内存
  const hashAsar = (() => {
    const h = crypto.createHash('sha256');
    const buf = Buffer.alloc(e.size);
    fs.readSync(fd, buf, 0, e.size, DATA_BASE + e.offset);
    h.update(buf);
    return h.digest('hex');
  })();
  const hashSrc = crypto.createHash('sha256').update(fs.readFileSync(srcFile)).digest('hex');
  if (hashAsar === hashSrc) results.same++;
  else results.diff.push({ path: e.path, reason: '内容不同（大小一致但字节不同）' });
}
fs.closeSync(fd);

/* ---------- 4. 报告 ---------- */
console.log(`asar : ${asarPath}`);
console.log(`源码 : ${srcDir}`);
console.log(`包内文件 ${entries.length} 个，数据区起点偏移 ${DATA_BASE}`);
console.log('─'.repeat(56));
console.log(`一致           : ${results.same}`);
console.log(`内容不同(🔴)   : ${results.diff.length}`);
console.log(`源码里找不到   : ${results.missingInSrc.length}`);
console.log(`解包文件(跳过) : ${results.skipped}`);
if (results.diff.length) {
  console.log('\n🔴 内容不一致的文件：');
  for (const d of results.diff) console.log(`   ${d.path}  —— ${d.reason}`);
}
if (results.missingInSrc.length) {
  console.log('\n（以下只存在于包内，通常是打包产物/依赖，可忽略）：');
  for (const p of results.missingInSrc.slice(0, 10)) console.log(`   ${p}`);
  if (results.missingInSrc.length > 10) console.log(`   ...还有 ${results.missingInSrc.length - 10} 个`);
}
// 业务代码才是我们真正关心的：只要 src/、electron/、index.html、样式一致就行
const onlyCodeDiff = results.diff.filter(
  (d) => !d.path.startsWith('node_modules/') && !EXPECTED_DIFF.some((re) => re.test(d.path))
);
const expectedDiff = results.diff.filter((d) => EXPECTED_DIFF.some((re) => re.test(d.path)));
if (expectedDiff.length) {
  console.log('（以下差异是 electron-builder 重写导致的，属预期，可忽略）：');
  for (const d of expectedDiff) console.log(`   ${d.path}  —— ${d.reason}`);
}
console.log('─'.repeat(56));
if (onlyCodeDiff.length === 0) {
  console.log('✅ 打包产物与当前源码一致（业务代码字节级相同）');
  process.exit(0);
} else {
  console.log('❌ 打包产物与源码不同步，建议重新打包');
  process.exit(1);
}
