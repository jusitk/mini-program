'use strict';
/**
 * check-bat.js —— 检查所有 .bat 文件，抓"双击就闪退"这类毛病
 *
 * 【为什么需要】.bat 的语法错误是最气人的一类 bug：
 *   用户双击 → 黑窗口闪一下就没了 → 完全不知道发生了什么。
 *   而编辑器/语法检查器都不会替我们看 .bat。
 *
 * 【抓哪几类】
 *   ① `if`/`for` 块内的 `echo` 里出现括号 () 或 `then`
 *      这是真实踩过的坑：`echo ... nodejs.org (LTS), then retry.` 放在 if 块里，
 *      cmd 把那个 `)` 当成"块结束"，接着看到 `then` 就报
 *      `then was unexpected at this time.` —— 整个部署脚本从这一行起全废。
 *      块内 echo 里的括号要用 ^( ^) 转义，或者干脆不写括号。
 *   ② 文件含非 ASCII 字节
 *      .bat 里的中文会被 cmd 按当前代码页解析，换个机器就成乱码，
 *      甚至连 `call "中文名.bat"` 都会失败（实测：chcp 65001 和 GBK 都不行）。
 *      所以规则是：**.bat 只写 ASCII，所有中文提示交给 Node 脚本输出**。
 *   ③ CRLF 行尾
 *      只有 LF 的 .bat 在个别 Windows 版本上会把两行粘成一行。
 *   ④ 缺 chcp 65001 / 缺 cd /d "%~dp0"
 *      前者让 Node 的中文输出乱码，后者让"以管理员身份运行"时工作目录跑到 system32。
 *   ⑤ for /f 的定界符写错（用过 `(...)` 而不是 `` `...` ``）
 *      这是真实踩过的坑：把反引号写成圆括号，命令根本不会被执行，
 *      于是"停止服务"静默失效。
 *
 * 用法：node tools/check-bat.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const problems = [];
const notes = [];

const files = fs.readdirSync(ROOT).filter(f => f.toLowerCase().endsWith('.bat')).sort();
if (!files.length) {
  console.log('  （没有 .bat 文件，跳过）');
  process.exit(0);
}

files.forEach((name) => {
  const abs = path.join(ROOT, name);
  const bytes = fs.readFileSync(abs);
  const text = bytes.toString('utf8');

  /* ② 非 ASCII */
  let nonAscii = 0;
  for (const b of bytes) if (b > 127) nonAscii++;
  if (nonAscii) {
    problems.push(name + '：含 ' + nonAscii + ' 个非 ASCII 字节 —— .bat 里不能写中文'
      + '（cmd 按代码页解析，换台机器就乱码，call 中文文件名也会失败）。'
      + '把中文输出交给 Node 脚本，.bat 只留 ASCII。');
  }

  /* ③ CRLF */
  const lfOnly = (text.match(/(?<!\r)\n/g) || []).length;
  if (lfOnly > 0) {
    problems.push(name + '：有 ' + lfOnly + ' 处只有 LF 的行尾（应为 CRLF）');
  }

  /* ④ 开头两件事 */
  if (text.indexOf('chcp 65001') < 0) {
    notes.push(name + '：没有 chcp 65001，Node 的中文输出可能乱码');
  }
  if (text.indexOf('cd /d "%~dp0"') < 0) {
    notes.push(name + '：没有 cd /d "%~dp0"，以管理员身份运行时工作目录可能不对');
  }

  /* ① 块内 echo 的括号 / then；⑤ for /f 定界符 */
  const lines = text.split(/\r?\n/);
  let depth = 0;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const ln = i + 1;

    if (/^(if|for)\b/i.test(line) && /\(\s*$/.test(line)) { depth++; return; }
    if (line === ')') { depth = Math.max(0, depth - 1); return; }
    // 单行 if（没有块）也要看：`if x (echo y) else (echo z)` 这种括号是配对的，放过
    if (depth > 0 && /^echo\b/i.test(line)) {
      const body = line.replace(/^echo\.?/i, '');
      if (/[()]/.test(body)) {
        problems.push(name + ' 第 ' + ln + ' 行：if/for 块内的 echo 里出现括号 → '
          + 'cmd 会把 ) 当成块结束，报 "then/else was unexpected"。'
          + '改法：去掉括号，或用 ^( ^) 转义。原句：' + line);
      }
      if (/\bthen\b/i.test(body)) {
        notes.push(name + ' 第 ' + ln + ' 行：块内 echo 含 "then"，和括号一起最容易炸');
      }
    }

    // for /f 的定界符必须是反引号
    if (/^for\s+\/f/i.test(line) && /in\s*\(/i.test(line)) {
      const m = line.match(/in\s*\(([\s\S]*)$/i);
      const rest = m ? m[1].trim() : '';
      if (rest && rest.charAt(0) === '(') {
        problems.push(name + ' 第 ' + ln + ' 行：for /f 的 in (...) 部分用了圆括号，'
          + '应该是反引号 `命令`。写成圆括号 → 那条命令根本不会执行（曾导致"停止服务"静默失效）。');
      }
    }
  });
});

console.log('');
if (notes.length) {
  notes.forEach(n => console.log('  ! ' + n));
  console.log('');
}
if (problems.length) {
  problems.forEach(p => console.log('  ✘ ' + p));
  console.log('');
  console.log('[失败] .bat 自检发现 ' + problems.length + ' 个问题（会让双击闪退或静默失效）');
  process.exit(1);
}
console.log('[通过] .bat 自检：' + files.length + ' 个文件（ASCII / CRLF / 块内 echo 无括号 / for 定界符正确）');
