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

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, globalShortcut } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { startPetServer } = require('./server');
const { DshStateWatcher } = require('./dsh-state');
const { startBalanceProxy } = require('./balance-proxy');
const { costOf, shouldAnnounce, announceText } = require('./pricing');

/** 内置余额代理（见 src/balance-proxy.js）。 */
let balanceProxy = null;

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
/** 自检用：强制跳过单实例锁，便于与常驻实例并存做封闭测试。 */
const STANDALONE = argValue('standalone') !== undefined;
/** 自检用：临时覆盖监听端口，避免与常驻实例抢同一个源。 */
const PORT_OVERRIDE = Number(argValue('port')) > 0 ? Number(argValue('port')) : null;
/** shot / menu-probe / standalone 都是自检模式，要允许与常驻实例并存。 */
const PROBE_MODE =
  SHOT_MODE || MENU_PROBE || STANDALONE || DSH_PROBE || SETTINGS_PROBE || GROWTH_PROBE || SAY_PROBE;

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
    onTurnEnd: (event) => announceTurnCost(event),
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
function sayToPet(text) {
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  const script = `(function(){ if (typeof window.__dshWhaleMoeSay !== 'function') return false; window.__dshWhaleMoeSay(${JSON.stringify(
    String(text),
  )}); return true; })()`;
  return win.webContents.executeJavaScript(script).catch((error) => {
    log('[say] failed', error.message);
    return false;
  });
}

/**
 * 一个 turn 结束后播报花费。
 *
 * 阈值的作用是"别为几分钱刷屏"：低于阈值连日志都不写（正常任务动辄上千万 tokens，
 * 真到了无声无息反而更值得怀疑，所以跳过时留一行日志便于排查）。
 *
 * 计时点用 Date.now() 而不是 turn 开始时间：峰谷价按**结算时刻**算更接近实际账单，
 * 而且跨峰谷的 turn 本来就只能给一个估算值。
 */
function announceTurnCost({ usage, reason }) {
  if (!config || config.costSay === false) return;
  const prices = {
    cacheHitPerM: Number(config.costPriceHit),
    cacheMissPerM: Number(config.costPriceMiss),
    outputPerM: Number(config.costPriceOutput),
  };
  const at = Date.now();
  const cost = costOf(usage, prices, at);
  if (!shouldAnnounce(cost, config.costThreshold)) {
    log('[cost] 低于阈值，不播报', cost.toFixed(6), 'reason=', reason ? reason.kind : 'n/a');
    return;
  }
  const text = announceText(usage, cost);
  log('[cost]', text, 'reason=', reason ? reason.kind : 'n/a');
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
     * 宽度是为"不出现滚动条"服务的：设置项是"标题 + 说明"的长文本，
     * 宽度不够时说明会折行，每折一行就多一行的高度。
     * 高度则按实际渲染结果量出来（见下面的 did-finish-load），这里给的只是初值。
     */
    width: 900,
    height: 620,
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
   * 内容高度跟着实际渲染结果走（分类数量、字体、缩放都会变）。
   *
   * 为什么要反复量：设置项是 renderShellConfig() 里 await 一次 IPC 之后才插进 DOM 的，
   * did-finish-load 时量到的是"还没渲染完"的高度，只量一次会得到一个偏矮的窗口。
   * 所以量到连续两次相同（渲染稳定）为止。
   *
   * 上限用工作区高度而不是写死的 760：写死的话，多一组设置就会静默多出一条滚动条
   * （不报错，只是最后一组被压到折叠线以下）。
   */
  settingsWin.webContents.once('did-finish-load', async () => {
    const cap = maxAuxContentHeight();
    let previous = -1;
    for (let i = 0; i < 12; i++) {
      if (!settingsWin || settingsWin.isDestroyed()) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
      let needed;
      try {
        needed = await settingsWin.webContents.executeJavaScript('Math.ceil(document.body.scrollHeight)');
      } catch (error) {
        log('[settings] auto-size failed', error.message);
        return;
      }
      if (needed === previous) break;
      previous = needed;
      if (!needed) return;
      const capped = Math.min(Math.max(needed + 2, 200), cap);
      const [width, current] = settingsWin.getContentSize();
      if (Math.abs(capped - current) > 2) {
        settingsWin.setContentSize(width, capped);
        const [, after] = settingsWin.getContentSize();
        log('[settings] content sized to', needed, '->', after, capped < needed ? '(已到上限，将可滚动)' : '');
      }
      if (needed > cap) {
        // 小屏幕上放不下就让它可以滚，别硬裁掉
        await settingsWin.webContents.executeJavaScript("document.body.style.overflowY = 'auto'");
      }
    }
  });
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
    { label: '称号…', click: () => openGrowthWindow('badges') },
    { label: '成就…', click: () => openGrowthWindow('achievements') },
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
        return {
          found: true,
          hidden: el.hidden,
          parentIsRoot: el.parentElement === document.querySelector('[data-dsh-whale-root]'),
          rows: [...el.querySelectorAll('.hud-row')].map((r) => r.getAttribute('data-hud-row')),
          action: (el.querySelector('.hud-action') || {}).textContent || null,
          prefsHidden: prefs ? getComputedStyle(prefs).display === 'none' : null,
        };
      })()`);
      check(
        '头顶浮层结构正确（天气 / 余额 + 养成入口，挂在桌宠根节点下）',
        Boolean(hud.found && hud.parentIsRoot && (hud.rows || []).join(',') === 'weather,balance' && hud.action === '日常养成'),
        JSON.stringify(hud)
      );
      check('浮层初始隐藏，且上游偏好面板已被隐藏', hud.found && hud.hidden === true && hud.prefsHidden === true, JSON.stringify({ hidden: hud.hidden, prefsHidden: hud.prefsHidden }));

      // ---- 2) 齿轮打开浮层 ----
      const shown = await win.webContents.executeJavaScript(`(() => {
        const gear = document.querySelector('[data-dsh-whale-gear]') || document.querySelector('[data-dsh-whale-gear-mini]');
        if (!gear) return { error: 'no gear' };
        gear.click();
        const el = document.getElementById('dsh-whale-shell-hud');
        return {
          hidden: el.hidden,
          texts: [...el.querySelectorAll('.hud-row')].map((r) => (r.querySelector('.k') || {}).textContent + ' / ' + (r.querySelector('.v') || {}).textContent),
        };
      })()`);
      check(
        '点齿轮 ⚙ 打开浮层，且每行都有文案',
        shown && shown.hidden === false && (shown.texts || []).every((t) => t && t.split(' / ')[0]),
        JSON.stringify(shown)
      );

      // ---- 3) 「日常养成」打开养成窗口 ----
      const clicked = await win.webContents.executeJavaScript(`(() => {
        const btn = document.querySelector('#dsh-whale-shell-hud .hud-action');
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
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
      const trayLabels = buildTrayTemplate().map((item) => item.label || `(${item.type})`);
      check(
        '托盘含「称号…」「成就…」',
        trayLabels.includes('称号…') && trayLabels.includes('成就…'),
        JSON.stringify(trayLabels)
      );
      const badgeItem = buildTrayTemplate().find((item) => item.label === '称号…');
      if (badgeItem && growthWin && !growthWin.isDestroyed()) {
        badgeItem.click();
        await new Promise((resolve) => setTimeout(resolve, 900));
        const tabNow = await growthWin.webContents.executeJavaScript(
          `(document.querySelector('#tabs button[aria-selected="true"]') || {}).dataset.tab`
        );
        check('托盘「称号…」把窗口切到称号页', tabNow === 'badges', JSON.stringify({ tabNow }));
      } else {
        check('托盘「称号…」把窗口切到称号页', false, '托盘项或窗口缺失');
      }
      // ---- 7) 天气端到端：从另一个窗口设城市 → 桌宠页面应主动预取 ----
      // 必须从**另一个窗口**写，才能触发同源 storage 事件（同文档写不触发）——
      // 这正是真实路径：城市是在设置窗口里改的。
      const beforeCity = await win.webContents.executeJavaScript("localStorage.getItem('whale-moe:weatherCity')");
      const setter = new BrowserWindow({
        width: 400,
        height: 300,
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
      });
      await setter.loadURL(`${server.url}/pet/settings.html`);
      await setter.webContents.executeJavaScript("localStorage.setItem('whale-moe:weatherCity', '上海')");
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
      check('天气端到端：另一个窗口改城市 → 桌宠主动预取真实天气', Boolean(weather), JSON.stringify(weather));

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
    const expected = 15;
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
      // 与单测同一组样本值：真实 turn 的用量
      const sample = { inputTokens: 352, cacheReadTokens: 1540992, outputTokens: 5164 };
      const expected = announceText(sample, costOf(sample, null, Date.now()));

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
       * 阈值闸门：清空气泡后播报一个远低于阈值的花费，气泡里不应再出现 tokens。
       * 注意断言的是"没有出现花费文案"，而不是"气泡保持隐藏"——
       * 桌宠可能在等待期间自己冒一句日常台词（那是正常的），
       * 拿 hidden 当条件会随机失败。
       */
      await win.webContents.executeJavaScript(`(() => {
        const bubble = document.querySelector('[data-dsh-whale-bubble]');
        const text = document.querySelector('[data-dsh-whale-bubble-text]');
        if (text) text.textContent = '';
        if (bubble) bubble.hidden = true;
        return true;
      })()`);
      announceTurnCost({ usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 }, reason: { kind: 'completed' } });
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
    const expected = 5;
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

// ---------------------------------------------------------------- 设置窗口探针
/**
 * 覆盖职责划分与设置窗口两件事：
 *   1) 桌宠右键菜单只留交互项（不该再有「打开看板娘设置」）
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
        const expectedRows = [
          '看板娘', '台词气泡', '粒子效果',
          '总是置顶', '跟随 DSH 工作状态', '开机自启',
          '大小', '位置',
          '重新加载页面', '数据目录', '运行日志',
          '天气城市', '天气 API Key', '显示余额', '余额接口',
          '播报本次花费', '播报阈值（元）', '单价（元/百万）',
        ];
        const missing = expectedRows.filter((name) => !structure.rows.includes(name));
        check('设置窗口含全部可配置项', missing.length === 0, missing.length ? JSON.stringify(missing) : `${structure.rows.length} 项`);

        // 说话钩子：server.js 在返回 /pet/mascot.js 时注入的那一行（磁盘 vendor 未改）
        const sayType = await win.webContents.executeJavaScript('typeof window.__dshWhaleMoeSay');
        check('桌宠页面暴露说话钩子 __dshWhaleMoeSay', sayType === 'function', sayType);

        const [cw, ch] = settingsWin.getContentSize();
        const scrollH = await settingsWin.webContents.executeJavaScript('Math.ceil(document.body.scrollHeight)');
        const scrollable = await settingsWin.webContents.executeJavaScript(
          "getComputedStyle(document.body).overflowY === 'auto'"
        );
        check(
          '窗口高度容得下全部内容（放不下时必须可滚动，不能裁掉）',
          scrollH <= ch || scrollable === true,
          `content=${cw}x${ch} scrollHeight=${scrollH} scrollable=${scrollable}`
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
    const expected = 14;
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
  ipcMain.on('shell:reload', () => win && win.webContents.reload());
  ipcMain.on('shell:reset-position', () => resetPosition());
  ipcMain.on('shell:open-path', (_event, which) => {
    const target = which === 'log' ? logFile() : app.getPath('userData');
    require('electron').shell.openPath(target).catch((error) => log('[shell] openPath failed', error.message));
  });
  ipcMain.on('shell:open-settings', () => openSettingsWindow());
  ipcMain.on('shell:open-growth', (_event, tab) => openGrowthWindow(tab));
  /** 设置窗口的"测试播报"按钮：直接让她说一句，用来确认钩子在真实环境里可用。 */
  ipcMain.handle('shell:say', async (_event, text) => {
    const line = String(text ?? '').trim() || announceText(
      { inputTokens: 352, cacheReadTokens: 1540992, outputTokens: 5164 },
      costOf({ inputTokens: 352, cacheReadTokens: 1540992, outputTokens: 5164 }, null, Date.now()),
    );
    const ok = await sayToPet(line);
    log('[say] manual', ok ? 'ok' : 'unavailable', line);
    return { ok, text: line };
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
