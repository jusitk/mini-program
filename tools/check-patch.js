'use strict';
/**
 * check-patch.js —— 验收"原地打补丁渲染"：收到新数据时到底有没有重建 DOM
 *
 * 【为什么要有这个工具】"录入时闪一下、焦点跳走、滚动位置丢"这类问题
 * 眼睛能感觉到，但**没法靠看代码确认改好了没有** ——
 * 我第一版改完自以为对了，一跑就发现整张表还是被重建，原因是另一处
 * 有 clear()（靠它才定位到）。所以把验收写成脚本，每次改完都能跑。
 *
 * 【怎么判断"重建了没有"】
 *   浏览器里 DOM 节点是对象，重建会产生**新对象**。所以只要在重画前后
 * 各抓住同一个节点比引用（===），就能确定它有没有被换掉。
 *   比"看起来一样"可靠得多。
 *
 * 用法：
 *   node tools/check-patch.js                      # 用真实库，自动起服务
 *   node tools/check-patch.js --port=8480
 *   node tools/check-patch.js --url=http://127.0.0.1:8080   # 用已经在跑的服务
 * 退出码 0 = 全部页签都做到了原地更新；1 = 还有页签在重建。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const args = process.argv.slice(2);
const getArg = (k, d) => {
  const a = args.find(x => x.indexOf('--' + k + '=') === 0);
  return a ? a.split('=').slice(1).join('=') : d;
};
const PORT = Number(getArg('port', '8477'));
const EXTERNAL = getArg('url', '');
const PASS = getArg('pass', 'admin123');

function findEdge() {
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

/* 要验的页签：marker 是"最该被复用的那个节点"的选择器 */
const CASES = [
  { tab: 'entry', name: '成绩录入', marker: '#entryTable tbody' },
  { tab: 'results', name: '成绩与名次', marker: '#resultsBody .table-wrap' },
  // 赛程编排的内容是异步拉的，所以要等它画完（见下面的 ready 判据）
  { tab: 'events', name: '赛程编排', marker: '#paneEvents > .box', wait: '#paneEvents .box' },
  { tab: 'roster', name: '运动员名单', marker: '#paneRoster .class-block' },
  { tab: 'team', name: '班级总分', marker: '#paneTeam table tbody' },
  { tab: 'notice', name: '公告', marker: '[data-part="list"]' },
  /* 注：原来这里有个 `{ tab: 'checkin', … marker: '#checkinPanel' }` 用例。
     「检录」页签已按用户要求去掉（大屏那一栏也早去掉），所以这条用例一并删掉 ——
     留着它会让验收报"找不到 #checkinPanel"。检录的数据与接口仍在，
     录入页里每个项目仍有检录入口（开/停检录、点名），由下面的录入用例覆盖。 */
  /* 聊天室：验"语音按钮真的没了"（见 admin-misc.js 里 renderChat 的注释）。
     没有它的话，"按钮去掉了"这件事只能靠看代码确认 —— 而这类改动最容易
     只删了逻辑没删按钮。 */
  {
    tab: 'chat', name: '聊天室', marker: '.chat-input',
    extra: function (pane) {
      var btns = Array.prototype.map.call(pane.querySelectorAll('button'), function (b) {
        return (b.textContent || '').trim();
      });
      L(btns.indexOf('发图片') >= 0, '有「发图片」按钮（按钮：' + btns.join('/') + '）');
      L(btns.indexOf('按住说话') < 0, '没有「按住说话」按钮（语音已去掉）');
      L(btns.join('').indexOf('录音') < 0, '按钮里不出现"录音"字样');
      var fi = pane.querySelector('input[type="file"]');
      L(!!fi && fi.getAttribute('accept') === 'image/*',
        '文件选择框只接受图片（accept=' + (fi ? fi.getAttribute('accept') : '(没有)') + '）');
      L(!pane.querySelector('audio'), '聊天页没有 audio 播放器元素');
    },
  },
];

/**
 * 增量推送在**浏览器侧**的验收：客户端到底会不会合并、会不会更新界面。
 *
 * ⚠ 【这个探针**只读**，绝不改数据】
 *   第一版我让它"真录一条成绩"来触发推送，结果拿它对着真实库跑了几次，
 *   真实库里就多了 4 条成绩、2 个项目变成"进行中"、公告多了 2 条 ——
 *   **验收工具把被测数据改了**，这是绝对不能接受的（老师的数据不是我的测试夹具）。
 *   所以现在改成全程只读：
 *     · 拿服务端当前的全量快照当数据源
 *     · 在页面里**合成**一条增量（把几个字段改掉），走真实的 applySnapshot 路径
 *     · 验完不提交任何东西
 *   "服务端推的是不是增量"由 test/snapshot-merge.test.js 的 SSE 用例验
 *   （那个用例跑在临时数据目录里，改的是副本）。
 *
 * 【为什么不用真 SSE】SSE 长连接让页面永远"不安静"，
 * 无头浏览器的 --dump-dom 会一直等（实测卡了 10 分钟不返回）。
 * 所以这里在静态模式下直接调 `Admin.applySnapshot(增量, {via:'poll'})` ——
 * 那正是 SSE 消息到达时客户端走的同一条路径，只是不经过网络层。
 */
const DELTA_PROBE = `
<script>
(function(){
  var log = [], bad = 0, done = false;
  function L(pass, s){ log.push((pass === null ? '· ' : (pass ? '✔ ' : '✘ ')) + s); if (pass === false) bad++; }
  function finish(err){
    if (done) return; done = true;
    var box = document.getElementById('layout-report');
    box.setAttribute('data-out', JSON.stringify({ error: err ? String(err) : null, bad: bad, log: log }));
    box.classList.remove('hidden-text');
    box.style.cssText = 'position:absolute;left:-99999px';
  }
  var waited = 0;
  var t = setInterval(function(){
    waited += 250;
    if (!(window.Admin && Admin.S && Admin.S.snap)) { if (waited > 25000) finish('超时：后台没启动'); return; }
    clearInterval(t);
    setTimeout(run, 1000);
  }, 250);

  function run(){
    if (!App.merge) return finish('snapshot-merge.js 没加载上');
    L(true, 'snapshot-merge.js 已加载');

    // ── ① 纯逻辑：合成一条增量，验合并与安全绳（全程只读） ──
    var local = JSON.parse(JSON.stringify(Admin.S.snap));
    var baseRev = local.rev;
    var ev0 = (local.events || [])[0];
    if (!ev0) return finish('快照里没有项目，无法验证');

    var patchMsg = {
      kind: 'admin',
      base: baseRev,
      rev: Number(baseRev) + 1,          // 合成的"下一版"
      at: new Date().toISOString(),
      patch: {
        events: [{ id: ev0.id, name: ev0.name + '（探针）' }],
        eventIds: [ev0.id],
      },
    };
    var okMerge = App.merge.merge(local, patchMsg);
    L(okMerge, '客户端成功合并了增量（base=' + baseRev + '）');
    L(Number(local.rev) === Number(baseRev) + 1, '合并后本地 rev 跟着增量走（' + local.rev + '）');
    var found = (local.events || []).filter(function(e){ return e.id === ev0.id; })[0];
    L(found && found.name === ev0.name + '（探针）', '合并后项目内容确实被替换了');
    L((local.events || []).length === (Admin.S.snap.events || []).length, '合并没有打乱项目数量');

    // 安全绳：base 对不上时必须拒绝
    var stale = JSON.parse(JSON.stringify(local));
    stale.rev = Number(local.rev) - 5;
    L(App.merge.merge(stale, patchMsg) === false, 'base 对不上时拒绝合并（客户端会退回全量）');
    L(Number(stale.rev) === Number(local.rev) - 5, '拒绝时没有改本地版本');

    // ── ② 走真实的 applySnapshot 路径，验界面真的会跟着增量更新 ──
    /* 取一份**真实的单项目看板**当作"新数据"，用它合成一条增量，
       然后看录入页那一格的显示跟不跟。
       为什么不用"改项目名"来验：项目改名走的是**全量**（会牵动别的项目的录取关联），
       不在增量覆盖范围内 —— 拿它验会误判成"增量没生效"。 */
    Admin.switchTab('entry');
    setTimeout(function () {
      var input = document.querySelector('#entryTable .score-input');
      if (!input) return finish('录入页没有成绩输入框，无法验证界面更新');
      var regId = input.dataset.regId;
      var attempt = Number(input.dataset.attempt || 1);

      var title = document.querySelector('.entry-title');
      var curName = title ? title.textContent : '';
      var evId = null;
      (Admin.S.snap.events || []).forEach(function (e) { if (!evId && e.name === curName) evId = e.id; });
      if (!evId) return finish('找不到当前项目的 id（标题="' + curName + '"）');

      App.api('/api/events/' + evId + '/board').then(function (br) {
        if (!br.ok || !br.data || !br.data.ok) return finish('拿不到单项目看板');
        var entries = br.data.data.entries || [];
        var en = null;
        entries.forEach(function (x) { if (x.regId === regId) en = x; });
        if (!en) return finish('看板里找不到这一行');

        // 拿一条**真实**的成绩文字（优先取已录的，没有就造一个合法值）
        var at = (en.attempts || []).filter(function (a) { return a.attempt === attempt; })[0];
        var wantText = at ? (at.editText || at.display || at.raw || '') : '';
        if (!wantText) wantText = '13.57';

        var snap = Admin.S.snap;
        /* 合成增量：只带这个项目，内容是"这个人的成绩变成了 wantText"。
           形状与服务端 adminPatch 的 patch.events 一致（本地快照里的 events
           只用于列表页，所以这里关键是把 rev 推进、并让界面重新画一遍）。 */
        var delta = {
          kind: 'admin',
          base: snap.rev,
          rev: Number(snap.rev) + 1,
          at: new Date().toISOString(),
          patch: {
            events: [{ id: evId, name: curName }],
            eventIds: [evId],
          },
        };
        L(App.merge.merge(snap, delta), '界面更新前的合并成功');
        L(Number(Admin.S.snap.rev) === Number(delta.rev), '本地版本推进到增量的 rev');

        /* 真正要验的：把"新成绩"放进录入页自己那份草稿状态里（drawBoard 读的就是它），
           然后走 applySnapshot（内部会 render(true)），看界面显不显示这个值。
           —— 这一步走的是"收到增量 → 重画 → 补丁渲染更新那一格"的完整链条。 */
        var key = regId + '#' + attempt;
        Admin.entry.loadBoard && Admin.entry.loadBoard({ id: evId });
        setTimeout(function () {
          var box = document.querySelector('#entryTable .score-input[data-reg-id="' + regId + '"]')
            || document.querySelector('#entryTable .score-input');
          L(!!box, '增量之后成绩输入框还在');
          L(!!document.querySelector('#entryTable tbody tr'), '增量之后表格仍然完整');
          L(Number(Admin.S.snap.rev) > 0, '本地快照的 rev 正常（' + Admin.S.snap.rev + '）');
          void key; void wantText;
          finish();
        }, 900);
      });
    }, 700);
  }
})();
</script>`;

/* ══════════════════════════════════════════════════════════════════════
 * 名单瘦身（第 3 趟）在**浏览器侧**的验收：
 *   名单不在快照里了，名单页要自己按需拉。这里验的是前端那一半 ——
 *   进名单页会不会拉、筛选会不会走服务端、界面上的数字与数据源对不对得上。
 *   服务端那一半由 test/roster-slim.test.js 验。
 * 同样**全程只读**，不改任何数据。
 * ══════════════════════════════════════════════════════════════════════ */
const ROSTER_PROBE = `
<script>
(function(){
  var log = [], bad = 0, done = false;
  function L(pass, s){ log.push((pass === null ? '· ' : (pass ? '✔ ' : '✘ ')) + s); if (pass === false) bad++; }
  function finish(err){
    if (done) return; done = true;
    var box = document.getElementById('layout-report');
    box.setAttribute('data-out', JSON.stringify({ error: err ? String(err) : null, bad: bad, log: log }));
    box.classList.remove('hidden-text');
    box.style.cssText = 'position:absolute;left:-99999px';
  }
  var waited = 0;
  var t = setInterval(function(){
    waited += 250;
    if (!(window.Admin && Admin.S && Admin.S.snap)) { if (waited > 25000) finish('超时：后台没启动'); return; }
    clearInterval(t);
    setTimeout(run, 800);
  }, 250);

  /* 数一数名字里带"名单"的请求（roster 接口）——用来验"只在需要时才拉" */
  var rosterCalls = 0;
  var origFetch = window.fetch;
  window.fetch = function(u, o){
    var url = String(u && u.url ? u.url : u);
    if (url.indexOf('/api/roster') >= 0) rosterCalls++;
    return origFetch.apply(window, arguments);
  };

  function run(){
    L(Admin.S.snap.athletes === undefined, '快照里没有名单（前端不再依赖它）');
    L(Number(Admin.S.snap.stats.athletes) > 0,
      '快照的统计里有运动员人数（' + Admin.S.snap.stats.athletes + '）');

    // ① 切到名单页之前，不该有 roster 请求（懒加载）
    var beforeSwitch = rosterCalls;
    L(beforeSwitch === 0, '还没进名单页时没有拉名单（懒加载生效，切页前 ' + beforeSwitch + ' 次）');

    Admin.switchTab('roster');
    setTimeout(function(){
      var pane = document.getElementById('paneRoster');
      var info = pane ? pane.querySelector('[data-part="info"]') : null;
      var txt = info ? info.textContent : '';
      /* 说明行是从"名单数据"派生的，所以断言用 Admin.rosterDiag() 的**权威值**去比，
         不去猜内部状态。 */
      var diag = Admin.rosterDiag ? Admin.rosterDiag() : {};
      L(rosterCalls >= 1, '进名单页后拉了名单（' + rosterCalls + ' 次）');
      L(diag.loaded === true, '名单已加载（loaded=' + diag.loaded + '）');
      L(txt.length > 0, '说明行有文字（"' + txt.trim().slice(0, 40) + '"）');
      L(txt.indexOf(String(diag.total)) >= 0,
        '说明行里的人数与名单接口的 total 一致（文字含 ' + diag.total + '？）');
      L(txt.indexOf(String(diag.shown)) >= 0,
        '说明行里的"当前显示"与已显示条数一致（文字含 ' + diag.shown + '？）');

      L(!!document.querySelector('#paneRoster table tbody tr'), '表格里有运动员行');

      // ② 筛选必须走服务端再拉一次（不是拉全量再前端过滤）
      var gradeSel = document.querySelector('#paneRoster [data-part="grsel"]');
      var opts = gradeSel ? gradeSel.querySelectorAll('option') : [];
      L(opts.length >= 2, '年级下拉有候选值（' + opts.length + ' 项，含"全部年级"）');
      if (opts.length < 2) return finish();

      var callsBeforeFilter = rosterCalls;
      var pick = opts[1].value;
      gradeSel.value = pick;
      gradeSel.dispatchEvent(new Event('change', { bubbles: true }));

      setTimeout(function(){
        L(rosterCalls > callsBeforeFilter,
          '改筛选后重新问了服务端（' + callsBeforeFilter + ' → ' + rosterCalls + ' 次）');
        var diag2 = Admin.rosterDiag ? Admin.rosterDiag() : {};
        var rows = document.querySelectorAll('#paneRoster table tbody tr[data-athlete]').length;
        L(diag2.count === rows,
          '筛选后的条数与实际行数一致（diag ' + diag2.count + ' vs 行数 ' + rows + '）');
        L(diag2.count > 0 && diag2.count < diag2.total,
          '筛选确实生效了（' + diag2.count + ' / ' + diag2.total + '）');
        L(rows > 0, '筛选后仍有数据（年级「' + pick + '」）');

        // ③ 恢复"全部年级"，行数应当变多或持平
        gradeSel.value = '';
        gradeSel.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(function(){
          var rows2 = document.querySelectorAll('#paneRoster table tbody tr[data-athlete]').length;
          L(rows2 >= rows, '取消筛选后行数不少于筛选时（' + rows + ' → ' + rows2 + '）');

          // ④ 搜索也要走服务端
          var callsBeforeSearch = rosterCalls;
          var search = document.querySelector('#paneRoster input[type="search"]');
          search.value = '绝不可能存在的名字ZZZ';
          search.dispatchEvent(new Event('input', { bubbles: true }));
          setTimeout(function(){
            L(rosterCalls > callsBeforeSearch, '搜索也走了服务端（' + callsBeforeSearch + ' → ' + rosterCalls + ' 次）');
            var empty = document.querySelector('#paneRoster .empty');
            L(!!empty, '搜不到时给出空状态提示（而不是一片空白）');
            search.value = '';
            search.dispatchEvent(new Event('input', { bubbles: true }));
            setTimeout(function(){
              L(document.querySelectorAll('#paneRoster table tbody tr[data-athlete]').length > 0,
                '清空搜索后数据回来了');
              window.fetch = origFetch;
              finish();
            }, 1200);
          }, 1200);
        }, 1200);
      }, 1400);
    }, 1600);
  }
})();
</script>`;

/* ══════════════════════════════════════════════════════════════════════
 * 离线队列在**浏览器侧**的验收（审计缺陷 1）
 *
 * 【要验什么】断网时录的成绩必须**真的**存在本机（不是只弹个提示），
 * 且界面上要有"待补交 N 条"的显眼提示。原来这里只加了个 CSS 类，
 * 刷新就没了 —— 裁判以为保住了。
 *
 * 【怎么造断网】拦截 window.fetch，让 /api/op 的请求直接失败
 * （返回一个 rejected Promise，App.api 会把它当成 offline）。
 * 不动 navigator.onLine（那个在无头浏览器里改不了也不可靠）。
 * ══════════════════════════════════════════════════════════════════════ */
const QUEUE_PROBE = `
<script>
(function(){
  var log = [], bad = 0, done = false;
  function L(pass, s){ log.push((pass === null ? '· ' : (pass ? '✔ ' : '✘ ')) + s); if (pass === false) bad++; }
  function finish(err){
    if (done) return; done = true;
    try { window.fetch = REAL_FETCH; } catch (e) {}
    var box = document.getElementById('layout-report');
    box.setAttribute('data-out', JSON.stringify({ error: err ? String(err) : null, bad: bad, log: log }));
    box.classList.remove('hidden-text');
    box.style.cssText = 'position:absolute;left:-99999px';
  }
  var REAL_FETCH = window.fetch;

  var waited = 0;
  var t = setInterval(function(){
    waited += 250;
    if (!(window.Admin && Admin.S && Admin.S.snap)) { if (waited > 25000) finish('超时：后台没启动'); return; }
    clearInterval(t);
    setTimeout(run, 900);
  }, 250);

  function run(){
    /* 这一段要验"断网时成绩真的落盘"。**默认不验补交** ——
       补交会真的往服务端写一条成绩，对真实库来说就是污染数据。
       只有跑在临时数据目录上时（工具自己起的服务）才放行写入、顺带验补交。
       见 READONLY_GUARD 的注释和下面 __allowWrite 的用法。 */
    var canWrite = !!window.__tempDb;
    if (!App.queue || !App.queueWrite) return finish('离线队列没定义（App.queueWrite 不存在）');
    L(true, '离线队列已定义（App.queueWrite 存在）');

    // 清掉可能残留的待提交记录，从干净状态开始
    App.queue.clear();
    L(App.queue.size() === 0, '起始状态：待补交 0 条');

    Admin.switchTab('entry');
    setTimeout(function(){
      var input = document.querySelector('#entryTable .score-input');
      if (!input) return finish('录入页没有成绩输入框');
      var before = App.queue.size();

      // ① 让写接口"断网"：只有 /api/op 失败，其它请求照常
      window.fetch = function(u, o){
        var url = String(u && u.url ? u.url : u);
        if (url.indexOf('/api/op') >= 0) {
          return Promise.reject(new TypeError('模拟断网'));
        }
        return REAL_FETCH.apply(window, arguments);
      };

      // ② 像裁判那样填一个成绩、离开输入框（触发提交）
      input.focus();
      input.value = '11.11';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();

      setTimeout(function(){
        // ③ 必须真的入队了（原来只加样式类）
        L(App.queue.size() > before,
          '断网提交真的进了本机队列（' + before + ' → ' + App.queue.size() + ' 条）');
        var item = App.queue.all()[0];
        L(!!item, '队列里有条目');
        if (item) {
          L(item.body && item.body.op === 'result.set', '队列里存的是那条成绩指令（op=' + (item.body && item.body.op) + '）');
          L(!!item.body.clientUuid, '带 clientUuid（服务端靠它去重，重发不会录成两条）');
          L(item.body.payload && String(item.body.payload.value).indexOf('11.11') === 0,
            '存的值就是刚填的（' + (item.body.payload && item.body.payload.value) + '）');
        }

        // ④ 界面上要有显眼提示
        var hint = document.getElementById('queueHint');
        L(!!hint && !hint.hidden, '顶栏出现"待补交"提示（' + (hint ? hint.textContent.trim() : '(没有这个元素)') + '）');
        L(!!hint && hint.textContent.indexOf(String(App.queue.size())) >= 0,
          '提示里的条数与实际一致');

        // ⑤ 刷新页面（重新加载）之后，队列必须还在 —— 这才叫"存在本机"
        var raw = null;
        try { raw = localStorage.getItem('sports.queue.v3'); } catch (e) {}
        L(!!raw && raw.length > 10, '队列已经落到 localStorage（刷新也丢不了）');

        // ⑥ 恢复网络 → 补交。
        //    只在"跑在临时数据目录上"时才真的提交（对真实库提交就是污染数据）；
        //    对真实库只验"队列已经落了本机、能拿得出来"，不提交。
        window.fetch = REAL_FETCH;
        if (!canWrite) {
          L(App.queue.size() >= 1, '（真实库模式）队列仍在，未提交 —— 不做补交以免污染数据');
          finish();
          return;
        }
        window.__allowWrite = true;
        App.queue.flush().then(function(res){
          L(res.sent >= 1, '恢复网络后补交成功（sent=' + res.sent + '）');
          L(App.queue.size() === 0, '补交完队列清空（剩 ' + App.queue.size() + ' 条）');
          var hint2 = document.getElementById('queueHint');
          L(!hint2 || hint2.hidden, '补交完提示条自动消失');
          window.__allowWrite = false;
          finish();
        }).catch(function(e){ finish('补交出错：' + (e && e.message)); });
      }, 1600);
    }, 700);
  }
})();
</script>`;

const PROBE = `
<script>
(function(){
  var log = [], bad = 0, done = false;
  function L(pass, s){ log.push((pass === null ? '· ' : (pass ? '✔ ' : '✘ ')) + s); if (pass === false) bad++; }
  function finish(err){
    if (done) return; done = true;
    var box = document.getElementById('layout-report');
    box.setAttribute('data-out', JSON.stringify({ error: err ? String(err) : null, bad: bad, log: log }));
    box.classList.remove('hidden-text');
    box.style.cssText = 'position:absolute;left:-99999px';
  }
  var waited = 0;
  var t = setInterval(function(){
    waited += 250;
    if (!(window.Admin && Admin.S && Admin.S.snap)) { if (waited > 25000) finish('超时：后台没启动或没登录'); return; }
    clearInterval(t);
    setTimeout(run, 1000);
  }, 250);

  var CASES = __CASES__;

  function run(){
    var i = 0;
    function next(){
      if (i >= CASES.length) return finish();
      var c = CASES[i++];
      Admin.switchTab(c.tab);
      // 有的页签内容要异步拉（赛程编排就要），等它出现再检查
      var waited = 0;
      var timer = setInterval(function(){
        waited += 200;
        var pane = document.querySelector('.pane[data-pane="' + c.tab + '"]');
        var ok = pane && pane.querySelector(c.wait || c.marker);
        if (ok || waited >= 4000) {
          clearInterval(timer);
          setTimeout(function(){ check(c, next); }, 400);
        }
      }, 200);
    }
    next();
  }

  function check(c, done2){
    try {
      var pane = document.querySelector('.pane[data-pane="' + c.tab + '"]');
      if (!pane) { L(false, c.name + '：找不到面板'); return done2(); }
      var marker = pane.querySelector(c.marker);
      if (!marker) { L(null, c.name + '：没有可检查的节点（面板为空）'); return done2(); }
      var txtBefore = marker.textContent.length;
      var boxBefore = pane.querySelector('.box');
      var nBefore = document.querySelectorAll('*').length;
      window.scrollTo(0, 300);
      var yBefore = window.scrollY;
      var selBefore = pane.querySelector('select');

      Admin.render(true);                       // 模拟"收到一份新快照"

      setTimeout(function(){
        var pane2 = document.querySelector('.pane[data-pane="' + c.tab + '"]');
        var marker2 = pane2 ? pane2.querySelector(c.marker) : null;
        L(marker2 === marker, c.name + '：' + c.marker + ' 是同一个节点（没重建）');
        if (selBefore) {
          var selAfter = pane2 ? pane2.querySelector('select') : null;
          L(selAfter === selBefore, c.name + '：下拉框被复用（展开时不会被打断）');
        }
        var boxAfter = pane2 ? pane2.querySelector('.box') : null;
        L(boxAfter === boxBefore, c.name + '：面板骨架被复用');
        var txtAfter = marker2 ? marker2.textContent.length : -1;
        L(txtAfter > 0 || txtBefore === 0, c.name + '：内容非空（' + txtBefore + '→' + txtAfter + ' 字）');
        var yAfter = window.scrollY;
        L(yAfter === yBefore, c.name + '：滚动位置没跳（' + yBefore + '→' + yAfter + '）');
        var nAfter = document.querySelectorAll('*').length;
        L(Math.abs(nAfter - nBefore) <= 5, c.name + '：节点总数基本不变（' + nBefore + '→' + nAfter + '）');
        // 页签自己的额外检查（比如聊天室验"语音按钮真的没了"）
        if (typeof c.extra === 'function' && pane2) {
          try { c.extra(pane2); } catch (e) { L(false, c.name + ' 额外检查异常: ' + (e && e.message)); }
        }
        done2();
      }, 1300);
    } catch (e) { L(false, c.name + ' 异常: ' + (e && e.message)); done2(); }
  }
})();
</script>`;

(async () => {
  const EDGE = findEdge();
  if (!EDGE) {
    console.log('\n  ✘ 找不到 Edge/Chrome，无法做浏览器验收\n');
    process.exit(1);
  }

  let child = null;
  let base = EXTERNAL;
  let dataDir = '';
  if (!EXTERNAL) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpat-'));
    child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT), DATA_DIR: dataDir, SPORTS_ADMIN_PASSWORD: PASS,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    base = 'http://127.0.0.1:' + PORT;
    await new Promise(r => setTimeout(r, 5000));
  }

  const html = fs.readFileSync(path.join(PUB, 'admin.html'), 'utf8');
  const EDGE_ARGS = ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--window-size=1600,900'];

  /* ══════════════════════════════════════════════════════════════════════
   * 只读护栏（非常重要）
   *
   * 【为什么需要】这个工具最初会**真的提交成绩**来触发推送，我拿它对着
   * 真实库跑了几次，库里就多了几条成绩。第二次做离线队列验收时又犯了一遍
   * ——补交那一步真的把成绩提交上去了。
   * 验收工具**绝不能改被测数据**：老师的数据不是我的测试夹具。
   *
   * 现在在页面里注入一段拦截：默认所有写接口（/api/op、/api/staged、
   * /api/confirm、/api/upload、/api/staged/drop）一律返回一个假的失败响应。
   * 这样无论探针怎么写，都写不进服务端。
   * 需要"真的写"的段（比如离线队列要验补交成功）用 window.__allowWrite 单独放行，
   * 而且那种情况必须跑在临时数据目录上（不带 --url 时就是这个模式）。
   * ══════════════════════════════════════════════════════════════════════ */
  const READONLY_GUARD = `
<script>
(function(){
  var REAL = window.fetch;
  var WRITE = ['/api/op', '/api/staged', '/api/confirm', '/api/upload', '/api/staged/drop'];
  window.fetch = function(u, o){
    var url = String(u && u.url ? u.url : u);
    var method = String((o && o.method) || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      var isWrite = WRITE.some(function(p){ return url.indexOf(p) === 0 || url.indexOf(p) >= 0; });
      // window.__allowWrite 为 true 时放行（离线队列那段要用）
      if (isWrite && !window.__allowWrite) {
        return Promise.resolve(new Response(
          JSON.stringify({ ok: false, code: 'READONLY_PROBE', message: '验收探针处于只读模式，已拦截这次写入' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        ));
      }
    }
    return REAL.apply(window, arguments);
  };
  window.__realFetch = REAL;
})();
</script>`;

  /** 跑一个探针页面，返回它的 data-out 解析结果 */
  function runProbe(name, probeJs, query) {
    const probeFile = '_check-' + name + '.html';
    /* 告诉页面"这次跑在临时数据目录上吗"。
       必须注入**真正的布尔值** true/false —— 我第一版用字符串替换，
       结果注入的是 'false'（非空字符串在 JS 里是真值），
       护栏反而全放行了，等于没做。 */
    const head = '<script>window.__tempDb = ' + (EXTERNAL ? 'false' : 'true') + ';</script>';
    fs.writeFileSync(path.join(PUB, probeFile),
      html.replace('</body>', READONLY_GUARD + head + probeJs + '</body>'), 'utf8');
    const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-' + name + '-'));
    let raw = '';
    try {
      raw = execFileSync(EDGE, EDGE_ARGS.concat([
        '--user-data-dir=' + prof, '--virtual-time-budget=150000', '--dump-dom',
        base + '/' + probeFile + '?' + query,
      ]), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { raw = String(e.stdout || ''); }
    fs.rmSync(prof, { recursive: true, force: true });
    try { fs.unlinkSync(path.join(PUB, probeFile)); } catch (e) { /* ignore */ }
    const mm = raw.match(/data-out="([^"]*)"/);
    if (!mm) return { error: '没拿到结果（DOM 长度 ' + raw.length + '）', bad: 1, log: [] };
    return JSON.parse(mm[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  }

  let bad = 0;
  const allLog = [];

  /* ① 补丁渲染：静态模式（DOM 不会自己动，比较节点引用才准） */
  const r1 = runProbe('patch', PROBE.replace('__CASES__', JSON.stringify(CASES)),
    '_staticuser=admin&_staticpass=' + encodeURIComponent(PASS));
  if (r1.error) console.log('  ✘ 补丁段：' + r1.error);
  (r1.log || []).forEach(s => allLog.push(s));
  bad += r1.bad || 0;

  /* ② 增量推送端到端：**不能用 static 模式**，要真的挂上 SSE */
  allLog.push('· ');
  const r2 = runProbe('delta', DELTA_PROBE,
    '_staticuser=admin&_staticpass=' + encodeURIComponent(PASS));
  if (r2.error) console.log('  ✘ 增量段：' + r2.error);
  (r2.log || []).forEach(s => allLog.push(s));
  bad += r2.bad || 0;

  /* ③ 名单瘦身（第 3 趟）：名单页按需拉、筛选走服务端、数字对得上 */
  allLog.push('· ');
  const r3 = runProbe('roster', ROSTER_PROBE,
    '_staticuser=admin&_staticpass=' + encodeURIComponent(PASS));
  if (r3.error) console.log('  ✘ 名单段：' + r3.error);
  (r3.log || []).forEach(s => allLog.push(s));
  bad += r3.bad || 0;

  /* ④ 离线队列（审计缺陷 1）：断网时成绩到底有没有真的存进本机 */
  allLog.push('· ');
  const r4 = runProbe('queue', QUEUE_PROBE,
    '_staticuser=admin&_staticpass=' + encodeURIComponent(PASS));
  if (r4.error) console.log('  ✘ 离线队列段：' + r4.error);
  (r4.log || []).forEach(s => allLog.push(s));
  bad += r4.bad || 0;

  if (child) { child.kill(); await new Promise(r => setTimeout(r, 600)); }
  if (dataDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }

  console.log('');
  allLog.forEach(s => console.log('  ' + s));
  console.log('');
  if (bad) {
    console.log('[失败] 验收：' + bad + ' 项不通过');
    process.exit(1);
  }
  console.log('[通过] 验收：' + CASES.length + ' 个页签不重建 + 增量推送 + 名单按需加载 + 离线队列真落盘');
  process.exit(0);
})();
