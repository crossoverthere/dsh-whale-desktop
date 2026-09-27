'use strict';

/**
 * 内置余额代理。
 *
 * 为什么需要它：上游桌宠把余额接口写死成 `http://127.0.0.1:3020/balance`，
 * 而 DeepSeek 官方接口的字段名和它要的形状**不一样**：
 *
 *   DeepSeek 官方 GET https://api.deepseek.com/user/balance
 *     → { is_available, balance_infos: [ { currency, total_balance, granted_balance, topped_up_balance } ] }
 *
 *   上游要的形状
 *     → { ok: true, balances: [ { currency, totalBalance } ] }
 *
 * 这个模块做三件事：取 Key、转字段、补 CORS 头。
 *
 * CORS 是硬要求：桌宠页面源是 http://127.0.0.1:<port>，而代理在 3020，
 * 属于跨源；少了 Access-Control-Allow-Origin 浏览器会静默拦掉，
 * 表现就是"余额不可用"，只有控制台会说原因。
 *
 * Key 的取法（按优先级）：
 *   1. 环境变量 DEEPSEEK_API_KEY
 *   2. DSH 凭据库 ~/.dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY（明文）
 *   3. 用户数据目录下的 balance-key.txt（手动兜底）
 * 只在本进程内存里使用，不落盘、不写日志、不随仓库分发。
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UPSTREAM = 'https://api.deepseek.com/user/balance';
const DEFAULT_PORT = 3020;

/** 从 DSH 凭据库里取明文 Key（只做一次定点匹配，不解析整份 YAML）。 */
function readDshCredentialsKey(home = os.homedir()) {
  try {
    const file = path.join(home, '.dsh', '.credentials.yaml');
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/(?:^|\n)\s*DEEPSEEK_API_KEY:\s*['"]?([^'"\s]+)['"]?\s*(?:\n|$)/);
    if (match && match[1] && match[1] !== 'null') {
      return { key: match[1], source: 'dsh-credentials' };
    }
  } catch (error) {
    /* 文件不存在或读不了都正常 */
  }
  return null;
}

/** 手动兜底：用户数据目录下的 balance-key.txt。 */
function readManualKey(userDataDir) {
  try {
    if (!userDataDir) return null;
    const file = path.join(userDataDir, 'balance-key.txt');
    const key = fs.readFileSync(file, 'utf8').trim();
    if (key) return { key, source: 'balance-key.txt' };
  } catch (error) {
    /* 没有就没有 */
  }
  return null;
}

/**
 * @param {string} [userDataDir] 手动 Key 文件的所在目录（Electron 的 userData）
 * @returns {{ key: string, source: string } | null}
 */
function resolveApiKey(userDataDir) {
  const fromEnv = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (fromEnv) {
    return { key: fromEnv, source: 'env:DEEPSEEK_API_KEY' };
  }
  return readDshCredentialsKey() || readManualKey(userDataDir);
}

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // 跨源访问必须放行，否则页面里的 fetch 会被浏览器拦掉
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

/**
 * 启动代理。端口被占用等失败情况由调用方决定是否致命（默认不致命）。
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void>, keySource: string|null }>}
 */
function startBalanceProxy(options = {}) {
  const port = options.port || DEFAULT_PORT;
  const log = options.log || (() => {});
  const userDataDir = options.userDataDir;

  const server = http.createServer(async (req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch (error) {
      return json(res, 400, { ok: false, error: 'bad-request' });
    }

    if (req.method === 'OPTIONS') {
      return json(res, 204, {});
    }

    if (pathname === '/health') {
      const resolved = resolveApiKey(userDataDir);
      return json(res, 200, {
        ok: true,
        service: 'dsh-whale-desktop balance proxy',
        hasKey: Boolean(resolved),
        keySource: resolved ? resolved.source : null,
      });
    }

    if (pathname !== '/balance') {
      return json(res, 404, { ok: false, error: 'not-found' });
    }

    const resolved = resolveApiKey(userDataDir);
    if (!resolved) {
      log('no DeepSeek key found (env / dsh credentials / balance-key.txt)');
      return json(res, 200, { ok: false, error: 'no-key' });
    }

    try {
      const upstream = await fetch(UPSTREAM, {
        headers: { Authorization: `Bearer ${resolved.key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!upstream.ok) {
        throw new Error(`upstream HTTP ${upstream.status}`);
      }
      const data = await upstream.json();
      const list = Array.isArray(data.balance_infos) ? data.balance_infos : [];
      const balances = list.map((item) => ({
        currency: item.currency,
        totalBalance: Number(item.total_balance),
        grantedBalance: Number(item.granted_balance ?? 0),
        toppedUpBalance: Number(item.topped_up_balance ?? 0),
      }));
      // 注意：这里用"有没有余额条目"判定 ok，而不是上游的 is_available ——
      // 余额为 0 也是有效信息，应该正常显示，而不是整块变成"不可用"。
      return json(res, 200, {
        ok: balances.length > 0,
        available: Boolean(data.is_available),
        balances,
        source: resolved.source,
        at: Date.now(),
      });
    } catch (error) {
      log('upstream failed:', error.message);
      return json(res, 200, { ok: false, error: error.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      const resolved = resolveApiKey(userDataDir);
      log(`listening on http://127.0.0.1:${actual}/balance (key: ${resolved ? resolved.source : '未找到'})`);
      resolve({
        url: `http://127.0.0.1:${actual}/balance`,
        port: actual,
        keySource: resolved ? resolved.source : null,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { startBalanceProxy, resolveApiKey, readDshCredentialsKey, DEFAULT_PORT };

// 也支持独立运行：node src/balance-proxy.js
if (require.main === module) {
  startBalanceProxy({ log: (...args) => console.log('[balance]', ...args) }).then(
    (proxy) => console.log(`[balance] ready: ${proxy.url}`),
    (error) => {
      console.error('[balance] failed to start:', error.message);
      process.exit(1);
    }
  );
}
