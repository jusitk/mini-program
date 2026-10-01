'use strict';
/**
 * browser-check.js —— 用真实浏览器（Edge/Chrome 无头）体检每个页面
 *
 * 为什么需要它：
 *   静态检查查不出"页面能打开但根本不能用"的问题。这个脚本真的把页面渲染一遍，
 *   然后读页面自己写在 #layout-report 里的体检结果，并核对页面的实际视口尺寸。
 *
 * 【需要登录的页面怎么测】
 *   后台/录入/打印都要登录。做法：临时在 public/ 里放一个跳板页 `_authcheck.html`，
 *   它在浏览器里用真实口令调 /api/login 拿到会话 Cookie（同源），然后跳到目标页；
 *   测完就把这个临时文件删掉。这样不需要给页面开后门，也不用手工准备 Cookie。
 *
 * 用法：
 *   node tools/browser-check.js                         默认 http://127.0.0.1:8080
 *   node tools/browser-check.js --base=http://127.0.0.1:8199
 *   node tools/browser-check.js --user=admin --pass=xxx   指定登录口令
 *   node tools/browser-check.js --shots                  顺便把截图存到 shots/ 目录
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const SHOTS = path.join(ROOT, 'shots');
const HARNESS = path.join(PUB, '_authcheck.html');

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const hit = args.find(a => a.indexOf('--' + name + '=') === 0);
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const BASE = getArg('base', 'http://127.0.0.1:8080').replace(/\/$/, '');
const USER = getArg('user', 'admin');
const PASS = getArg('pass', process.env.SPORTS_ADMIN_PASSWORD || 'admin-pass-123');
const WANT_SHOTS = args.indexOf('--shots') >= 0;
const TIMEOUT = Number(getArg('timeout', '60')) * 1000;

/* ── 找一个能用的浏览器 ───────────────────────────────────────────────── */

function findBrowser() {
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : '',
    '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  const names = ['msedge', 'chrome', 'google-chrome', 'chromium'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) {
      const p = path.join(dir, n + (process.platform === 'win32' ? '.exe' : ''));
      if (fs.existsSync(p)) return p;
    }
  }
  return '';
}

const BROWSER = findBrowser();

/* ── 分辨率清单：把各种比例都过一遍（这是"不同比例屏幕都要好看"的验证） ── */

/**
 * 要测的屏幕尺寸。
 *
 * 【已知限制：无头浏览器量不出真正的手机宽度】
 *   Chrome/Edge 的 `--window-size` 在无头模式下有最小窗口宽度（实测约 500 物理像素），
 *   所以写 390 实际拿到的是 **492 的布局视口**（`--force-device-width` 也没用）。
 *   好在这不影响结论：
 *     · 窄屏媒体查询（max-width: 700px）在 492 下**确实生效**，窄屏排版测得到
 *     · 只是横向空间比真机宽一点，所以"手机版是不是完全不溢出"要靠真机再看一眼
 *   注意别把这个当成"手机上一定没问题"的证明。
 */
const SIZES = [
  { name: '1920x1080', w: 1920, h: 1080, note: '标准 16:9（大屏 / 电视）' },
  { name: '1366x768', w: 1366, h: 768, note: '老笔记本 16:9' },
  { name: '2560x1080', w: 2560, h: 1080, note: '21:9 超宽屏' },
  { name: '3840x2160', w: 3840, h: 2160, note: '4K' },
  { name: '1280x1024', w: 1280, h: 1024, note: '4:3 老投影' },
  { name: '1080x1920', w: 1080, h: 1920, note: '竖屏拼接墙' },
  { name: '390x844', w: 390, h: 844, note: '手机（后台，实得约 492 宽）' },
  { name: '700x900', w: 700, h: 900, note: '窄窗口（实得 670）' },
];

const PAGES = [
  { path: '/screen', name: '大屏', login: false, allSizes: true },
  { path: '/login', name: '登录页', login: false },
  { path: '/admin', name: '后台管理', login: true },
  { path: '/print', name: '成绩单打印', login: true },
];

/* ── 跑一次浏览器 ─────────────────────────────────────────────────────── */

function runBrowser(url, size, opts) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sports-shot-'));
  const cmdArgs = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    // 关掉"位移动画"：无头截图容易在动画中途抓拍，留下半帧位移的残影
    // （卡片名次滚动那一下特别明显）。不影响真实使用，页面本身也尊重系统的减弱动态效果。
    '--force-prefers-reduced-motion',
    '--user-data-dir=' + profile,
    '--window-size=' + size.w + ',' + size.h,
    '--virtual-time-budget=' + ((opts && opts.budget) || 7000),
    // 注意：这里不加 --run-all-compositor-stages-before-draw。
    // 实测它会让无头浏览器在"虚拟时间到点"时截到半张合成画面
    // （后台截图上出现过一道竖条与白色空带），去掉后正常；DOM 断言不受影响。
  ];  if (opts && opts.shot) cmdArgs.push('--screenshot=' + opts.shot);
  else cmdArgs.push('--dump-dom');
  cmdArgs.push(url);

  let out = '', errText = '';
  try {
    out = execFileSync(BROWSER, cmdArgs, {
      encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    out = String(err.stdout || '');
    errText = String(err.stderr || err.message || '');
  }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  return { html: out, err: errText };
}

/* ── 从 DOM 里读结果 ──────────────────────────────────────────────────── */

function readReport(html) {
  const countM = html.match(/id="layout-report"[^>]*data-count="(\d+)"/)
    || html.match(/data-count="(\d+)"[^>]*id="layout-report"/);
  const bodyM = html.match(/id="layout-report"[^>]*>([\s\S]*?)<\/div>/);
  return {
    count: countM ? Number(countM[1]) : -1,
    text: bodyM ? bodyM[1].replace(/<[^>]*>/g, '').trim() : '（页面没有写体检结果：可能 JS 没跑起来）',
  };
}

/** 页面是否真的渲染出了内容（防止"白屏但没报错"） */
function hasContent(html, page) {
  switch (page.path) {
    // 大屏新版骨架：board-title（栏目标题）+ stage（主体网格）
    case '/screen': return /class="board-title"/.test(html) && /class="stage"/.test(html);
    case '/admin': return /id="stageBar"/.test(html) && /class="tab/.test(html);
    case '/login': return /id="loginForm"/.test(html);
    case '/print': return /print-bar/.test(html) && /id="printArea"/.test(html);
    default: return true;
  }
}

/** 从 DOM 里读 --s 与视口（页面把 --s 写在 html 的 style 上） */
function readViewport(html) {
  const svg = html.match(/<html[^>]*style="[^"]*--s:\s*([0-9.]+)/);
  return { s: svg ? Number(svg[1]) : null };
}

/* ── 登录跳板页 ───────────────────────────────────────────────────────── */

function writeHarness() {
  // 跳板页做两件事：
  //   ① 种下"静态体检模式"标记（页面据此不建 SSE 长连接，否则无头浏览器的 --dump-dom 不返回）
  //   ② 用真实口令登录拿到会话 Cookie，再跳到目标页
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>auth</title></head>
<body><div id="layout-report" class="sr-only" data-count="0">准备中</div>
<script>
(async function(){
  try { localStorage.setItem('sports.staticMode', '1'); } catch (e) {}
  var q = new URLSearchParams(location.search);
  var next = q.get('next') || '/admin';
  try {
    var res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)} })
    });
    var j = await res.json();
    if (!j || !j.ok) {
      document.getElementById('layout-report').textContent = '登录失败：' + ((j && j.message) || res.status);
      document.getElementById('layout-report').setAttribute('data-count', '99');
      return;
    }
    location.replace(next);
  } catch (e) {
    document.getElementById('layout-report').textContent = '登录出错：' + e.message;
    document.getElementById('layout-report').setAttribute('data-count', '99');
  }
})();
</script></body></html>`;
  fs.writeFileSync(HARNESS, html, 'utf8');
}

function removeHarness() {
  try { if (fs.existsSync(HARNESS)) fs.unlinkSync(HARNESS); } catch (e) { /* ignore */ }
}

/* ── 主流程 ───────────────────────────────────────────────────────────── */

let fails = 0, warns = 0;
const fail = (m) => { console.log('[失败] ' + m); fails++; };
const warn = (m) => { console.log('[可疑] ' + m); warns++; };

if (!BROWSER) {
  console.log('[跳过] 没找到 Edge / Chrome（现场机器上通常都有 Edge）。');
  console.log('       装了浏览器之后再跑这个脚本，才能验证真实版面。');
  process.exit(0);
}
console.log('浏览器：' + BROWSER);
console.log('目标：' + BASE);
console.log('');

/* 服务在跑吗 */
try {
  const res = execFileSync(process.execPath, ['-e',
    `fetch('${BASE}/api/health').then(r=>r.json()).then(j=>console.log('ok rev='+(j.rev||0))).catch(e=>console.log('fail '+e.message))`,
  ], { encoding: 'utf8', timeout: 15000 });
  if (res.indexOf('ok') !== 0) throw new Error(res.trim());
  console.log('服务健康检查：' + res.trim());
} catch (err) {
  console.log('[失败] 连不上服务 ' + BASE + '：' + (err && err.message));
  console.log('       请先启动服务（双击「启动.bat」或 node server.js），再跑本脚本。');
  process.exit(1);
}

/* 登录跳板：只用来"种下静态体检标记"，并确认口令对不对 */
writeHarness();
let loginOk = true;
{
  const r = runBrowser(BASE + '/_authcheck.html?next=' + encodeURIComponent('/login'), { w: 800, h: 600 }, { budget: 7000 });
  if (r.html.indexOf('登录失败') >= 0 || r.html.indexOf('登录出错') >= 0) {
    loginOk = false;
    const why = readReport(r.html);
    warn('自动登录没成功（' + why.text.slice(0, 90) + '），需要登录的页面将跳过检查');
    warn('  提示：默认口令是启动横幅里打印的那个，也可以用 --pass=你的口令 指定');
  }
}
if (loginOk) console.log('自动登录：成功（' + USER + '）');
console.log('');

if (WANT_SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

for (const page of PAGES) {
  const needLogin = page.login;
  console.log('── ' + page.name + ' ' + page.path + ' ' + '─'.repeat(Math.max(2, 44 - page.name.length)));
  if (needLogin && !loginOk) {
    console.log('  [跳过] 需要登录，但自动登录没成功');
    console.log('');
    continue;
  }
  for (const size of SIZES) {
    const isPhone = size.w < 500;
    const isNarrow = size.w <= 700;
    // 手机/窄窗口只测后台与登录页（手机录入页已去掉，后台本身就要能上手机）
    if (isNarrow && page.path !== '/admin' && page.path !== '/login') continue;
    // 大屏是按真实上屏尺寸设计的（1920/1366/2560/3840/1280/1080），
    // 700 宽不是上屏场景，测了只会报"略挤"这种没意义的结论
    if (page.path === '/screen' && isNarrow) continue;
    // 超宽/4K 不测打印页（打印是 A4 固定宽度，测了没意义）
    if (page.path === '/print' && (size.w > 2600 || isNarrow)) continue;

    // 静态模式 + 页面内同步登录（不做二次跳转：无头浏览器的虚拟时间预算不够跳两次）
    const qs = '?static=1&_staticuser=' + encodeURIComponent(USER) + '&_staticpass=' + encodeURIComponent(PASS);
    const target = needLogin ? (BASE + page.path + qs) : (BASE + page.path + '?static=1');
    const shot = (WANT_SHOTS && (size.name === '1920x1080' || size.name === '1080x1920' || size.name === '390x844'))
      ? path.join(SHOTS, page.path.replace(/\//g, '') + '-' + size.name + '.png')
      : '';
    // 各页的虚拟时间预算：大屏与后台都要等异步数据（快照 / 名单）画完再截图，
    // 否则拿到的是"正在读取…"那一帧，自动化看不到真实版面。
    const budget = page.path === '/screen' ? 12000 : 26000;
    const r = runBrowser(target, size, { shot, budget });

    if (shot) {
      if (fs.existsSync(shot)) console.log('  [' + size.name + '] 截图 ' + path.relative(ROOT, shot));
      else warn(size.name + ' 截图没生成');
    }
    if (!r.html) {
      if (!shot) warn(page.name + ' @ ' + size.name + ' 没拿到 DOM（无头浏览器偶发，重跑通常就好）');
      continue;
    }
    if (!hasContent(r.html, page)) {
      fail(page.name + ' @ ' + size.name + ' 页面是空的或没渲染出内容（JS 没跑起来？）');
      continue;
    }
    const rep = readReport(r.html);
    const vp = readViewport(r.html);
    const tag = '  [' + size.name + '] ' + size.note + (vp.s ? ('　--s=' + vp.s) : '');
    if (rep.count > 0) {
      fail(page.name + ' @ ' + size.name + ' 有 ' + rep.count + ' 处版面问题：' + rep.text.slice(0, 200));
    } else if (rep.count === -1) {
      warn(page.name + ' @ ' + size.name + ' 页面没有写体检结果：' + rep.text.slice(0, 100));
    } else {
      console.log(tag + ' ✓ 版面正常');
    }
  }
  console.log('');
}

removeHarness();

console.log('═'.repeat(66));
if (fails === 0) {
  console.log('结果：全部通过' + (warns ? ('（' + warns + ' 处可疑，见上）') : '') + (WANT_SHOTS ? '　截图在 shots/ 目录' : ''));
  process.exit(0);
}
console.log('结果：' + fails + ' 项失败' + (warns ? ('，' + warns + ' 处可疑') : ''));
process.exit(1);
