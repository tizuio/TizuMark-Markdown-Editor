// 导出 HTML / Word / PDF / 图片
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';
  const { dialogSave } = TMConst;

  // 网络资源超时：外链图 522 / 挂起时不能拖住整条导出链（_inlineImagesForExport 用
  // Promise.allSettled 等最慢的一张，一挂就是「遮罩撤了、文件没写」）。
  const REMOTE_IMAGE_TIMEOUT_MS = 8000;
  const EXPORT_FRAME_TIMEOUT_MS = 200;
  const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
  // Rust 的 fetch_image_as_base64 只返回纯 base64、不带 Content-Type；按 URL 扩展名猜会把
  // picsum.photos/800/400 这类无扩展名的 JPEG 误标成 PNG。改按图片头 magic bytes 判定，
  // 顺带把「后端返回了非图片内容（错误页/空串）」挡掉，避免把垃圾内联进文档。
  const mimeFromBase64 = (b64) => {
    try {
      const head = atob(String(b64).slice(0, 24));
      const c = (i) => head.charCodeAt(i);
      if (c(0) === 0xff && c(1) === 0xd8 && c(2) === 0xff) return 'image/jpeg';
      if (head.slice(0, 3) === 'GIF') return 'image/gif';
      if (head.slice(0, 2) === 'BM') return 'image/bmp';
      if (c(0) === 0x89 && head.slice(1, 4) === 'PNG') return 'image/png';
      if (head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WEBP') return 'image/webp';
      if (/^\s*(<svg|<\?xml)/i.test(head)) return 'image/svg+xml';
    } catch (_e) { /* 非法 base64 / 非图片内容 */ }
    return null;
  };
  // 可选步骤隔离：图片内联、DOM 预处理、样式采集这类「增强」任一失败/挂起，都只跳过自己，
  // 绝不让整份文档导不出来。带独立超时，防止某个 await 永不 settle 把导出拖死。
  const OPTIONAL_STEP_TIMEOUT_MS = 15000;
  // Word 图片宽度上限（CSS px）：小图按原显示尺寸，大图等比缩到此值。
  // 页面可用宽度更小时由 _docxPageConfig() 取较小值传给 docx-builder 做最终钳位。
  const WORD_IMG_MAX_PX = 500;
  const safeStep = async (label, fn, ms) => {
    try {
      return await withTimeout(Promise.resolve().then(fn), ms || OPTIONAL_STEP_TIMEOUT_MS);
    } catch (e) {
      console.warn(`[export] 可选步骤「${label}」失败或超时，已跳过：`, e && e.message ? e.message : e);
      return null;
    }
  };

  const mixin = {
      // 导出时把预览里的图片全部内联为 base64 data URI，使导出文档自包含、不受运行时
      // blob: 回收 / 源解析影响（同源 srcdoc 打印帧在 PDF 导出、外部打开在 HTML 导出都适用）。
      // 分支：blob:→fetch 还原；file://→Rust 读盘；相对路径→按文档目录 Rust 读盘；data:/http(s): 保留。
      //
      // 2026-10-25：未保存文档（无 filePath）不再整体早退 —— blob:/http(s): 两条分支不依赖
      // 文档目录，照样要内联。长图（SVG foreignObject）尤其需要：SVG-as-image 无法访问 blob:，
      // 留着原 url 的图片在成图里就是空白。只有「相对路径」分支确实需要 dir，那里单独判断。
      async _inlineImagesForExport(clone, filePath) {
        const dir = filePath ? filePath.replace(/[/\\][^/\\]*$/, '') : '';
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
          // 已内联（data:）资源直接保留
          if (src.startsWith('data:')) return;
          try {
            let dataUri = null;
            if (src.startsWith('blob:')) {
              // 预览里 img.src 已被 processImages 经 getCachedImageURL 缓存成 blob: URL，
              // 导出时必须还原为内联 base64。优先 fetch(blob:)（同源可读）；
              // fetch 失败（CSP 拦截 / blob 已被 LRU 回收）时，从 _imageURLCache
              // （dataUri→blobUrl 映射）反查原始 data URI 兜底，保证导出不依赖 fetch。
              try {
                const resp = await fetch(src);
                if (resp.ok) {
                  const blob = await resp.blob();
                  dataUri = await blobToDataUri(blob);
                }
              } catch (_e) { /* fallthrough：走缓存反查兜底 */ }
              if (!dataUri && this._imageURLCache) {
                for (const [dataUriKey, blobUrl] of this._imageURLCache) {
                  if (blobUrl === src) { dataUri = dataUriKey; break; }
                }
              }
            } else if (src.startsWith('http://') || src.startsWith('https://')) {
              // 跨域外链图**只**走 Rust 后端 reqwest（lib.rs:fetch_image_as_base64）。
              // 浏览器 fetch 必然被 "No 'Access-Control-Allow-Origin'" 挡下，除了在控制台
              // 刷一条红字、再等一次网络超时，没有任何收益 —— 用户会误读成「导出报错了」。
              // 后端也拿不到（图床 522 / 离线 / 运行时缺失）就保留原 URL，一张图不拖住整份文档。
              const timeoutMs = this._exportFetchTimeoutMs || REMOTE_IMAGE_TIMEOUT_MS;
              try {
                const b64 = await withTimeout(TauriApi.fetchImageAsBase64({ url: src }), timeoutMs);
                const mime = b64 ? mimeFromBase64(b64) : null;
                if (mime) dataUri = `data:${mime};base64,${b64}`;
              } catch (_e) { /* 后端不可用/超时/非图片：保留原 src */ }
            } else if (src.startsWith('file://')) {
              // file:// 走 Rust 读磁盘（绕过 CSP，与 processImages 一致）
              const url = src.replace(/^file:\/\//, '');
              const base64 = await TauriApi.fetchImageAsBase64({ url });
              dataUri = `data:${mimeOfExt(url)};base64,${base64}`;
            } else {
              // 纯相对路径：按当前 .md 所在目录补全。
              // 未保存文档（无 filePath）没有目录可解析 —— 保留原 src 即可，不能拼出
              // '/images/a.png' 这种绝对路径去读盘（会读不到，且把 src 改写成 base64,null）。
              if (!dir) return;
              let rel = src;
              if (rel.startsWith('/')) rel = rel.slice(1);
              const base64 = await TauriApi.fetchImageAsBase64({ url: dir + '/' + rel });
              if (!base64) return;
              dataUri = `data:${mimeOfExt(rel)};base64,${base64}`;
            }
            if (dataUri) img.src = dataUri;
          } catch (e) {
            // 还原失败不阻断导出：保留原 src，至少用户能手动补
            console.warn('[export] 图片内联失败，保留原 src:', src, e);
          }
        });
        // 整体上限：某一张图永久挂起（IPC 不回、FileReader 不回调）时，allSettled 会一直等。
        // 超时直接放行，已完成的图片仍留在 clone 上，由调用方继续导出整份文档。
        await withTimeout(Promise.allSettled(imgPromises),
          this._exportInlineTimeoutMs || REMOTE_IMAGE_TIMEOUT_MS).catch(() => {});
      },
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
      },
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
        th, td { padding: 8px 12px; border: 1px solid #d4d4d8; text-align: left; overflow-wrap: break-word; word-break: break-word; }
        th { background: #f0efee; font-weight: 600; }
        img { max-width: 100%; }
        hr { border: none; border-top: 1px solid #d4d4d8; margin: 24px 0; }
        ul, ol { padding-left: 24px; margin-bottom: 14px; }
        li { margin-bottom: 4px; }
        mark { display: inline-block; background: #fbbf24; color: #1a1a1a; padding: 1px 4px; border-radius: 3px; }
        kbd { display: inline-block; padding: 2px 7px; font-size: 0.82em; font-family: "SF Mono", "Fira Code", monospace; background: #f0efee; border: 1px solid #d4d4d8; border-bottom-width: 2px; border-radius: 4px; line-height: 1.5; }
        abbr { text-decoration: underline dotted; cursor: help; }
        /* 2026-10-28 用户要求：导出时不得因滚动/裁切丢失内容——图表容器解除横向滚动
           （svg 自带 max-width:100% 自适应缩放，无裁切） */
        .mermaid-container { text-align: center; margin: 16px 0; padding: 16px; max-width: 100%; background: #f0efee; border-radius: 8px; border: 1px solid #d4d4d8; overflow: visible; }
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
        .math-display { display: block; text-align: center; margin: 16px 0; overflow: visible; }
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
      },
      // 导出「全量展开」公共口径（2026-10-28 用户要求：不管设置里代码块是「滚动」还是「全部」，
      // 导出长图/PDF/DOCX 时所有超长滚动容器都必须展开显示全部，任何导出不得丢失内容）。
      // 渲染态的滚动/裁切容器（styles.css）：
      //   .code-scroll        代码块 max-height:300px + overflow-y（「代码块滚动条」设置开时）
      //   table               display:block + overflow-x:auto（宽表横向滚动）
      //   .katex-display-wrapper / .math-display / .katex-display  overflow-x:auto（宽公式）
      //   .mermaid-container  overflow-x:auto（宽图表，svg max-width:100% 自适应缩放）
      //   .md2-error pre      overflow-x:auto（表格解析错误回显）
      // 展开策略：纵向裁切直接解除（max-height:none + overflow:visible）；代码/表格强制 pre-wrap
      // 换行（代码块行白名单外的 no-wrap 模式同样收口）；表格恢复 table 布局（display:block 会
      // 破坏表格排版），单元格长 token 断词保证压缩换行不溢出；公式/图表容器解除横向裁切。
      // scope = 选择器前缀（长图 clone 用 '#tm-png-export-root'、PDF 打印帧用 '.preview-content'、
      // 无 scope 时用空串），各导出链路共用本方法避免口径漂移。
      _exportExpandRules(scope) {
        const p = scope ? scope + ' ' : '';
        return `${p}.code-scroll { max-height: none !important; overflow: visible !important; }
        ${p}pre { white-space: pre-wrap !important; word-wrap: break-word !important; word-break: break-word !important; overflow: visible !important; }
        ${p}pre code { white-space: pre-wrap !important; word-wrap: break-word !important; word-break: break-word !important; }
        ${p}.code-line-text { white-space: pre-wrap !important; word-wrap: break-word !important; word-break: break-word !important; }
        ${p}table { display: table !important; overflow: visible !important; }
        ${p}td, ${p}th { overflow-wrap: break-word !important; word-break: break-word !important; }
        ${p}.mermaid-container { overflow: visible !important; }
        ${p}.katex-display-wrapper, ${p}.math-display, ${p}.katex-display { overflow: visible !important; }
        ${p}.md2-error pre { overflow: visible !important; }`;
      },
      // ---------- 导出公共：样式采集 / MathML 去重 / 遮罩 ----------
      //
      // 样式采集铁律：导出帧要的样式一律从「主文档已加载的样式表」按 CSSOM 直读，不走网络。
      // 原实现用裸 fetch('lib/katex/katex.min.css')，失败时是**静默**的（catch 吞掉 → 空串），
      // 后果在用户侧表现为两类看似无关的现象：
      //   · 导出帧缺 katex 样式 → .katex-mathml 副本不再被 clip-path 隐藏 → 公式后面平铺出
      //     第二份纯文本（a²+b²=c² 紧跟 a2 + b2 = c2），且公式自身排版退化；
      //   · 导出帧缺 hljs 样式 → 代码块 token 全黑，等于高亮尽失。
      // 而 fetch 在自定义协议、打包路径差异、离线等场景都有失败面；CSSOM 直读只依赖
      // 「页面已正常渲染」这一个前提 —— 预览本身能着色，导出的帧就一定能着色。
      // matchFn 收到小写 href，返回该样式表全文；读不到规则（跨域/未加载）时继续找下一张。
      _exportStyleFromLink(matchFn) {
        const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          if (!matchFn(href.toLowerCase())) continue;
          const sheet = link.sheet;
          if (!sheet) continue;
          try {
            const rules = Array.from(sheet.cssRules).map((r) => r.cssText);
            if (rules.length) return { css: rules.join('\n'), base: link.href || '' };
          } catch (_e) { /* 跨域 / 未加载完：换下一张 */ }
        }
        return { css: '', base: '' };
      },
      // 把 CSS 里相对的 url() 按样式表自身位置补成绝对地址。
      // KaTeX 的字体写作 url(fonts/KaTeX_*.woff2)；以文本形式注入导出帧 / foreignObject 后，
      // 这些相对路径会按**宿主文档**解析（→ 404），公式字形退化成 Times New Roman。
      _absolutizeCssUrls(css, baseHref) {
        if (!css || !baseHref) return css;
        return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, _q, u) => {
          if (/^(data:|blob:|https?:|file:|about:|\/\/)/i.test(u)) return m;
          try { return `url("${new URL(u, baseHref).href}")`; } catch (_e) { return m; }
        });
      },
      // 把 CSS 里的字体文件 url() 内联为 data URI（只处理字体扩展名）。
      // 长图走 SVG-as-image，属受限环境，**不能加载任何外部资源**：KaTeX 的 woff2 若不内联，
      // 成图里公式字形会整体退化成 Times New Roman（与阅读模式肉眼可辨）。
      // 只内联 woff2 —— 它是 Chromium 必然支持的格式，且 KaTeX 每个 @font-face 都以它打头；
      // woff/ttf 备选项保留原 url（浏览器不会去取），避免把 1.2MB 字体目录全部塞进 SVG。
      async _inlineCssFonts(css, baseHref) {
        if (!css || !baseHref) return css;
        const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
        const targets = new Set();
        let m;
        while ((m = re.exec(css))) {
          const u = m[2];
          if (/^data:/i.test(u)) continue;
          if (!/\.woff2(\?|$)/i.test(u)) continue;
          targets.add(u);
        }
        if (!targets.size) return css;
        const map = new Map();
        await Promise.all(Array.from(targets).map(async (u) => {
          try {
            const abs = new URL(u, baseHref).href;
            const resp = await fetch(abs);
            if (!resp.ok) return;
            const blob = await resp.blob();
            const dataUri = await new Promise((res, rej) => {
              const fr = new FileReader();
              fr.onload = () => res(fr.result);
              fr.onerror = () => rej(fr.error || new Error('readAsDataURL failed'));
              fr.readAsDataURL(blob);
            });
            map.set(u, dataUri);
          } catch (_e) { /* 单个字体失败不阻断：保留原 url，字形可能退化 */ }
        }));
        return css.replace(re, (mm, _q, u) => (map.has(u) ? `url("${map.get(u)}")` : mm));
      },
      // 等容器内图片解码完（宽度/高度参与度量，未加载完会量出偏小的高度把图截断）。
      // 失败/超时都放行：宁可尺寸略偏，不能把导出卡死。
      async _waitImagesReady(root, timeoutMs = 8000) {
        const pending = Array.from(root.querySelectorAll('img')).filter((i) => !i.complete || !i.naturalWidth);
        if (!pending.length) return;
        await Promise.all(pending.map((i) => new Promise((resolve) => {
          const done = () => resolve();
          i.addEventListener('load', done, { once: true });
          i.addEventListener('error', done, { once: true });
          setTimeout(done, timeoutMs);
        })));
      },
      // 导出帧不需要 KaTeX 的 MathML 副本：它只是给屏幕阅读器/复制用的等价描述，
      // 视觉层完全由 .katex-html 负责，平时靠 CSS 的 clip-path: inset(50%) 隐藏。
      // 「靠 CSS 隐藏」在导出链路上有两处会破：① 样式表采集失败（见上面 _exportStyleFromLink）；
      // ② 栅格化 / 打印后端对 clip-path 的处理与屏幕不一致（长图走 canvas 尤其如此）。
      // 一旦破了，MathML 就按文本流铺开 —— 读者看到的就是 a²+b²=c² 后面又跟一遍 a2 + b2 = c2。
      // 故导出前直接从 clone 里摘掉，不再依赖任何 CSS 行为。
      //
      // 边界：DOCX 导出（export-docx.js）正是从 .katex-mathml 的 <math> 取源转 OMML 的，
      // 绝不能移除；它走独立流程、读的是 live preview，与这里的 clone 互不影响。
      _stripKatexMathml(clone) {
        if (!clone || !clone.querySelectorAll) return clone;
        clone.querySelectorAll('.katex-mathml').forEach((el) => el.remove());
        return clone;
      },
      // 导出遮罩属于 UI、不属于导出物：_enterLightExport() 会把 html 的 data-theme 临时
      // 切成 light（导出物一律亮色）。若遮罩只继承 html 变量，暗色主题下导出会中途闪成亮色、
      // 退出时再闪回去。CSS 的 [data-theme] / [data-color-scheme] 规则不限定元素，
      // 把「软件当前主题」固化到遮罩自身，即可在遮罩作用域内解析出对应配色变量，
      // 后续 html 切亮/还原都不影响它。并发导出时优先取亮色上下文保存的快照。
      _applyExportOverlayTheme(overlay) {
        const root = document.documentElement;
        const snap = this._lightExportSnapshot;
        const theme = (snap && snap.theme) || root.getAttribute('data-theme')
          || (this.isDark ? 'dark' : 'light');
        overlay.setAttribute('data-theme', theme);
        overlay.setAttribute('data-color-scheme',
          root.getAttribute('data-color-scheme') || 'default');
      },
      // 导出遮罩：长图 / HTML / PDF 三条链路共用。三处都自己拼 overlay 会各写一套 z-index
      // 与样式；统一在这里，且由调用方 finally 保证移除（导出失败/取消同样收干净）。
      _showExportOverlay(text) {
        this._hideExportOverlay();
        const overlay = document.createElement('div');
        overlay.id = 'tm-export-overlay';
        overlay.setAttribute('role', 'status');
        overlay.innerHTML = '<div class="tm-export-spinner"></div><div class="tm-export-text"></div>';
        overlay.querySelector('.tm-export-text').textContent = text || '';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;display:flex;flex-direction:column;'
          + 'align-items:center;justify-content:center;background:var(--bg-primary);cursor:progress;';
        this._applyExportOverlayTheme(overlay);
        if (!document.getElementById('tm-export-overlay-style')) {
          const s = document.createElement('style');
          s.id = 'tm-export-overlay-style';
          s.textContent = '.tm-export-spinner{width:34px;height:34px;border:3px solid var(--border-color);'
            + 'border-top-color:var(--accent-color);border-radius:50%;animation:tm-export-spin .7s linear infinite;margin-bottom:12px;}'
            + '@keyframes tm-export-spin{to{transform:rotate(360deg)}}'
            + '.tm-export-text{color:var(--text-primary);font-size:14px;letter-spacing:.4px;}';
          document.head.appendChild(s);
        }
        document.body.appendChild(overlay);
        // 强制一次样式计算，确保遮罩在后续同步重活（Mermaid 渲染 / canvas 绘制）前已经上屏
        overlay.offsetHeight;
        return overlay;
      },
      _hideExportOverlay() {
        const old = document.getElementById('tm-export-overlay');
        if (old && old.parentNode) old.parentNode.removeChild(old);
      },
      // ---------- 导出公共：亮色导出上下文（2026-11-09 定稿） ----------
      //
      // 口径：无论应用当前是明亮还是暗黑，导出物（HTML/长图/DOCX/PDF）内容一律按亮色主题
      // 渲染。实现为「成对调用 + 引用计数」：各导出在选完保存路径后调 _enterLightExport()、
      // 在自身 finally 末尾调 _leaveLightExport()——**不得**再包一层 try/finally：
      // test/export-parity / export-expand-all 对各导出函数体有字符窗口断言，新增 finally
      // 会挤爆窗口（2026-11-09 排查结论）。引用计数同时解决并发导出的状态撕裂
      // （A 存快照→切亮→B 存快照→切亮→A 恢复→B 恢复，若无计数用户主题会被 B 的恢复写坏）。
      //
      // 快照三件套：data-theme 属性、html 内联 color-scheme（theme.js 写的，内联优先级高于
      // CSS，只切 data-theme 时 color-scheme:dark 仍让 Chromium 用暗色 UA 画布——PDF 黑边
      // #121212 的根因之一）、hljs 亮/暗主题 link href。另注入临时样式禁用全局 transition
      // （body 有 background-color .3s，切亮色后立刻读 computed/截图会取到渐变中间灰）。
      async _waitForStylesheet(link, timeout = 1500) {
        if (!link) return;
        await new Promise((res) => {
          let done = false;
          const fin = () => { if (!done) { done = true; res(); } };
          link.addEventListener('load', fin, { once: true });
          link.addEventListener('error', fin, { once: true });
          setTimeout(fin, timeout);
        });
      },
      async _enterLightExport() {
        this._lightExportDepth = (this._lightExportDepth || 0) + 1;
        if (this._lightExportDepth > 1) return; // 已有并发导出把文档切到亮色，直接复用
        const root = document.documentElement;
        const hljsLink = document.getElementById('highlight-theme');
        this._lightExportSnapshot = {
          theme: root.getAttribute('data-theme'),
          colorScheme: root.style.getPropertyValue('color-scheme') || null,
          hljsHref: hljsLink ? hljsLink.getAttribute('href') : null,
        };
        root.setAttribute('data-theme', 'light');
        try { root.style.colorScheme = 'light'; } catch (_e) { /* 极旧内核无此属性，忽略 */ }
        // 禁用过渡：见上「快照三件套」注释——切亮色必须即刻生效，不能让导出快照到渐变中间态
        const st = document.createElement('style');
        st.id = 'tm-export-light-transition-off';
        st.textContent = 'html, html * { transition: none !important; }';
        document.head.appendChild(st);
        this._lightExportTransitionStyle = st;
        // 暗色高亮主题换亮色 github（测试 harness 无此 link，判空兜底）
        if (hljsLink && /dark/i.test(this._lightExportSnapshot.hljsHref || '')) {
          hljsLink.href = 'lib/highlight.js/github.min.css';
          await this._waitForStylesheet(hljsLink);
        }
      },
      _leaveLightExport() {
        const depth = (this._lightExportDepth || 0) - 1;
        this._lightExportDepth = Math.max(depth, 0);
        if (depth > 0) return; // 还有并发导出依赖亮色上下文，先不还原
        const snap = this._lightExportSnapshot;
        this._lightExportSnapshot = null;
        if (!snap) return;
        const root = document.documentElement;
        if (snap.theme !== null && snap.theme !== undefined) root.setAttribute('data-theme', snap.theme);
        else root.removeAttribute('data-theme');
        if (snap.colorScheme !== null) root.style.colorScheme = snap.colorScheme;
        else { try { root.style.removeProperty('color-scheme'); } catch (_e) {} }
        if (this._lightExportTransitionStyle && this._lightExportTransitionStyle.parentNode) {
          this._lightExportTransitionStyle.parentNode.removeChild(this._lightExportTransitionStyle);
        }
        this._lightExportTransitionStyle = null;
        const hljsLink = document.getElementById('highlight-theme');
        if (hljsLink && snap.hljsHref) hljsLink.href = snap.hljsHref;
        // 导出期间 mermaid 被按亮色/loose 重新 initialize 过（重绘图表），必须还原预览配置，
        // 否则暗色模式下导出完一次，预览里后续新增的图表全变亮色（theme/安全等级同时漂移）。
        if (this._lightMermaidTouched) {
          this._lightMermaidTouched = false;
          this._restoreMermaidPreviewConfig();
        }
      },
      // 还原 mermaid 预览配置：与 theme.js:155-164 同参（theme 按 DOM 实际值、strict、预览字体）。
      _restoreMermaidPreviewConfig() {
        if (typeof mermaid === 'undefined') return;
        try {
          mermaid.initialize({
            startOnLoad: false,
            theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default',
            securityLevel: 'strict',
            fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-preview').trim() || '-apple-system, sans-serif',
          });
        } catch (e) { console.error('[export] mermaid 预览配置还原失败:', e); }
      },
      // 图表亮色重绘（导出物一律亮色的最后一块拼图）：预览里的 mermaid SVG 颜色是按
      // **当时主题**生成并内联在 SVG 上的，切 data-theme 救不了它——白纸/亮底文档里
      // 嵌一张暗色图。这里把容器还原成 mermaid 源码后按 default（亮色）主题重渲染。
      // 原 _preparePdfClone 内联实现抽出共用（HTML / 长图 / PDF 三条链路同口径）。
      // securityLevel 保留 'loose'：导出要完整保真（mermaid-batch-rerender.test 的明确例外）。
      async _rerenderMermaidLightInClone(clone, idPrefix, fontFamily) {
        const mermaidContainers = Array.from(clone.querySelectorAll('.mermaid-container'));
        if (typeof mermaid === 'undefined' || !mermaidContainers.length) return;
        this._lightMermaidTouched = true;
        mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose', fontFamily: fontFamily || '-apple-system, sans-serif', themeVariables: { fontSize: '14px' } });
        for (let i = 0; i < mermaidContainers.length; i++) {
          const code = (mermaidContainers[i].getAttribute('data-code') || mermaidContainers[i].textContent || '').trim();
          if (!code) continue;
          try {
            const result = await mermaid.render(idPrefix + i, code);
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
            console.error('Mermaid light render error for diagram', i, ':', e);
          }
        }
      },
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
      },
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
      },
      // 把 Word HTML（altChunk 方案）转成 docx 的 ArrayBuffer（主线程，html-docx-js 同步打包）。
      // 曾走 Web Worker：Worker 在部分 Tauri/WebView 环境下不可用（自定义协议对 Worker 脚本
      // 加载支持不稳），导致整条导出链静默降级、公式全变文字，故全部改为主线程直构建。
      async _convertHtmlToDocxBuffer(html) {
        if (typeof htmlDocx === 'undefined' || !htmlDocx.asBlob) {
          throw new Error('导出组件未加载（html-docx 未加载）');
        }
        const blob = htmlDocx.asBlob(html);
        return await blob.arrayBuffer();
      },
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
      },
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
      },
      // Word 导出前的 DOM 预处理：把 Web 预览中 Word HTML 导入器会曲解的结构，
      // 转成 Word 能稳定渲染的等价形式，并内联关键样式。
      // 把 Web 预览 DOM 预处理成 Word 兼容结构。
      // 公式（.katex）本函数一律原样保留：DOCX 真 OOXML 主路径需要它内部的 <math>
      // 来生成 Word 可编辑公式（OMML）；公式不再转图片。
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
  
        // 8. 数学公式：不做任何转换，保留 .katex 原样。
        //    DOCX 真 OOXML 主路径由 domToDocxStructure 提取 <math> → OMML，得到 Word 可编辑公式；
        //    公式不再转图片（图片公式不可二次编辑，产品上不提供）。
        //    仅在 html-docx 回退路径（_fallbackWordHtmlExport）里降级为 LaTeX 源码文本。
  
        // 9. Mermaid 图表：SVG 在 Word HTML 导入里常丢失，转成 PNG 内联图。
        //    截图前临时去掉容器 padding/border/background，让容器紧包 SVG；
        //    截图后裁剪透明边，并以实际内容尺寸显示（不超宽时不满页拉伸）。
        //    截图前先 mermaid.render() 重渲染：预览时 mermaid 偶发未渲染（切换标签页
        //    触发重排后才渲染），直接 html2canvas 会截到空容器导致图表缺失/报错。
        if (typeof mermaid !== 'undefined') {
          const ff = getComputedStyle(document.documentElement).getPropertyValue('--font-preview').trim() || '-apple-system, sans-serif';
          // 主题读 DOM 的 data-theme（不再读 this.isDark）：亮色导出上下文会把 html 切成
          // light，但 this.isDark 仍是进入前的快照——按它取主题会让暗黑模式的 Word 里
          // 嵌暗色图表。上下文内 DOM 已是 light，这里自然得 'default'（亮色）。
          // mermaid.initialize 失败不致命：下方 mermaid.render 有独立 try/catch，且初始化异常不应阻断导出
          this._lightMermaidTouched = true;
          try { mermaid.initialize({ startOnLoad: false, theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default', securityLevel: 'loose', fontFamily: ff, themeVariables: { fontSize: '14px' } }); } catch (e) { console.error('[export] mermaid.initialize 失败（不影响导出）:', e); }
        }
        const mermaidContainers = Array.from(clone.querySelectorAll('.mermaid-container'));
        for (let mi = 0; mi < mermaidContainers.length; mi++) {
          const container = mermaidContainers[mi];
          // 重渲染确保 SVG 就绪
          if (typeof mermaid !== 'undefined' && container.getAttribute('data-code')) {
            try {
              const code = (container.getAttribute('data-code') || '').trim();
              if (code) {
                const result = await mermaid.render('docx-mermaid-' + Date.now() + '-' + mi, code);
                container.innerHTML = result.svg;
                const svgEl = container.querySelector('svg');
                if (svgEl) {
                  svgEl.removeAttribute('style');
                  const vb = svgEl.getAttribute('viewBox');
                  if (vb) { const parts = vb.split(/\s+/); if (parts.length >= 4) { svgEl.setAttribute('width', parts[2]); svgEl.setAttribute('height', parts[3]); } }
                }
              }
            } catch (e) { /* 渲染失败保留原 SVG，截图兜底 */ }
          }
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
          this._applyWordImgSize(img, natW, natH, WORD_IMG_MAX_PX, cssW);
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
        //     Mermaid（.tizu-mermaid-img）已单独处理为 500px，这里跳过以免被覆盖。
        //     （公式不再转图片，故无 .tizu-math-img 分支。）
        const plainImages = Array.from(clone.querySelectorAll('img')).filter((img) => {
          return !img.classList.contains('tizu-mermaid-img');
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
          this._applyWordImgSize(img, natW, natH, WORD_IMG_MAX_PX, dispW > 0 ? dispW : natW);
          img.style.display = 'inline-block';
          img.style.maxWidth = '100%';
        }));
  
        } finally {
          holder.remove();
        }
      },
      // 公式兜底：把 clone 里残留的 .katex 换成「LaTeX 源码文本」。
      // 只在 html-docx 回退路径（真 OOXML 主路径整体失败）才会走到，正常导出不会用到。
      //
      // 为什么是文本而不是图片：公式一律以 Word 原生可编辑公式（OMML）为目标，图片公式
      // 不能二次编辑、缩放后发虚，产品上不提供。主路径失败时与其塞一张图，不如保留可读、
      // 可复制回编辑器重新编辑的 LaTeX 源码（.katex-mathml 里的 <annotation encoding="application/x-tex">）。
      _katexElsToLatexText(clone) {
        const katexEls = Array.from(clone.querySelectorAll('.katex'));
        for (const katex of katexEls) {
          let tex = '';
          const annotation = katex.querySelector('.katex-mathml annotation[encoding="application/x-tex"]')
            || katex.querySelector('annotation[encoding="application/x-tex"]');
          if (annotation) tex = (annotation.textContent || '').trim();
          if (!tex) {
            const mathml = katex.querySelector('.katex-mathml');
            if (mathml) tex = (mathml.textContent || '').replace(/\s+/g, ' ').trim();
          }
          if (!tex) tex = (katex.textContent || '').replace(/\s+/g, ' ').trim();
          const span = document.createElement('code');
          span.className = 'tizu-math-source';
          span.textContent = tex;
          katex.replaceWith(span);
        }
      },
      // 导出 HTML。
      //
      // 2026-10-25 重做（用户反馈：导出 HTML 与阅读模式不一致 / 公式出现第二份纯文本 /
      // 代码高亮丢失）。三个根因：
      //   1) 原来用的是手写的 _documentExportCSS()，与 styles.css 的阅读样式是两套平行实现，
      //      必然漂移（同一份文档在阅读模式和导出 HTML 里长得不一样）；
      //   2) katex / hljs 样式走裸 fetch，失败即静默为空 → MathML 副本暴露、token 无色；
      //   3) body 里直接铺 clone.innerHTML，丢掉了 .preview-content 这个作用域根，
      //      而 styles.css 的阅读样式几乎全是 `.preview-content xxx` 后代选择器 —— 等于全部失效。
      // 现在：样式一律 CSSOM 直读完整 styles.css（含 :root 主题变量）+ 绝对化字体 url，
      // body 保留 .preview-content 容器与原 class（code-line-numbers 等状态类一并继承），
      // 只为「独立文档没有应用外壳」这一事实补少量修正。
      // DOCX 不走本方法（exportWord → export-docx.js），导出逻辑与样式均不受影响。
      async exportHTML() {
        let overlayOn = false;
        let htmlExported = false;
        try {
          const path = await dialogSave({
            defaultPath: this.activeTab.filePath
              ? this.activeTab.filePath.replace(/\.md$/, '.html')
              : 'export.html',
            filters: [{ name: 'HTML', extensions: ['html'] }]
          });
          if (!path) return;
  
          overlayOn = true;
          this._showExportOverlay(this.t('exportingHTML'));
          // 让遮罩先上屏，再开始图片内联/样式序列化这类同步重活
          await new Promise(r => requestAnimationFrame(r));
          // 亮色导出上下文：无论当前主题，导出物一律亮色（见 _enterLightExport 注释）
          await this._enterLightExport();

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
          // 摘掉 KaTeX 的 MathML 副本（不依赖 clip-path 隐藏，详见 _stripKatexMathml）
          this._stripKatexMathml(clone);

          await this._inlineImagesForExport(clone, this.activeTab.filePath);
          // 图表亮色重绘：预览里的 mermaid SVG 颜色按当时主题内联，切主题救不了（见公共注释）
          if (clone.querySelector('.mermaid-container')) {
            await this._rerenderMermaidLightInClone(clone, 'html-mermaid-',
              getComputedStyle(document.documentElement).getPropertyValue('--font-preview').trim() || '-apple-system, sans-serif');
          }
  
          // 样式：CSSOM 直读（应用样式 + KaTeX + 当前高亮主题），字体 url 绝对化
          const appSheet = this._exportStyleFromLink((h) => /(^|\/)styles\.css(\?|$)/.test(h));
          const katexSheet = this._exportStyleFromLink((h) => /katex/.test(h) && /\.css(\?|$)/.test(h));
          const hljsThemeEl = document.getElementById('highlight-theme');
          const hljsHref = ((hljsThemeEl && hljsThemeEl.getAttribute('href')) || '').toLowerCase();
          const hljsSheet = this._exportStyleFromLink((h) => (hljsHref
            ? h.endsWith(hljsHref)
            : /highlight|hljs|github/.test(h)));
  
          const appCSS = this._absolutizeCssUrls(appSheet.css, appSheet.base);
          // KaTeX 字体必须内联：导出的 HTML 是要被搬走的独立文件，写成 http/file 绝对地址
          // 换台机器/换个目录就取不到，公式字形会退化成 Times（实测 file:// 打开即如此）。
          const katexCSS = this._absolutizeCssUrls(await this._inlineCssFonts(katexSheet.css, katexSheet.base), katexSheet.base);
          const hljsCSS = this._absolutizeCssUrls(hljsSheet.css, hljsSheet.base);
  
          // 自定义预览字体的 @font-face（base64 内联）由 #custom-fonts-style 持有，导出要一并带上
          const customFontStyleEl = document.getElementById('custom-fonts-style');
          const customFontCSS = customFontStyleEl ? (customFontStyleEl.textContent || '') : '';
  
          const theme = document.documentElement.getAttribute('data-theme') || 'light';
          const colorScheme = document.documentElement.getAttribute('data-color-scheme') || 'default';
  
          // 独立文档修正：styles.css 的 body 规则是为「固定视口 + 内部滚动」的应用外壳写的
          // （height:100vh + overflow:hidden + 禁用选中），在独立 HTML 里会把内容直接裁掉，
          // 且读者需要能选中/复制文本。除此之外不改任何阅读样式。
          const docFix = `
    :root { color-scheme: light !important; }
    html, body { height: auto !important; overflow: visible !important; background: var(--preview-bg, #fff) !important; }
    body { -webkit-user-select: text !important; user-select: text !important; }
    .preview-content { overflow: visible !important; max-width: 860px; margin: 0 auto; }`;

          // 全量展开（与长图 / PDF 同一口径 _exportExpandRules）。
          // 阅读模式里的 .code-scroll（max-height:300px + overflow-y）靠 JS 在内容真的超高时
          // 才把 overflow-y 改成 auto；导出的是**静态文档**，没有那段 JS —— 留着 max-height
          // 就是直接裁掉 300px 以下的代码，且「代码块换行」关掉时 .code-line-text 是
          // white-space:pre，横向也滚不出去。同理宽表 / 宽公式 / 宽图表。故导出 HTML 也展开。
          const expandCSS = this._exportExpandRules('');
  
          const escapedTitle = this.activeTab.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          const containerClass = (clone.getAttribute('class') || 'preview-content');
          const fullHTML = `<!DOCTYPE html>
    <html lang="zh-CN" data-theme="${theme}" data-color-scheme="${colorScheme}">
    <head>
      <meta charset="UTF-8">
      <title>${escapedTitle}</title>
      <style>
    ${customFontCSS}${appCSS}
    ${hljsCSS ? hljsCSS + '\n' : ''}${katexCSS ? katexCSS + '\n' : ''}${docFix}
    ${expandCSS}
      </style>
    </head>
    <body>
    <div class="${containerClass}">${clone.innerHTML}</div>
    </body>
    </html>`;
  
          await TauriApi.writeFile({ path, content: fullHTML });
          this.setStatus(`${this.t('exportedHTML')}: ${path}`);
          htmlExported = true;
        } catch (error) {
          this.setStatus(`${this.t('exportFailed')}: ${error}`);
        } finally {
          if (overlayOn) this._hideExportOverlay();
          // 2026-10-26 用户反馈：HTML 导出遮罩结束后没有任何成功提示，不知道完没完成。
          // 与 DOCX 同口径（export.js「导出真正完成后再弹成功提示；先关遮罩，确保 toast
          // 不被遮住」）——写入文件成功才弹，失败只走 setStatus 错误态。
          if (htmlExported) this.showToast(this.t('exportSuccess'), 'success');
          this._leaveLightExport();
        }
      },
      // docx 页面尺寸（twips，1/20 pt）：A4 / Letter，支持纵向/横向。
      _docxPageSize(kind, orientation = 'portrait') {
        const sizes = {
          A4: { width: 11906, height: 16838 },
          Letter: { width: 12240, height: 15840 },
        };
        const s = sizes[kind] || sizes.A4;
        return orientation === 'landscape'
          ? { width: s.height, height: s.width }
          : { width: s.width, height: s.height };
      },
      // docx 边距（twips）：标准 / 窄 / 宽。
      _docxMargins(preset) {
        const map = {
          normal: { top: 1440, bottom: 1440, left: 1800, right: 1800 },
          narrow: { top: 720, bottom: 720, left: 720, right: 720 },
          wide: { top: 2880, bottom: 2880, left: 2880, right: 2880 },
        };
        return map[preset] || map.normal;
      },
      // 把 DOM→structure 中的 mathml run 转成 OMML（Word 可编辑公式）。
      // KaTeX 渲染的 <math>（export-docx.js 收集为 { mathml } run）经 MathML2OMML.mml2omml
      // 转成 OMML 字符串，主线程构建时用 ImportedXmlComponent 注入 <m:oMath>。
      //
      // 容错策略（关键）：mml2omml 对部分复杂公式（矩阵/aligned/cases 等）产出的 OMML
      // 可能不是良构 XML，docx 的 XML 解析器会抛 "Unexpected close tag"，**单个坏公式会
      // 拖垮整篇文档构建 → 全部回退 altChunk → 所有公式变文字**。因此这里逐公式处理：
      //   - 缺库 → 返回 false（走 html-docx 回退，公式降级 LaTeX 文本）
      //   - 转换且 OMML 良构 → { omml }（Word 可编辑公式）
      //   - 转换失败 / OMML 非良构 → { text: LaTeX源码 }（不丢内容，也不拖垮整篇）
      // 返回 true 表示可走主路径（个别公式降级文本不影响整体）。
      _structureMathmlToOmml(structure) {
        const convert = (typeof MathML2OMML !== 'undefined' && MathML2OMML.mml2omml)
          ? MathML2OMML.mml2omml
          : null;
        // OMML 良构预检：非法 XML 会让 docx 的 fromXmlString 抛错拖垮整篇。
        const isWellFormed = (xml) => {
          try {
            const doc = new DOMParser().parseFromString(xml, 'application/xml');
            return doc && doc.getElementsByTagName('parsererror').length === 0;
          } catch (e) { return false; }
        };
        // 从 MathML 里取 LaTeX 源码（<annotation encoding="application/x-tex">…</annotation>）
        const extractLatex = (mathml) => {
          const m = /<annotation[^>]*encoding=["']application\/x-tex["'][^>]*>([\s\S]*?)<\/annotation>/.exec(mathml);
          if (m) return m[1].trim();
          const m2 = /<annotation[^>]*>([\s\S]*?)<\/annotation>/.exec(mathml);
          return m2 ? m2[1].trim() : '';
        };
        // mathml 是序列化字符串（outerHTML），annotation 文本里的 < > & 已被实体转义；
        // 正则捕获的是转义形态，直接当纯文本塞进 Word 会显示字面 &lt;（用户实测）。
        const decodeXmlEntities = (s) => String(s)
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&');
        // mml2omml 产出 <m:t> 文本内容时不做 XML 转义：公式含 <（如 O(1) < O(\log n)）时
        // OMML 里出现裸 < → 非良构（parsererror）→ 被误判坏公式降级成 LaTeX 纯文本。
        // 这里对 <m:t>…</m:t> 内文本定向转义修复（< 一律转义；& 仅在非实体引用处转义，幂等；
        // > 在 XML 文本中合法不动），修复后良构校验通过即可走 OMML 主路径保留可编辑公式。
        const repairTextEscaping = (xml) => String(xml).replace(
          /(<m:t(?:\s[^>]*)?>)([\s\S]*?)(<\/m:t>)/g,
          (_, open, text, close) => open
            + text.replace(/&(?!(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;').replace(/</g, '&lt;')
            + close
        );
        let sawMath = false;
        const walkRuns = (runs) => {
          if (!Array.isArray(runs)) return;
          for (let i = runs.length - 1; i >= 0; i--) {
            const r = runs[i];
            if (r && typeof r.mathml === 'string') {
              sawMath = true;
              if (!convert) continue; // 缺库：保留 mathml run，外层据 sawMath 决定走主路径还是回退
              let ommlStr = null;
              try { ommlStr = String(convert(r.mathml)); } catch (e) { ommlStr = null; }
              if (ommlStr) ommlStr = repairTextEscaping(ommlStr);
              if (ommlStr && isWellFormed(ommlStr)) {
                runs[i] = { omml: ommlStr };
              } else {
                // 降级为 LaTeX 源码文本：宁可显示源码也不让坏 OMML 拖垮整篇文档。
                const tex = decodeXmlEntities(extractLatex(r.mathml)) || r.mathml.replace(/<[^>]+>/g, '').trim();
                runs[i] = { text: tex };
              }
            }
          }
        };
        for (const node of structure) {
          if (node && node.runs) walkRuns(node.runs);
          if (node && node.type === 'table') {
            for (const row of node.rows || []) {
              for (const cell of row.cells || []) {
                for (const p of cell.paragraphs || []) walkRuns(p.runs);
              }
            }
          }
        }
        // 无公式 → 走主路径；有公式但缺转换库 → 走 html-docx 回退（公式降级 LaTeX 文本）。
        if (!sawMath) return true;
        return !!convert;
      },
      // 弹「导出 DOCX」确认框：只做说明 + 确认，返回 Promise<boolean>（true=开始导出）。
      // 纸张/方向/边距固定 A4/纵向/标准——Word 是页面模型需要这些值，但让用户在导出前选
      // 是多余的一步（Word 里「布局 → 页面设置」随时可改，多数人导出也不是为了打印）。
      _confirmDocxExport() {
        return new Promise((resolve) => {
          const dlg = document.getElementById('docx-page-dialog');
          if (!dlg) { resolve(true); return; }
          const tipEl = dlg.querySelector('.docx-page-tip');
          if (tipEl) tipEl.textContent = `${this.t('wordTip1')} ${this.t('wordTip2')}`;
          const warnEl = dlg.querySelector('.docx-page-warn');
          if (warnEl) warnEl.textContent = this.t('wordBigFileWarn');
          dlg.classList.remove('hidden');
          const done = (val) => { dlg.classList.add('hidden'); resolve(val); };
          const cancels = dlg.querySelectorAll('.docx-page-cancel');
          const okBtn = dlg.querySelector('.docx-page-ok');
          cancels.forEach((btn) => { btn.onclick = () => done(false); });
          if (okBtn) okBtn.onclick = () => done(true);
        });
      },
      // 导出 DOCX 固定页面设置（不再让用户选）：A4 / 纵向 / 标准边距。
      _docxPageConfig() {
        const pageSize = this._docxPageSize('A4', 'portrait');
        const margins = this._docxMargins('normal');
        return {
          pageWidth: pageSize.width, pageHeight: pageSize.height,
          marginTop: margins.top, marginBottom: margins.bottom,
          marginLeft: margins.left, marginRight: margins.right,
          // 图片上限：既有 500px 口径与「页面可用宽度」取较小值（1px=15twips @96dpi），
          // 交给 docx-builder 的 clampImageToPage 做最终钳位，防止可选步骤超时后超宽裁切。
          maxImageWidthPx: Math.max(1, Math.min(WORD_IMG_MAX_PX,
            Math.floor((pageSize.width - margins.left - margins.right) / 15))),
        };
      },
      // 写盘统一入口：Tauri 走 IPC；纯浏览器调试页（无 __TAURI__）降级为 Blob 下载。
      // 不能因为「运行时缺失 / dialogSave 抛错」就让用户一个文件都拿不到。
      async _writeExportBinary(path, bytes) {
        const hasTauri = typeof window !== 'undefined' &&
          !!(window.__TAURI__ && window.__TAURI__.core);
        if (hasTauri) {
          await TauriApi.writeBinaryFile({ path, contents: bytes });
          return;
        }
        const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const blob = new Blob([arr], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        });
        if (typeof URL === 'undefined' || !URL.createObjectURL) {
          throw new Error('浏览器下载不可用：URL.createObjectURL 缺失');
        }
        const url = URL.createObjectURL(blob);
        try {
          const a = document.createElement('a');
          a.href = url;
          a.download = String(path || 'export.docx').split(/[/\\]/).pop() || 'export.docx';
          document.body.appendChild(a);
          a.click();
          a.remove();
        } finally {
          // 立即回收会让部分内核取消下载，延后一拍；一次性定时器，不常驻。
          setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_e) {} }, 1000);
        }
      },
      // 确保 lib/docx.min.js 已加载（定义 window.DocxLib）。
      // index.html 已常驻加载它，但用户若在改动 index.html 前就打开了 dev 页面且没刷新，
      // 旧页面里没有 docx.min.js → window.DocxLib 缺失 → 主路径整条失败、静默降级 altChunk。
      // 这里在导出时兜底按需加载，已加载则秒回；加载带 10s 超时（本地资源，正常几百毫秒）。
      _ensureDocxLibLoaded(timeoutMs = 10000) {
        if (window.DocxLib) return Promise.resolve(true);
        const src = 'lib/docx.min.js';
        if (document.querySelector('script[src="lib/docx.min.js"]')) {
          // 标签在但还没定义全局：等 onload（理论不该发生，等 2s 兜底）。
          return new Promise((resolve) => setTimeout(() => resolve(!!window.DocxLib), 2000));
        }
        return new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = src;
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error('docx 库加载超时'));
          }, timeoutMs);
          const done = (ok) => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); };
          s.onload = () => done(!!window.DocxLib);
          s.onerror = () => { clearTimeout(timer); reject(new Error('docx 库加载失败')); };
          document.head.appendChild(s);
        });
      },
      // 生成 docx（真 OOXML）：主线程直构建（lib/docx.min.js 常驻加载，缺失时按需补加载）。
      // 曾走 Web Worker，但真机上 Worker 不可用会导致整条导出退化成 altChunk（公式全变文字），
      // 可用性优先，直接主线程构建。
      async _buildDocxBuffer(structure, page) {
        await this._ensureDocxLibLoaded();
        if (typeof window.buildDocxFromStructure !== 'function') {
          throw new Error('导出组件未加载（docx-builder 未加载）');
        }
        // 构建若卡住（极端环境缺 Blob 等）不能让导出永远悬着，超时后仍回退 html-docx，保证「导出一定有结果」。
        const MAIN_BUILD_TIMEOUT = 60000;
        let timer = null;
        const timeout = new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error('主线程 docx 构建超时')), MAIN_BUILD_TIMEOUT);
        });
        try {
          const blob = await Promise.race([window.buildDocxFromStructure(structure, page), timeout]);
          return await blob.arrayBuffer();
        } finally {
          clearTimeout(timer);
        }
      },
      async exportWord() {
        // 主路径：docx 库主线程直构建真 OOXML（可编辑公式 + 二进制图片）；
        // html-docx（altChunk）仅在主路径失败时兜底。
  
        // 唯一的确认框：说明导出特性后点「导出」开始（取消即中止）。不再让用户选
        // 纸张/方向/边距——固定 A4/纵向/标准，需要改的人在 Word 里改。
        const proceed = await this._confirmDocxExport();
        if (!proceed) return;
  
        // Loading overlay：导出过程（尤其是 html2canvas 渲染公式/图表）可能阻塞主线程，
        // 给用户一个明确的等待反馈；60s watchdog 兜底防止 overlay 永远不消失。
        const overlay = document.createElement('div');
        overlay.innerHTML = `<div class="pdf-loading-spinner"></div><div class="pdf-loading-text">${this.t('preparingWordExport')}</div>`;
        overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--bg-primary);font-family:-apple-system,sans-serif;';
        this._applyExportOverlayTheme(overlay);
        if (!document.getElementById('pdf-loading-style')) {
          const s = document.createElement('style');
          s.id = 'pdf-loading-style';
          s.textContent = '.pdf-loading-spinner{width:36px;height:36px;border:3px solid var(--border-color);border-top-color:var(--accent-color);border-radius:50%;animation:pdf-spin .7s linear infinite;margin-bottom:14px;}@keyframes pdf-spin{to{transform:rotate(360deg)}}.pdf-loading-text{color:var(--text-primary);font-size:15px;letter-spacing:.5px;}';
          document.head.appendChild(s);
        }
        document.body.appendChild(overlay);
  
        let overlayDone = false;
        let exported = false;
        let exportPath = null;   // 提到外层：catch 里要写诊断文件（真机拿不到 console）
        const hideOverlay = () => {
          if (overlayDone) return;
          overlayDone = true;
          if (overlay.parentNode) overlay.remove();
        };
  
        let watchdog = null;
        try {
          // 先让 overlay 渲染出来，再执行可能较重的同步/阻塞操作。
          // 裸 await rAF 在窗口挂起/不可见时会永不 resolve，整条导出链停在遮罩上，
          // 且此时 watchdog 尚未启动 —— 既不报错也不出文件。超时后继续，正常环境 rAF 先到。
          try {
            await withTimeout(new Promise(r => requestAnimationFrame(r)),
              this._exportFrameTimeoutMs || EXPORT_FRAME_TIMEOUT_MS);
          } catch (_e) { /* 帧回调超时：照常继续 */ }

          const defaultName = this.activeTab.filePath
            ? this.activeTab.filePath.replace(/\.md$/, '.docx')
            : 'export.docx';
          let path = null;
          try {
            path = await dialogSave({
              defaultPath: defaultName,
              filters: [{ name: 'Word 文档', extensions: ['docx'] }]
            });
          } catch (dlgErr) {
            // 纯浏览器调试页没有 __TAURI__，dialogSave 必抛「Tauri 运行时不可用」。
            // 不再因此把整次导出判死：切到浏览器下载（_writeExportBinary 自动识别）。
            const noTauri = typeof window === 'undefined' ||
              !(window.__TAURI__ && window.__TAURI__.core);
            if (!noTauri) throw dlgErr;
            console.warn('[export] 未检测到 Tauri 运行时，导出切换为浏览器下载：', dlgErr && dlgErr.message);
            path = defaultName;
          }
          if (!path) {
            hideOverlay();
            return;
          }
          exportPath = path;
  
          // watchdog 只在「真正开始导出处理」之后才计时，不把用户选文件的时间算进去；
          // 超时放宽到 120s，避免公式/图表多、文档大时导出仍在进行却被误判卡死提前撤掉遮罩。
          watchdog = setTimeout(() => {
            this.setStatus(this.t('exportError'));
            hideOverlay();
          }, 120000);

          // 以下全是「可选增强」：任何一步报错/超时只跳过自己，整份文档照常导出。
          // 亮色导出上下文：无论当前主题，Word 导出（图表重绘/代码高亮）一律亮色
          await safeStep('亮色导出上下文', async () => {
            await this._enterLightExport();
          });

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
          await safeStep('图片尺寸采集', () => {
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
          });

          // 图片拿不到/挂起是最常见的局部故障：超时后直接跳过，不为一张图拖住整份文档。
          await safeStep('图片内联',
            () => this._inlineImagesForExport(clone, this.activeTab.filePath),
            this._exportInlineTimeoutMs || OPTIONAL_STEP_TIMEOUT_MS);
  
          // 把 Web 预览 DOM 预处理成 docx 兼容结构。
          // skipMathImage=true：保留 .katex（其 <math> 供 MathML→OMML 转可编辑公式），
          // 公式转 PNG 仅在 html-docx 回退路径需要（_fallbackWordHtmlExport 内补跑）。
          await safeStep('DOM 预处理', () => this._prepareWordDOM(clone, { skipMathImage: true }));
  
          // 页面设置已在流程开始的弹框里选好（pageCfg），此处不再二次弹框打断导出。
  
          // 用 docx 库生成真 OOXML：DOM → 中间结构 → 主线程构建 Document → toBlob。
          // _buildDocxBuffer 内部保证 docx 库已加载（缺失时按需补加载），主路径失败才回退 altChunk。
          const structure = await safeStep('DOM→docx 结构', () =>
            (typeof window.domToDocxStructure === 'function') ? window.domToDocxStructure(clone) : null);
          const mathConverted = await safeStep('公式转 OMML', () =>
            (structure && Array.isArray(structure)) ? this._structureMathmlToOmml(structure) : false);
          if (structure && Array.isArray(structure) && structure.length > 0 && mathConverted) {
            const page = this._docxPageConfig(); // 固定 A4/纵向/标准边距
            const diag = {
              build: '2026-09-08-r3',
              hasDocxLib: !!window.DocxLib,
              hasBuilder: typeof window.buildDocxFromStructure === 'function',
              hasDomToDocx: typeof window.domToDocxStructure === 'function',
              hasMathML2OMML: typeof MathML2OMML !== 'undefined',
              structureNodes: structure ? structure.length : 0,
              mathConverted,
            };
            try {
              const arrayBufferDocx = await this._buildDocxBuffer(structure, page);
              clearTimeout(watchdog);
              const bufDocx = new Uint8Array(arrayBufferDocx);
              await this._writeExportBinary(path, bufDocx);
              this.setStatus(`${this.t('exportedWord')}: ${path}`);
              exported = true;
            } catch (docxErr) {
              // 明确暴露主路径失败原因（之前静默降级，公式/图片全废却看不出为什么）。
              console.error('[export] docx 主路径失败，降级 html-docx：', docxErr);
              this.setStatus(`${this.t('exportError')}: docx ${docxErr && docxErr.message ? docxErr.message : docxErr}`);
              // 写诊断文件到 docx 同目录，便于用户反馈精准定位（真机上拿不到 console）。
              try {
                const diagText = `TizuMark 导出诊断\n代码版本: ${diag.build}\n\n` +
                  `window.DocxLib: ${diag.hasDocxLib}\n` +
                  `window.buildDocxFromStructure: ${diag.hasBuilder}\n` +
                  `window.domToDocxStructure: ${diag.hasDomToDocx}\n` +
                  `MathML2OMML: ${diag.hasMathML2OMML}\n` +
                  `structure 节点数: ${diag.structureNodes}\n` +
                  `公式是否全部转换: ${diag.mathConverted}\n\n` +
                  `主路径错误: ${docxErr && docxErr.stack ? docxErr.stack : docxErr}\n`;
                const diagPath = path.replace(/\.docx$/i, '_diagnostic.txt');
                await TauriApi.writeFile({ path: diagPath, content: diagText });
                this.showToast('公式导出失败，已生成诊断文件：' + diagPath, 'warning');
              } catch (e) { /* 写诊断文件失败也不阻塞回退 */ }
              await this._fallbackWordHtmlExport(clone, path, watchdog, (ok) => { exported = ok; });
            }
          } else {
            // 主路径前置条件不满足（structure 空 / 公式未转换）：写诊断帮助定位。
            try {
              const diagText = `TizuMark 导出诊断\n代码版本: 2026-09-08-r3\n\n` +
                `走回退原因: ${!structure || !structure.length ? 'structure 为空' : '公式未全部转换(mathConverted=false)'}\n` +
                `window.DocxLib: ${!!window.DocxLib}\n` +
                `MathML2OMML: ${typeof MathML2OMML !== 'undefined'}\n` +
                `structure 节点数: ${structure ? structure.length : 0}\n`;
              await TauriApi.writeFile({ path: path.replace(/\.docx$/i, '_diagnostic.txt'), content: diagText });
            } catch (e) { /* 诊断文件为排查用途，写入失败不阻塞回退导出 */ console.error('[export] 诊断文件写入失败:', e); }
            await this._fallbackWordHtmlExport(clone, path, watchdog, (ok) => { exported = ok; });
          }
        } catch (error) {
          clearTimeout(watchdog);
          console.error('exportWord error:', error);
          const msg = error && error.message ? error.message : String(error);
          // 浏览器直接打开 dev-server 页面（无 Tauri 运行时）时 dialogSave 必然抛错，
          // 这条最容易被误读成「导出功能坏了」，给一句能直接照做的提示。
          if (/Tauri 运行时不可用/.test(msg)) {
            this.setStatus('导出失败：请在 Tauri 应用窗口中使用（浏览器调试页无法保存文件）');
          } else {
            this.setStatus(`${this.t('exportFailed')}: ${msg}`);
          }
          // 落一份诊断文件：真机拿不到 console，下次反馈可直接看错误栈与图片源。
          // 之前只有 docx 主路径失败才写诊断，外层 catch 是盲区，正是「报错却查不到」的原因。
          if (exportPath) {
            try {
              let imgSrcs = '';
              try {
                imgSrcs = Array.from(this.preview.querySelectorAll('img'))
                  .slice(0, 10)
                  .map((im, i) => `  [${i}] ${String(im.getAttribute('src') || '').slice(0, 200)}`)
                  .join('\n');
              } catch (_e) { /* 预览已销毁 */ }
              const diagPath = exportPath.replace(/\.docx$/i, '_diagnostic.txt');
              const diagText = `TizuMark 导出诊断\n` +
                `时间: ${new Date().toISOString()}\n` +
                `Tauri 运行时: ${typeof window !== 'undefined' && !!window.__TAURI__}\n` +
                `目标路径: ${exportPath}\n` +
                `错误: ${msg}\n` +
                `调用栈: ${error && error.stack ? error.stack : '(无)'}\n\n` +
                `预览图片 src（最多 10 条）:\n${imgSrcs || '  (无)'}\n`;
              await TauriApi.writeFile({ path: diagPath, content: diagText });
              this.showToast('导出失败，已生成诊断文件：' + diagPath, 'warning');
            } catch (_e) { /* 写诊断失败不阻塞错误上报 */ }
          }
        } finally {
          // 最终兜底：只要已拿到目标路径且尚未成功写出，就用最简 HTML 再试一次。
          // 图片、公式、图表、样式、甚至整条主链路报错，都不该让用户一个文件都拿不到。
          if (!exported && exportPath) {
            try {
              const minimal = document.createElement('div');
              minimal.innerHTML = this.preview ? this.preview.innerHTML : '';
              minimal.querySelectorAll('script,style,link').forEach((el) => el.remove());
              const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
                minimal.innerHTML + '</body></html>';
              const buf = await this._convertHtmlToDocxBuffer(html);
              await this._writeExportBinary(exportPath, new Uint8Array(buf));
              exported = true;
              this.setStatus(`${this.t('exportedWord')}: ${exportPath}（兼容模式）`);
            } catch (e) {
              console.error('[export] 最终兜底导出失败:', e);
            }
          }
          hideOverlay();
          // 导出真正完成后（写入文件成功）再弹成功提示；先关遮罩，确保 toast 不被遮住。
          if (exported) {
            this.showToast(this.t('exportSuccess'), 'success');
          }
          this._leaveLightExport();
        }
      },
      // 回退路径：用 html-docx 把 HTML altChunk 写入 docx（兼容性较差，仅 docx 生成失败时兜底）。
      async _fallbackWordHtmlExport(clone, path, watchdog, onDone) {
        // DOCX 主路径保留 .katex（转 OMML 可编辑公式）；回退到 Word HTML 导入器时
        // KaTeX/MathML 都不被识别，这里把公式降级为 LaTeX 源码文本（不转图片：公式一律
        // 以可编辑为目标，图片公式不可二次编辑，产品上不提供）。
        this._katexElsToLatexText(clone);
        const escapedTitle = this.activeTab.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        // 公式已降级为 LaTeX 源码文本，不再需要内联 KaTeX CSS（约 300KB，白白撑大 docx）。
        // hljs 高亮 CSS：不再按 this.isDark 设门禁（暗黑模式导出也要亮色高亮），且改走
        // CSSOM 采集——裸 fetch 失败是静默的（导出帧 token 全黑），采集器自带回退。
        let hljsCSS = '';
        try {
          hljsCSS = this._exportStyleFromLink((h) => /highlight|hljs|github/.test(h)).css;
        } catch (e) { /* 高亮主题 CSS 为可选样式，采集失败不阻断导出 */ console.error('[export] 高亮主题 CSS 采集失败:', e); }
        const wordOverride = `
        .alert { background: #f6f5f4; border-left-color: #d4d4d8; }
        .alert-note { background: #eef4ff; border-left-color: #3884ff; }
        .alert-tip { background: #e9f9f1; border-left-color: #10b981; }
        .alert-important { background: #f3edfd; border-left-color: #8b5cf6; }
        .alert-warning { background: #fef6e7; border-left-color: #f59e0b; }
        .alert-caution { background: #fdecec; border-left-color: #ef4444; }
        .mermaid-container { width: 100%; max-width: 100%; box-sizing: border-box; }
        .tizu-math-source { font-family: Consolas, "SF Mono", monospace; background: #f6f5f4; padding: 1px 4px; border-radius: 3px; }`;
        const wordStyle = `${this._documentExportCSS()}\n${wordOverride}\n${hljsCSS ? hljsCSS : ''}`;
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
        try {
          const arrayBuffer = await this._convertHtmlToDocxBuffer(wordHTML);
          const buf = new Uint8Array(arrayBuffer);
          await this._writeExportBinary(path, buf);
          this.setStatus(`${this.t('exportedWord')}: ${path}`);
          onDone(true);
        } catch (error) {
          clearTimeout(watchdog);
          console.error('fallback Word export error:', error);
          this.setStatus(`${this.t('exportFailed')}: ${error}`);
          onDone(false);
        }
      },
      // 长图导出（2026-10-25 重做，换掉 html2canvas）
      //
      // 原实现用 html2canvas 把 DOM 重画到 canvas。它自带一套 CSS 解析与绘制器，不支持
      // MathML、clip-path、color-mix()、部分 flex 与伪元素 —— 那套渲染器和 Blink 不可能
      // 逐像素对齐，于是「导出长图与阅读模式差异太大」。现改为 <svg><foreignObject> 方案：
      // 内容交给浏览器自己的排版引擎渲染，再 drawImage 到 canvas，CSS / 字体 / 公式 / 图表
      // 全部由 Blink 计算，与阅读模式同源同参。
      //
      // 三个必须处理的差异：
      //  · SVG-as-image 是受限环境，**不能加载任何外部资源**：KaTeX 的 woff2 必须内联成
      //    data URI（否则公式字形退化成 Times New Roman），图片沿用 _inlineImagesForExport；
      //  · 独立 SVG 文档里没有 <html>/<body>：主题变量靠 `:root`（命中 <svg> 根）继承，
      //    再加包裹元素自带 data-theme / data-color-scheme 命中 [data-theme=...] 规则；
      //  · SVG 走 XML 解析，必须用 XMLSerializer 输出 well-formed XHTML（innerHTML 里
      //    的 <br> 这类未闭合标签会直接让整张图渲染失败）；
      //  · canvas 单边 ≤ 32767px、面积约 ≤ 268MP：超长文档按此自动降 scale（不裁内容）。
      async exportImage() {
        const result = await dialogSave({
          defaultPath: `${this.activeTab.name.replace(/\.[^.]+$/, '')}.png`,
          filters: [{ name: 'PNG', extensions: ['png'] }]
        });
        if (!result) return; // 先问路径：避免渲染几十秒后用户才取消

        let overlayOn = false;
        let host = null;
        let expandStyle = null;
        let imgExported = false;
        try {
          overlayOn = true;
          this._showExportOverlay(this.t('generatingImg'));
          await new Promise(r => requestAnimationFrame(r));
          // 亮色导出上下文：无论当前主题，长图一律亮色（见 _enterLightExport 注释）
          await this._enterLightExport();

          // ---- 1) 离屏宿主：在本文档内，样式与阅读模式同源，用于度量与图片内联 ----
          const source = this.preview.cloneNode(true);
          source.querySelectorAll('.copy-btn').forEach(el => el.remove());
          const abbrData = source.querySelector('#abbr-data');
          if (abbrData) abbrData.remove();
          this._stripKatexMathml(source);

          const theme = document.documentElement.getAttribute('data-theme') || 'light';
          const colorScheme = document.documentElement.getAttribute('data-color-scheme') || 'default';
          host = document.createElement('div');
          host.id = 'tm-png-export-root';
          host.className = source.getAttribute('class') || 'preview-content';
          host.setAttribute('data-theme', theme);
          host.setAttribute('data-color-scheme', colorScheme);
          host.style.cssText = 'position:fixed;left:-99999px;top:0;width:800px;height:auto;overflow:visible;';
          host.innerHTML = source.innerHTML;
          document.body.appendChild(host);

          // 展开所有滚动/裁切容器（与 PDF/DOCX 共用口径），否则长图只能截到一屏
          expandStyle = document.createElement('style');
          expandStyle.id = 'tm-export-expand-style';
          expandStyle.textContent = this._exportExpandRules('#tm-png-export-root');
          document.head.appendChild(expandStyle);

          await this._inlineImagesForExport(host, this.activeTab.filePath);
          // 图表亮色重绘：预览里的 mermaid SVG 颜色按当时主题内联，切主题救不了（见公共注释）
          if (host.querySelector('.mermaid-container')) {
            await this._rerenderMermaidLightInClone(host, 'png-mermaid-',
              getComputedStyle(document.documentElement).getPropertyValue('--font-preview').trim() || '-apple-system, sans-serif');
          }
          await this._waitImagesReady(host);
          await new Promise(r => setTimeout(r, 60));

          // 超宽内容（超宽公式/宽表展开后）按内容宽度兜底，保证不裁切
          const W = Math.max(800, Math.ceil(host.scrollWidth));
          host.style.width = W + 'px';
          await new Promise(r => requestAnimationFrame(r));
          const H = Math.ceil(Math.max(host.scrollHeight, host.getBoundingClientRect().height));
          if (!(H > 8)) throw new Error('导出内容为空（高度 ' + H + 'px）');
          const bg = getComputedStyle(host).backgroundColor || '#ffffff';

          // ---- 2) 样式：CSSOM 直读（不走网络）+ KaTeX 字体 data URI 内联 ----
          const appSheet = this._exportStyleFromLink((h) => /(^|\/)styles\.css(\?|$)/.test(h));
          const katexSheet = this._exportStyleFromLink((h) => /katex/.test(h) && /\.css(\?|$)/.test(h));
          const hljsThemeEl = document.getElementById('highlight-theme');
          const hljsHref = ((hljsThemeEl && hljsThemeEl.getAttribute('href')) || '').toLowerCase();
          const hljsSheet = this._exportStyleFromLink((h) => (hljsHref ? h.endsWith(hljsHref) : /highlight|hljs|github/.test(h)));
          const customFontStyleEl = document.getElementById('custom-fonts-style');
          const customFontCSS = customFontStyleEl ? (customFontStyleEl.textContent || '') : '';

          const appCSS = this._absolutizeCssUrls(appSheet.css, appSheet.base);
          const hljsCSS = this._absolutizeCssUrls(hljsSheet.css, hljsSheet.base);
          const katexCSS = await this._inlineCssFonts(katexSheet.css, katexSheet.base);

          // ---- 3) 组装 SVG：样式塞进宿主内部一起序列化（XMLSerializer 会正确转义 CSS 里的 < &） ----
          // ⚠️ _exportExpandRules 必须跟着进这份 style：SVG-as-image 是**独立渲染环境**，
          // document.head 里的 expandStyle（度量阶段用的）序列化后不存在 —— 而采集进来的
          // appCSS 是完整 styles.css，自带 .code-scroll{max-height:300px;overflow-y} 与
          // pre 的滚动/裁切规则，不加展开规则等于「度量时展开、成图时又缩回去」：长图里
          // 代码块再次只剩 300px + 滚动条（2026-10-26 用户截图复现）。scope 用 ''：host
          // 序列化后就是 foreignObject 的根，全文档作用域恰好等于宿主内部作用域。
          const expandCSSForSvg = this._exportExpandRules('');
          const styleEl = document.createElement('style');
          // 尾部追加 color-scheme:light：SVG 里 `:root` 命中 <svg> 根，独立渲染环境不带
          // 主文档的内联 color-scheme，必须自带（否则暗色 UA 画布语义渗进 SVG 渲染）。
          styleEl.textContent = customFontCSS + appCSS + hljsCSS + katexCSS + expandCSSForSvg + ':root { color-scheme: light !important; }';
          host.insertBefore(styleEl, host.firstChild);
          // 清掉离屏定位等宿主专用内联样式，只留排版必需的宽度/背景/取消内部滚动
          host.setAttribute('style', `width:${W}px;height:auto;overflow:visible;background:${bg};`);
          const contentXML = new XMLSerializer().serializeToString(host);
          styleEl.remove();

          const svgMarkup = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '">'
            + '<foreignObject x="0" y="0" width="' + W + '" height="' + H + '">'
            + contentXML
            + '</foreignObject></svg>';

          // 必须用 data: URL 而不是 blob: —— 实测（Chromium）blob: 形式的 SVG 画进 canvas 后
          // 画布即被标记为 tainted，toDataURL 直接抛 SecurityError；同样的内容换成 data: 就正常。
          // 用 base64 而非 encodeURIComponent：CSS + 内联字体的体积大，base64 只涨 1/3。
          const svgBytes = new TextEncoder().encode(svgMarkup);
          let svgBin = '';
          for (let i = 0; i < svgBytes.length; i += 0x8000) {
            svgBin += String.fromCharCode.apply(null, svgBytes.subarray(i, i + 0x8000));
          }
          const svgDataUrl = 'data:image/svg+xml;base64,' + btoa(svgBin);
          const img = new Image();
          await new Promise((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('SVG 渲染失败（内容过大或样式异常）'));
            img.src = svgDataUrl;
          });

          // ---- 4) 画到 canvas：按浏览器上限自动降 scale ----
          const MAX_SIDE = 32767;
          const MAX_AREA = 268000000;
          let scale = 2;
          scale = Math.min(scale, MAX_SIDE / W, MAX_SIDE / H, Math.sqrt(MAX_AREA / (W * H)));
          scale = Math.max(scale, 0.05);

          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(W * scale));
          canvas.height = Math.max(1, Math.round(H * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('canvas 2d context 不可用');
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          const imgData = canvas.toDataURL('image/png');
          if (!imgData || imgData.length < 128) throw new Error('长图编码失败（可能超出 canvas 上限）');

          // ---- 5) 落盘 ----
          const base64 = imgData.split(',')[1];
          const binaryStr = atob(base64);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
          await TauriApi.writeBinaryFile({ path: result, contents: Array.from(bytes) });
          imgExported = true;

          this.setStatus(`${this.t('exportedImg')}: ${result}`);
        } catch (error) {
          this.setStatus(`${this.t('exportFailed')}: ${error}`);
          console.error('[exportImage]', error);
        } finally {
          if (expandStyle && expandStyle.parentNode) expandStyle.parentNode.removeChild(expandStyle);
          if (host && host.parentNode) host.parentNode.removeChild(host);
          if (overlayOn) this._hideExportOverlay();
          // 2026-10-26 用户反馈：长图导出完成后没有任何成功提示。与 HTML/DOCX/PDF 同口径：
          // 先关遮罩再弹 toast，且只在写盘成功后弹。
          if (imgExported) this.showToast(this.t('exportSuccess'), 'success');
          this._leaveLightExport();
        }
      },
      // PrintToPdf 能力检测：ICoreWebView2_7::PrintToPdf 随 WebView2 运行时 101.x（2022-05）
      // 发布，WebView2 的 UA Chrome/ 主版本即运行时内核版本（Chromium 101 = 接口齐备）。
      // UA 解析不到（非 WebView2 环境 / 未来 UA 变化）按**支持**处理：走 PrintToPdf 主路径，
      // 真失败再报错——宁可报错也不冒进回退（2026-10-26 用户反馈：PDF 被占用时弹系统打印
      // 对话框体验割裂，回退只准给「确实没能力」的老运行时）。
      _supportsPrintToPdf() {
        try {
          const m = /Chrome\/(\d+)/.exec(navigator.userAgent || '');
          if (m) return parseInt(m[1], 10) >= 101;
        } catch (_e) { /* fallthrough */ }
        return true;
      },
      // PDF 导出（2026-10-25 重做；2026-10-26 二轮：白纸语义 + 成功 toast；三轮：按能力分流回退）。
      //
      // 旧路径：iframe.srcdoc + contentWindow.print() —— 会拉起 Chromium 打印预览，用户
      // 「另存为 PDF」走的是浏览器下载管线，窗口右上角会弹出 Edge 风格的下载气泡（用户反馈）；
      // 而且打印帧是另建的文档，appCSS / katex / hljs 全靠手工拼进去，拼漏一项就与阅读模式
      // 不一致（用户反馈的公式出现第二份纯文本、代码高亮丢失都出在这条路上）。
      //
      // 现路径：先选保存路径 → 把预览搬进 body 直下的 #pdf-print-root、隐藏其余 UI →
      // 调 Rust 的 print_to_pdf（WebView2 PrintToPdf）直接写文件。全程无对话框、无下载气泡，
      // 样式就是当前文档那一套（同一个文档、同一份 styles.css），与阅读模式天然一致。
      // 2026-10-26 用户要求**彻底移除**系统打印回退（PrintToPdf 落盘失败——如目标 PDF 被
      // 占用——时回退会突然弹出系统打印对话框，体验割裂）：失败就明确报错。
      async exportPDF() {
        // 能力分流（2026-10-26 用户四轮要求）：**弹确认框之前**先检测运行时是否支持
        // PrintToPdf，按结果弹对应的弹框——
        //   支持（主路径）：DOCX 同风格的柔和提示，大文件警示用琥珀色（soft），无红色警示块；
        //   不支持（极旧 WebView2，将走系统打印回退）：才弹红色警示块，说明会弹出系统
        //   打印对话框、需在其中选「另存为 PDF」。
        const capable = this._supportsPrintToPdf();
        // 排版与导出 DOCX 弹框完全一致：说明文字合并为一段（tip1 + 空格 + tip2）、
        // 大文件警示在说明**之后**（warning 块位于 message 下方）、确认键文案「导出」。
        const proceed = await this.showConfirmDialog(
          this.t('exportPDF'),
          this.t('pdfTip1') + ' ' + this.t('pdfTip2'),
          null,
          capable ? this.t('pdfBigFileWarn') : this.t('pdfPrintFallbackWarn'),
          capable ? 'soft' : 'danger',
          this.t('exportBtn'),
        );
        if (!proceed) return;

        const pdfBaseName = String(this.activeTab.name || '').replace(/\.[^.]+$/, '');
        const safeBaseName = pdfBaseName || this.t('untitled') || 'document';
        // 先问路径：PrintToPdf 直接落盘，不再依赖系统打印对话框的默认文件名
        const targetPath = await dialogSave({
          defaultPath: this.activeTab.filePath
            ? this.activeTab.filePath.replace(/\.[^./\\]+$/, '.pdf')
            : safeBaseName + '.pdf',
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });
        if (!targetPath) return;

        this._showExportOverlay(this.t('preparingPrint'));
        let clone = null;
        let printRoot = null;
        let printStyle = null;
        let expandStyle = null;
        let savedTheme = null;
        let savedColorScheme = null;
        let savedHljsHref = null;
        let pdfExported = false;
        let handedOverToPrint = false;
        const escapedTitle = safeBaseName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        // capable 已在确认框前检测（见方法开头）。
        // 恢复快照必须在任何可能提前 throw 之前捕获——否则 finally 的恢复逻辑会
        // 把用户当前主题/hljs 误当成「未设置」清掉（removeAttribute 的危险分支）。
        const rootEl0 = document.documentElement;
        savedTheme = rootEl0.getAttribute('data-theme');
        savedColorScheme = rootEl0.style.getPropertyValue('color-scheme') || null;
        const hljsLink0 = document.getElementById('highlight-theme');
        savedHljsHref = hljsLink0 ? hljsLink0.getAttribute('href') : null;
        try {
          await new Promise(r => requestAnimationFrame(r));
          if (!capable) {
            const err = new Error('runtime lacks PrintToPdf');
            err.__noPrintToPdf = true;
            throw err;
          }

          // 白纸语义（2026-10-26 用户二轮反馈：PDF 页面必须是白色背景）：打印态强制亮色
          // 外观 —— 暗色主题的浅色文字印在白纸上不可读（mermaid 也按亮色重绘，见
          // _preparePdfClone）；配色方案保持用户所选，内容底色由下方字面量 #fff 兜底，
          // 不依赖任何 CSS 变量解析。恢复在 finally。
          const rootEl = document.documentElement;
          savedTheme = rootEl.getAttribute('data-theme');
          rootEl.setAttribute('data-theme', 'light');
          // color-scheme 必须同切：theme.js 把 color-scheme:dark 写成了 html **内联样式**
          //（优先级高于 CSS），只切 data-theme 时 Chromium 仍按暗色 UA 语义渲染画布
          //（PDF 黑边 #121212 的根因）。恢复在 finally（快照已在 try 外捕获）。
          try { rootEl.style.colorScheme = 'light'; } catch (_e) { /* 极旧内核无此属性，忽略 */ }
          const hljsLink = document.getElementById('highlight-theme');
          savedHljsHref = hljsLink ? hljsLink.getAttribute('href') : null;
          if (hljsLink && /dark/i.test(savedHljsHref || '')) {
            hljsLink.href = 'lib/highlight.js/github.min.css';
            await new Promise((res) => {
              let done = false;
              const fin = () => { if (!done) { done = true; res(); } };
              hljsLink.addEventListener('load', fin, { once: true });
              hljsLink.addEventListener('error', fin, { once: true });
              setTimeout(fin, 1500);
            });
          }

          clone = await this._preparePdfClone();

          // ---- 打印态：预览独占页面，其余 UI 全部隐藏（finally 里原样复原）----
          printRoot = document.createElement('div');
          printRoot.id = 'pdf-print-root';
          printRoot.className = clone.getAttribute('class') || 'preview-content';
          printRoot.innerHTML = clone.innerHTML;
          printRoot.style.cssText = 'width:680px;margin:0 auto;box-sizing:border-box;';
          document.body.appendChild(printRoot);

          printStyle = document.createElement('style');
          printStyle.id = 'tm-pdf-print-style';
          // 注意 body > * 的优先级：这里一律用 ID 选择器回显需要保留的两块（#pdf-print-root /
          // #tm-export-overlay），否则会被 `body > *` 的 display:none 一起吞掉。
          printStyle.textContent = `
    html.pdf-printing, body.pdf-printing { height: auto !important; overflow: visible !important; }
    /* 白纸语义（2026-10-26 用户二轮反馈，必须解决）：PrintToPdf 会把背景印出来，body 的
       应用底色成了 PDF 页面画布色（用户实测：内容列白、页面其余全灰）。html/body 与内容
       根容器一律**字面量 #fff**——不随主题变量漂移，连同页面物理边距区域一起覆盖。
       暗色主题已由 data-theme=light 强制亮色。 */
    html.pdf-printing, html.pdf-printing body { background: #fff !important; }
    #pdf-print-root { background: #fff !important; }
    /* 关键：body 有 transition: background-color .3s ease（styles.css body 规则）——强制
       亮色/白底后颜色是**渐变过渡**，实测 300ms 才到白；PrintToPdf 在类翻转后约 100ms
       快照，会把**过渡中的灰色**印进 PDF（真机 timeline 实测：45ms 间隔采样
       32→81→181→222→244→253→255）。打印态全局禁用 transition，白底即刻生效。 */
    html.pdf-printing, html.pdf-printing body, html.pdf-printing * { transition: none !important; }
    /* color-scheme 同切（内联 color-scheme:dark 不切掉时 UA 按暗色语义画画布/滚动条/表单件）：
       只能加在屏幕规则区，@media print 块内有 400/500 字符窗口断言，勿动 */
    html.pdf-printing { color-scheme: light !important; }
    html.pdf-printing body > * { display: none !important; }
    html.pdf-printing #pdf-print-root { display: block !important; overflow: visible !important; height: auto !important; }
    /* 进度遮罩要留在屏幕上，但绝不能被打进 PDF（@media print 只作用于打印渲染） */
    html.pdf-printing #tm-export-overlay { display: flex !important; }
    /* 打印媒体里必须再声明一遍：styles.css 自带 @media print 块（8121 行起，旧「直接打印主窗口」
       方案的遗留）会用 #app{display:block!important} 把整个应用重新显示出来 —— ID 选择器 +
       !important 压得过 body > *，结果 PDF 第一页直接印出标签栏和整块预览（实测）。 */
    @media print {
      html.pdf-printing body > * { display: none !important; }
      html.pdf-printing #app { display: none !important; }
      html.pdf-printing #pdf-print-root { display: block !important; }
      /* 必须与上面屏幕规则的**同一选择器**（同特异性、后声明）才能压过它 ——
         只写 #tm-export-overlay 会因特异性更低而输，遮罩照样被印进 PDF（实测）。 */
      html.pdf-printing #tm-export-overlay { display: none !important; }
    }
    #pdf-print-root .mermaid-container { margin: 8px 0 !important; max-width: 100% !important; page-break-inside: avoid; }
    #pdf-print-root .mermaid-container svg { width: auto !important; max-width: 100% !important; height: auto !important; display: block !important; margin: 0 auto !important; }
    #pdf-print-root h1, #pdf-print-root h2, #pdf-print-root h3 { page-break-after: avoid; }
    #pdf-print-root blockquote, #pdf-print-root table, #pdf-print-root img,
    #pdf-print-root .math-display, #pdf-print-root .alert, #pdf-print-root .mermaid-container { page-break-inside: avoid; }
    #pdf-print-root p, #pdf-print-root li { orphans: 3; widows: 3; }`;
          document.head.appendChild(printStyle);

          // 展开所有滚动/裁切容器（与长图 / DOCX 同一口径），否则打印只出可视区那一屏
          expandStyle = document.createElement('style');
          expandStyle.id = 'tm-export-expand-style';
          expandStyle.textContent = this._exportExpandRules('#pdf-print-root');
          document.head.appendChild(expandStyle);

          document.documentElement.classList.add('pdf-printing');
          document.body.classList.add('pdf-printing');
          await this._waitImagesReady(printRoot);
          await new Promise(r => requestAnimationFrame(r));
          await new Promise(r => setTimeout(r, 80));

          // A4 = 8.27 × 11.69 英寸；1.5cm ≈ 0.59 英寸（与原 @page margin 保持一致）
          await TauriApi.printToPdf({
            options: {
              path: targetPath,
              pageWidth: 8.27,
              pageHeight: 11.69,
              marginTop: 0.59,
              marginBottom: 0.59,
              marginLeft: 0.59,
              marginRight: 0.59,
            },
          });
          pdfExported = true;
          this.setStatus(`${this.t('exportedPDF')}: ${targetPath}`);
        } catch (e) {
          if (capable) {
            // 运行时明明支持 PrintToPdf 还失败（PDF 被占用 / 磁盘错误等）——明确报错，
            // 绝不弹系统打印对话框（2026-10-26 用户反馈的割裂体验）。
            console.error('[exportPDF] PrintToPdf 失败:', e);
            // 失败必须**看得见**：左下角状态栏容易被忽略，同步弹 danger toast（2026-10-27
            // 用户反馈"导出没有成功提示"实际是因为失败只落在状态栏）
            const msg = `${this.t('exportFailed')}: ${e && e.message ? e.message : e}`;
            this.setStatus(msg);
            this.showToast(msg, 'danger');
          } else {
            // 极旧 WebView2 运行时（无 ICoreWebView2_7::PrintToPdf）：按用户指示回退
            // 系统打印，功能不丢。回退路径自行管理遮罩（afterprint/30s 收尾时隐藏）。
            handedOverToPrint = true;
            try {
              const fallbackClone = clone || await this._preparePdfClone();
              const html = await this._buildPdfPrintFrameHtml(fallbackClone);
              await this._exportViaSystemPrint(html, safeBaseName, escapedTitle, () => this._hideExportOverlay());
            } catch (e2) {
              console.error('exportPDF fallback error:', e2);
              const fbMsg = `${this.t('exportFailed')}: ${e2 && e2.message ? e2.message : e2}`;
              this.setStatus(fbMsg);
              this.showToast(fbMsg, 'danger');
              this._hideExportOverlay();
            }
          }
        } finally {
          const rootEl = document.documentElement;
          if (savedTheme !== null) rootEl.setAttribute('data-theme', savedTheme);
          else rootEl.removeAttribute('data-theme');
          if (savedColorScheme !== null) rootEl.style.colorScheme = savedColorScheme;
          else { try { rootEl.style.removeProperty('color-scheme'); } catch (_e) {} }
          const hljsLink = document.getElementById('highlight-theme');
          if (hljsLink && savedHljsHref) hljsLink.href = savedHljsHref;
          // mermaid 已按亮色/loose 重初始化过（_preparePdfClone），还原预览配置（theme 按
          // 还原后的实际主题、strict），否则暗色模式下导出完 PDF 预览里新图表全变亮色。
          if (this._lightMermaidTouched) {
            this._lightMermaidTouched = false;
            this._restoreMermaidPreviewConfig();
          }
          document.documentElement.classList.remove('pdf-printing');
          document.body.classList.remove('pdf-printing');
          if (printStyle && printStyle.parentNode) printStyle.parentNode.removeChild(printStyle);
          if (expandStyle && expandStyle.parentNode) expandStyle.parentNode.removeChild(expandStyle);
          if (printRoot && printRoot.parentNode) printRoot.parentNode.removeChild(printRoot);
          if (!handedOverToPrint) {
            // 先关遮罩再弹成功提示（DOCX/HTML 同口径：toast 不能被遮罩盖住）。
            // 回退路径的完成时机在系统打印对话框关闭后（afterprint），遮罩由其自管。
            this._hideExportOverlay();
            if (pdfExported) this.showToast(this.t('exportSuccess'), 'success');
          }
        }
      },
      // PDF 用的 clone 准备：去交互件、摘 MathML 副本、图片内联、Mermaid 按固定 viewBox 重绘。
      // PrintToPdf 与回退系统打印两条路径共用，避免口径分叉。
      async _preparePdfClone() {
        const clone = this.preview.cloneNode(true);
        clone.querySelectorAll('.copy-btn, #abbr-data').forEach(el => el.remove());
        // 摘掉 KaTeX 的 MathML 副本：打印管线一旦不认 clip-path，它就会平铺成第二份公式文本
        this._stripKatexMathml(clone);
        await this._inlineImagesForExport(clone, this.activeTab.filePath);

        // 图表一律按亮色 default 主题重绘：纸面是白底，暗色主题的浅色线条在白纸上几乎不可见。
        // 实现已抽到公共 _rerenderMermaidLightInClone（HTML / 长图同口径），字体链保持 PDF 专属。
        await this._rerenderMermaidLightInClone(clone, 'pdf-mermaid-', this._exportPdfFontStack());
        return clone;
      },
      // 回退路径用：把 clone 组装成独立打印帧 HTML（完整 appCSS + 亮色 hljs + katex + 打印补充）
      // async：hljs 亮色主题要优先取原文（见下方注释）。
      async _buildPdfPrintFrameHtml(clone) {
        const name = String(this.activeTab.name || '').replace(/\.[^.]+$/, '') || 'document';
        const escapedTitle = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const colorScheme = document.documentElement.getAttribute('data-color-scheme') || 'default';
        const appSheet = this._exportStyleFromLink((h) => /(^|\/)styles\.css(\?|$)/.test(h));
        const katexSheet = this._exportStyleFromLink((h) => /katex/.test(h) && /\.css(\?|$)/.test(h));
        const appCSS = this._absolutizeCssUrls(appSheet.css, appSheet.base);
        const katexCSS = this._absolutizeCssUrls(katexSheet.css, katexSheet.base);
        // hljs：本帧钉死 light 纸面（data-theme="light"），必须配**亮色**主题 ——
        // styles.css 里只有 token 映射说明、没有 .hljs-* 配色，缺主题就是一片纯黑；
        // 而暗色主题的 token 色印在白纸上又几乎看不见（用户反馈过「暗黑模式导出 PDF
        // 代码块文字发灰看不清」）。故优先取亮色主题原文，取不到才退回当前加载主题。
        const hljsCSS = (await this._loadStylesheetText('lib/highlight.js/github.min.css'))
          || this._exportStyleFromLink((h) => /github|highlight|hljs/.test(h)).css;
        const customFontStyleEl = document.getElementById('custom-fonts-style');
        const customFontCSS = customFontStyleEl ? (customFontStyleEl.textContent || '') : '';

        const printCSS = `
    @page { margin: 1.5cm; }
    html, body { margin: 0 !important; padding: 0 !important; background: white !important; color-scheme: light !important; }
    .preview-content { max-width: 680px !important; margin: 0 auto !important; padding: 16px 24px !important; font-family: ${this._exportPdfFontStack()} !important; background: #fff !important; } /* 白纸语义：钉死纯白，nord 等方案的灰紫 --preview-bg 不得漏进来（2026-10-26） */
    ${this._exportExpandRules('.preview-content')}
    .preview-content pre code.hljs,
    .preview-content pre .hljs { background: transparent !important; padding: 12px 16px !important; }
    .code-line { display: flex !important; line-height: 1.8 !important; min-width: 0 !important; }
    .code-line-num { flex-shrink: 0 !important; width: 3em !important; text-align: right !important; padding-right: 0.8em !important; color: #888 !important; user-select: none !important; display: none !important; }
    .preview-content.code-line-numbers .code-line-num { display: inline !important; }
    .code-line-text { flex: 1 1 auto !important; min-width: 0 !important; }
    .mermaid-container { margin: 8px 0 !important; max-width: 100% !important; overflow: hidden !important; break-inside: avoid; page-break-inside: avoid; }
    .mermaid-container svg { width: auto !important; max-width: 100% !important; height: auto !important; display: block !important; margin: 0 auto !important; }
    h1, h2, h3 { page-break-after: avoid; }
    blockquote, table, img, .math-display, .alert, .mermaid-container { page-break-inside: avoid; }
    p, li { orphans: 3; widows: 3; }
    input[type="checkbox"] { -webkit-appearance: none; appearance: none; margin-right: 8px; width: 16px; height: 16px; border: 1.5px solid #d4d4d8; border-radius: 3px; vertical-align: middle; position: relative; top: -1px; cursor: default; }
    input[type="checkbox"]:checked { background: #16a34a; border-color: #16a34a; }
    input[type="checkbox"]:checked::after { display: none !important; }`;

        return `<!DOCTYPE html>
    <html lang="zh-CN" data-color-scheme="${colorScheme}" data-theme="light">
    <head><meta charset="UTF-8"><title>${escapedTitle}</title>
    <style>${customFontCSS}${appCSS}${hljsCSS}${katexCSS}${printCSS}</style></head>
    <body>
    <div class="${clone.getAttribute('class') || 'preview-content'}">${clone.innerHTML}</div>
    </body></html>`;
      },
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
      },
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
      },
  };

  const statics = {
      // 纯函数：计算 canvas/imageData 的裁剪边界（去除四周空白/透明/背景色）。
      // 返回 { x, y, w, h }；若全空返回 null。
      _computeTrimBounds(data, width, height, { backgroundColor = null, padding = 4, tolerance = 15 } = {}) {
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
      },
  };

  const api = { mixin, statics };
  window.TMExport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
