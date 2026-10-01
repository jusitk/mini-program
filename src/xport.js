'use strict';
/**
 * xport.js —— 导出（Excel / CSV）
 *
 * 【为什么用 HTML 表格当 .xls】
 *   零依赖是硬约束，不能引 xlsx 这类库。Excel 能直接打开"HTML 表格 + .xls 后缀"的文件，
 *   而且中文字体、列宽、粗体、底色都能带过去，现场用起来和真 Excel 没区别。
 *   CSV 则带 UTF-8 BOM（否则 Excel 打开中文全是乱码，这是最爱踩的坑）。
 *
 * 导出的六种表：
 *   results  成绩与名次（按项目，含预赛/决赛）
 *   rank     排名总表（只导名次与得分，用于张贴）
 *   roster   名单
 *   team     班级总分榜
 *   checkin  检录单（打印用）
 *   program  秩序册（按天/时间排的项目表）
 *   all      全部数据（JSON 备份用）
 */

const S = require('./scoring');
const Board = require('./scoreboard');
const { fmtLocal, nowIso, gradeRank, classRank, zhCompare } = require('./util');
const { formatResult, DNF_LABEL, FOUL_LABEL } = require('./parse');

/**
 * "没成绩"时的文字：**犯规和弃权要分开**。
 *   三次试跳全犯规 / 径赛被判犯规 → "犯规"（foulOnly）
 *   请假、没来、明确写了弃权      → "弃权"
 * 以前导出里只判断 dnf，结果犯规的人成绩栏显示成"弃权"，打印出来老师会问。
 * 汇总行由 rankEntries 标了 foulOnly；没走排名的（检录单）看 dnf/foul。
 * @param {object} row 报名行（en）或名次行（rank row）
 */
function noResultLabel(row) {
  if (!row) return '';
  if (row.foulOnly) return FOUL_LABEL;
  if (row.dnf) return row.display === FOUL_LABEL ? FOUL_LABEL : DNF_LABEL;
  return '';
}

/** 成绩栏文字：有成绩就格式化，没成绩给"犯规/弃权"，什么都没有给空 */
function resultCell(row, ev) {
  const nr = noResultLabel(row);
  if (nr) return nr;
  if (row.best === null || row.best === undefined) return '';
  return formatResult(row.best, ev.kind);
}

/**
 * 生成一份可导出的数据。
 * @returns {{title:string, sheets:Array<{name:string, head:string[], rows:Array, widths:number[]}>}}
 */
function build(d, meet, opts) {
  const what = (opts && opts.what) || 'results';
  const ctx = Board.load(d, meet.id);
  const boards = Board.allBoards(ctx);
  const rule = ctx.rule;

  const meetInfo = {
    name: meet.name || '运动会',
    subtitle: meet.subtitle || '',
    host: meet.host || '',
    holdDate: meet.holdDate || '',
    exportedAt: fmtLocal(nowIso(), true),
  };

  if (what === 'roster') {
    const list = Board.sortAthletes(ctx);
    return {
      title: '名单',
      meetInfo,
      sheets: [{
        name: '名单',
        head: ['序号', '组别', '年级', '班级', '号码', '姓名', '单位', '报名项目数', '备注'],
        widths: [6, 10, 8, 10, 8, 12, 16, 10, 18],
        rows: list.map((a, i) => [
          i + 1,
          (ctx.groupById.get(a.groupId) || {}).name || '',
          a.grade || '', a.className || '', a.bib || '', a.name,
          Board.athleteTeam(ctx, a),
          ctx.regs.filter(r => r.athleteId === a.id).length,
          a.note || '',
        ]),
      }],
    };
  }

  if (what === 'team') {
    const totals = S.teamTotals({
      events: ctx.events, boardByEvent: boards, rule,
      classById: ctx.classById, athleteName: (e) => Board.athleteName(ctx, e),
      finalsOf: ctx.finalsOf,
    });
    const gradeFilter = opts && opts.grade;
    const teams = gradeFilter ? totals.teams.filter(t => t.grade === gradeFilter) : totals.teams;
    return {
      title: gradeFilter ? ('班级总分榜-' + gradeFilter) : '班级总分榜',
      meetInfo,
      note: '计分规则：' + totals.ruleText + '　（并列名次各得该名次的全额分）'
        + (gradeFilter
          ? '　·　名次是**本年级内**的排名'
          : '　·　这是全校总排名；各年级内排名请导出「班级总分榜-年级」'),
      sheets: [{
        name: '班级总分',
        head: ['名次', '班级', '年级', '总分', '第一名', '第二名', '第三名', '得分明细'],
        widths: [8, 18, 10, 10, 9, 9, 9, 60],
        rows: teams.map(t => [
          // 按年级导出时用"本年级名次"，否则同一张表里会出现 4、5、6 这种跳号
          gradeFilter ? (t.classRank || t.rank) : t.rank,
          t.name, t.grade || '', t.points, t.gold, t.silver, t.bronze,
          t.details.map(x => x.eventName + '第' + x.rank + '名(' + x.points + '分)').join('；'),
        ]),
      }],
    };
  }

  if (what === 'checkin') {
    const eventId = opts && opts.eventId;
    const events = eventId ? [ctx.eventById.get(eventId)].filter(Boolean) : ctx.events.filter(e => e.status !== 'done');
    const sheets = events.map((ev) => {
      const b = Board.eventBoard(ctx, ev);
      return {
        name: ev.name.slice(0, 20),
        head: ['道次', '号码', '姓名', '班级/单位', '接力队员', '检录', '最好成绩', '名次'],
        widths: [7, 9, 12, 18, 30, 8, 12, 8],
        rows: b.entries.map(en => [
          en.lane === null ? '' : en.lane,
          en.bib, en.name, en.team,
          en.legs && en.legs.length ? en.legs.join('、') : '',
          en.arrived ? '已到' : '未到',
          resultCell(en, ev),
          (b.board.rows.find(r => r.regId === en.regId) || {}).rank || '',
        ]),
      };
    });
    return { title: '检录单', meetInfo, sheets };
  }

  if (what === 'program') {
    const events = ctx.events.slice().sort((a, b) =>
      (a.sort || 0) - (b.sort || 0)
      || String(a.startAt || '').localeCompare(String(b.startAt || '')));
    return {
      title: '秩序册',
      meetInfo,
      sheets: [{
        name: '项目安排',
        head: ['序号', '项目', '组别', '类型', '阶段', '开始时间', '结束时间', '场地', '报名人数', '状态'],
        widths: [6, 26, 10, 8, 8, 18, 18, 14, 10, 8],
        rows: events.map((e, i) => [
          i + 1, e.name, (ctx.groupById.get(e.groupId) || {}).name || '',
          e.kind === 'field' ? '田赛' : '径赛',
          e.stage === 'heat' ? '预赛' : '决赛',
          e.startAt ? fmtLocal(e.startAt, true) : '', e.endAt ? fmtLocal(e.endAt, true) : '',
          e.venue || '', (boards.get(e.id) || { entries: [] }).entries.length,
          e.status === 'done' ? '已结束' : e.status === 'live' ? '进行中' : '未开始',
        ]),
      }],
    };
  }

  if (what === 'all') {
    // 全量导出：给"换机器/存档"用，包含一切原始表
    const dump = d.dump();
    const sheets = Object.keys(dump).map(t => ({
      name: t.slice(0, 28),
      head: dump[t].length ? Object.keys(dump[t][0]) : ['（空表）'],
      widths: null,
      rows: dump[t].map(row => Object.keys(dump[t][0] || {}).map(k => row[k])),
    }));
    return { title: '全量数据', meetInfo, sheets };
  }

  if (what === 'rank') {
    // 只导名次与得分（张贴用）：每个已结束项目一块
    const sheets = [];
    const doneEvents = ctx.events.filter(e => e.status === 'done');
    doneEvents.forEach((ev) => {
      const b = boards.get(ev.id);
      sheets.push({
        name: (ev.name || '项目').slice(0, 20),
        head: ['名次', '号码', '姓名', '班级/单位', '接力队员', '成绩', '得分'],
        widths: [8, 9, 12, 18, 30, 12, 8],
        rows: b.board.rows.map(r => [
          r.rank, r.bib || '', r.isRelay ? (r.teamName || r.name) : r.name,
          r.isRelay ? '' : (r.team || ''),
          r.isRelay && r.legs && r.legs.length ? r.legs.join('、') : '',
          resultCell(r, ev),
          r.points || 0,
        ]),
      });
    });
    if (!sheets.length) {
      sheets.push({ name: '名次表', head: ['提示'], widths: [40], rows: [['还没有已结束的项目']] });
    }
    return { title: '排名表', meetInfo, sheets };
  }

  /* 逐项明细表：一个项目一张小表。
     好处是每个项目可以有自己的列（田赛次数、接力队员），打印时按项目分开。 */
  if (what === 'details') {
    const eventId2 = opts && opts.eventId;
    const evs = eventId2 ? [ctx.eventById.get(eventId2)].filter(Boolean) : ctx.events;
    const sheets2 = [];
    evs.forEach((ev) => {
      const b = boards.get(ev.id);
      const maxAttempts = Math.max(1, ev.attempts || 1);
      const head = ['名次', '号码', '姓名', '班级/单位', '道次'];
      if (ev.isRelay) head.push('接力队员');
      for (let k = 1; k <= maxAttempts; k++) head.push('第' + k + '次');
      head.push('最好成绩', '得分', '状态');
      const widths = [8, 9, 12, 18, 7];
      if (ev.isRelay) widths.push(30);
      for (let k = 1; k <= maxAttempts; k++) widths.push(10);
      widths.push(12, 8, 10);
      sheets2.push({
        name: (ev.name || '项目').slice(0, 20),
        head, widths,
        rows: b.entries.map((en) => {
          const row = b.board.rows.find(r => r.regId === en.regId) || {};
          const cells = [
            row.rank || '',
            en.bib, en.isRelay ? (en.teamName || '') : en.name, en.team,
            en.lane === null || en.lane === undefined ? '' : en.lane,
          ];
          if (ev.isRelay) cells.push(en.legs && en.legs.length ? en.legs.join('、') : '');
          for (let k = 1; k <= maxAttempts; k++) {
            const at = en.attemptsRaw.find(x => x.attempt === k);
            cells.push(at ? at.display : '');
          }
          cells.push(
            resultCell(en, ev),
            row.points || 0,
            (noResultLabel(en) || (en.attempts > 0 ? '已录' : '未录')));
          return cells;
        }),
      });
    });
    if (!sheets2.length) sheets2.push({ name: '成绩', head: ['提示'], widths: [40], rows: [['还没有项目']] });
    return { title: eventId2 && evs[0] ? evs[0].name : '成绩明细', meetInfo, sheets: sheets2 };
  }

  /* 默认：**一张横表装下所有项目**（现场核对、翻查、丢进别的表里算总分最方便）。
     列固定为：项目 / 组别 / 阶段 / 名次 / 号码 / 姓名 / 班级 / 成绩 / 得分 / 状态。
     接力项目的"姓名"位放班级名，队员名单另起一列。 */
  const eventId = opts && opts.eventId;
  const events = eventId ? [ctx.eventById.get(eventId)].filter(Boolean) : ctx.events;
  const HEAD = ['项目', '组别', '阶段', '名次', '号码', '姓名/班级', '班级/单位', '接力队员', '成绩', '得分', '状态'];
  const WIDTHS = [22, 9, 7, 7, 9, 13, 17, 28, 11, 7, 8];
  const rows = [];
  events.forEach((ev) => {
    const b = boards.get(ev.id);
    const groupName = (ctx.groupById.get(ev.groupId) || {}).name || '';
    const stage = ev.stage === 'heat' ? '预赛' : '决赛';
    b.entries.forEach((en) => {
      const row = b.board.rows.find(r => r.regId === en.regId) || {};
      rows.push([
        ev.name || '',
        groupName,
        stage,
        row.rank || '',
        en.bib || '',
        en.isRelay ? (en.teamName || '') : (en.name || ''),
        en.isRelay ? '' : (en.team || ''),
        en.isRelay && en.legs && en.legs.length ? en.legs.join('、') : '',
        resultCell(en, ev),
        row.points || 0,
        (noResultLabel(en) || (en.attempts > 0 ? '已录' : '未录')),
      ]);
    });
  });
  return {
    title: eventId && events[0] ? events[0].name : '成绩汇总表',
    meetInfo,
    note: '一行一条报名记录；名次与得分是实时算出来的（只统计已结束项目）',
    sheets: rows.length
      ? [{ name: '成绩汇总', head: HEAD, widths: WIDTHS, rows }]
      : [{ name: '成绩汇总', head: HEAD, widths: WIDTHS, rows: [['（还没有项目）', '', '', '', '', '', '', '', '', '', '']] }],
  };
}

/* ── CSV ──────────────────────────────────────────────────────────────── */

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(built) {
  const lines = [];
  lines.push(csvCell(built.meetInfo ? (built.meetInfo.name + '　' + built.title) : built.title));
  if (built.meetInfo && built.meetInfo.holdDate) lines.push(csvCell(built.meetInfo.holdDate));
  lines.push('');
  (built.sheets || []).forEach((sh, i) => {
    if (i > 0) lines.push('');
    lines.push(csvCell(sh.name));
    lines.push((sh.head || []).map(csvCell).join(','));
    (sh.rows || []).forEach(r => lines.push(r.map(csvCell).join(',')));
  });
  return lines.join('\r\n');
}

/* ── Excel（HTML 表格） ────────────────────────────────────────────────── */

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 这个值该不该当数字写进 Excel（成绩/得分要能排序求和，号码/时间要留文本） */
function asNumber(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  return null;
}
/** 判断某一列是不是"数字列"：看表头名 */
function numericColumn(head) {
  return /^(总分|得分|积分|分数|名次|序号|人数|报名人数|名次分)$/.test(String(head || '').trim())
    || /分$/.test(String(head || '').trim()) && !/得分明细/.test(String(head || ''));
}

/**
 * 生成 Excel 能打开的 HTML。
 *
 * 相比"能打开就行"，这里多做几件事（都是为了现场直接打印/统计）：
 *   · 冻结表头行：`mso-freeze-panes`，滚动时表头不跑
 *   · 打印设置：横向、A4、缩放到一页宽、重复标题行（`mso-print-titles`）
 *   · 号码/成绩列设成文本（`mso-number-format:"\@"`），
 *     否则 001 会变成 1、12.30 会变成 12.3、长号码会变科学计数法
 *   · 真正的数字列（名次/得分/总分）写成数字，Excel 里能直接排序求和
 *   · 行数多时自动加一行合计（只有数字列参与）
 */
function toExcelHtml(built, meet) {
  const info = built.meetInfo || {};
  const parts = [];
  parts.push('<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8">');
  parts.push('<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>');
  parts.push('<x:Name>' + esc(String(built.title || '导出').slice(0, 28)) + '</x:Name>');
  parts.push('<x:WorksheetOptions><x:Print><x:ValidPrinterInfo/><x:PaperSizeIndex>9</x:PaperSizeIndex>');
  parts.push('<x:Scale>100</x:Scale><x:HorizontalResolution>600</x:HorizontalResolution></x:Print>');
  parts.push('<x:Selected/><x:FreezePanes/><x:FrozenNoSplit/><x:SplitHorizontal>2</x:SplitHorizontal>');
  parts.push('<x:TopRowBottomPane>2</x:TopRowBottomPane><x:ActivePane>2</x:ActivePane>');
  parts.push('</x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->');
  parts.push('<style>');
  parts.push('body{font-family:"Microsoft YaHei","微软雅黑",sans-serif;font-size:11pt}');
  parts.push('table{border-collapse:collapse;margin-bottom:18pt}');
  parts.push('td,th{border:0.5pt solid #9aa4b2;padding:3pt 6pt;vertical-align:middle;'
    + 'mso-number-format:"\\@";white-space:nowrap}');   // 默认按文本，避免 001 变 1
  parts.push('th{background:#e8edf5;font-weight:bold;text-align:center}');
  parts.push('.t{font-weight:bold;font-size:15pt;text-align:center;background:#f4f7fb;border:none}');
  parts.push('.m{text-align:center;border:none;color:#5a6675;font-size:9.5pt}');
  parts.push('.s{font-weight:bold;background:#eef2f8;font-size:11.5pt}');
  parts.push('.num{text-align:right;mso-number-format:"0"}');      // 名次/得分：真数字
  parts.push('.dec{text-align:right;mso-number-format:"0\\.00"}');
  parts.push('.c{text-align:center}');
  parts.push('.sum{font-weight:bold;background:#fdf6e8}');
  parts.push('@page{size:A4 landscape;margin:10mm 8mm}');
  parts.push('</style></head><body>');

  /* 表头块：会名 + 表名 + 副信息（占 2 行，正好对上冻结的前两行） */
  const sheetCount = (built.sheets || []).length;
  const headCols = Math.max(2, ((built.sheets || [])[0] || {}).head
    ? built.sheets[0].head.length : 2);
  parts.push('<table>');
  parts.push('<tr><td class="t" colspan="' + headCols + '">' + esc(info.name || '运动会')
    + (built.title ? '　—　' + esc(built.title) : '') + '</td></tr>');
  const sub = [info.subtitle, info.host, info.holdDate].filter(Boolean).join('　·　');
  parts.push('<tr><td class="m" colspan="' + headCols + '">'
    + esc(sub + (sub ? '　·　' : '') + '导出时间：' + (info.exportedAt || nowIso())) + '</td></tr>');
  if (built.note) {
    parts.push('<tr><td class="m" colspan="' + headCols + '">' + esc(built.note) + '</td></tr>');
  }
  parts.push('</table>');

  (built.sheets || []).forEach((sh, si) => {
    const head = sh.head || [];
    const rows = sh.rows || [];
    parts.push('<table>');
    if (sh.widths && sh.widths.length) {
      // Excel 的 <col width> 单位约等于"字符数 × 7"，这里留一点余量，避免列太挤
      parts.push('<colgroup>' + sh.widths.map(w => '<col width="' + Math.round(w * 7.6) + '">').join('') + '</colgroup>');
    }
    // 小标题：只有一个表时用导出名，多个表时用小表名（避免"名单 / 名单"这种重复）
    const sub2 = (sheetCount === 1 && built.title) ? built.title : sh.name;
    parts.push('<tr><td class="s" colspan="' + Math.max(1, head.length) + '">' + esc(sub2) + '</td></tr>');
    parts.push('<tr>' + head.map(hd => '<th>' + esc(hd) + '</th>').join('') + '</tr>');

    const sumCols = head.map(h => numericColumn(h));
    const totals = head.map(() => 0);
    let anyNumber = false;
    const startRow = rows.length >= 6 ? 0 : rows.length;   // 行太少就不加合计，免得喧宾夺主

    rows.forEach((r, ri) => {
      parts.push('<tr>' + r.map((c, i) => {
        const n = asNumber(c);
        let cls = '';
        if (n !== null) {
          cls = 'num';
          if (startRow === 0 && sumCols[i]) { totals[i] += n; anyNumber = true; }
        } else if (i === 0 && /名次|序号/.test(String(head[0] || ''))) {
          cls = 'c';
        }
        void ri;
        return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(c) + '</td>';
      }).join('') + '</tr>');
    });

    if (anyNumber && rows.length >= 6) {
      parts.push('<tr>' + head.map((h, i) => {
        if (i === 0) return '<td class="sum">合计</td>';
        if (sumCols[i]) return '<td class="sum num">' + totals[i] + '</td>';
        return '<td class="sum"></td>';
      }).join('') + '</tr>');
    }

    parts.push('</table>');
    if (si === (built.sheets || []).length - 1) {
      parts.push('<p style="font-size:9pt;color:#666">本表由「运动会成绩实时统计与大屏展示系统」生成'
        + (meet && meet.name ? '　·　' + esc(meet.name) : '') + '</p>');
    }
  });

  parts.push('</body></html>');
  return parts.join('\n');
}

module.exports = { build, toCsv, toExcelHtml, gradeRank, classRank, zhCompare };
