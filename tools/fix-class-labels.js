'use strict';
/**
 * fix-class-labels.js —— 一次性修复：班级显示名重复年级
 *
 * 【问题】现场导入的名单里「班级」列写的是带年级的全称（"初一（1）班"、"高一36班"），
 *   「年级」列另有值（"初一"/"高一"）。老的 classLabel 一律拼成 `年级(班级)`，于是：
 *       初一(初一（1）班)      ← 年级印了两遍
 *       高一(高一36班)
 *   大屏「班级总分」榜、名单页、导出都受影响。
 *
 * 【修法】src/util.js 的 classLabel 已改成"班级名里已含年级就不再拼"。
 *   但库里 classDef.label 是**早就写进去的**，得把存量刷一遍 —— 就是本脚本。
 *
 * 【安全性】
 *   · 只改 classDef.label 一个字段（显示名），不碰成绩、报名、运动员、接力队名
 *   · 改前自动备份
 *   · 先打印"改成什么样"，再写
 *
 * 用法：
 *   node tools/fix-class-labels.js          # 只看要改什么（不写库）
 *   node tools/fix-class-labels.js --write  # 真改
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WRITE = process.argv.indexOf('--write') >= 0;

let CFG = {};
try { CFG = require(path.join(ROOT, 'config.js')) || {}; } catch (e) { CFG = {}; }
const DATA_DIR = path.resolve(String(process.env.DATA_DIR || CFG.dataDir || path.join(ROOT, 'data')));
const DB = path.join(DATA_DIR, 'sports.db');

const db = require(path.join(ROOT, 'src', 'db.js'));
const { classLabel } = require(path.join(ROOT, 'src', 'util.js'));

console.log('');
console.log('  数据目录：' + DATA_DIR);
if (!fs.existsSync(DB)) {
  console.error('  找不到数据库：' + DB);
  process.exit(1);
}

const d = db.open(DB);
const meet = db.currentMeet(d);
if (!meet) { console.error('  库里没有运动会'); d.close(); process.exit(1); }
console.log('  本届：' + meet.name);

const rows = d.all('SELECT id, grade, className, label FROM classDef WHERE meetId = ? ORDER BY sortGrade, sortClass',
  [meet.id]);
console.log('  班级 ' + rows.length + ' 个');
console.log('');

const changes = [];
rows.forEach((c) => {
  const want = classLabel(c.grade, c.className);
  if (want !== c.label) changes.push({ id: c.id, grade: c.grade, className: c.className, from: c.label, to: want });
});

console.log('  ── 需要改的 ' + changes.length + ' 个 ──');
changes.forEach((x) => {
  console.log('    ' + (x.from || '(空)') + '   →   ' + (x.to || '(空)')
    + '　[grade=' + JSON.stringify(x.grade) + ' className=' + JSON.stringify(x.className) + ']');
});
if (!changes.length) {
  console.log('    （没有需要改的）');
  d.close();
  process.exit(0);
}

/* 提醒：接力队名不受影响（它和 classId 绑定，不靠 label 认人） */
const relayN = d.get('SELECT COUNT(1) c FROM registration r JOIN event e ON e.id = r.eventId WHERE r.meetId = ? AND e.isRelay = 1',
  [meet.id]).c;
console.log('');
console.log('  说明：接力队 ' + relayN + ' 支不受影响 —— 接力靠 classId 绑定，不靠 label 认人。');

if (!WRITE) {
  console.log('');
  console.log('  以上只是预览，没有写库。要改加 --write。');
  d.close();
  process.exit(0);
}

console.log('');
console.log('  ── 备份 ──');
const bkDir = path.join(DATA_DIR, 'backup');
fs.mkdirSync(bkDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
const bkFile = path.join(bkDir, 'sports-' + stamp + '-before-class-labels.db');
try {
  d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB, bkFile);
  const sz = fs.statSync(bkFile).size;
  console.log('    已备份 ' + path.basename(bkFile) + '（' + Math.round(sz / 1024) + ' KB）');
  if (sz < 1024) { console.error('    备份文件太小，中止'); d.close(); process.exit(1); }
} catch (e) {
  console.error('    备份失败：' + (e && e.message) + '　已中止');
  d.close();
  process.exit(1);
}

console.log('');
console.log('  ── 写入 ──');
const now = new Date().toISOString();
d.tx(() => {
  changes.forEach((x) => {
    d.run('UPDATE classDef SET label = ? WHERE id = ?', [x.to, x.id]);
  });
  d.run('UPDATE meet SET updatedAt = ? WHERE id = ?', [now, meet.id]);
});
console.log('    改了 ' + changes.length + ' 个班级显示名');

console.log('');
console.log('  ── 校验 ──');
const after = d.all('SELECT grade, className, label FROM classDef WHERE meetId = ? ORDER BY sortGrade, sortClass LIMIT 8',
  [meet.id]);
after.forEach(c => console.log('    ' + String(c.label)));
const still = d.all('SELECT grade, label FROM classDef WHERE meetId = ?', [meet.id])
  .filter(c => c.grade && c.label && (c.label.match(new RegExp(c.grade, 'g')) || []).length > 1);
console.log('    仍然重复年级的：' + still.length + ' 个' + (still.length ? '' : ' ✔'));
const cnt = (t) => d.get('SELECT COUNT(1) c FROM ' + t + ' WHERE meetId = ?', [meet.id]).c;
console.log('    数据没动：运动员 ' + cnt('athlete') + '　项目 ' + cnt('event')
  + '　报名 ' + cnt('registration') + '　成绩 ' + cnt('result'));
console.log('');
console.log('  退路：' + path.basename(bkFile));
d.close();
console.log('');
