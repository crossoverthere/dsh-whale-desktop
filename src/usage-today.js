'use strict';

/**
 * 「今日消耗」账本。
 *
 * 为什么需要它：花费播报是"一个 turn 一次"，而气泡里的余额查询要的是**今天一整天**
 * 的累计 —— 光靠内存里的当前 turn 是算不出来的，而且桌宠会被重启（每次升级都要重启），
 * 一重启就清零的话，用户看到的就是一个明显偏小的数字。所以：
 *
 *   1. 落盘（userData/usage-today.json），重启不丢；
 *   2. 按**本地日期**分区，跨天自动归零（不必等定时器，读写时顺手判断）；
 *   3. 只收**今天**的 turn，并按 `会话#turn` **去重**：启动时会从会话文件回放历史 turn
 *      来补当天的账（见 dsh-state.js 的 historical 标记），而会话文件是跨天的，
 *      回放里必然夹着昨天乃至更早的 turn —— 那些直接丢弃；去重则保证重复回放
 *      （每次重启都会回放）不会把同一天的账算两遍。
 *
 * 它是纯记账，不负责播报（阈值/文案在 src/pricing.js 与 main.js 里）。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 记最近多少个 turn 的去重键；一天跑几百个 turn 很正常，留够即可。 */
const MAX_KEYS = 600;

/** 本地日期键 YYYY-MM-DD（不是 UTC：用户说的"今天"是本地的今天）。 */
function localDateKey(at) {
  const d = new Date(typeof at === 'number' ? at : Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyDay(date) {
  return {
    date,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    cost: 0,
    turns: 0,
    keys: [],
  };
}

class UsageLedger {
  /**
   * @param {{ file: string, log?: Function }} options
   */
  constructor({ file, log = () => {} }) {
    this.file = file;
    this.log = log;
    this.day = emptyDay(localDateKey(Date.now()));
    /** 去重键集合（与 this.day.keys 同步，查起来是 O(1)） */
    this.seen = new Set();
    this.load();
  }

  load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.log('[usage] 账本读取失败，按空账继续', error.message);
      }
      return;
    }
    if (!raw || typeof raw !== 'object') return;
    // 隔天的旧账直接丢：留着只会算错
    if (raw.date !== localDateKey(Date.now())) return;
    this.day = {
      ...emptyDay(raw.date),
      ...raw,
      keys: Array.isArray(raw.keys) ? raw.keys.slice(-MAX_KEYS) : [],
    };
    this.seen = new Set(this.day.keys);
    this.log('[usage] 今日已记账', this.day.turns, '个 turn，', this.day.cost.toFixed(4), '元');
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify(this.day, null, 2)}\n`);
    } catch (error) {
      this.log('[usage] 账本写入失败', error.message);
    }
  }

  /** 跨天就把账清零（读写前都会走一遍）。 */
  rollover(at) {
    const date = localDateKey(at);
    if (this.day.date !== date) {
      this.log('[usage] 跨天，重置今日账本', this.day.date, '->', date);
      this.day = emptyDay(date);
      this.seen = new Set();
    }
    return this.day;
  }

  /**
   * 记一个已完成的 turn。
   *
   * **只收今天的账**：启动回放会把会话文件里的历史 turn 全读一遍，而一个 DSH 会话
   * 文件是跨天的（同一会话连着好几天很常见）。那些早于今天的账既不该计入今天，
   * 更不能把账本"回退"到那一天 —— 所以直接丢弃，而不是让账本跟着翻页。
   *
   * @param {{ key?: string, usage: object, cost: number, at?: number }} entry
   * @returns {'added'|'duplicate'|'past'} 记账结果（调用方据此打日志）
   */
  record({ key, usage, cost, at }) {
    const when = typeof at === 'number' && Number.isFinite(at) ? at : Date.now();
    if (localDateKey(when) !== localDateKey(Date.now())) {
      return 'past';
    }
    const day = this.rollover(when); // 两者同日，等价于"文件里还是昨天的话先归零"
    if (key && this.seen.has(key)) {
      return 'duplicate';
    }
    const u = usage || {};
    day.inputTokens += Number(u.inputTokens) || 0;
    day.cacheReadTokens += Number(u.cacheReadTokens) || 0;
    day.outputTokens += Number(u.outputTokens) || 0;
    day.cost += Number(cost) || 0;
    day.turns += 1;
    if (key) {
      this.seen.add(key);
      day.keys.push(key);
      if (day.keys.length > MAX_KEYS) {
        const dropped = day.keys.splice(0, day.keys.length - MAX_KEYS);
        for (const old of dropped) this.seen.delete(old);
      }
    }
    this.save();
    return 'added';
  }

  /** 今日快照。 */
  today(at) {
    const day = this.rollover(at);
    return {
      date: day.date,
      inputTokens: day.inputTokens,
      cacheReadTokens: day.cacheReadTokens,
      outputTokens: day.outputTokens,
      tokens: day.inputTokens + day.cacheReadTokens + day.outputTokens,
      cost: day.cost,
      turns: day.turns,
    };
  }
}

module.exports = { UsageLedger, localDateKey, MAX_KEYS };
