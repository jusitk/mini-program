'use strict';
/* ============================================================================
 * presence.test.js —— 「账号在线状态要实时」的验收
 *
 * 【原来错在哪】账号页的"在线"只查 `session` 表里有没有未过期的会话，
 *   而会话默认活 14 天 —— 老师早上登录、中午关掉网页，
 *   账号页**到明天都还显示"已登录"**。用户的原话：
 *   「不是打开过一次就一直显示已登录」。
 *
 * 【现在怎么判】看 `session.lastSeenAt`（每次带 Cookie 的请求都刷新）：
 *   最近 90 秒内活动过 = 在线。前端每 30 秒打一次 GET /api/ping。
 *
 * 验收要覆盖两类错法：
 *   · 判得太松 → 关了页面还一直显示在线（原来的毛病）
 *   · 判得太紧 → 还在用却显示离线（会让人以为掉线了）
 *
 * 运行：node --no-warnings --test test/presence.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8490;
const PASS = 'admin123';
let mod = null;
let server = null;
let dataDir = '';
let base = '';

function startServer() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
  process.env.DATA_DIR = dataDir;
  process.env.PORT = String(PORT);
  process.env.HOST = '127.0.0.1';
  process.env.SPORTS_ADMIN_PASSWORD = PASS;
  process.env.SPORTS_ADMIN_USER = 'admin';
  delete process.env.SEED_DEMO;
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf(ROOT) === 0 && k.indexOf('node_modules') < 0) delete require.cache[k];
  }
  mod = require(path.join(ROOT, 'server.js'));
  mod.initData();
  server = mod.server;
  return new Promise((resolve) => {
    if (server.listening) return resolve();
    server.listen(PORT, '127.0.0.1', resolve);
  });
}
function stopServer() {
  return new Promise((resolve) => {
    try { mod.stopTimers(); } catch (e) { /* ignore */ }
    const done = () => {
      try { const d = mod.getDb(); if (d) d.close(); } catch (e) { /* ignore */ }
      setTimeout(() => {
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        resolve();
      }, 200);
    };
    try { if (server && server.listening) server.close(done); else done(); }
    catch (e) { done(); }
  });
}

function makeClient(fakeIp) {
  let cookie = '', csrf = '';
  return {
    get cookie() { return cookie; },
    async call(method, url, body) {
      const headers = { Accept: 'application/json' };
      if (cookie) headers.Cookie = cookie;
      if (fakeIp) headers['X-Forwarded-For'] = fakeIp;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (csrf && method !== 'GET') headers['X-CSRF'] = csrf;
      const r = await fetch(base + url, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
      return { status: r.status, data };
    },
    async login() {
      const r = await this.call('POST', '/api/login', { username: 'admin', password: PASS });
      if (r.data && r.data.csrf) csrf = r.data.csrf;
      return r;
    },
    ping() { return this.call('GET', '/api/ping'); },
    users() { return this.call('GET', '/api/users'); },
  };
}

/** 把某个账号所有会话的 lastSeenAt 推到 n 秒前（模拟"人已经关了页面"） */
function ageSessions(seconds) {
  const d = mod.getDb();
  const at = new Date(Date.now() - seconds * 1000).toISOString();
  d.run('UPDATE session SET lastSeenAt = ?', [at]);
  return at;
}

test.before(async () => { base = 'http://127.0.0.1:' + PORT; await startServer(); });
test.after(async () => { await stopServer(); });

test('心跳接口存在，且未登录时明确 401（前端据此发现自己掉线）', async () => {
  const anon = await fetch(base + '/api/ping');
  assert.strictEqual(anon.status, 401, '没登录应当 401');
  const c = makeClient('192.168.5.1');
  await c.login();
  const r = await c.ping();
  assert.strictEqual(r.status, 200, '登录后心跳应当 200');
  assert.strictEqual(r.data.ok, true, '返回 ok');
  assert.strictEqual(r.data.user, 'admin', '带上是谁');
});

test('刚登录 → 在线', async () => {
  const c = makeClient('192.168.5.2');
  await c.login();
  const u = (await c.users()).data.data.users.find(x => x.username === 'admin');
  assert.strictEqual(u.online, true, '刚登录应当显示在线');
  assert.strictEqual(u.loggedIn, true, '同时也有会话');
  assert.ok(u.lastSeenAt, '要给出最后活跃时间');
});

test('心跳会刷新 lastSeenAt（页面开着 → 一直算在线）', async () => {
  const c = makeClient('192.168.5.3');
  await c.login();
  // 推到快过期（80 秒前），心跳一下应当又变成"刚刚"
  ageSessions(80);
  const before = (await c.users()).data.data.users.find(x => x.username === 'admin');
  assert.strictEqual(before.online, true, '80 秒内还算在线（窗口 90 秒）');

  await c.ping();
  const after = (await c.users()).data.data.users.find(x => x.username === 'admin');
  const age = Date.now() - new Date(after.lastSeenAt).getTime();
  assert.ok(age < 5000, '心跳之后 lastSeenAt 应当被刷新到现在（实际差 ' + Math.round(age / 1000) + ' 秒）');
});

test('人关掉网页（不再有请求）→ 过一会儿显示**离线**，但保留会话', async () => {
  /* 这就是用户要的核心行为：不是"打开过一次就一直已登录" */
  const c = makeClient('192.168.5.4');
  await c.login();

  // 模拟"关了网页"：把 lastSeenAt 推到窗口之外
  ageSessions(120);
  const u = (await c.users()).data.data.users.find(x => x.username === 'admin');
  assert.strictEqual(u.online, false, '超过窗口没活动 → 必须显示离线（否则就是原来的毛病）');
  assert.strictEqual(u.loggedIn, true, '会话还在（他还能直接刷新继续用），所以 loggedIn 仍为 true');
  assert.ok(u.sessionIp, '仍然知道是哪台机器');
});

test('离线之后回来动一下 → 立刻又是在线（判太紧会误报掉线）', async () => {
  const c = makeClient('192.168.5.5');
  await c.login();
  ageSessions(120);
  let u = (await c.users()).data.data.users.find(x => x.username === 'admin');
  assert.strictEqual(u.online, false, '先是离线');

  await c.ping();
  u = (await c.users()).data.data.users.find(x => x.username === 'admin');
  assert.strictEqual(u.online, true, '动一下就该立刻回到在线 —— 不能还显示离线让人以为掉线了');
});

test('窗口是 90 秒，且接口把它告诉前端（前端据此解释"多久算掉线"）', async () => {
  const c = makeClient('192.168.5.6');
  await c.login();
  const d = (await c.users()).data.data;
  assert.strictEqual(d.onlineWindowSec, 90, '窗口应当是 90 秒（实际 ' + d.onlineWindowSec + '）');
  assert.ok(d.serverTime, '要带服务器时间（客户端时钟可能不准）');
});

test('每个请求都会刷新 lastSeenAt（不只是心跳）', async () => {
  /* 【这一条现在是"反向"的，而且是有意的】
     我第一版让 currentUser 每次请求都刷新 lastSeenAt，测试立刻抓出问题：
     **管理员打开账号页看谁在线，这个动作先刷了他自己的时间**，
     于是"他自己永远显示在线"，判定失真。
     更糟的是：一个已经关掉网页的人，只要别人恰好触发一次带他 Cookie 的
     请求就"复活" —— 对"谁还在录成绩"这种判断是灾难性的。

     所以现在只有该会话**自己的心跳**才算数。
     只有他真在操作（页面开着），心跳才会到。 */
  const c = makeClient('192.168.5.7');
  await c.login();
  ageSessions(120);

  // 一个普通请求（不是心跳）：**不该**把它变回在线
  await c.call('GET', '/api/snapshot?kind=admin');
  let u = (await c.users()).data.data.users.find(x => x.username === 'admin');
  assert.strictEqual(u.online, false, '普通请求不该把已离线的会话刷成在线');

  // 心跳才行
  await c.ping();
  u = (await c.users()).data.data.users.find(x => x.username === 'admin');
  assert.strictEqual(u.online, true, '心跳了才算在线');
});

test('只有心跳会写 lastSeenAt（别的地方不许顺手写）', () => {
  /* 结构断言：这条规则很容易在后续改动里被"顺手优化"掉
     （比如为了"记住最后访问时间"又在 currentUser 里加一行 UPDATE），
     而症状是"在线状态又变成打开过一次就一直在" —— 极难发现。 */
  const auth = fs.readFileSync(path.join(ROOT, 'src', 'auth.js'), 'utf8');
  const cur = auth.slice(auth.indexOf('function currentUser('),
    auth.indexOf('function touchSession('));
  assert.strictEqual(/UPDATE session SET lastSeenAt/.test(cur), false,
    'currentUser 里不该再写 lastSeenAt（那会让"看列表"这个动作把人刷成在线）');
  const touch = auth.slice(auth.indexOf('function touchSession('));
  assert.ok(/UPDATE session SET lastSeenAt/.test(touch.slice(0, 400)),
    'touchSession 要负责写 lastSeenAt');

  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const ping = srv.slice(srv.indexOf("'/api/ping'"), srv.indexOf("'/api/ping'") + 500);
  assert.ok(/touchSession/.test(ping), '/api/ping 要调 touchSession');
});

test('前端确实会定时打心跳（结构断言）', () => {
  /* 后端判得再准，前端不打心跳也没用 —— 页面开着却"什么都不发"，
     lastSeenAt 就不会更新，反而会被判成离线。
     这属于"接口对了但没接线"，纯接口测试看不出来，所以查代码。 */
  const core = fs.readFileSync(path.join(ROOT, 'public', 'admin-core.js'), 'utf8');
  assert.ok(core.indexOf("'/api/ping'") >= 0, '前端要打 /api/ping');
  const i = core.indexOf('function heartbeat(');
  assert.ok(i >= 0, '要有 heartbeat 函数');
  const body = core.slice(i, i + 900);
  assert.ok(/setInterval\(/.test(body), '心跳要定时发');
  assert.ok(/document\.hidden/.test(body), '页面不在前台就别发（省电省流量）');
  const m = body.match(/}\s*,\s*(\d+)\s*\)/);
  assert.ok(m, '要能看出间隔');
  const interval = Number(m[1]);
  assert.ok(interval > 0 && interval <= 60000,
    '心跳间隔 ' + interval + 'ms 必须小于离线窗口（90 秒），否则会被误判成离线');
  // 必须在 startData 里真的被调用
  assert.ok(/heartbeat\(\);/.test(core), 'heartbeat 要被调用，不能只定义');
  // 401 时要能识别出"我掉线了"
  assert.ok(/r\.status === 401/.test(body) || /401/.test(body),
    '心跳拿到 401 要能反映出"会话没了"');
});
