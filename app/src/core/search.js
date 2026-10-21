/**
 * =========================================================
 * 全谱搜索 · core/search.js
 * ---------------------------------------------------------
 * 输入：已规范化的 people[]、称谓Map、查询串、由调用方给的「这个人属于哪一页」
 * 输出：排好序的命中数组
 *
 * 【为什么放在 core】
 *   搜索是这个软件里**唯一一个用户天天用、却一行都测不到**的逻辑 ——
 *   它原先整段住在 app.js 的 collectSearchHits() 里，依赖 document 与全局
 *   state，跑不进 tests/run.js。搬到 core 才能单测：拼音表、多音字、排序
 *   四条口径、命中途径优先级，全是「改错了要过很久才发现」的地方。
 *
 * 【分工铁律】同 tree.js：**这里不碰 DOM、不读全局 state。**
 *   「这个人属于哪一页」由调用方以 scopeOf(id) 回调传进来（它依赖布局，
 *   布局在 app 层）；core 只负责「匹不匹配、命中途径是谁、谁排前面」。
 *
 * 【为什么拼音表是静态的、而不是引入拼音库】
 *   见 core/data/pinyin.js 头注释：开发期生成、提交进仓库、运行时零依赖。
 * =========================================================
 */

import { displayName, birthYear } from './model.js';
import { readingsOf } from './data/pinyin.js';

/** 命中途径 → 排序优先级（第 2 条口径，越小越靠前） */
const HIT_RANK = { name: 0, pinyin: 1, call: 2 };

/**
 * 一个人的姓名能产出哪些拼音候选串。
 *
 * 【一张表就够】
 *   首字母 = 全拼串的第 0 个字符，所以**不用第二张表**。
 *
 *     李明 → 全拼 "liming"              首字母 "lm"
 *     李长 → 全拼 "lichang" / "lizhang" 首字母 "lc" / "lz"
 *
 * 【生僻字：整条退出，不跳字】（design.md D4）
 *   只要有一个字查不到拼音就返回空数组 —— 不是「跳过那个字、把其余字拼起来」。
 *   跳字会拼出「李龘」→「li」，于是搜 li 把「李」和「李龘」一起捞出来，
 *   用户以为搜对了，实际是把两个人混成一个。这类人仍可用汉字子串搜到。
 *
 * @param {string} name 姓名（调用方给 displayName 的结果）
 * @returns {{full: string[], initials: string[]}}
 */
export function pinyinForms(name) {
  const chars = [...String(name || '')];
  if (!chars.length) return { full: [], initials: [] };

  const perChar = [];
  for (const ch of chars) {
    const rs = readingsOf(ch);
    if (!rs.length) return { full: [], initials: [] };   // 生僻字 → 整条退出
    perChar.push(rs);
  }

  /* 每字 ≤2 读音 → 2 字名最多 4 种、3 字名 8 种、4 字名 16 种。
       超过 30 种就当「这名字没法用拼音找」，宁可不给也不给一堆噪音。
       ⚠️ 首字母**必须在这里按音节边界生成**：一旦拼成 "lichangshun"，
       音节边界就没了，事后逐字符取首字母只会把原串原样拿回来。 */
    const full = [];
    const initials = [];
    const walk = (i, acc, ini) => {
      if (i === perChar.length) { full.push(acc); initials.push(ini); return; }
      for (const r of perChar[i]) walk(i + 1, acc + r, ini + r[0]);
    };
    walk(0, '', '');
    if (full.length > 30) return { full: [], initials: [] };

    return { full, initials: [...new Set(initials)] };
}

/**
 * 这个人按拼音能不能被搜到。
 * @returns {{hit:boolean, form:string}} form = 命中的那一个拼音串（给界面展示）
 */
function pinyinHitOf(name, query) {
  const { full, initials } = pinyinForms(name);
  if (!full.length) return { hit: false, form: '' };
  /* 先全拼后首字母：敲 liming 时优先展示 liming 而不是 l。
     判定口径是「候选串**包含**查询串」，**不做中间省略** —— lming 不认，
     省略位置是猜的，猜错就等于替用户挑人。 */
  const form = full.find((f) => f.includes(query)) || initials.find((s) => s.includes(query));
  return form ? { hit: true, form } : { hit: false, form: '' };
}

/**
 * 全谱搜索，返回**排好序的全部命中**。
 *
 * 排序口径（一条一条都不能动）：
 *   1. 主树 → 姻亲 → 游离；
 *   2. **姓名命中 → 拼音命中 → 称谓命中**（拼音是「确定的姓名」，比模糊的
 *      称谓强，但弱于姓名原文命中 —— 原文命中说明用户已经知道确切写法）；
 *   3. 生年早的 → 生的；4. 都没生年的排最后。
 * 第 3 条的理由：族里是按长幼认人的，把没录生日的人往前塞，排出来的顺序
 * 就是错的 —— 宁可排后面，也不要假装知道。
 *
 * @param {object} opts
 * @param {object[]} [opts.people]  已规范化的 people[]
 * @param {Map<string,object>} [opts.kinship] 称谓 Map（core/kinship.js 的产物）
 * @param {string} [opts.query]     查询串（内部 trim）
 * @param {(id:string)=>string|null} [opts.scopeOf] 这个人属于哪一页；不给则全是 null
 * @param {(key:string|null)=>string} [opts.scopeLabel] 那一页的显示名
 * @returns {Array<{id:string,name:string,call:string,hitOn:'name'|'pinyin'|'call',
 *                  pinyinForm:string,scopeKey:string|null,scopeLabel:string,
 *                  year:number|null,hint:string}>}
 */
export function collectHits({ people = [], kinship, query = '', scopeOf, scopeLabel } = {}) {
  const s = String(query).trim();
  if (!s) return [];

  const scopeOfFn = typeof scopeOf === 'function' ? scopeOf : () => null;
  const labelOf = typeof scopeLabel === 'function'
    ? scopeLabel
    : (k) => (k === 'main' ? '本家族' : k ? '其他家族' : '不在任何家族页');

  const hits = [];
  for (const p of people) {
    const name = displayName(p);
    const k = kinship?.get(p.id);

    /* ⚠️ 必须 k.ok 才按称谓匹配：!ok 时 dialect 固定是「（关系待确认）」，
       拿它去匹配等于搜「关系待确认」能把所有算不出称谓的人全搜出来。 */
    const call = k?.ok ? (k.dialect || '') : '';
    const std = k?.ok ? (k.std || '') : '';

    let hitOn = null;
    let pinyinForm = '';
    if (name.includes(s)) {
      hitOn = 'name';
    } else {
      const py = pinyinHitOf(name, s);
      if (py.hit) { hitOn = 'pinyin'; pinyinForm = py.form; }
      else if (call.includes(s) || std.includes(s)) hitOn = 'call';
    }
    if (!hitOn) continue;

    const scopeKey = scopeOfFn(p.id);
    hits.push({
      id: p.id,
      name,
      call,
      hitOn,
      pinyinForm,
      scopeKey,
      scopeLabel: labelOf(scopeKey),
      year: birthYear(p),
      /* 悬停提示用关系描述 —— 列表行窄，长句塞不下，交给 title */
      hint: k?.desc || k?.note || '',
    });
  }

  const rank = (h) => [
    h.scopeKey === 'main' ? 0 : h.scopeKey ? 1 : 2,
    HIT_RANK[h.hitOn] ?? 3,
    h.year ?? 9999,
  ];

  return hits.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2]
      || a.name.localeCompare(b.name, 'zh');
  });
}

/**
 * 搜一次，把「能不能直接跳转」需要的信息一起带出来。
 *
 * @param {object} opts 同 collectHits
 * @returns {{hits:Array, exact:Array}} exact = **姓名全等**的命中。
 *   回车直接跳转只看 exact.length === 1 —— 拼音全等**不算**（design.md D5）：
 *   拼音全等的「唯一性」没姓名全等硬（liming 还可能是「黎明」），而且
 *   v0.2.55 用户已拍过板：宁可让人挑，不要替用户挑人。
 */
export function search({ people, kinship, query, scopeOf, scopeLabel } = {}) {
  const hits = collectHits({ people, kinship, query, scopeOf, scopeLabel });
  const s = String(query || '').trim();
  const exact = s ? hits.filter((h) => h.hitOn === 'name' && h.name === s) : [];
  return { hits, exact };
}