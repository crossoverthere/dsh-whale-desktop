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

const ROOT = path.join(__dirname, '..');
const PET_DIR = path.join(__dirname, 'pet');
const VENDOR_DIR = path.join(ROOT, 'vendor', 'whale');

// 必须在 app ready 之前定名：否则 userData 目录会用 productName（中文），
// 日志/配置路径带中文会给脚本化排查添麻烦。
app.setName('dsh-whale-desktop');

const argv = process.argv.slice(1);
const argValue = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const SHOT_MODE = argValue('shot') !== undefined;

let win = null;
let tray = null;
let server = null;
let config = null;
let isQuitting = false;

/** 自检用运行时状态：外部脚本可经 /__shell/state 读取。 */
const shellState = { interactive: false, petRect: null, updatedAt: 0 };

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
    if (SHOT_MODE) scheduleShot();
  });

  screen.on('display-metrics-changed', applyBounds);
  screen.on('display-added', applyBounds);
  screen.on('display-removed', applyBounds);
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
function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '显示桌宠', type: 'checkbox', checked: config.visible, click: () => setVisible(!config.visible) },
    { type: 'separator' },
    { label: '总是置顶', type: 'checkbox', checked: config.alwaysOnTop, click: () => setAlwaysOnTop(!config.alwaysOnTop) },
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
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const icon = buildTrayIcon();
  log('[tray] icon', icon.isEmpty() ? 'EMPTY(退回系统默认)' : `${icon.getSize().width}x${icon.getSize().height}`);
  tray = new Tray(icon);
  tray.setToolTip('鲸鱼娘桌宠');
  refreshTrayMenu();
  tray.on('click', toggleVisible);
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
    shellState.petRect = rect && typeof rect === 'object' ? rect : null;
  });
  ipcMain.handle('shell:get-config', () => ({ ...config, isPackaged: app.isPackaged }));
  ipcMain.handle('shell:set-config', (_event, patch) => {
    if (patch && typeof patch === 'object') {
      if (typeof patch.scale === 'number') setScale(patch.scale);
      if (typeof patch.alwaysOnTop === 'boolean') setAlwaysOnTop(patch.alwaysOnTop);
      if (typeof patch.autoLaunch === 'boolean') setAutoLaunch(patch.autoLaunch);
      if (typeof patch.visible === 'boolean') setVisible(patch.visible);
    }
    return { ...config };
  });
  ipcMain.on('shell:reload', () => win && win.webContents.reload());
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
if (!app.requestSingleInstanceLock()) {
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
        port: config.port,
        stateProvider: () => ({
          interactive: shellState.interactive,
          ignoreMouseEvents: !shellState.interactive,
          petRect: shellState.petRect,
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
    if (server) await server.close();
  });
}
