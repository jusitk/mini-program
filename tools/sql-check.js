#!/usr/bin/env node
'use strict';
/**
 * sql-check.js —— 手写 SQL 的静态自检（Windows / Node v22 / CommonJS / 零第三方依赖）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一、这个脚本防的是什么坑
 * ══════════════════════════════════════════════════════════════════════════
 * 本项目用 Node 内置的 node:sqlite 手写 SQL（不走 ORM，没有类型检查兜底）。
 * 手写的 INSERT / UPDATE 一旦「占位符数 ≠ 实参个数」，SQLite **不报错**：
 *   · 实参少了  → 缺的那个参数被当成 NULL 静默写进库；
 *   · 实参多了  → 多的值被丢掉，写入"看起来成功"。
 * 结果就是某一列永远空白 / 外键变成 NULL，页面上一片空白；
 * 现场录数据的运动会等发现时可能已经错了几百条，事后极难定位。
 * 所以要在**开发阶段、跑起来之前**用静态检查把它抓出来：
 *
 *     d.run('INSERT INTO athlete(id, name, bib) VALUES(?,?,?)', [id, name])   ← 少一个，抓！
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 二、为什么「列数」不再要求等于「占位符数」
 * ══════════════════════════════════════════════════════════════════════════
 * 老版本要求 INSERT 的列数 == 占位符数，结果对这种**完全合法**的写法误报：
 *
 *     d.run(`INSERT INTO user(id, username, displayName, role, pwdSalt, pwdHash,
 *                             disabled, createdAt, updatedAt)
 *            VALUES(?,?,?,?,?,?,0,?,?)`, [...]);
 *
 * 这里 disabled 列直接写常量字面量 0（合法、常见，而且比多绑一个 0 更清楚）：
 * 列 9 个、占位符 8 个、实参 8 个 —— 完全正确，却因为 9 ≠ 8 被判失败。
 * 结论：**唯一能证明参数绑对了的等式是「占位符数 == 实参个数」**。
 * 列数只作为信息附在报告里（"（列 9）"）方便人核对，不参与判定。
 * 同理，UPDATE 的 SET 项数也不再参与判定（`arrived = 1` 这种字面量赋值很常见）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三、本项目的真实调用风格（本脚本按这些风格识别）
 * ══════════════════════════════════════════════════════════════════════════
 *   · d.run('UPDATE athlete SET name = ?, bib = ? WHERE id = ?', [p.name, bib, a.id])
 *       包装层 d（名字随意：d / db / copy / wrapped / probe …）的第二个参数是**数组**，
 *       实参个数 = 数组元素个数。也允许 d.run(sql)（无参数，此时占位符必须为 0）。
 *   · d.get(sql, params) / d.all(sql, params) —— 同上。
 *   · d.raw.prepare(sql).run(a, b, c) —— 原始语句对象是**变参**，不是一个数组。
 *   · const stmt = x.prepare('...'); stmt.run(a, b) —— 变量形式也能对上。
 *   · SQL 里允许直接写常量字面量（`arrived = 1`、`VALUES(?,?,0,?)`），只数占位符。
 *   · 多行模板字符串、INSERT OR REPLACE / INSERT OR IGNORE 前缀都支持。
 *   · 命名参数 ?1/:name/@name/$name 按**唯一名字**计数（?1 只算一个序号）。
 *   · 动态拼接的 SQL（'DELETE FROM ' + t + ' WHERE meetId = ?'、`...${x}...`、变量形式）
 *     静态算不出来：只在含 INSERT / VALUES / UPDATE 时报一条「可疑」，**不影响退出码**。
 *   · 代码注释（// 与块注释）里的 SQL 一律不算。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 四、什么时候跑
 * ══════════════════════════════════════════════════════════════════════════
 *   · 改完任何写了 SQL 的 .js 之后：npm run check:sql
 *   · 让 AI 写完一段 CRUD 之后、提交代码之前（npm run check 会连带跑它）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 五、用法与退出码
 * ══════════════════════════════════════════════════════════════════════════
 *   node tools/sql-check.js
 *   node tools/sql-check.js --root=F:\运动会计分系统        （默认：本文件所在目录的上一级）
 *   node tools/sql-check.js --root=.\_sqlcheck_tmp          （指向夹具目录做测试）
 *
 *   扫描范围：server.js + src/ 下所有 .js（递归）。
 *   退出码：有硬失败 → 1；否则 → 0（「可疑」不改变退出码）；
 *           根目录 / src 目录不存在 → 打印 [跳过] 并 exit 0。
 *   只做文本层面的检查：不连数据库、不 require 任何项目代码、不写任何文件。
 */

const fs = require('node:fs');
const path = require('node:path');

/* ══════════════════════════════════════════════════════════════════════════
 * 零、通用小工具
 * ══════════════════════════════════════════════════════════════════════════ */

/** 动态拼接处的占位标记：源码里绝不可能出现 \u0001，用它把"这里拼了个变量"标出来 */
const DYN = '\u0001';

/** 路径统一成 /，输出好看 */
function slash(p) { return String(p).replace(/\\/g, '/'); }

/** 输出顺序稳定（先按文件、再按行） */
function cmpLoc(a, b) { return (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.line - b.line); }

/** JS 标识符字符（允许中文名，如 :班级） */
const JS_ID_START = /[\p{L}_$]/u;
const JS_ID_CHAR = /[\p{L}\p{N}_$]/u;

/** SQL 里命名参数的字符（:name @name $name） */
const SQL_ID_START = /[\p{L}_]/u;
const SQL_ID_CHAR = /[\p{L}\p{N}_]/u;

/** 认得出是 SQL 的开头关键字（用来区分 Map.get('key') 这种同名的非数据库调用） */
const SQL_START = /^(SELECT|INSERT|REPLACE|UPDATE|DELETE|WITH|PRAGMA|CREATE|DROP|ALTER|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ANALYZE|ATTACH|DETACH|EXPLAIN)\b/i;

/** 可能是数据库调用的方法名（包装层 d.run/d.get/d.all/d.exec 与原始 d.raw.prepare） */
const DB_METHODS = new Set(['run', 'get', 'all', 'exec', 'prepare', 'iterate', 'each', 'values', 'pluck']);
/** 其中"要绑定参数"的方法（exec 不绑定参数） */
const BIND_METHODS = new Set(['run', 'get', 'all', 'iterate', 'each', 'values', 'pluck']);

/** 这些关键字后面的 / 是正则而不是除号（return /re/、typeof /re/ …） */
const REGEX_AFTER_KW = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'case', 'delete',
  'void', 'new', 'do', 'else', 'yield', 'await', 'throw']);

const isPunct = (tk, v) => !!tk && tk.t === 'punct' && tk.v === v;

/* ══════════════════════════════════════════════════════════════════════════
 * 一、极简 JS 词法：只要认得出「字符串 / 模板字符串 / 标识符 / 标点」。
 *    不做语法分析、不 require 项目代码、不执行任何东西。
 *    token 形状：{ t:'id'|'num'|'str'|'tpl'|'regex'|'punct', v 或 parts, line }
 * ══════════════════════════════════════════════════════════════════════════ */

/** 转义序列：只取反斜杠后面那个字符本身（够用：判断 SQL 关键字不关心 \n 的真实含义） */
function escapeChar(src, i) { return i + 1 < src.length ? src[i + 1] : ''; }

function lexJs(src) {
  const toks = [];
  let i = 0;
  let line = 1;
  let lastTok = null;               // 全局上一个 token（模板 ${} 内层也要用，所以不放在局部）
  const n = src.length;

  function emit(sink, tk) { sink.push(tk); lastTok = tk; }

  /** 跳过空白与注释：注释里的 SQL 一律不算（明确需求） */
  function skipTrivia() {
    for (;;) {
      const c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' ||
          c === '\u00a0' || c === '\ufeff') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { i += 2; while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
        i += 2; continue;
      }
      return;
    }
  }

  /** 单/双引号字符串 */
  function readString(sink, quote) {
    const startLine = line;
    i++;
    let out = '';
    while (i < n) {
      const c = src[i];
      if (c === '\\') { out += escapeChar(src, i); i += 2; continue; }
      if (c === quote) { i++; break; }
      if (c === '\n') line++;
      out += c; i++;
    }
    emit(sink, { t: 'str', v: out, line: startLine });
  }

  /** 模板字符串：字面量部分照收，${...} 里的表达式递归读成"动态段" */
  function readTemplate(sink) {
    const startLine = line;
    i++;                                    // 跳过 `
    const parts = [];
    let buf = '';
    while (i < n) {
      const c = src[i];
      if (c === '\\') { buf += escapeChar(src, i); i += 2; continue; }
      if (c === '`') { i++; break; }
      if (c === '$' && src[i + 1] === '{') {
        if (buf) { parts.push({ text: buf }); buf = ''; }
        i += 2;
        const inner = [];
        readCode(true, inner);              // 读到配对的 } 为止
        parts.push({ dyn: true, toks: inner });
        continue;
      }
      if (c === '\n') line++;
      buf += c; i++;
    }
    if (buf) parts.push({ text: buf });
    emit(sink, { t: 'tpl', parts, line: startLine });
  }

  /** 正则字面量：跳过就好（里面的 ( ) ' 之类绝不能当成代码） */
  function readRegex(sink) {
    const startLine = line;
    i++;                                    // 跳过 /
    let inClass = false;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') { line++; break; }    // 没配对的 / ：当成除号算了
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { i++; break; }
      i++;
    }
    while (i < n && /[a-z]/i.test(src[i])) i++;   // 标志位 giu…
    emit(sink, { t: 'regex', v: '', line: startLine });
  }

  /** 这个位置的 / 是正则还是除号 */
  function regexAllowed() {
    if (!lastTok) return true;
    if (lastTok.t === 'id') return REGEX_AFTER_KW.has(lastTok.v);   // return /re/ 是正则，a / b 是除号
    if (lastTok.t === 'num' || lastTok.t === 'str' || lastTok.t === 'tpl' || lastTok.t === 'regex') return false;
    if (lastTok.t === 'punct') {
      if (lastTok.v === ')' || lastTok.v === ']' || lastTok.v === '}' || lastTok.v === '+') return false;
      return true;                                                   // = ( [ { ; , : ! && || …
    }
    return true;
  }

  /**
   * 读一段代码 token。
   * stopAtBrace=true 时：读到与模板 ${ 配对的 } 就返回（该 } 吃掉，不产出 token）。
   */
  function readCode(stopAtBrace, sink) {
    let depth = 0;
    while (i < n) {
      skipTrivia();
      if (i >= n) return;
      const c = src[i];
      const startLine = line;

      if (c === '\'' || c === '"') { readString(sink, c); continue; }
      if (c === '`') { readTemplate(sink); continue; }

      if (c === '{') { depth++; emit(sink, { t: 'punct', v: '{', line: startLine }); i++; continue; }
      if (c === '}') {
        if (depth === 0 && stopAtBrace) { i++; return; }
        if (depth > 0) depth--;
        emit(sink, { t: 'punct', v: '}', line: startLine }); i++; continue;
      }

      if (c === '/' && src[i + 1] !== '=' && regexAllowed()) { readRegex(sink); continue; }

      if (JS_ID_START.test(c)) {
        let j = i, w = '';
        while (j < n && JS_ID_CHAR.test(src[j])) { w += src[j]; j++; }
        emit(sink, { t: 'id', v: w, line: startLine });
        i = j; continue;
      }

      if (c >= '0' && c <= '9') {
        let j = i;
        while (j < n && /[0-9a-fA-FxXoObB_.eE]/.test(src[j])) j++;
        if (src[j] === '+' || src[j] === '-') {                 // 只在指数里吃 +/-
          if (/[eE]/.test(src[j - 1] || '')) j++;
        }
        while (j < n && /[0-9]/.test(src[j])) j++;
        emit(sink, { t: 'num', v: src.slice(i, j), line: startLine });
        i = j; continue;
      }

      if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
        emit(sink, { t: 'punct', v: '...', line: startLine }); i += 3; continue;
      }

      emit(sink, { t: 'punct', v: c, line: startLine });
      i++;
    }
  }

  readCode(false, toks);
  return toks;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 二、实参解析：按顶层逗号切开一个调用的实参表
 * ══════════════════════════════════════════════════════════════════════════ */

/** 找到 toks[open] 那个括号的配对位置（判断"整个实参就是一个数组/对象字面量"要用） */
function matchClose(toks, open) {
  const o = toks[open].v;
  const c = o === '(' ? ')' : o === '[' ? ']' : '}';
  let depth = 0;
  for (let j = open; j < toks.length; j++) {
    const tk = toks[j];
    if (tk.t !== 'punct') continue;
    if (tk.v === o) depth++;
    else if (tk.v === c) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/** 按顶层分隔符切分（括号/方括号/花括号里的不算），空段丢掉（尾随逗号） */
function splitTop(toks, sep) {
  const out = [];
  let depth = 0, cur = [];
  for (const tk of toks) {
    if (tk.t === 'punct') {
      if (tk.v === '(' || tk.v === '[' || tk.v === '{') depth++;
      else if (tk.v === ')' || tk.v === ']' || tk.v === '}') depth = Math.max(0, depth - 1);
      else if (tk.v === sep && depth === 0) { out.push(cur); cur = []; continue; }
    }
    cur.push(tk);
  }
  out.push(cur);
  return out.filter(p => p.length);
}

/** 解析调用实参：toks[open] 必须是 '('，返回 { args: [实参 token 片段…], end: ')' 下标 } */
function parseCallArgs(toks, open) {
  if (!isPunct(toks[open], '(')) return null;
  const args = [];
  let depth = 0, cur = [];
  for (let j = open; j < toks.length; j++) {
    const tk = toks[j];
    if (tk.t === 'punct') {
      if (tk.v === '(' || tk.v === '[' || tk.v === '{') depth++;
      else if (tk.v === ')' || tk.v === ']' || tk.v === '}') {
        depth--;
        if (depth === 0) { if (cur.length) args.push(cur); return { args, end: j }; }
      } else if (tk.v === ',' && depth === 1) { args.push(cur); cur = []; continue; }
      else if (tk.v === ';' && depth === 1) return { args, end: j };   // 容错：语句断了
    }
    if (j > open) cur.push(tk);
  }
  return { args, end: toks.length - 1 };
}

/**
 * 把一个实参 token 片段分类。返回：
 *   { kind:'string', text, dynamic }   字符串字面量 / 字符串拼接（含模板）
 *   { kind:'array', count, spread }    数组字面量
 *   { kind:'object', keys, spread }    对象字面量（命名参数整包传）
 *   { kind:'spread' } { kind:'ident', name } { kind:'other' } { kind:'empty' }
 */
function classifyArg(slice) {
  if (!slice || !slice.length) return { kind: 'empty' };
  if (slice.length === 1) return classifyArgSingle(slice[0]);

  // 数组 / 对象字面量：首尾括号刚好配对
  if (isPunct(slice[0], '[') && matchClose(slice, 0) === slice.length - 1) {
    const items = splitTop(slice.slice(1, -1), ',');
    return { kind: 'array', count: items.length, spread: items.some(p => isPunct(p[0], '...')) };
  }
  if (isPunct(slice[0], '{') && matchClose(slice, 0) === slice.length - 1) {
    const items = splitTop(slice.slice(1, -1), ',');
    const keys = [];
    let spread = false;
    for (const p of items) {
      if (isPunct(p[0], '...')) { spread = true; continue; }
      if (p[0] && (p[0].t === 'id' || p[0].t === 'str')) keys.push(p[0].v);
      else keys.push('?');
    }
    return { kind: 'object', keys, spread };
  }

  // 字符串拼接表达式：'a' + x + 'b' / `a${x}b`
  const segs = splitTop(slice, '+');
  if (segs.length > 1) {
    let text = '', dyn = false, sawString = false;
    for (const seg of segs) {
      const one = seg.length === 1 ? classifyArgSingle(seg[0]) : { kind: 'other' };
      if (one.kind === 'string') { text += one.text; dyn = dyn || one.dynamic; sawString = true; }
      else { text += DYN; dyn = true; }
    }
    if (sawString) return { kind: 'string', text, dynamic: dyn };   // 至少有一段是字符串才算拼接
  }

  if (isPunct(slice[0], '...')) return { kind: 'spread' };
  return { kind: 'other' };
}

function classifyArgSingle(tk) {
  if (!tk) return { kind: 'empty' };
  if (tk.t === 'str') return { kind: 'string', text: tk.v, dynamic: false };
  if (tk.t === 'tpl') {
    let text = '', dyn = false;
    for (const p of tk.parts) {
      if (p.text !== undefined) text += p.text;
      else { text += DYN; dyn = true; }
    }
    return { kind: 'string', text, dynamic: dyn };
  }
  if (tk.t === 'id') return { kind: 'ident', name: tk.v };
  if (isPunct(tk, '...')) return { kind: 'spread' };
  return { kind: 'other' };
}

/**
 * 数「实参个数」——本工具的核心：必须认识本项目自己的包装层风格。
 *   d.run(sql)                  → 0
 *   d.run(sql, [a, b])          → 2   （第二个参数是数组，个数 = 数组元素个数）
 *   d.run(sql, args)            → 未知（变量，静态求不出 → 不硬判）
 *   x.prepare(sql).run(a, b)    → 2   （原始语句对象是变参）
 *   d.run(sql, {a:1, b:2})      → 命名参数整包传对象
 */
function countBindArgs(args) {
  const list = args || [];
  if (!list.length) return { known: true, count: 0 };

  if (list.length === 1) {
    const a = classifyArg(list[0]);
    if (a.kind === 'array') {
      if (a.spread) return { known: false, why: '数组里有展开运算符 ...' };
      return { known: true, count: a.count };
    }
    if (a.kind === 'object') {
      if (a.spread) return { known: false, why: '对象里有展开运算符 ...' };
      return { known: true, count: a.keys.length, object: true, keys: a.keys };
    }
    if (a.kind === 'string') return { known: false, why: '参数写成了字符串' };
    if (a.kind === 'ident') return { known: false, why: '参数是变量' };
    if (a.kind === 'spread') return { known: false, why: '参数用了展开运算符 ...' };
    return { known: false, why: '参数是表达式' };
  }

  // 变参风格：d.get(sql, a, b) / prepare(sql).run(a, b)
  if (list.some(x => classifyArg(x).kind === 'spread')) {
    return { known: false, why: '实参里有展开运算符 ...' };
  }
  return { known: true, count: list.length };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 三、SQL 文本处理：挖空字符串/注释 → 数占位符 → 认语句种类
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 把 SQL 里的「字符串字面量、引号标识符、注释」内容全部换成空格（长度不变，下标仍然对得上）。
 * 这样后面数占位符、找分号时，不会把 '什么?' 里的问号、注释里的分号算进去。
 * [列名] 这种方括号标识符只在内容确实像个名字时才挖空，免得误伤 SQL 里真用方括号的地方。
 */
function maskSql(sql) {
  const out = sql.split('');
  const n = sql.length;
  const blank = (from, to) => {
    for (let k = Math.max(0, from); k < Math.min(n, to); k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {                 // -- 行注释
      let j = i; while (j < n && sql[j] !== '\n') j++;
      blank(i, j); i = j; continue;
    }
    if (c === '/' && sql[i + 1] === '*') {                 // 块注释
      let j = i + 2;
      while (j < n && !(sql[j] === '*' && sql[j + 1] === '/')) j++;
      j = Math.min(n, j + 2); blank(i, j); i = j; continue;
    }
    if (c === '\'' || c === '"' || c === '`') {            // 字符串 / 引号标识符（'' 转义）
      let j = i + 1, end = -1;
      while (j < n) {
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } end = j + 1; break; }
        j++;
      }
      if (end < 0) end = n;
      blank(i, end); i = end; continue;
    }
    if (c === '[') {                                       // [列名]
      const m = /^\[[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff ]*\]/.exec(sql.slice(i));
      if (m) { blank(i, i + m[0].length); i += m[0].length; continue; }
    }
    i++;
  }
  return out.join('');
}

/**
 * 数「需要绑定几个参数」——按 SQLite 的真实语义：
 *   ?        匿名占位符，拿"当前最大序号 + 1"
 *   ?NNN     显式序号，取最大值
 *   :n @n $n 命名参数，**同一个名字只算一个**（重复出现不重复绑定）
 */
function countPlaceholders(sql) {
  const s = maskSql(sql);
  const named = new Set();
  let max = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '?') {
      let j = i + 1, num = '';
      while (j < s.length && s[j] >= '0' && s[j] <= '9') { num += s[j]; j++; }
      if (num) max = Math.max(max, Number(num));
      else max = max + 1;
      i = j - 1;
      continue;
    }
    if ((c === ':' || c === '@' || c === '$') && SQL_ID_START.test(s[i + 1] || '')) {
      let j = i + 1, name = '';
      while (j < s.length && SQL_ID_CHAR.test(s[j])) { name += s[j]; j++; }
      if (!named.has(name)) { named.add(name); max = max + 1; }
      i = j - 1;
    }
  }
  return { max, named: [...named] };
}

/** 顶层分号切语句（字符串/注释已挖空，括号内的分号不算） */
function splitStatements(sql) {
  const masked = maskSql(sql);
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) { parts.push(sql.slice(start, i)); start = i + 1; }
  }
  parts.push(sql.slice(start));
  return parts.map(s => s.trim()).filter(s => s.length);
}

/** 数一段文本里顶层的逗号个数（用来算列清单 / SET 项数） */
function topCommaCount(s) {
  let depth = 0, n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) n++;
  }
  return n;
}

/**
 * 认一下语句种类，并数出「列数 / SET 项数」——**只用于报告展示，不参与判定**。
 * 支持 INSERT OR REPLACE / INSERT OR IGNORE 前缀；INSERT ... SELECT 没有列清单时 colCount = null。
 */
function sqlShape(sql) {
  const flat = maskSql(sql).replace(/\s+/g, ' ').trim();
  if (/^INSERT\b/i.test(flat)) {
    const m = /^INSERT\s+(?:OR\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\s+)?INTO\s+(?:"[^"]*"|\S+?)\s*\(/.exec(flat);
    let colCount = null;
    if (m) {
      const open = m.index + m[0].length - 1;
      let depth = 0, close = -1;
      for (let i = open; i < flat.length; i++) {
        if (flat[i] === '(') depth++;
        else if (flat[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
      }
      if (close > open) colCount = topCommaCount(flat.slice(open + 1, close)) + 1;
    }
    return { kind: 'INSERT', colCount };
  }
  if (/^UPDATE\b/i.test(flat)) {
    const m = /^UPDATE\s+\S+\s+SET\s+([\s\S]*?)(?:\s+WHERE\b|\s+RETURNING\b|$)/i.exec(flat);
    return { kind: 'UPDATE', setCount: m ? topCommaCount(m[1]) + 1 : null };
  }
  if (/^DELETE\b/i.test(flat)) return { kind: 'DELETE' };
  if (/^(SELECT|WITH)\b/i.test(flat)) return { kind: 'SELECT' };
  return { kind: 'OTHER' };
}

/** 报告里附带的「列数 / SET 项数」提示（方便人核对，不参与判定） */
function shapeNote(shape) {
  if (shape.kind === 'INSERT') return '（列 ' + (shape.colCount === null ? '?' : shape.colCount) + '）';
  if (shape.kind === 'UPDATE') return '（SET ' + (shape.setCount === null ? '?' : shape.setCount) + ' 项）';
  return '（列 -）';
}

/** 压成一行、动态标记换成 <<拼接>>、太长截断，给报告用 */
function preview(sql, max) {
  const s = String(sql).split(DYN).join('<<拼接>>').replace(/\s+/g, ' ').trim();
  const limit = max || 160;
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}

/**
 * 看这段文本像不像一条 SQL 的开头。
 * 只看**第一个动态拼接点之前**的字面量：'DELETE FROM ' + t 认得出，
 * 而 x + ' WHERE id = ?' 这种头都拼没了的不认（少报总比误报好）。
 */
function looksLikeSql(text) {
  const head = String(text).split(DYN)[0].trimStart();
  return SQL_START.test(head);
}

/** 动态拼接的 SQL 里是否含 INSERT / VALUES / UPDATE（含这些才值得提醒，否则太吵） */
function dynWorthNoting(text) {
  return /INSERT|VALUES|UPDATE/i.test(String(text).split(DYN).join(' '));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 四、扫描一个文件
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 扫描一个 .js 源码，返回 { stmtTotal, hard, soft }。
 *   hard：硬失败（占位符数 ≠ 实参个数）→ 影响退出码
 *   soft：可疑（动态拼接 / 参数是变量）→ 不影响退出码
 */
function scanFile(src, shown) {
  const toks = lexJs(src);
  const hard = [], soft = [];
  const seen = new Set();
  const prepared = new Map();      // 变量名 → { sql, line }：const s = x.prepare('...')
  const deadNames = new Set();     // 被重复赋值的变量名：放弃跟踪，避免串味
  let stmtTotal = 0;

  const addHard = (line, msg) => {
    const k = shown + ':' + line + ':H:' + msg;
    if (seen.has(k)) return;                       // 同一个位置只报一条
    seen.add(k);
    hard.push({ file: shown, line, msg });
  };
  const addSoft = (line, msg) => {
    const k = shown + ':' + line + ':S:' + msg;
    if (seen.has(k)) return;
    seen.add(k);
    soft.push({ file: shown, line, msg });
  };

  /* ── 预扫：记下 const stmt = x.prepare('SQL') 这种"语句变量"（变量形式的绑定值靠它比对） ── */
  for (let j = 0; j < toks.length; j++) {
    if (toks[j].t !== 'id' || toks[j].v !== 'prepare' || !isPunct(toks[j + 1], '(')) continue;
    const call = parseCallArgs(toks, j + 1);
    if (!call || !call.args.length) continue;
    const a0 = classifyArg(call.args[0]);
    if (a0.kind !== 'string' || a0.dynamic || !looksLikeSql(a0.text)) continue;
    const p1 = toks[j - 1], p2 = toks[j - 2], p3 = toks[j - 3], p4 = toks[j - 4], p5 = toks[j - 5];
    if (isPunct(p1, '.') && p2 && p2.t === 'id' && isPunct(p3, '=') && p4 && p4.t === 'id' &&
        p5 && p5.t === 'id' && (p5.v === 'const' || p5.v === 'let' || p5.v === 'var')) {
      const name = p4.v;
      if (prepared.has(name)) { prepared.delete(name); deadNames.add(name); }
      else if (!deadNames.has(name)) prepared.set(name, { sql: a0.text, line: toks[j].line });
    }
  }

  /* ── 判定一处调用：SQL 文本 + 实参个数 ── */
  function judge(line, method, sqlText, dynamic, binds) {
    if (dynamic) {
      // 拼接出来的 SQL 静态算不出占位符：只在含 INSERT/VALUES/UPDATE 时提醒一句，绝不判失败
      if (dynWorthNoting(sqlText)) {
        addSoft(line, '可疑：' + method + '() 的 SQL 是动态拼接的（含 INSERT/VALUES/UPDATE），' +
          '参数个数无法静态校验  ' + preview(sqlText));
      }
      return;
    }
    if (!looksLikeSql(sqlText)) return;                    // 不是 SQL（别的对象的同名方法）
    const chunks = splitStatements(sqlText);
    if (!chunks.length) return;

    const ph = countPlaceholders(sqlText);
    stmtTotal += chunks.length;

    const shape = sqlShape(chunks[0]);
    const namedNote = ph.named.length ? '；命名参数 ' + ph.named.map(x => ':' + x).join(' ') : '';

    // 参数个数静态求不出来 → 最多报「可疑」，绝不硬失败
    if (!binds.known) {
      if (ph.max > 0) {
        addSoft(line, '可疑：' + method + '() 的参数个数无法静态校验（' + binds.why + '），占位符 ' +
          ph.max + ' 个' + namedNote + '  ' + preview(sqlText));
      }
      return;
    }

    // 命名参数整包传对象：只要求"每个命名参数都有值"，多余键不算错
    if (binds.object && ph.named.length) {
      const missing = ph.named.filter(x => binds.keys.indexOf(x) < 0);
      if (missing.length) {
        addHard(line, '命名参数缺少绑定值 ' + missing.map(x => ':' + x).join(' ') +
          '（对象里给了 ' + binds.keys.length + ' 个键）（列 ' +
          (shape.kind === 'INSERT' && shape.colCount !== null ? shape.colCount : '-') + '）  ' + preview(sqlText));
      }
      return;
    }

    if (ph.max !== binds.count) {
      addHard(line, '占位符 ' + ph.max + ' 个 ≠ 实参 ' + binds.count + ' 个' + shapeNote(shape) +
        namedNote + '  ' + preview(sqlText));
    }
  }

  /* ── 主扫：找出所有数据库调用 ── */
  for (let j = 0; j < toks.length; j++) {
    const tk = toks[j];
    if (tk.t !== 'id' || !DB_METHODS.has(tk.v) || !isPunct(toks[j + 1], '(')) continue;
    const call = parseCallArgs(toks, j + 1);
    if (!call) continue;
    const a0 = call.args.length ? classifyArg(call.args[0]) : { kind: 'empty' };

    /* ① d.raw.prepare(sql).run(a, b, c) —— 链式：SQL 在 prepare 里，绑定值是变参 */
    if (tk.v === 'prepare') {
      const n1 = toks[call.end + 1], n2 = toks[call.end + 2], n3 = toks[call.end + 3];
      const chained = isPunct(n1, '.') && n2 && n2.t === 'id' && BIND_METHODS.has(n2.v) && isPunct(n3, '(');
      if (!chained) continue;                    // prepare 单独用（赋给变量）已由预扫处理
      if (a0.kind !== 'string') continue;        // SQL 是变量：静态查不了，跳过
      const c2 = parseCallArgs(toks, call.end + 3);
      judge(n2.line, n2.v, a0.text, a0.dynamic, countBindArgs(c2 ? c2.args : []));
      continue;
    }

    /* ② SQL 直接写在第一个实参里：d.run('...', [a, b]) / d.get('...', [id]) */
    if (a0.kind === 'string' && looksLikeSql(a0.text)) {
      judge(tk.line, tk.v, a0.text, a0.dynamic, countBindArgs(call.args.slice(1)));
      continue;
    }

    /* ③ 变量形式：const s = x.prepare('...'); s.run(a, b) */
    const recv = toks[j - 2];
    if (isPunct(toks[j - 1], '.') && recv && recv.t === 'id' && prepared.has(recv.v)) {
      judge(tk.line, tk.v, prepared.get(recv.v).sql, false, countBindArgs(call.args));
      continue;
    }

    /* ④ 其余（SQL 是变量/常量、接收者不是数据库）一律不报：静态求不出来就别吵 */
  }

  return { stmtTotal, hard, soft };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 五、主流程
 * ══════════════════════════════════════════════════════════════════════════ */

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.cache', 'dist', 'build', 'coverage']);

const USAGE = [
  '用法：node tools/sql-check.js [--root=<项目根目录>]',
  '  --root=<目录>  覆盖项目根目录（默认：本文件所在目录的上一级）',
  '  扫描范围：server.js + src/ 下所有 .js（递归）',
  '  退出码：有硬失败 → 1；否则 → 0（「可疑」不改变退出码）',
  '          根目录 / src 目录不存在 → 打印 [跳过] 并 exit 0',
].join('\n');

function parseArgs(argv) {
  const out = { root: null, help: false, bad: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a.startsWith('--root=')) { out.root = a.slice(7); continue; }
    if (a === '--root') { out.root = argv[++i]; continue; }
    out.bad.push(a);
  }
  return out;
}

/** 递归收集 .js 文件（去重、按名字排序，输出稳定） */
function collectJs(start, out) {
  const seen = new Set(out.map(p => path.resolve(p).toLowerCase()));
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); continue; }
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.js')) continue;
      const k = path.resolve(full).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k); out.push(full);
    }
  };
  let st;
  try { st = fs.statSync(start); } catch { return out; }
  if (st.isDirectory()) walk(start);
  else {
    const k = path.resolve(start).toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(start); }
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  for (const b of args.bad) console.log('[提示] 忽略无法识别的参数：' + b);

  const root = path.resolve(args.root || path.resolve(__dirname, '..'));
  const rel = (p) => slash(path.relative(root, p) || path.basename(p));

  if (!fs.existsSync(root)) { console.log('[跳过] 根目录不存在：' + slash(root)); return 0; }

  const srcDir = path.join(root, 'src');
  const serverJs = path.join(root, 'server.js');
  const hasSrc = fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory();
  const hasServer = fs.existsSync(serverJs) && fs.statSync(serverJs).isFile();
  if (!hasSrc && !hasServer) {
    console.log('[跳过] 没找到 src 目录，也没有 server.js：' + slash(root));
    return 0;
  }

  const files = [];
  if (hasSrc) collectJs(srcDir, files);
  if (hasServer) collectJs(serverJs, files);
  if (!files.length) { console.log('[跳过] 扫描范围内没有 .js 文件：' + slash(root)); return 0; }

  const hard = [], soft = [];
  let stmtTotal = 0;

  for (const file of files) {
    const shown = rel(file);
    let src;
    try { src = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      hard.push({ file: shown, line: 1, msg: '读取失败：' + ((e && e.message) || e) });
      continue;
    }
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);        // 去 BOM
    src = src.replace(/\r\n?/g, '\n');

    let r;
    try { r = scanFile(src, shown); }
    catch (e) {
      hard.push({ file: shown, line: 1, msg: '解析失败：' + ((e && e.message) || e) });
      continue;
    }
    stmtTotal += r.stmtTotal;
    for (const h of r.hard) hard.push(h);
    for (const s of r.soft) soft.push(s);
  }

  /* ── 输出 ── */
  hard.sort(cmpLoc);
  soft.sort(cmpLoc);

  for (const h of hard) console.log('[失败] ' + h.file + ':' + h.line + '  ' + h.msg);
  for (const s of soft) console.log('[可疑] ' + s.file + ':' + s.line + '  ' + s.msg);

  if (hard.length) {
    console.log('──── 共 ' + hard.length + ' 处硬失败、' + soft.length + ' 处可疑；已扫描 ' +
      files.length + ' 个文件 / ' + stmtTotal + ' 条语句 ────');
    return 1;
  }

  console.log('[通过] SQL 自检：共检查 ' + stmtTotal + ' 条语句（' + soft.length + ' 处可疑已忽略）');
  console.log('[统计] 扫描文件 ' + files.length + ' 个（server.js + src/**/*.js），0 处硬失败');
  return 0;
}

if (require.main === module) {
  let code = 1;
  try { code = main(process.argv.slice(2)); }
  catch (e) { console.log('[失败] 自检脚本自身出错：' + ((e && e.stack) || e)); code = 1; }
  process.exitCode = code;
}

module.exports = {
  main, lexJs, parseCallArgs, classifyArg, countBindArgs,
  countPlaceholders, maskSql, splitStatements, sqlShape, scanFile, preview,
};
