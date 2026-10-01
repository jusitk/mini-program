'use strict';
/**
 * db.js —— 数据库层（Node 内置 node:sqlite，零 npm 依赖）
 *
 * 职责：
 *   · 开库（WAL、外键、busy_timeout）与建表
 *   · **事务**：所有写操作走 tx()，出错整体回滚，绝不半成品
 *   · **预览副本**：后台"确认后会变成什么样"要在副本上试跑，绝不能污染真实数据
 *   · **备份/恢复**：用 sqlite 官方的 backup API（不是复制文件 —— WAL 模式下复制文件会拿到半个库）
 *   · **迁移**：老库平滑升到当前结构版本，现场录了一半的数据不能丢
 *
 * 换 PostgreSQL 只需要改这一个文件（上层拿到的都是 d.get / d.all / d.run 这套接口）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SCHEMA_VERSION, DDL } = require('./schema');
const { nowIso, makeId } = require('./util');

/* ── 迁移表 ───────────────────────────────────────────────────────────────
 * 每一项：{ to: 目标版本, up(d) } —— 从 to-1 升到 to 要做的事。
 * 注意：迁移里**不要**用参数化之外的怪写法，节点上要幂等（重复跑不报错）。
 * ------------------------------------------------------------------------ */
const MIGRATIONS = [
  {
    to: 11,
    up(d) {
      /* v11：athlete 加 blocked —— "屏蔽运动员"。
         现场场景：某个运动员上不了场/不参赛了，但**不能删**（删了报名和成绩一起没，
         而且号码可能还要留着）；只是不想让他出现在成绩展示页上。
         屏蔽后：人还在库里、还在录入页（可以取消屏蔽），
         但大屏/成绩与名次页不展示他（名次照常按剩下的人排）。 */
      const cols = d.all('PRAGMA table_info(athlete)').map(r => r.name);
      if (cols.indexOf('blocked') < 0) {
        d.exec('ALTER TABLE athlete ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0');
      }
    },
  },
  {
    to: 10,
    up(d) {
      /* v10：kickNote —— 记下"这条会话为什么被顶下线"。
         一个账号只能在一台设备登录（新登录顶掉旧的），
         被顶的那台需要知道原因，否则老师只会看到"突然要重新登录"。
         表本身由 DDL 建（createAll 会跑），这里只是把版本推上去。 */
      d.run(`CREATE TABLE IF NOT EXISTS kickNote (
               sessionId TEXT PRIMARY KEY, reason TEXT, at TEXT NOT NULL)`);
      d.run('CREATE INDEX IF NOT EXISTS idx_kick_time ON kickNote(at)');
    },
  },
  {
    to: 9,
    up(d) {
      /* v9：auditLog 加 sessionId —— 记下"这次操作是哪一次登录做的"。
         用来准确回答"这个 IP 以前登录过吗"（见 server.js 的 listSessions）：
         不加这一列就没法把**本次登录自己写的**那条 user.login 排除掉。 */
      const cols = d.all('PRAGMA table_info(auditLog)').map(r => r.name);
      if (cols.indexOf('sessionId') < 0) {
        d.run('ALTER TABLE auditLog ADD COLUMN sessionId TEXT');
      }
    },
  },
  {
    to: 8,
    up(d) {
      /* v8：暂存区补 baseSnapshot —— 暂存时把**目标记录**的字段快照存下来，
         确认时逐字段比对，用来发现"暂存之后别人又改过同一条"。

         为什么不用 baseVersion（整届版本号）：那一届里任何一个项目录了成绩，
         版本号都会变，于是所有暂存项都会被误判成冲突 —— 现场等于没法用。
         必须按**目标记录**判。 */
      const cols = d.all('PRAGMA table_info(stagedOp)').map(r => r.name);
      if (cols.indexOf('baseSnapshot') < 0) {
        d.exec('ALTER TABLE stagedOp ADD COLUMN baseSnapshot TEXT');
      }
    },
  },
  {
    to: 7,
    up(d) {
      // v7：meet 表补上版本号 rev（大屏靠它判断"数据变了没有"）
      const cols = d.all('PRAGMA table_info(meet)').map(r => r.name);
      if (cols.indexOf('rev') < 0) {
        d.exec('ALTER TABLE meet ADD COLUMN rev INTEGER NOT NULL DEFAULT 1');
      }
    },
  },
  {
    to: 6,
    up(d) {
      // v6：加"预赛→决赛自动录取"和"检控公告来源"，并把 attendance 相关列补齐
      const cols = (table) => d.all('PRAGMA table_info(' + table + ')').map(r => r.name);
      const ev = cols('event');
      if (ev.indexOf('advanceFromId') < 0) {
        // SQLite 不允许 ALTER 加带外键的列，所以这里加普通列，外键靠应用层保证
        d.exec('ALTER TABLE event ADD COLUMN advanceFromId TEXT');
      }
      if (ev.indexOf('advanceCount') < 0) {
        d.exec('ALTER TABLE event ADD COLUMN advanceCount INTEGER NOT NULL DEFAULT 6');
      }
      if (ev.indexOf('attempts') < 0) {
        d.exec('ALTER TABLE event ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1');
      }
      if (ev.indexOf('tol') < 0) {
        d.exec('ALTER TABLE event ADD COLUMN tol REAL NOT NULL DEFAULT 0.01');
      }
      const nt = cols('notice');
      if (nt.indexOf('eventId') < 0) d.exec('ALTER TABLE notice ADD COLUMN eventId TEXT');
      if (nt.indexOf('auto') < 0) d.exec('ALTER TABLE notice ADD COLUMN auto INTEGER NOT NULL DEFAULT 0');
      const cm = cols('chatMessage');
      if (cm.indexOf('kind') < 0) d.exec("ALTER TABLE chatMessage ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'");
      if (cm.indexOf('attachId') < 0) d.exec('ALTER TABLE chatMessage ADD COLUMN attachId TEXT');
      const rs = cols('result');
      if (rs.indexOf('foul') < 0) d.exec('ALTER TABLE result ADD COLUMN foul INTEGER NOT NULL DEFAULT 0');
      if (rs.indexOf('isBest') < 0) d.exec('ALTER TABLE result ADD COLUMN isBest INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    to: 5,
    up(d) {
      // v5：报名表的班级列必须可空（接力队可能只填队名没挂班级），
      // 并且把历史遗留的空字符串改成 NULL（空字符串会被当成无效外键）
      const cols = d.all('PRAGMA table_info(registration)');
      const classCol = cols.find(c => c.name === 'classId');
      if (classCol && classCol.notnull === 1) {
        d.exec('PRAGMA foreign_keys = OFF');
        d.exec(`CREATE TABLE registration_new (
          id TEXT PRIMARY KEY,
          meetId TEXT NOT NULL,
          eventId TEXT NOT NULL,
          athleteId TEXT,
          classId TEXT,
          teamName TEXT,
          legsJson TEXT,
          lane INTEGER,
          sort INTEGER NOT NULL DEFAULT 0,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        )`);
        d.exec('INSERT INTO registration_new SELECT id, meetId, eventId, athleteId, classId, teamName, legsJson, lane, sort, createdAt, updatedAt FROM registration');
        d.exec('DROP TABLE registration');
        d.exec('ALTER TABLE registration_new RENAME TO registration');
        d.exec('PRAGMA foreign_keys = ON');
      }
      ['athlete', 'registration', 'result', 'event', 'notice'].forEach(t => {
        const names = d.all('PRAGMA table_info(' + t + ')').map(r => r.name);
        ['classId', 'groupId', 'teamName', 'legsJson', 'advanceFromId', 'eventId', 'bib', 'grade',
          'className', 'team', 'venue', 'unit', 'raw', 'source', 'byUserId', 'byName', 'note']
          .filter(c => names.indexOf(c) >= 0)
          .forEach(c => {
            d.run('UPDATE ' + t + ' SET ' + c + ' = NULL WHERE ' + c + " = ''");
          });
      });
    },
  },
  {
    to: 4,
    up(d) {
      // v4：计分规则从老版的 9-7-6-5 改成现场定的 7-5-4-3-2-1（取前六名）
      const rows = d.all('SELECT id, ruleJson FROM meet');
      for (const r of rows) {
        let rule = null;
        try { rule = JSON.parse(r.ruleJson || 'null'); } catch (e) { rule = null; }
        if (!rule || !Array.isArray(rule.table)) continue;
        // 老表是 9 个数（取前八）→ 换成新的 6 个数
        if (rule.table.length !== 6 || rule.table[0] === 9) {
          rule.table = [7, 5, 4, 3, 2, 1];
        }
        if (rule.tie === undefined) rule.tie = 'full';   // 并列各得满分（1,2,2,4 → 7,5,5,3）
        if (rule.advanceCount === undefined) rule.advanceCount = 6;
        d.run('UPDATE meet SET ruleJson = ? WHERE id = ?', [JSON.stringify(rule), r.id]);
      }
    },
  },
];

/* ── 打开与初始化 ─────────────────────────────────────────────────────── */

/**
 * 打开数据库并保证结构是最新的。
 * @param {string} file 数据库文件路径（':memory:' 表示内存库，测试用）
 * @returns {object} 包装后的数据库对象
 */
function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  const d = wrap(raw, file);
  setup(d);
  // 顺序很重要：先按当前结构建表（幂等），再看库里的结构版本决定要不要迁移。
  // 反过来会踩坑：全新库还没有 schemaMeta 表，读版本号就直接报 "no such table"。
  createAll(d);
  migrate(d);
  return d;
}

/** 开库参数：WAL 让"一边录一边查"不互相卡；busy_timeout 让并发写自动排队而不是直接报错 */
function setup(d) {
  try { d.exec('PRAGMA journal_mode = WAL'); } catch (e) { /* 内存库不支持，忽略 */ }
  d.exec('PRAGMA foreign_keys = ON');
  d.exec('PRAGMA busy_timeout = 8000');
  d.exec('PRAGMA synchronous = NORMAL');   // WAL 下 NORMAL 已经够安全，且写入快得多
  d.exec('PRAGMA temp_store = MEMORY');
}

/** 建表（幂等）。
 *  只会给"全新的库"写上当前结构版本；老库保留它原来的版本号，
 *  这样随后的 migrate() 才知道要升到哪一版（否则老库会被误判成已是最新）。 */
function createAll(d) {
  d.exec(DDL);
  const has = d.get("SELECT name FROM sqlite_master WHERE type='table' AND name='schemaMeta'");
  if (!has) return;
  const cur = d.get('SELECT v FROM schemaMeta WHERE k = ?', ['schemaVersion']);
  if (!cur) setMeta(d, 'schemaVersion', String(SCHEMA_VERSION));
}

/**
 * 把库升到当前结构版本。
 * 注意：createAll() 已经在 open() 里跑过（新库此时就是当前结构），
 * 所以这里只需处理"老库补列/改表"这一件事，而且迁移必须幂等。
 */
function migrate(d) {
  const current = Number(getMeta(d, 'schemaVersion') || SCHEMA_VERSION);
  if (current >= SCHEMA_VERSION) return;

  const list = MIGRATIONS.filter(m => m.to > current).sort((a, b) => a.to - b.to);
  for (const m of list) {
    try {
      d.exec('BEGIN IMMEDIATE');
      m.up(d);
      setMeta(d, 'schemaVersion', String(m.to));
      d.exec('COMMIT');
      console.log('[数据库] 结构已升级到 v' + m.to);
    } catch (err) {
      try { d.exec('ROLLBACK'); } catch (e) { /* ignore */ }
      throw new Error('数据库升级到 v' + m.to + ' 失败：' + (err && err.message) +
        '\n（现场应急：先备份 data 目录，再用备份恢复；或联系维护者）');
    }
  }
  // 迁移后补建可能缺的表与索引（新增表不需要迁移代码）
  d.exec(DDL);
  setMeta(d, 'schemaVersion', String(SCHEMA_VERSION));
}

/* ── 包装：统一接口 + 事务 + 记录"脏"状态 ─────────────────────────────── */

function wrap(raw, file) {
  let inTx = 0;
  let dirty = false;
  /* 「有未备份的改动」标记 —— 存在**库里**（schemaMeta），不是进程内存里。
   *
   * 【为什么必须持久化】原来只有内存里的 `dirty`：重启归零，而启动过程本身
   * 就会写库（读 backupLog、更新 lastSeenAt…），于是 `isDirty()` 在启动时
   * **几乎必然为 true** —— 表现就是"每次打开都备一份"，把有用的旧备份挤掉。
   * 存进库里之后，换一次进程也还记得"这些改动还没备份过"。 */
  const DIRTY_KEY = 'dirtySince';
  /* markerSet：本进程是否已经写过那条持久标记（写过就不用重复写） */
  let markerSet = false;
  const d = {
    raw,
    file,
    /** 单条查询（返回一行或 undefined） */
    get(sql, params) {
      return raw.prepare(sql).get(...(params || []));
    },
    /** 多行查询 */
    all(sql, params) {
      return raw.prepare(sql).all(...(params || []));
    },
    /** 执行（写操作）；返回 { changes, lastInsertRowid } */
    run(sql, params) {
      const r = raw.prepare(sql).run(...(params || []));
      /* 只有**真的动了数据**才算"改过"。
       *
       * 【为什么必须看 changes】启动时有几处"顺手清理"的语句
       * （pruneIdempotency 的 DELETE、清过期会话…），绝大多数情况下
       * **一行都没删**（changes = 0）—— 但原来无条件 `dirty = true`，
       * 于是每次启动都显示"有改动"→ 启动就备一份 →
       * 备份被这种空转操作反复消耗掉。
       *
       * 注意：内存里的 dirty 和库里那条标记必须**同一口径**，
       * 否则 isDirty() 先看内存就直接返回 true 了，标记白记。 */
      if (r && r.changes > 0) {
        dirty = true;
        if (!markerSet) {
          markerSet = true;
          try {
            raw.prepare('INSERT INTO schemaMeta(k, v) VALUES(?, ?) '
              + 'ON CONFLICT(k) DO UPDATE SET v = excluded.v')
              .run(DIRTY_KEY, nowIso());
          } catch (e) { /* 表还没建好时忽略 */ }
        }
      }
      return r;
    },
    /** 没有参数、多条语句的原样执行（建表、PRAGMA 用） */
    exec(sql) {
      return raw.exec(sql);
    },
    /**
     * 事务。嵌套调用时只有最外层真正 BEGIN/COMMIT（内层用 SAVEPOINT），
     * 这样上层组合多个操作时仍然是一个原子事务。
     * 抛异常 → 整体 ROLLBACK，绝不半成品。
     */
    tx(fn) {
      const nested = inTx > 0;
      const sp = 'sp_' + (inTx + 1) + '_' + Math.random().toString(36).slice(2, 7);
      if (nested) d.exec('SAVEPOINT ' + sp);
      else d.exec('BEGIN IMMEDIATE');
      inTx++;
      try {
        const out = fn(d);
        inTx--;
        if (nested) d.exec('RELEASE ' + sp);
        else d.exec('COMMIT');
        if (out && typeof out.then === 'function') {
          throw new Error('事务回调不能是异步函数（node:sqlite 是同步接口）');
        }
        return out;
      } catch (err) {
        inTx--;
        try {
          if (nested) d.exec('ROLLBACK TO ' + sp), d.exec('RELEASE ' + sp);
          else d.exec('ROLLBACK');
        } catch (e) { /* ignore */ }
        throw err;
      }
    },
    inTransaction() { return inTx > 0; },
    /**
     * 有没有"还没备份的改动"。
     * 判据是**库里那条持久标记**（不是内存变量）——
     * 这样重启之后仍然知道"上次那些改动备份过了没有"。
     */
    isDirty() {
      if (dirty) return true;                       // 本进程改过，肯定脏
      try {
        const row = raw.prepare('SELECT v FROM schemaMeta WHERE k = ?').get(DIRTY_KEY);
        return !!(row && row.v);
      } catch (e) {
        return dirty;                                // 表还没建好 → 退回内存判断
      }
    },
    /** 标记"已经备份过了"（备份成功后调）——同时清掉库里那条标记 */
    markClean() {
      dirty = false;
      markerSet = false;
      try {
        raw.prepare('DELETE FROM schemaMeta WHERE k = ?').run(DIRTY_KEY);
      } catch (e) { /* ignore */ }
    },
    /** 手动置脏（极少用；正常写库会自动置） */
    markDirty() {
      dirty = true;
      if (!markerSet) {
        markerSet = true;
        try {
          raw.prepare('INSERT INTO schemaMeta(k, v) VALUES(?, ?) '
            + 'ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(DIRTY_KEY, nowIso());
        } catch (e) { /* ignore */ }
      }
    },

    /** 关库（先合并 WAL，避免 -wal 文件残留） */
    close() {
      try { d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignore */ }
      try { raw.close(); } catch (e) { /* ignore */ }
    },

    /**
     * 备份到指定文件（用 sqlite 官方 backup，WAL 下也安全）。
     * 不使用 fs.copyFileSync：WAL 模式下复制主文件会丢掉还没合并的事务。
     */
    async backupTo(target) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // 覆盖已存在文件：先删，避免 backup 追加到旧库
      try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch (e) { /* ignore */ }
      const { backup } = require('node:sqlite');
      /* 【版本兼容】sqlite.backup() 是 Node 22.16 才加进 22.x 分支的
         （更早的 22.5~22.15 只有 DatabaseSync，没有 backup）。
         声明 engines >=22.5 而直接用 backup()，会让 22.5~22.15 上
         "备份"整条路直接抛 TypeError —— 现场恰恰最怕备份坏掉。
         这里做一次能力探测：没有 backup 就退回"先 checkpoint 再复制文件"，
         WAL 已经合并过，复制出来就是一致的。 */
      if (typeof backup === 'function') {
        await backup(raw, target);
        return target;
      }
      try { raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignore */ }
      if (file === ':memory:') throw new Error('这个 Node 版本（' + process.version
        + '）没有 sqlite 备份接口，内存库无法备份');
      fs.copyFileSync(file, target);
      return target;
    },

    /** 把库里的全部数据导出成普通 JS 对象（导出全量 JSON 用） */
    dump() {
      const tables = d.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
      const out = {};
      for (const t of tables) {
        out[t.name] = d.all('SELECT * FROM "' + t.name + '"');
      }
      return out;
    },
  };
  return d;
}

/* ── 元信息读写 ───────────────────────────────────────────────────────── */

function getMeta(d, key, fallback) {
  const row = d.get('SELECT v FROM schemaMeta WHERE k = ?', [key]);
  return row ? row.v : (fallback === undefined ? null : fallback);
}

function setMeta(d, key, value) {
  d.run('INSERT INTO schemaMeta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
    [key, String(value)]);
}

/* ── 预览副本 ─────────────────────────────────────────────────────────── */

/**
 * 造一个"内存里的数据副本"用于预览。
 * 做法：把当前库**备份到临时文件**再作为内存库打开 —— 比"临时替换全局 state 再还原"安全得多，
 * 中途抛异常也不会污染真实数据。
 * @returns {object} 副本数据库（用完记得 close 并删文件）
 */
function cloneForPreview(d) {
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sports-preview-'));
  const file = path.join(tmpDir, 'preview.db');
  // 同步备份一份（预览是低频操作，同步可接受；避免异步回调里状态错乱）
  const { backup } = require('node:sqlite');
  // node:sqlite 的 backup 是异步的；这里用同步复制 + WAL 合并的替代方案：
  // 先把 WAL 合并进主库，再直接复制文件（此刻主库是完整的一致的）
  try { d.exec('PRAGMA wal_checkpoint(FULL)'); } catch (e) { /* ignore */ }
  fs.copyFileSync(d.file, file);
  const copy = new DatabaseSync(file);
  const wrapped = wrap(copy, file);
  setup(wrapped);
  wrapped.__previewDir = tmpDir;
  wrapped.__isPreview = true;
  // 预览副本不要往真实库回写：备份接口在副本上直接报错
  wrapped.backupTo = async function () { throw new Error('预览副本不能做备份'); };
  void backup;
  return wrapped;
}

/** 销毁预览副本 */
function destroyPreview(copy) {
  if (!copy) return;
  try { copy.close(); } catch (e) { /* ignore */ }
  const dir = copy.__previewDir;
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
}

/* ── 便捷查询（多处要用的小工具放这里，避免各文件重复写 SQL） ─────────── */

/** 当前届（没启用任何一届时返回第一行；空库返回 null） */
function currentMeet(d) {
  return d.get('SELECT * FROM meet WHERE isCurrent = 1 AND archived = 0 ORDER BY createdAt LIMIT 1')
    || d.get('SELECT * FROM meet WHERE archived = 0 ORDER BY createdAt LIMIT 1')
    || d.get('SELECT * FROM meet ORDER BY createdAt LIMIT 1')
    || null;
}

/** 记一次审计（谁/何时/改了什么/前后值） */
function audit(d, opts) {
  d.run(`INSERT INTO auditLog(id, meetId, userId, userName, action, target, beforeJson, afterJson, detail, ip, sessionId, createdAt)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [
    makeId('au'),
    opts.meetId || null,
    opts.userId || null,
    opts.userName || null,
    opts.action || 'unknown',
    opts.target || null,
    opts.before === undefined ? null : JSON.stringify(opts.before),
    opts.after === undefined ? null : JSON.stringify(opts.after),
    opts.detail || null,
    opts.ip || null,
    opts.sessionId || null,
    nowIso(),
  ]);
}

module.exports = {
  open, wrap, setup, createAll, migrate, MIGRATIONS,
  getMeta, setMeta, cloneForPreview, destroyPreview,
  currentMeet, audit, SCHEMA_VERSION,
};
