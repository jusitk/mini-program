'use strict';
/**
 * make-test-copy.js —— 另外生成一份**测试版**（不动原目录一个文件）
 *
 * 【为什么要有它】要在服务器上试各个功能、找 BUG，又不能让测试动作碰到
 * 正在用的那份数据。所以复制出一份独立的目录：自己的端口、自己的库、
 * 自己的假名单。测坏了、测乱了，删掉重新生成即可，原目录始终是干净的。
 *
 * 【原目录绝对不动】
 *   这个脚本只**读**原目录（复制文件），所有写入都在目标目录里。
 *   原目录的 data/（真实库）**不会被复制** —— 测试版用自己生成的假数据。
 *
 * 【生成出来的测试版包含什么】
 *   · 全部代码（server.js / src / public / tools / test / 启动脚本 / 文档）
 *   · 一份全新的空库，然后灌入**假名单与假赛程**（200 人上下、36 个项目）
 *   · 一个把端口设成 8080 的 config.js（测试版独占这个端口）
 *   · 一份《测试版说明.md》：怎么起、怎么测、测完怎么删
 *
 * 【不复制什么】
 *   data/（真实库与备份）、shots/（体检截图）、下划线开头的临时文件、
 *   口令.txt、node/（便携版 Node 运行时，几十 MB，测试版不需要）
 *
 * 用法：
 *   node tools/make-test-copy.js                    # 生成到 <上级目录>/运动会计分系统-测试版
 *   node tools/make-test-copy.js --to=D:\test       # 指定目标目录
 *   node tools/make-test-copy.js --port=8081        # 换个端口（默认 8080）
 *   node tools/make-test-copy.js --force            # 目标已存在时先删掉再生成
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (k, dflt) => {
  const hit = args.find(a => a.indexOf('--' + k + '=') === 0);
  return hit ? hit.slice(k.length + 3) : dflt;
};
const FORCE = args.indexOf('--force') >= 0;
const PORT = Number(argOf('port', '8080')) || 8080;
const TARGET = path.resolve(argOf('to', path.join(path.dirname(ROOT), path.basename(ROOT) + '-测试版')));

/** 不复制的东西（按名字判断，路径分隔统一成 / ） */
const SKIP_DIRS = ['data', 'shots', 'node', '.git', 'node_modules', '.dsh'];
const isSkipDir = (name) => SKIP_DIRS.indexOf(name) >= 0;
const isSkipFile = (name) => (
  name === '口令.txt'
  || /^_/.test(name)                       // 我的临时探针/日志
  || /\.(bak|log|pid)$/i.test(name)
  || /\.db(-wal|-shm)?$/i.test(name)
);

console.log('');
console.log('  原目录：' + ROOT);
console.log('  测试版：' + TARGET);
console.log('  端口：' + PORT);
console.log('');

/* ── 安全检查：别把自己复制进自己 ────────────────────────────────────── */
if (TARGET === ROOT || ROOT.indexOf(TARGET + path.sep) === 0) {
  console.error('  ✘ 目标目录不能是原目录本身或它的上级，请换个位置。');
  process.exit(1);
}

/* ── 目标已存在？ ────────────────────────────────────────────────────── */
if (fs.existsSync(TARGET)) {
  if (!FORCE) {
    console.error('  ✘ 目标目录已存在：' + TARGET);
    console.error('    要覆盖生成就加 --force（**会删掉那个目录里的所有东西**）');
    process.exit(1);
  }
  console.log('  目标已存在，--force：先删掉它…');
  fs.rmSync(TARGET, { recursive: true, force: true });
}

/* ── 复制代码 ────────────────────────────────────────────────────────── */
let files = 0;
let bytes = 0;
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (isSkipDir(ent.name)) continue;
      copyDir(path.join(from, ent.name), path.join(to, ent.name));
    } else if (ent.isFile()) {
      if (isSkipFile(ent.name)) continue;
      const src = path.join(from, ent.name);
      const dst = path.join(to, ent.name);
      fs.copyFileSync(src, dst);
      files++;
      bytes += fs.statSync(src).size;
    }
  }
}
console.log('  复制代码…');
copyDir(ROOT, TARGET);
console.log('    ' + files + ' 个文件，' + (Math.round(bytes / 1024)) + ' KB');
console.log('    （已跳过：data/ shots/ node/ 口令.txt 临时文件）');

/* ── config.js：把端口写死成测试端口，其余照抄原配置 ─────────────────── */
const cfgPath = path.join(TARGET, 'config.js');
let cfgSrc = fs.readFileSync(cfgPath, 'utf8');
cfgSrc = cfgSrc.replace(/port:\s*\d+/, 'port: ' + PORT)
  + '\n/* ══════════════════════════════════════════════════════════════════════\n'
  + ' * 【这是测试版】\n'
  + ' *   · 端口写死 ' + PORT + '（原版也是这个端口，所以**两个不要同时开**）\n'
  + ' *   · data/ 里是**假数据**，随便录、随便试，测坏了重新生成一份即可\n'
  + ' *   · 原目录一个文件都没动\n'
  + ' * ══════════════════════════════════════════════════════════════════════ */\n';
fs.writeFileSync(cfgPath, cfgSrc, 'utf8');
console.log('  已把端口设为 ' + PORT);

/* ── 生成库 + 灌假数据 ───────────────────────────────────────────────── */
console.log('');
console.log('  正在建库…');
const dataDir = path.join(TARGET, 'data');
fs.mkdirSync(dataDir, { recursive: true });
function runTool(rel, label) {
  try {
    const out = execFileSync(process.execPath, ['--no-warnings', path.join(TARGET, rel)], {
      cwd: TARGET, encoding: 'utf8',
      env: Object.assign({}, process.env, { DATA_DIR: dataDir }),
    });
    out.split('\n').filter(l => l.trim()).forEach(l => console.log('    ' + l.trim()));
    return true;
  } catch (e) {
    console.error('  ✘ ' + label + ' 失败：');
    console.error(String((e && e.stdout) || '') + String((e && e.stderr) || ''));
    return false;
  }
}
if (!runTool(path.join('tools', 'init-test-db.js'), '建库')) process.exit(1);
console.log('');
console.log('  正在生成假名单/假赛程…');
if (!runTool(path.join('tools', 'seed-fake-meet.js'), '造假数据')) process.exit(1);

/* ── 附一份《测试版说明.md》 ─────────────────────────────────────────── */
const readme = `# 测试版说明（自动生成）

这份是**测试用**的独立副本，原目录一个文件都没动。
里面的名单、赛程、班级都是**假的**，随便录、随便试，测坏了重新生成一份即可。

## 一、怎么启动

1. 双击 **启动.bat**（第一次可能要允许防火墙）
2. 黑窗口里会打印两个地址：
   - 大屏：\`http://127.0.0.1:${PORT}/screen\`
   - 后台：\`http://127.0.0.1:${PORT}/admin\`
   - 手机用同一个局域网地址（形如 \`http://192.168.x.x:${PORT}\`）
3. 登录：**admin / admin123**（这是测试版，口令保持默认方便你反复试）

> ⚠ 端口写死成 **${PORT}**，和原版一样 —— **两个不要同时开**。
>   要同时开就把这份的 \`config.js\` 里 \`port\` 改成 ${PORT + 1}。

第一次登录就会看到：
- **${'${}'}名单**：16 个班、160 名运动员（初一/初二/高一/高二，每级 4 个班）
- **赛程编排**：36 个项目，都是"未开始 + 按时间自动"
- 大屏打开就有内容（赛程栏、班级总分栏）

## 二、建议按这个顺序测

| 步骤 | 怎么试 | 该看到什么 |
|---|---|---|
| 1 | 大屏先开着，后台录一条成绩 | 大屏**不闪、不跳**，那一格数字变了 |
| 2 | 连着录同一个项目好几条 | 名次和班级总分实时变；大屏卡片按名次排 |
| 3 | 找一个人录**相同成绩** | 并列名次按 1、2、2、4；不同成绩（如 12.01/12.02）**不并列** |
| 4 | 田赛项目（跳远/铅球）录第 4 次 | 应当被拒：这个项目只记 3 次 |
| 5 | 检录页开始检录 → 点名 | 大屏底部公告栏出现一条检录提示 |
| 6 | 两个人**同时**改同一条成绩 | 后提交的看到"刚被别人改过"，可以选用谁的 |
| 7 | 管理员暂存一条改动，**先别确认**，另一处直接改同一条，再确认 | 应当**拒绝**并列出冲突（不会静默覆盖） |
| 8 | 断网（拔网线/关 WiFi）后录一条成绩 | 顶栏出现**待补交 N 条**；恢复网络后自动补交 |
| 9 | 手机上打开后台（同一个局域网地址） | 页面自适应，能正常录入 |
| 10 | 预赛项目点「录取决赛」 | 生成决赛并把预赛前六名**预填**进去；再到「名单」页删掉一个、补上一个，都能改 |
| 11 | 导出排名 Excel / 成绩单打印 | 能下载、内容对 |
| 12 | 后台改口令 → 看原来看后台的另一个窗口 | 那个窗口的实时连接**立刻断开**，要求重新登录 |
| 13 | 只读账号试着上传图片、清空暂存 | 都应当被拒（403） |
| 14 | 聊天发图片 | 能发能看；**没有语音按钮**（有意去掉的） |
| 15 | **同一个账号在第二台设备登录**（比如电脑上开着后台，再用手机登 admin） | 电脑那台**立刻弹出提示并跳回登录页**，登录页写着"这个账号在另一台设备上登录了（IP）…已被下线"。这是**有意设计**的：防止两人共用一个账号同时录成绩互相覆盖。不是 BUG。 |
| 16 | 后台「账号」页 ── 点某个账号的「已登录（IP）」 | 能看到它现在登录在哪台机器（IP/设备/最后活跃），也能把它踢下线 |

> **关于"一个账号只能一台设备"**：现场最容易被忽略的出错来源就是共用账号 ——
> 两个人用同一个操作员账号、各自在自己手机上录成绩，录到同一个项目就会互相覆盖。
> 所以默认**一人一台**：在别处登录会把原来那台顶下线，并明确告诉那台"你被顶了、从哪个 IP 顶的"。
> 如果确实需要同时登录（比如你既要在电脑上开着、又要用手机看），
> 把测试版 config.js 里的 allowMultiDeviceLogin 改成 true 再重启。
> 每次登录会顶掉 **1 台**，测试时可留意页面提示。

## 三、测完怎么处理

- 想**重新来一遍**：删掉整个测试版目录，回到原目录重新跑一次
  \`node tools/make-test-copy.js --force\` 即可。
- 只想**清掉录的成绩**（保留假名单）：
  \`node tools/reset-meet.js --write\`
- 不要了就直接把整个测试版目录删掉。

## 四、这份测试版和原版的差别

| | 原版 | 测试版 |
|---|---|---|
| 数据 | 真实名单（905 人 140 项目） | **假名单**（160 人 36 项目） |
| 端口 | ${PORT} | ${PORT}（一样，别同时开） |
| 目录 | 原目录 | 这个独立目录，互不影响 |
| 代码 | — | **完全相同**（复制过来的） |

代码是完全一样的，所以在这里测出来的 BUG，在原版上也会有。

---

生成时间：${new Date().toLocaleString('zh-CN')}
`;
fs.writeFileSync(path.join(TARGET, '测试版说明.md'), readme, 'utf8');

/* ── 自检：确认复制出来的东西能跑 ────────────────────────────────────── */
console.log('');
console.log('  自检…');
let bad = 0;
const must = ['server.js', 'config.js', 'package.json', '启动.bat',
  path.join('src', 'db.js'), path.join('public', 'admin.html'),
  path.join('tools', 'reset-meet.js'), path.join('test', 'run.js')];
must.forEach((f) => {
  const ok = fs.existsSync(path.join(TARGET, f));
  if (!ok) bad++;
  console.log('    ' + (ok ? '✔' : '✘') + ' ' + f);
});
// data 里应当有库和上传目录，但**不该有原版的备份**
const tData = fs.readdirSync(dataDir);
console.log('    ' + (tData.indexOf('sports.db') >= 0 ? '✔' : '✘') + ' data/sports.db（测试库）');
if (tData.indexOf('backup') >= 0) {
  const bk = fs.readdirSync(path.join(dataDir, 'backup'));
  console.log('    ' + (bk.length === 0 ? '✔' : '·') + ' data/backup/ 里有 ' + bk.length + ' 个文件（原版备份没被复制过来）');
}
console.log('    ' + (fs.existsSync(path.join(TARGET, '测试版说明.md')) ? '✔' : '✘') + ' 测试版说明.md');
// 确认原版的数据没被带过来
if (fs.existsSync(path.join(dataDir, 'uploads'))) {
  const up = fs.readdirSync(path.join(dataDir, 'uploads'));
  console.log('    ' + (up.length === 0 ? '✔' : '·') + ' data/uploads/ 是空的（没带原版附件）');
}
// 确认端口写对了
const cfg2 = fs.readFileSync(path.join(TARGET, 'config.js'), 'utf8');
const pm = cfg2.match(/port:\s*(\d+)/);
console.log('    ' + (pm && Number(pm[1]) === PORT ? '✔' : '✘') + ' config.js 端口 = ' + (pm ? pm[1] : '?'));

console.log('');
if (bad) {
  console.log('  ✘ 自检有 ' + bad + ' 项不过，测试版可能不完整。');
  process.exit(1);
}
console.log('  ✔ 测试版已生成：' + TARGET);
console.log('');
console.log('  下一步：');
console.log('    1) 确认原版服务已停（两个都占 ' + PORT + '，同时开只有一个能起）');
console.log('    2) 进测试版目录，双击 启动.bat');
console.log('    3) 看「测试版说明.md」里那份测试清单');
console.log('');
