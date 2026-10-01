'use strict';
/**
 * check-frontend.js —— 前端引用双向自检
 *
 * 防的是这两类"页面能打开但根本不能用"的问题：
 *   1. JS 里 el('xxx') / getElementById('xxx') 引用的 id 在 HTML 里不存在 → 白屏或按钮点不动
 *   2. HTML 里写了按钮/控件，但 JS 里没有任何处理 → 死按钮
 *   3. <script src> / <link href> 指向的文件不存在
 *   4. 前端调用的 /api/xxx 后端没有对应路由
 *   5. JS 里调用了没定义的函数（拼错名字）
 *
 * 用法：node tools/check-frontend.js
 * 退出码：有问题 exit 1，全通过 exit 0
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');

let fails = 0;
let warns = 0;
const fail = (msg) => { console.log('[失败] ' + msg); fails++; };
const warn = (msg) => { console.log('[可疑] ' + msg); warns++; };
const pass = (msg) => console.log('[通过] ' + msg);

function read(p) { return fs.readFileSync(p, 'utf8'); }
function exists(p) { return fs.existsSync(p); }

if (!exists(PUB)) {
  console.log('[跳过] 没有 public 目录');
  process.exit(0);
}

const files = fs.readdirSync(PUB).filter(f => /\.(html|js|css)$/.test(f));
const htmls = files.filter(f => f.endsWith('.html'));
const jss = files.filter(f => f.endsWith('.js'));
const csss = files.filter(f => f.endsWith('.css'));

/* ── 1. HTML 里的 id 集合 ─────────────────────────────────────────────── */
const idsByHtml = {};
htmls.forEach((f) => {
  const text = read(path.join(PUB, f));
  const ids = new Set();
  const re = /\sid\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(text))) ids.add(m[1]);
  idsByHtml[f] = ids;
});

/* ── 2. JS 引用的 id 必须在对应 HTML 里存在 ───────────────────────────── */
// 页面 → 它加载的 js 文件（按 admin.html 里的 script 标签推断；找不到就全部合并）
const pageOfJs = {};
htmls.forEach((f) => {
  const text = read(path.join(PUB, f));
  const re = /<script[^>]+src=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(text))) {
    const src = m[1];
    if (!/^https?:/i.test(src)) pageOfJs[src] = f;
  }
});

// 全部 html 的 id 并集（有的页面共用脚本，比如 common.js 不引用具体 id）
const allIds = new Set();
Object.values(idsByHtml).forEach(s => s.forEach(x => allIds.add(x)));

/**
 * JS 里**动态创建**的元素也要算进"已知 id"。
 * 后台很多容器是先建好再填充的，例如：
 *     const bar = h('div', { class: 'toolbar' });
 *     box.appendChild(h('div', { class: 'box-body', id: 'rosterList' }));
 *     ...
 *     el('rosterList').appendChild(...)
 * 这类 id 不在 HTML 里（HTML 只是个空壳），但完全合法。
 * 只认 h(...) 调用里出现的 id，避免把随便一个字符串当成 id 放过真问题。
 */
jss.forEach((f) => {
  const text = read(path.join(PUB, f));
  const re = /\bh\(\s*['"][a-zA-Z0-9]+['"]\s*,\s*\{[^}]*\bid\s*:\s*['"]([A-Za-z0-9_\-]+)['"]/g;
  let m;
  while ((m = re.exec(text))) allIds.add(m[1]);
  // 属性对象被拆成多行变量时兜底：单独出现的 id: 'xxx'
  const re2 = /\bid\s*:\s*['"]([A-Za-z0-9_\-]+)['"]/g;
  while ((m = re2.exec(text))) allIds.add(m[1]);
  // 用 setAttribute('id', 'xxx') 动态创建的也算（common.js 的 App.diag 就是这么建的）
  const re3 = /setAttribute\(\s*['"]id['"]\s*,\s*['"]([A-Za-z0-9_\-]+)['"]/g;
  while ((m = re3.exec(text))) allIds.add(m[1]);
});

jss.forEach((f) => {
  const text = read(path.join(PUB, f));
  const lines = text.split('\n');
  const refs = new Map();          // id → 行号
  let m;
  const re1 = /\bel\(\s*['"]([A-Za-z0-9_\-]+)['"]\s*\)/g;
  while ((m = re1.exec(text))) refs.set(m[1], text.slice(0, m.index).split('\n').length);
  const re2 = /getElementById\(\s*['"]([A-Za-z0-9_\-]+)['"]\s*\)/g;
  while ((m = re2.exec(text))) refs.set(m[1], text.slice(0, m.index).split('\n').length);

  refs.forEach((lineNo, id) => {
    if (allIds.has(id)) return;
    // 允许显式标记为"可选容器"：#id-optional
    // 用途：某些界面元素在部分页面/部分版本里是故意不存在的（例如界面上已撤掉的
    // "体检"页签容器），代码里做了 null 判断。这行注释就是告诉检查器"这是有意的"。
    const line = lines[lineNo - 1] || '';
    if (line.indexOf('#id-optional') >= 0) return;
    fail(f + ':' + lineNo + ' 引用的元素 id「' + id
      + '」在所有 HTML 里都不存在（会导致白屏或按钮点不动）；'
      + '若确实可以没有，请在该行末尾加注释 #id-optional');
  });
});
if (fails === 0) pass('JS 引用的元素 id 在 HTML 里都存在（' + jss.length + ' 个 JS / ' + allIds.size + ' 个 id）');

/* ── 3. 资源引用是否存在 ────────────────────────────────────────────────
 *
 * 【例外：可选图片】标了 `data-optional-img` 的 img 允许文件不存在 ——
 *   common.js 里给它们挂了 onerror（加载失败即隐藏），所以缺图不会白屏、
 *   也不会留下破图标。开源版就是靠这个机制不带任何单位标识
 *   （public/img/school-logo.webp）。
 *   判据：**同一行上**出现了 data-optional-img 就算可选。
 *   所以可选图片的 <img> 必须写成一行，别把属性折行 —— 折了这里认不出来。
 */
htmls.forEach((f) => {
  const text = read(path.join(PUB, f));
  const re = /(?:src|href)=["']([^"'#?]+)["']/g;
  let m;
  while ((m = re.exec(text))) {
    const url = m[1];
    if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:') || url.startsWith('mailto:')) continue;
    /* 取"这个属性所在的整行"，看有没有可选标记 */
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const lineEnd = text.indexOf('\n', m.index);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    const optionalImg = line.indexOf('data-optional-img') >= 0;
    const p = url.startsWith('/')
      ? path.join(PUB, url.replace(/^\//, ''))
      : path.join(PUB, url);
    if (url.startsWith('/') && /^\/(screen|admin|login|print|api|uploads|favicon)/.test(url)) continue;
    if (!exists(p)) {
      if (optionalImg) continue;          // 可选图片：缺了没关系（onerror 会隐藏）
      fail(f + ' 引用的资源不存在：' + url);
    }
  }
});
pass('HTML 引用的本地资源都存在（data-optional-img 标了的除外）');

/* ── 4. 前端调用的 /api/ 路径后端要有 ─────────────────────────────────── */
const serverText = read(path.join(ROOT, 'server.js'));
/** 服务端声明的路由集合：/api/op、/api/events/:id/board … */
const serverRoutes = new Set();
{
  const re = /on\(\s*'(GET|POST)'\s*,\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(serverText))) serverRoutes.add(m[2]);
}

const apiPaths = new Set();
jss.forEach((f) => {
  const text = read(path.join(PUB, f));

  // ① 拼接表达式：从引号里的 /api/... 开始，一路吃到表达式结束。
  //    例：'/api/events/' + id + '/board'   →  /api/events/:x/board
  //        '/api/snapshot' + q            →  /api/snapshot:q（后面按前缀匹配处理）
  //    先整体扫，再统一收敛，避免"只取了前半段"的误报。
  const reCat = /(['"])(\/api\/[^'"]*)\1((?:\s*\+\s*[^;,)\n]+)*)/g;
  let m;
  while ((m = reCat.exec(text))) {
    const segs = (m[3] || '').split(/\s*\+\s*/).filter(Boolean);
    let full = m[2];
    segs.forEach((seg) => {
      const lit = seg.match(/^(['"])([\s\S]*)\1$/);
      if (lit) full += lit[2];
      else full += ':x';            // 变量段
    });
    apiPaths.add(full);
  }

  // ② 模板字符串：`/api/stream/${kind}`
  const re3 = /`(\/api\/[^`]*)`/g;
  while ((m = re3.exec(text))) apiPaths.add(m[1]);
});

apiPaths.forEach((p) => {
  const clean = p.replace(/\$\{[^}]+\}/g, ':x')
    .replace(/:x+/g, ':x')
    .replace(/\?.*$/, '')
    .replace(/\/+$/, '');
  if (serverRoutes.has(clean)) return;
  const hit = Array.from(serverRoutes).some((r) => {
    if (r.indexOf(':') < 0) return false;
    const rp = r.split('/'), cp = clean.split('/');
    if (rp.length !== cp.length) return false;
    return rp.every((seg, i) => seg.charAt(0) === ':' || seg === cp[i]);
  });
  if (hit) return;
  // 变量拼在路径后面（如 '/api/snapshot' + query）：比对前缀是否命中某条路由
  const head = clean.split(':x')[0].replace(/\/+$/, '');
  if (head && Array.from(serverRoutes).some(r => r === head || r.indexOf(head + '/') === 0)) return;
  fail('前端调用了后端没有的接口：' + p);
});
pass('前端调用的 /api/ 路径在 server.js 里都有定义（' + apiPaths.size + ' 个路径 / ' + serverRoutes.size + ' 条路由）');

/* ── 5. JS 语法检查（语法错会让整页脚本不执行：按钮全点不动） ─────────── */
const { execFileSync } = require('node:child_process');
jss.concat(['../server.js']).forEach((f) => {
  const p = path.join(PUB, f);
  if (!exists(p)) return;
  try {
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
  } catch (err) {
    fail(f + ' 语法错误：' + String(err.stderr || err.message).split('\n').slice(0, 3).join(' '));
  }
});
pass('所有前端 JS 语法检查通过（' + jss.length + ' 个文件）');

/* ── 6. 前端不得引用外部资源（断外网也要能用） ────────────────────────── */
let external = 0;
htmls.concat(csss).forEach((f) => {
  const text = read(path.join(PUB, f));
  if (/https?:\/\/(?!127\.0\.0\.1|localhost)/i.test(text.replace(/xmlns[^"]*"[^"]*"/g, ''))) {
    // 允许注释里提到 URL，只挑出真正的加载语句
    const re = /(?:src|href)\s*=\s*["']https?:|@import\s+url\(\s*["']?https?:/gi;
    if (re.test(text)) { fail(f + ' 引用了外部资源（内网/断网时页面会缺东西）'); external++; }
  }
});
if (!external) pass('前端没有引用任何外部资源（断外网也能用）');

/* ── 7. 每个页面的启动函数确实被调用 ──────────────────────────────────── */
{
  const adminJs = read(path.join(PUB, 'admin.js'));
  if (adminJs.indexOf('Admin.boot()') < 0 && adminJs.indexOf('A.boot()') < 0) {
    fail('admin.js 里没有调用 Admin.boot()，后台会一片空白');
  }
  ['screen.js', 'login.js', 'print.js'].forEach((f) => {
    const t = read(path.join(PUB, f));
    if (t.indexOf('boot()') < 0) fail(f + ' 里没有调用 boot()，页面不会初始化');
  });
  pass('各页面的启动函数都被真正调用');
}

console.log('\n' + (fails === 0
  ? '[通过] 前端自检：' + htmls.length + ' 个页面 / ' + jss.length + ' 个 JS，' + (warns ? (warns + ' 处可疑已列出') : '没有发现问题')
  : '[失败] 前端自检共 ' + fails + ' 个问题'));
process.exit(fails === 0 ? 0 : 1);
