# PolyU 课程同步（polyu-course-sync）

让 AI 助手（Codex 或 Claude Code）把你在 PolyU Blackboard 和 Canvas 上本学期每门课的公告、作业、资料全部抓下来。它会逐门读完材料，整理出每项作业和考试的截止日、权重和要求，每个数字都附原文出处，再逐项核对一遍。最后你会得到：

- **每门课一个文件夹**（默认在「文稿 › PolyU 课程」）：全部资料，加一页「00 作业与考核.html」，出处点开直接跳到原文件那一页；
- **本地看版**：所有课的截止日、时间轴、本周变化，双击打开。

这是学生自己做的工具，与学校无关。它只用你自己的账号，访问你自己的课程。

## 安装

1. 装 [Node.js](https://nodejs.org)（18 以上）。推荐再装 Poppler 和 LibreOffice，用来抽 PDF 和 Office 文件里的文字：
   - macOS：`brew install poppler`、`brew install --cask libreoffice`
   - Windows：`scoop install poppler`（或 `choco install poppler`），LibreOffice 从官网下载安装
   - 没装也能用，AI 会告诉你缺什么。
2. 把这个仓库克隆到 skill 目录里，然后重启 Codex（或 Claude Code）：
   - **Codex**：
     ```bash
     git clone https://github.com/ChineseCodingboy/polyu-course-sync.git ~/.agents/skills/polyu-course-sync
     ```
     Windows 上目标路径是 `%USERPROFILE%\.agents\skills\polyu-course-sync`。
   - **Claude Code**：
     ```bash
     git clone https://github.com/ChineseCodingboy/polyu-course-sync.git ~/.claude/skills/polyu-course-sync
     ```
   - 没装 git 的话，在仓库页面点 Code → Download ZIP。解压后把文件夹改名为 `polyu-course-sync`，放到上面同样的位置。
3. 对 AI 说「帮我设置课程同步」。Codex 里也可以输入 `$polyu-course-sync` 点名调用。

以后要更新到最新版，在 skill 目录里运行 `git pull` 即可。你的数据在工作区里，更新不会动到它。

## 会发生什么

- **第一次**，大约 1–2 小时，比较耗额度：
  1. 安装依赖；
  2. 弹出一个浏览器窗口，**你自己**在里面登录 PolyU（含二次验证）；
  3. 抓取 20–30 分钟；
  4. 逐门课整理、核对；
  5. 生成课程文件夹和看版。
- **以后**：说「同步课程」就行，只处理有变化的课。
- 只想问「这周要交什么」时，AI 会直接用上次的结果回答，不重新抓。

## 注意

- **密码只在弹出的浏览器窗口里由你自己输入。** 不要把密码发给 AI，它也不会替你输入。
- **学校登录几小时到一天就会过期。** 所以每次同步通常都要重新登录一次。
- **Codex 默认的沙盒不能联网，也不能写当前文件夹以外的地方。** 第一次使用时，它会请你批准几条命令在沙盒外运行。也可以照 SKILL.md「权限」一节改一次配置，以后就不用反复批准。
- **课程材料的版权属于学校和老师。** 只给自己用，不要上传或外传。
- **登录态和资料都只在你自己的电脑上**（工作区默认在 `~/Library/Application Support/polyu-course-sync`，Windows 在 `%LOCALAPPDATA%\polyu-course-sync`）。

## 许可

[MIT](LICENSE)。
