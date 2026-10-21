/**
 * =========================================================
 * 主控制器 · app.js
 * ---------------------------------------------------------
 * 唯一的「有状态」文件。职责：
 *   ① 持有数据与视图状态
 *   ② 每次变更 → 重算派生数据 → 重绘
 *   ③ 事件的唯一接线处
 *
 * 【派生数据一览】改任何数据后必须按序重算：
 *   gen 解析 → 索引 → 家族树 → 布局 → 称谓 → 体检
 *   顺序不能乱：布局依赖 gen，称谓依赖索引和 gen，体检依赖前三者。
 *
 * 【性能取舍】全量重算在 40 人规模下 < 5ms，所以不做增量更新。
 *   族谱是「看」的应用而不是「刷」的应用，简单直接胜过聪明。
 * =========================================================
 */

import { SAMPLE_DATA } from './data/sample.js';
import {
  normalizeDataset, buildIndex, withResolvedGen, makeId, displayName,
} from './core/model.js';
import {
  buildMainTree, detectExpandableFamilies, buildFamilyTree, scopeToTree,
} from './core/family.js';
import { layoutAllTrees } from './core/layout.js';
import { deriveAllKinships, ruleStats } from './core/kinship.js';
import { diagnose } from './core/diagnose.js';
import { collectHits, search } from './core/search.js';
import { imagePlan, imageFilename, safeFileToken, dateStamp } from './core/export-image.js';
import {
  loadDataset, saveDataset, clearDataset, exportFile, exportImageFile, importFile, importFromDisk,
  storageMode, storageInfo, openDataDir,
  listBooks, currentBook, createBook, switchBook, renameBook, deleteBook,
} from './store.js';
import {
  ensure, ensureForDataset, forget, invalidate as invalidatePhotos, cached, photoBridge,
} from './core/photos.js';
import { collectPhotoRefs } from './core/photoNames.js';
import { TreeCanvas } from './ui/tree.js';
import { renderPanel } from './ui/panel.js';
import { renderCheck } from './ui/check.js';
import {
  openPersonDialog, confirmOverlay, newBookDialog, exportScopeDialog, exportImageDialog,
} from './ui/dialog.js';
import { ICON } from './ui/icons.js';

/* ========================================================= */
/* 状态                                                        */
/* ========================================================= */

const state = {
  dataset: null,
  index: null,
  kinship: null,
  diagnosis: null,
  expandable: [],
  layouts: {},
  mainTree: null,

  viewpoint: '',
  familyKey: 'main',   // 当前显示的树：'main' 或 'natal_xxx'
  openKey: null,       // 当前展开的原生家族 key（= familyKey 当它不是 main 时）
  activeId: null,
  view: 'tree',        // 'tree' | 'check'
  firstRun: false,

  /* v0.2.54：「只显示姓名」开关。
     true = 显示称谓（与 v0.2.53 及以前完全一致，也是默认值）；
     false = 卡面与详情面板只按姓名认人。
     称谓照算不误，这个开关只决定「显不显示」。存本机（localStorage），
     不进 dataset —— 纯显示偏好不该跟着谱导出、跑到别人电脑上。 */
  showCall: true,

  /* v0.2.55：搜索结果浮层的状态。
     hits 存的是**上一次查询的全谱命中**（含姻亲家族页的人），按已排好序的
     顺序存 —— 上下键移动就是挪下标，不重算。
     query 留着是为了高亮：重绘列表时要用它把命中的那几个字标出来。 */
  searchQuery: '',
  searchHits: [],
  searchSel: -1,
  /* 高亮这一条**是用户自己选出来的**（按过 ↑↓）吗？
     这才是回车的分水岭：选过了 =「我要这条」，照办；
     没选过 = 还在犹豫，按 commitSearch 的判断表走。
     v0.2.60 拿「列表是回车开的」当标志，漏了「用户已经选过了」这一路，
     于是选完按回车只会把列表重开、高亮弹回第一条 —— 用户看着就是「按了没反应」。 */
  searchChoiceValid: false,

  /* v0.2.24：可以同时存在多本谱（各自独立的一份数据集）。
     book = 当前这本 {id, name}；books = 清单。二者只用于界面显示，
     真正的读写目标由**主进程的 currentId** 决定，切过去才算数。 */
  book: null,
  books: [],
};

/* ========================================================= */
/* DOM                                                         */
/* ========================================================= */

const $ = (id) => document.getElementById(id);
let canvas = null;
let overlay = null;

/* ========================================================= */
/* 本机显示偏好（v0.2.54）                                      */
/* ---------------------------------------------------------
 * 只放「怎么显示」，不放「数据是什么」：
 * 族谱数据一律走 store.js（SQLite / localStorage），
 * 这里的开关跟着**这台机器**走，不进 dataset、不进导出文件。
 * ========================================================= */

const UI_KEY = 'genogram.ui.v1';

function readUiPrefs() {
  try {
    const raw = localStorage.getItem(UI_KEY);
    const o = raw ? JSON.parse(raw) : null;
    // 读不到 / 存的不是布尔 → 一律回到默认「显示称谓」，绝不猜
    return { showCall: typeof o?.showCall === 'boolean' ? o.showCall : true };
  } catch {
    return { showCall: true };
  }
}

function writeUiPrefs(patch) {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ ...readUiPrefs(), ...patch }));
  } catch (e) {
    // 存不了只是下次又要点一次，不该打断操作
    console.warn('[ui] 显示偏好没能存下：', e);
  }
}

/* ========================================================= */
/* 启动                                                        */
/* ========================================================= */

function boot() {
  const saved = loadDataset();
  state.firstRun = !saved;
  state.dataset = saved || normalizeDataset(SAMPLE_DATA);
  state.viewpoint = state.dataset.viewpoint || state.dataset.people[0]?.id || '';
  state.showCall = readUiPrefs().showCall;

  // 谱清单（同步读：桌面版在 bootstrap 时就带过来了）
  state.books = listBooks().books || [];
  state.book = currentBook() || state.books[0] || null;
  renderBookChip();

  canvas = new TreeCanvas({
    canvasEl: $('canvas'),
    wiresEl: $('wires'),
    stageEl: $('stage'),
    onSelect: selectPerson,
    onToggleFamily: (key, anchorId) => toggleFamily(anchorId, key),
    onZoom: (pct) => { $('zoomVal').textContent = pct + '%'; },
  });

  overlay = $('overlay');

  bindChrome();
  bindPanel();
  bindCheck();
  bindKeyboard();
  bindDesktopMenu();   // 桌面版才有；网页版内部直接 return
  bindEditingMode();   // 同上：把「弹窗打开」告诉主进程，让它禁用原生菜单项

  watchTopbarNarrow(); // 顶栏窄态观察（v0.2.76）：窗口缩放时重新判定按钮要不要降级

  recompute();
  render();
  warmPhotos();   // 带头像 / 照片的成员：异步取图，到了再重绘

  /* 初始视角。
     开发便利：URL 带 ?zoom=2 可直接放大到 200%，?focus=p_me 把某人居中。
     不带参数时行为不变（自动适应窗口）。

     ⚠️ 别用固定毫秒数赌「布局已经好了」—— 容器还没量出宽高时 fit() 会返回 false，
        那时硬算只会得到被 clamp 到 0.35 的假缩放。
     改成：双 rAF 等样式/布局落地，若仍不可用则下一帧重试（上限 20 次）。
     标签页在后台时 rAF 本就不触发，重试自然挂起，不会空转。 */
  const params = new URLSearchParams(location.search);
  const qZoom = Number(params.get('zoom'));
  const qFocus = params.get('focus');

  const applyInitialView = (tries = 0) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // setZoom 不依赖容器尺寸，恒定成功；fit 可能因容器零尺寸而失败
        const done = qZoom ? (canvas.setZoom(qZoom * 100), true) : canvas.fit();
        if (!done && tries < 20) return applyInitialView(tries + 1);
        if (qFocus) canvas.focusOn(qFocus, false);
      });
    });
  };
  applyInitialView();

  if (state.firstRun) {
    // 人数从真实数据里取，不要写死 —— 写死的数字迟早和示例数据对不上
    toast(`已载入示例家族（${state.dataset.people.length} 人）· 可直接换成你自己的数据`, 'ok', 4200);
    /* 桌面版：首次运行就把示例数据落进数据库。
       这样用户的 genogram.db 一打开就是有内容的，立刻可以拷走当备份，
       而不是「看着有数据、其实文件是空的」这种容易误判的中间态。
       网页版不动这个行为（保持 localStorage 版的原有语义）。 */
    if (storageMode() === 'sqlite') saveDataset(state.dataset);
  } else {
    toast('已载入本地存档', 'ok', 2000);
  }
}

/* ========================================================= */
/* 派生数据重算                                                */
/* ========================================================= */

function recompute() {
  // 1) 世次：显式 gen 优先，其余推导
  state.dataset = withResolvedGen(state.dataset);

  // 2) 索引
  state.index = buildIndex(state.dataset);

  // 3) 家族树：主树 + 可展开的原生家族
  state.mainTree = buildMainTree(state.dataset, state.viewpoint);
  state.expandable = detectExpandableFamilies(state.dataset, state.mainTree);

  // 4) 布局：全部一次排完（保证锚点对齐）
  state.layouts = layoutAllTrees(
    state.dataset, state.mainTree, state.expandable, buildFamilyTree
  );

  // 5) 称谓
  state.kinship = deriveAllKinships(state.dataset, state.viewpoint);

  // 6) 体检
  state.diagnosis = diagnose(state.dataset, { viewpoint: state.viewpoint });

  // 当前树若已不存在（数据改了），退回主树
  if (!state.layouts[state.familyKey]) {
    state.familyKey = 'main';
    state.openKey = null;
  }
  // 选中的人若被删了，退回视角人
  if (state.activeId && !state.index.byId.has(state.activeId)) {
    state.activeId = state.viewpoint;
  }
  if (!state.activeId) state.activeId = state.viewpoint;
}

/** 落库（重算 + 重绘 + 持久化）
 *  顺序：先让界面动起来（乐观更新），再等落盘 —— 桌面版写库要过 IPC，
 *  没必要让用户盯着界面等磁盘。落盘失败再弹警告，数据还在内存里没丢。
 */
async function commit(message) {
  recompute();
  render();
  /* 关系一改整棵树重排，视口却留在原地 → 满屏空白且数据侧查不出问题。
     这里兜一下：只有「一个节点都看不见」时才动视口，正常浏览不受影响。 */
  canvas.ensureVisible();
  const res = await saveDataset(state.dataset);
  if (!res.ok) toast(res.error, 'warn', 6000);
  else if (message) toast(message, 'ok');
}

/* ========================================================= */
/* 渲染                                                        */
/* ========================================================= */

function render() {
  /* 数据一改，上一次的搜索结果就过期了（人可能已被删、关系可能已改）——
     与其留着点一下跳到空处，不如直接收起来。 */
  closeSearchMenu();
  renderTabs();
  renderRail();
  renderBookChip();   // 人数会变，谱名不会 —— 顺手一起刷，成本可忽略
  renderCallToggle();
  renderStage();
  renderPanelArea();
  renderCheckArea();
  syncTopbarNarrow();   // 谱名/页签变了会改变顶栏的宽度压力，渲染完要重新判一次
}

/* =========================================================
   顶栏窄态：空间不足时把可降级的按钮切成图标态（v0.2.76）
   ---------------------------------------------------------
   ⚠️ 这里有两个坑，都是实测踩出来的，别简化：

   ① 判据**不能**用 `topbar.scrollWidth > topbar.clientWidth` ——
      顶栏**永远不会横向溢出**：flex 会把缺口吃进各项的宽度里，
      实测 scrollWidth 恒等于 clientWidth（1024 下两者都是 1024）。
      拿它当判据，条件永远为假，这个功能等于没做。

   ② **判据必须与「当前是不是窄态」无关** —— 这是 v0.2.78 修的自激振荡，
         也是这一整段最要紧的一条。别的地方都可以商量，这条不能。

         原来的判据是「搜索框当前的可见文字宽」。而切窄态**恰好会把这个量撑大**
         （按钮让位 + 输入框内边距收紧），于是判据被自己的动作推着走：
         判「不够宽」→ 切窄态 → 变够宽 → 判「够宽了」→ 切回文字态 → 又不够宽……
         每个周期改一次顶栏属性，视觉上就是顶部一直在闪（用户报的现象）。

         ⚠️ **v0.2.76 试过用滞回阈值解决，v0.2.77 又试过「右内边距取固定值」** ——
            两次都不够，原因是「切一次能让搜索框多宽」**不是一个常数**：

             | 窗口宽 | 文字态搜索框 | 窄态搜索框 | 收益 |
             |---|---|---|---|
             | 1400 | 195px | 298px（撞 `max-width:300` 封顶） | **103px** |
             | 1260 | 298px（撞封顶） | 62px | **236px** |

            同一份顶栏、同两个按钮，收益差了 130px —— 因为 `.search` 是 `flex: 1`
            （即 `1 1 0%`，基准 0）**且**有 `max-width: 300px` 封顶，
            「剩余空间怎么分、收缩按什么比例摊」完全不是线性的。
            所以任何「阈值差 ≥ 收益」的调参都只在某个宽度附近成立，换个宽度就又翻了。

         **现在的做法：判据量的是「如果保持文字态，搜索框能有多宽」** ——
         已经在窄态时就临时摘掉 `data-narrow` 量一眼再戴回去。
         于是这个量只是「窗口宽度 + 内容」的函数，**与当前状态无关**，
         翻不翻转从根上不存在了，阈值取多少都不会自激（详见 `wideModeTextWidth`）。

         双阈值仍然保留，但只为了挡 1~2px 的测量抖动，间隙很小（40 → 64）。
         v0.2.76 那个 160 是为了压住振荡才被迫抬到那么高的 ——
         根因去掉之后不需要了，用那么高反而会让 1380 默认窗口长期停在窄态。

   判据取「搜索框的可见文字宽」而不是「顶栏宽度」：压力不只来自窗口宽度，
   还来自谱名长度与家族页签标签长度 —— 同一个 1024 宽窗口，
   短谱名 + 短标签时余量 180px，标签一长就欠 44px。用宽度断点会在这两者间猜错。
   ========================================================= */
const NARROW_ENTER = 40;   // 文字态下能显示的文字窄于此 → 切图标态
const NARROW_LEAVE = 64;   // 宽于此 → 还原文字（间隙只挡测量抖动，见上）

/* 右内边距的参考值：按**文字态**的 32px 算（窄态只有 8px）。
   取文字态这个「更差」的一侧，于是这个量回答的是
   「如果保持文字态，能显示多少字」—— 窄态只会让它更宽，不会更窄。 */
const SEARCH_PAD_RIGHT_REF = 32;

/* 判据读数：**恒定按文字态算**，与当前是否窄态无关。
   已在文字态就直接量；已在窄态就临时摘掉属性量一眼再戴回去——
   摘戴在同一个任务里完成，浏览器只会在任务结束后画一帧，所以看不出闪烁。 */
function wideModeTextWidth() {
  const bar = document.querySelector('.topbar');
  const inp = document.querySelector('.search input');
  if (!bar || !inp) return Infinity;
  const read = () => {
    const cs = getComputedStyle(inp);
    return inp.clientWidth
      - (parseFloat(cs.paddingLeft) || 0)
      - SEARCH_PAD_RIGHT_REF - 2;
  };
  if (!bar.hasAttribute('data-narrow')) return read();
  bar.removeAttribute('data-narrow');
  const w = read();   // 读 clientWidth 会强制同步重排，这时量到的是摘掉后的布局
  bar.setAttribute('data-narrow', 'true');
  return w;
}

/* 测试出口：tests/topbar-layout.html 第 9 组断言的就是这一条性质 ——
   **判据读数与当前窄态无关**。阈值也一并暴露，好让测试不必把数字抄一遍
   （抄了就会连修复一起被抄对，在有 bug 的代码上也能通过 ——
   v0.2.78 实施时就这样白测过一次）。 */
window.__topbarNarrow = {
  get enter() { return NARROW_ENTER; },
  get leave() { return NARROW_LEAVE; },
  get padRightRef() { return SEARCH_PAD_RIGHT_REF; },
  measure: () => wideModeTextWidth(),
};

/* ⚠️ 这里读的是 `wideModeTextWidth()`，**不是**「当前可见文字宽」——
   前者与当前窄态无关，这是 v0.2.78 修自激振荡的关键，别改回去。
   顺带：本函数改属性后**不需要**再补判一次（旧版本有个 recheckNarrow，
   走双 rAF 等布局落定后再读一遍）。原因就是判据已经与状态无关 ——
   改完属性再读，读到的还是同一个数，补判只会凭空多出一次属性写入。
   去掉它还有个副作用值得知道：rAF 在无头 Chrome 下可能不触发，
   那条补判路径此前在自动化里是**测不到**的。 */
function syncTopbarNarrow() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  const w = wideModeTextWidth();
  const narrow = bar.hasAttribute('data-narrow');
  if (!narrow && w < NARROW_ENTER) {
    bar.setAttribute('data-narrow', 'true');
  } else if (narrow && w > NARROW_LEAVE) {
    bar.removeAttribute('data-narrow');
  }
}

function watchTopbarNarrow() {
  if (window.__topbarNarrowWatched) return;
  window.__topbarNarrowWatched = true;
  /* ⚠️ 用 window.resize，**不要**用 ResizeObserver（实测踩过）：
     顶栏宽度只随窗口变（它是 .app 的第一行、满宽），所以 resize 事件足够；
     而「内容变长但宽度没变」（谱名/页签变长）由 render() 末尾那次调用覆盖。
     换掉它的理由是可测性：无头 Chrome + --virtual-time-budget 下
     ResizeObserver 的回调**投递不可靠** —— 实测拉到 1380 时它压根没触发，
     属性停在窄态，而同一时刻 inner 已经 258px。 */
  let t = 0;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(syncTopbarNarrow, 60);
  });
}

/* ---------- 顶栏：「只显示姓名」开关 ---------- */
/* 状态**常驻可见**：文案写死「只显示姓名」，靠小圆点实心/空心表示开关，
   不靠颜色猜（关掉时它是灰的，开着是高亮 + 实心点）。 */
function renderCallToggle() {
  const b = $('callToggle');
  if (!b) return;
  const on = !state.showCall;               // 按钮上的意思是「我要只看姓名」
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
  b.title = on
    ? '正在「只显示姓名」：树和详情面板不显示称谓（再点一次恢复）'
    : '只显示姓名：隐藏称谓，只按姓名认人';

  /* 窄态降级用的 Aa 字形图标（v0.2.76）。宽态有文字就够了，这个图标只在
     顶栏窄态显示（见 app.css 的 .btn-toggle .btn-ico 规则），所以它必须
     一直待在 DOM 里、只是被 CSS 藏起来 —— 不能窄态时才插入，那会让
     「还原文字」和「再切图标」之间多一次重排。用 !firstChild 保证只填一次。 */
  const ico = b.querySelector('.btn-ico');
  if (ico && !ico.firstChild) ico.innerHTML = ICON.typeAa;
}

/* ---------- 顶栏：家族切换 chips ---------- */
function renderTabs() {
  const el = $('viewSwitch');
  if (!el) return;

  /* 还没有视角人时（空库 / 视角人被删）不要显示「的家族」——
     那是个明显的占位符漏出来了，看着像坏了。 */
  const vpName = state.index?.byId.get(state.viewpoint);
  const vpNameText = vpName ? displayName(vpName) : '';

  const items = [
    { key: 'main', label: vpNameText ? `${vpNameText}的家族` : '我的家族', count: state.mainTree?.people.length },
    ...state.expandable.map((ex) => ({
      key: ex.key, label: ex.label, count: ex.size, affinal: true, pending: !!ex.pending,
    })),
  ];

  el.innerHTML = items.map((it) => `
    <button class="view-tab${it.key === state.familyKey ? ' on' : ''}${it.affinal ? ' scope-affinal' : ''}${it.pending ? ' scope-pending' : ''}"
            data-family="${esc(it.key)}"
            title="${esc(it.label)}（${it.count} 人）">
      ${it.affinal ? ICON.users2 : ICON.users}
      <span class="tab-label">${esc(it.label)}</span>
      <span class="tab-count">${it.count}</span>
    </button>`).join('');
}

/* ---------- 左导航轨 ---------- */
function renderRail() {
  const el = $('rail');
  if (!el) return;
  const n = state.diagnosis?.issueCount ?? 0;

  const btn = (act, icon, tip, extra = '') =>
    `<button class="rail-btn${extra}" data-act="${act}" aria-label="${tip}">
       ${icon}<span class="rail-tip">${tip}</span>
     </button>`;

  el.innerHTML = `
    ${btn('view-tree', ICON.tree, '家谱树', state.view === 'tree' ? 'on' : '')}
    <button class="rail-btn${state.view === 'check' ? ' on' : ''}" data-act="view-check"
            aria-label="数据体检（${n} 项问题）">
      ${ICON.check}
      <span class="rail-dot${n ? '' : ' ok'}">${n ? n : '✓'}</span>
      <span class="rail-tip">数据体检</span>
    </button>
    <div class="rail-sep"></div>
    ${btn('import', ICON.upload, '导入 JSON 底稿（建成新谱）')}
    ${btn('export', ICON.download, '导出备份（可只导当前家族）')}
    ${btn('export-image', ICON.image, '把当前这一页导成图片（PNG）')}
    <div class="rail-spacer"></div>
    ${btn('about', ICON.source, '数据只存本地，不上传')}`;
}

/* ---------- 画布 ---------- */
function renderStage() {
  const wrap = $('viewTree');
  const view = state.layouts[state.familyKey];

  $('stageEmpty').style.display = view && view.tree.people.length ? 'none' : 'flex';
  if (!view) return;

  canvas.render({
    view,
    kinship: state.kinship,
    viewpoint: state.viewpoint,
    activeId: state.activeId,
    expandable: state.expandable,
    openKey: state.openKey,
    showCall: state.showCall,
  });

  // 视角提示条（当前不在主树时显示）
  const bar = $('scopeBar');
  if (state.familyKey !== 'main') {
    const ex = state.expandable.find((x) => x.key === state.familyKey);
    /* 待补录的家族（配偶没录父母）单独给一句指引 ——
       光显示「1 人」用户不知道该干什么，说清「补上父母就能展开」才行。 */
    const extra = ex?.pending
      ? ' · <b>TA 的父母还没录</b>，点开 TA 补上父母，这个家族就展开了'
      : ' · 点左上角切回本家族';
    bar.innerHTML = `${ICON.info} 当前查看 <b>${esc(ex?.label || '')}</b>（${view.tree.people.length} 人）${extra}`;
    bar.classList.add('on');
  } else {
    bar.classList.remove('on');
  }
}

/* ---------- 右面板 ---------- */
function renderPanelArea() {
  const el = $('panel');
  if (!el) return;

  // 折叠状态
  if (state.panelCollapsed) {
    el.classList.add('hide');
    $('panelHandle').classList.add('collapsed');
  } else {
    el.classList.remove('hide');
    $('panelHandle').classList.remove('collapsed');
  }

  const p = state.index.byId.get(state.activeId);
  const kin = state.kinship?.get(state.activeId);

  const expandable = state.expandable.find((x) => x.anchorId === state.activeId) || null;
  const isOpen = !!expandable && state.openKey === expandable.key;

  renderPanel(el, {
    person: p,
    kin,
    index: state.index,
    kinship: state.kinship,
    viewpoint: state.viewpoint,
    expandable,
    isOpen,
    showCall: state.showCall,
  });
}

/* ---------- 体检视图 ---------- */
function renderCheckArea() {
  const el = $('checkWrap');
  if (!el) return;

  const s = ruleStats();
  renderCheck(el, state.diagnosis, {
    nameOf,
    stats: {
      people: state.dataset.people.length,
      relationships: state.dataset.relationships.length,
      rules: s.total,
      rulePaths: s.uniquePaths,
      families: state.expandable.length + 1,
      storage: storageMode(),
    },
  });
}

/* ========================================================= */
/* 交互：视图切换                                              */
/* ========================================================= */

function setView(v) {
  state.view = v;
  $('viewTree').classList.toggle('on', v === 'tree');
  $('viewCheck').classList.toggle('on', v === 'check');
  $('panel').style.display = v === 'tree' ? '' : 'none';
  $('panelHandle').style.display = v === 'tree' ? '' : 'none';
  renderRail();
  if (v === 'tree') setTimeout(() => canvas.fit(), 40);
}

function setFamily(key) {
  state.familyKey = key;
  state.openKey = key === 'main' ? null : key;

  // 切到某个家族时，选中该家族的主角
  const ex = state.expandable.find((x) => x.key === key);
  if (ex) state.activeId = ex.anchorId;

  renderTabs();
  renderStage();
  renderPanelArea();

  /* 切家族必须**居中到那个家族的主角**。
     ⚠️ 以前这里什么都不做，只改 state 就重绘 —— 两棵树的坐标范围根本不重叠
        （主树 x[−1858~3098]、李允家族 x[−2034~−158]），沿用上一个视口
        必然是满屏空白。focusOn 保持当前倍率，只把主角摆到画面中间。 */
  if (ex) canvas.focusOn(ex.anchorId, false);
}

function toggleFamily(anchorId, key) {
  const ex = state.expandable.find((x) => x.anchorId === anchorId);
  if (!ex) return;
  if (state.familyKey === ex.key) setFamily('main');
  else setFamily(ex.key);
}

function selectPerson(id) {
  state.activeId = id;
  state.panelCollapsed = false;
  canvas.setActive(id);
  renderPanelArea();
  warmPhotos();   // 新选中的人可能有没预热过的照片
}

/* ========================================================= */
/* 交互：增删改                                                */
/* ========================================================= */

function addPerson() {
  openPersonDialog({
    person: null,
    dataset: state.dataset,
    index: state.index,
    // 弹窗里的父母下拉要显示「我该怎么称呼 TA」，靠这两个取称谓
    viewpoint: state.viewpoint,
    kinship: state.kinship,
    onSave: (payload) => upsertPerson(payload, null),
  });
}

/**
 * 「添加亲属」—— 先问是哪门子亲，再带着预设打开表单。
 * 这一小步很关键：用户从「我爸爸」的面板点进来，心里想的是
 * 「给爸爸加个弟弟」，不是「添加一个抽象的人」。
 *
 * @param {string} anchorId 参照人
 * @param {string} [relOnly] 只保留这一种关系（如 'spouse'），用于详情面板的「补充配偶」直入
 */
function addRelative(anchorId, relOnly) {
  const anchor = state.index.byId.get(anchorId);
  if (!anchor) return;

  const all = [
    { rel: 'father', label: '父亲', sex: 'M', desc: 'TA 的爸爸' },
    { rel: 'mother', label: '母亲', sex: 'F', desc: 'TA 的妈妈' },
    { rel: 'spouse', label: '配偶', sex: '',  desc: 'TA 的丈夫 / 妻子' },
    { rel: 'child',  label: '子女', sex: '',  desc: 'TA 的儿子 / 女儿' },
  ];
  const options = relOnly ? all.filter((o) => o.rel === relOnly) : all;
  if (!options.length) return;

  /**
 * 推算「TA 的孩子」的父母是谁 —— 从「添加亲属 → 子女」进来时用。
 *
 * 一夫一妻制（用户 2026-10-11 明确：离婚带儿子这些先不考虑）：
 *   参照人是男的 → 他是父亲，孩子是他的孩子；母亲取他的妻子
 *   参照人是女的 → 她是母亲，孩子是她的孩子；父亲取她的丈夫
 *   没有配偶     → 只锁参照人那侧，另一侧留空让用户自己补
 *
 * ⚠️ 拿不到性别的（待补信息）→ 按「参照人是父亲」处理，宁可父系也不能两边都不填。
 *
 * @returns {{father: string, mother: string}} 空串 = 这一侧还不确定
 */
function guessParentsOfChild(anchor) {
  const sp = (state.index.spouseOf.get(anchor.id) || [])
    .map((id) => state.index.byId.get(id))
    .filter(Boolean);
  const husband = sp.find((p) => p.sex === 'M');
  const wife = sp.find((p) => p.sex === 'F');

  if (anchor.sex === 'F') {
    return { father: husband?.id || '', mother: anchor.id };
  }
  return { father: anchor.id, mother: wife?.id || '' };
}

/** 打开录入弹窗（带反向关系预设） */
  const openForm = (opt) => {
    openPersonDialog({
      person: null,
      dataset: state.dataset,
      index: state.index,
      presetSex: opt.sex,
      /* ⚠️ 父母**在点开这个弹窗之前就已经确定**了，别再让用户选一遍。
         从「王运先」的详情面板点「添加子女」→ 王运先是父亲，
         那这个孩子必然是他的儿子 —— 用户还要在下拉里再选一次王运先？
         用户原话：「每次都要手动选也太麻烦了」。
         一夫一妻制（2026-10-11 用户明确：离婚带儿子这些先不考虑），
         所以另一侧直接取 TA 的配偶；没有配偶就只锁一侧，另一侧仍可留空。 */
      presetParents: opt.rel === 'child' ? guessParentsOfChild(anchor) : null,
      subtitle: `这位是「${displayName(anchor)}」的${opt.label}`,
      viewpoint: state.viewpoint,
      kinship: state.kinship,
      onSave: (payload) => upsertPerson(payload, { anchorId, rel: opt.rel }),
    });
  };

  // 只有一种关系时（「补充配偶」）不再多问一句，直接开表单
  if (options.length === 1) {
    openForm(options[0]);
    return;
  }

  clearTimeout(overlay._clearTimer);
  overlay._clearTimer = null;
  overlay.onclick = null;
  overlay.innerHTML = `
    <div class="modal modal-sm" role="dialog" aria-modal="true" aria-label="选择亲属关系">
      <div class="modal-head">
        <div>
          <div class="modal-title">添加谁的亲属？</div>
          <div class="modal-sub">以「${esc(displayName(anchor))}」为参照</div>
        </div>
        <button class="btn btn-ghost btn-icon" data-pick="close" aria-label="关闭">${ICON.x}</button>
      </div>
      <div class="modal-body" style="padding-top:12px">
        <div class="rel-picker">
          ${options.map((o) => `
            <button class="rel-pick" data-pick="${o.rel}">
              <b>${o.label}</b>
              <em>${o.desc}</em>
            </button>`).join('')}
        </div>
      </div>
    </div>`;
  overlay.classList.add('on');

  const close = () => {
    overlay.classList.remove('on');
    // 存句柄：下面 200ms 后要打开录入弹窗，必须先取消这次清空（否则新弹窗会被擦掉）
    overlay._clearTimer = setTimeout(() => {
      overlay.innerHTML = '';
      overlay._clearTimer = null;
    }, 220);
  };

  overlay.onclick = (e) => {
    if (e.target === overlay || e.target.closest('[data-pick="close"]')) return close();
    const btn = e.target.closest('[data-pick]');
    if (!btn) return;

    const opt = options.find((o) => o.rel === btn.dataset.pick);
    if (!opt) return close();
    close();

    setTimeout(() => openForm(opt), 200);
  };
}

/**
 * 写回一个人及其关系。
 * @param {object} payload 表单产物
 * @param {object|null} preset { anchorId, rel } —— 从「添加亲属」进来的反向关系
 */
function upsertPerson(payload, preset) {
  const { father, mother, spouses, ...person } = payload;

  // ⚠️ 配偶已从录入/编辑表单里移除，改由「添加亲属」流程维护。
  //    所以只有当 payload 明确带上了 spouses 数组（本表单已不再带），
  //    才重建配偶边；否则**原样保留**既有配偶关系，绝不能因为改个生日就把配偶删掉。
  const managesSpouses = Array.isArray(spouses);

  const people = state.dataset.people.slice();
  const i = people.findIndex((p) => p.id === person.id);
  if (i >= 0) people[i] = { ...people[i], ...person };
  else people.push(person);

  // 重建这个人的关系边（父母 / 配偶）
  let rels = state.dataset.relationships.filter((r) => {
    if (r.type === 'parent' && r.b === person.id) return false;
    if (managesSpouses && r.type === 'spouse' && (r.a === person.id || r.b === person.id)) return false;
    return true;
  });

  const push = (a, b, type) => {
    if (!a || !b || a === b) return;
    if (!people.some((p) => p.id === a) || !people.some((p) => p.id === b)) return;
    /* ⚠️ 同一对关系别写两遍：从「添加亲属」进来时，表单里已经带了父母
       （hidden input），下面 preset 分支还会再推一次同样的边。
       normalizeDataset 末尾会去重，但这里先挡住 —— 别让中间态出现重复。 */
    const dup = rels.some((r) => r.type === type
      && (type === 'spouse'
        ? (r.a === a && r.b === b) || (r.a === b && r.b === a)
        : r.a === a && r.b === b));
    if (dup) return;
    rels.push({ a, b, type, confidence: 'high' });
  };

  if (father) push(father, person.id, 'parent');
  if (mother) push(mother, person.id, 'parent');
  if (managesSpouses) for (const s of spouses) push(person.id, s, 'spouse');

  // 反向关系（从「添加亲属」进来）
  if (preset) {
    const { anchorId, rel } = preset;
    if (rel === 'father' || rel === 'mother') {
      push(person.id, anchorId, 'parent');       // 新人是 anchor 的父母
    } else if (rel === 'child') {
      push(anchorId, person.id, 'parent');       // anchor 是新人的父母
      // 子女的出生年通常晚于参照人，这里不额外处理，交给 F8.5 体检
    } else if (rel === 'spouse') {
      push(anchorId, person.id, 'spouse');
    }
  }

  state.dataset = normalizeDataset({ ...state.dataset, people, relationships: rels });
  state.activeId = person.id;
  commit(i >= 0 ? '已保存修改' : '已添加成员');
}

/**
 * 删除一个人（连同 TA 的全部关系边；子女保留，但会失去这一侧的父母）。
 *
 * ⚠️ 二次确认由调用方（ui/dialog.js）用自绘确认框完成，**这里绝对不能
 *    再用原生 confirm()** —— 原生模态框关闭后整个应用的真实键盘输入就废了，
 *    用户报的现象正是「删除后输入框无法输入、内容也无法删除」。
 *    原因见 ui/dialog.js 里 confirmOverlay 的注释。
 *
 * ⚠️ 返回值是有意义的，务必返回布尔值（2026-10-09 修复）：
 *   弹窗按这个返回值决定「要不要关窗」。以前这里全是裸 `return`，
 *   弹窗那边也无条件 close() —— 于是「删的是视角人物本人」「人已经不在索引里」
 *   这两种**根本没删成**的情况，弹窗也照样关掉，用户正在填的内容全部丢失。
 *
 * @param {string} id
 * @returns {boolean} true = 真的删掉了；false = 没删（被拒绝 / 出错）
 */
function deletePerson(id) {
  const p = state.index.byId.get(id);
  if (!p) return false;
  if (id === state.viewpoint) {
    toast('不能删除视角人物（本人）—— 可以先切换视角', 'warn');
    return false;
  }

  const kids = state.index.kidsOf.get(id) || [];
  const people = state.dataset.people.filter((x) => x.id !== id);
  const rels = state.dataset.relationships.filter((r) => r.a !== id && r.b !== id);

  state.dataset = normalizeDataset({ ...state.dataset, people, relationships: rels });
  state.activeId = state.viewpoint;
  commit(`已删除「${displayName(p)}」${kids.length ? `（TA 的 ${kids.length} 位子女仍在，但会失去这一侧的父母）` : ''}`);
  return true;
}

/* ========================================================= */
/* 照片（F12）                                                  */
/* ---------------------------------------------------------
 * 三层分工：core/photos.js 管缓存与 IPC；本文件管交互与数据流；
 * electron/photoStore.js（主进程）管磁盘。行为契约见
 * openspec/specs/photo-management。
 * ========================================================= */

let warming = false;

/**
 * 预热照片（全谱头像 + 面板照片），有新解析出来的就重绘一次。
 *
 * 渲染是同步的、取图是异步的 —— 这之间界面先显示占位（首字 / 空槽），
 * 图到了再重绘。幂等 + 重入保护：缓存里都有时一次 IPC 都不发。
 */
async function warmPhotos() {
  if (!photoBridge() || warming || !state.dataset) return;
  warming = true;
  try {
    for (let round = 0; round < 3; round++) {
      const fresh = await ensureForDataset(state.dataset);
      if (!fresh) break;   // 没有新解析出来的 → 不用重绘
      render();
    }
  } finally {
    warming = false;
  }
}

/** 添加照片：面板「＋」→ 系统对话框 → 主进程收文件 → 追加 photos 数组 */
async function addPhoto(personId) {
  const b = photoBridge();
  if (!b) return;   // 无桥时面板根本不渲染这个按钮，双保险
  const res = await b.add(personId);
  if (!res?.ok) {
    if (!res?.canceled) toast(res?.error || '添加照片失败', 'warn', 6000);
    return;
  }
  if (res.added?.length) {
    const people = state.dataset.people.map((x) => (
      x.id === personId ? { ...x, photos: [...(x.photos || []), ...res.added] } : x
    ));
    state.dataset = normalizeDataset({ ...state.dataset, people });
    forget(res.added);   // 摘掉可能存在的负缓存，让新文件能被看见
    commit(null);
    toast(`已添加 ${res.added.length} 张照片`, 'ok');
  }
  if (res.rejected?.length) {
    const detail = res.rejected
      .map((r) => `${String(r.file).split(/[\\/]/).pop()}（${r.reason}）`)
      .join('；');
    toast(`有 ${res.rejected.length} 个文件没能添加：${detail}`, 'warn', 7000);
  }
  warmPhotos();
}

/** 把一张照片设为该成员的主头像（谱树与面板即时生效） */
async function setPhotoAvatar(personId, name) {
  const p = state.index.byId.get(personId);
  if (!p || !name) return;
  if (p.avatar === name) {
    toast('这张已经是主头像了', 'ok', 1800);
    return;
  }
  const people = state.dataset.people.map((x) => (
    x.id === personId ? { ...x, avatar: name } : x
  ));
  state.dataset = normalizeDataset({ ...state.dataset, people });
  forget([name]);
  await commit(null);
  warmPhotos();
  toast('已设为主头像', 'ok');
}

/**
 * 删一张照片：确认 → 主进程删文件 → 摘引用（被删的正是主头像则一并清空）。
 * ⚠️ 文件删不掉时（EPERM，多半被资源管理器 / 预览占着）**保留数据库引用**，
 *    让用户关掉占用后重试 —— 不制造「库说删了、文件还在」的漂移。
 */
async function deletePhoto(personId, name) {
  const p = state.index.byId.get(personId);
  if (!p || !name) return;
  const ok = await confirmOverlay({
    title: '删除照片',
    message: '删除后不可恢复 —— 文件会从这台电脑的照片目录里移除。\n\n'
      + `确定要删除「${displayName(p)}」的这张照片吗？`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  const b = photoBridge();
  if (!b) return;
  const res = await b.remove([name]);
  if (!res?.ok) {
    toast(res?.error || '删除失败', 'warn', 6000);
    return;
  }
  if (res.errors?.length) {
    toast(`没能删除：${res.errors[0].error}。请先关掉正在查看这个文件的窗口，再试一次`, 'warn', 7000);
    return;
  }
  const people = state.dataset.people.map((x) => (
    x.id === personId
      ? {
          ...x,
          photos: (x.photos || []).filter((n) => n !== name),
          avatar: x.avatar === name ? '' : x.avatar,
        }
      : x
  ));
  state.dataset = normalizeDataset({ ...state.dataset, people });
  forget([name]);
  await commit(null);
  warmPhotos();
  toast('照片已删除', 'ok');
}

/**
 * 照片灯箱：缩略图 / 「+N」都开到这。网格全览 → 点开单张大图（原图 dataURL）。
 * 单张视图：←→ 翻页、Esc 关闭、「设为主头像」「删除」。
 *
 * ⚠️ close() 必须**立即**清空 innerHTML（不能像别的弹窗等 220ms 过渡）：
 *    「删除」要走 confirmOverlay，它靠「overlay 里还有没有别人」决定何时摘
 *    遮罩类 .on（见 dialog.js confirmOverlay 的注释）。留着旧内容会让它
 *    误判「还有人」，灯箱关了遮罩却还在，界面就点不动了。
 */
async function openPhotoLightbox(personId, startName = '') {
  const p = state.index.byId.get(personId);
  const b = photoBridge();
  if (!p || !b) return;
  const photos = (p.photos || []).filter(Boolean);
  if (!photos.length) return;

  /* 和每个弹窗一样：先取消上一个弹窗排的 220ms 清空定时器，
     否则它会在我们渲染之后把灯箱内容抹掉（表现为「闪一下就没有」）。 */
  clearTimeout(overlay._clearTimer);
  overlay._clearTimer = null;
  overlay.onclick = null;

  let idx = startName ? photos.indexOf(startName) : -1;   // -1 = 网格态
  await ensure(photos);   // 网格要先有缩略图

  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.onclick = null;
    overlay.classList.remove('on');
    clearTimeout(overlay._clearTimer);
    overlay._clearTimer = null;
    overlay.innerHTML = '';
  };

  function onKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (idx >= 0 && e.key === 'ArrowLeft') {
      e.preventDefault(); e.stopPropagation(); show(Math.max(0, idx - 1));
    } else if (idx >= 0 && e.key === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation(); show(Math.min(photos.length - 1, idx + 1));
    }
  }
  document.addEventListener('keydown', onKey);

  const headHtml = (sub) => `
    <div class="modal-head">
      <div>
        <div class="modal-title">${esc(displayName(p))} 的照片</div>
        <div class="modal-sub">${sub}</div>
      </div>
      <button type="button" class="btn btn-ghost btn-icon" data-ph="close" aria-label="关闭">${ICON.x}</button>
    </div>`;

  const bind = () => {
    overlay.querySelectorAll('[data-ph]').forEach((el) => {
      el.addEventListener('click', () => {
        const act = el.dataset.ph;
        if (act === 'close') return close();
        if (act === 'open') return show(Number(el.dataset.i));
        if (act === 'prev') return show(Math.max(0, idx - 1));
        if (act === 'next') return show(Math.min(photos.length - 1, idx + 1));
        if (act === 'avatar') return setPhotoAvatar(p.id, photos[idx]);
        if (act === 'delete') {
          const name = photos[idx];
          close();
          return deletePhoto(p.id, name);
        }
      });
    });
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
  };

  const showGrid = () => {
    idx = -1;
    overlay.innerHTML = `
      <div class="modal modal-photo" role="dialog" aria-modal="true" aria-label="照片">
        ${headHtml(`共 ${photos.length} 张 · 点开看大图`)}
        <div class="modal-body photo-grid">
          ${photos.map((n, i) => {
            const src = cached(n);
            return src
              ? `<button type="button" class="photo-cell" data-ph="open" data-i="${i}" title="第 ${i + 1} 张"><img src="${esc(src)}" alt=""></button>`
              : `<div class="photo-cell photo-cell-missing" title="文件缺失">缺失</div>`;
          }).join('')}
        </div>
      </div>`;
    bind();
    overlay.classList.add('on');   // ⚠️ 没这一行遮罩不显示，灯箱等于没打开
  };

  const show = async (i) => {
    idx = i;
    const name = photos[i];
    overlay.innerHTML = `
      <div class="modal modal-photo" role="dialog" aria-modal="true" aria-label="照片">
        ${headHtml(`第 ${i + 1} / ${photos.length} 张`)}
        <div class="modal-body photo-stage" data-ph="stage"><span class="muted">正在读取…</span></div>
        <div class="modal-foot">
          <button type="button" class="btn btn-ghost" data-ph="prev" ${i === 0 ? 'disabled' : ''}>${ICON.chevronLeft} 上一张</button>
          <span class="photo-foot-spacer"></span>
          <button type="button" class="btn" data-ph="avatar">${ICON.avatar} 设为主头像</button>
          <button type="button" class="btn btn-danger" data-ph="delete">${ICON.trash} 删除</button>
          <span class="photo-foot-spacer"></span>
          <button type="button" class="btn btn-ghost" data-ph="next" ${i === photos.length - 1 ? 'disabled' : ''}>下一张 ${ICON.chevronRight}</button>
        </div>
      </div>`;
    bind();
    overlay.classList.add('on');   // 单张视图同样要摘掉遮罩的隐藏（见 showGrid 的警告）
    const r = await b.original(name);
    // 异步回来时用户可能已切走 / 关掉：只有还停在这一张才填图
    const stage = overlay.querySelector('[data-ph="stage"]');
    if (stage && idx === i) {
      stage.innerHTML = r?.ok
        ? `<img class="photo-full" src="${esc(r.dataUrl)}" alt="">`
        : `<span class="muted">照片文件不存在（${esc(r?.error || '缺失')}）</span>`;
    }
  };

  if (idx >= 0) show(idx);
  else showGrid();
}

/* ========================================================= */
/* 导入 / 导出                                                 */
/* ========================================================= */

async function doImport() {
  // 桌面版：走系统「打开文件」对话框（比网页的文件选择器自然得多）
  if (storageMode() === 'sqlite') {
    const res = await importFromDisk();
    if (!res.ok) {
      if (!res.canceled) toast(res.error, 'warn', 6000);
      return;
    }
    return offerImport(res.dataset, res.name, res.photos);
  }

  // 网页版：退回 <input type=file>
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const res = await importFile(file);
    if (!res.ok) return toast(res.error, 'warn', 6000);
    offerImport(res.dataset, file.name, res.photos);
  };
  input.click();
}

/**
 * 导入数据的去向：**默认建成一本新谱**。
 *
 * ⚠️ 为什么改了默认值（v0.2.24）：
 *   以前导入是「覆盖当前库」，那条路在只有一本谱的时候还算合理，
 *   但一旦用户手里有了自己填的谱、又有系统自带的样例，他就陷入
 *   「想把亲戚的底稿也看看 → 只能先把自己的盖掉」的死结 —— 这个功能的
 *   原始诉求正是「想再建一套」。所以主路径改成新建，
 *   「覆盖当前谱」降为第三个按钮（保留，因为「恢复备份」场景确实需要）。
 */
async function offerImport(dataset, name, photos = null) {
  const base = String(name || '').replace(/\.json$/i, '').trim();
  const photoCount = photos ? Object.keys(photos).length : 0;

  const choice = await confirmOverlay({
    title: '导入这份数据',
    message: `「${name}」\n\n`
      + `· 成员 ${dataset.people.length} 人\n`
      + `· 关系 ${dataset.relationships.length} 条\n`
      + (photoCount ? `· 内联照片 ${photoCount} 张\n` : '')
      + '\n'
      + '默认把它建成一本新谱（当前这本不受影响），适合收集来的底稿；\n'
      + '要把这份数据覆盖到当前谱上（如恢复备份），点左下角那个按钮。',
    confirmText: '建成新谱',
    altText: '覆盖当前谱',
    cancelText: '取消',
  });
  if (!choice) return;

  if (choice === 'alt') return applyImport(dataset, name, photos);

  const r = await createBook({ name: base || undefined, seedDataset: dataset });
  if (!r.ok) { toast(r.error || '新建失败', 'warn', 6000); return; }

  /* 照片落盘必须赶在 applyBookSwap（渲染 + warmPhotos）**之前**：
     反过来先渲染，warmPhotos 会把「文件还不在」记成负缓存，
     照片恢复了也被挡着不显示（除非再 invalidate 一次）。 */
  const restored = await restoreImportedPhotos(photos, r.dataset || dataset);
  applyBookSwap(r.dataset, r.book, r.library?.books);
  toast(`已用「${name}」新建「${r.book?.name || ''}」${restored}`, 'ok', 4200);
}

/**
 * 覆盖式导入（原来的行为）。留着是为了「恢复备份」这条路径 ——
 * 那时用户要的就是盖回去，而不是再多一本同名的谱。
 */
async function applyImport(dataset, name, photos = null) {
  // 自绘确认框，**不能用原生 confirm**（见 deletePerson 的注释）
  const ok = await confirmOverlay({
    title: '导入会覆盖当前谱',
    message: `即将把「${name}」导入到当前谱「${state.book?.name || ''}」\n\n`
      + `· 成员 ${dataset.people.length} 人\n`
      + `· 关系 ${dataset.relationships.length} 条\n`
      + (photos && Object.keys(photos).length ? `· 内联照片 ${Object.keys(photos).length} 张\n` : '')
      + '\n'
      + '当前谱的现有数据会被完全替换，此操作不可撤销。\n'
      + '（只是想看看这份底稿的话，建议选「建成新谱」）',
    confirmText: '覆盖导入',
    danger: true,
  });
  if (!ok) return;

  /* 先落盘照片，再切数据（理由同 offerImport 的新谱分支） */
  const restored = await restoreImportedPhotos(photos, dataset);

  state.dataset = dataset;
  state.viewpoint = state.dataset.viewpoint || state.dataset.people[0]?.id || '';
  state.activeId = state.viewpoint;
  state.familyKey = 'main';
  state.openKey = null;
  commit('导入成功' + restored);
  setTimeout(() => canvas.fit(), 60);
}

/**
 * 把导入文件里内联的照片落盘到**当前谱**（调用方保证目的地谱已就位），
 * 回报一句拼进 toast 的话。没有内联照片 / 没有桥 → 空串（什么都不说）。
 *
 * 缺失数怎么算：内联带来的（written + skipped）一定在磁盘上；
 * 其余被引用的名字现查一遍存在性 —— 「只存文件名」的旧导出再导入时，
 * 这句话就是用户知道「照片没跟来」的唯一地方（spec：导入结果报缺失数）。
 *
 * @param {Object<string,string>|null} photos {文件名: dataUrl}
 * @param {object} dataset 导入后的数据集（用来收集引用）
 * @returns {Promise<string>} 形如「 · 已恢复 3 张照片，另有 2 个照片文件缺失」
 */
async function restoreImportedPhotos(photos, dataset) {
  if (!photos) return '';
  const names = Object.keys(photos);
  if (!names.length) return '';
  const b = photoBridge();
  if (!b) return ' · 照片未恢复（当前环境写不了本地文件）';

  const r = await b.restore(photos);
  if (!r?.ok) return ' · 照片恢复失败：' + (r?.error || '未知错误');

  const brought = new Set([...(r.written || []), ...(r.skipped || [])]);
  const others = collectPhotoRefs(dataset).filter((n) => !brought.has(n));
  let missing = r.errors?.length || 0;
  if (others.length) {
    const ex = await b.exists(others);
    if (ex?.ok) missing += others.length - (ex.existing?.length || 0);
  }

  let note = ` · 已恢复 ${r.written?.length || 0} 张照片`;
  if (missing > 0) note += `，另有 ${missing} 个照片文件缺失（旧文件没跟着来）`;
  return note;
}

async function doExport() {
  const tree = state.layouts[state.familyKey]?.tree;

  const pick = await exportScopeDialog({
    totalCount: state.dataset.people.length,
    relCount: state.dataset.relationships.length,
    treeLabel: tree?.label || '',
    treeCount: tree?.memberIds.size ?? 0,
    treeRelCount: tree ? countTreeRelations(tree) : 0,
    /* 把「没导出去的是谁」摆出来。这是隐私取舍，不能只说「不含其他家族」——
       用户需要具体知道岳家、外家哪些人没进文件，才敢把文件发出去。
       注意要列**所有**没被选中的页签（主树也在内）—— 停在「母亲家族」
       页上导出时，主树里自己父系那一支同样没进文件，只列姻亲页是漏报的。 */
    omitted: Object.keys(state.layouts)
      .filter((k) => k !== state.familyKey)
      .map((k) => state.layouts[k].tree.label),
    /* 谱里有照片引用才问「要不要带照片」—— 一张都没有时别让用户白选 */
    hasPhotos: collectPhotoRefs(state.dataset).length > 0,
  });
  if (!pick) return;

  /* ⚠️ ⚠️ state.dataset 是内存里的真身，下一次 commit 会把它整个写回库。
     裁剪只能是它的**副本**，绝不能就地改 —— 否则「只导一份」
     就变成了「把库也裁了」，那才是不可逆的数据损失。 */
  const dataset = pick.scope === 'tree' ? scopeToTree(state.dataset, tree) : state.dataset;

  /* 「包含照片」：从**这份副本**收集引用 → 主进程批量读 dataUrl → 内联进 JSON。
     引用收集按副本走，所以「只导当前家族 + 包含照片」只会带上这一页的人的照片。 */
  let photoMap = null;
  if (pick.photos) {
    const names = collectPhotoRefs(dataset);
    const b = photoBridge();
    if (!b) {
      toast('当前环境读不到照片文件，将只导出文件名', 'warn', 5000);
    } else if (names.length) {
      const r = await b.readMany(names);
      if (r?.ok) {
        photoMap = r.map;
        if (r.missing?.length) {
          toast(`有 ${r.missing.length} 张照片文件缺失，没有包含进导出文件`, 'warn', 5000);
        }
      } else {
        toast(r?.error || '读取照片失败，将只导出文件名', 'warn', 5000);
      }
    }
  }

  const res = await exportFile(
    dataset,
    pick.scope === 'tree' ? scopeFilename(tree?.label) : undefined,
    photoMap
  );
  if (!res.ok) {
    if (!res.canceled) toast(res.error || '导出失败', 'warn', 6000);
    return;
  }
  const photoNote = photoMap ? ` · 含 ${Object.keys(photoMap).length} 张照片` : '';
  toast(pick.scope === 'tree'
    ? `已导出「${res.name}」（${dataset.people.length} 人，不含其他家族${photoNote}）`
    : `已导出「${res.name}」${photoNote}`, 'ok', pick.scope === 'tree' ? 4000 : 2600);
}

/** 本树内部的关系条数（用于导出弹窗里的数字，跟裁剪结果口径一致） */
function countTreeRelations(tree) {
  const ids = tree?.memberIds;
  if (!(ids instanceof Set)) return 0;
  return state.dataset.relationships.filter((r) => ids.has(r.a) && ids.has(r.b)).length;
}

/**
 * 只导当前家族时的文件名 —— 带上家族名，免得同一天导好几份分不清哪份是哪份。
 * 洗字符的规则复用 core/export-image.js 的 safeFileToken：图片导出和
 * JSON 导出必须是同一套，否则同一天导出的两个文件一个叫 A 一个叫 B。
 */
function scopeFilename(label) {
  const safe = safeFileToken(label);
  return `家族谱-${safe || '当前家族'}-${dateStamp()}.json`;
}

/**
 * 导出当前这一页为 PNG（v0.2.63）。
 *
 * 【为什么和 doExport 分成两件事】
 *   JSON 底稿是**备份** —— 本软件唯一的备份途径，出问题就什么都没了，
 *   所以每次都问一句范围（理由见 dialog.js 的 exportScopeDialog）。
 *   图片是**给人看的**：上面有每个人的姓名、生卒年月和婚配关系
 *   （**不显示称呼** —— 称呼是站在某个视角下才成立的说法，印在分享图上
 *   容易让人以为图出错，见 tree.js mountExportSnapshot）。
 *   备份不该有随机性，图片只需要「当前这一页」。混在一处会让「备份」
 *   这个动作也变得可疑，用户从此不敢信那个 Ctrl+S。
 */
async function doExportImage() {
  const view = state.layouts[state.familyKey];

  /* 体检视图下画布那一栏根本没画（#viewTree 不在），没什么可拍的。
     这里必须挡住 —— 否则 html2canvas 会拍到一个 0×0 或者空容器，
     然后弹一个「另存为」，用户存下来的却是一张白纸。 */
  if (!$('viewTree').classList.contains('on')) {
    toast('先切回「家谱树」再导出图片', 'warn');
    return;
  }
  if (!view?.tree?.people.length) {
    toast('这一页还没有人，没什么可导出的', 'warn');
    return;
  }
  if (typeof html2canvas !== 'function') {
    toast('导出图片的组件没加载上，重启软件再试一次', 'warn', 6000);
    return;
  }

  /* 两档都先算出来：弹窗里要当场显示各自出多少像素，
     还要提前知道 2 倍会不会被自动降档（降档了得告诉用户）。 */
  const plans = {
    1: imagePlan({ bounds: view.bounds, scale: 1 }),
    2: imagePlan({ bounds: view.bounds, scale: 2 }),
  };
  if (!plans[1].ok) {
    toast(plans[1].error || '这一页还不能导出图片', 'warn');
    return;
  }

  const scale = await exportImageDialog({
    treeLabel: view.tree.label,
    treeCount: view.tree.people.length,
    plans,
  });
  if (!scale) return;

  const plan = plans[scale] || plans[1];

  /* 拍照要几百毫秒到几秒，这期间必须挡住交互：用户随手点掉一个人，
     拍出来的就是旧数据 —— 而文件已经发出去了，这种错事后根本发现不了。 */
  const busy = showExportBusy();
  let snapshot = null;
  try {
    /* 家族页：按**该页锚点**（母亲 / 妻子）当视角重算一遍配色。
       屏幕上的配色永远是按「我」算的 —— 那是**浏览**需要的（谁离我近、谁是我姻亲）；
       但分享出去的图是给所有亲戚一起看的，不该替谁划分立场：
       停在母亲家族页就整片玫红，娘家人看着亲切，旁人却会觉得「这图是站哪边的」。
       换成从该页锚点看，同一支的人自然同色、嫁进来的配偶保留橙色。
       主树不动 —— 它本来就是从「我」看的。
       ⚠️ 这套换色**只发生在导出副本里**，屏幕上分毫不变。 */
    const pageEx = state.expandable.find((e) => e.key === state.familyKey);
    const palette = (state.familyKey !== 'main' && pageEx)
      ? deriveAllKinships(state.dataset, pageEx.anchorId)
      : null;

    snapshot = await canvas.mountExportSnapshot(plan, palette);

    /* ⚠️ 一律按 **2x 渲染**，1x 的那一档再缩小下来。
       为什么不用 plan.scale 直接渲：头像外那圈投影（`--shadow-sm`）在
       scale=1 时相对更重 —— 实测同一页 1x 平均亮度 249.3、2x 是 250.9，
       用户反馈「标准清晰度暗很多」，而去掉投影后的 1x 是 250.8，与 2x 齐平，
       **说明差的就是这圈投影**。同一尺寸的投影在 2x 画布上被「摊薄」了。
       统一 2x 渲染的好处是两档观感一致（250.8 ≈ 250.9），而且 1x 反而更清晰。
       代价：1x 也要 2x 的内存（主树约 68 MB RGBA，可接受）。 */
    const RENDER_SCALE = Math.max(plan.scale, 2);
    let cv = await html2canvas(snapshot.el, {
      scale: RENDER_SCALE,
      backgroundColor: '#ffffff',
      width: plan.cssWidth,
      height: plan.cssHeight,
      logging: false,
      /* ⚠️ 这里是给将来 F12（头像 / 照片）留的坑位，**别删**：
         <img> 直接指 file:// 的本地照片会把画布标记为「污染」，
         toDataURL 会抛 SecurityError，导出直接失败。
         照片接入时必须走自定义协议或 base64 内联，
         **不许**用 webSecurity:false 去绕开它。 */
      useCORS: true,
    });
    if (plan.scale !== RENDER_SCALE) {
      const small = document.createElement('canvas');
      small.width = Math.floor(plan.cssWidth * plan.scale);
      small.height = Math.floor(plan.cssHeight * plan.scale);
      small.getContext('2d').drawImage(cv, 0, 0, small.width, small.height);
      cv = small;
    }
    const dataUrl = cv.toDataURL('image/png');

    /* 拍完就撤容器和遮罩，别等另存为。
       接下来弹的是系统对话框（另一个模态窗口），这期间主窗口还压着
       「正在生成图片…」的话，用户在那边挑半天文件名，回头一看这边
       界面像卡死了。finally 里还会再兜一次，重复 remove 无害。 */
    snapshot.dispose();
    snapshot = null;
    busy.remove();

    const res = await exportImageFile(dataUrl, imageFilename(view.tree.label));
    if (!res.ok) {
      if (!res.canceled) toast(res.error || '导出失败', 'warn', 6000);
      return;
    }
    toast(`已导出「${res.name}」（${plan.pixelWidth} × ${plan.pixelHeight}）`, 'ok', 4000);
  } catch (e) {
    toast('导出图片失败：' + (e?.message || e), 'warn', 6000);
  } finally {
    snapshot?.dispose();
    busy.remove();
  }
}

/** 导出期间的遮罩。返回节点，由调用方 remove()（一定要在 finally 里）。 */
function showExportBusy() {
  const el = document.createElement('div');
  el.className = 'export-busy';
  el.textContent = '正在生成图片…人多的谱树要等几秒';
  document.body.appendChild(el);
  return el;
}

/**
 * 清空全部数据。
 * 二次确认放在这里（而不是主进程菜单）—— 只有渲染层知道现在有多少人、
 * 也才能提示「先导出备份」。菜单那边只发一个动作名。
 */
async function doClear() {
  const n = state.dataset.people.length;
  const r = state.dataset.relationships.length;

  // 自绘确认框，**不能用原生 confirm**（见 deletePerson 的注释）
  const ok = await confirmOverlay({
    title: '清空全部数据？',
    message: n > 0
      ? `将删除 ${n} 位成员、${r} 条关系，且无法撤销。\n\n`
        + '建议先「文件 → 导出数据…」留一份备份。\n'
        + '（清空后重启不会重新载入示例家族，会保持为空等你录自己的人。）'
      : '当前库已经是空的。',
    confirmText: '清空全部数据',
    danger: true,
  });
  if (!ok) return;

  const res = await clearDataset();
  if (!res.ok) { toast(res.error || '清空失败', 'warn', 6000); return; }

  /* 内存里的状态也要跟着清干净，否则界面还显示着旧数据、
     下一次 commit 又会把它们写回库里。 */
  state.dataset = normalizeDataset({
    version: '1.0', viewpoint: '', people: [], relationships: [],
  });
  state.viewpoint = '';
  state.activeId = null;
  state.familyKey = 'main';
  state.openKey = null;
  state.firstRun = false;   // 清空 ≠ 首次运行，别再灌示例

  recompute();
  render();
  toast('已清空 · 从「添加成员」开始录入吧', 'ok', 3600);
}

function doAbout() {
  const s = ruleStats();
  const db = storageInfo();                 // 桌面版才有
  const isDb = storageMode() === 'sqlite';
  const kb = (n) => (n == null ? '' : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  clearTimeout(overlay._clearTimer);
  overlay._clearTimer = null;
  overlay.onclick = null;
  overlay.innerHTML = `
    <div class="modal modal-sm" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div class="modal-title">关于数据与隐私</div>
        <button class="btn btn-ghost btn-icon" data-about="close" aria-label="关闭">${ICON.x}</button>
      </div>
      <div class="modal-body">
        <div class="field"><span class="k">存储方式</span><span class="v">${
          isDb ? '本地 SQLite 数据库' : '浏览器本地存储（localStorage）'
        }</span></div>
        ${isDb && db?.path ? `<div class="field"><span class="k">数据库文件</span><span class="v" style="word-break:break-all">${db.path}</span></div>` : ''}
        ${isDb && db?.bytes ? `<div class="field"><span class="k">文件大小</span><span class="v">${kb(db.bytes)}</span></div>` : ''}
        <div class="field"><span class="k">联网上传</span><span class="v">无 —— 全程不联网，数据不出这台电脑</span></div>
        ${state.book ? `<div class="field"><span class="k">当前族谱</span><span class="v">${esc(state.book.name)}（共 ${state.books.length} 本，各自独立存放）</span></div>` : ''}
        <div class="field"><span class="k">成员</span><span class="v">${state.dataset.people.length} 人 / ${state.dataset.relationships.length} 条关系</span></div>
        <div class="field"><span class="k">称谓规则</span><span class="v">${s.total} 条，覆盖 ${s.uniquePaths} 种路径</span></div>
        <div class="sec-title" style="margin-top:16px">为什么不能填「称呼」？</div>
        <p style="font-size:13px;line-height:1.8;color:var(--ink-500)">
          称呼一旦存成字段，就会和真实关系脱节 —— 改了父母、加了配偶，
          称呼还是旧的。本产品只存「谁是谁的父母、谁和谁是夫妻」，
          称呼每次打开都重新算。所以你的数据里永远不会有对不上的称呼。
        </p>
        <div class="sec-title">备份</div>
        <p style="font-size:13px;line-height:1.8;color:var(--ink-500)">
          ${isDb
            ? '数据存在你自己的磁盘上，每本谱一个文件夹，搬家/备份 = 直接拷贝它。每次启动还会在该谱的 backups\\ 里留一份当天快照，最近 30 天都在。'
            : '族谱是几代人的东西。建议每隔一段时间导出备份到网盘或 U 盘 —— 浏览器缓存被清掉时，只有备份能救回来。'}
        </p>
      </div>
      <div class="modal-foot">
        ${isDb ? '<button class="btn" data-about="open-dir">打开数据目录</button>' : ''}
        <button class="btn btn-primary" data-about="close">知道了</button>
      </div>
    </div>`;
  overlay.classList.add('on');
  overlay.onclick = (e) => {
    if (e.target.closest('[data-about="open-dir"]')) {
      openDataDir().then((r) => { if (r && r.ok === false) toast(r.error || '打开失败', 'warn', 5000); });
      return;
    }
    if (e.target === overlay || e.target.closest('[data-about="close"]')) {
      overlay.classList.remove('on');
      overlay._clearTimer = setTimeout(() => {
        overlay.innerHTML = '';
        overlay._clearTimer = null;
      }, 220);
    }
  };
}

/* ========================================================= */
/* 族谱库：多本谱的切换 / 新建 / 重命名 / 删除                  */
/* --------------------------------------------------------- */
/* 【为什么要有这个】一个人往往不止一套谱：自己填的、系统自带的、
   从亲戚那边拿到的底稿……它们必须互相隔离 —— 否则「切换到另一套」
   永远只能靠覆盖自己的数据来实现，那是不可接受的。

   【边界】本段只负责「把哪一套数据装进 state」。
   真正的 sqlite 读写在 electron/library.js + db.js，网页版在 store.js。
   桌面版的权限永远在主进程那边，这里一行都不碰文件系统。 */
/* ========================================================= */

/** 一份真正的空数据集（不灌示例） */
const EMPTY_DS = () => normalizeDataset({
  version: '1.0', viewpoint: '', people: [], relationships: [],
});

/**
 * 把 state 复位到「刚装进一本新谱」的状态。
 *
 * ⚠️ 必须全复位：上一本谱的 viewpoint / familyKey / activeId 指向的 id
 *    在另一本谱里根本不存在。留着的话 recompute() 会以一堆 undefined 收场
 *    （症状是画布空白 + 面板找不到人）。
 */
function applyBookSwap(dataset, book, books) {
  state.dataset = dataset || EMPTY_DS();
  state.book = book || null;
  if (books) state.books = books;
  state.viewpoint = state.dataset.viewpoint || state.dataset.people[0]?.id || '';
  state.activeId = state.viewpoint;
  state.familyKey = 'main';
  state.openKey = null;
  state.firstRun = false;   // 切谱 ≠ 首次运行，别再灌示例

  /* 照片缓存是**按谱**的：不同谱的 photos/ 目录不同，文件名可能撞。
     所以换谱先全清，再按新谱重新预热。 */
  invalidatePhotos();

  recompute();
  render();
  renderBookChip();
  setTimeout(() => canvas.fit(), 60);
  warmPhotos();
}

/** 刷新顶栏那颗「当前谱」按钮 */
function renderBookChip() {
  const pill = $('bookChip');
  if (!pill) return;
  const name = state.book?.name || '未命名谱';
  const n = state.dataset?.people?.length ?? 0;
  $('bookChipName').textContent = name;
  pill.title = `当前谱：${name}（${n} 人）· 点击切换 / 新建`;
  const countEl = $('bookChipCount');
  if (countEl) countEl.textContent = `${n} 人`;
}

/** 切换到某个视角人物：以 TA 为中心重算整张称谓表与家族树 */
function switchViewpoint(newId) {
  if (!newId || newId === state.viewpoint) return;
  state.viewpoint = newId;
  state.dataset.viewpoint = newId;
  state.familyKey = 'main';
  state.openKey = null;
  state.activeId = newId;
  recompute();
  render();
  /* 把 TA 挪到画面中间，但**不动用户调好的缩放倍数**。
     setView('tree') 内部有 setTimeout(fit, 40)，会把倍率冲回「适应窗口」，
     所以人本来就在树视图时直接跳过它，只居中；
     从体检页切过来才算真的换了视图，铺满才合理（fit 40ms 先跑，这里 80ms 后接手）。 */
  if (state.view !== 'tree') setView('tree');
  setTimeout(() => canvas.focusOn(newId, true), 80);
  saveDataset(state.dataset);
  toast(`已切换到「${displayName(state.index.byId.get(newId)) || '视角'}」的视角`, 'ok');
}

/**
 * 回到当前视角：在**当前这棵树**里把视角人摆到正中 + 严格 100%。
 *
 * 为什么需要这个（用户提出：「刚开的族谱时会找不到自己在哪」）：
 *   ① `fit()` 按**整棵树**的包围盒算倍率，人越多缩得越小（179 人的树约 0.35），
 *      卡片上的姓名生卒全糊着；
 *   ② 改一次关系整棵树会重新布局，而 `commit()` 只 recompute + render、**完全不动画布**
 *      （见 `tree.js` 里 `ensureVisible` 的注释），视口可能停在几千像素开外 → 满屏空白；
 *   ③ 切到家族页后两棵树坐标范围根本不重叠。
 *   上面三条都不是「数据坏了」，但从用户视角看都是「我不见了」。
 *
 * ⚠️⚠️ 别在这里跳回主树（0.2.52 初版犯过这个错，用户当场纠正）：
 *   切到「妻子家族 / 母亲家族」时，用户要的正是**在当前这棵树里**定位，
 *   `setFamily('main')` 等于把他刚做的切族操作作废。
 *   而「我」确实不在这两棵树上（它们分别以配偶、母亲为根的血亲）——
 *   这时退回**该家族的锚点**，也就是「我」在这棵树里的最近代表（妻子家族 → 妻子）。
 *
 * ⚠️ 为什么不能直接写 `focusOn(id, true, 1.0)`：
 *   `focusOn` 的 `zoomTarget` 语义是「**至少**放大到这么多」（只放大不缩小，
 *   停在 1.5 时点体检不会被拽回 1.0）。而这里要的是「**就是** 100%」，
 *   所以先 `setZoom(100)` 定死倍率，再 `focusOn` 只负责居中。
 */
function goToViewpoint() {
  const vpId = state.viewpoint;
  const vp = vpId ? state.index?.byId.get(vpId) : null;
  if (!vp) {
    toast('这份谱还没设置视角人（我）', 'warn');
    return;
  }

  // 体检页 → 回树视图（setView 内部 40ms 会 fit，下面 80ms 接手）
  if (state.view !== 'tree') setView('tree');

  /* 当前这棵树里有没有「我」？有就定位「我」，没有就定位当前家族的锚点。
     `canvas.has()` 读的是**已渲染**的当前视图，所以要在 setView 之后再问。 */
  const ex = state.expandable.find((x) => x.key === state.familyKey);
  const selfHere = canvas.has(vpId);
  const targetId = selfHere ? vpId : (ex?.anchorId || vpId);
  const target = state.index?.byId.get(targetId) || vp;

  selectPerson(targetId);

  // 80ms 接手：必须晚于 setView 里的 fit(40ms)，否则倍率又被冲回「适应窗口」
  setTimeout(() => {
    // 兜底：连锚点都不在当前视图（理论上不会）就别干站着，铺满整棵树
    if (!canvas.has(targetId)) {
      canvas.fit();
      toast('这棵树里找不到可定位的人，已按「适应窗口」显示', 'warn', 2400);
      return;
    }
    canvas.setZoom(100);
    canvas.focusOn(targetId, true);
  }, 80);

  toast(
    selfHere
      ? `已回到「${displayName(vp) || '我'}」· 100%`
      : `当前家族里没有「我」，已定位到「${displayName(target) || '家族主角'}」· 100%`,
    'ok', 2400
  );
}

/** 「只显示姓名」开关（v0.2.54）。
 *
 * 只改显示，不重算、不落盘到谱里：称谓照样算着，切回来一个字不少。
 * 走 render() 而不是 commit() —— commit() 会把数据集写进数据库，
 * 而「看不看称谓」跟族谱数据没关系。
 */
function toggleShowCall() {
  state.showCall = !state.showCall;
  writeUiPrefs({ showCall: state.showCall });
  render();
  toast(state.showCall ? '已恢复显示称谓' : '已切成「只显示姓名」', 'ok', 1800);
}

/** 打开 / 关闭谱下拉 */
function toggleBookMenu(force) {
  const menu = $('bookMenu');
  if (!menu) return;
  const show = force !== undefined ? force : menu.hidden;
  menu.hidden = !show;
  $('bookChip')?.setAttribute('aria-expanded', String(show));
  if (show) renderBookMenu();
}

/** 下拉内容：谱列表 + 新建 / 重命名 / 删除 */
function renderBookMenu() {
  const menu = $('bookMenu');
  if (!menu) return;

  const books = listBooks().books || state.books || [];
  state.books = books;
  const cur = state.book?.id;

  const row = (b) => `
    <button class="book-item${b.id === cur ? ' on' : ''}" data-book-id="${esc(b.id)}">
      ${ICON.users}
      <span class="bi-name">${esc(b.name)}</span>
      <span class="bi-count">${b.people ?? 0} 人</span>
      ${b.id === cur ? ICON.check : ''}
    </button>`;

  menu.innerHTML = `
    <div class="book-menu-title">切换族谱</div>
    <div class="book-list">${books.map(row).join('')}</div>
    <div class="book-menu-sep"></div>
    <button class="book-item" data-book-act="new">${ICON.plus} 新建族谱…</button>
    <button class="book-item" data-book-act="rename">${ICON.source} 重命名本谱…</button>
    ${books.length > 1
      ? `<button class="book-item danger" data-book-act="delete">${ICON.trash} 删除本谱…</button>`
      : ''}`;
}

/** 切到另一本谱 */
async function doSwitchBook(id) {
  if (!id || id === state.book?.id) { toggleBookMenu(false); return; }
  toggleBookMenu(false);

  // 先落一次盘：commit() 是乐观更新，异步写库。直接切会丢最后一次编辑。
  const r = await switchBook(id);
  if (!r.ok) { toast(r.error || '切换失败', 'warn', 6000); return; }

  // 换过谱之后的 saveDataset 要写到新的那本 —— 桌面版由主进程管，无需这里操心
  applyBookSwap(r.dataset, r.book, r.library?.books);
  toast(`已切到「${r.book?.name || ''}」`, 'ok');
}

/** 新建一本谱 */
async function doNewBook() {
  toggleBookMenu(false);
  const books = listBooks().books || [];
  const picked = await newBookDialog({
    defaultName: '',
    taken: books.map((b) => b.name),
    sample: SAMPLE_DATA,     // 由 app.js 传进去，dialog.js 不认识示例数据
  });
  if (!picked) return;

  const seed = picked.seed === 'sample' ? normalizeDataset(SAMPLE_DATA) : null;
  const r = await createBook({ name: picked.name, seedDataset: seed });
  if (!r.ok) { toast(r.error || '新建失败', 'warn', 6000); return; }

  applyBookSwap(r.dataset, r.book, r.library?.books);
  toast(`已新建「${r.book?.name || ''}」${seed ? `· 含示例 ${seed.people.length} 人` : '· 空白谱'}`, 'ok', 3600);
}

/** 给当前谱改名字 */
async function doRenameBook() {
  toggleBookMenu(false);
  if (!state.book) return;
  const books = listBooks().books || [];
  const picked = await newBookDialog({
    defaultName: state.book.name,
    taken: books.filter((b) => b.id !== state.book.id).map((b) => b.name),
    // 重命名不改内容，所以不出现「从什么起步」那一节
    askSeed: false,
    submitText: '保存改名',
  });
  if (!picked) return;

  const r = await renameBook(state.book.id, picked.name);
  if (!r.ok) { toast(r.error || '重命名失败', 'warn', 6000); return; }

  state.book = r.book;
  if (r.library?.books) state.books = r.library.books;
  renderBookChip();
  toast(`已改名为「${r.book?.name || ''}」`, 'ok');
}

/**
 * 删除当前这本谱。
 * ⚠️ 桌面版只是把目录挪到 trash\（可手工找回），但仍然是「消失」，
 *    所以必须二次确认 + 建议先导出 —— 族谱是几十年的家底。
 */
async function doDeleteBook() {
  toggleBookMenu(false);
  if (!state.book) return;
  const books = listBooks().books || [];
  if (books.length <= 1) { toast('只剩这一本谱了，不能删', 'warn'); return; }

  const n = state.dataset?.people?.length ?? 0;
  const ok = await confirmOverlay({
    title: `删除「${state.book.name}」`,
    message: `这本谱有 ${n} 位成员，删除后不再出现在列表里。\n\n`
      + '桌面版会把它的目录挪到数据目录的 trash\\ 里（不会真删，可手工找回），'
      + '但仍建议先导出一份备份。\n\n'
      + '删除后会自动切到剩下的一本谱。',
    confirmText: '删除这本谱',
    danger: true,
  });
  if (!ok) return;

  const r = await deleteBook(state.book.id);
  if (!r.ok) { toast(r.error || '删除失败', 'warn', 6000); return; }

  applyBookSwap(r.dataset, r.book, r.library?.books);
  toast('已删除本谱 · 目录已挪到 trash\\', 'ok', 4200);
}

/* ========================================================= */
/* 搜索                                                        */
/* ---------------------------------------------------------
 * v0.2.55 起，v0.2.56 改了第③条。三条口径全是被「搜到别族的人」「搜出来是错的」
 * 「输一个字弹一次红字」逼出来的：
 *
 *  ① **搜全谱，但主树置顶**。整本谱的人都在搜索范围里（按称谓找人经常
 *     就是要跨到姻亲那一页，硬砍掉会漏人），但**主树命中排在前面**，
 *     姻亲命中折叠在下面一条「另有 N 人在姻亲家族页」里。
 *     藏起来 ≠ 砍掉：用户嫌的是被别族的人干扰，不是找不到人。
 *
 *  ② **同名必须全部列出来**。口语化之后一屏好几个「侄子」，
 *     从前 `Array.find` 只取第一个，输赢全看 people 数组的顺序 = 等于随机。
 *
 *  ③ **打字时全程安静，回车才给反馈**。v0.2.55 我把「输入即搜」做成了带提示的
 *     实时搜索，结果中文按拼音一个个敲，中间那一瞬几乎搜不到人，
 *     红字「没找到」一路狂喷 —— 用户原话：「这用户还以为出啥事了呢」。
 *     现在：打字只出候选列表，一条提示都不给（连搜不到也不报）；
 *     回车 / 点结果才定位、才出提示。**只有一个人也照列**，不再自己跳走 ——
 *     打字打到一半人名还没输全就跳页，是同一个毛病的另一半。
 *     但**跳页必须说明白** —— 顶栏那排家族 tab 会自己变，不说一声
 *     用户以为数据串谱了（这正是 v0.2.55 之前「搜到其他族谱的人」的由来：
 *     其实是同谱内的姻亲家族页，代码静默切了页，没人告诉他）。
 *
 * ⚠️ 搜索范围 = state.dataset.people，**天然只在当前这一本谱之内**。
 *    多本谱各自独立存库（electron/library.js 一本谱一个目录），
 *    dataset 不存在跨谱合并，所以别去加「跨谱搜索」——
 *    那需要另一条 IPC 通道，不是这里改改能有的。
 * ========================================================= */

/** 列表最多渲染多少行。超过就在底下写清楚还有多少，别让人以为就这些。 */
const SEARCH_LIMIT = 30;

/** 输入防抖计时器。模块级而非 bindChrome 的局部 —— previewSearch / commitSearch
    自己要能清它，否则「打完字立刻按回车」会被后面那次防抖再预览一遍。 */
let searchTimer = 0;

/** 这个人属于哪一页家族视图；主树优先。都不在 → null（游离人物） */
function searchScopeOf(id) {
  if (state.layouts.main?.pos?.[id]) return 'main';
  for (const ex of state.expandable) {
    if (state.layouts[ex.key]?.pos?.[id]) return ex.key;
  }
  return null;
}

/** 那一页的显示名（主树 = 本家族；姻亲页沿用 tab 上的标签） */
function searchScopeLabel(key) {
  if (key === 'main') return '本家族';
  if (!key) return '不在任何家族页';
  return state.expandable.find((x) => x.key === key)?.label || '其他家族';
}

/**
 * 全谱搜索，返回**排好序的全部命中**。
 *
 * 【匹配与排序已下沉到 core/search.js】（v0.2.72）
 *   它原先整段住在这里，依赖 document 与全局 state，一行都测不到。
 *   现在：core 只管「匹不匹配 / 命中途径是谁 / 谁排前面」，本层只补两样
 *   core 不该知道的东西：
 *     ① 这个人属于哪一页（searchScopeOf，依赖 state.layouts）
 *     ② 那一页在界面上叫什么（searchScopeLabel）
 *   排序四条口径见 core/search.js 的注释，**别在这里另写一份**。
 */
function collectSearchHits(s) {
  return collectHits({
    people: state.dataset.people,
    kinship: state.kinship,
    query: s,
    scopeOf: searchScopeOf,
    scopeLabel: searchScopeLabel,
  });
}

/** 把命中的那几个字包成 <mark>，其余部分照常转义 */
function markHit(text, s) {
  const i = text.indexOf(s);
  if (i < 0) return esc(text);
  return esc(text.slice(0, i))
    + `<mark>${esc(text.slice(i, i + s.length))}</mark>`
    + esc(text.slice(i + s.length));
}

/**
 * 渲染结果浮层。
 *
 * 结构：主树组（默认展开）+ 姻亲组（默认折叠，标题就是「另有 N 人…」）。
 * 「只显示姓名」开着时不显示称谓 —— 用户明确说了要只按姓名认人，
 * 结果列表就不该又把称谓塞回他眼前（下方定位提示同理）。
 */
function renderSearchMenu() {
  const menu = $('searchMenu');
  const input = $('searchInput');
  if (!menu || !input) return;

  const hits = state.searchHits;
  if (!hits.length) { closeSearchMenu(); return; }

  const s = state.searchQuery;
  const main = hits.filter((h) => h.scopeKey === 'main');
  const rest = hits.filter((h) => h.scopeKey !== 'main');
  /* 上限先给主树组 —— 主树优先是排序第一条，截断时也一样，
     不能让姻亲那组把主树的人挤下去（排序第一优先级的含义就是这个）。 */
  const limMain = main.slice(0, SEARCH_LIMIT);
  const limRest = rest.slice(0, Math.max(0, SEARCH_LIMIT - limMain.length));

  const row = (h) => {
    const i = hits.indexOf(h);
    const on = i === state.searchSel;
    /* 拼音命中的行，姓名右边补一个弱化的拼音串（design.md D7）。
       为什么必须补：汉字里根本标不出「是哪一段匹配上的」——`lngshun`
       在「李长顺」里没有一段是连续的。补出来等于把匹配过程摊给用户看，
       否则他会怀疑「到底搜到了没有」。用弱化样式而不是高亮：匹配行为本身
       不是他要找的东西，整行标黄会像「重点推荐」。 */
    const py = h.hitOn === 'pinyin' && h.pinyinForm
      ? `<span class="sr-pinyin">${esc(h.pinyinForm)}</span>` : '';
    return `<button class="sr-item${on ? ' on' : ''}" data-sr-id="${esc(h.id)}" role="option"
              aria-selected="${on}"${h.hint ? ` title="${esc(h.hint)}"` : ''}>
        <span class="sr-name">${markHit(h.name, s)}</span>
        ${py}
        ${state.showCall && h.call ? `<span class="sr-call">${markHit(h.call, s)}</span>` : ''}
        <span class="sr-spacer"></span>
        ${h.scopeKey && h.scopeKey !== 'main' ? `<span class="sr-scope">${esc(h.scopeLabel)}</span>` : ''}
        ${h.year ? `<span class="sr-year">${h.year}</span>` : ''}
      </button>`;
  };

  /* 第二组的标题要说准：有人根本不在任何一页里（比如没连上关系的），
     那就不能叫「姻亲家族页」。 */
  const restTitle = rest.some((h) => !h.scopeKey)
    ? '不在本家族页'
    : '姻亲家族页';

  /* 刚打开的列表从顶部开始看；已经开着才保持滚动位置 ——
     innerHTML 一换滚动位置会归零，上下键挪高亮时不能每按一下就跳回顶。 */
  const keepTop = menu.hidden ? 0 : menu.scrollTop;
  /* 两组都直接平铺，**不做折叠**（v0.2.58 去掉折叠，原因见下方注释）：
     折叠标题是个按钮，点它就得重建列表，而重建会把被点的那个按钮自己销毁掉 ——
     事件继续冒泡到「点到别处就收起」那段，检查的还是那个已经脱离 DOM 的节点，
     于是菜单当场自己关掉（用户 2026-10-12 反馈：「点了后窗口就关闭了」）。
     少一个交互就少一处这类坑，值。 */
  menu.innerHTML = `
    ${main.length
      ? `<div class="sr-group">本家族 · ${main.length} 人</div>
         <div class="sr-list">${limMain.map(row).join('')}</div>`
      : ''}
    ${rest.length ? `
      <div class="sr-group sr-sub">${restTitle} · ${rest.length} 人</div>
      <div class="sr-list">${limRest.map(row).join('')}</div>
    ` : ''}
    ${hits.length > SEARCH_LIMIT
      ? `<div class="sr-foot">只列出前 ${SEARCH_LIMIT} 人，共 ${hits.length} 人命中 · 再多打两个字</div>`
      : ''}`;

  menu.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  menu.scrollTop = keepTop;
}

function closeSearchMenu() {
  const menu = $('searchMenu');
  if (menu) menu.hidden = true;
  $('searchInput')?.setAttribute('aria-expanded', 'false');
  /* 列表一关，「高亮是用户选的」这个前提就不成立了 ——
     下一次打字自动弹出来的列表，高亮是程序挑的第一条，不算用户的选择。 */
  state.searchChoiceValid = false;
}

/**
 * 定位到某个人：必要时切家族页 → 选中 → **定死 100% 并居中**。
 *
 * ⚠️ 必须 `setZoom(100)` + `focusOn(id)` 两步，跟 `goToViewpoint()`（回到当前视角 / V 键）
 * 完全同一套口径。用户原话：「搜索后对方的视角要和点击定位当前视角的效果一样，
 * **不然在大家族树里哪怕居中了也很难找到**」——
 * `fit()` 的倍率是按整棵树算的，几十人时缩到 0.35 左右，卡片缩成指甲盖大小，
 * 姓名生卒全糊着，**居中也没用，因为根本认不出那是个人**。
 *
 * ⚠️ 为什么不用 `focusOn(id, true, 1.0)`：那个 `zoomTarget` 的语义是
 * 「**至少**放大到这么多」（只放大不缩小，见 tree.js 的注释）。搜索要的是
 * 「**就是** 100%」—— 用户自己已经放到 1.8 时搜个人，也不该被拽回 1.0 吗？
 * 该。所以先 `setZoom(100)` 定死倍率，再让 `focusOn` 只负责居中。
 */
function pickHit(hit) {
  closeSearchMenu();

  const fromKey = state.familyKey;
  if (hit.scopeKey && hit.scopeKey !== fromKey) setFamily(hit.scopeKey);

  /* 体检视图里搜人 → 先切回树视图。
     跟 goToViewpoint() 同一处理：不然居中的是一块**看不见的画布**，
     用户切回树视图只会发现「视口莫名其妙变了」。 */
  const wasCheck = state.view !== 'tree';
  if (wasCheck) setView('tree');

  selectPerson(hit.id);

  /* 等画布换过视图再问它「这个人画出来了吗」。
     60ms = setFamily 刚重排完；100ms = 还得排在 setView 里那次 fit(40ms) 后面，
     否则倍率又被「适应窗口」冲回去。 */
  setTimeout(() => {
    if (!canvas.has(hit.id)) {
      /* 不在任何一页里（多半是没连上关系）—— 这时候居中毫无意义，
         老老实实铺满整棵树，并说清为什么没跳过去。 */
      canvas.fit();
      return;
    }
    canvas.setZoom(100);
    canvas.focusOn(hit.id, true);
  }, wasCheck ? 100 : 60);

  const k = state.kinship.get(hit.id);
  const callTxt = state.showCall && k?.ok ? k.dialect + ' ' : '';

  if (!hit.scopeKey) {
    return toast(`找到 ${callTxt}${hit.name} · TA 不在任何家族页里，多半是没连上关系`, 'warn', 4200);
  }
  if (hit.scopeKey !== fromKey) {
    return toast(`找到 ${callTxt}${hit.name} · 已切到「${hit.scopeLabel}」页 · 100%`, 'ok', 3200);
  }
  return toast(`找到 ${callTxt}${hit.name} · 100%`, 'ok', 2200);
}

/**
 * 打字时的**预览**（实时搜索的「预览」那一半）。
 *
 * ⚠️⚠️ 这一函数**绝对不许弹 toast、不许跳转、不许切家族页**。
 * 用户2026-10-12 当面说过：「我还没输完就吐司不停，要等我点击搜索时再提示，
 * 这用户还以为出啥事了呢」。
 * 原因很直白：中文按拼音一个个敲，「林」→「林姑」中间那一瞬几乎搜不到人，
 * 拿「没找到」去报这种中间状态，就是在用假警报吓人。
 * 所以这里只更新候选列表，**一条提示都不给**；连「一个都没搜到」也不打扰，
 * 直接把列表收起来 —— 打字打到一半搜不到是常态，不是错误。
 */
function previewSearch(q) {
  clearTimeout(searchTimer);

  const s = String(q || '').trim();
  state.searchQuery = s;
  state.searchHits = s ? collectSearchHits(s) : [];
  state.searchSel = state.searchHits.length ? 0 : -1;
  state.searchChoiceValid = false;   // 新一轮预览，高亮是程序挑的，不算用户选了

  if (state.searchHits.length) renderSearchMenu();
  else closeSearchMenu();
}

/**
 * 回车 —— 这一刻才是「用户真的在搜」。
 *
 * ⚠️ 口径（用户 2026-10-12 提的，v0.2.55 那版写反了）：
 * **只有「姓名全等」才允许直接跳转。**其余一律开列表等人选：
 *   · 子串命中（「李」→ 李明、李强…）—— 你多半还没输完
 *   · 按称谓命中（「侄子」）          —— 一屏好几个侄子，跳哪个都是蒙
 *   · 姓名全等但有多人同名            —— 歧义，摆出来让人挑
 * 从前是「有命中就跳第一条」，等于**替用户挑了一个人**，跳过去还弹个「找到某某」，
 * 看着像程序认定那就是他要找的 —— 这比搜不到更糟。
 *
 * ⚠️ 唯一的例外是 `state.searchChoiceValid`：**用户已经用 ↑↓ 在列表里选过了**，
 * 这时回车就是「我要这一条」，必须照办（v0.2.61 修的就是这个 ——
 * 从前只认「列表是回车开的」，不认「用户选过了」，
 * 于是选完按回车只会把列表重开、高亮弹回第一条，看着像按了没反应）。
 *
 * @returns {'picked'|'listed'|'empty'} listed = 开了列表，输入框要留着焦点好接 ↑↓ 回车
 */
function commitSearch() {
  clearTimeout(searchTimer);

  const s = ($('searchInput')?.value || '').trim();

  /* 要在 closeSearchMenu() **之前**取 —— 关列表会把这个标志清掉。 */
  const choiceValid = !!$('searchMenu') && !$('searchMenu').hidden
    && state.searchChoiceValid;

  closeSearchMenu();
  if (!s) return 'empty';

  /* 重算而不复用预览结果：Enter 可能落在 120ms 防抖之前，那会儿 hits 还是空的。
     走 core 的 search()：hits 与 exact 同源，不在这儿另写一份「姓名全等」判定
     —— 两处各写各的，早晚会出现「预览能跳、回车不跳」这种对不上的毛病。 */
  const { hits, exact } = search({
    people: state.dataset.people,
    kinship: state.kinship,
    query: s,
    scopeOf: searchScopeOf,
    scopeLabel: searchScopeLabel,
  });

  // 用户已经自己选过了 → 照办，不再跟他商量
  if (choiceValid && hits.length) {
    const i = state.searchSel >= 0 && state.searchSel < hits.length ? state.searchSel : 0;
    pickHit(hits[i]);
    return 'picked';
  }

  if (exact.length === 1) {
    pickHit(exact[0]);
    return 'picked';
  }

  if (!hits.length) {
    toast(`没找到「${s}」`, 'warn');
    return 'empty';
  }

  state.searchQuery = s;
  state.searchHits = hits;
  state.searchSel = 0;
  state.searchChoiceValid = false;   // 重开的高亮不是用户选的，别当成确认
  renderSearchMenu();
  return 'listed';
}

/** 上下键挪高亮；到头不循环（循环会让长列表里按住↓一路冲到底） */
function moveSearchSel(delta) {
  const n = state.searchHits.length;
  if (!n) return;
  const next = state.searchSel + delta;
  state.searchSel = next < 0 ? 0 : next > n - 1 ? n - 1 : next;
  /* 按了 ↑↓ 就等于「我选的就是这一条」，回车必须照办（v0.2.61 修的 bug）。 */
  state.searchChoiceValid = true;
  renderSearchMenu();
  // 高亮可能在滚动区外面跟着滚过去
  $('searchMenu')?.querySelector('.sr-item.on')
    ?.scrollIntoView({ block: 'nearest' });
}

/* ========================================================= */
/* 事件接线                                                    */
/* ========================================================= */

function bindChrome() {
  // 顶栏
  $('viewSwitch').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-family]');
    if (tab) setFamily(tab.dataset.family);
  });

  /* 族谱库下拉（v0.2.24）。
     刻意**不用 overlay**：overlay 一打开就会通知主进程禁用一组原生菜单，
     而这个下拉只是个临时浮层，没必要把菜单锁掉。 */
  $('bookChip').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleBookMenu();
  });

  $('bookMenu').addEventListener('click', (e) => {
    const act = e.target.closest('[data-book-act]');
    if (act) {
      toggleBookMenu(false);
      if (act.dataset.bookAct === 'new') doNewBook();
      if (act.dataset.bookAct === 'rename') doRenameBook();
      if (act.dataset.bookAct === 'delete') doDeleteBook();
      return;
    }
    const item = e.target.closest('[data-book-id]');
    if (item) doSwitchBook(item.dataset.bookId);
  });

  // 点到别处就收起来
  document.addEventListener('click', (e) => {
    const menu = $('bookMenu');
    if (!menu || menu.hidden) return;
    if (!e.target.closest('#bookSw')) toggleBookMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('bookMenu').hidden) toggleBookMenu(false);
  });

  /* 搜索框（v0.2.55 重做接线，v0.2.56 改口径）。
   **打字 = 静默预览**（防抖 120ms，只出候选列表、不给任何提示）；
   **回车 / 点结果 = 提交**，提示只在提交那一刻出。理由见 previewSearch 的注释。 */
  const searchInput = $('searchInput');
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => previewSearch(searchInput.value), 120);
  });

  /* 鼠标点回输入框（框里还留着字）→ 把候选列表重新弹出来（用户 2026-10-12 要求）。
     之前只有 `input` 事件才刷新预览，于是「打完字 → 点别处 → 再点回框里」是一片空白 ——
     搜索词明明还在，用户却得先删一个字才能看到候选。
     走 `click` 而不是 `focus`：框已经聚焦时再点是**不触发** focus 的，
     而「框里已经有字、又点了一下」恰恰是最常见的那个动作。 */
  searchInput.addEventListener('click', () => {
    if (!searchInput.value.trim()) return;
    clearTimeout(searchTimer);   // 顺手撤掉待触发的防抖，免得弹两遍
    previewSearch(searchInput.value);
  });

  searchInput.addEventListener('keydown', (e) => {
    const listOpen = !$('searchMenu').hidden;

    if (e.key === 'ArrowDown' && state.searchHits.length) {
      e.preventDefault();
      // 列表还没开（刚打完字）时，先从「没选中」起步，落到第一个人
      if (!listOpen) state.searchSel = -1;
      moveSearchSel(1);
      return;
    }
    if (e.key === 'ArrowUp' && state.searchHits.length) {
      e.preventDefault();
      moveSearchSel(-1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // 开了列表就**别失焦** —— 用户还要 ↑↓ 挑、回车确认；跳走了才收焦
      if (commitSearch() !== 'listed') e.target.blur();
      return;
    }
    if (e.key === 'Escape') {
      if (listOpen) closeSearchMenu();       // 先关列表，再失焦
      e.target.blur();
    }
  });

  $('searchMenu').addEventListener('click', (e) => {
    const item = e.target.closest('[data-sr-id]');
    if (!item) return;
    const hit = state.searchHits.find((h) => h.id === item.dataset.srId);
    if (hit) pickHit(hit);
  });

  /* 点到别处就收起（和 #bookMenu 同一套：临时浮层，不锁原生菜单）。
     ⚠️ 判断的是**整个搜索控件 #searchSw**，不是只有 #searchMenu ——
     输入框是浮层的兄弟节点不是子节点，只认浮层的话，点一下输入框就会把列表收掉，
     「点回输入框弹列表」这条需求永远做不到。
     ⚠️ 必须用 `composedPath()` 而不是 `closest()`：点结果行会触发 `innerHTML` 重建，
     被点的那个 `<button>` 当场从 DOM 上消失，而事件还在往上冒泡。
     `closest()` 走的是**活的** DOM，节点一脱离就返回 null；`composedPath()` 返回的是
     事件发生那一刻的原始路径，不受影响。v0.2.57 的折叠按钮就是栽在这：
     一点它 → 重建把它销毁 → 这里判定成「点到别处」→ 菜单自己关掉。 */
  document.addEventListener('click', (e) => {
    const menu = $('searchMenu');
    if (!menu || menu.hidden) return;
    const box = $('searchSw');
    if (!e.composedPath().includes(box || menu)) closeSearchMenu();
  });

  $('zoom').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'zoom-in') canvas.zoomBy(1.15);
    if (b.dataset.act === 'zoom-out') canvas.zoomBy(1 / 1.15);
  });

  // 左导航轨 + 顶栏按钮（统一 data-act 分发）
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    runAction(b.dataset.act, b);
  });

  // 面板把手
  $('panelHandle').addEventListener('click', togglePanel);
}

/**
 * 动作分发。
 * 抽成独立函数，是为了让**桌面菜单**也能复用同一套动作
 * （主进程 → preload → 这里），不必在 Electron 里再实现一遍同样的逻辑。
 * @param {string} act
 * @param {HTMLElement|null} b 触发元素（有些动作要从它身上读 data-*）
 */
function runAction(act, b = null) {
  switch (act) {
    case 'view-tree': setView('tree'); break;
    case 'view-check': setView('check'); break;
    case 'fit': canvas.fit(); break;
    case 'to-me': goToViewpoint(); break;
    case 'toggle-call': toggleShowCall(); break;
    case 'add': addPerson(); break;
    case 'book-new': doNewBook(); break;
    case 'book-rename': doRenameBook(); break;
    case 'book-delete': doDeleteBook(); break;
    case 'import': doImport(); break;
    case 'export': doExport(); break;
    case 'export-image': doExportImage(); break;
    case 'clear': doClear(); break;
    case 'about': doAbout(); break;
    case 'close-panel': togglePanel(); break;
    case 'toggle-family': toggleFamily(b?.dataset.anchor, b?.dataset.key); break;
    case 'edit': {
      const p = state.index.byId.get(b?.dataset.id);
      if (p) openPersonDialog({
        person: p, dataset: state.dataset, index: state.index,
        viewpoint: state.viewpoint, kinship: state.kinship,
        onSave: (pl) => upsertPerson(pl, null),
        onDelete: deletePerson,
        // 从详情面板的「补充」按钮点进来时，带上目标字段，弹窗打开后聚焦它
        focusField: b?.dataset.field || null,
      });
      break;
    }
    case 'add-relative': addRelative(b?.dataset.id, b?.dataset.rel || null); break;
    case 'switch-vp': switchViewpoint(b?.dataset.id); break;
    case 'add-photo': addPhoto(b?.dataset.id); break;
    case 'photo-open': openPhotoLightbox(b?.dataset.id, b?.dataset.name); break;
    case 'photos-all': openPhotoLightbox(b?.dataset.id); break;
    case 'photo-avatar': setPhotoAvatar(b?.dataset.id, b?.dataset.name); break;
    case 'photo-delete': deletePhoto(b?.dataset.id, b?.dataset.name); break;
    default: break;
  }
}

/**
 * 桌面版接菜单。
 * 主进程的菜单项只是「发一个动作名」，真正的逻辑仍在渲染层，
 * 保持只有一处实现（网页版 / 桌面版行为不会漂移）。
 */
function bindDesktopMenu() {
  const b = typeof window !== 'undefined' ? window.genogramFS : null;
  if (!b?.onMenu) return;                 // 网页版：没有菜单，直接跳过
  b.onMenu((action) => {
    try {
      runAction(action);
    } catch (e) {
      console.error('[menu] 动作失败：', action, e);
      toast('菜单操作失败：' + (e?.message || e), 'warn', 5000);
    }
  });
}

function togglePanel() {
  state.panelCollapsed = !state.panelCollapsed;
  renderPanelArea();
}

/**
 * 把「现在有弹窗开着」告诉主进程，让它禁用会捣乱的原生菜单项。
 *
 * ⚠️ 为什么必须走主进程：accelerator（Ctrl+S / Ctrl+N / Ctrl+O / Ctrl+1…）
 *   是在 Windows 的原生菜单 accelerator 表里处理的，**优先级高于网页层的 keydown**，
 *   渲染层压根收不到这些按键，也就 preventDefault 不掉。
 *   编辑途中按 Ctrl+S 会真的弹出系统「另存为」（主进程模态，窗口失活，
 *   看上去就像「界面卡住改不动」）。
 *
 * 用 MutationObserver 盯 overlay 的 .on 类，而不是在每个 openXxxDialog 里手写通知 ——
 * 编辑弹窗、「添加亲属」的两段式流程、「关于」全都走 overlay，
 * 以后新增弹窗也不会漏掉。
 */
function bindEditingMode() {
  const b = typeof window !== 'undefined' ? window.genogramFS : null;
  if (!b?.setEditing || typeof MutationObserver === 'undefined') return;

  let last = null;      // 避免重复通知（比如 .on 反复被加上又移除）
  new MutationObserver(() => {
    const on = !!overlay?.classList.contains('on');
    if (on === last) return;
    last = on;
    try {
      b.setEditing(on);
    } catch { /* 主进程不在（网页版）就算了 */ }
  }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
}

function bindPanel() {
  // 面板内的跳转链接（亲属关系里点人名）
  $('panel').addEventListener('click', (e) => {
    const a = e.target.closest('[data-jump]');
    if (!a) return;
    const id = a.dataset.jump;
    const inView = state.layouts[state.familyKey]?.pos?.[id];
    if (!inView) {
      const other = Object.keys(state.layouts).find((k) => state.layouts[k].pos?.[id]);
      if (other) setFamily(other);
    }
    selectPerson(id);
    setTimeout(() => canvas.focusOn(id), 60);
  });
}

function bindCheck() {
  // 体检清单里点人名 → 跳到树上那个人，并放大到 100%
  //
  // ⚠️ 为什么这里要传 1.0：setView('tree') 会先 fit()（按整棵树算倍率，人越多越小），
  //    跟着的 focusOn 若沿用那个倍率，卡片上的姓名生卒全是糊的 —— 而体检跳转的
  //    目的正是「跳过去改这个人」，得给修的尺度。只放大不缩小（focusOn 内部保证）。
  $('checkWrap').addEventListener('click', (e) => {
    const w = e.target.closest('[data-jump]');
    if (!w) return;
    setView('tree');
    const id = w.dataset.jump;
    const inView = state.layouts[state.familyKey]?.pos?.[id];
    if (!inView) {
      const other = Object.keys(state.layouts).find((k) => state.layouts[k].pos?.[id]);
      if (other) setFamily(other);
    }
    selectPerson(id);
    setTimeout(() => canvas.focusOn(id, true, 1.0), 80);
  });
}

function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;

    /* ⚠️⚠️ 弹窗打开时，全局快捷键一律不响应（2026-10-09 修复）。
     *
     * 真实故障（用户报「改着改着就无法修改」，已在真 Electron 里复现）：
     *   原来的守卫是 `e.target.matches('input,textarea,select')` —— 它假设焦点总在输入框里。
     *   可编辑弹窗里的「在世」开关是 div、「性别」是 button，点完**焦点就掉到 <body>**，
     *   守卫随之失效。于是用户接着按的每个键都命中了全局快捷键：
     *     n → addPerson()，「编辑成员」被整个换成「添加成员」，**正在填的内容全丢**；
     *     1 / 2 → 切走视图；f → 画布 fit 突然缩放。
     *   Ctrl+K 更直接：界面右上角印着 ⌘K 提示，用户在编辑途中一按，
     *   焦点被抢到搜索框，从此「打不进字」。
     *
     * 所以判断依据换成「有没有弹窗」，而不是「焦点在哪」——
     * 只要 overlay 上有 .on，就别碰用户的键盘。
     * （Esc 关闭弹窗不受影响：它由 dialog.js 自己的 document 监听处理，走在冒泡前。）
     * 原生菜单那几项（Ctrl+S / N / O / 1 / 2）渲染层拦不住，
     * 由主进程在弹窗打开时禁用它们，见 electron/main.js 的 setEditingMode。 */
    if (overlay && overlay.classList.contains('on')) return;

    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('searchInput').focus();
      $('searchInput').select();
      return;
    }
    if (mod && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      doExport();
      return;
    }
    if (e.target.matches('input,textarea,select')) return;

    switch (e.key) {
      case '0': canvas.setZoom(100); break;
      case 'f': case 'F': canvas.fit(); break;
      // 「回到当前视角」：我居中 + 严格 100%（0 只是改倍率，f 只是铺满，都不居中）
      case 'v': case 'V': goToViewpoint(); break;
      case 'n': case 'N': addPerson(); break;
      case '1': setView('tree'); break;
      case '2': setView('check'); break;
      default: break;
    }
  });
}

/* ========================================================= */
/* Toast                                                       */
/* ========================================================= */

function toast(msg, kind = '', ms = 2600) {
  const wrap = $('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.innerHTML = `${kind === 'warn' ? ICON.alert : kind === 'ok' ? ICON.check : ICON.info}
                  <span>${esc(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 200ms';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

/* ========================================================= */
/* 小工具                                                      */
/* ========================================================= */

function nameOf(id) {
  const p = state.index?.byId.get(id);
  return p ? displayName(p) : id;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ========================================================= */
/* 运行时错误兜底                                              */
/* --------------------------------------------------------- */
/* 族谱是给人用的，不是给开发者看的。任何未捕获异常都不该
   表现成「白屏 + 用户一脸懵」，至少要告诉用户发生了什么、
   数据还在不在。                                              */
/* ========================================================= */

window.addEventListener('error', (e) => {
  console.error('[runtime]', e.error || e.message);
  toast(`出错了：${e.message}（你的数据已保存，刷新页面可恢复）`, 'warn', 8000);
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('[runtime] 未处理的 Promise 拒绝：', e.reason);
  toast(`出错了：${e.reason?.message || e.reason}`, 'warn', 8000);
});

/* 启动 */
boot();
