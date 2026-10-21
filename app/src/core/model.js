/**
 * =========================================================
 * 数据模型 · model.js
 * ---------------------------------------------------------
 * 产品的技术基石（PRD §3.1）：
 *   关系不存储，只存双亲指针。称谓实时计算。
 *
 * 一旦给人物加一个 `称呼` 字段，产品就退化成 Excel。
 * 所以本文件里没有、也永远不该有「称谓」字段——`callOverride` 不是称谓，
 * 它是**显示覆盖层**（用户手动填、按视角存），不参与推导，规则算出的
 * `dialect`/`std`/`note` 始终保留，只是卡片大字优先显示覆盖值。
 * =========================================================
 *
 * 【规范化数据结构】
 * {
 *   version: '1.0',
 *   viewpoint: 'p_me',            // 视角人物 id（v1 硬编码为用户本人）
 *   people: [
 *     {
 *       id: 'p_me',               // 稳定唯一，不含姓名含义
 *       name: '林然',
 *       sex: 'M',                 // 'M' | 'F'  —— 称谓推导必需，不可省
 *       birth: '1992',            // 精度可降级：YYYY | YYYY-MM | YYYY-MM-DD
 *       death: '',
 *       alive: true,
 *       avatar: '',               // 头像路径 / dataURL
 *       photos: [],
 *       note: '',
 *       gen: null,                // 世次；null = 由父母推导
 *       order: null,              // 同辈排行，0 = 长；null = 未知
 *       privacy: 'family',        // public | family | private
 *       place: '',
 *       expand: null,             // 可展开的家族树 key（'wife' / 'mom'）
 *     }
 *   ],
 *   relationships: [
 *     { a: 'p_me', b: 'p_f', type: 'parent',  from: '', to: '', source: '', confidence: 'high', note: '' },
 *     { a: 'p_f',  b: 'p_m', type: 'spouse',  from: '1986', to: '', source: '', confidence: 'high', note: '' },
 *   ]
 * }
 *
 * 【关系方向约定】—— 极易搞错，务必记牢
 *   type='parent'：a 是 b 的父亲或母亲（有向，a → b）
 *         一个人最多有 2 条入边（父 + 母）。
 *         边本身**不记**是父还是母 —— 查 Person.sex 得到。
 *         这样设计是为了避免「父母两个字段不一致」这个经典 bug。
 *   type='spouse'：a 与 b 是夫妻（无向，只写一条）
 *
 * ⚠️ 文档冲突：PRD §3.3 用 parentOf{}/spouseList{}，§3.6 用 lineage[]/spouseList[]，
 *    数据底稿 CSV 用统一 rel_type 表。三者描述同一信息。
 *    本项目内部统一采用**统一关系表**（最规范，且与真实数据底稿一致），
 *    并提供 toLineage() / toSpouseList() 适配 PRD §3.6 的导出格式。
 */

/* ========================================================= */
/* 常量                                                        */
/* ========================================================= */

/** 世次语义（PRD §3 README）：数值越大越年长 */
export const GEN_LABEL = {
  3: '曾祖辈',
  2: '祖辈',
  1: '父母辈',
  0: '我辈',
  '-1': '子侄辈',
  '-2': '孙辈',
};

/** 隐私级别 */
export const PRIVACY = {
  public: '公开',
  family: '家族内部',
  private: '仅自己',
};

export const PRIVACY_HINT = {
  public: '可对外展示，一般只给已故者',
  family: '仅家族内部可见（默认）',
  private: '仅本人 / 录入者可见',
};

/* ========================================================= */
/* 构建与规范化                                                 */
/* ========================================================= */

export function createEmptyDataset() {
  return { version: '1.0', viewpoint: '', people: [], relationships: [] };
}

/** 造一个稳定、不含姓名含义的 id */
export function makeId(existingIds = new Set()) {
  let id;
  do {
    id = 'p_' + Math.random().toString(36).slice(2, 8);
  } while (existingIds.has(id));
  return id;
}

/**
 * 规范化人物对象：补齐字段、校正类型、推导 alive。
 * 只补默认值，**不修正数据错误**（错误交给 diagnose 报出来，不静默改）。
 */
export function normalizePerson(raw = {}) {
  const death = str(raw.death);
  // alive 优先取显式值；没给就由 death 推导
  const alive =
    typeof raw.alive === 'boolean' ? raw.alive : death ? false : true;

  return {
  id: str(raw.id),
  name: str(raw.name),
  sex: raw.sex === 'F' ? 'F' : raw.sex === 'M' ? 'M' : '',
    birth: str(raw.birth),
    death,
    alive,
    avatar: str(raw.avatar),
    photos: Array.isArray(raw.photos) ? raw.photos.filter(Boolean) : [],
    note: str(raw.note),
    place: str(raw.place),
    gen: numOrNull(raw.gen),
    order: numOrNull(raw.order),
    privacy: PRIVACY[raw.privacy] ? raw.privacy : 'family',
    expand: raw.expand ? str(raw.expand) : null,
    // ★ 自定义称呼（显示覆盖层，按视角存）：{ [viewpointId]: '想叫的叫法' }
    //   这不是「称谓」计算结果、不参与推导；空对象 = 全部按规则自动算。
    callOverride: normalizeCallOverride(raw.callOverride),
  };
}

/**
 * 规范化「自定义称呼」覆盖表：只保留非空字符串值，其余丢弃。
 * 键是视角人物 id，值是该视角下想显示给这个人的叫法。
 */
function normalizeCallOverride(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'string' && val.trim()) out[k] = val.trim();
    }
  }
  return out;
}

export function normalizeRelationship(raw = {}) {
  return {
    a: str(raw.a),
    b: str(raw.b),
    type: raw.type === 'spouse' ? 'spouse' : 'parent',
    from: str(raw.from),
    to: str(raw.to),
    source: str(raw.source),
    confidence: ['high', 'medium', 'low'].includes(raw.confidence)
      ? raw.confidence
      : 'high',
    note: str(raw.note),
  };
}

/**
 * 规范化整份数据。
 * - 去重 id
 * - 丢弃指向不存在人物的关系（**同时记录**，由 diagnose 报为孤儿）
 * - 不修改语义
 */
export function normalizeDataset(raw = {}) {
  const people = [];
  const seen = new Set();

  for (const p of raw.people || []) {
    const person = normalizePerson(p);
    if (!person.id || seen.has(person.id)) continue; // 无 id / 重复 id 直接丢
    seen.add(person.id);
    people.push(person);
  }

  const relationships = [];
  const relSeen = new Set();
  const orphans = [];

  for (const r of raw.relationships || []) {
    const rel = normalizeRelationship(r);
    if (!rel.a || !rel.b || rel.a === rel.b) continue;

    // 关系去重：spouse 无向，需要对称去重
    const key =
      rel.type === 'spouse'
        ? [rel.a, rel.b].sort().join('|') + '|spouse'
        : rel.a + '>' + rel.b + '|parent';
    if (relSeen.has(key)) continue;
    relSeen.add(key);

    // 指向不存在的人 → 不进关系表，但登记为待体检项
    const missing = [];
    if (!seen.has(rel.a)) missing.push(rel.a);
    if (!seen.has(rel.b)) missing.push(rel.b);
    if (missing.length) {
      orphans.push({ rel, missing });
      continue;
    }

    relationships.push(rel);
  }

  return {
    version: str(raw.version) || '1.0',
    viewpoint: str(raw.viewpoint),
    people,
    relationships,
    _orphans: orphans, // 只读诊断线索，序列化时剔除
  };
}

/* ========================================================= */
/* 索引                                                        */
/* ========================================================= */

/**
 * 建索引。所有下游算法（布局 / 称谓 / 体检）都从这里拿关系，
 * 不直接翻 relationships 数组。
 */
export function buildIndex(dataset) {
  const people = dataset.people || [];
  const byId = new Map(people.map((p) => [p.id, p]));

  /** childId -> [parentId]  （最多 2 个：父 + 母） */
  const parentsOf = new Map();
  /** parentId -> [childId] */
  const kidsOf = new Map();
  /** personId -> [spouseId] */
  const spouseOf = new Map();

  const push = (map, key, val) => {
    if (!map.has(key)) map.set(key, []);
    const arr = map.get(key);
    if (!arr.includes(val)) arr.push(val);
  };

  for (const r of dataset.relationships || []) {
    if (r.type === 'parent') {
      push(parentsOf, r.b, r.a); // a 是 b 的父母
      push(kidsOf, r.a, r.b);
    } else if (r.type === 'spouse') {
      // 无向：两边都记，方便任意一侧查询
      push(spouseOf, r.a, r.b);
      push(spouseOf, r.b, r.a);
    }
  }

  // 排序：子按 order 长幼，未知排最后
  const byOrder = (a, b) => {
    const oa = byId.get(a)?.order;
    const ob = byId.get(b)?.order;
    if (oa == null && ob == null) return 0;
    if (oa == null) return 1;
    if (ob == null) return -1;
    return oa - ob;
  };
  for (const [k, arr] of kidsOf) kidsOf.set(k, arr.slice().sort(byOrder));

  return {
    byId,
    parentsOf,
    kidsOf,
    spouseOf,
    /** 取所有 id，便于建 Set */
    ids: new Set(byId.keys()),
  };
}

/** 取某人的父亲（sex === 'M' 的那条入边） */
export function fatherOf(idx, id) {
  for (const pid of idx.parentsOf.get(id) || []) {
    if (idx.byId.get(pid)?.sex === 'M') return pid;
  }
  return null;
}

/** 取某人的母亲 */
export function motherOf(idx, id) {
  for (const pid of idx.parentsOf.get(id) || []) {
    if (idx.byId.get(pid)?.sex === 'F') return pid;
  }
  return null;
}

/* ========================================================= */
/* 世次（gen）推导                                             */
/* ========================================================= */

/**
 * 推导世次。
 *
 * 规则（PRD §3.2 说「可由父母自动推导，也允许人工覆盖」但**没写算法**）：
 *   1. 显式 gen 永远优先（人工覆盖）
 *   2. 以 viewpoint（我）为锚点 = 0，沿父子/配偶双向传播：
 *        父/母  = 子 + 1
 *        子/女  = 父 - 1
 *        配 偶  = 同辈
 *   3. 与「我」不连通的家族（如妻子家族、母亲家族单独成树时），
 *      用分量内深度推导，锚定为「分量最深的后代 = gen 0」
 *
 * ⚠️ 第 3 条是启发式。文档没定义跨家族世次，此处按「后代落在 0 辈」处理。
 *    如果你希望妻子家族单独偏移，告诉我改。
 *
 * @returns {Map<string, number>}
 */
export function deriveGen(dataset) {
  const idx = buildIndex(dataset);
  const derived = new Map();
  const anchor = dataset.viewpoint;

  /* --- 1) 以 viewpoint 为锚，双向 BFS --- */
  if (anchor && idx.byId.has(anchor)) {
    const queue = [[anchor, 0]];
    derived.set(anchor, 0);
    while (queue.length) {
      const [id, g] = queue.shift();
      const spread = (nid, ng) => {
        if (nid && !derived.has(nid) && idx.byId.has(nid)) {
          derived.set(nid, ng);
          queue.push([nid, ng]);
        }
      };
      for (const p of idx.parentsOf.get(id) || []) spread(p, g + 1);
      for (const c of idx.kidsOf.get(id) || []) spread(c, g - 1);
      for (const s of idx.spouseOf.get(id) || []) spread(s, g);
    }
  }

  /* --- 2) 剩余不连通分量：按分量深度推导 --- */
  for (const p of dataset.people || []) {
    if (derived.has(p.id)) continue;

    // 收集该分量的全部成员（忽略方向）
    const comp = [];
    const seen = new Set([p.id]);
    const q = [p.id];
    while (q.length) {
      const id = q.shift();
      comp.push(id);
      const nbrs = [
        ...(idx.parentsOf.get(id) || []),
        ...(idx.kidsOf.get(id) || []),
        ...(idx.spouseOf.get(id) || []),
      ];
      for (const n of nbrs) {
        if (!seen.has(n)) { seen.add(n); q.push(n); }
      }
    }

    // 分量内深度（从「无父母的节点」往下走）
    const depth = new Map();
    const compSet = new Set(comp);
    const roots = comp.filter(
      (id) => !(idx.parentsOf.get(id) || []).some((x) => compSet.has(x))
    );
    const dq = (roots.length ? roots : comp).map((id) => {
      depth.set(id, 0);
      return id;
    });
    while (dq.length) {
      const id = dq.shift();
      const d = depth.get(id);
      for (const c of idx.kidsOf.get(id) || []) {
        if (compSet.has(c) && !depth.has(c)) { depth.set(c, d + 1); dq.push(c); }
      }
      // 配偶同深度
      for (const s of idx.spouseOf.get(id) || []) {
        if (compSet.has(s) && !depth.has(s)) { depth.set(s, d); dq.push(s); }
      }
    }

    // 锚定：该分量里若有显式 gen，用它对齐；否则让最深的后代落在 gen 0
    const explicit = comp
      .map((id) => ({ id, g: idx.byId.get(id)?.gen }))
      .filter((x) => x.g != null);
    let base;
    if (explicit.length) {
      // base 使 深度 0 的节点 gen = base，令显式值误差最小 → 取众数偏移
      const offsets = explicit.map((x) => {
        const d = depth.get(x.id) ?? 0;
        return (x.g ?? 0) + d; // gen + depth（gen 越大 = 越年长 = 深度越小）
      });
      base = Math.round(median(offsets));
    } else {
      const maxD = Math.max(0, ...depth.values());
      base = maxD; // 最深后代 = gen 0
    }

    for (const id of comp) {
      derived.set(id, base - (depth.get(id) ?? 0));
    }
  }

  return derived;
}

/**
 * 取某人最终生效的世次：显式优先，其次推导。
 * @returns {number|null}
 */
export function effectiveGen(person, genMap) {
  if (person && person.gen != null) return person.gen;
  const g = genMap?.get?.(person?.id);
  return g == null ? null : g;
}

/**
 * 剥掉推导出来的 gen，只留人工覆盖值。**存盘 / 导出前必须调用。**
 *
 * 为什么必须有这一步：
 *   gen 是**派生数据**，由双亲指针推导而来。项目第一铁律是「关系不存储，
 *   改一处关系全树自动更新」。如果把推导值写进数据库，下次加载时
 *   effectiveGen() 会把它当成「人工显式值」优先采用，推导从此不再参与 ——
 *   用户改了父母关系，树却不跟着变，只在体检里多一条「世次矛盾」。
 *   等于把派生数据固化成了事实来源，直接违反铁律。
 *
 * 配合 withResolvedGen 使用：后者在每人身上留一份 `_genRaw`（推导前的值），
 * 本函数据此还原，然后删掉这个内部字段，保证序列化出去的是干净数据。
 *
 * 幂等：对没推导过的数据集原样返回（不产生多余拷贝）。
 */
export function stripDerivedGen(dataset) {
  const people = (dataset.people || []).map((p) => {
    if (!('_genRaw' in p)) return p; // 没被推导过 —— 它的 gen 本来就是显式值
    const o = { ...p, gen: p._genRaw ?? null };
    delete o._genRaw;
    return o;
  });
  return { ...dataset, people };
}

/**
 * 给全表抹上最终生效的 gen（**不改原对象**，返回新数组）。
 *
 * ⚠️ 推导值只活在内存里。本函数会在每人身上留一份 `_genRaw`（推导前的显式值），
 *    供 stripDerivedGen() 在存盘 / 导出前还原。`_genRaw` 是内部字段，
 *    serialize() 已保证它不会流出到磁盘或导出文件。
 *
 * 幂等：重复调用结果一致 —— 每次都先剥掉上一轮的推导值，
 *    所以 deriveGen 看到的永远是干净的显式输入，不会「越推越偏」。
 */
export function withResolvedGen(dataset) {
  const base = stripDerivedGen(dataset);
  const genMap = deriveGen(base);
  const people = base.people.map((p) => ({
    ...p,
    _genRaw: p.gen, // 记住人工覆盖值（可能是 null）
    gen: effectiveGen(p, genMap), // 生效值：显式优先，其次推导
  }));
  return { ...dataset, people };
}

/* ========================================================= */
/* 导出适配（PRD §3.6 格式）                                    */
/* ========================================================= */

/** 统一关系表 → PRD §3.6 的 lineage: [[子, 父]] */
export function toLineage(dataset) {
  return (dataset.relationships || [])
    .filter((r) => r.type === 'parent')
    .map((r) => [r.b, r.a]);
}

/** 统一关系表 → PRD §3.6 的 spouseList: [{a,b,type,from,to}] */
export function toSpouseList(dataset) {
  return (dataset.relationships || [])
    .filter((r) => r.type === 'spouse')
    .map((r) => ({
      a: r.a,
      b: r.b,
      type: r.from ? 'married' : 'married',
      from: r.from || '',
      to: r.to || '',
    }));
}

/**
 * 序列化为底稿 JSON 文本（剔除内部诊断字段）。
 *
 * ⚠️ 这里是**唯一的落盘 / 导出出口**（saveDataset 与 exportFile 都走它），
 *    所以「剥掉推导 gen」这一步放在这里，一处覆盖所有写出路径，
 *    调用方不必各自记得调用 stripDerivedGen —— 忘了就会污染数据库。
 */
export function serialize(dataset) {
  const clean = stripDerivedGen(dataset);
  return JSON.stringify(
    {
      version: clean.version || '1.0',
      viewpoint: clean.viewpoint || '',
      people: (clean.people || []).map((p) => ({ ...p })),
      relationships: (clean.relationships || []).map((r) => ({ ...r })),
    },
    null,
    2
  );
}

/* ========================================================= */
/* 小工具                                                      */
/* ========================================================= */

function str(v) {
  if (v == null) return '';
  return String(v).trim();
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 把 'YYYY' / 'YYYY-MM' / 'YYYY-MM-DD' 拆成 {y,m,d}，解析不出来给 null */
export function parseDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return null;
  return {
    y: Number(m[1]),
    m: m[2] ? Number(m[2]) : null,
    d: m[3] ? Number(m[3]) : null,
  };
}

/** 取年份数字，用于长幼比较 */
export function birthYear(person) {
  return parseDate(person?.birth)?.y ?? null;
}

/* ========================================================= */
/* 显示层辅助（待补信息）                                        */
/* ========================================================= */

/**
 * 显示用姓名：留空时统一显示「未知」——这是「信息待补」的占位。
 *
 * 为什么要放在显示层而不是存储层？
 *   存储层允许 name 为空（待补），如果在这里强制成「未命名」，
 *   假数据就进库了，搜索 / 导出 / 体检都会把它当成真名。
 *   所以占位只在渲染时给，存盘永远是干净的空字符串。
 */
export function displayName(p) {
  return p && p.name ? String(p.name) : '未知';
}

/**
 * 头像字形：优先取姓名末字；姓名留空时回退为性别字「男 / 女」，
 * 性别也不知则「?」——让占位卡片也能一眼看出已知信息。
 */
export function avatarGlyph(p) {
  const n = (p && p.name) || '';
  if (!n) {
    if (p?.sex === 'M') return '男';
    if (p?.sex === 'F') return '女';
    return '?';
  }
  if (n.length === 1) return n;
  if (n.endsWith('氏')) return n[0];
  return n.slice(-1);
}

/**
 * 返回某人缺失的字段（用于「待补」标记 / 体检清单）。
 * @returns {string[]} 'name' | 'sex' 的子集，空数组表示已补全
 */
export function missingFields(p) {
  const m = [];
  if (!p || !p.name) m.push('name');
  if (!p || !p.sex) m.push('sex');
  return m;
}
