#!/usr/bin/env node
/**
 * 登录：开一个有头 Chromium，你自己在窗口里完成 PolyU 统一登录（含二次验证）。
 * 脚本不碰账号密码；它只每 3 秒问一次两个平台「我登录了吗」，都成功就保存并关窗。
 * 不需要回车 —— 用 bg.mjs 放到后台跑也能用。
 *
 *   node login.mjs                 # 最多等 10 分钟
 *   node login.mjs --timeout=20    # 最多等 20 分钟（也可以用环境变量 LOGIN_TIMEOUT_MIN）
 */
import { openContext, saveCookies, checkAuth, writeStatus, readStatus, sleep, BB, CANVAS, SUPPORT } from './lib/session.mjs';

const arg = (process.argv.find((a) => a.startsWith('--timeout=')) || '').split('=')[1];
const LIMIT = Number(arg || process.env.LOGIN_TIMEOUT_MIN || 10) * 60_000;
const t0 = Date.now();

const ctx = await openContext({ headless: false });
let auth = await checkAuth(ctx);
if (auth.blackboard.ok && auth.canvas.ok) {
  console.log('✓ 两个平台都已是登录状态，无需重新登录。');
  await saveCookies(ctx);
  writeStatus({ auth: { ...readStatus().auth, ...auth } });
  await ctx.close();
  process.exit(0);
}

const page = ctx.pages()[0] || await ctx.newPage();
await page.bringToFront();

const visit = (url) => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

if (!auth.blackboard.ok) {
  console.log('→ 已打开 Blackboard 登录页，请在弹出的浏览器窗口里完成登录。');
  await visit(`${BB}/ultra/course`);
}

let canvasOpened = false;
while (Date.now() - t0 < LIMIT) {
  await sleep(3000);
  auth = await checkAuth(ctx);
  if (auth.blackboard.ok && !auth.canvas.ok && !canvasOpened) {
    // ADFS 会话已建立，Canvas 这一跳通常不用再输密码
    console.log('✓ Blackboard 已登录 → 正在用同一个统一登录进 Canvas…');
    canvasOpened = true;
    await visit(`${CANVAS}/login/saml`);
  }
  if (!auth.blackboard.ok && auth.canvas.ok && !canvasOpened) {
    canvasOpened = true;  // 用户先登了 Canvas 的罕见情况：回到 Blackboard
    await visit(`${BB}/ultra/course`);
  }
  if (auth.blackboard.ok && auth.canvas.ok) break;
}

await saveCookies(ctx);
writeStatus({ auth: { ...readStatus().auth, ...auth } });
await ctx.close();

const mark = (x) => (x.ok ? '✓' : '✗');
console.log(`Blackboard ${mark(auth.blackboard)} · Canvas ${mark(auth.canvas)}`);
if (auth.blackboard.ok && auth.canvas.ok) {
  console.log(`✓ 登录完成，登录态已保存在本机工作区（${SUPPORT}）。`);
  process.exit(0);
}
console.error(`✗ ${Math.round(LIMIT / 60000)} 分钟内没有完成登录，重新运行 login.mjs。`);
process.exit(2);
