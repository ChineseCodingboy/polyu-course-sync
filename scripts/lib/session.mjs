/**
 * 共享的浏览器会话与路径。
 *
 * 路径都在工作区 WORK 里（见 config.mjs）。登录态两层：
 *   profile/       Chromium 持久 profile —— 保留统一登录的持久 cookie、记住的用户名等
 *   cookies.json   每次运行结束时导出的全部 cookie（含会话级 cookie）
 * Chromium 关闭时会丢掉会话级 cookie（Blackboard 的 BbRouter、Canvas 的 canvas_session 都是），
 * 所以下次启动时要从 cookies.json 灌回去，否则刚登录完就"过期"。
 *
 * playwright 装在 WORK/node_modules（setup 负责），用到浏览器时才加载，
 * 所以 convert / build 这些不开浏览器的步骤不依赖它。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { WORK, SEMESTER } from './config.mjs';

export const ROOT = WORK;
export const DATA = join(ROOT, 'data');
export const SUPPORT = WORK;
export const PROFILE = join(SUPPORT, 'profile');
export const JAR = join(SUPPORT, 'cookies.json');

export const BB = 'https://learn.polyu.edu.hk';
export const CANVAS = 'https://canvas.polyu.edu.hk';
export const TERM = SEMESTER.bbTerm;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 浏览器用不了时直接以退出码 3 结束，并说清楚怎么办（编排者据此去跑 setup 或换到沙盒外运行） */
function fatal(msg, e) {
  console.error(`✗ ${msg}${e ? `\n   （${String(e.message || e).split('\n')[0].slice(0, 200)}）` : ''}`);
  process.exit(3);
}

function chromium() {
  try {
    return createRequire(join(WORK, 'package.json'))('playwright').chromium;
  } catch (e) {
    return fatal('工作区里还没装 playwright：先运行 node <skill 目录>/scripts/setup.mjs', e);
  }
}

export async function openContext({ headless = true } = {}) {
  mkdirSync(PROFILE, { recursive: true });
  let ctx;
  try {
    ctx = await chromium().launchPersistentContext(PROFILE, {
      headless,
      viewport: { width: 1400, height: 900 },
      locale: 'en-HK',
      acceptDownloads: true,
      args: headless ? [] : ['--window-size=1440,960'],
    });
  } catch (e) {
    fatal('浏览器启动失败：先运行 setup 补装 Chromium；在 Codex 里多半是沙盒拦住了，让它在沙盒外运行这条命令（需要你批准）', e);
  }
  if (existsSync(JAR)) {
    try {
      const now = Date.now() / 1000;
      const jar = JSON.parse(readFileSync(JAR, 'utf8')).filter((c) => c.expires === -1 || c.expires > now);
      if (jar.length) await ctx.addCookies(jar);
    } catch { /* 坏掉的 jar 当作没有 */ }
  }
  return ctx;
}

export async function saveCookies(ctx) {
  const cookies = await ctx.cookies();
  writeFileSync(JAR, JSON.stringify(cookies));
  chmodSync(JAR, 0o600);
}

const firstLine = (e) => String(e?.message || e).split('\n')[0].slice(0, 160);

/**
 * GET，网络层错误（DNS、断连、超时）和 429/5xx 退避重试 3 次；4xx 立即返回。
 * 返回 Playwright APIResponse；重试用尽时抛出最后一个错误。
 */
export async function requestWithRetry(ctx, url, opts = {}, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(2000 * 2 ** (i - 1));
    try {
      const r = await ctx.request.get(url, opts);
      if (r.status() === 429 || r.status() >= 500) { last = new Error(`HTTP ${r.status()}`); continue; }
      return r;
    } catch (e) { last = e; }
  }
  throw new Error(firstLine(last));
}

/**
 * 顺序 GET + 固定间隔，避免端口耗尽（EADDRNOTAVAIL）。
 * 失败不抛：返回 { __status, __body } 或 { __error }，调用方用 isErr() 判断。
 */
export function makeApi(ctx, host, { gap = 350 } = {}) {
  const parse = (t) => JSON.parse(t.replace(/^while\(1\);/, ''));
  const opts = { headers: { Accept: 'application/json' }, timeout: 30000, maxRedirects: 0 };
  const get = async (path) => {
    await sleep(gap);
    try {
      const r = await requestWithRetry(ctx, path.startsWith('http') ? path : host + path, opts);
      const t = await r.text();
      if (!r.ok()) return { __status: r.status(), __body: t.slice(0, 200), __path: path };
      return parse(t);
    } catch (e) { return { __error: firstLine(e), __path: path }; }
  };
  /** Canvas 分页：跟着 Link: rel="next" 走，最多 20 页；中途失败整体算失败（不交半截数据） */
  const getAll = async (path) => {
    const out = [];
    let url = host + path;
    for (let i = 0; url && i < 20; i++) {
      await sleep(gap);
      try {
        const r = await requestWithRetry(ctx, url, opts);
        const t = await r.text();
        if (!r.ok()) return { __status: r.status(), __body: t.slice(0, 200), __path: path, __page: i };
        const page = parse(t);
        if (!Array.isArray(page)) return page;
        out.push(...page);
        const link = r.headers()['link'] || '';
        url = (link.split(',').find((s) => /rel="next"/.test(s)) || '').match(/<([^>]+)>/)?.[1] || null;
      } catch (e) { return { __error: firstLine(e), __path: path, __page: i }; }
    }
    return out;
  };
  return { get, getAll };
}

export const isErr = (v) => !v || (typeof v === 'object' && !Array.isArray(v) && ('__status' in v || '__error' in v));

export async function checkAuth(ctx) {
  const bb = makeApi(ctx, BB, { gap: 0 });
  const cv = makeApi(ctx, CANVAS, { gap: 0 });
  const [me, self] = await Promise.all([
    bb.get('/learn/api/public/v1/users/me'),
    cv.get('/api/v1/users/self'),
  ]);
  const at = new Date().toISOString();
  return {
    blackboard: { ok: !isErr(me) && !!me.id, checkedAt: at, userId: isErr(me) ? null : me.id },
    canvas: { ok: !isErr(self) && !!self.id, checkedAt: at },
  };
}

/* ── sync-status.json：各步骤各写各的字段，合并保存 ── */
const STATUS = join(DATA, 'sync-status.json');
export function readStatus() {
  try { return JSON.parse(readFileSync(STATUS, 'utf8')); } catch { return {}; }
}
export function writeStatus(patch) {
  const s = { ...readStatus(), ...patch, updatedAt: new Date().toISOString() };
  mkdirSync(DATA, { recursive: true });
  writeFileSync(STATUS, JSON.stringify(s, null, 2));
  return s;
}

/* ── 小工具 ── */
export const decode = (s) => String(s || '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');

/** HTML → 纯文本；链接保留成「文字 <URL>」，给提取 agent 看 */
export const htmlText = (v) => decode(String(v || '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => {
    const label = t.replace(/<[^>]+>/g, '').trim();
    return /^(#|javascript:)/.test(href) ? label : `${label} <${href}>`;
  })
  .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
  .replace(/<li[^>]*>/gi, '• ')
  .replace(/<\/t[dh]>/gi, ' | ')
  .replace(/<[^>]+>/g, ' '))
  .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();

export const stripHtml = (v) => htmlText(v).replace(/ <[^>]+>/g, '');

export const safeName = (s, n = 90) => String(s || '')
  .replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, n) || '_';

export const ensureDir = (p) => { mkdirSync(p, { recursive: true }); return p; };
export const readJson = (p, dflt) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return dflt; } };
export const writeJson = (p, v) => { ensureDir(dirname(p)); writeFileSync(p, JSON.stringify(v, null, 2)); };
