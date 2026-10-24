#!/usr/bin/env node
/**
 * 无头检查两个平台的登录态，写入 data/sync-status.json。
 * 退出码：0 = 两个都有效；2 = 至少一个过期（运行 login.mjs 重新登录）。
 *
 *   node probe.mjs
 */
import { openContext, saveCookies, checkAuth, writeStatus, readStatus } from './lib/session.mjs';

const ctx = await openContext();
const auth = await checkAuth(ctx);
if (auth.blackboard.ok || auth.canvas.ok) await saveCookies(ctx);  // 服务器可能续发了 cookie
await ctx.close();

writeStatus({ auth: { ...readStatus().auth, ...auth } });
const mark = (x) => (x.ok ? '✓ 有效' : '✗ 已过期');
console.log(`Blackboard ${mark(auth.blackboard)}`);
console.log(`Canvas     ${mark(auth.canvas)}`);
process.exit(auth.blackboard.ok && auth.canvas.ok ? 0 : 2);
