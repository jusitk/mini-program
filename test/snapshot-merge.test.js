'use strict';
/* ============================================================================
 * snapshot-merge.test.js —— 增量推送的验收（第 2 趟改造）
 *
 * 【为什么这是整个改造里最该测的地方】
 *   增量合并错了**不会报错**，只会少显示一条成绩或名次算错 ——
 *   这种 bug 到运动会现场才发现就晚了。
 *
 * 【验收标准：逐字段比对】
 *   对每一种改动都验这一条不变式：
 *       merge(改动前的全量, 服务端造的增量)  ===  改动后的全量
 *   三方都是服务端生成的（改前全量 / 增量 / 改后全量），不靠人眼、不写死期望值。
 *
 * 单独再验安全绳：base 对不上时必须**拒绝合并**，
 *   这样客户端才会退回全量 —— 少数据比慢一点严重得多。
 *
 * 运行：node --no-warnings --test test/
 *      node --no-warnings --test test/snapshot-merge.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const Merge = require(path.join(ROOT, 'public', 'snapshot-merge.js'));

const PORT = 8481;
const PASS = 'admin123';
let mod = null;        // server.js 模块
let httpServer = null; // http.Server 实例（mod.server）
let base = '';
let dataDir = '';
let c = null;          // 一个已登录的客户端（所有用例共用，省得反复登录）
let seeded = null;     // 合成数据（自己造，不依赖真实库）
let sseAbort = null;   // SSE 用例的 AbortController —— after() 里兜底 abort，避免关服务时卡住

function startServer() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-'));
  /* 【不依赖真实库】
     原来这里把项目 data/ 里的真实数据库复制过来用。问题有两个：
       ① 别人（或 CI）拿到这份代码时 data/ 可能是空的 → 后面"找有名单的项目"
          这类前置断言直接失败，而且报出来的错完全指不到真正原因
          （外部审计就踩了这个：单独跑这个文件时超时失败）
       ② 测试会**改动**真实库的数据，这是不该发生的
     现在改成：空库启动 + 在 before 里自己造一份固定的合成数据。
     下面 seedData() 造出来的规模（1 组 / 2 项目 / 6 人）是刻意选的：
     刚好够验"多项目 + 有名单 + 名次行"，又不至于让测试变慢。 */
  process.env.DATA_DIR = dataDir;
  process.env.PORT = String(PORT);
  process.env.HOST = '127.0.0.1';
  process.env.SPORTS_ADMIN_PASSWORD = PASS;
  process.env.SPORTS_ADMIN_USER = 'admin';
  delete process.env.SEED_DEMO;
  // 清模块缓存：保证读到的是新的 DATA_DIR / PORT（照 test/run.js 的做法）
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf(ROOT) === 0 && k.indexOf('node_modules') < 0) delete require.cache[k];
  }
  mod = require(path.join(ROOT, 'server.js'));
  mod.initData();                       // 建库 / 建管理员 / 起定时任务
  httpServer = mod.server;
  return new Promise((resolve) => {
    if (httpServer.listening) return resolve();
    httpServer.listen(PORT, '127.0.0.1', resolve);
  });
}

/**
 * 造一份固定的合成数据（不依赖真实库）。
 * @returns {object} { groupId, eventIds, athletes }
 */
async function seedData(c) {
  const g = await c.op('group.add', { name: '测试男子组', kind: 'male' });
  assert.strictEqual(g.status, 200, '建组别应当成功');
  const snap0 = await c.full('admin');
  const gid = (snap0.groups || [])[0].id;

  const eventIds = [];
  const kinds = [
    { name: '合成·100米决赛', kind: 'track', stage: 'final' },
    { name: '合成·跳远决赛', kind: 'field', stage: 'final', attempts: 3 },
  ];
  for (const k of kinds) {
    const r = await c.op('event.add', Object.assign({ groupId: gid }, k));
    assert.strictEqual(r.status, 200, '建项目「' + k.name + '」应当成功');
    eventIds.push(r.data.data.id);
  }

  const athletes = [];
  for (let i = 0; i < 6; i++) {
    const r = await c.op('athlete.add', {
      name: '合成选手' + String(i + 1).padStart(2, '0'),
      bib: String(2000 + i), groupId: gid,
      grade: i < 3 ? '高一' : '高二', className: (i % 2 ? '1班' : '2班'),
    });
    assert.strictEqual(r.status, 200, '建第 ' + (i + 1) + ' 个运动员应当成功');
    athletes.push(r.data.data.id);
  }
  // 每个人都报两个项目 —— 这样"有名单但没录成绩"的项目一定存在
  for (const eid of eventIds) {
    for (const aid of athletes) {
      const r = await c.op('reg.add', { eventId: eid, athleteId: aid });
      assert.strictEqual(r.status, 200, '报名应当成功');
    }
  }
  return { groupId: gid, eventIds, athletes };
}

function stopServer() {
  return new Promise((resolve) => {
    try { mod.stopTimers(); } catch (e) { /* ignore */ }
    const done = () => {
      // 关库：合并 WAL、释放文件句柄，否则临时目录删不掉
      try { const d = mod.getDb(); if (d) d.close(); } catch (e) { /* ignore */ }
      setTimeout(() => {
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        resolve();
      }, 200);
    };
    try {
      if (httpServer && httpServer.listening) httpServer.close(done);
      else done();
    } catch (e) { done(); }
  });
}

function makeClient() {
  let cookie = '';
  let csrf = '';
  return {
    async call(method, url, body) {
      const headers = { Accept: 'application/json' };
      if (cookie) headers.Cookie = cookie;
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
    op(op, payload) {
      return this.call('POST', '/api/op', { op, payload, clientUuid: 'sm-' + Math.random().toString(36).slice(2) });
    },
    async full(kind) {
      const r = await this.call('GET', '/api/snapshot?kind=' + kind);
      return r.data;
    },
    async board(eventId) {
      const r = await this.call('GET', '/api/events/' + eventId + '/board');
      return r.data && r.data.data;
    },
  };
}

/** 递归比较，返回第一处不同的路径（null = 完全相同）。用来做"逐字段一致"的判据。 */
function firstDiff(a, b, p) {
  p = p || '';
  if (a === b) return null;
  if (a === null || b === null) return p + ' 一边为 null: ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b);
  if (typeof a !== typeof b) return p + ' 类型不同';
  if (Array.isArray(a) !== Array.isArray(b)) return p + ' 一边数组一边不是';
  if (Array.isArray(a)) {
    if (a.length !== b.length) return p + ' 长度不同: ' + a.length + ' vs ' + b.length;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], p + '[' + i + ']');
      if (d) return d;
    }
    return null;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join(',') !== kb.join(',')) {
      return p + ' 字段不同（改前多: ' + ka.filter(k => kb.indexOf(k) < 0).join('/')
        + '；改后多: ' + kb.filter(k => ka.indexOf(k) < 0).join('/') + '）';
    }
    for (const k of ka) {
      const d = firstDiff(a[k], b[k], p + '.' + k);
      if (d) return d;
    }
    return null;
  }
  return p + ' 值不同: ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b);
}

/** at（时间戳）两次调用必然不同，不算数据不一致；rev 必须一致，所以不忽略 */
function ignoreAt(o) {
  if (o && typeof o === 'object') {
    delete o.at;
    Object.keys(o).forEach(k => ignoreAt(o[k]));
  }
}

/** 用服务端**自己的**增量构造函数造一条增量（跟 SSE 推的是同一段代码） */
function serverPatch(kind, eventIds, baseRev) {
  const d = mod.getDb();
  const dbMod = require(path.join(ROOT, 'src', 'db.js'));
  const meet = dbMod.currentMeet(d);
  const Board = require(path.join(ROOT, 'src', 'scoreboard.js'));
  return kind === 'screen'
    ? Board.screenPatch(d, meet.id, baseRev, eventIds)
    : Board.adminPatch(d, meet.id, baseRev, eventIds);
}

/**
 * 跑一轮不变式：
 *   before(全量) → 造增量(base=before.rev) → after(全量) → merge → 比较
 * mutation 是 async，负责真正改库。
 */
async function checkInvariant(label, kind, eventIds, before, mutation, alreadyDone) {
  /* 注意 mutation 必须 await：它内部是 fetch，不 await 的话断言拿到的是 Promise，
     后面拿到的 snapshot 也还是"改之前"的 —— 我第一版就漏了 await，
     报出来的错是 "Cannot read properties of undefined (reading 'slice')"，
     完全看不出真正原因。 */
  if (!alreadyDone) {
    const r = await mutation();
    assert.ok(r === undefined || r === true || (r && r.status === 200),
      label + '：改动应当成功 → ' + JSON.stringify(r && r.data).slice(0, 200));
  }
  const patch = serverPatch(kind, eventIds, Number(before.rev));
  const after = await c.full(kind);
  const local = JSON.parse(JSON.stringify(before));
  let merged = false;
  try {
    merged = Merge.merge(local, patch);
  } catch (err) {
    assert.fail(label + '：合并抛异常 ' + (err && err.message)
      + '\n  增量形状：kind=' + patch.kind
      + ' base=' + patch.base + ' rev=' + patch.rev
      + ' patch 字段=' + Object.keys(patch.patch || {}).join(',')
      + '\n  eventIds=' + JSON.stringify(patch.patch && patch.patch.eventIds)
      + '\n  local.kind=' + (before && before.kind)
      + ' local.panels=' + (before && before.panels ? Object.keys(before.panels).join(',') : '(无)'));
  }
  assert.strictEqual(merged, true,
    label + '：合并应当成功（base=' + patch.base + ' 本地 rev=' + local.rev + '）');
  ignoreAt(local); ignoreAt(after);
  const diff = firstDiff(local, after, label);
  assert.strictEqual(diff, null, label + '：合并结果与全量快照不一致 → ' + diff);
}

test.before(async () => {
  base = 'http://127.0.0.1:' + PORT;
  await startServer();
  c = makeClient();
  const lr = await c.login();
  assert.strictEqual(lr.status, 200, '测试用的管理员登录应当成功');
  /* 自己造数据 —— 不依赖项目 data/ 里有没有真实库。
     这样在任何机器、任何 CI 上跑的结果都一样，
     而且**不会碰到老师的真实数据**（外部审计指出过这个问题）。 */
  seeded = await seedData(c);
  assert.ok(seeded.eventIds.length >= 2, '合成数据里应当有 2 个项目');
});

test.after(async () => {
  /* 无条件清理：外部审计指出"SSE 用例在前置断言失败时走不到 ctrl.abort()，
     服务关闭会一直等长连接" —— 所以这里把兜底 abort 放在最前面。 */
  try { if (sseAbort) sseAbort.abort(); } catch (e) { /* ignore */ }
  await stopServer();
});

/* ══ ① 安全绳 ═══════════════════════════════════════════════════════════ */

test('安全绳：base 对不上时必须拒绝合并（这样客户端才会退回全量）', () => {
  const local = { kind: 'screen', rev: 10, panels: { live: [], done: [], pending: [] } };
  const patch = { kind: 'screen', base: 9, rev: 11, patch: { eventIds: [], events: [] } };
  assert.strictEqual(Merge.isPatch(patch), true, '带 base+patch 的要认成增量');
  assert.strictEqual(Merge.merge(local, patch), false, 'base=9 而本地 rev=10 → 必须拒绝');
  assert.strictEqual(local.rev, 10, '拒绝时不能改本地版本');
});

test('全量快照不会被当成增量', () => {
  assert.strictEqual(Merge.isPatch({ kind: 'screen', rev: 3, panels: {} }), false);
  assert.strictEqual(Merge.isPatch(null), false);
  assert.strictEqual(Merge.isPatch({ rev: 1 }), false, '没有 patch 字段的不算增量');
});

/* ══ ② 核心不变式：merge(改前全量, 增量) === 改后全量 ═══════════════════ */

test('录一条成绩 → 增量合并后与全量逐字段一致（大屏 + 后台）', async () => {
  const adminBefore = await c.full('admin');
  const ev = (adminBefore.events || []).find(e => e.regCount > 0 && e.recorded === 0);
  assert.ok(ev, '真实库里应当有"有名单但没录成绩"的项目（否则这条用例没意义）');
  const bd = await c.board(ev.id);
  assert.ok(bd && bd.entries.length, '项目应当有报名名单');

  const screenBefore = await c.full('screen');
  assert.strictEqual(Number(screenBefore.rev), Number(adminBefore.rev), '大屏与后台的 rev 应当一致');

  const reg = bd.entries[0];
  await checkInvariant('大屏·录成绩', 'screen', [ev.id], screenBefore,
    () => c.op('result.set', { eventId: ev.id, regId: reg.regId, attempt: 1, value: '12.34' }));
  await checkInvariant('后台·录成绩', 'admin', [ev.id], adminBefore, null, true);

  // 顺便确认成绩真的落了库（别让"两边都一样地空"骗过去）
  const bd2 = await c.board(ev.id);
  assert.ok(bd2.entries[0].attempts.length >= 1, '成绩应当已经录进去');
});

test('项目状态改变（→已结束）→ 条目要在 live/done 之间正确搬家', async () => {
  const before = await c.full('screen');
  const ev = (before.panels.live || [])[0] || (before.panels.pending || [])[0];
  assert.ok(ev, '应当有可改状态的项目');
  await checkInvariant('大屏·改状态', 'screen', [ev.id], before,
    () => c.op('event.status', { id: ev.id, status: 'done' }));

  const after = await c.full('screen');
  const inLive = (after.panels.live || []).filter(x => x.id === ev.id).length;
  const inDone = (after.panels.done || []).filter(x => x.id === ev.id).length;
  assert.strictEqual(inLive + inDone, 1,
    '一个项目只应出现在 live 或 done 之一（现在 live=' + inLive + ' done=' + inDone + '）');
});

test('恢复自动 → 状态回到按时间算，增量仍一致', async () => {
  const before = await c.full('admin');
  const ev = (before.events || []).find(e => e.statusMode === 'manual');
  assert.ok(ev, '上一条用例刚把它设成手动，这里应当能找到');
  await checkInvariant('后台·恢复自动', 'admin', [ev.id], before,
    () => c.op('event.statusAuto', { id: ev.id }));
});

test('检录点名 → 增量合并后与全量逐字段一致（大屏 + 后台）', async () => {
  /* 前提：必须先"开始检录"才能点到场（服务端有 CHECKIN_CLOSED 保护，
     这是现场防误点的设计）。所以这里先开检录，再点名。 */
  const adminPre = await c.full('admin');
  const ev = (adminPre.events || []).find(e => e.regCount > 1 && !e.checkinOpen);
  assert.ok(ev, '应当有项目带名单且还没开始检录');
  const open1 = await c.op('checkin.open', { eventId: ev.id });
  assert.strictEqual(open1.status, 200, '开始检录应当成功');

  const adminBefore = await c.full('admin');
  const screenBefore = await c.full('screen');
  const bd = await c.board(ev.id);
  const reg = bd.entries[0];

  await checkInvariant('大屏·检录点名', 'screen', [ev.id], screenBefore,
    () => c.op('checkin.mark', { regId: reg.regId, arrived: !reg.arrived }));
  await checkInvariant('后台·检录点名', 'admin', [ev.id], adminBefore, null, true);

  // 再点一次（取消到场），确认两个方向都对
  const adminMid = await c.full('admin');
  const screenMid = await c.full('screen');
  const bd2 = await c.board(ev.id);
  await checkInvariant('大屏·取消到场', 'screen', [ev.id], screenMid,
    () => c.op('checkin.mark', { regId: bd2.entries[0].regId, arrived: false }));
  await checkInvariant('后台·取消到场', 'admin', [ev.id], adminMid, null, true);
});

test('开始检录 → 大屏检录栏要出现这个项目，且增量与全量一致', async () => {
  const before = await c.full('screen');
  const admin = await c.full('admin');
  const ev = (admin.events || []).find(e => e.regCount > 0 && !e.checkinOpen);
  assert.ok(ev, '应当有还没开始检录的项目');
  await checkInvariant('大屏·开始检录', 'screen', [ev.id], before,
    () => c.op('checkin.open', { eventId: ev.id }));

  const after = await c.full('screen');
  assert.ok((after.panels.checkin || []).some(x => x.id === ev.id),
    '开始检录后，大屏检录栏里应当有这个项目');
});

test('清空项目成绩 → 增量合并后与全量逐字段一致', async () => {
  const adminBefore = await c.full('admin');
  const ev = (adminBefore.events || []).find(e => e.recorded > 0);
  assert.ok(ev, '应当有已录成绩的项目');
  const screenBefore = await c.full('screen');
  await checkInvariant('大屏·清空成绩', 'screen', [ev.id], screenBefore,
    () => c.op('result.clearEvent', { eventId: ev.id }));
  await checkInvariant('后台·清空成绩', 'admin', [ev.id], adminBefore, null, true);
});

test('连续两次改动：第二条增量的 base 要用第一条之后的 rev', async () => {
  const adminBefore = await c.full('admin');
  const ev = (adminBefore.events || []).find(e => e.regCount > 0);
  const bd = await c.board(ev.id);

  // 第一次改动
  const r1 = await c.op('result.set', { eventId: ev.id, regId: bd.entries[0].regId, attempt: 1, value: '11.11' });
  assert.strictEqual(r1.status, 200);
  const afterFirst = await c.full('admin');
  assert.ok(Number(afterFirst.rev) > Number(adminBefore.rev), 'rev 应当增加');

  // 第二次改动：增量以"第一次之后"的 rev 为 base
  const r2 = await c.op('result.set', { eventId: ev.id, regId: bd.entries[0].regId, attempt: 1, value: '10.10' });
  assert.strictEqual(r2.status, 200);
  const patch2 = serverPatch('admin', [ev.id], Number(afterFirst.rev));
  const afterSecond = await c.full('admin');

  const local = JSON.parse(JSON.stringify(afterFirst));
  assert.strictEqual(Merge.merge(local, patch2), true, '第二条增量应当能合并');
  ignoreAt(local); ignoreAt(afterSecond);
  const diff = firstDiff(local, afterSecond, '连续两次');
  assert.strictEqual(diff, null, '连续改动后不一致 → ' + diff);

  // 反向验一次安全绳：拿"第一次之前"的 rev 当 base 也必须被拒
  const stale = JSON.parse(JSON.stringify(afterFirst));
  assert.strictEqual(Merge.merge(stale, serverPatch('admin', [ev.id], Number(adminBefore.rev))), false,
    '用过期的 base 必须被拒（这条能挡住"漏了一条消息还硬套补丁"）');
});

/* ══ ③ 增量真的比全量小得多（否则这趟改造白做） ═══════════════════════ */

test('一条增量只带受影响的那个项目，体积远小于全量', async () => {
  const full = await c.full('admin');
  const ev = (full.events || [])[0];
  const patch = serverPatch('admin', [ev.id], Number(full.rev));

  assert.strictEqual(patch.patch.events.length, 1, '增量里应当只有 1 个项目');
  assert.deepStrictEqual(patch.patch.eventIds, [ev.id], 'eventIds 应当只有那一个');

  const fullSize = Buffer.byteLength(JSON.stringify(full), 'utf8');
  const patchSize = Buffer.byteLength(JSON.stringify(patch), 'utf8');
  /* 【这里为什么不比"比例"】这份夹具只有 2 个项目、6 个人，
     整份全量本身就才 3 KB —— 增量再怎么省也占不到三分之一，
     用比例断言会变成"夹具越小越失败"的假失败（我第一版就是这么挂的）。
     所以分两条判：
       ① 结构性断言（与规模无关）：增量里**只有那一个项目**的行
       ② 绝对上限：改造前每次推 296 KB，增量必须远远小于它
     真实规模下的比例由 tools 的实测量过：后台 296 KB → 1.9 KB。 */
  assert.ok(patchSize < 60 * 1024,
    '增量应当远小于改造前的整份快照（实测 ' + (patchSize / 1024).toFixed(1) + ' KB）');
  const evRow = patch.patch.events[0];
  assert.ok(evRow && evRow.id === ev.id, '增量里的那一行就是被改的项目');
  // 反向：增量里**不该**夹带别的项目
  assert.ok(patch.patch.events.every(x => x.id === ev.id), '增量里不该夹带别的项目');
  void fullSize;
});

/* ══ ④ SSE 真的在推增量（不只是函数能算出来） ═════════════════════════ */

test('SSE 推的确实是增量（带 base），首包仍是全量', async () => {
  const got = [];
  const ctrl = new AbortController();
  // 用带 cookie 的原始 fetch 读 SSE 流
  const headers = {};
  const login = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASS }),
  });
  headers.Cookie = String(login.headers.get('set-cookie') || '').split(';')[0];

  const streamP = fetch(base + '/api/stream/admin', { headers, signal: ctrl.signal })
    .then(async (res) => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split('\n').find(l => l.indexOf('data: ') === 0);
          if (!line) continue;
          try { got.push(JSON.parse(line.slice(6))); } catch (e) { /* ignore */ }
        }
        /* 这里**绝对不能**写 "收够 N 条就 break"：
           我第一版写了 got.length >= 2 就跳出，结果"订阅时的 hello + 订阅时的全量"
           正好凑够 2 条，循环当场结束 —— 后面真正要验的增量（第 3 条）
           永远读不到，而报错信息是"没收到增量"，完全指不到真正原因。
           一直读到 abort 为止就对了。 */
      }
    })
    .catch(() => { /* abort 时会走到这里，正常 */ });

  await new Promise(r => setTimeout(r, 500));
  // 首包应当是全量（hello）
  assert.ok(got.length >= 1, '应当收到首包');
  assert.strictEqual(got[0].type, 'hello', '首包应当是 hello');
  assert.strictEqual(got[0].data.base, undefined, '全量快照不带 base');

  /* 这个用例**不能依赖前一条用例留下的数据**。
     我第一版写的是"找已录成绩的项目"，但上一条用例正好把成绩清空了 ——
     于是单独跑这一条（--test-name-pattern）时它就找不到项目、断言失败，
     报出来的却是"没收到增量"，完全看不出真正原因。现在自己造条件。 */
  const full = await c.full('admin');
  const ev = (full.events || []).find(e => e.regCount > 0);
  assert.ok(ev, '应当有带名单的项目');
  const bd = await c.board(ev.id);
  const r = await c.op('result.set', { eventId: ev.id, regId: bd.entries[0].regId, attempt: 1, value: '9.99' });
  assert.strictEqual(r.status, 200, '造改动应当成功：' + JSON.stringify(r.data).slice(0, 200));

  await new Promise(r => setTimeout(r, 1500));
  ctrl.abort();
  await streamP;

  /* 这里**不能**断言"最后一条一定是增量"：
     期间可能还夹着别的全量推送（比如后台在线人数变化、自动状态切换），
     那些是正常现象。要验的是"**至少收到了一条增量，而且它带的是刚改的那个项目**"。 */
  const incs = got.filter(m => m.type === 'snapshot' && m.data && m.data.base !== undefined && m.data.patch);
  const dump = got.map(m => m.type + (m.data && m.data.base !== undefined ? '(增量)' : '(全量)')).join(' → ');
  assert.ok(incs.length >= 1,
    '改动后应当收到**增量**推送。这次收到的消息依次是：' + (dump || '(一条都没收到)')
    + '；改动结果=' + JSON.stringify(r.data).slice(0, 160));
  const inc = incs[incs.length - 1];
  assert.ok(inc.data.patch.eventIds.indexOf(ev.id) >= 0,
    '增量应当包含刚改的那个项目（' + ev.id + '），实际是 ' + JSON.stringify(inc.data.patch.eventIds));
  // 增量的 rev 必须真的往前走
  assert.ok(Number(inc.data.rev) > Number(inc.data.base),
    '增量的 rev 应当大于 base（base=' + inc.data.base + ' rev=' + inc.data.rev + '）');
});
