// 渲染后处理共享管线（RenderPost）：阅读模式与所见即所得的**唯一共享后处理入口**。
//
// 背景（2026-10-11 用户反馈四缺陷）：目录不加载 / 图片不加载 / 长代码不能滚动 / 图表不加载。
// 根因都是「两种模式的渲染后处理逻辑分叉」：阅读模式整篇一次过（preview-controller.render），
// 所见即所得按遮罩块补跑（wysiwyg.js），两处曾各写一份、逐渐漂移（codeScroll 条件写反、
// TOC 只取第一个 <p>、mermaid 容器 id 并发碰撞……）。本文件起，具体后处理步骤统一在此，
// 两种模式只允许存在**编排时序**差异：
//   - 阅读模式：整篇单遍（图片/mermaid 的 await 位置由 render() 自己决定，含代际检查）；
//   - 所见即所得：同步链在遮罩节点建好时跑，异步链在 DOM 落定后由 flush 补跑。
//
// [TOC] 不经过本管线：它依赖整篇内容（Rust generate_toc）——阅读模式做整篇级替换
// （preview-controller.render 的正则替换），所见即所得做逐节点替换（wysiwyg.js _wysiwygReplaceToc），
// 两者共用同一 Rust 函数与同一 toc-wrapper 结构。
//
// 契约：
//   - 所有 stage 故障隔离（单步失败不中断链条，静默降级保持原文）；
//   - 所有 stage 幂等（同一节点重复跑安全：KaTeX 已渲染的节点被 walker 跳过、
//     已换容器的 mermaid 无 code 可查、已加载图片走前缀跳过、已包裹的 code-scroll 被跳过）；
//   - stage 函数不持有任何模式相关状态；模式差异一律由参数注入（opts / deps / ctx）。
(function () {
  'use strict';

  const optFn = (fn, fallback) => ((typeof fn === 'function') ? fn : fallback);

  const RenderPost = {
    // ---------- 同步 stages ----------

    // details 展开：预览中折叠块默认全展开（阅读 render() 与遮罩同步 pass 同款）
    normalizeDetails(container) {
      if (!container || !container.querySelectorAll) return;
      try {
        container.querySelectorAll('details:not([open])').forEach((el) => { el.open = true; });
      } catch (_) { /* 展开失败不阻断 */ }
    },

    // 任务列表复选框：remark-gfm 默认输出 disabled，渲染后移除才能点击切换（两模式同款）
    enableCheckboxes(container) {
      if (!container || !container.querySelectorAll) return;
      try {
        container.querySelectorAll('input[type="checkbox"][disabled]')
          .forEach((cb) => cb.removeAttribute('disabled'));
      } catch (_) { /* 失败不阻断 */ }
    },

    // emoji 短码还原（失败保持短码原文）
    processEmoji(container) {
      try {
        if (typeof PreviewPost !== 'undefined' && typeof PreviewPost.processEmojiShortcodes === 'function') {
          PreviewPost.processEmojiShortcodes(container);
        }
      } catch (e) { console.warn('[render-post] Emoji error:', e); }
    },

    // 公式渲染（失败保持原始 $$ 源码）
    processMath(container) {
      try {
        if (typeof PreviewPost !== 'undefined' && typeof PreviewPost.processMath === 'function') {
          PreviewPost.processMath(container);
        }
      } catch (e) { console.warn('[render-post] Math error:', e); }
    },

    // 缩写还原（opts: t/isDark/escapeHtml/escapeAttr/headingToId）
    processAbbreviations(container, opts) {
      try {
        if (typeof PreviewPost !== 'undefined' && typeof PreviewPost.processAbbreviations === 'function') {
          PreviewPost.processAbbreviations(container, opts);
        }
      } catch (e) { console.warn('[render-post] Abbr error:', e); }
    },

    // 标题锚点 id（两模式同源 headingToId，# 锚点 / 交叉引用 / TOC 链接才可互达）
    processHeadings(container, opts) {
      try {
        if (typeof PreviewPost !== 'undefined' && typeof PreviewPost.processHeadings === 'function') {
          PreviewPost.processHeadings(container, opts);
        }
      } catch (e) { console.warn('[render-post] Headings error:', e); }
    },

    // 代码块复制按钮（必须在代码高亮之前跑，按钮才落在 pre 上）
    addCopyButtons(container, opts) {
      try {
        if (typeof PreviewPost !== 'undefined' && typeof PreviewPost.addCopyButtons === 'function') {
          PreviewPost.addCopyButtons(container, opts);
        }
      } catch (e) { console.warn('[render-post] Copy btn error:', e); }
    },

    // 代码高亮 + 行号（opts: { hljs, cache, lineNumbers }）
    processCodeBlocks(container, opts) {
      try {
        if (typeof CodeBlock === 'undefined' || typeof CodeBlock.processCodeBlocks !== 'function') return;
        CodeBlock.processCodeBlocks(container, {
          hljs: opts && opts.hljs,
          cache: (opts && opts.cache) || new Map(),
          lineNumbers: !!(opts && opts.lineNumbers),
        });
      } catch (e) { console.warn('[render-post] Code block error:', e); }
    },

    // ---------- 异步 stages ----------

    // 图片读盘 → base64（与阅读模式同一 ImageProcessor 纯函数、同一缓存）。
    // deps: { activeTab, imageCache, tauri, getCachedImageURL, getRenderGeneration }
    // 无 Tauri 运行时（纯浏览器环境）或容器内无 img 时直接返回已 resolve 的 promise。
    prepareImages(container, deps) {
      if (typeof ImageProcessor === 'undefined' || typeof ImageProcessor.processImages !== 'function') {
        return Promise.resolve();
      }
      if (!container || !container.querySelector || !container.querySelector('img')) return Promise.resolve();
      if (!deps || !deps.tauri) return Promise.resolve();
      try {
        return ImageProcessor.processImages(container, {
          activeTab: deps.activeTab,
          imageCache: deps.imageCache,
          tauri: deps.tauri,
          getCachedImageURL: optFn(deps.getCachedImageURL, (u) => u),
          getRenderGeneration: optFn(deps.getRenderGeneration, () => 0),
        });
      } catch (e) {
        return Promise.reject(e);
      }
    },

    // Mermaid 渲染（opts: t/isDark/escapeHtml/escapeAttr/headingToId/mermaidCache）。
    // 串行化与容器 id 唯一化在 processMermaid 内部（mermaid v11 内部 id 以 Date.now() 计，
    // 同毫秒并发 run() 会碰撞；详见 preview-post.js 注释）。
    runMermaid(container, opts) {
      if (typeof PreviewPost === 'undefined' || typeof PreviewPost.processMermaid !== 'function') {
        return Promise.resolve();
      }
      try {
        return Promise.resolve(PreviewPost.processMermaid(container, opts));
      } catch (e) {
        return Promise.reject(e);
      }
    },

    // 代码块按需滚动条（**条件唯一来源**）：「代码块滚动条」设置开启（codeScroll !== false）时，
    // 仅对真正超出 max-height 的块设 overflowY=auto（显式 auto 覆盖 CSS 的 hidden；
    // 不能清空让 CSS 接管——CSS 已是 hidden，清空后还是 hidden）；
    // 关闭时由 .code-no-scroll 类接管（max-height:none 高度自适应，永不滚动）。
    // 注：所见即所得曾手抄该条件且写反（=== false）：默认开启时长代码被 300px 裁掉且无
    // 滚动条（2026-10-11 用户反馈）——两模式从此共用本函数，不再各写一份。
    applyCodeScrollOverflow(container, ctx) {
      if (!container || !container.querySelectorAll) return;
      if (ctx && ctx.codeScroll === false) return;
      container.querySelectorAll('.code-scroll').forEach((el) => {
        el.style.overflowY = el.scrollHeight > el.clientHeight + 1 ? 'auto' : 'hidden';
      });
    },
  };

  // 互斥式导出：浏览器 <script> 挂 window，node require 走 module.exports。
  if (typeof window !== 'undefined' && typeof module === 'undefined') {
    window.RenderPost = RenderPost;
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = RenderPost;
  }
})();
