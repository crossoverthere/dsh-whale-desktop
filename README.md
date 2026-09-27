# 鲸鱼娘桌宠 · dsh-whale-desktop

把 [dsh-whale-musume](https://github.com/Sutera-Diffusus/dsh-whale-musume) 的桌宠本体
从 DSH 网页里**解放出来**，做成 Windows 桌面上的独立挂件：

- **透明**：只有鲸鱼娘本身可见，没有窗口边框、没有底色
- **置顶**：浮在其它窗口之上
- **点击穿透**：指针不在她身上时，鼠标事件全部穿过，不挡你操作桌面
- **零改动复用上游**：立绘、动作、互动、养成、成就、小游戏、齿轮设置面板全部原样可用
- **DSH 工作状态联动**：思考中 / 工作中 / 完成 / 出错 会切换对应立绘与状态签，
  而且**按工具类型换姿势**（跑 shell → 摸鱼打电话，写文件 → 开会，搜索 → 灵光一现）
- **托盘常驻**：显示/隐藏、置顶、跟随 DSH 开关、开机自启、缩放、重置位置、退出

> 这不是 DSH 插件，而是一个独立的 Electron 应用。它不依赖 DSH 运行，
> 也不需要浏览器标签页。DSH 那边的插件可以照常装着，两者互不干扰。
> 工作状态联动是**只读** DSH 的会话文件（`~/.dsh/sessions/**`），不往 DSH 里装任何东西。

---

## 快速开始

```bash
npm install          # 若 Electron 二进制没下来，见下方"常见问题"
npm start            # 启动桌宠
npm run dev          # 带 DevTools
```

启动后：

| 操作 | 效果 |
| --- | --- |
| 左键点她 | 脸红 / 爱心 |
| 快速连点三次 | 星星眼庆祝 + 粒子特效 |
| 按住拖动 | 切换「被拎起来」立绘，松手后位置自动记住 |
| 右键她 | **只放和她互动的事**：投喂 / 戳一下 / 夸夸 / 两个小游戏 / 回到原位 |
| 齿轮 ⚙ | 页面内偏好面板（开关、大小、天气城市、养成数据等）；`×` / 点旁边 / `Esc` 都能关掉 |
| 托盘右键 | 显示桌宠 / **设置…** / 总是置顶 / 跟随 DSH 工作状态 / 开机自启 / 大小 / 重置到默认位置 / 重新加载页面 / 打开数据目录 / 打开日志 / 退出 |
| 托盘 →「设置…」 | 独立设置窗口，分 4 类：看板娘 · 窗口与状态 · 大小与位置 · 维护 |
| `Alt+Shift+W` | 显示 / 隐藏 |
| 托盘图标单击 | 显示 / 隐藏 |

> 分工原则：**和她互动的事**在桌宠右键菜单；**高频全局动作与快速开关**在托盘；
> **需要解释的配置项**集中在设置窗口。托盘与设置窗口共用同一份配置，
> 任何一处改动都会同步（所有 setter 末尾都会刷新托盘菜单）。

存档（养成数据、成就、位置、偏好）全部在浏览器 `localStorage` 里，
键名前缀 `whale-moe:`，存放于 Electron 的 userData 目录，**关掉应用不会丢**。

---

## 项目结构

```
dsh-whale-desktop/
├─ src/
│  ├─ main.js              主进程：窗口/托盘/IPC/自检截图
│  ├─ preload.js           contextBridge 通道（页面拿不到 node）
│  ├─ server.js            本地静态服务器：/assets/* → vendor/whale/*
│  └─ pet/
│     ├─ index.html        只负责按顺序引入上游三个文件
│     ├─ shell.css         透明画布 + 选中/滚动等宿主适配
│     └─ shell.js          点击穿透判定 + 日志回传
├─ vendor/whale/           上游桌宠素材（MIT，见 THIRD-PARTY.md）
├─ scripts/
│  ├─ sync-upstream.mjs    从上游 tag 同步素材
│  └─ check-vendor.mjs     素材完整性校验
└─ docs/DEVELOPMENT.md     架构细节与调试方法
```

上游素材**一个字都没改**——这是刻意的，见 `docs/DEVELOPMENT.md` 里"为什么不需要改上游"。

---

## 常见问题

**`npm install` 之后启动报找不到 Electron**
npm 11+ 默认拦截依赖的生命周期脚本，Electron 的二进制就下不来。手动补一次：

```bash
node node_modules/electron/install.js
```

**鲸鱼娘没出现 / 位置跑到屏幕外**
托盘右键 →「重置到默认位置」。

**天气不显示**
设置面板里城市留空时完全不联网；填了城市会请求 `api.open-meteo.com`。

**余额那里报错**
那是 DSH 的本地余额代理（`127.0.0.1:3020`）。独立运行时它不存在，
桌宠会静默失败，不影响其它功能。

**`git push` 报 `Recv failure: Connection was reset`**
这台机器上 GitHub 的 API 与 codeload 都直连正常，但 git 的 **push 端点**
（`git-receive-pack`）会被重置。用仓库自带的推送助手：

```bash
pwsh -File scripts/push.ps1        # 检测到本机 Clash 代理就自动走代理
```

它只对本次命令生效，不写进 git 全局配置。也可以手动：

```bash
git -c http.proxy=http://127.0.0.1:7890 push origin main
```

---

## 路线图

- [ ] 与 DSH 的"工作状态联动"（跑工具时切「抱笔记本工作」）：上游靠观察 DSH 页面 DOM 判断，
      独立宿主需要另接信号源（DSH 事件流 / 本地钩子）
- [ ] 多显示器支持（当前铺满主显示器工作区）
- [ ] `electron-builder` 打包成免安装 exe
- [ ] 全局快捷键自定义
- [ ] 单实例之外的"每屏一只"

---

## 许可

- 本项目代码：MIT
- 上游桌宠素材：MIT，版权归 Sutera-Diffusus 及其贡献者，详见 `THIRD-PARTY.md` 与 `vendor/whale/LICENSE`
