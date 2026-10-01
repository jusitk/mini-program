'use strict';
/**
 * my-ip.js —— 查这台电脑的局域网地址（对应「我的地址.bat」）
 *
 * 现场最容易卡住的一步就是"手机上打不开"。常见原因：
 *   1. 拿到的是虚拟网卡地址（VMware / Radmin / WSL / Hyper-V），手机根本连不上
 *   2. Windows 防火墙没放行端口
 * 这个工具把两类地址分开列，并给出可直接复制到手机里的完整网址。
 */

const os = require('node:os');
const path = require('node:path');

let CFG = {};
try { CFG = require('../config.js') || {}; } catch (e) { CFG = {}; }
const PORT = Number(process.env.PORT || CFG.port || 8080);

const VIRTUAL = /(vmware|virtualbox|vethernet|hyper-v|wsl|radmin|tailscale|zerotier|loopback|docker|vpn|tap|tun|bluetooth)/i;

function collect() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of (ifaces[name] || [])) {
      if (info.family !== 'IPv4' || info.internal) continue;
      out.push({ name, address: info.address, virtual: VIRTUAL.test(name) });
    }
  }
  return out.sort((a, b) => (a.virtual ? 1 : 0) - (b.virtual ? 1 : 0));
}

const addrs = collect();
const real = addrs.filter(a => !a.virtual);
const virt = addrs.filter(a => a.virtual);

console.log('');
console.log('  ' + '─'.repeat(60));
console.log('  这台电脑的地址（端口 ' + PORT + '，想换端口改 config.js 里的 port）');
console.log('  ' + '─'.repeat(60));

if (!real.length) {
  console.log('  ⚠ 没找到可用的局域网地址。');
  console.log('    可能原因：这台电脑没插网线也没连 Wi-Fi，或者网络被设为"公用网络"且被系统限制。');
  console.log('    请先确认这台电脑能上网（或能连上学校内网），再重新运行本工具。');
} else {
  real.forEach((a) => {
    console.log('  网卡：' + a.name);
    console.log('    大屏（投到电视）： http://' + a.address + ':' + PORT + '/screen');
    console.log('    后台管理：         http://' + a.address + ':' + PORT + '/admin');
    console.log('    （后台用手机浏览器打开就能录成绩，不需要另开页面）');
    console.log('');
  });
}

if (virt.length) {
  console.log('  ── 下面是虚拟网卡（手机通常连不上，别用这些） ──');
  virt.forEach(a => console.log('    ' + a.address + '   (' + a.name + ')'));
  console.log('');
}

console.log('  ' + '─'.repeat(60));
console.log('  手机连不上的排查顺序：');
console.log('    1. 手机和这台电脑必须连同一个 Wi-Fi（不能一个连 5G 一个连 2.4G 的隔离网络）');
console.log('    2. 这台电脑的网络要设为"专用网络"（Windows 设置 → 网络和 Internet）');
console.log('    3. 放行端口（管理员身份运行一次即可）：');
console.log('       netsh advfirewall firewall add rule name="SportsScore" dir=in action=allow protocol=TCP localport=' + PORT);
console.log('    4. 确认服务在运行（黑窗口还开着，且没报错）');
console.log('    5. 手机浏览器地址栏要带 http:// 和端口号，例如 http://' + (real[0] ? real[0].address : '192.168.1.10') + ':' + PORT + '/admin');
console.log('  ' + '─'.repeat(60));
console.log('');
