'use strict';
/**
 * scoreboard.js —— 把库里的数据组装成前端要用的快照
 *
 * 原则：
 *  · 名次、计分、班级总分**只在服务端算一次**，大屏/后台/录入页/成绩单都用同一份口径，
 *    避免"大屏显示第 2，后台显示第 3"这种现场最难解释的问题。
 *  · 大屏需要的字段尽量在这里裁剪好（大屏是免登录的，别把账号、备份这些带出去）。
 */

const S = require('./scoring');
const { formatResult, DNF_LABEL, FOUL_LABEL } = require('./parse');
const { STATUS_LABEL, STATUS_TONE } = require('./status');
// 这 4 个在 sortAthletes() 等处仍在用 —— 删 import 前务必核实用量，
// 少一个就会在运行时报 "xxx is not defined"（曾把 zhCompare 漏掉，预览接口直接 500）。
const {
  nowIso, fmtLocal, classLabel, gradeRank, classRank, zhCompare, safeFilePart,
} = require('./util');

/* ══════════════════════════════════════════════════════════════════════
 * 基础装载：把常用表一次性读进内存（本项目规模小，一次性装载最简单可靠）
 * ══════════════════════════════════════════════════════════════════════ */

function load(d, meetId) {
  const meet = d.get('SELECT * FROM meet WHERE id = ?', [meetId]);
  if (!meet) throw new Error('找不到这一届运动会的数据');

  const groups = d.all('SELECT * FROM groupDef WHERE meetId = ? ORDER BY sort, name', [meetId]);
  const classes = d.all('SELECT * FROM classDef WHERE meetId = ? ORDER BY sortGrade, sortClass, label', [meetId]);
  const athletes = d.all('SELECT * FROM athlete WHERE meetId = ?', [meetId]);
  const events = d.all('SELECT * FROM event WHERE meetId = ? ORDER BY sort, id', [meetId]);
  const regs = d.all('SELECT * FROM registration WHERE meetId = ?', [meetId]);
  const results = d.all('SELECT * FROM result WHERE meetId = ? ORDER BY recordedAt', [meetId]);
  const notices = d.all('SELECT * FROM notice WHERE meetId = ? ORDER BY pinned DESC, createdAt DESC', [meetId]);
  const checkinStates = d.all(`SELECT cs.* FROM checkinState cs
                               JOIN event e ON e.id = cs.eventId
                               WHERE e.meetId = ?`, [meetId]);
  const checks = d.all(`SELECT c.* FROM checkin c
                        JOIN event e ON e.id = c.eventId
                        WHERE e.meetId = ?`, [meetId]);
  const rule = S.ruleFromMeet(meet);

  const groupById = new Map(groups.map(g => [g.id, g]));
  const classById = new Map(classes.map(c => [c.id, c]));
  const athleteById = new Map(athletes.map(a => [a.id, a]));
  const eventById = new Map(events.map(e => [e.id, e]));

  // regId → 该报名的所有成绩行
  const rowsByReg = new Map();
  for (const r of results) {
    if (!rowsByReg.has(r.regId)) rowsByReg.set(r.regId, []);
    rowsByReg.get(r.regId).push(r);
  }
  // eventId → 该项目的报名
  const regsByEvent = new Map();
  for (const r of regs) {
    if (!regsByEvent.has(r.eventId)) regsByEvent.set(r.eventId, []);
    regsByEvent.get(r.eventId).push(r);
  }
  // eventId → 检录状态
  const checkStateByEvent = new Map(checkinStates.map(c => [c.eventId, c]));
  const checkByEvent = new Map();
  for (const c of checks) {
    if (!checkByEvent.has(c.eventId)) checkByEvent.set(c.eventId, new Map());
    checkByEvent.get(c.eventId).set(c.regId, c);
  }
  // 预赛 → 决赛 的映射（决赛的 advanceFromId 指向预赛）
  const finalsOf = new Map();
  for (const e of events) {
    if (e.advanceFromId) finalsOf.set(e.advanceFromId, e.id);
  }

  return {
    meet, groups, classes, athletes, events, regs, results, notices, rule,
    groupById, classById, athleteById, eventById,
    rowsByReg, regsByEvent, checkStateByEvent, checkByEvent, finalsOf,
  };
}

/** 运动员显示名（找不到就返回空，绝不抛错） */
function athleteName(ctx, entry) {
  const a = entry.athleteId ? ctx.athleteById.get(entry.athleteId) : null;
  return a ? a.name : (entry.name || entry.teamName || '');
}

/** 号码 */
function athleteBib(ctx, entry) {
  const a = entry.athleteId ? ctx.athleteById.get(entry.athleteId) : null;
  return a && a.bib ? String(a.bib) : '';
}

/** 单位（大屏"班级/单位"列显示的字） */
function athleteTeam(ctx, entry) {
  const a = entry.athleteId ? ctx.athleteById.get(entry.athleteId) : null;
  if (!a) return entry.teamName || '';
  if (a.team) return a.team;
  const g = a.grade || '', c = a.className || '';
  if (g || c) return classLabel(g, c);
  const cls = a.classId ? ctx.classById.get(a.classId) : null;
  return cls ? cls.label : '';
}

/* ══════════════════════════════════════════════════════════════════════
 * 单个项目的榜
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 算一个项目的完整成绩板：谁报了名、录了几次、最好成绩、名次、得分、检录状态。
 * @returns {{event, board:{rows,groups}, entries, checkin}}
 */
function eventBoard(ctx, event) {
  const regs = (ctx.regsByEvent.get(event.id) || []).slice();
  const checkMap = ctx.checkByEvent.get(event.id) || new Map();
  const state = ctx.checkStateByEvent.get(event.id) || null;

  // 排序：报名顺序 → 道次 → 号码（名单稳定，现场按顺序念）
  regs.sort((a, b) =>
    (a.sort || 0) - (b.sort || 0)
    || (numOr(a.lane, 999) - numOr(b.lane, 999))
    || zhCompare(athleteBib(ctx, a), athleteBib(ctx, b))
    || zhCompare(athleteName(ctx, a), athleteName(ctx, b)));

  const entries = regs.map((reg) => {
    const rows = ctx.rowsByReg.get(reg.id) || [];
    const best = S.bestOf(reg, rows, event);
    const ck = checkMap.get(reg.id);
    /* 运动员是否被"屏蔽"（见 ops.js 的 athlete.block）。
       屏蔽 = 人还在库里、还能录成绩，但**成绩展示页不展示他**。
       接力报名没有 athleteId，天然是"未屏蔽"。 */
    const ath = reg.athleteId ? ctx.athleteById.get(reg.athleteId) : null;
    return Object.assign(best, {
      regId: reg.id,
      /* athleteId：录入页的「屏蔽」按钮要它（athlete.block 按运动员 id 操作）。
         接力报名没有 athleteId（整队一条），所以是 null —— 前端据此不显示屏蔽按钮。 */
      athleteId: reg.athleteId || null,
      blocked: !!(ath && ath.blocked),
      lane: reg.lane === null || reg.lane === undefined ? null : reg.lane,
      sort: reg.sort || 0,
      name: athleteName(ctx, reg),
      bib: athleteBib(ctx, reg),
      team: athleteTeam(ctx, reg),
      className: (reg.classId && ctx.classById.get(reg.classId))
        ? ctx.classById.get(reg.classId).className : '',
      grade: (reg.classId && ctx.classById.get(reg.classId))
        ? ctx.classById.get(reg.classId).grade : '',
      arrived: !!(ck && ck.arrived),
      attemptsRaw: rows.map(r => ({
        attempt: r.attempt,
        value: r.value,
        // display：给人看的（用于成绩板/大屏/打印）
        display: r.dnf ? DNF_LABEL : (r.foul ? FOUL_LABEL : formatResult(r.value, event.kind)),
        // editText：**回填到录入框里的文字**。前端别自己拼这个字符串 ——
        // 之前 admin-entry / admin-results / print 各写一份 `dnf ? 弃权 : foul ? 犯规 : ...`，
        // 漏一处就显示错（犯规被显示成弃权就是这么来的）。统一由这里给。
        editText: r.dnf ? DNF_LABEL : (r.foul ? FOUL_LABEL : (r.raw || formatResult(r.value, event.kind))),
        dnf: !!r.dnf, foul: !!r.foul, raw: r.raw || '',
        version: r.version, id: r.id,
      })),
    });
  });

  /* ★ 排名只喂"没被屏蔽的"。
     【为什么在这里拦】`entries` 要给**录入页**用（被屏蔽的人还得能改成绩、
     还能取消屏蔽），所以不能把人从 entries 里删掉；但**名次榜**必须只看没屏蔽的。
     把过滤放在 rankEntries 之前，分数、名次、大屏、成绩与名次页、打印单
     就全都自动一致了 —— 只改这一处，不会漏。
     名次会按剩下的人重排（第 3 名被屏蔽，原来第 4 名就变第 3 名）。 */
  const visible = entries.filter(e => !e.blocked);
  const board = S.rankEntries(visible, event, ctx.rule, {
    nameOf: (e) => e.name,
    bibOf: (e) => e.bib,
  });

  const arrived = entries.filter(e => e.arrived).length;
  return {
    event,
    entries,
    blocked: entries.filter(e => e.blocked).length,
    board,
    checkin: {
      open: !!(state && state.open),
      total: entries.length,
      arrived,
      startedAt: state ? state.startedAt : null,
      people: entries.map(e => ({
        regId: e.regId, lane: e.lane, bib: e.bib, name: e.name, team: e.team,
        legs: e.legs, arrived: e.arrived,
      })),
    },
  };
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 一次算完所有项目的榜（大屏和总分榜都要用，别重复算） */
function allBoards(ctx) {
  const map = new Map();
  for (const ev of ctx.events) map.set(ev.id, eventBoard(ctx, ev));
  return map;
}

/* ══════════════════════════════════════════════════════════════════════
 * 大屏快照
 * ══════════════════════════════════════════════════════════════════════ */

/** 项目在榜上显示的一行（名次行） */
function rowForScreen(ctx, row) {
  return {
    rank: row.rank,
    bib: row.bib || '',
    name: row.isRelay ? (row.teamName || row.name || '') : row.name,
    team: row.isRelay ? '' : (row.team || ''),
    // 接力：小字列出本班参赛的 4 名队员
    relay: !!row.isRelay,
    legs: row.isRelay ? (row.legs || []) : [],
    value: row.best,
    display: row.display || formatResult(row.best, row.kind),
    dnf: !!row.dnf,
    kind: row.kind,
    regId: row.regId,
  };
}

/** 项目卡片的小标题：组别 · 预赛/决赛 · 场地 · 时间 */
function eventMeta(ctx, ev) {
  const parts = [];
  const g = ctx.groupById.get(ev.groupId);
  if (g) parts.push(g.name);
  if (ev.stage === 'heat') parts.push('预赛');
  else if (ev.stage === 'final') parts.push('决赛');
  if (ev.isRelay) parts.push(ev.relayLegs ? (ev.relayLegs + '×' + '接力') : '接力');
  if (ev.venue) parts.push(ev.venue);
  if (ev.startAt) parts.push(fmtLocal(ev.startAt, false));
  return parts.join(' · ');
}

/** 一个项目在大屏上的卡片数据 */
function eventCardData(ctx, board) {
  const ev = board.event;
  const rows = board.board.rows.map(r => rowForScreen(ctx, r));
  const finished = ev.status === 'done';
  // 没结束的项目：只显示已录到的名次（现场实时看）；结束的项目：完整名次
  const limit = finished ? rows.length : rows.length;
  /* 【成绩要不要展示】录全了才展示名次。
   *
   * 现场要的是"别把没录完的名次挂出去" —— 一个项目 20 个人只录了 3 个，
   * 名次榜上那 3 个人是第 1/2/3 名，看着像最终结果，其实是半成品。
   * 大屏上一挂出来，观众和老师就会当成定局。
   *
   * `recorded` = 已录到成绩的人数，`total` = 报名人数。
   * `dnfCount` 也算"录过了"（弃权是要人工点出来的，属于已处理）。
   * 另外：如果这个项目**本来就是空的**（没人报名），也当"没什么可展示的"。
   */
  const recorded = board.entries.filter(e => e.attempts > 0).length;
  const total = board.entries.length;
  const resultsReady = total > 0 && recorded >= total;
  return {
    id: ev.id,
    name: ev.name,
    status: ev.status,
    kind: ev.kind,
    stage: ev.stage,
    isRelay: !!ev.isRelay,
    meta: eventMeta(ctx, ev),
    startAt: ev.startAt,
    endAt: ev.endAt,
    recorded: recorded,
    total: total,
    /* 大屏据此决定"展示名次"还是"显示录入进度" */
    resultsReady: resultsReady,
    rows: rows.slice(0, limit),
    dnfCount: rows.filter(r => r.dnf).length,
  };
}

/** 大屏：班级总分面板（增量与全量共用同一段代码，避免两处口径漂移） */
function screenTeamPanel(totals) {
  return totals.teams.map(t => ({
    key: t.key, classId: t.classId, name: t.name,
    grade: t.grade || '', className: t.className || '',
    points: t.points, rank: t.rank, classRank: t.classRank,
    gold: t.gold, silver: t.silver, bronze: t.bronze,
  }));
}

/** 后台：班级总分面板 */
function adminTeamPanel(totals) {
  return totals.teams.map(t => ({
    key: t.key, name: t.name, grade: t.grade, points: t.points,
    rank: t.rank, classRank: t.classRank,
    gold: t.gold, silver: t.silver, bronze: t.bronze, details: t.details,
  }));
}

/**
 * 大屏快照。
 * panels.live  = 进行中的项目（现场最关心）
 * panels.done  = 已结束的项目（名次榜）
 * panels.team  = 班级总分榜（按班级累计名次分）
 * panels.notice= 公告
 * panels.checkin = 正在检录的项目
 */
function screenSnapshot(d, meetId) {
  const ctx = load(d, meetId);
  const boards = allBoards(ctx);

  const liveEvents = ctx.events.filter(e => e.status === 'live');
  const doneEvents = ctx.events.filter(e => e.status === 'done');
  // "检录中"也算未开始（还没比赛），所以统计时并进 pending，另外单独给一个 checking 数
  const checkingEvents = ctx.events.filter(e => e.status === 'checking');
  const pendingEvents = ctx.events.filter(e => e.status === 'pending' || e.status === 'checking');

  // 计分与班级总分
  const totals = S.teamTotals({
    events: ctx.events,
    boardByEvent: boards,
    rule: ctx.rule,
    classById: ctx.classById,
    athleteName: (e) => athleteName(ctx, e),
    finalsOf: new Map(Array.from(ctx.finalsOf.entries()).map(([heat, fin]) => [heat, fin])),
  });

  // 检录栏：正在检录的优先，其次是状态是"进行中"但还没检录完的
  const checkinCards = ctx.events
    .filter(e => {
      const st = ctx.checkStateByEvent.get(e.id);
      return (st && st.open) || e.status === 'live';
    })
    .sort((a, b) => {
      const oa = ctx.checkStateByEvent.get(a.id), ob = ctx.checkStateByEvent.get(b.id);
      return ((ob && ob.open) ? 1 : 0) - ((oa && oa.open) ? 1 : 0)
        || (a.sort || 0) - (b.sort || 0);
    })
    .map(e => {
      const b = boards.get(e.id);
      return {
        id: e.id, name: e.name, status: e.status, open: b.checkin.open,
        total: b.checkin.total, arrived: b.checkin.arrived,
        people: b.checkin.people,
      };
    });

  const snap = {
    kind: 'screen',
    rev: Number(meetRev(ctx.meet)),
    at: nowIso(),
    meet: {
      id: ctx.meet.id, name: ctx.meet.name, subtitle: ctx.meet.subtitle,
      host: ctx.meet.host, holdDate: ctx.meet.holdDate,
    },
    screen: parseJson(ctx.meet.screenJson) || {},
    stats: {
      athletes: ctx.athletes.length,
      events: ctx.events.length,
      results: ctx.results.length,
      live: liveEvents.length, done: doneEvents.length, pending: pendingEvents.length,
      checking: checkingEvents.length,
    },
    // 状态文案与语气：大屏和后台都从快照里取，不要各自硬写
    // （加了"检录中"之后，后台有、大屏没有，就是因为这里漏了 —— 两处口径必须一致）
    statusLabel: STATUS_LABEL,
    statusTone: STATUS_TONE,
    panels: {
      live: liveEvents.map(e => eventCardData(ctx, boards.get(e.id))),
      done: doneEvents.slice().reverse().map(e => eventCardData(ctx, boards.get(e.id))),
      pending: pendingEvents.map(e => ({
        id: e.id, name: e.name, meta: eventMeta(ctx, e), startAt: e.startAt,
      })),
      notice: ctx.notices.map(n => ({
        id: n.id, text: n.text, level: n.level, until: n.until,
        pinned: !!n.pinned, auto: !!n.auto, createdAt: n.createdAt,
      })),
      team: screenTeamPanel(totals),
      teamMeta: {
        scoredEvents: totals.scoredEvents.length,
        ruleText: totals.ruleText,
        rule: ctx.rule,
      },
      checkin: checkinCards,
    },
  };
  return snap;
}

/* ══════════════════════════════════════════════════════════════════════
 * 后台 / 录入页快照
 * ══════════════════════════════════════════════════════════════════════ */

function meetRev(meet) {
  return parseJson(meet && meet.ruleJson) && meet.rev ? meet.rev : (meet.rev || 1);
}

function parseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

/** 名单：排序 组别 → 年级 → 班级 → 号码 → 姓名（大屏与后台都按这个） */
function sortAthletes(ctx) {
  const groupOrder = new Map(ctx.groups.map(g => [g.id, g.sort || 0]));
  return ctx.athletes.slice().sort((a, b) => {
    const ga = groupOrder.get(a.groupId) || 0, gb = groupOrder.get(b.groupId) || 0;
    if (ga !== gb) return ga - gb;
    const ra = gradeRank(a.grade), rb = gradeRank(b.grade);
    if (ra !== rb) return ra - rb;
    const ca = classRank(a.className), cb = classRank(b.className);
    if (ca !== cb) return ca - cb;
    const ba = a.bib || '', bb = b.bib || '';
    const na = ba === '' ? 1 : 0, nb = bb === '' ? 1 : 0;
    if (na !== nb) return na - nb;
    if (ba !== bb) {
      const x = Number(ba), y = Number(bb);
      if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;
      return zhCompare(ba, bb);
    }
    return zhCompare(a.name, b.name);
  });
}

/** 后台快照：名单 + 项目 + 班级 + 组别 + 统计（不含成绩明细，明细走单项目接口） */
function adminSnapshot(d, meetId) {
  const ctx = load(d, meetId);
  const boards = allBoards(ctx);
  const totals = S.teamTotals({
    events: ctx.events, boardByEvent: boards, rule: ctx.rule,
    classById: ctx.classById, athleteName: (e) => athleteName(ctx, e),
    finalsOf: ctx.finalsOf,
  });

  return {
    kind: 'admin',
    rev: Number(ctx.meet.rev || 1),
    at: nowIso(),
    meet: {
      id: ctx.meet.id, name: ctx.meet.name, subtitle: ctx.meet.subtitle,
      host: ctx.meet.host, holdDate: ctx.meet.holdDate, rule: ctx.rule,
      screen: parseJson(ctx.meet.screenJson) || {},
    },
    groups: ctx.groups.map(g => ({
      id: g.id, name: g.name, sort: g.sort, kind: g.kind,
      /* 带一个"这个组有多少运动员"。
         原来赛程编排页要靠 snap.athletes 自己数（(snap.athletes||[]).filter(...)），
         而名单已经从快照里去掉了（第 3 趟瘦身）—— 所以在这里直接把数算好带过来，
         一个数字替代 209 KB 的名单。 */
      athleteCount: ctx.athletes.filter(a => a.groupId === g.id).length,
    })),
    classes: ctx.classes.map(c => ({
      id: c.id, grade: c.grade, className: c.className, label: c.label,
    })),
    /* 【第 3 趟瘦身】这里**不再带 athletes 数组**。
       它占 209 KB（后台快照 296 KB 的 71%），而每次录成绩/检录都要推一遍。
       名单改由 GET /api/roster 按需拉（支持筛选与分页）。
       注意：stats.athletes（人数）还在，头部显示要用。 */
    events: ctx.events.map(e => {
      const b = boards.get(e.id);
      const fin = e.advanceFromId ? ctx.eventById.get(e.advanceFromId) : null;
      return {
        id: e.id, name: e.name, groupId: e.groupId,
        groupName: (ctx.groupById.get(e.groupId) || {}).name || '',
        kind: e.kind, stage: e.stage, isRelay: !!e.isRelay, relayLegs: e.relayLegs,
        day: e.day, venue: e.venue || '', unit: e.unit || '',
        startAt: e.startAt, endAt: e.endAt,
        status: e.status, statusMode: e.statusMode,
        attempts: e.attempts, tol: e.tol, sort: e.sort,
        advanceFromId: e.advanceFromId || null,
        advanceFromName: fin ? fin.name : '',
        advanceCount: e.advanceCount,
        finalId: ctx.finalsOf.get(e.id) || null,
        finalName: ctx.finalsOf.get(e.id) ? (ctx.eventById.get(ctx.finalsOf.get(e.id)) || {}).name : '',
        regCount: b.entries.length,
        recorded: b.entries.filter(x => x.attempts > 0).length,
        checkinOpen: b.checkin.open,
        arrived: b.checkin.arrived,
        topRows: b.board.rows.slice(0, 3).map(r => ({
          rank: r.rank, name: r.isRelay ? (r.teamName || '') : r.name,
          display: r.display, dnf: !!r.dnf,
        })),
      };
    }),
    notices: ctx.notices.map(n => ({
      id: n.id, text: n.text, level: n.level, until: n.until, pinned: !!n.pinned,
      auto: !!n.auto, createdAt: n.createdAt,
    })),
    team: adminTeamPanel(totals),
    teamMeta: { scoredEvents: totals.scoredEvents.length, ruleText: totals.ruleText },
    stats: {
      athletes: ctx.athletes.length, events: ctx.events.length, results: ctx.results.length,
      live: ctx.events.filter(e => e.status === 'live').length,
      done: ctx.events.filter(e => e.status === 'done').length,
      checking: ctx.events.filter(e => e.status === 'checking').length,
      // "检录中"也算未开始（还没比赛），一起并进 pending
      pending: ctx.events.filter(e => e.status === 'pending' || e.status === 'checking').length,
      classes: ctx.classes.length,
    },
    // 状态文案由服务端统一下发，前端不再各自硬写（加状态时只改 src/status.js 一处）
    statusLabel: STATUS_LABEL,
    statusTone: STATUS_TONE,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 增量推送（第 2 趟改造）
 *
 * 【为什么要有】原来任何一处改动都让服务端重建**整份**快照推给所有客户端：
 * 后台快照 296 KB、生成一次 85~110 ms，而一次录成绩真正变动的只有
 * "一个项目的名次行 + 班级总分"。增量就是只把这几个东西发过去。
 *
 * 【设计原则 —— 宁可退回全量，也不能发错】
 *   1. 增量只覆盖"能精确表达"的改动：成绩 / 检录 / 状态 / 项目结构 / 公告 / 班级总分。
 *      其余（运动员、班级、组别、名单导入、暂存确认…）一律**发全量** ——
 *      它们牵连的派生视图太多，硬做增量出错的风险远大于省下的那点流量。
 *   2. 每条增量都带 `base`（客户端应当已经持有的版本）与 `rev`（新版本）。
 *      客户端发现 base 对不上（漏过消息、刚重连）就**自动退回全量**，
 *      绝不出现"少了一条数据"。
 *   3. 增量与全量用**同一套构造函数**（eventCardData / screenTeamPanel 等），
 *      两边口径不可能漂移。
 * ══════════════════════════════════════════════════════════════════════ */

/** 大屏：只重算受影响项目的卡片。会按当前状态自动落到 live / done / pending 之一 */
function screenPatch(d, meetId, base, eventIds) {
  const ctx = load(d, meetId);
  const boards = allBoards(ctx);
  const totals = S.teamTotals({
    events: ctx.events, boardByEvent: boards, rule: ctx.rule,
    classById: ctx.classById, athleteName: (e) => athleteName(ctx, e),
    finalsOf: ctx.finalsOf,
  });
  const want = {};
  (eventIds || []).forEach((id) => { want[id] = true; });

  const cards = [], pendingCards = [], ids = [];
  ctx.events.forEach((e) => {
    if (!want[e.id]) return;
    ids.push(e.id);
    if (e.status === 'done' || e.status === 'live') cards.push(eventCardData(ctx, boards.get(e.id)));
    else pendingCards.push({ id: e.id, name: e.name, meta: eventMeta(ctx, e), startAt: e.startAt });
  });

  /* 受影响的项目**在全量列表里的位置**。
   *
   * 【为什么要给位置】增量只带"变了的项目"，但列表顺序也会因为它而变 ——
   * 比如一个大屏 pending 列表 [A,B,C]，删掉 B 之后全量变成 [A,C]；
   * 客户端如果把新内容追加到末尾，合并出来就是 [A,B,C] 顺序错了。
   * （这个不一致是测试逐字段比对时抓出来的，肉眼绝对看不出来。）
   *
   * 给出位置后，客户端可以把新条目**放回它在全量里的准确位置**，
   * 合并结果与全量逐字段完全一致。
   */
  // 三个列表的完整顺序（用来算"受影响项目在里面的位置"）
  const liveSeq = ctx.events.filter(e => e.status === 'live').map(e => e.id);
  const doneSeq = ctx.events.filter(e => e.status === 'done').slice().reverse().map(e => e.id);
  const pendSeq = ctx.events.filter(e => e.status === 'pending' || e.status === 'checking').map(e => e.id);
  const posOf = (seq) => {
    const pos = [];
    ids.forEach((id) => {
      const i = seq.indexOf(id);
      if (i >= 0) pos.push(i);
    });
    return pos;
  };

  const checkinCards = ctx.events
    .filter(e => {
      const st = ctx.checkStateByEvent.get(e.id);
      return (st && st.open) || e.status === 'live';
    })
    .sort((a, b) => {
      // 与全量快照**同一个排序**：正在检录的在前，其余按项目顺序。
      // 不排序的话，合并出来的数组顺序会和全量不一样 —— 而"逐字段一致"是验收标准，
      // 也是现场翻页顺序的依据。
      const oa = ctx.checkStateByEvent.get(a.id), ob = ctx.checkStateByEvent.get(b.id);
      return ((ob && ob.open) ? 1 : 0) - ((oa && oa.open) ? 1 : 0) || (a.sort || 0) - (b.sort || 0);
    })
    .map(e => {
      const b = boards.get(e.id);
      return {
        id: e.id, name: e.name, status: e.status, open: b.checkin.open,
        total: b.checkin.total, arrived: b.checkin.arrived, people: b.checkin.people,
      };
    });

  return {
    kind: 'screen',
    base: base,
    rev: Number(ctx.meet.rev || 1),
    at: nowIso(),
    patch: {
      events: cards,                       // 完整卡片（放 live 或 done）
      pending: pendingCards,               // 未开始/检录中的轻量条目
      eventIds: ids,                       // 名单：客户端用它把旧位置上的同 id 条目去掉
      // 每个受影响项目在三个列表里的位置（-1 表示不在那个列表里）
      livePos: posOf(liveSeq),
      donePos: posOf(doneSeq),
      pendingPos: posOf(pendSeq),
      liveLen: liveSeq.length,
      doneLen: doneSeq.length,
      pendingLen: pendSeq.length,
      checkin: checkinCards,
      team: screenTeamPanel(totals),
      teamMeta: {
        scoredEvents: totals.scoredEvents.length,
        ruleText: totals.ruleText,
        rule: ctx.rule,
      },
      /* 公告也要带：**开始/停止检录会自动写一条公告**（ops.js 里就这么设计的）。
         不带的话，大屏底部公告栏会停在旧内容上 —— 测试逐字段比对时抓出来的。 */
      notice: ctx.notices.map(n => ({
        id: n.id, text: n.text, level: n.level, until: n.until,
        pinned: !!n.pinned, auto: !!n.auto, createdAt: n.createdAt,
      })),
      /* 统计数字也要带：大屏右上角显示"已录成绩 N"，清空一个项目后它会变小。
         少带一项就会出现"合并后与全量不一致"（测试抓出来的第二个漏项）。 */
      stats: {
        athletes: ctx.athletes.length,
        events: ctx.events.length,
        results: ctx.results.length,
        live: ctx.events.filter(e => e.status === 'live').length,
        done: ctx.events.filter(e => e.status === 'done').length,
        checking: ctx.events.filter(e => e.status === 'checking').length,
        pending: ctx.events.filter(e => e.status === 'pending' || e.status === 'checking').length,
      },
    },
  };
}

/** 后台：只重算受影响的项目行（含检录人数、前三名等派生字段） */
function adminPatch(d, meetId, base, eventIds) {
  const ctx = load(d, meetId);
  const boards = allBoards(ctx);
  const totals = S.teamTotals({
    events: ctx.events, boardByEvent: boards, rule: ctx.rule,
    classById: ctx.classById, athleteName: (e) => athleteName(ctx, e),
    finalsOf: ctx.finalsOf,
  });
  const want = {};
  (eventIds || []).forEach((id) => { want[id] = true; });

  const rows = [];
  ctx.events.forEach((e) => {
    if (!want[e.id]) return;
    const b = boards.get(e.id);
    const fin = e.advanceFromId ? ctx.eventById.get(e.advanceFromId) : null;
    rows.push({
      id: e.id, name: e.name, groupId: e.groupId,
      groupName: (ctx.groupById.get(e.groupId) || {}).name || '',
      kind: e.kind, stage: e.stage, isRelay: !!e.isRelay, relayLegs: e.relayLegs,
      day: e.day, venue: e.venue || '', unit: e.unit || '',
      startAt: e.startAt, endAt: e.endAt,
      status: e.status, statusMode: e.statusMode,
      attempts: e.attempts, tol: e.tol, sort: e.sort,
      advanceFromId: e.advanceFromId || null,
      advanceFromName: fin ? fin.name : '',
      advanceCount: e.advanceCount,
      finalId: ctx.finalsOf.get(e.id) || null,
      finalName: ctx.finalsOf.get(e.id) ? (ctx.eventById.get(ctx.finalsOf.get(e.id)) || {}).name : '',
      regCount: b.entries.length,
      recorded: b.entries.filter(x => x.attempts > 0).length,
      checkinOpen: b.checkin.open,
      arrived: b.checkin.arrived,
      topRows: b.board.rows.slice(0, 3).map(r => ({
        rank: r.rank, name: r.isRelay ? (r.teamName || '') : r.name,
        display: r.display, dnf: !!r.dnf,
      })),
    });
  });

  return {
    kind: 'admin',
    base: base,
    rev: Number(ctx.meet.rev || 1),
    at: nowIso(),
    patch: {
      events: rows,
      eventIds: rows.map(r => r.id),
      team: adminTeamPanel(totals),
      teamMeta: { scoredEvents: totals.scoredEvents.length, ruleText: totals.ruleText },
      notices: ctx.notices.map(n => ({
        id: n.id, text: n.text, level: n.level, until: n.until, pinned: !!n.pinned,
        auto: !!n.auto, createdAt: n.createdAt,
      })),
      stats: {
        athletes: ctx.athletes.length, events: ctx.events.length, results: ctx.results.length,
        live: ctx.events.filter(e => e.status === 'live').length,
        done: ctx.events.filter(e => e.status === 'done').length,
        checking: ctx.events.filter(e => e.status === 'checking').length,
        pending: ctx.events.filter(e => e.status === 'pending' || e.status === 'checking').length,
        classes: ctx.classes.length,
      },
    },
  };
}

module.exports = {
  load, eventBoard, allBoards, athleteName, athleteBib, athleteTeam, eventMeta,
  eventCardData, screenSnapshot, adminSnapshot, sortAthletes,
  screenPatch, adminPatch,
  parseJson, safeFilePart,
};
