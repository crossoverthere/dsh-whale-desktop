'use strict';

/**
 * 壳胶水（渲染进程）。
 *
 * 核心职责只有一个：**点击穿透的实时判定**。
 *
 * 窗口是整屏透明置顶的，默认让所有鼠标事件穿过去（setIgnoreMouseEvents(true, {forward:true})）。
 * 只在指针真正压到桌宠（或它弹出的菜单/特效）上时，才临时把窗口切回"接收鼠标"，
 * 这样既不会挡住桌面操作，桌宠的点击/拖拽/右键菜单又全部照常。
 *
 * 判定方式利用了上游 CSS 的结构：容器 pointer-events:none，可交互部件 pointer-events:auto，
 * 所以 elementFromPoint 命中到 html/body 以外的东西就意味着"压到桌宠了"。
 */
(function () {
  'use strict';

  const api = window.whaleShell;
  if (!api) {
    return;
  }

  // ---------- 日志回传（无界面时靠它排查）----------
  api.log('info', 'shell bridge ready');
  window.addEventListener('error', (event) => {
    api.log('error', `window.onerror: ${event.message} @ ${event.filename}:${event.lineno}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    api.log('error', `unhandledrejection: ${(reason && reason.message) || reason}`);
  });
  window.addEventListener('load', () => {
    const root = document.querySelector('[data-dsh-whale-root]');
    const frames = root ? root.querySelectorAll('img[data-dsh-whale-frame], img[data-dsh-whale-layer]').length : 0;
    api.log('info', `dom ready: whaleRoot=${Boolean(root)} imgNodes=${frames} bodyChildren=${document.body.children.length}`);
  });

  // ---------- 点击穿透 ----------
  let interactive = null;
  /** 诊断用：渲染进程最后收到的鼠标信息，经 /__shell/state 暴露。 */
  let lastMouse = null;

  function setInteractive(next) {
    if (next === interactive) {
      return;
    }
    interactive = next;
    api.setInteractive(next);
  }

  function hitTest(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    return Boolean(el) && el !== document.documentElement && el !== document.body;
  }

  /** 统一入口：页内 mousemove 与主进程光标轮询都走这里。 */
  function applyCursor(clientX, clientY, source) {
    const hit = hitTest(clientX, clientY);
    const el = document.elementFromPoint(clientX, clientY);
    lastMouse = {
      x: Math.round(clientX),
      y: Math.round(clientY),
      hit,
      source,
      target: el ? el.tagName + (el.getAttributeNames ? '[' + el.getAttributeNames().join(',') + ']' : '') : null,
      at: Date.now(),
    };
    setInteractive(hit);
  }

  window.addEventListener(
    'mousemove',
    (event) => applyCursor(event.clientX, event.clientY, 'mousemove'),
    { passive: true }
  );

  // 主通道：主进程轮询屏幕光标（不依赖 Windows 的鼠标事件转发，见 preload.js 注释）
  if (typeof api.onCursor === 'function') {
    api.onCursor((pos) => {
      if (pos && typeof pos.x === 'number') {
        applyCursor(pos.x, pos.y, 'poll');
      }
    });
  }

  window.addEventListener('mouseleave', () => {
    lastMouse = { x: null, y: null, hit: false, leave: true, at: Date.now() };
    setInteractive(false);
  });

  // 兜底：窗口失焦后一律回到穿透，避免"卡在接收鼠标"把桌面点不动
  window.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (!document.querySelector('[data-dsh-whale-context]')) {
        setInteractive(false);
      }
    }, 400);
  });

  // 启动即穿透
  setInteractive(false);

  // ---------- 右键菜单越界修正 ----------
  // 上游 showContextMenu 用写死的 180x160 估算菜单尺寸夹取位置
  // （vendor/whale/dsh-whale-moe.js 第 610-611 行），但菜单高度随项目数变化
  // —— 实测 8 项就有 292px 高，贴屏幕右下角时必然溢出（实测右溢 14px、下溢 132px）。
  //
  // 修在壳层而不是改上游素材：一旦改了 vendor/whale，`npm run sync:upstream`
  // 就会把它冲掉。这里改为在菜单出现后用**实测尺寸**重新夹取回视口内。
  const CONTEXT_SELECTOR = '[data-dsh-whale-context]';
  const EDGE_MARGIN = 8;
  const clampObservers = new WeakMap();

  function clampIntoViewport(menu) {
    if (!menu || !menu.isConnected) {
      return;
    }
    const rect = menu.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 视口比菜单还小时退化为贴左上角，至少不出现负坐标
    const maxLeft = Math.max(EDGE_MARGIN, vw - rect.width - EDGE_MARGIN);
    const maxTop = Math.max(EDGE_MARGIN, vh - rect.height - EDGE_MARGIN);
    const nextLeft = Math.round(Math.min(Math.max(rect.left, EDGE_MARGIN), maxLeft));
    const nextTop = Math.round(Math.min(Math.max(rect.top, EDGE_MARGIN), maxTop));
    // 只在确有偏差时写回，避免与下面的 style 观察器互相触发
    if (Math.abs(nextLeft - rect.left) > 0.5) {
      menu.style.left = `${nextLeft}px`;
    }
    if (Math.abs(nextTop - rect.top) > 0.5) {
      menu.style.top = `${nextTop}px`;
    }
  }

  function watchMenu(menu) {
    clampIntoViewport(menu);
    // 布局可能要到下一帧才稳定，再夹一次兜底
    requestAnimationFrame(() => clampIntoViewport(menu));
    if (clampObservers.has(menu)) {
      return;
    }
    const observer = new MutationObserver(() => clampIntoViewport(menu));
    observer.observe(menu, { attributes: true, attributeFilter: ['style'] });
    clampObservers.set(menu, observer);
  }

  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) {
          continue;
        }
        if (node.matches(CONTEXT_SELECTOR)) {
          watchMenu(node);
        } else if (typeof node.querySelectorAll === 'function') {
          node.querySelectorAll(CONTEXT_SELECTOR).forEach(watchMenu);
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // ---------- 右键菜单「打开看板娘设置」在桌面模式下的替代行为 ----------
  // 上游那一项是去找 **DSH 页面**的设置入口（`[data-slot="sidebar.settings"] button`
  // → `[data-slot="settings.trigger"]` → 文本"设置"兜底），独立桌面版没有 DSH 页面，
  // 点了自然毫无反应。
  //
  // 修在壳层：页面上确实没有 DSH 入口时，改为打开桌宠**自带的偏好面板**
  // （就是齿轮 ⚙ 那个，等价物），vendor/whale 依旧不改。
  const SETTINGS_ITEM_LABEL = '打开看板娘设置';

  /** 页面里到底有没有 DSH 的设置入口（有就让上游自己处理，别抢）。 */
  function hasDshSettingsEntry() {
    if (document.querySelector('[data-slot="sidebar.settings"] button')) {
      return true;
    }
    const trigger = document.querySelector('[data-slot="settings.trigger"]');
    if (trigger && typeof trigger.closest === 'function' && trigger.closest('button')) {
      return true;
    }
    return Array.from(document.querySelectorAll('button')).some(
      (node) => (node.textContent || '').trim() === '设置'
    );
  }

  /** 打开桌宠自带的偏好面板（等价于点齿轮 ⚙）。 */
  function openPetPrefs() {
    const prefs = document.querySelector('[data-dsh-whale-prefs]');
    if (!prefs) {
      api.log('error', 'openPetPrefs: 找不到 [data-dsh-whale-prefs]');
      return false;
    }
    prefs.hidden = false;
    api.log('info', '已用桌宠自带偏好面板替代「打开看板娘设置」');
    return true;
  }

  // 用捕获阶段：此时右键菜单还挂在 DOM 上，判定最可靠。
  // 不阻止上游 handler（它会负责关掉右键菜单），只在其后补一个动作。
  document.addEventListener(
    'click',
    (event) => {
      const button =
        event.target && typeof event.target.closest === 'function'
          ? event.target.closest('[data-dsh-whale-context] button')
          : null;
      if (!button) {
        return;
      }
      if ((button.textContent || '').trim() !== SETTINGS_ITEM_LABEL) {
        return;
      }
      if (hasDshSettingsEntry()) {
        return; // 有 DSH 入口，上游自己能处理
      }
      window.setTimeout(openPetPrefs, 0);
    },
    true
  );

  // ---------- DSH 工作状态 → 上游信号合成 ----------
  // 上游判断"在忙"靠的是页面里存在这些 DOM 信号（只看存在性，不读业务文本）：
  //   thinking → [data-status="pending"]
  //   tool     → [data-running]   （detectToolPose 还会读它的 textContent 选具体姿势）
  //   success  → [data-state="success"]
  //   error    → [data-status="error"]
  //
  // 桌面版不在 DSH 页面里，拿不到这些节点，于是由壳层按主进程读到的 DSH 状态
  // **合成**它们 —— 上游一个字都不用改，状态机/立绘/状态签全部照原样复用。
  //
  // 合成节点必须满足上游 isVisible()：盒子 >1px、与视口相交、opacity 不能正好是 "0"。
  // 另外上游对 error 节点有"基线"机制：首次 reconcile 时已存在的错误节点会被当作
  // 历史记录忽略 —— 所以 error 节点必须**按需新建**、闪完即删，不能开机就摆着。
  const SIGNAL_HOST_ID = 'dsh-whale-shell-signals';

  /** DSH 工具名 → 上游关键词（顺序敏感：上游按 deploy/test/debug/search/write/bash/review/plan 依次匹配）。 */
  const TOOL_HINTS = Object.freeze({
    pwsh: 'bash shell 命令',
    bash: 'bash shell 命令',
    terminal: 'bash shell 命令',
    read: 'search grep 读取',
    glob: 'search glob 查找',
    grep: 'search grep 查找',
    write: 'write edit 写入',
    edit: 'write edit 修改文件',
    str_replace: 'write edit 修改文件',
    web_search: 'search 搜索',
    web_fetch: 'search 搜索',
    todo_write: 'plan todo 计划',
    create_goal: 'plan todo 计划',
    update_goal: 'plan todo 计划',
    subagent: 'plan 计划',
    workflow: 'plan 计划',
    present: 'write 写入',
    job_output: 'bash shell 命令',
  });

  const SIGNAL_ATTRS = Object.freeze({
    thinking: { 'data-status': 'pending' },
    tool: { 'data-running': '' },
    success: { 'data-state': 'success' },
    error: { 'data-status': 'error' },
  });
  const signalNodes = new Map();

  function ensureSignalHost() {
    let host = document.getElementById(SIGNAL_HOST_ID);
    if (host && host.isConnected) {
      return host;
    }
    host = document.createElement('div');
    host.id = SIGNAL_HOST_ID;
    host.setAttribute('aria-hidden', 'true');
    // 透明、不可点、2x2 且贴在视口内 —— 只为满足上游 isVisible() 的存在性判定
    host.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;overflow:visible';
    document.body.appendChild(host);
    return host;
  }

  function setSignal(name, on, text) {
    const existing = signalNodes.get(name);
    if (!on) {
      if (existing) {
        existing.remove();
        signalNodes.delete(name);
      }
      return;
    }
    let node = existing;
    if (!node || !node.isConnected) {
      node = document.createElement('i');
      for (const [key, value] of Object.entries(SIGNAL_ATTRS[name])) {
        node.setAttribute(key, value);
      }
      node.style.cssText = 'display:block;width:2px;height:2px;opacity:0.01';
      ensureSignalHost().appendChild(node);
      signalNodes.set(name, node);
    }
    const next = typeof text === 'string' && text.length ? text : 'tool 工作中';
    if (node.textContent !== next) {
      node.textContent = next;
    }
  }

  function applyDshState(payload) {
    const state = payload && typeof payload.state === 'string' ? payload.state : 'idle';
    const tool = payload ? payload.tool : null;
    setSignal('thinking', state === 'thinking');
    setSignal('tool', state === 'tool', tool ? (TOOL_HINTS[tool] || String(tool)) : null);
    setSignal('success', state === 'success');
    setSignal('error', state === 'failure');
  }

  if (typeof api.onDshState === 'function') {
    api.onDshState((payload) => {
      try {
        applyDshState(payload);
      } catch (error) {
        api.log('error', 'applyDshState failed: ' + error.message);
      }
    });
  }

  // ---------- 上报桌宠矩形（供自检端点/自动化测试用）----------
  function reportRect() {
    const frame = document.querySelector('[data-dsh-whale-frame]');
    if (!frame) {
      return;
    }
    const r = frame.getBoundingClientRect();
    api.reportPetRect({
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      dpr: window.devicePixelRatio,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      interactive,
      lastMouse,
    });
  }

  setInterval(reportRect, 2000);
  window.addEventListener('load', () => window.setTimeout(reportRect, 300));
})();
