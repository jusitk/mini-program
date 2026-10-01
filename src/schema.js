'use strict';
/**
 * schema.js —— 表结构定义与建表 SQL
 *
 * 【改这里的时候必须同时做的事】
 *   · 把 SCHEMA_VERSION 加 1
 *   · 在 db.js 的 MIGRATIONS 里补一段升级代码（老库要能平滑升上来，
 *     现场可能已经在库里录了半天成绩，绝不能要求"清库重来"）
 *
 * 【两条硬规矩（踩过坑）】
 *   1. 指向别的表的列如果表示"没有"，一律用 NULL，**绝不能写空字符串**：
 *      SQLite 里空字符串是真实取值，会被当成无效外键 → 直接 FOREIGN KEY 报错。
 *   2. 名次**不存库**。名次是从成绩实时算出来的派生数据，存了必然不一致
 *      （改一条成绩要连带改几十行名次，一旦漏改大屏就出错）。所以每次查询现算。
 */

const SCHEMA_VERSION = 11;

const DDL = `
PRAGMA foreign_keys = ON;

/* ── 版本 ─────────────────────────────────────────────────────────────── */
CREATE TABLE IF NOT EXISTS schemaMeta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

/* ── 运动会（本届 + 历史届次；一次只启用一届，其余归档） ─────────────── */
CREATE TABLE IF NOT EXISTS meet (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  subtitle    TEXT,
  host        TEXT,
  holdDate    TEXT,
  timezone    TEXT,
  ruleJson    TEXT,            -- 计分规则（名次分表、录取人数、并列算法）
  screenJson  TEXT,            -- 大屏配置（栏目开关、显示模式、翻页秒数、校名配色）
  rev         INTEGER NOT NULL DEFAULT 1,   -- 版本号：每次改动 +1，大屏靠它判断"数据变了"
  isCurrent   INTEGER NOT NULL DEFAULT 1,   -- 0/1
  archived    INTEGER NOT NULL DEFAULT 0,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);

/* ── 账号 ─────────────────────────────────────────────────────────────── */
CREATE TABLE IF NOT EXISTS user (
  id           TEXT PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE,
  displayName  TEXT NOT NULL,
  role         TEXT NOT NULL,          -- admin 管理员 / operator 操作员 / viewer 只读
  pwdSalt      TEXT NOT NULL,
  pwdHash      TEXT NOT NULL,
  disabled     INTEGER NOT NULL DEFAULT 0,
  pwdChangedAt TEXT,
  createdAt    TEXT NOT NULL,
  updatedAt    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id         TEXT PRIMARY KEY,
  userId     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  createdAt  TEXT NOT NULL,
  expiresAt  TEXT NOT NULL,
  lastSeenAt TEXT,
  ip         TEXT,
  agent      TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_user ON session(userId);

/* ── 组别（男子组 / 女子组；也允许"混合组"） ─────────────────────────── */
CREATE TABLE IF NOT EXISTS groupDef (
  id      TEXT PRIMARY KEY,
  meetId  TEXT NOT NULL REFERENCES meet(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0,
  kind    TEXT              -- male / female / mixed（班级总分榜要用）
);
CREATE INDEX IF NOT EXISTS idx_group_meet ON groupDef(meetId);

/* ── 班级（年级 + 班级名） ────────────────────────────────────────────── */
CREATE TABLE IF NOT EXISTS classDef (
  id         TEXT PRIMARY KEY,
  meetId     TEXT NOT NULL REFERENCES meet(id) ON DELETE CASCADE,
  grade      TEXT NOT NULL,
  className  TEXT NOT NULL,
  label      TEXT NOT NULL,     -- "高一(1)班"
  sortGrade  INTEGER NOT NULL DEFAULT 0,
  sortClass  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_class_meet ON classDef(meetId);

/* ── 运动员 ───────────────────────────────────────────────────────────── */
CREATE TABLE IF NOT EXISTS athlete (
  id         TEXT PRIMARY KEY,
  meetId     TEXT NOT NULL REFERENCES meet(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  groupId    TEXT NOT NULL REFERENCES groupDef(id) ON DELETE RESTRICT,
  classId    TEXT REFERENCES classDef(id) ON DELETE SET NULL,
  grade      TEXT,
  className  TEXT,
  team       TEXT,               -- 大屏"单位/班级"列显示的字；空则用 年级(班级)
  bib        TEXT,               -- 号码（可空）
  gender     TEXT,
  note       TEXT,
  blocked    INTEGER NOT NULL DEFAULT 0,  -- 1=已屏蔽：仍留在库里，但成绩展示页不展示（见 v11 迁移）
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_athlete_meet  ON athlete(meetId);
CREATE INDEX IF NOT EXISTS idx_athlete_group ON athlete(groupId);
CREATE INDEX IF NOT EXISTS idx_athlete_class ON athlete(classId);
CREATE INDEX IF NOT EXISTS idx_athlete_bib   ON athlete(meetId, bib);

/* ── 项目 ─────────────────────────────────────────────────────────────── */
CREATE TABLE IF NOT EXISTS event (
  id            TEXT PRIMARY KEY,
  meetId        TEXT NOT NULL REFERENCES meet(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  groupId       TEXT NOT NULL REFERENCES groupDef(id) ON DELETE RESTRICT,
  kind          TEXT NOT NULL,          -- track 径赛（越小越好）/ field 田赛（越大越好）
  stage         TEXT NOT NULL DEFAULT 'final',  -- heat 预赛 / final 决赛
  isRelay       INTEGER NOT NULL DEFAULT 0,     -- 接力：按班级/队排名
  relayLegs     INTEGER,                        -- 接力棒数（4x100 → 4）
  day           INTEGER,
  startAt       TEXT,                   -- UTC ISO；到点自动变"进行中"
  endAt         TEXT,                   -- UTC ISO；到点自动变"已结束"
  venue         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending / live / done
  statusMode    TEXT NOT NULL DEFAULT 'auto',    -- auto 按时间自动 / manual 手动锁定
  attempts      INTEGER NOT NULL DEFAULT 1,      -- 田赛试跳次数（1 = 只记一次）
  tol           REAL NOT NULL DEFAULT 0.01,      -- 成绩差 ≤ tol 视为并列
  unit          TEXT,                            -- 秒 / 米 / 分:秒（只用于显示提示）
  advanceFromId TEXT REFERENCES event(id) ON DELETE SET NULL,  -- 决赛指向它的预赛
  advanceCount  INTEGER NOT NULL DEFAULT 6,      -- 录取前几名进决赛
  sort          INTEGER NOT NULL DEFAULT 0,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_meet   ON event(meetId);
CREATE INDEX IF NOT EXISTS idx_event_status ON event(meetId, status);
CREATE INDEX IF NOT EXISTS idx_event_sort   ON event(meetId, sort);

/* ── 报名（名单）：个人一行一人；接力一行一队 ─────────────────────────── */
CREATE TABLE IF NOT EXISTS registration (
  id           TEXT PRIMARY KEY,
  meetId       TEXT NOT NULL REFERENCES meet(id) ON DELETE CASCADE,
  eventId      TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  athleteId    TEXT REFERENCES athlete(id) ON DELETE SET NULL,  -- 接力队的"队长/联系人"可空
  classId      TEXT REFERENCES classDef(id) ON DELETE SET NULL, -- 接力按班级成队
  teamName     TEXT,                                            -- 接力队显示名（班级名）
  legsJson     TEXT,                                            -- 接力 4 名队员姓名的快照（英文数组）
  lane         INTEGER,                                         -- 道次
  sort         INTEGER NOT NULL DEFAULT 0,
  createdAt    TEXT NOT NULL,
  updatedAt    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reg_event   ON registration(eventId);
CREATE INDEX IF NOT EXISTS idx_reg_athlete ON registration(athleteId);
CREATE INDEX IF NOT EXISTS idx_reg_class   ON registration(classId);
CREATE INDEX IF NOT EXISTS idx_reg_meet    ON registration(meetId);

/* ── 成绩 ─────────────────────────────────────────────────────────────────
 * 挂在"报名条目"上而不是直接挂运动员：接力才有地方放"一个班一条成绩"。
 * 田赛试跳：一次一行，attempt 从 1 开始。value 为纯数值（径赛=秒，田赛=米）。
 * ------------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS result (
  id           TEXT PRIMARY KEY,
  meetId       TEXT NOT NULL REFERENCES meet(id) ON DELETE CASCADE,
  eventId      TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  regId        TEXT NOT NULL REFERENCES registration(id) ON DELETE CASCADE,
  attempt      INTEGER NOT NULL DEFAULT 1,
  value        REAL,                     -- 弃权时为 NULL
  dnf          INTEGER NOT NULL DEFAULT 0,
  raw          TEXT,                     -- 老师原样输入的内容（"2:15.30"、"弃权"），便于追溯
  foul         INTEGER NOT NULL DEFAULT 0, -- 试跳犯规（有 raw 但无 value）
  isBest       INTEGER NOT NULL DEFAULT 0, -- 该条目最好一次（写入时重算，便于查询排序）
  version      INTEGER NOT NULL DEFAULT 1, -- 乐观锁：客户端提交它看到的版本
  clientUuid   TEXT,                       -- 幂等：同一条重复补交只落一条
  source       TEXT,                       -- entry 录入页 / admin 后台 / import 导入
  byUserId     TEXT REFERENCES user(id) ON DELETE SET NULL,
  byName       TEXT,
  recordedAt   TEXT NOT NULL,
  updatedAt    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_result_uuid   ON result(clientUuid) WHERE clientUuid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_result_slot   ON result(regId, attempt);
CREATE INDEX IF NOT EXISTS idx_result_event  ON result(eventId);
CREATE INDEX IF NOT EXISTS idx_result_reg    ON result(regId);

/* ── 检录 ─────────────────────────────────────────────────────────────── */
CREATE TABLE IF NOT EXISTS checkinState (
  eventId   TEXT PRIMARY KEY REFERENCES event(id) ON DELETE CASCADE,
  open      INTEGER NOT NULL DEFAULT 0,
  startedAt TEXT,
  stoppedAt TEXT,
  byUserId  TEXT REFERENCES user(id) ON DELETE SET NULL,
  byName    TEXT
);

CREATE TABLE IF NOT EXISTS checkin (
  id         TEXT PRIMARY KEY,
  eventId    TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  regId      TEXT NOT NULL REFERENCES registration(id) ON DELETE CASCADE,
  arrived    INTEGER NOT NULL DEFAULT 0,
  at         TEXT,
  byUserId   TEXT REFERENCES user(id) ON DELETE SET NULL,
  byName     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_slot ON checkin(eventId, regId);

/* ── 公告 ─────────────────────────────────────────────────────────────── */
CREATE TABLE IF NOT EXISTS notice (
  id        TEXT PRIMARY KEY,
  meetId    TEXT NOT NULL REFERENCES meet(id) ON DELETE CASCADE,
  text      TEXT NOT NULL,
  level     TEXT NOT NULL DEFAULT 'normal',   -- normal 普通轮播 / important 大字滚动
  until     TEXT,                             -- 重要公告到什么时候自动回落
  pinned    INTEGER NOT NULL DEFAULT 0,
  eventId   TEXT REFERENCES event(id) ON DELETE SET NULL,  -- 由检录自动生成的公告
  auto      INTEGER NOT NULL DEFAULT 0,                    -- 1 = 系统自动生成（可被覆盖更新）
  byUserId  TEXT REFERENCES user(id) ON DELETE SET NULL,
  byName    TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notice_meet ON notice(meetId, createdAt);

/* ── 聊天室 ───────────────────────────────────────────────────────────── */
CREATE TABLE IF NOT EXISTS chatMessage (
  id         TEXT PRIMARY KEY,
  meetId     TEXT NOT NULL REFERENCES meet(id) ON DELETE CASCADE,
  userId     TEXT REFERENCES user(id) ON DELETE SET NULL,
  userName   TEXT,
  role       TEXT,
  text       TEXT,
  kind       TEXT NOT NULL DEFAULT 'text',    -- text / image / system（语音 audio 已去掉）
  attachId   TEXT,                            -- 附件 id（存在 upload 表）
  clientUuid TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_meet ON chatMessage(meetId, createdAt);

/* ── 附件（聊天图片；存磁盘，库里只记元信息）
   注：语音功能已去掉（浏览器要求麦克风跑在安全上下文里，局域网 HTTP 用不了），
   所以 kind 只会是 image。durationMs 列保留着不用 —— 删列要重建表，
   为了一列无用的数据去动老师的库不值当。 */
CREATE TABLE IF NOT EXISTS upload (
  id         TEXT PRIMARY KEY,
  meetId     TEXT REFERENCES meet(id) ON DELETE CASCADE,
  fileName   TEXT NOT NULL,        -- 磁盘上的安全文件名（不含路径）
  origName   TEXT,
  mime       TEXT,
  size       INTEGER NOT NULL DEFAULT 0,
  kind       TEXT,                 -- 只可能是 image
  durationMs INTEGER,              -- 早期语音功能留下的列，现在不用
  byUserId   TEXT,
  byName     TEXT,
  createdAt  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upload_meet ON upload(meetId, createdAt);

/* ── 暂存区：后台改动先落这里，统一"确认"才写进正式表并推大屏 ─────────── */
CREATE TABLE IF NOT EXISTS stagedOp (
  id          TEXT PRIMARY KEY,
  meetId      TEXT NOT NULL REFERENCES meet(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  op          TEXT NOT NULL,
  payloadJson TEXT NOT NULL,
  label       TEXT,
  baseVersion TEXT,             -- 暂存时看到的整届版本号（只作参考，不用来判冲突）
  baseSnapshot TEXT,            -- 暂存时**目标记录**的字段快照（JSON）—— 确认时逐字段比对
  byUserId    TEXT,
  byName      TEXT,
  createdAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staged_meet ON stagedOp(meetId, seq);

/* ── 审计日志 ─────────────────────────────────────────────────────────── */
CREATE TABLE IF NOT EXISTS auditLog (
  id         TEXT PRIMARY KEY,
  meetId     TEXT,
  userId     TEXT,
  userName   TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  beforeJson TEXT,
  afterJson  TEXT,
  detail     TEXT,
  ip         TEXT,
  /* 是哪一次登录做的（v9 新增）。
     有了它，"这个 IP 以前登录过吗"才能问准 —— 否则没法把
     **本次登录自己写的那条 user.login 记录**排除掉，
     于是每个 IP 都被算成"来过"，异地登录就永远标不出来。
     老记录的这一列是 NULL，判定时按"没关联会话"处理。 */
  sessionId  TEXT,
  createdAt  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON auditLog(createdAt);
CREATE INDEX IF NOT EXISTS idx_audit_meet ON auditLog(meetId, createdAt);

/* ── 幂等表：同一个 clientUuid 只生效一次（断网补交、重复点击都不会录成两条） ── */
CREATE TABLE IF NOT EXISTS idempotency (
  clientUuid   TEXT PRIMARY KEY,
  op           TEXT NOT NULL,
  responseJson TEXT,
  createdAt    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idem_time ON idempotency(createdAt);

/* ── 备份记录（磁盘上的 .db 文件 + 这里的说明） ───────────────────────── */
CREATE TABLE IF NOT EXISTS backupLog (
  id        TEXT PRIMARY KEY,
  fileName  TEXT NOT NULL,
  reason    TEXT,
  size      INTEGER,
  byName    TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backup_time ON backupLog(createdAt);

/* ── 会话被"顶掉"的说明（v10） ─────────────────────────────────────────
 *
 * 【为什么需要一张表】现在的规则是**一个账号只能在一台设备上登录**：
 * 从新设备登录，旧设备就被顶下线。但"被顶下线"必须**说得出原因** ——
 * 否则老师看到的是"页面突然不能用了 / 一直提示重新登录"，
 * 会以为系统坏了，或者以为自己被盗号了。
 *
 * 服务端在顶掉旧会话时会往这里写一条说明；旧设备下次请求
 * （轮询、刷新页面、点任何东西）就能查到，从而弹出
 * "这个账号在另一台设备上登录了，你已被下线"。
 *
 * 行是**短命**的：会话清理（pruneSessions）时顺手删掉超过 10 分钟的记录。
 * 页面关掉五分钟后再打开才想起来看，那时直接当普通未登录处理就行。
 * ---------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS kickNote (
  sessionId TEXT PRIMARY KEY,
  reason    TEXT,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kick_time ON kickNote(at);
`;

/** 所有表名（测试与自检用） */
const TABLES = [
  'schemaMeta', 'meet', 'user', 'session', 'groupDef', 'classDef', 'athlete',
  'event', 'registration', 'result', 'checkinState', 'checkin', 'notice',
  'chatMessage', 'upload', 'stagedOp', 'auditLog', 'backupLog', 'idempotency',
  'kickNote',
];

module.exports = { SCHEMA_VERSION, DDL, TABLES };
