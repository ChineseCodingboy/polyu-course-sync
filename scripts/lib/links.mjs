/**
 * 正文、公告里的链接：分成「平台内文件」「可下载的外部文件」「普通外链」。
 * 外部文件尽量下载（Google Drive / Docs / Slides、OneDrive / SharePoint），
 * 下不了或是协作表格（Google Sheets —— 常是分组名单）就只登记成外链。
 */
import { createHash } from 'node:crypto';
import { decode } from './session.mjs';

export function extractLinks(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const attrs = m[1];
    const href = decode((attrs.match(/href="([^"]*)"/i) || [])[1] || '').trim();
    if (!href || /^(#|javascript:|mailto:)/i.test(href) || seen.has(href)) continue;
    seen.add(href);
    let label = decode(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const bbfile = (attrs.match(/data-bbfile="([^"]*)"/i) || [])[1];
    if (bbfile) {
      try { label = JSON.parse(decode(bbfile)).linkName || label; } catch { /* 保持原文字 */ }
    }
    out.push({ href, label });
  }
  // Ultra rawText 里的占位写法：@X@EmbeddedFile.requestUrlStub@X@bbcswebdav/xid-123_1
  for (const x of String(html || '').matchAll(/@X@EmbeddedFile\.requestUrlStub@X@(bbcswebdav\/[^"'\s<>]+)/g)) {
    const href = '/' + x[1];
    if (!seen.has(href)) { seen.add(href); out.push({ href, label: '' }); }
  }
  // 图片也算（有老师把评分表截图贴在正文里）
  for (const x of String(html || '').matchAll(/<img\b[^>]*src="([^"]+)"[^>]*>/gi)) {
    const href = decode(x[1]);
    if (/bbcswebdav|\/files\/\d+/.test(href) && !seen.has(href)) { seen.add(href); out.push({ href, label: '正文图片', image: true }); }
  }
  return out;
}

const short = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

/** 外部链接 → { key, download, name } 或 null（只登记） */
export function externalDownload(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  const h = u.hostname;
  if (h === 'drive.google.com') {
    const id = (u.pathname.match(/\/file\/d\/([\w-]+)/) || [])[1] || u.searchParams.get('id');
    if (id) return { key: `gdrive:${id}`, download: `https://drive.google.com/uc?export=download&id=${id}`, name: null };
  }
  if (h === 'docs.google.com') {
    const m = u.pathname.match(/^\/(document|presentation)\/d\/([\w-]+)/);
    if (m) return { key: `gdocs:${m[2]}`, download: `https://docs.google.com/${m[1]}/d/${m[2]}/export?format=pdf`, name: null, ext: '.pdf' };
    return null; // spreadsheets / forms：只登记
  }
  if (/(^|\.)sharepoint\.com$/.test(h) || h === '1drv.ms' || h === 'onedrive.live.com') {
    const dl = new URL(href);
    dl.searchParams.set('download', '1');
    return { key: `ms:${short(href)}`, download: dl.toString(), name: null };
  }
  if (/\.(pdf|docx?|pptx?|xlsx?|zip|png|jpe?g)$/i.test(u.pathname)) {
    return { key: `url:${short(href)}`, download: href, name: decodeURIComponent(u.pathname.split('/').pop()) };
  }
  return null;
}

/** 从 content-disposition 取文件名 */
export function dispositionName(headers) {
  const cd = headers['content-disposition'] || '';
  const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1].replace(/"/g, '')); } catch { /* fallthrough */ } }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : null;
}
