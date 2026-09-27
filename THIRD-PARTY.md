# 第三方素材与致谢

## dsh-whale-musume（鲸鱼娘看板娘）

- 仓库：https://github.com/Sutera-Diffusus/dsh-whale-musume
- 作者：Sutera-Diffusus 及其贡献者
- 许可：MIT
- 本项目使用的部分：`vendor/whale/` —— 即上游的 `assets/` 目录（桌宠表现层
  `dsh-whale-moe.js`、纯函数状态机 `whale-moe-core.js`、样式 `dsh-whale-moe.css`、
  校准表 `peek-calibration.json`、以及 `generated/` 下 90+ 张立绘），外加上游 LICENSE 原文。
- 上游版权声明见 `vendor/whale/LICENSE`。

上游是 DSH（DeepSeek Harness）的一个插件，形态是"网页内的看板娘"。
本项目**只复用它的桌宠本体素材**，另外写了一个 Electron 宿主，
让它脱离浏览器、成为可以浮在桌面上的独立挂件。

上游的 MIT 许可允许复制、修改、再分发，条件是保留版权声明与许可原文——
这就是 `vendor/whale/LICENSE` 存在的原因。**修改上游素材时请保留该文件。**

## 同步上游

```bash
npm run sync:upstream              # 取上游最新 release tag
npm run sync:upstream -- v2.1.0    # 指定 tag
npm run check:vendor               # 校验素材完整性
```

同步记录写在 `vendor/upstream.json`（上游仓库、tag、同步时间）。

## Electron

- 许可：MIT
- 用途：桌面窗口宿主（透明置顶、点击穿透、托盘）。
