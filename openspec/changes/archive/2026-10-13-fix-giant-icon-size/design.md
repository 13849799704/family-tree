# Design

## Context

见 proposal.md - Why。此处只补做方案时需要的现状事实：

**图标生成侧**（`app/src/ui/icons.js`）：

```js
const wrap = (path, { sw = 2, fill = 'none' } = {}) =>
  `<svg viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" ...>${path}</svg>`;
```

输出的 SVG **不带 `width`/`height` 属性**，只带 `viewBox`，颜色一律走 `currentColor`。
该文件顶部注释把这条约定写死了：「尺寸由外层 CSS 决定（svg 不写 width/height，
除非单独指定）」。

**尺寸的现状分布**（20 处调用点，已逐个核对）：

| 来源 | 是否有尺寸规则 |
|---|---|
| `app/index.html` 的 6 个内联 svg | 全部有（`.book-chip` / `.bc-caret` / `.search-ico` 自带 / `.btn` / `.stage-empty` / `.panel-handle`） |
| `app/src/ui/panel.js`、`tree.js`、`dialog.js`、`check.js`、`app.js` 里的模板 | 除下面两处外全部有 |
| `app/src/ui/panel.js` 的告警图标（`.rel-basis` 内） | **无** ← 本次修复 |
| `app/src/app.js:369` 的 info 图标（`.scope-bar` 内） | **无** ← 本次修复 |

**连线层是唯一的例外**：`app/index.html:126` 的 `<svg class="wires" width="2600"
height="1400">`，其 `.wires` 样式（`app/src/styles/app.css`）只有
`position / top / left / overflow / pointer-events` —— **没有宽高**。宽高在每次
渲染/重排时由 `app/src/ui/tree.js` 的 `setAttribute('width'|'height', ...)` 按当前树的
包围盒写入，`viewBox` 同步改写。这是有意为之：连线层必须精确罩住整棵树。

## Goals / Non-Goals

**Goals:**

- 让当前两处巨型图标恢复正常尺寸。
- 让「漏写尺寸规则」的后果从「撑破布局」降级为「按字号渲染」—— 即把契约从**约定**
  变成**结构保证**。
- 兜底对已有的一切渲染结果**零影响**（`.wires` 与 20 处已声明尺寸的图标都不动）。
- 不新增依赖、不动 core 层、不改任何模板或图标定义。

**Non-Goals:**

- 不统一图标尺寸体系。本次只把现有分散在各处的尺寸决策原样保留。
- 不改 `.rel-basis` 告警行的 DOM 形态（不改成 flex 行）。
- 不给这个变更补自动化断言（见 Risks）。
- 不动称谓规则表与称谓推导逻辑 —— 触发告警的条件（`ageUncertain` /
  `genMismatch`）本身没有问题，只是不该带着一张 300px 的图。

## Decisions

### D1 — 兜底规则用 `:where(svg:not(.wires))`，而不是 `svg:not(.wires)`

两个修饰符各自解决一个独立的坑，都不能省。

**(a) 为什么必须 `:not(.wires)`**

SVG 2 起，**任何 CSS 声明的优先级都高于 presentation attribute**。`.wires` 的宽高
正是以 attribute 形式存在的，所以一条命中它的静态规则会直接把它覆盖掉：

```css
/* 若写成这样，整棵树的连线层会被压成 16×16 —— 且不报错、不白屏，只是线没了 */
svg { width: 1em; height: 1em; }
```

`:not(.wires)` 让兜底**永远选不中它**，于是 `.wires` 仍由 `tree.js` 完全掌控。
这也意味着**不需要**给 `.wires` 补任何显式宽高规则（曾经考虑过「反过来保护」，
结论是不必要 —— 多一条固定值规则只会成为新的过期来源）。

**(b) 为什么必须 `:where()`**

`:not()` 会**吃掉参数里最具体那个选择器的特异度**。于是：

| 写法 | 实际特异度 | 与 `.photo svg`（0,1,1）相比 |
|---|---|---|
| `svg:not(.wires)` | (0,1,1) | **平手** → 由源码顺序决定 |
| `:where(svg:not(.wires))` | (0,0,0) | 稳输 → 组件规则永远生效 |

写成 `svg:not(.wires)` 也能「碰巧」正常工作 —— 只要它放在 `app.css` 的 reset 块里、
早于所有组件规则。但那等于把正确性押在源码顺序上：将来谁把这条规则往下挪、
或新增一条同样 0,1,1 的规则，就会**静默改掉某个已有图标的尺寸**。`:where()` 把这个
失效模式整个消掉，且 Electron（Chromium ≥ 88）原生支持。

### D2 — 兜底值取 `1em` 而不是固定像素

兜底的职责是「合理」，不是「精确」。`1em` 让图标自动跟随所在容器的字号：12px 的正文里
得到 12px 图标，16px 的标题里得到 16px 图标，不需要为每种上下文各调一次。真正需要
精确控制的地方（`.tag-expand` 10px、`.reveal` 14px、`.panel-empty` 40px、
`.stage-empty` 56px）本来就都有显式规则，兜底对它们不生效。

### D3 — 两处热点仍给显式 14px，不靠兜底

兜底在这两处会算出 `1em = 12px`（`.rel-basis` 与 `.scope-bar` 的 `font-size` 都是
`--fs-sm` = 12px）。但项目里**行内图标的既有尺寸语言是 14px**（`.reveal svg`、
`.vp-cur svg`、`.check-pass svg` 都是 14px）。12px 会让这两处比周围的图标小一圈。
所以这两处仍显式写 14px —— 兜底负责「不再出事」，这两条负责「看起来对」。

**基线对齐**：`.rel-basis` 是普通段落（`line-height: 1.7`），行内 SVG 默认坐在基线上，
14px 图标在 12px 文字里会显得偏低，因此配 `vertical-align: -3px` 抬到视觉中心附近。
`.scope-bar` 本身已是 `display: flex; align-items: center`，只需尺寸 + `flex: 0 0 14px`
防止被压扁，无需 `vertical-align`。

### D4 — 不改 `icons.js`，不给 `wrap()` 补默认尺寸

给 `wrap()` 加一个默认 `width`/`height` 看起来更省事，但有两个问题：① 修不到**已经**
写好的那两处（它们已经在页面上了）；② 会与项目现行的「按上下文定尺寸」打架 ——
同一份 `ICON.alert` 在 12px 正文里该是 14px，在 40px 空状态里该更大。硬编码进图标定义
等于把尺寸决策从「组件」搬到「图标库」，与该文件自己声明的分工相反。

### D5 — 不把 `.rel-basis` 改成 flex 行（方案 B 不采纳）

改成 `.rel-warn { display: flex; gap: 6px; align-items: flex-start }`（抄 `.err-msg`
的写法）对齐更彻底。但那要改 `app/src/ui/panel.js` 的模板，而本变更已声明不改模板 ——
为一个纯样式缺陷引入 DOM 改动不划算。代价说清楚：`vertical-align: -3px` 是经验值、
是「挪」而不是真正的光学居中。若真机观感仍不理想，升级路径是改走方案 B，
spec 里的「行内告警图标与文字对齐」requirement 不变，实现方式变而已。

## Risks / Trade-offs

- **[兜底规则误伤连线层 → 整棵树的血缘线/婚配线全部消失]** → 唯一的防线就是 `:not(.wires)`，
  而这条规则一旦被误删，**不会报任何错**，画面只是「线不见了」，很容易被误判成数据或
  布局问题。缓解：① 规则注释里写明原因（`:not(.wires)` 与 `tree.js` 的关联）；
  ② tasks.md 把「`:not(.wires)` 是否还在」列为 diff 复查项；
  ③ 手验第 3 步专门看树，全树任何一条线不对即判定失败。
- **[特异度平手导致某个已有图标尺寸被静默改写]** → 已由 D1(b) 的 `:where()` 消除。
- **[1em 兜底在将来某个新容器里偏大或偏小]** → 兜底只是底线而非终点，任何容器仍可用
  `X svg {}` 覆盖；且现有 20 处调用点已全部核对为显式声明，兜底对当前界面零影响。
- **[`vertical-align: -3px` 是经验值，可能在真机上偏]** → 缓解：升级路径明确（方案 B），
  且 spec 的 requirement 约束的是「视觉对齐」这一结果，不锁死实现。
- **[无自动化回归保护]** → CSS 计算宽度在无头 Chrome 里取值不稳，且要驱动详情面板进入
  `ageUncertain` 状态需要额外构造数据集，成本高于收益。本次不补 e2e 断言，改以手验三步
  覆盖；`npm test` 仍跑一遍，确认没有连带影响（理论上不涉及 core，但保持既有习惯）。
- **[Trade-off] 兜底规则让「忘记写尺寸」从编译期/审查期能查的问题变成静默的正常状态** ——
  代价是漏写尺寸不再有视觉症状。接受这个代价：当前 20 处漏 2 处的比例说明靠自觉不可靠，
  而结构性兜底的失效模式（多一个小图标）远轻于原失效模式（界面被撑坏）。

## Migration Plan

无数据迁移、无配置开关、无依赖变更，改动即时生效。

回滚 = 删除 `app/src/styles/app.css` 里新增的 3 条规则，并把 `app/package.json` 的
`version` 与 `app/README.md` 更新日志回退 —— 三条规则彼此独立，删任何一条都不会留下
半吊子状态（`.rel-basis` / `.scope-bar` 两条回到巨型图标，兜底那条变成无害的死代码）。
