// 滚动同步锚点与测量修复（2026-10-31 用户反馈「左右分屏差一点、上下分屏差太多」）：
// 1) _getOffsetTop 旧实现走 offsetParent 链，.preview-content 无 position 导致 offsetParent
//    越过 this.preview 直达 #preview-wrapper/body → 结果恒多出「pane 顶部偏移」
//    （横向 +88px≈4 行 / 纵向 +486px≈22 行）→ 预览滚动同步恒超前。修复 = rect 相对测量。
// 2) _computedPosition 只给块级元素建锚点，代码块内部 15~N 行无锚点 → 段中部插值偏差
//    4~5 行。修复 = 利用 .code-line 行结构补逐行锚点（每块 2 次 rect + 行高推算）。
// jsdom 的 getBoundingClientRect 恒 0，行为断言不可靠 → 静态断言锁实现契约。
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'preview-sync.js'), 'utf8');

test('scroll-sync: _getOffsetTop 用 getBoundingClientRect 相对测量（禁回退 offsetParent 链）', () => {
  const fn = src.match(/_getOffsetTop\(el\) \{[\s\S]*?\n      \}/);
  assert.ok(fn, '应能定位 _getOffsetTop 函数体');
  assert.ok(fn[0].includes('getBoundingClientRect'), '应基于 getBoundingClientRect');
  assert.ok(!fn[0].includes('offsetParent'), '不得再走 offsetParent 链（会把 pane 顶部偏移累加进 scrollTop，预览恒超前）');
});

test('scroll-sync: _computedPosition 含代码块逐行锚点扩展', () => {
  assert.ok(src.includes(".querySelectorAll('.code-line')"), '应利用 .code-line 行结构补锚点');
  assert.ok(src.includes('fenceLine + 1 + i'), '代码行源码行号 = 围栏行 + 1 + 行索引（开围栏占 1 行）');
});
