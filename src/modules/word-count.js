// 字数 / 字符 / 行数统计：从 app.js 的 updateWordCount 抽取纯计算部分。
// 设计：纯函数不依赖 DOM 或 this，便于单独测试、降低改动爆炸半径。
//   - countStats(content): 返回 { words, chars, lines }（编辑器源码口径）
//       * words: 去除 markdown 标记符号并按空白分词后的词数
//       * chars: 原始字符数（含换行）
//       * lines: 按 \n 切分的行数（空内容记为 0）
//   - countPreviewText(previewRoot): 返回预览「可见文本」的字符数（渲染后口径）
//       * 遍历 DOM 文本节点，跳过隐藏区（script/style/noscript）、图形内部文字
//         （mermaid svg、KaTeX 的隐藏 MathML）与代码复制按钮等非正文节点；
//       * 代码块文字、表格文字、图片 alt 计入（读者实际能看到的内容）。

function countStats(content) {
  const text = (content || '')
    .replace(/[#*`~\[\]()>_|\\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const words = text ? text.split(/\s+/).length : 0;
  const chars = (content || '').length;
  const lines = content ? content.split('\n').length : 0;
  return { words, chars, lines };
}

// 从根元素统计预览可见文本字符数。纯 DOM 遍历，无副作用。
function countPreviewText(previewRoot) {
  if (!previewRoot) return 0;
  let count = 0;
  const walk = (node) => {
    if (node.nodeType === 3) { // text node
      count += (node.textContent || '').length;
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    // 跳过的容器：脚本/样式、隐藏的 KaTeX MathML、图形类（mermaid 的 svg、
    // 数学/流程图内部文字不应计入「可见文本」）、复制按钮等 UI 元素
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
    if (el.classList && (
      el.classList.contains('katex-mathml') ||
      el.classList.contains('copy-btn') ||
      el.classList.contains('code-line-num')
    )) return;
    if (tag === 'svg') return;
    // 显式隐藏/零尺寸的元素跳过（避免排版残留文本重复计数）
    if (el.hidden) return;
    const style = el.style;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return;
    for (const child of el.childNodes) walk(child);
  };
  walk(previewRoot);
  return count;
}

// 浏览器：作为独立 <script> 加载，挂到全局 WordCount
if (typeof window !== 'undefined' && typeof module === 'undefined') {
  window.WordCount = { countStats, countPreviewText };
}
// Node（测试 / 构建）：CommonJS 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { countStats, countPreviewText };
}
