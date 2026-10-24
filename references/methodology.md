# 抓取方法论（full-capture）与数据布局

排查「为什么漏了 / 为什么显示部分」、或者要改抓取代码时读这份。平常同步不用读。

核心原则：**API 批量为主，浏览器只补 API 覆盖不到的地方。** 单靠任何一个通道都会漏：
老师常把东西放在 API 不返回的 HTML 条目、LTI 工具页、导航页里。

## 1. 每次都从实时课程清单重建（`data/inventory.json`）

- 记录平台 ID、课号、班别、学期、是否纳入抓取（`selected` + `reason`），并和上一轮比对：新增、消失、换了 ID、抓取范围变化。
- 绝不沿用旧课程 ID：同一个课号换学期或换班，平台内部 ID 就变了。
- 抓取范围（`lib/config.mjs` 的 `semesterInfo`）：
  - Blackboard：`courseId` 里带本学期标记（`ABC1234_20261_A` 的 `_20261_` = 2026/27 第一学期），或与这些课同一个 termId；
  - Canvas：`course_code` 带 `_26271_` 这种标记，或 term 名称是「1st Sem. (2026/27)」这类本学期名称；
  - 「Course offered by University」这类非学期制的全校课程不抓；`config.skipCourses` 里的课号不抓。

## 2. Blackboard（learn.polyu.edu.hk，Original 课程套在 Ultra 导航里）

- API 内容树（`contents?recursive=true`），附件逐条下载；
- 解析左侧菜单，每一项都访问并记状态：
  - Tools、Discussions、Contacts、Home 存整页文字；
  - Groups 只记有没有内容，不存名单；My Grades、Help、名单类页面不访问；
  - 日历由 API 覆盖；
- 从菜单的 content area 和 API 文件夹出发，逐层打开 Classic `listContent.jsp`（广度优先，有已访问集合和上限 400），API 没给的条目记为 `source=html`；
- LTI 条目和外部工具（ZOOM、Resource List/Leganto、Turnitin…）用真实页面 launch 一次：
  - Zoom 自动切到 Previous Meetings / Cloud Recordings；Leganto 展开折叠的书单分组；
- 作业条目打开详情页，只留说明、截止和满分（step1–2），提交区和提交历史不入库；
- 评分栏（截止日、满分）、公告（全文 + 链接 + 附件）、日历走 API。

## 3. Canvas（canvas.polyu.edu.hk）

- API 批量：tabs、modules（items 数对不上时逐模块补）、pages、front_page、assignment_groups + rubric、quizzes（只读说明页，不启动作答）、discussion_topics、announcements（明确整个学年的日期窗）、calendar_events、files、folders、external_tools、web_zip_exports；
- 每个端点都记状态：`ok` / `empty` / `http-403` / `http-404` / `error`——学生常常没有文件区权限，403 不代表没有文件；
- 每个可见导航 tab 用真实页面打开一次（成绩、名单页不抓）；模块里的 ExternalTool 条目 launch 一次（每门最多 15 个）。

## 4. 状态要分清

- 区分「已发现 / 已访问 / 已下载 / 已解析 / 失败」；
- 空数组、空白 iframe（`blank_frame`）、没下下来的大文件，都**不能**当成「没有内容」。

## 5. 增量下载（`lib/files.mjs`）

- 稳定身份是平台 ID / 原始路径 + 哈希，签名 CDN URL 永远不当主键；签名 URL 临下载前刷新；
- 小文件走浏览器上下文的 request；超过 64MB 走流式下载：每一跳只带该域自己的 cookie（凭证不转发给 CDN），写 `.part`，校验长度后原子改名，单个文件上限 2GB；
- 视频和音频默认不下载，只登记名字、出处和平台链接（`config.downloadMedia=true` 才下）；YouTube、Panopto、Zoom 录制等第三方视频只记平台和 ID；
- 返回 HTML 的一律算失败（多半是登录页），不会把登录页存成 PDF；
- 同一门课里内容相同的文件只存一份（`dupOf`）；Google Docs / Slides 导出成 PDF，Google Drive / OneDrive 尽量下载，Google Sheets / Forms 只登记成外链。

## 6. 本地转换（`convert.mjs`）

- PDF 逐页抽文字（Poppler 的 `pdftotext`），每页以 `=== p.N ===` 分隔；文字少于 200 字、或整页大图且文字少于 1200 字的页标为「需看图」；
- Office 文件用 LibreOffice 转成 PDF 再抽；压缩包列出目录；图片标为需看图；
- 平台数据渲染成 `data/text/<CODE>/_blackboard.md` / `_canvas.md`，文件清单渲染成 `_files.md`，给提取 agent 读。

## 7. 完整性门槛（`coverage.mjs` → `data/coverage.md`）

- 菜单、导航、文件夹都要有终态；每个附件都要有传输终态；每个 LTI 都要有 launch 结果；
- 文件夹打不开或未访问、LTI 空白或打不开、下载失败、接口失败，都算缺口 → `partial`，下轮自动重试；
- `locked`（老师设了定时开放）只记录，不算缺口。

## 8. 语义层

- 每门有变化的课派一个独立的提取 agent，只处理新增和变更的材料（`changed.mjs` 决定）；
- 关键 PDF（评分表、时间表、作业要求）必须看图核对；
- 再由另一个核查 agent 逐项对原文；
- `build.mjs` 把每条引用（quote）去掉空白后在文本层里查找，找不到的计入「未核实」；JSON 坏掉、权重合计不是 100、日期不合法时回滚到提取前的版本。

## 9. 隐私

- 不抓名单、个人成绩、提交历史、个人分析；
- token、cookie、LTI 的 id_token 和查询串都不落盘（页面 URL 只留 origin + path）；
- 网站只发布摘要、出处索引和原平台链接；原文件和本地路径只留在本机；
- 课程材料的版权属于学校和老师：只给自己看，不外传。

## 数据布局（都在工作区 `<WORK>` 里）

| 路径 | 内容 |
|---|---|
| `config.json` | 学期、第 1 周周一、课程文件夹位置、跳过的课、网站链接 |
| `profile/`、`cookies.json` | 登录态（不要读取、打印或外发） |
| `data/inventory.json` | 实时课程清单与比对 |
| `data/raw/<CODE>/{canvas,blackboard}.json` | 平台数据原样 |
| `data/files/<CODE>/…` | 指向课程文件夹的链接；资料按平台上的目录存放 |
| `data/manifest.json` | 全部文件与外链：出处、首见/变更时间、传输终态、跳过原因 |
| `data/text/<CODE>/…` | 文本层、转出的 PDF、`_canvas.md` / `_blackboard.md` / `_files.md` |
| `data/courses/<CODE>.json` | **每门课的唯一真相源**，由提取/核查 agent 维护；字段见 `extract-agent.md` |
| `data/courses/.prev/` | 提取前的备份（build 回滚用） |
| `data/changes/<日期>.json` | 每次同步的变更记录；`pending/` 是本轮还没合并的 |
| `data/grounding/<CODE>.json` | 每条引用是否在原文里找到 |
| `data/coverage.md`、`data/coverage/<CODE>.json` | 完整性报告 |
| `data/sync-status.json` | 登录态、上次抓取/校验结果 |
| `data/meta.json` | 学期信息（build 从 config.json 写入） |
| `data/profile.md` | 关于我：用户本人确认过的事实 |
| `data/site/` | 网站数据库文档（site-export 生成） |
| `index.html` | 本地看版（双击打开） |

想手工改某门课的某个字段、又不想被下次提取覆盖：把字段路径写进那门课的 `manualLock`（例如 `"assessments.A1.due"`）。
