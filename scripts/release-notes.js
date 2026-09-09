#!/usr/bin/env node
'use strict';
/**
 * scripts/release-notes.js —— 自动生成 Release Note（单一来源）。
 *
 * ⚠️⚠️ 格式红线（绝对不可更改）⚠️⚠️
 * 发布说明的「骨架」必须与 Gitee 上 v1.2.0 真实发布内容完全一致：
 *   1. `## ⬇️ 下载` + 三行下载链接（版本号随当前版本变化）
 *   2. `### 三种安装包说明` + 三行对比表格（NSIS/MSI/绿色版，文件名随版本变化）
 *   3. `---` 分隔线
 *   4. `## ✨ v<版本> 更新内容` + `### 新增` / `### 改进` / `### 修复` 三个分类小节
 *   5. 尾部 `> 使用中遇到问题欢迎加 QQ 群：1035294939`
 * 只允许变化：版本号、文件名、分类下的条目内容。结构、标题、表格列、说明文字一律不动。
 * 历史教训：曾把 v1.2.1 生成成「自 v1.2.0 起共 N 项提交 + 平铺列表」的自定义格式，
 *           与 v1.2.0 模板不一致被用户纠正。此后任何发布说明必须生成上述模板格式。
 *
 * 用途：每次「打包 / 发布」时，检查「自上次版本发布标签至今」的全部提交，
 *       把每个改动 / 需求用简短语言归纳成发布说明，满足：
 *         - 防止漏掉某次重要提交未写入发布说明；
 *         - release.js / github-release.js 直接 require 本文件取 VERSION 与 notesLines，
 *           保证 Gitee / GitHub 两个平台的发布说明完全一致。
 *
 * 双语：中文全文由本脚本自动生成（下方骨架，红线不可改）；其后紧跟 `---` 分隔线，
 *       再追加英文全文。英文全文来自 release/RELEASE_NOTES_en.md（由 AI 根据中文发布说明生成，
 *       非人工撰写；即原发往 GitHub 的英文说明），下载链接用 Gitee 域名以便 github-release.js 改写。
 *       最终 body = 中文全文 + `\n\n---\n\n` + 英文全文，Gitee / GitHub 两端一致。
 *
 * 版本号来源：package.json（发布前由人工 bump）。
 * 上次发布标签：严格取「小于当前 VERSION」的最大发布 tag（见 lastTag，勿改回 git describe）。
 *
 * 作为主脚本运行（node scripts/release-notes.js）时会把说明写入
 *   release/RELEASE_NOTES_v<VERSION>.md 并打印摘要；
 * 被 require 时只产出内存中的 VERSION / notesLines（供发布脚本使用，不落盘）。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');

function readPkg() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}
const VERSION = readPkg().version;

function git(args) {
  try {
    return execSync('git ' + args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// 上次发布标签：取「小于当前 VERSION」的最大发布 tag。
// 注意：绝不能用 `git describe --tags --abbrev=0`——它会返回「当前 VERSION 对应的 tag 自身」，
// 导致 0 提交 + "自 X 起" 这种空内容（例如发布 v1.2.2 时它返回 v1.2.2 自身）。
// 必须显式按版本号筛选「小于当前 VERSION 的最大 tag」作为基准，即动态的上一个发布版本。
function lastTag() {
  const all = git('tag --list')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((t) => /^v?\d+\.\d+\.\d+$/.test(t));
  if (!all.length) return '';
  const candidates = all.filter((t) => cmpVer(t, VERSION) < 0);
  if (candidates.length) return candidates.sort(cmpVer).pop();
  // 没有任何更早的发布 tag（首发版本）→ 返回空，让 collectCommits 输出全部提交
  return '';
}

// 收集自 lastTag 至今的提交（仅在 git 仓库内有效）
function collectCommits(sinceTag) {
  const range = sinceTag ? `${sinceTag}..HEAD` : 'HEAD';
  const out = git(`log ${range} --pretty=format:%s`);
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 把一条提交信息归纳成一句话（去前缀、压缩「代码描述」风格大段）
function summarize(raw) {
  if (!raw) return '';
  let s = raw.replace(/\s+/g, ' ').trim();

  // 1) 去掉常见的 Conventional Commits 类型前缀，但保留中文语义
  s = s.replace(/^(feat|fix|refactor|perf|test|chore|docs|style|build|ci|revert)(\([^)]*\))?\s*[:：]\s*/i, '');

  // 2) 形如「代码描述：【TizuMark】修复 xxx - 点1 - 点2 ...」→ 取第一个「-」之前的主句
  const bulletIdx = s.indexOf(' - ');
  if (bulletIdx > 0 && s.length > bulletIdx + 2) {
    s = s.slice(0, bulletIdx).replace(/代码描述[：:]\s*【[^】]*】\s*/, '');
  } else {
    s = s.replace(/^代码描述[：:]\s*【[^】]*】\s*/, '');
  }

  // 3) 去掉「需求名称：...」「开发进度：...」等尾随元信息
  s = s.replace(/[；;]?\s*(需求名称|开发进度|任务编号|关联)\s*[：:].*$/i, '');

  s = s.trim();
  // 4) 首字母大写更工整
  if (s) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

// ════════════════════════════════════════════════════════════════════
// 发布说明模板 —— 严格对齐 Gitee 上 v1.2.0 的真实发布格式（红线，禁止改结构）
// ════════════════════════════════════════════════════════════════════

function downloadSection() {
  return [
    '## ⬇️ 下载',
    '',
    '> **🏆 推荐大多数用户选择：** [⬇ TizuMark_' + VERSION + '_x64-setup.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v' + VERSION + '/TizuMark_' + VERSION + '_x64-setup.exe)',
    '>',
    '> **🛠 企业/批量部署：** [⬇ TizuMark_' + VERSION + '_x64_en-US.msi](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v' + VERSION + '/TizuMark_' + VERSION + '_x64_en-US.msi)',
    '>',
    '> **📦 绿色版（免安装）：** [⬇ TizuMark_' + VERSION + '_x64.exe](https://gitee.com/tizu/TizuMark-Markdown-Editor/releases/download/v' + VERSION + '/TizuMark_' + VERSION + '_x64.exe)',
    '',
    '### 三种安装包说明',
    '',
    '| 安装包 | 适用人群 | 特点 |',
    '|--------|---------|------|',
    '| ⭐ **NSIS 安装包 (.exe)** — **推荐** | 绝大多数 Windows 用户 | 传统的 setup 向导安装，支持自定义安装路径、创建桌面快捷方式、自动注册文件关联。双击即装，即装即用。 |',
    '| **MSI 安装包 (.msi)** | 企业 IT 管理员、需要批量部署的用户 | 标准的 Windows Installer 格式，支持组策略推送、静默安装（msiexec /i TizuMark_' + VERSION + '_x64_en-US.msi /qn）、适合企业环境集中管理。 |',
    '| **绿色版 (.exe)** | 追求便携的用户 | 单文件免安装，解压即用，适合 U 盘携带、临时使用，不写注册表。 |',
    '',
    '---',
    '',
  ];
}

// 内部发布/打包类提交（客户看不到，发布说明里应过滤）：
//   - chore: release v1.2.1 / release: v1.2.0 重新打包 …
function isInternalReleaseCommit(raw) {
  return /^release\s*[:：]?\s*v?\d/i.test(raw) || /^chore(\s*\([^)]*\))?\s*[:：]\s*release/i.test(raw);
}

// 非用户可见的噪声提交（开发过程/基础设施/文档元数据），发布说明里应过滤。
// 注意：宁可漏过、不要误杀——含用户可见改动的提交（如「PDF 字体链…；修复 CI 红灯」）
// 即使带了 CI 字眼也保留，这里只匹配纯内部性质的提交。
function isNoiseCommit(raw) {
  const s = String(raw).toLowerCase();
  const noise = [
    '实现计划', '设计文档', 'gitignore', 'rust job 的 apt',
    '发布说明改为', '中英文双语', '发布 v1.2', 'v1.2.2 发布说明', 'v1.2.2 更新说明',
    'release_notes', 'promotion', 'readme', '仓库重命名', '同步更新链接测试',
    '使用说明', '文档核对', '事实错误修正', '英文元描述', 'meta description',
    '更新面板发布说明排版', 'vendor 打包', 'worker 按统一 payload', 'dom→docx 中间结构',
    'dirlisting 实现 deref', 'index.html 接入 export-docx', 'startdragging 前 stoppropagation',
    'cargo 缓存',
  ];
  return noise.some((n) => s.includes(n));
}

// 把提交信息粗略归类到「新增 / 改进 / 修复」（先看前缀，再看归纳后文本）
function categorize(raw) {
  const s = String(raw).trim();
  if (!s) return 'improve';
  if (/^(feat|feature|feat\()/i.test(s) || /^(新增|支持|添加|增加|引入|实现)/.test(s)) return 'new';
  if (/^(fix|bugfix|hotfix|fix\()/i.test(s) || /^(修复|修正|解决)/.test(s)) return 'fix';
  const one = summarize(s);
  if (/^(修复|修正|解决)/.test(one)) return 'fix';
  if (/^(新增|支持|添加|增加|引入|实现)/.test(one)) return 'new';
  return 'improve'; // refactor / perf / test / chore / docs / 优化 / 调整 等
}

// 英文全文：由 AI 根据中文发布说明生成并写入 release/RELEASE_NOTES_en.md（即原 GitHub 英文说明）。
// 下载链接用 Gitee 域名，github-release.js 会按需改写为 GitHub 域名。
function englishSection() {
  const enPath = path.join(ROOT, 'RELEASE_NOTES_en.md');
  if (!fs.existsSync(enPath)) return [];
  const lines = fs.readFileSync(enPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

function buildNotes() {
  const tag = lastTag();
  const commits = collectCommits(tag);
  const grouped = { new: [], improve: [], fix: [] };
  const seen = new Set();
  for (const c of commits) {
    if (isInternalReleaseCommit(c)) continue; // 过滤发布/打包内部提交
    if (isNoiseCommit(c)) continue; // 过滤开发过程/基础设施/文档元数据噪声
    const cat = categorize(c);
    const one = summarize(c);
    if (one && !seen.has(one)) {
      seen.add(one);
      grouped[cat].push(one);
    }
  }

  const section = (title, items) =>
    ['### ' + title, ''].concat(items.length ? items.map((i) => '- ' + i) : ['- （无）'], ['']);

  const head = [
    '## ✨ v' + VERSION + ' 更新内容',
    '',
  ];

  const zh = downloadSection()
    .concat(head, section('新增', grouped.new), section('改进', grouped.improve), section('修复', grouped.fix), [
      '> 使用中遇到问题欢迎加 QQ 群：1035294939',
    ]);
  const en = englishSection();
  if (en.length) {
    return zh.concat(['', '---', ''], en);
  }
  return zh;
}

const notesLines = buildNotes();

// 落盘发布说明。被 release.js / github-release.js 在「打包发布」流程中调用，
// 也可在 `node scripts/release-notes.js` 直接运行时触发。
function writeNotes() {
  try {
    if (!fs.existsSync(RELEASE_DIR)) fs.mkdirSync(RELEASE_DIR, { recursive: true });
    const outFile = path.join(RELEASE_DIR, `RELEASE_NOTES_v${VERSION}.md`);
    fs.writeFileSync(outFile, notesLines.join('\n') + '\n', 'utf8');
    console.log('📝 已生成发布说明: ' + outFile);
    console.log('   版本 ' + VERSION + ' | 提交区间见上方说明头部');
    return outFile;
  } catch (e) {
    console.error('生成发布说明失败（不影响发布）: ' + e.message);
    return null;
  }
}

if (require.main === module) {
  writeNotes();
}

module.exports = { VERSION, notesLines, lastTag, collectCommits, summarize, categorize, isInternalReleaseCommit, writeNotes };
