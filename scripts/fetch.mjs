#!/usr/bin/env node
/**
 * 抓两个平台 → data/raw/<CODE>/{canvas,blackboard}.json + data/files/<CODE>/… + data/manifest.json
 *
 *   node fetch.mjs                 # 两个平台
 *   node fetch.mjs --only=canvas
 *
 * 退出码：0 全部成功；2 有平台未登录（已登录的平台照常抓）；1 其他错误
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { openContext, saveCookies, checkAuth, writeStatus, readStatus, readJson, writeJson, DATA } from './lib/session.mjs';
import { loadManifest, saveManifest, newStats } from './lib/files.mjs';
import { listCourses, ensureCourse } from './lib/courses.mjs';
import { fetchCanvas } from './lib/canvas.mjs';
import { fetchBlackboard } from './lib/blackboard.mjs';

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;
const startedAt = new Date().toISOString();

const ctx = await openContext();
const auth = await checkAuth(ctx);
writeStatus({ auth: { ...readStatus().auth, ...auth } });

const m = loadManifest();
const courses = listCourses();
const known = new Set(courses.map((c) => c.code));
const newCourses = [];
const onNewCourse = (info) => {
  const { created } = ensureCourse(info);
  known.add(info.code);
  if (created) { newCourses.push(info.code); console.log(`   ✚ 新课程 ${info.code}，已建空壳 data/courses/${info.code}.json`); }
};

const CRITICAL = /^(contents|columns|announcements|menu|calendar|modules|assignment_groups|calendar\(assignment\))$/;

const hashOf = (raw) => {
  const { fetchedAt, errors, ...rest } = raw;
  return createHash('sha1').update(JSON.stringify(rest)).digest('hex');
};

const summary = { at: startedAt, platforms: {} };
let failed = false;

for (const [name, run] of [
  ['canvas', (stats) => fetchCanvas(ctx, m, stats, { known, onNewCourse })],
  ['blackboard', (stats) => fetchBlackboard(ctx, m, stats, { known, onNewCourse })],
]) {
  if (only && only !== name) continue;
  const stats = newStats();
  if (!auth[name].ok) {
    console.log(`\n✗ ${name} 登录已过期，跳过（先运行 login.mjs 重新登录）`);
    summary.platforms[name] = { ok: false, reason: 'auth' };
    failed = true;
    continue;
  }
  console.log(`\n→ ${name}`);
  try {
    const results = await run(stats);
    const incomplete = [];
    for (const { code, raw } of results) {
      const p = join(DATA, 'raw', code, `${name}.json`);
      const prev = readJson(p, null);
      // 核心接口失败 → 这门课本轮作废，保留上一轮的 raw，免得「抓不到」被当成「没有」
      const broken = raw.errors.filter((e) => CRITICAL.test(e.label)).map((e) => e.label);
      if (broken.length) {
        incomplete.push({ code, failed: broken });
        console.log(`   ⚠ ${code} 核心接口失败（${broken.join('、')}），保留上一轮数据`);
        if (prev) continue;
      }
      raw.contentHash = hashOf(raw);
      raw.contentChangedAt = prev && prev.contentHash === raw.contentHash ? prev.contentChangedAt : raw.fetchedAt;
      writeJson(p, raw);
    }
    summary.platforms[name] = { ok: !incomplete.length, at: startedAt, courses: results.map((r) => r.code), ...stats,
      incomplete, apiErrors: results.reduce((s, r) => s + r.raw.errors.length, 0) };
    if (incomplete.length) failed = true;
  } catch (e) {
    console.error(`✗ ${name}: ${e.message}`);
    summary.platforms[name] = { ok: false, reason: String(e.message).slice(0, 200) };
    failed = true;
  }
  saveManifest(m);
}

await saveCookies(ctx);
await ctx.close();

// --only 时只覆盖本轮跑过的平台
const prevFetch = readStatus().lastFetch || {};
writeStatus({ lastFetch: {
  at: startedAt,
  platforms: { ...(prevFetch.platforms || {}), ...summary.platforms },
  newCourses,
} });
console.log('\n' + Object.entries(summary.platforms).map(([k, v]) => v.courses
  ? `${v.ok ? '✓' : '⚠'} ${k}: ${v.courses.length} 门课 · 新/变更文件 ${v.downloaded} · 未变 ${v.unchanged} · 跳过 ${v.skipped} · 外链 ${v.links} · 下载失败 ${v.failed}${v.apiErrors ? ` · 接口失败 ${v.apiErrors}` : ''}${v.incomplete.length ? `\n  本轮不完整：${v.incomplete.map((x) => x.code).join('、')}` : ''}`
  : `✗ ${k}: ${v.reason}`).join('\n'));
process.exit(failed ? (Object.values(summary.platforms).some((v) => v.reason === 'auth') ? 2 : 1) : 0);
