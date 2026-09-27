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
const { startPetServer } = require('./server');
const { DshStateWatcher } = require('./dsh-state');

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
/** 自检用：强制跳过单实例锁，便于与常驻实例并存做封闭测试。 */
const STANDALONE = argValue('standalone') !== undefined;
/** 自检用：临时覆盖监听端口，避免与常驻实例抢同一个源。 */
const PORT_OVERRIDE = Number(argValue('port')) > 0 ? Number(argValue('port')) : null;
/** shot / menu-probe / standalone 都是自检模式，要允许与常驻实例并存。 */
const PROBE_MODE = SHOT_MODE || MENU_PROBE || STANDALONE || DSH_PROBE || SETTINGS_PROBE;

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
  });
  dshWatcher.start();
  log('[dsh] watcher started');
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
function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }
  settingsWin = new BrowserWindow({
    width: 580,
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
  // 内容高度随字体/缩放/分类数量而变，按实际渲染高度自适应
  settingsWin.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 250)); // 等 IPC 渲染完各分组
      const needed = await settingsWin.webContents.executeJavaScript('Math.ceil(document.body.scrollHeight)');
      if (needed > 0) {
        const [width] = settingsWin.getContentSize();
        const capped = Math.min(Math.max(needed, 200), 760);
        settingsWin.setContentSize(width, capped);
        if (needed > capped) {
          // 小屏幕上放不下就让它可以滚，别硬裁掉
          await settingsWin.webContents.executeJavaScript("document.body.style.overflowY = 'auto'");
        }
        log('[settings] content sized to', needed, 'capped', capped);
      }
    } catch (error) {
      log('[settings] auto-size failed', error.message);
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

// ---------------------------------------------------------------- 菜单分工 & 设置窗口探针
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
          '设置窗口按分类展示（4 类）',
          structure.sections.length === 4,
          JSON.stringify(structure.sections)
        );
        const expectedRows = [
          '看板娘', '台词气泡', '粒子效果',
          '总是置顶', '跟随 DSH 工作状态', '开机自启',
          '大小', '位置',
          '重新加载页面', '数据目录', '运行日志',
        ];
        const missing = expectedRows.filter((name) => !structure.rows.includes(name));
        check('设置窗口含全部可配置项', missing.length === 0, missing.length ? JSON.stringify(missing) : `${structure.rows.length} 项`);

        const [cw, ch] = settingsWin.getContentSize();
        const scrollH = await settingsWin.webContents.executeJavaScript('Math.ceil(document.body.scrollHeight)');
        check('窗口高度容得下全部内容（无滚动条）', scrollH <= ch, `content=${cw}x${ch} scrollHeight=${scrollH}`);
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
    const expected = 13;
    log(
      '[settings-probe]',
      results.length < expected
        ? `DONE 只跑到 ${results.length}/${expected} 项（中途出错），失败 ${failed} 项`
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
    if (server) await server.close();
  });
}
