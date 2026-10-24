#!/usr/bin/env node
/**
 * 哪些课需要重新提取？输出 JSON 给编排者用。
 *
 *   node changed.mjs            # 只列有变化的课
 *   node changed.mjs --all      # 全部课，mode=full
 *
 * 判定：
 *   full        从未提取过 / 仍是种子（任何考核都没有 sources）/ --all
 *   incremental 自上次提取后有文件新增或变更，或平台数据（公告、作业、内容树…）有变化
 */
import { join } from 'node:path';
import { DATA, readJson } from './lib/session.mjs';
import { loadManifest } from './lib/files.mjs';
import { listCourses } from './lib/courses.mjs';

const all = process.argv.includes('--all');
const m = loadManifest();
const out = [];

for (const c of listCourses()) {
  const since = c.extractedAt ? new Date(c.extractedAt) : null;
  const seed = !c.extractedAt || !(c.assessments || []).some((a) => a.sources?.length);
  const files = Object.values(m.files).filter((f) => f.course === c.code);
  const changedFiles = files
    .filter((f) => f.lastChanged && (!since || new Date(f.lastChanged) > since))
    .map((f) => (f.skipped ? `${f.name}（${f.skipped === 'link' ? '外链' : f.skipped}）` : f.path));
  const changedPlatforms = ['canvas', 'blackboard'].filter((p) => {
    const raw = readJson(join(DATA, 'raw', c.code, `${p}.json`), null);
    return raw && (!since || new Date(raw.contentChangedAt) > since);
  });
  const mode = all || seed ? 'full' : changedFiles.length || changedPlatforms.length ? 'incremental' : null;
  if (!mode) continue;
  out.push({
    code: c.code, platform: c.platform, mode,
    reason: all ? '--all' : seed ? (c.extractedAt ? '首次核实种子数据' : '新课程') : '有新材料',
    changedPlatformData: changedPlatforms.map((p) => `data/text/${c.code}/_${p}.md`),
    changedFiles,
  });
}
console.log(JSON.stringify(out, null, 2));
