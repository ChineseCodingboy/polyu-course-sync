#!/usr/bin/env node
/**
 * 核查 agent 用的体检表：把一门课 JSON 里每个日期、权重、出处的状态列出来，标出可疑的地方。
 *
 *   node check.mjs <CODE>
 *
 * 检查：时区是否 +08:00、week 与日期是否对得上、in-class 是否落在上课日、opens 是否早于 due、
 * 没日期却不是 unknown、rubric 合计、每条出处的 grounding 状态（先跑 build 才有）。
 * 提取 agent 写完 JSON 后也用它自检：JSON 能不能解析、权重合计、每项考核有没有出处。
 * 退出码：0 没有硬错误；1 JSON 坏了、权重合计不是 100、或有考核没写出处。
 */
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { DATA, readJson } from './lib/session.mjs';

const code = (process.argv[2] || '').toUpperCase();
if (!code) { console.error('用法：node check.mjs <CODE>'); process.exit(1); }
const cPath = join(DATA, 'courses', `${code}.json`);
if (!existsSync(cPath)) { console.error(`✗ 没有 data/courses/${code}.json`); process.exit(1); }
let c;
try { c = JSON.parse(readFileSync(cPath, 'utf8')); } catch (e) { console.error(`✗ data/courses/${code}.json 不是合法的 JSON：${e.message}`); process.exit(1); }
let hard = 0;
const meta = readJson(join(DATA, 'meta.json'), {});
const w1 = meta.weekOneMonday ? new Date(`${meta.weekOneMonday}T00:00:00+08:00`) : null;
const ground = new Map((readJson(join(DATA, 'grounding', `${code}.json`), { results: [] }).results || []).map((x) => [x.ref, x]));

const DAYS = ['日', '一', '二', '三', '四', '五', '六'];
const hk = (iso) => new Date(new Date(iso).getTime() + 8 * 3600e3);   // 用 UTC 方法读香港时间
const weekOf = (d) => (w1 ? Math.floor((d - w1) / (7 * 864e5)) + 1 : null);
const classDays = new Set([...(c.meetings || []).map((m) => m.day), c.classDay].filter((x) => x != null).map(Number));

function chk(label, iso, { week, mode, conf } = {}) {
  if (!iso) return;
  const d = new Date(iso);
  if (isNaN(d)) { console.log(`  ${label}: ${iso} ⚠ 不是合法时间`); return; }
  const h = hk(iso);
  const dow = h.getUTCDay();
  const wk = weekOf(d);
  const out = [];
  if (!/\+08:00$/.test(iso)) out.push('不是 +08:00');
  if (week && wk != null && wk !== week) out.push(`week=${week}，但日期在第 ${wk} 周`);
  if (mode === 'in-class' && classDays.size && !classDays.has(dow === 0 ? 7 : dow)) out.push(`in-class，但周${DAYS[dow]}不是上课日（${[...classDays].join('/')}）`);
  console.log(`  ${label}: ${iso.slice(0, 16)} 周${DAYS[dow]}${wk != null ? ` W${wk}` : ''}${conf ? ` conf=${conf}` : ''}${out.length ? `  ⚠ ${out.join('；')}` : ''}`);
}

const as = c.assessments || [];
const tot = as.reduce((s, a) => s + (+a.weight || 0), 0);
const weightOk = c.graded === false || !as.length || Math.abs(tot - 100) < 0.01;
if (!weightOk) hard++;
console.log(`== ${code} graded=${c.graded !== false} 权重合计=${tot}${weightOk ? '' : ' ⚠ 不是 100'} classDay=${c.classDay ?? '—'} meetings=${JSON.stringify((c.meetings || []).map((m) => [m.type, m.day, m.start]))}${w1 ? '' : '  （没有 weekOneMonday，不查周次）'}`);
as.forEach((a, i) => {
  console.log(`- ${a.id} ${a.name || a.nameZh || ''} w=${a.weight} major=${a.major} mode=${a.mode} conf=${a.confidence}${a.unverifiedSeed ? ' seed未核实' : ''}`);
  chk('due', a.due, { week: a.week, mode: a.mode, conf: a.confidence });
  if (a.opens && a.due && new Date(a.opens) >= new Date(a.due)) console.log('  ⚠ opens 不早于 due');
  if (!a.due && a.confidence !== 'unknown' && !a.dueRange) console.log('  ⚠ 没有 due，但 confidence 不是 unknown');
  if (!(a.sources || []).length) { console.log('  ⚠ 没有 sources（每项考核都要附出处）'); hard++; }
  const rs = (a.rubric || []).map((r) => r.v).filter((v) => typeof v === 'number');
  if (rs.length && Math.abs(rs.reduce((s, v) => s + v, 0) - 100) > 0.01) console.log(`  ⚠ rubric 合计 ${rs.reduce((s, v) => s + v, 0)}`);
  (a.sources || []).forEach((s, j) => {
    const g = ground.get(`assessments.${a.id}.sources[${j}]`);
    const f = String(s.file || s.md || s.url || '').split('/').pop().slice(0, 60);
    console.log(`    [${g?.status || '未 build'}] ${f}${s.page ? ` p${s.page}` : ''}${s.vision ? ' 看图' : ''} | ${String(s.quote || '').slice(0, 110)}`);
  });
  for (const x of a.subItems || []) if (x.due) chk(`细分 ${String(x.name || '').slice(0, 30)}`, x.due);
});
(c.milestones || []).forEach((m, i) => { console.log(`- 节点${i} ${m.title} kind=${m.kind || '—'}`); chk('date', m.date, { week: m.week }); });
const badRefs = [...ground.values()].filter((x) => !/^(ok|ok-other-page|vision)$/.test(x.status)).map((x) => `${x.ref}(${x.status})`);
console.log(`grounding 未通过：${badRefs.length ? badRefs.join('，') : '无'}`);
console.log(`openQuestions：${(c.openQuestions || []).length} 条`);
console.log(hard ? `✗ ${hard} 个硬问题要修（见上面的 ⚠）` : '✓ JSON 能解析，权重合计和出处都没问题');
process.exit(hard ? 1 : 0);
