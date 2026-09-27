'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 养成 / 图鉴窗口的桥。
 *
 * 读数据不经过这里 —— 窗口与桌宠页面同源，直接读 localStorage。
 * 只有"需要回到桌宠页面才能做"的动作才走 IPC：
 *   · 领取任务（要跑 applyGrowth / 成就算 / 粒子与台词）
 *   · 佩戴称号（要派发 whale-moe-prefs-change 让她重画）
 */
contextBridge.exposeInMainWorld('whaleGrowth', {
  claimQuest: (id) => ipcRenderer.invoke('shell:claim-quest', id),
  equipBadge: (id) => ipcRenderer.invoke('shell:equip-badge', id),
  /** 窗口被复用、主进程要求切标签时。 */
  onTab: (cb) => {
    const handler = (_event, tab) => cb(tab);
    ipcRenderer.on('growth:tab', handler);
    return () => ipcRenderer.removeListener('growth:tab', handler);
  },
});
