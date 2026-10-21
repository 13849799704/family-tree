# Tasks

## 1. 拼音表（生成脚本 + 静态表）

- [x] 1.1 写 `app/scripts/gen-pinyin-table.js`：从权威数据源（Unicode Unihan `kMandarin`；备选 GB2312 码表对照）取通用规范汉字一级字，输出 `app/src/core/data/pinyin.js`，每字映射到拼音数组、多音字保留 2 个读音、不带声调；表头注释写明数据源与生成日期。验证：脚本跑一次产出文件，且 `node --check` 通过。
- [x] 1.2 给表本身加单测（并入 `tests/run.js`）：每个键都是 CJK 汉字、每个值至少一个非空小写拼音串、值里不含声调符号与空格；`长` `单` `解` 这类多音字确实存了 2 个读音；表体积在 64 KB 以内（实到 61.6 KB，原估 40 KB 偏小；下限 30 KB 防「没生成全」）。验证：`npm run test:core` 全绿。
- [x] 1.3 确认 `build.files` 不需要为新目录加排除规则（`app/package.json` 的 `files: ["**/*"]` 应已覆盖），并确认该表进得了 asar。验证：读一遍 `package.json` 的 files / asarUnpack 段并说明结论。

## 2. 搜索逻辑下沉到 core（先不含拼音）

- [x] 2.1 新建 `app/src/core/search.js`：纯函数，输入 `people[]` / `kinship` Map / 查询串 / 由调用方传入的 `scopeOf(id)`，输出排好序的命中数组；搬入现有**姓名子串 → 称谓子串**匹配与现有四条排序口径（此时命中途径只有 name / call）。core 层不得出现 `document`、`state`、`$`。验证：`node --check` 通过。
- [x] 2.2 在 `tests/run.js` 新增搜索组单测：姓名子串命中、称谓子串命中、称谓推导失败时兜底文本不得参与匹配（搜「关系待确认」不该捞出一堆人）、空查询串无命中、四条排序各自钉死（主树 > 姻亲 > 游离、姓名 > 称谓、生年早的在前、无生年的最后）。验证：`npm run test:core` 全绿。
- [x] 2.3 **搬迁前后对拍**：用同一份示例数据，把「旧的 `app.js` 内联实现」与「新的 `core/search.js`」的命中途径与排序结果逐人比对，必须完全一致（以固定样例写进 `tests/run.js` 断言，不做运行时对比）。验证：对拍用例全过；有差异就改 core，不许改断言迁就。

## 3. 拼音匹配进 core

- [x] 3.1 在 `core/search.js` 加拼音候选串生成：姓名每个字查表（≤2 音），全拼串按读音组合、首字母取各串首字符；姓名中只要有一个字查不到拼音，该人整条不产出拼音候选。验证：单测覆盖「李明 → `liming` / `lm`」「李长 → `lichang`、`lizhang` / `lc`、`lz`」，以及含表外生僻字的姓名**不产出任何候选**。
- [x] 3.2 加「拼音匹配」这一命中途径：查询串是任一候选串（全拼或首字母）的子串即命中；命中途径按 姓名 → 拼音 → 称谓 的优先级判定，同一人只出现一次；**不做**中间省略（`lming` 不命中「李明」）。验证：单测覆盖首字母、全拼、多音字两读各自命中、`lming` 不命中、拼音**不**匹配称谓。
- [x] 3.3 排序第 2 条改为 姓名 > 拼音 > 称谓。**实现时发现三种命中途径互斥（汉字查询 vs 拉丁查询），这一档平时观察不到** —— 经用户拍板保留三档不改 spec，单测改钉「三途径互斥」这个能观察到的事实，说明补进 design.md D6。验证：`npm run test:core` 全绿。

## 4. 接线到界面 + 文档

- [x] 4.1 `app/src/app.js` 的 `collectSearchHits()` 改为调用 `core/search.js`，`searchScopeOf()` 留在渲染层作 scope 回调传入；`renderSearchMenu()` / `commitSearch()` 的浮层行为（↑↓、回车、滚动位置保持）**不改**。验证：`node --check` 通过，`npm run test:core` 全绿。
- [x] 4.2 结果行：拼音命中的行在姓名右侧以弱化样式补上命中的那个拼音串，姓名 / 称谓命中的行不加。验证：在 `tests/e2e.html` 补一条搜索用例，断言拼音命中行出现该拼音串、姓名命中行不出现。**（e2e 实跑：`.sr-pinyin` = `lcs` PASS；中文「林志」行无 `.sr-pinyin` PASS）**
- [x] 4.3 回车判定保持不变：仍只有「姓名全等且唯一」才直接跳转，拼音全等照常开列表 —— 把这条补成 e2e 用例，防止后续有人顺手改成拼音也能跳。验证：该用例通过。**（e2e 实跑：拼音命中按回车仍开列表 PASS；姓名全等回车直接跳 PASS）**
- [x] 4.4 `app/index.html` 的搜索框 placeholder 写明可输拼音（给首字母与全拼两个示例），**不加任何新控件**。验证：在 `tests/e2e.html` 断言 placeholder 文案含拼音示例。**（e2e 实跑 PASS，文案：姓名 / 称呼 / 拼音（lcs 或 lichangshun））**
- [x] 4.5 文档：`app/README.md` §二 功能表 F10 状态更新为「首字母 + 全拼，已做」；§九 更新日志顶部追加本次条目（版本号第三位 + 1），并同步 `app/package.json` 的 `version`。验证：两处版本号一致（0.2.72）。

## Workflow follow-up

- 打包（`npx electron-builder --win --config.electronDist=...\node_modules\electron\dist`）由用户决定何时做；**纯打包不写更新日志**。
- 归档（archive）等用户实际用过搜索、确认效果之后再走。
- 「结果列表上限 30 对拼音命中是否够用」留待真实数据攒够同首字母用例后复评（design.md 的 Open Question，不阻塞实现）。