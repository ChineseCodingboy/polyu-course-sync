---
name: polyu-course-sync
description: PolyU（香港理工大学）课程同步。用用户本人登录的浏览器，把 Blackboard（learn.polyu.edu.hk）和 Canvas（canvas.polyu.edu.hk）上本学期每门课的公告、作业、评分栏、日历和课程资料全部抓下来。然后每门课派一个子 agent 读完全部材料，整理出评分构成、每项作业和考试的截止日与权重，每个数字都附原文出处；再派一个核查 agent 逐项对照原文。最后生成每门课的资料文件夹（全部资料加一页作业与考核）和本地看版。只要用户提到 PolyU、理大、Blackboard、Canvas 上的课程、作业、截止日（due、deadline）、考试、课程资料下载，或者说「同步课程」「课程有什么新东西」「这周要交什么」「学校登录过期了」「帮我设置课程同步」，或想把 PolyU 的课整理成待办和时间表，就用这个 skill，即使没提到 skill 名字。定时任务提示词里写了 mode=auto 时，按无人值守模式运行。
compatibility: Codex（CLI、IDE 插件或桌面 app）和 Claude Code 都能用，但只能在用户自己的电脑上运行，因为要打开浏览器让用户本人登录学校账号。需要 Node.js 18 以上；推荐装 Poppler 和 LibreOffice。macOS 已实测，Windows 和 Linux 应该能用，但没有测过。
---

# PolyU 课程同步

把用户在 PolyU **Blackboard**（learn.polyu.edu.hk）和 **Canvas**（canvas.polyu.edu.hk）上本学期每门课的材料抓下来，整理成**有出处、核对过**的作业与考核信息。产出两样东西：

- **每门课一个文件夹**，默认在 `~/Documents/PolyU 课程/<课号 课名>/`。里面是全部资料，加一页「00 作业与考核.html」：截止、权重、形式、要求、评分维度，出处直接链回原文件的那一页。
- **本地看版** `<WORK>/index.html`：总览、本周变化、时间轴和资料库，双击就能打开。

用 Claude 的话，还可以多建一个 claude.ai 上的「课程工作台」私密网页，见 `references/website.md`。

流水线：

1. 抓取（脚本）；
2. 转出文字层（脚本）；
3. 每门课一个提取子 agent；
4. 每门课一个核查子 agent；
5. 生成看版和文件夹（脚本）。

这是学生自己做的工具，与学校无关。它只用用户自己的账号，访问用户自己的课程。

## 路径与命令写法

- **`<SKILL_DIR>`**：本 skill 所在的目录，也就是这份 SKILL.md 所在的文件夹（Codex 一般在 `~/.agents/skills/polyu-course-sync`，Claude Code 一般在 `~/.claude/skills/polyu-course-sync`）。`<S>` = `<SKILL_DIR>/scripts`。
- **命令**：每一步都是 `node "<S>/<脚本>.mjs"`，在哪个目录下运行都可以。脚本只读写工作区，不改 skill 目录。
- **`<WORK>`**：工作区，放数据、登录态和依赖。
  - 默认位置：macOS 是 `~/Library/Application Support/polyu-course-sync`，Windows 是 `%LOCALAPPDATA%\polyu-course-sync`，Linux 是 `~/.local/share/polyu-course-sync`；
  - 用环境变量 `POLYU_HOME` 可以改到别处；
  - `node "<S>/setup.mjs" --where` 会打印实际路径。
- **配置**：在 `<WORK>/config.json`，用 `node "<S>/setup.mjs" --set 键=值` 修改，改完会马上同步到 `data/meta.json`。字段说明见 `scripts/lib/config.mjs` 开头。
- **脚本退出码**：`0` 成功；`2` 学校登录过期；`3` 还没装好，或者浏览器起不来（先跑 setup，Codex 里见「权限」一节）；`1` 其他错误，看输出。

## 不同工具里怎么做

| 要做的事 | Codex | Claude Code |
|---|---|---|
| 跑很久的命令（登录、抓取） | 用 `bg.mjs` 放到后台，分段等待（见同步步骤 1、2） | 同左 |
| 每门课一个子 agent | 派子 agent（subagents）：按本文模板，每门课一个、等全部完成 | Agent 工具，`subagent_type: "general-purpose"` |
| 看 PDF 页面、图片 | `node "<S>/pages.mjs" <文件> <页码>` 渲染成 PNG，再用 `view_image` 看 | Read 直接看；卡住时同左 |
| 联网、写工作目录以外的地方 | 沙盒默认不允许，见「权限」 | 见「权限」 |
| auto 模式的提醒 | `node "<S>/notify.mjs" "标题" "内容"` 发系统通知 | 有 PushNotification 工具就用它，没有就同左 |
| 定时自动同步 | Codex app 的 Automations，或 cron 调 `codex exec` | 桌面 app 的定时任务 |
| 网页版「课程工作台」 | 没有，用本地看版 | 可选，见 `references/website.md` |

派不了子 agent 的环境：自己按顺序逐门做。每门课都照 `references/extract-agent.md` 做完、`check.mjs` 通过，再做下一门。

## 底线

1. **账号密码只能由用户本人输入。** 登录时脚本会打开一个浏览器窗口，用户在里面完成统一登录（含二次验证）。
   - 不要替用户输入账号或密码，不要点登录页上的任何东西；
   - 不要让用户把密码发过来；用户主动给了也不要用。
2. **登录态不要碰。** `<WORK>/profile/` 和 `<WORK>/cookies.json` 只给脚本用：不要读取、打印、复制或外发。
3. **完全准确。** 宁可标「未定」，也不要猜。每个日期、每个权重都要能指回原文：这个 skill 就是为这个存在的。
4. **隐私与版权。**
   - 不抓名单、成绩、提交记录；
   - 课程材料只留在本机给用户自己看，不上传、不外传。
5. **视频和音频不下载**，只登记名字和平台链接。用户明确要下载时，再 `--set downloadMedia=true`。

## 只是问问（不用同步）

用户只是问「这周要交什么」「某门课的 project 什么时候交、占多少」，并且之前已经同步过，就直接用现有数据回答：

- 读 `<WORK>/data/courses/<CODE>.json` 里的 `assessments`、`milestones` 和 `openQuestions`；
- 读 `<WORK>/data/sync-status.json` 里的 `lastFetch.at`，看数据有多新。

回答时：

- 带上日期、权重和出处（文件名加页码）；
- 推算出来的日期（`confidence: "inferred"`）要说明是推算的；
- 数据超过 3 天没更新，提一句可以先「同步课程」。

## 第一次使用

按顺序做，每一步都告诉用户现在在做什么。

- **时间**：第一次完整跑下来大约 1–2 小时，大部分花在抓取和逐课阅读上。
- **用量**：全量提取比较耗用量。额度不够时可以分几次做，已经提取过的课不会重做。

1. **安装**：运行 `node "<S>/setup.mjs"`。它会建工作区，把 playwright 和 Chromium 装进工作区，并检查 Poppler 和 LibreOffice。
   - 这一步要联网、要写工作目录以外的地方。在 Codex 里会请用户批准在沙盒外运行，或者先按「权限」一节改好配置。
   - 提示没装 Poppler 时，把安装命令告诉用户。没装也能用，只是 PDF 抽不出文字，子 agent 只能看图，会慢很多。
   - 需要用户自己在终端里装东西时，给出命令就停下来，等用户装好再继续。
2. **确认设置**：把 setup 打印的学期和课程文件夹位置告诉用户，问一句对不对。
   - 学期不对：`--set semester=2026-2`。格式是「学年起始年-学期序号」，3 是暑期。
   - 想换课程文件夹的位置：`--set "coursesFolder=..."`。
3. **权限（推荐）**：照「权限」一节，把要改的设置告诉用户，**用户同意后**再改。不改的话，每次同步都会反复请用户批准。
4. **登录**：第一次没有登录态，不用先 probe，直接照「同步步骤」第 1 步里的登录方法做。
5. **第一次抓取**：照「同步步骤」第 2 步。
6. **确定第 1 周的周一和教学周数**。很多日期只写了「Week N」，要靠它换算成具体日期。
   - 先用 `--where` 看配置里现在的值。
   - 找证据：
     - 在各课的 `<WORK>/data/text/<CODE>/_files.md` 里，找文件名带 Schedule、Timetable、Calendar、Teaching Plan 的文件，读它的文本层。这类文件多半是表格，要看图核对。
     - 也可以搜：`grep -rniE 'week ?0?1\b|first (lecture|class)|will (begin|start)' "<WORK>/data/text" --include='*.txt' --include='_*.md' | head -40`
   - 有两门以上的课对得上：告诉用户结论和证据，然后写进配置，例如 `--set weekOneMonday=2026-08-31 totalWeeks=13`。日期必须是周一；周数只算教学周，个别课在考试周交东西不算。
   - 对不上或找不到：问用户，学校校历上有。
7. **全量提取与核查**：照「同步步骤」第 3–6 步，按 `changed.mjs` 的输出做。第一次通常每门课都是 `full`；如果之前分几次做过，有的课会是 `incremental`，照做即可。
8. **收尾**：照第 8、9 步生成课程文件夹，然后汇报。最后问用户要不要定时自动同步（见 `references/automation.md`）；用 Claude 的话，再问要不要建「课程工作台」网页（见 `references/website.md`）。

## 权限

工作区和课程文件夹一般不在当前工作目录里，抓取还要联网。先运行 `node "<S>/setup.mjs" --where`，拿到实际路径再改设置。

### Codex

沙盒默认不联网，也只能写当前工作目录和临时目录。两种做法，二选一：

- **不改配置**：Codex 跑 setup、login、fetch、folders 这些命令时，会请用户批准在沙盒外运行。每次同步要批准几次。
- **改一次配置**（用户同意后）：在 `~/.codex/config.toml` 里加上：
  ```toml
  [sandbox_workspace_write]
  network_access = true
  writable_roots = ["<WORK 的绝对路径>", "<coursesFolder 的绝对路径>"]
  ```
  改完要重启 Codex。浏览器在沙盒里起不来（脚本退出码 3、提示「浏览器启动失败」）时，登录和抓取这两步仍然要在沙盒外运行。

子 agent 继承同样的沙盒设置。auto 模式下没人批准，所以要定时同步的话，必须先改好配置。

### Claude Code

用户同意后，用 `update-config` skill 把下面的规则加进 `~/.claude/settings.json` 的 `permissions.allow`，写法以那个 skill 为准：

- `Read(<SKILL_DIR>/**)`：读本 skill 的说明书；
- `Read(<WORK>/**)` 和 `Edit(<WORK>/data/**)`：读写工作区的数据；
- `Read(<coursesFolder>/**)`：读课程文件夹里的原文件；
- `Bash(node "<S>/*)`：运行同步脚本（命令里脚本路径带引号，规则里也要带）；
- `Bash(pdftoppm *)`：把 PDF 页面渲染成图片；
- `ArtifactData`：只有建了网页才需要。

Read、Edit 规则里的绝对路径（以 `/` 开头）要写成 `//` 开头，例如 `Read(//Users/name/…)`；以 `~` 开头的照写。加完后跑一次 `node "<S>/setup.mjs" --check`，确认不再弹确认。

## 关于我（`<WORK>/data/profile.md`）

有些事实平台上看不出来：用户在哪一组、在周几那个班、哪条要求不适用于他。这类事实记在 `data/profile.md`，一行一条，写明课号。提取和核查 agent 都会照办，不会推翻。

- 用户在对话里说了这类事实，就加进 `profile.md`，并告诉用户已经记下。
- 子 agent 汇报「这门课分了组，但不知道用户在哪组」时，去问用户，不要自己猜。
- 用户转来的通知（邮件、截图、群消息）存进 `<WORK>/data/files/<CODE>/我收到的通知/`。这个目录就在课程文件夹里，名字一样。下次提取时 agent 会读，当作一手来源。

## 模式

| 模式 | 什么时候用 | 登录过期时 |
|---|---|---|
| **manual**（默认） | 用户在对话里叫你同步 | 打开浏览器窗口，**由用户自己**登录，然后继续 |
| **auto** | 定时任务（提示词里写了 `mode=auto`） | 不开窗口：跳过抓取，用已有材料跑完其余步骤，最后提醒用户登录 |

- 用户说「全部重新提取」：第 3 步加 `--all`。
- 用户只说「重新登录」：只做第 1 步。

## 同步步骤

### 0. 检查安装

```bash
node "<S>/setup.mjs" --check; echo "exit=$?"
```

- `exit=3`：还没装好，先运行 `node "<S>/setup.mjs"`。第一次使用的话，从上一节开始。
- 输出里说第 1 周周一还没设：先做「第一次使用」第 6 步。

### 1. 检查登录

```bash
node "<S>/probe.mjs"; echo "exit=$?"
```

- `exit=0`：继续。
- `exit=3`：浏览器起不来，见「权限」一节。
- `exit=2`，manual 模式（登录方法）：
  1. 告诉用户：「学校登录过期了（第一次用就说：需要先登录学校账号），我打开一个浏览器窗口，请在里面完成 PolyU 登录，包括二次验证，最多等 20 分钟。」
  2. 启动登录窗口，然后等结果：
     ```bash
     node "<S>/bg.mjs" start login --timeout=20
     node "<S>/bg.mjs" wait login
     ```
     `wait` 每次最多等 4 分钟。退出码是 100，说明用户还在登录，再运行一次 `wait`。
  3. 最后的退出码是 0 就继续；否则告诉用户没有登上，停在这里。
- `exit=2`，auto 模式：记下「登录过期」，跳过第 2 步。

### 2. 抓取、转换、完整性报告

```bash
node "<S>/bg.mjs" start fetch
node "<S>/bg.mjs" wait fetch
```

- **fetch 要 20–30 分钟。** `wait` 每次最多等 4 分钟：
  - 退出码 100 表示还在跑，会打印进度（到了第几门课、下载了多少文件），过一会儿再运行 `wait`；
  - 结束后打印结果，退出码就是 fetch 自己的退出码。
  - 不要中途停掉：fetch 最后才写结果，停掉等于白抓。重复 `start` 不会开第二个。
- **fetch 的退出码**：
  - `0`：两个平台都抓完了；
  - `1`：有课这一轮没抓完整（已自动保留上一轮的数据），在汇报里点名；
  - `2`：某个平台登录过期，另一个照常抓了。登录之后，只补抓那个平台：`node "<S>/bg.mjs" start fetch --only=canvas`（或 `--only=blackboard`）。
- **结果里要留意的行**：
  - `✚ 新课程`：新发现的课；
  - 「清单…」开头的行：课程清单的变化。出现「换了 ID」要在汇报里提醒。
- **课程列表不对**（多了上学期的课，或少了某门课）：
  - 看 `<WORK>/data/inventory.json` 里每门课的 `selected` 和 `reason`；
  - 学期不对：`--set semester=…`；
  - 不想抓的课：`--set skipCourses=ABC1234`。

fetch 结束后：

```bash
node "<S>/convert.mjs" | tail -15
node "<S>/coverage.mjs"
```

- convert 要转换的文件很多时（第一次），也可以用 `bg.mjs start convert` / `bg.mjs wait convert`。
- coverage 对每门课输出 `✓ 完整` 或 `⚠ 部分`，以及缺口原因。原样带进汇报。

### 3. 决定哪些课要提取

```bash
node "<S>/changed.mjs"          # 用户要求全部重做时加 --all
```

- 输出是一个 JSON 数组，每项有 `code`、`platform`、`mode`（full / incremental）、`reason`、`changedPlatformData`、`changedFiles`。
- 数组为空：跳到第 6 步。
- 数组不为空：先备份，`node "<S>/build.mjs" --snapshot`。它会顺便把最新的学期配置写进 `data/meta.json`，提取 agent 要读。

### 4. 第一波：提取（每门课一个子 agent）

每门课派一个子 agent（Claude Code 里 description 写「提取 <CODE>」）。

- **同时最多 3 个**，完成一个再补一个。并行太多会撞上用量上限，全部白跑。
- 等**全部**提取 agent 都完成，再往下走。完成通知会逐个到达，期间不要重复派发。
- 子 agent 看 PDF 页面卡住、很久没有反应时：重派，并在 prompt 里加一句「看图一律先用 pages.mjs 渲染成 PNG」。

prompt 模板。尖括号都换成实际内容；某一项没有内容就写「无」：

```
你是 PolyU 课程 <CODE> 的提取 agent。
先完整阅读 <SKILL_DIR 的绝对路径>/references/extract-agent.md，并严格照做。

工作区（说明书里写作 <WORK>）：<工作区的绝对路径>；下面的 data/… 都相对它。
脚本目录（说明书里写作 <S>）：<SKILL_DIR 的绝对路径>/scripts
第 1 周周一：<weekOneMonday>；教学周数：<totalWeeks>
课号：<CODE>（<platform>）
模式：<mode>（<reason>）
本轮有变化的平台数据：<changedPlatformData，逐行>
本轮新增/变更的文件：<changedFiles，逐行；超过 60 个时写「见 _files.md 里最近变更日期为今天的文件」>
关于我（data/profile.md 里和这门课有关的行）：<原样抄过来>

用户要求完全准确：表格、扫描页、图片一律看原图核对；每个日期和权重都要附原文引用。
平台数据里用真实页面打开过的内容（LTI 工具、作业详情页、导航页）同样是一手来源。
只写 data/courses/<CODE>.json 和 data/changes/pending/<CODE>.json。
```

### 5. 校验，然后第二波：核查

```bash
node "<S>/build.mjs" 2>&1 | tail -40
```

- 每门课输出一行：先是 `✓` 或 `✗ 已回滚（原因）`，后面是「引用 x/y 核实」、看图核对的条数、未核实的条数和提示。
- 被回滚的课（JSON 坏了、权重合计不是 100、日期格式不对）：把错误原因写进这门课的核查 prompt；或者重新派一个提取 agent。

再备份一次（`node "<S>/build.mjs" --snapshot`），然后为第 4 步的每门课派一个核查 agent（description 写「核查 <CODE>」），同样最多 3 个并行。prompt 模板：

```
你是 PolyU 课程 <CODE> 的核查 agent。
先完整阅读 <SKILL_DIR 的绝对路径>/references/verify-agent.md 和 extract-agent.md，并严格照做。

工作区（说明书里写作 <WORK>）：<工作区的绝对路径>
脚本目录（说明书里写作 <S>）：<SKILL_DIR 的绝对路径>/scripts
第 1 周周一：<weekOneMonday>；教学周数：<totalWeeks>
课号：<CODE>
build 报告：<这门课在 build 输出里的几行，含未核实引用数和提示>
关于我：<同上>
逐项核对 data/courses/<CODE>.json 与原文，修正错误、补上遗漏。
只写 data/courses/<CODE>.json 和 data/changes/pending/<CODE>.json。
```

### 6. 生成看版

```bash
node "<S>/build.mjs" 2>&1 | tail -40
```

第 3 步没有课要提取时也要跑：它会刷新看版上的同步状态。

### 7. 网页（只有 Claude、并且 config.json 里有 siteUrl 时才做）

照 `references/website.md` 里「每次同步后写入数据」一节：先运行 `node "<S>/site-export.mjs"`，再用 ArtifactData 分批写入。

### 8. 课程文件夹

```bash
node "<S>/folders.mjs"
```

- 在每门课的文件夹里生成「00 作业与考核.html」，内容有：
  - 截止、权重、形式、要求、细分、评分维度；
  - 出处链接，PDF 直接跳到那一页；
  - 其他时间节点；
  - 全部资料的目录。
- 第一次运行时，会把资料从工作区搬进课程文件夹，工作区里只留一个链接指过去。资料只存一份。

### 9. 汇报

先读 `<WORK>/data/changes/` 里今天的文件、`<WORK>/data/courses/*.json` 和 `<WORK>/data/coverage.md`。

**manual 模式**：在对话里，用用户的语言写这五部分。

1. **本次变化**：按课列出。先写日期或权重的改动、新考核，以及公告里要求做的事。
2. **14 天内到期**：每项写日期、课号、考核名称、权重。推算出来的日期要标出来。
3. **需要你确认**：
   - `unknown` 项和 `openQuestions`；
   - 分了组、但不知道用户在哪一组的课；
   - 下载失败、或只有外链的重要文件。
4. **抓取完整性**：
   - 两个平台各自 ✓ 或 ✗；
   - 课程清单的变化；
   - 每门显示「部分」的课和缺口原因；
   - 被回滚的课，以及未核实引用的数量。
5. **去哪看**：
   - 课程文件夹的路径；
   - 本地看版 `<WORK>/index.html`，可以用 `open`（Windows 用 `start`）帮用户打开；
   - 建了网页的话，附上 siteUrl。

**auto 模式**：只在下面两种情况提醒用户，一行，少于 200 字。有推送工具（例如 Claude 的 PushNotification）就用它；没有就运行 `node "<S>/notify.mjs" "PolyU 课程同步" "<内容>"` 发系统通知。

- 登录过期：「学校登录过期了，打开 Codex（或 Claude）说『同步课程』重新登录」；
- 有日期或权重改动、新考核，或 7 天内有截止：「<最重要的 1–2 条>；共 N 处变化」。

其他情况不提醒，只在会话里留下和 manual 模式一样的汇报。

## 换学期

新学期开始了、课程清单里全是上学期的课，或者用户说「换学期了」：

1. 运行 `node "<S>/setup.mjs" --archive`。它会：
   - 把上学期的数据挪到 `<WORK>/archive/<学期>/`，不删除；课程文件夹原样保留；
   - 把学期改回按日期推算，清空第 1 周周一。
2. 看一眼 `data/profile.md`，删掉上学期的行（拿不准就问用户）。
3. 从「第一次使用」第 4 步（登录）开始，重新走一遍。

## 排错

- **脚本退出码 3**：没装好或浏览器起不来。先跑 `node "<S>/setup.mjs"`；在 Codex 里，再让这条命令在沙盒外运行（见「权限」）。
- **fetch 出现大量「接口失败」**：通常是网络抖动，脚本已经重试过 3 次。隔几分钟再跑 fetch；已经下载的文件不会重复下载。
- **单个文件显示「返回的是网页（需要登录或无权限）」**：这个文件没有权限或已经下架。它会被记为下载失败，在汇报里点名。
- **LTI 或导航页显示 `blank_frame`**：这一轮页面是空白的，不代表没有内容，下轮会自动重试。连续几轮都空白，就提醒用户去平台上手动看一眼。
- **LibreOffice 转换卡住**：结束 soffice 进程（macOS / Linux 用 `pkill -f soffice`），再跑 convert。
- **bg.mjs 说「意外中断」**：多半是电脑睡眠或进程被结束。重新 `start` 即可，已下载的文件不会重复下载。
- **看版上的周次不对**：检查 `config.json` 里的 `weekOneMonday` 和 `totalWeeks`。
- **想手工改某个值，又不想被下次提取覆盖**：把字段路径写进那门课 JSON 的 `manualLock`，例如 `"assessments.A1.due"`。
- **抓取方法、数据布局、为什么显示「部分」**：见 `references/methodology.md`。
