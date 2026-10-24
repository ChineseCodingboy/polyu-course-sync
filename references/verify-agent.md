# 单课核查 agent 说明书

提取 agent 已经更新了 `data/courses/<CODE>.json`。你是**独立的第二双眼睛**，任务是找出错误并修正。
不要轻信现有的值，逐项回到原文去核对。

工作区根目录由编排者在 prompt 里给出（写作 `<WORK>`）。字段含义、出处格式、修改规则都和
`references/extract-agent.md` 一致，先把它读一遍（包括 `data/profile.md` 的用法）。

## 输入

- `data/courses/<CODE>.json`
- `data/grounding/<CODE>.json`：build 自动核对的结果，列出每条 `quote` 是否在原文里找到（`ok | missing | vision`）
- `data/text/<CODE>/_files.md`、`_canvas.md` / `_blackboard.md`、各文件的文本层与原文件
- `data/profile.md`：用户本人确认过的事实，不要推翻

三个辅助脚本（在 skill 的 `scripts/` 目录，编排者会在 prompt 里给出路径 `<S>`）：

- `node "<S>/check.mjs" <CODE>`：列出每个日期的星期、周次、是否落在上课日，权重和 rubric 合计，以及每条出处的核实状态。先跑它，⚠ 的地方优先查。
- `node "<S>/pages.mjs" <文件> <页码>`：把 PDF 页渲染成 PNG 给你看图（见 extract-agent.md §2.0）。
- `node "<S>/omissions.mjs" <CODE>`：列出材料里出现、但 JSON 里还没有的日期和出处。逐个回原文判断是不是漏掉的考核、截止或节点。

## 逐项核查清单

对**每一个** assessment、milestone 以及 rules 里的数字，逐一检查：

1. **出处真实**：打开 `sources` 指向的文件和页码，读原文，必要时看图。确认 quote 确实存在，而且确实支持这个值。
   - grounding 结果为 `missing` 的，一定要查：可能是 quote 抄错了，也可能是值本身错了。
   - `vision` 的引用，一定要亲自看那一页的图（方法见 extract-agent.md §2.0）。
2. **权重**：每项的 weight 与原文一致；全部 assessments 合计 = 100；rubric 各维度的 `v` 合计 = 100（原文本来就不是 100 的除外，要在 notes 里说明）。
3. **日期与时间**：
   - UTC 已转成 +08:00；
   - 星期几和原文一致；
   - `week` 与日期对得上：第 N 周周一 = `data/meta.json` 的 `weekOneMonday` + 7×(N−1)；
   - in-class 的日期必须落在该课的上课日；
   - `opens` 早于 `due`。
4. **confidence**：
   - 原文写明了具体日期 → `confirmed`；
   - 由周次推算 → `inferred`；
   - 没写 → `unknown`。
   标错的要改正。
5. **遗漏**：先看 `omissions.mjs` 的输出，再在 `_*.md` 和所有 A 类文件里搜索 `%`、`weight`、`marks`、`due`、`deadline`、`submit`、`quiz`、`test`、`exam`、`presentation`，还有日期写法（`\d{1,2} (Sep|Oct|Nov|Dec)`、`\d{1,2}/\d{1,2}`、`Week \d+`）。原文里出现、但 JSON 里没有的考核或截止日，要补上。
   - 老师常常不把事项加进日历或评分栏，所以**不能**以日历为准来判断「是否齐全」。
   - 公告正文、公告附件和讲义里的日期最容易漏，要逐条对照。
6. **冲突**：比较公告与文件、新旧版本文件、平台截止时间与文件写的时间，看是否一致。不一致的，要么已经写进 `conflicts` 并采用了正确的一方，要么由你补上。
7. **大纲**：`syllabus.contacts` 里的邮箱、办公室逐字核对；ILOs 确实来自 SDF 或 syllabus。
8. **unverifiedSeed**：再尽力找一次依据。找到了就去掉这个标记并补上 `sources`；仍然找不到就保留标记。

## 修正与记录

- 直接修改 `data/courses/<CODE>.json`，并写入：
  ```json
  "verification": { "at": "ISO", "checked": 23, "fixed": ["A2 截止时间 23:59 → 09:00（Assessment 2 Guide p.3）"], "unresolved": ["…"] }
  ```
- 每修正一处，往 `data/changes/pending/<CODE>.json` 的 `items` 里**追加**一条（`type` 用原有类型；`title` 以「核查修正：」开头）。不要删掉已有的条目。
- 只写这两个文件。
- 最后回复不超过 8 行：检查了多少项、修正了什么、还有什么无法确认。
