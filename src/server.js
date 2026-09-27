'use strict';

/**
 * 极简本地静态服务器。
 *
 * 为什么需要它：桌宠本体里的资源路径是写死的绝对路径
 *   ASSET_ROOT = "/assets/generated/"   ANIM_ROOT = "/assets/anim/"
 *   fetch("/assets/peek-calibration.json")
 * 上游 DSH 插件是靠「取到脚本文本 → 字符串替换路径 → 注入页面」来搬家的。
 * 我们不做替换，而是**把 /assets/* 原样映射到 vendor/whale/**，
 * 于是脚本一个字都不用改，上游升级后直接覆盖 vendor 即可。
 *
 * 走 http://127.0.0.1:<port> 而不是 file:// 还有一个原因：
 * 桌宠的养成数据存在 localStorage，file:// 是不透明源、localStorage 不可靠，
 * 而固定的 http 源可以让存档长期稳定。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** 解析并确保目标仍在 root 之内，防目录穿越。 */
function safeJoin(root, rel) {
  const target = path.normalize(path.join(root, rel));
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

function sendFile(res, file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    // 本地挂件，缓存激进一点无所谓；改了文件重启即可
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

/**
 * @param {{ petDir: string, vendorDir: string, port: number, stateProvider?: () => unknown }} opts
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
function startPetServer({ petDir, vendorDir, port, stateProvider }) {
  const server = http.createServer((req, res) => {
    // 自检端点：把"当前是否接管鼠标 / 桌宠矩形"暴露给外部脚本，
    // 这样点击穿透逻辑可以被自动化验证，而不是只能靠肉眼。
    if (stateProvider && req.url.startsWith('/__shell/state')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(stateProvider()));
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      return sendFile(res, path.join(petDir, 'index.html'));
    }

    // 桌宠本体：/assets/* → vendor/whale/*
    if (pathname.startsWith('/assets/')) {
      return sendFile(res, safeJoin(vendorDir, pathname.slice('/assets/'.length)));
    }

    // 壳自己的页面资源：/pet/*
    if (pathname.startsWith('/pet/')) {
      return sendFile(res, safeJoin(petDir, pathname.slice('/pet/'.length)));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    const tryListen = (p, attempt = 0) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < 20) {
          // 端口被占就顺延；端口一变 localStorage 的源就变了，
          // 所以默认端口固定是重要的，这里只是兜底。
          tryListen(p + 1, attempt + 1);
        } else {
          reject(err);
        }
      });
      server.listen(p, '127.0.0.1', () => {
        const actual = server.address().port;
        resolve({
          url: `http://127.0.0.1:${actual}`,
          port: actual,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    };
    tryListen(port);
  });
}

module.exports = { startPetServer };
