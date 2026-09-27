#!/usr/bin/env node
/**
 * 刷新本地价目表 pricing.json。
 *
 * **只在人工触发时运行**（`npm run refresh:prices`）。运行时桌宠只读 pricing.json，
 * 绝不联网 —— 官方没有价格 API，爬页面一旦结构变动就会静默失效，
 * 而计费算错是最难发现的一类 bug（她照样说话，只是数字不对）。
 * 所以刷新是"人来按下按钮"的动作：抓页面 → 解析 → **打印 diff** → 写文件。
 *
 * 用法：
 *   node scripts/refresh-prices.mjs                     # 直接抓官网
 *   node scripts/refresh-prices.mjs --from-file x.html  # 用已保存的页面（没网/被墙时）
 *   node scripts/refresh-prices.mjs --dry-run           # 只打印将要写的内容
 *
 * 解析失败（页面结构变了）时**不写文件**并退出 1 —— 宁可手动改，也不要写坏价目表。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'pricing.json');
const DEFAULT_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';

const argv = process.argv.slice(2);
const argValue = (name) => {
  const idx = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (idx === -1) return undefined;
  const hit = argv[idx];
  const eq = hit.indexOf('=');
  if (eq !== -1) return hit.slice(eq + 1);
  // 支持 `--from-file x.html` 这种空格分隔写法（否则只认 = 形式，很容易踩空）
  const next = argv[idx + 1];
  return next && !next.startsWith('--') ? next : true;
};

const url = typeof argValue('url') === 'string' ? argValue('url') : DEFAULT_URL;
const fromFile = typeof argValue('from-file') === 'string' ? argValue('from-file') : null;
const dryRun = argValue('dry-run') !== undefined;

/**
 * 从官网页面里解析出模型价格。
 *
 * 页面是 Docusaurus 渲染的一张表，值是纯文本。做法刻意"笨"一点：
 * 先把 HTML 里的标签剥掉、按行切开，再在 `模型` 行里按列名取值 ——
 * 这样即使表格顺序变了，只要还有"每个模型一列、每类价格一行"的结构就能对上。
 * 结构对不上就抛错（见文件头的说明）。
 */
export function parsePricingPage(html, { hourPeak } = {}) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<\/(tr|table|div|p|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \u00a0]+/g, ' ');

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const models = {};
  const aliases = {};

  /*
   * 1) 模型列表：模型细节表里第一行是 "模型\tdeepseek-flash(1)\tdeepseek-v4-pro"
   *    注意别用 /^模型\b/ —— `\b` 只认 [A-Za-z0-9_]，中文后面跟制表符不构成词边界，
   *    这个正则永远匹配不上（第一版就栽在这里）。
   */
  const modelHeader = lines.find((l) => /^模型\t/.test(l));
  if (modelHeader) {
    const names = modelHeader
      .split('\t')
      .slice(1)
      .map((s) => s.replace(/\(\d+\)/g, '').trim())
      .filter((s) => /^[a-z0-9][a-z0-9._-]*$/i.test(s));
    for (const name of names) models[name] = { label: '', cacheHit: {}, cacheMiss: {}, output: {} };
  }
  if (!Object.keys(models).length) {
    throw new Error('解析不出模型列表：页面结构可能变了（模型细节表的第一行）');
  }

  // 2) 版本号（模型版本行，列与上面一一对应）
  const versionLine = lines.find((l) => /^模型版本\t/.test(l));
  if (versionLine) {
    const versions = versionLine.split('\t').slice(1).map((s) => s.trim());
    Object.keys(models).forEach((name, i) => {
      models[name].label = versions[i] || '';
    });
  }

  /*
   * 3) 价格行。页面上的形状是（制表符是单元格边界）：
   *      "价格(2)\t百万tokens输入（缓存命中）\t空闲时段\t0.02元\t0.15元"
   *      "高峰时段\t0.04元\t0.30元"
   *      "百万tokens输入（缓存未命中）\t空闲时段\t1元\t4.5元"
   *      "高峰时段\t2元\t9.0元"
   *    所以不能假定"第一格是说明" —— 要**在行内找**说明格与时段格，值取时段格之后的格子。
   */
  const valueOf = (cell) => {
    const m = /([0-9]+(?:\.[0-9]+)?)/.exec(String(cell || ''));
    return m ? Number(m[1]) : null;
  };
  const assign = (key, tier, values) => {
    Object.keys(models).forEach((name, i) => {
      const v = valueOf(values[i]);
      if (v !== null) models[name][key][tier] = v;
    });
  };

  let currentKey = null;
  for (const line of lines) {
    const cells = line.split('\t').map((s) => s.trim());
    const descIdx = cells.findIndex((c) => /^百万tokens(输入|输出)/.test(c));
    if (descIdx !== -1) {
      const desc = cells[descIdx];
      currentKey = /^百万tokens输出/.test(desc) ? 'output' : /未命中/.test(desc) ? 'cacheMiss' : 'cacheHit';
    }
    if (!currentKey) continue;
    const tierIdx = cells.findIndex((c) => /^(空闲|高峰)时段/.test(c));
    if (tierIdx === -1) continue;
    assign(currentKey, /^高峰/.test(cells[tierIdx]) ? 'peak' : 'idle', cells.slice(tierIdx + 1));
  }

  // 缺任何一格都算解析失败：宁可报错也不要写半张表
  for (const [name, entry] of Object.entries(models)) {
    for (const key of ['cacheHit', 'cacheMiss', 'output']) {
      if (!Number.isFinite(entry[key].idle) || !Number.isFinite(entry[key].peak)) {
        throw new Error(`模型 ${name} 的 ${key} 没解析全（idle=${entry[key].idle} peak=${entry[key].peak}）`);
      }
    }
  }

  // 4) 旧模型名：脚注里写"旧模型名 xxx、yyy 仍可调用，但对应模型已下线，按 Flash 价格计费"。
  //    只取"仍可调用"**之前**那一段 —— 后面的解释文字里还会出现别的模型名（如 DeepSeek-V4.1-Flash），
  //    整句切分会把它们也当成别名（第一版就是这样多出两个假别名）。
  const flashName = Object.keys(models).find((n) => /flash/i.test(n)) || Object.keys(models)[0];
  const aliasSentence = /旧模型名([^。]*)/.exec(text);
  if (aliasSentence) {
    const namesPart = aliasSentence[1].split(/仍可调用|但对应/)[0];
    for (const part of namesPart.split(/[、,，\s]+/)) {
      const old = part.replace(/[`'"]/g, '').trim();
      if (old && /^[a-z0-9][a-z0-9._-]*$/i.test(old)) aliases[old] = flashName;
    }
  }

  return { models, aliases };
}

/** 本地日期 YYYY-MM-DD（不用 toISOString：那是 UTC，东八区凌晨会写成前一天）。 */
function localDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function buildTable({ models, aliases }, previous) {
  const peakHours = previous?.peakHours || [[9, 12], [14, 18]];
  return {
    $comment:
      '本地价目表：运行时**不联网**，只读这一个文件。刷新靠人工触发 —— `npm run refresh:prices`（脚本抓官方页面并 diff），或直接改这个文件。改完提交，价目表随版本走。',
    source: previous?.source || DEFAULT_URL,
    updatedAt: localDate(),
    currency: previous?.currency || 'CNY',
    unit: previous?.unit || '元 / 百万 tokens',
    peakHours,
    peakNote:
      previous?.peakNote ||
      '北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰；空闲价 = 高峰价的一半。下面每个价格都写明 idle（空闲）/ peak（高峰），不靠倍率推导。',
    models,
    aliases: { $comment: aliases.$comment || '旧模型名：官方说明仍可调用，但对应模型已下线，按 Flash 价格计费', ...aliases },
  };
}

function summarize(table) {
  const out = [];
  for (const [name, e] of Object.entries(table.models)) {
    out.push(
      `  ${name.padEnd(20)} 命中 ${e.cacheHit.idle}/${e.cacheHit.peak}  未命中 ${e.cacheMiss.idle}/${e.cacheMiss.peak}  输出 ${e.output.idle}/${e.output.peak}（空闲/高峰，元/百万）`,
    );
  }
  return out.join('\n');
}

async function fetchPage(target) {
  const res = await fetch(target, { headers: { 'user-agent': 'dsh-whale-desktop/refresh-prices' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const previous = fs.existsSync(TARGET) ? JSON.parse(fs.readFileSync(TARGET, 'utf8')) : null;
  let html;
  if (fromFile) {
    html = fs.readFileSync(fromFile, 'utf8');
    console.log(`[prices] 从文件读取页面：${fromFile}`);
  } else {
    console.log(`[prices] 抓取 ${url}`);
    html = await fetchPage(url);
  }

  const parsed = parsePricingPage(html, {});
  const table = buildTable(parsed, previous);
  // 别名里的 $comment 不算别名
  delete table.aliases.$comment;
  table.aliases = {
    $comment: '旧模型名：官方说明仍可调用，但对应模型已下线，按 Flash 价格计费',
    ...table.aliases,
  };

  console.log('[prices] 解析结果：');
  console.log(summarize(table));
  if (Object.keys(table.aliases).length > 1) {
    console.log('[prices] 别名：', JSON.stringify(table.aliases));
  }

  const before = previous ? summarize(previous) : '(没有旧文件)';
  const after = summarize(table);
  console.log(`[prices] 与现有文件相比：${before === after ? '无变化' : '有变化（见上，请核对官方页面）'}`);

  if (dryRun) {
    console.log('[prices] --dry-run：不写文件');
    return;
  }
  fs.writeFileSync(TARGET, `${JSON.stringify(table, null, 2)}\n`);
  console.log(`[prices] 已写入 ${TARGET} —— 请 git diff 核对后提交`);
}

// 直接运行时才执行（被 import 做单测时不要跑）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[prices] 失败：', error.message);
    console.error('[prices] 没有写文件。可以人工核对官方页面后直接改 pricing.json。');
    process.exit(1);
  });
}
