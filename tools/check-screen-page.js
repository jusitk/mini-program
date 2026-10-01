'use strict';
/**
 * check-screen-page.js —— 验收大屏翻页：各栏真的会按节奏翻页吗
 *
 * 【为什么要有这个工具】"某栏长时间不翻页"眼睛看不出来是"卡住了"还是"本来就只有一页"。
 *   大屏有卡片内滚动、栏目翻页两层定时器，还叠加"滚完才翻页"的约束，
 *   光看代码没法确认 —— 必须真的让浏览器跑一段时间，读它的实际页码。
 *
 * 【怎么做的】启动一个真实 Edge（无头），用 Chrome DevTools Protocol 连上去，
 *   隔一段时间读大屏自己写在 `#diagPage` 里的诊断：
 *     每栏 第几页/共几页、下次翻页还有几秒、在等哪张卡滚完
 *   然后断言：**页数 > 1 的栏目，观察期内必须翻过页**。
 *
 * Node 22 自带 WebSocket（全局），所以不需要装任何依赖。
 *
 * 用法：
 *   node tools/check-screen-page.js --url=http://127.0.0.1:8080 --seconds=40
 * 退出码 0 = 该翻的都翻了；1 = 有栏目一直没动。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const a = args.find(x => x.indexOf('--' + k + '=') === 0);
  return a ? a.split('=').slice(1).join('=') : d;
};
const URL_ = getArg('url', 'http://127.0.0.1:8080');
const SECONDS = Number(getArg('seconds', '40'));
const PORT = 9222 + Math.floor(Math.random() * 300);
const W = Number(getArg('w', '1920'));
const H = Number(getArg('h', '1080'));

function findBrowser() {
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

/* Node 自带的 WebSocket（22 起是全局的）；没有就明确报错，别装作能跑 */
if (typeof WebSocket === 'undefined') {
  console.error('这个 Node 没有全局 WebSocket（需要 Node 22+），无法连浏览器');
  process.exit(2);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const exe = findBrowser();
  if (!exe) { console.error('找不到 Edge / Chrome'); process.exit(2); }

  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'scr-'));
  const child = spawn(exe, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--window-size=' + W + ',' + H,
    'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  const cleanup = () => {
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    try { child.kill(); } catch (e) { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  };
  process.on('exit', cleanup);

  /* 等 CDP 端口起来 */
  let info = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      if (r.ok) { info = await r.json(); break; }
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  if (!info) { console.error('浏览器没起来（CDP 端口连不上）'); cleanup(); process.exit(2); }

  /* 新建一个标签页，开到目标地址 */
  const nt = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(URL_ + '/screen'),
    { method: 'PUT' })).json().catch(() => null);
  const target = nt && nt.webSocketDebuggerUrl ? nt : null;
  if (!target) { console.error('打不开标签页'); cleanup(); process.exit(2); }

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    let m = null;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
    if (r && r.result && r.result.result) return r.result.result.value;
    return null;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  console.log('');
  console.log('  目标 ' + URL_ + '/screen　视口 ' + W + '×' + H + '　观察 ' + SECONDS + ' 秒');
  console.log('');

  /* 等页面把诊断写出来（说明 JS 跑起来了、快照也到了） */
  let ready = false;
  for (let i = 0; i < 80; i++) {
    const t = await evaluate("(document.getElementById('diagPage')||{}).textContent || ''");
    if (t && t.length > 2) { ready = true; break; }
    await sleep(250);
  }
  if (!ready) { console.error('页面没写出翻页诊断（JS 没跑起来？快照没到手？）'); cleanup(); process.exit(1); }

  const snap = async () => {
    const t = await evaluate("(document.getElementById('diagPage')||{}).textContent || ''");
    try { return JSON.parse(t); } catch (e) { return null; }
  };

  const first = await snap();
  const startPage = {};
  (first.panels || []).forEach(p => { startPage[p.k] = p.page; });

  console.log('  起始状态：');
  (first.panels || []).forEach(p => {
    console.log('    ' + p.k.padEnd(12) + ' 第 ' + p.page + '/' + p.pages + ' 页'
      + '　卡片滚动 ' + p.scrollers + ' 个'
      + '　下次翻页 ' + (p.dueIn === null ? '—' : p.dueIn + 's')
      + '　等滚动 ' + (p.holdIn === null ? '—' : p.holdIn + 's'));
  });
  console.log('');

  /* 观察期内不断采样，记录每栏到过的页码 */
  const seen = {};
  const t0 = Date.now();
  while (Date.now() - t0 < SECONDS * 1000) {
    const s = await snap();
    if (s) {
      (s.panels || []).forEach((p) => {
        if (!seen[p.k]) seen[p.k] = new Set();
        seen[p.k].add(p.page);
        if (!startPage[p.k + '_pages']) startPage[p.k + '_pages'] = p.pages;
        startPage[p.k + '_pages'] = p.pages;
      });
    }
    await sleep(1000);
  }

  console.log('  观察 ' + SECONDS + ' 秒后：');
  let bad = 0;
  (first.panels || []).forEach((p0) => {
    const k = p0.k;
    const pages = startPage[k + '_pages'] || p0.pages;
    const seenN = seen[k] ? seen[k].size : 0;
    const moved = seenN > 1;
    const shouldMove = pages > 1;
    const okk = shouldMove ? moved : true;
    if (!okk) bad++;
    console.log('    ' + k.padEnd(12) + ' 共 ' + pages + ' 页　到过 ' + seenN + ' 个页码　'
      + (shouldMove
        ? (moved ? '✔ 翻了' : '✘ 一直没翻（应当翻）')
        : '（只有一页，不用翻）'));
  });
  console.log('');

  const last = await snap();
  if (last) {
    console.log('  结束状态：');
    (last.panels || []).forEach(p => {
      console.log('    ' + p.k.padEnd(12) + ' 第 ' + p.page + '/' + p.pages + ' 页'
        + '　下次翻页 ' + (p.dueIn === null ? '—' : p.dueIn + 's')
        + '　等滚动 ' + (p.holdIn === null ? '—' : p.holdIn + 's'));
    });
  }
  console.log('');
  console.log(bad ? ('  ✘ 有 ' + bad + ' 个栏目该翻没翻') : '  ✔ 该翻的都翻了');
  console.log('');

  cleanup();
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('  探针出错：' + (e && e.stack || e));
  process.exit(2);
});
