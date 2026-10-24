#!/usr/bin/env node
/**
 * data/courses/*.json → 校验 → 引用核对 → 合并变更 → 生成前端数据
 *
 *   node build.mjs --snapshot   提取前调用：把当前课程 JSON 备份到 data/courses/.prev/
 *   node build.mjs              校验 + 核对 + 生成 data/courses.js / files.js / sync.js
 *
 * 硬错误（JSON 坏了、权重≠100、日期不合法、confidence 非法）→ 该课回滚到 .prev 版本，退出码 1。
 * 引用核对：每个 sources[].quote 去空白后必须出现在对应文本层 / 平台 md 里 → data/grounding/<CODE>.json
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, rmSync, statSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, DATA, ensureDir, readJson, writeJson, readStatus, writeStatus } from './lib/session.mjs';
import { ASSETS, syncMeta } from './lib/config.mjs';
import { loadManifest, pathIndex } from './lib/files.mjs';
import { COURSES_DIR } from './lib/courses.mjs';

const PREV = join(COURSES_DIR, '.prev');
ensureDir(COURSES_DIR);   // 首次运行时还没有任何课程
const courseFiles = () => readdirSync(COURSES_DIR).filter((f) => f.endsWith('.json'));

if (process.argv.includes('--snapshot')) {
  syncMeta();   // 改过的学期配置（第 1 周周一等）在派提取 agent 之前就写进 meta.json
  ensureDir(PREV);
  for (const f of courseFiles()) copyFileSync(join(COURSES_DIR, f), join(PREV, f));
  console.log(`✓ 已备份 ${courseFiles().length} 门课到 data/courses/.prev/`);
  process.exit(0);
}

// 学期信息以 config.json 为准，写回 data/meta.json（提取 agent 和看版读它）
const meta = syncMeta();
const m = loadManifest();
const byPath = pathIndex(m);   // 现在的路径 + 文件搬家前的旧路径
const termStart = meta.weekOneMonday ? new Date(`${meta.weekOneMonday}T00:00:00+08:00`) : null;   // 还没确定第 1 周时不校验周次
const CONF = new Set(['confirmed', 'inferred', 'unknown']);

/* ── 引用核对 ── */
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase()
  .replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/[–—−‐]/g, '-')
  .replace(/[\s​­]+/g, '');
const textCache = new Map();
function sourceText(src) {
  let p = null;
  if (src.md) p = src.md;
  else if (src.file) {
    const f = byPath.get(src.file) || byPath.get(src.file.replace(/^\.\//, ''));
    p = f?.text || (src.file.startsWith('data/text/') ? src.file : null);
  }
  if (!p) return null;
  if (!textCache.has(p)) {
    const abs = join(ROOT, p);
    textCache.set(p, existsSync(abs) ? readFileSync(abs, 'utf8') : null);
  }
  return textCache.get(p);
}
function ground(src) {
  if (!src || !src.quote) return 'no-quote';
  if (src.vision) return 'vision';
  const text = sourceText(src);
  if (text == null) return src.file && !byPath.has(src.file) ? 'bad-file' : 'no-text';
  const q = norm(src.quote);
  if (src.page && /=== p\.\d+ ===/.test(text)) {
    const page = text.split(/=== p\.(\d+) ===/);
    for (let i = 1; i < page.length; i += 2) if (+page[i] === +src.page && norm(page[i + 1]).includes(q)) return 'ok';
    return norm(text).includes(q) ? 'ok-other-page' : 'missing';
  }
  return norm(text).includes(q) ? 'ok' : 'missing';
}

/* ── 校验 ── */
function validate(c) {
  const errors = [];
  const warns = [];
  const isoOk = (v) => v == null || (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !isNaN(new Date(v)));
  if (!c.code || !c.id) errors.push('缺 id/code');
  if (!Array.isArray(c.assessments)) errors.push('assessments 不是数组');
  const as = c.assessments || [];
  if (as.length && c.graded === false) {
    // 不计学分、完成即可的课（全校性的完成制课程）：各项 weight 写 0，不校验合计
    if (as.some((a) => +a.weight)) warns.push('graded=false 的课不应有非 0 权重');
  } else if (as.length) {
    const tot = as.reduce((s, a) => s + (+a.weight || 0), 0);
    if (Math.abs(tot - 100) > 0.01) errors.push(`权重合计 ${tot} ≠ 100`);
  } else {
    warns.push('还没有考核数据（待提取）');
  }
  const ids = new Set();
  for (const a of as) {
    const tag = `考核 ${a.id}`;
    if (!a.id) errors.push('有考核缺 id');
    if (ids.has(a.id)) errors.push(`${tag} id 重复`);
    ids.add(a.id);
    if (typeof a.weight !== 'number') errors.push(`${tag} weight 不是数字`);
    if (!CONF.has(a.confidence)) errors.push(`${tag} confidence=${a.confidence}`);
    for (const k of ['due', 'opens']) if (!isoOk(a[k])) errors.push(`${tag} ${k} 不是 ISO 时间：${a[k]}`);
    if (a.due && a.confidence === 'unknown' && !a.dueRange) warns.push(`${tag} 有日期但标 unknown`);
    if (!a.due && a.confidence === 'confirmed') warns.push(`${tag} 标 confirmed 但没有日期`);
    if (a.opens && a.due && new Date(a.opens) > new Date(a.due)) errors.push(`${tag} opens 晚于 due`);
    if (a.due && a.week && termStart) {
      const wk = Math.floor((new Date(a.due) - termStart) / (7 * 864e5)) + 1;
      if (wk !== a.week) warns.push(`${tag} week=${a.week} 与日期推算的第 ${wk} 周不符`);
    }
    if (!a.sources?.length) warns.push(`${tag} 没有 sources`);
    if (a.rubric?.length) {
      const rt = a.rubric.reduce((s, r) => s + (+r.v || 0), 0);
      if (Math.abs(rt - 100) > 0.01) warns.push(`${tag} rubric 合计 ${rt}`);
    }
    if (a.unverifiedSeed) warns.push(`${tag} 种子数据未找到依据`);
  }
  for (const x of c.milestones || []) if (!isoOk(x.date)) errors.push(`节点「${x.title}」date 不合法：${x.date}`);
  for (const x of c.schedule || []) if (x.date && !/^\d{4}-\d{2}-\d{2}$/.test(x.date)) errors.push(`周计划 W${x.week} date 不合法：${x.date}`);
  return { errors, warns };
}

function walkSources(c) {
  const out = [];
  const push = (ref, list) => (list || []).forEach((s, i) => out.push({ ref: `${ref}.sources[${i}]`, src: s }));
  push('syllabus', c.syllabus?.sources);
  push('rules', c.rules?.sources);
  (c.assessments || []).forEach((a) => {
    push(`assessments.${a.id}`, a.sources);
    (a.conflicts || []).forEach((cf, j) => (cf.values || []).forEach((v, k) => v.src && out.push({ ref: `assessments.${a.id}.conflicts[${j}].values[${k}]`, src: v.src })));
  });
  (c.milestones || []).forEach((x, i) => push(`milestones[${i}]`, x.sources));
  return out;
}

/* ── 主流程 ── */
const report = [];
const courses = [];
let hardFail = false;
ensureDir(join(DATA, 'grounding'));

for (const f of courseFiles()) {
  const p = join(COURSES_DIR, f);
  let c;
  let v;
  try { c = JSON.parse(readFileSync(p, 'utf8')); v = validate(c); } catch (e) { v = { errors: [`JSON 解析失败：${e.message}`], warns: [] }; }
  if (v.errors.length) {
    hardFail = true;
    const prev = join(PREV, f);
    if (existsSync(prev)) {
      copyFileSync(p, join(PREV, f.replace('.json', '.rejected.json')));
      copyFileSync(prev, p);
      c = JSON.parse(readFileSync(p, 'utf8'));
      report.push({ code: f.replace('.json', ''), rolledBack: true, errors: v.errors });
      v = validate(c);
    } else {
      report.push({ code: f.replace('.json', ''), rolledBack: false, errors: v.errors });
      if (!c) continue;
    }
  }
  const g = walkSources(c).map(({ ref, src }) => ({ ref, file: src.file || src.md || src.url || null, page: src.page || null, quote: src.quote || null, status: ground(src) }));
  writeJson(join(DATA, 'grounding', `${c.code}.json`), { at: new Date().toISOString(), results: g });
  const count = (s) => g.filter((x) => x.status === s).length;
  c._check = {
    warns: v.warns,
    grounding: { total: g.length, ok: count('ok') + count('ok-other-page'), vision: count('vision'), missing: g.length - count('ok') - count('ok-other-page') - count('vision') },
    missingRefs: g.filter((x) => !/^(ok|ok-other-page|vision)$/.test(x.status)).map((x) => x.ref),
  };
  courses.push(c);
  const r = report.find((x) => x.code === c.code) || (report.push({ code: c.code }), report[report.length - 1]);
  Object.assign(r, { warns: v.warns, grounding: c._check.grounding });
}

// 课程顺序：Canvas 在前，再按课号
courses.sort((a, b) => (a.platform === b.platform ? a.code.localeCompare(b.code) : a.platform === 'Canvas' ? -1 : 1));

/* ── 变更：pending → changes/<date>.json ── */
const pendDir = join(DATA, 'changes', 'pending');
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
if (existsSync(pendDir)) {
  const pend = readdirSync(pendDir).filter((x) => x.endsWith('.json'));
  if (pend.length) {
    const out = join(DATA, 'changes', `${today}.json`);
    const day = readJson(out, { date: today, courses: {} });
    for (const f of pend) {
      const x = readJson(join(pendDir, f), null);
      if (x?.items?.length) day.courses[x.course] = [...(day.courses[x.course] || []), ...x.items.map((i) => ({ ...i, at: x.at }))];
      try { rmSync(join(pendDir, f)); } catch { ensureDir(join(pendDir, '.merged')); renameSync(join(pendDir, f), join(pendDir, '.merged', `${Date.now()}-${f}`)); }  // 无删除权限的环境：挪走代替删除
    }
    writeJson(out, day);
  }
}
const changes = existsSync(join(DATA, 'changes'))
  ? readdirSync(join(DATA, 'changes')).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().reverse().slice(0, 8)
      .map((x) => readJson(join(DATA, 'changes', x), null)).filter(Boolean)
  : [];

/* ── 生成前端数据 ── */
meta.lastUpdated = today;
writeJson(join(DATA, 'meta.json'), meta);
copyFileSync(join(ASSETS, 'dashboard.html'), join(ROOT, 'index.html'));   // 本地看版跟着 skill 版本更新
writeFileSync(join(DATA, 'courses.js'),
  `/* 由 scraper/build.mjs 从 data/courses/*.json 生成，勿手改 */\nwindow.COURSE_DATA = ${JSON.stringify({ meta, courses }, null, 1)};\n`);

const status = readStatus();
const lastSeenCut = {};
for (const [k, v] of Object.entries(status.lastFetch?.platforms || {})) if (v.ok && v.at) lastSeenCut[k === 'canvas' ? 'Canvas' : 'Blackboard'] = v.at;
const files = {};
const alsoIn = {};
for (const f of Object.values(m.files)) if (f.dupOf) (alsoIn[f.dupOf] ||= []).push(f.context);
for (const f of Object.values(m.files)) {
  if (f.dupOf) continue;
  (files[f.course] ||= []).push({
    name: f.name, folder: f.folder, platform: f.platform,
    context: [f.context, ...(alsoIn[f.key] || [])].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' · '),
    path: f.path || null, url: f.url, size: f.size, ext: (f.name || '').split('.').pop().toLowerCase(),
    firstSeen: f.firstSeen, lastChanged: f.lastChanged || null, skipped: f.skipped || null,
    lockInfo: f.lockInfo ? String(f.lockInfo).replace(/<[^>]+>/g, '') : null,
    pages: f.pages ?? null, visionPages: f.visionPages?.length || 0,
    gone: !!(lastSeenCut[f.platform] && f.lastSeen < lastSeenCut[f.platform]),
  });
}
for (const k of Object.keys(files)) files[k].sort((a, b) => `${a.folder}/${a.name}`.localeCompare(`${b.folder}/${b.name}`));
writeFileSync(join(DATA, 'files.js'), `/* 由 scraper/build.mjs 生成，勿手改 */\nwindow.COURSE_FILES = ${JSON.stringify(files)};\n`);

const s2 = writeStatus({ lastBuild: { at: new Date().toISOString(), ok: !hardFail, report } });
writeFileSync(join(DATA, 'sync.js'), `/* 由 scraper/build.mjs 生成，勿手改 */\nwindow.SYNC = ${JSON.stringify({ status: s2, changes })};\n`);

/* ── 报告 ── */
for (const r of report) {
  const g = r.grounding;
  const line = [`${r.code.padEnd(9)}`];
  if (r.errors) line.push(r.rolledBack ? `✗ 已回滚（${r.errors.join('；')}）` : `✗ ${r.errors.join('；')}`);
  else line.push('✓');
  if (g) line.push(`引用 ${g.ok}/${g.total} 核实${g.vision ? ` · 看图 ${g.vision}` : ''}${g.missing ? ` · ⚠ 未核实 ${g.missing}` : ''}`);
  if (r.warns?.length) line.push(`提示 ${r.warns.length}`);
  console.log(line.join('  '));
  for (const w of r.warns || []) console.log(`           · ${w}`);
}
console.log(`\n✓ data/courses.js · files.js · sync.js 已生成（${courses.length} 门课，${Object.values(files).flat().length} 个文件/链接）`);
process.exit(hardFail ? 1 : 0);
