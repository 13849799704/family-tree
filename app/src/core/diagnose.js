/**
 * =========================================================
 * 自动体检 · diagnose.js
 * ---------------------------------------------------------
 * 对应 PRD §6.2 的 F8：录入 / 导入后自动扫描数据问题并出报告。
 *
 * 六项检查 + 一项规则覆盖率补充：
 *   F8.1 孤儿节点      有父指针但父不存在 / 血缘断裂
 *   F8.2 血缘成环      A 是 B 的父、B 又是 A 的父
 *   F8.3 世次矛盾      子世次 ≥ 父世次
 *   F8.4 排行重复/缺号 同父母下兄弟 order 重复或断层
 *   F8.5 生卒异常      子女出生早于父母 / 寿命超 120 岁
 *   F8.6 配偶不一致    配偶世次不符 / 配偶性别相同 / 有共同子女却未登记婚配
 *   F8.7 称谓未覆盖    规则表匹配不到（规则表 §10 要求登记）
 *
 * 设计原则：**只报不改**。
 * 数据错误交给用户判断，绝不静默修正 —— 错值比空值更毒。
 * =========================================================
 */

import { buildIndex, parseDate, displayName, missingFields } from './model.js';
import { deriveKinship } from './kinship.js';
import { hasRule } from './rules.js';

const MAX_LIFESPAN = 120;

/**
 * 跑全套体检。
 * @param {object} dataset 规范化 + 已 resolve gen 的数据
 * @param {object} [opts]
 * @param {string} [opts.viewpoint] 视角人，用于 F8.7
 * @returns {{
 *   ok: boolean,
 *   issueCount: number,
 *   groups: Array<{code,title,desc,items:Array<{text:string,personId?:string,otherId?:string}>}>
 * }}
 */
export function diagnose(dataset, opts = {}) {
  const idx = buildIndex(dataset);
  const viewpoint = opts.viewpoint || dataset.viewpoint;

  const groups = [
    checkOrphans(dataset, idx),
    checkCycles(idx),
    checkGeneration(idx),
    checkSiblingOrder(idx),
    checkDates(idx),
    checkSpouses(idx),
    checkKinshipCoverage(dataset, idx, viewpoint),
    checkIncomplete(dataset, idx),
  ];

  const issueCount = groups.reduce((s, g) => s + g.items.length, 0);

  return {
    ok: issueCount === 0,
    issueCount,
    groups,
  };
}

/* ========================================================= */
/* F8.1 孤儿节点                                               */
/* ========================================================= */

function checkOrphans(dataset, idx) {
  const items = [];

  // ① 导入阶段就丢失的关系（指向不存在的人）
  for (const o of dataset._orphans || []) {
    items.push({
      text: `关系 ${o.rel.a} → ${o.rel.b}（${o.rel.type}）指向不存在的人：${o.missing.join('、')}`,
    });
  }

  // ③ 血缘链断裂：有子女，却既没有配偶也没有父母
  //    ⚠️ 注意别写成「有子女但没父母」—— 嫁入的媳妇没登记原生父母是常态，
  //       报它只会制造噪音（实测在示例数据上误报 12 条）。
  //       真正异常的是「孩子凭空出现」：上游整段缺失。
  for (const p of dataset.people) {
    const hasKid = (idx.kidsOf.get(p.id) || []).length > 0;
    const hasParent = (idx.parentsOf.get(p.id) || []).length > 0;
    const hasSpouse = (idx.spouseOf.get(p.id) || []).length > 0;
    if (hasKid && !hasParent && !hasSpouse) {
      items.push({
        text: `${displayName(p)} 有子女，却既没有配偶也没有父母记录 —— 上游整段缺失，无法定位其在家族中的位置`,
        personId: p.id,
      });
    }
  }

  // ④ 完全孤立的人（无父无子无配偶）
  for (const p of dataset.people) {
    const hasParent = (idx.parentsOf.get(p.id) || []).length > 0;
    const hasKid = (idx.kidsOf.get(p.id) || []).length > 0;
    const hasSpouse = (idx.spouseOf.get(p.id) || []).length > 0;
    if (!hasParent && !hasKid && !hasSpouse) {
      items.push({
        text: `${displayName(p)} 没有任何关系记录，在树上会孤立显示`,
        personId: p.id,
      });
    }
  }

  return {
    code: 'F8.1',
    title: '孤儿节点 / 血缘断裂',
    desc: '有父指针但父不存在，或应连未连',
    items,
  };
}

/* ========================================================= */
/* F8.2 血缘成环                                               */
/* ========================================================= */

function checkCycles(idx) {
  const items = [];
  const state = new Map(); // 0 未访问 / 1 在栈中 / 2 已完成
  const stack = [];

  function dfs(id) {
    state.set(id, 1);
    stack.push(id);
    for (const p of idx.parentsOf.get(id) || []) {
      const st = state.get(p) ?? 0;
      if (st === 1) {
        // 找到环
        const from = stack.indexOf(p);
        const loop = [...stack.slice(from), p].map((x) => idx.byId.get(x) ? displayName(idx.byId.get(x)) : x);
        items.push({ text: `血缘成环：${loop.join(' → ')}` });
      } else if (st === 0) {
        dfs(p);
      }
    }
    stack.pop();
    state.set(id, 2);
  }

  for (const id of idx.byId.keys()) {
    if ((state.get(id) ?? 0) === 0) dfs(id);
  }

  return {
    code: 'F8.2',
    title: '血缘成环',
    desc: 'A 是 B 的父、B 又是 A 的父',
    items,
  };
}

/* ========================================================= */
/* F8.3 世次矛盾                                               */
/* ========================================================= */

function checkGeneration(idx) {
  const items = [];

  for (const [childId, parents] of idx.parentsOf) {
    const child = idx.byId.get(childId);
    if (!child || child.gen == null) continue;
    for (const pid of parents) {
      const parent = idx.byId.get(pid);
      if (!parent || parent.gen == null) continue;
      // 子必须比父小 1 辈以上
      if (child.gen >= parent.gen) {
        items.push({
          text: `${displayName(child)}（第 ${child.gen} 代）的世次不低于其${parent.sex === 'M' ? '父' : '母'} ${displayName(parent)}（第 ${parent.gen} 代）`,
          personId: childId,
          otherId: pid,
        });
      }
    }
  }

  return {
    code: 'F8.3',
    title: '世次矛盾',
    desc: '子世次 ≥ 父世次，会导致层级错乱',
    items,
  };
}

/* ========================================================= */
/* F8.4 排行重复 / 缺号                                         */
/* ========================================================= */

function checkSiblingOrder(idx) {
  const items = [];

  for (const [parentId, kids] of idx.kidsOf) {
    if (kids.length < 2) continue;
    const parent = idx.byId.get(parentId);
    const orders = new Map();

    for (const k of kids) {
      const kid = idx.byId.get(k);
      if (kid?.order == null) continue;
      if (!orders.has(kid.order)) orders.set(kid.order, []);
      orders.get(kid.order).push(displayName(kid));
    }

    for (const [o, names] of orders) {
      if (names.length > 1) {
        items.push({
          text: `${displayName(parent)} 的子女中，排行 ${o} 重复：${names.join('、')}`,
          otherId: parentId,
        });
      }
    }

    // 缺号：有 order 的都收集后看是否有断档
    const nums = [...orders.keys()].sort((a, b) => a - b);
    if (nums.length >= 2) {
      const gaps = [];
      for (let i = nums[0]; i < nums[nums.length - 1]; i++) {
        if (!orders.has(i)) gaps.push(i);
      }
      if (gaps.length) {
        items.push({
          text: `${displayName(parent)} 的子女排行有断档，缺：${gaps.join('、')}`,
          otherId: parentId,
        });
      }
    }
  }

  return {
    code: 'F8.4',
    title: '排行重复 / 缺号',
    desc: '同父母下的排行应唯一且连续',
    items,
  };
}

/* ========================================================= */
/* F8.5 生卒异常                                               */
/* ========================================================= */

function checkDates(idx) {
  const items = [];

  for (const p of idx.byId.values()) {
    const b = parseDate(p.birth)?.y;
    const d = parseDate(p.death)?.y;

    if (b != null && d != null) {
      if (d < b) {
        items.push({ text: `${displayName(p)} 的去世年份（${d}）早于出生年份（${b}）`, personId: p.id });
      } else if (d - b > MAX_LIFESPAN) {
        items.push({
          text: `${displayName(p)} 寿命 ${d - b} 岁，超过 ${MAX_LIFESPAN} 岁，请核对`,
          personId: p.id,
        });
      }
    }

    if (b == null) continue;

    // 与父母比
    for (const pid of idx.parentsOf.get(p.id) || []) {
      const parent = idx.byId.get(pid);
      const pb = parseDate(parent?.birth)?.y;
      if (pb == null) continue;

      if (b <= pb) {
        items.push({
          text: `${displayName(p)}（${b}）出生不晚于其${parent.sex === 'M' ? '父' : '母'} ${displayName(parent)}（${pb}）`,
          personId: p.id,
          otherId: pid,
        });
      } else if (b - pb < 12 && parent.sex === 'F') {
        items.push({
          text: `${displayName(parent)} 生 ${displayName(p)} 时约 ${b - pb} 岁，偏小，请核对`,
          personId: p.id,
          otherId: pid,
        });
      }
    }
  }

  return {
    code: 'F8.5',
    title: '生卒异常',
    desc: '子女早于父母出生、寿命超 120 岁等',
    items,
  };
}

/* ========================================================= */
/* F8.6 配偶不一致                                             */
/* ========================================================= */

function checkSpouses(idx) {
  const items = [];
  const seen = new Set();

  for (const [a, spouses] of idx.spouseOf) {
    for (const b of spouses) {
      const key = [a, b].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);

      const A = idx.byId.get(a);
      const B = idx.byId.get(b);
      if (!A || !B) continue;

      // ① 配偶双方世次不一致
      if (A.gen != null && B.gen != null && A.gen !== B.gen) {
        items.push({
          text: `配偶 ${displayName(A)}（第 ${A.gen} 代）与 ${displayName(B)}（第 ${B.gen} 代）世次不同，应为同辈`,
          personId: a,
          otherId: b,
        });
      }

      /* ② 配偶性别相同 —— 必须在体检里报出来，不能靠称谓规则掩盖。
        称谓表里 B W（嫂子）只有一条，没有 B H（兄之夫）；一旦数据里
        出现同性配偶，路径会退化成 B-H，界面上直接变成「关系待确认」。
        根因是数据填错（比如把哥哥的性别填成了女），所以这里如实报出，
        由用户判断是录错还是确实如此 —— 符合本项目「只报不改」的铁律。 */
      if (A.sex && B.sex && A.sex === B.sex) {
        items.push({
          text: `配偶 ${displayName(A)} 与 ${displayName(B)} 性别相同（都是${A.sex === 'F' ? '女' : '男'}），`
            + '会导致称谓无法推导，请确认是否录错',
          personId: a,
          otherId: b,
        });
      }
    }
  }

  // ③ 有共同子女但没登记婚配
  const kidPairs = new Map(); // parentId -> Set<parentId>
  for (const [childId, parents] of idx.parentsOf) {
    if (parents.length < 2) continue;
    for (let i = 0; i < parents.length; i++) {
      for (let j = i + 1; j < parents.length; j++) {
        const key = [parents[i], parents[j]].sort().join('|');
        if (!kidPairs.has(key)) kidPairs.set(key, []);
        kidPairs.get(key).push(childId);
      }
    }
  }
  for (const [key, kids] of kidPairs) {
    const [a, b] = key.split('|');
    const A = idx.byId.get(a);
    const B = idx.byId.get(b);
    if (!A || !B) continue;

    const married = (idx.spouseOf.get(a) || []).includes(b);
    const oneIsFemale = A.sex !== B.sex; // 同性的「共同父母」多为过继/继嗣，不报
    if (!married && oneIsFemale) {
      items.push({
        text: `${displayName(A)} 与 ${displayName(B)} 共同育有 ${kids.map((k) => idx.byId.get(k) ? displayName(idx.byId.get(k)) : k).join('、')}，但未登记婚配关系`,
        personId: a,
        otherId: b,
      });
    }
  }

  return {
    code: 'F8.6',
    title: '配偶不一致',
    desc: '配偶世次不符 / 性别相同 / 有共同子女却未登记婚配',
    items,
  };
}

/* ========================================================= */
/* F8.7 称谓未覆盖                                             */
/* ========================================================= */

function checkKinshipCoverage(dataset, idx, viewpoint) {
  const items = [];
  if (!viewpoint || !idx.byId.has(viewpoint)) {
    return {
      code: 'F8.7',
      title: '称谓未覆盖',
      desc: '规则表匹配不到的亲属关系',
      items: [],
    };
  }

  for (const p of dataset.people) {
    if (p.id === viewpoint) continue;
    const kin = deriveKinship(dataset, idx, viewpoint, p.id);
    if (!kin.ok) {
      items.push({
        text: `${displayName(p)}：${kin.reason || '规则表未覆盖'}（当前显示「关系待确认」）`,
        personId: p.id,
      });
    } else if (kin.genMismatch) {
      items.push({
        text: `${displayName(p)} 判为「${kin.dialect}」，按路径应为第 ${kin.ruleGen} 代，但数据里是第 ${kin.genDelta} 代 —— 世次或关系可能填错`,
        personId: p.id,
      });
    }
  }

  return {
    code: 'F8.7',
    title: '称谓未覆盖 / 推算存疑',
    desc: '规则表未覆盖，或称谓与世次互相矛盾',
    items,
  };
}

/* ========================================================= */
/* F8.8 待补充信息                                             */
/* ========================================================= */

/**
 * 待补充信息：姓名或性别留空的人（缺任意一个即列入）。
 *
 * 这是「先录上、后补全」工作流的落点 —— 用户录入时允许留空，
 * 这里把「哪些人还没补全」一次性列出来，点人名直接跳去编辑。
 * 补上之后 missingFields 变空，本条自动消失（**只报不改**）。
 *
 * 判定口径：只有姓名 / 性别是识别一个人的必需条件，缺一个就要提醒；
 * 出生、所在地、排行、备注、父母 / 配偶 / 子女等非必填项空着属常态，
 * 一律不报（详情面板里也不再摆「＋ 补充××」）。
 */
function checkIncomplete(dataset, idx) {
  const FIELD_LABEL = { name: '姓名', sex: '性别' };
  const items = [];

  for (const p of dataset.people) {
    const miss = missingFields(p);
    if (!miss.length) continue;
    const fields = miss.map((f) => FIELD_LABEL[f]).join('、');
    items.push({
      text: `${displayName(p)} 待补充：${fields}`,
      personId: p.id,
    });
  }

  return {
    code: 'F8.8',
    title: '待补充信息',
    desc: '姓名 / 性别留空，点名字可直接去补',
    items,
  };
}

/* ========================================================= */
/* 汇总统计（给左侧导航红点用）                                   */
/* ========================================================= */

export function diagnoseSummary(report) {
  if (!report) return { total: 0, ok: true };
  return {
    total: report.issueCount,
    ok: report.ok,
    byGroup: Object.fromEntries(report.groups.map((g) => [g.code, g.items.length])),
  };
}
