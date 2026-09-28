// Real cold start check for "open DSH": start a genuine `dsh web` through the same
// launcher the pet uses, in an isolated DSH_HOME on a free port, then stop it.
//
// Why it exists: the probe (npm run open-dsh:probe) uses stub processes, so it can
// prove the plumbing but not that a real `dsh web` actually boots this way. This one
// uses the real binary. The isolated home means a DSH session you are using right now
// is never touched.
//
// Usage: npm run cold:start            (default port 3094, home tmp/dsh-home-cold)
//        node scripts/cold-start-check.mjs 3094
//
// Exit code 0 = booted, answered, and we captured the token URL from its log.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveLaunchPlan,
  launchDshService,
  probeDshWeb,
  extractTokenUrl,
  readTextTail,
  pidAlive,
} from '../src/open-dsh.js';

const root = path.resolve(import.meta.dirname, '..');
const port = Number(process.argv[2] || 3094);
const url = `http://127.0.0.1:${port}`;
const home = path.join(root, 'tmp', 'dsh-home-cold');
const logDir = path.join(root, 'tmp');
fs.mkdirSync(home, { recursive: true });

if (await probeDshWeb(url)) {
  console.error(`port ${port} is already serving something - pick another one`);
  process.exit(2);
}

// Clean environment, like the pet gets when Windows starts it at logon.
const env = { ...process.env, DSH_HOME: home };
for (const key of Object.keys(env)) {
  if (['DSH_SHELL', 'DSH_SESSION_ID', 'DSH_WEB_URL'].includes(key.toUpperCase())) delete env[key];
}

const plan = resolveLaunchPlan({ url, root, logDir, env, platform: process.platform });
console.log('plan =', JSON.stringify({ kind: plan.kind, source: plan.source, file: plan.file, args: plan.args, logPath: plan.logPath }));
fs.writeFileSync(plan.logPath, '');
if (plan.errPath) fs.writeFileSync(plan.errPath, '');

const size = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
};
const readToken = () =>
  extractTokenUrl(readTextTail(plan.logPath)) || (plan.errPath ? extractTokenUrl(readTextTail(plan.errPath)) : null);

const t0 = Date.now();
const launched = await launchDshService({ plan, env, platform: process.platform });
console.log('launch =', JSON.stringify(launched.ok ? { pid: launched.pid, via: launched.via } : launched));
if (!launched.ok) process.exit(1);

let readyAt = null;
let tokenAt = null;
let token = null;
for (let i = 0; i < 120; i += 1) {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (!readyAt && (await probeDshWeb(url))) readyAt = elapsed;
  if (!token) {
    token = readToken();
    if (token) tokenAt = elapsed;
  }
  if (i % 6 === 0) {
    console.log(`  t=${elapsed}s stdout=${size(plan.logPath)} stderr=${plan.errPath ? size(plan.errPath) : '-'} ready=${readyAt ?? '-'} token=${tokenAt ?? '-'} alive=${pidAlive(launched.pid)}`);
  }
  if (token && readyAt) break;
  await new Promise((r) => setTimeout(r, 500));
}

console.log(`ready=${readyAt ?? 'never'}s  token=${tokenAt ?? 'never'}s`);
console.log('token url =', token);
console.log('stdout tail =', JSON.stringify(readTextTail(plan.logPath, 300)));
console.log('stderr tail =', JSON.stringify(plan.errPath ? readTextTail(plan.errPath, 300) : ''));

// Stop by PORT, not by the pid we launched: the launcher hands the process to the
// shell, so pid bookkeeping can drift, and a leftover server makes the *next* run
// see a false "already ready". Synchronous on purpose - a fire-and-forget child dies
// with this process before it gets to run.
if (readyAt || token) {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `foreach ($p in (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess) { taskkill /PID $p /T /F | Out-Null }`,
    ],
    { stdio: 'ignore', windowsHide: true }
  );
  console.log(`stopped whatever was listening on ${port}`);
}

process.exit(readyAt && token ? 0 : 1);
