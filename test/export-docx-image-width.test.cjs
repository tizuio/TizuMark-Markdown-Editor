// Word 导出图片不得超出页面宽度：超出时等比例缩小，小图保持原尺寸。
//
// 背景（用户截图）：外链风景图在 docx 里右边缘被页面裁掉。
// export.js 的「DOM 预处理」是带超时的可选步骤，一旦被跳过，_applyWordImgSize 不会
// 给 clone 里的 <img> 写 width 属性，imageToNode 便退回读预览显示宽度（约 680px），
// 而 A4 标准边距下的可用宽只有 11906-1800-1800=8306 twips ≈ 553px → 溢出裁切。
// 修复：docx-builder 构造 ImageRun 前按 page 做最后一道钳位（clampImageToPage）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withEditor } = require('./helpers/app-env.cjs');

const ROOT = path.join(__dirname, '..');
const BUILDER_SRC = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'docx-builder.js'), 'utf8');
const EXPORT_SRC = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'export.js'), 'utf8');
const { clampImageToPage } = require(path.join(ROOT, 'src', 'modules', 'docx-builder.js'));

// A4 纵向 / 标准边距，与 export.js _docxPageConfig() 一致
const PAGE = {
  pageWidth: 11906, pageHeight: 16838,
  marginTop: 1440, marginBottom: 1440, marginLeft: 1800, marginRight: 1800,
  maxImageWidthPx: 500,
};
const PX_TO_EMU = 9525;      // 96dpi
const TWIP_TO_EMU = 635;     // 1 twip = 1/20pt = 635 EMU
const USABLE_EMU = (PAGE.pageWidth - PAGE.marginLeft - PAGE.marginRight) * TWIP_TO_EMU;

// ---------------------------------------------------------------- 纯函数：钳位口径

test('超宽图等比缩到上限，宽高比保持不变', () => {
  const s = clampImageToPage({ width: 680, height: 400 }, PAGE);
  assert.strictEqual(s.width, 500, '应限制到 500px（既有口径），而非 553px 页面极限');
  assert.strictEqual(s.height, 294, '高度应等比缩放：400*500/680=294');
  assert.ok(Math.abs(s.width / s.height - 680 / 400) < 0.02, '宽高比必须保持');
});

test('小图保持原尺寸，绝不放大', () => {
  assert.deepStrictEqual(clampImageToPage({ width: 240, height: 180 }, PAGE), { width: 240, height: 180 });
  assert.deepStrictEqual(clampImageToPage({ width: 500, height: 300 }, PAGE), { width: 500, height: 300 });
});

test('页面更窄时按页面可用宽度钳位，而非死守 500', () => {
  const narrow = { pageWidth: 6000, pageHeight: 16838, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 };
  const s = clampImageToPage({ width: 680, height: 340 }, narrow);
  assert.strictEqual(s.width, 400, '6000twips/15=400px');
  assert.strictEqual(s.height, 200, '等比缩到一半');
});

test('page 缺失/脏数据退回默认上限，不把图片压成 1px', () => {
  for (const p of [undefined, null, {}, { pageWidth: 1, marginLeft: 0, marginRight: 0 }]) {
    const s = clampImageToPage({ width: 900, height: 450 }, p);
    assert.strictEqual(s.width, 500, `page=${JSON.stringify(p)} 应退回 500px`);
    assert.strictEqual(s.height, 250);
  }
});

test('宽高缺失时给可用兜底，不产生 0 或 NaN', () => {
  for (const n of [{}, { width: 0, height: 0 }, { width: 680 }, { width: 680, height: 0 }]) {
    const s = clampImageToPage(n, PAGE);
    assert.ok(s.width > 0 && s.height > 0, `${JSON.stringify(n)} 应给出正数尺寸`);
    assert.ok(Number.isFinite(s.width) && Number.isFinite(s.height));
    assert.ok(s.width <= 500);
  }
});

// ---------------------------------------------------------------- 集成：页面配置把上限传给 builder

test('export.js: _docxPageConfig 带 maxImageWidthPx，且两处限宽共用同一常量', async () => {
  await withEditor({}, async (_w, ed) => {
    const cfg = ed._docxPageConfig();
    assert.strictEqual(cfg.pageWidth, 11906);
    assert.strictEqual(cfg.maxImageWidthPx, 500, '500px 与页面可用宽 553px 取较小值');
  });
  assert.ok(EXPORT_SRC.includes('const WORD_IMG_MAX_PX = 500;'), '限宽常量应统一定义');
  const calls = EXPORT_SRC.match(/_applyWordImgSize\(img, natW, natH, WORD_IMG_MAX_PX/g) || [];
  assert.strictEqual(calls.length, 2, 'mermaid 与普通图片两条路径都要用同一上限');
  assert.ok(EXPORT_SRC.includes('maxImageWidthPx:'), '页面配置必须把上限传给 builder');
});

// ---------------------------------------------------------------- 端到端：真 docx 里 wp:extent 不超页

test('端到端：680px 图片写进 docx 后 cx 不超过页面可用宽且等比', async () => {
  const JSZip = require('jszip');
  if (!globalThis.DocxLib) globalThis.DocxLib = require('docx');
  const D = globalThis.DocxLib;
  // node 下 Packer.toBlob 依赖浏览器 Blob 流，用真实 toBuffer 桩掉（与既有用例同款）
  if (!D.Packer.__toBufferPatched) {
    const realToBuffer = D.Packer.toBuffer.bind(D.Packer);
    D.Packer.toBlob = async (doc) => {
      const buf = await realToBuffer(doc);
      return { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    };
    D.Packer.__toBufferPatched = true;
  }
  const { buildDocxFromStructure } = require(path.join(ROOT, 'src', 'modules', 'docx-builder.js'));
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(24).fill(0x41)]);
  const structure = [{ type: 'image', data: png, imageType: 'png', width: 680, height: 400 }];

  // 强制 resolveDocxLib 走上面这份 require('docx')，屏蔽 jsdom 测试可能泄漏的全局 window
  const savedWindow = globalThis.window;
  globalThis.window = undefined;
  let ab;
  try {
    const blob = await buildDocxFromStructure(structure, PAGE);
    ab = await blob.arrayBuffer();
  } finally {
    globalThis.window = savedWindow;
  }

  const zip = new JSZip();
  zip.load(Buffer.from(ab));
  const xml = zip.file('word/document.xml').asText();
  const m = /<wp:extent\s+cx="(\d+)"\s+cy="(\d+)"\s*\/>/.exec(xml);
  assert.ok(m, 'document.xml 应含图片 extent');
  const cx = Number(m[1]);
  const cy = Number(m[2]);
  assert.ok(cx <= USABLE_EMU, `图片宽 ${cx} EMU 不得超过页面可用宽 ${USABLE_EMU} EMU`);
  assert.ok(cx < 680 * PX_TO_EMU, '超宽图必须真的被缩小');
  assert.strictEqual(cx, 500 * PX_TO_EMU, '应钳到 500px');
  assert.ok(Math.abs(cx / cy - 680 / 400) < 0.02, `docx 内宽高比应等比，实际 ${cx}/${cy}`);
});

// ---------------------------------------------------------------- 静态防回退

test('静态契约：ImageRun 必须走钳位，不得直接吃 structure 里的裸宽高', () => {
  assert.ok(BUILDER_SRC.includes('transformation: clampImageToPage(node, page)'),
    '构建图片时必须调用钳位');
  assert.ok(!BUILDER_SRC.includes('transformation: { width: node.width'),
    '不得回退为未钳位的裸尺寸');
  assert.ok(BUILDER_SRC.includes('module.exports = api'), 'node 侧导出契约应保持');
  assert.ok(BUILDER_SRC.includes('clampImageToPage }'), '钳位纯函数应可供回归测试直接调用');
});
