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

  window.addEventListener(
    'mousemove',
    (event) => {
      setInteractive(hitTest(event.clientX, event.clientY));
    },
    { passive: true }
  );

  window.addEventListener('mouseleave', () => setInteractive(false));

  // 兜底：窗口失焦后一律回到穿透，避免"卡在接收鼠标"把桌面点不动
  window.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (!document.querySelector('[data-dsh-whale-menu]')) {
        setInteractive(false);
      }
    }, 400);
  });

  // 启动即穿透
  setInteractive(false);

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
    });
  }

  setInterval(reportRect, 2000);
  window.addEventListener('load', () => window.setTimeout(reportRect, 300));
})();
