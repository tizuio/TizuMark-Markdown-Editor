# Tab 撕离成独立编辑器窗口(多窗口)设计

- 日期:2026-11-18
- 状态:已实现(2026-11-18,分支 feat/tab-tearoff-window)
- 关联上游 issue:tizuio#28(第 1 条「每个文件支持单独一个窗口」,维护者回复"规划中"但 4 个月未动工)、tizuio#70(拖拽标签页分屏/多屏协作)

## 背景与动机

用户诉求:把一个 tab 单独拉出来变成新窗口,便于多文档/多屏协作(对应 #28.1 与 #70)。

架构现状(侦察结论,2026-11-18 master 25ef441):

- 单窗口、单 `MarkdownEditor` 实例;所有 tab 共享**同一个 CodeMirror**(`tabs.js` 的 `switchTab` 把内容换进同一个 `this.cm`);tab 是纯数据对象(content/光标/滚动/fileMeta/未保存标记)。
- 会话是单个 localStorage blob `tizumark-session`(files.js `saveSession`/`restoreSession`),只持久化有 filePath 的 tab + 工作区。
- Tauri 侧:`tauri_plugin_single_instance`(二次启动转发 argv → 主窗口 `file-open` 事件)、`tauri_plugin_window_state`(按 label 存几何)、自绘标题栏(`decorations: false`)、capabilities 只覆盖 `main` 一个 label,无建窗权限。
- 关闭语义由前端接管:主窗口 CloseRequested → `handleAppClose`(保存询问 → 托盘/退出)。
- 外部变更检测:1.5s `fileMeta` 轮询 + external-change banner(tab 级 `pendingExternalChange`)。

**关键洞察**:开 OS 窗口 = 全新 JS world = 天然各自一个编辑器实例 + 一个 CM。撕离成独立窗口完全绕开本仓库最深的单点假设(单 CM 实例)——"窗口内分屏"则必须打破它。同一文件在两个窗口打开的提醒可直接复用现有外部变更轮询 + banner。

## 目标 / 非目标 / 反目标

### 目标(v1)

1. tab 可通过**右键菜单「在新窗口打开」+ 快捷键**撕离成独立 Tauri 窗口;**移动语义**——tab 的全部状态(content/光标/滚动/未保存修改)随迁,原窗口移除该 tab(若因此空出,进入现有空态)。
2. 新窗口是**完整编辑器**:可继续开文件、切工作区、导出等,全功能等价。
3. 主窗口与多个分离窗口并存。
4. 关闭语义:分离窗口关闭 = 只关自己(未保存修改走现有保存询问);主窗口关闭 = 现有退出语义,且**不得静默丢失任何分离窗口的未保存内容**。
5. 退出时,分离窗口打开的文件并入主窗口会话,重启后作为主窗口 tab 恢复(降级无损)。

### 非目标(v1)

- 跨窗口 tab 互拖(拖到另一个已开的 TizuMark 窗口;需跨窗口 DnD 协议,单独评估)。拖拽撕离(拖出窗口边界=新窗打开)已随真机验证轮实现:复用自实现指针拖拽基础设施,越界 mouseup(8px 容差)触发,**默认复制语义**(原窗口保留,与菜单「在新窗口打开」同口径),Ctrl/Cmd+拖拽=移动(与「移动到新窗口」同口径),落点即新窗左上角(tearOffGeometry);指针捕获兜底越界事件送达。
- 多窗口会话的独立恢复(重启后不恢复窗口几何/多窗口布局,全部回收为主窗口 tab)。
- 同文件多窗口的实时协同;不搞独占文件锁。
- macOS/Linux 专项适配(本机 Windows 先行,不做平台分叉)。

### 反目标

- 静默丢失未保存内容(任何路径都不允许)。
- 分离窗口出现双份更新弹窗 / EULA 重复弹 / 全局热键注册冲突。
- 破坏现有单窗口行为:托盘、更新、single_instance argv 转发、退出开关(`closeAction`/`clearTabsOnQuit`)。

## 约束

- Tauri 2;前端无框架,模块以 mixin 挂 `MarkdownEditor.prototype`,双导出(浏览器挂 window / node 走 module.exports)。
- localStorage 同源全窗口共享 → 设置/最近文件/已接受 EULA 天然共享;**会话写入必须按窗口拆键**,否则互相覆盖。
- 测试纪律:jsdom 全量 + 纯函数抽取式测试(`view-mode-wysiwyg` 等);窗口创建等 Tauri 交互需可 mock,业务逻辑抽纯函数。
- capabilities 最小化口径;devtools 保持 false。

## 方案选型(已定)

**A. 完整编辑器窗口(选定)** —— `WebviewWindowBuilder` 开新窗,加载同一 `index.html` + 查询参数,boot 识别参数走分离模式。复用全部现有能力,绕开单 CM 重构。
代价:boot 副作用分叉、会话键拆分、退出协调、capabilities 扩展。

**B. 轻量单文档窗口(弃)** —— 集成面小,但形成第二种应用形态:窗口内"新建/打开"语义残废,无法继续开文件,不符 #70 多屏协作意图。

**C. 主窗口内分屏(弃)** —— 不是"新窗口";且必须打破单 CM 假设,是全仓库最深的一次重构,风险/收益比最差。

用户已确认:A + 菜单/快捷键先行(2026-11-18)。

## 已定案要点(勿重新设计)

1. **窗口形态**:完整编辑器(方案 A)。
2. **v1 交互**(真机验证后细化,2026-11-18):tab 右键菜单双入口——「在新窗口打开」=**复制**(原窗口保留 tab,新窗口开独立副本;快捷键 Ctrl+Shift+O 绑复制)+「移动到新窗口」=**撕离**(原窗口移除该 tab,Excel/Word 拖拽语义);撕离后原窗口空出则进入现有 `_applyEmptyState()` 空态。复制语义下:有 filePath 的副本互改由现有外部变更横幅提示(定案 13);未保存未命名副本各自独立、无冲突检测,属已知限制。
3. **窗口 label**:`editor-<n>`,n 取现有 `editor-*` 编号中的**最小空位**(关闭后可回收复用);创建时显式传几何(主窗口当前尺寸、级联偏移),不依赖 window-state 的 per-label 自动恢复。
4. **会话**:主窗口键 `tizumark-session` 不动;每个分离窗口写自己的 `tizumark-session-editor-<n>`(同 v2 结构);主窗口退出聚合时把分离窗口的 filePath 并入主 session.tabs,重启后作为普通 tab 恢复。
5. **tab 状态随迁通道(builder check 定案)**:localStorage 交接键 `tizumark-window-handoff-<label>`——源窗口在建窗**前**序列化完整 tab 状态(content/光标/滚动/previewScrollTop/kind/name/filePath/fileMeta/pendingExternalChange,未保存修改与无 filePath 的未命名 tab 均可迁),分离窗口 boot 消费后清除该键;键缺失且无 doc 参数 → 分离窗口报错并自关;主窗口 boot 清扫过期交接键。不引入新 IPC 通道。
6. **boot 分叉**:`app.js` DOMContentLoaded 读 `location.search`(如 `?doc=<path>&label=editor-1`)进入 detached 模式:跳过 `restoreSession()` 全量恢复(改为消费交接状态)、跳过更新检查 UI、跳过 CLI args 处理;EULA 已在 localStorage,天然跳过。
7. **事件定向化(builder check 纠错定案)**:现状 `file-open`/`folder-changed`/`close-requested` 均为**全窗口广播**(lib.rs `app.emit`/`window.emit`),多窗口下会重复触发——全部改为 `emit_to(label)` 定向:`file-open` → 仅 main(保持 single_instance argv 永远进主窗口的现状语义);`folder-changed`/`folder-watch-error` → 随 watcher 归属窗口(见第 12 条);`close-requested` → 见第 11 条。detached boot 按监听归属决定注册(file-open 不注册)。
8. **capabilities**:`default.json` 的 `windows` 扩为 `["main", "editor-*"]`;新增建窗所需权限(`core:window:allow-create-webview-window` 及 setBounds/setTitle/getAll 等最小集合,清单在 plan 核对)。
9. **建窗通道**:倾向 JS 侧 `new WebviewWindow(label, { url, ... })`(`withGlobalTauri` 已开);若权限/URL 解析在打包态有问题,退到 Rust 命令 `create_editor_window`。plan 时二选一并验证打包态(devUrl 与 tauri:// 两种 base)。
10. **Rust 命令多窗口安全**:带 `window: tauri::WebviewWindow` 参数的命令(print_to_pdf 等,PR #94 已窗口参数化)天然按调用窗口工作;builder 审计无 window 参数却隐含 main 假设的命令。
11. **退出协调覆盖全部退出入口(builder check 纠错定案)**:主窗口 `handleAppClose` 进入 quit 分支前枚举分离窗口,存在未保存修改者逐窗走其自身保存询问(事件/命令握手,形态留给 builder),任何一窗取消则整体不退出;分离窗口自己的 CloseRequested 只处理自己的 tab,关窗不退出进程。现状无托盘模式任意窗口 CloseRequested 直接 `exit_app`、托盘「退出」绕过前端直接 `exit_app`、更新安装重启杀全部窗口——三者都会静默丢分离窗口未保存内容,均纳入协调:
    - Rust CloseRequested 按 label 分流:`editor-*` 一律 `prevent_close` + `emit_to(该 label)`,由该窗口前端走保存询问后自关;`main` 托盘模式维持现状;**无托盘模式由"直接 exit_app"改为走同一协调**(行为变更,已向用户明示)。
    - 托盘「退出」→ `emit_to("main", close-requested)`,由主窗口走协调流程。
    - 更新安装 → 安装确认后、执行前跑同一协调;取消则不装。
12. **分离窗口工作区范围(已定:支持挂载)**:现状 `WatcherState` 为全进程单槽(lib.rs:751),分离窗口挂载工作区会偷走主窗口的 watcher。v1 即支持分离窗口挂载/切换工作区(完整编辑器语义,用户 2026-11-18 定),随一期做 **Rust WatcherState 重设计:per-label `Mutex<HashMap<String, Option<RecommendedWatcher>>>`**,`watch_folder`/`stop_watch` 增加 label 参数(缺省取调用窗口 label),`folder-changed`/`folder-watch-error` 改 `emit_to(owner label)`;窗口关闭时回收其 watcher。
13. **同文件双开**:允许;不加锁,依赖现有外部变更轮询 + banner 提醒"文件已在别处修改";已知限制:双开同时编辑,后保存覆盖先保存,banner 提示重载——v1 接受。

## 实现状态(2026-11-18 回填)

13 条定案与目标均已落地,主要入口:`src/modules/multi-window.js` / `tabs.js` / `lifecycle.js` / `tauri-api.js`、`src-tauri/src/lib.rs`。以下是实现相对设计文字的细化(语义不变):

- **定案 6**:分离窗口跳过**自动**更新检查;手动「检查更新」保留,安装按钮在分离窗口被拒并提示去主窗口。
- **定案 8**:建窗权限实际为 `core:webview:allow-create-webview-window`;显示器读取(`current-monitor` / `available-monitors`)已由 `core:window:default` 覆盖,用于撕离落点的工作区钳制。
- **定案 9**:采用 JS 侧 `new WebviewWindow`,开发态与打包态均已验证。
- **定案 11**:托盘「退出」使用专用 `app-quit-requested` 事件(而非 `close-requested`),避免 `closeAction=最小化` 吞掉退出;协调语义一致。
- **定案 12**:`watch_folder`/`stop_watch` 以 `window: tauri::WebviewWindow` 参数派生 label(等价于显式 label 参数),事件按 label 定向。
- **全局热键**:只由主窗口同步;分离窗口 boot 不重复注册,避免注册失败时把主窗口已注册的热键弄丢。

## 留给 builder

- 快捷键取值与现有快捷键冲突检查。
- 建窗通道(JS vs Rust 命令)最终选择 + capabilities 权限清单核对 + 打包态 URL 解析验证。
- boot detached 分支的副作用清单:以 `app.js` DOMContentLoaded 流程逐行审计为准(updater 触发点、demo.md 自动打开、`tizumark-app-version` 写入、file watcher 等)。
- 退出握手的 IPC 具体形态(Tauri 事件 + invoke 应答 vs Rust 侧逐窗 close 链)。
- per-label watcher 的 Rust 侧细节:label 缺省取调用窗口、窗口关闭回收、watch 报错恢复对话框的归属窗口。
- window-state 插件对 `editor-*` label 的实际行为(残留状态是否污染级联偏移)。
- 会话聚合的写竞态评估(多窗口同时 saveSession,last-write-wins 影响面)。
- 测试落点:label 分配/几何级联/会话聚合/退出协调判定/watcher 归属抽纯函数;窗口创建 mock;jsdom 全量回归;`docs/superpowers/plans/` 出实现计划。
- i18n 键(菜单项「在新窗口打开」/退出协调提示文案,zh/en/es 三语)。
