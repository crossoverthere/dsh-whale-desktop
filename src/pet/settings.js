'use strict';

/**
 * 独立设置窗口。
 *
 * 关键点：这个窗口和桌宠页面**同源**（都由 http://127.0.0.1:<port> 提供），
 * 所以两边共用同一份 localStorage —— 这里写 `whale-moe:*`，
 * 桌宠页面会收到 `storage` 事件，再派发上游认识的 `whale-moe-prefs-change`
 * 让它重新 reconcile。**不需要任何 IPC 通道来同步偏好。**
 *
 * 偏好键与语义完全对齐上游（`readPref`: 非 "0" 即开）：
 *   whale-moe:pet / whale-moe:chat / whale-moe:particles
 */
(function () {
  'use strict';

  const PREFS = [
    { key: 'pet', label: '看板娘', hint: '关掉后她离开桌面；本窗口仍可把她打开' },
    { key: 'chat', label: '台词气泡', hint: '互动时冒出的台词气泡' },
    { key: 'particles', label: '粒子效果', hint: '爱心、星星等粒子特效' },
  ];

  function read(key) {
    try {
      return localStorage.getItem('whale-moe:' + key) !== '0';
    } catch (error) {
      return true;
    }
  }

  function write(key, on) {
    try {
      localStorage.setItem('whale-moe:' + key, on ? '1' : '0');
    } catch (error) {
      /* 存储不可用时静默，别把窗口弄崩 */
    }
  }

  const list = document.getElementById('list');
  const inputs = new Map();

  for (const pref of PREFS) {
    const row = document.createElement('label');
    row.className = 'row';

    const text = document.createElement('div');
    text.className = 'text';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = pref.label;
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = pref.hint;
    text.append(name, hint);

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = read(pref.key);
    input.addEventListener('change', () => write(pref.key, input.checked));

    row.append(text, input);
    list.append(row);
    inputs.set(pref.key, input);
  }

  // 齿轮面板（页面内那个）改过之后，把窗口里的勾选状态同步回来
  window.addEventListener('storage', (event) => {
    const key = event.key || '';
    if (!key.startsWith('whale-moe:')) {
      return;
    }
    const input = inputs.get(key.slice('whale-moe:'.length));
    if (input) {
      input.checked = read(key.slice('whale-moe:'.length));
    }
  });

  document.getElementById('close').addEventListener('click', () => window.close());
})();
