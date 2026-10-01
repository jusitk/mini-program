'use strict';
/**
 * seed.js —— 初始化与演示数据
 *
 * 两个用途：
 *   1. ensureMeet()：库里一届运动会都没有时，建一个空的（否则所有接口都会报"没有数据"，
 *      老师第一次打开会一脸茫然）
 *   2. seedDemo()：生成一整套演示数据（12 个班 / 48 名运动员 / 10 个项目 / 成绩若干），
 *      用来演示大屏效果。**正式比赛前请在后台清空**。
 *
 * 演示数据刻意覆盖了这些容易出问题的场景，方便一眼看出系统算得对不对：
 *   · 一个项目里**并列**（成绩相同 → 名次 1,2,2,4）
 *   · **弃权**（排在最后，显示"弃权"）
 *   · 田赛**三次试跳**（含一次犯规，取最好成绩）
 *   · **4×100 接力**（按班级排名 + 小字列出 4 名队员）
 *   · 预赛**已自动录取**出决赛
 *   · 三种状态都有：未开始 / 进行中 / 已结束
 */

const { makeId, nowIso, gradeRank, classRank } = require('./util');

/** 没有运动会就建一个空的（含默认组别） */
function ensureMeet(d, opts) {
  const exist = d.get('SELECT id FROM meet LIMIT 1');
  if (exist) return exist.id;
  const o = opts || {};
  const now = nowIso();
  const id = makeId('meet');
  d.run(`INSERT INTO meet(id, name, subtitle, host, holdDate, timezone, ruleJson, screenJson,
            isCurrent, archived, rev, createdAt, updatedAt)
          VALUES(?,?,?,?,?,?,?,?,1,0,1,?,?)`, [
    id, o.name || '校运动会', o.subtitle || '实时成绩发布', o.host || '', o.holdDate || '',
    'Asia/Shanghai',
    JSON.stringify({ table: [7, 5, 4, 3, 2, 1], tie: 'full', advanceCount: 6, onlyFinished: true, relayScored: true, relayMultiplier: 2 }),
    JSON.stringify({
      showCheckin: true, mode: 'large', maxColumns: 4,
      rotate: { score: 11, notice: 6, classPoints: 8, checkin: 9 },
    }),
    now, now,
  ]);
  d.run('INSERT INTO groupDef(id, meetId, name, sort, kind) VALUES(?,?,?,?,?)', [makeId('g'), id, '男子组', 1, 'male']);
  d.run('INSERT INTO groupDef(id, meetId, name, sort, kind) VALUES(?,?,?,?,?)', [makeId('g'), id, '女子组', 2, 'female']);
  return id;
}

/* ── 演示数据的素材 ───────────────────────────────────────────────────── */

const SURNAMES = ['张', '王', '李', '赵', '陈', '刘', '杨', '黄', '周', '吴', '徐', '孙', '马', '朱', '胡', '郭'];
const GIVEN_M = ['伟', '强', '磊', '洋', '勇', '军', '杰', '涛', '明', '超', '鹏', '浩', '宇', '晨', '睿', '航'];
const GIVEN_F = ['静', '敏', '丽', '娟', '燕', '艳', '娜', '芳', '婷', '雪', '颖', '琳', '悦', '欣', '怡', '萱'];

const GRADES = ['初一', '初二', '初三', '高一', '高二', '高三'];
const CLASSES = ['1班', '2班'];

/** 用固定种子生成伪随机，保证每次演示数据一样（便于对照截图与测试） */
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 生成演示数据。
 * @param {object} d 数据库
 * @param {object} [opts] { seed, reset }
 */
function seedDemo(d, opts) {
  const o = opts || {};
  const rng = makeRng(o.seed || 20260912);

  // reset：把已有的运动会数据整个清掉再重建（演示要"从头来一遍"的效果）
  // 注意哪些表有 meetId 列：checkin / checkinState / session 这些没有，
  // 它们是挂在 event 上的（外键 ON DELETE CASCADE 会跟着 event 一起走）。
  if (o.reset) {
    const olds = d.all('SELECT id FROM meet');
    const SCOPED = ['result', 'registration', 'notice', 'chatMessage', 'stagedOp',
      'event', 'athlete', 'classDef', 'groupDef', 'upload'];
    for (const m of olds) {
      for (const t of SCOPED) {
        d.run('DELETE FROM ' + t + ' WHERE meetId = ?', [m.id]);
      }
      d.run('DELETE FROM meet WHERE id = ?', [m.id]);
    }
  }

  const meetId = ensureMeet(d, {
    /* 演示数据（tools/seed-fake-meet.js 会用）—— 这里用**通用校名**，
       不带任何真实学校的名字：开源仓库不该出现具体单位信息。 */
    name: '示例中学第 12 届田径运动会',
    subtitle: '实时成绩发布',
    host: '校体育运动委员会',
    holdDate: '2026 年 9 月 24 日 — 25 日',
  });

  const now = nowIso();
  const groups = d.all('SELECT * FROM groupDef WHERE meetId = ? ORDER BY sort', [meetId]);
  const gM = groups.find(g => g.kind === 'male') || groups[0];
  const gF = groups.find(g => g.kind === 'female') || groups[1] || groups[0];

  /* 班级：6 个年级 × 2 个班 = 12 个班 */
  const classes = [];
  GRADES.forEach((grade) => {
    CLASSES.forEach((className) => {
      const id = makeId('cls');
      d.run(`INSERT INTO classDef(id, meetId, grade, className, label, sortGrade, sortClass)
             VALUES(?,?,?,?,?,?,?)`,
        [id, meetId, grade, className, grade + '(' + className + ')', gradeRank(grade), classRank(className)]);
      classes.push({ id, grade, className, label: grade + '(' + className + ')' });
    });
  });

  /* 运动员：12 个班 × 4 人 = 48 人（每班男女各 2，接力正好凑 4 人一队） */
  const athletes = [];
  let bibSeq = 101;
  classes.forEach((cls) => {
    for (let k = 0; k < 4; k++) {
      const male = k < 2;
      const name = SURNAMES[Math.floor(rng() * SURNAMES.length)]
        + (male ? GIVEN_M : GIVEN_F)[Math.floor(rng() * 16)];
      const id = makeId('a');
      const bib = String(bibSeq++);
      d.run(`INSERT INTO athlete(id, meetId, name, groupId, classId, grade, className, team, bib, gender, note, createdAt, updatedAt)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        id, meetId, name, male ? gM.id : gF.id, cls.id, cls.grade, cls.className, cls.label,
        bib, male ? '男' : '女', null, now, now,
      ]);
      athletes.push({ id, name, bib, male, cls, groupId: male ? gM.id : gF.id });
    }
  });

  /* 项目：覆盖三种状态、预赛决赛、田赛试跳、接力 */
  const evDefs = [
    { name: '男子 100 米预赛', groupId: gM.id, kind: 'track', stage: 'heat', status: 'done', startAt: ts(-180), endAt: ts(-120), venue: '田径场', sort: 1, advanceCount: 6 },
    { name: '男子 100 米决赛', groupId: gM.id, kind: 'track', stage: 'final', status: 'done', startAt: ts(-110), endAt: ts(-95), venue: '田径场', sort: 2 },
    { name: '女子 800 米决赛', groupId: gF.id, kind: 'track', stage: 'final', status: 'live', startAt: ts(-15), endAt: ts(10), venue: '田径场', sort: 3 },
    { name: '男子跳远决赛', groupId: gM.id, kind: 'field', stage: 'final', status: 'live', startAt: ts(-20), endAt: ts(15), venue: '田赛区 A', sort: 4, attempts: 3 },
    { name: '女子铅球决赛', groupId: gF.id, kind: 'field', stage: 'final', status: 'done', startAt: ts(-150), endAt: ts(-100), venue: '田赛区 B', sort: 5, attempts: 3 },
    { name: '男子 4×100 米接力决赛', groupId: gM.id, kind: 'track', stage: 'final', status: 'done', startAt: ts(-90), endAt: ts(-70), venue: '田径场', sort: 6, isRelay: true, relayLegs: 4 },
    { name: '女子 4×100 米接力决赛', groupId: gF.id, kind: 'track', stage: 'final', status: 'pending', startAt: ts(40), endAt: ts(60), venue: '田径场', sort: 7, isRelay: true, relayLegs: 4 },
    { name: '女子 100 米预赛', groupId: gF.id, kind: 'track', stage: 'heat', status: 'done', startAt: ts(-170), endAt: ts(-140), venue: '田径场', sort: 8, advanceCount: 6 },
    { name: '女子 100 米决赛', groupId: gF.id, kind: 'track', stage: 'final', status: 'done', startAt: ts(-135), endAt: ts(-125), venue: '田径场', sort: 9 },
    { name: '男子 1500 米决赛', groupId: gM.id, kind: 'track', stage: 'final', status: 'pending', startAt: ts(70), endAt: ts(95), venue: '田径场', sort: 10 },
    { name: '女子跳高决赛', groupId: gF.id, kind: 'field', stage: 'final', status: 'pending', startAt: ts(100), endAt: ts(130), venue: '田赛区 A', sort: 11, attempts: 3 },
  ];

  const events = [];
  for (const def of evDefs) {
    const id = makeId('ev');
    d.run(`INSERT INTO event(id, meetId, name, groupId, kind, stage, isRelay, relayLegs, day,
              startAt, endAt, venue, status, statusMode, attempts, tol, unit,
              advanceFromId, advanceCount, sort, createdAt, updatedAt)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      id, meetId, def.name, def.groupId, def.kind, def.stage,
      def.isRelay ? 1 : 0, def.relayLegs || null, 1,
      def.startAt, def.endAt, def.venue, def.status, 'auto',
      def.kind === 'field' ? (def.attempts || 3) : 1, 0.01, def.kind === 'field' ? '米' : '秒',
      null, def.advanceCount || 6, def.sort, now, now,
    ]);
    events.push(Object.assign({ id }, def));
  }

  const byName = (n) => events.find(e => e.name === n);

  /* 报名 + 成绩 */
  const pool = { m: athletes.filter(a => a.male), f: athletes.filter(a => !a.male) };

  // 预赛：每个单项 12 人（男女各取 12 个），成绩随机但有区分度
  regIndividual(d, meetId, byName('男子 100 米预赛'), pool.m.slice(0, 12), rng, { base: 12.2, spread: 1.6, kind: 'track', dnfIndex: 10 });
  regIndividual(d, meetId, byName('女子 100 米预赛'), pool.f.slice(0, 12), rng, { base: 13.4, spread: 1.8, kind: 'track', dnfIndex: 11, tiePair: true });
  // 决赛：录取前六（成绩比预赛再好一点）
  regIndividual(d, meetId, byName('男子 100 米决赛'), pool.m.slice(0, 6), rng, { base: 12.0, spread: 0.9, kind: 'track', tiePair: true });
  regIndividual(d, meetId, byName('女子 100 米决赛'), pool.f.slice(0, 6), rng, { base: 13.2, spread: 1.0, kind: 'track' });
  // 800 米：进行中，只录了 5 个（现场"边跑边录"的样子）
  regIndividual(d, meetId, byName('女子 800 米决赛'), pool.f.slice(2, 12), rng, { base: 158, spread: 26, kind: 'track', partial: 5 });
  // 跳远：三次试跳（含犯规）
  regIndividual(d, meetId, byName('男子跳远决赛'), pool.m.slice(4, 16), rng, { base: 4.4, spread: 1.5, kind: 'field', attempts: 3, foulAt: 1 });
  // 铅球：三次试跳
  regIndividual(d, meetId, byName('女子铅球决赛'), pool.f.slice(0, 12), rng, { base: 6.2, spread: 3.2, kind: 'field', attempts: 3 });
  // 接力：12 个班各一队（男女各 12 队）
  regRelay(d, meetId, byName('男子 4×100 米接力决赛'), classes, athletes, rng, { base: 51.5, spread: 4.5, male: true });
  regRelay(d, meetId, byName('女子 4×100 米接力决赛'), classes, athletes, rng, { base: 58.0, spread: 5.0, male: false, noResult: true });

  /* 自动录取：男子 100 米预赛 → 决赛的关联（演示"预赛自动录取"的效果） */
  const heat = byName('男子 100 米预赛'), fin = byName('男子 100 米决赛');
  d.run('UPDATE event SET advanceFromId = ? WHERE id = ?', [heat.id, fin.id]);

  /* 公告 */
  const notices = [
    { text: '欢迎参加本届田径运动会　·　各项目成绩以本屏公告为准，颁奖安排请注意现场广播', level: 'normal' },
    { text: '请参加女子 4×100 米接力决赛的各班代表队，提前 15 分钟到检录处集合', level: 'normal' },
    { text: '重要通知：下午 15:30 举行闭幕式，请各班在主席台前集合列队', level: 'important' },
  ];
  for (const n of notices) {
    d.run(`INSERT INTO notice(id, meetId, text, level, until, pinned, eventId, auto, byUserId, byName, createdAt)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [
      makeId('nt'), meetId, n.text, n.level,
      n.level === 'important' ? new Date(Date.now() + 30 * 60000).toISOString() : null,
      0, null, 0, null, '演示数据', now,
    ]);
  }

  /* 检录：给"男子 4×100 接力"开着检录，演示检录栏与自动公告 */
  const relay = byName('男子 4×100 米接力决赛');
  d.run('INSERT INTO checkinState(eventId, open, startedAt, byUserId, byName) VALUES(?,1,?,NULL,?)',
    [relay.id, now, '演示数据']);
  const relayRegs = d.all('SELECT id FROM registration WHERE eventId = ? ORDER BY lane', [relay.id]);
  relayRegs.forEach((r, i) => {
    if (i % 4 === 3) return;    // 留几个"未到"，现场才有得看
    d.run('INSERT INTO checkin(id, eventId, regId, arrived, at, byUserId, byName) VALUES(?,?,?,1,?,NULL,?)',
      [makeId('ck'), relay.id, r.id, now, '演示数据']);
  });
  d.run(`INSERT INTO notice(id, meetId, text, level, until, pinned, eventId, auto, byUserId, byName, createdAt)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [
    makeId('nt'), meetId, relay.name + '　现在开始检录，请运动员到检录处报到',
    'normal', null, 0, relay.id, 1, null, '演示数据', now,
  ]);

  /* 聊天室几条现场对话 */
  const chats = [
    ['终点裁判', '男子 100 米决赛成绩已录完，请核对'],
    ['田赛裁判', '跳远第三次试跳还有人没过，稍等 2 分钟'],
    ['记录员', '女子 800 米正在跑，我在终点准备录'],
  ];
  for (const c of chats) {
    d.run(`INSERT INTO chatMessage(id, meetId, userId, userName, role, text, kind, attachId, clientUuid, deleted, createdAt)
           VALUES(?,?,?,?,?,?,?,?,?,0,?)`,
      [makeId('cm'), meetId, null, c[0], 'operator', c[1], 'text', null, null, now]);
  }

  d.run('UPDATE meet SET rev = rev + 1, updatedAt = ? WHERE id = ?', [now, meetId]);
  return { meetId, athletes: athletes.length, events: events.length, classes: classes.length };
}

/** 相对现在的时间（分钟），转 ISO */
function ts(minutesFromNow) {
  return new Date(Date.now() + minutesFromNow * 60000).toISOString();
}

/**
 * 报名一个个人项目并录成绩。
 * @param {object} cfg { base, spread, kind, attempts, dnfIndex, tiePair, partial, foulAt }
 */
function regIndividual(d, meetId, ev, people, rng, cfg) {
  if (!ev) return;
  const now = nowIso();
  const regs = [];
  people.forEach((a, i) => {
    const id = makeId('rg');
    d.run(`INSERT INTO registration(id, meetId, eventId, athleteId, classId, teamName, legsJson, lane, sort, createdAt, updatedAt)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [id, meetId, ev.id, a.id, a.cls.id, null, null, i + 1, i + 1, now, now]);
    regs.push({ id, a, index: i });
  });

  const limit = cfg.partial ? Math.min(cfg.partial, regs.length) : regs.length;
  regs.slice(0, limit).forEach((r, i) => {
    // 弃权
    if (cfg.dnfIndex !== undefined && i === cfg.dnfIndex) {
      d.run(`INSERT INTO result(id, meetId, eventId, regId, attempt, value, dnf, foul, raw, isBest,
                version, clientUuid, source, byUserId, byName, recordedAt, updatedAt)
             VALUES(?,?,?,?,1,NULL,1,0,?,0,1,NULL,'seed',NULL,?,?,?)`,
        [makeId('r'), meetId, ev.id, r.id, '弃权', '演示数据', now, now]);
      return;
    }
    const attempts = cfg.attempts || 1;
    for (let k = 1; k <= attempts; k++) {
      // 犯规那一次：有记录、没有成绩
      if (cfg.foulAt === k && i % 5 === 3) {
        d.run(`INSERT INTO result(id, meetId, eventId, regId, attempt, value, dnf, foul, raw, isBest,
                  version, clientUuid, source, byUserId, byName, recordedAt, updatedAt)
               VALUES(?,?,?,?,?,NULL,0,1,?,0,1,NULL,'seed',NULL,?,?,?)`,
          [makeId('r'), meetId, ev.id, r.id, k, '犯规', '演示数据', now, now]);
        continue;
      }
      let v;
      if (cfg.kind === 'field') {
        // 田赛：三次试跳，成绩逐渐变好（现场常见）
        v = cfg.base + rng() * cfg.spread + k * 0.08;
      } else {
        v = cfg.base + rng() * cfg.spread + i * 0.02;
      }
      // 并列：让第 2、3 个人成绩完全相同 → 名次 1,2,2,4
      if (cfg.tiePair && (i === 1 || i === 2)) v = round2(cfg.base + 0.3);

      d.run(`INSERT INTO result(id, meetId, eventId, regId, attempt, value, dnf, foul, raw, isBest,
                version, clientUuid, source, byUserId, byName, recordedAt, updatedAt)
             VALUES(?,?,?,?,?,?,0,0,?,?,1,NULL,'seed',NULL,?,?,?)`, [
        makeId('r'), meetId, ev.id, r.id, k, round2(v), String(round2(v)), 0, '演示数据', now, now,
      ]);
    }
    // 标记最好一次
    const rows = d.all('SELECT * FROM result WHERE regId = ? AND value IS NOT NULL ORDER BY value ' + (cfg.kind === 'field' ? 'DESC' : 'ASC') + ' LIMIT 1', [r.id]);
    if (rows.length) d.run('UPDATE result SET isBest = 1 WHERE id = ?', [rows[0].id]);
  });
}

/**
 * 报名一个接力项目：每班一队，4 名队员（取本班运动员姓名）。
 */
function regRelay(d, meetId, ev, classes, athletes, rng, cfg) {
  if (!ev) return;
  const now = nowIso();
  classes.forEach((cls, i) => {
    // 本班该性别的队员（演示数据每班男女各 2 人，不够 4 人就补上同班另一性别，凑足 4 个名字）
    const mine = athletes.filter(a => a.cls.id === cls.id);
    const same = mine.filter(a => a.male === cfg.male);
    const others = mine.filter(a => a.male !== cfg.male);
    const legs = same.concat(others).slice(0, 4).map(a => a.name);

    const id = makeId('rg');
    d.run(`INSERT INTO registration(id, meetId, eventId, athleteId, classId, teamName, legsJson, lane, sort, createdAt, updatedAt)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [
      id, meetId, ev.id, null, cls.id, cls.label, JSON.stringify(legs), i + 1, i + 1, now, now,
    ]);

    if (cfg.noResult) return;   // 未开始的项目不录成绩
    // 接力成绩：一个班一条（班级里第 1 个班的队员号码决定强弱，纯随机但可复现）
    const v = cfg.base + rng() * cfg.spread + i * 0.03;
    d.run(`INSERT INTO result(id, meetId, eventId, regId, attempt, value, dnf, foul, raw, isBest,
              version, clientUuid, source, byUserId, byName, recordedAt, updatedAt)
           VALUES(?,?,?,?,1,?,0,0,?,1,1,NULL,'seed',NULL,?,?,?)`,
      [makeId('r'), meetId, ev.id, id, round2(v), String(round2(v)), '演示数据', now, now]);
  });
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}

module.exports = { ensureMeet, seedDemo, makeRng };
