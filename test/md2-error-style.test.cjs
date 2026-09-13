// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// md2 错误块与单元格段落样式存在性。样式缺失会让错误块退化成裸文本
// （用户看不出这是「表格语法错误」而非普通正文），单元格里的 <p> 则会把表格撑开。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

test('存在 .md2-error 规则', () => {
  assert.match(CSS, /\.preview-content\s+\.md2-error\s*\{/);
});

test('存在 .md2-error pre 规则', () => {
  assert.match(CSS, /\.preview-content\s+\.md2-error\s+pre\s*\{/);
});

test('错误块有视觉区分（左侧强调边）', () => {
  const m = /\.preview-content\s+\.md2-error\s*\{([\s\S]*?)\}/.exec(CSS);
  assert.ok(m, '应能取到规则体');
  assert.match(m[1], /border-left/);
});

test('存在表格单元格内单段落重置规则（md2 单元格经管线会产出 <p>）', () => {
  // 任务 8 审查提出：md2 单元格内容回灌 unified 会产出 <p>，其在 td/th 里的
  // 默认上下边距会把表格撑开。GFM 表格单元格不含 <p>，故该规则对它们无影响。
  assert.match(CSS, /\.preview-content\s+td\s*>\s*p:only-child/);
  assert.match(CSS, /\.preview-content\s+th\s*>\s*p:only-child/);
});
