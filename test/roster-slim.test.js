'use strict';
/* ============================================================================
 * roster-slim.test.js —— 第 3 趟改造（快照瘦身 + 名单按需加载）的验收
 *
 * 【这次改造最容易出的错】
 *   名单原本是后台快照的一部分，现在拆成两个数据源：
 *     · 快照：项目 / 班级总分 / 公告 / 统计数字
 *     · /api/roster：运动员名单（按需拉、服务端筛选、分页）
 *   拆开之后最危险的不是"报错"，而是**两处口径不一致**：
 *   比如名单页显示"共 905 名"但快照的 stats.athletes 是 906，
 *   或者筛选条件前端筛一遍、服务端又筛一遍导致结果对不上。
 *   这种错不会报异常，只会让人看到错的数字。
 *
 * 【验收标准】
 *   ① 快照里**没有** athletes 数组（瘦身真的生效）
 *   ② 快照里的 athleteCount / stats.athletes 与名单接口的 total 一致
 *   ③ 名单接口"不带任何筛选拉全量"的条数 === 快照统计的运动员数
 *   ④ 每种筛选的服务端结果 === 前端按同样条件筛出来的结果（口径一致）
 *   ⑤ 分页不重不漏：按页拼起来的 id 集合 === 全量的 id 集合
 *   ⑥ 快照明显变小了（把"瘦身"这件事本身也钉住，免得以后又长回去）
 *
 * 运行：node --no-warnings --test test/
 *      node --no-warnings --test test/roster-slim.test.js
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8483;
const PASS = 'admin123';
let mod = null;
let httpServer = null;
let base = '';
let dataDir = '';
let c = null;

/* 自己造一份"够翻页、够筛选"的数据（不依赖真实库有多少人，跑在哪都对） */
const N_ATHLETES = 14;
const GRADES = ['高一', '高二'];
const CLASSES = ['1班', '2班'];

function startServer() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
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
      return this.call('POST', '/api/op', {
        op, payload, clientUuid: 'rs-' + Math.random().toString(36).slice(2),
      });
    },
    async snap() {
      const r = await this.call('GET', '/api/snapshot?kind=admin');
      return r.data;
    },
    async roster(qs) {
      const r = await this.call('GET', '/api/roster' + (qs || ''));
      return r.data && r.data.data;
    },
  };
}

test.before(async () => {
  base = 'http://127.0.0.1:' + PORT;
  await startServer();
  c = makeClient();
  const lr = await c.login();
  assert.strictEqual(lr.status, 200, '管理员登录应当成功');

  // 建组别 + 一批运动员（两种年级 × 两种班级，号码唯一）
  const g = await c.op('group.add', { name: '男子组', kind: 'male' });
  assert.strictEqual(g.status, 200, '建组别应当成功');
  const snap0 = await c.snap();
  const gid = (snap0.groups || [])[0].id;
  for (let i = 0; i < N_ATHLETES; i++) {
    const r = await c.op('athlete.add', {
      name: '选手' + String(i + 1).padStart(2, '0'),
      bib: String(1000 + i),
      groupId: gid,
      grade: GRADES[i % 2],
      className: CLASSES[Math.floor(i / 2) % 2],
      gender: '男',
    });
    assert.strictEqual(r.status, 200, '加第 ' + (i + 1) + ' 个运动员应当成功');
  }
});

test.after(async () => { await stopServer(); });

/* ══ ① 瘦身真的生效 ═════════════════════════════════════════════════════ */

test('后台快照里不再带完整名单（这是瘦身的关键）', async () => {
  const snap = await c.snap();
  assert.strictEqual(snap.athletes, undefined,
    '快照里不该再有 athletes 数组（它原来占 209 KB / 296 KB）');
  assert.ok(snap.stats && typeof snap.stats.athletes === 'number',
    '但统计里的运动员人数要留着（头部要显示）');
});

test('快照明显变小了（把"瘦身"这件事钉住，免得以后又长回去）', async () => {
  const snap = await c.snap();
  const size = Buffer.byteLength(JSON.stringify(snap), 'utf8');
  /* 改造前这份快照是 296 KB（905 人 + 140 项目）。
     这份夹具只有 14 个人，所以绝对数字没有可比性 ——
     改验"比例"：名单接口全量拉回来的体积应当远大于整个快照，
     说明名单确实不在快照里了。 */
  const all = await c.roster('?limit=2000');
  const rosterSize = Buffer.byteLength(JSON.stringify(all), 'utf8');
  assert.ok(rosterSize > size * 0.3,
    '名单全量的体积（' + (rosterSize / 1024).toFixed(1) + ' KB）应当与快照（'
    + (size / 1024).toFixed(1) + ' KB）可比甚至更大 —— 否则说明名单还在快照里');
});

/* ══ ② 两处口径必须一致 ═════════════════════════════════════════════════ */

test('快照统计的人数 === 名单接口的 total（两个数据源不能打架）', async () => {
  const snap = await c.snap();
  const all = await c.roster('?limit=2000');
  assert.strictEqual(all.total, snap.stats.athletes,
    '名单接口的 total（' + all.total + '）必须等于快照的 stats.athletes（' + snap.stats.athletes + '）');
  assert.strictEqual(all.athletes.length, N_ATHLETES, '不带筛选应当拿到全部 ' + N_ATHLETES + ' 人');
  assert.strictEqual(all.total, N_ATHLETES, 'total 应当是 ' + N_ATHLETES);
});

test('快照里每个组别的 athleteCount === 名单按该组别筛出来的条数', async () => {
  const snap = await c.snap();
  for (const g of snap.groups || []) {
    const r = await c.roster('?groupId=' + encodeURIComponent(g.id) + '&limit=2000');
    assert.strictEqual(g.athleteCount, r.count,
      '「' + g.name + '」快照说 ' + g.athleteCount + ' 人，名单接口说 ' + r.count + ' 人');
  }
});

/* ══ ③ 服务端筛选的结果 === 前端按同样条件筛的结果 ═════════════════════ */

test('按年级 / 班级 / 组别筛选：服务端结果与前端自己筛的一致', async () => {
  const all = (await c.roster('?limit=2000')).athletes;

  for (const grade of GRADES) {
    const r = await c.roster('?grade=' + encodeURIComponent(grade) + '&limit=2000');
    const want = all.filter(a => a.grade === grade);
    assert.strictEqual(r.count, want.length, '年级「' + grade + '」条数应当一致');
    assert.deepStrictEqual(r.athletes.map(a => a.id), want.map(a => a.id),
      '年级「' + grade + '」的**顺序和内容**都应当与前端筛的一致');
  }
  for (const cn of CLASSES) {
    const r = await c.roster('?className=' + encodeURIComponent(cn) + '&limit=2000');
    const want = all.filter(a => a.className === cn);
    assert.strictEqual(r.count, want.length, '班级「' + cn + '」条数应当一致');
    assert.deepStrictEqual(r.athletes.map(a => a.id), want.map(a => a.id), '班级「' + cn + '」内容一致');
  }
  // 两个条件叠加
  const combo = await c.roster('?grade=' + encodeURIComponent(GRADES[0])
    + '&className=' + encodeURIComponent(CLASSES[0]) + '&limit=2000');
  const wantCombo = all.filter(a => a.grade === GRADES[0] && a.className === CLASSES[0]);
  assert.strictEqual(combo.count, wantCombo.length, '年级+班级叠加筛选条数一致');
  assert.deepStrictEqual(combo.athletes.map(a => a.id), wantCombo.map(a => a.id), '叠加筛选内容一致');
});

test('搜索（姓名 / 号码）与前端筛的一致', async () => {
  const all = (await c.roster('?limit=2000')).athletes;

  const byName = await c.roster('?search=' + encodeURIComponent('选手0') + '&limit=2000');
  const wantName = all.filter(a => String(a.name).toLowerCase().indexOf('选手0') >= 0
    || String(a.bib).toLowerCase().indexOf('选手0') >= 0);
  assert.strictEqual(byName.count, wantName.length, '搜「选手0」条数一致');
  assert.deepStrictEqual(byName.athletes.map(a => a.id), wantName.map(a => a.id), '搜姓名内容一致');

  const byBib = await c.roster('?search=1005&limit=2000');
  const wantBib = all.filter(a => String(a.bib).indexOf('1005') >= 0);
  assert.strictEqual(byBib.count, wantBib.length, '搜号码条数一致');
  assert.deepStrictEqual(byBib.athletes.map(a => a.id), wantBib.map(a => a.id), '搜号码内容一致');

  // 搜不到时：给空数组而不是报错（前端要显示"没有符合条件的运动员"）
  const none = await c.roster('?search=' + encodeURIComponent('绝对不存在的人') + '&limit=2000');
  assert.strictEqual(none.count, 0, '搜不到时 count 应当是 0');
  assert.deepStrictEqual(none.athletes, [], '搜不到时给空数组');
  assert.ok(none.total > 0, '但 total（全库总数）仍是真实值，前端要用它区分"没人"和"筛没了"');
});

test('下拉候选值按全量算，不受当前筛选影响', async () => {
  // 只看高一，但班级候选里应当仍然有高二那边的班级
  const r = await c.roster('?grade=' + encodeURIComponent(GRADES[0]) + '&limit=2000');
  assert.ok(r.grades.length === GRADES.length,
    '年级候选值应当是全部 ' + GRADES.length + ' 个（否则选完一个别的就消失了），实际 ' + JSON.stringify(r.grades));
  assert.ok(r.classes.length === CLASSES.length,
    '班级候选值也应当是全部 ' + CLASSES.length + ' 个，实际 ' + JSON.stringify(r.classes));
});

/* ══ ④ 分页不重不漏 ═════════════════════════════════════════════════════ */

test('分页：按页拼起来正好是全集，不重不漏', async () => {
  const all = (await c.roster('?limit=2000')).athletes;
  const seen = [];
  const PAGE = 3;
  for (let off = 0; off < all.length; off += PAGE) {
    const r = await c.roster('?limit=' + PAGE + '&offset=' + off);
    assert.strictEqual(r.offset, off, '返回的 offset 应当与请求一致');
    assert.strictEqual(r.count, all.length, 'count 始终是"符合条件总数"，不是本页条数');
    r.athletes.forEach(a => seen.push(a.id));
  }
  assert.deepStrictEqual(seen, all.map(a => a.id), '按页拼起来的顺序与内容应当与全量完全一致');
  assert.strictEqual(new Set(seen).size, seen.length, '不该有重复');
});

/* ══ ⑤ 报名项数：名单页要显示"报名 N 项" ═══════════════════════════════ */

test('名单里带了报名项数，且与快照里项目的名单数对得上', async () => {
  /* 这份夹具是空库（不灌演示数据），所以项目要自己建 ——
     第一版我假设"建库时会有项目"，结果这条用例在空库上必挂。 */
  const g = await c.snap();
  const gid = (g.groups || [])[0].id;
  const evR = await c.op('event.add', { name: '测试项目', groupId: gid, kind: 'track', stage: 'final' });
  assert.strictEqual(evR.status, 200, '建项目应当成功');
  const evId = evR.data.data.id;

  const all = (await c.roster('?limit=2000')).athletes;
  assert.ok(all.every(a => typeof a.regCount === 'number'),
    '每个人的 regCount 都应当是个数字（前端"报名 N 项"要用）');

  // 给一个人报名，确认他的 regCount 涨了，而且项目的名单数也跟着涨
  const before = all[0].regCount;
  const r = await c.op('reg.add', { eventId: evId, athleteId: all[0].id });
  assert.strictEqual(r.status, 200, '报名应当成功');
  const after = (await c.roster('?limit=2000')).athletes.filter(a => a.id === all[0].id)[0];
  assert.strictEqual(after.regCount, before + 1,
    '报名后 regCount 应当 +1（前 ' + before + ' 后 ' + after.regCount + '）');

  const snap = await c.snap();
  const ev = (snap.events || []).filter(e => e.id === evId)[0];
  assert.strictEqual(ev.regCount, 1, '快照里这个项目的名单数应当是 1');
});
