'use strict';

/**
 * 养成 / 图鉴窗口。
 *
 * 这个窗口**自己读 localStorage**（与桌宠页面同源），并且直接复用上游的纯状态机
 * `/assets/whale-moe-core.js` —— 成就表（39 条）、称号表、等级规则、任务池全在里面，
 * 所以这里只负责把它们渲染出来，不重写任何养成算法。
 *
 * 两个动作需要回到桌宠页面才能做（因为逻辑与副作用都在那边）：
 *   · 领取任务 → 走 IPC，主进程在桌宠页面里调 window.__dshWhaleMoeClaimQuest(id)
 *   · 佩戴称号 → 同理调 window.__dshWhaleMoeApplyBadge(id)
 * 做完后本窗口重新读 localStorage 刷新。
 */
(function () {
  'use strict';

  const api = window.whaleGrowth || {};
  const core = window.DshWhaleMoeCore;
  const PREFIX = 'whale-moe:';
  const TAB_ORDER = ['quests', 'signin', 'badges', 'journal', 'achievements'];

  const $ = (id) => document.getElementById(id);
  const panel = $('panel');

  // ---------------------------------------------------------------- 读状态
  function ls(key, fallback) {
    try {
      const value = localStorage.getItem(PREFIX + key);
      return value === null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function lsJson(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed === null ? fallback : parsed;
    } catch (error) {
      return fallback;
    }
  }

  function readState() {
    return {
      mood: Number(ls('mood', 70)) || 70,
      affinity: Number(ls('affinity', 0)) || 0,
      satiety: Number(ls('satiety', 80)) || 80,
      level: Number(ls('level', 1)) || 1,
      signinStreak: Number(ls('signinStreak', 0)) || 0,
      lastSignin: ls('lastSignin', ''),
      companionSince: Number(ls('companionSince', 0)) || 0,
      achievements: (ls('achievements', '') || '').split(',').filter(Boolean),
      badge: ls('badge', ''),
      quests: lsJson('quests', null),
      weekSignin: lsJson('weekSignin', null),
      journal: lsJson('journal', []),
    };
  }

  // ---------------------------------------------------------------- 小工具
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function card(iconText, nameText, descText, right) {
    const wrap = el('div', 'card');
    wrap.append(el('div', 'icon', iconText));
    const grow = el('div', 'grow');
    grow.append(el('div', 'name', nameText));
    if (descText) grow.append(el('div', 'desc', descText));
    wrap.append(grow);
    if (right) wrap.append(right);
    return wrap;
  }

  function progressBar(value, max) {
    const bar = el('div', 'bar');
    const fill = el('i');
    const ratio = max > 0 ? Math.min(1, value / max) : 0;
    fill.style.width = `${Math.round(ratio * 100)}%`;
    bar.append(fill);
    return bar;
  }

  function dayKeyOf(date) {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }

  function weekDates(now) {
    const base = new Date(now);
    const sinceMonday = (base.getDay() + 6) % 7;
    const monday = new Date(base.getFullYear(), base.getMonth(), base.getDate() - sinceMonday);
    const out = [];
    for (let i = 0; i < 7; i += 1) {
      const day = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
      out.push({ date: day, key: dayKeyOf(day) });
    }
    return out;
  }

  const DOW = ['一', '二', '三', '四', '五', '六', '日'];

  function formatTime(at) {
    const d = new Date(at);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  }

  // ---------------------------------------------------------------- 各标签页
  function renderQuests(state) {
    const quests = core.refreshQuests(state.quests, Date.now());
    const pool = new Map(core.QUEST_POOL.map((q) => [q.id, q]));
    panel.replaceChildren();

    for (const slot of quests.slots || []) {
      const def = pool.get(slot.id) || { desc: slot.id, target: 1, reward: {} };
      const target = def.target || 1;
      const done = slot.progress >= target;
      const grow = el('div', 'grow');
      grow.append(el('div', 'name', def.desc));
      const reward = [];
      if (def.reward && def.reward.affinity) reward.push(`好感 +${def.reward.affinity}`);
      if (def.reward && def.reward.mood) reward.push(`心情 +${def.reward.mood}`);
      grow.append(el('div', 'desc', `${slot.progress}/${target}${reward.length ? ' · ' + reward.join(' · ') : ''}`));
      grow.append(progressBar(slot.progress, target));

      let right;
      if (slot.claimed) {
        right = el('span', 'pill done', '已领取');
      } else if (done) {
        right = el('button', 'action', '领取');
        right.type = 'button';
        right.addEventListener('click', async () => {
          right.disabled = true;
          right.textContent = '…';
          const result = await api.claimQuest(slot.id);
          if (!result || !result.ok) {
            right.disabled = false;
            right.textContent = '领取';
          }
          render();
        });
      } else {
        right = el('span', 'pill', '进行中');
      }

      const wrap = el('div', 'card');
      wrap.append(el('div', 'icon', done ? '🎯' : '⏳'), grow, right);
      panel.append(wrap);
    }
  }

  function renderSignin(state) {
    const current = core.computeWeekSignin(state.weekSignin, null, Date.now()).weekSignin || { days: [] };
    const days = Array.isArray(current.days) ? current.days : [];
    const todayKey = dayKeyOf(new Date());
    panel.replaceChildren();

    const week = el('div', 'week');
    for (let i = 0; i < 7; i += 1) {
      const info = weekDates(Date.now())[i];
      const signed = days.includes(info.key);
      const cell = el('div', `day${signed ? ' signed' : ''}${info.key === todayKey ? ' today' : ''}`);
      cell.append(el('div', 'dow', DOW[i]));
      cell.append(el('div', 'mark', signed ? '✓' : '·'));
      week.append(cell);
    }
    panel.append(week);

    const milestones = el('div', 'milestones');
    for (const [label, hit] of [['签到 1 天', current.rewarded1], ['签到 3 天', current.rewarded3], ['全勤 7 天', current.rewarded7]]) {
      milestones.append(el('span', `pill${hit ? ' done' : ''}`, `${hit ? '✓ ' : ''}${label}`));
    }
    panel.append(milestones);

    panel.append(
      card('🔥', `连续签到 ${state.signinStreak} 天`, state.lastSignin ? `上次签到：${state.lastSignin}` : '本周还没有签到记录', null)
    );
    if (!days.length) {
      panel.append(el('div', 'empty', '本周还没有签到。和她互动一次就会自动签到。'));
    }
  }

  function renderBadges(state) {
    panel.replaceChildren();
    const unlocks = core.bondUnlocks(state.level);
    const equipped = core.BOND.badges.find((b) => b.id === state.badge);

    panel.append(
      card('⭐', `当前等级 Lv.${state.level}`, equipped ? `佩戴中：${equipped.name}` : '还没有佩戴称号', null)
    );

    for (const badge of core.BOND.badges) {
      const unlocked = state.level >= badge.minLevel;
      if (!unlocked) {
        // 未解锁：灰显 + 隐藏名称（只露解锁条件，不剧透叫什么）
        const wrap = el('div', 'card locked');
        wrap.append(el('div', 'icon', '🔒'));
        const grow = el('div', 'grow');
        grow.append(el('div', 'name', '未解锁的称号'));
        grow.append(el('div', 'desc', `达到 Lv.${badge.minLevel} 解锁`));
        wrap.append(grow, el('span', 'pill', `Lv.${badge.minLevel}`));
        panel.append(wrap);
        continue;
      }
      const right = el('button', 'action', state.badge === badge.id ? '已佩戴' : '佩戴');
      right.type = 'button';
      right.disabled = state.badge === badge.id;
      right.addEventListener('click', async () => {
        right.disabled = true;
        await api.equipBadge(state.badge === badge.id ? '' : badge.id);
        render();
      });
      panel.append(card('🏅', badge.name, `Lv.${badge.minLevel} 解锁`, right));
    }

    panel.append(
      card(
        '🎁',
        '成长解锁',
        `Lv.${core.BOND.lv3Action} 新的互动动作 · Lv.${core.BOND.lv5Badge} 称号 · Lv.${core.BOND.lv7Egg} 隐藏彩蛋`,
        null
      )
    );
    if (!unlocks.badge) {
      panel.append(el('div', 'empty', `再升 ${Math.max(0, core.BOND.lv5Badge - state.level)} 级就能解锁称号。`));
    }
    panel.append(
      card('😊', '心情 / 好感 / 饱食', `心情 ${Math.round(state.mood)} · 好感 ${Math.round(state.affinity)} · 饱食 ${Math.round(state.satiety)}`, null)
    );
  }

  function renderJournal(state) {
    panel.replaceChildren();
    const list = Array.isArray(state.journal) ? state.journal.slice().reverse() : [];
    if (!list.length) {
      panel.append(el('div', 'empty', '成长日记还是空的。和她互动、跑 DSH 任务，都会记在这里。'));
      return;
    }
    for (const entry of list) {
      const row = el('div', 'journal-item');
      row.append(el('time', null, formatTime(entry.at || Date.now())));
      row.append(el('div', null, entry.text || ''));
      panel.append(row);
    }
  }

  function renderAchievements(state) {
    panel.replaceChildren();
    const have = new Set(state.achievements);
    const unlocked = core.ACHIEVEMENTS.filter((a) => have.has(a.id)).length;

    panel.append(el('div', 'empty', `已解锁 ${unlocked} / ${core.ACHIEVEMENTS.length}`));

    // 已解锁的排前面：否则要在三十多个灰条目里翻找自己拿到的那几个
    const ordered = core.ACHIEVEMENTS.slice().sort((a, b) => Number(have.has(b.id)) - Number(have.has(a.id)));

    for (const item of ordered) {
      const got = have.has(item.id);
      if (got) {
        panel.append(card(item.icon, item.name, item.desc, el('span', 'pill done', '已解锁')));
      } else {
        // 未解锁：灰显 + 隐藏名称与描述
        const wrap = el('div', 'card locked');
        wrap.append(el('div', 'icon', '🔒'));
        const grow = el('div', 'grow');
        grow.append(el('div', 'name', '未解锁的成就'));
        wrap.append(grow, el('span', 'pill', '?'));
        panel.append(wrap);
      }
    }
  }

  // ---------------------------------------------------------------- 框架
  const RENDERERS = {
    quests: renderQuests,
    signin: renderSignin,
    badges: renderBadges,
    journal: renderJournal,
    achievements: renderAchievements,
  };

  let currentTab = 'quests';

  function setTab(tab) {
    currentTab = TAB_ORDER.includes(tab) ? tab : 'quests';
    for (const button of document.querySelectorAll('#tabs button')) {
      button.setAttribute('aria-selected', String(button.dataset.tab === currentTab));
    }
    render();
  }

  function render() {
    const state = readState();
    const badge = core.BOND.badges.find((b) => b.id === state.badge);
    $('summary').textContent =
      `Lv.${state.level} · 成就 ${state.achievements.length}/${core.ACHIEVEMENTS.length}` +
      (badge ? ` · ${badge.name}` : '');
    RENDERERS[currentTab](state);
  }

  for (const button of document.querySelectorAll('#tabs button')) {
    button.addEventListener('click', () => setTab(button.dataset.tab));
  }

  // 从 URL 指定初始标签页（托盘「称号」「成就」就是靠这个直达）
  const fromUrl = new URLSearchParams(location.search).get('tab');
  setTab(fromUrl || 'quests');

  // 窗口已被复用、主进程让切标签时
  if (typeof api.onTab === 'function') {
    api.onTab((tab) => setTab(tab));
  }

  // 桌宠页面改了数据（领取任务、日常签到）→ 本窗口跟着刷新
  window.addEventListener('storage', (event) => {
    if ((event.key || '').startsWith(PREFIX)) {
      render();
    }
  });

  $('close').addEventListener('click', () => window.close());
})();
