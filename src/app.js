
// 超大文档预览保护阈值：超过则预览只渲染头部，避免整篇同步解析/渲染卡死主线程
const MAX_PREVIEW_LINES = 5000;
const MAX_PREVIEW_CHARS = 4 * 1024 * 1024;
// 头部渲染的字符上限（防止含超长行的文档渲染耗时过久）
const HEAD_RENDER_CHAR_CAP = 1.5 * 1024 * 1024;
// 大文档预览滑动窗口：预览只渲染围绕当前焦点的一段源码，避免整篇渲染卡死，
// 同时保证任意位置（大纲跳转 / 滚动）都可在预览中落点
const PREVIEW_WINDOW_LINES = 1200;  // 窗口源码行数上限
const PREVIEW_WINDOW_LEAD = 200;    // 焦点行前预留行数（让焦点不至于贴顶）

// 快捷插入（slash）命令分类：
//  - 字体相关操作（加粗/斜体/删除线/高亮）默认隐藏并置底；
//  - 前置高频项（行内代码/水平线/引用块/代码块）默认排在最前；
//  - 其余项默认显示、保持原相对顺序排在中间。
const SLASH_FONT_ACTIONS = ['insert-bold', 'insert-italic', 'insert-strikethrough', 'insert-highlight'];
const SLASH_FRONT_ACTIONS = ['insert-inline-code', 'insert-hr', 'insert-quote', 'insert-code-block'];
// 默认隐藏集合 = 字体类（开关默认关闭）；其余开关默认开启
const DEFAULT_SLASH_HIDDEN = SLASH_FONT_ACTIONS.slice();

// 系统字体由 Rust 命令 list_system_fonts 精确枚举（fontdb，跨平台），
// 不内置任何字体文件（等线/微软雅黑/苹方等版权字体绝不打包分发）。
// 下拉框仅展示白名单内、且本机确实已安装的字体（避免几百个系统字体刷屏）；
// 白名单外的已选中字体仍会保留显示（见 refreshFontSelectors）。
const SYSTEM_FONT_WHITELIST = [
  // 中文黑体（Windows / macOS / Linux）
  'Microsoft YaHei', 'Microsoft YaHei UI', 'DengXian', 'SimHei',
  'PingFang SC', 'PingFang TC', 'Hiragino Sans GB', 'STHeiti',
  'Noto Sans CJK SC', 'Source Han Sans SC', 'WenQuanYi Micro Hei', 'Noto Sans SC',
  // 中文宋体 / 楷体
  'SimSun', 'NSimSun', 'Songti SC', 'STSong',
  'KaiTi', 'Kaiti SC', 'STKaiti', 'FangSong',
  // 等宽（拉丁为主）
  'Consolas', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Source Code Pro',
  'Menlo', 'Monaco', 'Courier New', 'Courier', 'DejaVu Sans Mono', 'Liberation Mono',
  // 无衬线
  'Segoe UI', 'Tahoma', 'Arial', 'Helvetica Neue', 'Roboto', 'Ubuntu', 'DejaVu Sans', 'Noto Sans',
  // 衬线
  'IBM Plex Serif', 'Times New Roman', 'Georgia', 'DejaVu Serif', 'Liberation Serif', 'Cambria',
];
const SYSTEM_FONT_WHITELIST_SET = new Set(SYSTEM_FONT_WHITELIST.map((s) => s.toLowerCase()));

// CJK 字体中英文族名映射：英文族名 → 中文显示名（拉丁字体中英文同名，无需映射）。
// fontdb 枚举返回中英文两套族名（如「Microsoft YaHei」与「微软雅黑」），
// 显示层按 UI 语言取对应名；存储 value 始终用英文族名（旧设置兼容、CSS 渲染最稳）。
const FONT_NAME_LOCALE = {
  // Windows
  'Microsoft YaHei': '微软雅黑',
  'DengXian': '等线',
  'SimHei': '黑体',
  'SimSun': '宋体',
  'NSimSun': '新宋体',
  'KaiTi': '楷体',
  'FangSong': '仿宋',
  // macOS
  'PingFang SC': '苹方-简',
  'PingFang TC': '苹方-繁',
  'Hiragino Sans GB': '冬青黑体简体中文',
  'STHeiti': '华文黑体',
  'Songti SC': '宋体-简',
  'STSong': '华文宋体',
  'Kaiti SC': '楷体-简',
  'STKaiti': '华文楷体',
  // Linux
  'WenQuanYi Micro Hei': '文泉驿微米黑',
  'Noto Sans CJK SC': '思源黑体',
  'Source Han Sans SC': '思源黑体',
};
// 归一映射（小写中文名/变体名 → 主族英文 value）：
// ① 把枚举返回的中文名条目（微软雅黑/宋体…）归一为英文 value，与英文条目合并去重；
// ② 视觉一致的变体（微软雅黑 UI 中文名同为「微软雅黑」）合并进主族，避免下拉重复。
const FONT_LOCALE_REV = new Map([
  ...Object.entries(FONT_NAME_LOCALE).map(([en, zh]) => [zh.toLowerCase(), en]),
  ['microsoft yahei ui', 'Microsoft YaHei'],
]);

async function dialogOpen(options = {}) {
  // 注意：tauriApi.dialogOpen 内部已包一层 { options }（Tauri dialog 插件约定
  // 底层的 IPC 命令 'plugin:dialog|open' 收 { options }），这里必须透传，
  // 不能再包一层——否则双重嵌套会让 Rust 侧解析不到参数。
  return await TauriApi.dialogOpen(options);
}

async function dialogSave(options = {}) {
  return await TauriApi.dialogSave(options);
}

class Tab {
  constructor(name = '', content = '', filePath = null, kind = 'markdown') {
    this.name = name;
    this.content = content;
    this.savedContent = content;
    this.filePath = filePath;
    // 类型：'markdown' | 'image' | 'text' | 'unsupported'（unsupported 不进 Tab，仅用于判断）
    this.kind = kind;
    this.cursorPos = { line: 0, ch: 0 };
    this.scrollPos = { top: 0, left: 0 };
    this.fileMeta = null;
    this.pendingExternalChange = false;
    this._loaded = true;
    this.previewScrollTop = 0;
  }

  get isModified() {
    return this.content !== this.savedContent;
  }
}

// ====== 错误码文案字典（用户友好 + 开发可诊断） ======
// code -> { zh/en: { title, detail } }，detail 支持 {param} 插值
const ERROR_MESSAGES = {
  E_ENCODING: { zh: { title: '文件编码不被支持', detail: '该文件使用了 {encoding} 编码，当前仅支持 UTF-8' }, en: { title: 'Unsupported file encoding', detail: 'This file uses {encoding} encoding, only UTF-8 is supported' } },
  E_ENCODING_UNKNOWN: { zh: { title: '无法识别文件编码', detail: '文件包含无法识别的字符编码' }, en: { title: 'Unrecognized file encoding', detail: 'The file contains an unrecognized encoding' } },
  E_NOT_FOUND: { zh: { title: '文件不存在', detail: '文件「{name}」可能已被移动或删除' }, en: { title: 'File not found', detail: 'File "{name}" may have been moved or deleted' } },
  E_LOCKED: { zh: { title: '文件正被其他程序占用', detail: '请关闭占用「{name}」的程序后重试' }, en: { title: 'File is locked by another program', detail: 'Please close the program using "{name}" and retry' } },
  E_PERMISSION: { zh: { title: '没有访问权限', detail: '系统拒绝访问该文件' }, en: { title: 'Permission denied', detail: 'The system denied access to this file' } },
  E_PATH_TOO_LONG: { zh: { title: '文件路径过长', detail: '路径超过 260 字符，请缩短路径或移动文件' }, en: { title: 'File path too long', detail: 'Path exceeds 260 chars, please shorten or move it' } },
  E_EMPTY: { zh: { title: '无法读取文件内容', detail: '文件内容为空或读取失败' }, en: { title: 'Unable to read file content', detail: 'File is empty or reading failed' } },
  E_IO: { zh: { title: '读取文件时出错', detail: '发生未知读写错误' }, en: { title: 'Error reading file', detail: 'An unknown read/write error occurred' } },
  E_SAVE: { zh: { title: '保存失败', detail: '无法写入「{name}」，请检查路径和权限' }, en: { title: 'Save failed', detail: 'Cannot write to "{name}", check path and permissions' } },
  E_INIT: { zh: { title: '编辑器初始化失败', detail: '程序启动异常，请重启应用' }, en: { title: 'Editor initialization failed', detail: 'Startup error, please restart the app' } },
  E_RENDER: { zh: { title: '内容渲染失败', detail: '部分内容无法正常显示' }, en: { title: 'Content rendering failed', detail: 'Some content could not be displayed' } },
  E_UNKNOWN: { zh: { title: '发生未知错误', detail: '程序遇到意外问题' }, en: { title: 'An unexpected error occurred', detail: 'An unexpected problem occurred' } },
  // 迁移的硬编码中文错误
  openLink: { zh: { title: '无法打开文件', detail: '{href}' }, en: { title: 'Cannot open file', detail: '{href}' } },
  devtools: { zh: { title: '无法打开开发者工具', detail: '' }, en: { title: 'Cannot open DevTools', detail: '' } },
  clipboardImage: { zh: { title: '无法读取剪贴板图片', detail: '' }, en: { title: 'Cannot read clipboard image', detail: '' } },
  guide: { zh: { title: '打开使用说明失败', detail: '' }, en: { title: 'Failed to open guide', detail: '' } },
};

const I18N = {
  zh: {
    quickInsert: '快捷插入',
    manageQuickInsert: '管理快捷插入…',
    quickInsertHint: '在编辑器输入「/」时弹出快捷插入列表，可自定义顺序与显隐。',
    quickInsertOrder: '快捷插入顺序',
    quickInsertOrderHint: '拖动手柄调整顺序，取消勾选可隐藏该项（隐藏后输入「/」不再出现）。',
    quickInsertOrderDone: '完成',
    file: '文件',
    new: '新建',
    open: '打开',
    save: '保存',
    saveAs: '另存为',
    exportHTML: '导出 HTML',
    exportImg: '导出长图',
    exportPDF: '导出 PDF',
    exportWord: '导出DOCX',
    shortcuts: '快捷键设置',
    settings: '设置',
    insert: '插入',
    structure: '结构插入',
    heading: '标题',
    codeBlock: '代码块',
    table: '表格',
    quoteBlock: '引用块',
    callout: '提示块',
    expandToolbar: '展开工具栏',
    collapseToolbar: '收起工具栏',
    mathBlock: '数学公式',
    mermaidChart: 'Mermaid 图表',
    hr: '水平线',
    toc: '目录 [TOC]',
    textFormat: '文本格式',
    bold: '加粗',
    italic: '斜体',
    strikethrough: '删除线',
    inlineCode: '行内代码',
    highlight: '高亮',
    superscript: '上标',
    subscript: '下标',
    list: '列表',
    ul: '无序列表',
    ol: '有序列表',
    taskList: '任务列表',
    linkMedia: '链接与媒体',
    link: '链接',
    image: '图片',
    view: '视图',
    outline: '大纲',
    outlineFilter: '大纲层级',
    outlineFilterAll: '全部',
    outlineFilterH1: '仅 H1',
    outlineFilterH2: '仅 H1–H2',
    outlineFilterH3: '仅 H1–H3',
    outlineFilterH4: '仅 H1–H4',
    outlineFilterH5: '仅 H1–H5',
    outlineFilterH6: '仅 H1–H6',
    help: '帮助',
    userGuide: '使用说明',
    about: '关于',
    versionInfo: 'TizuMark v1.2.2',
    preview: '预览',
    edit: '编辑',
    themeLight: '明亮',
    themeDark: '暗黑',
    minimize: '最小化',
    maximize: '最大化',
    close: '关闭',
    ready: '就绪',
    words: '字数',
    chars: '字符',
    lines: '行数',
    untitled: 'Untitled',
    noHeadings: '暂无标题',
    copy: '复制',
    copied: '已复制',
    copyCode: '复制代码',
    cut: '剪切',
    paste: '粘贴',
    selectAll: '全选',
    findReplace: '查找替换',
    find: '查找',
    replace: '替换',
    replaceAll: '全部替换',
    replaceAllDone: '已替换 {n} 处',
    findNext: '下一个',
    findPrev: '上一个',
    caseSensitive: '区分大小写',
    regex: '正则',
    matches: '个结果',
    noMatches: '无结果',
    tooManyMatches: '结果过多',
    findInPreview: '在预览中查找',
    copyAsHTML: '复制为 HTML',
    closeTab: '关闭',
    closeOther: '关闭其他',
    closeAll: '关闭所有',
    copyFilePath: '复制文件路径',
    recentFiles: '打开最近的文件',
    noRecentFiles: '暂无最近文件',
    clearRecentFiles: '清空最近文件',
    recentWorkspaces: '打开最近的工作区',
    noRecentWorkspaces: '暂无最近工作区',
    clearRecentWorkspaces: '清空最近工作区',
    newFileCreated: '新文件已创建',
    opened: '已打开',
    openedFiles: '已打开 {n} 个文件',
    alreadyOpen: '文件已在打开中',
    saved: '已保存',
    savedAs: '已另存为',
    saveFailed: '保存失败',
    failed: '失败',
    externalChanged: '文件已在外部被修改',
    externalChangedDirty: '文件已在外部被修改，重新加载将丢失未保存的内容',
    reloadFailed: '重新加载失败',
    sessionLoadFailed: '会话恢复失败',
    ecbReload: '重新加载',
    ecbIgnore: '忽略',
    ecbReloadAll: '全部重新加载',
    ecbIgnoreAll: '全部忽略',
    openFailed: '打开失败',
    exportFailed: '导出失败',
    fileModified: '已修改，是否保存？',
    saveChanges: '保存更改',
    dontSave: '不保存',
    cancel: '取消',
    fontSize: '字体大小',
    tabSize: 'Tab 宽度',
    lineWrap: '自动换行',
    lineNumbers: '显示行号',
    codeLineNumbers: '代码块行号',
    codeBlockWrap: '代码块自动换行',
    codeScroll: '代码块滚动条',
    codeScrollHint: '勾选后，较长的代码块会显示纵向滚动条（默认行为）；不勾选时，代码块高度自动撑开、与内容等高，不再出现滚动条。',
    customBg: '自定义底色',
    langZh: '中文',
    langEn: 'English',
    previewFontSize: '正文字号',
    lineHeight: '行高',
    maxWidth: '最大宽度',
    unlimited: '无限制',
    language: '界面语言',
    behavior: '行为',
    themeMode: '主题模式',
    colorScheme: '配色方案',
    schemeDefault: '基准',
    schemeForest: '翠林风',
    schemeNord: '极夜风',
    schemeDusk: '暮紫风',
    schemeSunset: '暖橙风',
    defaultView: '默认视图',
    scrollSync: '滚动同步',
    softBreaks: '软换行（回车即换行）',
    softBreaksHint: '开启后，段落内单个回车直接换行（与「空格+空格+回车」一致），更符合日常写作习惯，也便于从其他笔记软件迁移。关闭则恢复 CommonMark 标准（回车视为空格）。',
    extendedSyntax: '扩展语法高亮（==文字==）',
    extendedSyntaxHint: '开启后，==文字== 会渲染为黄色高亮（TizuMark 扩展语法）。关闭则 ==文字== 原样显示为普通文本，适合粘贴 AI 生成、未遵循该语法的 Markdown，避免被误当成高亮。',
    formatUnsupported: '格式不支持',
    editUnsupported: '编辑模式不支持此类型文件',
    previewUnsupported: '预览模式不支持此类型文件',
    moreFilesHidden: '更多文件未显示',
    operationCancelled: '已取消',
    showTrayIcon: '显示托盘图标',
    showTrayIconHint: '关闭后隐藏系统托盘图标；此时关闭窗口会直接退出应用（否则无法通过托盘恢复窗口）。',
    showAllFiles: '显示所有文件',
    showAllFilesHint: '关闭时文件树只列出软件能识别的格式（Markdown 7 种 / 图片 20 种 / 明文代码 145 种）；打开后显示目录内全部文件，包括不可打开的格式。文件夹始终会显示。',
    tabSizeHint: '每按一次 Tab 键缩进几个空格。列表要往里缩一级（做子列表）也靠这个宽度，建议用 4，最稳。',
    closeAction: '关闭窗口时',
    closeActionAsk: '每次询问',
    closeActionQuit: '退出应用',
    closeActionMinimize: '最小化到托盘',
    followSystem: '跟随系统',
    resetDefault: '恢复默认',
    confirm: '确认',
    confirmMessage: '确定要执行此操作吗？',
    themeSwitched: '已切换到{theme}主题',
    basic: '基本',
    customFonts: '自定义字体',
    systemFonts: '系统字体',
    addFont: '添加字体',
    editorFont: '编辑器字体',
    previewFont: '预览字体',
    codeFont: '代码块字体',
    defaultFont: '默认',
    fontPreview: '字体预览',
    deleteFont: '删除',
    noCustomFont: '尚未添加自定义字体',
    systemFontsLoadFailed: '系统字体列表加载失败',
    systemFontsRetry: '重试',
    noMatchingFonts: '无匹配字体',
    importingFonts: '正在导入字体 ({n}/{total})…',
    confirmDeleteFont: '确定要删除字体「{name}」吗？此操作不可恢复。',
    importSuccess: '成功导入 {n} 个字体',
    importFailed: '失败 {n} 个字体：{detail}',
    fontAlreadyExists: '已存在',
    processing: '处理中…',
    scrollTop: 'TOP',
    collapseEditor: '折叠编辑器',
    collapsePreview: '折叠预览',
    restoreEditor: '恢复编辑器',
    restorePreview: '恢复预览',
    collapseHint: '请先切换到编辑视图再使用折叠功能',
    noteHint: 'Note 提示',
    tipHint: 'Tip 建议',
    warningHint: 'Warning 警告',
    cautionHint: 'Caution 注意',
    importantHint: 'Important 重要',
    version: '版本信息',
    contact: '联系我们',
    contactDesc: '反馈建议 · 报告 Bug · 交流使用心得 · 获取更新',
    qqGroupName: 'QQ 交流群',
    joinGroup: '点击加群',
    license: '许可协议',
    thirdParty: '第三方组件',
    copyright: '版权声明',
    aboutTitle: '关于 TizuMark',
    appName: 'TizuMark',
    appVersion: '1.2.2',
    versionDesc: '轻量级跨平台 Markdown 编辑器',
    buildInfo: '基于 Tauri v2.5 + Rust 构建',
    copyrightLine: 'Copyright (c) 2024-2026 TizuMark',
    proprietary: '本软件基于 GPL v3 开源协议发布。',
    noUnauthorized: '欢迎自由使用、修改和分发，衍生作品须延续 GPL v3 协议。',
    shortcutLabel: { newFile: '新建文件', openFile: '打开文件', saveFile: '保存文件', closeTab: '关闭标签页', find: '查找替换', crossSearch: '跨文件搜索', nextTab: '下一个标签页', prevTab: '上一个标签页', bold: '加粗', italic: '斜体', insertLink: '插入链接', exportPDF: '导出 PDF', inlineCode: '行内代码', strikethrough: '删除线', codeBlock: '代码块', blockquote: '引用块', toggleView: '切换视图', toggleSidebar: '切换侧边栏', toggleTheme: '切换主题', saveAs: '另存为', insertTable: '插入表格', insertImage: '插入图片', insertUl: '无序列表', insertOl: '有序列表', insertTask: '任务列表', insertHr: '水平线', highlight: '高亮标记', insertSuperscript: '上标', insertSubscript: '下标', insertH1: '标题1', insertH2: '标题2', insertH3: '标题3', insertH4: '标题4', insertH5: '标题5', insertH6: '标题6', insertMathBlock: '数学公式', insertMermaid: 'Mermaid 图表', insertToc: '目录', insertCalloutNote: 'Note 提示', insertCalloutTip: 'Tip 建议', insertCalloutWarning: 'Warning 警告', insertCalloutCaution: 'Caution 注意',     insertCalloutImportant: 'Important 重要', moveLineUp: '上移行/选区', moveLineDown: '下移行/选区', fileSearch: '文件搜索', closeToTray: '关闭到托盘' },
    shortcutGroup: { file: '文件', search: '查找与搜索', tabView: '标签页与视图', format: '文本格式', insert: '插入', heading: '标题', callout: '提示块' },
    // 快捷键设置的两大分类（可折叠）：内核固定不可改 + 方案与自定义可改
    builtinShortcutsTitle: '内置快捷键',
    builtinShortcutsHint: '系统固定 · 不可修改',
    configurableShortcutsTitle: '方案与自定义快捷键',
    configurableShortcutsHint: '可套用方案或自行设定',
    builtinNavGroup: '光标与选区',
    builtinEditGroup: '编辑通用',
    shortcutBuiltinOccupied: '「{key}」是系统内置快捷键（{name}），不可占用',
    shortcutScheme: '快捷键方案',
    schemeHint: '切换预设键位方案，或自行修改下方各项',
    crossSearch: '跨文件搜索',
    crossSearchTitle: '跨文件搜索',
    dialogResizeHint: '已调整窗口，双击标题栏可还原默认大小',
    scopeOpenFiles: '已打开文件',
    scopeDir: '目录',
    loopSearch: '循环查找',
    loop: '循环查找',
    searchRunning: '搜索中...',
    totalMatches: '共 {n} 处匹配',
    noResults: '无匹配结果',
    truncated: '结果过多，已截断',
    csBrowse: '浏览',
    csRun: '搜索',
    csQueryPlaceholder: '输入搜索内容...',
    schemeDefault: '默认',
    schemeVSCode: 'VSCode',
    schemeTypora: 'Typora',
    schemeSublime: 'Sublime Text',
    schemeCustom: '自定义',
    schemeOverrideConfirm: '这将覆盖当前所有快捷键，确定切换方案吗？',
    modify: '修改',
    clear: '清除',
    none: '无',
    pressKeys: '按下快捷键...',
    generatingImg: '正在生成长图...',
    preparingPrint: '正在准备打印...',
    exportedImg: '已导出长图',
    exportedHTML: '已导出 HTML',
    exportedPDF: '已导出 PDF',
    exportedWord: '已导出DOCX',
    exportSuccess: '导出成功',
    exportError: '导出失败',
    printTip1: '可在「更多设置」中「取消勾选"页眉和页脚"」，去除 PDF 顶部的日期、标题等多余信息。',
    printTip2: '如果代码高亮或背景色显示异常，请在「更多设置」中「勾选"背景图形"」。',
    pdfBigFileWarn: '⚠ 文件较大时生成 PDF 耗时较长，请耐心等待；如果未生成完就打开 PDF，会提示文件损坏',
    wordTip1: 'DOCX 由 HTML 导入生成，复杂排版可能与预览略有差异。',
    wordTip2: '公式、Mermaid 图表会被转为图片；代码块保留灰底但不含语法高亮色。',
    wordBigFileWarn: '⚠ 文件较大时生成 DOCX 耗时较长，请耐心等待。',
    preparingWordExport: '正在导出 DOCX...',
    backendDown: '⚠ 开发环境：后端已断开，文件功能不可用。请重启 npm run dev。',
    folderWatchErrorTitle: '文件夹监听异常',
    folderWatchErrorMessage: '目录树可能不会自动刷新。点击「确认」重新监听，或点击「取消」继续使用。',
    folderWatchRecovered: '已重新监听文件夹',
    editor: '编辑器',
    previewSection: '预览',
    column1: '列1',
    column2: '列2',
    column3: '列3',
    content: '内容',
    noteContent: '提示内容',
    tipContent: '建议内容',
    warningContent: '警告内容',
    cautionContent: '注意内容',
    importantContent: '重要内容',
    linkText: '链接文本',
    notSaved: '该文件尚未保存',
    pathCopied: '已复制文件路径',
    copyFailed: '复制失败',
    openedGuide: '已打开使用说明',
    openedGuideEn: 'Opened User Guide',
    failedGuide: '打开使用说明失败',
    giteeAction: '访问仓库',
    githubAction: '访问仓库',
    giteeTitle: '访问 Gitee 仓库',
    githubTitle: '访问 GitHub 仓库',
    qqTitle: '点击加群',
    donateTitle: '捐赠支持',
    donateDesc: '如果 TizuMark 帮到了你，欢迎支持一下。',
    donateWechat: '微信赞赏',
    donateAlipay: '支付宝赞赏',
    depCodeMirror: '代码编辑器组件',
    depHighlight: '语法高亮库',
    depCmark: 'Markdown 解析器（Rust）',
    depKatex: '数学公式渲染',
    depMermaid: '图表绘制库',
    depHtml2canvas: '截图导出',
    depTauri: '桌面应用框架',
    spaces: '空格',
    applying: '正在应用…',
    saving: '正在保存…',
    apply: '应用',
    appliedSuccess: '应用成功',
    savedSuccess: '保存成功',
    ok: '确定',
    browse: '浏览...',
    reloadFile: '重新加载文件',
    toggleTheme: '切换主题',
    collapseExpandToolbar: '折叠/展开工具栏',
    closeNotice: '关闭提示',
    insertLink: '插入链接',
    insertImage: '插入图片',
    imageSourceLocal: '本地图片',
    imageSourceWeb: '网络图片',
    imageAltLabel: '替代文本',
    closeAppTitle: '关闭应用',
    minimizeToTray: '最小化到托盘',
    quitApp: '退出应用',
    updateAvailableSuffix: '可用',
    updateCurrentVersionLabel: '当前版本:',
    updateNotes: '更新内容',
    updateLatestPrefix: '当前已是最新版本',
    updateLatestSuffix: '，无需更新',
    updateSkip: '稍后再说',
    csDirPlaceholder: '目录路径',
    largeFileNotice: '⚠ 文档过大（约 {lines} 行 / {size} MB），预览仅显示当前位置附近内容，滚动编辑区可逐步查看全文。',
    dontRemind: '不再提醒',
    shortcutOccupied: '快捷键 "{key}" 已被「{name}」占用',
    progressCheckingEula: '正在检查许可协议…',
    progressInitEditor: '正在初始化编辑器…',
    progressRegisterEvents: '正在注册事件监听…',
    progressLoadingFile: '正在加载文件…',
    progressReady: '准备就绪',
    devtoolsOpened: 'DevTools 已打开',
    devtoolsOpenFailed: 'DevTools 打开失败: {err}',
    devtools: '开发者工具',
    closeAppMsg: '请选择关闭应用时的操作：',
    rememberChoice: '记住选择，不再询问',
    errorCodePrefix: '错误码 {code}',
    shortcutsReset: '已恢复默认快捷键',
    saveDialogMessage: '文件已修改，是否保存？',
    imageLoadFailed: '[图片加载失败]',
    dropFileHere: '拖放文件到此处打开',
    allFiles: '所有文件',
    tablistLabel: '标签页',
    closeAria: '关闭',
    heading1: '# 标题 1',
    heading2: '## 标题 2',
    heading3: '### 标题 3',
    heading4: '#### 标题 4',
    heading5: '##### 标题 5',
    heading6: '###### 标题 6',
    previewMode: '预览模式',
    editMode: '编辑模式',
    newTab: '新建标签页',
    scrollLeft: '向左滚动',
    scrollRight: '向右滚动',
    backToTop: '回到顶部',
    loading: '加载中...',
    cursorPos: '行 {line}, 列 {col}',
    insertLinkTitle: '插入链接',
    linkText: '显示文本',
    linkUrl: '链接地址',
    insertImageTitle: '插入图片',
    imageSource: '图片来源',
    imageLocal: '本地图片',
    imageWeb: '网络图片',
    imageFile: '文件',
    imageBrowse: '浏览...',
    imageUrlLabel: '图片地址',
    imageAlt: '替代文本',
    imageAltHint: '当图片无法显示时展示此文本，屏幕阅读器也用它描述图片内容。',
    imageStoreModeHint: '图片存储支持复制到 assets/ 和 Base64 嵌入两种方式，可在设置中更改。',
    imageStoreMode: '存储方式',
    imageStoreAssets: '复制到 assets/（推荐）',
    imageStoreBase64: 'Base64 嵌入',
    imageStoreAssetsHint: '复制到 assets/：图片保存为独立文件，md 文件轻量，便于版本管理。',
    imageStoreBase64Hint: 'Base64 嵌入：图片编码到 md 文件内，单文件即可分享，但文件体积显著增大（约原图1.4倍），修改图片需重新编码。',
    imageSettingLabel: '图片存储方式',
    imageSettingAssets: '复制到 assets/（推荐）',
    imageSettingBase64: 'Base64 嵌入',
    imageSettingHint: '复制到 assets/：图片保存为独立文件，md 文件轻量，便于版本管理。Base64 嵌入：图片编码到 md 文件内，单文件即可分享，但文件体积显著增大（约原图1.4倍），修改图片需重新编码。',
    imageAssetPathLabel: '图片存储路径',
    imageAssetPathModeRelative: '相对路径',
    imageAssetPathModeAbsolute: '绝对路径',
    imageAssetPathRelativeHint: '相对于 markdown 文件所在目录的路径。例如 <code>assets</code> → 图片将保存在 <code>docs/assets/</code>。将整个文件夹移动到其他位置后，路径仍然有效，无需额外操作。',
    imageAssetPathAbsoluteHint: '完整的磁盘路径。例如 D:/images → 图片将直接保存到 D:/images/。如果将 markdown 文件夹移动到其他位置，图片路径会失效，需要手动更新引用。',
    imageAssetPathPlaceholder: 'assets',
    imageFileRequired: '请选择要插入的本地图片',
    imageUrlRequired: '请输入网络图片地址',
    needSaveFirst: '请先保存 markdown 文件后再插入图片',
    imageFallbackBase64: '文件未保存，已自动切换为 Base64 嵌入',
    imagePasted: '图片已粘贴',
    imagePasteFailed: '图片粘贴失败',
    linkAutoDetected: '（已从剪贴板检测到链接）',
    checkUpdate: '检查更新',
    updateChecking: '正在检查更新...',
    updateAvailable: '发现新版本',
    updateLatest: '已是最新版本',
    updateDownloadLabel: '下载更新',
    updateDownloading: '下载中...',
    updateInstallNow: '立即安装',
    updateLater: '稍后再说',
    updateReady: '更新已就绪，是否现在安装？',
    updateNoUpdate: '已是最新版本',
    updateFailed: '检查更新失败',
    updateConfirm: '确认',
    updateProgress: '下载中 {pct}%',
    noUpdateNotes: '暂无更新说明',
    unsafeRegex: '正则表达式不安全或过长',
    filesModifiedConfirm: '有 {n} 个文件未保存，是否保存更改？',
    saveAll: '保存全部',
    discardAll: '放弃全部',
    fileOpened: '已打开: {name}',
    openFolder: '打开文件夹',
    files: '文件',
    closeFolder: '关闭文件夹',
    openContainingFolder: '打开所在目录',
    openFolderFailed: '无法打开文件管理器，请手动定位目录',
    sortBy: '排序',
    sortByName: '名称',
    sortByTime: '修改时间',
    sortByCreated: '创建时间',
    modifiedLabel: '修改',
    createdLabel: '创建',
    createdUnknown: '创建时间未知',
    modifiedFullTitle: '修改时间: ',
    createdFullTitle: '创建时间: ',
    sizeFullTitle: '大小: ',
    fileSort: '排序方式',
    sortAsc: '升序',
    sortDesc: '降序',
    folderOpened: '已打开文件夹: {path}',
    extraDirsIgnoredBatch: '已忽略 {n} 个多余目录（每次仅打开一个文件夹）',
    fontSizeChanged: '字号 {size}px',
    fontSizeHint: '编辑器字号 {size}px',
    previewFontSizeHint: '预览字号 {size}px',
    fontSizeReset: '还原 {base}px',
    switchWorkspaceTitle: '切换工作区',
    switchWorkspaceMsg: '当前已打开工作区，是否切换到 {path}？',
    sidebar: '侧边栏',
    // 文件树右键操作（合并自 PR #36）
    fileNewFile: '新建文件',
    newFileNamePrompt: '文件名称（含扩展名，如 note.md）',
    fileNewFolder: '新建文件夹',
    newFolderNamePrompt: '文件夹名称',
    fileCreateFailed: '创建失败',
    nameExists: '已存在同名文件或文件夹',
    nameEmpty: '名称不能为空',
    nameInvalid: '名称包含非法字符（/ \\ : * ? " < > |）',
    fileRename: '重命名',
    renamePrompt: '新名称',
    fileRenameFailed: '重命名失败',
    fileDelete: '删除',
    confirmDeleteFolder: '确定要删除文件夹「{name}」及其所有内容吗？此操作不可撤销。',
    confirmDeleteFile: '确定要删除文件「{name}」吗？',
    fileDeleteFailed: '删除失败',
    fileCutDone: '已剪切到剪贴板',
    fileCopyDone: '已复制到剪贴板',
    clipboardEmpty: '剪贴板为空',
    pasteIntoSelf: '不能将目录粘贴到自身或其子目录内',
    filePasteDone: '已粘贴',
    fileCopyPath: '复制路径',
  },
  en: {
    quickInsert: 'Quick Insert',
    manageQuickInsert: 'Manage Quick Insert…',
    quickInsertHint: 'Typing "/" in the editor opens the quick-insert menu. You can reorder and show/hide items.',
    quickInsertOrder: 'Quick Insert Order',
    quickInsertOrderHint: 'Drag the handle to reorder. Uncheck to hide an item (hidden items no longer appear when typing "/").',
    quickInsertOrderDone: 'Done',
    file: 'File',
    new: 'New',
    open: 'Open',
    recentFiles: 'Open Recent',
    noRecentFiles: 'No recent files',
    clearRecentFiles: 'Clear Recent Files',
    recentWorkspaces: 'Open Recent Workspaces',
    noRecentWorkspaces: 'No recent workspaces',
    clearRecentWorkspaces: 'Clear Recent Workspaces',
    save: 'Save',
    saveAs: 'Save As',
    exportHTML: 'Export HTML',
    exportImg: 'Export Image',
    exportPDF: 'Export PDF',
    exportWord: 'Export DOCX',
    shortcuts: 'Shortcuts',
    settings: 'Settings',
    insert: 'Insert',
    structure: 'Structure',
    heading: 'Heading',
    codeBlock: 'Code Block',
    table: 'Table',
    quoteBlock: 'Blockquote',
    callout: 'Callout',
    expandToolbar: 'Expand Toolbar',
    collapseToolbar: 'Collapse Toolbar',
    externalChanged: 'File changed externally',
    externalChangedDirty: 'File changed externally; reloading will discard unsaved changes',
    reloadFailed: 'Reload failed',
    sessionLoadFailed: 'Session restore failed',
    ecbReload: 'Reload',
    ecbIgnore: 'Ignore',
    ecbReloadAll: 'Reload All',
    ecbIgnoreAll: 'Ignore All',
    mathBlock: 'Math Block',
    mermaidChart: 'Mermaid Chart',
    hr: 'Horizontal Rule',
    toc: 'Table of Contents',
    textFormat: 'Text Format',
    bold: 'Bold',
    italic: 'Italic',
    strikethrough: 'Strikethrough',
    inlineCode: 'Inline Code',
    highlight: 'Highlight',
    superscript: 'Superscript',
    subscript: 'Subscript',
    list: 'List',
    ul: 'Unordered List',
    ol: 'Ordered List',
    taskList: 'Task List',
    linkMedia: 'Links & Media',
    link: 'Link',
    image: 'Image',
    view: 'View',
    outline: 'Outline',
    outlineFilter: 'Outline level',
    outlineFilterAll: 'All',
    outlineFilterH1: 'H1 only',
    outlineFilterH2: 'H1–H2 only',
    outlineFilterH3: 'H1–H3 only',
    outlineFilterH4: 'H1–H4 only',
    outlineFilterH5: 'H1–H5 only',
    outlineFilterH6: 'H1–H6 only',
    help: 'Help',
    userGuide: 'User Guide',
    about: 'About',
    versionInfo: 'TizuMark v1.2.2',
    preview: 'Preview',
    edit: 'Edit',
    themeLight: 'Light',
    themeDark: 'Dark',
    minimize: 'Minimize',
    maximize: 'Maximize',
    close: 'Close',
    ready: 'Ready',
    words: 'Words',
    chars: 'Chars',
    lines: 'Lines',
    untitled: 'Untitled',
    noHeadings: 'No headings',
    copy: 'Copy',
    copied: 'Copied',
    copyCode: 'Copy code',
    cut: 'Cut',
    paste: 'Paste',
    selectAll: 'Select All',
    findReplace: 'Find & Replace',
    find: 'Find',
    replace: 'Replace',
    replaceAll: 'Replace All',
    replaceAllDone: 'Replaced {n} occurrences',
    findNext: 'Next',
    findPrev: 'Previous',
    caseSensitive: 'Case Sensitive',
    regex: 'Regex',
    matches: ' matches',
    noMatches: 'No matches',
    tooManyMatches: 'Too many matches',
    findInPreview: 'Find in Preview',
    copyAsHTML: 'Copy as HTML',
    closeTab: 'Close',
    closeOther: 'Close Others',
    closeAll: 'Close All',
    copyFilePath: 'Copy File Path',
    newFileCreated: 'New file created',
    opened: 'Opened',
    openedFiles: 'Opened {n} files',
    alreadyOpen: 'File already open',
    saved: 'Saved',
    savedAs: 'Saved as',
    saveFailed: 'Save failed',
    failed: 'Failed',
    openFailed: 'Open failed',
    exportFailed: 'Export failed',
    fileModified: ' has been modified. Save?',
    saveChanges: 'Save Changes',
    dontSave: 'Don\'t Save',
    cancel: 'Cancel',
    fontSize: 'Font Size',
    tabSize: 'Tab Size',
    lineWrap: 'Line Wrap',
    lineNumbers: 'Line Numbers',
    codeLineNumbers: 'Code line numbers',
    codeBlockWrap: 'Wrap code blocks',
    codeScroll: 'Code block scrollbar',
    codeScrollHint: 'When enabled, long code blocks show a vertical scrollbar (default). When disabled, the code block grows to fit its content height and no scrollbar appears.',
    customBg: 'Custom background',
    langZh: 'Chinese',
    langEn: 'English',
    previewFontSize: 'Preview Font Size',
    lineHeight: 'Line Height',
    maxWidth: 'Max Width',
    unlimited: 'Unlimited',
    language: 'Language',
    behavior: 'Behavior',
    themeMode: 'Theme Mode',
    colorScheme: 'Color Scheme',
    schemeDefault: 'Default',
    schemeForest: 'Forest',
    schemeNord: 'Nord',
    schemeDusk: 'Dusk',
    schemeSunset: 'Sunset',
    defaultView: 'Default View',
    scrollSync: 'Scroll Sync',
    softBreaks: 'Soft Line Break (Enter = newline)',
    softBreaksHint: 'When enabled, a single Enter inside a paragraph creates a line break (same as "two spaces + Enter"), matching everyday writing and easing migration from other note apps. When disabled, CommonMark standard applies (Enter is treated as a space).',
    extendedSyntax: 'Extended syntax highlight (==text==)',
    extendedSyntaxHint: 'When enabled, ==text== renders as a yellow highlight (TizuMark extended syntax). When disabled, ==text== shows as plain text, which is useful for AI-generated Markdown that does not follow this syntax and would otherwise be misinterpreted as a highlight.',
    formatUnsupported: 'Format not supported',
    editUnsupported: 'Edit mode does not support this file type',
    previewUnsupported: 'Preview mode does not support this file type',
    moreFilesHidden: 'More files not shown',
    operationCancelled: 'Cancelled',
    showTrayIcon: 'Show tray icon',
    showTrayIconHint: 'When disabled, the system tray icon is hidden; closing the window then quits the app directly (otherwise the window could not be restored via the tray).',
    showAllFiles: 'Show all files',
    showAllFilesHint: 'When off, the file tree only lists formats the app can open (7 Markdown / 20 image / 145 text/code). Turn on to show every file in the folder, including ones that cannot be opened. Folders are always shown.',
    tabSizeHint: 'How many spaces a Tab press indents. Indenting a list one level (to make a sub-list) also uses this width; 4 is recommended for the safest nesting.',
    closeAction: 'On window close',
    closeActionAsk: 'Ask every time',
    closeActionQuit: 'Quit app',
    closeActionMinimize: 'Minimize to tray',
    followSystem: 'Follow System',
    resetDefault: 'Reset Default',
    confirm: 'Confirm',
    confirmMessage: 'Are you sure you want to continue?',
    themeSwitched: 'Switched to {theme} theme',
    basic: 'Basic',
    customFonts: 'Custom Fonts',
    systemFonts: 'System Fonts',
    addFont: 'Add Font',
    editorFont: 'Editor Font',
    previewFont: 'Preview Font',
    codeFont: 'Code Block Font',
    defaultFont: 'Default',
    fontPreview: 'Font Preview',
    deleteFont: 'Delete',
    noCustomFont: 'No custom font added yet',
    systemFontsLoadFailed: 'Failed to load system fonts',
    systemFontsRetry: 'Retry',
    noMatchingFonts: 'No matching fonts',
    importingFonts: 'Importing fonts ({n}/{total})…',
    confirmDeleteFont: 'Are you sure you want to delete the font "{name}"? This cannot be undone.',
    importSuccess: 'Successfully imported {n} font(s)',
    importFailed: 'Failed to import {n} font(s): {detail}',
    fontAlreadyExists: 'already exists',
    processing: 'Processing…',
    scrollTop: 'TOP',
    collapseEditor: 'Collapse Editor',
    collapsePreview: 'Collapse Preview',
    restoreEditor: 'Restore Editor',
    restorePreview: 'Restore Preview',
    collapseHint: 'Switch to edit view first to use panel collapse',
    noteHint: 'Note',
    tipHint: 'Tip',
    warningHint: 'Warning',
    cautionHint: 'Caution',
    importantHint: 'Important',
    version: 'Version',
    contact: 'Contact Us',
    contactDesc: 'Feedback · Bug Reports · Tips & Discussion · Updates',
    qqGroupName: 'QQ Community',
    joinGroup: 'Join Group',
    license: 'License',
    thirdParty: 'Third-Party Components',
    copyright: 'Copyright Notice',
    aboutTitle: 'About TizuMark',
    appName: 'TizuMark',
    appVersion: '1.2.2',
    versionDesc: 'Lightweight cross-platform Markdown editor',
    buildInfo: 'Built with Tauri v2.5 + Rust',
    copyrightLine: 'Copyright (c) 2024-2026 TizuMark',
    proprietary: 'This software is released under the GPL v3 open-source license.',
    noUnauthorized: 'Free to use, modify, and distribute. Derivative works must remain under GPL v3.',
    shortcutLabel: { newFile: 'New File', openFile: 'Open File', saveFile: 'Save File', closeTab: 'Close Tab', find: 'Find & Replace', crossSearch: 'Cross-file Search', nextTab: 'Next Tab', prevTab: 'Previous Tab', bold: 'Bold', italic: 'Italic', insertLink: 'Insert Link', exportPDF: 'Export PDF', inlineCode: 'Inline Code', strikethrough: 'Strikethrough', codeBlock: 'Code Block', blockquote: 'Blockquote', toggleView: 'Toggle View', toggleSidebar: 'Toggle Sidebar', toggleTheme: 'Toggle Theme', saveAs: 'Save As', insertTable: 'Insert Table', insertImage: 'Insert Image', insertUl: 'Unordered List', insertOl: 'Ordered List', insertTask: 'Task List', insertHr: 'Horizontal Rule', highlight: 'Highlight', insertSuperscript: 'Superscript', insertSubscript: 'Subscript', insertH1: 'Heading 1', insertH2: 'Heading 2', insertH3: 'Heading 3', insertH4: 'Heading 4', insertH5: 'Heading 5', insertH6: 'Heading 6', insertMathBlock: 'Math Block', insertMermaid: 'Mermaid Diagram', insertToc: 'Table of Contents', insertCalloutNote: 'Callout Note', insertCalloutTip: 'Callout Tip', insertCalloutWarning: 'Callout Warning', insertCalloutCaution: 'Callout Caution',     insertCalloutImportant: 'Callout Important', moveLineUp: 'Move Line/Selection Up', moveLineDown: 'Move Line/Selection Down', fileSearch: 'File Search', closeToTray: 'Hide to tray' },
    shortcutGroup: { file: 'File', search: 'Find & Search', tabView: 'Tabs & View', format: 'Text Format', insert: 'Insert', heading: 'Headings', callout: 'Callouts' },
    builtinShortcutsTitle: 'Built-in Shortcuts',
    builtinShortcutsHint: 'Fixed by the app · not editable',
    configurableShortcutsTitle: 'Scheme & Custom Shortcuts',
    configurableShortcutsHint: 'Apply a preset or set your own',
    builtinNavGroup: 'Cursor & Selection',
    builtinEditGroup: 'Editing',
    shortcutBuiltinOccupied: '"{key}" is a built-in shortcut ({name}) and cannot be reassigned',
    shortcutScheme: 'Shortcut Scheme',
    schemeHint: 'Switch a preset scheme, or customize the items below',
    crossSearch: 'Cross-file Search',
    crossSearchTitle: 'Cross-file Search',
    dialogResizeHint: 'Window adjusted. Double-click the title bar to restore the default size',
    scopeOpenFiles: 'Opened Files',
    scopeDir: 'Directory',
    loopSearch: 'Wrap Around',
    loop: 'Wrap Around',
    searchRunning: 'Searching...',
    totalMatches: '{n} matches',
    noResults: 'No results',
    truncated: 'Too many results, truncated',
    csBrowse: 'Browse',
    csRun: 'Search',
    csQueryPlaceholder: 'Enter search query...',
    schemeDefault: 'Default',
    schemeVSCode: 'VSCode',
    schemeTypora: 'Typora',
    schemeSublime: 'Sublime Text',
    schemeCustom: 'Custom',
    schemeOverrideConfirm: 'This will override all current shortcuts. Switch scheme?',
    modify: 'Modify',
    clear: 'Clear',
    none: 'None',
    pressKeys: 'Press keys...',
    generatingImg: 'Generating image...',
    preparingPrint: 'Preparing to print...',
    exportedImg: 'Exported image',
    exportedHTML: 'Exported HTML',
    exportedPDF: 'PDF exported',
    exportedWord: 'DOCX exported',
    exportSuccess: 'Export successful',
    exportError: 'Export failed',
    printTip1: 'Go to "More settings" and uncheck "Headers and footers" to remove date, title and other extra info from the PDF.',
    printTip2: 'If code highlighting or background colors look wrong, go to "More settings" and check "Background graphics".',
    pdfBigFileWarn: '⚠ Generating a large PDF takes time — please be patient. Opening the PDF before it finishes will report file corruption.',
    wordTip1: 'DOCX is generated via HTML import; complex layouts may differ slightly from the preview.',
    wordTip2: 'Formulas and Mermaid diagrams will be converted to images; code blocks keep a gray background but no syntax highlighting colors.',
    wordBigFileWarn: '⚠ Generating a large DOCX takes time — please be patient.',
    preparingWordExport: 'Exporting DOCX...',
    backendDown: '⚠ Dev backend disconnected — file features unavailable. Restart with npm run dev.',
    folderWatchErrorTitle: 'Folder watcher error',
    folderWatchErrorMessage: 'The folder tree may not auto-refresh. Click "OK" to re-watch the folder, or "Cancel" to keep using.',
    folderWatchRecovered: 'Folder watcher restarted',
    editor: 'Editor',
    previewSection: 'Preview',
    column1: 'Col 1',
    column2: 'Col 2',
    column3: 'Col 3',
    content: 'Content',
    noteContent: 'Note content',
    tipContent: 'Tip content',
    warningContent: 'Warning content',
    cautionContent: 'Caution content',
    importantContent: 'Important content',
    linkText: 'Link text',
    notSaved: 'File not saved yet',
    pathCopied: 'File path copied',
    copyFailed: 'Copy failed',
    openedGuide: 'User guide opened',
    openedGuideEn: 'Opened User Guide',
    failedGuide: 'Failed to open user guide',
    failedGuideEn: 'Failed to open guide',
    giteeAction: 'Visit Repository',
    githubAction: 'Visit Repository',
    giteeTitle: 'Visit Gitee Repository',
    githubTitle: 'Visit GitHub Repository',
    qqTitle: 'Join Group',
    donateTitle: 'Donate',
    donateDesc: 'If TizuMark has helped you, please consider supporting it.',
    donateWechat: 'WeChat Pay',
    donateAlipay: 'Alipay',
    depCodeMirror: 'Code editor component',
    depHighlight: 'Syntax highlighting library',
    depCmark: 'Markdown parser (Rust)',
    depKatex: 'Math formula rendering',
    depMermaid: 'Diagram drawing library',
    depHtml2canvas: 'Screenshot export',
    depTauri: 'Desktop application framework',
    spaces: 'spaces',
    applying: 'Applying…',
    saving: 'Saving…',
    apply: 'Apply',
    appliedSuccess: 'Applied',
    savedSuccess: 'Saved',
    ok: 'OK',
    browse: 'Browse...',
    reloadFile: 'Reload File',
    toggleTheme: 'Toggle Theme',
    collapseExpandToolbar: 'Collapse/Expand Toolbar',
    closeNotice: 'Close Notice',
    insertLink: 'Insert Link',
    insertImage: 'Insert Image',
    imageSourceLocal: 'Local Image',
    imageSourceWeb: 'Web Image',
    imageAltLabel: 'Alt Text',
    closeAppTitle: 'Close App',
    minimizeToTray: 'Minimize to Tray',
    quitApp: 'Quit App',
    updateAvailableSuffix: 'available',
    updateCurrentVersionLabel: 'Current version:',
    updateNotes: 'Release Notes',
    updateLatestPrefix: 'You are on the latest version',
    updateLatestSuffix: '. No update needed.',
    updateSkip: 'Later',
    csDirPlaceholder: 'Folder path',
    largeFileNotice: '⚠ Large document ({lines} lines / {size} MB): preview shows only the area near the current position; scroll the editor to view the full content gradually.',
    dontRemind: "Don't remind",
    shortcutOccupied: 'Shortcut "{key}" is already used by "{name}"',
    progressCheckingEula: 'Checking license agreement…',
    progressInitEditor: 'Initializing editor…',
    progressRegisterEvents: 'Registering event listeners…',
    progressLoadingFile: 'Loading file…',
    progressReady: 'Ready',
    devtoolsOpened: 'DevTools opened',
    devtoolsOpenFailed: 'Failed to open DevTools: {err}',
    devtools: 'Developer Tools',
    closeAppMsg: 'Choose an action when closing the app:',
    rememberChoice: 'Remember my choice, don\'t ask again',
    errorCodePrefix: 'Error code {code}',
    shortcutsReset: 'Shortcuts reset to defaults',
    saveDialogMessage: 'File has been modified. Save?',
    imageLoadFailed: '[Image failed to load]',
    dropFileHere: 'Drop file here to open',
    allFiles: 'All Files',
    tablistLabel: 'Tabs',
    closeAria: 'Close',
    heading1: '# Heading 1',
    heading2: '## Heading 2',
    heading3: '### Heading 3',
    heading4: '#### Heading 4',
    heading5: '##### Heading 5',
    heading6: '###### Heading 6',
    previewMode: 'Preview Mode',
    editMode: 'Edit Mode',
    newTab: 'New Tab',
    scrollLeft: 'Scroll Left',
    scrollRight: 'Scroll Right',
    backToTop: 'Back to Top',
    loading: 'Loading...',
    cursorPos: 'Line {line}, Col {col}',
    insertLinkTitle: 'Insert Link',
    linkText: 'Text',
    linkUrl: 'URL',
    insertImageTitle: 'Insert Image',
    imageSource: 'Source',
    imageLocal: 'Local Image',
    imageWeb: 'Web Image',
    imageFile: 'File',
    imageBrowse: 'Browse...',
    imageUrlLabel: 'Image URL',
    imageAlt: 'Alt Text',
    imageAltHint: 'Shown when the image cannot be displayed; also used by screen readers to describe the image.',
    imageStoreModeHint: 'Supports "Copy to assets/" and "Embed as Base64". Change in Settings.',
    imageStoreMode: 'Storage',
    imageStoreAssets: 'Copy to assets/ (Recommended)',
    imageStoreBase64: 'Embed as Base64',
    imageStoreAssetsHint: 'Copy to assets/: Images saved as separate files, keeps markdown lightweight, suitable for version control.',
    imageStoreBase64Hint: 'Embed as Base64: Encodes image into the markdown file for self-contained sharing, but significantly increases file size (~1.4x original). Requires re-encoding to modify.',
    imageSettingLabel: 'Image Storage',
    imageSettingAssets: 'Copy to assets/ (Recommended)',
    imageSettingBase64: 'Embed as Base64',
    imageSettingHint: 'Copy to assets/: Images are saved as separate files, keeping the markdown file lightweight and suitable for version control. Embed as Base64: Encodes images into the markdown file for self-contained sharing, but file size increases significantly (~1.4x original). Requires re-encoding to modify.',
    imageAssetPathLabel: 'Image Asset Path',
    imageAssetPathModeRelative: 'Relative Path',
    imageAssetPathModeAbsolute: 'Absolute Path',
    imageAssetPathRelativeHint: 'Relative to the markdown file\'s directory. Example: <code>assets</code> → images saved in <code>docs/assets/</code>. Path remains valid when moving the entire folder to another location.',
    imageAssetPathAbsoluteHint: 'Full disk path. Example: D:/images → images saved directly in D:/images/. Path will break if the markdown folder is moved to another location.',
    imageAssetPathPlaceholder: 'assets',
    imageFileRequired: 'Please select a local image file',
    imageUrlRequired: 'Please enter an image URL',
    needSaveFirst: 'Save the markdown file first before inserting images',
    imageFallbackBase64: 'File not saved, auto-switched to Base64 embed',
    imagePasted: 'Image pasted',
    imagePasteFailed: 'Image paste failed',
    linkAutoDetected: '(Link detected from clipboard)',
    checkUpdate: 'Check for Updates',
    updateChecking: 'Checking for updates...',
    updateAvailable: 'Update Available',
    updateLatest: 'Up to Date',
    updateDownloadLabel: 'Download Update',
    updateDownloading: 'Downloading...',
    updateInstallNow: 'Install Now',
    updateLater: 'Later',
    updateReady: 'Update ready. Install now?',
    updateNoUpdate: 'You\'re up to date',
    updateFailed: 'Check for updates failed',
    updateConfirm: 'OK',
    updateProgress: 'Downloading {pct}%',
    noUpdateNotes: 'No release notes',
    unsafeRegex: 'Unsafe or too long regex pattern',
    filesModifiedConfirm: '{n} unsaved files. Save changes?',
    saveAll: 'Save All',
    discardAll: 'Discard All',
    fileOpened: 'Opened: {name}',
    openFolder: 'Open Folder',
    files: 'Files',
    closeFolder: 'Close Folder',
    openContainingFolder: 'Open Containing Folder',
    openFolderFailed: 'Failed to open file manager, please locate the folder manually',
    sortBy: 'Sort',
    sortByName: 'Name',
    sortByTime: 'Modified',
    sortByCreated: 'Created',
    modifiedLabel: 'Mod',
    createdLabel: 'Created',
    createdUnknown: 'Creation time unavailable',
    modifiedFullTitle: 'Modified: ',
    createdFullTitle: 'Created: ',
    sizeFullTitle: 'Size: ',
    fileSort: 'Sort by',
    sortAsc: 'Ascending',
    sortDesc: 'Descending',
    folderOpened: 'Opened folder: {path}',
    extraDirsIgnoredBatch: 'Ignored {n} extra folders (only one folder can be opened at a time)',
    fontSizeChanged: 'Font size {size}px',
    fontSizeHint: 'Editor font size {size}px',
    previewFontSizeHint: 'Preview font size {size}px',
    fontSizeReset: 'Reset to {base}px',
    switchWorkspaceTitle: 'Switch Workspace',
    switchWorkspaceMsg: 'A workspace is already open. Switch to {path}?',
    sidebar: 'Sidebar',
    // 文件树右键操作（合并自 PR #36）
    fileNewFile: 'New File',
    newFileNamePrompt: 'File name (with extension, e.g. note.md)',
    fileNewFolder: 'New Folder',
    newFolderNamePrompt: 'Folder name',
    fileCreateFailed: 'Create failed',
    nameExists: 'A file or folder with this name already exists',
    nameEmpty: 'Name cannot be empty',
    nameInvalid: 'Name contains invalid characters (/ \\ : * ? " < > |)',
    fileRename: 'Rename',
    renamePrompt: 'New name',
    fileRenameFailed: 'Rename failed',
    fileDelete: 'Delete',
    confirmDeleteFolder: 'Delete folder "{name}" and all its contents? This cannot be undone.',
    confirmDeleteFile: 'Delete file "{name}"?',
    fileDeleteFailed: 'Delete failed',
    fileCutDone: 'Cut to clipboard',
    fileCopyDone: 'Copied to clipboard',
    clipboardEmpty: 'Clipboard is empty',
    pasteIntoSelf: 'Cannot paste a folder into itself or its subdirectory',
    filePasteDone: 'Pasted',
    fileCopyPath: 'Copy Path',
  }
};

class MarkdownEditor {
  constructor() {
    this.untitledCounter = 1;
    this.tabs = [];
    this.activeTabIndex = 0;
    // 外部变更队列：在此先初始化为 []，作为异步 initFileWatcher 之前的兜底，
    // 避免初始化未完成时调用 enqueueExternalChange 触发 _externalQueue.includes 崩溃。
    this._externalQueue = [];
    this._externalBannerVisible = false;
    this.cm = null;
    this.workspaceFolder = null;
    this.expandedFolders = new Set();
    // 文件树右键菜单状态（合并自 PR #36）：_fileTreeCtx 为当前右键/点击目标 {path, isDir, nodeEl}；
    // _fileClipboard 为剪切/复制状态 {op:'cut'|'copy', path, isDir}，粘贴时据此调用 move/copy
    this._fileTreeCtx = null;
    this._fileClipboard = null;
    this.debounceTimer = null;
    this._imageURLCache = new Map(); // dataUri → Blob URL（LRU，上限 _imageURLCacheMax，超限 revoke）
    this._imageURLCacheMax = 64;
    this._imageBase64Cache = new Map(); // key: 绝对路径 → value: base64 data URI，省去每次打字跨 IPC 读磁盘
    this._hljsCache = new Map();
    this._mermaidCache = new Map(); // key: themeKey+'::'+code → 渲染后的 SVG innerHTML，避免打字时全量重渲染 mermaid
    this._renderGeneration = 0;
    this._mermaidGeneration = 0;
    this.previewWindow = null;       // 大文档窗口模式：{start, end}（0-based 源码行），普通文档为 null
    this.previewController = new PreviewController(this); // P2-1 Strangler facade（ADR-3）
    this._previewVirtual = false;    // 纯预览模式 + 大文档：虚拟滚动（spacer 撑高，可拖到任意位置）
    this._avgLineHeight = null;      // 虚拟滚动平均行高（首次渲染后校准一次，之后恒定）
    this._virtualRenderTimer = null; // 虚拟滚动重渲染 debounce 计时器
    this._previewScrollDriven = false; // 虚拟滚动：滚动驱动的重渲染保留 scrollTop（不回弹贴顶）
    this._previewSliceOffset = 0;    // 窗口切片起点（0-based），用于把 data-source-line 还原为绝对行号
    this._previewFocusLine = 0;      // 窗口焦点（0-based 源码行），决定窗口中心
    this._windowLineTops = null;     // 窗口模式下 [data-source-line] 元素相对预览内容顶部的像素偏移，用于定位
    this._linePositions = [{ line: 0, fraction: 0 }];
    this._blocks = [];
    this._previewChildrenCount = 0;
    this._editorPercent = null;
    this.isDark = false;
    this.viewMode = 'preview';
    this._sessionMdViewMode = null;  // 会话级 md 展示模式记忆：仅内存，不落盘；null=未记录（用 settings.defaultView）
    // 会话级「不再提醒」标志：仅本次应用运行期间有效，关闭应用后新会话自然复位为 false。
    // 注意：不在 switchTab / openFile 等处重置，否则会丢失用户在本次会话内的选择。
    this._largeFileNoticeSessionSuppressed = false;

    this.settings = this.loadSettings();
    this.shortcuts = this.loadShortcuts();
    this.shortcutScheme = this.loadShortcutScheme();
    this._recentFiles = [];
    this._recentSubmenuVisible = false;
    this.loadRecentFiles();
    this._recentWorkspaces = [];
    this.loadRecentWorkspaces();
    this.recordingAction = null;
    this.tabs.push(new Tab(this.t('untitled') + this.untitledCounter++));

    this.preview = document.getElementById('preview');
    if (this.preview) this.preview.style.scrollBehavior = 'auto';
    this.statusText = document.getElementById('status-text');
    this.cursorPosition = document.getElementById('cursor-position');
    this.wordCountEl = document.getElementById('word-count');
    this.charCountEl = document.getElementById('char-count');
    this.lineCountEl = document.getElementById('line-count');

    this.initEditor();
    this.applyShortcuts();
    this.initEventListeners();
    this.initResizer();
    this.initFindReplace();
    this.applyPreviewPaneWidth();
    this.initFileSearchModule();
    this.initScrollTopBtn();
    this.initExternalLinks();
    this.initDragDrop();
    this.initSettings();
    this.applyWindowBehavior();
    this.initShortcutsDialog();
    this.bindCollapseToggle();
    this.initDialogsDragResize();
    this.initCrossSearch();
    this.initOutline();
    this.initOutlineResizer();
    this.initSplitter();
    this.initPanelHeaders();
    this.initBreadcrumb();
    this.updateOutlineCheck();
    this.initContextMenu();
    this.initFormatToolbar();
    this.applySidebarState();
    this.initInsertDialogs();
    this.initImagePaste();
    this.initTabScroll();
    this.loadTheme();
    this.applySplitterRatio();
    this.updatePreview();
    this.applyViewMode();
    this.updateMaximizeIcon();
    this.updateWordCount();
    setTimeout(() => this.checkUpdate(false), 5000);
    this.updateSideButtons();
    this.initBackendHealth();
    this.applyLanguage();
  }

  showLoading() {
    this._loadingStart = Date.now();
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.remove('hidden');
    overlay.offsetHeight;
  }

  async hideLoading() {
    const elapsed = Date.now() - (this._loadingStart || 0);
    const minDuration = 200;
    if (elapsed < minDuration) {
      await new Promise(r => setTimeout(r, minDuration - elapsed));
    }
    document.getElementById('loading-overlay').classList.add('hidden');
  }

  showPaneLoading() {
    const el = document.getElementById('pane-loading');
    if (el && el.classList.contains('hidden')) {
      this._paneLoadingStart = Date.now();
      el.classList.remove('hidden');
    }
  }

  async hidePaneLoading() {
    const el = document.getElementById('pane-loading');
    if (!el) return;
    const elapsed = Date.now() - (this._paneLoadingStart || 0);
    const minDuration = 180;
    if (elapsed < minDuration) {
      await new Promise(r => setTimeout(r, minDuration - elapsed));
    }
    el.classList.add('hidden');
  }

  // 引用计数的加载层控制：多次嵌套的「开始/结束」只在实际最外层结束（count 归零）时才隐藏，
  // 从而让大文件重渲染（可能跨多次 updatePreview 调用）期间 loading 持续可见
  _beginPaneLoad() {
    this._paneLoadingCount = (this._paneLoadingCount || 0) + 1;
    this.showPaneLoading();
  }

  _endPaneLoad() {
    this._paneLoadingCount = Math.max(0, (this._paneLoadingCount || 0) - 1);
    if (this._paneLoadingCount === 0) this.hidePaneLoading();
  }

  showLargeFileNotice(key, totalLines, totalChars) {
    // 会话级「不再提醒」：本次应用运行期间一旦点过，整轮生命周期内都不再弹（不含跨会话）。
    if (this._largeFileNoticeSessionSuppressed) return;
    // 纯预览模式使用虚拟滚动，可拖到任意位置查看全文，无需提示横幅
    if (this.viewMode === 'preview') { this.hideLargeFileNotice(); return; }
    if (this._largeFileNoticeDismissed && this._largeFileNoticeKey === key) return;
    const banner = document.getElementById('large-file-banner');
    const textEl = document.getElementById('large-file-banner-text');
    if (!banner || !textEl) return;
    const sizeMB = (totalChars / 1048576).toFixed(1);
    textEl.textContent = this.t('largeFileNotice', { lines: totalLines, size: sizeMB });
    banner.classList.remove('hidden');
    this._largeFileNoticeKey = key;
  }

  hideLargeFileNotice() {
    const banner = document.getElementById('large-file-banner');
    if (banner) banner.classList.add('hidden');
    this._largeFileNoticeKey = null;
  }

  t(key, params = {}) {
    const lang = this.settings.language === 'en' ? 'en' : 'zh';
    let text = I18N[lang][key];
    if (text === undefined) {
      text = I18N.zh[key] || key;
    }
    if (text && params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace('{' + k + '}', v);
      }
    }
    return text;
  }

  applyLanguage() {
    const t = (k, p) => this.t(k, p);
    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    const setPlaceholder = (id, text) => { const el = document.getElementById(id); if (el) el.placeholder = text; };
    const setTitle = (id, text) => { const el = document.getElementById(id); if (el) el.title = text; };

    // Toolbar buttons — skip the dropdown-arrow span, target the label span
    const updateToolbarBtn = (btnId, text) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      const span = btn.querySelector('span:not(.dropdown-arrow)');
      if (span) span.textContent = text;
    };
    updateToolbarBtn('btn-file', t('file'));
    updateToolbarBtn('btn-view', t('view'));
    updateToolbarBtn('btn-help', t('help'));

    // File menu items
    // Use direct approach for menu items
    const updateMenuText = (id, text) => {
      const el = document.getElementById(id);
      if (!el) return;
      const span = el.querySelector('span:not(.shortcut):not(.icon)');
      if (span) span.textContent = text;
    };

    updateMenuText('btn-new', t('new'));
    updateMenuText('btn-open', t('open'));
    updateMenuText('btn-recent', t('recentFiles'));
    updateMenuText('btn-recent-workspaces', t('recentWorkspaces'));
    updateMenuText('btn-save', t('save'));
    updateMenuText('btn-save-as', t('saveAs'));
    updateMenuText('btn-export-html', t('exportHTML'));
    updateMenuText('btn-export-img', t('exportImg'));
    updateMenuText('btn-export-pdf', t('exportPDF'));
    updateMenuText('btn-export-word', t('exportWord'));
    updateMenuText('btn-shortcuts', t('shortcuts'));
    updateMenuText('btn-settings', t('settings'));
    updateMenuText('btn-user-guide', t('userGuide'));
    updateMenuText('btn-about', t('about'));
    updateMenuText('btn-open-folder', t('openFolder'));
    updateMenuText('btn-reload-menu', t('reloadFile'));
    updateMenuText('btn-check-update', t('checkUpdate'));
    updateMenuText('btn-devtools', t('devtools'));

    // View mode tabs
    updateMenuText('btn-view-preview', t('preview'));
    updateMenuText('btn-view-edit', t('edit'));

    // Theme button
    setText('theme-text', this.isDark ? t('themeDark') : t('themeLight'));

    // Window controls
    setTitle('btn-minimize', t('minimize'));
    setTitle('btn-maximize', t('maximize'));
    setTitle('btn-close', t('close'));

    // Status bar
    setText('status-text', t('ready'));
    document.getElementById('word-count').textContent = t('words') + ': 0';
    document.getElementById('char-count').textContent = t('chars') + ': 0';
    document.getElementById('line-count').textContent = t('lines') + ': 0';
    if (this.cm) {
      const cur = this.cm.getCursor();
      document.getElementById('cursor-position').textContent = this.t('cursorPos', { line: cur.line + 1, col: cur.ch + 1 });
    }

    // Drag overlay
    setText('drag-overlay', t('dropFileHere'));

    // ARIA labels
    const tabBar = document.getElementById('tab-bar');
    if (tabBar) tabBar.setAttribute('aria-label', t('tablistLabel'));
    document.querySelectorAll('.dialog-close').forEach(btn => {
      btn.setAttribute('aria-label', t('closeAria'));
    });

    // Settings dialog — use form element IDs as stable anchors
    document.querySelector('#settings-dialog .dialog-header h2').textContent = t('settings');
    const setSectionTitle = (anchorId, text) => {
      const el = document.getElementById(anchorId);
      if (el) { const name = el.closest('.settings-section').querySelector('.settings-section-name'); if (name) name.textContent = text; }
    };
    const setRowLabel = (formId, text) => {
      const el = document.getElementById(formId);
      if (el) { const label = el.closest('.settings-row').querySelector(':scope > label:not(.toggle)'); if (label) label.textContent = text; }
    };
    setSectionTitle('set-language', t('basic'));
    setRowLabel('set-language', t('language'));
    setRowLabel('set-theme-mode', t('themeMode'));
    setRowLabel('set-color-scheme', t('colorScheme'));
    setSectionTitle('set-font-size', t('editor'));
    setRowLabel('set-font-size', t('fontSize'));
    setRowLabel('set-tab-size', t('tabSize'));
    setRowLabel('set-line-wrap', t('lineWrap'));
    setRowLabel('set-line-numbers', t('lineNumbers'));
    setSectionTitle('set-preview-font-size', t('previewSection'));
    setRowLabel('set-preview-font-size', t('previewFontSize'));
    setRowLabel('set-line-height', t('lineHeight'));
    setRowLabel('set-max-width', t('maxWidth'));
    setSectionTitle('set-default-view', t('behavior'));
    setRowLabel('set-default-view', t('defaultView'));
    setRowLabel('set-scroll-sync', t('scrollSync'));
    setRowLabel('set-soft-breaks', t('softBreaks'));
    setRowLabel('set-extended-syntax', t('extendedSyntax'));
    setRowLabel('set-code-line-numbers', t('codeLineNumbers'));
    setRowLabel('set-code-wrap', t('codeBlockWrap'));
    setRowLabel('set-code-scroll', t('codeScroll'));
    setRowLabel('set-custom-bg', t('customBg'));
    setRowLabel('set-close-action', t('closeAction'));
    setRowLabel('set-show-tray-icon', t('showTrayIcon'));
    setRowLabel('set-show-all-files-label', t('showAllFiles'));
    setRowLabel('set-image-store-mode-label', t('imageSettingLabel'));
    setRowLabel('set-image-asset-path-mode-label', t('imageAssetPathLabel'));
    setSectionTitle('btn-add-font', t('customFonts'));
    setSectionTitle('btn-manage-slash', t('quickInsert'));
    setText('btn-manage-slash', t('manageQuickInsert'));
    const qiSection = document.getElementById('btn-manage-slash');
    if (qiSection) { const qiHint = qiSection.closest('.settings-section').querySelector('.form-hint .hint-text'); if (qiHint) qiHint.textContent = t('quickInsertHint'); }
    setText('slash-order-title', t('quickInsertOrder'));
    const soHint = document.querySelector('#slash-order-dialog .form-hint .hint-text');
    if (soHint) soHint.textContent = t('quickInsertOrderHint');
    setText('slash-order-reset', t('resetDefault'));
    setText('slash-order-done', t('quickInsertOrderDone'));
    setRowLabel('set-editor-font', t('editorFont'));
    setRowLabel('set-preview-font', t('previewFont'));
    setRowLabel('set-code-font', t('codeFont'));
    const softBreaksHint = document.querySelector('#setting-soft-breaks-hint .hint-text');
    if (softBreaksHint) softBreaksHint.textContent = t('softBreaksHint');
    const extendedSyntaxHint = document.querySelector('#setting-extended-syntax-hint .hint-text');
    if (extendedSyntaxHint) extendedSyntaxHint.textContent = t('extendedSyntaxHint');
    const tabSizeHint = document.querySelector('#setting-tab-size-hint .hint-text');
    if (tabSizeHint) tabSizeHint.textContent = t('tabSizeHint');
    const codeScrollHint = document.querySelector('#setting-code-scroll-hint .hint-text');
    if (codeScrollHint) codeScrollHint.textContent = t('codeScrollHint');
    const trayHint = document.querySelector('#setting-show-tray-icon-hint .hint-text');
    if (trayHint) trayHint.textContent = t('showTrayIconHint');
    const allFilesHint = document.querySelector('#setting-show-all-files-hint .hint-text');
    if (allFilesHint) allFilesHint.textContent = t('showAllFilesHint');
    document.querySelector('#setting-image-store-hint .hint-text').textContent = t('imageSettingHint');
    const assetPathHint = document.querySelector('#setting-image-asset-path-hint-text');
    if (assetPathHint) assetPathHint.innerHTML = t('imageAssetPathRelativeHint');
    document.getElementById('settings-reset').textContent = t('resetDefault');
    // 语言/界面文本刷新时跳过处于 loading 态的按钮：否则 applyPendingSettings 内部的
    // applyLanguage() 会在保存/应用进行中把按钮文案重置回「保存/应用」，让 spinner +
    // 「保存中…」只显示不到一帧（本地同步落盘极快），视觉上等于没有 loading。
    const applyBtn = document.getElementById('settings-apply-btn');
    if (applyBtn && !applyBtn.classList.contains('is-loading')) applyBtn.textContent = t('apply');
    const saveBtn = document.getElementById('settings-save-btn');
    if (saveBtn && !saveBtn.classList.contains('is-loading')) saveBtn.textContent = t('save');
    document.getElementById('settings-close-x').setAttribute('aria-label', t('cancel'));
    document.getElementById('confirm-dialog-confirm').textContent = t('confirm');
    document.getElementById('confirm-dialog-cancel').textContent = t('cancel');
    // 配色方案自绘下拉：随语言刷新选项文案（optionsProvider 依赖注入 t）
    if (this._selects && this._selects.colorScheme) this._selects.colorScheme.applyI18n(t);
    // 三个字体 FontPicker 的 i18n（占位符/默认项/无匹配文案）；须 bind(this) 否则 t 的 this 指向 FontPicker
    for (const k of ['editor', 'preview', 'code']) {
      const p = this._fontPickers && this._fontPickers[k];
      if (p) p.applyI18n(this.t.bind(this));
    }
    // 语言切换后刷新系统字体显示名（中文 UI 显示「微软雅黑」，英文 UI 显示 Microsoft YaHei）
    this.refreshFontSelectors();
    // 系统字体加载失败重试按钮文案
    const retryBtn = document.getElementById('btn-retry-system-fonts');
    if (retryBtn) retryBtn.textContent = t('systemFontsRetry');
    this.populateSchemeSelect();

    // 跨文件搜索弹框文案
    const csText = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
    csText('cs-title', 'crossSearchTitle');
    csText('cs-label-open', 'scopeOpenFiles');
    csText('cs-label-dir', 'scopeDir');
    csText('cs-label-case', 'caseSensitive');
    csText('cs-label-regex', 'regex');
    csText('cs-label-loop', 'loopSearch');
    csText('cs-browse', 'csBrowse');
    csText('cs-run', 'csRun');
    const csQuery = document.getElementById('cs-query');
    if (csQuery) csQuery.placeholder = t('csQueryPlaceholder');

    // Update tab bar
    this.updateTabBar();
    this.updateWordCount();
    this.updateOutline();

    // Toolbar / panel title attributes（2026-08-04 i18n 补漏）
    setTitle('btn-reload', t('reloadFile'));
    setTitle('btn-theme', t('toggleTheme'));
    setTitle('fmt-collapse', t('collapseExpandToolbar'));
    setTitle('outline-close', t('close'));
    setTitle('folder-close', t('closeFolder'));
    // 文件目录排序下拉文案随语言刷新由 _folderSortSelect.applyI18n 统一处理（见下方 SETTINGS DROPDOWN OPTIONS）
    this.updateFolderSortOrderButton();
    this.updateFolderMenuLabel();
    setTitle('large-file-banner-close', t('closeNotice'));
    setTitle('large-file-banner-dont-remind', t('dontRemind'));
    // fmt-icon-btn 系列（加粗/斜体/删除线/链接/图片/水平线/高亮/上标/下标）
    const fmtActionTitleKeys = {
      'insert-bold': 'bold',
      'insert-italic': 'italic',
      'insert-strikethrough': 'strikethrough',
      'insert-link': 'link',
      'insert-image': 'image',
      'insert-hr': 'hr',
      'insert-highlight': 'highlight',
      'insert-superscript': 'superscript',
      'insert-subscript': 'subscript',
    };
    document.querySelectorAll('#format-toolbar .fmt-icon-btn[data-action]').forEach(el => {
      const key = fmtActionTitleKeys[el.dataset.action];
      if (key) el.title = t(key);
    });

    // Insert-link dialog
    setText('insert-link-title', t('insertLink'));
    setText('insert-link-text-label', t('linkText'));
    setText('insert-link-url-label', t('linkUrl'));
    setText('insert-link-cancel', t('cancel'));
    setText('insert-link-ok', t('ok'));

    // Insert-image dialog
    setText('insert-image-title', t('insertImage'));
    setText('insert-image-source-label', t('imageSource'));
    if (this._imageSourceSelect) this._imageSourceSelect.applyI18n(t);
    setText('insert-image-file-label', t('file'));
    setText('insert-image-browse', t('browse'));
    setText('insert-image-url-label', t('imageUrlLabel'));
    setText('insert-image-alt-label', t('imageAltLabel'));
    setText('insert-image-cancel', t('cancel'));
    setText('insert-image-ok', t('ok'));
    // 自定义字体导入按钮（省略号后缀）
    setText('btn-add-font', t('addFont') + '…');

    // Close-confirm dialog
    setText('close-dialog-title', t('closeAppTitle'));
    setText('close-dialog-msg', t('closeAppMsg'));
    setText('close-dialog-remember-label-text', t('rememberChoice'));
    setText('close-dialog-minimize', t('minimizeToTray'));
    setText('close-dialog-quit', t('quitApp'));

    // Update dialog 静态文本（标题随状态由 showUpdateState 动态设置）
    setText('update-state-checking-text', t('updateChecking'));
    setText('update-available-suffix', t('updateAvailableSuffix'));
    setText('update-current-version-label', t('updateCurrentVersionLabel'));
    setText('update-notes-title', t('updateNotes'));
    setText('update-latest-title', t('updateLatest'));
    setText('update-latest-prefix', t('updateLatestPrefix'));
    setText('update-latest-suffix', t('updateLatestSuffix'));
    setText('update-skip', t('updateSkip'));
    setText('update-action', t('updateChecking'));

    // 跨文件搜索：目录路径 placeholder 补漏
    setPlaceholder('cs-dir', t('csDirPlaceholder'));

    // Side buttons
    this.applyViewMode();

    // About dialog（4 个折叠块：版本信息/联系我们/许可协议/第三方组件）
    document.querySelector('#about-dialog .dialog-header h2').textContent = t('aboutTitle');
    const aboutSections = document.querySelectorAll('#about-dialog .dependency-details');
    if (aboutSections.length >= 1) {
      const title = aboutSections[0].querySelector('.dependency-title .dependency-name');
      if (title) title.textContent = t('version');
      const sec = aboutSections[0];
      const appNameEl = sec.querySelector('.about-app-name');
      if (appNameEl) appNameEl.textContent = t('appName');
      const verEl = sec.querySelector('#about-version');
      if (verEl) verEl.textContent = 'v' + t('appVersion');
      const descEl = sec.querySelector('#about-version-desc');
      if (descEl) descEl.textContent = t('versionDesc');
      const buildEl = sec.querySelector('#about-build');
      if (buildEl) buildEl.textContent = t('buildInfo');
    }
    if (aboutSections.length >= 2) {
      const title = aboutSections[1].querySelector('.dependency-title .dependency-name');
      if (title) title.textContent = t('contact');
      const contactDesc = aboutSections[1].querySelector('.contact-desc');
      const qqLabel = aboutSections[1].querySelector('.qq-label');
      const qqJoinText = aboutSections[1].querySelector('.qq-join-text');
      const qqBadge = document.getElementById('qq-group-badge');
      if (contactDesc) contactDesc.textContent = t('contactDesc');
      if (qqLabel) qqLabel.textContent = t('qqGroupName');
      if (qqJoinText) qqJoinText.textContent = t('joinGroup');
      if (qqBadge) qqBadge.title = t('qqTitle');
      const giteeAction = aboutSections[1].querySelector('.gitee-action');
      const giteeBadge = document.getElementById('gitee-badge');
      if (giteeAction) giteeAction.textContent = t('giteeAction');
      if (giteeBadge) giteeBadge.title = t('giteeTitle');
      const githubAction = aboutSections[1].querySelector('.github-action');
      const githubBadge = document.getElementById('github-badge');
      if (githubAction) githubAction.textContent = t('githubAction');
      if (githubBadge) githubBadge.title = t('githubTitle');
    }
    if (aboutSections.length >= 3) {
      const title = aboutSections[2].querySelector('.dependency-title .dependency-name');
      if (title) title.textContent = t('license');
      const lps = aboutSections[2].querySelectorAll('.dependency-body p');
      if (lps[0]) lps[0].textContent = t('copyrightLine');
      if (lps[1]) lps[1].textContent = t('proprietary');
      if (lps[2]) lps[2].textContent = t('noUnauthorized');
    }
    if (aboutSections.length >= 4) {
      const title = aboutSections[3].querySelector('.dependency-title .dependency-name');
      if (title) title.textContent = t('thirdParty');
      const depDescs = aboutSections[3].querySelectorAll('.dependency-item p');
      const depKeys = ['depCodeMirror', 'depHighlight', 'depCmark', 'depKatex', 'depMermaid', 'depHtml2canvas', 'depTauri'];
      depDescs.forEach((p, i) => {
        if (i < depKeys.length) p.textContent = t(depKeys[i]);
      });
    }

    // Save dialog
    document.getElementById('save-dialog-title').textContent = t('saveChanges');
    document.getElementById('save-dialog-save').textContent = t('save');
    document.getElementById('save-dialog-discard').textContent = t('dontSave');
    document.getElementById('save-dialog-cancel').textContent = t('cancel');

    // Find panels
    setPlaceholder('find-input', t('find') + '...');
    setPlaceholder('replace-input', t('replace') + '...');
    document.querySelector('#find-panel .find-option:nth-child(2)') && (document.querySelector('#find-panel .find-option:nth-child(2)').childNodes[1] && (document.querySelector('#find-panel .find-option:nth-child(2)').childNodes[1].textContent = ' ' + t('caseSensitive')));
    document.querySelector('#find-panel .find-option:nth-child(3)') && (document.querySelector('#find-panel .find-option:nth-child(3)').childNodes[1] && (document.querySelector('#find-panel .find-option:nth-child(3)').childNodes[1].textContent = ' ' + t('regex')));
    document.querySelector('#find-panel .find-option:nth-child(4)') && (document.querySelector('#find-panel .find-option:nth-child(4)').childNodes[1] && (document.querySelector('#find-panel .find-option:nth-child(4)').childNodes[1].textContent = ' ' + t('loop')));
    document.getElementById('find-next').textContent = t('findNext');
    document.getElementById('find-prev').textContent = t('findPrev');
    document.getElementById('replace-one').textContent = t('replace');
    document.getElementById('replace-all').textContent = t('replaceAll');
    setPlaceholder('preview-find-input', t('findInPreview') + '...');
    document.querySelector('#preview-find-panel .find-option:nth-child(2)') && (document.querySelector('#preview-find-panel .find-option:nth-child(2)').childNodes[1] && (document.querySelector('#preview-find-panel .find-option:nth-child(2)').childNodes[1].textContent = ' ' + t('caseSensitive')));
    document.querySelector('#preview-find-panel .find-option:nth-child(3)') && (document.querySelector('#preview-find-panel .find-option:nth-child(3)').childNodes[1] && (document.querySelector('#preview-find-panel .find-option:nth-child(3)').childNodes[1].textContent = ' ' + t('regex')));
    document.querySelector('#preview-find-panel .find-option:nth-child(4)') && (document.querySelector('#preview-find-panel .find-option:nth-child(4)').childNodes[1] && (document.querySelector('#preview-find-panel .find-option:nth-child(4)').childNodes[1].textContent = ' ' + t('loop')));
    document.getElementById('preview-find-next').textContent = t('findNext');
    document.getElementById('preview-find-prev').textContent = t('findPrev');

    // Save dialog message
    setText('save-dialog-message', t('saveDialogMessage'));

    // Confirm dialog title & message
    setText('confirm-dialog-title', t('confirm'));
    setText('confirm-dialog-message', t('confirmMessage'));

    // Shortcuts dialog
    setText('shortcuts-title', t('shortcuts'));
    document.getElementById('shortcuts-reset').textContent = t('resetDefault');
    // 快捷键框「保存」按钮文案：与设置框「保存」一致；loading 中跳过（保 spinner）
    const scSaveBtn = document.getElementById('shortcuts-save-btn');
    if (scSaveBtn && !scSaveBtn.classList.contains('is-loading')) scSaveBtn.textContent = t('save');

    // Loading overlay
    setText('loading-text', t('loading'));

    // Scroll-top button
    setText('scroll-top-label', t('scrollTop'));
    setTitle('scroll-top-btn', t('backToTop'));

    // Tab bar tooltips
    setTitle('btn-add-tab', t('newTab'));
    setTitle('tab-scroll-left', t('scrollLeft'));
    setTitle('tab-scroll-right', t('scrollRight'));

    // Toolbar button titles
    setTitle('btn-file', t('file'));
    setTitle('btn-view', t('view'));
    setTitle('btn-help', t('help'));
    setTitle('btn-view-preview', t('previewMode'));
    setTitle('btn-view-edit', t('editMode'));

    // View menu sidebar toggle
    const sidebarToggle = document.getElementById('btn-sidebar-toggle');
    if (sidebarToggle) {
      const labelSpan = sidebarToggle.querySelector('span:last-of-type');
      if (labelSpan) labelSpan.textContent = t('sidebar');
    }

    // Items with data-action (format toolbar + context menus)
    const insActionKeys = {
      'insert-code-block': 'codeBlock',
      'insert-table': 'table',
      'insert-quote': 'quoteBlock',
      'insert-math-block': 'mathBlock',
      'insert-mermaid': 'mermaidChart',
      'insert-hr': 'hr',
      'insert-toc': 'toc',
      'insert-h1': 'heading1',
      'insert-h2': 'heading2',
      'insert-h3': 'heading3',
      'insert-h4': 'heading4',
      'insert-h5': 'heading5',
      'insert-h6': 'heading6',
      'insert-bold': 'bold',
      'insert-italic': 'italic',
      'insert-strikethrough': 'strikethrough',
      'insert-inline-code': 'inlineCode',
      'insert-highlight': 'highlight',
      'insert-superscript': 'superscript',
      'insert-subscript': 'subscript',
      'insert-ul': 'ul',
      'insert-ol': 'ol',
      'insert-task': 'taskList',
      'insert-link': 'link',
      'insert-image': 'image',
      'insert-callout-note': 'noteHint',
      'insert-callout-tip': 'tipHint',
      'insert-callout-warning': 'warningHint',
      'insert-callout-caution': 'cautionHint',
      'insert-callout-important': 'importantHint',
    };
    document.querySelectorAll(
      '#format-toolbar .dropdown-item[data-action],' +
      // Also cover context menu submenus
      '#ctx-structure .context-menu-item[data-action],' +
      '#ctx-heading .context-menu-item[data-action],' +
      '#ctx-callout .context-menu-item[data-action],' +
      '#ctx-text-format .context-menu-item[data-action],' +
      '#ctx-list .context-menu-item[data-action],' +
      '#ctx-link-media .context-menu-item[data-action]'
    ).forEach(el => {
      const key = insActionKeys[el.dataset.action];
      if (key) {
        const span = el.querySelector('span:first-of-type');
        if (span) span.textContent = t(key);
      }
    });

    // ====== data-i18n (category labels without actions, e.g. toolbar dropdowns) ======
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      if (key) {
        const lbl = el.querySelector('.lbl');
        if (lbl) lbl.textContent = t(key);
      }
    });

    // 折叠切换按钮文案随展开/收起状态变化
    const fmtLabel = document.querySelector('#fmt-collapse .fmt-toggle-label');
    if (fmtLabel) {
      fmtLabel.textContent = this.settings.toolbarCollapsed ? t('expandToolbar') : t('collapseToolbar');
    }

    // ====== CONTEXT MENUS ======
    // Submenu triggers
    const ctxSubKeys = {
      'ctx-structure': 'structure',
      'ctx-text-format': 'textFormat',
      'ctx-list': 'list',
      'ctx-link-media': 'linkMedia',
      'ctx-heading': 'heading',
      'ctx-callout': 'callout',
    };
    document.querySelectorAll('.context-submenu-trigger').forEach(el => {
      const key = ctxSubKeys[el.dataset.submenu];
      if (key) {
        const span = el.querySelector('span:first-of-type');
        if (span) span.textContent = t(key);
      }
    });

    // Items with data-action
    const ctxActionKeys = {
      cut: 'cut',
      copy: 'copy',
      paste: 'paste',
      'find-replace': 'findReplace',
      'select-all': 'selectAll',
      'preview-copy': 'copy',
      'preview-select-all': 'selectAll',
      'preview-copy-html': 'copyAsHTML',
      'preview-find': 'findInPreview',
      'tab-close': 'closeTab',
      'tab-close-others': 'closeOther',
      'tab-close-all': 'closeAll',
      'tab-copy-path': 'copyFilePath',
      'tab-open-containing': 'openContainingFolder',
      // 注意：'folder-open-containing' 文案由 updateFolderMenuLabel() 按 _folderCtxIsDir 动态切换
      // （文件夹→openFolder / 文件→openContainingFolder），不走这里的静态映射。
      'folder-copy-path': 'copyFilePath',
    };
    document.querySelectorAll('.context-menu-item[data-action]').forEach(el => {
      const key = ctxActionKeys[el.dataset.action];
      if (key) {
        const span = el.querySelector('span:first-of-type');
        if (span) span.textContent = t(key);
      }
    });

    // ====== SETTINGS DROPDOWN OPTIONS ======
    // 自绘下拉：随语言刷新选项文案（替代原生 select，展开面板可主题化 + 完整 ARIA）
    if (this._selects && this._selects.themeMode) this._selects.themeMode.applyI18n(t);
    if (this._selects && this._selects.colorScheme) this._selects.colorScheme.applyI18n(t);
    if (this._selects && this._selects.language) this._selects.language.applyI18n(t);
    if (this._selects && this._selects.tabSize) this._selects.tabSize.applyI18n(t);
    if (this._selects && this._selects.lineHeight) this._selects.lineHeight.applyI18n(t);
    if (this._selects && this._selects.maxWidth) this._selects.maxWidth.applyI18n(t);
    if (this._selects && this._selects.defaultView) this._selects.defaultView.applyI18n(t);
    if (this._selects && this._selects.closeAction) this._selects.closeAction.applyI18n(t);
    if (this._selects && this._selects.imageInsertMode) this._selects.imageInsertMode.applyI18n(t);
    if (this._selects && this._selects.imageAssetPathMode) this._selects.imageAssetPathMode.applyI18n(t);
    // 快捷键/插入图片/文件夹排序下拉（各自独立实例）随语言刷新
    if (this._schemeSelect) this._schemeSelect.applyI18n(t);
    if (this._imageSourceSelect) this._imageSourceSelect.applyI18n(t);
    if (this._folderSortSelect) this._folderSortSelect.applyI18n(t);
    if (this._outlineFilterSelect) this._outlineFilterSelect.applyI18n(t);
    // 自定义字体区（空状态 + 编辑/预览字体下拉的「跟随方案」）随语言刷新
    this.renderCustomFontSettings();
  }

  defaultSettings() {
    return {
      fontSize: 14,
      tabSize: 4,
      lineWrap: true,
      lineNumbers: true,
      previewFontSize: 16,
      lineHeight: 1.7,
      maxWidth: 0,
      themeMode: 'light',
      colorScheme: 'default',
      defaultView: 'preview',
      scrollSync: true,
      language: 'zh',
      imageInsertMode: 'assets',
      imageAssetPath: 'assets',
      imageAssetPathMode: 'relative',
      outlineWidth: 240,
      codeLineNumbers: false,
      codeWrap: false,
      codeScroll: true,
      softBreaks: true,
      extendedSyntax: true,
      showTrayIcon: true,
      closeAction: 'ask',
      showAllFiles: false, // 文件树过滤：默认只列受支持格式（markdown/image/text），true 时显示目录内全部文件
      toolbarCollapsed: false,
      sidebarHidden: false,
      // 文件面板高度占比（0~1），分屏改造后用于还原上下比例
      filesPanelRatio: 0.5,
      // 大纲层级过滤：0=全部，1~6=仅显示到该层级
      outlineFilterLevel: 0,
      // 面板整体折叠：文件/大纲任一收起时，对侧占满剩余高度
      filesCollapsed: false,
      outlineCollapsed: false,
      customFonts: [],
      editorFont: '',
      previewFont: '',
      fileSortKey: 'name',
      fileSortOrder: 'asc',
      // 预览区分屏宽度（合并自 PR #36）：拖拽 resizer 后持久化，下次启动按此还原。
      previewPaneWidth: 360,
      codeFont: '', // 预览代码块（行内代码 + 围栏代码块）字体，存自定义字体 id，空=跟随等宽默认
      customBgEnabled: false, // 自定义页面底色开关：开启时编辑+预览区用 customBgColor，文字按亮度反色
      customBgColor: '#f8f7f4', // 自定义底色（16 进制 RGB）
    };
  }

  loadSettings() {
    const defaults = this.defaultSettings();
    try {
      const saved = this._validConfigObject(JSON.parse(localStorage.getItem('tizumark-settings')));
      // 注：旧版本 localStorage 若残留 fontScheme 字段，defaults 已无此键，
      // 下方类型校验会把残留字段重置为 undefined 并在落盘时自动剔除（自愈）。
      // 类型校验：丢弃与默认值类型不符的字段，避免字符串/布尔错位污染 UI 与回写
      const merged = { ...defaults, ...saved };
      for (const k of Object.keys(merged)) {
        if (typeof merged[k] !== typeof defaults[k]) {
          merged[k] = defaults[k];
        }
      }
      return merged;
    } catch {
      return defaults;
    }
  }

  // 读取文件并归一化换行符为 \n：处理 CRLF 与单独 CR（混合/老 Mac 换行），避免保存时把单 CR 当作换行制造多余空行
  async readFileNormalized(path) {
    let raw;
    try {
      raw = await TauriApi.readFile({ path });
    } catch (e) {
      // Rust 返回结构化错误 JSON，映射为带错误码（E_NOT_FOUND/E_PERMISSION/...）的 Error 抛出
      throw this._mapReadFileError(e, path);
    }
    if (raw == null) {
      const err = new Error('读取返回空，可能是编码无法识别');
      err.code = 'E_EMPTY';
      err.path = path;
      throw err;
    }
    return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  // 校验从 localStorage 读取的配置为纯对象，避免畸形 JSON（数组/字符串/null）污染设置并原样回写
  _validConfigObject(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw;
  }

  saveSettings() {
    try { localStorage.setItem('tizumark-settings', JSON.stringify(this.settings)); } catch {}
  }

  // 只把 customFonts 字段写回 localStorage（不落盘面板内其他未应用设置）。
  // 需求（2026-08-06）：添加字体后字体列表立即保存，但编辑器/预览字体选择
  // 与是否应用仍由「应用/保存」决定。
  _persistCustomFontsOnly() {
    try {
      const raw = localStorage.getItem('tizumark-settings');
      const stored = raw ? this._validConfigObject(JSON.parse(raw)) : {};
      if (!stored) return;
      stored.customFonts = this.settings.customFonts;
      localStorage.setItem('tizumark-settings', JSON.stringify(stored));
    } catch {}
  }

  // 把 this.settings 同步到设置面板各控件（initSettings 与「取消/X 恢复」共用）
  syncSettingsControls() {
    const s = this.settings;
    document.getElementById('set-font-size').value = s.fontSize;
    document.getElementById('font-size-label').textContent = s.fontSize + 'px';
    if (this._selects && this._selects.tabSize) this._selects.tabSize.setValue(String(s.tabSize), true);
    document.getElementById('set-line-wrap').checked = s.lineWrap;
    document.getElementById('set-line-numbers').checked = s.lineNumbers;
    document.getElementById('set-preview-font-size').value = s.previewFontSize;
    document.getElementById('preview-font-size-label').textContent = s.previewFontSize + 'px';
    if (this._selects && this._selects.lineHeight) this._selects.lineHeight.setValue(String(s.lineHeight), true);
    if (this._selects && this._selects.maxWidth) this._selects.maxWidth.setValue(String(s.maxWidth), true);
    if (this._selects && this._selects.themeMode) this._selects.themeMode.setValue(s.themeMode, true);
    if (this._selects && this._selects.colorScheme) this._selects.colorScheme.setValue(s.colorScheme || 'default', true);
    // 三个字体 FontPicker 值同步（silent，不触发 onChange 递归）
    for (const k of ['editor', 'preview', 'code']) {
      const p = this._fontPickers && this._fontPickers[k];
      if (p) p.setValue(s[k + 'Font'] || '', true);
    }
    if (this._selects && this._selects.defaultView) this._selects.defaultView.setValue(s.defaultView || 'preview', true);
    document.getElementById('set-scroll-sync').checked = s.scrollSync;
    document.getElementById('set-code-line-numbers').checked = s.codeLineNumbers;
    document.getElementById('set-code-wrap').checked = s.codeWrap;
    document.getElementById('set-code-scroll').checked = s.codeScroll;
    if (this._selects && this._selects.language) this._selects.language.setValue(s.language || 'zh', true);
    document.getElementById('set-soft-breaks').checked = s.softBreaks !== false;
    document.getElementById('set-extended-syntax').checked = s.extendedSyntax !== false;
    document.getElementById('set-show-tray-icon').checked = s.showTrayIcon !== false;
    document.getElementById('set-show-all-files').checked = s.showAllFiles === true;
    if (this._selects && this._selects.closeAction) this._selects.closeAction.setValue(s.closeAction || 'ask', true);
    if (this._selects && this._selects.imageInsertMode) this._selects.imageInsertMode.setValue(s.imageInsertMode || 'assets', true);
    if (this._selects && this._selects.imageAssetPathMode) this._selects.imageAssetPathMode.setValue(s.imageAssetPathMode || 'relative', true);
    document.getElementById('settings-image-asset-path').value = s.imageAssetPath || 'assets';
    document.getElementById('set-custom-bg').checked = s.customBgEnabled === true;
    const cbg = document.getElementById('set-custom-bg-color');
    if (cbg) cbg.value = s.customBgColor || '#f8f7f4';
  }

  // 最小可见时长：设置保存/应用是本地即时操作（同步落盘），loading 往往一闪而过，
  // 用户几乎看不到 spinner。这里保证 loading 至少展示 ms 毫秒，提供明确的点击反馈。
  // 用 setTimeout 实现（与操作 Promise 以 Promise.all 取较长者），事件循环并行、不累加时长。
  _minDelay(ms) {
    return new Promise((res) => {
      if (typeof setTimeout === 'function') setTimeout(res, ms);
      else res();
    });
  }

  // 确保浏览器先完成一次 paint，再执行后续重活。
  // 关键：设置 spinner 的 innerHTML 后若「紧接 await 一个内部含同步重渲染的 async 函数」，
  // 该同步重活会作为微任务在 paint 之前执行，把首帧 paint 推迟到重活之后，导致 loading
  // 只闪一帧（用户看不到）。rAF 回调后接 setTimeout(0)（宏任务，保证在 paint 之后）是
  // 最稳的「等一帧 paint」写法：第一帧 paint 出 spinner，第二帧才开始重活（卡顿时可见）。
  _ensurePainted() {
    return new Promise((res) => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => setTimeout(res, 0));
      } else {
        // jsdom 等没有 requestAnimationFrame 的环境：直接等约一帧（16ms）再继续，
        // 保证 resolve 不依赖浏览器 paint 调度，避免 handler 永远挂起。
        setTimeout(res, 16);
      }
    });
  }

  async initSettings() {
    document.getElementById('btn-settings').addEventListener('click', () => this.showSettings());
    document.getElementById('settings-close-x').addEventListener('click', () => this.hideSettings(true));
    const applyBtn = document.getElementById('settings-apply-btn');
    applyBtn.addEventListener('click', async () => {
      // 点「应用」= 生效 + 落盘，面板保持打开：按钮进入 loading 态（文字「正在应用」+ spinner）
      // 顶部不再显示 loading toast，loading 结束后才弹「应用成功」成功提示。
      applyBtn.classList.add('is-loading');
      applyBtn.disabled = true;
      applyBtn.innerHTML = '<span class="btn-spinner"></span>' + this.t('applying');
      await this._ensurePainted(); // 让 spinner 先绘制一帧，避免被同步重活推后导致看不到
      try {
        await Promise.all([
          this.applyPendingSettings(),
          this._minDelay(300), // 保证 loading 至少可见 300ms，避免一闪而过
        ]);
        this.showToast(this.t('appliedSuccess'), 'success'); // 应用完成后弹成功提示
      } finally {
        applyBtn.disabled = false;
        applyBtn.classList.remove('is-loading');
        applyBtn.textContent = this.t('apply');
      }
    });
    const saveBtn = document.getElementById('settings-save-btn');
    saveBtn.addEventListener('click', async () => {
      // 点「保存」= 应用 + 落盘 + 关闭：按钮进入 loading 态（文字「正在保存」+ spinner）
      // 顶部不再显示 loading toast，loading 结束后才弹「保存成功」成功提示。
      saveBtn.classList.add('is-loading');
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="btn-spinner"></span>' + this.t('saving');
      await this._ensurePainted(); // 让 spinner 先绘制一帧，避免被同步重活推后导致看不到
      try {
        await Promise.all([
          this.applyPendingSettings(),
          this._minDelay(300), // 保证 loading 至少可见 300ms，避免一闪而过
        ]);
        this.showToast(this.t('savedSuccess'), 'success'); // 保存完成后弹成功提示
        this.hideSettings(false);
      } finally {
        saveBtn.disabled = false;
        saveBtn.classList.remove('is-loading');
        saveBtn.textContent = this.t('save');
      }
    });
    // 注：设置框不支持点击遮罩层关闭，也去掉了「取消」按钮；只能通过「×」放弃改动关闭，
    // 或点「应用」/「保存」生效。× 与旧的「取消」行为一致（按打开时快照回滚）。
    document.getElementById('settings-reset').addEventListener('click', () => this.resetSettings());

    // slash 命令排序对话框：设置入口按钮 + 对话框内按钮
    const manageSlashBtn = document.getElementById('btn-manage-slash');
    if (manageSlashBtn) manageSlashBtn.addEventListener('click', () => this.showSlashOrderDialog());
    const slashOrderDone = document.getElementById('slash-order-done');
    if (slashOrderDone) slashOrderDone.addEventListener('click', () => this.applySlashOrder());
    const slashOrderReset = document.getElementById('slash-order-reset');
    if (slashOrderReset) slashOrderReset.addEventListener('click', () => this.resetSlashOrder());
    const slashOrderClose = document.getElementById('slash-order-close-x');
    if (slashOrderClose) slashOrderClose.addEventListener('click', () => this.hideSlashOrderDialog());

    this.syncSettingsControls();

    document.getElementById('set-font-size').addEventListener('input', (e) => {
      // 应用式：拖动只更新数值显示，实际字号在点「应用/保存」后生效
      document.getElementById('font-size-label').textContent = Number(e.target.value) + 'px';
    });
    document.getElementById('set-font-size').addEventListener('change', (e) => {
      this.settings.fontSize = Number(e.target.value);
    });
    document.getElementById('set-line-wrap').addEventListener('change', (e) => {
      this.settings.lineWrap = e.target.checked;
    });
    document.getElementById('set-line-numbers').addEventListener('change', (e) => {
      this.settings.lineNumbers = e.target.checked;
    });
    document.getElementById('set-preview-font-size').addEventListener('input', (e) => {
      document.getElementById('preview-font-size-label').textContent = Number(e.target.value) + 'px';
    });
    document.getElementById('set-preview-font-size').addEventListener('change', (e) => {
      this.settings.previewFontSize = Number(e.target.value);
    });
    document.getElementById('set-scroll-sync').addEventListener('change', (e) => {
      this.settings.scrollSync = e.target.checked;
    });
    document.getElementById('set-soft-breaks').addEventListener('change', (e) => {
      this.settings.softBreaks = e.target.checked;
    });
    document.getElementById('set-extended-syntax').addEventListener('change', (e) => {
      this.settings.extendedSyntax = e.target.checked;
    });
    document.getElementById('set-show-tray-icon').addEventListener('change', (e) => {
      this.settings.showTrayIcon = e.target.checked;
    });
    document.getElementById('set-show-all-files').addEventListener('change', (e) => {
      this.settings.showAllFiles = e.target.checked;
    });
    document.getElementById('set-code-line-numbers').addEventListener('change', (e) => {
      this.settings.codeLineNumbers = e.target.checked;
    });
    document.getElementById('set-code-wrap').addEventListener('change', (e) => {
      this.settings.codeWrap = e.target.checked;
    });
    document.getElementById('set-code-scroll').addEventListener('change', (e) => {
      this.settings.codeScroll = e.target.checked;
    });
    // 图片存储方式 / 路径：已从 radio 升级为自绘下拉（set-image-store-mode / set-image-asset-path-mode），
    // onChange 在 initSettings 里通过 Select 绑定到 this.settings.imageInsertMode / imageAssetPathMode。

    document.getElementById('settings-image-asset-path').addEventListener('change', (e) => {
      this.settings.imageAssetPath = e.target.value.trim() || 'assets';
    });

    this.updateImageAssetPathHint();

    // ====== 字体选择（系统字体全量 + 自定义字体，可搜索 FontPicker） ======
    const addFontBtn = document.getElementById('btn-add-font');
    if (addFontBtn) addFontBtn.addEventListener('click', () => this.addFontFiles());
    // 三个字体选择器：editor / preview / code 共用同一组件与选项
    this._fontPickers = {};
    for (const k of ['editor', 'preview', 'code']) {
      const root = document.getElementById('set-' + k + '-font');
      if (!root) continue;
      this._fontPickers[k] = new FontPicker(root, {
        value: this.settings[k + 'Font'] || '',
        placeholder: this.t('defaultFont'),
        t: this.t.bind(this),
        onChange: (v) => {
          this.settings[k + 'Font'] = v;
          this.refreshFontSelectors();
        },
      });
    }
    // 通用自绘下拉：主题模式 + 配色方案（替代原生 select，展开面板可主题化 + 完整 ARIA）
    this._selects = {};
    const themeHost = document.getElementById('set-theme-mode');
    if (themeHost) {
      this._selects.themeMode = new Select(themeHost, {
        value: this.settings.themeMode,
        t: this.t.bind(this),
        ariaLabelKey: 'themeMode',
        optionsProvider: (t) => ([
          { value: 'light', label: t('themeLight') },
          { value: 'dark', label: t('themeDark') },
          { value: 'system', label: t('followSystem') },
        ]),
        onChange: (v) => { this.settings.themeMode = v; },
      });
    }
    const colorHost = document.getElementById('set-color-scheme');
    if (colorHost) {
      this._selects.colorScheme = new Select(colorHost, {
        value: this.settings.colorScheme || 'default',
        t: this.t.bind(this),
        ariaLabelKey: 'colorScheme',
        optionsProvider: (t) => ([
          { value: 'default', label: t('schemeDefault') },
          { value: 'sunset', label: t('schemeSunset') },
          { value: 'forest', label: t('schemeForest') },
          { value: 'nord', label: t('schemeNord') },
          { value: 'dusk', label: t('schemeDusk') },
        ]),
        onChange: (v) => { this.settings.colorScheme = v; },
      });
    }
    // 通用自绘下拉：语言 / Tab 宽度 / 行高 / 最大宽度 / 默认视图 / 关闭行为
    // （替代原生 select，展开面板可主题化 + 完整 ARIA；与原生 select 行为一致：仅写内存，
    //  真正生效/落盘由「应用/保存」决定）
    const langHost = document.getElementById('set-language');
    if (langHost) {
      this._selects.language = new Select(langHost, {
        value: this.settings.language || 'zh',
        t: this.t.bind(this),
        ariaLabelKey: 'language',
        optionsProvider: (t) => ([
          { value: 'zh', label: t('langZh') },
          { value: 'en', label: t('langEn') },
        ]),
        onChange: (v) => { this.settings.language = v; },
      });
    }
    const tabHost = document.getElementById('set-tab-size');
    if (tabHost) {
      this._selects.tabSize = new Select(tabHost, {
        value: String(this.settings.tabSize),
        t: this.t.bind(this),
        ariaLabelKey: 'tabSize',
        optionsProvider: (t) => ([
          { value: '2', label: '2 ' + t('spaces') },
          { value: '4', label: '4 ' + t('spaces') },
          { value: '8', label: '8 ' + t('spaces') },
        ]),
        onChange: (v) => { this.settings.tabSize = Number(v); },
      });
    }
    const lhHost = document.getElementById('set-line-height');
    if (lhHost) {
      this._selects.lineHeight = new Select(lhHost, {
        value: String(this.settings.lineHeight),
        t: this.t.bind(this),
        ariaLabelKey: 'lineHeight',
        optionsProvider: (t) => (['1.4', '1.6', '1.7', '1.8', '2.0'].map((v) => ({ value: v, label: v }))),
        onChange: (v) => { this.settings.lineHeight = Number(v); },
      });
    }
    const mwHost = document.getElementById('set-max-width');
    if (mwHost) {
      this._selects.maxWidth = new Select(mwHost, {
        value: String(this.settings.maxWidth),
        t: this.t.bind(this),
        ariaLabelKey: 'maxWidth',
        optionsProvider: (t) => ([
          { value: '0', label: t('unlimited') },
          { value: '800', label: '800px' },
          { value: '1000', label: '1000px' },
          { value: '1200', label: '1200px' },
        ]),
        onChange: (v) => { this.settings.maxWidth = Number(v); },
      });
    }
    const dvHost = document.getElementById('set-default-view');
    if (dvHost) {
      this._selects.defaultView = new Select(dvHost, {
        value: this.settings.defaultView || 'preview',
        t: this.t.bind(this),
        ariaLabelKey: 'defaultView',
        optionsProvider: (t) => ([
          { value: 'preview', label: t('preview') },
          { value: 'edit', label: t('edit') },
        ]),
        onChange: (v) => { this.settings.defaultView = v; },
      });
    }
    const caHost = document.getElementById('set-close-action');
    if (caHost) {
      this._selects.closeAction = new Select(caHost, {
        value: this.settings.closeAction || 'ask',
        t: this.t.bind(this),
        ariaLabelKey: 'closeAction',
        optionsProvider: (t) => ([
          { value: 'ask', label: t('closeActionAsk') },
          { value: 'quit', label: t('closeActionQuit') },
          { value: 'minimize', label: t('closeActionMinimize') },
        ]),
        onChange: (v) => { this.settings.closeAction = v; },
      });
    }
    // 图片存储方式 / 路径 —— 从 radio 组升级为自绘下拉，与默认视图/关闭窗口时保持视觉一致
    const imgModeHost = document.getElementById('set-image-store-mode');
    if (imgModeHost) {
      this._selects.imageInsertMode = new Select(imgModeHost, {
        value: this.settings.imageInsertMode || 'assets',
        t: this.t.bind(this),
        ariaLabelKey: 'imageSettingLabel',
        optionsProvider: (t) => ([
          { value: 'assets', label: t('imageSettingAssets') },
          { value: 'base64', label: t('imageSettingBase64') },
        ]),
        onChange: (v) => { this.settings.imageInsertMode = v; },
      });
    }
    const pathModeHost = document.getElementById('set-image-asset-path-mode');
    if (pathModeHost) {
      this._selects.imageAssetPathMode = new Select(pathModeHost, {
        value: this.settings.imageAssetPathMode || 'relative',
        t: this.t.bind(this),
        ariaLabelKey: 'imageAssetPathLabel',
        optionsProvider: (t) => ([
          { value: 'relative', label: t('imageAssetPathModeRelative') },
          { value: 'absolute', label: t('imageAssetPathModeAbsolute') },
        ]),
        onChange: (v) => {
          this.settings.imageAssetPathMode = v;
          this.settings.imageAssetPath = v === 'absolute' ? 'D:/images' : 'assets';
          const pathInput = document.getElementById('settings-image-asset-path');
          if (pathInput) pathInput.value = this.settings.imageAssetPath;
          if (typeof this.updateImageAssetPathHint === 'function') this.updateImageAssetPathHint();
        },
      });
    }
    const retryBtn = document.getElementById('btn-retry-system-fonts');
    if (retryBtn) retryBtn.addEventListener('click', () => this.loadSystemFonts(true));
    const cbgToggle = document.getElementById('set-custom-bg');
    if (cbgToggle) cbgToggle.addEventListener('change', (e) => {
      this.settings.customBgEnabled = e.target.checked;
    });
    const cbgColor = document.getElementById('set-custom-bg-color');
    if (cbgColor) cbgColor.addEventListener('input', (e) => {
      this.settings.customBgColor = e.target.value;
    });

    await this.loadSystemFonts();
    await this.registerCustomFonts();
    this.renderCustomFontSettings();

    this.applySettings();
  }

  initOutline() {
    // 侧边栏关闭统一由「视图 → 侧边栏」菜单（toggleSidebar）控制，不再保留顶部关闭栏。
    const outlineSidebar = document.getElementById('outline-sidebar');
    if (!outlineSidebar) return;
  }

  updateSideButtons() {
    const outlineSidebar = document.getElementById('outline-sidebar');
    const sideLeft = document.getElementById('btn-side-left');
    const sideRight = document.getElementById('btn-side-right');
    const outlineWidth = outlineSidebar.classList.contains('hidden') ? 0 : outlineSidebar.offsetWidth;
    sideLeft.style.left = outlineWidth + 'px';
    sideRight.style.left = '';
  }

    toggleSidebar() {
      const sidebar = document.getElementById('outline-sidebar');
      const wasHidden = sidebar.classList.contains('hidden');
      if (wasHidden) {
        sidebar.style.width = (this.settings.outlineWidth ?? 240) + 'px';
        sidebar.classList.remove('hidden');
      } else {
        this.settings.outlineWidth = sidebar.offsetWidth;
        sidebar.style.width = '';
        sidebar.classList.add('hidden');
      }
      this.settings.sidebarHidden = sidebar.classList.contains('hidden');
      this.saveSettings();
      this.updateSidebarChecks();
      if (!sidebar.classList.contains('hidden')) {
        this.updateOutline();
      }
      this.updateSideButtons();
    }

    // 仅确保侧边栏可见（分屏改造后无 Tab 切换，文件/大纲双面板常显）。
    showSidebar() {
      const sidebar = document.getElementById('outline-sidebar');
      if (sidebar.classList.contains('hidden')) {
        sidebar.style.width = (this.settings.outlineWidth ?? 240) + 'px';
        sidebar.classList.remove('hidden');
        this.settings.sidebarHidden = false;
        this.saveSettings();
      }
      this.updateSidebarChecks();
      this.updateSideButtons();
      if (!sidebar.classList.contains('hidden')) this.updateOutline();
    }

    applySidebarState() {
      const sidebar = document.getElementById('outline-sidebar');
      if (this.settings.sidebarHidden) {
        sidebar.style.width = '';
        sidebar.classList.add('hidden');
      } else {
        sidebar.style.width = (this.settings.outlineWidth ?? 240) + 'px';
        sidebar.classList.remove('hidden');
      }
      this.updateSidebarChecks();
      this.updateSideButtons();
      this.applySplitterRatio();
      this.applyPanelCollapse();
    }

  updateSidebarChecks() {
    const sidebar = document.getElementById('outline-sidebar');
    const visible = !sidebar.classList.contains('hidden');
    const sidebarToggle = document.getElementById('btn-sidebar-toggle');
    if (sidebarToggle) sidebarToggle.classList.toggle('checked', visible);
  }

  initPanelHeaders() {
    const filesChevron = document.getElementById('files-chevron');
    const outlineChevron = document.getElementById('outline-chevron');
    const btnAllFolders = document.getElementById('btn-all-folders');
    const btnAllOutline = document.getElementById('btn-all-outline');
    if (filesChevron) {
      filesChevron.addEventListener('click', () => this.togglePanel('files'));
    }
    if (outlineChevron) {
      outlineChevron.addEventListener('click', () => this.togglePanel('outline'));
    }
    // 面板标题（左侧图标+文字）点击等效于点击折叠按钮
    const filesHeader = document.querySelector('.files-panel-header .panel-title-group');
    const outlineHeader = document.querySelector('.outline-panel-header .panel-title-group');
    if (filesHeader) {
      filesHeader.addEventListener('click', () => this.togglePanel('files'));
    }
    if (outlineHeader) {
      outlineHeader.addEventListener('click', () => this.togglePanel('outline'));
    }
    if (btnAllFolders) {
      btnAllFolders.addEventListener('click', () => {
        // 基于文件树实际 DOM 状态决定本次动作，避免 _allFoldersExpanded 标志漂移导致
        // 「再点击不折叠」：只要还有未折叠目录就折叠，否则展开。
        const treeEl = document.getElementById('folder-tree');
        const anyExpanded = !!(treeEl && treeEl.querySelector('.tree-node.tree-folder.expanded'));
        this.toggleAllFolders(!anyExpanded);
      });
    }
    if (btnAllOutline) {
      btnAllOutline.addEventListener('click', () => {
        // 基于大纲实际展开状态决定本次动作：只要还有「可见（未折叠）」的大纲子块就折叠，否则展开。
        // 默认大纲全展开，首点应折叠；图标与 _allOutlineExpanded 同步，避免「点击没反应」。
        const content = document.getElementById('outline-content');
        const anyExpanded = !!(content && content.querySelector('.outline-children:not(.collapsed)'));
        this.toggleAllOutline(!anyExpanded);
      });
    }
    // 初始化「全部」按钮语义：基于 DOM 实际状态，而非硬编码标志，避免图标与实际折叠态不符。
    // 文件：依据已展开目录集合；大纲：默认全展开（outline.js buildOutlineTree 节点 expanded:true），
    // 故只要没有 .outline-children.collapsed 就视为「已全展开」，按钮显示「折叠全部」。
    this._allFoldersExpanded = this.expandedFolders && this.expandedFolders.size > 0;
    const outlineContent0 = document.getElementById('outline-content');
    this._allOutlineExpanded = !outlineContent0 || !outlineContent0.querySelector('.outline-children.collapsed');
    this._updateAllFoldersBtn();
    this._updateAllOutlineBtn();
  }

  initOutlineResizer() {
    const resizer = document.getElementById('outline-resizer');
    const sidebar = document.getElementById('outline-sidebar');
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isResizing = true;
      startX = e.clientX;
      startWidth = sidebar.offsetWidth;
      document.body.classList.add('is-resizing');
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const delta = e.clientX - startX;
      let newWidth = startWidth + delta;
      newWidth = Math.max(80, Math.min(500, newWidth));
      sidebar.style.width = newWidth + 'px';
      this.cm.refresh();
      this.updateSideButtons();
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      document.body.classList.remove('is-resizing');
      this.settings.outlineWidth = sidebar.offsetWidth;
      this.saveSettings();
    });
  }

  updateOutlineCheck() {
    this.updateSidebarChecks();
  }

  // 水平分隔条：调整「文件面板 / 大纲面板」上下高度比例。
  // 仿 initOutlineResizer，但改用 clientY + offsetHeight，并写入 settings.filesPanelRatio。
  initSplitter() {
    const resizer = document.getElementById('sidebar-h-resizer');
    const filesPanel = document.getElementById('folder-content');
    const outlinePanel = document.getElementById('outline-content');
    const sidebar = document.getElementById('outline-sidebar');
    if (!resizer || !filesPanel || !outlinePanel || !sidebar) return;

    const MIN = 120;

    // 两面板实际可分配高度 = 侧栏总高 − 固定 chrome（分隔条 + 大纲标题栏）。
    // 鼠标对齐的关键：两个面板 flex-basis 之和必须等于该可用高度，否则 flex 引擎会按比例
    // 压缩，导致分隔线移动量被缩放、与鼠标脱节。
    const chromeH = () => {
      let h = resizer.offsetHeight || 4;
      const oh = sidebar.querySelector('.outline-panel-header');
      if (oh) h += oh.offsetHeight;
      return h;
    };
    const availH = () => Math.max(0, sidebar.offsetHeight - chromeH());

    let isResizing = false;
    let startY = 0;
    let startFilesH = 0;

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isResizing = true;
      startY = e.clientY;
      startFilesH = filesPanel.offsetHeight;
      document.body.classList.add('is-resizing-row');
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const avail = availH();
      const delta = e.clientY - startY;
      const newH = Math.max(MIN, Math.min(avail - MIN, startFilesH + delta));
      filesPanel.style.flexBasis = newH + 'px';
      outlinePanel.style.flexBasis = (avail - newH) + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      document.body.classList.remove('is-resizing-row');
      const avail = availH();
      if (avail > 0) {
        this.settings.filesPanelRatio = filesPanel.offsetHeight / avail;
        this.saveSettings();
      }
    });
  }

  // 按 settings.filesPanelRatio 还原上下比例（init / 启动 / 切换主题后调用）
  applySplitterRatio() {
    const filesPanel = document.getElementById('folder-content');
    const outlinePanel = document.getElementById('outline-content');
    const sidebar = document.getElementById('outline-sidebar');
    if (!filesPanel || !outlinePanel || !sidebar) return;
    const sidebarH = sidebar.offsetHeight;
    if (sidebarH <= 0) return;
    // 扣完整 chrome（分隔条 + 大纲标题栏），保证两面板 basis 之和等于可用高度
    let chrome = (document.getElementById('sidebar-h-resizer') || {}).offsetHeight || 4;
    const oh = sidebar.querySelector('.outline-panel-header');
    if (oh) chrome += oh.offsetHeight;
    const avail = Math.max(0, sidebarH - chrome);
    const ratio = Math.max(0.1, Math.min(0.9, this.settings.filesPanelRatio ?? 0.5));
    const filesH = Math.round(avail * ratio);
    filesPanel.style.flexBasis = filesH + 'px';
    outlinePanel.style.flexBasis = (avail - filesH) + 'px';
  }

  // 还原面板整体折叠态：折叠时仅隐藏内容区、保留标题栏，对侧 flex:1 自动占满；两折叠则均展开。
  applyPanelCollapse() {
    const filesPanel = document.getElementById('folder-content');
    const outlinePanel = document.getElementById('outline-content');
    const resizer = document.getElementById('sidebar-h-resizer');
    const sidebar = document.getElementById('outline-sidebar');
    if (!filesPanel || !outlinePanel) return;
    let filesCollapsed = !!this.settings.filesCollapsed;
    let outlineCollapsed = !!this.settings.outlineCollapsed;
    // 两者同时折叠属异常态：强制都展开，避免整栏空白
    if (filesCollapsed && outlineCollapsed) {
      filesCollapsed = false;
      outlineCollapsed = false;
      this.settings.filesCollapsed = false;
      this.settings.outlineCollapsed = false;
    }
    // 任一折叠时隐藏水平拖拽条（无占比可言）
    if (resizer) resizer.classList.toggle('hidden', filesCollapsed || outlineCollapsed);
    filesPanel.classList.toggle('panel-collapsed', filesCollapsed);
    outlinePanel.classList.toggle('panel-collapsed', outlineCollapsed);
    // 状态类：驱动折叠态 CSS（文件折叠→文件面板收缩为标题条、大纲内容占满；
    // 大纲折叠→大纲内容隐藏、文件内容占满）。两标题相对位置由 DOM 顺序保证，不重排。
    if (sidebar) {
      sidebar.classList.toggle('files-collapsed', filesCollapsed);
      sidebar.classList.toggle('outline-collapsed', outlineCollapsed);
    }
    const filesChevron = document.getElementById('files-chevron');
    const outlineChevron = document.getElementById('outline-chevron');
    if (filesChevron) {
      filesChevron.classList.toggle('collapsed', filesCollapsed);
      filesChevron.title = filesCollapsed ? '展开文件面板' : '收起文件面板';
      filesChevron.setAttribute('aria-expanded', String(!filesCollapsed));
    }
    if (outlineChevron) {
      outlineChevron.classList.toggle('collapsed', outlineCollapsed);
      outlineChevron.title = outlineCollapsed ? '展开大纲面板' : '收起大纲面板';
      outlineChevron.setAttribute('aria-expanded', String(!outlineCollapsed));
    }
    if (filesCollapsed || outlineCollapsed) {
      // 折叠态下不需要按比例分配高度（CSS 接管：可见面板 flex:1 占满，折叠面板 flex:0 0 auto 缩为标题条）
      filesPanel.style.flexBasis = '';
      outlinePanel.style.flexBasis = '';
    } else {
      // 两面板都展开：恢复由 settings.filesPanelRatio 决定的上下比例（折叠时 basis 被清空过，必须重设）
      this.applySplitterRatio();
    }
  }

  // 面板整体折叠/展开切换
  togglePanel(which) {
    if (which !== 'files' && which !== 'outline') return;
    const willCollapse = which === 'files' ? !this.settings.filesCollapsed : !this.settings.outlineCollapsed;
    if (willCollapse) {
      // 收起当前面板时，若另一面板已折叠，则联动展开另一面板——
      // 保证「文件/大纲至少有一个可见」，同时尊重本次「收起当前」的意图。
      const other = which === 'files' ? 'outline' : 'files';
      const otherCollapsed = other === 'files' ? this.settings.filesCollapsed : this.settings.outlineCollapsed;
      if (otherCollapsed) {
        if (other === 'files') this.settings.filesCollapsed = false;
        else this.settings.outlineCollapsed = false;
      }
    }
    if (which === 'files') {
      this.settings.filesCollapsed = !this.settings.filesCollapsed;
    } else {
      this.settings.outlineCollapsed = !this.settings.outlineCollapsed;
    }
    this.saveSettings();
    this.applyPanelCollapse();
  }

  // 文件树：一键展开/折叠全部目录
  async toggleAllFolders(expand) {
    const treeEl = document.getElementById('folder-tree');
    if (!treeEl) return;
    const btn = document.getElementById('btn-all-folders');
    const FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>';
    const FOLDER_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" /></svg>';

    // 取消任何正在进行的展开/折叠任务，防止旧任务在新操作后继续修改 DOM。
    // 典型场景：展开全部耗时较长，用户在 loading 结束后点折叠，旧展开仍可能异步渲染子目录并重新展开。
    if (this._folderToggleToken) {
      this._folderToggleToken.cancelled = true;
    }
    const token = { cancelled: false };
    this._folderToggleToken = token;

    // 显示 loading 覆盖层（防重复点击 + 视觉反馈），并设超时兜底强制清除，避免卡死在 loading。
    const TIMEOUT_MS = 20000;
    const overlay = this._showFolderLoading(expand ? '正在展开全部目录…' : '正在折叠全部目录…');
    if (btn) btn.disabled = true;
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('folder-toggle-timeout')), TIMEOUT_MS);
    });

    try {
      const work = async () => {
        if (token.cancelled) return;
        if (expand) {
          // 递归展开所有已渲染目录节点（懒加载层级由 renderFolderLevel 补全）
          const expandNode = async (container) => {
            if (token.cancelled) return;
            const folders = container.querySelectorAll(':scope > .tree-node.tree-folder');
            for (const node of folders) {
              if (token.cancelled) return;
              const childContainer = node.querySelector(':scope > .tree-children');
              const path = node.dataset.path;
              if (!childContainer) continue;
              if (childContainer.childElementCount === 0) {
                // 单个子目录读取失败（无权限/IO 异常）不应中断整棵展开
                try {
                  await this.renderFolderLevel(path, childContainer, this._depthOf(node));
                } catch (_) { /* 忽略，继续展开其余目录 */ }
                if (token.cancelled) return;
              }
              childContainer.classList.remove('hidden');
              node.classList.add('expanded');
              const icon = node.querySelector(':scope > .tree-row .tree-icon.folder');
              if (icon) icon.innerHTML = FOLDER_OPEN;
              if (path) this.expandedFolders.add(path);
              await expandNode(childContainer);
            }
          };
          await expandNode(treeEl);
        } else {
          // 直接折叠当前所有已展开目录的 DOM，不依赖重建：清空集合 + 隐藏 .tree-children
          this.expandedFolders.clear();
          treeEl.querySelectorAll('.tree-children').forEach((c) => c.classList.add('hidden'));
          treeEl.querySelectorAll('.tree-node.tree-folder.expanded').forEach((n) => n.classList.remove('expanded'));
          treeEl.querySelectorAll('.tree-row .tree-icon.folder').forEach((icon) => { icon.innerHTML = FOLDER; });
        }
      };
      // 超时强制兜底：无论成功或超时都进 finally 清理；超时不抛错，只提示
      await Promise.race([work(), timeoutPromise.then(() => { throw new Error('folder-toggle-timeout'); })]);
    } catch (err) {
      if (err && err.message === 'folder-toggle-timeout') {
        // 超时：目录可能过多/IO 慢，强制结束并提示，不让用户卡在 loading
        token.cancelled = true;
        this.showToast(expand ? '展开全部目录超时' : '折叠全部目录超时');
      }
      // 其它异常也继续走 finally 清理
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      token.cancelled = true;
      this._hideFolderLoading(overlay);
      if (btn) btn.disabled = false;
      // 仅当本任务仍是当前任务时才更新状态与按钮，避免被更新的操作覆盖。
      // （如用户在新展开中途点折叠，折叠已设置状态为 false，旧展开的 finally 不应再把它改回 true。）
      if (this._folderToggleToken === token) {
        this.saveSession();
        this._allFoldersExpanded = expand;
        this._updateAllFoldersBtn();
      }
    }
  }

  // 在文件面板内显示半透明 loading 覆盖层；返回该元素以便后续移除
  _showFolderLoading(text) {
    const folderContent = document.getElementById('folder-content');
    if (!folderContent) return null;
    let overlay = folderContent.querySelector('.folder-loading-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'folder-loading-overlay';
      const spinner = document.createElement('div');
      spinner.className = 'folder-loading-spinner';
      const label = document.createElement('span');
      label.className = 'folder-loading-text';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'folder-loading-cancel';
      cancelBtn.textContent = this.t('cancel') || '取消';
      cancelBtn.addEventListener('click', () => {
        // 取消：中止展开/折叠的剩余递归（已展开/折叠的目录保持现状），并收起遮罩
        if (this._folderToggleToken) this._folderToggleToken.cancelled = true;
        this._hideFolderLoading(overlay);
      });
      overlay.appendChild(spinner);
      overlay.appendChild(label);
      overlay.appendChild(cancelBtn);
      folderContent.appendChild(overlay);
    }
    overlay.querySelector('.folder-loading-text').textContent = text || '';
    overlay.classList.remove('hidden');
    return overlay;
  }

  _hideFolderLoading(overlay) {
    if (!overlay || !overlay.parentNode) return;
    overlay.classList.add('hidden');
  }

  // 大纲：一键展开/折叠全部
  toggleAllOutline(expand) {
    const content = document.getElementById('outline-content');
    if (!content) return;
    const childrenBlocks = content.querySelectorAll('.outline-children');
    childrenBlocks.forEach((block) => {
      block.classList.toggle('collapsed', !expand);
    });
    const toggles = content.querySelectorAll('.outline-toggle:not(.outline-toggle--hidden)');
    toggles.forEach((tg) => {
      // 通过 collapsed 类让 CSS 旋转 SVG（不再用 textContent 写 ▼/▶，否则会破坏矢量三角、变大且风格不一致）
      tg.classList.toggle('collapsed', !expand);
    });
    this._allOutlineExpanded = expand;
    this._updateAllOutlineBtn();
  }

  _depthOf(node) {
    let depth = 0;
    let p = node.parentElement;
    while (p && p.id !== 'folder-tree') {
      if (p.classList.contains('tree-children')) depth++;
      p = p.parentElement;
    }
    return depth;
  }

  _updateAllFoldersBtn() {
    const btn = document.getElementById('btn-all-folders');
    if (!btn) return;
    // 双态字形：三条横线 + 三角（与单箭头 disclosure 的面板 chevron 明显区分）
    // 已全展开→「上三角」表示点击将折叠全部；否则→「下三角」表示点击将展开全部
    // 展开/折叠全部：使用 Lucide fold-vertical / unfold-vertical（收纳/展开，二者互为镜像，语义清晰）
    const COLLAPSE_ALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22v-6"/><path d="M12 8V2"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/><path d="m15 19-3-3-3 3"/><path d="m15 5-3 3-3-3"/></svg>';
    const EXPAND_ALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22v-6"/><path d="M12 8V2"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/><path d="m15 19-3 3-3-3"/><path d="m15 5-3-3-3 3"/></svg>';
    btn.innerHTML = this._allFoldersExpanded ? COLLAPSE_ALL : EXPAND_ALL;
    btn.title = this._allFoldersExpanded ? '折叠全部目录' : '展开全部目录';
    btn.setAttribute('aria-pressed', String(this._allFoldersExpanded));
  }

  _updateAllOutlineBtn() {
    const btn = document.getElementById('btn-all-outline');
    if (!btn) return;
    // 展开/折叠全部：使用 Lucide fold-vertical / unfold-vertical（收纳/展开，二者互为镜像，语义清晰）
    const COLLAPSE_ALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22v-6"/><path d="M12 8V2"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/><path d="m15 19-3-3-3 3"/><path d="m15 5-3 3-3-3"/></svg>';
    const EXPAND_ALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22v-6"/><path d="M12 8V2"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/><path d="m15 19-3 3-3-3"/><path d="m15 5-3-3-3 3"/></svg>';
    btn.innerHTML = this._allOutlineExpanded ? COLLAPSE_ALL : EXPAND_ALL;
    btn.title = this._allOutlineExpanded ? '折叠全部大纲' : '展开全部大纲';
    btn.setAttribute('aria-pressed', String(this._allOutlineExpanded));
  }

  initBreadcrumb() {
    const bc = document.getElementById('editor-breadcrumb');
    const scroll = document.getElementById('editor-breadcrumb-scroll');
    const overflowBtn = document.getElementById('editor-breadcrumb-overflow');
    if (!bc || !scroll) return;
    this._breadcrumbOverflowBtn = overflowBtn;

    // 滚轮横向滚动：鼠标滚轮在面包屑上时转换为左右滚动
    bc.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0 && scroll.scrollWidth > scroll.clientWidth) {
        e.preventDefault();
        scroll.scrollLeft += e.deltaY;
        this._updateBreadcrumbOverflow();
      }
    }, { passive: false });

    // 横向滚动时同步左侧溢出指示器（回到开头按钮）的显隐
    scroll.addEventListener('scroll', () => this._updateBreadcrumbOverflow(), { passive: true });

    // 点击左侧指示器平滑回到开头（查看被折叠/滚走的根标题）
    if (overflowBtn) {
      overflowBtn.addEventListener('click', () => {
        scroll.scrollTo({ left: 0, behavior: 'smooth' });
      });
    }

    // 点击标题跳转（事件委托）
    bc.addEventListener('click', (e) => {
      const item = e.target.closest('[data-breadcrumb-line]');
      if (!item || !this.cm) return;
      const line = parseInt(item.dataset.breadcrumbLine, 10);
      if (Number.isNaN(line)) return;
      this._jumpToHeadingLine(line);
    });
  }

  // 当内容溢出且已向左滚动离开起点时，显示左侧"回到开头"指示器
  _updateBreadcrumbOverflow() {
    const bc = document.getElementById('editor-breadcrumb');
    const scroll = document.getElementById('editor-breadcrumb-scroll');
    if (!bc || !scroll || !this._breadcrumbOverflowBtn) return;
    const show = scroll.scrollWidth > scroll.clientWidth && scroll.scrollLeft > 1;
    bc.classList.toggle('show-overflow', show);
  }

  _jumpToHeadingLine(line) {
    if (!this.cm) return;
    this.cm.setCursor({ line, ch: 0 });
    this.cm.focus();
    // WebView 中 scrollIntoView 不触发，改用精确滚动公式
    const y = this.cm.heightAtLine(line, 'local');
    this.cm.scrollTo(0, Math.max(0, y - 80));
  }

  updateBreadcrumb(force = false, line = null) {
    if (!this.cm) return;
    const content = this.cm.getValue();
    if (force || this._breadcrumbLastContent !== content) {
      this._breadcrumbHeadings = Outline.extractHeadings(content, { headingToId: (t) => this.headingToId(t) });
      this._breadcrumbLastContent = content;
    }
    const targetLine = typeof line === 'number' ? line : this.cm.getCursor().line;
    const path = Outline.computeBreadcrumbPath(this._breadcrumbHeadings, targetLine);
    this._renderBreadcrumb(path);
  }

  _renderBreadcrumb(path) {
    const bc = document.getElementById('editor-breadcrumb');
    const content = document.getElementById('editor-breadcrumb-content');
    const scroll = document.getElementById('editor-breadcrumb-scroll');
    if (!bc || !content) return;

    // diff guard：路径或文件名未变时不重写 DOM，避免滚动/光标高频事件导致重排
    const rawFileName = this.activeTab?.name || '';
    const key = (path ? path.map((h) => h.line + ':' + h.text).join('|') : '') + '|' + rawFileName;
    if (this._breadcrumbLastKey === key) return;
    this._breadcrumbLastKey = key;

    if (!path) path = [];

    // 始终显示面包屑（含文件名）。即使光标在第一标题前导致 path 为空，
    // 也只渲染文件名占位、保留栏体高度，避免编辑区因 .hidden{display:none}
    // 上下跳动；标题链由后续 for 循环按 path 长度追加。
    bc.classList.remove('hidden');
    const fileIcon = '<svg class="breadcrumb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /></svg>';
    content.innerHTML = Outline.renderBreadcrumbHtml(path, rawFileName || this.t('untitled'), {
      iconSvg: fileIcon,
    });

    // 自动定位当前项：仅当活动标题（最后一个）不完全可见时滚动到末尾，
    // 避免用户手动左滚查看开头时被强行拉回。
    if (scroll) {
      const activeEl = content.querySelector('.editor-breadcrumb-item.active');
      if (activeEl) {
        const right = activeEl.offsetLeft + activeEl.offsetWidth;
        if (right > scroll.scrollLeft + scroll.clientWidth) {
          scroll.scrollLeft = scroll.scrollWidth - scroll.clientWidth;
        }
      }
      this._updateBreadcrumbOverflow();
    }
  }

  updateOutline() {
    const content = this.cm.getValue();
    const outlineContent = document.getElementById('outline-content');
    const headings = Outline.extractHeadings(content, { headingToId: (t) => this.headingToId(t) });

    // 面包屑共享同一套标题数据，避免重复抽取
    this._breadcrumbHeadings = headings;
    this._breadcrumbLastContent = content;
    this._renderBreadcrumb(Outline.computeBreadcrumbPath(headings, this.cm.getCursor().line));

    if (headings.length === 0) {
      outlineContent.innerHTML = `<div class="outline-empty">${this.t('noHeadings')}</div>`;
      return;
    }

    const tree = Outline.buildOutlineTree(headings);
    outlineContent.innerHTML = Outline.renderOutlineHtml(tree, {
      escapeHtml: (t) => this.escapeHtml(t),
      maxLevel: this.settings.outlineFilterLevel || 0,
    });

    // Event delegation on outline-content
    outlineContent.onclick = (e) => {
      const toggle = e.target.closest('.outline-toggle');
      const item = e.target.closest('.outline-item');
      if (!item) return;

      if (toggle) {
        e.stopPropagation();
        const wrapper = item.closest('.outline-item-wrapper');
        const children = wrapper?.querySelector('.outline-children');
        if (children) {
          const isCollapsed = children.classList.toggle('collapsed');
          // 通过 collapsed 类让 CSS 旋转 SVG（不再用 textContent 写 ▼/▶，否则会破坏矢量三角、变大且风格不一致）
          toggle.classList.toggle('collapsed', isCollapsed);
        }
        return;
      }

      // Label click → jump
      const id = item.dataset.id;
      const line = parseInt(item.dataset.line, 10);
      // 跳转期间关闭滚动同步：setCursor/scrollIntoView 与 preview.scrollTo 都会触发各自的
      // scroll 事件，若不抑制，滚动同步会把对方刚设好的目标位置覆盖掉，表现为「点完大纲
      // 编辑区/预览仍停在顶部、光标却跳到了标题行」。先取消在途同步调度，再双标志锁住，
      // 跳转完成 120ms 后恢复（与 handleTaskCheckboxToggle 同一做法）。
      this._scrollThrottleTimer = null;
      this._scrollThrottlePending = null;
      clearTimeout(this._scrollDebounceTimer);
      this._scrollDebounceTimer = null;
      // 取消可能晚到的「视图模式恢复滚动」定时器（applyViewMode 50ms），
      // 否则它会在本次跳转之后把编辑器/预览又拉回旧位置。
      clearTimeout(this._viewModeRestoreTimer);
      this._viewModeRestoreTimer = null;
      this._canScroll.editor = false;
      this._canScroll.preview = false;
      // 编辑区始终跳转到该标题行（与文档大小无关，大文件预览只渲染头部时也能跳）
      if (!isNaN(line)) {
        this.cm.setCursor({ line, ch: 0 });
        // 显式滚动到标题行顶部留 80px 余量：scrollIntoView 在某些 WebView 下不触发实际滚动，
        // 导致「光标到了标题行、可视区仍停在顶部」；scrollTo 直接生效且不受上方 _canScroll 抑制影响。
        const targetTop = this.cm.heightAtLine(line, 'local') - 80;
        this.cm.scrollTo(0, Math.max(0, targetTop));
      }
      // 预览区跳转（仅当该标题已渲染在预览中时）
      // 守卫：纯符号标题（如 `# ===`）headingToId 会产出空串，querySelector('#') 抛
      // SyntaxError（历史 bug），跳过预览跳转仅保留编辑区跳转
      if (id) {
        const target = this.preview.querySelector(`#${CSS.escape(id)}`);
        if (target) {
          const previewHeight = this.preview.clientHeight;
          const targetRect = target.getBoundingClientRect();
          const previewRect = this.preview.getBoundingClientRect();
          // 顶部对齐：标题行与预览视口顶部对齐（余量 0），与编辑区跳转（顶部 -80px）一致，
          // 符合用户预期「点大纲即定位到标题顶部」，且不依赖居中逻辑、不影响滚动同步。
          const top = targetRect.top - previewRect.top + this.preview.scrollTop;
          this.preview.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
        } else if (this.previewWindow) {
          // 大文档窗口模式：目标标题尚未渲染在预览中，以该行为焦点重渲染预览窗口，使其落点
          this._previewScrollDriven = false;
          if (Number.isFinite(line)) this._previewFocusLine = line;
          this.updatePreview();
        }
      }
      // 安全网：120ms 后恢复滚动同步（此时两个面板均已停在标题位置，无在途滚动事件）。
      // 直接还原为可用状态，避免把上一轮滚动同步残留的 false 标志固化下来。
      setTimeout(() => {
        if (this._canScroll) {
          this._canScroll.editor = true;
          this._canScroll.preview = true;
        }
      }, 120);
      outlineContent.querySelectorAll('.outline-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
    };

    // 渲染后按当前光标行设置高亮（DOM 已重建，重置 guard 再派生）
    this._outlineActiveKey = null;
    this.updateOutlineActive(this.cm.getCursor().line);
  }

  // 大纲动态跟随：根据给定行号高亮当前标题，并将该标题滚动进 outline 视口，
  // 与面包屑共用 computeBreadcrumbPath，保证二者指向同一当前标题。
  // 用于：编辑器滚动、光标移动、内容/标签页切换后保持大纲与文档/面包屑一致。
  updateOutlineActive(line) {
    const outlineContent = document.getElementById('outline-content');
    if (!outlineContent) return;
    const items = outlineContent.querySelectorAll('.outline-item');
    const headings = this._breadcrumbHeadings;

    if (!headings || !headings.length || typeof line !== 'number') {
      items.forEach(el => el.classList.remove('active'));
      this._outlineActiveKey = null;
      return;
    }

    // 当前标题 = 面包屑路径最后一个（最深、且行号 <= line 的标题），与面包屑完全一致
    const path = Outline.computeBreadcrumbPath(headings, line);
    const current = path.length ? path[path.length - 1] : null;

    let target = null;
    if (current) {
      target = outlineContent.querySelector(`.outline-item[data-line="${current.line}"][data-id="${CSS.escape(String(current.id))}"]`)
           || outlineContent.querySelector(`.outline-item[data-line="${current.line}"]`);
    }

    const key = current ? (current.line + ':' + current.id) : '';
    // diff guard：当前标题未变时跳过 DOM 写入与滚动，避免同段内滚动抖动
    if (this._outlineActiveKey === key && target) return;
    this._outlineActiveKey = key;

    items.forEach(el => el.classList.remove('active'));
    if (!target) return;
    target.classList.add('active');

    // 纵向跟随：仅当该标题离开 outline 视口时才滚动其回可见区域（不改横向滚动）
    // 若标题因父级折叠而隐藏（offsetParent 为 null），仅保留高亮、跳过滚动
    if (target.offsetParent === null) return;
    const cRect = outlineContent.getBoundingClientRect();
    const tRect = target.getBoundingClientRect();
    if (tRect.top < cRect.top + 4 || tRect.bottom > cRect.bottom - 4) {
      const delta = (tRect.top + tRect.bottom) / 2 - (cRect.top + cRect.bottom) / 2;
      outlineContent.scrollTop += delta;
    }
  }

  // 预览模式大纲跟随：编辑器隐藏时，按预览滚动位置推导当前标题（源码行）再高亮。
  // 视图模式切换后预览 recreate，标题 id 与大纲 id 同源（均由 headingToId 生成），
  // 故可直接用预览 DOM 中的 h1~h6[id] 反查源码行，保证大纲与预览内容一致。
  updateOutlineFromPreview() {
    const preview = this.preview;
    const headings = this._breadcrumbHeadings;
    if (!preview || !headings || !headings.length) {
      this.updateOutlineActive(-1); // 无标题：清空高亮
      return;
    }
    let line = null;
    if (this._previewVirtual && Number.isFinite(this._previewFocusLine)) {
      // 大文档虚拟预览：渲染切片不含所有标题，直接用窗口焦点行推导当前标题
      line = this._previewFocusLine;
    } else {
      const pRect = preview.getBoundingClientRect();
      const els = preview.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]');
      let foundId = null;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        // 取最后一个顶部已滚过视口上沿的标题（文档顺序 == 标题顺序，遇未越过者即停）
        if (r.top - pRect.top <= 4) foundId = el.id; else break;
      }
      if (foundId) {
        const h = headings.find((hh) => hh.id === foundId);
        if (h) line = h.line;
      }
    }
    if (line == null) {
      // 滚到首个标题之前：清空高亮（line 取首标题前一行，computeBreadcrumbPath 返回空）
      this.updateOutlineActive(headings[0].line - 1);
    } else {
      this.updateOutlineActive(line);
    }
  }

  headingToId(text) {
    let id = '';
    for (const ch of text) {
      if (/[\p{L}\p{N}]/u.test(ch)) {
        id += ch.toLowerCase();
      } else if (ch === ' ' || ch === '-' || ch === '_') {
        id += '-';
      }
    }
    return id.replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // 转义双引号 HTML 属性值（img alt、a title 等），防止属性提前闭合
  escapeAttr(text) {
    return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 转义 Markdown 链接/图片 alt 文本中破坏语法的字符（] 与 \）
  escapeMdText(text) {
    return String(text).replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
  }

  // 同步托盘显隐状态到 Rust 后端
  async applyWindowBehavior() {
    const showTray = this.settings.showTrayIcon !== false;
    try {
      await TauriApi.setWindowBehavior({ showTray });
    } catch (err) {
      console.warn('applyWindowBehavior failed', err);
    }
  }

  // 按 RGB 16 进制计算感知亮度（ITU-R BT.601），越接近 255 越亮。
  _bgLuminance(hex) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
    if (!m) return 255;
    const v = parseInt(m[1], 16);
    const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  // 自定义页面底色：编辑+预览区背景用 customBgColor，文字按亮度反色。
  // 实现：在 <html> 上设 --custom-bg/--custom-fg，styles.css 里这两变量优先覆盖编辑/预览区；
  // body 加 custom-bg-active 类作为开关标记。关闭时清除变量与类，恢复主题默认。
  applyCustomBg() {
    const root = document.documentElement;
    const body = document.body;
    if (!root || !body) return;
    if (this.settings.customBgEnabled) {
      const bg = this.settings.customBgColor || '#f8f7f4';
      const lum = this._bgLuminance(bg);
      const fg = lum >= 128 ? '#2c2c2e' : '#d1d2d6';
      root.style.setProperty('--custom-bg', bg);
      root.style.setProperty('--custom-fg', fg);
      body.classList.add('custom-bg-active');
    } else {
      root.style.removeProperty('--custom-bg');
      root.style.removeProperty('--custom-fg');
      body.classList.remove('custom-bg-active');
    }
  }

  async applySettings() {
    const s = this.settings;
    this.editorZoom = null; // 应用设置时回落到设置字号（编辑器字号全局，非 per-tab）
    this.cm.getWrapperElement().style.fontSize = s.fontSize + 'px';
    this.cm.setOption('tabSize', s.tabSize);
    this.cm.setOption('indentUnit', s.tabSize);
    this.cm.setOption('lineWrapping', s.lineWrap);
    this.cm.setOption('lineNumbers', s.lineNumbers);
    this.preview.style.fontSize = s.previewFontSize + 'px';
    this.previewZoom = null; // 应用设置时回落到设置字号（与编辑器 tab.fontSize 重置一致）
    this.preview.style.lineHeight = String(s.lineHeight);
    if (s.maxWidth) {
      this.preview.style.maxWidth = s.maxWidth + 'px';
      this.preview.style.margin = '0 auto';
      this.preview.classList.add('max-width-active');
    } else {
      this.preview.style.maxWidth = '';
      this.preview.style.margin = '';
      this.preview.classList.remove('max-width-active');
    }
    this.preview.classList.toggle('code-line-numbers', s.codeLineNumbers);
    this.preview.classList.toggle('code-wrap', s.codeWrap);
    this.preview.classList.toggle('code-no-scroll', s.codeScroll === false);
    if (this._hljsCache) this._hljsCache.clear();
    await this.applyThemeMode();
    this.applyCustomBg();
    this.applyCustomFonts();
    // 「显示所有文件」开关切换后，重渲染文件树让过滤即时生效；
    // expandedFolders 集合保证展开态不丢
    if (this.workspaceFolder) this.renderFolderTree();
  }

  // ====== 自定义字体 ======
  async addFontFiles() {
    const btn = document.getElementById('btn-add-font');
    const originalHTML = btn ? btn.innerHTML : '';
    const setLoading = (n, total) => {
      if (!btn) return;
      btn.classList.add('is-loading');
      btn.innerHTML = `<span class="btn-spinner"></span>` + this.t('importingFonts', { n, total });
    };
    try {
      const selected = await dialogOpen({
        multiple: true,
        filters: [{ name: '字体', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const imported = [];
      const success = [];
      const skipped = [];
      const failed = [];
      setLoading(0, paths.length);
      // 先让 spinner 绘制出来，再做大字体解码等阻塞主线程的工作，避免看起来卡死
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const appDir = await TauriApi.appDataDir();
      const fontsDir = appDir.replace(/[\\\/]$/, '') + '/tizu-mark/fonts';
      await TauriApi.ensureDir({ path: fontsDir });
      for (let i = 0; i < paths.length; i++) {
        const p = paths[i];
        const name = p.split(/[\\\/]/).pop();
        setLoading(i + 1, paths.length);
        try {
          const b64 = await TauriApi.fetchImageAsBase64({ url: p });
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          let hash = '';
          if (crypto && crypto.subtle && crypto.subtle.digest) {
            const buf = await crypto.subtle.digest('SHA-256', bytes);
            hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
          }
          const fonts = this.settings.customFonts || [];
          const existing = hash ? fonts.find(f => f.hash === hash) : fonts.find(f => f.name === name);
          if (existing) {
            skipped.push(name);
            imported.push(existing.id);
            continue;
          }
          const ext = (p.split('.').pop() || 'ttf').toLowerCase();
          const id = 'cf' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
          const fileName = id + '.' + ext;
          await TauriApi.writeBinaryFile({ path: fontsDir + '/' + fileName, contents: Array.from(bytes) });
          this.settings.customFonts.push({ id, name, fileName, hash });
          success.push(name);
          imported.push(id);
        } catch (err) {
          failed.push({ name, reason: String(err && err.message ? err.message : err) });
        }
      }
      // 需求（2026-08-06）：添加字体只入列表并立即保存字体列表本身，
      // 不自动切换编辑器/预览字体选择项，也不立即应用到软件；
      // 用户手动选择字体后点「应用/保存」才生效并落盘。
      if (success.length) {
        // 仅持久化 customFonts 字段（不落盘面板内其他未应用设置）
        this._persistCustomFontsOnly();
        // 同步快照：取消面板不丢已添加的字体列表
        if (this._settingsSnapshot) {
          this._settingsSnapshot.customFonts = JSON.parse(JSON.stringify(this.settings.customFonts || []));
        }
      }
      // 注册 @font-face 资源（供下拉框/预览按需选择时可用），不改变任何选择项
      await this.registerCustomFonts();
      this.renderCustomFontSettings();
      if (success.length) {
        this.showToast(this.t('importSuccess', { n: success.length }), 'success');
      }
      const totalFail = skipped.length + failed.length;
      if (totalFail) {
        const parts = [];
        if (skipped.length) parts.push(skipped.join('、') + ' ' + this.t('fontAlreadyExists'));
        failed.forEach(f => parts.push(`${f.name}（${f.reason}）`));
        this.showToast(this.t('importFailed', { n: totalFail, detail: parts.join('；') }), 'danger');
      }
    } catch (e) {
      this.showToast(this.t('addFont') + ' ' + this.t('failed') + ': ' + e, 'danger');
    } finally {
      if (btn) {
        btn.classList.remove('is-loading');
        btn.innerHTML = originalHTML;
      }
    }
  }

  async registerCustomFonts() {
    let style = document.getElementById('custom-fonts-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'custom-fonts-style';
      document.head.appendChild(style);
    }
    const fonts = this.settings.customFonts || [];
    if (fonts.length === 0) {
      style.textContent = '';
      return;
    }
    const appDir = await TauriApi.appDataDir();
    const fontsDir = appDir.replace(/[\\\/]$/, '') + '/tizu-mark/fonts';
    const mimeMap = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
    const fmtMap = { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' };
    let css = '';
    for (const f of fonts) {
      const ext = (f.fileName.split('.').pop() || 'ttf').toLowerCase();
      const mime = mimeMap[ext] || 'font/ttf';
      const fmt = fmtMap[ext] || 'truetype';
      const b64 = await TauriApi.fetchImageAsBase64({ url: fontsDir + '/' + f.fileName });
      css += `@font-face{font-family:'tizumark-custom-${f.id}';src:url(data:${mime};base64,${b64}) format('${fmt}');font-display:swap;}\n`;
    }
    style.textContent = css;
  }

  // 加载系统字体列表：Rust 命令 list_system_fonts 精确枚举（fontdb）。
  // 结果缓存 this._systemFonts；失败 → 空列表 + toast + 显示重试按钮，
  // 绝不伪造降级名单（保证「用户选到的字体是真实已安装的」）。
  async loadSystemFonts(force = false) {
    if (!force && Array.isArray(this._systemFonts)) return this._systemFonts;
    const retryBtn = document.getElementById('btn-retry-system-fonts');
    try {
      const list = await TauriApi.listSystemFonts();
      this._systemFonts = Array.isArray(list) ? list.slice() : [];
      this._systemFontsError = '';
    } catch (err) {
      this._systemFonts = [];
      this._systemFontsError = String(err && err.message ? err.message : err);
      this.showToast(this.t('systemFontsLoadFailed'), 'danger');
    }
    if (retryBtn) retryBtn.classList.toggle('hidden', !this._systemFontsError);
    this.refreshFontSelectors();
    return this._systemFonts;
  }

  // 字体值 → CSS font-family 片段：空→''；命中自定义字体 id→tizumark-custom-{id}；
  // 否则视为系统字体族名→加引号（兼容含空格的族名如 "Microsoft YaHei"）
  _fontFamilyFor(id) {
    if (!id) return '';
    const isCustom = (this.settings.customFonts || []).some(f => f.id === id);
    return isCustom ? `'tizumark-custom-${id}'` : `"${id}"`;
  }

  applyCustomFonts() {
    const ef = this._fontFamilyFor(this.settings.editorFont);
    this.cm.getWrapperElement().style.fontFamily = ef;
    const pf = this._fontFamilyFor(this.settings.previewFont);
    this.preview.style.fontFamily = pf;
    // 预览代码块字体（行内代码 + 围栏代码块）注入到专用 CSS 变量；空则回退等宽默认
    const cf = this._fontFamilyFor(this.settings.codeFont);
    this.preview.style.setProperty('--font-code-preview', cf || 'var(--font-mono)');
  }

  async removeCustomFont(id) {
    const font = (this.settings.customFonts || []).find(f => f.id === id);
    const name = font ? font.name : '';
    await this.showConfirmDialog(
      this.t('deleteFont'),
      this.t('confirmDeleteFont', { name }),
      async () => {
        this.settings.customFonts = (this.settings.customFonts || []).filter(f => f.id !== id);
        if (this.settings.editorFont === id) this.settings.editorFont = '';
        if (this.settings.previewFont === id) this.settings.previewFont = '';
        if (this.settings.codeFont === id) this.settings.codeFont = '';
        // 应用式：删除在面板内即时生效，落盘随「应用/保存」
        await this.registerCustomFonts();
        this.applyCustomFonts();
        this.renderCustomFontSettings();
      }
    );
  }

  renderCustomFontSettings() {
    const list = document.getElementById('custom-font-list');
    if (list) {
      list.innerHTML = '';
      const fonts = this.settings.customFonts || [];
      if (fonts.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'custom-font-empty';
        empty.textContent = this.t('noCustomFont');
        list.appendChild(empty);
      } else {
        fonts.forEach(f => {
          const row = document.createElement('div');
          row.className = 'custom-font-item';
          const name = document.createElement('span');
          name.className = 'custom-font-name';
          name.textContent = f.name;
          const del = document.createElement('button');
          del.className = 'custom-font-del dialog-btn';
          del.type = 'button';
          del.textContent = this.t('deleteFont');
          del.addEventListener('click', () => this.removeCustomFont(f.id));
          row.appendChild(name);
          row.appendChild(del);
          list.appendChild(row);
        });
      }
    }
    this.refreshFontSelectors();
  }

  refreshFontSelectors() {
    // 选项分组：系统字体（值=英文族名原文，仅白名单内且本机已装，中英文名归一去重）
    //           + 自定义字体（值=自定义 id）
    const groups = [];
    const allSys = Array.isArray(this._systemFonts) ? this._systemFonts : [];
    const custom = this.settings.customFonts || [];
    const customIds = new Set(custom.map(f => f.id));
    const isZh = this.settings.language !== 'en';
    // 已选中的系统字体（可能不在白名单内，但应保留显示）
    const selectedSys = new Set(['editor', 'preview', 'code'].map(k => this.settings[k + 'Font'] || '').filter(Boolean));
    // 归一：中文名/变体名条目 → 主族英文 value（FONT_LOCALE_REV）；未映射字体保持原名
    const norm = (n) => FONT_LOCALE_REV.get(n.toLowerCase()) || n;
    // 显示名：中文 UI 显示中文名（有映射时），英文 UI 显示英文原名
    const disp = (en) => (isZh && FONT_NAME_LOCALE[en]) ? FONT_NAME_LOCALE[en] : en;
    const seen = new Set();
    const sysItems = [];
    for (const n of allSys) {
      const en = norm(n);
      if (!SYSTEM_FONT_WHITELIST_SET.has(en.toLowerCase()) && !selectedSys.has(en)) continue;
      const key = en.toLowerCase();
      if (seen.has(key)) continue; // 中英两条同族只保留一条
      seen.add(key);
      sysItems.push({ value: en, label: disp(en), fontFamily: `"${en}"` });
    }
    // 防御：选中了白名单外、且未在枚举列表中的字体，也补一项避免「字体消失」
    ['editor', 'preview', 'code'].forEach(k => {
      const v = this.settings[k + 'Font'] || '';
      if (v && !customIds.has(v) && !seen.has(v.toLowerCase())) {
        seen.add(v.toLowerCase());
        sysItems.push({ value: v, label: disp(v), fontFamily: `"${v}"` });
      }
    });
    if (sysItems.length) {
      groups.push({ label: this.t('systemFonts'), items: sysItems });
    }
    if (custom.length) {
      groups.push({
        label: this.t('customFonts'),
        items: custom.map(f => ({ value: f.id, label: f.name, fontFamily: `'tizumark-custom-${f.id}'` })),
      });
    }
    for (const k of ['editor', 'preview', 'code']) {
      const p = this._fontPickers && this._fontPickers[k];
      if (!p) continue;
      p.setGroups(groups);
      p.setValue(this.settings[k + 'Font'] || '', true);
      this.updateFontPreview(k);
    }
  }

  // 每个字体选择器下方有独立预览：以所选字体渲染样例文本，并显示当前字体名
  updateFontPreview(k) {
    const wrap = document.getElementById('font-preview-' + k);
    if (!wrap) return;
    const val = this.settings[k + 'Font'] || '';
    const text = wrap.querySelector('.font-preview-text');
    const cap = document.getElementById('font-name-' + k);
    if (text) {
      const fam = this._fontFamilyFor(val);
      text.style.fontFamily = fam || (k === 'code' ? 'var(--font-mono)' : '');
    }
    if (cap) {
      cap.textContent = val ? this._fontDisplayName(val) : (this.t('defaultFont') || '');
    }
  }

  _fontDisplayName(val) {
    if (!val) return '';
    const f = (this.settings.customFonts || []).find(x => x.id === val);
    if (f) return f.name;
    // 系统字体：中文 UI 显示中文族名（如有映射），英文 UI 显示英文原名
    const isZh = this.settings.language !== 'en';
    return (isZh && FONT_NAME_LOCALE[val]) ? FONT_NAME_LOCALE[val] : val;
  }

  async applyThemeMode() {
    const mode = this.settings.themeMode;
    if (mode === 'light') {
      this.isDark = false;
    } else if (mode === 'dark') {
      this.isDark = true;
    } else {
      this.isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    document.documentElement.setAttribute('data-theme', this.isDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-color-scheme', this.settings.colorScheme || 'default');
    this.cm.setOption('theme', this.isDark ? 'material-darker' : 'default');
    this.updateThemeIcon();
    const highlightTheme = document.getElementById('highlight-theme');
    if (highlightTheme) {
      highlightTheme.href = this.isDark
        ? 'lib/highlight.js/github-dark.min.css'
        : 'lib/highlight.js/github.min.css';
    }
    await this.rerenderMermaid();
  }

  async rerenderMermaid() {
    if (typeof mermaid === 'undefined') return;
    // 主题切换：旧主题的 SVG 缓存失效，清空后让下次 updatePreview / 本函数按新主题重渲染
    this._mermaidCache.clear();
    const gen = ++this._mermaidGeneration;
    const containers = this.preview.querySelectorAll('.mermaid-container');
    if (containers.length === 0) return;

    // 保存代码并创建全新容器（避免复用旧容器的渲染状态）
    const containerData = [];
    containers.forEach(container => {
      const code = container.getAttribute('data-code') || container.textContent;
      const sourceLine = container.getAttribute('data-source-line');
      containerData.push({
        code,
        sourceLine,
        nextSibling: container.nextSibling,
        parent: container.parentNode,
      });
    });

    // 重建容器
    containerData.forEach((data, i) => {
      const newContainer = document.createElement('div');
      newContainer.className = 'mermaid-container';
      newContainer.id = 'mermaid-' + Date.now() + '-' + i;
      newContainer.setAttribute('data-code', data.code);
      if (data.sourceLine) newContainer.setAttribute('data-source-line', data.sourceLine);
      newContainer.textContent = data.code;
      if (data.nextSibling) {
        data.parent.insertBefore(newContainer, data.nextSibling);
      } else {
        data.parent.appendChild(newContainer);
      }
    });

    // 移除旧容器
    containers.forEach(c => c.remove());

    if (this._mermaidGeneration !== gen) return;

    try {
      mermaid.initialize({
        startOnLoad: false,
        theme: this.isDark ? 'dark' : 'default',
        securityLevel: 'loose',
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-preview').trim() || '-apple-system, sans-serif',
      });
      // 主题切换重渲染全部图表。一次性 mermaid.run(全部节点) 是同步 CPU 密集任务
      // （layout 计算），图表多时阻塞主线程造成明显卡顿（含转圈动画被卡住）。
      // 分批渲染：每批【渲染前】先让出主线程一帧（保证转圈持续转动、不被阻塞），
      // 图表较多时再叠加预览区 loading 提示。
      const nodes = Array.from(this.preview.querySelectorAll('.mermaid-container'));
      const BATCH = 2;
      const showLoading = nodes.length > 6;
      if (showLoading) this._beginPaneLoad();
      try {
        for (let i = 0; i < nodes.length; i += BATCH) {
          if (this._mermaidGeneration !== gen) return; // 中途又切主题，放弃本次
          // 每批渲染前让出主线程一帧：mermaid.run 是同步 CPU 密集，若首批立即执行，
          // 转圈动画帧会被阻塞（表现为"点完停顿一下才开始转"）
          await new Promise((r) => requestAnimationFrame(r));
          const batch = nodes.slice(i, i + BATCH);
          try {
            await mermaid.run({ nodes: batch });
          } catch (e) {
            console.error('Mermaid re-render error:', e);
          }
        }
      } finally {
        if (showLoading) this._endPaneLoad();
      }
    } catch (e) {
      console.error('Mermaid re-render error:', e);
    }
  }

  showSettings() {
    // 每次打开重置为默认居中尺寸（拖动/缩放状态不记忆，符合预期）
    const sd = document.getElementById('settings-dialog');
    const sp = sd ? sd.querySelector('.dialog') : null;
    if (sp && typeof window.resetDialog === 'function') window.resetDialog(sp);
    // 打开设置面板：备份当前设置快照。应用式：面板内改动只改内存与控件显示，
    // 点「应用/保存」才生效并落盘，未生效直接关闭（取消 / ×）时按快照恢复。
    this._settingsSnapshot = JSON.parse(JSON.stringify(this.settings));
    // 每次打开重置折叠状态：所有分类默认展开
    sd.querySelectorAll('.settings-section').forEach((sec) => sec.setAttribute('data-collapsed', 'false'));
    document.getElementById('settings-dialog').classList.remove('hidden');
  }

  hideSettings(revert = false) {
    // 先取走快照（防连点：恢复只执行一次，重复触发直接走关闭分支）
    const snapshot = revert ? this._settingsSnapshot : null;
    this._settingsSnapshot = null;
    if (snapshot) {
      // 未应用直接关闭：恢复内存设置与控件显示。
      // 面板内改动从不实时触碰编辑器/预览，无需 applySettings / 重渲染，瞬间完成。
      this.settings = JSON.parse(JSON.stringify(snapshot));
      this.syncSettingsControls();
      this.renderCustomFontSettings();
      this.updateImageAssetPathHint();
    }
    document.getElementById('settings-dialog').classList.add('hidden');
  }

  // 「应用」：把面板内改动生效（applySettings）并落盘，面板保持打开（可连续调整）；
  // 「保存」= applyPendingSettings + 关闭面板。
  // 「应用」/「保存」统一入口：生效 + 落盘 + 快照推进。
  async applyPendingSettings() {
    await this.applySettings();
    this.applyLanguage();       // 语言/界面文本生效
    this.applyWindowBehavior(); // 托盘显隐生效
    this.saveSettings();        // 应用 = 落盘
    // 应用即确认：快照推进到当前值，之后「取消」回滚到最近一次应用/保存的状态
    this._settingsSnapshot = JSON.parse(JSON.stringify(this.settings));
  }

  // 「恢复默认」：仅把面板内设置项值重置为默认值（保留已导入的自定义字体），
  // 不立即生效、不落盘。改动写进 this.settings（面板当前态），由「应用 / 保存」统一生效落盘；
  // 直接点「取消 / ×」则按 _settingsSnapshot 回滚，恢复默认也变成可撤销的未生效改动。
  resetSettings() {
    const defaults = this.defaultSettings();
    const savedCustomFonts = this.settings.customFonts || [];
    this.settings = { ...defaults, customFonts: savedCustomFonts };
    this.syncSettingsControls();
    this.renderCustomFontSettings();
    this.updateImageAssetPathHint();
  }

  updateImageAssetPathHint() {
    const mode = this.settings.imageAssetPathMode || 'relative';
    const hintEl = document.getElementById('setting-image-asset-path-hint-text');
    if (hintEl) {
      // 文案含 <code> 高亮片段，须用 innerHTML
      hintEl.innerHTML = mode === 'relative'
        ? this.t('imageAssetPathRelativeHint')
        : this.t('imageAssetPathAbsoluteHint');
    }
  }

  getImageAssetPath() {
    const mode = this.settings.imageAssetPathMode || 'relative';
    const path = this.settings.imageAssetPath || 'assets';
    if (mode === 'absolute') {
      return { assetsDir: path, refPrefix: path };
    }
    const tab = this.activeTab;
    const sep = tab && tab.filePath ? (tab.filePath.includes('/') ? '/' : '\\') : '/';
    const dir = tab && tab.filePath ? tab.filePath.substring(0, tab.filePath.lastIndexOf(sep)) : '';
    const assetsDir = dir ? dir + sep + path : path;
    return { assetsDir, refPrefix: path };
  }

  getDefaultShortcuts() {
    return {
      newFile: { key: 'Ctrl+N', label: '新建' },
      openFile: { key: 'Ctrl+O', label: '打开' },
      saveFile: { key: 'Ctrl+S', label: '保存' },
      closeTab: { key: 'Ctrl+W', label: '关闭标签页' },
      find: { key: 'Ctrl+F', label: '查找替换' },
      nextTab: { key: 'Ctrl+Tab', label: '下一个标签页' },
      prevTab: { key: 'Ctrl+Shift+Tab', label: '上一个标签页' },
      bold: { key: 'Ctrl+B', label: '加粗' },
      italic: { key: 'Ctrl+I', label: '斜体' },
      insertLink: { key: 'Ctrl+K', label: '插入链接' },
      exportPDF: { key: 'Ctrl+Shift+P', label: '导出 PDF' },
      inlineCode: { key: 'Ctrl+Shift+`', label: '行内代码' },
      strikethrough: { key: 'Ctrl+Shift+5', label: '删除线' },
      codeBlock: { key: 'Ctrl+Shift+K', label: '代码块' },
      blockquote: { key: 'Ctrl+Shift+Q', label: '引用块' },
      toggleView: { key: 'Ctrl+\\', label: '切换视图' },
      toggleSidebar: { key: '', label: '切换侧边栏' },
      toggleTheme: { key: 'Ctrl+Shift+T', label: '切换主题' },
      saveAs: { key: '', label: '另存为' },
      crossSearch: { key: 'Ctrl+H', label: '跨文件搜索' },
      insertTable: { key: '', label: '插入表格' },
      insertImage: { key: 'Ctrl+Shift+I', label: '插入图片' },
      insertUl: { key: '', label: '无序列表' },
      insertOl: { key: '', label: '有序列表' },
      insertTask: { key: '', label: '任务列表' },
      insertHr: { key: '', label: '水平线' },
      highlight: { key: '', label: '高亮标记' },
      insertSuperscript: { key: '', label: '上标' },
      insertSubscript: { key: '', label: '下标' },
      insertH1: { key: 'Ctrl+1', label: '标题1' },
      insertH2: { key: 'Ctrl+2', label: '标题2' },
      insertH3: { key: 'Ctrl+3', label: '标题3' },
      insertH4: { key: 'Ctrl+4', label: '标题4' },
      insertH5: { key: 'Ctrl+5', label: '标题5' },
      insertH6: { key: 'Ctrl+6', label: '标题6' },
      insertMathBlock: { key: 'Ctrl+Shift+M', label: '数学公式' },
      insertMermaid: { key: '', label: 'Mermaid 图表' },
      insertToc: { key: '', label: '目录' },
      insertCalloutNote: { key: '', label: 'Note 提示' },
      insertCalloutTip: { key: '', label: 'Tip 建议' },
      insertCalloutWarning: { key: '', label: 'Warning 警告' },
      insertCalloutCaution: { key: '', label: 'Caution 注意' },
      insertCalloutImportant: { key: '', label: 'Important 重要' },
      closeToTray: { key: '', label: '关闭到托盘' },
      // 文件树/编辑器增强（合并自 PR #36）：文件搜索为 VS Code 风格 Ctrl+P，
      // 原 Ctrl+P 的「导出 PDF」迁到 Ctrl+Shift+P（见 loadShortcuts 迁移逻辑）。
      fileSearch: { key: 'Ctrl+P', label: '文件搜索' },
      moveLineUp: { key: 'Alt+Up', label: '上移行/选区' },
      moveLineDown: { key: 'Alt+Down', label: '下移行/选区' },
      // Eclipse/VS Code 风格：在当前行下方/上方插入空行，光标移到新行行首，不截断当前行、不继承缩进
      insertLineBelow: { key: 'Ctrl+Enter', label: '在下方插入行' },
      insertLineAbove: { key: 'Ctrl+Shift+Enter', label: '在上方插入行' },
      // 表格编辑增强（用户反馈）：Enter 已在表格内自动整理；加行/加列默认无键位，
      // 可在「自定义快捷键」中绑定（避免占用 Ctrl+F 等高频键）。
      addTableRow: { key: '', label: '表格插入行' },
      addTableColumn: { key: '', label: '表格插入列' },
    };
  }

  getShortcutPresets() {
    // 每个方案仅列出“有键”的 actionId；缺失项在 applyShortcutScheme 中回落为空串。
    // 方案内部键位已保证互不重复；空值用省略表示。
    return {
      vscode: {
        newFile:'Ctrl+N', openFile:'Ctrl+O', saveFile:'Ctrl+S', saveAs:'Ctrl+Shift+S',
        closeTab:'Ctrl+W', find:'Ctrl+F', crossSearch:'Ctrl+H',
        nextTab:'Ctrl+Tab', prevTab:'Ctrl+Shift+Tab',
        bold:'', italic:'Ctrl+I', inlineCode:'Ctrl+`', insertLink:'Ctrl+K',
        insertMathBlock:'Ctrl+Shift+M', toggleTheme:'Ctrl+Shift+T', fileSearch:'Ctrl+P',
        // VS Code 特色绑定（合并自 PR #36）：Ctrl+B 切换侧边栏（与 bold 冲突，bold 留空可自定义）；
        // Ctrl+P 为文件搜索（VS Code Quick Open），原「导出 PDF」迁到 Ctrl+Shift+P（见 default 方案）。
        toggleSidebar:'Ctrl+B',
        insertLineBelow:'Ctrl+Enter', insertLineAbove:'Ctrl+Shift+Enter',
      },
      typora: {
        newFile:'Ctrl+N', openFile:'Ctrl+O', saveFile:'Ctrl+S', closeTab:'Ctrl+W',
        find:'Ctrl+F', crossSearch:'Ctrl+H',
        nextTab:'Ctrl+Tab', prevTab:'Ctrl+Shift+Tab',
        bold:'Ctrl+B', italic:'Ctrl+I', insertLink:'Ctrl+K', exportPDF:'Ctrl+P', fileSearch:'',
        inlineCode:'Ctrl+Shift+`', strikethrough:'Ctrl+Shift+5', codeBlock:'Ctrl+Shift+K',
        blockquote:'Ctrl+Shift+Q', toggleTheme:'Ctrl+Shift+T',
        insertImage:'Ctrl+Shift+I', insertMathBlock:'Ctrl+Shift+M',
        insertH1:'Ctrl+1', insertH2:'Ctrl+2', insertH3:'Ctrl+3', insertH4:'Ctrl+4',
        insertH5:'Ctrl+5', insertH6:'Ctrl+6',
        insertLineBelow:'Ctrl+Enter', insertLineAbove:'Ctrl+Shift+Enter',
      },
      sublime: {
        newFile:'Ctrl+N', openFile:'Ctrl+O', saveFile:'Ctrl+S', saveAs:'Ctrl+Shift+S',
        closeTab:'Ctrl+W', find:'Ctrl+F', crossSearch:'Ctrl+H',
        nextTab:'Ctrl+Tab', prevTab:'Ctrl+Shift+Tab',
        exportPDF:'Ctrl+P', toggleTheme:'Ctrl+Shift+T', fileSearch:'',
        insertLineBelow:'Ctrl+Enter', insertLineAbove:'Ctrl+Shift+Enter',
      },
    };
  }

  // 预览方案：把预置键位加载到 this.shortcuts 并渲染列表（供用户「随意切换」查看），
  // 不持久化、不应用 CM（编辑器实际键位不变）；点快捷键对话框「确认」按钮才正式生效。
  previewShortcutScheme(name) {
    if (name === 'custom') {
      // 自定义方案：预览已保存/编辑中的自定义键位（不含其他方案的临时预览值）
      this.shortcuts = this.loadShortcuts();
      this.shortcutScheme = 'custom';
      this.renderShortcutsList();
      return;
    }
    const defaults = this.getDefaultShortcuts();
    let next;
    if (name === 'default') {
      next = JSON.parse(JSON.stringify(defaults)); // 整体恢复默认键位
    } else {
      const preset = this.getShortcutPresets()[name];
      if (!preset) return;
      next = {};
      for (const [aid, def] of Object.entries(defaults)) {
        const k = preset[aid];
        next[aid] = { key: (k != null ? k : ''), label: def.label };
      }
    }
    this.shortcuts = next;
    this.shortcutScheme = name;
    this.renderShortcutsList();
  }

  applyShortcutScheme(name) {
    if (name === 'custom') {
      this.shortcutScheme = 'custom';
      this.saveShortcutScheme('custom');
      return;
    }
    const defaults = this.getDefaultShortcuts();
    let next;
    if (name === 'default') {
      next = JSON.parse(JSON.stringify(defaults)); // 整体恢复默认键位
    } else {
      const preset = this.getShortcutPresets()[name];
      if (!preset) return;
      next = {};
      for (const [aid, def] of Object.entries(defaults)) {
        const k = preset[aid];
        next[aid] = { key: (k != null ? k : ''), label: def.label };
      }
    }
    this.shortcuts = next;
    this.shortcutScheme = name;
    this.saveShortcuts();
    this.saveShortcutScheme(name);
    this.renderShortcutsList();
    this.applyShortcuts();
  }

  // 归一化单条快捷键：兼容旧版字符串格式、补齐缺失字段、损坏 key 回落默认，
  // 自愈 localStorage 中残留的旧/损坏数据，确保加粗等键位不会因数据格式变更而丢失。
  _normalizeShortcutEntry(raw, def) {
    const dKey = def && def.key ? def.key : '';
    const dLabel = def && def.label ? def.label : '';
    if (raw == null) return { key: dKey, label: dLabel };
    // 旧版曾把 bold 等存成字符串（"Ctrl+B"）而非 {key,label} 对象
    if (typeof raw === 'string') {
      const k = raw.trim();
      return { key: k, label: dLabel };
    }
    if (typeof raw === 'object') {
      let key = (typeof raw.key === 'string') ? raw.key.trim() : '';
      if (key === '') key = dKey; // 旧数据 key 缺失/损坏 → 回落默认键（自愈）
      const label = (typeof raw.label === 'string' && raw.label.trim()) ? raw.label.trim() : dLabel;
      return { key, label };
    }
    return { key: dKey, label: dLabel };
  }

  // 以 defaults 为基准逐项归一化 saved：未知项丢弃、缺失项落默认、字符串/损坏项自愈。
  _normalizeShortcuts(saved, defaults) {
    const out = {};
    for (const [aid, def] of Object.entries(defaults)) {
      out[aid] = this._normalizeShortcutEntry(saved ? saved[aid] : undefined, def);
    }
    return out;
  }

  loadShortcuts() {
    const defaults = this.getDefaultShortcuts();
    try {
      const parsed = JSON.parse(localStorage.getItem('tizumark-shortcuts'));
      const saved = this._validConfigObject(parsed);
      const merged = this._normalizeShortcuts(saved, defaults);
      // 迁移：crossSearch 受输入法/保留键拦截的键位，统一迁到 Ctrl+H（不受输入法拦截）。
      // 此前中间版本用过 Ctrl+Shift+F / Ctrl+Shift+L，也一并迁移到 Ctrl+H。
      if (merged.crossSearch && (merged.crossSearch.key === 'Ctrl+Shift+F' || merged.crossSearch.key === 'Ctrl+Shift+L')) {
        merged.crossSearch = { ...merged.crossSearch, key: 'Ctrl+H' };
      }
      // 迁移：findReplace / previewFind 不再作为独立快捷键项（与 find 是同一功能），清理残留。
      if (merged.findReplace) delete merged.findReplace;
      if (merged.previewFind) delete merged.previewFind;
      // 迁移：fileSearch 现占用 Ctrl+P（VS Code Quick Open 风格），若用户旧配置仍把
      // exportPDF 绑在 Ctrl+P（旧默认），将 exportPDF 迁到 Ctrl+Shift+P，避免二者冲突。
      if (merged.fileSearch && merged.fileSearch.key === 'Ctrl+P' && merged.exportPDF && merged.exportPDF.key === 'Ctrl+P') {
        merged.exportPDF = { ...merged.exportPDF, key: 'Ctrl+Shift+P' };
      }
      return merged;
    } catch {
      return defaults;
    }
  }

  saveShortcuts() {
    try { localStorage.setItem('tizumark-shortcuts', JSON.stringify(this.shortcuts)); } catch {}
  }

  loadShortcutScheme() {
    const VALID = ['default', 'vscode', 'typora', 'sublime', 'custom'];
    const stored = localStorage.getItem('tizumark-shortcut-scheme');
    if (stored && VALID.includes(stored)) return stored; // 白名单校验，防脏数据
    // 旧数据无 scheme：与默认逐项比对，有差异视为自定义（保留用户旧自定义数据）
    const def = this.getDefaultShortcuts();
    const cur = this.shortcuts || def;
    for (const [aid, d] of Object.entries(def)) {
      if ((cur[aid] && cur[aid].key || '') !== (d.key || '')) return 'custom';
    }
    return 'default';
  }

  saveShortcutScheme(name) {
    try { localStorage.setItem('tizumark-shortcut-scheme', name); } catch {}
  }

  _markShortcutCustom() {
    if (this.shortcutScheme !== 'custom') {
      this.shortcutScheme = 'custom';
      this.saveShortcutScheme('custom');
    }
  }

  clearShortcut(action) {
    // 仅更新面板内编辑草稿（内存），不落盘、不应用；点「确认」才生效
    this.shortcuts[action].key = '';
    if (this.shortcutScheme !== 'custom') this.shortcutScheme = 'custom';
    this.renderShortcutsList();
  }

  resetShortcuts() {
    // 仅把面板内各选项值重置为默认（内存草稿预览），不落盘、不立即应用到 CM。
    // 必须点「确认」按钮才正式生效；未确认关闭面板后，重开仍读 localStorage 旧值。
    this.shortcuts = this.getDefaultShortcuts();
    this.shortcutScheme = 'default';
    this.renderShortcutsList();
    this.setStatus(this.t('shortcutsReset'));
  }

  formatShortcutDisplay(key) {
    if (!key) return `<span class="shortcut-key shortcut-key-empty">${this.t('none')}</span>`;
    // 方向键 / 功能键映射为更直观的符号，键位显示更紧凑美观
    const SYM = {
      ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
      Home: 'Home', End: 'End', Backspace: '⌫', Delete: '⌦',
      Enter: '↵', Space: 'Space', Escape: 'Esc', Tab: 'Tab',
    };
    const inner = key.split('+').map(k => `<kbd>${SYM[k] || k}</kbd>`).join('<span class="key-separator">+</span>');
    return `<span class="shortcut-key">${inner}</span>`;
  }

  // 系统内置、固定不可由用户改写的快捷键（附通俗解释）。
  // 结构化数据（含 combo/group/name/desc）不便塞进「值为字符串」的 i18n 字典，
  // 故在此按语言返回，combo 用录制规范格式（与 handleShortcutRecording 产出一致），
  // 便于冲突校验直接比对；group 用于在内置区内再细分（nav=光标与选区 / edit=编辑通用）。
  getBuiltinFixedShortcuts() {
    const ZH = [
      { combo: 'Ctrl+Home', group: 'nav', name: '跳到开头', desc: '把光标移到整篇文档的最前面' },
      { combo: 'Ctrl+End', group: 'nav', name: '跳到结尾', desc: '把光标移到整篇文档的最后面' },
      { combo: 'Shift+Ctrl+Home', group: 'nav', name: '选到开头', desc: '从光标位置一路选中到文档开头' },
      { combo: 'Shift+Ctrl+End', group: 'nav', name: '选到结尾', desc: '从光标位置一路选中到文档结尾' },
      { combo: 'Ctrl+ArrowLeft', group: 'nav', name: '按词左移', desc: '光标向左跳过一个完整的词' },
      { combo: 'Ctrl+ArrowRight', group: 'nav', name: '按词右移', desc: '光标向右跳过一个完整的词' },
      { combo: 'Shift+Ctrl+ArrowLeft', group: 'nav', name: '向左选词', desc: '按住 Shift，再向左按词选中文本' },
      { combo: 'Shift+Ctrl+ArrowRight', group: 'nav', name: '向右选词', desc: '按住 Shift，再向右按词选中文本' },
      { combo: 'Ctrl+Z', group: 'edit', name: '撤销', desc: '撤销上一步操作' },
      { combo: 'Ctrl+Y', group: 'edit', name: '重做', desc: '恢复刚刚被撤销的操作' },
      { combo: 'Ctrl+A', group: 'edit', name: '全选', desc: '选中编辑器里的全部内容' },
      { combo: 'Ctrl+C', group: 'edit', name: '复制', desc: '把选中的文本复制到剪贴板' },
      { combo: 'Ctrl+X', group: 'edit', name: '剪切', desc: '把选中的文本剪切到剪贴板' },
      { combo: 'Ctrl+V', group: 'edit', name: '粘贴', desc: '在光标处粘贴剪贴板内容' },
      { combo: 'Tab', group: 'edit', name: '增加缩进', desc: '为当前行或选中的多行增加一级缩进' },
      { combo: 'Shift+Tab', group: 'edit', name: '减少缩进', desc: '为当前行或选中的多行减少一级缩进' },
    ];
    const EN = [
      { combo: 'Ctrl+Home', group: 'nav', name: 'Go to start', desc: 'Move the cursor to the very beginning of the document' },
      { combo: 'Ctrl+End', group: 'nav', name: 'Go to end', desc: 'Move the cursor to the very end of the document' },
      { combo: 'Shift+Ctrl+Home', group: 'nav', name: 'Select to start', desc: 'Select from the cursor all the way to the document start' },
      { combo: 'Shift+Ctrl+End', group: 'nav', name: 'Select to end', desc: 'Select from the cursor all the way to the document end' },
      { combo: 'Ctrl+ArrowLeft', group: 'nav', name: 'Word left', desc: 'Move the cursor left by one whole word' },
      { combo: 'Ctrl+ArrowRight', group: 'nav', name: 'Word right', desc: 'Move the cursor right by one whole word' },
      { combo: 'Shift+Ctrl+ArrowLeft', group: 'nav', name: 'Select word left', desc: 'Hold Shift to select words to the left' },
      { combo: 'Shift+Ctrl+ArrowRight', group: 'nav', name: 'Select word right', desc: 'Hold Shift to select words to the right' },
      { combo: 'Ctrl+Z', group: 'edit', name: 'Undo', desc: 'Undo the last action' },
      { combo: 'Ctrl+Y', group: 'edit', name: 'Redo', desc: 'Redo the last undone action' },
      { combo: 'Ctrl+A', group: 'edit', name: 'Select all', desc: 'Select everything in the editor' },
      { combo: 'Ctrl+C', group: 'edit', name: 'Copy', desc: 'Copy the selected text to the clipboard' },
      { combo: 'Ctrl+X', group: 'edit', name: 'Cut', desc: 'Cut the selected text to the clipboard' },
      { combo: 'Ctrl+V', group: 'edit', name: 'Paste', desc: 'Paste clipboard content at the cursor' },
      { combo: 'Tab', group: 'edit', name: 'Indent', desc: 'Add one level of indent to the line or selection' },
      { combo: 'Shift+Tab', group: 'edit', name: 'Outdent', desc: 'Remove one level of indent from the line or selection' },
    ];
    const lang = (this.settings && this.settings.language) || 'zh';
    return lang === 'en' ? EN : ZH;
  }

  // 把任意来源的键位字符串规范化为「小写修饰键 + 小写主键」的规范串，
  // 用于冲突比对（不区分 Ctrl/Control、修饰键顺序、字母大小写）。
  _normalizeShortcutKey(key) {
    if (!key) return '';
    const mods = [];
    let main = '';
    for (const p of key.split('+')) {
      const up = p.trim().toLowerCase();
      if (up === 'ctrl' || up === 'control') mods.push('ctrl');
      else if (up === 'shift') mods.push('shift');
      else if (up === 'alt') mods.push('alt');
      else if (up === 'meta' || up === 'cmd') mods.push('meta');
      else main = up;
    }
    return [...mods.sort(), main].join('+');
  }

  // 查询某键位是否已被某个「内置固定快捷键」占用，命中返回该条目，否则 null。
  findBuiltinShortcut(key) {
    if (!key) return null;
    const norm = this._normalizeShortcutKey(key);
    for (const item of this.getBuiltinFixedShortcuts()) {
      if (this._normalizeShortcutKey(item.combo) === norm) return item;
    }
    return null;
  }

  updateShortcutHints() {
    const s = this.shortcuts;
    const map = {
      'insert-bold': 'bold',
      'insert-italic': 'italic',
      'insert-strikethrough': 'strikethrough',
      'insert-inline-code': 'inlineCode',
      'insert-highlight': 'highlight',
      'insert-code-block': 'codeBlock',
      'insert-table': 'insertTable',
      'insert-quote': 'blockquote',
      'insert-hr': 'insertHr',
      'insert-ul': 'insertUl',
      'insert-ol': 'insertOl',
      'insert-task': 'insertTask',
      'insert-link': 'insertLink',
      'insert-image': 'insertImage',
      // find-replace / preview-find 菜单项与 find 是同一功能（toggleFindPanel），
      // 提示统一显示 find 的键位
      'find-replace': 'find',
      'preview-find': 'find',
      'insert-superscript': 'insertSuperscript',
      'insert-subscript': 'insertSubscript',
      'insert-h1': 'insertH1',
      'insert-h2': 'insertH2',
      'insert-h3': 'insertH3',
      'insert-h4': 'insertH4',
      'insert-h5': 'insertH5',
      'insert-h6': 'insertH6',
      'insert-math-block': 'insertMathBlock',
      'insert-mermaid': 'insertMermaid',
      'insert-toc': 'insertToc',
      'insert-callout-note': 'insertCalloutNote',
      'insert-callout-tip': 'insertCalloutTip',
      'insert-callout-warning': 'insertCalloutWarning',
      'insert-callout-caution': 'insertCalloutCaution',
      'insert-callout-important': 'insertCalloutImportant',
    };
    const idMap = {
      'btn-new': 'newFile',
      'btn-open': 'openFile',
      'btn-save': 'saveFile',
      'btn-save-as': 'saveAs',
      'btn-export-pdf': 'exportPDF',
    };
    for (const [action, id] of Object.entries(map)) {
      const els = document.querySelectorAll(`[data-action="${action}"] .shortcut`);
      const key = s[id]?.key;
      for (const el of els) {
        el.textContent = key || '';
      }
    }
    for (const [elId, id] of Object.entries(idMap)) {
      const el = document.getElementById(elId);
      if (!el) continue;
      const span = el.querySelector('.shortcut');
      if (!span) continue;
      span.textContent = s[id]?.key || '';
    }
  }

  renderShortcutsList() {
    const container = document.getElementById('shortcuts-list');
    const labels = this.t('shortcutLabel');
    const groupLabels = this.t('shortcutGroup') || {};
    // 按功能分组展示，便于在长列表中查找
    const groups = [
      { key: 'file', ids: ['newFile', 'openFile', 'saveFile', 'saveAs', 'closeTab', 'exportPDF', 'closeToTray'] },
      { key: 'search', ids: ['find', 'crossSearch', 'fileSearch'] },
      { key: 'tabView', ids: ['nextTab', 'prevTab', 'toggleView', 'toggleSidebar', 'toggleTheme'] },
      { key: 'format', ids: ['bold', 'italic', 'strikethrough', 'inlineCode', 'highlight', 'insertSuperscript', 'insertSubscript', 'moveLineUp', 'moveLineDown', 'insertLineBelow', 'insertLineAbove'] },
      { key: 'insert', ids: ['insertLink', 'insertImage', 'insertTable', 'addTableRow', 'addTableColumn', 'insertUl', 'insertOl', 'insertTask', 'insertHr', 'codeBlock', 'blockquote', 'insertMathBlock', 'insertMermaid', 'insertToc'] },
      { key: 'heading', ids: ['insertH1', 'insertH2', 'insertH3', 'insertH4', 'insertH5', 'insertH6'] },
      { key: 'callout', ids: ['insertCalloutNote', 'insertCalloutTip', 'insertCalloutWarning', 'insertCalloutCaution', 'insertCalloutImportant'] },
    ];

    // 折叠状态在对话框会话内保持（重渲染不丢失用户的展开/收起选择）。
    // 内置区默认收缩（内容多、且不可改），放在顶部；方案与自定义默认展开。
    if (!this._sectionCollapsed) this._sectionCollapsed = { builtin: false, config: false };

    // —— 可配置区（方案与自定义）：保留原有按功能分组 + 录制/清除按钮 ——
    const configGroupsHtml = groups.map(group => {
      const rows = group.ids
        .filter(id => this.shortcuts[id])
        .map(id => {
          const shortcut = this.shortcuts[id];
          const isRecording = this.recordingAction === id;
          const label = labels[id] || shortcut.label || id;
          return `
        <div class="shortcut-row" data-action="${id}">
          <span class="shortcut-label">${label}</span>
            <div class="shortcut-actions">
              ${this.formatShortcutDisplay(shortcut.key)}
              <button class="shortcut-record-btn${isRecording ? ' recording' : ''}" data-action="${id}">${isRecording ? this.t('pressKeys') : this.t('modify')}</button>
              <button class="shortcut-clear-btn" data-action="${id}">${this.t('clear')}</button>
            </div>
        </div>`;
        }).join('');
      if (!rows) return '';
      return `
        <div class="shortcut-group">
          <div class="shortcut-group-title">${groupLabels[group.key] || group.key}</div>
          ${rows}
        </div>`;
    }).join('');

    // —— 内置固定区：不可改，紧凑两列表格（快捷键 | 名称+说明）——
    const builtin = this.getBuiltinFixedShortcuts();
    const builtinTable = (grp, title) => {
      const rows = builtin.filter(b => b.group === grp);
      if (!rows.length) return '';
      const body = rows.map(b => `
          <tr class="shortcut-builtin-row">
            <td class="shortcut-builtin-key">${this.formatShortcutDisplay(b.combo)}</td>
            <td class="shortcut-builtin-meta">
              <span class="shortcut-label">${b.name}</span>
              <span class="shortcut-builtin-desc">${b.desc}</span>
            </td>
          </tr>`).join('');
      return `
        <div class="shortcut-group">
          <div class="shortcut-group-title">${title}</div>
          <table class="shortcut-builtin-table">
            <tbody>${body}</tbody>
          </table>
        </div>`;
    };

    const builtinHtml =
      builtinTable('nav', this.t('builtinNavGroup')) +
      builtinTable('edit', this.t('builtinEditGroup'));

    const caretHtml = '<svg class="collapse-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
    // 分类标题左侧图标：与文件/大纲面板头的 panel-title-icon 同一类名，保持视觉统一
    const ICON_KEYBOARD = '<svg class="panel-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 8h.01" /><path d="M12 12h.01" /><path d="M14 8h.01" /><path d="M16 12h.01" /><path d="M18 8h.01" /><path d="M6 8h.01" /><path d="M7 16h10" /><path d="M8 12h.01" /><rect width="20" height="16" x="2" y="4" rx="2" /></svg>';
    const ICON_SLIDERS = '<svg class="panel-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 8h4" /><path d="M12 21v-9" /><path d="M12 8V3" /><path d="M17 16h4" /><path d="M19 12V3" /><path d="M19 21v-5" /><path d="M3 14h4" /><path d="M5 10V3" /><path d="M5 21v-7" /></svg>';
    const sectionHtml = (key, title, icon, body) => `
      <div class="shortcut-section" data-collapsed="${this._sectionCollapsed[key] ? 'true' : 'false'}">
        <div class="shortcut-section-title" data-toggle="${key}">
          ${icon}
          <span class="shortcut-section-name">${title}</span>
          ${caretHtml}
        </div>
        <div class="shortcut-section-body">${body}</div>
      </div>`;

    // 方案下拉归位到「方案与自定义」分类顶部：方案切换预设键位，下方再列可改项。
    const schemeBlockHtml = `
      <div class="scheme-block">
        <div class="scheme-block-head">
          <span class="scheme-block-label">${this.t('shortcutScheme')}</span>
          <span class="scheme-block-hint">${this.t('schemeHint')}</span>
        </div>
        <div id="shortcuts-scheme-host" class="scheme-select-host"></div>
      </div>`;

    container.innerHTML =
      sectionHtml('builtin', this.t('builtinShortcutsTitle'), ICON_KEYBOARD, builtinHtml) +
      sectionHtml('config', this.t('configurableShortcutsTitle'), ICON_SLIDERS, schemeBlockHtml + configGroupsHtml);

    // 把方案 Select 的宿主节点移入当前渲染出的占位容器（每次 innerHTML 重建后需重新挂接）。
    if (this._schemeSelect) this._schemeSelect.setValue(this.shortcutScheme || 'default', true);
    const schemePlaceholder = container.querySelector('#shortcuts-scheme-host');
    if (schemePlaceholder && this._schemeHost && this._schemeHost.parentElement !== schemePlaceholder) {
      schemePlaceholder.appendChild(this._schemeHost);
    }

    // 折叠/展开：由全局事件委托统一处理（bindCollapseToggle），
    // 每次 innerHTML 重建后新节点自动生效，无需逐节点绑定。

    container.querySelectorAll('.shortcut-record-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        this.startRecording(action);
      });
    });

    container.querySelectorAll('.shortcut-clear-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        this.clearShortcut(action);
      });
    });
  }

  startRecording(action) {
    this.recordingAction = action;
    this.renderShortcutsList();
  }

  handleShortcutRecording(e) {
    if (!this.recordingAction) return false;

    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      this.recordingAction = null;
      this.renderShortcutsList();
      return true;
    }

    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return true;

    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);

    const keyStr = parts.join('+');
    const dup = this.findDuplicateShortcut(keyStr, this.recordingAction);
    if (dup) {
      this.showToast(this.t('shortcutOccupied', { key: keyStr, name: this.t('shortcutLabel')[dup] || dup }));
      this.recordingAction = null;
      this.renderShortcutsList();
      return true;
    }
    // 不与「内置固定快捷键」冲突：内置键由编辑器内核占用，用户不可改写，
    // 否则录制成功却不生效，反而造成困惑。冲突即拦截并提示。
    const builtin = this.findBuiltinShortcut(keyStr);
    if (builtin) {
      this.showToast(this.t('shortcutBuiltinOccupied', { key: keyStr, name: builtin.name }));
      this.recordingAction = null;
      this.renderShortcutsList();
      return true;
    }
    this.shortcuts[this.recordingAction].key = keyStr;
    this.recordingAction = null;
    // 仅更新面板内的编辑草稿（内存 this.shortcuts），不落盘、不应用到 CM/全局派发。
    // 必须点「确认」按钮（shortcuts-save-btn）才正式 saveShortcuts + applyShortcuts 生效。
    if (this.shortcutScheme !== 'custom') this.shortcutScheme = 'custom'; // 内存预览标记，不落盘
    this.renderShortcutsList();
    return true;
  }

  findDuplicateShortcut(key, excludeAction) {
    if (!key) return null;
    for (const [action, config] of Object.entries(this.shortcuts)) {
      if (action === excludeAction) continue;
      if (config.key === key) return action;
    }
    return null;
  }

  initShortcutsDialog() {
    document.getElementById('btn-shortcuts').addEventListener('click', () => {
      document.getElementById('file-menu').classList.add('hidden');
      this.showShortcutsDialog();
    });
    document.getElementById('shortcuts-close').addEventListener('click', () => this.hideShortcutsDialog());
    // 注：快捷键框不支持点击遮罩层关闭，只能通过「×」关闭（放弃改动），与设置框一致。
    document.getElementById('shortcuts-reset').addEventListener('click', () => this.resetShortcuts());
    document.getElementById('shortcuts-save-btn').addEventListener('click', async () => {
      // 与设置框「保存」行为一致：按钮进入 loading 态（文字「正在保存」+ spinner），
      // 完成后弹「保存成功」成功提示并关闭；顶部不再显示 loading toast。
      const saveBtn = document.getElementById('shortcuts-save-btn');
      saveBtn.classList.add('is-loading');
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="btn-spinner"></span>' + this.t('saving');
      await this._ensurePainted(); // 让 spinner 先绘制一帧，避免被同步重活推后导致看不到
      try {
        // 「确认」按钮：方案切换与按键编辑在此正式生效（切换下拉只预览不生效）
        const name = this._schemeSelect ? this._schemeSelect.getValue() : this.shortcutScheme;
        if (name === 'custom') {
          // 自定义：以当前编辑后的键位为准，持久化并应用到 CM
          this.shortcutScheme = 'custom';
          this.saveShortcuts();
          this.saveShortcutScheme('custom');
          this.applyShortcuts();
        } else {
          // 预置方案：加载键位 + 持久化 + 应用到 CM
          this.applyShortcutScheme(name);
        }
        await this._minDelay(300); // 保证 loading 至少可见 300ms，避免一闪而过
        this.showToast(this.t('savedSuccess'), 'success'); // 保存完成后弹成功提示
        this.hideShortcutsDialog();
      } finally {
        saveBtn.disabled = false;
        saveBtn.classList.remove('is-loading');
        saveBtn.textContent = this.t('save');
      }
    });

    // 快捷键方案下拉：自绘 Select 组件（替代原生 select，展开面板可主题化 + 完整 ARIA）。
    // 宿主用一个持久化的游离 div，渲染时再挂入「方案与自定义」分类内的占位容器，
    // 避免每次 renderShortcutsList 重写 innerHTML 时把 Select 实例的 DOM 冲掉。
    if (!this._schemeHost) {
      this._schemeHost = document.createElement('div');
      this._schemeHost.className = 'scheme-select-host';
    }
    this._schemeSelect = new Select(this._schemeHost, {
      value: this.shortcutScheme || 'default',
      t: this.t.bind(this),
      ariaLabelKey: 'shortcutScheme',
      optionsProvider: (t) => ([
        { value: 'default', label: t('schemeDefault') },
        { value: 'vscode', label: t('schemeVSCode') },
        { value: 'typora', label: t('schemeTypora') },
        { value: 'sublime', label: t('schemeSublime') },
        { value: 'custom', label: t('schemeCustom') },
      ]),
      // 随意切换：仅把键位加载到列表预览（不应用 CM、不持久化），点「保存」按钮才正式生效。
      // 历史实现：change 即弹 window.confirm 并立即生效，Tauri 下 confirm 依赖
      // dialog:allow-confirm 权限（缺失报 "dialog.confirm not allowed"），且交互不符直觉。
      onChange: (name) => { this.previewShortcutScheme(name); },
    });
    this.populateSchemeSelect();
  }

  // 折叠组件统一点击委托：设置面板 / 关于面板 / 快捷键面板 的折叠块标题
  // （.shortcut-section-title / .dependency-title / .settings-section-title）
  // 点击切换最近 [data-collapsed] 容器的展开/收起；快捷键面板额外同步 _sectionCollapsed 供重渲染保持。
  // 事件委托挂在 document，各面板 innerHTML 重建后无需逐节点重新绑定。
  bindCollapseToggle() {
    document.addEventListener('click', (e) => {
      const title = e.target.closest('.shortcut-section-title, .dependency-title, .settings-section-title');
      if (!title) return;
      const panel = title.closest('.shortcut-section, .dependency-details, .settings-section');
      if (!panel) return;
      const collapsed = panel.getAttribute('data-collapsed') === 'true';
      panel.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
      const sec = title.dataset.toggle;
      if (sec && this._sectionCollapsed && Object.prototype.hasOwnProperty.call(this._sectionCollapsed, sec)) {
        this._sectionCollapsed[sec] = !collapsed;
      }
    });
  }

  // 为所有弹框（任意 .dialog-overlay）统一接入拖动 + 缩放（dialog-drag-resize.js）。
  // 一套逻辑复用给全部弹框：标题栏拖动、右下角手柄缩放、双击标题栏还原默认尺寸。
  // 首次（任一弹框）拖动或缩放时给出一次性引导提示，告知可双击标题栏还原默认尺寸。
  initDialogsDragResize() {
    if (typeof window.initDialogDragResize !== 'function') return;
    const hinted = { value: false };
    const onFirstInteract = () => {
      if (hinted.value) return;
      hinted.value = true;
      this.showToast(this.t('dialogResizeHint'), 'info');
    };
    document.querySelectorAll('.dialog-overlay').forEach((el) => {
      if (el.querySelector('.dialog')) {
        window.initDialogDragResize(el, { minWidth: 360, minHeight: 260, onFirstInteract });
      }
    });
  }

  showShortcutsDialog() {
    // 每次打开重置为默认居中尺寸（拖动/缩放状态不记忆，符合预期）
    const kd = document.getElementById('shortcuts-dialog');
    const kp = kd ? kd.querySelector('.dialog') : null;
    if (kp && typeof window.resetDialog === 'function') window.resetDialog(kp);
    this.recordingAction = null;
    // 每次打开都从 localStorage 重新加载已保存键位 + 方案，作为编辑基线。
    // 这样「未点确认就关闭面板」留下的内存草稿不会残留，重开仍显示已保存值。
    this.shortcuts = this.loadShortcuts();
    this.shortcutScheme = this.loadShortcutScheme();
    // 每次打开重置折叠默认：内置固定区收缩、方案与自定义区展开。
    this._sectionCollapsed = { builtin: false, config: false };
    this.renderShortcutsList();
    this.populateSchemeSelect();
    document.getElementById('shortcuts-dialog').classList.remove('hidden');
  }

  populateSchemeSelect() {
    if (!this._schemeSelect) return;
    const opts = [
      { value: 'default', label: this.t('schemeDefault') },
      { value: 'vscode', label: this.t('schemeVSCode') },
      { value: 'typora', label: this.t('schemeTypora') },
      { value: 'sublime', label: this.t('schemeSublime') },
      { value: 'custom', label: this.t('schemeCustom') },
    ];
    this._schemeSelect.setOptions(opts);
    this._schemeSelect.setValue(this.shortcutScheme || 'default', true);
  }

  hideShortcutsDialog() {
    this.recordingAction = null;
    document.getElementById('shortcuts-dialog').classList.add('hidden');
  }

  applyShortcuts() {
    const s = this.shortcuts;
    const LIST_LINE_RE = /^(\s*)(?:>[> ]*|[*+-]\s\[[xX ]\]\s|[*+-]\s|\d+[.)]\s)/;
    this.cm.setOption('extraKeys', {
      'Enter': (cm) => this._handleTableEnter(cm),
      'Tab': (cm) => {
        if (cm.somethingSelected()) {
          cm.indentSelection('add');
          return;
        }
        // 列表/引用行无选区：缩进整行形成子级（支持多级列表层级调整）
        const lineText = cm.getLine(cm.getCursor().line);
        if (LIST_LINE_RE.test(lineText)) {
          cm.indentSelection('add');
          return;
        }
        cm.replaceSelection(' '.repeat(this.settings.tabSize), 'end');
      },
      'Shift-Tab': (cm) => cm.indentSelection('subtract'),
    });

    // 把 DOM 键名规范化为 CodeMirror 5 的 keyName（CM5 用 'Up'/'Down' 而非 'ArrowUp'，
    // 用 'Esc' 而非 'Escape'）。否则录 Alt+ArrowUp 注册成 'Alt-ArrowUp'，而 CM 查找
    // 'Alt-Up'，handler 永不触发（合并自 PR #36 的行移动功能配套修正）。
    const KEY_ALIAS = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', ' ': 'Space' };
    const toCmKey = (k) => {
      const parts = k.split('+');
      let key = parts.pop();
      key = KEY_ALIAS[key] || key;
      const order = { Shift: 0, Ctrl: 1, Alt: 2, Cmd: 3, Meta: 3 };
      parts.sort((a, b) => (order[a] ?? 99) - (order[b] ?? 99));
      return parts.concat([key]).join('-');
    };

    // Editor-only actions (work in CodeMirror extraKeys when editor is focused)
    const editorMap = {
      bold: () => this.wrapSelection('**', '**'),
      italic: () => this.wrapSelection('*', '*'),
      strikethrough: () => this.wrapSelection('~~', '~~'),
      inlineCode: () => this.wrapSelection('`', '`'),
      highlight: () => this.wrapSelection('==', '=='),
      codeBlock: () => this.insertBlock('```javascript\n// code here\n```', 14),
      blockquote: () => this.insertLinePrefix('> '),
      insertTable: () => this.insertBlock('| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |', 2),
      addTableRow: () => this._addTableRow(cm),
      addTableColumn: () => this._addTableColumn(cm),
      insertUl: () => this.insertLinePrefix('- '),
      insertOl: () => this.insertLinePrefix('1. ', true),
      insertTask: () => this.insertLinePrefix('- [ ] '),
      insertHr: () => this.insertBlock('---'),
      insertLink: () => this.showInsertLinkDialog(),
      insertImage: () => this.showInsertImageDialog(),
      insertSuperscript: () => this.executeMenuAction('insert-superscript'),
      insertSubscript: () => this.executeMenuAction('insert-subscript'),
      insertH1: () => this.executeMenuAction('insert-h1'),
      insertH2: () => this.executeMenuAction('insert-h2'),
      insertH3: () => this.executeMenuAction('insert-h3'),
      insertH4: () => this.executeMenuAction('insert-h4'),
      insertH5: () => this.executeMenuAction('insert-h5'),
      insertH6: () => this.executeMenuAction('insert-h6'),
      insertMathBlock: () => this.executeMenuAction('insert-math-block'),
      insertMermaid: () => this.executeMenuAction('insert-mermaid'),
      insertToc: () => this.executeMenuAction('insert-toc'),
      insertCalloutNote: () => this.executeMenuAction('insert-callout-note'),
      insertCalloutTip: () => this.executeMenuAction('insert-callout-tip'),
      insertCalloutWarning: () => this.executeMenuAction('insert-callout-warning'),
      insertCalloutCaution: () => this.executeMenuAction('insert-callout-caution'),
      insertCalloutImportant: () => this.executeMenuAction('insert-callout-important'),
      // 行/选区上下移动（合并自 PR #36）：CM5 核心无 moveLineUp/Down 命令，自实现 _moveLine。
      moveLineUp: () => this._moveLine(-1),
      moveLineDown: () => this._moveLine(1),
      // Eclipse/VS Code 风格：在当前行下方/上方插入空行，光标移到新行行首
      insertLineBelow: () => this.insertLineBelow(),
      insertLineAbove: () => this.insertLineAbove(),
    };

    // Global actions (work anywhere via document keydown handler)
    const globalMap = {
      saveFile: () => this.saveFile(),
      openFile: () => this.openFile(),
      newFile: () => this.newFile(),
      closeTab: () => this.closeTab(this.activeTabIndex),
      exportPDF: () => this.exportPDF(),
      saveAs: () => this.saveAsFile(),
      toggleView: () => this.toggleViewMode(),
      toggleSidebar: () => this.toggleSidebar(),
      toggleTheme: () => this.toggleTheme(),
      find: () => this.toggleFindPanel(),
      crossSearch: () => this.openCrossSearchDialog(),
      fileSearch: () => this.openFileSearchDialog(),
      nextTab: () => {
        const next = (this.activeTabIndex + 1) % this.tabs.length;
        this.switchTab(next);
      },
      closeToTray: () => this.hideToTray(),
      prevTab: () => {
        const prev = this.activeTabIndex > 0 ? this.activeTabIndex - 1 : this.tabs.length - 1;
        this.switchTab(prev);
      },
    };

    // Editor-local actions (bold/italic/insert-*, need the CM instance) are
    // registered as real handlers in extraKeys — they only apply when the
    // editor is focused, which is exactly what we want.
    const extraKeys = this.cm.getOption('extraKeys');
    for (const [action, fn] of Object.entries(editorMap)) {
      const key = s[action]?.key;
      if (key) extraKeys[toCmKey(key)] = fn;
    }
    // Global actions (save/find/crossSearch/nextTab/... ) are dispatched
    // centrally by the document-level keydown handler (works in ALL focus
    // states). Here we neutralize them in CM with `false` so CM's own default
    // keymap (e.g. search.js binds Shift-Ctrl-F→"replace", Ctrl-F→"find") can't
    // fire and there is no double-dispatch. CodeMirror does not stop propagation
    // for handled keys, so the event still reaches the document handler.
    for (const [action, fn] of Object.entries(globalMap)) {
      const key = s[action]?.key;
      if (key) extraKeys[toCmKey(key)] = false;
    }

    // 文档首/末导航（与常见编辑器一致：无 Shift=移动光标，带 Shift=从光标处选中）。
    // 这些键与 a/c/v/x/z/y 同逻辑：在全局捕获 keydown 监听里「放行」（不 preventDefault /
    // 不 stopPropagation），事件自然到达 CodeMirror，由下方 extraKeys handler 处理；
    // 这样 CM 的 onKeyDown 不会因 e.defaultPrevented 提前 return，handler 能正常执行。
    // 用自定义 handler 而非 CM 默认 goDocStart/goDocEnd，因为：CM 默认 Ctrl+End 落末行
    // 首列（我们要末行末列）；CM 默认 Ctrl+Home 反而「选中」（我们要移动）。
    // 注意：CM 的 extendSelection(head) 单参数等价 setCursor（移动、collapsed），并不会
    // 保留原锚点；真正的「从光标选中到目标」需用 setSelection(原光标, 目标)。
    extraKeys['Ctrl-Home']       = (cm) => cm.setCursor({ line: cm.firstLine(), ch: 0 });
    extraKeys['Ctrl-End']        = (cm) => cm.setCursor({ line: cm.lastLine(), ch: cm.getLine(cm.lastLine()).length });
    extraKeys['Shift-Ctrl-Home'] = (cm) => { const c = cm.getCursor(); cm.setSelection(c, { line: cm.firstLine(), ch: 0 }); };
    extraKeys['Shift-Ctrl-End']  = (cm) => { const c = cm.getCursor(); cm.setSelection(c, { line: cm.lastLine(), ch: cm.getLine(cm.lastLine()).length }); };

    // 按「词」移动 / 选择（方案 B：Intl.Segmenter 中文分词）。
    // 方向键与 Home/End 同逻辑：需在全局捕获 keydown 监听里「放行」（见下方放行名单），
    // 否则事件被 preventDefault 后 CM 收不到、custom handler 永不执行。
    // Shift 版本复用同一 handler：extendSelectionsBy 会按 display.shift 自动扩展选区。
    extraKeys['Ctrl-Left']        = (cm) => this._moveByWord(cm, -1, false);
    extraKeys['Ctrl-Right']       = (cm) => this._moveByWord(cm, 1, false);
    extraKeys['Shift-Ctrl-Left']  = (cm) => this._moveByWord(cm, -1, true);
    extraKeys['Shift-Ctrl-Right'] = (cm) => this._moveByWord(cm, 1, true);

    this.cm.setOption('extraKeys', extraKeys);

    // Build global shortcut lookup for document-level handling.
    // 全局动作（保存/查找等）在任何焦点下都派发；编辑器动作（加粗/标题等）包一层
    // 「编辑器聚焦才执行」的守卫，这样无论 CodeMirror 自身的 extraKeys 派发是否生效
    // （焦点/事件到达问题），都能通过全局捕获通道稳定触发，且不会在非编辑场景误触。
    // 命中即 stopPropagation（见 document keydown 监听），事件不再冒泡到 CM，不会重复执行。
    this.globalShortcutLookup = {};
    const registerGlobal = (action, fn, editorOnly) => {
      const key = s[action]?.key;
      if (!key) return;
      this.globalShortcutLookup[key] = editorOnly
        ? () => { if (this.cm && this.cm.hasFocus()) fn(); }
        : fn;
    };
    for (const [action, fn] of Object.entries(globalMap)) registerGlobal(action, fn, false);
    for (const [action, fn] of Object.entries(editorMap)) registerGlobal(action, fn, true);

    this.updateShortcutHints();
  }

  get activeTab() {
    return this.tabs[this.activeTabIndex];
  }

  // 上下移动当前行/选中行块（CM5 核心无 moveLineUp/Down 命令，自实现，合并自 PR #36）。
  // dir=-1：与上一行交换块（上移）；dir=+1：与下一行交换块（下移）。
  // 无选区移当前单行；有选区移选中范围内所有行；块到达文档边界时 no-op。
  // 选区/光标的 ch 与方向跟随整体平移，保持原有选择语义。
  _moveLine(dir) {
    const cm = this.cm;
    if (!cm) return;
    const sel = cm.listSelections()[0];
    if (!sel) return;
    const fromLine = Math.min(sel.anchor.line, sel.head.line);
    const toLine = Math.max(sel.anchor.line, sel.head.line);
    const last = cm.lastLine();
    if (dir < 0 && fromLine === 0) return;        // 已在第一行
    if (dir > 0 && toLine === last) return;       // 已在最后一行
    cm.operation(() => {
      // 取出待移动块（fromLine..toLine）的文本
      const block = [];
      for (let i = fromLine; i <= toLine; i++) block.push(cm.getLine(i));
      const blockText = block.join('\n');
      if (dir < 0) {
        // 上移：与上一行交换。替换为 block + '\n' + 上一行 → 块整体上移一行，原上一行落到块尾
        const aboveText = cm.getLine(fromLine - 1);
        cm.replaceRange(
          blockText + '\n' + aboveText,
          { line: fromLine - 1, ch: 0 },
          { line: toLine, ch: cm.getLine(toLine).length }
        );
        // 块新位置 fromLine-1..toLine-1：选区整体上移一行
        cm.setSelection(
          { line: sel.anchor.line - 1, ch: sel.anchor.ch },
          { line: sel.head.line - 1, ch: sel.head.ch }
        );
      } else {
        // 下移：与下一行交换。替换为 下一行 + '\n' + block → 块整体下移一行，原下一行升到块首
        const belowText = cm.getLine(toLine + 1);
        cm.replaceRange(
          belowText + '\n' + blockText,
          { line: fromLine, ch: 0 },
          { line: toLine + 1, ch: cm.getLine(toLine + 1).length }
        );
        // 块新位置 fromLine+1..toLine+1：选区整体下移一行
        cm.setSelection(
          { line: sel.anchor.line + 1, ch: sel.anchor.ch },
          { line: sel.head.line + 1, ch: sel.head.ch }
        );
      }
    });
  }

  // ---- Ctrl+方向键「按词移动 / 选择」 ----
  // 词边界分词器：优先用 Intl.Segmenter 做中文分词（地基/承载 等独立成词），
  // 环境不支持时降级为正则（连续 字母/数字/中文 视为一个词）。懒创建并缓存。
  _createWordSegmenter() {
    if (this._wordSegmenterCached) return this._wordSegmenterCached;
    let info = { type: 'regex' };
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      try {
        const seg = new Intl.Segmenter('zh', { granularity: 'word' });
        seg.segment('探测'); // 触发一次，确认可用
        info = { type: 'segmenter', seg };
      } catch (e) { /* 降级到 regex */ }
    }
    this._wordSegmenterCached = info;
    return info;
  }

  // 单行内从 ch 沿 dir 方向计算「词边界」目标（不含跨行）。
  // 返回 { ch, isEdgeWord }：ch 为目标列；isEdgeWord 表示该边界恰好处在行首/行尾
  // （词起点在行首 / 词尾在行尾），此时应视为有效停靠点而非继续跨行。
  // 语义对齐主流编辑器：向右先在词内跳到词尾、再跳下一词尾；向左跳到词头。
  // 标点 / 空格 / 公式符号等非 word-like 段被跳过，光标落在相邻词的边界。
  _wordBoundaryInLine(lineText, ch, dir, segInfo) {
    const words = [];
    if (segInfo.type === 'segmenter') {
      for (const s of segInfo.seg.segment(lineText)) {
        if (s.isWordLike) words.push([s.index, s.index + s.segment.length]);
      }
    } else {
      const re = /[\w一-鿿]+/g;
      let m;
      while ((m = re.exec(lineText)) !== null) words.push([m.index, m.index + m[0].length]);
    }
    const len = lineText.length;
    if (dir > 0) {
      // 向右：词内 → 当前词尾；否则第一个 start>=ch 的词尾
      for (const [s, e] of words) {
        if (ch >= s && ch < e) return { ch: e, isEdgeWord: e === len };
      }
      for (const [s, e] of words) {
        if (s >= ch) return { ch: e, isEdgeWord: e === len };
      }
      return { ch: len, isEdgeWord: false };
    }
    // 向左：词内/词尾 → 词头；否则最后一个 start<ch 的词头
    for (const [s, e] of words) {
      if (ch > s && ch <= e) return { ch: s, isEdgeWord: s === 0 };
    }
    let target = null;
    for (const [s] of words) {
      if (s < ch) target = s; else break;
    }
    return { ch: target != null ? target : 0, isEdgeWord: target != null && target === 0 };
  }

  // Ctrl+←/→ 按词移动；Ctrl+Shift+←/→ 选择词。
  // extend=true 时临时置 doc.extend，强制 extendSelectionsBy 扩展选区（不依赖
  // display.shift，确保 Shift 版无论事件路径都能选中）；extend=false 时若有选区则折叠。
  // 跨行时沿 dir 续算到相邻行的词边界。
  _moveByWord(cm, dir, extend) {
    if (!cm) return;
    const segInfo = this._createWordSegmenter();
    const doc = cm.doc;
    const prevExtend = doc.extend;
    if (extend) doc.extend = true;
    try {
      cm.extendSelectionsBy((range) => {
      let line = range.head.line;
      let ch = range.head.ch;
      let guard = 0;
      const maxLine = cm.lineCount();
      while (guard++ < maxLine + 2) {
        const lt = cm.getLine(line);
        const target = this._wordBoundaryInLine(lt, ch, dir, segInfo);
        if (dir > 0) {
          // 命中词尾（非行尾）即停靠；词尾恰在行尾也视为有效停靠；否则跨下一行
          if (target.ch < lt.length) return { line, ch: target.ch };
          if (target.isEdgeWord) return { line, ch: lt.length };
          if (line >= cm.lastLine()) return { line, ch: lt.length };
          line += 1; ch = 0;
        } else {
          // 命中词头（非行首）即停靠；词头恰在行首也视为有效停靠；否则跨上一行
          if (target.ch > 0) return { line, ch: target.ch };
          if (target.isEdgeWord) return { line, ch: 0 };
          if (line <= cm.firstLine()) return { line, ch: 0 };
          line -= 1; ch = cm.getLine(line).length;
        }
      }
      return { line, ch };
      });
    } finally {
      doc.extend = prevExtend;
    }
  }

  initEditor() {
    // slash 命令面板状态
    this._slashOpen = false;
    this._slashCommands = null;
    this._slashStart = null;
    this._slashQuery = '';
    this._slashSel = 0;
    this._slashFiltered = [];

    const LIST_LINE_RE = /^(\s*)(?:>[> ]*|[*+-]\s\[[xX ]\]\s|[*+-]\s|\d+[.)]\s)/;
    this.cm = CodeMirror(document.getElementById('editor-wrapper'), {
      value: '',
      mode: 'gfm',
      theme: 'default',
      inputStyle: 'contenteditable',
      lineNumbers: true,
      lineWrapping: true,
      styleActiveLine: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      indentUnit: this.settings.tabSize,
      extraKeys: {
        'Enter': (cm) => this._handleTableEnter(cm),
        'Tab': (cm) => {
          if (cm.somethingSelected()) {
            cm.indentSelection('add');
            return;
          }
          // 列表/引用行无选区：缩进整行形成子级（支持多级列表层级调整）
          const lineText = cm.getLine(cm.getCursor().line);
          if (LIST_LINE_RE.test(lineText)) {
            cm.indentSelection('add');
            return;
          }
          cm.replaceSelection(' '.repeat(this.settings.tabSize), 'end');
        },
        'Shift-Tab': (cm) => cm.indentSelection('subtract'),
      }
    });

    // Ctrl + 鼠标滚轮缩放编辑器字体（全局，不持久化到 settings 面板，hint 消失后写回）
    const _zoomWrapper = this.cm.getWrapperElement();
    this.editorZoom = null; // null=未缩放，回落到 settings.fontSize
    // 「还原」按钮的目标字号 = 出厂默认（defaultSettings），而非当前设置值
    const _defaultSizes = this.defaultSettings();
    this._defaultEditorFontSize = _defaultSizes.fontSize;
    this._defaultPreviewFontSize = _defaultSizes.previewFontSize;

    // 顶部缩放提示（与 .lightbox-hint 视觉一致）
    this.zoomHint = document.createElement('div');
    this.zoomHint.className = 'zoom-hint';
    this.zoomHint.innerHTML = '<span class="zoom-hint-text"></span><span class="zoom-hint-reset hidden" role="button" title="Reset font size"></span>';
    this.zoomHint.querySelector('.zoom-hint-reset').addEventListener('click', () => {
      // 编辑器/预览共用同一提示条，按当前显示模式分派重置目标
      if (this._zoomHintMode === 'preview') this.resetPreviewFontSize();
      else this.resetEditorFontSize();
    });
    this._zoomHintHovering = false;
    this.zoomHint.addEventListener('mouseenter', () => {
      this._zoomHintHovering = true;
      clearTimeout(this._zoomHintTimer);
    });
    this.zoomHint.addEventListener('mouseleave', () => {
      this._zoomHintHovering = false;
      this._zoomHintTimer = setTimeout(() => this._zoomHintTimeout(), 3000);
    });
    document.body.appendChild(this.zoomHint);

    this.showZoomHint = (mode = 'editor') => {
      if (!this.zoomHint) return;
      if (mode !== 'preview' && !this.activeTab) return;
      this._zoomHintMode = mode; // 记录当前显示模式，供重置按钮分派
      const isPreview = mode === 'preview';
      // 编辑器/预览共用同一提示条（避免两个 fixed 元素叠加遮挡）；内容按模式切换
      const cur = isPreview
        ? (this.previewZoom ?? this.settings.previewFontSize)
        : (this.editorZoom ?? this.settings.fontSize);
      const base = isPreview ? this._defaultPreviewFontSize : this._defaultEditorFontSize;
      const textEl = this.zoomHint.querySelector('.zoom-hint-text');
      const resetEl = this.zoomHint.querySelector('.zoom-hint-reset');
      // 左侧始终显示当前字号，并明确是编辑器还是预览
      textEl.textContent = this.t(isPreview ? 'previewFontSizeHint' : 'fontSizeHint', { size: cur });
      if (cur !== base) {
        // 右侧显示「还原 Npx」按钮（还原到出厂默认字号）
        resetEl.textContent = this.t('fontSizeReset', { base });
        resetEl.classList.remove('hidden');
      } else {
        resetEl.classList.add('hidden');
      }
      this.zoomHint.classList.add('show');
      clearTimeout(this._zoomHintTimer);
      // hover 期间保持显示；离开后才按 3 秒倒计时消失（消失即持久化字号）
      if (!this._zoomHintHovering) {
        this._zoomHintTimer = setTimeout(() => this._zoomHintTimeout(), 3000);
      }
    };

    this.hideZoomHint = () => {
      if (!this.zoomHint) return;
      this.zoomHint.classList.remove('show');
      clearTimeout(this._zoomHintTimer);
    };

    // 字号调整落盘：hint 消失（3 秒无操作）后把运行时字号写回 settings 并持久化，
    // 保证下次重启保持上次调整的大小。编辑器按缩放源 tab 写回，预览按 previewZoom 写回。
    this._zoomHintTimeout = () => {
      this.zoomHint.classList.remove('show');
      this._persistZoom();
    };

    this._persistZoom = () => {
      try {
        let changed = false;
        if (this.editorZoom != null) {
          this.settings.fontSize = this.editorZoom;
          changed = true;
        }
        if (this.previewZoom != null) {
          this.settings.previewFontSize = this.previewZoom;
          changed = true;
        }
        if (changed) this.saveSettings();
      } catch {}
    };

    this.resetEditorFontSize = () => {
      const tab = this.activeTab;
      if (!tab) return;
      this.editorZoom = null;
      this.settings.fontSize = this._defaultEditorFontSize; // 还原到出厂默认字号
      this.cm.getWrapperElement().style.fontSize = this.settings.fontSize + 'px';
      this.cm.refresh();
      this.saveSettings(); // 还原即持久化，重启保持默认
      this.showZoomHint();
    };

    _zoomWrapper.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;            // 非 Ctrl：放行，CM 正常滚动
      e.preventDefault();               // 阻止 CM 滚动 + 浏览器整页/页面缩放
      e.stopPropagation();
      if (!this.activeTab) return;
      const cur = this.editorZoom ?? this.settings.fontSize;
      const next = Math.max(8, Math.min(72, cur + (e.deltaY < 0 ? 1 : -1)));
      if (next === cur) return;
      this.editorZoom = next;
      _zoomWrapper.style.fontSize = next + 'px';
      this.cm.refresh();
      this.showZoomHint();
    }, true);  // capture：先于 CM 内部 mousewheel 监听拦截

    // 预览区 Ctrl + 鼠标滚轮缩放字号（全局，不持久化到 settings 面板，hint 消失后写回
    // settings.previewFontSize 并落盘，重启保持）。顶部提示复用编辑器的 zoomHint。
    this.previewZoom = null; // null=未缩放，回落到 settings.previewFontSize

    this.resetPreviewFontSize = () => {
      this.previewZoom = null;
      this.settings.previewFontSize = this._defaultPreviewFontSize; // 还原到出厂默认字号
      this.preview.style.fontSize = this.settings.previewFontSize + 'px';
      this.saveSettings(); // 还原即持久化，重启保持默认
      this.showZoomHint('preview');
    };

    const _previewScroll = document.getElementById('preview-pane');
    _previewScroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;            // 非 Ctrl：放行，预览正常滚动
      e.preventDefault();               // 阻止预览滚动 + 浏览器整页/页面缩放
      e.stopPropagation();
      const cur = this.previewZoom ?? this.settings.previewFontSize;
      const next = Math.max(8, Math.min(72, cur + (e.deltaY < 0 ? 1 : -1)));
      if (next === cur) return;
      this.previewZoom = next;
      this.preview.style.fontSize = next + 'px';
      this.showZoomHint('preview');
    }, true);  // capture：先于预览内部可能的滚动监听拦截

    this.cm.on('change', () => {
      this.activeTab.content = this.cm.getValue();
      this.updateTabDisplay();
      // 大文档滑动窗口模式：打字时把窗口焦点同步到光标当前行（0-based），
      // 否则 updatePreview 仍按旧 _previewFocusLine 渲染切片，导致光标处新输入不显示、且预览跳到旧焦点。
      // 滚动驱动的虚拟重渲染走各自的焦点计算，这里只在窗口模式下跟随光标。
      if (this.previewWindow) {
        this._previewFocusLine = this.cm.getCursor().line;
      }
      this.debounceUpdatePreview();
    });

    this.cm.on('renderLine', (cm, line, el) => {
      if (line.text.length > 500 && line.text.includes('data:image/')) {
        el.classList.add('cm-base64-line');
      } else {
        el.classList.remove('cm-base64-line');
      }
    });

    this.cm.on('cursorActivity', () => {
      const cursor = this.cm.getCursor();
      // slash 命令面板：面板开启时按光标重算/关闭（回退到 / 前或换行列即关闭）；
      // 未开启时检测光标前的 / 是否满足「行首或空格后」触发条件。
      // 注意：不依赖 cm 的 inputRead 事件（在 Tauri WebView 下不可靠），改用 cursorActivity
      // —— 每次输入/光标移动必触发，覆盖真实输入路径。
      if (this._slashOpen) {
        this._updateSlashFromCursor();
      } else {
        this._maybeTriggerSlash(this.cm, cursor);
      }
      this.activeTab.cursorPos = cursor;
      this.cursorPosition.textContent = this.t('cursorPos', { line: cursor.line + 1, col: cursor.ch + 1 });
      this.updateBreadcrumb();
      // 光标移动时大纲同步高亮当前标题（与面包屑一致）
      this.updateOutlineActive(cursor.line);
    });

    // 双标志锁机制（demo 风格：canScroll.editor / canScroll.showDom）
    this._canScroll = { editor: true, preview: true };
    this._scrollThrottlePending = null;
    this._scrollThrottleTimer = null;
    this._scrollDebounceTimer = null;

    // 编辑器滚动 → 同步预览（demo 的 onScroll 思路）
    this.cm.on('scroll', () => {
      const container = document.querySelector('.editor-container');
      // 编辑器被隐藏（纯预览模式 / 编辑器折叠）时 getScrollInfo().top 恒为 0，
      // 若写回 scrollPos 会把已保存位置清零，导致切回编辑跳顶部。仅当编辑器可见才更新快照。
      if (container.classList.contains('preview-mode') || container.classList.contains('editor-collapsed')) return;
      const info = this.cm.getScrollInfo();
      this.activeTab.scrollPos = { top: info.top, left: info.left };

      // 滚动时按视口顶部行更新面包屑，实现「滚动到某标题时面包屑自动切换」
      if (this._breadcrumbHeadings && this._breadcrumbHeadings.length) {
        const topLine = this.cm.lineAtHeight(info.top + 4, 'local');
        this.updateBreadcrumb(false, Math.max(0, topLine));
        // 大纲同步跟随：滚动到某标题时，大纲高亮并滚动到当前标题
        this.updateOutlineActive(Math.max(0, topLine));
      }

      if (!this.settings.scrollSync || !this._canScroll.editor) return;
      if (container.classList.contains('preview-collapsed') || container.classList.contains('preview-mode')) return;

      this._canScroll.preview = false;
      this._throttleScroll(() => this._syncEditorToPreview(), 50);
      this._debounceScroll(() => this._resumeScroll(), 100);
    });

    // 预览滚动 → 同步编辑器（demo 的 onScroll 思路，方向相反）
    this.preview.addEventListener('scroll', () => {
      const container = document.querySelector('.editor-container');
      // 持续记录预览滚动位置（预览可见时）。edit/preview 切换恢复以及滚动同步都依赖它；
      // 预览折叠时其 scrollTop 不可靠，跳过以免覆盖有效值。
      if (this.activeTab && !container.classList.contains('preview-collapsed')) {
        this.activeTab.previewScrollTop = this.preview.scrollTop;
      }
      // 纯预览模式：编辑器隐藏，其滚动同步会提前退出，大纲须直接跟随预览内容。
      // 注意：先驱动虚拟预览懒加载（若需），再统一派生当前标题，避免漏渲染。
      if (container.classList.contains('preview-mode')) {
        if (this._previewVirtual && this.previewWindow) this._syncPreviewVirtualScroll();
        this.updateOutlineFromPreview();
        return;
      }
      // 纯预览模式 + 大文档虚拟滚动：驱动预览自身懒加载（拖到任意位置查看全文）
      if (container.classList.contains('preview-mode') && this._previewVirtual && this.previewWindow) {
        this._syncPreviewVirtualScroll();
        return;
      }
      if (!this.settings.scrollSync || !this._canScroll.preview) return;
      if (container.classList.contains('preview-collapsed')) return;

      this._canScroll.editor = false;
      this._throttleScroll(() => this._syncPreviewToEditor(), 50);
      this._debounceScroll(() => this._resumeScroll(), 100);
    });

    // ---- 行号点击选行 + 拖动连选 ----
    this._gutterDrag = null;
    this._gutterAnchor = null;
    this.cm.on('gutterClick', (cm, line, gutter, ev) => this.onGutterClick(cm, line, gutter, ev));
    this._gutterMouseMove = (e) => this.onGutterMouseMove(e);
    this._gutterMouseUp = (e) => this.onGutterMouseUp(e);
    document.addEventListener('mousemove', this._gutterMouseMove);
    document.addEventListener('mouseup', this._gutterMouseUp);

    // IME 适配说明：已切换到 inputStyle:'contenteditable'，IME 候选框由
    // WebView2 原生锚定在光标行下方（与浏览器行为一致），不再需要
    // compositionstart 滚动补偿。之前的滚动处理器在视口边缘行上会打断
    // composition（输入不了）+ 触发滚动反馈循环（页面乱滚），已移除。
  }

  _selectLineRange(cm, fromLine, toLine) {
    const a = Math.min(fromLine, toLine), b = Math.max(fromLine, toLine);
    const last = cm.lastLine();
    const end = b < last ? { line: b + 1, ch: 0 } : { line: b, ch: cm.getLine(b).length };
    cm.setSelection({ line: a, ch: 0 }, end);
  }

  onGutterClick(cm, line, gutter, ev) {
    if (ev.button !== 0) return;        // 仅左键
    ev.preventDefault();                // 阻止 CM 原生行选区/拖拽干扰
    if (ev.shiftKey) {
      const anchor = this._gutterAnchor == null ? cm.getCursor().line : this._gutterAnchor;
      this._gutterAnchor = anchor;
      this._gutterDrag = { anchor, startLine: anchor };
      this._selectLineRange(cm, anchor, line);
    } else {
      this._gutterAnchor = line;
      this._gutterDrag = { anchor: line, startLine: line };
      this._selectLineRange(cm, line, line);
    }
  }

  onGutterMouseMove(e) {
    const ds = this._gutterDrag;
    if (!ds) return;
    const pos = this.cm.coordsChar({ left: e.clientX, top: e.clientY }, 'window');
    const line = Math.max(0, Math.min(this.cm.lastLine(), pos.line));
    this._selectLineRange(this.cm, ds.anchor, line);
  }

  onGutterMouseUp() {
    if (this._gutterDrag) {
      this._gutterAnchor = this._gutterDrag.anchor;
      this._gutterDrag = null;
    }
  }

  async ensureTabLoaded(tab) {
    if (!tab) return;
    if (tab._loaded || !tab.filePath) { tab._loaded = true; return; }
    // 图片不读文本：内容由预览面板经 fetchImageAsBase64 从路径渲染，按文本读会污染 tab.content（乱码）
      if (tab.kind === 'image') { tab.content = ''; tab._loaded = true; return; }
    try {
      const content = await this.readFileNormalized(tab.filePath);
      tab.content = content;
      tab.savedContent = content;
      await this.refreshFileMeta(tab);
    } catch (e) {
      // 懒加载失败（文件被删/锁定/无权限）：标记错误并提示，避免静默空白
      tab._loadError = true;
      tab.content = '';
      tab.savedContent = '';
      this.reportError(e.code || 'E_IO', { context: { path: tab.filePath }, error: e, params: e.params, detail: e.detail });
    }
    tab._loaded = true;
  }

  // 切换/打开/重载文档后，恢复该 tab 记忆的滚动位置（编辑器 + 预览）。
  // 统一临时关闭滚动同步，避免恢复过程中的程序化滚动事件互相重定位，导致
  // 「切换标签页后预览/页面跳到别处」。下一帧再恢复滚动同步，交还给用户。
  _restoreSwitchScroll(restoreScroll, restorePreviewTop) {
    this._canScroll.editor = false;
    this._canScroll.preview = false;
    this.cm.scrollTo(restoreScroll.left || 0, restoreScroll.top || 0);
    const maxScroll = Math.max(this.preview.scrollHeight - this.preview.clientHeight, 0);
    this.preview.scrollTop = Math.min(restorePreviewTop || 0, maxScroll);
    setTimeout(() => this._resumeScroll(), 0);
  }

  async switchTab(index) {
    if (index === this.activeTabIndex || index < 0 || index >= this.tabs.length) return;

    this._largeFileNoticeDismissed = false;
    this._previewFocusLine = 0;
    this.previewWindow = null;
    this._beginPaneLoad();
    try {
      const oldTab = this.activeTab;
      oldTab.content = this.cm.getValue();
      oldTab.cursorPos = this.cm.getCursor();
      oldTab.scrollPos = { top: this.cm.getScrollInfo().top, left: this.cm.getScrollInfo().left };
      oldTab.previewScrollTop = this.preview.scrollTop;

      this.activeTabIndex = index;
      const newTab = this.activeTab;
      // 编辑器字号为全局（editorZoom），切 tab 不改变字号
      this.hideZoomHint();

      if (!newTab._loaded && newTab.filePath) {
        await this.ensureTabLoaded(newTab);
      }

      // 关键：先把恢复值读到局部变量。setValue 会同步触发 scroll / cursorActivity 事件，
      // 此刻 this.activeTab 已是 newTab，事件处理器会把 newTab.scrollPos / cursorPos 覆盖为 0，
      // 所以恢复必须用这里的快照副本，不能再回头读 newTab.*（否则会读到被污染的 0 → 回到顶部）。
      const restoreCursor = newTab.cursorPos || { line: 0, ch: 0 };
      const restoreScroll = newTab.scrollPos || { top: 0, left: 0 };
      const restorePreviewTop = newTab.previewScrollTop || 0;

      if (newTab.kind === 'image') {
        this.cm.setValue('');
      } else {
        this.cm.setValue(newTab.content || '');
        const newExt = (newTab.filePath && window.FileTypes && window.FileTypes.extOf)
          ? window.FileTypes.extOf(newTab.filePath)
          : (newTab.kind === 'markdown' ? 'md' : '');
        this._applyCodeMode(newExt);
      }
      clearTimeout(this.debounceTimer);
      this.cm.setCursor(restoreCursor);
      this.cm.clearHistory();

      this.updateTabDisplay();
      await this.updatePreview();
      // 统一恢复该 tab 记忆的编辑器/预览滚动位置。临时关闭滚动同步，避免恢复过程中
      // 程序化滚动事件互相重定位（分屏 + 滚动同步开启时预览会被编辑器同步覆盖，
      // 表现为「切换后预览/页面跳到别处」）。
      this._restoreSwitchScroll(restoreScroll, restorePreviewTop);
      this.updateWordCount();
      this.updateOutline();
      this.updateExternalChangeBanner();
      this.highlightTreeActiveFile();
      this.syncViewModeToTab();
    } finally {
      this._endPaneLoad();
    }
  }

  async addTab(name = '', content = '', filePath = null, kind = 'markdown') {
    const defaultName = this.t('untitled');
    if (!name || name === defaultName) {
      name = `${defaultName}${this.untitledCounter++}`;
    }
    content = content.replace(/\r\n/g, '\n');
    const tab = new Tab(name, content, filePath, kind);
    this.tabs.push(tab);
    this.refreshFileMeta(tab);
    await this.switchTab(this.tabs.length - 1);
    this.updateTabBar();
    try {
      if (filePath) this.addRecentFile(filePath);
    } catch (e) {
      console.error('[TizuMark] addRecentFile failed:', e);
    }
    this.saveSession();
  }

  async closeTab(index) {
    if (index < 0 || index >= this.tabs.length) return;

    const tab = this.tabs[index];
    if (tab.isModified) {
      const result = await this.showSaveDialog(this.t('saveChanges'), `${tab.name} ${this.t('fileModified')}`);
      if (result === 'cancel') return;
      if (result === 'save') {
        const savedIndex = this.tabs.indexOf(tab);
        if (savedIndex === -1) return;
        try {
          if (!tab.filePath) {
            const path = await dialogSave({
              filters: [
                { name: 'Markdown', extensions: ['md'] },
                { name: this.t('allFiles'), extensions: ['*'] }
              ]
            });
            if (!path) return;
            tab.filePath = path;
            tab.name = path.split(/[/\\]/).pop();
          }
          await TauriApi.writeFile({ path: tab.filePath, content: tab.content });
          tab.savedContent = tab.content;
          await this.refreshFileMeta(tab);
          this.setStatus(`${this.t('saved')}: ${tab.filePath}`);
        } catch (error) {
          this.setStatus(`${this.t('saveFailed')}: ${error}`);
          return;
        }
      }
    }

    const removeIndex = this.tabs.indexOf(tab);
    if (removeIndex === -1) return;

    if (this._externalQueue) this._externalQueue = this._externalQueue.filter(t => t !== tab);
    this.tabs.splice(removeIndex, 1);
    if (this.tabs.length === 0) {
      this.tabs.push(new Tab(`${this.t('untitled')}${this.untitledCounter++}`));
      this.activeTabIndex = 0;
      this.cm.setValue('');
    } else {
      if (removeIndex < this.activeTabIndex) {
        this.activeTabIndex--;
      } else if (this.activeTabIndex >= this.tabs.length) {
        this.activeTabIndex = this.tabs.length - 1;
      }
    }
    this.updateTabBar();
    if (this.tabs.length > 0) {
      await this.ensureTabLoaded(this.activeTab);
      this.cm.setValue(this.activeTab.content || '');
      this.cm.setCursor(this.activeTab.cursorPos || { line: 0, ch: 0 });
      this.updatePreview();
    }
    this.saveSession();
  }

  // ---- 标签页拖拽排序 ----
  reorderTab(from, to) {
    if (from === to || from < 0 || from >= this.tabs.length || to < 0 || to >= this.tabs.length) return;
    const [moved] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, moved);
    // 跟踪 activeTab 跟随移动
    if (this.activeTabIndex === from) {
      this.activeTabIndex = to;
    } else if (from < this.activeTabIndex && to >= this.activeTabIndex) {
      this.activeTabIndex--;
    } else if (from > this.activeTabIndex && to <= this.activeTabIndex) {
      this.activeTabIndex++;
    }
    this.updateTabBar();
    this.saveSession();
  }

  // 拖拽排序辅助（基于指针事件，不依赖原生 HTML5 DnD）
  _tabElAt(index) {
    return document.querySelector(`.tab[data-index="${index}"]`);
  }

  _tabIndexAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const tab = el.closest('.tab');
    if (!tab || tab.dataset.index == null) return null;
    return parseInt(tab.dataset.index, 10);
  }

  _startTabDrag(from) {
    const tab = this._tabElAt(from);
    if (tab) tab.classList.add('dragging');
    document.body.style.userSelect = 'none';
  }

  _updateTabDragTarget(x, y) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over'));
    const idx = this._tabIndexAtPoint(x, y);
    if (idx != null) {
      const t = this._tabElAt(idx);
      if (t) t.classList.add('drag-over');
    }
  }

  _endTabDrag() {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over', 'dragging'));
    document.body.style.userSelect = '';
  }

  // ---- 最近文件 ----
  loadRecentFiles() {
    try {
      const raw = localStorage.getItem('tizumark-recent-files');
      const arr = raw ? JSON.parse(raw) : [];
      this._recentFiles = Array.isArray(arr) ? arr.filter(p => typeof p === 'string') : [];
    } catch {
      this._recentFiles = [];
    }
  }

  saveRecentFiles() {
    try {
      localStorage.setItem('tizumark-recent-files', JSON.stringify(this._recentFiles || []));
    } catch {}
  }

  addRecentFile(filePath) {
    if (!filePath) return;
    const list = this._recentFiles || (this._recentFiles = []);
    const idx = list.indexOf(filePath);
    if (idx !== -1) list.splice(idx, 1);
    list.unshift(filePath);
    if (list.length > 10) list.length = 10;
    this.saveRecentFiles();
    if (this._recentSubmenuVisible) this.renderRecentFilesSubmenu();
  }

  clearRecentFiles() {
    this._recentFiles = [];
    this.saveRecentFiles();
    if (this._recentSubmenuVisible) this.renderRecentFilesSubmenu();
  }

  loadRecentWorkspaces() {
    try {
      const raw = localStorage.getItem('tizumark-recent-workspaces');
      const arr = raw ? JSON.parse(raw) : [];
      this._recentWorkspaces = Array.isArray(arr) ? arr.filter(p => typeof p === 'string') : [];
    } catch {
      this._recentWorkspaces = [];
    }
  }

  saveRecentWorkspaces() {
    try {
      localStorage.setItem('tizumark-recent-workspaces', JSON.stringify(this._recentWorkspaces || []));
    } catch {}
  }

  addRecentWorkspace(folderPath) {
    if (!folderPath) return;
    const list = this._recentWorkspaces || (this._recentWorkspaces = []);
    const idx = list.indexOf(folderPath);
    if (idx !== -1) list.splice(idx, 1);
    list.unshift(folderPath);
    if (list.length > 10) list.length = 10;
    this.saveRecentWorkspaces();
    if (this._recentWorkspacesSubmenuVisible) this.renderRecentWorkspacesSubmenu();
  }

  clearRecentWorkspaces() {
    this._recentWorkspaces = [];
    this.saveRecentWorkspaces();
    if (this._recentWorkspacesSubmenuVisible) this.renderRecentWorkspacesSubmenu();
  }

  async refreshRecentFiles() {
    if (!this._recentFiles || this._recentFiles.length === 0) return;
    const fileMenu = document.getElementById('file-menu');
    if (!fileMenu || fileMenu.classList.contains('hidden')) return;
    let changed = false;
    const survivors = [];
    for (const p of this._recentFiles) {
      let exists = true;
      try {
        const meta = await TauriApi.fileMeta({ path: p });
        exists = meta !== null && meta !== undefined;
      } catch {
        exists = true; // 查询失败保守保留，避免误删
      }
      if (exists) survivors.push(p); else changed = true;
    }
    if (changed) {
      this._recentFiles = survivors;
      this.saveRecentFiles();
      this.renderRecentFilesSubmenu();
    }
  }

  hideRecentSubmenu() {
    const sm = document.getElementById('recent-files-submenu');
    if (sm) sm.classList.add('hidden');
    this._recentSubmenuVisible = false;
  }

  showRecentSubmenu() {
    const trigger = document.getElementById('btn-recent');
    const submenu = document.getElementById('recent-files-submenu');
    if (!trigger || !submenu) return;
    this.hideRecentWorkspacesSubmenu(); // 与最近工作区子菜单互斥，避免重叠遮盖
    this.renderRecentFilesSubmenu();
    submenu.classList.remove('hidden');
    this._recentSubmenuVisible = true;
    this.positionSubmenu(trigger, submenu);
  }

  positionSubmenu(trigger, submenu) {
    if (!trigger || !submenu) return;
    const rect = trigger.getBoundingClientRect();
    submenu.style.left = (rect.right - 1) + 'px';
    submenu.style.top = rect.top + 'px';
    requestAnimationFrame(() => {
      const sr = submenu.getBoundingClientRect();
      if (sr.right > window.innerWidth) submenu.style.left = (rect.left - sr.width + 1) + 'px';
      if (sr.bottom > window.innerHeight) submenu.style.top = (window.innerHeight - sr.height - 4) + 'px';
    });
  }

  renderRecentWorkspacesSubmenu() {
    const submenu = document.getElementById('recent-workspaces-submenu');
    if (!submenu) return;
    const list = this._recentWorkspaces || [];
    submenu.innerHTML = '';
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dropdown-item disabled';
      empty.textContent = this.t('noRecentWorkspaces');
      submenu.appendChild(empty);
      return;
    }
    list.forEach(p => {
      const item = document.createElement('div');
      item.className = 'dropdown-item recent-file-item recent-workspace-item';
      item.dataset.path = p;
      const name = p.split(/[/\\]/).pop() || p;
      const dir = p.slice(0, Math.max(0, p.length - name.length)).replace(/[/\\]$/, '');
      const nameEl = document.createElement('span');
      nameEl.className = 'recent-file-name recent-workspace-name';
      nameEl.textContent = name;
      const dirEl = document.createElement('span');
      dirEl.className = 'recent-file-dir recent-workspace-dir';
      dirEl.textContent = dir;
      item.appendChild(nameEl);
      item.appendChild(dirEl);
      item.title = p;
      submenu.appendChild(item);
    });
    const sep = document.createElement('div');
    sep.className = 'dropdown-separator';
    submenu.appendChild(sep);
    const clear = document.createElement('div');
    clear.className = 'dropdown-item recent-clear recent-workspace-clear';
    clear.dataset.action = 'clear';
    clear.textContent = this.t('clearRecentWorkspaces');
    submenu.appendChild(clear);
  }

  showRecentWorkspacesSubmenu() {
    const trigger = document.getElementById('btn-recent-workspaces');
    const submenu = document.getElementById('recent-workspaces-submenu');
    if (!trigger || !submenu) return;
    this.hideRecentSubmenu(); // 与最近文件子菜单互斥，避免重叠遮盖
    this.renderRecentWorkspacesSubmenu();
    submenu.classList.remove('hidden');
    this._recentWorkspacesSubmenuVisible = true;
    this.positionSubmenu(trigger, submenu);
  }

  hideRecentWorkspacesSubmenu() {
    const sm = document.getElementById('recent-workspaces-submenu');
    if (sm) sm.classList.add('hidden');
    this._recentWorkspacesSubmenuVisible = false;
  }

  renderRecentFilesSubmenu() {
    const submenu = document.getElementById('recent-files-submenu');
    if (!submenu) return;
    const list = this._recentFiles || [];
    submenu.innerHTML = '';
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dropdown-item disabled';
      empty.textContent = this.t('noRecentFiles');
      submenu.appendChild(empty);
      return;
    }
    list.forEach(p => {
      const item = document.createElement('div');
      item.className = 'dropdown-item recent-file-item';
      item.dataset.path = p;
      const name = p.split(/[/\\]/).pop() || p;
      const dir = p.slice(0, Math.max(0, p.length - name.length)).replace(/[/\\]$/, '');
      const nameEl = document.createElement('span');
      nameEl.className = 'recent-file-name';
      nameEl.textContent = name;
      const dirEl = document.createElement('span');
      dirEl.className = 'recent-file-dir';
      dirEl.textContent = dir;
      item.appendChild(nameEl);
      item.appendChild(dirEl);
      item.title = p;
      submenu.appendChild(item);
    });
    const sep = document.createElement('div');
    sep.className = 'dropdown-separator';
    submenu.appendChild(sep);
    const clear = document.createElement('div');
    clear.className = 'dropdown-item recent-clear';
    clear.dataset.action = 'clear';
    clear.textContent = this.t('clearRecentFiles');
    submenu.appendChild(clear);
  }

  updateTabBar() {
    const tabBar = document.getElementById('tab-bar');
    const addBtn = document.getElementById('btn-add-tab');

    const fragment = document.createDocumentFragment();

    this.tabs.forEach((tab, i) => {
      const tabEl = document.createElement('div');
      tabEl.className = `tab${i === this.activeTabIndex ? ' active' : ''}${tab.isModified ? ' modified' : ''}`;
      tabEl.dataset.index = i;
      tabEl.setAttribute('role', 'tab');
      tabEl.setAttribute('aria-selected', i === this.activeTabIndex ? 'true' : 'false');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'tab-name';
      nameSpan.textContent = tab.name;
      tabEl.appendChild(nameSpan);

      if (this.tabs.length > 1) {
        const closeBtn = document.createElement('span');
        closeBtn.className = 'tab-close';
        closeBtn.textContent = '\u00d7';
        closeBtn.setAttribute('role', 'button');
        closeBtn.setAttribute('aria-label', this.t('closeAria'));
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.closeTab(i);
        });
        tabEl.appendChild(closeBtn);
      }

      tabEl.addEventListener('click', () => {
        if (this._suppressClick) { this._suppressClick = false; return; }
        this.switchTab(i);
      });
      // 中键点击关闭标签页；左键按下准备拖拽排序（用指针事件实现，绕过 Tauri 默认 dragDropEnabled 接管原生 DnD 导致拖不动的问题）
      tabEl.addEventListener('mousedown', (e) => {
        this._suppressClick = false;
        if (e.button === 1) { e.preventDefault(); this.closeTab(i); return; }
        if (e.button === 0) {
          this._dragState = { from: i, startX: e.clientX, startY: e.clientY, active: false };
        }
      });
      // 鼠标悬停显示完整路径（含文件名）；未保存标签无 filePath 时回退文件名
      tabEl.title = tab.filePath || tab.name;
      fragment.appendChild(tabEl);
    });

    tabBar.replaceChildren(fragment);
    if (addBtn) tabBar.appendChild(addBtn);
    // Refresh scroll arrows after tabs change
    if (this.updateTabScrollArrows) this.updateTabScrollArrows();
  }

  updateTabDisplay() {
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach((tab, i) => {
      if (i >= this.tabs.length) return;
      tab.className = `tab${i === this.activeTabIndex ? ' active' : ''}${this.tabs[i].isModified ? ' modified' : ''}${this.tabs[i].pendingExternalChange ? ' external-change' : ''}`;
      tab.querySelector('.tab-name').textContent = this.tabs[i].name;
    });
  }

  initEventListeners() {
    const toolbarDropdowns = [
      { btn: 'btn-file', menu: 'file-menu' },
      { btn: 'btn-view', menu: 'view-menu' },
      { btn: 'btn-help', menu: 'help-menu' },
    ];

    let toolbarHideTimer = null;
    let anyToolbarOpen = false;

    toolbarDropdowns.forEach(({ btn, menu }) => {
      const btnEl = document.getElementById(btn);
      const menuEl = document.getElementById(menu);
      const dropdown = btnEl.closest('.dropdown');

      const closeMenu = () => {
        toolbarHideTimer = setTimeout(() => {
          if (!dropdown.matches(':hover') && !document.querySelector('.dropdown:hover')) {
            menuEl.classList.add('hidden');
            anyToolbarOpen = false;
          }
        }, 150);
      };

      const cancelClose = () => {
        clearTimeout(toolbarHideTimer);
      };

      btnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        cancelClose();
        toolbarDropdowns.forEach(d => {
          const m = document.getElementById(d.menu);
          if (d.menu !== menu) m.classList.add('hidden');
        });
        const isOpening = menuEl.classList.contains('hidden');
        menuEl.classList.toggle('hidden');
        anyToolbarOpen = isOpening;
        if (menu === 'file-menu' && !menuEl.classList.contains('hidden')) this.refreshRecentFiles();
      });

      dropdown.addEventListener('mouseenter', () => {
        cancelClose();
        if (anyToolbarOpen && menuEl.classList.contains('hidden')) {
          toolbarDropdowns.forEach(d => {
            document.getElementById(d.menu).classList.add('hidden');
          });
          menuEl.classList.remove('hidden');
          if (menu === 'file-menu') this.refreshRecentFiles();
        }
      });

      dropdown.addEventListener('mouseleave', closeMenu);
    });

    document.addEventListener('click', () => {
      toolbarDropdowns.forEach(d => document.getElementById(d.menu).classList.add('hidden'));
      this.hideAllContextMenus();
    });
    // 标签页拖拽排序：用指针事件实现，避免 Tauri 默认开启 dragDropEnabled 接管原生 DnD 导致拖不动
    document.addEventListener('mousemove', (e) => {
      const ds = this._dragState;
      if (!ds) return;
      if (!ds.active) {
        const dx = e.clientX - ds.startX;
        const dy = e.clientY - ds.startY;
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        ds.active = true;
        this._startTabDrag(ds.from);
      }
      this._updateTabDragTarget(e.clientX, e.clientY);
    });
    document.addEventListener('mouseup', (e) => {
      const ds = this._dragState;
      if (!ds) return;
      if (ds.active) {
        const to = this._tabIndexAtPoint(e.clientX, e.clientY);
        if (to != null && to !== ds.from) this.reorderTab(ds.from, to);
        this._endTabDrag();
        this._suppressClick = true;
      }
      this._dragState = null;
    });
    document.getElementById('btn-sidebar-toggle').addEventListener('click', () => {
      this.toggleSidebar();
    });
    document.getElementById('btn-new').addEventListener('click', () => {
      document.getElementById('file-menu').classList.add('hidden');
      this.newFile();
    });
    document.getElementById('btn-add-tab').addEventListener('click', () => {
      this.newFile();
    });
    document.getElementById('btn-open').addEventListener('click', () => {
      document.getElementById('file-menu').classList.add('hidden');
      this.openFile();
    });
    document.getElementById('btn-open-folder').addEventListener('click', () => {
      document.getElementById('file-menu').classList.add('hidden');
      this.openFolder();
    });
    // 大纲层级过滤下拉：自绘 Select，选项 = 全部 / 仅 H1 / 仅 H1–H2 / ... / 仅 H1–H6
    const outlineFilterHost = document.getElementById('outline-filter');
    if (outlineFilterHost) {
      this._outlineFilterSelect = new Select(outlineFilterHost, {
        value: String(this.settings.outlineFilterLevel || 0),
        t: this.t.bind(this),
        ariaLabelKey: 'outlineFilter',
        optionsProvider: (t) => ([
          { value: '0', label: t('outlineFilterAll') },
          { value: '1', label: t('outlineFilterH1') },
          { value: '2', label: t('outlineFilterH2') },
          { value: '3', label: t('outlineFilterH3') },
          { value: '4', label: t('outlineFilterH4') },
          { value: '5', label: t('outlineFilterH5') },
          { value: '6', label: t('outlineFilterH6') },
        ]),
        onChange: (v) => {
          this.settings.outlineFilterLevel = parseInt(v, 10) || 0;
          this.saveSettings();
          this.updateOutline();
        },
      });
    }
    // 最近文件子菜单交互
    document.getElementById('btn-recent').addEventListener('mouseenter', () => {
      this.showRecentSubmenu();
    });
    document.getElementById('btn-recent').addEventListener('click', (e) => {
      e.stopPropagation();
      this.showRecentSubmenu();
    });
    document.getElementById('file-menu').addEventListener('mouseover', (e) => {
      if (e.target.closest('#recent-files-submenu')) return;
      if (e.target.closest('#btn-recent')) return;
      if (e.target.closest('#recent-workspaces-submenu')) return;
      if (e.target.closest('#btn-recent-workspaces')) return;
      this.hideRecentSubmenu();
      this.hideRecentWorkspacesSubmenu();
    });
    const recentSubmenu = document.getElementById('recent-files-submenu');
    recentSubmenu.addEventListener('click', (e) => {
      e.stopPropagation();
      const clearItem = e.target.closest('[data-action="clear"]');
      if (clearItem) {
        this.clearRecentFiles();
        this.hideRecentSubmenu();
        return;
      }
      const item = e.target.closest('.recent-file-item');
      if (item && item.dataset.path) {
        const path = item.dataset.path;
        document.getElementById('file-menu').classList.add('hidden');
        this.hideRecentSubmenu();
        this.openFilePath(path);
      }
    });
    // 最近工作区子菜单交互
    const wsTrigger = document.getElementById('btn-recent-workspaces');
    if (wsTrigger) {
      wsTrigger.addEventListener('mouseenter', () => this.showRecentWorkspacesSubmenu());
      wsTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showRecentWorkspacesSubmenu();
      });
    }
    const wsSubmenu = document.getElementById('recent-workspaces-submenu');
    if (wsSubmenu) {
      wsSubmenu.addEventListener('click', (e) => {
        e.stopPropagation();
        const clearItem = e.target.closest('[data-action="clear"]');
        if (clearItem) {
          this.clearRecentWorkspaces();
          this.hideRecentWorkspacesSubmenu();
          return;
        }
        const item = e.target.closest('.recent-workspace-item');
        if (item && item.dataset.path) {
          const path = item.dataset.path;
          document.getElementById('file-menu').classList.add('hidden');
          this.hideRecentWorkspacesSubmenu();
          this.maybeOpenFolderPath(path, { confirm: true });
        }
      });
    }
    document.getElementById('folder-close').addEventListener('click', () => {
      this.closeFolder();
    });
    // 文件目录排序控件：自绘 Select 组件（替代原生 select，展开面板可主题化 + 完整 ARIA）
    const sortKeyHost = document.getElementById('folder-sort-key');
    if (sortKeyHost) {
      this._folderSortSelect = new Select(sortKeyHost, {
        value: this.settings.fileSortKey || 'name',
        t: this.t.bind(this),
        ariaLabelKey: 'fileSort',
        optionsProvider: (t) => ([
          { value: 'name', label: t('sortByName') },
          { value: 'time', label: t('sortByTime') },
          { value: 'created', label: t('sortByCreated') },
        ]),
        onChange: (v) => {
          this.settings.fileSortKey = v;
          this.saveSettings();
          this.renderFolderTree();
        },
      });
    }
    const sortOrderEl = document.getElementById('folder-sort-order');
    if (sortOrderEl) {
      sortOrderEl.addEventListener('click', () => {
        this.settings.fileSortOrder = this.settings.fileSortOrder === 'desc' ? 'asc' : 'desc';
        this.saveSettings();
        this.updateFolderSortOrderButton();
        this.renderFolderTree();
      });
    }
    this.updateFolderSortOrderButton();
    document.getElementById('btn-save').addEventListener('click', () => {
      document.getElementById('file-menu').classList.add('hidden');
      this.saveFile();
    });
    document.getElementById('btn-save-as').addEventListener('click', () => {
      document.getElementById('file-menu').classList.add('hidden');
      this.saveAsFile();
    });
    document.getElementById('btn-reload').addEventListener('click', () => this.reloadFile());
    document.getElementById('btn-reload-menu').addEventListener('click', () => {
      document.getElementById('file-menu').classList.add('hidden');
      this.reloadFile();
    });
    document.getElementById('btn-export-html').addEventListener('click', () => {
      document.getElementById('file-menu').classList.add('hidden');
      this.exportHTML();
    });
    document.getElementById('btn-export-img').addEventListener('click', () => {
      document.getElementById('file-menu').classList.add('hidden');
      this.exportImage();
    });
    document.getElementById('btn-export-pdf').addEventListener('click', () => {
      document.getElementById('file-menu').classList.add('hidden');
      this.exportPDF();
    });
    document.getElementById('btn-export-word').addEventListener('click', () => {
      document.getElementById('file-menu').classList.add('hidden');
      this.exportWord();
    });
    document.getElementById('btn-settings').addEventListener('click', () => {
      document.getElementById('file-menu').classList.add('hidden');
      this.showSettings();
    });
    document.getElementById('btn-theme').addEventListener('click', () => this.toggleTheme());
    document.getElementById('btn-user-guide').addEventListener('click', () => {
      document.getElementById('help-menu').classList.add('hidden');
      this.openUserGuide();
    });
    document.getElementById('btn-about').addEventListener('click', () => {
      document.getElementById('help-menu').classList.add('hidden');
      this.showAbout();
    });
    document.getElementById('btn-check-update').addEventListener('click', () => {
      document.getElementById('help-menu').classList.add('hidden');
      this.checkUpdate(true);
    });
    document.getElementById('btn-devtools').addEventListener('click', () => {
      document.getElementById('help-menu').classList.add('hidden');
      try {
        TauriApi.toggleDevtools();
      } catch (e) {
        this.reportError('devtools');
      }
    });
    document.querySelector('.tab-bar-wrapper').addEventListener('dblclick', (e) => {
      if (!e.target.closest('.tab') && !e.target.closest('.tab-add')) {
        this.newFile();
      }
    });
    document.getElementById('btn-view-preview').addEventListener('click', () => this.setViewMode('preview'));
    document.getElementById('btn-view-edit').addEventListener('click', () => this.setViewMode('edit'));
    document.getElementById('btn-side-left').addEventListener('click', () => this.toggleCollapse('editor'));
    document.getElementById('btn-side-right').addEventListener('click', () => this.toggleCollapse('preview'));
    document.getElementById('large-file-banner-close').addEventListener('click', () => {
      this.hideLargeFileNotice();
      this._largeFileNoticeDismissed = true;
    });
    // 「不再提醒」：本次应用运行期间彻底屏蔽大文档横幅（会话级，重启后复位）。
    document.getElementById('large-file-banner-dont-remind').addEventListener('click', () => {
      this._largeFileNoticeSessionSuppressed = true;
      this.hideLargeFileNotice();
    });
    document.getElementById('about-close').addEventListener('click', () => this.hideAbout());
    document.getElementById('about-dialog').addEventListener('click', (e) => {
      if (e.target.id === 'about-dialog') this.hideAbout();
    });
    document.getElementById('update-close').addEventListener('click', () => this.hideUpdateDialog());
    document.getElementById('update-dialog').addEventListener('click', (e) => {
      if (e.target.id === 'update-dialog') this.hideUpdateDialog();
    });
    document.getElementById('update-action').addEventListener('click', () => this.handleUpdateAction());
    document.getElementById('update-skip').addEventListener('click', () => this.hideUpdateDialog());
    document.getElementById('gitee-badge').addEventListener('click', () => {
      const url = document.getElementById('gitee-badge').dataset.url;
      if (url) this.openExternal(url);
    });
    document.getElementById('qq-group-badge').addEventListener('click', () => {
      const badge = document.getElementById('qq-group-badge');
      const url = badge.dataset.joinUrl;
      if (url && !url.includes('YOUR_JOIN_KEY')) {
        this.openExternal(url);
      }
    });
    document.getElementById('github-badge').addEventListener('click', () => {
      const url = document.getElementById('github-badge').dataset.url;
      if (url) this.openExternal(url);
    });

    document.getElementById('btn-minimize').addEventListener('click', () => this.minimizeWindow());
    document.getElementById('btn-maximize').addEventListener('click', () => this.toggleMaximize());
    document.getElementById('btn-close').addEventListener('click', () => this.closeWindow());

    const header = document.querySelector('.header');
    if (header) {
      header.addEventListener('mousedown', async (e) => {
        if (e.target.closest('button, input, select, textarea, .dropdown-menu, .app-icon, .view-mode-tab, .window-controls')) {
          return;
        }
        if (e.button === 0) {
          // 阻止冒泡到 document，避免 Tauri 注入的 drag.js（data-tauri-drag-region）
          // 与这里调用同一个 start_dragging IPC 造成重复触发
          e.stopPropagation();
          if (e.detail === 2) {
            this.toggleMaximize();
            return;
          }
          try {
            const appWindow = TauriApi.currentWindow();
            if (appWindow && typeof appWindow.startDragging === 'function') {
              await appWindow.startDragging();
            }
          } catch (err) {
            console.warn('startDragging failed:', err);
          }
        }
      });
    }

    window.addEventListener('resize', () => {
      this.updateMaximizeIcon();
      this.updateSideButtons();
    });

    // 应用退出时全量 revoke Blob URL，避免 WebView 存活期内泄漏（LRU 兜底外的一刀切）
    window.addEventListener('beforeunload', () => {
      if (this._imageURLCache && typeof URL !== 'undefined' && URL.revokeObjectURL) {
        for (const url of this._imageURLCache.values()) URL.revokeObjectURL(url);
        this._imageURLCache.clear();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (this.handleShortcutRecording(e)) return;

      // slash 命令面板开启时，方向键/回车/Tab/Esc 优先在此拦截，阻断 CodeMirror 的
      // 光标移动/换行/缩进默认行为，由面板自身处理导航与确认；面板关闭后这些键恢复常态。
      if (this._slashOpen) {
        switch (e.key) {
          case 'ArrowDown': e.preventDefault(); e.stopPropagation(); this._slashMove(1); return;
          case 'ArrowUp': e.preventDefault(); e.stopPropagation(); this._slashMove(-1); return;
          case 'Enter':
          case 'Tab': e.preventDefault(); e.stopPropagation(); this._slashConfirm(); return;
          case 'Escape': e.preventDefault(); e.stopPropagation(); this._closeSlashPanel(); return;
        }
      }

      // slash 命令排序对话框开启时，Esc 关闭（草稿不保存）
      if (this._slashOrderOpen && e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); this.hideSlashOrderDialog(); return;
      }

      // 文件树右键菜单快捷键（合并自 PR #36）：_fileTreeCtx 存在时，F2/Delete/Ctrl+X/C/V 对其生效。
      // 关键修复：点击文件打开后焦点落在编辑器（.CodeMirror），旧逻辑用「!inEditor」拦截导致
      // Ctrl+C/V 被 CodeMirror 吞掉、文件复制/粘贴「不起作用」。现改为：Ctrl+C/X/V 以文件树操作为先，
      // 仅当编辑器或预览区存在文本选区时才让位给文本复制/剪切/粘贴。
      // 用户真正点进编辑器编辑时（editorWrapper mousedown）会清掉 _fileTreeCtx，恢复纯文本操作。
      if (this._fileTreeCtx) {
        const inInput = e.target.closest('input, textarea, select');
        if (!inInput) {
          const ctrl = e.ctrlKey || e.metaKey;
          if (e.key === 'F2') { e.preventDefault(); this.fileTreeRename(); return; }
          if (e.key === 'Delete') { e.preventDefault(); this.fileTreeDelete(); return; }
          if (ctrl && !e.shiftKey && !e.altKey) {
            const k = e.key.toLowerCase();
            // 检查编辑器或预览区是否有文本选区——有选区时交给浏览器原生 copy/cut，
            // 不走文件树操作。预览区是 HTML 内容，window.getSelection() 检测其选区。
            const hasTextSelection = (this.cm && this.cm.somethingSelected())
              || (window.getSelection && window.getSelection().toString().length > 0);
            // 复制 / 剪切：有文本选区时交给编辑器/浏览器；否则按文件树复制/剪切
            if (k === 'x' || k === 'c') {
              if (hasTextSelection) return;
              e.preventDefault();
              if (k === 'c') this.fileTreeCopy(); else this.fileTreeCut();
              return;
            }
            // 粘贴：文件树选中节点（目录或文件）且无文本选区时，粘贴文件。
            // 选中目录→粘贴进该目录；选中文件→粘贴进其所在目录（同级）。有文本选区时交给文本粘贴。
            if (k === 'v') {
              if (!hasTextSelection) {
                e.preventDefault();
                this.fileTreePaste();
              }
              return;
            }
          }
          if (ctrl && e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
            e.preventDefault();
            if (this._fileTreeCtx.isDir) this.fileTreeNewFile();
            return;
          }
          if (ctrl && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
            e.preventDefault();
            if (this._fileTreeCtx.isDir) this.fileTreeNewFolder();
            return;
          }
        }
      }

      if (/^F(1[0-2]|[1-9])$/.test(e.key)) {
        e.preventDefault();
        return;
      }

      // Block WebView history navigation (back/forward)
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        return;
      }

      if (e.key === 'Escape') {
        const aboutDialog = document.getElementById('about-dialog');
        if (!aboutDialog.classList.contains('hidden')) {
          this.hideAbout();
          return;
        }
        const shortcutsDialog = document.getElementById('shortcuts-dialog');
        if (!shortcutsDialog.classList.contains('hidden')) {
          this.hideShortcutsDialog();
          return;
        }
      }

      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl) {
        const key = e.key.toLowerCase();

        // 文档导航键（Home/End）：与 a/c/v/x 同逻辑，放行给 CodeMirror 处理。
        // 事件自然到达 CM，由 extraKeys 注册的 handler 接管（Ctrl+End 落末行末列、
        // Ctrl+Home 移动而非选中）；CM 命中后会自行 preventDefault（阻止页面滚动）。
        // 不放行的话全局捕获监听会 preventDefault，导致 CM 因 defaultPrevented 提前
        // return、handler 永不执行（见 codemirror.js onKeyDown → signalDOMEvent）。
        if (key === 'home' || key === 'end' || key === 'arrowleft' || key === 'arrowright') {
          // 文档导航键 / 方向键：放行给 CodeMirror 处理（Ctrl+←/→ 按词移动、
          // Ctrl+Shift+←/→ 选词）。若在此 preventDefault，CM 因 defaultPrevented 提前
          // return，extraKeys 里自定义的 _moveByWord handler 永不执行（同 Home/End 坑）。
          return;
        }

        // Essential browser editing shortcuts — always let through
        if (['a', 'c', 'v', 'x', 'z', 'y'].includes(key)) {
          if (!e.shiftKey) return;
          if (key === 'z') return; // Ctrl+Shift+Z for redo
          e.preventDefault(); // Block Ctrl+Shift+C (DevTools) etc.
          return;
        }

        // Block ALL other Ctrl shortcuts from triggering browser defaults
        e.preventDefault();

        // Handle TizuMark's global shortcuts (work even when editor is not focused)
        // 主键用 e.code（物理键位）推导，规避某些浏览器/环境下 Ctrl+Shift+字母的
        // e.key 取值异常（如被当成其它字符），保证 keyStr 与 globalShortcutLookup
        // 中存储的 'Ctrl+Shift+F' 等稳定匹配。
        let baseKey;
        if (e.code && /^Key[A-Za-z]$/.test(e.code)) baseKey = e.code.slice(3).toUpperCase();
        else if (e.code && /^Digit[0-9]$/.test(e.code)) baseKey = e.code.slice(5);
        else baseKey = e.key.length === 1 ? e.key.toUpperCase() : e.key;
        const gParts = [];
        if (e.ctrlKey || e.metaKey) gParts.push('Ctrl');
        if (e.shiftKey) gParts.push('Shift');
        if (e.altKey) gParts.push('Alt');
        gParts.push(baseKey);
        const keyStr = gParts.join('+');
        const gHandler = this.globalShortcutLookup?.[keyStr];
        // 全局快捷键在【捕获阶段】统一派发：命中即 stopPropagation，阻断事件继续
        // 冒泡到 CodeMirror（及其默认键位 search.js 的 Shift-Ctrl-F→replace）或
        // Tauri WebView 的原生处理，确保编辑器有焦点时也能且仅由本处触发一次。
        // （CM 的 extraKeys 仍对相关键置 false 作为兜底。）
        if (gHandler) {
          e.stopPropagation();
          gHandler();
        }
      }
    }, true);
  }

  initResizer() {
    const resizer = document.getElementById('resizer');
    const container = document.querySelector('.editor-container');
    const editorPane = document.getElementById('editor-pane');
    const previewPane = document.getElementById('preview-pane');
    const outlineSidebar = document.getElementById('outline-sidebar');
    let isResizing = false;
    let startX = 0;
    let startEditorWidth = 0;

    const onMouseMove = (e) => {
      if (!isResizing) return;
      const delta = e.clientX - startX;
      const newEditorWidth = startEditorWidth + delta;
      const outlineWidth = outlineSidebar.classList.contains('hidden') ? 0 : outlineSidebar.offsetWidth;
      const resizerWidth = resizer.offsetWidth;
      const totalContentWidth = container.offsetWidth - outlineWidth - resizerWidth;
      const editorPercent = (newEditorWidth / totalContentWidth) * 100;
      if (editorPercent > 20 && editorPercent < 80) {
        const editorRatio = editorPercent / 100;
        const previewRatio = 1 - editorRatio;
        editorPane.style.flex = editorRatio.toFixed(4) + ' 0 0px';
        previewPane.style.flex = previewRatio.toFixed(4) + ' 0 0px';
        editorPane.style.width = '';
        previewPane.style.width = '';
        this._editorPercent = editorPercent;
        this.cm.refresh();
        this.updateSideButtons();
      }
    };

    const onMouseUp = () => {
      if (!isResizing) return;
      isResizing = false;
      document.body.classList.remove('is-resizing');
      // 保存预览区宽度到设置（合并自 PR #36）
      const pw = previewPane.getBoundingClientRect().width;
      this.settings.previewPaneWidth = Math.round(pw);
      this.saveSettings();
      document.documentElement.style.setProperty('--preview-pane-width', Math.round(pw) + 'px');
    };

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isResizing = true;
      startX = e.clientX;
      startEditorWidth = editorPane.getBoundingClientRect().width;
      document.body.classList.add('is-resizing');
    });

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // 应用已保存的预览区宽度（合并自 PR #36）：分屏模式下按 settings.previewPaneWidth 还原布局。
  // 纯预览/编辑器折叠/预览折叠由 CSS 类控制，禁止用用户分屏宽度覆盖，否则占不满且留空白。
  applyPreviewPaneWidth() {
    const container = document.querySelector('.editor-container');
    if (!container) return;
    if (container.classList.contains('preview-mode')
        || container.classList.contains('editor-collapsed')
        || container.classList.contains('preview-collapsed')) return;
    const pw = this.settings.previewPaneWidth;
    if (!pw) return;
    const editorPane = document.getElementById('editor-pane');
    const previewPane = document.getElementById('preview-pane');
    if (!editorPane || !previewPane) return;
    const outlineSidebar = document.getElementById('outline-sidebar');
    const resizer = document.getElementById('resizer');
    const outlineWidth = outlineSidebar && outlineSidebar.classList.contains('hidden') ? 0 : (outlineSidebar ? outlineSidebar.offsetWidth : 0);
    const resizerWidth = resizer ? resizer.offsetWidth : 6;
    const totalContentWidth = container.offsetWidth - outlineWidth - resizerWidth;
    if (totalContentWidth <= 0) return;
    const editorWidth = totalContentWidth - pw;
    const editorRatio = (editorWidth / totalContentWidth);
    if (editorRatio > 0.1 && editorRatio < 0.9) {
      editorPane.style.flex = editorRatio.toFixed(4) + ' 0 0px';
      previewPane.style.flex = (1 - editorRatio).toFixed(4) + ' 0 0px';
      this._editorPercent = editorRatio * 100;
    } else {
      // 比例超出范围时，直接用预设宽度设置预览区
      previewPane.style.flex = '0 0 auto';
      previewPane.style.width = pw + 'px';
      editorPane.style.flex = '1 1 0px';
      this._editorPercent = ((totalContentWidth - pw) / totalContentWidth) * 100;
    }
    document.documentElement.style.setProperty('--preview-pane-width', pw + 'px');
  }

  initFindReplace() {
    const findPanel = document.getElementById('find-panel');
    const findInput = document.getElementById('find-input');
    const replaceInput = document.getElementById('replace-input');
    const findCount = document.getElementById('find-count');
    let lastQuery = '';
    this.findMarks = this.findMarks || []; // 全部高亮的 markText 句柄

    const isSafeRegex = FindReplace.isSafeRegex;

    // 带步数上限的安全匹配计数：避免灾难性回溯卡死主线程
    const safeMatchCount = (text, re, limit = 200000) => {
      if (!re.global) re = new RegExp(re.source, re.flags + 'g');
      let count = 0, steps = 0;
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        count++;
        steps += m.index + 1;
        if (steps > limit || count > 100000) return -1; // 超限：疑似 ReDoS
        if (re.lastIndex === m.index) re.lastIndex++;
      }
      return count;
    };

    const makeRegex = (q, flags) => {
      try { return new RegExp(q, flags); } catch { return null; }
    };

    const getSearchCursor = () => {
      const query = findInput.value;
      if (!query) return null;
      const caseSensitive = document.getElementById('find-case').checked;
      const useRegex = document.getElementById('find-regex').checked;
      if (useRegex) {
        if (!isSafeRegex(query)) { this.setStatus(this.t('unsafeRegex')); return null; }
        try { new RegExp(query); } catch { return null; }
      }
      const cursor = this.cm.getSearchCursor(
        useRegex ? new RegExp(query, caseSensitive ? 'g' : 'gi') : query,
        this.cm.getCursor(),
        { caseFold: !caseSensitive }
      );
      return cursor;
    };

    let findComposing = false; // 输入法合成中（拼音/手写）：期间不触发搜索，避免主线程被反复全量高亮占满而卡死
    const debounce = (fn, delay) => {
      let t = null;
      return (...args) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
    };
    const updateCount = () => {
      if (findComposing) return; // 拼音合成中跳过；合成结束会立刻搜一次
      const query = findInput.value;
      if (!query) { findCount.textContent = ''; return; }
      const caseSensitive = document.getElementById('find-case').checked;
      const useRegex = document.getElementById('find-regex').checked;
      const text = this.cm.getValue();
      let count = 0;
      if (useRegex) {
        if (!isSafeRegex(query)) { findCount.textContent = ''; return; }
        const re = makeRegex(query, caseSensitive ? 'g' : 'gi');
        if (re) { const c = safeMatchCount(text, re); count = c < 0 ? '∞' : c; }
      } else {
        const lower = caseSensitive ? text : text.toLowerCase();
        const q = caseSensitive ? query : query.toLowerCase();
        let pos = 0;
        while ((pos = lower.indexOf(q, pos)) !== -1) { count++; pos += q.length; }
      }
      if (count === '∞') { findCount.textContent = this.t('tooManyMatches') || '∞'; }
      else findCount.textContent = count > 0 ? count + this.t('matches') : this.t('noMatches');
      this.highlightAllMatches();
      // 预览框（编辑模式下与编辑框并排）同样黄色高亮
      this.highlightPreviewMatches(query, caseSensitive, useRegex);
    };

    // 输入防抖：避免每敲一个字符就同步全量搜索+高亮（尤其中文拼音边输边搜会卡死）
    const debouncedFindUpdate = debounce(() => updateCount(), 160);
    findInput.addEventListener('input', debouncedFindUpdate);
    findInput.addEventListener('compositionstart', () => { findComposing = true; });
    findInput.addEventListener('compositionend', () => {
      findComposing = false;
      updateCount(); // 合成结束立即搜索一次，即时反馈
    });
    document.getElementById('find-case').addEventListener('change', updateCount);
    document.getElementById('find-regex').addEventListener('change', updateCount);

    document.getElementById('find-next').addEventListener('click', () => {
      const loop = document.getElementById('find-loop').checked;
      const cursor = getSearchCursor();
      if (cursor && cursor.findNext()) {
        this.cm.setSelection(cursor.from(), cursor.to());
        this.cm.scrollIntoView({ from: cursor.from(), to: cursor.to() }, 100);
      } else if (cursor && loop) {
        const q = findInput.value;
        const useRegex = document.getElementById('find-regex').checked;
        if (useRegex && !isSafeRegex(q)) return;
        const cursor2 = this.cm.getSearchCursor(
          useRegex ? new RegExp(q, document.getElementById('find-case').checked ? 'g' : 'gi') : q,
          { line: 0, ch: 0 },
          { caseFold: !document.getElementById('find-case').checked }
        );
        if (cursor2.findNext()) {
          this.cm.setSelection(cursor2.from(), cursor2.to());
          this.cm.scrollIntoView({ from: cursor2.from(), to: cursor2.to() }, 100);
        }
      }
    });

    document.getElementById('find-prev').addEventListener('click', () => {
      const query = findInput.value;
      if (!query) return;
      const caseSensitive = document.getElementById('find-case').checked;
      const useRegex = document.getElementById('find-regex').checked;
      const cursor = this.cm.getCursor();
      const text = this.cm.getValue();

      // 用 CodeMirror 原生 indexFromPos/posFromIndex 做偏移换算：
      // 历史实现每次调用都对全文 split('\n')，多匹配循环下近 O(n²)；原生 API 走行表，常数级。
      const currentOffset = this.cm.indexFromPos(cursor);
      const flags = caseSensitive ? 'g' : 'gi';
      if (useRegex && !isSafeRegex(query)) return;
      const regex = useRegex
        ? new RegExp(query, flags)
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);

      let lastMatch = null;
      let lastOverall = null;
      let m;
      while ((m = regex.exec(text)) !== null) {
        const cand = { from: this.cm.posFromIndex(m.index), to: this.cm.posFromIndex(m.index + m[0].length) };
        lastOverall = cand;
        if (m.index + m[0].length < currentOffset) {
          lastMatch = cand;
        }
        if (regex.lastIndex === m.index) { regex.lastIndex++; }
      }

      const loop = document.getElementById('find-loop').checked;
      if (lastMatch) {
        this.cm.setSelection(lastMatch.from, lastMatch.to);
        this.cm.scrollIntoView({ from: lastMatch.from, to: lastMatch.to }, 100);
      } else if (loop && lastOverall) {
        this.cm.setSelection(lastOverall.from, lastOverall.to);
        this.cm.scrollIntoView({ from: lastOverall.from, to: lastOverall.to }, 100);
      }
    });

    document.getElementById('replace-one').addEventListener('click', () => {
      if (this.cm.somethingSelected()) {
        this.cm.replaceSelection(replaceInput.value);
      }
      document.getElementById('find-next').click();
    });

    document.getElementById('replace-all').addEventListener('click', () => {
      const query = findInput.value;
      const replacement = replaceInput.value;
      if (!query) return;
      const caseSensitive = document.getElementById('find-case').checked;
      const useRegex = document.getElementById('find-regex').checked;

      if (useRegex && !isSafeRegex(query)) return;
      // 使用 CodeMirror 的 searchCursor.replace，原生支持 $1/$& 反向引用（正则替换不被退化为文本替换）
      const search = useRegex ? new RegExp(query, caseSensitive ? 'g' : 'gi') : query;
      const cursor = this.cm.getSearchCursor(search, { line: 0, ch: 0 }, { caseFold: !caseSensitive });
      let count = 0;
      let steps = 0;
      this.cm.operation(() => {
        while (cursor.findNext()) {
          count++;
          steps++;
          if (steps > 100000) break; // 防御性上限，避免极端情况卡死
          cursor.replace(replacement);
        }
      });
      if (count > 0) this.setStatus(this.t('replaceAllDone', { n: count }));
    });

    document.getElementById('find-close').addEventListener('click', () => this.closeFindPanel());

    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('find-next').click();
      }
      if (e.key === 'Escape') this.closeFindPanel();
    });

    replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('replace-one').click();
      }
      if (e.key === 'Escape') this.closeFindPanel();
    });

    this.initPreviewFind();
  }

  initPreviewFind() {
    const previewFindInput = document.getElementById('preview-find-input');
    const previewFindCount = document.getElementById('preview-find-count');
    this.previewSelections = [];
    this.previewSelectionIndex = -1;

    let previewComposing = false; // 输入法合成中：期间不触发预览搜索，避免卡顿
    const debouncePreview = (fn, delay) => { let t = null; return (...args) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...args), delay); }; };
    const updatePreviewCount = () => {
      if (previewComposing) return;
      const query = previewFindInput.value;
      if (!query) { previewFindCount.textContent = ''; this.clearPreviewHighlight(); return; }
      const caseSensitive = document.getElementById('preview-find-case').checked;
      const useRegex = document.getElementById('preview-find-regex').checked;
      const text = this.preview.textContent;
      let count = 0;
      if (useRegex) {
        if (!isSafeRegex(query)) { previewFindCount.textContent = ''; return; }
        const re = makeRegex(query, caseSensitive ? 'g' : 'gi');
        if (re) { const c = safeMatchCount(text, re); count = c < 0 ? '∞' : c; }
      } else {
        const lower = caseSensitive ? text : text.toLowerCase();
        const q = caseSensitive ? query : query.toLowerCase();
        let pos = 0;
        while ((pos = lower.indexOf(q, pos)) !== -1) { count++; pos += q.length; }
      }
      if (count === '∞') { previewFindCount.textContent = this.t('tooManyMatches') || '∞'; }
      else previewFindCount.textContent = count > 0 ? count + this.t('matches') : this.t('noMatches');
      if (query && count !== '∞' && count > 0) {
        this.highlightPreviewMatches(query, caseSensitive, useRegex);
      } else {
        this.clearPreviewHighlights();
      }
    };

    const doPreviewFind = (reverse = false) => {
      const query = previewFindInput.value;
      if (!query) return;
      const caseSensitive = document.getElementById('preview-find-case').checked;
      const useRegex = document.getElementById('preview-find-regex').checked;

      const text = this.preview.textContent;
      let matches = [];
      
      if (useRegex) {
        if (!isSafeRegex(query)) return;
        const regex = makeRegex(query, caseSensitive ? 'g' : 'gi');
        if (regex) {
          let m;
          while ((m = regex.exec(text)) !== null) {
            matches.push({ start: m.index, end: m.index + m[0].length });
            if (matches.length > 10000) break;
          }
        }
      } else {
        const flags = caseSensitive ? 'g' : 'gi';
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escapedQuery, flags);
        let m;
        while ((m = regex.exec(text)) !== null) {
          matches.push({ start: m.index, end: m.index + m[0].length });
          if (matches.length > 10000) break;
        }
      }

      if (matches.length === 0) return;

      let currentPos = 0;
      const selection = window.getSelection();
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const preRange = document.createRange();
        preRange.selectNodeContents(this.preview);
        preRange.setEnd(range.endContainer, range.endOffset);
        currentPos = preRange.toString().length;
      }

      const loop = document.getElementById('preview-find-loop').checked;
      let targetMatch = null;
      if (reverse) {
        let found = false;
        for (let i = matches.length - 1; i >= 0; i--) {
          if (matches[i].end < currentPos) { targetMatch = matches[i]; found = true; break; }
        }
        if (!found && loop) targetMatch = matches[matches.length - 1];
      } else {
        let found = false;
        for (let i = 0; i < matches.length; i++) {
          if (matches[i].start >= currentPos) { targetMatch = matches[i]; found = true; break; }
        }
        if (!found && loop) targetMatch = matches[0];
      }

      if (targetMatch) this.highlightPreviewMatch(targetMatch);
    };

    this.highlightPreviewMatch = (target) => {
      const walker = document.createTreeWalker(this.preview, NodeFilter.SHOW_TEXT, null, false);
      let node;
      let charCount = 0;
      while (node = walker.nextNode()) {
        const nodeLen = node.nodeValue.length;
        if (charCount + nodeLen > target.start) {
          const startOffset = target.start - charCount;
          // 匹配可能跨多个文本节点（如 <strong> 边界），endOffset 在本节点内钳制，
          // 避免 range.setEnd 越界抛 IndexSizeError（历史 bug：跨节点匹配直接崩掉高亮）
          const endOffset = Math.min(target.end - charCount, nodeLen);
          const range = document.createRange();
          range.setStart(node, startOffset);
          range.setEnd(node, Math.max(endOffset, startOffset));
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          range.startContainer.parentElement.scrollIntoView({ behavior: 'auto', block: 'center' });
          return;
        }
        charCount += nodeLen;
      }
    };

    this.clearPreviewHighlight = () => {
      this.clearPreviewHighlights();
    };

    // 输入防抖 + 输入法合成守卫：避免预览框边输边搜卡死
    const debouncedPreviewUpdate = debouncePreview(() => updatePreviewCount(), 160);
    previewFindInput.addEventListener('input', debouncedPreviewUpdate);
    previewFindInput.addEventListener('compositionstart', () => { previewComposing = true; });
    previewFindInput.addEventListener('compositionend', () => {
      previewComposing = false;
      updatePreviewCount(); // 合成结束立即搜索一次
    });
    document.getElementById('preview-find-case').addEventListener('change', updatePreviewCount);
    document.getElementById('preview-find-regex').addEventListener('change', updatePreviewCount);

    document.getElementById('preview-find-next').addEventListener('click', () => doPreviewFind(false));
    document.getElementById('preview-find-prev').addEventListener('click', () => doPreviewFind(true));
    document.getElementById('preview-find-close').addEventListener('click', () => {
      document.getElementById('preview-find-panel').classList.add('hidden');
      this.clearPreviewHighlight();
    });

    previewFindInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doPreviewFind(e.shiftKey);
      }
      if (e.key === 'Escape') {
        document.getElementById('preview-find-panel').classList.add('hidden');
        this.clearPreviewHighlight();
      }
    });
  }

  toggleFindPanel(replaceMode = false) {
    // 互斥：打开页面内查找时关闭跨文件搜索弹框
    const csDlg = document.getElementById('cross-search-dialog');
    if (csDlg) csDlg.classList.add('hidden');
    if (this.viewMode === 'preview') {
      const panel = document.getElementById('preview-find-panel');
      const isHidden = panel.classList.contains('hidden');
      document.getElementById('find-panel').classList.add('hidden');
      panel.classList.toggle('hidden');
      if (isHidden) {
        const input = document.getElementById('preview-find-input');
        const selection = window.getSelection();
        if (selection.toString()) {
          input.value = selection.toString();
        }
        input.focus();
        input.select();
        if (input.value) this.highlightPreviewMatches(input.value, document.getElementById('preview-find-case').checked, document.getElementById('preview-find-regex').checked);
      } else {
        this.clearPreviewHighlights();
      }
    } else {
      const panel = document.getElementById('find-panel');
      const isHidden = panel.classList.contains('hidden');
      document.getElementById('preview-find-panel').classList.add('hidden');
      panel.classList.toggle('hidden');
      if (isHidden) {
        const input = document.getElementById('find-input');
        if (this.cm.somethingSelected()) {
          input.value = this.cm.getSelection();
        }
        input.focus();
        input.select();
        this.highlightAllMatches();
        // 预览框（编辑模式下与编辑框并排）同样黄色高亮
        this.highlightPreviewMatches(input.value, document.getElementById('find-case').checked, document.getElementById('find-regex').checked);
      } else {
        this.clearFindHighlights();
      }
    }
  }

  closeFindPanel() {
    document.getElementById('find-panel').classList.add('hidden');
    document.getElementById('preview-find-panel').classList.add('hidden');
    this.clearPreviewHighlight();
    this.clearFindHighlights();
    if (this.viewMode === 'edit') {
      this.cm.focus();
    }
  }

  highlightAllMatches() {
    // 全部高亮：用 getSearchCursor 遍历所有匹配，markText 加 .search-match 类。
    // 上限 2000 防止超大文档卡顿；超限仅高亮前 2000 个（计数仍由 updateCount 准确显示）。
    this.clearFindHighlights();
    const findInput = document.getElementById('find-input');
    if (!findInput) return;
    const query = findInput.value;
    if (!query) return;
    const caseSensitive = document.getElementById('find-case').checked;
    const useRegex = document.getElementById('find-regex').checked;
    let re;
    try {
      if (useRegex) {
        if (!FindReplace.isSafeRegex(query)) return;
        re = new RegExp(query, caseSensitive ? 'g' : 'gi');
      } else {
        re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
      }
    } catch { return; }
    const LIMIT = 2000;
    this.cm.operation(() => {
      const cursor = this.cm.getSearchCursor(re, { line: 0, ch: 0 }, { caseFold: !caseSensitive });
      let count = 0;
      while (cursor.findNext()) {
        if (count >= LIMIT) break;
        try {
          const mark = this.cm.markText(cursor.from(), cursor.to(), { className: 'search-match' });
          this.findMarks.push(mark);
        } catch (_) {}
        count++;
      }
    });
  }

  clearFindHighlights() {
    if (this.findMarks && this.findMarks.length) {
      this.findMarks.forEach(m => { try { m.clear(); } catch (_) {} });
    }
    this.findMarks = [];
  }

  // 跨文件搜索高亮：独立于文件内查找（findMarks），便于两种查找互斥时各自清理互不干扰
  clearCrossSearchHighlights() {
    if (!this.crossSearchMarks) { this.crossSearchMarks = []; return; }
    this.crossSearchMarks.forEach(m => { try { m.clear(); } catch (_) {} });
    this.crossSearchMarks = [];
  }

  // 预览高亮：在 #preview 的文本节点中把匹配片段包裹为 <mark class="search-match">，
  // 与编辑器高亮共用同一配色（醒目黄色）。从后往前包裹，避免节点切分影响更早偏移。
  clearPreviewHighlights() {
    const pv = this.preview;
    if (!pv) { this._safeClearSelection(); return; }
    const marks = pv.querySelectorAll('mark.preview-search-hl');
    marks.forEach(mk => {
      const parent = mk.parentNode;
      while (mk.firstChild) parent.insertBefore(mk.firstChild, mk);
      parent.removeChild(mk);
    });
    pv.normalize();
    this._safeClearSelection();
  }

  // 仅清空落在 #preview 内的文档选区。
  // 关键修复：若焦点落在搜索框 / 编辑器等可编辑元素上（其选区不在 #preview 内），
  // 绝不调用 window.getSelection().removeAllRanges()——WebView2/Chromium 下该调用会令
  // 当前聚焦的 <input> 失焦，表现为「搜索框里打一个字符光标就移走」。
  _safeClearSelection() {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const pv = this.preview;
    // 选区锚点不在预览内（例如在搜索输入框里）→ 不动它，避免抢焦点
    if (!pv || !pv.contains(sel.anchorNode)) return;
    sel.removeAllRanges();
  }

  highlightPreviewMatches(query, caseSensitive, useRegex) {
    const pv = this.preview;
    if (!pv) return;
    this.clearPreviewHighlights();
    if (!query) return;
    const text = pv.textContent;
    if (!text) return;
    const matches = [];
    const LIMIT = 2000;
    if (useRegex) {
      if (!FindReplace.isSafeRegex(query)) return;
      let re;
      try { re = new RegExp(query, caseSensitive ? 'g' : 'gi'); } catch { return; }
      let m;
      while ((m = re.exec(text)) !== null) {
        matches.push([m.index, m.index + m[0].length]);
        if (matches.length >= LIMIT) break;
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    } else {
      const hay = caseSensitive ? text : text.toLowerCase();
      const q = caseSensitive ? query : query.toLowerCase();
      let pos = 0;
      while ((pos = hay.indexOf(q, pos)) !== -1) {
        matches.push([pos, pos + q.length]);
        pos += q.length;
        if (matches.length >= LIMIT) break;
      }
    }
    if (!matches.length) return;
    const walker = document.createTreeWalker(pv, NodeFilter.SHOW_TEXT, null, false);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) { if (node.nodeValue) nodes.push(node); }
    let mi = 0;
    let charCount = 0;
    for (const n of nodes) {
      const len = n.nodeValue.length;
      const nodeMatches = [];
      while (mi < matches.length && matches[mi][0] >= charCount && matches[mi][1] <= charCount + len) {
        nodeMatches.push([matches[mi][0] - charCount, matches[mi][1] - charCount]);
        mi++;
      }
      while (mi < matches.length && matches[mi][0] >= charCount && matches[mi][0] < charCount + len && matches[mi][1] > charCount + len) mi++;
      for (let k = nodeMatches.length - 1; k >= 0; k--) {
        const s = nodeMatches[k][0], e = nodeMatches[k][1];
        const range = document.createRange();
        range.setStart(n, s);
        range.setEnd(n, e);
        const mark = document.createElement('mark');
        mark.className = 'search-match preview-search-hl';
        try { range.surroundContents(mark); } catch (_) {}
      }
      charCount += len;
    }
  }

  openCrossSearchDialog() {
    const dlg = document.getElementById('cross-search-dialog');
    if (!dlg) return;
    dlg.classList.remove('hidden');
    // 互斥：打开跨文件搜索时关闭页面内查找并清除高亮，避免两种查找同时干扰编辑器/预览
    document.getElementById('find-panel').classList.add('hidden');
    document.getElementById('preview-find-panel').classList.add('hidden');
    this.clearFindHighlights();
    this.clearPreviewHighlights();
    this.clearCrossSearchHighlights();
    // 浮动面板定位：首次显示在右上角避免遮挡正文；已拖动过则保持上次位置并夹取在视口内
    const panel = document.getElementById('cs-panel');
    if (panel) {
      const w = panel.offsetWidth || 560;
      const vw = window.innerWidth || 1200;
      const vh = window.innerHeight || 800;
      let left = panel.style.left ? parseInt(panel.style.left, 10) : Math.max(12, vw - w - 24);
      let top = panel.style.top ? parseInt(panel.style.top, 10) : Math.max(12, Math.round(vh * 0.08));
      left = Math.max(0, Math.min(left, vw - 80));
      top = Math.max(0, Math.min(top, vh - 40));
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
    }
    // 默认目录：当前文件所在目录
    const dirInput = document.getElementById('cs-dir');
    if (this.activeTab && this.activeTab.filePath) {
      const fp = this.activeTab.filePath;
      const m = fp.match(/[/\\][^/\\]*$/);
      dirInput.value = m ? fp.substring(0, m.index) : fp;
    }
    const q = document.getElementById('cs-query');
    if (this.cm && this.cm.somethingSelected()) q.value = this.cm.getSelection();
    q.focus();
    q.select();
  }

  // 文件搜索（VS Code 风格 Ctrl+P，合并自 PR #36）：委托给 modules/file-search.js 的全局函数。
  // 该模块负责扫描工作区、渲染列表与键盘导航；此处仅做初始化与入口转发，保持 IPC 收敛在模块内。
  openFileSearchDialog() {
    if (typeof openFileSearchDialog === 'function') openFileSearchDialog();
  }

  initFileSearchModule() {
    if (typeof initFileSearch === 'function') initFileSearch();
  }

  initCrossSearch() {
    const dlg = document.getElementById('cross-search-dialog');
    if (!dlg) return;
    // 标题栏拖动 + 缩放统一交由 dialog-drag-resize.js（在 initDialogsDragResize 中遍历所有 .dialog-overlay 接入），
    // 此处不再自写拖动逻辑，保证一套逻辑复用所有弹框。

    document.getElementById('cs-close').addEventListener('click', () => {
      dlg.classList.add('hidden');
      this.clearCrossSearchHighlights();
      this.clearPreviewHighlights();
    });
    const updateDirRow = () => {
      const isDir = document.querySelector('input[name="cs-scope"]:checked')?.value === 'dir';
      document.getElementById('cs-dir-row').classList.toggle('hidden', !isDir);
    };
    document.querySelectorAll('input[name="cs-scope"]').forEach(r => r.addEventListener('change', updateDirRow));
    document.getElementById('cs-browse').addEventListener('click', async () => {
      const sel = await dialogOpen({ directory: true });
      if (sel) document.getElementById('cs-dir').value = Array.isArray(sel) ? sel[0] : sel;
    });
    document.getElementById('cs-run').addEventListener('click', () => this.runCrossSearch());
    document.getElementById('cs-query').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // 已有结果且 query 未变 → 跳到下一个匹配（循环查找可选）；否则重新搜索
        if (this.crossSearchFlat && this.crossSearchFlat.length && this.csLastQuery === e.target.value) {
          this.csNextMatch();
        } else {
          this.runCrossSearch();
        }
      }
      if (e.key === 'Escape') dlg.classList.add('hidden');
    });
  }

  // 跨文件搜索 - 打开文件范围：遍历 this.tabs，ensureTabLoaded 后对 content 按行搜索。
  async searchOpenFiles(query, caseSensitive, useRegex) {
    const results = [];
    let re = null;
    if (useRegex) {
      if (!FindReplace.isSafeRegex(query)) return results;
      try { re = new RegExp(query, caseSensitive ? 'g' : 'gi'); } catch { return results; }
    }
    const qLower = query.toLowerCase();
    for (let i = 0; i < this.tabs.length; i++) {
      const tab = this.tabs[i];
      await this.ensureTabLoaded(tab);
      const content = tab.content || '';
      const lines = content.split('\n');
      const matches = [];
      const LIMIT = 500;
      for (let j = 0; j < lines.length && matches.length < LIMIT; j++) {
        const line = lines[j];
        let col = -1, len = 0;
        if (re) {
          re.lastIndex = 0;
          const m = re.exec(line);
          if (m) { col = m.index; len = m[0].length; }
        } else {
          const hay = caseSensitive ? line : line.toLowerCase();
          const idx = hay.indexOf(caseSensitive ? query : qLower);
          if (idx >= 0) { col = idx; len = query.length; }
        }
        if (col >= 0) {
          matches.push({ line: j + 1, col: col + 1, len, line_text: line.substring(0, 300) });
        }
      }
      if (matches.length) {
        results.push({ tabIndex: i, filePath: tab.filePath || '', name: tab.name || '', path: tab.filePath || tab.name || '', matches });
      }
    }
    return results;
  }

  async runCrossSearch() {
    const query = document.getElementById('cs-query').value;
    if (!query) return;
    const caseSensitive = document.getElementById('cs-case').checked;
    const useRegex = document.getElementById('cs-regex').checked;
    const scope = document.querySelector('input[name="cs-scope"]:checked')?.value || 'open';
    const progress = document.getElementById('cs-progress');
    const totalEl = document.getElementById('cs-total');
    const resultsEl = document.getElementById('cs-results');
    progress.classList.remove('hidden');
    progress.textContent = this.t('searchRunning');
    totalEl.textContent = '';
    resultsEl.innerHTML = '';
    this.csLastQuery = query;
    this.clearCrossSearchHighlights();
    this.crossSearchFlat = [];
    this.crossSearchPos = -1;
    try {
      let results;
      if (scope === 'open') {
        results = await this.searchOpenFiles(query, caseSensitive, useRegex);
      } else {
        const dir = document.getElementById('cs-dir').value;
        if (!dir) { totalEl.textContent = this.t('noResults'); progress.classList.add('hidden'); return; }
        const raw = await TauriApi.searchInFiles({ dir, pattern: query, caseSensitive, useRegex, extensions: [] });
        results = raw.map(r => ({ path: r.path, matches: r.matches.map(m => ({ line: m.line, col: m.col, len: 0, line_text: m.line_text })) }));
      }
      // 扁平化匹配列表，供“下一个 / 循环查找”导航
      for (const f of results) {
        for (const m of f.matches) {
          this.crossSearchFlat.push({ filePath: f.path, line: m.line, col: m.col, len: m.len || 0 });
        }
      }
      this.renderCrossSearchResults(results, query);
    } catch (e) {
      this.reportError('E_IO', { context: { query }, error: e });
    } finally {
      progress.classList.add('hidden');
    }
  }

  // 跳到下一个匹配：勾选“循环查找”时在末尾回到第一个，否则停在最后一条
  csNextMatch() {
    const flat = this.crossSearchFlat;
    if (!flat || !flat.length) return;
    const loop = document.getElementById('cs-loop') ? document.getElementById('cs-loop').checked : false;
    let next = this.crossSearchPos + 1;
    if (next >= flat.length) {
      if (!loop) return; // 不循环则停在最后
      next = 0;
    }
    this.crossSearchPos = next;
    const m = flat[next];
    this.csHighlightCurrent();
    this.jumpToMatch(m.filePath, m.line, m.col, m.len);
  }

  csHighlightCurrent() {
    const items = document.querySelectorAll('#cs-results .cs-match');
    items.forEach((el, i) => el.classList.toggle('current', i === this.crossSearchPos));
    const cur = items[this.crossSearchPos];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  renderCrossSearchResults(results, query) {
    const totalEl = document.getElementById('cs-total');
    const resultsEl = document.getElementById('cs-results');
    const total = results.reduce((s, r) => s + r.matches.length, 0);
    if (total === 0) {
      totalEl.textContent = this.t('noResults');
      resultsEl.innerHTML = '';
      return;
    }
    totalEl.textContent = this.t('totalMatches', { n: total });
    resultsEl.innerHTML = '';
    for (const file of results) {
      const group = document.createElement('div');
      group.className = 'cs-file-group';
      const header = document.createElement('div');
      header.className = 'cs-file-header';
      header.textContent = `${file.path || file.name} (${file.matches.length})`;
      group.appendChild(header);
      for (const m of file.matches) {
        const item = document.createElement('div');
        item.className = 'cs-match';
        const snippet = (m.line_text || '').trim().substring(0, 120);
        item.textContent = `${m.line}:${m.col}  ${snippet}`;
        item.addEventListener('click', () => this.jumpToMatch(file.path, m.line, m.col, m.len || 0));
        group.appendChild(item);
      }
      resultsEl.appendChild(group);
    }
  }

  async jumpToMatch(filePath, line, col, len) {
    const prevViewMode = this.viewMode;
    if (filePath) {
      await this.openFilePath(filePath);
      // openFilePath 打开新文件时会切到 preview，这里恢复原视图模式，避免每次跳转改变用户视图
      if (this.viewMode !== prevViewMode) {
        this.viewMode = prevViewMode;
        this.applyViewMode();
      }
    }
    const pos = { line: Math.max(0, line - 1), ch: Math.max(0, col - 1) };
    // 编辑区跳转目标行；大文档滑动窗口需先以该行为焦点重渲染，否则匹配行不在窗口片段内无法定位
    this._previewFocusLine = pos.line;
    this._previewScrollDriven = false;
    await this.ensureTabLoaded(this.activeTab);
    // 确保预览已用新文件内容渲染完（异步），便于后续预览高亮准确定位
    await this.updatePreview();
    this.cm.focus();
    // 计算高亮区间：优先用后端返回的 len；目录搜索 len=0 时按查询在行内定位
    let from = pos, to = pos;
    const query = this.csLastQuery || '';
    const cs = document.getElementById('cs-case').checked;
    const ur = document.getElementById('cs-regex').checked;
    if (len > 0) {
      to = { line: pos.line, ch: pos.ch + len };
    } else if (query) {
      const lineText = this.cm.getLine(pos.line) || '';
      let matchLen = 0;
      if (ur) {
        try {
          const re = new RegExp(query, cs ? '' : 'i');
          const m = lineText.slice(pos.ch).match(re);
          if (m) matchLen = m[0].length;
        } catch (_) { /* 非法正则忽略 */ }
      } else {
        const hay = cs ? lineText : lineText.toLowerCase();
        const q = cs ? query : query.toLowerCase();
        const idx = hay.indexOf(q, pos.ch);
        if (idx !== -1) matchLen = q.length;
      }
      if (matchLen > 0) to = { line: pos.line, ch: pos.ch + matchLen };
    }
    // 编辑框黄色高亮：清除上一次跨文件高亮，标记当前匹配
    this.clearCrossSearchHighlights();
    if (to.ch !== pos.ch || to.line !== pos.line) {
      this.cm.setSelection(from, to);
      try {
        const mark = this.cm.markText(from, to, { className: 'search-match' });
        this.crossSearchMarks.push(mark);
      } catch (_) {}
    } else {
      this.cm.setCursor(pos);
    }
    this.cm.scrollIntoView(pos, 100);
    // 预览同步滚动到匹配行：预览 / 分屏模式下用户才能直观看到“跳转”
    try {
      this._buildWindowLineTops();
      this._focusPreviewToLine(pos.line);
    } catch (_) {}
    // 预览框黄色高亮（编辑与预览两种模式下预览均可见）
    if (query && (this.viewMode === 'preview' || this.viewMode === 'edit')) {
      this.highlightPreviewMatches(query, cs, ur);
    }
  }

  initScrollTopBtn() {
    const scrollTopBtn = document.getElementById('scroll-top-btn');
    this.preview.addEventListener('scroll', () => {
      if (this.preview.scrollTop > 200) {
        scrollTopBtn.classList.remove('hidden');
      } else {
        scrollTopBtn.classList.add('hidden');
      }
    });
    scrollTopBtn.addEventListener('click', () => {
      this.preview.scrollTo({ top: 0, behavior: 'auto' });
    });
  }

  initExternalLinks() {
    this.preview.addEventListener('click', async (e) => {
      const img = e.target.closest('img');
      if (img && img.src) {
        e.preventDefault();
        e.stopPropagation();
        this.showImageLightbox(img.src);
        return;
      }

      const mermaidContainer = e.target.closest('.mermaid-container');
      if (mermaidContainer) {
        e.preventDefault();
        e.stopPropagation();
        // 锚点必须是容器而非 svg：closest('.mermaid-container svg') 只匹配「自身是 svg 且
        // 祖先有 container」的节点——点击 svg 内部（rect/text 等）能向上命中 svg，但点击
        // 容器内边距（两侧灰色区，target 是 div 本身）匹配不到，lightbox 打不开。
        // 改为容器锚点 + 内部取 svg：中央与空白区点击都能打开图表查看器。
        const svg = mermaidContainer.querySelector('svg');
        if (svg) this.showLightbox(svg, 'svg');
        return;
      }

      // 任务列表 checkbox：点击切换 [ ] <-> [x] 并回写源码
      const checkbox = e.target.closest('input[type="checkbox"]');
      if (checkbox) {
        // 注意：这里【不】调用 e.preventDefault()。一旦拦截默认行为，原生复选框不会
        // 切换，需手动设置 checkbox.checked —— 但 appearance:none 的自定义勾选框在
        // 真实 WebView 里手动改 checked 不一定重绘 :checked 样式，且我们用
        // _suppressNextPreviewRerender 抑制了整篇重渲染，结果就是「点了没反应」。
        // 正确做法：放行原生默认切换（浏览器自己画勾选态，必然有响应），处理器只
        // 按源码反推目标态写回 [ ]/[x]，不再手动动 checkbox.checked。
        e.stopPropagation();
        this.handleTaskCheckboxToggle(checkbox);
        return;
      }

      const link = e.target.closest('a');
      if (!link) return;

      e.preventDefault();
      e.stopPropagation();

      const href = link.getAttribute('href');
      if (!href) return;

      if (href.startsWith('#')) {
        // href 经 rehype-stringify 后非 ASCII 会被 URL 编码（如 #数学公式 → #%E6%95%B0...），
        // 需 decode 才能匹配 heading 的字面 id（id="数学公式"）。
        const id = decodeURIComponent(href.substring(1));
        const target = this.preview.querySelector(`#${CSS.escape(id)}`);
        if (target) {
          const previewHeight = this.preview.clientHeight;
          const targetRect = target.getBoundingClientRect();
          const previewRect = this.preview.getBoundingClientRect();
          const top = targetRect.top - previewRect.top + this.preview.scrollTop
                    - (previewHeight / 2) + (targetRect.height / 2);
          this.preview.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
          target.classList.add('footnote-flash');
          setTimeout(() => target.classList.remove('footnote-flash'), 1300);
        }
        return;
      }

      // 外部 http(s) 链接：即便以 .md 结尾也是 gitee/github 等网页，
      // 一律用系统浏览器打开；不要在 app 内 fetch 渲染（webview 跨域 fetch 必失败且无意义）。
      if (href.startsWith('http://') || href.startsWith('https://')) {
        this.openExternal(href);
        return;
      }

      if (isMarkdownLink(href)) {
        try {
          if (href.startsWith('http://') || href.startsWith('https://')) {
            const resp = await fetch(href);
            if (resp.ok) {
              const content = await resp.text();
              const name = href.split('/').pop();
              this.addTab(name, content, null);
              this.activeTab.savedContent = content;
              this.updateTabDisplay();
              return;
            }
          } else if (TauriApi.isAvailable()) {
            // 本地相对链接：相对当前文档所在目录解析成绝对路径，
            // 直接读取文件（不要 fetch webview 源，否则会被 SPA 回退返回 index.html）。
            const tab = this.activeTab;
            if (tab && tab.filePath) {
              const normHref = this.normalizeLinkHref(href);
              // 简单文件名链接：可能是 bundled 资源（demo.md / guide.md 等，dev 项目根 /
              // prod 资源目录）。先 read_bundled_file 探针——命中走 _openBundledFile
              // （isBundled=true，否则 processImages 不启用 read_bundled_image_as_base64
              // 回退，demo.md 内相对图片会显示失败框）；未命中（用户自己的笔记）再走下方
              // 本地路径，行为不变。
              if (!/[\/\\]/.test(normHref)) {
                try {
                  const probe = await TauriApi.readBundledFile({ filename: normHref });
                  const probeContent = probe && typeof probe === 'object' ? probe.content : probe;
                  if (probeContent && !probeContent.trim().startsWith('<!DOCTYPE') && !probeContent.trim().startsWith('<html')) {
                    const probePath = probe && typeof probe === 'object' ? probe.path : normHref;
                    await this._openBundledFile(href, probeContent, probePath);
                    return;
                  }
                } catch (_) { /* 非 bundled 资源，走下方本地路径 */ }
              }
              const targetPath = resolveDocPath(tab.filePath, normHref);
              const existingIndex = this.tabs.findIndex(t => t.filePath === targetPath);
              if (existingIndex !== -1) {
                this.switchTab(existingIndex);
                return;
              }
              const content = await this.readFileNormalized(targetPath);
              const name = targetPath.split(/[/\\]/).pop();
              this.addTab(name, content, targetPath);
              this.activeTab.savedContent = content;
              this.updateTabDisplay();
              return;
            }
            // 无活动文件（如「使用说明」等打包资源 Tab）：
            // 1) 绝对路径链接（D:\... / D:/... / /...）直接用 Rust read_file 读取，不要走 fetch/URL；
            // 2) 相对打包资源（如 demo.md）走专用命令 read_bundled_file，dev/prod 都能找到。
            const normHref = this.normalizeLinkHref(href);
            if (/^[a-zA-Z]:[\\/]/.test(normHref) || normHref.startsWith('/')) {
              try {
                const content = await this.readFileNormalized(normHref);
                if (content && !content.trim().startsWith('<!DOCTYPE') && !content.trim().startsWith('<html')) {
                  await this._openBundledFile(href, content, normHref);
                  return;
                }
              } catch (err) {
                console.error('Failed to open absolute markdown link:', href, err);
                this.reportError('openLink', { params: { href }, error: err });
                return;
              }
            }
            // 相对打包资源（demo.md / screenshots/* 等）：read_bundled_file 在 dev 模式
            // 回退到项目根读取，prod 模式从资源目录读取，统一入口。
            try {
              const result = await TauriApi.readBundledFile({ filename: normHref });
              // 返回 { content, path }：path 是实际读取到的本地路径，
              // dev 模式 = 项目根（D:/project/tizu-mark/demo.md），
              // 生产 = 资源目录（C:/Program Files/.../resources/demo.md）。
              // 用它设 tab.filePath，让 demo.md 内的相对图片能按真实目录解析。
              const content = result && typeof result === 'object' ? result.content : result;
              const realPath = result && typeof result === 'object' ? result.path : normHref;
              if (content && !content.trim().startsWith('<!DOCTYPE') && !content.trim().startsWith('<html')) {
                await this._openBundledFile(href, content, realPath);
                return;
              }
            } catch (err) {
              console.error('Failed to open bundled markdown link:', href, err);
              this.reportError('openLink', { params: { href }, error: err });
            }
          } else {
            const resp = await fetch(href);
            if (resp.ok) {
              const content = await resp.text();
              const name = href.split(/[/\\]/).pop();
              this.addTab(name, content, null);
              this.activeTab.savedContent = content;
              this.updateTabDisplay();
              return;
            }
          }
        } catch (err) {
          console.error('Failed to open markdown link:', href, err);
          this.reportError('openLink', { params: { href }, error: err });
          return;
        }
      }

      if (href.startsWith('mailto:') || href.startsWith('tel:')) {
        window.location.href = href;
        return;
      }

      try {
        if (!await TauriApi.shellOpen(href)) {
          window.open(href, '_blank', 'noopener,noreferrer');
        }
      } catch (err) {
        window.open(href, '_blank', 'noopener,noreferrer');
      }
    }, true);
  }

  showImageLightbox(src) {
    this.showLightbox(src, 'image');
  }

  showLightbox(content, type) {
    let scale = 1, tx = 0, ty = 0;
    let naturalW = 0, naturalH = 0;
    let isDragging = false, startX = 0, startY = 0, startTx = 0, startTy = 0;

    const wasOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const overlay = document.createElement('div');
    overlay.className = 'image-lightbox';

    let el;
    if (type === 'svg') {
      el = document.createElement('div');
      el.className = 'lightbox-svg-wrapper';
      el.appendChild(content.cloneNode(true));
    } else {
      el = document.createElement('img');
      el.src = content;
      el.referrerPolicy = 'no-referrer';
    }
    const hint = document.createElement('div');
    hint.className = 'lightbox-hint';
    hint.innerHTML = '<span>🖱 滚轮缩放 · 拖动平移 · 双击重置 · Esc 关闭</span><span class="lightbox-hint-close">&times;</span>';
    hint.querySelector('.lightbox-hint-close').addEventListener('click', () => hint.remove());
    overlay.appendChild(hint);
    overlay.appendChild(el);
    document.body.appendChild(overlay);

    const updateTransform = () => {
      el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    };

    const clampTransform = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const maxTx = Math.abs(naturalW * scale - vw) / 2;
      const maxTy = Math.abs(naturalH * scale - vh) / 2;
      tx = Math.max(-maxTx, Math.min(maxTx, tx));
      ty = Math.max(-maxTy, Math.min(maxTy, ty));
    };

    // Fit to viewport on open
    const initFit = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        naturalW = rect.width;
        naturalH = rect.height;
        const fitScale = Math.min(window.innerWidth / naturalW, window.innerHeight / naturalH, 1);
        if (fitScale < 1) {
          scale = fitScale;
          updateTransform();
        }
      } else {
        requestAnimationFrame(initFit);
      }
    };
    if (type === 'image') {
      if (el.complete) {
        requestAnimationFrame(initFit);
      } else {
        el.addEventListener('load', () => requestAnimationFrame(initFit));
      }
    } else {
      requestAnimationFrame(initFit);
    }

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.overflow = wasOverflow;
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    overlay.addEventListener('wheel', (e) => {
      e.preventDefault();
      const oldS = scale;
      scale += e.deltaY < 0 ? 0.15 : -0.15;
      scale = Math.max(0.2, scale);
      const ratio = scale / oldS;
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;
      tx = mx + (tx - mx) * ratio;
      ty = my + (ty - my) * ratio;
      clampTransform();
      updateTransform();
    }, { passive: false });

    el.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startTx = tx;
      startTy = ty;
      el.style.cursor = 'grabbing';
    });

    const onMouseMove = (e) => {
      if (!isDragging) return;
      tx = startTx + (e.clientX - startX);
      ty = startTy + (e.clientY - startY);
      clampTransform();
      updateTransform();
    };
    document.addEventListener('mousemove', onMouseMove);

    const onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      el.style.cursor = '';
    };
    document.addEventListener('mouseup', onMouseUp);

    el.addEventListener('dblclick', () => {
      scale = 1;
      tx = 0;
      ty = 0;
      updateTransform();
    });
  }

  initDragDrop() {
    const app = document.getElementById('app');
    const dragOverlay = document.getElementById('drag-overlay');

    if (TauriApi.isAvailable()) {
      TauriApi.onEvent('tauri://drag-enter', (e) => {
        if (e.payload && e.payload.paths && e.payload.paths.length > 0) {
          app.classList.add('drag-over');
          dragOverlay.classList.remove('hidden');
        }
      });

      TauriApi.onEvent('tauri://drag-over', (e) => {
        if (e.payload && e.payload.paths && e.payload.paths.length > 0) {
          app.classList.add('drag-over');
          dragOverlay.classList.remove('hidden');
        }
      });

      TauriApi.onEvent('tauri://drag-drop', async (event) => {
        app.classList.remove('drag-over');
        dragOverlay.classList.add('hidden');
        // 目录/文件统一分发：目录进工作区（已有不同工作区时弹确认），文件开 tab。
        // 注意：不要在此先 showLoading——加载遮罩 z-index(10000) 会盖住确认框，
        // 导致切换工作区确认框点不到而卡在加载页；加载由 openFolderPath 内部负责。
        await this.openPathsSmart(event.payload.paths || []);
      });

      TauriApi.onEvent('tauri://drag-leave', () => {
        app.classList.remove('drag-over');
        dragOverlay.classList.add('hidden');
      });
    } else {
      app.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes('Files')) {
          app.classList.add('drag-over');
          dragOverlay.classList.remove('hidden');
        }
      });

      app.addEventListener('dragleave', (e) => {
        if (!app.contains(e.relatedTarget)) {
          app.classList.remove('drag-over');
          dragOverlay.classList.add('hidden');
        }
      });

      app.addEventListener('drop', async (e) => {
        e.preventDefault();
        app.classList.remove('drag-over');
        dragOverlay.classList.add('hidden');
        const files = e.dataTransfer.files;
        if (!files || files.length === 0) return;

        for (const file of files) {
          try {
            const content = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(reader.error);
              reader.readAsText(file);
            });
            this.addTab(file.name, content, null);
            this.setStatus(`${this.t('opened')}: ${file.name}`);
          } catch (err) {
            this.setStatus(`${this.t('openFailed')}: ${err}`);
          }
        }
      });
    }
  }

  showSaveDialog(title, message, saveLabel, discardLabel, cancelLabel) {
    return Dialogs.showSaveDialog({
      title, message, saveLabel, discardLabel, cancelLabel,
      t: (k, p) => this.t(k, p),
      doc: document,
    });
  }

  showConfirmDialog(title, message, action = null, warning = null) {
    return Dialogs.showConfirmDialog({
      title, message, action, warning,
      t: (k, p) => this.t(k, p),
      showToast: (msg, type) => this.showToast(msg, type),
      doc: document,
    });
  }

  initInsertDialogs() {
    // Insert Link dialog
    document.getElementById('insert-link-ok').addEventListener('click', () => {
      const text = document.getElementById('insert-link-text').value.trim();
      const url = document.getElementById('insert-link-url').value.trim();
      if (!url) return;
      const linkText = this.escapeMdText(text || url);
      const safeUrl = String(url).replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
      const sel = this.cm.getSelection();
      if (sel) {
        this.cm.replaceSelection(`[${this.escapeMdText(sel)}](${safeUrl})`);
      } else {
        this.insertAtCursor(`[${linkText}](${safeUrl})`, linkText.length + 3);
      }
      this.hideInsertLinkDialog();
      this.cm.focus();
    });
    document.getElementById('insert-link-cancel').addEventListener('click', () => this.hideInsertLinkDialog());
    document.getElementById('insert-link-close').addEventListener('click', () => this.hideInsertLinkDialog());
    document.getElementById('insert-link-dialog').addEventListener('click', (e) => {
      if (e.target.id === 'insert-link-dialog') this.hideInsertLinkDialog();
    });
    document.getElementById('insert-link-url').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('insert-link-ok').click();
    });
    document.getElementById('insert-link-text').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('insert-link-ok').click();
    });

    // Insert Image dialog
    const sourceHost = document.getElementById('insert-image-source');
    if (sourceHost) {
      this._imageSourceSelect = new Select(sourceHost, {
        value: 'local',
        t: this.t.bind(this),
        ariaLabelKey: 'imageSource',
        optionsProvider: (t) => ([
          { value: 'local', label: t('imageSourceLocal') },
          { value: 'web', label: t('imageSourceWeb') },
        ]),
        onChange: (v) => {
          const isLocal = v === 'local';
          document.getElementById('insert-image-local-field').classList.toggle('hidden', !isLocal);
          document.getElementById('insert-image-alt-field').classList.toggle('hidden', !isLocal);
          document.getElementById('insert-image-web-field').classList.toggle('hidden', isLocal);
        },
      });
    }
    document.getElementById('insert-image-browse').addEventListener('click', async () => {
      try {
        const selected = await dialogOpen({
          multiple: false,
          filters: [
            { name: this.t('imageLocal'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'] }
          ]
        });
        if (selected) {
          document.getElementById('insert-image-file').value = selected;
        }
      } catch (_) {}
    });
    document.querySelector('#insert-image-alt-hint .hint-text').textContent = this.t('imageAltHint');
    document.querySelector('#insert-image-store-hint .hint-text').textContent = this.t('imageStoreModeHint');
    document.getElementById('insert-image-ok').addEventListener('click', () => this.handleInsertImageOk());
    document.getElementById('insert-image-cancel').addEventListener('click', () => this.hideInsertImageDialog());
    document.getElementById('insert-image-close').addEventListener('click', () => this.hideInsertImageDialog());
    document.getElementById('insert-image-dialog').addEventListener('click', (e) => {
      if (e.target.id === 'insert-image-dialog') this.hideInsertImageDialog();
    });
  }

  initImagePaste() {
    const wrapper = document.getElementById('editor-wrapper');
    if (!wrapper) return;
    wrapper.addEventListener('paste', (e) => {
      const items = Array.from(e.clipboardData.items).filter(i => i.type.startsWith('image/'));
      if (items.length === 0) return;
      e.preventDefault();
      for (const item of items) {
        const file = item.getAsFile();
        if (file) {
          this.handlePasteImage(file).catch(err => {
            this.setStatus(this.t('imagePasteFailed') + ': ' + err);
          });
        } else {
          this.reportError('clipboardImage');
        }
      }
    });
  }

  showInsertLinkDialog() {
    const sel = this.cm.getSelection();
    document.getElementById('insert-link-text').value = sel || '';
    document.getElementById('insert-link-url').value = '';
    // Clipboard URL detection
    try {
      navigator.clipboard.readText().then(text => {
        if (text && (text.startsWith('http://') || text.startsWith('https://'))) {
          document.getElementById('insert-link-url').value = text;
          const textInput = document.getElementById('insert-link-text');
          if (!textInput.value) {
            textInput.placeholder = this.t('linkAutoDetected');
          }
        }
      }).catch(() => {});
    } catch (_) {}
    document.getElementById('insert-link-dialog').classList.remove('hidden');
    setTimeout(() => document.getElementById('insert-link-text').focus(), 100);
  }

  hideInsertLinkDialog() {
    document.getElementById('insert-link-dialog').classList.add('hidden');
  }

  showInsertImageDialog() {
    if (this._imageSourceSelect) this._imageSourceSelect.setValue('local', true);
    document.getElementById('insert-image-local-field').classList.remove('hidden');
    document.getElementById('insert-image-alt-field').classList.remove('hidden');
    document.getElementById('insert-image-web-field').classList.add('hidden');
    document.getElementById('insert-image-file').value = '';
    document.getElementById('insert-image-url').value = '';
    document.getElementById('insert-image-alt').value = '';
    document.querySelector('#insert-image-alt-hint .hint-text').textContent = this.t('imageAltHint');
    document.querySelector('#insert-image-store-hint .hint-text').textContent = this.t('imageStoreModeHint');
    document.getElementById('insert-image-dialog').classList.remove('hidden');
    setTimeout(() => {
      const browseBtn = document.getElementById('insert-image-browse');
      if (browseBtn) browseBtn.focus();
    }, 100);
  }

  hideInsertImageDialog() {
    document.getElementById('insert-image-dialog').classList.add('hidden');
  }

  async handleInsertImageOk() {
    const alt = document.getElementById('insert-image-alt').value.trim();
    const localField = document.getElementById('insert-image-local-field');
    const isLocal = !localField.classList.contains('hidden');

    if (isLocal) {
      const filePath = document.getElementById('insert-image-file').value.trim();
      if (!filePath) {
        this.showToast(this.t('imageFileRequired'));
        return;
      }
      const storeMode = this.settings.imageInsertMode || 'assets';

      if (storeMode === 'assets') {
        if (!this.activeTab || !this.activeTab.filePath) {
          this.showToast(this.t('needSaveFirst'));
          return;
        }
        await this.insertLocalImageAssets(filePath, alt);
      } else {
        await this.insertLocalImageBase64(filePath, alt);
      }
    } else {
      const url = document.getElementById('insert-image-url').value.trim();
      if (!url) {
        this.showToast(this.t('imageUrlRequired'));
        return;
      }
      this.insertImageBlock(`![${this.escapeMdText(alt || 'image')}](${url})`);
    }
    this.hideInsertImageDialog();
    this.cm.focus();
  }

  async insertLocalImageAssets(filePath, alt) {
    const tab = this.activeTab;
    if (!tab.filePath) {
      this.setStatus(this.t('needSaveFirst'));
      return;
    }
    const { assetsDir, refPrefix } = this.getImageAssetPath();
    const extMatch = filePath.match(/\.([^.]+)$/);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
    try {
      const content = await TauriApi.fetchImageAsBase64({ url: filePath });
      const bytes = Uint8Array.from(atob(content), c => c.charCodeAt(0));
      const info = await TauriApi.saveImageToAssets({ bytes: Array.from(bytes), ext, assetsDir });
      const src = refPrefix + '/' + info.filename;
      const w = info.width || '';
      const h = info.height || '';
      const dimAttr = w ? ` width="${w}" height="${h}"` : '';
      const imgTag = `<img src="${src}"${dimAttr} alt="${this.escapeAttr(alt || info.filename)}">`;
      this.insertImageBlock(imgTag);
      this.setStatus(this.t('imagePasted'));
    } catch (err) {
      this.showToast(this.t('imagePasteFailed') + ': ' + err);
    }
  }

  async insertLocalImageBase64(filePath, alt) {
    try {
      const base64 = await TauriApi.fetchImageAsBase64({ url: filePath });
      const extMatch = filePath.match(/\.([^.]+)$/);
      const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
      let mime = 'image/png';
      if (ext === 'jpg' || ext === 'jpeg') mime = 'image/jpeg';
      else if (ext === 'gif') mime = 'image/gif';
      else if (ext === 'svg') mime = 'image/svg+xml';
      else if (ext === 'webp') mime = 'image/webp';
      else if (ext === 'bmp') mime = 'image/bmp';
      else if (ext === 'ico') mime = 'image/x-icon';
      const dataUrl = `data:${mime};base64,${base64}`;
      this.insertImageBlock(`![${alt || 'image'}](${dataUrl})`);
      this.setStatus(this.t('imagePasted'));
    } catch (err) {
      this.showToast(this.t('imagePasteFailed') + ': ' + err);
    }
  }

  async handlePasteImage(file) {
    const mode = this.settings.imageInsertMode || 'assets';
    if (mode === 'assets') {
      if (!this.activeTab || !this.activeTab.filePath) {
        this.showToast(this.t('needSaveFirst'));
        return;
      }
      const { assetsDir, refPrefix } = this.getImageAssetPath();
      const ext = file.type.split('/')[1] || 'png';
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const info = await TauriApi.saveImageToAssets({ bytes: Array.from(bytes), ext, assetsDir });
      const alt = 'image';
      const src = refPrefix + '/' + info.filename;
      const w = info.width || '';
      const h = info.height || '';
      const dimAttr = w ? ` width="${w}" height="${h}"` : '';
      this.insertImageBlock(`<img src="${src}"${dimAttr} alt="${this.escapeAttr(alt)}">`);
      this.setStatus(this.t('imagePasted'));
    } else {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const mime = file.type || 'image/png';
      const dataUrl = `data:${mime};base64,${base64}`;
      this.insertImageBlock(`![image](${dataUrl})`);
      this.setStatus(this.t('imagePasted'));
    }
  }

  newFile() {
    this.addTab(this.t('untitled'), '', null);
    this.setViewMode('edit');
    this.setStatus(this.t('newFileCreated'));
  }

  async reloadFile() {
    const tab = this.activeTab;
    if (!tab || !tab.filePath) {
      this.setStatus(this.t('noFileToReload') || '当前文件无关联路径，无法重新加载');
      return;
    }
    this.showLoading();
    try {
      const scrollInfo = this.cm.getScrollInfo();
      const cursorPos = this.cm.getCursor();
      const previewScrollTop = this.preview.scrollTop;
      const content = await TauriApi.readFile({ path: tab.filePath });
      tab.content = content;
      tab.savedContent = content;
      // 重新加载：markdown 和图片都可能在外部被改动，清图片 base64 缓存强制重读
      this._imageBase64Cache.clear();
      this.cm.setValue(content);
      // 取消 change 事件调度的 debounced 预览更新，后续显式调用 updatePreview 替代
      clearTimeout(this.debounceTimer);
      this.cm.setCursor(cursorPos);
      this.cm.clearHistory();
      await this.updatePreview();
      // 统一恢复该 tab 记忆的编辑器/预览滚动位置（临时关闭滚动同步避免互相重定位）
      this._restoreSwitchScroll(scrollInfo, previewScrollTop);
      this.updateWordCount();
      this.updateOutline();
      this.updateTabDisplay();
      this.setStatus(`${this.t('reloaded') || '已重新加载'}: ${tab.name}`);
    } catch (err) {
      this.reportError('E_IO', { context: { path: tab.filePath }, error: err, params: { name: tab.name } });
    } finally {
      this.hideLoading();
    }
  }

  async openFile() {
    try {
      const selected = await dialogOpen({
        multiple: true,
        filters: [
          { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
          { name: this.t('allFiles'), extensions: ['*'] }
        ]
      });

      if (!selected) return;
      this.showLoading();
      const files = Array.isArray(selected) ? selected : [selected];
      let openedCount = 0;

      for (const filePath of files) {
        const existingIndex = this.tabs.findIndex(t => t.filePath === filePath);
        if (existingIndex !== -1) {
          this.switchTab(existingIndex);
          continue;
        }
        try {
          const content = await this.readFileNormalized(filePath);
          const name = filePath.split(/[/\\]/).pop();
          this.addTab(name, content, filePath);
          openedCount++;
        } catch (e) {
          console.error('Failed to open file:', filePath, e);
        }
      }
      this.syncViewModeToTab();
      this.applyViewMode();
      this.updateWordCount();
      this.setStatus(openedCount > 0 ? this.t('openedFiles', { n: openedCount }) : this.t('alreadyOpen'));
    } catch (error) {
      // 多选打开时单个文件失败：弹 toast 而非仅 console，避免用户无感
      this.reportError(error.code || 'E_IO', { context: { path: error.path }, error, params: error.params, detail: error.detail });
    } finally {
      this.hideLoading();
    }
  }

  loadSession() {
    try {
      const raw = localStorage.getItem('tizumark-session');
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || data.version !== 2) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  saveSession() {
    try {
      const tabs = this.tabs
        .filter(t => t.filePath)
        .map(t => ({
          name: t.name,
          filePath: t.filePath,
          cursorPos: t.cursorPos || { line: 0, ch: 0 },
          scrollPos: t.scrollPos || { top: 0, left: 0 },
          previewScrollTop: t.previewScrollTop || 0,
          fileMeta: t.fileMeta || null,
        }));
      const data = {
        version: 2,
        activeFilePath: (this.activeTab && this.activeTab.filePath) ? this.activeTab.filePath : null,
        tabs,
        workspaceFolder: this.workspaceFolder || null,
        expandedFolders: this.expandedFolders ? Array.from(this.expandedFolders) : [],
      };
      localStorage.setItem('tizumark-session', JSON.stringify(data));
    } catch (e) { /* ignore */ }
  }

  async restoreSession() {
    const session = this.loadSession();
    if (!session) return false;
    const tabs = session.tabs || [];
    const workspaceFolder = session.workspaceFolder || null;
    if (tabs.length === 0 && !workspaceFolder) return false;

    const restored = [];
    for (const st of tabs) {
      if (!st.filePath) continue;
      const tab = new Tab(st.name || st.filePath.split(/[/\\]/).pop(), '', st.filePath);
      // 恢复时必须按后缀正确分类 kind：否则图片会被当成 markdown，
      // 后续 ensureTabLoaded 仍按文本读取二进制 → 显示成代码
      if (window.FileTypes && window.FileTypes.classifyFile) {
        tab.kind = window.FileTypes.classifyFile(st.filePath);
      }
      tab.cursorPos = st.cursorPos || { line: 0, ch: 0 };
      tab.scrollPos = st.scrollPos || { top: 0, left: 0 };
      tab.previewScrollTop = st.previewScrollTop || 0;
      tab.fileMeta = st.fileMeta || null;
      tab._loaded = false;
      restored.push(tab);
    }
    if (restored.length === 0 && !workspaceFolder) return false;
    if (restored.length === 0) {
      restored.push(new Tab(`${this.t('untitled')}${this.untitledCounter++}`));
    }

    this.tabs = restored;
    this.activeTabIndex = 0;
    if (session.activeFilePath) {
      const idx = this.tabs.findIndex(t => t.filePath === session.activeFilePath);
      if (idx !== -1) this.activeTabIndex = idx;
    }

    const active = this.activeTab;
    if (active && active.filePath) {
      // 图片不按文本读取（否则二进制被当代码显示），与 ensureTabLoaded / switchTab 保持一致
      let _activeKind = active.kind;
      if (active.filePath && window.FileTypes && window.FileTypes.classifyFile) {
        _activeKind = window.FileTypes.classifyFile(active.filePath);
      }
      if (_activeKind === 'image') {
        active.content = '';
        active.savedContent = '';
        active._loaded = true;
      } else {
        try {
          const content = await this.readFileNormalized(active.filePath);
          active.content = content;
          active.savedContent = content;
        } catch (e) {
          // 读盘失败（文件被删除/移动/无权限）：保留标签页但标记为加载失败，
          // 不再静默置空 content/savedContent（避免后续保存用空内容覆盖原文件）
          active.content = '';
          active.savedContent = '';
          active._loadError = true;
          this.reportError('E_NOT_FOUND', { context: { path: active.filePath }, params: { name: active.name }, error: e });
        }
        active._loaded = true;
      }
    } else if (active) {
      active._loaded = true;
    }

    await Promise.all(this.tabs.map(t => this.refreshFileMeta(t)));

    // 同 switchTab：setValue 会同步触发 scroll / cursorActivity 事件，污染 activeTab.scrollPos / cursorPos，先取快照
    const restoreCursor = (active && active.cursorPos) || { line: 0, ch: 0 };
    const restoreScroll = (active && active.scrollPos) || { top: 0, left: 0 };
    const restorePreviewTop = (active && active.previewScrollTop) || 0;

    this.cm.setValue(this.activeTab.content || '');
    this.cm.setCursor(restoreCursor);
    this.cm.clearHistory();
    this.updateTabBar();
    this.updateTabDisplay();
    this.syncViewModeToTab();
    await this.updatePreview();
    // 统一恢复该 tab 记忆的编辑器/预览滚动位置（临时关闭滚动同步避免互相重定位）
    this._restoreSwitchScroll(restoreScroll, restorePreviewTop);
    this.updateOutline();
    this.updateWordCount();
    this.highlightTreeActiveFile();

    if (workspaceFolder) {
      this.workspaceFolder = workspaceFolder;
      this.expandedFolders = new Set(session.expandedFolders || []);
      await this.renderFolderTree();
      this.showSidebar();
      this.saveSession();
      this.startFolderWatch();
    }
    return true;
  }

  async openFilePath(filePath) {
    this._largeFileNoticeDismissed = false;
    this._previewFocusLine = 0;
    this.previewWindow = null;
    // 类型判断：unsupported 直接提示，不打开
    const kind = (window.FileTypes && window.FileTypes.classifyFile)
      ? window.FileTypes.classifyFile(filePath)
      : 'markdown';
    if (kind === 'unsupported') {
      this.showToast(this.t('formatUnsupported'), 'warning');
      this.setStatus(this.t('formatUnsupported'));
      return;
    }
    this._beginPaneLoad();
    try {
      const existingIndex = this.tabs.findIndex(t => t.filePath === filePath);
      if (existingIndex !== -1) {
        await this.switchTab(existingIndex);
        this.saveSession();
        return;
      }
      // 图片：不读文本内容，预览面板内显示图片
      if (kind === 'image') {
        const name = filePath.split(/[/\\]/).pop();
        await this.addTab(name, '', filePath, 'image');
        this.viewMode = 'preview';
        this.applyViewMode();
        this.updateWordCount();
        this.setStatus(this.t('fileOpened', { name }));
        this.saveSession();
        return;
      }
      const content = await this.readFileNormalized(filePath);
      const name = filePath.split(/[/\\]/).pop();
      // text：按原始文本显示（不按 Markdown 渲染）；markdown：现有渲染管线
      await this.addTab(name, content, filePath, kind);
      // 按扩展名设置编辑器语法高亮（image 不进入编辑器）
      if (kind === 'text') {
        const ext = (window.FileTypes && window.FileTypes.extOf) ? window.FileTypes.extOf(filePath) : '';
        this._applyCodeMode(ext);
      } else {
        this._applyCodeMode('md');
      }
      this.viewMode = (kind === 'text') ? 'edit' : (this.settings.defaultView || 'preview');
      this.applyViewMode();
      this.updateWordCount();
      this.setStatus(this.t('fileOpened', { name }));
      this.saveSession();
    } catch (e) {
      // 打开失败：结构化错误码（E_NOT_FOUND/E_PERMISSION/...）或兜底 E_IO，用户可见 toast + 开发可见 console
      this.reportError(e.code || 'E_IO', { context: { path: filePath }, error: e, params: e.params, detail: e.detail });
    } finally {
      this._endPaneLoad();
    }
  }

  // 非 Markdown 明文文件：按扩展名选择 CodeMirror 语法高亮模式（仅高亮，不改变编辑行为）
  _applyCodeMode(ext) {
    if (!this.cm || typeof this.cm.setOption !== 'function') return;
    const map = {
      js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
      ts: 'javascript', tsx: 'javascript',
      py: 'python', pyw: 'python',
      rs: 'rust',
      html: 'htmlmixed', htm: 'htmlmixed',
      xml: 'xml', svg: 'xml',
      css: 'css',
      json: 'javascript',
      yml: 'yaml', yaml: 'yaml',
      sh: 'shell', bash: 'shell', zsh: 'shell',
      md: 'gfm', markdown: 'gfm',
    };
    const mode = map[(ext || '').toLowerCase()] || 'gfm';
    try { this.cm.setOption('mode', mode); } catch (e) { try { this.cm.setOption('mode', 'gfm'); } catch (_) {} }
  }

  async openFolder() {
    try {
      const selected = await dialogOpen({ directory: true });
      if (!selected) return;
      const folderPath = Array.isArray(selected) ? selected[0] : selected;
      if (!folderPath) return;
      await this.openFolderPath(folderPath);
    } catch (e) {
      this.setStatus(this.t('openFailed') + ': ' + e);
    }
  }

  // 直接按给定路径加载为工作区目录（不走 dialog）。
  // CLI 参数 / file-open 事件 / drag-drop 都复用此入口。
  async openFolderPath(folderPath) {
    if (!folderPath) return;
    this.showLoading();
    try {
      this.workspaceFolder = folderPath;
      this.expandedFolders = new Set();
      await this.renderFolderTree();
      this.showSidebar();
      this.startFolderWatch();
      this.saveSession();
      this.addRecentWorkspace(folderPath);
      this.setStatus(this.t('folderOpened', { path: folderPath }));
    } catch (e) {
      this.setStatus(this.t('openFailed') + ': ' + e);
    } finally {
      this.hideLoading();
    }
  }

  // 运行中收到目录（拖放 / 二次实例 file-open）时的工作区切换入口：
  // 已有不同工作区则弹确认框，取消则忽略该目录；启动 CLI 场景传 confirm=false 直接打开。
  async maybeOpenFolderPath(folderPath, { confirm = true } = {}) {
    if (!folderPath) return false;
    if (confirm && this.workspaceFolder && this.workspaceFolder !== folderPath) {
      const ok = await this.showConfirmDialog(
        this.t('switchWorkspaceTitle'),
        this.t('switchWorkspaceMsg', { path: folderPath })
      );
      if (!ok) return false;
    }
    await this.openFolderPath(folderPath);
    return true;
  }

  // 统一「一批路径按目录/文件分发」：目录加载为工作区（仅第一个，多余目录提示忽略），
  // 文件走 openFilePath。drag-drop / file-open 事件 / 启动 CLI 参数三处入口共用。
  async openPathsSmart(paths, { confirmWorkspaceSwitch = true } = {}) {
    let dirOpened = false;
    const ignoredDirs = [];
    for (const p of paths || []) {
      if (!p || p.startsWith('-')) continue;
      try {
        let isDir = false;
        try { isDir = await TauriApi.isDirectory({ path: p }); }
        catch (_) { /* 非 Tauri 环境或路径不可访问，按文件处理 */ }
        if (isDir) {
          if (dirOpened) {
            ignoredDirs.push(p);
            continue;
          }
          const opened = await this.maybeOpenFolderPath(p, { confirm: confirmWorkspaceSwitch });
          if (opened) dirOpened = true;
        } else {
          await this.openFilePath(p);
        }
      } catch (err) {
        this.setStatus(`${this.t('openFailed')}: ${err}`);
      }
    }
    // 多余目录合并成一条 toast，避免一次拖十几个文件夹时刷屏
    if (ignoredDirs.length > 0) {
      this.showToast(this.t('extraDirsIgnoredBatch', { n: ignoredDirs.length }), 'warning');
    }
  }

  closeFolder() {
    this.workspaceFolder = null;
    this.expandedFolders = new Set();
    this.saveSession();
    this.renderFolderTree();
    try { TauriApi.stopWatch().catch(() => {}); } catch (e) { /* ignore */ }
  }

  // 开始监听工作区目录树变化（先停掉旧的，避免重复监听）。外部增删目录/文件时会收到 folder-changed 事件
  async startFolderWatch() {
    if (!this.workspaceFolder) return;
    try { await TauriApi.stopWatch(); } catch (e) { /* ignore */ }
    try { await TauriApi.watchFolder({ path: this.workspaceFolder }); }
    catch (e) { console.warn('[folder-watch] failed:', e); }
  }

  // 文件夹监听异常处理：弹确认框提供「重新监听（确认）/ 继续使用（取消）」。
  // 手动触发所以无自动重挂的风暴风险；_folderWatchDialogOpen 防重入（panic 反复时
  // 避免弹窗互相覆盖、监听叠加）
  async _handleFolderWatchError(event) {
    if (this._folderWatchDialogOpen) return;
    this._folderWatchDialogOpen = true;
    try {
      const detail = event && event.payload && event.payload.message
        ? '：' + event.payload.message
        : '';
      const ok = await this.showConfirmDialog(
        this.t('folderWatchErrorTitle'),
        this.t('folderWatchErrorMessage') + detail,
        async () => { await this.startFolderWatch(); },
      );
      if (ok) this.showToast(this.t('folderWatchRecovered'), 'success');
    } finally {
      this._folderWatchDialogOpen = false;
    }
  }

  // 收到 folder-changed 后防抖重建文件树（保留已展开目录），避免单次操作触发多次重渲染
  _scheduleTreeRefresh() {
    if (this._treeRefreshTimer) clearTimeout(this._treeRefreshTimer);
    this._treeRefreshTimer = setTimeout(() => {
      this._treeRefreshTimer = null;
      if (this.workspaceFolder) this.renderFolderTree();
    }, 400);
  }

  sortFolderEntries(entries, key, order, dirFirst = true) {
    const arr = entries.slice();
    const sign = order === 'desc' ? -1 : 1;
    arr.sort((a, b) => {
      if (dirFirst && a.is_dir !== b.is_dir) {
        return a.is_dir ? -1 : 1;
      }
      let cmp;
      if (key === 'time') {
        cmp = (a.mtime || 0) - (b.mtime || 0);
      } else if (key === 'created') {
        cmp = (a.created || a.mtime || 0) - (b.created || b.mtime || 0);
      } else {
        cmp = String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase());
      }
      return cmp * sign;
    });
    return arr;
  }

  // 文件大小自适应格式化：B / KB / MB / GB（保留 1 位小数，>=1000 才进级）
  formatFileSize(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return b + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let val = b / 1024;
    let i = 0;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i += 1;
    }
    return val.toFixed(val >= 100 ? 0 : 1) + ' ' + units[i];
  }

  // 修改时间友好格式化：今天显示 HH:mm，今年显示 MM-DD HH:mm，跨年显示 YYYY-MM-DD
  formatFileTime(mtime) {
    const ms = Number(mtime) || 0;
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
      return hm;
    }
    const md = pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    if (d.getFullYear() === now.getFullYear()) {
      return md + ' ' + hm;
    }
    return d.getFullYear() + '-' + md;
  }

  updateFolderSortOrderButton() {
    const el = document.getElementById('folder-sort-order');
    if (!el) return;
    const asc = (this.settings.fileSortOrder || 'asc') !== 'desc';
    // 排序字形：清晰的上下双箭头（升序=上箭头实色+下箭头淡显；降序反之），与面板 chevron 明显区分
    // 升序/降序：使用 Lucide arrow-up-narrow-wide / arrow-down-wide-narrow（条形由窄到宽表征顺序方向）
    const SORT_ASC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/><path d="M11 12h4"/><path d="M11 16h7"/><path d="M11 20h10"/></svg>';
    const SORT_DESC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/></svg>';
    el.innerHTML = asc ? SORT_ASC : SORT_DESC;
    el.classList.toggle('desc', !asc);
    el.title = this.t(asc ? 'sortAsc' : 'sortDesc');
    el.setAttribute('aria-pressed', String(asc));
  }

  // 文件树右键菜单首项文案：文件夹→「打开文件夹」，文件→「打开所在目录」（动态切换，i18n 键均有）
  updateFolderMenuLabel() {
    const span = document.getElementById('folder-open-label');
    if (!span) return;
    span.textContent = this.t(this._folderCtxIsDir ? 'openFolder' : 'openContainingFolder');
  }

  // ====== 文件树右键菜单：状态更新 + 辅助方法 + 操作（合并自 PR #36）======
  // 注意：IPC 全部走 TauriApi（ADR-1 唯一边界），不直接 invoke。

  // 根据当前右键目标和剪贴板状态更新菜单项禁用状态
  updateFileTreeMenuState() {
    const menu = document.getElementById('context-menu-file-tree');
    if (!menu) return;
    const ctx = this._fileTreeCtx;
    const isDir = ctx ? ctx.isDir : false;
    const setDisabled = (action, disabled) => {
      const item = menu.querySelector(`[data-action="${action}"]`);
      if (item) item.classList.toggle('disabled', disabled);
    };
    setDisabled('file-new-file', !isDir);
    setDisabled('file-new-folder', !isDir);
    setDisabled('file-paste', !isDir || !this._fileClipboard);
    if (!ctx) {
      ['file-cut', 'file-copy', 'file-rename', 'file-copy-path', 'file-delete'].forEach(a => setDisabled(a, true));
    }
  }

  // 通用输入对话框：返回用户输入的字符串（trim），取消返回 null
  showPromptDialog({ title, message = '', value = '', placeholder = '', selectBase = false }) {
    return new Promise((resolve) => {
      const dialog = document.getElementById('prompt-dialog');
      const titleEl = document.getElementById('prompt-dialog-title');
      const msgEl = document.getElementById('prompt-dialog-message');
      const input = document.getElementById('prompt-dialog-input');
      const confirmBtn = document.getElementById('prompt-dialog-confirm');
      const cancelBtn = document.getElementById('prompt-dialog-cancel');
      if (!dialog || !input) { resolve(null); return; }
      titleEl.textContent = title || '';
      msgEl.textContent = message;
      msgEl.style.display = message ? '' : 'none';
      input.value = value;
      input.placeholder = placeholder;
      dialog.classList.remove('hidden');
      input.focus();
      if (selectBase && value) {
        const dot = value.lastIndexOf('.');
        if (dot > 0) input.setSelectionRange(0, dot);
        else input.select();
      } else {
        input.select();
      }
      const cleanup = () => {
        dialog.classList.add('hidden');
        input.removeEventListener('keydown', onKey);
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        dialog.removeEventListener('click', onOverlay);
      };
      const onConfirm = () => { const v = input.value.trim(); cleanup(); resolve(v || null); };
      const onCancel = () => { cleanup(); resolve(null); };
      const onKey = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
        else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      };
      const onOverlay = (e) => { if (e.target === dialog) onCancel(); };
      input.addEventListener('keydown', onKey);
      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      dialog.addEventListener('click', onOverlay);
    });
  }

  validateFileName(name) {
    if (!name || !name.trim()) return this.t('nameEmpty');
    if (/[\/\\:*?"<>|]/.test(name)) return this.t('nameInvalid');
    return null;
  }

  joinPath(parent, name) {
    if (!parent) return name;
    return parent.replace(/[\/\\]+$/, '') + '/' + name;
  }

  parentPath(path) {
    const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return idx > 0 ? path.substring(0, idx) : '';
  }

  baseName(path) {
    const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return idx >= 0 ? path.substring(idx + 1) : path;
  }

  async pathExists(path) {
    try {
      const parent = this.parentPath(path);
      const name = this.baseName(path);
      if (!parent) return false;
      const entries = await TauriApi.listDir({ path: parent });
      return entries.some(e => e.name === name);
    } catch { return false; }
  }

  async fileTreeNewFile() {
    const ctx = this._fileTreeCtx;
    if (!ctx || !ctx.isDir) return;
    let name = await this.showPromptDialog({
      title: this.t('fileNewFile'),
      message: this.t('newFileNamePrompt'),
      placeholder: 'note.md'
    });
    if (name === null) return;
    if (!name.includes('.')) name += '.md';
    const err = this.validateFileName(name);
    if (err) { this.showToast(err, 'danger'); return; }
    const newPath = this.joinPath(ctx.path, name);
    if (await this.pathExists(newPath)) { this.showToast(this.t('nameExists'), 'danger'); return; }
    try {
      await TauriApi.writeFile({ path: newPath, content: '' });
      this.expandedFolders.add(ctx.path);
      this.renderFolderTree();
      this.setStatus(this.t('fileNewFile') + ': ' + name);
    } catch (e) {
      this.showToast(this.t('fileCreateFailed') + ': ' + e, 'danger');
    }
  }

  async fileTreeNewFolder() {
    const ctx = this._fileTreeCtx;
    if (!ctx || !ctx.isDir) return;
    const name = await this.showPromptDialog({
      title: this.t('fileNewFolder'),
      message: this.t('newFolderNamePrompt'),
      placeholder: 'new-folder'
    });
    if (name === null) return;
    const err = this.validateFileName(name);
    if (err) { this.showToast(err, 'danger'); return; }
    const newPath = this.joinPath(ctx.path, name);
    if (await this.pathExists(newPath)) { this.showToast(this.t('nameExists'), 'danger'); return; }
    try {
      await TauriApi.ensureDir({ path: newPath });
      this.expandedFolders.add(ctx.path);
      this.renderFolderTree();
      this.setStatus(this.t('fileNewFolder') + ': ' + name);
    } catch (e) {
      this.showToast(this.t('fileCreateFailed') + ': ' + e, 'danger');
    }
  }

  async fileTreeRename() {
    const ctx = this._fileTreeCtx;
    if (!ctx) return;
    const oldName = this.baseName(ctx.path);
    let newName = await this.showPromptDialog({
      title: this.t('fileRename'),
      message: this.t('renamePrompt'),
      value: oldName,
      selectBase: true
    });
    if (newName === null) return;
    const oldExt = oldName.includes('.') ? oldName.slice(oldName.lastIndexOf('.')) : '';
    if (!newName.includes('.') && (oldExt === '' || oldExt === '.md')) newName += '.md';
    const err = this.validateFileName(newName);
    if (err) { this.showToast(err, 'danger'); return; }
    if (newName === oldName) return;
    const parent = this.parentPath(ctx.path);
    const newPath = this.joinPath(parent, newName);
    if (await this.pathExists(newPath)) { this.showToast(this.t('nameExists'), 'danger'); return; }
    try {
      await TauriApi.renamePath({ from: ctx.path, to: newPath });
      const tab = this.tabs.find(t => t.filePath === ctx.path);
      if (tab) {
        tab.filePath = newPath;
        tab.name = newName;
        this.updateTabBar();
        this.saveSession();
      }
      this.renderFolderTree();
      this.setStatus(this.t('fileRename') + ': ' + oldName + ' → ' + newName);
    } catch (e) {
      this.showToast(this.t('fileRenameFailed') + ': ' + e, 'danger');
    }
  }

  async fileTreeDelete() {
    const ctx = this._fileTreeCtx;
    if (!ctx) return;
    const name = this.baseName(ctx.path);
    const msg = ctx.isDir
      ? this.t('confirmDeleteFolder', { name })
      : this.t('confirmDeleteFile', { name });
    const ok = await this.showConfirmDialog(this.t('fileDelete'), msg);
    if (!ok) return;
    try {
      await TauriApi.removePath({ path: ctx.path });
      const tabIdx = this.tabs.findIndex(t => t.filePath === ctx.path);
      if (tabIdx >= 0) await this.closeTab(tabIdx);
      this.renderFolderTree();
      this.setStatus(this.t('fileDelete') + ': ' + name);
    } catch (e) {
      this.showToast(this.t('fileDeleteFailed') + ': ' + e, 'danger');
    }
  }

  fileTreeCut() {
    const ctx = this._fileTreeCtx;
    if (!ctx) return;
    this._fileClipboard = { op: 'cut', path: ctx.path, isDir: ctx.isDir };
    this.setStatus(this.t('fileCutDone') + ': ' + this.baseName(ctx.path));
    // 操作完成后清除文件树上下文，避免残留的 _fileTreeCtx 继续劫持编辑器/预览区的
    // Ctrl+C/V（见 fileTreeCopyPath 的同类处理）：用户复制/剪切文件后回到正文 Ctrl+V
    // 不应被 fileTreePaste 当成文件粘贴。
    this._fileTreeCtx = null;
  }

  fileTreeCopy() {
    const ctx = this._fileTreeCtx;
    if (!ctx) return;
    this._fileClipboard = { op: 'copy', path: ctx.path, isDir: ctx.isDir };
    this.setStatus(this.t('fileCopyDone') + ': ' + this.baseName(ctx.path));
    // 同上：复制完成后清除上下文，避免残留劫持编辑器/预览区的 Ctrl+C/V。
    this._fileTreeCtx = null;
  }

  async fileTreePaste() {
    const ctx = this._fileTreeCtx;
    if (!ctx || !this._fileClipboard) {
      this.showToast(this.t('clipboardEmpty'), 'danger');
      return;
    }
    // 目标目录：选中目录时为目标本身；选中文件时取其所在目录（粘贴到同级）。
    const targetDir = ctx.isDir ? ctx.path : this.parentPath(ctx.path);
    if (!targetDir) {
      this.showToast(this.t('clipboardEmpty'), 'danger');
      return;
    }
    const clip = this._fileClipboard;
    // 安全检查：禁止把目录复制/移动到自身或自身子目录内，否则递归复制直到路径超长
    const normClip = clip.path.replace(/[\/\\]+$/, '');
    const normTarget = targetDir.replace(/[\/\\]+$/, '');
    if (normClip === normTarget
        || normTarget.startsWith(normClip + '/')
        || normTarget.startsWith(normClip + '\\')) {
      this.showToast(this.t('pasteIntoSelf'), 'danger');
      return;
    }
    const srcName = this.baseName(clip.path);
    let dstPath = this.joinPath(targetDir, srcName);
    // 同名冲突时加 (n) 后缀
    if (await this.pathExists(dstPath)) {
      const dot = srcName.lastIndexOf('.');
      const base = dot > 0 ? srcName.substring(0, dot) : srcName;
      const ext = dot > 0 ? srcName.substring(dot) : '';
      let i = 1;
      while (await this.pathExists(this.joinPath(targetDir, `${base} (${i})${ext}`))) i++;
      dstPath = this.joinPath(targetDir, `${base} (${i})${ext}`);
    }
    try {
      if (clip.op === 'cut') {
        await TauriApi.movePath({ from: clip.path, to: dstPath });
        const tab = this.tabs.find(t => t.filePath === clip.path);
        if (tab) {
          tab.filePath = dstPath;
          this.updateTabBar();
          this.saveSession();
        }
        this._fileClipboard = null;
      } else {
        await TauriApi.copyPath({ from: clip.path, to: dstPath });
      }
      this.expandedFolders.add(targetDir);
      this.renderFolderTree();
      this.setStatus(this.t('filePasteDone') + ': ' + this.baseName(dstPath));
      // 粘贴完成后清除文件树上下文，避免残留劫持编辑器/预览区的 Ctrl+C/V（与 copy/cut 一致）。
      this._fileTreeCtx = null;
    } catch (e) {
      this.showToast(this.t('filePasteDone') + ': ' + e, 'danger');
    }
  }

  fileTreeCopyPath() {
    const ctx = this._fileTreeCtx;
    if (!ctx) return;
    // 「复制路径」为瞬时动作，不进入「复制文件待粘贴」状态；执行后清除文件树上下文，
    // 否则 _fileTreeCtx 持续存在会让后续编辑器内 Ctrl+C 被 fileTreeCopy 劫持、一直复制该路径。
    this._fileTreeCtx = null;
    navigator.clipboard.writeText(ctx.path).then(() => {
      this.setStatus(this.t('fileCopyPath') + ': ' + ctx.path);
    }).catch(() => {
      this.showToast(this.t('fileCopyPath') + ' ' + this.t('failed'), 'danger');
    });
  }

  _filterTreeEntries(entries, showAll) {
    if (showAll) return entries;
    // 文件夹始终保留：保证树可继续下钻；空文件夹也会显示（避免「目录消失」错觉）
    if (!window.FileTypes || !window.FileTypes.classifyFile) return entries;
    return entries.filter((e) => e && e.is_dir ? true : window.FileTypes.classifyFile(e.name) !== 'unsupported');
  }

  async renderFolderTree() {
    const treeEl = document.getElementById('folder-tree');
    if (!treeEl) return;
    const headerEl = document.getElementById('folder-header');
    const pathEl = document.getElementById('folder-path');
    treeEl.innerHTML = '';
    if (pathEl) pathEl.textContent = this.workspaceFolder || '';
    if (headerEl) headerEl.classList.toggle('hidden', !this.workspaceFolder);
    if (!this.workspaceFolder) {
      const empty = document.createElement('button');
      empty.className = 'folder-empty';
      empty.textContent = this.t('openFolder');
      empty.addEventListener('click', () => this.openFolder());
      treeEl.appendChild(empty);
      return;
    }
    await this.renderFolderLevel(this.workspaceFolder, treeEl, 0);
  }

  async renderFolderLevel(dirPath, containerEl, depth) {
    if (depth > 20) return; // 防御：限制目录递归深度，避免深层嵌套/符号链接环导致浏览器卡死
    const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6" /></svg>';
    const FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>';
    const FOLDER_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" /></svg>';
    const FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /></svg>';
    const IMAGE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';

    let listing;
    try {
      listing = await TauriApi.listDir({ path: dirPath });
    } catch (e) {
      return;
    }
    const rawEntries = Array.isArray(listing)
      ? listing
      : (listing && Array.isArray(listing.entries) ? listing.entries : []);
    const sorted = this.sortFolderEntries(rawEntries, this.settings.fileSortKey, this.settings.fileSortOrder);
    // 默认按「受支持格式」过滤文件（Markdown 7 / 图片 20 / 明文代码 145），
    // 设置里开启「显示所有文件」时退回原始列表。文件夹始终保留，保证可继续下钻。
    const entries = this._filterTreeEntries(sorted, this.settings.showAllFiles);
    const truncated = !!(listing && listing.truncated);
    for (const entry of entries) {
      const node = document.createElement('div');
      node.className = 'tree-node ' + (entry.is_dir ? 'tree-folder' : 'tree-file');
      node.dataset.path = entry.path;
      node.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 文件树右键目标上下文（合并自 PR #36）：驱动 file-* 菜单 + F2/Delete/Ctrl+X/C/V 快捷键
        this._fileTreeCtx = { path: entry.path, isDir: entry.is_dir, nodeEl: node };
        // 同时设置「打开所在目录」所需状态
        this._folderCtxPath = entry.path;
        this._folderCtxIsDir = entry.is_dir;
        this.updateFolderMenuLabel();
        this.hideAllContextMenus();
        this.updateFileTreeMenuState();
        this.showContextMenu('context-menu-file-tree', e.clientX, e.clientY);
      });

      const row = document.createElement('div');
      row.className = 'tree-row';
      row.style.paddingLeft = (8 + depth * 14) + 'px';

      const arrow = document.createElement('span');
      arrow.className = 'tree-arrow';
      arrow.innerHTML = CHEVRON;
      const icon = document.createElement('span');
      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = entry.name;

      if (entry.is_dir) {
        const expanded = this.expandedFolders.has(entry.path);
        icon.className = 'tree-icon folder';
        icon.innerHTML = expanded ? FOLDER_OPEN : FOLDER;
        node.classList.toggle('expanded', expanded);
        const childContainer = document.createElement('div');
        childContainer.className = 'tree-children' + (expanded ? '' : ' hidden');
        node.appendChild(row);
        node.appendChild(childContainer);
        if (expanded) {
          await this.renderFolderLevel(entry.path, childContainer, depth + 1);
        }
        row.addEventListener('click', async () => {
          // 左键点击也更新文件树选中目标，让 F2/Delete/Ctrl+C 等快捷键作用于当前点击项
          this._fileTreeCtx = { path: entry.path, isDir: true, nodeEl: node };
          const isOpen = !childContainer.classList.contains('hidden');
          if (isOpen) {
            childContainer.classList.add('hidden');
            node.classList.remove('expanded');
            icon.innerHTML = FOLDER;
            this.expandedFolders.delete(entry.path);
          } else {
            childContainer.classList.remove('hidden');
            node.classList.add('expanded');
            icon.innerHTML = FOLDER_OPEN;
            this.expandedFolders.add(entry.path);
            if (childContainer.childElementCount === 0) {
              await this.renderFolderLevel(entry.path, childContainer, depth + 1);
            }
          }
          this.saveSession();
        });
      } else {
        arrow.innerHTML = '';
        const cat = (window.FileTypes && window.FileTypes.classifyFile)
          ? window.FileTypes.classifyFile(entry.name)
          : 'markdown';
        icon.className = 'tree-icon file';
        icon.innerHTML = cat === 'image' ? IMAGE_ICON : FILE;
        node.appendChild(row);
        row.addEventListener('click', () => {
          // 左键点击也更新文件树选中目标，让 F2/Delete/Ctrl+C 等快捷键作用于当前点击项
          this._fileTreeCtx = { path: entry.path, isDir: false, nodeEl: node };
          this.openFilePath(entry.path);
        });
      }
      row.appendChild(arrow);
      row.appendChild(icon);
      row.appendChild(label);

      const meta = document.createElement('span');
      meta.className = 'tree-meta';
      if (!entry.is_dir && entry.size != null) {
        const sizeEl = document.createElement('span');
        sizeEl.className = 'tree-size';
        sizeEl.textContent = this.formatFileSize(entry.size);
        meta.appendChild(sizeEl);
      }
      const mtime = Number(entry.mtime) || 0;
      const created = Number(entry.created) || 0;
      // 上下文时间戳：显示当前排序依据的那种时间（按创建时间排序→创建，否则→修改）；
      // 另一时间 + 大小收进 hover tooltip，避免每行常驻两串时间导致拥挤。
      const byCreated = this.settings.fileSortKey === 'created';
      let primaryVal = 0, primaryLabelKey = 'modifiedLabel';
      if (byCreated && created) { primaryVal = created; primaryLabelKey = 'createdLabel'; }
      else if (!byCreated && mtime) { primaryVal = mtime; primaryLabelKey = 'modifiedLabel'; }
      else { primaryVal = byCreated ? mtime : created; primaryLabelKey = byCreated ? 'modifiedLabel' : 'createdLabel'; }
      const timeLine = document.createElement('span');
      timeLine.className = 'tree-time-line';
      const lab = document.createElement('span');
      lab.className = 'tree-meta-label';
      lab.textContent = this.t(primaryLabelKey);
      timeLine.appendChild(lab);
      timeLine.appendChild(document.createTextNode(' ' + this.formatFileTime(primaryVal)));
      const titleParts = [];
      if (mtime) titleParts.push(this.t('modifiedFullTitle') + new Date(mtime).toLocaleString());
      if (created) titleParts.push(this.t('createdFullTitle') + new Date(created).toLocaleString());
      if (!entry.is_dir && entry.size != null) titleParts.push(this.t('sizeFullTitle') + this.formatFileSize(entry.size));
      if (titleParts.length) timeLine.title = titleParts.join('\n');
      meta.appendChild(timeLine);
      row.appendChild(meta);

      containerEl.appendChild(node);
    }
    if (truncated) {
      const ph = document.createElement('div');
      ph.className = 'tree-node tree-file tree-truncated';
      const phRow = document.createElement('div');
      phRow.className = 'tree-row';
      const phLabel = document.createElement('span');
      phLabel.className = 'tree-label tree-label--muted';
      phLabel.textContent = this.t('moreFilesHidden');
      phRow.appendChild(phLabel);
      ph.appendChild(phRow);
      containerEl.appendChild(ph);
    }
    this.highlightTreeActiveFile();
  }

  highlightTreeActiveFile() {
    const treeEl = document.getElementById('folder-tree');
    if (!treeEl) return;
    const activePath = (this.activeTab && this.activeTab.filePath) ? this.activeTab.filePath : null;
    treeEl.querySelectorAll('.tree-row.active').forEach(el => el.classList.remove('active'));
    if (!activePath) return;
    treeEl.querySelectorAll('.tree-node.tree-file').forEach(node => {
      if (node.dataset.path === activePath) {
        const row = node.querySelector('.tree-row');
        if (row) row.classList.add('active');
      }
    });
  }

  async saveFile() {
    try {
      let path = this.activeTab.filePath;
      if (!path) {
        path = await dialogSave({
          filters: [
            { name: 'Markdown', extensions: ['md'] },
            { name: this.t('allFiles'), extensions: ['*'] }
          ]
        });
        if (!path) return;
      }

      await TauriApi.writeFile({ path, content: this.activeTab.content });
      if (!this.activeTab.filePath) {
        this.activeTab.filePath = path;
        this.activeTab.name = path.split(/[/\\]/).pop();
      }
      this.activeTab.savedContent = this.activeTab.content;
      this.updateTabDisplay();
      await this.refreshFileMeta(this.activeTab);
      this.setStatus(`${this.t('saved')}: ${this.activeTab.filePath}`);
      this.saveSession();
    } catch (error) {
      this.setStatus(`${this.t('saveFailed')}: ${error}`);
    }
  }

  async saveAsFile() {
    try {
      const path = await dialogSave({
        defaultPath: this.activeTab.filePath || `${this.activeTab.name}`,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: this.t('allFiles'), extensions: ['*'] }
        ]
      });
      if (!path) return;

      await TauriApi.writeFile({ path, content: this.activeTab.content });
      this.activeTab.filePath = path;
      this.activeTab.name = path.split(/[/\\]/).pop();
      this.activeTab.savedContent = this.activeTab.content;
      this.updateTabBar();
      await this.refreshFileMeta(this.activeTab);
      this.setStatus(`${this.t('savedAs')}: ${path}`);
      this.saveSession();
    } catch (error) {
      this.setStatus(`${this.t('saveFailed')}: ${error}`);
    }
  }

  // 导出时把预览里的图片全部内联为 base64 data URI，使导出文档自包含、不受运行时
  // blob: 回收 / 源解析影响（同源 srcdoc 打印帧在 PDF 导出、外部打开在 HTML 导出都适用）。
  // 分支：blob:→fetch 还原；file://→Rust 读盘；相对路径→按文档目录 Rust 读盘；data:/http(s): 保留。
  async _inlineImagesForExport(clone, filePath) {
    if (!filePath) return; // 未保存文档：相对路径无法解析，跳过（保留原 src）
    const dir = filePath.replace(/[/\\][^/\\]*$/, '');
    const mimeOfExt = (name) => {
      const ext = String(name).split('.').pop().toLowerCase();
      if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
      if (ext === 'gif') return 'image/gif';
      if (ext === 'svg') return 'image/svg+xml';
      if (ext === 'webp') return 'image/webp';
      if (ext === 'png') return 'image/png';
      if (ext === 'bmp') return 'image/bmp';
      return 'image/png';
    };
    const blobToDataUri = (blob) => new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error('readAsDataURL failed'));
      fr.readAsDataURL(blob);
    });
    const imgPromises = Array.from(clone.querySelectorAll('img')).map(async (img) => {
      let src = img.getAttribute('src');
      if (!src) return;
      // 已内联（data:）或远程（http(s):）资源直接保留
      if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) return;
      try {
        let dataUri = null;
        if (src.startsWith('blob:')) {
          // 预览里 img.src 已被 processImages 经 getCachedImageURL 缓存成 blob: URL，
          // 导出时该 blob 可能已被 LRU 回收失效，必须还原为内联 base64。
          // blob 与主窗口同源，可直接 fetch 还原。
          const resp = await fetch(src);
          if (resp.ok) {
            const blob = await resp.blob();
            dataUri = await blobToDataUri(blob);
          }
        } else if (src.startsWith('file://')) {
          // file:// 走 Rust 读磁盘（绕过 CSP，与 processImages 一致）
          const url = src.replace(/^file:\/\//, '');
          const base64 = await TauriApi.fetchImageAsBase64({ url });
          dataUri = `data:${mimeOfExt(url)};base64,${base64}`;
        } else {
          // 纯相对路径：按当前 .md 所在目录补全
          let rel = src;
          if (rel.startsWith('/')) rel = rel.slice(1);
          const base64 = await TauriApi.fetchImageAsBase64({ url: dir + '/' + rel });
          dataUri = `data:${mimeOfExt(rel)};base64,${base64}`;
        }
        if (dataUri) img.src = dataUri;
      } catch (e) {
        // 还原失败不阻断导出：保留原 src，至少用户能手动补
        console.warn('[export] 图片内联失败，保留原 src:', src, e);
      }
    });
    await Promise.allSettled(imgPromises);
  }

  // PDF 导出需要完整 styles.css。优先运行时 fetch（原始文本保真），失败则回退读取
  // 已加载样式表的 CSSOM（自包含、不依赖网络/打包路径），彻底杜绝
  // 「fetch 失败 → appCSS 空 → 打印样式大面积缺失」的软依赖风险。
  async _loadStylesheetText(url) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const txt = await resp.text();
        if (txt && txt.trim()) return txt;
      }
    } catch (e) { /* fallthrough to CSSOM */ }
    try {
      const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        if (href.indexOf(url) === -1) continue;
        const sheet = link.sheet;
        if (!sheet) continue;
        const rules = Array.from(sheet.cssRules).map((r) => r.cssText).join('\n');
        if (rules && rules.trim()) return rules;
      }
    } catch (e) { /* cross-origin 等忽略 */ }
    return '';
  }

  // 文档导出（HTML / Word）共用的基础样式表。
  // 使用标签级选择器（h1/pre/...）而非 .preview-content 后代选择器，
  // 因为导出时 this.preview 的外层容器被丢弃，仅其 children 进入 <body>。
  // 该 CSS 同时被 Word 的 altChunk 导入器识别（html-docx-js 把整段 HTML 原样嵌入 MHT）。
  _documentExportCSS() {
    return `body { max-width: 860px; margin: 0 auto; padding: 40px 20px; line-height: 1.8; color: #2a2a2e; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    h1, h2, h3, h4, h5, h6 { margin-top: 24px; margin-bottom: 12px; font-weight: 600; line-height: 1.3; }
    h1 { font-size: 2em; border-bottom: 2px solid #d4d4d8; padding-bottom: 10px; }
    h2 { font-size: 1.5em; border-bottom: 1px solid #d4d4d8; padding-bottom: 8px; }
    h3 { font-size: 1.25em; }
    h4 { font-size: 1.1em; }
    h5 { font-size: 1em; color: #5e5e62; }
    h6 { font-size: 0.9em; color: #5e5e62; }
    p { margin-bottom: 14px; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    strong { font-weight: 600; }
    em { font-style: italic; }
    del { text-decoration: line-through; color: #5e5e62; }
    code { padding: 2px 6px; background: #f0efee; border: 1px solid #d4d4d8; border-radius: 4px; font-family: "SF Mono", "Fira Code", monospace; font-size: 0.88em; }
    pre { padding: 16px; background: #f6f5f4; border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; word-break: break-word; overflow: visible; margin: 16px 0; max-width: 100%; border: 1px solid #d4d4d8; }
    pre code { padding: 0; background: transparent; border: none; font-size: 0.9em; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; word-break: break-word; }
    /* 代码块：hljs 主题里 .hljs{background:#fff}（specificity 0,1,0）会盖住上面 pre code(0,0,2) 的 transparent，
       形成"内白外灰"。用 .hljs 同类选择 + !important 显式压住，让 pre 的灰底透出到 code 上。 */
    pre code.hljs, pre code .hljs { background: transparent !important; padding: 0; }
    /* 代码块行结构（code-block.js 输出的 .code-line/.code-line-num/.code-line-text 在导出里也要换行） */
    .code-scroll { max-height: none; overflow: visible; }
    .code-line { display: flex; line-height: 1.8; min-width: 0; }
    .code-line-num { flex-shrink: 0; width: 3em; text-align: right; padding-right: 0.8em; color: #888; user-select: none; display: none; }
    .preview-content.code-line-numbers .code-line-num { display: inline; }
    .code-line-text { white-space: pre-wrap; word-wrap: break-word; word-break: break-word; flex: 1 1 auto; min-width: 0; }
    blockquote { padding: 12px 20px; margin: 0 0 16px 0; border-left: 4px solid #2563eb; background: #f6f5f4; border-radius: 0 6px 6px 0; color: #5e5e62; }
    blockquote p:last-child { margin-bottom: 0; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
    th, td { padding: 8px 12px; border: 1px solid #d4d4d8; text-align: left; }
    th { background: #f0efee; font-weight: 600; }
    img { max-width: 100%; }
    hr { border: none; border-top: 1px solid #d4d4d8; margin: 24px 0; }
    ul, ol { padding-left: 24px; margin-bottom: 14px; }
    li { margin-bottom: 4px; }
    mark { display: inline-block; background: #fbbf24; color: #1a1a1a; padding: 1px 4px; border-radius: 3px; }
    kbd { display: inline-block; padding: 2px 7px; font-size: 0.82em; font-family: "SF Mono", "Fira Code", monospace; background: #f0efee; border: 1px solid #d4d4d8; border-bottom-width: 2px; border-radius: 4px; line-height: 1.5; }
    abbr { text-decoration: underline dotted; cursor: help; }
    .mermaid-container { text-align: center; margin: 16px 0; padding: 16px; max-width: 100%; background: #f0efee; border-radius: 8px; border: 1px solid #d4d4d8; overflow-x: auto; }
    .mermaid-container svg { max-width: 100%; height: auto; }
    .alert { border-radius: 10px; padding: 14px 18px; margin: 16px 0; max-width: 100%; border-left: 4px solid; overflow-wrap: break-word; }
    .alert-title { font-weight: 700; margin-bottom: 6px; font-size: 0.95em; display: flex; align-items: center; gap: 8px; }
    .alert-icon { width: 18px; height: 18px; flex-shrink: 0; }
    .alert-content p:last-child { margin-bottom: 0; }
    .alert-note { background: rgba(56,132,255,0.06); border-left-color: #3884ff; }
    .alert-tip { background: rgba(16,185,129,0.06); border-left-color: #10b981; }
    .alert-important { background: rgba(139,92,246,0.06); border-left-color: #8b5cf6; }
    .alert-warning { background: rgba(245,158,11,0.06); border-left-color: #f59e0b; }
    .alert-caution { background: rgba(239,68,68,0.06); border-left-color: #ef4444; }
    .math-display { display: block; text-align: center; margin: 16px 0; overflow-x: auto; }
    .toc-wrapper { padding: 12px 16px; margin: 16px 0; background: #f6f5f4; border-radius: 8px; border: 1px solid #d4d4d8; }
    .toc-list ul { list-style: none; padding-left: 16px; margin: 2px 0; }
    .toc-list li { margin-bottom: 3px; line-height: 1.6; }
.toc a { color: #2563eb; text-decoration: underline; font-size: 0.92em; }
input[type="checkbox"] { -webkit-appearance: none; appearance: none; margin-right: 8px; width: 16px; height: 16px; border: 1.5px solid #d4d4d8; border-radius: 3px; vertical-align: middle; position: relative; top: -1px; cursor: default; }
input[type="checkbox"]:checked { background: #16a34a url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIzIiBmaWxsPSJub25lIj48cGF0aCBkPSJNNSAxM2w0IDRMMTkgNyIvPjwvc3ZnPg==") center / 14px no-repeat; border-color: #16a34a; }
    input[type="checkbox"] { -webkit-appearance: none; appearance: none; margin-right: 8px; width: 16px; height: 16px; border: 1.5px solid #d4d4d8; border-radius: 3px; vertical-align: middle; position: relative; top: -1px; cursor: default; }
    input[type="checkbox"]:checked { background: #16a34a; border-color: #16a34a; }
    input[type="checkbox"]:checked::after { content: ''; position: absolute; left: 4px; top: 1px; width: 5px; height: 9px; border: solid white; border-width: 0 2px 2px 0; transform: rotate(45deg); }
    details { margin-bottom: 14px; padding: 8px 12px; background: #f6f5f4; border-radius: 6px; border: 1px solid #d4d4d8; }
    summary { font-weight: 600; cursor: pointer; }`;
  }

  // 纯函数：计算 canvas/imageData 的裁剪边界（去除四周空白/透明/背景色）。
  // 返回 { x, y, w, h }；若全空返回 null。
  static _computeTrimBounds(data, width, height, { backgroundColor = null, padding = 4, tolerance = 15 } = {}) {
    if (!data || width <= 0 || height <= 0) return null;
    const isEmpty = (idx) => {
      if (data[idx + 3] < 10) return true;
      if (!backgroundColor) return false;
      const dr = data[idx] - backgroundColor.r;
      const dg = data[idx + 1] - backgroundColor.g;
      const db = data[idx + 2] - backgroundColor.b;
      return Math.sqrt(dr * dr + dg * dg + db * db) <= tolerance;
    };
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        if (!isEmpty(idx)) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0 || maxY < 0) return null;
    const x = Math.max(0, minX - padding);
    const y = Math.max(0, minY - padding);
    const w = Math.min(width - x, maxX - minX + 1 + padding * 2);
    const h = Math.min(height - y, maxY - minY + 1 + padding * 2);
    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  }

  // 裁剪 canvas 四周空白/透明/背景色边距，仅保留有内容的区域。
  // backgroundColor 为 null 时只裁剪完全透明像素；传入 {r,g,b} 时按颜色裁剪（容差 15）。
  _trimCanvas(canvas, { backgroundColor = null, padding = 4, tolerance = 15 } = {}) {
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) return canvas;
      const { width, height } = canvas;
      if (width <= 0 || height <= 0) return canvas;
      const imageData = ctx.getImageData(0, 0, width, height);
      const bounds = MarkdownEditor._computeTrimBounds(imageData.data, width, height, { backgroundColor, padding, tolerance });
      if (!bounds) return canvas;
      const { x, y, w, h } = bounds;
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const outCtx = out.getContext('2d');
      if (!outCtx) return canvas;
      outCtx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
      return out;
    } catch (e) {
      return canvas;
    }
  }

  // 把 SVG 元素转成 PNG data URL（用于 Mermaid 图表落入 Word）。
  // 失败时返回空字符串，调用方应保留原 SVG 作为降级。
  async _svgToPngDataUrl(svg) {
    try {
      if (typeof XMLSerializer === 'undefined' || typeof Blob === 'undefined' || typeof Image === 'undefined') return '';
      const serializer = new XMLSerializer();
      let svgStr = serializer.serializeToString(svg);
      if (!svgStr) return '';
      // 解析尺寸：优先 viewBox，其次 width/height 属性
      let width = 0, height = 0;
      const vb = svg.getAttribute('viewBox');
      if (vb) {
        const parts = vb.trim().split(/\s+/).map(Number);
        if (parts.length >= 4 && Number.isFinite(parts[2]) && Number.isFinite(parts[3])) {
          width = parts[2];
          height = parts[3];
        }
      }
      if (!width || !height) {
        const w = parseFloat(svg.getAttribute('width'));
        const h = parseFloat(svg.getAttribute('height'));
        if (w && h) { width = w; height = h; }
      }
      if (!width || !height) {
        const rect = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
        if (rect && rect.width > 0 && rect.height > 0) {
          width = rect.width;
          height = rect.height;
        }
      }
      if (!width || !height) { width = 600; height = 400; }
      // 声明命名空间，避免 canvas 绘制空白
      if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svgStr)) {
        svgStr = svgStr.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      }
      const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
      const url = (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(blob) : '';
      if (!url) return '';
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) { URL.revokeObjectURL(url); return ''; }
      canvas.width = Math.max(1, Math.floor(width));
      canvas.height = Math.max(1, Math.floor(height));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      return canvas.toDataURL('image/png');
    } catch (e) {
      return '';
    }
  }

  // 在 Web Worker 里运行 html-docx-js 的 asBlob，避免其同步 zip 操作阻塞主线程。
  // Worker 接收 HTML 字符串，返回 docx 文件的 ArrayBuffer。
  _runWordExportWorker(html) {
    return new Promise((resolve, reject) => {
      const worker = new Worker('lib/word-export.worker.js');
      let settled = false;
      const id = `${Date.now()}-${Math.random()}`;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        worker.terminate();
        reject(new Error('word export worker timeout'));
      }, 120000);
      worker.onmessage = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        if (e.data && e.data.success) {
          resolve(e.data.arrayBuffer);
        } else {
          reject(new Error((e.data && e.data.error) || 'word export worker failed'));
        }
      };
      worker.onerror = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        reject(err);
      };
      worker.postMessage({ id, html });
    });
  }

  // 把 Word HTML 转成 docx 的 ArrayBuffer；优先走 Worker，失败或 Worker 不可用时回退主线程。
  async _convertHtmlToDocxBuffer(html) {
    if (typeof Worker !== 'undefined') {
      try {
        return await this._runWordExportWorker(html);
      } catch (e) {
        console.warn('Word export worker failed, falling back to main thread:', e);
      }
    }
    if (typeof htmlDocx !== 'undefined') {
      const blob = htmlDocx.asBlob(html);
      return await blob.arrayBuffer();
    }
    throw new Error('导出组件未加载（html-docx 未加载）');
  }

  // 给导出到 Word 的 <img> 同时设置 HTML width/height 属性 + CSS 尺寸。
  // Word 的 HTML 导入器对 CSS width 支持不可靠（会按图片原始像素渲染导致超宽被裁），
  // 但对 HTML width/height 属性支持稳定，因此以属性为主、CSS 为辅双保险。
  //   natW/natH : 图像真实像素尺寸（用于算宽高比）
  //   maxW      : 宽度上限（CSS px），默认 500；原显示宽度 < maxW 的小图保持原尺寸不放大
  //   cssW      : 原始「显示宽度」（CSS px）；未传时以 natW 当作显示宽（普通图片路径）
  _applyWordImgSize(img, natW, natH, maxW, cssW) {
    // 单图高度上限（CSS px）：A4 默认页边距下内容区约 930px，取 850 留出容器/上下文余量，避免高图跨页被截断。
    const WORD_PAGE_MAX_CSS_HEIGHT = 850;
    const wMax = Math.max(1, Math.round(maxW || 500));
    // 显示参考宽度：优先用 cssW（原始显示宽），否则退化为 natW（普通图片的 naturalWidth）
    const refW = (cssW && cssW > 0) ? cssW : (natW > 0 ? natW : wMax);
    // 小图（显示宽 < 上限）保持原显示尺寸，不放大；大图限制到上限宽度
    let targetW = refW < wMax ? Math.max(1, Math.round(refW)) : wMax;
    let targetH = null;
    if (natW > 0 && natH > 0) {
      const ratio = natH / natW;
      targetH = Math.round(targetW * ratio);
      // 高度限制：等比缩放后高度超过一页可用高度，则按高度反推宽度，强制等比例缩小
      if (targetH > WORD_PAGE_MAX_CSS_HEIGHT) {
        targetH = WORD_PAGE_MAX_CSS_HEIGHT;
        targetW = Math.max(1, Math.round(targetH / ratio));
      }
    }
    img.setAttribute('width', targetW);
    img.style.width = targetW + 'px';
    if (targetH != null) {
      img.setAttribute('height', targetH);
      img.style.height = targetH + 'px';
    } else {
      img.style.height = 'auto';
    }
  }

  // 把 canvas 像素宽度限制在 maxPxW 以内（等比缩小），返回新 canvas；无需缩放时原样返回。
  // 用于避免 html2canvas 2× 截图后像素过大导致 docx 膨胀、且 Word 按原始大像素渲染溢出页面。
  _scaleCanvasDown(canvas, maxPxW) {
    try {
      if (!canvas || canvas.width <= 0 || canvas.width <= maxPxW) return canvas;
      const scale = maxPxW / canvas.width;
      const newW = Math.max(1, Math.round(maxPxW));
      const newH = Math.max(1, Math.round(canvas.height * scale));
      const out = document.createElement('canvas');
      out.width = newW;
      out.height = newH;
      const ctx = out.getContext('2d');
      if (!ctx) return canvas;
      ctx.drawImage(canvas, 0, 0, newW, newH);
      return out;
    } catch (e) {
      return canvas;
    }
  }

  // Word 导出前的 DOM 预处理：把 Web 预览中 Word HTML 导入器会曲解的结构，
  // 转成 Word 能稳定渲染的等价形式，并内联关键样式。
  async _prepareWordDOM(clone) {
    // 把 clone 临时挂到离屏 DOM，确保 html2canvas 能拿到真实布局与样式。
    const holder = document.createElement('div');
    holder.style.position = 'fixed';
    holder.style.left = '-9999px';
    holder.style.top = '0';
    holder.style.zIndex = '-1';
    holder.appendChild(clone);
    document.body.appendChild(holder);

    try {
    // 1. 删除线 / 插入线：Word 会把 <del>/<ins> 当成修订追踪，换成等效 <span>
    clone.querySelectorAll('del').forEach((el) => {
      const span = document.createElement('span');
      span.style.textDecoration = 'line-through';
      span.style.color = '#5e5e62';
      span.innerHTML = el.innerHTML;
      el.replaceWith(span);
    });
    clone.querySelectorAll('ins').forEach((el) => {
      const span = document.createElement('span');
      span.style.textDecoration = 'underline';
      span.innerHTML = el.innerHTML;
      el.replaceWith(span);
    });

    // 2. 任务列表：Word 不会渲染 <input type="checkbox">，换成 Unicode 字符
    clone.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      const span = document.createElement('span');
      span.textContent = cb.checked ? '☑ ' : '☐ ';
      const li = cb.closest ? cb.closest('li') : null;
      if (li) {
        const ul = li.parentElement;
        if (ul && ul.tagName === 'UL') {
          ul.style.listStyleType = 'none';
          ul.style.paddingLeft = '0';
        }
      }
      cb.replaceWith(span);
    });

    // 3. 列表项包裹的 <p> 会导致 Word 把 bullet 与文字分两段；含嵌套列表时也要 unwrap。
    //    循环处理直到没有 <li> 直接子 <p> 为止。
    let pInLi;
    while ((pInLi = clone.querySelector('li > p'))) {
      const li = pInLi.parentElement;
      // 把 <p> 的内容移到 <p> 之前，保留后续兄弟（如嵌套 <ul>/<ol>）
      while (pInLi.firstChild) li.insertBefore(pInLi.firstChild, pInLi);
      pInLi.remove();
    }
    // 清除列表项里的空文本节点，避免 Word 把它们渲染成空 bullet
    clone.querySelectorAll('li').forEach((li) => {
      for (let i = li.childNodes.length - 1; i >= 0; i--) {
        const node = li.childNodes[i];
        if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) {
          node.remove();
        }
      }
    });

    // 4. 代码块：.code-line flex 结构 + 语法高亮 span 在 Word 里常变成带框小格。
    //     Word 对 <pre> 预格式化识别最好；内部用 <br> 强制换行，white-space:pre 禁止自动硬折行。
    const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    clone.querySelectorAll('pre').forEach((pre) => {
      const code = pre.querySelector('code');
      let plain = '';
      if (code) {
        const scroll = code.querySelector('.code-scroll');
        if (scroll) {
          const lines = [];
          scroll.querySelectorAll('.code-line').forEach((line) => {
            const text = line.querySelector('.code-line-text');
            lines.push(text ? text.textContent : line.textContent);
          });
          plain = lines.join('\n');
        } else {
          plain = code.textContent;
        }
      } else {
        plain = pre.textContent;
      }
      plain = plain.replace(/\n+\s*$/, '');
      if (!plain) plain = '';

      const wrapper = document.createElement('div');
      wrapper.className = 'tizu-code-block';
      wrapper.style.background = '#f6f5f4';
      wrapper.style.border = '1px solid #d4d4d8';
      wrapper.style.borderRadius = '6px';
      wrapper.style.padding = '16px';
      wrapper.style.margin = '16px 0';
      wrapper.style.maxWidth = '100%';
      wrapper.style.overflowX = 'auto';
      wrapper.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

      const newPre = document.createElement('pre');
      newPre.style.cssText = 'margin:0;padding:0;background:transparent;border:none;font-family:"SF Mono","Fira Code",monospace;font-size:0.9em;line-height:1.5;white-space:pre;word-wrap:normal;word-break:keep-all;';
      newPre.innerHTML = plain.split('\n').map((line) => escapeHtml(line || ' ')).join('<br>');

      wrapper.appendChild(newPre);
      pre.replaceWith(wrapper);
    });

    // 5. 引用块：内联样式 + 段落内换行换成 <br>
    clone.querySelectorAll('blockquote').forEach((bq) => {
      bq.style.background = '#f6f5f4';
      bq.style.borderLeft = '4px solid #2563eb';
      bq.style.padding = '12px 20px';
      bq.style.margin = '0 0 16px 0';
      bq.style.borderRadius = '0 6px 6px 0';
      bq.style.color = '#5e5e62';
      bq.querySelectorAll('p').forEach((p) => {
        p.style.marginBottom = '0';
        if (p.innerHTML.includes('\n')) p.innerHTML = p.innerHTML.replace(/\n/g, '<br>');
      });
    });

    // 6. 提示框（Alerts）：Word 对 <style> 里的 rgba/类选择器支持不稳定，内联实色
    const alertMap = {
      'alert-note': { bg: '#eef4ff', border: '#3884ff' },
      'alert-tip': { bg: '#e9f9f1', border: '#10b981' },
      'alert-important': { bg: '#f3edfd', border: '#8b5cf6' },
      'alert-warning': { bg: '#fef6e7', border: '#f59e0b' },
      'alert-caution': { bg: '#fdecec', border: '#ef4444' }
    };
    clone.querySelectorAll('.alert').forEach((alert) => {
      let style = alertMap['alert-note'];
      for (const cls of alert.classList) {
        if (alertMap[cls]) { style = alertMap[cls]; break; }
      }
      alert.style.borderRadius = '10px';
      alert.style.padding = '14px 18px';
      alert.style.margin = '16px 0';
      alert.style.maxWidth = '100%';
      alert.style.borderLeft = `4px solid ${style.border}`;
      alert.style.background = style.bg;
      alert.style.overflowWrap = 'break-word';
      const title = alert.querySelector('.alert-title');
      if (title) {
        title.style.fontWeight = '700';
        title.style.marginBottom = '6px';
        title.style.fontSize = '0.95em';
        title.style.display = 'block';
      }
      alert.querySelectorAll('p').forEach((p) => { p.style.marginBottom = '0'; });
    });

    // 7. 高亮：内联背景色
    clone.querySelectorAll('mark').forEach((m) => {
      m.style.display = 'inline-block';
      m.style.background = '#fbbf24';
      m.style.color = '#1a1a1a';
      m.style.padding = '1px 4px';
      m.style.borderRadius = '3px';
    });

    // 8. 数学公式：KaTeX HTML/MathML 在 Word HTML 导入里基本都失败，
    //     用 html2canvas 把 .katex 渲染成 PNG 内联图最稳；失败再保留 MathML。
    const katexEls = Array.from(clone.querySelectorAll('.katex'));
    for (const katex of katexEls) {
      let dataUrl = '';
      let natW = 0, natH = 0;
      try {
        if (typeof html2canvas !== 'undefined') {
          const canvas = await html2canvas(katex, {
            scale: 2,
            backgroundColor: null,
            useCORS: true
          });
          const trimmed = this._trimCanvas(canvas, { backgroundColor: null, padding: 2 });
          // 限制像素宽度，避免 docx 膨胀 + Word 按原始大像素渲染溢出页面。
          const scaled = this._scaleCanvasDown(trimmed, 1000);
          dataUrl = scaled.toDataURL('image/png');
          natW = scaled.width;
          natH = scaled.height;
        }
      } catch (e) { dataUrl = ''; }
      if (!dataUrl) {
        const mathml = katex.querySelector('.katex-mathml');
        if (mathml) {
          const math = mathml.querySelector('math');
          if (math) {
            const newMath = math.cloneNode(true);
            if (!newMath.getAttribute('xmlns')) {
              newMath.setAttribute('xmlns', 'http://www.w3.org/1998/Math/MathML');
            }
            katex.replaceWith(newMath);
            continue;
          }
        }
      }
      if (!dataUrl) continue;
      const img = document.createElement('img');
      img.src = dataUrl;
      img.className = 'tizu-math-img';
      // 截图是 2× 像素，显示参考宽度应取一半（预览看到的 CSS 宽），否则小公式会被当作 2× 大图放大到 500；
      // 小于 500 的小公式保持原显示尺寸，大公式限制到 500，过高再按高度等比缩小。
      this._applyWordImgSize(img, natW, natH, 500, natW > 0 ? natW / 2 : 0);
      img.style.verticalAlign = 'middle';
      katex.replaceWith(img);
      // 让出主线程，使 loading spinner 与鼠标事件有机会处理。
      await new Promise((r) => setTimeout(r, 0));
    }

    // 9. Mermaid 图表：SVG 在 Word HTML 导入里常丢失，转成 PNG 内联图。
    //    截图前临时去掉容器 padding/border/background，让容器紧包 SVG；
    //    截图后裁剪透明边，并以实际内容尺寸显示（不超宽时不满页拉伸）。
    const mermaidContainers = Array.from(clone.querySelectorAll('.mermaid-container'));
    for (const container of mermaidContainers) {
      let dataUrl = '';
      let natW = 0, natH = 0, cssW = 0;
      // 备份原样式，截图后恢复（最终 Word HTML 里仍保留灰底框装饰）。
      const savedStyle = {
        padding: container.style.padding,
        border: container.style.border,
        background: container.style.background,
        backgroundColor: container.style.backgroundColor,
        borderRadius: container.style.borderRadius,
        margin: container.style.margin,
        overflow: container.style.overflow,
        textAlign: container.style.textAlign,
      };
      try {
        container.style.padding = '0';
        container.style.border = 'none';
        container.style.background = 'transparent';
        container.style.backgroundColor = 'transparent';
        container.style.borderRadius = '0';
        container.style.margin = '0';
        container.style.overflow = 'visible';
        container.style.textAlign = 'left';
        if (typeof html2canvas !== 'undefined') {
          const canvas = await html2canvas(container, {
            scale: 2,
            backgroundColor: null,
            useCORS: true
          });
          const trimmed = this._trimCanvas(canvas, { backgroundColor: null, padding: 4 });
          // 把图片像素本身限制在 1000px 宽以内（2× 显示宽度），避免 docx 膨胀且 Word 按原始大像素渲染时溢出页面。
          const scaled = this._scaleCanvasDown(trimmed, 1000);
          dataUrl = scaled.toDataURL('image/png');
          natW = scaled.width;
          natH = scaled.height;
          cssW = scaled.width / 2; // 2× 截图，显示参考宽度取一半
        }
      } catch (e) { dataUrl = ''; }
      // 恢复容器装饰样式
      Object.assign(container.style, savedStyle);
      if (!dataUrl) {
        const svg = container.querySelector('svg');
        if (svg) {
          try {
            dataUrl = await this._svgToPngDataUrl(svg);
            // 从 svg 取自然尺寸用于等比高度
            let sw = 0, sh = 0;
            const vb = svg.getAttribute('viewBox');
            if (vb) { const p = vb.trim().split(/\s+/).map(Number); if (p.length >= 4) { sw = p[2]; sh = p[3]; } }
            if (!sw || !sh) { sw = parseFloat(svg.getAttribute('width')) || 0; sh = parseFloat(svg.getAttribute('height')) || 0; }
            if (!sw || !sh) { const r = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null; if (r) { sw = r.width; sh = r.height; } }
            natW = sw; natH = sh; cssW = sw; // sw 已是 CSS 显示宽
          } catch (e) { dataUrl = ''; }
        }
      }
      if (!dataUrl) continue;
      const img = document.createElement('img');
      img.src = dataUrl;
      img.className = 'tizu-mermaid-img';
      // 同时设置 HTML width/height 属性：小于 500 的小图保持原显示尺寸，大图限制 500，
      // 过高则按页面高度上限等比缩小，确保 Word 中完整显示、不跨页裁切。
      this._applyWordImgSize(img, natW, natH, 500, cssW);
      img.style.display = 'inline-block';
      container.innerHTML = '';
      container.style.textAlign = 'center';
      container.style.padding = '16px';
      container.style.background = '#f0efee';
      container.style.border = '1px solid #d4d4d8';
      container.style.borderRadius = '8px';
      container.style.maxWidth = '100%';
      container.style.boxSizing = 'border-box';
      container.appendChild(img);
      // 让出主线程，使 loading spinner 与鼠标事件有机会处理。
      await new Promise((r) => setTimeout(r, 0));
    }

    // 10. 普通图片：读取自然尺寸，按宽高比等比缩放到 500px，并设置 HTML width/height 属性，
    //     确保 Word 按此尺寸完整显示、不裁切（CSS width 在 Word 导入器里不可靠）。
    //     公式（.tizu-math-img）与 Mermaid（.tizu-mermaid-img）已单独处理为 500px，这里跳过以免被覆盖。
    const plainImages = Array.from(clone.querySelectorAll('img')).filter((img) => {
      return !img.classList.contains('tizu-math-img') && !img.classList.contains('tizu-mermaid-img');
    });
    await Promise.all(plainImages.map(async (img) => {
      // 优先用导出前从真实预览采集的渲染尺寸（dataset），不再依赖 new Image() 异步重加载——
      // 该方式在 SVG（naturalWidth 为 0）、图片未成功内联、或加载超时时会读取失败，
      // 导致 natW=0、所有图片退化为 width=500（小图被放大、超高图高度上限失效）。
      let natW = parseInt(img.dataset.natW || '0', 10) || 0;
      let natH = parseInt(img.dataset.natH || '0', 10) || 0;
      const dispW = parseInt(img.dataset.dispW || '0', 10) || 0;
      const dispH = parseInt(img.dataset.dispH || '0', 10) || 0;
      // naturalWidth/naturalHeight 不可靠（如 SVG）时，用显示尺寸兜底，保证宽高比与高度上限可用。
      if (natW <= 0 && dispW > 0) natW = dispW;
      if (natH <= 0 && dispH > 0) natH = dispH;
      // 先清除原始 width/height 属性（如 width="1200"），再由 _applyWordImgSize 写入正确的等比尺寸。
      img.removeAttribute('width');
      img.removeAttribute('height');
      this._applyWordImgSize(img, natW, natH, 500, dispW > 0 ? dispW : natW);
      img.style.display = 'inline-block';
      img.style.maxWidth = '100%';
    }));

    } finally {
      holder.remove();
    }
  }

  async exportHTML() {
    try {
      const path = await dialogSave({
        defaultPath: this.activeTab.filePath
          ? this.activeTab.filePath.replace(/\.md$/, '.html')
          : 'export.html',
        filters: [{ name: 'HTML', extensions: ['html'] }]
      });
      if (!path) return;

      const clone = this.preview.cloneNode(true);
      clone.style.position = '';
      clone.style.left = '';
      clone.style.top = '';
      clone.style.width = '';
      clone.style.padding = '';
      clone.style.overflow = '';
      clone.style.height = '';

      clone.querySelectorAll('.copy-btn').forEach(el => el.remove());
      const abbrData = clone.querySelector('#abbr-data');
      if (abbrData) abbrData.remove();

      await this._inlineImagesForExport(clone, this.activeTab.filePath);

      let katexCSS = '';
      try {
        const resp = await fetch('lib/katex/katex.min.css');
        if (resp.ok) katexCSS = await resp.text();
      } catch (e) { /* skip */ }

      let hljsCSS = '';
      try {
        const themeLink = document.getElementById('highlight-theme');
        if (themeLink) {
          const resp = await fetch(themeLink.getAttribute('href'));
          if (resp.ok) hljsCSS = await resp.text();
        }
      } catch (e) { /* skip */ }

      const escapedTitle = this.activeTab.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const fullHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${escapedTitle}</title>
  <style>
    ${this._documentExportCSS()}
${katexCSS ? katexCSS + '\n' : ''}${hljsCSS ? hljsCSS : ''}
  </style>
</head>
<body>
${clone.innerHTML}
</body>
</html>`;

      await TauriApi.writeFile({ path, content: fullHTML });
      this.setStatus(`${this.t('exportedHTML')}: ${path}`);
    } catch (error) {
      this.setStatus(`${this.t('exportFailed')}: ${error}`);
    }
  }

  async exportWord() {
    if (typeof htmlDocx === 'undefined') {
      this.reportError('E_RENDER', { detail: '导出组件未加载（html-docx 未加载）' });
      return;
    }

    // 与导出 PDF 一致的确认框：提示 Word 导出特性与耗时风险，用户确认后再继续。
    const proceed = await this.showConfirmDialog(
      this.t('exportWord'),
      this.t('wordTip1') + '\n\n' + this.t('wordTip2'),
      null,
      this.t('wordBigFileWarn'),
    );
    if (!proceed) return;

    // Loading overlay：导出过程（尤其是 html2canvas 渲染公式/图表）可能阻塞主线程，
    // 给用户一个明确的等待反馈；60s watchdog 兜底防止 overlay 永远不消失。
    const overlay = document.createElement('div');
    overlay.innerHTML = `<div class="pdf-loading-spinner"></div><div class="pdf-loading-text">${this.t('preparingWordExport')}</div>`;
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.35);font-family:-apple-system,sans-serif;';
    if (!document.getElementById('pdf-loading-style')) {
      const s = document.createElement('style');
      s.id = 'pdf-loading-style';
      s.textContent = '.pdf-loading-spinner{width:36px;height:36px;border:3px solid rgba(255,255,255,0.25);border-top-color:#fff;border-radius:50%;animation:pdf-spin .7s linear infinite;margin-bottom:14px;}@keyframes pdf-spin{to{transform:rotate(360deg)}}.pdf-loading-text{color:#fff;font-size:15px;letter-spacing:.5px;}';
      document.head.appendChild(s);
    }
    document.body.appendChild(overlay);

    let overlayDone = false;
    let exported = false;
    const hideOverlay = () => {
      if (overlayDone) return;
      overlayDone = true;
      if (overlay.parentNode) overlay.remove();
    };

    let watchdog = null;
    try {
      // 先让 overlay 渲染出来，再执行可能较重的同步/阻塞操作。
      await new Promise(r => requestAnimationFrame(r));

      const path = await dialogSave({
        defaultPath: this.activeTab.filePath
          ? this.activeTab.filePath.replace(/\.md$/, '.docx')
          : 'export.docx',
        filters: [{ name: 'Word 文档', extensions: ['docx'] }]
      });
      if (!path) {
        hideOverlay();
        return;
      }

      // watchdog 只在「真正开始导出处理」之后才计时，不把用户选文件的时间算进去；
      // 超时放宽到 120s，避免公式/图表多、文档大时导出仍在进行却被误判卡死提前撤掉遮罩。
      watchdog = setTimeout(() => {
        this.setStatus(this.t('exportError'));
        hideOverlay();
      }, 120000);

      const clone = this.preview.cloneNode(true);
      clone.style.position = '';
      clone.style.left = '';
      clone.style.top = '';
      clone.style.width = '';
      clone.style.padding = '';
      clone.style.overflow = '';
      clone.style.height = '';

      clone.querySelectorAll('.copy-btn').forEach(el => el.remove());
      const abbrData = clone.querySelector('#abbr-data');
      if (abbrData) abbrData.remove();

      // 从真实预览元素采集每张图片的渲染尺寸（仍在文档流中，getBoundingClientRect / naturalWidth 可靠），
      // 写入 clone 的同源 <img>，供 _prepareWordDOM 设置导出尺寸。
      // 不再依赖 _prepareWordDOM 内 new Image() 异步重加载：该方式在 SVG（naturalWidth 为 0）、
      // 图片未成功内联、或加载超时时会读取失败 → natW=0 → 所有图片退化为 width=500
      // （小图被放大、超高图因不设 height 而跨页被裁）。
      {
        const srcImgs = Array.from(this.preview.querySelectorAll('img'));
        const dstImgs = Array.from(clone.querySelectorAll('img'));
        dstImgs.forEach((dimg, i) => {
          const simg = srcImgs[i];
          if (!simg) return;
          // 若预览元素已带 dataset（测试模拟已渲染），优先使用；否则取真实布局尺寸。
          const dw = simg.dataset.dispW ? parseInt(simg.dataset.dispW, 10)
            : (Math.round(simg.getBoundingClientRect().width) || 0);
          const dh = simg.dataset.dispH ? parseInt(simg.dataset.dispH, 10)
            : (Math.round(simg.getBoundingClientRect().height) || 0);
          dimg.dataset.natW = String(simg.naturalWidth || 0);
          dimg.dataset.natH = String(simg.naturalHeight || 0);
          dimg.dataset.dispW = String(dw || (simg.naturalWidth || 0));
          dimg.dataset.dispH = String(dh || (simg.naturalHeight || 0));
        });
      }

      await this._inlineImagesForExport(clone, this.activeTab.filePath);

      // 把 Web 预览 DOM 转换成 Word HTML 导入器能稳定渲染的结构。
      await this._prepareWordDOM(clone);

      const escapedTitle = this.activeTab.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      // KaTeX / highlight.js 主题：与 HTML 导出一致，让公式与代码配色贴近预览。
      // 深色调下 hljs 主题背景为深色，会与浅色文档冲突，故深色模式跳过（代码块仍保留浅灰底）。
      let katexCSS = '';
      try {
        const resp = await fetch('lib/katex/katex.min.css');
        if (resp.ok) katexCSS = await resp.text();
      } catch (e) { /* skip */ }

      let hljsCSS = '';
      if (!this.isDark) {
        try {
          const themeLink = document.getElementById('highlight-theme');
          if (themeLink) {
            const resp = await fetch(themeLink.getAttribute('href'));
            if (resp.ok) hljsCSS = await resp.text();
          }
        } catch (e) { /* skip */ }
      }

      // html-docx-js 把整段 HTML 作为 altChunk 嵌入 .docx，由 Word 自身的 HTML 导入器渲染，
      // 因此 <head> 里的 <style> 会被应用——套用与 HTML 导出相同的基础样式表即可贴近预览。
      // Word 导入器不支持 rgba()，这里把提示框底色换成近似实色；其余圆角/阴影等属性被忽略无副作用。
      const wordOverride = `
    .alert { background: #f6f5f4; border-left-color: #d4d4d8; }
    .alert-note { background: #eef4ff; border-left-color: #3884ff; }
    .alert-tip { background: #e9f9f1; border-left-color: #10b981; }
    .alert-important { background: #f3edfd; border-left-color: #8b5cf6; }
    .alert-warning { background: #fef6e7; border-left-color: #f59e0b; }
    .alert-caution { background: #fdecec; border-left-color: #ef4444; }
    .mermaid-container { width: 100%; max-width: 100%; box-sizing: border-box; }`;
      const wordStyle = `${this._documentExportCSS()}\n${wordOverride}\n${katexCSS ? katexCSS + '\n' : ''}${hljsCSS ? hljsCSS : ''}`;

      const wordHTML = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="UTF-8"><title>${escapedTitle}</title>
<style>
${wordStyle}
</style></head>
<body>
${clone.innerHTML}
</body>
</html>`;

      const arrayBuffer = await this._convertHtmlToDocxBuffer(wordHTML);
      const buf = new Uint8Array(arrayBuffer);
      await TauriApi.writeBinaryFile({ path, contents: buf });
      clearTimeout(watchdog);
      this.setStatus(`${this.t('exportedWord')}: ${path}`);
      exported = true;
    } catch (error) {
      clearTimeout(watchdog);
      console.error('exportWord error:', error);
      this.setStatus(`${this.t('exportFailed')}: ${error}`);
    } finally {
      hideOverlay();
      // 导出真正完成后（写入文件成功）再弹成功提示；先关遮罩，确保 toast 不被遮住。
      if (exported) {
        this.showToast(this.t('exportSuccess'), 'success');
      }
    }
  }

  async exportImage() {
    if (typeof html2canvas === 'undefined') {
      this.reportError('E_RENDER', { detail: '导出组件未加载（html2canvas not loaded）' });
      return;
    }

    let clone = null;
    try {
      this.setStatus(this.t('generatingImg'));

      clone = this.preview.cloneNode(true);
      clone.style.position = 'fixed';
      clone.style.left = '-9999px';
      clone.style.top = '0';
      clone.style.width = '800px';
      clone.style.padding = '32px';
      clone.style.background = this.isDark ? '#1a1b1e' : '#ffffff';
      clone.style.color = this.isDark ? '#d4d4d8' : '#2a2a2e';
      clone.style.overflow = 'visible';
      clone.style.height = 'auto';
      document.body.appendChild(clone);

      // 图片加载策略与实时预览 processImages 保持一致：
      // data:/http(s):/file:/blob: 直接保留；绝对路径直接读取；相对路径按当前文档目录解析
      const images = clone.querySelectorAll('img');
      const tabFile = this.activeTab ? this.activeTab.filePath : '';
      const imgDir = tabFile ? tabFile.replace(/[/\\][^/\\]*$/, '') : '';
      const imagePromises = Array.from(images).map(async (img) => {
        const src = img.getAttribute('src');
        if (!src || src.startsWith('data:') || src.startsWith('http://') ||
            src.startsWith('https://') || src.startsWith('file://') || src.startsWith('blob:')) return;

        let url = src;
        if (!(src.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(src)) && imgDir) {
          url = imgDir + '/' + src; // 相对路径按文档目录解析
        }

        try {
          const base64 = await TauriApi.fetchImageAsBase64({ url });
          const ext = src.split('.').pop().split('?')[0].toLowerCase();
          let mime = 'image/png';
          if (ext === 'jpg' || ext === 'jpeg') mime = 'image/jpeg';
          else if (ext === 'gif') mime = 'image/gif';
          else if (ext === 'svg') mime = 'image/svg+xml';
          else if (ext === 'webp') mime = 'image/webp';
          img.src = `data:${mime};base64,${base64}`;
        } catch (e) {
          img.style.border = '1px solid red';
          img.alt = this.t('imageLoadFailed');
        }
      });

      await Promise.all(imagePromises);
      await new Promise(r => setTimeout(r, 300));

      const canvas = await html2canvas(clone, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        backgroundColor: this.isDark ? '#1a1b1e' : '#ffffff',
        width: 800,
        windowWidth: 800
      });

      const imgData = canvas.toDataURL('image/png');

      const result = await dialogSave({
        defaultPath: `${this.activeTab.name.replace(/\.[^.]+$/, '')}.png`,
        filters: [{ name: 'PNG', extensions: ['png'] }]
      });

      if (!result) return;

      const base64 = imgData.split(',')[1];
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const arr = Array.from(bytes);
      await TauriApi.writeBinaryFile({ path: result, contents: arr });

      this.setStatus(`${this.t('exportedImg')}: ${result}`);
    } catch (error) {
      this.setStatus(`${this.t('exportFailed')}: ${error}`);
    } finally {
      if (clone && clone.parentNode) {
        clone.parentNode.removeChild(clone);
      }
    }
  }

  async exportPDF() {
    // Print tips + 醒目警示（"文件较大时生成 PDF 耗时较长..."）一起在确认框里展示，
    // 用户点确认后直接走系统打印对话框，不再做任何"是否写完"的承诺。
    const proceed = await this.showConfirmDialog(
      this.t('exportPDF'),
      this.t('printTip1') + '\n\n' + this.t('printTip2'),
      null,
      this.t('pdfBigFileWarn'),
    );
    if (!proceed) return;

    // --- Loading overlay (打印准备中，afterprint 立即收尾) ---
    const overlay = document.createElement('div');
    overlay.innerHTML = `<div class="pdf-loading-spinner"></div><div class="pdf-loading-text">${this.t('preparingPrint')}</div>`;
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.35);font-family:-apple-system,sans-serif;';
    if (!document.getElementById('pdf-loading-style')) {
      const s = document.createElement('style');
      s.id = 'pdf-loading-style';
      s.textContent = '.pdf-loading-spinner{width:36px;height:36px;border:3px solid rgba(255,255,255,0.25);border-top-color:#fff;border-radius:50%;animation:pdf-spin .7s linear infinite;margin-bottom:14px;}@keyframes pdf-spin{to{transform:rotate(360deg)}}.pdf-loading-text{color:#fff;font-size:15px;letter-spacing:.5px;}';
      document.head.appendChild(s);
    }
    document.body.appendChild(overlay);

    let overlayDone = false;
    const hideOverlay = () => {
      if (overlayDone) return;
      overlayDone = true;
      if (overlay.parentNode) overlay.remove();
    };

    try {
      // Yield so the overlay paints before CPU-heavy Mermaid work
      await new Promise(r => requestAnimationFrame(r));

      // 文件名：取自当前 md，去扩展名。系统打印对话框默认文件名走主窗口 document.title
      // （_exportViaSystemPrint 在 iframe.onload 里临时覆盖为该值），无需在应用内另弹保存框。
      const pdfBaseName = String(this.activeTab.name || '').replace(/\.[^.]+$/, '');
      const safeBaseName = pdfBaseName || this.t('untitled') || 'document';

      const clone = this.preview.cloneNode(true);
      clone.querySelectorAll('.copy-btn, #abbr-data').forEach(el => el.remove());

      // 图片内联：把预览里的 blob:/file:///相对路径图片全部转内联 base64，
      // 使打印帧自包含（不受 blob LRU 回收 / 源解析影响，根除 PDF 空白图）。
      await this._inlineImagesForExport(clone, this.activeTab.filePath);

      // Re-render Mermaid via mermaid.render() so every diagram gets a
      // consistent viewBox regardless of the current preview-pane width.
      const mermaidContainers = Array.from(clone.querySelectorAll('.mermaid-container'));
      if (typeof mermaid !== 'undefined' && mermaidContainers.length) {
        const ff = getComputedStyle(document.documentElement).getPropertyValue('--font-preview').trim() || '-apple-system, sans-serif';
        mermaid.initialize({ startOnLoad: false, theme: this.isDark ? 'dark' : 'default', securityLevel: 'loose', fontFamily: ff, themeVariables: { fontSize: '14px' } });
        for (let i = 0; i < mermaidContainers.length; i++) {
          const code = (mermaidContainers[i].getAttribute('data-code') || mermaidContainers[i].textContent || '').trim();
          if (!code) continue;
          try {
            const result = await mermaid.render('pdf-mermaid-' + i, code);
            const wrapper = document.createElement('div');
            wrapper.className = 'mermaid-container';
            wrapper.innerHTML = result.svg;
            const svgEl = wrapper.querySelector('svg');
            if (svgEl) {
              svgEl.removeAttribute('style');
              svgEl.removeAttribute('width');
              svgEl.removeAttribute('height');
              const vb = svgEl.getAttribute('viewBox');
              if (vb) {
                const parts = vb.split(/\s+/);
                if (parts.length >= 4) {
                  svgEl.setAttribute('width', parts[2]);
                  svgEl.setAttribute('height', parts[3]);
                }
              }
            }
            mermaidContainers[i].replaceWith(wrapper);
          } catch (e) {
            console.error('Mermaid PDF render error for diagram', i, ':', e);
          }
        }
      }

      // 完整 styles.css：优先 fetch（原始文本保真），失败回退已加载样式表 CSSOM（加固，避免软依赖）
      const appCSS = await this._loadStylesheetText('styles.css');
      let hljsCSS = '';
      try { const themeLink = document.getElementById('highlight-theme'); if (themeLink) { const resp = await fetch(themeLink.getAttribute('href')); if (resp.ok) hljsCSS = await resp.text(); } } catch (e) { /* skip */ }
      let katexCSS = '';
      try { const resp = await fetch('lib/katex/katex.min.css'); if (resp.ok) katexCSS = await resp.text(); } catch (e) { /* skip */ }

      // escapedTitle：用于打印帧 <title> / contentDocument.title（去扩展名文件名已在上文取得）
      const escapedTitle = safeBaseName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      const colorScheme = document.documentElement.getAttribute('data-color-scheme') || 'default';

      const printCSS = `
@page { margin: 1.5cm; }
html, body { margin: 0 !important; padding: 0 !important; background: white !important; }
.preview-content { max-width: 680px !important; margin: 0 auto !important; padding: 16px 24px !important; }
.preview-content pre { white-space: pre-wrap !important; word-wrap: break-word !important; word-break: break-word !important; overflow: visible !important; }
.preview-content pre code { white-space: pre-wrap !important; word-wrap: break-word !important; word-break: break-word !important; }
/* 代码块 hljs 默认主题里 .hljs 元素带 background:#ffffff，会盖住 pre 的灰色形成"内白外灰"。
   强制透明 + 12px 内边距，让整个代码块统一是 pre 的 --code-bg 灰色（与软件预览一致）。 */
.preview-content pre code.hljs,
.preview-content pre .hljs { background: transparent !important; padding: 12px 16px !important; }
/* 代码块行结构（导出 iframe 没载入 styles.css，code-block.js 输出的 .code-line 必须显式块级化） */
.code-scroll { max-height: none !important; overflow: visible !important; }
.code-line { display: flex !important; line-height: 1.8 !important; min-width: 0 !important; }
.code-line-num { flex-shrink: 0 !important; width: 3em !important; text-align: right !important; padding-right: 0.8em !important; color: #888 !important; user-select: none !important; display: none !important; }
.preview-content.code-line-numbers .code-line-num { display: inline !important; }
.code-line-text { white-space: pre-wrap !important; word-wrap: break-word !important; word-break: break-word !important; flex: 1 1 auto !important; min-width: 0 !important; }
.mermaid-container { margin: 8px 0 !important; max-width: 100% !important; overflow: hidden !important; break-inside: avoid; page-break-inside: avoid; }
.mermaid-container svg { width: auto !important; max-width: 100% !important; height: auto !important; display: block !important; margin: 0 auto !important; }
.mermaid-container svg text, .mermaid-container svg .nodeLabel, .mermaid-container svg .edgeLabel, .mermaid-container svg .label, .mermaid-container svg textPath { font-size: 14px !important; }
.mermaid-container svg foreignObject,
.mermaid-container svg foreignObject div,
.mermaid-container svg foreignObject span { font-size: 14px !important; line-height: 1.4 !important; }
h1, h2, h3 { page-break-after: avoid; }
blockquote, table, img, .math-display, .alert, .mermaid-container { page-break-inside: avoid; }
p, li { orphans: 3; widows: 3; }
input[type="checkbox"] { -webkit-appearance: none; appearance: none; margin-right: 8px; width: 16px; height: 16px; border: 1.5px solid #d4d4d8; border-radius: 3px; vertical-align: middle; position: relative; top: -1px; cursor: default; }
input[type="checkbox"]:checked { background: #16a34a url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIzIiBmaWxsPSJub25lIj48cGF0aCBkPSJNNSAxM2w0IDRMMTkgNyIvPjwvc3ZnPg==") center / 14px no-repeat; border-color: #16a34a; }
input[type="checkbox"]:checked::after { display: none !important; }
`;

      const html = `<!DOCTYPE html>
<html lang="zh-CN" data-color-scheme="${colorScheme}" data-theme="light">
<head><meta charset="UTF-8"><title>${escapedTitle}</title>
<style>${appCSS}${hljsCSS}${katexCSS}${printCSS}</style></head>
<body>
<div class="preview-content">${clone.innerHTML}</div>
</body></html>`;

      // 系统打印（iframe + contentWindow.print()）：用 OS 打印引擎生成 PDF，保证文字可选中。
      // afterprint 即收尾，不做落盘检测——OS 打印后台异步落盘是浏览器架构限制，
      // 应用拿不到"写完"回调。警示已在确认框里展示，由用户自己判断何时打开。
      await this._exportViaSystemPrint(html, safeBaseName, escapedTitle, hideOverlay);
    } catch (e) {
      console.error('exportPDF error:', e);
      hideOverlay();
      this.setStatus(this.t('exportError'));
    }
  }

  // 系统打印路径（iframe + contentWindow.print()）：用 OS 打印引擎生成 PDF。
  // 不做落盘检测（OS 打印后台异步写盘，应用拿不到"写完"回调；警示已前置到确认框）。
  // afterprint（用户在系统框里点完打印/取消后触发）一回调即收尾；30s watchdog 兜底异常。
  async _exportViaSystemPrint(html, safeBaseName, escapedTitle, hideOverlay) {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:680px;height:600px;border:none;';
    iframe.srcdoc = html;
    document.body.appendChild(iframe);

    // 文件名来源：Chromium 打印 PDF 默认文件名取自【主窗口】(顶层 frame) title，
    // 而非 srcdoc 子 frame <title>。故 onload 临时覆盖主窗口 document.title 为 md 文件名，
    // 打印结束后还原（afterprint 或 watchdog 兜底）。同时显式写 contentDocument.title 兼容。
    const originalTitle = document.title;
    let titleRestored = false;
    const restoreTitle = () => {
      if (titleRestored) return;
      titleRestored = true;
      document.title = originalTitle;
    };

    // 两条清理路径（afterprint / 30s 兜底 watchdog）共用 cleanupIframe + cleaned 互斥标志，
    // 避免"iframe 已 remove 后再次读 contentWindow.removeEventListener"报 NPE。
    let cleaned = false;
    let finished = false;
    const cleanupIframe = () => {
      if (cleaned) return;
      cleaned = true;
      restoreTitle();
      if (iframe.contentWindow) {
        try { iframe.contentWindow.removeEventListener('afterprint', after); } catch (_) {}
      }
      if (iframe.parentNode) iframe.remove();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      cleanupIframe();
      hideOverlay();
    };
    const after = () => finish();
    // 30s 兜底：覆盖"用户在系统框里点取消 / afterprint 不触发"等异常路径，
    // 走完整收尾（清 iframe + 还原 title + 隐藏 overlay）。
    const watchdog = setTimeout(finish, 30000);

    iframe.onload = () => {
      if (iframe.contentDocument) iframe.contentDocument.title = escapedTitle;
      document.title = safeBaseName; // 主窗口 title 决定系统打印对话框默认文件名
      iframe.contentWindow.addEventListener('afterprint', after);
      iframe.contentWindow.print();
    };
  }

  getCachedImageURL(dataUri) {
    if (!dataUri || !dataUri.startsWith('data:')) return dataUri;
    const cached = this._imageURLCache.get(dataUri);
    if (cached) {
      // LRU 刷新：命中项移到队尾（Map 插入序），保证淘汰的是最久未用的
      this._imageURLCache.delete(dataUri);
      this._imageURLCache.set(dataUri, cached);
      return cached;
    }
    try {
      const comma = dataUri.indexOf(',');
      const meta = dataUri.slice(0, comma);
      const b64 = dataUri.slice(comma + 1);
      const mimeMatch = meta.match(/data:([^;]+)/);
      const mime = mimeMatch ? mimeMatch[1] : 'image/png';
      const bin = atob(b64);
      const len = bin.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      const url = URL.createObjectURL(blob);
      this._imageURLCache.set(dataUri, url);
      // 容量上限：超限 revoke 最旧 Blob URL，防止长会话多图内存持续增长（历史 bug：只增不减）
      if (this._imageURLCache.size > this._imageURLCacheMax) {
        const oldestKey = this._imageURLCache.keys().next().value;
        const oldestUrl = this._imageURLCache.get(oldestKey);
        this._imageURLCache.delete(oldestKey);
        if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
          URL.revokeObjectURL(oldestUrl);
        }
      }
      return url;
    } catch (e) {
      return dataUri;
    }
  }

  debounceUpdatePreview() {
    // 任务列表勾选来源：预览 DOM 已就地同步，跳过全量重渲染（不防抖，立即轻量刷新字数/大纲）
    if (this._suppressNextPreviewRerender) {
      this._suppressNextPreviewRerender = false;
      this.updateWordCount();
      this.updateOutline();
      return;
    }
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.updatePreview(true);
      this.updateWordCount();
      this.updateOutline();
    }, 300);
  }

  // 按空行切分为逻辑块，跟踪围栏代码块（内部不切分）
  parseBlocks(content) {
    const lines = content.split('\n');
    const blocks = [];
    let inFence = false;
    let fenceChar = '';
    let fenceCount = 0;
    let blockStart = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!inFence && (trimmed.startsWith('```') || trimmed.startsWith('~~~'))) {
        const fc = trimmed[0];
        const match = trimmed.match(new RegExp('^\\' + fc + '{3,}'));
        if (match) {
          inFence = true;
          fenceChar = fc;
          fenceCount = match[0].length;
          if (blockStart >= 0) {
            blocks.push({ startLine: blockStart, endLine: i - 1 });
            blockStart = -1;
          }
          blockStart = i;
          continue;
        }
      }

      if (inFence) {
        if (trimmed.startsWith(fenceChar)) {
          const match = trimmed.match(new RegExp('^\\' + fenceChar + '{' + fenceCount + ',}'));
          if (match && trimmed.replace(match[0], '').trim() === '') {
            blocks.push({ startLine: blockStart, endLine: i });
            blockStart = -1;
            inFence = false;
          }
        }
        continue;
      }

      if (trimmed === '') {
        if (blockStart >= 0) {
          blocks.push({ startLine: blockStart, endLine: i - 1 });
          blockStart = -1;
        }
      } else if (blockStart < 0) {
        blockStart = i;
      }
    }

    if (blockStart >= 0) {
      blocks.push({ startLine: blockStart, endLine: lines.length - 1 });
    }

    return blocks;
  }

  // 遍历预览 DOM，收集所有块级渲染元素（用于比例映射）
  collectBlockElements(root) {
    const blockTags = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'TABLE', 'UL', 'OL', 'BLOCKQUOTE', 'HR', 'DETAILS', 'DIV']);
    const result = [];
    const walk = (el) => {
      if (!el || !el.children) return;
      for (const child of el.children) {
        if (blockTags.has(child.tagName)) {
          result.push(child);
        } else if (child.tagName === 'IMG') {
          result.push(child);
        } else {
          walk(child);
        }
      }
    };
    walk(root);
    return result;
  }

  // 去掉 markdown 语法，提取用于匹配的纯文本关键词
  cleanMarkdownForSearch(text) {
    return text
      .replace(/^#{1,6}\s*/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^>\s*/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/\[(.+?)\]\(.+?\)/g, '$1')
      .replace(/!\[(.+?)\]\(.+?\)/g, '$1')
      .replace(/^\d+\.\s+/, '')
      .trim();
  }

  // 从预览元素获取对应的源文件行号（通过 unified 嵌入的 data-source-line）
  _getSourceLine(el) {
    if (el.dataset && el.dataset.sourceLine) {
      return parseInt(el.dataset.sourceLine, 10);
    }
    const inner = el.querySelector('[data-source-line]');
    if (inner) {
      return parseInt(inner.dataset.sourceLine, 10);
    }
    return null;
  }

  // 构建逐行密集位置映射（纯线性插值，无速度限制）
  // 每个编辑器行都有精确的 previewTop 插值
  // 无缓存：每次调用全量重建，与 legacy-master 行为一致（用户报告精准匹配）。
  // 3dac68c 引入的 dirty 缓存 + 布局指纹会造成某些场景下位置表过期（编辑器布局变化但
  // preview scrollHeight 未变时缓存命中 → 用旧表插值），此版本回退到 legacy 行为。
  _computedPosition() {
    const allElements = this.preview.querySelectorAll('[data-source-line]');
    const anchors = [];
    const seenLines = new Set();

    for (const el of allElements) {
      // 跳过脚注区域内的元素（source line 在文档中部但渲染在预览最底部）
      if (el.closest('.footnotes')) continue;

      const sourceLine = parseInt(el.dataset.sourceLine, 10);
      if (isNaN(sourceLine)) continue;
      if (seenLines.has(sourceLine)) continue;
      seenLines.add(sourceLine);

      const editorTop = this.cm.heightAtLine(Math.max(0, sourceLine - 1), 'local');
      const previewTop = this._getOffsetTop(el);
      if (typeof editorTop !== 'number' || typeof previewTop !== 'number') continue;

      anchors.push({ line: sourceLine, editorTop, previewTop });
    }

    if (anchors.length < 2) {
      this._editorElementList = null;
      this._previewElementList = null;
      return;
    }

    anchors.sort((a, b) => a.line - b.line);

    // 过滤非单调锚点（只检查 editorTop）
    const clean = [anchors[0]];
    for (let i = 1; i < anchors.length; i++) {
      if (anchors[i].editorTop > clean[clean.length - 1].editorTop) {
        clean.push(anchors[i]);
      }
    }

    if (clean.length < 2) {
      this._editorElementList = null;
      this._previewElementList = null;
      return;
    }

    // 逐行构建密集数组
    const totalLines = this.cm.lineCount();
    const editorList = new Array(totalLines);
    const rawPreviewList = new Array(totalLines);
    let anchorIdx = 0;

    for (let line = 0; line < totalLines; line++) {
      editorList[line] = this.cm.heightAtLine(line, 'local');
      const sourceLine = line + 1;

      while (anchorIdx + 1 < clean.length && clean[anchorIdx + 1].line <= sourceLine) {
        anchorIdx++;
      }

      if (anchorIdx >= clean.length - 1) {
        const last = clean[clean.length - 1];
        rawPreviewList[line] = last.previewTop + Math.max(0, sourceLine - last.line) * 20;
      } else {
        const a1 = clean[anchorIdx];
        const a2 = clean[anchorIdx + 1];
        const lineGap = a2.line - a1.line;
        if (lineGap <= 0) {
          rawPreviewList[line] = a1.previewTop;
        } else {
          rawPreviewList[line] = a1.previewTop + (sourceLine - a1.line) / lineGap * (a2.previewTop - a1.previewTop);
        }
      }
    }

    this._editorElementList = editorList;
    this._previewElementList = rawPreviewList;
  }

  // 返回预览视口顶部对应的源码行号（1-based）；测量失败返回 null。
  // 用于切换模式时把「预览像素位置」转成宽度无关的行锚点。
  _lineAtPreviewTop(pvTop) {
    this._computedPosition();
    const list = this._previewElementList;
    if (!list || list.length < 2) return null;
    // 二分找 previewList 中 <= pvTop 的最大行索引
    let lo = 0, hi = list.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] <= pvTop) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans + 1; // 1-based 源码行
  }

  // 根据 unified 渲染结果重建滚动同步数据（仅在内容变化时调用）
  rebuildScrollSync() {
    const content = this.cm.getValue();
    const totalLines = content.split('\n').length;

    // 构建平行位置数组（使用 data-source-line）
    this._computedPosition();

    // 生成 _linePositions（兼容 updatePreview 滚动恢复）
    const allElements = Array.from(this.preview.querySelectorAll('[data-source-line]'));
    const previewRect = this.preview.getBoundingClientRect();
    const st = this.preview.scrollTop;
    const sh = this.preview.scrollHeight || 1;
    const positions = [{ line: 0, fraction: 0 }];
    const seen = new Set();

    // 超大预览：元素过多时只采样测量，未测行靠行号线性插值，避免全量 getBoundingClientRect 重排卡顿
    const MAX_SYNC_SAMPLES = 2000;
    const step = Math.max(1, Math.ceil(allElements.length / MAX_SYNC_SAMPLES));

    for (let i = 0; i < allElements.length; i++) {
      if (step > 1 && i % step !== 0 && i !== allElements.length - 1) continue;
      const child = allElements[i];
      const sourceLine = parseInt(child.dataset.sourceLine, 10);
      if (isNaN(sourceLine)) continue;
      if (seen.has(sourceLine)) continue;
      seen.add(sourceLine);

      const rect = child.getBoundingClientRect();
      const elTop = rect.top - previewRect.top + st;
      const elBottom = elTop + child.offsetHeight;

      positions.push({ line: sourceLine, fraction: Math.min(Math.max(elTop / sh, 0), 1) });
      positions.push({ line: sourceLine + 1, fraction: Math.min(Math.max(elBottom / sh, 0), 1) });
    }

    positions.push({ line: totalLines - 1, fraction: 1 });
    positions.sort((a, b) => a.line - b.line);

    const deduped = [];
    let lastLine = -1;
    for (const p of positions) {
      if (p.line !== lastLine) {
        deduped.push(p);
        lastLine = p.line;
      }
    }
    if (deduped.length === 0 || deduped[0].line > 0) deduped.unshift({ line: 0, fraction: 0 });
    if (deduped[deduped.length - 1].line < totalLines - 1) deduped.push({ line: totalLines - 1, fraction: 1 });
    this._linePositions = deduped;
  }

  // demo 的 getHeightToTop：计算元素到容器顶部的距离（offsetTop 遍历 offsetParent）
  _getOffsetTop(el) {
    let top = el.offsetTop;
    let parent = el.offsetParent;
    while (parent && parent !== this.preview) {
      top += parent.offsetTop;
      parent = parent.offsetParent;
    }
    return top;
  }

  // demo 风格：节流函数（首次立即执行，后续在 delay 内只保存最后一次调用）
  _throttleScroll(fn, delay) {
    if (this._scrollThrottleTimer) {
      this._scrollThrottlePending = fn;
      return;
    }
    fn();
    this._scrollThrottleTimer = setTimeout(() => {
      this._scrollThrottleTimer = null;
      if (this._scrollThrottlePending) {
        const pending = this._scrollThrottlePending;
        this._scrollThrottlePending = null;
        this._throttleScroll(pending, delay);
      }
    }, delay);
  }

  // demo 风格：防抖函数（每次调用重置计时器）
  _debounceScroll(fn, delay) {
    clearTimeout(this._scrollDebounceTimer);
    this._scrollDebounceTimer = setTimeout(fn, delay);
  }

  // demo 风格：恢复滚动（重置双标志锁）
  _resumeScroll() {
    this._canScroll.editor = true;
    this._canScroll.preview = true;
  }

  // 编辑器 → 预览同步（逐行密集插值）
  _syncEditorToPreview(editorTop) {
    if (this.previewWindow) { this._syncEditorToPreviewWindow(); return; }
    this._computedPosition();

    const editorList = this._editorElementList;
    const previewList = this._previewElementList;
    if (!editorList || editorList.length < 2) return;

    const { scrollHeight, clientHeight } = this.preview;
    const cmInfo = this.cm.getScrollInfo();
    const top = (editorTop != null) ? editorTop : cmInfo.top;

    if (top <= 0.5) { this.preview.scrollTop = 0; return; }
    if (top + clientHeight >= cmInfo.height - 0.5) {
      this.preview.scrollTop = Math.max(0, scrollHeight - clientHeight);
      return;
    }

    let lo = 0, hi = editorList.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (editorList[mid] <= top) lo = mid + 1;
      else hi = mid;
    }
    let idx = lo - 1;
    if (idx < 0) { this.preview.scrollTop = 0; return; }
    if (idx >= editorList.length - 1) {
      this.preview.scrollTop = Math.max(0, scrollHeight - clientHeight);
      return;
    }

    const editorStart = editorList[idx];
    const editorEnd = editorList[idx + 1];
    const previewStart = previewList[idx];
    const previewEnd = previewList[idx + 1];

    if (editorEnd <= editorStart || previewEnd < 0 || previewStart < 0) {
      this.preview.scrollTop = previewStart;
      return;
    }

    const targetScrollTop = previewStart + (top - editorStart) / (editorEnd - editorStart) * (previewEnd - previewStart);
    this.preview.scrollTop = Math.max(0, Math.min(targetScrollTop, scrollHeight - clientHeight));
  }

  // 预览 → 编辑器同步（逐行密集插值）
  // previewTop 可选：指定预览滚动位置作为来源；省略则读当前预览 scrollTop。
  // 切换模式时用它传入「已保存的预览位置」，避免依赖此刻可能不可靠的实时值。
  _syncPreviewToEditor(previewTop) {
    if (this.previewWindow) { this._syncPreviewToEditorWindow(); return; }
    this._computedPosition();

    const previewList = this._previewElementList;
    const editorList = this._editorElementList;
    if (!previewList || previewList.length < 2) return;

    const { scrollHeight, clientHeight } = this.preview;
    const cmInfo = this.cm.getScrollInfo();
    const pvTop = (previewTop != null) ? previewTop : this.preview.scrollTop;

    if (pvTop <= 0.5) { this.cm.scrollTo(0, 0); return; }
    if (pvTop + clientHeight >= scrollHeight - 0.5) {
      this.cm.scrollTo(0, Math.max(0, cmInfo.height - cmInfo.clientHeight));
      return;
    }

    let lo = 0, hi = previewList.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (previewList[mid] <= pvTop) lo = mid + 1;
      else hi = mid;
    }
    let idx = lo - 1;
    if (idx < 0) { this.cm.scrollTo(0, 0); return; }
    if (idx >= previewList.length - 1) {
      this.cm.scrollTo(0, Math.max(0, cmInfo.height - cmInfo.clientHeight));
      return;
    }

    const previewStart = previewList[idx];
    const previewEnd = previewList[idx + 1];
    const editorStart = editorList[idx];
    const editorEnd = editorList[idx + 1];

    if (previewEnd <= previewStart || editorEnd < 0 || editorStart < 0) {
      this.cm.scrollTo(0, editorStart);
      return;
    }

    const targetEditorTop = editorStart + (pvTop - previewStart) / (previewEnd - previewStart) * (editorEnd - editorStart);
    this.cm.scrollTo(0, targetEditorTop);
  }

  // 滑动窗口模式：编辑器滚动 → 预览
  // 焦点（编辑区视口顶部对应行）落在窗口内则直接定位预览；否则以焦点重新渲染窗口
  _syncEditorToPreviewWindow() {
    const win = this.previewWindow;
    if (!win) return;
    const cmInfo = this.cm.getScrollInfo();
    const focus = this.cm.lineAtHeight(cmInfo.top, 'local'); // 0-based
    if (focus < win.start + 8 || focus > win.end - 8) {
      this._previewFocusLine = Math.max(0, Math.min(focus, this.cm.lineCount() - 1));
      this.debounceUpdatePreview();
      return;
    }
    this._focusPreviewToLine(focus);
  }

  // 滑动窗口模式：预览滚动 → 编辑器
  // 预览仅含窗口片段，按当前预览滚动位置反查窗口内对应源码行，回滚编辑器
  _syncPreviewToEditorWindow() {
    if (!this._windowLineTops || !this._windowLineTops.length) return;
    const st = this.preview.scrollTop;
    let bestLine = this.previewWindow.start;
    let bestTop = -Infinity;
    for (const [ln, top] of this._windowLineTops) {
      if (top <= st + 1 && top > bestTop) { bestLine = ln - 1; bestTop = top; }
    }
    const targetTop = this.cm.heightAtLine(bestLine, 'local');
    if (this.activeTab) this.activeTab.scrollPos = { top: targetTop, left: 0 };
    this.cm.scrollTo(0, targetTop);
  }

  // 按 markdown 块级元素边界分割源码，与 pulldown-cmark 渲染输出对齐
  // 注意：此方法保留用于兼容旧的 _blocks 数组引用
  _splitMarkdownBlocks(lines) {
    const blocks = [];
    let i = 0;

    while (i < lines.length) {
      while (i < lines.length && lines[i].trim() === '') i++;
      if (i >= lines.length) break;

      const startLine = i;
      const line = lines[i].trim();

      // 代码围栏：作为一个整体 block
      if (line.startsWith('```') || line.startsWith('~~~')) {
        const fence = line.match(/^(`{3,}|~{3,})/)[0];
        i++;
        while (i < lines.length) {
          if (lines[i].trim().startsWith(fence)) break;
          i++;
        }
        if (i < lines.length) i++;
        blocks.push({ startLine, endLine: i - 1 });
        continue;
      }

      // 标题：始终是单行 block（demo 中每个 # 行 = 一个预览元素）
      if (/^#{1,6}\s/.test(line)) {
        blocks.push({ startLine, endLine: i });
        i++;
        continue;
      }

      // 水平分割线：单行 block
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        blocks.push({ startLine, endLine: i });
        i++;
        continue;
      }

      // 表格：连续的 | 行
      if (line.startsWith('|')) {
        while (i < lines.length && lines[i].trim().startsWith('|')) i++;
        blocks.push({ startLine, endLine: i - 1 });
        continue;
      }

      // 段落/列表/引用：消费连续非空行，遇到标题/围栏/分割线/表格时停止
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        const t = lines[i].trim();
        if (/^#{1,6}\s/.test(t) ||
            t.startsWith('```') || t.startsWith('~~~') ||
            /^(-{3,}|\*{3,}|_{3,})\s*$/.test(t) ||
            t.startsWith('|')) {
          break;
        }
        i++;
      }
      blocks.push({ startLine, endLine: i - 1 });
    }

    return blocks;
  }

  // 获取预览 DOM 的直系 block 级子元素（与 blocks 顺序一一对应）
  _getPreviewBlockElements() {
    const tags = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'TABLE', 'UL', 'OL', 'BLOCKQUOTE', 'HR', 'DETAILS', 'DIV', 'DL', 'FIGURE', 'IMG']);
    return Array.from(this.preview.children).filter(el => tags.has(el.tagName));
  }

  // 像素比例兜底：在文档中均匀取样 20 个点
  _fallbackPositionMap(totalLines) {
    const positions = [{ line: 0, fraction: 0 }];
    const step = Math.max(1, Math.floor(totalLines / 20));
    for (let l = step; l < totalLines - 1; l += step) {
      positions.push({ line: l, fraction: l / totalLines });
    }
    positions.push({ line: totalLines - 1, fraction: 1 });
    return positions;
  }

  // 超大文档预览保护：返回前 maxLines 行内容。
  // 若在代码围栏内被截断，向后补足到下一个围栏，避免后续整段被当作代码块。
  _headForPreview(content, maxLines) {
    const lines = content.split('\n');
    if (lines.length <= maxLines) return content;
    let head = lines.slice(0, maxLines).join('\n');
    const fences = (head.match(/^\s*```/gm) || []).length;
    if (fences % 2 === 1) {
      const rest = lines.slice(maxLines).join('\n');
      const idx = rest.indexOf('```');
      if (idx >= 0) head += '\n' + rest.slice(0, idx + 3);
    }
    return head;
  }

  // P2-1 Strangler（ADR-3）：以下 5 个虚拟窗口方法逻辑已迁至 PreviewController，
  // 当前保留薄委托，待全部调用点迁移后删除。
  _buildWindowLineTops() {
    return this.previewController._buildWindowLineTops();
  }
  _focusPreviewToLine(line) {
    return this.previewController._focusPreviewToLine(line);
  }
  _renderPreviewWindowBlock(finalHtml, win, content) {
    return this.previewController._renderPreviewWindowBlock(finalHtml, win, content);
  }
  _updateVirtualScrollMetrics() {
    return this.previewController._updateVirtualScrollMetrics();
  }
  _syncPreviewVirtualScroll() {
    return this.previewController._syncPreviewVirtualScroll();
  }

    async updatePreview(suppressLoading = false) {
      // P2-1 Strangler（ADR-3）：编排逻辑已迁至 PreviewController.render()，此处保留薄委托。
      return this.previewController.render(suppressLoading);
    }

  // P1-1：逻辑已抽到 src/modules/image-processor.js（纯函数 + 依赖注入）。
  // 这里只做 DI 适配：把实例字段/方法包成注入项，错误仍上交调用方（6772 处的 try/catch）。
  async processImages() {
    return ImageProcessor.processImages(this.preview, {
      activeTab: this.activeTab,
      imageCache: this._imageBase64Cache,
      tauri: TauriApi,
      getCachedImageURL: (dataUri) => this.getCachedImageURL(dataUri),
      getRenderGeneration: () => this._renderGeneration,
    });
  }

  processFootnotes() {
    this.preview.querySelectorAll('.footnote-ref a').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const href = link.getAttribute('href');
        if (!href) return;
        const target = this.preview.querySelector(href);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('footnote-flash');
          setTimeout(() => target.classList.remove('footnote-flash'), 1500);
        }
      });
    });

    this.preview.querySelectorAll('.footnote-backref').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const href = link.getAttribute('href');
        if (!href) return;
        const target = this.preview.querySelector(href);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('footnote-flash');
          setTimeout(() => target.classList.remove('footnote-flash'), 1500);
        }
      });
    });
  }

  // 后端健康探测（dev 模式"僵尸界面"可见化修复）：启动时 + 每 30s 心跳 ping 一次。
  // 背景：dev 模式下前端页面与 Rust 后端 / Node dev-server 生命周期完全解耦（tauri-api 延迟
  // 求值 + 全降级是防白屏的刻意设计），后端挂掉时页面仍正常显示且无任何提示——用户无法区分
  // 「应用正常」与「后端已死」。这里复用最轻的已有命令 get_cli_args 做心跳，不新增 IPC、
  // 不改 invoke 透传语义（N21 硬约束不受影响）。失败 → 顶部红条；恢复成功 → 自动隐藏。
  initBackendHealth() {
    this._probeBackendHealth();
    this._backendHealthTimer = setInterval(() => this._probeBackendHealth(), 30000);
  }

  async _probeBackendHealth() {
    let down = false;
    try {
      if (!TauriApi.isAvailable()) throw new Error('not in tauri runtime');
      await TauriApi.getCliArgs();
    } catch (_) {
      down = true;
    }
    this._setBackendBanner(down);
  }

  _setBackendBanner(down) {
    const banner = document.getElementById('backend-banner');
    if (!banner) return;
    // 复用兜底报错条样式 .fatal-error-bar（fixed 底部红条），只切 hidden
    banner.classList.toggle('hidden', !down);
    if (down) {
      const txt = document.getElementById('backend-banner-text');
      if (txt) txt.textContent = this.t('backendDown');
    }
  }

  showToast(text, type = 'danger', opts = {}) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast ' + type;

    const iconSvg = type === 'danger'
      ? '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'
      : type === 'warning'
        ? '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'
        : type === 'info'
          ? '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'
          : '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>';
    const iconSpan = document.createElement('span');
    iconSpan.className = 'toast-icon';
    iconSpan.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + iconSvg + '</svg>';

    const body = document.createElement('div');
    body.className = 'toast-body';
    if (typeof text === 'object' && text !== null) {
      const titleEl = document.createElement('div');
      titleEl.className = 'toast-title';
      titleEl.textContent = text.title || '';
      body.appendChild(titleEl);
      if (text.detail) {
        const detailEl = document.createElement('div');
        detailEl.className = 'toast-detail';
        detailEl.textContent = text.detail;
        body.appendChild(detailEl);
      }
      if (text.code) {
        const codeEl = document.createElement('div');
        codeEl.className = 'toast-code';
        codeEl.textContent = this.t('errorCodePrefix', { code: text.code });
        body.appendChild(codeEl);
      }
    } else {
      body.textContent = text;
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', this.t('close') || 'Close');
    closeBtn.textContent = this.t('close') || 'Close';

    let timer = null;
    const dismiss = () => {
      if (timer) clearTimeout(timer);
      if (!el.parentNode) return;
      el.style.transition = 'opacity 0.25s, transform 0.25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-12px) scale(0.98)';
      setTimeout(() => el.remove(), 250);
    };
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });

    el.appendChild(iconSpan);
    el.appendChild(body);
    el.appendChild(closeBtn);
    container.appendChild(el);

    const duration = opts.duration || (type === 'danger' ? 5000 : type === 'warning' ? 4000 : 3000);
    timer = setTimeout(dismiss, duration);
  }

  // 统一错误上报：用户友好提示 + 开发可诊断（错误码 + 上下文写入 console）
  reportError(code, opts = {}) {
    const lang = this.settings && this.settings.language === 'en' ? 'en' : 'zh';
    const dict = ERROR_MESSAGES[code] || {};
    const entry = dict[lang] || dict.zh || { title: code, detail: '' };
    let detail = opts.detail || entry.detail || '';
    if (detail && opts.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        detail = detail.replace('{' + k + '}', v == null ? '' : v);
      }
    }
    const title = opts.title || entry.title || code;
    const context = opts.context || {};
    // 开发可诊断：错误码 + 上下文 + 完整堆栈写入 console（用户不可见，但开发可查）
    console.error('[TizuMark]', code, JSON.stringify(context), opts.error && (opts.error.stack || opts.error));
    if (opts.toast === false) {
      this.setStatus(title + (detail ? '：' + detail : ''));
    } else {
      this.showToast({ title, detail, code }, opts.type || 'danger', { duration: opts.duration });
    }
  }

  // 解析 Rust read_file 的结构化错误 JSON，返回带 .code 的 Error 供上层 reportError 使用
  _mapReadFileError(e, path) {
    let kind = 'Io';
    try {
      const raw = typeof e === 'string' ? e : (e && e.message ? e.message : null);
      const obj = raw ? JSON.parse(raw) : null;
      if (obj && obj.kind) kind = obj.kind;
    } catch (_) { /* 非结构化错误，按 Io 处理 */ }
    const codeMap = {
      NotFound: 'E_NOT_FOUND',
      PermissionDenied: 'E_PERMISSION',
      Locked: 'E_LOCKED',
      PathTooLong: 'E_PATH_TOO_LONG',
      InvalidEncoding: 'E_ENCODING',
      Io: 'E_IO',
    };
    const code = codeMap[kind] || 'E_IO';
    const name = path ? path.split(/[/\\]/).pop() : '';
    const err = new Error('读取文件失败: ' + kind);
    err.code = code;
    err.path = path;
    err.params = { name };
    return err;
  }

  // ====== 外部文件变更检测 ======
  async refreshFileMeta(tab) {
    if (!tab) return;
    if (!tab.filePath) { tab.fileMeta = null; return; }
    try {
      tab.fileMeta = await TauriApi.fileMeta({ path: tab.filePath });
    } catch (e) {
      tab.fileMeta = null;
    }
  }

  async reloadTabFromDisk(tab) {
    if (!tab || !tab.filePath) return;
    try {
      const content = await this.readFileNormalized(tab.filePath);
      tab.content = content;
      tab.savedContent = content;
      await this.refreshFileMeta(tab);
      tab.pendingExternalChange = false;
      if (tab === this.activeTab) {
        this.cm.setValue(content);
        this.updatePreview();
        this.updateOutline();
        this.updateWordCount();
      }
      this.updateTabDisplay();
    } catch (e) {
      this.reportError(e.code || 'E_IO', { context: { path: tab.filePath }, error: e, params: e.params, detail: e.detail });
    }
  }

  enqueueExternalChange(tab) {
    if (!tab || !tab.filePath) return;
    if (this._externalQueue.includes(tab)) return;
    tab.pendingExternalChange = true;
    this._externalQueue.push(tab);
    this.updateTabDisplay();
    this.updateExternalChangeBanner();
  }

  // 提示条始终反映当前激活标签页的外部变更
  updateExternalChangeBanner() {
    const tab = this.activeTab;
    if (tab && tab.pendingExternalChange) {
      this.renderExternalChangeBanner(tab);
    } else {
      this.hideExternalChangeBanner();
    }
  }

  async dismissExternalChange(tab, reload) {
    const idx = this._externalQueue.indexOf(tab);
    if (idx !== -1) this._externalQueue.splice(idx, 1);
    if (reload) {
      await this.reloadTabFromDisk(tab);
    } else {
      await this.refreshFileMeta(tab);
      tab.pendingExternalChange = false;
    }
    this.updateTabDisplay();
    this.updateExternalChangeBanner();
  }

  async reloadAllExternalChanges() {
    const queue = this._externalQueue.slice();
    for (const tab of queue) {
      await this.reloadTabFromDisk(tab);
      const i = this._externalQueue.indexOf(tab);
      if (i !== -1) this._externalQueue.splice(i, 1);
    }
    this.updateTabDisplay();
    this.updateExternalChangeBanner();
  }

  ignoreAllExternalChanges() {
    this._externalQueue.slice().forEach(t => {
      t.pendingExternalChange = false;
      this.refreshFileMeta(t);
    });
    this._externalQueue = [];
    this.updateTabDisplay();
    this.updateExternalChangeBanner();
  }

  renderExternalChangeBanner(tab) {
    const banner = document.getElementById('external-change-banner');
    if (!banner) return;
    const dirty = tab.isModified;
    banner.querySelector('.ecb-name').textContent = tab.name || tab.filePath || '';
    banner.querySelector('.ecb-msg').textContent = dirty ? this.t('externalChangedDirty') : this.t('externalChanged');
    banner.querySelector('.ecb-reload').textContent = this.t('ecbReload');
    banner.querySelector('.ecb-ignore').textContent = this.t('ecbIgnore');
    banner.querySelector('.ecb-reload-all').textContent = this.t('ecbReloadAll');
    banner.querySelector('.ecb-ignore-all').textContent = this.t('ecbIgnoreAll');
    banner.dataset.tabIndex = this.activeTabIndex;
    banner.classList.add('visible');
    this._externalBannerVisible = true;
  }

  hideExternalChangeBanner() {
    const banner = document.getElementById('external-change-banner');
    if (banner) banner.classList.remove('visible');
    this._externalBannerVisible = false;
  }

  initFileWatcher() {
    if (this._fileWatcherStarted) return;
    this._fileWatcherStarted = true;
    this._externalQueue = [];
    this._externalBannerVisible = false;
    this._watching = false;

    const banner = document.getElementById('external-change-banner');
    if (banner) {
      banner.querySelector('.ecb-reload').addEventListener('click', () => {
        const i = parseInt(banner.dataset.tabIndex, 10);
        const tab = this.tabs[i];
        if (tab) this.dismissExternalChange(tab, true);
      });
      banner.querySelector('.ecb-ignore').addEventListener('click', () => {
        const i = parseInt(banner.dataset.tabIndex, 10);
        const tab = this.tabs[i];
        if (tab) this.dismissExternalChange(tab, false);
      });
      banner.querySelector('.ecb-reload-all').addEventListener('click', () => this.reloadAllExternalChanges());
      banner.querySelector('.ecb-ignore-all').addEventListener('click', () => this.ignoreAllExternalChanges());
    }

    const pass = async () => {
      for (const tab of this.tabs) {
        if (!tab.filePath) continue;
        let meta;
        try { meta = await TauriApi.fileMeta({ path: tab.filePath }); }
        catch (e) { meta = undefined; }
        if (meta === undefined) continue;
        if (!meta) {
          if (tab.fileMeta !== null && !tab.pendingExternalChange) this.enqueueExternalChange(tab);
          continue;
        }
        if (!tab.fileMeta) { tab.fileMeta = meta; continue; }
        if (meta.mtime !== tab.fileMeta.mtime || meta.size !== tab.fileMeta.size) {
          let disk = null;
          try { disk = await this.readFileNormalized(tab.filePath); } catch (e) { disk = null; }
          // 磁盘内容换行已归一化为 LF，savedContent 同为 LF，统一比较，避免 CRLF/CR 文件每次轮询误报"外部已修改"
          if (disk !== null && disk !== tab.savedContent) this.enqueueExternalChange(tab);
          else tab.fileMeta = meta;
        }
      }
    };

    setInterval(async () => {
      if (this._watching) return;
      this._watching = true;
      try { await pass(); } catch (e) { /* ignore */ } finally { this._watching = false; }
    }, 1500);

    window.addEventListener('focus', () => {
      if (this._watching) return;
      this._watching = true;
      pass().catch(() => {}).finally(() => { this._watching = false; });
    });
  }

  setStatus(text) {
    this.statusText.textContent = text;
    setTimeout(() => {
      if (this.statusText.textContent === text) {
        this.statusText.textContent = this.t('ready');
      }
    }, 3000);
  }

  updateWordCount() {
    const { words, chars, lines } = WordCount.countStats(this.cm.getValue());
    this.wordCountEl.textContent = `${this.t('words')}: ${words}`;
    this.charCountEl.textContent = `${this.t('chars')}: ${chars}`;
    this.lineCountEl.textContent = `${this.t('lines')}: ${lines}`;
  }

  async toggleTheme() {
    // 复用启动 loading（logo + 进度条 + 文字）作全局遮罩。平滑策略：
    //  1) 先把遮罩背景/文字固定为【切换前】主题色（inline style）——切换瞬间 var(--bg-primary)
    //     跳变不会让遮罩"啪"地变色，且遮罩初始色与页面一致，出现时无缝；
    //  2) 双 rAF：第一帧绘制遮罩，第二帧才改主题（单 rAF 回调在绘制前执行会与遮罩同帧）；
    //  3) 完成后的隐藏用 opacity 淡出（合成器属性，不占主线程，mermaid 渲染期间也流畅，
    //     不用 background-color 渐变——那是主线程 repaint，会被渲染阻塞导致跳帧卡顿）。
    const overlay = document.getElementById('loading-overlay');
    const cs = getComputedStyle(document.documentElement);
    overlay.style.backgroundColor = cs.getPropertyValue('--bg-primary').trim() || '#f5f5f5';
    const textEl = document.getElementById('loading-text');
    if (textEl) textEl.style.color = cs.getPropertyValue('--text-secondary').trim();
    overlay.classList.remove('hidden');
    overlay.offsetHeight; // 强制重排，确保下一帧一定绘制遮罩
    const showTime = Date.now();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      if (this.settings.themeMode !== 'light' && this.settings.themeMode !== 'dark') {
        this.settings.themeMode = this.isDark ? 'light' : 'dark';
        if (this._selects && this._selects.themeMode) this._selects.themeMode.setValue(this.settings.themeMode, true);
      }
      this.isDark = !this.isDark;
      this.settings.themeMode = this.isDark ? 'dark' : 'light';
      if (this._selects && this._selects.themeMode) this._selects.themeMode.setValue(this.settings.themeMode, true);
      this.saveSettings();
      document.documentElement.setAttribute('data-theme', this.isDark ? 'dark' : 'light');
      document.documentElement.setAttribute('data-color-scheme', this.settings.colorScheme || 'default');
      this.cm.setOption('theme', this.isDark ? 'material-darker' : 'default');
      this.updateThemeIcon();

      const highlightTheme = document.getElementById('highlight-theme');
      if (highlightTheme) {
        highlightTheme.href = this.isDark
          ? 'lib/highlight.js/github-dark.min.css'
          : 'lib/highlight.js/github.min.css';
      }

      await this.rerenderMermaid();
    } finally {
      // 最小显示时长：图表少/切换很快时遮罩也不一闪而过，保证用户能看清 loading 界面
      const MIN_SHOW_MS = 300;
      const elapsed = Date.now() - showTime;
      if (elapsed < MIN_SHOW_MS) {
        await new Promise((r) => setTimeout(r, MIN_SHOW_MS - elapsed));
      }
      // 清除固定色 → opacity 淡出（0.3s，合成器流畅）→ 隐藏。淡出时页面已是新主题，
      // 旧色遮罩渐渐透明、新主题页面透出，自然交叉过渡
      overlay.style.backgroundColor = '';
      if (textEl) textEl.style.color = '';
      overlay.style.opacity = '0';
      await new Promise((r) => setTimeout(r, 320));
      overlay.style.opacity = '';
      overlay.classList.add('hidden');
    }
    this.setStatus(this.t('themeSwitched', { theme: this.isDark ? this.t('themeDark') : this.t('themeLight') }));
  }

  updateThemeIcon() {
    const svg = document.getElementById('theme-icon');
    const text = document.getElementById('theme-text');
    if (!svg) return;
    if (this.isDark) {
      svg.innerHTML = '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>';
      if (text) text.textContent = this.t('themeDark');
    } else {
      svg.innerHTML = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>';
      if (text) text.textContent = this.t('themeLight');
    }
  }

  loadTheme() {
    this.applyThemeMode();
    
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.settings.themeMode === 'system') {
        this.applyThemeMode();
      }
    });
  }

  // 视图模式跟随当前标签页类型，与「打开文件」逻辑完全一致：
  // 图片 → 预览（单栏）；非 Markdown 明文 → 编辑（无预览栏）；
  // 有路径的 Markdown → 跟随设置中的默认视图；未命名（无路径）Markdown → 编辑（当新建文档）。
  // 类型以文件后缀为准（window.FileTypes.classifyFile），避免 tab.kind 因会话恢复等残留旧值。
  // 覆盖「打开文件 / 切换标签 / 当前标签」所有情况。
  syncViewModeToTab() {
    const tab = this.activeTab;
    // 未命名（无路径）不按类型切换，保留当前视图：newFile 已显式 setViewMode('edit')，
    // 初始化则继承 settings.defaultView。与改动前行为一致。
    if (!tab || !tab.filePath) return;
    let kind = window.FileTypes.classifyFile(tab.filePath);
    let target = 'preview';
    if (kind === 'image') target = 'preview';
    else if (kind === 'text') target = 'edit';
    else target = this._sessionMdViewMode || this.settings.defaultView || 'preview'; // md：会话记忆优先，其次默认视图
    // 视图布局由「模式 + 类型」共同决定：即使模式没变（如 md 编辑 → 文本编辑），
    // 类型变了也需重新 applyViewMode（重新决定 preview-collapsed 等），否则预览栏不会收起。
    if (target !== this.viewMode || this._lastViewKind !== kind) {
      this.viewMode = target;
      this._lastViewKind = kind;
      this.applyViewMode();
    } else {
      this._lastViewKind = kind;
    }
  }

  setViewMode(mode) {
    // 图片只支持预览模式、非 Markdown 明文只支持编辑模式：拦截切换到不支持的视图
    // 类型以文件后缀为准（window.FileTypes.classifyFile），避免 tab.kind 因会话恢复等残留旧值
    const _tab = this.activeTab;
    let _kind = _tab ? _tab.kind : 'markdown';
    if (_tab && _tab.filePath && window.FileTypes && window.FileTypes.classifyFile) {
      _kind = window.FileTypes.classifyFile(_tab.filePath);
    }
    if (_kind === 'image' && mode !== 'preview') { this.showToast(this.t('editUnsupported'), 'warning'); return; }
    if (_kind === 'text' && mode !== 'edit') { this.showToast(this.t('previewUnsupported'), 'warning'); return; }
    if (this.viewMode === mode) return;
    
    if (mode === 'preview') {
      document.getElementById('find-panel').classList.add('hidden');
    } else {
      document.getElementById('preview-find-panel').classList.add('hidden');
      this.clearPreviewHighlight();
    }

    // 切换前保存滚动位置 + 行锚点。
    // 关键：像素位置（scrollPos / previewScrollTop）与宽度绑定——纯预览 100% 宽与分屏 50% 宽
    // 下同一像素对应不同段落。切换会让预览重排，跨宽度用旧像素定位必然错位。
    // 因此额外算出「视口顶部对应的源码行号」作为宽度无关的锚点，切换后按该行在新宽度下定位。
    this._pendingSwitchAnchorLine = null;
    const swTab = this.activeTab;
    if (swTab) {
      // 预览在分屏/纯预览两种模式都可见，始终记录其像素位置（锚点失效时回退用）
      if (this.preview) swTab.previewScrollTop = this.preview.scrollTop;
      if (this.cm && this.viewMode === 'edit') {
        // 离开编辑（分屏）：编辑器可见，存像素 + 视口顶部源码行
        const si = this.cm.getScrollInfo();
        swTab.scrollPos = { top: si.top, left: si.left };
        try { this._pendingSwitchAnchorLine = this.cm.lineAtHeight(si.top, 'local') + 1; } catch (_) {}
      } else if (this.preview && this.viewMode === 'preview') {
        // 离开纯预览（100% 宽）：预览可见，存视口顶部源码行
        this._pendingSwitchAnchorLine = this._lineAtPreviewTop(this.preview.scrollTop);
      }
    }

    this.viewMode = mode;
    // 会话级 md 模式记忆：仅当当前 tab 有 filePath 且为 markdown 时记录，
    // 无路径的新建文档（kind 兜底 markdown）不记录；图片/txt 不触碰记忆，
    // 这样「其他格式按特殊展示 → 再切回 md」仍沿用之前的 md 记忆。
    if (_tab && _tab.filePath && _kind === 'markdown') {
      this._sessionMdViewMode = mode;
    }
    this.applyViewMode();
  }

  toggleViewMode() {
    this.setViewMode(this.viewMode === 'preview' ? 'edit' : 'preview');
  }

  applyViewMode() {
    const container = document.querySelector('.editor-container');
    const editorPane = document.getElementById('editor-pane');
    const previewPane = document.getElementById('preview-pane');
    const btnPreview = document.getElementById('btn-view-preview');
    const btnEdit = document.getElementById('btn-view-edit');
    const sideLeft = document.getElementById('btn-side-left');
    const sideRight = document.getElementById('btn-side-right');

    editorPane.style.flex = '';
    editorPane.style.width = '';
    previewPane.style.flex = '';
    previewPane.style.width = '';

    container.classList.remove('preview-mode', 'editor-collapsed', 'preview-collapsed', 'text-only');
    if (this.viewMode === 'preview') {
      container.classList.add('preview-mode');
    }

    btnPreview.classList.toggle('active', this.viewMode === 'preview');
    btnEdit.classList.toggle('active', this.viewMode === 'edit');

    let activeTabKind = this.activeTab ? this.activeTab.kind : 'markdown';
    if (this.activeTab && this.activeTab.filePath && window.FileTypes && window.FileTypes.classifyFile) {
      activeTabKind = window.FileTypes.classifyFile(this.activeTab.filePath);
    }

    // 图片只支持预览、非 md 明文只支持编辑：两个模式按钮都保留可见；
    // 切到不支持的模式时由 setViewMode 的 _kind 守卫弹提示拦截，不隐藏按钮。
    btnPreview.style.display = '';
    btnEdit.style.display = '';

    // 侧边收缩/展开按钮（#btn-side-left / #btn-side-right）默认隐藏，仅 Markdown 显示。
    sideLeft.classList.add('side-hidden', 'side-active');
    sideRight.classList.add('side-hidden', 'side-active');

    if (activeTabKind === 'text') {
      // 非 Markdown 明文：编辑器占满整行，无预览栏、无收缩/展开按钮，只支持编辑
      container.classList.add('text-only');
    } else if (activeTabKind === 'markdown' && this.viewMode === 'edit') {
      // 仅 Markdown 在编辑模式下保留侧边收缩/展开按钮（折叠编辑器或预览）；预览模式一律不显示
      sideLeft.classList.remove('side-hidden', 'side-active');
      sideRight.classList.remove('side-hidden', 'side-active');
      sideLeft.innerHTML = '&#9664;';
      sideLeft.title = this.t('collapseEditor');
      sideRight.innerHTML = '&#9654;';
      sideRight.title = this.t('collapsePreview');
    }
    // 图片：预览显示图片，但同样不需要侧边收缩/展开按钮（图片不可编辑），保持隐藏

    // 存句柄：大纲跳转等用户操作可在本定时器到期前 clearTimeout 取消，
    // 避免「视图模式恢复滚动」在跳转之后晚到、把编辑器/预览又拉回旧位置。
    clearTimeout(this._viewModeRestoreTimer);
    this._viewModeRestoreTimer = setTimeout(() => {
      this.cm.refresh();
      this.updateSideButtons();
      // 切换视图模式后，若虚拟滚动状态与新模式不一致则按新模式重建预览
      if (this.previewWindow && this._previewVirtual !== (this.viewMode === 'preview')) {
        this.updatePreview();
      }
      // 恢复滚动位置：用切换前算出的「源码行锚点」在新宽度下定位目标面板。
      // 行锚点与宽度无关，能正确跨越分屏(50%)↔纯预览(100%)的重排；像素值只在锚点失效时回退。
      const rTab = this.activeTab;
      if (rTab) {
        const anchor = this._pendingSwitchAnchorLine;
        this._pendingSwitchAnchorLine = null;
        if (this.viewMode === 'preview') {
          // 进入纯预览（100% 宽）：预览已重排，用锚点行在新布局下的预览位置定位
          let restored = false;
          if (anchor != null) {
            this._computedPosition();
            const list = this._previewElementList;
            if (list && anchor - 1 < list.length) {
              const pMax = Math.max(this.preview.scrollHeight - this.preview.clientHeight, 0);
              this.preview.scrollTop = Math.min(Math.max(0, list[anchor - 1] || 0), pMax);
              restored = true;
            }
          }
          if (!restored) {
            const pMax = Math.max(this.preview.scrollHeight - this.preview.clientHeight, 0);
            this.preview.scrollTop = Math.min(rTab.previewScrollTop || 0, pMax);
          }
          // 进入预览后立即按预览位置校准大纲高亮（不依赖 scroll 事件触发）
          this.updateOutlineFromPreview();
        } else {
          // 切回编辑（分屏）：编辑器已 refresh，用锚点行在编辑器里的像素位置定位
          let restored = false;
          if (anchor != null && this.cm) {
            try {
              const targetTop = this.cm.heightAtLine(Math.max(0, anchor - 1), 'local');
              if (typeof targetTop === 'number') { this.cm.scrollTo(0, targetTop); restored = true; }
            } catch (_) {}
          }
          if (!restored) {
            const sp = rTab.scrollPos || { top: 0, left: 0 };
            this.cm.scrollTo(sp.left || 0, sp.top || 0);
          }
        }
      }
      requestAnimationFrame(() => this._resumeScroll());
      this._viewModeRestoreTimer = null;
    }, 50);
  }

  toggleCollapse(pane) {
    const container = document.querySelector('.editor-container');
    if (this.viewMode === 'preview') {
      this.setStatus(this.t('collapseHint'));
      return;
    }

    this._canScroll.editor = false;
    this._canScroll.preview = false;

    const sideLeft = document.getElementById('btn-side-left');
    const sideRight = document.getElementById('btn-side-right');
    const editorPane = document.getElementById('editor-pane');
    const previewPane = document.getElementById('preview-pane');
    const previewScrollTop = this.preview.scrollTop;

    editorPane.style.flex = '';
    editorPane.style.width = '';
    previewPane.style.flex = '';
    previewPane.style.width = '';

    if (pane === 'editor') {
      container.classList.toggle('editor-collapsed');
      const isCollapsed = container.classList.contains('editor-collapsed');
      sideLeft.innerHTML = isCollapsed ? '&#9654;' : '&#9664;';
      sideLeft.title = isCollapsed ? this.t('restoreEditor') : this.t('collapseEditor');
      sideLeft.classList.toggle('side-active', isCollapsed);
    } else {
      container.classList.toggle('preview-collapsed');
      const isCollapsed = container.classList.contains('preview-collapsed');
      sideRight.innerHTML = isCollapsed ? '&#9664;' : '&#9654;';
      sideRight.title = isCollapsed ? this.t('restorePreview') : this.t('collapsePreview');
      sideRight.classList.toggle('side-active', isCollapsed);
    }

    let restored = false;
    const doRefresh = () => {
      if (restored) return;
      restored = true;
      this.cm.refresh();
      this.preview.scrollTop = previewScrollTop;
      this.updateSideButtons();
      requestAnimationFrame(() => {
        this._resumeScroll();
      });
    };
    const targetPane = pane === 'editor' ? editorPane : previewPane;
    targetPane.addEventListener('transitionend', (e) => {
      if (e.propertyName === 'flex') doRefresh();
    }, { once: true });
    setTimeout(doRefresh, 280);
  }

  async openUserGuide() {
    const isEn = this.settings.language === 'en';
    const fileName = isEn ? 'guide.en.md' : 'guide.md';
    const tabName = isEn ? 'User Guide.md' : '使用说明.md';
    const existingIndex = this.tabs.findIndex(t => t.name === tabName);
    if (existingIndex !== -1) {
      this.switchTab(existingIndex);
      return;
    }
    let content = null;
    // 优先用 fetch 读取打包后的前端资源（开发/多数运行环境）
    // guide.md 位于 src/ 目录，webview 前端路径 frontendDist: ../src 可访问
    try {
      const resp = await fetch(fileName);
      if (resp.ok) {
        const text = await resp.text();
        // 防止静态服务把未知路径回退成 index.html：内容是 HTML 则视为读取失败，走兜底
        const looksLikeHtml = text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html');
        if (!looksLikeHtml) content = text;
      }
    } catch (_) { /* 落到下面的兜底读取 */ }
    // 兜底：通过 Rust 从应用资源目录读取（部分打包/WebView 环境下 fetch 受限）
    if (content === null) {
      try {
        const baseDir = (await TauriApi.resourceDir()) || '';
        const p = baseDir ? (baseDir.replace(/[/\\]$/, '') + '/' + fileName) : fileName;
        content = await TauriApi.readFile({ path: p });
      } catch (e) {
        this.reportError('guide', { error: e });
        return;
      }
      // read_file 也可能返回 HTML（某些资源目录解析不符预期），同样排除
      if (content && (content.trim().startsWith('<!DOCTYPE') || content.trim().startsWith('<html'))) {
        content = null;
      }
    }
    if (content === null) {
      this.reportError('guide');
      return;
    }
    this.addTab(tabName, content, null);
    this.activeTab.savedContent = content;
    this.activeTab.isGuide = true;
    this.updateTabDisplay();
    this.setStatus(isEn ? this.t('openedGuideEn') : this.t('openedGuide'));
  }

  async _openBundledFile(href, content, filePath = null) {
    const name = filePath ? filePath.split(/[/\\]/).pop() : href.split(/[/\\]/).pop();
    // 去重：有真实路径按路径，无路径（打包资源，如从「使用说明」打开的 demo.md）按名称，
    // 避免同一资源重复打开多个标签页
    const existingIndex = filePath
      ? this.tabs.findIndex(t => t.filePath === filePath)
      : this.tabs.findIndex(t => t.name === name);
    if (existingIndex !== -1) {
      this.switchTab(existingIndex);
      return;
    }
    this.addTab(name, content, filePath);
    this.activeTab.savedContent = content;
    // 标记为打包资源 tab：processImages 仅对这类 tab 启用 read_bundled_image_as_base64
    // 回退（dev 模式 filePath 目录可能读不到图片），普通本地文档不回退，避免误加载打包资源。
    this.activeTab.isBundled = true;
    this.updateTabDisplay();
  }

  // 还原被渲染器编码的链接 URL（%5C→\、%2F→/ 等），得到可读取的真实文件路径。
  // 兼容 Windows 盘符路径（D:\ 或 D:/）与 macOS/Linux 绝对路径（/...），
  // 相对路径原样返回，交由 resolveDocPath 处理。
  normalizeLinkHref(href) {
    let p = href;
    try { p = decodeURIComponent(href); } catch (_) { p = href; }
    return p;
  }

  async showAbout() {
    const dialog = document.getElementById('about-dialog');
    // 每次打开重置为默认居中尺寸（拖动/缩放状态不记忆，符合预期）
    const ap = dialog ? dialog.querySelector('.dialog') : null;
    if (ap && typeof window.resetDialog === 'function') window.resetDialog(ap);
    // 每次打开重置折叠状态：所有分类默认展开
    dialog.querySelectorAll('.dependency-details').forEach((sec) => sec.setAttribute('data-collapsed', 'false'));
    dialog.classList.remove('hidden');
    // 折叠块展开/收起由全局委托 bindCollapseToggle 统一处理，
    // 各块默认状态（展开/收起）由 HTML data-collapsed 初始值决定，此处不再干预。
    if (!dialog._devSetup) {
      dialog._devSetup = true;
      let cnt = 0;
      let timer = null;
      const verEl = document.getElementById('about-version');
      if (verEl) {
        verEl.addEventListener('click', async () => {
          cnt++;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => { cnt = 0; }, 400);
          if (cnt >= 5) {
            cnt = 0;
            clearTimeout(timer);
            timer = null;
            try {
              await TauriApi.openDevtools();
              this.showToast(this.t('devtoolsOpened'), 'success');
            } catch (e) {
              this.showToast(this.t('devtoolsOpenFailed', { err: e }), 'danger');
            }
          }
        });
      }
    }
    try {
      const ver = await TauriApi.getVersion();
      const el = document.getElementById('about-version');
      if (el) el.textContent = 'v' + ver;
    } catch (_) {}
  }

  hideAbout() {
    document.getElementById('about-dialog').classList.add('hidden');
  }

  // ========== Update / Auto-updater ==========

  showUpdateDialog() {
    document.getElementById('update-dialog').classList.remove('hidden');
  }

  hideUpdateDialog() {
    this._updateDismissed = true;
    document.getElementById('update-dialog').classList.add('hidden');
  }

  showUpdateState(state, checkId) {
    ['checking', 'available', 'latest'].forEach(s => {
      document.getElementById('update-state-' + s).classList.toggle('hidden', s !== state);
    });
    const titles = {
      checking: this.t('updateChecking'),
      available: this.t('updateAvailable'),
      latest: this.t('updateLatest'),
    };
    const titleEl = document.getElementById('update-title');
    if (titleEl) titleEl.textContent = titles[state] || this.t('updateAvailable');
    const btn = document.getElementById('update-action');
    const skipBtn = document.getElementById('update-skip');
    if (state === 'checking') {
      btn.disabled = true;
      btn.textContent = this.t('updateChecking');
      document.getElementById('update-progress-wrap').classList.add('hidden');
      if (skipBtn) skipBtn.classList.remove('hidden');
    } else if (state === 'available') {
      if (skipBtn) skipBtn.classList.remove('hidden');
    } else if (state === 'latest') {
      // 已是最新：弹框保持打开，不弹 toast，下方按钮变为单个蓝色「确认」
      if (skipBtn) skipBtn.classList.add('hidden');
      btn.disabled = false;
      btn.dataset.state = 'confirm';
      btn.textContent = this.t('updateConfirm');
      document.getElementById('update-progress-wrap').classList.add('hidden');
      this._fillLatestVersion(checkId);
    }
  }

  async _fillLatestVersion(checkId) {
    const el = document.getElementById('update-latest-version');
    if (!el) return;
    try {
      const ver = await TauriApi.getVersion();
      if (checkId !== undefined && this._updateCheckId !== checkId) return;
      el.textContent = 'v' + ver;
    } catch (_) {}
  }

  async checkUpdate(showUpToDate = false) {
    const checkId = (this._updateCheckId || 0) + 1;
    this._updateCheckId = checkId;
    this._updateDismissed = false;
    if (showUpToDate) {
      this.showUpdateDialog();
      this.showUpdateState('checking', checkId);
    }
    try {

      const result = await TauriApi.updater.check();
      if (this._updateCheckId !== checkId || this._updateDismissed) return;
      if (!result) {
        if (showUpToDate) {
          this.showUpdateState('latest', checkId);
        }
        return;
      }
      const update = result;
      if (!showUpToDate) this.showUpdateDialog();
      document.getElementById('update-new-version').textContent = update.version;
      try {
        const ver = await TauriApi.getVersion();
        if (this._updateCheckId !== checkId || this._updateDismissed) return;
        document.getElementById('update-current-version').textContent = ver;
      } catch (_) {}
      const notesEl = document.getElementById('update-notes-body');
      if (update.body) {
        if (window.markdownit) {
          notesEl.innerHTML = window.markdownit({ html: false, linkify: true }).render(update.body);
        } else {
          notesEl.innerHTML = update.body.replace(/\n/g, '<br>');
        }
      } else {
        notesEl.textContent = this.t('noUpdateNotes');
      }
      this.showUpdateState('available', checkId);
      this.pendingUpdate = update;
      this.pendingUpdateRid = update.rid;
      this.setUpdateAction('download');
    } catch (err) {
      console.error('Update check failed:', err);
      if (showUpToDate) {
        this.hideUpdateDialog();
        this.showToast(this.t('updateFailed'));
      }
    }
  }

  setUpdateAction(state) {
    const btn = document.getElementById('update-action');
    btn.dataset.state = state;
    btn.disabled = state === 'downloading';
    if (state === 'download') {
      btn.textContent = this.t('updateDownloadLabel');
    } else if (state === 'downloading') {
      btn.textContent = this.t('updateDownloading');
    } else if (state === 'install') {
      btn.textContent = this.t('updateInstallNow');
    }
  }

  async handleUpdateAction() {
    const state = document.getElementById('update-action').dataset.state;
    if (state === 'confirm') {
      this.hideUpdateDialog();
      return;
    }
    if (state === 'download') {
      this.setUpdateAction('downloading');
      document.getElementById('update-progress-wrap').classList.remove('hidden');
      await this.downloadUpdate();
    } else if (state === 'install') {
      await this.installUpdate();
    }
  }

  async downloadUpdate() {
    if (!this.pendingUpdate || !this.pendingUpdateRid) return;
    this.pendingBytesRid = null;
    try {

      const channel = new TauriApi.Channel();
      let totalSize = 0;
      let downloadedSize = 0;
      channel.onmessage = (eventData) => {
        if (eventData.event === 'Started') {
          totalSize = eventData.data?.contentLength || 0;
        } else if (eventData.event === 'Progress') {
          downloadedSize += eventData.data?.chunkLength || 0;
          const pct = totalSize > 0 ? Math.min(100, Math.round((downloadedSize / totalSize) * 100)) : 0;
          document.getElementById('update-progress-fill').style.width = pct + '%';
          document.getElementById('update-progress-text').textContent = pct + '%';
        } else if (eventData.event === 'Finished') {
          document.getElementById('update-progress-fill').style.width = '100%';
          document.getElementById('update-progress-text').textContent = '100%';
        }
      };
      const bytesRid = await TauriApi.updater.download({ rid: this.pendingUpdateRid, onEvent: channel });
      this.pendingBytesRid = bytesRid;
      this.setUpdateAction('install');
    } catch (err) {
      console.error('Download failed:', err);
      this.showToast(this.t('updateFailed'));
      this.hideUpdateDialog();
    }
  }

  async installUpdate() {
    if (!this.pendingUpdateRid || !this.pendingBytesRid) return;
    document.getElementById('update-action').disabled = true;
    this.hideUpdateDialog();
    try {

      await TauriApi.updater.install({ updateRid: this.pendingUpdateRid, bytesRid: this.pendingBytesRid });
    } catch (err) {
      console.error('Install failed:', err);
      document.getElementById('update-action').disabled = false;
      this.showToast(this.t('updateFailed'));
    }
  }

  openExternal(url) {
    TauriApi.shellOpen(url).then((opened) => {
      if (!opened) window.open(url, '_blank', 'noopener,noreferrer');
    });
  }

  async minimizeWindow() {
    try {
      const appWindow = TauriApi.currentWindow();
      await appWindow.minimize();
    } catch (e) {
      console.warn('minimize failed:', e);
    }
  }

  async toggleMaximize() {
    try {
      const appWindow = TauriApi.currentWindow();
      const isMaximized = await appWindow.isMaximized();
      if (isMaximized) {
        await appWindow.unmaximize();
      } else {
        await appWindow.maximize();
      }
      this.updateMaximizeIcon();
    } catch (e) {
      console.warn('maximize failed:', e);
    }
  }

  async updateMaximizeIcon() {
    try {
      const appWindow = TauriApi.currentWindow();
      const isMaximized = await appWindow.isMaximized();
      const btn = document.getElementById('btn-maximize');
      if (isMaximized) {
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
      } else {
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>';
      }
    } catch (e) {
      console.warn('updateMaximizeIcon failed:', e);
    }
  }

  async closeWindow() {
    await this.handleAppClose();
  }

  // ========== Markdown 格式化辅助方法 ==========

  wrapSelection(before, after) {
    const sel = this.cm.getSelection();
    if (sel) {
      this.cm.replaceSelection(before + sel + after);
    } else {
      const cursor = this.cm.getCursor();
      this.cm.replaceRange(before + after, cursor);
      this.cm.setCursor({ line: cursor.line, ch: cursor.ch + before.length });
    }
    this.cm.focus();
  }

  insertAtCursor(text, cursorOffset) {
    const cursor = this.cm.getCursor();
    const prevLine = cursor.line > 0 ? this.cm.getLine(cursor.line - 1) : '';
    const needNewline = cursor.line > 0 && prevLine.trim() !== '';
    const prefix = needNewline ? '\n' : '';
    const addedLines = needNewline ? 1 : 0;
    this.cm.replaceRange(prefix + text, cursor);
    if (cursorOffset !== undefined) {
      this.cm.setCursor({ line: cursor.line + addedLines, ch: cursor.ch + cursorOffset });
    } else {
      this.cm.setCursor({ line: cursor.line + addedLines, ch: cursor.ch + text.length });
    }
    this.cm.focus();
  }

  insertImageBlock(text) {
    const cursor = this.cm.getCursor();
    const line = this.cm.getLine(cursor.line);
    const afterText = line.slice(cursor.ch);
    const prevLine = cursor.line > 0 ? this.cm.getLine(cursor.line - 1) : '';
    let prefix = '';
    let addedLines = 0;
    if (cursor.ch > 0 || (cursor.line > 0 && prevLine.trim() !== '')) {
      prefix = '\n';
      addedLines = 1;
    }
    this.cm.replaceRange(prefix + text + '\n' + afterText, cursor, { line: cursor.line, ch: line.length });
    this.cm.setCursor({ line: cursor.line + addedLines + 1, ch: 0 });
    this.cm.focus();
  }

  handleTaskCheckboxToggle(checkbox) {
    // 通过 li 的 data-source-line 反查源码行（remark plugin 给所有节点标注，1-based）
    const li = checkbox.closest('li');
    if (!li) return;
    const lineAttr = li.getAttribute('data-source-line');
    if (!lineAttr) return;
    const lineNum = parseInt(lineAttr, 10) - 1;  // 转 0-based
    if (isNaN(lineNum) || lineNum < 0 || lineNum >= this.cm.lineCount()) return;
    const lineText = this.cm.getLine(lineNum);
    // 匹配任务列表行：可选 > 前缀（引用块嵌套）+ 前缀（- * + 或 数字.）+ [ ] / [x] + 可选内容
    const taskRe = /^(\s*(?:>\s*)*(?:[*+-]|\d+[.)])\s+)\[([ xX])\](\s.*)?$/;
    const m = lineText.match(taskRe);
    if (!m) return;
    // 按源码标记取反作为目标态（与即将发生的原生 click 默认切换结果一致）。
    // 这里【不】手动设置 checkbox.checked：不 preventDefault，原生默认行为会把
    // checkbox 切到 newChecked 并自己重绘 :checked 样式；若我们抢先设了 checked，
    // 原生默认行为会在事件末尾再翻一次，反而错。
    const sourceChecked = m[2] === 'x' || m[2] === 'X';
    const newChecked = !sourceChecked;
    const newMark = newChecked ? 'x' : ' ';
    const newLine = m[1] + '[' + newMark + ']' + (m[3] || '');
    const cursor = this.cm.getCursor();
    // 预览 checkbox 已由原生 click 默认行为即时切到 newChecked（浏览器自绘，必然有响应）；
    // 抑制整篇重渲染，避免重复重建把即时勾选态覆盖 / 引发预览或编辑器跳动。
    this._suppressNextPreviewRerender = true;
    // 同时取消任何已排队的防抖重建（如打字 / setValue 触发的待执行 300ms 定时器）：
    // 否则勾选后那个遗留定时器仍会到期并整篇重建 preview，覆盖即时勾选并引发跳动/“看似没反应”。
    clearTimeout(this.debounceTimer);
    // 取消任何在途的滚动同步调度：用户刚滚动到勾选框、点击间隔 < 100ms 时，
    // 上一次滚动留下的 throttle 尾随 _syncPreviewToEditor / debounce _resumeScroll 会在
    // 本函数设的抑制窗口外补跑，越权把编辑器滚到别处。一并清掉，避免越权同步。
    this._scrollThrottleTimer = null;
    this._scrollThrottlePending = null;
    clearTimeout(this._scrollDebounceTimer);
    this._scrollDebounceTimer = null;
    // 记录编辑器滚动位置：cm.replaceRange/cm.setCursor 在某些 WebView 下会让 CodeMirror
    // 内部滚动编辑器（即便 setCursor scroll:false）。_canScroll 双标志只挡「滚动同步」、
    // 挡不住 CM 自身滚动，表现为「点完勾选框编辑器跳到别处」。故显式捕获并在变更后还原。
    const edScrollTop = this.cm.getScrollInfo().top;
    // 临时关闭滚动同步：cm.replaceRange/cm.setCursor 可能让编辑器自动滚动，
    // 触发 _syncEditorToPreview 把预览滚到光标行（任务列表某行），导致上方 H3「任务列表」
    // 被滚出视野顶部——表现为「点完之后预览框根本没有渲染出来」。
    // _resumeScroll 会在 100ms 后自动恢复 _canScroll 标志，不影响正常滚动同步。
    const prevCanScroll = { editor: this._canScroll.editor, preview: this._canScroll.preview };
    this._canScroll.editor = false;
    this._canScroll.preview = false;
    this.cm.replaceRange(newLine, { line: lineNum, ch: 0 }, { line: lineNum, ch: lineText.length });
    this.cm.setCursor(cursor, { scroll: false });  // 保持光标位置不跳动且不让编辑器自动滚动
    if (typeof edScrollTop === 'number') {
      this.cm.scrollTo(0, edScrollTop); // 立即还原编辑器滚动，消除 CM 内部滚动导致的跳动
      // 兜住 CM 在 operation 收尾时的异步滚动（下一帧），避免长时间错位闪烁
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => { if (typeof edScrollTop === 'number') this.cm.scrollTo(0, edScrollTop); });
      }
    }
    setTimeout(() => {
      // 安全网：若 CM 在变更后异步（rAF/operation 收尾）调整了编辑器滚动，再还原一次；
      // 此时 _canScroll.editor 仍为 false，scrollTo 触发的滚动事件被同步处理器忽略，不会联动预览。
      if (typeof edScrollTop === 'number') this.cm.scrollTo(0, edScrollTop);
      if (this._canScroll) {
        this._canScroll.editor = prevCanScroll.editor;
        this._canScroll.preview = prevCanScroll.preview;
      }
    }, 120);
    // activeTab.content 由 change 事件同步；预览 DOM 已就地更新，无需重渲染.
  }

  insertLinePrefix(prefix, ordered = false) {
    const cm = this.cm;
    // 有选区（跨行 / 多选区）：对选区覆盖的每一行逐行加前缀，用 operation 包裹保证一次 undo 撤销整批
    if (cm.somethingSelected()) {
      cm.operation(() => {
        const selections = cm.listSelections();
        const newSelections = [];
        for (const sel of selections) {
          const startLine = Math.min(sel.anchor.line, sel.head.line);
          const endLine = Math.max(sel.anchor.line, sel.head.line);
          let n = 1;
          for (let ln = startLine; ln <= endLine; ln++) {
            const text = cm.getLine(ln);
            // 单行替换不增删行，行号在循环中保持有效
            const linePrefix = ordered ? (n++) + '. ' : prefix;
            cm.replaceRange(linePrefix + text, { line: ln, ch: 0 }, { line: ln, ch: text.length });
          }
          // 选中整批改动行（行首到末行行尾），让用户直观看到加前缀后的范围
          const lastLineText = cm.getLine(endLine);
          newSelections.push({
            anchor: { line: startLine, ch: 0 },
            head: { line: endLine, ch: lastLineText.length },
          });
        }
        cm.setSelections(newSelections);
      });
      cm.focus();
      return;
    }
    // 无选区：原单行行为（含上一行非空时自动换行再加前缀）
    const cursor = cm.getCursor();
    const line = cm.getLine(cursor.line);
    const prevLine = cursor.line > 0 ? cm.getLine(cursor.line - 1) : '';
    const needNewline = cursor.line > 0 && prevLine.trim() !== '';
    const newLine = needNewline ? '\n' : '';
    cm.replaceRange(newLine + prefix + line, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
    cm.setCursor({ line: cursor.line + (needNewline ? 1 : 0), ch: prefix.length + cursor.ch });
    cm.focus();
  }

  // 标题快捷键：智能设置 / 切换标题层级（替代原先的「行首盲目加 #」）。
  // - 行首已是标题（^#{1,6}\s*）：目标层级不同 → 原位替换旧的 # 前缀（如 ## 标题 + Ctrl+3 → ### 标题）；
  //   目标层级相同 → 取消标题（移除 # 前缀回到正文，Typora 式 toggle）。
  // - 行首无标题标记：沿用 insertLinePrefix 的插入行为（含上一行非空时自动换行）。
  // 多行选区：对选区内每一行分别执行「替换 / 取消 / 追加」，不触发换行逻辑，整体一次 undo。
  applyHeadingLevel(level) {
    const cm = this.cm;
    const prefix = '#'.repeat(level) + ' ';
    const HEADING_RE = /^(#{1,6})\s*/;

    if (cm.somethingSelected()) {
      cm.operation(() => {
        const selections = cm.listSelections();
        const newSelections = [];
        for (const sel of selections) {
          const startLine = Math.min(sel.anchor.line, sel.head.line);
          const endLine = Math.max(sel.anchor.line, sel.head.line);
          for (let ln = startLine; ln <= endLine; ln++) {
            const text = cm.getLine(ln);
            const m = text.match(HEADING_RE);
            if (m) {
              const newPrefix = m[1].length === level ? '' : prefix;
              cm.replaceRange(newPrefix, { line: ln, ch: 0 }, { line: ln, ch: m[0].length });
            } else {
              cm.replaceRange(prefix + text, { line: ln, ch: 0 }, { line: ln, ch: text.length });
            }
          }
          const lastLineText = cm.getLine(endLine);
          newSelections.push({
            anchor: { line: startLine, ch: 0 },
            head: { line: endLine, ch: lastLineText.length },
          });
        }
        cm.setSelections(newSelections);
      });
      cm.focus();
      return;
    }

    // 无选区：单行
    const cursor = cm.getCursor();
    const line = cm.getLine(cursor.line);
    const m = line.match(HEADING_RE);
    if (m) {
      const newPrefix = m[1].length === level ? '' : prefix;
      const delta = newPrefix.length - m[0].length;
      cm.replaceRange(newPrefix, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: m[0].length });
      const newCh = Math.max(0, Math.min(cursor.ch + delta, (newPrefix + line.slice(m[0].length)).length));
      cm.setCursor({ line: cursor.line, ch: newCh });
      cm.focus();
      return;
    }
    // 无标题标记 → 沿用原有插入行为（含上一行非空时自动换行）
    this.insertLinePrefix(prefix);
  }

  // 表格行内按 Enter 自动补充表格结构
  // 表格行内 Enter：整理整段表格（对齐/补齐分隔行/统一列数）并在当前行下方插入等列空白行。
  // 整理规则（用户反馈）：① 缺分隔行→自动补齐；② 分隔行数量不足→补全；
  // ③ 分隔行不规范（如 |--|）→规范为 | --- |；④ 各行列数不统一→缺失行补空白格；
  // ⑤ 单元格不规范（如 |内容 |）→规范为 | 内容 |。
  _handleTableEnter(cm) {
    const TABLE_ROW_RE = /^\|.*\|\s*$/;
    const TABLE_SEPARATOR_RE = /^\|\s*[-:][-:\s]*\|/;
    const pos = cm.getCursor();
    const line = cm.getLine(pos.line);
    // 非表格行或分隔行 → 走正常换行/列表延续
    if (!TABLE_ROW_RE.test(line) || TABLE_SEPARATOR_RE.test(line)) {
      this._newlineAndIndent(cm);
      return;
    }
    // 有选区 → 交回原有逻辑
    if (cm.somethingSelected()) {
      this._newlineAndIndent(cm);
      return;
    }
    // 计算列数
    const colCount = (line.match(/\|/g) || []).length - 1;
    if (colCount < 1) {
      this._newlineAndIndent(cm);
      return;
    }
    // 空表格行（去除 | 与空白后无内容）→ 退出表格：删除本行
    const stripped = line.replace(/\|/g, '').trim();
    if (stripped === '') {
      const nextLine = cm.getLine(pos.line + 1);
      if (nextLine !== undefined) {
        cm.replaceRange('', { line: pos.line, ch: 0 }, { line: pos.line + 1, ch: 0 });
      } else {
        // 最后一行：清空内容
        cm.replaceRange('', { line: pos.line, ch: 0 }, { line: pos.line, ch: line.length });
      }
      cm.setCursor({ line: pos.line, ch: 0 });
      return;
    }
    // 正常表格行 → 整理整段表格 + 在当前行下方插入等列空白新行
    cm.operation(() => {
      const res = this._normalizeTableBlock(cm, pos.line, TABLE_ROW_RE, TABLE_SEPARATOR_RE, pos.line);
      if (!res) { this._newlineAndIndent(cm); return; }
      cm.setCursor({ line: res.newRowLine, ch: 2 });
    });
  }

  // 在光标所在表格行下方插入等列空白行（同时整理整段表格），光标置于新行第一格。
  // 默认无键位，可在「自定义快捷键」中为 addTableRow 绑定（用户反馈：表格加行）。
  _addTableRow(cm) {
    if (!cm) return;
    const pos = cm.getCursor();
    const line = cm.getLine(pos.line);
    const TABLE_ROW_RE = /^\|.*\|\s*$/;
    const TABLE_SEPARATOR_RE = /^\|\s*[-:][-:\s]*\|/;
    if (!TABLE_ROW_RE.test(line) || TABLE_SEPARATOR_RE.test(line)) return; // 不在表格数据行 → 不操作
    const colCount = (line.match(/\|/g) || []).length - 1;
    if (colCount < 1) return;
    cm.operation(() => {
      const res = this._normalizeTableBlock(cm, pos.line, TABLE_ROW_RE, TABLE_SEPARATOR_RE, pos.line);
      if (res) cm.setCursor({ line: res.newRowLine, ch: 2 });
    });
    cm.focus();
  }

  // 在光标所在列右侧插入空白列（跨整段表格），光标置于新列首格。
  // 默认无键位，可在「自定义快捷键」中为 addTableColumn 绑定（用户反馈：表格加列）。
  _addTableColumn(cm) {
    if (!cm) return;
    const pos = cm.getCursor();
    const line = cm.getLine(pos.line);
    const TABLE_ROW_RE = /^\|.*\|\s*$/;
    const TABLE_SEPARATOR_RE = /^\|\s*[-:][-:\s]*\|/;
    if (!TABLE_ROW_RE.test(line)) return; // 不在表格行 → 不操作
    const colIdx = this._cursorColumnIndex(line, pos.ch); // 光标所在列（0 起）
    if (colIdx < 0) return;
    // 扩展表格块范围
    let start = pos.line, end = pos.line;
    while (start - 1 >= 0 && TABLE_ROW_RE.test(cm.getLine(start - 1))) start--;
    while (end + 1 <= cm.lastLine() && TABLE_ROW_RE.test(cm.getLine(end + 1))) end++;
    cm.operation(() => {
      let curStarts = null;
      for (let i = start; i <= end; i++) {
        const l = cm.getLine(i);
        const isSep = TABLE_SEPARATOR_RE.test(l);
        const cells = this._splitCells(l);
        const insertIdx = Math.min(colIdx + 1, cells.length); // 插到光标列右侧
        cells.splice(insertIdx, 0, isSep ? '---' : '');
        const { text, starts } = this._buildRow(cells);
        cm.replaceRange(text, { line: i, ch: 0 }, { line: i, ch: l.length });
        if (i === pos.line) curStarts = starts;
      }
      if (curStarts) {
        const target = Math.min(colIdx + 1, curStarts.length - 1);
        cm.setCursor({ line: pos.line, ch: curStarts[target] });
      }
    });
    cm.focus();
  }

  // 返回光标所在列的 0 起索引；越界时回落到最近列。
  _cursorColumnIndex(line, ch) {
    let pipes = 0;
    for (let i = 0; i < ch && i < line.length; i++) {
      if (line[i] === '|') pipes++;
    }
    // 首个 | 开启第 0 列，故列索引 = 其前的 | 数 - 1
    return Math.max(0, pipes - 1);
  }

  // 整理光标所在表格块：补齐/规范分隔行、统一单元格对齐与列数；可选在 blankAfterLine
  // 指定的原始数据行下方追加一条等列空白行。返回 { newRowLine }（追加行的绝对行号；未追加为 -1）。
  _normalizeTableBlock(cm, cursorLine, TABLE_ROW_RE, TABLE_SEPARATOR_RE, blankAfterLine) {
    let start = cursorLine, end = cursorLine;
    while (start - 1 >= 0 && TABLE_ROW_RE.test(cm.getLine(start - 1))) start--;
    while (end + 1 <= cm.lastLine() && TABLE_ROW_RE.test(cm.getLine(end + 1))) end++;
    const raws = [];
    for (let i = start; i <= end; i++) {
      const t = cm.getLine(i);
      raws.push({ text: t, isSep: TABLE_SEPARATOR_RE.test(t), origLine: i });
    }
    let colCount = 0;
    for (const r of raws) if (!r.isSep) colCount = Math.max(colCount, this._splitCells(r.text).length);
    if (colCount === 0) return null;
    const hasSep = raws.some((r) => r.isSep);
    const out = [];
    let newRowLine = -1;
    let pendingBlank = false; // 标记：在当前数据行之后（跨过紧随的分隔行）插入空白行
    const pushBlank = () => {
      const blankIdx = out.length;
      out.push(this._buildRow(Array(colCount).fill('')).text);
      newRowLine = start + blankIdx;
    };
    for (let i = 0; i < raws.length; i++) {
      const r = raws[i];
      if (r.isSep) {
        out.push(this._buildRow(this._normalizeSepCells(r.text, colCount)).text);
        if (pendingBlank) { pushBlank(); pendingBlank = false; }
        continue;
      }
      const cells = this._splitCells(r.text);
      while (cells.length < colCount) cells.push('');
      out.push(this._buildRow(cells).text);
      // 在指定数据行下方追加空白行（若紧随其后是分隔行，则延后到分隔行之后，保证表头→分隔→正文顺序）
      if (blankAfterLine != null && r.origLine === blankAfterLine) {
        pendingBlank = true;
      }
      // 缺分隔行 → 在首行（表头/首数据行）下方补齐
      if (!hasSep && i === 0 && !r.isSep) {
        out.push(this._buildRow(Array(colCount).fill('---')).text);
        if (pendingBlank) { pushBlank(); pendingBlank = false; }
      }
    }
    if (pendingBlank) pushBlank();
    const newText = out.join('\n');
    cm.replaceRange(newText, { line: start, ch: 0 }, { line: end, ch: cm.getLine(end).length });
    return { newRowLine };
  }

  // 把表格行拆分为单元格数组（去首尾 | 并按 | 切分、trim）。
  _splitCells(text) {
    let t = text.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map((c) => c.trim());
  }

  // 把单元格数组组装为标准表格行，返回 { text, starts }；starts[k] 为第 k 列内容起始 ch。
  _buildRow(cells) {
    let text = '| ';
    const starts = [];
    for (let k = 0; k < cells.length; k++) {
      starts.push(text.length);
      text += cells[k];
      if (k < cells.length - 1) text += ' | ';
    }
    text += ' |';
    return { text, starts };
  }

  // 规范分隔行单元格：保留对齐标记（:-- / --: / :-:），不足列数补 ---。
  _normalizeSepCells(sepText, colCount) {
    const cells = this._splitCells(sepText);
    while (cells.length < colCount) cells.push('---');
    return cells.map((c) => {
      const t = c.trim();
      const left = t.startsWith(':');
      const right = t.endsWith(':');
      let s = '---';
      if (left) s = ':' + s;
      if (right) s = s + ':';
      return s;
    });
  }

  _newlineAndIndent(cm) {
    const cmdName = 'newlineAndIndentContinueMarkdownList';
    if (CodeMirror.commands[cmdName]) {
      cm.execCommand(cmdName);
    } else {
      cm.execCommand('newlineAndIndent');
    }
  }

  insertBlock(text, cursorOffset) {
    const cursor = this.cm.getCursor();
    const line = this.cm.getLine(cursor.line);
    const needNewline = line.trim() !== '';
    const prefix = needNewline ? '\n\n' : '';
    const addedLines = needNewline ? 2 : 0;
    this.cm.replaceRange(prefix + text + '\n', cursor);
    if (cursorOffset !== undefined) {
      const before = text.substring(0, cursorOffset);
      const lastNewline = before.lastIndexOf('\n');
      const targetLine = cursor.line + addedLines + (before.split('\n').length - 1);
      const targetCh = lastNewline === -1 ? cursorOffset : (cursorOffset - lastNewline - 1);
      this.cm.setCursor({ line: targetLine, ch: targetCh });
    } else {
      const lines = text.split('\n');
      this.cm.setCursor({ line: cursor.line + addedLines + lines.length - 1, ch: lines[lines.length - 1].length });
    }
    this.cm.focus();
  }

  // 在光标所在行下方插入空行（不截断当前行），光标保持在原来位置（原行、原列），不移动到新行。
  insertLineBelow() {
    const cm = this.cm;
    if (!cm) return;
    const cur = cm.getCursor();
    const lineNo = cur.line;
    const lineLen = cm.getLine(lineNo).length;
    cm.operation(() => {
      // 在行尾追加换行 → 当前行光标后文本留在原行，不截断；下方生成一个新的空行。
      cm.replaceRange('\n', { line: lineNo, ch: lineLen });
      // 光标保持在原行、原列位置（新空行在其下方，原行内容不受影响）。
      cm.setCursor({ line: lineNo, ch: cur.ch });
    });
  }

  // 在光标所在行上方插入空行：原行整体下移，光标跟随原文本行、保持原列位置（不移动到新行）。
  insertLineAbove() {
    const cm = this.cm;
    if (!cm) return;
    const cur = cm.getCursor();
    const lineNo = cur.line;
    cm.operation(() => {
      // 在当前行行首插入换行 → 原行整体下移，上方生成一个新的空行。
      cm.replaceRange('\n', { line: lineNo, ch: 0 });
      // 原文本整体下移一行，光标跟随到原文本所在的新行（lineNo+1），保持原列位置。
      cm.setCursor({ line: lineNo + 1, ch: cur.ch });
    });
  }

  // ========== 右键菜单 ==========

  initContextMenu() {
    const editorWrapper = document.getElementById('editor-wrapper');
    const previewWrapper = document.getElementById('preview-wrapper');

    editorWrapper.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.copy-btn')) return;
      e.preventDefault();
      this.hideAllContextMenus();
      this.showContextMenu('context-menu-editor', e.clientX, e.clientY);
    });

    // 点击编辑器区域即视为离开文件树：清除树选中态，恢复编辑器的文本复制/剪切/粘贴。
    // 否则 _fileTreeCtx 持续存在会让 Ctrl+C/V 优先按文件树操作，误拦截编辑器文本操作。
    // 注意：从目录树点击文件打开编辑器是 openFilePath 程序化 focus，不会触发此 mousedown，
    // 因此「点文件 → Ctrl+C 复制文件」的常用流程不受影响。
    editorWrapper.addEventListener('mousedown', () => {
      if (this._fileTreeCtx) this._fileTreeCtx = null;
    });

    previewWrapper.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.copy-btn')) return;
      e.preventDefault();
      this.hideAllContextMenus();
      this.showContextMenu('context-menu-preview', e.clientX, e.clientY);
    });

    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hideAllContextMenus();
        this._contextTabIndex = parseInt(tab.dataset.index);
        this.showContextMenu('context-menu-tab', e.clientX, e.clientY);
      });
    });

    const observer = new MutationObserver(() => {
      document.querySelectorAll('.tab').forEach(tab => {
        if (!tab._ctxBound) {
          tab._ctxBound = true;
          tab.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.hideAllContextMenus();
            this._contextTabIndex = parseInt(tab.dataset.index);
            this.showContextMenu('context-menu-tab', e.clientX, e.clientY);
          });
        }
      });
    });
    observer.observe(document.getElementById('tab-bar'), { childList: true, subtree: true });

    document.addEventListener('click', () => this.hideAllContextMenus());
    document.addEventListener('contextmenu', (e) => {
      if (e.target.closest('input:not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea, select') &&
          !e.target.closest('#editor-wrapper') && !e.target.closest('#preview-wrapper')) {
        return;
      }
      e.preventDefault();
      if (!e.target.closest('.context-menu') && !e.target.closest('.dropdown-menu') && !e.target.closest('#editor-wrapper') && !e.target.closest('#preview-wrapper') && !e.target.closest('.tab')) {
        this.hideAllContextMenus();
      }
    });

    document.querySelectorAll('.context-menu-item[data-action]').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = item.dataset.action;
        this.hideAllContextMenus();
        this.executeMenuAction(action);
      });
    });

    document.querySelectorAll('.context-submenu-trigger').forEach(trigger => {
      const showSubmenu = () => {
        const parentMenu = trigger.closest('.context-menu');
        const submenuId = trigger.dataset.submenu;
        const submenu = document.getElementById(submenuId);
        if (!submenu) return;

        const ancestors = [];
        let el = parentMenu;
        while (el) {
          if (el.classList && el.classList.contains('context-menu')) {
            ancestors.push(el);
          }
          el = el.parentElement;
        }

        document.querySelectorAll('.context-menu.submenu').forEach(s => {
          if (!ancestors.includes(s) && s !== submenu) {
            s.classList.add('hidden');
          }
        });

        submenu.classList.remove('hidden');
        const parentRect = trigger.getBoundingClientRect();
        submenu.style.left = (parentRect.right - 1) + 'px';
        submenu.style.top = parentRect.top + 'px';

        requestAnimationFrame(() => {
          const subRect = submenu.getBoundingClientRect();
          if (subRect.right > window.innerWidth) {
            submenu.style.left = (parentRect.left - subRect.width + 1) + 'px';
          }
          if (subRect.bottom > window.innerHeight) {
            submenu.style.top = (window.innerHeight - subRect.height - 4) + 'px';
          }
        });
      };

      trigger.addEventListener('mouseenter', showSubmenu);
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const submenuId = trigger.dataset.submenu;
        const submenu = document.getElementById(submenuId);
        if (submenu && submenu.classList.contains('hidden')) {
          showSubmenu();
        }
      });
    });

    let ctxHideTimer = null;

    document.querySelectorAll('.context-menu').forEach(menu => {
      menu.addEventListener('mouseleave', () => {
        clearTimeout(ctxHideTimer);
        ctxHideTimer = setTimeout(() => {
          if (!document.querySelector('.context-menu.submenu:hover') && !document.querySelector('.context-submenu-trigger:hover')) {
            document.querySelectorAll('.context-menu.submenu').forEach(s => s.classList.add('hidden'));
          }
        }, 150);
      });
      menu.addEventListener('mouseenter', () => {
        if (menu.classList.contains('submenu')) {
          clearTimeout(ctxHideTimer);
        }
      });
    });

    document.querySelectorAll('.context-menu .context-menu-item:not(.context-submenu-trigger)').forEach(item => {
      item.addEventListener('mouseenter', () => {
        const parentMenu = item.closest('.context-menu');
        parentMenu.querySelectorAll('.context-submenu-trigger').forEach(trigger => {
          const sub = document.getElementById(trigger.dataset.submenu);
          if (sub) sub.classList.add('hidden');
        });
      });
    });
  }

  showContextMenu(menuId, x, y) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.classList.remove('hidden');
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.style.left = (x - rect.width) + 'px';
      }
      if (rect.bottom > window.innerHeight) {
        menu.style.top = (y - rect.height) + 'px';
      }
    });
  }

  hideAllContextMenus() {
    document.querySelectorAll('.context-menu').forEach(m => m.classList.add('hidden'));
    document.querySelectorAll('.dropdown-menu.submenu').forEach(m => m.classList.add('hidden'));
  }

  // ===== slash 命令面板（输入 / 触发的可插入语法快捷选择）=====
  // 按重度编辑用户的使用频率排序：高频块级语法置顶，结构化/边缘语法沉底；
  // 关键字含中/英/拼音以便过滤。上标/下标为纯 HTML 边缘标签，从面板移除（手写即可）。
  _buildSlashCommands() {
    if (this._slashCommands) return this._slashCommands;
    const base = [
      // 高频：标题骨架
      { action: 'insert-h1', label: '标题 1', hint: '#', keywords: ['h1', 'heading', 'title', 'biaoti', '1', 'yiji'] },
      { action: 'insert-h2', label: '标题 2', hint: '##', keywords: ['h2', 'heading', 'title', 'biaoti', '2', 'erji'] },
      { action: 'insert-h3', label: '标题 3', hint: '###', keywords: ['h3', 'heading', 'title', 'biaoti', '3', 'sanji'] },
      // 高频：列表与块级结构
      { action: 'insert-ul', label: '无序列表', hint: '-', keywords: ['ul', 'list', 'liebiao', 'wuxu', 'unordered'] },
      { action: 'insert-ol', label: '有序列表', hint: '1.', keywords: ['ol', 'list', 'liebiao', 'youxu', 'ordered'] },
      { action: 'insert-task', label: '任务列表', hint: '- [ ]', keywords: ['task', 'todo', 'renwu', 'checkbox', 'daiban'] },
      { action: 'insert-quote', label: '引用块', hint: '>', keywords: ['quote', 'yinyong'] },
      { action: 'insert-code-block', label: '代码块', hint: '```', keywords: ['code', 'block', 'daima', 'fence'] },
      { action: 'insert-table', label: '表格', hint: '| |', keywords: ['table', 'biaoge'] },
      // 高频：链接/图片/行内格式
      { action: 'insert-link', label: '链接', hint: '[]()', keywords: ['link', 'url', 'lianjie'] },
      { action: 'insert-image', label: '图片', hint: '![]()', keywords: ['image', 'img', 'tupian'] },
      { action: 'insert-bold', label: '加粗', hint: '**', keywords: ['bold', 'strong', 'jiacu'] },
      { action: 'insert-italic', label: '斜体', hint: '*', keywords: ['italic', 'xieti'] },
      { action: 'insert-inline-code', label: '行内代码', hint: '`', keywords: ['code', 'inline', 'daima', 'hangnei'] },
      // 中频：结构化文档
      { action: 'insert-hr', label: '水平线', hint: '---', keywords: ['hr', 'line', 'shuipingxian', 'fenge'] },
      { action: 'insert-toc', label: '目录 [TOC]', hint: '[TOC]', keywords: ['toc', 'contents', 'mulu'] },
      { action: 'insert-math-block', label: '数学公式', hint: '$$', keywords: ['math', 'formula', 'gongshi', 'tex', 'latex'] },
      { action: 'insert-mermaid', label: 'Mermaid 图表', hint: '```mermaid', keywords: ['mermaid', 'flow', 'liucheng', 'tu', 'chart'] },
      { action: 'insert-callout-note', label: 'Note 提示', hint: '> [!NOTE]', keywords: ['note', 'callout', 'tishi', 'prompt'] },
      { action: 'insert-callout-tip', label: 'Tip 建议', hint: '> [!TIP]', keywords: ['tip', 'callout', 'jianyi', 'suggestion'] },
      { action: 'insert-callout-warning', label: 'Warning 警告', hint: '> [!WARNING]', keywords: ['warning', 'callout', 'jinggao', 'alert'] },
      { action: 'insert-callout-important', label: 'Important 重要', hint: '> [!IMPORTANT]', keywords: ['important', 'callout', 'zhongyao'] },
      { action: 'insert-callout-caution', label: 'Caution 注意', hint: '> [!CAUTION]', keywords: ['caution', 'callout', 'zhuyi', 'notice'] },
      // 低频：偶用行内格式
      { action: 'insert-strikethrough', label: '删除线', hint: '~~', keywords: ['strikethrough', 'shanchuxian'] },
      { action: 'insert-highlight', label: '高亮', hint: '==', keywords: ['highlight', 'gaoliang', 'mark'] },
      // 低频：深层标题
      { action: 'insert-h4', label: '标题 4', hint: '####', keywords: ['h4', 'heading', 'title', 'biaoti', '4', 'siji'] },
      { action: 'insert-h5', label: '标题 5', hint: '#####', keywords: ['h5', 'heading', 'title', 'biaoti', '5', 'wuji'] },
      { action: 'insert-h6', label: '标题 6', hint: '######', keywords: ['h6', 'heading', 'title', 'biaoti', '6', 'liuji'] },
    ];
    this._slashBaseCatalog = base;
    this._slashCommands = this._applySlashLayout(base);
    return this._slashCommands;
  }

  // 按用户保存的 slashOrder 重排、slashHidden 过滤。
  // 新命令（不在 order 中）自动补到末尾，order 中的陈旧 id 忽略。纯函数式，便于测试。
  _applySlashLayout(catalog) {
    const order = this.settings.slashOrder || [];
    const hidden = new Set(this.settings.slashHidden || []);
    const byId = new Map();
    for (const c of catalog) byId.set(c.action, c);
    const seen = new Set();
    const out = [];
    for (const id of order) {
      const c = byId.get(id);
      if (c && !seen.has(id)) { out.push(c); seen.add(id); }
    }
    for (const c of catalog) if (!seen.has(c.action)) out.push(c);
    return out.filter((c) => !hidden.has(c.action));
  }

  // 输入 / 后在满足「行首或空格后」时触发；change.to 为输入后光标位置（/ 之后）
  _maybeTriggerSlash(cm, pos) {
    const line = cm.getLine(pos.line);
    if (!line || line[pos.ch - 1] !== '/') return;
    const prev = pos.ch > 1 ? line[pos.ch - 2] : '';
    // 仅行首（/ 位于索引 0）或 / 前为空白字符时触发，避免 and/or 等正文斜杠误触
    if (pos.ch !== 1 && !/\s/.test(prev)) return;
    this._openSlashPanel(pos);
  }

  _openSlashPanel(pos) {
    this._slashOpen = true;
    this._slashStart = { line: pos.line, ch: pos.ch - 1 }; // 记录 / 所在坐标
    this._slashQuery = '';
    this._slashSel = 0;
    this._renderSlashPanel();
  }

  // 面板开启时按光标位置重算 query；失焦/回退/换行列/含空格则关闭
  _updateSlashFromCursor() {
    const cur = this.cm.getCursor();
    if (!this._slashStart) { this._closeSlashPanel(); return; }
    if (cur.line !== this._slashStart.line) { this._closeSlashPanel(); return; }
    const line = this.cm.getLine(cur.line);
    if (!line || line[this._slashStart.ch] !== '/') { this._closeSlashPanel(); return; }
    if (cur.ch < this._slashStart.ch) { this._closeSlashPanel(); return; }
    const query = line.substring(this._slashStart.ch + 1, cur.ch);
    if (/\s/.test(query)) { this._closeSlashPanel(); return; } // 空格视为放弃，关闭面板
    this._slashQuery = query;
    this._slashSel = 0;
    this._renderSlashPanel();
  }

  _renderSlashPanel() {
    const q = this._slashQuery.trim().toLowerCase();
    const cmds = this._buildSlashCommands();
    const filtered = q === ''
      ? cmds
      : cmds.filter((c) => {
          if (c.label.toLowerCase().includes(q)) return true;
          return c.keywords.some((k) => k.toLowerCase().includes(q));
        });
    this._slashFiltered = filtered;
    if (filtered.length === 0) { this._closeSlashPanel(); return; }
    if (this._slashSel >= filtered.length) this._slashSel = 0;

    let panel = document.getElementById('slash-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'slash-panel';
      panel.className = 'slash-panel';
      document.body.appendChild(panel);
    }
    panel.innerHTML = '';
    filtered.forEach((c, i) => {
      const item = document.createElement('div');
      item.className = 'slash-item' + (i === this._slashSel ? ' selected' : '');
      item.dataset.idx = String(i);

      const label = document.createElement('span');
      label.className = 'slash-label';
      label.textContent = c.label;
      item.appendChild(label);

      if (c.hint) {
        const hintEl = document.createElement('span');
        hintEl.className = 'slash-hint';
        hintEl.textContent = c.hint;
        item.appendChild(hintEl);
      }

      // mousedown + preventDefault：避免编辑器失焦导致面板/光标错乱
      item.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        this._slashSel = i;
        this._slashConfirm();
      });
      item.addEventListener('mousemove', () => {
        if (this._slashSel !== i) {
          this._slashSel = i;
          this._renderSlashPanel();
        }
      });

      panel.appendChild(item);
    });

    // 面板底部「管理命令排序」入口：mousedown + preventDefault 保编辑器焦点，避免面板提前关闭
    const footer = document.createElement('div');
    footer.className = 'slash-footer';
    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'slash-manage-btn';
    manageBtn.textContent = '管理命令排序';
    manageBtn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.showSlashOrderDialog();
    });
    footer.appendChild(manageBtn);
    panel.appendChild(footer);

    // 定位到 / 光标处（window 坐标，配合 position:fixed）；无布局环境（如测试）下
    // cursorCoords 可能返回 null，跳过定位即可，不影响逻辑。
    const coords = this.cm.cursorCoords(this._slashStart, 'window');
    if (coords) {
      panel.style.left = coords.left + 'px';
      panel.style.top = (coords.bottom + 4) + 'px';
    }
    panel.classList.remove('hidden');
    const sel = panel.querySelector('.slash-item.selected');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }

  _slashMove(dir) {
    const n = this._slashFiltered ? this._slashFiltered.length : 0;
    if (n === 0) return;
    this._slashSel = (this._slashSel + dir + n) % n;
    this._renderSlashPanel();
    const panel = document.getElementById('slash-panel');
    const sel = panel && panel.querySelector('.slash-item.selected');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }

  _slashConfirm() {
    const cmd = this._slashFiltered && this._slashFiltered[this._slashSel];
    this._closeSlashPanel();
    if (!cmd) return;
    const from = { line: this._slashStart.line, ch: this._slashStart.ch }; // 含 /
    const to = this.cm.getCursor();
    this.cm.replaceRange('', from, to); // 删除 /query 文本，光标落到 / 之前
    this.executeMenuAction(cmd.action);
  }

  _closeSlashPanel() {
    this._slashOpen = false;
    this._slashQuery = '';
    this._slashSel = 0;
    this._slashFiltered = [];
    const panel = document.getElementById('slash-panel');
    if (panel) panel.classList.add('hidden');
  }

  // ===== slash 命令排序对话框（拖动排序 + 显隐）=====
  // 草稿独立于已保存设置，关闭/取消不污染设置；「完成」才写盘。
  showSlashOrderDialog() {
    // 打开排序对话框时先关掉可能还开着的 slash 面板
    this._closeSlashPanel();
    const baseIds = this._buildSlashBaseCatalogIds();
    // 草稿顺序：以已保存顺序为基准，补齐尚未持久化的新命令到末尾
    const saved = (this.settings.slashOrder && this.settings.slashOrder.length)
      ? this.settings.slashOrder.slice()
      : baseIds.slice();
    this._slashOrderDraft = saved.filter((id) => baseIds.includes(id));
    for (const id of baseIds) if (!this._slashOrderDraft.includes(id)) this._slashOrderDraft.push(id);
    // 默认隐藏 = 字体类（开关默认关闭），其余开关默认开启；已保存设置优先
    this._slashHiddenDraft = new Set(this.settings.slashHidden || DEFAULT_SLASH_HIDDEN);
    this._slashOrderOpen = true;
    this._renderSlashOrderList();
    const dlg = document.getElementById('slash-order-dialog');
    if (dlg) {
      const kp = dlg.querySelector('.dialog');
      if (kp && typeof window.resetDialog === 'function') window.resetDialog(kp);
      dlg.classList.remove('hidden');
    }
  }

  hideSlashOrderDialog() {
    this._slashOrderOpen = false;
    const dlg = document.getElementById('slash-order-dialog');
    if (dlg) dlg.classList.add('hidden');
  }

  // 写入设置并落盘；清 slash 命令缓存，下次输入 / 立即生效
  applySlashOrder() {
    this.settings.slashOrder = this._slashOrderDraft.slice();
    this.settings.slashHidden = [...this._slashHiddenDraft];
    this.saveSettings();
    this._slashCommands = null;
    this.hideSlashOrderDialog();
  }

  // 恢复默认：顺序回到内置默认序、字体类隐藏置底（其余默认显示）
  resetSlashOrder() {
    this._slashOrderDraft = this._buildSlashBaseCatalogIds();
    this._slashHiddenDraft = new Set(DEFAULT_SLASH_HIDDEN);
    this._renderSlashOrderList();
  }

  _buildSlashBaseCatalogIds() {
    // 与 _buildSlashCommands 的基础目录保持一致（仅取 action 顺序）。
    // 默认顺序：前置高频项 → 其余项（保持原相对顺序）→ 字体类置底（默认隐藏）。
    const all = [
      'insert-h1', 'insert-h2', 'insert-h3',
      'insert-ul', 'insert-ol', 'insert-task',
      'insert-quote', 'insert-code-block', 'insert-table',
      'insert-link', 'insert-image', 'insert-bold', 'insert-italic', 'insert-inline-code',
      'insert-hr', 'insert-toc', 'insert-math-block', 'insert-mermaid',
      'insert-callout-note', 'insert-callout-tip', 'insert-callout-warning', 'insert-callout-important', 'insert-callout-caution',
      'insert-strikethrough', 'insert-highlight',
      'insert-h4', 'insert-h5', 'insert-h6',
    ];
    const front = SLASH_FRONT_ACTIONS.filter((id) => all.includes(id));
    const font = SLASH_FONT_ACTIONS.filter((id) => all.includes(id));
    const middle = all.filter((id) => !front.includes(id) && !font.includes(id));
    return [...front, ...middle, ...font];
  }

  // 完整基础目录（含所有 28 项，供对话框渲染标签/hint，不受隐藏影响）
  _slashBaseCatalogFull() {
    if (!this._slashBaseCatalog) this._buildSlashCommands();
    return this._slashBaseCatalog;
  }

  _slashCatalogById(id) {
    return this._slashBaseCatalogFull().find((c) => c.action === id);
  }

  _renderSlashOrderList() {
    const list = document.getElementById('slash-order-list');
    if (!list) return;
    const full = this._slashBaseCatalogFull();
    const byId = new Map(full.map((c) => [c.action, c]));
    list.innerHTML = '';
    this._slashOrderDraft.forEach((id, idx) => {
      const cmd = byId.get(id);
      if (!cmd) return;
      const hidden = this._slashHiddenDraft.has(id);
      const row = document.createElement('div');
      row.className = 'slash-order-row' + (hidden ? ' hidden-cmd' : '');
      row.dataset.idx = String(idx);

      const handle = document.createElement('span');
      handle.className = 'slash-order-handle';
      handle.setAttribute('aria-hidden', 'true');
      handle.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" width="16" height="16"><circle cx="9" cy="5" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="9" cy="19" r="1.6"/><circle cx="15" cy="5" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="15" cy="19" r="1.6"/></svg>';

      const label = document.createElement('span');
      label.className = 'slash-order-label';
      label.textContent = cmd.label;

      const hint = document.createElement('span');
      hint.className = 'slash-order-hint';
      hint.textContent = cmd.hint || '';

      // 显隐开关：复用现有 .toggle / .toggle-slider
      const toggle = document.createElement('label');
      toggle.className = 'slash-order-toggle toggle';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !hidden;
      cb.addEventListener('change', () => {
        if (cb.checked) this._slashHiddenDraft.delete(id);
        else this._slashHiddenDraft.add(id);
        row.classList.toggle('hidden-cmd', !cb.checked);
      });
      const slider = document.createElement('span');
      slider.className = 'toggle-slider';
      toggle.appendChild(cb);
      toggle.appendChild(slider);

      row.appendChild(handle);
      row.appendChild(label);
      row.appendChild(hint);
      row.appendChild(toggle);

      handle.addEventListener('pointerdown', (e) => this._startSlashOrderDrag(e, idx, row));
      list.appendChild(row);
    });
  }

  // 指针事件拖拽重排（项目红线：页内拖拽用指针事件，不用 HTML5 DnD）。
// 交互模型（用户原话：「拖出来浮动跟着鼠标然后放回去到对应位置」）：
//   - mousedown in handle：克隆源行作为 ghost（position: fixed，跟手），源行加 dragging-source 视觉占位
//   - mousemove：ghost 跟随鼠标；用一条蓝色线（.slash-order-drop-line）精准指示"将插入到哪两项之间"
//   - mouseup：根据 ghost 中心 Y 计算目标位置，draft 一次性 splice + 重渲染；移除 ghost/占位/蓝线
// 中间态不重排 list（保持其他行原位，避免实时重排造成视觉抖动与索引混乱）。
  _startSlashOrderDrag(e, idx, row) {
    e.preventDefault();
    const list = document.getElementById('slash-order-list');
    if (!list) return;
    const rect = row.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const offsetX = startX - rect.left;
    const offsetY = startY - rect.top;
    const curIdx = idx;

    // 创建 ghost：克隆源行，position: fixed 跟手（Z 抬高、阴影制造浮动感、不响应鼠标）
    const ghost = row.cloneNode(true);
    ghost.classList.add('slash-order-ghost');
    ghost.style.cssText = `position:fixed !important;left:${rect.left}px !important;top:${rect.top}px !important;width:${rect.width}px !important;height:${rect.height}px !important;z-index:9999 !important;pointer-events:none !important;margin:0 !important;`;
    document.body.appendChild(ghost);

    // 源行：原位置视觉占位（半透明）+ 行高保留，避免落点计算时位置跳变
    row.classList.add('dragging-source');

    // 蓝色插入线：随鼠标在 list 内流动，精准指示插入缝隙（置于某行之前 = 插入到该行之前）
    const dropLine = document.createElement('div');
    dropLine.className = 'slash-order-drop-line';

    // 计算插入位置（visible 列表下标）：第一个「中心在光标之上」的行之前
    const computeVisualInsert = (centerY) => {
      const rows = Array.from(list.querySelectorAll('.slash-order-row:not(.dragging-source)'));
      for (let i = 0; i < rows.length; i++) {
        const tr = rows[i].getBoundingClientRect();
        if (centerY < tr.top + tr.height / 2) return i;
      }
      return rows.length;
    };

    const placeDropLine = (centerY) => {
      const rows = Array.from(list.querySelectorAll('.slash-order-row:not(.dragging-source)'));
      const v = computeVisualInsert(centerY);
      if (v >= rows.length) list.appendChild(dropLine);
      else list.insertBefore(dropLine, rows[v]);
    };

    // 统一参考点：拖拽全程用「ghost 中心 Y」判定插入位置（与用户看到的浮动项一致），
    // 蓝线放置与松手落点共用同一数值，保证「所见即所得」。
    let ghostCenterY = rect.top + rect.height / 2; // 初始：源行中心

    const onMove = (ev) => {
      ghost.style.left = (ev.clientX - offsetX) + 'px';
      ghost.style.top = (ev.clientY - offsetY) + 'px';
      ghostCenterY = (ev.clientY - offsetY) + rect.height / 2;
      placeDropLine(ghostCenterY);
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      const rows = Array.from(list.querySelectorAll('.slash-order-row:not(.dragging-source)'));
      let visualInsert = rows.length; // 默认末尾
      for (let i = 0; i < rows.length; i++) {
        const tr = rows[i].getBoundingClientRect();
        if (ghostCenterY < tr.top + tr.height / 2) { visualInsert = i; break; }
      }
      // 蓝线指示的 visible 下标即最终 draft 索引（移除 source 后按此下标插入），
      // 不再 +1——旧逻辑的 +1 会让落点落到蓝线所示位置的下一项。
      let targetDraftIdx = Math.max(0, Math.min(visualInsert, this._slashOrderDraft.length - 1));
      if (targetDraftIdx !== curIdx) {
        this._moveSlashOrderItem(curIdx, targetDraftIdx);
      }
      // 清理视觉状态并重渲染
      ghost.parentNode && ghost.parentNode.removeChild(ghost);
      if (dropLine.parentNode) dropLine.parentNode.removeChild(dropLine);
      list.querySelectorAll('.dragging-source').forEach(el => el.classList.remove('dragging-source'));
      this._renderSlashOrderList();
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  _moveSlashOrderItem(from, to) {
    const n = this._slashOrderDraft.length;
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return;
    const moved = this._slashOrderDraft.splice(from, 1)[0];
    this._slashOrderDraft.splice(to, 0, moved);
  }

  executeMenuAction(action) {
    switch (action) {
      case 'cut': { const s = this.cm.getSelection(); if (s) { navigator.clipboard.writeText(s); this.cm.replaceSelection(''); } this.cm.focus(); break; }
      case 'copy': { const s = this.cm.getSelection(); if (s) navigator.clipboard.writeText(s); this.cm.focus(); break; }
      case 'paste': { navigator.clipboard.readText().then(t => { if (t) this.cm.replaceSelection(t); }).catch(() => {}); this.cm.focus(); break; }
      case 'find-replace': this.toggleFindPanel(true); break;
      case 'select-all': this.cm.execCommand('selectAll'); break;

      case 'insert-bold': this.wrapSelection('**', '**'); break;
      case 'insert-italic': this.wrapSelection('*', '*'); break;
      case 'insert-strikethrough': this.wrapSelection('~~', '~~'); break;
      case 'insert-inline-code': this.wrapSelection('`', '`'); break;
      case 'insert-highlight': this.wrapSelection('==', '=='); break;
      case 'insert-superscript': this.wrapSelection('<sup>', '</sup>'); break;
      case 'insert-subscript': this.wrapSelection('<sub>', '</sub>'); break;

      case 'insert-h1': this.applyHeadingLevel(1); break;
      case 'insert-h2': this.applyHeadingLevel(2); break;
      case 'insert-h3': this.applyHeadingLevel(3); break;
      case 'insert-h4': this.applyHeadingLevel(4); break;
      case 'insert-h5': this.applyHeadingLevel(5); break;
      case 'insert-h6': this.applyHeadingLevel(6); break;

      case 'insert-code-block': this.insertBlock('```javascript\n// code here\n```', 14); break;
      case 'insert-table': this.insertBlock('| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |', 2); break;
      case 'insert-quote': this.insertLinePrefix('> '); break;
      case 'insert-math-block': this.insertBlock('$$\nE = mc^2\n$$', 3); break;
      case 'insert-mermaid': this.insertBlock('```mermaid\ngraph TD\n    A[开始] --> B[结束]\n```', 11); break;
      case 'insert-hr': this.insertBlock('---'); break;
      case 'insert-toc': this.insertBlock('[TOC]'); break;

      case 'insert-callout-note': this.insertBlock('> [!NOTE]\n> 提示内容', 12); break;
      case 'insert-callout-tip': this.insertBlock('> [!TIP]\n> 建议内容', 11); break;
      case 'insert-callout-warning': this.insertBlock('> [!WARNING]\n> 警告内容', 15); break;
      case 'insert-callout-caution': this.insertBlock('> [!CAUTION]\n> 注意内容', 15); break;
      case 'insert-callout-important': this.insertBlock('> [!IMPORTANT]\n> 重要内容', 17); break;

      case 'insert-ul': this.insertLinePrefix('- '); break;
      case 'insert-ol': this.insertLinePrefix('1. ', true); break;
      case 'insert-task': this.insertLinePrefix('- [ ] '); break;

      case 'insert-link': this.showInsertLinkDialog(); break;
      case 'insert-image': this.showInsertImageDialog(); break;

      case 'preview-copy': { const s = window.getSelection(); if (s && s.toString()) navigator.clipboard.writeText(s.toString()).catch(() => {}); break; }
      case 'preview-select-all': { const range = document.createRange(); range.selectNodeContents(this.preview); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); break; }
      case 'preview-copy-html': { const sel = window.getSelection(); if (sel.rangeCount > 0) { const range = sel.getRangeAt(0); const frag = range.cloneContents(); const div = document.createElement('div'); div.appendChild(frag); navigator.clipboard.writeText(div.innerHTML); } break; }
      case 'preview-find': this.toggleFindPanel(); break;

      case 'tab-close': this.closeTab(this._contextTabIndex); break;
      case 'tab-close-others': this.closeOtherTabs(this._contextTabIndex); break;
      case 'tab-close-all': this.closeAllTabs(); break;
      case 'tab-copy-path': this.copyTabPath(this._contextTabIndex); break;
      case 'tab-open-containing': this.openTabContainingFolder(this._contextTabIndex); break;

      case 'folder-open-containing': this.openContainingFolder(this._folderCtxPath, this._folderCtxIsDir); break;
      case 'folder-copy-path': this.copyPath(this._folderCtxPath); break;

      // 文件树右键菜单动作（合并自 PR #36）
      case 'file-new-file': this.fileTreeNewFile(); break;
      case 'file-new-folder': this.fileTreeNewFolder(); break;
      case 'file-cut': this.fileTreeCut(); break;
      case 'file-copy': this.fileTreeCopy(); break;
      case 'file-paste': this.fileTreePaste(); break;
      case 'file-rename': this.fileTreeRename(); break;
      case 'file-copy-path': this.fileTreeCopyPath(); break;
      case 'file-delete': this.fileTreeDelete(); break;
    }
  }

  async closeOtherTabs(keepIndex) {
    if (keepIndex < 0 || keepIndex >= this.tabs.length) return;
    const otherModified = this.tabs.filter((t, i) => i !== keepIndex && t.isModified);
    if (otherModified.length > 0) {
      const result = await this.showSaveDialog(
        this.t('saveChanges'),
        this.t('filesModifiedConfirm', { n: otherModified.length }),
        this.t('saveAll'), this.t('discardAll'), this.t('cancel')
      );
      if (result === 'cancel') return;
      if (result === 'save') {
        const ok = await this.batchSaveTabs(otherModified);
        if (!ok) return;
      } else {
        for (const tab of otherModified) {
          tab.content = tab.savedContent;
        }
        this.cm.setValue(this.activeTab.content);
        this.updateTabDisplay();
        this.updatePreview();
      }
    }
    const tab = this.tabs[keepIndex];
    this.tabs = [tab];
    this.activeTabIndex = 0;
    await this.ensureTabLoaded(tab);
    this.cm.setValue(tab.content || '');
    this.cm.setCursor(tab.cursorPos || { line: 0, ch: 0 });
    this.updateTabBar();
    this.updatePreview();
    this.saveSession();
  }

  async closeAllTabs() {
    const modified = this.tabs.filter(t => t.isModified);
    if (modified.length > 0) {
      const result = await this.showSaveDialog(
        this.t('saveChanges'),
        this.t('filesModifiedConfirm', { n: modified.length }),
        this.t('saveAll'), this.t('discardAll'), this.t('cancel')
      );
      if (result === 'cancel') return;
      if (result === 'save') {
        const ok = await this.batchSaveTabs(modified);
        if (!ok) return;
      }
    }
    this.tabs = [new Tab(`${this.t('untitled')}${this.untitledCounter++}`)];
    this.activeTabIndex = 0;
    this.cm.setValue('');
    this.updateTabBar();
    this.updatePreview();
    this.saveSession();
  }

  async copyPath(path) {
    if (!path) {
      this.setStatus(this.t('notSaved'));
      return;
    }
    try {
      await navigator.clipboard.writeText(path);
      this.setStatus(this.t('pathCopied'));
    } catch {
      this.setStatus(this.t('copyFailed'));
    }
  }

  async copyTabPath(index) {
    if (index < 0 || index >= this.tabs.length) return;
    const tab = this.tabs[index];
    if (!tab.filePath) {
      this.setStatus(this.t('notSaved'));
      return;
    }
    await this.copyPath(tab.filePath);
  }

  // 标签页右键「打开所在目录」：tab 均为文件（markdown），isDir=false，
  // 调用通用 openContainingFolder 打开父目录并选中该文件。
  async openTabContainingFolder(index) {
    if (index < 0 || index >= this.tabs.length) return;
    const tab = this.tabs[index];
    if (!tab.filePath) { this.setStatus(this.t('notSaved')); return; }
    await this.openContainingFolder(tab.filePath, false);
  }

  // 在系统文件管理器中「打开所在目录」：文件→打开父目录并选中文件，目录→打开并选中自身。
  // 主路径 = Rust reveal_in_folder 命令（直接 spawn 系统文件管理器，不受 shell 插件 scope 限制，最可靠，
  //   且能「选中」目标文件）；兜底 = shell.open(dir)（需 capability 放行本地路径，链接同理走此通道）。
  // 注意：shell.open 对文件夹默认被 scope 拒绝，必须由 capability 显式允许本地路径，否则静默失败。
  async openContainingFolder(path, isDir) {
    if (!path) { console.error('[openFolder] path 为空'); this.setStatus(this.t('openFolderFailed')); return; }
    // 去掉 Windows 长路径前缀 \\?\（explorer / shell 都不认，会导致静默失败）。
    const stripLong = (p) => (p && p.startsWith('\\\\?\\')) ? p.slice(4) : p;
    const normPath = stripLong(path);
    // 目录本身，或文件取其父目录
    const dir = stripLong(isDir ? path : path.replace(/[/\\][^/\\]*$/, ''));
    if (!dir) { console.error('[openFolder] dir 为空, path=', path); this.setStatus(this.t('openFolderFailed')); return; }
    console.log('[openFolder] 目标 dir=', dir, ' normPath=', normPath, ' isDir=', !!isDir, ' Tauri可用=', TauriApi.isAvailable());

    // 1) 主路径：Rust 命令直接 spawn 文件管理器（能选中目标文件，最可靠）。
    if (TauriApi.isAvailable()) {
      try {
        // 注意：Tauri v2 invoke 参数名 JS 侧必须 camelCase（Rust 侧 is_dir ↔ JS 侧 isDir）
        await TauriApi.revealInFolder({ path: normPath, isDir: !!isDir });
        console.log('[openFolder] reveal_in_folder 调用成功，已请求打开资源管理器');
        return;
      } catch (e) {
        console.error('[openFolder] reveal_in_folder 失败:', e && e.message ? e.message : String(e));
      }
    } else {
      console.error('[openFolder] TauriApi.isAvailable()=false，跳过 reveal_in_folder');
    }

    // 2) 兜底：shell.open 打开所在目录（capability 已放行本地路径）。
    let dirOpened = false;
    if (TauriApi.shellOpen) {
      try { dirOpened = await TauriApi.shellOpen(dir); } catch (e) { console.error('[openFolder] shell.open 异常:', e); dirOpened = false; }
      console.log('[openFolder] shell.open 结果=', dirOpened);
    } else {
      console.error('[openFolder] shellOpen 不可用');
    }
    if (dirOpened) return;

    this.setStatus(this.t('openFolderFailed'));
  }

  async batchSaveTabs(tabs) {
    for (const tab of tabs) {
      if (!tab.isModified) continue;
      try {
        if (!tab.filePath) {
          const path = await dialogSave({
            filters: [
              { name: 'Markdown', extensions: ['md'] },
              { name: this.t('allFiles'), extensions: ['*'] }
            ]
          });
          if (!path) return false;
          tab.filePath = path;
          tab.name = path.split(/[/\\]/).pop();
        }
        await TauriApi.writeFile({ path: tab.filePath, content: tab.content });
        tab.savedContent = tab.content;
        await this.refreshFileMeta(tab);
      } catch (error) {
        this.setStatus(`${this.t('saveFailed')}: ${error}`);
        return false;
      }
    }
    return true;
  }

  async handleAppClose() {
    try {
      const appWindow = TauriApi.currentWindow();
      // 1. 处理未保存文档
      const modified = this.tabs.filter(t => t.isModified);
      if (modified.length > 0) {
        const result = await this.showSaveDialog(
          this.t('saveChanges'),
          this.t('filesModifiedConfirm', { n: modified.length }),
          this.t('saveAll'), this.t('discardAll'), this.t('cancel')
        );
        if (result === 'cancel') return;
        if (result === 'save') {
          const ok = await this.batchSaveTabs(modified);
          if (!ok) return;
        } else {
          for (const tab of modified) {
            tab.content = tab.savedContent;
          }
          const remaining = this.tabs.filter(t => t.filePath || t.content !== '');
          if (remaining.length === 0) {
            this.tabs.length = 0;
            this.tabs.push(new Tab(`${this.t('untitled')}${this.untitledCounter++}`));
            this.activeTabIndex = 0;
          } else {
            this.tabs = remaining;
            if (this.activeTabIndex >= this.tabs.length) {
              this.activeTabIndex = this.tabs.length - 1;
            }
          }
          this.cm.setValue(this.activeTab.content);
          this.updateTabBar();
          this.updatePreview();
        }
      }
      // 2. 保存会话
      this.saveSession();
      // 3. 按用户偏好执行关闭行为
      const action = await this._resolveCloseAction();
      if (!action) return; // 用户在弹框点了取消
      if (action === 'quit') {
        await TauriApi.quitApp();
      } else {
        await appWindow.hide();
      }
    } catch (error) {
      console.error('handleAppClose error:', error);
      try {
        const w = TauriApi.currentWindow();
        if (w) await w.hide();
      } catch { /* 浏览器环境下降级 */ }
    }
  }

  async hideToTray() {
    // 快捷键「关闭到托盘」：仅把窗口隐藏到系统托盘，应用进程与文档保留在内存中，
    // 因此不会丢失未保存内容；下次从托盘图标恢复窗口即可继续编辑。
    try {
      this.saveSession();
      const w = TauriApi.currentWindow();
      if (w) await w.hide();
    } catch (error) {
      console.error('hideToTray error:', error);
      try {
        const w = TauriApi.currentWindow();
        if (w) await w.hide();
      } catch { /* 浏览器环境下降级 */ }
    }
  }

  async _resolveCloseAction() {
    const action = this.settings.closeAction || 'ask';
    if (action === 'quit') return 'quit';
    if (action === 'minimize') return 'minimize';
    // ask — 弹出确认对话框
    const result = await Dialogs.showCloseDialog({
      t: (k, p) => this.t(k, p),
      doc: document,
    });
    if (!result) return null; // cancelled
    if (result.remember) {
      this.settings.closeAction = result.action;
      this.saveSettings();
    }
    return result.action;
  }

  initFormatToolbar() {
    // 格式工具栏：直接按钮 + 复合下拉（悬停展开），折叠状态持久化
    const fmtToolbar = document.getElementById('format-toolbar');
    if (fmtToolbar) {
      fmtToolbar.classList.toggle('collapsed', !!this.settings.toolbarCollapsed);
      fmtToolbar.querySelectorAll('[data-action]').forEach(item => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.executeMenuAction(item.dataset.action);
          // 点击菜单项后关闭弹出菜单：强制隐藏，直到鼠标移出下拉区再恢复 hover 展开
          const menu = item.closest('.dropdown-menu');
          if (menu) menu.classList.add('force-hide');
        });
      });
      // 鼠标移出下拉区后清除强制隐藏，恢复 hover 展开能力
      fmtToolbar.querySelectorAll('.fmt-dropdown').forEach(dd => {
        dd.addEventListener('mouseleave', () => {
          const m = dd.querySelector('.dropdown-menu');
          if (m) m.classList.remove('force-hide');
        });
      });
      const fmtCollapse = document.getElementById('fmt-collapse');
      if (fmtCollapse) {
        fmtCollapse.addEventListener('click', (e) => {
          e.stopPropagation();
          this.settings.toolbarCollapsed = !this.settings.toolbarCollapsed;
          fmtToolbar.classList.toggle('collapsed', this.settings.toolbarCollapsed);
          const lbl = fmtCollapse.querySelector('.fmt-toggle-label');
          if (lbl) lbl.textContent = this.settings.toolbarCollapsed ? this.t('expandToolbar') : this.t('collapseToolbar');
          this.saveSettings();
        });
      }
    }
  }

  // ========== 标签栏滚动 ==========

  initTabScroll() {
    this.scrollContainer = document.getElementById('tab-bar-scroll');
    this.scrollLeftBtn = document.getElementById('tab-scroll-left');
    this.scrollRightBtn = document.getElementById('tab-scroll-right');

    if (!this.scrollContainer) return;

    const updateArrows = () => {
      const maxScroll = this.scrollContainer.scrollWidth - this.scrollContainer.clientWidth;
      if (maxScroll <= 1) {
        this.scrollLeftBtn.classList.add('hidden');
        this.scrollRightBtn.classList.add('hidden');
      } else {
        this.scrollLeftBtn.classList.toggle('hidden', this.scrollContainer.scrollLeft <= 1);
        this.scrollRightBtn.classList.toggle('hidden', this.scrollContainer.scrollLeft >= maxScroll - 1);
      }
    };

    this.scrollContainer.addEventListener('scroll', updateArrows, { passive: true });

    this.scrollContainer.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        this.scrollContainer.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });

    this.scrollLeftBtn.addEventListener('click', () => {
      this.scrollContainer.scrollBy({ left: -200, behavior: 'auto' });
    });

    this.scrollRightBtn.addEventListener('click', () => {
      this.scrollContainer.scrollBy({ left: 200, behavior: 'auto' });
    });

    // Update arrows after tab bar changes or window resize
    const observer = new ResizeObserver(updateArrows);
    observer.observe(this.scrollContainer);

    // Also observe the tab bar itself for changes when tabs are added/removed
    const tabBar = document.getElementById('tab-bar');
    if (tabBar) {
      const tabObserver = new ResizeObserver(updateArrows);
      tabObserver.observe(tabBar);
    }

    // Store updateArrows for external calls (e.g. after updateTabBar)
    this.updateTabScrollArrows = updateArrows;
  }
}

function updateLoadingProgress(percent, text) {
  document.getElementById('loading-progress-fill').style.width = Math.min(100, Math.max(0, percent)) + '%';
  const textEl = document.getElementById('loading-text');
  if (textEl && text) textEl.textContent = text;
}

// 初始化阶段（window.editor 未创建）读取当前语言：settings 尚未加载，直接从持久化读
function tInit(key) {
  let lang = 'zh';
  try {
    const saved = JSON.parse(localStorage.getItem('tizumark-settings') || '{}');
    if (saved && saved.language === 'en') lang = 'en';
  } catch (_) {}
  return I18N[lang][key] !== undefined ? I18N[lang][key] : I18N.zh[key] || key;
}

function initEula() {
  const eulaAccepted = localStorage.getItem('tizumark-eula-accepted');
  if (eulaAccepted === 'true') {
    document.getElementById('eula-dialog').classList.add('hidden');
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const overlay = document.getElementById('eula-dialog');
    const acceptBtn = document.getElementById('eula-accept');

    overlay.classList.remove('hidden');

    const autoAccept = () => {
      localStorage.setItem('tizumark-eula-accepted', 'true');
      overlay.classList.add('hidden');
      console.warn('EULA auto-accepted after timeout');
      resolve(true);
    };

    const autoTimer = setTimeout(autoAccept, 20000);

    const gplLink = overlay.querySelector('.gpl-link');
    if (gplLink) {
      gplLink.addEventListener('click', (e) => {
        e.preventDefault();
        window.open('https://www.gnu.org/licenses/gpl-3.0.html', '_blank');
      });
    }

    acceptBtn.addEventListener('click', () => {
      clearTimeout(autoTimer);
      localStorage.setItem('tizumark-eula-accepted', 'true');
      overlay.classList.add('hidden');
      resolve(true);
    });
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  // 防重入：DOMContentLoaded 只允许初始化一次（jsdom 测试环境会自然触发 + 手动派发各一次，
  // 双重初始化会重复注册 file-open/drag-drop 等监听，导致确认框弹两次等问题）
  if (window.__tizumarkInited) return;
  window.__tizumarkInited = true;
  // 安全兜底：20 秒后强制隐藏加载遮罩，防止任何异常导致卡死
  const loadingSafetyTimer = setTimeout(() => {
    const overlay = document.getElementById('loading-overlay');
    if (overlay && !overlay.classList.contains('hidden')) {
      overlay.classList.add('hidden');
      console.warn('Loading overlay force-hidden by safety timeout (20s)');
    }
  }, 20000);

  try {
    updateLoadingProgress(5, tInit('progressCheckingEula'));
    const isFirstLaunch = await initEula();

    updateLoadingProgress(15, tInit('progressInitEditor'));
    window.editor = new MarkdownEditor();
    window.editor._loadingStart = Date.now();

    updateLoadingProgress(60, tInit('progressRegisterEvents'));
    // 代码块按需滚动：preview 出现/替换 .code-scroll 时自动跑后处理（rAF 去抖）。
    // LiveReload 推新 JS 后已渲染的代码块不会重新触发 render，单靠 render 末尾调用
    // 会漏掉；MutationObserver 兜底所有时机（含初次加载、async 替换、LiveReload 后）。
    const pruneCodeScrolls = () => {
      if (!window.editor || !window.editor.preview) return;
      window.editor.preview.querySelectorAll('.code-scroll').forEach((el) => {
        // 必须显式 'auto'：CSS 默认是 hidden（防 Windows always-show 滚动条轨道），
        // 清空 inline 会让 CSS 接管 → 仍 hidden → 永远没滚动条
        el.style.overflowY = el.scrollHeight > el.clientHeight + 1 ? 'auto' : 'hidden';
      });
    };
    new MutationObserver(() => requestAnimationFrame(pruneCodeScrolls))
      .observe(window.editor.preview, { childList: true, subtree: true });
    await TauriApi.onEvent('close-requested', async () => {
      await window.editor.handleAppClose();
    });

    // 工作区目录树随外部文件增删自动刷新（由 Rust watch_folder 广播 folder-changed 事件）
    await TauriApi.onEvent('folder-changed', () => {
      if (window.editor) window.editor._scheduleTreeRefresh();
    });

    // 文件夹监听异常（Rust watch_folder 回调 panic，已由 catch_unwind 兜住监听不中断）：
    // 弹窗提示用户手动「重新监听 / 继续使用」——不做自动重挂，避免失败风暴
    await TauriApi.onEvent('folder-watch-error', (event) => {
      if (window.editor) window.editor._handleFolderWatchError(event);
    });

    await TauriApi.onEvent('file-open', async (event) => {
      const args = event.payload;
      if (!args || args.length === 0) return;

      try {
        const w = TauriApi.currentWindow();
        await w.unminimize();
        await w.show();
        await w.setFocus();
      } catch (_) {}

      // 二次实例传参：目录进工作区（已有不同工作区时弹确认），文件开 tab。
      // 注意：不要在此先 showLoading——加载遮罩 z-index(10000) 会盖住确认框，
      // 导致切换工作区确认框点不到而卡在加载页；加载由 openFolderPath 内部负责。
      await window.editor.openPathsSmart(args);
    });

    updateLoadingProgress(85, tInit('progressLoadingFile'));
    try {
      const args = await TauriApi.getCliArgs();
      const hadSession = await window.editor.restoreSession();
      let currentVersion = '';
      if (args && args.length > 0) {
        // 启动 CLI 参数：命令行显式指定目录，直接作为工作区打开（不弹确认）
        await window.editor.openPathsSmart(args, { confirmWorkspaceSwitch: false });
      } else {
        // 首次安装 / 升级后首次打开：自动展示使用说明和 demo.md
        const lastVersion = localStorage.getItem('tizumark-app-version');
        try {
          currentVersion = await TauriApi.getVersion();
        } catch (_) { /* fallback 到静默跳过 */ }
        if (isFirstLaunch || (currentVersion && lastVersion !== currentVersion)) {
          window.editor.openUserGuide();
          // 同步打开 demo.md（使用说明内嵌的 demo.md 链接已可手动点开，
          // 此处自动打开省去用户多一步点击）
          try {
            const result = await TauriApi.readBundledFile({ filename: 'demo.md' });
            const demoContent = result && typeof result === 'object' ? result.content : result;
            const demoPath = result && typeof result === 'object' ? result.path : 'demo.md';
            if (demoContent && !demoContent.trim().startsWith('<!DOCTYPE') && !demoContent.trim().startsWith('<html')) {
              await window.editor._openBundledFile('demo.md', demoContent, demoPath);
            }
          } catch (_) {
            // demo.md 读取失败不影响主功能
          }
        }
      }
      // 持久化当前应用版本，供下次启动比对
      if (currentVersion) {
        localStorage.setItem('tizumark-app-version', currentVersion);
      }
    } catch (e) {
      console.warn('Failed to load session / cli args:', e);
    }

    updateLoadingProgress(100, tInit('progressReady'));
    await window.editor.initFileWatcher();
    await new Promise(r => setTimeout(r, 300));
  } catch (e) {
    console.error('Initialization error:', e);
    // 初始化异常对用户可见（否则整页空白无提示）；toast:false 避免依赖尚未就绪的 UI，改用页面顶部错误条
    try {
      if (window.editor && window.editor.reportError) {
        window.editor.reportError('E_INIT', { error: e, toast: false });
      }
      const bar = document.createElement('div');
      bar.className = 'fatal-error-bar';
      bar.textContent = '编辑器初始化失败，请重启应用。如反复出现，请将此界面截图反馈给开发者。';
      // 固定底部条，不遮挡 Tauri 标题栏/窗口控制按钮/工具栏菜单
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:100000;' +
        'background:#b00020;color:#fff;font:12px/1.5 system-ui,-apple-system,sans-serif;' +
        'padding:8px 14px;box-shadow:0 -2px 6px rgba(0,0,0,.25);';
      document.body.appendChild(bar);
    } catch (_) {}
  } finally {
    clearTimeout(loadingSafetyTimer);
    window.editor?.hideLoading();
  }
});
