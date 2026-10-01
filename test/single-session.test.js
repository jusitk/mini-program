'use strict';
/* ============================================================================
 * single-session.test.js —— 「一个账号只能在一台设备上登录」的验收
 *
 * 【为什么要有这个规则】共用账号是现场最容易被忽略的出错来源：
 *   两个人用同一个操作员账号、各自在自己手机上录成绩，录到同一个项目就会
 *   互相覆盖（乐观锁会拦，但两人会不停看到"刚被别人改过"，越录越乱）。
 *   一人一台、各用各的账号，才是干净的用法。
 *
 * 【这个规则最怕的不是"没生效"，而是"生效了但没人知道自己被顶了"】
 *   老师会以为系统坏了或者被盗号了。所以验收的重点有一半在
 *   "被顶下线的那台**知不知道自己为什么下线**"。
 *
 * 两组独立实例：
 *   · 默认（ALLOW_MULTI_DEVICE_LOGIN 不设）→ 只能一台
 *   · ALLOW_MULTI_DEVICE_LOGIN=1          → 允许多台（留个开关，行为也要对）
 *
 * 运行：node --no-warnings --test test/single-session.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const PASS = 'admin123';

/* ── 起一个独立的服务实例（每组测试一个，互不干扰）──────────────────── */
function makeHarness(port, allowMulti) {
  const h = {
    port, base: 'http://127.0.0.1:' + port,
    dataDir: '', mod: null, server: null, aborts: [],
  };
  h.start = async function () {
    h.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-'));
    process.env.DATA_DIR = h.dataDir;
    process.env.PORT = String(port);
    process.env.HOST = '127.0.0.1';
    process.env.SPORTS_ADMIN_PASSWORD = PASS;
    process.env.SPORTS_ADMIN_USER = 'admin';
    delete process.env.SEED_DEMO;
    if (allowMulti) process.env.ALLOW_MULTI_DEVICE_LOGIN = '1';
    else delete process.env.ALLOW_MULTI_DEVICE_LOGIN;
    for (const k of Object.keys(require.cache)) {
      if (k.indexOf(ROOT) === 0 && k.indexOf('node_modules') < 0) delete require.cache[k];
    }
    h.mod = require(path.join(ROOT, 'server.js'));
    h.mod.initData();
    h.server = h.mod.server;
    await new Promise((res) => {
      if (h.server.listening) return res();
      h.server.listen(port, '127.0.0.1', res);
    });
  };
  h.stop = async function () {
    h.aborts.forEach(a => { try { a.abort(); } catch (e) { /* ignore */ } });
    h.aborts.length = 0;
    try { h.mod.stopTimers(); } catch (e) { /* ignore */ }
    await new Promise((res) => {
      const done = () => {
        try { const dd = h.mod.getDb(); if (dd) dd.close(); } catch (e) { /* ignore */ }
        setTimeout(() => {
          try { fs.rmSync(h.dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
          res();
        }, 200);
      };
      try { if (h.server && h.server.listening) h.server.close(done); else done(); }
      catch (e) { done(); }
    });
  };
  return h;
}

function clientFor(h, fakeIp) {
  let cookie = '', csrf = '';
  return {
    get cookie() { return cookie; },
    get sid() { return cookie.replace(/^sports_sid=/, ''); },
    async call(method, url, body) {
      const headers = { Accept: 'application/json' };
      if (cookie) headers.Cookie = cookie;
      if (fakeIp) headers['X-Forwarded-For'] = fakeIp;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (csrf && method !== 'GET') headers['X-CSRF'] = csrf;
      const r = await fetch(h.base + url, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
      return { status: r.status, data, setCookie: sc || '' };
    },
    async login(u, p) {
      const r = await this.call('POST', '/api/login', {
        username: u === undefined ? 'admin' : u,
        password: p === undefined ? PASS : p,
      });
      if (r.data && r.data.csrf) csrf = r.data.csrf;
      return r;
    },
    me() { return this.call('GET', '/api/me'); },
    note() { return this.call('GET', '/api/session/note'); },
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ══════════════════════════════════════════════════════════════════════
 * 两个实例：默认（只能一台）+ 开关打开（允许多台）
 * 都在这里建好，后面的测试才能引用（const 有暂时性死区，必须先声明）
 * ══════════════════════════════════════════════════════════════════════ */
const H1 = makeHarness(8488, false);
const H2 = makeHarness(8489, true);
test.before(async () => { await H1.start(); await H2.start(); });
test.after(async () => { await H1.stop(); await H2.stop(); });

test('开关关闭时（默认），第二个设备登录会顶掉第一个', async () => {
  const pc = clientFor(H1, '192.168.1.10');
  const phone = clientFor(H1, '192.168.1.20');

  assert.strictEqual((await pc.login()).status, 200, '电脑登录成功');
  const ok1 = await pc.me();
  assert.ok(ok1.data.user, '电脑此时是登录着的');

  const r2 = await phone.login();
  assert.strictEqual(r2.status, 200, '手机登录成功');
  assert.strictEqual(r2.data.displaced, 1, '应当顶掉 1 台（实际 ' + r2.data.displaced + '）');
  assert.strictEqual(r2.data.multiDevice, false, '返回里要说明当前不允许多设备');

  // 第一台必须已经失效
  const dead = await pc.me();
  assert.strictEqual(dead.data.user, null, '电脑应当已经被顶下线');
  // 第二台正常
  const alive = await phone.me();
  assert.ok(alive.data.user, '手机是登录着的');
});

test('被顶下线的那台**说得出原因**（否则老师以为系统坏了）', async () => {
  const pc = clientFor(H1, '192.168.1.31');
  const phone = clientFor(H1, '192.168.1.32');
  await pc.login();
  await phone.login();

  // 电脑那边问"我这条会话怎么了"
  const note = await pc.note();
  assert.strictEqual(note.status, 200, '会话说明接口可用');
  assert.ok(note.data.reason, '要给出原因，不能只说"未登录"');
  assert.ok(/另一台设备|别处/.test(note.data.reason), '原因要说清是"在别处登录了"：' + note.data.reason);
  assert.ok(/下线/.test(note.data.reason), '要说清"你已下线"：' + note.data.reason);
  assert.ok(/192\.168\.1\.32/.test(note.data.reason),
    '最好带上是从哪个 IP 登的，便于判断是不是本人：' + note.data.reason);

  // /api/me 也要带上（页面刷新后靠它）
  const me = await pc.me();
  assert.strictEqual(me.data.user, null, '已经不是登录状态');
  assert.ok(me.data.invalidReason, '/api/me 也要给出被顶下线的原因');
  assert.strictEqual(me.data.invalidReason, note.data.reason, '两个接口给的原因要一致');
});

test('被顶下线的那台，实时连接会收到带原因的 bye（不是默默断线）', async () => {
  const pc = clientFor(H1, '192.168.1.41');
  const phone = clientFor(H1, '192.168.1.42');
  await pc.login();
  await phone.login();          // 先让 pc 的会话被顶掉，再单独建流测"顶的瞬间"

  // 重新登录 pc，然后把手机再登一次来顶它
  const pc2 = clientFor(H1, '192.168.1.43');
  await pc2.login();
  const ctrl = new AbortController();
  H1.aborts.push(ctrl);
  let bye = null;
  const streamP = fetch(H1.base + '/api/stream/admin', {
    headers: { Cookie: pc2.cookie }, signal: ctrl.signal,
  }).then(async (res) => {
    const rd = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ln = chunk.split('\n').find(l => l.indexOf('data: ') === 0);
        if (!ln) continue;
        let msg = null;
        try { msg = JSON.parse(ln.slice(6)); } catch (e) { continue; }
        if (msg.type === 'bye') bye = msg;
      }
    }
  }).catch(() => { /* abort 正常 */ });

  await sleep(500);
  // 另一台设备登录，把 pc2 顶掉
  const other = clientFor(H1, '192.168.1.44');
  const r = await other.login();
  assert.strictEqual(r.data.displaced, 1, '应当顶掉 pc2');
  await sleep(800);
  ctrl.abort();
  await streamP.catch(() => {});

  assert.ok(bye, '被顶的那台应当收到 bye 消息（不是默默断线）');
  assert.ok(bye.reason && /另一台设备|下线/.test(bye.reason),
    'bye 要带能看懂的原因：' + (bye && bye.reason));
});

test('反复登录同一账号，始终只有一条会话（不会越登越多）', async () => {
  const ips = ['192.168.1.51', '192.168.1.52', '192.168.1.53', '192.168.1.54'];
  for (const ip of ips) {
    const c = clientFor(H1, ip);
    assert.strictEqual((await c.login()).status, 200, ip + ' 登录');
  }
  const d = H1.mod.getDb();
  const n = d.get('SELECT COUNT(*) c FROM session WHERE userId = (SELECT id FROM user WHERE username = ?)',
    ['admin']).c;
  assert.strictEqual(n, 1, '不管登录几次，都只该剩 1 条会话（实际 ' + n + '）');
});

test('顶下线要写进操作记录（谁在哪个 IP 登的、顶掉了几台）', async () => {
  const d = H1.mod.getDb();
  const rows = d.all(`SELECT action, detail, ip, sessionId FROM auditLog
                      WHERE action = 'session.displace' ORDER BY rowid DESC LIMIT 1`, []);
  assert.strictEqual(rows.length, 1, '应当有 session.displace 审计');
  const a = rows[0];
  assert.ok(a.detail && /顶下线/.test(a.detail), '说明里要写清顶下线了：' + a.detail);
  assert.ok(a.sessionId, '要关联到"是哪次登录做的"');
  assert.ok(/192\.168\.1\./.test(a.detail), '要带上被顶掉那台的 IP：' + a.detail);
});

test('退出登录后，再说"被顶下线"就不合适了（不该翻旧账）', async () => {
  const c = clientFor(H1, '192.168.1.61');
  await c.login();
  await c.call('POST', '/api/logout', {});
  const note = await c.note();
  assert.strictEqual(note.data.reason, null, '主动退出不该被说成"被顶下线"');
  const me = await c.me();
  assert.strictEqual(me.data.invalidReason, null, '/api/me 也不该给原因');
});

test('允许通过开关放开多设备（默认关，但要能开）', async () => {
  /* 用第二组实例验证（ALLOW_MULTI_DEVICE_LOGIN=1）*/
  const a = clientFor(H2, '192.168.9.1');
  const b = clientFor(H2, '192.168.9.2');
  await a.login();
  const r = await b.login();
  assert.strictEqual(r.data.multiDevice, true, '应当报告"允许多设备"');
  assert.strictEqual(r.data.displaced, 0, '不该顶掉任何人');
  assert.ok((await a.me()).data.user, '第一台应当还在登录着');
  assert.ok((await b.me()).data.user, '第二台也在登录着');

  // 账号列表里也要照实显示 2 条
  const users = (await b.call('GET', '/api/users')).data.data;
  assert.strictEqual(users.multiDevice, true, '账号列表要带上这个设置');
  const admin = users.users.find(u => u.username === 'admin');
  assert.ok(admin.sessionCount >= 2, '会话数应当 ≥2（实际 ' + admin.sessionCount + '）');
});

/* ══════════════════════════════════════════════════════════════════════
 * 第二组：允许多设备（开关打开）—— 测试都在上面一起跑，这里只留说明
 * ══════════════════════════════════════════════════════════════════════ */

test('允许多设备时，管理员仍能单独踢掉某一台', async () => {
  const a = clientFor(H2, '192.168.9.11');
  const b = clientFor(H2, '192.168.9.12');
  await a.login();
  await b.login();
  const ss = (await a.call('GET', '/api/sessions')).data.data.sessions;
  const other = ss.filter(s => !s.current)[0];
  assert.ok(other, '能看到另一台');
  const k = await a.call('POST', '/api/sessions/kick', { id: other.id });
  assert.strictEqual(k.status, 200, '踢掉成功');
  assert.strictEqual((await b.me()).data.user, null, '被踢的掉线了');
  assert.ok((await a.me()).data.user, '自己没受影响');
});

test('多设备时被踢，也要说得出原因', async () => {
  const a = clientFor(H2, '192.168.9.21');
  const b = clientFor(H2, '192.168.9.22');
  await a.login();
  await b.login();
  const ss = (await a.call('GET', '/api/sessions')).data.data.sessions;
  const other = ss.filter(s => !s.current)[0];
  await a.call('POST', '/api/sessions/kick', { id: other.id });
  const note = await b.note();
  assert.ok(note.data.reason, '被踢的也要能问出原因：' + JSON.stringify(note.data));
});

/* ══════════════════════════════════════════════════════════════════════
 * 客户端那一半：被顶下线时**界面要怎么做**
 *
 * 这些是结构断言，因为"被顶下线"在无头浏览器里不好端到端地测
 * （`--virtual-time-budget` + 长连接会让 dump-dom 不返回，踩过多次）。
 * 但坏掉的后果很实在：老师只会看到"页面突然不能用了"，
 * 以为系统坏了或被盗号了 —— 所以必须钉住。
 * ══════════════════════════════════════════════════════════════════════ */

test('被顶下线时：关掉实时连接、留下原因、跳到登录页', () => {
  const core = fs.readFileSync(path.join(ROOT, 'public', 'admin-core.js'), 'utf8');
  assert.ok(core.indexOf('function onKicked(') >= 0, 'admin-core 应当有被顶下线的处理');
  assert.ok(/handleKicked:\s*onKicked/.test(core), '要导出成 A.handleKicked（好测、也更明确）');
  const i = core.indexOf('function onKicked(');
  const body = core.slice(i, i + 1400);
  assert.ok(/S\.stream\.close|S\.stream && S\.stream\.close/.test(body),
    '要先关掉实时连接（会话都没了，继续挂着只会刷一堆 401）');
  assert.ok(body.indexOf("localStorage.setItem('sports.kicked'") >= 0,
    '要把原因留给登录页（跳转后还要显示）');
  assert.ok(/location\.replace\('\/login/.test(body), '最后要跳到登录页');
  // 只处理一次：bye 和轮询可能同时报到
  assert.ok(/if \(kicked\) return/.test(body), '要防重复处理');
});

test('实时通道要认服务端的 bye（原来直接忽略了，导致一直默默重连）', () => {
  const common = fs.readFileSync(path.join(ROOT, 'public', 'common.js'), 'utf8');
  assert.ok(common.indexOf("msg.type === 'bye'") >= 0,
    '要处理 bye 消息 —— 原来服务端发了、客户端不看，被顶下线只会一直重连');
  const i = common.indexOf("msg.type === 'bye'");
  const body = common.slice(i, i + 700);
  assert.ok(body.indexOf('onBye') >= 0, 'bye 要转交给上层处理');
  assert.ok(/es\.close\(\)/.test(body), '收到 bye 要关掉连接，别再重连');
  assert.ok(/clearInterval\(watchdog\)/.test(body), '还要停掉心跳看门狗');
  assert.ok(/stopPolling\(\)/.test(body), '也要停掉轮询');
  // 签名要能收第四个参数
  assert.ok(/App\.stream = function \(kind, onData, onStatus, onBye\)/.test(common),
    'App.stream 要接受 onBye 参数');
});

test('后台把 bye 接上处理函数，并且有兜底轮询', () => {
  const core = fs.readFileSync(path.join(ROOT, 'public', 'admin-core.js'), 'utf8');
  assert.ok(/App\.stream\('admin',[\s\S]{0,200}?setConn,\s*onKicked\)/.test(core),
    "App.stream('admin', …) 要把 onKicked 作为第四个参数传进去");
  assert.ok(core.indexOf('/api/session/note') >= 0,
    '还要有兜底：定期问一句"我这条会话还在吗"（SSE 断掉时靠它）');
});

test('登录页要显示"被顶下线"的原因，且不能重复唠叨', () => {
  const login = fs.readFileSync(path.join(ROOT, 'public', 'login.js'), 'utf8');
  assert.ok(login.indexOf("localStorage.getItem('sports.kicked')") >= 0,
    '登录页要读后台留下的原因');
  assert.ok(/removeItem\('sports\.kicked'\)/.test(login),
    '显示过就要清掉，否则刷新一次弹一次');
  assert.ok(login.indexOf('invalidReason') >= 0,
    '页面直接刷新时，要靠 /api/me 的 invalidReason 拿到原因');
  /* 原因那句话本身已经写全了（谁顶的、哪个 IP、该怎么办），
     登录页别再重复一遍"多人一起录…" —— 我第一版就重复了。 */
  const i = login.indexOf('if (kicked) {');
  const body = login.slice(i, i + 260);
  assert.strictEqual(/多人一起录成绩/.test(body), false,
    '登录页不该再重复"多人一起录…"（原因里已经说过了）');
});
