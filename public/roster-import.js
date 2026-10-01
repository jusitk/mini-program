'use strict';
/**
 * tools/roster-import.js —— 名单导入的"兼容层"（解析 + 列名识别）
 *
 * 【为什么单独一个文件】
 *   现场拿到的名单五花八门：Excel 复制的、别人导出的 CSV、微信传的 txt、
 *   带 GBK 编码的中文 CSV、前面还有几行标题的表格……全塞在界面代码里会很难维护。
 *   这里只做纯粹的"文本 → 行对象数组"，界面只管显示结果。
 *
 * 【和后端的关系】
 *   列名识别的规则与 src/ops.js 的 HDR **保持一致**（同一套优先级与别名）。
 *   服务端也有自动识别兜底，所以即使前端认错了，导入也不会整份失败。
 *   本文件同时可在 Node 下 require（给自检脚本用），所以不依赖任何浏览器 API ——
 *   解码用的 TextDecoder 由调用方注入。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RosterImport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── 列名识别（与 src/ops.js 的 HDR 同规则） ─────────────────────────── */

  const HDR = {
    name: { p: 10, exact: ['姓名', '名字', '运动员', '运动员姓名', '学生', '学生姓名', 'name', '姓 名'], like: ['姓名', '名字', '运动员', '学生', 'name'] },
    bib: { p: 9, exact: ['号码', '号码布', '编号', '参赛号', '学号', '号', 'bib', 'no', 'number', '序号'], like: ['号码布', '参赛号', '号码', '编号', '学号', '序号'] },
    group: { p: 8, exact: ['组别', '组', '性别组', '大组', 'group'], like: ['组别', '性别组'] },
    className: { p: 8, exact: ['班级', '班', '所在班级', '行政班', 'class'], like: ['班级', '所在班', '行政班'] },
    grade: { p: 7, exact: ['年级', '级', '所在年级', 'grade'], like: ['年级'] },
    team: { p: 6, exact: ['单位', '队伍', '代表队', '班级单位', '参赛单位', 'team'], like: ['单位', '队伍', '代表队'] },
    gender: { p: 6, exact: ['性别', 'gender', 'sex'], like: ['性别'] },
    note: { p: 4, exact: ['备注', '说明', '注', 'note', 'remark'], like: ['备注', '说明'] },
  };

  const LABEL = {
    name: '姓名', bib: '号码', group: '组别', className: '班级',
    grade: '年级', team: '单位', gender: '性别', note: '备注',
  };

  /** 表头归一化：全角转半角、去空格与标点、去括号内容、转小写 */
  function normHeader(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/\u3000/g, ' ')
      .replace(/[（(【\[].*?[）)】\]]/g, '')
      .replace(/[\s*＊:：、,，.。"'`]/g, '')
      .toLowerCase();
  }

  /** 一行列名 → { 字段: 原列名 }，并给出每列被认成什么 */
  function mapHeaders(head) {
    const cols = (head || []).map((h) => ({ raw: String(h == null ? '' : h), norm: normHeader(h) }));
    const got = {}, labels = {}, byIndex = {};
    Object.keys(HDR).forEach((field) => {
      const spec = HDR[field];
      let hit = null;
      for (const c of cols) {
        if (!c.norm) continue;
        if (spec.exact.some((a) => normHeader(a) === c.norm)) { hit = c; break; }
      }
      if (!hit) {
        for (const c of cols) {
          if (!c.norm) continue;
          if (spec.like.some((a) => c.norm.indexOf(normHeader(a)) >= 0)) { hit = c; break; }
        }
      }
      if (hit) {
        got[field] = hit.raw;
        labels[field] = hit.raw;
        byIndex[hit.raw] = field;
      }
    });
    return { got, labels, byIndex, fields: Object.keys(got).length };
  }

  /** 按识别结果从一行里取值 */
  function pick(row, got, field) {
    const key = got[field];
    if (!key) return '';
    const v = row[key];
    return v === undefined || v === null ? '' : String(v).trim();
  }

  /* ── 表格文本解析 ────────────────────────────────────────────────────── */

  /** 猜分隔符：制表符 > 分号 > 逗号 > 竖线，取"出现次数最一致"的那个 */
  function guessDelim(text) {
    const sample = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 12);
    if (!sample.length) return '\t';
    const cand = ['\t', ';', ',', '|'];
    let best = '\t', bestScore = -1;
    cand.forEach((d) => {
      const counts = sample.map((l) => l.split(d).length - 1);
      const total = counts.reduce((a, b) => a + b, 0);
      if (total === 0) return;
      const max = Math.max.apply(null, counts);
      const consistent = counts.filter((c) => c === max).length / counts.length;
      const score = max * consistent;
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return best;
  }

  /** 按分隔符切一行，支持双引号包裹（Excel 导出常见） */
  function splitLine(line, delim) {
    if (delim === '\t' || delim === '|') {
      // 制表符/竖线不会有引号转义问题，直接切更稳
      return line.split(delim).map((s) => s.trim().replace(/^"|"$/g, ''));
    }
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; }
        } else { cur += ch; }
      } else if (ch === '"') { inQ = true; }
      else if (ch === delim) { out.push(cur); cur = ''; }
      else { cur += ch; }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  /**
   * 解析整块文本。
   * @returns {{head:string[], rows:Object[], map:Object, labels:Object, delim:string,
   *            headerLine:number, columns:Array, error?:string}}
   */
  function parseTable(text) {
    const raw = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) return { error: '没有内容。请把 Excel 里的名单（含表头）整块复制粘进来。' };

    const delim = guessDelim(raw);

    // 表头可能在前面几行（有人喜欢先写个标题）：在前 8 行里找"姓名列"最靠前的一行
    let headerIdx = -1, mapped = null, bestScore = -1;
    const scanTo = Math.min(lines.length, 8);
    for (let i = 0; i < scanTo; i++) {
      const cells = splitLine(lines[i], delim);
      const m = mapHeaders(cells);
      if (!m.got.name) continue;
      const score = m.fields * 10 - i;      // 认出的列越多越好；同样多则取靠前的
      if (score > bestScore) { bestScore = score; headerIdx = i; mapped = m; }
    }

    // 一行都没认出来：把第一行当表头，并给出"认不出"的提示（仍然尝试按位置兜底）
    if (headerIdx < 0) {
      const cells = splitLine(lines[0], delim);
      mapped = mapHeaders(cells);
      headerIdx = 0;
    }

    const head = splitLine(lines[headerIdx], delim);

    // 单列且没认出姓名 ⇒ 当成"只有一列姓名"的极简名单
    if (head.length === 1 && !mapped.got.name) {
      const rows = lines.map((l) => ({ 姓名: l.trim() })).filter((r) => r.姓名);
      const m2 = mapHeaders(['姓名']);
      return {
        head: ['姓名'], rows, map: m2.got, labels: m2.labels, byIndex: m2.byIndex,
        delim, headerLine: 0, columns: [], singleColumn: true,
      };
    }

    const bodyLines = lines.slice(headerIdx + 1);
    const rows = bodyLines.map((line) => {
      const cells = splitLine(line, delim);
      const obj = {};
      head.forEach((h, i) => { obj[h] = cells[i] === undefined ? '' : cells[i]; });
      return obj;
    }).filter((o) => Object.keys(o).some((k) => String(o[k]).trim() !== ''));

    const columns = head.map((h, i) => ({
      index: i,
      head: h,
      field: mapped.byIndex[h] || '',
      label: mapped.byIndex[h] ? LABEL[mapped.byIndex[h]] : '',
    }));

    const out = {
      head, rows, map: mapped.got, labels: mapped.labels, byIndex: mapped.byIndex,
      delim, headerLine: headerIdx, columns,
    };
    if (!mapped.got.name) {
      out.error = '没找到「姓名」列。请确认第一行是表头，并且其中一列叫「姓名」（'
        + '当前读到的列名：' + (head.slice(0, 8).join('、') || '（空）') + '）';
    } else if (!rows.length) {
      out.error = '表头认出来了，但下面没有数据行。';
    }
    return out;
  }

  /* ── 文件解码：自动分辨 UTF-8 / GBK ─────────────────────────────────── */

  /** UTF-8 严格解码，失败就抛（用来判断"这到底是不是 UTF-8"） */
  function strictUtf8(buf) {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  }

  /** 常见乱码特征：UTF-8 字节被当 GBK 读会出现这些字 */
  const MOJIBAKE = /[锟斤拷烫屯]\{0\}|[\uFFFD]|[\u00C0-\u00FF]{3,}/;

  /**
   * 把文件字节解成文本。
   * @param {ArrayBuffer|Uint8Array} buf
   * @returns {{text:string, encoding:string, warning?:string}}
   */
  function decodeFile(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);

    // ① BOM
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return { text: strictUtf8(bytes.subarray(3)), encoding: 'UTF-8（带 BOM）' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16LE' };
    }

    // ② 先试 UTF-8
    try {
      const t = strictUtf8(bytes);
      return { text: t, encoding: 'UTF-8' };
    } catch (e) { /* 不是 UTF-8，继续 */ }

    // ③ 退到 GBK（Excel 另存 CSV 在中文 Windows 上默认就是这个）
    try {
      const t = new TextDecoder('gbk').decode(bytes);
      return {
        text: t, encoding: 'GBK',
        warning: '这个文件不是 UTF-8 编码（多半是 Excel 直接另存的 CSV），已按 GBK 读取。'
          + '若中文仍有乱码，请在 Excel 里「另存为 → CSV UTF-8」再试，或直接复制粘贴。',
      };
    } catch (e) {
      const t = new TextDecoder('utf-8').decode(bytes);
      return {
        text: t, encoding: '未知（按 UTF-8 尽力读）',
        warning: '认不出这个文件的编码，已按 UTF-8 尽力读取。若有乱码，请改从 Excel 直接复制粘贴。',
      };
    }
  }

  /** 生成一份"可以直接粘贴/另存"的空表头示例 */
  function templateText() {
    return ['姓名', '组别', '年级', '班级', '号码', '性别', '单位', '备注'].join('\t') + '\n'
      + ['张三', '男子组', '高一', '1班', '101', '男', '高一(1)班', ''].join('\t') + '\n'
      + ['李四', '女子组', '高一', '2班', '102', '女', '高一(2)班', ''].join('\t');
  }

  return {
    HDR, LABEL, normHeader, mapHeaders, pick, guessDelim, splitLine, parseTable,
    decodeFile, templateText,
  };
});
