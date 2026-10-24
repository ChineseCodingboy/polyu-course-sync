/**
 * Blackboard（learn.polyu.edu.hk）。PolyU 的课是 Original course view，套在 Ultra 导航里。
 *
 * 抓取方法照 full-capture 设计（references/methodology.md）：API 为主通道，Classic HTML 兜底，LTI 用真实页面打开。
 *   1. 课程清单：memberships 全量 → data/inventory.json（和上一轮比对）；只抓本学期的课
 *   2. 内容树：v1 contents?recursive=true（API）
 *   3. 菜单：解析 courseMain 左侧菜单，每一项都访问并记状态
 *      content area → 进 HTML 广度优先遍历；Tools / Discussions / Contacts / Home → 整页文本
 *      Groups → 只记有没有内容（不存名单）；My Grades / Help → 不访问
 *      ZOOM 等外部工具（未知 tool_id）→ 真实页面 launch，记录 frame 与可见文字
 *   4. HTML 交叉核对：从菜单的 content area 和 API 的文件夹出发，逐层打开 listContent.jsp，
 *      API 没给的条目记为 source=html，并登记其中的附件和链接；每个文件夹都要有 visited / empty / error 终态
 *   5. LTI 条目（Resource List、Turnitin…）launch 一次；作业条目打开详情页，只留说明和截止信息
 *   6. 评分栏、公告、日历照旧走 API
 *
 * 端点实测（2026-09-16 / 10-04）：
 *   memberships   /learn/api/v1/users/{uid}/memberships?expand=course&limit=200
 *   course        /learn/api/public/v3/courses/{id}                          description 在这
 *   contents      /learn/api/v1/courses/{id}/contents?recursive=true&limit=200
 *                 contentHandler 是字符串；body 是 {rawText, displayText}；文件挂在 attachments 上
 *   attachments   /learn/api/public/v1/courses/{id}/contents/{cid}/attachments[/{aid}/download]
 *   columns       /learn/api/public/v2/courses/{id}/gradebook/columns        grading.due / score.possible
 *   categories    /learn/api/public/v1/courses/{id}/gradebook/categories
 *   announcements /learn/api/v1/courses/{id}/announcements?limit=50          body.rawText 为完整 HTML
 *   calendar      /learn/api/public/v1/calendars/items?since&until&limit=200 跨度 ≤16 周、limit ≤200；按 calendarId 分课
 *   listContent   /webapps/blackboard/content/listContent.jsp?course_id&content_id&mode=reset
 *                 条目 = <li id="contentListItem:_X_1">，图标 alt 标类型（Content Folder / File / Assignment / LTI Link…）
 *   LTI 条目      /webapps/blackboard/execute/blti/launchLink?course_id&content_id
 *   作业详情      /webapps/assignment/uploadAssignment?content_id&course_id&group_id=&mode=view
 *                 step1 = 说明，step2 = 截止与满分，step3 起是提交表单（不入库）
 *   ✗ rubrics（403）、public discussions（Original 不支持）、v1 discussions（404）
 */
import { makeApi, isErr, htmlText, decode, safeName, requestWithRetry, BB, TERM } from './session.mjs';
import { SEMESTER, SKIP, windows } from './config.mjs';
import { registerFile, registerLink } from './files.mjs';
import { extractLinks, externalDownload } from './links.mjs';
import { courseCode } from './courses.mjs';
import { saveInventory } from './inventory.mjs';
import { capturePage, captureText, stripUrl } from './pagecapture.mjs';

const ONLY = (process.env.POLYU_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);

const CAL_WINDOWS = windows(SEMESTER.window);   // 整个学年，切成每段 ≤15 周
const MAX_FOLDERS = 400;   // 单门课 HTML 遍历上限，防止页面错误形成环

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
const bodyHtml = (b) => (typeof b === 'string' ? b : (b?.rawText || b?.displayText || ''));
const iso = (ms) => (typeof ms === 'number' ? new Date(ms).toISOString() : ms || null);
const firstLine = (e) => String(e?.message || e).split('\n')[0].slice(0, 160);
const LOGIN_HTML = /<form[^>]*(adfs\.polyu|login)|id="loginForm"|name="user_id"/i;
const EMPTY_TEXT = /no items found|there are no|nothing to display|no (forums|groups|contacts|items) (are )?(found|available)/i;

async function pagedResults(get, path) {
  const out = [];
  let next = path;
  for (let i = 0; next && i < 20; i++) {
    const r = await get(next);
    if (isErr(r)) return r;  // 中途失败整体算失败，不交半截数据
    out.push(...(r.results || []));
    next = r.paging?.nextPage || null;
  }
  return out;
}

/** 平台内文件链接 → 下载地址；外部 → externalDownload；其它 → null */
function classify(href) {
  const abs = href.startsWith('/') ? BB + href : href;
  if (/learn\.polyu\.edu\.hk\/bbcswebdav\//.test(abs)) {
    const xid = (abs.match(/xid-([\d_]+)/) || [])[1] || abs.replace(/^.*bbcswebdav\//, '');
    return { kind: 'bb', key: `bbdav:${xid}`, download: abs };
  }
  if (/learn\.polyu\.edu\.hk/.test(abs)) return { kind: 'internal', href: abs };
  const ext = externalDownload(abs);
  return ext ? { kind: 'external', ...ext, href: abs } : { kind: 'link', href: abs };
}

/** 登记一段 HTML 里的所有链接；返回 [{label, href, fileKey?}] 写回 raw，方便 agent 对照 */
async function harvestLinks(ctx, m, stats, { html, course, folder, context, pageUrl }) {
  const links = [];
  for (const { href, label, image } of extractLinks(html)) {
    const c = classify(href);
    if (c.kind === 'bb' || c.kind === 'external') {
      const e = await registerFile(ctx, m, {
        key: c.key, course, platform: 'Blackboard', name: c.name || (image ? null : label) || null,
        folder, context, url: c.kind === 'external' ? c.href : pageUrl, download: c.download,
        external: c.kind === 'external',
      }, stats);
      if (e.skipped === 'link') e.name ||= label || c.href;
      links.push({ label, href: c.href || c.download, fileKey: c.key });
    } else if (c.kind === 'link') {
      const key = `link:${Buffer.from(c.href).toString('base64url').slice(-40)}`;
      registerLink(m, { key, course, platform: 'Blackboard', name: label || c.href, folder, context, url: c.href }, stats);
      links.push({ label, href: c.href, fileKey: key });
    } else {
      links.push({ label, href: c.href });
    }
  }
  return links;
}

/** 课程页只要 id="contentPanel" 那块（去掉顶栏和左侧菜单） */
function panelOf(h) {
  const at = h.search(/id="contentPanel"/);
  return (at >= 0 ? '<div ' + h.slice(at) : h).replace(/<div[^>]*id="copyright"[\s\S]*$/i, '').replace(/<nav[\s\S]*?<\/nav>/gi, '');
}

async function getHtml(ctx, url) {
  try {
    const r = await requestWithRetry(ctx, url, { timeout: 30000 });
    const h = await r.text();
    if (!r.ok()) return { status: `http-${r.status()}`, url: r.url() };
    if (LOGIN_HTML.test(h) && !/id="contentPanel"/.test(h)) return { status: 'login_required', url: r.url() };
    return { status: 'ok', html: h, url: r.url() };
  } catch (e) { return { status: 'error', error: firstLine(e) }; }
}

/** listContent.jsp → [{ id, title, icon, href, childId, isFolder, detailsHtml }] */
export function parseListContent(html) {
  const list = String(html).split('<!-- Begin bottom list action bar')[0];
  const out = [];
  for (const seg of list.split(/(?=<li id="contentListItem:)/).slice(1)) {
    const id = (seg.match(/^<li id="contentListItem:(_\d+_\d+)"/) || [])[1];
    if (!id) continue;
    const icon = decode((seg.match(/<img alt="([^"]*)"/i) || [])[1] || '');
    const h3 = (seg.match(/<h3>([\s\S]*?)<\/h3>/i) || [])[1] || '';
    const title = decode(h3.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const href = decode((h3.match(/href="([^"]+)"/i) || [])[1] || '');
    const childId = (href.match(/listContent\.jsp\?[^"]*content_id=(_\d+_\d+)/) || [])[1] || null;
    const detailsHtml = (seg.match(/<div class="details"\s*>([\s\S]*)$/i) || [])[1] || '';
    out.push({ id, title, icon, href, childId, isFolder: /folder|learning module/i.test(icon) || !!childId, detailsHtml });
  }
  return out;
}

/** 左侧菜单 → [{ name, href, kind }] */
function parseMenu(h) {
  const out = [];
  for (const x of h.matchAll(/<li[^>]*id="paletteItem:([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)) {
    const inner = x[2];
    const href = decode((inner.match(/href="([^"]+)"/) || [])[1] || '');
    const name = decode((inner.match(/title="([^"]*)"/) || [])[1] || inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (!href || !name) continue;   // 分隔线
    out.push({ name, href, kind: menuKind(name, href), contentId: (href.match(/content_id=(_\d+_\d+)/) || [])[1] || null });
  }
  return out;
}

function menuKind(name, href) {
  if (/listContent\.jsp/.test(href)) return 'content';
  if (/^home/i.test(name)) return 'home';
  if (/announcement/i.test(name)) return 'announcements';
  if (/calendar/i.test(name)) return 'calendar';
  if (/grade/i.test(name)) return 'grades';
  if (/^help$/i.test(name)) return 'help';
  if (/^tools$/i.test(name)) return 'tools';
  if (/discussion/i.test(name)) return 'discussions';
  if (/group/i.test(name)) return 'groups';
  if (/contact/i.test(name)) return 'contacts';
  if (/roster|people|course messages|email/i.test(name)) return 'private';
  if (/blti|tool_id=|zoom|panopto|leganto|resource list|turnitin|lecture capture/i.test(href + ' ' + name)) return 'lti';
  return 'page';
}

/** 一次 capture 只留下可审计的部分（不存查询串、不存整页 HTML） */
const compactCapture = (c) => c && ({
  status: c.status, at: c.at, finalUrl: c.finalUrl || null, title: c.title || '', redirects: c.redirects || [],
  frames: (c.frames || []).map((f) => pick(f, ['url', 'main', 'visible', 'status', 'chars'])),
  views: (c.views || []).map((v) => v.view), expanded: c.expanded || 0,
  text: captureText(c), error: c.error || undefined,
});

export async function fetchBlackboard(ctx, m, stats, { known, onNewCourse }) {
  const { get } = makeApi(ctx, BB);
  const me = await get('/learn/api/public/v1/users/me');
  if (isErr(me)) throw new Error('Blackboard 未登录');

  /* ── 1. 课程清单 ── */
  const mem = await pagedResults(get, `/learn/api/v1/users/${me.id}/memberships?expand=course&limit=200`);
  if (isErr(mem)) throw new Error(`Blackboard 课程清单失败：${mem.__status || mem.__error}`);
  const all = mem.map((r) => r.course).filter(Boolean);
  const termIds = new Set(all.filter((c) => String(c.courseId || '').includes(TERM)).map((c) => c.termId).filter(Boolean));
  const inv = all.map((c) => {
    const code = courseCode(c.courseId);
    const thisSem = !!code && (String(c.courseId || '').includes(TERM) || termIds.has(c.termId));
    const skipped = thisSem && SKIP.has(code);
    const selected = thisSem && !skipped;
    return {
      platform: 'Blackboard', id: c.id, externalId: c.courseId, code, name: decode(c.name),
      section: (String(c.courseId).match(/_([A-Z0-9]+)$/) || [])[1] || null, term: c.termId || null,
      selected, reason: skipped ? '按配置跳过（skipCourses）' : selected ? `本学期（${TERM}）` : code ? '其他学期' : '非课程（培训/组织）',
    };
  });
  saveInventory('blackboard', inv);
  const courses = all.filter((c) => inv.find((x) => x.id === c.id)?.selected);

  const calendar = [];
  const calendarErrors = [];
  for (const [a, b] of CAL_WINDOWS) {
    // limit 上限 200（超了直接 400）；跨度上限 16 周
    const r = await pagedResults(get, `/learn/api/public/v1/calendars/items?since=${a}T00:00:00.000Z&until=${b}T00:00:00.000Z&limit=200`);
    if (isErr(r)) calendarErrors.push({ label: 'calendar', ...r });
    else calendar.push(...r);
  }

  const results = [];
  for (const c of courses) {
    const code = courseCode(c.courseId);
    if (ONLY.length && !ONLY.includes(code)) continue;   // 调试：POLYU_ONLY=ABC1234,DEF5678 只抓这几门
    if (!known.has(code)) onNewCourse({ code, platform: 'Blackboard', title: c.name, bbId: c.id, bbCourseId: c.courseId, url: `${BB}/ultra/courses/${c.id}/outline` });
    console.log(`══ Blackboard ${code}  ${c.name}`);
    const cid = c.id;
    const courseUrl = `${BB}/webapps/blackboard/execute/courseMain?course_id=${cid}`;
    const errors = [...calendarErrors];
    const note = (label, v) => { if (isErr(v)) errors.push({ label, ...v }); return isErr(v) ? [] : v; };
    const raw = { platform: 'Blackboard', fetchedAt: new Date().toISOString(), courseUrl, errors };

    const v3 = await get(`/learn/api/public/v3/courses/${cid}`);
    raw.course = isErr(v3) ? { id: cid, courseId: c.courseId, name: c.name }
      : { ...pick(v3, ['id', 'courseId', 'name', 'termId', 'modified']), description: htmlText(v3.description) };

    /* ── 2. 内容树（API） ── */
    const contents = note('contents', await pagedResults(get, `/learn/api/v1/courses/${cid}/contents?recursive=true&limit=200`));
    const byId = new Map(contents.map((x) => [x.id, x]));
    const pathOf = (id) => {
      const parts = [];
      for (let x = byId.get(id); x; x = byId.get(x.parentId)) parts.unshift(decode(x.title));
      return parts;
    };
    raw.contents = [];
    for (const x of contents) {
      const handler = typeof x.contentHandler === 'string' ? x.contentHandler : x.contentHandler?.id;
      const trail = pathOf(x.id);
      const html = bodyHtml(x.body);
      const pageUrl = `${BB}/webapps/blackboard/content/listContent.jsp?course_id=${cid}&content_id=${x.parentId || x.id}`;
      const item = {
        id: x.id, title: decode(x.title), path: trail.join(' / '), parentId: x.parentId || null,
        position: x.position, handler, modified: iso(x.modifiedDate), source: 'api',
        description: htmlText(x.description), body: htmlText(html),
        detail: x.contentDetail && Object.keys(x.contentDetail).length ? x.contentDetail : undefined,
        links: [], attachments: [],
      };
      if (html) item.links = await harvestLinks(ctx, m, stats, { html, course: code, folder: trail.join('/'), context: item.path, pageUrl });
      if (!/folder|blti-link|lti/.test(handler || '')) {
        const at = await get(`/learn/api/public/v1/courses/${cid}/contents/${x.id}/attachments`);
        // 400「does not support file attachments」= 该类条目本来就不挂附件（文件在正文链接里）
        if (isErr(at) && at.__status !== 404 && !/does not support file attachments/.test(at.__body || '')) errors.push({ label: `attachments ${item.path}`, ...at });
        for (const a of (isErr(at) ? [] : at.results || [])) {
          const e = await registerFile(ctx, m, {
            key: `bb:${a.id}`, course: code, platform: 'Blackboard', name: a.fileName,
            folder: trail.slice(0, -1).join('/') || trail[0] || '', context: item.path, url: pageUrl, mime: a.mimeType,
            sourceUpdatedAt: item.modified,  // 换附件会换 attachment id；同 id 以条目修改时间为版本
            download: `${BB}/learn/api/public/v1/courses/${cid}/contents/${x.id}/attachments/${a.id}/download`,
          }, stats);
          item.attachments.push({ fileKey: e.key, name: a.fileName, path: e.path || null });
        }
      }
      // LTI 条目：真实页面 launch 一次
      if (/blti-link|lti/.test(handler || '')) {
        item.lti = compactCapture(await capturePage(ctx, `${BB}/webapps/blackboard/execute/blti/launchLink?course_id=${cid}&content_id=${x.id}`));
        console.log(`   ⧉ LTI「${item.title}」${item.lti.status}${item.lti.finalUrl ? ` → ${new URL(item.lti.finalUrl).host}` : ''}`);
      }
      // 作业条目：详情页只留「说明 + 截止/满分」（step1–step2），提交区和提交历史不入库
      if (/assignment/.test(handler || '')) {
        const d = await getHtml(ctx, `${BB}/webapps/assignment/uploadAssignment?content_id=${x.id}&course_id=${cid}&group_id=&mode=view`);
        const seg = d.html ? (d.html.match(/id="step1"[\s\S]*?(?=id="step3")/) || [])[0] : null;
        item.detailPage = seg ? { status: 'ok', text: htmlText('<div ' + seg).slice(0, 8000) }
          : { status: d.status === 'ok' ? 'no-info（可能已提交，页面只剩提交记录，不抓）' : d.status };
      }
      raw.contents.push(item);
    }

    /* ── 3. 菜单：每一项都访问并记状态 ── */
    raw.menu = [];
    const main = await getHtml(ctx, courseUrl);
    if (main.status !== 'ok') errors.push({ label: 'menu', __status: main.status });
    const menuItems = main.html ? parseMenu(main.html) : [];
    for (const item of menuItems) {
      const rec = { name: item.name, kind: item.kind, url: stripUrl(BB + item.href), links: [] };
      if (['grades', 'help', 'private'].includes(item.kind)) { rec.status = 'skipped（个人数据/帮助页，不抓）'; raw.menu.push(rec); continue; }
      if (item.kind === 'calendar') { rec.status = 'covered-by-api'; raw.menu.push(rec); continue; }   // Classic 日历页只是 Ultra 壳，内容走 calendars API
      if (item.kind === 'lti') {
        rec.lti = compactCapture(await capturePage(ctx, BB + item.href));
        rec.status = rec.lti.status;
        console.log(`   ⧉ 菜单「${item.name}」${rec.status}${rec.lti.finalUrl ? ` → ${new URL(rec.lti.finalUrl).host}` : ''}`);
        raw.menu.push(rec);
        continue;
      }
      const page = await getHtml(ctx, BB + item.href);
      if (page.status !== 'ok') { rec.status = page.status; errors.push({ label: `menu:${item.name}`, __status: page.status }); raw.menu.push(rec); continue; }
      rec.url = stripUrl(page.url);
      const part = panelOf(page.html);
      const text = htmlText(part).slice(0, 60000);
      const body = text.replace(/^.*?\n/, '').trim();   // 去掉页面标题行再判空
      rec.status = body.length < 20 || (EMPTY_TEXT.test(body) && body.length < 300) ? 'empty' : 'ok';
      if (item.kind === 'groups') { rec.present = rec.status === 'ok'; raw.menu.push(rec); continue; }   // 不存小组名单
      rec.text = text;
      rec.links = (await harvestLinks(ctx, m, stats, { html: part, course: code, folder: safeName(item.name, 40), context: `菜单：${item.name}`, pageUrl: page.url })).filter((l) => l.fileKey);
      raw.menu.push(rec);
    }

    /* ── 4. HTML 交叉核对：从 content area 和 API 文件夹出发逐层打开 ── */
    const apiIds = new Set(raw.contents.map((x) => x.id));
    const queue = [
      ...menuItems.filter((x) => x.kind === 'content' && x.contentId).map((x) => ({ id: x.contentId, title: x.name, path: [x.name], via: 'menu' })),
      ...raw.contents.filter((x) => /folder/.test(x.handler || '')).map((x) => ({ id: x.id, title: x.title, path: x.path.split(' / '), via: 'api' })),
    ];
    const folders = new Map();
    while (queue.length && folders.size < MAX_FOLDERS) {
      const node = queue.shift();
      if (folders.has(node.id)) continue;
      const rec = { id: node.id, title: node.title, path: node.path.join(' / '), via: node.via };
      folders.set(node.id, rec);
      const url = `${BB}/webapps/blackboard/content/listContent.jsp?course_id=${cid}&content_id=${node.id}&mode=reset`;
      const page = await getHtml(ctx, url);
      if (page.status !== 'ok') { rec.status = page.status; continue; }
      const items = parseListContent(page.html);
      rec.items = items.length;
      rec.status = items.length ? 'visited' : 'empty';
      rec.htmlOnly = [];
      for (const it of items) {
        const childPath = [...node.path, it.title];
        if (!apiIds.has(it.id)) {
          // API 没给的条目：存标题、正文、附件和链接
          rec.htmlOnly.push(it.id);
          apiIds.add(it.id);
          const item = {
            id: it.id, title: it.title, path: childPath.join(' / '), parentId: node.id, handler: `html:${it.icon || 'item'}`,
            source: 'html', body: htmlText(it.detailsHtml).slice(0, 20000), links: [], attachments: [],
          };
          item.links = await harvestLinks(ctx, m, stats, { html: it.detailsHtml + (it.href && !it.childId ? `<a href="${it.href}">${it.title}</a>` : ''), course: code, folder: childPath.slice(0, -1).join('/'), context: item.path, pageUrl: url });
          if (/lti/i.test(it.icon)) item.lti = compactCapture(await capturePage(ctx, BB + it.href));
          raw.contents.push(item);
          console.log(`   ＋ HTML 补到 API 没给的条目「${item.path}」`);
        }
        if (it.isFolder && !folders.has(it.childId || it.id)) {
          queue.push({ id: it.childId || it.id, title: it.title, path: childPath, via: raw.contents.find((x) => x.id === it.id)?.source || 'html' });
        }
      }
    }
    raw.crawl = {
      folders: [...folders.values()],
      unvisited: queue.filter((q) => !folders.has(q.id)).map((q) => q.id),
      htmlOnly: raw.contents.filter((x) => x.source === 'html').length,
    };

    /* ── 5. 评分栏（含截止日与分值）── */
    const cats = note('categories', await get(`/learn/api/public/v1/courses/${cid}/gradebook/categories`));
    const catName = new Map((cats.results || []).map((x) => [x.id, x.title]));
    const cols = note('columns', await pagedResults(get, `/learn/api/public/v2/courses/${cid}/gradebook/columns?limit=200`));
    raw.gradebook = cols.map((x) => ({
      id: x.id, name: decode(x.name), description: htmlText(x.description), contentId: x.contentId || null,
      due: x.grading?.due || null, type: x.grading?.type || null, possible: x.score?.possible ?? null,
      category: catName.get(x.gradebookCategoryId) || null, available: x.availability?.available,
    }));

    /* ── 6. 公告：全文 + 链接 + 附件 ── */
    const anns = note('announcements', await pagedResults(get, `/learn/api/v1/courses/${cid}/announcements?limit=50`));
    raw.announcements = [];
    for (const a of anns) {
      if (a.isDraft) continue;
      const html = bodyHtml(a.body);
      const title = decode(a.title);
      const links = await harvestLinks(ctx, m, stats, {
        html, course: code, folder: '公告附件', context: `公告：${title}`,
        pageUrl: `${BB}/webapps/blackboard/execute/announcement?method=search&context=course_entry&course_id=${cid}&handle=announcements_entry&mode=view`,
      });
      raw.announcements.push({
        id: a.id, title, created: a.createdDate, modified: a.modifiedDate,
        visibleFrom: a.startDateRestriction || null, body: htmlText(html), links,
      });
    }

    raw.calendar = calendar.filter((x) => x.calendarId === cid).map((x) => ({
      title: decode(x.title), type: x.type, start: x.start, end: x.end,
      eventType: x.dynamicCalendarItemProps?.eventType || null, id: x.id,
    }));

    const nFiles = Object.values(m.files).filter((f) => f.course === code).length;
    const lti = [...raw.menu.filter((x) => x.lti), ...raw.contents.filter((x) => x.lti)];
    console.log(`   内容 ${raw.contents.length}（HTML 补 ${raw.crawl.htmlOnly}）· 文件夹 ${raw.crawl.folders.length}${raw.crawl.unvisited.length ? `（未访问 ${raw.crawl.unvisited.length}）` : ''} · 菜单 ${raw.menu.length} · LTI ${lti.length}（ok ${lti.filter((x) => (x.lti.status) === 'ok').length}）· 评分栏 ${raw.gradebook.length} · 公告 ${raw.announcements.length} · 日历 ${raw.calendar.length} · 文件/链接 ${nFiles}${errors.length ? ` · ${errors.length} 个接口失败` : ''}`);
    results.push({ code, raw });
  }
  return results;
}
