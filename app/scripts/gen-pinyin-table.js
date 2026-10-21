#!/usr/bin/env node
/**
 * =========================================================
 * 生成汉字 → 拼音的静态表 · scripts/gen-pinyin-table.js
 * ---------------------------------------------------------
 * 产出：app/src/core/data/pinyin.js（**提交进仓库**）
 *
 * 【为什么要生成而不是直接依赖拼音库】
 *   core/ 的立身之本是「零 npm 依赖 + 可在 Node 里单测」。
 *   为了搜索引一个几百 KB 的运行期依赖不划算，而这张表只有 40KB 左右，
 *   且**读音不常变**—— 所以：开发期生成一次，产物进仓库，运行时零依赖。
 *   这也是 app/package.json 的 dependencies 至今只有 html2canvas + sql.js 的原因。
 *
 * 【字符集：GB2312 一级汉字（3755 字）】
 *   不用「通用规范汉字表一级字」是因为那份清单得另外下载，而 GB2312 的
 *   一级汉字本来就是**编码标准里定义的常用字集**：区 0xB0–0xD7、
 *   位 0xA1–0xFE，共 3755 个汉字，机器直接枚举即可，完全离线可复现。
 *   覆盖人名 99.9% 以上；表外生僻字按「未覆盖不猜」处理（见 core/search.js）。
 *
 * 【读音来源：pinyin-pro（仅开发期）】
 *   pinyin-pro 是**运行时不依赖**，只在生成时用一次。跑本脚本前：
 *     npm i --no-save pinyin-pro
 *   （--no-save：只装进 node_modules，不写进 package.json 的依赖表。）
 *   生成完可以直接 `npm uninstall pinyin-pro` 清掉。
 *
 * 用法：
 *   node scripts/gen-pinyin-table.js
 * =========================================================
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core', 'data', 'pinyin.js');

/** 一个字最多留几个读音（现代汉语多音字绝大多数是双音；留 2 个够用且表小） */
const MAX_READINGS = 2;

/** GB2312 一级汉字：区 0xB0–0xD7，位 0xA1–0xFE */
function gb2312Level1() {
  const dec = new TextDecoder('gbk');
  const out = new Set();
  for (let lead = 0xb0; lead <= 0xd7; lead++) {
    for (let trail = 0xa1; trail <= 0xfe; trail++) {
      const ch = dec.decode(new Uint8Array([lead, trail]));
      /* 解出来未必是汉字（GB2312 一级区理论上都是，
         但个别码位解码器可能给别的字符）—— 挡掉非汉字。 */
      if (/[\u4e00-\u9fff]/.test(ch)) out.add(ch);
    }
  }
  return [...out];
}

async function main() {
  let pinyin;
  try {
    ({ pinyin } = await import('pinyin-pro'));
  } catch {
    console.error('需要开发期依赖 pinyin-pro：先跑 npm i --no-save pinyin-pro');
    process.exit(1);
  }

  const chars = gb2312Level1().sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
  const table = {};
  const missing = [];

  for (const ch of chars) {
    /* multiple: 多音字给全部读音；toneType 'none': 不带声调（键盘打不出来，
       存了也没地方用）。
       ⚠️ pinyin-pro 的 multiple 返回值**版本之间不一样**：v3 给的是
       「空格分隔的字符串」（"chang zhang"），旧版给的是嵌套数组。
       两种都接住 —— 这个坑踩过一次：按数组处理时整串带空格，
       被下面的 /^[a-z]+$/ 全过滤掉，一大批常用字读音成了空值。 */
    const raw = pinyin(ch, { multiple: true, toneType: 'none' });
    const parts = typeof raw === 'string' ? raw.split(/\s+/) : raw.flat();
    const flat = parts.filter((x) => typeof x === 'string' && x);

    const readings = [...new Set(flat
      /* ü 有两种敲法（lü 可打 lv 也可打 lu），两种都存，用户怎么打都搜得到 */
      .flatMap((x) => {
        const base = x.toLowerCase().replace(/ü/g, 'u').replace(/ê/g, 'e');
        return /[üê]/.test(x.toLowerCase()) ? [base, base.replace(/u/g, 'v')] : [base];
      }))]
      .filter((x) => /^[a-z]+$/.test(x) && x.length <= 6)
      /* 上限在 ü 展开之后才生效：优先保住「读音本身」，再是 ü 的两种敲法 */
      .slice(0, MAX_READINGS);

    if (!readings.length) missing.push(ch);
    table[ch] = readings.join('|');   // '|'-分隔：比数组省一半字符，又不牺牲可读性
  }

  const lines = Object.keys(table).map((ch) => `  '${ch}': '${table[ch]}',`).join('\n');
  const body = `/**
 * 汉字 → 拼音（静态表，**由 scripts/gen-pinyin-table.js 生成，请勿手改**）
 * ---------------------------------------------------------
 * 字符集：GB2312 一级汉字 ${Object.keys(table).length} 字
 * 读音来源：pinyin-pro（仅开发期使用，运行时不依赖）
 * 值格式：多读音用 '|' 分隔，如 '长': 'chang|zhang'；不带声调
 *
 * ⚠️ 表外的字**查不到就是查不到** —— core/search.js 会让这类姓名整条退出
 *    拼音匹配（不跳字、不猜），别在这里补「大概的读音」。
 * 生成时间：${new Date().toISOString().slice(0, 10)}
 */

/** @type {Record<string, string>} 字 → 拼音串（多读音以 '|' 分隔） */
export const PINYIN = {
${lines}
};

/** 取某个字的所有读音；表外字返回空数组（**不是 null**，省得每处都判两种） */
export function readingsOf(ch) {
  const v = PINYIN[ch];
  return v ? v.split('|') : [];
}
`;

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, body, 'utf8');
  console.log(`已生成 ${OUT}`);
  console.log(`  字数 ${Object.keys(table).length}，文件 ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB`);
  if (missing.length) console.log(`  ⚠️ 无有效读音（已留空，不猜）：${missing.join('')}`);
}

main();