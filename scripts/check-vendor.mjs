#!/usr/bin/env node
'use strict';

/** 校验 vendor/whale/ 是否完整；缺失时给出修复命令。 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'whale');

const REQUIRED = ['dsh-whale-moe.css', 'dsh-whale-moe.js', 'whale-moe-core.js', 'peek-calibration.json'];

let bad = false;
for (const name of REQUIRED) {
  const file = path.join(VENDOR, name);
  if (!fs.existsSync(file)) {
    console.error(`[vendor] 缺失: ${name}`);
    bad = true;
  }
}

const generated = path.join(VENDOR, 'generated');
const images = fs.existsSync(generated) ? fs.readdirSync(generated).filter((f) => f.endsWith('.webp')) : [];
if (images.length < 50) {
  console.error(`[vendor] 立绘数量异常: ${images.length}（预期 90+）`);
  bad = true;
}

if (bad) {
  console.error('\n修复: npm run sync:upstream           # 从上游 tag 下载');
  console.error('      npm run sync:upstream -- --from-local   # 从已装的 DSH 插件复制');
  process.exit(1);
}

const metaPath = path.join(ROOT, 'vendor', 'upstream.json');
let tag = '未知';
if (fs.existsSync(metaPath)) {
  tag = JSON.parse(fs.readFileSync(metaPath, 'utf8')).tag;
}
console.log(`[vendor] OK — ${REQUIRED.length} 个文件 + ${images.length} 张立绘（上游 ${tag}）`);
