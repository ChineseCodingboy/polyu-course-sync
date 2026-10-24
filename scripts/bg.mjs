#!/usr/bin/env node
/**
 * 跑很久的步骤放到后台，分段等待：登录最多等 20 分钟，抓取要 20–30 分钟。
 * 不依赖某个 AI 工具自己的后台功能，Codex 和 Claude Code 都这样用。
 *
 *   node bg.mjs start fetch [参数…]          在后台启动，立刻返回
 *   node bg.mjs start login --timeout=20
 *   node bg.mjs wait fetch [--max=240]       最多等 --max 秒（默认 240）：
 *       已结束 → 打印结果，退出码 = 那一步自己的退出码（0 / 1 / 2 / 3）
 *       还在跑 → 打印进度，退出码 100（过一会儿再运行一次 wait）
 *   node bg.mjs status fetch                 不等，看一眼（等于 wait --max=0）
 *
 * 可以放到后台的步骤：login、fetch、convert。
 * 日志在 <WORK>/data/logs/<步骤>.log，状态在 <WORK>/data/logs/<步骤>.job.json。
 */
import { spawn, spawnSync } from 'node:child_process';
import { openSync, readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORK } from './lib/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGS = join(WORK, 'data', 'logs');
const STEPS = new Set(['login', 'fetch', 'convert']);
const RUNNING = 100;

const [cmd, step, ...rest] = process.argv.slice(2);
if (!['start', 'wait', 'status', '__run'].includes(cmd) || !STEPS.has(step)) {
  console.error('用法：node bg.mjs start|wait|status login|fetch|convert [参数…]');
  process.exit(64);
}
const logPath = join(LOGS, `${step}.log`);
const jobPath = join(LOGS, `${step}.job.json`);
const readJob = () => { try { return JSON.parse(readFileSync(jobPath, 'utf8')); } catch { return null; } };
const writeJob = (j) => writeFileSync(jobPath, JSON.stringify(j, null, 2));
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const mins = (ms) => `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`;

/* ── 后台进程本体：跑那一步，结束时记下退出码 ── */
if (cmd === '__run') {
  const r = spawnSync(process.execPath, [join(HERE, `${step}.mjs`), ...rest], { stdio: ['ignore', 'inherit', 'inherit'], cwd: WORK, env: process.env });
  const code = typeof r.status === 'number' ? r.status : 1;
  appendFileSync(logPath, `\n=== 结束：exit=${code}${r.signal ? `（信号 ${r.signal}）` : ''}\n`);
  writeJob({ ...(readJob() || {}), exitCode: code, endedAt: new Date().toISOString() });
  process.exit(code);
}

/* ── start ── */
if (cmd === 'start') {
  mkdirSync(LOGS, { recursive: true });
  const prev = readJob();
  if (prev && prev.exitCode == null && alive(prev.pid)) {
    console.log(`${step} 已经在后台运行（开始于 ${prev.startedAt}）。用 node bg.mjs wait ${step} 等结果。`);
    process.exit(0);
  }
  const fd = openSync(logPath, 'w');
  writeJob({ step, args: rest, startedAt: new Date().toISOString(), log: logPath, pid: null, exitCode: null });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__run', step, ...rest], {
    detached: true, stdio: ['ignore', fd, fd], cwd: WORK, env: process.env, windowsHide: true,
  });
  child.unref();
  closeSync(fd);
  writeJob({ ...readJob(), pid: child.pid });
  console.log(`✓ 已在后台启动 ${step}${rest.length ? ` ${rest.join(' ')}` : ''}`);
  console.log(`   日志：${logPath}`);
  console.log(`   接着运行：node bg.mjs wait ${step}（每次最多等 4 分钟；还没完就再运行一次）`);
  process.exit(0);
}

/* ── wait / status ── */
const maxArg = (rest.find((a) => a.startsWith('--max=')) || '').split('=')[1];
const max = cmd === 'status' ? 0 : Math.max(0, Number(maxArg ?? 240));
const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');
const lines = () => log().split('\n').filter((l) => l.trim());

let job = readJob();
if (!job) { console.error(`还没有启动过 ${step}：先运行 node bg.mjs start ${step}`); process.exit(65); }
while (job.exitCode == null && alive(job.pid) && Date.now() - t0 < max * 1000) {
  await sleep(5000);
  job = readJob() || job;
}

if (job.exitCode != null) {
  // 结束了：下载明细（每个文件一行 ↓）不打，只看结果
  const out = lines().filter((l) => !/^\s+↓ /.test(l));
  console.log(out.slice(step === 'fetch' ? -60 : -25).join('\n'));
  console.log(`\n${step} 已结束，用时 ${mins(new Date(job.endedAt) - new Date(job.startedAt))}，exit=${job.exitCode}`);
  process.exit(job.exitCode);
}
if (!alive(job.pid)) {
  console.log(lines().slice(-15).join('\n'));
  console.log(`\n✗ ${step} 意外中断了（后台进程已经不在，没有留下退出码；可能是电脑睡眠或被强制结束）。重新 start 即可，已下载的文件不会重复下载。`);
  process.exit(1);
}
// 还在跑：给进度
const all = lines();
const heads = all.filter((l) => /^(══|→)/.test(l));
const got = all.filter((l) => /^\s+↓ /.test(l)).length;
const last = all.filter((l) => !/^\s+↓ /.test(l)).slice(-3);
console.log(`${step} 还在运行，已用 ${mins(Date.now() - new Date(job.startedAt))}${step === 'fetch' ? `，本轮已下载 ${got} 个文件` : ''}`);
if (heads.length) console.log(`当前进度：${heads[heads.length - 1]}（已到第 ${heads.filter((l) => l.startsWith('══')).length} 门课）`);
if (last.length) console.log(last.join('\n'));
console.log(`→ 过一会儿再运行 node bg.mjs wait ${step}`);
process.exit(RUNNING);
