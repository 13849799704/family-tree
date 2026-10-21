/**
 * =========================================================
 * core 层自测 · tests/run.js
 * ---------------------------------------------------------
 * 零依赖（只用 node:assert），直接 `node tests/run.js`。
 * core 层不碰 DOM，所以能在 Node 里跑 —— 这是当初坚持
 * 「引擎与渲染分离」换来的红利：改一行称谓规则，秒级知道炸没炸。
 *
 * 覆盖五块：
 *   1. 数据规范化与索引
 *   2. 世次推导
 *   3. 布局三条硬约束（夫妻间距 / 父居中 / 同代不重叠）
 *   4. 称谓推导（40+ 条抽样，含口语叫法与两跳姻亲）
 *   5. F8 自动体检
 * =========================================================
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  normalizeDataset, normalizePerson, buildIndex, withResolvedGen, stripDerivedGen,
  fatherOf, motherOf, serialize, parseDate, birthYear,
} from '../src/core/model.js';
import {
  buildMainTree, detectExpandableFamilies, buildFamilyTree, findLineageRoot, scopeToTree,
} from '../src/core/family.js';
import { layoutTree, layoutAllTrees, verifyLayout, LAYOUT } from '../src/core/layout.js';
import { filterParentCandidates, branchOfSymbols, splitParentCandidates, PARENT_GROUP } from '../src/core/parentFilter.js';
import { deriveKinship, deriveAllKinships, ruleStats, displayCall, displayLabel } from '../src/core/kinship.js';
import { RULES, lookupRule, withRank } from '../src/core/rules.js';
import { diagnose, diagnoseSummary } from '../src/core/diagnose.js';
import { SAMPLE_DATA } from '../src/data/sample.js';
import {
  imagePlan, imageFilename, safeFileToken, dateStamp, PAD, MAX_DIM, MAX_AREA,
} from '../src/core/export-image.js';
import { PINYIN, readingsOf } from '../src/core/data/pinyin.js';
import { collectHits, search, pinyinForms } from '../src/core/search.js';

/* ========================================================= */
/* 极简测试框架                                                */
/* ========================================================= */

let passed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failures.push({ group: currentGroup, name, message: e.message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${String(e.message).split('\n')[0]}\x1b[0m`);
  }
}

/* ========================================================= */
/* 准备数据                                                    */
/* ========================================================= */

const ds = withResolvedGen(normalizeDataset(SAMPLE_DATA));
const idx = buildIndex(ds);
const tags = SAMPLE_DATA.people;
const nameOf = (id) => idx.byId.get(id)?.name || id;

/* ========================================================= */
/* 1. 数据规范化与索引                                          */
/* ========================================================= */

group('1. 数据规范化与索引');

test('示例数据无悬空关系（_orphans 为空）', () => {
  assert.equal(ds._orphans.length, 0,
    `有 ${ds._orphans.length} 条关系指向不存在的人：` +
    ds._orphans.map((o) => `${o.rel.a}→${o.rel.b}`).join(', '));
});

test('人物数量与原始数据一致', () => {
  assert.equal(ds.people.length, tags.length);
});

test('每个人 id 唯一', () => {
  const ids = ds.people.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('parseDate 三种精度都能解析', () => {
  assert.deepEqual(parseDate('1992'), { y: 1992, m: null, d: null });
  assert.deepEqual(parseDate('1992-07'), { y: 1992, m: 7, d: null });
  assert.deepEqual(parseDate('1992-07-15'), { y: 1992, m: 7, d: 15 });
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('不知道'), null);
});

test('父母按 sex 正确区分（父 / 母各一条边，不靠字段名）', () => {
  assert.equal(fatherOf(idx, 'p_me'), 'p_f');
  assert.equal(motherOf(idx, 'p_me'), 'p_m');
  assert.equal(fatherOf(idx, 'p_wife'), 'p_wf');
  assert.equal(motherOf(idx, 'p_wife'), 'p_wm');
  assert.equal(fatherOf(idx, 'p_p2'), 'p_g1');
});

test('婚配关系是无向的（两侧都能查到）', () => {
  assert.ok(idx.spouseOf.get('p_me').includes('p_wife'));
  assert.ok(idx.spouseOf.get('p_wife').includes('p_me'));
});

test('子女按排行升序排列', () => {
  assert.deepEqual(idx.kidsOf.get('p_p2'), ['p_gu', 'p_f', 'p_unc']);
  assert.deepEqual(idx.kidsOf.get('p_wf'), ['p_wu', 'p_wife', 'p_wsis']);
});

test('serialize 输出可被重新解析（往返不丢信息）', () => {
  const round = normalizeDataset(JSON.parse(serialize(ds)));
  assert.equal(round.people.length, ds.people.length);
  assert.equal(round.relationships.length, ds.relationships.length);
});

test('normalize 会丢弃自环与重复关系，而不是静默接受', () => {
  const dirty = normalizeDataset({
    people: [{ id: 'a', name: 'A', sex: 'M' }, { id: 'b', name: 'B', sex: 'M' }],
    relationships: [
      { a: 'a', b: 'a', type: 'parent' },          // 自环 → 丢
      { a: 'a', b: 'b', type: 'spouse' },
      { a: 'b', b: 'a', type: 'spouse' },          // 无向重复 → 丢
      { a: 'a', b: 'ghost', type: 'parent' },      // 悬空 → 进 _orphans
    ],
  });
  assert.equal(dirty.relationships.length, 1);
  assert.equal(dirty._orphans.length, 1);
});

/* ========================================================= */
/* 2. 世次推导                                                 */
/* ========================================================= */

group('2. 世次推导');

const genOf = (id) => ds.people.find((p) => p.id === id).gen;

test('以「我」为锚点，父母 +1 / 子女 -1', () => {
  assert.equal(genOf('p_me'), 0);
  assert.equal(genOf('p_f'), 1);
  assert.equal(genOf('p_m'), 1);
  assert.equal(genOf('p_son'), -1);
});

test('向上两代 / 三代推导正确', () => {
  assert.equal(genOf('p_p2'), 2);
  assert.equal(genOf('p_g1'), 3);
});

test('配偶与本人同辈', () => {
  assert.equal(genOf('p_wife'), 0);
  assert.equal(genOf('p_p2w'), 2);
});

test('姻亲家族（岳父家）能跨家族推出世次', () => {
  assert.equal(genOf('p_wf'), 1);
  assert.equal(genOf('p_wg'), 2);
});

test('母系家族（外公家）世次正确', () => {
  assert.equal(genOf('p_mg'), 2);
  assert.equal(genOf('p_mbro'), 0);
});

test('全表无 null 世次（每人都能推导或显式给出）', () => {
  const missing = ds.people.filter((p) => p.gen == null).map((p) => p.name);
  assert.equal(missing.length, 0, `未推导出世次：${missing.join('、')}`);
});

/* ========================================================= */
/* 3. 布局                                                     */
/* ========================================================= */

group('3. 布局引擎');

const mainTree = buildMainTree(ds, 'p_me');
const mainLayout = layoutTree(mainTree);

test('主树只含父系家族，姻亲家族各自独立成树', () => {
  const ids = mainTree.people.map((p) => p.id);
  assert.ok(ids.includes('p_me'), '本人应在树内');
  assert.ok(ids.includes('p_g1'), '族源（曾祖父）应在树内');
  assert.ok(!ids.includes('p_wg'), '岳祖父不该混进父系主树');
  assert.ok(!ids.includes('p_mg'), '外公不该混进父系主树');
  assert.equal(mainTree.people.length, 20, '父系家族应为 20 人');
});

test('主树节点全部落位（无遗漏、无多余）', () => {
  assert.equal(Object.keys(mainLayout.pos).length, mainTree.people.length);
  for (const p of mainTree.people) {
    assert.ok(mainLayout.pos[p.id], `${p.name} 没落位`);
  }
});

test('主树布局满足三条硬约束（夫妻间距 / 父居中 / 同代不重叠）', () => {
  const v = verifyLayout(mainTree, mainLayout);
  assert.equal(v.issues.length, 0, '布局问题：\n  ' + v.issues.join('\n  '));
  assert.ok(v.couples > 0, '居然没检测到任何夫妻');
  assert.ok(v.fathers > 0, '居然没检测到任何父节点');
});

test('y 用全局统一映射：同一 gen 必然同一 y', () => {
  assert.equal(mainLayout.pos.p_me.y, mainLayout.pos.p_wife.y, '同为第 0 代却 y 不同');
});

test('y 映射跨树一致 —— 换家族时锚点上下不跳', () => {
  const expandable = detectExpandableFamilies(ds, mainTree);
  const all = layoutAllTrees(ds, mainTree, expandable, buildFamilyTree);
  const wifeTree = all['natal_p_wife'];
  assert.ok(wifeTree, '没生成妻子家族树');
  assert.equal(wifeTree.pos.p_wu.y, mainLayout.pos.p_me.y,
    '同为第 0 代却 y 不同 —— 说明 y 用了局部重排（PRD §5 明确禁止）');
  assert.equal(wifeTree.pos.p_wg.y, mainLayout.pos.p_p2.y, '同为第 2 代却 y 不同');
});

test('世次越高 y 越小（越靠上），且行高恒定', () => {
  const y0 = mainLayout.pos.p_me.y;
  const y1 = mainLayout.pos.p_f.y;
  assert.equal(y0 - y1, LAYOUT.ROW_H);
});

test('自动发现可展开的原生家族（妻子家 / 母亲家）', () => {
  const expandable = detectExpandableFamilies(ds, mainTree);
  const labels = expandable.map((e) => e.label);
  assert.ok(expandable.length >= 2,
    `只发现 ${expandable.length} 个：${labels.join('、')}`);
  assert.ok(expandable.some((e) => e.anchorId === 'p_wife'), '没发现妻子家族');
  assert.ok(expandable.some((e) => e.anchorId === 'p_m'), '没发现母亲家族');
});

test('三页模型：配偶一个祖先都没录，也要照样留一页（标待补父母）', () => {
  /* 用户定的模型是固定三页：男方血脉 / 母亲血脉 / 妻子血脉。
     以前「上溯不到祖先就跳过」—— 妻子父母没录时，第三页凭空消失，
     人也跟着不见了，连个提示都没有。页数不该由「数据录全了没」决定。 */
  const d = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      { id: 'me',   name: '我',   sex: 'M', gen: 1 },
      { id: 'fa',   name: '爸',   sex: 'M', gen: 2 },
      { id: 'wife', name: '妻',   sex: 'F', gen: 1 },   // ← 没有任何父母
    ],
    relationships: [
      { a: 'fa', b: 'me', type: 'parent' },
      { a: 'me', b: 'wife', type: 'spouse' },
    ],
  }));
  const tree = buildMainTree(d, 'me');
  const ex = detectExpandableFamilies(d, tree);
  const wifePage = ex.find((e) => e.anchorId === 'wife');

  assert.ok(wifePage, '妻子没录父母时，家族页也必须留着');
  assert.equal(wifePage.pending, true, '这一页要标成待补录（UI 据此画虚线框）');
  /* tab 上不写「待补父母」：tab 是导航不是提示位，写满了字挤得慌。
     「还缺父母」由虚线框 + 页面顶部的提示条去说。 */
  assert.equal(wifePage.label.includes('待补'), false,
    `tab 标签不该出现「待补」字样，实际「${wifePage.label}」`);
  assert.ok(wifePage.label.includes('妻'), `标签仍要写明是谁的家族：「${wifePage.label}」`);
  assert.equal(wifePage.rootId, 'wife', '以她自己为根，页里才能画出这个人');

  /* 页里确实能画出她，而且布局合法 —— 不能只留一个空壳页。
     注意 buildFamilyTree 会把血亲成员的配偶一并带进来（该函数第 2 步），
     所以这一页是「她 + 她的配偶」，不是孤零零一个人。 */
  const t = buildFamilyTree(d, {
    rootId: wifePage.rootId, anchorId: wifePage.anchorId, key: wifePage.key, label: wifePage.label,
  });
  assert.ok(t.people.some((p) => p.id === 'wife'), '待补页里得能看见她本人');
  assert.equal(wifePage.size, t.people.length, 'tab 上的人数要跟页里实际人头一致');
  const lay = layoutTree(t);
  assert.ok(lay.pos.wife, '待补页里得能画出她');

  /* 有父母时照旧是正常页，不该被标成待补 */
  assert.equal(ex.find((e) => e.anchorId === 'fa'), undefined,
    '父亲属于主树，不该单独再出一页');
});

test('只有视角人的配偶享受「无祖先也出页」，其他姻亲不享受（否则几十个空页）', () => {
  const d = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      { id: 'me',   name: '我',       sex: 'M', gen: 1 },
      { id: 'wife', name: '妻',       sex: 'F', gen: 1 },
      { id: 'bro',  name: '兄弟',     sex: 'M', gen: 1 },
      { id: 'bsw',  name: '嫂子',     sex: 'F', gen: 1 },   // 兄弟的妻子，也没父母
    ],
    relationships: [
      { a: 'me', b: 'wife', type: 'spouse' },
      { a: 'me', b: 'bro', type: 'spouse' },
      { a: 'bro', b: 'bsw', type: 'spouse' },
    ],
  }));
  const tree = buildMainTree(d, 'me');
  const ex = detectExpandableFamilies(d, tree);
  assert.ok(ex.some((e) => e.anchorId === 'wife'), '视角人的配偶要出页');
  assert.equal(ex.some((e) => e.anchorId === 'bsw'), false,
    '旁人的妻子没祖先就不出页 —— 否则空页会泛滥');
});

test('固定三页：只出「母亲 / 妻子」两页，别的姻亲一律不出页', () => {
  /* 用户 2026-10-11 定：顶部最多三个 tab —— 自己 / 母亲 / 妻子。
     旧实现扫所有姻亲，页数不可控，而且切视角后第二个 tab 可能还是上一个人的亲戚。 */
  const d = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      { id: 'me',    name: '我',     sex: 'M', gen: 1 },
      { id: 'fa',    name: '爸',     sex: 'M', gen: 2 },
      { id: 'fag',   name: '爷爷',   sex: 'M', gen: 3 },
      { id: 'mo',    name: '妈',     sex: 'F', gen: 2 },
      { id: 'mog',   name: '外公',   sex: 'M', gen: 3 },
      { id: 'wife',  name: '妻',     sex: 'F', gen: 1 },
      { id: 'wifef', name: '岳父',   sex: 'M', gen: 2 },
      { id: 'bro',   name: '兄弟',   sex: 'M', gen: 1 },
      { id: 'bsw',   name: '嫂子',   sex: 'F', gen: 1 },
      { id: 'bswg',  name: '嫂子的父亲', sex: 'M', gen: 2 },
    ],
    relationships: [
      { a: 'fa', b: 'me', type: 'parent' }, { a: 'fag', b: 'fa', type: 'parent' },
      { a: 'mo', b: 'me', type: 'parent' }, { a: 'mog', b: 'mo', type: 'parent' },
      { a: 'me', b: 'wife', type: 'spouse' }, { a: 'wifef', b: 'wife', type: 'parent' },
      { a: 'fa', b: 'bro', type: 'parent' }, { a: 'bro', b: 'bsw', type: 'spouse' },
      { a: 'bswg', b: 'bsw', type: 'parent' },
    ],
  }));
  const main = buildMainTree(d, 'me');
  const ex = detectExpandableFamilies(d, main);

  /* 自己的族源走父系（爷爷），母亲页走外公那条线，妻子页走岳父那条线 —— 三者互不重合 */
  const mainNames = main.people.map((p) => p.name);
  assert.ok(mainNames.includes('我') && mainNames.includes('爸') && mainNames.includes('爷爷'),
    `主树应是父系这一支，实际 ${mainNames.join('、')}`);
  assert.equal(mainNames.includes('妈'), false,
    '妈是通过 parent 边连上来的「向上」关系，不在父系下行的路径里 —— 母系归第 2 页');
  assert.equal(mainNames.includes('外公'), false, '外公属母系，只能出现在母亲页');
  assert.equal(ex.length, 2, `只应有母亲页 + 妻子页，实际 ${ex.length}：${ex.map((e) => e.label).join('、')}`);
  assert.equal(ex[0].anchorId, 'mo', '第 2 页必须是母亲');
  assert.equal(ex[1].anchorId, 'wife', '第 3 页必须是妻子');
  assert.ok(ex[0].label.includes('母亲'), `标签要写明身份，现在只是「${ex[0].label}」`);
  assert.ok(ex[1].label.includes('妻子'), `标签要写明身份，现在只是「${ex[1].label}」`);
  assert.equal(ex.some((e) => e.anchorId === 'bsw'), false, '嫂子的娘家不出页');
  assert.equal(ex.some((e) => e.anchorId === 'wifef'), false, '岳父属于妻子页，不另出页');

  /* ⚠️ 只登记母亲、没登记父亲时，主树族源 == 母亲页族源，两页会 100% 重合。
     这种情况必须跳过，否则同一张图出现两遍 —— 这就是保留 0.8 检查的唯一理由。 */
  const d2 = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      { id: 'me',  name: '我',   sex: 'M', gen: 0 },
      { id: 'mo',  name: '妈',   sex: 'F', gen: 1 },
      { id: 'mog', name: '外公', sex: 'M', gen: 2 },
    ],
    relationships: [
      { a: 'mo', b: 'me', type: 'parent' },
      { a: 'mog', b: 'mo', type: 'parent' },
    ],
  }));
  const ex2 = detectExpandableFamilies(d2, buildMainTree(d2, 'me'));
  assert.equal(ex2.length, 0, '母系就是主树本身时，不该再重复出一页');
});

test('切视角后第二、三页必须换成新视角人的母亲与妻子', () => {
  /* 用户报的现象：「切换视角后母亲和妻子还是原来人物的」。 */
  const people = [
    { id: 'a', name: '甲', sex: 'M', gen: 1 },
    { id: 'afa', name: '甲父', sex: 'M', gen: 2 }, { id: 'afag', name: '甲爷', sex: 'M', gen: 3 },
    { id: 'amo', name: '甲妈', sex: 'F', gen: 2 }, { id: 'amog', name: '甲外爷', sex: 'M', gen: 3 },
    { id: 'aw', name: '甲妻', sex: 'F', gen: 1 }, { id: 'awf', name: '甲岳', sex: 'M', gen: 2 },
    { id: 'b', name: '乙', sex: 'M', gen: 1 },
    { id: 'bfa', name: '乙父', sex: 'M', gen: 2 }, { id: 'bfag', name: '乙爷', sex: 'M', gen: 3 },
    { id: 'bmo', name: '乙妈', sex: 'F', gen: 2 }, { id: 'bmog', name: '乙外爷', sex: 'M', gen: 3 },
    { id: 'bw', name: '乙妻', sex: 'F', gen: 1 }, { id: 'bwf', name: '乙岳', sex: 'M', gen: 2 },
  ];
  const rels = [
    { a: 'afa', b: 'a', type: 'parent' }, { a: 'afag', b: 'afa', type: 'parent' },
    { a: 'amo', b: 'a', type: 'parent' }, { a: 'amog', b: 'amo', type: 'parent' },
    { a: 'a', b: 'aw', type: 'spouse' }, { a: 'awf', b: 'aw', type: 'parent' },
    { a: 'bfa', b: 'b', type: 'parent' }, { a: 'bfag', b: 'bfa', type: 'parent' },
    { a: 'bmo', b: 'b', type: 'parent' }, { a: 'bmog', b: 'bmo', type: 'parent' },
    { a: 'b', b: 'bw', type: 'spouse' }, { a: 'bwf', b: 'bw', type: 'parent' },
  ];
  const pagesOf = (vpId) => {
    const d = withResolvedGen(normalizeDataset({
      version: '1.0', viewpoint: vpId, people, relationships: rels,
    }));
    return detectExpandableFamilies(d, buildMainTree(d, vpId)).map((e) => e.anchorId);
  };

  assert.deepEqual(pagesOf('a'), ['amo', 'aw'], '甲视角：母亲甲妈、妻子甲妻');
  assert.deepEqual(pagesOf('b'), ['bmo', 'bw'], '乙视角：必须换成乙妈、乙妻，不能还停在甲的人身上');
});

test('女方视角：第三页是「丈夫」的家族树，不是「妻子」', () => {
  /* 用户指出：「如果视角是女方，那第三个就是丈夫的家族树了」。
     写死「妻子」的话，女方视角下会荒谬地标成「妻子家族」——
     视角人自己就是那位"妻子"。角色称呼必须跟着视角人性别走。 */
  const people = [
    { id: 'w',   name: '女方', sex: 'F', gen: 0 },
    { id: 'wf',  name: '女方爸', sex: 'M', gen: 1 },
    { id: 'wfg', name: '女方爷', sex: 'M', gen: 2 },
    { id: 'wm',  name: '女方妈', sex: 'F', gen: 1 },
    { id: 'wmg', name: '女方外公', sex: 'M', gen: 2 },
    { id: 'h',   name: '丈夫', sex: 'M', gen: 0 },
    { id: 'hf',  name: '公公', sex: 'M', gen: 1 },
    { id: 'hfg', name: '公公爹', sex: 'M', gen: 2 },
  ];
  const rels = [
    { a: 'wf', b: 'w', type: 'parent' }, { a: 'wfg', b: 'wf', type: 'parent' },
    { a: 'wm', b: 'w', type: 'parent' }, { a: 'wmg', b: 'wm', type: 'parent' },
    { a: 'w', b: 'h', type: 'spouse' },
    { a: 'hf', b: 'h', type: 'parent' }, { a: 'hfg', b: 'hf', type: 'parent' },
  ];
  const ex = detectExpandableFamilies(
    withResolvedGen(normalizeDataset({ version: '1.0', viewpoint: 'w', people, relationships: rels })),
    buildMainTree(withResolvedGen(normalizeDataset({ version: '1.0', viewpoint: 'w', people, relationships: rels })), 'w'),
  );

  assert.equal(ex.length, 2, `母亲页 + 丈夫页，实际 ${ex.length}`);
  assert.equal(ex[0].anchorId, 'wm', '第 2 页仍是母亲的家族');
  assert.equal(ex[0].label.includes('母亲'), true, `第 2 页标签：${ex[0].label}`);
  assert.equal(ex[1].anchorId, 'h', '第 3 页是丈夫，不是「妻子」');
  assert.ok(ex[1].label.includes('丈夫'), `第 3 页标签必须写「丈夫」，现在写的是「${ex[1].label}」`);
  assert.equal(ex[1].label.includes('妻子'), false, '女方视角下不许出现「妻子家族」这种荒谬标签');
});

test('男方视角：第三页仍写「妻子」，两边的称呼不能串', () => {
  const people = [
    { id: 'm',   name: '男方', sex: 'M', gen: 0 },
    { id: 'mf',  name: '男方爸', sex: 'M', gen: 1 },
    { id: 'mfg', name: '男方爷', sex: 'M', gen: 2 },
    { id: 'mm',  name: '男方妈', sex: 'F', gen: 1 },
    { id: 'mmg', name: '男方外公', sex: 'M', gen: 2 },
    { id: 'w',   name: '妻子', sex: 'F', gen: 0 },
    { id: 'wf',  name: '岳父', sex: 'M', gen: 1 },
    { id: 'wfg', name: '岳祖父', sex: 'M', gen: 2 },
  ];
  const rels = [
    { a: 'mf', b: 'm', type: 'parent' }, { a: 'mfg', b: 'mf', type: 'parent' },
    { a: 'mm', b: 'm', type: 'parent' }, { a: 'mmg', b: 'mm', type: 'parent' },
    { a: 'm', b: 'w', type: 'spouse' },
    { a: 'wf', b: 'w', type: 'parent' }, { a: 'wfg', b: 'wf', type: 'parent' },
  ];
  const d = withResolvedGen(normalizeDataset({ version: '1.0', viewpoint: 'm', people, relationships: rels }));
  const ex = detectExpandableFamilies(d, buildMainTree(d, 'm'));
  assert.equal(ex.length, 2, `母亲页 + 妻子页，实际 ${ex.length}：${ex.map((e) => e.label).join('、')}`);
  assert.ok(ex[1].label.includes('妻子'), `男方视角第 3 页应写「妻子」，实际「${ex[1].label}」`);
  assert.equal(ex[1].label.includes('丈夫'), false, '男方视角下不许出现「丈夫家族」');
});

test('导出只导当前家族（v0.2.45）：岳家、外家的人不带出去，但配偶本人要留着', () => {
  /* 用户诉求：「导出时能不能只导当前这一张表，我不想别人看到我妻子的家族、
     我母亲的家族」。这里用与上面那条固定三页测试同一份数据，
     三条线（父系 / 母系 / 妻子家族）互不重合，正好能验干净。 */
  const d = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      { id: 'me',    name: '我',     sex: 'M', gen: 1 },
      { id: 'fa',    name: '爸',     sex: 'M', gen: 2 },
      { id: 'fag',   name: '爷爷',   sex: 'M', gen: 3 },
      { id: 'mo',    name: '妈',     sex: 'F', gen: 2 },
      { id: 'mog',   name: '外公',   sex: 'M', gen: 3 },
      { id: 'wife',  name: '妻',     sex: 'F', gen: 1 },
      { id: 'wifef', name: '岳父',   sex: 'M', gen: 2 },
      { id: 'wifem', name: '岳母',   sex: 'F', gen: 2 },
      { id: 'sib',   name: '妹',     sex: 'F', gen: 1 },
      { id: 'kid',   name: '孩子',   sex: 'M', gen: 0 },
    ],
    relationships: [
      { a: 'fa', b: 'me', type: 'parent' }, { a: 'fag', b: 'fa', type: 'parent' },
      { a: 'mo', b: 'me', type: 'parent' }, { a: 'mog', b: 'mo', type: 'parent' },
      { a: 'me', b: 'wife', type: 'spouse' },
      { a: 'wifef', b: 'wife', type: 'parent' }, { a: 'wifem', b: 'wife', type: 'parent' },
      { a: 'fa', b: 'sib', type: 'parent' },
      { a: 'me', b: 'kid', type: 'parent' },
    ],
  }));

  const main = buildMainTree(d, 'me');
  const sub = scopeToTree(d, main);
  const names = sub.people.map((p) => p.name);

  /* 1) 自己这一支在 */
  for (const n of ['我', '爸', '爷爷', '妹', '孩子']) {
    assert.ok(names.includes(n), `自己这一支的「${n}」被漏掉了`);
  }
  /* 2) 配偶本人必须在 —— 夫妻关系断了，这份谱就不成立 */
  assert.ok(names.includes('妻'),
    '配偶本人必须留下：没有她，我这一支和自己的配偶关系就没了');
  assert.ok(sub.relationships.some((r) =>
    r.type === 'spouse' && (r.a === 'wife' || r.b === 'wife')),
  '与配偶的夫妻关系必须保留');
  /* 3) 岳家、外家一律不带出去（这才是这个功能的全部意义） */
  for (const n of ['岳父', '岳母', '妈', '外公']) {
    assert.equal(names.includes(n), false, `「${n}」不该出现在只导当前家族的文件里`);
  }
  assert.ok(sub.people.length < d.people.length, '裁剪后人数应当比全谱少，否则等于没裁');
});

test('只导当前家族：关系表不许留悬空引用，且导入回来不丢人', () => {
  /* 关键在悬空引用：dataset.relationships 是全量的，不按两端过滤的话，
     岳父母那条边会留在文件里，而文件里根本没有岳父母这个人。
     导入时 normalizeDataset 会把它当孤儿静默丢掉 —— 用户看不出发生过什么，
     只会觉得「导进来怎么少了点东西」。这里显式验「两端都在」。 */
  const d = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      { id: 'me', name: '我', sex: 'M', gen: 1 },
      { id: 'fa', name: '爸', sex: 'M', gen: 2 },
      { id: 'wife', name: '妻', sex: 'F', gen: 1 },
      { id: 'wifef', name: '岳父', sex: 'M', gen: 2 },
    ],
    relationships: [
      { a: 'fa', b: 'me', type: 'parent' },
      { a: 'me', b: 'wife', type: 'spouse' },
      { a: 'wifef', b: 'wife', type: 'parent' },
    ],
  }));

  const sub = scopeToTree(d, buildMainTree(d, 'me'));
  const ids = new Set(sub.people.map((p) => p.id));
  const dangling = sub.relationships.filter((r) => !ids.has(r.a) || !ids.has(r.b));
  assert.equal(dangling.length, 0,
    `有 ${dangling.length} 条关系的一端不在文件里：${JSON.stringify(dangling)}`);

  /* 真走一遍导出→导入：serialize 出来再 parse 回去，人数和关系数都要对得上。
     _orphans 是 normalizeDataset 给悬空关系开的登记簿 —— 它必须为空，
     这才是「文件自洽」的硬证明（体检会不会全绿另说，那跟裁剪无关）。 */
  const round = normalizeDataset(JSON.parse(serialize(sub)));
  assert.equal(round.people.length, sub.people.length, '导入回来人数变了');
  assert.equal(round.relationships.length, sub.relationships.length, '导入回来关系数变了');
  assert.equal(round._orphans.length, 0,
    `导出文件里有悬空关系：${JSON.stringify(round._orphans)}`);
});

test('只导当前家族：视角人不在本树里要退回锚点，原 dataset 一个字节都不能动', () => {
  /* 两个坑：
     ① 视角人「我」可能不在当前那棵树里。viewpoint 沿用原值的话，导出的谱
        导入后族源上溯不到人（buildMainTree 的 rootId 从 viewpoint 出发），
        整棵树是塌的 —— 必须退回本树的锚点。
     ② state.dataset 是内存里的真身，下一次 commit 会整个写回库。
        裁剪必须返回新对象，就地改就等于「只导一份」变成「把库也裁了」。 */
  const d = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      { id: 'me', name: '我', sex: 'M', gen: 1 },
      { id: 'fa', name: '爸', sex: 'M', gen: 2 },
      { id: 'uncle', name: '伯父', sex: 'M', gen: 2 },
    ],
    relationships: [
      { a: 'fa', b: 'me', type: 'parent' },
      { a: 'fa', b: 'uncle', type: 'parent' },
    ],
  }));
  const snapshot = JSON.stringify(d);

  /* 只裁伯父这一支（他还没录孩子）：本树里没有视角人「我」 */
  const sub = scopeToTree(d, buildFamilyTree(d, {
    rootId: 'uncle', anchorId: 'uncle', key: 'x',
  }));
  assert.equal(sub.people.length, 1, '这棵树应当只有伯父一人');
  assert.equal(sub.viewpoint, 'uncle',
    `视角人不在本树里时应退回锚点「伯父」，实际「${sub.viewpoint}」`);

  assert.equal(JSON.stringify(d), snapshot,
    'scopeToTree 改了原数据集 —— 它必须是纯函数，否则下一次 commit 会把裁过的数据写回库');
});

test('多树布局：每棵树都满足硬约束', () => {
  const expandable = detectExpandableFamilies(ds, mainTree);
  const all = layoutAllTrees(ds, mainTree, expandable, buildFamilyTree);
  const bad = [];
  for (const [key, lay] of Object.entries(all)) {
    const v = verifyLayout(lay.tree, lay);
    if (v.issues.length) bad.push(`${key}: ${v.issues.join(' | ')}`);
  }
  assert.equal(bad.length, 0, '多树布局问题：\n  ' + bad.join('\n  '));
});

test('锚点对齐：切换家族时，妻子在两张图里 x 不跳', () => {
  const expandable = detectExpandableFamilies(ds, mainTree);
  const all = layoutAllTrees(ds, mainTree, expandable, buildFamilyTree);
  const wifeTree = all['natal_p_wife'];
  if (!wifeTree) return; // 没这张树就跳过（不算失败）
  const xInMain = mainLayout.pos.p_wife.x;
  const xInWifeTree = wifeTree.pos.p_wife.x;
  assert.ok(Math.abs(xInMain - xInWifeTree) < 0.5,
    `妻子 x 从 ${xInMain} 跳到 ${xInWifeTree}`);
});

test('findLineageRoot 沿父系上溯到族源', () => {
  assert.equal(findLineageRoot(idx, 'p_me'), 'p_g1');
  assert.equal(findLineageRoot(idx, 'p_wife'), 'p_wg');
  assert.equal(findLineageRoot(idx, 'p_m'), 'p_mg');
});

/* ========================================================= */
/* 4. 称谓推导                                                 */
/* ========================================================= */

group('4. 称谓推导');

/**
 * 断言目标人的称谓。
 * @param {string} id 目标人
 * @param {string} expected 期望的本地叫法（dialect）
 */
function expectKin(id, expected) {
  const k = deriveKinship(ds, idx, 'p_me', id);
  assert.equal(k.dialect, expected,
    `${nameOf(id)}：期望「${expected}」，实际「${k.dialect}」` +
    `（路径 ${k.symbols.join('-') || '无'}${k.reason ? '，' + k.reason : ''}）`);
  return k;
}

test('本人', () => {
  const k = deriveKinship(ds, idx, 'p_me', 'p_me');
  assert.equal(k.kind, 'self');
  assert.equal(k.dialect, '我');
});

test('直系上行：父母', () => {
  expectKin('p_f', '爸爸');
  expectKin('p_m', '妈妈');
});

test('直系上行：祖辈', () => {
  expectKin('p_p2', '爷爷');
  expectKin('p_p2w', '奶奶');
  expectKin('p_mg', '外公');
  expectKin('p_mgw', '外婆');
});

test('直系上行：曾祖辈', () => {
  expectKin('p_g1', '太爷爷');
  expectKin('p_g1w', '太奶奶');
});

test('直系下行', () => {
  expectKin('p_son', '儿子');
  expectKin('p_nep', '侄子');
});

test('同辈亲兄弟姐妹：只有一个人时直接叫原词（不加「大/二」）', () => {
  expectKin('p_bro', '哥哥');  // 我只有一个哥哥（独哥），叫「哥哥」不叫「大哥」
});

test('亲兄弟姐妹有多个时仍要报数（大哥 / 二哥）', () => {
  const P = (id, name, sex, order, birth) => ({ id, name, sex, order, birth });
  const PARENT = (a, b) => ({ a, b, type: 'parent' });
  const d = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      P('me', '我', 'M', 2, '1992'),
      P('fa', '父亲', 'M', 0, '1960'), P('mo', '母亲', 'F', 0, '1962'),
      P('b1', '大哥', 'M', 0, '1988'),
      P('b2', '二哥', 'M', 1, '1990'),
    ],
    relationships: [
      PARENT('fa', 'me'), PARENT('mo', 'me'),
      PARENT('fa', 'b1'), PARENT('mo', 'b1'),
      PARENT('fa', 'b2'), PARENT('mo', 'b2'),
    ],
  }));
  const i = buildIndex(d);
  assert.equal(deriveKinship(d, i, 'me', 'b1').dialect, '大哥');
  assert.equal(deriveKinship(d, i, 'me', 'b2').dialect, '二哥');
});

test('独弟叫「弟弟」不叫「二弟」，独姐叫「姐姐」不叫「大姐」', () => {
  const P = (id, name, sex, order, birth) => ({ id, name, sex, order, birth });
  const PARENT = (a, b) => ({ a, b, type: 'parent' });
  const d = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      P('me', '我', 'M', 0, '1990'),
      P('fa', '父亲', 'M', 0, '1960'), P('mo', '母亲', 'F', 0, '1962'),
      P('d1', '弟弟', 'M', 1, '1995'),
      P('s1', '姐姐', 'F', 0, '1988'),
    ],
    relationships: [
      PARENT('fa', 'me'), PARENT('mo', 'me'),
      PARENT('fa', 'd1'), PARENT('mo', 'd1'),
      PARENT('fa', 's1'), PARENT('mo', 's1'),
    ],
  }));
  const i = buildIndex(d);
  assert.equal(deriveKinship(d, i, 'me', 'd1').dialect, '弟弟');
  assert.equal(deriveKinship(d, i, 'me', 's1').dialect, '姐姐');
});

test('平辈兄弟姐妹：按称呼类型分组，该类型只有一人就不报数', () => {
  /* 用户 2026-10-11 定稿（当天改过三次，这是最终口径）：
     **按「称呼类型」分组数 —— 哥/姐侧（排我前面）与弟/妹侧（排我后面）分开算，
       某一侧只有一位就不报数。**
     ⚠️ 三轮修订的教训，别再改回去：
       ① 「最年幼的不带数字」—— 四兄弟时顺，一遇「我老三 + 两个姐姐」就崩
          （最小那个姐姐被叫「姐姐」，跟「大姐」根本分不清）。
       ② 「同性别 ≥2 全报数」—— 长幼两个方向混在一起数，于是四兄弟的老四
          从「弟弟」变成「四弟」（只比我小一岁，很生分）。
       ③ 现在：分组数，上面两个例子同时成立。 */
  const P = (id, name, sex, order, birth) => ({ id, name, sex, order, birth });
  const PARENT = (a, b) => ({ a, b, type: 'parent' });
  const mk = (people, rels, myOrder = 2) => withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [P('me', '我', 'M', myOrder, '1992'),
      P('fa', '父亲', 'M', 0, '1960'), P('mo', '母亲', 'F', 0, '1962'), ...people],
    relationships: [PARENT('fa', 'me'), PARENT('mo', 'me'), ...rels],
  }));
  const call = (d, id) => deriveKinship(d, buildIndex(d), 'me', id).dialect;

  /* 场景 A：我老三，上面两个姐姐 → 姐侧有 2 位，必须报数才能区分 */
  const dSis = mk(
    [P('s1', '大姐', 'F', 0, '1988'), P('s2', '二姐', 'F', 1, '1990')],
    [PARENT('fa', 's1'), PARENT('mo', 's1'), PARENT('fa', 's2'), PARENT('mo', 's2')],
  );
  assert.equal(call(dSis, 's1'), '大姐');
  assert.equal(call(dSis, 's2'), '二姐',
    '有两个姐姐时连最小的也要报数 —— 否则叫不清是谁');

  /* 场景 B：四兄弟，我老三 → 哥侧 2 位报数；弟侧只有老四 1 位 → 不报数 */
  const d4 = mk(
    [P('b1', '大哥', 'M', 0, '1988'), P('b2', '二哥', 'M', 1, '1990'), P('b4', '老四', 'M', 3, '1993')],
    [PARENT('fa', 'b1'), PARENT('mo', 'b1'), PARENT('fa', 'b2'), PARENT('mo', 'b2'),
      PARENT('fa', 'b4'), PARENT('mo', 'b4')],
  );
  assert.equal(call(d4, 'b1'), '大哥', '哥侧有 2 位 → 报数');
  assert.equal(call(d4, 'b2'), '二哥', '哥侧有 2 位 → 报数');
  assert.equal(call(d4, 'b4'), '弟弟',
    '弟侧只有老四一位 → 不报数。他只比我小一岁，报「四弟」生分');

  /* 场景 C：我老大，下面三个弟弟 → 弟侧 3 位，整侧报数。
     ⚠️ birth 必须与 order 一致（我 1992 年生，三个弟弟都比我晚），
     否则长幼判定会跟排行打架 —— 引擎按 birth 判哥姐、按 order 报数。 */
  const dTop = mk(
    [P('b2', '老二', 'M', 1, '1995'), P('b3', '老三', 'M', 2, '1997'), P('b4', '老四', 'M', 3, '1999')],
    [PARENT('fa', 'b2'), PARENT('mo', 'b2'), PARENT('fa', 'b3'), PARENT('mo', 'b3'),
      PARENT('fa', 'b4'), PARENT('mo', 'b4')],
    0,
  );
  assert.equal(call(dTop, 'b2'), '二弟');
  assert.equal(call(dTop, 'b3'), '三弟');
  assert.equal(call(dTop, 'b4'), '四弟', '弟侧有 3 位 → 末位也报数');

  /* 场景 D：两侧各只有一位 → 两边都不报数 */
  const dMix = mk(
    [P('b1', '大哥', 'M', 0, '1988'), P('s1', '小妹', 'F', 3, '1998')],
    [PARENT('fa', 'b1'), PARENT('mo', 'b1'), PARENT('fa', 's1'), PARENT('mo', 's1')],
    2,
  );
  assert.equal(call(dMix, 'b1'), '哥哥', '哥侧只有一位 → 不报数');
  assert.equal(call(dMix, 's1'), '妹妹', '妹侧只有一位 → 不报数');

  /* 排行按家族大排，不因「谁在看我」重排 */
  const asYoungest = buildIndex(withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'b4', people: d4.people, relationships: d4.relationships,
  })));
  assert.equal(deriveKinship(d4, asYoungest, 'b4', 'me').dialect, '三哥');
  assert.equal(deriveKinship(d4, asYoungest, 'b4', 'b2').dialect, '二哥');
});

test('父系旁支：伯叔姑按长幼区分，并带排行', () => {
  expectKin('p_gu', '大姑');    // 1960 < 父亲 1963 → 年长；家中长女
  /* 爷爷三个孩子：p_gu(长女) / p_f(次子) / p_unc(幼子)。
     排行只数儿子（含父亲本人）—— 父亲是爷爷的次子。
     p_unc 1968 比父亲 1963 小，且是「比我爸小的那些叔叔」里最年幼的一个
     → 小化叫「小叔」，不按 order 报成「二叔」。 */
  expectKin('p_unc', '小叔');
});

test('父系旁支的配偶：排行跟丈夫走，不跟她自己', () => {
  expectKin('p_aunt', '婶');    // 丈夫小化成小叔，她跟着叫「婶」，不加小、不报排行
  expectKin('p_guf', '姑父');
});

test('堂亲：林浩 1995 年生，比「我」小 → 必须是堂弟而非堂哥', () => {
  const k = expectKin('p_cous', '堂弟');
  assert.equal(k.genDelta, 0);
});

test('祖父辈旁支：二爷爷 —— 路径 F F B（爷爷的兄弟），排行由他自己算', () => {
  const k = expectKin('p_p2s', '二爷爷');
  assert.equal(k.std, '叔祖父');
  assert.equal(k.genDelta, 2, '爷爷的兄弟是祖辈（第 2 代）');
  assert.deepEqual(k.symbols, ['F', 'F', 'B']);
});

test('二奶奶：排行跟丈夫（二爷爷）走', () => {
  expectKin('p_p2sw', '二奶奶');
});

test('堂叔：二爷爷的儿子是我父辈的堂亲', () => {
  const k = expectKin('p_p2ss', '堂叔');
  assert.equal(k.genDelta, 1);
  assert.deepEqual(k.symbols, ['F', 'F', 'B', 'S']);
});

test('母系旁支：舅姨带排行，且**舅和姨各排各的**', () => {
  /* 外公家三个孩子：p_mun(舅, order 0) / p_m(妈, order 1) / p_myi(姨, order 2)。
     拿 order 直接当排行，姨妈就是「幺姨」—— 现实里没人这么叫。
     舅和姨分开排：舅舅那边「大舅」，姨妈那边「大姨」。 */
  expectKin('p_mun', '大舅');    // 兄弟里的长子
  expectKin('p_munw', '大妗子'); // 舅妈按南阳口径叫「妗子」（2026-10-10）
  expectKin('p_myi', '小姨');    // 妈妈只有一个妹妹，1970 比妈妈小 → 小化
  expectKin('p_myif', '姨夫');   // 妻子小化，他跟着叫「姨夫」，不加小、不报排行
});

test('🔴 排行只在同一性别里数（舅不占姨的序号，反之亦然）', () => {
  /* 造一个「三舅两姨」的母系家庭（外公外婆六个孩子，兄弟交错）：
     order 0 大舅 / 1 妈 / 2 大姨 / 3 二舅 / 4 二姨 / 5 三舅
    分开排的结果必须是 舅舅那边 大舅/四舅/六舅（男性直取，断号照报）、
    姨妈那边 二姨/三姨（妈妈 order 1 占着她那格，兄弟不占女儿的号），
    绝不能出现「五姨」这种把舅舅（和全家兄弟）的号算进去的排行。 */
  const mk = (people, rels) => {
    const d = withResolvedGen(normalizeDataset({ people, relationships: rels }));
    return { d, i: buildIndex(d) };
  };
  const P = (id, name, sex, order) => ({ id, name, sex, order });
  const sibs = ['u1', 'mo', 'y1', 'u2', 'y2', 'u3'];
  const { d, i } = mk(
    [
      P('me', '我', 'M', 0),
      P('mo', '妈', 'F', 1),
      P('mg', '外公', 'M', 0), P('mgw', '外婆', 'F', 0),
      P('u1', '大舅', 'M', 0),
      P('y1', '大姨', 'F', 2),
      P('u2', '二舅', 'M', 3), P('y2', '二姨', 'F', 4),
      P('u3', '三舅', 'M', 5),
    ],
    [
      ...sibs.flatMap((c) => [
        { a: 'mg', b: c, type: 'parent' }, { a: 'mgw', b: c, type: 'parent' },
      ]),
      { a: 'mo', b: 'me', type: 'parent' },
    ]
  );
  assert.equal(d._orphans.length, 0, '测试数据不该有悬空关系');

  const cases = [
    /* 男性走直取：大舅 order 0 → 大舅；二舅 order 3 → 四舅（前面隔着妈和大姨）；
       三舅 order 5 → 六舅。⚠️ 2026-10-11 用户接受这个代价：
       男性排行改成「所见即所得」，夹在中间的姐妹不再帮他让位。 */
    ['u1', '大舅'], ['u2', '四舅'],
    /* u3 order 5 是妈妈同胞里最大的那个 → 小化，小舅盖住六舅（2026-10-15：
       小化只看排行，候选池是爸妈的全体同胞，不限性别） */
    ['u3', '小舅'],
    /* 女性走同性别重数，**妈妈本人留在序列里占号**（2026-10-15 用户定）：
       妈妈 order 1 → 她是外婆家的二女儿 → 大姨 order 2 是三姨 → 二姨，
       二姨 order 4 是四姨 → 三姨。兄弟（u1/u2/u3）不占女儿的号。 */
    ['y1', '二姨'], ['y2', '三姨'],
  ];
  for (const [id, want] of cases) {
    const k = deriveKinship(d, i, 'me', id);
    assert.deepEqual(k.symbols, ['M', id.startsWith('y') ? 'Z' : 'B'], `${id} 路径`);
    assert.equal(k.dialect, want, `${id} 应叫「${want}」，实际「${k.dialect}」`);
    /* 只查「姨」：男性按填的号直取，跳号是允许的；
       女性的号必须连续（不能出现四姨五姨），否则就是把兄弟或全家的号算进去了。 */
    assert.ok(!/[四五六七八九]姨/.test(k.dialect),
      `不该出现跨性别排行「${k.dialect}」`);
  }
});

test('🔴 妈妈参与排行：她是长女时，妹妹们叫二姨 / 三姨 / 小姨', () => {
  /* 2026-10-15 用户定（这条推翻了 2026-10-11「妈妈占的那个号不该让姨妈跟着跳」）：
     排行 = 这个人在祖辈女儿序列里的序位，**妈妈自己占一格** ——
     她是长女，序列里就没人是大姨，她的三个妹妹依次是二姨、三姨、小姨。
     ⚠️ 过去 `M Z` 会把妈妈从序列里剔掉，序位整体前移一位，于是叫成大姨 / 二姨；
     而且排行随视角漂移（同一房的两个人在各自孩子那边都成了大姨）。
     附带好处：排行与视角无关了 —— 二姨的孩子看妈妈，序位0 → 大姨，一致。 */
  const P = (id, name, sex, order) => ({ id, name, sex, order });
  const PARENT = (a, b) => ({ a, b, type: 'parent' });
  const kids = ['mo', 'y1', 'y2', 'y3'];
  const d = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      P('me', '我', 'M', 0), P('fa', '爸', 'M', 0),
      P('mg', '外公', 'M', 0), P('mgw', '外婆', 'F', 0),
      P('mo', '妈', 'F', 0), P('y1', '二姨', 'F', 1),
      P('y2', '三姨', 'F', 2), P('y3', '小姨', 'F', 3),
      /* 二姨的孩子（小表），用来验证视角无关 */
      P('n1', '表妹', 'F', 0),
    ],
    relationships: [
      ...kids.flatMap((c) => [PARENT('mg', c), PARENT('mgw', c)]),
      PARENT('fa', 'me'), PARENT('mo', 'me'),
      PARENT('y1', 'n1'),
    ],
  }));
  const i = buildIndex(d);
  assert.equal(d._orphans.length, 0, '测试数据不该有悬空关系');

  assert.equal(deriveKinship(d, i, 'me', 'mo').dialect, '妈妈', '妈妈还是妈妈');
  assert.equal(deriveKinship(d, i, 'me', 'y1').dialect, '二姨', '长女的妹妹叫二姨');
  assert.equal(deriveKinship(d, i, 'me', 'y2').dialect, '三姨', '老二的妹妹叫三姨');
  assert.equal(deriveKinship(d, i, 'me', 'y3').dialect, '小姨',
    '最小的妹妹既是序位 3、又是全家最小 → 小化盖住排行');

  /* 视角无关：从二姨的孩子那边看，妈妈序位 0 → 大姨，其余两个序号不变 */
  assert.equal(deriveKinship(d, i, 'n1', 'mo').dialect, '大姨', '妈妈在妹妹那边是大姨');
  assert.equal(deriveKinship(d, i, 'n1', 'y2').dialect, '三姨', '同一个人在两边的排行一致');
  assert.equal(deriveKinship(d, i, 'n1', 'y3').dialect, '小姨', '最小的那个两边都叫小姨');
});

test('🔴 男性排行「所见即所得」，断号照报；女性走同性别重数且妈妈占号', () => {
  /* 2026-10-11 用户定：
     ① **男性**排行直接用他填的 order —— 填 2 就是父母子女里的第 3 位 → 三爷爷。
        中间断号（兄弟没录全，号空着）也如实跳号，不替他猜。
     ② **女性**走同性别重数。⚠️ 2026-10-15 用户改了 ② 的一半：
        妈妈**不再让号** —— 她是外婆家的女儿，占着自己那一格，
        妈妈排行 1 时，排行 2 的妹妹叫「三姨」而不是「二姨」。
     ⚠️ ① 推翻了 2026-10-10 的「舅和姨各排各的」对男性那一半；
        女性那一半改由上面「妈妈参与排行」那条用例盯住。 */
  const P = (id, name, sex, order, birth) =>
    (birth ? { id, name, sex, order, birth } : { id, name, sex, order });
  const PARENT = (a, b) => ({ a, b, type: 'parent' });

  /* —— 父系：太爷爷 6 个儿子，排行 0(爷爷) / 0 / 1 / 3 / 4 / 6
        （排行 2 和 5 那两个兄弟没录，号空着） —— */
  const uncles = ['u1', 'u2', 'u3', 'u4', 'u5'];
  const d1 = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      P('me', '我', 'M', 0), P('fa', '爸', 'M', 1), P('mo', '妈', 'F', 1),
      P('gff', '太爷爷', 'M', 0), P('gffw', '太奶奶', 'F', 0),
      P('gf', '爷爷', 'M', 0, '1930'), P('gmw', '奶奶', 'F', 0, '1932'),
      P('u1', '大爷爷', 'M', 0, '1935'), P('u2', '二爷爷', 'M', 1, '1938'),
      P('u3', '三爷爷', 'M', 3, '1942'), P('u4', '四爷爷', 'M', 4, '1945'),
      P('u5', '五爷爷', 'M', 6, '1948'),
    ],
    relationships: [
      ...uncles.flatMap((c) => [PARENT('gff', c), PARENT('gffw', c)]),
      PARENT('gff', 'gf'), PARENT('gffw', 'gf'),     // 爷爷也是太爷爷的儿子
      PARENT('gf', 'fa'), PARENT('gmw', 'fa'),       // 爸爸是爷爷的儿子 → F F B 才走得通
      PARENT('fa', 'me'), PARENT('mo', 'me'),
    ],
  }));
  const i1 = buildIndex(d1);
  assert.equal(d1._orphans.length, 0, '测试数据不该有悬空关系');
  for (const [id, want] of [
    ['u1', '大爷爷'], ['u2', '二爷爷'],
    ['u3', '四爷爷'],   // order 3 → 第四位，2 号那个兄弟没录，如实跳号
    ['u4', '五爷爷'],
    ['u5', '七爷爷'],   // order 6 → 第七位
  ]) {
    assert.equal(deriveKinship(d1, i1, 'me', id).dialect, want,
      `排行断号时 ${id} 应叫「${want}」`);
  }

  /* —— 母系：外祖父母 4 个孩子全是女性，排行 0 / 1(妈妈) / 2 / 3 —— */
  const kids = ['y1', 'mo', 'y2', 'y3'];
  const d2 = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      P('me', '我', 'M', 0), P('fa', '爸', 'M', 1),
      P('mg', '外公', 'M', 0), P('mgw', '外婆', 'F', 0),
      P('y1', '大姨', 'F', 0), P('mo', '妈', 'F', 1),
      P('y2', '二姨', 'F', 2), P('y3', '三姨', 'F', 3),
    ],
    relationships: [
      ...kids.flatMap((c) => [PARENT('mg', c), PARENT('mgw', c)]),
      PARENT('mg', 'mo'), PARENT('mgw', 'mo'),     // 妈妈是外公外婆的女儿，否则 M Z 走不通
      PARENT('fa', 'me'), PARENT('mo', 'me'),
    ],
  }));
  const i2 = buildIndex(d2);
  assert.equal(d2._orphans.length, 0, '测试数据不该有悬空关系');
  for (const [id, want] of [
    /* 妈妈排行 1 → 她是二女儿 → 占一格：y1(0) 大姨、y2(2) 三姨、y3(3) 小姨。
       ⚠️ y3 是这一家最小的那个（排行 3）→ 小化盖住四姨（2026-10-15：
       小化只看排行，候选池是爸妈的全体同胞）。 */
    ['y1', '大姨'], ['y2', '三姨'], ['y3', '小姨'],
  ]) {
    assert.equal(deriveKinship(d2, i2, 'me', id).dialect, want,
      `女性按同性别重数且妈妈占号，${id} 应叫「${want}」`);
  }
  assert.equal(deriveKinship(d2, i2, 'me', 'mo').dialect, '妈妈',
    '妈妈不是自己的姨妈');
});

test('🔴 排行只报数，不设「幺」（排第几就叫几）', () => {
  /* 2026-10-10 用户定：「不要幺舅，排第几就是几」。
     过去三兄弟以上最小的那个会被叫成「幺叔 / 幺姑 / 幺舅」——
     听的人还得再数一遍才知道这个幺排第几，不如直接报数。 */
  const rule = { path: 'M B', dialect: '舅舅', rankBase: '舅' };
  const cases = [
    [0, '大舅'], [1, '二舅'], [2, '三舅'], [8, '九舅'], [9, '十舅'],
    [10, '十一舅'], [11, '十二舅'], [19, '二十舅'], [20, '二十一舅'], [98, '九十九舅'],
  ];
  for (const [order, want] of cases) {
    assert.equal(withRank(rule, order), want, `排行第 ${order + 1} 应叫「${want}」`);
  }
  /* 排不出来（第 100 位 / 没填 order）→ 原样退回不带排行的说法，宁可不排也不瞎排 */
  assert.equal(withRank(rule, 99), '舅舅');
  assert.equal(withRank(rule, -1), '舅舅');
  assert.equal(withRank(rule, null), '舅舅');
  /* 长幼变体同样走报数：最小的叔叔是「三叔」，不是「幺叔」 */
  const uncle = { path: 'F B', dialect: '叔叔', rankBase: '叔' };
  assert.equal(withRank(uncle, 2), '三叔');
  /* 词根自带称呼的规则（伯娘 / 姑婆 / 太爷）照旧直接拼 */
  assert.equal(withRank({ path: 'F B W', dialect: '伯娘', rankBase: '伯娘' }, 1), '二伯娘');
});

/* 造一个「长辈足够多」的家族，用来测排行与小化判定 */
function buildWideFamily(extra = {}) {
  const P = (id, name, sex, order, birth) =>
    ({ id, name, sex, order, ...(birth ? { birth } : {}), ...extra[id] });
  const PARENT = (a, b) => ({ a, b, type: 'parent' });
  const SPOUSE = (a, b) => ({ a, b, type: 'spouse' });

  /* 爷爷四个儿子四个女儿；外公八个孩子舅姨交错，妈妈排中间 */
  const gfKids = ['fbo', 'fa', 'f2', 'f3', 'f4', 'g1', 'g2', 'g3', 'g4'];
  const mgKids = ['u1', 'mo', 'u2', 'y1', 'u3', 'y2', 'u4', 'y3', 'y4', 'u5'];

  const d = withResolvedGen(normalizeDataset({
    version: '1.0',
    viewpoint: 'me',
    people: [
      P('me', '我', 'M', 0, '1992'),
      P('fa', '父亲', 'M', 1, '1963'), P('mo', '母亲', 'F', 1, '1965'),
      P('gf', '爷爷', 'M', 0, '1938'), P('gmw', '奶奶', 'F', 0, '1940'),
      P('fbo', '大伯', 'M', 0, '1955'), P('f2', '二叔', 'M', 2, '1966'),
      P('f3', '三叔', 'M', 3, '1970'), P('f4', '四叔', 'M', 4, '1978'),
      P('f4w', '四婶', 'F', 0, '1980'),
      P('g1', '大姑', 'F', 5, '1960'), P('g2', '二姑', 'F', 6, '1962'),
      P('g3', '三姑', 'F', 7, '1965'), P('g4', '四姑', 'F', 8, '1972'),
      P('mg', '外公', 'M', 0, '1935'), P('mgw', '外婆', 'F', 0, '1937'),
      P('u1', '大舅', 'M', 0, '1950'), P('u2', '二舅', 'M', 2, '1958'),
      P('u3', '三舅', 'M', 4, '1962'), P('u4', '四舅', 'M', 6, '1970'),
      P('u4w', '妗子', 'F', 0, '1972'),
      P('y1', '大姨', 'F', 3, '1960'), P('y2', '二姨', 'F', 5, '1964'),
      P('y3', '三姨', 'F', 7, '1966'), P('y4', '四姨', 'F', 8, '1972'),
      P('y4h', '姨夫', 'M', 0, '1970'),
      P('u5', '五舅', 'M', 9),   // 故意不给出生年 → 只能照报排行，不许瞎叫小
    ],
    relationships: [
      ...gfKids.flatMap((c) => [PARENT('gf', c), PARENT('gmw', c)]),
      ...mgKids.flatMap((c) => [PARENT('mg', c), PARENT('mgw', c)]),
      PARENT('fa', 'me'), PARENT('mo', 'me'),
      SPOUSE('f4', 'f4w'), SPOUSE('u4', 'u4w'), SPOUSE('y4', 'y4h'),
    ],
  }));
  const i = buildIndex(d);
  assert.equal(d._orphans.length, 0, '测试数据不该有悬空关系');
  return { d, i, call: (id) => deriveKinship(d, i, 'me', id).dialect };
}

test('🔴 比我爸妈小的那批长辈里，最年幼的那一个 → 叫「小X」（小叔 / 小姑 / 小舅 / 小姨）', () => {
  /* 2026-10-10 用户定（河南南阳口径）：比我爸妈小的那些同辈长辈里，
     **最年幼的那一个**叫「小舅」而不是「四舅」；只要他后面还有更小的，
     「小」就轮不到他。⚠️ 没有「第几位」的门槛 —— 排行第几位是结果不是条件。
     配偶跟着叫「婶 / 妗子 / 姨夫」—— 不加「小」，也不报排行。
     ⚠️ 2026-10-15 用户又定了两点：
        ① 「小」只看**排行**，出生年不再参与（修家谱的人知道排行不知道年龄）；
        ② 候选池是爸妈的**全体同胞、不限性别** —— 叔姑抢同一个「小」，
           所以这一家里叫「小姑」就不会同时有「小叔」，姨也不跟舅抢。 */
  const { call } = buildWideFamily();

  /* 爸爸那边：爷爷家最小的孩子是四姑(order 8) → 「小」归她，三位叔照报排行 */
  assert.equal(call('fbo'), '大伯');
  assert.equal(call('f2'), '三叔');   // 排行把父亲本人算进去，所以爷爷的次子叫三叔
  assert.equal(call('f3'), '四叔', '他后面还有更小的辈分长者，「小」轮不到他');
  assert.equal(call('f4'), '五叔', 'order 4 直取；最小的是四姑，不是他');
  assert.equal(call('f4w'), '五婶', '四叔没被小化 → 配偶照报排行（与小叔的「婶」相对）');

  /* 妈妈那边同理：小舅 → 妗子，小姨 → 姨夫。
     ⚠️ 2026-10-11 起男性排行走「直取」：order 填 2 就是第 3 位 → 三舅，
        夹在中间的姐妹和妈妈不再让位（母系：u1(0) mo(1) u2(2) y1(3) u3(4) y2(5) …）。
     ⚠️ 2026-10-15 起女性排行里**妈妈占号**（妈妈 order 1 → 她是二女儿），
        姨妈从二姨起排；「小」归这一家最小的 u5(order 9)，所以姨们一个都不叫小。 */
  assert.equal(call('u1'), '大舅');
  assert.equal(call('u2'), '三舅', 'order 2 → 第三位');
  assert.equal(call('u3'), '五舅', 'order 4 → 第五位');
  assert.equal(call('u4'), '七舅', 'order 6 → 第七位；后面还有 y3/y4/u5 更小');
  assert.equal(call('u4w'), '七妗子', '四舅没被小化 → 妗子照报排行（与小舅的「妗子」相对）');
  assert.equal(call('y1'), '二姨', '妈妈占一号：y1(3) 在女儿序列里排第 2');
  assert.equal(call('y4'), '五姨', '序位 4 → 五姨；全家最小是 u5，「小」轮不到她');
  assert.equal(call('y4h'), '五姨夫', '四姨没被小化 → 姨夫照报排行（与小姨的「姨夫」相对）');

  /* 姑姑那边：四姑最年幼，且比我爸小 → 小姑；爸爸是儿子，占不了女儿的号，
     所以姑姑序位不受影响，三姑仍是三姑 */
  assert.equal(call('g4'), '小姑');
  assert.equal(call('g3'), '三姑');

  /* 「小」只看排行，没有出生年照样叫得出来 —— 过去这条是「十舅」 */
  assert.equal(call('u5'), '小舅', 'order 9 是妈妈同胞里最大的 → 小化盖住十舅');
});

test('🔴 岳家那边同口径：岳母占号、最小的那个叫小姨', () => {
  /* 2026-10-15 用户定「叔姑侧和岳家侧一起」：妻子的姨妈（`W M Z`）
     与妈妈的姨妈（M Z）同一套口径 ——
     ① 排行序位里**岳母占一格**（岳母 order 0 → 大姨 order 1 → 二姨）；
     ② 「小」化候选池是**岳母的全体同胞**（含岳母本人，不限性别）。
     ⚠️ 过去这里拿 `nodes[1]`（= 妻子）当参照人比年龄，岳家这条路整个是错的。 */
  const P = (id, name, sex, order) => ({ id, name, sex, order });
  const PARENT = (a, b) => ({ a, b, type: 'parent' });
  const SPOUSE = (a, b) => ({ a, b, type: 'spouse' });
  const wk = ['wmo', 'wy1', 'wy2', 'wy3'];
  const d = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      P('me', '我', 'M', 0), P('wife', '妻', 'F', 0),
      P('wgf', '岳父', 'M', 0), P('wgw', '岳母', 'F', 0),
      P('wmo', '妻妈', 'F', 0), P('wy1', '妻大姨', 'F', 1),
      P('wy2', '妻二姨', 'F', 2), P('wy3', '妻小姨', 'F', 3),
    ],
    relationships: [
      SPOUSE('me', 'wife'),
      ...wk.flatMap((c) => [PARENT('wgf', c), PARENT('wgw', c)]),
      PARENT('wmo', 'wife'),
    ],
  }));
  const i = buildIndex(d);
  assert.equal(d._orphans.length, 0, '测试数据不该有悬空关系');

  assert.equal(deriveKinship(d, i, 'me', 'wmo').dialect, '岳母', '岳母还是岳母');
  assert.equal(deriveKinship(d, i, 'me', 'wy1').dialect, '二姨', '岳母占一号 → 大姨是二姨');
  assert.equal(deriveKinship(d, i, 'me', 'wy2').dialect, '三姨', '往后顺延');
  assert.equal(deriveKinship(d, i, 'me', 'wy3').dialect, '小姨',
    '最小的那位 → 小化盖住四姨');
});

test('🔴 爸爸占不了女儿的号；两家的「小」各算各的', () => {
  /* ① `F Z` / `H F Z`：爸爸、公公都是**儿子**，进不了女儿的序列 ——
        爸爸是爷爷家的次子时，两个姑姑仍叫大姑 / 小姑，不因为多了个儿子就跳号。
     ② 跨家庭不入池：奶奶家的「小」和外公家的「小」互不干扰 ——
        爷爷家最小的孩子是姑姑 → 小姑；外公家最小的孩子是舅舅 → 小舅。 */
  const P = (id, name, sex, order) => ({ id, name, sex, order });
  const PARENT = (a, b) => ({ a, b, type: 'parent' });
  const SPOUSE = (a, b) => ({ a, b, type: 'spouse' });

  /* —— 爷爷家：四个孩子，次子是我爸，两个姑姑 —— */
  const gfKids = ['gf2', 'fa', 'g1', 'g2'];
  /* —— 外公家：三个孩子，长女是我妈，两个舅舅 —— */
  const mgKids = ['mo', 'u1', 'u2'];
  const d = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      P('me', '我', 'M', 0), P('fa', '爸', 'M', 1), P('mo', '妈', 'F', 0),
      P('gff', '爷爷', 'M', 0), P('gfw', '奶奶', 'F', 0),
      P('gf2', '大爷', 'M', 0), P('g1', '大姑', 'F', 2), P('g2', '小姑', 'F', 3),
      P('mgf', '外公', 'M', 0), P('mgw', '外婆', 'F', 0),
      P('mo', '妈', 'F', 0), P('u1', '大舅', 'M', 1), P('u2', '小舅', 'M', 2),
    ],
    relationships: [
      ...gfKids.flatMap((c) => [PARENT('gff', c), PARENT('gfw', c)]),
      ...mgKids.flatMap((c) => [PARENT('mgf', c), PARENT('mgw', c)]),
      PARENT('fa', 'me'), PARENT('mo', 'me'),
    ],
  }));
  const i = buildIndex(d);
  assert.equal(d._orphans.length, 0, '测试数据不该有悬空关系');

  /* 爸爸 order 1 是儿子，不占女儿的号 → 姑姑 order 2 仍是「大姑」（否则会变成二姑） */
  assert.equal(deriveKinship(d, i, 'me', 'g1').dialect, '大姑',
    '爸爸是儿子，姑姑序位不受影响');
  assert.equal(deriveKinship(d, i, 'me', 'g2').dialect, '小姑',
    '爷爷家最小的孩子 → 姑姑抢到了「小」');

  /* 两家各算各的：爷爷家的「小」归小姑，外公家的「小」归小舅，互不干扰 */
  assert.equal(deriveKinship(d, i, 'me', 'u2').dialect, '小舅', '外公家最小的是舅舅');
  assert.equal(deriveKinship(d, i, 'me', 'u1').dialect, '二舅', '大舅照报排行（男性直取 order）');
});

test('🔴 排行断号按最后一个算；排行没填就不敢叫小', () => {
  /* 2026-10-15 用户定：
     ① **断号**（order 0 / 2 / 5，兄弟没录全）—— 不猜、不补空号，
        就按记录里**最后一个**（order 5）算，所以他是小叔；
     ② `order` **整格为空**时，谁最小根本判不出来 → 老实照报排行，
        宁可叫「五叔」也不猜一个小叔（延续 2026-10-10 的保守口径）。
     ⚠️ 爷爷家最小的孩子是姑姑时，「小」归她，她丈夫那条规则本来就不报排行 → 姑父。 */
  const P = (id, name, sex, order) => ({ id, name, sex, order });
  const PARENT = (a, b) => ({ a, b, type: 'parent' });
  const SPOUSE = (a, b) => ({ a, b, type: 'spouse' });

  /* —— 断号：爷爷四个孩子，排行 1(爸) / 2 / 5，中间两个兄弟没录 —— */
  const d1 = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      P('me', '我', 'M', 0), P('fa', '爸', 'M', 1), P('mo', '妈', 'F', 0),
      P('gf', '爷爷', 'M', 0), P('gm', '奶奶', 'F', 0),
      P('f2', '二叔', 'M', 2), P('f5', '五叔', 'M', 5),
      P('g3', '三姑', 'F', 3), P('g3h', '姑父', 'M', 0),
    ],
    relationships: [
      ...['fa', 'f2', 'f5', 'g3'].flatMap((c) => [PARENT('gf', c), PARENT('gm', c)]),
      PARENT('fa', 'me'), PARENT('mo', 'me'),
      SPOUSE('g3', 'g3h'),
    ],
  }));
  const i1 = buildIndex(d1);
  assert.equal(d1._orphans.length, 0, '测试数据不该有悬空关系');
  assert.equal(deriveKinship(d1, i1, 'me', 'f2').dialect, '三叔', 'order 2 → 第三位');
  assert.equal(deriveKinship(d1, i1, 'me', 'f5').dialect, '小叔',
    '断号时按记录里最后一个算 → 小叔');
  assert.equal(deriveKinship(d1, i1, 'me', 'g3').dialect, '大姑',
    '姑姑 order 3 不是全家最小（叔 order 5 才是）→ 照报排行，「小」被叔抢走');
  assert.equal(deriveKinship(d1, i1, 'me', 'g3h').dialect, '姑父',
    '姑姑那条规则本来就不报排行，配偶不受影响');

  /* —— 排行一个都没填：判不出谁最小，全体照报排行 —— */
  const d2 = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      P('me', '我', 'M', 0), P('fa', '爸', 'M', 1), P('mo', '妈', 'F', 0),
      P('gf', '爷爷', 'M', 0), P('gm', '奶奶', 'F', 0),
      { id: 'x2', name: '二叔', sex: 'M' }, { id: 'x3', name: '三叔', sex: 'M' },
    ],
    relationships: [
      ...['fa', 'x2', 'x3'].flatMap((c) => [PARENT('gf', c), PARENT('gm', c)]),
      PARENT('fa', 'me'), PARENT('mo', 'me'),
    ],
  }));
  const i2 = buildIndex(d2);
  assert.equal(d2._orphans.length, 0, '测试数据不该有悬空关系');
  /* order 全空 → 排行与小化都判不出来，退回不带排行的叫法。
     ⚠️ 具体落成「伯伯」还是「叔叔」由长幼判定（judgeAge，仍以出生年优先）
     决定，不在本次改动范围内 —— 这里只盯住「不出现小X、不出现数字排行」。 */
  for (const id of ['x2', 'x3']) {
    const got = deriveKinship(d2, i2, 'me', id).dialect;
    assert.ok(!/小/.test(got), `${id} 不该被叫成「${got}」`);
    assert.ok(!/[二三四五]叔/.test(got), `${id} 排不出就不报数，实际「${got}」`);
  }
});

test('🔴 三边对称：妻子的姑姑（W F Z）与丈夫的姑姑（H F Z）同一套口径', () => {
  /* 2026-10-15 用户定「叔姑侧和岳家侧一起」——
     排行与「小」化必须三边一致（自家 F / 随妻家 W / 随夫家 H），
     不许出现「同一户人在妻子那边叫大姑、在丈夫那边叫二姑」。
     两条都验证两件事：
     ① **爸爸/公公是儿子，占不了女儿的号** → 长女仍是大姑，不是二姑；
     ② 「小」化候选池是**参照长辈的全体同胞**（这里最小的是二姑 → 小姑）。 */
  const P = (id, name, sex, order) => ({ id, name, sex, order });
  const PARENT = (a, b) => ({ a, b, type: 'parent' });
  const SPOUSE = (a, b) => ({ a, b, type: 'spouse' });

  /* —— A. 我是丈夫：妻子的姑姑 = 岳父的姐妹（`W F Z`）—— */
  const a1 = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      P('me', '我', 'M', 0), P('wf', '妻', 'F', 0),
      P('gff', '妻爷爷', 'M', 0), P('gfw', '妻奶奶', 'F', 0),
      P('fa', '岳父', 'M', 0), P('g1', '大姑', 'F', 1), P('g2', '二姑', 'F', 2),
    ],
    relationships: [
      SPOUSE('me', 'wf'),
      ...['fa', 'g1', 'g2'].flatMap((c) => [PARENT('gff', c), PARENT('gfw', c)]),
      PARENT('fa', 'wf'),
    ],
  }));
  const ia = buildIndex(a1);
  assert.equal(a1._orphans.length, 0, '测试数据不该有悬空关系');
  assert.equal(deriveKinship(a1, ia, 'me', 'g1').dialect, '大姑',
    '岳父是儿子，长女仍是大姑');
  assert.equal(deriveKinship(a1, ia, 'me', 'g2').dialect, '小姑', '全家最小 → 小姑');

  /* —— B. 我是妻子：丈夫的姑姑 = 公公的姐妹（`H F Z`）—— */
  const b1 = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      P('me', '我', 'F', 0), P('hu', '丈夫', 'M', 0),
      P('hff', '公爷爷', 'M', 0), P('hfw', '公奶奶', 'F', 0),
      P('fa', '公公', 'M', 0), P('g1', '大姑', 'F', 1), P('g2', '二姑', 'F', 2),
    ],
    relationships: [
      SPOUSE('me', 'hu'),
      ...['fa', 'g1', 'g2'].flatMap((c) => [PARENT('hff', c), PARENT('hfw', c)]),
      PARENT('fa', 'hu'),
    ],
  }));
  const ib = buildIndex(b1);
  assert.equal(b1._orphans.length, 0, '测试数据不该有悬空关系');
  assert.equal(deriveKinship(b1, ib, 'me', 'g1').dialect, '大姑',
    '公公是儿子，长女仍是大姑');
  assert.equal(deriveKinship(b1, ib, 'me', 'g2').dialect, '小姑', '全家最小 → 小姑');
});

test('🔴 排行很靠后、但他其实比我爸妈大 → 照报排行，不叫小', () => {
  /* 最容易误判的一种：爷爷五个儿子，父亲排行第五（本人最年幼），
     四叔虽排第四却比父亲还大（数据里 order 跟实际年龄对不上时会这样）。
     这时候绝不能叫「小叔」—— 辈分上他比我爸妈都长，叫小是贬了人家。 */
  const P = (id, name, sex, order, birth) => ({ id, name, sex, order, birth });
  const PARENT = (a, b) => ({ a, b, type: 'parent' });
  const kids = ['f4', 'fbo', 'f2', 'f3', 'fa'];
  const d = withResolvedGen(normalizeDataset({
    version: '1.0',
    viewpoint: 'me',
    people: [
      P('me', '我', 'M', 0, '1980'),
      P('fa', '父亲', 'M', 4, '1955'),
      P('mo', '母亲', 'F', 0, '1957'),
      P('gf', '爷爷', 'M', 0, '1920'), P('gmw', '奶奶', 'F', 0, '1922'),
      /* order 给成了「大伯 - 二叔 - 三叔 - 四叔 - 父亲」，
         但出生年故意让四叔（1945）比大伯（1950）还小、比父亲（1955）还大 */
      P('f4', '四伯', 'M', 3, '1945'), P('fbo', '大伯', 'M', 0, '1950'),
      P('f2', '二伯', 'M', 1, '1948'), P('f3', '三伯', 'M', 2, '1947'),
    ],
    relationships: [
      ...kids.flatMap((c) => [PARENT('gf', c), PARENT('gmw', c)]),
      PARENT('fa', 'me'), PARENT('mo', 'me'),
    ],
  }));
  const i = buildIndex(d);
  assert.equal(d._orphans.length, 0, '测试数据不该有悬空关系');

  const k = deriveKinship(d, i, 'me', 'f4');
  assert.equal(k.dialect, '四伯', `四伯比我爸大，应叫「四伯」，实际「${k.dialect}」`);
});

test('🔴 规则表里不许再出现「幺」（排行只报数）', () => {
  const offenders = RULES
    .filter((r) => [r.dialect, r.rankBase, r.std].some((f) => String(f).includes('幺')))
    .map((r) => `${r.path} → ${r.dialect}`);
  assert.equal(offenders.length, 0,
    '词表里不该再有「幺」系列：\n  ' + offenders.join('\n  '));
});

test('表亲：按出生年判长幼', () => {
  expectKin('p_mbro', '表哥');  // 1988 < 1992
  expectKin('p_msis', '表妹');  // 1995 > 1992
});

test('姻亲一跳：配偶与岳父母', () => {
  expectKin('p_wife', '老婆');
  expectKin('p_wf', '岳父');
  expectKin('p_wm', '岳母');
});

test('姻亲一跳：妻之兄弟姊妹', () => {
  expectKin('p_wu', '大舅子');   // 1987 < 1992
  expectKin('p_wsis', '小姨子'); // 1996 > 1992
});

/* ---------------------------------------------------------
 * 长幼判定的「参照人」—— TC-2026-1009 回归
 *
 * 妻弟/妻兄该拿**妻子**比（同父同母，排行与出生年都可比），
 * 绝不能拿「我」比 —— 跨家庭比 order 是本软件踩过的最坑的一个 bug：
 * 辈分差是 0，旧代码就取 nodes[0] =「我」，结果小舅子被叫成大舅子。
 * ========================================================= */

/** 造「我 + 妻子 + 妻子兄弟」小家庭：全员无出生年，只靠排行 */
function wifeFamily(meOrder, wifeOrder, sibs) {
  return withResolvedGen(normalizeDataset({
    version: '1.0',
    viewpoint: 'me',
    people: [
      { id: 'me',   name: '我',   sex: 'M', order: meOrder },
      { id: 'wife', name: '妻子', sex: 'F', order: wifeOrder },
      { id: 'wf',   name: '岳父', sex: 'M', order: 0 },
      { id: 'wm',   name: '岳母', sex: 'F', order: 0 },
      ...sibs.map((s, i) => ({ id: `s${i}`, name: s.name, sex: s.sex, order: s.order })),
    ],
    relationships: [
      { a: 'me',   b: 'wife', type: 'spouse' },
      { a: 'wf',   b: 'wife', type: 'parent' },
      { a: 'wm',   b: 'wife', type: 'parent' },
      ...sibs.flatMap((_, i) => [
        { a: 'wf', b: `s${i}`, type: 'parent' },
        { a: 'wm', b: `s${i}`, type: 'parent' },
      ]),
    ],
  }));
}

test('TC-2026-1009 妻弟与「妻子」比长幼，不能与我比（小舅子曾被叫成大舅子）', () => {
  /* 我 order=2 · 妻子 order=0 · 妻弟 order=1
     妻弟比妻子小 → 小舅子。
     旧逻辑拿「我」比：1 < 2 → older → 大舅子（错）。 */
  const ds2 = wifeFamily(2, 0, [{ name: '妻弟', sex: 'M', order: 1 }]);
  const k = deriveKinship(ds2, buildIndex(ds2), 'me', 's0');
  assert.deepEqual(k.symbols, ['W', 'B'], '应走 W B 路径');
  assert.equal(k.dialect, '小舅子', `实际「${k.dialect}」`);
  assert.equal(k.age, 'younger');
  assert.equal(k.ageUncertain, false, '排行齐全就不该报「判不出来」');
});

test('TC-2026-1009 排行与我撞车时也能判：妻兄 vs 妻子，不该报「暂按年长」', () => {
  /* 我 order=0 · 妻兄 order=0（撞车）· 妻子 order=1
     妻兄与妻子同父同母 → 排行可比 → older → 大舅子。
     旧逻辑拿「我」比：0 == 0 → 判不出来，UI 只能按「年长」显示。 */
  const ds2 = wifeFamily(0, 1, [{ name: '妻兄', sex: 'M', order: 0 }]);
  const k = deriveKinship(ds2, buildIndex(ds2), 'me', 's0');
  assert.equal(k.dialect, '大舅子', `实际「${k.dialect}」`);
  assert.equal(k.age, 'older');
  assert.equal(k.ageUncertain, false);
});

test('TC-2026-1009 丈夫的兄弟与「丈夫」比长幼（H B，不与我比）', () => {
  const ds2 = withResolvedGen(normalizeDataset({
    version: '1.0',
    viewpoint: 'me',
    people: [
      { id: 'me',  name: '我',   sex: 'F', order: 0 },
      { id: 'hus', name: '丈夫', sex: 'M', order: 1 },
      { id: 'br',  name: '大伯', sex: 'M', order: 0 }, // 丈夫的哥哥
      { id: 'hf',  name: '公公', sex: 'M', order: 0 },
      { id: 'hm',  name: '婆婆', sex: 'F', order: 0 },
    ],
    relationships: [
      { a: 'me',  b: 'hus', type: 'spouse' },
      { a: 'hf',  b: 'hus', type: 'parent' },
      { a: 'hm',  b: 'hus', type: 'parent' },
      { a: 'hf',  b: 'br',  type: 'parent' },
      { a: 'hm',  b: 'br',  type: 'parent' },
    ],
  }));
  const k = deriveKinship(ds2, buildIndex(ds2), 'me', 'br');
  assert.deepEqual(k.symbols, ['H', 'B'], '应走 H B 路径');
  assert.equal(k.dialect, '大伯子', `实际「${k.dialect}」`);
  assert.equal(k.ageUncertain, false);
});

test('TC-2026-1009 跨家庭不猜：堂兄弟无出生年时不用 order 硬分长幼', () => {
  /* 堂兄弟不同父母，order 只在自己家有效 —— 比出来必错。
     宁可判不出来让用户补出生年，也不能瞎叫。 */
  const ds2 = withResolvedGen(normalizeDataset({
    version: '1.0',
    viewpoint: 'me',
    people: [
      { id: 'me',   name: '我',     sex: 'M', order: 1 },
      { id: 'f',    name: '父亲',   sex: 'M', order: 0 },
      { id: 'ff',   name: '爷爷',   sex: 'M', order: 0 },
      { id: 'unc',  name: '三叔',   sex: 'M', order: 2 },
      { id: 'cous', name: '堂哥',   sex: 'M', order: 0 }, // 三叔长子，不同父母
    ],
    relationships: [
      { a: 'f',   b: 'me',   type: 'parent' },
      { a: 'ff',  b: 'f',    type: 'parent' },
      { a: 'ff',  b: 'unc',  type: 'parent' },
      { a: 'unc', b: 'cous', type: 'parent' },
    ],
  }));
  const k = deriveKinship(ds2, buildIndex(ds2), 'me', 'cous');
  assert.equal(k.age, null, '跨家庭不该给出长幼结论');
  assert.equal(k.ageUncertain, true, '应提示用户补出生年');
  assert.ok(['堂哥', '堂弟'].includes(k.dialect),
    `无出生年时按默认显示，实际「${k.dialect}」`);
});

test('姻亲一跳：妻兄之子 = 内侄', () => {
  expectKin('p_wnep', '内侄');
});

test('姻亲两跳：妻兄之妻 = 内嫂（W-B-W）', () => {
  const k = expectKin('p_wus', '内嫂');
  assert.deepEqual(k.symbols, ['W', 'B', 'W']);
});

test('姻亲两跳：妻之祖父 = 跟着老婆叫爷爷（W-F-F）', () => {
  const k = expectKin('p_wg', '爷爷');
  assert.equal(k.std, '岳祖父');
  assert.equal(k.genDelta, 2);
});

test('姻亲两跳：妻之祖母', () => {
  expectKin('p_wgw', '奶奶');
});

/* ---------------------------------------------------------
 * 妻方家族 —— 口径（2026-10-10 定）：我的称谓和妻子一样
 * ---------------------------------------------------------
 * 妻子的姑姑就是我的姑姑，妻子的姑姑的丈夫就是我的姑父。
 * 以前 `W F Z H`（姑父）这一族整个是空的，`W F B` / `W F Z`
 * 还被写成「岳伯」「岳姑」这种现实中没人叫的书面词。
 * ========================================================= */

/** 造一个完整的妻方家族：岳父家（伯叔姑舅姨齐全）+ 各自的下一代 */
function wifeExtended() {
  const P = (id, name, sex, birth) => ({ id, name, sex, birth });
  const child = (a, b) => ({ a, b, type: 'parent' });
  const couple = (a, b) => ({ a, b, type: 'spouse' });
  return withResolvedGen(normalizeDataset({
    version: '1.0',
    viewpoint: 'me',
    people: [
      P('me', '我', 'M', '1992'),
      P('wife', '妻子', 'F', '1992'),
      /* 岳家两代 */
      P('wf', '岳父', 'M', '1966'), P('wm', '岳母', 'F', '1968'),
      P('wg', '爷爷', 'M', '1938'), P('wgw', '奶奶', 'F', '1940'),
      /* 岳父的兄弟姊妹 */
      P('wb', '伯父', 'M', '1960'), P('wbw', '伯娘', 'F', '1962'),
      P('ws', '叔父', 'M', '1972'), P('wsw', '婶', 'F', '1974'),
      P('wz1', '大姑', 'F', '1964'), P('wz2', '小姑', 'F', '1970'),
      P('wzh', '姑父', 'M', '1968'),
      /* 下一代 */
      P('wc1', '堂兄', 'M', '1985'), P('wc1w', '堂嫂', 'F', '1987'),
      P('wc1s', '堂侄', 'M', '2012'),
      P('wt1', '姑表兄', 'M', '1988'),
      /* 岳母那边的兄弟姊妹 —— 注意是「妻子的外公的兄弟姊妹」，
         岳母自己的父母必须先建出来，否则血亲路径会被压成 W B（妻子的兄弟）。 */
      P('xwg', '外公', 'M', '1936'), P('xgw', '外婆', 'F', '1938'),
      P('wjf', '妻舅', 'M', '1965'), P('wjfw', '妗子', 'F', '1967'),
      P('wy', '妻姨', 'F', '1970'), P('wyh', '姨夫', 'M', '1968'),
      P('wjt', '舅表兄', 'M', '1986'),
    ],
    relationships: [
      couple('me', 'wife'),
      child('wf', 'wife'), child('wm', 'wife'),
      child('wg', 'wf'), child('wgw', 'wf'),
      /* 伯叔姑都是爷爷奶奶的孩子 */
      child('wg', 'wb'), child('wgw', 'wb'),
      child('wg', 'ws'), child('wgw', 'ws'),
      child('wg', 'wz1'), child('wgw', 'wz1'),
      child('wg', 'wz2'), child('wgw', 'wz2'),
      couple('wb', 'wbw'), couple('ws', 'wsw'), couple('wz2', 'wzh'),
      /* 下一代 */
      child('wb', 'wc1'), couple('wc1', 'wc1w'), child('wc1', 'wc1s'),
      child('wz1', 'wt1'),
      /* 舅姨是岳母（妻子的母亲）的兄弟姊妹 —— 都挂在外公外婆名下 */
      child('xwg', 'wm'), child('xgw', 'wm'),
      child('xwg', 'wjf'), child('xgw', 'wjf'),
      child('xwg', 'wy'), child('xgw', 'wy'),
      couple('wjf', 'wjfw'), couple('wy', 'wyh'),
      child('wjf', 'wjt'),
    ],
  }));
}

const wds = wifeExtended();
const widx = buildIndex(wds);
/** 妻方家族里某人的称谓 */
const kinW = (id) => deriveKinship(wds, widx, 'me', id);

/** 断言妻方家族里某人的称谓（错误信息带上人名和路径） */
function expectW(id, expected) {
  const k = kinW(id);
  assert.equal(k.dialect, expected,
    `${widx.byId.get(id)?.name || id}：期望「${expected}」，实际「${k.dialect}」`
    + `（路径 ${k.symbols.join('-') || '无'}）`);
  return k;
}

test('TC-2026-1010 妻方家族：姑姑 / 姑妈 / 姑父（姑父以前整族是空的）', () => {
  /* 站位：大姑（1964）比妻子（1992）年长 → 姑妈；小姑（1970）年幼 → 姑姑 */
  const a = kinW('wz1');
  assert.deepEqual(a.symbols, ['W', 'F', 'Z']);
  assert.equal(a.dialect, '姑妈', `实际「${a.dialect}」`);
  assert.equal(a.std, '姑母');
  assert.equal(a.genDelta, 1, '姑姑与妻子同辈，比我高一代');
  assert.equal(a.genMismatch, false);

  const b = kinW('wz2');
  assert.equal(b.dialect, '姑姑', `实际「${b.dialect}」`);
  assert.equal(b.age, 'younger');

  /* ★ 本次要修的那一条 */
  const h = kinW('wzh');
  assert.deepEqual(h.symbols, ['W', 'F', 'Z', 'H']);
  assert.equal(h.dialect, '姑父', `实际「${h.dialect}」`);
  assert.equal(h.std, '姑父');
  assert.ok(h.ok, '以前这条直接输出「（关系待确认）」');
});

test('TC-2026-1010 姑父三边统一叫「姑父」，且不挂任何方言备选', () => {
  /* 「姑爷」在普通话环境里容易被听成「姑姑的儿子」，对不熟的人容易叫错。
     自家（F Z H）、随夫家（H F Z H）、妻方（W F Z H）三条一起改，
     免得同一族里三边叫法一致之外还各挂一堆方言。 */
  for (const path of ['F Z H', 'H F Z H', 'W F Z H']) {
    const rs = RULES.filter((r) => r.path === path);
    assert.equal(rs.length, 1, `${path} 应恰好一条规则，实际 ${rs.length} 条`);
    assert.equal(rs[0].dialect, '姑父', `${path} 的显示称呼应是「姑父」`);
    assert.equal(rs[0].std, '姑父');
    assert.ok(!/姑爷|姑爹/.test(String(rs[0].alt)),
      `${path} 不该再把方言叫法挂在备选里，实际 ${JSON.stringify(rs[0].alt)}`);
  }
});

test('TC-2026-1010 妻方家族：不再叫「岳姑 / 岳伯」，直接叫姑姑 / 伯伯', () => {
  /* 「岳姑」「岳伯」现实中没人叫，与旁边「随夫家」已改叫姑妈/姑姑
     （rules.js 的 H F Z）的做法自相矛盾。 */
  for (const [path, banned] of [['W F B', '岳伯'], ['W F Z', '岳姑']]) {
    const hit = RULES.filter((r) => r.path === path && String(r.dialect).includes(banned));
    assert.equal(hit.length, 0, `${path} 不该再出现「${banned}」`);
  }
  const b = kinW('wb');
  assert.equal(b.dialect, '伯伯', `实际「${b.dialect}」`);
  assert.equal(b.std, '伯父');
  const s = kinW('ws');
  assert.equal(s.dialect, '叔叔', `实际「${s.dialect}」`);
});

test('TC-2026-1010 妻方家族：伯娘 / 婶 / 姑父 / 舅舅 / 妗子 / 姨妈 / 姨夫', () => {
  expectW('wbw', '伯娘');
  expectW('wsw', '婶');
  expectW('wjf', '舅舅');
  /* 这批测试数据没填 order，排不出来就不排 —— 不瞎加「大」 */
  expectW('wjfw', '妗子');
  expectW('wy', '姨妈');
  expectW('wyh', '姨夫');
  for (const id of ['wbw', 'wsw', 'wjf', 'wyh']) {
    assert.equal(kinW(id).genMismatch, false, `${id} 的辈分差与规则不符`);
  }
});

test('TC-2026-1010 妻方家族：同辈叫哥 / 表哥，下一代叫侄子 / 外甥', () => {
  /* 妻子的堂兄、姑表兄、舅表兄都与我同辈；堂兄之子是侄子，姑表兄之子是外甥 */
  const c = kinW('wc1');
  assert.deepEqual(c.symbols, ['W', 'F', 'B', 'S']);
  assert.equal(c.dialect, '哥', `实际「${c.dialect}」`);
  assert.equal(c.genDelta, 0);

  expectW('wc1w', '嫂子');
  expectW('wt1', '表哥');
  expectW('wjt', '表哥');
  expectW('wc1s', '侄子');
  assert.equal(kinW('wc1s').genDelta, -1);
});

test('TC-2026-1010 妻方家族：规则表里这一族已成体系，不再有孤零零的 W F B / W F Z', () => {
  /* 每个「W F ...」路径都必须有成对的年龄分支或明确的单条，
     免得以后又出现「有哥哥没弟弟」这种半截缺口。 */
  const needPair = ['W F B', 'W F B W', 'W F Z', 'W F B S', 'W F B D',
    'W F Z S', 'W F Z D', 'W M B S', 'W M Z D'];
  for (const p of needPair) {
    const ages = RULES.filter((r) => r.path === p).map((r) => r.age).filter(Boolean);
    assert.ok(ages.includes('older') && ages.includes('younger'),
      `${p} 缺长幼分支（现有 ${JSON.stringify(ages)}）`);
  }
  /* 姑父 / 妻舅这类无长幼的，必须成条存在 */
  for (const p of ['W F Z H', 'W M B', 'W M B W', 'W M Z', 'W M Z H']) {
    assert.ok(RULES.some((r) => r.path === p), `规则表缺 ${p}`);
  }
});

test('兄之妻 = 嫂子（B-W）', () => {
  expectKin('p_sis', '嫂子');
});

/* ========================================================= */
/* 称谓必须口语优先 —— 这一组是本软件的核心卖点            */
/* ---------------------------------------------------------
 * 「初衷是为了好称呼」：用户要的是能脱口而出的那个词。
 * 下面这组专门盯两件事：
 *   1. 辈分不能算错 —— 尤其别把「从哥的妻子」算成侄媳
 *   2. 界面上不许出现谱系学术语（堂侄 / 从侄 / 表侄 …）
 * ========================================================= */

/**
 * 造一个专门的家庭，覆盖「堂哥一支」和「从哥一支」往下两代。
 *
 *          爷爷 ─┬─ 父亲 ── 我(me)
 *                │
 *          爷爷的兄弟 ── 堂伯(cu) ─┬─ 从哥(cong)  ─┬─ 从嫂(congw)
 *                                 │                ├─ 侄子(nephew)
 *                                 │                └─ 侄女(niecen)
 *                                 └─ 从弟(cong2) ─── 从弟媳(cong2w)
 *          父亲 ─┬─ 父亲
 *                │
 *          父亲的兄弟 ─┬─ 堂哥(tc) ─┬─ 堂嫂(tcw)
 *                        │           ├─ 侄子(tcn) ── 侄媳(tcnw)
 *                        │           └─ 侄女(tcd) ── 侄女婿(tcdh)
 */
const ORAL = withResolvedGen(normalizeDataset({
  version: '1.0',
  viewpoint: 'me',
  people: [
    { id: 'me',      name: '我',      sex: 'M', birth: '1970' },
    { id: 'f',       name: '父亲',    sex: 'M', birth: '1945' },
    { id: 'fm',      name: '母亲',    sex: 'F', birth: '1947' },
    { id: 'gf',      name: '爷爷',    sex: 'M', birth: '1920' },
    { id: 'gfb',     name: '爷爷的兄弟', sex: 'M', birth: '1925' },
    { id: 'ggf',     name: '太爷爷',  sex: 'M', birth: '1895' },

    // 从哥一支（爷爷的兄弟的孙子）
    { id: 'cu',      name: '堂伯',    sex: 'M', birth: '1948' },
    { id: 'cuw',     name: '堂伯娘',  sex: 'F', birth: '1950' },
    { id: 'cong',    name: '从哥',    sex: 'M', birth: '1965' },
    { id: 'congw',   name: '从嫂',    sex: 'F', birth: '1967' },
    { id: 'nephew',  name: '从哥的儿子', sex: 'M', birth: '1995' },
    { id: 'niecen',  name: '从哥的女儿', sex: 'F', birth: '1997' },
    { id: 'cong2',   name: '从弟',    sex: 'M', birth: '1975' },
    { id: 'cong2w',  name: '从弟媳',  sex: 'F', birth: '1978' },

    // 堂哥一支（父亲的兄弟的儿子）
    { id: 'fb',      name: '叔父',    sex: 'M', birth: '1950' },
    { id: 'fbw',     name: '婶',      sex: 'F', birth: '1952' },
    { id: 'tc',      name: '堂哥',    sex: 'M', birth: '1968' },
    { id: 'tcw',     name: '堂嫂',    sex: 'F', birth: '1970' },
    { id: 'tcn',     name: '堂哥的儿子', sex: 'M', birth: '1998' },
    { id: 'tcnw',    name: '堂侄媳',  sex: 'F', birth: '1999' },
    { id: 'tcd',     name: '堂哥的女儿', sex: 'F', birth: '2000' },
    { id: 'tcdh',    name: '堂侄女婿', sex: 'M', birth: '1999' },
  ],
  relationships: [
    /* ⚠️ 两个约定踩过一次就够：
       ① 兄弟关系不是独立边，它由「共同父节点」推出来 —— gf / gfb / fb
          必须挂在同一个曾祖父 ggf 下，否则 bloodPath 找不到 LCA，整条支全断。
       ② parent 关系里 a 是父母、b 是孩子（见 model.js buildIndex）。 */
    { a: 'ggf', b: 'gf', type: 'parent' },
    { a: 'ggf', b: 'gfb', type: 'parent' },
    { a: 'gf', b: 'f', type: 'parent' },
    { a: 'gf', b: 'fb', type: 'parent' },
    { a: 'f', b: 'me', type: 'parent' },
    { a: 'fm', b: 'me', type: 'parent' },

    { a: 'gfb', b: 'cu', type: 'parent' },
    { a: 'cu', b: 'cong', type: 'parent' },
    { a: 'cu', b: 'cong2', type: 'parent' },
    { a: 'cong', b: 'nephew', type: 'parent' },
    { a: 'cong', b: 'niecen', type: 'parent' },

    { a: 'fb', b: 'tc', type: 'parent' },
    { a: 'tc', b: 'tcn', type: 'parent' },
    { a: 'tc', b: 'tcd', type: 'parent' },

    { a: 'cu', b: 'cuw', type: 'spouse' },
    { a: 'cong', b: 'congw', type: 'spouse' },
    { a: 'cong2', b: 'cong2w', type: 'spouse' },
    { a: 'fb', b: 'fbw', type: 'spouse' },
    { a: 'tc', b: 'tcw', type: 'spouse' },
    { a: 'tcn', b: 'tcnw', type: 'spouse' },
    { a: 'tcd', b: 'tcdh', type: 'spouse' },
  ],
}));
const ORAL_IDX = buildIndex(ORAL);

const oralKin = (id) => deriveKinship(ORAL, ORAL_IDX, 'me', id);
const oralName = (id) => ORAL_IDX.byId.get(id)?.name || id;

function expectOral(id, expected, note = '') {
  const k = oralKin(id);
  assert.equal(k.dialect, expected,
    `${oralName(id)}：期望「${expected}」，实际「${k.dialect}」`
    + `（路径 ${k.symbols.join('-') || '无'}${k.reason ? '，' + k.reason : ''}）${note}`);
  return k;
}

test('口语 · 同辈的哥哥一律叫「哥」（堂哥 / 从哥）', () => {
  expectOral('tc', '堂哥');
  expectOral('cong', '从哥');
  /* 从弟比我小 —— 规则表给了 younger 变体 */
  expectOral('cong2', '从弟');
});

test('口语 · 同辈哥哥的妻子叫「嫂子」，不叫堂嫂 / 表嫂 / 从嫂', () => {
  const k = expectOral('congw', '嫂子',
    '　← 关键回归：F-F-B-S-S-W 辈分是 0（跟我同辈），算错会变成「侄媳」');
  assert.equal(k.genDelta, 0, '从嫂与「我」同辈，辈分差必须是 0');
  assert.equal(k.symbols.join('-'), 'F-F-B-S-S-W');
  expectOral('tcw', '嫂子');
});

test('口语 · 同辈弟弟的妻子叫「弟媳」', () => {
  expectOral('cong2w', '弟媳');
});

test('口语 · 哥哥的儿子叫「侄子」—— 不叫堂侄 / 从侄', () => {
  const k1 = expectOral('tcn', '侄子');
  assert.equal(k1.genDelta, -1, '侄子比我低一代');
  const k2 = expectOral('nephew', '侄子');
  assert.equal(k2.genDelta, -1, '从哥的儿子比我低一代');
  assert.equal(k2.symbols.join('-'), 'F-F-B-S-S-S');
});

test('口语 · 哥哥的女儿叫「侄女」', () => {
  expectOral('tcd', '侄女');
  expectOral('niecen', '侄女');
});

test('口语 · 母系表亲的女儿叫「外甥女」—— 不叫表侄女 / 堂外甥女', () => {
  /* TC-2026-1009 用户报：妈妈的兄弟的儿子的女儿（M B S D）显示「（关系待确认）」。
     以前母系只写了男方向（M B S S 等），女方向一条都没有。
     口径：父系同姓的兄弟之子才叫「侄子」，其余（姐妹、姑舅姨那边）一律「外甥」，
     所以母系表亲的女儿是「外甥女」，不是「侄女」也不是「表侄女」。 */
  const cases = [
    ['M B S D', '外甥女', '舅表兄之女'],
    ['M B D D', '外甥女', '舅表姐之女'],
    ['M Z S D', '外甥女', '姨表兄之女'],
    ['M Z D D', '外甥女', '姨表姐之女'],
  ];
  for (const [path, dialect, note] of cases) {
    const r = RULES.find((x) => x.path === path);
    assert.ok(r, `规则表缺少路径 ${path}（母系表亲之女）`);
    assert.equal(r.dialect, dialect, `${path} 显示称谓应为「${dialect}」`);
    assert.equal(r.branch, 'maternal', `${path} 应归入母系分支`);
    assert.equal(r.note, note, `${path} 的 note 应保留谱系出处备查`);
  }
});

test('口语 · 父系表亲的女儿叫「外甥女」—— 同一个错不能犯第二次', () => {
  /* 用户报（2026-10-11）：点开某人时「外甥女」的称呼没有，全谱 5 个人卡在
     「（关系待确认）」，全是女方向，实测路径 F-Z-S-D / F-Z-D-D / F-B-D-D。
     根因：父系这一族**只写了子、没写女**（`F B D S`=堂姐之子 有，`F B D D` 没有），
     与母系当年那条注释描述的症状一模一样 —— 同一个错犯了两次。
     口径：第一跳是兄弟且同姓 → 侄女（`F B S D`，一直都有）；
             其余（堂姐那边、姑那边）→ 外甥女，
             与 `F B D S`（堂姐之子＝外甥）严格对称，不叫「堂侄女」。 */
  const cases = [
    ['F B D D', '外甥女', '堂姐之女'],
    ['F Z S D', '外甥女', '姑表兄之女'],
    ['F Z D D', '外甥女', '姑表姐之女'],
  ];
  for (const [path, dialect, note] of cases) {
    const r = RULES.find((x) => x.path === path);
    assert.ok(r, `规则表缺少路径 ${path}（父系表亲之女）`);
    assert.equal(r.dialect, dialect, `${path} 显示称谓应为「${dialect}」`);
    assert.equal(r.branch, 'paternal', `${path} 应归入父系分支`);
    assert.equal(r.gen, -1, `${path} 比我低一代`);
    assert.equal(r.note, note, `${path} 的 note 应说明谱系出处`);
  }

  /* 钉死「不叫堂侄女」：父系同姓堂兄那条本来叫侄女，不许被改成外甥女 */
  const tcd = RULES.find((x) => x.path === 'F B S D');
  assert.ok(tcd, 'F B S D（堂兄之女）必须留着');
  assert.equal(tcd.dialect, '侄女', '堂兄之女仍叫「侄女」，不许跟堂姐那边混成外甥女');
});

test('口语 · 妻方侄辈层 16 条路径必须齐全 —— 第三次「只写子不写女」不许再犯', () => {
  /* 用户报（2026-10-11）：「外甥女的称呼怎么没有」。定位时拿真实库遍历
     4 本谱 × 全部视角 × 全部目标（39382 组）实测出兜底路径，发现妻方侄辈层
     16 条路径只写了 8 条 —— 妻的**父**那边四条齐全（连堂姐之女都写了），
     妻的**母**那边和妻的父之姑那边清一色只写子（`… S`），女方向零条。
     实测这 8 条各触发 6～43 次，全族退回「（关系待确认）」。
     ⚠️ 这是同一个毛病第三次出现（母系 v0.2.4x 补过一次、父系本次补过一次），
        所以这里不钉单个词条，而是钉「16 条路径的完整性 + 男女对称」。 */
  const expect = {
    // 妻的父的兄弟那一支（同姓，伯叔那边）→ 侄子 / 侄女
    'W F B S S': '侄子', 'W F B S D': '侄女', 'W F B D S': '侄子', 'W F B D D': '侄女',
    // 其余（姑姑那边、舅姨那边，异姓）→ 外甥 / 外甥女
    'W F Z S S': '外甥', 'W F Z S D': '外甥女', 'W F Z D S': '外甥', 'W F Z D D': '外甥女',
    'W M B S S': '外甥', 'W M B S D': '外甥女', 'W M B D S': '外甥', 'W M B D D': '外甥女',
    'W M Z S S': '外甥', 'W M Z S D': '外甥女', 'W M Z D S': '外甥', 'W M Z D D': '外甥女',
  };
  for (const [path, dialect] of Object.entries(expect)) {
    const r = RULES.find((x) => x.path === path);
    assert.ok(r, `规则表缺少路径 ${path}`);
    assert.equal(r.dialect, dialect, `${path} 显示称谓应为「${dialect}」`);
    assert.equal(r.branch, 'affinal', `${path} 应归入姻亲分支`);
    assert.equal(r.gen, -1, `${path} 比我低一代`);
  }

  /* 反向钉死分界：妻的父的兄弟那一支必须是「侄」，
     妻的母的兄弟那一支必须是「外甥」—— 两者只差一个字母，改正则时最容易改混。 */
  assert.equal(RULES.find((x) => x.path === 'W M B D S').dialect, '外甥',
    '妻的舅表姐之子叫「外甥」——与妻的堂兄那条口径不同，舅那边归外甥');
  assert.equal(RULES.find((x) => x.path === 'W F B D S').dialect, '侄子',
    '妻的堂姐之子仍叫「侄子」——妻方「侄子」只给妻的父的兄弟那一支');

  /* 每个 gender 槽位都要成对出现（S/D 各一条），这就是「对称性」本身 */
  const paths = new Set(RULES.map((r) => r.path));
  for (const g of ['F', 'M']) {
    for (const mid of ['B', 'Z']) {
      for (const last of ['S', 'D']) {
        assert.ok(paths.has(`W ${g} ${mid} S ${last}`), `缺 W ${g} ${mid} S ${last}`);
        assert.ok(paths.has(`W ${g} ${mid} D ${last}`), `缺 W ${g} ${mid} D ${last}`);
      }
    }
  }
});

test('口语 · 母系表亲的孙辈叫「外甥孙 / 外甥孙女」', () => {
  /* 与上面 4 条对称往下走一代，不补的话「表姐有儿子却没孙子」会退回兜底。
     两组各 8 条：M B/M Z × S/D × S/D ——「表亲之孙」和「外甥女之子女」，
     少任何一组都会让缺口往下挪一层，等于没修。 */
  const paths = [
    'M B S S S', 'M B S S D', 'M B D S S', 'M B D S D',
    'M Z S S S', 'M Z S S D', 'M Z D S S', 'M Z D S D',
    'M B S D S', 'M B S D D', 'M B D D S', 'M B D D D',
    'M Z S D S', 'M Z S D D', 'M Z D D S', 'M Z D D D',
  ];
  const missing = paths.filter((p) => !RULES.some((r) => r.path === p));
  assert.equal(missing.length, 0, '规则表缺少母系表亲孙辈路径：\n  ' + missing.join('\n  '));
  for (const p of paths) {
    const r = RULES.find((x) => x.path === p);
    assert.match(r.dialect, /^外甥孙/, `${p} 应叫「外甥孙 / 外甥孙女」，实际「${r.dialect}」`);
    assert.equal(r.gen, -2, `${p} 比我低两代`);
  }
});

test('口语 · 侄辈的婚配叫「侄媳 / 侄女婿」（辈分落在「侄」字上）', () => {
  expectOral('tcnw', '侄媳');
  expectOral('tcdh', '侄女婿');
});

test('🔴 规则表里不许出现谱系学术语（堂侄 / 从侄 / 表侄 / 堂外甥…）', () => {
  /* 这些词现实里没人说，叫出来会被当成不会说话 —— 产品初衷就是「好称呼」。
     规范称谓没有丢，挪进了 note，需要查谱系时仍然看得到。 */
  const BANNED = ['堂侄', '从侄', '堂外甥', '表侄', '堂嫂', '表嫂', '堂姐夫', '表姐夫'];
  const offenders = RULES
    .filter((r) => [r.dialect, r.std].some((t) => BANNED.some((b) => String(t).includes(b))))
    .map((r) => `${r.path} → ${r.dialect}/${r.std}`);
  assert.equal(offenders.length, 0,
    '这些是谱系学术语，不该出现在显示称谓上：\n  ' + offenders.join('\n  '));
});

test('🔴 规则表里不许残留方言备选词（爹爹 / 家公 / 姑爹 / 幺系列…）', () => {
  /* 2026-10-10 清理：软件只保留「现在正在用的称呼」。
     dialect（界面大字）不动，扫的是 alt 与 note —— 这两处曾经挂着一批
     地域方言词，点开成员详情就会露出来，现在一律不许再挂。 */
  const BANNED = ['爹爹', '家公', '家家', '老婆婆', '姑爷', '姑爹', '幺弟', '幺妹', '幺叔',
    '幺姑', '幺舅', '幺姨', '幺爷', '伯婆', '叔婆', '舅娘', '老爹', '老娘', '武汉'];
  const offenders = RULES
    .filter((r) => [r.alt, r.note].some((f) => BANNED.some((b) => String(f).includes(b))))
    .map((r) => `${r.path} → alt=${JSON.stringify(r.alt)} note=${JSON.stringify(r.note)}`);
  assert.equal(offenders.length, 0,
    '备选叫法与备注里不该再出现方言词：\n  ' + offenders.join('\n  '));
});

test('口语 · 规范称谓要保留在 note 里（不能因为口语化就丢掉信息）', () => {
  const r = RULES.find((x) => x.path === 'F B S S' && x.dialect === '侄子');
  assert.ok(r, '堂哥之子（F B S S）应存在');
  assert.ok(String(r.note).includes('堂侄'),
    `note 里应保留谱系称谓「堂侄」备查，实际 note =「${r.note}」`);
});

test('口语 · 随夫家口径：妻子看丈夫家的侄辈叫「侄子 / 侄女」（不叫外甥）', () => {
  /* 2026-10-09 定口径：嫁入的妻子随夫家称呼 —— 丈夫兄弟的儿子就是我的侄子，
     不因为我不是姓林的就改口「外甥」（现实中绝大多数家庭就是这么叫的）。
     之前这一族整族没规则，母亲视角下丈夫家全是「（关系待确认）」。 */
  const cases = [
    ['H B S', '侄子', '随夫家'],
    ['H B D', '侄女', '随夫家'],
    ['H B S W', '侄媳', '丈夫侄儿之妻'],
    ['H B D H', '侄女婿', '丈夫侄女之夫'],
    ['H B S S', '侄孙', '丈夫侄儿之子'],
    ['H B D D', '侄孙女', '丈夫侄女之孙女'],
    /* 丈夫姐妹的子女是异姓，走「外甥」那一族 —— 跟上面成对，别混 */
    ['H Z S', '外甥', '丈夫姐妹之子'],
    ['H Z D', '外甥女', '丈夫姐妹之女'],
  ];
  for (const [path, dialect, note] of cases) {
    const r = RULES.find((x) => x.path === path);
    assert.ok(r, `规则表缺少路径 ${path}（随夫家）`);
    assert.equal(r.dialect, dialect, `${path} 显示称谓应为「${dialect}」`);
    assert.equal(r.branch, 'affinal', `${path} 应归入姻亲分支`);
    assert.ok(String(r.note).includes(note),
      `${path} 的 note 应写明出处（含「${note}」），实际「${r.note}」`);
  }
});

test('口语 · 随夫家口径：儿媳 / 女婿 / 孙媳 / 亲家公母（常识级关系不许兜底）', () => {
  /* `H S` / `H D` 就是「我的儿子 / 女儿」，因此这一组是我家的儿媳妇那一支。
     以前连「我儿媳妇」都是「（关系待确认）」。 */
  const cases = [
    ['H S W', '儿媳妇', -1],
    ['H D H', '女婿', -1],
    ['H S S W', '孙媳妇', -2],
    ['H D S W', '外孙媳妇', -2],
  ];
  for (const [path, dialect, gen] of cases) {
    const r = RULES.find((x) => x.path === path);
    assert.ok(r, `规则表缺少路径 ${path}（儿媳/孙媳这一支）`);
    assert.equal(r.dialect, dialect, `${path} 显示称谓应为「${dialect}」`);
    assert.equal(r.gen, gen, `${path} 辈分差应为 ${gen}`);
  }
  /* 血亲可达的等价写法不许写进规则表：`H S D` 永远查不到，
     因为血亲算法会直接推出 `S D`。写了只是灌水、误导后来人。 */
  for (const p of ['H S D', 'H D D', 'H S S S', 'H D D D']) {
    assert.equal(RULES.some((r) => r.path === p), false,
      `${p} 与纯血亲路径等价，属死规则，不该进规则表`);
  }
});

test('口语 · 亲家公 / 亲家母：前缀换了称谓不变（后缀兜底）', () => {
  /* 「我儿媳的爹妈」叫亲家公 —— 这一条在不同视角下前缀千差万别：
       我看儿媳的爹妈 S W F / 爸爸看 F S W F / 爷爷看 F F S W F /
       我看女婿的爹妈 D H F / 我看孙媳的爹妈 S S W F …
     逐条登记是无穷组合，但称谓只取决于配偶步之后那几步，所以走后缀匹配。
     此前这些全是「（关系待确认）」—— 连「我儿媳妇的爹妈」都算不出来。 */
  const cases = [
    [['S', 'W', 'F'], '亲家公'],
    [['S', 'W', 'M'], '亲家母'],
    [['F', 'S', 'W', 'F'], '亲家公'],
    [['F', 'F', 'S', 'W', 'M'], '亲家母'],
    [['D', 'H', 'F'], '亲家公'],
    [['D', 'H', 'M'], '亲家母'],
    [['S', 'S', 'W', 'F'], '亲家公'],
    [['S', 'W', 'F', 'F'], '亲家爷爷'],
    [['S', 'W', 'F', 'M'], '亲家奶奶'],
  ];
  for (const [symbols, dialect] of cases) {
    const r = lookupRule(symbols);
    assert.ok(r, `${symbols.join('-')} 应能查到称谓`);
    assert.equal(r.dialect, dialect, `${symbols.join('-')} 应叫「${dialect}」`);
    assert.equal(r.branch, 'affinal', `${symbols.join('-')} 应归入姻亲分支`);
  }
});

test('🔴 亲家后缀兜底不许抢走既有的直接配偶亲属（安全阀）', () => {
  /* 这是本层最要命的边界：配偶步前面必须**至少有一段血亲步**。
     少了这个条件，`W F` 会被当成「剥掉前缀后剩 W F」→ 误判成亲家公，
     可它明明是「妻子的父亲」= 岳父。同理 H F 是公公、H M 是婆婆。 */
  const mustKeep = [
    [['W', 'F'], '岳父'],
    [['W', 'M'], '岳母'],
    [['H', 'F'], '公公'],
    [['H', 'M'], '婆婆'],
    [['W', 'F', 'F'], '爷爷'],
    [['H', 'F', 'F'], '爷爷'],
  ];
  for (const [symbols, dialect] of mustKeep) {
    const r = lookupRule(symbols);
    assert.ok(r, `${symbols.join('-')} 应在规则表里`);
    assert.equal(r.dialect, dialect,
      `${symbols.join('-')} 是直接配偶的爹妈，必须是「${dialect}」，不该被亲家兜底抢走`);
    assert.notEqual(r.inlawFallback, true, `${symbols.join('-')} 不该走后缀兜底`);
  }
});

test('口语 · 「我儿媳的爹妈」端到端能算出来（此前整族兜底）', () => {
  const d = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      { id: 'me',   name: '我',       sex: 'M', gen: 0 },
      { id: 'son',  name: '儿子',     sex: 'M', gen: -1 },
      { id: 'wife', name: '儿媳妇',   sex: 'F', gen: -1 },
      { id: 'ff',   name: '亲家公',   sex: 'M', gen: 0 },   // 儿子的岳父，比儿子高一代 → 与我同辈
      { id: 'fm',   name: '亲家母',   sex: 'F', gen: 0 },
      { id: 'fff',  name: '亲家爷爷', sex: 'M', gen: 1 },
    ],
    relationships: [
      { a: 'me',   b: 'son',  type: 'parent' },   // 儿子是我的儿子
      { a: 'me',   b: 'wife', type: 'parent' },   // 我是儿媳妇的丈夫
      { a: 'son',  b: 'wife', type: 'spouse' },   // 儿子娶了她
      { a: 'ff',   b: 'wife', type: 'parent' },   // 亲家公是儿媳妇的父亲
      { a: 'fm',   b: 'wife', type: 'parent' },
      { a: 'fff',  b: 'ff',   type: 'parent' },
    ],
  }));
  const di = buildIndex(d);
  const got = (id) => deriveKinship(d, di, 'me', id);
  assert.equal(got('ff').dialect, '亲家公', '儿媳的父亲 = 亲家公');
  assert.equal(got('fm').dialect, '亲家母', '儿媳的母亲 = 亲家母');
  assert.equal(got('fff').dialect, '亲家爷爷', '儿媳的祖父 = 亲家爷爷');
  assert.equal(got('ff').genDelta, 0, '亲家公与我同辈');
  assert.equal(got('fff').genDelta, 1, '亲家爷爷比我高一辈');
  /* 后缀兜底的 gen 是占位值，绝不能因此误报「辈分不一致」 */
  assert.equal(got('fff').genMismatch, false, '亲家爷爷不该误报辈分不一致');
  assert.equal(got('ff').genMismatch, false, '亲家公不该误报辈分不一致');
});

test('口语 · 只登记了配偶没登记父亲时，「妈妈的丈夫」也得叫得出爸爸', () => {
  /* 实测自家谱踩到的：张国友只是「李书香的配偶」，没另外登记成父亲，
     于是爸爸只能走 `M H` 推出来 —— 规则表里以前没这条，
     界面直接显示「（关系待确认）」，诊断也报 `规则表未覆盖路径 M-H`。 */
  const d = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      { id: 'me',  name: '我',   sex: 'M', gen: 0 },
      { id: 'mo',  name: '妈妈', sex: 'F', gen: 1 },
      { id: 'pa',  name: '爸爸', sex: 'M', gen: 1 },
    ],
    relationships: [
      { a: 'mo', b: 'me', type: 'parent' },
      { a: 'mo', b: 'pa', type: 'spouse' },     // ← 只有配偶，没有 parent 边
    ],
  }));
  const di = buildIndex(d);
  assert.deepEqual(deriveKinship(d, di, 'me', 'pa').symbols, ['M', 'H'],
    '妈妈的丈夫应走 M H');
  assert.equal(deriveKinship(d, di, 'me', 'pa').dialect, '爸爸');
  assert.equal(lookupRule(['F', 'W'], null).dialect, '妈妈',
    '爸爸的老婆（F W）同词，也是「妈妈」');
  assert.equal(lookupRule(['M', 'H'], null).gen, 1, 'M H 比我高一代');
  assert.equal(lookupRule(['F', 'W'], null).gen, 1, 'F W 比我高一代');
});

test('父母候选：辈分过滤要有上下界（太爷爷不能当妈）', () => {
  /* 用户报的场景：「妻子家族里给妻子的父亲设母亲，下拉里能选到太爷爷」。
     以前只有下界 `p.gen > myGen`（必须比我年长），上界完全没有 ——
     于是高三辈的太爷爷也混在候选里。 */
  const pool = [
    { id: 'me', gen: 0, sex: 'M' },        // 我这一辈（自己的父母不可能是它）
    { id: 'parent', gen: 1, sex: 'M' },    // 我父母那一辈 ✓
    { id: 'gp', gen: 2, sex: 'M' },        // 祖父母
    { id: 'ggp', gen: 3, sex: 'M' },       // 曾祖父母
    { id: 'tggp', gen: 4, sex: 'M' },      // 高祖父母 =「太爷爷」← 绝不该出现
  ];
  const ids = (arr) => arr.map((p) => p.id).sort();

  /* 目标是我（gen 0）→ 父母只能是 gen 1 */
  assert.deepEqual(ids(filterParentCandidates(pool, 0, '')), ['parent'],
    '我的父母只能选父母那一辈，太爷爷/曾祖父母都不许出现');

  /* 目标是我的儿子（gen -1）→ 父母只能是我这一辈 */
  assert.deepEqual(ids(filterParentCandidates(pool, -1, '')), ['me'],
    '给我儿子设父亲时，只能选我这一辈');

  /* 目标是我的父亲（gen 1）→ 他的父母是 gen 2（祖父母），不该出现太爷爷 */
  assert.deepEqual(ids(filterParentCandidates(pool, 1, '')), ['gp'],
    '我父亲的父亲是祖父，太爷爷不该出现');

  /* ⚠️ 下界不能丢：比自己年轻的（子女那一辈）永远不进候选 */
  const younger = pool.concat([{ id: 'kid', gen: -1, sex: 'M' }]);
  assert.equal(filterParentCandidates(younger, 1, '').some((p) => p.id === 'kid'), false,
    '我的子女不能出现在「我父亲」的候选里');

  /* 世次断层兜底：父母那一层没人时，逐级放宽但仍不能空 */
  const gapped = [{ id: 'ggp', gen: 5, sex: 'M' }, { id: 'gp', gen: 3, sex: 'F' }];
  const relaxed = filterParentCandidates(gapped, 1, '');
  assert.ok(relaxed.length > 0, '候选永远不能为空');
  assert.equal(relaxed.some((p) => p.id === 'gp'), true, '放宽时仍要保留唯一能用的那位');

  assert.equal(filterParentCandidates([], 0, '').length, 0);
  assert.equal(filterParentCandidates(pool, null, '').length, pool.length,
    '目标没有世次时（新增未录）不做任何过滤，下拉不能空');

  /* 已选中那位即使辈分异常也必须留下 —— 否则用户一保存就静默清空父母关系 */
  const kept = filterParentCandidates(pool, 0, 'tggp');
  assert.equal(kept.some((p) => p.id === 'tggp'), true,
    '已选中的那位不能被过滤掉，否则保存时会悄悄清空这条关系');
});

test('父母候选：性别要对得上（男的别进母亲选项，女的别进父亲选项）', () => {
  /* 用户报：「其实男的不应该出现的母亲选项里，女的也不应该出现在父亲选项里」。
     以前性别只是**排序权重**（sexOk 只参与 sort），候选列表里男女全在，
     只是对的排前面 —— 等于让人在一堆异性里翻。 */
  const pool = [
    { id: 'fa', gen: 1, sex: 'M' },
    { id: 'mo', gen: 1, sex: 'F' },
    { id: 'uncle', gen: 1, sex: 'M' },
    { id: 'aunt', gen: 1, sex: 'F' },
    { id: 'unknown', gen: 1, sex: '' },
  ];
  const inFather = filterParentCandidates(pool, 0, '', 'M').map((p) => p.id).sort();
  const inMother = filterParentCandidates(pool, 0, '', 'F').map((p) => p.id).sort();

  assert.deepEqual(inFather, ['fa', 'uncle', 'unknown'], '父亲候选里只有男性 + 性别未知的');
  assert.deepEqual(inMother, ['aunt', 'mo', 'unknown'], '母亲候选里只有女性 + 性别未知的');
  assert.equal(inFather.includes('mo'), false, '女性不许出现在父亲候选里');
  assert.equal(inMother.includes('fa'), false, '男性不许出现在母亲候选里');

  /* 性别未知的必须两边都放行 —— 那是「待补充信息」，不能让人查无此人 */
  assert.equal(inFather.includes('unknown'), true);
  assert.equal(inMother.includes('unknown'), true);

  /* 兜底也不能把异性放回来：辈分放宽后仍要守住性别 */
  const far = [
    { id: 'farM', gen: 5, sex: 'M' },
    { id: 'farF', gen: 5, sex: 'F' },
  ];
  assert.deepEqual(filterParentCandidates(far, 0, '', 'M').map((p) => p.id), ['farM'],
    '世次断层时放宽辈分，也不能把女性放进父亲候选');
  assert.deepEqual(filterParentCandidates(far, 0, '', 'F').map((p) => p.id), ['farF'],
    '同理，父亲不进母亲候选');

  /* 已选中的那位若是历史数据录错了性别，也得留着（否则保存时静默清空） */
  const wrong = filterParentCandidates(pool, 0, 'mo', 'M');
  assert.equal(wrong.some((p) => p.id === 'mo'), true,
    '已选中但性别与槽位不符的那位不能消失 —— 否则保存会悄悄清空关系');
});

test('父母候选分组：他属于哪边的家族（用户报：两个太奶奶字面一模一样，选错了）', () => {
  /* 用户报的场景（2026-10-11）：给**妻子那边**的孩子设母亲时，下拉里
     「我太奶奶」和「妻子她太奶奶」都渲染成 `未知（太奶奶）·女`，
     他选成了我太奶奶 → 四个人的排行全乱（大爷爷/三爷爷/六姑婆）。
     名字和称呼都指望不上：无名的一律「未知」，而血亲对血亲的称谓
     天然对称。**唯一能区分的是他属于哪边的家族** —— 路径首符号说了算。 */

  /* --- 分组键：只认路径的第一个符号 --- */
  assert.equal(branchOfSymbols(['F', 'F', 'M']), PARENT_GROUP.SELF, 'F 开头 = 本家');
  assert.equal(branchOfSymbols(['M', 'F']), PARENT_GROUP.SELF, 'M 开头也是本家（母系）');
  assert.equal(branchOfSymbols(['W', 'F', 'F', 'M']), PARENT_GROUP.AFFINAL, 'W 开头 = 配偶那边');
  assert.equal(branchOfSymbols(['H', 'W', 'B']), PARENT_GROUP.AFFINAL, 'H 开头 = 配偶那边');
  assert.equal(branchOfSymbols(['W', 'D', 'H']), PARENT_GROUP.AFFINAL,
    '路径长一点不看后面的符号，首符号说了算 —— 免得「妻子的女婿」被当成本家');
  assert.equal(branchOfSymbols([]), PARENT_GROUP.OTHER, '空路径 = 待定');
  assert.equal(branchOfSymbols(undefined), PARENT_GROUP.OTHER, '连路径都没有也归待定，不能抛');

  /* --- 切组：三个组各自有序，空组不渲染 --- */
  const cand = [
    { id: 'gm', syms: ['F', 'F'] },        // 我爷爷 → 本家
    { id: 'gmWife', syms: ['F', 'F', 'M'] }, // 我奶奶 → 本家
    { id: 'wifeGm', syms: ['W', 'F', 'F'] },  // 妻子的爷爷 → 配偶那边
    { id: 'wifeGmWife', syms: ['W', 'F', 'F', 'M'] },
    { id: 'lost', syms: [] },              // 还没连上 → 待定
  ];
  const branchOf = (p) => branchOfSymbols(p.syms);
  const out = splitParentCandidates(cand, branchOf);

  assert.equal(out.grouped, true, '有本家和配偶家两组 → 该分组');
  assert.deepEqual(out.groups.map((g) => g.key),
    [PARENT_GROUP.SELF, PARENT_GROUP.AFFINAL, PARENT_GROUP.OTHER],
    '组顺序固定为本家 → 配偶家 → 待定');
  assert.deepEqual(out.groups.map((g) => g.items.map((p) => p.id)),
    [['gm', 'gmWife'], ['wifeGm', 'wifeGmWife'], ['lost']],
    '每个候选只进一组，且组内顺序原样保留（排序是 UI 那边的事，这里不重排）');
  assert.equal(out.groups.every((g) => g.items.length > 0), true, '空组不能渲染出来占一行');

  /* --- 只有一组时退化平铺：别画一条只有标题没有别的分组线 --- */
  const onlySelf = splitParentCandidates(cand.slice(0, 2), branchOf);
  assert.equal(onlySelf.grouped, false, '只有一组就不分组');
  assert.deepEqual(onlySelf.groups.map((g) => g.items.map((p) => p.id)), [['gm', 'gmWife']]);

  /* --- 一个候选都没有时也不能炸 --- */
  const empty = splitParentCandidates([], branchOf);
  assert.equal(empty.grouped, false);
  assert.deepEqual(empty.groups, []);

  /* --- 传进来个不认识的分组键：归「待定」，不丢人也不丢组 --- */
  const weird = splitParentCandidates([{ id: 'x' }, { id: 'y' }], (p) => (p.id === 'x' ? '哪门子' : PARENT_GROUP.SELF));
  assert.deepEqual(weird.groups.map((g) => g.items.map((p) => p.id)), [['y'], ['x']],
    '未知键落进「其他待定」（组序 本家→配偶家→待定），不会凭空消失');
});

test('口语 · 儿媳 / 女婿必须走 S W、D H，不许被绕成 W 开头的长路（回归）', () => {
  /* 背景：A 路（从「我」的配偶绕出去）排在 B 路（目标是「我血亲的配偶」）前面，
     先到先得、不比长短 → 同一个人的两条路里，绕远的那条先把结果抢走。
     实测：儿媳被绕成 `W S W`（妻子的儿子的妻子）、女婿被绕成 `W D H`
     （妻子的女儿的丈夫），规则表里两条都没有 → 整族显示「（关系待确认）」。
     现在 A / B 两路都跑完取步数少的那条，同长时 B 路赢。 */
  const d = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      { id: 'me',    name: '我',         sex: 'M', gen: 1 },
      { id: 'wife',  name: '妻',         sex: 'F', gen: 1 },
      { id: 'son',   name: '儿子',       sex: 'M', gen: 0 },
      { id: 'swife', name: '儿媳妇',     sex: 'F', gen: 0 },   // 儿子的妻子
      { id: 'dau',   name: '女儿',       sex: 'F', gen: 0 },
      { id: 'dhus',  name: '女婿',       sex: 'M', gen: 0 },   // 女儿的丈夫
    ],
    relationships: [
      { a: 'me',   b: 'wife',  type: 'spouse' },
      { a: 'me',   b: 'son',   type: 'parent' },
      { a: 'wife', b: 'son',   type: 'parent' },
      { a: 'son',  b: 'swife', type: 'spouse' },
      { a: 'me',   b: 'dau',   type: 'parent' },
      { a: 'wife', b: 'dau',   type: 'parent' },
      { a: 'dau',  b: 'dhus',  type: 'spouse' },
    ],
  }));
  const di = buildIndex(d);

  const sw = deriveKinship(d, di, 'me', 'swife');
  assert.deepEqual(sw.symbols, ['S', 'W'], '儿媳妇必须走 S W（我 → 儿子 → 他的妻子）');
  assert.equal(sw.dialect, '儿媳妇', '儿媳妇应显示「儿媳妇」');
  assert.equal(sw.std, '儿媳');

  const dh = deriveKinship(d, di, 'me', 'dhus');
  assert.deepEqual(dh.symbols, ['D', 'H'], '女婿必须走 D H（我 → 女儿 → 她的丈夫）');
  assert.equal(dh.dialect, '女婿', '女婿应显示「女婿」');

  /* 绕路那条（W S W / W D H）本身在规则表里就不该存在，
     有的话说明有人试图用「灌规则」掩盖搜索顺序问题 —— 那样只会再多出无穷多条同类路径。 */
  for (const p of ['W S W', 'W D H']) {
    assert.equal(RULES.some((r) => r.path === p), false,
      `${p} 是绕路产物，不该进规则表`);
  }

  /* 儿媳在两个视角下必须是同一个词 —— 以前 `S W` 是「媳妇」、
     `H S W` 是「儿媳妇」，同一个人两个叫法。 */
  assert.equal(lookupRule(['S', 'W'], null).dialect,
    lookupRule(['H', 'S', 'W'], null).dialect,
    '儿媳在自家视角与随夫家视角必须同词，否则同一个人两个叫法');

  /* 回归护栏：加两条配偶步的内亲仍按原样，别被择优改坏 */
  const d2 = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      { id: 'me',   name: '我',     sex: 'M', gen: 0 },
      { id: 'wife', name: '妻',     sex: 'F', gen: 0 },
      { id: 'jf',   name: '岳父',   sex: 'M', gen: 1 },
      { id: 'bro',  name: '妻兄',   sex: 'M', gen: 0 },
      { id: 'bsw',  name: '内嫂',   sex: 'F', gen: 0 },
      { id: 'nep',  name: '内侄',   sex: 'M', gen: -1 },
    ],
    relationships: [
      { a: 'me',   b: 'wife', type: 'spouse' },
      /* 妻与妻兄是真兄妹（同一个岳父），但与「我」没有半点血缘 ——
         这才是 `W B W`（内嫂）成立的前提。若把妻兄也挂成「我」的儿子，
         血亲路会直接推出 `B W`（嫂子），那就成了另一回事。 */
      { a: 'jf',   b: 'wife', type: 'parent' },
      { a: 'jf',   b: 'bro',  type: 'parent' },
      { a: 'bro',  b: 'bsw',  type: 'spouse' },
      { a: 'bro',  b: 'nep',  type: 'parent' },
    ],
  }));
  const di2 = buildIndex(d2);
  assert.equal(deriveKinship(d2, di2, 'me', 'bsw').dialect, '内嫂', '妻子的兄弟的妻子 = 内嫂');
  assert.equal(deriveKinship(d2, di2, 'me', 'nep').dialect, '内侄', '妻子的兄弟的儿子 = 内侄');
});

test('口语 · 妻方侄辈的孙辈：内侄孙 / 外甥孙那一族（以前整族兜底）', () => {
  /* 实测自家 158 人谱，光这一族 37 人显示「（关系待确认）」。
     上一轮只补了 `W F B S S`（妻子的堂兄之子，隔一层的），
     **直系的 `W B …` / `W Z …` 整族没写**。
     口径：内侄的孙辈叫「内侄孙 / 内侄孙女」，外甥的孙辈叫「外甥孙 / 外甥孙女」，
     与妈妈那边的 `M B S S`＝外甥孙 同词，不另立「堂内侄孙」那种没人叫的词。 */
  const cases = [
    ['W B S S', '内侄孙',   -2],   // 内侄的儿子
    ['W B S D', '内侄孙女', -2],   // 内侄的女儿
    ['W B D S', '内侄孙',   -2],   // 内侄女的儿子（经孙女绕回来，同辈同称）
    ['W B D D', '内侄孙女', -2],   // 内侄女的女儿
    ['W Z S S', '外甥孙',   -2],   // 外甥的儿子
    ['W Z S D', '外甥孙女', -2],   // 外甥的女儿
    ['W Z D S', '外甥孙',   -2],   // 外甥女的儿子
    ['W Z D D', '外甥孙女', -2],   // 外甥女的女儿
    ['W B S W', '内侄孙媳妇', -1], // 内侄的妻子
    ['W B D H', '内侄孙女婿', -1], // 内侄女的丈夫
    ['W Z S W', '外甥孙媳妇', -1], // 外甥的妻子
    ['W Z D H', '外甥孙女婿', -1], // 外甥孙女的丈夫
  ];
  for (const [path, dialect, gen] of cases) {
    const r = RULES.find((x) => x.path === path);
    assert.ok(r, `规则表缺少路径 ${path}（妻方侄辈的孙辈）`);
    assert.equal(r.dialect, dialect, `${path} 显示称谓应为「${dialect}」`);
    assert.equal(r.gen, gen, `${path} 辈分差应为 ${gen}`);
  }

  /* 端到端：妻 → 兄弟 → 孙子 → 孙媳妇，一口气推到最远的那一档 */
  const d = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      { id: 'me',    name: '我',       sex: 'M', gen: 0 },
      { id: 'wife',  name: '妻',       sex: 'F', gen: 0 },
      { id: 'jf',    name: '岳父',     sex: 'M', gen: 1 },
      { id: 'bro',   name: '妻兄',     sex: 'M', gen: 0 },
      { id: 'nep',   name: '内侄',     sex: 'M', gen: -1 },
      { id: 'nepw',  name: '内侄媳妇', sex: 'F', gen: -1 },
      { id: 'gnep',  name: '内侄孙',   sex: 'M', gen: -2 },
      { id: 'sis',   name: '妻妹',     sex: 'F', gen: 0 },
      { id: 'zsis',  name: '外甥',     sex: 'M', gen: -1 },
      { id: 'gzsis', name: '外甥孙',   sex: 'M', gen: -2 },
    ],
    relationships: [
      { a: 'me',   b: 'wife', type: 'spouse' },
      { a: 'jf',   b: 'wife', type: 'parent' },
      { a: 'jf',   b: 'bro',  type: 'parent' },
      { a: 'jf',   b: 'sis',  type: 'parent' },
      { a: 'bro',  b: 'nep',  type: 'parent' },
      { a: 'nep',  b: 'nepw', type: 'spouse' },
      { a: 'nep',  b: 'gnep', type: 'parent' },
      { a: 'sis',  b: 'zsis', type: 'parent' },
      { a: 'zsis', b: 'gzsis', type: 'parent' },
    ],
  }));
  const di = buildIndex(d);
  const got = (id) => deriveKinship(d, di, 'me', id).dialect;
  assert.equal(got('gnep'), '内侄孙', '妻子的兄弟的孙子 = 内侄孙');
  assert.equal(got('nepw'), '内侄孙媳妇', '内侄的妻子 = 内侄孙媳妇');
  assert.equal(got('gzsis'), '外甥孙', '妻子的姐妹的孙子 = 外甥孙');
});

test('口语 ·「媳妇」只能指儿媳妇，绝不能挂在妻子名下（口径钉死）', () => {
  /* 南阳话里「媳妇」专指儿媳妇。挂错的后果比"叫哪个好听"严重得多：
     同一屏里 `S W`（儿媳妇）和 `W`（妻子）会挂着同一个词、两种意思。 */
  const wife = RULES.find((r) => r.path === 'W');
  const sw = RULES.find((r) => r.path === 'S W');
  assert.ok(wife && sw, '`W` 与 `S W` 两条都得在');
  assert.equal(wife.dialect, '老婆', '我的妻子口语就是「老婆」');
  assert.equal((wife.alt || []).includes('媳妇'), false,
    '「媳妇」不能当妻子的别名 —— 当地口语它是儿媳妇的专属叫法');
  assert.equal(sw.dialect, '儿媳妇', '儿媳妇的大字必须是「儿媳妇」');
  assert.ok((sw.alt || []).includes('媳妇'),
    '「媳妇」可以作为儿媳妇的别名保留');

  /* 全表扫一遍：任何挂在**非儿媳妇**路径上的「媳妇」都要抓出来 */
  const offenders = RULES.filter((r) => r.path !== 'S W' && r.path !== 'H S W'
    && (r.dialect === '媳妇' || (r.alt || []).includes('媳妇')));
  assert.deepEqual(offenders.map((r) => r.path), [],
    '除 S W / H S W 外，不许再有路径用「媳妇」');
});

test('口语 · 孙媳 / 外孙媳：自家视角与随夫家视角必须都有（以前爷爷看孙媳兜底）', () => {
  /* 以前只写了 `H S S W` / `H D S W`，自家视角的 `S S W` / `D S W` 全缺，
     于是爷爷看孙媳显示「（关系待确认）」，奶奶看却是「孙媳妇」。 */
  const cases = [
    ['S S W', '孙媳妇', -2],
    ['D S W', '外孙媳妇', -2],
  ];
  for (const [path, dialect, gen] of cases) {
    const r = RULES.find((x) => x.path === path);
    assert.ok(r, `规则表缺少路径 ${path}（自家视角的孙媳）`);
    assert.equal(r.dialect, dialect, `${path} 显示称谓应为「${dialect}」`);
    assert.equal(r.gen, gen, `${path} 辈分差应为 ${gen}`);
  }
  /* 与随夫家那两条同词 */
  assert.equal(lookupRule(['S', 'S', 'W'], null).dialect, lookupRule(['H', 'S', 'S', 'W'], null).dialect);
  assert.equal(lookupRule(['D', 'S', 'W'], null).dialect, lookupRule(['H', 'D', 'S', 'W'], null).dialect);

  /* 端到端：我 → 儿子 → 孙子 → 孙媳妇 */
  const d = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      { id: 'me',   name: '我',       sex: 'M', gen: 2 },
      { id: 'son',  name: '儿子',     sex: 'M', gen: 1 },
      { id: 'gs',   name: '孙子',     sex: 'M', gen: 0 },
      { id: 'gsw',  name: '孙媳妇',   sex: 'F', gen: 0 },
      { id: 'dau',  name: '女儿',     sex: 'F', gen: 1 },
      { id: 'gs_d', name: '外孙',     sex: 'M', gen: 0 },
      { id: 'gsdw', name: '外孙媳妇', sex: 'F', gen: 0 },
    ],
    relationships: [
      { a: 'me',  b: 'son', type: 'parent' },
      { a: 'son', b: 'gs',  type: 'parent' },
      { a: 'gs',  b: 'gsw', type: 'spouse' },
      { a: 'me',  b: 'dau', type: 'parent' },
      { a: 'dau', b: 'gs_d', type: 'parent' },
      { a: 'gs_d', b: 'gsdw', type: 'spouse' },
    ],
  }));
  const di = buildIndex(d);
  assert.equal(deriveKinship(d, di, 'me', 'gsw').dialect, '孙媳妇', '我 → 儿子 → 孙子 → 孙媳妇');
  assert.equal(deriveKinship(d, di, 'me', 'gsdw').dialect, '外孙媳妇', '我 → 女儿 → 外孙 → 外孙媳妇');
});

test('口语 · 侄女自己那一支：侄女有丈夫 / 有女儿都不许兜底', () => {
  /* 以前 `B S S D`（侄孙的妹妹）有人管，`B S D …`（侄女这一支）没人管，
     于是「侄女有丈夫」「侄女有女儿」两条整族漏掉。 */
  const cases = [
    ['B S D D', '侄孙女', -2],   // 侄女的女儿
    ['B S D H', '侄女婿', -2],   // 侄女的丈夫（辈分与侄孙女同，口语不分这么细）
  ];
  for (const [path, dialect, gen] of cases) {
    const r = RULES.find((x) => x.path === path);
    assert.ok(r, `规则表缺少路径 ${path}（侄女那一支）`);
    assert.equal(r.dialect, dialect, `${path} 显示称谓应为「${dialect}」`);
    assert.equal(r.gen, gen, `${path} 辈分差应为 ${gen}`);
  }
});

test('口语 · 亲家那一族补上同辈旁支：儿媳的父亲的兄弟 / 姐妹', () => {
  /* 走 INLAW_BY_SUFFIX 兜底，不逐条登记 —— 同一关系换个视角前缀就变
     （我 → S W F Z、爸爸 → F S W F Z、爷爷 → F F S W F Z …），
     写进 RULES 只能盖住一种视角。 */
  const cases = [
    [['S', 'W', 'F', 'B'], '亲家公'],
    [['S', 'W', 'F', 'Z'], '亲家母'],
    [['S', 'S', 'W', 'F', 'Z'], '亲家母'],
    [['F', 'S', 'W', 'F', 'B'], '亲家公'],
  ];
  for (const [symbols, dialect] of cases) {
    const r = lookupRule(symbols, null);
    assert.ok(r, `路径 ${symbols.join('-')} 应被亲家后缀兜底接住`);
    assert.equal(r.dialect, dialect, `${symbols.join('-')} 应显示「${dialect}」`);
  }

  /* ⚠️ 明确不补的一条：`S W B`（儿媳的兄弟）—— 用户拍板保留兜底。
     理由：论辈分他与「我儿子」平辈，可民间公公见儿媳的兄弟从不按称谓称呼，
     硬造一个词既不真实也会污染规则表。这里钉死一条断言，防止以后有人「顺手补上」。 */
  assert.equal(lookupRule(['S', 'W', 'B'], null), null,
    '儿媳的兄弟不该有称谓：现实中一律直呼姓名，别造词');
});

test('结构路径代数：路径形状与辈分必须自洽（防止规则表整体错一代）', () => {
  const cases = [
    ['p_f',     1, ['F']],
    ['p_p2',    2, ['F', 'F']],
    ['p_g1',    3, ['F', 'F', 'F']],
    ['p_gu',    1, ['F', 'Z']],            // 爸爸的姐妹
    ['p_unc',   1, ['F', 'B']],            // 爸爸的兄弟
    ['p_p2s',   2, ['F', 'F', 'B']],       // 爷爷的兄弟
    ['p_cous',  0, ['F', 'B', 'S']],       // 爸爸兄弟的儿子
    ['p_p2ss',  1, ['F', 'F', 'B', 'S']],  // 爷爷兄弟的儿子
    ['p_mg',    2, ['M', 'F']],            // 母亲的父亲
    ['p_mun',   1, ['M', 'B']],            // 母亲的兄弟
    ['p_wf',    1, ['W', 'F']],            // 妻子的父亲
    ['p_wu',    0, ['W', 'B']],            // 妻子的兄弟
  ];
  const bad = [];
  for (const [id, gen, symbols] of cases) {
    const k = deriveKinship(ds, idx, 'p_me', id);
    if (JSON.stringify(k.symbols) !== JSON.stringify(symbols)) {
      bad.push(`${nameOf(id)}：路径应为 ${symbols.join('-')}，实际 ${k.symbols.join('-')}`);
    }
    if (k.genDelta !== gen) {
      bad.push(`${nameOf(id)}：辈分差应为 ${gen}，实际 ${k.genDelta}`);
    }
    if (k.ruleGen !== gen) {
      bad.push(`${nameOf(id)}：规则表标注第 ${k.ruleGen} 代，与数据算出的第 ${gen} 代不符 —— 规则表路径写错代了`);
    }
  }
  assert.equal(bad.length, 0, '结构路径问题：\n  ' + bad.join('\n  '));
});

test('规则表规模体检（防止误删规则）', () => {
  const s = ruleStats();
  assert.ok(s.total >= 120, `规则只有 ${s.total} 条，疑似被误删`);
  assert.ok(s.uniquePaths >= 70, `唯一路径只有 ${s.uniquePaths} 条`);
});

test('全表称谓覆盖：不该出现「关系待确认」', () => {
  const all = deriveAllKinships(ds, 'p_me');
  const uncovered = [];
  for (const [id, k] of all) {
    if (!k.ok && id !== 'p_me') uncovered.push(`${nameOf(id)}（${k.reason}）`);
  }
  assert.equal(uncovered.length, 0,
    `${uncovered.length} 人未覆盖：\n  ` + uncovered.join('\n  '));
});

/* ========================================================= */
/* 4b. 自定义称呼（按视角覆盖显示）                              */
/* ========================================================= */

group('4b. 自定义称呼（按视角覆盖显示）');

const _me = { id: 'p_me' };
const _cousin = {
  id: 'p_c',
  callOverride: { p_me: '幺妹', p_x: '表姐' },
};
const _kinCousin = { ok: true, dialect: '表妹', std: '表妹', kind: 'kin' };

test('有覆盖值时优先显示该视角的覆盖值', () => {
  assert.equal(displayCall(_cousin, _kinCousin, 'p_me'), '幺妹');
});

test('不同视角各自取自己的覆盖值', () => {
  assert.equal(displayCall(_cousin, _kinCousin, 'p_x'), '表姐');
});

test('无覆盖值退回规则算出的 dialect', () => {
  assert.equal(displayCall(_cousin, _kinCousin, 'p_other'), '表妹');
});

test('视角人自己一律显示「我」', () => {
  assert.equal(displayCall(_me, _kinCousin, 'p_me'), '我');
});

test('规则算不出且无覆盖值 → 关系待确认', () => {
  const unknown = { ok: false, dialect: '（关系待确认）' };
  assert.equal(displayCall(_cousin, unknown, 'p_other'), '（关系待确认）');
});

test('显示覆盖不改动规则本身（dialect / std 不变）', () => {
  displayCall(_cousin, _kinCousin, 'p_me');
  assert.equal(_kinCousin.dialect, '表妹');
  assert.equal(_kinCousin.std, '表妹');
});

test('normalizePerson 规范化 callOverride（只留非空字符串，去空白）', () => {
  const p = normalizePerson({ id: 'p', callOverride: { a: ' 幺妹 ', b: '', c: 5 } });
  assert.deepEqual(p.callOverride, { a: '幺妹' });
});

/* ========================================================= */
/* 4c. 「只显示姓名」开关（v0.2.54）                             */
/* ---------------------------------------------------------
 * 开关只管显示不管推导：称谓照算，关掉立刻恢复。
 * 这几条就是钉住「开关不许偷偷改数据」这件事。
 * ========================================================= */

group('4c. 「只显示姓名」开关');

const _named = { id: 'p_c', name: '王小妹' };
const _noname = { id: 'p_x' };

test('默认（showCall 为真 / 不传）→ 与以前逐字一致', () => {
  assert.equal(displayLabel(_cousin, _kinCousin, 'p_me'), displayCall(_cousin, _kinCousin, 'p_me'));
  assert.equal(displayLabel(_cousin, _kinCousin, 'p_me', true), '幺妹');   // 覆盖值照旧优先
  assert.equal(displayLabel(_me, _kinCousin, 'p_me', true), '我');
});

test('关掉 → 只剩姓名，自定义覆盖值也不抢位置', () => {
  assert.equal(displayLabel(_cousin, _kinCousin, 'p_me', false), '未知');
  assert.equal(displayLabel(_named, _kinCousin, 'p_me', false), '王小妹');
});

test('关掉时视角人自己显示姓名，不是「我」', () => {
  assert.equal(displayLabel({ id: 'p_me', name: '林然' }, _kinCousin, 'p_me', false), '林然');
});

test('关掉时无名的人回落到「未知」，人还在（不许空行）', () => {
  assert.equal(displayLabel(_noname, _kinCousin, 'p_me', false), '未知');
  assert.equal(displayLabel(null, _kinCousin, 'p_me', false), '未知');
});

test('反复开关不改动规则本身（dialect / std / 覆盖值都不变）', () => {
  displayLabel(_cousin, _kinCousin, 'p_me', false);
  displayLabel(_cousin, _kinCousin, 'p_me', true);
  assert.equal(_kinCousin.dialect, '表妹');
  assert.equal(_kinCousin.std, '表妹');
  assert.deepEqual(_cousin.callOverride, { p_me: '幺妹', p_x: '表姐' });
});

test('开关状态下，整份示例数据的称谓 Map 一模一样', () => {
  const a = deriveAllKinships(ds, 'p_me');
  const b = deriveAllKinships(ds, 'p_me');
  assert.deepEqual([...b.keys()], [...a.keys()]);
  for (const [id, k] of a) assert.deepEqual(b.get(id), k, `${nameOf(id)} 的称谓被开关改了`);
});

/* ========================================================= */
/* 5. 自动体检                                                 */
/* ========================================================= */

group('5. F8 自动体检');

const report = diagnose(ds, { viewpoint: 'p_me' });

test('示例数据体检应当全绿（示例就该是干净数据）', () => {
  assert.equal(report.issueCount, 0,
    '存在 ' + report.issueCount + ' 个问题：\n' +
    report.groups
      .filter((g) => g.items.length)
      .map((g) => `  [${g.code}] ${g.title}\n` + g.items.map((i) => '    - ' + i.text).join('\n'))
      .join('\n'));
});

test('八项检查全部有产出（结构完整）', () => {
  assert.equal(report.groups.length, 8);
  const codes = report.groups.map((g) => g.code);
  for (const c of ['F8.1', 'F8.2', 'F8.3', 'F8.4', 'F8.5', 'F8.6', 'F8.7', 'F8.8']) {
    assert.ok(codes.includes(c), `缺少 ${c}`);
  }
});

test('体检能真的抓出问题（反向验证，防止检查形同虚设）', () => {
  const broken = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'a',
    people: [
      { id: 'a', name: '甲', sex: 'M', birth: '1900', gen: 0 },
      { id: 'b', name: '乙', sex: 'M', birth: '1990', gen: 0 }, // 子与父同世次
    ],
    relationships: [{ a: 'a', b: 'b', type: 'parent' }],
  }));
  const r = diagnose(broken, { viewpoint: 'a' });
  assert.ok(r.issueCount > 0, '世次矛盾居然没被抓出来');

  const orphan = diagnose(normalizeDataset({
    people: [{ id: 'x', name: '孤', sex: 'M' }],
    relationships: [],
  }), {});
  assert.ok(orphan.issueCount > 0, '孤立节点居然没被抓出来');
});

test('diagnoseSummary 汇总正确', () => {
  const s = diagnoseSummary(report);
  assert.equal(s.total, report.issueCount);
  assert.equal(s.ok, report.ok);
  assert.equal(Object.keys(s.byGroup).length, 8);
});

/* ========================================================= */
/* 6. 派生数据不落盘（世次不能被固化）                          */
/* ========================================================= */

group('6. 派生数据不落盘（世次不能被固化）');

/** 走一遍真实的「存盘 → 重新加载」链路：serialize 就是唯一的落盘出口 */
function roundTrip(dataset) {
  return normalizeDataset(JSON.parse(serialize(dataset)));
}

test('serialize 只写人工显式 gen，推导值不落盘', () => {
  const raw = normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      { id: 'me', name: '我', sex: 'M', gen: 0 },      // 人工显式
      { id: 'pa', name: '爸', sex: 'M', gen: null },   // 待推导
    ],
    relationships: [{ a: 'pa', b: 'me', type: 'parent' }],
  });
  const resolved = withResolvedGen(raw);
  // 内存里两人都该有世次 —— 这证明推导确实生效了
  assert.equal(resolved.people.find((p) => p.id === 'me').gen, 0);
  assert.equal(resolved.people.find((p) => p.id === 'pa').gen, 1);

  const back = roundTrip(resolved);
  assert.equal(back.people.find((p) => p.id === 'pa').gen, null,
    '推导出来的 gen 被写进磁盘了 —— 下次加载会被当成人工显式值，推导从此失效');
  assert.equal(back.people.find((p) => p.id === 'me').gen, 0,
    '人工显式 gen 应当原样保留');
});

test('内部字段 _genRaw / _orphans 不得出现在序列化结果里', () => {
  const s = serialize(withResolvedGen(normalizeDataset(SAMPLE_DATA)));
  assert.ok(!s.includes('_genRaw'), '内部字段 _genRaw 泄漏到导出文件了');
  assert.ok(!s.includes('_orphans'), '内部诊断字段 _orphans 泄漏到导出文件了');
});

test('withResolvedGen 幂等：反复调用结果一致（不会越推越偏）', () => {
  const once = withResolvedGen(normalizeDataset(SAMPLE_DATA));
  const twice = withResolvedGen(once);
  const thrice = withResolvedGen(twice);
  for (const p of once.people) {
    assert.equal(twice.people.find((x) => x.id === p.id).gen, p.gen, p.name);
    assert.equal(thrice.people.find((x) => x.id === p.id).gen, p.gen, p.name);
  }
});

test('★ 改关系后重新加载，世次要跟着变（铁律「改一处全树自动更新」）', () => {
  /* 复现场景：一个与「我」不连通的旁支，先存盘，再给他加个儿子。
     正确的世次由「分量内最深后代 = 第 0 代」锚定，所以加完儿子后是 旁支=1、子=0。
     若 gen 被固化，旁支会锁死在存盘那一刻的值，儿子跟着偏一代 ——
     同一份关系，存没存过盘算出两种答案。 */
  const base = {
    version: '1.0', viewpoint: 'me',
    people: [
      { id: 'me',   name: '我',   sex: 'M', gen: 0 },
      { id: 'side', name: '旁支', sex: 'M', gen: null },
    ],
    relationships: [],
  };
  const son = { id: 'son', name: '旁支子', sex: 'M', gen: null };
  const sonRel = { a: 'side', b: 'son', type: 'parent' };

  // 路径 A：一直在内存里，直接加儿子
  const memDs = withResolvedGen(normalizeDataset({
    ...base, people: [...base.people, son], relationships: [sonRel],
  }));
  const genA = (id) => memDs.people.find((p) => p.id === id).gen;

  // 路径 B：先存盘 → 重新加载 → 再加同一个儿子
  const saved = roundTrip(withResolvedGen(normalizeDataset(base)));
  const diskDs = withResolvedGen(normalizeDataset({
    ...saved, people: [...saved.people, son], relationships: [sonRel],
  }));
  const genB = (id) => diskDs.people.find((p) => p.id === id).gen;

  assert.equal(genA('side'), genB('side'),
    `同一份关系：没存过盘算出第 ${genA('side')} 代，存过盘算出第 ${genB('side')} 代 —— 世次被快照锁死了`);
  assert.equal(genA('son'), genB('son'),
    `同一份关系：没存过盘算出第 ${genA('son')} 代，存过盘算出第 ${genB('son')} 代 —— 世次被快照锁死了`);
  assert.equal(genB('son'), 0, '旁支的儿子应当落在第 0 代（分量最深后代锚定）');
});

test('示例数据往返一次，世次不漂移', () => {
  const before = withResolvedGen(normalizeDataset(SAMPLE_DATA));
  const after = withResolvedGen(roundTrip(before));
  for (const p of before.people) {
    const got = after.people.find((x) => x.id === p.id).gen;
    assert.equal(got, p.gen, `${p.name} 往返一次后世次从 ${p.gen} 变成了 ${got}`);
  }
});

/* ========================================================= */
/* 7. 边界与破坏性输入（验收新写项 TC-0909 / 0913 / 0914 / 0112） */
/* ========================================================= */

group('7. 边界与破坏性输入');

test('TC-0909 规则表外的血亲路径：显示「关系待确认」+ 关系描述，绝不编造', () => {
  /* 母亲堂兄之女 —— 血缘路径 M F B S D，80 条规则表不覆盖。
     铁律：匹配不到就输出关系描述，std 必须为空。 */
  const far = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      { id: 'me',   name: '我',     sex: 'M', gen: 0 },
      { id: 'mom',  name: '妈妈',   sex: 'F', gen: null },
      { id: 'mgf',  name: '外公',   sex: 'M', gen: null },
      { id: 'mgfb', name: '外公的兄弟', sex: 'M', gen: null },
      { id: 'unc',  name: '堂舅',   sex: 'M', gen: null },
      { id: 'girl', name: '堂舅的女儿', sex: 'F', gen: null },
    ],
    relationships: [
      { a: 'mom',  b: 'me',   type: 'parent' },
      { a: 'mgf',  b: 'mom',  type: 'parent' },
      { a: 'mgfb', b: 'unc',  type: 'parent' },
      { a: 'unc',  b: 'girl', type: 'parent' },
    ],
  }));
  const farIdx = buildIndex(far);
  const k = deriveKinship(far, farIdx, 'me', 'girl');
  assert.equal(k.ok, false, '规则表外的路径不该假装成功');
  assert.equal(k.kind, 'unknown');
  assert.equal(k.std, '', 'std 必须为空 —— 编造称呼即违反铁律');
  assert.ok(k.dialect.includes('待确认'), `dialect 应为「关系待确认」，实际「${k.dialect}」`);
  assert.ok(k.desc && k.desc.length > 0, '必须给出关系描述');
  assert.ok(!/堂妹|堂姐|表妹|表姐/.test(k.dialect + k.std),
    '绝不能把堂表姐妹的称呼安到规则表外路径上');
});

test('TC-0909 超过两跳姻亲（MAX_AFFINAL_DEPTH）：不猜，出待确认', () => {
  /* 妻子的哥哥的妻子的哥哥 = W B W B，需要 3 跳姻亲，超出搜索深度。
     预期走「找不到连通路径」兜底，同样不许编造。 */
  const aff = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me',
    people: [
      { id: 'me',   name: '我',   sex: 'M', gen: 0 },
      { id: 'wife', name: '妻子', sex: 'F', gen: null },
      { id: 'wb',   name: '内兄', sex: 'M', gen: null },
      { id: 'wbs',  name: '内兄的妻子', sex: 'F', gen: null },
      { id: 'wbsb', name: '内兄的妻兄', sex: 'M', gen: null },
    ],
    relationships: [
      { a: 'wife', b: 'me',   type: 'spouse' },
      { a: 'wb',   b: 'wbs',  type: 'spouse' },
      { a: 'wbsb', b: 'wbs',  type: 'parent' },
    ],
  }));
  const affIdx = buildIndex(aff);
  const k = deriveKinship(aff, affIdx, 'me', 'wbsb');
  assert.equal(k.ok, false, '超深度姻亲不该假装成功');
  assert.equal(k.kind, 'unknown');
  assert.equal(k.std, '');
  assert.ok(k.dialect.includes('待确认'), `dialect 应为「关系待确认」，实际「${k.dialect}」`);
});

test('TC-0913 特殊字符姓名：往返无损、不崩、不触发注入（core 层）', () => {
  const evil = [
    `'<script>alert(1)</script>`,
    `x'); DROP TABLE people;--`,
    `"引号'混合<>&amp;%$#@!~^*()`,
    `emoji😀家族\u0000\u0001控制符`,   // eslint-disable-line no-control-regex
  ];
  const people = evil.map((name, i) => ({
    id: `evil${i}`, name, sex: i % 2 ? 'F' : 'M', gen: null,
  }));
  people.unshift({ id: 'root', name: '根', sex: 'M', gen: 0 });
  const rels = people.slice(1).map((p) => ({ a: 'root', b: p.id, type: 'parent' }));
  const ds = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'root', people, relationships: rels,
  }));

  // ① 称谓推导不崩（走得到每一个人的路径）
  const eIdx = buildIndex(ds);
  for (const p of people) {
    const k = deriveKinship(ds, eIdx, 'root', p.id);
    assert.ok(k && typeof k.dialect === 'string', `${p.id} 称谓推导异常`);
  }
  // ② serialize → JSON.parse → normalizeDataset 往返，姓名字节级一致
  //    （normalizeDataset 的 str() 会 trim 首尾空格，那是录入清洗的既定行为，
  //      所以这里对的是「已规范化后的值」，重复 normalize 必须幂等。）
  const back = normalizeDataset(JSON.parse(serialize(ds)));
  for (const p of ds.people) {
    const got = back.people.find((x) => x.id === p.id);
    assert.ok(got, `${p.id} 往返后丢失`);
    assert.equal(got.name, p.name, `姓名被改写：期望 ${JSON.stringify(p.name)} 实际 ${JSON.stringify(got.name)}`);
  }
  // ③ 导出文本本身必须是合法 JSON（引号/控制符已正确转义）
  const text = serialize(ds);
  assert.doesNotThrow(() => JSON.parse(text), 'serialize 产出了非法 JSON');
});

test('TC-0914 超长姓名（50/100/200 字）：不崩、世次仍推导、布局硬约束不破', () => {
  const mk = (n) => '林'.repeat(n);
  const people = [
    { id: 'pa', name: mk(50), sex: 'M', gen: null },
    { id: 'pb', name: mk(100), sex: 'F', gen: null },
    { id: 'me', name: mk(200), sex: 'M', gen: 0 },
    { id: 'son', name: mk(1) + '子', sex: 'M', gen: null },
  ];
  const longDs = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'me', people,
    relationships: [
      { a: 'pa', b: 'me', type: 'parent' },
      { a: 'pb', b: 'me', type: 'parent' },
      { a: 'me', b: 'son', type: 'parent' },
    ],
  }));
  assert.equal(longDs.people.find((p) => p.id === 'pa').gen, 1, '50 字姓名的世次推导挂了');
  assert.equal(longDs.people.find((p) => p.id === 'son').gen, -1, '子辈世次推导挂了');

  const tree = buildMainTree(longDs, 'me');
  const lay = layoutTree(tree);
  const v = verifyLayout(tree, lay);
  assert.equal(v.issues.length, 0, '超长姓名导致布局硬约束被破坏：\n  ' + v.issues.join('\n  '));

  // 往返不崩不截断
  const back = normalizeDataset(JSON.parse(serialize(longDs)));
  assert.equal(back.people.find((p) => p.id === 'me').name.length, 200, '200 字姓名被截断');
});

test('TC-0112 极端数据布局：8 代单链 + 一人 12 子女，硬约束仍满足', () => {
  const people = [];
  const rels = [];
  // 8 代单链：g0 → g1 → … → g7（g7 是锚点「我」）
  for (let i = 0; i < 8; i++) {
    people.push({ id: `g${i}`, name: `第${i}代`, sex: 'M', gen: null });
    if (i > 0) rels.push({ a: `g${i - 1}`, b: `g${i}`, type: 'parent' });
  }
  // g2 有 12 个子女（其中一个就是 g3，另外 11 个是旁支）
  for (let i = 0; i < 11; i++) {
    const id = `c${i}`;
    people.push({ id, name: `子女${i}`, sex: i % 2 ? 'F' : 'M', gen: null });
    rels.push({ a: 'g2', b: id, type: 'parent' });
  }
  const bigDs = withResolvedGen(normalizeDataset({
    version: '1.0', viewpoint: 'g7', people, relationships: rels,
  }));
  assert.equal(bigDs.people.find((p) => p.id === 'g0').gen, 7, '8 代链顶端世次不对');
  assert.equal(bigDs.people.find((p) => p.id === 'g7').gen, 0, '锚点世次不为 0');

  const tree = buildMainTree(bigDs, 'g7');
  const lay = layoutTree(tree);
  assert.equal(Object.keys(lay.pos).length, tree.people.length, '有人没落位');
  const v = verifyLayout(tree, lay);
  assert.equal(v.issues.length, 0, '极端数据布局问题：\n  ' + v.issues.join('\n  '));

  // 同代 12 个子女 + 1 个 g3，共 13 人同排，x 应当互不相同（不重叠）
  const row = tree.people.filter((p) => lay.pos[p.id].y === lay.pos.g3.y);
  const xs = row.map((p) => lay.pos[p.id].x).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) {
    assert.ok(xs[i] - xs[i - 1] > 0, '同代节点 x 重叠');
  }
});

/* ========================================================= */
/* 8. 导出图片（v0.2.63）                                      */
/* ---------------------------------------------------------
 * 这个功能的全部风险都在「尺寸算错」上，而算错的三个后果
 * （图被切掉半边 / 整棵树跑出画面 / 画出一张黑图）肉眼看代码
 * 一个都看不出来。只能钉在这里。
 * ========================================================= */

group('8. 导出图片 · 尺寸与落点');

/** 真实主树的量级：横向约 5000px，且 minX 是负数（见 README 实测记录） */
const BIG = { minX: -1858, minY: -32, maxX: 3098, maxY: 3800 };

test('大尺寸原样出图；负坐标必须补到留白处（否则整棵树出画）', () => {
  const p = imagePlan({ bounds: BIG, scale: 1 });
  assert.equal(p.ok, true);
  assert.equal(p.clamped, false);
  assert.equal(p.cssWidth, 3098 + 1858 + PAD * 2, '容器宽 = 内容宽 + 两侧留白');
  assert.equal(p.pixelWidth, p.cssWidth, '1 倍时像素数应等于 CSS 尺寸');
  /* ⚠️ 这一条是实测踩出来的：minX 为负时不补偿，克隆出来的画布会
     整体右移 1858px，图里一片空白。 */
  assert.equal(p.offsetX, PAD + 1858, '负坐标要补到留白处');
  assert.equal(p.offsetY, PAD + 32);
});

test('2 倍只翻倍像素，容器尺寸与落点不变', () => {
  const one = imagePlan({ bounds: BIG, scale: 1 });
  const two = imagePlan({ bounds: BIG, scale: 2 });
  assert.equal(two.cssWidth, one.cssWidth, '容器尺寸与清晰度无关');
  assert.equal(two.offsetX, one.offsetX, '落点与清晰度无关');
  assert.equal(two.pixelWidth, one.pixelWidth * 2);
  assert.equal(two.pixelHeight, one.pixelHeight * 2);
});

test('超过画布上限：自动降档并说清降到几倍，不静默出黑图', () => {
  const wide = { minX: 0, minY: 0, maxX: 12000, maxY: 900 };
  const p = imagePlan({ bounds: wide, scale: 2 });
  assert.equal(p.ok, true);
  assert.equal(p.clamped, true);
  assert.ok(p.scale < 2, `降档后仍是 ${p.scale} 倍，等于没降`);
  assert.ok(p.pixelWidth <= MAX_DIM, `宽 ${p.pixelWidth} 仍超上限 ${MAX_DIM}`);
  assert.ok(p.note.includes(String(p.scale)), '必须告诉用户降到了几倍');
});

test('1 倍就已经超（极端宽谱）：降到 0.5 倍，总算能出图', () => {
  const huge = { minX: 0, minY: 0, maxX: 20000, maxY: 100 };
  const p = imagePlan({ bounds: huge, scale: 1 });
  assert.equal(p.ok, true);
  assert.equal(p.scale, 0.5);
  assert.ok(p.pixelWidth <= MAX_DIM, `宽 ${p.pixelWidth} 仍超上限`);
  assert.ok(p.pixelWidth * p.pixelHeight <= MAX_AREA, '面积也必须在内');
});

test('连 0.5 倍都放不下：如实报「太大」，不硬撑', () => {
  /* 0.5 倍仍需 20064px —— 需要的原始宽度超过 3 万像素 */
  const absurd = { minX: 0, minY: 0, maxX: 40000, maxY: 40000 };
  const p = imagePlan({ bounds: absurd, scale: 1 });
  assert.equal(p.ok, false);
  assert.ok(p.error.includes('太大'), `错误要说清是太大，实际「${p.error}」`);
});

test('空页 / 缺字段 / 全零包围盒：一律判为不可导出，不产出白纸', () => {
  for (const bad of [null, undefined, {}, { minX: 'x', minY: 0, maxX: 1, maxY: 1 },
                     { minX: 0, minY: 0, maxX: 0, maxY: 0 }]) {
    const p = imagePlan({ bounds: bad, scale: 1 });
    assert.equal(p.ok, false, `${JSON.stringify(bad)} 应当被判为不可导出`);
    assert.ok(p.error, '必须带一句人话错误');
  }
});

test('scale 给 0 / 负数 / NaN / 字符串：退回 1 倍，不崩', () => {
  for (const s of [0, -3, NaN, 'abc', null, undefined]) {
    const p = imagePlan({ bounds: BIG, scale: s });
    assert.equal(p.ok, true);
    assert.equal(p.scale, 1, `scale=${String(s)} 应当退回 1 倍，实际 ${p.scale}`);
  }
});

group('9. 导出图片 · 文件名');

test('家族名里的非法字符和空格：洗成能用的片段', () => {
  assert.equal(safeFileToken('配偶家族 · 王五'), '配偶家族-王五');
  assert.equal(safeFileToken('a/b:c*d?e"f<g>h|i'), 'abcdefghi', 'Windows 非法字符全要洗掉');
  assert.equal(safeFileToken('  两头空白  '), '两头空白');
  assert.equal(safeFileToken(''), '');
});

test('图片文件名：家族谱-家族名-日期.png，家族名为空有兜底', () => {
  const d = new Date(2026, 9, 12);
  assert.equal(imageFilename('配偶家族 · 王五', d), '家族谱-配偶家族-王五-20261012.png');
  assert.equal(imageFilename('', d), '家族谱-当前家族-20261012.png');
  assert.ok(imageFilename('x', d).endsWith('.png'), '必须是 .png —— 主进程按后缀写文件');
});

test('日期戳补零：1 月 5 日不是 202615', () => {
  assert.equal(dateStamp(new Date(2026, 0, 5)), '20260105');
  assert.equal(dateStamp(new Date(2026, 11, 31)), '20261231');
});

/* ========================================================= */
/* 10. 拼音静态表                                              */
/* ========================================================= */

group('10. 拼音静态表');

test('表覆盖 GB2312 一级汉字 3755 字', () => {
  assert.equal(Object.keys(PINYIN).length, 3755);
});

test('每个键都是汉字，没有混进非汉字', () => {
  const bad = Object.keys(PINYIN).filter((ch) => !/[\u4e00-\u9fff]/.test(ch));
  assert.equal(bad.length, 0, `混进了：${bad.join('')}`);
});

test('每个值至少一个读音，且全是非空小写字母（无声调、无空格）', () => {
  const bad = [];
  for (const [ch, v] of Object.entries(PINYIN)) {
    const parts = v.split('|');
    if (!v || parts.some((x) => !/^[a-z]{1,6}$/.test(x))) bad.push(`${ch}=${JSON.stringify(v)}`);
  }
  assert.equal(bad.length, 0, `不合格的有 ${bad.length} 个：${bad.slice(0, 20).join(', ')}`);
});

test('多音字确实留了 2 个读音（长/单/解/曾/重）', () => {
  assert.equal(PINYIN['长'], 'chang|zhang');
  assert.equal(PINYIN['单'], 'dan|shan');
  assert.equal(PINYIN['解'], 'jie|xie');
  assert.equal(PINYIN['曾'], 'ceng|zeng');
  assert.equal(PINYIN['重'], 'zhong|chong');
});

test('ü 的两种敲法都在（lü 能打 lu 也能打 lv）', () => {
  assert.equal(PINYIN['绿'], 'lu|lv', '绿必须 lu / lv 都收');
  assert.equal(PINYIN['女'], 'nu|nv', '女必须 nu / nv 都收');
  for (const ch of Object.keys(PINYIN)) {
    assert.ok(!/[üê]/.test(PINYIN[ch]), `${ch} 的读音里还留着 ü/ê：${PINYIN[ch]}`);
  }
});

test('表外字取到的是空数组，不是 null（省得每处都判两种）', () => {
  /* 龘 不在 GB2312 一级字里 —— 它就是「生僻字」那一类真实存在的样本 */
  assert.deepEqual(readingsOf('龘'), []);
  assert.equal(PINYIN['龘'], undefined);
  assert.deepEqual(readingsOf('李'), ['li']);
  assert.deepEqual(readingsOf('长'), ['chang', 'zhang']);
});

test('常见姓氏读音抽查（拼错一个，用户就搜不到人）', () => {
  const want = {
    王: 'wang', 李: 'li', 张: 'zhang', 刘: 'liu', 陈: 'chen', 杨: 'yang',
    黄: 'huang', 赵: 'zhao', 吴: 'wu', 徐: 'xu', 孙: 'sun', 马: 'ma',
    朱: 'zhu', 胡: 'hu', 郭: 'guo', 何: 'he', 高: 'gao', 林: 'lin',
    罗: 'luo', 郑: 'zheng', 梁: 'liang', 宋: 'song', 谢: 'xie', 韩: 'han',
  };
  for (const [ch, py] of Object.entries(want)) {
    assert.ok(PINYIN[ch]?.split('|').includes(py), `${ch} 应含 ${py}，实际 ${PINYIN[ch]}`);
  }
});

test('表体积在 64 KB 以内（超了先查是不是混进整份字典）', () => {
  const kb = Buffer.byteLength(
    readFileSync(new URL('../src/core/data/pinyin.js', import.meta.url), 'utf8')) / 1024;
  assert.ok(kb < 64, `实际 ${kb.toFixed(1)} KB`);
  assert.ok(kb > 30, `只有 ${kb.toFixed(1)} KB，像是没生成全`);
});

/* ========================================================= */
/* 11. 搜索 · 姓名与称谓                                       */
/* ========================================================= */

group('11. 搜索 · 姓名与称谓');

/** 测试用称谓Map（示例数据，视角人 = 数据里的 viewpoint） */
const kinAll = deriveAllKinships(ds, ds.viewpoint);

/** 测试用作用域：给三个 id 分配 主树 / 姻亲 / 游离，方便把排序三条钉死 */
const SCOPE = { p_ldgs: 'main', p_lc: 'ex-wife', p_zws: null };
const scopeOf = (id) => (id in SCOPE ? SCOPE[id] : 'main');
const scopeLabel = (k) => (k === 'main' ? '本家族' : k ? '其他家族' : '不在任何家族页');

const namesOf = (hits) => hits.map((h) => h.name);
const hitOnOf = (hits, name) => hits.find((h) => h.name === name)?.hitOn;
const query = (s) => search({ people: ds.people, kinship: kinAll, query: s, scopeOf, scopeLabel });

test('姓名子串命中，命中途径是 name', () => {
  const { hits } = query('李慧');
  assert.ok(hits.length >= 2, '李慧兰 / 李慧芳 都该在');
  assert.ok(hits.every((h) => h.hitOn === 'name'));
  assert.deepEqual(namesOf(hits).sort(), ['李慧兰', '李慧芳']);
});

test('称谓子串命中，命中途径是 call', () => {
  const { hits } = query('嫂子');
  assert.ok(hits.length >= 1, '示例数据里有嫂子');
  assert.ok(hits.every((h) => h.hitOn === 'call'));
});

test('称谓推导失败时，兜底文本不得参与匹配', () => {
  /* 不能拿「（关系待确认）」去匹配 —— 否则搜这几个字会把所有算不出
     称谓的人全捞出来。单造一个这样的 kinship 来验。 */
  const broken = new Map([['p_ldgd', { ok: false, dialect: '（关系待确认）', std: '', desc: '', note: '' }]]);
  const r = search({ people: ds.people, kinship: broken, query: '关系待确认', scopeOf });
  assert.equal(r.hits.length, 0, '搜「关系待确认」不该命中任何人');
});

test('空查询串 / 纯空白：一条都不返回', () => {
  assert.equal(query('').hits.length, 0);
  assert.equal(query('   ').hits.length, 0);
});

test('查无此人：空数组，不报错', () => {
  const r = query('zzzz不存在的名字');
  assert.deepEqual(r.hits, []);
  assert.deepEqual(r.exact, []);
});

test('排序第 1 条：主树 → 姻亲 → 游离', () => {
  const { hits } = query('林');
  const keys = hits.map((h) => h.scopeKey);
  const rank = (k) => (k === 'main' ? 0 : k ? 1 : 2);
  for (let i = 1; i < keys.length; i++) {
    assert.ok(rank(keys[i - 1]) <= rank(keys[i]),
      `第 ${i} 条排序错了：${keys[i - 1]} 排在 ${keys[i]} 前面`);
  }
});

test('排序第 2 条：姓名命中 → 称谓命中', () => {
  /* 「林志」命中 4 个人的姓名；同一页里称谓命中的人必排其后 */
  const { hits } = query('林志');
  const firstCall = hits.findIndex((h) => h.hitOn === 'call');
  if (firstCall >= 0) {
    assert.ok(hits.slice(0, firstCall).every((h) => h.hitOn === 'name'),
      '称谓命中的一律排在姓名命中之后');
  } else {
    assert.ok(hits.every((h) => h.hitOn === 'name'), '没有称谓命中时全是姓名命中');
  }
});

test('排序第 3 条：生年早的在前，无生年的最后', () => {
  const { hits } = query('林');
  const years = hits.filter((h) => h.scopeKey === 'main').map((h) => h.year);
  const known = years.filter((y) => y != null);
  const unknownAt = years.indexOf(null);
  if (unknownAt >= 0) {
    assert.ok(years.slice(unknownAt).every((y) => y == null), '无生年的只能排在同组末尾');
  }
  for (let i = 1; i < known.length; i++) {
    assert.ok(known[i - 1] <= known[i], `同组内生年必须升序：${known[i - 1]} 在 ${known[i]} 前面`);
  }
});

test('exact 只认姓名全等：拼音全等不算、子串不算', () => {
  assert.equal(query('李慧兰').exact.length, 1, '姓名全等且唯一 → exact 命中一条');
  assert.equal(query('李慧').exact.length, 0, '子串不算全等');
});

test('★ 搬迁对拍：core/search.js 与搬迁前的 app.js 内联实现结果完全一致', () => {
  /* 旧实现的排序只有两档（name / call），本change 才引入第三档 pinyin。
     对拍只用**纯汉字查询**（拼音撞不上的），比对命中途径与顺序，
     有任何差异就改 core —— 不许改断言迁就。 */
  const legacyCollect = (s) => {
    const out = [];
    for (const p of ds.people) {
      const name = p.name || '未知';
      const k = kinAll.get(p.id);
      const call = k?.ok ? (k.dialect || '') : '';
      const std = k?.ok ? (k.std || '') : '';
      let hitOn = null;
      if (name.includes(s)) hitOn = 'name';
      else if (call.includes(s) || std.includes(s)) hitOn = 'call';
      if (!hitOn) continue;
      const scopeKey = scopeOf(p.id);
      out.push({
        name, hitOn, scopeKey, year: birthYear(p),
        scopeLabel: scopeLabel(scopeKey), call, hint: k?.desc || k?.note || '',
      });
    }
    const rank = (h) => [h.scopeKey === 'main' ? 0 : h.scopeKey ? 1 : 2, h.hitOn === 'name' ? 0 : 1, h.year ?? 9999];
    return out.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || a.name.localeCompare(b.name, 'zh');
    });
  };

  for (const s of ['林', '李慧', '王', '林志', '建国', '嫂子', '姑姑', '秀英', '不存在']) {
    const legacy = legacyCollect(s);
    const now = collectHits({ people: ds.people, kinship: kinAll, query: s, scopeOf, scopeLabel });
    assert.deepEqual(now.map((h) => h.name), legacy.map((h) => h.name),
      `查询「${s}」的命中顺序变了`);
    assert.deepEqual(now.map((h) => h.hitOn), legacy.map((h) => h.hitOn),
      `查询「${s}」的命中途径变了`);
    assert.deepEqual(now.map((h) => h.year), legacy.map((h) => h.year),
      `查询「${s}」的生年排序变了`);
  }
});

/* ========================================================= */
/* 12. 搜索 · 拼音                                            */
/* ========================================================= */

group('12. 搜索 · 拼音');

/** 造一份只含给定人员的临时数据集，省得改示例数据 */
const miniDs = (people) => withResolvedGen(normalizeDataset({ people, relationships: [] }));

test('候选串：全拼 + 首字母（首字母由全拼派生，一张表就够）', () => {
  assert.deepEqual(pinyinForms('李慧兰'), { full: ['lihuilan'], initials: ['lhl'] });
  assert.deepEqual(pinyinForms('王秀英'), { full: ['wangxiuying'], initials: ['wxy'] });
});

test('候选串：多音字每个读音各来一遍（李长顺 → chang / zhang）', () => {
  const f = pinyinForms('李长顺');
  assert.deepEqual([...f.full].sort(), ['lichangshun', 'lizhangshun']);
  assert.deepEqual([...f.initials].sort(), ['lcs', 'lzs']);
});

test('全拼命中：lichangshun → 李长顺', () => {
  const { hits } = query('lichangshun');
  assert.ok(hits.some((h) => h.name === '李长顺' && h.hitOn === 'pinyin'), '李长顺应被全拼命中');
});

test('首字母命中：lcs → 李长顺', () => {
  const { hits } = query('lcs');
  assert.ok(hits.some((h) => h.name === '李长顺' && h.hitOn === 'pinyin'));
});

test('多音字两读各自都能搜到（zhangshun 也认）', () => {
  const { hits } = query('lizhangshun');
  assert.ok(hits.some((h) => h.name === '李长顺'), '长读 zhang 时也要能搜到');
});

test('★ 拼音只做**连续片段**匹配：掐头去尾认，掐中间不认', () => {
  /* 口径要说准 —— 「不做中间省略」不等于「掐头去尾也不认」：
     候选串的连续子串一律命中（changshun / ichangshun 都是连续的），
     只有掐掉**中间**音节（lngshun、lngshn）才不命中 —— 那是猜省略位置，
     猜错就等于替用户挑人。 */
  assert.ok(query('lcs').hits.length > 0, '对照组：完整首字母能命中');
  assert.ok(query('changshun').hits.length > 0, '掐掉开头仍是连续片段，应命中');
  assert.ok(query('lichangsh').hits.length > 0, '掐掉结尾仍是连续片段，应命中');
  assert.equal(query('lngshun').hits.length, 0, '掐中间不认');
  assert.equal(query('lcsn').hits.length, 0, '掐中间也不认');
});

test('生僻字：整条退出拼音匹配，不跳字', () => {
  /* 「龘」不在表里。李龘必须**一个拼音候选都不产出** ——
     跳字拼出 "li" 会把「李」和「李龘」混成一个人。 */
  assert.deepEqual(pinyinForms('李龘'), { full: [], initials: [] });
  assert.deepEqual(pinyinForms('龘'), { full: [], initials: [] });

  const people = [{ id: 'a', name: '李龘', sex: 'M' }, { id: 'b', name: '李明', sex: 'M' }];
  const d = miniDs(people);
  const kmap = new Map();
  const r = search({ people: d.people, kinship: kmap, query: 'li', scopeOf: () => 'main' });
  assert.equal(r.hits.some((h) => h.id === 'a'), false, '李龘不该被 li 命中');
  assert.equal(r.hits.some((h) => h.id === 'b'), true, '李明仍该被 li 命中');
});

test('生僻字者仍可用汉字子串搜到（能力没丢）', () => {
  const people = [{ id: 'a', name: '李龘', sex: 'M' }];
  const d = miniDs(people);
  const r = search({ people: d.people, kinship: new Map(), query: '李龘', scopeOf: () => 'main' });
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].hitOn, 'name');
});

test('拼音不匹配称谓（搜 daye 搜不到「大爷」那一类）', () => {
  const { hits } = query('daye');
  assert.equal(hits.length, 0, '称谓没有拼音，拼音只服务姓名');
});

test('★ 三种命中途径互斥：拉丁查询只可能拼音命中，中文查询不可能拼音命中', () => {
  /* 这是本次实现撞出来的事实，值得钉死：
     姓名命中要求查询串是姓名的**汉字**子串，拼音命中要求查询串是**拉丁字母**
     且含在拼音候选里 —— 同一个查询串不可能同时满足两者。所以排序第 2 条里
     「拼音」那一档，实际永远观察不到（它只在有人起拉丁名时才可能与其它档相遇）。 */
  const r1 = query('lcs');
  assert.ok(r1.hits.length > 0, '拉丁查询有命中');
  assert.ok(r1.hits.every((h) => h.hitOn === 'pinyin'),
    `拉丁查询不该出现姓名/称谓命中，实际：${[...new Set(r1.hits.map((h) => h.hitOn))].join(',')}`);

  const r2 = query('林志');
  assert.ok(r2.hits.length > 0, '中文查询有命中');
  assert.ok(r2.hits.every((h) => h.hitOn === 'name' || h.hitOn === 'call'),
    `中文查询不该出现拼音命中，实际：${[...new Set(r2.hits.map((h) => h.hitOn))].join(',')}`);
});

test('拼音命中行带回 form（界面要展示命中的那一个拼音串）', () => {
  const { hits } = query('lichangshun');
  assert.equal(hits[0].name, '李长顺');
  assert.equal(hits[0].pinyinForm, 'lichangshun');
  assert.equal(query('lcs').hits[0].pinyinForm, 'lcs');
  assert.equal(query('林志').hits[0].pinyinForm, '', '姓名 / 称谓命中不带拼音串');
});

test('★ 拼音全等不算 exact（回车不直接跳转）', () => {
  const r = query('lichangshun');
  assert.equal(r.hits.length, 1, '全拼能命中');
  assert.equal(r.exact.length, 0, '但 exact 必须为空 —— 拼音全等不许直接跳');
  assert.equal(query('李长顺').exact.length, 1, '姓名全等照旧 exact');
});

/* ========================================================= */
/* 汇总                                                        */
/* ========================================================= */

console.log('\n' + '─'.repeat(56));
if (failures.length === 0) {
  console.log(`\x1b[32m\x1b[1m全部通过\x1b[0m  ${passed} passed`);
  process.exit(0);
} else {
  console.log(`\x1b[31m\x1b[1m${failures.length} 项失败\x1b[0m  ${passed} passed, ${failures.length} failed`);
  for (const f of failures) {
    console.log(`\n\x1b[31m[${f.group}] ${f.name}\x1b[0m`);
    console.log('  ' + f.message);
  }
  process.exit(1);
}
