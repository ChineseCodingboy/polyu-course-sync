#!/usr/bin/env node
/**
 * 每门课一个文件夹：作业与考核信息 + 全部抓到的课程资料，在 Finder 里直接点开。
 *
 *   node folders.mjs
 *
 * - 资料按平台上的目录存放，只存一份（不复制）
 * - 在每门课的资料文件夹里生成「00 作业与考核.html」：作业与考核（截止、权重、形式、要求、出处）、
 *   其他时间节点、资料目录；文件名都是相对链接，点开就是原文件，PDF 出处直接跳到对应页
 * - 资料实际放在课程文件夹 <coursesFolder>/<课号 课名>/（真文件夹，默认 ~/Documents/PolyU 课程），
 *   data/files/<CODE> 是指回去的链接（Windows 上用目录联接 junction，不需要管理员权限）
 *
 * 依赖 build 生成的 data/courses.js（课程数据）和 data/manifest.json（文件清单）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, lstatSync, symlinkSync, unlinkSync, readlinkSync, renameSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ROOT, DATA } from './lib/session.mjs';
import { COURSES_FOLDER } from './lib/config.mjs';
import { loadManifest, pathIndex } from './lib/files.mjs';

const HUB = COURSES_FOLDER;
const TZ = 'Asia/Hong_Kong';
const t = readFileSync(join(DATA, 'courses.js'), 'utf8');
const { courses } = JSON.parse(t.slice(t.indexOf('=') + 1).trim().replace(/;\s*$/, ''));
const m = loadManifest();
const IDX = pathIndex(m);   // 文件搬过家时，按旧路径找到现在的位置

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso, o) => new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, ...o }).format(new Date(iso));
const when = (iso) => {
  if (!iso) return '待定';
  const d = fmt(iso, { month: 'numeric', day: 'numeric' }) + ' ' + fmt(iso, { weekday: 'short' });
  const tm = fmt(iso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return tm === '00:00' ? d : `${d} ${tm}`;
};
const DOW = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const href = (rel) => rel.split('/').map(encodeURIComponent).join('/');
const safe = (s) => String(s).replace(/[/:]/g, '-').trim();

/** 出处 → 课程文件夹里的相对链接（文本层 .txt 映射回原文件；PDF 带页码） */
function sourceLink(src, code) {
  if (!src) return '';
  let label = src.file ? src.file.split('/').pop().replace(/\.txt$/, '') : src.md ? '平台页面' : '';
  if (!src.file) return esc(label + (src.page ? ` p.${src.page}` : ''));
  let p = src.file.replace(/^\.\//, '').replace(/^data\/text\//, 'data/files/').replace(/\.txt$/, '');
  const moved = !existsSync(join(ROOT, p)) && (IDX.get(p) || IDX.get(src.file));
  if (moved?.path) { p = moved.path; label = moved.name || label; }
  if (!existsSync(join(ROOT, p)) && /\.pdf$/.test(p)) p = p.replace(/\.pdf$/, '');   // Office 转出的 PDF → 原文件
  const base = `data/files/${code}/`;
  if (!p.startsWith(base) || !existsSync(join(ROOT, p))) return esc(label + (src.page ? ` p.${src.page}` : ''));
  const rel = p.slice(base.length);
  const page = src.page && /\.pdf$/i.test(rel) ? `#page=${src.page}` : '';
  return `<a href="${href(rel)}${page}">${esc(label)}${src.page ? ` p.${src.page}` : ''}</a>`;
}

const CSS = `
:root{--bg:#FAF9F5;--ink:#141413;--muted:rgba(20,20,19,.58);--hair:rgba(20,20,19,.12);--tint:#EDEAE1}
@media (prefers-color-scheme:dark){:root{--bg:#1C1B19;--ink:#F0EEE6;--muted:rgba(240,238,230,.58);--hair:rgba(240,238,230,.13);--tint:#2E2B26}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,"PingFang SC","Helvetica Neue",sans-serif}
main{max-width:860px;margin:0 auto;padding:36px 24px 64px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:var(--muted);font-size:14px;margin:0 0 4px}
h2{font-size:13px;color:var(--muted);font-weight:600;margin:36px 0 6px}
table{border-collapse:collapse;width:100%}
td{border-top:1px solid var(--hair);padding:10px 12px 10px 0;vertical-align:top}
td.d{white-space:nowrap;width:92px;font-variant-numeric:tabular-nums}
td.w{white-space:nowrap;text-align:right;width:48px;font-variant-numeric:tabular-nums}
.n{font-weight:600}.en{color:var(--muted);font-size:13px}
.x{color:var(--muted);font-size:13px;margin-top:4px}
.x a,.files a{color:inherit}
ul{margin:0;padding-left:1.1em}
.files{list-style:none;padding:0}
.files li{border-top:1px solid var(--hair);padding:7px 0;display:flex;gap:12px;justify-content:space-between}
.files .m{color:var(--muted);font-size:13px;white-space:nowrap}
.folder{font-weight:600;margin:16px 0 4px;font-size:14px}
a{text-underline-offset:2px}
`;

function page(c) {
  const code = c.code;
  const meet = (c.meetings || []).map((x) => `${x.type || ''} ${DOW[x.day] || ''} ${x.start || ''}${x.end ? '–' + x.end : ''}${x.room ? ' ' + x.room : ''}`.trim());
  const sub = [c.title && c.titleZh ? c.title : '', c.teacher, ...meet].filter(Boolean).map(esc).join(' · ');
  const as = (c.assessments || []).slice().sort((a, b) => (a.due ? Date.parse(a.due) : 9e15) - (b.due ? Date.parse(b.due) : 9e15));
  const rows = as.map((a) => {
    const extra = [];
    if (a.format) extra.push(esc(a.format));
    if (a.description) extra.push(esc(a.description));
    if (a.notes) extra.push(esc(Array.isArray(a.notes) ? a.notes.join('；') : a.notes));
    if (a.opens) extra.push('开放 ' + esc(when(a.opens)));
    if (a.dueRange) extra.push('进行时段 ' + esc(a.dueRange.join(' 至 ')));
    if ((a.subItems || []).length) extra.push('细分：' + a.subItems.map((x) => `${esc(x.name)}${x.weight != null ? ' ' + esc(x.weight) + '%' : ''}${x.due ? ' ' + esc(when(x.due)) : ''}`).join('；'));
    if ((a.rubric || []).length) extra.push('评分：' + a.rubric.map((r) => `${esc(r.k)} ${esc(r.v)}%`).join('；'));
    const src = (a.sources || []).map((s) => sourceLink(s, code)).filter(Boolean);
    if (src.length) extra.push('出处：' + [...new Set(src)].join('；'));
    const approx = a.confidence === 'inferred' ? '约 ' : '';
    return `<tr><td class="d">${approx}${esc(when(a.due))}</td><td><div class="n">${esc(a.nameZh || a.name || a.label)}</div>` +
      `${a.nameZh && a.name ? `<div class="en">${esc(a.name)}</div>` : ''}${extra.length ? `<div class="x">${extra.join('<br>')}</div>` : ''}</td>` +
      `<td class="w">${c.graded === false ? '' : esc(a.weight) + '%'}</td></tr>`;
  }).join('');
  const ms = (c.milestones || []).filter((x) => x.date).sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    .map((x) => `<tr><td class="d">${esc(when(x.date))}</td><td>${esc(x.title)}${x.detail ? `<div class="x">${esc(x.detail)}</div>` : ''}</td><td class="w"></td></tr>`).join('');

  // 资料目录：按平台上的文件夹分组；文件点开即本地原件，外链和未下载的视频链接到平台
  const files = Object.values(m.files).filter((f) => f.course === code && !f.dupOf);
  const groups = {};
  for (const f of files) (groups[f.folder || '其他'] ||= []).push(f);
  const base = `data/files/${code}/`;
  const list = Object.keys(groups).sort().map((g) => `<p class="folder">${esc(g)}</p><ul class="files">` + groups[g]
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((f) => {
      let link;
      let meta = '';
      if (f.path && f.path.startsWith(base) && existsSync(join(ROOT, f.path))) {
        link = `<a href="${href(f.path.slice(base.length))}">${esc(f.name)}</a>`;
        meta = f.pages ? `${f.pages} 页` : '';
      } else {
        link = f.url ? `<a href="${esc(f.url)}">${esc(f.name || f.url)}</a>` : esc(f.name);
        meta = f.skipped === 'media' ? '视频，未下载' : f.skipped === 'locked' ? '未开放' : f.skipped === 'link' ? '网页链接' : f.skipped ? '下载失败' : '';
      }
      return `<li><span>${link}</span><span class="m">${meta}</span></li>`;
    }).join('') + '</ul>').join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(code)} ${esc(c.titleZh || c.title || '')} · 作业与考核</title><style>${CSS}</style></head><body><main>
<h1>${esc(code)} ${esc(c.titleZh || c.title || '')}</h1>
${sub ? `<p class="sub">${sub}</p>` : ''}${c.url ? `<p class="sub"><a href="${esc(c.url)}">在 ${esc(c.platform || '平台')} 打开</a></p>` : ''}
<h2>作业与考核${c.graded === false ? '（完成制，不计权重）' : ''}</h2>
${rows ? `<table>${rows}</table>` : '<p class="sub">还没有整理出考核信息。</p>'}
${ms ? `<h2>其他时间节点</h2><table>${ms}</table>` : ''}
<h2>课程资料（${files.length}）</h2>
${list || '<p class="sub">还没有抓到资料。</p>'}
<p class="sub" style="margin-top:32px">更新于 ${esc(fmt(new Date().toISOString(), { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))}</p>
</main></body></html>`;
}

// 课程文件夹是真文件夹：资料实际存放在 <课程文件夹>/<课号 课名>/，
// data/files/<课号> 是指回去的链接，抓取和 convert 照旧按 data/files/<课号> 读写。
// （反过来用链接做入口的话，iCloud / 手机上看不到资料，所以资料放在真文件夹里）
const makeLink = (target, path) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
const fold = (x) => (process.platform === 'linux' ? x : x.toLowerCase());   // macOS / Windows 默认不区分大小写
const same = (a, b) => fold(resolve(String(a).replace(/^\\\\\?\\/, ''))) === fold(resolve(b));   // Windows 的 junction 读回来可能带 \\?\ 前缀
mkdirSync(HUB, { recursive: true });
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
let moved = 0;
const names = [];
for (const c of courses) {
  const name = safe(`${c.code} ${c.titleZh || c.title || ''}`);
  const real = join(HUB, name);
  const link = join(DATA, 'files', c.code);
  if (isLink(link)) {
    const cur = readlinkSync(link);
    if (!same(cur, real)) {                                          // 课名变了：整个文件夹改名
      if (existsSync(cur) && !existsSync(real)) renameSync(cur, real);
      unlinkSync(link); makeLink(real, link);
    }
  } else if (existsSync(link)) {                                     // 第一次：把资料搬进课程文件夹
    if (existsSync(real)) {                                          // 同名文件夹已经有了：不覆盖、不合并，这门课先留在原地
      console.log(`   ⚠ ${real} 已经存在，${c.code} 的资料先留在 ${link}（把两边合并后删掉其中一个，再跑 folders）`);
      writeFileSync(join(link, '00 作业与考核.html'), page(c));
      continue;
    }
    renameSync(link, real); makeLink(real, link); moved++;
  } else {
    mkdirSync(join(DATA, 'files'), { recursive: true });
    mkdirSync(real, { recursive: true }); makeLink(real, link);
  }
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, '00 作业与考核.html'), page(c));
  names.push(name);
}
console.log(`✓ ${courses.length} 门课的文件夹在 ${HUB}${moved ? `（这次搬入 ${moved} 门）` : ''}，每个里面有「00 作业与考核.html」和全部资料`);
for (const n of names) console.log(`   ${n}`);
console.log(`   （${relative(ROOT, join(DATA, 'files'))}/<课号> 是指向这些文件夹的链接）`);
