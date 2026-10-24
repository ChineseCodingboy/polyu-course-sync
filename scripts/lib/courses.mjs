/**
 * data/courses/<CODE>.json 的读写。抓取时发现的新课先建一个空壳，等提取 agent 填。
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, readJson, writeJson } from './session.mjs';

export const COURSES_DIR = join(DATA, 'courses');

export function listCourses() {
  if (!existsSync(COURSES_DIR)) return [];
  return readdirSync(COURSES_DIR)
    .filter((f) => /^[A-Z]{2,8}(\d{3,5}[A-Z]?)?\.json$/.test(f))   // 也收没有数字的全校课程
    .map((f) => readJson(join(COURSES_DIR, f), null))
    .filter(Boolean);
}

export const courseCode = (s) => (String(s || '').match(/[A-Z]{2,6}\d{3,5}[A-Z]?/) || [])[0] || null;

const titleCase = (s) => String(s || '').toLowerCase()
  .replace(/\b([a-z])/g, (m) => m.toUpperCase())
  .replace(/\b(And|Of|In|For|The|To|On)\b/g, (m) => m.toLowerCase())
  .replace(/\((\w+)\)/g, (m, w) => `(${w.toUpperCase()})`);

/** 发现新课：建空壳（assessments 为空 → 看版显示「待提取」，build 不判失败） */
export function ensureCourse({ code, platform, title, section, canvasId, bbId, bbCourseId, url }) {
  const p = join(COURSES_DIR, `${code}.json`);
  if (existsSync(p)) return { created: false, course: readJson(p) };
  const course = {
    id: code, code, section: section || 'A',
    title: titleCase(title), titleZh: '',
    credits: null, platform,
    ...(canvasId ? { canvasId } : {}),
    ...(bbId ? { bbId, bbCourseId } : {}),
    dept: '', teacher: '', url: url || '',
    meetings: [], classDay: null, totalWeeks: 13,
    sources: [],
    syllabus: null,
    rules: { pass: '', attendance: '', late: [], misc: [] },
    assessments: [], milestones: [], schedule: [], announcements: [],
    extractedAt: null, manualLock: [],
  };
  writeJson(p, course);
  return { created: true, course };
}
