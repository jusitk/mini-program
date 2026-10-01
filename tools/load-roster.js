'use strict';
/**
 * load-roster.js —— 把「代表队名单」一次性录进系统
 *
 * 【为什么有这个工具】
 *   学校发来的名单是 Word/Excel，格式五花八门。这个工具专门认"一个班一块、
 *   一行两个人"的**代表队名单**格式（某中学的代表队名单就是这种），
 *   直接把运动员、班级、项目、报名全部建好，不用手工录 900 多人。
 *
 * 【怎么用】
 *   node tools/load-roster.js "名单.doc"                 # 先看解析结果（不写库）
 *   node tools/load-roster.js "名单.doc" --write          # 真正写进数据库
 *   node tools/load-roster.js "名单.doc" --write --relay-legs
 *
 *   · .doc 其实是 docx（ZIP）也能读；老的二进制 .doc 读不了，请先另存为 .docx
 *   · 名单格式：以「XX组  XX班(N人)」开头的块，块内分「男子/女子」，
 *     运动员行形如：号码 | 姓名 | 项目1、项目2  （一行可以并排两个人）
 *   · 组别按名单里的"XX组"建（名次就是按组别算的），项目按「组别+性别+项目」建
 *   · 幂等：重复执行不会产生重复数据（按 组别+姓名+号码 / 组别+项目名 认）
 *
 * 【安全】
 *   · 默认**只解析不写库**，必须先加 --write 才动手
 *   · 写库前会自动备份一份到 data/backup
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const src = args.find(a => !a.startsWith('--'));
const WRITE = args.indexOf('--write') >= 0;

if (!src) {
  console.log(`
用法：
  node tools/load-roster.js "代表队名单.doc"            先看解析结果（不写库）
  node tools/load-roster.js "代表队名单.doc" --write     真正写进数据库

说明：默认只解析；加了 --write 才会写库，并且写之前自动备份。
`);
  process.exit(0);
}
if (!fs.existsSync(src)) { console.error('找不到文件：' + src); process.exit(1); }

/* ── 读 docx 的表格 ─────────────────────────────────────────────────── */

function readDocxRows(file) {
  const head = fs.readFileSync(file).subarray(0, 4);
  if (!(head[0] === 0x50 && head[1] === 0x4B)) {
    console.error('这个文件不是 .docx（ZIP）格式。老的二进制 .doc 读不了，');
    console.error('请在 Word 里「另存为 → Word 文档(.docx)」再试。');
    process.exit(1);
  }
  const tmp = path.join(ROOT, '_roster.xml');
  const ps = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
    "$z=[System.IO.Compression.ZipFile]::OpenRead('" + file.replace(/'/g, "''") + "');",
    "$e=$z.Entries | Where-Object { $_.FullName -eq 'word/document.xml' };",
    "if (-not $e) { Write-Error 'docx 里没有 word/document.xml'; exit 1 }",
    '$sr=New-Object System.IO.StreamReader($e.Open(),[System.Text.Encoding]::UTF8);',
    '$t=$sr.ReadToEnd(); $sr.Close(); $z.Dispose();',
    "[System.IO.File]::WriteAllText('" + tmp.replace(/'/g, "''") + "',$t,[System.Text.Encoding]::UTF8);",
  ].join(' ');
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'] });
  const xml = fs.readFileSync(tmp, 'utf8');
  fs.unlinkSync(tmp);

  const cellText = (tc) => {
    const parts = [];
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(tc))) parts.push(m[1]);
    return parts.join('')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ').trim();
  };
  const rows = [];
  const trRe = /<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g;
  let tr;
  while ((tr = trRe.exec(xml))) {
    const cells = [];
    const tcRe = /<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g;
    let tc;
    while ((tc = tcRe.exec(tr[1]))) cells.push(cellText(tc[1]));
    rows.push(cells);
  }
  return rows;
}

/* ── 解析：一个班一块，一行两人 ─────────────────────────────────────── */

const BLOCK_RE = /^(\S*?组)\s*[　\s]+(\S*?班)\s*[（(](\d+)\s*人[）)]/;

function parseRoster(rows) {
  const people = [];
  const blocks = [];
  const warns = [];
  let block = null, gender = '';

  rows.forEach((cells, ri) => {
    const line = cells.map(c => String(c || '').trim()).filter(Boolean);
    if (!line.length) return;
    if (/^代\s*表\s*队\s*名\s*单$/.test(line[0].replace(/\s/g, ''))) return;

    const bm = BLOCK_RE.exec(line[0]);
    if (bm) {
      block = { group: bm[1], className: bm[2], declared: Number(bm[3]), got: 0 };
      blocks.push(block);
      gender = '';
      return;
    }
    if (/^(领队|教练)\s*[:：]/.test(line[0])) return;
    if (line.length === 1 && /^(男子|女子|男生|女生)$/.test(line[0])) {
      gender = /男/.test(line[0]) ? '男' : '女';
      return;
    }
    if (!block) { warns.push('第 ' + (ri + 1) + ' 行不在任何班级块里，已忽略'); return; }

    // 一行可能并排两个人：号码 姓名 项目 | 号码 姓名 项目
    for (let i = 0; i + 1 < line.length; i += 3) {
      const bib = line[i], name = line[i + 1], ev = line[i + 2];
      if (!bib || !name || !/^\d{3,6}$/.test(bib)) continue;
      people.push({
        group: block.group,
        className: block.className,
        gender,
        bib,
        name,
        events: String(ev || '').split(/[、,，]/).map(s => s.trim()).filter(Boolean),
      });
      block.got++;
    }
  });

  return { people, blocks, warns };
}

/* ── 项目：按"组别 + 性别 + 项目"建；100/200 米另拆预赛 ─────────────── */

/** 项目名 → 田赛/径赛、是否接力 */
const KIND_OF = {
  '100米': 'track', '200米': 'track', '400米': 'track', '800米': 'track',
  '1500米': 'track', '400米障碍赛': 'track', '4×100': 'track',
  '跳高': 'field', '跳远': 'field', '三级跳远': 'field', '实心球': 'field',
  '引体向上': 'field', '仰卧起坐': 'field',
};

/**
 * 要拆预赛的项目（高一~高三），以及预赛录取人数。
 * 依据规程的「赛次」列：初一/初二只取前 3 名，直接决赛；
 * 高一/高二/高三的 100 米、200 米有预赛（分别取 8 名、6 名）。
 * 特例：高一组 200 米规程只排了"预赛取 6 名"、没有单列决赛 ⇒ 只建预赛。
 */
function planStages(groupName, evName, junior) {
  if (junior) return [{ stage: 'final', advanceCount: 3 }];
  if (evName === '100米') return [{ stage: 'heat', advanceCount: 8 }, { stage: 'final', advanceCount: 6 }];
  if (evName === '200米') {
    if (groupName === '高一组') return [{ stage: 'heat', advanceCount: 6 }];
    return [{ stage: 'heat', advanceCount: 6 }, { stage: 'final', advanceCount: 6 }];
  }
  return [{ stage: 'final', advanceCount: 6 }];
}

/* ── 主流程 ─────────────────────────────────────────────────────────── */

const rows = readDocxRows(src);
const { people, blocks, warns } = parseRoster(rows);

console.log('');
console.log('  解析结果');
console.log('  ' + '─'.repeat(60));
console.log('  运动员 ' + people.length + ' 人，班级块 ' + blocks.length + ' 个');
const groups = [...new Set(people.map(p => p.group))];
groups.forEach((g) => {
  const n = people.filter(p => p.group === g).length;
  console.log('    ' + g.padEnd(8) + n + ' 人');
});
const gBySex = {};
people.forEach(p => { gBySex[p.gender || '(未标)'] = (gBySex[p.gender || '(未标)'] || 0) + 1; });
console.log('  性别：' + Object.keys(gBySex).map(k => k + ' ' + gBySex[k]).join('　'));

const badBlock = blocks.filter(b => b.got !== b.declared);
console.log('  班级人数核对：' + (badBlock.length
  ? badBlock.map(b => b.className + ' 声明' + b.declared + '实际' + b.got).join('；')
  : '全部 ' + blocks.length + ' 个班与名单声明一致 ✔'));

const evNames = [...new Set(people.flatMap(p => p.events))];
console.log('  比赛项目 ' + evNames.length + ' 种：' + evNames.join('、'));
const unknown = evNames.filter(e => !KIND_OF[e]);
if (unknown.length) console.log('  ⚠ 认不出田赛/径赛的项目：' + unknown.join('、') + '（会按径赛处理）');

// 统计要建多少项目
let evCount = 0;
groups.forEach((g) => {
  const junior = /^初一|^初二/.test(g);
  ['男', '女'].forEach(() => {
    evNames.forEach((e) => { evCount += planStages(g, e, junior).length; });
  });
});
console.log('  将创建项目约 ' + evCount + ' 个（组别 × 性别 × 项目，100/200 米含预赛）');

if (!WRITE) {
  console.log('');
  console.log('  以上只是解析结果，**没有写库**。确认无误后加 --write 再执行一次。');
  console.log('');
  process.exit(0);
}

/* ── 写库 ───────────────────────────────────────────────────────────── */

const db = require('../src/db');
const Ops = require('../src/ops');
const d = db.open(path.join(ROOT, 'data', 'sports.db'));
const meet = db.currentMeet(d);
if (!meet) { console.error('数据库里还没有运动会，请先启动一次服务。'); process.exit(1); }

/* 写库前先备份一份（出错能退回去）。d.backupTo(file) 是 db.open() 返回对象上的方法。 */
try {
  if (typeof d.backupTo === 'function') {
    const dir = path.join(ROOT, 'data', 'backup');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const file = path.join(dir, 'sports-' + stamp + '-before-roster.db');
    d.backupTo(file);
    console.log('  已备份：' + path.basename(file));
  } else {
    console.log('  提示：服务启动时会自动备份；也可以稍后在后台点「立即备份」');
  }
} catch (e) {
  console.log('  （备份跳过：' + (e && e.message) + '）');
}

const log = [];
const call = (op, payload) => {
  try { return { ok: true, out: Ops.execute({ d, op, payload, meetId: meet.id }) }; }
  catch (e) { log.push(op + '：' + e.message); return { ok: false, err: e.message }; }
};

/* 组别 */
const groupIds = {};
groups.forEach((g, i) => {
  const hit = d.get('SELECT * FROM groupDef WHERE meetId = ? AND name = ?', [meet.id, g]);
  if (hit) { groupIds[g] = hit.id; return; }
  const r = call('group.add', { name: g, sort: i + 1 });
  if (r.ok) groupIds[g] = r.out.id; else console.error('  建组别失败 ' + g + '：' + r.err);
});

/* 项目（批量） */
const eventIdByKey = new Map();
const items = [];
let sortSeq = 0;
groups.forEach((g) => {
  const junior = /^初一|^初二/.test(g);
  ['男', '女'].forEach((sex) => {
    evNames.forEach((ev) => {
      planStages(g, ev, junior).forEach((st) => {
        sortSeq += 10;
        const name = g + (sex === '男' ? '男子' : '女子') + ev + (st.stage === 'heat' ? '预赛' : '决赛');
        const key = [g, sex, ev, st.stage].join('|');
        const hit = d.get('SELECT id FROM event WHERE meetId = ? AND name = ?', [meet.id, name]);
        if (hit) { eventIdByKey.set(key, hit.id); return; }
        items.push({
          key, op: 'event.add',
          payload: {
            name, groupId: groupIds[g],
            kind: KIND_OF[ev] || 'track',
            stage: st.stage,
            isRelay: ev.indexOf('4×100') >= 0,
            relayLegs: ev.indexOf('4×100') >= 0 ? 4 : undefined,
            attempts: (KIND_OF[ev] === 'field') ? 3 : 1,
            advanceCount: st.advanceCount,
            venue: (KIND_OF[ev] === 'field') ? '田赛区' : '田径场',
            sort: sortSeq,
          },
        });
      });
    });
  });
});
if (items.length) {
  const res = Ops.executeBatch({ d, items, meetId: meet.id });
  (res.results || []).forEach((r, i) => {
    if (r.ok && r.id) eventIdByKey.set(items[i].key, r.id);
    else log.push('建项目 ' + items[i].payload.name + '：' + (r.error || '失败'));
  });
}
console.log('  项目：新建 ' + items.length + ' 个');

/* 运动员 */
const athIdByKey = new Map();
let athNew = 0;
people.forEach((p) => {
  const key = [p.group, p.name, p.bib].join('|');
  const hit = d.get('SELECT * FROM athlete WHERE meetId = ? AND name = ? AND bib = ?', [meet.id, p.name, p.bib]);
  if (hit) { athIdByKey.set(key, hit.id); return; }
  const r = call('athlete.add', {
    name: p.name, groupId: groupIds[p.group],
    grade: p.group.replace(/组$/, ''), className: p.className, team: p.className,
    bib: p.bib, gender: p.gender, note: p.events.join('、'),
  });
  if (r.ok) { athIdByKey.set(key, r.out.id); athNew++; }
  else log.push('建运动员 ' + p.name + '：' + r.err);
});
console.log('  运动员：新建 ' + athNew + ' 人（已存在 ' + (people.length - athNew) + ' 人）');

/* 报名（接力按班成队 + 填队员） */
const relayPeople = new Map();
people.forEach((p) => {
  if (!p.events.some(e => e.indexOf('4×100') >= 0)) return;
  const k = [p.group, p.gender, p.className].join('|');
  if (!relayPeople.has(k)) relayPeople.set(k, []);
  relayPeople.get(k).push(p.name);
});

let regNew = 0, legSet = 0;
people.forEach((p) => {
  const athId = athIdByKey.get([p.group, p.name, p.bib].join('|'));
  if (!athId) return;
  p.events.forEach((ev) => {
    const junior = /^初一|^初二/.test(p.group);
    const st = planStages(p.group, ev, junior)[0].stage;
    const evId = eventIdByKey.get([p.group, p.gender, ev, st].join('|'));
    if (!evId) return;
    if (ev.indexOf('4×100') >= 0) {
      let reg = d.get('SELECT * FROM registration WHERE eventId = ? AND teamName = ?', [evId, p.className]);
      if (!reg) {
        const r = call('reg.add', { eventId: evId, teamName: p.className });
        if (r.ok) { regNew++; reg = d.get('SELECT * FROM registration WHERE eventId = ? AND teamName = ?', [evId, p.className]); }
        else return;
      }
      const names = (relayPeople.get([p.group, p.gender, p.className].join('|')) || []).slice(0, 4);
      const cur = reg.legsJson ? JSON.parse(reg.legsJson) : [];
      if (names.length && JSON.stringify(cur) !== JSON.stringify(names)) {
        if (call('reg.legs', { id: reg.id, legs: names }).ok) legSet++;
      }
      return;
    }
    if (d.get('SELECT id FROM registration WHERE eventId = ? AND athleteId = ?', [evId, athId])) return;
    if (call('reg.add', { eventId: evId, athleteId: athId }).ok) regNew++;
  });
});
console.log('  报名：新建 ' + regNew + ' 条，接力队填队员 ' + legSet + ' 个');

/* 公告：顺手写两条现场常用的，**幂等**（同一条只加一次）。
   这个脚本学校改名单后会反复跑，不判重的话公告栏会堆一堆重复的。 */
let ntNew = 0;
function noticeOnce(text, level) {
  if (d.get('SELECT id FROM notice WHERE meetId = ? AND text = ?', [meet.id, text])) return;
  if (call('notice.add', { text, level }).ok) ntNew++;
}
noticeOnce('各项目录取名次：初一、初二组取前 3 名；高一、高二、高三组取前 6 名。'
  + '班级总分按 7、5、4、3、2、1 计分。', 'important');
noticeOnce('请各班代表队按赛程提前到检录处集合，检录开始后未到的按弃权处理。', 'info');
if (ntNew) console.log('  公告：新增 ' + ntNew + ' 条（已有的不重复加）');

if (warns.length) {
  console.log('');
  console.log('  解析时的提示（前 5 条）：');
  warns.slice(0, 5).forEach(w => console.log('    ' + w));
}
if (log.length) {
  console.log('');
  console.log('  写库时的问题（前 10 条）：');
  log.slice(0, 10).forEach(x => console.log('    ' + x));
}

const st = {
  g: d.get('SELECT COUNT(*) c FROM groupDef WHERE meetId=?', [meet.id]).c,
  c: d.get('SELECT COUNT(*) c FROM classDef WHERE meetId=?', [meet.id]).c,
  a: d.get('SELECT COUNT(*) c FROM athlete WHERE meetId=?', [meet.id]).c,
  e: d.get('SELECT COUNT(*) c FROM event WHERE meetId=?', [meet.id]).c,
  r: d.get('SELECT COUNT(*) c FROM registration WHERE meetId=?', [meet.id]).c,
};
console.log('');
console.log('  库里现有：组别 ' + st.g + '　班级 ' + st.c + '　运动员 ' + st.a
  + '　项目 ' + st.e + '　报名 ' + st.r);
console.log('');
d.close();
