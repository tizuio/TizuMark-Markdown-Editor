// P1-4（2026-08-01 审查修复）：_imageURLCache Blob URL LRU 容量上限测试。
// 覆盖：① 命中缓存返回同一 URL 且刷新 LRU 序；② 超限 revoke 最久未用的 Blob URL；
//        ③ beforeunload 全量 revoke。
// 注：jsdom 未实现 URL.createObjectURL/revokeObjectURL，测试 stub 之。

const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

// 合法 base64（PNG 头），保证 atob 可解码
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const P1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE=';
const P2 = 'data:image/png;base64,iVBORw0KGgoAAAABCAYAAA';
const P3 = 'data:image/png;base64,iVBORw0KGgoAAAABCAYAAAA';

test('getCachedImageURL: 命中缓存复用同一 URL', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  const origCreate = w.URL.createObjectURL;
  const origRevoke = w.URL.revokeObjectURL;
  let count = 0;
  w.URL.createObjectURL = () => 'blob:mock-' + (count++);
  w.URL.revokeObjectURL = () => {};
  try {
    const first = ed.getCachedImageURL(PNG);
    const second = ed.getCachedImageURL(PNG);
    assert.strictEqual(first, second, '同一 dataUri 应复用同一 Blob URL');
    assert.strictEqual(count, 1, '只应创建一次');
  } finally {
    w.URL.createObjectURL = origCreate;
    w.URL.revokeObjectURL = origRevoke;
  }
}));

test('getCachedImageURL: 超限 revoke 最久未用的 URL（LRU）', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed._imageURLCacheMax = 3;
  const origCreate = w.URL.createObjectURL;
  const origRevoke = w.URL.revokeObjectURL;
  const created = [];
  const revoked = [];
  w.URL.createObjectURL = () => { const u = 'blob:mock-' + created.length; created.push(u); return u; };
  w.URL.revokeObjectURL = (u) => revoked.push(u);
  try {
    ed.getCachedImageURL(PNG);
    ed.getCachedImageURL(P1);
    ed.getCachedImageURL(P2);
    // 访问 PNG 刷新 LRU 序（PNG 最新，P1 最旧）
    ed.getCachedImageURL(PNG);
    ed.getCachedImageURL(P3);
    assert.strictEqual(ed._imageURLCache.size, 3, '容量应钳制在 3');
    assert.deepStrictEqual(revoked, ['blob:mock-1'], '应 revoke 最久未用的 P1（mock-1）');
    // 刷新过的 PNG 仍可用
    assert.strictEqual(ed.getCachedImageURL(PNG), 'blob:mock-0');
  } finally {
    w.URL.createObjectURL = origCreate;
    w.URL.revokeObjectURL = origRevoke;
  }
}));

test('getCachedImageURL: beforeunload 全量 revoke', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  const origCreate = w.URL.createObjectURL;
  const origRevoke = w.URL.revokeObjectURL;
  const revoked = [];
  w.URL.createObjectURL = () => 'blob:mock-u';
  w.URL.revokeObjectURL = (u) => revoked.push(u);
  try {
    ed.getCachedImageURL(PNG);
    ed.getCachedImageURL(P1);
    w.dispatchEvent(new w.Event('beforeunload'));
    assert.strictEqual(revoked.length, 2, '退出时应全量 revoke');
    assert.strictEqual(ed._imageURLCache.size, 0, '退出后缓存应清空');
  } finally {
    w.URL.createObjectURL = origCreate;
    w.URL.revokeObjectURL = origRevoke;
  }
}));

// 2026-11-18 修复回归：阅读模式「有些图显示不出来」。
// 根因：getCachedImageURL 的 LRU（上限 64）无脑 revoke 队首项——blob URL 直接挂在
// <img src> 上，阅读模式整篇一次过、图多于上限时先处理的图必然被 revoke 即裂图
// （真机 80 图实测前 16 张全挂 = 80-64；实时预览逐块渲染 < 64 张所以没事）。
// 修复：淘汰改为软上限——跳过仍被 DOM img 引用的条目。

test('getCachedImageURL: 超限但队首 URL 仍被 DOM img 引用 → 跳过它淘汰下一条（不裂图）', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed._imageURLCacheMax = 3;
  const origCreate = w.URL.createObjectURL;
  const origRevoke = w.URL.revokeObjectURL;
  const created = [];
  const revoked = [];
  w.URL.createObjectURL = () => { const u = 'blob:mock-' + created.length; created.push(u); return u; };
  w.URL.revokeObjectURL = (u) => revoked.push(u);
  let img = null;
  try {
    const u0 = ed.getCachedImageURL(PNG);   // mock-0
    ed.getCachedImageURL(P1);               // mock-1
    ed.getCachedImageURL(P2);               // mock-2
    // mock-0 仍挂在页面 <img> 上（模拟阅读模式已显示的图）
    img = w.document.createElement('img');
    img.src = u0;
    w.document.body.appendChild(img);
    // 第 4 张：插入前超限 → 队首 mock-0 被引用必须跳过，淘汰次旧的 mock-1
    ed.getCachedImageURL(P3);
    assert.deepStrictEqual(revoked, ['blob:mock-1'], '应跳过被引用的 mock-0，revoke 未被引用的 mock-1');
    assert.strictEqual(ed._imageURLCache.size, 3, '容量仍钳制在 3');
    // mock-0 命中复用（未 revoke，页面上的图不裂）
    assert.strictEqual(ed.getCachedImageURL(PNG), 'blob:mock-0', '被引用的 mock-0 应仍在缓存中复用');
  } finally {
    if (img) img.remove();
    w.URL.createObjectURL = origCreate;
    w.URL.revokeObjectURL = origRevoke;
  }
}));

test('getCachedImageURL: 全部条目都被引用 → 软上限不淘汰不 revoke（缓存可临时超限）', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed._imageURLCacheMax = 3;
  const origCreate = w.URL.createObjectURL;
  const origRevoke = w.URL.revokeObjectURL;
  const revoked = [];
  let count = 0;
  w.URL.createObjectURL = () => 'blob:mock-' + (count++);
  w.URL.revokeObjectURL = (u) => revoked.push(u);
  const imgs = [];
  try {
    const u0 = ed.getCachedImageURL(PNG);
    const u1 = ed.getCachedImageURL(P1);
    const u2 = ed.getCachedImageURL(P2);
    for (const u of [u0, u1, u2]) {
      const img = w.document.createElement('img');
      img.src = u;
      w.document.body.appendChild(img);
      imgs.push(img);
    }
    // 第 4 张：3 条全被引用 → 不淘汰（缓存超限到 4），零 revoke
    ed.getCachedImageURL(P3);
    assert.deepStrictEqual(revoked, [], '全部被引用时不得 revoke 任何 URL');
    assert.strictEqual(ed._imageURLCache.size, 4, '软上限：全被引用时缓存可临时超限');
    // 移除引用后再插入全新条目 → 恢复正常淘汰
    imgs.forEach((i) => i.remove());
    ed.getCachedImageURL(PNG); // 命中刷新（PNG 最新）
    // 全新 dataUri 才触发插入（P1..P3 已在缓存，命中不触发淘汰）。
    // 此刻 LRU 序：P1(m1) 最旧 → 淘汰 mock-1（base64 长度必须为 4 的倍数，否则 atob 抛错走 catch）
    ed.getCachedImageURL('data:image/png;base64,iVBORw0KGgoAAAAB');
    assert.deepStrictEqual(revoked, ['blob:mock-1'], '引用解除后恢复 LRU 淘汰');
  } finally {
    imgs.forEach((i) => { try { i.remove(); } catch (_) {} });
    w.URL.createObjectURL = origCreate;
    w.URL.revokeObjectURL = origRevoke;
  }
}));
