// 导出 HTML / Word / PDF / 图片
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';
  const { dialogSave } = TMConst;

  const mixin = {
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
              // 网络图片：下载内联为 base64，保证导出的 HTML 离线（换目录/断网）也能显示。
              // 走浏览器 fetch（blob.type 携带真实 mime，避免按扩展名猜错）；
              // 下载失败（离线/超时）时保留原 URL，至少联网打开仍可见。
              try {
                const resp = await fetch(src);
                if (resp.ok) {
                  const blob = await resp.blob();
                  dataUri = await blobToDataUri(blob);
                }
              } catch (_e) { /* 离线或网络异常：保留原 src */ }
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
          // mermaid.initialize 失败不致命：下方 mermaid.render 有独立 try/catch，且初始化异常不应阻断导出
          try { mermaid.initialize({ startOnLoad: false, theme: this.isDark ? 'dark' : 'default', securityLevel: 'loose', fontFamily: ff, themeVariables: { fontSize: '14px' } }); } catch (e) { console.error('[export] mermaid.initialize 失败（不影响导出）:', e); }
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
          this._applyWordImgSize(img, natW, natH, 500, dispW > 0 ? dispW : natW);
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
        };
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
  
          // 把 Web 预览 DOM 预处理成 docx 兼容结构。
          // skipMathImage=true：保留 .katex（其 <math> 供 MathML→OMML 转可编辑公式），
          // 公式转 PNG 仅在 html-docx 回退路径需要（_fallbackWordHtmlExport 内补跑）。
          await this._prepareWordDOM(clone, { skipMathImage: true });
  
          // 页面设置已在流程开始的弹框里选好（pageCfg），此处不再二次弹框打断导出。
  
          // 用 docx 库生成真 OOXML：DOM → 中间结构 → 主线程构建 Document → toBlob。
          // _buildDocxBuffer 内部保证 docx 库已加载（缺失时按需补加载），主路径失败才回退 altChunk。
          const structure = (typeof window.domToDocxStructure === 'function')
            ? window.domToDocxStructure(clone)
            : null;
          const mathConverted = (structure && Array.isArray(structure))
            ? this._structureMathmlToOmml(structure)
            : false;
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
              await TauriApi.writeBinaryFile({ path, contents: bufDocx });
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
          this.setStatus(`${this.t('exportFailed')}: ${error}`);
        } finally {
          hideOverlay();
          // 导出真正完成后（写入文件成功）再弹成功提示；先关遮罩，确保 toast 不被遮住。
          if (exported) {
            this.showToast(this.t('exportSuccess'), 'success');
          }
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
        let hljsCSS = '';
        if (!this.isDark) {
          try {
            const themeLink = document.getElementById('highlight-theme');
            if (themeLink) {
              const resp = await fetch(themeLink.getAttribute('href'));
              if (resp.ok) hljsCSS = await resp.text();
            }
          } catch (e) { /* 高亮主题 CSS 为可选样式，拉取失败不阻断导出 */ console.error('[export] 高亮主题 CSS 拉取失败:', e); }
        }
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
          await TauriApi.writeBinaryFile({ path, contents: buf });
          this.setStatus(`${this.t('exportedWord')}: ${path}`);
          onDone(true);
        } catch (error) {
          clearTimeout(watchdog);
          console.error('fallback Word export error:', error);
          this.setStatus(`${this.t('exportFailed')}: ${error}`);
          onDone(false);
        }
      },
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
      },
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
            const ff = this._exportPdfFontStack();
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
          // 自定义字体的 @font-face（base64 内联）由 #custom-fonts-style 持有。打印帧是独立文档，
          // 必须一并携带，否则用户选了自定义预览字体时，字体链首项在 PDF 里无字形可落。
          const customFontStyleEl = document.getElementById('custom-fonts-style');
          const customFontCSS = customFontStyleEl ? (customFontStyleEl.textContent || '') : '';
  
          // escapedTitle：用于打印帧 <title> / contentDocument.title（去扩展名文件名已在上文取得）
          const escapedTitle = safeBaseName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  
          const colorScheme = document.documentElement.getAttribute('data-color-scheme') || 'default';
  
          const printCSS = `
    @page { margin: 1.5cm; }
    html, body { margin: 0 !important; padding: 0 !important; background: white !important; }
    .preview-content { max-width: 680px !important; margin: 0 auto !important; padding: 16px 24px !important; font-family: ${this._exportPdfFontStack()} !important; }
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
    <style>${customFontCSS}${appCSS}${hljsCSS}${katexCSS}${printCSS}</style></head>
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
