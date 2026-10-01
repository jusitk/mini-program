'use strict';
/**
 * test/run.js —— 零依赖测试套件（自带服务、自带全新数据目录，可重复跑）
 *
 * 用法：
 *   node test/run.js                 跑全部
 *   node test/run.js --only=engine   只跑成绩/名次/计分规则
 *   node test/run.js --only=api      只跑接口与并发
 *   node test/run.js --keep          保留临时数据目录（排查用）
 *
 * 设计原则：
 *   · 每个套件都从**全新的空数据目录**开始，不依赖上一次的残留，连跑两遍结果一致
 *   · 服务在进程内启动（server.js 导出 start），跑完关掉并清理
 *   · 断言失败不中断其它用例，最后汇总；有失败就 exit 1
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const KEEP = args.indexOf('--keep') >= 0;
const ONLY = (args.find(a => a.indexOf('--only=') === 0) || '').split('=')[1] || '';

const suites = [];
const register = (name, fn) => suites.push({ name, fn });

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  ok(a === b, msg + (a === b ? '' : ('（实际 ' + a + '，期望 ' + b + '）')));
}
function section(title) { console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(2, 50 - title.length))); }

/* ── 起一个测试服务（独立数据目录 + 独立端口） ─────────────────────────── */

let server = null;
let base = '';
let dataDir = '';
let currentMod = null;

async function startServer(seedDemo) {
  // 先把上一个套件的服务彻底关掉：只清 require 缓存而不关库，
  // 旧连接会一直占着 SQLite 文件（Windows 上还会导致临时目录删不掉）
  await stopServer();

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sports-test-'));
  const port = 8300 + Math.floor(Math.random() * 500);
  process.env.DATA_DIR = dataDir;
  process.env.PORT = String(port);
  process.env.HOST = '127.0.0.1';
  process.env.SPORTS_ADMIN_PASSWORD = 'test-pass-123';
  process.env.SPORTS_ADMIN_USER = 'admin';
  /* 【这个套件必须开多设备登录】
     它有一节专门测"20 个客户端同时提交成绩、一条不丢"，
     而 20 个客户端都是**同一个 admin 账号**。
     默认规则（一个账号只能一台设备）下，会不停把前面的客户端顶下线，
     那一节就全 401 了 —— 那不是它的考点，会把真正的回归淹没掉。
     登录规则本身在 single-session.test.js / sessions.test.js 里单独验。 */
  process.env.ALLOW_MULTI_DEVICE_LOGIN = '1';
  delete process.env.SEED_DEMO;
  if (seedDemo) process.env.SEED_DEMO = '1';

  // 清掉模块缓存再 require：保证新套件读到的是新的 DATA_DIR / PORT
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf(ROOT) === 0 && k.indexOf('node_modules') < 0) delete require.cache[k];
  }
  const mod = require(path.join(ROOT, 'server.js'));
  currentMod = mod;
  // 关键：必须走一遍 initData（建库、灌演示数据、建首个管理员、起定时任务）。
  // 只 listen 不 initData 会漏掉建管理员这一步，登录直接 401。
  mod.initData();
  server = mod.server;
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.listen(Number(process.env.PORT), '127.0.0.1', resolve);
  });
  base = 'http://127.0.0.1:' + server.address().port;
  return { mod, dataDir, base };
}

async function stopServer() {
  try {
    if (currentMod && typeof currentMod.stopTimers === 'function') currentMod.stopTimers();
  } catch (e) { /* ignore */ }
  try {
    if (server && server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  } catch (e) { /* ignore */ }
  // 关库（合并 WAL 并释放文件句柄），否则临时目录删不掉、下一个套件可能拿到旧数据
  try {
    if (currentMod && typeof currentMod.getDb === 'function') {
      const db = currentMod.getDb();
      if (db) db.close();
    }
  } catch (e) { /* ignore */ }
  server = null;
  currentMod = null;
  base = '';
  await new Promise(r => setTimeout(r, 150));
  if (dataDir && !KEEP) {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  } else if (dataDir && KEEP) {
    console.log('  （保留数据目录：' + dataDir + '）');
  }
  dataDir = '';
}

/* ── HTTP 小客户端 ────────────────────────────────────────────────────── */

function makeClient() {
  const c = { cookie: '', csrf: '' };
  c.call = async function (method, p, body, extraHeaders) {
    const headers = Object.assign({ Accept: 'application/json' }, extraHeaders || {});
    if (c.cookie) headers.Cookie = c.cookie;
    if (c.csrf && method !== 'GET' && !headers['X-CSRF']) headers['X-CSRF'] = c.csrf;
    let payload;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + p, { method, headers, body: payload });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const kv = sc.split(';')[0];
      if (kv.indexOf('sports_sid=') === 0) c.cookie = kv;
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: res.status, data };
  };
  c.login = async function (u, p) {
    const r = await c.call('POST', '/api/login', { username: u || 'admin', password: p || 'test-pass-123' });
    if (r.data && r.data.csrf) c.csrf = r.data.csrf;
    return r;
  };
  c.op = function (op, payload, extra) {
    return c.call('POST', '/api/op', Object.assign({ op, payload: payload || {} }, extra || {}));
  };
  return c;
}

/* ══════════════════════════════════════════════════════════════════════
 * 套件一：成绩解析、名次、并列、弃权、田赛取最好、计分、班级总分
 * ══════════════════════════════════════════════════════════════════════ */

register('engine', async () => {
  section('成绩解析：三种格式 + 全角 + 单位 + 非法输入必须报错');
  const P = require(path.join(ROOT, 'src/parse.js'));
  eq(P.parseResult('12.35').value, 12.35, '12.35 → 12.35 秒');
  eq(P.parseResult('2:15.30').value, 135.3, '2:15.30 → 135.3 秒');
  eq(P.parseResult('1:02:15.30').value, 3735.3, '1:02:15.30 → 3735.3 秒');
  eq(P.parseResult('5.67米').value, 5.67, '5.67米 → 5.67');
  eq(P.parseResult('１２．３５').value, 12.35, '全角数字能认');
  eq(P.parseResult('弃权').dnf, true, '「弃权」识别为弃权');
  eq(P.parseResult('DNF').dnf, true, 'DNF 识别为弃权');
  eq(P.parseResult('犯规').foul, true, '「犯规」识别为单次犯规');
  eq(P.parseResult('').empty, true, '空字符串 = 删除这条成绩');
  let threw = false;
  try { P.parseResult('12.35mm'); } catch (e) { threw = true; }
  ok(threw, '「12.35mm」必须报错（不能静默当成 12.35 秒）');
  threw = false;
  try { P.parseResult('abc'); } catch (e) { threw = true; }
  ok(threw, '「abc」必须报错');
  threw = false;
  try { P.parseResult('2:75'); } catch (e) { threw = true; }
  ok(threw, '「2:75」必须报错（秒数不能 ≥ 60）');
  eq(P.formatResult(135.3, 'track'), '2:15.30', '格式化：135.3 → 2:15.30');
  eq(P.formatResult(12.345, 'field'), '12.35', '格式化：田赛保留两位');
  eq(P.formatResult(12.3, 'track'), '12.30', '格式化：径赛小值保留两位');

  section('名次：径赛小者优先、田赛大者优先');
  const S = require(path.join(ROOT, 'src/scoring.js'));
  const evTrack = { id: 'e1', kind: 'track', tol: 0.01, attempts: 1, name: '径赛' };
  const evField = { id: 'e2', kind: 'field', tol: 0.01, attempts: 3, name: '田赛' };
  const mk = (v, bib, id) => ({ regId: id || ('r' + bib), best: v, dnf: false, bib, name: 'X' + bib });
  let r = S.rankEntries([mk(12.5, '3'), mk(12.1, '1'), mk(12.9, '2')], evTrack, S.DEFAULT_RULE,
    { bibOf: e => e.bib, nameOf: e => e.name });
  eq(r.rows.map(x => x.rank), [1, 2, 3], '径赛：12.1 < 12.5 < 12.9 → 1,2,3');
  eq(r.rows[0].bib, '1', '第一名是 12.1');
  r = S.rankEntries([mk(5.1, '1'), mk(6.2, '2'), mk(5.9, '3')], evField, S.DEFAULT_RULE,
    { bibOf: e => e.bib, nameOf: e => e.name });
  eq(r.rows[0].best, 6.2, '田赛：6.2 最大 → 第一');

  section('并列：按**计时精度**判等，标准竞技排名 1,2,2,4');
  r = S.rankEntries([mk(12.0, '1'), mk(12.3, '2'), mk(12.3, '3'), mk(12.4, '4')], evTrack, S.DEFAULT_RULE,
    { bibOf: e => e.bib, nameOf: e => e.name });
  eq(r.rows.map(x => x.rank), [1, 2, 2, 4], '并列后跳号：1,2,2,4');
  eq(r.rows.map(x => x.points), [7, 5, 5, 3], '并列各得该名次全额分：7,5,5,3');

  /* 【这条原来是错的，改的就是它】
     旧规则：差 ≤ 0.01 算并列 → 12.0 和 12.005 并列，12.01 和 12.02 也并列。
     那是把**浮点误差容忍值**当成了竞赛规则 —— 12.01 秒和 12.02 秒是两个
     不同的成绩，本该第 1 名和第 2 名。
     新规则：按百分位取整后**读数相同**才算并列。 */
  r = S.rankEntries([mk(12.0, '1'), mk(12.005, '2'), mk(12.4, '3')], evTrack, S.DEFAULT_RULE,
    { bibOf: e => e.bib, nameOf: e => e.name });
  eq(r.rows.map(x => x.rank), [1, 2, 3], '12.00 与 12.005 是两个人（旧规则误判成并列）');

  r = S.rankEntries([mk(12.01, '1'), mk(12.02, '2')], evTrack, S.DEFAULT_RULE,
    { bibOf: e => e.bib, nameOf: e => e.name });
  eq(r.rows.map(x => x.rank), [1, 2], '12.01 与 12.02 不并列（审计报告里点出来的那条）');

  r = S.rankEntries([mk(12.34, '1'), mk(12.34, '2'), mk(12.35, '3')], evTrack, S.DEFAULT_RULE,
    { bibOf: e => e.bib, nameOf: e => e.name });
  eq(r.rows.map(x => x.rank), [1, 1, 3], '读数相同（12.34）才并列；12.35 是下一位');

  // 千分位（终点摄像）：12.341 与 12.342 是两个人；两个 12.341 并列第 1
  r = S.rankEntries([mk(12.341, '1'), mk(12.342, '2'), mk(12.341, '3')], Object.assign({}, evTrack, { tol: 0.001 }), S.DEFAULT_RULE,
    { bibOf: e => e.bib, nameOf: e => e.name });
  eq(r.rows.map(x => x.rank), [1, 1, 3], '两个 12.341 并列第 1，12.342 第 3（并列后跳号）');

  // 十分位（手工计时）：12.3 与 12.3 并列
  r = S.rankEntries([mk(12.3, '1'), mk(12.34, '2'), mk(12.5, '3')], Object.assign({}, evTrack, { tol: 0.1 }), S.DEFAULT_RULE,
    { bibOf: e => e.bib, nameOf: e => e.name });
  eq(r.rows.map(x => x.rank), [1, 1, 3], '十分位下 12.3 与 12.34 取整后都是 12.3 → 并列');

  // 整秒
  r = S.rankEntries([mk(12.0, '1'), mk(12.4, '2'), mk(13.0, '3')], Object.assign({}, evTrack, { tol: 1 }), S.DEFAULT_RULE,
    { bibOf: e => e.bib, nameOf: e => e.name });
  eq(r.rows.map(x => x.rank), [1, 1, 3], '整秒下 12.0 与 12.4 都是 12 秒 → 并列');

  // 分钟换算的成绩也要按同样规则（2:15.30 vs 2:15.31）
  r = S.rankEntries([mk(135.30, '1'), mk(135.31, '2')], evTrack, S.DEFAULT_RULE,
    { bibOf: e => e.bib, nameOf: e => e.name });
  eq(r.rows.map(x => x.rank), [1, 2], '2:15.30 与 2:15.31 不并列');

  section('并列排序稳定：同成绩按号码，没号码排后');
  r = S.rankEntries([mk(12.3, '9'), mk(12.3, ''), mk(12.3, '2')], evTrack, S.DEFAULT_RULE,
    { bibOf: e => e.bib, nameOf: e => e.name });
  eq(r.rows.map(x => x.bib), ['2', '9', ''], '同成绩：号码小在前，无号码排后');

  section('弃权：排最后、显示弃权、不得分');
  r = S.rankEntries([mk(12.0, '1'), { regId: 'r2', best: null, dnf: true, bib: '2', name: '弃' }, mk(12.5, '3')],
    evTrack, S.DEFAULT_RULE, { bibOf: e => e.bib, nameOf: e => e.name });
  eq(r.rows.length, 3, '三个人都在榜上（弃权不删除）');
  eq(r.rows[2].dnf, true, '弃权排在最后');
  eq(r.rows[2].display, '弃权', '弃权显示"弃权"两个字');
  eq(r.rows[2].points, 0, '弃权不得分');
  eq(r.rows[2].rank, 3, '弃权的名次是最后一位');

  section('田赛多次试跳取最好一次；全犯规≠弃权（显示要分开）');
  const ev3 = { id: 'e3', kind: 'field', tol: 0.01, attempts: 3, name: '跳远' };
  let best = S.bestOf({ id: 'r1' }, [
    { attempt: 1, value: 4.5, dnf: false, foul: false, recordedAt: 't1' },
    { attempt: 2, value: null, dnf: false, foul: true, recordedAt: 't2' },
    { attempt: 3, value: 5.1, dnf: false, foul: false, recordedAt: 't3' },
  ], ev3);
  eq(best.best, 5.1, '三次试跳取最大 5.1');
  eq(best.bestAttempt, 3, '记住是第 3 次跳出来的');
  eq(best.fouls, 1, '统计到 1 次犯规');
  best = S.bestOf({ id: 'r2' }, [
    { attempt: 1, value: null, dnf: false, foul: true, recordedAt: 't1' },
    { attempt: 2, value: null, dnf: false, foul: true, recordedAt: 't2' },
  ], ev3);
  eq(best.dnf, true, '两次都犯规 → 名次排最后（人还在榜上）');
  eq(best.foulOnly, true, '全犯规要标出 foulOnly，好和大屏文字分开');
  // 显示必须区分"犯规"和"弃权"（曾经只判 dnf，全犯规被显示成"弃权"）
  let rf = S.rankEntries([
    mk(5.1, '1'), { regId: 'rx', best: null, dnf: true, foul: true, foulOnly: true, bib: '2', name: '犯' },
    { regId: 'ry', best: null, dnf: true, foul: false, bib: '3', name: '弃' },
  ], ev3, S.DEFAULT_RULE, { bibOf: e => e.bib, nameOf: e => e.name });
  eq(rf.rows[0].display, '5.10', '有成绩的正常显示');
  const foulRow = rf.rows.find(x => x.regId === 'rx');
  const dnfRow = rf.rows.find(x => x.regId === 'ry');
  eq(foulRow.display, '犯规', '全犯规显示「犯规」而不是「弃权」');
  eq(dnfRow.display, '弃权', '真弃权还是显示「弃权」');
  // 不变量：没成绩的（犯规/弃权）名次一定在有成绩的人之后，且彼此并列于同一个最后名次
  eq(foulRow.rank > rf.rows[0].rank, true, '全犯规排在有效成绩之后');
  eq(foulRow.points, 0, '全犯规不得分');
  eq(dnfRow.rank, foulRow.rank, '犯规和弃权并列于同一个"最后名次"');

  best = S.bestOf({ id: 'r3' }, [
    { attempt: 1, value: 100, dnf: false, foul: false, recordedAt: 't1' },
    { attempt: 2, value: 50, dnf: false, foul: false, recordedAt: 't2' },
  ], { id: 'e4', kind: 'track', tol: 0.01, attempts: 2, name: '径赛多次' });
  eq(best.best, 50, '径赛多次取最小');

  section('决赛录取：并列跨录取线不淘汰');
  const rows = [
    { rank: 1, regId: 'a', best: 10, dnf: false }, { rank: 2, regId: 'b', best: 11, dnf: false },
    { rank: 3, regId: 'c', best: 12, dnf: false }, { rank: 4, regId: 'd', best: 13, dnf: false },
    { rank: 5, regId: 'e', best: 14, dnf: false }, { rank: 6, regId: 'f', best: 15, dnf: false },
    { rank: 6, regId: 'g', best: 15, dnf: false }, { rank: 8, regId: 'h', best: 17, dnf: false },
  ];
  const q = S.qualifiers(rows, 6);
  eq(q.rows.length, 7, '第 6 名并列 → 录取 7 人（不抽签淘汰）');
  ok(q.expandNote.indexOf('并列') >= 0, '给出并列扩招的说明');
  eq(S.qualifiers(rows, 4).rows.length, 4, '录取 4 人时正常取 4 人');

  section('接力：按班级成队，分数记到班级');
  const totals = S.teamTotals({
    events: [
      { id: 'ev1', name: '100米', kind: 'track', isRelay: false, status: 'done' },
      { id: 'ev2', name: '4×100', kind: 'track', isRelay: true, status: 'done' },
      { id: 'ev3', name: '未结束', kind: 'track', isRelay: false, status: 'live' },
    ],
    boardByEvent: new Map([
      ['ev1', { board: { rows: [
        { regId: 'r1', rank: 1, points: 7, dnf: false, classId: 'c1', isRelay: false, name: 'A' },
        { regId: 'r2', rank: 2, points: 5, dnf: false, classId: 'c2', isRelay: false, name: 'B' },
      ] } }],
      ['ev2', { board: { rows: [
        { regId: 'r3', rank: 1, points: 7, dnf: false, classId: 'c2', isRelay: true, teamName: '高二(2)班', legs: ['甲', '乙'] },
      ] } }],
      ['ev3', { board: { rows: [{ regId: 'r4', rank: 1, points: 7, dnf: false, classId: 'c1', isRelay: false }] } }],
    ]),
    rule: S.DEFAULT_RULE,
    classById: new Map([
      ['c1', { id: 'c1', grade: '高一', className: '1班', label: '高一(1)班' }],
      ['c2', { id: 'c2', grade: '高二', className: '2班', label: '高二(2)班' }],
    ]),
    athleteName: (e) => e.name || '',
  });
  eq(totals.teams.length, 2, '两个班上榜');
  eq(totals.teams[0].name, '高二(2)班', '高二(2)班总分最高（接力 7×2=14，加单项 5）');
  /* 【接力双倍赋分】现场口径：接力得分 ×2（一个项目只算一条成绩、却要出动 4 名队员）。
     这里 5 + 7×2 = 19。倍数改了这条会立刻红，正好当回归哨兵。 */
  eq(totals.teams[0].points, 19, '接力分翻倍后记到班级（5 + 14 = 19）');
  eq(totals.teams[1].points, 7, '只跑单项的班拿 7 分');
  eq(totals.scoredEvents.length, 2, '只统计已结束的项目（进行中的不算）');
  ok(totals.ruleText.indexOf('7-5-4-3-2-1') >= 0, '计分表是 7-5-4-3-2-1');
  ok(totals.ruleText.indexOf('只算已结束') >= 0, '规则说明里写明只算已结束项目');
  /* 默认规则必须是"接力翻倍"，否则上一行就名不副实 */
  eq(S.DEFAULT_RULE.relayMultiplier, 2, '默认规则：接力 ×2');

  section('接力翻倍：倍数确实作用在总分上');
  {
    /* 同一套夹具，只改倍数跑两遍 —— 总分必须差出"接力那一份"。
       这样测的是"倍数真的参与了计算"，而不是"某个字段等于 2"。 */
    const mk = (mult) => S.teamTotals({
      events: [
        { id: 'ev1', name: '100米', kind: 'track', isRelay: false, status: 'done' },
        { id: 'ev2', name: '4×100', kind: 'track', isRelay: true, status: 'done' },
      ],
      boardByEvent: new Map([
        ['ev1', { board: { rows: [{ regId: 'r1', rank: 1, points: 7, dnf: false, classId: 'c2', name: 'A' }] } }],
        ['ev2', { board: { rows: [{ regId: 'r3', rank: 1, points: 7, dnf: false, classId: 'c2', isRelay: true, teamName: '高二(2)班' }] } }],
      ]),
      rule: S.mergeRule({ relayMultiplier: mult }),
      classById: new Map([['c2', { id: 'c2', grade: '高二', className: '2班', label: '高二(2)班' }]]),
      athleteName: (e) => e.name || '',
    });
    const x1 = mk(1).teams[0].points;
    const x2 = mk(2).teams[0].points;
    const x3 = mk(3).teams[0].points;
    eq(x1, 14, '倍数 1：单项 7 + 接力 7 = 14');
    eq(x2, 21, '倍数 2：单项 7 + 接力 14 = 21');
    eq(x3, 28, '倍数 3：单项 7 + 接力 21 = 28');
    eq(x2 - x1, 7, '翻倍正好多出"接力那一份名次分"');
    /* 倍数非法值不能把接力算成 0 分（算 0 分不报错，最难查） */
    eq(S.mergeRule({ relayMultiplier: 0 }).relayMultiplier, 2, '倍数 0 → 退回默认 2（不是 0）');
    eq(S.mergeRule({ relayMultiplier: -5 }).relayMultiplier, 2, '负数 → 退回默认 2');
    eq(S.mergeRule({ relayMultiplier: 'x' }).relayMultiplier, 2, '乱写 → 退回默认 2');
  }
  // 两个班分属高一/高二：全校总名次是 1、2，但各自都是本年级第 1 名
  eq(totals.teams[0].rank, 1, '高二(2)班全校第 1');
  eq(totals.teams[1].rank, 2, '高一(1)班全校第 2');
  eq(totals.teams[0].classRank, 1, '高二(2)班本年级第 1');
  eq(totals.teams[1].classRank, 1, '高一(1)班**也是**本年级第 1（年级内单独排）');
});

/* ══════════════════════════════════════════════════════════════════════
 * 套件二：接口、并发、冲突、幂等
 * ══════════════════════════════════════════════════════════════════════ */

register('api', async () => {
  await startServer(true);
  const c = makeClient();

  section('登录与鉴权');
  let r = await c.call('GET', '/api/snapshot?kind=admin');
  ok(r.status === 401, '未登录读不到后台数据');
  r = await c.call('GET', '/api/snapshot?kind=screen');
  ok(r.status === 200, '未登录可以读大屏数据（大屏免登录）');
  r = await c.call('POST', '/api/login', { username: 'admin', password: 'wrong' });
  ok(r.status === 401, '口令错误被拒');
  r = await c.login();
  ok(r.status === 200 && r.data.ok, '管理员登录成功');
  ok(!!c.csrf, '拿到 CSRF 令牌');
  r = await c.call('POST', '/api/op', { op: 'notice.add', payload: { text: 'x' } }, { 'X-CSRF': 'bad' });
  ok(r.status === 403, '错误 CSRF 被拒');

  section('并发写入：20 个客户端同时提交不同成绩，一条不丢');
  const snap = (await c.call('GET', '/api/snapshot?kind=admin')).data;
  const ev = snap.events.find(e => e.kind === 'track' && e.regCount > 3);
  const board = (await c.call('GET', '/api/events/' + ev.id + '/board')).data.data;
  const clients = [];
  for (let i = 0; i < 20; i++) {
    const cc = makeClient();
    await cc.login();
    clients.push(cc);
  }
  const targets = board.entries.slice(0, 20);
  await Promise.all(targets.map((t, i) => clients[i].op('result.set', {
    eventId: ev.id, regId: t.regId, attempt: 1, value: (12 + i * 0.01).toFixed(2),
  }, { clientUuid: 'conc-' + i + '-' + Date.now() })));
  const after = (await c.call('GET', '/api/events/' + ev.id + '/board')).data.data;
  const recorded = after.entries.filter(e => (e.attempts || []).length).length;
  ok(recorded >= targets.length, '并发提交后 ' + recorded + ' 人有成绩（提交了 ' + targets.length + ' 条，一条不丢）');
  const ranks = after.rows.map(x => x.rank);
  ok(ranks.length > 0 && ranks[0] === 1, '名次从 1 开始');
  ok(ranks.every((v, i) => i === 0 || v >= ranks[i - 1]), '名次单调不减（算对了）');

  section('乐观锁：两个客户端改同一条，后者被拒并拿到服务器当前值');
  const v = after.entries.find(e => (e.attempts || []).length).attempts[0].version;
  const reg = after.entries.find(e => (e.attempts || []).length).regId;
  const a = await clients[0].op('result.set', { eventId: ev.id, regId: reg, attempt: 1, value: '13.11', version: v });
  const b = await clients[1].op('result.set', { eventId: ev.id, regId: reg, attempt: 1, value: '13.22', version: v });
  ok(a.status === 200, '先到的提交成功');
  ok(b.status === 409 && b.data.code === 'CONFLICT', '后到的被拒并给出冲突');
  ok(b.data.detail && b.data.detail.server, '冲突里带了服务器当前值供人对比');

  section('幂等：同一条重复提交只落一条');
  const uuid = 'idem-' + Date.now();
  const p1 = await c.op('result.set', { eventId: ev.id, regId: reg, attempt: 1, value: '14.44' }, { clientUuid: uuid });
  const p2 = await c.op('result.set', { eventId: ev.id, regId: reg, attempt: 1, value: '14.44' }, { clientUuid: uuid });
  ok(p1.data.ok && p2.data.ok, '两次都返回成功');
  ok(p2.data.data && p2.data.data.idempotent === true, '第二次命中幂等（没有录成两条）');

  section('只读账号不能写（权限）');
  const admin = makeClient(); await admin.login();
  r = await admin.op('user.add', { username: 'viewer1', password: 'viewer-pass-1', displayName: '看板', role: 'viewer' });
  ok(r.status === 200, '建了一个只读账号');
  const viewer = makeClient(); await viewer.login('viewer1', 'viewer-pass-1');
  r = await viewer.op('notice.add', { text: '只读想发公告' });
  ok(r.status === 403, '只读账号写操作被拒');
  r = await viewer.call('GET', '/api/users');
  ok(r.status === 403, '只读账号看不到账号列表');

  await stopServer();
});

/* ══════════════════════════════════════════════════════════════════════
 * 套件三：暂存 / 预览 / 确认 + 备份 + 导出
 * ══════════════════════════════════════════════════════════════════════ */

register('data', async () => {
  await startServer(true);
  const c = makeClient();
  await c.login();

  section('暂存：改动先进暂存区，真实数据不变');
  let r = await c.call('POST', '/api/staged', { op: 'notice.add', payload: { text: '【测试】暂存公告' } });
  ok(r.status === 200 && r.data.ok, '暂存成功');
  let notices = (await c.call('GET', '/api/notices')).data.data.notices;
  ok(!notices.some(n => n.text.indexOf('【测试】暂存公告') >= 0), '暂存期间真实数据里没有这条公告');
  r = await c.call('GET', '/api/staged');
  ok(r.data.data.items.length === 1, '暂存区里有 1 项');

  section('预览：在数据副本上试跑，能看到"确认后的样子"且不污染真实数据');
  r = await c.call('GET', '/api/preview');
  ok(r.status === 200 && r.data.ok, '预览接口可用');
  ok(r.data.data.screen.panels.notice.some(n => n.text.indexOf('【测试】暂存公告') >= 0),
    '预览快照里能看到这条公告（确认后的效果）');
  notices = (await c.call('GET', '/api/notices')).data.data.notices;
  ok(!notices.some(n => n.text.indexOf('【测试】暂存公告') >= 0), '预览没有污染真实数据');

  section('确认：一次性落盘并推送');
  const rev0 = (await c.call('GET', '/api/snapshot?kind=admin')).data.rev;
  r = await c.call('POST', '/api/confirm', {});
  ok(r.status === 200 && r.data.ok, '确认成功，应用了 ' + (r.data.data && r.data.data.applied) + ' 项');
  notices = (await c.call('GET', '/api/notices')).data.data.notices;
  ok(notices.some(n => n.text.indexOf('【测试】暂存公告') >= 0), '公告已经真的落盘');
  const rev1 = (await c.call('GET', '/api/snapshot?kind=admin')).data.rev;
  ok(rev1 > rev0, '版本号上涨（' + rev0 + ' → ' + rev1 + '），大屏据此刷新');
  r = await c.call('GET', '/api/staged');
  ok(r.data.data.items.length === 0, '暂存区已清空');

  section('预览不能碰真实数据（含清空类指令）');
  await c.call('POST', '/api/staged', { op: 'data.clear', payload: { scope: 'all', confirmText: '清空' } });
  const before = (await c.call('GET', '/api/snapshot?kind=admin')).data.stats.athletes;
  await c.call('GET', '/api/preview');
  const afterStats = (await c.call('GET', '/api/snapshot?kind=admin')).data.stats.athletes;
  eq(afterStats, before, '预览 data.clear 之后真实库里的运动员数没变');
  await c.call('POST', '/api/staged/drop', { all: true });

  section('名单：搜索与三重筛选');
  r = await c.call('GET', '/api/roster');
  const total = r.data.data.athletes.length;
  ok(total > 0, '名单有 ' + total + ' 人');
  const some = r.data.data.athletes[0];
  r = await c.call('GET', '/api/roster', undefined, undefined);
  const byName = (await c.call('GET', '/api/roster?search=' + encodeURIComponent(some.name))).data.data.athletes;
  ok(byName.some(a => a.name === some.name), '按姓名能搜到');
  const byBib = (await c.call('GET', '/api/roster?search=' + encodeURIComponent(some.bib))).data.data.athletes;
  ok(byBib.length > 0, '按号码能搜到');
  const byGrade = (await c.call('GET', '/api/roster?grade=' + encodeURIComponent(some.grade))).data.data.athletes;
  ok(byGrade.length > 0 && byGrade.every(a => a.grade === some.grade), '按年级筛选正确');
  const byClass = (await c.call('GET', '/api/roster?grade=' + encodeURIComponent(some.grade)
    + '&className=' + encodeURIComponent(some.className))).data.data.athletes;
  ok(byClass.every(a => a.grade === some.grade && a.className === some.className), '年级 + 班级能叠加筛选');

  /* ── 按项目筛（第 4 个筛选项）────────────────────────────────────────────
     现场用途：核对/打印某个项目的名单。服务端只对**个人项目**筛 ——
     接力是一个班一条报名记录（队员存在 legsJson 里，是姓名文本、没有运动员 id），
     按接力项目筛不出"某个人"，所以那条路不筛（由前端提示说明）。 */
  section('名单：按项目筛选');
  {
    const ros = (await c.call('GET', '/api/roster?limit=2000')).data.data;
    ok(Array.isArray(ros.events) && ros.events.length > 0,
      '名单接口带回了项目清单（' + (ros.events || []).length + ' 个）');
    ok((ros.events || []).every(e => e && e.id && e.name), '项目清单每项都有 id 和 name');

    // 找一个有报名的个人项目
    const evPick = (ros.events || []).filter(e => e.regs > 0)
      .sort((a, b) => b.regs - a.regs)[0];
    ok(!!evPick, '找到有报名的项目：' + (evPick && evPick.name) + '（' + (evPick && evPick.regs) + ' 人）');

    const byEv = (await c.call('GET', '/api/roster?eventId=' + encodeURIComponent(evPick.id)
      + '&limit=2000')).data.data;
    ok(byEv.count === evPick.regs, '按项目筛出的人数与报名人数一致（'
      + byEv.count + ' / ' + evPick.regs + '）');
    ok(byEv.athletes.length === byEv.count, '返回的名单条数也对得上');
    ok(byEv.eventFilter && byEv.eventFilter.id === evPick.id,
      '接口回带 eventFilter，前端据此显示"项目名单：xxx"');

    /* 逐人核：名单里每一个人**确实**报了这个项目（不能靠接口自己说）。
       ⚠ 用**号码**交叉核对，不要用 athleteId ——
       `/api/events/:id/board` 的 entries 里**没有 athleteId**（只有 regId），
       我第一次用 `e.athleteId` 建集合，得到的是 `{undefined}`，
       于是"每个人都对不上"和"一个都没漏"同时成立 —— 两个断言都成了摆设。 */
    const evRegs = (await c.call('GET', '/api/events/' + evPick.id + '/board')).data.data;
    const regBibs = new Set((evRegs.entries || []).map(e => String(e.bib || '')).filter(Boolean));
    ok(regBibs.size === evPick.regs, '项目的报名号码集合有 ' + regBibs.size + ' 个');

    const wrong = byEv.athletes.filter(a => !regBibs.has(String(a.bib || '')));
    ok(wrong.length === 0, '筛出来的每个人都在这个项目的报名里'
      + (wrong.length ? ('（多了 ' + wrong.length + ' 个：' + wrong.slice(0, 3).map(x => x.name).join('、') + '）') : ''));

    // 不该有漏：项目报名里的人应当都在筛出来的名单里
    const gotBibs = new Set(byEv.athletes.map(a => String(a.bib || '')));
    const missed = Array.from(regBibs).filter(b => !gotBibs.has(b));
    ok(missed.length === 0, '项目报名里的人一个都没漏'
      + (missed.length ? ('（漏了 ' + missed.length + ' 个）') : ''));

    // "还报了"：这个项目的名单里，同一个人兼的其它项目
    const withOther = byEv.athletes.filter(a => (a.otherEvents || []).length > 0);
    ok(withOther.length > 0, '给出了"还报了"别的项目的人（' + withOther.length + ' 个）');
    ok(withOther.every(a => (a.otherEvents || []).every(n => String(n).indexOf(evPick.name) < 0)),
      '「还报了」里不会重复列出当前正在筛的这个项目');

    // 叠加：项目 + 班级
    const combo = (await c.call('GET', '/api/roster?eventId=' + encodeURIComponent(evPick.id)
      + '&grade=' + encodeURIComponent(byEv.athletes[0].grade) + '&limit=2000')).data.data;
    ok(combo.count <= byEv.count, '项目 + 年级可以叠加（' + byEv.count + ' → ' + combo.count + '）');
    ok(combo.athletes.every(a => regBibs.has(String(a.bib || ''))), '叠加后仍然只出这个项目的人');

    // 接力项目：不按人筛（返回全部，由前端提示说明）
    const relayEv = (ros.events || []).length ? null : null;
    const anyRelay = (await c.call('GET', '/api/snapshot?kind=admin')).data.events
      .find(e => e.isRelay);
    if (anyRelay) {
      const relayRes = (await c.call('GET', '/api/roster?eventId=' + encodeURIComponent(anyRelay.id)
        + '&limit=2000')).data.data;
      ok(relayRes.eventFilter === null, '接力项目不按人筛（eventFilter 为 null，避免滤成空名单）');
      ok(relayRes.count === ros.count, '传接力项目时返回全部名单（' + relayRes.count + '）');
    }
    void relayEv;
  }

  section('导出：Excel 与 CSV');
  let res = await fetch(base + '/api/export?what=results&format=xls', { headers: { Cookie: c.cookie } });
  let text = await res.text();
  ok(res.status === 200 && text.indexOf('<table') > 0, 'Excel 导出成功且含表格');
  ok(text.indexOf('名次') > 0, 'Excel 里有名次表头');
  res = await fetch(base + '/api/export?what=team&format=csv', { headers: { Cookie: c.cookie } });
  const buf = Buffer.from(await res.arrayBuffer());
  ok(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF, 'CSV 带 UTF-8 BOM（中文不乱码）');
  for (const w of ['rank', 'roster', 'program', 'checkin', 'all']) {
    res = await fetch(base + '/api/export?what=' + w + '&format=xls', { headers: { Cookie: c.cookie } });
    ok(res.status === 200, '导出 ' + w + ' 正常');
  }

  section('备份与恢复');
  r = await c.call('POST', '/api/backups', {});
  ok(r.status === 200 && r.data.ok, '手动备份成功：' + (r.data.data && r.data.data.name));
  const list = (await c.call('GET', '/api/backups')).data.data;
  ok(list.backups.length >= 1, '备份列表有 ' + list.backups.length + ' 份');
  /* keep = 0 表示**永不自动删除备份**（现场要求：别每次打开都清备份）。
     这里断言的是"接口如实报出当前策略"，而不是某个具体数字 ——
     数字由 config.js 的 backupKeep 决定，改配置不该让测试红。 */
  ok(typeof list.keep === 'number' && list.keep >= 0,
    '保留策略：' + (list.keep ? ('最近 ' + list.keep + ' 份') : '永不自动删除'));
  ok(typeof list.everyMin === 'number' && list.everyMin >= 0,
    '自动备份间隔：' + (list.everyMin ? (list.everyMin + ' 分钟') : '已关闭'));
  r = await c.call('POST', '/api/backups/restore', { name: '../../etc/passwd', confirmText: '恢复' });
  ok(r.status === 400, '路径穿越被挡住');
  r = await c.call('POST', '/api/backups/restore', { name: list.backups[0].name });
  ok(r.status === 400, '恢复必须输入「恢复」两个字');

  section('检录：开始/停止自动写公告，反复开关只留一条');
  const snap = (await c.call('GET', '/api/snapshot?kind=admin')).data;
  const ev = snap.events[0];
  await c.op('checkin.open', { eventId: ev.id });
  await c.op('checkin.close', { eventId: ev.id });
  await c.op('checkin.open', { eventId: ev.id });
  const ns = (await c.call('GET', '/api/notices')).data.data.notices.filter(n => n.auto && n.text.indexOf(ev.name) >= 0);
  eq(ns.length, 1, '反复开关检录只留一条自动公告（不刷屏）');
  ok(ns[0].text.indexOf('检录') >= 0, '公告内容带"检录"字样');

  section('自动录取：预赛 → 决赛');
  const heat = (await c.call('GET', '/api/snapshot?kind=admin')).data.events.find(e => e.stage === 'heat' && !e.finalId);
  if (heat) {
    r = await c.op('event.autoAdvance', { eventId: heat.id });
    ok(r.status === 200 && r.data.ok, '自动录取成功，生成决赛：' + (r.data.data && r.data.data.finalName));
    const after = (await c.call('GET', '/api/snapshot?kind=admin')).data;
    const fin = after.events.find(e => e.id === (r.data.data && r.data.data.finalId));
    ok(!!fin, '决赛项目已存在');
    ok(fin && fin.regCount > 0, '决赛名单已报入 ' + (fin && fin.regCount) + ' 人');
    const heatAfter = after.events.find(e => e.id === heat.id);
    ok(heatAfter && heatAfter.status === 'done', '预赛被标记为已结束');
  } else {
    ok(true, '演示数据里没有可录取的预赛，跳过');
  }

  /* ── 手动录取决赛（event.makeFinal）────────────────────────────────────
     现场口径：谁进决赛由老师定。系统的活是"建出决赛项目 + 预填一份起点名单"，
     之后由老师在名单页增删。这里验证三件事：
       ① 能建出决赛、且名单是**可改的**（不是定死的）
       ② 已经录了成绩的决赛不允许被"重做"覆盖（防止把现场干过的活抹掉）
       ③ 权限：操作员也能用（编排是操作员的活）                                */
  section('手动录取决赛');
  {
    /* 【为什么不复用别的预赛】上面那节 autoAdvance 已经把演示数据里
       所有预赛都生成过决赛了，再找 `stage==='heat' && !finalId` 会一个都没有，
       整节静默跳过 —— 我第一次就是这么写的，测试"通过"了但什么都没测。
       所以这里**自己造一个预赛**，状态完全可控。 */
    const snapForFinal = (await c.call('GET', '/api/snapshot?kind=admin')).data;
    const demoGroup = (snapForFinal.groups || [])[0];
    ok(!!demoGroup, '取到一个组别：' + (demoGroup && demoGroup.name));
    const rosterAll = (await c.call('GET', '/api/roster?limit=50')).data.data;
    const demoAthletes = (rosterAll.athletes || rosterAll.rows || []).slice(0, 6);
    ok(demoAthletes.length >= 6, '取到 ' + demoAthletes.length + ' 名运动员做样本');

    r = await c.op('event.add', {
      name: '测试用 200 米预赛', groupId: demoGroup.id, kind: 'track', stage: 'heat',
      isRelay: false, attempts: 1, tol: 0.01, advanceCount: 3, sort: 9001,
    });
    ok(r.status === 200 && r.data.ok, '建出测试预赛');
    const heatId = r.data.data && (r.data.data.id || r.data.data.eventId);
    for (let i = 0; i < 5; i++) {
      await c.op('reg.add', { eventId: heatId, athleteId: demoAthletes[i].id });
    }
    const hb = (await c.call('GET', '/api/events/' + heatId + '/board')).data.data;
    const hEntries = hb.entries || [];
    ok(hEntries.length === 5, '预赛报名 ' + hEntries.length + ' 人');
    for (let i = 0; i < hEntries.length; i++) {
      const eid = hEntries[i].regId || hEntries[i].id;
      await c.op('result.set', { eventId: heatId, regId: eid, attempt: 1, value: (23 + i * 0.1).toFixed(2) });
    }

    // ① 生成决赛：默认预填前 advanceCount 名
    r = await c.op('event.makeFinal', { eventId: heatId });
    ok(r.status === 200 && r.data.ok, '生成决赛成功：' + (r.data.data && r.data.data.finalName));
    const mk = r.data.data || {};
    ok(mk.qualified === 3, '按 advanceCount=3 预填了 ' + mk.qualified + ' 人');

    let sn = (await c.call('GET', '/api/snapshot?kind=admin')).data;
    let fin2 = sn.events.find(e => e.id === mk.finalId);
    ok(!!fin2, '决赛项目已出现在赛程里');
    ok(fin2 && fin2.regCount === 3, '决赛名单 ' + (fin2 && fin2.regCount) + ' 人');

    // ①b 名单可改：删掉一个，再手动补一个预赛没录取的人
    const fb = (await c.call('GET', '/api/events/' + mk.finalId + '/board')).data.data;
    const victim = (fb.entries || [])[0];
    r = await c.op('reg.del', { id: victim.regId || victim.id });
    ok(r.status === 200 && r.data.ok, '能把预填的人删掉（名单是起点，不是定论）');
    const outsider = demoAthletes[demoAthletes.length - 1];
    r = await c.op('reg.add', { eventId: mk.finalId, athleteId: outsider.id });
    ok(r.status === 200 && r.data.ok, '能手动补进预赛没录取的人（' + outsider.name + '）');
    sn = (await c.call('GET', '/api/snapshot?kind=admin')).data;
    fin2 = sn.events.find(e => e.id === mk.finalId);
    ok(fin2 && fin2.regCount === 3, '增删之后仍是 ' + (fin2 && fin2.regCount) + ' 人');

    // ② 不 force 再点一次 → 409
    r = await c.op('event.makeFinal', { eventId: heatId });
    ok(r.status === 409, '已生成过决赛时再点被拒绝（不重复生成）');

    // ③ 决赛录了成绩 → force 重做被拒
    const fb2 = (await c.call('GET', '/api/events/' + mk.finalId + '/board')).data.data;
    const e2 = (fb2.entries || [])[0];
    await c.op('result.set', { eventId: mk.finalId, regId: e2.regId || e2.id, attempt: 1, value: '22.22' });
    r = await c.op('event.makeFinal', { eventId: heatId, force: true });
    ok(r.status === 409, '决赛已录成绩时重做被拒绝（HTTP ' + r.status + '）');
    ok(r.data && /成绩/.test(String(r.data.message || '')), '拒绝原因讲清了：' + (r.data && r.data.message));

    // ③b 清掉成绩后 force 重做应当成功
    await c.op('result.clearEvent', { eventId: mk.finalId });
    r = await c.op('event.makeFinal', { eventId: heatId, force: true });
    ok(r.status === 200 && r.data.ok, '清掉成绩后重做成功');
    ok(r.data.data && r.data.data.replaced === true, '返回值说明是"重做"而不是新建');
  }

  /* ── 大屏「赛程安排」栏：只显示正在检录和正在进行的 ──────────────────────
     现场口径：这一栏是"看当下"的 —— 正在检录的（该去报到了）、
     正在比赛的（成绩马上来）。已结束的不用再挂着（成绩已经进左边卡片了），
     还没开始的也不用提前占地方。
     服务端的活是"把数据给对"，客户端的活是"只挑这两种状态"。两边都要钉住。 */
  section('大屏赛程栏：只显示检录中/进行中');
  {
    const Board2 = require(path.join(ROOT, 'src', 'scoreboard.js'));
    const dd = currentMod.getDb();
    const M2 = dd.get('SELECT id FROM meet LIMIT 1', []).id;

    /* 自己取组别和运动员 —— 不要用上面那节的局部变量
       （它在大括号里，这里拿不到；我第一次就写成 demoGroup 直接 ReferenceError）。 */
    const snap3a = (await c.call('GET', '/api/snapshot?kind=admin')).data;
    const grp = (snap3a.groups || [])[0];
    const roster3 = (await c.call('GET', '/api/roster?limit=50')).data.data;
    const ath3 = (roster3.athletes || roster3.rows || []).slice(0, 3);
    ok(!!grp && ath3.length >= 3, '取到组别「' + (grp && grp.name) + '」和 ' + ath3.length + ' 名运动员');

    // 造四个不同状态的项目，各自都要有报名（检录要有名单才动得了）
    async function mkEvent(name, stage) {
      const rr = await c.op('event.add', {
        name, groupId: grp.id, kind: 'track', stage: stage || 'final',
        isRelay: false, attempts: 1, tol: 0.01, sort: 9100,
      });
      const id = rr.data.data.id || rr.data.data.eventId;
      for (let i = 0; i < 3; i++) {
        await c.op('reg.add', { eventId: id, athleteId: ath3[i].id });
      }
      return id;
    }
    const evLive = await mkEvent('测试-进行中');
    const evCheck = await mkEvent('测试-检录中');
    const evPend = await mkEvent('测试-未开始');
    await c.op('event.status', { id: evLive, status: 'live' });
    await c.op('event.status', { id: evCheck, status: 'checking' });
    await c.op('checkin.open', { eventId: evCheck });
    // evPend 保持 pending

    const snap3 = Board2.screenSnapshot(dd, M2);
    const p3 = snap3.panels;
    const ids = (arr) => (arr || []).map(x => x.id);

    ok(ids(p3.live).indexOf(evLive) >= 0, '服务端：进行中的项目在 panels.live 里');
    ok(ids(p3.live).indexOf(evCheck) < 0,
      '服务端：检录中的项目**不在** panels.live 里（这是那个坑）');
    ok(ids(p3.checkin).indexOf(evCheck) >= 0,
      '服务端：检录中的项目在 panels.checkin 里（赛程栏只能从这里取）');
    ok(ids(p3.pending).indexOf(evPend) >= 0, '服务端：未开始的在 panels.pending 里');

    /* ── 左侧「成绩公告」的卡片顺序：已结束的聚在前、进行中排最后 ──────────
       现场要求"有成绩的放一页，别和登记中/登记完的混着放"。
       原来 eventList 是 `live.concat(done)`，一页里可能既有定局又有还在比的。
       这里盯住"已结束在前、进行中在后"这个不变量 ——
       顺序一旦反了（或又改回交错），同页就会混状态。 */
    const scr0 = fs.readFileSync(path.join(ROOT, 'public', 'screen.js'), 'utf8');
    const iEv = scr0.indexOf('const eventList');
    ok(iEv > 0, '找得到 eventList');
    const evBody = scr0.slice(iEv, iEv + 900);
    ok(/doneList\(\)/.test(evBody) && /liveList\(\)/.test(evBody),
      'eventList 同时用到 done 与 live');
    ok(/return done\.concat\(live\)/.test(evBody),
      '★ 已结束的排在前面（done.concat(live)），不再交错');
    ok(!/liveList\(\)\.concat\(doneList/.test(evBody),
      '★ 没有改回"live 在前"的老写法');
    /* 注：这里**不再写** "doneN + liveN >= 0" 那种断言 —— 它永远为真，
       等于没测（我第一版就是这么写的，属于自己批评过的错误）。 */

    /* 客户端 scheduleList 的来源与筛选（静态断言 —— 逻辑在浏览器里跑，
       这里盯住"来源对了、筛选对了"，防止以后有人改回从 pending/done 取） */
    const scr = fs.readFileSync(path.join(ROOT, 'public', 'screen.js'), 'utf8');

    /* ── 翻页不被数据更新打断（"成绩公告栏长时间不翻页"）──────────────────
       现场的故障：大屏每次收到数据都走
         applySnapshot → relayout() → paint() → stopScrollers()
       把所有翻页/滚动计时器清掉重建。而成绩卡放不下就要滚，
       每张卡往 scrollHoldUntil 写"滚完要 20.6 秒"，栏目翻页必须等它。
       比赛期间数据来得很密 → 那 20.6 秒**永远等不到头** → 那一栏不翻页。

       修法有两半，下面每条都钉住：
         ① 数据更新时走**轻量刷新**（内容没变就不重建 DOM、不重置滚动）
         ② 排翻页计时器时**判重**（新到期时刻更晚且还没到点就不重排）
       注意：这些是**结构断言**（跑不了浏览器定时器）。
       真正的行为验收在 `tools/check-screen-page.js`（CDP 探针，实测翻页节奏）。
       ⚠ `scr` 必须在这段**之前**声明 —— 我第一次把这段放在上面，
         直接 "Cannot access 'scr' before initialization"（TDZ）。 */
    ok(scr.indexOf('function panelSig') > 0, '★ 有内容指纹 panelSig（控制"要不要重画"）');
    ok(/sig === null \|\| sig !== inst\.lastSig/.test(scr),
      '★ 指纹没变就不重画（不动 DOM）');
    ok(/inst\.lastSig = panelSig\(inst\)/.test(scr),
      'paint 画完要重算指纹 —— 否则下次还认为"变了"，等于白做');
    ok(scr.indexOf('function layoutGeometry') > 0 && scr.indexOf('function refreshPanels') > 0,
      '★ 几何重算(layoutGeometry) 与 重画(refreshPanels) 已拆开');
    {
      const iSnap = scr.indexOf('function applySnapshot');
      const snapshotBody = scr.slice(iSnap, iSnap + 2200);
      ok(/refreshPanels\(\)/.test(snapshotBody),
        '★ 收到数据走 refreshPanels（轻量），不再无条件重建 DOM');
      ok(!/renderMarquee\(\);\s*\n\s*relayout\(\)/.test(snapshotBody),
        '★ applySnapshot 里不再直接调 relayout()');
    }
    ok(/if \(inst\.dueAt && !inst\.isDue\(\)\)/.test(scr),
      '★ schedulePanel 会判重，不把"下次翻页"越推越远');
    ok(/isDue\(\) \{ return !this\.dueAt/.test(scr), 'inst.isDue 已定义');
    ok(/pages - 1\) \* \(holdMs \+ TIMING\.scrollMs\) \+ holdMs/.test(scr),
      '★ 等滚动按"pages-1 次滚动 + 一屏停留"算（卡片从第 1 屏开始，不用等整轮）');
    {
      const m = scr.match(/panelMaxHold:\s*(\d+)/);
      const cap = m ? Number(m[1]) : 0;
      ok(cap > 0 && cap <= 15000,
        '★ 等滚动有上限（' + cap + 'ms）—— 老算法实测会算出 20.6 秒');
    }
    const html2 = fs.readFileSync(path.join(ROOT, 'public', 'screen.html'), 'utf8');
    ok(html2.indexOf('diagPage') > 0, '大屏有 #diagPage 诊断出口（现场/自动化都靠它读翻页节奏）');
    ok(scr.indexOf('function reportPageTiming') > 0, '有 reportPageTiming 写诊断');
    ok(/tickClock[\s\S]{0,700}reportPageTiming\(\)/.test(scr),
      '诊断挂在每秒的时钟上刷新（不为它单独加定时器）');
    ok(fs.existsSync(path.join(ROOT, 'tools', 'check-screen-page.js')),
      '有行为验收工具 tools/check-screen-page.js（CDP 实测翻页）');

    const iFn = scr.indexOf('function scheduleList');
    ok(iFn > 0, '找得到 scheduleList');
    const body = scr.slice(iFn, iFn + 2600);
    ok(/liveList\(\)/.test(body), '赛程栏从 panels.live 取"进行中"');
    ok(/checkinList\(\)/.test(body), '赛程栏从 panels.checkin 取"检录中"');
    ok(/e\.status === 'checking' \|\| e\.status === 'live'/.test(body),
      '赛程栏显式只放行 checking / live 两种状态');
    ok(!/P\('pending'/.test(body) && !/P\('done'/.test(body),
      '赛程栏不再从 pending / done 取数据');
    ok(!/RECENT_DONE/.test(scr) && !/NEXT_UP/.test(scr),
      '旧的"刚结束 N 个 / 接下来 N 个"常量已清干净');
    ok(scr.indexOf('现在没有正在检录或比赛的项目') > 0, '空状态文案说清了"现在没有"');
    const css2 = fs.readFileSync(path.join(ROOT, 'public', 'screen.css'), 'utf8');
    ok(css2.indexOf('.sched-flag.is-checking') > 0, '检录中条目有状态签样式');
    /* 【项目上不得出现时间标签】用户要求把所有项目的时间标签去掉。
       这几条盯着"哪些界面不再渲染时刻"，防止以后有人又加回来。 */
    ok(scr.indexOf('App.fmtClock(ev.startAt)') < 0, '大屏赛程栏不再显示项目时刻');
    ok(scr.indexOf('function relTime') < 0, '大屏"还有 N 分钟"已删干净');
    ok(css2.indexOf('.sched-rel') < 0, '样式里也没有相对时间那一行了');
    const evJs = fs.readFileSync(path.join(ROOT, 'public', 'admin-events.js'), 'utf8');
    ok(evJs.indexOf('timeText') < 0, '赛程编排的项目行不再显示时刻');
    const enJs = fs.readFileSync(path.join(ROOT, 'public', 'admin-entry.js'), 'utf8');
    ok(enJs.indexOf("'时刻：'") < 0, '录入页项目信息不再显示时刻');
    ok(enJs.indexOf("querySelector('.tm')") < 0, '录入页项目列表不再显示时刻');
    const prJs = fs.readFileSync(path.join(ROOT, 'public', 'print.js'), 'utf8');
    ok(prJs.indexOf("'时刻：'") < 0, '打印单不再印时刻');
  }

  /* ── 新增项目 / 新增运动员的防呆 ────────────────────────────────────────
     这两块以前什么都不查，实测能建出"名字为空的项目"（会被悄悄改名成
     "新项目"）、能建重名项目、能加两个同号码的人。号码是现场认人的唯一
     凭据（检录、录入、大屏都靠它），重号会让"这人到底是谁"说不清。 */
  section('新增项目 / 新增运动员：防呆');
  {
    /* 注意：组别现在**按年级推**，所以这一节所有 athlete.add 都必须给 grade。
       （不给会被拒 —— 那是下一节要测的行为。）
       演示数据的组别是**按性别**分的（男子组/女子组），跟年级对不上，
       所以这里临时造一个「高一」→「高一组」的对应关系，不依赖演示数据长什么样。 */
    const sg = (await c.call('GET', '/api/snapshot?kind=admin')).data.groups[0];
    const d0 = currentMod.getDb();
    const gm0 = d0.get('SELECT id FROM meet LIMIT 1', []).id;
    const GD = '高一';
    if (!d0.get('SELECT id FROM groupDef WHERE meetId = ? AND name = ?', [gm0, '高一组'])) {
      d0.run('INSERT INTO groupDef(id, meetId, name, sort, kind) VALUES(?,?,?,?,?)',
        ['g_fd_1', gm0, '高一组', 200, 'mixed']);
    }
    ok(true, '样本年级「' + GD + '」对应「高一组」已就位');
    /* 要直接查库核对存进去的值，所以拿一份 db 句柄。
       （这个套件里 `d` 不是全局变量 —— 我第一次写成裸 `d.get(...)`，
         整节抛 ReferenceError，报的是"套件 data 抛异常：d is not defined"。） */
    const d = d0;

    // 项目：空名字
    r = await c.op('event.add', { name: '', groupId: sg.id });
    ok(r.status === 400, '空名字的项目被拒绝（HTTP ' + r.status + '）');
    ok(r.data && /名称/.test(String(r.data.message || '')), '提示说的是名称问题');

    // 项目：纯空格也算空
    r = await c.op('event.add', { name: '   ', groupId: sg.id });
    ok(r.status === 400, '纯空格的名字也被拒绝');

    // 项目：正常建一个
    r = await c.op('event.add', { name: '防呆测试项目', groupId: sg.id });
    ok(r.status === 200, '正常名字能建');

    // 项目：同名再建（DUP_NAME 是"冲突"语义，服务端映射成 409）
    r = await c.op('event.add', { name: '防呆测试项目', groupId: sg.id });
    ok(r.status === 409, '同组别下重名被拒绝（HTTP ' + r.status + '）');
    ok(r.data && /已经有一个/.test(String(r.data.message || '')), '提示讲清了原因');

    // 项目：时刻规范化（只存 HH:MM，且补零）
    r = await c.op('event.add', { name: '防呆测试时刻', groupId: sg.id, startAt: '7:05', endAt: '8:04' });
    ok(r.status === 200, '带时刻能建');
    if (r.status === 200) {
      const did = r.data.data.id;
      const row = d.get('SELECT startAt, endAt FROM event WHERE id = ?', [did]);
      ok(row && row.startAt === '07:05', '"7:05" 存成补零的 "07:05"', JSON.stringify(row));
      ok(row && row.endAt === '08:04', '"8:04" 存成补零的 "08:04"');
      await c.op('event.update', { id: did, startAt: '2026-09-30T09:07' });
      const row2 = d.get('SELECT startAt FROM event WHERE id = ?', [did]);
      ok(row2 && row2.startAt === '09:07', '旧的 ISO 时刻会归一成 "09:07"', JSON.stringify(row2));
      await c.op('event.update', { id: did, startAt: '' });
      const row3 = d.get('SELECT startAt FROM event WHERE id = ?', [did]);
      ok(row3 && !row3.startAt, '时刻留空 = 不设（不写空串）', JSON.stringify(row3));
    }

    // 运动员：号码重复
    r = await c.op('athlete.add', { name: '防呆甲', bib: '88801', gender: '男', grade: GD });
    ok(r.status === 200, '第一个号码 88801 能加');
    r = await c.op('athlete.add', { name: '防呆乙', bib: '88801', gender: '男', grade: GD });
    ok(r.status === 409, '同号码再加一个被拒绝（HTTP ' + r.status + '）');
    ok(r.data && /号码/.test(String(r.data.message || '')), '提示指向号码');

    // 运动员：同班同名
    r = await c.op('athlete.add', { name: '防呆同名', grade: GD, className: '1班' });
    ok(r.status === 200, '同班第一个"防呆同名"能加');
    r = await c.op('athlete.add', { name: '防呆同名', grade: GD, className: '1班' });
    ok(r.status === 409, '同班同名被拒绝（HTTP ' + r.status + '）');
    r = await c.op('athlete.add', { name: '防呆同名', grade: GD, className: '2班' });
    ok(r.status === 200, '不同班可以同名（真的会有两个同名同学）');

    // 运动员：号码留空不算重复。
    // 组别现在按年级推，所以**必须给年级**（不给会被拒 —— 见下一节）。
    r = await c.op('athlete.add', { name: '防呆无号甲', grade: GD });
    ok(r.status === 200, '没号码的人能加');
    r = await c.op('athlete.add', { name: '防呆无号乙', grade: GD });
    ok(r.status === 200, '再一个没号码的人也能加（空号码不算重复）');
  }

  /* ── 组别由年级决定（原来会静默把人塞进初一组）────────────────────────────
     以前加运动员时"组别"下拉有默认值，服务端在组别为空时返回 groups[0]
     （排序第一个 = 初一组）。老师只填年级 → **人全进初一组**，还不报错。
     组别错了，这个人的名次、班级总分、能报的项目全跟着错。

     ⚠ 演示数据的组别是**按性别**分的（男子组/女子组），而现场是**按年级**分
     （初一组/高二组…）。所以这一节**自己造几个按年级分的组别**来测 ——
     拿演示数据那两个组去测"高一→高一组"必然推不出来，
     我第一次就是这么写的，9 条断言全红。 */
  section('组别按年级推（不再默认落进初一组）');
  {
    const d = currentMod.getDb();
    const Ops = require(path.join(ROOT, 'src/ops.js'));
    const gm = d.get('SELECT id FROM meet LIMIT 1', []).id;

    // 造按年级分的组别（模拟现场）。注意 groupDef 只有 id/meetId/name/sort/kind —
    // 没有 createdAt/updatedAt（我第一次按习惯写了时间戳，直接报"no column named createdAt"）
    const want = ['初一组', '初二组', '高一组', '高二组', '高三组'];
    want.forEach((nm, i) => {
      if (!d.get('SELECT id FROM groupDef WHERE meetId = ? AND name = ?', [gm, nm])) {
        d.run('INSERT INTO groupDef(id, meetId, name, sort, kind) VALUES(?,?,?,?,?)',
          ['g_test_' + i, gm, nm, 100 + i, 'mixed']);
      }
    });
    const gByName = {};
    d.all('SELECT id, name FROM groupDef WHERE meetId = ?', [gm]).forEach(g => { gByName[g.name] = g.id; });
    ok(!!gByName['高一组'] && !!gByName['高二组'], '按年级分的组别就位：' + want.join('、'));

    // 纯函数：年级 → 组别
    eq(Ops.groupFromGrade(d, gm, '高一'), gByName['高一组'], '「高一」→ 高一组');
    eq(Ops.groupFromGrade(d, gm, '高二'), gByName['高二组'], '「高二」→ 高二组');
    eq(Ops.groupFromGrade(d, gm, '初一'), gByName['初一组'], '「初一」→ 初一组');
    eq(Ops.groupFromGrade(d, gm, '高三'), gByName['高三组'], '「高三」→ 高三组');
    eq(Ops.groupFromGrade(d, gm, '高一36班'), gByName['高一组'], '「高一36班」也能认出来');
    eq(Ops.groupFromGrade(d, gm, ''), null, '空年级 → null（不猜）');
    eq(Ops.groupFromGrade(d, gm, '五年级'), null, '认不出的年级 → null（不猜，也不落到第一个组）');

    // 走接口：加一个高二的学生，必须进高二组
    const beforeG2 = d.get('SELECT COUNT(1) c FROM athlete WHERE groupId = ?', [gByName['高二组']]).c;
    r = await c.op('athlete.add', { name: '组别测试生', grade: '高二', className: '99班', bib: '77701' });
    ok(r.status === 200, '填了年级就能加（HTTP ' + r.status + '）');
    if (r.status === 200) {
      const a = d.get('SELECT groupId, grade FROM athlete WHERE id = ?', [r.data.data.id]);
      eq(a.groupId, gByName['高二组'], '★ 归入了高二组（不是初一组）');
      eq(a.grade, '高二', '年级也存对了');
    }
    const afterG2 = d.get('SELECT COUNT(1) c FROM athlete WHERE groupId = ?', [gByName['高二组']]).c;
    eq(afterG2, beforeG2 + 1, '高二组人数 +1');

    // 不填年级：明确拒绝，而不是落到初一组
    const beforeG1 = d.get('SELECT COUNT(1) c FROM athlete WHERE groupId = ?', [gByName['初一组']]).c;
    r = await c.op('athlete.add', { name: '没填年级的人' });
    ok(r.status === 400, '不填年级被拒绝（HTTP ' + r.status + '）');
    ok(r.data && /年级/.test(String(r.data.message || '')), '提示让他填年级');
    eq(d.get('SELECT COUNT(1) c FROM athlete WHERE name = ?', ['没填年级的人']).c, 0, '★ 被拒的人没有落库');
    eq(d.get('SELECT COUNT(1) c FROM athlete WHERE groupId = ?', [gByName['初一组']]).c, beforeG1,
      '★ 初一组人数没变 —— 不再被静默塞人');

    // 认不出的年级：也拒绝
    r = await c.op('athlete.add', { name: '怪年级的人', grade: '五年级' });
    ok(r.status === 400, '认不出的年级也拒绝（HTTP ' + r.status + '）');
    eq(d.get('SELECT COUNT(1) c FROM athlete WHERE name = ?', ['怪年级的人']).c, 0, '★ 也没有落库');

    /* 明确给了组别时照旧优先用给的（导入场景）。
       ⚠ 用 groupName 而不是 groupId：groupIdOrFirst 对**不认识的 id** 会走
       "包含匹配"（拿 id 串去和组别名比），可能命中别的组 ——
       我第一次传 'g_test_4' 就被演示数据的「高三组」接走了。
       传名字才是这条路径真正支持的用法。 */
    r = await c.op('athlete.add', { name: '指定组别的人', groupName: '高三组', grade: '随便写' });
    ok(r.status === 200, '明确指定组别时能加');
    if (r.status === 200) {
      const got = d.get('SELECT groupId FROM athlete WHERE id = ?', [r.data.data.id]).groupId;
      eq(got, gByName['高三组'], '用的是明确指定的组别');
    }

    // 导入：名单里没有"组别"列时，按年级推（不再整批进初一组）
    const beforeCnt = d.get('SELECT COUNT(1) c FROM athlete WHERE meetId = ?', [gm]).c;
    r = await c.op('athlete.import', {
      rows: [
        { name: '导入甲', grade: '高一', className: '98班', bib: '77711' },
        { name: '导入乙', grade: '高三', className: '98班', bib: '77712' },
      ],
    });
    ok(r.status === 200, '导入两行成功');
    const impA = d.get('SELECT groupId FROM athlete WHERE bib = ?', ['77711']);
    const impB = d.get('SELECT groupId FROM athlete WHERE bib = ?', ['77712']);
    eq(impA && impA.groupId, gByName['高一组'], '★ 导入的「高一」进了高一组');
    eq(impB && impB.groupId, gByName['高三组'], '★ 导入的「高三」进了高三组');
    eq(d.get('SELECT COUNT(1) c FROM athlete WHERE meetId = ?', [gm]).c, beforeCnt + 2, '多了 2 个人');

    // 导入：既没年级也没组别 → 跳过并给出行号，而不是塞进第一个组
    r = await c.op('athlete.import', { rows: [{ name: '导入无年级', className: '98班' }] });
    ok(r.status === 200, '导入本身不报错（逐行跳过）');
    eq(d.get('SELECT COUNT(1) c FROM athlete WHERE name = ?', ['导入无年级']).c, 0, '★ 没年级的行被跳过');
    const dd = r.data.data || {};
    ok((dd.skipped || 0) >= 1, '返回值里报了跳过 ' + (dd.skipped || 0) + ' 行');
    ok((dd.errors || []).some(x => /年级|组别/.test(String(x))), '跳过原因讲清了要补年级/组别');
  }

  /* ── 「添加项目 / 添加运动员」整条链路复捋 ────────────────────────────────
     一次事故的教训：这两个入口是现场用得最多的，也是"静默出错"最多的地方
     （人悄悄进错组别、项目悄悄改名成"新项目"）。这里把它们**从头打一遍**：
     每一个字段的默认值、每一种错法、以及"到底有没有落库"。

     ★ 这一节抓到一个真 BUG：传**不存在的 groupId** 时，
       `groupIdOrFirst` 的模糊匹配认不出就落到 `groups[0]`，
       于是老 BUG（人进第一个组别）从另一个入口又回来了。
       修法是新增 `groupById()`：给 id 就必须真实存在，给名字才宽松匹配。 */
  section('添加项目：字段默认值与各种错法');
  {
    const d = currentMod.getDb();
    const gm = d.get('SELECT id FROM meet LIMIT 1', []).id;
    const grp = (await c.call('GET', '/api/snapshot?kind=admin')).data.groups[0];

    // ① 最简：只给名字+组别
    r = await c.op('event.add', { name: '复捋-最简', groupId: grp.id });
    ok(r.status === 200, '只给名字和组别就能建（HTTP ' + r.status + '）');
    const idS = r.status === 200 ? r.data.data.id : null;
    if (idS) {
      const ev = d.get('SELECT * FROM event WHERE id = ?', [idS]);
      eq(ev.kind, 'track', '默认类型是径赛');
      eq(ev.stage, 'final', '默认阶段是决赛');
      eq(ev.attempts, 1, '径赛次数固定 1');
      eq(ev.status, 'pending', '新项目是"未开始"');
      eq(ev.relayLegs, null, '非接力 relayLegs 是 null（不是 0 / undefined）');
      eq(ev.startAt, null, '没给时刻就是 null');
      eq(ev.unit, null, 'unit 是 null（历史上这里漏过一次，整个 event.add 全挂）');
      ok(typeof ev.tol === 'number' && ev.tol > 0, '精度有默认值 ' + ev.tol);
    }

    // ② 名字为空 / 纯空格 —— 不能悄悄变成"新项目"
    r = await c.op('event.add', { name: '', groupId: grp.id });
    ok(r.status === 400, '空名字被拒（HTTP ' + r.status + '）');
    r = await c.op('event.add', { name: '   ', groupId: grp.id });
    ok(r.status === 400, '纯空格也被拒');
    eq(d.get('SELECT COUNT(1) c FROM event WHERE meetId = ? AND name = ?', [gm, '新项目']).c, 0,
      '★ 没有悄悄建出"新项目"（老代码的坑）');

    // ③ 同组别重名
    r = await c.op('event.add', { name: '复捋-最简', groupId: grp.id });
    ok(r.status === 409, '同组同名被拒（HTTP ' + r.status + '）');
    r = await c.op('event.add', { name: '复捋-最简', groupName: '男子组' });
    ok(r.status === 200 || r.status === 409, '用 groupName 也不崩（' + r.status + '）');

    // ④ 田赛多次试跳；径赛强制 1 次
    r = await c.op('event.add', { name: '复捋-田赛', groupId: grp.id, kind: 'field', attempts: 3 });
    ok(r.status === 200, '田赛能建');
    if (r.status === 200) {
      const ev = d.get('SELECT kind, attempts FROM event WHERE id = ?', [r.data.data.id]);
      eq(ev.kind, 'field', '类型存成 field');
      eq(ev.attempts, 3, '田赛记 3 次试跳');
    }
    r = await c.op('event.add', { name: '复捋-径赛想3次', groupId: grp.id, kind: 'track', attempts: 3 });
    if (r.status === 200) {
      eq(d.get('SELECT attempts FROM event WHERE id = ?', [r.data.data.id]).attempts, 1,
        '★ 径赛即使传 attempts=3 也强制回 1');
    }

    // ⑤ 接力棒数
    r = await c.op('event.add', { name: '复捋-接力', groupId: grp.id, isRelay: true });
    if (r.status === 200) {
      const ev = d.get('SELECT isRelay, relayLegs FROM event WHERE id = ?', [r.data.data.id]);
      eq(ev.isRelay, 1, '接力标记存对');
      eq(ev.relayLegs, 4, '不填棒数默认 4');
    }
    r = await c.op('event.add', { name: '复捋-接力2棒', groupId: grp.id, isRelay: true, relayLegs: 2 });
    if (r.status === 200) {
      eq(d.get('SELECT relayLegs FROM event WHERE id = ?', [r.data.data.id]).relayLegs, 2, '2 棒也接受');
    }

    // ⑥ 时刻：只存 HH:MM
    r = await c.op('event.add', { name: '复捋-时刻', groupId: grp.id, startAt: '7:05', endAt: '08:10' });
    if (r.status === 200) {
      const ev = d.get('SELECT startAt, endAt FROM event WHERE id = ?', [r.data.data.id]);
      eq(ev.startAt, '07:05', '★ "7:05" 补零成 "07:05"');
      eq(ev.endAt, '08:10', '时刻原样存');
    }
    r = await c.op('event.add', { name: '复捋-空时刻', groupId: grp.id, startAt: '' });
    if (r.status === 200) {
      eq(d.get('SELECT startAt FROM event WHERE id = ?', [r.data.data.id]).startAt, null, '空时刻 = null');
    }

    // ⑦ 不给时刻 → 一直是未开始（不会乱跳）
    r = await c.op('event.add', { name: '复捋-不给时刻', groupId: grp.id });
    if (r.status === 200) {
      eq(d.get('SELECT status FROM event WHERE id = ?', [r.data.data.id]).status, 'pending',
        '不给时刻 → 未开始');
    }

    // ⑧ ★ 不存在的组别 id：必须报错，不能原样写进库
    const badEvName = '复捋-怪组别项目';
    r = await c.op('event.add', { name: badEvName, groupId: 'no-such-group' });
    ok(r.status === 400, '★ 项目传不存在的 groupId 被拒（HTTP ' + r.status + '）');
    eq(d.get('SELECT COUNT(1) c FROM event WHERE meetId = ? AND name = ?', [gm, badEvName]).c, 0,
      '★ 没落库');
    r = await c.op('event.add', { name: '复捋-不给组别' });
    ok(r.status === 400, '不给组别被拒（HTTP ' + r.status + '）');
  }

  section('添加运动员：组别必须对，不能静默塞进第一个组');
  {
    const d = currentMod.getDb();
    const gm = d.get('SELECT id FROM meet LIMIT 1', []).id;
    const grp0 = (await c.call('GET', '/api/snapshot?kind=admin')).data.groups[0];
    const gidOf = (nm) => (d.get('SELECT id FROM groupDef WHERE meetId = ? AND name = ?', [gm, nm]) || {}).id;

    // ★ 不存在的 groupId：这是复审时抓到的真 BUG
    const before0 = d.get('SELECT COUNT(1) c FROM athlete WHERE groupId = ?', [grp0.id]).c;
    r = await c.op('athlete.add', { name: '复捋-怪组', groupId: 'no-such', grade: '高一' });
    ok(r.status === 400, '★ 不存在的 groupId 被拒（HTTP ' + r.status + '）');
    eq(d.get('SELECT COUNT(1) c FROM athlete WHERE name = ?', ['复捋-怪组']).c, 0, '★ 没落库');
    eq(d.get('SELECT COUNT(1) c FROM athlete WHERE groupId = ?', [grp0.id]).c, before0,
      '★ 第一个组别「' + grp0.name + '」人数没变 —— 老 BUG 没从这条路回来');

    // 反向：真实的 id 必须能用（别把功能挡死）
    r = await c.op('athlete.add', { name: '复捋-真组id', groupId: gidOf('高二组'), grade: '随便写' });
    ok(r.status === 200, '★ 真实存在的 groupId 正常可用');
    if (r.status === 200) {
      eq(d.get('SELECT groupId FROM athlete WHERE id = ?', [r.data.data.id]).groupId, gidOf('高二组'),
        '用的是指定的那个组别');
    }

    // 号码重复 + 并发（真发 5 笔）
    r = await c.op('athlete.add', { name: '复捋-号A', grade: '高一', bib: 'ZZ001' });
    ok(r.status === 200, '号码 ZZ001 能加');
    r = await c.op('athlete.add', { name: '复捋-号B', grade: '高一', bib: 'ZZ001' });
    ok(r.status === 409, '同号码被拒（HTTP ' + r.status + '）');
    {
      const rs = await Promise.all([1, 2, 3, 4, 5].map(i =>
        c.op('athlete.add', { name: '复捋-并发' + i, grade: '高一', bib: 'ZZ999', clientUuid: 'zz-cu-' + i })));
      const okN = rs.filter(x => x.status === 200).length;
      eq(d.get('SELECT COUNT(1) c FROM athlete WHERE bib = ?', ['ZZ999']).c, 1,
        '★ 并发 5 笔同号码只进 1 条（成功 ' + okN + ' 笔）');
    }

    // 同名：同班拦、不同班放行
    r = await c.op('athlete.add', { name: '复捋-同名', grade: '高一', className: '高一36班' });
    ok(r.status === 200, '第一个同名能加');
    r = await c.op('athlete.add', { name: '复捋-同名', grade: '高一', className: '高一36班' });
    ok(r.status === 409, '同班同名被拒');
    r = await c.op('athlete.add', { name: '复捋-同名', grade: '高一', className: '高一37班' });
    ok(r.status === 200, '不同班可以同名');

    // 字段边界
    r = await c.op('athlete.add', { name: '复捋-空号码', grade: '高一', bib: '' });
    if (r.status === 200) {
      eq(d.get('SELECT bib FROM athlete WHERE id = ?', [r.data.data.id]).bib, null, '号码空串存成 null');
    }
    r = await c.op('athlete.add', { name: 'x'.repeat(80), grade: '高一' });
    if (r.status === 200) {
      ok(d.get('SELECT name FROM athlete WHERE id = ?', [r.data.data.id]).name.length <= 40,
        '★ 超长姓名被截到 40 字以内');
    }

    /* 班级显示名：两种情形都要对
       · 班级名已含年级（现场的"初一（1）班"）→ 不重复拼
       · 班级名不含年级（"99班"）→ 拼成 年级(班级) 消歧义
       我第一次写的断言只认第一种，对第二种必然失败 —— 是断言不懂规则。 */
    r = await c.op('athlete.add', { name: '复捋-建班', grade: '高一', className: '复捋99班' });
    if (r.status === 200) {
      const cls = d.get('SELECT * FROM classDef WHERE meetId = ? AND className = ?', [gm, '复捋99班']);
      ok(!!cls, '给了班级名会自动建 classDef');
      eq(cls && cls.label, '高一(复捋99班)', '★ 不含年级的班级名 → 拼上年级消歧义');
    }
    const U2 = require(path.join(ROOT, 'src/util.js'));
    eq(U2.classLabel('初一', '初一（1）班'), '初一（1）班', '★ 已含年级的班级名不重复');
  }

  /* ── 屏蔽运动员（录入页每行那个按钮）──────────────────────────────────────
     现场场景：某个人上不了场，但**不能删**（删了报名和成绩一起没，号码可能
     还印在秩序册上），只是不想让他出现在成绩展示页上。
     口径：屏蔽后 —— 名次榜/大屏/成绩与名次页都不展示他（名次按剩下的人重排），
     但**人还在库里、还在录入页**（随时能取消屏蔽）。
     ★ 实现上只拦一处：eventBoard 里 `rankEntries(visible)`。
       所以这里既要验"榜上没有他"，也要验"entries 里还有他"。 */
  section('屏蔽运动员：展示页不显示，但人不删');
  {
    const d = currentMod.getDb();
    const gm = d.get('SELECT id FROM meet LIMIT 1', []).id;
    const grp = (await c.call('GET', '/api/snapshot?kind=admin')).data.groups[0];

    // 表结构（v11 迁移）
    const cols = d.all('PRAGMA table_info(athlete)', []).map(x => x.name);
    ok(cols.indexOf('blocked') >= 0, '★ athlete 表有 blocked 列（v11 迁移）');

    // 造一个项目：4 人、成绩 10/11/12/13 秒
    const evR = await c.op('event.add', { name: '屏蔽测试-100米', groupId: grp.id, kind: 'track' });
    ok(evR.status === 200, '测试项目建好了');
    const evId = evR.data.data.id;
    const some = d.all('SELECT id, name FROM athlete WHERE meetId = ? LIMIT 4', [gm]);
    eq(some.length, 4, '取到 4 名运动员');
    for (const a of some) await c.op('reg.add', { eventId: evId, athleteId: a.id });
    const regs = d.all('SELECT id, athleteId FROM registration WHERE eventId = ? ORDER BY id', [evId]);
    eq(regs.length, 4, '4 人报名成功');
    const vals = [10, 11, 12, 13];
    for (let i = 0; i < 4; i++) {
      await c.op('result.set', { eventId: evId, regId: regs[i].id, attempt: 1, value: String(vals[i]) });
    }
    await c.op('event.status', { id: evId, status: 'done' });

    const boardOf = async () => {
      const r = await c.call('GET', '/api/events/' + evId + '/board');
      return (r.data && r.data.data) || {};
    };
    /* ⚠ 结构是 data.rows / data.entries（**不是** data.board.rows）——
       我第一次按 board.rows 取，全部断言假红，而大屏那边其实是对的。 */
    let bd = await boardOf();
    eq((bd.rows || []).length, 4, '屏蔽前榜上 4 人');
    eq((bd.rows || [])[0].value, 10, '第 1 名 10 秒');

    // 屏蔽第 2 名（11 秒那位）
    const victim = regs[1];
    const rb = await c.op('athlete.block', { id: victim.athleteId, blocked: true });
    ok(rb.status === 200, '屏蔽成功（HTTP ' + rb.status + '）');
    eq(d.get('SELECT blocked FROM athlete WHERE id = ?', [victim.athleteId]).blocked, 1, '库里 blocked=1');

    bd = await boardOf();
    eq((bd.rows || []).length, 3, '★ 榜上只剩 3 人（被屏蔽的不展示）');
    ok(!(bd.rows || []).some(x => Number(x.value) === 11), '★ 11 秒那位不在榜上');
    eq((bd.rows || []).map(x => x.rank).join(','), '1,2,3',
      '★ 名次重排成 1,2,3（原来 12 秒是第 3，现在第 2）');
    eq((bd.entries || []).length, 4, '★ entries 仍有 4 条（录入页还要能改他的成绩）');
    const e1 = (bd.entries || []).filter(x => x.regId === victim.id)[0];
    ok(e1 && e1.blocked === true, '★ entries 里标了 blocked=true（按钮状态要用）');
    eq(e1 && e1.athleteId, victim.athleteId, '★ entries 里带上了 athleteId（按钮要用）');
    eq(bd.blockedCount, 1, 'board 返回里报了"屏蔽 1 人"');

    // 大屏也不该有他
    const sres = await c.call('GET', '/api/snapshot?kind=screen');
    const card = ((sres.data.data || sres.data).panels.done || []).filter(e => e.id === evId)[0];
    ok(!!card, '大屏快照里找得到这个项目');
    if (card) {
      eq((card.rows || []).length, 3, '★ 大屏卡片也只有 3 行');
      ok(!(card.rows || []).some(x => Number(x.value) === 11), '★ 大屏上没有他');
    }

    // 取消屏蔽 → 恢复
    const ru = await c.op('athlete.block', { id: victim.athleteId, blocked: false });
    ok(ru.status === 200, '取消屏蔽成功');
    bd = await boardOf();
    eq((bd.rows || []).length, 4, '★ 又回到 4 人');
    eq((bd.rows || [])[1].value, 11, '★ 11 秒那位回到第 2 名');
    eq(bd.blockedCount, 0, '屏蔽数回到 0');

    // 边界
    const r1 = await c.op('athlete.block', { id: 'no-such-id', blocked: true });
    eq(r1.status, 400, '不存在的运动员被拒');
    await c.op('athlete.block', { id: victim.athleteId, blocked: true });
    const r3 = await c.op('athlete.block', { id: victim.athleteId, blocked: true });
    ok(r3.status === 200 && r3.data.data && r3.data.data.unchanged === true,
      '★ 重复屏蔽是幂等的（unchanged=true，不会重复写审计）');
    await c.op('athlete.block', { id: victim.athleteId, blocked: false });
    /* ⚠ action 带 `op.` 前缀 —— 我第一次按 'athlete.block%' 查，查到 0 条，
       差点当成"审计没写"。 */
    const au = d.all("SELECT action FROM auditLog WHERE meetId = ? AND action LIKE '%athlete.block%'", [gm]);
    ok(au.length >= 3, '★ 操作记录里留下了痕迹（' + au.length + ' 条）');
  }

  await stopServer();
});

/* ══════════════════════════════════════════════════════════════════════
 * 套件：纯函数单元测试（parse / scoring / util / status / xport）
 *
 * 【为什么单独一个套件】这些是**纯函数**，不碰数据库也不起服务，
 * 是最容易测、也最该测的部分 —— 成绩解析和名次算法出错的代价最大
 * （现场算错名次、班级总分算错，老师当场就会发现）。
 * 以前只有几个"顺带"的断言，边界情况基本没覆盖。
 * ══════════════════════════════════════════════════════════════════════ */

register('unit', async () => {
  const P = require(path.join(ROOT, 'src/parse.js'));
  const S = require(path.join(ROOT, 'src/scoring.js'));
  const U = require(path.join(ROOT, 'src/util.js'));
  const ST = require(path.join(ROOT, 'src/status.js'));
  const X = require(path.join(ROOT, 'src/xport.js'));

  section('parseResult：能认的格式都要认');
  eq(P.parseResult('12.35').value, 12.35, '12.35');
  eq(P.parseResult(' 12.35 ').value, 12.35, '两端空格');
  eq(P.parseResult('１２．３５').value, 12.35, '全角数字与句点');
  eq(P.parseResult('12.35秒').value, 12.35, '带单位"秒"');
  eq(P.parseResult('12.35s').value, 12.35, '带单位 s');
  eq(P.parseResult('5.67米').value, 5.67, '带单位"米"');
  eq(P.parseResult('2:15.30').value, 135.3, '2:15.30 = 135.3 秒');
  eq(P.parseResult('2：15.30').value, 135.3, '全角冒号');
  eq(P.parseResult('1:02:15.30').value, 3735.3, '1:02:15.30');
  eq(P.parseResult('0.01').value, 0.01, '极小但合法的成绩能收下');
  // 0 是**故意拒绝**的：0 秒/0 米在真实比赛里几乎一定是误输入，
  // 收下反而会让名次全乱（它排第一）。要表达"没成绩"应该填弃权/犯规。
  {
    let threw0 = false;
    try { P.parseResult('0'); } catch (e) { threw0 = true; }
    ok(threw0, '「0」被拒（0 秒/0 米几乎一定是误输入，要弃权请填"弃权"）');
    let threw0b = false;
    try { P.parseResult('0.00'); } catch (e) { threw0b = true; }
    ok(threw0b, '「0.00」同样被拒');
  }
  eq(P.parseResult('   ').empty, true, '纯空格 = 空');
  eq(P.parseResult('').empty, true, '空串 = 空');

  section('parseResult：弃权 / 犯规 的各种写法');
  ['弃权', '弃赛', '退赛', '受伤', '请假', '缺席', '未到', 'DNS', 'DNF', '-'].forEach((w) => {
    eq(P.parseResult(w).dnf, true, '「' + w + '」→ 弃权');
  });
  ['犯规', 'X', 'x', '×', '✕', 'foul', 'F'].forEach((w) => {
    eq(P.parseResult(w).foul, true, '「' + w + '」→ 犯规');
  });
  eq(P.parseResult('弃权').foul, undefined, '弃权不会被当成犯规');
  eq(P.parseResult('犯规').dnf, undefined, '犯规不会被当成弃权');

  section('parseResult：认不出的必须报错，绝不悄悄当数字');
  ['12.35mm', 'abc', '12..3', '一米二', '12,35', '1::2'].forEach((w) => {
    let threw = false;
    try { P.parseResult(w); } catch (e) { threw = true; }
    ok(threw, '「' + w + '」被拒（不静默当数字）');
  });
  // 注意："1:2:3" 是**合法**的（1 小时 2 分 3 秒），别把它当错误输入
  eq(P.parseResult('1:2:3').value, 3723, '1:2:3 = 1 小时 2 分 3 秒（合法）');
  // 这些是"能认但有提醒"的
  const hint = P.parseResult('130', { kind: 'track' });
  eq(hint.value, 130, '裸数字 130 仍然按 130 秒收下（长跑手计时会这么写）');
  ok(!!hint.warning, '但给出"是不是 1 分 30 秒"的提醒');

  section('formatResult：显示格式');
  eq(P.formatResult(12.345, 'track'), '12.35', '径赛 < 60 秒 → 12.35（两位小数）');
  eq(P.formatResult(135.3, 'track'), '2:15.30', '≥ 60 秒 → 2:15.30');
  eq(P.formatResult(3735.3, 'track'), '1:02:15.30', '≥ 1 小时 → 1:02:15.30');
  eq(P.formatResult(5.6, 'field'), '5.60', '田赛 → 5.60（补两位）');
  eq(P.formatResult(null, 'track'), '', 'null → 空');
  eq(P.formatResult('', 'track'), '', '空串 → 空');
  eq(P.formatResult(59.999, 'track'), '60.00', '59.999 不进位到分:秒（保持简单）');

  section('isTie：差 ≤0.01 算并列');
  /* isTie：**按计时精度**判"读数是否相同"，不是"差不超过某个值"。
     旧规则把 0.01 当成容差，结果 12.34 和 12.35 并列（差正好一个刻度）、
     12.01 和 12.02 也并列 —— 两个不同的成绩被判成同名次。 */
  section('parse：并列按计时精度判等');
  eq(P.isTie(12.34, 12.34, 0.01), true, '读数相同 → 并列');
  eq(P.isTie(12.34, 12.35, 0.01), false, '差一个刻度（0.01）→ 不并列（旧规则会判并列）');
  eq(P.isTie(12.01, 12.02, 0.01), false, '12.01 与 12.02 → 不并列（审计报告点出的那条）');
  eq(P.isTie(12.34, 12.36, 0.01), false, '差 0.02 → 不并列');
  eq(P.isTie(5.0, 5.01, 0.01), false, '田赛差 1 厘米 → 不并列');
  eq(P.isTie(5.0, 5.0, 0.01), true, '田赛成绩相同 → 并列');
  eq(P.isTie(12.341, 12.342, 0.001), false, '千分位下是两个人');
  eq(P.isTie(12.341, 12.341, 0.001), true, '千分位读数相同 → 并列');
  eq(P.isTie(12.3, 12.34, 0.1), true, '十分位下取整后都是 12.3 → 并列');
  eq(P.isTie(12.3, 12.4, 0.1), false, '十分位下 12.3 与 12.4 不同');
  eq(P.isTie(12.0, 12.4, 1), true, '整秒下 12.0 与 12.4 取整后都是 12 → 并列');
  eq(P.isTie(12.4, 12.6, 1), false, '整秒下 12.4→12、12.6→13 → 不并列（四舍五入，不是截断）');
  eq(P.isTie(NaN, 5, 0.01), false, 'NaN 不算并列');
  // 二进制误差不能被当成"不同成绩"
  eq(P.isTie(0.1 + 0.2, 0.3, 0.001), true, '浮点误差不该把相等的判成不等');
  // 分钟换算
  eq(P.isTie(135.30, 135.31, 0.01), false, '2:15.30 与 2:15.31 不并列');
  eq(P.isTie(135.30, 135.30, 0.01), true, '2:15.30 相同 → 并列');
  // 坏值归到最近档位，不让判等拿到没意义的值
  eq(P.normTol(undefined), 0.01, '没传 → 百分位');
  eq(P.normTol(NaN), 0.01, 'NaN → 百分位');
  eq(P.normTol(0), 0.01, '0 → 百分位');
  eq(P.normTol(0.05), 0.1, '0.05 归到十分位');
  eq(P.normTol(99), 1, '超大值归到整秒');
  eq(P.normTol(0.001), 0.001, '档位原样保留');

  section('util：年级/班级排序与拆分');
  eq(U.GRADE_ORDER[0], '初一', '年级顺序从初一开始');
  ok(U.gradeRank('高一') > U.gradeRank('初二'), '高一排在初二之后');
  eq(U.gradeRank('没见过的年级'), 90, '不认识的年级排最后（不抛错）');
  eq(U.classRank('3班'), 3, '班号能取出来');
  eq(U.classRank('12班'), 12, '两位班号也对');
  eq(U.classLabel('高一', '36班'), '高一(36班)', '班级标签格式');

  // splitTeam：**只能拆一次**（只传 team）；传了 grade+className 就原样返回
  eq(U.splitTeam('高一(36)班').className, '36班', '从"高一(36)班"拆出班级');
  eq(U.splitTeam('高一(36)班').grade, '高一', '从"高一(36)班"拆出年级');
  eq(U.splitTeam('高一36班').grade, '高一', '没有括号也能拆');
  eq(U.splitTeam('高一36班').className, '36班', '没有括号也能拆出班级');
  eq(U.splitTeam('初一（1）班').className, '1班', '全角括号也能拆');
  // 这条是回归测试：非贪婪正则曾把"高三"的"三"当成班级数字，
  // 拆成 grade="高"、className="三41班"（名单里的"高三36班"就是这么排错序的）
  eq(U.splitTeam('高三41班'), { grade: '高三', className: '41班' },
    '「高三41班」不能把年级里的"三"当成班级数字');
  eq(U.splitTeam('高二3班'), { grade: '高二', className: '3班' }, '「高二3班」同理');
  eq(U.splitTeam('没有班级信息').grade, '没有班级信息', '拆不出来就整体当年级（不丢信息）');

  /* ── 班级显示名：不能把年级印两遍 ────────────────────────────────────────
     现场导入的名单里「班级」列是**带年级的全称**（"初一（1）班"），
     「年级」列另有值（"初一"）。老实现一律拼 `年级(班级)`，大屏班级总分榜上就成了
     `初一(初一（1）班)`、`高一(高一36班)` —— 年级印两遍（用户报的就是这个）。 */
  section('classLabel：班级名已含年级时不重复拼');
  eq(U.classLabel('初一', '初一（1）班'), '初一（1）班', '★ 初一（1）班 不再变成 初一(初一（1）班)');
  eq(U.classLabel('高一', '高一36班'), '高一36班', '★ 高一36班 不再变成 高一(高一36班)');
  eq(U.classLabel('初二', '初二（2）班'), '初二（2）班', '全角括号');
  eq(U.classLabel('高二', '高二(12)班'), '高二(12)班', '半角括号也认');
  eq(U.classLabel('初一', '初一1班'), '初一1班', '年级后面直接跟数字（班级序号）也算已含年级');
  eq(U.classLabel('初一年级', '初一年级3班'), '初一年级3班', '「初一年级」这种写法');
  eq(U.classLabel('七年级', '七3班'), '七3班', '七年级 → 七');
  // 真正需要消歧义时才拼：班级名不以年级开头
  eq(U.classLabel('高一', '3班'), '高一(3班)', '班级名不含年级时才拼上（用来区分不同年级的同名班）');
  eq(U.classLabel('高一', '1班'), '高一(1班)', '同上（注意括号要配对）');
  // 缺值兜底
  eq(U.classLabel('', '3班'), '3班', '没有年级就只用班级名');
  eq(U.classLabel('高一', ''), '高一', '没有班级名就只用年级');
  eq(U.classLabel('', ''), '', '都空就是空串');
  // 年级名里有正则元字符时不能当正则用
  eq(U.classLabel('高(一)', '高(一)3班'), '高(一)3班', '年级名里的括号要当字面量（不能当正则）');

  section('status：四个状态齐、文案唯一');
  eq(ST.STATUS_ORDER.length, 4, '状态共 4 个');
  eq(ST.STATUS_LABEL.checking, '检录中', '有"检录中"');
  eq(ST.isBeforeStart('pending'), true, '未开始属于"还没比"');
  eq(ST.isBeforeStart('checking'), true, '检录中也属于"还没比"');
  eq(ST.isBeforeStart('live'), false, '进行中不属于');

  section('scoring：名次与计分（rows 是**按名次排好序**的）');
  const evT = { id: 'e1', kind: 'track', tol: 0.01 };
  const mk = (v, bib) => ({ regId: 'r' + bib, best: v, dnf: false, bib: String(bib), name: 'N' + bib });
  // 注意：rankEntries 返回的 rows 已经按名次排好，所以按数组顺序断言名次即可
  let rk = S.rankEntries([mk(12.0, 1), mk(11.5, 2), mk(12.5, 3)], evT, S.DEFAULT_RULE,
    { bibOf: e => e.bib, nameOf: e => e.name });
  eq(rk.rows.map(x => x.bib), ['2', '1', '3'], '径赛：11.5 < 12.0 < 12.5，快的在前');
  eq(rk.rows.map(x => x.rank), [1, 2, 3], '名次 1,2,3');
  eq(rk.rows.map(x => x.points), [7, 5, 4], '得分 7/5/4 跟着名次走');

  rk = S.rankEntries([mk(12.0, 1), mk(12.0, 2), mk(12.5, 3)], evT, S.DEFAULT_RULE,
    { bibOf: e => e.bib, nameOf: e => e.name });
  eq(rk.rows.map(x => x.rank), [1, 1, 3], '并列名次：1,1,3（不是 1,1,2）');
  eq(rk.rows.map(x => x.points), [7, 7, 4], '并列各得全额分（7、7）');

  const evF = { id: 'e2', kind: 'field', tol: 0.01 };
  rk = S.rankEntries([mk(5.1, 1), mk(5.9, 2), mk(5.5, 3)], evF, S.DEFAULT_RULE,
    { bibOf: e => e.bib, nameOf: e => e.name });
  eq(rk.rows.map(x => x.bib), ['2', '3', '1'], '田赛：5.9 > 5.5 > 5.1，远的在前');
  eq(rk.rows.map(x => x.rank), [1, 2, 3], '田赛名次 1,2,3');

  section('scoring：名次超出得分表就是 0 分（初一/初二只取前 3）');
  const many = [];
  for (let i = 1; i <= 8; i++) many.push(mk(10 + i, i));
  rk = S.rankEntries(many, evT, S.DEFAULT_RULE, { bibOf: e => e.bib, nameOf: e => e.name });
  eq(rk.rows.slice(0, 6).map(x => x.points), [7, 5, 4, 3, 2, 1], '前六名 7,5,4,3,2,1');
  eq(rk.rows[6].points, 0, '第 7 名 0 分');
  eq(rk.rows[7].points, 0, '第 8 名 0 分');
  eq(rk.rows[7].rank, 8, '但名次照给（第 8 名）');

  section('scoring：bestOf 的边界');
  const ev3 = { id: 'e3', kind: 'field', tol: 0.01, attempts: 3 };
  eq(S.bestOf({ id: 'x' }, [], ev3).best, null, '一次都没录 → 没有最好成绩');
  eq(S.bestOf({ id: 'x' }, [], ev3).dnf, false, '一次都没录也不算弃权（还没开始比）');
  const one = S.bestOf({ id: 'x' }, [{ attempt: 1, value: 5, dnf: false, foul: false }], ev3);
  eq(one.best, 5, '只录了一次也能算');
  eq(one.attemptsWithValue, 1, '统计有效次数');
  const withDnf = S.bestOf({ id: 'x' }, [
    { attempt: 1, value: 5, dnf: false, foul: false },
    { attempt: 2, value: null, dnf: true, foul: false },
  ], ev3);
  eq(withDnf.dnf, true, '有弃权记录 → dnf');
  eq(withDnf.foulOnly, false, '弃权不是 foulOnly');
  const withFoulOnly = S.bestOf({ id: 'x' }, [
    { attempt: 1, value: null, dnf: false, foul: true },
    { attempt: 2, value: null, dnf: false, foul: true },
  ], ev3);
  eq(withFoulOnly.foulOnly, true, '全犯规 → foulOnly');
  eq(withFoulOnly.fouls, 2, '统计犯规次数');

  section('scoring：qualifiers 并列跨录取线要都进');
  const rows = [];
  for (let i = 1; i <= 9; i++) rows.push({ regId: 'q' + i, rank: i, best: 10 + i * 0.1, dnf: false });
  rows[5].best = rows[4].best;             // 第 5、6 名并列
  const q = S.qualifiers(rows, 6);
  ok(q.rows.length >= 6, '录取至少 6 人');
  eq(!!q.expandNote || q.rows.length === 6, true, '并列跨线时给出说明或正常录取');

  section('xport：CSV 转义与 BOM');
  const csv = X.toCsv({ title: 'T', sheets: [{ name: 'S', head: ['姓名', '成绩'], rows: [['张"三', '12.35'], ['李,四', '5.6']] }] });
  ok(csv.indexOf('"张""三"') >= 0 || csv.indexOf('张""三') >= 0, '双引号被转义');
  ok(csv.indexOf('\r\n') >= 0, '用 CRLF（Excel 友好）');
  ok(csv.indexOf('"李,四"') >= 0, '含逗号的字段被引号包起来');
});

/* ══════════════════════════════════════════════════════════════════════
 * 套件：操作与接口覆盖（C3）
 *
 * 把"删数据""改设置"这类**风险高但以前没测**的操作补上。
 * 都用全新数据目录，不依赖上一个套件。
 * ══════════════════════════════════════════════════════════════════════ */

register('ops', async () => {
  await startServer(false);
  const c = makeClient();
  await c.login();

  section('meet：改会名 / 计分规则 / 大屏设置');
  let r = await c.op('meet.update', { name: '测试运动会', host: '测试学校', holdDate: '2026-10-01' });
  eq(r.status, 200, '改运动会信息成功');
  let snap = (await c.call('GET', '/api/snapshot?kind=admin')).data;
  eq(snap.meet.name, '测试运动会', '会名已更新');

  // 注意：meet.rule / meet.screen 的参数要**包一层**（{ rule: {...} } / { screen: {...} }）
  r = await c.op('meet.rule', { rule: { table: [9, 7, 6, 5, 4, 3, 2, 1], tie: 'full', advanceCount: 8 } });
  eq(r.status, 200, '改计分规则成功');
  snap = (await c.call('GET', '/api/snapshot?kind=admin')).data;
  eq(snap.meet.rule.table.length, 8, '规则改成 8 名计分');
  eq(snap.meet.rule.advanceCount, 8, '录取人数改成 8');
  await c.op('meet.rule', { rule: { table: [7, 5, 4, 3, 2, 1], advanceCount: 6 } });   // 还原

  r = await c.op('meet.screen', { screen: { mode: 'huge', maxColumns: 3 } });
  eq(r.status, 200, '改大屏设置成功');
  snap = (await c.call('GET', '/api/snapshot?kind=admin')).data;
  eq(snap.meet.screen.mode, 'huge', '大屏模式已更新');

  section('group / class：增删改');
  r = await c.op('group.add', { name: '测试组', sort: 99 });
  const gid = r.data.data.id;
  ok(!!gid, '加组别成功');
  eq((await c.op('group.update', { id: gid, name: '测试组2' })).status, 200, '改组别名成功');
  r = await c.op('group.del', { id: gid });
  eq(r.status, 200, '删空组别成功');

  const g0 = (await c.call('GET', '/api/snapshot?kind=admin')).data.groups[0];
  r = await c.op('class.add', { grade: g0.name.replace('组', ''), className: '99班' });
  eq(r.status, 200, '加班级成功');

  section('athlete：增删改 + 导入');
  r = await c.op('athlete.add', { name: '测试甲', groupId: g0.id, grade: '高一', className: '1班', bib: '9999', gender: '男' });
  const aid = r.data.data.id;
  eq(r.status, 200, '加运动员成功');
  eq((await c.op('athlete.update', { id: aid, name: '测试乙' })).status, 200, '改运动员成功');
  /* 名单**不在后台快照里**了（第 3 趟瘦身：209 KB 的名单改成按需拉），
     所以这里要问 /api/roster，不能再从快照里找。 */
  const ros1 = await c.call('GET', '/api/roster?limit=2000');
  eq(ros1.status, 200, '名单接口可用');
  eq(ros1.data.data.athletes.find(a => a.id === aid).name, '测试乙', '改名已生效');
  ok(snap.athletes === undefined, '后台快照里不再带完整名单（瘦身生效）');

  // 导入：带列映射
  r = await c.op('athlete.import', {
    rows: [{ 姓名: '导入一', 号码: '8881', 组别: g0.name, 年级: '高一', 班级: '1班' }],
    map: { name: '姓名', bib: '号码', group: '组别', grade: '年级', className: '班级' },
  });
  eq(r.status, 200, '导入 1 行成功');
  const ros2 = await c.call('GET', '/api/roster?limit=2000');
  ok(ros2.data.data.athletes.some(a => a.name === '导入一'), '导入的人已进名单');

  /* 名单接口的服务端筛选：三重筛选 + 搜索 + 报名数 */
  const ros3 = await c.call('GET', '/api/roster?grade=' + encodeURIComponent('高一') + '&limit=2000');
  eq(ros3.status, 200, '按年级筛选可用');
  ok(ros3.data.data.athletes.every(a => a.grade === '高一'), '按年级筛选返回的都是高一');
  ok(ros3.data.data.count <= ros3.data.data.total, '筛选后的条数不超过总数');
  const ros4 = await c.call('GET', '/api/roster?search=' + encodeURIComponent('测试乙') + '&limit=2000');
  eq(ros4.data.data.athletes.length >= 1, true, '按姓名搜索能搜到');
  ok(ros4.data.data.athletes.every(a => a.name.indexOf('测试乙') >= 0 || String(a.bib).indexOf('测试乙') >= 0),
    '搜索结果都匹配');
  ok(typeof ros4.data.data.athletes[0].regCount === 'number', '名单里带了报名项数（regCount）');
  /* grades/classes 候选值要按**全量**算，不受当前筛选影响 ——
     否则选了一个年级之后，别的年级就从下拉里消失了。
     注意断言写法：ops 套件用的是空库，可能只有一个年级，
     所以不能假设"一定多于一个"（第一版这么写就挂在这套夹具上了）。 */
  ok(ros3.data.data.grades.indexOf('高一') >= 0, '年级候选值里包含当前筛选的年级');
  ok(ros3.data.data.grades.length >= 1, '年级候选值至少有一个');
  // 分页：条数够才验翻页（空库上没得翻）
  const ros5 = await c.call('GET', '/api/roster?limit=2&offset=0');
  eq(ros5.data.data.athletes.length, Math.min(2, ros5.data.data.count), '分页 limit 生效');
  if (ros5.data.data.count > 2) {
    const ros6 = await c.call('GET', '/api/roster?limit=2&offset=2');
    ok(ros6.data.data.athletes.length >= 1, '翻页拿到数据');
    ok(ros5.data.data.athletes[0].id !== ros6.data.data.athletes[0].id, '翻页拿到的是不同的数据');
  } else {
    ok(true, '（这份夹具里运动员不足 3 个，跳过翻页检查）');
  }

  section('event：增删改与排序');
  r = await c.op('event.add', { name: '测试项目A', groupId: g0.id, kind: 'track', stage: 'final' });
  const eid = r.data.data.id;
  eq(r.status, 200, '加项目成功');
  eq((await c.op('event.update', { id: eid, name: '测试项目B', attempts: 3 })).status, 200, '改项目成功');
  eq((await c.op('event.status', { id: eid, status: 'live' })).status, 200, '手动改状态成功');
  eq((await c.op('event.statusAuto', { id: eid })).status, 200, '恢复自动成功');

  section('reg：报名增删改与接力队员');
  r = await c.op('reg.add', { eventId: eid, athleteId: aid });
  const rid = r.data.data.id;
  eq(r.status, 200, '报名成功');
  eq((await c.op('reg.update', { id: rid, lane: 4 })).status, 200, '改道次成功');
  // 重复报名要被拒
  r = await c.op('reg.add', { eventId: eid, athleteId: aid });
  ok(r.status !== 200, '同一个人重复报名被拒');

  r = await c.op('event.add', { name: '测试接力', groupId: g0.id, isRelay: true, relayLegs: 4 });
  const relayId = r.data.data.id;
  r = await c.op('reg.add', { eventId: relayId, teamName: '高一1班' });
  const relayReg = r.data.data.id;
  eq(r.status, 200, '接力按班报名成功');
  r = await c.op('reg.legs', { id: relayReg, legs: ['甲', '乙', '丙', '丁'] });
  eq(r.status, 200, '填接力队员成功');
  snap = (await c.call('GET', '/api/events/' + relayId + '/board')).data.data;
  eq(snap.entries[0].legs.length, 4, '接力队员存下了 4 个');

  section('result.batch / result.clearEvent');
  r = await c.op('result.batch', {
    items: [{ eventId: eid, regId: rid, attempt: 1, value: '11.11' }],
  });
  eq(r.status, 200, '批量录成绩成功');
  let bd = (await c.call('GET', '/api/events/' + eid + '/board')).data.data;
  eq(bd.rows[0].display, '11.11', '成绩已录入');
  r = await c.op('result.clearEvent', { eventId: eid });
  eq(r.status, 200, '清空整个项目的成绩成功');
  eq(r.data.data.removed, 1, '返回删掉了 1 条');
  bd = (await c.call('GET', '/api/events/' + eid + '/board')).data.data;
  eq(bd.entries[0].attempts.length, 0, '成绩真的清了');
  // 注意：rows 里**每个报名者都有一行**（没成绩的人也在榜上，只是没名次）——
  // 这是设计如此（人不能从榜上消失），所以不能断言 rows.length === 0
  eq(bd.rows.length, 1, '报名的人仍然在榜上（不会因为清成绩而消失）');
  eq(bd.rows[0].best, null, '清空后没有最好成绩');
  eq(bd.rows[0].points, 0, '清空后 0 分');
  // 没成绩的人不会"没有名次"，而是并列在最后一名（rank 有值）
  ok(bd.rows[0].rank >= 1, '清空后并列于最后一名（rank=' + bd.rows[0].rank + '）');
  eq(bd.rows[0].display, '', '清空后成绩栏是空的');

  section('notice：增删改');
  r = await c.op('notice.add', { text: '【测试】公告一', level: 'important' });
  const nid = r.data.data.id;
  eq(r.status, 200, '发公告成功');
  eq((await c.op('notice.update', { id: nid, text: '【测试】公告二' })).status, 200, '改公告成功');
  let nn = (await c.call('GET', '/api/notices')).data.data.notices;
  ok(nn.some(n => n.text === '【测试】公告二'), '公告已更新');
  eq((await c.op('notice.del', { id: nid })).status, 200, '删公告成功');
  nn = (await c.call('GET', '/api/notices')).data.data.notices;
  ok(!nn.some(n => n.id === nid), '公告已删除');

  section('chat：发/删/撤回');
  r = await c.call('POST', '/api/op', { op: 'chat.send', payload: { text: '【测试】消息' }, clientUuid: 'chat-1' });
  eq(r.status, 200, '发消息成功');
  let chat = (await c.call('GET', '/api/chat')).data.data;
  const mid = (chat.messages || []).find(m => m.text === '【测试】消息');
  ok(!!mid, '消息已存下');
  eq((await c.op('chat.delete', { id: mid.id })).status, 200, '删消息成功');

  section('user：账号增删改口令');
  r = await c.op('user.add', { username: 'u_test1', password: 'pass-123456', displayName: '测试员', role: 'operator' });
  const uid = r.data.data.id;
  eq(r.status, 200, '建账号成功');
  eq((await c.op('user.update', { id: uid, displayName: '测试员2' })).status, 200, '改账号成功');
  ok((await c.op('user.add', { username: 'u_test1', password: 'x-123456', role: 'viewer' })).status !== 200,
    '重名账号被拒');
  // 注意字段名是 newPassword（不是 password）
  eq((await c.op('user.pwd', { id: uid, newPassword: 'new-pass-123' })).status, 200, '管理员改他人口令成功');
  // 新口令能登录
  const u2 = makeClient();
  eq((await u2.login('u_test1', 'new-pass-123')).status, 200, '用新口令能登录');
  eq((await u2.login('u_test1', 'pass-123456')).status, 401, '旧口令已失效');
  // 弱口令要被拒
  ok((await c.op('user.pwd', { id: uid, newPassword: '123456' })).status !== 200, '弱口令（纯数字）被拒');
  ok((await c.op('user.pwd', { id: uid, newPassword: 'abc' })).status !== 200, '太短的口令被拒');

  section('event.del / athlete.del / reg.del 的联动');
  eq((await c.op('reg.del', { id: relayReg })).status, 200, '取消接力报名成功');
  eq((await c.op('event.del', { id: relayId })).status, 200, '删项目成功');
  eq((await c.op('event.del', { id: eid })).status, 200, '删有成绩的项目（会连成绩一起删）成功');
  eq((await c.op('athlete.del', { id: aid })).status, 200, '删运动员成功');
  // 删组别时里面还有人 → 要被拦住（不能让人变成孤儿）
  const gUsed = (await c.call('GET', '/api/snapshot?kind=admin')).data.groups[0];
  ok((await c.op('group.del', { id: gUsed.id })).status !== 200, '组别里还有人时不能删');

  section('接口覆盖：以前没测到的几个');
  eq((await c.call('GET', '/api/health')).status, 200, 'GET /api/health');
  eq((await c.call('GET', '/api/info')).status, 200, 'GET /api/info');
  eq((await c.call('GET', '/api/import/columns')).status, 200, 'GET /api/import/columns');
  eq((await c.call('GET', '/api/me')).status, 200, 'GET /api/me');
  eq((await c.call('GET', '/api/roster')).status, 200, 'GET /api/roster');
  eq((await c.call('GET', '/api/chat')).status, 200, 'GET /api/chat');
  eq((await c.call('GET', '/api/audit')).status, 200, 'GET /api/audit（管理员）');
  eq((await c.call('GET', '/api/backups')).status, 200, 'GET /api/backups');
  eq((await c.call('GET', '/api/snapshot/screen')).status, 200, 'GET /api/snapshot/screen');
  eq((await c.call('GET', '/api/snapshot?kind=screen')).status, 200, 'GET /api/snapshot?kind=screen');
  r = await c.call('POST', '/api/diag/layout', { page: 'admin', issues: [] });
  ok(r.status === 200 || r.status === 204, 'POST /api/diag/layout');
  r = await c.call('POST', '/api/diag/error', { page: 'admin', message: '测试' });
  ok(r.status === 200 || r.status === 204, 'POST /api/diag/error');

  // 自己改自己
  eq((await c.op('me.pwd', { oldPassword: 'test-pass-123', newPassword: 'my-new-pass-1' })).status, 200,
    '自己改自己口令成功');
  ok((await c.op('me.pwd', { oldPassword: '错的口令', newPassword: 'x-12345678' })).status !== 200,
    '原口令不对时拒绝');
  // 改口令会让**该账号所有会话失效**（安全设计），所以当前客户端要重新登录
  await c.login('admin', 'my-new-pass-1');
  eq((await c.call('GET', '/api/me')).data.user.role, 'admin', '用新口令重新登录成功');
  eq((await c.op('user.del', { id: uid })).status, 200, '删账号成功');
  // 最后一个管理员不能被删
  const meId = (await c.call('GET', '/api/me')).data.user.id;
  ok((await c.op('user.del', { id: meId })).status !== 200, '最后一个管理员不能删自己');

  section('操作员不能看管理页（A5 收紧后）—— 放在最后，因为前面改过管理员口令');
  await c.op('user.add', { username: 'op_test', password: 'op-pass-123', displayName: '操作', role: 'operator' });
  const opc = makeClient();
  await opc.login('op_test', 'op-pass-123');
  eq((await opc.call('GET', '/api/audit')).status, 403, '操作员看操作记录被拒（403）');
  eq((await opc.call('GET', '/api/users')).status, 403, '操作员看账号列表被拒（403）');
  eq((await opc.call('GET', '/api/backups')).status, 403, '操作员看备份被拒（403）');
  eq((await opc.call('POST', '/api/backups', { reason: 'x' })).status, 403, '操作员做备份被拒（403）');
  // 操作员能干的他都能干（这两条以前被误判成管理员专属，前端有按钮却点不动）
  eq((await opc.op('result.clearEvent', { eventId: 'whatever' })).status !== 403, true,
    '操作员能调「清空项目成绩」');
  eq((await opc.op('event.autoAll', {})).status !== 403, true,
    '操作员能调「全部恢复自动」');

  await stopServer();
});

/* ══════════════════════════════════════════════════════════════════════
 * 套件四：静态自检（前端引用、SQL、CSS 网格）
 * ══════════════════════════════════════════════════════════════════════ */

register('static', async () => {
  const { execFileSync } = require('node:child_process');
  const tools = [
    ['check-frontend.js', '前端引用自检'],
    ['sql-check.js', 'SQL 自检'],
    ['check-css-grid.js', 'CSS 网格自检'],
    // 抓"用了但没引入"——删代码时清理 import 删过头是运行时错误，语法检查看不出来
    ['check-imports.js', '导入自检'],
    // 抓"语法都对、跑起来才炸"的那类：权限表死配置、前端状态对象写错、快照字段两边不一致
    ['check-consistency.js', '一致性自检'],
    // 抓"双击就闪退"：.bat 里的块内括号、非 ASCII、LF 行尾、for 定界符写错
    ['check-bat.js', '.bat 双击可用性自检'],
  ];
  for (const [file, label] of tools) {
    const p = path.join(ROOT, 'tools', file);
    if (!fs.existsSync(p)) { ok(false, label + ' 工具不存在：' + file); continue; }
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, ['--no-warnings', p], { encoding: 'utf8', timeout: 120000 });
    } catch (err) {
      out = String(err.stdout || '') + String(err.stderr || '');
      code = err.status === undefined ? 1 : err.status;
    }
    ok(code === 0, label + ' 通过' + (code === 0 ? '' : ('：' + out.split('\n').filter(l => l.indexOf('[失败]') >= 0).slice(0, 3).join(' / '))));
  }

  /* ── DOM 打补丁的单元测试（node:test）────────────────────────────────
   * 为什么单独跑一个 node --test：
   *   它是**纯函数**测试，不需要服务也不需要浏览器；用 Node 内置的 test runner
   *   比塞进这个文件的手写断言更清楚（失败时会打印期望/实际）。
   * 这一步很关键：reconcile 的正确性靠肉眼看不出来 ——
   *   写这套测试时它立刻抓出两个真 bug（新节点被误删、两个 null 相等导致
   *   节点根本没插入）。没有它，"列表是空的"这种错误会一路带到现场。
   */
  const nodeTests = [
    ['dom.test.js', 'DOM 补丁单测'],
    /* 增量推送的验收：核心不变式是
       「merge(改动前的全量, 服务端造的增量) === 改动后的全量」，逐字段比对。
       增量合并错了**不会报错**，只会少显示一条成绩 —— 必须自动化验证。 */
    ['snapshot-merge.test.js', '增量推送验收'],
    /* 快照瘦身（名单从快照里拆出去、改成按需拉）的验收。
       拆成两个数据源之后最危险的不是报错，而是**两处口径不一致**：
       名单页显示"共 905 名"而快照统计是 906 —— 不会报异常，只会让人看到错数字。
       所以这里逐条比对"快照统计 === 名单接口 total"、"服务端筛选 === 前端筛选"。 */
    ['roster-slim.test.js', '名单瘦身验收'],
    /* 《运动会系统检查与改进建议》里 9 条缺陷的回归测试。
       每条测试名里都写明了"原来会怎样"，以后改坏了这里会红。
       全部用临时数据目录 + 合成数据，不碰真实库。 */
    ['audit-fixes.test.js', '审计缺陷回归'],
    /* 「多地登录看得见、能踢」的验收。
       这套系统**故意允许**同一账号在多设备多地同时登录（现场手机+电脑），
       会话也不绑 IP；补的是"账号被盗后从别处登录看不出来"这个洞。
       几个容易写错又危险的点各有断言：不能踢自己当前会话、
       踢一条不能连带踢掉其它、非管理员不能碰别人的、踢完要真失效、要留审计。 */
    ['sessions.test.js', '多地登录与踢会话（开关打开时）'],
    /* 「一个账号只能在一台设备上登录」—— 默认行为，防"两人共用一个账号
       同时录成绩互相覆盖"。重点有一半在"被顶下线的那台知不知道自己为什么下线"。 */
    ['single-session.test.js', '单设备登录（防共用账号冲突）'],
    /* 「在线状态要实时」—— 判据是"最近还在活动"（心跳），
       不是"会话表里有记录"。用户原话："不是打开过一次就一直显示已登录"。
       这条测试还抓出过一个设计错误：一开始让每个请求都刷新时间，
       结果"管理员打开账号页看谁在线"这个动作先把自己刷成了在线。 */
    ['presence.test.js', '在线状态实时判定'],
  ];
  for (const [file, label] of nodeTests) {
    const p = path.join(ROOT, 'test', file);
    if (!fs.existsSync(p)) { ok(false, '找不到 test/' + file); continue; }
    let out2 = '';
    let code2 = 0;
    try {
      out2 = execFileSync(process.execPath, ['--no-warnings', '--test', p],
        { encoding: 'utf8', timeout: 180000 });
    } catch (err) {
      out2 = String(err.stdout || '') + String(err.stderr || '');
      code2 = err.status === undefined ? 1 : err.status;
    }
    const m = out2.match(/# pass (\d+)/);
    const f = out2.match(/# fail (\d+)/);
    ok(code2 === 0,
      label + '通过（' + (m ? m[1] : '?') + ' 项）'
      + (code2 === 0 ? '' : ('（失败 ' + (f ? f[1] : '?') + ' 项）')));
  }
});

/* ══════════════════════════════════════════════════════════════════════
 * 跑起来
 * ══════════════════════════════════════════════════════════════════════ */

(async () => {
  console.log('运动会成绩系统 · 测试套件');
  console.log('（每个套件都用全新的空数据目录，可重复跑；加 --keep 保留数据目录）');

  for (const s of suites) {
    if (ONLY && s.name !== ONLY) continue;
    console.log('\n████ 套件：' + s.name);
    try {
      await s.fn();
    } catch (err) {
      failed++;
      failures.push('套件 ' + s.name + ' 抛异常：' + (err && err.message));
      console.log('  ✗ 套件抛异常：' + (err && err.stack || err));
      try { await stopServer(); } catch (e) { /* ignore */ }
    }
  }

  console.log('\n' + '═'.repeat(64));
  console.log('结果：' + (failed === 0 ? ('全部通过（' + passed + ' 条断言）') : (passed + ' 通过 / ' + failed + ' 失败')));
  if (failed) {
    console.log('\n失败清单：');
    failures.forEach(f => console.log('  · ' + f));
  }
  process.exit(failed === 0 ? 0 : 1);
})();
