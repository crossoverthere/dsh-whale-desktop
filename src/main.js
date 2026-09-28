'use strict';

/**
 * 鲸鱼娘桌宠 —— Electron 主进程。
 *
 * 形态取舍（为什么是"整屏透明窗口"而不是"桌宠大小的窗口"）：
 *   上游桌宠是 position:fixed + 视口坐标定位，位置存在 localStorage 的
 *   whale-moe:floatX / floatY，拖拽逻辑也在它自己手里。
 *   如果把窗口做成桌宠那么大，它一拖就会被窗口边缘裁掉。
 *   把窗口铺满工作区、保持透明并默认点击穿透，则它的定位/拖拽/右键菜单/
 *   齿轮设置面板全部零改动可用 —— 这是改动量最小、行为最忠实宿主。
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, globalShortcut, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { startPetServer } = require('./server');
const { DshStateWatcher } = require('./dsh-state');
const { startBalanceProxy } = require('./balance-proxy');
const { costOf, shouldAnnounce, announceText, formatTokens, formatMoney, isPeak } = require('./pricing');
const { loadTable, resolveRates, readDshModel, lookupModel } = require('./price-table');
const { UsageLedger } = require('./usage-today');
const {
  DEFAULT_DSH_URL,
  DEFAULT_BOOT_TIMEOUT_MS,
  normalizeUrl,
  resolveDshUrl,
  probeDshWeb,
  extractTokenUrl,
  readTextTail,
  resolveDshCommand,
  waitForDshWeb,
} = require('./open-dsh');

/** 内置余额代理（见 src/balance-proxy.js）。 */
let balanceProxy = null;

/** 「今日消耗」账本（见 src/usage-today.js）：余额查询要报今天一整天的量。 */
let usageLedger = null;

/** 本地价目表（见 pricing.json 与 src/price-table.js）：运行时只读，不联网。 */
let priceTable = loadTable();
/** 当前模型：会话记录里的 request/header 优先，其次 DSH 设置文件里的默认模型。 */
let currentModel = readDshModel() || '';
/** 上一次播报用的取价方式，用来只在"取价依据变了"时打一行日志。 */
let lastRateSource = '';

const ROOT = path.join(__dirname, '..');
const PET_DIR = path.join(__dirname, 'pet');
const VENDOR_DIR = path.join(ROOT, 'vendor', 'whale');

// 必须在 app ready 之前定名：否则 userData 目录会用 productName（中文），
// 日志/配置路径带中文会给脚本化排查添麻烦。
app.setName('dsh-whale-desktop');

/*
 * Windows 上关闭 Chromium 的"原生窗口遮挡检测"。
 *
 * 为什么必须关：桌宠窗口是**整屏 + 置顶**的，遮挡检测会把其它窗口判定为
 * "被完全遮住"，于是**停止为它们出帧** —— 表现就是设置窗口打开后一片空白，
 * 点一下窗口（触发交互/重绘）内容才出现。
 * 追加而不是覆盖，避免踩掉 Electron/Chromium 自己设的 disable-features。
 */
{
  const existing = app.commandLine.getSwitchValue('disable-features');
  const merged = existing ? `${existing},CalculateNativeWinOcclusion` : 'CalculateNativeWinOcclusion';
  app.commandLine.appendSwitch('disable-features', merged);
}

const argv = process.argv.slice(1);
const argValue = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const SHOT_MODE = argValue('shot') !== undefined;
const MENU_PROBE = argValue('menu-probe') !== undefined;
const DSH_PROBE = argValue('dsh-probe') !== undefined;
const SETTINGS_PROBE = argValue('settings-probe') !== undefined;
const GROWTH_PROBE = argValue('growth-probe') !== undefined;
const SAY_PROBE = argValue('say-probe') !== undefined;
const OPEN_DSH_PROBE = argValue('open-dsh-probe') !== undefined;
/** 自检用：强制跳过单实例锁，便于与常驻实例并存做封闭测试。 */
const STANDALONE = argValue('standalone') !== undefined;
/** 自检用：临时覆盖监听端口，避免与常驻实例抢同一个源。 */
const PORT_OVERRIDE = Number(argValue('port')) > 0 ? Number(argValue('port')) : null;
/** shot / menu-probe / standalone 都是自检模式，要允许与常驻实例并存。 */
const PROBE_MODE =
  SHOT_MODE || MENU_PROBE || STANDALONE || DSH_PROBE || SETTINGS_PROBE || GROWTH_PROBE || SAY_PROBE || OPEN_DSH_PROBE;
/**
 * 「打开DSH」只演练、不真开浏览器。
 *
 * 任何自检模式都算演练 —— 否则跑一次探针就会往用户桌面上弹一个浏览器窗口，
 * 那是拿他的桌面当测试场地。`--open-dsh-dry` 给人工演练用。
 */
const OPEN_DSH_DRY = PROBE_MODE || argValue('open-dsh-dry') !== undefined;

let win = null;
let tray = null;
let server = null;
let config = null;
let isQuitting = false;

/** 自检用运行时状态：外部脚本可经 /__shell/state 读取。 */
const shellState = { interactive: false, petRect: null, updatedAt: 0 };
/** DSH 工作状态读取器（读会话文件，见 src/dsh-state.js）。 */
let dshWatcher = null;
/** 最近一次推给页面的 DSH 状态。 */
let lastDshState = { state: 'idle', tool: null, at: 0 };

// ---------------------------------------------------------------- 日志
function logFile() {
  return path.join(app.getPath('userData'), 'shell.log');
}
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    fs.appendFileSync(logFile(), line + '\n');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

// ---------------------------------------------------------------- 配置
const DEFAULT_CONFIG = {
  port: 38911,
  scale: 1,
  alwaysOnTop: true,
  autoLaunch: false,
  visible: true,
  /** 是否跟随 DSH 的工作状态（读会话文件）。 */
  followDsh: true,
  /**
   * 任务结束后用台词播报本次花费。阈值以下的零头不打扰（默认 1 分钱）。
   * 单价可改是因为官方调价是会发生的；默认值见 src/pricing.js。
   */
  costSay: true,
  costThreshold: 0.01,
  costPriceHit: 0.02,
  costPriceMiss: 1,
  costPriceOutput: 4,
  /**
   * 右键「打开DSH」要打开的地址。默认就是 DSH web profile 的默认监听；
   * 换了端口/主机就改这里（设置窗口 → 维护 也能改）。
   */
  dshUrl: DEFAULT_DSH_URL,
  /** 启动 DSH 的命令（留空 = 自动：npm 全局 dsh → PATH → npx）。 */
  dshCommand: '',
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}
function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
  } catch (error) {
    log('[config] save failed', error.message);
  }
}

// ---------------------------------------------------------------- 托盘图标
/** 优先用上游立绘当图标；webp 不被 nativeImage 支持时退回手绘位图。 */
function buildTrayIcon() {
  const candidates = [
    'dsh-whale-home-peek.webp',
    'dsh-whale-state-home.webp',
    'dsh-whale-state-idle.webp',
  ];
  for (const name of candidates) {
    const file = path.join(VENDOR_DIR, 'generated', name);
    if (!fs.existsSync(file)) continue;
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) {
      return image.resize({ width: 16, height: 16 });
    }
  }

  const size = 32;
  const buffer = Buffer.alloc(size * size * 4);
  const put = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    buffer[i] = b;
    buffer[i + 1] = g;
    buffer[i + 2] = r;
    buffer[i + 3] = a;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - 16) / 13;
      const dy = (y - 17) / 11;
      if (dx * dx + dy * dy <= 1) {
        put(x, y, 74, 168, 255, 255); // 鲸鱼蓝
      }
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size }).resize({ width: 16, height: 16 });
}

// ---------------------------------------------------------------- 窗口
function applyBounds() {
  if (!win || win.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  win.setBounds({ x: area.x, y: area.y, width: area.width, height: area.height });
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;

  win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: '鲸鱼娘桌宠',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: Boolean(argValue('dev')),
    },
  });

  win.setAlwaysOnTop(config.alwaysOnTop, 'screen-saver');
  // 默认整屏穿透；渲染进程按指针位置按需切回来
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.on('closed', () => {
    stopCursorPolling();
    win = null;
  });

  // 渲染进程的 console 也收进日志，便于无界面排查
  win.webContents.on('console-message', (...args) => {
    const first = args[0];
    if (first && typeof first === 'object' && 'message' in first) {
      log('[renderer]', first.level, first.message);
    } else {
      log('[renderer]', args[1], args[2]);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('[renderer] did-fail-load', code, desc, url));
  win.webContents.on('render-process-gone', (_e, details) => log('[renderer] gone', JSON.stringify(details)));

  win.loadURL(`${server.url}/`);
  win.webContents.once('did-finish-load', () => {
    win.webContents.setZoomFactor(config.scale);
    if (config.visible) win.showInactive();
    log('[window] loaded', server.url, 'bounds', JSON.stringify(win.getBounds()));
    startCursorPolling();
    if (!DSH_PROBE) pushDshState();
    if (SETTINGS_PROBE) runSettingsProbe();
    else if (GROWTH_PROBE) runGrowthProbe();
    else if (SAY_PROBE) runSayProbe();
    else if (OPEN_DSH_PROBE) runOpenDshProbe();
    else if (DSH_PROBE) runDshProbe();
    else if (MENU_PROBE) runMenuProbe();
    else if (SHOT_MODE) scheduleShot();
  });

  screen.on('display-metrics-changed', applyBounds);
  screen.on('display-added', applyBounds);
  screen.on('display-removed', applyBounds);
}

// ---------------------------------------------------------------- 光标轮询
/**
 * 把「屏幕光标 - 窗口原点」的相对坐标推给页面做穿透判定。
 *
 * 为什么不靠页面的 mousemove：Windows 上
 * setIgnoreMouseEvents(true, { forward: true }) 的转发并不可靠 ——
 * 实测把指针移动到桌宠身上时，页面收不到任何 mousemove，
 * 于是"压到桌宠才接管鼠标"永远不成立，右键菜单也就点不出来。
 * 主进程 screen.getCursorScreenPoint() 轮询是确定性的，不依赖转发。
 */
const CURSOR_POLL_MS = 80;
let cursorTimer = null;

function startCursorPolling() {  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const point = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    win.webContents.send('shell:cursor', { x: point.x - bounds.x, y: point.y - bounds.y });
  }, CURSOR_POLL_MS);
}

function stopCursorPolling() {
  if (cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
}

// ---------------------------------------------------------------- DSH 工作状态
/**
 * 读取 DSH 会话文件得到工作状态，推给页面。
 * 页面侧（shell.js）会把它合成为上游认识的 DOM 信号，
 * 从而复用上游原有的状态机与立绘（含按工具类型选姿势）。
 */
function startDshWatcher() {
  if (dshWatcher) return;
  dshWatcher = new DshStateWatcher({
    log: (...parts) => log(...parts),
    onChange: (state) => {
      lastDshState = state;
      // 链路探针要独占状态通道，否则真实 DSH 状态会把注入值覆盖掉
      if (DSH_PROBE || !config || config.followDsh === false) return;
      if (win && !win.isDestroyed()) win.webContents.send('shell:dsh-state', state);
    },
    onTurnEnd: (event) => handleTurnEnd(event),
  });
  dshWatcher.start();
  log('[dsh] watcher started');
}

/**
 * 让桌宠说一句话。
 *
 * `__dshWhaleMoeSay` 是 src/server.js 在返回 /pet/mascot.js 时注入的一行补丁
 * （磁盘上的 vendor 文件没动）。上游没改锚点它就一定在；万一不在，返回 false，
 * 调用方降级成"只写日志"，不会静默假装播报过。
 */
/**
 * 壳主动让她说的台词，打完字后停留多久（毫秒）。
 *
 * 5 秒是用户定的。关键在"**打完字之后**才开始计时"：上游原本是开口时设 4.5 秒到期，
 * 而台词逐字打（标点 260ms、每 5 字 130ms、其余 64ms），余额播报那种四十多字的句子
 * 光打字就 4 秒多 —— 打完就到点了，等于看不清。计时点由 server.js 注入的补丁搬到了
 * 打字结束之后（见 MASCOT_PATCH）。
 */
const SAY_HOLD_MS = 5000;

function sayToPet(text, holdMs = SAY_HOLD_MS) {
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  const script = `(function(){ if (typeof window.__dshWhaleMoeSay !== 'function') return false; window.__dshWhaleMoeSay(${JSON.stringify(
    String(text),
  )}, ${Number(holdMs) || 0}); return true; })()`;
  return win.webContents.executeJavaScript(script).catch((error) => {
    log('[say] failed', error.message);
    return false;
  });
}

/**
 * 此刻、此模型的单价与取价依据（价目表 or 手动配置）。
 *
 * 会话记录里带模型名时会顺便更新 currentModel —— 用户换模型后不用重启桌宠。
 */
function currentRates(at, modelHint) {
  if (modelHint && modelHint !== currentModel) {
    log('[price] 模型变为', modelHint);
    currentModel = modelHint;
  }
  const manual = {
    cacheHitPerM: Number(config ? config.costPriceHit : 0),
    cacheMissPerM: Number(config ? config.costPriceMiss : 0),
    outputPerM: Number(config ? config.costPriceOutput : 0),
  };
  const resolved = resolveRates({ table: priceTable, model: currentModel, manual, at });
  const signature = `${resolved.source}:${resolved.modelKey || 'manual'}:${resolved.peak ? 'peak' : 'idle'}`;
  if (signature !== lastRateSource) {
    lastRateSource = signature;
    log(
      '[price]',
      resolved.source === 'table' ? `价目表命中 ${resolved.modelKey}` : `价目表无此模型（${currentModel || '未知'}），改用手动配置`,
      resolved.peak ? '高峰价' : '空闲价',
      JSON.stringify(resolved.rates),
    );
  }
  return resolved;
}

/**
 * 一个 turn 结束时：记账 + （按需）播报。
 *
 * 记账与播报是两件事，必须分开：
 *   · 记账**无条件**做（阈值以下的零头、历史回放的账都要算进"今日消耗"）；
 *   · 播报只在"实时完成的 turn"且金额达到阈值时才做 ——
 *     历史回放（桌宠当天中途启动时的补账）绝不能一条条念出来。
 *
 * 计时点用记录自己的时间（`event.at`）而不是 Date.now()：
 * 峰谷价按**结算时刻**算更接近实际账单，历史账也能归到它发生的那一天。
 */
function handleTurnEnd(event) {
  if (!config) return;
  const at = Number(event.at) || Date.now();
  const cost = costOf(event.usage, currentRates(at, event.model).rates);

  if (usageLedger) {
    // 去重键：同一个 turn 被回放/重复读到时不重复记账
    const key = `${event.session || 'unknown'}#${event.turn ?? '?'}`;
    const result = usageLedger.record({ key, usage: event.usage, cost, at });
    // 'past' 是常态：会话文件跨天，启动回放里会夹着昨天及更早的 turn
    if (result === 'duplicate') log('[usage] 重复的 turn，已跳过', key);
  }

  if (event.historical) return; // 历史账只入账
  if (config.costSay === false) return;
  if (!shouldAnnounce(cost, config.costThreshold)) {
    log('[cost] 低于阈值，不播报', cost.toFixed(6), 'reason=', event.reason ? event.reason.kind : 'n/a');
    return;
  }
  const text = announceText(event.usage, cost);
  log('[cost]', text, 'reason=', event.reason ? event.reason.kind : 'n/a');
  sayToPet(text).then((ok) => {
    if (!ok) log('[cost] 说话钩子不可用，已跳过播报');
  });
}

function stopDshWatcher() {
  if (dshWatcher) {
    dshWatcher.stop();
    dshWatcher = null;
  }
}

function pushDshState() {
  if (!win || win.isDestroyed() || !dshWatcher) return;
  const snapshot = config && config.followDsh === false
    ? { state: 'idle', tool: null, at: Date.now(), source: 'disabled' }
    : dshWatcher.snapshot();
  lastDshState = snapshot;
  win.webContents.send('shell:dsh-state', snapshot);
}

// ---------------------------------------------------------------- 独立设置窗口
let settingsWin = null;

/**
 * 「打开看板娘设置」开的独立窗口。
 *
 * 为什么不做成页面内浮层：浮层要靠齿轮 ⚙ 开关，而齿轮在台词气泡里、
 * 气泡 4.5 秒就自动隐藏 —— 于是面板一打开就没有可点的关闭入口。
 * 独立窗口有原生标题栏（还有窗口内的"关闭"按钮），并且用的是同一个源，
 * 与桌宠页面共享 localStorage，改完立即生效。
 */
// ---------------------------------------------------------------- 辅助窗口工厂
/**
 * 设置窗口与养成窗口共用的创建逻辑。
 *
 * 三处细节缺一不可（都是踩过的坑）：
 *   show:false + ready-to-show   —— 等首帧就绪再显示，避免先出现一片空白
 *   alwaysOnTop('screen-saver')  —— 必须比整屏置顶的桌宠窗口更高；失焦时撤掉
 *   显示后 invalidate()          —— 再要求重绘一次
 * 另外 Windows 上必须全局关掉 Chromium 的遮挡检测，否则整屏桌宠会把新窗口判定为
 * "被完全遮住"而停止出帧 —— 表现就是窗口一片空白、点一下才出现（见文件顶部 appendSwitch）。
 *
 * 注：openSettingsWindow 是这套helper之前写的，逻辑等价但没走这里；
 *     下次改设置窗口时顺手迁移过来，别让两份实现漂移。
 */
/**
 * 辅助窗口（设置 / 养成）的内容高度上限。
 *
 * 为什么不写死：写死 760 的时候，多一组设置就静默多出一条滚动条 ——
 * 内容没丢，但最后一组被压到折叠线以下，看起来像"设置少了"。
 */
function maxAuxContentHeight() {
  return Math.max(320, screen.getPrimaryDisplay().workAreaSize.height - 40);
}

function createAuxWindow({ width, height, title, url, preload, autoSize }) {
  const aux = new BrowserWindow({
    width,
    height,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title,
    backgroundColor: '#fafafa',
    alwaysOnTop: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      devTools: Boolean(argValue('dev')),
    },
  });
  aux.setMenuBarVisibility(false);
  aux.setAlwaysOnTop(true, 'screen-saver');
  aux.loadURL(url);

  aux.on('focus', () => {
    if (!aux.isDestroyed()) aux.setAlwaysOnTop(true, 'screen-saver');
  });
  aux.on('blur', () => {
    if (!aux.isDestroyed()) aux.setAlwaysOnTop(false);
  });
  aux.once('ready-to-show', () => {
    aux.show();
    aux.focus();
    aux.webContents.invalidate();
  });

  if (autoSize) {
    aux.webContents.once('did-finish-load', async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 250)); // 等异步分组渲染完
        const needed = await aux.webContents.executeJavaScript('Math.ceil(document.body.scrollHeight)');
        if (needed > 0) {
          const [w] = aux.getContentSize();
          const capped = Math.min(Math.max(needed + 2, 200), maxAuxContentHeight());
          aux.setContentSize(w, capped);
          if (needed > capped) {
            await aux.webContents.executeJavaScript("document.body.style.overflowY = 'auto'");
          }
          log('[aux]', title, 'content sized to', needed, '->', capped);
        }
      } catch (error) {
        log('[aux]', title, 'auto-size failed', error.message);
      }
    });
  }
  return aux;
}

// ---------------------------------------------------------------- 养成 / 图鉴窗口
let growthWin = null;

/**
 * 养成窗口：今日任务 / 本周签到 / 称号 / 成长日记 / 成就，五个标签页。
 * 头顶浮层的「日常养成」与托盘的「称号…」「成就…」都开这一个窗口，只是初始标签不同。
 */
function openGrowthWindow(tab) {
  const wanted = tab || 'quests';
  if (growthWin && !growthWin.isDestroyed()) {
    growthWin.show();
    growthWin.focus();
    growthWin.webContents.send('growth:tab', wanted);
    return growthWin;
  }
  growthWin = createAuxWindow({
    width: 620,
    height: 620,
    title: '鲸鱼娘 · 养成',
    url: `${server.url}/pet/growth.html?tab=${encodeURIComponent(wanted)}`,
    preload: path.join(__dirname, 'growth-preload.js'),
    autoSize: false, // 长列表窗口：固定高度 + 内部滚动更合适
  });
  growthWin.on('closed', () => {
    growthWin = null;
  });
  log('[growth] window opened tab=' + wanted);
  return growthWin;
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }
  settingsWin = new BrowserWindow({
    /*
     * 窗口宽度 = 左侧分类栏(136) + 间距 + 右侧设置栏，也就是"够放下标题 + 说明 + 控件"
     * 的宽度；高度由页面量出来（见 openSettingsWindow 末尾的说明）。
     */
    width: 720,
    height: 520,
    show: false, // 等 ready-to-show（首帧就绪）再显示，避免先出现一块空白
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: '看板娘设置',
    backgroundColor: '#fafafa',
    // 桌宠窗口是整屏置顶的，设置窗口必须比它更高，否则既被画在她下面，
    // 又正好落进上面说的"被遮挡"判定里。
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      devTools: Boolean(argValue('dev')),
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.setAlwaysOnTop(true, 'screen-saver');
  settingsWin.loadURL(`${server.url}/pet/settings.html`);


  // 失焦就撤掉置顶，免得它一直浮在别的应用上面
  settingsWin.on('focus', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setAlwaysOnTop(true, 'screen-saver');
  });
  settingsWin.on('blur', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setAlwaysOnTop(false);
  });

  settingsWin.once('ready-to-show', () => {
    settingsWin.show();
    settingsWin.focus();
    // 首帧落屏后再主动要求重绘一次，双保险
    settingsWin.webContents.invalidate();
    log('[settings] shown (alwaysOnTop=' + settingsWin.isAlwaysOnTop() + ')');
  });
  /*
   * 高度不在这里写死：两栏布局下"最高的一屏"只有页面知道，
   * 所以由页面量好经 `shell:settings-size` 报上来（见 registerIpc 里的处理）。
   * 这里的初值取得比实际需要略大：报上来之前先按这个尺寸显示，
   * 万一面上的脚本出错，也只是底部多留一点空白，不会把设置项裁掉。
   */
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  log('[settings] window opened');
  return settingsWin;
}

function setVisible(next) {
  config.visible = next;
  saveConfig();
  if (!win) return;
  if (next) {
    win.showInactive();
  } else {
    win.hide();
  }
  refreshTrayMenu();
}

function setScale(next) {
  config.scale = next;
  saveConfig();
  if (win) win.webContents.setZoomFactor(next);
  refreshTrayMenu();
}

function setAlwaysOnTop(next) {
  config.alwaysOnTop = next;
  saveConfig();
  if (win) win.setAlwaysOnTop(next, 'screen-saver');
  refreshTrayMenu();
}

function setAutoLaunch(next) {
  config.autoLaunch = next;
  saveConfig();
  const settings = { openAtLogin: next };
  if (!app.isPackaged) {
    // 开发态下可执行文件是 electron.exe，必须把项目目录当参数带上
    settings.path = process.execPath;
    settings.args = [ROOT];
  }
  try {
    app.setLoginItemSettings(settings);
  } catch (error) {
    log('[autoLaunch] failed', error.message);
  }
  refreshTrayMenu();
}

/** 开关「跟随 DSH 工作状态」。关掉时立刻把页面推回空闲，免得卡在工作姿势。 */
function setFollowDsh(next) {
  config.followDsh = next;
  saveConfig();
  if (win && !win.isDestroyed()) {
    if (next) {
      pushDshState();
    } else {
      win.webContents.send('shell:dsh-state', { state: 'idle', tool: null, at: Date.now(), source: 'disabled' });
    }
  }
  refreshTrayMenu();
}

function resetPosition() {
  if (!win) return;
  win.webContents
    .executeJavaScript(
      `(() => { try { localStorage.removeItem('whale-moe:floatX'); localStorage.removeItem('whale-moe:floatY'); return true; } catch (e) { return false; } })()`
    )
    .then(() => {
      win.webContents.reload();
      log('[window] position reset');
    })
    .catch((error) => log('[window] reset failed', error.message));
}

function toggleVisible() {
  setVisible(!config.visible);
}

// ---------------------------------------------------------------- 托盘菜单
/**
 * 托盘 = 高频全局动作 + 快速开关。
 *
 * 与设置窗口是**同一份 config 的两个入口**（设置窗口内容更全、按类分组）。
 * 两边不会打架：所有改动都走 setScale/setAlwaysOnTop/… 这些 setter，
 * 而它们末尾都会调用 refreshTrayMenu()，所以托盘的勾选状态始终跟着 config 走。
 */
function buildTrayTemplate() {
  return [
    { label: '显示桌宠', type: 'checkbox', checked: config.visible, click: () => setVisible(!config.visible) },
    { type: 'separator' },
    { label: '总是置顶', type: 'checkbox', checked: config.alwaysOnTop, click: () => setAlwaysOnTop(!config.alwaysOnTop) },
    {
      label: '跟随 DSH 工作状态',
      type: 'checkbox',
      checked: config.followDsh,
      click: () => setFollowDsh(!config.followDsh),
    },
    { label: '开机自启', type: 'checkbox', checked: config.autoLaunch, click: () => setAutoLaunch(!config.autoLaunch) },
    {
      label: '大小',
      submenu: [0.8, 0.9, 1, 1.1, 1.25, 1.5].map((value) => ({
        label: `${Math.round(value * 100)}%`,
        type: 'radio',
        checked: Math.abs(config.scale - value) < 0.001,
        click: () => setScale(value),
      })),
    },
    { label: '重置到默认位置', click: resetPosition },
    { label: '重新加载页面', click: () => win && win.webContents.reload() },
    { type: 'separator' },
    { label: '打开数据目录', click: () => require('electron').shell.openPath(app.getPath('userData')) },
    { label: '打开日志', click: () => require('electron').shell.openPath(logFile()) },
    { label: '设置…', click: () => openSettingsWindow() },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ];
}

/** 保留当前托盘菜单的引用：自检需要读它的勾选状态，验证与设置窗口的同步。 */
let trayMenu = null;

function refreshTrayMenu() {
  if (!tray) return;
  trayMenu = Menu.buildFromTemplate(buildTrayTemplate());
  tray.setContextMenu(trayMenu);
}

function createTray() {
  const icon = buildTrayIcon();
  log('[tray] icon', icon.isEmpty() ? 'EMPTY(退回系统默认)' : `${icon.getSize().width}x${icon.getSize().height}`);
  tray = new Tray(icon);
  tray.setToolTip('鲸鱼娘桌宠');
  refreshTrayMenu();
  tray.on('click', toggleVisible);
}

// ---------------------------------------------------------------- DSH 状态链路探针
/**
 * 验证「状态 → 页面合成信号 → 上游状态机」这条链。
 *
 * 走真实 IPC 通道推状态，然后读上游自己的调试快照 `window.__dshWhaleMoeDebug`
 * 看它认成了什么 state/pose —— 上游内部怎么想，比截图更可信。
 * （会话文件读取器本身由 /__shell/state 的 dsh 字段单独验证。）
 */
function runDshProbe() {
  // 上游对"工作中"有 goneHold（home 视图 4s）消抖，状态间隔必须大于它，
  // 否则上一步的工作姿势会把下一步盖住 —— 这不是 bug，是上游刻意的防抖。
  const HOLD_MS = 4500;
  const sequence = [
    { state: 'idle', note: '基线' },
    { state: 'thinking' },
    { state: 'tool', tool: 'pwsh', expect: 'work-slack-phone (bash→打电话)' },
    { state: 'tool', tool: 'write', expect: 'work-meeting (write→开会)' },
    { state: 'tool', tool: 'grep', expect: 'work-idea (search→灵光)' },
    { state: 'success' },
    { state: 'failure' },
    { state: 'idle', note: '回到空闲' },
  ];

  setTimeout(async () => {
    for (const item of sequence) {
      win.webContents.send('shell:dsh-state', { ...item, at: Date.now(), source: 'probe' });
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      const snap = await win.webContents.executeJavaScript(`(() => {
        const d = window.__dshWhaleMoeDebug || {};
        const root = document.querySelector('[data-dsh-whale-root]');
        const chip = root ? root.querySelector('[data-dsh-whale-chip]') : null;
        const host = document.getElementById('dsh-whale-shell-signals');
        // 交叉淡入淡出有两层，取当前可见的那层才准
        const layers = root ? [...root.querySelectorAll('img[data-dsh-whale-layer]')] : [];
        const shown = layers.filter((n) => n.style.display !== 'none' && n.getAttribute('src'));
        const pick = shown.length ? shown[shown.length - 1] : layers[0];
        const src = pick ? (pick.getAttribute('src') || '') : '';
        return {
          state: d.state || null,
          pose: d.pose || null,
          busy: root ? root.getAttribute('data-dsh-whale-busy') : null,
          chip: chip ? chip.textContent : null,
          sprite: src ? src.split('/').pop().split('?')[0] : null,
          layerCount: layers.length,
          signals: host ? host.innerHTML.replace(/\\s+/g, ' ').trim() : null,
        };
      })()`);
      const label = item.tool ? `${item.state}/${item.tool}` : item.state;
      log('[dsh-probe]', label, item.expect ? `(期望 ${item.expect})` : '', '->', JSON.stringify(snap));
    }
    log('[dsh-probe] DONE');
    app.exit(0);
  }, 3500);
}

// ---------------------------------------------------------------- 自检小工具
/** 截图带重试并返回 NativeImage：窗口刚 setContentSize / 刚显示时合成器还没出新帧，
 *  capturePage 会抛 UnknownVizError。返回 null 表示三次都失败。 */
async function captureImage(webContents) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await webContents.capturePage();
    } catch (error) {
      log('[probe] capture attempt', attempt, 'failed:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return null;
}

async function captureTo(webContents, target) {
  const image = await captureImage(webContents);
  if (!image) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, image.toPNG());
  return true;
}

/**
 * 判断截图是不是"一片空白"。
 * 全白（未出帧）时暗像素与彩色像素的占比都接近 0；
 * 正常渲染时文字会贡献暗像素、蓝色开关会贡献彩色像素。
 */
function analyzePixels(image) {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  let total = 0;
  let dark = 0;
  let colored = 0;
  for (let y = 0; y < size.height; y += 2) {
    for (let x = 0; x < size.width; x += 2) {
      const i = (y * size.width + x) * 4;
      const b = bitmap[i];
      const g = bitmap[i + 1];
      const r = bitmap[i + 2];
      total += 1;
      if (r < 200 || g < 200 || b < 200) dark += 1;
      if (Math.abs(r - g) > 30 || Math.abs(g - b) > 30 || Math.abs(r - b) > 30) colored += 1;
    }
  }
  return {
    size: `${size.width}x${size.height}`,
    darkRatio: Number((dark / total).toFixed(4)),
    coloredRatio: Number((colored / total).toFixed(4)),
  };
}

// ---------------------------------------------------------------- 养成 / 图鉴探针
/**
 * 覆盖本次新增的整条链：
 *   1) 头顶浮层（天气/余额/称号 + 日常养成入口）存在、初始隐藏、上游偏好面板被隐藏
 *   2) 点齿轮 ⚙ 能打开浮层，且每行都有内容
 *   3) 「日常养成」打开养成窗口，5 个标签页齐全
 *   4) 成就页：39 条；已解锁数对得上；未解锁的名称被隐藏
 *   5) 托盘「称号…」「成就…」能打开对应标签页
 *   6) 领取任务 / 佩戴称号的 IPC 往返可用（佩戴有可观测效果）
 */
function runGrowthProbe() {
  const target = typeof argValue('growth-probe') === 'string'
    ? argValue('growth-probe')
    : path.join(ROOT, 'tmp', 'growth-probe.png');

  setTimeout(async () => {
    const results = [];
    const check = (name, ok, detail) => {
      results.push({ name, ok });
      log('[growth-probe]', ok ? 'PASS' : 'FAIL', name, detail ? '-> ' + detail : '');
    };

    try {
      // ---- 1) 浮层结构 ----
      const hud = await win.webContents.executeJavaScript(`(() => {
        const el = document.getElementById('dsh-whale-shell-hud');
        const prefs = document.querySelector('[data-dsh-whale-prefs]');
        if (!el) return { found: false };
        const actions = [...el.querySelectorAll('.hud-action')];
        return {
          found: true,
          hidden: el.hidden,
          parentIsRoot: el.parentElement === document.querySelector('[data-dsh-whale-root]'),
          rows: [...el.querySelectorAll('.hud-row')].map((r) => r.getAttribute('data-hud-row')),
          actions: actions.map((b) => b.textContent),
          actionKeys: actions.map((b) => b.getAttribute('data-hud-action')),
          prefsHidden: prefs ? getComputedStyle(prefs).display === 'none' : null,
        };
      })()`);
      check(
        '头顶浮层结构正确（天气 / 余额 + 两个入口，挂在桌宠根节点下）',
        Boolean(
          hud.found &&
            hud.parentIsRoot &&
            (hud.rows || []).join(',') === 'weather,balance' &&
            (hud.actions || []).join(',') === '日常养成,余额查询'
        ),
        JSON.stringify(hud)
      );
      check('浮层初始隐藏，且上游偏好面板已被隐藏', hud.found && hud.hidden === true && hud.prefsHidden === true, JSON.stringify({ hidden: hud.hidden, prefsHidden: hud.prefsHidden }));

      // ---- 2) 齿轮打开浮层 ----
      const shown = await win.webContents.executeJavaScript(`(() => {
        const gear = document.querySelector('[data-dsh-whale-gear]') || document.querySelector('[data-dsh-whale-gear-mini]');
        if (!gear) return { error: 'no gear' };
        gear.click();
        const el = document.getElementById('dsh-whale-shell-hud');
        const actions = [...el.querySelectorAll('.hud-action')];
        return {
          hidden: el.hidden,
          texts: [...el.querySelectorAll('.hud-row')].map((r) => (r.querySelector('.k') || {}).textContent + ' / ' + (r.querySelector('.v') || {}).textContent),
          // 两个入口的**实际渲染尺寸**（必须等浮层可见才量得到，否则是 0×0）
          actionBoxes: actions.map((b) => {
            const r = b.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
          }),
        };
      })()`);
      check(
        '点齿轮 ⚙ 打开浮层，且每行都有文案',
        shown && shown.hidden === false && (shown.texts || []).every((t) => t && t.split(' / ')[0]),
        JSON.stringify(shown)
      );
      check(
        '两个入口同一行且等宽（日常养成在左、余额查询在右）',
        (shown.actionBoxes || []).length === 2 &&
          shown.actionBoxes[0].top === shown.actionBoxes[1].top &&
          Math.abs(shown.actionBoxes[0].w - shown.actionBoxes[1].w) <= 1 &&
          shown.actionBoxes.every((b) => b.w > 40 && b.h > 20),
        JSON.stringify(shown.actionBoxes)
      );
      // 顺手留一张浮层的截图：浮层的观感只能看，断言只能保证尺寸与文案
      {
        const hudShot = await captureImage(win.webContents);
        if (hudShot) {
          const file = path.join(ROOT, 'tmp', 'hud-probe.png');
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, hudShot.toPNG());
          log('[growth-probe] hud screenshot', file);
        }
      }

      // ---- 3) 「日常养成」打开养成窗口 ----
      const growthClick = await win.webContents.executeJavaScript(`(() => {
        const hud = document.getElementById('dsh-whale-shell-hud');
        const btn = hud.querySelector('[data-hud-action="growth"]');
        if (!btn) return { clicked: false };
        btn.click();
        // 点选项应立刻收起浮层（不要让菜单杵在头顶挡视线）
        return { clicked: true, hiddenAfter: hud.hidden };
      })()`);
      const clicked = growthClick.clicked;
      check('点选项后浮层自动收起（日常养成）', growthClick.hiddenAfter === true, JSON.stringify(growthClick));
      await new Promise((resolve) => setTimeout(resolve, 2200));
      const winInfo = growthWin && !growthWin.isDestroyed()
        ? { exists: true, visible: growthWin.isVisible(), title: growthWin.getTitle() }
        : { exists: false };
      check('「日常养成」弹出养成窗口', Boolean(clicked && winInfo.exists && winInfo.visible), JSON.stringify(winInfo));

      if (winInfo.exists) {
        const tabs = await growthWin.webContents.executeJavaScript(
          `[...document.querySelectorAll('#tabs button')].map((b) => ({ tab: b.dataset.tab, label: b.textContent, on: b.getAttribute('aria-selected') }))`
        );
        check(
          '养成窗口含 5 个标签页且默认停在今日任务',
          tabs.length === 5 && tabs[0].on === 'true' && tabs.map((t) => t.label).join(',') === '今日任务,本周签到,称号,成长日记,成就',
          JSON.stringify(tabs.map((t) => t.label))
        );

        // ---- 4) 成就页 ----
        const ach = await growthWin.webContents.executeJavaScript(`(() => {
          const btn = [...document.querySelectorAll('#tabs button')].find((b) => b.dataset.tab === 'achievements');
          btn.click();
          const cards = [...document.querySelectorAll('#panel .card')];
          const locked = cards.filter((c) => c.classList.contains('locked'));
          const unlocked = cards.filter((c) => !c.classList.contains('locked'));
          const stored = (localStorage.getItem('whale-moe:achievements') || '').split(',').filter(Boolean);
          return {
            total: cards.length,
            unlocked: unlocked.length,
            stored: stored.length,
            lockedNameHidden: locked.length === 0 ? true : locked.every((c) => (c.querySelector('.name') || {}).textContent === '未解锁的成就'),
          };
        })()`);
        check('成就页列出全部 39 条', ach.total === 39, JSON.stringify({ total: ach.total }));
        check(
          '成就页：已解锁数与存档一致，未解锁的名称被隐藏',
          ach.unlocked === ach.stored && ach.lockedNameHidden === true,
          JSON.stringify(ach)
        );

        // ---- 6) 佩戴称号的 IPC 往返（有可观测效果）----
        const equip = await growthWin.webContents.executeJavaScript(
          `window.whaleGrowth.equipBadge('bond-lv5').then(() => localStorage.getItem('whale-moe:badge'))`
        );
        check('佩戴称号：IPC 往返生效', equip === 'bond-lv5', JSON.stringify({ badge: equip }));
        await growthWin.webContents.executeJavaScript(`window.whaleGrowth.equipBadge('')`);

        // 领取任务：只验通道是否通（没到领取条件时返回 ok:false 也算通）
        const claim = await growthWin.webContents.executeJavaScript(
          `window.whaleGrowth.claimQuest('signin-1').then((r) => r && typeof r.ok === 'boolean')`
        );
        check('领取任务：IPC 通道可用', claim === true, JSON.stringify({ claim }));

        const shot = await captureImage(growthWin.webContents);
        if (shot) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, shot.toPNG());
          const stats = analyzePixels(shot);
          check('养成窗口渲染出内容（非空白）', stats.darkRatio > 0.003, JSON.stringify(stats));
          log('[growth-probe] screenshot', target);
        } else {
          check('养成窗口渲染出内容（非空白）', false, '截图失败');
        }
      }

      // ---- 5) 托盘入口 ----
      // 称号/成就不再占用托盘：它们本质是"养成"的一部分，
      // 入口统一收在气泡齿轮 →「日常养成」里（那个入口上面已经断言过）。
      const trayLabels = buildTrayTemplate().map((item) => item.label || `(${item.type})`);
      check(
        '托盘不再含「称号…」「成就…」（改由气泡 →「日常养成」进入）',
        !trayLabels.includes('称号…') && !trayLabels.includes('成就…'),
        JSON.stringify(trayLabels)
      );
      check(
        '托盘仍保留常用项与「设置…」',
        ['显示桌宠', '总是置顶', '跟随 DSH 工作状态', '开机自启', '设置…', '退出'].every((label) =>
          trayLabels.includes(label)
        ),
        JSON.stringify(trayLabels)
      );
      // 入口没了，窗口内必须还能到称号页 —— 否则功能等于被删掉
      if (growthWin && !growthWin.isDestroyed()) {
        const badgeTab = await growthWin.webContents.executeJavaScript(`(() => {
          const btn = [...document.querySelectorAll('#tabs button')].find((b) => b.dataset.tab === 'badges');
          btn.click();
          return { on: btn.getAttribute('aria-selected'), cards: document.querySelectorAll('#panel .card').length };
        })()`);
        check(
          '养成窗口内可切到称号页（称号/成就的入口）',
          badgeTab.on === 'true' && badgeTab.cards > 0,
          JSON.stringify(badgeTab)
        );
      } else {
        check('养成窗口内可切到称号页（称号/成就的入口）', false, '养成窗口不存在');
      }
      // ---- 7) 天气端到端：从另一个窗口设城市 → 桌宠页面应主动预取 ----
      // 必须从**另一个窗口**写，才能触发同源 storage 事件（同文档写不触发）——
      // 这正是真实路径：城市是在设置窗口里改的。
      //
      // 注意：`setItem` 写入**相同的值不会触发 storage 事件**，所以第二次跑这条探针时
      // 不能还写上次那个城市（曾经因此假失败：改动没发生 → 没事件 → 20 秒超时）。
      // 所以先读原值，写一个**一定不同**的值，跑完再还原。
      const beforeCity = await win.webContents.executeJavaScript("localStorage.getItem('whale-moe:weatherCity')");
      const probeCity = beforeCity === '北京' ? '上海' : '北京';
      const setter = new BrowserWindow({
        width: 400,
        height: 300,
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
      });
      await setter.loadURL(`${server.url}/pet/settings.html`);
      await setter.webContents.executeJavaScript(
        `localStorage.setItem('whale-moe:weatherCity', ${JSON.stringify(probeCity)})`
      );
      const weather = await win.webContents.executeJavaScript(`(async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 20000) {
          await new Promise((r) => setTimeout(r, 400));
          const s = window.__dshWhaleMoeWeather;
          if (s && s.current && Number.isFinite(s.current.temp)) {
            return { temp: s.current.temp, code: s.current.code, ms: Date.now() - t0 };
          }
        }
        return null;
      })()`);
      if (beforeCity === null) {
        await setter.webContents.executeJavaScript("localStorage.removeItem('whale-moe:weatherCity')");
      } else {
        await setter.webContents.executeJavaScript(`localStorage.setItem('whale-moe:weatherCity', ${JSON.stringify(beforeCity)})`);
      }
      setter.destroy();
      check(
        `天气端到端：另一个窗口把城市改成「${probeCity}」→ 桌宠主动预取真实天气`,
        Boolean(weather),
        JSON.stringify(weather)
      );

      // ---- 8) 余额端到端：契约 + 自定义地址是否真的能用 ----
      // 上游要的形状： { ok: true, balances: [ { currency, totalBalance } ] }，
      // 而且**必须带 CORS 头**（页面源是 127.0.0.1:38911，接口在另一个端口 = 跨源）。
      const balanceServer = http.createServer((req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ ok: true, balances: [{ currency: 'CNY', totalBalance: 888.5 }] }));
      });
      await new Promise((resolve) => balanceServer.listen(3021, '127.0.0.1', resolve));

      const beforeEndpoint = await win.webContents.executeJavaScript("localStorage.getItem('whale-moe:balanceEndpoint')");
      const beforeEnabled = await win.webContents.executeJavaScript("localStorage.getItem('whale-moe:balance')");
      const balSetter = new BrowserWindow({
        width: 400,
        height: 300,
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
      });
      await balSetter.loadURL(`${server.url}/pet/settings.html`);
      await balSetter.webContents.executeJavaScript(`
        localStorage.setItem('whale-moe:balanceEndpoint', 'http://127.0.0.1:3021/balance');
        localStorage.setItem('whale-moe:balance', '1');
      `);
      const balance = await win.webContents.executeJavaScript(`(async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 25000) {
          await new Promise((r) => setTimeout(r, 500));
          const b = window.__dshWhaleMoeBalance;
          if (b && b.ok === true && Number.isFinite(b.amount)) return { amount: b.amount, currency: b.currency, tier: b.tier, ms: Date.now() - t0 };
        }
        const b = window.__dshWhaleMoeBalance;
        return { failed: true, last: b ? JSON.stringify(b) : null };
      })()`);

      /*
       * ---- 8.5) 气泡「余额查询」：点一下 → 她念一整句 ----
       *   当前余额为 CNY 888.50，状态为很充裕，今日共计消耗 … tokens，消费 … 元
       *
       * 放在还原 localStorage 之前：这条链路依赖"余额已启用 + 接口指向 888.5 那个假服务"。
       * 数字部分用正则而不是等值断言：今日消耗取自当天的真实会话账本，
       * 精确的账本算术由 scripts/test-cost.mjs 覆盖，这里只管四个分句是否都到位。
       * 台词是逐字打出来的，所以轮询到整句匹配为止。
       */
      const balanceQueryClick = await win.webContents.executeJavaScript(`(() => {
        const hud = document.getElementById('dsh-whale-shell-hud');
        hud.hidden = false; // 上次点完已经收起了，这里先摊开再点
        const btn = hud.querySelector('[data-hud-action="balance-query"]');
        if (btn) btn.click();
        return { clicked: Boolean(btn), hiddenAfter: hud.hidden };
      })()`);
      check(
        '点选项后浮层自动收起（余额查询）',
        balanceQueryClick.clicked === true && balanceQueryClick.hiddenAfter === true,
        JSON.stringify(balanceQueryClick)
      );
      const balanceLinePattern = /^当前余额为 CNY 888\.50，状态为很充裕，今日共计消耗 .+ tokens，消费 .+ 元$/;
      let balanceLine = '';
      const balanceDeadline = Date.now() + 9000;
      while (Date.now() < balanceDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        balanceLine = await win.webContents.executeJavaScript(
          "(() => { const el = document.querySelector('[data-dsh-whale-bubble-text]'); return el ? el.textContent || '' : ''; })()"
        );
        if (balanceLinePattern.test(balanceLine)) break;
      }
      check(
        '气泡「余额查询」：念出余额 + 状态 + 今日消耗 tokens/金额',
        balanceLinePattern.test(balanceLine),
        JSON.stringify(balanceLine)
      );

      if (beforeEndpoint === null) await balSetter.webContents.executeJavaScript("localStorage.removeItem('whale-moe:balanceEndpoint')");
      else await balSetter.webContents.executeJavaScript(`localStorage.setItem('whale-moe:balanceEndpoint', ${JSON.stringify(beforeEndpoint)})`);
      if (beforeEnabled === null) await balSetter.webContents.executeJavaScript("localStorage.removeItem('whale-moe:balance')");
      else await balSetter.webContents.executeJavaScript(`localStorage.setItem('whale-moe:balance', ${JSON.stringify(beforeEnabled)})`);
      balSetter.destroy();
      await new Promise((resolve) => balanceServer.close(resolve));
      check(
        '余额端到端：自定义接口 + CORS 后能读到金额',
        Boolean(balance && balance.ok !== false && balance.amount === 888.5),
        JSON.stringify(balance)
      );

      // ---- 9) 3020 上确实有按契约应答的余额服务 ----
      // 注意：探针实例与常驻实例会抢 3020，抢不到的那个 balanceProxy 为 null，
      // 但那不代表"没有服务"（服务由常驻实例提供）。所以断言的是**服务本身**，
      // 而不是我们这个进程里的对象 —— 这正是之前那条断言误报的原因。
      let defaultService = null;
      try {
        const res = await fetch('http://127.0.0.1:3020/balance', { signal: AbortSignal.timeout(10000) });
        const data = await res.json();
        defaultService = {
          ok: Boolean(data && data.ok),
          count: Array.isArray(data && data.balances) ? data.balances.length : 0,
          amount: data && data.balances && data.balances[0] ? data.balances[0].totalBalance : null,
          source: data ? data.source : null,
        };
      } catch (error) {
        defaultService = { error: error.message };
      }
      check(
        '3020 上有按契约应答的余额服务（内置代理或既有服务）',
        Boolean(defaultService && defaultService.ok && defaultService.count > 0),
        JSON.stringify({
          ownProxy: Boolean(balanceProxy),
          keySource: balanceProxy ? balanceProxy.keySource : null,
          service: defaultService,
        })
      );
    } catch (error) {
      log('[growth-probe] failed', error.message);
    }

    const failed = results.filter((r) => !r.ok).length;
    const expected = 20;
    log(
      '[growth-probe]',
      results.length !== expected
        ? `DONE 断言数不符：跑了 ${results.length} 项、预期 ${expected} 项，失败 ${failed} 项`
        : failed === 0
          ? `DONE 全部 ${expected} 项通过`
          : `DONE ${failed}/${expected} 项未通过`
    );
    app.exit(failed === 0 && results.length === expected ? 0 : 1);
  }, 3500);
}

// ---------------------------------------------------------------- 花费播报探针
/**
 * 验证"任务结束后她说一句本次花费"链路的最后一环：主进程 → 页面 → 气泡里真的有字。
 *
 * 前面几环都能离线测（scripts/test-cost.mjs 覆盖计价、阈值与 turn 累加），
 * 唯独"钩子调了但气泡里没字"只能靠真实页面断言 —— 钩子存在 ≠ 话说得出来：
 * 气泡节点可能还没建立、台词可能被 localizeLine 改写、气泡可能没被取消隐藏。
 * 所以这里断言的是**可见气泡里的完整文本**，而不是 window 上有没有那个函数。
 */
function runSayProbe() {
  const target = typeof argValue('say-probe') === 'string'
    ? argValue('say-probe')
    : path.join(ROOT, 'tmp', 'say-probe.png');

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  setTimeout(async () => {
    const results = [];
    const check = (name, ok, detail) => {
      results.push({ name, ok });
      log('[say-probe]', ok ? 'PASS' : 'FAIL', name, detail ? '-> ' + detail : '');
    };
    const readBubble = () =>
      win.webContents.executeJavaScript(`(() => {
        const bubble = document.querySelector('[data-dsh-whale-bubble]');
        const text = document.querySelector('[data-dsh-whale-bubble-text]');
        if (!bubble || !text) return null;
        return { hidden: Boolean(bubble.hidden), text: text.textContent || '' };
      })()`);

    try {
      // 与单测同一组样本值：真实 turn 的用量（取价走当前模型 + 当前峰谷，和播报一致）
      const sample = { inputTokens: 352, cacheReadTokens: 1540992, outputTokens: 5164 };
      const expected = announceText(sample, costOf(sample, currentRates(Date.now()).rates));

      const sayType = await win.webContents.executeJavaScript('typeof window.__dshWhaleMoeSay');
      check('页面暴露说话钩子 __dshWhaleMoeSay', sayType === 'function', sayType);

      const said = await sayToPet(expected);
      check('主进程调用说话钩子成功', said === true, String(said));

      // 台词是逐字打出来的，等到打完（或超时）为止
      let bubble = null;
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        bubble = await readBubble();
        if (bubble && !bubble.hidden && bubble.text === expected) break;
        await sleep(200);
      }
      check(
        '气泡可见且文本与预期完全一致',
        Boolean(bubble && !bubble.hidden && bubble.text === expected),
        JSON.stringify(bubble) + ' expected=' + JSON.stringify(expected)
      );

      const image = await captureImage(win.webContents);
      if (image) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, image.toPNG());
        log('[say-probe] screenshot', target);
      }

      /*
       * 停留时间：注入的钩子把到期时间从"开口时"挪到了"打完字之后"。
       * 旧行为下这句话光打字就 4 秒多（标点 260ms/每 5 字 130ms/其余 64ms），
       * 开口时设的 4.5 秒到打完基本就用光了 —— 所以"打完 3 秒后仍可见"这条
       * 恰好能把新旧行为区分开。
       */
      await sleep(3000);
      const still = await readBubble();
      check(
        '播报停留够久：打完字 3 秒后仍可见',
        Boolean(still && !still.hidden && still.text === expected),
        JSON.stringify(still)
      );

      // 到点自动消失（5 秒 + 200ms 淡出 + 一拍状态机）
      let gone = null;
      const goneDeadline = Date.now() + 4000;
      while (Date.now() < goneDeadline) {
        gone = await readBubble();
        if (!gone || gone.hidden || gone.text !== expected) break;
        await sleep(200);
      }
      check(
        '到点自动消失（打完字约 5 秒后）',
        Boolean(gone) && (gone.hidden === true || gone.text !== expected),
        JSON.stringify(gone)
      );

      // 点一下就收：再念一次，等打完字，然后点一下鼠标
      await sayToPet(expected);
      let typed = null;
      const typedDeadline = Date.now() + 8000;
      while (Date.now() < typedDeadline) {
        typed = await readBubble();
        if (typed && !typed.hidden && typed.text === expected) break;
        await sleep(200);
      }
      await win.webContents.executeJavaScript(
        `(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`
      );
      await sleep(600);
      const dismissed = await readBubble();
      check(
        '点一下就收：鼠标点击后立刻消失',
        Boolean(typed && !typed.hidden && typed.text === expected) && Boolean(dismissed) && dismissed.hidden === true,
        JSON.stringify({ typed, dismissed })
      );

      /*
       * 阈值闸门：喂一个远低于阈值的 turn，气泡里不应再出现 tokens。
       * 注意断言的是"没有出现花费文案"，而不是"气泡保持隐藏"——
       * 桌宠可能在等待期间自己冒一句日常台词（那是正常的），
       * 拿 hidden 当条件会随机失败。
       * （这个假 turn 会进自检实例自己的账本，自检用的是另一个文件名，不碰用户的账。）
       */
      await win.webContents.executeJavaScript(`(() => {
        const bubble = document.querySelector('[data-dsh-whale-bubble]');
        const text = document.querySelector('[data-dsh-whale-bubble-text]');
        if (text) text.textContent = '';
        if (bubble) bubble.hidden = true;
        return true;
      })()`);
      handleTurnEnd({
        turn: -1,
        usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1, messages: 1 },
        reason: { kind: 'completed' },
        at: Date.now(),
        session: 'say-probe',
        historical: false,
      });
      await sleep(900);
      const after = await readBubble();
      check(
        '低于阈值的花费不播报',
        Boolean(after) && !after.text.includes('tokens'),
        JSON.stringify(after)
      );
      check('播报开关默认开启、阈值默认 0.01', config.costSay === true && config.costThreshold === 0.01, JSON.stringify({
        costSay: config.costSay,
        costThreshold: config.costThreshold,
      }));
    } catch (error) {
      log('[say-probe] failed', error.message);
    }

    const failed = results.filter((r) => !r.ok).length;
    const expected = 8;
    log(
      '[say-probe]',
      results.length !== expected
        ? `DONE 断言数不符：跑了 ${results.length} 项、预期 ${expected} 项，失败 ${failed} 项`
        : failed === 0
          ? `DONE 全部 ${expected} 项通过`
          : `DONE ${failed}/${expected} 项未通过`
    );
    app.exit(failed === 0 && results.length === expected ? 0 : 1);
  }, 3500);
}

// ---------------------------------------------------------------- 打开DSH 探针
/**
 * 「打开DSH」探针。关心四件事：
 *
 *   1) 纯逻辑：地址归一化、token 地址识别、启动命令解析（含端口 / npm shim / npx 兜底）
 *   2) **已经在跑** → 只开浏览器：不重启、不再拉一个服务（拿 401 的替身服务当"在跑"，
 *      这正是无 cookie 访问真 DSH 的真实表现）
 *   3) **没在跑** → 真的把进程拉起来、等它应答、再打开；替身进程会往日志里写一行
 *      带 token 的地址，用来断言"自己拉起来的这次能拿到可直接打开的地址"
 *   4) **起不来** → 超时返回 ok:false，而不是假装成功
 *
 * 全程 dry-run：一个浏览器窗口都不会弹（那是用户的桌面，不是测试场地）。
 * 替身命令是 electron 自己的 `ELECTRON_RUN_AS_NODE` 模式 —— 不依赖机器上装了 node。
 */
function runOpenDshProbe() {
  const tmpDir = path.join(ROOT, 'tmp');

  /** 拿一个空闲端口（listen(0) 问系统要，随即释放）。 */
  const freePort = () =>
    new Promise((resolve) => {
      const probe = http.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });

  const stubScript = (port, token) =>
    `require('http').createServer((q,s)=>{s.writeHead(401);s.end('unauthorized')})` +
    `.listen(${port},'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:${port}/?token=${token}'))`;

  const stubSpec = (script) => ({
    source: 'stub',
    command: process.execPath,
    args: ['-e', script],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });

  const killStub = (pid) => {
    if (!pid) return;
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      /* 收尾失败不影响断言 */
    }
  };

  setTimeout(async () => {
    const results = [];
    const check = (name, ok, detail) => {
      results.push({ name, ok });
      log('[open-dsh-probe]', ok ? 'PASS' : 'FAIL', name, detail ? '-> ' + detail : '');
    };
    const spawned = [];

    try {
      // ---- 1) 纯逻辑 ----
      const normalized = [
        normalizeUrl(''),
        normalizeUrl('  127.0.0.1:3080/  '),
        normalizeUrl('http://127.0.0.1:3080///'),
        normalizeUrl('https://box.example/dsh/?token=abc'),
        normalizeUrl('::::'),
      ];
      check(
        '地址归一化：空值→默认、裸主机补 http、去尾斜杠、保留 token、垃圾值→默认',
        normalized[0] === DEFAULT_DSH_URL &&
          normalized[1] === 'http://127.0.0.1:3080' &&
          normalized[2] === 'http://127.0.0.1:3080' &&
          normalized[3] === 'https://box.example/dsh?token=abc' &&
          normalized[4] === DEFAULT_DSH_URL,
        JSON.stringify(normalized)
      );

      const tokenLine =
        '^Cdsh web: http://127.0.0.1:3080/?token=QtNoX9r5vKE96ijf5O84Q7TiIy94c6lDfNuiANOIgL4\n' +
        'noise http://127.0.0.1:1/ not-a-token\n' +
        'dsh web: http://127.0.0.1:3080/?token=P39pFCuwCeEIz9tLA-aVRX0jAFuKJYGD-OsNR0DJvuU\n';
      check(
        '从 dsh 输出里认出最后一行带 token 的地址（旧的/噪音的都不认）',
        extractTokenUrl(tokenLine) ===
          'http://127.0.0.1:3080/?token=P39pFCuwCeEIz9tLA-aVRX0jAFuKJYGD-OsNR0DJvuU' &&
          extractTokenUrl('nothing here') === null,
        String(extractTokenUrl(tokenLine))
      );

      const cmd = resolveDshCommand({ url: 'http://127.0.0.1:3099', platform: 'win32' });
      const cmdNix = resolveDshCommand({
        url: DEFAULT_DSH_URL,
        platform: 'linux',
        env: { PATH: path.dirname(process.execPath) },
        exists: (file) => path.basename(file) === 'dsh',
      });
      check(
        '启动命令：dsh web --no-open 且带上地址里的端口；找不到 dsh 时退回 npx',
        cmd.args.includes('web') &&
          cmd.args.includes('--no-open') &&
          cmd.args.includes('3099') &&
          cmdNix.args.includes('--no-open') &&
          cmdNix.command.endsWith('dsh'),
        JSON.stringify({ win32: cmd, linux: cmdNix })
      );

      // ---- 2) 已经在跑：只开浏览器，不重启 ----
      fs.mkdirSync(tmpDir, { recursive: true });
      const liveServer = http.createServer((_req, res) => {
        res.writeHead(401);
        res.end('unauthorized');
      });
      const livePort = await new Promise((resolve) => {
        liveServer.listen(0, '127.0.0.1', () => resolve(liveServer.address().port));
      });
      /*
       * "不再拉服务"要拿**外部证据**来断言：替身命令会在被真的执行时留下一个文件，
       * 走"已经在跑"这条路时它必须始终不出现（只看 pid 是空的证明不了没起过进程）。
       */
      const marker = path.join(tmpDir, 'open-dsh-probe-spawned.txt');
      try {
        fs.unlinkSync(marker);
      } catch {
        /* 之前就没有 */
      }
      const already = await openDshWeb({
        url: `http://127.0.0.1:${livePort}`,
        dryRun: true,
        timeoutMs: 4000,
        logPath: path.join(tmpDir, 'open-dsh-probe-live.log'),
        command: stubSpec(`require('fs').writeFileSync(${JSON.stringify(marker)},'spawned')`),
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      const spawnedAnyway = fs.existsSync(marker);
      await new Promise((resolve) => liveServer.close(resolve));
      check(
        '已经在跑（401）：直接打开，不重启也不再拉服务',
        already.ok === true &&
          already.running === true &&
          already.started === false &&
          already.pid === undefined &&
          already.opened === false &&
          spawnedAnyway === false,
        JSON.stringify({ ...already, spawnedAnyway })
      );

      // ---- 3) 没在跑：拉起来 → 等应答 → 打开（并优先用日志里的 token 地址）----
      const bootPort = await freePort();
      const bootLog = path.join(tmpDir, 'open-dsh-probe.log');
      fs.writeFileSync(bootLog, '');
      const launched = await openDshWeb({
        url: `http://127.0.0.1:${bootPort}`,
        dryRun: true,
        timeoutMs: 20000,
        logPath: bootLog,
        command: stubSpec(stubScript(bootPort, 'PROBEtoken123')),
      });
      spawned.push(launched.pid);
      check(
        '没在跑：把进程拉起来、等它应答，并回报 pid',
        launched.ok === true &&
          launched.started === true &&
          launched.running === false &&
          launched.pid > 0 &&
          launched.baseUrl === `http://127.0.0.1:${bootPort}`,
        JSON.stringify(launched)
      );
      check(
        '自己拉起来的那次用日志里的 token 地址打开（旧 token 会 401）',
        launched.url === `http://127.0.0.1:${bootPort}/?token=PROBEtoken123`,
        String(launched.url)
      );

      // ---- 4) 起不来：超时报错，不假装成功 ----
      const deadPort = await freePort();
      const failed = await openDshWeb({
        url: `http://127.0.0.1:${deadPort}`,
        dryRun: true,
        timeoutMs: 2500,
        logPath: path.join(tmpDir, 'open-dsh-probe-fail.log'),
        command: stubSpec('setTimeout(()=>{},10)'),
      });
      spawned.push(failed.pid);
      check(
        '起不来（超时）：ok:false + error=timeout，且没有假装打开',
        failed.ok === false && failed.error === 'timeout' && failed.opened === false && failed.started === true,
        JSON.stringify(failed)
      );

      // ---- 5) 页面里那条菜单项真的接到了主进程 ----
      /*
       * 用一个 401 的替身服务冒充"DSH 已经在跑"，**只改内存里的 config.dshUrl**
       * （不经 IPC 写盘，不碰用户的配置文件），然后真的点一下菜单项；
       * 断言从 `/__shell/state`（HTTP，外部脚本读的那一份）能看到这次调用的结果 ——
       * 这样"菜单项 → 预加载 → 主进程 → 打开"整条链子都被覆盖，而不只是标签存在。
       */
      const clickServer = http.createServer((_req, res) => {
        res.writeHead(401);
        res.end('unauthorized');
      });
      const clickPort = await new Promise((resolve) => {
        clickServer.listen(0, '127.0.0.1', () => resolve(clickServer.address().port));
      });
      const clickUrl = `http://127.0.0.1:${clickPort}`;
      const savedUrl = config.dshUrl;
      config.dshUrl = clickUrl;
      let click = null;
      let openDshState = null;
      try {
        click = await win.webContents.executeJavaScript(`(async () => {
          const frame = document.querySelector('[data-dsh-whale-frame]');
          if (!frame) return { error: 'no whale frame' };
          frame.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 300 }));
          await new Promise((r) => setTimeout(r, 350));
          const menu = document.querySelector('[data-dsh-whale-context]');
          if (!menu) return { error: 'no context menu' };
          const labels = [...menu.querySelectorAll('button')].map((b) => b.textContent.trim());
          const item = [...menu.querySelectorAll('button')].find((b) => b.textContent.trim() === '打开DSH');
          if (!item) return { error: 'no 打开DSH item', labels };
          item.click();
          await new Promise((r) => setTimeout(r, 500));
          return { labels, menuClosed: !document.querySelector('[data-dsh-whale-context]') };
        })()`);

        const readState = () =>
          new Promise((resolve) => {
            const request = http.get(`${server.url}/__shell/state`, { timeout: 2000 }, (response) => {
              let body = '';
              response.on('data', (chunk) => {
                body += chunk;
              });
              response.on('end', () => {
                try {
                  resolve(JSON.parse(body));
                } catch {
                  resolve(null);
                }
              });
            });
            request.on('timeout', () => {
              request.destroy();
              resolve(null);
            });
            request.on('error', () => resolve(null));
          });
        const deadline = Date.now() + 4000;
        for (;;) {
          const state = await readState();
          if (state && state.openDsh) {
            openDshState = state.openDsh;
            break;
          }
          if (Date.now() >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } finally {
        config.dshUrl = savedUrl;
        await new Promise((resolve) => clickServer.close(resolve));
      }
      check(
        '点菜单里的「打开DSH」→ 走通预加载/主进程并收起菜单',
        click &&
          click.menuClosed === true &&
          click.labels &&
          click.labels.includes('打开DSH') &&
          openDshState &&
          openDshState.ok === true &&
          openDshState.running === true &&
          openDshState.dryRun === true &&
          openDshState.opened === false &&
          openDshState.url === clickUrl,
        JSON.stringify({ click, openDshState })
      );
    } catch (error) {
      log('[open-dsh-probe] failed', error.message);
    } finally {
      spawned.forEach(killStub);
    }

    const failed = results.filter((r) => !r.ok).length;
    const expected = 8;
    log(
      '[open-dsh-probe]',
      results.length !== expected
        ? `DONE 断言数不符：跑了 ${results.length} 项、预期 ${expected} 项，失败 ${failed} 项`
        : failed === 0
          ? `DONE 全部 ${expected} 项通过`
          : `DONE ${failed}/${expected} 项未通过`
    );
    app.exit(failed === 0 && results.length === expected ? 0 : 1);
  }, 2500);
}

// ---------------------------------------------------------------- 设置窗口探针
/**
 * 覆盖职责划分与设置窗口两件事：
 *   1) 桌宠右键菜单只留交互项（不该再有「打开看板娘设置」），但要有「打开DSH」
 *   2) 托盘菜单有「设置…」，点它能弹出独立设置窗口
 *   3) 设置窗口按分类展示，含全部可配置项
 *   4) 窗口首帧/失焦后都真的渲染出内容（防白屏回归）
 *   5) 窗口里改「总是置顶」→ 主进程状态跟着变
 *   6) 偏好写入被桌宠页面读到（同源 localStorage）
 *   7) 页面内偏好面板仍可关闭
 */
function runSettingsProbe() {
  const target = typeof argValue('settings-probe') === 'string'
    ? argValue('settings-probe')
    : path.join(ROOT, 'tmp', 'settings-probe.png');

  setTimeout(async () => {
    const results = [];
    const check = (name, ok, detail) => {
      results.push({ name, ok });
      log('[settings-probe]', ok ? 'PASS' : 'FAIL', name, detail ? '-> ' + detail : '');
    };

    try {
      // ---- 1) 桌宠右键菜单：只应有交互项 ----
      // stripNonInteractionItems 在 MutationObserver 回调里跑（微任务），所以要等一拍再读
      await win.webContents.executeJavaScript(`(() => {
        const frame = document.querySelector('[data-dsh-whale-frame]');
        if (!frame) return false;
        frame.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 }));
        return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const mascotMenu = await win.webContents.executeJavaScript(`(() => {
        const menu = document.querySelector('[data-dsh-whale-context]');
        if (!menu) return { error: 'menu not opened' };
        return { labels: [...menu.querySelectorAll('button')].map((n) => n.textContent.trim()) };
      })()`);
      const labels = (mascotMenu && mascotMenu.labels) || [];
      const interaction = ['投喂小点心', '戳一下', '夸夸 鲸鱼娘', '回到原位'];
      check(
        '桌宠菜单不再含「打开看板娘设置」',
        labels.length > 0 && !labels.includes('打开看板娘设置'),
        JSON.stringify(labels)
      );
      check(
        '桌宠菜单保留交互项',
        interaction.every((item) => labels.includes(item)),
        JSON.stringify(interaction.filter((item) => !labels.includes(item)))
      );
      check(
        '桌宠菜单里有「打开DSH」（壳层注入的那一条，上游素材未改）',
        labels.includes('打开DSH'),
        JSON.stringify(labels)
      );
      if (labels.length === 0) {
        throw new Error('桌宠右键菜单没打开：' + JSON.stringify(mascotMenu));
      }

      // ---- 2) 托盘菜单：原有项都在，且新增了「设置…」 ----
      const trayTemplate = buildTrayTemplate();
      const trayLabels = trayTemplate.map((item) => item.label || `(${item.type})`);
      const settingsItem = trayTemplate.find((item) => item.label === '设置…');
      const trayRequired = [
        '显示桌宠', '设置…', '总是置顶', '跟随 DSH 工作状态', '开机自启',
        '大小', '重置到默认位置', '重新加载页面', '打开数据目录', '打开日志', '退出',
      ];
      const trayMissing = trayRequired.filter((label) => !trayLabels.includes(label));
      const afterLog = trayLabels.indexOf('设置…') === trayLabels.indexOf('打开日志') + 1;
      check(
        '托盘菜单：原有项齐全，且「设置…」紧跟「打开日志」',
        Boolean(settingsItem) && trayMissing.length === 0 && afterLog,
        trayMissing.length ? `缺: ${JSON.stringify(trayMissing)}` : JSON.stringify(trayLabels)
      );
      if (settingsItem) {
        settingsItem.click();
      }
      await new Promise((resolve) => setTimeout(resolve, 2200));

      const winInfo = settingsWin && !settingsWin.isDestroyed()
        ? { exists: true, visible: settingsWin.isVisible(), title: settingsWin.getTitle() }
        : { exists: false };
      check('托盘「设置…」弹出独立设置窗口', Boolean(winInfo.exists && winInfo.visible), JSON.stringify(winInfo));

      if (winInfo.exists) {
        const structure = await settingsWin.webContents.executeJavaScript(`(() => ({
          sections: [...document.querySelectorAll('section h2')].map((n) => n.textContent.trim()),
          rows: [...document.querySelectorAll('.row .name')].map((n) => n.textContent.trim()),
        }))()`);
        check(
          '设置窗口按分类展示（6 类）',
          structure.sections.length === 6 && structure.sections.includes('天气与余额') && structure.sections.includes('花费播报'),
          JSON.stringify(structure.sections)
        );

        // 二级菜单：左侧一级分类由 section 生成，右侧一次只显示一屏
        const nav = await settingsWin.webContents.executeJavaScript(`(() => {
          const rail = document.getElementById('rail');
          const buttons = [...rail.querySelectorAll('button')];
          const visible = [...document.querySelectorAll('section[data-panel]')].filter((s) => !s.hidden);
          return {
            labels: buttons.map((b) => b.textContent.trim()),
            selected: buttons.filter((b) => b.getAttribute('aria-selected') === 'true').length,
            visiblePanels: visible.map((s) => s.dataset.panel),
            headings: [...document.querySelectorAll('section[data-panel] h2')].map((h) => h.textContent.trim()),
          };
        })()`);
        check(
          '左侧分类栏与右侧各屏一一对应（导航是生成的，不会漂移）',
          nav.labels.length === 6 &&
            nav.labels.join(',') === nav.headings.join(',') &&
            nav.selected === 1 &&
            nav.visiblePanels.length === 1,
          JSON.stringify(nav)
        );

        // 点另一项 → 右侧真的换屏（这是"二级菜单"的核心行为）
        const switched = await settingsWin.webContents.executeJavaScript(`(() => {
          const buttons = [...document.getElementById('rail').querySelectorAll('button')];
          const target = buttons.find((b) => b.textContent.trim() === '花费播报');
          target.click();
          const visible = [...document.querySelectorAll('section[data-panel]')].filter((s) => !s.hidden);
          const rows = visible.length === 1 ? visible[0].querySelectorAll('.row').length : 0;
          return {
            visiblePanels: visible.map((s) => s.dataset.panel),
            rows,
            selected: buttons.filter((b) => b.getAttribute('aria-selected') === 'true').map((b) => b.textContent.trim()),
          };
        })()`);
        check(
          '点左侧「花费播报」→ 右侧只显示这一屏且内容非空',
          switched.visiblePanels.join(',') === 'cost' && switched.rows > 0 && switched.selected.join(',') === '花费播报',
          JSON.stringify(switched)
        );

        /*
         * 「DSH WebUI」那一行：地址可改 + 一个「打开」按钮。
         * 顺手量一下这一行有没有被撑出横向滚动 —— "输入框 + 按钮"最容易把行撑破，
         * 而撑破只会在真机上表现为一条横向滚动条，不会报错。
         */
        const dshUi = await settingsWin.webContents.executeJavaScript(`(() => {
          const rail = [...document.getElementById('rail').querySelectorAll('button')]
            .find((b) => b.textContent.trim() === '维护');
          rail.click();
          const row = [...document.querySelectorAll('.row')]
            .find((r) => (r.querySelector('.name') || {}).textContent === 'DSH WebUI');
          if (!row) return { found: false };
          const input = row.querySelector('input');
          const button = row.querySelector('button');
          return {
            found: true,
            visible: !row.closest('section[data-panel]').hidden,
            inputValue: input ? input.value : null,
            button: button ? button.textContent.trim() : null,
            hint: (row.querySelector('.hint') || {}).textContent || '',
            rowOverflow: row.scrollWidth - row.clientWidth,
            bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
          };
        })()`);
        check(
          '「DSH WebUI」行：地址可改 + 有「打开」按钮，且不撑出横向滚动',
          dshUi.found &&
            dshUi.visible &&
            typeof dshUi.inputValue === 'string' &&
            dshUi.inputValue.startsWith('http') &&
            dshUi.button === '打开' &&
            dshUi.hint.length > 0 &&
            dshUi.rowOverflow <= 0 &&
            dshUi.bodyOverflow <= 0,
          JSON.stringify(dshUi)
        );
        /*
         * 收拾干净：上面那一点会把"上次看的分类"记进 localStorage（真实使用时是有用的），
         * 但探针不该给用户留下界面状态 —— 否则他打开设置窗口会莫名停在探针点过的那一屏。
         */
        await settingsWin.webContents.executeJavaScript(
          "localStorage.removeItem('whale-moe:settingsTab')"
        );

        const expectedRows = [
          '看板娘', '台词气泡', '粒子效果',
          '总是置顶', '跟随 DSH 工作状态', '开机自启',
          '大小', '位置',
          '重新加载页面', '数据目录', '运行日志', 'DSH WebUI',
          '天气城市', '天气 API Key', '显示余额', '余额接口',
          '播报本次花费', '播报阈值（元）', '手动配置（元/百万）',
        ];
        const missing = expectedRows.filter((name) => !structure.rows.includes(name));
        check('设置窗口含全部可配置项', missing.length === 0, missing.length ? JSON.stringify(missing) : `${structure.rows.length} 项`);

        /*
         * 「单价」区域：模型名与价格**只读**，跟着实际用的模型自动刷新；
         * 手动配置那三个数可改，只在模型不在价目表里时参与计算。
         */
        const priceUi = await settingsWin.webContents.executeJavaScript(`(() => {
          const row = document.querySelector('.model-row');
          if (!row) return { found: false };
          const manual = [...document.querySelectorAll('.row')]
            .find((r) => (r.querySelector('.name') || {}).textContent === '手动配置（元/百万）');
          return {
            found: true,
            name: (row.querySelector('.name') || {}).textContent || '',
            prices: (row.querySelector('.price-line') || {}).textContent || '',
            badge: (row.querySelector('.badge') || {}).textContent || '',
            badgeTone: (row.querySelector('.badge') || {}).getAttribute('data-tone'),
            // 只读：该区域不该有任何输入控件
            inputs: row.querySelectorAll('input, select, textarea').length,
            manualInputs: manual ? manual.querySelectorAll('input').length : 0,
            manualDisabled: manual
              ? [...manual.querySelectorAll('input')].every((i) => i.disabled === false)
              : false,
          };
        })()`);
        check(
          '「单价」区显示当前模型与它的价格（自动、只读）',
          priceUi.found &&
            priceUi.inputs === 0 &&
            priceUi.name.includes('当前模型') &&
            priceUi.name.includes('deepseek') &&
            /命中 .*未命中 .*输出/.test(priceUi.prices) &&
            ['空闲价', '高峰价'].includes(priceUi.badge),
          JSON.stringify(priceUi)
        );
        check(
          '「手动配置」区可编辑（模型不在价目表中时用）',
          priceUi.manualInputs === 3 && priceUi.manualDisabled === true,
          JSON.stringify({ manualInputs: priceUi.manualInputs, manualDisabled: priceUi.manualDisabled })
        );

        // 说话钩子：server.js 在返回 /pet/mascot.js 时注入的那一行（磁盘 vendor 未改）
        const sayType = await win.webContents.executeJavaScript('typeof window.__dshWhaleMoeSay');
        check('桌宠页面暴露说话钩子 __dshWhaleMoeSay', sayType === 'function', sayType);

        /*
         * 高度：页面把"最高的一屏"量成 naturalHeight 报给主进程，主进程据此定窗口尺寸。
         * 断言 naturalHeight ≤ 窗口内容高度 —— 也就是说**不需要滚动条**就能看全，
         * 而不是"能用滚动条凑合"（那是兜底，不是通过标准）。
         */
        const [cw, ch] = settingsWin.getContentSize();
        const natural = await settingsWin.webContents.executeJavaScript(
          'Number(document.body.dataset.naturalHeight) || 0'
        );
        const scrollable = await settingsWin.webContents.executeJavaScript(
          "getComputedStyle(document.body).overflowY === 'auto'"
        );
        check(
          '窗口高度容得下最高的一屏（放不下时才有滚动条兜底）',
          natural > 0 && natural <= ch,
          `content=${cw}x${ch} natural=${natural} scrollable=${scrollable}`
        );
        log('[settings-probe] disable-features =', app.commandLine.getSwitchValue('disable-features'));
        const image = await captureImage(settingsWin.webContents);
        if (image) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, image.toPNG());
          const stats = analyzePixels(image);
          check(
            '设置窗口首帧就渲染出内容（非空白）',
            stats.darkRatio > 0.003 && stats.coloredRatio > 0.001,
            JSON.stringify(stats)
          );
          log('[settings-probe] screenshot', target);
        } else {
          check('设置窗口首帧就渲染出内容（非空白）', false, '截图三次都失败');
        }

        // 把焦点抢回桌宠窗口，再截一次：模拟"用户还没点设置窗口"的状态。
        // 这正是遮挡检测出问题时的表现场景（未聚焦 → 被判遮挡 → 不出帧 → 白屏）。
        win.focus();
        await new Promise((resolve) => setTimeout(resolve, 700));
        const blurredImage = await captureImage(settingsWin.webContents);
        if (blurredImage) {
          const stats = analyzePixels(blurredImage);
          check(
            '失去焦点后仍保持渲染（不白屏）',
            stats.darkRatio > 0.003 && stats.coloredRatio > 0.001,
            JSON.stringify(stats)
          );
        } else {
          check('失去焦点后仍保持渲染（不白屏）', false, '截图失败');
        }
        settingsWin.focus();

        // 2) 在设置窗口里关掉「台词气泡」
        await settingsWin.webContents.executeJavaScript(`(() => {
          const row = [...document.querySelectorAll('.row')].find((r) => (r.querySelector('.name') || {}).textContent === '台词气泡');
          const input = row.querySelector('input');
          input.checked = false;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 700));
        const seen = await win.webContents.executeJavaScript(
          `({ chat: localStorage.getItem('whale-moe:chat'), whaleAlive: Boolean(document.querySelector('[data-dsh-whale-root]')) })`
        );
        check('设置写入被桌宠页面读到（同源 localStorage）', seen.chat === '0' && seen.whaleAlive, JSON.stringify(seen));

        // 还原
        await settingsWin.webContents.executeJavaScript(`(() => {
          const row = [...document.querySelectorAll('.row')].find((r) => (r.querySelector('.name') || {}).textContent === '台词气泡');
          const input = row.querySelector('input');
          input.checked = true;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);

        // ---- 壳配置往返：窗口里切「总是置顶」，主进程状态必须跟着变 ----
        const before = win.isAlwaysOnTop();
        await settingsWin.webContents.executeJavaScript(`(() => {
          const row = [...document.querySelectorAll('.row')].find((r) => (r.querySelector('.name') || {}).textContent === '总是置顶');
          const input = row.querySelector('input');
          input.checked = !input.checked;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return input.checked;
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 600));
        const after = win.isAlwaysOnTop();
        check(
          '窗口里改「总是置顶」→ 主进程状态跟着变',
          before !== after && after === config.alwaysOnTop,
          `isAlwaysOnTop ${before} -> ${after}, config=${config.alwaysOnTop}`
        );
        // 托盘和设置窗口是同一份 config 的两个入口，勾选状态必须跟着走
        const trayItem = trayMenu ? trayMenu.items.find((item) => item.label === '总是置顶') : null;
        check(
          '托盘勾选状态跟随设置窗口变化',
          Boolean(trayItem) && trayItem.checked === config.alwaysOnTop,
          `tray.checked=${trayItem ? trayItem.checked : 'n/a'} config=${config.alwaysOnTop}`
        );
        // 还原
        await settingsWin.webContents.executeJavaScript(`(() => {
          const row = [...document.querySelectorAll('.row')].find((r) => (r.querySelector('.name') || {}).textContent === '总是置顶');
          const input = row.querySelector('input');
          input.checked = !input.checked;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      // 3) 页面内偏好面板的关闭按钮
      const panel = await win.webContents.executeJavaScript(`(() => {
        const gear = document.querySelector('[data-dsh-whale-gear]') || document.querySelector('[data-dsh-whale-gear-mini]');
        if (!gear) return { error: 'no gear button' };
        gear.click();
        const p = document.querySelector('[data-dsh-whale-prefs]');
        if (!p) return { error: 'no prefs panel' };
        const openedNow = !p.hidden;
        const close = p.querySelector('[data-dsh-whale-prefs-close]');
        if (!close) return { error: 'no injected close button', openedNow };
        close.click();
        return { openedNow, closed: p.hidden };
      })()`);
      check('页面内偏好面板可关闭（注入的 × 按钮）', Boolean(panel && panel.openedNow && panel.closed), JSON.stringify(panel));
    } catch (error) {
      log('[settings-probe] failed', error.message);
    }

    const failed = results.filter((r) => !r.ok).length;
    const expected = 20;
    log(
      '[settings-probe]',
      results.length !== expected
        ? `DONE 断言数不符：跑了 ${results.length} 项、预期 ${expected} 项，失败 ${failed} 项`
        : failed === 0
          ? `DONE 全部 ${expected} 项通过`
          : `DONE ${failed}/${expected} 项未通过`
    );
    app.exit(failed === 0 && results.length === expected ? 0 : 1);
  }, 3500);
}

// ---------------------------------------------------------------- 右键菜单越界探针
/**
 * 在屏幕右下角模拟一次右键，量出菜单是否溢出视口。
 *
 * 存在的理由：上游 showContextMenu 用写死的 180x160 估算尺寸夹取位置，
 * 菜单实际高度随项目数变化（最多 10 项），贴边时必然溢出。
 * 修完之后必须有可量化的证据，而不是"看着好像好了"。
 */
function runMenuProbe() {
  const target = typeof argValue('menu-probe') === 'string' ? argValue('menu-probe') : path.join(ROOT, 'tmp', 'menu-probe.png');
  setTimeout(async () => {
    try {
      const opened = await win.webContents.executeJavaScript(`(() => {
        const frame = document.querySelector('[data-dsh-whale-frame]');
        if (!frame) return { error: 'no whale frame' };
        const vw = window.innerWidth, vh = window.innerHeight;
        // 在右下角极贴近边缘处右键，最大化溢出风险
        frame.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: vw - 6, clientY: vh - 6,
        }));
        return { vw, vh };
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 700));

      const measured = await win.webContents.executeJavaScript(`(() => {
        const menu = document.querySelector('[data-dsh-whale-context]');
        if (!menu) return { error: 'context menu not found' };
        const r = menu.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        return {
          left: Math.round(r.left), top: Math.round(r.top),
          right: Math.round(r.right), bottom: Math.round(r.bottom),
          w: Math.round(r.width), h: Math.round(r.height),
          vw, vh,
          overflowRight: Math.max(0, Math.round(r.right - vw)),
          overflowBottom: Math.max(0, Math.round(r.bottom - vh)),
          overflowLeft: Math.max(0, Math.round(-r.left)),
          overflowTop: Math.max(0, Math.round(-r.top)),
          items: menu.querySelectorAll('button').length,
        };
      })()`);

      fs.mkdirSync(path.dirname(target), { recursive: true });
      const image = await win.webContents.capturePage();
      fs.writeFileSync(target, image.toPNG());

      log('[menu-probe] viewport', JSON.stringify(opened));
      log('[menu-probe] menu', JSON.stringify(measured));
      const ok = measured && !measured.error
        && measured.overflowRight === 0 && measured.overflowBottom === 0
        && measured.overflowLeft === 0 && measured.overflowTop === 0;
      log('[menu-probe]', ok ? 'PASS 菜单完全在屏幕内' : 'FAIL 菜单溢出视口');
      log('[menu-probe] screenshot', target);

      // 菜单构成（只应含交互项）由 npm run settings:probe 断言，这里不重复。
    } catch (error) {
      log('[menu-probe] failed', error.message);
    }
    app.exit(0);
  }, 3500);
}

// ---------------------------------------------------------------- 自检截图
function scheduleShot() {
  const raw = argValue('shot-delay');
  const delay = Number(raw) > 0 ? Number(raw) : 5000;
  const target = typeof argValue('shot') === 'string' ? argValue('shot') : path.join(ROOT, 'tmp', 'shot.png');
  setTimeout(async () => {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const image = await win.webContents.capturePage();
      fs.writeFileSync(target, image.toPNG());
      const size = image.getSize();
      log('[shot] saved', target, `${size.width}x${size.height}`);

      // 透明窗口的 capturePage 有可能把 alpha 压成不透明，
      // 直接读原始位图的 alpha 才能判定"窗口到底透不透明"。
      try {
        const bitmap = image.toBitmap();
        const px = (x, y) => {
          const i = (y * size.width + x) * 4;
          if (i < 0 || i + 3 >= bitmap.length) return null;
          return { b: bitmap[i], g: bitmap[i + 1], r: bitmap[i + 2], a: bitmap[i + 3] };
        };
        log('[shot] alpha probe', 'corner(4,4)=' + JSON.stringify(px(4, 4)), 'mid(960,120)=' + JSON.stringify(px(960, 120)));
      } catch (error) {
        log('[shot] alpha probe failed', error.message);
      }

      const state = await win.webContents.executeJavaScript(`(() => {
        const r = document.querySelector('[data-dsh-whale-root]');
        if (!r) return { root: false, bodyChildren: document.body.children.length };
        const cs = getComputedStyle(r);
        const layer = r.querySelector('img[data-dsh-whale-layer]');
        const frame = r.querySelector('[data-dsh-whale-frame]');
        const fr = frame ? frame.getBoundingClientRect() : null;
        return {
          root: true,
          mode: r.getAttribute('data-dsh-whale-mode'),
          busy: r.getAttribute('data-dsh-whale-busy'),
          position: cs.position,
          left: cs.left,
          top: cs.top,
          width: cs.width,
          height: cs.height,
          frameRect: fr ? { x: Math.round(fr.x), y: Math.round(fr.y), w: Math.round(fr.width), h: Math.round(fr.height) } : null,
          layerSrc: layer ? layer.getAttribute('src') : null,
          layerLoaded: layer ? (layer.complete && layer.naturalWidth > 0) : false,
          layerNatural: layer ? layer.naturalWidth + 'x' + layer.naturalHeight : null,
          bodyChildren: document.body.children.length,
          localStorageKeys: Object.keys(localStorage).filter((k) => k.startsWith('whale-moe:')),
        };
      })()`);
      log('[shot] dom', JSON.stringify(state));
    } catch (error) {
      log('[shot] failed', error.message);
    }
    app.exit(0);
  }, delay);
}

// ---------------------------------------------------------------- 打开 DSH
/**
 * 桌宠右键菜单里的「打开DSH」：**已经在跑就直接开浏览器，没跑才拉起来**。
 *
 * 有一条底线：**正在跑的 DSH 绝不重启**。用户此刻很可能正在里面聊天，
 * 重启会把会话一起带走（`dsh web` 的 token 是每次启动新生成的）。
 * 所以这里只做两件事：探活、必要时拉起。真正的启停策略归用户。
 *
 * 判定与命令解析在 src/open-dsh.js（纯 node，可脚本化验证），这里只负责
 * 进程与浏览器这两件必须有 Electron 才能干的事。
 */

/** 拉起来的 DSH 输出写这里（token 地址也在这里，排查时直接看）。 */
function dshWebLogFile() {
  return path.join(app.getPath('userData'), 'dsh-web.log');
}

/** 正在进行中的那一次「打开DSH」：连点两下不该拉起两个服务。 */
let openDshPending = null;

/** 最近一次「打开DSH」的结果，经 /__shell/state 暴露（自检与排查用）。 */
function rememberOpenDsh(result) {
  shellState.openDsh = { ...result, at: Date.now() };
  return result;
}

/** 开浏览器。dry-run 时只记日志 —— 自检不该往用户桌面上弹窗口。 */
async function openExternalSafe(url, dryRun) {
  if (dryRun) {
    log('[dsh] (dry-run) 本该打开', url);
    return false;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch (error) {
    log('[dsh] 打开浏览器失败', error.message);
    return false;
  }
}

/**
 * detached 起进程：桌宠退出后 DSH 要活着，所以 detached + unref。
 *
 * 输出直接接到日志文件的 fd 上（而不是管道）：父进程一旦退出，管道那一头就断了，
 * 服务往断掉的 stdout 写会出岔子。交给文件句柄则与父进程死活无关。
 */
function spawnDshWeb(spec, logPath) {
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fd = fs.openSync(logPath, 'a');
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd || ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, ...(spec.env || {}) },
    });
    child.on('error', (error) => log('[dsh] 子进程错误', spec.source, error.message));
    child.on('exit', (code, signal) => log('[dsh] 子进程退出', spec.source, 'code=' + code, 'signal=' + signal));
    child.unref();
    return child;
  } catch (error) {
    log('[dsh] 启动失败', spec.source, error.message);
    return null;
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

/**
 * 打开 DSH。返回 { ok, url, running, started, pid?, opened, dryRun, source, error }。
 *
 * `options` 是给探针用的替身入口（url / command / probe / timeoutMs / logPath / dryRun）：
 * 不注入任何东西时就是真实行为。
 */
async function openDshWeb(options = {}) {
  const url = resolveDshUrl({ configured: options.url || config.dshUrl });
  const dryRun = options.dryRun === undefined ? OPEN_DSH_DRY : Boolean(options.dryRun);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_BOOT_TIMEOUT_MS;
  const probe = typeof options.probe === 'function' ? options.probe : (target) => probeDshWeb(target);
  const logPath = options.logPath || dshWebLogFile();

  // 1) 已经在跑 —— 只开浏览器
  if (await probe(url)) {
    log('[dsh] 已经在跑，直接打开', url);
    const opened = await openExternalSafe(url, dryRun);
    return rememberOpenDsh({
      ok: true, url, running: true, started: false, opened, dryRun, source: null, error: null,
    });
  }

  // 2) 没在跑 —— 拉起来，等它应答，再开浏览器
  const spec = options.command || resolveDshCommand({ url, override: config.dshCommand });
  log('[dsh] 启动中', spec.source, JSON.stringify([spec.command, ...spec.args]), '→', logPath);
  const child = spawnDshWeb(spec, logPath);
  if (!child) {
    return rememberOpenDsh({
      ok: false, url, running: false, started: false, opened: false, dryRun,
      source: spec.source, error: 'spawn-failed', logPath,
    });
  }

  let tokenUrl = null;
  const ready = await waitForDshWeb({
    url,
    timeoutMs,
    probe,
    // 起来之前顺手从日志里捞 token 地址：服务每次启动都换 token，只有自己拉起来的这次拿得到
    onTick: () => {
      if (!tokenUrl) {
        tokenUrl = extractTokenUrl(readTextTail(logPath));
      }
    },
  });
  if (!tokenUrl) {
    tokenUrl = extractTokenUrl(readTextTail(logPath));
  }

  if (!ready) {
    log('[dsh] 启动超时', timeoutMs + 'ms', 'pid', child.pid, '→ 看', logPath);
    return rememberOpenDsh({
      ok: false, url, running: false, started: true, pid: child.pid, opened: false, dryRun,
      source: spec.source, error: 'timeout', logPath,
    });
  }

  const target = tokenUrl || url;
  const opened = await openExternalSafe(target, dryRun);
  log('[dsh] 已启动', 'pid', child.pid, '打开', target);
  return rememberOpenDsh({
    ok: true, url: target, baseUrl: normalizeUrl(url), running: false, started: true, pid: child.pid,
    opened, dryRun, source: spec.source, error: null, logPath,
  });
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.on('shell:interactive', (_event, value) => {
    if (!win || win.isDestroyed()) return;
    shellState.interactive = Boolean(value);
    shellState.updatedAt = Date.now();
    win.setIgnoreMouseEvents(!value, { forward: true });
  });
  ipcMain.on('shell:pet-rect', (_event, rect) => {
    // 整包存下来：除矩形外还带着渲染进程自己的 interactive 与 lastMouse，
    // 用于区分"鼠标事件没送到"和"DOM 命中判定失灵"。
    shellState.petRect = rect && typeof rect === 'object' ? rect : null;
  });
  ipcMain.handle('shell:get-config', () => ({ ...config, isPackaged: app.isPackaged }));
  ipcMain.handle('shell:set-config', (_event, patch) => {
    if (patch && typeof patch === 'object') {
      if (typeof patch.scale === 'number') setScale(patch.scale);
      if (typeof patch.alwaysOnTop === 'boolean') setAlwaysOnTop(patch.alwaysOnTop);
      if (typeof patch.autoLaunch === 'boolean') setAutoLaunch(patch.autoLaunch);
      if (typeof patch.followDsh === 'boolean') setFollowDsh(patch.followDsh);
      if (typeof patch.visible === 'boolean') setVisible(patch.visible);
      // 花费播报：纯主进程行为，改完即生效，不需要重启或刷新页面
      if (typeof patch.costSay === 'boolean') config.costSay = patch.costSay;
      for (const key of ['costThreshold', 'costPriceHit', 'costPriceMiss', 'costPriceOutput']) {
        if (patch[key] === undefined || patch[key] === null || patch[key] === '') continue;
        const value = Number(patch[key]);
        if (Number.isFinite(value) && value >= 0) config[key] = value;
      }
      // 「打开DSH」的地址与命令：纯字符串，改完即生效（下一次点菜单就用新的）
      for (const key of ['dshUrl', 'dshCommand']) {
        if (typeof patch[key] === 'string') config[key] = patch[key].trim();
      }
      saveConfig();
    }
    return { ...config };
  });
  ipcMain.handle('shell:app-info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    isPackaged: app.isPackaged,
  }));
  /*
   * 设置窗口的高度由**页面**量好报上来（见 settings.js 的 naturalHeight），
   * 这里只负责夹取与套用。
   *
   * 为什么量高度的活交给页面：两栏布局下"最高的一屏"只有页面知道，
   * 主进程读不到渲染进程的布局；而且它要用到"切换分类后重新量"的能力。
   */
  ipcMain.on('shell:settings-size', (event, height) => {
    if (!settingsWin || settingsWin.isDestroyed()) return;
    // 只认设置窗口自己报的高度：同源的桌宠页面也能 invoke 这个通道
    if (event.sender !== settingsWin.webContents) return;
    const needed = Number(height);
    if (!Number.isFinite(needed) || needed <= 0) return;
    /*
     * +4 是给"最后一行的 margin"留的余量：offsetHeight 不含子元素的下外边距，
     * 页面量出来的值会比真实内容少几像素 —— 少这几像素就会平白多出一条滚动条。
     */
    const target = Math.min(Math.max(Math.round(needed) + 4, 220), maxAuxContentHeight());
    const [width, current] = settingsWin.getContentSize();
    if (Math.abs(target - current) > 2) {
      settingsWin.setContentSize(width, target);
      const [, after] = settingsWin.getContentSize();
      log('[settings] content sized to', needed, '->', after, target < needed ? '(已到上限，将可滚动)' : '');
    }
  });
  /**
   * 价目信息：设置窗口「单价」区域用。
   *
   * 返回的是**已经定好的数字**，页面只负责显示 —— 峰谷判定与表/手动之分只存在于
   * src/price-table.js 一处。页面每 2 秒问一次，这样用户中途换模型也能自动跟上。
   */
  ipcMain.handle('shell:price-info', () => {
    const now = Date.now();
    const resolved = currentRates(now, dshWatcher ? dshWatcher.model : null);
    const hit = lookupModel(priceTable, currentModel);
    const entry = hit ? hit.entry : null;
    const pair = (v) => ({ idle: v ? Number(v.idle) : null, peak: v ? Number(v.peak) : null });
    return {
      model: currentModel || '',
      inTable: Boolean(hit),
      matchedBy: hit ? hit.matchedBy : null,
      label: entry ? entry.label || hit.key : '',
      source: resolved.source,
      peak: isPeak(now),
      rates: resolved.rates,
      // 表里这个模型的完整价格（空闲/高峰都给，页面用来展示"当前用哪一档"）
      tablePrices: entry
        ? {
            cacheHit: pair(entry.cacheHit),
            cacheMiss: pair(entry.cacheMiss),
            output: pair(entry.output),
          }
        : null,
      table: {
        ok: priceTable.ok,
        file: priceTable.file,
        updatedAt: priceTable.updatedAt,
        sourceUrl: priceTable.source,
        unit: priceTable.unit,
        currency: priceTable.currency,
        peakNote: priceTable.peakNote,
        models: priceTable.modelNames,
      },
      manual: {
        cacheHitPerM: Number(config.costPriceHit),
        cacheMissPerM: Number(config.costPriceMiss),
        outputPerM: Number(config.costPriceOutput),
      },
    };
  });
  ipcMain.on('shell:reload', () => win && win.webContents.reload());
  ipcMain.on('shell:reset-position', () => resetPosition());
  ipcMain.on('shell:open-path', (_event, which) => {
    const target = which === 'log' ? logFile() : app.getPath('userData');
    require('electron').shell.openPath(target).catch((error) => log('[shell] openPath failed', error.message));
  });
  ipcMain.on('shell:open-settings', () => openSettingsWindow());
  ipcMain.on('shell:open-growth', (_event, tab) => openGrowthWindow(tab));
  /**
   * 「打开DSH」（桌宠右键菜单 / 设置窗口的「打开」按钮）：
   * 已经在跑就开浏览器，没跑就 detached 拉起来再开。
   * 并发调用共享同一次操作 —— 连点两下不该拉起两个服务。
   */
  ipcMain.handle('shell:open-dsh', () => {
    if (!openDshPending) {
      openDshPending = openDshWeb().finally(() => {
        openDshPending = null;
      });
    }
    return openDshPending;
  });
  /** 设置窗口的"测试播报"按钮：直接让她说一句，用来确认钩子在真实环境里可用。 */
  ipcMain.handle('shell:say', async (_event, text, holdMs) => {
    const sample = { inputTokens: 352, cacheReadTokens: 1540992, outputTokens: 5164 };
    const line = String(text ?? '').trim() || announceText(sample, costOf(sample, currentRates(Date.now()).rates));
    const ok = await sayToPet(line, holdMs);
    log('[say] manual', ok ? 'ok' : 'unavailable', `hold=${Number(holdMs) || SAY_HOLD_MS}`, line);
    return { ok, text: line };
  });
  /**
   * 今日消耗：气泡里的「余额查询」用。
   *
   * 数字已经格式化好再交出去 —— 千分位/万/亿/小数的规则只应存在于 src/pricing.js 一处，
   * 页面里再写一遍迟早和播报对不上。
   */
  ipcMain.handle('shell:usage-today', () => {
    const today = usageLedger ? usageLedger.today() : { date: null, tokens: 0, cost: 0, turns: 0 };
    return {
      date: today.date,
      turns: today.turns,
      tokens: today.tokens,
      cost: today.cost,
      tokensText: formatTokens(today.tokens),
      costText: today.cost > 0 ? formatMoney(today.cost).replace('¥', '') : '0',
    };
  });

  /*
   * 养成的两个动作必须回到桌宠页面执行：领取任务要跑 applyGrowth / 成就算 /
   * 粒子与台词，佩戴称号要派发 whale-moe-prefs-change 让她重画 —— 这些副作用
   * 都在页面里。主进程直接把页面里的 hook 调一下，拿回结果即可。
   */
  ipcMain.handle('shell:claim-quest', async (_event, id) => {
    if (!win || win.isDestroyed()) return { ok: false, error: '桌宠窗口未运行' };
    try {
      const done = await win.webContents.executeJavaScript(
        `(typeof window.__dshWhaleMoeClaimQuest === 'function') ? window.__dshWhaleMoeClaimQuest(${JSON.stringify(String(id))}) : false`
      );
      log('[pet-action] claim-quest', String(id), '->', done);
      return { ok: Boolean(done) };
    } catch (error) {
      log('[pet-action] claim-quest failed', error.message);
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('shell:equip-badge', async (_event, id) => {
    if (!win || win.isDestroyed()) return { ok: false, error: '桌宠窗口未运行' };
    try {
      await win.webContents.executeJavaScript(
        `(typeof window.__dshWhaleMoeApplyBadge === 'function') ? window.__dshWhaleMoeApplyBadge(${JSON.stringify(String(id || ''))}) : null`
      );
      log('[pet-action] equip-badge', JSON.stringify(String(id || '')));
      return { ok: true };
    } catch (error) {
      log('[pet-action] equip-badge failed', error.message);
      return { ok: false, error: error.message };
    }
  });
  ipcMain.on('shell:quit', () => {
    isQuitting = true;
    app.quit();
  });
  ipcMain.on('shell:log', (_event, payload) => {
    const level = payload && payload.level ? payload.level : 'info';
    const message = payload && payload.message ? payload.message : String(payload);
    log('[page]', level, message);
  });
}

// ---------------------------------------------------------------- 启动
// 自检模式要与常驻实例并存（探针会另起一个窗口），所以跳过单实例锁。
if (!PROBE_MODE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      setVisible(true);
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    config = loadConfig();
    registerIpc();

    try {
      server = await startPetServer({
        petDir: PET_DIR,
        vendorDir: VENDOR_DIR,
        port: PORT_OVERRIDE ?? config.port,
        log: (...parts) => log(...parts),
        stateProvider: () => ({
          interactive: shellState.interactive,
          ignoreMouseEvents: !shellState.interactive,
          petRect: shellState.petRect,
          dsh: dshWatcher ? dshWatcher.snapshot() : null,
          lastDshState,
          openDsh: shellState.openDsh || null,
          updatedAt: shellState.updatedAt,
          cursor: screen.getCursorScreenPoint(),
          workArea: screen.getPrimaryDisplay().workArea,
          visible: win && !win.isDestroyed() ? win.isVisible() : null,
          focused: win && !win.isDestroyed() ? win.isFocused() : null,
        }),
      });
      log('[server] listening', server.url);
    } catch (error) {
      log('[server] failed to start', error.message);
      app.exit(1);
      return;
    }

    createWindow();
    createTray();

    /*
     * 价目表：运行时只读本地 pricing.json（不联网 —— 没有价格 API，爬页面会静默失效）。
     * 刷新靠人工：`npm run refresh:prices` 抓官方页面 + diff，确认后提交。
     * 当前模型先取 DSH 设置文件里的默认模型，之后由会话记录里的 request/header 校正。
     */
    log(
      '[price] 价目表',
      priceTable.ok ? '已加载' : `加载失败（${priceTable.error}）→ 全部走手动配置`,
      priceTable.ok ? `${priceTable.modelNames.join(' / ')} · ${priceTable.updatedAt}` : '',
      '当前模型',
      currentModel || '(未知)',
    );

    /*
     * 「今日消耗」账本。必须在 watcher 之前建好：watcher 一启动就会回放当天的历史 turn
     * 来补账，账本还没建的话那批账会直接丢掉（见 src/usage-today.js）。
     *
     * 自检实例用另一个文件名：它与常驻实例共用同一个 userData，
     * 两边同时往同一个 JSON 里写会互相覆盖（自检只是临时跑一下，不该动用户的账）。
     */
    usageLedger = new UsageLedger({
      file: path.join(app.getPath('userData'), PROBE_MODE ? 'usage-today-probe.json' : 'usage-today.json'),
      log: (...parts) => log(...parts),
    });

    startDshWatcher();

    /*
     * 内置余额代理。上游把余额接口写死成 http://127.0.0.1:3020/balance，
     * 而 DeepSeek 官方接口的字段名与它要的形状不同 —— 这里自己起一个满足契约的服务，
     * Key 自动从 DSH 凭据库（~/.dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY）读取，
     * 用户不需要手工配置。3020 被占用不算致命：那说明用户有自己的代理。
     */
    try {
      balanceProxy = await startBalanceProxy({
        port: 3020,
        userDataDir: app.getPath('userData'),
        log: (...args) => log('[balance]', ...args),
      });
    } catch (error) {
      balanceProxy = null;
      log('[balance] 未启动（端口被占用或出错）:', error.message);
    }

    // 开机自启在开发态与打包态路径不同，启动时用配置校正一次
    if (config.autoLaunch) setAutoLaunch(true);

    const accelerator = 'Alt+Shift+W';
    if (!globalShortcut.register(accelerator, toggleVisible)) {
      log('[shortcut] register failed', accelerator);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // 托盘常驻，不因为窗口关闭而退出；真正退出走托盘菜单
    if (isQuitting) app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('will-quit', async () => {
    globalShortcut.unregisterAll();
    stopDshWatcher();
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.destroy();
    if (growthWin && !growthWin.isDestroyed()) growthWin.destroy();
    if (balanceProxy) await balanceProxy.close();
    if (server) await server.close();
  });
}
