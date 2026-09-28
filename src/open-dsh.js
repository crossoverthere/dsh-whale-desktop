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
 *   2) **没在跑**：把它拉起来，等它应答，再打开浏览器。
 *
 * 拉起这件事有三个坑，每一个都踩过：
 *
 *   · **不能挂在自己的进程树/控制台里**。桌宠是 GUI 进程，直接 spawn 出来的
 *     `cmd.exe /c dsh ...` 会共享一个隐藏控制台，一旦有人往那个控制台发
 *     CTRL_C（或被控制台关闭事件带走），服务就死得莫名其妙 —— 实测日志里只有
 *     一个 `^C`、退出码 0xC000013A（STATUS_CONTROL_C_EXIT），什么错误都没有。
 *     所以现在走 **PowerShell 的 Start-Process -WindowStyle Hidden**：
 *     进程由 shell 创建、自己一个隐藏窗口，桌宠退出或被 Ctrl+C 都不会牵连它。
 *   · **环境要干净**。`DSH_SHELL` / `DSH_SESSION_ID` / `DSH_WEB_URL` 描述的是
 *     "我正在哪个会话里"，对一个**新起的服务**是错的（会让它去连一个正在跑的
 *     会话）。拉起前一律摘掉，DSH_HOME 之类的保留。
 *   · **首选用户自己的启动脚本**。工作空间里那个
 *     `Start-DSH-Web-Background.bat` 是用户机器上一直在用的 launcher
 *     （它自己会检查端口、自己落日志），能用就用它。
 *
 * 本文件不 require electron：能纯 node 跑，便于脚本化验证。
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** DSH 网页界面的默认地址（web profile 的默认监听）。 */
const DEFAULT_DSH_URL = 'http://127.0.0.1:3080';
/** DSH web profile 的默认端口：用户脚本不接受 --port，只有这个端口才敢用脚本。 */
const DEFAULT_DSH_PORT = '3080';
/** 拉起服务后等多久算失败：冷启动实测 6 秒左右，但机器忙 / npx 兜底会更久。 */
const DEFAULT_BOOT_TIMEOUT_MS = 60000;
/** 就绪探测的间隔。 */
const POLL_INTERVAL_MS = 600;
/** 探活超时：本机回环地址，慢到 1.2 秒还没应答就是没有服务。 */
const PROBE_TIMEOUT_MS = 1200;
/** 读日志尾巴的字节数（只是找一行 token 地址 / 看一条报错，不需要整份）。 */
const LOG_TAIL_BYTES = 8192;
/** 服务输出文件名（我们的 dsh-web.log；工作空间脚本也把日志写在这个名字上）。 */
const SERVICE_LOG_NAME = 'dsh-web.log';
/** 工作空间里"后台启动脚本"的名字（这两个是这台机器上一直在用的 launcher）。 */
const START_SCRIPT_NAMES = ['Start-DSH-Web-Background.bat', 'Start-DSH-Web-Background.cmd'];
/**
 * 拉起服务前要从环境里摘掉的变量。
 *
 * 它们描述的是"我正处在哪个 DSH 会话里"：对一个**新起的服务**毫无意义，
 * 反而会让它以为自己属于那个会话。桌宠自己可能就是从一个 DSH 会话里被叫起来的
 * （比如被工具启动），于是这些标记会一路继承下去。
 */
const SESSION_ENV_KEYS = ['DSH_SHELL', 'DSH_SESSION_ID', 'DSH_WEB_URL'];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 读环境变量，**大小写不敏感**。
 *
 * 为什么不能直接 `env.PATH`：Windows 的环境变量名本来就不分大小写，
 * 而 `process.env` 是个大小写不敏感的特例对象；一旦把它 `{...}` 拷成普通对象
 * （我们到处都这么干，为了改一个键不动原环境），`PATH` / `Path` 就对不上了 ——
 * 实测这台机器上拷出来的是 `Path`，于是 `env.PATH` 取到 undefined，
 * 找 node.exe 一路失败、悄悄退化成最慢的 npx 兜底。
 */
function envGet(env, name) {
  if (!env) {
    return '';
  }
  if (env[name] !== undefined) {
    return env[name];
  }
  const upper = String(name).toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper) {
      return env[key];
    }
  }
  return '';
}

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
  const fromEnv = String(envGet(env, 'DSH_WEB_URL') || '').trim();
  if (fromEnv) {
    return normalizeUrl(fromEnv);
  }
  return DEFAULT_DSH_URL;
}

/**
 * 探活：只要 HTTP 有应答就算"在跑"（401 也算）。
 * 超时 / 连不上 → false。刻意不用 fetch：这个判定要能在轮询里反复发起。
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

/** 读文件尾巴（token 行 / 报错都在末尾；日志可能已经很长了）。 */
function readTextTail(file, maxBytes = LOG_TAIL_BYTES) {
  try {
    if (!file) {
      return '';
    }
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

/** 在 PATH 里找一个可执行文件（Windows 上要带上 .cmd/.exe 后缀）。 */
function findOnPath(env, exists, names) {
  const raw = String(envGet(env, 'PATH') || '');
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
 * 其次 PATH 里的 dsh.cmd。顺便算出它对应的 `lib/bin.js`
 * —— 能直接跑 bin.js 就不必经 cmd.exe（少一层引号与控制台麻烦）。
 */
function findDshShim(env, exists) {
  const homes = [envGet(env, 'APPDATA'), envGet(env, 'LOCALAPPDATA')];
  for (const home of homes) {
    if (!home) continue;
    const shim = path.join(String(home), 'npm', 'dsh.cmd');
    if (exists(shim)) {
      return {
        file: shim,
        source: 'npm-shim',
        bin: path.join(path.dirname(shim), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      };
    }
  }
  const onPath = findOnPath(env, exists, ['dsh.cmd', 'dsh.bat', 'dsh']);
  return onPath ? { file: onPath, source: 'path', bin: null } : null;
}

/** 这个路径看起来是不是"一个可以直接执行的程序/脚本"。 */
function isScriptPath(file) {
  return /\.(bat|cmd|ps1|exe)$/i.test(String(file || '').trim());
}

/** 在"程序目录 / 它的上级（工作空间根）"里找工作空间启动脚本。 */
function findStartScript(root, exists) {
  const dirs = [];
  for (const dir of [root, root ? path.dirname(root) : '']) {
    if (dir && !dirs.includes(dir)) {
      dirs.push(dir);
    }
  }
  for (const dir of dirs) {
    for (const name of START_SCRIPT_NAMES) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/** 摘掉"我正在某个会话里"的环境变量（见 SESSION_ENV_KEYS 的说明）。 */
function dropSessionEnv(env) {
  const clean = { ...(env || {}) };
  const drop = SESSION_ENV_KEYS.map((key) => key.toUpperCase());
  for (const key of Object.keys(clean)) {
    if (drop.includes(key.toUpperCase())) {
      delete clean[key];
    }
  }
  return clean;
}

/**
 * 「怎么把 DSH 拉起来」→ 一个启动计划。
 *
 * 返回 { kind, source, file, args, cwd, logPath, errPath, redirect }：
 *   kind: 'script'（用户 / 工作空间的启动脚本，原样跑，不追加参数）
 *       | 'node'  （直接 `node <dsh>/lib/bin.js web …`，不过 cmd.exe）
 *       | 'cli'   （`cmd /c <dsh.cmd> web …`，或 npx 兜底）
 *
 * 优先级：用户配置 → 工作空间启动脚本 → dsh CLI。
 * 只有"地址就是 DSH 默认端口"时才用脚本 —— 脚本不接受 --port，
 * 免得"要打开的地址"和"服务监听的端口"各说各话。
 */
function resolveLaunchPlan(options = {}) {
  const url = normalizeUrl(options.url || DEFAULT_DSH_URL);
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const exists = options.exists || ((file) => fs.existsSync(file));
  const root = options.root || '';
  const logDir = options.logDir || root || process.cwd();
  const override = String(options.override == null ? '' : options.override).trim();
  const port = urlPort(url);
  const cliArgs = ['web', '--no-open', ...(port ? ['--port', port] : [])];
  const logPath = path.join(logDir, SERVICE_LOG_NAME);
  const errPath = path.join(logDir, SERVICE_LOG_NAME.replace(/\.log$/, '.err.log'));

  /** 脚本路线：脚本自己会 cd、自己会落日志，我们原样执行。 */
  const scriptPlan = (script, source) => {
    const dir = path.dirname(script);
    const scriptLog = path.join(dir, SERVICE_LOG_NAME);
    const base = { kind: 'script', source, cwd: dir, logPath: scriptLog, errPath: null, redirect: false, url, script };
    if (/\.ps1$/i.test(script)) {
      return { ...base, file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] };
    }
    if (/\.exe$/i.test(script)) {
      return { ...base, file: script, args: [] };
    }
    return { ...base, file: 'cmd.exe', args: ['/c', `"${script}"`] };
  };

  // ① 用户自己指定的：可以是命令，也可以是启动脚本
  if (override) {
    if (isScriptPath(override)) {
      return scriptPlan(override, 'custom-script');
    }
    if (platform === 'win32') {
      return {
        kind: 'cli', source: 'custom',
        file: 'cmd.exe', args: ['/c', `"${override}"`, ...cliArgs],
        cwd: path.dirname(override) || root, logPath, errPath, redirect: true, url,
      };
    }
    return { kind: 'cli', source: 'custom', file: override, args: cliArgs, cwd: root, logPath, errPath, redirect: true, url };
  }

  // ② 工作空间里的启动脚本
  if (platform === 'win32' && (!port || port === DEFAULT_DSH_PORT)) {
    const script = findStartScript(root, exists);
    if (script) {
      return scriptPlan(script, 'workspace-script');
    }
  }

  // ③ 自己拼 dsh 命令
  if (platform === 'win32') {
    const shim = findDshShim(env, exists);
    const nodeExe = findOnPath(env, exists, ['node.exe']);
    if (shim && shim.bin && exists(shim.bin) && nodeExe) {
      return {
        kind: 'node', source: shim.source,
        file: nodeExe, args: [shim.bin, ...cliArgs],
        cwd: root || logDir, logPath, errPath, redirect: true, url,
      };
    }
    if (shim) {
      return {
        kind: 'cli', source: shim.source,
        file: 'cmd.exe', args: ['/c', `"${shim.file}"`, ...cliArgs],
        cwd: path.dirname(shim.file), logPath, errPath, redirect: true, url,
      };
    }
    return {
      kind: 'cli', source: 'npx',
      file: 'cmd.exe', args: ['/c', 'npx', '--yes', '@deepseek-ai/dsh', ...cliArgs],
      cwd: root || logDir, logPath, errPath, redirect: true, url,
    };
  }

  const onPath = findOnPath(env, exists, ['dsh']);
  if (onPath) {
    return { kind: 'cli', source: 'path', file: onPath, args: cliArgs, cwd: root, logPath, errPath, redirect: true, url };
  }
  return {
    kind: 'cli', source: 'npx',
    file: 'npx', args: ['--yes', '@deepseek-ai/dsh', ...cliArgs],
    cwd: root, logPath, errPath, redirect: true, url,
  };
}

/** PowerShell 单引号字面量。 */
function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 交接脚本：让 **shell**（而不是我们）创建那个进程。
 *
 * `Start-Process -WindowStyle Hidden` 起的进程有自己的隐藏窗口 / 控制台，
 * 不在桌宠的控制台里 —— 这是"别人按 Ctrl+C 不该杀掉刚拉起来的 DSH"的关键。
 * 顺带回传 PID，后面用它做"早死了就早报错"。
 */
function buildHandoffScript(plan, options = {}) {
  const args = (plan.args || []).map((arg) => {
    const text = String(arg);
    return psLiteral(/\s/.test(text) ? `"${text}"` : text);
  });
  const lines = ["$ErrorActionPreference = 'Stop'"];
  let call =
    `$proc = Start-Process -FilePath ${psLiteral(plan.file)}` +
    (args.length ? ` -ArgumentList ${args.join(', ')}` : '') +
    ` -WorkingDirectory ${psLiteral(plan.cwd || options.cwd || '.')}`;

  // 脚本路线不重定向：脚本自己会 >> 它自己的日志，我们再接一手会两边抢同一个文件
  if (plan.redirect !== false && plan.logPath) {
    call += ` -RedirectStandardOutput ${psLiteral(plan.logPath)}`;
    if (plan.errPath) {
      call += ` -RedirectStandardError ${psLiteral(plan.errPath)}`;
    }
  }
  call += ' -WindowStyle Hidden -PassThru';
  lines.push(call);
  lines.push("Write-Output ('DSHLAUNCHPID=' + $proc.Id)");
  return lines.join('\r\n');
}

/** 收集一个短命子进程的输出（PowerShell 交接器就该秒退）。 */
function collect(child, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经退了 */
      }
      done({ code: null, stdout, stderr: `${stderr}(交接器超时)`, failed: true });
    }, Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    function done(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }
    child.on('error', (error) => done({ code: null, stdout, stderr: `${stderr}${error.message}`, failed: true }));
    child.on('exit', (code) => done({ code, stdout, stderr, failed: false }));
  });
}

/**
 * 真正把服务拉起来。返回 { ok, pid, via, script } 或 { ok:false, error, ... }。
 *
 * Windows 走 PowerShell 交接；其他平台直接 detached spawn（那边的进程组语义不同，
 * 没有"共享一个控制台"这回事）。
 */
async function launchDshService(options = {}) {
  const plan = options.plan;
  if (!plan || !plan.file) {
    return { ok: false, error: 'no-plan' };
  }
  const platform = options.platform || process.platform;
  const spawnImpl = options.spawnImpl || spawn;
  const env = dropSessionEnv(options.env || process.env);

  if (platform !== 'win32') {
    let out = null;
    let err = null;
    try {
      fs.mkdirSync(path.dirname(plan.logPath), { recursive: true });
      out = fs.openSync(plan.logPath, 'a');
      err = plan.errPath ? fs.openSync(plan.errPath, 'a') : out;
      const child = spawnImpl(plan.file, plan.args, {
        cwd: plan.cwd,
        detached: true,
        stdio: ['ignore', out, err],
        env,
      });
      child.unref();
      return { ok: true, pid: child.pid, via: 'direct', script: null };
    } catch (error) {
      return { ok: false, error: 'spawn-failed', detail: error.message };
    } finally {
      if (out !== null) fs.closeSync(out);
      if (err !== null && err !== out) fs.closeSync(err);
    }
  }

  const script = buildHandoffScript(plan, { cwd: options.cwd });
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawnImpl(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env }
  );
  const result = await collect(child, options.handoffTimeoutMs);
  const pid = Number((/\bDSHLAUNCHPID=(\d+)/.exec(result.stdout) || [])[1]);
  if (!pid) {
    return {
      ok: false,
      error: 'handoff-failed',
      code: result.code,
      detail: `${String(result.stderr || '').trim()} ${String(result.stdout || '').trim()}`.trim(),
      script,
    };
  }
  return { ok: true, pid, via: 'powershell-handoff', script };
}

/** 进程还活着吗（用 signal 0 探活；EPERM 表示活着但不是我们的）。 */
function pidAlive(pid) {
  const target = Number(pid);
  if (!Number.isFinite(target) || target <= 0) {
    return false;
  }
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM';
  }
}

/**
 * 轮询等它应答。
 *
 * `onTick` 在每次"还没起来"之后调一次 —— 主进程用它顺手从日志里捞 token 地址、
 * 看进程是不是已经死了（死了就别再等满超时）。
 * `shouldStop` 返回 true 时立刻放弃（配合 onTick 实现"早死早报错"）。
 * 返回 true = 已应答；false = 超时或提前放弃。
 */
async function waitForDshWeb(options = {}) {
  const url = normalizeUrl(options.url || DEFAULT_DSH_URL);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_BOOT_TIMEOUT_MS;
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : POLL_INTERVAL_MS;
  const probe = typeof options.probe === 'function' ? options.probe : (target) => probeDshWeb(target);
  const onTick = typeof options.onTick === 'function' ? options.onTick : null;
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : null;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await probe(url)) {
      return true;
    }
    if (onTick) {
      onTick();
    }
    if (shouldStop && shouldStop()) {
      return false;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(Math.min(intervalMs, Math.max(50, deadline - Date.now())));
  }
}

module.exports = {
  DEFAULT_DSH_URL,
  DEFAULT_DSH_PORT,
  DEFAULT_BOOT_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  SERVICE_LOG_NAME,
  START_SCRIPT_NAMES,
  SESSION_ENV_KEYS,
  normalizeUrl,
  resolveDshUrl,
  envGet,
  probeDshWeb,
  extractTokenUrl,
  readTextTail,
  findOnPath,
  findDshShim,
  isScriptPath,
  findStartScript,
  dropSessionEnv,
  resolveLaunchPlan,
  buildHandoffScript,
  launchDshService,
  pidAlive,
  waitForDshWeb,
};
