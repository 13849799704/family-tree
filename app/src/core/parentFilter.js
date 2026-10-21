/**
 * 父母候选的过滤 —— 纯函数，抽到 core 是因为这段逻辑**已经被改错过三次**：
 *   ① 20-10-09 补了「辈分下界」：父母必须比自己年长
 *      （在此之前，下拉按「年轻 → 年长」排，自己的子女永远排第 1）。
 *   ② 20-10-11 补了「辈分上界」：用户报「妻子家族里给妻子的父亲设母亲，
 *      下拉里能选到太爷爷」—— 只管下界不管上界，高三辈的人也会冒出来。
 *   ③ 20-10-11 补了「性别过滤」：用户报「男的不应该出现在母亲选项里，
 *      女的也不应该出现在父亲选项里」—— 以前性别只是**排序权重**，
 *      候选列表里男女全在，只是对的排前面。
 * 四处都因为它躺在 `ui/dialog.js` 里而没有测试兜着，所以抽出来钉死。
 */

/**
 * 筛掉「不可能是父母」的人。两道关：**性别** + **辈分**。
 *
 * ⚠️ 性别未知的（`sex === ''`）两边都放行 —— 那是「待补充信息」，
 *    不能因为还没填性别就让人查无此人（真要严格，得先让人去体检补上）。
 *
 * @param {object[]} base 候选池（已排除本人 / 自己的配偶 / 自己的后代）
 * @param {number|null|undefined} myGen 目标人物的世次
 * @param {string} selected 已选中的那位（无论多怪都必须留在列表里）
 * @param {'M'|'F'} wantSex 该槽位期望的性别：'M' 父亲 / 'F' 母亲
 * @returns {object[]} 过滤后的候选
 */
export function filterParentCandidates(base, myGen, selected, wantSex) {
  const pool = base || [];

  // ① 性别关：男性不进「母亲」候选，女性不进「父亲」候选。
  //    已选中的那位是例外 —— 历史数据可能有性别录错的下拉值，
  //    它一消失，用户一保存就静默清空这条关系。
  const sameSex = pool.filter((p) =>
    p.id === selected || p.sex === '' || !wantSex || p.sex === wantSex);

  // ② 辈分关：父母只应该高一代，太爷爷/曾祖父母都不该出现。
  //    逐级放宽，但**绝不让下拉空掉**（项目铁律）。
  const keep = (p) => p.id === selected || myGen == null;
  const strict = sameSex.filter((p) =>
    keep(p) || p.gen == null || (p.gen > myGen && p.gen <= myGen + 1));
  if (strict.length) return strict;

  const loose = sameSex.filter((p) => keep(p) || p.gen == null || p.gen > myGen);
  if (loose.length) return loose;

  // ③ 兜底：连放宽都空了 → 退回「性别对得上」的全量，而不是原始全量
  return sameSex;
}

/* ========================================================= */
/* 候选分组：这个人属于「哪边的家族」                        */
/* ========================================================= */

/** 三个分组，顺序即下拉里从上到下的顺序。 */
export const PARENT_GROUP = {
  SELF: 'self',       // 谱主本家的长辈
  AFFINAL: 'affinal', // 配偶那边的长辈
  OTHER: 'other',     // 跟谱主还没连上，说不清是哪边
};

/** 分组标题。带「· N 人」由 UI 拼，这里只给主干文案。 */
export const PARENT_GROUP_LABEL = {
  [PARENT_GROUP.SELF]: '本家长辈',
  [PARENT_GROUP.AFFINAL]: '配偶家长辈',
  [PARENT_GROUP.OTHER]: '其他待定',
};

const GROUP_ORDER = [PARENT_GROUP.SELF, PARENT_GROUP.AFFINAL, PARENT_GROUP.OTHER];

/**
 * 这个人在谱主的家族里算哪一边。
 *
 * 【为什么只能看路径首符号】血亲对血亲的称谓天然对称 —— 我的太奶奶和
 * 妻子的太奶奶，从「我」这儿算出来**都是「太奶奶」**，分不出来；
 * 名字也常常都没填（`displayName` 一律回「未知」）。真正能把两人区分开的
 * 只有一件事：他属于哪边的家族。而这件事由路径的**第一个符号**唯一决定：
 *   F / M 开头 → 顺着我的血脉往上 → 本家
 *   W / H 开头 → 先跳到配偶再往上 → 配偶那边
 * 用户 2026-10-11 报的就是这个：给妻子那边的孩子设母亲时，
 * 「我太奶奶」和「妻子她太奶奶」在下拉里字面一模一样，选错了，
 * 结果四个人的排行全乱（「三爷爷」「六姑婆」就是这么来的）。
 *
 * @param {string[]} symbols 从谱主到该人的关系路径，如 ['W','F','F','M']
 * @returns {'self'|'affinal'|'other'}
 */
export function branchOfSymbols(symbols) {
  const first = (symbols || [])[0];
  if (first === 'F' || first === 'M') return PARENT_GROUP.SELF;
  if (first === 'W' || first === 'H') return PARENT_GROUP.AFFINAL;
  return PARENT_GROUP.OTHER;          // 空路径 / 算不出关系
}

/**
 * 把候选按分组切开，**组内顺序原样保留**（排序是 UI 那边的权重决定的，
 * 这里不重排、不合并，两边各管各的）。
 *
 * @param {object[]} gens 已过滤+已排序的候选
 * @param {(p:object)=>string} branchOf 每人的分组键
 * @returns {{grouped:boolean, groups:{key:string,label:string,items:object[]}[]}}
 *   `grouped` 为 false 时 UI 应**退回平铺**，别画只有一条的分组线。
 */
export function splitParentCandidates(gens, branchOf) {
  const buckets = new Map(GROUP_ORDER.map((k) => [k, []]));
  for (const p of gens || []) {
    const key = branchOf(p);
    // 传进来的键不认识（将来加了新分组却忘了补 GROUP_ORDER）→ 归「待定」，不丢人
    (buckets.get(key) || buckets.get(PARENT_GROUP.OTHER)).push(p);
  }
  const groups = GROUP_ORDER
    .map((key) => ({ key, label: PARENT_GROUP_LABEL[key], items: buckets.get(key) }))
    .filter((g) => g.items.length);      // 空组不渲染
  return { grouped: groups.length > 1, groups };
}