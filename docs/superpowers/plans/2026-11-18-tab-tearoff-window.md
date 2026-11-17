# Tab 撕离成独立编辑器窗口(多窗口)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** tab 通过右键菜单/快捷键撕离成独立 Tauri 窗口(完整编辑器、可挂工作区),所有退出入口协调、不静默丢未保存内容。

**Architecture:** 新窗口加载同一 `index.html?label=editor-N`,boot 分叉为 detached 模式消费 localStorage 交接键;Rust 侧事件全部改 `emit_to(label)` 定向、CloseRequested 按 label 分流、WatcherState 改 per-label;主窗口 quit 前与分离窗口做事件握手并聚合会话。

**Tech Stack:** Tauri 2.11(Rust)+ 原生 JS(模块双导出 + mixin 挂 MarkdownEditor.prototype)+ localStorage。

**Spec:** `docs/superpowers/specs/2026-11-18-tab-tearoff-window-design.md`(定案要点勿重新设计,实现时与本计划同读)

## Global Constraints

- 分支:`feat/tab-tearoff-window`(origin 是 fork,最终 PR 提给 tizuio 上游)。
- 模块范式:新 JS 模块双导出(浏览器挂 `window.TMMultiWindow`,node 走 `module.exports`),纯函数优先,方法体经 mixin 挂 prototype(与 tabs.js 同风格)。
- 测试纪律:每个任务先写失败测试再实现;渲染器未动则不必重建 bundle(pretest 自动跑);任务完成后跑该任务相关测试文件,最后任务跑全量 `npm test` + `cargo test`(Rust 零警告)。
- 文案:i18n 三语键,zh/en/es 同步加(i18n-data.js)。
- capabilities 最小化;`devtools` 保持 false。
- 任何路径不得静默丢失未保存内容。
- 注释风格:中文、讲 why(项目既有密度)。
- 本机环境:cargo 需 `export PATH="$HOME/.cargo/bin:$PATH"`;npm test 浏览器测试需 `CHROME_PATH='C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'`(不设则显示 ok (0/0) 实为 SKIP)。

## Review Focus

1. **未保存修改的未命名 tab 撕离**:无 filePath、content≠savedContent 的 tab 是多屏协作主场景——撕离后新窗口必须完整保住内容与修改态(isModified 不丢)。→ Task 4 测试 `detach 保留未保存未命名 tab 的修改态`。
2. **主窗口退出时分离窗口有未保存内容**:点主窗口 X(无托盘模式)或托盘「退出」,分离窗口正在编辑未保存 → 必须弹各自保存询问、任一取消则整体不退。→ Task 8 测试 `quit 协调任一 aborted 则不退出`。
3. **分离窗口关闭只关自己**:分离窗口点 X 不允许触发整个应用退出(现状 lib.rs 任意窗口 CloseRequested 无托盘即 exit_app)。→ Task 5 测试 `is_editor_label 分流` + 真机验证清单。
4. **同文件双开的外部变更提醒**:A 窗口保存后,B 窗口必须在轮询内出现 external-change banner 且不被误判成本窗口未保存。→ 复用现有 banner 机制,Task 9 真机验证清单项;jsdom 已有 external-change 用例不回归即可。
5. **交接键竞态/残留**:建窗后源窗口崩溃、或分离窗口 boot 失败,残留 `tizumark-window-handoff-*` 不得污染下次启动。→ Task 1 测试 `sweepStaleHandoffs 只清 editor-* 交接键` + Task 7 主窗口 boot 清扫步骤。

---

### Task 1: 分支 + 纯函数模块 multi-window.js(label/几何/交接键)

**Files:**
- Create: `src/modules/multi-window.js`
- Test: `test/multi-window.test.cjs`

**Interfaces:**
- Produces(后续任务全部依赖,签名逐字):
  - `nextEditorLabel(existing: string[]): string` — 已有 `editor-*` 最大 N+1,无则 `editor-1`
  - `cascadeGeometry(base: {x:number,y:number,width:number,height:number}, slot: number): {x:number,y:number,width:number,height:number}` — x,y 各偏移 `slot*28`,负数钳 0,不小于 800×600
  - `parseBootParams(search: string): { detached: boolean, label: string|null }` — 解析 `?label=editor-1`;label 以 `editor-` 开头才判 detached
  - `buildHandoffPayload(tab): object` — 序列化 Tab 的 `{name,content,savedContent,filePath,kind,cursorPos,scrollPos,previewScrollTop,fileMeta,pendingExternalChange,_loaded:true}` 于 `{version:1, tab}` 包裹
  - `readHandoff(label: string, storage): object|null` / `clearHandoff(label, storage)` / `writeHandoff(label, tab, storage)` — 键 `tizumark-window-handoff-<label>`,storage 参数默认 localStorage(测试注入 mock)
  - `sweepStaleHandoffs(storage): string[]` — 删除全部 `tizumark-window-handoff-editor-*`,返回被删键
  - `mergeDetachedSessions(mainSession: object, detachedSessions: object[]): object` — 把各 detached 的 tabs(filePath 去重、保持顺序)追加进 mainSession.tabs,activeFilePath/main 其余字段不变
  - `isDetachedLabel(label: string): boolean` — `editor-` 前缀(与 Rust 侧 Task 5 的 `is_editor_label` 口径一致)

- [ ] **Step 1: 建分支并提交设计文档**

```bash
git checkout -b feat/tab-tearoff-window
git add docs/superpowers/specs/2026-11-18-tab-tearoff-window-design.md docs/superpowers/plans/2026-11-18-tab-tearoff-window.md
git commit -m "docs(多窗口): tab 撕离成独立编辑器窗口——设计文档与实现计划"
```

- [ ] **Step 2: 写失败测试** `test/multi-window.test.cjs`(node:test,模式仿 test/settings.test.cjs:require 模块、注入 mock storage)

用例:`nextEditorLabel 空/最大N+1/跳号`、`cascadeGeometry 级联偏移/负钳0/不小于800×600`、`parseBootParams detached/非 editor 前缀不判 detached/无参数`、`buildHandoffPayload 含 savedContent 与 pendingExternalChange(未保存未命名 tab 可迁)`、`writeHandoff→readHandoff 往返/clearHandoff 删键`、`sweepStaleHandoffs 只清 editor-* 交接键`、`mergeDetachedSessions 追加去重/main 字段不变`、`isDetachedLabel 边界('editor-'无编号不判真)`。

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test --test-concurrency=1 test/multi-window.test.cjs`
Expected: FAIL(模块不存在)

- [ ] **Step 4: 实现** `src/modules/multi-window.js`

IIFE 双导出;所有函数纯函数、不读全局(storage 注入);键名常量 `HANDOFF_PREFIX='tizumark-window-handoff-'` 导出供 Task 7/8 复用。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test --test-concurrency=1 test/multi-window.test.cjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/multi-window.js test/multi-window.test.cjs
git commit -m "feat(多窗口): label 分配/几何级联/交接键纯函数模块"
```

---

### Task 2: index.html 接入(script + 菜单项)+ i18n 三语

**Files:**
- Modify: `src/index.html`(script 标签区,约 1500+ 行处与其它 modules 相邻;`context-menu-tab` 在 1442 行)
- Modify: `src/modules/i18n-data.js`(zh/en/es 三处)
- Modify: `src/modules/i18n.js`(菜单 action→i18n 键映射区,502 行附近 `'tab-close': 'closeTab'` 同款)
- Test: `test/entry-scripts.test.cjs`(已有,追加断言)、`test/i18n.test.cjs`(已有则追加,无则只跑 entry)

**Interfaces:**
- Produces: 菜单 action id `tab-open-in-window`(Task 4 的 executeMenuAction case 与之对齐);i18n 键 `openInNewWindow`(标签「在新窗口打开」/「Open in New Window」/「Abrir en nueva ventana」)
- Consumes: `window.TMMultiWindow`(Task 1 模块,script 标签顺序放在 constants.js 之后、tabs.js 之前)

- [ ] **Step 1: 写失败断言** — `test/entry-scripts.test.cjs` 追加:index.html 含 `<script src="modules/multi-window.js">` 且位于 modules/constants.js 之后;`#context-menu-tab` 内含 `data-action="tab-open-in-window"`。
- [ ] **Step 2: 跑该测试确认失败**

Run: `node --test --test-concurrency=1 test/entry-scripts.test.cjs`
Expected: FAIL

- [ ] **Step 3: 实现** — index.html 加 script 标签 + 菜单项(仿 tab-copy-path 条目结构);i18n-data.js 三语加 `openInNewWindow`;i18n.js 菜单映射加 `'tab-open-in-window': 'openInNewWindow'`(逐字仿 `'tab-close': 'closeTab'` 行)。
- [ ] **Step 4: 跑测试确认通过**(同 Step 2 命令,Expected PASS;i18n 相关既有测试一并跑:`node --test --test-concurrency=1 test/i18n.test.cjs 2>/dev/null || true` 有则须过)
- [ ] **Step 5: Commit** `feat(多窗口): tab 右键菜单「在新窗口打开」入口与三语文案`

---

### Task 3: TauriApi.createEditorWindow + capabilities 扩展

**Files:**
- Modify: `src/modules/tauri-api.js`(双导出 api 对象追加方法)
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/src/lib.rs`(仅 window-state 插件初始化行,1432 行)
- Test: `test/capabilities.test.cjs`(已有,追加断言)

**Interfaces:**
- Produces: `TauriApi.createEditorWindow(label: string, geometry: {x,y,width,height}) -> Promise<WebviewWindow|null>` — 用 `__TAURI__.webviewWindow.WebviewWindow`(`withGlobalTauri` 已开),url `'index.html?label=' + label`,选项 `{x,y,width,height, minWidth:800, minHeight:600, decorations:false, visible:true, backgroundColor:'#f5f5f5'}`;浏览器环境(无 `__TAURI__`)返回 null。`TauriApi.listEditorWindows() -> Promise<string[]>` — invoke Rust 命令 `list_editor_windows`(Task 5 实现,本任务先按此签名调用)。
- Consumes: Task 1 无依赖;与 Task 5 的 Rust 命令名 `list_editor_windows` 互为约定。

- [ ] **Step 1: 写失败断言** — `test/capabilities.test.cjs` 追加:`windows` 数组含 `"main"` 与 `"editor-*"`;permissions 含 `core:webview:allow-create-webview-window`。
- [ ] **Step 2: 跑确认失败**

Run: `node --test --test-concurrency=1 test/capabilities.test.cjs`
Expected: FAIL

- [ ] **Step 3: 实现**
  - capabilities/default.json:`"windows": ["main", "editor-*"]`;permissions 追加 `core:webview:allow-create-webview-window`(若运行时报权限缺失,以 `src-tauri/gen/` 与 cargo 依赖树里实际权限标识为准修正——tauri 2.11 权限名以 `cargo tauri` 生成清单核对)。
  - tauri-api.js 追加两方法,风格仿现有 `currentWindow()`(命名空间缺失降级 null)。
  - lib.rs:1432 window-state 插件加过滤,跳过 `editor-*` label(已定案:分离窗口几何显式级联,不靠插件恢复):`tauri_plugin_window_state::Builder::default().with_state_filter(|label| !label.starts_with("editor-"))`——API 名以安装版本实际签名为准(`cargo doc`/源码核对),若插件无该 filter 则在 Task 6 的 Destroyed 清理处改用 forget。

- [ ] **Step 4: 跑测试确认通过**(capabilities 测试 PASS;`cargo check` 通过:cargo 需 PATH)
- [ ] **Step 5: Commit** `feat(多窗口): JS 建窗 API 与 capabilities/窗口状态过滤`

---

### Task 4: 撕离动作 detachTabToWindow(tabs.js + 菜单 case + 快捷键)

**Files:**
- Modify: `src/modules/tabs.js`(mixin 追加方法)
- Modify: `src/app.js`(executeMenuAction 追加 case,384-390 行区;TMConst 无需改)
- Modify: `src/modules/shortcuts.js`(getDefaultShortcuts 第 8 行区追加默认项;globalMap 约 811 行区追加 handler)
- Test: `test/tab-detach.test.cjs`(新建,模式仿 test/sidebar-split.test.cjs 的 mixin eval 范式)

**Interfaces:**
- Consumes: Task 1 `buildHandoffPayload/writeHandoff/nextEditorLabel/cascadeGeometry/isDetachedLabel`、`HANDOFF_PREFIX`;Task 3 `TauriApi.createEditorWindow`。
- Produces: `MarkdownEditor.prototype.detachTabToWindow(index: number): Promise<boolean>` — 返回是否撕离成功;快捷键 action id `detachTab`(默认 `Ctrl+Shift+O`,与既有默认无冲突,冲突由 findDuplicateShortcut 机制兜底)。

- [ ] **Step 1: 写失败测试** `test/tab-detach.test.cjs`:
  - mock `TauriApi.createEditorWindow`(记录 label/geometry/payload 返回 Promise)、mock localStorage
  - 用例:`撕离写入交接键并建窗(label=editor-1、几何级联)`、`源窗口移除 tab 且活动索引正确(撕活动 tab/撕非活动 tab/撕唯一 tab 进空态)`、`未保存未命名 tab 完整随迁(payload 含 savedContent、无 filePath)`、`建窗失败则 tab 保留并清交接键`、`executeMenuAction('tab-open-in-window') 调 detachTabToWindow(this._contextTabIndex)`(dispatch case 断言,仿 app-tabs 既有范式)、`isDetachedLabel 下快捷键 handler 调 detachTabToWindow(activeTabIndex)`(globalMap 绑定断言)
- [ ] **Step 2: 跑确认失败**

Run: `node --test --test-concurrency=1 test/tab-detach.test.cjs`
Expected: FAIL

- [ ] **Step 3: 实现**
  - `detachTabToWindow(index)`:守卫 index;`const tab=this.tabs[index]`;若 tab 未加载先 `await this.ensureTabLoaded(tab)`(撕离前补内容);`const labels=await TauriApi.listEditorWindows().catch(()=>[])`;`const label=nextEditorLabel(labels)`;`writeHandoff(label, tab)`;`const geom=cascadeGeometry(await 主窗口几何(), 已有 editor 窗口数)`(主窗口几何经 `TauriApi.currentWindow()` 的 `innerPosition/outerSize` 获取,浏览器降级 {x:100,y:100,width:1200,height:800});`await TauriApi.createEditorWindow(label, geom)` 失败→`clearHandoff` + `this.reportError` + return false;成功→从 tabs 移除(不弹保存询问——状态随迁,复用 closeTab 尾部的索引调整+updateTabBar+ensureTabLoaded 逻辑,抽 `_removeTabNoPrompt(index)` 私有方法),`this.saveSession()`。
  - app.js executeMenuAction:`case 'tab-open-in-window': this.detachTabToWindow(this._contextTabIndex); break;`
  - shortcuts.js:`getDefaultShortcuts()` 加 `detachTab: { key: 'Ctrl+Shift+O', label: '在新窗口打开' }`;globalMap 加 `detachTab: () => this.detachTabToWindow(this.activeTabIndex)`。
- [ ] **Step 4: 跑测试确认通过**(同 Step 2;另跑 `test/settings.test.cjs test/shortcuts*.test.cjs 2>/dev/null || true` 有则须过——快捷键默认表变更的回归)
- [ ] **Step 5: Commit** `feat(多窗口): tab 撕离到新窗口——交接键随迁 + 菜单/快捷键入口`

---

### Task 5: Rust 侧窗口分流 + 事件定向 + list_editor_windows

**Files:**
- Modify: `src-tauri/src/lib.rs`(CloseRequested 1454-1466;single_instance 1437-1443;托盘 quit 268-270;新增命令与纯函数;generate_handler 1480 区注册)
- Test: `src-tauri/src/lib.rs` 内 `#[cfg(test)]`(既有 mod 追加)

**Interfaces:**
- Produces: 纯函数 `fn is_editor_label(label: &str) -> bool`;命令 `list_editor_windows(app) -> Vec<String>`(返回除 `main` 外全部 webview 窗口 label,升序)。
- Consumes: 无(Task 3 的 JS 侧按 `list_editor_windows` 名调用)。

- [ ] **Step 1: 写失败 Rust 单测**(既有 `#[cfg(test)]` mod):`is_editor_label` 真/假/边界(`"editor-"` 假、`"main"` 假、`"editor-12"` 真);`list_editor_windows` 过滤口径(mock 窗口不可行则测纯过滤函数 `fn filter_editor_labels(Vec<String>) -> Vec<String>`,命令体调用它)。
- [ ] **Step 2: cargo test 确认失败**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: FAIL(函数不存在)

- [ ] **Step 3: 实现**
  - `is_editor_label` + `filter_editor_labels` 纯函数。
  - CloseRequested(1454):`let label = window.label();` 分流——`is_editor_label(&label)` → 一律 `api.prevent_close()` + `let _ = window.emit_to(window.label(), "close-requested", ())`(Tauri 2 中 window 自身 emit 即 broadcast,必须用 `Emitter::emit_to` 指定 target label);否则(主窗口):托盘模式维持 prevent_close + `emit_to("main", ...)`;**无托盘模式改为 prevent_close + `emit_to("main", "close-requested")`**(协调退出,设计定案 11)。
  - single_instance(1442):`app.emit("file-open", ...)` → `app.emit_to("main", "file-open", files_from_args(argv))`。
  - 托盘「退出」(268-270):`exit_app(app.clone())` → `if let Some(w)=app.get_webview_window("main") { let _=w.emit_to("main","close-requested",()); } else { exit_app(app.clone()); }`。
  - 新命令 `list_editor_windows` + generate_handler 注册。
  - **命令审计**(spec 定案 10):逐个核对 generate_handler 清单中无 `window` 参数的命令是否隐含 main 假设——`watch_folder/stop_watch` 由 Task 6 处理;`get_cli_args`(仅主窗口 boot 调)、`set_window_behavior`/`set_close_to_tray_shortcut`(托盘语义,主窗口专属,分离窗口不注册 UI 入口)、updater 命令(主窗口触发)预期免改;发现真隐含假设者当场修复并记录,审计结论写进 PR 描述。
- [ ] **Step 4: cargo test 确认通过 + cargo check 零警告**
- [ ] **Step 5: Commit** `feat(多窗口): Rust 窗口关闭分流、事件定向 emit、list_editor_windows`

---

### Task 6: Rust per-label WatcherState

**Files:**
- Modify: `src-tauri/src/lib.rs`(WatcherState 751;watch_folder/stop_watch 753-806;on_window_event 追加 Destroyed 清理)
- Test: `src-tauri/src/lib.rs` `#[cfg(test)]`

**Interfaces:**
- Produces: `WatcherState(pub Mutex<HashMap<String, Option<RecommendedWatcher>>>)`;watch_folder/stop_watch 命令签名对前端不变(新增 `window: tauri::WebviewWindow` 参数,Tauri 自动注入,前端 files.js 无需改)。`folder-changed`/`folder-watch-error` 改 `emit_to(owner_label)`。
- Consumes: Task 5 无直接依赖。

- [ ] **Step 1: 写失败单测**:watcher map 的纯逻辑抽 `fn owner_label_from(window_label: &str) -> String`(恒等,便于测试点),`HashMap` 插入/替换/删除口径测试。
- [ ] **Step 2: cargo test 确认失败**(结构变化编译失败即视为失败信号)
- [ ] **Step 3: 实现**
  - 状态改 `Mutex<HashMap<String, Option<RecommendedWatcher>>>`。
  - `watch_folder(path, window)`:label 取 `window.label()`;先 drop 该 label 旧 watcher;回调闭包捕获 `(app_handle, label)`,`folder-changed`/`folder-watch-error` 均 `emit_to(&label, ...)`;写入 map[label]。
  - `stop_watch(window)`:移除 map[label]。
  - `on_window_event` 追加 `WindowEvent::Destroyed`:从 map 移除该 label(分离窗口关闭即回收 watcher;主窗口 Destroyed 进程将退,无碍)。
  - 其余口径不变:回调内仍 catch_unwind、无锁。
- [ ] **Step 4: cargo test 通过 + cargo check 零警告;前端回归 `node --test --test-concurrency=1 test/file-watcher*.test.cjs test/sidebar-split.test.cjs 2>/dev/null || true`(files.js 未改应不破)
- [ ] **Step 5: Commit** `feat(多窗口): 文件监视器 per-label 化,事件定向归属窗口`

---

### Task 7: boot 分叉 + 分离窗口消费交接 + 会话键参数化

**Files:**
- Modify: `src/app.js`(DOMContentLoaded 491-612:file-open 注册 542 行加 `!boot.detached` 门;boot 参数分支包 restoreSession/CLI/版本逻辑)
- Modify: `src/modules/files.js`(loadSession/saveSession 89-125 键参数化;新增 restoreDetachedTab)
- Modify: `src/modules/lifecycle.js`(initWakeRecovery 无关不动)
- Test: `test/detached-boot.test.cjs`(新建)

**Interfaces:**
- Consumes: Task 1 `parseBootParams/readHandoff/clearHandoff/sweepStaleHandoffs/HANDOFF_PREFIX`、`isDetachedLabel`。
- Produces: 纯函数 `resolveBootMode(search)`(multi-window.js 已有 parseBootParams,app.js 直接用,不重复造);`MarkdownEditor.prototype.restoreDetachedTab(payload): Promise<Tab>`(files.js mixin——按 payload 重建 Tab、kind 归一(FileTypes.classifyFile)、恢复光标/滚动、不读盘当 `_loaded:true`,filePath 存在且 payload._loadError 时走 ensureTabLoaded 报错路径);`this.sessionKey(): string`(detached→`tizumark-session-<label>`,主→`tizumark-session`)。

- [ ] **Step 1: 写失败测试** `test/detached-boot.test.cjs`:
  - `parseBootParams('?label=editor-2') → detached:true`(委托 Task 1,烟测)
  - `sessionKey: 主窗口默认键 / detached 键含 label`(mixin eval 范式,sessionKey 读 parseBootParams 结果缓存于 `this._boot`)
  - `restoreDetachedTab: 完整 payload 重建 Tab(_loaded=true、不读盘)`、`kind 归一(image 路径)`、`_loadError 走报错路径`
  - `主窗口 saveSession 写默认键、detached saveSession 写 label 键`(mock localStorage)
- [ ] **Step 2: 跑确认失败**

Run: `node --test --test-concurrency=1 test/detached-boot.test.cjs`
Expected: FAIL

- [ ] **Step 3: 实现**
  - app.js:DOMContentLoaded 开头 `const boot = parseBootParams(window.location.search); window.__tizumarkBoot = boot;`;file-open 注册包 `if (!boot.detached)`;主窗口 boot 分支加 `TMMultiWindow.sweepStaleHandoffs(localStorage)`;restoreSession/CLI/版本块包 `if (!boot.detached)`;detached 分支:`const payload = TMMultiWindow.readHandoff(boot.label, localStorage); if (!payload) { 报错条 + await TauriApi.currentWindow()?.destroy(); return; }` → `const tab = await window.editor.restoreDetachedTab(payload.tab); await window.editor.addTab(tab.name, tab.content, tab.filePath, tab.kind)`(addTab 后覆写 tab 状态:cursorPos/scrollPos/previewScrollTop/savedContent/pendingExternalChange/fileMeta 从 payload 回填,再 switchTab 恢复)→ `TMMultiWindow.clearHandoff(boot.label, localStorage)`。folder-changed/folder-watch-error 监听两模式都注册(事件已定向)。
  - files.js:loadSession/saveSession 用 `this.sessionKey()`;saveSession/restoreSession 内部默认行为不变。sessionKey mixin 方法放 tabs.js 或 files.js均可,放 files.js。
- [ ] **Step 4: 跑测试确认通过**(同 Step 2;另跑 `test/app-session.test.cjs test/app-core.test.cjs test/entry-scripts.test.cjs` 相关回归须过)
- [ ] **Step 5: Commit** `feat(多窗口): boot 分叉——分离窗口消费交接态,会话键按 label 拆分`

---

### Task 8: 退出协调 + 会话聚合 + 更新安装前置协调

**Files:**
- Modify: `src/modules/lifecycle.js`(handleAppClose 117-172 分叉;新增 coordinateQuit)
- Modify: `src/modules/updater.js`(installUpdate 315 行入口前置协调)
- Modify: `src/modules/tauri-api.js`(追加 `emitTo(label, event, payload)` 薄封装,`__TAURI__.event.emitTo`,命名空间缺失降级)
- Modify: `src/app.js`(detached 模式注册 `app-quit-request` 监听)
- Test: `test/quit-coordination.test.cjs`(新建)

**Interfaces:**
- Consumes: Task 1 `mergeDetachedSessions/HANDOFF_PREFIX`、Task 3 `TauriApi.listEditorWindows`、Task 5 Rust 事件定向。
- Produces: `MarkdownEditor.prototype.coordinateQuit(): Promise<boolean>` — 枚举分离窗口→逐个 `emitTo(label,'app-quit-request')`→等待每窗 `app-quit-ready`/`app-quit-aborted`(60s 超时)→全 ready 则聚合会话并 `TauriApi.quitApp()`,true;任一 aborted/超时 false。`handleAppClose` detached 分支:自身保存询问→`saveSession()`→`currentWindow().close()`。事件载荷 `{label}`(aborted 时带原因)。

- [ ] **Step 1: 写失败测试** `test/quit-coordination.test.cjs`:
  - `coordinateQuit: 无分离窗口直接聚合+quitApp`
  - `全 ready → 聚合各 editor 会话进主 session 并清 editor 键 → quitApp`(mock emitTo/监听收发)
  - `任一 aborted → 不 quitApp、主窗口保留`
  - `60s 超时(测试用注入短超时)→ 不 quitApp`
  - `detached handleAppClose:有未保存→弹询问,选保存→saveSession(label 键)→close 自身,不触 quit`
  - `mergeDetachedSessions 聚合用例(委托 Task 1 烟测)`
- [ ] **Step 2: 跑确认失败**

Run: `node --test --test-concurrency=1 test/quit-coordination.test.cjs`
Expected: FAIL

- [ ] **Step 3: 实现**
  - lifecycle.js:handleAppClose 开头 `if (isDetachedLabel(TauriApi.currentWindow()?.label))` → detached 分支(保存询问复用现有 modified 流程,保存/丢弃后 `await this.saveSession(); await TauriApi.currentWindow().close(); return;`;close 会再触发 CloseRequested→Task 5 已分流为 emit_to 自身→二次 handleAppClose 时已无 modified,直接 close——需幂等守卫 `this._closingWindow` 标志防循环)。
  - 主窗口分支:action==='quit' 时先 `const ok = await this.coordinateQuit(); if (!ok) return;`,原 clearTabsOnQuit/saveSession 逻辑不变,最后 quitApp。'minimize' 托盘分支不变。
  - coordinateQuit:`const labels = await TauriApi.listEditorWindows();`;对每个 label `TauriApi.emitTo(label, 'app-quit-request', {from: 'main'})`(tauri-api.js 加 `emitTo` 薄封装,`__TAURI__.event.emitTo`);监听 `app-quit-ready`/`app-quit-aborted`(event.label 归属);注入参数 `_timeoutMs`(默认 60000)便于测试;全 ready → 读各 `tizumark-session-editor-<label>` 键,`mergeDetachedSessions(this.loadSession(), detachedSessions)` 写回主键,删除全部 editor 会话键与 HANDOFF_PREFIX 键。
  - app.js detached boot 分支追加:`await TauriApi.onEvent('app-quit-request', () => window.editor.handleAppClose())`(detached 分支自身保存询问完成后 emitTo('main','app-quit-ready')——在 lifecycle detached 分支 close 前 emit)。
  - updater.js installUpdate():入口先 `if (!(await window.editor.coordinateQuit())) return;`(协调取消则不安装——安装重启会杀全部窗口,设计定案 11)。
- [ ] **Step 4: 跑测试确认通过**(同 Step 2;另跑 `test/editor-clear-tabs-on-quit.test.cjs` 回归须过)
- [ ] **Step 5: Commit** `feat(多窗口): 退出协调握手、会话聚合、更新安装前置协调`

---

### Task 9: 全量回归 + 真机验证 + PR

**Files:**
- Modify: 无新代码;修测试发现的回归

**Interfaces:**
- Consumes: 全部前序任务。

- [ ] **Step 1: 渲染器 bundle 确认**——本计划未动 unified-renderer.js,跑 `npm run build:renderer` 一次确保产物与源一致(pretest 亦会兜底)。
- [ ] **Step 2: 全量前端测试**

Run: `npm test > /tmp/tizumark-full-test.log 2>&1; echo EXIT=$?`(后台跑,>10 分钟;CHROME_PATH 设 x86 Chrome 以真跑浏览器测试,勿信 ok (0/0))
Expected: 175+ 文件全过、0 失败、EXIT=0

- [ ] **Step 3: Rust 全量**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
Expected: 全过、零警告

- [ ] **Step 4: 项目门禁**

Run: `npm run check`
Expected: 无违规

- [ ] **Step 5: 真机验证(用户参与,per [[verify-before-pr]])**——`npm run dev`(cargo PATH 已加),核对清单:
  1. 右键 tab「在新窗口打开」/`Ctrl+Shift+O` → 新窗口出现且**未保存修改的未命名 tab** 内容与修改态完整
  2. 源窗口 tab 移除、唯一 tab 撕离进空态欢迎页
  3. 分离窗口可继续开文件、可切换工作区,两窗口文件树各自自动刷新(互不偷 watcher)
  4. 同文件双开:A 窗口保存 → B 窗口出现外部变更 banner
  5. 分离窗口点 X 只关自己;主窗口 X(无托盘设置下)→ 分离窗口各有保存询问,取消则整体不退
  6. 托盘「退出」走协调;更新安装按钮在分离窗口有未保存时先协调
  7. 重启后:分离窗口曾打开的文件以主窗口 tab 恢复
- [ ] **Step 6: 推分支 + 提 PR**

```bash
git push -u origin feat/tab-tearoff-window
gh pr create --repo tizuio/TizuMark-Markdown-Editor --base master --head <fork>:feat/tab-tearoff-window \
  --title "feat(editor): tab 撕离成独立编辑器窗口(多窗口)" \
  --body " closes/ref tizuio#28(第1条) ref tizuio#70;设计文档 docs/superpowers/specs/2026-11-18-tab-tearoff-window-design.md"
```

(先经用户真机确认再提 PR;PR 描述附真机验证清单结果)
