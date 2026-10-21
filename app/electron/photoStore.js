/**
 * =========================================================
 * 照片存储 · electron/photoStore.js
 * ---------------------------------------------------------
 * 只有**主进程** import 这个文件（它要碰 fs）。
 * 渲染层没有 require，一律走 IPC（见 preload.cjs 的 genogramFS.photos）。
 *
 * 分工：
 *   src/core/photoNames.js  纯函数（命名 / 校验 / 引用收集），两头共用
 *  本文件                    编排（复制、读、删、恢复），只依赖 fs + path
 *
 * ⚠️ 存储形态（design D1）：照片**文件**进 per-book 的 photos/ 目录，
 *    数据库行里只存文件名。base64 塞进行里会让每次全量重写（db.js writeDataset）
 *    越来越慢，README §287 也早留了这句话。
 *
 * ⚠️ 渲染通道（design D2）：照片绝不直接以 file:// 上画布 —— 会污染 canvas，
 *    toDataURL 抛 SecurityError（app.js 导出图片处的坑位注释）。
 *    所有出口都是 dataURL。
 * =========================================================
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  isValidPhotoName, safeExt, photoName, thumbName, extOfName, mimeOfExt,
} from '../src/core/photoNames.js';

/** 缩略图最长边（面板槽位约 64px，320 够高清屏也够灯箱预显） */
export const THUMB_EDGE = 320;
/** 缩略图质量（JPEG 档） */
export const THUMB_QUALITY = 80;

/** name → dataURL（MIME 按扩展名推） */
const dataUrl = (buf, name) =>
  `data:${mimeOfExt(extOfName(name))};base64,${buf.toString('base64')}`;

/**
 * 路径必须落在 photos 目录内（design D3）。
 * 数据库里的名字可能是历史脏数据或手工篡改的，拼路径前必须过这两关：
 *   ① isValidPhotoName：无分隔符、无 `..`、纯 ASCII、不前导点
 *   ② resolve 后仍以目录为前缀（双保险）
 */
function assertInside(dir, name) {
  if (!isValidPhotoName(name)) {
    throw new Error('照片文件名不合法：' + String(name));
  }
  const root = path.resolve(dir);
  const full = path.resolve(root, name);
  if (full !== path.join(root, name) || !full.startsWith(root + path.sep)) {
    throw new Error('照片路径越界：' + String(name));
  }
  return full;
}

/* ---------------------------------------------------------- */
/* 读                                                          */
/* ---------------------------------------------------------- */

/**
 * 取一张照片的 dataURL。
 * @param {string} dir photos 目录
 * @param {string} name 文件名
 * @param {boolean} preferThumb true = 先缩略图，缺失则回落原图
 * @returns {{ok:true, dataUrl:string, thumb:boolean}|{ok:false, error:string}}
 */
export function readDataUrl(dir, name, preferThumb = false) {
  try {
    if (preferThumb) {
      const t = assertInside(dir, thumbName(name));
      if (fs.existsSync(t)) {
        return { ok: true, dataUrl: dataUrl(fs.readFileSync(t), name), thumb: true };
      }
    }
    const f = assertInside(dir, name);
    if (!fs.existsSync(f)) return { ok: false, error: '照片文件不存在' };
    return { ok: true, dataUrl: dataUrl(fs.readFileSync(f), name), thumb: false };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * 批量读（导出「包含照片」用）。磁盘上没有的进 missing，由调用方报数。
 * @returns {{ok:true, map:Object<string,string>, missing:string[]}}
 */
export function readMany(dir, names) {
  const map = {};
  const missing = [];
  for (const n of names || []) {
    const r = readDataUrl(dir, n, false);
    if (r.ok) map[n] = r.dataUrl;
    else missing.push(n);
  }
  return { ok: true, map, missing };
}

/* ---------------------------------------------------------- */
/* 删                                                          */
/* ---------------------------------------------------------- */

/**
 * 删照片（连同缩略图）。
 * ENOENT 视为已删（文件本来就没啦，引用照删）；EPERM 等（文件被资源管理器 /
 * 预览占用）进 errors —— 调用方**保留数据库引用**并报错，用户关掉占用后重试，
 * 不制造「库说删了、文件还在」的漂移。
 * @returns {{ok:true, removed:string[], errors:{name:string,error:string}[]}}
 */
export function removePhotos(dir, names) {
  const removed = [];
  const errors = [];
  for (const n of names || []) {
    let full;
    let thumb;
    try {
      full = assertInside(dir, n);
      thumb = assertInside(dir, thumbName(n));
    } catch (e) {
      errors.push({ name: n, error: e?.message || String(e) });
      continue;
    }
    try {
      fs.unlinkSync(full);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        errors.push({ name: n, error: e?.message || String(e) });
        continue;
      }
    }
    try { fs.unlinkSync(thumb); } catch { /* 缩略图删不掉不阻塞主文件已删的事实 */ }
    removed.push(n);
  }
  return { ok: true, removed, errors };
}

/* ---------------------------------------------------------- */
/* 恢复（导入）                                                 */
/* ---------------------------------------------------------- */

const DATA_URL_RE = /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=\s]+)$/i;

/**
 * 把 {name: dataUrl} 写进 dir（导入内联照片用）。
 * 已存在的文件**跳过不覆盖**（用户可能已手动更替过）；坏名字 / 坏数据进 errors。
 * @returns {{ok:true, written:string[], skipped:string[], errors:{name:string,error:string}[]}}
 */
export function restoreMap(dir, map) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const skipped = [];
  const errors = [];
  for (const [name, url] of Object.entries(map || {})) {
    let full;
    try {
      full = assertInside(dir, name);
    } catch (e) {
      errors.push({ name, error: e?.message || String(e) });
      continue;
    }
    const m = DATA_URL_RE.exec(String(url || ''));
    if (!m) {
      errors.push({ name, error: '不是合法的图片数据' });
      continue;
    }
    if (fs.existsSync(full)) {
      skipped.push(name);
      continue;
    }
    try {
      fs.writeFileSync(full, Buffer.from(m[1], 'base64'));
      written.push(name);
    } catch (e) {
      errors.push({ name, error: e?.message || String(e) });
    }
  }
  return { ok: true, written, skipped, errors };
}

/* ---------------------------------------------------------- */
/* 添加（系统对话框之后）                                        */
/* ---------------------------------------------------------- */

/**
 * 把用户选的文件收进 dir：白名单 → 读盘 → 解码试错 → 原字节落盘 → 缩略图。
 *
 * nativeImage 由调用方注入（Electron 的 nativeImage；单测里给桩）——
 * 这样本文件保持「不 import electron」，纯 Node 下可测。
 *
 * 大小**不设上限**（用户 2026-10-21：本地磁盘、照片获取不易，体积再大也收）。
 * 缩略图失败不阻塞（渲染层回退原图）；坏格式不影响同批其他文件。
 *
 * @returns {{ok:true, added:string[], rejected:{file:string,reason:string}[]}}
 */
export function addPhotos(dir, personId, files, nativeImage) {
  fs.mkdirSync(dir, { recursive: true });
  const added = [];
  const rejected = [];

  for (const file of files || []) {
    const ext = safeExt(file);
    if (!ext) {
      rejected.push({ file, reason: '格式不支持（可用 jpg / png / webp / gif / bmp）' });
      continue;
    }

    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (e) {
      rejected.push({ file, reason: '读不了这个文件：' + (e?.message || e) });
      continue;
    }

    // 解码试错：nativeImage 解不了的（损坏 / 伪扩展名）存进去也是坏数据，
    // 这里挡下来，明确告诉用户（spec：不得把坏数据写进库）
    let img = null;
    try {
      img = nativeImage.createFromBuffer(buf);
    } catch {
      img = null;
    }
    if (!img || img.isEmpty()) {
      rejected.push({ file, reason: '图片解码失败（文件可能损坏）' });
      continue;
    }

    // 取名（撞名重试；rand6 撞概率极低，几轮足够）
    let name = '';
    for (let i = 0; i < 5 && !name; i++) {
      const cand = photoName(personId, ext);
      if (!fs.existsSync(path.join(dir, cand))) name = cand;
    }
    if (!name) {
      rejected.push({ file, reason: '文件名生成失败，请重试' });
      continue;
    }

    try {
      fs.writeFileSync(path.join(dir, name), buf);
    } catch (e) {
      rejected.push({ file, reason: '保存失败：' + (e?.message || e) });
      continue;
    }

    makeThumb(dir, name, img);   // 失败静默：渲染层回退原图
    added.push(name);
  }

  return { ok: true, added, rejected };
}

/**
 * 生成缩略图。**中心裁切成正方形**再缩到 THUMB_EDGE。
 *
 * ⚠️ 为什么必须是方的（2026-10-21 修）：头像位是 60×60、面板格是方的，
 *    而 **html2canvas 不支持 `object-fit`** —— 它把 <img> 直接 drawImage
 *    拉伸到元素框里。喂一张 3:2 的照片进正方形框，导出图里的头像就被挤扁
 *    （屏幕上是好的，因为浏览器认 object-fit；一导出就露馅）。
 *    缩略图本身是方的 → 方图进方框，等比不变形，屏幕观感也完全一样
 *    （格子本来就是方的，object-fit: cover 裁的也是中心）。
 *    亮图（png/webp/gif）走 toPNG，其余走 toJPEG —— 透明区不该被垫成黑的。
 */
function makeThumb(dir, name, img) {
  try {
    const buf = squareBuffer(img, THUMB_EDGE, extOfName(name));
    if (buf && buf.length) {
      fs.writeFileSync(path.join(dir, thumbName(name)), buf);
    }
  } catch {
    /* 缩略图失败就回退原图，不算这一张添加失败 */
  }
}

/**
 * 中心裁切 + 缩放，成一张正方形的缩略图字节。
 * @param {object} img nativeImage
 * @param {number} edge 边长（px）
 * @param {string} ext 原图扩展名（决定编码器：带透明的走 PNG）
 */
function squareBuffer(img, edge, ext) {
  const size = img.getSize() || { width: 0, height: 0 };
  const w = Math.max(1, size.width || 1);
  const h = Math.max(1, size.height || 1);
  const side = Math.min(w, h);
  const cropped = img.crop({
    x: Math.round((w - side) / 2),
    y: Math.round((h - side) / 2),
    width: side,
    height: side,
  });
  const small = cropped.resize({ width: edge, height: edge });
  return (ext === 'png' || ext === 'webp' || ext === 'gif')
    ? small.toPNG()
    : small.toJPEG(THUMB_QUALITY);
}

/**
 * 取**方形**缩略图（头像与网格格都用它）。
 * 磁盘上的缩略图若是旧版的「等比缩放」（非方形），就地重生成一份 ——
 * 不迁数据、不动原图，下一次读到的就是方的。
 *
 * @param {string} dir photos 目录
 * @param {string} name 文件名
 * @param {object} nativeImage Electron 的 nativeImage
 * @returns {{ok:true, dataUrl:string, thumb:true}|{ok:false, error:string}}
 */
export function squareThumb(dir, name, nativeImage) {
  let t;
  let orig;
  try {
    t = assertInside(dir, thumbName(name));
    orig = assertInside(dir, name);
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }

  // 已有方形缩略图 → 直接读
  if (fs.existsSync(t)) {
    try {
      const buf = fs.readFileSync(t);
      const img = nativeImage.createFromBuffer(buf);
      const s = img && !img.isEmpty() ? img.getSize() : null;
      if (s && s.width === s.height) {
        return { ok: true, dataUrl: dataUrl(buf, name), thumb: true };
      }
    } catch {
      /* 落到「从原图重建」 */
    }
  }

  // 没有缩略图 / 旧版非方形 → 从原图重生成一份方的并落盘
  if (!fs.existsSync(orig)) return { ok: false, error: '照片文件不存在' };
  try {
    const buf = fs.readFileSync(orig);
    const img = nativeImage.createFromBuffer(buf);
    if (!img || img.isEmpty()) return { ok: false, error: '图片解码失败' };
    const square = squareBuffer(img, THUMB_EDGE, extOfName(name));
    if (!square || !square.length) return { ok: false, error: '缩略图生成失败' };
    fs.writeFileSync(t, square);
    return { ok: true, dataUrl: dataUrl(square, name), thumb: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
