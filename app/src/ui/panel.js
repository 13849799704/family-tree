/**
 * =========================================================
 * 详情面板 · ui/panel.js
 * ---------------------------------------------------------
 * 这是产品的「灵魂视图」：用户点一个人，要一眼看懂
 *   「他是我什么人」——不只是三个字，还要能看见为什么。
 *
 * 三级显示（PRD §4.4）：
 *   ① 本地叫法   大字，最显眼 —— 张嘴就能喊出口的那个
 *   ② 标准称呼   小字，正式场合 / 写请柬用
 *   ③ 关系描述   关系链 —— 从「我」一步步走到他
 *
 * 另附推导依据（辈分差 / 分叉方向 / 性别），
 * 让用户能验证结果而不是盲信 —— PRD §10 明确要求「不猜」，
 * 不猜的前提是把推理过程亮出来。
 * =========================================================
 */

import { ICON } from './icons.js';
import { describePath } from '../core/rules.js';
import { displayLabel } from '../core/kinship.js';
import { PRIVACY, GEN_LABEL, birthYear, displayName, avatarGlyph, missingFields } from '../core/model.js';

const BRANCH_CLASS = {
  direct: 'paternal',
  paternal: 'paternal',
  maternal: 'maternal',
  affinal: 'affinal',
};

const BRANCH_TEXT = {
  direct: '直系血缘',
  paternal: '父系血缘',
  maternal: '母系血缘',
  affinal: '姻亲',
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 非必填项的空位占位：只有一个破折号，不做任何「你该补」的表情 */
const DASH = '<span class="muted">—</span>';

/** 年份区间：1936–2015 / 1963– */
function lifeSpan(p) {
  const b = p.birth ? String(p.birth).slice(0, 4) : '';
  const d = p.death ? String(p.death).slice(0, 4) : '';
  if (!b && !d) return '';
  if (p.alive === false) return `${b || '?'}–${d || '?'}`;
  return `${b}–`;
}

/* ========================================================= */
/* 主入口                                                      */
/* ========================================================= */

/**
 * @param {HTMLElement} el 面板容器
 * @param {object} ctx
 * @param {object} ctx.person
 * @param {object} ctx.kin        deriveKinship 结果
 * @param {object} ctx.index      buildIndex 产物
 * @param {Map}    ctx.kinship
 * @param {string} ctx.viewpoint
 * @param {object|null} ctx.expandable  该人可展开的原生家族
 * @param {boolean} ctx.isOpen    该家族当前是否已展开
 * @param {boolean} [ctx.showCall=true] 「只显示姓名」关掉时为 false：
 *        顶部大字换成姓名，并隐藏标准称呼 / 推导路径 / 称谓推导整块，
 *        「亲属关系」各行也不再带称谓前缀（认人线索必须留着，所以下拉里照旧显示）
 */
export function renderPanel(el, ctx) {
  const { person: p, kin, index, kinship, viewpoint, expandable, isOpen, showCall = true } = ctx;
  if (!p) {
    el.innerHTML = emptyState();
    return;
  }

  const cls = BRANCH_CLASS[kin?.branch] || 'paternal';
  const isSelf = p.id === viewpoint;
  const unknown = !kin || !kin.ok;
  const hasOverride = !!(p.callOverride && p.callOverride[viewpoint]);

  const callMain = displayLabel(p, kin, viewpoint, showCall);
  const callStd = isSelf ? '本人' : (kin?.std || '');
  /* 姓名模式下大字位写的是姓名，不能再挂「unknown」样式（那是给待确认的称谓用的） */
  const mainCls = !showCall ? 'call-main call-main-name'
    : (unknown && !isSelf && !hasOverride ? 'call-main unknown' : 'call-main');

  el.innerHTML = `
    <div class="panel-head">
      <div class="panel-head-top">
        <div class="panel-avatar" style="border-color:var(--${cls});color:var(--${cls});background:var(--${cls}-bg)">
          ${p.avatar ? `<img src="${esc(p.avatar)}" alt="">` : esc(avatarGlyph(p))}
        </div>
        <div class="panel-id">
          <div class="${mainCls}">${esc(callMain)}</div>
          ${showCall && callStd ? `<div class="call-std">标准称呼：<b>${esc(callStd)}</b></div>` : ''}
          <div class="name-line">${showCall ? esc(displayName(p)) : ''}${lifeSpan(p) ? ` <span class="muted">${lifeSpan(p)}</span>` : ''}</div>
        </div>
      </div>
      <div class="chips">
        <span class="chip chip-${p.alive === false ? 'deceased' : cls}">
          ${p.alive === false ? '已故' : BRANCH_TEXT[kin?.branch] || '亲属'}
        </span>
        ${p.alive !== false ? '<span class="chip chip-alive">在世</span>' : ''}
        ${p.sex ? `<span class="chip chip-privacy">${p.sex === 'M' ? '男' : '女'}</span>` : ''}
        ${p.gen != null ? `<span class="chip chip-privacy">${GEN_LABEL[p.gen] || '第 ' + p.gen + ' 代'}</span>` : ''}
        ${missingFields(p).length ? '<span class="chip chip-todo">信息待补</span>' : ''}
        <span class="chip chip-privacy">${PRIVACY[p.privacy] || '家族内部'}</span>
      </div>
      ${showCall && !isSelf && kin?.symbols?.length
        ? `<div class="call-path" title="称谓推导路径">路径 ${kin.symbols.join('·')}　→　${esc(describePath(kin.symbols))}</div>`
        : ''}
    </div>

    <!-- 视角入口：切换视角的语义是「整棵树以 TA 为基准」，属于面板级操作，
         所以放在称谓区正下方，而不是混进底部的编辑/添加亲属。 -->
    ${isSelf
      ? `<div class="vp-cur">${ICON.users}<span>TA 就是你当前的视角</span></div>`
      : `<button class="reveal vp-set" data-act="switch-vp" data-id="${esc(p.id)}"
                 title="整棵树的称谓都会改成以 TA 为基准重新推导">
           ${ICON.users}<span>设为我的视角</span>
         </button>`}

    ${expandable ? `
      <button class="reveal" data-act="toggle-family" data-anchor="${esc(p.id)}" data-key="${esc(expandable.key)}">
        ${ICON.target}
        ${isOpen ? '收起 TA 的原生家族' : `展开 TA 的原生家族（${expandable.size} 人）`}
      </button>` : ''}

    <div class="panel-body">
      ${sectionBasic(p, index)}
      ${sectionKin(p, index, kinship, showCall)}
      ${showCall ? sectionDerive(p, kin, isSelf, unknown) : ''}
      ${sectionPhotos(p)}
    </div>

    <div class="panel-foot">
      <button class="btn" data-act="edit" data-id="${esc(p.id)}">${ICON.edit} 编辑</button>
      <button class="btn btn-primary" data-act="add-relative" data-id="${esc(p.id)}">${ICON.plus} 添加亲属</button>
    </div>`;
}

/* ========================================================= */
/* 各区块                                                      */
/* ========================================================= */

function sectionBasic(p) {
  // 只有「姓名 / 性别」是识别一个人的必需条件，缺了才给可点的补充入口；
  // 出生 / 所在地 / 排行 / 备注都不是必填，空着属常态 —— 只留一个破折号，
  // 不再摆「＋ 补充××」去暗示「你少填了」（用户 2026-10-09 要求）。
  const rows = [
    ['性别', p.sex ? (p.sex === 'M' ? '男' : '女') : fillBtn(p.id, 'sex', '补充性别')],
    ['出生', p.birth ? esc(p.birth) : DASH],
    ['所在地', p.place ? esc(p.place) : DASH],
    ['排行', p.order != null ? `第 ${p.order + 1}` : DASH],
    ['备注', p.note ? esc(p.note) : DASH],
  ];

  return `
    <div class="sec-title">基本资料</div>
    ${rows.map(([k, v]) => `
      <div class="field"><span class="k">${k}</span><span class="v">${v}</span></div>
    `).join('')}`;
}

function sectionKin(p, index, kinship, showCall = true) {
  const link = (id) => {
    const o = index.byId.get(id);
    if (!o) return '';
    /* 姓名模式下不挂称谓前缀 —— 这一列是「谁是谁」，多一个称呼反而挤在一起看不清 */
    const k = showCall ? kinship.get(id) : null;
    const call = k && k.ok ? k.dialect : '';
    return `<a data-jump="${esc(id)}">${esc(call ? call + ' ' : '')}${esc(displayName(o))}</a>`;
  };
  const linkList = (ids) => ids.length ? ids.map(link).join('、') : '';

  const parents = index.parentsOf.get(p.id) || [];
  const father = parents.find((x) => index.byId.get(x)?.sex === 'M');
  const mother = parents.find((x) => index.byId.get(x)?.sex === 'F');
  const spouses = index.spouseOf.get(p.id) || [];
  const kids = index.kidsOf.get(p.id) || [];

  return `
    <div class="sec-title">亲属关系</div>
    <div class="field"><span class="k">父亲</span><span class="v">${father ? link(father) : DASH}</span></div>
    <div class="field"><span class="k">母亲</span><span class="v">${mother ? link(mother) : DASH}</span></div>
    <div class="field"><span class="k">配偶</span><span class="v">${spouses.length ? linkList(spouses) : DASH}</span></div>
    <div class="field"><span class="k">子女</span><span class="v">${kids.length ? linkList(kids) : DASH}</span></div>`;
}

function sectionDerive(p, kin, isSelf, unknown) {
  if (isSelf) {
    return `
      <div class="sec-title">称谓推导</div>
      <div class="rel-chain">
        <div class="rel-chain-row">
          <span class="rel-node me">我</span>
          <span class="rel-arrow">·</span>
          <span class="rel-node target">视角锚点</span>
        </div>
        <div class="rel-basis">
          全树称谓都以本人为基准实时推导，<b>不存储任何称呼</b>。
          点开别人、再点「设为我的视角」，整棵树的叫法就会重算。
        </div>
      </div>`;
  }

  if (unknown) {
    return `
      <div class="sec-title">称谓推导</div>
      <div class="rel-chain">
        <div class="rel-chain-row">
          <span class="rel-node me">我</span>
          <span class="rel-arrow">→</span>
          <span class="rel-node target affinal">关系待确认</span>
        </div>
        <div class="rel-basis">
          <b>不猜。</b>${esc(kin?.reason || '规则表未覆盖这条关系路径')}<br>
          可以在「编辑」里补上 TA 的父母或配偶，补全后称谓会自动算出来。
        </div>
      </div>`;
  }

  const steps = describePath(kin.symbols);
  const genTxt = kin.genDelta > 0 ? `+${kin.genDelta}` : String(kin.genDelta);
  const dir = kin.branch === 'maternal' ? '母系'
    : kin.branch === 'affinal' ? '姻亲'
    : kin.branch === 'direct' ? '直系' : '父系';

  const ageTxt = kin.age === 'older' ? '年长' : kin.age === 'younger' ? '年幼' : null;

  return `
    <div class="sec-title">称谓推导</div>
    <div class="rel-chain">
      <div class="rel-chain-row">
        <span class="rel-node me">我</span>
        <span class="rel-arrow">→</span>
        <span class="rel-node step">${esc(steps)}</span>
        <span class="rel-arrow">→</span>
        <span class="rel-node target ${esc(BRANCH_CLASS[kin.branch] || '')}">${esc(kin.dialect)}</span>
      </div>
      <div class="rel-basis">
        推导依据：辈分差 <b>${genTxt}</b> ·
        分叉方向 <b>${dir}</b> ·
        性别 <b>${p.sex === 'M' ? '男' : p.sex === 'F' ? '女' : '未知'}</b>
        ${ageTxt ? ` · 长幼 <b>${ageTxt}</b>` : ''}
      </div>
      ${kin.ageUncertain
        ? `<div class="rel-basis rel-warn">${ICON.alert}<span>长幼判不出来（排行只在同父母之间有效，缺排行或出生年就判不了），暂按「年长」显示 —— 补齐出生年后会变准。</span></div>`
        : ''}
      ${kin.genMismatch
        ? `<div class="rel-basis rel-warn">${ICON.alert}<span>这条关系算出的辈分（第 ${kin.genDelta} 代）与规则表标注（第 ${kin.ruleGen} 代）不一致，建议核对世次或关系是否填错。</span></div>`
        : ''}
      ${kin.alt?.length
        ? `<div class="rel-basis">其他叫法：${kin.alt.map((a) => `<b>${esc(a)}</b>`).join(' / ')}</div>`
        : ''}
      ${kin.note ? `<div class="rel-basis">${esc(kin.note)}</div>` : ''}
    </div>`;
}

function sectionPhotos(p) {
  const photos = p.photos || [];
  const slots = [0, 1, 2, 3];
  return `
    <div class="sec-title">照片</div>
    <div class="photos">
      ${photos.slice(0, 3).map((src) => `
        <div class="photo"><img src="${esc(src)}" alt=""></div>
      `).join('')}
      ${slots.slice(photos.length, 4).map(() => `<div class="photo empty"></div>`).join('')}
      <button class="photo add" data-act="add-photo" data-id="${esc(p.id)}" title="添加照片（照片保存在本地）">
        ${ICON.image}
      </button>
    </div>`;
}

/* ========================================================= */
/* 空状态                                                      */
/* ========================================================= */

function emptyState() {
  return `
    <div class="panel-empty">
      ${ICON.users}
      <div>点击左侧任意一位家人<br>查看 TA 该叫什么</div>
    </div>`;
}

/**
 * 空字段的「补充」入口：点击直接打开编辑弹窗并聚焦对应字段。
 * 现在只用于**必填项**（性别）；其余字段空着不提示（见 sectionBasic）。
 * 配偶 / 子女改从面板底部的「添加亲属」按钮进。
 */
function fillBtn(id, field, label) {
  return `<button type="button" class="fill-btn" data-act="edit" data-id="${esc(id)}" data-field="${esc(field)}">＋ ${esc(label)}</button>`;
}
