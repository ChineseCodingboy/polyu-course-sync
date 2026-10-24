# 单课提取 agent 说明书

你负责**一门课**。目标：把这门课在 Canvas / Blackboard 上的全部材料读完，更新
`data/courses/<CODE>.json`，使其**完全准确**：大纲、评分准则、每一项作业/考核的信息与时间节点。

工作区根目录由编排者在 prompt 里给出（下面写作 `<WORK>`），以下路径都相对它。

> 用户要的是**完全准确**：宁可标 `unknown` 也不要猜；每个数字、日期都要能指回原文。

---

## 1. 输入

编排者会告诉你：课号 `<CODE>`、本轮是 `full`（全部重读）还是 `incremental`（只看变化），以及变化清单。

| 文件 | 内容 |
|---|---|
| `data/courses/<CODE>.json` | 当前记录（上一轮结果；首轮是抓取时自动建的空壳，也可能有用户手工填的种子） |
| `data/profile.md` | **关于我**：用户本人确认过的事实（组号、所在班别、哪些要求不适用），见 §6 |
| `data/text/<CODE>/_canvas.md` / `_blackboard.md` | 平台数据全文：公告（含链接）、作业说明与 rubric、评分栏截止日、内容树、菜单页整页文本、日历 |
| `data/text/<CODE>/_files.md` | 这门课所有文件：原文件路径、文本路径、页数、**需看图页**、首见/变更日期、出处 |
| `data/text/<CODE>/**.txt` | 每个文件的文本层，`=== p.N ===` 分页 |
| `data/text/<CODE>/**.pdf` | Office 文件转出的 PDF（看版式/图片用） |
| `data/files/<CODE>/**` | 原文件 |
| `data/meta.json` | `weekOneMonday`（第 1 周周一）、`totalWeeks` 等学期信息 |

`data/files/<CODE>/00 作业与考核.html` 是本项目根据上一轮 JSON 生成的汇总页，**不是课程材料**，不能当出处。

## 2. 读材料的方法（准确性的关键）

### 2.0 怎么「看图」

下文说的「看图」，是指亲眼看页面图像，不只读文本层：

- **Claude Code**：用 Read 直接打开 PDF（`pages` 参数指定页，每次最多 20 页）或图片。卡住（很久没有反应）时改用下面的方法。
- **Codex 或其他工具**：先渲染成 PNG，再用看图工具（Codex 的 `view_image`）打开：
  ```bash
  node "<S>/pages.mjs" "data/files/<CODE>/…/x.pdf" 3-5
  ```
  它会打印每一页 PNG 的路径。Word / PPT 会自动改用转出的 PDF；图片文件直接返回原路径。
  `<S>` 是编排者在 prompt 里给出的脚本目录。

### 2.1 先分类，再决定读多深

- **A 类·必须逐页精读**：Subject Information Sheet / Subject Description Form (SDF) / Syllabus / Teaching Schedule / 课程要求 / Assessment（Student）Guide / 作业说明 / Project Instruction / Rubric / Marking Criteria / 评分表 / Lecture 1（开课讲义常有考核页）/ 公告正文和公告附件（包括图片）。
  - 文本层全读，同时**看原文件的图**（方法见 §2.0；Office 文件看转出的 PDF；图片直接看）。
  - 表格（周次、日期、权重、rubric）在文本层里经常错位，**只要页面上有表格，就必须看图核对**。
  - `_files.md` 里标了「需看图页」的页必须看图：那是扫描页或图片页，文本层基本是空的。
- **B 类·检索后精读命中处**：普通讲义、Lab 讲义、练习。
  - 在 `.txt` 里搜索（grep 或你的搜索工具）：`assess|assignment|due|deadline|submi|quiz|test|exam|mid-?term|project|presentation|report|weight|marks?|%|grading|rubric|late|penalt|attendance|week\s*\d+|group`。
  - 命中的页要读上下文；命中的是表格或图片就看图。
  - 整份文件如果大部分页都「需看图」，至少看第 1–3 页、最后 2 页和所有带考核字样的页。
- **C 类·只记书名**：规范、标准、指南、参考读物、数据集、样例报告。只在 `syllabus.textbooks` 里列主要几项，不必逐页读。

### 2.2 平台数据同样是一手来源

> **日历、评分栏和 Canvas 作业的截止时间都不完整。** 老师经常不把事项加进 calendar 或 Grade Center，很多截止日、课堂测验、展示、分组期限只写在公告、课程文件、讲义或内容页正文里。
> - 日历里没有，**不代表**没有这个时间节点；
> - 日历里有、文件里没提，也要收录。
>
> 每个时间节点都要把公告、文件、讲义、正文和日历全部过一遍，再决定取哪个值。

- **公告**：老师经常在公告里改日期、补说明、发链接（分组截止、换课室、补课、测验范围……）。
  - 按时间从旧到新读，**较新的公告覆盖较旧的文件**；
  - 公告里的每一个日期都要判断：是考核或截止，还是其他节点（进 `milestones`）。
- **Canvas 作业**：`due` 是系统截止时间（UTC，要转成 +08:00）。
- **Blackboard 评分栏**：`due` 同样是 UTC。
- **菜单页**：Contacts 里有老师的联系方式和答疑时间。
- **外链**：`_files.md` 里标成「外链」的链接无法下载。如果看起来重要（例如作业说明放在 OneDrive 上），就写进 `openQuestions`。
- **用真实页面打开过的内容**（按 full-capture 方法新增，同样是一手来源）：
  - Blackboard「课程菜单」里的 LTI 工具（如 ZOOM）、内容树里的 LTI 条目（Resource List / Leganto 书单、Turnitin 作业页）：`captureMd` 段落里是页面上看得到的文字。
    - Zoom 的会议列表能反映固定上课时间，可以用来核对 `meetings`；
    - Leganto 书单直接进 `syllabus.textbooks`；
    - Turnitin 页面上的截止时间、说明，和评分栏、公告一起核对。
  - Blackboard 作业条目下的「作业详情页（说明 + 截止/满分）」：里面的 Due Date 是系统时间，Points Possible 是满分。满分不等于本课权重。
  - 内容树里标了「只在 HTML 页面上出现（API 没给）」的条目：照常读。
  - Canvas「导航 tabs」「模块里的外部工具」：外部工具页面上的文字照常读；状态是 `blank_frame` 表示这一轮页面空白，不代表没有内容，写进 `openQuestions` 等下轮。
  - 「接口状态」：`http-403` / `http-404` 表示学生没有权限或功能停用，不代表没有内容。

### 2.3 时间换算

- 平台给的 `...Z` 是 UTC，必须转成香港时间（+08:00）。例如 `2026-09-28T15:59:00Z` → `2026-09-28T23:59:00+08:00`。
- 第 N 周的周一 = `weekOneMonday` + 7×(N−1) 天。`weekOneMonday` 是 `null` 时不要按周次推算日期：只写 `week`，`due` 留 `null`、`confidence` 用 `unknown`，并在 `openQuestions` 里写明「第 1 周日期未确定」。
- 文件只写「Week N 课堂进行」时，日期 = 该周 `classDay` 那天，时间取那节课的开始时间，`confidence: "inferred"`。
- 只有日期、没有时间：记成 `T00:00:00+08:00`（看版会显示为不带时间），并在 notes 里写明「原文未给具体时间」。
- 自己推算出的日期，要核对原文里有没有提到假期或调课；有冲突就写进 `conflicts`。

## 3. 输出：更新 `data/courses/<CODE>.json`

保留现有字段结构，前端依赖这些字段。完整字段如下，带 ★ 的是本流水线新增的：

```jsonc
{
  "id": "ABC1234", "code": "ABC1234", "section": "A",
  "title": "英文原名", "titleZh": "中文名", "credits": 3,
  "platform": "Canvas|Blackboard", "canvasId": 0, "bbId": "_x_1", "bbCourseId": "…",
  "dept": "", "teacher": "", "teacherContact": "", "tutors": "", "url": "",
  "meetings": [{ "type": "Lecture|Lab|Tutorial|Seminar", "day": 1, "start": "09:30", "end": "11:20", "room": "TU101" }],
  "classDay": 4, "totalWeeks": 13,
  "sources": ["人能看懂的主要文件名", "…"],

  "syllabus": {                                   // ★ 大纲
    "summary": "中文 2–4 句：这门课学什么、怎么考",
    "ilos": ["Intended learning outcomes（保留英文原文）"],
    "topics": ["主要内容单元"],
    "textbooks": ["教材 / 主要参考"],
    "contacts": [{ "name": "", "role": "Lecturer|Tutor|TA", "email": "", "office": "", "phone": "", "consultation": "" }],
    "requirements": ["软件、先修、需带的材料等"],
    "sources": [SRC]
  },

  "rules": {
    "pass": "通过条件", "attendance": "出勤要求",
    "late": ["逾期规则逐条"], "misc": ["其他重要规则"],
    "sources": [SRC]                              // ★
  },

  "assessments": [{
    "id": "A1", "label": "Assessment 1", "name": "英文原名", "nameZh": "中文名",
    "weight": 15,                                 // 占本课总分的百分比；所有 assessments 合计必须 = 100
    "major": true,                                // 原文标明 major，或权重 ≥ 20
    "mode": "in-class|out-of-class|mixed|exam|unknown",
    "week": 5, "opens": null, "due": "2026-09-30T09:00:00+08:00",
    "dueRange": ["2026-11-03", "2026-11-17"],     // 可选：分组轮流进行时
    "confidence": "confirmed|inferred|unknown",
    "format": "一句话：形式 · 提交方式 · 字数/时长",
    "description": "★ 任务要求要点（中文，可多句）",
    "submission": "★ 提交位置与方式（Turnitin / Blackboard 作业区 / 课堂 …）",
    "groupwork": false,                           // ★
    "rubric": [{ "k": "评分维度", "v": 40 }],       // 维度权重（占这项考核的 %）
    "rubricLevels": [{                            // ★ 评分等级描述，原文有就写全
      "criterion": "Analysis", "weight": 40,
      "levels": [{ "band": "A+ / A (85–100)", "desc": "原文描述（英文原文，过长可截）" }]
    }],
    "subItems": [{ "name": "", "weight": 6, "due": null, "note": "" }],
    "notes": ["注意事项"],
    "topics": ["可选题目方向"],
    "url": "平台上的对应页面",                      // ★
    "sources": [SRC],                             // ★ 必填
    "conflicts": [{ "field": "due", "values": [{ "value": "…", "src": SRC }], "resolution": "采用哪个、为什么" }],
    "unverifiedSeed": false                       // ★ 见 §4
  }],

  "milestones": [{ "date": "ISO+08:00", "week": 4, "title": "", "detail": "", "kind": "critical|milestone", "sources": [SRC] }],
  "schedule": [{ "week": 1, "date": "YYYY-MM-DD", "title": "", "lab": "", "speaker": "", "kind": "lecture|assess|unit|holiday" }],
  "announcements": [{ "date": "ISO", "title": "", "summary": "中文 1–2 句", "actionItems": ["需要你做的事"], "url": "" }],  // ★ 最近 15 条，新→旧
  "openQuestions": ["★ 原文没写清、需要问老师的事"],
  "extractedAt": "本轮完成时间 ISO",
  "manualLock": []
}
```

### SRC（出处）格式——每个日期、权重、rubric 数字都要有

```jsonc
{ "file": "data/files/<CODE>/…/x.pdf", "page": 3, "quote": "原文片段" }            // 文件
{ "md": "data/text/<CODE>/_blackboard.md", "quote": "原文片段", "url": "…" }       // 平台数据
{ "file": "…", "page": 2, "quote": "你看图读到的原文", "vision": true }              // 只能看图得到的
```

- `quote` 必须是原文里**逐字存在**的一段（10–200 字符，保持原文语言）。build 会去掉空白后，在文本层或 md 里查这段文字，查不到会报「未核实引用」。
- 数字只在图片里出现时，才标 `"vision": true`，这种引用由核查 agent 复核。
- 最好直接引用包含该数字或日期的那一句，例如 `"Assessment 1 (15%) ... 30 September 2026, 9:00am"`。

## 4. 修改规则

1. **种子数据**（用户手工填、还没有 `sources` 的旧值）未必正确。每一项都要用现有材料核实：
   - 能核实：补上 `sources`；
   - 被材料推翻：按材料改，并记一条 change；
   - 找不到任何依据：**保留**，同时设 `"unverifiedSeed": true`，并把「XX 的依据未找到」写进 `openQuestions`。
2. 没有新材料推翻的内容一律保留，不要因为这轮没读到就删掉。
3. `manualLock` 里列出的路径（例如 `"assessments.A1.due"`、`"rules"`）不要改动。
4. 同一事项有多个来源说法不一时，优先级是：**较新的公告 > 较新的文件版本 > Canvas/Blackboard 系统截止时间 > 较旧文件**。把冲突写进 `conflicts`；无法判断时写 `unknown` 并加进 `openQuestions`。
5. 权重合计必须正好 100。原文拆分不清时，不要自己凑数，写进 `openQuestions`。
   例外：不计学分、完成即可（Pass/Complete）的课，比如全校性的完成制课程。这类课：
   - 顶层写 `"graded": false`，`credits` 写 `null`；
   - 每个组成部分照常列为 assessment，`weight` 写 0，`major` 写 false；
   - 完成要求（出勤、测验通过线、先修模块）写进 `format` / `notes` / `subItems`；
   - build 不会校验这类课的权重合计。
6. 课程小作业、问卷之类不计分的项目**不**放进 `assessments`；有截止日的可以放进 `milestones`（`kind: "milestone"`）。
7. 中文摘要风格参考现有条目：简洁、具体、带数字，英文原名保留。
8. 不要编造课室、时间、老师姓名；原文没有就留空或 `null`。

## 5. 变更记录

写入 `data/changes/pending/<CODE>.json`，每轮覆盖：

```json
{
  "course": "<CODE>", "at": "ISO",
  "items": [
    { "type": "new-assessment|date-change|weight-change|rubric|rule|new-info|announcement|new-file|conflict|seed-unverified",
      "title": "中文一句话（例：A1 截止改到 10/02 09:00）",
      "detail": "旧值 → 新值 / 补充说明",
      "ref": "assessments.A1.due",
      "src": { "…": "SRC" } }
  ]
}
```

- 新文件只记和考核、时间相关的（例如新发了 Assignment 2 说明），普通讲义不用记。
- 新公告都记一条 `announcement`，一句话写清楚要做什么。

## 6. 收尾

1. 运行 `node "<S>/check.mjs" <CODE>` 自检：它会确认 JSON 能解析、权重合计为 100、每个 assessment 都有 `sources`，并列出日期与周次、上课日对不上的地方。退出码不是 0 就修好再跑。
2. 更新 `extractedAt`。
3. **只**写 `data/courses/<CODE>.json` 和 `data/changes/pending/<CODE>.json`，不要碰别的课或别的文件。
   - 不要把名单（学生姓名、学号、分组名单）、个人成绩、提交记录写进 JSON。分组表、汇报时间表里只取全班通用的日期和规则。
   - `data/profile.md` 里关于这门课的事实（组号、班别、不适用的要求）是用户本人确认过的，**照办、不要推翻**。
     组别专属的日期（例如汇报时段）只取用户那一组那一行，不抄其他组；分了班的课，日期只取用户那个班。
     这门课分了组或分了班、但 `profile.md` 里没写用户是哪一组/哪个班时：只记全班通用的信息，并在 `openQuestions` 里写「需要你告诉我组号/班别」。
   - 用户自己转存的通知（邮件、截图、群消息）如果放在 `data/files/<CODE>/我收到的通知/`，也是一手来源：
     直接看原图（方法见 §2.0），引用时 `file` 写它的路径并标 `vision: true`。较新的通知同样覆盖较旧的文件。
4. 最后回复不超过 10 行：读了哪些关键文件（有没有看图）、改了什么、还有哪些 `unknown` 或 `openQuestions`。
