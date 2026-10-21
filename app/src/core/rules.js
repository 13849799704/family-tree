/**
 * =========================================================
 * 称谓规则表 · rules.js
 * ---------------------------------------------------------
 * 口径来源：河南南阳本地口语（用户 2026-10-10 逐条确认），规范称谓见 std
 * ⚠️ 早期那份 `族谱软件-称谓规则表.md` 已随武汉背景文档删除，别再找它
 *
 * 【路径记法】
 *   F 上行到父     M 上行到母
 *   S 下行到子     D 下行到女
 *   B 兄弟（同辈男性） Z 姐妹（同辈女性）
 *   W 配偶（妻）    H 配偶（夫）
 *
 *   路径从左到右依次执行。B/Z 的含义是「上一步到达的那个人的兄弟/姐妹」。
 *   例：'F B S'  = 我 → 父亲 → 父亲的兄弟 → 他的儿子 = 堂兄弟
 *       'F F B'  = 我 → 父 → 祖父 → 祖父的兄弟 = 伯祖父 / 叔祖父
 *       'W B'    = 我 → 妻子 → 妻子的兄弟 = 内兄 / 内弟
 *
 * 【与文档的差异】—— 必须知道，否则会和算法对不上
 *   文档的规则表用的是**口语路径**，本文件按**结构路径**重写，
 *   两者对同一路径可能差一代。举例（林浩是爸爸的三弟的儿子）：
 *     口语：父亲的兄弟的儿子      → F B S
 *     结构：同上，因为「父亲的兄弟」就是 B 一步 → F B S   ✓ 一致
 *   但如果是「爷爷的兄弟的儿子」（我爸爸的堂兄）：
 *     口语容易写成 F B S（错，那是爸爸的兄弟）
 *     结构：F F B S（爷爷的兄弟的孙子辈）  ← 本文件按结构写
 *
 * 【长幼判定】
 *   标了 age 的规则，比较「主语」与「我这一侧同辈分的人」：
 *     辈分 +1 → 比父亲；辈分 0 → 比我
 *   主语 = 目标去掉尾部的 W/H（伯母的长幼由她丈夫定）
 *
 * 【🔴 第一原则：口语优先，宁可重名也不说谱系学术语】
 * ---------------------------------------------------------
 *   本软件的初衷是**好称呼** —— 用户要的是能脱口而出的那个词，
 *   不是编族谱用的术语。所以：
 *
 *     ✗ 堂侄  从侄  堂侄女  从侄女  堂侄孙  堂外甥  表侄
 *     ✓ 侄子  侄女          侄孙          外甥
 *
 *   「堂侄」「从侄」这两个词现实里没人说，叫出来会被当成不会说话。
 *   代价是「侄子」会同时指亲哥/堂哥/从哥的儿子三个人 —— 但这本来就是
 *   口语的真实情况，族谱里靠「世次 + 关系描述」区分就够了（见 describePath）。
 *   **规范称谓不丢**：挪进 note 字段，需要查谱系时仍然看得到。
 *
 *   同理，同辈的哥哥的妻子一律叫「嫂子」，不叫堂嫂 / 表嫂 / 从嫂；
 *   长幼仍要分（哥哥的妻子叫嫂子，弟弟的妻子叫弟媳），亲疏由辈分表达。
 *
 * 【辈分怎么算】（与 data 无关，纯算术，gen 值必须对得上）
 *   F / M 各 +1（升一代）   S / D 各 -1（降一代）
 *   B / Z 各  0（同辈）      W / H 各  0（配偶同辈）
 *   例：'F F B S S W' = 1+1+0-1-1+0 = 0  → 从哥的妻子，跟我同辈 → 嫂子
 *       'F F B S S S' = 1+1+0-1-1-1   = -1 → 从哥的儿子，   比我低一代 → 侄子
 *   ⚠️ 别把这两个搞混 —— 搞混就会出现「侄媳」这种荒谬称谓。
 *
 * 【未命中不猜】规则表没有的路径一律走关系描述兜底（PRD §10）。
 * =========================================================
 */

/** 关系大类 —— 决定卡片描边色 */
export const BRANCH = {
  DIRECT: 'direct',       // 直系（祖 → 孙、亲兄弟姐妹）
  PATERNAL: 'paternal',   // 父系旁支
  MATERNAL: 'maternal',   // 母系旁支
  AFFINAL: 'affinal',     // 姻亲
};

/**
 * @typedef {object} Rule
 * @property {string}  path       路径，空格分隔
 * @property {number}  gen        辈分差：+2 祖辈 / +1 父母辈 / 0 同辈 / -1 子侄辈 / -2 孙辈
 * @property {string}  branch     关系大类
 * @property {string}  std        标准称呼
 * @property {string}  dialect    本地口语叫法 —— 卡片默认显示
 * @property {string[]} [alt]     其他可选叫法
 * @property {'older'|'younger'} [age] 长幼条件
 * @property {string}  [note]     备注
 * @property {boolean} [ranked]   是否适合加排行前缀（大伯 / 二叔 / 小姑）
 * @property {string}  [small]    「小」化叫法（小叔 / 小舅 / 小姨 / 妗子）；
 *                                ⚠️ **没有「第几位」的门槛**（2026-10-15 更正，旧的
 *                                「第 4 位起」是错的）：只要①比我爸妈小
 *                                ②在那批同辈长辈里最年幼，就用这个称呼。
 *                                判定只看排行、候选池不限性别，见 kinship.js
 *                                的 isYoungestSmaller / juniorPool
 */

/** @type {Rule[]} */
export const RULES = [

  /* =======================================================
     一、直系（上行）· 12 条
     ======================================================= */
  { path: 'F', gen: 1, branch: 'direct', std: '父亲', dialect: '爸爸', alt: ['爸'] },
  { path: 'M', gen: 1, branch: 'direct', std: '母亲', dialect: '妈妈', alt: ['妈'] },

  { path: 'F F', gen: 2, branch: 'direct', std: '祖父', dialect: '爷爷' },
  { path: 'F M', gen: 2, branch: 'direct', std: '祖母', dialect: '奶奶' },
  { path: 'M F', gen: 2, branch: 'direct', std: '外祖父', dialect: '外公' },
  { path: 'M M', gen: 2, branch: 'direct', std: '外祖母', dialect: '外婆' },

  { path: 'F F F', gen: 3, branch: 'direct', std: '曾祖父', dialect: '太爷爷' },
  { path: 'F F M', gen: 3, branch: 'direct', std: '曾祖母', dialect: '太奶奶' },
  { path: 'M F F', gen: 3, branch: 'direct', std: '外曾祖父', dialect: '太外公' },
  { path: 'M F M', gen: 3, branch: 'direct', std: '外曾祖母', dialect: '太外婆' },

  { path: 'F F F F', gen: 4, branch: 'direct', std: '高祖父', dialect: '老太爷爷', alt: ['老太'], note: '极少用' },
  { path: 'F F F M', gen: 4, branch: 'direct', std: '高祖母', dialect: '老太奶奶', alt: ['老太'] },

  /* =======================================================
     二、直系（下行）· 10 条
     ======================================================= */
  { path: 'S', gen: -1, branch: 'direct', std: '儿子', dialect: '儿子' },
  { path: 'D', gen: -1, branch: 'direct', std: '女儿', dialect: '女儿', alt: ['丫头'],
    note: '2026-10-11 用户定：叫「女儿」。此前用南阳口语「姑娘」，跟「儿子」不对称' },
  { path: 'S S', gen: -2, branch: 'direct', std: '孙子', dialect: '孙子' },
  { path: 'S D', gen: -2, branch: 'direct', std: '孙女', dialect: '孙女' },
  { path: 'D S', gen: -2, branch: 'direct', std: '外孙', dialect: '外孙' },
  { path: 'D D', gen: -2, branch: 'direct', std: '外孙女', dialect: '外孙女' },
  { path: 'S S S', gen: -3, branch: 'direct', std: '曾孙', dialect: '重孙' },
  { path: 'S S D', gen: -3, branch: 'direct', std: '曾孙女', dialect: '重孙女' },
  { path: 'D D S', gen: -3, branch: 'direct', std: '外曾孙', dialect: '外重孙' },
  { path: 'D D D', gen: -3, branch: 'direct', std: '外曾孙女', dialect: '外重孙女' },

  /* =======================================================
     三、同辈兄弟姐妹 · 4 条
     （同父 / 同母两种走法压缩后路径相同，无需重复）
     ======================================================= */
  { path: 'B', gen: 0, branch: 'direct', std: '兄', dialect: '哥哥', rankBase: '哥', age: 'older', ranked: true, alt: ['大哥', '二哥'] },
  { path: 'B', gen: 0, branch: 'direct', std: '弟', dialect: '弟弟', rankBase: '弟', age: 'younger', ranked: true },
  { path: 'Z', gen: 0, branch: 'direct', std: '姐', dialect: '姐姐', rankBase: '姐', age: 'older', ranked: true, alt: ['大姐'] },
  { path: 'Z', gen: 0, branch: 'direct', std: '妹', dialect: '妹妹', rankBase: '妹', age: 'younger', ranked: true },

  /* =======================================================
     四、兄弟姐妹的配偶 · 4 条
     ======================================================= */
  { path: 'B W', gen: 0, branch: 'affinal', std: '嫂', dialect: '嫂子', age: 'older' },
  { path: 'B W', gen: 0, branch: 'affinal', std: '弟妹', dialect: '弟媳', age: 'younger' },
  { path: 'Z H', gen: 0, branch: 'affinal', std: '姐夫', dialect: '姐夫', age: 'older' },
  { path: 'Z H', gen: 0, branch: 'affinal', std: '妹夫', dialect: '妹夫', age: 'younger' },

  /* =======================================================
     五、父系旁支（伯叔姑堂从）
     -------------------------------------------------------
     【结构路径代数】—— 最容易错的地方，先记公式：

        符号数 = 上行步数(u) + 下行步数(d) - 1     （u≥1 且 d≥1）
        B/Z 那一步吞掉了「最后一步上行 + 第一步下行」，
        所以 B 前面有 u-1 个 F/M，后面有 d-1 个 S/D。

        F            u=1 d=0   父亲
        F B          u=2 d=1   伯叔父                ← 1 个 F + B
        F F B        u=3 d=1   伯叔祖父（爷爷的兄弟）
        F F F B      u=4 d=1   伯叔曾祖父
        F B S        u=2 d=2   堂兄弟                ← 1 个 F + B + 1 个 S
        F F B S      u=3 d=2   堂伯/堂叔（爸爸的堂兄弟）
        F F F B S    u=4 d=2   堂祖父（爷爷的堂兄弟）

     ⚠️ 文档原表把 `F F B` 写成「从伯父」、`F F F B` 写成「伯祖父」，
        整体少算一代。本文件已按上面的公式逐条校正，
        tests/run.js 第 4 组会盯住这件事（改错一代必红）。
     ======================================================= */
  { path: 'F B', gen: 1, branch: 'paternal', std: '伯父', dialect: '伯伯', rankBase: '伯', alt: ['大伯'], age: 'older', ranked: true },
  { path: 'F B', gen: 1, branch: 'paternal', std: '叔父', dialect: '叔叔', rankBase: '叔', age: 'younger', ranked: true, small: '小叔' },
  { path: 'F B W', gen: 1, branch: 'affinal', std: '伯母', dialect: '伯娘', rankBase: '伯娘', alt: ['大妈'], age: 'older', ranked: true },
  { path: 'F B W', gen: 1, branch: 'affinal', std: '婶母', dialect: '婶', rankBase: '婶', age: 'younger', ranked: true, small: '婶' },

  { path: 'F Z', gen: 1, branch: 'paternal', std: '姑母', dialect: '姑妈', rankBase: '姑', alt: ['大姑'], age: 'older', ranked: true },
  { path: 'F Z', gen: 1, branch: 'paternal', std: '姑母', dialect: '姑姑', rankBase: '姑', age: 'younger', ranked: true, small: '小姑' },
  { path: 'F Z H', gen: 1, branch: 'affinal', std: '姑父', dialect: '姑父' },

  /* 堂 —— 伯叔的子女（同姓） */
  { path: 'F B S', gen: 0, branch: 'paternal', std: '堂兄', dialect: '堂哥', age: 'older' },
  { path: 'F B S', gen: 0, branch: 'paternal', std: '堂弟', dialect: '堂弟', age: 'younger' },
  { path: 'F B D', gen: 0, branch: 'paternal', std: '堂姐', dialect: '堂姐', age: 'older' },
  { path: 'F B D', gen: 0, branch: 'paternal', std: '堂妹', dialect: '堂妹', age: 'younger' },

  /* 姑表 —— 姑姑的子女（异姓） */
  { path: 'F Z S', gen: 0, branch: 'paternal', std: '表兄', dialect: '表哥', age: 'older' },
  { path: 'F Z S', gen: 0, branch: 'paternal', std: '表弟', dialect: '表弟', age: 'younger' },
  { path: 'F Z D', gen: 0, branch: 'paternal', std: '表姐', dialect: '表姐', age: 'older' },
  { path: 'F Z D', gen: 0, branch: 'paternal', std: '表妹', dialect: '表妹', age: 'younger' },

  /* 父辈的堂亲 —— 爷爷的兄弟的儿子（我爸爸的堂兄弟）*/
  { path: 'F F B S', gen: 1, branch: 'paternal', std: '堂伯父', dialect: '堂伯', alt: ['从伯'], age: 'older' },
  { path: 'F F B S', gen: 1, branch: 'paternal', std: '堂叔父', dialect: '堂叔', alt: ['从叔'], age: 'younger' },
  { path: 'F F B D', gen: 1, branch: 'paternal', std: '堂姑母', dialect: '堂姑' },
  { path: 'F F B S W', gen: 1, branch: 'affinal', std: '堂伯母', dialect: '堂伯娘', age: 'older' },
  { path: 'F F B S W', gen: 1, branch: 'affinal', std: '堂婶母', dialect: '堂婶', age: 'younger' },

  /* 祖父辈旁支 —— 爷爷的兄弟姐妹 */
  { path: 'F F B', gen: 2, branch: 'paternal', std: '伯祖父', dialect: '爷爷', rankBase: '爷爷',
    alt: ['大爷爷'], age: 'older', ranked: true },
  { path: 'F F B', gen: 2, branch: 'paternal', std: '叔祖父', dialect: '爷爷', rankBase: '爷爷',
    alt: ['二爷爷'], age: 'younger', ranked: true },
  { path: 'F F B W', gen: 2, branch: 'affinal', std: '伯祖母', dialect: '奶奶', rankBase: '奶奶',
    alt: ['大奶奶'], age: 'older', ranked: true },
  { path: 'F F B W', gen: 2, branch: 'affinal', std: '叔祖母', dialect: '奶奶', rankBase: '奶奶',
    alt: ['二奶奶'], age: 'younger', ranked: true },
  { path: 'F F Z', gen: 2, branch: 'paternal', std: '姑祖母', dialect: '姑婆', rankBase: '姑婆',
    alt: ['姑奶奶'], ranked: true },

  /* 祖辈的堂亲 —— 爷爷的堂兄弟（曾祖父兄弟的儿子）*/
  { path: 'F F F B S', gen: 2, branch: 'paternal', std: '堂伯祖父', dialect: '堂伯公', alt: ['堂爷爷'], age: 'older' },
  { path: 'F F F B S', gen: 2, branch: 'paternal', std: '堂叔祖父', dialect: '堂叔公', age: 'younger' },
  { path: 'F F F B D', gen: 2, branch: 'paternal', std: '堂姑祖母', dialect: '堂姑婆' },

  /* 曾祖辈旁支 —— 曾祖父的兄弟姐妹 */
  { path: 'F F F B', gen: 3, branch: 'paternal', std: '伯曾祖父', dialect: '太伯公', rankBase: '太爷',
    alt: ['太爷爷'], age: 'older', ranked: true },
  { path: 'F F F B', gen: 3, branch: 'paternal', std: '叔曾祖父', dialect: '太叔公', rankBase: '太爷',
    alt: ['太爷爷'], age: 'younger', ranked: true },
  { path: 'F F F Z', gen: 3, branch: 'paternal', std: '姑曾祖母', dialect: '太姑婆', rankBase: '太姑', ranked: true },

  /* =======================================================
     六、母系旁支（舅姨）· 12 条
     ======================================================= */
  /* ⚠️ 舅和姨是**各排各的**（rankBase 不同只是表面，真正分开在 kinship.js 的
     sibGroup：排行只在同一性别同胞里数）。
     妈妈兄弟多姐妹少时，姨妈最多叫到「大姨 / 二姨」——
     绝不会出现「五姨六姨」这种把舅舅序号算进去的排行。
     ⚠️ 2026-10-15 起妈妈**不再让号**：她是外婆家的女儿，占着自己那一格，
     所以妈妈排老二时，排行 3 的妹妹叫「三姨」。真正的「五姨」只在
     姐妹有五个以上时才可能出现（那就是实打实的女儿序，不是混号）。 */
  { path: 'M B', gen: 1, branch: 'maternal', std: '舅父', dialect: '舅舅', rankBase: '舅', alt: ['大舅'], ranked: true, small: '小舅' },
  { path: 'M B W', gen: 1, branch: 'affinal', std: '舅母', dialect: '妗子', rankBase: '妗子', ranked: true, small: '妗子' },
  { path: 'M Z', gen: 1, branch: 'maternal', std: '姨母', dialect: '姨妈', rankBase: '姨', alt: ['大姨'], ranked: true, small: '小姨' },
  { path: 'M Z H', gen: 1, branch: 'affinal', std: '姨父', dialect: '姨夫', rankBase: '姨夫', ranked: true, small: '姨夫' },

  /* 舅表 / 姨表 */
  { path: 'M B S', gen: 0, branch: 'maternal', std: '表兄', dialect: '表哥', age: 'older' },
  { path: 'M B S', gen: 0, branch: 'maternal', std: '表弟', dialect: '表弟', age: 'younger' },
  { path: 'M B D', gen: 0, branch: 'maternal', std: '表姐', dialect: '表姐', age: 'older' },
  { path: 'M B D', gen: 0, branch: 'maternal', std: '表妹', dialect: '表妹', age: 'younger' },
  { path: 'M Z S', gen: 0, branch: 'maternal', std: '表兄', dialect: '表哥', age: 'older' },
  { path: 'M Z S', gen: 0, branch: 'maternal', std: '表弟', dialect: '表弟', age: 'younger' },
  { path: 'M Z D', gen: 0, branch: 'maternal', std: '表姐', dialect: '表姐', age: 'older' },
  { path: 'M Z D', gen: 0, branch: 'maternal', std: '表妹', dialect: '表妹', age: 'younger' },

  /* 外祖辈旁支（外公的兄弟姐妹）· 文档漏项 */
  { path: 'M F B', gen: 2, branch: 'maternal', std: '舅祖父', dialect: '舅公', rankBase: '舅公', alt: ['舅爷爷'], ranked: true },
  { path: 'M F B W', gen: 2, branch: 'affinal', std: '舅祖母', dialect: '舅婆' },
  { path: 'M F Z', gen: 2, branch: 'maternal', std: '姨祖母', dialect: '姨婆', rankBase: '姨婆', alt: ['姨奶奶'], ranked: true },
  { path: 'M F Z H', gen: 2, branch: 'affinal', std: '姨祖父', dialect: '姨公' },

  /* =======================================================
     七、姻亲（配偶方）· 20 条 —— 最难的一类
     ⚠️ `W`（我的妻子）的 alt **故意是空的**（2026-10-11 删掉原「媳妇」）：
        南阳话里「媳妇」专指**儿媳妇**，把它挂在妻子名下等于告诉用户
        「我媳妇 = 我老婆」，与同屏里 `S W` 的儿媳妇正面撞车 —— 一屏里
        会出现两个意思完全相反的「媳妇」。妻子的口语就是「老婆」，
        标准称呼「妻」，不必再塞别名。
     ======================================================= */
  { path: 'W', gen: 0, branch: 'affinal', std: '妻', dialect: '老婆' },
  { path: 'H', gen: 0, branch: 'affinal', std: '夫', dialect: '老公', alt: ['丈夫'] },

  { path: 'W F', gen: 1, branch: 'affinal', std: '岳父', dialect: '岳父', alt: ['老丈人'] },
  { path: 'W M', gen: 1, branch: 'affinal', std: '岳母', dialect: '岳母', alt: ['丈母娘'] },
  { path: 'H F', gen: 1, branch: 'affinal', std: '公公', dialect: '公公', alt: ['老爷子'] },
  { path: 'H M', gen: 1, branch: 'affinal', std: '婆婆', dialect: '婆婆' },

  /* -----------------------------------------------------------------
     「妈妈的丈夫」与「爸爸的老婆」—— 这两条以前整族缺失。
     平时看不出来，是因为数据里爸爸往往**同时**被登记成父亲（parent 边），
     血亲路先命中 `F`，`M H` 根本轮不上。可只要只登记了「配偶」没登记
     「父亲」—— 现实里很常见，比如再婚家庭、只补了一条关系 ——
     爸爸就只能走 `M H` 推出来，规则表里没有 → 界面显示「（关系待确认）」。
     实测自家谱就是这么撞上的：张国友只是「李书香的配偶」，
     诊断直接报 `规则表未覆盖路径 M-H`。
     口径：与 `F` / `M` 完全同词（爸爸 / 妈妈），不另立「继父」「后爸」——
     是不是亲生的由用户自己判断，软件只管辈分。
     ============================================================ */
  { path: 'M H', gen: 1, branch: 'direct', std: '父亲', dialect: '爸爸', alt: ['爸'], note: '母亲的丈夫' },
  { path: 'F W', gen: 1, branch: 'direct', std: '母亲', dialect: '妈妈', alt: ['妈'], note: '父亲的妻子' },

  /* 配偶的祖辈 —— 现实中的通行做法是「跟着配偶叫」，这也是本产品的高频场景。
     原规则表整段缺失，导致「老婆的爷爷」直接输出「关系待确认」。 */
  { path: 'W F F', gen: 2, branch: 'affinal', std: '岳祖父', dialect: '爷爷', alt: ['岳爷爷'],
    note: '随配偶称呼，最常见的处理方式' },
  { path: 'W F M', gen: 2, branch: 'affinal', std: '岳祖母', dialect: '奶奶', alt: ['岳奶奶'],
    note: '随配偶称呼' },
  { path: 'W M F', gen: 2, branch: 'affinal', std: '外岳祖父', dialect: '外公',
    note: '随配偶称呼' },
  { path: 'W M M', gen: 2, branch: 'affinal', std: '外岳祖母', dialect: '外婆',
    note: '随配偶称呼' },
  { path: 'H F F', gen: 2, branch: 'affinal', std: '夫之祖父', dialect: '爷爷', note: '随配偶称呼' },
  { path: 'H F M', gen: 2, branch: 'affinal', std: '夫之祖母', dialect: '奶奶', note: '随配偶称呼' },
  { path: 'H M F', gen: 2, branch: 'affinal', std: '夫之外祖父', dialect: '外公', note: '随配偶称呼' },
  { path: 'H M M', gen: 2, branch: 'affinal', std: '夫之外祖母', dialect: '外婆', note: '随配偶称呼' },
  /* 配偶的曾祖辈 —— 同上，继续跟着叫 */
  { path: 'W F F F', gen: 3, branch: 'affinal', std: '岳曾祖父', dialect: '太爷爷', note: '随配偶称呼' },
  { path: 'W F F M', gen: 3, branch: 'affinal', std: '岳曾祖母', dialect: '太奶奶', note: '随配偶称呼' },

  /* 配偶的兄弟姊妹 —— 用「大 / 小」区分，不加数字排行
     （妻子的弟弟一律叫「小舅子」，没人叫「二舅子」） */
  { path: 'W B', gen: 0, branch: 'affinal', std: '内兄', dialect: '大舅子', age: 'older' },
  { path: 'W B', gen: 0, branch: 'affinal', std: '内弟', dialect: '小舅子', age: 'younger' },
  { path: 'W Z', gen: 0, branch: 'affinal', std: '内姐', dialect: '大姨子', age: 'older' },
  { path: 'W Z', gen: 0, branch: 'affinal', std: '内妹', dialect: '小姨子', age: 'younger' },
  { path: 'H B', gen: 0, branch: 'affinal', std: '大伯子', dialect: '大伯子', age: 'older' },
  { path: 'H B', gen: 0, branch: 'affinal', std: '小叔子', dialect: '小叔子', age: 'younger' },
  { path: 'H Z', gen: 0, branch: 'affinal', std: '大姑子', dialect: '大姑子', age: 'older' },
  { path: 'H Z', gen: 0, branch: 'affinal', std: '小姑子', dialect: '小姑子', age: 'younger' },

  { path: 'W B S', gen: -1, branch: 'affinal', std: '内侄', dialect: '内侄' },
  { path: 'W B D', gen: -1, branch: 'affinal', std: '内侄女', dialect: '内侄女' },
  { path: 'W Z S', gen: -1, branch: 'affinal', std: '外甥', dialect: '外甥' },
  { path: 'W Z D', gen: -1, branch: 'affinal', std: '外甥女', dialect: '外甥女' },

  { path: 'W B W', gen: 0, branch: 'affinal', std: '内嫂', dialect: '内嫂', age: 'older' },
  { path: 'W Z H', gen: 0, branch: 'affinal', std: '连襟', dialect: '连襟', age: 'older' },

  /* -----------------------------------------------------------------
     妻方侄辈的下一代 —— 正对着上面 `W B S`=内侄 / `W Z S`=外甥 往下长一代。
     ⚠️ 以前这一整段是空的，后果是「内侄有孙子」「外甥有孙子」全族兜底：
        实测自家 158 人谱里，光这一族就有 37 人显示「（关系待确认）」。
        上一轮只补了 `W F B S S`（妻子的堂兄之子，隔一层的），
        **直系的 `W B …` / `W Z …` 整族没写** —— 那两条一补到位就全亮了。
     【口径（2026-10-11 定，南阳）】
        内侄的孙辈 → 内侄孙 / 内侄孙女（不叫「堂内侄孙」，没人这么说）
        外甥的孙辈 → 外甥孙 / 外甥孙女（与妈妈那边的 `M B S S` 同词，口径统一）
     【经孙女绕回来的两条同称】
        `W B D S`（兄弟的孙女的儿子）与 `W B S S`（兄弟的孙子）gen 都是 −2，
        辈分一模一样，因此同称，不另立词。
     ============================================================ */
  { path: 'W B S S', gen: -2, branch: 'affinal', std: '内侄孙', dialect: '内侄孙', note: '内侄之子' },
  { path: 'W B S D', gen: -2, branch: 'affinal', std: '内侄孙女', dialect: '内侄孙女', note: '内侄之女' },
  { path: 'W B D S', gen: -2, branch: 'affinal', std: '内侄孙', dialect: '内侄孙', note: '内侄女之子' },
  { path: 'W B D D', gen: -2, branch: 'affinal', std: '内侄孙女', dialect: '内侄孙女', note: '内侄女之女' },
  { path: 'W Z S S', gen: -2, branch: 'affinal', std: '外甥孙', dialect: '外甥孙', note: '外甥之子' },
  { path: 'W Z S D', gen: -2, branch: 'affinal', std: '外甥孙女', dialect: '外甥孙女', note: '外甥之女' },
  { path: 'W Z D S', gen: -2, branch: 'affinal', std: '外甥孙', dialect: '外甥孙', note: '外甥女之子' },
  { path: 'W Z D D', gen: -2, branch: 'affinal', std: '外甥孙女', dialect: '外甥孙女', note: '外甥女之女' },

  /* 上面孙辈的配偶 —— 规矩跟「侄媳」那一族完全一致 */
  { path: 'W B S W', gen: -1, branch: 'affinal', std: '内侄孙媳', dialect: '内侄孙媳妇', alt: ['内侄媳妇'], note: '内侄之妻' },
  { path: 'W B D H', gen: -1, branch: 'affinal', std: '内侄孙女婿', dialect: '内侄孙女婿', note: '内侄女之夫' },
  { path: 'W Z S W', gen: -1, branch: 'affinal', std: '外甥孙媳', dialect: '外甥孙媳妇', alt: ['外甥媳妇'], note: '外甥之妻' },
  { path: 'W Z D H', gen: -1, branch: 'affinal', std: '外甥孙女婿', dialect: '外甥孙女婿', note: '外甥女之夫' },

  /* 「儿媳的父亲的兄弟 / 姐妹」交给 INLAW_BY_SUFFIX 的 `W F B` / `W F Z` 兜底 ——
     与 `W F`（亲家公）/ `W M`（亲家母）同族，口径一致，都是「亲家那一族」，
     在这个族里父辈只分男女、不分长幼（跟亲家爷爷不分大小一个道理）。
     写成完整路径 `S W F Z` 是错的两个原因：
       ① 辈分算错 —— 亲家公与「我」同辈（gen 0），他的姐妹也同辈，不是 +1；
       ② 同样的路径换个视角就变（我 → S S W F Z、看爷爷 → F F S W F Z …），
          逐条登记是无穷组合，走后缀才盖得住。
     ⚠️ 明确**不补** `S W B`（儿媳的兄弟）：论辈分他与「我儿子」平辈，
        但民间公公见儿媳的兄弟从不按称谓称呼（都是直呼姓名或喊「亲家」），
        硬造一个词既不真实也会污染规则表。保留「（关系待确认）」，
        用户可在「编辑」里手填自定义称呼。 */

  /* =======================================================
     七之二、妻方家族（★ 随妻家族：我的称谓和妻子一样）· 47 条
     ---------------------------------------------------------
     【口径（2026-10-10 定）：跟妻子一样叫】
     妻子那边的亲戚，我不用「岳姑」「岳伯」这种书面词 ——
     现实中没人那么叫，脱口而出的就是「姑姑」「姑父」「伯伯」。
     妻子的姑姑就是我的姑姑，妻子的姑姑的丈夫就是我的姑父。
     所以这一族基本是 `F ...` / `M ...` 血亲规则原样复制一份、
     前面加个 `W`，跟「随夫家」那一族（`H ...`）严格对称。

     ⚠️ 这一族以前只写了 21 条，缺口全在「岳家的伯叔姑姨」这一层：
        `W F Z H`（姑父）、`W F B W`（伯娘/婶）、`W M B`（妻舅）
        一条都没有 → 界面直接显示「（关系待确认）」。
        以前那两条 `W F B`=「岳伯」、`W F Z`=「岳姑」已按本口径改掉。

     【辈分算术】W 步算 0，所以 `W F Z` 的 gen 是 1（与 `F Z` 相同），
        `W F B S` 的 gen 是 0。别把 W 算进 +1/−1。
     ======================================================= */

  /* 妻子的伯叔辈 —— 岳家的伯父叔父，跟自家长辈同一套词 */
  { path: 'W F B', gen: 1, branch: 'affinal', std: '伯父', dialect: '伯伯', rankBase: '伯', alt: ['大伯'], age: 'older', ranked: true },
  { path: 'W F B', gen: 1, branch: 'affinal', std: '叔父', dialect: '叔叔', rankBase: '叔', age: 'younger', ranked: true, small: '小叔' },
  { path: 'W F B W', gen: 1, branch: 'affinal', std: '伯母', dialect: '伯娘', rankBase: '伯娘', alt: ['大妈'], age: 'older', ranked: true },
  { path: 'W F B W', gen: 1, branch: 'affinal', std: '婶母', dialect: '婶', rankBase: '婶', age: 'younger', ranked: true, small: '婶' },

  /* ★ 妻子的姑姑、姑父 —— 「姑父」以前整个族系都是空的 */
  { path: 'W F Z', gen: 1, branch: 'affinal', std: '姑母', dialect: '姑妈', rankBase: '姑', alt: ['大姑'], age: 'older', ranked: true },
  { path: 'W F Z', gen: 1, branch: 'affinal', std: '姑母', dialect: '姑姑', rankBase: '姑', age: 'younger', ranked: true, small: '小姑' },
  { path: 'W F Z H', gen: 1, branch: 'affinal', std: '姑父', dialect: '姑父', note: '妻子的姑姑的丈夫，随妻家族叫' },

  /* 妻子的舅姨辈 —— 岳母那边的兄弟姊妹，同一套「舅舅 / 姨妈」 */
  { path: 'W M B', gen: 1, branch: 'affinal', std: '舅父', dialect: '舅舅', rankBase: '舅', alt: ['大舅'], ranked: true, small: '小舅' },
  { path: 'W M B W', gen: 1, branch: 'affinal', std: '舅母', dialect: '妗子', rankBase: '妗子', ranked: true, small: '妗子' },
  { path: 'W M Z', gen: 1, branch: 'affinal', std: '姨母', dialect: '姨妈', rankBase: '姨', alt: ['大姨'], ranked: true, small: '小姨' },
  { path: 'W M Z H', gen: 1, branch: 'affinal', std: '姨父', dialect: '姨夫', rankBase: '姨夫', ranked: true, small: '姨夫' },

  /* 妻子的同辈亲戚 —— 伯叔的子女叫「哥 / 弟 / 姐 / 妹」，
     姑姑、舅父、姨妈那边的子女统称「表哥 / 表姐」 */
  { path: 'W F B S', gen: 0, branch: 'affinal', std: '堂兄', dialect: '哥', age: 'older', note: '妻子的堂兄，随妻家族与我同辈' },
  { path: 'W F B S', gen: 0, branch: 'affinal', std: '堂弟', dialect: '弟', age: 'younger', note: '妻子的堂弟' },
  { path: 'W F B D', gen: 0, branch: 'affinal', std: '堂姐', dialect: '姐', age: 'older', note: '妻子的堂姐' },
  { path: 'W F B D', gen: 0, branch: 'affinal', std: '堂妹', dialect: '妹', age: 'younger', note: '妻子的堂妹' },
  { path: 'W F Z S', gen: 0, branch: 'affinal', std: '表兄', dialect: '表哥', age: 'older', note: '姑表兄' },
  { path: 'W F Z S', gen: 0, branch: 'affinal', std: '表弟', dialect: '表弟', age: 'younger', note: '姑表弟' },
  { path: 'W F Z D', gen: 0, branch: 'affinal', std: '表姐', dialect: '表姐', age: 'older', note: '姑表姐' },
  { path: 'W F Z D', gen: 0, branch: 'affinal', std: '表妹', dialect: '表妹', age: 'younger', note: '姑表妹' },
  { path: 'W M B S', gen: 0, branch: 'affinal', std: '表兄', dialect: '表哥', age: 'older', note: '舅表兄' },
  { path: 'W M B S', gen: 0, branch: 'affinal', std: '表弟', dialect: '表弟', age: 'younger', note: '舅表弟' },
  { path: 'W M B D', gen: 0, branch: 'affinal', std: '表姐', dialect: '表姐', age: 'older', note: '舅表姐' },
  { path: 'W M B D', gen: 0, branch: 'affinal', std: '表妹', dialect: '表妹', age: 'younger', note: '舅表妹' },
  { path: 'W M Z S', gen: 0, branch: 'affinal', std: '表兄', dialect: '表哥', age: 'older', note: '姨表兄' },
  { path: 'W M Z S', gen: 0, branch: 'affinal', std: '表弟', dialect: '表弟', age: 'younger', note: '姨表弟' },
  { path: 'W M Z D', gen: 0, branch: 'affinal', std: '表姐', dialect: '表姐', age: 'older', note: '姨表姐' },
  { path: 'W M Z D', gen: 0, branch: 'affinal', std: '表妹', dialect: '表妹', age: 'younger', note: '姨表妹' },

  /* 上面这些同辈亲戚的配偶 —— 与自家长辈同辈的婚配同一套词 */
  { path: 'W F B S W', gen: 0, branch: 'affinal', std: '嫂子', dialect: '嫂子', age: 'older', note: '妻子堂兄之妻' },
  { path: 'W F B S W', gen: 0, branch: 'affinal', std: '弟媳', dialect: '弟媳', age: 'younger', note: '妻子堂弟之妻' },
  { path: 'W F B D H', gen: 0, branch: 'affinal', std: '姐夫', dialect: '姐夫', note: '妻子堂姐之夫' },
  { path: 'W F Z S W', gen: 0, branch: 'affinal', std: '嫂子', dialect: '嫂子', age: 'older', note: '姑表兄之妻' },
  { path: 'W F Z S W', gen: 0, branch: 'affinal', std: '弟媳', dialect: '弟媳', age: 'younger', note: '姑表弟之妻' },
  { path: 'W F Z D H', gen: 0, branch: 'affinal', std: '姐夫', dialect: '姐夫', note: '姑表姐之夫' },
  { path: 'W M B S W', gen: 0, branch: 'affinal', std: '嫂子', dialect: '嫂子', age: 'older', note: '舅表兄之妻' },
  { path: 'W M B S W', gen: 0, branch: 'affinal', std: '弟媳', dialect: '弟媳', age: 'younger', note: '舅表弟之妻' },
  { path: 'W M B D H', gen: 0, branch: 'affinal', std: '姐夫', dialect: '姐夫', note: '舅表姐之夫' },
  { path: 'W M Z S W', gen: 0, branch: 'affinal', std: '嫂子', dialect: '嫂子', age: 'older', note: '姨表兄之妻' },
  { path: 'W M Z S W', gen: 0, branch: 'affinal', std: '弟媳', dialect: '弟媳', age: 'younger', note: '姨表弟之妻' },
  { path: 'W M Z D H', gen: 0, branch: 'affinal', std: '姐夫', dialect: '姐夫', note: '姨表姐之夫' },

  /* 妻子同辈亲戚的下一代 —— 跟「随夫家」一样把口子扎到孙辈，
     只补到子辈的话，缺口会整层往下挪，等于没修。
     分界仍只有一条：伯叔那一支（同姓）叫「侄子」，姑姑/舅姨那一支（异姓）叫「外甥」。 */
  { path: 'W F B S S', gen: -1, branch: 'affinal', std: '侄子', dialect: '侄子', note: '妻子堂兄之子' },
  { path: 'W F B S D', gen: -1, branch: 'affinal', std: '侄女', dialect: '侄女', note: '妻子堂兄之女' },
  { path: 'W F B D S', gen: -1, branch: 'affinal', std: '侄子', dialect: '侄子', note: '妻子堂姐之子' },
  { path: 'W F B D D', gen: -1, branch: 'affinal', std: '侄女', dialect: '侄女', note: '妻子堂姐之女' },
  { path: 'W F Z S S', gen: -1, branch: 'affinal', std: '外甥', dialect: '外甥', note: '姑表兄之子' },
  { path: 'W F Z D S', gen: -1, branch: 'affinal', std: '外甥', dialect: '外甥', note: '姑表姐之子' },
  { path: 'W M B S S', gen: -1, branch: 'affinal', std: '外甥', dialect: '外甥', note: '舅表兄之子' },
  { path: 'W M Z D S', gen: -1, branch: 'affinal', std: '外甥', dialect: '外甥', note: '姨表姐之子' },
  /* 妻方侄辈层的女方向 + 补齐它没写全的那两支 —— 16 条路径里只写了 8 条。
     ⚠️ 又是同一个毛病（只写了子、没写女，第三次了）：
        妻的**父**那边（`W F B`）四条齐全，连「堂姐之女」都写了；
        但妻的**母**那边（`W M B` / `W M Z`）和妻的父之姑那边（`W F Z`）
        全是清一色的 `… S`（子），女方向一条没有。
        实测用户 158 人主谱里，这 8 条路径各触发 6～43 次，
        全族退回「（关系待确认）」，而且**清一色卡在女方向**。
     【口径】沿用本节开头那条分界，不新造词：
        妻的父的兄弟那一支（同姓，伯叔那边）→ 侄子 / 侄女（`W F B * *`，一直都有）；
        其余（姑姑那边、舅姨那边，异姓）→ 外甥 / 外甥女。
        所以`W M B D S`（妻的舅表姐**之子**）是外甥而不是侄子 ——
        与既有的 `W M B S S`（妻的舅表兄之子＝外甥）同口径。 */
  { path: 'W F Z S D', gen: -1, branch: 'affinal', std: '外甥女', dialect: '外甥女', note: '妻子姑表兄之女' },
  { path: 'W F Z D D', gen: -1, branch: 'affinal', std: '外甥女', dialect: '外甥女', note: '妻子姑表姐之女' },
  { path: 'W M B S D', gen: -1, branch: 'affinal', std: '外甥女', dialect: '外甥女', note: '妻子舅表兄之女' },
  { path: 'W M B D S', gen: -1, branch: 'affinal', std: '外甥', dialect: '外甥', note: '妻子舅表姐之子' },
  { path: 'W M B D D', gen: -1, branch: 'affinal', std: '外甥女', dialect: '外甥女', note: '妻子舅表姐之女' },
  { path: 'W M Z S S', gen: -1, branch: 'affinal', std: '外甥', dialect: '外甥', note: '妻子姨表兄之子' },
  { path: 'W M Z S D', gen: -1, branch: 'affinal', std: '外甥女', dialect: '外甥女', note: '妻子姨表兄之女' },
  { path: 'W M Z D D', gen: -1, branch: 'affinal', std: '外甥女', dialect: '外甥女', note: '妻子姨表姐之女' },

  /* 儿媳 / 女婿
     ⚠️ 口径 2026-10-11 改：这里的 dialect 以前是「媳妇」，现改为「儿媳妇」。
        理由：南阳话里「媳妇」这个日常词**默认就是儿媳妇** —— 老人说
        「我媳妇回来没」说的是儿媳妇，不是老婆。所以叫「媳妇」有两重问题：
          ① 跟 `H S W`（丈夫视角的我家儿媳）显示不一致，同一个人两个词；
          ② 更要命的是跟 `W` 的旧 alt「媳妇」撞车 —— 那条等于告诉用户
             「我媳妇 = 我老婆」，而按当地口语它指儿媳妇，一屏里能出现两个
             意思相反的「媳妇」。改完后「媳妇」只作为别名挂着，不再有歧义。 */
  { path: 'S W', gen: -1, branch: 'affinal', std: '儿媳', dialect: '儿媳妇', alt: ['媳妇'] },
  { path: 'D H', gen: -1, branch: 'affinal', std: '女婿', dialect: '女婿' },

  /* 孙媳 / 外孙媳 —— 与 `H S S W` / `H D S W` 严格对称。
     ⚠️ 以前只写了 `H` 前缀那两条，导致**爷爷看孙媳显示「（关系待确认）」**、
        奶奶看却是「孙媳妇」。凡是 `H …` 前面还有一段自家血亲的（`H S W` / `H D H`
        / `H S S W` / `H D S W`），都得在自家视角下配一条同词的。
        曾孙媳（`S S S W`）同样缺，属同一族，但现用不到，等真出现再补 —— 不预先灌水。 */
  { path: 'S S W', gen: -2, branch: 'affinal', std: '孙媳', dialect: '孙媳妇', alt: ['孙媳'] },
  { path: 'D S W', gen: -2, branch: 'affinal', std: '外孙媳', dialect: '外孙媳妇' },

  /* =======================================================
     八、侄甥辈 · 口语优先，不分亲疏
     ---------------------------------------------------------
     【分界只有一条线：父系同姓的兄弟之子叫「侄子」，其余叫「外甥」】
         亲兄之子 / 堂兄之子 / 从兄之子  → 侄子、侄女
         姐妹之子 / 姑舅姨那边的孩子      → 外甥、外甥女
     理由还是口语：「表侄」「堂外甥」没人叫，但「外甥」人人都叫得出来。
     ======================================================= */
  { path: 'B S', gen: -1, branch: 'direct', std: '侄子', dialect: '侄子' },
  { path: 'B D', gen: -1, branch: 'direct', std: '侄女', dialect: '侄女' },
  { path: 'Z S', gen: -1, branch: 'direct', std: '外甥', dialect: '外甥' },
  { path: 'Z D', gen: -1, branch: 'direct', std: '外甥女', dialect: '外甥女' },

  /* 父系同姓 —— 跟亲侄一样叫「侄子 / 侄女」，规范称谓放 note */
  { path: 'F B S S', gen: -1, branch: 'paternal', std: '侄子', dialect: '侄子', note: '堂兄之子，谱系称「堂侄」' },
  { path: 'F B S D', gen: -1, branch: 'paternal', std: '侄女', dialect: '侄女', note: '堂兄之女，谱系称「堂侄女」' },
  { path: 'F F B S S S', gen: -1, branch: 'paternal', std: '侄子', dialect: '侄子', note: '从兄之子，谱系称「从侄」' },
  { path: 'F F B S S D', gen: -1, branch: 'paternal', std: '侄女', dialect: '侄女', note: '从兄之女，谱系称「从侄女」' },

  /* 姐妹 / 姑舅姨那一支 —— 一律「外甥 / 外甥女」 */
  { path: 'F B D S', gen: -1, branch: 'paternal', std: '外甥', dialect: '外甥', note: '堂姐之子，谱系称「堂外甥」' },
  { path: 'F Z S S', gen: -1, branch: 'paternal', std: '外甥', dialect: '外甥', note: '姑表兄之子' },
  { path: 'F Z D S', gen: -1, branch: 'paternal', std: '外甥', dialect: '外甥', note: '姑表姐之子' },
  /* 父系这一族的女方向 —— 与上面 3 条、以及母系那 4 条严格对称。
     ⚠️ 这 3 条以前整个缺失（`F B S D` 有、其余三跳都只写了子），
        后果是「堂姐的女儿」「姑表兄的女儿」「姑表姐的女儿」一律退回
        「（关系待确认）」。实测用户 81 人谱里一枪 5 个人卡在这儿，
        全是女方向 —— 与母系当年那条注释描述的症状一模一样
        （「这 4 条以前整个缺失，只写了子、没写女」），同一个错犯了两次。
     【口径】第一跳是兄弟（B）且同姓 → 侄女（`F B S D`，见上）；
             其余（堂姐那边、姑那边）→ 外甥女。
             与 `F B D S`（堂姐之子＝外甥）严格对称，不另立「堂侄女」这种没人叫的词。 */
  { path: 'F B D D', gen: -1, branch: 'paternal', std: '外甥女', dialect: '外甥女', note: '堂姐之女' },
  { path: 'F Z S D', gen: -1, branch: 'paternal', std: '外甥女', dialect: '外甥女', note: '姑表兄之女' },
  { path: 'F Z D D', gen: -1, branch: 'paternal', std: '外甥女', dialect: '外甥女', note: '姑表姐之女' },
  { path: 'M B S S', gen: -1, branch: 'maternal', std: '外甥', dialect: '外甥', note: '舅表兄之子' },
  { path: 'M B D S', gen: -1, branch: 'maternal', std: '外甥', dialect: '外甥', note: '舅表姐之子' },
  { path: 'M Z S S', gen: -1, branch: 'maternal', std: '外甥', dialect: '外甥', note: '姨表兄之子' },
  { path: 'M Z D S', gen: -1, branch: 'maternal', std: '外甥', dialect: '外甥', note: '姨表姐之子' },

  /* 母系表亲的**女**方向 —— 与上面4 条严格对称。
     ⚠️ 这4 条以前整个缺失（只写了子、没写女），后果是
        「妈妈的兄弟的儿子的女儿」这类关系一律退回兜底「（关系待确认）」。
        称谓口径跟男方向完全一致：父系同姓兄弟之子才叫「侄子」，
        其余（姐妹、姑舅姨那边）一律「外甥」—— 所以女的就是「外甥女」，
        不另立「表侄女」这种没人叫的词。 */
  { path: 'M B S D', gen: -1, branch: 'maternal', std: '外甥女', dialect: '外甥女', note: '舅表兄之女' },
  { path: 'M B D D', gen: -1, branch: 'maternal', std: '外甥女', dialect: '外甥女', note: '舅表姐之女' },
  { path: 'M Z S D', gen: -1, branch: 'maternal', std: '外甥女', dialect: '外甥女', note: '姨表兄之女' },
  { path: 'M Z D D', gen: -1, branch: 'maternal', std: '外甥女', dialect: '外甥女', note: '姨表姐之女' },

  /* 母系表亲的孙辈 —— 接着上一组再往下走一代，口径仍是「外甥孙 / 外甥孙女」。
     同一个道理：不补的话「表姐有儿子却没孙子」，这些路径都会退回兜底。 */
  { path: 'M B S S S', gen: -2, branch: 'maternal', std: '外甥孙', dialect: '外甥孙', note: '舅表兄之孙' },
  { path: 'M B S S D', gen: -2, branch: 'maternal', std: '外甥孙女', dialect: '外甥孙女', note: '舅表兄之孙女' },
  { path: 'M B D S S', gen: -2, branch: 'maternal', std: '外甥孙', dialect: '外甥孙', note: '舅表姐之孙' },
  { path: 'M B D S D', gen: -2, branch: 'maternal', std: '外甥孙女', dialect: '外甥孙女', note: '舅表姐之孙女' },
  { path: 'M Z S S S', gen: -2, branch: 'maternal', std: '外甥孙', dialect: '外甥孙', note: '姨表兄之孙' },
  { path: 'M Z S S D', gen: -2, branch: 'maternal', std: '外甥孙女', dialect: '外甥孙女', note: '姨表兄之孙女' },
  { path: 'M Z D S S', gen: -2, branch: 'maternal', std: '外甥孙', dialect: '外甥孙', note: '姨表姐之孙' },
  { path: 'M Z D S D', gen: -2, branch: 'maternal', std: '外甥孙女', dialect: '外甥孙女', note: '姨表姐之孙女' },

  /* 再往下：外甥女 / 外甥孙的子女。与上面 8 条严格对称 ——
     上一轮只补到「M 表亲之孙」，结果「表哥的孙子」M B S D S 又退回兜底，
     等于缺口往下挪了一层，等于没修。口径仍是「外甥孙 / 外甥孙女」。 */
  { path: 'M B S D S', gen: -2, branch: 'maternal', std: '外甥孙', dialect: '外甥孙', note: '舅表兄的外甥女之子' },
  { path: 'M B S D D', gen: -2, branch: 'maternal', std: '外甥孙女', dialect: '外甥孙女', note: '舅表兄的外甥女之女' },
  { path: 'M B D D S', gen: -2, branch: 'maternal', std: '外甥孙', dialect: '外甥孙', note: '舅表姐的外甥女之子' },
  { path: 'M B D D D', gen: -2, branch: 'maternal', std: '外甥孙女', dialect: '外甥孙女', note: '舅表姐的外甥女之女' },
  { path: 'M Z S D S', gen: -2, branch: 'maternal', std: '外甥孙', dialect: '外甥孙', note: '姨表兄的外甥女之子' },
  { path: 'M Z S D D', gen: -2, branch: 'maternal', std: '外甥孙女', dialect: '外甥孙女', note: '姨表兄的外甥女之女' },
  { path: 'M Z D D S', gen: -2, branch: 'maternal', std: '外甥孙', dialect: '外甥孙', note: '姨表姐的外甥女之子' },
  { path: 'M Z D D D', gen: -2, branch: 'maternal', std: '外甥孙女', dialect: '外甥孙女', note: '姨表姐的外甥女之女' },

  /* 从兄弟 —— 从伯叔的子女（同曾祖父），同辈男性一律叫「哥」 */
  { path: 'F F B S S', gen: 0, branch: 'paternal', std: '从兄', dialect: '从哥', age: 'older' },
  { path: 'F F B S S', gen: 0, branch: 'paternal', std: '从弟', dialect: '从弟', age: 'younger' },
  { path: 'F F B S D', gen: 0, branch: 'paternal', std: '从姐', dialect: '从姐', age: 'older' },
  { path: 'F F B S D', gen: 0, branch: 'paternal', std: '从妹', dialect: '从妹', age: 'younger' },

  /* =======================================================
     九、孙辈细分 · 侄孙辈
     ---------------------------------------------------------
     「侄子」那一支的下一代。口语就是「侄孙 / 侄孙女」，
     不叫「堂侄孙」—— 同一个道理：没人那么说。
     ======================================================= */
  { path: 'B S S', gen: -2, branch: 'direct', std: '侄孙', dialect: '侄孙' },
  { path: 'B S D', gen: -2, branch: 'direct', std: '侄孙女', dialect: '侄孙女' },
  { path: 'Z S S', gen: -2, branch: 'direct', std: '外甥孙', dialect: '外甥孙' },
  { path: 'Z S D', gen: -2, branch: 'direct', std: '外甥孙女', dialect: '外甥孙女' },
  { path: 'B S S S', gen: -3, branch: 'direct', std: '曾侄孙', dialect: '曾侄孙' },

  /* 侄孙女自己那一支 —— 以前漏了两条，而且是专挑有儿子的人家漏：
       侄女有丈夫 → `B S D H` 查不到；侄女有女儿 → `B S D D` 查不到。
     上一组（`B S S D` = 侄孙的妹妹）只管了「侄子的女儿」，
     女儿那条（侄女）一直没人管，缺口就这么留下来了。
     口径：`B S D D` 与 `B S S D` 同为 gen −2，同称「侄孙女」；
     `B S D H` 与已有的 `B D H`＝侄女婿、`F B S D H`＝堂侄女婿完全一致，
     口语也是同一个词，不另立「侄孙女婿」。 */
  { path: 'B S D D', gen: -2, branch: 'direct', std: '侄孙女', dialect: '侄孙女', note: '侄女之女' },
  { path: 'B S D H', gen: -2, branch: 'affinal', std: '侄女婿', dialect: '侄女婿', note: '侄女之夫，辈分与侄孙女同（−2）；口语不分这么细，仍叫侄女婿' },

  /* 侄辈那一支再往下 —— 对称路径一并补齐，
     否则「堂哥有孙子但没孙女」「堂侄女有女儿但没儿子」就会退回兜底 */
  { path: 'F B S S S', gen: -2, branch: 'paternal', std: '侄孙', dialect: '侄孙', note: '堂侄之孙' },
  { path: 'F B S S D', gen: -2, branch: 'paternal', std: '侄孙女', dialect: '侄孙女', note: '堂侄之孙女' },
  { path: 'F B S D S', gen: -2, branch: 'paternal', std: '侄孙', dialect: '侄孙', note: '堂侄女之子' },
  { path: 'F B S D D', gen: -2, branch: 'paternal', std: '侄孙女', dialect: '侄孙女', note: '堂侄女之女' },
  { path: 'F F B S S S S', gen: -2, branch: 'paternal', std: '侄孙', dialect: '侄孙', note: '从侄之孙' },
  { path: 'F F B S S S D', gen: -2, branch: 'paternal', std: '侄孙女', dialect: '侄孙女', note: '从侄之孙女' },

  /* =======================================================
     十、同辈的婚配 —— 一律「嫂子 / 姐夫 / 弟媳 / 妹夫」
     ---------------------------------------------------------
     【为什么要合并】
     堂嫂、表嫂、从嫂这些词现实中没人说。只要是**跟我同辈的
     哥哥的妻子**，张口就是「嫂子」；姐姐的丈夫就是「姐夫」。
     亲疏由辈分表达，不靠称谓区分。
     ⚠️ 长幼一定要分：哥哥的妻子叫嫂子，弟弟的妻子叫弟媳。
        判不出长幼时 lookupRule 取「年长」那条（嫂子）并标不确定。
     ======================================================= */
  { path: 'F B S W', gen: 0, branch: 'affinal', std: '嫂子', dialect: '嫂子', age: 'older', note: '堂兄之妻' },
  { path: 'F B S W', gen: 0, branch: 'affinal', std: '弟媳', dialect: '弟媳', age: 'younger', note: '堂弟之妻' },
  { path: 'F B D H', gen: 0, branch: 'affinal', std: '姐夫', dialect: '姐夫', note: '堂姐之夫' },

  { path: 'F F B S S W', gen: 0, branch: 'affinal', std: '嫂子', dialect: '嫂子', age: 'older', note: '从兄之妻' },
  { path: 'F F B S S W', gen: 0, branch: 'affinal', std: '弟媳', dialect: '弟媳', age: 'younger', note: '从弟之妻' },
  { path: 'F F B S D H', gen: 0, branch: 'affinal', std: '姐夫', dialect: '姐夫', note: '从姐之夫' },

  { path: 'F Z S W', gen: 0, branch: 'affinal', std: '嫂子', dialect: '嫂子', age: 'older', note: '姑表兄之妻' },
  { path: 'F Z S W', gen: 0, branch: 'affinal', std: '弟媳', dialect: '弟媳', age: 'younger', note: '姑表弟之妻' },
  { path: 'F Z D H', gen: 0, branch: 'affinal', std: '姐夫', dialect: '姐夫', note: '姑表姐之夫' },

  { path: 'M B S W', gen: 0, branch: 'affinal', std: '嫂子', dialect: '嫂子', age: 'older', note: '舅表兄之妻' },
  { path: 'M B S W', gen: 0, branch: 'affinal', std: '弟媳', dialect: '弟媳', age: 'younger', note: '舅表弟之妻' },
  { path: 'M B D H', gen: 0, branch: 'affinal', std: '姐夫', dialect: '姐夫', note: '舅表姐之夫' },
  { path: 'M Z S W', gen: 0, branch: 'affinal', std: '嫂子', dialect: '嫂子', age: 'older', note: '姨表兄之妻' },
  { path: 'M Z S W', gen: 0, branch: 'affinal', std: '弟媳', dialect: '弟媳', age: 'younger', note: '姨表弟之妻' },
  { path: 'M Z D H', gen: 0, branch: 'affinal', std: '姐夫', dialect: '姐夫', note: '姨表姐之夫' },

  /* =======================================================
     十一、侄辈的婚配 · 侄媳 / 侄女婿
     ---------------------------------------------------------
     辈分比「侄子/侄女」高一档，跟嫂子（gen 0）不是一路人，别混。
     这两条以前完全缺失，导致「侄子的老婆」直接输出关系待确认。
     ======================================================= */
  { path: 'B S W', gen: -1, branch: 'affinal', std: '侄媳', dialect: '侄媳', alt: ['侄媳妇'], note: '侄儿之妻' },
  { path: 'B D H', gen: -1, branch: 'affinal', std: '侄女婿', dialect: '侄女婿', note: '侄女之夫' },
  { path: 'F B S S W', gen: -1, branch: 'affinal', std: '侄媳', dialect: '侄媳', alt: ['侄媳妇'], note: '堂侄之妻' },
  { path: 'F B S D H', gen: -1, branch: 'affinal', std: '侄女婿', dialect: '侄女婿', note: '堂侄女之夫' },
  { path: 'F F B S S S W', gen: -1, branch: 'affinal', std: '侄媳', dialect: '侄媳', alt: ['侄媳妇'], note: '从侄之妻' },
  { path: 'F F B S S D H', gen: -1, branch: 'affinal', std: '侄女婿', dialect: '侄女婿', note: '从侄女之夫' },

  /* =======================================================
     十二、随夫家（主体是嫁入的女性，看丈夫那边）· 34 条
     ---------------------------------------------------------
     【口径（2026-10-09 定）：随夫家】
     嫁入的妻子看丈夫家的亲戚，跟「丈夫」的血亲称呼保持一致——
     丈夫的兄弟的儿子就是我的「侄子」，不因为我不是姓林的就改口「外甥」。
     这也是现实中绝大多数家庭的做法。

     ⚠️ 这一族以前整族缺失，后果是：以母亲为视角看丈夫家时，
        丈夫的伯叔 / 姑姨 / 兄嫂 / 侄辈 / 儿媳**整片显示「（关系待确认）」**。
        只写了 `H B` / `H Z` 一层（见第七节），往下一层全断。

     【辈分算术】H/W 各 0，所以 `H ...` 的 gen 就是纯血亲那一段的代数，
        跟主体自己的世次无关 —— 别把 H 算进 +1/-1。
     ======================================================= */

  /* 丈夫的伯叔辈 —— 公婆的兄弟（随夫家叫法，与 `F B` / `F Z` 同一套词） */
  { path: 'H F B', gen: 1, branch: 'affinal', std: '伯父', dialect: '伯伯', rankBase: '伯', alt: ['大伯'], age: 'older', ranked: true },
  { path: 'H F B', gen: 1, branch: 'affinal', std: '叔父', dialect: '叔叔', rankBase: '叔', age: 'younger', ranked: true, small: '小叔' },
  { path: 'H F B W', gen: 1, branch: 'affinal', std: '伯母', dialect: '伯娘', rankBase: '伯娘', alt: ['大妈'], age: 'older', ranked: true },
  { path: 'H F B W', gen: 1, branch: 'affinal', std: '婶母', dialect: '婶', rankBase: '婶', age: 'younger', ranked: true, small: '婶' },
  { path: 'H F Z', gen: 1, branch: 'affinal', std: '姑母', dialect: '姑妈', rankBase: '姑', alt: ['大姑'], age: 'older', ranked: true },
  { path: 'H F Z', gen: 1, branch: 'affinal', std: '姑母', dialect: '姑姑', rankBase: '姑', age: 'younger', ranked: true, small: '小姑' },
  { path: 'H F Z H', gen: 1, branch: 'affinal', std: '姑父', dialect: '姑父' },

  /* 丈夫的从兄弟（与「我」同辈）—— 同辈的哥哥叫「哥」，不叫堂哥 */
  { path: 'H F B S', gen: 0, branch: 'affinal', std: '堂兄', dialect: '哥', age: 'older', note: '丈夫的堂兄，随夫家与我同辈' },
  { path: 'H F B S', gen: 0, branch: 'affinal', std: '堂弟', dialect: '弟', age: 'younger', note: '丈夫的堂弟' },
  { path: 'H F B D', gen: 0, branch: 'affinal', std: '堂姐', dialect: '姐', age: 'older', note: '丈夫的堂姐' },
  { path: 'H F B D', gen: 0, branch: 'affinal', std: '堂妹', dialect: '妹', age: 'younger', note: '丈夫的堂妹' },

  /* 丈夫兄弟的妻子 / 姐妹的丈夫 —— 与「我」的兄嫂同称 */
  { path: 'H B W', gen: 0, branch: 'affinal', std: '内嫂', dialect: '嫂子', age: 'older', note: '丈夫兄弟的妻子' },
  { path: 'H B W', gen: 0, branch: 'affinal', std: '内弟媳', dialect: '弟媳', age: 'younger', note: '丈夫兄弟的妻子' },
  { path: 'H F B S W', gen: 0, branch: 'affinal', std: '嫂子', dialect: '嫂子', age: 'older', note: '丈夫堂兄之妻' },
  { path: 'H F B S W', gen: 0, branch: 'affinal', std: '弟媳', dialect: '弟媳', age: 'younger', note: '丈夫堂弟之妻' },
  { path: 'H Z H', gen: 0, branch: 'affinal', std: '姊夫', dialect: '姐夫', note: '丈夫姐妹的丈夫' },

  /* ★ 丈夫的侄辈 —— 本次要修的主体。
     随夫家口径：丈夫兄弟的儿子就是我的「侄子」，不叫外甥。 */
  { path: 'H B S', gen: -1, branch: 'affinal', std: '侄子', dialect: '侄子', note: '丈夫兄弟之子，随夫家口径' },
  { path: 'H B D', gen: -1, branch: 'affinal', std: '侄女', dialect: '侄女', note: '丈夫兄弟之女，随夫家口径' },
  { path: 'H B S W', gen: -1, branch: 'affinal', std: '侄媳', dialect: '侄媳', alt: ['侄媳妇'], note: '丈夫侄儿之妻' },
  { path: 'H B D H', gen: -1, branch: 'affinal', std: '侄女婿', dialect: '侄女婿', note: '丈夫侄女之夫' },

  /* 丈夫侄辈的下一代 —— 与 `B S S` / `B S D` 同称侄孙 / 侄孙女 */
  { path: 'H B S S', gen: -2, branch: 'affinal', std: '侄孙', dialect: '侄孙', note: '丈夫侄儿之子' },
  { path: 'H B S S D', gen: -2, branch: 'affinal', std: '侄孙女', dialect: '侄孙女', note: '丈夫侄儿之孙女' },
  { path: 'H B D S', gen: -2, branch: 'affinal', std: '侄孙', dialect: '侄孙', note: '丈夫侄女之子' },
  { path: 'H B D D', gen: -2, branch: 'affinal', std: '侄孙女', dialect: '侄孙女', note: '丈夫侄女之孙女' },

  /* 丈夫姐妹的子女 —— 异姓，随夫家叫「外甥」那一族 */
  { path: 'H Z S', gen: -1, branch: 'affinal', std: '外甥', dialect: '外甥', note: '丈夫姐妹之子' },
  { path: 'H Z D', gen: -1, branch: 'affinal', std: '外甥女', dialect: '外甥女', note: '丈夫姐妹之女' },
  { path: 'H Z S S', gen: -2, branch: 'affinal', std: '外甥孙', dialect: '外甥孙', note: '丈夫姐妹之孙' },
  { path: 'H Z S D', gen: -2, branch: 'affinal', std: '外甥孙女', dialect: '外甥孙女', note: '丈夫姐妹之孙女' },
  { path: 'H Z D S', gen: -2, branch: 'affinal', std: '外甥孙', dialect: '外甥孙', note: '丈夫姐妹之外孙' },
  { path: 'H Z D D', gen: -2, branch: 'affinal', std: '外甥孙女', dialect: '外甥孙女', note: '丈夫姐妹之外孙女' },

  /* -----------------------------------------------------------------
     自己这一侧的配偶与孙辈 —— `H S` / `H D` 就是「我的儿子 / 女儿」，
     所以这里就是我家的儿媳妇、孙媳妇，跟丈夫那边毫无关系。
     以前连「我儿媳妇」都是兜底，属常识级缺口。
     ----------------------------------------------------------------- */
  { path: 'H S W', gen: -1, branch: 'affinal', std: '儿媳', dialect: '儿媳妇', alt: ['媳妇'] },
  { path: 'H D H', gen: -1, branch: 'affinal', std: '女婿', dialect: '女婿' },
  { path: 'H S S W', gen: -2, branch: 'affinal', std: '孙媳', dialect: '孙媳妇', alt: ['孙媳'] },
  { path: 'H D S W', gen: -2, branch: 'affinal', std: '外孙媳', dialect: '外孙媳妇' },
  /* 故意不写 `H S D` / `H D D` / `H S S S` / `H D D D`：那些是我的孙女、外孙女、
     曾孙女，外祖孙辈，与主体有血亲，血亲算法会直接推出 `S D` / `D D` / `S S S` / `D D D`，
     带 `H` 前缀的版本永远查不到 —— 写进来只是给规则表灌水。 */
];

/* ========================================================= */
/* 查表                                                        */
/* ========================================================= */

export const pathKey = (symbols) => symbols.join(' ');

/**
 * 按路径 + 长幼查规则。
 * @param {string[]} symbols 如 ['F','B','S']
 * @param {'older'|'younger'|null} age
 */
export function lookupRule(symbols, age = null) {
  const key = pathKey(symbols);
  const candidates = RULES.filter((r) => r.path === key);

  if (!candidates.length) {
    /* 亲家兜底：剥掉前导的纯血亲步再试一次（见 inlawFallback 的说明） */
    return inlawFallback(symbols);
  }

  // 1) 优先不分长幼的规则（更稳）
  const neutral = candidates.find((r) => !r.age);
  if (neutral) return neutral;

  // 2) 有长幼要求的：按判定找
  if (age) {
    const hit = candidates.find((r) => r.age === age);
    if (hit) return hit;
  }

  // 3) 判定不出来（缺 order 和 birth）→ 取「年长」那条，并在结果里标记不确定
  return candidates[0];
}

/* ========================================================= */
/* 亲家兜底（后缀匹配）                                          */
/* ---------------------------------------------------------
   ⚠️ 为什么需要这一层，而不是老老实实把路径逐条登记：

   「我儿媳的爹妈」叫亲家公，这一条关系在不同视角下前缀千差万别：
     我看儿媳的爹妈      S W F      （我是公公）
     爸爸看儿媳的爹妈    F S W F
     爷爷看儿媳的爹妈    F F S W F
     我看女婿的爹妈      D H F
     我看孙媳的爹妈      S S W F
   逐条登记就是无穷组合，而且以后每加一代又要重列一遍。

   但**称谓只取决于配偶步之后那几步**，前面那些纯血亲步（谁是儿子、孙子、
   叔叔）跟「他配偶的父母」这个称谓毫无关系 —— 所以剥掉前缀、按后缀查即可。

   🔒 关键安全阀：配偶步前面必须**至少有一个**血亲步。
      否则 `W F` 会被误判成亲家公，可它明明是「妻子的父亲」= 岳父（表里已有）。
      这一条让本层完全不影响既有规则，只补它们管不到的新形状。
   ======================================================= */

/** 后缀 → 称谓。这里刻意不写成完整路径，key 一律从第一个配偶步（W/H）开始。 */
const INLAW_BY_SUFFIX = {
  'W F':    { std: '亲家公',   dialect: '亲家公' },
  'W M':    { std: '亲家母',   dialect: '亲家母' },
  'H F':    { std: '亲家公',   dialect: '亲家公' },
  'H M':    { std: '亲家母',   dialect: '亲家母' },
  'W F F':  { std: '亲家祖父', dialect: '亲家爷爷' },
  'W F M':  { std: '亲家祖母', dialect: '亲家奶奶' },
  'H F F':  { std: '亲家祖父', dialect: '亲家爷爷' },
  'H F M':  { std: '亲家祖母', dialect: '亲家奶奶' },
  /* 亲家那一族的同辈旁支（2026-10-11 补）：
       `W F B` = 儿媳的父亲的兄弟 → 亲家公，`W F Z` = 儿媳的父亲的姐妹 → 亲家母。
     与上面同族同口径：这个族里父辈只分男女、不分长幼（亲家爷爷也不分大小）。
     有了这两档，「我儿媳的父亲的姐妹」以及换个视角的
     `S S W F Z` / `F S W F Z` / `H S S W F Z` … 全都不用再逐条登记。 */
  'W F B':  { std: '亲家公',   dialect: '亲家公' },
  'W F Z':  { std: '亲家母',   dialect: '亲家母' },
};

/** 是不是纯血亲步（能当可剥除的前缀） */
const isBloodStep = (s) => s === 'F' || s === 'M' || s === 'S' || s === 'D';

/**
 * 亲家兜底匹配。命中就返回一个「合成规则」，gen 由调用方按完整路径算，
 * 这里给 0 只是占位 —— 同辈（亲家与我同辈），实际不参与 genMismatch 判断。
 */
function inlawFallback(symbols) {
  const i = symbols.findIndex((s) => s === 'W' || s === 'H');

  // i 必须 ≥ 1：前面得有一段纯血亲，否则就是 W F / H F 这种直接配偶的爹妈
  if (i < 1) return null;
  if (!symbols.slice(0, i).every(isBloodStep)) return null;

  const hit = INLAW_BY_SUFFIX[symbols.slice(i).join(' ')];
  if (!hit) return null;

  return {
    path: `${symbols.slice(0, i).join(' ')} (亲家后缀)`,
    gen: 0,
    branch: BRANCH.AFFINAL,
    std: hit.std,
    dialect: hit.dialect,
    alt: [],
    note: '经血亲的配偶进入其原生家庭',
    inlawFallback: true,
  };
}

export function hasRule(symbols) {
  const key = pathKey(symbols);
  return RULES.some((r) => r.path === key);
}

/** 该路径是否有长幼变体（用于判断「长幼未知」是否需要提示） */
export function needsAge(symbols) {
  const key = pathKey(symbols);
  return RULES.filter((r) => r.path === key).some((r) => r.age);
}

/* ========================================================= */
/* 排行前缀（大伯 / 二叔 / 三姑）                                */
/* ========================================================= */

const RANK_CN = ['大', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const DIGIT_CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/**
 * 排行序号 → 口语数字。
 * 第一位叫「大」，两位数照念「十一」「二十三」；排到第 100 位返回 null
 * （没见过第 100 个舅舅，宁可不排也不瞎排）。
 *
 * ⚠️ **不设「幺」**（2026-10-10 用户定：「不要幺舅，排第几就是几」）：
 *    三个舅舅就报「三舅」，四个报「四舅」—— 报数比「幺」准，
 *    省得听的人还得在心里数一数这个幺排第几。
 *
 * ⚠️ `order` 是 0 起（0 = 长），说人话的数字是 order + 1：
 *    拼两位数**必须用 order + 1**，否则 order=9（第十位）与 order=10
 *    会都念成「十」，第十一位和第十二位撞车。
 *
 * @param {number} order 0 = 长
 * @returns {string|null} 数字前缀；排不出来时 null
 */
function rankCn(order) {
  if (order < RANK_CN.length) return RANK_CN[order];
  if (order > 98) return null;
  const n = order + 1;                       // 说人话的序号（第几位）
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return (tens === 1 ? '十' : DIGIT_CN[tens] + '十') + (ones ? DIGIT_CN[ones] : '');
}

/**
 * 给规则结果加排行前缀。
 * 只在有 order 且同级排行明确时加，否则原样返回。
 *
 * ⚠️ 必须传整条规则而不是它的 dialect：
 *    dialect 是「不带排行时的说法」，往往自带「哥 / 叔 / 姑」等词根，
 *    直接拼前缀会得到「大哥哥」「大姑妈」这种鬼话。
 *    规则的 `rankBase` 给出**可拼前缀的词根**，没有则退回 dialect。
 *
 * @param {Rule} rule 规则对象
 * @param {number|null} order 0 = 长（**同一性别**同胞内的序号，舅和姨各排各的）
 */
export function withRank(rule, order) {
  if (!rule) return '';
  if (order == null || order < 0) return rule.dialect;

  const prefix = rankCn(order);
  if (!prefix) return rule.dialect;
  return prefix + (rule.rankBase || rule.dialect);
}

/* ========================================================= */
/* 关系描述兜底（规则未覆盖时用）                                  */
/* ========================================================= */

const UP_TERM = {
  'F': '父亲', 'M': '母亲',
  'F F': '祖父', 'F M': '祖母', 'M F': '外祖父', 'M M': '外祖母',
  'F F F': '曾祖父', 'F F M': '曾祖母', 'M F F': '外曾祖父', 'M F M': '外曾祖母',
  'F F F F': '高祖父', 'F F F M': '高祖母',
};

const DOWN_TERM = {
  'S': '儿子', 'D': '女儿',
  'S S': '孙子', 'S D': '孙女', 'D S': '外孙', 'D D': '外孙女',
  'S S S': '曾孙', 'S S D': '曾孙女',
};

/**
 * 路径 → 人话。只逐级描述，**不猜称谓**（PRD §10）。
 * ['F','B','S'] → "父亲的兄弟的儿子"
 */
export function describePath(symbols) {
  if (!symbols.length) return '本人';

  const parts = [];
  let i = 0;
  const n = symbols.length;
  const spouseTerm = (s) => (s === 'W' ? '妻子' : '丈夫');

  // 前导配偶
  while (i < n && (symbols[i] === 'W' || symbols[i] === 'H')) {
    parts.push(spouseTerm(symbols[i]));
    i++;
  }

  // 兄弟步（紧跟配偶或开头）
  while (i < n && (symbols[i] === 'B' || symbols[i] === 'Z')) {
    parts.push(symbols[i] === 'B' ? '兄弟' : '姐妹');
    i++;
  }

  // 上行段
  let up = '';
  while (i < n && (symbols[i] === 'F' || symbols[i] === 'M')) {
    up += symbols[i];
    i++;
  }
  if (up) {
    const k = up.split('').join(' ');
    if (UP_TERM[k]) parts.push(UP_TERM[k]);
    else for (const s of up) parts.push(s === 'F' ? '父亲' : '母亲');
  }

  // 中间可能再出现兄弟步 / 配偶
  while (i < n && (symbols[i] === 'B' || symbols[i] === 'Z' || symbols[i] === 'W' || symbols[i] === 'H')) {
    const s = symbols[i];
    parts.push(s === 'B' ? '兄弟' : s === 'Z' ? '姐妹' : spouseTerm(s));
    i++;
  }

  // 下行段
  let down = '';
  while (i < n && (symbols[i] === 'S' || symbols[i] === 'D')) {
    down += symbols[i];
    i++;
  }
  if (down) {
    const k = down.split('').join(' ');
    if (DOWN_TERM[k]) parts.push(DOWN_TERM[k]);
    else for (const s of down) parts.push(s === 'S' ? '儿子' : '女儿');
  }

  // 尾随
  while (i < n) {
    const s = symbols[i];
    parts.push(s === 'W' ? '妻子' : s === 'H' ? '丈夫' : s);
    i++;
  }

  return parts.join('的');
}
