#!/usr/bin/env node
'use strict';

/**
 * 从上游 dsh-whale-musume 同步桌宠素材到 vendor/whale/。
 *
 * 为什么不用 git：本机（以及很多只想改桌宠的人）不一定装 git。
 * GitHub 的 codeload 压缩包走 HTTPS 即可拿到指定 tag 的完整源码，
 * 这里用 Node 自带的 zlib 解 tar.gz，零第三方依赖。
 *
 * 用法：
 *   node scripts/sync-upstream.mjs                 # 取最新 release tag
 *   node scripts/sync-upstream.mjs v2.1.0          # 指定 tag
 *   node scripts/sync-upstream.mjs --from-local    # 从已安装的 DSH 插件目录复制（离线）
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const https = require('node:https');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'whale');
const META = path.join(ROOT, 'vendor', 'upstream.json');
const UPSTREAM = 'Sutera-Diffusus/dsh-whale-musume';

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'user-agent': 'dsh-whale-desktop-sync' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume();
          resolve(request(res.headers.location, redirects + 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

function readString(buffer, offset, length) {
  return buffer
    .subarray(offset, offset + length)
    .toString('utf8')
    .replace(/\0.*$/, '')
    .trim();
}

/** 极简 tar 解包：只取常规文件，跳过 pax/目录/链接。 */
function extractTarGz(gzipped, destDir, stripComponents) {
  const tar = zlib.gunzipSync(gzipped);
  let offset = 0;
  let written = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const name = readString(header, 0, 100);
    if (!name) break; // 全零块表示归档结束
    const size = parseInt(readString(header, 124, 12), 8) || 0;
    const type = String.fromCharCode(header[156]);
    const prefix = readString(header, 345, 155);
    const full = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + 512;
    const rel = full.split('/').slice(stripComponents).join('/');

    if ((type === '0' || type === '\0' || type === '') && rel) {
      const out = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, tar.subarray(dataStart, dataStart + size));
      written++;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return written;
}

/**
 * 读现有的 vendor/upstream.json（不存在或坏了都当空对象）。
 *
 * 存在的意义是"保住同步脚本重建不出来的字段"：`method`（首次 vendor 的来源与方式）、
 * `packageVersion`。它们只有人知道，脚本一覆盖就没了。
 */
function readMeta() {
  try {
    const parsed = JSON.parse(fs.readFileSync(META, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 写 vendor/upstream.json —— **合并**，不是覆盖。
 *
 * 早先这里直接写 `{upstream, tag, syncedAt}`，跑一次同步就把首次 vendor 留下的
 * `method` / `packageVersion` 抹掉了：不影响运行，但把"素材怎么来的"这段溯源证据丢了。
 * 那两项脚本没有能力重建（它不知道历史），所以只能继承。
 */
function writeMeta(patch) {
  const meta = readMeta();
  fs.mkdirSync(path.dirname(META), { recursive: true });
  fs.writeFileSync(
    META,
    `${JSON.stringify(
      {
        ...meta,
        upstream: UPSTREAM,
        ...patch,
        syncedAt: new Date().toISOString(),
        note: meta.note || '后续请用 npm run sync:upstream 更新，不要再手工复制',
      },
      null,
      2
    )}\n`
  );
}

async function resolveTag(explicit) {
  if (explicit) return explicit;
  const body = await request(`https://api.github.com/repos/${UPSTREAM}/releases/latest`);
  const json = JSON.parse(body.toString('utf8'));
  return json.tag_name;
}

async function main() {
  const args = process.argv.slice(2);
  const fromLocal = args.includes('--from-local');

  if (fromLocal) {
    const local = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-whale-musume', 'assets');
    if (!fs.existsSync(local)) {
      console.error(`[sync] 本地找不到已安装的插件素材：${local}`);
      process.exit(1);
    }
    fs.rmSync(VENDOR, { recursive: true, force: true });
    fs.mkdirSync(VENDOR, { recursive: true });
    fs.cpSync(local, VENDOR, { recursive: true });
    // 来源写在 patch 里而不是覆盖 method：历史那条"首次 vendor"的记录要留着
    writeMeta({ tag: readMeta().tag || 'unknown', source: 'from-local' });
    console.log(`[sync] 已从本地插件目录同步 -> ${VENDOR}`);
    return;
  }

  const tag = await resolveTag(args.find((a) => !a.startsWith('--')));
  console.log(`[sync] 上游 ${UPSTREAM} @ ${tag}`);
  const url = `https://codeload.github.com/${UPSTREAM}/tar.gz/refs/tags/${tag}`;
  const gz = await request(url);
  console.log(`[sync] 下载 ${(gz.length / 1024 / 1024).toFixed(1)} MB`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-sync-'));
  try {
    extractTarGz(gz, tmp, 1);
    const src = path.join(tmp, 'assets');
    if (!fs.existsSync(src)) throw new Error('压缩包里没有 assets/ 目录');
    fs.rmSync(VENDOR, { recursive: true, force: true });
    fs.mkdirSync(VENDOR, { recursive: true });
    fs.cpSync(src, VENDOR, { recursive: true });
    const license = path.join(tmp, 'LICENSE');
    if (fs.existsSync(license)) fs.copyFileSync(license, path.join(VENDOR, 'LICENSE'));

    fs.mkdirSync(path.dirname(META), { recursive: true });
    writeMeta({ tag, source: 'codeload' });
    console.log(`[sync] 完成 -> ${VENDOR}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[sync] 失败:', error.message);
  process.exit(1);
});
