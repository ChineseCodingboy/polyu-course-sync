/**
 * 实时课程清单（full-capture 第 1 步）。
 *
 * 每次运行都从两个平台的「我的课程」重建：
 *   平台内部 ID / 外部课号 / 课程名 / 班别 / 学期 / 是否纳入抓取（selected + reason）
 * 然后和上一轮比对，打印新增、消失、同课号换了 ID 的课。
 *
 * 绝不沿用旧课程 ID：同一个课号换了学期或班别，平台内部 ID 就会变，旧导出里的 ID 不能再用。
 *
 * 文件：data/inventory.json = { at, courses: [...], diff: { canvas: {...}, blackboard: {...} } }
 */
import { join } from 'node:path';
import { DATA, readJson, writeJson } from './session.mjs';

const PATH = join(DATA, 'inventory.json');
const keyOf = (c) => `${c.platform}:${c.id}`;
const label = (c) => `${c.code || c.externalId || c.id}（${c.platform} ${c.id}${c.term ? ` · ${c.term}` : ''}）`;

export function loadInventory() {
  return readJson(PATH, { courses: [] });
}

/** rows: [{ platform, id, externalId, code, name, section, term, selected, reason }] */
export function saveInventory(platform, rows) {
  const prev = loadInventory();
  const same = (c) => String(c.platform).toLowerCase() === String(platform).toLowerCase();   // 'blackboard' 与 'Blackboard' 视为同一平台
  const before = (prev.courses || []).filter(same);
  const others = (prev.courses || []).filter((c) => !same(c));
  const b = new Map(before.map((c) => [keyOf(c), c]));
  const a = new Map(rows.map((c) => [keyOf(c), c]));
  const at = new Date().toISOString();
  const first = !before.length;   // 首次记录不算「新增」
  const diff = {
    at,
    added: first ? [] : rows.filter((c) => !b.has(keyOf(c))).map(label),
    removed: before.filter((c) => !a.has(keyOf(c))).map(label),
    // 同一个课号（且都纳入抓取）换了平台 ID —— 新班、新学期，旧 ID 不能再用
    idChanged: rows.filter((c) => c.selected && c.code && before.some((x) => x.selected && x.code === c.code && x.id !== c.id))
      .map((c) => `${c.code}: ${before.find((x) => x.selected && x.code === c.code).id} → ${c.id}`),
    selectionChanged: rows.filter((c) => b.has(keyOf(c)) && b.get(keyOf(c)).selected !== c.selected)
      .map((c) => `${label(c)} ${c.selected ? '纳入' : '移出'}抓取（${c.reason}）`),
  };
  writeJson(PATH, { at, courses: [...others, ...rows], diff: { ...(prev.diff || {}), [platform]: diff } });
  const lines = [];
  if (!before.length) lines.push(`   清单：首次记录 ${rows.length} 门（纳入抓取 ${rows.filter((c) => c.selected).length}）`);
  else {
    for (const [k, v] of [['新增', diff.added], ['消失', diff.removed], ['换了 ID', diff.idChanged], ['抓取范围变化', diff.selectionChanged]]) {
      if (v.length) lines.push(`   清单${k}：${v.join('；')}`);
    }
    if (!lines.length) lines.push(`   清单无变化：${rows.length} 门，纳入抓取 ${rows.filter((c) => c.selected).length} 门`);
  }
  for (const l of lines) console.log(l);
  return diff;
}
