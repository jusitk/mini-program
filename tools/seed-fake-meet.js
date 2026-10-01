'use strict';
/**
 * seed-fake-meet.js —— 造一批**假的**名单与赛程（给测试版用）
 *
 * 【为什么单独一个脚本，不用 SEED_DEMO】
 *   内置的演示数据是 12 个班 / 48 人 / 10 个项目 —— 太少，测不出真实压力：
 *   大屏"人多时卡片自己滚动"、140 个项目的列表性能、搜索与三重筛选，
 *   都要有量才看得出来。这个脚本造的是**中等规模**：
 *     4 个年级 × 4 个班 = 16 个班；每班 10 人 = **160 名运动员**
 *     4 个组别、**36 个项目**（含预赛/决赛、田赛试跳、4×100 接力）
 *     报名按"每人 2~3 项"自动生成 ≈ 400 条
 *
 * 【不造成绩】成绩留空，让测试的人自己录 —— 这样也顺便测了录入流程。
 *   只把 1 个项目置成"已结束"、2 个置成"进行中"、1 个开检录，
 *   这样大屏、班级总分、检录栏、赛程栏一打开就有内容可看。
 *
 * 用法（一般由 tools/make-test-copy.js 调用，不单独跑）：
 *   DATA_DIR=<测试目录>/data node tools/seed-fake-meet.js
 *
 * ⚠ 会**清空**目标库里的运动员/项目/报名再重建。只对测试库用。
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
let CFG = {};
try { CFG = require('../config.js') || {}; } catch (e) { CFG = {}; }
const DATA_DIR = path.resolve(String(process.env.DATA_DIR || CFG.dataDir || path.join(ROOT, 'data')));

const db = require('../src/db');
const { makeId, nowIso, gradeRank, classRank } = require('../src/util');

const DB_FILE = path.join(DATA_DIR, 'sports.db');
if (!fs.existsSync(DB_FILE)) {
  console.error('  找不到数据库：' + DB_FILE);
  process.exit(1);
}
const d = db.open(DB_FILE);
const meet = db.currentMeet(d);
if (!meet) { console.error('  数据库里还没有运动会。'); process.exit(1); }
const M = meet.id;

/* ── 假名字库（跟 src/seed.js 一个路子，够用就行） ─────────────────────── */
const SURNAMES = ['张', '王', '李', '赵', '陈', '刘', '杨', '黄', '周', '吴', '徐', '孙',
  '马', '朱', '胡', '郭', '林', '何', '高', '罗', '郑', '梁', '谢', '宋', '唐', '许',
  '韩', '冯', '邓', '曹', '彭', '曾', '肖', '田', '董', '潘'];
const GIVEN_M = ['伟', '强', '磊', '洋', '勇', '军', '杰', '涛', '明', '超', '鹏', '浩',
  '宇', '晨', '睿', '航', '博', '轩', '泽', '阳', '峰', '斌', '健', '锋', '亮', '辉'];
const GIVEN_F = ['静', '敏', '丽', '娟', '燕', '艳', '娜', '芳', '婷', '雪', '颖', '琳',
  '悦', '欣', '怡', '蕾', '倩', '洁', '梅', '萍', '红', '霞', '露', '薇', '萱', '瑶'];

/** 固定种子的伪随机 —— 每次生成同一批名字，便于反复测试时对照 */
let seed = 20260930;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

const GRADES = ['初一', '初二', '高一', '高二'];
const CLASS_NUMS = [1, 2, 3, 4];
const PER_CLASS = 10;          // 每班 10 人（男女各 5）

console.log('');
console.log('  数据目录：' + DATA_DIR);
console.log('  正在清空旧的运动员/项目/报名…');

/* ── 清空（只清名单与赛程相关，不动别的） ─────────────────────────────── */
d.tx(() => {
  d.run(`DELETE FROM result WHERE eventId IN (SELECT id FROM event WHERE meetId = ?)`, [M]);
  d.run(`DELETE FROM checkin WHERE eventId IN (SELECT id FROM event WHERE meetId = ?)`, [M]);
  d.run(`DELETE FROM checkinState WHERE eventId IN (SELECT id FROM event WHERE meetId = ?)`, [M]);
  d.run('DELETE FROM registration WHERE meetId = ?', [M]);
  d.run('DELETE FROM event WHERE meetId = ?', [M]);
  d.run('DELETE FROM athlete WHERE meetId = ?', [M]);
  d.run('DELETE FROM classDef WHERE meetId = ?', [M]);
  d.run('DELETE FROM groupDef WHERE meetId = ?', [M]);
});

/* ── 组别：每个年级各一个男子组、一个女子组 ───────────────────────────── */
const now = nowIso();
const groups = [];       // { id, grade, kind }
let gsort = 0;
GRADES.forEach((g) => {
  ['male', 'female'].forEach((kind) => {
    const id = makeId('g');
    const nm = g + (kind === 'male' ? '男子组' : '女子组');
    /* 注意 groupDef 只有 id/meetId/name/sort/kind —— **没有 createdAt/updatedAt**
       （第一版我照别的表加了这两列，直接报 "no column named createdAt"） */
    d.run('INSERT INTO groupDef(id, meetId, name, sort, kind) VALUES(?,?,?,?,?)',
      [id, M, nm, ++gsort, kind]);
    groups.push({ id, grade: g, kind });
  });
});
const groupOf = (grade, kind) => groups.find(x => x.grade === grade && x.kind === kind);

/* ── 班级：4 个年级 × 4 个班 = 16 个班 ───────────────────────────────── */
const classes = [];
GRADES.forEach((g) => {
  CLASS_NUMS.forEach((n) => {
    const id = makeId('cls');
    const cn = n + '班';
    /* classDef 同样没有 createdAt/updatedAt */
    d.run('INSERT INTO classDef(id, meetId, grade, className, label, sortGrade, sortClass) VALUES(?,?,?,?,?,?,?)',
      [id, M, g, cn, g + '(' + cn + ')', gradeRank(g), classRank(cn)]);
    classes.push({ id, grade: g, className: cn, label: g + '(' + cn + ')' });
  });
});

/* ── 运动员：16 班 × 10 人 = 160 人（男女各半） ───────────────────────── */
const athletes = [];
let bibSeq = 1001;
classes.forEach((cls) => {
  for (let k = 0; k < PER_CLASS; k++) {
    const male = k % 2 === 0;
    const name = SURNAMES[Math.floor(rnd() * SURNAMES.length)]
      + (male ? GIVEN_M : GIVEN_F)[Math.floor(rnd() * 26)];
    const id = makeId('a');
    const bib = String(bibSeq++);
    const g = groupOf(cls.grade, male ? 'male' : 'female');
    d.run(`INSERT INTO athlete(id, meetId, name, groupId, classId, grade, className, team, bib, gender, note, createdAt, updatedAt)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, M, name, g.id, cls.id, cls.grade, cls.className, cls.label, bib,
        male ? '男' : '女', null, now, now]);
    athletes.push({ id, name, bib, male, cls, groupId: g.id, grade: cls.grade });
  }
});

/* ── 项目：每个年级男子/女子各若干，共 36 个 ──────────────────────────── */
/** 基准时间：比赛日 8:00（本地时间） */
const DAY = '2026-09-30';
const baseMs = new Date(DAY + 'T08:00:00').getTime();
const ts = (min) => new Date(baseMs + min * 60000).toISOString();

const evDefs = [];
let sort = 0;
GRADES.forEach((g, gi) => {
  const gM = groupOf(g, 'male');
  const gF = groupOf(g, 'female');
  const off = gi * 90;                     // 每个年级错开 90 分钟
  const track = '田径场';
  const field = '田赛区 ' + String.fromCharCode(65 + gi);
  const add = (o) => evDefs.push(Object.assign({ sort: ++sort }, o));
  /* 男子 */
  add({ name: g + '男子100米预赛', groupId: gM.id, kind: 'track', stage: 'heat', startAt: ts(off + 0), endAt: ts(off + 20), venue: track, advanceCount: 6 });
  add({ name: g + '男子100米决赛', groupId: gM.id, kind: 'track', stage: 'final', startAt: ts(off + 30), endAt: ts(off + 45), venue: track });
  add({ name: g + '男子400米决赛', groupId: gM.id, kind: 'track', stage: 'final', startAt: ts(off + 55), endAt: ts(off + 75), venue: track });
  add({ name: g + '男子1500米决赛', groupId: gM.id, kind: 'track', stage: 'final', startAt: ts(off + 85), endAt: ts(off + 115), venue: track });
  add({ name: g + '男子4×100米接力决赛', groupId: gM.id, kind: 'track', stage: 'final', startAt: ts(off + 125), endAt: ts(off + 145), venue: track, isRelay: true, relayLegs: 4 });
  add({ name: g + '男子跳远决赛', groupId: gM.id, kind: 'field', stage: 'final', startAt: ts(off + 10), endAt: ts(off + 70), venue: field, attempts: 3 });
  add({ name: g + '男子铅球决赛', groupId: gM.id, kind: 'field', stage: 'final', startAt: ts(off + 75), endAt: ts(off + 120), venue: field, attempts: 3 });
  add({ name: g + '男子跳高决赛', groupId: gM.id, kind: 'field', stage: 'final', startAt: ts(off + 125), endAt: ts(off + 170), venue: field, attempts: 3 });
  /* 女子 */
  add({ name: g + '女子100米预赛', groupId: gF.id, kind: 'track', stage: 'heat', startAt: ts(off + 5), endAt: ts(off + 25), venue: track, advanceCount: 6 });
  add({ name: g + '女子100米决赛', groupId: gF.id, kind: 'track', stage: 'final', startAt: ts(off + 35), endAt: ts(off + 50), venue: track });
  add({ name: g + '女子800米决赛', groupId: gF.id, kind: 'track', stage: 'final', startAt: ts(off + 60), endAt: ts(off + 80), venue: track });
  add({ name: g + '女子4×100米接力决赛', groupId: gF.id, kind: 'track', stage: 'final', startAt: ts(off + 130), endAt: ts(off + 150), venue: track, isRelay: true, relayLegs: 4 });
  add({ name: g + '女子跳远决赛', groupId: gF.id, kind: 'field', stage: 'final', startAt: ts(off + 15), endAt: ts(off + 65), venue: field, attempts: 3 });
  add({ name: g + '女子实心球决赛', groupId: gF.id, kind: 'field', stage: 'final', startAt: ts(off + 70), endAt: ts(off + 115), venue: field, attempts: 3 });
});

const events = [];
for (const def of evDefs) {
  const id = makeId('ev');
  d.run(`INSERT INTO event(id, meetId, name, groupId, kind, stage, isRelay, relayLegs, day,
            startAt, endAt, venue, status, statusMode, attempts, tol, unit,
            advanceFromId, advanceCount, sort, createdAt, updatedAt)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    id, M, def.name, def.groupId, def.kind, def.stage,
    def.isRelay ? 1 : 0, def.relayLegs || null, 1,
    def.startAt, def.endAt, def.venue,
    /* 全部 pending + auto：由"按时间自动切换"去驱动。
       比赛日是 2026-09-30，现在还没到，所以打开就是"未开始"，
       测试的人可以改开始时间把它推成"进行中"。 */
    'pending', 'auto',
    def.attempts || 1, def.kind === 'field' ? 0.01 : 0.01, def.kind === 'field' ? '米' : '秒',
    null, def.advanceCount || 6, def.sort, now, now,
  ]);
  events.push(Object.assign({ id }, def));
}

/* ── 报名：每人报 2~3 项（同组别的项目）──────────────────────────────── */
let regCount = 0;
const byGroup = {};
events.forEach((e) => { (byGroup[e.groupId] = byGroup[e.groupId] || []).push(e); });
athletes.forEach((a, ai) => {
  const pool = byGroup[a.groupId] || [];
  if (!pool.length) return;
  // 每人挑 3 项，错开起点，让各项目人数分布均匀
  const want = [];
  for (let k = 0; k < 3 && k < pool.length; k++) {
    want.push(pool[(ai * 3 + k * 5) % pool.length]);
  }
  const seen = {};
  want.forEach((e) => {
    if (seen[e.id]) return;
    seen[e.id] = 1;
    const id = makeId('rg');
    d.run(`INSERT INTO registration(id, meetId, eventId, athleteId, classId, teamName, legsJson, lane, sort, createdAt, updatedAt)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [id, M, e.id, a.id, a.cls.id, null, null, null, ai, now, now]);
    regCount++;
  });
});

d.run('UPDATE meet SET rev = rev + 1, updatedAt = ? WHERE id = ?', [now, M]);

console.log('');
console.log('  ✔ 假数据已生成：');
console.log('    组别 ' + groups.length + ' 个　班级 ' + classes.length + ' 个'
  + '　运动员 ' + athletes.length + ' 名');
console.log('    项目 ' + events.length + ' 个　报名 ' + regCount + ' 条');
console.log('    比赛日 ' + DAY + '（项目都是"未开始 + 按时间自动"）');
console.log('');
d.close();
