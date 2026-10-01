'use strict';
/**
 * deploy.js —— 一键部署：把"装环境 → 放行防火墙 → 建库 → 起服务 → 报地址"一次做完
 *
 * 【为什么要有这个】原来只有「启动.bat」，它假设这台电脑已经装好了 Node.js。
 * 真到学校电脑上，卡住的地方往往是：
 *   1. 没装 Node → 双击只闪一下黑窗口，老师不知道发生了什么
 *   2. 装了但防火墙没放行 → 电脑上打得开，手机连不上，现场才发现
 *   3. 装完不知道手机该输哪个地址
 * 这个脚本把这几步连起来，并且**每一步都打印人话**（成功/失败/怎么补救）。
 *
 * 【怎么用】
 *   双击根目录的「一键部署.bat」          ← 老师用这个
 *   node tools/deploy.js                  ← 一样，但能看到更详细的输出
 *   node tools/deploy.js --check          ← 只体检，什么都不改（排错用）
 *   node tools/deploy.js --no-start       ← 只做部署检查，不起服务
 *   node tools/deploy.js --firewall-only  ← 只放行防火墙（「防火墙放行.bat」用）
 *   node tools/deploy.js --autostart      ← 设置/取消开机自启（「开机自启.bat」用）
 *   node tools/deploy.js --message=xxx    ← 入口 .bat 用它说明"这次是来干什么的"
 *
 * 【安全】只做这几件事，不动系统其它设置：
 *   · 放行本机 8080 端口（入站，仅 TCP）—— 需要管理员权限，没权限就打印手动命令
 *   · 在本项目目录里写 data\ 目录
 *   · 开机自启只在**当前用户的启动文件夹**放一个快捷方式（可一键取消）
 *   不改环境变量、不装全局包、不写注册表。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const has = (flag) => args.indexOf(flag) >= 0;
const NO_START = has('--no-start');
const CHECK_ONLY = has('--check');
const FIREWALL_ONLY = has('--firewall-only');
const AUTOSTART = has('--autostart');
/** --quick：日常启动用。跳过文件清单和防火墙检查（那两条是"部署时"才需要），
 *  只做"能不能起来"的必要检查，然后直接启动 —— 老师双击「启动.bat」的体验要快。 */
const QUICK = has('--quick');
const MESSAGE = (args.find(a => a.indexOf('--message=') === 0) || '').slice('--message='.length);

const C = {
  reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m',
  green: '\u001b[32m', yellow: '\u001b[33m', red: '\u001b[31m', cyan: '\u001b[36m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (s, c) => (useColor ? c + s + C.reset : s);
const ok = (s) => console.log('  ' + paint('✔', C.green) + ' ' + s);
const warn = (s) => console.log('  ' + paint('!', C.yellow) + ' ' + s);
const bad = (s) => console.log('  ' + paint('✘', C.red) + ' ' + s);
const info = (s) => console.log('    ' + paint(s, C.dim));
const head = (s) => { console.log(''); console.log(paint('── ' + s + ' ' + '─'.repeat(Math.max(2, 56 - s.length)), C.cyan)); };

const problems = [];
const addProblem = (msg, howTo) => { problems.push({ msg, howTo }); bad(msg); if (howTo) info('补救：' + howTo); };

/* ══ 1. 运行环境 ══════════════════════════════════════════════════════════ */

function checkRuntime() {
  head('1/6 检查运行环境');
  const v = process.versions.node;
  const major = Number(v.split('.')[0]);
  const minor = Number(v.split('.')[1]);
  // node:sqlite 需要 22.5 以上
  if (major > 22 || (major === 22 && minor >= 5)) {
    ok('Node.js 版本够用：v' + v);
  } else {
    addProblem('Node.js 版本太低（v' + v + '），本项目需要 22.5 以上',
      '装新版 Node：https://nodejs.org 下载 LTS 一路下一步；'
      + '或把便携版解压后放进本项目 node\\ 目录（放 node\\node.exe）');
  }
  /* 【只看版本号不够】node:sqlite 的 DatabaseSync 是 22.5 进来的，
     而 sqlite.backup() 要到 22.16 才进 22.x 分支 —— 版本号够了也可能缺 API。
     所以真的 require 一下、真的建个内存库试试（见 tools/check-node.js）。 */
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync(process.execPath, ['--no-warnings', path.join(ROOT, 'tools', 'check-node.js')], {
      stdio: 'pipe', encoding: 'utf8',
    });
    ok('数据库接口实测可用（node:sqlite 建库读写通过）');
  } catch (e) {
    const out = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    addProblem('这个 Node 缺少运行本系统必须的接口（版本号看着够，但 API 不全）',
      out.split('\n').filter(l => l.indexOf('✘') >= 0).join('\n') ||
      '运行 node tools/check-node.js 看详细缺什么。建议装 Node 22 LTS 的最新小版本或 Node 24。');
  }
  ok('操作系统：' + os.type() + ' ' + os.release() + '（' + os.arch() + '）');

  const portable = path.join(ROOT, 'node', 'node.exe');
  if (fs.existsSync(portable)) {
    ok('检测到项目自带的便携版 Node：node\\node.exe（换电脑也能用）');
  } else {
    info('没有自带便携版 Node —— 这台电脑已经装了 Node，所以不影响使用。');
    info('只有"把整个文件夹拷到另一台没装 Node 的电脑"时才需要，');
    info('那时在那边同样双击「一键部署.bat」，它会自动下载一份便携版。');
  }
}

/* ══ 2. 项目文件 ══════════════════════════════════════════════════════════ */

function checkFiles() {
  head('2/6 检查项目文件');
  const need = ['server.js', 'config.js', 'src/schema.js', 'src/ops.js',
    'public/screen.html', 'public/admin.html', 'public/login.html'];
  const missing = need.filter(f => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) {
    addProblem('缺少文件：' + missing.join('、'),
      '整个文件夹要一起拷贝。如果是从压缩包解出来的，确认解压完整、没有被杀毒软件删掉。');
  } else {
    ok('核心文件齐全（' + need.length + ' 个）');
  }
  try {
    require(path.join(ROOT, 'config.js'));
    ok('config.js 能正常读取');
  } catch (e) {
    addProblem('config.js 有语法错误：' + (e && e.message), '用记事本打开 config.js，看提示的那一行');
  }
}

/* ══ 3. 端口 ══════════════════════════════════════════════════════════════ */

function getPort() {
  let port = 8080;
  try { port = Number(require(path.join(ROOT, 'config.js')).port) || 8080; } catch (e) { /* 用默认 */ }
  return port;
}

function checkPort(port) {
  head('3/6 检查端口 ' + port);
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  const lines = String(r.stdout || '').split('\n')
    .filter(l => l.indexOf(':' + port) >= 0 && /LISTENING/i.test(l));
  if (!lines.length) {
    ok('端口 ' + port + ' 空闲');
    return { free: true };
  }
  // 看看占用的是不是我们自己的服务
  const pid = (lines[0].trim().split(/\s+/).pop() || '').trim();
  let owner = '';
  try {
    const q = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    owner = String(q.stdout || '').split(',')[0].replace(/"/g, '').trim();
  } catch (e) { /* ignore */ }
  warn('端口 ' + port + ' 已被占用（' + (owner || '未知程序') + '，PID ' + pid + '）');
  if (/node/i.test(owner)) {
    info('占用者是 node —— 很可能**本系统已经在运行了**。');
    info('那就直接用下面的地址打开；要重启就先双击「停止.bat」。');
  } else {
    info('是别的程序占着。两个办法：');
    info('  ① 关掉那个程序；');
    info('  ② 改 config.js 里的 port（比如 8090），然后手机地址也换成新端口。');
  }
  return { free: false, pid, owner };
}

/** 已在本机跑着的服务，能不能连上（用来判断"是不是本系统在运行"） */
async function probeLocal(port) {
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.ok ? j : null;
  } catch (e) { return null; }
}

/* ══ 4. 数据目录 ══════════════════════════════════════════════════════════ */

function checkData() {
  head('4/6 准备数据目录');
  const dataDir = path.join(ROOT, 'data');
  if (!fs.existsSync(dataDir)) {
    if (CHECK_ONLY) { info('data\\ 还不存在（首次启动时会自动创建）'); return; }
    try { fs.mkdirSync(dataDir, { recursive: true }); ok('已创建 data\\ 目录'); }
    catch (e) { addProblem('建不了 data\\ 目录：' + e.message, '把整个文件夹放到 D:\\ 或 F:\\ 再试（不要放在 C:\\Program Files）'); return; }
  } else {
    ok('data\\ 目录已存在');
  }
  // 能不能写？现场最怕"数据目录只读"
  const probe = path.join(dataDir, '.write-test');
  try {
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    ok('data\\ 目录可写');
  } catch (e) {
    addProblem('data\\ 目录不可写：' + e.message,
      '把整个文件夹移到 D:\\ 或 F:\\（C:\\Program Files 下通常没有写权限）');
  }
  const dbFile = path.join(dataDir, 'sports.db');
  if (fs.existsSync(dbFile)) {
    const kb = Math.round(fs.statSync(dbFile).size / 1024);
    ok('已有数据库 sports.db（' + kb + ' KB）—— 名单和历史数据会保留');
  } else {
    info('还没有数据库，首次启动会自动建库');
  }
}

/* ══ 5. 防火墙 ════════════════════════════════════════════════════════════ */

function isAdmin() {
  try {
    const r = execFileSync('net', ['session'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    void r;
    return true;
  } catch (e) { return false; }
}

function firewallRuleExists(name) {
  try {
    const r = spawnSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=' + name],
      { encoding: 'utf8' });
    return String(r.stdout || '').indexOf('No rules match') < 0
      && String(r.stdout || '').indexOf('没有与指定条件匹配的规则') < 0
      && String(r.stdout || '').trim().length > 20;
  } catch (e) { return false; }
}

function firewallCmd(port, name) {
  return 'netsh advfirewall firewall add rule name="' + name + '" dir=in action=allow protocol=TCP localport=' + port;
}

function checkFirewall(port) {
  head('5/6 放行防火墙（让手机能连上）');
  const name = 'SportsScore' + (port === 8080 ? '' : '-' + port);

  if (firewallRuleExists(name)) {
    ok('防火墙规则「' + name + '」已存在');
    return { done: true };
  }
  if (CHECK_ONLY) {
    warn('还没放行（体检模式不改系统设置）');
    info('手动放行：管理员身份运行 CMD，执行下面这行');
    info(firewallCmd(port, name));
    return { done: false };
  }
  if (!isAdmin()) {
    warn('当前不是管理员权限，没法自动放行防火墙');
    info('两个办法：');
    info('  ① 右键「一键部署.bat」→ 以管理员身份运行（推荐）');
    info('  ② 或者右键开始菜单 → 终端(管理员)，粘贴执行：');
    info('     ' + firewallCmd(port, name));
    problems.push({
      msg: '防火墙未放行（手机可能连不上）',
      howTo: '右键「一键部署.bat」→ 以管理员身份运行',
    });
    return { done: false, needAdmin: true };
  }
  const r = spawnSync('netsh', ['advfirewall', 'firewall', 'add', 'rule',
    'name=' + name, 'dir=in', 'action=allow', 'protocol=TCP', 'localport=' + String(port)],
  { encoding: 'utf8' });
  const outText = String(r.stdout || '') + String(r.stderr || '');
  if (r.status === 0 && outText.indexOf('Ok') >= 0) {
    ok('已放行端口 ' + port + '（规则名「' + name + '」）');
    return { done: true };
  }
  // 中文系统会回 "确定。" 而不是 "Ok."
  if (r.status === 0) {
    ok('已放行端口 ' + port + '（规则名「' + name + '」）');
    return { done: true };
  }
  warn('自动放行没成功：' + outText.trim().slice(0, 120));
  info('手动执行：' + firewallCmd(port, name));
  return { done: false };
}

/* ══ 6. 访问地址 ══════════════════════════════════════════════════════════ */

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach((name) => {
    (ifs[name] || []).forEach((a) => {
      const fam = a.family === 'IPv4' || a.family === 4;
      if (!fam || a.internal) return;
      // 虚拟网卡要排除掉：VMware / VirtualBox / Hyper-V / WSL / Docker，
      // 以及 Radmin / 蒲公英 / Tailscale 这类 VPN —— 它们的地址多半 26.x / 10.x，
      // 手机根本连不上，排在前头会把真正的 Wi-Fi 地址挤下去（踩过）
      const virt = /vmware|virtualbox|hyper-v|vethernet|loopback|docker|wsl|tap|tun|vpn|radmin|tailscale|zerotier|hamachi|openvpn|wireguard/i.test(name);
      out.push({ name, address: a.address, virtual: virt });
    });
  });
  // 真实网卡排前面
  return out.sort((a, b) => (a.virtual ? 1 : 0) - (b.virtual ? 1 : 0));
}

function printAddresses(port) {
  head('6/6 访问地址');
  const addrs = lanAddresses();
  const real = addrs.filter(a => !a.virtual);
  console.log('  ' + paint('这台电脑自己用（大屏就在这台机器上时）：', C.bold));
  console.log('    大屏   http://127.0.0.1:' + port + '/screen');
  console.log('    后台   http://127.0.0.1:' + port + '/admin');
  console.log('');
  if (real.length) {
    console.log('  ' + paint('手机 / 其它电脑用（连同一个 Wi-Fi）：', C.bold));
    real.forEach((a) => {
      console.log('    大屏   http://' + a.address + ':' + port + '/screen');
      console.log('    后台   http://' + a.address + ':' + port + '/admin' + paint('　← 手机录成绩用这个', C.dim));
      console.log('    ' + paint('（网卡 ' + a.name + '）', C.dim));
    });
  } else {
    warn('没找到局域网地址：这台电脑可能没连网线/Wi-Fi');
    info('手机要连上它，必须：电脑连网（网线或 Wi-Fi）→ 手机连同一个 Wi-Fi');
  }
  if (!real.length) return [];
  return real;
}

/* ══ 开机自启 ══════════════════════════════════════════════════════════════
 *
 * 【做法】在当前用户的"启动"文件夹里放一个 .bat，登录后自动起服务。
 *   为什么不用注册表 / 计划任务：
 *     · 计划任务要管理员权限，而"放行防火墙"已经要过一次了，能少要就少要
 *     · 启动文件夹**当前用户就能写**，而且老师自己就能看见、能删
 *     · 想取消：再点一次「开机自启.bat」，我们把它删掉
 *
 * 【窗口】故意**不隐藏**：服务窗口留着，老师一眼能看到"服务在跑"；
 *   关掉窗口就等于停服务。隐藏了反而会出现"数据没在记但没人知道"的情况。
 */
function startupDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function startupFilePath() {
  return path.join(startupDir(), 'SportsScore-Autostart.bat');
}

/** 找到该用哪个 node 来起服务（优先项目自带的便携版） */
function nodeExeForStartup() {
  const portable = path.join(ROOT, 'node', 'node.exe');
  if (fs.existsSync(portable)) return portable;
  return process.execPath;
}

function toggleAutostart() {
  head('开机自启');
  const file = startupFilePath();
  const dir = startupDir();

  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
      ok('已取消开机自启（删掉了启动文件夹里的快捷方式）');
      info('文件：' + file);
      console.log('');
      console.log('  ' + paint('以后开机不会再自动启动服务。要恢复就再点一次「开机自启.bat」。', C.bold));
      return;
    } catch (e) {
      addProblem('删不掉开机自启文件：' + e.message, '手动删除：' + file);
      return;
    }
  }

  if (!fs.existsSync(dir)) {
    addProblem('找不到"启动"文件夹：' + dir, '这台电脑的用户配置可能不标准，改用「计划任务」手动添加');
    return;
  }
  const nodeExe = nodeExeForStartup();
  const bat = [
    '@echo off',
    'rem 由本系统自动生成：开机后自动启动运动会成绩服务。',
    'rem 想取消：双击项目里的「开机自启.bat」，或直接删掉这个文件。',
    'title Sports Score Server (autostart)',
    'cd /d "' + ROOT + '"',
    'echo.',
    'echo   运动会成绩系统已开机自动启动。',
    'echo   这个窗口是服务器，**不要关闭**；关掉就等于停了服务。',
    'echo   停止服务：双击项目里的「停止.bat」，或直接关掉这个窗口。',
    'echo.',
    '"' + nodeExe + '" --no-warnings server.js',
    'echo.',
    'echo   服务已退出。若这不是你主动停的，请查看上面的报错信息。',
    'timeout /t 10 /nobreak',
    '',
  ].join('\r\n');

  try {
    // 用 UTF-8 + BOM 写：这是 Windows 的"启动"文件夹里给自己用的 .bat，
    // 内容有中文注释，BOM 能帮记事本/部分编辑器认出编码。
    // （cmd 执行时中文只在 rem/echo 里，不影响运行）
    fs.writeFileSync(file, '\uFEFF' + bat, 'utf8');
    ok('已设置开机自启');
    info('位置：' + file);
    info('用的 Node：' + nodeExe);
  } catch (e) {
    addProblem('写不进启动文件夹：' + e.message, '手动把「启动.bat」的快捷方式放进：' + dir);
    return;
  }

  console.log('');
  console.log('  ' + paint('下次开机登录后会自动启动服务，窗口会自己弹出来。', C.bold));
  console.log('  想取消：再点一次「开机自启.bat」。');
  console.log('  ' + paint('提示：开机自启前建议先双击一次「一键部署.bat」把防火墙放行好。', C.dim));
}

/* ══ 口令提示 ═════════════════════════════════════════════════════════════ */

function printPasswordHint() {
  const f = path.join(ROOT, '口令.txt');
  if (fs.existsSync(f)) {
    console.log('');
    console.log('  ' + paint('账号口令：见本文件夹里的「口令.txt」', C.bold));
    return;
  }
  console.log('');
  console.log('  ' + paint('账号口令：首次启动会在这台电脑上生成，并写入「口令.txt」', C.bold));
  console.log('  ' + paint('默认管理员是 admin；第一次启动时窗口里也会打印一次口令。', C.dim));
}

/* ══ 结束语 ══════════════════════════════════════════════════════════════ */

function printSummary() {
  head('结果');
  if (problems.length) {
    console.log('  有 ' + problems.length + ' 项需要处理：');
    problems.forEach((p, i) => {
      console.log('    ' + (i + 1) + '. ' + p.msg);
      if (p.howTo) console.log('       → ' + p.howTo);
    });
    console.log('');
    console.log('  ' + paint('处理完再双击「一键部署.bat」重跑一次即可。', C.bold));
  } else {
    ok(paint('全部就绪', C.bold));
  }
}

/* ══ 主流程 ══════════════════════════════════════════════════════════════ */

(async () => {
  console.log('');
  console.log(paint('  运动会成绩实时统计与大屏展示系统 · 一键部署', C.bold));
  console.log(paint('  项目目录：' + ROOT, C.dim));
  if (MESSAGE) console.log(paint('  本次操作：' + MESSAGE, C.cyan));
  if (CHECK_ONLY) console.log(paint('  （体检模式：只看不改）', C.yellow));

  /* --autostart：只处理开机自启，不碰别的（老师点「开机自启.bat」时走这条） */
  if (AUTOSTART) {
    toggleAutostart();
    printSummary();
    console.log('');
    return;
  }

  /* --firewall-only：只放行防火墙（老师点「防火墙放行.bat」时走这条） */
  const port = getPort();
  if (FIREWALL_ONLY) {
    checkRuntime();
    checkFirewall(port);
    head('防火墙放行结果');
    if (problems.length) {
      problems.forEach((p) => { console.log('  · ' + p.msg); if (p.howTo) info('→ ' + p.howTo); });
    } else {
      ok(paint('已放行，手机现在应该能连上了', C.bold));
      const addrs = lanAddresses().filter(a => !a.virtual);
      if (addrs.length) {
        console.log('');
        console.log('  让手机打开：' + paint('http://' + addrs[0].address + ':' + port + '/admin', C.bold));
      }
    }
    console.log('');
    return;
  }

  checkRuntime();
  if (!QUICK) checkFiles();
  const portState = checkPort(port);
  checkData();
  if (!QUICK) {
    const fw = checkFirewall(port);
    void fw;
  }
  const addrs = printAddresses(port);
  printPasswordHint();
  printSummary();

  // 已经在跑的服务：直接给地址，不再重复启动（重复启动会因端口占用失败）
  const live = await probeLocal(port);
  if (live) {
    console.log('');
    ok('检测到服务已经在运行（不用再启动）');
    if (addrs.length) {
      console.log('  手机现在就能打开：' + paint('http://' + addrs[0].address + ':' + port + '/admin', C.bold));
    }
    console.log('');
    return;
  }
  void portState;

  if (CHECK_ONLY || NO_START) {
    console.log('');
    console.log('  ' + paint('体检/部署完成。要启动服务就双击「启动.bat」。', C.bold));
    console.log('');
    return;
  }

  console.log('');
  console.log(paint('  ── 现在启动服务（这个窗口别关）──────────────────────────', C.bold));
  console.log(paint('  关掉这个窗口 = 停止服务，大屏和手机都会断开。', C.dim));
  console.log(paint('  要停止：双击「停止.bat」，或直接关掉这个窗口。', C.dim));
  console.log('');

  // 用当前这个 node 起服务，并把输出直接接到本窗口
  const child = spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'server.js')], {
    cwd: ROOT, stdio: 'inherit',
  });
  if (child.status !== 0) {
    console.log('');
    bad('服务退出（代码 ' + child.status + '）。常见原因看上面的提示：');
    info('1) 端口被占用 → 改 config.js 的 port');
    info('2) data\\ 不可写 → 把文件夹移到 D:\\ 或 F:\\');
    info('3) Node 版本太低 → 需要 22.5 以上');
  }
})();
