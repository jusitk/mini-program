'use strict';
/**
 * reset-meet.js —— 把赛事恢复到一个干净的起点
 *
 * 【两种力度】
 *
 *  ① 默认（只清"比赛过程数据"）—— 比赛结束、明年还用这份名单时用
 *     清掉：成绩、检录记录与检录开关、聊天、上传的附件、待确认改动、
 *           操作记录、检录自动生成的公告、幂等去重表、所有登录会话；
 *           项目状态回到"未开始 + 按时间自动"
 *     留下：**运动员名单、班级、组别、项目、报名、计分规则、大屏设置、账号**
 *
 *  ② `--full`（额外清掉"账号与备份"）—— 要把系统交给别人、或彻底重来时用
 *     额外清掉：除管理员外的所有账号、所有登录会话、
 *               **全部备份历史与磁盘上的备份文件**、以及手工公告
 *     留下：运动员、班级、组别、项目、报名、计分规则、大屏设置、管理员账号
 *
 *     ⚠ `--full` 会删掉备份历史。为了让"清完后悔"还有救，
 *       它会**额外留一份名字带 BEFORE-CLEAR 的安全备份**，
 *       并在报告里告诉你文件名和怎么用它。
 *
 * 【怎么用】
 *   node tools/reset-meet.js                        # 先看会清掉什么（**不动数据**）
 *   node tools/reset-meet.js --write                # 真的清（清之前自动备份一份）
 *   node tools/reset-meet.js --write --full         # 连账号和备份一起清
 *   node tools/reset-meet.js --write --all-notices  # 只额外清手工公告
 *   node tools/reset-meet.js --write --full --no-keep-backups
 *       连那份安全备份也不留（**不可恢复**，只在确定不要了才用）
 *
 * 【安全】
 *   · 默认只预览，必须加 --write 才动手
 *   · 清之前自动备份到 data/backup
 *   · 请先停掉服务再跑（避免和正在跑的服务同时写库）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const WRITE = args.indexOf('--write') >= 0;
const FULL = args.indexOf('--full') >= 0;
/* 手工公告：--full 默认一起清；也可以单独用 --all-notices 只清公告 */
const ALL_NOTICES = FULL || args.indexOf('--all-notices') >= 0;
const KEEP_SAFETY = args.indexOf('--no-keep-backups') < 0;

const db = require('../src/db');
/* 【数据目录要跟着 DATA_DIR 走，别硬编码】
 *
 * 原来这里写死 `path.join(ROOT, 'data', 'sports.db')`，结果：
 *   · 我为了"先在副本上试跑"设了 DATA_DIR 指向临时副本，
 *     工具却照样操**真实库** —— 隔离完全没生效，真库的备份全被删了。
 *   · 更一般地：谁把数据放在别的盘（config.js 的 dataDir 或 DATA_DIR 环境变量），
 *     这个工具就会去操作一个**不存在的/错误的**库。
 *
 * 现在与 server.js 同一套解析顺序：环境变量 DATA_DIR > config.js 的 dataDir > 默认 data/
 * （config.js 在项目根目录，server.js 读的也是它，保证两边永远一致）
 */
let CFG = {};
try { CFG = require('../config.js') || {}; } catch (e) { CFG = {}; }
const DATA_DIR = path.resolve(String(
  process.env.DATA_DIR
  || CFG.dataDir
  || path.join(ROOT, 'data')
));
const DB_FILE = path.join(DATA_DIR, 'sports.db');
if (!fs.existsSync(DB_FILE)) {
  console.error('');
  console.error('  找不到数据库：' + DB_FILE);
  console.error('  （如果数据在别处，用 DATA_DIR 指定数据目录）');
  console.error('');
  process.exit(1);
}
console.log('  数据目录：' + DATA_DIR);
const d = db.open(DB_FILE);
const meet = db.currentMeet(d);
if (!meet) { console.error('数据库里还没有运动会。'); process.exit(1); }
const M = meet.id;
const BACKUP_DIR = path.join(DATA_DIR, 'backup');

/* ══ 主流程 ═════════════════════════════════════════════════════════════
 * 包成 async 是为了 `await d.backupTo(...)` —— 它是异步的，
 * 不 await 的话"安全备份"可能还没写盘脚本就退出了（真踩过：
 * backupLog 里记着备份文件，磁盘上却没有）。
 * ══════════════════════════════════════════════════════════════════════ */
async function main() {
  /* ── 先统计一遍（预览与实际用的是同一套查询）───────────────────────────── */

  /** 没有 meetId 的表，经 event 关联 */
  const kEvent = (table) => d.get('SELECT COUNT(*) c FROM ' + table
    + ' x JOIN event e ON e.id = x.eventId WHERE e.meetId = ?', [M]).c;
  const kMeet = (table) => d.get('SELECT COUNT(*) c FROM ' + table + ' WHERE meetId = ?', [M]).c;

  function survey() {
    return [
      ['成绩记录', kMeet('result')],
      ['检录记录', kEvent('checkin')],
      ['检录开关', kEvent('checkinState')],
      ['聊天消息', kMeet('chatMessage')],
      ['上传附件', kMeet('upload')],
      ['待确认改动', kMeet('stagedOp')],
      ['操作记录', kMeet('auditLog')],
      ['检录自动公告', d.get('SELECT COUNT(*) c FROM notice WHERE meetId = ? AND auto = 1', [M]).c],
      ['手工公告', d.get('SELECT COUNT(*) c FROM notice WHERE meetId = ? AND (auto IS NULL OR auto = 0)', [M]).c],
      ['幂等去重表', d.get('SELECT COUNT(*) c FROM idempotency', []).c],
      ['登录会话', d.get('SELECT COUNT(*) c FROM session', []).c],
    ];
  }

  const before = survey();
  const nonZeroStatus = d.get(`SELECT COUNT(*) AS c FROM event WHERE meetId = ?
                               AND (status <> 'pending' OR statusMode <> 'auto')`, [M]).c;
  const otherUsers = d.all('SELECT username, role FROM user WHERE username <> ? ORDER BY username', ['admin']);
  const backupFiles = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR) : [];
  const backupBytes = backupFiles.reduce((n, f) => {
    try { return n + fs.statSync(path.join(BACKUP_DIR, f)).size; } catch (e) { return n; }
  }, 0);

  console.log('');
  console.log('  运动会：' + meet.name + '（' + (meet.holdDate || '未设日期') + '）');
  console.log('  清理力度：' + (FULL ? '【全部清理】—— 连账号和备份一起清' : '【常规清理】—— 只清比赛过程数据'));
  console.log('  ' + '─'.repeat(64));
  console.log('  【会清掉】');
  before.forEach(([label, n]) => {
    const skip = (label === '手工公告' && !ALL_NOTICES);
    console.log('    ' + label.padEnd(14) + String(n).padStart(5) + ' 条' + (skip ? '　（默认保留）' : ''));
  });
  console.log('    项目状态复位      ' + String(nonZeroStatus).padStart(5) + ' 个项目（改成"未开始 + 按时间自动"）');
  if (FULL) {
    console.log('    其它账号          ' + String(otherUsers.length).padStart(5) + ' 个'
      + (otherUsers.length ? ('　（' + otherUsers.map(u => u.username + '/' + u.role).join('、') + '）') : ''));
    console.log('    备份文件          ' + String(backupFiles.length).padStart(5) + ' 个　共 '
      + (Math.round(backupBytes / 1024 / 1024 * 10) / 10) + ' MB'
      + (KEEP_SAFETY && backupFiles.length ? '　（其中会额外留 1 份安全备份）' : ''));
    console.log('    备份记录          ' + String(d.get('SELECT COUNT(*) c FROM backupLog', []).c).padStart(5) + ' 条');
  }
  console.log('');
  console.log('  【会留下】');
  console.log('    运动员 ' + kMeet('athlete') + ' 人　班级 ' + kMeet('classDef')
    + ' 个　组别 ' + kMeet('groupDef') + ' 个');
  console.log('    项目 ' + kMeet('event') + ' 个　报名 ' + kMeet('registration') + ' 条');
  console.log('    计分规则与大屏设置（保持当前值）');
  console.log('    管理员账号 admin' + (FULL ? '（其它账号会清掉）' : ' 与其它账号都保留'));
  console.log('');

  if (!WRITE) {
    console.log('  以上只是预览，**没有动数据**。');
    console.log('  确实要清就加 --write 再执行一次：');
    if (FULL) {
      console.log('    node tools/reset-meet.js --write --full   （连账号和备份一起清）');
      console.log('    node tools/reset-meet.js --write          （改成只做常规清理）');
    } else {
      console.log('    node tools/reset-meet.js --write          （常规清理：留账号和备份）');
      console.log('    node tools/reset-meet.js --write --full   （连账号和备份一起清）');
    }
    console.log('');
    d.close();
    process.exit(0);
  }

  /* ── 备份 ──────────────────────────────────────────────────────────────── */

  /* 【顺序很重要】--full 会删掉"所有备份"，但**不能把自己刚做的这份删掉** ——
     否则"清完后悔想恢复"就没得恢复了。
     做法：先做备份、记住文件名，后面删备份时跳过它。

     ⚠ `d.backupTo()` 是 **async** 的！原来这里没 await，于是：
       · 后面 `fs.existsSync(safetyFile)` 查的时候文件还没写完 → 不登记进 backupLog
       · 更糟的是脚本可能在写盘完成前就退出了 → **磁盘上根本没有这个备份**
       而 backupLog 里却写着"安全备份在此" —— 那份"安全备份"是假的。
       现在 await 它，并且**真的检查文件存在、大小大于 0** 才算成功。 */
  let safetyFile = '';
  if (typeof d.backupTo === 'function') {
    const dir = BACKUP_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const name = FULL
      ? ('sports-' + stamp + '-BEFORE-CLEAR.db')
      : ('sports-' + stamp + '-before-reset.db');
    safetyFile = path.join(dir, name);
    try {
      await d.backupTo(safetyFile);
      const sz = fs.existsSync(safetyFile) ? fs.statSync(safetyFile).size : 0;
      if (sz > 0) {
        console.log('  已备份：' + name + '（' + Math.round(sz / 1024) + ' KB）'
          + (FULL ? '　← 安全备份，--full 不会删它' : ''));
      } else {
        console.log('  ⚠ 备份文件是空的或没写出来：' + name);
        safetyFile = '';
      }
    } catch (e) {
      console.log('  ⚠ 备份失败：' + (e && e.message));
      safetyFile = '';
    }
  }
  /* 备份没成功时，--full 要停下来问一句 ——
     "删掉所有备份"却又没有新的安全备份，是把退路全堵上。 */
  if (FULL && !safetyFile) {
    console.log('');
    console.log('  ✘ 没有做成安全备份，**已停止**（--full 会删掉全部备份历史，');
    console.log('    没有退路的事不能默认干）。请先确认磁盘可写、或改用不带 --full 的常规清理。');
    console.log('');
    d.close();
    process.exit(1);
  }

  /* ── 清理（一个事务里做完：要么全清，要么一个不动）─────────────────────── */

  const nowIsoStr = new Date().toISOString();
  const done = {};
  d.tx(() => {
    done.result = d.run('DELETE FROM result WHERE meetId = ?', [M]).changes || 0;
    done.checkin = d.run(`DELETE FROM checkin WHERE eventId IN
                          (SELECT id FROM event WHERE meetId = ?)`, [M]).changes || 0;
    done.checkinState = d.run(`DELETE FROM checkinState WHERE eventId IN
                               (SELECT id FROM event WHERE meetId = ?)`, [M]).changes || 0;
    done.chat = d.run('DELETE FROM chatMessage WHERE meetId = ?', [M]).changes || 0;
    done.upload = d.run('DELETE FROM upload WHERE meetId = ?', [M]).changes || 0;
    done.staged = d.run('DELETE FROM stagedOp WHERE meetId = ?', [M]).changes || 0;
    done.audit = d.run('DELETE FROM auditLog WHERE meetId = ?', [M]).changes || 0;
    done.noticeAuto = d.run('DELETE FROM notice WHERE meetId = ? AND auto = 1', [M]).changes || 0;
    if (ALL_NOTICES) {
      done.noticeAll = d.run('DELETE FROM notice WHERE meetId = ?', [M]).changes || 0;
    }
    // 幂等表：清掉，免得"现场重连补交"被判成已处理过
    done.once = d.run('DELETE FROM idempotency', []).changes || 0;

    if (FULL) {
      /* 会话要先清（session.userId 有外键指向 user，虽然声明了 CASCADE，
         但显式清一遍更稳，也顺便把"管理员自己的会话"一起清掉
         —— 清完必须重新登录，这是有意的）。 */
      done.session = d.run('DELETE FROM session', []).changes || 0;
      // 除 admin 外的账号（`aaa` 这种测试账号就清掉了）
      done.users = d.run('DELETE FROM user WHERE username <> ?', ['admin']).changes || 0;
      // 管理员本人的会话已经在上面一起清了，这里不用再动
      done.backupLog = d.run('DELETE FROM backupLog', []).changes || 0;
    } else {
      /* 常规清理也把会话清掉：比赛数据都清了，旧的登录状态没必要留着，
         而且能给"现场换了人操作"一个干净的起点。管理员重新登录即可。 */
      done.session = d.run('DELETE FROM session', []).changes || 0;
    }

    // 项目状态复位：回到"未开始 + 按时间自动"
    done.status = d.run(`UPDATE event SET status = 'pending', statusMode = 'auto', updatedAt = ?
                         WHERE meetId = ? AND (status <> 'pending' OR statusMode <> 'auto')`,
      [nowIsoStr, M]).changes || 0;
    // 版本号 +1：所有连着的大屏/后台会立刻刷新
    d.run('UPDATE meet SET rev = rev + 1, updatedAt = ? WHERE id = ?', [nowIsoStr, M]);
  });

  /* 上传的附件文件：库里记录删了，磁盘上的文件也删掉，别一直占空间。
     顺手把空目录也删掉 —— 留个空壳目录没有意义，而且会让人以为"还有附件"。
     （注意路径要用 DATA_DIR，不能写死 ROOT/data —— 上面那行原来就是写死的，
       跟库路径是同一个毛病。） */
  let files = 0;
  const upDir = path.join(DATA_DIR, 'uploads');
  if (fs.existsSync(upDir)) {
    fs.readdirSync(upDir).forEach((f) => {
      try { fs.unlinkSync(path.join(upDir, f)); files++; } catch (e) { /* 忽略单个失败 */ }
    });
    try { fs.rmdirSync(upDir); } catch (e) { /* 还有没删掉的就不强删 */ }
  }

  /* ── 备份文件：--full 时删掉历史备份（**跳过刚才那份安全备份**）────────── */

  let removedBackups = 0;
  let keptBackups = 0;
  let freedBytes = 0;
  if (FULL && fs.existsSync(BACKUP_DIR)) {
    const keepName = path.basename(safetyFile);
    fs.readdirSync(BACKUP_DIR).forEach((f) => {
      if (KEEP_SAFETY && keepName && f === keepName) { keptBackups++; return; }
      const full = path.join(BACKUP_DIR, f);
      try {
        const sz = fs.statSync(full).size;
        fs.unlinkSync(full);
        removedBackups++;
        freedBytes += sz;
      } catch (e) { /* 单个失败不影响其它 */ }
    });
    if (KEEP_SAFETY && safetyFile && fs.existsSync(safetyFile)) {
      // 安全备份要重新登记进 backupLog，否则后台的"备份与导出"看不到它、也就恢复不了
      d.run(`INSERT INTO backupLog(id, fileName, reason, size, byName, createdAt)
             VALUES(?,?,?,?,?,?)`, [
        'bk_' + Math.random().toString(36).slice(2, 12), path.basename(safetyFile),
        '清库前的安全备份', fs.statSync(safetyFile).size, '清理工具', nowIsoStr,
      ]);
    }
  }

  /* ── 报告 ──────────────────────────────────────────────────────────────── */

  console.log('');
  console.log('  【清理结果】');
  console.log('    成绩 ' + done.result + '　检录记录 ' + done.checkin + '　检录开关 ' + done.checkinState
    + '　聊天 ' + done.chat + '　上传 ' + done.upload);
  console.log('    待确认 ' + done.staged + '　操作记录 ' + done.audit
    + '　自动公告 ' + done.noticeAuto + (done.noticeAll ? ('　手工公告 ' + done.noticeAll) : '')
    + '　幂等表 ' + done.once + '　登录会话 ' + (done.session || 0));
  console.log('    项目状态复位 ' + done.status + ' 个' + (files ? ('　磁盘附件删除 ' + files + ' 个') : ''));
  if (FULL) {
    console.log('    清掉账号 ' + (done.users || 0) + ' 个　备份记录 ' + (done.backupLog || 0) + ' 条');
    console.log('    删除备份文件 ' + removedBackups + ' 个'
      + (freedBytes ? ('　释放 ' + (Math.round(freedBytes / 1024 / 1024 * 10) / 10) + ' MB') : '')
      + (keptBackups ? ('　保留 ' + keptBackups + ' 个（安全备份）') : ''));
  }

  const after = survey();
  console.log('');
  console.log('  【现在的状态】');
  after.forEach(([label, n]) => console.log('    ' + label.padEnd(14) + String(n).padStart(5) + ' 条'));
  console.log('');
  console.log('    运动员 ' + kMeet('athlete') + ' 人　班级 ' + kMeet('classDef')
    + ' 个　项目 ' + kMeet('event') + ' 个　报名 ' + kMeet('registration') + ' 条');
  console.log('    账号 ' + d.all('SELECT username, role FROM user ORDER BY username', [])
    .map(u => u.username + '(' + u.role + ')').join('、'));
  console.log('');

  if (safetyFile && fs.existsSync(safetyFile)) {
    console.log('  【万一要反悔】清库前的安全备份在：');
    console.log('    data/backup/' + path.basename(safetyFile));
    console.log('    恢复办法：启动服务 → 后台「导入与设置 → 导出与备份 → 从备份恢复」选它；');
    console.log('    或者停掉服务后把这个文件改名成 sports.db 覆盖回去（先删掉 sports.db-wal/-shm）。');
    console.log('');
  }

  console.log('  ✔ 已清理完成（名单与赛程完好）。');
  if (FULL) {
    console.log('    管理员账号仍是 admin（口令没变）；其它账号已清掉，');
    console.log('    现在所有人都需要重新登录。');
  } else {
    console.log('    下次比赛直接在这份名单上录成绩即可。');
  }
  console.log('');
  d.close();
}

main().catch((e) => {
  console.error('  ✘ 清理过程出错：' + (e && e.message));
  process.exit(1);
});
