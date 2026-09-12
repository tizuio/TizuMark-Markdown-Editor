// 系统字体枚举与自定义字体
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';
  const { SYSTEM_FONT_WHITELIST_SET, FONT_NAME_LOCALE, EXPORT_CJK_FONT_TAIL, EXPORT_FALLBACK_SANS, FONT_LOCALE_REV, dialogOpen } = TMConst;

  const mixin = {
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
      },
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
      },
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
      },
      // 字体值 → CSS font-family 片段：空→''；命中自定义字体 id→tizumark-custom-{id}；
      // 否则视为系统字体族名→加引号（兼容含空格的族名如 "Microsoft YaHei"）
      _fontFamilyFor(id) {
        if (!id) return '';
        const isCustom = (this.settings.customFonts || []).some(f => f.id === id);
        return isCustom ? `'tizumark-custom-${id}'` : `"${id}"`;
      },
      // PDF 导出字体链 = 用户预览字体 + 中文字体尾链 + sans-serif。
      // 打印帧只取 preview 的 innerHTML，容器上的行内 font-family 不会带过去，
      // 因此必须在此显式拼装，否则用户选的预览字体在导出时被 :root 默认值悄悄顶掉。
      _exportPdfFontStack() {
        const userFont = this._fontFamilyFor(this.settings.previewFont);
        return `${userFont || EXPORT_FALLBACK_SANS}, ${EXPORT_CJK_FONT_TAIL}, sans-serif`;
      },
      applyCustomFonts() {
        const ef = this._fontFamilyFor(this.settings.editorFont);
        this.cm.getWrapperElement().style.fontFamily = ef;
        const pf = this._fontFamilyFor(this.settings.previewFont);
        this.preview.style.fontFamily = pf;
        // 预览代码块字体（行内代码 + 围栏代码块）注入到专用 CSS 变量；空则回退等宽默认
        const cf = this._fontFamilyFor(this.settings.codeFont);
        this.preview.style.setProperty('--font-code-preview', cf || 'var(--font-mono)');
      },
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
      },
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
      },
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
      },
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
      },
      _fontDisplayName(val) {
        if (!val) return '';
        const f = (this.settings.customFonts || []).find(x => x.id === val);
        if (f) return f.name;
        // 系统字体：中文 UI 显示中文族名（如有映射），英文 UI 显示英文原名
        const isZh = this.settings.language !== 'en';
        return (isZh && FONT_NAME_LOCALE[val]) ? FONT_NAME_LOCALE[val] : val;
      },
  };

  const api = { mixin };
  window.TMFont = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
