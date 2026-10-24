#!/usr/bin/env node
/**
 * 找漏：把这门课所有文本层和平台数据里出现的日期挑出来，去掉 JSON 里已经有的，剩下的就是可能漏掉的时间节点。
 *
 *   node omissions.mjs <CODE>
 *
 * 认得的写法：12 Oct / 12th October / Oct 12 / 12/10（日/月）/ 10月12日 / 2026-10-12。
 * 只看本学期范围内的日期（第 1 周前两周到考试周之后）；每个日期最多列 4 处出处。
 * 这只是线索：命中的日期要回原文判断是不是考核、截止或其他节点。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DATA, readJson } from './lib/session.mjs';
import { SEMESTER } from './lib/config.mjs';

const code = (process.argv[2] || '').toUpperCase();
if (!code) { console.error('用法：node omissions.mjs <CODE>'); process.exit(1); }
const c = readJson(join(DATA, 'courses', `${code}.json`), null);
if (!c) { console.error(`✗ 没有 data/courses/${code}.json`); process.exit(1); }
const meta = readJson(join(DATA, 'meta.json'), {});

/* 学期范围 */
const day = (s) => new Date(`${s}T00:00:00Z`);
let from;
let to;
if (meta.weekOneMonday) {
  from = new Date(day(meta.weekOneMonday).getTime() - 14 * 864e5);
  to = new Date(day(meta.weekOneMonday).getTime() + ((meta.totalWeeks || 13) + 8) * 7 * 864e5);
} else {
  const y = SEMESTER.year;
  [from, to] = SEMESTER.term === 1 ? [day(`${y}-08-15`), day(`${y + 1}-01-15`)]
    : SEMESTER.term === 2 ? [day(`${y + 1}-01-01`), day(`${y + 1}-05-31`)] : [day(`${y + 1}-06-01`), day(`${y + 1}-08-31`)];
}
const iso = (d) => d.toISOString().slice(0, 10);
/** 没写年份的「日 + 月」：取落在学期范围里的那一年 */
function resolve(dd, mm) {
  for (const y of [from.getUTCFullYear(), to.getUTCFullYear()]) {
    const d = new Date(Date.UTC(y, mm - 1, dd));
    if (d.getUTCMonth() === mm - 1 && d >= from && d <= to) return d;
  }
  return null;
}

/* JSON 里已经有的日期 */
const have = new Set();
const add = (v) => { if (v) have.add(String(v).slice(0, 10)); };
for (const a of c.assessments || []) {
  add(a.due); add(a.opens);
  for (const x of a.dueRange || []) add(x);
  for (const x of a.subItems || []) add(x.due);
}
for (const m of c.milestones || []) add(m.date);
const sched = new Set((c.schedule || []).map((x) => String(x.date || '').slice(0, 10)).filter(Boolean));
const ann = new Set((c.announcements || []).map((x) => String(x.date || '').slice(0, 10)).filter(Boolean));

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const M = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec';
/** 写了年份的就按那一年判断（讲义里的历史年份不算），没写年份的取落在学期里的那一年 */
function dated(dd, mm, yy) {
  if (!mm || dd < 1 || dd > 31) return null;
  if (!yy) return resolve(dd, mm);
  const y = +yy < 100 ? 2000 + +yy : +yy;
  const d = new Date(Date.UTC(y, mm - 1, dd));
  return d.getUTCMonth() === mm - 1 && d >= from && d <= to ? d : null;
}
const PATS = [
  [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s-]*(?:of\\s+)?(${M})[a-z]*\\.?(?:,?\\s*(\\d{4})\\b)?`, 'gi'), (x) => dated(+x[1], MON[x[2].toLowerCase()], x[3])],
  [new RegExp(`\\b(${M})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4})\\b)?`, 'gi'), (x) => dated(+x[2], MON[x[1].toLowerCase()], x[3])],
  [/(?<![\d/.])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/g, (x) => (+x[2] >= 1 && +x[2] <= 12 ? dated(+x[1], +x[2], x[3]) : null)],
  [/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/g, (x) => dated(+x[3], +x[2], x[1])],
  [/\b(20\d{2})-(\d{2})-(\d{2})\b/g, (x) => { const d = new Date(Date.UTC(+x[1], +x[2] - 1, +x[3])); return d >= from && d <= to ? d : null; }],
];

function walk(dir, out = []) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (/\.txt$/.test(n) || /^_(canvas|blackboard)\.md$/.test(n)) out.push(p);
  }
  return out;
}

const base = join(DATA, 'text', code);
const hits = new Map();
for (const f of walk(base)) {
  let page = null;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (line.startsWith('=== p.')) { page = line.trim(); continue; }
    for (const [re, toDate] of PATS) {
      for (const x of line.matchAll(re)) {
        const d = toDate(x);
        if (!d) continue;
        const k = iso(d);
        if (have.has(k)) continue;
        if (!hits.has(k)) hits.set(k, []);
        hits.get(k).push([relative(base, f).slice(0, 55), page, line.trim().slice(0, 150)]);
      }
    }
  }
}

console.log(`== ${code}：本学期范围 ${iso(from)} – ${iso(to)}，JSON 里已有 ${have.size} 个日期；下面是材料里提到、JSON 里还没有的日期`);
for (const k of [...hits.keys()].sort()) {
  const tag = `${sched.has(k) ? '[周计划有]' : ''}${ann.has(k) ? '[公告日]' : ''}`;
  console.log(`${k} ${tag} ×${hits.get(k).length}`);
  const seen = new Set();
  for (const [file, page, text] of hits.get(k)) {
    if (seen.has(text)) continue;
    seen.add(text);
    console.log(`     ${file} ${page || ''} | ${text}`);
    if (seen.size >= 4) break;
  }
}
if (!hits.size) console.log('（没有发现 JSON 以外的日期）');
