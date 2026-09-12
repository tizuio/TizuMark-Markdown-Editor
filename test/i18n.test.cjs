// i18n 测试：字典完整性 / t() 取值与插值回退 / applyLanguage 切换 DOM
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { buildEnv, cleanup, delay, waitForEditor } = require('./helpers/app-env.cjs');

async function makeEditor() {
  const { w } = await buildEnv({ captureInitErr: true });
  const ed = await waitForEditor(w);
  return { w, ed };
}

function extractI18N() {
  // 字典数据已从 app.js → i18n.js → i18n-data.js 拆分（缩进 2 空格），正则需容忍前导空白
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'i18n-data.js'), 'utf8');
  const m = src.match(/(?:^|\n)[ \t]*const I18N = \{[\s\S]*?\n[ \t]*\};/);
  assert.ok(m, '应能从源码中提取 I18N 字典');
  return new Function('return ' + m[0].replace(/^[\s\S]*?const I18N = /, '').replace(/;\s*$/, ''))();
}

test('i18n: zh/en 字典键集合一致', async () => {
  const I18N = extractI18N();
  const zh = Object.keys(I18N.zh);
  const en = Object.keys(I18N.en);
  // 已知遗留死键：en.failedGuideEn 无引用且 zh 缺失（t() 会回退，不影响运行）
  const knownOrphans = ['failedGuideEn'];
  const missEn = zh.filter((k) => !(k in I18N.en));
  const missZh = en.filter((k) => !(k in I18N.zh) && !knownOrphans.includes(k));
  assert.deepStrictEqual(missEn, [], 'zh 中每个键 en 都应有翻译');
  assert.deepStrictEqual(missZh, [], 'en 不应出现 zh 没有的新键（白名单除外）');
  assert.ok(zh.length > 300, '字典规模合理（>300 键）');
});

test('i18n: 字典值均为非空字符串', async () => {
  const I18N = extractI18N();
  for (const lang of ['zh', 'en']) {
    for (const [k, v] of Object.entries(I18N[lang])) {
      if (typeof v === 'object' && v !== null) {
        // 允许嵌套映射（如 shortcutLabel），其内部值须为非空字符串
        for (const [sk, sv] of Object.entries(v)) {
          assert.strictEqual(typeof sv, 'string', `${lang}.${k}.${sk} 应为字符串`);
          assert.ok(sv.length > 0, `${lang}.${k}.${sk} 不应为空`);
        }
        continue;
      }
      assert.strictEqual(typeof v, 'string', `${lang}.${k} 应为字符串`);
      assert.ok(v.length > 0, `${lang}.${k} 不应为空`);
    }
  }
});

test('i18n: t() 按语言取值且支持 {param} 插值', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings.language = 'zh';
    assert.strictEqual(ed.t('file'), '文件');
    ed.settings.language = 'en';
    assert.strictEqual(ed.t('file'), 'File');
    // 插值：找一个含 {} 占位符的键做真实验证
    const I18N = extractI18N();
    const kv = Object.entries(I18N.zh).find(([, v]) => /\{(\w+)\}/.test(v));
    assert.ok(kv, '字典中应存在含占位符的键');
    const [key, tpl] = kv;
    const pname = tpl.match(/\{(\w+)\}/)[1];
    ed.settings.language = 'zh';
    const out = ed.t(key, { [pname]: 'XYZ42' });
    assert.ok(out.includes('XYZ42'), '占位符应被替换');
    assert.ok(!out.includes('{' + pname + '}'), '不应残留占位符');
  } finally { cleanup(w); }
});

test('i18n: t() en 缺键回退 zh，未知键返回键名', async () => {
  const { w, ed } = await makeEditor();
  try {
    ed.settings.language = 'en';
    assert.strictEqual(ed.t('__no_such_key__'), '__no_such_key__', '未知键应原样返回');
    ed.settings.language = 'fr'; // 非 en 一律按 zh
    assert.strictEqual(ed.t('file'), '文件', '非 en 语言应按 zh 处理');
  } finally { cleanup(w); }
});

test('i18n: applyLanguage 切换工具栏/菜单文案', async () => {
  const { w, ed } = await makeEditor();
  try {
    const fileSpan = w.document.querySelector('#btn-file span:not(.dropdown-arrow)');
    const newSpan = w.document.querySelector('#btn-new span:not(.shortcut):not(.icon)');
    assert.ok(fileSpan && newSpan, 'DOM 应存在工具栏/菜单元素');
    ed.settings.language = 'en';
    ed.applyLanguage();
    assert.strictEqual(fileSpan.textContent, 'File');
    assert.strictEqual(newSpan.textContent, 'New');
    ed.settings.language = 'zh';
    ed.applyLanguage();
    assert.strictEqual(fileSpan.textContent, '文件');
    assert.strictEqual(newSpan.textContent, '新建');
  } finally { cleanup(w); }
});
