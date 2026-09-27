'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 页面（桌宠 + 壳胶水）与主进程之间的唯一通道。
 * contextIsolation 打开，页面拿不到 require / node。
 */
contextBridge.exposeInMainWorld('whaleShell', {
  /** 鼠标是否落在可交互区域：true 时窗口接收点击，false 时整屏穿透。 */
  setInteractive: (value) => ipcRenderer.send('shell:interactive', Boolean(value)),
  /** 上报桌宠当前矩形，供自检端点与外部脚本使用。 */
  reportPetRect: (rect) => ipcRenderer.send('shell:pet-rect', rect),
  getConfig: () => ipcRenderer.invoke('shell:get-config'),
  setConfig: (patch) => ipcRenderer.invoke('shell:set-config', patch),
  reload: () => ipcRenderer.send('shell:reload'),
  /** 打开独立的设置窗口（由主进程创建 BrowserWindow）。 */
  openSettings: () => ipcRenderer.send('shell:open-settings'),
  /** 打开养成 / 图鉴窗口；tab: quests | signin | badges | journal | achievements */
  openGrowth: (tab) => ipcRenderer.send('shell:open-growth', tab),
  quit: () => ipcRenderer.send('shell:quit'),
  /** 让她说一句话（气泡里的「余额查询」用它播报）。文本由页面组装，holdMs = 打完字后停留多久。 */
  say: (text, holdMs) => ipcRenderer.invoke('shell:say', text, holdMs),
  /** 今日消耗（主进程按 turn 记账，见 src/usage-today.js）：tokens/cost 已格式化好。 */
  getTodayUsage: () => ipcRenderer.invoke('shell:usage-today'),
  /** 渲染进程日志/报错回传，方便无界面时排查。 */
  log: (level, message) => ipcRenderer.send('shell:log', { level, message }),
  /**
   * 主进程轮询来的「屏幕光标 - 窗口原点」相对坐标（DIP）。
   *
   * 为什么不直接用页面的 mousemove：Windows 上
   * setIgnoreMouseEvents(true, { forward: true }) 的转发并不可靠，
   * 实测合成鼠标移动收不到任何 mousemove，穿透判定就会彻底失灵。
   * 改由主进程 screen.getCursorScreenPoint 轮询推送，判定不再依赖转发。
   */
  onCursor: (cb) => {
    const handler = (_event, pos) => cb(pos);
    ipcRenderer.on('shell:cursor', handler);
    return () => ipcRenderer.removeListener('shell:cursor', handler);
  },
  /** 供未来接 DSH 工作状态联动：主进程推 busy 状态进页面。 */
  onBusy: (cb) => {
    const handler = (_event, value) => cb(Boolean(value));
    ipcRenderer.on('shell:busy', handler);
    return () => ipcRenderer.removeListener('shell:busy', handler);
  },
  /**
   * DSH 工作状态（主进程读会话文件得到）：
   * { state: 'idle'|'thinking'|'tool'|'success'|'failure', tool: string|null, ... }
   */
  onDshState: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('shell:dsh-state', handler);
    return () => ipcRenderer.removeListener('shell:dsh-state', handler);
  },
});
