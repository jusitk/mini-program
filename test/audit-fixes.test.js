'use strict';
/* ============================================================================
 * audit-fixes.test.js —— 针对《运动会系统检查与改进建议》里 9 条缺陷的回归测试
 *
 * 【这个文件的意义】那份审计报告是外部做的，它对**另一份代码副本**下的结论。
 * 我先在当前这份代码上逐条实测复现（9 条全部成立），改完之后在这里
 * 给每条都留一个"能复现原缺陷"的断言 —— 以后谁改动碰坏了，这里会红。
 *
 * 每条测试的名字里都写了"原来会怎样"，方便日后看懂为什么要有它。
 *
 * 全部用临时数据目录 + 合成数据，**不碰真实库**。
 * 运行：node --no-warnings --test test/audit-fixes.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8485;
const PASS = 'admin123';
let mod = null;
let httpServer = null;
let base = '';
let dataDir = '';
let admin = null;
let seeded = null;
const openAborts = [];

function startServer() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-'));
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
  httpServer = mod.server;
  return new Promise((resolve) => {
    if (httpServer.listening) return resolve();
    httpServer.listen(PORT, '127.0.0.1', resolve);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    // 先兜底掐掉所有还挂着的长连接，否则 close() 会一直等
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

function makeClient() {
  let cookie = '';
  let csrf = '';
  return {
    get cookie() { return cookie; },
    get csrf() { return csrf; },
    async call(method, url, body, opts) {
      const o = opts || {};
      const headers = { Accept: 'application/json' };
      if (cookie) headers.Cookie = cookie;
      if (o.cookie) headers.Cookie = o.cookie;
      let payload;
      if (body !== undefined && o.raw) {
        /* 【上传必须用这种发法】接口读的是**请求体的原始字节**，
           文件类型靠 Content-Type 头说明（见 server.js 的 /api/upload）。
           ⚠ 千万别用 FormData：那会把 multipart 边界一起当文件内容，
           服务端收到的就不是文件本身了 —— 我第一版就是这样，
           结果"正常 PNG 也被拒"，白查了半天。 */
        payload = body;
        headers['Content-Type'] = o.mime || 'application/octet-stream';
      } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      if (csrf && method !== 'GET' && !o.noCsrf) headers['X-CSRF'] = csrf;
      const r = await fetch(base + url, { method, headers, body: payload });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
      return { status: r.status, headers: r.headers, data };
    },
    async login(u, p) {
      const r = await this.call('POST', '/api/login', {
        username: u === undefined ? 'admin' : u,
        password: p === undefined ? PASS : p,
      });
      if (r.data && r.data.csrf) csrf = r.data.csrf;
      return r;
    },
    op(op, payload) {
      return this.call('POST', '/api/op', {
        op, payload, clientUuid: 'af-' + Math.random().toString(36).slice(2),
      });
    },
    async snap(kind) {
      const r = await this.call('GET', '/api/snapshot?kind=' + (kind || 'admin'));
      return r.data;
    },
    async roster() {
      const r = await this.call('GET', '/api/roster?limit=2000');
      return (r.data && r.data.data && r.data.data.athletes) || [];
    },
  };
}

async function seedData(c) {
  const g = await c.op('group.add', { name: '审计用组', kind: 'male' });
  const snap0 = await c.snap();
  const gid = (snap0.groups || [])[0].id;
  const evR = await c.op('event.add', {
    name: '审计·跳远', groupId: gid, kind: 'field', stage: 'final', attempts: 3,
  });
  const evId = evR.data.data.id;
  const athletes = [];
  for (let i = 0; i < 4; i++) {
    const r = await c.op('athlete.add', {
      name: '审计选手' + (i + 1), bib: '3' + String(i + 1).padStart(3, '0'),
      groupId: gid, grade: '高一', className: '1班',
    });
    athletes.push(r.data.data.id);
    await c.op('reg.add', { eventId: evId, athleteId: r.data.data.id });
  }
  return { gid, evId, athletes };
}

test.before(async () => {
  base = 'http://127.0.0.1:' + PORT;
  await startServer();
  admin = makeClient();
  const lr = await admin.login();
  assert.strictEqual(lr.status, 200, '管理员登录应当成功');
  seeded = await seedData(admin);
});

test.after(async () => { await stopServer(); });

/* ══ 缺陷 2：只读账号可清空管理员暂存 ══════════════════════════════════ */

test('缺陷2 回归：只读账号不能删/清空暂存，也读不到暂存内容', async () => {
  // 建一个只读账号（账号名要 ≥3 位、口令要 ≥6 位且不能全是数字）
  const u = await admin.op('user.add', {
    username: 'viewer1', password: 'viewer12345', role: 'viewer', displayName: '只读甲',
  });
  assert.strictEqual(u.status, 200, '建只读账号应当成功：' + JSON.stringify(u.data).slice(0, 140));
  const v = makeClient();
  const lr = await v.login('viewer1', 'viewer12345');
  assert.strictEqual(lr.status, 200, '只读账号应当能登录');

  // 管理员暂存一条
  const st = await admin.call('POST', '/api/staged', {
    op: 'athlete.update', payload: { id: seeded.athletes[0], name: '只读不该动我' },
  });
  assert.strictEqual(st.status, 200, '管理员暂存应当成功');
  const before = await admin.call('GET', '/api/staged');
  assert.ok(before.data.data.items.length >= 1, '暂存区里应当有 1 条');

  // 原来：只读账号 POST /api/staged/drop 会返回 200 且真删掉
  const drop = await v.call('POST', '/api/staged/drop', { all: true });
  assert.strictEqual(drop.status, 403, '只读清空暂存必须 403（原来返回 200 并真删了）');
  const after = await admin.call('GET', '/api/staged');
  assert.strictEqual(after.data.data.items.length, before.data.data.items.length,
    '暂存条数不该变（原来会被清空）');

  // 顺便：暂存列表的读取也要管理员（原来只读能看到管理操作的载荷）
  const peek = await v.call('GET', '/api/staged');
  assert.strictEqual(peek.status, 403, '只读不该读得到暂存内容');

  // 撤销单条同样要管理员
  const dropOne = await v.call('POST', '/api/staged/drop', { id: before.data.data.items[0].id });
  assert.strictEqual(dropOne.status, 403, '只读撤销单条也必须 403');

  // 管理员自己仍然能清
  const okDrop = await admin.call('POST', '/api/staged/drop', { all: true });
  assert.strictEqual(okDrop.status, 200, '管理员清空暂存应当成功');
});

/* ══ 缺陷 3：附件上传 ═══════════════════════════════════════════════════ */

test('缺陷3 回归：只读不能上传；HTML/SVG 一律拒收；改扩展名也拦得住', async () => {
  const v = makeClient();
  const vlr = await v.login('viewer1', 'viewer12345');
  assert.strictEqual(vlr.status, 200, '只读账号应当能登录（否则下面的断言会误报成 401）');

  // ① 只读账号上传 → 403
  const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  const upViewer = await v.call('POST', '/api/upload?name=x.png', pngHead, { raw: true, mime: 'image/png' });
  assert.strictEqual(upViewer.status, 403, '只读账号不该能上传（原来能）');

  // ② HTML 直接拒收
  const upHtml = await admin.call('POST', '/api/upload?name=evil.html',
    Buffer.from('<html><body><script>alert(1)</script></body></html>'), { raw: true, mime: 'text/html' });
  assert.strictEqual(upHtml.status, 400, 'HTML 必须拒收（原来能传上去还能被匿名打开）');
  assert.strictEqual(upHtml.data && upHtml.data.code, 'BAD_FILE_TYPE', '拒收原因应当是文件类型');

  // ③ 把 HTML 内容改成 .png 传（改扩展名蒙混）
  const upFake = await admin.call('POST', '/api/upload?name=fake.png',
    Buffer.from('<html><body>hi</body></html>'), { raw: true, mime: 'image/png' });
  assert.strictEqual(upFake.status, 400, '内容不像 PNG 的必须拒收（挡改扩展名）');

  // ④ 真的 PNG（完整 8 字节 PNG 签名）应当能传
  const upOk = await admin.call('POST', '/api/upload?name=ok.png', pngHead, { raw: true, mime: 'image/png' });
  assert.strictEqual(upOk.status, 200, '正常 PNG 应当能传：' + JSON.stringify(upOk.data).slice(0, 140));
  assert.ok(upOk.data.data.url.indexOf('.png') > 0, '存盘扩展名由服务端决定');

  // ⑤ 响应必须带 nosniff + CSP sandbox（万一有漏网的也不至于当网页执行）
  const fetchIt = await fetch(base + upOk.data.data.url);
  assert.strictEqual(fetchIt.headers.get('x-content-type-options'), 'nosniff',
    '上传目录的响应必须带 nosniff');
  assert.ok(String(fetchIt.headers.get('content-security-policy') || '').indexOf('sandbox') >= 0,
    '上传目录的响应必须带 CSP sandbox');
  assert.strictEqual(fetchIt.headers.get('content-type'), 'image/png', '按白名单类型发');
});

/* ══ 语音功能已去掉（浏览器要求麦克风跑在安全上下文，局域网 HTTP 用不了）══ */

test('语音已去掉：音频文件收不了、audio 类型消息也进不来', async () => {
  /* 【为什么锁住这个】语音在局域网 HTTP 下根本用不了（getUserMedia 要安全上下文），
     与其留一个按下去只会弹错的按钮，不如不做。这里用测试把"不做语音"钉住，
     免得以后有人顺手又加回来、现场才发现手机上用不了。 */

  // ① 上传接口只收图片：mp3/wav/webm 一律拒
  const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00]);   // 'ID3'
  const upMp3 = await admin.call('POST', '/api/upload?name=a.mp3', mp3, { raw: true, mime: 'audio/mpeg' });
  assert.strictEqual(upMp3.status, 400, 'mp3 必须拒收（语音已去掉）');
  assert.strictEqual(upMp3.data && upMp3.data.code, 'BAD_FILE_TYPE', '拒收原因应当是文件类型');

  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);
  const upWebm = await admin.call('POST', '/api/upload?name=a.webm', webm, { raw: true, mime: 'audio/webm' });
  assert.strictEqual(upWebm.status, 400, 'webm 也必须拒收');

  const wav = Buffer.from('RIFF....WAVEfmt ', 'binary');
  const upWav = await admin.call('POST', '/api/upload?name=a.wav', wav, { raw: true, mime: 'audio/wav' });
  assert.strictEqual(upWav.status, 400, 'wav 也必须拒收');

  // ② 消息类型里没有 audio：硬塞会被当成 text（不会存成 audio）
  const msg = await admin.call('POST', '/api/op', {
    op: 'chat.send',
    payload: { text: '假装是语音', kind: 'audio' },
    clientUuid: 'voice-' + Math.random().toString(36).slice(2),
  });
  assert.strictEqual(msg.status, 200, '发消息本身应当成功');
  assert.strictEqual(msg.data.data.kind, 'text',
    'kind=audio 会被降级成 text（原来能存成 audio，前端就按语音渲染）');

  // ③ 前端源码里不该再有录音相关的 API 调用
  const src = fs.readFileSync(path.join(ROOT, 'public', 'admin-misc.js'), 'utf8');
  /* getUserMedia 只允许出现在**注释**里（用来解释"为什么不做语音"）。
     这里真的要跟一下块注释状态 —— 我第一版只判"这一行是不是以 * 开头"，
     结果块注释里的一行普通文字被当成了代码（那行确实不以 * 开头）。 */
  let inBlock = false;
  src.split('\n').forEach((line, i) => {
    const wasInBlock = inBlock;
    // 先更新块注释状态（粗糙但够用：这一行里出现 /* 就进入，出现 */ 就退出）
    const open = line.indexOf('/*');
    const close = line.indexOf('*/');
    if (!inBlock && open >= 0 && (close < 0 || close < open)) inBlock = true;
    else if (inBlock && close >= 0) inBlock = false;

    const idx = line.indexOf('getUserMedia');
    if (idx < 0) return;
    const t = line.trim();
    const lineComment = t.indexOf('//') === 0 || t.indexOf('*') === 0;
    const isComment = wasInBlock || inBlock || lineComment;
    assert.ok(isComment,
      'admin-misc.js:' + (i + 1) + ' getUserMedia 只能在注释里出现，实际是代码：' + t.slice(0, 80));
  });
  assert.strictEqual(/new\s+MediaRecorder\s*\(/.test(src), false, '不该再 new MediaRecorder');
  assert.strictEqual(/navigator\.mediaDevices/.test(src), false, '不该再碰 navigator.mediaDevices');
  assert.ok(src.indexOf("accept: 'image/*'") >= 0, '文件选择框只接受图片');
  assert.strictEqual(src.indexOf('audio/*'), -1, '不该再接受 audio/* 类型');
});

/* ══ 缺陷 6：试跳次数 ═══════════════════════════════════════════════════ */

test('缺陷6 回归：三次试跳录不进第四次；0/负数/小数/超大一律拒绝', async () => {
  const evId = seeded.evId;
  const aid = seeded.athletes[0];

  // 1~3 次可以
  for (const at of [1, 2, 3]) {
    const r = await admin.op('result.set', { eventId: evId, athleteId: aid, attempt: at, value: '5.0' });
    assert.strictEqual(r.status, 200, '第 ' + at + ' 次应当能录');
  }
  // 第 4 次必须拒（原来能录进去，而且会参与排名）
  const r4 = await admin.op('result.set', { eventId: evId, athleteId: aid, attempt: 4, value: '9.99' });
  assert.strictEqual(r4.status, 400, '第 4 次必须被拒（原来返回 200/created）');
  assert.strictEqual(r4.data.code, 'BAD_ATTEMPT', '拒绝原因应当是次数越界');

  // 0 / -1 / 1.5 / 99 全部拒（原来被 clamp 成 1 或直接收下）
  for (const at of [0, -1, 1.5, 99, 'abc']) {
    const r = await admin.op('result.set', { eventId: evId, athleteId: aid, attempt: at, value: '5.0' });
    assert.strictEqual(r.status, 400, 'attempt=' + at + ' 必须被拒（原来 0/-1/1.5/99 都被收下）');
  }

  // 越界的那次没有落库（否则会算进最好成绩）
  const snap = await admin.snap();
  const ev = snap.events.filter(e => e.id === evId)[0];
  assert.ok(ev, '项目还在');
  const d = mod.getDb();
  const n = d.get('SELECT COUNT(*) c FROM result WHERE eventId = ? AND attempt > 3', [evId]).c;
  assert.strictEqual(n, 0, '库里不该有超出次数的成绩行');
});

test('缺陷6 回归：减少试跳次数时，超出范围的历史成绩会被清掉并告知', async () => {
  const r = await admin.op('event.add', {
    name: '审计·六次试跳', groupId: seeded.gid, kind: 'field', stage: 'final', attempts: 6,
  });
  const eid = r.data.data.id;
  const aR = await admin.op('athlete.add', {
    name: '试跳乙', bib: '3999', groupId: seeded.gid, grade: '高一', className: '1班',
  });
  const aid = aR.data.data.id;
  await admin.op('reg.add', { eventId: eid, athleteId: aid });
  for (const at of [1, 2, 3, 4, 5, 6]) {
    const x = await admin.op('result.set', { eventId: eid, athleteId: aid, attempt: at, value: '4.0' });
    assert.strictEqual(x.status, 200, '6 次项目第 ' + at + ' 次应当能录');
  }
  const d = mod.getDb();
  assert.strictEqual(d.get('SELECT COUNT(*) c FROM result WHERE eventId = ?', [eid]).c, 6, '应当是 6 条');

  // 改成 3 次 → 4/5/6 次的成绩必须清掉（原来只在改成 1 次时才清）
  const up = await admin.op('event.update', { id: eid, attempts: 3 });
  assert.strictEqual(up.status, 200, '改次数应当成功');
  assert.strictEqual(up.data.data.cleaned, 3, '应当报告清掉了 3 条超出的成绩');
  assert.strictEqual(d.get('SELECT COUNT(*) c FROM result WHERE eventId = ?', [eid]).c, 3,
    '超出范围的成绩必须被清掉（原来留着，还会参与最好成绩排名）');
});

/* ══ 缺陷 4：暂存确认的版本冲突 ═════════════════════════════════════════ */

test('缺陷4 回归：暂存之后别人改过同一条 → 确认被拒，不静默覆盖', async () => {
  const aid = seeded.athletes[1];
  // ① 暂存"改名成 A"
  const st = await admin.call('POST', '/api/staged', {
    op: 'athlete.update', payload: { id: aid, name: '暂存名A' },
  });
  assert.strictEqual(st.status, 200, '暂存应当成功');
  // ② 直接改（立即生效）成 B
  const direct = await admin.op('athlete.update', { id: aid, name: '直接名B' });
  assert.strictEqual(direct.status, 200, '直接改应当成功');

  // ③ 确认 → 必须 409，且名字保持"直接名B"
  const cf = await admin.call('POST', '/api/confirm', {});
  assert.strictEqual(cf.status, 409, '有冲突时确认必须被拒（原来返回 200 并静默覆盖）');
  assert.strictEqual(cf.data.code, 'STAGED_CONFLICT', '拒绝原因应当是暂存冲突');
  assert.ok(cf.data.data.conflicts && cf.data.data.conflicts.length >= 1, '要返回冲突明细');
  const c0 = cf.data.data.conflicts[0];
  assert.ok(c0.changed && c0.changed.length, '冲突里要写清是哪个字段');
  assert.strictEqual(String(c0.changed[0].current), '直接名B', '冲突里要带上"现在是什么值"');
  assert.strictEqual(String(c0.changed[0].staged), '审计选手2', '冲突里要带上"暂存时是什么值"');

  const ros = await admin.roster();
  const now = ros.filter(a => a.id === aid)[0];
  assert.strictEqual(now.name, '直接名B', '被拒之后名字不该被改（原来会变回暂存值）');

  // ④ 明确 force 才允许覆盖（保留人工决定的出口）
  const cf2 = await admin.call('POST', '/api/confirm', { force: true });
  assert.strictEqual(cf2.status, 200, 'force 确认应当成功');
  const ros2 = await admin.roster();
  assert.strictEqual(ros2.filter(a => a.id === aid)[0].name, '暂存名A',
    'force 之后才按暂存值覆盖');
});

test('缺陷4 回归：改的是**不同字段**时不该误判成冲突', async () => {
  const aid = seeded.athletes[2];
  // 暂存改号码
  await admin.call('POST', '/api/staged', {
    op: 'athlete.update', payload: { id: aid, bib: '8888' },
  });
  // 期间别人改的是**姓名**（不同字段）
  await admin.op('athlete.update', { id: aid, name: '别人改的名字' });
  const cf = await admin.call('POST', '/api/confirm', {});
  assert.strictEqual(cf.status, 200,
    '改不同字段不该算冲突（否则现场几十个人同时录入会天天"冲突"）');
  const ros = await admin.roster();
  const now = ros.filter(a => a.id === aid)[0];
  assert.strictEqual(now.bib, '8888', '号码应当按暂存值改了');
  assert.strictEqual(now.name, '别人改的名字', '姓名是别人改的，不该被覆盖');
});

/* ══ 缺陷 5：业务审计 ═══════════════════════════════════════════════════ */

test('缺陷5 回归：通过 /api/op 的改动会写审计，且能看出"从什么变成什么"', async () => {
  const d = mod.getDb();
  const before = d.get('SELECT COUNT(*) c FROM auditLog').c;

  const aR = await admin.op('athlete.add', {
    name: '审计丙', bib: '4001', groupId: seeded.gid, grade: '高一', className: '1班',
  });
  const aid = aR.data.data.id;
  await admin.op('athlete.update', { id: aid, name: '审计丁' });

  const after = d.get('SELECT COUNT(*) c FROM auditLog').c;
  assert.ok(after > before, '经 /api/op 的改动必须写审计（原来一行都不写）');

  const rows = d.all("SELECT action, target, beforeJson, afterJson, detail, userName FROM auditLog WHERE action = 'op.athlete.update' ORDER BY rowid DESC LIMIT 1", []);
  assert.strictEqual(rows.length, 1, '应当有一条 op.athlete.update 的审计');
  const r = rows[0];
  assert.ok(r.beforeJson && r.beforeJson.indexOf('审计丙') >= 0, '要记下改动前的值');
  assert.ok(r.afterJson && r.afterJson.indexOf('审计丁') >= 0, '要记下改动后的值');
  assert.ok(r.detail && r.detail.indexOf('审计丙') >= 0 && r.detail.indexOf('审计丁') >= 0,
    '说明里要有人话的前后值：' + r.detail);
  assert.ok(r.userName, '要记下是谁改的');

  // 成绩也要有审计（争议最多的地方）
  const rr = await admin.op('result.set', {
    eventId: seeded.evId, athleteId: seeded.athletes[0], attempt: 1, value: '6.66',
  });
  assert.strictEqual(rr.status, 200, '录成绩应当成功');
  const resAudit = d.all("SELECT action, detail FROM auditLog WHERE action = 'op.result.set' ORDER BY rowid DESC LIMIT 1", []);
  assert.strictEqual(resAudit.length, 1, '录成绩也要留审计（原来没有）');
});

test('缺陷5 回归：账号口令绝不能原样写进审计', async () => {
  const d = mod.getDb();
  await admin.op('user.add', {
    username: 'sec1', password: 'SecPass123456', role: 'operator', displayName: '保密测试',
  });
  const rows = d.all("SELECT beforeJson, afterJson, detail FROM auditLog WHERE action = 'op.user.add' ORDER BY rowid DESC LIMIT 1", []);
  assert.strictEqual(rows.length, 1, '建账号也要有审计（但口令不能进日志）');
  const blob = JSON.stringify(rows[0]);
  assert.strictEqual(blob.indexOf('SecPass123456'), -1, '口令不能出现在审计里');
  assert.ok(blob.indexOf('敏感字段') >= 0 || blob.indexOf('不记录') >= 0,
    '敏感字段要标成"已改，不记录"：' + blob.slice(0, 200));
});

/* ══ 缺陷 7：退出登录后 SSE 要失效 ═════════════════════════════════════ */

test('缺陷7 回归：退出登录后，原有的后台实时连接不再收到数据', async () => {
  const c = makeClient();
  await c.login();
  const got = [];
  const ctrl = new AbortController();
  openAborts.push(ctrl);
  let closed = false;
  const streamP = fetch(base + '/api/stream/admin', {
    headers: { Cookie: c.cookie }, signal: ctrl.signal,
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
  assert.ok(nBefore >= 1, '首包应当收到');

  await c.call('POST', '/api/logout', {});
  await new Promise(r => setTimeout(r, 400));

  // 触发推送
  await admin.op('group.update', { id: seeded.gid, name: '推送触发用' });
  await new Promise(r => setTimeout(r, 1500));
  ctrl.abort();
  await streamP.catch(() => {});

  const after = got.slice(nBefore);
  const snapshots = after.filter(m => m.type === 'snapshot' || m.type === 'hello');
  assert.strictEqual(snapshots.length, 0,
    '退出之后不该再收到任何数据（原来还会收到 snapshot；这次收到 ' + JSON.stringify(after.map(m => m.type)) + '）');
  const bye = after.filter(m => m.type === 'bye');
  assert.ok(bye.length >= 1, '服务端应当主动发一条 bye 告诉客户端"你掉线了"');
  assert.strictEqual(closed, true, '服务端应当主动关掉这条连接');
});

/* ══ 缺陷 8：登录限流规范化 ════════════════════════════════════════════ */

test('缺陷8 回归：用户名加空格不能绕开登录限流', async () => {
  await admin.op('user.add', {
    username: 'ratelimit1', password: 'Rl12345678', role: 'operator', displayName: '限流测试',
  });
  // 先连错 8 次把账号锁上
  const a = makeClient();
  for (let i = 0; i < 8; i++) await a.login('ratelimit1', 'wrong-password-xx');

  // 正常形式：必须被挡（401 或 429 都算"挡住"）
  const b = makeClient();
  const r1 = await b.login('ratelimit1', 'Rl12345678');
  assert.notStrictEqual(r1.status, 200, '锁定期间正常形式不该能登录');

  // 尾部加空格：**同样必须被挡**（原来这里返回 200，等于限流白做）
  const c2 = makeClient();
  const r2 = await c2.login('ratelimit1   ', 'Rl12345678');
  assert.notStrictEqual(r2.status, 200, '尾部加空格也必须被挡（原来能绕过去）');

  // 其它变体也试一下（大写、全角空格）
  const c3 = makeClient();
  const r3 = await c3.login('RATELIMIT1', 'Rl12345678');
  assert.notStrictEqual(r3.status, 200, '大写形式也必须被挡（原来也不规范化）');
});

test('缺陷8 回归：登录成功、账号存在时，正常输入仍能进（别把好人也挡了）', async () => {
  const c = makeClient();
  const r = await c.login('sec1', 'SecPass123456');
  assert.strictEqual(r.status, 200, '没失败过的账号应当能正常登录');
  // 前后带空格也该能进（手机输入法很容易带出来），但**限流键是同一个**
  const c2 = makeClient();
  const r2 = await c2.login('  sec1  ', 'SecPass123456');
  assert.strictEqual(r2.status, 200, '用户名前后带空格应当照常能登录');
});

/* ══ 并列按计时精度判（审计报告里"并列容差"那条） ═════════════════════ */

test('并列规则：按计时精度判"读数是否相同"，不再把 12.01/12.02 判成并列', async () => {
  /* 【改的是什么】原来 tol 默认 0.01 并当成"差 ≤ 0.01 就算并列" ——
     那是浮点误差容忍值，不是竞赛规则。审计报告实测：12.01 与 12.02 都排第 1。
     现在判等 = 按该项目的精度取整后**读数相同**。 */

  // 建一个径赛项目（默认百分位）
  const evR = await admin.op('event.add', {
    name: '并列测试·100米', groupId: seeded.gid, kind: 'track', stage: 'final',
  });
  assert.strictEqual(evR.status, 200, '建项目应当成功');
  const eid = evR.data.data.id;

  const ids = [];
  for (let i = 0; i < 3; i++) {
    const a = await admin.op('athlete.add', {
      name: '并列选手' + (i + 1), bib: '5' + String(i + 1).padStart(3, '0'),
      groupId: seeded.gid, grade: '高一', className: '1班',
    });
    ids.push(a.data.data.id);
    await admin.op('reg.add', { eventId: eid, athleteId: a.data.data.id });
  }

  // 12.01 / 12.02 / 12.02 —— 后两个并列第 2，第一个第 1
  await admin.op('result.set', { eventId: eid, athleteId: ids[0], attempt: 1, value: '12.01' });
  await admin.op('result.set', { eventId: eid, athleteId: ids[1], attempt: 1, value: '12.02' });
  await admin.op('result.set', { eventId: eid, athleteId: ids[2], attempt: 1, value: '12.02' });

  const b1 = await admin.call('GET', '/api/events/' + eid + '/board');
  const ranks = b1.data.data.rows.map(r => r.rank);
  assert.deepStrictEqual(ranks, [1, 2, 2],
    '12.01 第 1、两个 12.02 并列第 2（旧规则会把三个都判成第 1）');

  // 改成千分位后，12.011 与 12.012 应当是两个人
  const up = await admin.op('event.update', { id: eid, tol: 0.001 });
  assert.strictEqual(up.status, 200, '改精度应当成功');
  await admin.op('result.set', { eventId: eid, athleteId: ids[0], attempt: 1, value: '12.011' });
  await admin.op('result.set', { eventId: eid, athleteId: ids[1], attempt: 1, value: '12.012' });
  const b2 = await admin.call('GET', '/api/events/' + eid + '/board');
  const r2 = b2.data.data.rows.map(r => r.rank);
  assert.deepStrictEqual(r2, [1, 2, 3],
    '千分位下 12.011 与 12.012 是两个人（读数不同）');

  // 改成十分位后，12.01 与 12.04 取整都是 12.0 → 并列
  await admin.op('event.update', { id: eid, tol: 0.1 });
  await admin.op('result.set', { eventId: eid, athleteId: ids[0], attempt: 1, value: '12.01' });
  await admin.op('result.set', { eventId: eid, athleteId: ids[1], attempt: 1, value: '12.04' });
  await admin.op('result.set', { eventId: eid, athleteId: ids[2], attempt: 1, value: '12.4' });
  const b3 = await admin.call('GET', '/api/events/' + eid + '/board');
  const r3 = b3.data.data.rows.map(r => r.rank);
  assert.deepStrictEqual(r3, [1, 1, 3],
    '十分位下 12.01 与 12.04 都是 12.0 → 并列第 1；12.4 是第 3');
});

test('并列规则：精度档位非法值会被归到最近档位（不让判等拿到没意义的值）', async () => {
  const evR = await admin.op('event.add', {
    name: '并列测试·归位', groupId: seeded.gid, kind: 'track', stage: 'final',
  });
  const eid = evR.data.data.id;
  const cases = [
    [0.05, 0.1, '0.05 → 十分位'],
    [0.004, 0.001, '0.004 → 千分位'],
    [0, 0.01, '0 → 百分位（默认）'],
    [-1, 0.01, '负数 → 百分位'],
    [999, 1, '超大 → 整秒'],
  ];
  for (const [input, want, label] of cases) {
    const r = await admin.op('event.update', { id: eid, tol: input });
    assert.strictEqual(r.status, 200, label + '：改精度应当成功');
    const snap = await admin.snap();
    const ev = (snap.events || []).filter(e => e.id === eid)[0];
    assert.strictEqual(Number(ev.tol), want, label + '（实际 ' + ev.tol + '）');
  }
});

test('并列规则：成绩单上的说明文字按精度写，不写"相差不超过 0.01"', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'public', 'print.js'), 'utf8');
  /* 只看**代码**，不看注释 —— 注释里正解释"为什么不能写相差不超过"，
     把注释也算进来会误报（我第一版就是这么挂的）。 */
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  assert.strictEqual(code.indexOf('相差不超过'), -1,
    '成绩单的**代码**里不该再写"相差不超过 X"（那会让人以为 12.01 和 12.02 并列）');
  assert.ok(code.indexOf('tieText') >= 0, '成绩单应当用统一的 tieText() 生成说明');

  const P = require(path.join(ROOT, 'src', 'parse'));
  const t1 = P.tieRuleText(0.01);
  assert.ok(t1.indexOf('百分位') >= 0, '说明里要带精度档位的说法：' + t1);
  assert.ok(P.tieRuleText(0.001).indexOf('千分位') >= 0, '千分位的说法也要有');
  assert.strictEqual(t1.indexOf('相差不超过'), -1, '不再用"相差不超过"的措辞');
  // 说明里要说清"并列后名次跳号"，否则老师不知道为什么是 1、2、2、4
  assert.ok(t1.indexOf('跳号') >= 0 || t1.indexOf('1、2、2、4') >= 0, '要说明并列后名次跳号');
});

test('缺陷9 回归：备份在没有 sqlite.backup() 的版本上要能降级，不能直接报错', async () => {
  const dbMod = require(path.join(ROOT, 'src', 'db.js'));
  const d = mod.getDb();
  // 正常备份
  const target = path.join(dataDir, 'backup-test.db');
  await d.backupTo(target);
  assert.ok(fs.existsSync(target), '备份文件应当生成');
  assert.ok(fs.statSync(target).size > 0, '备份文件不该是空的');

  // 降级路径：把 sqlite.backup 藏掉（模拟 Node 22.5~22.15），backupTo 仍要能出文件
  const sqlite = require('node:sqlite');
  const realBackup = sqlite.backup;
  let hidden = false;
  try {
    Object.defineProperty(sqlite, 'backup', { value: undefined, configurable: true });
    hidden = true;
  } catch (e) { hidden = false; }
  if (!hidden) {
    // 改不了模块导出就跳过这条（不是失败）
    assert.ok(true, '（这个 Node 不允许改 node:sqlite 导出，跳过降级路径检查）');
    return;
  }
  const target2 = path.join(dataDir, 'backup-fallback.db');
  try {
    await d.backupTo(target2);
    assert.ok(fs.existsSync(target2), '没有 sqlite.backup() 时应当降级生成备份文件');
    assert.ok(fs.statSync(target2).size > 0, '降级备份也不该是空文件');
  } finally {
    Object.defineProperty(sqlite, 'backup', { value: realBackup, configurable: true, writable: true });
  }
  void dbMod;
});

test('缺陷9 回归：check-node.js 会真的调用 API 而不是只看版本号', () => {
  const p = path.join(ROOT, 'tools', 'check-node.js');
  assert.ok(fs.existsSync(p), '应当有 tools/check-node.js');
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(/new\s+.*DatabaseSync/.test(src), '要真的建一个库试试（不能只看版本号）');
  assert.ok(/backup/.test(src), '要探测 backup() 是否存在');
});
