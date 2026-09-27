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
  quit: () => ipcRenderer.send('shell:quit'),
  /** 渲染进程日志/报错回传，方便无界面时排查。 */
  log: (level, message) => ipcRenderer.send('shell:log', { level, message }),
  /** 供未来接 DSH 工作状态联动：主进程推 busy 状态进页面。 */
  onBusy: (cb) => {
    const handler = (_event, value) => cb(Boolean(value));
    ipcRenderer.on('shell:busy', handler);
    return () => ipcRenderer.removeListener('shell:busy', handler);
  },
});
