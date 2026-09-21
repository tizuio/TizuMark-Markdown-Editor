// 灯箱、外链、拖放与插入对话框
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';
  const { Tab, dialogOpen } = TMConst;

  const mixin = {
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
      },
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
      },
      showImageLightbox(src) {
        this.showLightbox(src, 'image');
      },
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
      },
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
      },
      showSaveDialog(title, message, saveLabel, discardLabel, cancelLabel) {
        return Dialogs.showSaveDialog({
          title, message, saveLabel, discardLabel, cancelLabel,
          t: (k, p) => this.t(k, p),
          doc: document,
        });
      },
      showConfirmDialog(title, message, action = null, warning = null) {
        return Dialogs.showConfirmDialog({
          title, message, action, warning,
          t: (k, p) => this.t(k, p),
          showToast: (msg, type) => this.showToast(msg, type),
          doc: document,
        });
      },
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
      },
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
      },
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
      },
      hideInsertLinkDialog() {
        document.getElementById('insert-link-dialog').classList.add('hidden');
      },
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
      },
      hideInsertImageDialog() {
        document.getElementById('insert-image-dialog').classList.add('hidden');
      },
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
      },
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
      },
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
      },
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
      },
    // 工具栏下拉菜单的展开/切换/延时收起
    initToolbarMenus() {
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
    },
    // 关于/更新对话框关闭与外链徽章
    initDialogDismiss() {
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
    },
  };

  const api = { mixin };
  window.TMMiscUI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
