#!/usr/bin/env node
/**
 * 安装与配置。代码留在 skill 里，数据、登录态和依赖都放进工作区（路径见 lib/config.mjs）。
 *
 *   node setup.mjs                      建工作区、写默认配置、装 playwright 和 Chromium、检查转换工具
 *   node setup.mjs --check              只检查，不安装；退出码 0 = 可以同步，3 = 需要先跑 setup
 *   node setup.mjs --where              以 JSON 打印各个路径和学期（给 AI 助手用）
 *   node setup.mjs --set k=v [k=v …]    改配置，例如：
 *       --set weekOneMonday=2026-08-31   第 1 周的周一
 *       --set semester=2026-2            指定学期（不设就按日期推算）
 *       --set "coursesFolder=~/Documents/PolyU 课程"
 *       --set skipCourses=ABC1234,DEF5678
 *       --set downloadMedia=true
 *       --set siteUrl=https://claude.ai/artifact/…
 *   node setup.mjs --archive            换学期：把上学期的数据挪到 archive/<学期>/（不删除），课程文件夹不动
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WORK, CONFIG_PATH, COURSES_FOLDER, SEMESTER, DEFAULTS, readConfig, writeConfig, syncMeta, SKILL_DIR } from './lib/config.mjs';

const PW_VERSION = '1.62.1';
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const isWin = process.platform === 'win32';

/* ── --set ── */
if (has('--set')) {
  const patch = {};
  for (const kv of args.filter((a) => a.includes('='))) {
    const i = kv.indexOf('=');
    const k = kv.slice(0, i).trim();
    let v = kv.slice(i + 1).trim();
    if (!(k in DEFAULTS)) { console.error(`✗ 不认识的配置项 ${k}（可用：${Object.keys(DEFAULTS).join(', ')}）`); process.exit(1); }
    if (v === '' || v === 'null') v = null;
    else if (k === 'weekOneMonday') {
      const d = new Date(`${v}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(d) || d.getUTCDay() !== 1) { console.error(`✗ weekOneMonday 要是一个周一，格式 YYYY-MM-DD（收到 ${v}）`); process.exit(1); }
    } else if (k === 'semester') {
      if (!/^\d{4}-[123]$/.test(v)) { console.error('✗ semester 格式是 学年起始年-学期，例如 2026-1（第一学期）、2026-2（第二学期）、2026-3（暑期）'); process.exit(1); }
    } else if (k === 'totalWeeks') {
      v = Number(v);
      if (!Number.isInteger(v) || v < 1 || v > 30) { console.error('✗ totalWeeks 要是 1–30 的整数'); process.exit(1); }
    } else if (k === 'downloadMedia') {
      v = /^(1|true|yes)$/i.test(v);
    } else if (k === 'skipCourses') {
      v = v.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    } else if (k === 'siteUrl' && !/^https:\/\/claude\.ai\/(code\/)?artifact\//.test(v)) {
      console.error('✗ siteUrl 应该是 claude.ai 的 Artifact 链接'); process.exit(1);
    }
    patch[k] = v;
  }
  const next = writeConfig(patch);
  syncMeta();   // 提取 agent 读 data/meta.json，改完马上同步过去
  console.log(`✓ 已写入 ${CONFIG_PATH}（data/meta.json 已同步）`);
  for (const k of Object.keys(patch)) console.log(`   ${k} = ${JSON.stringify(next[k])}`);
  process.exit(0);
}

/* ── --archive：换学期时把上学期的数据挪走（不删除）。课程文件夹和指向它们的链接（data/files）、
 *    关于我（profile.md）留下：跨两个学期的课（如毕业设计）新学期的资料会接着放进同一个文件夹 ── */
if (has('--archive')) {
  const data = join(WORK, 'data');
  if (!existsSync(data)) { console.log('没有需要归档的数据。'); process.exit(0); }
  let tag = 'old';
  try { tag = JSON.parse(readFileSync(join(data, 'meta.json'), 'utf8')).semester || tag; } catch { /* 没有 meta 就用 old */ }
  let dest = join(WORK, 'archive', tag);
  if (existsSync(dest)) dest += `-${new Date().toISOString().slice(0, 10)}`;
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(data)) {
    if (name === 'files' || name === 'profile.md') continue;
    renameSync(join(data, name), join(dest, name));
  }
  for (const d of ['data/courses', 'data/changes/pending']) mkdirSync(join(WORK, d), { recursive: true });
  writeConfig({ semester: null, weekOneMonday: null });
  console.log(`✓ 上学期的数据已挪到 ${dest}（课程文件夹里的资料原样保留）`);
  console.log('   学期改回按日期推算、第 1 周周一已清空；关于我（data/profile.md）留着，过时的行记得删掉。');
  process.exit(0);
}

/* ── --where ── */
if (has('--where')) {
  const c = readConfig();
  console.log(JSON.stringify({
    skill: SKILL_DIR, scripts: join(SKILL_DIR, 'scripts'), work: WORK, data: join(WORK, 'data'), config: CONFIG_PATH,
    coursesFolder: COURSES_FOLDER, dashboard: join(WORK, 'index.html'), profile: join(WORK, 'data', 'profile.md'),
    semester: { id: SEMESTER.id, label: SEMESTER.label, auto: SEMESTER.auto },
    weekOneMonday: c.weekOneMonday, totalWeeks: c.totalWeeks, siteUrl: c.siteUrl,
  }, null, 2));
  process.exit(0);
}

/* ── 检查与安装 ── */
const check = has('--check');
const ok = (s) => console.log(`✓ ${s}`);
const warn = (s) => console.log(`⚠ ${s}`);
const bad = (s) => console.log(`✗ ${s}`);
let ready = true;

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) { bad(`Node.js ${process.versions.node} 太旧，需要 18 以上（https://nodejs.org）`); process.exit(3); }

mkdirSync(WORK, { recursive: true });
for (const d of ['data/courses', 'data/changes/pending']) mkdirSync(join(WORK, d), { recursive: true });
if (!existsSync(CONFIG_PATH)) {
  if (check) { bad(`还没有配置文件 ${CONFIG_PATH}`); ready = false; } else writeConfig({});
}
const profile = join(WORK, 'data', 'profile.md');
if (!existsSync(profile) && !check) {
  writeFileSync(profile, [
    '# 关于我',
    '',
    '提取 agent 每次都会读这份文件。只记跟课程信息判断有关、平台上看不出来的事实，一行一条，写明课号。',
    '同步时你告诉 AI 助手（Codex / Claude）的这类事实（组号、所在班别、哪些要求不适用于你），它会记到这里。',
    '',
    '<!-- 例子：',
    '- ABC1234：我在 Group 3，组别专属的日期（汇报时段等）只取 Group 3 那一行',
    '- DEF5678：我在周二下午那个班（T02），日期一律取周二一列',
    '- GHI4999：我是 Year 3，写着 for Year 4 students 的要求不适用',
    '-->',
    '',
  ].join('\n'));
}

// playwright（装在工作区，不装进 skill）
const pwPkg = join(WORK, 'node_modules', 'playwright', 'package.json');
const pwHave = existsSync(pwPkg) ? JSON.parse(readFileSync(pwPkg, 'utf8')).version : null;
if (pwHave !== PW_VERSION) {
  if (check) { bad(`工作区还没装 playwright ${PW_VERSION}${pwHave ? `（现在是 ${pwHave}）` : ''}`); ready = false; } else {
    writeFileSync(join(WORK, 'package.json'), JSON.stringify({
      name: 'polyu-course-sync-workspace', private: true, description: 'polyu-course-sync 的运行时依赖（由 setup.mjs 生成）',
      dependencies: { playwright: PW_VERSION },
    }, null, 2) + '\n');
    console.log(`→ 安装 playwright ${PW_VERSION} 到工作区（第一次要下载，约 1 分钟）…`);
    const r = spawnSync(isWin ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: WORK, stdio: 'inherit', shell: isWin });
    if (r.status !== 0) { bad('npm install 失败：检查网络或代理设置后重跑 setup'); process.exit(3); }
  }
}
if (existsSync(pwPkg)) {
  if (!check) {
    console.log('→ 准备 Chromium（已经下载过会直接跳过）…');
    const r = spawnSync(process.execPath, [join(WORK, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'], { cwd: WORK, stdio: 'inherit' });
    if (r.status !== 0) { bad('Chromium 下载失败：检查网络后重跑 setup'); process.exit(3); }
  }
  ok(`playwright ${PW_VERSION}`);
}

// 文件转换工具：缺了也能抓取，只是少了文字层
const exists = (cmd, a = ['-v']) => { const r = spawnSync(cmd, a, { stdio: 'ignore', shell: false }); return !(r.error && r.error.code === 'ENOENT'); };
const HINT = {
  poppler: { darwin: 'brew install poppler', win32: 'scoop install poppler（或 choco install poppler），装完确认 pdftotext 在 PATH 里', linux: 'sudo apt install poppler-utils' },
  office: { darwin: 'brew install --cask libreoffice', win32: '安装 LibreOffice，并把它的 program 目录加进 PATH（命令名 soffice）', linux: 'sudo apt install libreoffice' },
};
const hint = (k) => HINT[k][process.platform] || HINT[k].linux;
if (exists('pdftotext') && exists('pdfimages')) ok('Poppler（pdftotext / pdfimages）');
else warn(`没装 Poppler：PDF 抽不出文字层，提取 agent 只能逐页看图，慢很多。安装：${hint('poppler')}`);
if (exists('soffice', ['--version'])) ok('LibreOffice（Word / PPT / Excel 转 PDF）');
else warn(`没装 LibreOffice：Word / PPT 不能转成 PDF 抽文字（原文件照常下载）。可选安装：${hint('office')}`);

/* ── 汇总 ── */
const c = readConfig();
if (!check) syncMeta();
console.log('');
ok(`工作区：${WORK}`);
ok(`课程文件夹：${COURSES_FOLDER}`);
console.log(`${SEMESTER.auto ? '•' : '✓'} 学期：${SEMESTER.label}${SEMESTER.auto ? '（按今天的日期推算；要指定用 --set semester=2026-2 这种写法）' : ''}`);
if (c.weekOneMonday) ok(`第 1 周周一：${c.weekOneMonday}（共 ${c.totalWeeks} 周）`);
else warn('第 1 周周一还没设：第一次抓取后从教学计划里确认，再用 --set weekOneMonday=YYYY-MM-DD 写入');
console.log(`• 课程工作台网页：${c.siteUrl || '没设置（可选，见 references/website.md）'}`);
const loggedIn = existsSync(join(WORK, 'cookies.json'));
console.log(`• 登录态：${loggedIn ? '有保存（是否过期用 probe.mjs 检查）' : '还没登录过 → 运行 login.mjs'}`);
if (!ready) { console.log('\n→ 先运行：node "' + join(SKILL_DIR, 'scripts', 'setup.mjs') + '"'); process.exit(3); }
process.exit(0);
