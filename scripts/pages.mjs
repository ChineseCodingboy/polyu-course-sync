#!/usr/bin/env node
/**
 * 把 PDF 的某几页渲染成 PNG，用来看图核对表格、扫描页和图片。
 * 在 Codex 里要先渲染、再用看图工具（view_image）看；Claude Code 的 Read 能直接看 PDF，
 * 但偶尔会卡住，也可以先渲染。
 *
 *   node pages.mjs <文件> <页码> [--dpi=110]
 *     文件：绝对路径，或相对工作区的 data/files/… / data/text/… 路径
 *     页码：3、1-3、2,5,7-9
 *     Word / PPT 自动改用 convert 转出的 PDF；图片直接返回原路径
 *
 * 输出每一页 PNG 的路径（在系统临时目录的 polyu-pages/ 里）。需要 Poppler 的 pdftoppm。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, isAbsolute, resolve, relative, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { WORK } from './lib/config.mjs';
import { loadManifest } from './lib/files.mjs';

const args = process.argv.slice(2);
const dpi = Number((args.find((a) => a.startsWith('--dpi=')) || '').split('=')[1] || 110);
const [fileArg, pagesArg] = args.filter((a) => !a.startsWith('--'));
if (!fileArg || !pagesArg) { console.error('用法：node pages.mjs <文件> <页码，如 3 或 1-3 或 2,5,7-9> [--dpi=110]'); process.exit(64); }

let abs = isAbsolute(fileArg) ? fileArg : existsSync(resolve(fileArg)) ? resolve(fileArg) : join(WORK, fileArg);
if (!existsSync(abs)) { console.error(`✗ 找不到文件：${abs}`); process.exit(1); }
const ext = extname(abs).toLowerCase();

if (/^\.(png|jpe?g|gif|webp|bmp|tiff?)$/.test(ext)) { console.log(abs); process.exit(0); }   // 图片：直接看原图

if (ext !== '.pdf') {
  // Office 文件：用 convert 转出的 PDF
  const rel = relative(WORK, abs).split('\\').join('/');
  const f = Object.values(loadManifest().files).find((x) => x.path === rel);
  const pdf = f?.pdf ? join(WORK, f.pdf) : join(WORK, rel.replace(/^data\/files\//, 'data/text/') + '.pdf');
  if (!existsSync(pdf)) { console.error(`✗ ${rel} 还没有转出 PDF（先跑 convert；没装 LibreOffice 的话只能打开原文件看）`); process.exit(1); }
  abs = pdf;
}

const pages = [];
for (const part of String(pagesArg).split(',')) {
  const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
  if (!m) { console.error(`✗ 看不懂页码：${part}`); process.exit(64); }
  for (let p = +m[1]; p <= +(m[2] || m[1]); p++) pages.push(p);
}
if (pages.length > 40) { console.error('✗ 一次最多渲染 40 页'); process.exit(64); }

const out = join(tmpdir(), 'polyu-pages');
mkdirSync(out, { recursive: true });
const tag = createHash('sha1').update(abs).digest('hex').slice(0, 10);
let failed = 0;
for (const p of pages) {
  const base = join(out, `${tag}-p${p}`);
  const r = spawnSync('pdftoppm', ['-r', String(dpi), '-f', String(p), '-l', String(p), '-singlefile', '-png', abs, base], { encoding: 'utf8' });
  if (r.error?.code === 'ENOENT') { console.error('✗ 没有 pdftoppm：先装 Poppler（setup.mjs 会给出安装命令）'); process.exit(1); }
  if (r.status !== 0 || !existsSync(`${base}.png`)) { console.error(`✗ 第 ${p} 页渲染失败：${(r.stderr || '').trim().split('\n')[0] || '页码超出范围？'}`); failed++; continue; }
  console.log(`${base}.png`);
}
process.exit(failed ? 1 : 0);
