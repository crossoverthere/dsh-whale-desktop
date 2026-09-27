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
      row('数据目录', '存档与配置（localStorage / config.json）', actionButton('打开', () => api.openDataDir && api.openDataDir())),
      row('运行日志', '主进程与页面的日志汇总', actionButton('打开', () => api.openLog && api.openLog()))
    );

    renderEnvGroup();
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
    group.append(
      textRow('天气城市', '留空则不查询天气（走 Open-Meteo，无需 Key）', prefText('weatherCity', ''), '例如 上海', (v) => prefWrite('weatherCity', v)),
      textRow('天气 API Key', '选填：仅当你的 Open-Meteo 需要 apikey 时填', prefText('weatherKey', ''), '留空即可', (v) => prefWrite('weatherKey', v)),
      row('显示余额', '开启后她才会去读余额', toggle(prefFlag('balance'), (on) => prefWrite('balance', on ? '1' : ''))),
      textRow(
        '余额接口',
        '默认走本机余额代理；桌面版可改成你自己的接口',
        prefText('balanceEndpoint', ''),
        'http://127.0.0.1:3020/balance',
        (v) => prefWrite('balanceEndpoint', v)
      )
    );
  }

  renderShellConfig();

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
