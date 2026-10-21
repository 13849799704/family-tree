# Proposal

## Why

详情面板「称谓推导」里那两条警告行（长幼判不出来 / 辈分与规则表不一致）上的图标，
在真机上渲染成 **300×300px 的巨图**，一个图标占满整行，把警告文字挤到边上。
顶栏切到「妻子家族 / 母亲家族」页时，橙色提示胶囊里的 info 图标有同样的问题。

根因不是画错了图标，而是 `app/src/ui/icons.js` 的 `wrap()` **只写 `viewBox`、不写
`width`/`height`**（该文件注释里写明「尺寸由外层 CSS 决定」）。这意味着每一个调用
点的容器都必须自带一条 `X svg { width: Npx }` 规则 —— 这是一条**纯靠人记的隐式契约，
没有任何机制保证它被遵守**。全项目 20 处调用点里有 2 处漏了，漏掉的那两处就静默掉进
CSS 默认对象尺寸算法（有内在宽高比 1:1、宽高都是 auto → 300×150 再按比例修正成
300×300）。它不报错、不白屏，只是把界面撑坏，所以能潜伏这么久。

同一个坑还留着两颗雷：任何人以后新增图标都可能再踩一次；而要补全局兜底时，
`app/index.html:126` 的 `<svg class="wires">` 会被一起选中 —— 它的宽高是 JS 用
`setAttribute` 写进去的，而 CSS 优先级高于 presentation attribute，一选中整棵树的
连线层就被压没，**且不报错**。这两点决定了这个修复不能只补两条 CSS 就完事。

## What Changes

- **修掉当前两处巨型图标**：`.rel-basis` 内的告警图标（`ui/panel.js` 的
  `kin.ageUncertain` / `kin.genMismatch` 两行）与 `.scope-bar` 内的 info 图标
  （`app.js` 切家族页时渲染的那条）。
- **把「图标尺寸由 CSS 决定」从约定变成结构保证**：加一条 **0 特异度**的全局兜底
  规则，使任何漏写尺寸规则的图标只会拿到一个跟随字号的合理默认值，而不会掉进
  300×300。选 0 特异度是为了让现有及将来所有组件级 `X svg {}` 规则稳赢，
  不出现平手比源码顺序。
- **兜底规则必须排除 `.wires`**：连线层的宽高由 `ui/tree.js` 的
  `setAttribute('width'/'height')` 写入并随每棵树的重排变化，不能被任何静态 CSS 规则
  接管。
- **不改 `icons.js` 的既有分工**（零第三方依赖、尺寸一律由 CSS 给），**不改 DOM 形态** ——
  警告行维持普通段落 + 行内图标，只补尺寸与基线对齐。
- 版本号 `app/package.json` 0.2.72 → 0.2.73，`app/README.md` 第九节更新日志顶部追加一条。

**明确不做**：不给这个变更补 e2e 自动断言（CSS 计算宽度在无头环境里取值不稳，
且需要额外驱动面板进入 `ageUncertain` 状态）；验证以 `npm start` 手验三步为准。
不动称谓规则表、不动 core 层、不新增任何依赖。

## Capabilities

### New Capabilities

- `ui-icon-sizing`: 界面图标的尺寸由结构保证而非逐点自觉 —— 图标在任何调用点都不得
  回落到 CSS 默认对象尺寸；连线层这类由 JS 注入几何尺寸的 SVG 不受此约束影响。

### Modified Capabilities

无。现有 capability 只有 `person-search`（搜索），与图标尺寸无关，其 requirement 不变。

## Impact

| 位置 | 改动 |
|---|---|
| `app/src/styles/app.css` | reset 块内加 1 条全局兜底规则；`.rel-basis` 与 `.scope-bar` 各加 1 条尺寸规则 |
| `app/package.json` | `version` 0.2.72 → 0.2.73 |
| `app/README.md` | 第九节「更新日志」顶部追加一条 |

- **不涉及** `app/src/core/**`：不碰称谓推导、规则表、数据层。
- **不涉及** `app/src/ui/panel.js` / `app.js` / `icons.js`：三者的模板与图标定义一字不改
  —— 纯样式层修复。
- **依赖不变**：仍是 `html2canvas` + `sql.js` 两个。
- **测试**：`npm test`（core/db/library）跑不到 CSS，本次不新增自动化测试；
  风险集中在 `.wires` 是否被误伤，只能手验 —— 这也是 design.md 里把它列为
  首要回归项的原因。
- **界面可见变化**：仅「此前渲染成巨图的两处」恢复正常尺寸，其余界面像素级不变。
