// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Yoong Hor Meng
//
// TizuMark 的 md2 表格子系统（移植/衍生自 md2，MIT 许可，
// Copyright (c) 2026 The md2 authors，上游许可全文见
// test/fixtures/md2-golden/LICENSE）。
// 本仓库整体以 GPL-3.0 分发（见根目录 LICENSE）；上面的 MIT 标识说明的是
// 本文件自身的许可，不改变 TizuMark 的整体许可。
// md2 表格 AST → HTML（对应 md2 crates/md2-core/src/html.rs 的表部分）。
//
// 与 md2 的**有意差异共两处**：
//   1) 对齐用 TizuMark 既有的 align 属性（见 src/styles.css:2138 的
//      th[align="center"] 选择器），而非 md2 的内联 style="text-align:"。
//      该差异由一致性门禁的归一化吸收。
//   2) 结尾 </table> 不带尾随换行（上游 html.rs:179 带 \n）。这是配合消费方的
//      正确行为：scan.js 以 out.join('\n') 拼回行流，自带换行，本模块再加会产生多余空行。
//
// 单元格内容渲染通过回调注入，本模块不依赖 unified —— 保持纯净可单测。
//
// **转义契约（重要）：** 本模块把 renderCellContent 的返回值**按原始 HTML 原样插入**
// <th>/<td>，绝不做任何转义——转义/渲染是回调的职责，本模块二次转义会造成双重转义
// 并破坏回调产出的结构（如 <p> 包裹）。
// ⚠️ 注意这与本仓库另一处表格渲染器 src/unified-renderer.js:740 的 renderCellContent
// **约定相反**（那个是内部先 escapeHTML）。两者互不复用，切勿混淆。
'use strict';

const { Alignment } = require('./ast.js');

// 属性值白名单：属性是本模块亲手拼装的（与内容不同——内容由回调负责转义），
// 故只允许已知的对齐值进入，畸形 AST 里的任意字符串不会成为可注入的属性值。
const ALIGN_VALUES = new Set([Alignment.Left, Alignment.Center, Alignment.Right]);

/**
 * 渲染一个 cell 的开始标签属性。
 * covered cell 由调用方跳过，不会走到这里。
 */
function cellAttrs(cell, align) {
  let attrs = '';
  if (cell.colspan > 1) attrs += ` colspan="${cell.colspan}"`;
  if (cell.rowspan > 1) attrs += ` rowspan="${cell.rowspan}"`;
  if (ALIGN_VALUES.has(align)) attrs += ` align="${align}"`;
  return attrs;
}

function renderRow(row, tag, alignments, renderCellContent) {
  let out = '<tr>';
  for (let c = 0; c < row.cells.length; c++) {
    const cl = row.cells[c];
    if (cl.covered) continue; // §3.4：covered 位置不产出元素
    out += `<${tag}${cellAttrs(cl, alignments[c])}>`;
    out += renderCellContent(cl.content);
    out += `</${tag}>`;
  }
  out += '</tr>\n';
  return out;
}

/**
 * 渲染整张表。
 *
 * 契约边界：本函数假定传入的是**已过 `validate()` 的全网格 AST**
 * （每行恰 `columnCount` 格、`alignments.length === columnCount`）——
 * `alignments[c]` 的映射依赖它。本函数不自行校验，只对 headerRowCount 做归一化。
 *
 * @param {object} table  md2 表格 AST（假定已通过 ast.validate()）
 * @param {(content: string) => string} renderCellContent 单元格内容渲染回调。
 *   **必须提供**；其返回值按原始 HTML 原样插入，回调须自行完成转义。
 * @returns {string} HTML
 */
function renderTable(table, renderCellContent) {
  if (typeof renderCellContent !== 'function') {
    throw new TypeError('renderTable: renderCellContent must be a function');
  }
  const { alignments, rows } = table;
  // 上游 html.rs 同款钳制，并归一化非整数：畸形 AST 里 headerRowCount 可能越界，
  // 不处理会读 rows[r].cells 抛 TypeError → 整个预览崩掉；NaN 更糟——会静默产出一张空表。
  const rawHeaderRows = table.headerRowCount;
  const headerRowCount = Math.max(0, Math.min(Number.isInteger(rawHeaderRows) ? rawHeaderRows : 0, rows.length));

  let out = '<table>\n';

  if (headerRowCount > 0) {
    out += '<thead>\n';
    for (let r = 0; r < headerRowCount; r++) {
      out += renderRow(rows[r], 'th', alignments, renderCellContent);
    }
    out += '</thead>\n';
  }

  if (rows.length > headerRowCount) {
    out += '<tbody>\n';
    for (let r = headerRowCount; r < rows.length; r++) {
      out += renderRow(rows[r], 'td', alignments, renderCellContent);
    }
    out += '</tbody>\n';
  }

  out += '</table>';
  return out;
}

module.exports = { renderTable };
