# 族谱软件 · PC 桌面版

不常回家、亲戚认不全、过年叫不出称呼 —— 这个软件解决的就是这件事。

核心**不是记录，是称谓自动推导**：只录「谁是谁的爸妈」「谁和谁是夫妻」，称呼实时算出来。
改一处关系，全树称谓自动更新。数据只存在你自己硬盘上，不联网、不上传。

---

## 0. 这份文档怎么用

仓库里有三份文档，各管一段，别混着看：

| 文档 | 管什么 | 什么时候看 |
|---|---|---|
| **本文件**（根 `README.md`） | 工程说明：怎么跑 · 代码结构 · 数据模型 · 测试 · 打包 · 排障 | 改代码、跑起来、出包、遇到怪问题 |
| [`app/README.md`](app/README.md) | 逐版本更新日志（v0.2.0 → 现在，95 条） | 想知道「某个行为是什么时候、为什么变的」 |
| `openspec/specs/` | 需求真源（5 个能力规格） | 改行为之前，先看规格怎么写的 |

阅读路线：

| 你的目的 | 直接看 |
|---|---|
| 第一次跑起来 | §2 快速开始 |
| 改某个功能 | §3 结构 → §4 原则 → §6 测试 |
| 出一版安装包 | §7 打包与发布 |
| 应用打不开 / 界面空白 | §8 环境坑与排障 |
| 了解「当初为什么这么定」 | §4.2 设计定稿 + 附录 A |

两条约定：

- 本文档随代码走，**改代码请同步改这里**。
- 附录 A「历史档案」**只增不改**：记录已定稿的结论与踩过的坑，新增往后追加，不回改旧条目。

---

## 1. 当前状态

| 项 | 值 |
|---|---|
| 源码版本 | **v0.2.85**（`app/package.json`） |
| 最近一次打包 | **v0.2.85** —— 含 F12 照片管理，`dist/` 里的 exe 与源码同版 |
| 仓库 | [github.com/13849799704/family-tree](https://github.com/13849799704/family-tree) —— 公开仓库，MIT 协议 |
| 平台 | Windows x64（Electron 44 + sql.js） |
| 数据 | 纯本地 SQLite，不联网、不上传 |

**已实现**：族谱树 · 点击查人 · 称谓自动显示 · 录入/编辑 · 家族切换（自己 / 母亲 / 妻子三页）·
缩放拖拽 · 搜索（姓名 / 称谓 / 拼音首字母与全拼）· 自动体检（F8）· 导出当前页为 PNG 图片 ·
多本谱管理（新建 / 切换 / 改名 / 删除进回收站）· 删除流程二次确认 · 照片管理（F12：添加 / 灯箱 /
设为主头像 / 删除 / 导出可选内联 / 导入自动恢复）· 桌面壳（原生菜单 / 系统对话框 /
本地 SQLite / 每日备份）· 打包成安装包。

**未实现**：分支折叠（F9）· 导出 PDF · 资料完整度提示（F13）· 代码签名 · 自动更新 ——
**逐项现状见 §9**。

---

## 2. 快速开始

```bash
cd app
npm install      # 4 个包：electron(壳) + sql.js(SQLite 的 WASM 版) + html2canvas(导出图片) + electron-builder(打包)
npm start        # 启动桌面应用
```

| 命令 | 用途 |
|---|---|
| `npm start` | 启动桌面应用（真 Electron） |
| `npm run web` | 网页版调试服务器 → `http://127.0.0.1:5173/index.html`（见 §2.2） |
| `npm test` | 三套 Node 单测（core 177 + 存储 39 + 谱清单 29），秒级 |
| `npm run test:e2e` | 桌面版端到端（真 Electron，会弹一下窗口并截图） |
| `npm run test:book` | 多本谱端到端（**数据隔离**是重点） |
| `npm run test:edit` | 编辑弹窗「能不能改」回归（真实鼠标 + 键盘事件） |
| `npm run test:acc` | 系统级按键注入，验原生菜单 accelerator |
| `npm run test:delete` | 删除人员流程回归（系统级物理按键） |
| `npm run db:inspect` | 不启动应用，直接看库（见 §2.3） |

### 2.1 数据目录

首次启动会自动建库并载入 36 人示例家族。数据目录**刻意放在应用目录之外**：

- 有 D 盘 → `D:\族谱pc端项目\数据\`
- 没有 → `C:\Users\<用户名>\族谱数据\`

实际用了哪个会写进 `boot.log`。要换位置就设环境变量 `GENOGRAM_DATA_DIR`，例如
`GENOGRAM_DATA_DIR=E:\我的族谱 npm start`。目录结构见 §5.1。

> 备份 = 直接拷走整个 `数据\` 文件夹。卸载、重装、删代码都不会丢数据。

### 2.2 网页版（仅开发调试通道，不做正式网页版）

```bash
npm run web          # 起静态服务器 → http://127.0.0.1:5173/index.html
```

同一套 `src/` 代码，存储自动退回 `localStorage`。调试参数：`?zoom=1.2&focus=p_p2s`
（指定初始缩放 / 聚焦到某人）。

> 网页版必须走 HTTP，不能双击 `index.html` —— 用的是原生 ES Module，`file://` 下浏览器会拦掉模块加载。
> 桌面版没这个问题（`file://` 由 Electron 自己加载，且 `webSecurity` 行为不同）。

### 2.3 查一眼自己的库（不启动应用）

```bash
npm run db:inspect                    # 默认查「当前谱」的库
npm run db:inspect -- "E:\某处\x.db"   # 指定库文件
```

打印人数、关系条数（血缘/婚配分开）、世次分布、meta、前 8 人。
有多本谱时会一并列出清单并标出当前这本。另有 `scripts/analyze-db.js`（把库读进 core 层跑一遍
**产品逻辑**，看数据完整性与称谓覆盖率）和 `scripts/check-export-scope.js`（排障：导出的
到底是哪一页），见 §3.2。

---

## 3. 仓库结构与模块职责

### 3.1 顶层

| 目录 / 文件 | 内容 |
|---|---|
| `app/` | **代码本体**（Electron 工程）。逐版本变更记录见 [`app/README.md`](app/README.md) |
| `openspec/` | OpenSpec 工作区：`specs/` 5 个能力规格 + `changes/archive/` 5 个已归档变更 |
| `数据/` | **运行时数据目录**（不在版本控制内，首次启动自动生成）—— `library.json` 谱清单 + `books\<谱id>\` 每谱一个目录（`genogram.db` 主库 + `.bak` + `backups/` 每日快照 + `photos/`）+ `trash\` 删谱回收站 |
| `数据底稿/` | 录入模板与测试数据（`people.csv` / `relationships.csv` / `测试数据-周氏家族.json` + 字段说明 `README.md`）—— **不在版本控制内**（`.gitignore`），本机目录 |
| `dist/` | 打包产物（安装版 / 免安装版 exe + `win-unpacked/`）※ 不在版本控制内 |

数据目录**刻意放在 `app/` 之外** —— 卸载、重装、删代码都不会丢数据。

### 3.2 `app/` 内部

```
app/
├─ index.html            三栏骨架：顶栏 + 左导航轨(52px) + 画布 + 右详情面板(336px)
├─ electron/             ★ 桌面壳（只有它能碰文件系统和数据库）
│  ├─ main.js            主进程：建窗 / IPC / 菜单 / 启动日志 / 错误兜底 / 打包后自检
│  ├─ preload.cjs        渲染层 ↔ 主进程 桥（contextBridge 白名单）
│  ├─ db.js              SQLite 存储：建表、数据集↔表 映射、事务、原子落盘
│  ├─ library.js         族谱库清单：增删改查、当前谱、老库迁移、生成短 id
│  ├─ photoStore.js      F12 照片存储：收文件 / 读 / 删 / 恢复（nativeImage 注入，可单测）
│  └─ paths.js           数据目录解析 + 备份策略（不 import electron，可单测）
├─ build/                ★ 打包资源（不进应用包）
│  ├─ icon.ico           应用图标（7 个尺寸，由 make-icon.py 生成，纯 Python 零依赖）
│  ├─ make-icon.py       图标生成脚本：圆角方块 + 微缩族谱树，距离场 + 超采样抗锯齿
│  └─ installer.nsh      NSIS 钩子（v0.2.50 起不再固定安装目录，文件里只剩编码约定与空 preInit 宏）
├─ scripts/
│  ├─ launch.js          启动包装：先清 ELECTRON_RUN_AS_NODE，再拉真 Electron
│  ├─ inspect-db.js      库文件检查器（不启动应用，直接看人数/关系/世次）
│  ├─ analyze-db.js      真实数据只读体检：把库读进 core 跑产品逻辑，看完整性与称谓覆盖
│  ├─ check-export-scope.js  排障脚本：查「导出的到底是哪一页」
│  ├─ verify-asar.js     包/源码一致性校验（打包后必跑：sha256 逐文件比对业务代码）
│  ├─ check-migrate.js   老库迁移只读演练（拿真实数据副本跑，逐项比对）
│  ├─ gen-pinyin-table.js 拼音表生成器（开发期用，pinyin-pro 取音，不在发布包）
│  └─ tmp-*.js           一次性排查脚本（随用随弃，不是基础设施）
├─ dev-server.js         零依赖静态服务器（网页版调试用，含目录穿越防护）
├─ src/
│  ├─ app.js             主控制器：状态、派生数据重算、事件接线、toast、错误兜底
│  ├─ store.js           可插拔存储：桌面版走 SQLite 桥 ↺ 网页版走 localStorage
│  ├─ core/              ★ 纯计算层，**零 DOM 依赖**，可直接在 Node 里单测
│  │  ├─ model.js        数据规范化 + 建索引（byId / parentsOf / kidsOf / spouseOf）
│  │  ├─ family.js       家族树划分（族源上溯 + 血缘下收 + 配偶并入）
│  │  ├─ layout.js       布局算法：递归树形 + 父居中 + 全局 genY 映射
│  │  ├─ kinship.js      称谓推导：LCA + 兄弟步压缩 + 姻亲多跳搜索 + 长幼/排行
│  │  ├─ rules.js        称谓规则表（290 条，口语叫法）+ 排行前缀
│  │  ├─ search.js       搜索匹配与排序：拼音表、多音字、主树/姻亲排序（纯函数）
│  │  ├─ export-image.js 导出图片的纯计算：裁剪范围、清晰度、元素多少
│  │  ├─ parentFilter.js 父母候选过滤：级别 / 辈分 / 性别 / 排行四道关
│  │  ├─ diagnose.js     F8 自动体检（孤儿/成环/世次矛盾/排行/生卒/配偶不一致）
│  │  ├─ photoNames.js   F12 照片命名与校验纯函数（主进程/渲染层共用一份）
│  │  ├─ photos.js       F12 渲染层照片缓存：dataURL 懒加载 + 负缓存 + 切谱失效
│  │  └─ data/pinyin.js  拼音表数据（由 gen-pinyin-table.js 生成）
│  ├─ ui/
│  │  ├─ tree.js         TreeCanvas：节点渲染 + SVG 连线 + 缩放/拖拽/键盘
│  │  ├─ panel.js        右侧详情面板（本地叫法 / 标准称呼 / 关系描述 三级）
│  │  ├─ dialog.js       录入 / 编辑弹窗（**只收事实，不收称呼**）
│  │  ├─ check.js        体检结果面板
│  │  └─ icons.js        零依赖内联 SVG 图标集
│  ├─ data/sample.js     36 人示例数据（含父系/母系/妻系三棵树）
│  └─ styles/            tokens.css（设计 token）+ app.css
└─ tests/               12 套回归 + 2 个专项脚本，**项数与职责见 §6**
   ├─ run.js             core 层单测（Node 直跑）
   ├─ db.test.js         存储层单测（Node 直跑，不需要 Electron）
   ├─ library.test.js    谱清单 + 网页版多谱数据隔离（Node 直跑）
   ├─ photos.test.js     F12 照片模块单测：命名/校验/路径逃逸/增删读恢复（Node 直跑）
   ├─ e2e.html           渲染层回归（真浏览器）
   ├─ modal-overflow.html 弹窗溢出回归（无头可跑）
   ├─ icon-size.html     图标尺寸回归（无头可跑，v0.2.75 新增）
   ├─ topbar-layout.html 顶栏宽窄布局回归（无头可跑，v0.2.76 新增）
   ├─ electron-smoke.js  桌面版端到端（真 Electron，含截图）
   ├─ edit-dialog.test.js 编辑弹窗回归（真 Electron）
   ├─ delete-flow.test.js 删除人员流程回归（真 Electron）
   ├─ acc-input.test.js  原生菜单 accelerator 回归（真 Electron + 系统级按键注入）
   └─ repro-delete-current.test.js 删当前谱卡死的一次性复现脚本（真 Electron）
```

---

## 4. 架构原则与设计定稿

### 4.1 架构原则

| 原则 | 说明 |
|---|---|
| **依赖极少** | 运行时只有 3 个包：`electron`（壳）+ `sql.js`（SQLite）+ `html2canvas`（导出图片，v0.2.63 起）。没有框架、没有构建步骤。**`core/` 依旧零依赖**——html2canvas 只在渲染层用，`tests/run.js` 不需要 DOM |
| **不联网** | 全程无网络请求，数据不出本机。`store.js` 只碰 IPC / localStorage |
| **core 层无 DOM** | `core/*` 只吃数据结构、不碰 `document`，所以能在 Node 里直接单测 |
| **关系不存储** | `dataset` 只存 `Person[]` + `relationships[]`（parent/spouse），称呼永远算出来 |
| **未覆盖不猜** | 规则表匹配不到时输出「关系描述」兜底，绝不编造称呼（PRD §10） |
| **进程隔离** | 只有主进程碰数据库；页面里没有 `require`/`fs`/`process`，能力全部经 preload 白名单 |

### 4.2 设计定稿（早期原型阶段已定，代码里一直没改）

早期原型（PRD / UI 设计稿 v1 / 预览 v1、v2）已随那批武汉背景文档删除，下面 7 条决策**早已在代码里定稿**，留此备查：

| # | 议题 | 最终做法 |
|---|---|---|
| 1 | 卡片尺寸 | 原型 66px 未采用，现为 `--node-w: 76px` + `--sp-gap: 12px` → 配偶间距 88px |
| 2 | 色板 | 采用对比度达 WCAG AA 的那套（`tokens.css`），父系/母系/姻亲三色 |
| 3 | 连线色 | 血缘 `#a8b2c0`、婚配 `#d08a2e` |
| 4 | 关系存储结构 | **一张** `relationships(a,b,type)` 表同时存 parent + spouse，不拆两张映射表（拆了反而挡住未来的收养 / 继嗣 `type`） |
| 5 | `gen` 推导算法 | 从视角人 BFS 上溯取族源、向下推 `gen`、锚点 `gen = 0`；跨树姻亲归其原生树 |
| 6 | 父母字段 | **父、母两个槽位**，落成两条 parent 边。单亲字段表达不了「有爸有妈」，与称谓引擎的 `F`/`M` 路径直接冲突 |
| 7 | 存储位置与格式 | 跳过 JSON 中转，v1 直接上 **SQLite**（`sql.js`），示例数据首启即落库 |

---

## 5. 本地数据库

### 5.1 位置

v0.2.24 起数据根目录里可以放**多本谱**（每本谱一个独立目录）：

```
D:\族谱pc端项目\数据\
├─ library.json             谱清单：有几本、当前在用哪本
├─ books\
│  ├─ book-mv22zy6z-fxcg\     ← 一本谱 = 一个目录
│  │  ├─ genogram.db         这本谱自己的库（标准 SQLite，任何工具都能打开）
│  │  ├─ genogram.db.bak     上次退出时的状态
│  │  ├─ backups\            该谱的每日快照，保留最近 30 份
│  │  └─ photos\             该谱的照片（F12）：原件 + 同名 .thumb 缩略图，
│  │                          数据库行里只存文件名，不存二进制
│  └─ book-n3k9…\
│     └─ …
└─ trash\                    被删的谱目录挪到这里（**不真删**，可手工找回）
```

**为什么是一谱一目录，而不是一张库 + 一个 "book" 字段**：目录天然隔离，
照片、自动备份、每日快照、磁盘布局全都跟着谱走，逻辑一行都不用改；
而且「把这一本拷给亲戚」就是拷一个文件夹。

**备份 = 直接拷贝那一本谱的文件夹。** 数据库不在应用目录里，卸载/重装应用不会丢数据。

> 目录名是短 id（不是中文谱名），所以**改谱名不用动磁盘**。谱名只存在 `library.json` 里。

### 5.2 从 v0.2.23 及以前升级

老版本是「根目录直接躺着 `genogram.db`」。首次启动新版本时会自动把它搬进
`books/<id>/genogram.db` 并登记为第一本谱 **「我的家族」**，内容逐字节不变。

- **原件不删**：原文件改名为 `genogram.db.migrated-<日期>` 留在原地，随时能拷回来。
- **只迁一次**：清单里一旦有谱就不再迁移，哪怕手贱把老文件复制回根目录。
- 演练（拿真实数据在副本上算一遍，不动原件）：
  ```bash
  node scripts/check-migrate.js D:\族谱pc端项目\数据
  ```

### 5.3 表结构

```sql
people          -- 一人一行
  id, name, sex, birth, death, alive, avatar, photos, note, place,
  gen, order_no, privacy, expand

relationships   -- 一条关系一行，parent / spouse 同一张表
  id, a, b, type CHECK(type IN ('parent','spouse')),
  from_date, to_date, source, confidence, note,
  UNIQUE (a, b, type)

meta            -- 版本、视角人、保存时间、schema_version
  key, value
```

几个刻意的设计：

- **`order` / `from` / `to` 是 SQL 关键字**，列名用 `order_no` / `from_date` / `to_date` 规避。
- **`gen` / `order_no` 用可空整数** —— `0`（我辈 / 长子）和「没填」必须区分，不能都用 0。
- **⚠️ 派生数据不落盘** —— `gen` 由双亲指针推导而来。推导值只活在内存里，
  `serialize()` 在写出前会调 `stripDerivedGen()` 把它剥掉，只保留人工显式填的世次。
  否则下次加载时它会被当成「人工显式值」优先采用，推导从此失效 ——
  改了父母关系树却不跟着变，等于把派生数据固化成了事实来源，直接违反第一铁律。
  `tests/run.js` 第 6 组有专门的回归测试盯着这件事。
- **`type` 加了 CHECK 约束**，写错关系类型数据库会直接拒绝。
- **照片文件存磁盘，行里只存文件名**（F12，v0.2.85 落地）：`photos/` 目录放原件
  （外加同名 `.thumb` 缩略图），`photos` 列是文件名数组、`avatar` 列是主头像文件名。
  base64 进行里会让每次全量重写越存越慢；而且照片跟着谱目录走，「拷一个文件夹
  给亲戚」照片也跟着走。删文件前主进程校验路径必须落在该谱 `photos/` 内
  （挡历史脏数据的 `..\` 逃逸）。渲染一律走 IPC 读成 dataURL —— `file://` 上画布
  会污染 canvas，`toDataURL` 直接抛 SecurityError（F11 导出图片的坑位注释）。
- **缩略图是方形中心裁切，不是等比缩放**：头像位（60×60）与照片格都是方的，
  而 **html2canvas 不支持 `object-fit`** —— 它把 `<img>` 直接拉伸到元素框里，
  一张 3:2 的照片进方框，导出图里的头像就被挤扁（屏幕上却是好的，因为浏览器
  认 `object-fit`）。缩略图本身就是方的 → 方图进方框永不变形。旧版缩略图
  会在读取时自动重生成，不迁数据、不动原图。
  导出副本里还把头像的圆与描边环**烙进 PNG**（canvas 的 `arc` 自带抗锯齿），
  因为 html2canvas 裁圆是硬裁路径、不带抗锯齿，放大后是一圈锯齿（外加头像投影
  的近似模糊环），也就是「花边」。

### 5.4 为什么是 sql.js 而不是 better-sqlite3

`better-sqlite3` 是原生模块，要针对 Electron 的 ABI 重编译，本机没有 VS Build Tools 会直接卡死。
`sql.js` 是 SQLite 编译成 WASM，**零编译**，代价是整库常驻内存 —— 族谱这个量级（几百人 / 几 MB）完全无感。

将来要换 better-sqlite3：**只改 `electron/db.js` 一个文件**，表结构、`store.js`、UI 全都不用动。

### 5.5 写入的两条硬保证

1. **事务**：每次保存是「清空 + 重建」放在一个 `BEGIN/COMMIT` 里。族谱量级下比逐行 diff 简单得多，而且天然一致 —— 不会出现「人删了、关系还在」的半截状态。写失败则 `ROLLBACK`，磁盘和内存都留在原样。
2. **原子落盘**：先写 `genogram.db.tmp`，再 `rename` 覆盖主库。同卷 rename 是原子的，断电/崩溃最多丢掉最后一次保存，**不会写出半个损坏的库**。

> 如果 `genogram.db` 被别的东西弄成 0 字节，应用会**明确报错并拒绝打开**（提示从 `backups\` 恢复），而不是把半截文件硬塞给 SQLite 抛一堆内部错。

### 5.6 「空」有两种，必须分清楚

空的数据库有两种完全不同的含义，混淆会出事故：

| 情况 | 判定 | 应该怎么做 |
|---|---|---|
| **全新库**，从没写入过 | `meta.seeded` 不存在 | 载入示例家族，让人一打开就有东西看 |
| **用户主动清空过** | `meta.seeded = 1` | **保持为空**，等他录自己的人 |

以前只靠「people 表是不是空的」来判断，结果就是：用户点了「清空数据」→ 重启 → 36 人示例家族又回来了，
清空按钮等于失灵。现在写过一次的库一律打上 `seeded` 标记（见 `db.js` 的 `META_SEEDED`），
之后空着就是真的空着。网页版同理：清空的语义是**写入一份空数据集**，不是把 localStorage 的 key 删掉。

> ⚠️ v0.2.24 起：新建一本谱时**即使选的是「空白谱」，也会立刻写入一份空数据集把 `seeded` 打上**
> （见 `electron/main.js` 的 `lib:create`）。不打这个标记的话，重启后会被当成「全新库 → 灌示例家族」，
> 「新建」这个动作直接失灵。`tests/book-flow.test.js` 第 2 组专门盯着它。

---

## 6. 测试

```bash
npm test             # core(177) + 存储(39) + 谱清单与网页版(29)，纯 Node，秒级
npm run test:e2e     # 桌面版端到端（真 Electron，会弹一下窗口并截图）
npm run test:book    # 多本谱端到端（**数据隔离**是重点）
npm run test:edit    # 编辑弹窗「能不能改」回归（真实鼠标+键盘事件）
npm run test:acc     # 系统级按键注入，验原生菜单 accelerator
npm run test:delete  # 删除人员流程回归（系统级物理按键）
```

四个 html 套件不是 npm 脚本：先 `npm run web`（见 §2.2），再开浏览器访问 `/tests/<名字>.html`。

12 套回归 + 2 个专项脚本各管一件事：

| 套件 | 跑在哪 | 项数 | 管什么 |
|---|---|---|---|
| `tests/run.js` | Node | 177 | 称谓引擎、布局、世次、体检、**派生数据不落盘**、**边界与破坏性输入** —— 产品逻辑的命根子 |
| `tests/db.test.js` | Node | 41 | 表结构、往返无损、事务回滚、原子落盘、备份策略、**清空后不被示例覆盖**、**SQL 注入串存取**、**照片文件名与脏路径字符往返** |
| `tests/library.test.js` | Node | 29 | **族谱库清单 + 网页版回落**：全新安装建第一本谱、**老库迁移且不反复迁**、重名消歧、删谱进 trash、清单损坏可自愈、**localStorage 版多谱的数据隔离** |
| `tests/photos.test.js` | Node | 15 | **F12 照片模块**：命名与校验纯函数（路径逃逸全形态）、引用收集、增删读恢复编排（含目录外拒绝、坏数据拒绝） |
| `tests/e2e.html` | 浏览器 | 53 | 渲染层交互（含跨树姻亲称谓、录入流程、弹窗竞态、体检跳转放大居中） |
| `tests/modal-overflow.html` | 无头浏览器 | 15 | **编辑弹窗小窗口溢出回归**（760×560 视口断言 flex/滚动/按钮可达） |
| `tests/icon-size.html` | 无头浏览器 | 13 | **图标尺寸回归**：兜底对漏写规则的容器生效、**`.wires` 连线层不被兜底压扁**、组件级 `X svg` 压过兜底、v0.2.73/74 两处热点仍 14px |
| `tests/topbar-layout.html` | 无头浏览器 | 30 | **顶栏宽窄布局回归**：品牌文字不纵向越出顶栏、谱名被 flex 压到 `max-width` 之下且有 3em 下限、**族谱库胶囊既不溢出外层也不内部装不下**、家族页签三个都在可视区内、**搜索结果浮层不被压扁**、**窄态按钮降级后仍够点且不丢可访问名称**、**拖动式连续 resize 下状态净变化 ≤2 次** |
| `tests/electron-smoke.js` | 真 Electron | 30 | 壳能不能起、preload 桥通不通、**数据真的落进 .db 了吗**、菜单动作 |
| `tests/edit-dialog.test.js` | 真 Electron | 58 | **编辑弹窗到底能不能改**：真实鼠标事件戳每个控件、`elementFromPoint` 抓遮挡、IME 上屏、焦点归属、弹窗叠加/残留定时器、**弹窗内全局快捷键是否误触** |
| `tests/delete-flow.test.js` | 真 Electron | 28 | **删除人员流程**：自绘确认框替代原生 `confirm()`、取消/拒绝删除/真删/物理按键仍有效、遮罩无残留（第 5 组用系统级物理按键守住原生 `confirm` 禁用） |
| `tests/acc-input.test.js` | 真 Electron + 系统级按键注入 | 7 | 原生菜单 accelerator 会不会吃掉输入框按键（**证伪裸键 F，同时守住这个结论**） |
| `tests/repro-delete-current.test.js` | 真 Electron | 一次性 | 删当前谱卡死的历史复现脚本（已修，留作回归用） |
| `scripts/check-migrate.js` | Node | 只读演算 | 拿**真实数据在副本上**跑一遍老库迁移，逐项比对人数/关系/视角人/`seeded` 标记 |

`electron-smoke.js` 的期望值都从示例数据**现算**（不写死人数）；它跑在临时沙箱目录里，
**不会碰你真实的库**。失败时保留沙箱目录供复盘，成功则自动清理。

> ⚠️ 为什么 `edit-dialog.test.js` 坚持用 `webContents.sendInputEvent` 而不是 `el.click()` / `el.value = 'x'`：
> 后者测的是 DOM API 通不通，测不到「用户真实戳一下有没有反应」。
> 弹窗内的一切都走真实鼠标/键盘事件（`isTrusted=true`），和人手同一条路径。

> ⚠️ 但 `sendInputEvent` 有个**测不到的地方**：它直接把事件投递到渲染层，
> 完全绕过 Windows 原生菜单的 accelerator 表 —— 而 accelerator 恰恰是在原生那层拦截的。
> 要验 accelerator 必须用系统级注入（`user32.keybd_event`，见 `tests/acc-input.test.js`）。
> 这也是当初「裸键 accelerator 吃掉字母 F」这个怀疑能被证伪的原因。

> 上面的套件跑的都是**源码**。打包出来的安装包另有一套自检（`GENOGRAM_SELFTEST=1`），见 §7.3。

> ⚠️ `tests/e2e.html` 用**离屏 iframe + 动态挂 src**，在**无头 Chrome** 下时序不可靠：
> `--dump-dom` 常抓到「应用还没起来」的中间态，报一堆 `click of undefined` 的假失败
> （`--virtual-time-budget` 只加速虚拟时钟，管不了 iframe 的真实网络加载）。
> **请开真实浏览器跑**（`npm run web` 后访问 `/tests/e2e.html`）。
> 无头环境要验渲染，直接 dump `index.html` 本体数节点更靠谱。

---

## 7. 打包与发布

### 7.1 打包前必须核对版本号

`app/README.md` 更新日志里最新条目的版本号，须与 `app/package.json` 的 `version` 一致。
不一致说明代码改了但漏升版本号 —— 产物文件名会沿用旧版本号，造成「同一版本号反复覆盖、用户分不清哪一版」。
**先升 `package.json` 的 version，再打包。**

### 7.2 打包命令

```bash
npm run dist        # 完整构建：NSIS 安装包 + 免安装版
npm run dist:dir    # 只打包不生成安装器（快，用来验证 asar 内容）
npm run dist:publish # 构建 + 自动发到 GitHub Releases（见 §7.3）
```

> ⚠️ **本机打包必现 EPERM**：`npm run dist` 会在 electron-builder 的打包阶段挂掉，
> 报 `EPERM: operation not permitted, rename 'dist\win-unpacked.tmp' -> 'dist\win-unpacked'`。
> 根因是 electron-builder 解压 electron 到 `.tmp` 后立刻 rename，Windows Defender 实时扫描
> 持着句柄导致 rename 必失败 —— 与残留目录、程序是否在运行、输出目录在哪都无关。
> **已验证的解法**：指定 `electronDist` 为本地已解压的 electron 目录，走「纯复制」分支，压根不做 rename：
>
> ```bash
> # 前提：dist\win-unpacked 目录必须事先不存在
> npx electron-builder --win --config.electronDist="D:\族谱pc端项目\app\node_modules\electron\dist"
> ```
>
> 这条命令**不改 `package.json`**（命令行 `--config.` 临时覆盖即可）。若 electron 版本升级过，
> 先确认 `node_modules\electron\dist\version` 与目标版本一致。
> 删不掉的文件（旧的 `Genogram-*.exe`、`.blockmap`、`win-unpacked`）请手动删 —— 路径存在时
> electron-builder 内部的清空步骤会失败。

### 7.3 产物

落在 `D:\族谱pc端项目\dist\`（**故意不放应用目录、更不放 C 盘**）：

| 文件 | 说明 |
|---|---|
| `Genogram-Setup-0.2.80.exe` | **安装版**（约 107 MB）。安装目录在向导里自选，默认 `C:\Users\<用户名>\AppData\Local\Programs\家族谱` |
| `Genogram-Portable-0.2.80.exe` | **免安装版**（约 106.8 MB）。双击就跑，适合放 U 盘随身带 |
| `Genogram-Setup-0.2.80.exe.blockmap` | 安装版的差分索引，给「自动更新」用（尚未实现，见 §9） |
| `win-unpacked\` | 解包后的程序目录，调试用 |

> 源码当前版本见 §1 —— `dist/` 里的 exe 版本号会落后于源码；下次 `npm run dist` 前先核对版本号。

**发布到 GitHub Releases**（别人从仓库页面直接下载安装包走这条路）：

```bash
$env:GH_TOKEN = gh auth token
npm run dist:publish
```

`dist:publish` 就是 `dist` 加一个 `--publish always`：构建完成后自动在仓库上创建以版本号命名的
Release（tag 形如 `v0.2.85`），并把安装版、免安装版和 `.blockmap` 一并挂上去。三个坑：

- **必须先设 `GH_TOKEN`**。electron-builder 只读环境变量，**不会**复用 `gh` 的登录态
  （见 `node_modules/electron-publish/out/gitHubPublisher.js` 第 25 行，只认
  `GITHUB_RELEASE_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`）。`gh` 本身已登录且带 `repo` 权限，
  `gh auth token` 取出来即可。
- **版本号必须是新的**。tag 已存在时发布会失败中止 —— 这是防呆，别绕过；确实要重发同一版，
  先去 Releases 页面把那个 tag 删掉。
- **本机打包仍受 §7.2 的 EPERM 限制**，所以实际发布要跑这条（`dist:publish` 里没带 `electronDist`，
  在本机会挂在 rename 上）：

  ```bash
  $env:GH_TOKEN = gh auth token
  npx electron-builder --win --publish always --config.electronDist="D:\族谱pc端项目\app\node_modules\electron\dist"
  ```

### 7.4 装包后必须验的三件事

打包最容易「窗口能开、界面空白」，而且**只检查文件存在是发现不了的**。所以内置了自检开关：

```bash
# 不开窗口，把渲染层的实际结果写成 JSON 再退出
GENOGRAM_SELFTEST=1 GENOGRAM_SELFTEST_OUT=D:\tmp\st.json GENOGRAM_DATA_DIR=D:\tmp\d 家族谱.exe
```

它回答三个问题：

1. **ES Module 能不能从 asar 里走 `file://` 加载** —— 数 `.node` 节点数，加载失败就是 0
2. **`sql.js` 的 WASM 能不能定位到** —— 看 `数据\books\<id>\` 里有没有真的生出 `genogram.db`
   （v0.2.24 起每本谱独立存放，不再直接躺在数据根目录）
3. **进程隔离还在不在** —— 页面里 `require` / `process` 必须都是 undefined

### 7.5 第四件事：包里的代码和源码是不是同一份

打包是某个时间点的快照，之后源码再改（或者像这次误删后从 asar 恢复），**安装包就和源码脱节了**。
只看文件在不在、只看大小，都验不出来。所以加了个校验脚本：

```bash
node scripts/verify-asar.js                          # 默认比 win-unpacked 的 app.asar 和本目录
node scripts/verify-asar.js <asar路径> <源码目录>
```

它按 sha256 逐文件比对，**业务代码（`src/`、`electron/`、`index.html`）只要有一个字节不同就退出码 1**。
`package.json` 的差异会单独列出并忽略 —— electron-builder 打包时会重写它（剥掉 devDependencies / build 配置），属预期。

脚本只读 asar、只读源码，输出一律走系统临时目录，**不会往项目目录写任何东西**。

> 写这个脚本时踩的坑：asar 数据区起点是 `8 + headerBuf.length`，**不是** `16 + JSON 长度`
> （JSON 后面有 4 字节对齐填充）。算错 1 字节的表现极具迷惑性 —— 提取出来的文件大小完全正确、
> 内容只差一个换行，diff 几乎看不出来，但哈希对不上。

### 7.6 体积优化（踩过的坑）

`sql.js` 的 npm 包默认带了一堆用不上的东西：**debug 版 5.5 MB ×2、asm.js 版 1.3 MB ×3、还有 3 个 zip 包共 5 MB** —— 合计 21 MB，占 asar 的 98%。
`package.json` 的 `build.files` 里用 `!` 排除了，**asar 从 20.64 MB 降到 0.32 MB**。

另外两处刻意配置：

- `asarUnpack` 只放行 `sql-wasm.wasm` —— WASM 作为独立文件躺在磁盘上，绕开「从 asar 里读二进制」的任何边界情况
- `build.files` 里加了 `!_*` 和 `!**/*.log` —— 防止开发期的临时文件混进发布包（**第一次打包真混进去了**）

### 7.7 默认安装目录（v0.2.50 起不再固定）

**以前** `build/installer.nsh` 用 NSIS 的 `preInit` 钩子把默认安装目录写死成 `D:\族谱pc端项目\程序`
（原理：`.onInit` 会优先读卸载项注册表里的 `InstallLocation`，而 `preInit` 在它之前执行，预写即可生效）。

**现在去掉了**，原因：打包版是要**装到别人电脑上**用的，而别人的机器不一定有 D 盘。
没有 D 盘（或 D 盘不可写）时 NSIS 建不出这个目录，结果就是
**「安装向导走完了、桌面快捷方式也有，双击却毫无反应」** —— 快捷方式指向一个不存在的 exe。
现在默认装到 `C:\Users\<用户名>\AppData\Local\Programs\家族谱`，用户在向导里可自选（`allowToChangeInstallationDirectory` 仍为 true）；
数据目录本来就独立，卸载 / 重装 / 删程序都不会丢族谱。

> **编码坑（踩了两次）**：`installer.nsh` **必须是 UTF-8 且带 BOM**。
> electron-builder 传给 makensis 的主脚本是 UTF-8；include 的文件若没有 BOM，NSIS 按 ANSI 解析，
> 里面的中文路径会变成乱码目录名（历史上真出过一次 `D:\WorkBuddy¶Ï嬱敁豰p`）；
> 改存 GBK 更糟 —— 直接报 `Bad text encoding: installer.nsh:1`，整个构建中断。
> 另外文件里不要出现 GBK/ASCII 之外的符号（emoji、⚠ 之类），否则同样会炸。

### 7.8 国内网络打包（首次构建必看）

首次 `npm run dist` 很可能卡成这样：

```
⨯ Timeout awaiting 'request' for 600000ms
```

原因：electron-builder 26 打包 Windows 目标时要下载工具集 `winCodeSign-2.6.0.7z`
（里面的 `rcedit` 用来写 exe 的图标和版本信息），默认源是 GitHub Releases，国内直连会挂满 10 分钟超时。

两个解法，任选其一：

1. **让它走镜像**（推荐）：
   ```bash
   ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
   npm run dist
   ```

2. **预置缓存**（之后可离线构建）：把 `winCodeSign-2.6.0.7z` 放到
   `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign-2.6.0\winCodeSign-2.6.0.7z`
   并要求 SHA256 = `cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4`。
   命中缓存后 electron-builder 直接解压，完全不碰网络。

工具集缓存布局统一为 `<缓存目录>\<releaseName>\<文件名>`（`nsis-3.0.4.1`、`nsis-resources-3.4.1` 同理）。
缓存与镜像都就绪时，一次完整构建约 **40 秒**（对比超时挂死的 10 分钟）。

---

## 8. 环境坑与排障

本机实测，踩过就知道：

| 症状 | 原因 | 处理 |
|---|---|---|
| `electron` 一启动就报 `Cannot read properties of undefined`，且报错栈写着 **Node.js vXX** | 会话里设了 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成纯 Node | 启动前 `unset ELECTRON_RUN_AS_NODE`（或用 `npm start`，npm 脚本里已清） |
| **窗口永远不出现**，没有任何报错 | ESM 主入口下，Electron 要等**入口模块顶层求值全部结束**才发 `ready`；入口里有顶层 `await` 等窗口 → 死锁 | 入口顶层不要写 `await`，用 `.then()` 触发起步逻辑（见 `tests/electron-smoke.js` 注释） |
| 满屏 `GPU process exited unexpectedly` → `FATAL: GPU process isn't usable. Goodbye.` 然后退出 | 本机 GPU 进程不稳定 | 默认已关硬件加速（软件渲染）。想开回去：`GENOGRAM_HW_ACCEL=1` |
| 应用启动"卡死"不响应 | 主进程错误框是**阻塞式**的，会一直等点击 | 排障时设 `GENOGRAM_NO_DIALOG=1`（配合 `GENOGRAM_DEBUG=1` 看分步日志） |
| **双击毫无反应、也没有任何提示** | 旧版的单实例锁失败只走 `console.error`（GUI 程序没有控制台）就退出；或崩在数据目录解析之前 —— 那时日志一个字都还没写 | v0.2.50 起会弹窗说明（已在运行 / 如何结束残留进程），且启动日志**第一时间落 `%TEMP%\族谱-boot.log`**，定下数据目录后再并进 `数据\boot.log`。别人电脑打不开，让他把 `boot.log` 发回来即可定位 |
| 崩溃后没有日志可查 | 只记了正常启动的步骤，崩在窗口创建之后就没有下文 | v0.2.50 起有 `uncaughtException` / `render-process-gone` / `child-process-gone` 钩子，`type=gpu` 就是显卡加速进程崩了 |
| 终端里跑脚本毫无输出，像卡死了 | 本机沙箱会吞掉 PowerShell 的 stdout；bash 环境还缺 coreutils（`ls` / `head` 不可用） | 结果先落盘再 Read；完整路径的 `node` / `python` 可直跑 |
| 内联 JS 报 `bad substitution` | bash 会把内联脚本里的反引号和 `${...}` 当 shell 展开 | 复杂脚本先 Write 成 `.js` 文件再 `node` 执行，不要内联 |
| 打包必挂 `EPERM ... rename 'dist\win-unpacked.tmp'` | electron-builder 解压后立刻 rename，Defender 实时扫描持句柄 | 见 §7.2 的 `--config.electronDist` 解法 |

排障开关一览：

```bash
GENOGRAM_DEBUG=1        # 主进程分步日志（打印到 stderr，并写入数据目录 boot.log）
GENOGRAM_NO_DIALOG=1    # 关掉阻塞式错误框
GENOGRAM_HW_ACCEL=1     # 开回硬件加速
GENOGRAM_DATA_DIR=...   # 换数据目录
GENOGRAM_BOOT_LOG=...   # 指定启动日志路径
```

---

## 9. 待办与未实现

| 编号 | 功能 | 现状 |
|---|---|---|
| F9 | 分支折叠 | 未做 |
| F10 | 拼音 / 首字母搜索 | **v0.2.72 已做**：`lx`（首字母）与 `liming`（全拼）都能搜人，多音字两个读音都认；只做连续片段匹配，生僻字整条退出；拼音全等**不**允许回车直跳。匹配与排序已下沉到 `core/search.js` |
| F11 | 导出图片 / PDF | **图片（PNG）v0.2.63 已做**：菜单「文件 → 导出图片…」或左栏图片按钮，只导**当前这一页**，清晰度二选一（1x / 2x）。**PDF 仍未做** |
| F12 | 头像 / 照片管理 | **v0.2.85 已做**：面板照片区添加（系统多选）/ 悬停「设为主头像 / 删除」/ 点击开灯箱看原图 / 超出 3 张显示「+N」全览。存储 = 文件进该谱 `photos/`（含缩略图）、行里只存文件名；渲染走 IPC dataURL（`file://` 会污染导出画布）。导出 JSON 可选「包含照片」（base64 内联、自包含），导入自动恢复并报缺失数；删除有路径逃逸防护，文件缺失降级为空槽。规格见 `openspec/specs/photo-management/` |
| F13 | 资料完整度提示 | 未做 |
| — | 代码签名 | 未做。安装时 Windows SmartScreen 会拦一下（「未知发布者」），需点「更多信息 → 仍要运行」 |
| — | 自动更新 | 未做 |
| — | 收养 / 继嗣 | 按 PRD §3.3「v1 不做」，仅预留 |

---

## 附录 A · 历史档案（只增不改）

> 本附录只记录**已定稿的结论**与**踩过的坑**，供日后回查，不参与日常开发。
> 实时状态看 §1，需求真源看 `openspec/specs/`，逐版本明细见 [`app/README.md`](app/README.md)。
> 追加时写在对应小节末尾，不回改旧条目。

### A.1 阶段线与里程碑

设计基线 → 网页版可运行 → PC 桌面版 + 本地 SQLite → 打包成安装包 → 代码审查 + 缺陷修复 →
多本谱 → 拼音搜索 F10 → 导出图片 → 顶栏/图标回归修复 → 长幼口径定稿 → git 建仓 + 私有远端。

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 设计基线（8 轮线框） | ✅ |
| M1 | 交互预览 + 布局算法 | ✅ |
| M2 | 数据层 + 录入 UI | ✅ |
| M3 | 称谓引擎 + 单测 | ✅ |
| M4 | 自动体检 F8 | ✅ |
| M5 | 桌面化：Electron 壳 + 本地 SQLite | ✅ |
| M6 | 打包：安装版 + 免安装版 + 图标 | ✅ |
| M7 | 真实数据试跑 → 修数据模型 | ✅（70 人真库跑出 10 处「关系待确认」并补齐规则；157 人 / 215 条关系真库跑过迁移演练，见 `app/README.md` 的 v0.2.7 / v0.2.24 条） |
| M8 | F9~F13：F10 拼音搜索 ✅ · F11 导出图片 ✅（PDF 未做）· F9 分支折叠 / F12 照片 / F13 完整度 ⏳ | 部分完成 |
| M9 | 版本控制 + 私有远端（git / GitHub 私有仓） | ✅ |

### A.2 历程六轮（压缩版）

1. **桌面化**（动机：用户指出要的不是网页，是只用本地数据库的 PC 端）：Electron 壳 + sql.js 落盘 `.db`；
   存储层可插拔（认 preload 桥走 SQLite，否则退 localStorage）—— core / ui 一行没白写。
2. **打包**：安装版 + 免安装版 + 纯 Python 距离场渲染的应用图标。
3. **代码审查**：1 必修（世次固化，见 A.4）+ 2 处会坑到数据的缺陷；修复都经过「故意退掉重跑、确认测试会红」。
4. **产物一致性**：新增 `scripts/verify-asar.js`，逐文件 sha256 比对包与源码，业务代码差一字节就退出码 1。
5. **多本谱**（v0.2.24）：谱清单 + 每谱独立目录；老库首次启动自动迁移（只迁一次，原件保留）；删谱进 `trash\` 回收站。
6. **功能冲刺**（2026-10-10 ~ 21）：南阳称谓口径定稿 → 搜索重做 + 拼音（F10）→ 导出图片（F11 图片部分）
   → 顶栏/图标回归修复 → 长幼口径再修 → git 建仓传私有远端。逐版本明细见 [`app/README.md`](app/README.md)。

### A.3 预览阶段的方法论（2026-09-17/18 日志摘录）

预览 v1 / v2 阶段（M0/M1：8 轮线框 + 单文件 HTML 原型）的工作日志提炼 —— 原始日志已删，
别处没有的结论收在这里。三条方法论今天仍然指导 `core/layout.js`：

1. **层级 y 必须用全局世次映射**：`genY(g) = 基线 + (GEN_TOP - g) × 行高`，全树共用。
   绝不能用「当前树出现过的世次集合」局部重排序 —— 主树与姻亲树世代集合不同，
   坐标系会错位（妻妹与妻子不同 y 就是这么来的）。
2. **显式锚点 + 血缘链传播，优于推测算法**：一度按 depth 找「最深直系链」自动识别主干，
   结果锚点漂移、主树被打乱。锚点坐标显式钉死、轴心沿 parent 指针向上传播，简单可控。
3. **布局校验用单元边界 + 按主轴人过滤**：核对「父居中」要拿单元（人 + 配偶）边界比，
   不能拿主轴人 x 直接比（有配偶时单元宽 144，会假报偏 72px）；查重叠只算主轴人，
   配偶不当独立节点 —— 用错公式跑出过 19 处假预警。

**探针验证法**（后来 `tests/` 无头回归体系的雏形）：抽出页面 `<script>` 内容、截断到数据定义处，
`new Function()` 执行后打印坐标对账；无头环境用 `--serve` 同源加载绕过 ESM 的 `file://` 限制。
headless_probe 实测过的结论（夫妻间距 15 对全 88px、13 个父节点全居中、WCAG 核心 token 全达标）
已转化为 `tests/topbar-layout.html` 等常驻回归。

**「无法修改」排查结论（2026-09-18）**：无头实测编辑主流程 11 项断言全部通过，
web 端功能无恙；真实瑕疵是编辑弹窗「在世情况」开关文案写死不随状态变（已修：`f-alive-text` +
`paintAlive()`）。用户报的「无法修改」现象未在 web 端复现，列为遗留待澄清，此后再未复现。

### A.4 历史缺陷档案：世次推导值被写回数据库（2026-09-18 已修）

**症状**：`recompute()` 把推导出的 `gen` 抹成真实值 → 存盘 → 重开后 `gen != null` 被当成「人工显式值」
优先采用 → 推导再也不参与。**同一份关系，存过盘和没存过盘世次不一样** —— 现场极难 debug，
且直接违反「关系不存储、称呼永远实时算」的第一铁律。

**修法**：改在 `model.js` 的唯一写出出口 `serialize()` 上（加 `stripDerivedGen()`），而不是 `app.js` ——
落盘与导出都走这一个出口，从根源上保证派生值出不去；`withResolvedGen()` 先剥再推保证幂等。
`tests/run.js` 有专门的回归组盯着这件事（§6）。

**验证方法（值得沿用的范式）**：修完故意把修复退掉重跑，确认新测试真的会红；再对真实库做只读体检
（当时结论：世次与推导值逐条一致、0 处污染）。不会红的回归等于没有。

### A.5 未闭环的技术债（2026-09-18 审查提出，均未做）

1. **CSP**：`index.html` 与主进程都没有 Content-Security-Policy。威胁不只是 XSS —— 导入的 JSON 里
   `avatar` / `photos` 字段可以是任意 URL，渲染时 `<img src>` 会对外发起请求；`esc()` 防得住注入、
   防不住这种 SSRF 式信息外泄（对方服务器能拿到你的 IP 和访问时间）。两个候选实现：
   ① `index.html` 加 `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: blob:; script-src 'self'">`；
   ② 主进程用 `session.defaultSession.webRequest.onHeadersReceived` 注入 CSP 响应头（Electron 下更可靠）。
2. **`paths.js` TDZ**：`resolveDataDir()` 里给 `lastError` 赋值，但 `let` 声明在函数之后
   （模块级变量还会跨调用残留上次的错误）。目前能跑是因为模块求值完才被调用；改成函数内局部变量即可。
3. **配偶校验**：原状是用户可把父亲 / 子女设为配偶，称谓推导会给出荒谬结果。**现状已变** ——
   录入表单不再直接提交配偶边（改由「添加亲属」流程维护，v0.2.6），成环有校验；
   「直系血亲不得为配偶」的专门守卫未逐条核实。
4. **`layout.js` O(n²)**：布局算法随人数平方增长；族谱量级（几百人）无感，规模大了再收拾。

> 另有一批 2026-09-18 记的小问题（`esc()` 不转单引号、`error` 监听器注册在 `boot()` 之后等），
> 未逐项复核；原始清单在 git 历史里的 `文档/代码审查报告.md` §五。

### A.6 守住别退的工程实践（2026-09-18 审查确认，今天仍然成立）

- **XSS 防护做得很扎实**：手写 DOM 的项目里，`innerHTML` 插值点全部套了 `esc()`，没有一处裸插值。
- **Electron 安全模型正确**：`contextIsolation: true` + `nodeIntegration: false`，preload 只暴露白名单 API；
  冒烟测试专门断言 `requireVisible: false` / `processVisible: false`。
- **写入有事务、落盘是原子的**：`BEGIN` + 清空重建 + `COMMIT`，落盘走 `.tmp` → `rename`；
  断电最多丢最后一次保存，不会写出半个损坏的库。
- **「未覆盖不猜」落实到位**：规则表匹配不到就输出关系描述兜底，绝不编造称谓 —— 产品最该守的底线。
- **畸形数据不崩**：畸形输入被 `normalizeDataset` 挡住或降级，且体检如实报出，符合「只报不改」。

> 口径修订记录：审查时记的「长幼判定优先用出生年」对哥 / 姐判定仍然成立；
> 但「小X」化已按 v0.2.80 改为**只比排行不看出生年**（修家谱的人知道排行、未必知道年龄），以 `app/README.md` 的 v0.2.80 条为准。
