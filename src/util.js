'use strict';
/**
 * 通用小工具：id、时间、数字、中文排序、安全文件名。
 *
 * 约定（整个项目都遵守，改的时候别破）：
 *   · 时间一律以 **UTC ISO 字符串** 存库，需要给"体育老师看"的地方在接口层按
 *     服务器本地时区格式化成 "2026-09-12 08:30"。
 *     理由：现场可能改服务器时区，存成本地字符串会整体错位；存 UTC 只是显示时换算。
 *   · 表示"没有"的列一律用 NULL，**绝不用空字符串**（SQLite 里空字符串是真实取值，
 *     会被当成无效外键直接报 FOREIGN KEY 失败）。
 */

const crypto = require('node:crypto');

/* ── id ─────────────────────────────────────────────────────────────── */

let idSeq = 0;

/** 生成短 id：前缀 + 时间基数 + 进程内自增，人眼可读且不会撞 */
function makeId(prefix) {
  idSeq = (idSeq + 1) % 100000;
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(3).toString('hex');
  return String(prefix || 'x') + '_' + t + idSeq.toString(36) + r;
}

/** 随机令牌（会话 id、CSRF） */
function randomToken(bytes) {
  return crypto.randomBytes(bytes || 24).toString('base64url');
}

/* ── 时间 ───────────────────────────────────────────────────────────── */

/** 当前时间（UTC ISO） */
function nowIso() {
  return new Date().toISOString();
}

/** 把一个 Date / 时间戳 / ISO 串统一成 ISO 串；无效返回 null */
function toIso(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return new Date(v).toISOString();
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  const s = String(v).trim();
  if (!s) return null;
  // 已经是 ISO（带 Z 或 +08:00）
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  // 不带时区的 "2026-09-12T08:30" → 按 **服务器本地时区** 解释
  // （项目时间是老师按本地钟点填的，不能当 UTC 读，否则会差 8 小时）
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const d = new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0), 0
    );
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** UTC ISO → 本地 "2026-09-12 08:30"（给接口层用） */
function fmtLocal(iso, withDate) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const time = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  if (withDate === false) return time;
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + time;
}

/** UTC ISO → 本地 "08:30"（只看钟点） */
function fmtClock(iso) {
  return fmtLocal(iso, false);
}

/** UTC ISO → "2026-09-12" */
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/* ── 项目时刻：只存 "HH:MM" ────────────────────────────────────────────────
 *
 * 【为什么需要这一对函数】本届比赛就一天，项目只需要"几点几分开始"，
 * 不需要日期。但如果直接存 "07:40"，`new Date("07:40")` 是**无效日期** ——
 * 名次排序、"按时间归位"（autoStatus）、大屏的"还有几分钟"全都会算不出来
 * （而且是**静默**算不出来，最难查）。
 *
 * 所以约定：**存 "HH:MM"，用的时候补上"今天"**。
 * 老的 ISO 值（如 "2026-09-30T07:40"）继续认，免得历史数据显示不出来。
 */

/** 规范成 "HH:MM"；认不出返回 '' */
function toClockStr(v) {
  if (!v) return '';
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) {
    const h = Number(m[1]), mi = Number(m[2]);
    if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) return pad2(h) + ':' + pad2(mi);
    return '';
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    if (isNaN(d.getTime())) return '';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  return '';
}

/**
 * "HH:MM"（或老 ISO）→ 毫秒时间戳，补上"今天"。
 * @param {string} v 时刻值
 * @param {number} [nowMs] 基准时刻（默认现在）—— 测试要传，免得依赖真实时间
 * @returns {number} 毫秒；认不出返回 NaN
 */
function clockToMs(v, nowMs) {
  const c = toClockStr(v);
  if (!c) return NaN;
  const h = Number(c.slice(0, 2)), mi = Number(c.slice(3, 5));
  const base = new Date(nowMs === undefined ? Date.now() : nowMs);
  base.setHours(h, mi, 0, 0);
  return base.getTime();
}

/** UTC ISO → value for <input type="datetime-local">（本地时间，不带时区） */
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** 生日/日期字符串 → 年龄用的天数差（用于"距开幕还有几天"之类，可不用） */
function dayDiff(aIso, bIso) {
  const a = new Date(aIso), b = new Date(bIso);
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((a - b) / 86400000);
}

/* ── 数字 ───────────────────────────────────────────────────────────── */

function num(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback === undefined ? 0 : fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

/** 四舍五入到 n 位小数（避免 0.1+0.2 这类浮点尾巴） */
function round(v, n) {
  const p = Math.pow(10, n === undefined ? 2 : n);
  return Math.round((Number(v) + Number.EPSILON) * p) / p;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/* ── 文本 ───────────────────────────────────────────────────────────── */

function str(v, max) {
  if (v === null || v === undefined) return '';
  let s = String(v).replace(/\r\n?/g, '\n').trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

/** 表示"空"的输入统一变 NULL（数据库层面绝不能出现空字符串外键） */
function orNull(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s === '' ? null : s;
}

/** 中文友好排序：数字优先，其次按拼音（localeCompare zh） */
const zhCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
function zhCompare(a, b) {
  return zhCollator.compare(String(a === null || a === undefined ? '' : a),
    String(b === null || b === undefined ? '' : b));
}

/** 年级排序权重：初一..初三 / 高一..高三 在前，其它按字典序垫后 */
const GRADE_ORDER = ['初一', '初二', '初三', '高一', '高二', '高三'];
function gradeRank(grade) {
  const g = String(grade || '').replace(/\s/g, '');
  let i = GRADE_ORDER.indexOf(g);
  if (i >= 0) return i;
  // "七年级/八年级/九年级"、"1年级" 等写法归一
  const m = g.match(/^([一二三四五六七八九1-9])年/);
  if (m) {
    const cn = '一二三四五六七八九';
    const idx = cn.indexOf(m[1]) >= 0 ? cn.indexOf(m[1]) : Number(m[1]) - 1;
    if (idx >= 0 && idx <= 2) return idx;          // 七/八/九 → 初一/二/三
    if (idx >= 3 && idx <= 5) return idx - 3 + 3;  // 高一/二/三
  }
  return 90; // 其它年级（小学等）排到最后，内部按字典序
}

/** 班级名归一："1班" / "一班" / "01" / "高一(1)班" → 可比较的排序键 */
function classRank(className) {
  const s = String(className || '');
  const m = s.match(/(\d+)/);
  if (m) return Number(m[1]);
  const cn = '一二三四五六七八九十';
  const c = s.match(/([一二三四五六七八九十])班/);
  if (c) return cn.indexOf(c[1]) + 1;
  return 999;
}

/**
 * 班级显示名：年级 + 班级，避免不同年级的"1班"混淆。
 *
 * 【为什么加了"已经含年级就不重复拼"】现场导入的名单里「班级」列写的是
 *   **带年级的全称**（"初一（1）班"、"高一36班"），而「年级」列另有值（"初一"/"高一"）。
 *   老实现一律拼成 `年级(班级)`，于是大屏和名单上显示成：
 *      初一(初一（1）班)      高一(高一36班)
 *   年级出现两遍，又长又难读（用户报的就是这个）。
 *
 * 现在的口径：
 *   · 班级名**以年级开头**（含"初中/高中/年级"这类后缀写法）→ 直接用班级名
 *   · 否则才拼 年级(班级)  —— 这种才是真正需要消歧义的情况（"高一" + "3班"）
 */
function classLabel(grade, className) {
  const g = str(grade).trim(), c = str(className).trim();
  if (!c) return g || '';
  if (!g) return c;
  /* 年级变体也认：初一 / 初一年级 / 初中 —— 都算"班级名里已经带了年级" */
  const variants = [g, g.replace(/年级$/, ''), g.replace(/^初/, '初中'), g.replace(/^高/, '高中')]
    .filter(Boolean)
    .map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));   // 转义，别让年级名当正则用
  /* 年级后面**不是汉字**就算"已经含年级了"：
       初一（1）班   → 后面是全角括号 ✔
       初一1班       → 后面是数字 ✔（数字是班级序号，不是年级的一部分）
       初一(1)班     → 半角括号 ✔
       初一年级3班   → 变体命中 ✔
     而 高一 / 3班 这种（班级名不以年级开头）**不命中** → 才需要拼成 高一(3班)。 */
  const head = new RegExp('^(' + variants.join('|') + ')($|[^\\u4e00-\\u9fa5])');
  if (head.test(c)) return c;          // 班级名里已经含年级 → 不重复拼
  return g + '(' + c + ')';            // 否则拼上，用于区分不同年级的同名班
}

/**
 * 把 "高一(1)班" / "高一1班" / "高一（1）" / "高三41班" 拆成 { grade, className }
 *
 * 【为什么不能只靠一条正则】原来用的是
 *   `/^(.+?)[\s(（]*([0-9一二三四五六七八九十]+)\s*[)）班]?\s*$/`
 * 非贪婪的年级组配贪婪的班级组，遇到"高三41班"会把**年级里的"三"**
 * 当成班级数字吃掉：拆成 grade="高"、className="三41班" —— 年级排错、班级也错。
 * （名单里的"高三36班"就是这么被拆错的，而且不会报错，只会安静地排错序。）
 *
 * 现在两条路：
 *   ① 先按**已知年级**匹配开头（初一…高三，以及"七年级"这类写法）—— 最稳
 *   ② 匹配不到再退回原来那条宽松正则
 * 并且班级数字**不再接收中文数字**（年级已经吃掉了它们），
 * 这样"三41班"这种结果就不可能再出现。
 */
const GRADE_PREFIXES = (function () {
  const list = GRADE_ORDER.slice();
  // 常见别名：加"年级"后缀、以及"七年级"这类
  ['七年级', '八年级', '九年级', '1年级', '2年级', '3年级',
    '4年级', '5年级', '6年级'].forEach(g => list.push(g));
  GRADE_ORDER.forEach((g) => { list.push(g + '年级'); });
  // 长的排前面，避免"高一"抢在"高一年级"前面匹配
  return list.sort((a, b) => b.length - a.length);
})();

function splitTeam(team, grade, className) {
  const g0 = str(grade), c0 = str(className);
  if (g0 && c0) return { grade: g0, className: c0 };
  const s = str(team).replace(/\s+/g, '');
  if (!s) return { grade: g0, className: c0 };

  // ① 已知年级开头：剩下的部分就是班级
  for (const g of GRADE_PREFIXES) {
    if (s.indexOf(g) !== 0) continue;
    const rest = s.slice(g.length).replace(/^[（(]|[)）班]$/g, '').trim();
    const num = rest.match(/^(\d+)/);
    return { grade: g0 || g, className: c0 || (num ? num[1] + '班' : '') };
  }

  // ② 兜底：宽松匹配（班级只收阿拉伯数字，不再收中文数字）
  const m = s.match(/^(.+?)[\s(（]*([0-9]+)\s*[)）班]?\s*$/);
  if (m) return { grade: g0 || m[1], className: c0 || (m[2] + '班') };
  return { grade: g0 || s, className: c0 };
}

/** 文件名安全化（备份名、导出名都要用，防路径穿越） */
function safeFilePart(s, fallback) {
  const out = String(s === null || s === undefined ? '' : s)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return out || (fallback || 'file');
}

/* ── 其它 ───────────────────────────────────────────────────────────── */

/** 等一会儿（给重试退避用） */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 数组按 key 分组 → Map */
function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list || []) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

/** 服务器本地时区偏移（分钟），启动横幅与前端时钟校准用 */
function tzOffsetMinutes() {
  return -new Date().getTimezoneOffset();
}

module.exports = {
  makeId, randomToken,
  nowIso, toIso, fmtLocal, fmtClock, fmtDate, toLocalInput, dayDiff, tzOffsetMinutes,
  toClockStr, clockToMs,
  num, round, clamp,
  str, orNull, zhCompare, gradeRank, classRank, classLabel, splitTeam,
  GRADE_ORDER, safeFilePart, sleep, groupBy, pad2,
};
