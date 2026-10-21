/**
 * =========================================================
 * 画布渲染 · ui/tree.js
 * ---------------------------------------------------------
 * 输入：core 层算好的坐标（layout.pos）+ 称谓（kinship Map）
 * 输出：DOM 节点 + SVG 连线
 *
 * 【分工铁律】
 *   本文件**不做任何布局计算、不推导任何称谓**。
 *   坐标全部来自 core/layout.js，称谓全部来自 core/kinship.js。
 *   这里只负责把数字变成像素。
 *   —— 一旦在渲染层里写 if(是伯父) 这类逻辑，三栏之外的地方就会
 *      各算各的，最终结果不一致。这个坑设计稿那版已经踩过一次。
 *
 * 【视觉规格】全部沿用 UI 设计稿 v1：
 *   血缘线 #a8b2c0 1.6px 正交折线 + 箭头
 *   婚配线 #d08a2e 2.4px 水平粗线
 *   卡片上下锚点：出线 y+88 / 入线 y+2
 * =========================================================
 */

import { ICON } from './icons.js';
import { LAYOUT } from '../core/layout.js';
import { displayLabel } from '../core/kinship.js';
import { displayName, avatarGlyph, missingFields } from '../core/model.js';

const WIRE_BLOOD = '#a8b2c0';
const WIRE_MARRY = '#d08a2e';

/** 卡片出线 / 入线相对节点左上角的 y 偏移（与设计稿一致） */
const OUT_Y = 88;
const IN_Y = 2;
/** 婚配横线的 y 偏移（在头像中部） */
const MARRY_Y = 30;

/** 称谓大类 → 卡片配色 class */
const BRANCH_CLASS = {
  direct: 'paternal',   // 直系沿用父系蓝（设计稿里直系也是蓝）
  paternal: 'paternal',
  maternal: 'maternal',
  affinal: 'affinal',
};

/** 头像里显示的字统一走 model.avatarGlyph（见 core/model.js） */

export class TreeCanvas {
  /**
   * @param {object} deps
   * @param {HTMLElement} deps.canvasEl 坐标容器（节点 + 连线都放这里）
   * @param {SVGElement}  deps.wiresEl  连线层
   * @param {HTMLElement} deps.stageEl  视口（负责拖拽 / 滚轮）
   * @param {(id:string)=>void} deps.onSelect
   * @param {(key:string|null, anchorId:string)=>void} deps.onToggleFamily
   * @param {(pct:number)=>void} [deps.onZoom]
   */
  constructor({ canvasEl, wiresEl, stageEl, onSelect, onToggleFamily, onZoom }) {
    this.canvasEl = canvasEl;
    this.wiresEl = wiresEl;
    this.stageEl = stageEl;
    this.onSelect = onSelect;
    this.onToggleFamily = onToggleFamily;
    this.onZoom = onZoom;

    this.zoom = 1;
    this.tx = 0;
    this.ty = 0;
    this.state = null;

    this._bind();
  }

  /* ======================================================= */
  /* 事件                                                    */
  /* ======================================================= */

  _bind() {
    // 节点 / 展开角标：事件委托
    this.canvasEl.addEventListener('click', (e) => {
      const nodeEl = e.target.closest('.node');
      if (!nodeEl) return;
      const id = nodeEl.dataset.id;
      const expandBtn = e.target.closest('.tag-expand');
      if (expandBtn) {
        e.stopPropagation();
        this.onToggleFamily?.(expandBtn.dataset.key || null, id);
        return;
      }
      this.onSelect?.(id);
    });

    // 拖拽平移
    let dragging = false;
    let sx = 0, sy = 0, stx = 0, sty = 0;

    this.stageEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('.node')) return;      // 点卡片不算拖拽
      if (e.target.closest('.legend,.zoom-dock,.scope-bar')) return;
      e.preventDefault();   // 阻止拖拽时选中文本/拖出图片
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      stx = this.tx; sty = this.ty;
      this.stageEl.classList.add('grabbing');
      this.stageEl.querySelector('.stage-bg')?.classList.add('grabbing');
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      this.tx = stx + (e.clientX - sx);
      this.ty = sty + (e.clientY - sy);
      this._apply();
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      this.stageEl.classList.remove('grabbing');
      this.stageEl.querySelector('.stage-bg')?.classList.remove('grabbing');
    });

    // 滚轮缩放（以光标为锚点）
    this.stageEl.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) {
        // 普通滚轮 = 平移
        this.tx -= e.deltaX;
        this.ty -= e.deltaY;
        this._apply();
        e.preventDefault();
        return;
      }
      e.preventDefault();
      const rect = this.stageEl.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const next = clamp(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.35, 2.4);
      const k = next / this.zoom;
      this.tx = px - k * (px - this.tx);
      this.ty = py - k * (py - this.ty);
      this.zoom = next;
      this._apply();
      this.onZoom?.(Math.round(this.zoom * 100));
    }, { passive: false });

    // 键盘：方向键平移
    window.addEventListener('keydown', (e) => {
      if (e.target.matches('input,textarea,select')) return;
      const step = e.shiftKey ? 80 : 24;
      const map = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      const d = map[e.key];
      if (!d) return;
      this.tx += d[0];
      this.ty += d[1];
      this._apply();
    });
  }

  _apply() {
    this.canvasEl.style.transform =
      `translate(${this.tx}px, ${this.ty}px) scale(${this.zoom})`;
  }

  /* ======================================================= */
  /* 缩放 / 适应                                              */
  /* ======================================================= */

  setZoom(pct) {
    this.zoom = clamp(pct / 100, 0.35, 2.4);
    this._apply();
    this.onZoom?.(Math.round(this.zoom * 100));
  }

  /** 缩放并保持视口中心不动 */
  zoomBy(factor) {
    const rect = this.stageEl.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const next = clamp(this.zoom * factor, 0.35, 2.4);
    const k = next / this.zoom;
    this.tx = cx - k * (cx - this.tx);
    this.ty = cy - k * (cy - this.ty);
    this.zoom = next;
    this._apply();
    this.onZoom?.(Math.round(this.zoom * 100));
  }

  /**
   * 适应窗口：整棵树铺满并居中
   * @returns {boolean} 是否真的算出了缩放。false 表示容器还没布局好，
   *   调用方应下一帧重试（见下方「零尺寸守卫」）。
   */
  fit(padding = 64) {
    const v = this.state?.view;
    if (!v || !v.bounds) return false;
    const rect = this.stageEl.getBoundingClientRect();
    const w = v.bounds.maxX - v.bounds.minX;
    const h = v.bounds.maxY - v.bounds.minY;

    /* 零尺寸守卫 —— 别让 clamp 静默兜底。
       stageEl 还没布局时（首帧、后台标签页、面板开合过渡中）rect 是 0，
       硬算出来的比值必然是负数，会被 clamp 到下界 0.35，
       树看起来"缩成一小坨"却没有任何报错。这里直接放弃，交给调用方重试。 */
    if (!w || !h || rect.width <= 0 || rect.height <= 0) return false;

    const zoom = clamp(
      Math.min((rect.width - padding * 2) / w, (rect.height - padding * 2) / h),
      0.35, 1.6
    );
    this.zoom = zoom;
    this.tx = (rect.width - w * zoom) / 2 - v.bounds.minX * zoom;
    this.ty = (rect.height - h * zoom) / 2 - v.bounds.minY * zoom;
    this._apply();
    this.onZoom?.(Math.round(this.zoom * 100));
    return true;
  }

  /**
   * 这棵树里有没有这个人。
   * 「回到当前视角」靠它分情况：切到「妻子家族 / 母亲家族」时，「我」不在这棵树上
   * （那是以配偶 / 母亲为根的血亲），这时不该把人硬拽回主树。
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    return !!this.state?.view?.pos?.[id];
  }

  /**
   * 把某个人物居中（搜索命中 / 体检跳转时用）
   *
   * @param {string}  id
   * @param {boolean} [animate=true]   是否走 240ms 过渡
   * @param {number}  [zoomTarget=null] 目标倍率（1 = 100%），null = 保持当前倍率
   *
   * 【为什么体检跳转要放大】
   *   fit() 的倍率是按**整棵树**的包围盒算的，人越多缩得越小 —— 36 人的家族
   *   大约只有 0.5，卡片 76px 宽缩成 40px，姓名生卒全糊着。而体检跳转的用途
   *   是「跳过去改这个人」，就该给修的尺度，不是给浏览的尺度。
   *   ⚠️ 只放大不缩小：用户自己已经放到 1.5 时再点体检，不该被拽回 1.0。
   *
   * @returns {boolean} 是否当场算出了变换。
   *   false = 容器还没布局（切视图那一帧 rect 可能是 0），本方法会自行重试。
   */
  focusOn(id, animate = true, zoomTarget = null) {
    const pos = this.state?.view?.pos?.[id];
    if (!pos) return false;
    const rect = this.stageEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      /* 容器零尺寸时直接放弃 = 人没居中，而用户完全看不出发生了什么
         （setView('tree') 里的 fit() 就有同样的坑）。这里改成自己重试。 */
      this._retryFocus(id, animate, zoomTarget, 0);
      return false;
    }
    if (zoomTarget != null) {
      this.zoom = clamp(Math.max(this.zoom, zoomTarget), 0.35, 2.4);
    }
    this.canvasEl.style.transition = animate ? 'transform 240ms cubic-bezier(.4,0,.2,1)' : 'none';
    // ⚠️ 必须在设完 zoom 之后再算 tx/ty：先算平移再改倍率，人就不在中间了。
    this.tx = rect.width / 2 - (pos.x + LAYOUT.NODE_W / 2) * this.zoom;
    this.ty = rect.height / 2 - (pos.y + 52) * this.zoom;
    this._apply();
    if (zoomTarget != null) this.onZoom?.(Math.round(this.zoom * 100));
    if (animate) {
      setTimeout(() => { this.canvasEl.style.transition = ''; }, 260);
    }
    return true;
  }

  /** 容器还没布局时，隔帧重试居中（上限 8 次 ≈ 400ms，够视图切换的过渡了） */
  _retryFocus(id, animate, zoomTarget, tries) {
    if (this._focusTimer) clearTimeout(this._focusTimer);
    this._focusTimer = setTimeout(() => {
      this._focusTimer = null;
      if (!this.state?.view?.pos?.[id]) return;   // 人已不在当前视图（切了家族）→ 放弃
      if (this.focusOn(id, animate, zoomTarget)) return;
      if (tries < 8) this._retryFocus(id, animate, zoomTarget, tries + 1);
    }, 50);
  }

  /**
   * 救急：**视口里一个人都看不见时**，自动把整棵树拉回视野。
   *
   * ⚠️ 为什么需要它（实测踩出来的）：
   *   改关系会让整棵树重新布局 —— 改一次母亲关系，族源就变了，所有节点的
   *   x/y 全变。而 `commit()` 只 recompute + render，**完全不动画布**。
   *   于是人还留在旧视口里，而节点已经跑到几千像素开外 → 画布一片空白，
   *   数据侧却查不出任何问题（成环、坐标、布局校验全是绿的）。
   *   切家族也一样：两棵树的坐标范围根本不重叠
   *   （主树 x[−1858~3098]、李允家族 x[−2034~−158]），
   *   沿用上一个视口就是空白。
   *
   * 【判据必须是「一个都看不见」，不是「有几个看不见」】
   *   只要还有一个人在你正盯着的那一小块区域里，就绝不打扰你；
   *   只有满屏空白（节点全在视口外）才动用户的视口。
   *   这条判据让「正常浏览时改个字」完全不受影响。
   *
   * @returns {boolean} 是否真的拉回来了
   */
  ensureVisible() {
    const v = this.state?.view;
    if (!v || !v.pos) return false;
    const ids = Object.keys(v.pos);
    if (!ids.length) return false;

    const rect = this.stageEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    const z = this.zoom;
    const cardH = 104 * z;          // 卡片实际高度（含下方行距）
    for (const id of ids) {
      const q = v.pos[id];
      const sx = q.x * z + this.tx;
      const sy = q.y * z + this.ty;
      if (sx + LAYOUT.NODE_W * z > 0 && sx < rect.width
        && sy + cardH > 0 && sy < rect.height) {
        return false;              // 还有人看得见 → 视口是好的，别碰
      }
    }
    return this.fit();
  }

  /* ======================================================= */
  /* 渲染                                                    */
  /* ======================================================= */

  /**
   * @param {object} state
   * @param {object} state.view       { tree, pos, bounds }
   * @param {Map}    state.kinship    id -> deriveKinship 结果
   * @param {string} state.viewpoint  视角人 id
   * @param {string|null} state.activeId
   * @param {Array}  state.expandable [{ key, anchorId }]
   * @param {string|null} state.openKey 当前已展开的原生家族 key
   * @param {boolean} [state.showCall=true] 「只显示姓名」关掉时为 false：
   *        卡面大字换成姓名、原姓名小字不再画（见 core/kinship.js displayLabel）
   */
  render(state) {
    this.state = state;
    const { view, kinship, viewpoint, activeId, expandable = [], openKey, showCall = true } = state;
    if (!view) return;

    this._drawWires(view);
    this._drawNodes({ view, kinship, viewpoint, activeId, expandable, openKey, showCall });

    /* SVG 的视口必须**正好罩住整棵树**，起点用 minX/minY，不能用 0。
       ⚠️ 以前写的是 max(1, b.maxX + 200) —— 视口从 0 起、宽到 maxX，
       大家族（minX 常在 -2000 上下）**左边那一大片内容整个落在视口外**。
       屏幕上靠 CSS 的 overflow:visible 撑着还看得见，**导出图片时就全没了**：
       html2canvas 把 SVG 当一张独立图片渲染，而 SVG 根元素此时按规范是
       overflow:hidden，超出视口的笔画在 PNG 上会被裁掉。
       改用 viewBox 把内容范围映射进视口。

       ⚠️⚠️ 改 viewBox 时踩的坑（v0.2.64 回归，2026-10-12）：
       viewBox 是把「内容坐标 (minX,minY)」映射到「**元素**内的 (0,0)」，
       而 SVG 元素在画布里本身还停在 (0,0)（.wires 的 CSS top/left 是 0），
       卡片却是按绝对坐标摆的 —— **两边坐标系不一致**。
       结果整棵树的线被整体平移了 (minX, minY)（主树是右移 1918px、下移 64px）：
       屏幕上「线没对上人」，导出图里「线不全」，**其实是同一个毛病**。
       所以光改 viewBox 不够，必须把 SVG 元素本身挪到 minX/minY，
       让两边的原点重新对齐。 */
    const b = view.bounds;
    const w = Math.max(1, b.maxX - b.minX);
    const h = Math.max(1, b.maxY - b.minY);
    this.wiresEl.setAttribute('width', w);
    this.wiresEl.setAttribute('height', h);
    this.wiresEl.setAttribute('viewBox', `${b.minX} ${b.minY} ${w} ${h}`);
    this.wiresEl.style.left = `${b.minX}px`;
    this.wiresEl.style.top = `${b.minY}px`;
  }

  _drawWires(view) {
    const { tree, pos } = view;
    const canExpand = new Map();
    for (const ex of this.state.expandable || []) {
      if (!canExpand.has(ex.anchorId)) canExpand.set(ex.anchorId, ex);
    }

    /* 主轴人 → 配偶（用于算「单元」中心与右边界） */
    const spouseOfMain = {};
    for (const [a, b] of tree.couples) {
      const aMain = tree.bloodIds.has(a);
      const bMain = tree.bloodIds.has(b);
      if (aMain && !bMain) spouseOfMain[a] = b;
      else if (!aMain && bMain) spouseOfMain[b] = a;
    }

    /**
     * 单元中心 = 主轴人和配偶为一整体时的中心。
     * ⚠️ 必须用单元中心而不是卡片中心：layout 保证「父单元中心 = 子女群中心」，
     *    从卡片中心出线会在有配偶时偏左半个身位。
     */
    const unitCenter = (id) => {
      const s = spouseOfMain[id];
      if (s && pos[s]) return (pos[id].x + pos[s].x + LAYOUT.NODE_W) / 2;
      return pos[id].x + LAYOUT.NODE_W / 2;
    };
    const unitRight = (id) => {
      const s = spouseOfMain[id];
      if (s && pos[s]) return Math.max(pos[id].x, pos[s].x) + LAYOUT.NODE_W;
      return pos[id].x + LAYOUT.NODE_W;
    };

    let h = '';

    /* --- 血缘线：父单元中心 下折 → 子女中心 --- */
    for (const [cid, pid] of tree.lineage) {
      if (!pos[cid] || !pos[pid]) continue;
      const sx = unitCenter(pid);
      const sy = pos[pid].y + OUT_Y;
      const ex = unitCenter(cid);
      const ey = pos[cid].y + IN_Y;
      const midY = (sy + ey) / 2;

      h += `<path d="M${sx} ${sy} L${sx} ${midY} L${ex} ${midY} L${ex} ${ey}"`
        + ` fill="none" stroke="${WIRE_BLOOD}" stroke-width="1.6" stroke-linejoin="round"/>`;
      h += `<path d="M${ex - 3.5} ${ey - 6} L${ex} ${ey - .5} L${ex + 3.5} ${ey - 6}"`
        + ` fill="none" stroke="${WIRE_BLOOD}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
    }

    /* --- 婚配线：两卡片之间水平粗线 --- */
    for (const [a, b] of tree.couples) {
      if (!pos[a] || !pos[b]) continue;
      const left = Math.min(pos[a].x, pos[b].x) + LAYOUT.NODE_W;
      const right = Math.max(pos[a].x, pos[b].x);
      if (right <= left) continue;
      const y = pos[a].y + MARRY_Y;
      h += `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}"`
        + ` stroke="${WIRE_MARRY}" stroke-width="2.4" stroke-linecap="round"/>`;
    }

    /* 让 unitRight 不白算（未来画「展开指示线」会用到） */
    void unitRight;

    this.wiresEl.innerHTML = h;
  }

  _drawNodes({ view, kinship, viewpoint, activeId, expandable, openKey, showCall = true }) {
    const { tree, pos } = view;

    // 可展开的人 → key 映射
    const expandByAnchor = new Map();
    for (const ex of expandable) {
      if (!expandByAnchor.has(ex.anchorId)) expandByAnchor.set(ex.anchorId, ex);
    }

    const frag = document.createDocumentFragment();

    for (const p of tree.people) {
      const at = pos[p.id];
      if (!at) continue;

      const kin = kinship.get(p.id);
      const isSelf = p.id === viewpoint;
      const cls = BRANCH_CLASS[kin?.branch] || 'paternal';
      const ex = expandByAnchor.get(p.id);

      const el = document.createElement('div');
      el.className = [
        'node',
        cls,
        p.alive === false ? 'deceased' : '',
        p.id === activeId ? 'sel' : '',
        isSelf ? 'anchor' : '',
      ].filter(Boolean).join(' ');
      el.style.left = at.x + 'px';
      el.style.top = at.y + 'px';
      el.dataset.id = p.id;
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      const hasOverride = !!(p.callOverride && p.callOverride[viewpoint]);
      el.setAttribute('aria-label',
        `${displayLabel(p, kin, viewpoint, showCall)} ${displayName(p)}${p.alive === false ? '，已故' : ''}`);

      /* 「只显示姓名」：大字位改写姓名，原来那行小字姓名就不再画（不重复出现）。
         卡片宽度 --node-w 恒定、行高 ROW_H 恒定，少一行不影响坐标，也不会重叠。 */
      const callText = displayLabel(p, kin, viewpoint, showCall);
      const callCls = showCall
        ? ((kin && kin.ok) || hasOverride ? 'node-call' : 'node-call unknown')
        : 'node-call node-call-name';

      const avatarInner = p.avatar
        ? `<img src="${esc(p.avatar)}" alt="">`
        : avatarGlyph(p);

      const todo = missingFields(p).length
        ? `<span class="tag-todo" title="信息待补：姓名/性别未填，点开可补">待补</span>`
        : '';

      el.innerHTML = `
        ${isSelf ? '<span class="anchor-flag">我</span>' : ''}
        <div class="avatar">${avatarInner}${todo}
          ${p.alive === false ? `<span class="tag-dead">故</span>` : ''}
          ${ex ? `<span class="tag-expand${openKey === ex.key ? ' on' : ''}"
                    data-key="${esc(ex.key)}"
                    title="${openKey === ex.key ? '收起' : '展开'}TA的原生家族"
                    role="button" tabindex="0">${ICON.chevronDown}</span>` : ''}
        </div>
        <div class="${callCls}">${esc(callText)}</div>
        ${showCall ? `<div class="node-name">${esc(displayName(p))}</div>` : ''}`;

      frag.appendChild(el);
    }

    // 清空旧节点（保留 wires SVG）
    this.canvasEl.querySelectorAll('.node').forEach((n) => n.remove());
    this.canvasEl.appendChild(frag);
  }

  /** 只更新选中态，不重绘整棵树（点选时用，避免闪烁） */
  setActive(id) {
    if (this.state) this.state.activeId = id;
    this.canvasEl.querySelectorAll('.node').forEach((n) => {
      n.classList.toggle('sel', n.dataset.id === id);
    });
  }

  /* ======================================================= */
  /* 导出图片用的离屏副本                                      */
  /* ======================================================= */

  /**
   * 造一份「导出用的离屏副本」，拍完由调用方 dispose() 掉。**异步**。
   *
   * 【为什么不直接拍 #canvas】
   *   ① #canvas 是 position:absolute 且没有显式宽高（子节点全是 absolute），
   *      它的 getBoundingClientRect() 宽高为 0 —— 而 html2canvas 正是靠它
   *      推断画布尺寸，直接拍会得到一张 0×0 的图。
   *   ② 它身上挂着 transition: transform，为了把内容对齐到容器而改它的
   *      transform，动画会在中途被拍进去。
   *   ③ 用户正在看的缩放 / 平移 / 选中态一点都不能动。导出是「把现在这
   *      一份原样拿走」，不该让界面跳一下。
   *
   * 【为什么 SVG 要先转成 PNG 再交给 html2canvas】★ 本功能的第二个坑
   *   html2canvas 渲染**内联 <svg>** 时会漏画、错位：几千像素宽的谱树里，
   *   婚配线和箭头大面积消失（实测血亲线只画出 57%），而**屏幕上完全正常** ——
   *   因为屏幕走的是浏览器原生光栅化。
   *   绕法：先用浏览器的 Image 把 SVG 光栅化成 PNG（这一步等于借用原生渲染，
   *   100% 可靠），再把 <img> 交给 html2canvas —— 它对 <img> 支持得很好。
   *   实测改完：血亲线 5856 → 10979，婚配线从「几乎看不见」变成完整。
   *
   * 【导出的图一律不显示称呼】（v0.2.71，固定行为、无开关）
   *   导出图是给人「认人」的，认人的线索是姓名；称呼是站在某个视角下才成立的
   *   说法，印在分享图上容易让人以为图出错。屏幕上的显示照旧，不受影响。
   *
   * @param {{cssWidth:number, cssHeight:number, offsetX:number, offsetY:number}} plan
   *        尺寸与落点由 core/export-image.js 算好（那里能单测）
   * @param {Map<string,object>} [palette] 该页按「本页锚点」重算的称谓 Map。
   *        给了就把副本的配色整体换成它的 —— 见下面「导出图的配色」。
   * @returns {Promise<{el: HTMLElement, dispose: () => void}|null>}
   */
  async mountExportSnapshot(plan, palette) {
    if (!plan?.cssWidth) return null;

    const root = document.createElement('div');
    root.className = 'export-root';
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText = 'position:fixed;left:0;top:0;z-index:-99999;pointer-events:none;'
      + `width:${plan.cssWidth}px;height:${plan.cssHeight}px;background:#fff;`;

    const clone = this.canvasEl.cloneNode(true);

    /* 副本不能沿用正本的 id：同一个 document 里出现两个 #wires，
       后面谁再 querySelector('#wires') 就会拿到错的那个。 */
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));

    /* 卡片是 tabindex="0" 的，副本不摘掉的话，用户按 Tab 会「看不见地」
       走进这张还没拍完的图里。 */
    clone.querySelectorAll('[tabindex]').forEach((el) => el.removeAttribute('tabindex'));

    /* 静态图不该出现的东西，三类：
       ① **交互状态**：选中光晕 / 视角人光晕 —— 别人看的图里没有「你刚点了谁」；
       ② **交互暗示**：「展开」角标（点了能开原生家族）、「待补」角标（录入提示）——
          静态图里点不动，挂着反而像 bug；
       ③ **视角人标记**（卡片上方那个「我」）：第一人称对看图的人没有意义，
          换成人名也一样多余 —— 「谁是视角人」取决于**看图的人**从哪看，
          印在图上只会让人以为那是谱里某个人的绰号。整块去掉。
       ⚠️ 屏幕上的标记**全部保留**，这里只改克隆体。 */
    clone.querySelectorAll('.anchor-flag, .tag-expand, .tag-todo')
      .forEach((el) => el.remove());

    clone.querySelectorAll('.node.sel, .node.anchor').forEach((el) => {
      el.classList.remove('sel', 'anchor');
    });

    /* 【导出的图一律不显示称呼 —— 固定行为，没有开关】（v0.2.71）
       分享出去的是**给人认人**的图，认人的线索是姓名。称呼是**站在「我」视角**
       才成立的说法：同一张图，母亲的弟弟在主树叫「舅舅」，在母亲家族页本该叫
       「弟弟」，分享给外人时两种叫法只会让人以为图错了。所以图上只留姓名。

       实现方式是**把副本的卡片改写成「只显示姓名」模式的样子**（与顶栏那个
       开关同一套 DOM 形态：.node-call 挂 node-call-name 装姓名、小字姓名行删掉）。
       卡片宽 --node-w / 行高 ROW_H 恒定，少一行不改坐标，也不会重叠。
       ⚠️ 屏幕上的显示**不受影响** —— 用户自己开着「只显示姓名」时两边一致，
          没开时只是导出图比屏幕干净。 */
    const byId = new Map((this.state?.view?.tree?.people || []).map((x) => [x.id, x]));
    for (const el of clone.querySelectorAll('.node')) {
      const p = byId.get(el.dataset.id);
      if (!p) continue;
      const callEl = el.querySelector('.node-call');
      if (callEl) {
        callEl.textContent = displayName(p);
        /* unknown 是「称谓算不出来」的样式，姓名模式下不挂 —— 否则整片橙色，
           看着像「这页人称谓待确认」。 */
        callEl.classList.remove('unknown');
        callEl.classList.add('node-call-name');
      }
      el.querySelector('.node-name')?.remove();
      el.setAttribute('aria-label', `${displayName(p)}${p.alive === false ? '，已故' : ''}`);
    }

    /* 【导出图的配色：按「本页锚点」重算，而不是按「我」】
       屏幕上的配色永远是相对视角人（默认「我」）算的 —— 这是**浏览**时要的，
       它回答的是「谁离我近、谁是我的姻亲」。
       但分享出去的图是**拿给所有亲戚一起看的**，那份图不该替谁划分立场：
       停在母亲家族页时整片玫红，娘家人看着亲切，旁人却会觉得「这图是站哪边的」。

       所以家族页导出时改用**该页锚点**（母亲 / 妻子）当视角重算一遍：
       这一支的人自然同色，嫁进来的配偶保留橙色，一眼看出哪两家联姻。
       主树保持原样（它本来就是从「我」看的）。
       ⚠️ 只改副本 —— 屏幕上一律不动，浏览时仍按「我」的远近上色。 */
    if (palette) {
      for (const el of clone.querySelectorAll('.node')) {
        const cls = BRANCH_CLASS[palette.get(el.dataset.id)?.branch] || 'paternal';
        el.classList.remove('paternal', 'maternal', 'affinal');
        el.classList.add(cls);
      }
    }

    /* 逐条设，不用 cssText += —— 那样会把 _apply() 写进去的内联 transform
       留在串里，靠「后者覆盖前者」生效，太脆。 */
    clone.style.transform = 'none';
    clone.style.transition = 'none';
    clone.style.left = `${plan.offsetX}px`;
    clone.style.top = `${plan.offsetY}px`;

    root.appendChild(clone);
    await svgToImage(clone);

    document.body.appendChild(root);
    return { el: root, dispose: () => root.remove() };
  }
}

/**
 * 把容器里的内联 <svg> 换成同尺寸的 <img>（内容是该 SVG 的 PNG 光栅化结果）。
 *
 * ⚠️ 这是为了绕开 html2canvas 渲染内联 SVG 时的漏画 / 错位，
 *    原因与取舍见 TreeCanvas.mountExportSnapshot 的注释。
 * 转不动（理论上不该发生）时保持原样 —— 宁可少画点线，也不能让整张图失败。
 */
async function svgToImage(scope) {
  const svg = scope.querySelector('svg.wires');
  if (!svg) return;
  const w = svg.getAttribute('width');
  const h = svg.getAttribute('height');
  try {
    const url = 'data:image/svg+xml;charset=utf-8,'
      + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    img.style.position = 'absolute';
    img.style.left = svg.style.left;
    img.style.top = svg.style.top;
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
    svg.replaceWith(img);
  } catch { /* 保持原 SVG */ }
}

/* ========================================================= */
/* 小工具                                                      */
/* ========================================================= */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
