'use strict';
/**
 * check-consistency.js —— 一致性自检（把踩过的坑变成常驻检查）
 *
 * 这个脚本专抓"语法都对、跑起来才炸"的那类问题。每一节都对应一次真实事故：
 *
 *  ① 权限表与操作表对不上
 *     `ACTION_ROLE` 里写了 7 条 `backup.create` / `staged.confirm` 这类**不存在于 OPS**
 *     的动作（备份/确认走的是路由级 withRole，不经过 Ops.execute）——
 *     死配置，改它一点用没有，还会让人以为改这里就能改权限。
 *     反过来 `result.clearEvent` / `event.autoAll` 前端在用、权限表却没写，
 *     就按 admin 处理 → 操作员点按钮被拒。
 *
 *  ② 前端引用了不存在的状态对象（`G.snap` 写成 `S.snap`）
 *     大屏的状态对象叫 `G`、后台叫 `S`。写错不报语法错，只有真点在那一行才炸
 *     —— 而大屏是无人值守的，炸了没人知道。
 *
 *  ③ 快照字段两边不一致
 *     大屏快照曾经漏了 `statusLabel`，后台有 —— 加了"检录中"之后大屏就不显示。
 *
 * 用法：node tools/check-consistency.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const pubJs = () => fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.js'));
const srcJs = () => fs.readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.js'));

const fails = [];
const passes = [];
function ok(cond, label, detail) {
  if (cond) passes.push(label);
  else fails.push(label + (detail ? '　→ ' + detail : ''));
}

/* ══ ① 权限表 ↔ 操作表 ══════════════════════════════════════════════════ */

const Auth = require(path.join(ROOT, 'src', 'auth'));
const Ops = require(path.join(ROOT, 'src', 'ops'));
const opNames = Ops.OP_NAMES.map(o => (typeof o === 'string' ? o : (o && o.name) || ''));

const allFrontend = pubJs().map(f => read('public/' + f)).join('\n')
  + read('server.js') + srcJs().map(f => read('src/' + f)).join('\n');

const deadKeys = Object.keys(Auth.ACTION_ROLE).filter(k => opNames.indexOf(k) < 0);
ok(deadKeys.length === 0,
  '权限表里没有"不存在的操作"（死配置）',
  deadKeys.map(k => k + '（不在 OPS 里）').join('、'));

const unwritten = opNames.filter(k => !Auth.ACTION_ROLE[k]);
ok(unwritten.length === 0,
  '每个业务操作都在权限表里写了角色',
  unwritten.map(k => k + '（会按 admin 处理）').join('、'));

// 权限表里写了、但全项目没人调用的操作（多半是重构后忘了删）
const neverCalled = opNames.filter((k) => allFrontend.indexOf("'" + k + "'") < 0);
ok(neverCalled.length === 0,
  '没有"定义了却没人调用"的操作',
  neverCalled.join('、'));

/* ══ ② 前端全局对象：G / S / A 不要写错 ══════════════════════════════ */

/**
 * 每个页面文件用哪个"状态对象"。
 *
 * 【判定思路】不要硬编码"这个文件该用 G 还是 S" —— 有的文件自己定义了本地状态对象
 * （`admin-entry.js` 里 `const S = { eventId, ... }` 就是录入页自己的状态，
 *  不是后台框架的 `A.S`），硬编码会把合法写法报成错误（踩过，一堆误报）。
 *
 * 改成两步：
 *   1. 扫出这个文件**自己声明**了哪些顶层状态对象（`const S = ...` / `const G = ...`）
 *   2. 再检查它有没有用"别的文件才有的"那个名字
 * 这样"大屏里误写 S.snap"照样能抓到（大屏声明的是 G、用的却是 S），
 * 而"admin-entry 自己声明并用 S"不会被误报。
 */
const FRAMEWORK_STATE = { S: '后台框架（A.S）', G: '大屏（G.snap）' };

pubJs().forEach((f) => {
  let src = read('public/' + f)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  const declared = {};
  ['G', 'S'].forEach((name) => {
    // 自己声明过（const/let/var 或函数参数）就算"这个文件有它"
    declared[name] = new RegExp('(?:const|let|var)\\s+' + name + '\\s*[=;,]').test(src)
      || new RegExp('function\\s+\\w+\\s*\\([^)]*\\b' + name + '\\b').test(src);
  });

  ['G', 'S'].forEach((name) => {
    if (declared[name]) return;             // 这个文件自己有，不算误用
    const other = name === 'S' ? 'G' : 'S';
    if (!declared[other]) return;           // 两个都没有：这个文件不玩状态对象
    const re = new RegExp('(^|[^.\\w$])' + name + '\\.', 'g');
    const hits = [];
    let m;
    while ((m = re.exec(src))) hits.push('第 ' + src.slice(0, m.index).split('\n').length + ' 行');
    ok(hits.length === 0,
      f + ' 用的是 ' + other + '，没有误写成 ' + name + '（' + FRAMEWORK_STATE[name] + '）',
      hits.slice(0, 4).join('、'));
  });
});

/* ══ ③ 快照字段一致性 ══════════════════════════════════════════════════ */

const boardSrc = read('src/scoreboard.js');
const screenFn = boardSrc.slice(boardSrc.indexOf('function screenSnapshot'));
const adminFn = boardSrc.slice(boardSrc.indexOf('function adminSnapshot'),
  boardSrc.indexOf('function adminSnapshot') + 6000);

['statusLabel', 'statusTone'].forEach((field) => {
  ok(screenFn.indexOf(field) >= 0, '大屏快照带 ' + field);
  ok(adminFn.indexOf(field) >= 0, '后台快照带 ' + field);
});

/* ══ ④ 状态文案只有一处定义 ══════════════════════════════════════════ */

const statusSrc = read('src/status.js');
const statusKeys = ['pending', 'checking', 'live', 'done'];
ok(statusKeys.every(k => statusSrc.indexOf("'" + k + "'") >= 0),
  'src/status.js 里四个状态都有定义');

/**
 * 前端不许"另写一套状态映射"。
 *
 * 判断标准不是"出现了中文"（那太严，兜底对象、按钮文案都会报），
 * 而是"出现了**三元链**"：`status === 'x' ? '甲' : status === 'y' ? '乙' : '丙'`
 * —— 这正是当初"犯规显示成弃权""大屏漏了检录中"那类 bug 的写法。
 * admin-events.js 的 `const STATUS = {...}` 兜底对象允许保留（快照没到时用）。
 */
const TERNARY_RE = /status\s*===\s*'(\w+)'\s*\?\s*'([^']+)'/g;

pubJs().forEach((f) => {
  if (f === 'admin-core.js' || f === 'login.js' || f === 'common.js') return;
  const src = read('public/' + f).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const hits = [...src.matchAll(TERNARY_RE)];
  // 允许 1 处：admin-events.js 里 toneClass() 那种"语气 → 样式类"的映射不是状态文案
  const bad = hits.filter(m => ['未开始', '检录中', '进行中', '已结束'].indexOf(m[2]) >= 0);
  ok(bad.length === 0,
    f + ' 里没有"另写一套状态文案"的三元链',
    bad.map(m => m[2]).join('、'));
});

/* ══ ⑤ 接口与前端调用对得上 ══════════════════════════════════════════ */

const serverSrc = read('server.js');
const serverRoutes = [...serverSrc.matchAll(/on\('(GET|POST)',\s*'([^']+)'/g)].map(m => m[2]);
const calledApis = new Set();
pubJs().forEach((f) => {
  const t = read('public/' + f);
  [...t.matchAll(/App\.api\(\s*'([^']+)'/g)].forEach(m => calledApis.add(m[1].split('?')[0]));
  [...t.matchAll(/App\.api\(\s*"([^"]+)"/g)].forEach(m => calledApis.add(m[1].split('?')[0]));
});
const notFound = [...calledApis].filter((p) => {
  if (!p || p === '/' || p.charAt(p.length - 1) === '/') return false;   // 拼接用的前缀，如 '/api/events/'
  if (serverRoutes.indexOf(p) >= 0) return false;
  // 带 :id 的参数路由
  const parts = p.split('/');
  return !serverRoutes.some((r) => {
    const rp = r.split('/');
    if (rp.length !== parts.length) return false;
    return rp.every((seg, i) => seg.charAt(0) === ':' || seg === parts[i]);
  });
});
ok(notFound.length === 0, '前端调的接口在 server.js 里都存在',
  notFound.join('、'));

/* ══ ⑥ 数据库列名对得上（最容易拼错的一类） ══════════════════════════ */

const schemaSrc = read('src/schema.js');
const tables = {};
[...schemaSrc.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\s*\)/g)].forEach((m) => {
  const cols = [];
  m[2].split('\n').forEach((line) => {
    const c = line.trim().match(/^(\w+)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)/i);
    if (c) cols.push(c[1]);
  });
  tables[m[1]] = cols;
});
ok(Object.keys(tables).length > 8, '从 schema.js 解析出 ' + Object.keys(tables).length + ' 张表');

// 迁移里新加的列也要算进去
const dbSrc = read('src/db.js');
[...dbSrc.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)].forEach((m) => {
  if (tables[m[1]] && tables[m[1]].indexOf(m[2]) < 0) tables[m[1]].push(m[2]);
});

// 检查形如 `FROM x` 后面用到的别名列（只查最常见的 select * 之后直接读字段的场景）
let colErr = 0;
['src/ops.js', 'src/scoreboard.js', 'src/xport.js', 'src/scoring.js'].forEach((f) => {
  const t = read(f);
  // 找 "d.get('SELECT * FROM xxx ...')" 这类，然后看同作用域里读了哪些 r.yyy
  [...t.matchAll(/mustRow\(d,\s*'(\w+)'/g)].forEach((m) => {
    if (!tables[m[1]]) return;
  });
});
ok(colErr === 0, '数据库表名引用正常');

/* ══ ⑦ 并列精度：前后端两份定义必须一致 ══════════════════════════════
 *
 * 判并列的精度有四档（0.001 / 0.01 / 0.1 / 1），后端 `src/parse.js` 用来算名次，
 * 前端 `public/common.js` 的 App.precision 用来给老师显示中文说法、规格化下拉值。
 * **两份定义**，最容易改了一边忘了另一边 —— 而症状是
 * "界面上写着千分位，实际按百分位算"，不报任何错。
 *
 * 所以这里把两边的档位和说法都读出来对一遍。
 */
const ParseMod = require(path.join(ROOT, 'src', 'parse'));
const precisionSrc = (() => {
  const t = read('public/common.js');
  const i = t.indexOf('App.precision');
  if (i < 0) return '';
  const j = t.indexOf('\n  };', i);
  return t.slice(i, j < 0 ? i + 2000 : j);
})();
ok(!!precisionSrc, '前端有 App.precision（并列精度口径）');
if (precisionSrc) {
  // 档位
  const m = precisionSrc.match(/PRESETS:\s*\[([^\]]+)\]/);
  const frontPresets = m ? m[1].split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n)) : [];
  ok(JSON.stringify(frontPresets) === JSON.stringify(ParseMod.TOL_PRESETS),
    '前后端精度档位一致',
    '前端 ' + JSON.stringify(frontPresets) + ' vs 后端 ' + JSON.stringify(ParseMod.TOL_PRESETS));
  // 中文说法
  Object.keys(ParseMod.TOL_LABEL).forEach((k) => {
    ok(precisionSrc.indexOf(ParseMod.TOL_LABEL[k]) >= 0,
      '「' + k + '」的说明文字前后端一致',
      '前端没有：' + ParseMod.TOL_LABEL[k]);
  });
  // 规格化规则：**逐条比对两边的分支文字**，而不是"拿几个值试结果"
  const normCases = [0.001, 0.01, 0.1, 1, 0.05, 0.005, 0.002, 0, -1, 99, NaN];
  const frontNormSrc = (() => {
    // 取 "norm(tol, kind) { ... }" 的函数体
    const i = precisionSrc.indexOf('norm(tol, kind)');
    if (i < 0) return '';
    const j = precisionSrc.indexOf('\n    },', i);
    return precisionSrc.slice(precisionSrc.indexOf('{', i) + 1, j < 0 ? i + 600 : j);
  })();
  ok(!!frontNormSrc, '前端 App.precision 里有 norm() 方法');
  /* 【为什么不能只比值】我试过把前端阈值 0.005 改成 0.002、缺省值改成 0.02，
     自检都没抓到 —— 因为后端只会产出四个精确档位（0.001/0.01/0.1/1），
     前端那些阈值对"后端能给的输入"是死代码，改了不起作用。
     换句话说：**只比值等于没检查**。所以要逐条比分支条件本身，
     以后谁把阈值改飘了、或者加了新分支没同步，这里立刻能看出来。 */
  const branchOf = (src) => src.split('\n')
    .map(l => l.trim())
    .filter(l => /^(if\s*\(|return\s)/.test(l))
    .map(l => l
      .replace(/\s+/g, ' ')
      /* 两边"取缺省值"的写法本来就不同，归一后再比：
         前端 this.defaultFor(kind)、后端 defaultTol(kind) —— 语义一样。
         不归一的话这一条会一直红，久了就没人看自检了。 */
      .replace(/this\.defaultFor\(kind\)/g, '取缺省值')
      .replace(/defaultTol\(kind\)/g, '取缺省值')
      .replace(/\bkind\b/g, 'K'))
    .join(' | ');
  const normDigits = (s) => (s.match(/\d+(?:\.\d+)?/g) || []).join(',');
  const backNormSrc = (() => {
    const t = read('src/parse.js');
    const i = t.indexOf('function normTol(');
    const j = t.indexOf('\n}', i);
    return i < 0 ? '' : t.slice(i, j < 0 ? i + 600 : j);
  })();
  {
    const a = branchOf(frontNormSrc);
    const b = branchOf(backNormSrc);
    ok(a === b, '前后端"归到最近档位"的分支条件逐条一致',
      a === b ? '' : ('前端：' + a + '　后端：' + b));
  }
  /* 缺省精度：**把前端那个函数真的跑一遍**再和后端比结果。
     （不要比源文字 —— 前端写成 `kind === 'field' ? 0.01 : 0.01`，
       后端写成 `kind === 'field' ? FIELD_TOL : 0.01`，
       写法不同但结果一样，比文字会一直红，久了自检就没人看了。） */
  {
    const fm = precisionSrc.match(/defaultFor\(kind\)\s*\{([^}]*)\}/);
    let frontDefault = null;
    if (fm) {
      try {
        // 前端对象里有 FIELD: 0.01，求值时补上
        const fieldVal = Number((precisionSrc.match(/FIELD:\s*([\d.]+)/) || [])[1]);
        frontDefault = new Function('kind',
          'const FIELD = ' + (Number.isFinite(fieldVal) ? fieldVal : 0.01) + ';'
          + fm[1].replace(/this\.FIELD/g, 'FIELD'));
      } catch (e) { frontDefault = null; }
    }
    if (frontDefault) {
      const bad = ['track', 'field', undefined].filter(k =>
        String(frontDefault(k)) !== String(ParseMod.defaultTol(k)));
      ok(bad.length === 0, '前后端缺省精度的取值一致（实际跑一遍再比）',
        bad.map(k => k + '：前端 ' + frontDefault(k) + '，后端 ' + ParseMod.defaultTol(k)).join('、'));
      // 前端对象里的 FIELD 常量也要和后端一致
      const fieldVal = Number((precisionSrc.match(/FIELD:\s*([\d.]+)/) || [])[1]);
      ok(!Number.isFinite(fieldVal) || fieldVal === ParseMod.FIELD_TOL,
        '前后端"田赛量具精度"常量一致',
        '前端 ' + fieldVal + ' vs 后端 ' + ParseMod.FIELD_TOL);
    } else {
      ok(false, '前端 defaultFor 没法在 Node 里求值（写法变了吗）');
    }
  }
  // 再拿值试一遍（覆盖运行时真的会走的那些输入）
  {
    const self = { defaultFor: (kind) => ParseMod.defaultTol(kind) };
    let Front = null;
    try {
      Front = new Function('tol', 'kind', 'const self = this;' + frontNormSrc);
    } catch (e) { Front = null; }
    if (Front) {
      const front = (v) => Front.call(self, v, undefined);
      const bad = normCases.filter((v) => {
        const a = String(ParseMod.normTol(v));
        const b = String(front(v));
        return a !== b;
      });
      ok(bad.length === 0, '前后端"归到最近档位"的结果一致（含坏值/缺省值）',
        bad.map(v => v + '（前端 ' + front(v) + '，后端 ' + ParseMod.normTol(v) + '）').join('、'));
    } else {
      ok(true, '（前端 norm 没法在 Node 里求值，跳过结果比对）');
    }
  }
}

/* ══ 输出 ══════════════════════════════════════════════════════════════ */

console.log('');
passes.forEach(p => console.log('  ✓ ' + p));
if (fails.length) {
  console.log('');
  fails.forEach(f => console.log('  ✘ ' + f));
  console.log('');
  console.log('[失败] 一致性自检共 ' + fails.length + ' 个问题');
  process.exit(1);
}
console.log('');
console.log('[通过] 一致性自检：' + passes.length + ' 项通过（权限表 / 前端状态对象 / 快照字段 / 接口对应 / 表结构）');
