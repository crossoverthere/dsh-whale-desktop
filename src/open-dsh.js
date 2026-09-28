'use strict';

/**
 * 「打开DSH」—— 桌宠右键菜单里的那一条（启动 / 唤起 DSH 网页界面）。
 *
 * 两种情况分开处理：
 *
 *   1) **已经在跑**：直接在默认浏览器里打开它的地址。
 *      判断只看"HTTP 有没有应答"，**401 也算在跑** —— DSH 的 browser-trust 会
 *      拒绝没有 cookie 的请求（实测无 cookie 访问根路径就是 401），而用户的浏览器
 *      里本来就有那个 cookie。把 401 当"没在跑"，就会平白再拉一个服务起来，
 *      那比"打开一个可能认证失败的页面"糟得多。
 *
 *   2) **没在跑**：detached 拉起 `dsh web --no-open`，等它应答，再打开浏览器。
 *      加 `--no-open` 是刻意的：浏览器由**我们**开，才能把"起没起来"回报给桌宠页面
 *      （她会说一句成功/失败），也让"只弹一个窗口"成为确定行为。
 *
 * 本文件不 require electron：能纯 node 跑，便于脚本化验证。
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

/** DSH 网页界面的默认地址（web profile 的默认监听）。 */
const DEFAULT_DSH_URL = 'http://127.0.0.1:3080';
/** 拉起服务后等多久算失败：真机冷启动约 5 秒，留足余量。 */
const DEFAULT_BOOT_TIMEOUT_MS = 30000;
/** 就绪探测的间隔。 */
const POLL_INTERVAL_MS = 600;
/** 探活超时：本机回环地址，慢到 1.2 秒还没应答就是没有服务。 */
const PROBE_TIMEOUT_MS = 1200;
/** 读日志尾巴的字节数（只是找一行 token 地址，不需要整份）。 */
const LOG_TAIL_BYTES = 8192;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 把用户填的地址补成可用的 base URL：缺协议就补 http://、去掉结尾斜杠与 hash。
 * 查询串**保留** —— 别人给的地址里可能已经带着 token。
 * 填了不合法的东西就退回默认地址，而不是让 url 变成 "http://" 这种残废值。
 */
function normalizeUrl(raw, fallback = DEFAULT_DSH_URL) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) {
    return fallback;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname) {
      return fallback;
    }
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${pathname}${url.search}`;
  } catch {
    return fallback;
  }
}

/**
 * 用户配置的地址 → 实际要用的地址。
 * 配置为空时依次退回 DSH_WEB_URL 环境变量、内置默认值。
 */
function resolveDshUrl(options = {}) {
  const configured = String(options.configured == null ? '' : options.configured).trim();
  if (configured) {
    return normalizeUrl(configured);
  }
  const env = options.env || process.env;
  const fromEnv = String((env && env.DSH_WEB_URL) || '').trim();
  if (fromEnv) {
    return normalizeUrl(fromEnv);
  }
  return DEFAULT_DSH_URL;
}

/**
 * 探活：只要 HTTP 有应答就算"在跑"（401 也算）。
 * 超时/连不上 → false。刻意不用 fetch：这个判定必须能在主进程里同步发起多次轮询。
 */
function probeDshWeb(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request;
    try {
      request = http.get(url, { timeout: timeoutMs }, (response) => {
        response.resume();
        done(true);
      });
    } catch {
      done(false);
      return;
    }
    request.on('timeout', () => {
      request.destroy();
      done(false);
    });
    request.on('error', () => done(false));
  });
}

/** 地址里显式写的端口（没写就返回空串）。 */
function urlPort(url) {
  try {
    return new URL(normalizeUrl(url)).port || '';
  } catch {
    return '';
  }
}

/**
 * 从 `dsh web` 的输出里取回**带 token 的**地址。
 *
 * 服务每次启动都生成新 token，旧 token 一律 401（实测把日志里上一轮的 token 拿来
 * 访问正在跑的服务，两个都是 401）。所以只有"自己拉起来的"这一次能拿到可直接
 * 用浏览器打开的地址；已经在跑的那个只能靠浏览器里的 cookie。
 */
function extractTokenUrl(text) {
  const matches = String(text == null ? '' : text).match(
    /https?:\/\/[^\s"'<>]*[?&]token=[A-Za-z0-9._~-]+/g
  );
  return matches && matches.length ? matches[matches.length - 1] : null;
}

/** 读文件尾巴（token 行在最末尾；日志可能已经很长了）。 */
function readTextTail(file, maxBytes = LOG_TAIL_BYTES) {
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, maxBytes);
    if (size <= 0) {
      return '';
    }
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, stat.size - size);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** 在 PATH 里找一个可执行文件（Windows 上要带上 .cmd 后缀）。 */
function findOnPath(env, exists, names) {
  const raw = String((env && env.PATH) || '');
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * 找 npm 全局装的 dsh CLI：优先 APPDATA / LOCALAPPDATA 下的 shim，
 * 其次 PATH 里的 dsh.cmd。找不到就交给调用方退回 npx。
 */
function findDshShim(env, exists) {
  const homes = [env && env.APPDATA, env && env.LOCALAPPDATA];
  for (const home of homes) {
    if (!home) continue;
    const candidate = path.join(String(home), 'npm', 'dsh.cmd');
    if (exists(candidate)) {
      return { file: candidate, source: 'npm-shim' };
    }
  }
  const onPath = findOnPath(env, exists, ['dsh.cmd', 'dsh.bat', 'dsh']);
  return onPath ? { file: onPath, source: 'path' } : null;
}

/**
 * 「怎么把 DSH 拉起来」→ { source, command, args }。
 *
 * 一律走 `web --no-open` 并显式带上端口（地址里写了端口就带上），
 * 这样"要打开的地址"和"服务监听的端口"不会各说各话。
 * Windows 上 .cmd/.bat 必须经 cmd.exe，node 的 spawn 不能直接执行批处理。
 */
function resolveDshCommand(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const exists = options.exists || ((file) => fs.existsSync(file));
  const port = urlPort(options.url || DEFAULT_DSH_URL);
  const wants = ['web', '--no-open', ...(port ? ['--port', port] : [])];
  const override = String(options.override == null ? '' : options.override).trim();

  if (override) {
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(override)) {
      return { source: 'custom', command: 'cmd.exe', args: ['/c', override, ...wants] };
    }
    return { source: 'custom', command: override, args: wants };
  }

  if (platform === 'win32') {
    const shim = findDshShim(env, exists);
    if (shim) {
      return { source: shim.source, command: 'cmd.exe', args: ['/c', shim.file, ...wants] };
    }
    return {
      source: 'npx',
      command: 'cmd.exe',
      args: ['/c', 'npx', '--yes', '@deepseek-ai/dsh', ...wants],
    };
  }

  const onPath = findOnPath(env, exists, ['dsh']);
  if (onPath) {
    return { source: 'path', command: onPath, args: wants };
  }
  return { source: 'npx', command: 'npx', args: ['--yes', '@deepseek-ai/dsh', ...wants] };
}

/**
 * 轮询等它应答。
 *
 * `onTick` 在每次"还没起来"之后调一次 —— 主进程用它顺手从日志里捞 token 地址，
 * 不用把文件读取塞进这个纯逻辑里。
 * 返回 true = 已应答；false = 超时。
 */
async function waitForDshWeb(options = {}) {
  const url = normalizeUrl(options.url || DEFAULT_DSH_URL);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_BOOT_TIMEOUT_MS;
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : POLL_INTERVAL_MS;
  const probe = typeof options.probe === 'function' ? options.probe : (target) => probeDshWeb(target);
  const onTick = typeof options.onTick === 'function' ? options.onTick : null;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await probe(url)) {
      return true;
    }
    if (onTick) {
      onTick();
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(Math.min(intervalMs, Math.max(50, deadline - Date.now())));
  }
}

module.exports = {
  DEFAULT_DSH_URL,
  DEFAULT_BOOT_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  normalizeUrl,
  resolveDshUrl,
  probeDshWeb,
  extractTokenUrl,
  readTextTail,
  findDshShim,
  resolveDshCommand,
  waitForDshWeb,
};
