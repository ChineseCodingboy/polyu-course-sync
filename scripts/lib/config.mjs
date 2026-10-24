/**
 * 工作区、配置与学期。
 *
 * 代码在 skill 里（只读）；数据、登录态和依赖都在工作区 WORK：
 *   macOS    ~/Library/Application Support/polyu-course-sync
 *   Windows  %LOCALAPPDATA%\polyu-course-sync
 *   Linux    $XDG_DATA_HOME/polyu-course-sync（默认 ~/.local/share/polyu-course-sync）
 *   环境变量 POLYU_HOME 可以改到别处
 *
 * WORK/
 *   config.json            用户配置（setup 生成，字段见下）
 *   package.json           只声明 playwright 依赖；node_modules/ 由 setup 安装
 *   profile/ cookies.json  登录态，只在本机 —— 不要读取、打印或外发
 *   data/                  抓取与提取的全部数据（课程原文件实际在课程文件夹里，data/files/<课号> 是指过去的链接）
 *   index.html             本地看版（build 时从 skill 的 assets/dashboard.html 复制过来）
 *
 * config.json 字段：
 *   semester        "2026-1" = 2026/27 第一学期，"-2" 第二学期，"-3" 暑期；不写就按今天的日期推算
 *   weekOneMonday   第 1 周的周一 "YYYY-MM-DD"；首次同步前由 AI 助手从教学计划里确认后写入
 *   totalWeeks      教学周数，默认 13
 *   coursesFolder   课程文件夹放在哪，默认 ~/Documents/PolyU 课程
 *   downloadMedia   视频/音频是否下载，默认 false（只登记名字和平台链接）
 *   skipCourses     不抓的课号，例如 ["ABC1234"]
 *   siteUrl         「课程工作台」网页（claude.ai Artifact）的链接；没建网页就是 null
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ASSETS = join(SKILL_DIR, 'assets');

function defaultWork() {
  const name = 'polyu-course-sync';
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), name);
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), name);
}

const expandHome = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

export const WORK = resolve(expandHome(process.env.POLYU_HOME) || defaultWork());
export const CONFIG_PATH = join(WORK, 'config.json');

export const DEFAULTS = {
  semester: null,
  weekOneMonday: null,
  totalWeeks: 13,
  coursesFolder: '~/Documents/PolyU 课程',
  downloadMedia: false,
  skipCourses: [],
  siteUrl: null,
};

export function readConfig() {
  let c = {};
  try { c = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { /* 还没有 setup 时用默认值 */ }
  return { ...DEFAULTS, ...c };
}

export function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  mkdirSync(WORK, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
  return next;
}

export const config = readConfig();

/** 课程文件夹：环境变量 POLYU_FOLDERS > config.coursesFolder */
export const COURSES_FOLDER = resolve(expandHome(process.env.POLYU_FOLDERS || config.coursesFolder || DEFAULTS.coursesFolder));

/** 跳过的课号：config.skipCourses */
export const SKIP = new Set((config.skipCourses || []).map((x) => String(x).trim().toUpperCase()).filter(Boolean));

/**
 * 学期 → 两个平台上识别本学期课程的标记。
 *
 * PolyU 的课号里带学期：
 *   Blackboard  ABC1234_20261_A      学年起始年 + 学期序号（1 / 2 / 3 = 暑期）
 *   Canvas      ABC1234_26271_A      两位起始年 + 两位结束年 + 学期序号；term.name 形如「1st Sem. (2026/27)」
 *
 * spec：config.semester（"2026-1"）或环境变量 POLYU_SEMESTER；都没有就按香港时间的今天推算：
 *   8–12 月 → 当年第一学期；1–5 月 → 上一学年第二学期；6–7 月 → 上一学年暑期
 */
export function semesterInfo(spec, now = new Date()) {
  let year;
  let term;
  const m = String(spec || '').trim().match(/^(\d{4})-([123])$/);
  if (m) {
    year = +m[1]; term = +m[2];
  } else {
    const hk = new Date(now.getTime() + 8 * 3600e3);
    const y = hk.getUTCFullYear();
    const mo = hk.getUTCMonth() + 1;
    if (mo >= 8) { year = y; term = 1; } else if (mo <= 5) { year = y - 1; term = 2; } else { year = y - 1; term = 3; }
  }
  const yy = String(year).slice(2);
  const yy1 = String(year + 1).slice(2);
  const ay = `${year}/${yy1}`;
  const termName = term === 3
    ? new RegExp(`Summer[^(]*\\(${year}\\/${yy1}\\)`, 'i')
    : new RegExp(`${term === 1 ? '1st' : '2nd'} Sem[^(]*\\(${year}\\/${yy1}\\)`, 'i');
  return {
    id: `${year}-${term}`, year, term, auto: !m,
    label: `${ay} 学年${['', '第一学期', '第二学期', '暑期'][term]}`,
    labelEn: `${ay} ${['', 'Semester 1', 'Semester 2', 'Summer Term'][term]}`,
    bbTerm: process.env.TERM_FILTER || `_${year}${term}_`,
    canvasCodeTag: `_${yy}${yy1}${term}_`,
    canvasTermName: termName,
    /** 公告、日历的取数窗口：整个学年（6 月到次年 8 月） */
    window: [`${year}-06-01`, `${year + 1}-08-31`],
  };
}

export const SEMESTER = semesterInfo(process.env.POLYU_SEMESTER || config.semester);

/**
 * 把学期信息从 config.json 写进 data/meta.json。提取 agent 和看版读的是 meta.json，
 * 所以 setup --set、build（含 --snapshot）都会调用它，改了配置马上生效。
 */
export function syncMeta() {
  const c = readConfig();
  const sem = semesterInfo(process.env.POLYU_SEMESTER || c.semester);
  const p = join(WORK, 'data', 'meta.json');
  let meta = {};
  try { meta = JSON.parse(readFileSync(p, 'utf8')); } catch { /* 第一次还没有 */ }
  meta = { ...meta, semester: sem.id, term: sem.labelEn, termZh: sem.label, weekOneMonday: c.weekOneMonday || null, totalWeeks: c.totalWeeks || 13 };
  mkdirSync(join(WORK, 'data'), { recursive: true });
  writeFileSync(p, JSON.stringify(meta, null, 2) + '\n');
  return meta;
}

/** 日期窗切成每段不超过 15 周（Blackboard 日历接口跨度上限 16 周） */
export function windows([from, to], days = 105) {
  const out = [];
  let a = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (a < end) {
    const b = new Date(Math.min(a.getTime() + days * 864e5, end.getTime()));
    out.push([a.toISOString().slice(0, 10), b.toISOString().slice(0, 10)]);
    a = b;
  }
  return out;
}
