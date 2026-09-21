// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// md2 一致性门禁的归一化器。
//
// 目的：把 TizuMark 与 md2 的输出归一到可比较的规范形式，吸收两者的
// **有意差异**（对齐编码：md2 用内联 style，TizuMark 用 align 属性）。
//
// 比较范围（设计规格「一致性门禁」节）：
//   1. 元素树     2. 元素名/层级/顺序   3. colspan / rowspan（缺省 1）
//   4. covered 省略（体现为该行 cell 数） 5. 单元格文本（空白折叠）
//   6. 对齐值归一
//
// **不比较**单元格内部的标记细节：md2 把单段落单元格输出为裸行内内容，
// TizuMark 回灌 unified 会产生 <p> 包裹。文本与结构相同，标记不同。
'use strict';

const { JSDOM } = require('jsdom');

/** 从一段 HTML 中提取所有 <table> 的规范形式。 */
function extractTables(html) {
  const dom = new JSDOM(`<body>${html}</body>`);
  const doc = dom.window.document;
  return Array.from(doc.querySelectorAll('table')).map(normalizeTable);
}

function alignOf(el) {
  const attr = el.getAttribute('align');
  if (attr) return String(attr).toLowerCase();
  const style = el.getAttribute('style') || '';
  const m = /text-align\s*:\s*(left|center|right)/i.exec(style);
  return m ? m[1].toLowerCase() : 'default';
}

function normalizeTable(table) {
  const rows = [];
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const cells = [];
    for (const el of Array.from(tr.children)) {
      const tag = el.tagName.toLowerCase();
      if (tag !== 'td' && tag !== 'th') continue;
      cells.push({
        tag,
        colspan: Number(el.getAttribute('colspan') || 1),
        rowspan: Number(el.getAttribute('rowspan') || 1),
        align: alignOf(el),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      });
    }
    rows.push(cells);
  }
  const thead = table.querySelector('thead');
  const headerRowCount = thead ? thead.querySelectorAll('tr').length : 0;
  return { headerRowCount, rows };
}

module.exports = { extractTables, normalizeTable };
