/**
 * =========================================================
 * 录入 / 编辑弹窗 · ui/dialog.js
 * ---------------------------------------------------------
 * 【设计要点】
 *   1. 只收「事实」，不收「称呼」—— 表单里没有、也不该有「称谓」字段。
 *      用户填的是父亲是谁、母亲是谁，称呼由引擎算（PRD §3.1）。
 *   2. 父母是**两个槽位**（父 / 母），写回时落成两条 parent 边。
 *      界面上分父亲母亲，是因为人脑就是这么想的；
 *      底层统一成一条边、靠 sex 区分，避免「父字段和母字段不一致」。
 *   3. 防环校验前置：不能让「我的孙子当我的父亲」这种数据进库。
 *      引擎虽然有防环保护，但脏数据进去了 F8 也救不回来用户体验。
 * =========================================================
 */

import { ICON } from './icons.js';
import { PRIVACY, PRIVACY_HINT, makeId, displayName } from '../core/model.js';
import { deriveKinship, displayCall } from '../core/kinship.js';
import { filterParentCandidates, splitParentCandidates, branchOfSymbols } from '../core/parentFilter.js';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * 打开人物录入 / 编辑弹窗。
 *
 * @param {object} ctx
 * @param {object|null} ctx.person   为 null 表示「新增」
 * @param {object} ctx.dataset
 * @param {object} ctx.index
 * @param {string} [ctx.presetParentId] 从「添加亲属」进来时的焦点人物
 * @param {string} [ctx.presetRelation] 'father'|'mother'|'spouse'|'child'|null
 * @param {(payload:object)=>void} ctx.onSave
 * @param {(id:string)=>boolean} [ctx.onDelete] 返回 true 才表示「真删掉了」，
 *        弹窗据此决定关不关（取消确认 / 拒绝删本人时都必须保持打开）
 */
export function openPersonDialog(ctx) {
  const { person, dataset, index, onDelete, presetSex, presetParents, subtitle, focusField } = ctx;
  const isEdit = !!person;

  const overlay = document.getElementById('overlay');
  // ⚠️ 关系选择器 / 关于弹窗用的是 overlay.onclick 赋值，
  //    这里必须清掉，否则点遮罩会误触上一个流程的回调。
  overlay.onclick = null;
  // ⚠️ 竞态：上一个弹窗 close() 会排一个 ~220ms 后清空 overlay 的定时器，
  //    而「添加亲属」流程是 close() 之后 200ms 再打开本弹窗 ——
  //    若不取消，200ms 渲染出来的表单会在 220ms 被那个残留定时器擦掉（弹窗一闪即逝）。
  clearTimeout(overlay._clearTimer);
  overlay._clearTimer = null;
  overlay.innerHTML = shell(ctx, isEdit);
  overlay.classList.add('on');

  const modal = overlay.querySelector('.modal');
  const form = overlay.querySelector('form');

  /* ---------- 性别分段 ---------- */
  let sex = person?.sex || presetSex || '';
  const sexBtns = [...form.querySelectorAll('[data-sex]')];
  const paintSex = () => sexBtns.forEach((b) => b.classList.toggle('on', b.dataset.sex === sex));
  /* ⚠️ 别让这些控件把焦点从输入框抢走（2026-10-09 修复）。
   * 性别是 <button>、在世开关是 <div>，点完焦点会落到 <body>，
   * 而 app.js 的全局快捷键守卫是 `e.target.matches('input,textarea,select')` ——
   * 焦点一离开输入框，用户接着按的每个键都会命中快捷键
   * （n 会弹「添加成员」把正在填的表单整个顶掉）。
   * 在 mousedown 上 preventDefault：点击照常触发，焦点原地不动。 */
  sexBtns.forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));
  // 再点已选中的按钮 = 取消，回到「未知」（婴儿暂未确认性别时常用）
  sexBtns.forEach((b) => b.addEventListener('click', () => {
    sex = (b.dataset.sex === sex) ? '' : b.dataset.sex;
    paintSex();
  }));
  paintSex();

  /* ---------- 在世开关 ---------- */
  const aliveWrap = form.querySelector('#f-alive');
  let alive = person ? person.alive !== false : true;
  const paintAlive = () => {
    aliveWrap.classList.toggle('on', alive);
    form.querySelector('#row-death').style.display = alive ? 'none' : '';
    const at = form.querySelector('#f-alive-text');
    // ⚠️ 之前文案写死「已故（点击切换）」，不随状态变化，
    // 已故/在世看不出当前值，容易误以为这个开关不能改。改为随状态显示。
    if (at) at.textContent = alive ? '在世（点击切换为已故）' : '已故（点击切换为在世）';
  };
  aliveWrap.addEventListener('mousedown', (e) => e.preventDefault());   // 同性别按钮：别抢焦点
  aliveWrap.addEventListener('click', () => { alive = !alive; paintAlive(); });
  paintAlive();

  /* ---------- 关闭 ---------- */
  const close = () => {
    overlay.classList.remove('on');
    overlay.onclick = null;
    overlay._clearTimer = setTimeout(() => {
      overlay.innerHTML = '';
      overlay._clearTimer = null;
    }, 220);
    document.removeEventListener('keydown', onKey);
  };
  function onKey(e) {
    // ⚠️ 输入法合成（中文/日文等）期间按 Esc 是「取消候选词」，不是「关闭弹窗」。
    // 不判断 isComposing / keyCode===229 会误关编辑弹窗，导致正在输入的内容丢失。
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }
  document.addEventListener('keydown', onKey);

  // 遮罩点击关闭：用单一 onclick 赋值（与 app.js 里 addRelative / doAbout 一致），
  // 避免 addEventListener 每次打开都叠加、close 又不移除，导致残留监听反复清空当前弹窗。
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  form.querySelector('[data-act="cancel"]').addEventListener('click', close);
  form.querySelector('[data-act="close"]').addEventListener('click', close);

  /* ---------- 记住「刚才在填哪个输入框」 ----------
   * 删除没删成时要把焦点还回去，不能一律跳回姓名框 ——
   * 用户正填到一半的是备注/生日，焦点却跳到姓名，继续往下打字就填错地方了。
   * 用 focusin 追踪（不用 focusout：点按钮也会触发 focusout，那时已经丢焦点了）。 */
  let lastFocus = null;
  form.addEventListener('focusin', (e) => {
    if (e.target && e.target.matches?.('input,textarea,select')) lastFocus = e.target;
  });
  const lastFocusEl = () => (lastFocus && lastFocus.isConnected ? lastFocus : null);

  if (isEdit && onDelete) {
    let deleting = false;
    form.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
      /* ⚠️ 删除没成功时**绝不能关窗**（2026-10-09 修复）。
       *
       * 旧写法是无条件 `onDelete(person.id); close();`，而 deletePerson 有两条
       * 提前返回的路径 —— 根本不是「删除被触发」而是「删除压根没发生」：
       *   ① 删的是视角人物（本人），代码拒绝并弹 toast；
       *   ② 人已经不在索引里。
       * 这两种情况下弹窗照样被关掉：用户正在填的内容全部丢失。
       *
       * 现在按返回值决定：只有真删掉了才关窗；否则弹窗留在原地，
       * 焦点还给刚才在填的那个输入框，用户可以接着改。
       *
       * try/catch 同样重要：删除过程一旦抛异常，这里**绝不能**让异常把 close() 顶掉 ——
       * overlay 会残留 .on，遮罩的 pointer-events:auto 加上 bindKeyboard 的全局守卫
       * 会把整个界面锁死，那才是字面意义上的「完全打不进字」。 */
      if (deleting) return;
      deleting = true;
      const backToField = () => (lastFocusEl() || form.querySelector('#f-name'))?.focus();

      // 二次确认走自绘确认框，**绝不用原生 confirm**（原因见 confirmOverlay 的注释）
      const kids = (index.kidsOf.get(person.id) || []).length;
      const ok = await confirmOverlay({
        title: '删除这个人',
        message: `确定删除「${displayName(person)}」吗？\n\n`
          + 'TA 的所有关系记录会一并删除，此操作不可撤销。\n'
          + (kids ? `TA 的 ${kids} 位子女仍在，但会失去这一侧的父母。\n` : '')
          + '（建议先导出备份）',
        confirmText: '删除',
        danger: true,
      });
      if (!ok) { deleting = false; backToField(); return; }

      let removed = false;
      try {
        removed = onDelete(person.id) === true;
      } catch (e) {
        console.error('[delete] 删除失败：', e);
        removed = false;
      }
      if (!removed) { deleting = false; backToField(); return; }
      close();
    });
  }

  /* ---------- 提交 ---------- */
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = validate(form, sex, { person, index, dataset });
    if (err) return showError(form, err);

    const cur = index.byId.get(person?.id);
    const payload = {
      id: person?.id || makeId(index.ids),
      name: val(form, 'name').trim(),
      sex,
      birth: val(form, 'birth').trim(),
      death: alive ? '' : val(form, 'death').trim(),
      alive,
      place: val(form, 'place').trim(),
      note: val(form, 'note').trim(),
      order: val(form, 'order') === '' ? null : Number(val(form, 'order')),
      privacy: val(form, 'privacy') || 'family',
      // 关系槽位
      father: val(form, 'father') || '',
      mother: val(form, 'mother') || '',
      // ⚠️ 不再在这里提交 spouses：配偶改由「添加亲属」流程维护。
      //    本表单不携带该字段，upsertPerson 会原样保留既有配偶边，不会误删。
      expand: null,
    };
    // 自定义称呼：保留其他视角的覆盖值，只改「当前视角」这一项
    const vpt = dataset.viewpoint;
    const callOverride = { ...(cur?.callOverride || {}) };
    const newCall = val(form, 'callOverride').trim();
    if (newCall) callOverride[vpt] = newCall;
    else delete callOverride[vpt];
    payload.callOverride = callOverride;
    // 保留原有的照片 / 头像（表单里没有的字段不能丢）
    payload.avatar = cur?.avatar || '';
    payload.photos = cur?.photos || [];

    ctx.onSave(payload);
    close();
  });

  // 自动聚焦：优先聚焦从详情面板「补充」按钮点进来的目标字段
  let focusEl = null;
  if (focusField) {
    if (focusField === 'death') { alive = false; paintAlive(); }
    focusEl = focusFieldEl(form, focusField);
  }
  setTimeout(() => (focusEl || form.querySelector('#f-name'))?.focus(), 60);
}

/**
 * 把详情面板传来的 focusField 映射到弹窗里的实际控件。
 * 返回可聚焦的元素（或 null 表示沿用默认聚焦到姓名）。
 */
function focusFieldEl(form, field) {
  switch (field) {
    case 'sex':     return form.querySelector('[data-sex="M"]');
    case 'birth':   return form.querySelector('#f-birth');
    case 'death':   return form.querySelector('#f-death');
    case 'place':   return form.querySelector('#f-place');
    case 'order':   return form.querySelector('#f-order');
    case 'note':    return form.querySelector('#f-note');
    case 'callOverride': return form.querySelector('#f-callOverride');
    case 'father':  return form.querySelector('#f-father');
    case 'mother':  return form.querySelector('#f-mother');
    default:        return null;
  }
}

/* ========================================================= */
/* 模板                                                        */
/* ========================================================= */

function shell(ctx, isEdit) {
  const { person, dataset, index, presetParentId, presetRelation, subtitle } = ctx;

  const fatherNow = person ? fatherOf(index, person.id) : '';
  const motherNow = person ? motherOf(index, person.id) : '';

  /* ---------- 我该怎么称呼他（2026-10-10 用户要求） ----------
   * 下拉里原来写的是「第 3 代 · 曾祖辈」，用户反馈「完全不认识」——
   * 世次和辈分标签是给数据看的词，不是给人看的词。
   * 真正帮用户认出「这条是谁」的，是**我该怎么叫 TA**：
   * 爸爸 / 大伯 / 二爷爷 / 堂弟… 一眼就能对上人。
   * 优先用 app.js 已经算好的全表称谓（state.kinship，零额外开销），
   * 拿不到时才现场推一次。推不出来就什么都不显示 —— 宁可空着，
   * 也不摆「（关系待确认）」去干扰选人。 */
  const viewpoint = ctx.viewpoint || dataset.viewpoint || '';
  /* ⚠️ 同一个人**只推一次**关系：下面的 callOf（要称呼）和 parentOptions
     的分组（要路径首符号）都要它。两个人各算一遍就是白算两倍 ——
     父母候选常有几十项，能缓存就缓存。 */
  const kinCache = new Map();
  const kinOf = (p) => {
    if (kinCache.has(p.id)) return kinCache.get(p.id);
    const kin = (!viewpoint || p.id === viewpoint) ? null
      : (ctx.kinship?.get?.(p.id) || deriveKinship(dataset, index, viewpoint, p.id));
    kinCache.set(p.id, kin);
    return kin;
  };
  const callOf = (p) => {
    if (!viewpoint || p.id === viewpoint) return '';        // 「我」自己，没有称呼
    const kin = kinOf(p);
    if (!kin) return '';
    const call = displayCall(p, kin, viewpoint);
    // 无手动覆盖且规则也算不出时，下拉里不显示，免得干扰选人
    return (call && call !== '（关系待确认）') ? call : '';
  };
  // 自定义称呼：按当前视角存的覆盖值（编辑时回填）
  const vpName = viewpoint ? (displayName(index.byId.get(viewpoint)) || '') : '';
  const initCall = person?.callOverride?.[viewpoint] || '';

  /* ⚠️ 从「添加亲属」进来时父母已经**算好了**（见 app.js 的 guessParentsOfChild）。
     以前这里是两行死代码 `presetRelation === 'father' ? '' : ''` 和 `''`，
     也就是从「添加子女」进来时父母下拉**永远是空的** —— 用户每加一个孩子
     都得手动把父母重选一遍。`presetParentId` 更是在文档里挂着、
     shell 里解构出来却从头到尾没用过，是个半成品。 */
  const presetParents = ctx.presetParents || null;
  const preFather = presetParents?.father || '';
  const preMother = presetParents?.mother || '';
  const lockFather = !!preFather;
  const lockMother = !!preMother;
  const bothLocked = lockFather && lockMother;

  /* 已锁定的父母渲染成**静态文字 + hidden input**：
     界面上不再给下拉（用户明确说「别再让用户再手动选一次」），
     但 hidden input 保证 `val(form,'father')` 照常取得到值，
     校验与提交逻辑一行都不用改。
     ⚠️ 未锁定的那一侧**绝不拿另一侧当预选值** —— 参照人没有配偶时
     （比如只有父亲、母亲还空着）母亲下拉里根本不会列出父亲，
     硬塞一个 id 只会让下拉静默显示「未填写」，不如老实留空。 */
  const parentField = (role, locked, id) => {
    const label = role === 'father' ? '父亲' : '母亲';
    const otherNow = role === 'father' ? motherNow : fatherNow;
    if (locked) {
      const p = index.byId.get(id);
      const call = callOf(p);
      return `
        <div class="form-item">
          <label class="form-label">${label} <span class="hint">已按参照人确定</span></label>
          <input type="hidden" id="f-${role}" name="${role}" value="${esc(id)}">
          <div class="locked-parent">
            <b>${esc(displayName(p))}</b>${call ? `（${esc(call)}）` : ''}
          </div>
        </div>`;
    }
    return `
      <div class="form-item">
        <label class="form-label" for="f-${role}">${label}</label>
        <select class="select" id="f-${role}" name="${role}">
          ${parentOptions(role === 'father' ? fatherNow : motherNow, otherNow, role)}
        </select>
      </div>`;
  };

  const people = [...dataset.people].sort((a, b) => {
    const ga = a.gen ?? 0, gb = b.gen ?? 0;
    if (ga !== gb) return gb - ga;            // 辈分高的在前
    return (a.order ?? 99) - (b.order ?? 99);
  });

  // 候选父亲/母亲列表。
  //
  // ⚠️ 硬约束（2026-10-09 修复）：父母必须**比自己年长**，即 p.gen > person.gen。
  //    旧实现没有任何辈分过滤，排序权重 tierOf 又把「gen < myGen」判成「上代 → 最优先」，
  //    而 gen 越小越年轻 —— 结果整个下拉是按「年轻 → 年长」排的：自己的子女永远第 1、
  //    侄女排第 2、真正的父母掉到几十名开外（实测「我」的母亲排第 40，
  //    王国栋的母亲排第 59，而他自己的三个子女排第 6）。排序在错的集合上做得再细也没用，
  //    所以这里改成先硬过滤、再排序。
  //
  // 排除项：本人 / 另一侧已选的父母 / 自己的配偶 / 自己的直系后代。
  // 兜底：万一过滤后一个候选都不剩（世次数据缺失等异常），退回仅排除上述项的全量列表，
  //保证「添加成员」时这个下拉永远不为空。
  // 排序：① 越接近父母那一辈（myGen + 1）越靠前；② 性别合适优先；
  //      ③ **另一侧已选父母的配偶**优先（填了父亲，母亲最可能就是他的妻子；
  //      填了母亲，父亲同理 —— 这是最强也最省事的启发式）；
  //      ④ 树上已有子女者优先；⑤ 排行。
  const parentOptions = (selected, exclude, role) => {
    const wantSex = role === 'father' ? 'M' : 'F';        // 该槽位期望的性别
    const myGen = person?.gen;
    const spouseIds = new Set(person ? (index.spouseOf.get(person.id) || []) : []);
    const isParentInTree = (p) => (index.kidsOf.get(p.id)?.length || 0) > 0;
    // ⚠️ 性别过滤已搬到 core/parentFilter.js（以前这里只当排序权重用，
    //    候选列表里男女全在，只把对的排前面 —— 用户报「男的出现在母亲选项里」）。
    const isMyKid = (p) => !!person && isDescendant(index, person.id, p.id);
    // exclude 传进来的正是「另一侧已选的父母」，它的配偶就是本槽位最可能的人选
    const otherSpouses = new Set(exclude ? (index.spouseOf.get(exclude) || []) : []);
    const isOtherSpouse = (p) => (otherSpouses.has(p.id) ? 0 : 1);
    const base = people.filter((p) =>
      p.id !== person?.id && p.id !== exclude && !spouseIds.has(p.id) && !isMyKid(p));
    /* ⚠️ 辈分过滤（上下界）搬到 `core/parentFilter.js` 了 —— 这段逻辑改错过两次
     （20-10-09 补下界、20-10-11 补上界），而 UI 层没有测试覆盖，
     所以抽成纯函数并在 tests/run.js 里钉死。这里只管排序。 */
    const gens = filterParentCandidates(base, myGen, selected, wantSex);
    const distOf = (p) => (myGen == null ? 0 : Math.abs((p.gen ?? myGen + 1) - (myGen + 1)));
    gens.sort((a, b) => {
      const da = distOf(a), db = distOf(b);
      if (da !== db) return da - db;                  // 越接近父母那一辈越靠前
      const la = isOtherSpouse(a), lb = isOtherSpouse(b);
      if (la !== lb) return la - lb;                  // 另一侧父母的配偶优先
      const pa = isParentInTree(a) ? 0 : 1, pb = isParentInTree(b) ? 0 : 1;
      if (pa !== pb) return pa - pb;                  // 树上已是父母优先
      const ga = a.gen ?? 999, gb = b.gen ?? 999;
      if (ga !== gb) return ga - gb;
      return (a.order ?? 99) - (b.order ?? 99);
    });
    const optionHtml = (p) => {
      const call = callOf(p);
      return `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>
        ${esc(displayName(p))}${call ? `（${esc(call)}）` : ''}${p.sex ? `·${p.sex === 'M' ? '男' : '女'}` : ''}
      </option>`;
    };
    const head = `<option value="">未填写</option>`;
    const flat = () => head + gens.map(optionHtml).join('');

    /* ⚠️ 2026-10-11 用户报：「给妻子那边的孩子设父母时，我太奶奶和妻子她太奶奶
       在下拉里字面一模一样（全叫「未知（太奶奶）·女」），选错了 → 四个人的
       排行全乱成「大爷爷 / 三爷爷 / 六姑婆」」。
       光靠名字和称呼分不开：无名的人 `displayName` 一律回「未知」，而血亲对血亲
       的称谓天然对称（我的太奶奶和妻子的太奶奶都叫「太奶奶」）。
       **唯一能把两人区分开的是「他属于哪边的家族」** —— 由站在谱主视角的
       路径首符号决定（F/M→本家，W/H→配偶那边）。
       所以候选按这个切成 <optgroup>，组内顺序沿用上面那套权重不动。
       没有谱主视角时（新建成员还没定视角）判不出分支，退回平铺，
       免得整屏都是「其他待定」；只剩一组时同理，不画只有一条的分组线。 */
    if (!viewpoint) return flat();
    const { grouped, groups } = splitParentCandidates(
      gens, (p) => branchOfSymbols(kinOf(p)?.symbols));
    if (!grouped) return flat();

    return head + groups.map((g) =>
      `<optgroup label="${esc(`${g.label} · ${g.items.length} 人`)}">`
      + g.items.map(optionHtml).join('') + '</optgroup>'
    ).join('');
  };
  const initOrder = person?.order != null ? person.order : '';
  const initPrivacy = person?.privacy || 'family';

  return `
  <div class="modal" role="dialog" aria-modal="true" aria-label="${isEdit ? '编辑成员' : '添加成员'}">
    <form>
      <div class="modal-head">
        <div>
          <div class="modal-title">${isEdit ? '编辑成员' : '添加成员'}</div>
          <div class="modal-sub">${esc(subtitle || '只填事实，称呼自动算 —— 不需要填「该叫他什么」')}</div>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" data-act="close" aria-label="关闭">${ICON.x}</button>
      </div>

      <div class="modal-body">
        <div class="form-block">
          <div class="form-block-title"><span class="num">1</span>基本信息</div>

          <div class="form-row">
            <div class="form-item">
              <label class="form-label" for="f-name">姓名 <span class="hint">可不填（留空标记为「待补」）</span></label>
              <input class="input" id="f-name" name="name" autocomplete="off"
                     value="${esc(person?.name || '')}" placeholder="如：林志远">
            </div>
            <div class="form-item" style="flex:0 0 180px">
              <label class="form-label">性别 <span class="hint">可不填（如婴儿暂未确认）</span></label>
              <div class="segmented">
                <button type="button" data-sex="M">男</button>
                <button type="button" data-sex="F">女</button>
              </div>
            </div>
          </div>

          <div class="form-row">
            <div class="form-item">
              <label class="form-label" for="f-birth">
                出生
                <span class="hint">1985 或 1985-06 或 1985-06-12</span>
              </label>
              <input class="input" id="f-birth" name="birth" autocomplete="off"
                     value="${esc(person?.birth || '')}" placeholder="1985">
            </div>
            <div class="form-item">
              <label class="form-label" for="f-place">所在地</label>
              <input class="input" id="f-place" name="place" autocomplete="off"
                     value="${esc(person?.place || '')}" placeholder="河南南阳">
            </div>
          </div>

          <div class="form-row">
            <div class="form-item">
              <label class="form-label">在世情况</label>
              <div class="switch" id="f-alive" role="switch" tabindex="0">
                <span class="switch-track"><span class="switch-thumb"></span></span>
                <span class="switch-text" id="f-alive-text">已故（点击切换为在世）</span>
              </div>
            </div>
            <div class="form-item" id="row-death">
              <label class="form-label" for="f-death">去世年份</label>
              <input class="input" id="f-death" name="death" autocomplete="off"
                     value="${esc(person?.death || '')}" placeholder="2015">
            </div>
          </div>
        </div>

        <div class="form-block">
          <div class="form-block-title"><span class="num">2</span>亲属关系 <span class="hint" style="font-weight:400;color:var(--ink-400)">填了这里，称呼就自动出来了</span></div>

          <div class="muted" style="font-size:12px;margin:-4px 0 10px">
            配偶、子女请回到详情面板点「添加亲属」来添加 —— 那边是以参照人为中心添加，不会弄错辈分。
          </div>

          <div class="form-row">
            ${parentField('father', lockFather, preFather)}
            ${parentField('mother', lockMother, preMother)}
          </div>

          <div class="form-row">
            <div class="form-item">
              <label class="form-label" for="f-order">排行 <span class="hint">0 = 长子女</span></label>
              <!-- type=text + inputmode=numeric，而不是 type=number：
                   Windows 上 number 框会禁用输入法，切到中文输入法后打不出数字，
                   用户会以为「这个框改不动」。这里只放行数字字符，语义不变。 -->
              <input class="input" id="f-order" name="order" type="text" inputmode="numeric"
                     pattern="[0-9]*" autocomplete="off"
                     value="${initOrder}" placeholder="留空表示未知">
            </div>
            <div class="form-item">
              <label class="form-label" for="f-privacy">隐私级别</label>
              <select class="select" id="f-privacy" name="privacy">
                ${Object.entries(PRIVACY).map(([k, v]) =>
                  `<option value="${k}" ${k === initPrivacy ? 'selected' : ''}>${v} —— ${PRIVACY_HINT[k]}</option>`
                ).join('')}
              </select>
            </div>
          </div>
        </div>

        <div class="form-block">
          <div class="form-block-title"><span class="num">3</span>备注</div>
          <div class="form-row">
            <div class="form-item full">
              <label class="form-label" for="f-callOverride">自定义称呼 <span class="hint">${esc(vpName)} 视角下优先显示</span></label>
              <input class="input" id="f-callOverride" name="callOverride" type="text" autocomplete="off"
                     value="${esc(initCall)}" placeholder="留空=按规则自动算；填了只对这个视角生效">
            </div>
          </div>
          <div class="form-row">
            <div class="form-item full">
              <textarea class="input" id="f-note" name="note" rows="3"
                        style="height:auto;padding:10px 12px;line-height:1.6"
                        placeholder="职业、籍贯、值得记下来的事…">${esc(person?.note || '')}</textarea>
            </div>
          </div>
          <div class="err-msg" id="form-err" style="display:none"></div>
        </div>
      </div>

      <div class="modal-foot">
        ${isEdit ? `<button type="button" class="btn btn-danger danger-zone" data-act="delete">${ICON.trash} 删除此人</button>` : ''}
        <button type="button" class="btn" data-act="cancel">取消</button>
        <button type="submit" class="btn btn-primary">${ICON.save} ${isEdit ? '保存修改' : '添加'}</button>
      </div>
    </form>
  </div>`;
}

/* ========================================================= */
/* 校验                                                        */
/* ========================================================= */

function validate(form, sex, { person, index, dataset }) {
  // ⚠️ 姓名 / 性别允许留空：留空即「待补信息」，不阻断录入。
  //    想填的时候随时回来补，体检清单会提醒你哪些人还没补全。

  const father = val(form, 'father');
  const mother = val(form, 'mother');
  if (father && mother && father === mother) return '父亲和母亲不能是同一个人';

  // 性别校验：父亲不能是女性，母亲不能是男性；性别未知（未填）两者皆可。
  const fSex = father ? index.byId.get(father)?.sex : '';
  const mSex = mother ? index.byId.get(mother)?.sex : '';
  if (fSex === 'F') return '所选「父亲」的性别为女，父亲不能是女性，请重新选择';
  if (mSex === 'M') return '所选「母亲」的性别为男，母亲不能是男性，请重新选择';

  const selfId = person?.id;
  if (selfId) {
    // 不能把自己设为自己的父母
    if (father === selfId || mother === selfId) return '不能把自己设为自己的父母';
    // 不能让后代当自己的父母（成环）
    for (const pid of [father, mother]) {
      if (pid && isDescendant(index, selfId, pid)) {
        return '这条关系会形成循环：TA 是你的后代，不能同时又当你的长辈';
      }
    }
  }

  // 出生年与父母出生年的粗校验
  const b = Number((val(form, 'birth').match(/^(\d{4})/) || [])[1]);
  if (b) {
    for (const pid of [father, mother]) {
      const pb = Number(((index.byId.get(pid)?.birth || '').match(/^(\d{4})/) || [])[1]);
      if (pb && b <= pb) {
        return `出生年（${b}）不该早于或等于其长辈的出生年（${pb}），请核对`;
      }
    }
  }
  return null;
}

/** candidateId 是否为 rootId 的后代 */
function isDescendant(index, rootId, candidateId) {
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const cur = queue.shift();
    for (const k of index.kidsOf.get(cur) || []) {
      if (k === candidateId) return true;
      if (!seen.has(k)) { seen.add(k); queue.push(k); }
    }
  }
  return false;
}

function showError(form, msg) {
  const box = form.querySelector('#form-err');
  box.style.display = 'flex';
  box.innerHTML = `${ICON.alert} ${esc(msg)}`;
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ========================================================= */
/* 确认框（替代原生 confirm）                                */
/* --------------------------------------------------------- */
/* ⚠️⚠️ 为什么全项目禁用原生 confirm() / window.confirm（2026-10-10）：
 *
 *   Electron 渲染层弹出的**原生模态框**，关闭之后 Windows 的键盘输入链路
 *   不会干净地交还给渲染进程。实测结论（真 Electron + user32.keybd_event
 *   系统级物理按键注入，不是程序注入）：
 *
 *     · 确认框点「确定」之后，弹窗正常、焦点正常落在输入框、遮罩正常；
 *     · insertText 这类**程序注入有效**，但**真实物理按键全部失效**；
 *     · 键盘失效会一直持续下去，直到应用重启。
 *
 *   表现就是用户报的：「删除人员后无法继续编辑操作，输入框无法输入，
 *   内容也无法删除」。而且它不限于删除 —— 凡是弹过原生确认框之后，
 *   整个应用的键盘输入就废了。
 *
 *   所以删除、清空全部数据、导入数据这三处一律改用本组件。
 *   顺带的好处：样式和中文文案跟应用完全统一，不再弹出 Windows 原生灰框。
 *
 * 它是**叠在当前弹窗之上**的一层（不覆盖 overlay.innerHTML），
 * 所以「在编辑弹窗里问要不要删人」这种嵌套流程能正常工作。
 *
 * 【返回值】true = 确定，false = 取消/关闭。
 *   传了 altText 时，点第三个按钮返回字符串 'alt' ——
 *   用它做「次要出口」（如导入时的「覆盖当前谱」）：
 *   现有 `if (!ok) return` 的调用点不受影响（truthy/falsy 语义没动）。
 * ========================================================= */
export function confirmOverlay(opts = {}) {
  const {
    title = '请确认',
    message = '',
    confirmText = '确定',
    cancelText = '取消',
    altText = '',
    danger = false,
  } = opts;

  const overlay = document.getElementById('overlay');
  // 下层弹窗 close() 排的 220ms 清空定时器会把确认框一起抹掉，这里先取消
  clearTimeout(overlay._clearTimer);
  overlay._clearTimer = null;
  const prevFocus = document.activeElement;

  const layer = document.createElement('div');
  layer.className = 'confirm-layer';
  layer.innerHTML = `
    <div class="modal modal-sm" role="alertdialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head">
        <div class="modal-title">${esc(title)}</div>
      </div>
      <div class="modal-body">
        <p class="confirm-text">${esc(message)}</p>
      </div>
      <div class="modal-foot">
        ${altText ? `<button type="button" class="btn btn-ghost" data-cf="2">${esc(altText)}</button>` : ''}
        <button type="button" class="btn" data-cf="0">${esc(cancelText)}</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-cf="1">${esc(confirmText)}</button>
      </div>
    </div>`;
  overlay.appendChild(layer);
  overlay.classList.add('on');

  const btns = [...layer.querySelectorAll('[data-cf]')];

  return new Promise((resolve) => {
    let done = false;
    // ⚠️ 这个定时器必须在 finish 里取消掉：
    //   否则「用户 0ms 内就按了 Esc / 点了取消」时，它会在弹层已经
    //   remove() 之后才跑，去 focus 一个**已脱离文档**的按钮 ——
    //   Chromium 找不到可聚焦的渲染框，就把焦点甩到 <body>，
    //   用户正准备接着改的那一框直接失去焦点（实测焦点 = BODY）。
    const focusTimer = setTimeout(() => {
      if (layer.isConnected) btns[btns.length - 1].focus();
    }, 0);

    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKey, true);
      layer.remove();
      /* ⚠️⚠️ `.on` 是本函��在 658 行自己加的，就必须自己摘 ——
         全项目只有 confirmOverlay 曾经「加了不摘」。后果不是报错、不是白屏，
         而是那个铺满全屏、`pointer-events: auto` 的**空**遮罩留在原地：
         界面看起来一切正常，鼠标却点不动任何东西 —— 用户报的是「删除族谱后卡住」。

         为什么以前一直没暴露：confirmOverlay 大多数时候是**叠在别的弹窗之上**
         （下层弹窗的 close() 会顺手摘掉 `.on`）。而「删除本谱」这条流程里，
         它是整个交互里唯一碰过 `#overlay` 的弹窗 —— 没人替它收尾，
         遮罩就这么留下来了。这也解释了为什么 book-flow 那套测试测不出来：
         它压根没断言过 overlay 状态。

         ⚠️ 不能无脑 `remove('on')`：叠在别人上面时 `.on` 归下层管，
         提前摘掉会让下层弹窗失去遮罩（用户能点到背后的画布）。
         所以判据是「摘掉自己之后，overlay 里还有没有别人」。 */
      if (!overlay.firstElementChild) overlay.classList.remove('on');
      // 焦点还回下层弹窗，用户可以接着改
      if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') prevFocus.focus();
      resolve(val);
    };
    function onKey(e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
      else if (e.key === 'Tab') {
        // 焦点圈在确认框里，别 Tab 跑到下层弹窗去改东西
        const i = btns.indexOf(document.activeElement);
        if (i >= 0) {
          e.preventDefault();
          btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
        }
      }
    }
    // 捕获阶段：必须抢在下层编辑弹窗自己的 Esc 处理（冒泡）之前
    document.addEventListener('keydown', onKey, true);
    btns.forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.cf;
      finish(v === '1' ? true : v === '2' ? 'alt' : false);
    }));
    layer.addEventListener('mousedown', (e) => { if (e.target === layer) finish(false); });
  });
}

/* ========================================================= */
/* 新建族谱（v0.2.24）                                         */
/* --------------------------------------------------------- */
/* 不用原生 prompt —— 除了 confirmOverlay 注释里说的那个「原生模态框
   会让整个应用的真实键盘输入失效」的原因，prompt() 也画不出下面的选项卡片。
   ========================================================= */

/**
 * 问两件事：这张谱叫什么、从什么内容起步。
 *
 * @param {object} opts
 * @param {string} [opts.defaultName] 输入框里的初始名字
 * @param {string[]} [opts.taken] 已占用的谱名（用于重名提示）
 * @param {object} [opts.sample] 示例数据集；给了才会出现「用示例家族起步」选项
 * @param {boolean} [opts.askSeed=true] false 时只问名字（重命名要的就是这个）
 * @param {string} [opts.submitText] 主按钮文案
 * @returns {Promise<{name:string, seed:'empty'|'sample'}|null>} null = 取消
 */
export function newBookDialog({
  defaultName = '', taken = [], sample = null, askSeed = true, submitText = '新建并切换',
} = {}) {
  const overlay = document.getElementById('overlay');
  clearTimeout(overlay._clearTimer);
  overlay._clearTimer = null;
  overlay.onclick = null;

  const takenSet = new Set(taken.map((n) => String(n).trim().toLowerCase()));

  overlay.innerHTML = `
    <div class="modal modal-sm" role="dialog" aria-modal="true" aria-label="新建族谱">
      <div class="modal-head">
        <div>
          <div class="modal-title">新建一本族谱</div>
          <div class="modal-sub">每本谱各自独立存放、互不影响，随时可以切回来</div>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" data-book="close" aria-label="关闭">${ICON.x}</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-item full">
            <label class="form-label" for="bk-name">谱名</label>
            <input class="input" id="bk-name" autocomplete="off" maxlength="40"
                   value="${esc(defaultName)}" placeholder="如：张氏族谱（南召支）">
            <div class="err-msg" id="bk-err" style="display:none"></div>
          </div>
        </div>

        ${askSeed ? `
        <div class="form-block-title" style="margin-top:14px">
          <span class="num">2</span>从什么内容起步
        </div>
        <div class="rel-picker" style="grid-template-columns:${sample ? '1fr 1fr' : '1fr'}">
          <button type="button" class="rel-pick on" data-seed="empty">
            <b>空白谱</b>
            <em>从零开始录自己的家人</em>
          </button>
          ${sample ? `
          <button type="button" class="rel-pick" data-seed="sample">
            <b>示例家族起步</b>
            <em>先拿 ${sample.people.length} 人样例熟悉操作，再改成自己的</em>
          </button>` : ''}
        </div>` : ''}
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" data-book="cancel">取消</button>
        <button type="button" class="btn btn-primary" data-book="ok">${ICON.save} ${esc(submitText)}</button>
      </div>
    </div>`;
  overlay.classList.add('on');

  let seed = 'empty';
  let done = () => {};        // Promise 的 resolve，下面各条出口统一调它
  const input = overlay.querySelector('#bk-name');
  const errBox = overlay.querySelector('#bk-err');

  /* ⚠️ 和性别按钮同一个坑：点击这些卡片会把焦点从输入框抢走，
     而 app.js 的全局快捷键守卫只认 input/textarea/select ——
     焦点一落到 body，接着按的每个键都会命中快捷键。 */
  overlay.querySelectorAll('[data-seed]').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      seed = b.dataset.seed;
      overlay.querySelectorAll('[data-seed]').forEach((x) => x.classList.toggle('on', x === b));
    });
  });

  const close = () => {
    overlay.classList.remove('on');
    overlay.onclick = null;
    document.removeEventListener('keydown', onKey);
    overlay._clearTimer = setTimeout(() => {
      overlay.innerHTML = '';
      overlay._clearTimer = null;
    }, 220);
  };

  function submit() {
    const name = String(input.value || '').trim();
    if (!name) return showBookErr('给这本谱起个名字吧');
    if (takenSet.has(name.toLowerCase())) return showBookErr(`已经有一本叫「${name}」的谱了，换一个`);
    close();
    done({ name, seed });
  }

  function showBookErr(msg) {
    errBox.style.display = 'flex';
    errBox.innerHTML = `${ICON.alert} ${esc(msg)}`;
    input.focus();
  }

  function onKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); done(null); }
    if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); submit(); }
  }
  document.addEventListener('keydown', onKey);

  overlay.querySelector('[data-book="ok"]').addEventListener('click', submit);
  overlay.querySelector('[data-book="cancel"]').addEventListener('click', () => { close(); done(null); });
  overlay.querySelector('[data-book="close"]').addEventListener('click', () => { close(); done(null); });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) { close(); done(null); } });

  setTimeout(() => { input.focus(); input.select(); }, 60);

  return new Promise((resolve) => { done = resolve; });
}

/* =========================================================
   导出范围选择（v0.2.45）
   ---------------------------------------------------------
   【为什么不直接跟着当前页签导出】
   导出在本项目里是**唯一的备份途径** —— 清空数据、删谱的提示都让用户
   「先导出留一份」。如果导出范围由「现在停在哪个家族页签」决定，那么
   哪天顺手停在「母亲家族」上按了 Ctrl+S，导出的备份就是一份残谱，
   而且**不可逆**。备份不能有这种随机性。
   所以改成每次导出都问一句：全谱，还是只当前家族。

   【为什么不用 confirmOverlay 的 altText 凑合】
   这是隐私取舍，两个选项的后果差别很大（谁会出现在文件里），
   必须把人数和「排除了谁」都摆在眼前，不能只靠两个按钮的字面意思。
   ========================================================= */

/**
 * 问「导全谱」还是「只导当前家族」。
 *
 * @param {object} opts
 * @param {number} opts.totalCount 全谱人数
 * @param {number} opts.relCount 全谱关系条数
 * @param {string} opts.treeLabel 当前页签的家族名（如「张三的家族」）
 * @param {number} opts.treeCount 当前家族人数
 * @param {number} [opts.treeRelCount] 当前家族关系条数
 * @param {string[]} [opts.omitted] 没被包含的家族名（用来讲清楚排除了谁）
 * @returns {Promise<'all'|'tree'|null>} null = 取消
 */
export function exportScopeDialog({
  totalCount = 0, relCount = 0,
  treeLabel = '', treeCount = 0, treeRelCount = 0,
  omitted = [],
} = {}) {
  const overlay = document.getElementById('overlay');
  clearTimeout(overlay._clearTimer);
  overlay._clearTimer = null;
  overlay.onclick = null;

  /* 当前家族就是全谱时（只有自己这一支、没录任何姻亲），
     两个选项导出的东西一模一样 —— 与其让用户白选一次，不如明说。 */
  const treeDesc = treeCount >= totalCount
    ? '与「全部成员」内容相同'
    : (omitted.length ? `不含 ${omitted.join('、')}` : '只含当前这一页的人');

  overlay.innerHTML = `
    <div class="modal modal-sm" role="dialog" aria-modal="true" aria-label="导出范围">
      <div class="modal-head">
        <div>
          <div class="modal-title">导出哪些人？</div>
          <div class="modal-sub">导出的是 JSON 底稿，把文件给别人看就等于把这些人给他看</div>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" data-scope="close" aria-label="关闭">${ICON.x}</button>
      </div>
      <div class="modal-body">
        <div class="rel-picker">
          <button type="button" class="rel-pick on" data-pick="all">
            <b>全部成员</b>
            <em>${totalCount} 人 · ${relCount} 条关系</em>
            <em>用作备份，换电脑 / 重装系统靠它</em>
          </button>
          <button type="button" class="rel-pick" data-pick="tree">
            <b>只导当前家族</b>
            <em>${esc(treeLabel || '当前家族')} · ${treeCount} 人 · ${treeRelCount} 条关系</em>
            <em>${esc(treeDesc)}</em>
          </button>
        </div>
        <p class="confirm-text" style="margin-top:var(--sp-3)">只导当前家族 = 只导这一页上的人：含配偶<b>本人</b>（夫妻关系断了谱就不成立），但<b>不含</b>配偶的父母、兄弟姐妹。</p>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" data-scope="cancel">取消</button>
        <button type="button" class="btn btn-primary" data-scope="ok">${ICON.save} 导出</button>
      </div>
    </div>`;
  overlay.classList.add('on');

  let scope = 'all';
  let done = () => {};

  /* ⚠️ 和 newBookDialog 同一个坑：点卡片会把焦点抢走，而 app.js 的全局
     快捷键守卫只认 input/textarea/select —— 焦点一落到 body，紧接着按的
     键就都会命中快捷键。所以先吃掉卡片上的 mousedown。 */
  overlay.querySelectorAll('[data-pick]').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      scope = b.dataset.pick;
      overlay.querySelectorAll('[data-pick]').forEach((x) => x.classList.toggle('on', x === b));
    });
  });

  const close = () => {
    overlay.classList.remove('on');
    overlay.onclick = null;
    document.removeEventListener('keydown', onKey);
    overlay._clearTimer = setTimeout(() => {
      overlay.innerHTML = '';
      overlay._clearTimer = null;
    }, 220);
  };

  function onKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); done(null); }
    /* Enter 走当前选中的那一项：Tab 到卡片上按回车时焦点不在页脚按钮上，
       别让回车什么都不发生。 */
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      close(); done(scope);
    }
  }
  document.addEventListener('keydown', onKey);

  overlay.querySelector('[data-scope="ok"]').addEventListener('click', () => { close(); done(scope); });
  overlay.querySelector('[data-scope="cancel"]').addEventListener('click', () => { close(); done(null); });
  overlay.querySelector('[data-scope="close"]').addEventListener('click', () => { close(); done(null); });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) { close(); done(null); } });

  return new Promise((resolve) => { done = resolve; });
}

/**
 * 导出图片前的确认弹窗。
 *
 * 【为什么单独问一次，而不是点一下直接导出】
 *   JSON 底稿是给自己留的备份，图片是**给别人看**的 —— 上面有每个人的
 *   姓名、生卒年月和婚配关系（**不显示称呼**，见 tree.js mountExportSnapshot）。
 *   两者性质不同，所以入口分开
 *   （备份走 Ctrl+S / 「导出数据」，图片走「导出图片」）。
 *   这里再把「图上有谁」讲清楚，才对得起这份取舍。
 *
 * 清晰度只给两档：1x 是屏幕原尺寸（够发微信），2x 够打印。
 * 再往上对一张几千像素宽的谱树没有意义，只会把等待时间拉长。
 *
 * @param {object} opts
 * @param {string} opts.treeLabel   当前这一页的家族名
 * @param {number} opts.treeCount   当前这一页的人数
 * @param {Object<number,object>} opts.plans  各档位对应的 imagePlan 结果
 * @returns {Promise<number|null>} 选中的清晰度；null = 取消
 */
export function exportImageDialog({ treeLabel = '', treeCount = 0, plans = {} } = {}) {
  const overlay = document.getElementById('overlay');
  clearTimeout(overlay._clearTimer);
  overlay._clearTimer = null;
  overlay.onclick = null;

  const size = (p) => (p?.ok ? `${p.pixelWidth} × ${p.pixelHeight} 像素` : '—');
  const p2 = plans[2];

  overlay.innerHTML = `
    <div class="modal modal-sm" role="dialog" aria-modal="true" aria-label="导出图片">
      <div class="modal-head">
        <div>
          <div class="modal-title">导出这一页为图片</div>
          <div class="modal-sub">只导当前这一页：${esc(treeLabel || '当前家族')} · ${treeCount} 人</div>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" data-img="close" aria-label="关闭">${ICON.x}</button>
      </div>
      <div class="modal-body">
        <p class="confirm-text">图上有每个人的<b>姓名、生卒年月</b>和<b>婚配关系</b>，不显示称呼。发给别人，就等于把这些人摊给他看。</p>
        <div class="rel-picker">
          <button type="button" class="rel-pick on" data-q="1">
            <b>标准清晰度</b>
            <em>${size(plans[1])}</em>
            <em>快，文件小，微信里直接看</em>
          </button>
          <button type="button" class="rel-pick" data-q="2">
            <b>高清（2 倍）</b>
            <em>${size(plans[2])}</em>
            <em>打印或放大看更清楚，人多时要等几秒</em>
          </button>
        </div>
        <p class="confirm-text" style="margin-top:var(--sp-3)">${p2?.clamped
          ? esc(p2.note)
          : '别的家族不会出现在这张图上 —— 换页签再导一次，就是另一张。'}</p>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" data-img="cancel">取消</button>
        <button type="button" class="btn btn-primary" data-img="ok">${ICON.image} 导出 PNG</button>
      </div>
    </div>`;
  overlay.classList.add('on');

  let q = 1;
  let done = () => {};

  /* 与 exportScopeDialog 同一个坑：点卡片会把焦点抢走，而 app.js 的全局
     快捷键守卫只认 input/textarea/select。先吃掉卡片上的 mousedown。 */
  overlay.querySelectorAll('[data-q]').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      q = Number(b.dataset.q);
      overlay.querySelectorAll('[data-q]').forEach((x) => x.classList.toggle('on', x === b));
    });
  });

  const close = () => {
    overlay.classList.remove('on');
    overlay.onclick = null;
    document.removeEventListener('keydown', onKey);
    overlay._clearTimer = setTimeout(() => {
      overlay.innerHTML = '';
      overlay._clearTimer = null;
    }, 220);
  };

  function onKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); done(null); }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(); done(q); }
  }
  document.addEventListener('keydown', onKey);

  overlay.querySelector('[data-img="ok"]').addEventListener('click', () => { close(); done(q); });
  overlay.querySelector('[data-img="cancel"]').addEventListener('click', () => { close(); done(null); });
  overlay.querySelector('[data-img="close"]').addEventListener('click', () => { close(); done(null); });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) { close(); done(null); } });

  return new Promise((resolve) => { done = resolve; });
}

/* ========================================================= */
/* 小工具                                                      */
/* ========================================================= */

const val = (form, name) => {
  const el = form.querySelector(`[name="${name}"]`);
  return el ? String(el.value || '') : '';
};

function fatherOf(index, id) {
  for (const pid of index.parentsOf.get(id) || []) {
    if (index.byId.get(pid)?.sex === 'M') return pid;
  }
  return '';
}
function motherOf(index, id) {
  for (const pid of index.parentsOf.get(id) || []) {
    if (index.byId.get(pid)?.sex === 'F') return pid;
  }
  return '';
}
