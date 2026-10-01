'use strict';
/**
 * tools/check-import-export.js —— 名单导入 与 导出 的自检
 *
 * 为什么单独一个自检：
 *   这两块最容易"看着能用、一到现场就出问题"，而且都属于纯逻辑，
 *   完全可以在命令行里用假数据跑一遍，不用开浏览器。
 *
 *   · 名单导入：各种表头写法、分隔符、全角空格、缺列、缺姓名
 *   · 导出：Excel 的冻结表头/打印设置/文本与数字格式/合计行、CSV 的 BOM 与转义
 */

const path = require('node:path');
const Xport = require('../src/xport');
const Ops = require('../src/ops');
const RI = require('../public/roster-import.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [通过] ' + name); }
  else { fail++; console.log('  [失败] ' + name + (extra ? ('  → ' + extra) : '')); }
}
const eq = (name, got, want) => ok(name, String(got) === String(want), '实际=' + JSON.stringify(got) + ' 期望=' + JSON.stringify(want));

/* ══ 一、列名识别 ══════════════════════════════════════════════════════ */

console.log('\n一、列名识别（各种写法都要认出来）');

const cases = [
  { head: ['姓名', '组别', '年级', '班级', '号码'], want: { name: '姓名', group: '组别', grade: '年级', className: '班级', bib: '号码' } },
  { head: ['运动员姓名', '性别', '所在班级', '参赛号'], want: { name: '运动员姓名', gender: '性别', className: '所在班级', bib: '参赛号' } },
  { head: ['姓 名*', '性别（男/女）', '班级', '号码布'], want: { name: '姓 名*', gender: '性别（男/女）', className: '班级', bib: '号码布' } },
  { head: ['姓名', '组别', '班级', '单位'], want: { name: '姓名', group: '组别', className: '班级', team: '单位' } },
];
cases.forEach((c, i) => {
  const m = RI.mapHeaders(c.head);
  const bad = Object.keys(c.want).filter(k => m.got[k] !== c.want[k]);
  ok('表头用例 ' + (i + 1) + '：' + c.head.join('|'), bad.length === 0,
    bad.map(k => k + ' 认成 ' + JSON.stringify(m.got[k])).join('；'));
});

// 前后端必须同一口径
const srv = Ops.mapHeaders(['运动员姓名', '性别', '所在班级', '参赛号']).got;
const cli = RI.mapHeaders(['运动员姓名', '性别', '所在班级', '参赛号']).got;
ok('前后端列名识别结果一致', JSON.stringify(srv) === JSON.stringify(cli), JSON.stringify(srv) + ' vs ' + JSON.stringify(cli));

/* ══ 二、表格解析（分隔符 / 表头定位 / 缺姓名） ═══════════════════════ */

console.log('\n二、表格解析');

let p = RI.parseTable('姓名\t组别\t号码\n张三\t男子组\t101\n李四\t男子组\t102');
eq('制表符分隔行数', p.rows.length, 2);
eq('制表符分隔列数', p.head.length, 3);
eq('取到姓名', RI.pick(p.rows[0], p.map, 'name'), '张三');

p = RI.parseTable('姓名,组别,号码\n张三,男子组,101\n李四,男子组,102');
eq('逗号分隔行数', p.rows.length, 2);
eq('逗号分隔取到号码', RI.pick(p.rows[0], p.map, 'bib'), '101');

p = RI.parseTable('姓名;组别;号码\n张三;男子组;101');
eq('分号分隔行数', p.rows.length, 1);

p = RI.parseTable('某某中学运动会报名表\n2026年9月\n姓名\t组别\t号码\n张三\t男子组\t101');
eq('表头不在第一行时也能找到', p.headerLine, 2);
eq('前面有标题时仍取到姓名', RI.pick(p.rows[0], p.map, 'name'), '张三');

p = RI.parseTable('"姓名","备注"\n"张三","含,逗号"\n"李四","含""引号"""');
eq('引号转义：逗号不被切开', RI.pick(p.rows[0], p.map, 'note'), '含,逗号');
eq('引号转义：双引号还原', RI.pick(p.rows[1], p.map, 'note'), '含"引号"');

p = RI.parseTable('张三\n李四\n王五');
eq('单列名单（没有表头）也能导入', p.rows.length, 3);
eq('单列名单取到姓名', RI.pick(p.rows[0], p.map, 'name'), '张三');

p = RI.parseTable('姓名\t号码\n\t101\n李四\t102');
ok('缺姓名的行会被标出来', p.rows.filter(r => !RI.pick(r, p.map, 'name')).length === 1);

p = RI.parseTable('');
ok('空文本给出明确提示', !!p.error);

/* ══ 三、导出：CSV ════════════════════════════════════════════════════ */

console.log('\n三、导出 CSV');

const fake = {
  title: '测试表',
  meetInfo: { name: '测试运动会', holdDate: '2026-09-25', exportedAt: '2026-09-25 10:00' },
  sheets: [{
    name: '名单',
    head: ['序号', '姓名', '备注'],
    widths: [6, 12, 20],
    rows: [[1, '张三', '含,逗号'], [2, '李四', '含"引号"']],
  }],
};
const csv = Xport.toCsv(fake);
ok('CSV 含会名与表名', csv.indexOf('测试运动会') >= 0 && csv.indexOf('测试表') >= 0);
ok('CSV 逗号被引号包起来', csv.indexOf('"含,逗号"') >= 0);
ok('CSV 引号被转义', csv.indexOf('"含""引号"""') >= 0);
ok('CSV 用 CRLF 换行（Excel 友好）', csv.indexOf('\r\n') >= 0);

/* ══ 四、导出：Excel ══════════════════════════════════════════════════ */

console.log('\n四、导出 Excel');

const big = {
  title: '班级总分榜',
  meetInfo: { name: '测试运动会', exportedAt: '2026-09-25 10:00' },
  sheets: [{
    name: '班级总分',
    head: ['名次', '班级', '总分'],
    widths: [8, 18, 10],
    rows: [[1, '高一(1)班', 37], [2, '高一(2)班, 有逗号', 24], [3, '高一(3)班', 12],
      [4, '高一(4)班', 9], [5, '高一(5)班', 6], [6, '高一(6)班', 3]],
  }],
};
const xls = Xport.toExcelHtml(big, { name: '测试运动会' });

ok('Excel 有冻结表头', xls.indexOf('FreezePanes') >= 0);
ok('Excel 有打印设置（横向 A4）', xls.indexOf('PaperSizeIndex') >= 0 && xls.indexOf('@page') >= 0);
ok('Excel 默认单元格是文本格式（001 不会变 1）', xls.indexOf('mso-number-format:"\\@"') >= 0);
ok('Excel 数字列用数字格式', xls.indexOf('class="num"') >= 0);
ok('Excel 行数够时加合计行', xls.indexOf('class="sum"') >= 0);
eq('Excel 合计算对了（37+24+12+9+6+3）', /class="sum num">(\d+)</.exec(xls)[1], 91);
ok('Excel 转义了 & < >', Xport.toExcelHtml({
  title: 'x', meetInfo: { name: '<b>&' }, sheets: [{ name: 's', head: ['a'], rows: [['<x>']] }],
}, null).indexOf('&lt;x&gt;') >= 0);

const one = Xport.toExcelHtml({
  title: '成绩总表', meetInfo: { name: '测试' },
  sheets: [{ name: '成绩总表', head: ['姓名'], rows: [['张三']] }],
}, null);
ok('单表时不重复显示"表名/表名"', one.indexOf('>成绩总表</td>') >= 0);

/* ══ 汇总 ═════════════════════════════════════════════════════════════ */

console.log('\n' + '═'.repeat(60));
console.log('结果：' + (fail ? ('有 ' + fail + ' 项失败') : '全部通过') + '（' + pass + ' 项通过）');
process.exit(fail ? 1 : 0);
