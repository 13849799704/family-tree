/**
 * =========================================================
 * 家族树划分 · family.js
 * ---------------------------------------------------------
 * 在 UI 设计稿里，三棵树（我的家族 / 妻子家族 / 母亲家族）
 * 是靠硬编码的数据切的。真实应用必须**从数据推导**。
 *
 * 推导规则：
 *   1. 每棵树有一个「族源」（rootId）= 某个人的父系最远祖先
 *   2. 树的成员 = 族源的全部血缘后代 + 每个后代的所有配偶
 *      → 嫁入的姻亲（如妈妈、妻子）是成员，但**不向上追溯**其原生家族
 *   3. 主轴（lineage）= 从族源向下走的血缘链，每人只认一个「主轴父」
 *      → 妈妈不会成为主轴人，她是爸爸的配偶
 *   4. 锚点（anchorId）= 切换视角时位置不动的那个血缘主角
 *
 * 这套规则能精确复现设计稿的三棵树（19 / 10 / 10 人），
 * 但对真实数据同样成立 —— 不写死任何人名。
 * =========================================================
 */

import { buildIndex, displayName } from './model.js';

/**
 * 从某人出发，沿父系链上溯，取最远的祖先。
 * 「沿父系」= 优先走父亲（sex === 'M'）；没有父亲就退到母亲；
 * 都没有则停在本人。
 *
 * 这条规则决定了每棵树的族源：
 *   我   → 父 → 爷爷 → 曾祖父（停）      root = 曾祖父
 *   妻子 → 岳父 → 岳祖父（停）           root = 岳祖父
 *   妈妈 → 外公（停）                    root = 外公
 */
export function findLineageRoot(idx, startId) {
  let cur = startId;
  const guard = new Set();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const parents = idx.parentsOf.get(cur) || [];
    if (!parents.length) break;
    // 优先父亲，其次母亲
    const father = parents.find((p) => idx.byId.get(p)?.sex === 'M');
    const next = father || parents[0];
    if (!next) break;
    cur = next;
  }
  return cur || startId;
}

/**
 * 收集一棵树的成员与结构。
 *
 * @param {object} dataset 规范化数据
 * @param {object} opts { rootId, anchorId, key, label }
 * @returns {{
 *   key, label, rootId, anchorId,
 *   people: object[],                  // 成员对象数组
 *   memberIds: Set<string>,
 *   bloodIds: Set<string>,             // 血缘成员（主轴判定用）
 *   lineage: [string,string][],        // [[子, 主轴父]] —— 只含本树内
 *   couples: [string,string][],        // [[主轴人, 配偶]] —— 只含本树内
 * }}
 */
export function buildFamilyTree(dataset, opts = {}) {
  const idx = buildIndex(dataset);
  const rootId = opts.rootId || dataset.viewpoint;
  const anchorId = opts.anchorId || dataset.viewpoint;

  /* --- 1) 血缘后代：从族源向下，全性别都走 --- */
  const blood = new Set();
  /** 主轴父：childId -> parentId（只认从族源走下来的那一条链） */
  const lineageParent = new Map();

  const walkDown = (id) => {
    if (blood.has(id)) return;
    blood.add(id);
    for (const c of idx.kidsOf.get(id) || []) {
      // 只认第一次到达的路径作为「主轴父」
      if (!lineageParent.has(c)) {
        lineageParent.set(c, id);
        walkDown(c);
      }
    }
  };
  if (idx.byId.has(rootId)) walkDown(rootId);

  /* --- 2) 加配偶（只加，不向上追溯其原生家族） --- */
  const members = new Set(blood);
  for (const id of blood) {
    for (const s of idx.spouseOf.get(id) || []) members.add(s);
  }
  // 配偶的配偶（多段婚姻）也一并纳入，避免漏人
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...members]) {
      for (const s of idx.spouseOf.get(id) || []) {
        if (!members.has(s)) { members.add(s); grew = true; }
      }
    }
  }

  /* --- 3) 主轴边：一条 [子, 父] --- */
  const lineage = [];
  for (const [child, parent] of lineageParent) {
    if (members.has(child) && members.has(parent)) {
      lineage.push([child, parent]);
    }
  }
  // 按 order 长幼排序输出，保证布局稳定
  lineage.sort((x, y) => {
    const ox = idx.byId.get(x[0])?.order ?? 999;
    const oy = idx.byId.get(y[0])?.order ?? 999;
    return ox - oy;
  });

  /* --- 4) 婚配边：只保留「主轴人 ↔ 非主轴人」的组合 --- */
  const couples = [];
  const coupleSeen = new Set();
  for (const id of members) {
    for (const sid of idx.spouseOf.get(id) || []) {
      if (!members.has(sid)) continue;
      const k = [id, sid].sort().join('|');
      if (coupleSeen.has(k)) continue;
      coupleSeen.add(k);

      const idIsMain = blood.has(id);
      const sidIsMain = blood.has(sid);
      // 主轴人 + 配偶；若两人都是血缘（近亲婚配），取 order 靠前者为主轴
      let main, sp;
      if (idIsMain && !sidIsMain) { main = id; sp = sid; }
      else if (!idIsMain && sidIsMain) { main = sid; sp = id; }
      else if (idIsMain && sidIsMain) { main = id; sp = sid; }
      else continue; // 两人都是姻亲 → 不属于本树的主轴结构

      couples.push([main, sp]);
    }
  }

  const people = [...members]
    .map((id) => idx.byId.get(id))
    .filter(Boolean);

  return {
    key: opts.key || 'main',
    label: opts.label || '家族',
    rootId,
    anchorId,
    people,
    memberIds: members,
    bloodIds: blood,
    lineage,
    couples,
    lineageParent,
  };
}

/**
 * 顶部家族切换页 —— **固定三页**（2026-10-11 用户定）。
 *
 *   第 1 页：视角人自己的血脉家族树（主树，由 `buildMainTree` 负责）
 *   第 2 页：**母亲**的血脉家族树
 *   第 3 页：**配偶**的血脉家族树 —— 男性视角是「妻子的家族」，
 *            女性视角是「丈夫的家族」。角色称呼按视角人性别走，
 *            不写死「妻子」，否则女方视角下会荒谬地标成「妻子家族」。
 *
 * 【为什么必须固定，而不是"扫一遍谁有家族就出页"】
 *   旧实现遍历主树里所有姻亲，看到谁上溯得到祖先就给他开一页。
 *   后果有两个：
 *     ① 页数不可控 —— 堂伯的媳妇、表姐的丈夫…谁都可能多出一页，
 *        用户要的「最多三个」根本做不到；
 *     ② **切视角后页面语义会错位** —— 页的顺序取决于"谁先被遍历到"，
 *        换个人当视角，第二个 tab 可能还是上一个人的亲戚。
 *   改成按身份取人（母亲、配偶），页面语义就绑死在「当前视角人」身上，
 *   切视角后第二页必然是新视角人的母亲，第三页必然是他的配偶。
 *
 * 【缺页规则】没有母亲 / 没有配偶才缺。其余一律要显示 ——
 *   哪怕她们的父母一个都没录，也照样留一页（页里是她 + 她的配偶）。
 *   页数不该由「数据录全了没」决定（否则用户根本不知道少了个人没录）。
 *   ⚠️ 这种页的 tab 上**不加「待补父母」字样**（用户 2026-10-11 定：tab 是导航不是提示位），
 *      只用 `pending: true` 交给 UI —— 虚线框 + 点进去之后的提示条去说。
 *
 * @returns {Array<{fromPersonId,key,label,rootId,anchorId,size,pending}>}
 */
export function detectExpandableFamilies(dataset, tree, opts = {}) {
  const idx = buildIndex(dataset);
  const vp = dataset.viewpoint;
  const out = [];

  const pushPage = (personId, role) => {
    if (!personId || !idx.byId.has(personId)) return;

    const rootId = findLineageRoot(idx, personId);
    const pending = !rootId || rootId === personId;    // 一个祖先都没录
    const key = opts.keyOf ? opts.keyOf(personId, rootId) : 'natal_' + personId;

    /* 标签带姓名，但**没录姓名就别硬凑**。
       实际谱子里大量人是「姓名待补」（体检 F8.8 常年几十条），
       用 displayName 会渲染成「母亲家族 · 未知」—— 那等于没说是谁。
       宁可只写角色，等用户补上姓名，下一次切视角标签自然就带名字了。 */
    const rawName = idx.byId.get(personId)?.name;
    const label = rawName ? `${role}家族 · ${rawName}` : `${role}家族`;

    const t = buildFamilyTree(dataset, {
      rootId: pending ? personId : rootId,
      anchorId: personId,
      key,
      label,
    });

    /* 与主树高度重合说明本来就是一家，不必再开一页。
       ⚠️ 这条例外是唯一的：理论上「有母亲就必须显示」，
       但若母亲那一族已经八成在主树里，再开一页就是纯重复。
       典型场景：**只登记了母亲、没登记父亲** —— 此时主树族源就是母亲那条线。 */
    if (!pending) {
      const overlap = t.people.filter((x) => tree.memberIds.has(x.id)).length;
      if (overlap / t.people.length > 0.8) return;
    }

    out.push({
      fromPersonId: personId,
      key,
      /* tab 上**不写「待补父母」**（用户 2026-10-11 定）——
         tab 是导航，不是提示位，写满了字挤得慌。
         「还缺父母」这件事交给 tab 的虚线框（.scope-pending）
         和点进去之后顶部那条提示条去说。 */
      label,
      rootId: pending ? personId : rootId,
      anchorId: personId,
      size: t.people.length,
      pending,
    });
  };

  /* 第 2 页：母亲 —— 不分男女，都是母亲那一族 */
  const mother = (idx.parentsOf.get(vp) || []).find((x) => idx.byId.get(x)?.sex === 'F');
  pushPage(mother, '母亲');

  /* 第 3 页：配偶。
     ⚠️ 按**视角人的性别**决定角色称呼：男性视角 → 妻子的家族；
        女性视角 → 丈夫的家族。写死「妻子」的话，女方视角下第三页
        标签会变成荒谬的「妻子家族」—— 视角人自己就是那位"妻子"。 */
  const vpSex = idx.byId.get(vp)?.sex;
  const spouse = (idx.spouseOf.get(vp) || [])
    .find((x) => idx.byId.get(x)?.sex && idx.byId.get(x)?.sex !== vpSex);
  pushPage(spouse, vpSex === 'F' ? '丈夫' : '妻子');

  return out;
}

/**
 * 一站式：为某个视角人物建好它的主树。
 *
 * @param {object} dataset
 * @param {string} anchorId 视角人物（通常 = dataset.viewpoint）
 */
export function buildMainTree(dataset, anchorId) {
  const idx = buildIndex(dataset);
  const rootId = findLineageRoot(idx, anchorId || dataset.viewpoint);
  const anchor = idx.byId.get(anchorId || dataset.viewpoint);

  return buildFamilyTree(dataset, {
    rootId,
    anchorId: anchorId || dataset.viewpoint,
    key: 'main',
    label: anchor ? `${displayName(anchor)}的家族` : '我的家族',
  });
}

/**
 * 按一棵树的范围，裁出一份**只含该家族**的子数据集（v0.2.45）。
 *
 * 动机：树的成员是「从族源往下的血缘 + 这些人的配偶本人」，
 * 妻子娘家的父母、母亲那一族的祖辈都**不在**本树里。用户要的就是
 * 只把自己这一支导出去、不让外人看到岳家/外家。
 *
 * 【关系表必须重新过滤，不能原样带上】
 *   dataset.relationships 是全量的，里面有一堆边的一端（妻子的父母、
 *   外祖父母…）在裁剪后的文件里根本不存在。不按两端过滤的话，导出的
 *   文件带着悬空引用 —— 导入时 normalizeDataset 会把它们当孤儿静默丢掉，
 *   用户完全看不出发生过什么，只会觉得「导进来怎么少了点东西」。
 *   这里显式过滤，保证导出的文件**自洽**：里面的人、边，两两对得上。
 *
 * ⚠️ **本函数是纯函数，绝不修改传入的 dataset**，也绝不碰 app.js 里的
 *    `state.dataset`。后者是内存里的真身，下一次 commit 会把它整个写回
 *    库；真在这里裁了就等于把「只导一份」变成了「把库也裁了」。
 *
 * @param {object} dataset 完整数据集
 * @param {object} tree buildFamilyTree / layouts[key].tree 的结果
 * @returns {{version:string, viewpoint:string, people:object[], relationships:object[]}}
 */
export function scopeToTree(dataset, tree) {
  /* memberIds 是 buildFamilyTree 直接给的权威成员集；
     万一传进来的是别处拼的裸对象，退回从 people 推。 */
  const keep = tree?.memberIds instanceof Set
    ? tree.memberIds
    : new Set((tree?.people || []).map((p) => p?.id).filter(Boolean));

  const people = (dataset.people || []).filter((p) => keep.has(p.id));
  const relationships = (dataset.relationships || [])
    .filter((r) => keep.has(r.a) && keep.has(r.b));

  /* 视角人未必在本树里（停在「母亲家族」页签时，他在另一棵树）。
     沿用原 viewpoint 会导出一个「打开看不到人」的谱 —— mainTree 的
     族源是从 viewpoint 上溯的，viewpoint 不在文件里整棵树就塌了。
     所以退到本树的锚点（母亲/妻子那页的锚点就是她本人），再退到空。 */
  const viewpoint = keep.has(dataset.viewpoint)
    ? dataset.viewpoint
    : (keep.has(tree?.anchorId) ? tree.anchorId : '');

  return {
    version: dataset.version || '1.0',
    viewpoint,
    people,
    relationships,
  };
}
