/**
 * =========================================================
 * 照片缓存 · core/photos.js
 * ---------------------------------------------------------
 * 渲染层唯一的照片出口。**没有桥（网页版）时整个模块静默降级** ——
 * 所有函数都先问一句 photoBridge()，没有就什么也不做（spec：
 * 不具备本地文件能力时不提供照片入口，其余功能不受影响）。
 *
 * 缓存策略（design D2）：
 *   · Map<name, dataUrl>：dataURL 可能几十 KB，但换来的是「导出图片
 *     不污染画布」——file:// 上画布会让 toDataURL 抛 SecurityError，
 *     这是 app.js 导出图片处坑位注释明令的红线。
 *   · 负缓存 missing：文件不在磁盘上时也记住，避免每次重绘都去问一遍 IPC。
 *     照片被添加 / 恢复后由调用方 forget() 摘掉，不会挡住新文件。
 *   · ensure() 幂等：已在缓存 / 在途中 / 已知缺失的一概跳过，
 *     返回**新解析出几张**（>0 时调用方应重绘一次）。
 *
 * ⚠️ 只 import 纯函数模块 photoNames.js，不碰任何 node 内置模块。
 * =========================================================
 */

import { collectPhotoRefs } from './photoNames.js';

/** 桌面版注入的桥；网页版没有 → null */
export const photoBridge = () =>
  (typeof window !== 'undefined' && window.genogramFS && window.genogramFS.photos) || null;

/** name → dataUrl */
const cache = new Map();
/** 已知磁盘上不存在的 name（负缓存，见文件头） */
const missing = new Set();
/** 正在取图的 name → Promise（防同帧重复 IPC） */
const pending = new Map();

/** 已缓存的 dataUrl；没有则空串（调用方据此回落占位） */
export function cached(name) {
  return cache.get(name) || '';
}

/** 清掉一个名字的缓存 / 负缓存（增删恢复之后调用，让新状态能被看到） */
export function forget(names) {
  for (const n of Array.isArray(names) ? names : [names]) {
    if (typeof n !== 'string' || !n) continue;
    cache.delete(n);
    missing.delete(n);
    pending.delete(n);
  }
}

/** 全清（切谱 / 数据集替换时调用） */
export function invalidate() {
  cache.clear();
  missing.clear();
  pending.clear();
}

/**
 * 确保这些照片都在缓存里（懒加载）。
 * @param {string[]} names
 * @returns {Promise<number>} 新解析出几张（>0 → 调用方重绘一次即可显示）
 */
export async function ensure(names) {
  const b = photoBridge();
  if (!b) return 0;

  let fresh = 0;
  const jobs = [];
  for (const name of names) {
    if (typeof name !== 'string' || !name) continue;
    if (cache.has(name) || missing.has(name)) continue;
    if (pending.has(name)) {
      jobs.push(pending.get(name));
      continue;
    }
    const job = (async () => {
      try {
        // 先缩略图（小、快），缺失或失败回落原图
        let r = await b.thumb(name);
        if (!r || r.ok !== true || !r.dataUrl) r = await b.original(name);
        if (r && r.ok === true && r.dataUrl) {
          cache.set(name, r.dataUrl);
          fresh++;
        } else {
          missing.add(name);   // 文件不在 / 读不了：记负缓存
        }
      } catch {
        missing.add(name);
      } finally {
        pending.delete(name);
      }
    })();
    pending.set(name, job);
    jobs.push(job);
  }
  await Promise.all(jobs);
  return fresh;
}

/**
 * 从一份数据集收集引用并预热（树头像 + 面板照片共用）。
 * @returns {Promise<number>} 新解析出几张
 */
export async function ensureForDataset(dataset) {
  return ensure(collectPhotoRefs(dataset));
}
