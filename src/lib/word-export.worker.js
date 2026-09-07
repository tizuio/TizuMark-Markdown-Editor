// Word 导出打包 Worker：在独立线程中运行 docx 库，避免阻塞主线程。
// 主线程传入统一 payload：{ id, type:'docx', structure, page }（真 OOXML）或
//                   { id, type:'html', html }（回退 altChunk，走 html-docx-js）。
// worker 按 type 选择 DocxLib（真 OOXML）或 htmlDocx（回退）。
importScripts('./docx.min.js');
importScripts('./html-docx.min.js');

// 把主线程的中间结构转成 DocxLib 对象树。
function buildDocx(structure, page) {
  const D = self.DocxLib;
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = D;
  // run → docx 子元素：omml run（可编辑公式）经 ImportedXmlComponent 注入 oMath；
  // 普通 run 转 TextRun。fromXmlString 的顶层是 undefined key 容器，取 root[0]。
  const runToChild = (r) => {
    if (r && r.omml) {
      const comp = D.ImportedXmlComponent.fromXmlString(r.omml);
      return (comp && comp.root && comp.root[0]) || new TextRun({ text: '' });
    }
    return new TextRun({ text: (r && r.text) || '', bold: r && r.bold, italics: r && r.italics, strike: r && r.strike, color: r && r.color });
  };
  const children = [];
  for (const node of structure || []) {
    if (node.type === 'heading') {
      children.push(new Paragraph({ heading: HeadingLevel['HEADING_' + (node.level || 1)], children: (node.runs || []).map(runToChild) }));
    } else if (node.type === 'paragraph') {
      children.push(new Paragraph({ children: (node.runs || []).map(runToChild), alignment: node.align ? AlignmentType[node.align] : undefined }));
    } else if (node.type === 'bullet') {
      children.push(new Paragraph({ text: (node.runs && node.runs[0] && node.runs[0].text) || '', bullet: { level: node.level || 0 } }));
    } else if (node.type === 'table') {
      children.push(buildTable(D, node));
    } else if (node.type === 'code') {
      children.push(new Paragraph({ children: node.lines.map(l => ({ text: l })), shading: { type: D.ShadingType.CLEAR, fill: 'F6F5F4' }, spacing: { before: 120, after: 120 } }));
    } else if (node.type === 'image') {
      children.push(new Paragraph({ children: [ new D.ImageRun({ data: Uint8Array.from(node.data), transformation: { width: node.width, height: node.height } }) ] }));
    }
  }
  const doc = new Document({
    sections: [{
      properties: { page: { size: { width: page.pageWidth, height: page.pageHeight }, margin: { top: page.marginTop, bottom: page.marginBottom, left: page.marginLeft, right: page.marginRight } } },
      children,
    }]
  });
  return Packer.toBlob(doc);
}

function buildTable(D, node) {
  const rows = (node.rows || []).map(row => new D.TableRow({
    children: row.cells.map(cell => new D.TableCell({
      children: (cell.paragraphs || []).map(p => new D.Paragraph(p.text || '')),
      width: { size: cell.width || 0, type: D.WidthType.PERCENTAGE },
    }))
  }));
  return new D.Table({ rows, width: { size: 100, type: D.WidthType.PERCENTAGE } });
}

function toArrayBuffer(blob) {
  const reader = new FileReaderSync();
  return reader.readAsArrayBuffer(blob);
}

self.onmessage = function (e) {
  const { id, type } = e.data;
  try {
    if (type === 'docx') {
      const blob = buildDocx(e.data.structure, e.data.page);
      const arrayBuffer = toArrayBuffer(blob);
      self.postMessage({ id, success: true, arrayBuffer }, [arrayBuffer]);
    } else {
      const blob = self.htmlDocx.asBlob(e.data.html);
      const arrayBuffer = toArrayBuffer(blob);
      self.postMessage({ id, success: true, arrayBuffer }, [arrayBuffer]);
    }
  } catch (err) {
    self.postMessage({ id, success: false, error: err.message || String(err) });
  }
};
