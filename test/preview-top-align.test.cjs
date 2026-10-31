/**
 * 预览顶部内容对齐（2026-10-31 用户反馈「编辑和预览顶部内容对齐，现在有点偏差」）：
 * 编辑分屏态预览 padding-top 对齐编辑器有效顶部内距（30px），首元素 margin-top 清零。
 * 规则必须带 :not(preview-mode/wysiwyg-mode) 作用域——阅读模式与所见即所得各有
 * padding:32px 口径，且 .preview-content 类被 WYSIWYG 块遮罩复用。静态断言守护。
 */
'use strict';
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

test('preview-top-align: 编辑分屏态预览 padding-top 对齐规则存在', () => {
  assert.match(
    css,
    /\.editor-container:not\(\.preview-mode\):not\(\.wysiwyg-mode\) \.preview-pane \.preview-content \{ padding-top: 30px; \}/,
    '应存在分屏态预览 padding-top:30px 规则'
  );
});

test('preview-top-align: 首元素 margin-top 清零规则存在且带同款作用域', () => {
  assert.match(
    css,
    /\.editor-container:not\(\.preview-mode\):not\(\.wysiwyg-mode\) \.preview-pane \.preview-content > :first-child \{ margin-top: 0; \}/,
    '应存在首元素 margin-top 清零规则'
  );
});

test('preview-top-align: 基类 .preview-content 的 padding 不被直接改动（阅读模式 32px 口径不受影响）', () => {
  // 基类仍是 16px 24px；30px 只出现在带 :not 作用域的规则里
  const base = css.match(/\.preview-content \{[^}]*\}/);
  assert.ok(base, '基类 .preview-content 规则应存在');
  assert.ok(base[0].includes('padding: 16px 24px'), '基类 padding 应保持 16px 24px');
});
