'use strict';
/* ============================================================================
 * sessions.test.js —— 「多地登录看得见、能踢」的验收
 *
 * 【为什么单独测这个】
 *   这套系统**故意允许同一账号在多台设备、多个地点同时登录**，而且会话不绑 IP
 *   —— 现场一个操作员可能手机录成绩、电脑看名单，绑 IP 会把人误踢下线。
 *   代价是账号被盗后从别处登录，界面上原来只显示一个"在线"，看不出异常。
 *
 *   新加的这两个接口就是补这个洞。它有几个**很容易写错、而且错了很危险**的点，
 *   每一条都值得一个断言：
 *     · 不能把自己当前这条会话踢掉（否则等于"踢人把管理员自己踢下线"）
 *     · 踢掉一条不能影响同账号的其它会话（否则"单独踢"就变成了"全踢"）
 *     · 非管理员不能看/踢别人的会话
 *     · 踢掉之后那条会话真的失效（不是只从列表里消失）
 *     · 踢人要留审计（谁在什么时候踢了谁、从哪个 IP）
 *
 * 运行：node --no-warnings --test test/sessions.test.js
 *
 * ⚠ 现在的默认规则是**一个账号只能在一台设备上登录**（新登录顶掉旧的，
 *   见 config.js 的 allowMultiDeviceLogin）。所以这个文件里显式把开关打开
 *   （ALLOW_MULTI_DEVICE_LOGIN=1），专门验"允许多设备"这套行为 ——
 *   包括各地登录都能看见、能单独踢掉某一处。
 *   "只能一台"那套行为在 single-session.test.js 里验。
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8486;
const PASS = 'admin123';
let mod = null;
let httpServer = null;
let base = '';
let dataDir = '';
const openAborts = [];

function startServer() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  process.env.DATA_DIR = dataDir;
  process.env.PORT = String(PORT);
  process.env.HOST = '127.0.0.1';
  process.env.SPORTS_ADMIN_PASSWORD = PASS;
  process.env.SPORTS_ADMIN_USER = 'admin';
  /* 这个文件专门验"允许多设备"那套（多地可见、单独踢）；
     "只能一台"在 single-session.test.js 里验。 */
  process.env.ALLOW_MULTI_DEVICE_LOGIN = '1';
  delete process.env.SEED_DEMO;
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf(ROOT) === 0 && k.indexOf('node_modules') < 0) delete require.cache[k];
  }
  mod = require(path.join(ROOT, 'server.js'));
  mod.initData();
  httpServer = mod.server;
  return new Promise((resolve) => {
    if (httpServer.listening) return resolve();
    httpServer.listen(PORT, '127.0.0.1', resolve);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    openAborts.forEach((a) => { try { a.abort(); } catch (e) { /* ignore */ } });
    openAborts.length = 0;
    try { mod.stopTimers(); } catch (e) { /* ignore */ }
    const done = () => {
      try { const d = mod.getDb(); if (d) d.close(); } catch (e) { /* ignore */ }
      setTimeout(() => {
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        resolve();
      }, 200);
    };
    try {
      if (httpServer && httpServer.listening) httpServer.close(done); else done();
    } catch (e) { done(); }
  });
}

/**
 * 一个客户端。可以指定"假装来自哪个 IP"（X-Forwarded-For）——
 * 用来造出"同一账号从多个 IP 登录"的场景。
 */
function makeClient(fakeIp) {
  let cookie = '';
  let csrf = '';
  return {
    get cookie() { return cookie; },
    get sid() { return cookie.replace(/^sports_sid=/, ''); },
    async call(method, url, body, opts) {
      const o = opts || {};
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
    async login(u, p) {
      const r = await this.call('POST', '/api/login', {
        username: u === undefined ? 'admin' : u,
        password: p === undefined ? PASS : p,
      });
      if (r.data && r.data.csrf) csrf = r.data.csrf;
      return r;
    },
    sessions(userId) {
      return this.call('GET', '/api/sessions' + (userId ? ('?userId=' + userId) : ''));
    },
    kick(id) {
      return this.call('POST', '/api/sessions/kick', { id });
    },
    op(op, payload) {
      return this.call('POST', '/api/op', {
        op, payload, clientUuid: 'ss-' + Math.random().toString(36).slice(2),
      });
    },
  };
}

test.before(async () => {
  base = 'http://127.0.0.1:' + PORT;
  await startServer();
});
test.after(async () => { await stopServer(); });

/* ══ ① 多地登录看得见 ═══════════════════════════════════════════════════ */

test('同一账号从多个 IP 登录：会话列表里全都在，且标出"当前这条"', async () => {
  const a = makeClient('203.0.113.1');
  const b = makeClient('203.0.113.2');
  const c = makeClient('198.51.100.7');
  assert.strictEqual((await a.login()).status, 200, 'A 登录');
  assert.strictEqual((await b.login()).status, 200, 'B 登录');
  assert.strictEqual((await c.login()).status, 200, 'C 登录');

  const r = await a.sessions();
  assert.strictEqual(r.status, 200, '会话接口可用');
  const ss = r.data.data.sessions;
  assert.strictEqual(ss.length, 3, '三个地方登录 → 列表里三条（实际 ' + ss.length + '）');

  const ips = ss.map(s => s.ip).sort();
  assert.deepStrictEqual(ips, ['198.51.100.7', '203.0.113.1', '203.0.113.2'].sort(),
    '三条会话的 IP 都在：' + JSON.stringify(ips));

  const mine = ss.filter(s => s.current);
  assert.strictEqual(mine.length, 1, '有且只有一条被标成"当前"');
  assert.strictEqual(mine[0].ip, '203.0.113.1', '标成当前的那条就是 A 自己的 IP');

  // 每条都要有给界面看的东西
  ss.forEach((s) => {
    assert.ok(s.ip, '要有 ip');
    assert.ok(s.agent, '要有设备说明');
    assert.ok(s.lastSeenAt, '要有最后活跃时间');
    assert.ok(s.createdAt, '要有登录时间');
    assert.strictEqual(typeof s.newIp, 'boolean', '要有 newIp 标记');
    assert.ok(s.id && s.id.length > 10, '要有会话 id');
  });
});

test('账号列表直接给出"会话数 / 不同 IP 数"，不用点开也知道是多地登录', async () => {
  const a = makeClient('203.0.113.1');
  await a.login();
  const r = await a.call('GET', '/api/users');
  assert.strictEqual(r.status, 200, '账号列表可用');
  const admin = (r.data.data.users || []).find(u => u.username === 'admin');
  assert.ok(admin, '能找到 admin');
  assert.ok(admin.sessionCount >= 3, 'admin 的会话数 ≥3（实际 ' + admin.sessionCount + '）');
  assert.ok(admin.ipCount >= 3, 'admin 的不同 IP 数 ≥3（实际 ' + admin.ipCount + '）');
  assert.strictEqual(admin.online, true, 'online 仍然是 true');
});

test('从没登录过的 IP 会被标成 newIp（列表上标黄靠它）', async () => {
  const a = makeClient('203.0.113.1');
  await a.login();
  // 换一个从没用过的 IP 登录
  const fresh = makeClient('192.0.2.99');
  assert.strictEqual((await fresh.login()).status, 200, '新 IP 登录');
  const r = await fresh.sessions();
  const ss = r.data.data.sessions;
  const newOne = ss.filter(s => s.ip === '192.0.2.99')[0];
  assert.ok(newOne, '新 IP 的会话在列表里');
  assert.strictEqual(newOne.newIp, true, '它应当被标成"这个 IP 以前没登录过"');
  // 老 IP 不该被标新
  const oldOne = ss.filter(s => s.ip === '203.0.113.1')[0];
  if (oldOne) assert.strictEqual(oldOne.newIp, false, '老 IP 不该被标新');
});

/* ══ ② 踢人：精确、安全 ═════════════════════════════════════════════════ */

test('踢掉一处：那一处真的失效，**其它会话不受影响**', async () => {
  const a = makeClient('203.0.113.11');
  const b = makeClient('203.0.113.12');
  await a.login();
  await b.login();
  const bSid = b.sid;

  // A 看列表，找到 B 那条并踢掉
  const before = (await a.sessions()).data.data.sessions;
  const target = before.filter(s => s.ip === '203.0.113.12')[0];
  assert.ok(target, '列表里能找到 B 的会话');
  assert.strictEqual(target.current, false, 'B 的会话不是 A 的当前会话');

  const k = await a.kick(target.id);
  assert.strictEqual(k.status, 200, '踢人成功：' + JSON.stringify(k.data).slice(0, 120));

  // B 那条真的失效了（不是只从列表消失）
  const bAfter = await b.call('GET', '/api/me');
  assert.strictEqual(bAfter.data.user, null, 'B 应当已经掉线（user 为 null）');

  // A 自己还能用
  const aAfter = await a.call('GET', '/api/me');
  assert.ok(aAfter.data.user, 'A 自己没被影响');
  assert.strictEqual(aAfter.data.user.username, 'admin', 'A 还是 admin');

  // B 那条从列表里也没了，A 那条还在
  const after = (await a.sessions()).data.data.sessions;
  assert.strictEqual(after.filter(s => s.ip === '203.0.113.12').length, 0, '被踢的那条不在列表里了');
  assert.strictEqual(after.filter(s => s.ip === '203.0.113.11').length, 1, 'A 那条还在');
  void bSid;
});

test('不许踢自己当前这条会话（否则等于"踢人把管理员自己踢下线"）', async () => {
  const a = makeClient('203.0.113.21');
  await a.login();
  const ss = (await a.sessions()).data.data.sessions;
  const mine = ss.filter(s => s.current)[0];
  assert.ok(mine, '找到自己的会话');
  const r = await a.kick(mine.id);
  assert.strictEqual(r.status, 400, '踢自己必须被拒（实际 ' + r.status + '）');
  assert.strictEqual(r.data.code, 'SELF', '拒绝原因应当是 SELF');
  assert.ok(/退出/.test(r.data.message || ''), '提示里要告诉人"要退出请点退出"：' + r.data.message);
  // 自己还活着
  const me = await a.call('GET', '/api/me');
  assert.ok(me.data.user, '自己没被踢下线');
});

test('踢一个不存在的会话：给明确的 404，不报 500', async () => {
  const a = makeClient('203.0.113.31');
  await a.login();
  const r = await a.kick('ses_根本不存在的id');
  assert.strictEqual(r.status, 404, '应当是 404');
  assert.ok(/不存在|退出/.test(r.data.message || ''), '要有能看懂的话：' + r.data.message);
});

/* ══ ③ 权限 ═════════════════════════════════════════════════════════════ */

test('操作员只能看/踢自己的会话，看别人的一律 403 或只看到自己的', async () => {
  const adm = makeClient('203.0.113.41');
  await adm.login();
  const mk = await adm.op('user.add', {
    username: 'op1', password: 'op123456', role: 'operator', displayName: '操作员甲',
  });
  assert.strictEqual(mk.status, 200, '建操作员账号：' + JSON.stringify(mk.data).slice(0, 120));

  const op = makeClient('203.0.113.42');
  assert.strictEqual((await op.login('op1', 'op123456')).status, 200, '操作员登录');

  // 操作员不传 userId → 只看到自己的
  const own = await op.sessions();
  assert.strictEqual(own.status, 200, '操作员能看自己的会话');
  assert.ok(own.data.data.sessions.length >= 1, '至少有自己这条');
  assert.strictEqual(own.data.data.canKickOthers, false, '不应当允许他踢别人');

  // 操作员想看管理员的 → 拿到的应当还是自己的（服务端忽略 userId）
  const admUser = (await adm.call('GET', '/api/users')).data.data.users.find(u => u.username === 'admin');
  const peek = await op.sessions(admUser.id);
  assert.strictEqual(peek.status, 200, '请求本身不报错');
  assert.strictEqual(peek.data.data.user.username, 'op1',
    '非管理员传别人的 userId 时，只能拿到自己的（实际拿到 ' + peek.data.data.user.username + '）');

  // 操作员想踢管理员的会话 → 403
  const admSess = (await adm.sessions()).data.data.sessions;
  const victim = admSess.filter(s => !s.current)[0] || admSess[0];
  const forbidden = await op.kick(victim.id);
  assert.strictEqual(forbidden.status, 403, '操作员踢别人的会话必须 403（实际 ' + forbidden.status + '）');
  assert.ok(/只能/.test(forbidden.data.message || ''), '提示要说明只能踢自己的：' + forbidden.data.message);
});

test('操作员能踢掉自己的另一处登录（手机上忘了退，应该能自己处理）', async () => {
  const op1 = makeClient('203.0.113.51');
  const op2 = makeClient('203.0.113.52');
  await op1.login('op1', 'op123456');
  await op2.login('op1', 'op123456');

  const ss = (await op1.sessions()).data.data.sessions;
  const other = ss.filter(s => !s.current)[0];
  assert.ok(other, '应当能看到另一处登录');
  const r = await op1.kick(other.id);
  assert.strictEqual(r.status, 200, '踢自己的另一处应当成功：' + JSON.stringify(r.data).slice(0, 120));
  const gone = await op2.call('GET', '/api/me');
  assert.strictEqual(gone.data.user, null, '被踢的那处掉线了');
});

/* ══ ④ 留下痕迹 ════════════════════════════════════════════════════════ */

test('踢人写进操作记录：是谁、踢了哪个 IP、什么时候', async () => {
  const a = makeClient('203.0.113.61');
  const b = makeClient('203.0.113.62');
  await a.login();
  await b.login();
  const target = (await a.sessions()).data.data.sessions.filter(s => s.ip === '203.0.113.62')[0];
  assert.ok(target, '找到 B 的会话');
  assert.strictEqual((await a.kick(target.id)).status, 200, '踢成功');

  const d = mod.getDb();
  const rows = d.all(`SELECT action, target, detail, userName, ip FROM auditLog
                      WHERE action = 'session.kick' ORDER BY rowid DESC LIMIT 1`, []);
  assert.strictEqual(rows.length, 1, '应当有一条 session.kick 的审计');
  const r = rows[0];
  assert.ok(r.userName, '要记下是谁踢的');
  assert.ok(r.detail && r.detail.indexOf('203.0.113.62') >= 0,
    '说明里要带上被踢的 IP：' + r.detail);
  assert.ok(r.detail.indexOf('踢掉') >= 0, '说明要是人话：' + r.detail);
});

/* ══ ⑤ 踢掉会话要连带断开实时连接 ═════════════════════════════════════ */

/* ══ ⑥ 界面那层：两个"静默失效"的坑 ═══════════════════════════════════
 *
 * 下面两条是**在真实浏览器里点出来的**，纯接口测试发现不了 ——
 * 服务端全都正常，坏的是客户端：动作做成了、提示也弹了，
 * 但用户看到的还是旧界面（或者压根没发出请求）。
 * 因为完全没有任何报错，特别隐蔽，必须留断言钉住。
 */

test('账号页的"登录情况"弹窗不会把 ask 依赖的输入框弄没', () => {
  /* 【背景】我第一版"在线会话"弹窗是借 A.ask 的壳：ask() 打开、然后
     clear(askField) 塞自己的内容。结果把 `#askInput` 从文档里删了，
     而 ask() 在点"确定"时会读 `input.value` →
     `Cannot read properties of null (reading 'value')` →
     **整个踢人流程静默中断**（弹窗关了、请求一个都没发、连报错都没有）。
     所以现在改成 A.modal 提供画布，且明确保证输入框留在文档里。 */
  const core = fs.readFileSync(path.join(ROOT, 'public', 'admin-core.js'), 'utf8');
  assert.ok(core.indexOf('function modal(') >= 0, 'admin-core 应当提供 A.modal（自定义弹窗）');
  assert.ok(/modal,\s*$/m.test(core) || /\bmodal,/.test(core), 'A.modal 要导出给 admin-misc 用');
  // 画布是"插在输入框前面"，不能把输入框搬走或删掉
  assert.ok(core.indexOf("field.insertBefore(canvas, input)") >= 0,
    '画布必须插在输入框前面（输入框要留在原处）');
  assert.strictEqual(/field\.removeChild\(input\)|input\.remove\(\)/.test(core), false,
    '代码里不该有"把输入框从弹窗里删掉"的写法');
  // 借壳（suspend）模式不能清空画布，否则外层内容被抹掉
  assert.ok(core.indexOf('if (!o.suspend) { clear(canvas); canvas.hidden = false; }') >= 0,
    'suspend 模式必须保留画布里的内容');

  const misc = fs.readFileSync(path.join(ROOT, 'public', 'admin-misc.js'), 'utf8');
  const i = misc.indexOf('function showSessions(');
  assert.ok(i >= 0, 'admin-misc 应当有 showSessions');
  const body = misc.slice(i, i + 4000);
  assert.ok(body.indexOf('A.modal(') >= 0, 'showSessions 应当用 A.modal 画自己的弹窗');
  assert.strictEqual(/clear\(body\)/.test(body), false,
    'showSessions 不能去清 askField（那会把 askInput 删掉，正是原来的 bug）');
  assert.strictEqual(/clear\(el\('askField'\)\)/.test(misc), false,
    '任何地方都不该 clear(askField)');
});

test('借壳还原要用"活节点"而不是 innerHTML（否则外层列表更新写进脱离文档的角落）', () => {
  /* 【背景】踢人其实**成功了**（库里那条会话真没了、审计也写了、toast 也弹了），
     但弹窗里显示的还是"踢之前"的列表。原因：suspend 用 innerHTML 保存/还原画布，
     还原时把节点**重建**了一遍，而 paint() 还握着旧节点的引用，
     它之后的清空/重画全写进了不在文档里的元素上。
     表现是"看起来没踢掉"——比报错更坑，因为它让人以为功能坏了。 */
  const core = fs.readFileSync(path.join(ROOT, 'public', 'admin-core.js'), 'utf8');
  assert.ok(/canvasEl:\s*myCanvas/.test(core),
    'suspend 应当保存**画布元素本身**');
  assert.ok(core.indexOf('replaceChild(saved.canvasEl, cur)') >= 0,
    '还原时应当把活着的画布节点搬回去');
  assert.strictEqual(/canvas\.innerHTML = saved\.canvas/.test(core), false,
    '不该再用 innerHTML 还原画布（会把节点重建，引用失效）');
});

test('审计记录带上会话 id，让"这个 IP 以前登录过吗"能问准', async () => {
  /* 这条是给 newIp 判定兜底的：
     排除"本次登录自己写的那条记录"必须靠 sessionId，
     靠时间戳比较会踩"同一毫秒"和"加了余量又误判"两个坑（都真踩过）。 */
  const a = makeClient('203.0.113.81');
  await a.login();
  const d = mod.getDb();
  const row = d.get(`SELECT sessionId, ip, action FROM auditLog
                     WHERE action = 'user.login' ORDER BY rowid DESC LIMIT 1`, []);
  assert.ok(row, '应当有登录审计');
  assert.ok(row.sessionId, '登录审计要记下会话 id（实际 ' + JSON.stringify(row.sessionId) + '）');
  assert.strictEqual(row.ip, '203.0.113.81', 'IP 也要记对');
  // 这条 sessionId 应当就是当前会话
  const mine = (await a.sessions()).data.data.sessions.filter(s => s.current)[0];
  assert.strictEqual(row.sessionId, mine.id, '审计里的会话 id 应当就是当前这条会话');
});


/* ══ ⑦ 踢掉会话要连带断开实时连接 ═════════════════════════════════════ */

test('踢掉一处之后，那一处的实时连接也必须断（不能还在收数据）', async () => {
  const a = makeClient('203.0.113.71');
  const b = makeClient('203.0.113.72');
  await a.login();
  await b.login();

  const got = [];
  const ctrl = new AbortController();
  openAborts.push(ctrl);
  let closed = false;
  const streamP = fetch(base + '/api/stream/admin', {
    headers: { Cookie: b.cookie }, signal: ctrl.signal,
  }).then(async (res) => {
    const rd = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await rd.read();
      if (done) { closed = true; break; }
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ln = chunk.split('\n').find(l => l.indexOf('data: ') === 0);
        if (ln) { try { got.push(JSON.parse(ln.slice(6))); } catch (e) { /* ignore */ } }
      }
    }
  }).catch(() => { /* abort 正常 */ });

  await new Promise(r => setTimeout(r, 500));
  const nBefore = got.length;
  assert.ok(nBefore >= 1, 'B 的实时通道建起来了');

  // A 踢掉 B
  const target = (await a.sessions()).data.data.sessions.filter(s => s.ip === '203.0.113.72')[0];
  assert.ok(target, '找到 B 的会话');
  assert.strictEqual((await a.kick(target.id)).status, 200, '踢成功');
  await new Promise(r => setTimeout(r, 600));

  // 触发一次推送，看 B 还会不会收到
  const snap = await a.call('GET', '/api/snapshot?kind=admin');
  await mod.pushAll();
  void snap;
  await new Promise(r => setTimeout(r, 1200));
  ctrl.abort();
  await streamP.catch(() => {});

  const after = got.slice(nBefore);
  const snapshots = after.filter(m => m.type === 'snapshot' || m.type === 'hello');
  assert.strictEqual(snapshots.length, 0,
    '被踢之后不该再收到数据（收到 ' + JSON.stringify(after.map(m => m.type)) + '）');
  assert.strictEqual(closed, true, '服务端应当主动关掉了这条连接');
});
