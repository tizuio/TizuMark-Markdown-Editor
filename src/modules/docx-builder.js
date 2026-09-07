// docx 真 OOXML 构建器：把「DOM→中间结构」转成 DocxLib 的 Document 并打包成 Blob。
//
// 在主线程运行（lib/docx.min.js 由 index.html 常驻加载）。曾把这段逻辑放在 Web Worker 里，
// 但部分 Tauri/WebView 环境下 Worker 不可用（自定义协议对 Worker 脚本加载不稳），
// 整条 docx 主路径会静默降级成 html-docx 的 altChunk——公式全变纯文本、图片变占位符。
// 主线程直构建无此不确定性，代价是打包期间主线程短暂阻塞（有 loading 遮罩，可接受）。
//
// 双导出：node 走 module.exports（测试），浏览器走 window 全局。
(function () {
  'use strict';

  // worker 已弃用；node 测试走全局 DocxLib，浏览器走 window.DocxLib。
  function resolveDocxLib() {
    if (typeof window !== 'undefined' && window && window.DocxLib) return window.DocxLib;
    if (typeof self !== 'undefined' && self && self.DocxLib) return self.DocxLib;
    if (typeof DocxLib !== 'undefined') return DocxLib;
    return null;
  }

  function buildTable(D, node) {
    // 列宽：cell.width 之前传 0 导致 Word 列宽全 0、排版乱。按列数平均分配 100%。
    const colCount = (node.rows && node.rows[0] && node.rows[0].cells) ? node.rows[0].cells.length : 1;
    const colW = Math.floor(100 / Math.max(1, colCount));
    const rows = (node.rows || []).map(row => new D.TableRow({
      children: row.cells.map(cell => new D.TableCell({
        children: (cell.paragraphs || []).map(p => new D.Paragraph(p.text || '')),
        width: { size: (cell.width && cell.width > 0) ? cell.width : colW, type: D.WidthType.PERCENTAGE },
      }))
    }));
    return new D.Table({
      rows,
      width: { size: 100, type: D.WidthType.PERCENTAGE },
      borders: {
        top: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4D4D8' },
        bottom: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4D4D8' },
        left: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4D4D8' },
        right: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4D4D8' },
        insideHorizontal: { style: D.BorderStyle.SINGLE, size: 4, color: 'E4E4E7' },
        insideVertical: { style: D.BorderStyle.SINGLE, size: 4, color: 'E4E4E7' },
      },
    });
  }

  async function buildDocxFromStructure(structure, page) {
    const D = resolveDocxLib();
    if (!D) throw new Error('docx 库未加载（DocxLib）');
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = D;
    // run → docx 子元素：omml run（可编辑公式）经 ImportedXmlComponent 注入 oMath；
    // 普通 run 转 TextRun。fromXmlString 的顶层是 undefined key 容器，取 root[0]。
    const runToChild = (r) => {
      if (r && r.omml) {
        try {
          const comp = D.ImportedXmlComponent.fromXmlString(r.omml);
          return (comp && comp.root && comp.root[0]) || new TextRun({ text: '' });
        } catch (e) {
          // 兜底：OMML 非法 XML（mml2omml 对复杂公式可能产出非良构 XML）时，
          // 降级为 OMML 内的纯文本，绝不让单个坏公式拖垮整篇文档构建。
          const fallback = String(r.omml).replace(/<[^>]+>/g, '').trim();
          return new TextRun({ text: fallback });
        }
      }
      return new TextRun({ text: (r && r.text) || '', bold: r && r.bold, italics: r && r.italics, strike: r && r.strike, color: r && r.color });
    };
    const children = [];
    for (const node of structure || []) {
      if (node.type === 'heading') {
        children.push(new Paragraph({ heading: HeadingLevel['HEADING_' + (node.level || 1)], children: (node.runs || []).map(runToChild) }));
      } else if (node.type === 'paragraph') {
        // quote 段落（blockquote / alert）：加左缩进 + 左边框，否则与普通段落无视觉区分。
        const opts = { children: (node.runs || []).map(runToChild) };
        if (node.align) opts.alignment = AlignmentType[node.align];
        if (node.quote) {
          opts.indent = { left: 360 }; // 0.25 英寸
          opts.border = { left: { style: D.BorderStyle.SINGLE, size: 24, color: '2563EB', space: 8 } };
          opts.spacing = { before: 80, after: 80 };
        }
        children.push(new Paragraph(opts));
      } else if (node.type === 'bullet') {
        children.push(new Paragraph({ text: (node.runs && node.runs[0] && node.runs[0].text) || '', bullet: { level: node.level || 0 } }));
      } else if (node.type === 'table') {
        children.push(buildTable(D, node));
      } else if (node.type === 'code') {
        // 代码块：灰底 + 边框 + 等宽。多行用一个 Paragraph（行间用 break）保持整体外观。
        const codeRuns = [];
        node.lines.forEach((l, idx) => {
          if (idx > 0) codeRuns.push(new TextRun({ text: '', break: 1 }));
          codeRuns.push(new TextRun({ text: l, font: { name: 'Consolas' } }));
        });
        children.push(new Paragraph({
          children: codeRuns,
          shading: { type: D.ShadingType.CLEAR, fill: 'F6F5F4' },
          border: {
            top: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4D4D8' },
            bottom: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4D4D8' },
            left: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4D4D8' },
            right: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4D4D8' },
          },
          spacing: { before: 120, after: 120 },
          indent: { left: 120, right: 120 },
        }));
      } else if (node.type === 'image') {
        children.push(new Paragraph({
          children: [new D.ImageRun({
            type: node.imageType || 'png',
            data: Uint8Array.from(node.data || []),
            transformation: { width: node.width, height: node.height },
          })]
        }));
      } else if (node.type === 'hr') {
        // 水平线：段落底边框。
        children.push(new Paragraph({
          border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: 'D4D4D8', space: 1 } },
          spacing: { before: 80, after: 80 },
        }));
      }
    }
    const doc = new Document({
      sections: [{
        properties: {
          page: {
            size: { width: page.pageWidth, height: page.pageHeight },
            margin: { top: page.marginTop, bottom: page.marginBottom, left: page.marginLeft, right: page.marginRight },
          },
        },
        children,
      }]
    });
    return Packer.toBlob(doc);
  }

  const api = { buildDocxFromStructure };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.buildDocxFromStructure = buildDocxFromStructure;
  }
})();
