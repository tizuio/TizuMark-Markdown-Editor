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
        children: (cell.paragraphs || []).map(p => new D.Paragraph({
          text: p.text || '',
          // 行高调高：before/after 由 20 提升到 60 让表格每行更舒展（用户反馈"每行高度调高一点"）
          spacing: { before: 60, after: 60, line: 276, lineRule: 'auto' },
        })),
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
    const runToChild = (r, opts) => {
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
      // 标题强制加粗：docx 默认 Heading 样式（本库生成）不含 <w:b/>，
      // 仅靠样式不会加粗，故在 run 层显式 bold，保证标题在 Word 里显眼（用户反馈"标题没加粗"）。
      const bold = (opts && typeof opts.bold !== 'undefined') ? opts.bold : (r && r.bold);
      // 行内代码（<code>）：docx 无原生 code 样式，显式套等宽字体以与正文区分
      const font = (r && r.codeStyle) ? { name: 'Consolas' } : undefined;
      return new TextRun({ text: (r && r.text) || '', bold, italics: r && r.italics, strike: r && r.strike, color: r && r.color, font });
    };
    const children = [];
    for (const node of structure || []) {
      if (node.type === 'heading') {
        children.push(new Paragraph({ heading: HeadingLevel['HEADING_' + (node.level || 1)], children: (node.runs || []).map(r => runToChild(r, { bold: true })) }));
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
        // 代码块：灰底 + 边框 + 等宽。每行一个独立段落，行间【不用】<w:br/> 软换行——
        // Word/WPS 的东亚排版会把「软换行结尾的行」按两端对齐强行拉伸到整行宽
        //（即使段落未设 w:jc、全文 0 处 jc，实测仍拉伸），代码行被扯出巨大空隙；
        // 而段落末行永远不会被拉伸。相邻段落的边框/底纹/缩进完全一致时 Word 会把
        // 边框合并为一个整体框，视觉上仍是一个连续代码块。显式 LEFT 对齐双保险。
        const total = (node.lines || []).length;
        (node.lines || []).forEach((l, idx) => {
          children.push(new Paragraph({
            alignment: AlignmentType.LEFT,
            children: [new TextRun({ text: l, font: { name: 'Consolas' } })],
            shading: { type: D.ShadingType.CLEAR, fill: 'F6F5F4' },
            border: {
              top: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4D4D8' },
              bottom: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4D4D8' },
              left: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4D4D8' },
              right: { style: D.BorderStyle.SINGLE, size: 4, color: 'D4D4D8' },
            },
            // 首行 before / 末行 after 各留 120 与正文过渡，行间 0 间距保持紧凑
            spacing: { before: idx === 0 ? 120 : 0, after: idx === total - 1 ? 120 : 0, line: 300, lineRule: 'auto' },
            indent: { left: 120, right: 120 },
          }));
        });
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
      // 全局默认段落间距：段前段后各 40 twips（约 0.07cm）+ 1.15 倍行距，
      // 否则 Word 默认段落零间距、文字太密集（用户反馈"太密集"）。
      styles: {
        default: {
          document: {
            paragraph: { spacing: { before: 40, after: 40, line: 276, lineRule: 'auto' } },
          },
        },
      },
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
