/**
 * Canvas（canvas.polyu.edu.hk），会话 cookie 调 API；API 覆盖不到的导航页和 LTI 用真实页面打开。
 *
 * 抓取方法照 full-capture 设计（references/methodology.md）：
 *   1. 课程清单：enrollment_state=active 全量 → data/inventory.json（和上一轮比对）
 *      纳入：本学期的课（课号带学期标记，或 term 名称是本学期）；非学期制的全校课程（「Course offered by University」）不抓
 *   2. API 批量：tabs、modules(+items)、pages、front_page、assignment_groups(+rubric)、quizzes、
 *      discussion_topics、announcements（明确日期窗）、calendar_events、files/folders、external_tools、
 *      web_zip_exports（离线课程包，学生通常无权创建，只记可用性）
 *      每个端点都记状态：ok / empty / http-403 / http-404 / error —— 空数组 ≠ 没访问
 *   3. UI 补漏：每个可见导航 tab 打开一次（成绩、名单页不抓）；模块里的 ExternalTool 条目 launch 一次
 *   4. 文件按 fileId 增量下载（签名 URL 临下载前从文件详情取）
 *
 * 端点实测（2026-09-16）：
 *   ✓ courses?include[]=syllabus_body,teachers,term     term.name 形如「1st Sem. (2026/27)」
 *   ✓ modules?include[]=items,content_details            File / Page / Assignment 项
 *   ✓ pages/{url}                                         列表接口被停用（404）但逐页取可以
 *   ✓ assignment_groups?include[]=assignments             group_weight + description + rubric
 *   ✓ announcements?context_codes[]=course_X              message 为完整 HTML，attachments 带下载地址
 *   ✓ calendar_events?type=assignment / type=event
 *   ✓ courses/{id}/files/{fid}                            单个文件元数据；url 带 verifier，可直接下载
 *   ✗ courses/{id}/files、folders/{id}/files（403，学生看不到文件区）
 *   ✗ pages 列表、quizzes（404，部分课程停用）—— 仍然每轮试一次，开了就抓
 *   locked_for_user=true 的文件没有 url：登记为 locked，开放后下一轮自动下载
 */
import { makeApi, isErr, htmlText, CANVAS } from './session.mjs';
import { SEMESTER, SKIP } from './config.mjs';
import { registerFile, registerLink } from './files.mjs';
import { extractLinks, externalDownload } from './links.mjs';
import { courseCode } from './courses.mjs';
import { saveInventory } from './inventory.mjs';
import { capturePage, captureText } from './pagecapture.mjs';

const ONLY = (process.env.POLYU_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
const SEMESTER_TERM = /Sem\.|Semester|Summer/i;
const PRIVATE_TABS = /^(grades|people|conferences|collaborations)$/;
const MAX_TOOL_LAUNCHES = 15;

/** 非标准课号（如 ABC_2023 这类全校课程）退回字母前缀 */
const canvasCode = (c) => courseCode(c.course_code) || courseCode(c.name)
  || ((String(c.course_code || '').match(/^([A-Za-z]{2,8})(?=[_\s-]|$)/) || [])[1] || '').toUpperCase() || null;

const compactCapture = (c) => c && ({
  status: c.status, at: c.at, finalUrl: c.finalUrl || null, title: c.title || '', redirects: c.redirects || [],
  frames: (c.frames || []).map((f) => pick(f, ['url', 'main', 'visible', 'status', 'chars'])),
  views: (c.views || []).map((v) => v.view), text: captureText(c), error: c.error || undefined,
});

const statusOf = (v) => (isErr(v) ? (v.__status ? `http-${v.__status}` : 'error') : Array.isArray(v) && !v.length ? 'empty' : 'ok');

export async function fetchCanvas(ctx, m, stats, { known, onNewCourse }) {
  const { get, getAll } = makeApi(ctx, CANVAS);
  const list = await getAll('/api/v1/courses?enrollment_state=active&include[]=term&include[]=teachers&include[]=syllabus_body&per_page=100');
  if (isErr(list)) throw new Error('Canvas 未登录或课程列表失败');

  /* ── 1. 课程清单：课号里的学期标记（_26271_）或 term 名称（1st Sem. (2026/27)）任一对上就是本学期 ── */
  const inv = list.map((c) => {
    const term = c.term?.name || '';
    const code = canvasCode(c);
    const thisSem = String(c.course_code || '').includes(SEMESTER.canvasCodeTag) || SEMESTER.canvasTermName.test(term);
    const semesterBased = SEMESTER_TERM.test(term) || thisSem;
    const skipped = !!code && SKIP.has(code);
    const selected = !!code && semesterBased && thisSem && !skipped;
    return {
      platform: 'Canvas', id: c.id, externalId: c.course_code, code, name: c.name, term,
      section: (String(c.course_code).match(/_([A-Z0-9]+)$/) || [])[1] || null,
      selected, reason: !code ? '无法识别课号' : !semesterBased ? '全校课程（非学期制），不抓' : skipped ? '按配置跳过（skipCourses）'
        : selected ? `本学期（${SEMESTER.labelEn}）` : '其他学期',
    };
  });
  saveInventory('canvas', inv);
  const targets = list.filter((c) => inv.find((x) => x.id === c.id)?.selected);

  const results = [];
  for (const c of targets) {
    const code = canvasCode(c);
    if (ONLY.length && !ONLY.includes(code)) continue;   // 调试：POLYU_ONLY=ABC1234,DEF5678 只抓这几门
    if (!known.has(code)) onNewCourse({ code, platform: 'Canvas', title: c.name.replace(/^[A-Z]+\d+[^:]*:\s*/, ''), canvasId: c.id, url: `${CANVAS}/courses/${c.id}` });
    console.log(`══ Canvas ${code}  ${c.name}`);
    const base = `/api/v1/courses/${c.id}`;
    const errors = [];
    const endpoints = {};
    /** 统一记状态；optional 的失败不算错误（学生本来就可能没权限），但状态照记 */
    const call = async (label, promise, optional = false) => {
      const v = await promise;
      endpoints[label] = { status: statusOf(v), count: Array.isArray(v) ? v.length : undefined };
      if (isErr(v)) { if (!optional) errors.push({ label, ...v }); return []; }
      return v;
    };
    const raw = {
      platform: 'Canvas', fetchedAt: new Date().toISOString(), courseUrl: `${CANVAS}/courses/${c.id}`, errors, endpoints,
      course: {
        ...pick(c, ['id', 'name', 'course_code', 'apply_assignment_group_weights', 'default_view']),
        term: c.term?.name, teachers: (c.teachers || []).map((t) => t.display_name),
        syllabus: htmlText(c.syllabus_body),
      },
    };

    const fileRefs = new Map();   // fileId → { folder, context, url }
    const addRef = (id, ref) => { if (id && !fileRefs.has(+id)) fileRefs.set(+id, ref); };
    const htmlBlocks = [];        // [{ html, folder, context, url }] → 文件引用 + 外链
    htmlBlocks.push({ html: c.syllabus_body, folder: 'Syllabus', context: 'Syllabus', url: `${CANVAS}/courses/${c.id}/assignments/syllabus` });

    /* 导航 tabs（API） */
    const tabs = await call('tabs', getAll(`${base}/tabs?per_page=100`), true);

    /* 模块：inline items 不全时（items_count 对不上）逐模块补 */
    const modules = await call('modules', getAll(`${base}/modules?include[]=items&include[]=content_details&per_page=100`));
    raw.modules = [];
    const pageUrls = new Map();
    const toolItems = [];
    for (const mod of modules) {
      let items = mod.items;
      if (!items || (mod.items_count != null && items.length < mod.items_count)) {
        items = await call(`module ${mod.id} items`, getAll(`${base}/modules/${mod.id}/items?include[]=content_details&per_page=100`));
      }
      raw.modules.push({
        name: mod.name, position: mod.position, unlockAt: mod.unlock_at || null,
        prerequisites: (mod.prerequisite_module_ids || []).length ? mod.prerequisite_module_ids : undefined,
        state: mod.state || undefined,
        items: items.map((i) => ({
          type: i.type, title: i.title, contentId: i.content_id || null, pageUrl: i.page_url || null,
          externalUrl: i.external_url || null, htmlUrl: i.html_url || null,
          due: i.content_details?.due_at || null, points: i.content_details?.points_possible ?? null,
          locked: !!i.content_details?.locked_for_user, lockExplanation: i.content_details?.lock_explanation || null,
        })),
      });
      for (const i of items) {
        if (i.type === 'File') addRef(i.content_id, { folder: mod.name, context: `模块：${mod.name}`, url: i.html_url });
        if (i.type === 'Page') pageUrls.set(i.page_url, mod.name);
        if (i.type === 'ExternalUrl' && i.external_url) htmlBlocks.push({ html: `<a href="${i.external_url}">${i.title}</a>`, folder: mod.name, context: `模块：${mod.name}`, url: i.html_url });
        if (i.type === 'ExternalTool' && i.html_url && !i.content_details?.locked_for_user) toolItems.push({ title: i.title, module: mod.name, url: i.html_url });
      }
    }

    /* 页面：列表（常被停用）∪ 模块里的 Page */
    const pageList = await call('pages', getAll(`${base}/pages?per_page=100`), true);
    for (const p of pageList) if (!pageUrls.has(p.url)) pageUrls.set(p.url, 'Pages');
    const front = await get(`${base}/front_page`);
    endpoints.front_page = { status: statusOf(front) };
    raw.pages = [];
    const pushPage = (p, folder) => {
      raw.pages.push({ title: p.title, url: p.html_url, updated: p.updated_at, folder, body: htmlText(p.body), locked: p.locked_for_user || undefined });
      htmlBlocks.push({ html: p.body, folder, context: `页面：${p.title}`, url: p.html_url });
    };
    if (!isErr(front)) pushPage(front, 'Home');
    for (const [url, folder] of pageUrls) {
      const p = await get(`${base}/pages/${encodeURIComponent(url)}`);
      if (isErr(p)) { errors.push({ label: `page ${url}`, ...p }); continue; }
      pushPage(p, folder);
    }

    /* 作业与权重 */
    const groups = await call('assignment_groups', getAll(`${base}/assignment_groups?include[]=assignments&per_page=100`));
    raw.assignmentGroups = groups.map((g) => ({
      name: g.name, weight: g.group_weight, rules: g.rules && Object.keys(g.rules).length ? g.rules : undefined,
      assignments: (g.assignments || []).map((a) => {
        htmlBlocks.push({ html: a.description, folder: '作业附件', context: `作业：${a.name}`, url: a.html_url });
        return {
          id: a.id, name: a.name, url: a.html_url, due: a.due_at, unlock: a.unlock_at, lock: a.lock_at,
          points: a.points_possible, gradingType: a.grading_type, submission: a.submission_types,
          allowedExtensions: a.allowed_extensions, groupWork: !!a.group_category_id,
          omitFromFinal: a.omit_from_final_grade, published: a.published, locked: a.locked_for_user,
          lockExplanation: a.lock_explanation || null,
          description: htmlText(a.description),
          externalTool: a.external_tool_tag_attributes?.url ? new URL(a.external_tool_tag_attributes.url).host : undefined,
          rubric: a.rubric ? a.rubric.map((r) => ({
            criterion: r.description, detail: r.long_description || null, points: r.points,
            ratings: (r.ratings || []).map((x) => ({ label: x.description, detail: x.long_description || null, points: x.points })),
          })) : undefined,
          rubricSettings: a.rubric_settings || undefined,
        };
      }),
    }));

    /* 测验：只读 landing（说明、时间、次数），不启动 attempt */
    const quizzes = await call('quizzes', getAll(`${base}/quizzes?per_page=100`), true);
    raw.quizzes = quizzes.map((q) => {
      htmlBlocks.push({ html: q.description, folder: '测验', context: `测验：${q.title}`, url: q.html_url });
      return { title: q.title, url: q.html_url, due: q.due_at, unlock: q.unlock_at, lock: q.lock_at, timeLimit: q.time_limit, attempts: q.allowed_attempts, points: q.points_possible, questions: q.question_count, locked: q.locked_for_user || undefined, description: htmlText(q.description) };
    });

    const topics = await call('discussion_topics', getAll(`${base}/discussion_topics?per_page=100`));
    raw.discussions = topics.map((t) => {
      htmlBlocks.push({ html: t.message, folder: '讨论', context: `讨论：${t.title}`, url: t.html_url });
      return { title: t.title, url: t.html_url, posted: t.posted_at, message: htmlText(t.message) };
    });

    /* 公告：明确整个学期的日期窗（不设窗口时服务器只回近期） */
    const anns = await call('announcements', getAll(`/api/v1/announcements?context_codes[]=course_${c.id}&start_date=${SEMESTER.window[0]}&end_date=${SEMESTER.window[1]}&per_page=100`));
    raw.announcements = anns.map((a) => {
      htmlBlocks.push({ html: a.message, folder: '公告附件', context: `公告：${a.title}`, url: a.html_url });
      for (const x of a.attachments || []) addRef(x.id, { folder: '公告附件', context: `公告：${a.title}`, url: a.html_url, meta: x });
      return {
        title: a.title, url: a.html_url, posted: a.posted_at, delayedUntil: a.delayed_post_at || null,
        body: htmlText(a.message), attachments: (a.attachments || []).map((x) => ({ fileKey: `canvas:${x.id}`, name: x.display_name })),
      };
    });

    /* 日历 */
    const evA = await call('calendar(assignment)', getAll(`/api/v1/calendar_events?context_codes[]=course_${c.id}&type=assignment&all_events=true&per_page=100`));
    const evE = await call('calendar(event)', getAll(`/api/v1/calendar_events?context_codes[]=course_${c.id}&type=event&all_events=true&per_page=100`));
    raw.calendar = [...evE, ...evA].map((e) => ({
      title: e.title, start: e.start_at, end: e.end_at, type: e.assignment ? 'assignment' : 'event',
      location: e.location_name || null, description: htmlText(e.description),
    }));
    for (const e of evE) htmlBlocks.push({ html: e.description, folder: '日历', context: `日历：${e.title}`, url: e.html_url });

    /* 文件区 / 文件夹 / 外部工具 / 离线课程包：学生常无权限，状态照记；能列就全收 */
    const folders = await call('folders', getAll(`${base}/folders?per_page=100`), true);
    const folderName = new Map(folders.map((f) => [f.id, String(f.full_name || f.name || '').replace(/^course files\/?/, '') || '文件区']));
    const fileList = await call('files', getAll(`${base}/files?per_page=100`), true);
    for (const f of fileList) addRef(f.id, { folder: folderName.get(f.folder_id) || '文件区', context: '文件区', url: `${CANVAS}/courses/${c.id}/files/${f.id}`, meta: f });
    const tools = await call('external_tools', getAll(`${base}/external_tools?per_page=100`), true);
    raw.externalTools = tools.map((t) => ({ name: t.name, domain: t.domain || null, url: t.url ? new URL(t.url).host : null }));
    const exportsList = await call('web_zip_exports', getAll(`${base}/web_zip_exports?per_page=100`), true);
    raw.offlineExports = exportsList.map((x) => pick(x, ['id', 'workflow_state', 'created_at', 'progress_id']));

    /* 正文里的文件引用与外链 */
    for (const b of htmlBlocks) {
      if (!b.html) continue;
      for (const { href, label } of extractLinks(b.html)) {
        const fid = (href.match(/(?:canvas\.polyu\.edu\.hk)?\/(?:api\/v1\/)?(?:courses\/\d+\/)?files\/(\d+)/) || [])[1];
        if (fid && (href.startsWith('/') || href.includes('canvas.polyu.edu.hk'))) { addRef(fid, { folder: b.folder, context: b.context, url: b.url }); continue; }
        if (href.startsWith('/') || href.includes('canvas.polyu.edu.hk')) continue;  // 课内导航链接
        const ext = externalDownload(href);
        if (ext) {
          const e = await registerFile(ctx, m, { key: ext.key, course: code, platform: 'Canvas', name: ext.name, folder: b.folder, context: b.context, url: href, download: ext.download, external: true }, stats);
          if (e.skipped === 'link') e.name ||= label || href;
        } else {
          registerLink(m, { key: `link:${Buffer.from(href).toString('base64url').slice(-40)}`, course: code, platform: 'Canvas', name: label || href, folder: b.folder, context: b.context, url: href }, stats);
        }
      }
    }

    /* 下载所有引用到的文件：签名 URL 临下载前从文件详情取 */
    raw.files = [];
    for (const [fid, ref] of fileRefs) {
      let meta = await get(`${base}/files/${fid}`);
      if (isErr(meta)) meta = await get(`/api/v1/files/${fid}`);
      if (isErr(meta) && ref.meta?.url) meta = ref.meta;   // 详情取不到时退回公告附件自带的地址
      if (isErr(meta)) { errors.push({ label: `file ${fid}`, ...meta }); continue; }
      const e = await registerFile(ctx, m, {
        key: `canvas:${fid}`, course: code, platform: 'Canvas', name: meta.display_name,
        folder: ref.folder, context: ref.context, url: ref.url || `${CANVAS}/courses/${c.id}/files/${fid}`,
        mime: meta['content-type'], size: meta.size, sourceUpdatedAt: meta.modified_at || meta.updated_at,
        locked: meta.locked_for_user && !meta.url, lockInfo: meta.lock_explanation || meta.unlock_at || null,
        download: meta.url || `${CANVAS}/files/${fid}/download?download_frd=1`,
      }, stats);
      raw.files.push({ fileKey: e.key, name: e.name, folder: ref.folder, path: e.path || null, skipped: e.skipped || null });
    }

    /* UI 补漏：每个可见导航 tab 打开一次；模块里的外部工具 launch 一次 */
    raw.tabs = [];
    for (const t of tabs) {
      const rec = { id: t.id, label: t.label, type: t.type, hidden: !!t.hidden, visibility: t.visibility };
      if (t.hidden) { rec.status = 'hidden'; raw.tabs.push(rec); continue; }
      if (PRIVATE_TABS.test(t.id)) { rec.status = 'present（个人数据，不抓）'; raw.tabs.push(rec); continue; }
      rec.capture = compactCapture(await capturePage(ctx, t.full_url || CANVAS + t.html_url));
      rec.status = rec.capture.status;
      if (t.type === 'external' || rec.status !== 'ok') console.log(`   ⧉ tab「${t.label}」${rec.status}`);
      raw.tabs.push(rec);
    }
    raw.toolLaunches = [];
    for (const it of toolItems.slice(0, MAX_TOOL_LAUNCHES)) {
      const cap = compactCapture(await capturePage(ctx, it.url));
      raw.toolLaunches.push({ ...it, capture: cap, status: cap.status });
      console.log(`   ⧉ 模块工具「${it.title}」${cap.status}`);
    }
    if (toolItems.length > MAX_TOOL_LAUNCHES) raw.toolLaunchesSkipped = toolItems.length - MAX_TOOL_LAUNCHES;

    const okTabs = raw.tabs.filter((t) => t.status === 'ok').length;
    console.log(`   模块 ${raw.modules.length} · 页面 ${raw.pages.length} · 作业 ${raw.assignmentGroups.reduce((s, g) => s + g.assignments.length, 0)} · 测验 ${raw.quizzes.length} · 公告 ${raw.announcements.length} · 日历 ${raw.calendar.length} · 文件 ${raw.files.length} · 导航 ${okTabs}/${raw.tabs.length} · 外部工具 ${raw.toolLaunches.length}${errors.length ? ` · ${errors.length} 个接口失败` : ''}`);
    results.push({ code, raw });
  }
  return results;
}
