/**
 * =========================================================
 * 称谓推导引擎 · kinship.js
 * ---------------------------------------------------------
 * 纯函数：输入关系数据 + 视角人，输出每个人对视角人的称呼。
 * 无副作用、无 DOM、可单测。
 *
 * 【推导原理】PRD §4.1
 *   称谓 = 从「我」到目标人的路径 + 规则匹配
 *   判定三要素：辈分差 / 分叉方向 / 性别
 *
 * 【算法】最近公共祖先（LCA）+ 兄弟步压缩
 *   1. 从「我」和目标人各自向上收集祖先链（BFS，保证最短）
 *   2. 取总距离最短的公共祖先 = LCA
 *   3. 严格路径 = 上行段 + 下行段，如 二爷爷 = F F F S
 *   4. **压缩**：路径形状必然是「上行到 A，再下行」。
 *      下行的第一步 C1 是 A 的儿子，而我在 A 下的那条链是 n(u-1)。
 *      因为 A 是最深公共祖先，C1 ≠ n(u-1) → C1 与 n(u-1) 是**兄弟**。
 *      于是把「最后一步上行 + 第一步下行」压成一个兄弟步 B/Z。
 *      → 二爷爷 = F F B（而不是 F F F S）
 *
 *   ⚠️ 这一步压缩很关键：规则表用的是「口语路径」（F-B = 伯父），
 *      不压缩的话会多出一代，整个规则表都对不上。
 *      详见 README「文档冲突」第 7 条。
 *
 *   5. 姻亲：血缘不通时，先走一步配偶（W/H），再在配偶的血亲里找路径
 *
 * 【长幼判定】
 *   规则标了 age 的，比较「目标（去掉尾部配偶）」与「主语同辈的参照人」。
 *   参照人 = 沿路径回溯到的、与主语同辈且同支的最近祖先（pickAgeRefIdx）：
 *     W B（妻子的兄弟）→ 妻子   ← 配偶步不改辈分，不能取「我」
 *     F B（父亲的兄弟）→ 父亲
 *     F B S（堂兄弟）  → 我
 *   只在双方同父同母时才允许用 order 兜底，跨家庭宁可不判（不猜）。
 *
 * 【未覆盖不猜】PRD §10：匹配不到规则时输出关系描述，绝不编造。
 * =========================================================
 */

import { buildIndex, displayName } from './model.js';
import { lookupRule, describePath, needsAge, withRank, BRANCH, RULES } from './rules.js';

/** 血缘上溯的最大层数（普通家族 4~5 代足够） */
const MAX_UP_DEPTH = 8;

/**
 * 姻亲最多跳几层「婚姻」。
 * 1 层 = 岳父 / 嫂子 / 妹夫
 * 2 层 = 内嫂（妻兄之妻）/ 岳祖父（妻之祖父）/ 连襟
 * 再往上收益极低且路径难读，故封顶 2。
 */
const MAX_AFFINAL_DEPTH = 2;

/**
 * 每一步关系符号的辈分增减。
 *   父母 +1 · 子女 −1 · 兄弟姊妹/配偶 0
 * 用于沿路径推算「参照人」的辈分落点。
 */
const STEP_GEN = { F: 1, M: 1, S: -1, D: -1, B: 0, Z: 0, W: 0, H: 0 };


/* ========================================================= */
/* 主入口                                                      */
/* ========================================================= */

/**
 * 推导目标人对「我」的称呼。
 *
 * @param {object} dataset 已 resolve gen 的规范化数据
 * @param {object} idx     buildIndex 产物
 * @param {string} meId    视角人
 * @param {string} targetId 目标人
 * @returns {{
 *   ok: boolean,
 *   kind: 'self'|'blood'|'affinal'|'unknown',
 *   symbols: string[],        // 压缩后的路径符号
 *   rawSymbols: string[],     // 未压缩的严格 LCA 路径（调试）
 *   nodes: string[],          // 沿途节点 id
 *   std: string, dialect: string, alt: string[], note: string,
 *   branch: string,
 *   genDelta: number,
 *   desc: string,
 *   reason: string,           // 未覆盖时的说明
 * }}
 */
export function deriveKinship(dataset, idx, meId, targetId) {
  const _idx = idx || buildIndex(dataset);

  if (!meId || !targetId) return unknown('缺少视角人或目标人');
  if (meId === targetId) {
    return {
      ok: true,
      kind: 'self',
      symbols: [],
      rawSymbols: [],
      nodes: [meId],
      std: '本人',
      dialect: '我',
      alt: [],
      note: '',
      branch: BRANCH.DIRECT,
      genDelta: 0,
      desc: '本人',
      reason: '',
    };
  }

  const genOf = (id) => _idx.byId.get(id)?.gen ?? 0;
  const genDelta = genOf(targetId) - genOf(meId);

  /* --- 统一搜索：血缘优先，姻亲按「配偶跳数」递归 --- */
  let found = searchPath(_idx, meId, targetId, new Set([meId]), MAX_AFFINAL_DEPTH);

  /* --- A / B 都不通，再试 C 路：路径中间夹配偶步（亲家那一族）--- */
  if (!found) {
    found = searchPathMidAffinal(_idx, meId, targetId, new Set([meId]));
  }

  if (found) {
    return finalize(dataset, _idx, meId, targetId, {
      symbols: found.symbols,
      rawSymbols: found.rawSymbols,
      nodes: found.nodes,
      kind: found.kind,
      genDelta,
    });
  }

  /* --- 兜底：不猜，出关系描述 --- */
  const t = _idx.byId.get(targetId);
  return unknown(
    `找不到「${_idx.byId.get(meId) ? displayName(_idx.byId.get(meId)) : meId}」到「${t ? displayName(t) : targetId}」的连通路径`,
    t ? `${displayName(t)}（关系待确认）` : ''
  );
}

/**
 * 通用路径搜索 —— 血缘 + 姻亲。
 *
 * 血缘走不通时，把「配偶」当成一步继续搜，最多 MAX_AFFINAL_DEPTH 跳姻亲。
 * 两个方向都要试：
 *   A) 从我这个方向跳：我的配偶的血亲（岳父 / 内兄 / 妻妹 …）
 *   B) 从目标那头跳：我的血亲的配偶（嫂子 / 婶婶 / 堂弟媳 …）
 *
 * 为什么必须递归而不是写死两步：`内嫂` = W B W 是**两跳**姻亲
 * （我的配偶 → 配偶的兄弟 → 兄弟的妻子），
 * 写死「血缘 + 一步配偶」的版本永远推不出来，只会输出「关系待确认」。
 *
 * ⚠️⚠️ A / B 两路必须**都跑完再择优**，不能「A 路命中就返回」（动了必炸）：
 *
 *   同一个人的两条路，A 路可能绕得更远，却因为跑在前面先把结果抢走。
 *   实测（自家 158 人谱）：儿子的妻子本该是 `S W`（我 → 儿子 → 他的妻子），
 *   A 路却绕成 `W S W`（我 → 妻子 → 她的儿子 → 他的妻子）——
 *   指向同一个人，规则表只认前者，后者查不到就显示「（关系待确认）」。
 *   同理，女儿的丈夫本该是 `D H`，被绕成 `W D H`（女婿也没了）。
 *
 *   择优口径：**总步数少的赢；一样长时 B 路赢**（B 路语义上更贴近
 *   「这是我血亲的配偶」，也更符合口语习惯）。
 *
 * @param {Set<string>} visited 已访问的人，防绕圈（妻 → 我 → 妻 …）
 * @returns {{symbols,rawSymbols,nodes,kind}|null} symbols 与 nodes 均以 fromId 起头
 */
function searchPath(idx, fromId, targetId, visited, depth) {
  /* --- 1) 纯血缘 --- */
  const b = bloodPath(idx, fromId, targetId);
  if (b) {
    return { symbols: b.symbols, rawSymbols: b.rawSymbols, nodes: b.nodes, kind: 'blood' };
  }

  if (depth <= 0) return null;

  /* --- 2) A / B 两路都跑一遍，取步数最少的那条 ---
     B 路排在前面循环：用 `<` 严格小于，同长时先到的 B 路自然留下。 */
  let best = null;
  const keep = (res) => {
    if (res && (!best || res.symbols.length < best.symbols.length)) best = res;
  };

  /* 2-1) B 路：目标是「我某个血亲的配偶」 */
  for (const sp of idx.spouseOf.get(targetId) || []) {
    if (visited.has(sp)) continue;
    const nextVisited = new Set(visited);
    nextVisited.add(sp);

    const sub = searchPath(idx, fromId, sp, nextVisited, depth - 1);
    if (sub) {
      const step = idx.byId.get(targetId)?.sex === 'F' ? 'W' : 'H';
      keep({
        symbols: [...sub.symbols, step],
        rawSymbols: [...sub.rawSymbols, step],
        nodes: [...sub.nodes, targetId],
        kind: 'affinal',
      });
    }
  }

  /* 2-2) A 路：跳到我方配偶，在配偶的血亲里找目标 */
  for (const sp of idx.spouseOf.get(fromId) || []) {
    if (visited.has(sp)) continue;
    const step = idx.byId.get(sp)?.sex === 'F' ? 'W' : 'H';
    const nextVisited = new Set(visited);
    nextVisited.add(sp);

    const sub = searchPath(idx, sp, targetId, nextVisited, depth - 1);
    if (sub) {
      keep({
        symbols: [step, ...sub.symbols],
        rawSymbols: [step, ...sub.rawSymbols],
        nodes: [fromId, ...sub.nodes],
        kind: 'affinal',
      });
    }
  }

  return best;
}

/* ========================================================= */
/* C 路：夹在路径中间的配偶步（专治「亲家」这一族）                    */
/* ========================================================= */

/** 两段血亲各自允许的最大步数 —— 超过就不认，别把八竿子打不着的人算成亲戚 */
const MID_AFFINAL_MAX = 2;

/**
 * 路径**中间**插一个配偶步的血亲关系，A / B 路都够不着的那一类。
 *
 * A / B 路只在路径的两端尝试配偶跳，夹在中间的那一步两边都摸不到，
 * 于是「我 → 儿子 → 儿媳 → 亲家公」推不出来，symbols 为空，
 * 界面上直接显示「（关系待确认）」。典型代表全是常识级称谓：
 *
 *   S W F / S W M   我儿媳的爹妈        亲家公 / 亲家母
 *   D H F / D H M   我女婿的爹妈        亲家公 / 亲家母
 *   S W B / S W Z   我儿媳的兄弟姊妹
 *
 * ⚠️⚠️ 三条设计约束，都是被实测打出来的，动了必炸：
 *
 *   1) **只能由 deriveKinship 在顶层调用**，绝不能塞进 searchPath 里递归。
 *      塞进去过一次：A 路递归到配偶那一层时会再触发本函数并叠加前缀，
 *      路径变成 `H-S-W-F` 这种「丈夫的儿子的妻子的父亲」；
 *      递归更深时还会产出 `W-S-F-M-F-S-W`（妻子的儿子的妻子的母亲的哥哥的妻子）
 *      这种绕地球的垃圾路径，直接把 F8 体检「示例数据全绿」炸红（实测 6 项红）。
 *
 *   2) 配偶步之后**只能走纯血亲**（bloodPath），不能再跳配偶。
 *      允许套娃就等于允许任意绕路，「最近关系」这个前提就没了。
 *
 *   3) 两段血亲各限 MID_AFFINAL_MAX 步。少了这个限制，
 *      「儿媳的妈妈的哥哥的妻子」也会被认成亲戚 —— 路径能连通，
 *      但那个位置上根本没有一个称谓在等着，只会换个姿势显示「关系待确认」。
 *
 * 语义边界：借一个血亲进他配偶的娘家 / 配偶自己的原生家庭，再纯血亲走过去。
 * 例如儿媳的娘家、孙媳的娘家、女婿的原生家庭（这些以前整族兜底）。
 *
 * @param {Set<string>} visited 已访问的人，防绕圈
 * @returns {{symbols,rawSymbols,nodes,kind}|null} symbols 与 nodes 均以 meId 起头
 */
function searchPathMidAffinal(idx, meId, targetId, visited) {
  const cands = [...collectKin(idx, meId).values()]
    .filter((r) => r.symbols.length >= 1 && r.symbols.length <= MID_AFFINAL_MAX)
    .sort((a, b) => a.symbols.length - b.symbols.length);   // 最近的先试

  for (const rec of cands) {
    const x = rec.nodes[rec.nodes.length - 1];
    for (const sp of idx.spouseOf.get(x) || []) {
      if (visited.has(sp) || sp === meId) continue;
      const b = bloodPath(idx, sp, targetId);
      if (!b || b.symbols.length > MID_AFFINAL_MAX) continue;
      const step = idx.byId.get(sp)?.sex === 'F' ? 'W' : 'H';
      return {
        symbols: [...rec.symbols, step, ...b.symbols],
        rawSymbols: [...rec.symbols, step, ...b.rawSymbols],
        nodes: [...rec.nodes, ...b.nodes],
        kind: 'affinal',
      };
    }
  }
  return null;
}

/** 一次性推导全表 —— 渲染时用 */
export function deriveAllKinships(dataset, meId) {
  const idx = buildIndex(dataset);
  const out = new Map();
  for (const p of dataset.people || []) {
    out.set(p.id, deriveKinship(dataset, idx, meId, p.id));
  }
  return out;
}

/* ========================================================= */
/* 血缘路径（含兄弟步压缩）                                      */
/* ========================================================= */

/**
 * 收集从 startId 出发、向上可达的全部祖先。
 * BFS 保证「首次到达 = 最短路径」。
 *
 * @returns {Map<string,{symbols:string[],nodes:string[]}>}
 */
function collectAncestors(idx, startId) {
  const map = new Map();
  map.set(startId, { symbols: [], nodes: [startId] });

  const queue = [startId];
  while (queue.length) {
    const cur = queue.shift();
    const rec = map.get(cur);
    if (!rec || rec.symbols.length >= MAX_UP_DEPTH) continue;

    // 父亲优先入队 → 同距离时父系路径胜出（同父同母的兄弟走父系）
    const parents = (idx.parentsOf.get(cur) || [])
      .slice()
      .sort((a, b) => {
        const sa = idx.byId.get(a)?.sex === 'M' ? 0 : 1;
        const sb = idx.byId.get(b)?.sex === 'M' ? 0 : 1;
        return sa - sb;
      });

    for (const pid of parents) {
      if (map.has(pid)) continue;
      const per = idx.byId.get(pid);
      if (!per) continue;
      const sym = per.sex === 'M' ? 'F' : 'M';
      map.set(pid, {
        symbols: [...rec.symbols, sym],
        nodes: [...rec.nodes, pid],
      });
      queue.push(pid);
    }
  }
  return map;
}

/**
 * 求 blood path：严格 LCA 路径 + 兄弟步压缩。
 * @returns {{symbols, rawSymbols, nodes, lca}|null}
 */
function bloodPath(idx, meId, targetId) {
  const ancMe = collectAncestors(idx, meId);
  const ancTgt = collectAncestors(idx, targetId);

  // 找总距离最短的公共祖先
  let best = null;
  for (const [id, m] of ancMe) {
    const t = ancTgt.get(id);
    if (!t) continue;
    const total = m.symbols.length + t.symbols.length;
    const paternal = (m.symbols[0] || 'F') === 'F'; // 同距离优先父系
    if (
      !best ||
      total < best.total ||
      (total === best.total && paternal && !best.paternal)
    ) {
      best = { id, m, t, total, paternal };
    }
  }
  if (!best) return null;

  const upSymbols = best.m.symbols;          // 我 → LCA
  const upNodes = best.m.nodes;              // [me, ..., LCA]
  const tNodes = best.t.nodes;               // [target, ..., LCA]

  // LCA → target 的下行符号（看每一层的「子」是男是女）
  const downSymbols = [];
  for (let i = tNodes.length - 1; i >= 1; i--) {
    const child = idx.byId.get(tNodes[i - 1]);
    downSymbols.push(child?.sex === 'M' ? 'S' : 'D');
  }

  const rawSymbols = [...upSymbols, ...downSymbols];
  // tNodes 是 [target, ..., LCA]，倒过来即 [LCA, ..., target]
  const downNodes = tNodes.slice().reverse();
  // 去掉重复的 LCA，拼成完整沿途节点
  const rawNodes = [...upNodes, ...downNodes.slice(1)];

  /* --- 兄弟步压缩 --- */
  let symbols;
  let nodes;

  if (upSymbols.length >= 1 && downSymbols.length >= 1) {
    // C1 = LCA 在目标侧的子女（= 我这一侧同辈那个人的兄弟）
    const c1 = tNodes[tNodes.length - 2];
    const c1Sex = idx.byId.get(c1)?.sex;
    const sib = c1Sex === 'M' ? 'B' : 'Z';

    symbols = [
      ...upSymbols.slice(0, -1), // 去掉最后一步上行
      sib,                       // 换成兄弟步
      ...downSymbols.slice(1),   // 去掉第一步下行
    ];
    // upNodes 末尾是 LCA，去掉；补上 C1；再接 C1 之后的节点
    // downNodes = [LCA, C1, C2, ..., target] → slice(2) = [C2, ..., target]
    nodes = [
      ...upNodes.slice(0, -1),
      c1,
      ...downNodes.slice(2),
    ];
  } else {
    symbols = rawSymbols;
    nodes = rawNodes;
  }

  return { symbols, rawSymbols, nodes, lca: best.id };
}

/* ========================================================= */
/* 血亲可达集（上下行都走，供 C 路找「中间配偶」用）                      */
/* ========================================================= */

/**
 * 从 startId 出发，沿**血亲边双向** BFS，收集全部可达血亲节点及其符号路径。
 *
 * ⚠️ 为什么不能直接复用 collectAncestors：那个函数只向上走（收集祖先），
 *    而「我 → 儿子 → 儿媳」里的儿子是**下行**方向，祖先集里根本没有它，
 *    于是 C 路照样够不着 —— 实测就是我儿媳的爹妈仍然推不出来。
 *
 * @returns {Map<string,{symbols:string[],nodes:string[]}>} nodes 以 startId 起头
 */
function collectKin(idx, startId) {
  const map = new Map();
  map.set(startId, { symbols: [], nodes: [startId] });

  const queue = [startId];
  while (queue.length) {
    const cur = queue.shift();
    const rec = map.get(cur);
    if (!rec || rec.symbols.length >= MAX_UP_DEPTH) continue;

    /* 上行到父母 */
    for (const pid of idx.parentsOf.get(cur) || []) {
      if (map.has(pid)) continue;
      const p = idx.byId.get(pid);
      if (!p) continue;
      const sym = p.sex === 'M' ? 'F' : 'M';
      map.set(pid, { symbols: [...rec.symbols, sym], nodes: [...rec.nodes, pid] });
      queue.push(pid);
    }

    /* 下行到子女 */
    for (const kid of idx.kidsOf.get(cur) || []) {
      if (map.has(kid)) continue;
      const k = idx.byId.get(kid);
      if (!k) continue;
      const sym = k.sex === 'M' ? 'S' : 'D';
      map.set(kid, { symbols: [...rec.symbols, sym], nodes: [...rec.nodes, kid] });
      queue.push(kid);
    }
  }

  return map;
}

/* ========================================================= */
/* 规则匹配 + 长幼判定                                          */
/* ========================================================= */

function finalize(dataset, idx, meId, targetId, info) {
  const { symbols, rawSymbols, nodes, kind, genDelta } = info;
  const target = idx.byId.get(targetId);

  /* --- 长幼 --- */
  const age = judgeAge(idx, symbols, nodes);

  /* --- 查规则 --- */
  const rule = lookupRule(symbols, age);

  if (!rule) {
    return {
      ok: false,
      kind: 'unknown',
      symbols,
      rawSymbols,
      nodes,
      std: '',
      dialect: '（关系待确认）',
      alt: [],
      note: '',
      branch: branchOf(symbols),
      genDelta,
      desc: describePath(symbols),
      reason: `规则表未覆盖路径 ${symbols.join('-') || '（空）'}`,
    };
  }

  // 规则自带的辈分差可能与数据算出的不一致 → 以数据为准，但标记出来
  // ⚠️ 亲家后缀兜底出来的规则例外：它的 gen 是按「剥掉前缀后的短路径」占位的 0，
  //    真实辈分取决于被剥掉几段血亲（S W F F 是 +1，不是 0），
  //    拿它跟 genDelta 比会凭空报一堆「辈分不一致」，那是误报。
  const mismatch = !rule.inlawFallback && rule.gen !== genDelta;

  /* --- 排行前缀：大伯 / 二叔 / 三姑 / 小舅 ---
     ⚠️ 排行要跟「主语」走，不是跟目标本人走：
        婶的排行由她丈夫（我三叔）决定，她自己的 order 是她娘家的排行。
        「主语」= 去掉尾部配偶步之后的那个人 —— 与 judgeAge 同一套判定。 */
  let dialect = rule.dialect;
  let ranked = false;
  if (rule.ranked) {
    const { id: subjectId, index: subjectIdx } = subjectOf(symbols, nodes);
    const subject = idx.byId.get(subjectId);
    if (subject?.order != null) {
      // 锚点 = 路径上主语的**前一个人**（`M Z` 里是妈妈，不是外婆），以及是兄弟步还是姐妹步。
      // ⚠️ meId 一起传进去：`Z` 步只有「锚点是我」时（我的姐妹）才剔除锚点
      const anchorId = subjectIdx >= 1 ? nodes[subjectIdx - 1] : null;
      const step = symbols[subjectIdx - 1];
      const order = rankAmongSibs(idx, subjectId, anchorId, step, nodes[0]);

      /* 「小」化：在「比我爸妈小的那批长辈」里，他就是最年幼的那一个
       → 改叫「小叔 / 小姑 / 小舅 / 小姨」，配偶跟着叫「婶 / 妗子 / 姨夫」，
       配偶不加「小」也不报排行。判定见 isYoungestSmaller。
       ⚠️ **不看排行第几位**：只要他后面没有更小的，「小」就轮到他。
          这样三个长辈时末位那位自然叫小叔，五个长辈时也只会有一个小舅 ——
          排行第几位是结果，不是门槛。
       ⚠️ 候选池是「爸妈的全体同胞，不限性别」：叔姑抢同一个「小」。 */
      const refIdx = pickAgeRefIdx(symbols, subjectIdx);
      const smalled = !!rule.small
        && isYoungestSmaller(idx, subjectId, refIdx >= 0 ? nodes[refIdx] : null, step);

      if (smalled) {
        dialect = rule.small;
      } else if (rule.path === 'B' || rule.path === 'Z') {
        /* 亲兄弟姐妹的排行（2026-10-11 用户定稿，当天改过三次，这里是最终口径）：
             **按「称呼类型」分组数：该类型下只有一人时就不报数。**
             称呼类型就是嘴上会说的那两个字：
               哥 / 姐侧 = 排在我前面的同性别同胞
               弟 / 妹侧 = 排在我后面的同性别同胞
             某一侧只有一位 → 那个方向不必区分，直接叫「哥哥」「弟弟」…
             某一侧有两位及以上 → 整侧报数（大哥 / 二哥 / 四弟 / 大姐 / 二姐…）

             ⚠️ 三轮修订的教训，别再改回去：
               ① v0.2.32「最年幼的不带数字」—— 四兄弟时顺，一遇到「我老三、
                  上面两个姐姐」就崩：最小的姐姐被叫「姐姐」，跟「大姐」分不清。
               ② v0.2.38「同性别 ≥2 人全报数」—— 把长幼两个方向混在一起数，
                  于是四兄弟的老四从「弟弟」变成了「四弟」（只比我小一岁，很生分）。
               ③ 现在：按称呼类型分开数，上面两个例子同时成立。
             ⚠️ order 缺失时排不出来 → 退回不带排行的说法，宁可不排也不瞎排。 */
        const meId = nodes[0];
        const subSex = subject?.sex;

        /* ⚠️ 不能拿 `sibGroup(subjectId)` 算：那个函数按**目标人**的性别过滤，
           我要是男性，就压根不在姐姐那个组里，`indexOf(me)` 永远是 -1。
           所以这里自己排：取「我」的全部同胞（**不限性别**），按 order 升序，
           再按「目标人的性别 + 相对我的方向」数这个称呼类型下有几个人。 */
        const allSet = new Set([meId]);   // ⚠️ 必须去重：父母双方各自会把同一批孩子列一遍，
        for (const p of idx.parentsOf.get(meId) || []) {   // 不去重的话 all 会变成
          for (const c of idx.kidsOf.get(p) || []) allSet.add(c);   // b1 b1 b2 b2 me b4 b4，计数直接翻倍
        }
        const all = [...allSet];
        all.sort((a, b) => {
          const oa = idx.byId.get(a)?.order;
          const ob = idx.byId.get(b)?.order;
          if (oa == null && ob == null) return 0;
          if (oa == null) return 1;
          if (ob == null) return -1;
          return oa - ob;
        });

        const myIdx = all.indexOf(meId);
        const subIdx = all.indexOf(subjectId);
        let sideCount = -1;
        if (myIdx >= 0 && subIdx >= 0 && subSex) {
          const sameSide = subIdx < myIdx;   // 目标人在我前（哥/姐侧）还是后（弟/妹侧）
          sideCount = all.filter((x) => x !== meId
            && idx.byId.get(x)?.sex === subSex
            && (all.indexOf(x) < myIdx) === sameSide).length;
        }

        if (sideCount <= 1) {
          dialect = rule.dialect;          // 哥哥 / 弟弟 / 姐姐 / 妹妹，不报数
        } else {
          const withPrefix = withRank(rule, order);
          if (withPrefix !== rule.dialect) {
            dialect = withPrefix;
            ranked = true;
          }
        }
      } else {
        const withPrefix = withRank(rule, order);
        if (withPrefix !== rule.dialect) {
          dialect = withPrefix;
          ranked = true;
        }
      }
    }
  }

  /* --- 长幼判定不出来时，标一个不确定 --- */
  const ageUncertain = needsAge(symbols) && age == null;

  return {
    ok: true,
    kind,
    symbols,
    rawSymbols,
    nodes,
    std: rule.std,
    dialect,
    alt: rule.alt || [],
    note: rule.note || '',
    branch: rule.branch,
    genDelta,
    ruleGen: rule.gen,
    genMismatch: mismatch, // 供体检用
    ranked,
    age,
    ageUncertain, // 缺 order / birth，长幼按「年长」显示
    desc: describePath(symbols),
    reason: '',
  };
}

/**
 * 算排行前缀的序号 —— 两条独立的口语规矩，都得满足：
 *
 * 1) **只在同一性别里数**：舅和姨各排各的，伯叔和姑姑也各排各的。
 *    外公家五个孩子（order 0 舅 / 1 姨 / 2 舅 / 3 姨 / 4 舅）时，
 *    拿 order 直接当排行会叫出「五姨六姨」—— 现实里没人这么叫。
 *    正确是：舅舅那边 大舅/二舅/三舅，姨妈那边 大姨/二姨。
 *
 * 2) **只把「我自己」摘出去**：`Z` 步（我的姐妹）锚点就是「我」——
 *    我不当我自己的姐妹。
 *    ⚠️ 而 `M Z` / `F Z`（妈妈的姐妹 / 爸爸的姐妹）锚点是**参照长辈本人**：
 *    妈妈是外婆家的女儿，她在女儿序列里占着自己那一格，**不能剔**。
 *    剔了她排行会整体前移一位 —— 妈妈是长女时，本该叫「二姨 / 三姨」的
 *    两个妹妹会变成「大姨 / 二姨」，而且排行随视角漂移（同一房两个人都成大姨）。
 *    【2026-10-15 用户定：妈妈依旧参与排行】
 *    而 `B` 步**要**把父亲算进去 —— 「二叔」说的是爷爷的次子，
 *    父亲本人就占着一个位置（爷爷只有两个儿子时，叔叔确实叫二叔）。
 *
 * ⚠️ 性别未知（sex === ''）时退回「全体同胞」旧口径 —— 宁可排行粗一点，也不瞎排。
 *
 * 【2026-10-11 用户定：男同胞直取排行，女同胞维持重数】
 *    男性主体（大爷爷/二爷爷/大伯/二叔/大舅…）**直接用他填的 order**，
 *    所见即所得：排行填 2 就是父母子女里的第 3 个 → 三爷爷，
 *    中间断号（兄弟没录全）就如实跳号，不替用户猜。
 *    女性主体（大姨/大姑/大奶奶…）走同性别重数，**且妈妈本人留在序列里占号**
 *    （妈妈排行 4 时，排行 5 的姨妈叫「二姨」、排行 6 的叫「小姨」——
 *    她若是全家最小就小化，否则叫三姨）。性别未知同理走重数。
 *
 * @param {string} id        主语（排行跟谁走）
 * @param {string|null} anchorId 锚点（路径上主语的前一个人；`M Z` / `F Z` 里
 *                             就是参照长辈本人），只有它等于「我」时才剔除
 * @param {string} step      走到主语的那一步：'B' 兄弟 / 'Z' 姐妹
 * @param {string} [meId]    视角人物自己（nodes[0]），用来分辨「我的姐妹」与「妈妈的姐妹」
 * @returns {number} 序号（0 = 长）。**只报数不报总数** —— 「幺」已取消（rules.js → rankCn）
 */
function rankAmongSibs(idx, id, anchorId, step, meId) {
  const person = idx.byId.get(id);
  if (person?.sex === 'M' && person.order != null) return Math.max(0, person.order);
  return Math.max(0, sibGroup(idx, id, anchorId, step, meId).indexOf(id));
}

/**
 * 取排行用的「同辈同性群体」。
 *
 * ⚠️ 只有「我的姐妹」这一种场景要把锚点（= 我）剔掉；
 *    `M Z` / `F Z` 的锚点是妈妈/爸爸本人，**必须留在序列里**（见 rankAmongSibs）。
 *
 * @returns {string[]} 已按 order 升序排好的 id 列表（order 未知的排最后）
 */
function sibGroup(idx, id, anchorId, step, meId) {
  const person = idx.byId.get(id);
  const sibs = new Set();
  for (const p of idx.parentsOf.get(id) || []) {
    for (const c of idx.kidsOf.get(p) || []) {
      if (c !== id) sibs.add(c);
    }
  }

  let group = person.sex
    ? [id, ...sibs].filter((x) => idx.byId.get(x)?.sex === person.sex)
    : [id, ...sibs];

  // 只有锚点是「我自己」时剔除 —— 那才是「我的姐妹」，我不当我自己的姐妹。
  // ⚠️ 妈妈/爸爸不是我，即使我恰好是同性别、也在这个序列里，也不能剔（design D1）
  if (step === 'Z' && anchorId && anchorId === meId && group.includes(anchorId)) {
    group = group.filter((x) => x !== anchorId);
  }

  // kidsOf 已按 order 排过序，这里对同性子集再排一次；order 未知的排最后
  group.sort((a, b) => {
    const oa = idx.byId.get(a)?.order;
    const ob = idx.byId.get(b)?.order;
    if (oa == null && ob == null) return 0;
    if (oa == null) return 1;
    if (ob == null) return -1;
    return oa - ob;
  });

  return group;
}

/* ========================================================= */
/* 「小」化判定：小叔 / 小舅 / 小姑 / 小姨                          */
/* ========================================================= */

/**
 * 这是不是我爸妈那一辈里「比我小、且还是最小的那个」。
 *
 * 【为什么要有这条】2026-10-10 用户定：比我爸妈小的那些同辈长辈里，
 *     **最年幼的那一个**叫「小叔 / 小姑 / 小舅 / 小姨」，不再报排行数字。
 *     爷爷三个儿子、父亲排第二时，那个弟弟就该叫「小叔」而不是「三叔」——
 *     所以**没有「第几位」的门槛**，排行第几位是结果不是条件。
 *
 * 【为什么不会一次冒出好几个小舅】「比我小」的那批人里只取最年幼的一个，
 *     只要他后面还有更小的，「小」就轮不到他。于是五个舅舅里前四个照报
 *     （大舅 / 二舅 / 三舅 / 四舅），末位那个才是小舅。
 *
 * 【两个条件同时成立】
 *   1. 比我爸妈小 —— 比我大的照报「大伯」「大舅」
 *   2. 是这批人里最年幼的 —— 他后面还有更小的，那就轮不到他叫小
 *
 * 【参照长辈是谁】跟 `judgeAge` 同一套（`pickAgeRefIdx`）—— 叔姑跟父亲比、
 *     舅姨跟母亲比，岳家那边跟岳母 / 岳父比。⚠️ 过去这里写死 `nodes[1]`，
 *     妻子的姨妈（`W M Z`）就会拿**妻子**当参照人，比错了人。
 *
 * ⚠️ **只看排行，不看出生年**（2026-10-15 用户定）：修家谱的人知道排行、
 *     未必知道年龄，而且存在辈分大年龄小的人 —— 排行就是唯一的年龄证据。
 *     排行断号（0 / 2 / 5）按记录里最后一个算；排行没填则判不出谁最小，
 *     老实照报排行，宁可叫「四舅」也不猜一个小舅出来。
 *
 * @param {object} idx       索引
 * @param {string} subjectId 主语（排行跟谁走就是跟谁）
 * @param {string|null} refId 参照长辈（`pickAgeRefIdx` 给的下标对应的那个节点）
 * @param {string} step      走到主语那一步：'B' 兄弟 / 'Z' 姐妹
 * @returns {boolean} 该叫「小X」吗
 */
function isYoungestSmaller(idx, subjectId, refId, step) {
  if (step !== 'B' && step !== 'Z') return false;
  if (!refId || refId === subjectId) return false;

  const oSub = idx.byId.get(subjectId)?.order;
  const oRef = idx.byId.get(refId)?.order;
  if (oSub == null || oRef == null) return false;

  const pool = juniorPool(idx, refId);
  // 池里有人排行没填 → 谁最小判不出来 → 全体照报排行，不瞎叫小
  if (pool.some((x) => idx.byId.get(x)?.order == null)) return false;
  if (oSub <= oRef) return false;                          // 比我爸妈大的 → 照报排行（大伯 / 四舅）

  return pool[pool.length - 1] === subjectId;              // 后面没人更小 → 小X
}

/**
 * 「小」化用的候选池 —— 参照长辈的**全体同胞，不限性别**（含参照长辈本人）。
 *
 * 【为什么不复用 sibGroup】2026-10-15 用户定：叔姑抢同一个「小」、
 *     舅姨也抢同一个「小」 —— 爸爸那边最小的是姑姑，就没人叫小叔；
 *     舅舅排在最末时，姨一个都叫不到「小」。所以这一层不分类别，
 *     跟排行那层（同性别重数）是两套语义，别混在一起（design D2）。
 *
 * @returns {string[]} 按 order 升序排好的 id 列表（order 未知的排最后）
 */
function juniorPool(idx, refId) {
  const sibs = new Set([refId]);
  for (const p of idx.parentsOf.get(refId) || []) {
    for (const c of idx.kidsOf.get(p) || []) sibs.add(c);
  }
  return [...sibs].sort((a, b) => {
    const oa = idx.byId.get(a)?.order;
    const ob = idx.byId.get(b)?.order;
    if (oa == null && ob == null) return 0;
    if (oa == null) return 1;
    if (ob == null) return -1;
    return oa - ob;
  });
}

/**
 * 取「主语」—— 路径里真正决定称呼的那个人。
 *
 * 尾部连着几个配偶步就退几步：
 *   伯母的长幼由她丈夫决定，不由她自己；
 *   婶婶的排行由我三叔决定，不由她娘家的排行决定。
 *
 * @returns {{id:string|null, index:number}}
 */
function subjectOf(symbols, nodes) {
  if (!nodes.length) return { id: null, index: -1 };
  let trailing = 0;
  for (
    let i = symbols.length - 1;
    i >= 0 && (symbols[i] === 'W' || symbols[i] === 'H');
    i--
  ) {
    trailing++;
  }
  const index = Math.max(0, nodes.length - 1 - trailing);
  return { id: nodes[index], index };
}

/**
 * 选长幼参照人：主语**同辈、且在主语那一支上**离主语最近的祖先。
 *
 * ⚠️ 不能简单用 nodes[辈分差] —— 配偶步不改变辈分，会把参照人取到「我」头上：
 *   W B（妻子的兄弟）辈分差 0 → nodes[0] = 我，
 *   于是拿妻弟的排行去和我的排行比 —— 跨家庭比 order，结果一律是错的
 *   （我 order=1、妻弟 order=0 时，明明是小舅子却被判成「大舅子」）。
 *
 * 正确参照人是**妻子**：妻弟与妻子同父同母，排行和出生年都可比。
 *
 *   W B      → 妻子   （妻弟 vs 妻子）
 *   H B      → 丈夫
 *   W B W    → 妻子   （内嫂的长幼随丈夫）
 *   F B      → 父亲   （与旧逻辑一致）
 *   F B S    → 我     （堂兄弟与我）
 *   F F B    → 祖父   （与旧逻辑一致）
 *
 * @returns {number} 参照人在 nodes 中的下标；-1 = 找不到（无法判长幼）
 */
function pickAgeRefIdx(symbols, subjectIdx) {
  // cumulative[i] = nodes[i] 相对「我」的辈分差（沿路径符号累加）
  const cumulative = [0];
  for (let i = 0; i < subjectIdx; i++) {
    cumulative.push(cumulative[i] + (STEP_GEN[symbols[i]] ?? 0));
  }
  const subjectGen = cumulative[subjectIdx];
  for (let j = subjectIdx - 1; j >= 0; j--) {
    if (cumulative[j] === subjectGen) return j;
  }
  return -1;
}

/**
 * 判定长幼：比较「主语」与「主语同辈的参照人」。
 *
 * @returns {'older'|'younger'|null}
 */
function judgeAge(idx, symbols, nodes) {
  const { id: subjectId, index: subjectIdx } = subjectOf(symbols, nodes);
  if (!subjectId) return null;

  const vsIdx = pickAgeRefIdx(symbols, subjectIdx);
  if (vsIdx < 0 || subjectIdx === vsIdx) return null;

  const a = idx.byId.get(subjectId);
  const b = idx.byId.get(nodes[vsIdx]);
  if (!a || !b) return null;

  // order 只是「同一个父亲下的排行」，跨家庭比毫无意义 → 明确告诉 compareAge
  const cmp = compareAge(a, b, { sameParents: shareParent(idx, a, b) });
  if (cmp == null) return null;
  return cmp < 0 ? 'older' : 'younger';
}

/** 是否同父或同母 */
function shareParent(idx, a, b) {
  const pa = idx.parentsOf.get(a?.id) || [];
  if (!pa.length) return false;
  const pb = idx.parentsOf.get(b?.id) || [];
  return pa.some((p) => pb.includes(p));
}

/**
 * 比较谁年长。
 *
 * ⚠️ **必须优先用出生年，不能用排行**。
 * order 是「同一个父亲下的排行」，只能在自己家里比。
 * 跨家庭比 order 会得到荒谬结果：三叔的长子 order=0、我是次子 order=1，
 * 但他 1995 年生、我 1992 年生 —— 按 order 会把他叫成「堂哥」。
 *
 * 只有当双方都没有出生年时才退回 order，且**必须同父或同母**（sameParents）。
 * 不同父母 → 返回 null，宁可让 UI 报「长幼判不出来」，也不猜。
 *
 * @param {{sameParents?: boolean|null}} [opts]
 * @returns {number|null} 负数 = a 更年长
 */
export function compareAge(a, b, opts = {}) {
  const ya = yearOf(a?.birth);
  const yb = yearOf(b?.birth);
  if (ya != null && yb != null && ya !== yb) return ya - yb;

  if (opts.sameParents === false) return null;

  // 同年出生（或都没出生年）→ 退回排行
  if (a?.order != null && b?.order != null && a.order !== b.order) {
    return a.order - b.order;
  }
  return null;
}

function yearOf(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

/** 路径 → 关系大类（规则未命中时兜底用） */
function branchOf(symbols) {
  if (!symbols.length) return BRANCH.DIRECT;
  const head = symbols[0];
  if (head === 'W' || head === 'H') return BRANCH.AFFINAL;
  if (symbols.includes('W') || symbols.includes('H')) return BRANCH.AFFINAL;
  if (head === 'M') return BRANCH.MATERNAL;
  if (head === 'F') return BRANCH.PATERNAL;
  return BRANCH.DIRECT; // S / D / B / Z 开头 → 直系或同辈
}

function unknown(reason, desc = '') {
  return {
    ok: false,
    kind: 'unknown',
    symbols: [],
    rawSymbols: [],
    nodes: [],
    std: '',
    dialect: '（关系待确认）',
    alt: [],
    note: '',
    branch: BRANCH.DIRECT,
    genDelta: 0,
    desc,
    reason,
  };
}

/* ========================================================= */
/* 统计（给体检和开发期看）                                       */
/* ========================================================= */

/** 规则表规模 */
export function ruleStats() {
  // 同路径的多条（长幼变体）只算一条
  const uniq = new Set(RULES.map((r) => r.path));
  const byBranch = {};
  for (const r of RULES) {
    byBranch[r.branch] = (byBranch[r.branch] || 0) + 1;
  }
  return { total: RULES.length, uniquePaths: uniq.size, byBranch };
}

/* ========================================================= */
/* 称谓三级显示（PRD §4.4）                                      */
/* ========================================================= */

/**
 * 输出详情面板要的三行。
 *   本地叫法（大字）/ 标准称呼 / 关系描述
 */
export function kinshipTriple(kin) {
  if (!kin) return { main: '—', std: '', desc: '' };
  if (kin.kind === 'self') return { main: '我', std: '本人', desc: '' };
  if (!kin.ok) {
    return {
      main: kin.dialect,           // （关系待确认）
      std: '',
      desc: kin.desc || kin.reason,
      unknown: true,
    };
  }
  return { main: kin.dialect, std: kin.std, desc: kin.desc, unknown: false };
}

/**
 * 显示的「称呼大字」：优先用用户手动填的覆盖值，否则退回规则算出的 dialect。
 *
 * @param {object} person   人物对象（含 callOverride: { [viewpointId]: term }）
 * @param {object} kin      deriveKinship 结果（含 dialect / kind）
 * @param {string} viewpoint 当前视角人物 id
 * @returns {string}
 */
export function displayCall(person, kin, viewpoint) {
  if (!person) return kin?.dialect || '（关系待确认）';
  if (person.id === viewpoint) return '我';
  const override = person?.callOverride?.[viewpoint];
  if (override) return override;
  return kin?.dialect || '（关系待确认）';
}

/**
 * 「只显示姓名」开关的唯一决策点（v0.2.54）。
 *
 * 开关**只管显示，管不到推导**：称谓照算不误，这里只是决定卡面上那行大字
 * 写「称谓」还是写「姓名」。所以关掉开关立刻恢复原样，不存在数据被改。
 *
 * ⚠️ 为什么不给视角人自己返回「我」：节点上本来就有「我」的角标，
 * 姓名模式下再顶一个字会让人以为「我」是个称呼。统一走 displayName。
 *
 * @param {object} person   人物对象（缺失时退化成占位）
 * @param {object} kin      deriveKinship 结果
 * @param {string} viewpoint 当前视角人物 id
 * @param {boolean} showCall true = 显示称谓（默认，与 v0.2.53 及以前一致）
 * @returns {string}
 */
export function displayLabel(person, kin, viewpoint, showCall = true) {
  if (showCall) return displayCall(person, kin, viewpoint);
  if (!person) return '未知';
  return displayName(person);
}
