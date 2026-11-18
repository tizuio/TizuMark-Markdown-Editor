/**
 * multi-window.js —— tab 撕离多窗口纯函数(设计:docs/superpowers/specs/2026-11-18-tab-tearoff-window-design.md)
 *
 * 只放纯函数与键名常量:窗口 label 分配 / 几何级联 / boot 参数解析 / localStorage 交接键 /
 * 退出聚合会话合并。不读任何全局(storage 由调用方注入,测试传 mock),便于单测与 jsdom 回归。
 *
 * 双导出:浏览器挂 window.TMMultiWindow;node 走 module.exports(互斥式,与 preview-window.js 同款)。
 */
(function () {
  'use strict';

  // 分离窗口交接键前缀:源窗口建窗前写 <prefix><label>,分离窗口 boot 消费后清除;
  // 主窗口 boot 清扫残留(sweepStaleHandoffs)。会话键仍用 tizumark-session(-<label>),不在此列。
  const HANDOFF_PREFIX = 'tizumark-window-handoff-';

  // label 口径:editor-<数字> 才算分离窗口(Rust 侧 is_editor_label 同口径,两侧须一致)。
  // 'editor-' 无编号不算,防误伤;主窗口恒为 'main'。
  function isDetachedLabel(label) {
    return /^editor-\d+$/.test(String(label || ''));
  }

  // 已有 editor-* 窗口编号中取最小空位(1,3 存在 → editor-2);无则 1。编号有界,空位即复用。
  // 传入当前存活 label 列表(TauriApi.listEditorWindows)。
  function nextEditorLabel(existing) {
    const used = new Set();
    for (const l of existing || []) {
      const m = /^editor-(\d+)$/.exec(String(l || ''));
      if (m) used.add(parseInt(m[1], 10));
    }
    let n = 1;
    while (used.has(n)) n++;
    return 'editor-' + n;
  }

  // 建窗几何:主窗口尺寸为基,x/y 按 slot 级联偏移(每窗 28px,可叠出层叠感),负坐标钳 0;
  // 尺寸不小于 800×600(与 tauri.conf.json minWidth/minHeight 一致,避免 window-state 残留影响)。
  function cascadeGeometry(base, slot) {
    const b = base || {};
    const w = Math.max(800, Number(b.width) || 1200);
    const h = Math.max(600, Number(b.height) || 800);
    const x = Math.max(0, (Number(b.x) || 0) + slot * 28);
    const y = Math.max(0, (Number(b.y) || 0) + slot * 28);
    return { x: x, y: y, width: w, height: h };
  }

  // boot 参数解析:?label=editor-<n> → detached 分离窗口模式;其余(含 main/无参)一律主窗口。
  function parseBootParams(search) {
    let label = null;
    try {
      const m = /[?&]label=([^&]*)/.exec(String(search || ''));
      if (m) label = decodeURIComponent(m[1]);
    } catch (_) { label = null; }
    const detached = isDetachedLabel(label);
    return { detached: detached, label: detached ? label : null };
  }

  // 交接负载:序列化 Tab 的全部随迁状态。savedContent 必带(未保存修改态 isModified 随迁),
  // filePath 可为 null(未命名 tab——多屏协作主场景,不可因无路径拒绝撕离)。
  function buildHandoffPayload(tab) {
    const t = tab || {};
    return {
      tab: {
        name: t.name,
        content: t.content,
        savedContent: t.savedContent,
        filePath: t.filePath,
        kind: t.kind,
        cursorPos: t.cursorPos || { line: 0, ch: 0 },
        scrollPos: t.scrollPos || { top: 0, left: 0 },
        previewScrollTop: t.previewScrollTop || 0,
        fileMeta: t.fileMeta || null,
        pendingExternalChange: !!t.pendingExternalChange,
        _loadError: !!t._loadError,
      },
    };
  }

  function writeHandoff(label, tab, storage) {
    storage.setItem(HANDOFF_PREFIX + label, JSON.stringify(buildHandoffPayload(tab)));
  }

  function readHandoff(label, storage) {
    try {
      const raw = storage.getItem(HANDOFF_PREFIX + label);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.tab) return null;
      return data;
    } catch (e) {
      // 损坏 JSON 视同缺失，但必须留下诊断线索（评审 P1-2：不再静默吞掉）
      console.warn('[TizuMark] handoff payload corrupt:', e);
      return null;
    }
  }

  function clearHandoff(label, storage) {
    storage.removeItem(HANDOFF_PREFIX + label);
  }

  // 清扫残留交接键(主窗口 boot 调):建窗后源窗口崩溃、分离窗口 boot 失败都会留垃圾;
  // 只清 editor-<数字>,main/会话键等其余键一律不动。返回被删键列表(便于日志/测试)。
  function sweepStaleHandoffs(storage) {
    const removed = [];
    try {
      const n = storage.length;
      const keys = [];
      for (let i = 0; i < n; i++) {
        const k = storage.key(i);
        if (k && k.indexOf(HANDOFF_PREFIX) === 0 && /^editor-\d+$/.test(k.slice(HANDOFF_PREFIX.length))) {
          keys.push(k);
        }
      }
      for (const k of keys) {
        storage.removeItem(k);
        removed.push(k);
      }
    } catch (_) { /* 清扫失败不阻塞启动,残留键由下次 boot 再清 */ }
    return removed;
  }

  // 拖拽撕离判定:指针落在窗口边界外即撕离候选(默认留 8px 容差,防贴边误触)。
  // 拖拽=移动语义(Excel/Word),配合 tabs.js initTabDragEvents 的 mouseup 分支使用。
  function tearOffPoint(x, y, width, height, margin) {
    const m = Number.isFinite(margin) ? margin : 8;
    x = Number(x); y = Number(y);
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return x < -m || x > w + m || y < -m || y > h + m;
  }

  // 拖拽撕落几何:落点即新窗左上角(逻辑坐标 = 窗口原点 base + 窗口内落点 dropClient*),
  // 负值钳 0;尺寸沿用级联结果。让新窗出现在用户松手的地方,而非固定级联位。
  function tearOffGeometry(base, dropPt, width, height) {
    const b = base || {};
    const d = dropPt || {};
    return {
      x: Math.max(0, (Number(b.x) || 0) + (Number(d.dropClientX) || 0)),
      y: Math.max(0, (Number(b.y) || 0) + (Number(d.dropClientY) || 0)),
      width: width,
      height: height,
    };
  }

  // 显示器工作区钳制（评审 P2-6）：bounds 为逻辑像素 {x,y,width,height}。
  // 拖到屏幕右/下边缘松手时，避免新窗大比例落在屏外；窗口大于工作区时贴左上。
  function clampGeometry(geometry, bounds) {
    const g = geometry || {};
    const w = Math.max(800, Number(g.width) || 1200);
    const h = Math.max(600, Number(g.height) || 800);
    if (!bounds) {
      return { x: Math.max(0, Number(g.x) || 0), y: Math.max(0, Number(g.y) || 0), width: w, height: h };
    }
    const bx = Number(bounds.x) || 0;
    const by = Number(bounds.y) || 0;
    const maxX = bx + (Number(bounds.width) || 0) - w;
    const maxY = by + (Number(bounds.height) || 0) - h;
    return {
      x: Math.max(bx, Math.min(Number(g.x) || 0, maxX)),
      y: Math.max(by, Math.min(Number(g.y) || 0, maxY)),
      width: w,
      height: h,
    };
  }

  // 所有显示器的物理像素并集（评审 P2-6）：以统一坐标空间钳制新窗，
  // 既不把窗口拉回源显示器（支持拖到副屏），也不让它落到桌面区域之外。
  function monitorUnionBounds(monitors) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const m of monitors || []) {
      if (!m || !m.position || !m.size) continue;
      const x = Number(m.position.x) || 0;
      const y = Number(m.position.y) || 0;
      const w = Number(m.size.width) || 0;
      const h = Number(m.size.height) || 0;
      if (w <= 0 || h <= 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    }
    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  // 退出聚合:把各分离窗口会话的 tabs(filePath 去重、保序)追加进主会话;主会话其余字段
  // (activeFilePath/workspaceFolder/expandedFolders/emptyTabs/version)一律不动——重启后
  // 分离窗口文件以主窗口 tab 恢复(设计定案 4 的降级无损路径)。
  function mergeDetachedSessions(mainSession, detachedSessions) {
    const m = mainSession || {};
    const tabs = Array.isArray(m.tabs) ? m.tabs.slice() : [];
    const seen = {};
    for (const t of tabs) seen[t && t.filePath] = true;
    for (const d of detachedSessions || []) {
      for (const t of (d && Array.isArray(d.tabs) ? d.tabs : [])) {
        if (!t || !t.filePath || seen[t.filePath]) continue;
        seen[t.filePath] = true;
        tabs.push(t);
      }
    }
    m.tabs = tabs;
    return m;
  }

  const api = {
    HANDOFF_PREFIX: HANDOFF_PREFIX,
    isDetachedLabel: isDetachedLabel,
    nextEditorLabel: nextEditorLabel,
    cascadeGeometry: cascadeGeometry,
    parseBootParams: parseBootParams,
    buildHandoffPayload: buildHandoffPayload,
    writeHandoff: writeHandoff,
    readHandoff: readHandoff,
    clearHandoff: clearHandoff,
    sweepStaleHandoffs: sweepStaleHandoffs,
    tearOffPoint: tearOffPoint,
    tearOffGeometry: tearOffGeometry,
    clampGeometry: clampGeometry,
    monitorUnionBounds: monitorUnionBounds,
    mergeDetachedSessions: mergeDetachedSessions,
  };

  if (typeof window !== 'undefined' && typeof module === 'undefined') {
    window.TMMultiWindow = api;
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
