# Proposal

## Why

搜索是这个软件里**唯一一个用户天天用、却一行都测不到**的逻辑：它整段住在 `app/src/app.js` 的 `collectSearchHits()` 里，依赖 `document` 与 `state`，既跑不进 Node 单测，改动也没有任何回归网兜底。趁这次加拼音搜索把它下沉到 `core/search.js`，是补上这块网的最自然时机。

拼音需求本身很实在：族里认人靠姓名，但汉字输入法要打完一整串才出候选——长辈问「李明是哪一辈的」，用户更想敲 `lm` 或 `liming`。目前只能按姓名/称呼子串逐字敲，等于把输入法最擅长的那一步丢掉了。

## What Changes

- 新增 `core/search.js`：把「谁命中、怎么排序」的判定从渲染层下沉为纯函数（无 DOM、无全局状态），纳入 `tests/run.js` 单测。
- 新增拼音匹配能力，静态表 `core/data/pinyin.js`（通用规范汉字一级字 3500 个）：
  - 一张表搞定两种形态 —— 首字母 = 全拼串的第一个字符，不需要第二张表。
  - 每字最多存 2 个音（`长 chang/zhang`、`单 shàn/dān` 等多音字都在人名里）。
  - 查询串命中任一候选串的**子串**即算命中；不做「中间省略」（`lming` 不认）。
  - 只对**姓名**做拼音匹配，称谓不参与（口语称呼没有拼音输入习惯，方言称呼更没有）。
  - 名字里含表外生僻字者**整名退出拼音匹配**，只走汉字子串 —— 不跳字、不猜。
- 排序口径调整（只改第 2 条）：主树 > 姻亲 > 游离 → **姓名 > 拼音 > 称谓** → 生年早的在前。
- 回车直接跳转的口径**不变**：仍然只有「姓名全等」才直接跳。拼音全等（`liming` 唯一命中）照样开列表等人挑 —— 拼音是另一种找人的方式，不是新的快捷方式。
- 结果行右侧灰字标出命中的拼音形式（如 `李明liming`），让人能确认「搜到的就是它」。
- 输入框 placeholder 写明可输拼音（`lx` / `liming`）。除 placeholder 外**不加任何界面元素**（左导航轨 52px，不塞新东西）。
- 明确不做：称谓拼音、运行时引入 npm 拼音依赖、其它 F 项。

## Capabilities

### New Capabilities

- `person-search`: 按姓名 / 称谓 / 拼音在全谱找人，以及命中结果的排序口径与「何时允许直接跳转」的判定。含拼音表的覆盖边界与多音字规则。

### Modified Capabilities

（无 —— 本项目 `openspec/specs/` 目前为空，没有既有能力的需求发生变化。）

## Impact

- 新增：`app/src/core/search.js`、`app/src/core/data/pinyin.js`、`app/src/tests` 中 search 组的单测。
- 改动：`app/src/app.js`（`collectSearchHits` 改为调用 core，结果行渲染 + placeholder 文案）、`app/index.html`（placeholder）、`app/README.md` §二 功能表 F10 状态与 §九 更新日志。
- 依赖：**运行时依赖不变**（仍只有 `html2canvas` + `sql.js`）。拼音表在开发期由脚本生成、提交进仓库，生成脚本落在 `app/scripts/`（开发期工具，不进发布包）。
- 不变量：`core/` 仍然零 DOM、零 npm 依赖，可在 Node 里直接单测；「未覆盖不猜」铁律沿用到生僻字。
- 数据：没有数据库结构变化（搜索是纯查询）。