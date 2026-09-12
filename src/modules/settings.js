// 设置读写、持久化与设置面板
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';
  const { Tab } = TMConst;

  const mixin = {
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
          clearTabsOnQuit: false, // 退出应用时不保存标签会话，下次打开总是空白
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
          // 框架界面字号（侧栏/工具栏/弹窗/菜单/标签/状态栏等 chrome），范围 11–18px，默认 13px
          uiFontSize: 13,
          // 预览/编辑正文基础字重：300/400/500/600（严格小于加粗档 700），默认 400
          previewFontWeight: 400,
          editorFontWeight: 400,
          customBgEnabled: false, // 自定义页面底色开关：开启时编辑+预览区用 customBgColor，文字按亮度反色
          customBgColor: '#f8f7f4', // 自定义底色（16 进制 RGB）
        };
      },
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
      },
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
      },
      // 校验从 localStorage 读取的配置为纯对象，避免畸形 JSON（数组/字符串/null）污染设置并原样回写
      _validConfigObject(raw) {
        if (raw === null || raw === undefined) return null;
        if (typeof raw !== 'object' || Array.isArray(raw)) return null;
        return raw;
      },
      saveSettings() {
        try { localStorage.setItem('tizumark-settings', JSON.stringify(this.settings)); } catch {}
      },
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
      },
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
        // 框架界面字号滑块 + 预览/编辑字重滑块回填（silent，不触发 onChange 递归）
        const uiFs = document.getElementById('set-ui-font-size');
        if (uiFs) { uiFs.value = s.uiFontSize; document.getElementById('ui-font-size-label').textContent = s.uiFontSize + 'px'; }
        const pfW = document.getElementById('set-preview-font-weight');
        if (pfW) { pfW.value = s.previewFontWeight; document.getElementById('preview-font-weight-label').textContent = s.previewFontWeight; }
        const efW = document.getElementById('set-editor-font-weight');
        if (efW) { efW.value = s.editorFontWeight; document.getElementById('editor-font-weight-label').textContent = s.editorFontWeight; }
        document.getElementById('settings-image-asset-path').value = s.imageAssetPath || 'assets';
        document.getElementById('set-clear-tabs-on-quit').checked = s.clearTabsOnQuit === true;
        document.getElementById('set-custom-bg').checked = s.customBgEnabled === true;
        const cbg = document.getElementById('set-custom-bg-color');
        if (cbg) cbg.value = s.customBgColor || '#f8f7f4';
      },
      // 最小可见时长：设置保存/应用是本地即时操作（同步落盘），loading 往往一闪而过，
      // 用户几乎看不到 spinner。这里保证 loading 至少展示 ms 毫秒，提供明确的点击反馈。
      // 用 setTimeout 实现（与操作 Promise 以 Promise.all 取较长者），事件循环并行、不累加时长。
      _minDelay(ms) {
        return new Promise((res) => {
          if (typeof setTimeout === 'function') setTimeout(res, ms);
          else res();
        });
      },
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
      },
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
        // 框架界面字号滑块：拖动只更新数值显示，实际字号在点「应用/保存」后随 applySettings 生效
        const uiFs = document.getElementById('set-ui-font-size');
        if (uiFs) {
          uiFs.addEventListener('input', (e) => {
            document.getElementById('ui-font-size-label').textContent = Number(e.target.value) + 'px';
          });
          uiFs.addEventListener('change', (e) => {
            this.settings.uiFontSize = Number(e.target.value);
          });
        }
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
        const ctoq = document.getElementById('set-clear-tabs-on-quit');
        if (ctoq) ctoq.addEventListener('change', (e) => { this.settings.clearTabsOnQuit = e.target.checked; });
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
        // 预览/编辑字重：由原自绘下拉改为 range 滑块（min=100 max=900 step=10），可更精准调节粗细
        const previewWHost = document.getElementById('set-preview-font-weight');
        if (previewWHost) {
          previewWHost.addEventListener('input', (e) => {
            const lb = document.getElementById('preview-font-weight-label');
            if (lb) lb.textContent = e.target.value;
          });
          previewWHost.addEventListener('change', (e) => { this.settings.previewFontWeight = Number(e.target.value); });
        }
        const editorWHost = document.getElementById('set-editor-font-weight');
        if (editorWHost) {
          editorWHost.addEventListener('input', (e) => {
            const lb = document.getElementById('editor-font-weight-label');
            if (lb) lb.textContent = e.target.value;
          });
          editorWHost.addEventListener('change', (e) => { this.settings.editorFontWeight = Number(e.target.value); });
        }
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
      },
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
        // 框架界面字号 + 预览/编辑字重：写入 CSS 变量（:root），由 styles.css 统一引用
        const root = document.documentElement;
        root.style.setProperty('--ui-font-size', s.uiFontSize + 'px');
        root.style.setProperty('--preview-weight', String(s.previewFontWeight));
        // 加粗/标题字重随基础字重动态联动：基础 +200、封顶 900，保证始终比正文重一档（基础 600 → 加粗 800，对比明显）
        root.style.setProperty('--preview-bold-weight', String(Math.min(s.previewFontWeight + 200, 900)));
        // 编辑器（纯源码、无强调区分）直接套字重于 CodeMirror 包裹层，向下继承到各行
        if (this.cm && this.cm.getWrapperElement()) {
          this.cm.getWrapperElement().style.fontWeight = String(s.editorFontWeight);
        }
        // 「显示所有文件」开关切换后，重渲染文件树让过滤即时生效；
        // expandedFolders 集合保证展开态不丢
        if (this.workspaceFolder) this.renderFolderTree();
      },
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
      },
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
      },
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
      },
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
      },
      updateImageAssetPathHint() {
        const mode = this.settings.imageAssetPathMode || 'relative';
        const hintEl = document.getElementById('setting-image-asset-path-hint-text');
        if (hintEl) {
          // 文案含 <code> 高亮片段，须用 innerHTML
          hintEl.innerHTML = mode === 'relative'
            ? this.t('imageAssetPathRelativeHint')
            : this.t('imageAssetPathAbsoluteHint');
        }
      },
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
      },
  };

  const api = { mixin };
  window.TMSettings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
