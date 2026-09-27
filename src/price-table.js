'use strict';

/**
 * 价目表：**读本地文件**、按当前模型取价。
 *
 * 为什么不做运行时联网取价：DeepSeek 没有价格 API，官网只有一张给人看的网页表格；
 * 爬页面一旦结构变动就静默失效 —— 而计费算错是最难发现的一类 bug（她照样说话，
 * 只是数字不对）。所以价目表是仓库里的一份数据文件（pricing.json），
 * 刷新靠人工触发：`npm run refresh:prices` 抓页面 + diff，确认后提交。
 *
 * 取价优先级：
 *   1. 当前模型在价目表里（含别名）→ 用表里的 idle/peak 价，**忽略手动配置**
 *   2. 不在表里 → 用手动配置（设置窗口「手动配置」那三个数），高峰时 ×2
 *
 * 另外这里还负责"当前用的是哪个模型"：DSH 的会话记录 `request/header` 里有
 * `data.header.config.model`（实测存在），设置文件 `~/.dsh/settings.yaml` 里也有默认模型。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { isPeak, PEAK_MULTIPLIER } = require('./pricing');

const DEFAULT_TABLE_FILE = path.join(__dirname, '..', 'pricing.json');
const DEFAULT_DSH_SETTINGS = path.join(os.homedir(), '.dsh', 'settings.yaml');

/** 读价目表；读不到就返回 ok:false（调用方回落到手动配置，不影响运行）。 */
function loadTable(file = DEFAULT_TABLE_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const models = raw && raw.models && typeof raw.models === 'object' ? raw.models : {};
    return {
      ok: true,
      file,
      source: raw.source || '',
      updatedAt: raw.updatedAt || '',
      currency: raw.currency || 'CNY',
      unit: raw.unit || '元 / 百万 tokens',
      peakNote: raw.peakNote || '',
      models,
      aliases: raw.aliases && typeof raw.aliases === 'object' ? raw.aliases : {},
      modelNames: Object.keys(models),
    };
  } catch (error) {
    return { ok: false, file, error: error.message, models: {}, aliases: {}, modelNames: [] };
  }
}

function normalizeModel(name) {
  return String(name == null ? '' : name).trim().toLowerCase();
}

/**
 * 在表里找模型（先精确、再别名、最后忽略大小写）。
 * @returns {{ key: string, entry: object, matchedBy: 'exact'|'alias' }|null}
 */
function lookupModel(table, model) {
  const name = normalizeModel(model);
  if (!table || !table.models || !name) return null;
  const exactKey = Object.keys(table.models).find((k) => normalizeModel(k) === name);
  if (exactKey) return { key: exactKey, entry: table.models[exactKey], matchedBy: 'exact' };
  const aliasTarget = Object.entries(table.aliases || {}).find(([k]) => normalizeModel(k) === name);
  if (aliasTarget) {
    const target = String(aliasTarget[1]);
    const hit = Object.keys(table.models).find((k) => normalizeModel(k) === normalizeModel(target));
    if (hit) return { key: hit, entry: table.models[hit], matchedBy: 'alias' };
  }
  return null;
}

function pick(pair, peak) {
  const value = pair && typeof pair === 'object' ? (peak ? pair.peak : pair.idle) : pair;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 算出"此刻、此模型"的三项单价（元/百万 tokens）。
 *
 * @param {{ table?: object, model?: string, manual?: object, at?: number }} opts
 * @returns {{ source: 'table'|'manual', peak: boolean, modelKey: string|null, label: string|null,
 *             matchedBy: string|null, rates: { cacheHitPerM: number, cacheMissPerM: number, outputPerM: number } }}
 */
function resolveRates({ table, model, manual, at } = {}) {
  const peak = isPeak(at);
  const hit = lookupModel(table, model);
  if (hit) {
    return {
      source: 'table',
      peak,
      modelKey: hit.key,
      label: hit.entry.label || hit.key,
      matchedBy: hit.matchedBy,
      rates: {
        cacheHitPerM: pick(hit.entry.cacheHit, peak),
        cacheMissPerM: pick(hit.entry.cacheMiss, peak),
        outputPerM: pick(hit.entry.output, peak),
      },
    };
  }
  // 表里没有这个模型：用手动配置，高峰按统一倍率放大
  const mult = peak ? PEAK_MULTIPLIER : 1;
  const m = manual || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    source: 'manual',
    peak,
    modelKey: null,
    label: null,
    matchedBy: null,
    rates: {
      cacheHitPerM: num(m.cacheHitPerM) * mult,
      cacheMissPerM: num(m.cacheMissPerM) * mult,
      outputPerM: num(m.outputPerM) * mult,
    },
  };
}

/**
 * 从 DSH 的设置文件里读默认模型（只在会话还没给出模型时兜底）。
 *
 * 不用 YAML 库：这里只关心 `agent-default-model:` 段下的 `model:` 一行，
 * 用正则足够，也免得为一个字段引依赖。读不到返回 ''。
 */
function readDshModel(file = DEFAULT_DSH_SETTINGS) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const block = /agent-default-model:\s*\n((?:[ \t]+.*\n?)*)/.exec(text);
    const scope = block ? block[1] : text;
    const hit = /^\s*model:\s*['"]?([^'"\s#]+)/m.exec(scope);
    return hit ? hit[1] : '';
  } catch (error) {
    return '';
  }
}

module.exports = {
  DEFAULT_TABLE_FILE,
  DEFAULT_DSH_SETTINGS,
  loadTable,
  normalizeModel,
  lookupModel,
  resolveRates,
  readDshModel,
};
