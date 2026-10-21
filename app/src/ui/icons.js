/**
 * =========================================================
 * 图标集 · icons.js
 * ---------------------------------------------------------
 * 全部来自 UI 设计稿 v1 原样抄录（lucide 风格，24×24 网格，
 * stroke 描边不填充）。不引第三方图标库 —— 这是零依赖的一部分。
 *
 * 统一约定：
 *   · 尺寸由外层 CSS 决定（svg 不写 width/height，除非单独指定）
 *   · 颜色一律 currentColor，跟随父级 color
 * =========================================================
 */

const wrap = (path, { sw = 2, fill = 'none' } = {}) =>
  `<svg viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

export const ICON = {
  /* ---------- 导航 ---------- */
  /** 家谱树：三人关系图 */
  tree: wrap('<circle cx="12" cy="4" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M12 6.5v5M6 16.5v-3a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3"/>'),
  /** 体检：勾选清单 */
  check: wrap('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  /** 导入 */
  upload: wrap('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>'),
  /** 导出 */
  download: wrap('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>'),
  /** 数据源 / 底稿 */
  source: wrap('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),

  /* ---------- 顶栏 ---------- */
  search: wrap('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>', { sw: 2.2 }),
  plus: wrap('<path d="M12 5v14M5 12h14"/>', { sw: 2.4 }),
  fit: wrap('<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>'),
  /** 视角切换 */
  users: wrap('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', { sw: 2 }),
  users2: wrap('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>', { sw: 2 }),
  up: wrap('<path d="M12 2v20"/><path d="M5 8l7-6 7 6"/>', { sw: 2 }),

  /* ---------- 画布 ---------- */
  chevronDown: wrap('<path d="M6 9l6 6 6-6"/>', { sw: 3 }),
  chevronLeft: wrap('<path d="M15 18l-6-6 6-6"/>', { sw: 2.4 }),
  chevronRight: wrap('<path d="M9 18l6-6-6-6"/>', { sw: 2.4 }),
  target: wrap('<circle cx="12" cy="12" r="3"/><path d="M12 5V3M12 21v-2M5 12H3M21 12h-2"/>', { sw: 2.2 }),
  dead: wrap('<path d="M18 6L6 18M6 6l12 12"/>', { sw: 3 }),
  avatar: wrap('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', { sw: 2 }),
  link: wrap('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>', { sw: 2 }),

  /* ---------- 面板 / 表单 ---------- */
  x: wrap('<path d="M18 6L6 18M6 6l12 12"/>', { sw: 2.2 }),
  edit: wrap('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'),
  trash: wrap('<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  alert: wrap('<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>', { sw: 2.5 }),
  info: wrap('<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>', { sw: 2.2 }),
  sparkle: wrap('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>', { sw: 1.8 }),
  save: wrap('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>', { sw: 2 }),
  clock: wrap('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', { sw: 2 }),
  image: wrap('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>', { sw: 2 }),
  empty: wrap('<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>', { sw: 1.6 }),

  /* ---------- 窄态降级用的图标 ----------
     顶栏空间不足时「只显示姓名」会隐藏文字、只留图标（见 app.css 的 [data-narrow] 规则）。
     那个按钮原本只有一个表示状态的小圆点，圆点说明不了「这个开关是干什么的」，
     去掉文字后就完全认不出来了，所以补一个「Aa」字形图标。
     ⚠️ 它是全套图标里**唯一**用 <text> 的：其余都是描边路径，而「Aa」用路径描不出来。
        所以不能走 wrap()（那里固定了 fill:none + stroke:currentColor）。

     ⚠️⚠️ font-size / y 是**量出来的**，别凭感觉调小（v0.2.79 修）。
        别的图标在 24 格 viewBox 里靠路径占掉约 20 格；而「Aa」的大小只由字号决定：
        原来的 font-size=12.5 在 24格里只有约 9 格字高，**不到路径图标的一半**。
        缩到屏幕上（14px 盒、缩放 0.583）之后：
          · Aa 字高  12.5 × 0.72 × 0.583 ≈ **5.2px**
          · 加号 墨迹 14 格 × 0.583                ≈ **8.2px**
        用户报「缩小后这个 Aa 感觉很小」—— 数字对得上。

        现在 font-size=16，配合 app.css 在窄态给的 17px 盒（缩放 0.708）：
          · 字高 16 × 0.72 × 0.708 ≈ **8.2px**，与「添加成员」的加号同级
          · 排版宽约 20.8 格 / 24 格 ≈ 87%，两侧各留约 1.2px
        ⚠️ **16 是权衡出来的，不是往大调**。试过 18：字高能到 9.2px，
           但排版宽到了 23.4/24 ≈ 97%，几乎顶满盒子 —— 而 `<svg>` 默认
           `overflow: hidden`，换台机器 `--font-ui` fallback 到更宽的字体就会**被裁掉**。
           「两个字母并排」天然比单路径难做大，所以宽度是这条图标的硬约束。
           tests/topbar-layout.html 第 10 组同时钉住「字高 ≥ 邻近图标 70%」
           与「排版宽 ≤ 盒宽 90%」两条。

        y 是让「大写字母的字顶到基线这一段」在 24 格里上下居中算出来的：
        y = 12 + capH/2 = 12 + 0.72 × 16 / 2 ≈ 17.8。 */
  typeAa: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<text x="12" y="17.8" text-anchor="middle" font-size="16" font-weight="600" ' +
    'fill="currentColor" stroke="none">Aa</text></svg>',
};

/** 图标转 HTML 片段（便于模板字符串里拼） */
export const icon = (name) => ICON[name] || '';
