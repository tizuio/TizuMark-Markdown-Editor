// 所见即所得异步 pass 的行为回归（2026-10-11 四缺陷修复配套）：
//   1) [TOC] 替换对齐阅读模式：块内非首个 <p> 的 [TOC] 段也要被替换（旧实现只取第一个 p）；
//   2) [TOC] invoke 失败不缓存，下次重挂可重试；
//   3) 异步 pass 集中冲刷：只跑「节点已入 DOM」的待跑遮罩，未物化的留待下次；
//      _dropWysiwygMaskNode 只作废本节点（节点级代数），不牵连他块；
//   4) mermaid.run 串行化（并发 ≤1）+ 容器 id 全局唯一（同毫秒并发不碰撞）。
//
// 真实浏览器端到端断言在 scripts/wysiwyg-browser-check.mjs 的 S9–S12（harness 带 TauriApi mock）。

const test = require('node:test');
const assert = require('node:assert');
const { withEditor, delay } = require('./helpers/app-env.cjs');

const TOC_HTML = '<div class="toc"><div class="toc-title">📑 目录</div><ul class="toc-list"><li><a href="#a">A</a></li></ul></div>';

test('[TOC]：非首个 <p> 的 [TOC] 段也被替换为 toc-wrapper（与阅读模式替换规则一致）', async () => {
  await withEditor({}, async (w, ed) => {
    const node = w.document.createElement('div');
    node.innerHTML = '<p data-source-line="0">前面另有段落</p><p data-source-line="2">[TOC]</p>';
    w.document.body.appendChild(node);
    const origTauriApi = w.TauriApi;
    w.TauriApi = { generateToc: async () => TOC_HTML };
    ed._wysiwygToc = null;
    try {
      await ed._wysiwygReplaceToc(node);
    } finally {
      w.TauriApi = origTauriApi;
      ed._wysiwygToc = null;
    }
    // 普通段落不受影响
    assert.strictEqual(node.children[0].tagName, 'P', '非 [TOC] 段落不应被替换');
    assert.strictEqual(node.querySelector('p').textContent, '前面另有段落');
    // [TOC] 段换成 toc-wrapper，且保留 data-source-line
    const wrap = node.querySelector('.toc-wrapper');
    assert.ok(wrap, '[TOC] 段必须被替换为 toc-wrapper');
    assert.strictEqual(wrap.getAttribute('data-source-line'), '2');
    assert.ok(wrap.querySelector('.toc'), 'toc-wrapper 内必须含目录 HTML');
    assert.strictEqual(node.querySelector('p').textContent, '前面另有段落');
  });
});

test('[TOC]：invoke 失败不缓存（_wysiwygToc 清空），下次重挂按新内容重试可成功', async () => {
  await withEditor({}, async (w, ed) => {
    const node = w.document.createElement('div');
    node.innerHTML = '<p data-source-line="2">[TOC]</p>';
    w.document.body.appendChild(node);
    const origTauriApi = w.TauriApi;
    let calls = 0;
    w.TauriApi = {
      generateToc: async () => {
        calls++;
        if (calls === 1) throw new Error('mock boom');
        return TOC_HTML;
      },
    };
    ed._wysiwygToc = null;
    try {
      // 第一次：失败 → [TOC] 原文保留、缓存清空
      await ed._wysiwygReplaceToc(node);
      assert.strictEqual(calls, 1);
      assert.strictEqual(ed._wysiwygToc, null, '失败后缓存必须清空（可重试）');
      assert.ok(node.querySelector('p'), '失败后保持 [TOC] 原文');
      // 第二次：同一节点重试成功
      await ed._wysiwygReplaceToc(node);
      assert.strictEqual(calls, 2);
      assert.ok(node.querySelector('.toc-wrapper'), '重试后必须替换成功');
    } finally {
      w.TauriApi = origTauriApi;
      ed._wysiwygToc = null;
    }
  });
});

test('异步 pass 冲刷：只跑已入 DOM 的节点，未物化的留待下次；_dropWysiwygMaskNode 只作废本节点', async () => {
  await withEditor({}, async (w, ed) => {
    const connected = w.document.createElement('div');
    w.document.body.appendChild(connected);
    const detached = w.document.createElement('div'); // 未入 DOM（虚拟模式视口外块的模拟）

    const origPost = ed._wysiwygPostProcessAsync;
    const origGen = ed._wysiwygNodeGen;
    const calls = [];
    ed._wysiwygPostProcessAsync = (n) => { calls.push(n); };
    ed._wysiwygNodeGen = new Map([ [connected, 1], [detached, 1] ]);
    ed._wysiwygPendingAsync = new Set([connected, detached]);
    ed.viewMode = 'wysiwyg';
    try {
      ed.flushWysiwygAsyncPasses();
      assert.deepStrictEqual(calls, [connected], '只冲刷已入 DOM 的节点');
      assert.strictEqual(ed._wysiwygPendingAsync.size, 1, '未物化节点必须留在待跑集');
      assert.ok(ed._wysiwygPendingAsync.has(detached));

      // 作废已处理节点：代数 +1、移出待跑集；未物化的 detached 仍在待跑集（下次冲刷再试），代数不受牵连
      ed._dropWysiwygMaskNode(connected);
      assert.strictEqual(ed._wysiwygPendingAsync.size, 1, '只有本节点被移出待跑集');
      assert.ok(ed._wysiwygPendingAsync.has(detached), '未物化节点必须留待下次冲刷');
      assert.strictEqual(ed._wysiwygNodeGen.get(connected), 2, '本节点代数必须 +1（在飞 pass 停写）');
      assert.strictEqual(ed._wysiwygNodeGen.get(detached), 1, '他节点代数不受牵连');
    } finally {
      ed._wysiwygPostProcessAsync = origPost;
      ed._wysiwygNodeGen = origGen;
      ed._wysiwygPendingAsync = new Set();
      connected.remove();
      ed.viewMode = 'preview';
    }
  });
});

test('mermaid.run 串行化（并发≤1）且容器 id 跨调用全局唯一（同毫秒并发不碰撞）', async () => {
  await withEditor({}, async (w) => {
    assert.ok(w.PreviewPost && typeof w.PreviewPost.processMermaid === 'function', 'PreviewPost.processMermaid 必须可用');
    const origMermaid = w.mermaid;
    let inFlight = 0;
    let maxInFlight = 0;
    w.mermaid = {
      initialize() {},
      run: async ({ nodes }) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(15); // 拉长窗口，若并发则 inFlight 必达 2
        nodes.forEach((n) => { n.innerHTML = '<svg></svg>'; });
        inFlight--;
      },
    };
    const mk = (codeText) => {
      const d = w.document.createElement('div');
      d.innerHTML = '<pre><code class="language-mermaid"></code></pre>';
      d.querySelector('code').textContent = codeText;
      return d;
    };
    const d1 = mk('graph TD\nA --> B');
    const d2 = mk('graph LR\nX --> Y');
    try {
      const p1 = w.PreviewPost.processMermaid(d1, { isDark: false, mermaidCache: new Map() });
      const p2 = w.PreviewPost.processMermaid(d2, { isDark: false, mermaidCache: new Map() });
      await Promise.all([p1, p2]);
      assert.strictEqual(maxInFlight, 1, 'mermaid.run 必须串行（并发 1），实测最大并发 ' + maxInFlight);
      const c1 = d1.querySelector('.mermaid-container');
      const c2 = d2.querySelector('.mermaid-container');
      assert.ok(c1 && c2, 'pre 必须被替换为 mermaid-container');
      assert.notStrictEqual(c1.id, c2.id, '同毫秒并发的容器 id 必须唯一，实际: ' + c1.id + ' vs ' + c2.id);
      assert.ok(c1.querySelector('svg') && c2.querySelector('svg'), '两张图都必须渲染出 SVG');
    } finally {
      w.mermaid = origMermaid;
    }
  });
});
