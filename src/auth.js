'use strict';
/**
 * auth.js —— 账号、会话、权限、审计
 *
 * 【设计口径】
 *  · 口令散列用 Node 内置 crypto 的 scrypt（不用第三方库，也不用明文的任何形式）
 *  · 会话：随机 id 存在库里 + HttpOnly Cookie（前端 JS 读不到，防 XSS 偷会话）
 *  · CSRF：每个会话一个令牌，写操作必须带 X-CSRF 头。大屏是只读的，不带也没关系
 *  · 三级角色：
 *      admin    管理员：全都能干（名单/项目/账号/备份/确认/恢复）
 *      operator 操作员：录成绩、改项目状态、检录、发公告、聊天（不能改名单与账号）
 *      viewer   只读：只能看大屏与后台数据，一律拒绝写
 *  · 登录失败限流：同一用户名/IP 连续失败会短暂锁定，防止有人瞎试
 *  · 账号停用或改密后，该账号所有会话立即失效（把 session 删掉）
 */

const crypto = require('node:crypto');
const { makeId, randomToken, nowIso } = require('./util');

const COOKIE_NAME = 'sports_sid';
const SESSION_DAYS = 14;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;   // 10 分钟内
const LOGIN_MAX_FAILS = 8;                // 失败 8 次就锁一会儿

/* ── 口令散列 ─────────────────────────────────────────────────────────── */

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt: s, hash };
}

/** 定时安全的比较（避免通过响应时间猜口令） */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ── 会话失效通知 ────────────────────────────────────────────────────────
 *
 * 【为什么需要】会话被销毁（退出登录 / 改口令 / 停用 / 删号）之后，
 * 那条会话上已经建立的 SSE 长连接不会自己断 —— 实测过：
 * 建连 → 退出 → 触发推送，原连接照样收到数据。
 *
 * auth.js 不该反过来 require server.js（会造成循环依赖），
 * 所以这里留一个钩子：server.js 启动时挂上"关掉这个人的实时连接"。
 */
let onSessionsGone = null;

/** server.js 在启动时注册（只该注册一次） */
function setSessionGoneHandler(fn) { onSessionsGone = fn; }

function notifyGone(info) {
  if (!onSessionsGone) return;
  try { onSessionsGone(info); } catch (e) { /* 钩子出错不能影响登录流程 */ }
}

/* ── 登录限流（内存即可：单机服务，重启后清零可接受） ─────────────────── */

const fails = new Map();   // key → { count, first, until }

/**
 * 用户名规范化 —— **限流和查库必须用同一个规范化结果**。
 *
 * 【原来错在哪】限流键用 `toLowerCase()`，而查账号用 `trim()`：
 *   failKey('zhang') → 'zhang|1.2.3.4'
 *   failKey('zhang  ') → 'zhang  |1.2.3.4'   ← 多了两个空格，是另一个 key
 * 但查库时两个都会 trim 成 'zhang' → 命中同一个账号。
 * 结果：把 'zhang' 锁住了，换 'zhang  ' 接着试密码 —— 限流形同虚设。
 *
 * 实测确认过：正常形式返回 401（已锁定），尾部加空格返回 200（蒙对了密码就进去了）。
 */
function normUser(username) {
  return String(username === null || username === undefined ? '' : username)
    .replace(/[\s\u3000]+/g, '')      // 去掉所有空白（含全角空格）—— 用户名里本就不该有
    .toLowerCase();
}

function failKey(username, ip) { return normUser(username) + '|' + String(ip || ''); }

function checkThrottle(username, ip) {
  const k = failKey(username, ip);
  const rec = fails.get(k);
  if (!rec) return { blocked: false };
  if (rec.until && rec.until > Date.now()) {
    return { blocked: true, seconds: Math.ceil((rec.until - Date.now()) / 1000) };
  }
  return { blocked: false };
}

function noteFail(username, ip) {
  const k = failKey(username, ip);
  const now = Date.now();
  let rec = fails.get(k);
  if (!rec || now - rec.first > LOGIN_WINDOW_MS) rec = { count: 0, first: now, until: 0 };
  rec.count++;
  if (rec.count >= LOGIN_MAX_FAILS) rec.until = now + 60 * 1000;   // 锁 1 分钟
  fails.set(k, rec);
  /* 除了"账号+IP"，再单独按来源 IP 记一份：
     否则换着用户名猜密码（撞库）永远碰不到单个账号的上限。 */
  const ipKey = 'ip|' + String(ip || '');
  let ipRec = fails.get(ipKey);
  if (!ipRec || now - ipRec.first > LOGIN_WINDOW_MS) ipRec = { count: 0, first: now, until: 0 };
  ipRec.count++;
  if (ipRec.count >= LOGIN_MAX_FAILS * 4) ipRec.until = now + 2 * 60 * 1000;
  fails.set(ipKey, ipRec);
}

function clearFail(username, ip) {
  fails.delete(failKey(username, ip));
  fails.delete('ip|' + String(ip || ''));
}

/** 给测试与运维用：看看当前锁了哪些（不暴露在接口上） */
function throttleStats() {
  const out = [];
  fails.forEach((v, k) => {
    if (v.until && v.until > Date.now()) out.push({ key: k, seconds: Math.ceil((v.until - Date.now()) / 1000) });
  });
  return out;
}

/* ── 角色与权限 ───────────────────────────────────────────────────────── */

const ROLES = ['admin', 'operator', 'viewer'];

const ROLE_LABEL = { admin: '管理员', operator: '操作员', viewer: '只读' };

/**
 * 每个写操作要求的角色。表里没有的按 'admin' 处理（宁可要权高一点，也别漏开）
 *
 * 关于 operator（操作员）：现场干事的人。编排类操作（名单/赛程/班级/组别）也开给他，
 * 否则他连运动员都加不了、只能找管理员，现场会卡住。
 * **这些改动对操作员是"直接生效"，对管理员是"暂存后统一确认"** ——
 * 区别不在权限，而在 src/ops.js 的 stage()：只有管理员走暂存。
 *
 * 【只写"业务操作"（OPS 里有的）】
 *   备份/恢复、暂存确认、看操作记录这些是**独立接口**，用 server.js 里的
 *   `withRole('admin')` 直接拦，不经过 Ops.execute，所以写在这里也不会被查到 ——
 *   以前这里留着 `backup.create/restore/delete`、`staged.confirm/discard/drop/stage`
 *   七条，都是永远不会命中的死配置，容易误导（以为改这里就能改权限）。
 *   现在删掉了；加权限判断时先确认这个动作在不在 OPS 里（`Ops.OP_NAMES`）。
 */
const ACTION_ROLE = {
  // 录成绩 / 改状态 / 检录 / 公告 / 聊天：操作员就可以
  'result.set': 'operator', 'result.clear': 'operator',
  'result.batch': 'operator',
  // 清空某个项目的成绩 / 全部恢复自动：赛程与成绩页签上有按钮，操作员也点了要用
  'result.clearEvent': 'operator', 'event.autoAll': 'operator',
  'event.status': 'operator', 'event.statusAuto': 'operator',
  'checkin.open': 'operator', 'checkin.close': 'operator', 'checkin.mark': 'operator',
  'checkin.all': 'operator',
  'notice.add': 'operator', 'notice.del': 'operator', 'notice.update': 'operator',
  'chat.send': 'operator', 'chat.delete': 'operator',
  'event.tick': 'operator',
  // 编排类（名单 / 项目 / 班级 / 组别 / 接力队员）：操作员也能做
  'athlete.add': 'operator', 'athlete.update': 'operator', 'athlete.del': 'operator',
  /* 屏蔽/取消屏蔽：录入页上就要能点（录到一半发现人上不了场）。
     它只影响"展不展示"，不删任何数据，所以给操作员就够，不必卡在管理员那层。 */
  'athlete.block': 'operator',
  'athlete.import': 'operator',
  'event.add': 'operator', 'event.update': 'operator', 'event.del': 'operator', 'event.move': 'operator',
  /* 手动录取决赛：只"建出决赛项目"，名单由老师在「名单」里挑。
     这是编排工作，操作员就该能干，不该卡在管理员那一层。 */
  'event.makeFinal': 'operator',
  'reg.add': 'operator', 'reg.del': 'operator', 'reg.update': 'operator', 'reg.legs': 'operator',
  'group.add': 'operator', 'group.update': 'operator', 'group.del': 'operator',
  'class.add': 'operator',
  // 下面这些只给管理员：影响整届比赛或账号安全
  'event.autoAdvance': 'admin',
  'meet.update': 'admin', 'meet.screen': 'admin', 'meet.rule': 'admin',
  'user.add': 'admin', 'user.update': 'admin', 'user.pwd': 'admin', 'user.del': 'admin',
  'data.clear': 'admin', 'data.demo': 'admin',
  'backup.note': 'admin',
  // 下面这些谁登录了都能用（只动自己的东西）
  'me.pwd': 'viewer',
};

/** 这个角色能不能做这个动作 */
function can(role, action) {
  if (!role || ROLES.indexOf(role) < 0) return false;
  if (role === 'admin') return true;
  const need = ACTION_ROLE[action] || 'admin';
  if (need === 'viewer') return true;                 // 任何登录用户
  if (need === 'operator') return role === 'operator';
  return false;                                        // 需要管理员
}

/** 某些功能"只有管理员才需要确认"（前端按这个决定显示不显示确认条） */
const ADMIN_ONLY_ACTIONS = Object.keys(ACTION_ROLE).filter(k => ACTION_ROLE[k] === 'admin');

/**
 * 前端要显示的页签。
 * 这是**显示口径**，不是安全边界 —— 真正的拦截始终在 ACTION_ROLE / can()。
 * 操作员不该看到"账号/备份恢复/导入与设置/班级总分(规则)"这些用不上的东西，
 * 页签少一半，现场更容易点对。
 */
const ROLE_TABS = {
  /* 【为什么没有 checkin】大屏和后台都不再单设「检录」页签了：
     大屏那一栏早去掉（挤掉名次），后台这个页签也按用户要求去掉。
     检录的**数据**照旧保留、接口照旧可用，而且**录入页**里每个项目
     仍有检录入口（开/停检录、点名），现场照常能干。
     所以这里只是不再列这个页签，不是删功能。 */
  admin: ['entry', 'results', 'notice', 'chat', 'events', 'roster', 'settings', 'team', 'backup', 'accounts', 'audit'],
  operator: ['entry', 'results', 'notice', 'chat', 'events', 'roster', 'team'],
  viewer: ['results', 'notice', 'chat', 'team'],
};

/* ── 会话 ─────────────────────────────────────────────────────────────── */

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function createSession(d, user, info) {
  const id = randomToken(32);
  const csrf = randomToken(24);
  const now = Date.now();
  d.run(`INSERT INTO session(id, userId, csrf, createdAt, expiresAt, lastSeenAt, ip, agent)
         VALUES(?,?,?,?,?,?,?,?)`, [
    id, user.id, csrf,
    new Date(now).toISOString(),
    new Date(now + SESSION_DAYS * 86400000).toISOString(),
    new Date(now).toISOString(),
    (info && info.ip) || null,
    ((info && info.agent) || '').slice(0, 200) || null,
  ]);
  return { id, csrf, expiresAt: new Date(now + SESSION_DAYS * 86400000).toISOString() };
}

/** 从请求里取当前登录人（顺便刷新 lastSeenAt，用于"谁在线"） */
function currentUser(d, req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const sid = cookies[COOKIE_NAME];
  if (!sid) return null;
  const s = d.get('SELECT * FROM session WHERE id = ?', [sid]);
  if (!s) return null;
  if (new Date(s.expiresAt).getTime() < Date.now()) {
    d.run('DELETE FROM session WHERE id = ?', [sid]);
    return null;
  }
  const u = d.get('SELECT * FROM user WHERE id = ?', [s.userId]);
  if (!u || u.disabled) {
    d.run('DELETE FROM session WHERE userId = ?', [s.userId]);
    return null;
  }
  // 改密后旧会话立即失效
  if (u.pwdChangedAt && u.pwdChangedAt > s.createdAt) {
    d.run('DELETE FROM session WHERE id = ?', [sid]);
    return null;
  }
  /* 【这里**故意不**刷新 lastSeenAt —— 改成由心跳专门刷新】
     lastSeenAt 现在表示"这条会话的**浏览器**还活着吗"，只由
     GET /api/ping（心跳）写。为什么不能在这个"每个请求都会经过"的地方顺手写：

       我第一版就是在这里每次请求都刷 —— 结果**管理员打开账号页看谁在线**
       这个动作，先刷了他自己的 lastSeenAt，再去看列表，于是
       "他自己永远在线"，判定直接失真。

     更糟的是它会掩盖真问题：一个已经关掉网页的人，只要**别人**恰好
     触发一次带他 Cookie 的请求，他就"复活"了。
     对"谁还在录成绩"这种判断，这是灾难性的。

     所以：要算在线，就必须由**那条会话自己的客户端**定期报到。
     这也正是"在线"两个字的实际含义。见 touchSession。 */
  return {
    id: u.id, username: u.username, displayName: u.displayName, role: u.role,
    csrf: s.csrf, sessionId: sid,
  };
}

/** 心跳：把这条会话标记为"刚刚还活着"。**只有这里**会写 lastSeenAt。 */
function touchSession(d, sid) {
  if (!sid) return false;
  const r = d.run('UPDATE session SET lastSeenAt = ? WHERE id = ?', [nowIso(), sid]);
  return !!(r && r.changes);
}

function destroySession(d, sid) {
  d.run('DELETE FROM session WHERE id = ?', [sid]);
  notifyGone({ sid: sid, reason: '登录状态已失效，请重新登录' });
}

function destroyUserSessions(d, userId) {
  d.run('DELETE FROM session WHERE userId = ?', [userId]);
  notifyGone({ uid: userId, reason: '账号状态已变更，请重新登录' });
}

/** 清过期会话（定时任务调用） */
function pruneSessions(d) {
  const r = d.run('DELETE FROM session WHERE expiresAt < ?', [nowIso()]);
  /* 顺手清掉过期的"被顶下线说明"。
     它是给"刚被顶下线的那台"看的，超过 10 分钟就没意义了
     （页面关了半小时再打开，直接当未登录处理更自然）。 */
  try {
    d.run('DELETE FROM kickNote WHERE at < ?',
      [new Date(Date.now() - 10 * 60 * 1000).toISOString()]);
  } catch (e) { /* 老库还没有这张表时忽略 */ }
  return r.changes || 0;
}

/** 设 Cookie（HttpOnly + SameSite=Lax；HTTPS 下可加 Secure） */
function cookieHeader(sid, opts) {
  const parts = [
    COOKIE_NAME + '=' + encodeURIComponent(sid),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + (SESSION_DAYS * 86400),
  ];
  if (opts && opts.secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookieHeader() {
  return COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

/* ── 登录 / 首次启动建管理员 ─────────────────────────────────────────── */

/** 库里一个账号都没有 → 首次启动，建一个管理员并返回明文口令（只在启动横幅打印一次） */
function ensureFirstAdmin(d, opts) {
  const n = d.get('SELECT COUNT(*) AS c FROM user').c;
  if (n > 0) return null;
  const username = (opts && opts.username) || 'admin';
  const password = (opts && opts.password) || randomPassword();
  const now = nowIso();
  const ph = hashPassword(password);
  d.run(`INSERT INTO user(id, username, displayName, role, pwdSalt, pwdHash, disabled, createdAt, updatedAt)
         VALUES(?,?,?,?,?,?,0,?,?)`, [
    makeId('u'), username, '系统管理员', 'admin', ph.salt, ph.hash, now, now,
  ]);
  return { username, password };
}

/** 生成好记又够强的口令：4 组 4 位，老师抄得下来 */
function randomPassword() {
  const words = ['jump', 'run8', 'field', 'track', 'gold', 'lane', 'heat', 'team',
    'time', 'star', 'wind', 'fast', 'mile', 'shot', 'long', 'high'];
  const pick = () => words[crypto.randomInt(words.length)];
  const digits = () => String(crypto.randomInt(1000, 9999));
  return pick() + '-' + digits() + '-' + pick() + '-' + digits();
}

function login(d, username, password, info) {
  /* 【限流与查库必须用同一个规范化】见 normUser 的注释：
     原来限流键不 trim、查库 trim，于是"用户名尾部加空格"就能绕开锁定。 */
  const uname = String(username === null || username === undefined ? '' : username).trim();
  const throttle = checkThrottle(username, info && info.ip);
  if (throttle.blocked) {
    return { ok: false, error: '登录失败次数过多，请 ' + throttle.seconds + ' 秒后再试' };
  }
  // 账号查询也走规范化：库里存的都是不带空白的用户名，
  // 但允许用户输入时前后带空格/全角空格（手机输入法很容易带出来）
  const u = d.get('SELECT * FROM user WHERE username = ?', [uname])
    || d.get('SELECT * FROM user WHERE LOWER(REPLACE(username, " ", "")) = ?', [normUser(username)]);
  if (!u) {
    noteFail(username, info && info.ip);
    return { ok: false, error: '账号或口令不正确' };
  }
  const ph = hashPassword(password, u.pwdSalt);
  if (!safeEqual(ph.hash, u.pwdHash)) {
    noteFail(username, info && info.ip);
    return { ok: false, error: '账号或口令不正确' };
  }
  if (u.disabled) return { ok: false, error: '这个账号已被停用，请联系管理员' };
  clearFail(username, info && info.ip);
  const s = createSession(d, u, info);
  return {
    ok: true,
    user: { id: u.id, username: u.username, displayName: u.displayName, role: u.role },
    session: s,
  };
}

/** 改口令（自己改自己的，或管理员改别人的） */
function setPassword(d, userId, newPassword) {
  const ph = hashPassword(newPassword);
  d.run('UPDATE user SET pwdSalt = ?, pwdHash = ?, pwdChangedAt = ?, updatedAt = ? WHERE id = ?',
    [ph.salt, ph.hash, nowIso(), nowIso(), userId]);
}

/** 口令强度最低要求：至少 6 位，别用 123456 */
function checkPasswordStrength(pwd) {
  const s = String(pwd || '');
  if (s.length < 6) return '口令至少要 6 位';
  if (/^\d+$/.test(s)) return '口令不能全是数字，请混入字母';
  if (['123456', '000000', '888888', 'password', 'abc123'].indexOf(s.toLowerCase()) >= 0) {
    return '这个口令太常见了，换一个';
  }
  return '';
}

/* ── 审计 ─────────────────────────────────────────────────────────────── */

function auditWith(d, user, action, target, before, after, detail, ip, sessionId) {
  const { audit } = require('./db');
  audit(d, {
    meetId: (before && before.meetId) || (after && after.meetId) || null,
    userId: user ? user.id : null,
    userName: user ? (user.displayName || user.username) : '系统',
    action, target, before, after, detail, ip,
    /* 记下"这次操作是哪一次登录做的"。登录时如果还没建会话就传空
       （登录那条记录本身就是"哪次登录"的起点，见 server.js 的调用）。 */
    sessionId: sessionId || (user && user.sessionId) || null,
  });
}

module.exports = {
  COOKIE_NAME, ROLES, ROLE_LABEL, ACTION_ROLE,
  ADMIN_ONLY_ACTIONS, ROLE_TABS,
  hashPassword, safeEqual, can,
  parseCookies, createSession, currentUser, destroySession, destroyUserSessions, pruneSessions,
  touchSession,
  cookieHeader, clearCookieHeader,
  ensureFirstAdmin, randomPassword, login, setPassword, checkPasswordStrength,
  auditWith, checkThrottle, noteFail, clearFail, normUser, throttleStats,
  setSessionGoneHandler,
};
