'use strict';
/**
 * init-test-db.js —— 建一个空的测试库（建表 + 建运动会 + 建管理员）
 *
 * 【为什么单拎出来】`tools/seed-fake-meet.js` 是往**已有**的库里灌假数据，
 * 它假设库已经建好了。而测试版目录是全新复制的，`data/` 是空的 ——
 * 所以要先有一步"把库建起来"。
 *
 * 这里**不** require server.js：那会连带起定时任务、占用端口。
 * 只做建库需要的那几件事（与 server.js 的 initData 一致）：
 *   建表（db.open 里做）→ 建运动会 → 建第一个管理员
 *
 * 用法：DATA_DIR=<测试目录>/data node tools/init-test-db.js
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
let CFG = {};
try { CFG = require('../config.js') || {}; } catch (e) { CFG = {}; }
const DATA_DIR = path.resolve(String(process.env.DATA_DIR || CFG.dataDir || path.join(ROOT, 'data')));

const db = require('../src/db');
const seed = require('../src/seed');
const Auth = require('../src/auth');

fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'sports.db');
console.log('');
console.log('  数据目录：' + DATA_DIR);

/* db.open 会建表 + 跑迁移 */
const d = db.open(DB_FILE);

/* 运动会（组别/班级/运动员随后由 seed-fake-meet.js 灌） */
if (!db.currentMeet(d)) {
  seed.ensureMeet(d, {
    name: '【测试版】校运动会',
    subtitle: '功能测试用 · 数据是假的',
    host: '测试',
    holdDate: '2026-09-30',
  });
  console.log('  已建运动会');
} else {
  console.log('  库里已有运动会，沿用');
}

/* 管理员：测试版保持默认口令，方便反复试 */
const adminUser = CFG.adminUser || 'admin';
const adminPassword = CFG.adminPassword || 'admin123';
const info = Auth.ensureFirstAdmin(d, { username: adminUser, password: adminPassword });
if (info && info.created) {
  console.log('  已建管理员：' + adminUser + ' / ' + adminPassword);
} else {
  console.log('  管理员已存在：' + adminUser);
}

const meet = db.currentMeet(d);
console.log('  运动会：' + meet.name + '（' + meet.holdDate + '）');
console.log('');
d.close();
