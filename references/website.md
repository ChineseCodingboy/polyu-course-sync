# 「课程工作台」网页（可选，只有 Claude 能用）

这一节只适用于 Claude（Claude Code 或 Claude 桌面 app），并且要有 Artifact 和 ArtifactData 工具。Codex 用户没有这个功能，用本地看版 `<WORK>/index.html` 就好，内容差不多。

一个只有用户自己能看的 claude.ai 私密 Artifact：首页是待办（每项可以展开看要求、形式、提交方式、评分和出处，能勾选完成），
再往下是每门课的完成进度；每门课还有自己的一页（老师与上课时间、作业与考核、时间节点、全部资料的平台链接）。
手机上打开 claude.ai 也能看。

- 页面源码：`<SKILL_DIR>/assets/course-desk.html`。只有第一次、或 skill 更新改了这个文件时才需要发布。
- 课程数据存在 Artifact 自带的数据库里，每次同步后用 ArtifactData 写入，**不用重新发布页面**。
- 「标记完成」存在每位查看者自己的 `data/users/<id>/state` 里，对其他人不可见。同步流程不要碰它。
- 网页里只有摘要、出处索引和平台链接：原文件、本地路径和登录态都不会上传。

## 第一次建网页

1. 先问用户要不要建网页。用户同意后，加载 `artifact-capabilities` skill：发布时声明 capabilities 之前必须先读它，写法以它为准。
2. 用 Artifact 工具发布 `<SKILL_DIR>/assets/course-desk.html`：
   - 这是一个新的 Artifact，所以不传 `url`；
   - icon 用 `calendar`，description 写「PolyU 课程待办与进度」；
   - 声明两项能力：`db` 和 `user`。
     - `courses`、`site` 两个集合只让所有者写（数据由 Claude 用 ArtifactData 写入），查看者只读；
     - 页面自己只写当前查看者的 `data/users/<id>/state`，这个路径本来就只有本人可见。
   - 按 artifact-capabilities 的写法，大致是：
     ```json
     { "db": { "rules": [
         { "path": "courses", "read": "view", "write": "owner" },
         { "path": "site",    "read": "view", "write": "owner" } ] },
       "user": {} }
     ```
3. 把链接记进配置：`node "<S>/setup.mjs" --set siteUrl=<发布结果里的链接>`。
4. 马上按下面「每次同步后写入数据」写入一次。然后做一遍功能检查：
   - 用 ArtifactData 分别 `list` 一次 `courses` 和 `site`，确认文档都在；
   - 请用户在网页上勾选一项待办，再 `list` 一次 `data/users/me`，确认有一个 `state` 文档、里面的 `done` 记下了这一项。
   - 用一句话告诉用户检查了什么、哪些没法检查。
   - 网页默认只有用户自己能打开。上面的 rules 只在用户把网页分享给别人时才起作用：别人能看，但改不了课程数据。

## 每次同步后写入数据

`config.json` 里有 `siteUrl` 才做这一步。

```bash
node "<S>/site-export.mjs"
```

它会生成 `<WORK>/data/site/<collection>__<doc>.json`，以及分好批的 `<WORK>/data/site/batches.json`（每批不超过 50 个文档、900 KiB）。生成的文档有两类：

- `site/meta`：学期第一周周一、总周数、生成时间、两个平台的登录是否有效、课程顺序；
- `courses/<CODE>`：课号、课名、平台链接、老师与上课时间、每项任务的详情、时间节点、资料清单。资料只给平台链接，不列视频和录播。

写入步骤（ArtifactData，`url` = `siteUrl`）：

1. 用 `list` 读 `courses`、`site` 两个集合（`query.limit` 设 1000），记下每个文档的 `version`。
2. 按 `batches.json` 逐批调用 `batch`，每个条目写成 `{op: "set", collection, doc_id, file_path}`。已存在的文档必须带 `if_version`，新文档不带。
3. 数据库里有、但本轮导出没有的课，用 `delete` 删掉（同样带 `if_version`）。
4. 某一批因为版本冲突被拒：重新 `list`，再重做那一批。

## 页面本身要更新时

只有 skill 更新改了 `assets/course-desk.html`、或者用户要求改版式时才需要：

- 用 Artifact 工具发布这个文件，`url` 用 `siteUrl`；
- **不传 `capabilities`**，沿用已经存好的声明。传了就会覆盖原来的声明。
