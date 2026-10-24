/**
 * 用真实页面打开一次，记录看得到的内容。
 *
 * 用途：API 和导出覆盖不到的地方。比如 LTI 工具（Zoom、Panopto、Resource List/Leganto、Turnitin），
 * Canvas 导航页，以及嵌入式预览。原则来自 full-capture 方法论（references/methodology.md）：每个入口都要「打开过、
 * 看过、记录结果」；空白 frame 不等于没有内容。
 *
 * 只读：
 * - 不提交、不填表；
 * - 只在白名单里的视图切换上点一下，比如 Zoom 的 Previous Meetings / Cloud Recordings；
 * - URL 只保留 origin + path，不落盘查询串，因为 LTI 常带 id_token 或 OAuth state。
 *
 * status 取值：
 *   ok              工具页或可见 iframe 里有正文
 *   blank_frame     页面里有可见 iframe，但全部空白 —— 不等于没有内容，下一轮重试
 *   empty           页面打开了，但没有任何正文
 *   login_required  跳到了登录页
 *   error           打不开或超时
 */
import { sleep } from './session.mjs';

export const stripUrl = (u) => {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) ? x.origin + x.pathname : `${x.protocol}${x.pathname}`;
  } catch { return String(u || '').split('?')[0]; }
};
const LOGIN = /adfs\.polyu\.edu\.hk|login\.microsoftonline\.com|\/webapps\/login\/|\/login\/(canvas|saml)/i;
const PLATFORM = /^https:\/\/(learn|canvas)\.polyu\.edu\.hk\//;
const firstLine = (e) => String(e?.message || e).split('\n')[0].slice(0, 160);

// 只读的视图切换（会议列表 / 录制列表）
const VIEW_TABS = [/^\s*Previous Meetings\s*$/i, /^\s*Cloud Recordings\s*$/i];
// 默认折叠的列表：只点展开开关（aria-expanded=false），不碰 cookie 弹窗和其它按钮
// （Leganto 的分组标题外层和内层各有一个 header，同时点两下会先开后关，所以每点一次都重新查）
const EXPANDERS = [{ frame: /alma\.exlibrisgroup\.com\/leganto\//, selector: 'mat-expansion-panel-header[aria-expanded="false"]' }];

const tidy = (t) => String(t || '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

async function frameText(f) {
  try { return tidy(await f.evaluate(() => (document.body ? document.body.innerText : ''))); } catch { return null; }
}

/**
 * @param {import('playwright').BrowserContext} ctx
 * @param {string} url
 * @param {{ settleMs?: number, maxText?: number, views?: boolean }} opts
 */
export async function capturePage(ctx, url, { settleMs = 4000, maxText = 20000, views = true } = {}) {
  const page = await ctx.newPage();
  const out = { url: stripUrl(url), at: new Date().toISOString() };
  const hops = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) hops.push(stripUrl(f.url())); });
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    out.httpStatus = resp ? resp.status() : null;
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await sleep(settleMs);
    for (const ex of EXPANDERS) {
      for (const f of page.frames().filter((x) => ex.frame.test(x.url()))) {
        // 在页面里直接触发 click（外层 header 被内层盖住，Playwright 的可点击检查过不去）；
        // 同一个分组按标题文字去重，只点一次
        const n = await f.evaluate(async (sel) => {
          const seen = new Set();
          let clicked = 0;
          for (let round = 0; round < 3; round++) {
            for (const h of document.querySelectorAll(sel)) {
              const key = (h.innerText || '').split('\n')[0].trim();
              if (seen.has(key)) continue;
              seen.add(key);
              h.click();
              clicked++;
              await new Promise((r) => setTimeout(r, 800));
            }
          }
          return clicked;
        }, ex.selector).catch(() => 0);
        if (n) { out.expanded = (out.expanded || 0) + n; await sleep(2500); }
      }
    }
    // 懒加载列表（Leganto 书目、Panopto 文件夹…）：每个 frame 滚到底几次再读
    for (let i = 0; i < 4; i++) {
      for (const f of page.frames()) {
        await f.evaluate(() => {
          const els = [document.scrollingElement, ...document.querySelectorAll('[class*="scroll"], main, [role="main"]')].filter(Boolean);
          for (const el of els) el.scrollTop = el.scrollHeight;
          window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
        }).catch(() => {});
      }
      await sleep(1200);
    }
    out.finalUrl = stripUrl(page.url());
    out.redirects = [...new Set(hops)].filter((h) => h && h !== out.finalUrl && h !== 'about:blank').slice(0, 10);
    out.title = (await page.title().catch(() => '')) || '';
    if (LOGIN.test(page.url())) { out.status = 'login_required'; return out; }

    out.frames = [];
    for (const f of page.frames()) {
      const main = f === page.mainFrame();
      let visible = main;
      if (!main) {
        const el = await f.frameElement().catch(() => null);
        const box = el ? await el.boundingBox().catch(() => null) : null;
        visible = !!box && box.width * box.height >= 40000;   // 忽略隐藏或极小的跟踪用 iframe
      }
      const text = await frameText(f);
      const rec = { url: stripUrl(f.url()), main, visible, chars: text == null ? null : text.length };
      rec.status = text == null ? 'unreadable' : (!text || f.url() === 'about:blank') ? 'blank' : 'ok';
      if (text) rec.text = text.slice(0, maxText);
      out.frames.push(rec);
    }

    if (views) {
      out.views = [];
      for (const re of VIEW_TABS) {
        for (const f of page.frames()) {
          const tab = f.getByRole('tab', { name: re })
            .or(f.getByRole('link', { name: re }))
            .or(f.getByRole('button', { name: re })).first();
          if (!(await tab.count().catch(() => 0))) continue;
          try {
            await tab.click({ timeout: 5000 });
            await sleep(3000);
            out.views.push({ view: re.source.replace(/\\s\*|\^|\$/g, '').trim(), text: ((await frameText(f)) || '').slice(0, maxText) });
          } catch { /* 切不过去就保留默认视图 */ }
          break;
        }
      }
      if (!out.views.length) delete out.views;
    }

    // 判定：工具页本身（已跳出平台）有字 → ok；仍在平台壳里 → 看可见 iframe
    const mainRec = out.frames.find((x) => x.main);
    const subs = out.frames.filter((x) => !x.main && x.visible);
    const onPlatform = PLATFORM.test(page.url());
    const mainHasText = !!mainRec && mainRec.status === 'ok' && mainRec.chars > 40;
    if (subs.some((x) => x.status === 'ok')) out.status = 'ok';
    else if (subs.length) out.status = 'blank_frame';
    else if (mainHasText) out.status = 'ok';
    else out.status = 'empty';
    out.onPlatform = onPlatform;
  } catch (e) {
    out.status = 'error';
    out.error = firstLine(e);
  } finally {
    await page.close().catch(() => {});
  }
  return out;
}

/** 给 Markdown 用：把一次 capture 压成可读文本（工具 frame 优先，平台壳的菜单文字最后） */
export function captureText(c, max = 12000) {
  if (!c) return '';
  const parts = [];
  for (const f of (c.frames || []).filter((x) => !x.main && x.visible && x.text)) parts.push(`[frame ${f.url}]\n${f.text}`);
  const main = (c.frames || []).find((x) => x.main);
  if (main?.text && (!c.onPlatform || !parts.length)) parts.push(main.text);
  for (const v of c.views || []) if (v.text) parts.push(`[视图 ${v.view}]\n${v.text}`);
  return parts.join('\n\n').slice(0, max);
}
