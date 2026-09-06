// DOM → docx 中间结构（纯 JSON，可 postMessage 给 worker）的转换模块。
// 浏览器：挂 window.domToDocxStructure；node：module.exports（互斥式，与现有模块一致）。
//
// 注意：elementToNode 内部返回【节点数组】而非单节点，以便把包裹在 <p>/<blockquote>
// 里的 <img> 打捞成顶层 image 节点（DocxLib 用块级节点，未打捞的图片会被静默丢弃）。
(function () {
  function dataUrlToBytes(dataUrl) {
    const m = /^data:[^;]+;base64,(.+)$/.exec(String(dataUrl || ''));
    if (!m) return null;
    try { return Uint8Array.from(atob(m[1]), c => c.charCodeAt(0)); } catch (e) { return null; }
  }

  function imageToNode(el) {
    const dataUrl = el.getAttribute('src') || '';
    const data = dataUrlToBytes(dataUrl);
    if (!data) return null;
    // 优先读 data-dispW/data-dispH（预览显示尺寸，docx 落宽高用它）；getAttribute 跨环境一致，
    // dataset 兜底覆盖 jsdom（键被小写化 dispw/disph）与浏览器（camelCase dispW/dispH）两种形态。
    const ds = el.dataset || {};
    const wSrc = el.getAttribute('data-dispW') || ds.dispW || ds.dispw || el.getAttribute('width') || el.naturalWidth || 100;
    const hSrc = el.getAttribute('data-dispH') || ds.dispH || ds.disph || el.getAttribute('height') || el.naturalHeight || 100;
    const w = parseInt(wSrc, 10) || 100;
    const h = parseInt(hSrc, 10) || 100;
    return { type: 'image', data: Array.from(data), width: w, height: h };
  }

  // 收集行内 runs；遇到 <img> 时若传入 images 数组则把图片节点打捞进去（不产生 run）。
  function collectRuns(el, runs = [], images = null) {
    if (!el) return runs;
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        const text = child.textContent || '';
        if (text) runs.push({ text });
      } else if (child.nodeType === 1) {
        const tag = child.tagName.toLowerCase();
        const style = child.style || {};
        let runBase = {};
        if (tag === 'strong' || tag === 'b') runBase.bold = true;
        else if (tag === 'em' || tag === 'i') runBase.italics = true;
        else if (tag === 'del' || tag === 's') runBase.strike = true;
        else if (tag === 'code') runBase.codeStyle = true;
        else if (tag === 'mark') { runBase.highlight = true; }
        else if (tag === 'br') { runs.push({ break: true }); continue; }
        else if (tag === 'img') {
          if (images) { const img = imageToNode(child); if (img) images.push(img); }
          continue;
        }
        const color = style.color;
        if (color) runBase.color = color.replace('#', '').toUpperCase();
        const before = runs.length;
        collectRuns(child, runs, images);
        for (let i = before; i < runs.length; i++) {
          if (!runs[i].bold && !runs[i].italics && !runs[i].strike && !runs[i].color) {
            runs[i] = { ...runs[i], ...runBase };
          }
        }
      }
    }
    return runs;
  }

  function elementToNode(el) {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      return [{ type: 'heading', level: parseInt(tag[1], 10), runs: collectRuns(el) }];
    }
    if (tag === 'p') {
      const imgs = [];
      const runs = collectRuns(el, undefined, imgs);
      const nodes = [];
      if (runs.length) nodes.push({ type: 'paragraph', runs, align: el.style.textAlign || undefined });
      nodes.push(...imgs);
      return nodes;
    }
    if (tag === 'blockquote') {
      const imgs = [];
      const inner = el.querySelector('p');
      const runs = collectRuns(inner || el, undefined, imgs);
      const nodes = [];
      if (runs.length) nodes.push({ type: 'paragraph', runs, quote: true });
      nodes.push(...imgs);
      return nodes;
    }
    if (tag === 'pre') {
      const code = el.querySelector('code');
      const text = (code ? code.textContent : el.textContent) || '';
      const lines = text.split('\n').map(l => l.trimEnd()).filter((l, i, a) => !(i === a.length - 1 && l === ''));
      return [{ type: 'code', lines }];
    }
    if (tag === 'ul' || tag === 'ol') {
      const nodes = [];
      for (const li of el.querySelectorAll(':scope > li')) {
        let prefix = '';
        const cb = li.querySelector('input[type="checkbox"]');
        if (cb) prefix = cb.checked ? '☑ ' : '☐ ';
        const inner = li.cloneNode(true);
        const cbIn = inner.querySelector('input[type="checkbox"]');
        if (cbIn) inner.removeChild(cbIn);
        const text = prefix + (inner.textContent || '').replace(/\s+/g, ' ').trim();
        nodes.push({ type: 'bullet', level: 0, runs: [{ text }] });
        const nestedUl = li.querySelector(':scope > ul, :scope > ol');
        if (nestedUl) {
          for (const nli of nestedUl.querySelectorAll(':scope > li')) {
            nodes.push({ type: 'bullet', level: 1, runs: [{ text: (nli.textContent || '').replace(/\s+/g, ' ').trim() }] });
          }
        }
      }
      return [{ type: 'list', children: nodes }];
    }
    if (tag === 'table') {
      const rows = [];
      for (const tr of el.querySelectorAll('tr')) {
        const cells = [];
        for (const td of tr.querySelectorAll('th, td')) {
          cells.push({ paragraphs: [{ text: (td.textContent || '').replace(/\s+/g, ' ').trim() }], width: 0 });
        }
        rows.push({ cells });
      }
      return [{ type: 'table', rows }];
    }
    if (tag === 'img') {
      const img = imageToNode(el);
      return img ? [img] : [];
    }
    if (tag === 'hr') return [{ type: 'hr' }];
    if (tag === 'div' && /mermaid-container/.test(el.className || '')) {
      const img = el.querySelector('img');
      return img ? elementToNode(img) : [];
    }
    if (tag === 'div' && /alert/.test(el.className || '')) {
      const imgs = [];
      const title = el.querySelector('.alert-title');
      const content = el.querySelector('.alert-content');
      const runs = [];
      if (title) runs.push({ text: (title.textContent || '').trim() + '\n', bold: true });
      if (content) runs.push(...(collectRuns(content, undefined, imgs)));
      const nodes = [];
      if (runs.length) nodes.push({ type: 'paragraph', runs, quote: true });
      nodes.push(...imgs);
      return nodes;
    }
    return [];
  }

  function domToDocxStructure(root) {
    const out = [];
    const walk = (el) => {
      for (const child of el.childNodes) {
        if (child.nodeType === 3) {
          const t = (child.textContent || '').trim();
          if (t) out.push({ type: 'paragraph', runs: [{ text: t }] });
          continue;
        }
        if (child.nodeType !== 1) continue;
        const nodes = elementToNode(child);
        for (const node of nodes) {
          if (node && node.type === 'list') out.push(...node.children);
          else if (node) out.push(node);
        }
      }
    };
    walk(root);
    return out;
  }

  const api = { domToDocxStructure };
  // 互斥式双导出（对齐仓库模块约定）：node 走 module.exports，浏览器/测试走 window，二者只触发其一。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.domToDocxStructure = domToDocxStructure;
  }
})();
