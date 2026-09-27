/**
 * 花费播报的离线自检：计价 + turn 累加 + "不播报历史"闸门。
 *
 * 为什么必须单独跑：计费算错是最难发现的一类 bug —— 她照样说话，只是数字不对，
 * 而且金额小的时候看起来都"差不多"。这里用真实会话记录的样本值（见下）和
 * 自己造的多帧 zstd 会话文件，把三个环节全部钉死。
 *
 * 运行：npm run test:cost
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pricing = require('../src/pricing.js');
const { DshStateWatcher } = require('../src/dsh-state.js');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS', name);
  } catch (error) {
    failures.push({ name, error });
    console.log('  FAIL', name, '->', error.message);
  }
}

// ---------------------------------------------------------------- 1. 计价
// 样本来自真实会话（turn 31）：输入 352、缓存命中 1,540,992、输出 5,164
const SAMPLE = { inputTokens: 352, cacheReadTokens: 1540992, outputTokens: 5164 };

console.log('[1] 计价');
check('样本用量总 tokens = 1,546,508', () => {
  assert.equal(pricing.totalTokens(SAMPLE), 352 + 1540992 + 5164);
});

check('空闲时段单价与手算一致', () => {
  // 非高峰时刻：2026-01-03 是周六
  const at = Date.UTC(2026, 0, 3, 4, 0, 0);
  const cost = pricing.costOf(SAMPLE, null, at);
  const expected = (352 * 1 + 1540992 * 0.02 + 5164 * 4) / 1e6;
  assert.ok(Math.abs(cost - expected) < 1e-9, `${cost} != ${expected}`);
  // 手算：0.000352 + 0.03081984 + 0.020656 = 0.05182784
  assert.ok(Math.abs(cost - 0.05182784) < 1e-8, String(cost));
});

check('高峰时段正好翻倍', () => {
  const offPeak = pricing.costOf(SAMPLE, null, Date.UTC(2026, 0, 3, 4, 0, 0)); // 周六
  const peak = pricing.costOf(SAMPLE, null, Date.UTC(2026, 0, 5, 2, 0, 0)); // 周一 10:00 北京
  assert.ok(Math.abs(peak - offPeak * 2) < 1e-9, `${peak} vs ${offPeak}`);
});

check('峰谷判定：工作日 9-12/14-18 为峰，午休与夜间为谷', () => {
  const at = (y, m, d, beijingHour) => Date.UTC(y, m, d, beijingHour - 8, 0, 0);
  assert.equal(pricing.isPeak(at(2026, 0, 5, 9)), true);
  assert.equal(pricing.isPeak(at(2026, 0, 5, 11)), true);
  assert.equal(pricing.isPeak(at(2026, 0, 5, 12)), false, '12:00 起是午休');
  assert.equal(pricing.isPeak(at(2026, 0, 5, 14)), true);
  assert.equal(pricing.isPeak(at(2026, 0, 5, 17)), true);
  assert.equal(pricing.isPeak(at(2026, 0, 5, 18)), false);
  assert.equal(pricing.isPeak(at(2026, 0, 5, 8)), false);
  assert.equal(pricing.isPeak(at(2026, 0, 10, 7, 10)), false, '周六不涨价');
});

check('缓存命中/未命中分开计价（混算会高估 ~50 倍）', () => {
  const at = Date.UTC(2026, 0, 3, 4, 0, 0);
  const onlyMiss = pricing.costOf({ inputTokens: 1e6 }, null, at);
  const onlyHit = pricing.costOf({ cacheReadTokens: 1e6 }, null, at);
  assert.ok(Math.abs(onlyMiss - 1) < 1e-9, String(onlyMiss));
  assert.ok(Math.abs(onlyHit - 0.02) < 1e-9, String(onlyHit));
});

check('reasoningTokens 不参与累加（它是 output 的子集）', () => {
  const at = Date.UTC(2026, 0, 3, 4, 0, 0);
  const withReasoning = pricing.costOf({ outputTokens: 1000, reasoningTokens: 900 }, null, at);
  const withoutReasoning = pricing.costOf({ outputTokens: 1000 }, null, at);
  assert.equal(withReasoning, withoutReasoning);
});

check('单价可被配置覆盖', () => {
  const at = Date.UTC(2026, 0, 3, 4, 0, 0);
  const cost = pricing.costOf({ inputTokens: 1e6 }, { cacheMissPerM: 2 }, at);
  assert.ok(Math.abs(cost - 2) < 1e-9, String(cost));
});

// ---------------------------------------------------------------- 2. 阈值与文案
console.log('[2] 阈值与文案');
check('低于 0.01 不播报，等于阈值播报', () => {
  assert.equal(pricing.shouldAnnounce(0.0099, 0.01), false);
  assert.equal(pricing.shouldAnnounce(0.01, 0.01), true);
  assert.equal(pricing.shouldAnnounce(0.052, 0.01), true);
});

check('非法值当作不播报（NaN 不能变成"永远播报"）', () => {
  assert.equal(pricing.shouldAnnounce(NaN, 0.01), false);
  assert.equal(pricing.shouldAnnounce(0.5, NaN), true, '阈值非法时退回默认 0.01');
});

check('文案：token 用万/亿，小额金额保留 4 位小数', () => {
  const cost = pricing.costOf(SAMPLE, null, Date.UTC(2026, 0, 3, 4, 0, 0));
  const text = pricing.announceText(SAMPLE, cost);
  assert.equal(text, '这次任务花了 154.7 万 tokens，约 ¥0.0518');
});

check('文案：大额金额保留 2 位小数', () => {
  assert.equal(pricing.formatMoney(12.3456), '¥12.35');
  assert.equal(pricing.formatMoney(0.05182784), '¥0.0518');
});

check('token 单位换算', () => {
  assert.equal(pricing.formatTokens(999), '999');
  assert.equal(pricing.formatTokens(10000), '1.0 万');
  assert.equal(pricing.formatTokens(123456789), '1.23 亿');
});

// ---------------------------------------------------------------- 3. 会话读取 → 播报
console.log('[3] 会话读取与播报闸门');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cost-test-'));
const sessions = path.join(tmp, 'sessions');

/** 同步小睡：mtime 只有毫秒精度，测试里需要它明确变大。 */
function sleepSync(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin */
  }
}

function writeSession(dirName, records, { frames = [] } = {}) {
  const dir = path.join(sessions, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v3.jsonl.zstd');
  const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  // 多帧 zstd：与真实会话文件一致（每次追加一帧），顺便验证增量解帧
  const chunks = frames.length ? frames : [text];
  fs.writeFileSync(file, Buffer.concat(chunks.map((c) => zlib.zstdCompressSync(Buffer.from(c, 'utf8')))));
  return file;
}

function turnRecords(turn, usage, kind = 'completed') {
  return [
    { type: 'turn/start', seq: 1, time: Date.now(), data: { turn } },
    { type: 'assistant/message', seq: 2, time: Date.now(), data: { usage } },
    { type: 'turn/end', seq: 3, time: Date.now(), data: { turn, reason: { kind } } },
  ];
}

const historyFile = writeSession('history', turnRecords(1, { inputTokens: 100, cacheReadTokens: 0, outputTokens: 10 }));

check('启动时读到的历史 turn 只入账、不播报（historical 标记）', () => {
  const seen = [];
  const watcher = new DshStateWatcher({ sessionsRoot: sessions, onTurnEnd: (e) => seen.push(e), log: () => {} });
  watcher.poll();
  watcher.poll();
  assert.equal(seen.length, 1, '历史 turn 也要回调（今日账本要补账）');
  assert.ok(seen.every((e) => e.historical === true), JSON.stringify(seen));
  assert.equal(seen[0].session, 'history');
  assert.equal(watcher.primed, true, '追平后应置 primed');
  watcher.stop();
});

check('追平之后新增的 turn 会播报，且用量按 turn 累加', () => {
  const seen = [];
  const watcher = new DshStateWatcher({ sessionsRoot: sessions, onTurnEnd: (e) => seen.push(e), log: () => {} });
  watcher.poll(); // 第一次：吃历史，primed=false
  watcher.poll();
  const before = fs.readFileSync(historyFile);
  const extra = [
    { type: 'turn/start', seq: 4, time: Date.now(), data: { turn: 2 } },
    { type: 'assistant/message', seq: 5, time: Date.now(), data: { usage: { inputTokens: 200, cacheReadTokens: 3000, outputTokens: 40 } } },
    { type: 'assistant/message', seq: 6, time: Date.now(), data: { usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 2, reasoningTokens: 2 } } },
    { type: 'turn/end', seq: 7, time: Date.now(), data: { turn: 2, reason: { kind: 'completed' } } },
  ];
  fs.writeFileSync(historyFile, Buffer.concat([
    before,
    zlib.zstdCompressSync(Buffer.from(extra.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')),
  ]));
  watcher.poll();
  watcher.stop();

  const live = seen.filter((e) => !e.historical);
  assert.equal(live.length, 1, JSON.stringify(seen));
  assert.deepEqual(live[0].usage, { inputTokens: 201, cacheReadTokens: 3000, outputTokens: 42, messages: 2 });
  assert.equal(live[0].turn, 2);
  assert.equal(live[0].reason.kind, 'completed');
  const cost = pricing.costOf(live[0].usage, null, Date.now());
  assert.ok(cost > 0 && Number.isFinite(cost), String(cost));
});

check('换会话文件时重新追平，不把新文件里的旧账播一遍', () => {
  const seen = [];
  const watcher = new DshStateWatcher({ sessionsRoot: sessions, onTurnEnd: (e) => seen.push(e), log: () => {} });
  watcher.poll();
  watcher.poll();
  sleepSync(20); // 让 mtime 明确变大，否则 findActiveSession 可能仍选中旧文件
  writeSession('newer', turnRecords(9, { inputTokens: 10, cacheReadTokens: 0, outputTokens: 1 }));
  watcher.scanAt = 0; // 强制下一轮重新扫描目录
  watcher.poll();
  watcher.poll();
  assert.ok(watcher.filePath.endsWith(path.join('newer', 'session.v3.jsonl.zstd')), watcher.filePath);
  assert.ok(seen.length > 0 && seen.every((e) => e.historical === true), JSON.stringify(seen));
  watcher.stop();
});

check('追平之后没有 usage 的 turn 不播报', () => {
  const dir = path.join(tmp, 'nousage');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v3.jsonl.zstd');
  const head = [{ type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } }];
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(head.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')));
  const seen = [];
  const watcher = new DshStateWatcher({ sessionsRoot: tmp, onTurnEnd: (e) => seen.push(e), log: () => {} });
  watcher.poll();
  watcher.poll();
  const before = fs.readFileSync(file);
  const tail = [
    { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  fs.writeFileSync(file, Buffer.concat([
    before,
    zlib.zstdCompressSync(Buffer.from(tail.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')),
  ]));
  watcher.poll();
  watcher.stop();
  assert.deepEqual(seen, [], JSON.stringify(seen));
});

check('跨启动的进行中任务也算得准（追平时保留当前 turn 已累计的用量）', () => {
  const dir = path.join(tmp, 'inflight');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v3.jsonl.zstd');
  // 历史里最后一个 turn 还没结束 —— 正是"桌宠在任务中途被重启"的情形
  const head = [
    ...turnRecords(1, { inputTokens: 100, cacheReadTokens: 0, outputTokens: 10 }),
    { type: 'turn/start', seq: 4, time: Date.now(), data: { turn: 2 } },
    { type: 'assistant/message', seq: 5, time: Date.now(), data: { usage: { inputTokens: 500, cacheReadTokens: 0, outputTokens: 50 } } },
  ];
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(head.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')));
  const seen = [];
  const watcher = new DshStateWatcher({ sessionsRoot: tmp, onTurnEnd: (e) => seen.push(e), log: () => {} });
  watcher.scanAt = 0;
  watcher.poll();
  watcher.poll();
  assert.equal(watcher.primed, true);
  const before = fs.readFileSync(file);
  const tail = [
    { type: 'assistant/message', seq: 6, time: Date.now(), data: { usage: { inputTokens: 7, cacheReadTokens: 0, outputTokens: 3 } } },
    { type: 'turn/end', seq: 7, time: Date.now(), data: { turn: 2, reason: { kind: 'completed' } } },
  ];
  fs.writeFileSync(file, Buffer.concat([
    before,
    zlib.zstdCompressSync(Buffer.from(tail.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')),
  ]));
  watcher.poll();
  watcher.stop();
  const live = seen.filter((e) => !e.historical);
  assert.equal(live.length, 1, JSON.stringify(seen));
  assert.deepEqual(live[0].usage, { inputTokens: 507, cacheReadTokens: 0, outputTokens: 53, messages: 2 });
});

fs.rmSync(tmp, { recursive: true, force: true });

// ---------------------------------------------------------------- 4. 今日账本
console.log('[4] 今日消耗账本');

const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ledger-test-'));

function freshLedger(name) {
  const { UsageLedger } = require('../src/usage-today.js');
  return new UsageLedger({ file: path.join(ledgerDir, name), log: () => {} });
}

const HOUR = 3600 * 1000;

check('累计 token / 金额 / turn 数', () => {
  const ledger = freshLedger('basic.json');
  const at = Date.now();
  ledger.record({ key: 's#1', usage: { inputTokens: 100, cacheReadTokens: 200, outputTokens: 10 }, cost: 0.01, at });
  ledger.record({ key: 's#2', usage: { inputTokens: 1, cacheReadTokens: 2, outputTokens: 3 }, cost: 0.02, at });
  const today = ledger.today(at);
  assert.deepEqual(
    { tokens: today.tokens, cost: today.cost, turns: today.turns },
    { tokens: 100 + 200 + 10 + 1 + 2 + 3, cost: 0.03, turns: 2 }
  );
});

check('同一个 turn 重复入账被去重（回放历史不能算两遍）', () => {
  const ledger = freshLedger('dedupe.json');
  const at = Date.now();
  const entry = { key: 's#7', usage: { inputTokens: 50, outputTokens: 5 }, cost: 0.01, at };
  assert.equal(ledger.record(entry), 'added');
  assert.equal(ledger.record(entry), 'duplicate', '第二次应为重复');
  assert.equal(ledger.today(at).turns, 1);
  assert.equal(ledger.today(at).tokens, 55);
});

check('昨天的 turn 既不记账、也不会把账本回退到昨天', () => {
  const at = Date.now();
  const yesterday = at - 24 * HOUR;
  const ledger = freshLedger('past.json');
  ledger.record({ key: 's#1', usage: { inputTokens: 1000 }, cost: 1, at });
  // 会话文件是跨天的：启动回放里必然夹着更早的 turn
  assert.equal(ledger.record({ key: 'old#1', usage: { inputTokens: 999999 }, cost: 99, at: yesterday }), 'past');
  const today = ledger.today(at);
  assert.equal(today.tokens, 1000, '今天的账不能被昨天覆盖或污染');
  assert.equal(today.cost, 1);
  assert.equal(today.turns, 1);
});

check('落盘后重启仍在（升级/重启不丢今天的账）', () => {
  const at = Date.now();
  const first = freshLedger('persist.json');
  first.record({ key: 's#1', usage: { inputTokens: 1000 }, cost: 0.001, at });
  const second = freshLedger('persist.json');
  const today = second.today(at);
  assert.equal(today.tokens, 1000);
  assert.equal(today.turns, 1);
  assert.ok(Math.abs(today.cost - 0.001) < 1e-9, String(today.cost));
});

check('跨天自动归零（旧账不会被算进新的一天）', () => {
  const { localDateKey } = require('../src/usage-today.js');
  const todayAt = Date.now();
  const tomorrowAt = todayAt + 24 * HOUR;
  const ledger = freshLedger('rollover.json');
  ledger.record({ key: 's#1', usage: { inputTokens: 9999 }, cost: 1, at: todayAt });
  assert.equal(ledger.today(todayAt).tokens, 9999, '当天应已记账');
  const tomorrow = ledger.today(tomorrowAt);
  assert.notEqual(tomorrow.date, localDateKey(todayAt), '日期应已翻页');
  assert.equal(tomorrow.turns, 0);
  assert.equal(tomorrow.tokens, 0);
  assert.equal(tomorrow.cost, 0);
});

check('昨天写的账文件不会被当成今天的账读进来', () => {
  const file = path.join(ledgerDir, 'stale.json');
  const stale = {
    date: '2000-01-01',
    inputTokens: 5000,
    cacheReadTokens: 0,
    outputTokens: 0,
    cost: 9.9,
    turns: 5,
    keys: ['old#1'],
  };
  fs.writeFileSync(file, JSON.stringify(stale));
  const { UsageLedger } = require('../src/usage-today.js');
  const ledger = new UsageLedger({ file, log: () => {} });
  assert.equal(ledger.today().tokens, 0);
  assert.equal(ledger.today().turns, 0);
});

check('日期键用本地日期（不是 UTC）', () => {
  const { localDateKey } = require('../src/usage-today.js');
  // 本地 00:30 必须落在"今天"，用 UTC 取的话东八区会退回前一天
  const at = new Date(2026, 5, 10, 0, 30, 0).getTime();
  assert.equal(localDateKey(at), '2026-06-10');
});

fs.rmSync(ledgerDir, { recursive: true, force: true });

// ---------------------------------------------------------------- 结果
console.log('');
if (failures.length) {
  console.error(`[test:cost] ${passed} 项通过，${failures.length} 项失败`);
  for (const f of failures) console.error('  ✗', f.name, '\n   ', f.error.stack.split('\n').slice(0, 3).join('\n    '));
  process.exit(1);
}
console.log(`[test:cost] 全部通过（${passed} 项）`);
