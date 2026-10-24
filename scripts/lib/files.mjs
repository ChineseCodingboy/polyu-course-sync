/**
 * 统一文件库：data/files/<CODE>/<文件夹>/<文件名> + data/manifest.json
 *
 * manifest.files[key]：
 *   key            平台内稳定标识（canvas:<fileId> / bb:<attachmentId> / bbdav:<xid> / gdrive:<id> / link:<hash> …）
 *                  —— 稳定身份用平台 ID / 原始路径 + 哈希，签名 CDN URL 永远不当主键
 *   course, platform, name, folder, context, path（相对项目根）, url（原页面或原链接）
 *   mime, size, sha1, sha256, sourceUpdatedAt, remoteTag（ETag|Last-Modified|长度）
 *   firstSeen, lastChanged, lastSeen      —— 用于「新」标记与增量提取
 *   transfer       本轮传输终态：downloaded / unchanged / locked / link / too-large / failed
 *   lastAttemptAt  最近一次尝试时间；lastError 最近一次失败原因
 *   skipped        null | 'locked' | 'too-large' | 'link' | 'media'（视频音频默认不下载，只登记）| 'failed:<原因>'
 *   video          视频外链的平台与 ID（YouTube / Panopto / Zoom 录制 / HLS），只记元数据，不下第三方视频
 *   dupOf          同课内容相同的另一条目 key（共用它的 path，不重复存盘）
 *   text, pages, visionPages, textSha1, media    —— 由 convert.mjs 填
 *
 * 下载：
 *   - 小文件走浏览器上下文的 request（cookie 与重定向和浏览器一致）
 *   - 视频、音频默认不下载，只登记名字、出处和平台链接（config.downloadMedia=true 或 POLYU_DOWNLOAD_MEDIA=1 时才下）
 *   - 已知超过 64MB 的文件走流式：每一跳只带该域自己的 cookie（凭证不转发给 CDN），
 *     边下边算哈希，写 .part，校验长度后原子改名
 *   - 返回 HTML 的一律当失败（多半是登录页），不会把登录页存成 PDF
 */
import { existsSync, writeFileSync, renameSync, rmSync, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname, relative, dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ROOT, DATA, safeName, ensureDir, readJson, writeJson, requestWithRetry } from './session.mjs';
import { config } from './config.mjs';
import { dispositionName } from './links.mjs';

export const MANIFEST = join(DATA, 'manifest.json');
const MAX_BYTES = 2 * 1024 * 1024 * 1024;     // 单个文件上限 2GB
const STREAM_OVER = 64 * 1024 * 1024;         // 已知超过 64MB 就流式下载
const SKIP_MEDIA = !(config.downloadMedia === true || process.env.POLYU_DOWNLOAD_MEDIA === '1');   // 视频体积大，默认只登记不下载
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MEDIA_EXT = /\.(mp4|m4v|mov|avi|mkv|wmv|webm|mp3|m4a|wav|aac|flac|ogg)$/i;
const MIME_EXT = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/msword': '.doc', 'application/vnd.ms-powerpoint': '.ppt', 'application/vnd.ms-excel': '.xls',
  'image/png': '.png', 'image/jpeg': '.jpg', 'application/zip': '.zip', 'text/plain': '.txt',
  'video/mp4': '.mp4', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
};

export function loadManifest() {
  const m = readJson(MANIFEST, null) || { files: {} };
  m.files ||= {};
  return m;
}
export function saveManifest(m) {
  m.updatedAt = new Date().toISOString();
  writeJson(MANIFEST, m);
}
export const newStats = () => ({ downloaded: 0, unchanged: 0, skipped: 0, failed: 0, links: 0, bytes: 0 });

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const remoteTag = (h) => (h.etag || h['last-modified'] ? `${h.etag || ''}|${h['last-modified'] || ''}|${h['content-length'] || ''}` : null);

/** 链接文字当文件名时常缺扩展名：按 content-disposition / MIME 补上 */
function withExt(name, dispName, mime) {
  if (!name || extname(name).length > 1 && extname(name).length <= 6) return name;
  const ext = (dispName && extname(dispName)) || MIME_EXT[mime] || '';
  return ext ? name + ext : name;
}

function uniquePath(m, key, course, folder, name) {
  const dir = join(DATA, 'files', course, ...String(folder || '').split('/').filter(Boolean).map((s) => safeName(s, 60)));
  let base = safeName(name, 120);
  let abs = join(dir, base);
  const taken = (p) => Object.values(m.files).some((f) => f.key !== key && f.path === relative(ROOT, p));
  if (taken(abs)) {
    const ext = extname(base);
    base = `${base.slice(0, base.length - ext.length)} (${key.split(':').pop().slice(-8)})${ext}`;
    abs = join(dir, base);
  }
  return abs;
}

/** uniquePath 遇到重名时加的后缀「 (key 末 8 位)」去掉后的路径 */
const dedupSuffixless = (p, key) => String(p).split(` (${String(key).split(':').pop().slice(-8)})`).join('');

/** 文件搬家时记下旧路径（最多 5 个），出处里的旧路径还能对上现在的文件 */
function rememberOldPath(entry, old) {
  if (!old || old === entry.path) return;
  entry.prevPaths = [...new Set([...(entry.prevPaths || []), old])].slice(-5);
}

/** 路径 → manifest 条目：现在的路径、文本层路径，以及搬家前的旧路径 */
export function pathIndex(m) {
  const map = new Map();
  for (const f of Object.values(m.files)) for (const p of f.prevPaths || []) map.set(p, f);
  for (const f of Object.values(m.files)) { if (f.path) map.set(f.path, f); if (f.text) map.set(f.text, f); }
  return map;
}

function baseEntry(m, f) {
  const now = new Date().toISOString();
  const prev = m.files[f.key];
  const entry = {
    ...(prev || {}),
    key: f.key, course: f.course, platform: f.platform,
    name: f.name || prev?.name || null, folder: f.folder || '', context: f.context || prev?.context || '',
    url: f.url || prev?.url || null,
    mime: f.mime || prev?.mime || null,
    size: f.size ?? prev?.size ?? null,
    sourceUpdatedAt: f.sourceUpdatedAt || prev?.sourceUpdatedAt || null,
    firstSeen: prev?.firstSeen || now,
    lastSeen: now,
    lastAttemptAt: now,
  };
  m.files[f.key] = entry;
  return { entry, prev, now };
}

/** 视频外链：只记平台和 ID（不下第三方视频） */
function videoOf(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const h = u.hostname.replace(/^www\./, '');
  if (h === 'youtube.com' || h === 'm.youtube.com') return u.searchParams.get('v') ? { platform: 'youtube', id: u.searchParams.get('v') } : null;
  if (h === 'youtu.be') return { platform: 'youtube', id: u.pathname.slice(1) };
  if (/panopto\.(com|eu)$/.test(h)) return { platform: 'panopto', id: u.searchParams.get('id') || null };
  if (/(^|\.)zoom\.us$/.test(h) && /\/rec\//.test(u.pathname)) return { platform: 'zoom-recording', id: null };
  if (/\.m3u8$/i.test(u.pathname)) return { platform: 'hls', id: null };
  return null;
}

/** 只登记、不下载的链接（Google Sheets、Panopto、普通网页…） */
export function registerLink(m, f, stats) {
  const { entry, prev, now } = baseEntry(m, f);
  entry.skipped = 'link';
  entry.transfer = 'link';
  const v = videoOf(f.url);
  if (v) entry.video = v;
  if (!prev) entry.lastChanged = now;
  stats.links++;
  return entry;
}

/**
 * 流式下载：手动跟重定向，每一跳只带该 URL 自己域名下的 cookie（与浏览器的 cookie 作用域一致），
 * 边下边算 sha1/sha256，写 .part；长度对不上或返回网页就丢弃。
 */
export async function streamDownload(ctx, url, partPath) {
  let cur = url;
  let res;
  for (let hop = 0; hop < 10; hop++) {
    const cookies = await ctx.cookies(cur);
    const headers = { 'User-Agent': UA, Accept: '*/*' };
    if (cookies.length) headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    res = await fetch(cur, { redirect: 'manual', headers, signal: AbortSignal.timeout(60 * 60 * 1000) });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { await res.body?.cancel(); cur = new URL(loc, cur).href; continue; }
    break;
  }
  if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
  const headers = Object.fromEntries(res.headers);
  const ct = (headers['content-type'] || '').split(';')[0].trim();
  if (/text\/html/.test(ct)) { await res.body?.cancel(); throw new Error('返回的是网页（需要登录或无权限）'); }
  const len = Number(headers['content-length']) || null;
  if (len && len > MAX_BYTES) { await res.body?.cancel(); return { tooLarge: true, len, headers, ct }; }
  ensureDir(dirname(partPath));
  const h1 = createHash('sha1');
  const h256 = createHash('sha256');
  let size = 0;
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_BYTES) { cb(new Error('超过 2GB 上限')); return; }
      h1.update(chunk); h256.update(chunk); cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), tap, createWriteStream(partPath));
  } catch (e) { rmSync(partPath, { force: true }); throw e; }
  // 服务器压缩传输时 content-length 是压缩后的长度，fetch 已解压，不能直接比
  if (len && size !== len && !headers['content-encoding']) { rmSync(partPath, { force: true }); throw new Error(`长度不符（${size}/${len}）`); }
  return { size, sha1: h1.digest('hex'), sha256: h256.digest('hex'), headers, ct, finalHost: new URL(cur).host };
}

/**
 * 登记并（必要时）下载一个文件。
 * f: { key, course, platform, name?, folder, context, url, download, mime, size, sourceUpdatedAt,
 *      locked?, lockInfo?, external? }
 * name 为空时从 content-disposition / URL 推断。external=true 时下载失败降级为「只登记」。
 */
export async function registerFile(ctx, m, f, stats) {
  const { entry, prev, now } = baseEntry(m, f);
  const nameHint = f.name || prev?.name || '';
  const isMedia = MEDIA_EXT.test(nameHint) || /^(video|audio)\//.test(f.mime || '');

  if (isMedia && SKIP_MEDIA) { entry.skipped = 'media'; entry.transfer = 'skipped-media'; stats.skipped++; return entry; }
  if (f.size && f.size > MAX_BYTES) { entry.skipped = 'too-large'; entry.transfer = 'too-large'; stats.skipped++; return entry; }

  const have = prev?.path && !prev.skipped && existsSync(join(ROOT, prev.path));
  if (f.locked) {
    // 老师设了定时开放：先登记，开放后下一轮自动下载
    entry.lockInfo = f.lockInfo || null;
    if (!have) { entry.skipped = 'locked'; entry.transfer = 'locked'; stats.skipped++; return entry; }
    entry.transfer = 'unchanged'; stats.unchanged++; return entry;
  }
  delete entry.lockInfo;

  // 平台给了版本时间且没变 → 不重下
  if (have && f.sourceUpdatedAt && f.sourceUpdatedAt === prev.sourceUpdatedAt) {
    entry.transfer = 'unchanged';
    if (prev.dupOf) { stats.unchanged++; return entry; }
    entry.name = withExt(entry.name, null, entry.mime);
    const want = uniquePath(m, f.key, f.course, f.folder, entry.name);
    const rel = relative(ROOT, want);
    // 课程里挪了文件夹或改了名：跟着搬，并记下旧路径（提取 agent 写的出处可能还指着旧路径，build 会认）。
    // 只是同名去重后缀「 (xxxxxxxx)」加上或去掉了，不搬：来回改名会让出处路径失效。
    if (rel !== prev.path && dedupSuffixless(rel, f.key) !== dedupSuffixless(prev.path, f.key) && !existsSync(want)) {
      ensureDir(join(want, '..'));
      renameSync(join(ROOT, prev.path), want);
      rememberOldPath(entry, prev.path);
      entry.path = rel;
    }
    stats.unchanged++; return entry;
  }

  // 没有版本时间的（Blackboard 正文链接、外部文件）→ 先 HEAD 比 ETag/Last-Modified，没变就不重下
  if (have && !f.sourceUpdatedAt && prev.remoteTag) {
    try {
      const h = await ctx.request.head(f.download, { timeout: 30000 });
      if (h.ok() && remoteTag(h.headers()) === prev.remoteTag) { entry.transfer = 'unchanged'; stats.unchanged++; return entry; }
    } catch { /* HEAD 不支持就照常 GET */ }
  }

  try {
    let got;   // { part?, buf?, size, sha1, sha256, headers, ct }
    if (isMedia || (f.size && f.size > STREAM_OVER)) {
      const part = join(DATA, 'files', '.partial', `${createHash('sha1').update(f.key).digest('hex').slice(0, 16)}.part`);
      got = await streamDownload(ctx, f.download, part);
      if (got.tooLarge) { entry.skipped = 'too-large'; entry.transfer = 'too-large'; entry.size = got.len; stats.skipped++; return entry; }
      got.part = part;
    } else {
      const r = await requestWithRetry(ctx, f.download, { timeout: 900000 }, 3);
      if (!r.ok()) throw new Error(`HTTP ${r.status()}`);
      const headers = r.headers();
      const ct = (headers['content-type'] || '').split(';')[0].trim();
      if (/text\/html/.test(ct) && !/\.html?$/i.test(nameHint)) throw new Error('返回的是网页（需要登录或无权限）');
      if (SKIP_MEDIA && /^(video|audio)\//.test(ct)) { entry.skipped = 'media'; entry.transfer = 'skipped-media'; entry.mime = ct; stats.skipped++; return entry; }
      const buf = await r.body();
      if (buf.length > MAX_BYTES) { entry.skipped = 'too-large'; entry.transfer = 'too-large'; stats.skipped++; return entry; }
      got = { buf, size: buf.length, sha1: sha1(buf), sha256: sha256(buf), headers, ct, finalHost: new URL(r.url()).host };
    }

    entry.remoteTag = remoteTag(got.headers);
    entry.finalHost = got.finalHost;
    const disp = dispositionName(got.headers);
    if (!entry.name) entry.name = disp || decodeURIComponent(new URL(f.download).pathname.split('/').pop() || '') || f.key;
    entry.name = withExt(entry.name, disp, got.ct);

    const hash = got.sha1;
    // 同一门课里同一份内容（附件 + 正文链接各引用一次）只存一份
    const twin = Object.values(m.files).find((x) => x.key !== f.key && x.course === f.course && x.sha1 === hash && x.path && !x.dupOf && !x.skipped);
    if (twin) {
      if (got.part) rmSync(got.part, { force: true });
      if (have && prev.path !== twin.path && existsSync(join(ROOT, prev.path))) rmSync(join(ROOT, prev.path));
      Object.assign(entry, { path: twin.path, size: got.size, mime: got.ct || entry.mime, skipped: null, dupOf: twin.key, sha1: hash, sha256: got.sha256, transfer: 'unchanged' });
      if (hash !== prev?.sha1) entry.lastChanged = now;
      stats.unchanged++;
      return entry;
    }
    delete entry.dupOf;

    let abs = have ? join(ROOT, prev.path) : uniquePath(m, f.key, f.course, f.folder, entry.name);
    if (have && !extname(abs) && extname(entry.name)) {   // 旧版本缺扩展名 → 迁到新名字
      const next = uniquePath(m, f.key, f.course, f.folder, entry.name);
      rmSync(abs);
      rememberOldPath(entry, prev.path);
      abs = next;
    }
    if (hash !== prev?.sha1 || !existsSync(abs)) {
      ensureDir(join(abs, '..'));
      if (got.part) renameSync(got.part, abs);
      else { writeFileSync(abs + '.part', got.buf); renameSync(abs + '.part', abs); }   // 原子改名
    } else if (got.part) rmSync(got.part, { force: true });
    entry.path = relative(ROOT, abs);
    entry.size = got.size;
    entry.mime = got.ct || entry.mime;
    entry.sha256 = got.sha256;
    entry.skipped = null;
    delete entry.lastError;
    if (hash !== prev?.sha1) {
      entry.sha1 = hash;
      entry.lastChanged = now;
      entry.transfer = 'downloaded';
      stats.downloaded++;
      stats.bytes += got.size;
      console.log(`   ↓ ${entry.path}${got.size > STREAM_OVER ? `（${(got.size / 1048576).toFixed(0)} MB）` : ''}`);
    } else {
      entry.transfer = 'unchanged';
      stats.unchanged++;
    }
  } catch (e) {
    const why = String(e.message || e).split('\n')[0].slice(0, 80);
    entry.lastError = why;
    if (have) { entry.transfer = 'unchanged'; stats.unchanged++; return entry; }   // 旧版本还在，保留
    if (f.external) { entry.skipped = 'link'; entry.transfer = 'link'; stats.links++; return entry; }
    entry.name ||= f.key;
    entry.skipped = `failed:${why}`;
    entry.transfer = 'failed';
    stats.failed++;
    console.log(`   ✗ ${entry.name} — ${why}`);
  }
  return entry;
}
