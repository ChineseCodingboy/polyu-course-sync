#!/usr/bin/env node
/**
 * 文件 → 文本旁车（只处理新增/变更的），并把每门课的 raw JSON 渲染成可读 Markdown。
 *
 *   data/text/<CODE>/<与 data/files 相同的相对路径>.txt   每页以「=== p.N ===」分隔，引用页码用
 *   data/text/<CODE>/<…>.pdf                              Office 文件转出的 PDF（给 agent 看版式/图片）
 *   data/text/<CODE>/_canvas.md / _blackboard.md          平台数据（公告全文、作业说明、内容树…）
 *   data/text/<CODE>/_files.md                            这门课的全部文件清单
 *
 * manifest 里补：text, pdf, pages, visionPages, textSha1
 *   visionPages = 文字少于 200 字、或整页大图且文字少于 1200 字的页 —— 提取 agent 必须用眼睛看
 *
 *   node convert.mjs            # 增量
 *   node convert.mjs --force    # 全部重转
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, copyFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, extname, relative, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ROOT, DATA, SUPPORT, ensureDir, readJson } from './lib/session.mjs';
import { loadManifest, saveManifest } from './lib/files.mjs';
import { listCourses } from './lib/courses.mjs';

const force = process.argv.includes('--force');
const m = loadManifest();
const OFFICE = /\.(docx?|pptx?|xlsx?|rtf|odt|odp|ods)$/i;
const IMAGE = /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i;
const PLAIN = /\.(txt|csv|md|json|html?)$/i;
const MEDIA = /\.(mp4|m4v|mov|avi|mkv|wmv|webm|mp3|m4a|wav|aac|flac|ogg)$/i;

/** 流式算 sha256（老条目补齐；新下载的在 files.mjs 里已经算好） */
function fileSha256(abs) {
  const h = createHash('sha256');
  const fd = openSync(abs, 'r');
  const buf = Buffer.alloc(4 * 1024 * 1024);
  try { let n; while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { closeSync(fd); }
  return h.digest('hex');
}

/** ffprobe → 时长 / 分辨率 / 编码 */
function mediaInfo(abs) {
  const j = JSON.parse(run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', abs]));
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  return {
    duration: j.format?.duration ? Math.round(+j.format.duration) : null,
    width: v?.width || null, height: v?.height || null, vcodec: v?.codec_name || null, acodec: a?.codec_name || null,
    title: j.format?.tags?.title || null,
  };
}
const hms = (s) => (s == null ? '—' : `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);

const run = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'], ...opt });

function pdfPages(pdf) {
  let text = '';
  try { text = run('pdftotext', ['-layout', '-enc', 'UTF-8', pdf, '-']); } catch { return null; }
  const pages = text.split('\f');
  if (pages.length > 1 && !pages[pages.length - 1].trim()) pages.pop();
  // 每页大图面积（pdfimages -list：page num type width height …）
  const bigImage = new Set();
  try {
    for (const line of run('pdfimages', ['-list', pdf]).split('\n').slice(2)) {
      const c = line.trim().split(/\s+/);
      if (c.length > 4 && c[2] === 'image' && +c[3] * +c[4] >= 250000) bigImage.add(+c[0]);
    }
  } catch { /* 没有 pdfimages 也能跑 */ }
  const vision = [];
  pages.forEach((p, i) => {
    const n = p.replace(/\s+/g, '').length;
    if (n < 200 || (bigImage.has(i + 1) && n < 1200)) vision.push(i + 1);
  });
  return {
    body: pages.map((p, i) => `=== p.${i + 1} ===\n${p.replace(/[ \t]+$/gm, '').trim()}`).join('\n\n'),
    pages: pages.length, vision,
  };
}

const lo = join(SUPPORT, 'lo-profile');
function officeToPdf(src) {
  const out = mkdtempSync(join(tmpdir(), 'polyu-lo-'));
  try {
    run('soffice', [`-env:UserInstallation=${pathToFileURL(lo).href}`,  // 路径含空格，必须 URL 编码
      '--headless', '--convert-to', 'pdf', '--outdir', out, src]);
    const f = readdirSync(out).find((x) => x.endsWith('.pdf'));
    return f ? { tmp: out, pdf: join(out, f) } : { tmp: out, pdf: null };
  } catch { return { tmp: out, pdf: null }; }
}

let converted = 0;
let failed = 0;
let hashed = 0;
for (const f of Object.values(m.files)) {
  if (!f.path || f.skipped || f.dupOf) continue;
  const abs = join(ROOT, f.path);
  if (!existsSync(abs)) continue;
  if (!f.sha256) { try { f.sha256 = fileSha256(abs); hashed++; } catch { /* 读不了就下轮再算 */ } }
  const txtRel = f.path.replace(/^data\/files\//, 'data/text/') + '.txt';
  if (!force && f.textSha1 === f.sha1 && f.text && existsSync(join(ROOT, f.text))) continue;

  const ext = extname(f.path).toLowerCase();
  let res = null;
  delete f.pdf;
  try {
    if (ext === '.pdf') {
      res = pdfPages(abs);
    } else if (OFFICE.test(ext)) {
      const { tmp, pdf } = officeToPdf(abs);
      if (pdf) {
        const pdfRel = f.path.replace(/^data\/files\//, 'data/text/') + '.pdf';
        ensureDir(dirname(join(ROOT, pdfRel)));
        copyFileSync(pdf, join(ROOT, pdfRel));
        f.pdf = pdfRel;
        res = pdfPages(pdf);
      }
      rmSync(tmp, { recursive: true, force: true });
    } else if (IMAGE.test(ext)) {
      res = { body: '=== p.1 ===\n（图片，无文字层 —— 直接看原图）', pages: 1, vision: [1] };
    } else if (/^\.(zip|rar|7z|tar|gz|tgz)$/.test(ext)) {
      let listing;
      try { listing = run('bsdtar', ['-tvf', abs]); } catch { listing = run('tar', ['-tvf', abs]); }   // Windows 10+ 自带的 tar 就是 bsdtar
      res = { body: '=== 压缩包内容 ===\n' + listing, pages: 0, vision: [] };
    } else if (PLAIN.test(ext)) {
      res = { body: readFileSync(abs, 'utf8').slice(0, 500000), pages: 1, vision: [] };
    } else if (MEDIA.test(ext)) {
      f.media = mediaInfo(abs);
      const x = f.media;
      res = { body: `=== 媒体元数据 ===\n时长 ${hms(x.duration)} · ${x.width ? `${x.width}×${x.height} · ` : ''}视频 ${x.vcodec || '—'} · 音频 ${x.acodec || '—'}${x.title ? ` · 标题 ${x.title}` : ''}\n（没有字幕/转写；内容需要时再人工看）`, pages: 0, vision: [] };
    }
  } catch (e) {
    console.log(`   ✗ ${f.path} — ${String(e.message).slice(0, 80)}`);
  }
  if (!res) { f.text = null; f.pages = null; f.visionPages = null; delete f.textSha1; failed++; continue; }
  ensureDir(dirname(join(ROOT, txtRel)));
  writeFileSync(join(ROOT, txtRel), res.body);
  Object.assign(f, { text: txtRel, pages: res.pages, visionPages: res.vision, textSha1: f.sha1 });
  converted++;
  console.log(`   ✎ ${f.path}  (${res.pages} 页${res.vision.length ? `，需看图 ${res.vision.length} 页` : ''})`);
}
for (const f of Object.values(m.files)) {
  const twin = f.dupOf && m.files[f.dupOf];
  if (twin) Object.assign(f, { text: twin.text || null, pdf: twin.pdf, pages: twin.pages ?? null, visionPages: twin.visionPages || null, textSha1: twin.textSha1 });
}
saveManifest(m);

/* ── 每门课：平台数据 → Markdown ── */
const byKey = m.files;
const fileRef = (key) => {
  const f = byKey[key];
  if (!f) return '';
  if (f.skipped === 'link') return ` → 外链`;
  if (f.skipped) return ` → [${f.skipped}]`;
  return ` → \`${f.path}\``;
};
const linkLines = (links = []) => links.map((l) => `  - ${l.label || '(无文字)'} <${l.href}>${l.fileKey ? fileRef(l.fileKey) : ''}`).join('\n');
/** [1,2,3,5,7,8] → "1–3, 5, 7–8" */
const ranges = (xs) => {
  const out = [];
  for (let i = 0; i < xs.length; i++) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    out.push(i === j ? `${xs[i]}` : `${xs[i]}–${xs[j]}`);
    i = j;
  }
  return out.join(', ');
};
const block = (t) => (t ? t.split('\n').map((x) => `> ${x}`).join('\n') : '> （空）');

function canvasMd(r) {
  const out = [`# ${r.course.name}（Canvas）`, `抓取：${r.fetchedAt} · ${r.courseUrl}`, `学期：${r.course.term} · 教师：${(r.course.teachers || []).join('、')} · 按作业组加权：${r.course.apply_assignment_group_weights}`, ''];
  out.push('## Syllabus 页', block(r.course.syllabus), '');
  out.push('## 作业组与作业');
  for (const g of r.assignmentGroups || []) {
    out.push(`### 作业组「${g.name}」权重 ${g.weight}%`);
    for (const a of g.assignments) {
      out.push(`#### ${a.name}`, `- 截止 ${a.due || '无'} · 开放 ${a.unlock || '—'} · 关闭 ${a.lock || '—'} · 分值 ${a.points ?? '—'} · 提交 ${(a.submission || []).join('/')}${a.groupWork ? ' · 小组' : ''}${a.omitFromFinal ? ' · 不计入总分' : ''}`, `- ${a.url}`);
      if (a.lockExplanation) out.push(`- 锁定说明：${a.lockExplanation.replace(/<[^>]+>/g, '')}`);
      if (a.description) out.push(block(a.description));
      if (a.rubric) {
        out.push('', '| 评分项 | 分值 | 等级 |', '|---|---|---|');
        for (const c of a.rubric) out.push(`| ${c.criterion}${c.detail ? `：${c.detail}` : ''} | ${c.points} | ${c.ratings.map((x) => `${x.label}(${x.points})${x.detail ? `：${x.detail}` : ''}`).join('；')} |`);
      }
      out.push('');
    }
  }
  out.push('## 公告（全文）');
  for (const a of r.announcements || []) {
    out.push(`### ${a.title}`, `- 发布 ${a.posted || `定时 ${a.delayedUntil}`} · ${a.url}`, block(a.body));
    for (const x of a.attachments) out.push(`  - 附件：${x.name}${fileRef(x.fileKey)}`);
    out.push('');
  }
  out.push('## 模块');
  for (const mod of r.modules || []) {
    out.push(`### ${mod.name}${mod.unlockAt ? `（${mod.unlockAt} 开放）` : ''}${mod.prerequisites ? ' · 有先修模块要求' : ''}${mod.state && mod.state !== 'unlocked' && mod.state !== 'completed' ? ` · 状态 ${mod.state}` : ''}`);
    for (const i of mod.items) out.push(`- [${i.type}] ${i.title}${i.due ? ` · 截止 ${i.due}` : ''}${i.locked ? ' · 未开放' : ''}${i.type === 'File' ? fileRef(`canvas:${i.contentId}`) : ''}${i.externalUrl ? ` <${i.externalUrl}>` : ''}`);
  }
  out.push('', '## 页面（全文）');
  for (const p of r.pages || []) out.push(`### ${p.title}（模块：${p.folder}）`, `- 更新 ${p.updated} · ${p.url}`, block(p.body), '');
  if ((r.quizzes || []).length) { out.push('## 测验'); for (const q of r.quizzes) out.push(`- ${q.title} · 截止 ${q.due || '—'} · 开放 ${q.unlock || '—'} · 限时 ${q.timeLimit ?? '—'} · 次数 ${q.attempts ?? '—'} · 题数 ${q.questions ?? '—'} · 分值 ${q.points ?? '—'}${q.locked ? ' · 未开放' : ''} · ${q.url}`, block(q.description)); }
  if ((r.discussions || []).length) { out.push('## 讨论'); for (const d of r.discussions) out.push(`### ${d.title}`, block(d.message)); }
  out.push('', '## 日历');
  for (const e of r.calendar || []) out.push(`- ${e.start || '—'} ${e.title}（${e.type}${e.location ? ` @ ${e.location}` : ''}）`);
  if ((r.tabs || []).length) {
    out.push('', '## 导航 tabs（每个可见 tab 都用真实页面打开过一次）');
    for (const t of r.tabs) {
      out.push(`### ${t.label}（${t.type}${t.hidden ? ' · 隐藏' : ''}）：${t.status}`);
      // 内部 tab 的内容 API 已经有了；外部工具和异常状态才贴页面文字
      if (t.capture && (t.type === 'external' || t.status !== 'ok')) out.push(captureMd(t.capture));
    }
  }
  if ((r.toolLaunches || []).length) {
    out.push('', '## 模块里的外部工具（launch 一次）');
    for (const t of r.toolLaunches) out.push(`### ${t.title}（模块：${t.module}）：${t.status}`, captureMd(t.capture));
    if (r.toolLaunchesSkipped) out.push(`- 另有 ${r.toolLaunchesSkipped} 个外部工具本轮没打开（上限 ${15}）`);
  }
  if ((r.externalTools || []).length) out.push('', '## 课程外部工具配置', ...r.externalTools.map((t) => `- ${t.name}${t.domain ? ` · ${t.domain}` : ''}`));
  if (r.endpoints) {
    out.push('', '## 接口状态（空 = 访问过但没有内容；http-403/404 = 学生无权限或功能停用）');
    for (const [k, v] of Object.entries(r.endpoints)) out.push(`- ${k}: ${v.status}${v.count != null ? `（${v.count}）` : ''}`);
  }
  if (r.errors?.length) out.push('', '## 抓取失败的接口', ...r.errors.map((e) => `- ${e.label}: ${e.__status || e.__error}`));
  return out.join('\n');
}

/** 真实页面 capture → Markdown（状态、落点、可见文字） */
function captureMd(c) {
  if (!c) return '';
  const head = `- 状态 ${c.status}${c.finalUrl ? ` · 落点 ${c.finalUrl}` : ''}${c.title ? ` · 标题「${c.title}」` : ''}${c.views?.length ? ` · 已切换视图 ${c.views.join('、')}` : ''}${c.error ? ` · ${c.error}` : ''}`;
  const blank = (c.frames || []).filter((f) => !f.main && f.visible && f.status !== 'ok').map((f) => f.url);
  return [head, blank.length ? `- 空白 frame：${blank.join('、')}（不等于没有内容，下轮重试）` : '', c.text ? block(c.text) : ''].filter(Boolean).join('\n');
}

function bbMd(r) {
  const out = [`# ${r.course.name}（Blackboard ${r.course.courseId}）`, `抓取：${r.fetchedAt} · ${r.courseUrl}`, ''];
  if (r.course.description) out.push('## 课程简介', block(r.course.description), '');
  out.push('## 公告（全文，新→旧）');
  for (const a of [...(r.announcements || [])].sort((x, y) => String(y.created).localeCompare(String(x.created)))) {
    out.push(`### ${a.title}`, `- 发布 ${a.created}${a.modified !== a.created ? ` · 修改 ${a.modified}` : ''}`, block(a.body));
    if (a.links.length) out.push('- 链接：', linkLines(a.links));
    out.push('');
  }
  out.push('## 评分栏（Grade Center）');
  for (const g of r.gradebook || []) out.push(`- ${g.name} · 满分 ${g.possible ?? '—'} · 截止 ${g.due || '—'} · 类别 ${g.category || '—'} · ${g.type || ''}${g.description ? `\n${block(g.description)}` : ''}`);
  out.push('', '## 日历');
  for (const e of r.calendar || []) out.push(`- ${e.start} ${e.title}（${e.eventType || e.type}）`);
  if (r.crawl) {
    const fs = r.crawl.folders || [];
    const n = (s) => fs.filter((x) => x.status === s).length;
    out.push('', '## 抓取覆盖（API 内容树 + Classic HTML 逐层核对）',
      `- 文件夹 ${fs.length} 个：已访问 ${n('visited')} · 空 ${n('empty')} · 失败 ${fs.length - n('visited') - n('empty')}${r.crawl.unvisited?.length ? ` · 未访问 ${r.crawl.unvisited.length}` : ''}`,
      `- HTML 补到 API 没给的条目：${r.crawl.htmlOnly}`);
    for (const f of fs.filter((x) => !['visited', 'empty'].includes(x.status))) out.push(`  - ⚠ ${f.path}：${f.status}`);
  }
  out.push('', '## 内容树');
  for (const c of r.contents || []) {
    const depth = c.path.split(' / ').length;
    out.push(`${'#'.repeat(Math.min(depth + 2, 6))} ${c.title}`, `- 路径：${c.path} · 类型 ${c.handler}${c.modified ? ` · 修改 ${c.modified}` : ''}${c.source === 'html' ? ' · **只在 HTML 页面上出现（API 没给）**' : ''}`);
    if (c.description) out.push(block(c.description));
    if (c.body) out.push(block(c.body));
    if (c.detail && !/folder/.test(c.handler)) out.push('```json', JSON.stringify(c.detail).slice(0, 1500), '```');
    if (c.detailPage) out.push(`- 作业详情页（说明 + 截止/满分）：${c.detailPage.status}`, c.detailPage.text ? block(c.detailPage.text) : '');
    if (c.lti) out.push('- LTI 工具（launch 一次）：', captureMd(c.lti));
    for (const a of c.attachments) out.push(`  - 附件：${a.name}${fileRef(a.fileKey)}`);
    if (c.links.length) out.push('- 正文链接：', linkLines(c.links));
  }
  out.push('', '## 课程菜单（每一项都访问过）');
  for (const p of r.menu || []) {
    out.push(`### 菜单：${p.name}（${p.kind || '页面'} · ${p.status || 'ok'}）`, `- ${p.url}`);
    if (p.lti) out.push(captureMd(p.lti));
    else if (p.kind === 'groups') out.push(p.present ? '- 有内容（小组名单不抓）' : '- 空');
    else if (p.text) out.push(block(p.text));
    if (p.links?.length) out.push('- 页面上的文件/外链：', linkLines(p.links));
    out.push('');
  }
  if (r.errors?.length) out.push('', '## 抓取失败的接口', ...r.errors.map((e) => `- ${e.label}: ${e.__status || e.__error}`));
  return out.join('\n');
}

for (const c of listCourses()) {
  const dir = join(DATA, 'text', c.code);
  ensureDir(dir);
  for (const [name, render] of [['canvas', canvasMd], ['blackboard', bbMd]]) {
    const raw = readJson(join(DATA, 'raw', c.code, `${name}.json`), null);
    if (raw) writeFileSync(join(dir, `_${name}.md`), render(raw));
  }
  const files = Object.values(m.files).filter((f) => f.course === c.code)
    .sort((a, b) => `${a.folder}/${a.name}`.localeCompare(`${b.folder}/${b.name}`));
  const rows = files.map((f) => {
    const twin = f.dupOf && m.files[f.dupOf];
    if (twin) return `- **${f.name}** · ${f.platform} · 出处「${f.context}」\n  与「${twin.name}」内容相同 → \`${f.path}\``;
    const state = f.skipped === 'link' ? `外链 <${f.url}>${f.video ? `（视频：${f.video.platform}${f.video.id ? ` ${f.video.id}` : ''}，只记元数据）` : ''}`
      : f.skipped ? `[${f.skipped}]${f.lockInfo ? ` ${String(f.lockInfo).replace(/<[^>]+>/g, '')}` : ''}`
      : `\`${f.path}\`${f.media ? `（${hms(f.media.duration)}${f.media.width ? ` · ${f.media.width}×${f.media.height}` : ''}）` : ''}`;
    const txt = f.text ? ` · 文本 \`${f.text}\`${f.pdf ? ` · 转出PDF \`${f.pdf}\`` : ''} · ${f.pages} 页${f.visionPages?.length ? ` · **需看图页 ${ranges(f.visionPages)}**` : ''}` : '';
    return `- **${f.name}** · ${f.platform} · 文件夹「${f.folder || '—'}」 · 出处「${f.context}」\n  ${state}${txt}\n  首见 ${f.firstSeen?.slice(0, 10)} · 最近变更 ${f.lastChanged?.slice(0, 10) || '—'}`;
  });
  writeFileSync(join(dir, '_files.md'), `# ${c.code} 文件清单（${files.length}）\n\n${rows.join('\n')}\n`);
}
console.log(`\n✓ 转换 ${converted} 个文件${failed ? `，${failed} 个无法抽文字（仍可直接看原文件）` : ''}${hashed ? `，补算 sha256 ${hashed} 个` : ''}；平台数据已渲染到 data/text/<CODE>/_*.md`);
