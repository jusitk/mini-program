'use strict';
/**
 * reset-password.js —— 进不去后台时的救急工具
 *
 * 用法（在服务器那台电脑的项目目录里开命令行执行）：
 *   node tools/reset-password.js                     看有哪些账号、什么状态
 *   node tools/reset-password.js admin 新口令          重置 admin 的口令
 *   node tools/reset-password.js admin 新口令 --admin  顺便恢复成启用的管理员
 *
 * 也可以**不带任何参数**运行：列完账号后会像问答一样提示你输入账号和新口令。
 * 直接双击项目根目录的「重置口令.bat」就是这个效果 —— 不熟悉命令行的老师用那个。
 *
 * 注意：这个工具直接改数据库，改完该账号已有的登录会全部失效（这是有意的）。
 * 服务在运行也可以执行，但**执行完请重启服务**（服务内存里还握着旧库句柄）。
 */

const path = require('node:path');
const readline = require('node:readline');
const db = require('../src/db');
const Auth = require('../src/auth');
const { nowIso } = require('../src/util');

let CFG = {};
try { CFG = require('../config.js') || {}; } catch (e) { CFG = {}; }

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || CFG.dataDir || path.join(ROOT, 'data'));
const DB_FILE = path.join(DATA_DIR, 'sports.db');

const args = process.argv.slice(2);
if (args[0] === '--help' || args[0] === '-h') {
  console.log(`
用法：
  node tools/reset-password.js                          列出所有账号
  node tools/reset-password.js <账号> <新口令>            重置口令
  node tools/reset-password.js <账号> <新口令> --admin     重置口令并恢复成启用的管理员
  node tools/reset-password.js                          不带参数：列账号 + 问答式重置
`);
  process.exit(0);
}

/* ── 问答式输入 ────────────────────────────────────────────────────────────
   放在 Node 里而不是批处理里，是因为 cmd 的 `set /p` 在读管道/重定向输入时
   经常拿到空值（实测过），而 Node 这边三种情况都稳：真控制台、管道、重定向。
   另外这一层还能顺带校验（口令长度、两次输入一致），批处理做这些很别扭。

   实现要点（都踩过）：
   1. 用 `rl.on('line')` 事件 + 队列，**不要用 rl.question** ——
      在"输入重定向"下 `question` 从第二问起会丢答案（实测三行输入只拿到一行）。
      事件式读法在控制台 / 管道 / 重定向下都能把每一行读全。
   2. 提示文字自己 process.stdout.write，readline 的 output 指向空壳流 ——
      否则"输入重定向 + 输出管道"的组合下提示文字会丢。
   3. 输入结束（EOF）时给所有等待中的提问回一个空答案，
      于是"没有输入"就等价于"直接回车"，会安全地什么都不改。 */

let rl = null;
const NULL_OUT = { write() {} };
const pendingAsks = [];
const lineQueue = [];
let eof = false;

function ensureReader() {
  if (rl) return;
  rl = readline.createInterface({ input: process.stdin, output: NULL_OUT, terminal: false });
  rl.on('line', (line) => {
    const next = pendingAsks.shift();
    if (next) next(line);
    else lineQueue.push(line);
  });
  rl.on('close', () => {
    eof = true;
    while (pendingAsks.length) pendingAsks.shift()('');
  });
}

function ask(question) {
  ensureReader();
  process.stdout.write(question);
  return new Promise((resolve) => {
    const done = (line) => {
      process.stdout.write('\n');
      resolve(String(line === undefined || line === null ? '' : line).trim());
    };
    if (lineQueue.length) { done(lineQueue.shift()); return; }
    if (eof) { done(''); return; }
    pendingAsks.push(done);
  });
}
function askDone() { if (rl) { rl.close(); rl = null; } }

if (!require('node:fs').existsSync(DB_FILE)) {
  console.log('找不到数据库：' + DB_FILE);
  console.log('说明这台机器上还没有启动过服务。先双击「启动.bat」跑一次再执行本工具。');
  process.exit(1);
}

const d = db.open(DB_FILE);

function listUsers() {
  const users = d.all('SELECT id, username, displayName, role, disabled, createdAt FROM user ORDER BY role, username');
  if (!users.length) return [];
  console.log('');
  console.log('  账号列表（数据库：' + DB_FILE + '）');
  console.log('  ' + '─'.repeat(58));
  console.log('  账号'.padEnd(16) + '显示名'.padEnd(16) + '角色'.padEnd(10) + '状态');
  console.log('  ' + '─'.repeat(58));
  users.forEach((u) => {
    console.log('  ' + String(u.username).padEnd(16)
      + String(u.displayName || '').padEnd(16)
      + String(Auth.ROLE_LABEL[u.role] || u.role).padEnd(10)
      + (u.disabled ? '已停用' : '正常'));
  });
  console.log('  ' + '─'.repeat(58));
  console.log('');
  return users;
}

/** 真正改库：改口令 + 踢掉旧登录 + 恢复启用（可选提权） */
function doReset(username, password, promote) {
  const u = d.get('SELECT * FROM user WHERE username = ?', [username]);
  if (!u) {
    console.log('找不到账号「' + username + '」。上面那份列表里有的才是有效账号。');
    return false;
  }
  const weak = Auth.checkPasswordStrength(password);
  if (weak) {
    console.log('口令不符合要求：' + weak);
    return false;
  }
  Auth.setPassword(d, u.id, password);
  Auth.destroyUserSessions(d, u.id);
  d.run('UPDATE user SET disabled = 0, updatedAt = ? WHERE id = ?', [nowIso(), u.id]);
  if (promote) d.run("UPDATE user SET role = 'admin', updatedAt = ? WHERE id = ?", [nowIso(), u.id]);

  const roleText = promote ? '管理员（已恢复）' : (Auth.ROLE_LABEL[u.role] || u.role);
  const when = new Date().toLocaleString('zh-CN', { hour12: false });

  console.log('');
  console.log('  ┌──────────────────────────────────────────────────────┐');
  console.log('  │  口令已改好，请记下来（这行字在黑窗口里，也会写进   │');
  console.log('  │  项目目录下的「口令.txt」，忘了可以再去翻）          │');
  console.log('  └──────────────────────────────────────────────────────┘');
  console.log('');
  console.log('      登录账号：' + u.username);
  console.log('      新 口 令：' + password);
  console.log('      角    色：' + roleText + '　状态：已启用');
  console.log('');
  console.log('  怎么用：关掉服务那个黑窗口 → 双击「启动.bat」');
  console.log('          → 浏览器打开后台地址 → 用上面这行账号和口令登录。');
  console.log('  提示：原来那个随机口令已经作废；该账号之前的所有登录也全部失效了。');
  console.log('  ⚠ 如果服务还在运行，一定要重启一次（服务内存里还是旧数据）。');
  console.log('');

  // 同时写一份到项目目录，方便老师回头查看（下次重置会覆盖）。
  // 注意：**把所有账号都列出来**，只标出"这次改的是哪个" ——
  // 只写刚改的那个，会让人误以为"系统里只有这一个账号"（踩过这个坑）。
  try {
    const all = d.all('SELECT username, displayName, role, disabled FROM user ORDER BY role, username');
    const note = [
      '运动会计分系统 —— 账号口令记录',
      '生成时间：' + when,
      '来源：口令重置（这次改的是「' + u.username + '」）',
      '',
      '  ★ ' + u.username + '（' + (u.displayName || '') + '）',
      '     口    令：' + password,
      '     角    色：' + roleText + '　状态：已启用　　← 这次刚改的',
      '',
      '  ── 系统里的其它账号（口令没变；忘了就再重置一次）──',
    ];
    const others = all.filter(x => x.username !== u.username);
    if (!others.length) note.push('     （没有其它账号）');
    others.forEach((x) => {
      note.push('     ' + x.username + '（' + (x.displayName || '') + '）　角色：'
        + (Auth.ROLE_LABEL[x.role] || x.role) + (x.disabled ? '　【已停用】' : ''));
    });
    note.push('');
    note.push('用法：双击「启动.bat」启动服务，浏览器打开后台地址，用上面的账号和口令登录。');
    note.push('安全提示：抄走口令后请把这个文件删掉，或至少别留在公用电脑上。');
    note.push('         每次重置口令都会覆盖本文件。');
    note.push('');
    require('node:fs').writeFileSync(path.join(ROOT, '口令.txt'), note.join('\r\n'), 'utf8');
    console.log('  已另存一份到：' + path.join(ROOT, '口令.txt'));
    console.log('');
  } catch (e) {
    console.log('  （没能写出「口令.txt」：' + (e && e.message) + '，请直接看上面窗口里的口令）');
    console.log('');
  }

  return true;
}

(async function main() {
  const users = listUsers();
  if (!users.length) {
    console.log('数据库里还没有任何账号。先启动一次服务，它会自动创建一个管理员并在启动横幅里打印口令。');
    d.close();
    process.exit(1);
  }

  // 有参数：一次性执行（自动化/熟悉命令行的人走这条）
  if (args.length) {
    const ok = doReset(String(args[0]), String(args[1] || ''), args.indexOf('--admin') >= 0);
    d.close();
    process.exit(ok ? 0 : 1);
  }

  // 没参数：问答式（双击「重置口令.bat」走这条）
  console.log('  重置口令：直接回车表示不改动、退出。');
  console.log('');

  const username = await ask('  要重置哪个账号？请输入账号名：');
  if (!username) {
    console.log('');
    console.log('  没有输入账号，什么都没改。');
    askDone();
    d.close();
    process.exit(0);
  }

  const p1 = await ask('  这个账号的新口令（至少 6 位）：');
  if (!p1) {
    console.log('');
    console.log('  口令是空的，什么都没改。');
    askDone();
    d.close();
    process.exit(1);
  }
  const p2 = await ask('  再输入一次确认：');
  if (p1 !== p2) {
    console.log('');
    console.log('  两次输入的口令不一样，什么都没改。请重新运行一次。');
    askDone();
    d.close();
    process.exit(1);
  }

  const ok = doReset(username, p1, true);
  askDone();
  d.close();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('出错了：' + (err && err.message));
  askDone();
  try { d.close(); } catch (e) { /* ignore */ }
  process.exit(1);
});

