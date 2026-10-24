#!/usr/bin/env node
/**
 * 看版数据 → 「课程工作台」网页（claude.ai Artifact，可选）的数据库文档。
 *
 *   node site-export.mjs   → data/site/*.json（每个文件是一个文档）+ data/site/batches.json
 *
 * 网页：待办（每项可展开看要求、评分、提交方式、出处）、课程进度，以及每门课一页（作业与考核、时间节点、全部资料）。
 *   site/meta        学期第一周周一、总周数、生成时间、两个平台的登录是否有效（判断数据是否过时）、课程顺序
 *   courses/<CODE>   课号、课名、平台链接、老师与上课时间、每项任务的详情、时间节点、资料清单
 * 资料只给平台上的链接（原文件只留在本机的课程文件夹里），视频和录播不列。
 *
 * 写入由 Claude 用 ArtifactData 的 batch 完成（见 skill 的 references/website.md）：
 * 先 list 拿到 version，再按 batches.json 逐批 set（已存在的文档带 if_version）。
 */
import { readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, ensureDir, readStatus } from './lib/session.mjs';
import { loadManifest, pathIndex } from './lib/files.mjs';

const OUT = join(DATA, 'site');
const MAX_DOC = 240 * 1024;
const MAX_BATCH = 900 * 1024;
const MAX_WRITES = 50;

const t = readFileSync(join(DATA, 'courses.js'), 'utf8');
const { meta, courses } = JSON.parse(t.slice(t.indexOf('=') + 1).trim().replace(/;\s*$/, ''));
const status = readStatus();

if (existsSync(OUT)) { try { rmSync(OUT, { recursive: true, force: true }); } catch { /* 无删除权限的环境：直接覆盖同名文件 */ } }
ensureDir(OUT);

const docs = [];
const push = (collection, id, data) => {
  const body = JSON.stringify(data);
  if (Buffer.byteLength(body) > MAX_DOC) throw new Error(`${collection}/${id} 超过单文档上限`);
  const file = join(OUT, `${collection}__${id}.json`);
  writeFileSync(file, body);
  docs.push({ collection, doc_id: id, file_path: file, bytes: Buffer.byteLength(body) });
};

const m = loadManifest();
const files = Object.values(m.files);
const byPath = pathIndex(m);   // 现在的路径、文本层路径 + 文件搬家前的旧路径
const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const clip = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
/** 出处 → { t: 文件名 p.N, u: 平台链接, q: 原文片段 } */
function src(s, c) {
  if (s.file) {
    const f = byPath.get(s.file.replace(/^\.\//, '')) || byPath.get(s.file.replace(/^\.\//, '').replace(/\.pdf$/, ''));
    const name = f?.name || s.file.split('/').pop().replace(/\.txt$/, '');
    return { t: name + (s.page ? ` p.${s.page}` : '') + (s.entry ? `（${s.entry.split('/').pop()}）` : ''), u: f?.url || null, q: clip(s.quote, 220) || null };
  }
  if (s.md) return { t: `${c.platform || '平台'} 页面`, u: c.url || null, q: clip(s.quote, 220) || null };
  if (s.url) return { t: clip(s.url.replace(/^https?:\/\//, ''), 60), u: s.url, q: clip(s.quote, 220) || null };
  return null;
}
const FIELD = { weight: '权重', due: '截止', opens: '开放', format: '形式', submission: '提交', week: '周次', group: '分组' };
/** 资料之间说法不一：只留结论（采用哪个、为什么） */
function conflict(x) {
  if (typeof x === 'string') return x;
  const head = FIELD[x.field] ? FIELD[x.field] + '：' : '';
  if (x.resolution) return head + x.resolution;
  if (x.note || x.detail) return head + (x.note || x.detail);
  return null;
}
const dedupe = (xs) => { const seen = new Set(); return xs.filter((x) => { const k = x.t + '|' + x.q; if (seen.has(k)) return false; seen.add(k); return true; }); };

for (const c of courses) {
  const mats = files.filter((f) => f.course === c.code && !f.dupOf && f.skipped !== 'media' && !f.video)
    .map((f) => ({ n: f.name, f: f.folder || '其他', u: f.url || null, k: f.path ? 'file' : f.skipped === 'locked' ? 'locked' : 'link', p: f.pages || null }))
    .sort((a, b) => a.f.localeCompare(b.f) || String(a.n).localeCompare(String(b.n)));
  push('courses', c.code, {
    code: c.code, title: c.title || '', titleZh: c.titleZh || '', graded: c.graded === false ? false : true,
    platform: c.platform || null, url: c.url || null, teacher: c.teacher || null, contact: c.teacherContact || null,
    meetings: (c.meetings || []).map((x) => ({ type: x.type || null, day: x.day ?? null, start: x.start || null, end: x.end || null, room: x.room || null })),
    assessments: (c.assessments || []).map((a) => ({
      id: a.id, label: a.label || null, name: a.name || null, nameZh: a.nameZh || null,
      weight: a.weight ?? 0, due: a.due || null, confidence: a.confidence || null, unverifiedSeed: !!a.unverifiedSeed,
      opens: a.opens || null, dueRange: a.dueRange || null, week: a.week ?? null,
      format: a.format || null, description: a.description || null, submission: a.submission || null, group: a.groupwork ?? null,
      subItems: arr(a.subItems).map((x) => ({ name: x.name || x.nameZh || '', weight: x.weight ?? null, due: x.due || null })),
      rubric: arr(a.rubric).map((r) => ({ k: r.k, v: r.v })),
      notes: arr(a.notes).map(String), conflicts: arr(a.conflicts).map(conflict).filter(Boolean),
      url: a.url || null,
      sources: dedupe(arr(a.sources).map((s) => src(s, c)).filter(Boolean)).slice(0, 8),
    })),
    milestones: (c.milestones || []).filter((x) => x.date).map((x) => ({ date: x.date, title: x.title, detail: x.detail || null })),
    materials: mats,
  });
}
push('site', 'meta', {
  weekOneMonday: meta.weekOneMonday, totalWeeks: meta.totalWeeks,
  generatedAt: new Date().toISOString(),
  auth: { blackboard: { ok: status.auth?.blackboard?.ok ?? null }, canvas: { ok: status.auth?.canvas?.ok ?? null } },
  order: courses.map((c) => c.code),
});

const batches = [];
let cur = [];
let size = 0;
for (const d of docs) {
  if (cur.length && (cur.length >= MAX_WRITES || size + d.bytes > MAX_BATCH)) { batches.push(cur); cur = []; size = 0; }
  cur.push(d); size += d.bytes;
}
if (cur.length) batches.push(cur);
writeFileSync(join(OUT, 'batches.json'), JSON.stringify(batches.map((b) => b.map(({ collection, doc_id, file_path }) => ({ collection, doc_id, file_path }))), null, 1));
console.log(`✓ ${docs.length} 个文档（courses ${courses.length} · site 1），共 ${(docs.reduce((s, d) => s + d.bytes, 0) / 1024).toFixed(0)} KiB，分 ${batches.length} 批 → data/site/batches.json`);
