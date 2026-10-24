#!/usr/bin/env node
/**
 * 发一条系统通知（auto 模式提醒用）。没有专门推送工具的环境（例如 Codex）用它。
 *
 *   node notify.mjs "标题" "内容"
 *
 * macOS 用 osascript，Linux 用 notify-send，Windows 用 PowerShell 弹 toast；发不出去时只打印，不报错。
 */
import { spawnSync } from 'node:child_process';

const [title = 'PolyU 课程同步', body = ''] = process.argv.slice(2);
const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
let r = { status: 1 };
try {
  if (process.platform === 'darwin') {
    r = spawnSync('osascript', ['-e', `display notification "${q(body)}" with title "${q(title)}"`]);
  } else if (process.platform === 'win32') {
    const ps = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      `$t = $x.GetElementsByTagName('text'); $t.Item(0).AppendChild($x.CreateTextNode('${String(title).replace(/'/g, "''")}')) > $null; $t.Item(1).AppendChild($x.CreateTextNode('${String(body).replace(/'/g, "''")}')) > $null`,
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
    ].join('; ');
    r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true });
  } else {
    r = spawnSync('notify-send', [title, body]);
  }
} catch { /* 发不出去就只打印 */ }
console.log(`${r.status === 0 ? '✓ 已发通知' : '（系统通知没发出去，只打印）'}：${title} — ${body}`);
