/**
 * =========================================================
 * 导出图片的纯计算 · core/export-image.js
 * ---------------------------------------------------------
 * 输入：布局层算好的包围盒 bounds + 用户选的清晰度
 * 输出：克隆容器该多大、画布该摆在容器里的哪个位置、最终出多少像素
 *
 * 【为什么放 core】这里不许碰 DOM。尺寸算错一次的后果是
 * 「图被切掉半边」「整棵树跑出画面」这类肉眼才看得出的错，
 * 必须能被 tests/run.js 直接单测，不能等到出图了才看出来。
 * =========================================================
 */

/**
 * Chromium 的画布上限：单边 16384、总面积 16384²。
 * 单看单边容易漏 —— 真正先撞上的通常是**总面积**
 * （10000×8000 单边都没超，但面积已经过线）。
 * 撞上限的典型表现不是报错，是直接画不出来 / 出一张全黑图。
 */
export const MAX_DIM = 16384;
export const MAX_AREA = MAX_DIM * MAX_DIM;

/**
 * 四周留白（像素）。
 * ⚠️ 这个数不是「看着顺眼」定的：卡片上方那个「我」标记
 * （.anchor-flag）是 position:absolute; top:-20px，向上溢出卡片 20px。
 * 留白小于 20，最顶上那张卡片的「我」就会被切掉半截。
 */
export const PAD = 32;

/** 可选的清晰度档位（弹窗里给用户二选一） */
export const SCALES = [1, 2];

/**
 * 算一份导出计划。
 *
 * @param {object}  opts
 * @param {object}  opts.bounds   布局层给的包围盒 { minX, minY, maxX, maxY }
 * @param {number} [opts.scale=1] 清晰度：1 = 屏幕原尺寸，2 = 高清
 * @returns {{ok:boolean, error?:string, scale?:number, requestedScale?:number,
 *           clamped?:boolean, note?:string, cssWidth?:number, cssHeight?:number,
 *           pixelWidth?:number, pixelHeight?:number, offsetX?:number, offsetY?:number}}
 */
export function imagePlan({ bounds, scale = 1 } = {}) {
  const b = bounds || {};
  const minX = Number(b.minX);
  const minY = Number(b.minY);
  const maxX = Number(b.maxX);
  const maxY = Number(b.maxY);
  const requested = Number(scale) > 0 ? Number(scale) : 1;

  const bad = { ok: false, error: '这一页还没有可导出的内容' };
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return bad;

  /* 先按**内容**判空，不能拿「加了留白之后的尺寸」判 ——
     包围盒全零（空页）时，加完 64px 留白仍是 64×64 的正数，
     会被当成「有一张很小的图」，最后弹个另存为让人存下一张白纸。 */
  const rawW = maxX - minX;
  const rawH = maxY - minY;
  if (rawW <= 0 || rawH <= 0) return bad;

  const cssWidth = Math.ceil(rawW) + PAD * 2;
  const cssHeight = Math.ceil(rawH) + PAD * 2;

  /* 降档：这个尺寸最多能放到几倍 → 往下取整到 0.5 的整数倍。
     宁可少给点清晰度，也不能硬撑出一张画不出来的图。 */
  const maxScale = Math.min(
    MAX_DIM / cssWidth,
    MAX_DIM / cssHeight,
    Math.sqrt(MAX_AREA / (cssWidth * cssHeight))
  );
  const clamped = requested > maxScale;
  const effective = clamped
    ? Math.max(0.5, Math.floor(maxScale * 2) / 2)
    : requested;

  /* 连 0.5 倍都还超：那是「一页就宽出几万像素」的极端谱。硬撑出来的
     是黑图或者根本画不出来 —— 如实说不行，比给一张打不开的图强。 */
  if (overLimit(effective, cssWidth, cssHeight)) {
    return { ok: false, error: '这一页太大了，图片尺寸超出上限，导不出来' };
  }

  return {
    ok: true,
    scale: effective,
    requestedScale: requested,
    clamped,
    note: clamped
      ? `这一页排出来是 ${cssWidth}×${cssHeight} 像素，${requested} 倍会超过画布上限，已自动降到 ${effective} 倍`
      : '',
    cssWidth,
    cssHeight,
    pixelWidth: Math.floor(cssWidth * effective),
    pixelHeight: Math.floor(cssHeight * effective),
    /* 画布副本在容器里的落点：把内容左上角（minX/minY）挪到留白处。
       ⚠️ 少了这个补偿，整棵树会按布局坐标整体右移/下移 —— 布局坐标
       **可以是负数**（主树的 minX 常在 -2000 上下），不补就是整张出画。 */
    offsetX: PAD - minX,
    offsetY: PAD - minY,
  };
}

/** 某个倍率下是否已经越过画布上限 */
function overLimit(scale, cssWidth, cssHeight) {
  return scale * cssWidth > MAX_DIM
    || scale * cssHeight > MAX_DIM
    || scale * scale * cssWidth * cssHeight > MAX_AREA;
}

/** Windows 文件名里不能用的字符 */
const BAD_FILE_CHARS = /[\\/:*?"<>|]/g;

/**
 * 家族标签 → 可用的文件名片段。
 * 标签里带「·」和空格（`配偶家族 · 王五`），先洗一遍再拼进文件名。
 *
 * ⚠️ JSON 导出（app.js 的 scopeFilename）和图片导出共用这一份。
 * 两处各写各的，同一天导出的两个文件就会一个叫 A 一个叫 B。
 */
export function safeFileToken(label) {
  return String(label || '')
    .replace(BAD_FILE_CHARS, '')
    .replace(/[·\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 日期戳 20261012 */
export function dateStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

/** 导出图片的文件名：家族谱-家族名-日期.png */
export function imageFilename(label, date = new Date()) {
  return `家族谱-${safeFileToken(label) || '当前家族'}-${dateStamp(date)}.png`;
}