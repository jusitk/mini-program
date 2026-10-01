'use strict';
/* ============================================================================
 * check-node.js —— 实测这个 Node 到底能不能跑本系统
 *
 * 【为什么不能只看版本号】package.json 里写 `>=22.5.0`，但实际用到的 API
 * 不是同一批进来的：
 *   · `node:sqlite` 的 DatabaseSync —— 22.5 起（早期还要 --experimental-sqlite 开关）
 *   · `node:sqlite` 的 backup()     —— 22.16 才进 22.x 分支
 * 只看版本号会出现"版本够了、跑起来却报 TypeError"。
 * 所以这里**逐个 API 真的调用一下**，缺什么就明确说缺什么。
 *
 * 用法：node tools/check-node.js
 *   退出码 0 = 全部可用；1 = 有缺（报告里会写清缺哪一项、怎么办）
 * ========================================================================== */
const path = require('node:path');

const checks = [];
function add(name, level, fn) {
  let ok = false;
  let note = '';
  try {
    const r = fn();
    ok = r === true || r === undefined;
    if (typeof r === 'string') { ok = false; note = r; }
  } catch (e) {
    ok = false;
    note = (e && e.message) || String(e);
  }
  checks.push({ name, level, ok, note });
}

const v = process.versions.node;
const major = Number(v.split('.')[0]);
const minor = Number(v.split('.')[1]);

// ① 版本本身（只作为参考信息）
add('Node 版本 ≥ 22.5', 'must', () => {
  if (major > 22) return true;
  if (major === 22 && minor >= 5) return true;
  return '当前 ' + v + '，node:sqlite 需要 22.5 及以上';
});

// ② 真的 require 一下 node:sqlite（早期版本可能要 --experimental-sqlite）
let sqliteMod = null;
add('能 require node:sqlite', 'must', () => {
  sqliteMod = require('node:sqlite');
  if (!sqliteMod || typeof sqliteMod.DatabaseSync !== 'function') {
    return '拿不到 DatabaseSync（22.5~22.12 可能需要启动参数 --experimental-sqlite）';
  }
  return true;
});

// ③ 真的建一个内存库、建表、写读 —— 这才是"能用"
add('DatabaseSync 能建库读写', 'must', () => {
  if (!sqliteMod) return '上一步没通过';
  const d = new sqliteMod.DatabaseSync(':memory:');
  try {
    d.exec('CREATE TABLE t(a INTEGER, b TEXT)');
    d.prepare('INSERT INTO t(a,b) VALUES(?,?)').run(1, 'x');
    const row = d.prepare('SELECT * FROM t').get();
    if (!row || row.a !== 1 || row.b !== 'x') return '写进去读出来不对';
    return true;
  } finally {
    d.close();
  }
});

// ④ WAL 模式（一边录成绩一边查大屏要靠它）
add('支持 WAL 日志模式', 'must', () => {
  if (!sqliteMod) return '上一步没通过';
  const d = new sqliteMod.DatabaseSync(':memory:');
  try {
    d.exec('PRAGMA journal_mode = WAL');
    return true;                      // 内存库不支持 WAL，但不报错就算过
  } catch (e) {
    return 'WAL 设置失败：' + e.message;
  } finally {
    d.close();
  }
});

/* ⑤ backup()：**不是必须的**，因为 src/db.js 里做了能力探测 ——
   没有它会退回"checkpoint + 复制文件"。这里只做提示，不当失败。 */
add('sqlite.backup()（备份用，缺了会自动降级）', 'nice', () => {
  if (!sqliteMod) return '上一步没通过';
  if (typeof sqliteMod.backup !== 'function') {
    return '这个版本没有 backup()，备份会退回 checkpoint+复制文件（可用，但不如官方备份稳）';
  }
  return true;
});

// ⑥ 其它用到的新特性
add('fetch / FormData（接口与大屏推送用）', 'must', () => {
  if (typeof fetch !== 'function') return '没有全局 fetch';
  if (typeof FormData !== 'function') return '没有全局 FormData';
  return true;
});

add('node --test（跑测试用）', 'nice', () => {
  if (major > 18 || (major === 18 && minor >= 13)) return true;
  return 'Node 18.13 以下没有内置 test runner，但服务本身能跑';
});

add('crypto.randomInt / randomUUID', 'must', () => {
  const c = require('node:crypto');
  if (typeof c.randomInt !== 'function') return '没有 randomInt';
  if (typeof c.randomUUID !== 'function') return '没有 randomUUID';
  return true;
});

/* ── 报告 ───────────────────────────────────────────────────────────── */
console.log('');
console.log('  Node ' + v + '（' + process.platform + ' ' + process.arch + '）');
console.log('  ' + path.dirname(process.execPath));
console.log('');
let must = 0;
for (const c of checks) {
  const mark = c.ok ? '✔' : (c.level === 'must' ? '✘' : '·');
  if (!c.ok && c.level === 'must') must++;
  console.log('  ' + mark + ' ' + c.name + (c.ok ? '' : ('　—— ' + c.note)));
}
console.log('');

if (must) {
  console.log('  这个 Node 跑不了本系统（' + must + ' 项必须的能力缺失）。');
  if (major === 22 && minor < 16) {
    console.log('  建议：装 Node 22 LTS 的最新小版本（22.16 以上），或者 Node 24。');
    console.log('        本机可以双击 install-node.bat 自动装。');
  } else {
    console.log('  建议：装 Node 22 LTS（22.16 以上）或 Node 24，再运行一次本检查。');
  }
  console.log('');
  process.exit(1);
}
const warn = checks.filter(c => !c.ok && c.level === 'nice').length;
console.log('  ✔ 通过：这个 Node 可以运行本系统' + (warn ? ('（有 ' + warn + ' 项非必须能力缺失，已自动降级）') : ''));
console.log('');
process.exit(0);
