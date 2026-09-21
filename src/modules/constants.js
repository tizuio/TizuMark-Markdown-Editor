// 共享基础层：常量、数据模型与平台桥接。
// 本文件必须在其它业务模块之前加载（index.html 中排在 tauri-api.js 之后；
// 测试 harness 通过 PRIORITY_MODULES 保证顺序）。
//
// 为什么必须显式共享：生产环境用 <script> 加载时，app.js 的顶层 const 会进入全局词法环境，
// 其它脚本「碰巧」能访问；但测试 harness 用 w.eval(appjs) 加载，eval 里的 const 不会泄漏到
// 全局 —— 两边行为不一致。集中到本模块后，消费方一律显式取值，不再依赖加载顺序的巧合。
(function () {
  'use strict';

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

  // PDF 导出的中文字体尾链（TrueType 优先）：
  // 打印帧若让系统自行回退，中文会落到 Noto Sans SC 等 CFF 轮廓字体，Skia 转 PDF 时会
  // 退化成 Type3（位图化）字体 —— 体积暴涨且文字不可选中/搜索。这里显式钉 TrueType 中文字体。
  // 只作尾链（放在用户字体之后），不覆盖用户的预览字体选择。
  const EXPORT_CJK_FONT_TAIL = '"Microsoft YaHei", "微软雅黑", "DengXian", "SimSun", "NSimSun"';
  // 用户未设置预览字体时的拉丁兜底链（与 styles.css 中 --font-preview 默认值保持一致）
  const EXPORT_FALLBACK_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial';
  // 归一映射（小写中文名/变体名 → 主族英文 value）：
  // ① 把枚举返回的中文名条目（微软雅黑/宋体…）归一为英文 value，与英文条目合并去重；
  // ② 视觉一致的变体（微软雅黑 UI 中文名同为「微软雅黑」）合并进主族，避免下拉重复。
  const FONT_LOCALE_REV = new Map([
    ...Object.entries(FONT_NAME_LOCALE).map(([en, zh]) => [zh.toLowerCase(), en]),
    ['microsoft yahei ui', 'Microsoft YaHei'],
  ]);

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

  // Tauri 对话框桥接：tauriApi.dialogOpen 内部已包一层 { options }（Tauri dialog 插件约定
  // 底层的 IPC 命令 'plugin:dialog|open' 收 { options }），这里必须透传，
  // 不能再包一层——否则双重嵌套会让 Rust 侧解析不到参数。
  async function dialogOpen(options = {}) {
    return await TauriApi.dialogOpen(options);
  }

  async function dialogSave(options = {}) {
    return await TauriApi.dialogSave(options);
  }

  const api = {
    MAX_PREVIEW_LINES,
    MAX_PREVIEW_CHARS,
    HEAD_RENDER_CHAR_CAP,
    PREVIEW_WINDOW_LINES,
    PREVIEW_WINDOW_LEAD,
    SLASH_FONT_ACTIONS,
    SLASH_FRONT_ACTIONS,
    DEFAULT_SLASH_HIDDEN,
    SYSTEM_FONT_WHITELIST,
    SYSTEM_FONT_WHITELIST_SET,
    FONT_NAME_LOCALE,
    EXPORT_CJK_FONT_TAIL,
    EXPORT_FALLBACK_SANS,
    FONT_LOCALE_REV,
    Tab,
    dialogOpen,
    dialogSave,
  };

  window.TMConst = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
