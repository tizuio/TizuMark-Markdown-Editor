// 大纲（目录）抽取：从 app.js 的 updateOutline 拆出纯计算与渲染部分。
// 设计：纯函数不依赖 DOM 或 this，依赖通过 opts 注入（headingToId / escapeHtml），
// 与 preview-post.js 的注入风格一致，降低改动爆炸半径。
//   - extractHeadings(content, { headingToId }): 从 markdown 文本提取标题（跳过代码块、解析 #、去重 id）
//   - buildOutlineTree(headings): 按层级组织成树
//   - renderOutlineHtml(tree, { escapeHtml }): 生成大纲 DOM 的 HTML 字符串

// 完整清理标题中的 Markdown 内联语法，仅用于显示（面包屑 / 大纲文字）。
// 与生成 id 的轻量清理（仅去 [*`~[]）不同：这里进一步剥离链接括号、行内代码
// 反引号、强调/删除线标记、尾随 # 等，使显示文字更干净。
// 注意：HTML 标签（<...>）不在此删除，交由渲染层转义为文字，避免误删正常尖括号内容。
function stripInlineMarkdown(raw) {
  let s = String(raw);
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');     // 图片 ![alt](url)
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');  // 链接 [text](url) -> text
  s = s.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1'); // 引用式链接 [text][ref] -> text
  s = s.replace(/<(https?:\/\/[^>]+)>/g, '$1');   // 自动链接 <http://x> -> http://x
  s = s.replace(/`([^`]+)`/g, '$1');              // 行内代码 `code` -> code
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');        // 粗体 **x**
  s = s.replace(/__([^_]+)__/g, '$1');            // 粗体 __x__
  s = s.replace(/\*([^*]+)\*/g, '$1');            // 斜体 *x*
  s = s.replace(/_([^_]+)_/g, '$1');              // 斜体 _x_
  s = s.replace(/~~([^~]+)~~/g, '$1');            // 删除线 ~~x~~
  s = s.replace(/[`*_~\[\]]/g, '');               // 残留标记字符
  s = s.replace(/\s+#+\s*$/, '');                 // 尾随 #（GitHub 风格闭合标题）
  s = s.replace(/\s+/g, ' ').trim();              // 合并空白
  return s;
}

function extractHeadings(content, opts) {
  const headingToId = opts && opts.headingToId;
  const lines = (content || '').split('\n');
  const headings = [];
  const idCount = {};
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      const level = match[1].length;
      // 轻量清理文本用于生成 id，保持与改动前完全一致，避免影响大纲/面包屑点击跳转锚点
      const idText = match[2].replace(/[*`~\[\]]/g, '').trim();
      // 完整清理文本用于显示（面包屑 / 大纲），剥离 Markdown 内联语法残留
      const text = stripInlineMarkdown(match[2]);
      const baseId = headingToId ? headingToId(idText) : idText;
      const n = idCount[baseId] || 0;
      idCount[baseId] = n + 1;
      const id = n === 0 ? baseId : baseId + '-' + (n + 1);
      headings.push({ level, text, id, line: i });
    }
  }
  return headings;
}

function buildOutlineTree(headings) {
  const root = { level: 0, children: [] };
  const stack = [root];
  for (const h of headings) {
    const node = { ...h, children: [], expanded: true };
    while (stack.length > 1 && stack[stack.length - 1].level >= h.level) {
      stack.pop();
    }
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

function renderOutlineHtml(tree, opts) {
  const escapeHtml = (opts && opts.escapeHtml) || ((s) => s);
  // 大纲层级过滤：maxLevel=0 表示全部；>0 时仅渲染 level<=maxLevel 的节点，
  // 被过滤子树的父节点仍保留（不渲染其更深子节点）。
  const maxLevel = (opts && opts.maxLevel) || 0;
  const renderTree = (nodes) => {
    let html = '';
    for (const node of nodes) {
      if (maxLevel && node.level > maxLevel) continue;
      const hasChildren = node.children.length > 0;
      html += '<div class="outline-item-wrapper">';
      html += `<div class="outline-item level-${node.level}" data-id="${node.id}" data-line="${node.line}">`;
      // 始终输出 toggle 占位：无子节点项加 outline-toggle--hidden（隐藏且不可点击），
      // 保留与有子节点项一致的宽度，使各级标签起始位置对齐，避免同级标题因
      // 有无展开箭头而视觉错位（见 styles.css .outline-toggle--hidden）。
      const toggleCls = hasChildren ? 'outline-toggle' : 'outline-toggle outline-toggle--hidden';
      // 与文件目录 .tree-arrow 的 CHEVRON 完全同款（Lucide chevron-right / stroke 2 /
      // currentColor）：展开态由 CSS 旋转 90° 指向下，折叠态转回 0° 指向右。
      // 不再用实心等腰小三角；常量放函数体内，单独 eval 方法体时也能取到。
      const DISCLOSURE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6" /></svg>';
      html += `<span class="${toggleCls}">${DISCLOSURE}</span>`;
      html += `<span class="outline-label">${escapeHtml(node.text)}</span>`;
      html += '</div>';
      if (hasChildren) {
        // 过滤生效时不再渲染更深子树（已被上方 continue 跳过），否则正常渲染
        html += `<div class="outline-children">${renderTree(node.children)}</div>`;
      }
      html += '</div>';
    }
    return html;
  };
  return renderTree(tree);
}

// 根据当前行号计算面包屑路径：返回从根到当前位置所经过的所有标题祖先。
// 算法：按行号顺序遍历标题，维护一条单调不升的路径；遇到更浅或同级标题时回退。
function computeBreadcrumbPath(headings, line) {
  const path = [];
  for (const h of headings) {
    if (h.line > line) break;
    while (path.length && path[path.length - 1].level >= h.level) {
      path.pop();
    }
    path.push(h);
  }
  return path;
}

// 生成面包屑 DOM 字符串（纯函数，便于单元测试）。
// 溢出处理策略（统一为一套，避免"折叠"与"滚动"互相打架）：
//  1) 每个标题由 CSS `.crumb-label` 做单行省略号截断，防止单个超长标题占满整行；
//  2) 层级再多也全部渲染，超出可视宽度时由外层容器横向滚动浏览
//     （滚轮转横滚 + 自动定位当前项 + 左侧"回到开头"按钮），滚动一定能看全每一层，
//     不存在被永久隐藏、滚动也还原不出的层级。
function escapeBreadcrumbAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeBreadcrumbText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function renderBreadcrumbHtml(path, fileName, opts) {
  const o = opts || {};
  const icon = o.iconSvg || '';
  const sep = '<span class="editor-breadcrumb-separator">›</span>';

  const fileText = escapeBreadcrumbText(fileName || '');
  const fileTitle = escapeBreadcrumbAttr(fileName || '');
  let html = `<span class="editor-breadcrumb-file" title="${fileTitle}">${icon}<span class="crumb-label">${fileText}</span></span>`;

  const crumb = (h, isLast) => {
    const cls = isLast ? 'editor-breadcrumb-item active' : 'editor-breadcrumb-item';
    const title = escapeBreadcrumbAttr(h.text);
    return `<span class="${cls}" data-breadcrumb-line="${h.line}" title="${title}"><span class="crumb-label">${escapeBreadcrumbText(h.text)}</span></span>`;
  };

  for (let i = 0; i < path.length; i++) {
    html += sep + crumb(path[i], i === path.length - 1);
  }
  return html;
}

const Outline = { extractHeadings, buildOutlineTree, renderOutlineHtml, computeBreadcrumbPath, renderBreadcrumbHtml };

// 浏览器：作为独立 <script> 加载，挂到全局 Outline
if (typeof window !== 'undefined' && typeof module === 'undefined') {
  window.Outline = Outline;
}
// Node（测试 / 构建）：CommonJS 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Outline;
}
