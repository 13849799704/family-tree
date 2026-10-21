/**
 * =========================================================
 * 照片命名与校验的纯函数 · core/photoNames.js
 * ---------------------------------------------------------
 * 这个文件**两头共用**：
 *   主进程（electron/photoStore.js）  —— 生成文件名、校验路径
 *   渲染层（src/core/photos.js 等）   —— 收集导出引用、判缺失
 * 所以它**一个 node 内置模块都不能 import**（渲染层没有 require），
 * 只用正则、字符串和 globalThis.crypto。
 *
 * 安全口径（design D3）：照片文件名是「数据库里的一行字」，
 * 可能是历史脏数据、也可能是手工篡改过的 —— 任何拼进磁盘路径的
 * 名字都必须先过 isValidPhotoName，否则一个 `..\` 就能逃出 photos/。
 * =========================================================
 */

/** 支持的图片扩展名（nativeImage 可解码集；HEIC / RAW 明确不支持，尽早拒绝） */
export const PHOTO_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];

/** 合法照片文件名：纯 ASCII、无路径分隔符、不以点开头、不含连续点 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 是否是安全的照片文件名（可直接拼进 photos/ 目录）。
 * 挡掉：路径分隔符（/ \）、`..`、绝对路径、空串、非 ASCII、前导点。
 */
export function isValidPhotoName(name) {
  return typeof name === 'string'
    && NAME_RE.test(name)
    && !name.includes('..');
}

/** 取小写扩展名；不在白名单返回 null */
export function safeExt(file) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(file || ''));
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return PHOTO_EXTS.includes(ext) ? ext : null;
}

/** 扩展名 → MIME（拼 dataURL 用） */
export function mimeOfExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'png') return 'image/png';
  if (e === 'webp') return 'image/webp';
  if (e === 'gif') return 'image/gif';
  if (e === 'bmp') return 'image/bmp';
  return 'application/octet-stream';
}

/** 从文件名取小写扩展名（不含点） */
export function extOfName(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * personId 清洗成可用作文件名前缀的串。
 * 人物 id 形如 `p_me` / `p_wus`（见 data/sample.js），本来就是 ASCII；
 * 清洗是防御未来的脏 id，不是日常路径。
 */
export function sanitizePersonId(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9]/g, '');
  return s || 'p';
}

/** 6 位随机十六进制（3 字节；crypto.getRandomValues，浏览器与 Node 都有） */
export function rand6() {
  const buf = new Uint8Array(3);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * 生成照片文件名：`<personId>-<rand6>.<ext>`。
 * 带 personId 前缀是为了人在资源管理器里能认出这是谁的照片
 * （目录名用短 id 不掺姓名，是 paths.js 的既定取舍，但文件名可以友好些）。
 */
export function photoName(personId, ext) {
  return `${sanitizePersonId(personId)}-${rand6()}.${String(ext || '').toLowerCase()}`;
}

/** 缩略图文件名：`p_me-a1b2c3.jpg` → `p_me-a1b2c3.thumb.jpg`（扩展名随之而变） */
export function thumbName(name) {
  return String(name || '').replace(/(\.[A-Za-z0-9]+)$/, '.thumb$1');
}

/**
 * 从一份数据集里收集被引用的照片文件名（people[].photos + people[].avatar），
 * 去重且保持出现顺序。导出「包含照片」与「缺失报数」都用它。
 * @returns {string[]}
 */
export function collectPhotoRefs(dataset) {
  const out = [];
  const seen = new Set();
  const push = (n) => {
    if (typeof n === 'string' && n.trim() && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  for (const p of dataset?.people || []) {
    for (const n of p?.photos || []) push(n);
    push(p?.avatar);
  }
  return out;
}

/**
 * 被引用但磁盘上不存在的照片名。
 * @param {(name:string)=>boolean} has 磁盘存在性判据
 * @returns {string[]}
 */
export function missingPhotoRefs(dataset, has) {
  return collectPhotoRefs(dataset).filter((n) => !has(n));
}
