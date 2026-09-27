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
