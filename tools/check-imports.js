'use strict';
/**
 * check-imports.js —— 静态自检：找出"用了但没定义/没引入"的函数
 *
 * 【为什么需要它】
 *   删掉一段代码后顺手清理 import，很容易删过头：
 *   函数还在别处被调用，但名字已经不在了 —— 这是**运行时错误**，
 *   静态语法检查（node --check）发现不了，只有真的执行到那一行才炸。
 *   实例：删掉录入页快照后把 `zhCompare` 一起从 import 里去掉了，
 *        结果「预览效果」接口直接 500，而语法检查是"通过"的。
 *
 * 做法：把注释和字符串去掉，收集本文件定义过的名字（函数/变量/解构/形参），
 *       再看所有裸调用 `name(` 是否都能对上。宁可少报也不要误报成灾，
 *       所以内置名、方法调用（a.b()）、SQL 关键字都排除掉。
 *
 * 用法：node tools/check-imports.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** 语言内置 / 全局对象 / 关键字 —— 这些不算"没定义" */
const BUILTIN = new Set([
  'require', 'module', 'exports', 'process', 'console', 'Buffer', 'globalThis',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'structuredClone', 'fetch', 'URL', 'URLSearchParams', 'AbortController',
  'JSON', 'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Promise', 'Map', 'Set', 'WeakMap',
  'WeakSet', 'Symbol', 'BigInt', 'Proxy', 'Reflect', 'Intl', 'Function', 'TextEncoder',
  'TextDecoder', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'eval', '__dirname', '__filename',
  // 关键字后面跟括号的情况（if ( / for ( / while ( / switch ( / catch ( / return ( 等）
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'function', 'await',
  'this', 'super', 'do', 'else', 'in', 'of', 'case', 'delete', 'void', 'yield',
  'class', 'const', 'let', 'var', 'try', 'finally', 'throw', 'break', 'continue',
  'default', 'export', 'import', 'async', 'constructor',
  // SQL 里的函数名会出现在模板字符串里（已被去掉，但双保险）
  'COUNT', 'SUM', 'MAX', 'MIN', 'COALESCE', 'IFNULL', 'GROUP_CONCAT',
]);

/** 只检查这些文件（后端；前端由 check-frontend.js 管引用） */
function targets() {
  const list = ['server.js'];
  const src = path.join(ROOT, 'src');
  if (fs.existsSync(src)) {
    fs.readdirSync(src).filter(f => f.endsWith('.js')).forEach(f => list.push('src/' + f));
  }
  return list;
}

/** 去掉注释和字符串，避免把文字当成代码 */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** 收集本文件里"定义过"的名字 */
function collectDefined(src) {
  const out = new Set();
  let m;
  const defRe = /\b(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = defRe.exec(src))) out.add(m[1]);

  // 解构：const { a, b: c } = ... / const [a, b] = ...
  const destrRe = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g;
  while ((m = destrRe.exec(src))) {
    m[1].split(',').forEach((part) => {
      const name = part.split(':').pop().trim().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    });
  }
  // 形参：只匹配**真正的函数头**，不能乱匹配
  //   function name(a, b)   /   function (a, b)   /   (a, b) =>   /   a =>   /   name: function (a)
  // 注意不能用 `\(([^()]*)\)\s*(?:=>|\{)` 这种写法：非贪婪的 [^()]* 会跨过
  // 对象字面量，把 `{ get, all, run }` 里的名字当成形参收进来（踩过，导致一堆误报）。
  const paramRes = [
    /\bfunction\s+[A-Za-z_$][\w$]*\s*\(([^()]*)\)/g,
    /\bfunction\s*\(([^()]*)\)/g,
    /\(([^()]*)\)\s*=>/g,          // 箭头函数
    /(^|[,(=:[\]\s])([A-Za-z_$][\w$]*)\s*=>/g,   // 单参数箭头函数 a =>
  ];
  paramRes.forEach((re) => {
    let mm;
    while ((mm = re.exec(src))) {
      const raw = mm.length > 2 && re.source.indexOf('=>') > 0 && re.source.indexOf('\\(') < 0
        ? mm[2] : mm[1];
      if (!raw) continue;
      raw.split(',').forEach((part) => {
        const name = part.split(':').pop().trim().split('=')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== '...') out.add(name);
      });
    }
  });
  // catch (e) 之类
  const catchRe = /catch\s*\(\s*([A-Za-z_$][\w$]*)/g;
  while ((m = catchRe.exec(src))) out.add(m[1]);

  // 对象里的"方法简写"：{ tx(fn) { ... } }  —— 形参也要收进来
  const methodRe = /(^|[,{]\s*|\n\s*)([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/g;
  while ((m = methodRe.exec(src))) {
    out.add(m[2]);
    m[3].split(',').forEach((part) => {
      const name = part.split(':').pop().trim().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    });
  }
  return out;
}

const problems = [];
for (const rel of targets()) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const src = strip(fs.readFileSync(abs, 'utf8'));
  const defined = collectDefined(src);
  const callRe = /([A-Za-z_$][\w$]*)\s*\(/g;
  const seen = new Set();
  let m;
  while ((m = callRe.exec(src))) {
    const name = m[1];
    if (BUILTIN.has(name) || defined.has(name) || seen.has(name)) continue;
    // 前面紧挨着 '.' 的是方法调用（d.get(...) / JSON.parse(...)），不算裸调用
    let i = m.index - 1;
    while (i >= 0 && /\s/.test(src[i])) i--;
    if (i >= 0 && src[i] === '.') continue;
    // 跳过参数表，看 ')' 后面是什么：
    //   name(...) {      → 对象里的"方法简写"定义（如 { up(d) { ... } }）
    //   name(...) => ... → 箭头函数
    // 注意：re.lastIndex 停在 '(' 之后，直接看 src[lastIndex] 会读到第一个参数名
    // （踩过这个坑：把迁移表里的 up(d) { 当成了未定义的调用，一堆误报）
    let k = callRe.lastIndex, depth = 1;
    while (k < src.length && depth > 0) {
      const c = src[k];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      k++;
    }
    let j = k;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] === '{') continue;
    if (src[j] === '=' && src[j + 1] === '>') continue;
    seen.add(name);
    problems.push(rel + ' 调用了 ' + name + '()，但本文件没有它的定义或引入'
      + (process.env.DEBUG_IMPORTS ? '　[前一个非空白字符=' + JSON.stringify(src[i] === undefined ? '(行首)' : src[i]) + ' 后一个=' + JSON.stringify(src[j] === undefined ? '(结尾)' : src[j]) + ']' : ''));
  }
}

console.log('');
if (problems.length) {
  console.log('[失败] 发现 ' + problems.length + ' 处"用了但没定义/没引入"（会在运行时抛 ReferenceError）：');
  problems.forEach(p => console.log('  · ' + p));
  console.log('');
  console.log('  提示：删代码时清理 import 很容易删过头。核对一下上面这些名字，');
  console.log('        该补回 import 的补回来，确实不用的就一起删掉。');
  process.exit(1);
}
console.log('[通过] 导入自检：' + targets().length + ' 个后端文件，没有"用了但没引入"的函数');
