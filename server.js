'use strict';
/**
 * server.js —— HTTP 服务 + 接口 + SSE 实时推送 + 定时任务 + 备份
 *
 * 【为什么零依赖】
 *   学校内网、现场部署、老师要能用记事本急救改一行 —— 所以：不用框架、不用构建、
 *   Node 22.5+ 内置的 node:sqlite 当数据库。代价是 Node 版本必须 ≥ 22.5。
 *
 * 【现场最关心的三件事，都在这里兜住】
 *   1. 一键启动：双击 .cmd → 自动建库 → 打印"局域网其它设备用"的真实地址
 *   2. 断网不丢数据：实时推送断了自动重连；录入端有本地队列，恢复后自动补交（幂等）
 *   3. 数据不丢：每 30 分钟自动备份（有改动才备）+ 保留最近 30 份 + 启动/恢复前各备一次
 *
 * 环境变量：PORT / HOST / DATA_DIR / BACKUP_KEEP / BACKUP_EVERY_MIN /
 *           SEED_DEMO / SPORTS_ADMIN_USER / SPORTS_ADMIN_PASSWORD / TZ
 */

/* 屏蔽 node:sqlite 的实验性警告（现场老师看到一堆 Warning 会以为出错了） */
const origEmit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (/SQLite is an experimental feature/i.test(text)) return;
  return origEmit.call(process, warning, ...rest);
};

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const db = require('./src/db');
const Ops = require('./src/ops');
const Board = require('./src/scoreboard');
const Auth = require('./src/auth');
const Xport = require('./src/xport');
const S = require('./src/scoring');
const { nowIso, safeFilePart, str, num, fmtLocal, orNull, gradeRank, classRank } = require('./src/util');

/* ══════════════════════════════════════════════════════════════════════
 * 配置
 * ══════════════════════════════════════════════════════════════════════ */

/* ── 配置：config.js 给老师改，环境变量优先（部署到服务器时用环境变量） ── */

let CFG = {};
try {
  CFG = require('./config.js') || {};
} catch (err) {
  console.error('[提示] 读不到 config.js，将使用默认配置：' + (err && err.message));
}

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
/** 环境变量优先于 config.js；取不到就用默认值 */
const pick = (envName, cfgKey, fallback) => {
  const e = process.env[envName];
  if (e !== undefined && e !== '') return e;
  const c = CFG[cfgKey];
  if (c !== undefined && c !== '' && c !== null) return c;
  return fallback;
};

const DATA_DIR = path.resolve(String(pick('DATA_DIR', 'dataDir', path.join(ROOT, 'data'))));
const BACKUP_DIR = path.join(DATA_DIR, 'backup');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'sports.db');
const PORT = Number(pick('PORT', 'port', 8080)) || 8080;
const HOST = String(pick('HOST', 'host', '0.0.0.0'));
/* 备份保留份数。**0 = 永不自动删除**（现场要求：别每次打开都清备份）。
   注意不能再用 `Math.max(5, …)` —— 那会把 0 顶成 5，等于关不掉。
   负数也当 0 处理，别让它变成"slice(-N)"这种意外行为。 */
const BACKUP_KEEP = (() => {
  const raw = pick('BACKUP_KEEP', 'backupKeep', 30);
  const n = Number(raw);
  if (!Number.isFinite(n) || raw === '' || raw === null || raw === undefined) return 30;
  return n <= 0 ? 0 : n;
})();
/* 自动备份间隔（分钟）。**0 = 关掉自动备份**（不建定时器）。 */
const BACKUP_EVERY_MIN = (() => {
  const raw = pick('BACKUP_EVERY_MIN', 'backupEveryMin', 30);
  const n = Number(raw);
  if (!Number.isFinite(n) || raw === '' || raw === null || raw === undefined) return 30;
  return n <= 0 ? 0 : n;
})();
/* 后台维护任务（清过期会话/幂等、合并 WAL、裁剪聊天）的开关 */
const HOUSEKEEPING = (() => {
  const raw = pick('HOUSEKEEPING', 'housekeeping', true);
  return raw === true || raw === 1 || String(raw).toLowerCase() === 'true' || String(raw) === '1';
})();
const UPLOAD_MAX_MB = Math.max(1, Number(pick('UPLOAD_MAX_MB', 'uploadMaxMB', 12)) || 12);
const SEED_DEMO = String(pick('SEED_DEMO', 'seedDemo', '')).toLowerCase() === 'true'
  || String(pick('SEED_DEMO', 'seedDemo', '')) === '1';
const SECURE_COOKIES = process.env.SECURE_COOKIES === '1';
/* 一个账号能不能在多台设备上登录。默认 **不能**（见 config.js 的说明）。
   两种改法：config.js 里 allowMultiDeviceLogin: true，
   或者设环境变量 ALLOW_MULTI_DEVICE_LOGIN=1（临时排查用）。 */
const ALLOW_MULTI_DEVICE = (() => {
  const raw = pick('ALLOW_MULTI_DEVICE_LOGIN', 'allowMultiDeviceLogin', false);
  return raw === true || raw === 1 || String(raw).toLowerCase() === 'true' || String(raw) === '1';
})();
const ADMIN_USER = String(pick('SPORTS_ADMIN_USER', 'adminUser', 'admin'));
const ADMIN_PASSWORD = String(pick('SPORTS_ADMIN_PASSWORD', 'adminPassword', ''));

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let d = db.open(DB_FILE);

/* ══════════════════════════════════════════════════════════════════════
 * 实时推送（SSE）
 *   把"数据变了"告诉所有客户端。为了不让大屏连续重绘，变更做 300ms 去抖：
 *   一次批量确认只推一次。
 * ══════════════════════════════════════════════════════════════════════ */

const streams = { screen: new Set(), admin: new Set() };
let pushTimer = null;

/* ══════════════════════════════════════════════════════════════════════
 * 推送：能发增量就发增量，发不了就发全量
 *
 * 【第 2 趟改造的核心】原来任何改动都重建整份快照（后台 296 KB / 85~110 ms）
 * 推给所有客户端。现在：
 *   · 一次请求里**只影响某几个项目**的改动（录成绩、检录、改状态、项目结构）
 *     → 推增量：只带这几个项目的卡片 + 班级总分，几百字节
 *   · 其余一律发全量（运动员/班级/组别/名单导入/确认暂存…派生视图太多，
 *     硬做增量出错风险远大于省下的流量）
 *
 * `pendingEventIds` 由各路由在**改动前**登记（见 markTouched），
 * 300ms 的合并窗口会把它累积起来 —— 连点几下只发一条增量。
 * ══════════════════════════════════════════════════════════════════════ */

/** 这一轮推送里"被改到的项目 id"。null 表示"说不清，发全量" */
let pendingEventIds = null;
/** 这一轮改动**之前**的项目版本号 —— 增量里的 base，客户端拿它判断有没有漏消息 */
let pendingBaseRev = null;

/** 登记一个受影响的项目 id（一次请求里多次调用会合并） */
function markTouched() {
  // 只要有一次说不清（传 null/空），整轮就发全量 —— 宁可保守
  if (pendingEventIds === null) return;
  for (let i = 0; i < arguments.length; i++) {
    const id = arguments[i];
    if (id === null || id === undefined || id === '') { pendingEventIds = null; return; }
    if (pendingEventIds.indexOf(id) < 0) pendingEventIds.push(id);
  }
}

/**
 * 开始记录一轮改动。**必须在真正改库之前调用** ——
 * 它要记下"改动前的 rev"作为增量的 base：
 * 客户端拿到增量时会检查 `自己的 rev === base`，
 * 对不上说明漏过消息（断线重连、切后台），就自动退回全量，绝不会少数据。
 */
function beginTouch() {
  pendingEventIds = [];
  try {
    const meet = db.currentMeet(d);
    pendingBaseRev = meet ? Number(meet.rev || 1) : null;
  } catch (e) { pendingBaseRev = null; }
}

function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const ids = pendingEventIds;
    const base = pendingBaseRev;
    pendingEventIds = null;
    pendingBaseRev = null;
    pushAll(ids, base);
  }, 300);
}

function pushAll(eventIds, baseRev) {
  pushKind('screen', eventIds, baseRev);
  pushKind('admin', eventIds, baseRev);
}

/** 给某一类客户端推最新数据。
 * eventIds 是数组且非空 → 发增量；否则发全量。
 * 首包永远是全量（见 openStream），所以客户端手里一定有可合并的底子。
 */
function pushKind(kind, eventIds, baseRev) {
  const set = streams[kind];
  if (!set || !set.size) return;
  const meet = db.currentMeet(d);
  if (!meet) return;

  const base = Number(baseRev === null || baseRev === undefined ? meet.rev : baseRev) || 1;
  let payload = null;
  let incremental = false;
  try {
    if (eventIds && eventIds.length) {
      payload = (kind === 'screen')
        ? Board.screenPatch(d, meet.id, base, eventIds)
        : Board.adminPatch(d, meet.id, base, eventIds);
      incremental = true;
    } else {
      payload = snapshotFor(kind, meet.id, {});
    }
  } catch (err) {
    log('推送 ' + kind + (incremental ? ' 增量' : ' 快照') + '失败：' + (err && err.message));
    return;
  }
  const msg = 'data: ' + JSON.stringify({ type: 'snapshot', kind, data: payload }) + '\n\n';
  for (const conn of Array.from(set)) {
    /* 推送前逐条验会话：退出登录 / 改密 / 被停用之后，
       这条连接不该再收到任何数据（实测过原来会继续收）。 */
    if (!streamAlive(conn)) {
      try {
        conn.res.write('data: ' + JSON.stringify({
          type: 'bye', reason: '登录状态已失效，请重新登录',
        }) + '\n\n');
        conn.res.end();
      } catch (e) { /* ignore */ }
      closeConn(kind, conn);
      log('推送时断开一条失效连接：' + kind + '（剩 ' + set.size + ' 个）');
      continue;
    }
    try { conn.res.write(msg); } catch (e) { closeConn(kind, conn); }
  }
}

function snapshotFor(kind, meetId, opts) {
  if (kind === 'screen') return Board.screenSnapshot(d, meetId);
  if (kind === 'admin') return Board.adminSnapshot(d, meetId);
  throw new Error('不支持的数据类型：' + kind);
}

/* ── 判断一条指令"影响了哪些项目" ────────────────────────────────────────
 *
 * 返回数组 → 按这个列表发增量（只重算这几个项目的卡片 + 班级总分）
 * 返回 [null] → 说不清，发全量
 *
 * 【为什么这份表要写死而不是自动推断】
 *   自动推断（比如"看哪些表变了"）在这个项目里做不到 —— 用的是 node:sqlite，
 *   没有变更追踪。而写死一张表的好处是**看得见、审得清**：
 *   新加一条指令时，如果忘了登记，默认就是发全量（安全的那一边）。
 */
const TOUCH_SELF = {
  // 只影响"这一个项目"的指令（payload.eventId 就是它）
  'result.set': 'eventId',
  'result.batch': 'eventId',
  'result.clearEvent': 'eventId',
  'checkin.open': 'eventId',
  'checkin.close': 'eventId',
  'checkin.all': 'eventId',
  'result.clearAttempt': 'eventId',
  'result.del': 'eventId',
};

function touchedByOp(op, payload) {
  const p = payload || {};
  // ① 只影响一个项目：直接给它的 id
  if (TOUCH_SELF[op]) {
    const id = p[TOUCH_SELF[op]] || p.eventId || p.id;
    return id ? [id] : [null];
  }
  // ② 检录点名：payload 只有 regId，要从报名反查项目
  if (op === 'checkin.mark') {
    try {
      const row = d.get('SELECT eventId FROM registration WHERE id = ?', [String(p.regId || '')]);
      return row && row.eventId ? [row.eventId] : [null];
    } catch (e) { return [null]; }
  }
  // ③ 改状态/排序：只影响它自己
  if (op === 'event.status' || op === 'event.statusAuto' || op === 'event.move') {
    const id = p.id || p.eventId;
    return id ? [id] : [null];
  }
  /* ④ 其余一律发全量。典型的有：
     · event.add / event.del / event.update —— 会改 finalsOf 关联、影响别的项目的
       "由…录取 / 已生成决赛"那两行，只更新自己会漏
     · athlete.* / class.* / group.* / import.* —— 牵连报名、名单、班级总分等一堆派生视图
     · notice.* —— 不带项目，但公告面板要变；顺带发全量最省心（公告改动不频繁）
     · event.tick / event.autoAll —— 一次可能改多个项目，逐个算不划算 */
  return [null];
}

/* ══════════════════════════════════════════════════════════════════════
 * 日志（打印到控制台，现场可直接看）
 * ══════════════════════════════════════════════════════════════════════ */

function stamp() {
  const dt = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(dt.getHours()) + ':' + p(dt.getMinutes()) + ':' + p(dt.getSeconds());
}
function log(...args) { console.log('[' + stamp() + ']', ...args); }
function logErr(...args) { console.error('[' + stamp() + ']', ...args); }

/* ══════════════════════════════════════════════════════════════════════
 * 极简路由
 * ══════════════════════════════════════════════════════════════════════ */

const routes = { GET: [], POST: [] };
const on = (method, pattern, handler) => routes[method].push({ pattern, handler });

function matchRoute(method, pathname) {
  for (const r of routes[method]) {
    const m = matchPattern(r.pattern, pathname);
    if (m) return { handler: r.handler, params: m };
  }
  return null;
}

function matchPattern(pattern, pathname) {
  if (pattern === pathname) return {};
  if (pattern.indexOf(':') < 0) return null;
  const p = pattern.split('/'), q = pathname.split('/');
  if (p.length !== q.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].charAt(0) === ':') params[p[i].slice(1)] = decodeURIComponent(q[i]);
    else if (p[i] !== q[i]) return null;
  }
  return params;
}

/* ── 请求/响应小工具 ─────────────────────────────────────────────────── */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes) {
  const limit = limitBytes || 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('提交的内容太大了（超过 ' + Math.round(limit / 1048576) + ' MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 32 * 1024 * 1024);
  if (!buf.length) return {};
  let v;
  try { v = JSON.parse(buf.toString('utf8')); }
  catch (e) { throw new Ops.OpError('提交的数据格式不对（不是合法的 JSON）', 'BAD_JSON'); }
  // body 写成 `null` / `123` / `"x"` 时也当空对象处理：
  // 否则后面读 body.op 会抛 TypeError，日志里留一堆吓人的堆栈（实际只是个空请求）
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
  return v;
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

/* ── 鉴权包装 ─────────────────────────────────────────────────────────── */

function withUser(handler) {
  return async (req, res, params, ctx) => {
    if (!ctx.user) return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '请先登录' });
    return handler(req, res, params, ctx);
  };
}

function withRole(minRole, handler) {
  return withUser(async (req, res, params, ctx) => {
    if (!Auth.can(ctx.user.role, minRole === 'admin' ? '__admin__' : '__op__')) {
      // __admin__ 不在表里 → 只有 admin 通过；__op__ 同理
      if (minRole === 'admin' && ctx.user.role !== 'admin') {
        return sendJson(res, 403, { ok: false, code: 'FORBIDDEN', message: '只有管理员能做这个操作' });
      }
      if (minRole === 'operator' && ctx.user.role === 'viewer') {
        return sendJson(res, 403, { ok: false, code: 'FORBIDDEN', message: '只读账号不能修改数据' });
      }
    }
    return handler(req, res, params, ctx);
  });
}

/** CSRF：写操作必须带与会话匹配的令牌 */
function checkCsrf(req, ctx) {
  if (!ctx.user) return;
  const token = req.headers['x-csrf'] || '';
  if (!token || token !== ctx.user.csrf) {
    throw new Ops.OpError('登录状态已过期或页面已失效，请刷新页面重新登录', 'CSRF');
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 接口：公开（免登录，只读）
 * ══════════════════════════════════════════════════════════════════════ */

on('GET', '/api/health', (req, res) => {
  const meet = db.currentMeet(d);
  sendJson(res, 200, {
    ok: true, at: nowIso(), rev: meet ? Number(meet.rev) : 0,
    version: require('./package.json').version, node: process.version,
  });
});

on('GET', '/api/info', (req, res) => {
  const meet = db.currentMeet(d);
  sendJson(res, 200, {
    ok: true,
    meet: meet ? {
      id: meet.id, name: meet.name, subtitle: meet.subtitle, host: meet.host,
      holdDate: meet.holdDate, rev: Number(meet.rev || 1),
    } : null,
    serverTime: nowIso(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tzOffset: -new Date().getTimezoneOffset(),
    version: require('./package.json').version,
    needsSetup: !meet,
  });
});

/**
 * 名单导入"认哪些表头"（导入界面用它做提示与预览）。
 * 直接取 ops.js 里的 HDR，和真正导入时用的是同一套规则 ——
 * 两边各写一套的话，迟早会出现"预览说认得、导入却不认"。
 */
on('GET', '/api/import/columns', (req, res) => {
  const LABEL = {
    name: '姓名', bib: '号码', group: '组别', className: '班级',
    grade: '年级', team: '单位', gender: '性别', note: '备注',
  };
  const order = ['name', 'group', 'grade', 'className', 'bib', 'team', 'gender', 'note'];
  const columns = order.filter(f => Ops.HDR[f]).map((field) => ({
    field,
    label: LABEL[field] || field,
    required: field === 'name',
    accepts: Ops.HDR[field].exact.slice(),
  }));
  sendJson(res, 200, { ok: true, columns, required: ['name'] });
});

/* 大屏专用快照（免登录，里面不含任何账号/备份/审计信息） */
on('GET', '/api/snapshot/screen', (req, res) => {
  const meet = db.currentMeet(d);
  if (!meet) return sendJson(res, 200, { ok: true, empty: true, at: nowIso() });
  const url = new URL(req.url, 'http://x');
  const snap = Board.screenSnapshot(d, meet.id);
  // screen 快照本身就是可以整份公开的；如果整份太大，允许裁剪（默认给全量，逻辑最简单最不易错）
  const full = url.searchParams.get('full') !== '0';
  sendJson(res, 200, full ? snap : snap);
});

/* 兼容旧调用：/api/snapshot?kind=screen */
on('GET', '/api/snapshot', (req, res, params, ctx) => {
  const url = new URL(req.url, 'http://x');
  const kind = url.searchParams.get('kind') || 'screen';
  const meet = db.currentMeet(d);
  if (!meet) return sendJson(res, 200, { ok: true, empty: true, at: nowIso() });
  if (kind === 'screen') return sendJson(res, 200, Board.screenSnapshot(d, meet.id));
  if (!ctx.user) return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '请先登录' });
  if (kind === 'admin') return sendJson(res, 200, Board.adminSnapshot(d, meet.id));
  return sendJson(res, 400, { ok: false, message: '不支持的数据类型：' + kind });
});

/* 大屏的 SSE（免登录） */
on('GET', '/api/stream/screen', (req, res) => {
  openStream(req, res, 'screen');
});

/* 后台的 SSE（需登录；大屏是免登录的） */
/* ══════════════════════════════════════════════════════════════════════
 * 实时通道（SSE）
 *
 * 【原来错在哪】streams 里只存了裸的 res 对象 —— 服务端**不知道这条连接是谁的**。
 * 于是在建立连接之后退出登录、改密码、被停用，这条连接照样继续收到数据
 * （实测：建连 → 退出 → 触发推送，原连接仍收到 data:）。
 * 大屏是免登录的，这个问题只在后台连接上有，但后台数据更敏感
 * （谁在录什么成绩、暂存了什么改动）。
 *
 * 【做法】每条连接记 { res, sid, uid }：
 *   · 推送前逐条验会话还在不在（会话被删/过期/用户停用 → 立刻断开）
 *   · 心跳里也验一次，保证"没有人操作也推送"时同样会失效
 *   · 登出、改密、停用、删号时主动扫一遍并把相关连接关掉（见 closeStreamsFor）
 * 大屏连接 sid/uid 为空，不做会话校验（它本来就是给大屏看的公开数据）。
 * ══════════════════════════════════════════════════════════════════════ */

/** 这条连接的会话还有效吗？大屏连接（没有 sid）一律算有效 */
function streamAlive(conn) {
  if (!conn.sid) return true;
  try {
    const s = d.get('SELECT * FROM session WHERE id = ?', [conn.sid]);
    if (!s) return false;
    if (new Date(s.expiresAt).getTime() < Date.now()) return false;
    const u = d.get('SELECT id, disabled FROM user WHERE id = ?', [s.userId]);
    if (!u || u.disabled) return false;
    return true;
  } catch (e) {
    return true;                      // 查库出错时不要误踢人，下一轮再验
  }
}

/** 主动关闭某个人（或某个会话）的所有实时连接 */
function closeStreamsFor(opts) {
  const o = opts || {};
  let n = 0;
  Object.keys(streams).forEach((kind) => {
    for (const conn of Array.from(streams[kind])) {
      const hit = (o.sid && conn.sid === o.sid) || (o.uid && conn.uid === o.uid);
      if (!hit) continue;
      try {
        conn.res.write('data: ' + JSON.stringify({
          type: 'bye', reason: o.reason || '登录状态已失效，请重新登录',
        }) + '\n\n');
        conn.res.end();
      } catch (e) { /* ignore */ }
      closeConn(kind, conn);
      n++;
    }
  });
  if (n) log('已关闭 ' + n + ' 条实时连接（' + (o.reason || '会话失效') + '）');
  return n;
}

/** 把一条连接从集合里摘掉并停掉它的心跳 */
function closeConn(kind, conn) {
  try { clearInterval(conn.ping); } catch (e) { /* ignore */ }
  const set = streams[kind];
  if (set) set.delete(conn);
}

/* auth.js 销毁会话（退出/改密/停用/删号）时会回调这里 ——
   把那条会话上的实时连接立刻关掉，别让人已经退出还在收数据。 */
Auth.setSessionGoneHandler((info) => closeStreamsFor(info));

on('GET', '/api/stream/admin', (req, res, params, ctx) => {
  if (!ctx.user) return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '请先登录' });
  // 记下会话 id 与用户 id，推送前要验它们还活着
  openStream(req, res, 'admin', { sid: ctx.user.sessionId || '', uid: ctx.user.id });
});

function openStream(req, res, kind, who) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',       // nginx 反代要关缓冲，否则大屏会卡住不动
  });
  res.write('retry: 3000\n\n');

  const meet = db.currentMeet(d);
  // 首包就是一份完整快照：客户端拿到就能直接画，不用再发一次请求
  try {
    const snap = meet ? snapshotFor(kind, meet.id, {}) : { empty: true, at: nowIso() };
    res.write('data: ' + JSON.stringify({ type: 'hello', kind, data: snap }) + '\n\n');
  } catch (err) {
    logErr('生成首包快照失败', err && err.message);
    res.write('data: ' + JSON.stringify({ type: 'hello', kind, data: null }) + '\n\n');
  }

  const conn = {
    res: res, kind: kind,
    sid: (who && who.sid) || '',
    uid: (who && who.uid) || '',
    ping: null,
  };
  streams[kind].add(conn);
  log('大屏/客户端接入实时通道：' + kind + '（当前 ' + streams[kind].size + ' 个）');

  conn.ping = setInterval(() => {
    /* 心跳里顺便验一次会话 —— 这样"没人操作、只有自动状态切换在推送"时，
       已经退出的连接也会在一个心跳周期内被断开，不会一直挂着收数据。 */
    if (!streamAlive(conn)) {
      try {
        res.write('data: ' + JSON.stringify({
          type: 'bye', reason: '登录状态已失效，请重新登录',
        }) + '\n\n');
        res.end();
      } catch (e) { /* ignore */ }
      closeConn(kind, conn);
      log('客户端断开实时通道（会话已失效）：' + kind + '（剩 ' + streams[kind].size + ' 个）');
      return;
    }
    try { res.write('data: ' + JSON.stringify({ type: 'ping', at: nowIso() }) + '\n\n'); }
    catch (e) { /* 连接已断，下面的 close 会清理 */ }
  }, 15000);

  const cleanup = () => {
    closeConn(kind, conn);
    log('客户端断开实时通道：' + kind + '（剩 ' + streams[kind].size + ' 个）');
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

/* ══════════════════════════════════════════════════════════════════════
 * 接口：登录
 * ══════════════════════════════════════════════════════════════════════ */

on('POST', '/api/login', async (req, res) => {
  const body = await readJson(req);
  const out = Auth.login(d, body.username, body.password, {
    ip: clientIp(req), agent: req.headers['user-agent'],
  });
  if (!out.ok) {
    Auth.auditWith(d, null, 'user.login.fail', String(body.username || ''), null, null, out.error, clientIp(req));
    return sendJson(res, 401, { ok: false, code: 'BAD_LOGIN', message: out.error });
  }
  // 登录成功这条审计要带上**这次新建的会话 id** —— listSessions 靠它把这个 IP
  // 从"历史登录 IP"里排除掉，否则"新 IP"永远标不出来（详见 listSessions 的注释）
  Auth.auditWith(d, out.user, 'user.login', out.user.username, null, null, '',
    clientIp(req), out.session.id);

  /* ── 一个账号只留一台设备：把其它会话顶下线 ──────────────────────────
   *
   * 【为什么】共用账号是现场最容易被忽略的出错来源：两个人用同一个操作员账号、
   * 各自在自己手机上录成绩，录到同一个项目就会互相覆盖（乐观锁会拦，
   * 但两人会不停看到"刚被别人改过"，越录越乱）。一人一台才干净。
   *
   * 【为什么还要写 kickNote】被顶的那台如果只是"突然要重新登录"，
   * 老师会以为系统坏了或者被盗号了。所以把原因记下来，
   * 那台设备下次请求（轮询/刷新/点任何东西）就能看到一句人话。
   *
   * 【顺序】先记 note、再删会话、最后断实时连接 ——
   * 断连接会让对方立刻发起请求，那时候 note 必须已经写好了。
   */
  let displaced = 0;
  if (!ALLOW_MULTI_DEVICE) {
    const olds = d.all('SELECT id, ip, agent FROM session WHERE userId = ? AND id <> ?',
      [out.user.id, out.session.id]);
    const from = clientIp(req);
    olds.forEach((s) => {
      const reason = '这个账号在另一台设备上登录了'
        + (from ? ('（' + from + '）') : '')
        + '，当前这台已被下线。一个账号同一时间只能在一台设备上使用；'
        + '如果是多人一起录成绩，请各自用自己的账号登录。';
      d.run('INSERT OR REPLACE INTO kickNote(sessionId, reason, at) VALUES(?,?,?)',
        [s.id, reason, nowIso()]);
    });
    if (olds.length) {
      displaced = d.run('DELETE FROM session WHERE userId = ? AND id <> ?',
        [out.user.id, out.session.id]).changes || 0;
      // 被顶的那台要立刻知道（否则它会一直重连/轮询，让人以为卡了）
      olds.forEach((s) => {
        closeStreamsFor({ sid: s.id, reason: '这个账号在另一台设备上登录了，你已被下线' });
      });
      Auth.auditWith(d, out.user, 'session.displace', out.user.username, null, null,
        '在 ' + (from || '未知 IP') + ' 登录，顶下线了另外 ' + displaced + ' 台设备'
        + (olds.map(s => '（' + (s.ip || '未知 IP') + '）').join('')), from, out.session.id);
    }
  }

  res.setHeader('Set-Cookie', Auth.cookieHeader(out.session.id, { secure: SECURE_COOKIES }));
  sendJson(res, 200, {
    ok: true, user: out.user, csrf: out.session.csrf, expiresAt: out.session.expiresAt,
    displaced: displaced,          // 顶掉了几台（界面可以提示一下）
    multiDevice: ALLOW_MULTI_DEVICE, // 当前是否允许多设备
  });
  schedulePush();  // 后台在线人数变了，推一下（大屏不关心，但后台要）
});

on('POST', '/api/logout', async (req, res, params, ctx) => {
  if (ctx.user) {
    Auth.destroySession(d, ctx.user.sessionId);
    Auth.auditWith(d, ctx.user, 'user.logout', ctx.user.username, null, null, '', clientIp(req));
    /* 会话没了，这条会话上的实时连接也必须立刻断 ——
       否则人已经退出，页面上还继续滚着后台数据（实测过）。 */
    closeStreamsFor({ sid: ctx.user.sessionId, reason: '你已退出登录' });
  }
  res.setHeader('Set-Cookie', Auth.clearCookieHeader());
  sendJson(res, 200, { ok: true });
});

/* ── 会话为什么没了（给被顶下线的设备一个说法） ──────────────────────────
 *
 * 一个账号只能在一台设备登录，所以"在手机上登录"会把"电脑上那台"顶掉。
 * 被顶掉的那台必须知道自己**为什么**被踢，否则老师看到的是
 * "怎么突然要重新登录了 / 是不是坏了 / 是不是被盗号了"。
 *
 * 页面两条路都会问到：
 *   · SSE 还连着 → 服务端断开前会推一条 `bye`（带 reason），页面直接弹提示
 *   · SSE 已断（或页面刚刷新）→ 调这个接口问"我刚才那条会话怎么了"
 *
 * 只在 Cookie 里带的那个会话 id 上查，不需要登录态（会话已经被删了）。
 */
function peekKickNote(sid) {
  if (!sid) return null;
  try {
    const row = d.get('SELECT reason, at FROM kickNote WHERE sessionId = ?', [sid]);
    if (!row) return null;
    /* 太老的说明就不提了：页面关了半小时再打开，
       直接当"未登录、请登录"处理更自然，翻旧账反而莫名其妙。 */
    const age = Date.now() - new Date(row.at).getTime();
    if (!Number.isFinite(age) || age > 10 * 60 * 1000) return null;
    return row.reason || '这条登录已在别处失效';
  } catch (e) { return null; }
}

on('GET', '/api/session/note', (req, res) => {
  const cookies = Auth.parseCookies(req.headers.cookie || '');
  const sid = cookies[Auth.COOKIE_NAME] || '';
  const reason = peekKickNote(sid);
  sendJson(res, 200, { ok: true, reason: reason, multiDevice: ALLOW_MULTI_DEVICE });
});

on('GET', '/api/me', (req, res, params, ctx) => {
  if (!ctx.user) {
    /* 没登录也把"是不是被顶下线了"告诉页面，这样刷新一下也能看到原因 */
    const cookies = Auth.parseCookies(req.headers.cookie || '');
    return sendJson(res, 200, {
      ok: true, user: null,
      invalidReason: peekKickNote(cookies[Auth.COOKIE_NAME] || ''),
      multiDevice: ALLOW_MULTI_DEVICE,
    });
  }
  sendJson(res, 200, {
    ok: true,
    user: {
      id: ctx.user.id, username: ctx.user.username,
      displayName: ctx.user.displayName, role: ctx.user.role,
      roleLabel: Auth.ROLE_LABEL[ctx.user.role] || ctx.user.role,
    },
    csrf: ctx.user.csrf,
    multiDevice: ALLOW_MULTI_DEVICE,
    perms: {
      canAdmin: ctx.user.role === 'admin',
      canWrite: ctx.user.role !== 'viewer',
      // 前端拿这些决定"显示哪些页签、哪些按钮"。
      // 注意：这是显示口径，真正的拦截始终在服务端（Auth.ACTION_ROLE / can()）。
      role: ctx.user.role,
      tabs: Auth.ROLE_TABS[ctx.user.role] || [],
    },
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 接口：写操作（统一指令）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 直接执行一条改动（**立即生效、立即返回结果**）。
 *
 * 用途：需要拿返回值的操作 —— 自动录取决赛（要拿新项目的 id）、账号管理等，
 * 以及成绩/检录这类现场实时协同的写入。
 *
 * 【"改动需确认"在哪里】不在这里，在 /api/staged：
 *   管理员的编排类改动走 /api/staged → 进暂存区，等"确认修改并推送大屏"；
 *   操作员走同一个接口但**直接生效**（判断写在 Ops.stage() 里，只有一处）。
 *   前端的分工：普通编辑用 A.cmd()（走 /api/staged），
 *   需要立即结果的操作才用 App.op()（走这里）。
 */
on('POST', '/api/op', withUser(async (req, res, params, ctx) => {
  checkCsrf(req, ctx);
  const body = await readJson(req);
  beginTouch();                       // 记下"改动前"的版本（增量的 base）
  const out = Ops.execute({
    d, user: ctx.user, op: body.op, payload: body.payload || {},
    clientUuid: body.clientUuid, meetId: body.meetId, source: ctx.source, ip: clientIp(req),
  });
  markTouched(...touchedByOp(body.op, body.payload));
  sendJson(res, 200, { ok: true, data: out });
  schedulePush();
}));

on('POST', '/api/op/batch', withUser(async (req, res, params, ctx) => {
  checkCsrf(req, ctx);
  const body = await readJson(req);
  beginTouch();
  const out = Ops.executeBatch({ d, user: ctx.user, items: body.items || [], meetId: body.meetId });
  (body.items || []).forEach(it => markTouched(...touchedByOp(it.op, it.payload)));
  sendJson(res, 200, { ok: true, data: out });
  schedulePush();
}));

/* ── 暂存 / 预览 / 确认 ───────────────────────────────────────────────── */

on('POST', '/api/staged', withUser(async (req, res, params, ctx) => {
  checkCsrf(req, ctx);
  const body = await readJson(req);
  const out = Ops.stage({ d, user: ctx.user, payload: body, meetId: body.meetId });
  sendJson(res, 200, { ok: true, data: out });
  schedulePush();     // 后台的"待确认 N 项"要同步给其它后台
}));

/* 暂存区：只有管理员在管它（管理员的改动要确认才生效）。
 *
 * 【为什么要收紧】原来这三个接口都只要求"登录"：
 *   · drop  —— 实测只读账号能清空管理员的暂存（HTTP 200 / removed:1）
 *   · GET   —— 低权限账号能读到管理操作的**载荷**（谁改了什么、改成什么）
 * 界面不给低权限账号显示按钮**不是**防护 —— 知道地址就能直接调接口。
 *
 * 另外：暂存项是"某个人自己攒着待确认的改动"，所以**只有暂存它的人和管理员**
 * 能撤掉它。否则 A 攒了 10 条、B 一激动全清掉，A 白干。 */
on('GET', '/api/staged', withRole('admin', (req, res) => {
  const meet = db.currentMeet(d);
  if (!meet) return sendJson(res, 200, { ok: true, data: { items: [] } });
  sendJson(res, 200, { ok: true, data: { items: Ops.listStaged(d, meet.id), rev: Ops.revOf(d, meet.id) } });
}));

on('POST', '/api/staged/drop', withRole('admin', async (req, res, params, ctx) => {
  checkCsrf(req, ctx);
  const body = await readJson(req);
  const meet = db.currentMeet(d);
  if (!meet) return sendJson(res, 400, { ok: false, message: '还没有建立运动会数据' });
  let out;
  if (body.all) {
    out = Ops.clearStaged(d, meet.id);
    Auth.auditWith(d, ctx.user, 'staged.clearAll', 'staged:*', null, null,
      '清空了 ' + out.removed + ' 条暂存改动', clientIp(req));
  } else {
    const id = String(body.id || '');
    // 撤掉单条：要把那条的内容也记进审计，否则"谁撤了什么"查不出来
    const item = Ops.listStaged(d, meet.id).filter(x => x.id === id)[0];
    out = Ops.unstage(d, meet.id, id);
    Auth.auditWith(d, ctx.user, 'staged.drop', 'staged:' + id, item || null, null,
      item ? ('撤掉了暂存改动：' + (item.label || item.op)) : '撤掉一条暂存改动（已不存在）',
      clientIp(req));
  }
  sendJson(res, 200, { ok: true, data: out });
  schedulePush();
}));

on('GET', '/api/preview', withRole('admin', (req, res, params, ctx) => {
  const meet = db.currentMeet(d);
  if (!meet) return sendJson(res, 200, { ok: true, data: { empty: true } });
  const out = Ops.preview({ d, meetId: meet.id, user: ctx.user });
  sendJson(res, 200, { ok: true, data: out });
}));

on('POST', '/api/confirm', withRole('admin', async (req, res, params, ctx) => {
  checkCsrf(req, ctx);
  const body = await readJson(req);
  const meet = db.currentMeet(d);
  if (!meet) return sendJson(res, 400, { ok: false, message: '还没有建立运动会数据' });
  /* force：操作者在界面上看到了冲突提示之后明确选择"仍然按暂存的值覆盖"。
     没有它，冲突时一律整体拒绝 —— 宁可让人多点一下，也不能静默覆盖别人的改动。 */
  const out = Ops.confirm({
    d, meetId: meet.id, user: ctx.user, force: !!body.force, ip: clientIp(req),
  });
  if (out.conflicts && out.conflicts.length) {
    return sendJson(res, 409, { ok: false, code: 'STAGED_CONFLICT', message: out.error, data: out });
  }
  if (out.failed && out.failed.length) {
    return sendJson(res, 409, { ok: false, code: 'CONFIRM_FAILED', message: out.error, data: out });
  }
  /* 逐项的前后值由 Ops.confirm 自己写进 auditLog（每一项一条，能看到从什么变成什么）。
     这里不再重复记一条汇总 —— 重复记会让"这条改动是谁确认的"查起来有两份。
     但保留一条汇总便于快速检索整批确认这件事。 */
  Auth.auditWith(d, ctx.user, 'staged.confirmed', 'staged:batch', null, null,
    '确认了 ' + out.applied + ' 项暂存改动', clientIp(req));
  out.rev = Ops.revOf(d, meet.id);
  sendJson(res, 200, { ok: true, data: out });
  schedulePush();
}));

/* ── 某个运动员报了哪些项目（名单页"报名 N 项"展开用） ───────────────── */

/**
 * 为什么单独一个接口：主快照里的 athletes 只带 regCount（省流量），
 * 905 个运动员的完整报名明细塞进快照会让每一条推送都变大好几倍。
 * 只有用户真去点开某个人时才查这一次。
 */
on('GET', '/api/athlete/:id/regs', withUser((req, res, params, ctx) => {
  const meet = db.currentMeet(d);
  const ath = d.get('SELECT * FROM athlete WHERE id = ? AND meetId = ?', [params.id, meet.id]);
  if (!ath) return sendJson(res, 404, { ok: false, message: '找不到这个运动员' });
  const rows = d.all(`SELECT r.*, e.name AS eventName, e.stage, e.kind, e.isRelay, e.sort,
                             e.advanceFromId, e.status AS eventStatus,
                             (SELECT COUNT(*) FROM result x WHERE x.regId = r.id) AS resultCount
                      FROM registration r
                      JOIN event e ON e.id = r.eventId
                      WHERE r.athleteId = ?
                      ORDER BY e.sort`, [ath.id]);
  sendJson(res, 200, {
    ok: true,
    data: {
      athlete: { id: ath.id, name: ath.name, bib: ath.bib, team: ath.team, className: ath.className },
      regs: rows.map((r) => ({
        id: r.id, eventId: r.eventId, eventName: r.eventName, stage: r.stage,
        kind: r.kind, isRelay: !!r.isRelay, eventStatus: r.eventStatus,
        teamName: r.teamName || '',
        legs: (() => { try { return r.legsJson ? JSON.parse(r.legsJson) : []; } catch (e) { return []; } })(),
        hasResult: !!r.resultCount,
        resultCount: r.resultCount,
      })),
    },
  });
}));

/* ── 单项目成绩板（录入页与后台都用） ─────────────────────────────────── */

on('GET', '/api/events/:id/board', withUser((req, res, params, ctx) => {
  const meet = db.currentMeet(d);
  const ctxData = Board.load(d, meet.id);
  const ev = ctxData.eventById.get(params.id);
  if (!ev) return sendJson(res, 404, { ok: false, message: '找不到这个项目' });
  const board = Board.eventBoard(ctxData, ev);
  sendJson(res, 200, {
    ok: true,
    data: {
      event: {
        id: ev.id, name: ev.name, kind: ev.kind, stage: ev.stage, isRelay: !!ev.isRelay,
        relayLegs: ev.relayLegs, attempts: ev.attempts, tol: ev.tol, unit: ev.unit,
        status: ev.status, statusMode: ev.statusMode, venue: ev.venue,
        startAt: ev.startAt, endAt: ev.endAt, meta: Board.eventMeta(ctxData, ev),
      },
      entries: board.entries.map(e => ({
        regId: e.regId, name: e.name, bib: e.bib, team: e.team,
        grade: e.grade, className: e.className, lane: e.lane, legs: e.legs,
        arrived: e.arrived, best: e.best, dnf: !!e.dnf, attempts: e.attemptsRaw,
        /* 【别漏这两个】录入页每行的「屏蔽」按钮要用：
             athleteId → athlete.block 按运动员 id 操作
             blocked   → 按钮文字（屏蔽/取消屏蔽）和整行灰掉的状态
           漏了的表现是"按钮点了没反应"（id 是 undefined，服务端 400）。
           接力报名没有 athleteId（整队一条），前端据此不显示这个按钮。 */
        athleteId: e.athleteId || null,
        blocked: !!e.blocked,
      })),
      /* rows = **名次榜**（已排除被屏蔽的人）；entries = 全部报名（含被屏蔽的）。 */
      rows: board.board.rows,
      /* 被屏蔽的人数，页面上可以提示一句"本项已屏蔽 N 人" */
      blockedCount: board.blocked || 0,
      checkin: board.checkin,
    },
  });
}));

/* ── 名单（三重筛选 + 搜索） ────────────────────────────────────────────
 *
 * 【第 3 趟改造】名单**不再塞进后台快照**，改成这个接口按需拉。
 * 原因：905 名运动员的完整明细约 209 KB，而后台快照总共 296 KB ——
 * 也就是**每次推送的 71% 是名单**，而绝大多数改动（录成绩、检录）根本不碰名单。
 *
 * 这里支持服务端筛选 + 分页，所以名单页打开时只传它要显示的那一页。
 * grades / classes 两个下拉的候选值始终按**全量**算（不受当前筛选影响），
 * 否则选了一个年级之后，别的年级就从下拉里消失了。
 */
on('GET', '/api/roster', withUser((req, res) => {
  const url = new URL(req.url, 'http://x');
  const meet = db.currentMeet(d);
  if (!meet) return sendJson(res, 200, { ok: true, data: { athletes: [], total: 0, count: 0 } });
  const ctxData = Board.load(d, meet.id);
  const search = str(url.searchParams.get('search'), 40).toLowerCase();
  const groupId = url.searchParams.get('groupId') || '';
  const grade = url.searchParams.get('grade') || '';
  const className = url.searchParams.get('className') || '';
  const eventId = url.searchParams.get('eventId') || '';
  const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 200));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

  let list = Board.sortAthletes(ctxData);
  if (groupId) list = list.filter(a => a.groupId === groupId);
  if (grade) list = list.filter(a => (a.grade || '') === grade);
  if (className) list = list.filter(a => (a.className || '') === className);

  /* ── 按项目筛：只出**这个项目的报名名单** ──────────────────────────────
   * 现场用途：打印/核对某个项目的名单、或者看"这个项目都有谁"。
   *
   * ⚠ 只覆盖**个人项目**。接力是一个班一条报名记录（队员存在 legsJson 里，
   *   是**姓名文本**，没有对应的运动员 id），所以按接力项目筛不出"某个人"，
   *   只能筛出"哪些班参赛"。传接力项目时这里不筛（否则会误滤成空名单），
   *   由前端在提示里说明。
   */
  let eventFilter = null;
  if (eventId) {
    const evRow = d.get('SELECT * FROM event WHERE id = ? AND meetId = ?', [eventId, meet.id]);
    if (evRow && !evRow.isRelay) {
      eventFilter = evRow;
      const allowed = new Set(
        d.all('SELECT athleteId FROM registration WHERE eventId = ? AND athleteId IS NOT NULL', [eventId])
          .map(r => r.athleteId));
      list = list.filter(a => allowed.has(a.id));
    }
  }

  if (search) {
    list = list.filter(a => String(a.name || '').toLowerCase().indexOf(search) >= 0
      || String(a.bib || '').toLowerCase().indexOf(search) >= 0);
  }

  const page = list.slice(offset, offset + limit);
  // 报名项数：名单页要显示"报名 N 项"。用聚合查询一次算完（别按人循环查）
  const regCount = {};
  /* 按项目筛时，额外给出"这个人报的项目名"——
     现场核对这个项目的名单时，顺便能看到他还兼了什么项（避免兼项冲突）。 */
  const eventsOf = {};
  if (page.length) {
    const ids = page.map(a => a.id);
    const marks = ids.map(() => '?').join(',');
    d.all('SELECT athleteId, COUNT(*) c FROM registration WHERE athleteId IN (' + marks + ') GROUP BY athleteId', ids)
      .forEach(r => { regCount[r.athleteId] = r.c; });
    if (eventFilter) {
      d.all(`SELECT r.athleteId, e.name AS en FROM registration r
             JOIN event e ON e.id = r.eventId
             WHERE r.athleteId IN (` + marks + `) AND r.eventId != ?`, ids.concat([eventFilter.id]))
        .forEach((r) => { (eventsOf[r.athleteId] = eventsOf[r.athleteId] || []).push(r.en); });
    }
  }

  sendJson(res, 200, {
    ok: true,
    data: {
      total: ctxData.athletes.length,
      count: list.length,
      offset: offset, limit: limit,
      rev: Number(ctxData.meet.rev || 1),        // 客户端用它判断"我拿的名单是不是最新的"
      grades: Array.from(new Set(ctxData.athletes.map(a => a.grade).filter(Boolean)))
        .sort((a, b) => gradeRank(a) - gradeRank(b)),
      classes: Array.from(new Set(ctxData.athletes.map(a => a.className).filter(Boolean)))
        .sort((a, b) => classRank(a) - classRank(b)),
      /* 筛选下拉用的项目清单（只给个人项目 —— 接力的队员不是"报名的人"） */
      events: ctxData.events
        .filter(e => !e.isRelay)
        .map(e => ({
          id: e.id, name: e.name,
          groupName: (ctxData.groupById.get(e.groupId) || {}).name || '',
          regs: (ctxData.regsByEvent && ctxData.regsByEvent.get(e.id)
            ? ctxData.regsByEvent.get(e.id).length : 0),
        })),
      eventFilter: eventFilter ? { id: eventFilter.id, name: eventFilter.name, relay: false } : null,
      /* ── 接力队伍 ────────────────────────────────────────────────────────
       * 【为什么由名单接口一起给】接力不是"某个人报名"，而是**一个班一条报名记录**，
       *   队员是存在 legsJson 里的姓名文本（没有运动员 id）。所以它既进不了
       *   athletes 列表，也筛不出"某个人"。名单页要能**看和管**这些队
       *   （新建 / 填改队员 / 按班级自动补齐 / 删队），就得单独给它一份数据。
       *   数量很小（10 个接力项目 × 每项十来个班），跟着名单一起回最省事。
       *
       * 每队给出：队名、绑定的班级（没有就是空）、队员姓名、以及有没有成绩
       *   （**有成绩的不让删** —— 删了成绩一起没，风险大，前端据此禁用删除按钮）。
       */
      relayTeams: (() => {
        const evs = ctxData.events.filter(e => e.isRelay);
        return evs.map((e) => {
          const regs = (ctxData.regsByEvent.get(e.id) || []).slice();
          return {
            eventId: e.id,
            eventName: e.name,
            groupId: e.groupId,
            groupName: (ctxData.groupById.get(e.groupId) || {}).name || '',
            legs: Number(e.relayLegs) || 4,
            status: e.status,
            teams: regs.map((r) => {
              let legsArr = [];
              try { legsArr = JSON.parse(r.legsJson || '[]'); } catch (err) { legsArr = []; }
              if (!Array.isArray(legsArr)) legsArr = [];
              const hasResult = ctxData.results.some(x => x.regId === r.id);
              return {
                id: r.id,
                teamName: r.teamName || '',
                classId: r.classId || '',
                className: r.classId ? ((ctxData.classById.get(r.classId) || {}).label || '') : '',
                legs: legsArr,
                hasResult: hasResult,
              };
            }),
          };
        });
      })(),
      athletes: page.map(a => ({
        id: a.id, name: a.name, bib: a.bib || '',
        groupId: a.groupId, groupName: (ctxData.groupById.get(a.groupId) || {}).name || '',
        grade: a.grade || '', className: a.className || '',
        team: Board.athleteTeam(ctxData, a), note: a.note || '',
        regCount: regCount[a.id] || 0,
        otherEvents: eventsOf[a.id] || [],
      })),
    },
  });
}));

/* ── 账号列表（单独接口，不进快照：避免把账号信息推给所有连接的客户端） ── */

on('GET', '/api/users', withRole('admin', (req, res) => {
  const rows = d.all(`SELECT id, username, displayName, role, disabled, pwdChangedAt, createdAt, updatedAt
                      FROM user ORDER BY role, username`);
  /* 在线状态：一个账号同一时间只允许一台设备登录（见 config.js 的
     allowMultiDeviceLogin），所以正常情况最多只有一条会话。
     这里给出会话数和"是哪台机器"（IP），账号列表上一眼能看出谁登录着。

     ⚠ "在线"= **最近还在活动**（lastSeenAt 在窗口内），
       不是"会话表里有记录"。否则关掉网页的人会一直显示"已登录"。 */
  pruneSessionsThrottled();
  const nowS = nowIso();
  const sess = d.all(`SELECT userId, ip, lastSeenAt, createdAt FROM session WHERE expiresAt > ?`, [nowS]);
  const byUser = new Map();
  sess.forEach((s) => {
    if (!byUser.has(s.userId)) byUser.set(s.userId, { count: 0, ips: new Set(), online: 0, lastAt: '' });
    const rec = byUser.get(s.userId);
    rec.count++;
    if (sessionIsOnline(s)) rec.online++;
    if (s.ip) rec.ips.add(s.ip);
    const t = s.lastSeenAt || s.createdAt;
    if (t > rec.lastAt) rec.lastAt = t;
  });
  sendJson(res, 200, {
    ok: true,
    data: {
      multiDevice: ALLOW_MULTI_DEVICE,
      onlineWindowSec: Math.round(ONLINE_WINDOW_MS / 1000),
      serverTime: nowIso(),
      users: rows.map((u) => {
        const rec = byUser.get(u.id);
        return {
          id: u.id, username: u.username, displayName: u.displayName, role: u.role,
          disabled: !!u.disabled,
          /* online = 还活着；loggedIn = 有会话但可能已经关页面了。
             界面按这两个分别显示"在线"/"已离线（还留着登录）"。 */
          online: !!(rec && rec.online > 0),
          loggedIn: !!rec,
          sessionCount: rec ? rec.count : 0,
          onlineCount: rec ? rec.online : 0,
          ipCount: rec ? rec.ips.size : 0,
          sessionIp: rec ? (Array.from(rec.ips)[0] || '') : '',
          lastSeenAt: rec ? rec.lastAt : '',
          roleLabel: Auth.ROLE_LABEL[u.role] || u.role,
          createdAt: u.createdAt, updatedAt: u.updatedAt,
        };
      }),
    },
  });
}));

/* ── 在线会话（"多地登录"看得见、能处置） ────────────────────────────────
 *
 * 【为什么要有】这套系统**允许同一账号在多台设备、多个地点同时登录**，
 * 而且会话**不绑 IP** —— 这是故意的：现场一个操作员可能同时用手机录成绩、
 * 用电脑看名单，绑 IP 会把人踢下线。
 * 但代价是：账号被盗之后，攻击者从别的地方登录，界面上只显示一个"在线"，
 * 看不出"这个账号现在有 3 个地方在登"。
 *
 * 这两个接口把这件事变成看得见的：
 *   GET  /api/sessions?userId=xxx   列出会话（IP / 设备 / 最后活跃 / 是不是新 IP）
 *   POST /api/sessions/kick         踢掉指定的一个会话
 *
 * 【权限】管理员看所有人的、踢所有人的；其它角色只能看/踢自己的
 *   （自己的会话在别人电脑上忘了退，应该能自己踢掉）。
 * 【防呆】不许把自己**当前这条**会话踢掉 —— 那等于自己按了退出，
 *   而且会让人以为"踢人把管理员自己踢出去了"。要退请用右上角的「退出」。
 */

/** 把 UA 缩成一句人话（不装库，认几个常见的就够了） */
function uaLabel(ua) {
  const s = String(ua || '');
  if (!s) return '未知设备';
  const os = /Windows NT 10/.test(s) ? 'Windows'
    : /Windows/.test(s) ? 'Windows'
      : /Android/.test(s) ? 'Android'
        : /iPhone|iPad|iOS/.test(s) ? 'iOS'
          : /Mac OS X/.test(s) ? 'macOS'
            : /Linux/.test(s) ? 'Linux' : '';
  const br = /Edg\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
      : /Chrome\//.test(s) ? 'Chrome'
        : /Firefox\//.test(s) ? 'Firefox'
          : /Safari\//.test(s) ? 'Safari' : '';
  if (os && br) return os + ' · ' + br;
  if (os) return os;
  if (br) return br;
  return s.slice(0, 24);
}

/**
 * 列出一个账号当前有效的会话。
 *
 * 【newIp 是怎么判的 —— 这里有个坑】
 *   "新 IP"的意思是"**这次登录之前**，这个 IP 从没成功登录过"。
 *   而登录成功时**会立刻往审计表里写一条 `user.login`（带本次 IP）** ——
 *   如果直接拿"审计表里出现过的所有 IP"当历史，那么**每一个 IP 都是"历史上出现过"**，
 *   newIp 永远是 false，这个标记就等于没有。
 *   （我第一版就是这么写的，表现是"新 IP 也标不出来"。）
 *
 *   正确做法：历史 IP 只统计**本次会话建立之前**的那些登录记录
 *   （`createdAt < 这条会话的 createdAt`）。这样"这个 IP 以前来过吗"才是真问题。
 *
 * @param {string} userId
 * @param {string} mineSid 当前请求所用的会话 id（用来标出"就是你这条"）
 */
function listSessions(userId, mineSid) {
  const nowS = nowIso();
  const rows = d.all(`SELECT id, userId, createdAt, expiresAt, lastSeenAt, ip, agent
                      FROM session WHERE userId = ? AND expiresAt > ?
                      ORDER BY COALESCE(lastSeenAt, createdAt) DESC`, [userId, nowS]);
  return rows.map((s) => {
    const ip = s.ip || '';
    let newIp = false;
    if (ip) {
      /* "这个 IP 以前登录过吗" —— 要排除掉**本次登录自己写的那条** user.login 记录，
         否则每个 IP 都算"来过"，标记全灭。
         v9 起 auditLog 有了 sessionId，这件事可以问得很准：
         只统计**别的会话**留下的、同一 IP 的成功登录。
         （老记录 sessionId 是 NULL，当作"别的会话"处理，不影响判断。）

         ⚠ 我在这上面绕过两次弯路，都记在这里免得以后再踩：
           ① 拿 userName 去比 —— 审计里存的是**显示名**（"系统管理员"），
              不是登录名（"admin"），一条都查不到，于是**每个 IP 都标成新的**；
           ② 改用"时间早于本会话 createdAt" —— 但登录时是"先建会话、再写审计"，
              两者常在同一毫秒，严格小于比较失败，**还是全标新的**；
              后来我给它加了 2 秒余量，又变成**几秒前刚登录过的 IP 被误标成新的**。
           正确做法是别拿时间猜，直接把会话 id 记进审计里。 */
      const seen = d.get(`SELECT COUNT(*) c FROM auditLog
                          WHERE action = 'user.login' AND userId = ? AND ip = ?
                            AND (sessionId IS NULL OR sessionId <> ?)`,
      [userId, ip, s.id]);
      newIp = !(seen && seen.c > 0);
    }
    return {
      id: s.id,
      current: !!mineSid && s.id === mineSid,
      ip: ip || '（未记录）',
      ipRaw: ip,
      agent: uaLabel(s.agent),
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt || s.createdAt,
      expiresAt: s.expiresAt,
      /* newIp：这个 IP 在这条会话建立之前从没登录过 → 可能是异地/被盗，界面上标黄。
         注意 IP 可能被 X-Forwarded-For 伪造（后端直连公网时），
         所以它只是"值得看一眼"，不是确凿证据。 */
      newIp: newIp,
    };
  });
}

on('GET', '/api/sessions', withUser((req, res, params, ctx) => {
  const url = new URL(req.url, 'http://x');
  const wantId = url.searchParams.get('userId') || '';
  const isAdmin = ctx.user.role === 'admin';
  // 非管理员只能看自己的
  const userId = isAdmin ? (wantId || ctx.user.id) : ctx.user.id;
  const target = d.get('SELECT id, username, displayName, role FROM user WHERE id = ?', [userId]);
  if (!target) return sendJson(res, 404, { ok: false, message: '没有这个账号' });
  sendJson(res, 200, {
    ok: true,
    data: {
      user: {
        id: target.id, username: target.username,
        displayName: target.displayName, role: target.role,
        roleLabel: Auth.ROLE_LABEL[target.role] || target.role,
      },
      sessions: listSessions(userId, ctx.user.sessionId),
      canKickOthers: isAdmin,
    },
  });
}));

on('POST', '/api/sessions/kick', withUser(async (req, res, params, ctx) => {
  checkCsrf(req, ctx);
  const body = await readJson(req);
  const sid = String(body.id || '');
  if (!sid) return sendJson(res, 400, { ok: false, message: '没给会话 id' });
  const s = d.get('SELECT * FROM session WHERE id = ?', [sid]);
  if (!s) return sendJson(res, 404, { ok: false, message: '这个会话已经不存在了（可能已经退出）' });
  // 不许踢自己当前这条
  if (sid === ctx.user.sessionId) {
    return sendJson(res, 400, {
      ok: false, code: 'SELF',
      message: '这是你自己当前的登录。要退出请点右上角的「退出」。',
    });
  }
  // 权限：管理员随便踢；其它人只能踢自己的
  const isAdmin = ctx.user.role === 'admin';
  if (!isAdmin && s.userId !== ctx.user.id) {
    return sendJson(res, 403, { ok: false, code: 'FORBIDDEN', message: '只能踢掉自己的登录' });
  }
  const target = d.get('SELECT username, displayName FROM user WHERE id = ?', [s.userId]) || {};
  const who = (target.displayName || target.username || '管理员');
  const selfKick = target.username === ctx.user.username;
  /* 被踢的那台也要"说得出原因"（和登录顶下线一个道理）——
     否则它只会看到"突然要重新登录"，而管理员这边明明做了个动作。
     必须先写 note 再 destroySession：destroySession 会立刻断开它的实时连接，
     那台设备随即就会来问"我怎么了"。 */
  d.run('INSERT OR REPLACE INTO kickNote(sessionId, reason, at) VALUES(?,?,?)', [
    sid,
    '你的这次登录已被' + (selfKick ? '你自己（在另一台设备上）' : ('管理员「' + who + '」'))
    + '结束，需要重新登录。',
    nowIso(),
  ]);
  Auth.destroySession(d, sid);      // 会顺带断开这条会话上的实时连接（见 auth.js 的钩子）
  Auth.auditWith(d, ctx.user, 'session.kick', 'session:' + sid, null, null,
    '踢掉了' + (selfKick ? '自己' : ('「' + who + '」'))
    + '在 ' + (s.ip || '未知 IP') + '（' + uaLabel(s.agent) + '）上的一次登录',
    clientIp(req), ctx.user.sessionId);
  sendJson(res, 200, { ok: true, data: { kicked: sid, ip: s.ip || '', agent: uaLabel(s.agent) } });
}));

/* ── "在线"是"最近还在活动"，不是"有过会话" ──────────────────────────────
 *
 * 【原来错在哪】账号页的"在线"只查 `session` 表里有没有未过期的会话。
 * 而会话默认能活 14 天 —— 老师早上登录过、中午关了网页回家，
 * 账号页**到明天都还显示"已登录"**。这既没意义，也容易误判
 * （"他明明在线上，怎么不接电话"）。
 *
 * 【现在怎么判】看 `lastSeenAt`（每次带 Cookie 的请求都会刷新）：
 *   最近 ONLINE_WINDOW_MS 内活动过 = 在线。
 * 前端每 30 秒发一次心跳（GET /api/ping），所以：
 *   · 页面开着 → 一直在线
 *   · 关掉网页/断网/合上笔记本 → 最多一个窗口后变"离线"
 * 窗口给 90 秒：比心跳间隔宽 3 倍，偶尔卡一下或手机切网不会误判成离线。
 */
const ONLINE_WINDOW_MS = 90 * 1000;
let lastPruneAt = 0;
function pruneSessionsThrottled() {
  const now = Date.now();
  if (now - lastPruneAt < 60 * 1000) return;
  lastPruneAt = now;
  try { Auth.pruneSessions(d); } catch (e) { /* ignore */ }
}

/** 这个会话现在算"在线"吗 */
function sessionIsOnline(s) {
  const t = new Date(s.lastSeenAt || s.createdAt).getTime();
  return Number.isFinite(t) && (Date.now() - t) <= ONLINE_WINDOW_MS;
}

/* 心跳：页面活着就定时打一下，用来把 lastSeenAt 刷新到现在。
   走 withUser —— 会话失效时它直接 401，前端据此就知道自己掉线了。

   ⚠ 只有这里会写 lastSeenAt。"在线"= 那条会话自己的客户端在报到，
      不是"有人带着它的 Cookie 访问过"。原因见 auth.js 里 currentUser 的注释。 */
on('GET', '/api/ping', withUser((req, res, params, ctx) => {
  Auth.touchSession(d, ctx.user.sessionId);
  sendJson(res, 200, { ok: true, at: nowIso(), user: ctx.user.username });
}));

/* ── 公告 / 聊天 / 检录 / 审计 / 备份 ─────────────────────────────────── */

on('GET', '/api/notices', (req, res) => {
  const meet = db.currentMeet(d);
  if (!meet) return sendJson(res, 200, { ok: true, data: { notices: [] } });
  const list = d.all('SELECT * FROM notice WHERE meetId = ? ORDER BY pinned DESC, createdAt DESC LIMIT 60', [meet.id]);
  sendJson(res, 200, {
    ok: true,
    data: {
      notices: list.map(n => ({
        id: n.id, text: n.text, level: n.level, until: n.until, pinned: !!n.pinned,
        auto: !!n.auto, eventId: n.eventId, byName: n.byName, createdAt: n.createdAt,
      })),
    },
  });
});

on('GET', '/api/chat', withUser((req, res) => {
  const url = new URL(req.url, 'http://x');
  const meet = db.currentMeet(d);
  if (!meet) return sendJson(res, 200, { ok: true, data: { messages: [] } });
  const limit = Math.max(1, Math.min(200, num(url.searchParams.get('limit'), 60)));
  const rows = d.all(`SELECT * FROM chatMessage WHERE meetId = ? ORDER BY createdAt DESC LIMIT ?`, [meet.id, limit]);
  sendJson(res, 200, {
    ok: true,
    data: {
      messages: rows.reverse().map(m => ({
        id: m.id, text: m.deleted ? '' : m.text, deleted: !!m.deleted,
        kind: m.kind, attachId: m.attachId, userName: m.userName, role: m.role,
        userId: m.userId, createdAt: m.createdAt,
      })),
    },
  });
}));

/* ── 附件上传（聊天图片）：存磁盘，库里只记元信息 ────────────────────────
 *
 * 【只收图片】原来还收音频（配合"按住说话"录音）。语音功能已经去掉，原因见
 * public/admin-misc.js 里 renderChat 的注释：浏览器要求 getUserMedia() 跑在
 * 安全上下文里，而现场是 `http://192.168.x.x`，手机上根本拿不到麦克风。
 * 既然不做语音，上传口子也一起收掉 —— **能收什么就只开什么**，
 * 少一类可上传的文件就少一类风险（音频格式的解析面比图片大得多）。
 *
 * 【原来错在哪】只要求"登录"，并且**保留用户给的扩展名**。实测确认：
 *   · 只读账号也能传
 *   · 传一个 a.html 上去，匿名 GET /uploads/xxx.html 会拿到
 *     `Content-Type: text/html` —— 也就是**在应用自己的域名下托管了一个网页**。
 *     把链接发给已登录的管理员，点开就是在同源下执行它里面的脚本。
 *
 * 【三层防护】
 *   ① 角色：只读账号不能上传（它本来就不该产生内容）
 *   ② 扩展名白名单：只收图片，并在**存盘前**按文件头魔数核对内容，
 *      改扩展名蒙混过不去
 *   ③ 存盘时用**我们自己定的**扩展名（从白名单里取），不沿用用户给的名字
 *   另外：/uploads 的响应统一加 nosniff 与 CSP sandbox，杜绝"当网页打开"
 */
const UPLOAD_KINDS = {
  // 扩展名 → 允许的 Content-Type + 文件头魔数（前几个字节的十六进制前缀）
  '.png': { mime: 'image/png', magic: ['89504e47'] },
  '.jpg': { mime: 'image/jpeg', magic: ['ffd8ff'] },
  '.jpeg': { mime: 'image/jpeg', magic: ['ffd8ff'] },
  '.gif': { mime: 'image/gif', magic: ['47494638'] },
  '.webp': { mime: 'image/webp', magic: ['52494646'] },      // RIFF....WEBP
};

/** 取文件头十六进制（最多前 12 字节就够判断了） */
function headHex(buf, n) {
  return buf.slice(0, n || 12).toString('hex').toLowerCase();
}

/**
 * 这个文件真的像它声称的类型吗？
 * @param {string} ext   存盘要用的扩展名（从用户给的文件名取）
 * @param {string} declaredMime 客户端声明的类型（可能不可信、也可能是 multipart）
 * @param {Buffer} buf   文件内容
 * @returns {string} '' = 通过；否则是拒绝原因
 */
function checkUploadType(ext, declaredMime, buf) {
  const spec = UPLOAD_KINDS[ext];
  if (!spec) {
    return '这种文件不能上传（聊天只支持图片：'
      + Object.keys(UPLOAD_KINDS).join(' / ') + '）';
  }
  /* ① 声明的 Content-Type 要对得上。
     【注意】不能直接拿 req.headers['content-type'] 来判 ——
     用 FormData 上传时它是 `multipart/form-data; boundary=...`（传输用的类型），
     **不是文件类型**。我第一版就是这么判的，结果正常 PNG 也被拒了，
     等于把上传功能整个弄坏。所以在路由里把 multipart 过滤掉再传进来；
     这里只做兜底判断。 */
  const dm = String(declaredMime || '').toLowerCase();
  if (dm && dm.indexOf('multipart/') !== 0
      && dm.indexOf('image/') !== 0
      && dm.indexOf('application/octet-stream') !== 0) {
    return '这个文件的类型（' + declaredMime + '）不是图片';
  }
  // ② 文件头魔数要对得上（防止把 .html 改成 .png 传上来）
  const hex = headHex(buf, 12);
  const okMagic = spec.magic.some((m) => {
    if (ext === '.webp') return hex.slice(0, 8) === '52494646' && hex.slice(16, 24) === '57454250';
    return hex.indexOf(m) === 0;
  });
  if (!okMagic) {
    return '这个文件的内容不像 ' + ext + '（可能改了扩展名，或者文件损坏了）';
  }
  return '';
}

on('POST', '/api/upload', withRole('operator', async (req, res, params, ctx) => {
  checkCsrf(req, ctx);
  const url = new URL(req.url, 'http://x');
  const kind = url.searchParams.get('kind') || 'file';
  const origName = safeFilePart(url.searchParams.get('name') || 'file', 'file');
  /* 【别用 req.headers['content-type'] 当文件类型】
     FormData 上传时它是 `multipart/form-data; boundary=…`（传输类型），
     拿它去比对"是不是图片"会把正常图片也拒掉 —— 我第一版就踩了这个坑，
     直接导致页面上传全坏（测试里"正常 PNG 应当能传"那条抓出来的）。
     真正的类型判断靠**文件头魔数**（下面 checkUploadType 里的第 ② 步），
     客户端声明的类型只当辅助参考。 */
  const headerMime = String(req.headers['content-type'] || '');
  const declaredMime = headerMime.indexOf('multipart/') === 0 ? '' : headerMime;
  const buf = await readBody(req, UPLOAD_MAX_MB * 1024 * 1024);
  if (!buf.length) throw new Ops.OpError('没有收到文件内容', 'EMPTY_FILE');
  if (buf.length > UPLOAD_MAX_MB * 1024 * 1024) {
    throw new Ops.OpError('文件太大了（上限 ' + UPLOAD_MAX_MB + ' MB）', 'TOO_BIG');
  }
  const ext = (path.extname(origName) || '').toLowerCase().slice(0, 8);
  const why = checkUploadType(ext, declaredMime, buf);
  if (why) throw new Ops.OpError(why, 'BAD_FILE_TYPE');

  /* 存盘用的扩展名从**白名单**里取（就是我校验过的那一个），
     不沿用用户给的原始文件名 —— 用户给的名字只进数据库当"显示名"。 */
  const safeExt = UPLOAD_KINDS[ext] ? ext : '.bin';
  const fileName = Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex') + safeExt;
  fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buf);
  const meet = db.currentMeet(d);
  const id = 'up_' + crypto.randomBytes(8).toString('hex');
  d.run(`INSERT INTO upload(id, meetId, fileName, origName, mime, size, kind, byUserId, byName, createdAt)
         VALUES(?,?,?,?,?,?,?,?,?,?)`, [
    id, meet ? meet.id : null, fileName, origName, UPLOAD_KINDS[safeExt].mime, buf.length, kind,
    ctx.user.id, ctx.user.displayName || ctx.user.username, nowIso(),
  ]);
  sendJson(res, 200, {
    ok: true,
    data: { id, url: '/uploads/' + fileName, size: buf.length, mime: UPLOAD_KINDS[safeExt].mime, kind },
  });
}));

/* ── 审计日志（操作记录） ─────────────────────────────────────────────── */

/**
 * 只有管理员能看操作记录。
 *
 * 【为什么收紧】原来这里是 withRole('operator')，但前端**只给管理员显示这个页签** ——
 * 于是"接口开着、界面没有"，属于两边不一致：操作员知道地址就能读到所有人的操作历史
 * （含谁改了什么、IP）。要么放开页签，要么收紧接口；选了收紧：
 * 操作员看全量审计意义不大，而审计里含其他人的操作细节。
 * 改前端页签的地方见 src/auth.js 的 ROLE_TABS。
 */
on('GET', '/api/audit', withRole('admin', (req, res) => {
  const url = new URL(req.url, 'http://x');
  const limit = Math.max(1, Math.min(500, num(url.searchParams.get('limit'), 120)));
  const rows = d.all('SELECT * FROM auditLog ORDER BY createdAt DESC LIMIT ?', [limit]);
  sendJson(res, 200, {
    ok: true,
    data: {
      logs: rows.map(r => ({
        id: r.id, userName: r.userName, action: r.action, target: r.target,
        detail: r.detail, ip: r.ip, createdAt: r.createdAt,
        before: Board.parseJson(r.beforeJson), after: Board.parseJson(r.afterJson),
      })),
    },
  });
}));

/* 回滚一次改动：把审计里的 before 写回去（只支持能安全还原的几类） */
on('POST', '/api/audit/undo', withRole('admin', async (req, res, params, ctx) => {
  checkCsrf(req, ctx);
  const body = await readJson(req);
  const row = d.get('SELECT * FROM auditLog WHERE id = ?', [String(body.id || '')]);
  if (!row) return sendJson(res, 404, { ok: false, message: '找不到这条操作记录' });
  const before = Board.parseJson(row.beforeJson);
  if (!before) return sendJson(res, 400, { ok: false, message: '这条记录没有可回滚的前值' });

  const out = d.tx(() => {
    if (row.action === 'athlete.update' && before.name !== undefined) {
      const id = String(row.target || '').replace(/^athlete:/, '');
      d.run(`UPDATE athlete SET name = ?, bib = ?, grade = ?, className = ?, team = ?, updatedAt = ? WHERE id = ?`,
        [before.name, orNull(before.bib), orNull(before.grade), orNull(before.className), orNull(before.team), nowIso(), id]);
      return { undone: '运动员资料已还原' };
    }
    throw new Ops.OpError('这一类操作不支持自动回滚（成绩请直接重录覆盖）', 'NO_UNDO');
  });
  Auth.auditWith(d, ctx.user, 'audit.undo', row.id, null, before, '回滚：' + row.action, clientIp(req));
  sendJson(res, 200, { ok: true, data: out });
  schedulePush();
}));

/* ── 备份 ─────────────────────────────────────────────────────────────── */

function backupList() {
  const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR) : [];
  return files
    .filter(f => /^sports-.*\.db$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, size: st.size, at: st.mtime.toISOString(), mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

async function createBackup(reason, byName) {
  const name = 'sports-' + stamp().replace(/:/g, '') + '-' + safeFilePart(reason || 'manual', 'manual') + '.db';
  const file = path.join(BACKUP_DIR, name);
  await d.backupTo(file);
  const st = fs.existsSync(file) ? fs.statSync(file) : { size: 0 };
  try {
    d.run('INSERT INTO backupLog(id, fileName, reason, size, byName, createdAt) VALUES(?,?,?,?,?,?)',
      ['bk_' + crypto.randomBytes(6).toString('hex'), name, reason || 'manual', st.size, byName || null, nowIso()]);
  } catch (e) { /* 元信息写不进去不影响备份本身 */ }
  pruneBackups();
  d.markClean();
  return { name, size: st.size, at: nowIso() };
}

/**
 * 清理旧备份 —— **只在确实配了份数上限时才删**。
 *
 * 【为什么改成这样】现场反馈：每次打开程序备份就被清一次。
 * 原因是两件事叠加：
 *   ① 启动时无条件备一份（已改成"有改动才备"）
 *   ② 每次备份后都按 `backupKeep` 裁掉多余的
 * 于是"重启十来次"就把有价值的旧备份全挤出去了。
 *
 * 现在 `backupKeep = 0` 表示**永不自动删除**（config.js 里可配）。
 * 这时这个函数什么都不做，备份只会因为人在后台点「删除」而消失。
 */
function pruneBackups() {
  if (!BACKUP_KEEP) return;                 // 0 = 不自动删
  const list = backupList();
  const drop = list.slice(BACKUP_KEEP);
  for (const f of drop) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch (e) { /* ignore */ }
  }
  if (drop.length) log('清理旧备份 ' + drop.length + ' 份（只保留最近 ' + BACKUP_KEEP + ' 份）');
}

on('GET', '/api/backups', withRole('admin', (req, res) => {
  const list = backupList();
  sendJson(res, 200, {
    ok: true,
    data: {
      dir: BACKUP_DIR, keep: BACKUP_KEEP, everyMin: BACKUP_EVERY_MIN,
      backups: list,
      totalSize: list.reduce((s, x) => s + x.size, 0),
    },
  });
}));

on('POST', '/api/backups', withRole('admin', async (req, res, params, ctx) => {
  checkCsrf(req, ctx);
  const out = await createBackup('manual', ctx.user.displayName || ctx.user.username);
  Auth.auditWith(d, ctx.user, 'backup.create', out.name, null, null, '手动备份', clientIp(req));
  sendJson(res, 200, { ok: true, data: out });
}));

on('POST', '/api/backups/restore', withRole('admin', async (req, res, params, ctx) => {
  checkCsrf(req, ctx);
  const body = await readJson(req);
  const name = String(body.name || '');
  if (body.confirmText !== '恢复') {
    return sendJson(res, 400, { ok: false, message: '危险操作：请在确认框里输入「恢复」两个字' });
  }
  // 防路径穿越：只允许 backup 目录下的文件名，且必须是我们自己生成的命名
  if (!/^sports-[0-9A-Za-z_\-]+\.db$/.test(name) || name.indexOf('..') >= 0 || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0) {
    return sendJson(res, 400, { ok: false, message: '备份文件名不合法' });
  }
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, message: '找不到这个备份文件' });

  // 恢复前先把当前数据备份下来（万一恢复错了还能回来）
  const safety = await createBackup('before-restore', ctx.user.displayName || ctx.user.username);

  // 校验备份文件是不是一个能打开的库
  try {
    const probe = db.open(file);
    const n = probe.get('SELECT COUNT(*) AS c FROM meet');
    probe.close();
    if (!n || n.c === 0) throw new Error('这个备份里没有任何运动会数据');
  } catch (err) {
    return sendJson(res, 400, { ok: false, message: '这个备份文件打不开或已损坏，拒绝恢复：' + (err && err.message) });
  }

  // 关当前库 → 覆盖 → 重新打开（现场就一台机器，重启式恢复最简单可靠）
  try { d.close(); } catch (e) { /* ignore */ }
  fs.copyFileSync(file, DB_FILE);
  for (const suffix of ['-wal', '-shm']) {
    try { if (fs.existsSync(DB_FILE + suffix)) fs.unlinkSync(DB_FILE + suffix); } catch (e) { /* ignore */ }
  }
  d = db.open(DB_FILE);
  Auth.auditWith(d, ctx.user, 'backup.restore', name, null, null, '从备份恢复（恢复前的数据已备份为 ' + safety.name + '）', clientIp(req));
  const meet = db.currentMeet(d);
  sendJson(res, 200, {
    ok: true,
    data: { restored: name, safety: safety.name, rev: meet ? Number(meet.rev) : 0 },
    message: '已恢复。当前登录会话可能已失效，如果页面提示未登录，请重新登录。',
  });
  pushAll();
}));

on('POST', '/api/backups/delete', withRole('admin', async (req, res, params, ctx) => {
  checkCsrf(req, ctx);
  const body = await readJson(req);
  const name = String(body.name || '');
  if (!/^sports-[0-9A-Za-z_\-]+\.db$/.test(name)) {
    return sendJson(res, 400, { ok: false, message: '备份文件名不合法' });
  }
  const file = path.join(BACKUP_DIR, name);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  Auth.auditWith(d, ctx.user, 'backup.delete', name, null, null, '', clientIp(req));
  sendJson(res, 200, { ok: true });
}));

/* ── 导出 ─────────────────────────────────────────────────────────────── */

on('GET', '/api/export', withUser((req, res) => {
  const url = new URL(req.url, 'http://x');
  const what = url.searchParams.get('what') || 'results';
  const format = url.searchParams.get('format') || 'xls';
  const meet = db.currentMeet(d);
  if (!meet) return sendJson(res, 400, { ok: false, message: '还没有数据' });
  const eventId = url.searchParams.get('eventId') || '';
  const grade = url.searchParams.get('grade') || '';

  const built = Xport.build(d, meet, { what, eventId, grade });
  // 文件名里的时间用**本机时区**（以前用 toISOString() 是 UTC，老师看到的会是 06:02 而不是 14:02）
  const dnow = new Date();
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const stampStr = '' + dnow.getFullYear() + pad2(dnow.getMonth() + 1) + pad2(dnow.getDate())
    + pad2(dnow.getHours()) + pad2(dnow.getMinutes());
  const base = safeFilePart((meet.name || '运动会') + '-' + built.title, 'export') + '-' + stampStr;

  if (format === 'csv') {
    const csv = '\uFEFF' + Xport.toCsv(built);      // 带 BOM，Excel 打开中文不乱码
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="export.csv"; filename*=UTF-8\'\'' + encodeURIComponent(base + '.csv'),
    });
    return res.end(csv);
  }
  // Excel：用 HTML 表格 + .xls 后缀（Excel 能直接打开，且不用任何第三方库）
  const html = Xport.toExcelHtml(built, meet);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
    'Content-Disposition': 'attachment; filename="export.xls"; filename*=UTF-8\'\'' + encodeURIComponent(base + '.xls'),
  });
  res.end('\uFEFF' + html);
}));

/* ── 诊断（现场排查用：页面把版面问题与 JS 报错回报过来） ─────────────── */

on('POST', '/api/diag/layout', async (req, res) => {
  const body = await readJson(req).catch(() => ({}));
  const issues = Array.isArray(body.issues) ? body.issues : [];
  if (issues.length) {
    logErr('[页面问题] ' + (body.page || '?') + ' ' + (body.w || '?') + 'x' + (body.h || '?') +
      ' 共 ' + issues.length + ' 处：');
    issues.slice(0, 8).forEach(i => logErr('    · ' + (i.kind || '') + ' ' + (i.sel || '') +
      (i.by ? '（超出 ' + i.by + 'px）' : '') + (i.text ? ' 「' + i.text + '」' : '')));
  }
  sendJson(res, 200, { ok: true });
});

on('POST', '/api/diag/error', async (req, res) => {
  const body = await readJson(req).catch(() => ({}));
  logErr('[页面报错] ' + (body.page || '?') + '：' + (body.message || '') +
    (body.source ? ' @ ' + body.source + ':' + body.line : ''));
  if (body.stack) logErr('    ' + String(body.stack).split('\n').slice(0, 4).join('\n    '));
  sendJson(res, 200, { ok: true });
});

/* ── 初始化（第一次启动时建一届运动会） ─────────────────────────────── */

on('POST', '/api/setup', withRole('admin', async (req, res, params, ctx) => {
  checkCsrf(req, ctx);
  const body = await readJson(req);
  const meet = db.currentMeet(d);
  if (meet) return sendJson(res, 400, { ok: false, message: '已经初始化过了' });
  const out = Ops.execute({
    d, user: ctx.user, op: 'meet.update',
    payload: { name: body.name || '校运动会', subtitle: '实时成绩发布', host: body.host || '', holdDate: body.holdDate || '' },
  });
  void out;
  // 顺手建好默认组别，省得老师一进来什么都没有
  for (const g of [{ name: '男子组', kind: 'male', sort: 1 }, { name: '女子组', kind: 'female', sort: 2 }]) {
    Ops.execute({ d, user: ctx.user, op: 'group.add', payload: g });
  }
  sendJson(res, 200, { ok: true, message: '已初始化' });
  pushAll();
}));

/* ══════════════════════════════════════════════════════════════════════
 * 静态文件
 * ══════════════════════════════════════════════════════════════════════ */

/* 静态资源类型表。**语音类型（mp3/m4a/ogg/wav/webm）已去掉** ——
   聊天不做语音了，上传白名单也只收图片，留着这些类型没有用处，
   反而让"上传目录里出现一个能当资源加载的文件"多几种可能。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.map': 'application/json',
};

const PAGES = {
  '/': 'screen.html',
  '/screen': 'screen.html',
  '/admin': 'admin.html',
  '/login': 'login.html',
  '/print': 'print.html',
};

/** 防路径穿越：把请求路径解析到 public 目录内，越界一律拒绝 */
function resolveStatic(pathname, baseDir) {
  const rel = decodeURIComponent(pathname).replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel.indexOf('..') >= 0) return null;
  const full = path.resolve(baseDir, rel);
  const base = path.resolve(baseDir);
  if (full !== base && full.indexOf(base + path.sep) !== 0) return null;
  return full;
}

function serveFile(req, res, file, downloadName) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  const etag = '"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    // 页面不缓存（现场改了要立刻生效），静态资源短缓存
    'Cache-Control': /\.html?$/.test(ext) ? 'no-cache' : 'public, max-age=60',
  };
  if (downloadName) {
    headers['Content-Disposition'] = 'attachment; filename="file"; filename*=UTF-8\'\'' + encodeURIComponent(downloadName);
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
  return true;
}

on('GET', '/favicon.ico', (req, res) => {
  // 浏览器每次开页面都会要它；给一个内联的空图标，免得日志里刷 404
  const ico = Buffer.from('AAABAAEAEBAQAAEABAAoAQAAFgAAACgAAAAQAAAAIAAAAAEABAAAAAAAgAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAA////AAAAAAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//wAA', 'base64');
  res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Content-Length': ico.length, 'Cache-Control': 'public, max-age=86400' });
  res.end(ico);
});

/* ══════════════════════════════════════════════════════════════════════
 * 主处理
 * ══════════════════════════════════════════════════════════════════════ */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let pathname = '/';
  try {
    const url = new URL(req.url, 'http://x');
    pathname = url.pathname;
  } catch (e) { /* 保底 */ }

  try {
    // 上下文：谁在访问
    const user = Auth.currentUser(d, req);
    const ctx = { user, source: 'web', ip: clientIp(req) };

    // 1) 上传文件（聊天图片）
    if (pathname.indexOf('/uploads/') === 0) {
      const file = resolveStatic(pathname.replace(/^\/uploads/, ''), UPLOAD_DIR);
      if (!file) return sendJson(res, 400, { ok: false, message: '路径不合法' });
      /* 【安全头】上传目录里放的都是用户给的文件，必须当"数据"而不是"网页"对待：
         · X-Content-Type-Options: nosniff —— 不许浏览器猜类型
         · Content-Security-Policy: sandbox    —— 万一真被当成页面打开，
           也是在沙箱里（拿不到本应用的 Cookie、不能发同源请求）
         · Content-Disposition: inline 但**只允许白名单里的图片/音频**；
           其它一律 attachment（下载而不是打开）
         这样即使上传校验有疏漏，也不至于变成"在我们域名下执行脚本"。 */
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      const upExt = path.extname(file).toLowerCase();
      if (!UPLOAD_KINDS[upExt]) return serveFile(req, res, file, path.basename(file));
      if (!serveFile(req, res, file)) return sendJson(res, 404, { ok: false, message: '文件不存在' });
      return;
    }

    // 2) 接口
    if (pathname.indexOf('/api/') === 0) {
      const route = matchRoute(req.method, pathname)
        || (pathname === '/api/snapshot' ? matchRoute('GET', '/api/snapshot') : null);
      if (!route) return sendJson(res, 404, { ok: false, code: 'NO_ROUTE', message: '没有这个接口：' + pathname });
      await route.handler(req, res, route.params, ctx);
      return;
    }

    // 3) 页面
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (PAGES[pathname]) {
        if (serveFile(req, res, path.join(PUBLIC_DIR, PAGES[pathname]))) return;
      }
      const file = resolveStatic(pathname, PUBLIC_DIR);
      if (file && serveFile(req, res, file)) return;
      // 找不到页面时给个友好提示（现场输错地址最常见）
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>页面不存在</title>'
        + '<style>body{background:#05070d;color:#eaf1ff;font-family:"Microsoft YaHei",sans-serif;padding:60px;line-height:2}'
        + 'a{color:#d8b23c}h1{font-size:22px}</style></head><body>'
        + '<h1>没有这个页面</h1><p>你要找的地址是：' + String(pathname).replace(/[<>&"]/g, '') + '</p>'
        + '<p>常用入口：<a href="/screen">成绩大屏</a>　·　<a href="/admin">后台管理（手机也能开）</a>　·　'
        + '<a href="/print">成绩单打印</a></p></body></html>');
    }

    sendJson(res, 405, { ok: false, message: '不支持这个请求方法' });
  } catch (err) {
    const code = err && err.code;
    /* 业务失败的 HTTP 状态码。这里**必须把每个 code 都列上** ——
       没列的会落到最后的 400，客户端拿到的语义就不对了
       （比如"决赛已录成绩、不让重做"是**冲突**，该给 409 而不是 400）。
       历史坑：加了 HAS_RESULT 却忘了加进这张表，测试里断言 409 直接红了。 */
    const status = code === 'UNAUTHORIZED' ? 401
      : (code === 'FORBIDDEN' || code === 'CSRF' || code === 'LAST_ADMIN') ? 403
        : (code === 'CONFLICT' || code === 'CONFIRM_FAILED' || code === 'HAS_FINAL'
          || code === 'HAS_RESULT' || code === 'IN_USE' || code === 'DUP'
          || code === 'DUP_NAME' || code === 'DUP_BIB') ? 409
          : 400;
    if (status >= 500 || !code) logErr('处理 ' + req.method + ' ' + pathname + ' 出错：', err && err.stack || err);
    sendJson(res, status, {
      ok: false,
      code: code || 'ERROR',
      message: (err && err.message) || '服务器处理出错',
      detail: (err && err.detail) || undefined,
    });
  } finally {
    if (Date.now() - started > 3000) log('慢请求 ' + req.method + ' ' + pathname + ' 用了 ' + (Date.now() - started) + 'ms');
  }
});

/* ══════════════════════════════════════════════════════════════════════
 * 定时任务
 * ══════════════════════════════════════════════════════════════════════ */

const timers = [];

/**
 * 清掉幂等去重表里超过 keepDays 天的记录。
 * @returns {number} 删掉几条
 */
function pruneIdempotency(d, keepDays) {
  const days = Number(keepDays) || 7;
  const before = new Date(Date.now() - days * 86400000).toISOString();
  const r = d.run('DELETE FROM idempotency WHERE createdAt < ?', [before]);
  return (r && r.changes) || 0;
}

function startTimers() {
  /* 【已去掉：项目状态按时间自动切换】
     原来这里有个 10 秒一次的定时器，会把"到点了"的项目自动推成
     进行中/已结束（`Ops.tickAll`）。现场反应是：项目到点自己就变了状态，
     没人操作却像开始了 —— 这会让大屏显示"进行中"跟实际不符，
     所以按用户要求**去掉自动开始**。

     现在项目的状态**只由人工控制**：
       · 录入页/赛程页的状态按钮（未开始/检录中/进行中/已结束）
       · 「开始检录」时自动进"检录中"；检录人齐了自动进"进行中"
         （这是按**检录结果**走的，不是按时间）
       · 「全部恢复自动」按钮仍在，但改成**手动触发的一次性归位**，
         不再有定时器周期性地改

     保留的接口（手动可调，不影响）：
       · `event.status` / `event.statusAuto` / `event.autoAll`
       · `Ops.tickAll` 还在被 event.autoAll 用，只是没有定时器调它了 */
  /* 1) 自动备份 —— 默认**关掉**（config.js 的 backupEveryMin = 0）。
   *
   * 【为什么默认关】现场反馈"每次打开都清理备份"。根源就是
   * "启动备一份 + 每 30 分钟备一份 + 每次都按份数上限裁掉旧的"，
   * 结果备份在被自动产生的重复内容挤掉。
   *
   * 现在：`backupEveryMin = 0` → 不建这个定时器，一份都不会自动产生、
   * 也就一份都不会被自动删。要备份就在后台点「立即备份」，
   * 或者把 backupEveryMin 设成正数（比如 30）恢复自动备份。
   *
   * 说明：即使开着自动备份，它也是"有改动才备"（下面那个 isDirty 判断），
   * 不会像以前那样空转着产生重复备份。 */
  if (BACKUP_EVERY_MIN > 0) {
    timers.push(setInterval(() => {
      try {
        if (!d.isDirty()) return;
        createBackup('auto', '系统').then(info => {
          log('自动备份完成：' + info.name + '（' + Math.round(info.size / 1024) + ' KB）');
        }).catch(err => logErr('自动备份失败', err && err.message));
      } catch (err) { logErr('自动备份失败', err && err.message); }
    }, BACKUP_EVERY_MIN * 60 * 1000));
    log('自动备份已开启：每 ' + BACKUP_EVERY_MIN + ' 分钟检查一次（有改动才备）');
  } else {
    log('自动备份已关闭（backupEveryMin = 0）—— 需要时请在后台点「立即备份」');
  }

  /* 2~5) 后台维护任务。都不动成绩数据，只是防止数据库无限增长。
     `housekeeping = false` 时一个都不建。 */
  if (!HOUSEKEEPING) {
    log('后台维护任务已关闭（housekeeping = false）');
    return;
  }

  // 清过期登录会话（每小时）
  timers.push(setInterval(() => {
    try {
      const n = Auth.pruneSessions(d);
      if (n) log('清理了 ' + n + ' 个过期登录会话');
    } catch (err) { /* ignore */ }
  }, 3600 * 1000));

  // 清幂等去重表里太老的记录（每小时）
  //   这张表是"断网重发不录成两条"的凭据，但**必须清理**：
  //   每录一条成绩就写一行，一天几千行，攒到比赛结束就是几万行；
  //   而且 clientUuid 是随机生成的，跨天不可能重复，所以留着没用。
  //   留 7 天是为了覆盖"当天断网、第二天才补交"这种情况。
  timers.push(setInterval(() => {
    try {
      const n = pruneIdempotency(d);
      if (n) log('清理了 ' + n + ' 条过期的幂等记录');
    } catch (err) { /* ignore */ }
  }, 3600 * 1000));

  // 合并 WAL（每小时），避免 -wal 文件无限增长
  timers.push(setInterval(() => {
    try { d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignore */ }
  }, 3600 * 1000));

  // 聊天只留最近 500 条（每 6 小时）
  timers.push(setInterval(() => {
    try {
      const meet = db.currentMeet(d);
      if (!meet) return;
      const old = d.all(`SELECT id FROM chatMessage WHERE meetId = ?
                         ORDER BY createdAt DESC LIMIT -1 OFFSET 500`, [meet.id]);
      for (const o of old) d.run('DELETE FROM chatMessage WHERE id = ?', [o.id]);
    } catch (err) { /* ignore */ }
  }, 6 * 3600 * 1000));
}

function stopTimers() {
  timers.forEach(t => clearInterval(t));
  timers.length = 0;
}

/* ══════════════════════════════════════════════════════════════════════
 * 启动
 * ══════════════════════════════════════════════════════════════════════ */

/** 本机所有可用的局域网地址（虚拟网卡单独标出来，免得老师拿到连不上的地址） */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  const virtualRe = /(vmware|virtualbox|vethernet|hyper-v|wsl|radmin|tailscale|zerotier|loopback|docker|vpn|tap|tun)/i;
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      out.push({ name, address: info.address, virtual: virtualRe.test(name) });
    }
  }
  // 真实网卡排前面（192.168.x / 10.x / 172.16-31.x 都是常见校园网段）
  return out.sort((a, b) => (a.virtual ? 1 : 0) - (b.virtual ? 1 : 0));
}

function announce(adminInfo) {
  const meet = db.currentMeet(d);
  const addrs = lanAddresses();
  const real = addrs.filter(a => !a.virtual);
  const primary = real.length ? real[0].address : (addrs.length ? addrs[0].address : '127.0.0.1');
  const port = server.address() ? server.address().port : PORT;
  const line = '─'.repeat(58);

  console.log('');
  console.log('  ' + line);
  console.log('  运动会成绩实时统计与大屏展示系统　v' + require('./package.json').version);
  if (meet) {
    console.log('  本届：' + meet.name + (meet.holdDate ? ('　·　' + meet.holdDate) : ''));
  } else {
    console.log('  （还没有建立运动会数据：登录后台后会引导你初始化）');
  }
  console.log('  ' + line);
  console.log('  ── 局域网其它设备用这些地址（手机/笔记本/大屏电脑） ──');
  real.forEach((a) => {
    console.log('     大屏：   http://' + a.address + ':' + port + '/screen');
    console.log('     后台：   http://' + a.address + ':' + port + '/admin');
    console.log('     （后台用手机浏览器打开就能录成绩，不需要另开页面）');
    console.log('     （网卡 ' + a.name + '）');
  });
  if (!real.length) {
    console.log('     ⚠ 没找到局域网地址：这台电脑可能没连上网线/Wi-Fi，');
    console.log('       或者网络是"公用网络"被系统限制了。手机将无法访问。');
  }
  const virt = addrs.filter(a => a.virtual);
  if (virt.length) {
    console.log('  ── 下面这些是虚拟网卡（VMware/Radmin/WSL 等），手机通常连不上，别用 ──');
    virt.forEach(a => console.log('     ' + a.address + '  (' + a.name + ')'));
  }
  console.log('  ── 这台电脑自己用 ──');
  console.log('     大屏：   http://127.0.0.1:' + port + '/screen');
  console.log('     后台：   http://127.0.0.1:' + port + '/admin');
  console.log('  ' + line);
  if (adminInfo) {
    console.log('  ── 管理员账号（只显示这一次，请抄下来） ──');
    console.log('     账号：' + adminInfo.username);
    console.log('     口令：' + adminInfo.password);
    console.log('     （忘了口令：双击项目里的「重置口令.bat」，或运行');
    console.log('       node tools/reset-password.js admin 新口令）');
    // 同一个文件也写一份：老师当时没抄、窗口关了也还能翻出来（下次重置口令会覆盖）
    try {
      const lines = [
        '运动会计分系统 —— 账号口令记录',
        '生成时间：' + new Date().toLocaleString('zh-CN', { hour12: false }),
        '来源：首次启动时自动创建的管理员',
        '',
        '  登录账号：' + adminInfo.username,
        '  口    令：' + adminInfo.password,
        '',
        '用法：浏览器打开后台地址（上面黑窗口里打印过），用这个账号和口令登录。',
        '安全提示：抄走口令后请删掉本文件，或至少别留在公用电脑上。',
        '         忘了口令就双击「重置口令.bat」，本文件会被新的口令覆盖。',
        '',
      ].join('\r\n');
      fs.writeFileSync(path.join(ROOT, '口令.txt'), lines, 'utf8');
      console.log('     已另存一份到：' + path.join(ROOT, '口令.txt'));
    } catch (e) { /* 写不出来也不影响启动 */ }
    console.log('  ' + line);
  }
  console.log('  数据目录：' + DATA_DIR);
  /* 备份说明按实际设置写 —— 以前不管配成什么都印"每 N 分钟自动备份，保留最近 N 份"，
     关掉之后会印成"每 0 分钟…保留最近 0 份"，看着像坏了。 */
  const bkText = BACKUP_EVERY_MIN > 0
    ? ('每 ' + BACKUP_EVERY_MIN + ' 分钟自动备份（有改动才备）'
      + (BACKUP_KEEP ? ('，保留最近 ' + BACKUP_KEEP + ' 份') : '，备份不自动删除'))
    : ('自动备份已关闭' + (BACKUP_KEEP ? ('，保留最近 ' + BACKUP_KEEP + ' 份') : '，备份不自动删除')
      + '，需要时在后台点「立即备份」');
  console.log('  备份目录：' + BACKUP_DIR + '（' + bkText + '）');
  console.log('  按 Ctrl+C 停止服务（停之前会自动把数据落盘）');
  console.log('  ' + line);
  console.log('');
}

/** 演示数据（第一次演示时用；正式比赛前记得清空） */
function maybeSeedDemo() {
  const seed = require('./src/seed');
  log('正在生成演示数据（12 个班 / 48 名运动员 / 11 个项目，含并列、弃权、接力、三次试跳）…');
  const info = seed.seedDemo(d, { reset: true });
  log('演示数据已生成：' + info.athletes + ' 名运动员、' + info.events + ' 个项目、' + info.classes + ' 个班级。');
  log('要清空：登录后台 → 备份与导出 → 清空全部数据（或删掉 data 目录重启）');
}

/**
 * 初始化数据：建库、灌演示数据（可选）、建首个管理员、起定时任务。
 * 拆出来是为了让自动化测试能在**不监听端口**的情况下复用同一套初始化逻辑
 * （测试自己 listen，避免端口冲突；否则会漏掉建管理员这一步，登录直接失败）。
 * @returns {{adminInfo:object|null}} 首次启动时返回管理员明文口令
 */
function initData() {
  const seed = require('./src/seed');
  if (SEED_DEMO) maybeSeedDemo();
  if (!db.currentMeet(d)) {
    seed.ensureMeet(d, { name: '校运动会', subtitle: '实时成绩发布' });
  }
  const adminInfo = Auth.ensureFirstAdmin(d, {
    username: ADMIN_USER,
    password: ADMIN_PASSWORD || undefined,
  });
  // 启动时顺手清一次过期的幂等记录：不等第一次定时任务（要一小时），
  // 老库一启动就瘦下来，日志里也能看到清了多少
  try {
    const n = pruneIdempotency(d);
    if (n) log('清理了 ' + n + ' 条过期的幂等记录（保留最近 7 天）');
  } catch (e) { /* ignore */ }
  startTimers();
  return { adminInfo };
}

function start() {
  const { adminInfo } = initData();

  // 监听端口：被占用就自动往后顺延，别让老师卡在"端口被占用"
  let tryPort = PORT;
  let attempts = 0;
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && attempts < 12) {
      attempts++;
      tryPort++;
      log('端口 ' + (tryPort - 1) + ' 被占用，换用 ' + tryPort + ' 重试…');
      setTimeout(() => server.listen(tryPort, HOST), 120);
    } else {
      logErr('启动失败：' + (err && err.message));
      process.exit(1);
    }
  });
  server.listen(tryPort, HOST, () => {
    announce(adminInfo);
    /* 启动时备一份 —— 但**只在真的有改动时**才备。
     *
     * 【原来错在哪】这里无条件调 createBackup('startup')。
     *   而 createBackup 结尾会 pruneBackups()，按"保留最近 30 份"把最旧的删掉。
     *   于是**每重启一次程序就产生一份内容完全相同的备份**，
     *   重开十来次就把有价值的旧备份全挤掉了 —— 备份本来是用来兜底的，
     *   结果被"启动"这个动作自己消耗掉了。
     *
     *   30 分钟一次的自动备份那边一直是有判断的（`if (!d.isDirty()) return`），
     *   只有启动这一次漏了。现在用同一个判断：
     *   数据没变就不备（启动只是"接着用"，不是"新的一天"）。
     *
     * 想要"每次启动都强制留一份"的话，把 data 目录里的
     * `.dirty` 判断去掉即可，但那样就得同时把 backupKeep 调大，
     * 否则还是会把旧备份顶掉。 */
    if (d.isDirty()) {
      createBackup('startup', '系统').then(() => d.markClean()).catch(() => {});
    } else {
      log('数据与上次备份相比没有变化，跳过启动备份（不占用备份份数）');
    }
    writePidFile(tryPort);
    watchStdinForStop();
  });
}

/* ══════════════════════════════════════════════════════════════════════
 * 进程标识与"怎么停下来"
 *
 * 【为什么不用"按命令行筛 node 进程"】
 *   原来「停止.bat」是用 PowerShell 找"命令行里含 server.js 的 node.exe"再 taskkill。
 *   匹配的是命令行文本，路径里有反斜杠、空格、中文，还要在 .bat 里跟引号和转义打架 ——
 *   实测就是**漏杀**：脚本打印 "Done"，服务却还占着端口，老师以为停了。
 *
 * 【现在怎么做】服务启动时把三样东西写进 data\：
 *   · server.pid   —— JSON，给需要看的人看（端口、启动时间、工作目录）
 *   · stop-server.bat —— **里面写死了自己的 PID**，内容极简：taskkill /PID <pid> /F
 *                        停止脚本只要执行它，不需要任何解析、比较、引号处理
 *   这么做是因为：**把复杂逻辑放在能可靠处理的程序里（Node），
 *   而不是放在会长歪的地方（cmd 的引号规则里）**。
 * ══════════════════════════════════════════════════════════════════════ */

function pidFilePath() {
  return path.join(DATA_DIR, 'server.pid');
}

function stopBatPath() {
  return path.join(DATA_DIR, 'stop-server.bat');
}

function writePidFile(port) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(pidFilePath(), JSON.stringify({
      pid: process.pid, port, startedAt: nowIso(), cwd: ROOT,
    }, null, 2), 'utf8');

    // 生成只属于本次运行的停止脚本：PID 写死，停止时不用解析任何东西
    fs.writeFileSync(stopBatPath(), [
      '@echo off',
      'rem 由服务启动时自动生成：停止 PID ' + process.pid + '。',
      'rem 想手动停服务，双击项目根目录的「停止.bat」即可（它调用本文件）。',
      'taskkill /PID ' + process.pid + ' /T /F >nul 2>&1',
      'if errorlevel 1 (echo   server not running - nothing to stop) else (echo   server stopped)',
      '',
    ].join('\r\n'), 'ascii');
  } catch (e) { /* 写不进去不影响服务，只是停止脚本少一条线索 */ }
}

/** 退出时清掉这两个文件，免得下次按旧 PID 误杀别人的进程 */
function clearPidFile() {
  try {
    const f = pidFilePath();
    if (fs.existsSync(f)) {
      const info = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (info && info.pid === process.pid) fs.unlinkSync(f);
    }
  } catch (e) { /* ignore */ }
  try {
    const b = stopBatPath();
    if (fs.existsSync(b)) {
      // 只删自己生成的那份：确认里面的 PID 就是自己
      const t = fs.readFileSync(b, 'ascii');
      if (t.indexOf('taskkill /PID ' + process.pid) >= 0) fs.unlinkSync(b);
    }
  } catch (e) { /* ignore */ }
}

/**
 * 监听标准输入里的 "stop"（若有人往服务窗口写这一行，就优雅退出）。
 * 只是个"额外入口"：主要靠 data\stop-server.bat 按 PID 停。
 * stdin 不可用（被服务化启动）时静默跳过，绝不影响服务本身。
 */
function watchStdinForStop() {
  try {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (buf) => {
      if (String(buf).toLowerCase().indexOf('stop') >= 0) shutdown('收到停止请求');
    });
    process.stdin.on('error', () => { /* 忽略 */ });
    process.stdin.resume();
  } catch (e) { /* 忽略 */ }
}

/* 优雅退出：先合并 WAL 再关库，避免断电式的数据损坏 */
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  log('收到 ' + signal + '，正在保存数据并退出…');
  stopTimers();
  try {
    for (const kind of Object.keys(streams)) {
      for (const res of streams[kind]) { try { res.end(); } catch (e) { /* ignore */ } }
      streams[kind].clear();
    }
  } catch (e) { /* ignore */ }
  try { d.close(); } catch (e) { /* ignore */ }
  clearPidFile();
  log('数据已安全落盘，再见。');
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logErr('未捕获的异常（服务继续运行）：', err && err.stack || err);
});
process.on('unhandledRejection', (err) => {
  logErr('未处理的 Promise 拒绝（服务继续运行）：', err && err.stack || err);
});

if (require.main === module) start();

module.exports = {
  server, start, initData, stopTimers, d: () => d, dataDir: DATA_DIR, backupDir: BACKUP_DIR,
  createBackup, backupList, pushAll, schedulePush, snapshotFor, lanAddresses,
  setDb: (next) => { d = next; },
  getDb: () => d,
  log, logErr, fmtLocal, config: () => ({
    PORT, HOST, DATA_DIR, BACKUP_KEEP, BACKUP_EVERY_MIN, UPLOAD_MAX_MB, SEED_DEMO,
  }),
};
