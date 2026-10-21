/**
 * =========================================================
 * 存储层自测 · tests/db.test.js
 * ---------------------------------------------------------
 * 直接 `node tests/db.test.js`，**不需要 Electron**。
 * 这是刻意的设计：electron/db.js 与 paths.js 都不 import electron，
 * 所以能像 core 层一样在纯 Node 里秒级验证。
 *
 * 覆盖：
 *   1. 数据目录解析与备份策略
 *   2. 表结构（不是「存了个 JSON blob」，是真的列）
 *   3. 数据集 → 表 → 数据集 往返无损（含 null / 空值 / 关键字列名这些坑）
 *   4. 落盘是原子的，产出的是标准 SQLite 文件
 *   5. 事务性：写坏的时候不会留下半截数据
 * =========================================================
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GenogramStore, SCHEMA_VERSION, META_SEEDED } from '../electron/db.js';
import {
  resolveDataDir, dataDirCandidates, ensureLayout, backupOnOpen,
  dbFile, bakFile, backupsDir, DEFAULT_DATA_DIR, C_DRIVE_DIR_NAME,
} from '../electron/paths.js';
import { normalizeDataset, serialize } from '../src/core/model.js';
import { SAMPLE_DATA } from '../src/data/sample.js';

/* ========================================================= */
/* 极简测试框架（与 tests/run.js 同款）                          */
/* ========================================================= */

let passed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

/** 支持 async 测试用例 */
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failures.push({ group: currentGroup, name, message: e.message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${String(e.message).split('\n')[0]}\x1b[0m`);
  }
}

/* ========================================================= */
/* 临时沙箱                                                    */
/* ========================================================= */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'genogram_dbtest_'));
const cleanup = () => {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* 忽略 */ }
};
process.on('exit', cleanup);

const sample = () => normalizeDataset(SAMPLE_DATA);

/* ========================================================= */
/* 1. 数据目录                                                  */
/* ========================================================= */

group('1. 数据目录解析与备份');

await test('有 D 盘时优先用 D:\\族谱pc端项目\\数据（能放 D 盘就不放 C 盘）', () => {
  const dir = resolveDataDir({ env: {}, hasD: true });
  assert.equal(dir, DEFAULT_DATA_DIR);
});

await test('没有 D 盘时退到 C 盘用户目录（打包给别人用时的常态）', () => {
  const fakeHome = path.join(sandbox, 'fakehome');
  const dir = resolveDataDir({ env: {}, home: fakeHome, hasD: false });
  assert.equal(dir, path.join(fakeHome, C_DRIVE_DIR_NAME));
  assert.ok(fs.existsSync(dir), '目录应被创建');
});

await test('候选顺序：环境变量 → D 盘 → C 盘用户目录 → userData', () => {
  const home = 'C:\\Users\\tester';
  const fb = path.resolve('C:\\Users\\tester\\AppData\\Roaming\\家族谱');
  assert.deepEqual(dataDirCandidates({ env: {}, fallback: fb, home, hasD: true }), [
    DEFAULT_DATA_DIR,
    path.join(home, C_DRIVE_DIR_NAME),
    fb,
  ]);
  assert.deepEqual(dataDirCandidates({ env: {}, fallback: fb, home, hasD: false }), [
    path.join(home, C_DRIVE_DIR_NAME),
    fb,
  ]);
  assert.deepEqual(
    dataDirCandidates({ env: { GENOGRAM_DATA_DIR: 'E:\\我的族谱' }, fallback: fb, home, hasD: true }),
    [path.resolve('E:\\我的族谱'), DEFAULT_DATA_DIR, path.join(home, C_DRIVE_DIR_NAME), fb]
  );
});

await test('环境变量 GENOGRAM_DATA_DIR 优先（便于测试 / 多库切换）', () => {
  const custom = path.join(sandbox, 'custom');
  const dir = resolveDataDir({ env: { GENOGRAM_DATA_DIR: custom } });
  assert.equal(dir, path.resolve(custom));
  assert.ok(fs.existsSync(dir), '目录应被创建');
});

await test('ensureLayout 建出 photos/ 与 backups/', () => {
  const d = path.join(sandbox, 'layout');
  ensureLayout(d);
  assert.ok(fs.existsSync(path.join(d, 'photos')));
  assert.ok(fs.existsSync(path.join(d, 'backups')));
});

await test('backupOnOpen：首次没有库时不报错、不建垃圾文件', () => {
  const d = path.join(sandbox, 'bk-empty');
  ensureLayout(d);
  const r = backupOnOpen(d);
  assert.deepEqual(r.made, []);
});

await test('backupOnOpen：二次打开产出 .bak 与当天快照', () => {
  const d = path.join(sandbox, 'bk-full');
  ensureLayout(d);
  fs.writeFileSync(dbFile(d), 'SQLite format 3\0fake');
  const r = backupOnOpen(d);
  assert.ok(fs.existsSync(bakFile(d)), '.bak 应生成');
  assert.ok(r.made.some((x) => x.startsWith('backups/')), '当天快照应生成');
  // 同一天再打开不应重复生成快照
  const r2 = backupOnOpen(d);
  assert.ok(!r2.made.some((x) => x.startsWith('backups/')), '同一天不重复快照');
  const files = fs.readdirSync(backupsDir(d));
  assert.equal(files.length, 1);
});

/* ========================================================= */
/* 2. 建库与表结构                                              */
/* ========================================================= */

group('2. 建库与表结构');

const dir = path.join(sandbox, 'main');
ensureLayout(dir);
const store = await GenogramStore.open(dir);

await test('打开后立刻产出 .db 文件（用户马上能看到自己的数据文件）', () => {
  assert.ok(fs.existsSync(dbFile(dir)));
  assert.ok(fs.statSync(dbFile(dir)).size > 0);
});

await test('产出的是标准 SQLite 文件（文件头 SQLite format 3）', () => {
  const head = fs.readFileSync(dbFile(dir)).subarray(0, 15).toString('latin1');
  assert.equal(head, 'SQLite format 3');
});

await test('空库 readDataset() 返回 null（交给上层走首次运行）', () => {
  assert.equal(store.readDataset(), null);
});

await test('三张表都建好了：people / relationships / meta', () => {
  const tables = store
    .selectAll("SELECT name FROM sqlite_master WHERE type='table'")
    .map((r) => r.name);
  for (const t of ['people', 'relationships', 'meta']) {
    assert.ok(tables.includes(t), `缺表 ${t}`);
  }
});

await test('people 是真正的列，不是「一个 JSON blob 字段」', () => {
  const cols = store.selectAll('PRAGMA table_info(people)').map((r) => r.name);
  for (const c of ['id', 'name', 'sex', 'birth', 'death', 'alive', 'gen', 'order_no', 'privacy']) {
    assert.ok(cols.includes(c), `缺列 ${c}`);
  }
  // 我们用的是数据库，不是文件柜
  assert.ok(!cols.includes('json') && !cols.includes('data'));
});

await test('SQL 关键字列名已规避（order → order_no，from → from_date）', () => {
  const pc = store.selectAll('PRAGMA table_info(people)').map((r) => r.name);
  const rc = store.selectAll('PRAGMA table_info(relationships)').map((r) => r.name);
  assert.ok(pc.includes('order_no'));
  assert.ok(!pc.includes('order'));
  assert.ok(rc.includes('from_date') && rc.includes('to_date'));
});

await test('关系表有 CHECK 约束：type 只能是 parent / spouse', () => {
  assert.throws(
    () => store.db.run("INSERT INTO relationships (a,b,type) VALUES ('x','y','cousin')"),
    /CHECK|constraint/i
  );
  assert.equal(store.selectAll('SELECT * FROM relationships').length, 0);
});

await test('meta 里记了 schema_version（留给以后迁移用）', () => {
  assert.equal(Number(store.getMeta('schema_version')), SCHEMA_VERSION);
});

await test('info() 报出库路径与规模', () => {
  const i = store.info();
  assert.equal(i.kind, 'sqlite');
  assert.equal(i.people, 0);
  assert.ok(i.path.endsWith('genogram.db'));
});

/* ========================================================= */
/* 3. 往返无损                                                  */
/* ========================================================= */

group('3. 数据集 → 表 → 数据集 往返');

await test('写入示例数据：人数与关系数对得上', () => {
  const ds = sample();
  const res = store.writeDataset(ds);
  assert.equal(res.ok, true, res.error);
  const i = store.info();
  assert.equal(i.people, ds.people.length);
  assert.equal(i.relationships, ds.relationships.length);
});

await test('读回来的数据与写入的语义一致（规范化后逐字段比对）', () => {
  const before = sample();
  const after = normalizeDataset(store.readDataset());
  assert.equal(after.viewpoint, before.viewpoint);
  assert.equal(after.people.length, before.people.length);
  assert.equal(after.relationships.length, before.relationships.length);

  const bById = new Map(before.people.map((p) => [p.id, p]));
  for (const p of after.people) {
    const b = bById.get(p.id);
    assert.ok(b, `读回来多出一个人 ${p.id}`);
    for (const k of ['name', 'sex', 'birth', 'death', 'alive', 'note', 'place', 'gen', 'order', 'privacy', 'expand']) {
      assert.deepEqual(p[k], b[k], `${p.id}.${k}：${JSON.stringify(p[k])} ≠ ${JSON.stringify(b[k])}`);
    }
  }
});

await test('关系方向没被搞反（parent 的 a 仍是父母一方）', () => {
  const after = normalizeDataset(store.readDataset());
  const rel = after.relationships.find((r) => r.b === 'p_me' && r.type === 'parent');
  assert.ok(rel, '「我」应该有一条 parent 入边');
  const parent = after.people.find((p) => p.id === rel.a);
  assert.ok(['p_f', 'p_m'].includes(parent.id), `我的父母应是 p_f/p_m，实际 ${parent.id}`);
});

await test('null 与空值不被写成字符串 "null"', () => {
  const ds = normalizeDataset({
    version: '1.0',
    viewpoint: 'x',
    people: [{ id: 'x', name: '甲', sex: 'M', gen: null, order: null, expand: null }],
    relationships: [],
  });
  store.writeDataset(ds);
  const row = store.selectAll('SELECT gen, order_no, expand FROM people WHERE id = ?', ['x'])[0];
  assert.equal(row.gen, null);
  assert.equal(row.order_no, null);
  assert.equal(row.expand, null);
  const back = normalizeDataset(store.readDataset()).people[0];
  assert.equal(back.gen, null);
  assert.equal(back.order, null);
});

await test('gen = 0 不会被当成「没填」（0 与 null 必须区分）', () => {
  store.writeDataset(normalizeDataset({
    version: '1.0', viewpoint: 'x',
    people: [{ id: 'x', name: '甲', sex: 'M', gen: 0, order: 0 }],
    relationships: [],
  }));
  const back = normalizeDataset(store.readDataset()).people[0];
  assert.equal(back.gen, 0);
  assert.equal(back.order, 0);
});

await test('photos 数组往返还是数组（不是被序列化成字符串）', () => {
  store.writeDataset(normalizeDataset({
    version: '1.0', viewpoint: 'x',
    people: [{ id: 'x', name: '甲', sex: 'M', photos: ['a.jpg', 'b.jpg'] }],
    relationships: [],
  }));
  const back = normalizeDataset(store.readDataset()).people[0];
  assert.deepEqual(back.photos, ['a.jpg', 'b.jpg']);
});

await test('中文与特殊字符不出乱码（UTF-8 全链路）', () => {
  const weird = '三太爷·「大舅子」/ 王 氏 100% <b>&amp;</b>';
  const multiline = "引号 '\"` 反斜杠 \\ 制表\t符\n第二行";
  store.writeDataset(normalizeDataset({
    version: '1.0', viewpoint: 'x',
    people: [{ id: 'x', name: weird, sex: 'F', note: multiline }],
    relationships: [],
  }));
  const back = normalizeDataset(store.readDataset()).people[0];
  assert.equal(back.name, weird);
  assert.equal(back.note, multiline);
});

await test('TC-0913 SQL 注入串作为姓名：参数化绑定挡住，表完好、字节级存回', () => {
  /* 验收新写项。注入串混在正常姓名里写入，若 db 层是字符串拼 SQL，
     people 表会被 DROP / 数据被改写。预期：表还在、行数对、名字原样。 */
  const evil = [
    `x'); DROP TABLE people;--`,
    `a' OR '1'='1`,
    `'; DELETE FROM relationships;--`,
  ];
  store.writeDataset(normalizeDataset({
    version: '1.0', viewpoint: 'x',
    people: [
      { id: 'x', name: '根', sex: 'M' },
      ...evil.map((name, i) => ({ id: `e${i}`, name, sex: 'F' })),
    ],
    relationships: [],
  }));
  // 表没被 DROP，行数 = 4
  assert.equal(store.info().people, 4, '注入串把 people 表搞坏了');
  // 每个邪恶名字字节级读回
  const back = normalizeDataset(store.readDataset());
  for (let i = 0; i < evil.length; i++) {
    const got = back.people.find((p) => p.id === `e${i}`);
    assert.ok(got, `e${i} 丢失`);
    assert.equal(got.name, evil[i], `注入串被改写：${JSON.stringify(evil[i])} -> ${JSON.stringify(got.name)}`);
  }
  // relationships 表也没被 DELETE（此时应为 0 行，但表必须存在）
  assert.doesNotThrow(() => store.selectAll('SELECT * FROM relationships'));
});

await test('viewpoint 记在 meta 里，换库后仍能恢复视角', () => {
  const ds = sample();
  store.writeDataset(ds);
  assert.equal(store.getMeta('viewpoint'), ds.viewpoint);
});

/* ========================================================= */
/* 4. 原子性与持久化                                            */
/* ========================================================= */

group('4. 落盘原子性与持久化');

await test('重开一个 store 能读到刚才写的数据（真的落盘了，不是只在内存）', async () => {
  const ds = sample();
  store.writeDataset(ds);
  const s2 = await GenogramStore.open(dir);
  const back = s2.readDataset();
  assert.ok(back, '重开后应该读得到数据');
  assert.equal(back.people.length, ds.people.length);
  s2.close();
});

await test('落盘不留 .tmp 残留', () => {
  store.writeDataset(sample());
  const left = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(left, []);
});

await test('重复写同一份数据不会累积重复行（整表重建语义）', () => {
  const ds = sample();
  store.writeDataset(ds);
  store.writeDataset(ds);
  assert.equal(store.info().people, ds.people.length);
  assert.equal(store.info().relationships, ds.relationships.length);
});

await test('重复关系被 UNIQUE 去重（同一对不能插两次）', () => {
  store.writeDataset(normalizeDataset({
    version: '1.0', viewpoint: 'a',
    people: [{ id: 'a', name: '甲', sex: 'M' }, { id: 'b', name: '乙', sex: 'M' }],
    relationships: [
      { a: 'a', b: 'b', type: 'parent' },
      { a: 'a', b: 'b', type: 'parent' },
    ],
  }));
  assert.equal(store.selectAll('SELECT * FROM relationships').length, 1);
});

await test('写坏数据时整表回滚，不留半截状态', () => {
  const good = sample();
  store.writeDataset(good);
  const nBefore = store.info().people;

  // 造一个「插入到一半必然抛错」的数据：photos 里放循环引用，
  // JSON.stringify 会抛 TypeError —— 此时 DELETE 已执行、INSERT 才做了一半，
  // 正是要验证「事务回滚」的场景。
  const circular = [];
  circular.push(circular);

  const res = store.writeDataset({
    version: '1.0', viewpoint: 'x',
    people: [
      { id: 'ok', name: '甲', sex: 'M' },
      { id: 'bad', name: '乙', sex: 'M', photos: circular },
    ],
    relationships: [],
  });
  assert.equal(res.ok, false, '应当报告失败而非静默吞掉');
  assert.ok(res.error, '应该带回错误原因');
  assert.equal(store.info().people, nBefore, '失败后仍应是原来那份数据');
  assert.equal(store.readDataset().people.length, nBefore, '读出来也该是原样');
});

/* ⚠️ 这里断言的是「清空后保持为空」，不是「回到 null」。
   以前断言回 null，等于把 bug 固化成了正确行为：
   空库 + null → app.js 判定首次运行 → 重启又把 36 人示例家族灌回来，
   用户点的「清空数据」等于没生效。见 META_SEEDED 的说明。 */
await test('clearAll() 清空后是「空数据集」而不是 null（不被误判成首次运行）', () => {
  store.writeDataset(sample());
  const r = store.clearAll();
  assert.equal(r.ok, true);

  const back = store.readDataset();
  assert.ok(back, '清空后应返回空数据集对象，不能是 null（null = 首次运行 = 会灌示例）');
  assert.equal(back.people.length, 0);
  assert.equal(back.relationships.length, 0);
  store.writeDataset(sample());   // 恢复，供后续用例用
});

await test('清空后重开数据库，仍然是空的（示例家族不会自己回来）', async () => {
  // 用独立沙箱：这条要模拟「关掉应用再打开」，不能复用共享 store
  const d2 = path.join(sandbox, 'cleared_then_reopen');
  ensureLayout(d2);

  const s1 = await GenogramStore.open(d2);
  s1.writeDataset(sample());
  s1.clearAll();
  s1.close();

  const s2 = await GenogramStore.open(d2);   // ← 相当于重启应用
  const back = s2.readDataset();
  assert.ok(back, '重开后不应为 null，否则会走首次运行分支');
  assert.equal(back.people.length, 0, '重开后必须还是空的，示例家族不能自己回来');
  s2.close();
});

await test('全新库（从未写入过）仍然返回 null —— 保留首次运行载入示例的行为', async () => {
  const d3 = path.join(sandbox, 'brand_new');
  ensureLayout(d3);
  const s = await GenogramStore.open(d3);
  assert.equal(s.readDataset(), null, '全新库应为 null，好让上层载入示例家族');
  assert.equal(s.getMeta(META_SEEDED), null);
  s.close();
});

await test('0 字节的库文件会被明确拒绝，而不是抛 SQLite 内部错', async () => {
  const bad = path.join(sandbox, 'bad');
  ensureLayout(bad);
  fs.writeFileSync(dbFile(bad), '');
  await assert.rejects(() => GenogramStore.open(bad), /空的/);
});

await test('导出的 JSON 文本可直接被 importFile 那套逻辑解析', () => {
  const text = serialize(sample());
  const raw = JSON.parse(text);
  const ds = normalizeDataset(raw);
  assert.ok(ds.people.length > 0);
  assert.equal(ds._orphans.length, 0, '示例数据不该有孤儿关系');
});

/* ========================================================= */
/* 5. 查询能力（用上数据库该有的样子）                            */
/* ========================================================= */

group('5. 用得上 SQL 的地方');

await test('按姓名查（走 idx_people_name 索引）', () => {
  store.writeDataset(sample());
  const rows = store.selectAll('SELECT id, name FROM people WHERE name = ?', ['林然']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'p_me');
});

await test('按关系查：某人的子女（这才是数据库该干的活）', () => {
  store.writeDataset(sample());
  const kids = store.selectAll(
    `SELECT p.name FROM relationships r JOIN people p ON p.id = r.b
      WHERE r.a = ? AND r.type = 'parent'`,
    ['p_g1']
  ).map((r) => r.name);
  assert.ok(kids.length >= 2, `曾祖父应至少有两个子女，实际 ${kids.length}`);
});

await test('配偶查询拿得到两边（无向关系存一条，查得到双向）', () => {
  store.writeDataset(sample());
  const spouse = store.selectAll(
    `SELECT a, b FROM relationships
      WHERE type = 'spouse' AND (a = ? OR b = ?)`,
    ['p_f', 'p_f']
  );
  assert.ok(spouse.length >= 1, '父亲应该有配偶记录');
});

await test('索引确实存在（不是白写的）', () => {
  const idx = store.selectAll('SELECT name FROM sqlite_master WHERE type = ?', ['index'])
    .map((r) => r.name);
  assert.ok(idx.includes('idx_rel_b'));
  assert.ok(idx.includes('idx_people_name'));
});

/* ========================================================= */
/* 收尾                                                        */
/* ========================================================= */

store.close();

console.log(
  `\n${failures.length ? '\x1b[31m' : '\x1b[32m'}` +
  `${failures.length ? failures.length + ' 项失败' : '全部通过'}\x1b[0m  ` +
  `${passed} passed`
);

if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · [${f.group}] ${f.name}\n    ${f.message}`);
  process.exitCode = 1;
}
