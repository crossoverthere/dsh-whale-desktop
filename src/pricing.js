'use strict';

/**
 * DeepSeek 计费与"本次任务花费"文案。
 *
 * 全部是纯函数，方便单测（见 scripts/test-cost.mjs）—— 计费算错是最难发现的一类 bug，
 * 必须能脱离 Electron 单独验证。
 *
 * 分工（刻意分开，避免"价目表"和"算术"纠缠在一起）：
 *   · **单价从哪来** → src/price-table.js（读本地 pricing.json，按模型 + 峰谷取价）
 *   · **怎么乘**     → 本文件：`costOf(usage, rates)` 只做"用量 × 已定好的单价"
 *
 * 价目表要点（deepseek-flash 空闲价，元/百万 tokens）：
 *   输入（缓存命中）0.02   输入（缓存未命中）1   输出 4
 *   高峰时段价格是空闲时段的 2 倍（具体数字见 pricing.json，不靠倍率推导）
 *
 * 两个必须记住的坑：
 *   1. cacheReadTokens 与 inputTokens 是**分开计价**的两部分，价差 50 倍，
 *      混在一起算会高估几十倍。
 *   2. reasoningTokens 是 outputTokens 的**子集**，不能再加一遍。
 */

/** 兜底单价（元 / 百万 tokens）：模型既不在价目表里、手动配置也没填时用。 */
const DEFAULT_PRICES = Object.freeze({
  cacheHitPerM: 0.02,
  cacheMissPerM: 1,
  outputPerM: 4,
});

/** 手动配置走高峰时的倍率（价目表里的数字是逐个写明的，不用这个倍率）。 */
const PEAK_MULTIPLIER = 2;

/** 高峰时段（北京时间，周一至周五）：9:00-12:00、14:00-18:00。 */
const PEAK_HOURS = Object.freeze([
  [9, 12],
  [14, 18],
]);

/**
 * 是否处于高峰时段。
 *
 * 仅供估算：**中国法定节假日没有处理**（那几天官方按空闲计价，我们会算高一倍）。
 * 需要精确就得引入节假日表，v1 不做。
 */
function isPeak(at) {
  const ms = typeof at === 'number' ? at : Date.now();
  const bj = new Date(ms + 8 * 3600 * 1000); // 平移到北京时间，再用 UTC 取值
  const day = bj.getUTCDay(); // 0 = 周日
  if (day === 0 || day === 6) {
    return false;
  }
  const hour = bj.getUTCHours();
  return PEAK_HOURS.some(([from, to]) => hour >= from && hour < to);
}

/** 只取计费需要的三项，缺项按 0。 */
function normalizeUsage(usage) {
  const u = usage || {};
  return {
    inputTokens: Number(u.inputTokens) || 0,
    cacheReadTokens: Number(u.cacheReadTokens) || 0,
    outputTokens: Number(u.outputTokens) || 0,
  };
}

/** 输入总量（未命中 + 命中）。 */
function totalTokens(usage) {
  const u = normalizeUsage(usage);
  return u.inputTokens + u.cacheReadTokens + u.outputTokens;
}

/**
 * 算钱（元）。
 *
 * `rates` 必须是**此刻有效的**单价（空闲或高峰已经选好，见 src/price-table.js 的
 * resolveRates）—— 本函数不再自己判断峰谷，免得"谁决定时段"散落在两处。
 *
 * @param {object} usage 汇总后的 token 用量
 * @param {{ cacheHitPerM?: number, cacheMissPerM?: number, outputPerM?: number }} [rates]
 */
function costOf(usage, rates) {
  const p = { ...DEFAULT_PRICES, ...(rates || {}) };
  const u = normalizeUsage(usage);
  return (u.inputTokens * p.cacheMissPerM + u.cacheReadTokens * p.cacheHitPerM + u.outputTokens * p.outputPerM) / 1e6;
}

/** 1546508 -> "154.7 万"；再大到亿就换单位。 */
function formatTokens(count) {
  const n = Number(count) || 0;
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return String(Math.round(n));
}

/** 金额格式化：小额给 4 位小数，否则 2 位。 */
function formatMoney(value) {
  const v = Number(value) || 0;
  return v < 0.1 ? `¥${v.toFixed(4)}` : `¥${v.toFixed(2)}`;
}

/** 低于阈值就不打扰（NaN 也当作不播报）。 */
function shouldAnnounce(cost, threshold) {
  const t = Number(threshold);
  if (!Number.isFinite(cost)) return false;
  return cost >= (Number.isFinite(t) ? t : 0.01);
}

/** 播报文案。 */
function announceText(usage, cost) {
  return `这次任务花了 ${formatTokens(totalTokens(usage))} tokens，约 ${formatMoney(cost)}`;
}

module.exports = {
  DEFAULT_PRICES,
  PEAK_MULTIPLIER,
  PEAK_HOURS,
  isPeak,
  normalizeUsage,
  totalTokens,
  costOf,
  formatTokens,
  formatMoney,
  shouldAnnounce,
  announceText,
};
