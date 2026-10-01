'use strict';
/**
 * check-add-forms.js —— 验收"添加项目 / 添加运动员"两个弹窗**真的能用**
 *
 * 【为什么要有这个工具】后端接口有 70 多条断言罩着，但**弹窗本身没人测**：
 *   字段少一个、下拉是空的、"加入"按钮点了没反应、服务端拒绝后弹窗关掉把
 *   已填内容弄丢 —— 这些接口测试全都看不见。必须真的开浏览器填一遍。
 *
 * 【怎么做的】起一个无头 Edge，用 CDP（Node 22 自带 WebSocket，零依赖）：
 *   登录 → 进「名单」页 → 点「加一名运动员」→ 填表 → 点「加入」→ 看结果
 *   同样再走一遍「赛程」页的「新增项目」。
 *
 * 用法：
 *   node tools/check-add-forms.js --url=http://127.0.0.1:8080 --pass=admin123
 * 退出码 0 = 两个弹窗都能用。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const a = args.find(x => x.indexOf('--' + k + '=') === 0);
  return a ? a.split('=').slice(1).join('=') : d;
};
const BASE = getArg('url', 'http://127.0.0.1:8080');
const USER = getArg('user', 'admin');
const PASS = getArg('pass', 'admin123');
const PORT = 9500 + Math.floor(Math.random() * 300);

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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
if (typeof WebSocket === 'undefined') { console.error('需要 Node 22+（自带 WebSocket）'); process.exit(2); }

let pass = 0, fail = 0;
const ck = (cond, label, extra) => {
  if (cond) { pass++; console.log('    ✓ ' + label); }
  else { fail++; console.log('    ✗ ' + label + (extra === undefined ? '' : ('　→ ' + JSON.stringify(extra)))); }
};

(async () => {
  const exe = findBrowser();
  if (!exe) { console.error('找不到 Edge / Chrome'); process.exit(2); }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'frm-'));
  const child = spawn(exe, [
    '--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--window-size=1920,1080', 'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  const cleanup = () => {
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    try { child.kill(); } catch (e) { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  };
  process.on('exit', cleanup);

  let info = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      if (r.ok) { info = await r.json(); break; }
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  if (!info) { console.error('浏览器没起来'); cleanup(); process.exit(2); }

  const nt = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(BASE + '/admin'),
    { method: 'PUT' })).json().catch(() => null);
  if (!nt || !nt.webSocketDebuggerUrl) { console.error('打不开标签页'); cleanup(); process.exit(2); }
  ws = new WebSocket(nt.webSocketDebuggerUrl);
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
  const ev = async (expr, awaitPromise) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: !!awaitPromise,
    });
    if (r && r.result && r.result.exceptionDetails) {
      return { __err: (r.result.exceptionDetails.exception || {}).description || 'JS 抛错' };
    }
    return r && r.result && r.result.result ? r.result.result.value : null;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  console.log('');
  console.log('  目标 ' + BASE + '/admin');
  console.log('');

  /* ── 登录 ── */
  let logged = false;
  for (let i = 0; i < 60; i++) {
    const atLogin = await ev("!!document.querySelector('input[type=password]') || location.pathname.indexOf('login')>=0");
    if (atLogin) {
      await ev(`(function(){
        var f = document.querySelector('form') || document.body;
        var u = f.querySelector('input[type=text],input[name=username],input:not([type])');
        var p = f.querySelector('input[type=password]');
        if (u) u.value = ${JSON.stringify(USER)};
        if (p) p.value = ${JSON.stringify(PASS)};
        var b = f.querySelector('button[type=submit],button');
        if (b) b.click(); else if (f.requestSubmit) f.requestSubmit();
        return 'submitted';
      })()`);
    }
    await sleep(500);
    const onAdmin = await ev("!document.querySelector('input[type=password]') && !!document.querySelector('[data-tab]')");
    if (onAdmin) { logged = true; break; }
  }
  ck(logged, '能登录进后台');
  if (!logged) { cleanup(); process.exit(1); }

  /* 等界面把数据拉回来。
     ⚠ 不要检查 `window.App.S` —— admin-core 里 S 是 IIFE 内的局部变量，
       根本没挂到 App 上（我第一次这么写，拿到 TypeError）。
     也不要在切页签**之前**去数下拉 —— 那时名单页还没渲染，当然是 0 个。 */
  await ev("(function(){var b=[].find.call(document.querySelectorAll('[data-tab]'),function(x){return x.dataset.tab==='roster'});if(b)b.click();return 1})()");
  await sleep(2000);
  const groupsSeen = await ev(`(function(){
    var sels = [].slice.call(document.querySelectorAll('#paneRoster select, .pane select, select'));
    var best = 0, names = [];
    sels.forEach(function(s){
      var opts = [].slice.call(s.options).map(function(o){return o.textContent;});
      if (opts.length > best) { best = opts.length; names = opts; }
    });
    return {n: best, names: names.slice(0, 8)};
  })()`);
  console.log('      界面上最多的一个下拉：' + JSON.stringify(groupsSeen && groupsSeen.names));
  ck(groupsSeen && groupsSeen.n > 0, '界面渲染出了下拉（' + (groupsSeen ? groupsSeen.n : 0) + ' 个选项）');

  /* ── 一、添加运动员弹窗 ── */
  console.log('  ① 「名单」页 →「加一名运动员」');
  await sleep(600);

  const opened = await ev(`(function(){
    var btns = [].slice.call(document.querySelectorAll('#paneRoster button, .pane button'));
    var b = btns.filter(function(x){return (x.textContent||'').indexOf('加一名运动员')>=0;})[0];
    if (!b) return {err:'找不到「加一名运动员」按钮', n:btns.length};
    b.click();
    return {ok:true};
  })()`);
  ck(opened && opened.ok, '点得到「加一名运动员」', opened);
  await sleep(600);

  const form = await ev(`(function(){
    var m = document.getElementById('askModal');
    if (!m || m.hidden) return {err:'弹窗没打开'};
    var f = document.getElementById('askField');
    var labels = [].slice.call(f.querySelectorAll('.label')).map(function(x){return x.textContent;});
    var inputs = f.querySelectorAll('input').length;
    var selects = f.querySelectorAll('select').length;
    var gradeSel = f.querySelector('select');
    return {
      title: document.getElementById('askTitle').textContent,
      okText: document.getElementById('askOk').textContent,
      labels: labels,
      inputs: inputs, selects: selects,
      gradeOptions: gradeSel ? [].slice.call(gradeSel.options).map(function(o){return o.value;}) : [],
    };
  })()`);
  console.log('      弹窗标题：' + (form && form.title));
  console.log('      字段：' + JSON.stringify(form && form.labels));
  console.log('      年级下拉选项：' + JSON.stringify(form && form.gradeOptions));
  ck(form && /加一名运动员/.test(form.title), '弹窗标题对');
  ck(form && form.labels.indexOf('姓名') >= 0, '有「姓名」');
  ck(form && form.labels.indexOf('年级') >= 0, '★ 有「年级」（组别由它推）');
  ck(form && form.labels.indexOf('性别') >= 0, '有「性别」');
  ck(form && form.labels.indexOf('归入组别') >= 0, '★ 有「归入组别」提示行');
  ck(form && form.labels.indexOf('组别') < 0, '★ 没有独立的「组别」下拉了（免得选错）');
  ck(form && form.gradeOptions.length > 0, '年级下拉有选项（' + (form ? form.gradeOptions.length : 0) + ' 个）');

  /* 年级下拉**默认就有值**（第一个选项），所以"不填年级"这个状态其实不存在 ——
     这正是设计意图（错的组合根本选不出来）。
     我第一次的断言写的是"不填年级要拦住"，结果必然失败：不是代码错，是断言不懂设计。
     这里改成测**真正会发生的错**：把年级切到「（其它年级…）」再手填一个认不出的。 */
  const NAME = '前端探针' + Date.now().toString().slice(-5);
  const wrongTry = await ev(`(function(){
    var f = document.getElementById('askField');
    var inputs = [].slice.call(f.querySelectorAll('input'));
    inputs[0].value = ${JSON.stringify(NAME)};
    var gradeSel = f.querySelector('select');
    var custom = [].slice.call(gradeSel.options).filter(function(o){return o.value==='__custom__';})[0];
    if (!custom) return {skip:true};
    gradeSel.value = '__custom__';
    gradeSel.dispatchEvent(new Event('change', {bubbles:true}));
    // 手填一个认不出的年级
    var free = inputs.filter(function(x){return x.placeholder && x.placeholder.indexOf('年级')>=0;})[0];
    if (!free) return {skip:true};
    free.value = '五年级';
    free.dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('askOk').click();
    return {ok:true, hint: (f.querySelector('.hint')||{}).textContent};
  })()`);
  await sleep(800);
  const wrongRes = await ev(`(function(){
    var m = document.getElementById('askModal');
    var f = document.getElementById('askField');
    var err = [].slice.call(f.querySelectorAll('.ask-text')).map(function(x){return x.textContent;}).filter(Boolean);
    var hints = [].slice.call(f.querySelectorAll('.hint')).map(function(x){return x.textContent;});
    return {stillOpen: !m.hidden, err: err, hints: hints};
  })()`);
  if (wrongTry && wrongTry.skip) {
    console.log('      （这个弹窗没有"其它年级"入口，跳过认不出年级的用例）');
  } else {
    ck(wrongRes && wrongRes.stillOpen, '★ 年级填成认不出的「五年级」时弹窗不关', wrongRes);
    ck(wrongRes && wrongRes.err.length > 0 && /年级|组别/.test(wrongRes.err.join('')),
      '★ 给出了明确原因：' + JSON.stringify(wrongRes && wrongRes.err));
    ck(wrongRes && wrongRes.hints.some(x => /认不出/.test(String(x))),
      '★ 提示行当场变红说"认不出"：' + JSON.stringify((wrongRes && wrongRes.hints || []).slice(-1)));
  }

  /* 正经填一遍 */
  const filled = await ev(`(function(){
    var f = document.getElementById('askField');
    var inputs = [].slice.call(f.querySelectorAll('input'));
    var sels = [].slice.call(f.querySelectorAll('select'));
    inputs[0].value = ${JSON.stringify(NAME)};
    var gradeSel = sels[0], genderSel = sels[1];
    var grade = gradeSel.options[0] ? gradeSel.options[0].value : '';
    gradeSel.value = grade;
    gradeSel.dispatchEvent(new Event('change', {bubbles:true}));
    if (genderSel) { genderSel.value = '男'; genderSel.dispatchEvent(new Event('change', {bubbles:true})); }
    // 班级与号码：按标签找
    var labels = [].slice.call(f.querySelectorAll('.label'));
    function inputAfter(t){
      for (var i=0;i<labels.length;i++){
        if (labels[i].textContent.indexOf(t)>=0) {
          var box = labels[i].parentElement;
          var inp = box.querySelector('input');
          if (inp) return inp;
        }
      }
      return null;
    }
    var ci = inputAfter('班级'); if (ci) ci.value = '探针班';
    var bi = inputAfter('号码'); if (bi) bi.value = 'PB' + Date.now().toString().slice(-6);
    var hint = [].slice.call(f.querySelectorAll('.hint')).map(function(x){return x.textContent;}).join(' | ');
    return {grade: grade, hint: hint, nInputs: inputs.length};
  })()`);
  console.log('      联动提示：' + JSON.stringify(filled && filled.hint));
  ck(filled && /将归入/.test(String(filled.hint)),
    '★ 选完年级实时说"将归入「…」"（说明下拉里的年级能推出组别）', filled && filled.hint);

  await ev("document.getElementById('askOk').click(); 1");
  await sleep(2500);
  const after = await ev(`(function(){
    var m = document.getElementById('askModal');
    var wrap = document.getElementById('toastWrap');
    var toasts = wrap ? [].slice.call(wrap.querySelectorAll('.toast')).map(function(x){return x.textContent;}) : [];
    var f = document.getElementById('askField');
    var err = [].slice.call(f.querySelectorAll('.ask-text')).map(function(x){return x.textContent;}).filter(Boolean);
    return {modalClosed: !!m.hidden, toasts: toasts, err: err};
  })()`);
  console.log('      toast：' + JSON.stringify(after && after.toasts));
  ck(after && after.modalClosed, '★ 填对了才关弹窗');
  ck(after && (!after.err || !after.err.length), '没有残留报错', after && after.err);
  ck(after && after.toasts && after.toasts.length > 0, '★ 给出了反馈（toast）');

  /* 库里现在**还查不到** —— 人只是进了暂存区（要确认才生效）。
     这里只打印不判定，真正的"进库了没有"放在确认之后再断言。
     （我第一版就是在这儿断言"人真的进库了"，必然失败：那是设计如此。
       修的时候又忘了删这块，于是同一句话断言了两次、一直红两条。） */
  const preSave2 = await ev(`(function(){
    return fetch('/api/roster?search=' + encodeURIComponent(${JSON.stringify(NAME)}) + '&limit=5',
      {credentials:'same-origin'}).then(function(r){return r.json()})
      .then(function(j){ var d=j.data||j; return (d.athletes||d.rows||[]).length; });
  })()`, true);
  console.log('      这一步查库：' + preSave2 + ' 条（应当是 0 —— 还没确认）');
  ck(preSave2 === 0, '★ 确认之前库里查不到（改动确实只在暂存区，没提前生效）');

  /* ── 二、新增项目弹窗 ── */
  console.log('');
  console.log('  ② 「赛程」页 →「新增项目」');
  await ev("(function(){var b=[].find.call(document.querySelectorAll('[data-tab]'),function(x){return x.dataset.tab==='events'});if(b)b.click();return 1})()");
  await sleep(1500);

  const evOpened = await ev(`(function(){
    var btns = [].slice.call(document.querySelectorAll('button'));
    var b = btns.filter(function(x){return (x.textContent||'').trim().indexOf('新增项目')>=0;})[0];
    if (!b) return {err:'找不到「新增项目」按钮'};
    b.click();
    return {ok:true};
  })()`);
  ck(evOpened && evOpened.ok, '点得到「新增项目」', evOpened);
  await sleep(600);

  const evForm = await ev(`(function(){
    var m = document.getElementById('askModal');
    if (!m || m.hidden) return {err:'弹窗没打开'};
    var f = document.getElementById('askField');
    var labels = [].slice.call(f.querySelectorAll('.label')).map(function(x){return x.textContent;});
    return {
      title: document.getElementById('askTitle').textContent,
      labels: labels,
      timeInputs: f.querySelectorAll('input[type=time]').length,
      dateInputs: f.querySelectorAll('input[type=date],input[type=datetime-local]').length,
      selects: [].slice.call(f.querySelectorAll('select')).map(function(s){
        return {n: s.options.length, first: s.options[0] ? s.options[0].value : null};
      }),
    };
  })()`);
  console.log('      标题：' + (evForm && evForm.title));
  console.log('      字段：' + JSON.stringify(evForm && evForm.labels));
  ck(evForm && /新增项目/.test(evForm.title), '弹窗标题对');
  ck(evForm && evForm.labels.indexOf('项目名称') >= 0, '有「项目名称」');
  ck(evForm && evForm.labels.indexOf('组别') >= 0, '有「组别」');
  ck(evForm && evForm.labels.indexOf('类型') >= 0, '有「类型」');
  ck(evForm && evForm.labels.indexOf('阶段') >= 0, '有「阶段」');
  ck(evForm && evForm.timeInputs === 2, '★ 开始/结束都是 time（只填时刻，不填日期）');
  ck(evForm && evForm.dateInputs === 0, '★ 没有日期选择器（已按要求去掉）');
  ck(evForm && evForm.selects.length >= 2 && evForm.selects[0].n > 0,
    '组别下拉有选项（' + JSON.stringify(evForm && evForm.selects) + '）');
  ck(evForm && evForm.labels.indexOf('田赛试跳次数') >= 0, '有「田赛试跳次数」');
  ck(evForm && evForm.labels.some(function(x){return x.indexOf('精度')>=0;}), '有「精度」');

  /* 空名字要拦住 */
  await ev("document.getElementById('askOk').click(); 1");
  await sleep(600);
  const evBlank = await ev("(function(){return {stillOpen: !document.getElementById('askModal').hidden, name: document.getElementById('askField').querySelector('input').value}})()");
  ck(evBlank && evBlank.stillOpen, '★ 名字为空时不关弹窗（拦住人）', evBlank);

  const EVNAME = '前端探针项目' + Date.now().toString().slice(-5);
  await ev(`(function(){
    var f = document.getElementById('askField');
    f.querySelector('input').value = ${JSON.stringify(EVNAME)};
    var t = f.querySelector('input[type=time]');
    if (t) { t.value = '07:40'; t.dispatchEvent(new Event('change', {bubbles:true})); }
    document.getElementById('askOk').click();
    return 1;
  })()`);
  await sleep(2500);
  const evAfter = await ev(`(function(){
    var m = document.getElementById('askModal');
    var wrap = document.getElementById('toastWrap');
    var toasts = wrap ? [].slice.call(wrap.querySelectorAll('.toast')).map(function(x){return x.textContent;}) : [];
    var f = document.getElementById('askField');
    var err = [].slice.call(f.querySelectorAll('.ask-text')).map(function(x){return x.textContent;}).filter(Boolean);
    return {closed: !!m.hidden, toasts: toasts, err: err};
  })()`);
  console.log('      toast：' + JSON.stringify(evAfter && evAfter.toasts));
  ck(evAfter && evAfter.closed, '项目弹窗填对了才关');
  ck(evAfter && evAfter.toasts && evAfter.toasts.length > 0, '★ 给了反馈（toast）');

  /* 库里现在**还查不到** —— 人只是进了暂存区。
     这一步故意只打印不判定，真正的"进库了没有"放在确认之后再断言。
     （我第一版就是在这儿断言"人真的进库了"，必然失败：那是设计如此。） */
  const preSave = await ev(`(function(){
    return fetch('/api/roster?search=' + encodeURIComponent(${JSON.stringify(NAME)}) + '&limit=5',
      {credentials:'same-origin'}).then(function(r){return r.json()})
      .then(function(j){ var d=j.data||j; return (d.athletes||d.rows||[]).length; });
  })()`, true);
  console.log('      确认之前查库：' + preSave + ' 条（应当是 0 —— 还没确认）');
  ck(preSave === 0, '★ 确认之前库里查不到（改动确实在暂存区，没提前生效）');

  /* ── 三、暂存 → 确认 → 真进库 ──────────────────────────────────────────
     【为什么必须走这一步】管理员的新增是**暂存**的：点「新增」只是进了暂存区，
     要点「确认并推送大屏」才真写进库。我第一次跑探针时看到两个弹窗都"成功"了
     就去查库，结果一条都没有 —— 差点误判成"添加功能是坏的"。
     真相是**设计如此**，而我的探针少走了后半程。 */
  console.log('');
  console.log('  ③ 暂存区 → 确认 → 真进库（管理员的改动要走这一步）');

  const staged = await ev(`(function(){
    return fetch('/api/staged', {credentials:'same-origin'})
      .then(function(r){return r.json()})
      .then(function(j){
        var d = j.data || j;
        var list = d.items || d.staged || d.list || [];
        return {n: list.length, ops: list.map(function(x){return x.op;})};
      });
  })()`, true);
  console.log('      暂存区：' + JSON.stringify(staged));
  ck(staged && staged.n >= 2, '★ 两次新增都进了暂存区（' + (staged ? staged.n : 0) + ' 条）');
  ck(staged && staged.ops && staged.ops.indexOf('athlete.add') >= 0, '暂存里有 athlete.add');
  ck(staged && staged.ops && staged.ops.indexOf('event.add') >= 0, '暂存里有 event.add');

  const confirmed = await ev(`(function(){
    return fetch('/api/confirm', {
      method:'POST', credentials:'same-origin',
      /* CSRF 令牌用 App.getCsrf() 取（common.js 里存的是模块内变量，
         不是 App.csrf 属性 —— 我第一次写成 App.csrf 会拿到空串）。 */
      headers:{'content-type':'application/json','x-csrf': App.getCsrf ? App.getCsrf() : ''},
      body: JSON.stringify({force:true}),
    }).then(function(r){return r.json().then(function(j){return {status:r.status, body:j}}) });
  })()`, true);
  console.log('      确认结果：HTTP ' + (confirmed && confirmed.status)
    + '　' + JSON.stringify(confirmed && confirmed.body && (confirmed.body.message || confirmed.body.ok)));
  ck(confirmed && confirmed.status === 200, '★ 确认成功（HTTP ' + (confirmed && confirmed.status) + '）',
    confirmed && confirmed.body);
  const applied = confirmed && confirmed.body && confirmed.body.data && confirmed.body.data.applied;
  console.log('      生效条数：' + applied);

  /* 确认之后再看一次暂存区应当空了 */
  const staged2 = await ev(`(function(){
    return fetch('/api/staged', {credentials:'same-origin'})
      .then(function(r){return r.json()})
      .then(function(j){var d=j.data||j;var l=d.items||d.staged||d.list||[];return {n:l.length}});
  })()`, true);
  ck(staged2 && staged2.n === 0, '★ 确认后暂存区清空（' + (staged2 ? staged2.n : 0) + ' 条）');

  /* 确认之后，两个人才真的在库里 —— 这才是"能不能用"的最终判据 */
  const savedAfter = await ev(`(function(){
    return fetch('/api/roster?search=' + encodeURIComponent(${JSON.stringify(NAME)}) + '&limit=5',
      {credentials:'same-origin'}).then(function(r){return r.json()})
      .then(function(j){
        var d = j.data || j;
        var rows = d.athletes || d.rows || [];
        return {n: rows.length, first: rows[0] || null};
      });
  })()`, true);
  console.log('      确认之后查库：' + JSON.stringify(savedAfter && savedAfter.first));
  ck(savedAfter && savedAfter.n >= 1, '★ 确认后**人真的进库了**（' + (savedAfter ? savedAfter.n : 0) + ' 条）');
  ck(savedAfter && savedAfter.first && savedAfter.first.name === NAME, '名字对得上');
  ck(savedAfter && savedAfter.first && !!savedAfter.first.groupId, '★ 组别不是空的（没落成"无组别"）');

  console.log('');
  console.log('  ══ 结果：' + pass + ' 通过 / ' + fail + ' 失败 ══');
  console.log('  VERIFY_NAME=' + NAME);
  console.log('  VERIFY_EVENT=' + EVNAME);
  console.log('');

  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('  探针出错：' + (e && e.stack || e));
  process.exit(2);
});
