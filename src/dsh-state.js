'use strict';

/**
 * DSH 工作状态读取器。
 *
 * 为什么读会话文件：桌面版桌宠不在 DSH 页面里，拿不到上游原本依赖的 DOM 信号
 * （`[data-running]` / `[data-status="pending"]` 等）。DSH 会话文件是权威、细粒度
 * 且不需要 DSH 侧做任何改动的状态源。
 *
 * 文件形态：`~/.dsh/sessions/<workspace>/session-<id>/session.v3.jsonl.zstd`
 * 它是**多帧拼接的 zstd**（每次追加一帧），帧之间以 magic `28 B5 2F FD` 分隔；
 * 每帧解压后是若干行 `{type, seq, time, data}`。
 * 因此可以只解压新增的帧，不必每次重解整个文件。
 *
 * 状态映射（依据实测的记录类型）：
 *   turn/start, step/start, assistant/message, tool/result, approval/*  → thinking
 *   tool/call                                                          → tool（带工具名）
 *   turn/end + reason.kind === "completed"                             → success（闪一下）
 *   turn/end + 其它 reason / tool/result 带 data.error                  → failure（闪一下）
 *   其余 / 超时无写入                                                    → idle
 *
 * 另外每条 `assistant/message` 都带 token 用量，按 turn 累加后经 `onTurnEnd` 交出去
 * （花费播报与"今日累计"都吃这份数据，见 src/pricing.js 与 src/usage-today.js）。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** 忙态下多久没有新记录就认定 DS H已停（崩溃/被杀的兜底）。 */
const DEFAULT_IDLE_AFTER_MS = 180000;
/** 成功/失败闪光的持续时间。 */
const DEFAULT_FLASH_MS = 4000;
/** 单次轮询最多解压的帧数。启动时要一次追平历史，否则中间态会算错（见 recompute 注释）。 */
const MAX_FRAMES_PER_POLL = 4000;

function sessionsRoot() {
  return path.join(os.homedir(), '.dsh', 'sessions');
}

/** 找最近被写入的会话文件；找不到返回 null。 */
function findActiveSession(root = sessionsRoot()) {
  let best = null;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (/^session\..*\.jsonl(\.zstd)?$/.test(entry.name)) {
        try {
          const stat = fs.statSync(full);
          if (!best || stat.mtimeMs > best.mtimeMs) {
            best = { path: full, mtimeMs: stat.mtimeMs, size: stat.size, zstd: full.endsWith('.zstd') };
          }
        } catch {
          /* 文件可能正在被替换 */
        }
      }
    }
  };
  walk(root, 0);
  return best;
}

/** 找出 buffer 里所有 zstd 帧起点。 */
function frameOffsets(buffer) {
  const offsets = [];
  for (let i = 0; i + 4 <= buffer.length; i++) {
    if (
      buffer[i] === ZSTD_MAGIC[0] &&
      buffer[i + 1] === ZSTD_MAGIC[1] &&
      buffer[i + 2] === ZSTD_MAGIC[2] &&
      buffer[i + 3] === ZSTD_MAGIC[3]
    ) {
      offsets.push(i);
    }
  }
  return offsets;
}

function parseRecords(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 半行（正在写入）忽略，下一轮会重新读到 */
    }
  }
  return out;
}

class DshStateWatcher {
  /**
   * @param {{ intervalMs?: number, idleAfterMs?: number, flashMs?: number, sessionsRoot?: string, onChange?: (s: object) => void, onTurnEnd?: Function, log?: Function }} options
   */
  constructor(options = {}) {
    this.intervalMs = options.intervalMs ?? 400;
    this.idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
    this.flashMs = options.flashMs ?? DEFAULT_FLASH_MS;
    /** 会话目录；单测指到临时目录就能脱离真实 DSH 验证（见 scripts/test-cost.mjs）。 */
    this.root = options.sessionsRoot ?? sessionsRoot();
    this.onChange = options.onChange ?? (() => {});
    /**
     * 一个 turn 结束时回调：`{ turn, usage, reason, at, session, historical }`。
     * 历史 turn（启动时追平到的）也会回调，`historical: true` —— 调用方只入账、不播报。
     */
    this.onTurnEnd = options.onTurnEnd ?? (() => {});
    this.log = options.log ?? (() => {});

    this.timer = null;
    this.filePath = null;
    this.offset = 0;
    this.lastRecordAt = 0;
    this.inTurn = false;
    this.lastType = null;
    this.toolName = null;
    this.flash = null;
    this.flashUntil = 0;
    this.state = { state: 'idle', tool: null, turn: null, at: 0, session: null, source: 'none' };
    /** 最近一次请求头里看到的模型名（价目表按模型取价）。 */
    this.model = null;
    this.scanAt = 0;
    /** 当前 turn 累计的 token 用量（用于花费播报）。 */
    this.turnUsage = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, messages: 0 };
    /**
     * 是否已完成首次"追平历史"。
     * 启动时会把整份历史读一遍，里面全是历史 turn/end —— 不加这道闸就会在开机瞬间
     * 把过去每一个任务都播报一遍。
     */
    this.primed = false;
    /** 最近一次读到的新鲜文件大小（poll 里 scan 的 this.size 可能已过期）。 */
    this.lastStatSize = 0;
  }

  start() {
    this.stop();
    this.timer = setInterval(() => {
      try {
        this.poll();
      } catch (error) {
        this.log('[dsh] poll failed', error.message);
      }
    }, this.intervalMs);
    this.poll();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 当前状态快照（供 /__shell/state 使用）。 */
  snapshot() {
    return { ...this.state, model: this.model };
  }

  poll() {
    const now = Date.now();
    // 会话文件查找不必每轮都做：目录扫描比解帧贵
    if (!this.filePath || now - this.scanAt > 3000) {
      this.scanAt = now;
      const found = findActiveSession(this.root);
      if (!found) {
        this.publish({ state: 'idle', tool: null, at: now, session: null, source: 'none' });
        return;
      }
      if (found.path !== this.filePath) {
        this.log('[dsh] watching', found.path);
        this.filePath = found.path;
        this.offset = 0;
        this.inTurn = false;
        this.lastType = null;
        this.toolName = null;
        this.flash = null;
        this.flashUntil = 0;
        /*
         * 换会话文件要重新"追平"：新文件里已有的历史 turn/end 同样是历史，
         * 不把 primed 清掉就会在切换会话的瞬间把旧账播一遍。
         */
        this.primed = false;
        this.lastStatSize = 0;
        this.turnUsage = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, messages: 0 };
      }
      this.size = found.size;
      this.mtimeMs = found.mtimeMs;
      this.zstd = found.zstd;
    }

    this.readNewRecords();
    // 追平历史之后才允许播报（否则会把过去每个 turn 都播一遍）
    if (this.lastStatSize > 0 && this.offset >= this.lastStatSize) {
      this.primed = true;
    }
    this.recompute(now);
  }

  readNewRecords() {
    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      this.filePath = null; // 文件没了，下轮重新找
      return;
    }
    if (stat.size < this.offset) {
      // 被截断/轮转，重头来
      this.offset = 0;
      this.inTurn = false;
      this.lastType = null;
    }
    this.lastStatSize = stat.size;
    if (stat.size === this.offset) return;

    let buffer;
    try {
      const fd = fs.openSync(this.filePath, 'r');
      try {
        const length = stat.size - this.offset;
        buffer = Buffer.allocUnsafe(length);
        fs.readSync(fd, buffer, 0, length, this.offset);
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      this.log('[dsh] read failed', error.message);
      return;
    }

    if (!this.zstd) {
      this.ingest(parseRecords(buffer.toString('utf8')));
      this.offset = stat.size;
      return;
    }

    const offsets = frameOffsets(buffer);
    if (!offsets.length) return; // 帧头还没写完
    if (offsets[0] !== 0) {
      // 不在帧边界上（上一次只解了部分），对齐到第一个帧头
      this.offset += offsets[0];
      buffer = buffer.subarray(offsets[0]);
    }

    let consumed = 0;
    let frames = 0;
    for (let i = 0; i < offsets.length && frames < MAX_FRAMES_PER_POLL; i++) {
      const start = offsets[i];
      const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length;
      let text;
      try {
        text = zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8');
      } catch {
        // 最后一帧可能还在写；保留未消费部分，下轮重试
        break;
      }
      this.ingest(parseRecords(text));
      consumed = end;
      frames++;
    }
    this.offset += consumed;
  }

  ingest(records) {
    for (const record of records) {
      const type = record.type;
      const data = record.data ?? {};
      if (typeof record.time === 'number') this.lastRecordAt = Math.max(this.lastRecordAt, record.time);

      // token 用量：每条 assistant/message 都带一份，按当前 turn 累加
      if (data.usage) {
        const u = data.usage;
        this.turnUsage.inputTokens += Number(u.inputTokens) || 0;
        this.turnUsage.cacheReadTokens += Number(u.cacheReadTokens) || 0;
        this.turnUsage.outputTokens += Number(u.outputTokens) || 0;
        // 注意：reasoningTokens 是 outputTokens 的子集，不能再加
        this.turnUsage.messages += 1;
      }

      switch (type) {
        case 'turn/start':
          this.inTurn = true;
          this.turn = data.turn ?? null;
          this.turnUsage = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, messages: 0 };
          break;
        case 'turn/end': {
          this.inTurn = false;
          this.flash = data.reason && data.reason.kind === 'completed' ? 'success' : 'failure';
          this.flashUntil = Date.now() + this.flashMs;
          const usage = this.turnUsage;
          const hadUsage = usage.messages > 0;
          this.turnUsage = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, messages: 0 };
          /*
           * 每个 turn 结束都回调，包括启动时追平到的历史 turn。
           *
           * 为什么历史也要回调：账本（src/usage-today.js）需要"今日累计"，
           * 而桌宠可能是在当天中途才起来的（升级重启、开机晚于 DSH），
           * 只算起来之后的 turn 会明显少一截。历史账由调用方按 `historical`
           * 决定**只入账不播报**；账本按 `会话#turn` 去重，重复回放不会算两遍。
           */
          if (hadUsage) {
            this.onTurnEnd({
              turn: data.turn ?? this.turn ?? null,
              usage,
              reason: data.reason ?? null,
              // 用记录自己的时间而不是 Date.now()：历史账要归到它发生的那一天
              at: typeof record.time === 'number' ? record.time : Date.now(),
              session: this.filePath ? path.basename(path.dirname(this.filePath)) : null,
              historical: !this.primed,
              // 这个 turn 用的模型（价目表按模型取价；没读到就是 null）
              model: this.model || null,
            });
          }
          break;
        }
        case 'tool/call':
          this.toolName = typeof data.name === 'string' ? data.name : null;
          break;
        /*
         * 当前用的是哪个模型：`request/header` 里带着
         *   data.header.config = { provider, model, reasoningEffort, maxTokens }
         * （`assistant/message` 里没有模型名，只有这处有）
         * 价目表要按模型取价，所以顺手记下来，随 onTurnEnd 一起交出去。
         */
        case 'request/header': {
          const model = data.header && data.header.config ? data.header.config.model : null;
          if (typeof model === 'string' && model) {
            if (this.model !== model) this.log('[dsh] model', model);
            this.model = model;
          }
          break;
        }
        case 'tool/result':
          if (data.error) {
            this.flash = 'failure';
            this.flashUntil = Date.now() + this.flashMs;
          }
          break;
        default:
          break;
      }
      this.lastType = type;
    }
  }

  recompute(now) {
    let state = 'idle';
    let tool = null;

    /*
     * 「忙」是派生量，不是写回状态：
     *   busy = 处在某个 turn 内 && 最近还在写记录
     *
     * 踩过的坑：早期版本在这里把 this.inTurn 直接置 false 来兜底"DSH 挂了"，
     * 结果启动时只吃到前 400 帧（那一批还在几十个 turn 之前），lastRecordAt 很旧
     * → 判定 stale → inTurn 被永久清掉。而最后那个 turn/start 早已在前一批被消费，
     * 后面全是 turn 内的记录，再没有 turn/start 来恢复它 —— 于是永远报 idle。
     * 所以 stale 必须只是本次判定的一部分，绝不能改写 inTurn。
     */
    const caughtUp = this.offset >= this.size;
    const idleTooLong = caughtUp && this.lastRecordAt > 0 && now - this.lastRecordAt > this.idleAfterMs;

    if (this.inTurn && !idleTooLong) {
      if (this.lastType === 'tool/call') {
        state = 'tool';
        tool = this.toolName;
      } else {
        state = 'thinking';
      }
    }

    if (state === 'idle' && this.flash && now < this.flashUntil) {
      state = this.flash;
      this.flash = null; // 一闪即过，避免重复触发
    }

    this.publish({ state, tool, turn: this.turn ?? null, at: now, session: this.filePath ? path.basename(path.dirname(this.filePath)) : null, source: 'session' });
  }

  publish(next) {
    const prev = this.state;
    const changed = prev.state !== next.state || prev.tool !== next.tool || prev.session !== next.session;
    this.state = next;
    if (changed) {
      this.log('[dsh] state', next.state, next.tool ? `tool=${next.tool}` : '');
      this.onChange(next);
    }
  }
}

module.exports = { DshStateWatcher, findActiveSession, sessionsRoot };
