/**
 * =========================================================
 * 自动体检面板 · ui/check.js
 * ---------------------------------------------------------
 * 对应 PRD §6.2 F8。把 core/diagnose.js 的报告渲染成可读清单。
 *
 * 【产品原则：只报不改】
 *   每一条都写清「谁 / 哪里不对 / 为什么不对」，
 *   并给出可点击的人名直接跳过去修。
 *   引擎绝不替用户改数据 —— 错值比空值更毒。
 * =========================================================
 */

import { ICON } from './icons.js';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * @param {HTMLElement} el
 * @param {object} report diagnose() 的产物
 * @param {object} ctx { nameOf(id), stats }
 */
export function renderCheck(el, report, ctx = {}) {
  const nameOf = ctx.nameOf || ((id) => id);
  const total = report?.issueCount ?? 0;
  const allPass = total === 0;

  el.innerHTML = `
    <div class="check-head">
      <div>
        <div class="check-title">数据体检</div>
        <div style="font-size:12px;color:var(--ink-400);margin-top:2px">
          只报不改 —— 问题交给你判断，引擎不会偷偷动你的数据
        </div>
      </div>
      <div class="check-score">
        <span>发现问题</span>
        <b class="${allPass ? 'pass' : 'fail'}">${total}</b>
        <span>项</span>
      </div>
    </div>
    <div class="check-body">
      ${allPass ? banner() : ''}
      ${(report?.groups || []).map((g) => groupHTML(g, nameOf)).join('')}
      ${ctx.stats ? statsHTML(ctx.stats) : ''}
    </div>`;
}

/* ========================================================= */
/* 区块                                                        */
/* ========================================================= */

function banner() {
  return `
    <div class="check-group">
      <div class="check-pass">
        ${ICON.check} 数据没问题，结构自洽，称谓全部推得出来。
      </div>
    </div>`;
}

function groupHTML(g, nameOf) {
  const n = g.items.length;
  // 「待补充信息」是待办清单，不是错误，用 info 样式区分
  const isTodo = g.code === 'F8.8';
  // 无问题的组：组头角标已显示「通过」，底下不再重复一行
  const body = n
    ? `<div class="check-group-body">
        ${g.items.map((it) => itemHTML(it, nameOf)).join('')}
      </div>`
    : '';

  return `
    <div class="check-group${isTodo ? ' todo' : ''}">
      <div class="check-group-head">
        <span class="code">${esc(g.code)}</span>
        <span>${esc(g.title)}</span>
        <span class="badge ${isTodo ? 'info' : (n ? 'warn' : 'ok')}">${n ? n + ' 项' : '通过'}</span>
      </div>
      ${body}
    </div>`;
}

function itemHTML(it, nameOf) {
  // 把涉及的人名变成可点击的跳转锚点
  //（点了会跳到家族树、把人放大到 100% 居中 —— 见 app.js bindCheck）
  let text = esc(it.text);
  for (const id of [it.personId, it.otherId]) {
    if (!id) continue;
    const nm = nameOf(id);
    if (!nm) continue;
    const safe = esc(nm);
    if (text.includes(safe)) {
      text = text.replace(safe,
        `<span class="who" data-jump="${esc(id)}" title="点击定位到家族树，并放大到 100%">${safe}</span>`);
    }
  }
  return `<div class="check-item"><span>${text}</span></div>`;
}

function statsHTML(stats) {
  const rows = [
    ['成员总数', stats.people],
    ['关系边数', stats.relationships],
    ['称谓规则', `${stats.rules} 条 / ${stats.rulePaths} 种路径`],
    ['可展开家族', stats.families],
    ['存储位置', stats.storage === 'file' ? '本地文件' : '浏览器本地存储'],
  ].filter(([, v]) => v != null);

  return `
    <div class="check-group" style="margin-top:24px">
      <div class="check-group-head">
        <span class="code">INFO</span>
        <span>数据概览</span>
      </div>
      <div class="check-group-body" style="padding:8px 16px 12px">
        ${rows.map(([k, v]) => `
          <div class="field"><span class="k" style="width:88px;flex:0 0 88px">${k}</span><span class="v">${esc(v)}</span></div>
        `).join('')}
      </div>
    </div>`;
}
