'use strict';
/**
 * ops.js —— 所有"改动"的指令表（加功能基本都改这个文件）
 *
 * 为什么要集中在一张表里：
 *   权限、乐观锁、幂等去重、审计留痕、暂存确认、推送大屏 —— 这五件事如果散落在
 *   各个接口里，早晚会漏一个（历史上就漏过一个写接口没挂鉴权）。所以所有写操作
 *   统一走 execute()，在这一个地方处理完。
 *
 * 【几个关键约定】
 *   · 每个改动都会把 meet.rev 加 1（版本号），大屏靠它判断"数据变了，重画"
 *   · 成绩写入带 version（乐观锁）与 clientUuid（幂等）：见 result.set 的注释
 *   · 名次不落库：写入后只更新 result.isBest，其余全部实时算
 *   · 弃权：value 置 NULL、dnf=1，人仍留在榜上（排在最后）
 */

const P = require('./parse');
const S = require('./scoring');
const Board = require('./scoreboard');
const { cloneForPreview, destroyPreview } = require('./db');
const {
  makeId, nowIso, orNull, str, num, round,
  gradeRank, classRank, classLabel, zhCompare, splitTeam,
  toClockStr, clockToMs,
} = require('./util');

/* ══════════════════════════════════════════════════════════════════════
 * 错误类型：带上机器可读的 code，前端据此决定"排队重发"还是"弹窗让人选"
 * ══════════════════════════════════════════════════════════════════════ */

class OpError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'OpError';
    this.code = code || 'OP_FAILED';
    this.detail = detail || null;
  }
}
const fail = (msg, code, detail) => { throw new OpError(msg, code, detail); };
const conflict = (msg, detail) => { throw new OpError(msg, 'CONFLICT', detail); };

/* ══════════════════════════════════════════════════════════════════════
 * 小工具
 * ══════════════════════════════════════════════════════════════════════ */

const OPS = {};
const def = (name, fn, meta) => { OPS[name] = Object.assign({ name, fn }, meta || {}); };

function mustRow(d, table, id, label) {
  if (!id) fail('缺少' + label + '的 id');
  const row = d.get('SELECT * FROM ' + table + ' WHERE id = ?', [id]);
  if (!row) fail('找不到这个' + label + '（可能已被别人删除，请刷新页面）', 'GONE');
  return row;
}

function meetOf(d, meetId) {
  const m = meetId
    ? d.get('SELECT * FROM meet WHERE id = ?', [meetId])
    : (d.get('SELECT * FROM meet WHERE isCurrent = 1 AND archived = 0 LIMIT 1')
      || d.get('SELECT * FROM meet ORDER BY createdAt LIMIT 1'));
  if (!m) fail('还没有建立运动会数据，请先初始化', 'NO_MEET');
  return m;
}

/** 版本号 +1（大屏靠它刷新；批量操作只加一次） */
function bumpRev(d, meetId) {
  d.run('UPDATE meet SET rev = rev + 1, updatedAt = ? WHERE id = ?', [nowIso(), meetId]);
}

/** 幂等表：同一个 clientUuid 只生效一次（断网重发、重复点都不会录成两条） */
function onceLookup(d, uuid) {
  if (!uuid) return null;
  const r = d.get('SELECT responseJson FROM idempotency WHERE clientUuid = ?', [uuid]);
  if (!r) return null;
  try { return JSON.parse(r.responseJson); } catch (e) { return null; }
}

function onceRemember(d, uuid, op, response) {
  if (!uuid) return;
  try {
    d.run('INSERT OR IGNORE INTO idempotency(clientUuid, op, responseJson, createdAt) VALUES(?,?,?,?)',
      [uuid, op, JSON.stringify(response === undefined ? null : response), nowIso()]);
  } catch (e) { /* 并发下可能已存在，忽略 */ }
}

/** 建幂等表（幂等；正式结构在 schema.js 里，这里只是兜底，防止老库缺这张表） */
function ensureOnceTable(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS idempotency (
    clientUuid TEXT PRIMARY KEY,
    op TEXT NOT NULL,
    responseJson TEXT,
    createdAt TEXT NOT NULL
  )`);
}

/** 班级：没有就建（导入名单时年级班级是自由文本，自动补 classDef） */
function ensureClass(d, meetId, grade, className) {
  const g = str(grade), c = str(className);
  if (!g && !c) return null;
  const label = classLabel(g, c);
  const exist = d.get('SELECT * FROM classDef WHERE meetId = ? AND grade = ? AND className = ?',
    [meetId, g, c]);
  if (exist) return exist;
  const id = makeId('cls');
  d.run(`INSERT INTO classDef(id, meetId, grade, className, label, sortGrade, sortClass)
         VALUES(?,?,?,?,?,?,?)`, [id, meetId, g, c, label, gradeRank(g), classRank(c)]);
  return d.get('SELECT * FROM classDef WHERE id = ?', [id]);
}

/** 组别：**严格按 id** 找；给的是 id 就必须真实存在 */
function groupById(d, meetId, id) {
  const groups = d.all('SELECT * FROM groupDef WHERE meetId = ? ORDER BY sort, id', [meetId]);
  if (!groups.length) fail('还没有设置组别，请先在"赛程"里加一个组别（如男子组）', 'NO_GROUP');
  const x = groups.find(g => g.id === String(id));
  if (!x) {
    fail('这个组别不存在（可能已被删除）。现有组别：' + groups.map(g => g.name).join('、'),
      'NO_GROUP');
  }
  return x.id;
}

/** 组别：按名字找，找不到就用第一个（导入时组别写"男"/"男子"都能认） */
function groupIdOrFirst(d, meetId, want) {
  const groups = d.all('SELECT * FROM groupDef WHERE meetId = ? ORDER BY sort, id', [meetId]);
  if (!groups.length) fail('还没有设置组别，请先在"赛程"里加一个组别（如男子组）', 'NO_GROUP');
  const w = str(want);
  if (!w) return groups[0].id;
  const exact = groups.find(g => g.name === w);
  if (exact) return exact.id;
  const loose = groups.find(g => g.name.indexOf(w) >= 0 || w.indexOf(g.name) >= 0);
  if (loose) return loose.id;
  // "男" / "女" 这种简称
  const byGender = groups.find(g => {
    if (w.indexOf('男') >= 0) return g.name.indexOf('男') >= 0 || g.kind === 'male';
    if (w.indexOf('女') >= 0) return g.name.indexOf('女') >= 0 || g.kind === 'female';
    return false;
  });
  return byGender ? byGender.id : groups[0].id;
}

/**
 * 从**年级**推出组别（本届的组别就是按年级分的：初一组/初二组/高一组…）。
 *
 * 【为什么要有这个函数 —— 这里原来是个会静默出错的 BUG】
 *   加运动员的弹窗里既有"组别"下拉又有"年级"输入框，老师只填了年级，
 *   组别下拉就取默认值——而 `groupIdOrFirst` 在组别为空时返回 **groups[0]**，
 *   也就是**初一组**（排序第一个）。结果：**新加的人全被归到初一组**，
 *   而且**一声不响**，只有在名单里翻到才发现，改起来还要一个个挪。
 *
 * 现在的口径：**年级说了算**，组别由年级推出来。
 *   · 先按年级找同名组别（"高一" → "高一组"）
 *   · 再按包含关系松一点找（"高一36班" 里含 "高一"）
 *   · 推不出来就**明确报错**，绝不悄悄塞进第一个组别
 *
 * @returns {string|null} 组别 id；推不出来返回 null（由调用方决定报错文案）
 */
function groupFromGrade(d, meetId, grade) {
  const groups = d.all('SELECT * FROM groupDef WHERE meetId = ? ORDER BY sort, id', [meetId]);
  if (!groups.length) return null;
  const g = str(grade);
  if (!g) return null;

  const nameOf = (x) => String(x.name || '');
  /* 把"组"去掉再比：组别叫"高一组"、年级叫"高一" */
  const bare = (s) => s.replace(/组$/, '').trim();
  const gb = bare(g);

  // ① 去掉"组"之后完全相同
  let hit = groups.filter(x => bare(nameOf(x)) === gb);
  if (hit.length === 1) return hit[0].id;
  if (hit.length > 1) return null;                  // 有歧义，交给调用方报错

  // ② 年级串里含组别名（"高一36班" 含 "高一"）
  hit = groups.filter(x => gb.indexOf(bare(nameOf(x))) >= 0 && bare(nameOf(x)).length >= 2);
  if (hit.length === 1) return hit[0].id;
  if (hit.length > 1) return null;

  return null;                                      // 推不出来 —— 不猜
}


function classLabelOf(row) {
  if (!row) return '';
  if (row.label) return row.label;
  return classLabel(row.grade, row.className);
}

function userName(u) {
  return u ? (u.displayName || u.username || '') : '系统';
}

/* ══════════════════════════════════════════════════════════════════════
 * 项目状态机：到点自动切换 + 手动锁定 + 恢复自动
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 按时间算出项目"应该"是什么状态。
 * 手动锁定（statusMode = 'manual'）的项目不会被自动改。
 * @param {object} now 传入 Date.now() 便于测试固定时间
 */
/**
 * 赛事状态：pending 未开始 / checking 检录中 / live 进行中 / done 已结束
 * （定义在 src/status.js —— 那里是唯一一处，ops/scoreboard/xport 共用）
 *
 * 说明：'checking'（检录中）是**手动进入**的状态 —— 裁判点「开始检录」时才进。
 * 所以按时间自动归位时**不能把它冲掉**：否则刚点开检录，下一次 tick 就变回"未开始"了。
 * 一旦人工推进过（检录中/进行中/已结束），autoStatus 就不再插手；
 * 只有仍处于 pending 的项目才按时间自动走。
 */
const { STATUS_ORDER, STATUS_LABEL } = require('./status');

function autoStatus(ev, nowMs) {
  if (!ev.startAt && !ev.endAt) return ev.status;   // 没设时刻就不管
  // 已经检录中/进行中/已结束的，不按时间改动（人工推进优先）
  if (ev.status && ev.status !== 'pending') return ev.status;
  const t = nowMs === undefined ? Date.now() : nowMs;
  /* 用 clockToMs，不要用 `new Date(ev.startAt)` ——
     项目现在只存 "07:40" 这种时刻串，`new Date("07:40")` 是**无效日期**，
     两个时间戳都会变成 NaN，于是这个"按时间归位"会**静默什么都不做**
     （点「全部按时间归位」看着像没反应）。clockToMs 会把时刻补上"今天"。 */
  const sMs = clockToMs(ev.startAt, t), eMs = clockToMs(ev.endAt, t);
  const start = Number.isFinite(sMs) ? sMs : null;
  const end = Number.isFinite(eMs) ? eMs : null;
  if (end !== null && t >= end) return 'done';
  if (start !== null && t >= start) return 'live';
  return 'pending';
}

/**
 * 检录人齐了就自动把项目改成"进行中"。
 * @returns {boolean} 是否真的改了
 */
function autoLiveIfAllArrived(d, ev) {
  if (!ev || ev.status === 'done') return false;          // 已结束的不回头
  if (ev.status === 'live') return false;                 // 已经是进行中
  const total = d.get('SELECT COUNT(*) AS c FROM registration WHERE eventId = ?', [ev.id]).c;
  if (!total) return false;                               // 没人报名，不自动切
  const arrived = d.get(`SELECT COUNT(*) AS c FROM checkin ck
                         JOIN registration r ON r.id = ck.regId
                         WHERE r.eventId = ? AND ck.arrived = 1`, [ev.id]).c;
  if (arrived < total) return false;
  d.run('UPDATE event SET status = ?, updatedAt = ? WHERE id = ?', ['live', nowIso(), ev.id]);
  return true;
}

/** 把一届里所有 auto 的项目按时间归位；返回改动了几个 */
function tickAll(d, meetId, nowMs) {
  const list = d.all('SELECT * FROM event WHERE meetId = ? AND statusMode = ?', [meetId, 'auto']);
  let changed = 0;
  for (const ev of list) {
    const want = autoStatus(ev, nowMs);
    if (want !== ev.status) {
      d.run('UPDATE event SET status = ?, updatedAt = ? WHERE id = ?', [want, nowIso(), ev.id]);
      changed++;
    }
  }
  if (changed) bumpRev(d, meetId);
  return changed;
}

/* ══════════════════════════════════════════════════════════════════════
 * 成绩的"槽位"语义
 *   田赛多次试跳：每次一行（attempt 1..N）
 *   径赛一次定成绩：只有 attempt 1
 *   value 为 NULL 且 dnf=1 → 弃权；foul=1 → 该次犯规（有记录、无成绩）
 * ══════════════════════════════════════════════════════════════════════ */

function resultSlot(d, regId, attempt) {
  return d.get('SELECT * FROM result WHERE regId = ? AND attempt = ?', [regId, attempt]);
}

/** 更新一条报名的"最好一次"标记（isBest 只是为了排序查询方便，名次仍实时算） */
function refreshBest(d, regId, ev) {
  const rows = d.all('SELECT * FROM result WHERE regId = ?', [regId]);
  const dir = ev.kind === 'field' ? 'max' : 'min';
  let bestId = null, best = null;
  for (const r of rows) {
    if (r.dnf || r.foul || r.value === null || r.value === undefined) continue;
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    if (best === null || (dir === 'max' ? v > best : v < best)) { best = v; bestId = r.id; }
  }
  d.run('UPDATE result SET isBest = 0 WHERE regId = ?', [regId]);
  if (bestId) d.run('UPDATE result SET isBest = 1 WHERE id = ?', [bestId]);
  void ev;
}

/** 这个报名条目是否已录过任何成绩 */
function hasAny(d, regId) {
  const r = d.get('SELECT COUNT(*) AS c FROM result WHERE regId = ?', [regId]);
  return r.c > 0;
}

/* ══════════════════════════════════════════════════════════════════════
 * 检录自动公告
 *   现场会反复开关检录（等人、暂停、再开）。如果每次新增公告，公告栏几十秒就被
 *   刷屏。所以同一个项目只维护**一条**自动公告：开→写"已开始检录"，关→改成
 *   "已停止检录"，反复开关只有这一条在变。
 * ══════════════════════════════════════════════════════════════════════ */

function announceCheckin(d, meetId, ev, open, user) {
  const exist = d.get('SELECT * FROM notice WHERE meetId = ? AND eventId = ? AND auto = 1',
    [meetId, ev.id]);
  const text = ev.name + (open
    ? '　现在开始检录，请运动员到检录处报到'
    : '　检录已结束，请运动员准备比赛');
  const now = nowIso();
  if (exist) {
    d.run('UPDATE notice SET text = ?, createdAt = ? WHERE id = ?', [text, now, exist.id]);
  } else {
    d.run(`INSERT INTO notice(id, meetId, text, level, until, pinned, eventId, auto, byUserId, byName, createdAt)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [
      makeId('nt'), meetId, text, 'normal', null, 0, ev.id, 1,
      user ? user.id : null, userName(user), now,
    ]);
  }
  // 公告栏只留最近 50 条，避免无限增长（自动公告多了也占地方）
  const old = d.all('SELECT id FROM notice WHERE meetId = ? ORDER BY createdAt DESC LIMIT -1 OFFSET 50', [meetId]);
  for (const o of old) d.run('DELETE FROM notice WHERE id = ?', [o.id]);
}

/* ══════════════════════════════════════════════════════════════════════
 * 预赛 → 决赛：自动录取前 N 名
 * ══════════════════════════════════════════════════════════════════════ */

function finalNameFor(name) {
  if (/预赛/.test(name)) return name.replace(/预赛/g, '决赛');
  if (/决赛/.test(name)) return name + '（2）';
  return name + ' 决赛';
}

/** 已有的决赛（指向同一个预赛） */
function existingFinal(d, heatId) {
  return d.get('SELECT * FROM event WHERE advanceFromId = ?', [heatId]);
}

/**
 * 建决赛并把预赛的前 N 名报进去。
 * 并列跨录取线的一起进（不靠抽签淘汰人）。
 */
function createFinalFor(d, meetId, heat, user) {
  const ctx = Board.load(d, meetId);
  const heatNow = d.get('SELECT * FROM event WHERE id = ?', [heat.id]);
  const board = Board.eventBoard(ctx, heatNow);
  const count = Number(heatNow.advanceCount) || ctx.rule.advanceCount || 6;
  const q = S.qualifiers(board.board.rows, count);
  if (!q.rows.length) {
    fail('这个预赛还没有任何成绩，没法录取。先把预赛成绩录完再来。', 'NO_RESULT');
  }

  const now = nowIso();
  const id = makeId('ev');
  const sort = (heatNow.sort || 0) + 1;
  d.run(`INSERT INTO event(id, meetId, name, groupId, kind, stage, isRelay, relayLegs, day,
            startAt, endAt, venue, status, statusMode, attempts, tol, unit,
            advanceFromId, advanceCount, sort, createdAt, updatedAt)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    id, meetId, finalNameFor(heatNow.name), heatNow.groupId, heatNow.kind, 'final',
    heatNow.isRelay, heatNow.relayLegs, heatNow.day,
    null, null, heatNow.venue, 'pending', 'auto',
    heatNow.attempts, heatNow.tol, heatNow.unit,
    heatNow.id, count, sort, now, now,
  ]);

  // 把录取的人/队按预赛名次报进决赛（道次按名次顺排，现场好叫号）
  let lane = 1;
  for (const r of q.rows) {
    const reg = d.get('SELECT * FROM registration WHERE id = ?', [r.regId]);
    if (!reg) continue;
    d.run(`INSERT INTO registration(id, meetId, eventId, athleteId, classId, teamName, legsJson, lane, sort, createdAt, updatedAt)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [
      makeId('rg'), meetId, id, reg.athleteId, reg.classId, reg.teamName, reg.legsJson,
      lane, lane, now, now,
    ]);
    lane++;
  }

  // 把预赛标成"已结束"，避免两个阶段同时"进行中"
  if (heatNow.status !== 'done') {
    d.run('UPDATE event SET status = ?, statusMode = ?, updatedAt = ? WHERE id = ?',
      ['done', 'manual', now, heatNow.id]);
  }
  bumpRev(d, meetId);

  const finalEv = d.get('SELECT * FROM event WHERE id = ?', [id]);
  return { final: finalEv, qualified: q.rows.length, note: q.expandNote, count };
}

/* ══════════════════════════════════════════════════════════════════════
 * 指令表
 * ══════════════════════════════════════════════════════════════════════ */

/* ── 运动会信息 ───────────────────────────────────────────────────────── */

def('meet.update', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const meet = meetOf(d, ctx.meetId);
  const before = { name: meet.name, subtitle: meet.subtitle, host: meet.host, holdDate: meet.holdDate };
  d.run('UPDATE meet SET name = ?, subtitle = ?, host = ?, holdDate = ?, updatedAt = ? WHERE id = ?', [
    str(p.name, 120) || meet.name, orNull(str(p.subtitle, 200)),
    orNull(str(p.host, 120)), orNull(str(p.holdDate, 120)), nowIso(), meet.id,
  ]);
  bumpRev(d, meet.id);
  return { meetId: meet.id, before, after: p };
}, { action: 'meet.update' });

def('meet.rule', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const meet = meetOf(d, ctx.meetId);
  const rule = S.mergeRule(Object.assign(S.ruleFromMeet(meet), p.rule || {}));
  d.run('UPDATE meet SET ruleJson = ?, updatedAt = ? WHERE id = ?', [JSON.stringify(rule), nowIso(), meet.id]);
  bumpRev(d, meet.id);
  return { rule };
}, { action: 'meet.rule' });

def('meet.screen', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const meet = meetOf(d, ctx.meetId);
  let cur = Board.parseJson(meet.screenJson) || {};
  cur = Object.assign(cur, p.screen || {});
  d.run('UPDATE meet SET screenJson = ?, updatedAt = ? WHERE id = ?', [JSON.stringify(cur), nowIso(), meet.id]);
  bumpRev(d, meet.id);
  return { screen: cur };
}, { action: 'meet.screen' });

/* ── 组别 ─────────────────────────────────────────────────────────────── */

def('group.add', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const meet = meetOf(d, ctx.meetId);
  const id = makeId('g');
  const sort = d.get('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM groupDef WHERE meetId = ?', [meet.id]).s;
  d.run('INSERT INTO groupDef(id, meetId, name, sort, kind) VALUES(?,?,?,?,?)',
    [id, meet.id, str(p.name, 40) || '新组别', num(p.sort, sort), orNull(str(p.kind, 20))]);
  bumpRev(d, meet.id);
  return { id };
}, { action: 'group.add' });

def('group.update', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const g = mustRow(d, 'groupDef', p.id, '组别');
  d.run('UPDATE groupDef SET name = ?, sort = ?, kind = ? WHERE id = ?', [
    str(p.name, 40) || g.name, num(p.sort, g.sort), orNull(str(p.kind, 20)), g.id,
  ]);
  bumpRev(d, g.meetId);
  return { id: g.id };
}, { action: 'group.update' });

def('group.del', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const g = mustRow(d, 'groupDef', p.id, '组别');
  const used = d.get('SELECT COUNT(*) AS c FROM event WHERE groupId = ?', [g.id]).c;
  const usedA = d.get('SELECT COUNT(*) AS c FROM athlete WHERE groupId = ?', [g.id]).c;
  if (used || usedA) {
    fail('这个组别下面还有 ' + usedA + ' 名运动员、' + used + ' 个项目，不能删除。' +
      '请先把他们改到别的组别。', 'IN_USE');
  }
  d.run('DELETE FROM groupDef WHERE id = ?', [g.id]);
  bumpRev(d, g.meetId);
  return { id: g.id };
}, { action: 'group.del' });

/* ── 班级 ─────────────────────────────────────────────────────────────── */

def('class.add', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const meet = meetOf(d, ctx.meetId);
  const c = ensureClass(d, meet.id, p.grade, p.className);
  if (!c) fail('年级和班级至少要填一个');
  bumpRev(d, meet.id);
  return { id: c.id, label: c.label };
}, { action: 'class.add' });

/* ── 运动员（名单） ───────────────────────────────────────────────────── */

def('athlete.add', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const meet = meetOf(d, ctx.meetId);
  const name = str(p.name, 40);
  if (!name) fail('姓名不能为空');
  const t = splitTeam(p.team, p.grade, p.className);
  const cls = ensureClass(d, meet.id, t.grade, t.className);
  const bib = orNull(str(p.bib, 20));

  /* 【组别怎么定 —— 这里原来是个静默 BUG】
   *   以前是 `groupIdOrFirst(d, meet.id, p.groupName || p.groupId)`，
   *   而组别为空时它返回 **groups[0]**（排序第一个 = 初一组）。
   *   于是"只填了年级、没选组别"的新运动员**全被塞进初一组**，还不报错。
   *
   *   后来改成"年级推组别"，但**还有个口子没堵**：
   *   前端传一个**不存在的 groupId**（比如那个组别已被删掉）时，
   *   groupIdOrFirst 的模糊匹配认不出，**照样落到 groups[0]** ——
   *   等于老 BUG 从另一个入口又进来了（实测能复现：传 groupId='no-such'
   *   的人被加进"男子组"）。
   *
   * 现在的口径（三条路，各有各的判据）：
   *   · 传了 groupId（前端下拉的值）→ **必须真实存在**，否则报错
   *   · 传了 groupName（导入时手写的"男"/"男子组"）→ 宽松匹配
   *   · 都没传 → 从**年级**推；推不出来就报错
   *   宁可让老师多选一下，也不能把人悄悄记到错的组里 ——
   *   组别错了，这个人的名次、班级总分、能报的项目全跟着错。 */
  let groupId = null;
  const rawId = str(p.groupId), rawName = str(p.groupName);
  if (rawName) {
    groupId = groupIdOrFirst(d, meet.id, rawName);
  } else if (rawId) {
    groupId = groupById(d, meet.id, rawId);
  } else {
    groupId = groupFromGrade(d, meet.id, t.grade);
    if (!groupId) {
      const names = d.all('SELECT name FROM groupDef WHERE meetId = ? ORDER BY sort', [meet.id])
        .map(x => x.name).join('、');
      fail(t.grade
        ? ('从年级「' + t.grade + '」认不出该归哪个组别。请把「年级」填成与组别对应的写法（现有组别：'
          + names + '），或在「组别」里直接选一个。')
        : ('请填写「年级」（现有组别：' + names + '），否则不知道该把这个人归到哪一组。'),
      'NO_GROUP');
    }
  }

  /* 【新增时的防呆】以前这两样都不查，实测能加出：
   *   · 两个号码一样的人 —— 号码是现场认人的唯一凭据（检录、成绩录入、
   *     大屏都靠它），重号会让"这个人到底是谁"说不清，而且改起来要翻名单。
   *   · 完全同名同班的人 —— 多半是手滑点两次"加入"。
   * 注意：**不同班可以重名**（真有两个张伟），所以同名只在"同班同组别"时才拦。 */
  if (bib) {
    const dupBib = d.get('SELECT id, name FROM athlete WHERE meetId = ? AND bib = ?', [meet.id, bib]);
    if (dupBib) {
      fail('号码「' + bib + '」已经被「' + dupBib.name + '」用了。'
        + '号码是现场认人的唯一凭据，不能重复 —— 请换一个号码，'
        + '或先去名单里把那个人改成别的号码。', 'DUP_BIB');
    }
  }
  const dupName = d.get(`SELECT id FROM athlete
                         WHERE meetId = ? AND name = ? AND IFNULL(grade,'') = IFNULL(?,'')
                           AND IFNULL(className,'') = IFNULL(?,'')`,
    [meet.id, name, orNull(t.grade), orNull(t.className)]);
  if (dupName) {
    fail('「' + name + '」在同一个班里已经有了。如果确实有两个同名的同学，'
      + '请在名字后面加个区分（比如"张伟(大)"），或先填号码再核对。', 'DUP_NAME');
  }

  const now = nowIso();
  const id = makeId('a');
  d.run(`INSERT INTO athlete(id, meetId, name, groupId, classId, grade, className, team, bib, gender, note, createdAt, updatedAt)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    id, meet.id, name, groupId, cls ? cls.id : null,
    orNull(t.grade), orNull(t.className), orNull(str(p.team, 60)),
    bib, orNull(str(p.gender, 10)), orNull(str(p.note, 200)), now, now,
  ]);
  bumpRev(d, meet.id);
  return { id };
}, { action: 'athlete.add' });

def('athlete.update', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const a = mustRow(d, 'athlete', p.id, '运动员');
  /* 审计用的"改前值"（写给 auditBefore/auditWrite 看的那份） */
  const before = { name: a.name, bib: a.bib, grade: a.grade, className: a.className, team: a.team,
    blocked: a.blocked ? 1 : 0 };
  const t = splitTeam(
    p.team === undefined ? a.team : p.team,
    p.grade === undefined ? a.grade : p.grade,
    p.className === undefined ? a.className : p.className
  );
  const cls = (t.grade || t.className) ? ensureClass(d, a.meetId, t.grade, t.className) : null;
  const groupId = p.groupId ? p.groupId : (p.groupName ? groupIdOrFirst(d, a.meetId, p.groupName) : a.groupId);
  d.run(`UPDATE athlete SET name = ?, groupId = ?, classId = ?, grade = ?, className = ?,
            team = ?, bib = ?, gender = ?, note = ?, blocked = ?, updatedAt = ? WHERE id = ?`, [
    p.name === undefined ? a.name : (str(p.name, 40) || a.name),
    groupId,
    cls ? cls.id : (p.classId === undefined ? a.classId : orNull(p.classId)),
    orNull(t.grade), orNull(t.className),
    p.team === undefined ? a.team : orNull(str(p.team, 60)),
    p.bib === undefined ? a.bib : orNull(str(p.bib, 20)),
    p.gender === undefined ? a.gender : orNull(str(p.gender, 10)),
    p.note === undefined ? a.note : orNull(str(p.note, 200)),
    /* blocked 是 0/1：不传就保持原值（老库升上来是 0） */
    p.blocked === undefined ? (a.blocked ? 1 : 0) : (p.blocked ? 1 : 0),
    nowIso(), a.id,
  ]);
  bumpRev(d, a.meetId);
  return { id: a.id, before };
}, { action: 'athlete.update' });

/**
 * 屏蔽 / 取消屏蔽运动员。
 *
 * 【为什么要这个（而不是直接删）】现场会有"这个人上不了场了"的情况，
 *   但**不能删**他：删了报名和成绩一起没，号码也可能还要留着（秩序册已印）。
 *   屏蔽的语义是：**人还在库里、还在录入页**（随时能取消），
 *   但**成绩展示页（大屏/成绩与名次）不展示他** —— 名次照常按剩下的人排。
 *
 * 单开一个操作、不走 athlete.update：那边一改就要重算班级/组别，
 * 而这里只动一个开关，越简单越不容易误伤。
 */
def('athlete.block', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const a = mustRow(d, 'athlete', p.id, '运动员');
  const want = p.blocked ? 1 : 0;
  const was = a.blocked ? 1 : 0;
  if (was === want) return { id: a.id, blocked: want, unchanged: true };
  d.run('UPDATE athlete SET blocked = ?, updatedAt = ? WHERE id = ?', [want, nowIso(), a.id]);
  bumpRev(d, a.meetId);
  return { id: a.id, name: a.name, blocked: want, before: was };
}, { action: 'athlete.block' });

def('athlete.del', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const a = mustRow(d, 'athlete', p.id, '运动员');
  const regs = d.all('SELECT id FROM registration WHERE athleteId = ?', [a.id]);
  // 接力队的队员是姓名快照，删掉运动员不影响历史成绩单（这是有意设计）
  for (const r of regs) {
    d.run('DELETE FROM result WHERE regId = ?', [r.id]);
    d.run('DELETE FROM checkin WHERE regId = ?', [r.id]);
    d.run('DELETE FROM registration WHERE id = ?', [r.id]);
  }
  d.run('DELETE FROM athlete WHERE id = ?', [a.id]);
  bumpRev(d, a.meetId);
  return { id: a.id, removedRegs: regs.length };
}, { action: 'athlete.del' });

/**
 * 名单批量导入（从 Excel 整块粘贴，或上传 csv/tsv 文本）。
 *
 * 【兼容性设计】现场拿到的名单表格千奇百怪，所以这一段的容错做得很宽：
 *   · 表头：精确名 → 包含关系 → 正则 三级匹配，还带"优先级"（见 HDR）
 *     「运动员姓名」「学生姓名」「姓 名」都能认出来
 *   · 全角转半角、去空格、去星号括号 → 「姓　名*」「性别（男/女）」也能认
 *   · 姓名列必须有；其余列没有就用默认值（组别取第一个），不会因为少一列就整份失败
 *   · 同一人（同组别+同名+同号码；没号码时用 同名+班级）更新而不是重复插入
 *   · 逐行报错：哪一行缺姓名，返回给前端显示，不会静默吞掉
 */
const HDR = {
  // 优先级越大越优先。号码要压过"序号"，班级要压过"班"，避免被宽泛别名抢走
  name: { p: 10, exact: ['姓名', '名字', '运动员', '运动员姓名', '学生', '学生姓名', 'name', '姓 名'], like: ['姓名', '名字', '运动员', '学生', 'name'] },
  bib: { p: 9, exact: ['号码', '号码布', '编号', '参赛号', '学号', '号', 'bib', 'no', 'number', '序号'], like: ['号码布', '参赛号', '号码', '编号', '学号', '序号'] },
  group: { p: 8, exact: ['组别', '组', '性别组', '大组', 'group'], like: ['组别', '性别组'] },
  className: { p: 8, exact: ['班级', '班', '所在班级', '行政班', 'class'], like: ['班级', '所在班', '行政班'] },
  grade: { p: 7, exact: ['年级', '级', '所在年级', 'grade'], like: ['年级'] },
  team: { p: 6, exact: ['单位', '队伍', '代表队', '班级单位', '参赛单位', 'team'], like: ['单位', '队伍', '代表队'] },
  gender: { p: 6, exact: ['性别', 'gender', 'sex'], like: ['性别'] },
  note: { p: 4, exact: ['备注', '说明', '注', 'note', 'remark'], like: ['备注', '说明'] },
};

/** 表头归一化：去空格/星号/括号内容、全角转半角、转小写 */
function normHeader(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))  // 全角→半角
    .replace(/\u3000/g, ' ')
    .replace(/[（(【\[].*?[）)】\]]/g, '')     // 去掉括号及其中内容
    .replace(/[\s*＊:：、,，.。"'`]/g, '')      // 去掉空白与常见标点
    .toLowerCase();
}

/** 把一行的列名映射成"字段 → 列名"，返回命中的字段数与每个字段的中文标签 */
function mapHeaders(head) {
  const cols = (head || []).map(h => ({ raw: String(h), norm: normHeader(h) }));
  const got = {};
  const labels = {};
  Object.keys(HDR).forEach((field) => {
    const spec = HDR[field];
    let hit = null;
    // ① 精确
    for (const c of cols) {
      if (!c.norm) continue;
      if (spec.exact.some(a => normHeader(a) === c.norm)) { hit = c; break; }
    }
    // ② 包含
    if (!hit) {
      for (const c of cols) {
        if (!c.norm) continue;
        if (spec.like.some(a => c.norm.indexOf(normHeader(a)) >= 0)) { hit = c; break; }
      }
    }
    if (hit) { got[field] = hit.raw; labels[field] = hit.raw; }
  });
  return { got, labels, fields: Object.keys(got).length };
}

def('athlete.import', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const meet = meetOf(d, ctx.meetId);
  const rows = Array.isArray(p.rows) ? p.rows : [];
  if (!rows.length) fail('没有读到任何数据行');

  // 前端已按表头映射好；没映射时（比如直接调接口）在这里再自动认一遍
  let map = p.map;
  if (!map || typeof map !== 'object' || !map.name) {
    const head = Object.keys(rows[0] || {});
    map = mapHeaders(head).got;
  }
  if (!map.name) {
    const seen = Object.keys(rows[0] || {}).slice(0, 8).join('、');
    fail('认不出"姓名"列。请确认第一行是表头，并且有一列叫「姓名」。当前读到的列名：' + (seen || '（空）'));
  }
  const pick = (row, field) => {
    const key = map[field];
    if (!key) return '';
    const v = row[key];
    return v === undefined || v === null ? '' : String(v).trim();
  };

  let added = 0, updated = 0, skipped = 0;
  const errors = [];
  const now = nowIso();

  rows.forEach((row, i) => {
    const name = pick(row, 'name');
    if (!name) { skipped++; if (errors.length < 8) errors.push('第 ' + (i + 2) + ' 行没有姓名，已跳过'); return; }
    const groupName = pick(row, 'group');
    const grade = pick(row, 'grade');
    const className = pick(row, 'className');
    const team = pick(row, 'team');
    const bib = pick(row, 'bib');
    const gender = pick(row, 'gender');
    const note = pick(row, 'note');
    /* 【和 athlete.add 同一个口径】组别列空着时**按年级推**，不要落到第一个组别。
       以前这里也是 `groupIdOrFirst(...)` —— 名单里没有"组别"列（很常见，
       因为组别本来就是从年级来的）时，**整批人全进初一组**，而且导入完
       只看到"成功 N 条"，一点异常都没有。 */
    const t = splitTeam(team, grade, className);
    let groupId = groupName ? groupIdOrFirst(d, meet.id, groupName)
      : groupFromGrade(d, meet.id, t.grade);
    if (!groupId) {
      skipped++;
      if (errors.length < 8) {
        errors.push('第 ' + (i + 2) + ' 行「' + name + '」：'
          + (t.grade ? ('年级「' + t.grade + '」认不出组别') : '没有年级也没有组别')
          + '，已跳过（请补上年级，或加一列"组别"）');
      }
      return;
    }
    const cls = ensureClass(d, meet.id, t.grade, t.className);

    // 去重：同组别 + 同名 + 同号码（号码为空时用 同名+班级）
    let exist = null;
    if (bib) {
      exist = d.get('SELECT * FROM athlete WHERE meetId = ? AND groupId = ? AND name = ? AND bib = ?',
        [meet.id, groupId, name, bib]);
    } else {
      exist = d.get('SELECT * FROM athlete WHERE meetId = ? AND groupId = ? AND name = ? AND IFNULL(bib, \'\') = \'\' AND IFNULL(className, \'\') = ?',
        [meet.id, groupId, name, t.className || '']);
    }
    if (exist) {
      d.run(`UPDATE athlete SET classId = ?, grade = ?, className = ?, team = ?, gender = ?,
                note = ?, updatedAt = ? WHERE id = ?`, [
        cls ? cls.id : null, orNull(t.grade), orNull(t.className),
        orNull(team) || (cls ? cls.label : null), orNull(gender), orNull(note), now, exist.id,
      ]);
      updated++;
    } else {
      d.run(`INSERT INTO athlete(id, meetId, name, groupId, classId, grade, className, team, bib, gender, note, createdAt, updatedAt)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        makeId('a'), meet.id, name, groupId, cls ? cls.id : null,
        orNull(t.grade), orNull(t.className), orNull(team) || (cls ? cls.label : null),
        orNull(bib), orNull(gender), orNull(note), now, now,
      ]);
      added++;
    }
  });

  bumpRev(d, meet.id);
  return {
    added, updated, skipped, errors, total: rows.length,
    matched: Object.keys(map).filter(k => map[k]),
  };
}, { action: 'athlete.import' });

/* ── 项目 ─────────────────────────────────────────────────────────────── */

/**
 * 时刻归一：能认出钟点的存 "HH:MM"，认不出的原样留着（或 null）。
 * 放在 normalizeEventFields 上面，因为它建 event 时要用。
 */
function normClock(v) {
  if (v === null || v === undefined || v === '') return null;
  const c = toClockStr(v);
  return c || orNull(str(v, 40));
}

function normalizeEventFields(d, meetId, p, base) {  const b = base || {};
  const kind = (p.kind === 'field' || p.kind === 'track') ? p.kind : (b.kind || 'track');
  const stage = (p.stage === 'heat' || p.stage === 'final') ? p.stage : (b.stage || 'final');
  const isRelay = p.isRelay === undefined ? !!b.isRelay : !!p.isRelay;
  let attempts = num(p.attempts, b.attempts === undefined ? 1 : b.attempts);
  if (kind === 'track') attempts = 1;                 // 径赛只有一次成绩
  if (!Number.isFinite(attempts) || !Number.isInteger(attempts)) attempts = 1;
  attempts = Math.max(1, Math.min(10, attempts));
  /* [组别] 和 athlete.add 同一口径：给 id 就必须真实存在。
     以前这里是 `p.groupId ? p.groupId : ...` —— 传错的 id 会**原样写进库**，
     结果是一个挂在不存在组别上的项目（列表里分组头是空的、排序也乱）。
     现在给 id 走严格校验，给名字才宽松匹配。 */
  const rawId = str(p.groupId), rawName = str(p.groupName);
  const groupId = rawName ? groupIdOrFirst(d, meetId, rawName)
    : rawId ? groupById(d, meetId, rawId)
      : b.groupId;
  if (!groupId) fail('项目必须属于一个组别（男子组/女子组），请选一个。', 'NO_GROUP');
  /* 注意：这里每个值都必须是「可绑定」的（字符串/数字/null）。
     绝不能留下 undefined —— node:sqlite 会直接报
     "Provided value cannot be bound to SQLite parameter N"。
     历史上 unit 就漏过一次：新建项目时不传 unit，结果 b.unit 是 undefined，
     整个 event.add 全挂（而且报的是参数序号，很难一眼看出是哪个字段）。 */
  const pickOr = (v, fallback) => (v === undefined ? (fallback === undefined ? null : fallback) : v);
  return {
    name: str(p.name, 80) || b.name || '新项目',
    groupId, kind, stage, isRelay,
    relayLegs: isRelay ? Math.max(2, Math.min(8, num(p.relayLegs, b.relayLegs || 4))) : null,
    day: p.day === undefined ? (b.day === undefined ? null : b.day) : (p.day === '' ? null : num(p.day, null)),
    /* 时刻统一存 "HH:MM"（见 util.js 里 toClockStr 的说明）。
       老数据是 "2026-09-30T07:40" 这种 ISO，这里顺手归一成 "07:40"；
       认不出的（比如历史遗留的纯日期 "2026-09-30"）保留原样，别默默清掉。 */
    startAt: normClock(pickOr(p.startAt, b.startAt)),
    endAt: normClock(pickOr(p.endAt, b.endAt)),
    venue: orNull(str(pickOr(p.venue, b.venue), 60)),
    attempts,
    /* 精度档位：只允许 0.001 / 0.01 / 0.1 / 1（见 parse.js 顶部那段说明）。
       没传就按类型给默认值；历史遗留的怪值也在这里归到最近档位，
       免得判等逻辑拿到一个没意义的数值。 */
    tol: P.normTol(p.tol === undefined ? (b.tol === undefined ? P.defaultTol(kind) : b.tol) : p.tol, kind),
    unit: orNull(str(pickOr(p.unit, b.unit), 20)),
    advanceCount: num(p.advanceCount, b.advanceCount === undefined ? 6 : b.advanceCount),
    sort: num(p.sort, b.sort === undefined ? 0 : b.sort),
  };
}

def('event.add', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const meet = meetOf(d, ctx.meetId);

  /* 【新增时的防呆】以前这里什么都不查，实测能建出：
   *   · 名字为空的项目（normalizeEventFields 里的 `|| '新项目'` 会把它
   *     悄悄变成"新项目"，现场就会出现一堆同名同姓的"新项目"）
   *   · 同一个组别下重名的项目（比如手滑点两次"添加"）
   * 这两样一旦进了库，选项目时根本分不清哪个是哪个，只能一条条手工删。
   * 所以新增时一律先拦住（改名走 event.update，不受影响）。 */
  const wantName = str(p.name, 80);
  if (!wantName) fail('项目名称不能为空。请填写，例如「男子 100 米决赛」。', 'NO_NAME');

  const f = normalizeEventFields(d, meet.id, p, null);
  f.name = wantName;                       // 不要让它退回 '新项目'

  const dup = d.get('SELECT id, name FROM event WHERE meetId = ? AND groupId = ? AND name = ?',
    [meet.id, f.groupId, f.name]);
  if (dup) {
    fail('这个组别里已经有一个叫「' + f.name + '」的项目了。'
      + '如果是要再加一组（比如另一个赛次），请在名字里区分开，例如加"（2）"。', 'DUP_NAME');
  }

  const id = makeId('ev');
  if (!f.sort) {
    f.sort = d.get('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM event WHERE meetId = ?', [meet.id]).s;
  }
  const now = nowIso();
  d.run(`INSERT INTO event(id, meetId, name, groupId, kind, stage, isRelay, relayLegs, day,
            startAt, endAt, venue, status, statusMode, attempts, tol, unit,
            advanceFromId, advanceCount, sort, createdAt, updatedAt)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    id, meet.id, f.name, f.groupId, f.kind, f.stage, f.isRelay ? 1 : 0, f.relayLegs, f.day,
    f.startAt, f.endAt, f.venue, 'pending', 'auto', f.attempts, f.tol, f.unit,
    null, f.advanceCount, f.sort, now, now,
  ]);
  bumpRev(d, meet.id);
  autoTickOne(d, id);
  return { id };
}, { action: 'event.add' });

/** 单个项目建完立刻按时间归位（刚建的项目如果时间已过，别一直"未开始"） */
function autoTickOne(d, eventId) {
  const ev = d.get('SELECT * FROM event WHERE id = ?', [eventId]);
  if (!ev || ev.statusMode !== 'auto') return;
  const want = autoStatus(ev);
  if (want !== ev.status) {
    d.run('UPDATE event SET status = ?, updatedAt = ? WHERE id = ?', [want, nowIso(), ev.id]);
  }
}

def('event.update', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const ev = mustRow(d, 'event', p.id, '项目');
  const f = normalizeEventFields(d, ev.meetId, p, ev);
  d.run(`UPDATE event SET name = ?, groupId = ?, kind = ?, stage = ?, isRelay = ?, relayLegs = ?,
            day = ?, startAt = ?, endAt = ?, venue = ?, attempts = ?, tol = ?, unit = ?,
            advanceCount = ?, sort = ?, updatedAt = ? WHERE id = ?`, [
    f.name, f.groupId, f.kind, f.stage, f.isRelay ? 1 : 0, f.relayLegs,
    f.day, f.startAt, f.endAt, f.venue, f.attempts, f.tol, f.unit,
    f.advanceCount, f.sort, nowIso(), ev.id,
  ]);
  /* 次数变少了 → 把超出范围的试跳记录清掉。
     【为什么】原来是 `if (f.attempts === 1)` 才清 ——
     从 6 次改成 3 次时不清，第 4~6 次的成绩留在库里：
     界面上看不见（录入页只画到第 3 次），但 scoring 取最好成绩时会遍历所有行，
     等于**看不见的成绩还在参与排名**。改成"只要减少就清"，并把清掉的条数报出来。 */
  const oldAttempts = Math.max(1, Number(ev.attempts) || 1);
  let cleaned = 0;
  if (f.attempts < oldAttempts) {
    const regs = d.all('SELECT id FROM registration WHERE eventId = ?', [ev.id]);
    for (const r of regs) {
      const del = d.run('DELETE FROM result WHERE regId = ? AND attempt > ?', [r.id, f.attempts]);
      cleaned += (del && del.changes) || 0;
      refreshBest(d, r.id, f);
    }
  }
  bumpRev(d, ev.meetId);
  autoTickOne(d, ev.id);
  return cleaned
    ? {
      id: ev.id, cleaned,
      note: '试跳次数从 ' + oldAttempts + ' 次改为 ' + f.attempts + ' 次，'
        + '已清掉 ' + cleaned + ' 条超出的成绩',
    }
    : { id: ev.id };
}, { action: 'event.update' });

def('event.del', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const ev = mustRow(d, 'event', p.id, '项目');
  const fin = d.get('SELECT id, name FROM event WHERE advanceFromId = ?', [ev.id]);
  if (fin && !p.force) {
    fail('这个项目已经生成了决赛「' + fin.name + '」。如果要删，请先删决赛（或勾选强制删除）。', 'HAS_FINAL');
  }
  d.run('DELETE FROM result WHERE eventId = ?', [ev.id]);
  d.run('DELETE FROM checkin WHERE eventId = ?', [ev.id]);
  d.run('DELETE FROM checkinState WHERE eventId = ?', [ev.id]);
  d.run('DELETE FROM registration WHERE eventId = ?', [ev.id]);
  d.run('UPDATE notice SET eventId = NULL WHERE eventId = ?', [ev.id]);
  d.run('DELETE FROM event WHERE id = ?', [ev.id]);
  bumpRev(d, ev.meetId);
  return { id: ev.id };
}, { action: 'event.del' });

def('event.move', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const ev = mustRow(d, 'event', p.id, '项目');
  const dir = p.dir === 'up' ? -1 : 1;
  const all = d.all('SELECT id, sort FROM event WHERE meetId = ? ORDER BY sort, id', [ev.meetId]);
  const idx = all.findIndex(x => x.id === ev.id);
  const swap = all[idx + dir];
  if (!swap) return { moved: false };
  // 交换 sort；如果两个 sort 相同，先重新编号再换
  d.run('UPDATE event SET sort = ? WHERE id = ?', [swap.sort, ev.id]);
  d.run('UPDATE event SET sort = ? WHERE id = ?', [ev.sort, swap.id]);
  const again = d.all('SELECT id, sort FROM event WHERE meetId = ? ORDER BY sort, id', [ev.meetId]);
  const dup = again.some((x, i) => i > 0 && x.sort === again[i - 1].sort);
  if (dup) {
    again.forEach((x, i) => d.run('UPDATE event SET sort = ? WHERE id = ?', [i + 1, x.id]));
  }
  bumpRev(d, ev.meetId);
  return { moved: true };
}, { action: 'event.move' });

/** 手动切状态：一旦手动切过就锁定为"手动"，直到"恢复自动" */
def('event.status', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const ev = mustRow(d, 'event', p.id, '项目');
  const want = ['pending', 'checking', 'live', 'done'].indexOf(p.status) >= 0 ? p.status : null;
  if (!want) fail('状态只能是 未开始/检录中/进行中/已结束');
  d.run('UPDATE event SET status = ?, statusMode = ?, updatedAt = ? WHERE id = ?',
    [want, 'manual', nowIso(), ev.id]);
  bumpRev(d, ev.meetId);
  return { id: ev.id, status: want, statusMode: 'manual' };
}, { action: 'event.status' });

/** 恢复自动：立刻按当前时间归位 */
def('event.statusAuto', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const ev = mustRow(d, 'event', p.id, '项目');
  const want = autoStatus(ev);
  d.run('UPDATE event SET status = ?, statusMode = ?, updatedAt = ? WHERE id = ?',
    [want, 'auto', nowIso(), ev.id]);
  bumpRev(d, ev.meetId);
  return { id: ev.id, status: want, statusMode: 'auto' };
}, { action: 'event.statusAuto' });

/** 一键把所有项目恢复自动（赛程临时整体推迟时很省事） */
def('event.autoAll', (ctx) => {
  const d = ctx.d, p = ctx.payload || {};
  const meet = meetOf(d, ctx.meetId);
  const list = d.all('SELECT * FROM event WHERE meetId = ?', [meet.id]);
  let n = 0;
  for (const ev of list) {
    const want = autoStatus(ev);
    if (ev.statusMode !== 'auto' || want !== ev.status) {
      d.run('UPDATE event SET status = ?, statusMode = ?, updatedAt = ? WHERE id = ?',
        [want, 'auto', nowIso(), ev.id]);
      n++;
    }
  }
  if (n) bumpRev(d, meet.id);
  return { changed: n, force: !!p.force };
}, { action: 'event.statusAuto' });

/** 按时间归位（定时任务与手动都调它；手动传 now 便于测试） */
def('event.tick', (ctx) => {
  const d = ctx.d, p = ctx.payload || {};
  const meet = meetOf(d, ctx.meetId);
  const n = tickAll(d, meet.id, p.now ? Number(p.now) : undefined);
  return { changed: n };
}, { action: 'event.tick', silentIfNone: true });

/* ── 报名（名单） ─────────────────────────────────────────────────────── */

def('reg.add', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const ev = mustRow(d, 'event', p.eventId, '项目');
  const now = nowIso();
  const id = makeId('rg');
  if (p.athleteId) {
    const a = mustRow(d, 'athlete', p.athleteId, '运动员');
    const dup = d.get('SELECT id FROM registration WHERE eventId = ? AND athleteId = ?', [ev.id, a.id]);
    if (dup) fail('这位运动员已经在这个项目的名单里了', 'DUP');
    d.run(`INSERT INTO registration(id, meetId, eventId, athleteId, classId, teamName, legsJson, lane, sort, createdAt, updatedAt)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [
      id, ev.meetId, ev.id, a.id, a.classId, orNull(str(p.teamName, 60)), null,
      p.lane === undefined || p.lane === '' ? null : num(p.lane, null),
      num(p.sort, 0), now, now,
    ]);
  } else {
    // 接力队：没有单个运动员，按班级成队
    const cls = p.classId ? mustRow(d, 'classDef', p.classId, '班级') : null;
    const teamName = str(p.teamName, 60) || (cls ? cls.label : '');
    if (!teamName) fail('接力队至少要填一个队名（通常就是班级名）');
    const dup = d.get('SELECT id FROM registration WHERE eventId = ? AND teamName = ?', [ev.id, teamName]);
    if (dup) fail('「' + teamName + '」已经在这个项目的名单里了', 'DUP');
    d.run(`INSERT INTO registration(id, meetId, eventId, athleteId, classId, teamName, legsJson, lane, sort, createdAt, updatedAt)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [
      id, ev.meetId, ev.id, null, cls ? cls.id : null, teamName,
      Array.isArray(p.legs) && p.legs.length ? JSON.stringify(p.legs.map(x => str(x, 20)).filter(Boolean)) : null,
      p.lane === undefined || p.lane === '' ? null : num(p.lane, null),
      num(p.sort, 0), now, now,
    ]);
  }
  bumpRev(d, ev.meetId);
  return { id };
}, { action: 'reg.add' });

def('reg.del', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const reg = mustRow(d, 'registration', p.id, '报名记录');
  d.run('DELETE FROM result WHERE regId = ?', [reg.id]);
  d.run('DELETE FROM checkin WHERE regId = ?', [reg.id]);
  d.run('DELETE FROM registration WHERE id = ?', [reg.id]);
  bumpRev(d, reg.meetId);
  return { id: reg.id };
}, { action: 'reg.del' });

def('reg.update', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const reg = mustRow(d, 'registration', p.id, '报名记录');
  d.run(`UPDATE registration SET teamName = ?, legsJson = ?, lane = ?, classId = ?, updatedAt = ? WHERE id = ?`, [
    p.teamName === undefined ? reg.teamName : orNull(str(p.teamName, 60)),
    p.legs === undefined ? reg.legsJson
      : (Array.isArray(p.legs) && p.legs.length ? JSON.stringify(p.legs.map(x => str(x, 20)).filter(Boolean)) : null),
    p.lane === undefined ? reg.lane : (p.lane === '' || p.lane === null ? null : num(p.lane, null)),
    p.classId === undefined ? reg.classId : orNull(p.classId),
    nowIso(), reg.id,
  ]);
  bumpRev(d, reg.meetId);
  return { id: reg.id };
}, { action: 'reg.update' });

/**
 * 接力队员：支持手填，也支持"按班级自动补齐"。
 * 自动补齐的做法：把这个班里在这个项目的**已报名个人项目**或同班运动员按号码顺序取前 N 人。
 * 现场口径：接力按班级成队，队员就是本班参加接力的人，老师大多时候手填 4 个名字。
 */
def('reg.legs', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const reg = mustRow(d, 'registration', p.id, '报名记录');
  const ev = mustRow(d, 'event', reg.eventId, '项目');
  const n = Math.max(2, Math.min(8, Number(ev.relayLegs) || 4));
  let legs = Array.isArray(p.legs) ? p.legs.map(x => str(x, 20)).filter(Boolean) : null;

  if (!legs && p.auto) {
    if (!reg.classId) fail('这个接力队没有绑定班级，没法自动补齐队员。请先选班级或手填队员。', 'NO_CLASS');
    const mates = d.all(`SELECT name, bib FROM athlete
                         WHERE meetId = ? AND classId = ?
                         ORDER BY CASE WHEN bib IS NULL OR bib = '' THEN 1 ELSE 0 END, bib, name`,
      [reg.meetId, reg.classId]);
    legs = mates.slice(0, n).map(m => m.name);
    if (!legs.length) fail('这个班里还没有运动员，没法自动补齐', 'NO_ATHLETE');
  }
  if (!legs) legs = [];
  d.run('UPDATE registration SET legsJson = ?, updatedAt = ? WHERE id = ?',
    [legs.length ? JSON.stringify(legs.slice(0, n)) : null, nowIso(), reg.id]);
  bumpRev(d, reg.meetId);
  return { id: reg.id, legs: legs.slice(0, n) };
}, { action: 'reg.legs' });

/* ── 成绩（现场最核心的指令） ─────────────────────────────────────────── */

/**
 * 写入一条成绩。
 *
 * payload:
 *   eventId        项目
 *   regId          报名条目（推荐）；也可给 athleteId 自动找报名
 *   attempt        第几次（田赛试跳 1..N；径赛固定 1）
 *   value          原样输入（"12.35" / "2:15.30" / "5.67" / "弃权" / 空=删除）
 *   version        客户端看到的版本号（乐观锁）；不传表示"我没有底稿，直接写"
 *   clientUuid     客户端唯一 id（幂等：断网重发不会录成两条）
 *   force          版本对不上时强行覆盖（前端让人选择"用我的"之后才传 true）
 *
 * 【并发怎么写才不会丢数据】
 *   两个人同时改同一条成绩：
 *     · 都带 version → 先到的成功（version+1），后到的拿到 CONFLICT 与"服务器当前值"，
 *       前端弹并排对比让人选用哪个。**绝不静默覆盖**。
 *     · 没带 version（比如现场新的手机打开就录）→ 直接写，但审计里记下是谁写的。
 */
def('result.set', (ctx) => {
  const d = ctx.d, p = ctx.payload, u = ctx.user;
  const ev = mustRow(d, 'event', p.eventId, '项目');

  // 找报名条目
  let reg = null;
  if (p.regId) reg = mustRow(d, 'registration', p.regId, '报名记录');
  else if (p.athleteId) {
    reg = d.get('SELECT * FROM registration WHERE eventId = ? AND athleteId = ?', [ev.id, p.athleteId]);
    if (!reg) {
      // 名单里没有这个人：现场常见（临时加人）。自动补一条报名，别让老师卡住。
      const a = mustRow(d, 'athlete', p.athleteId, '运动员');
      const now = nowIso();
      const id = makeId('rg');
      d.run(`INSERT INTO registration(id, meetId, eventId, athleteId, classId, teamName, legsJson, lane, sort, createdAt, updatedAt)
             VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [id, ev.meetId, ev.id, a.id, a.classId, null, null, null, 0, now, now]);
      reg = d.get('SELECT * FROM registration WHERE id = ?', [id]);
    }
  }
  if (!reg) fail('没找到这条报名记录。请刷新页面后重试，或先在名单里把这个人加到本项目。', 'NO_REG');
  if (reg.eventId !== ev.id) fail('这条报名不属于这个项目（可能是页面数据旧了，请刷新）', 'MISMATCH');

  /* ── 试跳/试掷次数校验 ────────────────────────────────────────────────
   *
   * 【原来错在哪】只写了一句 `Math.max(1, Math.min(10, num(p.attempt, 1)))` ——
   * 它是个**夹取**（clamp），不是校验：attempt=0 被悄悄改成 1，
   * -1 改成 1，1.5 也照收。而且上面只拦了 `attempt > 1` 时项目是不是多次项目，
   * **没有拦上限** —— 三次试跳的项目实测能录进第 4 次、第 99 次。
   *
   * 后果不只是多一行：scoring 里"取最好成绩"会遍历所有成绩行，
   * 第 4 次跳出的好成绩会参与排名，等于凭空多给一次机会。
   *
   * 现在：attempt 必须是 1..ev.attempts 的整数，别的一律拒绝并说清原因。 */
  const attemptRaw = p.attempt === undefined || p.attempt === null || p.attempt === ''
    ? 1 : Number(p.attempt);
  if (!Number.isInteger(attemptRaw)) {
    fail('第几次成绩必须是整数（收到「' + p.attempt + '」）', 'BAD_ATTEMPT');
  }
  const attempt = attemptRaw;
  const maxAttempts = ev.kind === 'field' ? Math.max(1, Number(ev.attempts) || 1) : 1;
  if (attempt < 1) {
    fail('第几次成绩要从 1 开始（收到 ' + attempt + '）', 'BAD_ATTEMPT');
  }
  if (attempt > maxAttempts) {
    fail('这个项目只记 ' + maxAttempts + ' 次成绩，没有第 ' + attempt + ' 次'
      + (ev.kind === 'field' ? '（要改次数请在「赛程编排 → 详细设置」里改）' : '')
      + '。', 'BAD_ATTEMPT');
  }

  const cur = resultSlot(d, reg.id, attempt);
  const parsed = P.parseResult(p.value, { kind: ev.kind, unit: ev.unit });

  // ── 乐观锁：版本对不上就报冲突（除非明确要求覆盖）
  if (cur && p.version !== undefined && p.version !== null && p.version !== ''
      && Number(p.version) !== Number(cur.version) && !p.force) {
    conflict('这条成绩刚被别人改过（当前是「' + displayOf(cur, ev) + '」，你提交的是「' +
      (parsed.empty ? '清空' : (parsed.raw || p.value)) + '」）。请选择保留哪一个。', {
      server: {
        id: cur.id, value: cur.value, raw: cur.raw, dnf: !!cur.dnf, foul: !!cur.foul,
        display: displayOf(cur, ev), version: cur.version,
        byName: cur.byName || '', at: cur.recordedAt,
      },
    });
  }

  const now = nowIso();
  let action = 'unchanged';

  if (parsed.empty) {
    // 清空输入框 = 删除这次成绩
    if (cur) {
      d.run('DELETE FROM result WHERE id = ?', [cur.id]);
      action = 'deleted';
    }
  } else if (cur) {
    d.run(`UPDATE result SET value = ?, dnf = ?, foul = ?, raw = ?, version = version + 1,
              clientUuid = ?, source = ?, byUserId = ?, byName = ?, recordedAt = ?, updatedAt = ?
           WHERE id = ?`, [
      parsed.dnf || parsed.foul ? null : parsed.value,
      parsed.dnf ? 1 : 0, parsed.foul ? 1 : 0, parsed.raw || String(p.value),
      p.clientUuid || cur.clientUuid, ctx.source || 'entry',
      u ? u.id : null, userName(u), now, now, cur.id,
    ]);
    action = 'updated';
  } else {
    d.run(`INSERT INTO result(id, meetId, eventId, regId, attempt, value, dnf, foul, raw, isBest,
              version, clientUuid, source, byUserId, byName, recordedAt, updatedAt)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      makeId('r'), ev.meetId, ev.id, reg.id, attempt,
      parsed.dnf || parsed.foul ? null : parsed.value,
      parsed.dnf ? 1 : 0, parsed.foul ? 1 : 0, parsed.raw || String(p.value), 0,
      1, p.clientUuid || null, ctx.source || 'entry',
      u ? u.id : null, userName(u), now, now,
    ]);
    action = 'created';
  }

  refreshBest(d, reg.id, ev);
  bumpRev(d, ev.meetId);

  // 回给前端的新版本号（它下次提交要带上，才能发现别人改过）
  const after = resultSlot(d, reg.id, attempt);
  const response = {
    action,
    eventId: ev.id,
    regId: reg.id,
    attempt,
    version: after ? after.version : 0,
    display: after ? displayOf(after, ev) : '',
    warning: parsed.warning || '',
  };
  onceRemember(d, p.clientUuid, 'result.set', response);
  return response;
}, { action: 'result.set', auditTarget: (p) => 'reg:' + (p.regId || p.athleteId) });

function displayOf(r, ev) {
  if (!r) return '';
  if (r.dnf) return P.DNF_LABEL;
  if (r.foul) return P.FOUL_LABEL;
  return P.formatResult(r.value, ev.kind);
}

/** 批量写成绩：一次事务、只推一次大屏、只涨一个版本号（现场"整组一起录"很常见） */
def('result.batch', (ctx) => {
  const d = ctx.d, p = ctx.payload, u = ctx.user;
  const items = Array.isArray(p.items) ? p.items : [];
  if (!items.length) fail('没有要提交的成绩');
  const results = [];
  for (const it of items) {
    try {
      const r = OPS['result.set'].fn(Object.assign({}, ctx, { payload: it }));
      results.push(Object.assign({ ok: true }, r));
    } catch (err) {
      results.push({
        ok: false, code: err.code || 'OP_FAILED', error: err.message,
        detail: err.detail || null,
        eventId: it.eventId, regId: it.regId, attempt: it.attempt || 1,
      });
    }
  }
  void u;
  const okCount = results.filter(r => r.ok).length;
  return { total: items.length, ok: okCount, failed: items.length - okCount, results };
}, { action: 'result.batch' });

def('result.clear', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const reg = mustRow(d, 'registration', p.regId, '报名记录');
  const n = d.run('DELETE FROM result WHERE regId = ?', [reg.id]).changes;
  bumpRev(d, reg.meetId);
  return { removed: n };
}, { action: 'result.clear' });

/** 把一个项目的成绩全部清空（重录整场用；危险操作，前端要二次确认） */
def('result.clearEvent', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const ev = mustRow(d, 'event', p.eventId, '项目');
  const n = d.run('DELETE FROM result WHERE eventId = ?', [ev.id]).changes;
  bumpRev(d, ev.meetId);
  return { removed: n };
}, { action: 'result.clearEvent' });

/* ── 自动录取（预赛 → 决赛） ──────────────────────────────────────────── */

def('event.autoAdvance', (ctx) => {
  const d = ctx.d, p = ctx.payload, u = ctx.user;
  const ev = mustRow(d, 'event', p.eventId, '项目');
  if (ev.stage === 'final') fail('决赛本身不能再录取下一个阶段');
  const exists = existingFinal(d, ev.id);
  if (exists && !p.force) {
    fail('这个预赛已经生成过决赛「' + exists.name + '」了。要按现在的成绩重做，请先删掉那个决赛。', 'HAS_FINAL');
  }
  if (exists && p.force) {
    // 重做：把旧决赛连同它的报名与成绩一起删掉
    d.run('DELETE FROM result WHERE eventId = ?', [exists.id]);
    d.run('DELETE FROM checkin WHERE eventId = ?', [exists.id]);
    d.run('DELETE FROM checkinState WHERE eventId = ?', [exists.id]);
    d.run('DELETE FROM registration WHERE eventId = ?', [exists.id]);
    d.run('DELETE FROM event WHERE id = ?', [exists.id]);
  }
  const out = createFinalFor(d, ev.meetId, ev, u);
  return {
    finalId: out.final.id, finalName: out.final.name,
    qualified: out.qualified, note: out.note, count: out.count,
  };
}, { action: 'event.autoAdvance' });

/* ── 手动录取决赛（现场口径：谁进决赛由老师定，系统不自己录）──────────────
 *
 * 【为什么要有这个】原来只有 `event.autoAdvance`：点一下系统就按预赛名次
 * 把前 N 名自动报进决赛。但现场情况常有例外 ——
 *   · 某个学生预赛跑完有事先走了，不该进决赛
 *   · 有人预赛发挥失常但实力强，教练要让他进
 *   · 接力换人
 * 自动录出来的名单还得一条条删，反而更慢。
 *
 * 所以现在拆成两步：
 *   ① 这一步：只**建出决赛项目**（空的，名单不填）
 *   ② 老师在「名单」里把该进的人挑进去
 * 决赛名次照旧只按决赛成绩算，不会把预赛成绩带进来。
 *
 * 注意 `advanceFromId` 还是要写上：它表示"这个决赛是从那个预赛来的"，
 * 用来看关联、避免重复生成。
 */
def('event.makeFinal', (ctx) => {
  const d = ctx.d, p = ctx.payload, u = ctx.user;
  const ev = mustRow(d, 'event', p.eventId, '项目');
  if (ev.stage === 'final') fail('决赛本身不能再生成下一个阶段');

  const exists = existingFinal(d, ev.id);
  if (exists && !p.force) {
    fail('这个预赛已经生成过决赛「' + exists.name + '」了。'
      + '要重做请先删掉那个决赛，或勾选"重做"。', 'HAS_FINAL');
  }
  if (exists && p.force) {
    /* 重做前必须确认那个决赛还没录成绩 —— 录了就删，等于把现场干过的活抹掉。
       这种情况让老师自己去删（或者先把成绩导出来），不替他决定。 */
    const n = d.get('SELECT COUNT(*) c FROM result WHERE eventId = ?', [exists.id]).c;
    if (n > 0) {
      fail('决赛「' + exists.name + '」已经录了 ' + n + ' 条成绩，'
        + '重做会把这些成绩一起删掉。请先到「成绩与名次」里清空它，或改名保留。', 'HAS_RESULT');
    }
    d.run('DELETE FROM checkin WHERE eventId = ?', [exists.id]);
    d.run('DELETE FROM checkinState WHERE eventId = ?', [exists.id]);
    d.run('DELETE FROM registration WHERE eventId = ?', [exists.id]);
    d.run('DELETE FROM event WHERE id = ?', [exists.id]);
  }

  const now = nowIso();
  const id = makeId('ev');
  const count = Number(ev.advanceCount) || 6;
  /* 排在预赛后面：先看有没有别的项目已经占了这个位置，有就顺延 */
  let sort = (ev.sort || 0) + 1;
  while (d.get('SELECT id FROM event WHERE meetId = ? AND sort = ? AND id != ?', [ev.meetId, sort, id])) sort++;

  d.run(`INSERT INTO event(id, meetId, name, groupId, kind, stage, isRelay, relayLegs, day,
            startAt, endAt, venue, status, statusMode, attempts, tol, unit,
            advanceFromId, advanceCount, sort, createdAt, updatedAt)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    id, ev.meetId, finalNameFor(ev.name), ev.groupId, ev.kind, 'final',
    ev.isRelay, ev.relayLegs, ev.day,
    null, null, ev.venue, 'pending', 'auto',
    ev.attempts, ev.tol, ev.unit,
    ev.id, count, sort, now, now,
  ]);

  /* 【要不要预填前 N 名】现场口径是"名单手动挑"，但**空名单**其实更费事：
     老师还得自己一个个把 6 个人加进去。所以默认**预填前 N 名当起点**，
     老师在「名单」页删掉不该进的、补上该进的 —— 几个人而已，比从零加 6 个快。

     预填只是建议，不是定论：名次照旧只按**决赛**成绩算，预赛成绩不会带进来。
     `prefill: false` 就建成完全空的。 */
  let prefillNote = '';
  let qualified = 0;
  if (p.prefill !== false) {
    const ctx2 = Board.load(d, ev.meetId);
    const heatNow = d.get('SELECT * FROM event WHERE id = ?', [ev.id]);
    const board = Board.eventBoard(ctx2, heatNow);
    const q = S.qualifiers(board.board.rows, count);
    let lane = 1;
    for (const r of q.rows) {
      const reg = d.get('SELECT * FROM registration WHERE id = ?', [r.regId]);
      if (!reg) continue;
      d.run(`INSERT INTO registration(id, meetId, eventId, athleteId, classId, teamName, legsJson, lane, sort, createdAt, updatedAt)
             VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [
        makeId('rg'), ev.meetId, id, reg.athleteId, reg.classId, reg.teamName, reg.legsJson,
        lane, lane, now, now,
      ]);
      lane++;
    }
    qualified = q.rows.length;
    prefillNote = q.expandNote;
  }

  bumpRev(d, ev.meetId);
  const finalEv = d.get('SELECT * FROM event WHERE id = ?', [id]);
  return {
    finalId: finalEv.id, finalName: finalEv.name,
    count: count, replaced: !!exists,
    qualified: qualified, note: prefillNote,
    byName: userName(u),
  };
}, { action: 'event.makeFinal' });

/* ── 检录 ─────────────────────────────────────────────────────────────── */

/** 检录必须先"开始检录"：没开始就不许标记到场（现场口径：先开检录再点名） */
function requireCheckinOpen(d, ev) {
  const st = d.get('SELECT * FROM checkinState WHERE eventId = ?', [ev.id]);
  if (!st || !st.open) {
    fail('这个项目还没开始检录。请先点「开始检录」，再标记到场。', 'CHECKIN_CLOSED');
  }
  return st;
}

def('checkin.open', (ctx) => {
  const d = ctx.d, p = ctx.payload, u = ctx.user;
  const ev = mustRow(d, 'event', p.eventId, '项目');
  const now = nowIso();
  const st = d.get('SELECT * FROM checkinState WHERE eventId = ?', [ev.id]);
  if (st) {
    d.run('UPDATE checkinState SET open = 1, startedAt = ?, byUserId = ?, byName = ? WHERE eventId = ?',
      [now, u ? u.id : null, userName(u), ev.id]);
  } else {
    d.run('INSERT INTO checkinState(eventId, open, startedAt, byUserId, byName) VALUES(?,?,?,?,?)',
      [ev.id, 1, now, u ? u.id : null, userName(u)]);
  }
  // 开始检录就把项目状态推到"检录中"（除非已结束）
  if (ev.status !== 'done') {
    d.run('UPDATE event SET status = ?, updatedAt = ? WHERE id = ?', ['checking', now, ev.id]);
  }
  announceCheckin(d, ev.meetId, ev, true, u);
  bumpRev(d, ev.meetId);
  return { eventId: ev.id, open: true, status: ev.status === 'done' ? 'done' : 'checking' };
}, { action: 'checkin.open' });

def('checkin.close', (ctx) => {
  const d = ctx.d, p = ctx.payload, u = ctx.user;
  const ev = mustRow(d, 'event', p.eventId, '项目');
  const st = d.get('SELECT * FROM checkinState WHERE eventId = ?', [ev.id]);
  if (st) d.run('UPDATE checkinState SET open = 0, stoppedAt = ? WHERE eventId = ?', [nowIso(), ev.id]);
  // 停止检录：如果还是"检录中"且人已到齐，就直接进"进行中"；否则退回"未开始"
  const fresh = d.get('SELECT * FROM event WHERE id = ?', [ev.id]);
  let live = false;
  if (fresh.status === 'checking') {
    live = autoLiveIfAllArrived(d, fresh);
    if (!live) {
      d.run('UPDATE event SET status = ?, updatedAt = ? WHERE id = ?', ['pending', nowIso(), ev.id]);
    }
  }
  announceCheckin(d, ev.meetId, ev, false, u);
  bumpRev(d, ev.meetId);
  return { eventId: ev.id, open: false, live };
}, { action: 'checkin.close' });

def('checkin.mark', (ctx) => {
  const d = ctx.d, p = ctx.payload, u = ctx.user;
  const reg = mustRow(d, 'registration', p.regId, '报名记录');
  const ev = mustRow(d, 'event', reg.eventId, '项目');
  requireCheckinOpen(d, ev);
  const arrived = p.arrived === false || p.arrived === 0 ? 0 : 1;
  const exist = d.get('SELECT * FROM checkin WHERE eventId = ? AND regId = ?', [ev.id, reg.id]);
  const now = nowIso();
  if (exist) {
    d.run('UPDATE checkin SET arrived = ?, at = ?, byUserId = ?, byName = ? WHERE id = ?',
      [arrived, now, u ? u.id : null, userName(u), exist.id]);
  } else {
    d.run('INSERT INTO checkin(id, eventId, regId, arrived, at, byUserId, byName) VALUES(?,?,?,?,?,?,?)',
      [makeId('ck'), ev.id, reg.id, arrived, now, u ? u.id : null, userName(u)]);
  }
  // 人齐了 → 项目自动转"进行中"
  const live = arrived ? autoLiveIfAllArrived(d, d.get('SELECT * FROM event WHERE id = ?', [ev.id])) : false;
  bumpRev(d, ev.meetId);
  return { regId: reg.id, arrived: !!arrived, live };
}, { action: 'checkin.mark' });

/** 一键"全部已到/全部未到"（现场点名点烦了用） */
def('checkin.all', (ctx) => {
  const d = ctx.d, p = ctx.payload, u = ctx.user;
  const ev = mustRow(d, 'event', p.eventId, '项目');
  requireCheckinOpen(d, ev);          // 同样要先开始检录
  const arrived = p.arrived === false || p.arrived === 0 ? 0 : 1;
  const regs = d.all('SELECT id FROM registration WHERE eventId = ?', [ev.id]);
  const now = nowIso();
  for (const r of regs) {
    const exist = d.get('SELECT id FROM checkin WHERE eventId = ? AND regId = ?', [ev.id, r.id]);
    if (exist) d.run('UPDATE checkin SET arrived = ?, at = ?, byUserId = ?, byName = ? WHERE id = ?',
      [arrived, now, u ? u.id : null, userName(u), exist.id]);
    else d.run('INSERT INTO checkin(id, eventId, regId, arrived, at, byUserId, byName) VALUES(?,?,?,?,?,?,?)',
      [makeId('ck'), ev.id, r.id, arrived, now, u ? u.id : null, userName(u)]);
  }
  // 一键全到 → 直接进"进行中"
  const live = arrived ? autoLiveIfAllArrived(d, d.get('SELECT * FROM event WHERE id = ?', [ev.id])) : false;
  bumpRev(d, ev.meetId);
  return { eventId: ev.id, count: regs.length, arrived: !!arrived, live };
}, { action: 'checkin.all' });

/* ── 公告 ─────────────────────────────────────────────────────────────── */

def('notice.add', (ctx) => {
  const d = ctx.d, p = ctx.payload, u = ctx.user;
  const meet = meetOf(d, ctx.meetId);
  const text = str(p.text, 500);
  if (!text) fail('公告内容不能为空');
  const level = p.level === 'important' ? 'important' : 'normal';
  const until = level === 'important'
    ? (p.until ? String(p.until) : new Date(Date.now() + (num(p.durationMin, 10) * 60000)).toISOString())
    : null;
  const id = makeId('nt');
  d.run(`INSERT INTO notice(id, meetId, text, level, until, pinned, eventId, auto, byUserId, byName, createdAt)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [
    id, meet.id, text, level, until, p.pinned ? 1 : 0, null, 0,
    u ? u.id : null, userName(u), nowIso(),
  ]);
  bumpRev(d, meet.id);
  return { id, until };
}, { action: 'notice.add' });

def('notice.update', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const n = mustRow(d, 'notice', p.id, '公告');
  d.run('UPDATE notice SET text = ?, level = ?, until = ?, pinned = ? WHERE id = ?', [
    p.text === undefined ? n.text : (str(p.text, 500) || n.text),
    p.level === undefined ? n.level : (p.level === 'important' ? 'important' : 'normal'),
    p.until === undefined ? n.until : orNull(p.until),
    p.pinned === undefined ? n.pinned : (p.pinned ? 1 : 0),
    n.id,
  ]);
  bumpRev(d, n.meetId);
  return { id: n.id };
}, { action: 'notice.update' });

def('notice.del', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const n = mustRow(d, 'notice', p.id, '公告');
  d.run('DELETE FROM notice WHERE id = ?', [n.id]);
  bumpRev(d, n.meetId);
  return { id: n.id };
}, { action: 'notice.del' });

/* ── 聊天室 ───────────────────────────────────────────────────────────── */

def('chat.send', (ctx) => {
  const d = ctx.d, p = ctx.payload, u = ctx.user;
  const meet = meetOf(d, ctx.meetId);
  /* 消息类型：语音（audio）已经去掉 —— 浏览器要求麦克风跑在安全上下文里，
     现场是 http://192.168.x.x，手机上根本用不了（见 public/admin-misc.js 的注释）。
     这里也一并拒掉，免得老客户端或手写请求还能塞进来。 */
  const kind = ['text', 'image', 'system'].indexOf(p.kind) >= 0 ? p.kind : 'text';
  const text = str(p.text, 1000);
  if (!text && !p.attachId) fail('消息不能为空');
  const id = makeId('cm');
  d.run(`INSERT INTO chatMessage(id, meetId, userId, userName, role, text, kind, attachId, clientUuid, deleted, createdAt)
         VALUES(?,?,?,?,?,?,?,?,?,0,?)`, [
    id, meet.id, u ? u.id : null, userName(u), u ? u.role : null,
    text, kind, p.attachId ? String(p.attachId) : null, p.clientUuid || null, nowIso(),
  ]);
  const out = { id, text, kind, attachId: p.attachId || null, userName: userName(u), createdAt: nowIso() };
  onceRemember(d, p.clientUuid, 'chat.send', out);
  // 聊天不进大屏，不需要 bumpRev（否则大屏白重绘一次）
  return out;
}, { action: 'chat.send', noBump: true });

def('chat.delete', (ctx) => {
  const d = ctx.d, p = ctx.payload, u = ctx.user;
  const m = mustRow(d, 'chatMessage', p.id, '消息');
  if (u && u.role !== 'admin' && m.userId !== u.id) {
    fail('只能撤回自己发的消息（管理员可以撤回任何人的）', 'FORBIDDEN');
  }
  d.run('UPDATE chatMessage SET deleted = 1 WHERE id = ?', [m.id]);
  return { id: m.id };
}, { action: 'chat.delete', noBump: true });

/* ── 账号 ─────────────────────────────────────────────────────────────── */

const auth = require('./auth');

def('user.add', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const username = str(p.username, 40).toLowerCase();
  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) fail('账号只能用 3-40 位小写字母、数字、下划线、点或横线');
  const strength = auth.checkPasswordStrength(p.password);
  if (strength) fail(strength);
  if (d.get('SELECT id FROM user WHERE username = ?', [username])) fail('这个账号已经存在了');
  const role = auth.ROLES.indexOf(p.role) >= 0 ? p.role : 'operator';
  const ph = auth.hashPassword(p.password);
  const id = makeId('u');
  const now = nowIso();
  d.run(`INSERT INTO user(id, username, displayName, role, pwdSalt, pwdHash, disabled, createdAt, updatedAt)
         VALUES(?,?,?,?,?,?,0,?,?)`,
    [id, username, str(p.displayName, 40) || username, role, ph.salt, ph.hash, now, now]);
  return { id, username, role };
}, { action: 'user.add' });

def('user.update', (ctx) => {
  const d = ctx.d, p = ctx.payload, u = ctx.user;
  const target = mustRow(d, 'user', p.id, '账号');
  const role = auth.ROLES.indexOf(p.role) >= 0 ? p.role : target.role;
  const disabled = p.disabled === undefined ? target.disabled : (p.disabled ? 1 : 0);

  // 不能把最后一个管理员降级或停用（否则谁也进不去后台了）
  if (target.role === 'admin' && (role !== 'admin' || disabled)) {
    const admins = d.get("SELECT COUNT(*) AS c FROM user WHERE role = 'admin' AND disabled = 0").c;
    if (admins <= 1) fail('这是最后一个可用的管理员，不能降级或停用。请先加一个管理员。', 'LAST_ADMIN');
  }
  d.run('UPDATE user SET displayName = ?, role = ?, disabled = ?, updatedAt = ? WHERE id = ?', [
    p.displayName === undefined ? target.displayName : (str(p.displayName, 40) || target.displayName),
    role, disabled, nowIso(), target.id,
  ]);
  if (disabled || role !== target.role) auth.destroyUserSessions(d, target.id);
  void u;
  return { id: target.id, role, disabled: !!disabled };
}, { action: 'user.update' });

def('me.pwd', (ctx) => {
  const d = ctx.d, p = ctx.payload, u = ctx.user;
  if (!u) fail('请先登录', 'UNAUTHORIZED');
  const full = mustRow(d, 'user', u.id, '账号');
  const ph = auth.hashPassword(p.oldPassword, full.pwdSalt);
  if (!auth.safeEqual(ph.hash, full.pwdHash)) fail('原口令不对');
  const strength = auth.checkPasswordStrength(p.newPassword);
  if (strength) fail(strength);
  auth.setPassword(d, u.id, p.newPassword);
  auth.destroyUserSessions(d, u.id);   // 改完要重新登录（安全考虑）
  return { ok: true };
}, { action: 'me.pwd' });

def('user.pwd', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const target = mustRow(d, 'user', p.id, '账号');
  const strength = auth.checkPasswordStrength(p.newPassword);
  if (strength) fail(strength);
  auth.setPassword(d, target.id, p.newPassword);
  return { id: target.id };
}, { action: 'user.pwd' });

def('user.del', (ctx) => {
  const d = ctx.d, p = ctx.payload, u = ctx.user;
  const target = mustRow(d, 'user', p.id, '账号');
  if (u && target.id === u.id) fail('不能删掉自己正在用的账号');
  if (target.role === 'admin') {
    const admins = d.get("SELECT COUNT(*) AS c FROM user WHERE role = 'admin' AND disabled = 0").c;
    if (admins <= 1) fail('这是最后一个可用的管理员，不能删除', 'LAST_ADMIN');
  }
  auth.destroyUserSessions(d, target.id);
  d.run('DELETE FROM user WHERE id = ?', [target.id]);
  return { id: target.id };
}, { action: 'user.del' });

/* ── 危险操作：清空数据 / 载入演示 ────────────────────────────────────── */

/**
 * 清空本届的全部比赛数据。
 * scope='results' 只清成绩（赛前重来一遍最常用）
 * scope='events'  清成绩 + 报名 + 项目（保留运动员名单）
 * scope='all'     连运动员、班级、公告一起清（换一届运动会）
 */
def('data.clear', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  const meet = meetOf(d, ctx.meetId);
  const scope = ['results', 'events', 'all'].indexOf(p.scope) >= 0 ? p.scope : 'results';
  if (p.confirmText !== '清空') {
    fail('危险操作：请在确认框里输入「清空」两个字', 'NEED_CONFIRM');
  }
  const out = { scope, results: 0, regs: 0, events: 0, athletes: 0 };

  out.results = d.run('DELETE FROM result WHERE meetId = ?', [meet.id]).changes || 0;
  d.run('DELETE FROM checkin WHERE eventId IN (SELECT id FROM event WHERE meetId = ?)', [meet.id]);
  d.run('DELETE FROM checkinState WHERE eventId IN (SELECT id FROM event WHERE meetId = ?)', [meet.id]);

  if (scope === 'events' || scope === 'all') {
    out.regs = d.run('DELETE FROM registration WHERE meetId = ?', [meet.id]).changes || 0;
    out.events = d.run('DELETE FROM event WHERE meetId = ?', [meet.id]).changes || 0;
  }
  if (scope === 'all') {
    out.athletes = d.run('DELETE FROM athlete WHERE meetId = ?', [meet.id]).changes || 0;
    d.run('DELETE FROM classDef WHERE meetId = ?', [meet.id]);
    d.run('DELETE FROM notice WHERE meetId = ?', [meet.id]);
    d.run('DELETE FROM chatMessage WHERE meetId = ?', [meet.id]);
  }
  d.run('DELETE FROM stagedOp WHERE meetId = ?', [meet.id]);
  d.run('DELETE FROM idempotency');
  bumpRev(d, meet.id);
  return out;
}, { action: 'data.clear' });

/** 载入演示数据（给老师试功能用；会把现有数据整体换掉） */
def('data.demo', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  if (p.confirmText !== '演示') {
    fail('这个操作会**替换掉现有的全部数据**。请在确认框里输入「演示」两个字。', 'NEED_CONFIRM');
  }
  const seed = require('./seed');
  const info = seed.seedDemo(d, { reset: true });
  const meet = meetOf(d, null);
  bumpRev(d, meet.id);
  return info;
}, { action: 'data.demo' });

/* ── 备份记录 ─────────────────────────────────────────────────────────── */

def('backup.note', (ctx) => {
  const d = ctx.d, p = ctx.payload;
  d.run('INSERT INTO backupLog(id, fileName, reason, size, byName, createdAt) VALUES(?,?,?,?,?,?)', [
    makeId('bk'), str(p.fileName, 200) || 'unknown', str(p.reason, 40) || 'manual',
    num(p.size, 0), userName(ctx.user), nowIso(),
  ]);
  return { ok: true };
}, { action: 'backup.create', noBump: true });

/* ══════════════════════════════════════════════════════════════════════
 * 暂存 / 预览 / 确认（后台"改完先看着，最后一次确认"）
 * ══════════════════════════════════════════════════════════════════════ */

/** 版本号：确认时用它做乐观锁，发现"暂存期间别人也改了" */
function revOf(d, meetId) {
  const m = d.get('SELECT rev FROM meet WHERE id = ?', [meetId]);
  return m ? Number(m.rev) : 0;
}

/** 给暂存项起个中文名字（给老师看"待确认 3 项"里都是什么） */
function labelOf(op, payload) {
  const name = payload && (payload.name || payload.text || payload.title);
  const short = name ? ('「' + str(name, 24) + '」') : '';
  const map = {
    'athlete.add': '新增运动员', 'athlete.update': '修改运动员', 'athlete.del': '删除运动员',
    'athlete.block': '屏蔽/取消屏蔽运动员',
    'athlete.import': '导入名单',
    'event.add': '新增项目', 'event.update': '修改项目', 'event.del': '删除项目',
    'event.move': '调整项目顺序', 'event.status': '手动切换项目状态', 'event.statusAuto': '恢复自动状态',
    'event.autoAdvance': '自动录取决赛',
    'event.makeFinal': '生成决赛（名单手动挑）',
    'reg.add': '加入名单', 'reg.del': '移出名单', 'reg.update': '修改报名', 'reg.legs': '填写接力队员',
    'result.set': '录入成绩', 'result.batch': '批量录入成绩', 'result.clear': '清空某人成绩',
    'result.clearEvent': '清空项目成绩',
    'notice.add': '发布公告', 'notice.update': '修改公告', 'notice.del': '删除公告',
    'meet.update': '修改运动会信息', 'meet.rule': '修改计分规则', 'meet.screen': '修改大屏设置',
    'group.add': '新增组别', 'group.update': '修改组别', 'group.del': '删除组别',
    'class.add': '新增班级',
    'checkin.open': '开始检录', 'checkin.close': '停止检录', 'checkin.mark': '检录点名',
    'checkin.all': '检录全选', 'user.add': '新增账号', 'user.update': '修改账号',
    'user.pwd': '重置口令', 'user.del': '删除账号',
    'data.demo': '载入演示数据', 'data.clear': '清空数据',
  };
  return (map[op] || op) + short;
}

/** 暂存一条（不落正式数据） */
/**
 * 暂存一条改动。
 *
 * 【谁能暂存】只有**管理员**走"暂存 + 确认"：
 *   · 管理员：改完先攒在暂存区，确认后统一推送落盘（可以预览、可以放弃）
 *   · 操作员/只读：编排类改动**直接生效**（现场操作员就是干活的，让他再去找人确认很别扭）
 *   `direct:true` 的指令（成绩/检录/聊天/自己改口令）对谁都直接生效 ——
 *   现场多人实时协同，走暂存会互相打架。
 */
function stage(ctx) {
  const d = ctx.d, p = ctx.payload || {};
  const meet = meetOf(d, ctx.meetId);
  ensureOnceTable(d);
  const op = String(p.op || '');
  if (!OPS[op]) fail('不认识的指令：' + op, 'UNKNOWN_OP');

  // 成绩录入与检录**不进暂存**：现场是多人实时协同，走"暂存+确认"会互相打架。
  const direct = ['result.set', 'result.batch', 'result.clear', 'result.clearEvent',
    'checkin.open', 'checkin.close', 'checkin.mark', 'checkin.all',
    'chat.send', 'chat.delete', 'me.pwd'];
  if (direct.indexOf(op) >= 0) {
    // 注意：clientUuid 要原样带进 payload —— 幂等去重靠它，
    // 丢了的话"断网重发/重复点击"就会录成两条（踩过一次）。
    return {
      direct: true,
      out: execute({
        d, op, user: ctx.user, meetId: meet.id,
        payload: Object.assign({}, p.payload || {}, p.clientUuid ? { clientUuid: p.clientUuid } : {}),
        clientUuid: p.clientUuid, source: ctx.source, ip: ctx.ip,
      }),
    };
  }

  // 非管理员：直接执行（不再需要"确认修改并推送大屏"这一步）
  const role = ctx.user && ctx.user.role;
  if (role !== 'admin') {
    const out = execute({
      d, op, user: ctx.user, meetId: meet.id,
      payload: Object.assign({}, p.payload || {}, p.clientUuid ? { clientUuid: p.clientUuid } : {}),
      clientUuid: p.clientUuid, source: ctx.source, ip: ctx.ip,
    });
    return { direct: true, applied: true, out, label: labelOf(op, p.payload) };
  }

  const seq = d.get('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM stagedOp WHERE meetId = ?', [meet.id]).s;
  const id = makeId('st');
  /* 暂存时把目标记录的字段快照一起存下来 —— 确认时靠它发现
     "暂存之后别人又改了同一条"。没有这一步，确认会静默覆盖别人的改动。 */
  const snap = stageSnapshot(d, op, p.payload);
  d.run(`INSERT INTO stagedOp(id, meetId, seq, op, payloadJson, label, baseVersion, baseSnapshot, byUserId, byName, createdAt)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [
    id, meet.id, seq, op, JSON.stringify(p.payload || {}), labelOf(op, p.payload),
    String(p.baseVersion === undefined ? revOf(d, meet.id) : p.baseVersion),
    snap ? JSON.stringify(snap) : null,
    ctx.user ? ctx.user.id : null, userName(ctx.user), nowIso(),
  ]);
  return { id, seq, label: labelOf(op, p.payload) };
}

function listStaged(d, meetId) {
  return d.all('SELECT * FROM stagedOp WHERE meetId = ? ORDER BY seq', [meetId]).map(r => ({
    id: r.id, seq: r.seq, op: r.op, label: r.label,
    payload: (() => { try { return JSON.parse(r.payloadJson); } catch (e) { return null; } })(),
    baseSnapshot: (() => { try { return r.baseSnapshot ? JSON.parse(r.baseSnapshot) : null; } catch (e) { return null; } })(),
    byName: r.byName, createdAt: r.createdAt,
  }));
}

/* ══════════════════════════════════════════════════════════════════════
 * 暂存 → 确认 的冲突检测
 *
 * 【要解决的问题】暂存的意思是"我先记下来，等会儿统一确认"。
 * 但暂存和确认之间可能有别人改了同一条记录：
 *     甲暂存"把张三改名叫 张三丰" → 乙直接把张三改成了 张三疯 → 甲点确认
 * 原来的实现会**静默**把名字改回"张三丰"，乙的改动没了、还没有任何提示。
 * 代码里注释写着"逐条乐观锁"，但 baseVersion 只写不读 —— 等于没做。
 *
 * 【为什么按目标记录比对、而不是按整届版本号】
 * 整届版本号 rev 只要有人录一条成绩就会变。用它判冲突的话，
 * 现场几十个人同时录入时，每一批暂存确认都会报"冲突"，根本没法用。
 * 必须只看**这条指令要改的那几个字段**有没有被别人动过。
 *
 * 【只比"这条指令要改的字段"】甲改姓名、乙改号码，两者不该互相冲突。
 * ══════════════════════════════════════════════════════════════════════ */

/** 指令改的是哪张表、用 payload 里哪个字段找目标记录 */
const STAGE_ENTITY = {
  'athlete.add': { table: 'athlete', by: 'id' },
  'athlete.update': { table: 'athlete', by: 'id' },
  'athlete.del': { table: 'athlete', by: 'id' },
  'athlete.block': { table: 'athlete', by: 'id' },
  'event.add': { table: 'event', by: 'id' },
  'event.update': { table: 'event', by: 'id' },
  'event.del': { table: 'event', by: 'id' },
  'event.status': { table: 'event', by: 'id' },
  'group.add': { table: 'groupDef', by: 'id' },
  'group.update': { table: 'groupDef', by: 'id' },
  'group.del': { table: 'groupDef', by: 'id' },
  'class.add': { table: 'classDef', by: 'id' },
  'class.update': { table: 'classDef', by: 'id' },
  'class.del': { table: 'classDef', by: 'id' },
  'notice.del': { table: 'notice', by: 'id' },
  'reg.del': { table: 'registration', by: 'id' },
};

/** 这些 payload 字段不是"记录内容"，比对时要排除（改了它们不算别人动过记录） */
const NON_FIELD_KEYS = ['id', 'meetId', 'clientUuid', 'force', 'baseVersion', 'op', 'seq'];

/**
 * 暂存时：把目标记录里**这条指令会改到的字段**存一份。
 * @returns {object|null} 形如 { table, key, fields: { name: '张三', bib: '001' } }
 */
function stageSnapshot(d, op, payload) {
  const spec = STAGE_ENTITY[op];
  const p = payload || {};
  if (!spec) return null;
  const key = p[spec.by];
  if (!key) return null;                     // add 类指令暂存时还没有 id → 不存快照
  const row = d.get('SELECT * FROM ' + spec.table + ' WHERE ' + spec.by + ' = ?', [key]);
  if (!row) return null;                     // 记录已经不在了 → 确认时按"已消失"处理
  const fields = {};
  Object.keys(p).forEach((k) => {
    if (NON_FIELD_KEYS.indexOf(k) >= 0) return;
    if (SECRET_FIELDS.indexOf(k) >= 0) { fields[k] = '(敏感字段)'; return; }
    // 只记"这条指令要改的字段"当前是什么值
    fields[k] = row[k] === undefined ? null : row[k];
  });
  if (!Object.keys(fields).length) return null;
  return { table: spec.table, key: key, fields: fields };
}

/**
 * 确认前：检查这条暂存指令要改的字段，有没有在暂存之后被别人改过。
 * @returns {object|null} 有冲突时返回冲突详情，没冲突返回 null
 */
function stageConflict(d, item) {
  const spec = STAGE_ENTITY[item.op];
  if (!spec || !item.baseSnapshot) return null;
  const snap = item.baseSnapshot;
  const row = d.get('SELECT * FROM ' + snap.table + ' WHERE ' + spec.by + ' = ?', [snap.key]);
  if (!row) {
    return {
      kind: 'gone', table: snap.table, key: snap.key,
      staged: snap.fields, current: null,
      message: '这条记录已经被删掉了',
    };
  }
  const changed = [];
  Object.keys(snap.fields).forEach((k) => {
    const was = snap.fields[k];
    const now = row[k] === undefined ? null : row[k];
    if (String(was === null ? '' : was) !== String(now === null ? '' : now)) {
      changed.push({ field: k, staged: was, current: now, want: (item.payload || {})[k] });
    }
  });
  if (!changed.length) return null;
  return {
    kind: 'changed', table: snap.table, key: snap.key,
    changed: changed,
    byName: row.updatedAt ? (row.byName || '') : '',
    message: '暂存之后这条记录被别人改过：' + changed.map(c =>
      fieldLabel(c.field) + '「' + fmtAuditVal(c.staged) + '」→「' + fmtAuditVal(c.current) + '」').join('；')
      + '。你暂存的是想改成「'
      + changed.map(c => fmtAuditVal(c.want)).join('、') + '」',
  };
}

const FIELD_LABELS = {
  name: '名称', bib: '号码', grade: '年级', className: '班级', team: '队伍',
  groupId: '组别', kind: '类型', stage: '阶段', attempts: '试跳次数', tol: '并列容差',
  venue: '场地', startAt: '开始时间', endAt: '结束时间', unit: '单位',
  advanceCount: '录取人数', relayLegs: '接力人数', day: '比赛日', sort: '顺序',
  status: '状态', text: '内容', level: '级别', pinned: '置顶', durationMin: '滚动时长',
  label: '标签', displayName: '显示名', role: '角色', disabled: '停用',
  passHash: '口令', gender: '性别', note: '备注',
};
function fieldLabel(k) { return FIELD_LABELS[k] || k; }

function unstage(d, meetId, id) {
  const r = d.run('DELETE FROM stagedOp WHERE meetId = ? AND id = ?', [meetId, id]);
  return { removed: r.changes || 0 };
}

function clearStaged(d, meetId) {
  const r = d.run('DELETE FROM stagedOp WHERE meetId = ?', [meetId]);
  return { removed: r.changes || 0 };
}

/** 在一个库（可能是预览副本）上顺序执行一批暂存指令 */
function applyStaged(d, meetId, items, user) {
  const out = [];
  for (const it of items) {
    const spec = OPS[it.op];
    if (!spec) { out.push({ id: it.id, ok: false, error: '不认识的指令：' + it.op }); continue; }
    try {
      const res = spec.fn({
        d, user, meetId, payload: it.payload || {}, source: 'admin', staging: true,
      });
      out.push({ id: it.id, ok: true, op: it.op, label: it.label, result: res });
    } catch (err) {
      out.push({
        id: it.id, ok: false, op: it.op, label: it.label,
        code: err.code || 'OP_FAILED', error: err.message, detail: err.detail || null,
      });
    }
  }
  return out;
}

/**
 * 预览：把暂存指令在**数据副本**上跑一遍，返回"确认后会变成什么样"。
 * 关键：绝不能在真实库上试跑。这里用 cloneForPreview（复制文件后另开一个库），
 * 中途抛异常也只影响副本。
 */
function preview(opts) {
  const d = opts.d, meetId = opts.meetId, user = opts.user;
  const items = listStaged(d, meetId);
  if (!items.length) {
    return {
      empty: true,
      staged: [],
      snapshot: Board.adminSnapshot(d, meetId),
      screen: Board.screenSnapshot(d, meetId),
    };
  }
  const copy = cloneForPreview(d);
  try {
    const results = applyStaged(copy, meetId, items, user);
    const boards = Board.allBoards(Board.load(copy, meetId));
    void boards;
    return {
      empty: false,
      results,
      failed: results.filter(r => !r.ok),
      // 暂存之后被别人改过的那些：界面上要显眼地提示"确认后会覆盖掉别人的改动"
      conflicts: conflictsOf(d, items),
      staged: items,
      snapshot: Board.adminSnapshot(copy, meetId),
      screen: Board.screenSnapshot(copy, meetId),
    };
  } finally {
    destroyPreview(copy);
  }
}

/** 把暂存列表里"目标记录已被别人改过"的都挑出来（给界面提示用，不抛错） */
function conflictsOf(d, items) {
  const out = [];
  for (const it of items) {
    const c = stageConflict(d, it);
    if (c) out.push(Object.assign({ id: it.id, op: it.op, label: it.label, byName: it.byName }, c));
  }
  return out;
}

/**
 * 统一确认：把暂存区里的改动一次性落盘 + 推送大屏。
 * · 全部在一个事务里：任何一条失败就整体回滚（绝不半成品）
 * · **逐条比字段**：暂存时目标记录的字段值 vs 现在的值，不一致就整体拒绝并说清是谁改的
 *
 * 【为什么要拒绝而不是"跳过冲突项"】冲突时跳过会导致"确认了 8 条、2 条没生效"，
 * 而操作者以为全生效了 —— 现场没人会去数。宁可整体拒绝、把冲突列清楚，
 * 让人明确决定（撤掉那几条，或者明确选择覆盖）。
 */
function confirm(opts) {
  const d = opts.d, meetId = opts.meetId, user = opts.user;
  const items = listStaged(d, meetId);
  if (!items.length) return { applied: 0, empty: true };

  // 0) 冲突检查：暂存之后别人改过同一条 → 拒绝并说清（除非明确 force）
  if (!opts.force) {
    const conflicts = conflictsOf(d, items);
    if (conflicts.length) {
      return {
        applied: 0, conflicts,
        error: '有 ' + conflicts.length + ' 项改动在暂存之后被别人改过，已整体取消（数据没有被改动）。'
          + '请先看一下冲突内容：可以撤掉那几条，或者明确选择「仍然按暂存的值覆盖」。',
      };
    }
  }

  // 1) 先在副本上试跑一遍，把"会失败的"提前挑出来，避免真实库白跑一趟
  const copy = cloneForPreview(d);
  let trial;
  try {
    trial = applyStaged(copy, meetId, items, user);
  } finally {
    destroyPreview(copy);
  }
  const failed = trial.filter(r => !r.ok);
  if (failed.length) {
    return {
      applied: 0, failed,
      error: '有 ' + failed.length + ' 项改动现在无法生效，已整体取消（数据没有被改动）。请查看下面的原因：',
    };
  }

  // 2) 真正落盘：单事务 + 逐条写审计（谁确认的、每条从什么变成什么）
  const applied = d.tx(() => {
    const before = items.map(it => ({
      it,
      snap: (() => {
        const spec = STAGE_ENTITY[it.op];
        const key = spec && (it.payload || {})[spec.by];
        return key ? d.get('SELECT * FROM ' + spec.table + ' WHERE ' + spec.by + ' = ?', [key]) : null;
      })(),
    }));
    const out = applyStaged(d, meetId, items, user);
    const bad = out.filter(r => !r.ok);
    if (bad.length) {
      const e = new OpError('确认时出错，已整体回滚', 'CONFIRM_FAILED', bad);
      throw e;
    }
    // 逐项审计：确认是"一批改动同时生效"，必须能查到每一项的前后值
    before.forEach((b, i) => {
      const res = out[i] || {};
      const spec = STAGE_ENTITY[b.it.op];
      let after = null;
      if (spec) {
        const key = (b.it.payload || {})[spec.by] || (res.result && res.result.id);
        if (key) after = d.get('SELECT * FROM ' + spec.table + ' WHERE ' + spec.by + ' = ?', [key]) || null;
      }
      try {
        d.run(`INSERT INTO auditLog(id, meetId, userId, userName, action, target, beforeJson, afterJson, detail, ip, createdAt)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [
          makeId('au'), meetId, user ? user.id : null,
          user ? (user.displayName || user.username) : null,
          'staged.confirm', 'staged:' + b.it.id,
          b.snap ? JSON.stringify(scrubSecret(b.snap)) : null,
          after ? JSON.stringify(scrubSecret(after)) : null,
          '确认暂存改动：' + (b.it.label || b.it.op),
          opts.ip || '', nowIso(),
        ]);
      } catch (e2) { /* 审计失败不影响确认 */ }
    });
    d.run('DELETE FROM stagedOp WHERE meetId = ?', [meetId]);
    return out;
  });

  return { applied: applied.length, results: applied, rev: revOf(d, meetId) };
}

/* ══════════════════════════════════════════════════════════════════════
 * 统一入口
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 执行一条指令。
 * @param {object} ctx { d, user, payload, op, meetId, source, ip }
 * @returns {object} 给前端的结果
 */
/* ══════════════════════════════════════════════════════════════════════
 * 业务审计（每一次改动都留痕）
 *
 * 【为什么要在这里统一做】审计散落在各个指令里，早晚会漏 ——
 * 实测确认过：通过 /api/op 改运动员，auditLog 一行都没写。
 * 结果是成绩有争议时查不出"谁在什么时候把 12.34 改成了 12.35"。
 *
 * 【做法】在 execute()/executeBatch() 这一层包一圈：
 *   执行前  读一次目标记录 → beforeJson
 *   执行后  再读一次       → afterJson
 *   两者不同才写一条审计（没变就不写，免得刷屏）
 * 目标表由 auditTarget/审计目标表决定（见 AUDIT_ENTITY）。
 *
 * 【脱敏】密码类字段只记"改过"，绝不记原值 —— 审计表是要给人看的。
 * ══════════════════════════════════════════════════════════════════════ */

/** 哪些指令改的是哪张表、用哪个字段找目标记录 */
const AUDIT_ENTITY = {
  'result.set': { table: 'result', by: 'regId', extra: 'attempt' },
  'result.del': { table: 'result', by: 'id' },
  'result.clearAttempt': { table: 'result', by: 'regId', extra: 'attempt' },
  'checkin.mark': { table: 'checkin', by: 'regId' },
  'checkin.open': { table: 'checkinState', by: 'eventId' },
  'checkin.close': { table: 'checkinState', by: 'eventId' },
  'athlete.add': { table: 'athlete', by: 'id' },
  'athlete.update': { table: 'athlete', by: 'id' },
  'athlete.del': { table: 'athlete', by: 'id' },
  'athlete.block': { table: 'athlete', by: 'id' },
  'event.add': { table: 'event', by: 'id' },
  'event.update': { table: 'event', by: 'id' },
  'event.del': { table: 'event', by: 'id' },
  'event.status': { table: 'event', by: 'id' },
  'group.add': { table: 'groupDef', by: 'id' },
  'group.update': { table: 'groupDef', by: 'id' },
  'group.del': { table: 'groupDef', by: 'id' },
  'class.add': { table: 'classDef', by: 'id' },
  'class.update': { table: 'classDef', by: 'id' },
  'class.del': { table: 'classDef', by: 'id' },
  'notice.add': { table: 'notice', by: 'id' },
  'notice.update': { table: 'notice', by: 'id' },
  'notice.del': { table: 'notice', by: 'id' },
  'user.add': { table: 'user', by: 'id', secret: true },
  'user.update': { table: 'user', by: 'id', secret: true },
  'user.del': { table: 'user', by: 'id', secret: true },
  'reg.add': { table: 'registration', by: 'id' },
  'reg.del': { table: 'registration', by: 'id' },
};

/** 敏感字段：只记"改过"，不记值 */
const SECRET_FIELDS = ['password', 'pwdHash', 'pwdSalt', 'token', 'secret', 'csrf'];

function scrubSecret(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  Object.keys(obj).forEach((k) => {
    if (SECRET_FIELDS.indexOf(k) >= 0) { out[k] = '(已改，不记录)'; return; }
    out[k] = obj[k];
  });
  return out;
}

/** 读一条记录当前的样子（找不到就返回 null，代表"本来不存在"） */
function auditBefore(d, op, payload, out) {
  const spec = AUDIT_ENTITY[op];
  if (!spec) return null;
  const p = payload || {};
  // 新增类指令：目标是执行后才有的 id
  const id = p[spec.by] || (out && out.id) || (out && out[spec.by]) || '';
  if (!id) return null;
  const row = d.get('SELECT * FROM ' + spec.table + ' WHERE ' + spec.by + ' = ?', [id]);
  return row ? { table: spec.table, key: id, row: scrubSecret(row) } : null;
}

/** 把这一次改动写进审计表。前后一样就不写。 */
function auditWrite(d, ctx, op, payload, before, out) {
  if (ctx.noAudit) return;
  const spec = AUDIT_ENTITY[op];
  if (!spec) return;
  const p = payload || {};
  const id = p[spec.by] || (out && out.id) || (out && out[spec.by]) || '';
  let after = null;
  if (id) {
    const row = d.get('SELECT * FROM ' + spec.table + ' WHERE ' + spec.by + ' = ?', [id]);
    after = row ? scrubSecret(row) : null;
  }
  const b = before ? before.row : null;
  // 没有实质变化就不写（比如"设成同一个值"）
  if (b && after && JSON.stringify(b) === JSON.stringify(after)) return;
  if (!b && !after) return;

  const meet = ctx.meetId || '';
  const user = ctx.user || {};
  const action = 'op.' + op;
  const target = spec.table + ':' + (id || '?');
  const detail = describeChange(op, b, after, p);
  try {
    d.run(`INSERT INTO auditLog(id, meetId, userId, userName, action, target, beforeJson, afterJson, detail, ip, createdAt)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [
      makeId('au'), meet, user.id || null, user.displayName || user.username || null,
      action, target,
      b ? JSON.stringify(b) : null,
      after ? JSON.stringify(after) : null,
      detail, ctx.ip || '', nowIso(),
    ]);
  } catch (e) {
    /* 审计写失败**不能**让业务操作失败 —— 现场录成绩比留痕重要。
       但要记一笔到日志，否则审计悄悄坏了没人知道。 */
    try { console.error('[审计] 写入失败（业务操作已成功）：' + (e && e.message)); } catch (e2) { /* ignore */ }
  }
}

/** 给审计记录写一句人话说明：哪个字段从什么变成什么 */
function describeChange(op, b, after, payload) {
  if (!b && after) return labelOf(op, payload) + '：新建';
  if (b && !after) return labelOf(op, payload) + '：删除';
  if (!b || !after) return labelOf(op, payload);
  const diffs = [];
  const keys = Object.keys(after);
  for (const k of keys) {
    if (SECRET_FIELDS.indexOf(k) >= 0) { if (b[k] !== after[k]) diffs.push(k + ' 有改动'); continue; }
    if (String(b[k]) !== String(after[k])) {
      diffs.push(k + '：' + fmtAuditVal(b[k]) + ' → ' + fmtAuditVal(after[k]));
    }
  }
  if (!diffs.length) return labelOf(op, payload);
  return labelOf(op, payload) + '　' + diffs.slice(0, 8).join('；');
}

function fmtAuditVal(v) {
  if (v === null || v === undefined || v === '') return '（空）';
  const s = String(v);
  return s.length > 40 ? (s.slice(0, 40) + '…') : s;
}

function execute(ctx) {
  const d = ctx.d;
  const op = String(ctx.op || ctx.payload && ctx.payload.op || '');
  const spec = OPS[op];
  if (!spec) fail('不认识的指令：' + op, 'UNKNOWN_OP');

  ensureOnceTable(d);

  // 幂等：同一个 clientUuid 只生效一次（断网补交、重复点击都会命中这里）
  const clientUuid = ctx.clientUuid || (ctx.payload && ctx.payload.clientUuid) || '';
  if (clientUuid) {
    const hit = onceLookup(d, clientUuid);
    if (hit) return Object.assign({ idempotent: true }, hit);
  }

  const meet = meetOf(d, ctx.meetId);
  const action = spec.action || op;
  if (ctx.user && !auth.can(ctx.user.role, action)) {
    fail('你的账号（' + (auth.ROLE_LABEL[ctx.user.role] || ctx.user.role) + '）没有权限做这个操作：' + labelOf(op, ctx.payload),
      'FORBIDDEN');
  }

  return d.tx(() => {
    // 审计：改动前先看一眼前值（同一个事务里读，避免中间被别人改）
    const before = auditBefore(d, op, ctx.payload, null);
    const out = spec.fn(Object.assign({}, ctx, { op, meetId: meet.id }));
    auditWrite(d, Object.assign({}, ctx, { meetId: meet.id }), op, ctx.payload, before, out);
    if (!spec.noBump && op !== 'event.tick') bumpRev(d, meet.id);
    if (clientUuid) onceRemember(d, clientUuid, op, out);
    return out;
  });
}

/** 批量执行（一次事务、只推一次大屏） */
function executeBatch(ctx) {
  const items = Array.isArray(ctx.items) ? ctx.items : [];
  if (!items.length) fail('没有要提交的改动');
  const d = ctx.d;
  ensureOnceTable(d);
  const meet = meetOf(d, ctx.meetId);
  const results = [];

  d.tx(() => {
    for (const it of items) {
      const op = String(it.op || '');
      const spec = OPS[op];
      if (!spec) { results.push({ ok: false, op, error: '不认识的指令：' + op }); continue; }
      const action = spec.action || op;
      if (ctx.user && !auth.can(ctx.user.role, action)) {
        results.push({ ok: false, op, code: 'FORBIDDEN', error: '没有权限：' + labelOf(op, it.payload) });
        continue;
      }
      const uuid = it.clientUuid || (it.payload && it.payload.clientUuid) || '';
      if (uuid) {
        const hit = onceLookup(d, uuid);
        if (hit) { results.push(Object.assign({ ok: true, op, idempotent: true }, hit)); continue; }
      }
      try {
        // 审计：批量里的每一条也要留痕（成绩批量录入走的就是这里）
        const before = auditBefore(d, op, it.payload, null);
        const out = spec.fn(Object.assign({}, ctx, {
          op, payload: it.payload || {}, meetId: meet.id, clientUuid: uuid,
        }));
        auditWrite(d, Object.assign({}, ctx, { meetId: meet.id }), op, it.payload, before, out);
        if (uuid) onceRemember(d, uuid, op, out);
        results.push(Object.assign({ ok: true, op }, out));
      } catch (err) {
        results.push({
          ok: false, op, code: err.code || 'OP_FAILED',
          error: err.message, detail: err.detail || null,
        });
      }
    }
    const okAny = results.some(r => r.ok);
    if (okAny) bumpRev(d, meet.id);
  });

  return { total: items.length, ok: results.filter(r => r.ok).length, results };
}

module.exports = {
  OP_NAMES: Object.keys(OPS).map(k => OPS[k]),
  OPS, execute, executeBatch, stage, listStaged, unstage, clearStaged,
  preview, confirm, revOf, labelOf, ensureOnceTable,
  autoStatus, tickAll, announceCheckin, createFinalFor, ensureClass, groupIdOrFirst,
  groupFromGrade,
  autoLiveIfAllArrived,
  // 名单导入的表头识别：前端"看看能认出哪些列"与服务端导入共用同一套规则，
  // 保证"预览说认得、实际导入也认得"（两边各写一套早晚会不一致）
  mapHeaders, normHeader, HDR,
  OpError, fail, conflict,
};
