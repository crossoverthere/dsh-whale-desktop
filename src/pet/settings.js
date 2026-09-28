'use strict';

/**
 * 独立设置窗口。
 *
 * 两类设置，走两条不同的通道：
 *
 * 1) **桌宠偏好**（看板娘 / 台词气泡 / 粒子效果）—— 存在 localStorage 的
 *    `whale-moe:*`。本窗口与桌宠页面**同源**，直接共用同一份存储；
 *    页面侧监听 `storage` 事件再派发上游认识的 `whale-moe-prefs-change`，
 *    改完立即生效，不需要 IPC。
 *
 * 2) **壳配置**（置顶 / 跟随 DSH / 开机自启 / 缩放 / 重置位置 / 维护动作）——
 *    属于主进程，经 `window.whaleSettings`（settings-preload.js）走 IPC。
 */
(function () {
  'use strict';

  const api = window.whaleSettings || {};

  // ---------------------------------------------------------------- 工具
  function row(label, hint, control) {
    const wrap = document.createElement('label');
    wrap.className = 'row';
    const text = document.createElement('div');
    text.className = 'text';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = label;
    text.append(name);
    if (hint) {
      const hintNode = document.createElement('div');
      hintNode.className = 'hint';
      hintNode.textContent = hint;
      text.append(hintNode);
    }
    wrap.append(text, control);
    return wrap;
  }

  function toggle(checked, onChange) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    return input;
  }

  function actionButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'action';
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      onClick();
    });
    return button;
  }

  // ---------------------------------------------------------------- 0. 二级菜单
  /*
   * 左侧一级分类、右侧对应设置。
   *
   * 为什么做成两栏而不是长列表：设置项已经二十多个，全铺在一屏里既长又难找；
   * 分成一屏一屏之后，窗口还能矮一大截（最高的一屏决定窗口高度）。
   *
   * 左侧导航**由 section 生成**，不写死在 HTML 里：
   * 否则"加了一屏忘了加导航"或者"改了 h2 忘了改导航文案"这类漂移迟早发生。
   */
  const panels = [...document.querySelectorAll('section[data-panel]')];
  const rail = document.getElementById('rail');
  const railButtons = new Map();
  /** 记住上次看的分类：设置窗口是反复开的，每次都跳回第一项很烦。 */
  const TAB_KEY = 'whale-moe:settingsTab';
  let activeName = '';

  function activate(name, remember = true) {
    activeName = name;
    for (const panel of panels) {
      panel.hidden = panel.dataset.panel !== name;
    }
    for (const [key, button] of railButtons) {
      button.setAttribute('aria-selected', key === name ? 'true' : 'false');
    }
    if (remember) {
      try {
        localStorage.setItem(TAB_KEY, name);
      } catch (error) {
        /* 存储不可用不影响使用 */
      }
    }
  }

  for (const panel of panels) {
    const button = document.createElement('button');
    button.type = 'button';
    const heading = panel.querySelector('h2');
    button.textContent = (heading ? heading.textContent : panel.dataset.panel).trim();
    button.addEventListener('click', () => activate(panel.dataset.panel));
    rail.append(button);
    railButtons.set(panel.dataset.panel, button);
  }

  let preferredTab = '';
  try {
    preferredTab = localStorage.getItem(TAB_KEY) || '';
  } catch (error) {
    preferredTab = '';
  }
  activate(railButtons.has(preferredTab) ? preferredTab : panels[0].dataset.panel, false);

  // ---------------------------------------------------------------- 1. 桌宠偏好（localStorage）
  const PET_PREFS = [
    { key: 'pet', label: '看板娘', hint: '关掉后她离开桌面；本窗口仍可把她打开' },
    { key: 'chat', label: '台词气泡', hint: '互动时冒出的台词气泡' },
    { key: 'particles', label: '粒子效果', hint: '爱心、星星等粒子特效' },
  ];

  function readPref(key) {
    try {
      return localStorage.getItem('whale-moe:' + key) !== '0';
    } catch (error) {
      return true;
    }
  }

  function writePref(key, on) {
    try {
      localStorage.setItem('whale-moe:' + key, on ? '1' : '0');
    } catch (error) {
      /* 存储不可用时静默，别把窗口弄崩 */
    }
  }

  const petInputs = new Map();
  const petGroup = document.getElementById('group-pet');
  for (const pref of PET_PREFS) {
    const input = toggle(readPref(pref.key), (on) => writePref(pref.key, on));
    petInputs.set(pref.key, input);
    petGroup.append(row(pref.label, pref.hint, input));
  }

  // 齿轮面板（页面内那个）改过之后，把勾选状态同步回来
  window.addEventListener('storage', (event) => {
    const key = event.key || '';
    if (!key.startsWith('whale-moe:')) {
      return;
    }
    const short = key.slice('whale-moe:'.length);
    const input = petInputs.get(short);
    if (input) {
      input.checked = readPref(short);
    }
  });

  // ---------------------------------------------------------------- 2. 壳配置（IPC）
  const SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5];

  function applyConfig(patch) {
    if (typeof api.setConfig === 'function') {
      return api.setConfig(patch);
    }
    return Promise.resolve(null);
  }

  /**
   * 「DSH WebUI」：地址可改（换了端口/主机的人），点「打开」走主进程那套
   * 「已经在跑就只开浏览器、没跑就拉起来」的逻辑 —— 与右键菜单里的「打开DSH」
   * 是同一件事，只是这里还能顺手把地址改掉。
   *
   * 说明文字里写上**这次打算用哪条路把它拉起来**（工作空间启动脚本？dsh CLI？npx？）：
   * 起不来的原因十有八九是"走的那条路不对"，先把那件事摆出来，再谈排查。
   *
   * 反馈写在行内的 hint 里（和「测试播报」同一套做法）：这个动作要等好几秒，
   * 没有反馈用户只会以为没点上。
   */
  function dshRow(config) {
    const wrap = document.createElement('div');
    wrap.className = 'row';
    const text = document.createElement('div');
    text.className = 'text';
    text.append(Object.assign(document.createElement('div'), { className: 'name', textContent: 'DSH WebUI' }));
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '已经在跑就只打开浏览器；没跑就把它拉起来';
    text.append(hint);

    const field = document.createElement('div');
    field.className = 'field-group';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    input.value = config.dshUrl || '';
    input.placeholder = 'http://127.0.0.1:3080';
    input.addEventListener('change', () => applyConfig({ dshUrl: input.value.trim() }));
    input.addEventListener('click', (event) => event.preventDefault());

    /* 拉起方式：只显示"是什么"，完整路径挂在 title 上（长路径会把这一行撑破）。 */
    async function describePlan() {
      if (typeof api.dshPlan !== 'function') {
        return;
      }
      try {
        const plan = await api.dshPlan();
        // 脚本路线真正执行的是那个脚本（plan.file 只是跑它的 cmd.exe），别显示错了
        const target = plan.kind === 'script' && plan.script ? plan.script : plan.file;
        const base = String(target || '').split(/[\\/]/).filter(Boolean).pop() || target;
        const how = plan.kind === 'script' ? `启动脚本 ${base}` : `dsh CLI（${base}）`;
        hint.textContent = `已经在跑就只打开浏览器；没跑就用 ${how} 拉起来`;
        wrap.title = `${plan.file} ${(plan.args || []).join(' ')}\n脚本：${plan.script || '(无)'}\n日志：${plan.logPath}`;
      } catch (error) {
        /* 拿不到就保留默认文案 */
      }
    }

    const opened = actionButton('打开', async () => {
      if (typeof api.openDsh !== 'function') {
        return;
      }
      hint.textContent = '正在打开…';
      try {
        const result = await api.openDsh();
        if (!result || !result.ok) {
          hint.textContent = `没起来（${(result && result.error) || '未知错误'}）—— 细节看运行日志`;
        } else if (result.opened === false && result.dryRun !== true) {
          hint.textContent = '地址已就绪，但浏览器没打开 —— 细节看运行日志';
        } else if (result.running) {
          hint.textContent = '本来就在跑，只开了浏览器';
        } else {
          hint.textContent = `刚拉起来（${result.pid}），已交给浏览器`;
        }
        if (result && result.dryRun) {
          hint.textContent += '（演练，未真的打开）';
        }
      } catch (error) {
        hint.textContent = `失败：${(error && error.message) || error}`;
      }
    });

    field.append(input, opened);
    wrap.append(text, field);
    describePlan();
    return wrap;
  }

  async function renderShellConfig() {
    if (typeof api.getConfig !== 'function') {
      return;
    }
    const config = await api.getConfig();

    const windowGroup = document.getElementById('group-window');
    windowGroup.append(
      row('总是置顶', '浮在其它窗口之上', toggle(config.alwaysOnTop, (on) => applyConfig({ alwaysOnTop: on }))),
      row('跟随 DSH 工作状态', '读会话文件，思考/工具/完成/出错时换立绘', toggle(config.followDsh, (on) => applyConfig({ followDsh: on }))),
      row('开机自启', '登录 Windows 后自动把她叫起来', toggle(config.autoLaunch, (on) => applyConfig({ autoLaunch: on })))
    );

    const sizeGroup = document.getElementById('group-size');
    const select = document.createElement('select');
    for (const value of SCALES) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = `${Math.round(value * 100)}%`;
      option.selected = Math.abs(config.scale - value) < 0.001;
      select.append(option);
    }
    select.addEventListener('change', () => applyConfig({ scale: Number(select.value) }));
    sizeGroup.append(
      row('大小', '整体缩放', select),
      row('位置', '把她叫回默认位置（屏幕右下角）', actionButton('重置', () => api.resetPosition && api.resetPosition()))
    );

    const maintGroup = document.getElementById('group-maint');
    maintGroup.append(
      row('重新加载页面', '改完素材或排查问题时用', actionButton('执行', () => api.reloadPet && api.reloadPet())),
      dshRow(config),
      row('数据目录', '存档与配置（localStorage / config.json）', actionButton('打开', () => api.openDataDir && api.openDataDir())),
      row('运行日志', '主进程与页面的日志汇总', actionButton('打开', () => api.openLog && api.openLog()))
    );

    renderEnvGroup();
    renderCostGroup(config);
  }

  // ---------------------------------------------------------------- 4. 花费播报
  /**
   * 任务结束后她用一句台词报"这次花了多少 tokens、约多少钱"。
   *
   * 数据来源是 DSH 会话文件里每条 assistant/message 带的 usage，按 turn 累加；
   * 计费规则在 src/pricing.js（峰谷价、缓存命中/未命中分开计价）。
   * 阈值以下的零头不播报，避免每做一件小事都刷屏。
   */
  function renderCostGroup(config) {
    const group = document.getElementById('group-cost');

    function numberInput(value, step, onCommit, className) {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = className || 'text-input num-input';
      input.min = '0';
      input.step = step;
      input.value = String(value);
      input.addEventListener('change', () => {
        const parsed = Number(input.value);
        if (Number.isFinite(parsed) && parsed >= 0) onCommit(parsed);
        else input.value = String(value);
      });
      input.addEventListener('click', (event) => event.preventDefault());
      return input;
    }

    function numberRow(label, hint, value, step, onCommit) {
      return row(label, hint, numberInput(value, step, onCommit));
    }

    /*
     * 当前模型 + 它的价格：**只读**，跟着会话里实际用的模型自动刷新。
     *
     * 为什么不做成可编辑：价格是按模型从本地价目表（pricing.json）取的，
     * 手改只会让显示与实际计费不一致。想改价格就刷新价目表，或者用下面的手动配置区。
     */
    const modelRow = document.createElement('div');
    modelRow.className = 'row model-row';
    const modelText = document.createElement('div');
    modelText.className = 'text';
    const modelName = document.createElement('div');
    modelName.className = 'name';
    const modelHint = document.createElement('div');
    modelHint.className = 'hint';
    const modelPrices = document.createElement('div');
    modelPrices.className = 'price-line';
    modelText.append(modelName, modelHint, modelPrices);
    const modelBadge = document.createElement('span');
    modelBadge.className = 'badge';
    modelRow.append(modelText, modelBadge);

    let priceInfo = null;
    /** 上一次渲染的"签名"：内容变了才重新量一次窗口高度（见函数末尾）。 */
    let priceSignature = '';

    function renderPriceInfo(info) {
      priceInfo = info;
      modelName.textContent = `当前模型：${info.model || '未知'}`;
      if (info.table.ok === false) {
        modelBadge.textContent = '价目表缺失';
        modelBadge.setAttribute('data-tone', 'warn');
        modelHint.textContent = `读不到 pricing.json（${info.table.file || ''}），已改用手动配置`;
        modelPrices.textContent = '';
      } else if (info.inTable) {
        modelBadge.textContent = info.peak ? '高峰价' : '空闲价';
        modelBadge.setAttribute('data-tone', info.peak ? 'peak' : 'idle');
        modelHint.textContent = `${info.label}${info.matchedBy === 'alias' ? '（旧模型名，按此表计费）' : ''} · 价目表 ${info.table.updatedAt}`;
        const p = info.tablePrices;
        const money = (v) => (v === null || v === undefined ? '—' : String(v));
        modelPrices.textContent =
          `命中 ${money(p.cacheHit.idle)} / 未命中 ${money(p.cacheMiss.idle)} / 输出 ${money(p.output.idle)}` +
          `（空闲）· ${money(p.cacheHit.peak)} / ${money(p.cacheMiss.peak)} / ${money(p.output.peak)}（高峰）` +
          ` 元/百万 tokens`;
      } else {
        modelBadge.textContent = '手动配置';
        modelBadge.setAttribute('data-tone', 'warn');
        modelHint.textContent = '这个模型不在价目表里，正在用手动配置的数字计算';
        const m = info.rates;
        modelPrices.textContent =
          `实际采用：命中 ${m.cacheHitPerM} / 未命中 ${m.cacheMissPerM} / 输出 ${m.outputPerM} 元/百万 tokens` +
          (info.peak ? '（高峰，已 ×2）' : '');
      }

      /*
       * 这块文字是**异步**填进来的（价格要问主进程），比首次量窗口高度晚一步 ——
       * 填完之后这一屏会变高，不重新量就会平白多出一条滚动条。
       * 只在内容真的变了时才重量，别每 2 秒都去动窗口尺寸。
       */
      const signature = `${modelName.textContent}|${modelHint.textContent}|${modelPrices.textContent}|${modelBadge.textContent}`;
      if (signature !== priceSignature) {
        priceSignature = signature;
        reportHeight();
      }
    }

    async function refreshPriceInfo() {
      if (typeof api.priceInfo !== 'function') return;
      try {
        renderPriceInfo(await api.priceInfo());
      } catch (error) {
        /* 主进程没起来也不该让设置窗口崩 */
      }
    }

    /*
     * 三个手动单价挤在一行里。
     * 只在"当前模型不在价目表里"时参与计算 —— 表里有就按表算，这样官方调价后
     * 用户改过的数字不会悄悄把估算带偏。
     */
    function manualPriceRow() {
      const wrap = document.createElement('div');
      wrap.className = 'price-group';
      const specs = [
        ['命中', 'costPriceHit', 0.01],
        ['未命中', 'costPriceMiss', 0.1],
        ['输出', 'costPriceOutput', 0.1],
      ];
      for (const [label, key, step] of specs) {
        const cell = document.createElement('label');
        cell.className = 'mini';
        const caption = document.createElement('span');
        caption.textContent = label;
        cell.append(caption, numberInput(config[key], step, (v) => applyConfig({ [key]: v }), 'num-input mini-input'));
        wrap.append(cell);
      }
      return wrap;
    }

    const manualRow = row(
      '手动配置（元/百万）',
      '当前模型不在价目表中时用它计算；高峰时段 ×2',
      manualPriceRow()
    );

    const probe = document.createElement('span');
    probe.className = 'hint';
    const testButton = actionButton('测试播报', async () => {
      if (typeof api.say !== 'function') return;
      testButton.disabled = true;
      probe.textContent = '已发送…';
      try {
        const result = await api.say('');
        probe.textContent = result && result.ok ? `✓ 她说了：${result.text}` : '✗ 说话钩子不可用（看运行日志）';
      } catch (error) {
        probe.textContent = `✗ ${error.message}`;
      } finally {
        testButton.disabled = false;
      }
    });
    const testRow = document.createElement('div');
    testRow.className = 'row';
    const testText = document.createElement('div');
    testText.className = 'text';
    testText.append(Object.assign(document.createElement('div'), { className: 'name', textContent: '测试' }));
    testText.append(probe);
    testRow.append(testText, testButton);

    group.append(
      row(
        '播报本次花费',
        '每次任务结束时她说一句"这次任务花了多少 tokens、约多少钱"',
        toggle(config.costSay, (on) => applyConfig({ costSay: on }))
      ),
      numberRow('播报阈值（元）', '低于这个金额就不打扰，默认 0.01（一分钱）', config.costThreshold, 0.01, (v) =>
        applyConfig({ costThreshold: v })
      ),
      modelRow,
      manualRow,
      testRow
    );

    // 先拉一次，再定期刷新：中途换模型（会话里 request/header 变了）也能自动跟上
    refreshPriceInfo();
    window.setInterval(refreshPriceInfo, 2000);
  }

  // ---------------------------------------------------------------- 3. 天气与余额
  // 这两组直接写 localStorage（与桌宠页面同源），桌宠那边会经 storage 事件重读：
  // 天气城市/Key 由上游的天气 tick 检测到变化后重新拉取；余额开关与接口同理。
  function prefText(key, fallback) {
    try {
      const value = localStorage.getItem('whale-moe:' + key);
      return value === null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function prefWrite(key, value) {
    try {
      if (value) localStorage.setItem('whale-moe:' + key, value);
      else localStorage.removeItem('whale-moe:' + key);
    } catch (error) {
      /* 存储不可用就算了 */
    }
  }

  function prefFlag(key) {
    return prefText(key, '') === '1';
  }

  function textRow(label, hint, value, placeholder, onCommit) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    input.value = value;
    input.placeholder = placeholder || '';
    input.addEventListener('change', () => onCommit(input.value.trim()));
    input.addEventListener('click', (event) => event.preventDefault());
    return row(label, hint, input);
  }

  function renderEnvGroup() {
    const group = document.getElementById('group-env');

    // 「测试」按钮：直接打这个接口，把结果摊开给用户看 —— 省得靠猜
    const probe = document.createElement('span');
    probe.className = 'hint';
    probe.textContent = '';
    const testButton = actionButton('测试', async () => {
      const endpoint = (prefText('balanceEndpoint', '') || 'http://127.0.0.1:3020/balance').trim();
      testButton.disabled = true;
      probe.textContent = '请求中…';
      try {
        const res = await fetch(endpoint, { cache: 'no-store' });
        const data = await res.json();
        if (data && data.ok && Array.isArray(data.balances) && data.balances.length) {
          const first = data.balances[0];
          const amount = Number(first.totalBalance);
          const shown = Number.isFinite(amount) ? amount.toFixed(2) : String(first.totalBalance);
          probe.textContent = `✓ 可用：${first.currency} ${shown}（来源 ${data.source || '未知'}）`;
        } else {
          probe.textContent = `✗ 接口通了但数据不合契约：${JSON.stringify(data).slice(0, 120)}`;
        }
      } catch (error) {
        probe.textContent = `✗ 连不上：${error.message}`;
      } finally {
        testButton.disabled = false;
      }
    });
    const testRow = document.createElement('div');
    testRow.className = 'row';
    const testText = document.createElement('div');
    testText.className = 'text';
    testText.append(Object.assign(document.createElement('div'), { className: 'name', textContent: '测试余额接口' }));
    testText.append(probe);
    testRow.append(testText, testButton);

    group.append(
      textRow('天气城市', '留空则不查询天气（走 Open-Meteo，无需 Key）', prefText('weatherCity', ''), '例如 上海', (v) => prefWrite('weatherCity', v)),
      textRow('天气 API Key', '选填：仅当你的 Open-Meteo 需要 apikey 时填', prefText('weatherKey', ''), '留空即可', (v) => prefWrite('weatherKey', v)),
      row('显示余额', '开启后她才会去读余额', toggle(prefFlag('balance'), (on) => prefWrite('balance', on ? '1' : ''))),
      textRow(
        '余额接口',
        '留空 = 用内置代理（127.0.0.1:3020，自动读 DSH 里的 DeepSeek Key，随桌宠启停）',
        prefText('balanceEndpoint', ''),
        'http://127.0.0.1:3020/balance',
        (v) => prefWrite('balanceEndpoint', v)
      ),
      testRow
    );
  }

  // ---------------------------------------------------------------- 5. 窗口高度
  /**
   * 量出"内容自然高度"报给主进程，由它定窗口尺寸。
   *
   * 为什么不直接读 `document.body.scrollHeight`：它的**下限是可视高度**，
   * 窗口偏高时量到的就是窗口高度本身，于是永远缩不回去（第一版就踩了这个坑：
   * 量一次得到 581，设成 778 之后再量还是 778）。
   * 所以按"外层留白 + 标题 + **最高的一屏** + 底栏"逐项相加 —— 注意 CSS 里
   * .shell / .pane / .rail 都刻意没有纵向 margin，否则这里要跟着改。
   *
   * 取最高的一屏（而不是当前这一屏）是为了让窗口**高度固定**：
   * 切分类时窗口忽高忽低很晃眼。
   */
  function naturalHeight() {
    const previous = activeName;
    let tallest = 0;
    for (const panel of panels) {
      activate(panel.dataset.panel, false);
      tallest = Math.max(tallest, panel.offsetHeight);
    }
    activate(previous, false);

    const bodyStyle = getComputedStyle(document.body);
    const h1 = document.querySelector('h1');
    const h1Style = getComputedStyle(h1);
    const foot = document.querySelector('.foot');
    const footStyle = getComputedStyle(foot);
    return Math.ceil(
      (parseFloat(bodyStyle.paddingTop) || 0) +
        (parseFloat(bodyStyle.paddingBottom) || 0) +
        h1.offsetHeight +
        (parseFloat(h1Style.marginBottom) || 0) +
        tallest +
        (parseFloat(footStyle.marginTop) || 0) +
        foot.offsetHeight
    );
  }

  function reportHeight() {
    // 暴露给自检探针（主进程读不到渲染进程的布局，只能由页面把结果带出来）
    const needed = naturalHeight();
    document.body.dataset.naturalHeight = String(needed);
    if (typeof api.setContentHeight === 'function') {
      api.setContentHeight(needed);
    }
  }

  // 等各分组渲染完再量（renderShellConfig 内部 await 过一次 IPC）
  Promise.resolve(renderShellConfig()).then(reportHeight, reportHeight);

  // 版本信息
  if (typeof api.appInfo === 'function') {
    api.appInfo().then((info) => {
      if (info) {
        document.getElementById('version').textContent =
          `v${info.version} · Electron ${info.electron}`;
      }
    });
  }

  document.getElementById('close').addEventListener('click', () => window.close());
})();
