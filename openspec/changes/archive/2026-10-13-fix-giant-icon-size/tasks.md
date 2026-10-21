# Tasks

> 全部改动集中在 `app/src/styles/app.css` 一个文件，不涉及 `core/`、`ui/panel.js`、
> `app.js`、`icons.js` 的模板与逻辑（依据 design.md 的 Non-Goals）。

## 1. 尺寸兜底规则

- [x] 1.1 在 `app/src/styles/app.css` 的 reset 块内（`app/src/styles/app.css:12-33` 那组
  `*` / `body` / `button` 规则之后、`/* 屏幕阅读器专用 */` 之前）加入
  `:where(svg:not(.wires)) { width: 1em; height: 1em; }`。
  验证：规则文本里 `:where(` 与 `:not(.wires)` **都在**，且注释写明了
  ① `.wires` 的宽高由 `app/src/ui/tree.js` 的 `setAttribute` 注入、CSS 优先级高于
  presentation attribute，② `:where()` 是为了 0 特异度、不与组件级 `X svg {}` 平手。
- [x] 1.2 复查兜底规则的命中面：确认除 `<svg class="wires">`（`app/index.html:126`）
  之外，没有任何几何尺寸由脚本注入的 SVG 会被误命中 —— 全项目只有这一个，
  静态核对 `app/index.html` 与 `app/src/ui/tree.js` 中 `.wires` 的两处引用即可。
  验证：`.wires` 不被兜底选中，不需要为它补任何显式宽高规则。

## 2. 两处热点的显式尺寸

- [x] 2.1 在 `app/src/styles/app.css` 现有 `.rel-basis` 规则（约 587 行）之后加入
  `.rel-basis svg { width: 14px; height: 14px; vertical-align: -3px; margin-right: 4px; }`。
  验证：`npm start` 源码启动，点开一个触发「长幼判不出来」或「辈分与规则表标注不一致」
  的人（`kin.ageUncertain` / `kin.genMismatch`）—— 告警行首图标与「设为我的视角」按钮
  里的图标同量级，不再出现占满整行宽度的巨大图标，图标与文字视觉对齐。
- [x] 2.2 在 `app/src/styles/app.css` 现有 `.scope-bar b` 规则（约 454 行）之后加入
  `.scope-bar svg { width: 14px; height: 14px; flex: 0 0 14px; }`。
  验证：`npm start` 下顶栏切到「妻子家族」或「母亲家族」页 —— 画布顶部的橙色提示胶囊
  高度与圆角正常，info 图标不再撑破它。

## 3. 回归与留痕

- [x] 3.1 用 `npm start` 做整界面回归，重点看**树本身**：
  ① 全部血缘线（折线 + 箭头）与婚配线（橙色粗横线）完整无缺失、位置与卡片对齐 ——
  这是 `:not(.wires)` 唯一的防线，线消失即为改动失败；② 适应窗口 / 缩放 / 拖拽平移
  后连线仍正常。③ 顶栏搜索图标、家族切换 chips、导航轨按钮图标、详情面板底部按钮图标、
  照片占位加号、面板空状态大图标、家族抽屉条目、Toast 图标 —— 与改动前逐一比对应无差异。
- [x] 3.2 跑 `npm test`，确认 core / db / library 三组全通过。
  验证：本次不涉及 `core/`，此处属连带影响确认，任何失败都说明改动越界了。
- [x] 3.3 `app/package.json` 的 `version` 由 `0.2.72` 改为 `0.2.73`。
  验证：读回该字段确认为 `0.2.73`。
- [x] 3.4 在 `app/README.md` 第九节「更新日志」**顶部**追加一条（日期 2026-10-13，
  标题含 v0.2.73）。内容须写明：① 症状（告警行图标 300×300、切换家族页胶囊条 info 图标）；
  ② 根因（`icons.js` 只写 `viewBox` + 漏写尺寸规则 → 掉进 CSS 默认对象尺寸）；
  ③ 两条改动（14px 显式尺寸 + `:where(svg:not(.wires))` 兜底）；
  ④ `:not(.wires)` 为什么不能省（CSS 优先级高于 presentation attribute，误伤则全树线消失且不报错）；
  ⑤ 手验三步的结论；⑥ 明确记下本次**未加**自动化断言这一取舍与原因。
  验证：新条目位于更新日志第一节，旧条目未被删改。

## Workflow follow-up

- 实现与手验全部完成后，用 `/opsx:archive` 归档该变更。
- 归档后确认 `openspec/specs/ui-icon-sizing/spec.md` 已生成，且其中的 Purpose 与
  4 条 requirement 与本次 delta 一致。
- 后续若要给图标尺寸补 e2e 回归断言（design.md 的 Risks 里记为本次明确不做），
  另开一个变更，不要塞进本次归档。
