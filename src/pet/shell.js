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
    stripNonInteractionItems(menu);
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

  // ---------- 桌宠右键菜单只留"对她做的事" ----------
  // 上游菜单里「打开看板娘设置」属于应用级配置，按职责划分应该走
  // 托盘 → 设置窗口，所以壳层把它从桌宠菜单里摘掉。
  //
  // 只在"页面上确实没有 DSH 设置入口"时摘：将来若把这个页面嵌回 DSH，
  // 上游原有的行为应当原样保留，我们不抢。
  const NON_INTERACTION_ITEMS = ['打开看板娘设置'];

  /** 页面里到底有没有 DSH 的设置入口。 */
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

  function stripNonInteractionItems(menu) {
    if (hasDshSettingsEntry()) {
      return;
    }
    for (const button of menu.querySelectorAll('button')) {
      const label = (button.textContent || '').trim();
      if (NON_INTERACTION_ITEMS.includes(label)) {
        button.remove();
        api.log('info', `已从桌宠右键菜单摘掉「${label}」（它属于设置，已移到托盘 → 设置窗口）`);
      }
    }
  }

  // ---------- 页面内偏好面板：补一个能关掉它的入口 ----------
  // 上游面板只能靠齿轮 ⚙ 开合，而齿轮在台词气泡里、气泡 4.5 秒后自动隐藏，
  // 于是面板一打开就没有可点的关闭入口 —— 这是上游在独立宿主下的设计缺口。
  // 壳层给它注入一个 × 按钮，并补上「点外面关闭 / Esc 关闭」。
  let panelCloseTarget = null;

  function ensurePanelClose() {
    // 桌宠 DOM 变动很频繁，这里先做最便宜的短路
    if (panelCloseTarget && panelCloseTarget.isConnected) {
      return;
    }
    const panel = document.querySelector('[data-dsh-whale-prefs]');
    if (!panel) {
      return;
    }
    // 上游给 [data-dsh-whale-prefs] button 定了 flex 行样式，
    // 所以这里必须用内联样式（内联优先于样式表）把它压成一个小圆钮。
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-dsh-whale-prefs-close', 'true');
    button.title = '关闭设置';
    button.setAttribute('aria-label', '关闭设置');
    button.textContent = '×';
    button.style.cssText = [
      'position:absolute',
      'top:4px',
      'right:6px',
      'display:block',
      'width:18px',
      'height:18px',
      'padding:0',
      'margin:0',
      'line-height:16px',
      'font-size:14px',
      'text-align:center',
      'color:inherit',
      'background:transparent',
      'border:0',
      'border-radius:6px',
      'box-shadow:none',
      'cursor:pointer',
      'opacity:0.6',
    ].join(';');
    button.addEventListener('mouseenter', () => {
      button.style.opacity = '1';
    });
    button.addEventListener('mouseleave', () => {
      button.style.opacity = '0.6';
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      panel.hidden = true;
    });
    if (getComputedStyle(panel).position === 'static') {
      panel.style.position = 'relative';
    }
    // 给 × 让出位置，免得压住第一个开关
    panel.style.paddingTop = '20px';
    panel.appendChild(button);
    panelCloseTarget = panel;
    api.log('info', '已给页面内偏好面板注入关闭按钮');
  }
  // 桌宠根节点是后挂到 body 的，出现后再注入。
  // 注意：这里**不能**同步调用 ensureHud() —— HUD_ID 用 const 声明在本文件更靠后的位置，
  // 提前调用会踩暂时性死区（TDZ）抛错，把后面整段脚本都带停。
  // 观察器回调是异步的，那时声明已经执行过，调用是安全的。
  ensurePanelClose();
  new MutationObserver(() => {
    ensurePanelClose();
    ensureHud();
  }).observe(document.body, { childList: true, subtree: true });

  // 点面板外面关闭：上游给 rootNode 挂了 stopPropagation，
  // 所以"能冒泡到 document 的点击"天然就是"点在桌宠之外"。
  document.addEventListener('click', () => {
    const panel = document.querySelector('[data-dsh-whale-prefs]');
    if (panel && !panel.hidden) {
      panel.hidden = true;
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    const panel = document.querySelector('[data-dsh-whale-prefs]');
    if (panel && !panel.hidden) {
      panel.hidden = true;
    }
  });

  // ---------- 头顶浮层：天气 / 余额 / 养成入口 ----------
  // 上游那块位置原本是三个开关（看板娘/台词气泡/粒子效果）——它们已经进了设置窗口，
  // 于是壳层把这块位置改造成"状态 + 入口"。齿轮 ⚙ 仍然负责开合它。
  const HUD_ID = 'dsh-whale-shell-hud';
  let hudTimer = null;

  function hudReadWeather() {
    const state = window.__dshWhaleMoeWeather || {};
    const core = window.DshWhaleMoeCore;
    const city = String(state.city || '').trim();
    if (!city) {
      return { main: '未设置城市', sub: '点这里去设置', tone: 'muted' };
    }
    const current = state.current;
    if (!current) {
      return { main: city, sub: state.status === 'error' ? '获取失败' : '获取中…', tone: 'muted' };
    }
    const text = core && core.weatherText ? core.weatherText(current.code) : { emoji: '🌡️', label: '' };
    return { main: `${text.emoji} ${city} ${Math.round(current.temp)}°`, sub: text.label, tone: 'ok' };
  }

  function hudReadBalance() {
    let enabled = false;
    try {
      enabled = localStorage.getItem('whale-moe:balance') === '1';
    } catch (error) {
      enabled = false;
    }
    if (!enabled) {
      return { main: '未启用余额', sub: '点这里去设置', tone: 'muted' };
    }
    const state = window.__dshWhaleMoeBalance;
    if (!state || !state.ok) {
      return { main: '余额不可用', sub: '余额接口无响应', tone: 'muted' };
    }
    const core = window.DshWhaleMoeCore;
    const amount = Number(state.amount);
    // 金额要精确到分：上游的 formatBalance(…, false) 只给档位措辞（充裕/紧张…），
    // 所以把确切数字放到主行，档位词退到副行。
    const shown = Number.isFinite(amount) ? amount.toFixed(2) : String(state.amount);
    const tier = core && core.formatBalance ? core.formatBalance(amount, state.currency, false) : state.tier;
    return { main: `💰 ${state.currency} ${shown}`, sub: tier || '', tone: 'ok' };
  }

  // 天气预取。
  // 上游只在**空闲聊天**里才 weatherEnsure()（间隔数分钟且要求她正闲着），
  // 于是「设置里填了城市 → 浮层一直显示获取中」可能要等很久。
  // 这里由壳层主动拉一次同样的 Open-Meteo 接口，并把结果写回
  // `window.__dshWhaleMoeWeather` —— 它就是上游闭包里的 weatherState（同一引用），
  // 所以她的天气特效、天气台词、浮层显示会一起用上这份数据。
  // vendor 不改；上游自己到点照常刷新，两边不冲突。
  const WEATHER_FRESH_MS = 2 * 3600 * 1000;
  let weatherPending = false;

  function weatherStored(key) {
    try {
      return (localStorage.getItem('whale-moe:' + key) || '').trim();
    } catch (error) {
      return '';
    }
  }

  async function ensureWeatherFresh(force) {
    const state = window.__dshWhaleMoeWeather;
    const city = weatherStored('weatherCity');
    if (!state || !city || weatherPending) {
      return;
    }
    const fresh = state.current && Date.now() - (state.fetchedAt || 0) < WEATHER_FRESH_MS;
    if (!force && fresh) {
      return;
    }
    weatherPending = true;
    try {
      const key = weatherStored('weatherKey');
      const keyParam = key ? `&apikey=${encodeURIComponent(key)}` : '';
      const geo = await (await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json${keyParam}`
      )).json();
      const hit = geo && Array.isArray(geo.results) ? geo.results[0] : null;
      if (!hit) {
        throw new Error('城市未找到');
      }
      const wx = await (await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}` +
          `&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m&timezone=auto${keyParam}`
      )).json();
      if (!wx || !wx.current) {
        throw new Error('无天气数据');
      }
      state.current = {
        temp: Number(wx.current.temperature_2m),
        code: String(wx.current.weather_code),
        wind: Number(wx.current.wind_speed_10m || 0),
        humidity: Number(wx.current.relative_humidity_2m || 0),
      };
      state.fetchedAt = Date.now();
      state.status = 'ok';
      state.city = city;
      state.key = key;
      try {
        localStorage.setItem('whale-moe:weatherLat', String(hit.latitude));
        localStorage.setItem('whale-moe:weatherLon', String(hit.longitude));
      } catch (error) {
        /* 缓存坐标失败无所谓 */
      }
      api.log('info', `天气已预取：${city} ${Math.round(state.current.temp)}°`);
    } catch (error) {
      state.status = 'error';
      api.log('error', 'weather prefetch failed: ' + error.message);
    } finally {
      weatherPending = false;
      refreshHud();
    }
  }

  function hudRow(key, loader, onClick) {
    const row = document.createElement('div');
    row.className = 'hud-row';
    row.setAttribute('data-hud-row', key);
    const main = document.createElement('span');
    main.className = 'k';
    const sub = document.createElement('span');
    sub.className = 'v';
    row.append(main, sub);
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    row.__update = () => {
      const info = loader();
      main.textContent = info.main;
      sub.textContent = info.sub || '';
      row.setAttribute('data-tone', info.tone || 'muted');
    };
    return row;
  }

  function ensureHud() {
    const existing = document.getElementById(HUD_ID);
    if (existing && existing.isConnected) {
      return existing;
    }
    const rootNode = document.querySelector('[data-dsh-whale-root]');
    if (!rootNode) {
      return null;
    }
    const hud = document.createElement('div');
    hud.id = HUD_ID;
    hud.hidden = true;

    const toSettings = () => {
      if (typeof api.openSettings === 'function') {
        api.openSettings();
      }
    };
    const toGrowth = (tab) => {
      if (typeof api.openGrowth === 'function') {
        api.openGrowth(tab);
      }
    };

    const weatherRow = hudRow('weather', hudReadWeather, toSettings);
    const balanceRow = hudRow('balance', hudReadBalance, toSettings);

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'hud-action';
    action.textContent = '日常养成';
    action.addEventListener('click', (event) => {
      event.stopPropagation();
      toGrowth('quests');
    });

    hud.append(weatherRow, balanceRow, action);
    hud.__refresh = () => {
      weatherRow.__update();
      balanceRow.__update();
    };
    rootNode.append(hud);
    hud.__refresh();
    api.log('info', '头顶浮层已就绪（天气 / 余额 / 日常养成）');
    return hud;
  }

  function refreshHud() {
    const hud = document.getElementById(HUD_ID);
    if (hud && hud.__refresh) {
      hud.__refresh();
    }
    // 顺带保证天气是新的（新鲜时零开销，直接返回）
    ensureWeatherFresh(false);
  }

  function setHudVisible(visible) {
    const hud = ensureHud();
    if (!hud) {
      return false;
    }
    hud.hidden = !visible;
    if (visible) {
      refreshHud();
      if (!hudTimer) {
        // 天气/余额是异步来的，浮层开着时定期刷一下
        hudTimer = window.setInterval(refreshHud, 1500);
      }
    } else if (hudTimer) {
      window.clearInterval(hudTimer);
      hudTimer = null;
    }
    return true;
  }

  // 齿轮 ⚙ 改开合我们这块浮层。
  // 上游的 handler 仍会 toggle 那个已被我们隐藏的偏好面板，无副作用，不去抢它。
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      if (!target.closest('[data-dsh-whale-gear], [data-dsh-whale-gear-mini]')) {
        return;
      }
      const hud = ensureHud();
      if (hud) {
        setHudVisible(hud.hidden);
      }
    },
    true
  );

  // 点桌宠之外收起浮层（能冒泡到 document 的点击 = 点在桌宠之外）
  document.addEventListener('click', () => {
    const hud = document.getElementById(HUD_ID);
    if (hud && !hud.hidden) {
      setHudVisible(false);
    }
  });

  // 声明都已执行，这里可以安全地先建一次（桌宠根节点通常已经在了）
  ensureHud();
  // 启动时若已配了城市，先把天气拉一次，免得第一次打开浮层还要等
  window.setTimeout(() => ensureWeatherFresh(false), 1200);

  // ---------- 独立设置窗口改了偏好后，让上游重新读一遍 ----------
  // 两个窗口同源，所以走 storage 事件就够了，不需要额外 IPC。
  window.addEventListener('storage', (event) => {
    const key = event.key || '';
    if (!key.startsWith('whale-moe:')) {
      return;
    }
    // 城市/Key 变了就立刻重拉天气，别等她下次闲聊
    if (key === 'whale-moe:weatherCity' || key === 'whale-moe:weatherKey') {
      ensureWeatherFresh(true);
    }
    window.dispatchEvent(
      new CustomEvent('whale-moe-prefs-change', {
        detail: { key: key.slice('whale-moe:'.length), value: event.newValue },
      })
    );
  });

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
      // 浮层内容也上报：主进程读不到渲染进程的 localStorage，
      // 把结果带出来才能在外部（/__shell/state）断言"天气/余额真的显示出来了"
      hud: {
        weather: hudReadWeather(),
        balance: hudReadBalance(),
      },
    });
  }

  setInterval(reportRect, 2000);
  window.addEventListener('load', () => window.setTimeout(reportRect, 300));
})();
