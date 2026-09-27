'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 独立设置窗口的桥。
 *
 * 只暴露"设置"需要的那几件事；桌宠偏好（看板娘/台词气泡/粒子效果）
 * 不走这里 —— 那个窗口与桌宠页面同源，直接用 localStorage 就行。
 */
contextBridge.exposeInMainWorld('whaleSettings', {
  getConfig: () => ipcRenderer.invoke('shell:get-config'),
  setConfig: (patch) => ipcRenderer.invoke('shell:set-config', patch),
  resetPosition: () => ipcRenderer.send('shell:reset-position'),
  reloadPet: () => ipcRenderer.send('shell:reload'),
  openDataDir: () => ipcRenderer.send('shell:open-path', 'data'),
  openLog: () => ipcRenderer.send('shell:open-path', 'log'),
  appInfo: () => ipcRenderer.invoke('shell:app-info'),
  /** 当前模型 + 它对应的单价、价目表信息（只读展示，见 main.js 的 shell:price-info）。 */
  priceInfo: () => ipcRenderer.invoke('shell:price-info'),
  /** 让她说一句话（设置窗口的"测试播报"按钮）。 */
  say: (text) => ipcRenderer.invoke('shell:say', text),
  /** 上报"内容自然高度"：窗口尺寸由页面量、主进程设（见 settings.js 的 naturalHeight）。 */
  setContentHeight: (height) => ipcRenderer.send('shell:settings-size', height),
});
