#!/usr/bin/env node
/**
 * 每门课的完整性报告（full-capture 的完整性门槛，见 references/methodology.md）。
 *
 *   node coverage.mjs        → data/coverage/<CODE>.json、data/coverage.md、sync-status.coverage
 *
 * 门槛（全部满足才算 complete）：
 *   - 平台数据本轮抓到了（没有核心接口失败、没有退回上一轮）
 *   - Blackboard：菜单每一项都有终态；每个文件夹 visited 或 empty（不是打不开、不是没访问）
 *   - Canvas：每个可见导航 tab 都打开过；必需接口没有失败
 *   - 每个 LTI / 外部工具都有 launch 结果；空白 frame（blank_frame）算缺口，下轮重试
 *   - 每个附件都有传输终态；下载失败、超过上限算缺口；老师定时未开放（locked）只记录、不算缺口
 * 「空」是终态，「没访问」不是；不能把空数组、空白 iframe 或没下下来的大文件当成「没有内容」。
 */
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { DATA, readJson, writeJson, readStatus, writeStatus, ensureDir } from './lib/session.mjs';
import { loadManifest } from './lib/files.mjs';
import { listCourses } from './lib/courses.mjs';

const m = loadManifest();
const status = readStatus();
const OUT = ensureDir(join(DATA, 'coverage'));
const tally = (xs) => xs.reduce((o, x) => ((o[x] = (o[x] || 0) + 1), o), {});
const short = (s) => String(s).split('（')[0];

const report = {};
for (const c of listCourses()) {
  const code = c.code;
  const bb = readJson(join(DATA, 'raw', code, 'blackboard.json'), null);
  const cv = readJson(join(DATA, 'raw', code, 'canvas.json'), null);
  const raw = c.platform === 'Canvas' ? cv : bb;
  const reasons = [];
  const notes = [];
  const counts = {};

  if (!raw) {
    reasons.push('还没有平台数据');
  } else {
    const plat = status.lastFetch?.platforms?.[raw.platform === 'Canvas' ? 'canvas' : 'blackboard'];
    if (plat?.incomplete?.some((x) => x.code === code)) reasons.push('本轮核心接口失败，显示的是上一轮数据');
    if (plat?.ok === false && plat.reason === 'auth') reasons.push('登录过期，本轮没抓');
    const apiErrors = (raw.errors || []).filter((e) => e.label !== 'calendar');
    if (apiErrors.length) reasons.push(`${apiErrors.length} 个接口失败（${apiErrors.slice(0, 3).map((e) => e.label).join('、')}${apiErrors.length > 3 ? '…' : ''}）`);
  }

  /* Blackboard：菜单、文件夹、LTI、作业详情 */
  if (bb && c.platform !== 'Canvas') {
    const menu = bb.menu || [];
    counts.menu = tally(menu.map((x) => short(x.status || 'ok')));
    const badMenu = menu.filter((x) => !/^(ok|empty|covered-by-api|skipped)/.test(x.status || 'ok') && !x.lti);
    if (badMenu.length) reasons.push(`菜单打不开：${badMenu.map((x) => `${x.name}(${x.status})`).join('、')}`);
    if (!menu.length) reasons.push('没读到课程菜单');
    const folders = bb.crawl?.folders || [];
    counts.folders = tally(folders.map((x) => x.status));
    const badFolders = folders.filter((x) => !['visited', 'empty'].includes(x.status));
    if (badFolders.length) reasons.push(`${badFolders.length} 个文件夹打不开（${badFolders.slice(0, 3).map((x) => x.path).join('、')}）`);
    if (bb.crawl?.unvisited?.length) reasons.push(`${bb.crawl.unvisited.length} 个文件夹未访问（超过遍历上限）`);
    if (!bb.crawl) reasons.push('没做 HTML 逐层核对（旧版抓取数据）');
    counts.htmlOnly = bb.crawl?.htmlOnly || 0;
    if (counts.htmlOnly) notes.push(`HTML 补到 ${counts.htmlOnly} 个 API 没给的条目`);
    const lti = [...menu.filter((x) => x.lti).map((x) => ({ name: `菜单 ${x.name}`, s: x.lti.status })),
      ...(bb.contents || []).filter((x) => x.lti).map((x) => ({ name: x.title, s: x.lti.status }))];
    counts.lti = tally(lti.map((x) => x.s));
    const blank = lti.filter((x) => x.s === 'blank_frame');
    const ltiBad = lti.filter((x) => !['ok', 'empty', 'blank_frame'].includes(x.s));
    if (blank.length) reasons.push(`LTI 空白：${blank.map((x) => x.name).join('、')}（下轮重试）`);
    if (ltiBad.length) reasons.push(`LTI 打不开：${ltiBad.map((x) => `${x.name}(${x.s})`).join('、')}`);
    const dp = (bb.contents || []).filter((x) => x.detailPage);
    counts.assignmentPages = tally(dp.map((x) => short(x.detailPage.status)));
    const dpBad = dp.filter((x) => !/^(ok|no-info)/.test(x.detailPage.status));
    if (dpBad.length) reasons.push(`作业详情页打不开：${dpBad.map((x) => x.title).join('、')}`);
  }

  /* Canvas：导航 tab、外部工具、接口 */
  if (cv && c.platform === 'Canvas') {
    const tabs = cv.tabs || [];
    counts.tabs = tally(tabs.map((x) => short(x.status)));
    if (!tabs.length) reasons.push('没打开导航 tab（旧版抓取数据或 tabs 接口失败）');
    const blank = tabs.filter((x) => x.status === 'blank_frame');
    const bad = tabs.filter((x) => !/^(ok|empty|blank_frame|hidden|present)/.test(x.status));
    if (blank.length) reasons.push(`导航页空白：${blank.map((x) => x.label).join('、')}（LTI，下轮重试）`);
    if (bad.length) reasons.push(`导航页打不开：${bad.map((x) => `${x.label}(${x.status})`).join('、')}`);
    const tl = cv.toolLaunches || [];
    counts.toolLaunches = tally(tl.map((x) => x.status));
    const tlBad = tl.filter((x) => !['ok', 'empty'].includes(x.status));
    if (tlBad.length) reasons.push(`模块外部工具未取到内容：${tlBad.map((x) => `${x.title}(${x.status})`).join('、')}`);
    if (cv.toolLaunchesSkipped) reasons.push(`${cv.toolLaunchesSkipped} 个模块外部工具超出上限没打开`);
    counts.endpoints = Object.fromEntries(Object.entries(cv.endpoints || {}).map(([k, v]) => [k, v.status]));
    const locked = (cv.modules || []).filter((x) => x.prerequisites || (x.state && x.state === 'locked'));
    if (locked.length) notes.push(`${locked.length} 个模块有先修要求或未解锁（如实保留，不尝试解锁）`);
  }

  /* 文件：每个都要有传输终态 */
  const files = Object.values(m.files).filter((f) => f.course === code && !f.dupOf);
  const state = (f) => f.transfer || (f.skipped ? short(String(f.skipped).split(':')[0]) : f.path ? 'unchanged' : 'pending');
  counts.files = tally(files.map(state));
  const failed = files.filter((f) => state(f) === 'failed');
  const big = files.filter((f) => state(f) === 'too-large');
  const pending = files.filter((f) => state(f) === 'pending');
  const locked = files.filter((f) => state(f) === 'locked');
  if (failed.length) reasons.push(`${failed.length} 个附件下载失败（${failed.slice(0, 3).map((f) => f.name).join('、')}）`);
  if (big.length) reasons.push(`${big.length} 个文件超过 2GB 没下`);
  if (pending.length) reasons.push(`${pending.length} 个文件没有终态`);
  if (locked.length) notes.push(`${locked.length} 个文件老师设了定时开放，开放后自动下载`);
  const media = files.filter((f) => f.skipped === 'media');
  if (media.length) notes.push(`${media.length} 个视频/音频按设置不下载，只登记了出处和链接`);
  const videos = files.filter((f) => f.video);
  if (videos.length) notes.push(`${videos.length} 个外部视频只记录了平台和 ID`);
  const unparsed = files.filter((f) => f.path && !f.text && /\.(pdf|docx?|pptx?|xlsx?)$/i.test(f.path));
  if (unparsed.length) notes.push(`${unparsed.length} 个文档没抽出文字（可直接看原文件）`);

  const prev = readJson(join(OUT, `${code}.json`), {});
  const verdict = reasons.length ? 'partial' : 'complete';
  const rec = {
    code, platform: c.platform, verdict, reasons, notes, counts,
    lastAttemptAt: raw?.fetchedAt || null,
    contentChangedAt: raw?.contentChangedAt || null,
    lastCompleteAt: verdict === 'complete' ? raw?.fetchedAt : prev.lastCompleteAt || null,
  };
  writeJson(join(OUT, `${code}.json`), rec);
  report[code] = rec;
}

/* 人看的总表 */
const rows = Object.values(report).map((r) => {
  const f = r.counts.files || {};
  return `| ${r.code} | ${r.platform} | ${r.verdict === 'complete' ? '完整' : '**部分**'} | ${r.reasons.join('；') || '—'} | ${Object.entries(f).map(([k, v]) => `${k} ${v}`).join(' · ')} | ${r.lastAttemptAt?.slice(0, 16).replace('T', ' ') || '—'} |`;
});
writeFileSync(join(DATA, 'coverage.md'), `# 抓取完整性报告\n\n生成：${new Date().toISOString()}\n\n| 课程 | 平台 | 完整性 | 缺口 | 文件终态 | 本轮抓取 |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n\n## 备注\n\n${Object.values(report).filter((r) => r.notes.length).map((r) => `- **${r.code}**：${r.notes.join('；')}`).join('\n') || '—'}\n`);

writeStatus({ coverage: Object.fromEntries(Object.entries(report).map(([k, r]) => [k, { verdict: r.verdict, reasons: r.reasons, notes: r.notes, lastAttemptAt: r.lastAttemptAt, lastCompleteAt: r.lastCompleteAt }])) });

for (const r of Object.values(report)) {
  console.log(`${r.code.padEnd(9)} ${r.verdict === 'complete' ? '✓ 完整' : '⚠ 部分'}${r.reasons.length ? `  ${r.reasons.join('；')}` : ''}`);
}
console.log(`\n✓ data/coverage.md · data/coverage/<CODE>.json 已生成`);
if (!existsSync(join(DATA, 'coverage.md'))) process.exit(1);
