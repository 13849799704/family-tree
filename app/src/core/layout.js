/**
 * =========================================================
 * 布局引擎 · layout.js
 * ---------------------------------------------------------
 * 纯函数：输入关系结构，输出坐标。无副作用、无 DOM、可单测。
 *
 * ⚠️ 早期原型（预览 v2 / UI 设计稿 v1 / PRD）已随那批武汉背景文档一并删除，
 *    规范以本文件 + `tokens.css` 为准。以下 4 个关键点是实现时必须守住的，
 *    每一条都是踩过坑换来的：
 *
 *   1. y 必须用**全局统一映射**，不能按「当前树出现过的世次」重排
 *      → 否则多树切换时锚点与非锚点高低不齐
 *   2. 主轴人判定用「是否在 lineage 中出现过」，**不能**用 order != null
 *      → 数据里配偶也可能带 order
 *   3. 父居中的右侧边界用「末子**单元**右边界」，不是末子**子树**右边界
 *   4. 父居中若需向左伸出，**整棵子树右移让位**，不要压父节点
 *
 * ⚠️ 尺寸参数与 PRD §5.2 的 66/78 不一致 —— 采用 UI 稿的 76/88，
 *    因为 76px 是实际渲染验证过的卡片宽度。
 * =========================================================
 */

/* ========================================================= */
/* 布局常量                                                     */
/* ========================================================= */

export const LAYOUT = {
  NODE_W: 76,    // 卡片宽度
  SP_GAP: 12,    // 主轴人与配偶的间距（配偶紧贴右侧）
  UNIT_GAP: 60,  // 单元之间的最小间距
  ROW_H: 132,    // 行高，**恒定**：不因某棵树缺某代而压缩
  Y_BASE: 64,    // 第 0 代的 y
  GEN_TOP: 3,    // 最高世次（曾祖辈），用于 y 映射
  CENTER_X: 620, // 单棵树居中时的画布中心 x
};

/** 全局 y 映射 —— 所有树公用，绝不可改成局部重排 */
export const makeGenY = (cfg = LAYOUT) => (g) =>
  cfg.Y_BASE + (cfg.GEN_TOP - (g ?? 0)) * cfg.ROW_H;

/* ========================================================= */
/* 单棵树布局                                                   */
/* ========================================================= */

/**
 * 对一棵家族树求坐标。
 *
 * @param {object} tree buildFamilyTree() 的产物
 * @param {object} [opts]
 * @param {object} [opts.basePos] 基准树坐标（用于锚点对齐；主树不传）
 * @param {object} [opts.cfg]    布局参数覆盖
 * @returns {{ pos: Record<string,{x:number,y:number}>, width:number, height:number }}
 */
export function layoutTree(tree, opts = {}) {
  const cfg = { ...LAYOUT, ...(opts.cfg || {}) };
  const genY = makeGenY(cfg);
  const { NODE_W, SP_GAP, UNIT_GAP, CENTER_X } = cfg;
  const basePos = opts.basePos || null;

  const P = (id) => tree.people.find((p) => p.id === id);

  /* --- 主轴人判定：在整个 lineage 里出现过 --- */
  const inLine = new Set();
  for (const [c, p] of tree.lineage) { inLine.add(c); inLine.add(p); }
  const isMain = (p) => !!p && inLine.has(p.id);

  /* --- 主轴父表 --- */
  const lineageParent = tree.lineageParent instanceof Map
    ? tree.lineageParent
    : new Map(tree.lineage.map(([c, p]) => [c, p]));

  /* --- 子女（只取主轴人，按 order 长幼） --- */
  const kidsMap = new Map();
  for (const [c, p] of tree.lineage) {
    if (!kidsMap.has(p)) kidsMap.set(p, []);
    kidsMap.get(p).push(c);
  }
  const orderOf = (id) => {
    const o = P(id)?.order;
    return o == null ? 999 : o;
  };
  for (const [, arr] of kidsMap) arr.sort((a, b) => orderOf(a) - orderOf(b));

  const kidsOf = (id) =>
    (kidsMap.get(id) || []).map(P).filter((k) => isMain(k));

  /* --- 配偶表：主轴人 → 其非主轴配偶 --- */
  const spousesOf = {};
  for (const [a, b] of tree.couples) {
    const A = P(a), B = P(b);
    if (!A || !B) continue;
    if (isMain(A) && !isMain(B)) (spousesOf[a] = spousesOf[a] || []).push(b);
    else if (isMain(B) && !isMain(A)) (spousesOf[b] = spousesOf[b] || []).push(a);
  }
  const spOf = (id) => spousesOf[id] || [];

  /** 单元宽度 = 主轴人 + 配偶们 */
  const unitW = (id) => NODE_W + spOf(id).length * (NODE_W + SP_GAP);

  /* --- 递归排布 --- */
  const mainX = {};
  let cursor = 0;

  /** 整棵子树水平平移（父居中越界时让位用） */
  function shiftSubtree(id, dx, seen) {
    const visited = seen || new Set();
    if (visited.has(id)) return;
    visited.add(id);
    if (mainX[id] != null) mainX[id] += dx;
    for (const k of kidsOf(id)) shiftSubtree(k.id, dx, visited);
  }

  /** 返回本子树右边界 */
  function place(id) {
    const kids = kidsOf(id);

    if (!kids.length) {
      // 叶子：直接落地
      mainX[id] = cursor;
      const right = cursor + unitW(id);
      cursor = right + UNIT_GAP;
      return right;
    }

    const startLeft = cursor;

    // 先递归排所有子，收集子树右边界
    const childR = [];
    for (const k of kids) childR.push(place(k.id));

    // ★ 关键点 3：末子用「单元」右边界，不是「子树」右边界
    const firstKidLeft = mainX[kids[0].id];
    const lastKid = kids[kids.length - 1];
    const lastKidRight = mainX[lastKid.id] + unitW(lastKid.id);
    const spanCenter = (firstKidLeft + lastKidRight) / 2;

    const lastSubRight = childR[childR.length - 1];

    // 父单元中心 = 子女群中心
    let px = spanCenter - unitW(id) / 2;

    // ★ 关键点 4：越界时整棵子树右移让位，而不是把父压回去
    if (px < startLeft) {
      shiftSubtree(id, startLeft - px);
      px = startLeft;
    }

    mainX[id] = px;
    const right = Math.max(mainX[id] + unitW(id), lastSubRight);
    cursor = right + UNIT_GAP;
    return right;
  }

  /* --- 从所有「主轴根」开始排 --- */
  const mains = tree.people.filter((p) => isMain(p));
  const roots = mains.filter((p) => !lineageParent.has(p.id));
  roots
    .sort((a, b) => (b.gen ?? 0) - (a.gen ?? 0) || orderOf(a.id) - orderOf(b.id))
    .forEach((r) => place(r.id));

  // 兜底：主轴人若未被任何 root 覆盖（数据异常），顺序摆到右侧
  mains
    .filter((p) => mainX[p.id] == null)
    .forEach((p) => {
      mainX[p.id] = cursor;
      cursor += unitW(p.id) + UNIT_GAP;
    });

  /* --- 展开为 x：主轴人在 mainX，配偶紧跟右侧 --- */
  const finalX = {};
  for (const id of Object.keys(mainX)) {
    if (!isMain(P(id))) continue;
    finalX[id] = mainX[id];
    let sx = mainX[id] + NODE_W + SP_GAP;
    for (const s of spOf(id)) {
      finalX[s] = sx;
      sx += NODE_W + SP_GAP;
    }
  }

  /* --- 落到坐标 --- */
  const pos = {};
  for (const id of Object.keys(finalX)) {
    const p = P(id);
    if (!p) continue;
    pos[id] = { x: finalX[id], y: genY(p.gen), g: p.gen ?? 0 };
  }

  // 完全没进 layout 的成员（数据异常）排在右侧兜底
  let free = Math.max(0, ...Object.values(finalX)) + NODE_W + UNIT_GAP;
  for (const p of tree.people) {
    if (!pos[p.id]) {
      pos[p.id] = { x: free, y: genY(p.gen), g: p.gen ?? 0 };
      free += NODE_W + SP_GAP;
    }
  }

  /* --- 整棵树居中 --- */
  const xs = Object.values(pos).map((q) => q.x);
  if (xs.length) {
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs) + NODE_W;
    const off = CENTER_X - (minX + maxX) / 2;
    for (const k of Object.keys(pos)) pos[k].x += off;
  }

  /* --- 锚点对齐：整树平移，使锚点 x 与基准树一致 --- */
  if (basePos && tree.anchorId && pos[tree.anchorId] && basePos[tree.anchorId]) {
    const delta = basePos[tree.anchorId].x - pos[tree.anchorId].x;
    for (const k of Object.keys(pos)) pos[k].x += delta;
  }

  const allX = Object.values(pos).map((q) => q.x);
  const allY = Object.values(pos).map((q) => q.y);
  const width = allX.length ? Math.max(...allX) + NODE_W - Math.min(...allX) : 0;
  const height = allY.length ? Math.max(...allY) + 120 : 0;

  return {
    pos,
    width,
    height,
    bounds: allX.length
      ? {
          minX: Math.min(...allX), maxX: Math.max(...allX) + NODE_W,
          minY: Math.min(...allY), maxY: Math.max(...allY) + 120,
        }
      : { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  };
}

/* ========================================================= */
/* 多棵树布局（主树 + 所有可展开家族）                            */
/* ========================================================= */

/**
 * 一次排完主树与全部可展开家族。
 *
 * 依赖顺序：主树先排 → 其余树各自排 → 再按锚点整体平移对齐。
 * 这样保证切换视角时，血缘主角的位置**不跳**。
 *
 * @param {object} dataset
 * @param {object} mainTree
 * @param {Array<{key,rootId,anchorId,label}>} expandable
 * @param {Function} buildTreeFn (dataset, opts) => tree
 * @returns {Record<string,{tree,pos,width,height,bounds}>}
 */
export function layoutAllTrees(dataset, mainTree, expandable = [], buildTreeFn, opts = {}) {
  const cfg = opts.cfg || {};
  const out = {};

  const mainLayout = layoutTree(mainTree, { cfg });
  out[mainTree.key] = { tree: mainTree, ...mainLayout };

  for (const ex of expandable) {
    const tree = buildTreeFn(dataset, {
      rootId: ex.rootId,
      anchorId: ex.anchorId,
      key: ex.key,
      label: ex.label,
    });
    // 主树里没有锚点 → 退化为整树居中，不强求对齐
    const basePos = mainLayout.pos[ex.anchorId] ? mainLayout.pos : null;
    const lay = layoutTree(tree, { basePos, cfg });
    out[ex.key] = { tree, ...lay };
  }

  return out;
}

/* ========================================================= */
/* 自检工具（供单测 / 开发期用）                                  */
/* ========================================================= */

/**
 * 校验一棵树的布局是否满足三条硬性约束。
 * 返回问题清单（空数组 = 全绿）。
 */
export function verifyLayout(tree, layout, cfg = LAYOUT) {
  const { NODE_W, SP_GAP } = cfg;
  const issues = [];
  const pos = layout.pos;
  const P = (id) => tree.people.find((p) => p.id === id);

  const inLine = new Set();
  for (const [c, p] of tree.lineage) { inLine.add(c); inLine.add(p); }
  const isMain = (p) => !!p && inLine.has(p.id);

  /* --- 夫妻间距必须 = NODE_W + SP_GAP --- */
  let couples = 0;
  for (const [a, b] of tree.couples) {
    if (!pos[a] || !pos[b]) continue;
    const A = P(a), B = P(b);
    if (!A || !B || !isMain(A) || isMain(B)) continue;
    couples++;
    const d = pos[b].x - pos[a].x;
    if (Math.abs(d - (NODE_W + SP_GAP)) > 0.5) {
      issues.push(`夫妻间距异常 ${a}→${b}: ${d}px（应为 ${NODE_W + SP_GAP}）`);
    }
  }

  /* --- 父必须居中于子女群（按单元边界比） --- */
  let fathers = 0;
  const kidsMap = new Map();
  for (const [c, p] of tree.lineage) {
    if (!kidsMap.has(p)) kidsMap.set(p, []);
    kidsMap.get(p).push(c);
  }
  const spouseOfMain = {};
  for (const [a, b] of tree.couples) {
    const A = P(a), B = P(b);
    if (A && B && isMain(A) && !isMain(B)) spouseOfMain[a] = b;
    else if (A && B && isMain(B) && !isMain(A)) spouseOfMain[b] = a;
  }
  for (const [pid, kids] of kidsMap) {
    const self = pos[pid];
    if (!self) continue;
    const validKids = kids.filter((k) => pos[k]);
    if (!validKids.length) continue;
    fathers++;

    const lefts = validKids.map((k) => pos[k].x);
    const rights = validKids.map((k) => {
      const s = spouseOfMain[k];
      const rightX = s && pos[s] ? Math.max(pos[k].x, pos[s].x) : pos[k].x;
      return rightX + NODE_W;
    });
    const spanCenter = (Math.min(...lefts) + Math.max(...rights)) / 2;
    const unitW = NODE_W + (spouseOfMain[pid] ? NODE_W + SP_GAP : 0);
    const selfCenter = self.x + unitW / 2;
    const dev = Math.abs(selfCenter - spanCenter);
    if (dev > 1.5) {
      issues.push(`父节点未居中 ${pid}: 偏 ${dev.toFixed(1)}px`);
    }
  }

  /* --- 同代单元不得重叠 --- */
  const items = tree.people
    .filter((p) => isMain(p) && pos[p.id])
    .map((p) => {
      const s = spouseOfMain[p.id];
      const left = pos[p.id].x;
      const right =
        (s && pos[s] ? Math.max(pos[p.id].x, pos[s].x) : pos[p.id].x) + NODE_W;
      return { id: p.id, l: left, r: right, g: pos[p.id].y };
    })
    .sort((a, b) => a.l - b.l);

  for (let i = 1; i < items.length; i++) {
    if (items[i].g === items[i - 1].g && items[i].l < items[i - 1].r - 0.5) {
      issues.push(
        `同代单元重叠 ${items[i - 1].id} ↔ ${items[i].id}: ${(items[i].l - items[i - 1].r).toFixed(0)}px`
      );
    }
  }

  return { issues, couples, fathers, nodes: Object.keys(pos).length };
}
