// 托盘僵尸图标修复：退出路径必须统一走 exit_app（先清 TrayState 引用再 app.exit）。
// 背景：tray-icon 平台图标仅在最后一个 Rc 引用 drop 时发 NIM_DELETE；app.exit 的
// cleanup_before_exit 清不到 app.manage(TrayState) 里的那份引用，进程退出跳过 Drop，
// 托盘图标残留（鼠标掠过才消失、反复开关累积多个）。静态断言防止直接 app.exit 绕过。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const libRs = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8');

test('存在 exit_app 统一退出入口，且先清 TrayState 再 app.exit', () => {
  assert.ok(/fn exit_app\(app: tauri::AppHandle\)/.test(libRs), '应定义 exit_app');
  const m = libRs.match(/fn exit_app\(app: tauri::AppHandle\) \{[\s\S]*?\n\}/);
  assert.ok(m, '应能提取 exit_app 函数体');
  const body = m[0];
  const takeIdx = body.indexOf('*guard = None');
  const exitIdx = body.indexOf('app.exit(0)');
  assert.ok(takeIdx !== -1, 'exit_app 应先清 TrayState（*guard = None）');
  assert.ok(exitIdx !== -1, 'exit_app 应调用 app.exit(0)');
  assert.ok(takeIdx < exitIdx, '清理 TrayState 必须先于 app.exit');
});

test('所有退出路径统一走 exit_app，无直接 app.exit 绕过', () => {
  // quit_app 命令（关闭弹框「退出」）、托盘菜单 quit、CloseRequested 非托盘分支
  const callSites = (libRs.match(/exit_app\(/g) || []).length;
  assert.ok(callSites >= 4, 'exit_app 定义 + 至少三处调用，实际 ' + callSites);
  assert.ok(/fn quit_app\(app: tauri::AppHandle\) \{\s*exit_app\(app\);/.test(libRs),
    'quit_app 应转发 exit_app');
  assert.ok(/"quit" => \{\s*exit_app\(app\.clone\(\)\);/.test(libRs),
    '托盘菜单退出应走 exit_app');
  assert.ok(/if !show_tray \{\s*exit_app\(app\.clone\(\)\);/.test(libRs),
    'CloseRequested 非托盘分支应走 exit_app');
  // 除 exit_app 函数体内，不允许任何直接 app.exit(0)
  const withoutFn = libRs.replace(/fn exit_app\(app: tauri::AppHandle\) \{[\s\S]*?\n\}/, '');
  assert.ok(!/\.exit\(0\)/.test(withoutFn), 'exit_app 之外不得有直接 .exit(0) 绕过清理');
});
