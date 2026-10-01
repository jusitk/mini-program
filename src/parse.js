'use strict';
/**
 * parse.js —— 成绩解析与格式化
 *
 * 【为什么单独一个文件、为什么必须报错】
 *   成绩是现场老师手输的，来源五花八门：手机输入法会打出全角数字和全角冒号，
 *   有人写"12.35"、有人写"2:15.30"、有人写"5.67米"、有人写"弃权"。
 *   历史教训：**无法识别的输入绝不能静默当成数字**。
 *   例如把 "12.35mm" 当成 12.35 秒，成绩就错了，而且事后没人看得出来。
 *   所以这里的原则是：认不出来就抛错，让人自己看着办。
 *
 * 支持：
 *   12.35        → 12.35 秒（径赛）
 *   2:15.30      → 135.30 秒（分:秒.百分秒）
 *   1:02:15.30   → 3735.30 秒（时:分:秒.百分秒）
 *   5.67 / 5.67米 / 5.67m → 5.67 米（田赛）
 *   12.35秒 / 12"35  → 径赛秒数（带单位不改变数值，只做校验）
 *   弃权 / 受伤 / 退赛 / 犯规 / DNS / DNF / - / × → 弃权
 *   试跳犯规（田赛单次）：X / × / 犯规 → 该次犯规（有记录但没有成绩）
 *   空字符串 → 删除这条成绩（由调用方处理，这里返回 { empty: true }）
 *
 * 不支持（明确报错）：
 *   12.35mm、abc、12.35.6、2:75（秒数≥60）等
 */

/* ── 归一化 ───────────────────────────────────────────────────────────── */

/** 全角 → 半角；顺手把中文单位与常见符号理一遍（手机输入法重灾区） */
function normalize(input) {
  let s = String(input === null || input === undefined ? '' : input);
  // 全角数字 ０-９ → 0-9
  s = s.replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  // 全角句点/冒号/逗号/空格
  s = s.replace(/\uFF0E/g, '.').replace(/\uFF1A/g, ':')
    .replace(/\uFF0C/g, ',').replace(/\u3000/g, ' ');
  // 中文冒号、希腊问号之类
  s = s.replace(/[：]/g, ':').replace(/[．。]/g, '.');
  // 各种破折号统一成 -
  s = s.replace(/[\u2010-\u2015\u2212\uFF0D]/g, '-');
  // 撇号/双撇号（12'35" 这种写法）
  s = s.replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D\u2033]/g, '"');
  // 全角括号
  s = s.replace(/[\uFF08]/g, '(').replace(/[\uFF09]/g, ')');
  // 连续空白压成一个
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/* ── 弃权、犯规这类"非数字"标记 ───────────────────────────────────────── */

const DNF_WORDS = [
  '弃权', '弃赛', '退赛', '受伤', '伤退', '请假', '缺席', '未到', '未参加', '没来',
  'dns', 'dnf', 'dq', 'dsq', 'nm', 'wd', 'w/o', 'wo',
  '-', '--', '—', '/', '无', '空', '取消', '取消资格', '免',
];

const FOUL_WORDS = ['犯规', 'x', '×', '✕', '✗', 'foul', 'f', '试跳犯规'];

/** 判是否弃权 */
function isDnf(s) {
  const t = s.toLowerCase();
  return DNF_WORDS.indexOf(t) >= 0;
}

/** 判是否单次试跳犯规（有记录、无成绩） */
function isFoul(s) {
  const t = s.toLowerCase();
  return FOUL_WORDS.indexOf(t) >= 0;
}

/* ── 数字与时间 ───────────────────────────────────────────────────────── */

/** 严格数字：只允许 123 / 12.3 / .5；不允许 12.3.4、12,3 之类 */
function strictNumber(s) {
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 去掉尾部单位：秒 / 米 / m / s / 分 / 分秒 */
function stripUnit(s) {
  let t = s;
  let hint = null;
  const m = t.match(/^(.*?)\s*(米|m|M|公尺|秒|s|S|sec|秒数|分|min)$/);
  if (m) {
    t = m[1].trim();
    const u = m[2].toLowerCase();
    if (u === '米' || u === 'm' || u === '公尺') hint = 'field';
    else if (u === '秒' || u === 's' || u === 'sec' || u === '秒数') hint = 'track';
  }
  return { value: t, hint };
}

/**
 * 解析一条成绩输入。
 *
 * @param {string} input 用户原样输入
 * @param {object} [opts]
 *   @param {string} [opts.kind]  'track' | 'field'  项目类型（用于合理性提示）
 *   @param {string} [opts.unit]  项目单位（'秒' / '米' / '分:秒'），仅用于报错措辞
 * @returns {{empty:boolean}|{dnf:boolean}|{foul:boolean}|{value:number, seconds:number|null, raw:string}}
 * @throws {Error} 认不出来时抛错，错误信息是给老师看的中文
 */
function parseResult(input, opts) {
  opts = opts || {};
  const raw = String(input === null || input === undefined ? '' : input);
  const s = normalize(raw);

  // 空 = 删除这条成绩（由调用方处理）
  if (s === '') return { empty: true };

  // 弃权类
  if (isDnf(s)) return { dnf: true, raw: s };

  // 犯规类（田赛单次试跳）
  if (isFoul(s)) return { foul: true, raw: s };

  // 去掉单位
  const su = stripUnit(s);
  let body = su.value;

  // 12'35" 的写法 → 12.35
  const apos = body.match(/^(\d+)\s*'\s*(\d+(?:\.\d+)?)\s*"?$/);
  if (apos) body = apos[1] + ':' + apos[2];

  // 带冒号的时间：H:MM:SS.xx / M:SS.xx
  if (body.indexOf(':') >= 0) {
    const parts = body.split(':').map(x => x.trim());
    if (parts.length < 2 || parts.length > 3) {
      throw new Error('时间格式不对：「' + raw + '」应该是 2:15.30（分:秒）或 1:02:15.30（时:分:秒）');
    }
    const nums = parts.map((p, idx) => {
      const n = strictNumber(p);
      if (n === null) throw new Error('时间里的「' + p + '」不是数字：' + raw);
      if (n < 0) throw new Error('时间不能是负数：' + raw);
      return n;
    });
    // 除第一段外，每段都必须 < 60
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] >= 60) throw new Error('「' + parts[i] + '」不能大于等于 60（' + raw + '）');
    }
    let seconds = 0;
    for (const n of nums) seconds = seconds * 60 + n;
    if (!isFinite(seconds) || seconds <= 0) throw new Error('成绩必须大于 0：' + raw);
    return { value: seconds, seconds, raw: s, unitHint: 'track' };
  }

  // 纯数字
  const n = strictNumber(body);
  if (n === null) {
    throw new Error('认不出这个成绩：「' + raw + '」。可以填 12.35（秒）、2:15.30（分:秒）、5.67（米），或者填「弃权」');
  }
  if (n <= 0) throw new Error('成绩必须大于 0：' + raw);

  // 合理性检查：径赛输入裸数字但大于 60 的（比如 1:30 填成 130）提醒一下，
  // 但不阻断 —— 1500 米本来就可能是 300 秒以上，长跑手计时也确实会写纯秒数。
  if (opts.kind === 'track' && n >= 60 && !/[:\uFF1A]/.test(s)) {
    // 只在数字很像"分秒连写"时才提示（如 130、214），超过 900 秒（15 分钟）不管
    const asDigits = String(n).replace(/\.\d+$/, '');
    if (asDigits.length === 3 && n < 900) {
      const mm = Number(asDigits.slice(0, 1)), ss = Number(asDigits.slice(1));
      if (ss < 60 && mm >= 1) {
        return {
          value: n, seconds: n, raw: s, unitHint: 'track',
          warning: '如果本意是 ' + mm + ' 分 ' + ss + ' 秒，请填 ' + mm + ':' + String(ss).padStart(2, '0'),
        };
      }
    }
  }

  return { value: n, seconds: opts.kind === 'field' ? null : n, raw: s, unitHint: su.hint };
}

/* ── 格式化 ───────────────────────────────────────────────────────────── */

/**
 * 成绩 → 显示文本。
 *   径赛：< 60 秒 → "12.35"；≥ 60 秒 → "2:15.30"；≥ 1 小时 → "1:02:15.30"
 *   田赛："5.67"
 */
function formatResult(value, kind) {
  if (value === null || value === undefined || value === '') return '';
  const v = Number(value);
  if (!Number.isFinite(v)) return '';
  if (kind === 'field') return v.toFixed(2);
  if (v < 60) return v.toFixed(2);
  if (v < 3600) {
    const m = Math.floor(v / 60);
    const s = v - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }
  const hh = Math.floor(v / 3600);
  const mm = Math.floor((v - hh * 3600) / 60);
  const ss = v - hh * 3600 - mm * 60;
  return hh + ':' + String(mm).padStart(2, '0') + ':' + (ss < 10 ? '0' : '') + ss.toFixed(2);
}

/** 弃权统一显示这两个字（大屏、成绩单、导出都用它） */
const DNF_LABEL = '弃权';
const FOUL_LABEL = '犯规';

/** 给"距离"这类成绩（跳远、铅球）加上名次提示用的单位 */
function unitLabel(kind) {
  return kind === 'field' ? '米' : '秒';
}

/* ── 并列规则：按**计时精度**定义"相等" ─────────────────────────────────
 *
 * 【原来错在哪】并列容差默认 0.01，并把它当成"差 ≤ 0.01 就算并列"。
 * 那 0.01 是**浮点误差的容忍值**（12.01 - 12.02 在 double 里是 -0.009999…），
 * 不是竞赛规则。后果：12.01 秒和 12.02 秒被判成并列第 1 ——
 * 而这是两个不同的成绩，本该是第 1 名和第 2 名。
 *
 * 【现在怎么做】容差 = **这个项目的计时精度**，"相等"就是
 * **显示出来的读数一模一样**：
 *   · 0.01  百分位电子计时（最常见）→ 12.34 只和 12.34 并列
 *   · 0.001 千分位（终点摄像）      → 12.341 与 12.342 是两个人
 *   · 0.1   十分位手工计时          → 12.3 与 12.3 并列，12.3 与 12.4 不并列
 *   · 1     整秒                    → 12 与 12 并列
 *
 * 判等用**四舍五入到该精度再比**，而不是"差 ≤ 精度"：
 * 后者会把 12.34 和 12.35 算成并列（差正好等于精度），而那显然是两个人。
 * 比的时候留一个极小的浮点余量（见 TIE_EPS），免得 0.1+0.2 这种
 * 二进制误差把"本来相等"的两个数判成不等。
 */

/** 给"按精度取整后比相等"留的浮点余量（只抵二进制误差，不参与竞赛判断） */
const TIE_EPS = 1e-9;

/** 允许的精度档位（管理界面就是这四个选项） */
const TOL_PRESETS = [0.001, 0.01, 0.1, 1];

/** 档位 → 中文说法（界面、导出说明、成绩单都用它，避免各处自己硬写） */
const TOL_LABEL = {
  0.001: '千分位（0.001 秒，终点摄像）',
  0.01: '百分位（0.01 秒，电子计时）',
  0.1: '十分位（0.1 秒，手工计时）',
  1: '整秒（1 秒）',
};

/** 田赛的精度就是量到的最小单位：1 厘米 = 0.01 米 */
const FIELD_TOL = 0.01;

/** 某个项目的默认精度：田赛按量具，径赛按电子计时 */
function defaultTol(kind) {
  return kind === 'field' ? FIELD_TOL : 0.01;
}

/**
 * 把容差规格化成上面四个档位之一。
 * 库里可能有历史遗留的怪值（比如 0.05、NaN），一律归到最近的档位，
 * 免得判等逻辑拿到一个没意义的值。
 */
function normTol(tol, kind) {
  const t = Number(tol);
  if (!Number.isFinite(t) || t <= 0) return defaultTol(kind);
  if (t >= 0.5) return 1;
  if (t >= 0.05) return 0.1;
  if (t >= 0.005) return 0.01;
  return 0.001;
}

/** 精度 → 小数位数（0.001→3、0.01→2、0.1→1、1→0） */
function decimalsOf(tol) {
  const t = normTol(tol);
  if (t >= 1) return 0;
  if (t >= 0.1) return 1;
  if (t >= 0.01) return 2;
  return 3;
}

/** 按精度四舍五入（判等前先去到这个刻度上） */
function roundTo(value, tol) {
  const p = Math.pow(10, decimalsOf(tol));
  return Math.round(Number(value) * p) / p;
}

/**
 * 两个成绩是否并列 —— **按计时精度**判断，也就是"显示出来的读数是否相同"。
 * @param {number} a
 * @param {number} b
 * @param {number} tol 该项目的精度（0.001 / 0.01 / 0.1 / 1）
 */
function isTie(a, b, tol) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const t = normTol(tol);
  // 同一刻度上的两个数，差小于半个刻度就算同一个读数
  // （用半个刻度而不是"≤ t"，是为了让 12.34 与 12.35 明确不算并列）
  const half = t / 2;
  return Math.abs(roundTo(a, t) - roundTo(b, t)) < half + TIE_EPS;
}

/** 成绩单/导出里那句说明："并列规则：…" */
function tieRuleText(tol) {
  const t = normTol(tol);
  const lbl = TOL_LABEL[t] || (t + ' 秒');
  return '同名次判定：成绩按' + lbl + '取整后相同的，名次并列（并列后名次跳号，如 1、2、2、4）';
}

module.exports = {
  normalize, parseResult, formatResult, isTie,
  isDnf, isFoul, DNF_LABEL, FOUL_LABEL, unitLabel,
  TOL_PRESETS, TOL_LABEL, FIELD_TOL, defaultTol, normTol, decimalsOf, roundTo, tieRuleText,
};
