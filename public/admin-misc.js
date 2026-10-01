/* ============================================================================
 * admin-misc.js —— 其余页签：总览 / 班级总分 / 检录 / 公告 / 聊天室 /
 *                  设置 / 备份与导出 / 账号 / 操作记录 / 体检
 * ========================================================================== */
'use strict';

(function () {
  const A = window.Admin;
  const h = A.h, el = A.el, clear = A.clear;
  const App = window.App;

  /* ══════════════════════════════════════════════════════════════════════
   * 导入与设置页签（容器 id 是 paneSettings，页签 data-tab="settings"）
   * 内容：本届概览 + 名单导入 + 计分规则/大屏设置 + 快捷操作
   * ══════════════════════════════════════════════════════════════════════ */

  A.register('settings', function renderSettingsPane() {
    const S = A.S;
    const pane = el('paneSettings');
    if (!pane) return;
    clear(pane);
    const snap = S.snap;
    const st = snap.stats || {};
    const box = h('div', { class: 'box' });
    box.appendChild(h('div', { class: 'box-head' }, [
      h('div', { class: 'box-title', text: '本届概览' }),
      h('div', { class: 'box-note', text: '大屏地址：' + location.origin + '/screen（免登录，投到电视上就行）' }),
    ]));
    const body = h('div', { class: 'box-body' });
    body.appendChild(h('div', { class: 'stats' }, [
      card('运动员', st.athletes, '人'),
      card('项目', st.events, '个'),
      card('已录成绩', st.results, '条'),
      card('进行中', st.live, '个项目'),
      card('已结束', st.done, '个项目'),
      card('未开始', st.pending, '个项目'),
      card('待确认改动', S.staged.length, '项'),
    ]));
    box.appendChild(body);
    pane.appendChild(box);

    /* ── 导入名单：从 Excel 整块复制粘贴，或选 csv/tsv/txt 文件 ────────── */
    pane.appendChild(importRosterBox());

    /* ── 导出与备份 ───────────────────────────────────────────────────── */
    const box4 = h('div', { class: 'box' });
    box4.appendChild(h('div', { class: 'box-head' }, [
      h('div', { class: 'box-title', text: '导出与备份' }),
      h('div', { class: 'box-note', text: '导出的 Excel 已设好冻结表头、A4 横向打印；号码与成绩是文本格式，不会变成 1 或科学计数法' }),
    ]));
    const b4 = h('div', { class: 'box-body toolbar' });
    [
      ['成绩汇总表（一行一条，推荐）', '/api/export?what=results&format=xls'],
      ['成绩明细（按项目分表）', '/api/export?what=details&format=xls'],
      ['排名表（张贴用）', '/api/export?what=rank&format=xls'],
      ['班级总分榜', '/api/export?what=team&format=xls'],
      ['运动员名单', '/api/export?what=roster&format=xls'],
      ['秩序册', '/api/export?what=program&format=xls'],
      ['检录单', '/api/export?what=checkin&format=xls'],
    ].forEach(([text, url]) => b4.appendChild(h('button', {
      class: 'btn btn-sm', type: 'button', text,
      onclick: () => { location.href = url; },
    })));

    // CSV 与全量存档放一个下拉里：平时不用，但关键时候要能找到
    const more = h('select', { class: 'select', style: { width: 'auto', minWidth: '13rem' } });
    more.appendChild(h('option', { value: '', text: '更多导出（CSV / 全量存档）…' }));
    [
      ['成绩汇总表 CSV（手机也能打开）', '/api/export?what=results&format=csv'],
      ['排名表 CSV', '/api/export?what=rank&format=csv'],
      ['班级总分榜 CSV', '/api/export?what=team&format=csv'],
      ['运动员名单 CSV', '/api/export?what=roster&format=csv'],
      ['全量数据（含所有表，换机器/存档用）', '/api/export?what=all&format=csv'],
    ].forEach(([text, url]) => more.appendChild(h('option', { value: url, text })));
    more.addEventListener('change', () => {
      if (!more.value) return;
      location.href = more.value;
      more.value = '';
    });
    b4.appendChild(more);

    b4.appendChild(h('button', {
      class: 'btn btn-sm', type: 'button', text: '立即备份',
      onclick: () => {
        App.api('/api/backups', { method: 'POST', body: {} }).then((r) => {
          if (r.ok) { A.toast('已备份：' + r.data.data.name, 'ok'); A.loadBackups(); }
          else A.toast((r.data && r.data.message) || r.error || '备份失败', 'bad');
        });
      },
    }));
    b4.appendChild(h('button', {
      class: 'btn btn-sm', type: 'button', text: '打开大屏',
      onclick: () => window.open('/screen', '_blank'),
    }));
    box4.appendChild(b4);
    pane.appendChild(box4);

    // 同一个页签里再挂上"设置"（运动会信息 / 计分规则 / 大屏设置）
    renderSettingsInto(pane);
  });

  /* ══════════════════════════════════════════════════════════════════════
   * 名单导入面板
   *
   * 解析与列名识别全部交给 public/roster-import.js（解析是纯粹的文本处理，
   * 抽出去以后 Node 下也能测）。这里只负责界面：
   *   选文件（自动分辨 UTF-8 / GBK）→ 解析 → 显示"哪列认成了什么" →
   *   预览前几行 → 确认后暂存（不直接落库）
   * ══════════════════════════════════════════════════════════════════════ */

  /** 界面上的导入状态（切换页签时不丢，避免解析结果被清掉） */
  const IMP = { text: '', fileName: '', encoding: '', warning: '', parsed: null };

  function importRosterBox() {
    const RI = window.RosterImport;
    const box = h('div', { class: 'box' });
    box.appendChild(h('div', { class: 'box-head' }, [
      h('div', { class: 'box-title', text: '导入运动员名单' }),
      h('div', { class: 'box-note', text: '从 Excel 选中整块（含表头）复制粘贴即可；也可选 .csv / .tsv / .txt 文件（中文 CSV 的 GBK 编码也能读）' }),
    ]));
    const body = h('div', { class: 'box-body' });

    /* ── 认识的列名（提示用；与服务端同一份规则） ── */
    const colHint = h('div', { class: 'hint', text: '正在读取支持的列名…' });
    body.appendChild(h('div', { class: 'field' }, [
      h('span', { class: 'label', text: '认这些列名（第一行是表头；只有「姓名」是必须的）' }),
      colHint,
    ]));
    App.api('/api/import/columns').then((r) => {
      if (!r.ok || !r.data || !r.data.ok) return;
      const list = r.data.columns || [];
      clear(colHint);
      list.forEach((c, i) => {
        if (i) colHint.appendChild(document.createTextNode('　'));
        colHint.appendChild(h('b', { text: c.label + (c.required ? '（必填）' : '') }));
        colHint.appendChild(document.createTextNode('：' + c.accepts.slice(0, 4).join(' / ')));
      });
    });

    /* ── 粘贴框 ── */
    const ta = h('textarea', {
      class: 'textarea', id: 'importText', rows: '9',
      style: { minHeight: '180px', fontFamily: 'Consolas, monospace', fontSize: '13px' },
      placeholder: '姓名\t组别\t年级\t班级\t号码\n张三\t男子组\t高一\t1班\t101\n李四\t女子组\t高一\t2班\t102\n\n'
        + '（直接从 Excel 复制整块粘进来就行：制表符、逗号、分号分隔都能认；\n'
        + '  表头前面多几行标题也没关系，程序会自己找表头那一行）',
    });
    ta.value = IMP.text || '';
    ta.addEventListener('input', () => { IMP.text = ta.value; IMP.parsed = null; });

    /* ── 选文件：自动分辨编码 ── */
    const fileInput = h('input', {
      type: 'file',
      accept: '.csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values',
      style: { display: 'none' },
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (/\.xlsx?$/i.test(file.name)) {
        A.ask({
          title: '这个文件读不了（.xlsx 是压缩包）',
          text: '程序不引第三方库，读不了 .xlsx。两个办法：\n\n'
            + '① 打开这个 Excel，选中名单那一块（连表头）→ Ctrl+C → 粘到上面的框里（最省事）\n'
            + '② 在 Excel 里「另存为 → CSV UTF-8(逗号分隔)」，再选那个 .csv 文件\n\n'
            + '（临时把后缀改成 .zip 再解压也能拿到表格 XML，但没必要，太麻烦）',
          okText: '知道了',
        });
        fileInput.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const dec = RI.decodeFile(reader.result);
          ta.value = dec.text;
          IMP.text = dec.text;
          IMP.parsed = null;
          IMP.fileName = file.name;
          IMP.encoding = dec.encoding;
          IMP.warning = dec.warning || '';
          if (dec.warning) A.toast('已读入 ' + file.name + '：' + dec.warning, 'warn', 8000);
          else A.toast('已读入 ' + file.name + '（' + Math.round(file.size / 1024) + ' KB，编码 ' + dec.encoding + '）', 'ok');
          doParse(true);
        } catch (e) {
          A.toast('读文件出错：' + (e && e.message), 'bad', 6000);
        }
      };
      reader.readAsArrayBuffer(file);      // 拿字节自己判编码，不能用 readAsText('UTF-8')
    });

    body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'label', text: '粘贴数据' }), ta]));

    /* ── 解析结果区（列映射 + 前几行预览） ── */
    const out = h('div', { id: 'importOut', style: { marginTop: '10px' } });
    body.appendChild(out);

    /* ── 按钮条 ── */
    body.appendChild(h('div', { class: 'toolbar', style: { marginTop: '10px' } }, [
      h('button', { class: 'btn', type: 'button', text: '选择文件…', onclick: () => fileInput.click() }),
      fileInput,
      h('button', { class: 'btn btn-sm', type: 'button', text: '填一份示例表头', onclick: () => {
        ta.value = RI.templateText();
        IMP.text = ta.value;
        doParse(true);
      } }),
      h('button', { class: 'btn btn-sm', type: 'button', text: '清空', onclick: () => {
        ta.value = ''; IMP.text = ''; IMP.parsed = null; IMP.fileName = ''; IMP.encoding = ''; IMP.warning = '';
        clear(out);
      } }),
      h('span', { class: 'grow' }),
      h('button', {
        class: 'btn btn-primary', type: 'button', text: '导入（先暂存，确认后生效）',
        onclick: () => submitImport(ta, out),
      }),
    ]));

    box.appendChild(body);
    if (IMP.text) setTimeout(() => doParse(false), 30);   // 页签切回来时恢复上次结果
    return box;
  }

  /** 解析并画出"列映射 + 预览" */
  function doParse(announce) {
    const RI = window.RosterImport;
    const out = el('importOut');
    const ta = el('importText');
    if (!out || !ta || !RI) return;
    const parsed = RI.parseTable(ta.value);
    IMP.parsed = parsed;
    clear(out);

    if (parsed.error) {
      out.appendChild(h('div', { class: 'tip' }, [h('b', { text: '⚠ ' }), document.createTextNode(parsed.error)]));
      if (announce) A.toast(parsed.error, 'warn', 6000);
      return;
    }

    const delimName = { '\t': '制表符（Excel 复制）', ',': '逗号', ';': '分号', '|': '竖线' }[parsed.delim] || parsed.delim;

    /* 头部小结 */
    const summary = h('div', { class: 'tip' }, [
      h('div', {}, [
        document.createTextNode('读到 '),
        h('b', { text: String(parsed.rows.length) }),
        document.createTextNode(' 行数据，' + parsed.head.length + ' 列；分隔符：' + delimName
          + '；表头在第 ' + (parsed.headerLine + 1) + ' 行'),
        IMP.fileName ? document.createTextNode('；文件：' + IMP.fileName + (IMP.encoding ? '（' + IMP.encoding + '）' : '')) : null,
      ]),
      IMP.warning ? h('div', { style: { color: 'var(--amber)' } }, [document.createTextNode('⚠ ' + IMP.warning)]) : null,
    ]);
    out.appendChild(summary);

    /* 列映射表：每列认成了什么 */
    const mapTable = h('table', { class: 'grid' });
    mapTable.appendChild(h('thead', {}, [h('tr', {}, [
      h('th', { text: '文件里的列名' }),
      h('th', { text: '认作' }),
      h('th', { text: '样例值' }),
    ])]));
    const mtb = h('tbody');
    (parsed.columns || []).forEach((c) => {
      const sample = parsed.rows.slice(0, 2)
        .map(r => String(r[c.head] === undefined ? '' : r[c.head]).trim())
        .filter(Boolean).join('、');
      mtb.appendChild(h('tr', {}, [
        h('td', {}, [h('span', { text: c.head || '（空列名）' })]),
        h('td', {}, [
          c.label
            ? h('span', { class: 'pill pill-ok', text: c.label })
            : h('span', { class: 'pill pill-dim', text: '忽略' }),
        ]),
        h('td', { class: 'sub-cell', text: sample || '—' }),
      ]));
    });
    mapTable.appendChild(mtb);
    out.appendChild(mtTable);

    /* 前几行预览（按"认出来的字段"重排，让老师一眼看出对不对） */
    const FIELDS = ['name', 'bib', 'group', 'grade', 'className', 'gender', 'note'];
    const labels = RI.LABEL;
    const pv = h('table', { class: 'grid', style: { marginTop: '10px' } });
    pv.appendChild(h('thead', {}, [h('tr', {}, FIELDS.map(f =>
      h('th', { text: labels[f] + (f === 'name' ? '（必填）' : '') })))]));
    const ptb = h('tbody');
    parsed.rows.slice(0, 6).forEach((r) => {
      ptb.appendChild(h('tr', {}, FIELDS.map((f) => {
        const v = RI.pick(r, parsed.map, f);
        if (f === 'name' && !v) return h('td', {}, [h('span', { class: 'pill pill-danger', text: '缺姓名' })]);
        return h('td', { class: f === 'name' ? 'name-cell' : '', text: v || '—' });
      })));
    });
    pv.appendChild(ptb);
    out.appendChild(pv);
    if (parsed.rows.length > 6) {
      out.appendChild(h('div', { class: 'hint', text: '（只显示前 6 行，实际会导入全部 ' + parsed.rows.length + ' 行）' }));
    }

    /* 缺姓名的行单独提醒 */
    const noName = parsed.rows.filter(r => !RI.pick(r, parsed.map, 'name')).length;
    if (noName) {
      out.appendChild(h('div', { class: 'tip', style: { borderColor: 'var(--red-line)', background: 'var(--red-bg)' } }, [
        document.createTextNode('有 ' + noName + ' 行没有姓名，导入时会被跳过（其余行照常导入）。'),
      ]));
    }
  }

  /** 确认并提交导入（走暂存，不直接落库） */
  function submitImport(ta, out) {
    const RI = window.RosterImport;
    const parsed = IMP.parsed || (RI ? RI.parseTable(ta.value) : null);
    if (!parsed) { A.toast('请先粘贴或选择名单文件', 'warn'); return; }
    if (parsed.error) { A.toast(parsed.error, 'warn', 6000); return; }
    if (!parsed.rows.length) { A.toast('没有读到数据行', 'warn'); return; }

    const preview = parsed.rows.slice(0, 5).map(r => [
      RI.pick(r, parsed.map, 'name') || '（无姓名）',
      RI.pick(r, parsed.map, 'group'),
      RI.pick(r, parsed.map, 'grade'),
      RI.pick(r, parsed.map, 'className'),
      RI.pick(r, parsed.map, 'bib'),
    ].join(' / ')).join('\n');

    A.ask({
      title: '导入 ' + parsed.rows.length + ' 行名单',
      text: '前几行预览（姓名 / 组别 / 年级 / 班级 / 号码）：\n' + preview
        + '\n\n导入后是**暂存**状态，点顶部「确认修改并推送大屏」才正式生效。\n'
        + '同一个人（同组别 + 同名 + 同号码）会被更新，不会重复添加。',
      okText: '导入',
    }).then((r) => {
      if (!r.ok) return;
      // 把"列映射"一起送给服务端：前后端用同一份识别结果，不会出现两边认得不一致
      A.cmd('athlete.import', { rows: parsed.rows, map: parsed.map }).then((res) => {
        const d = (res && res.data) || {};
        if (d.errors && d.errors.length) {
          A.ask({ title: '导入完成，但有几行被跳过', text: d.errors.join('\n'), okText: '知道了' });
        }
        ta.value = ''; IMP.text = ''; IMP.parsed = null;
        clear(out);
        A.refresh();
      });
    });
  }

  function card(k, v, x) {
    return h('div', { class: 'stat' }, [
      h('div', { class: 'k', text: k }),
      h('div', { class: 'v', text: String(v === undefined || v === null ? '—' : v) }),
      x ? h('div', { class: 'x', text: x }) : null,
    ]);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 班级总分
   * ══════════════════════════════════════════════════════════════════════ */

  A.register('team', function renderTeam() {
    const S = A.S;
    const pane = el('paneTeam');
    if (!pane) return;
    const snap = S.snap;
    const meta = snap.teamMeta || {};
    const rule = (snap.meet && snap.meet.rule) || {};

    /* 【原地更新】骨架只建一次（标题条 + 下拉 + 表格 + 底部说明）。
       原来每次数据更新都 clear(pane) 重建 —— 表格几百行全部重造，
       下拉框正展开着也会被收起来。 */
    let box = pane.querySelector('[data-part="team"]');
    if (!box) {
      clear(pane);
      box = h('div', { class: 'box', 'data-part': 'team' });
      box.appendChild(h('div', { class: 'box-head' }, [
        h('div', { class: 'box-title', text: '班级总分榜' }),
        h('div', { class: 'box-note', 'data-part': 'meta' }),
        h('span', { style: { flex: '1 1 auto' } }),
        h('button', {
          class: 'btn btn-sm', type: 'button', text: '导出 Excel',
          onclick: () => { location.href = '/api/export?what=team&format=xls'; },
        }),
        h('button', {
          class: 'btn btn-sm', type: 'button', text: '只看这个年级',
          onclick: () => { location.href = '/api/export?what=team&format=xls&grade=' + encodeURIComponent(S.filters.team.grade || ''); },
        }),
      ]));

      const bar = h('div', { class: 'box-body toolbar' });
      const gsel = h('select', { class: 'select', 'data-part': 'gsel' });
      gsel.addEventListener('change', () => { S.filters.team.grade = gsel.value; A.render(); });
      bar.appendChild(gsel);
      bar.appendChild(h('span', { class: 'box-note', 'data-part': 'rule' }));
      box.appendChild(bar);

      const table = h('table', { class: 'grid' });
      table.appendChild(h('thead', {}, [h('tr', {}, [
        h('th', { text: '名次' }), h('th', { text: '班级' }), h('th', { text: '年级' }),
        h('th', { class: 'num', text: '总分' }), h('th', { class: 'num', text: '第一名' }),
        h('th', { class: 'num', text: '第二名' }), h('th', { class: 'num', text: '第三名' }),
        h('th', { text: '得分明细' }),
      ])]));
      table.appendChild(h('tbody'));
      const bb = h('div', { class: 'box-body' });
      bb.appendChild(h('div', { class: 'table-wrap' }, [table]));
      bb.appendChild(h('div', { class: 'box-note', 'data-part': 'foot', style: { marginTop: '8px' } }));
      box.appendChild(bb);
      pane.appendChild(box);
    }

    App.dom.setText(box.querySelector('[data-part="meta"]'),
      (meta.ruleText || '') + '　·　已计入 ' + (meta.scoredEvents || 0) + ' 个项目');

    const grades = Array.from(new Set((snap.team || []).map(t => t.grade).filter(Boolean)));
    const gsel = box.querySelector('[data-part="gsel"]');
    if (gsel) {
      // 下拉选项原地对齐（含"全部年级"这一项）
      App.dom.reconcile(gsel, [{ id: '', text: '全部年级' }].concat(grades.map(g => ({ id: g, text: g }))),
        it => it.id, (it, node) => {
          if (!node) node = h('option', {});
          node.value = it.id;
          App.dom.setText(node, it.text);
          return node;
        });
      if (gsel.value !== S.filters.team.grade) gsel.value = S.filters.team.grade;
    }
    App.dom.setText(box.querySelector('[data-part="rule"]'),
      '计分表：' + ((rule.table || []).join(' / ') || '7 / 5 / 4 / 3 / 2 / 1') + '（第 1 名到第 6 名）');

    const gradeFilter = S.filters.team.grade;
    let list = (snap.team || []).slice();
    if (gradeFilter) list = list.filter(t => t.grade === gradeFilter);

    const tb = box.querySelector('tbody');
    /* 名次口径：
       · 不筛年级 → 全校总名次（t.rank），这样一眼能看出全校谁领先
       · 筛了某个年级 → **本年级名次**（t.classRank），否则那一列会是 4、5、6 这种跳号
       （大屏是按年级分页的，所以它一直用 classRank） */
    const rows = list.map(t => ({ t: t, r: gradeFilter ? (t.classRank || t.rank) : t.rank }));
    if (!rows.length) rows.push({ empty: true, key: '__empty' });
    App.dom.reconcile(tb, rows, it => (it.empty ? '__empty' : 'c:' + (it.t.key || it.t.name)),
      (it, node) => {
        if (it.empty) {
          if (!node) node = h('tr', {}, [h('td', { colspan: '8' }, [h('div', { class: 'empty' })])]);
          App.dom.setText(node.querySelector('.empty'), '还没有已结束的项目，暂时没有分数');
          return node;
        }
        const t = it.t, r = it.r;
        if (!node) {
          node = h('tr', {}, [
            h('td', { class: 'rank' }), h('td', {}), h('td', {}),
            h('td', { class: 'num' }), h('td', { class: 'num' }),
            h('td', { class: 'num' }), h('td', { class: 'num' }),
            h('td', {}, [h('span', { class: 'box-note' })]),
          ]);
        }
        App.dom.setClass(node, r <= 3 ? 'top' + r : '');
        const td = node.children;
        App.dom.setText(td[0], String(r));
        App.dom.setText(td[1], t.name);
        App.dom.setText(td[2], t.grade || '');
        App.dom.setText(td[3], String(t.points));
        App.dom.setText(td[4], String(t.gold || 0));
        App.dom.setText(td[5], String(t.silver || 0));
        App.dom.setText(td[6], String(t.bronze || 0));
        App.dom.setText(td[7].querySelector('.box-note'),
          (t.details || []).map(d => d.eventName + ' 第' + d.rank + '名(' + d.points + ')').join('；'));
        return node;
      });

    /* 说明行跟着计分规则走，别写死倍数 —— 规则改了这里不改就成了骗人的。
       snap.meet.rule 是服务端合并好的规则（含 relayMultiplier）。 */
    const ruleNow = (snap.meet && snap.meet.rule) || {};
    const relayMultNow = Number(ruleNow.relayMultiplier) > 0 ? Number(ruleNow.relayMultiplier) : 2;
    App.dom.setText(box.querySelector('[data-part="foot"]'),
      '只统计**已结束**项目的名次分；接力按班级成队，分数记到班级'
      + (relayMultNow !== 1 ? ('，**接力得分 ×' + relayMultNow + '**') : '（与单项相同）')
      + '；并列名次各得该名次的全额分（1,2,2,4 → 7,5,5,3）。'
      + (gradeFilter ? '　当前显示的是「' + gradeFilter + '」**年级内**的排名。' : '　名次为全校总排名；选一个年级可看该年级内的排名。'));
  });

  /* ══════════════════════════════════════════════════════════════════════
   * 公告
   * ══════════════════════════════════════════════════════════════════════ */

  /* 公告条目是**复用**的，所以按钮回调不能把那条公告闭包进去
     （复用后会操作到旧的那条）。把"当前数据"挂在节点上，回调时现取。 */
  const noticeData = new WeakMap();
  const curNoticeOf = (node) => noticeData.get(node) || null;

  A.register('notice', function renderNotice() {
    const S = A.S;
    const pane = el('paneNotice');
    if (!pane) return;
    const snap = S.snap;

    /* 【原地更新】发布区（含那个 textarea）只建一次。
       原来每次数据更新都重建 —— 正在打的公告文字会被清掉，焦点也没了。 */
    let box = pane.querySelector('[data-part="pub"]');
    let text = null;
    if (!box) {
      clear(pane);
      box = h('div', { class: 'box', 'data-part': 'pub' });
      box.appendChild(h('div', { class: 'box-head' }, [
        h('div', { class: 'box-title', text: '发布公告' }),
        h('div', { class: 'box-note', text: '普通公告在大屏公告栏轮播；标「重要」的会变成顶部大字滚动条，到时间自动回落' }),
      ]));
      const body = h('div', { class: 'box-body' });

      // 加 input-editable：一是让它跟别的"改完就提交"的输入框一样有醒目的底纹，
      // 二是让"正在打字就先别重画"的判断认得它（普通 textarea 也会被 FIELD_SEL 认出来，
      // 这只是再加一道保险）。
      text = h('textarea', { class: 'textarea input-editable', placeholder: '例如：请参加女子 4×100 米接力决赛的各班代表队，提前 15 分钟到检录处集合', maxlength: '500' });
      const level = h('select', { class: 'select', style: { width: 'min(160px, 100%)' } }, [
        h('option', { value: 'normal', text: '普通（轮播）' }),
        h('option', { value: 'important', text: '重要（大字滚动）' }),
      ]);
      const mins = h('input', { class: 'input', type: 'number', min: '1', max: '120', value: '10', style: { width: 'min(90px, 100%)' } });
      const pinned = h('input', { type: 'checkbox' });

      body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'label', text: '公告内容' }), text]));
      body.appendChild(h('div', { class: 'toolbar', style: { marginTop: '10px' } }, [
        h('label', { class: 'field' }, [h('span', { class: 'label', text: '级别' }), level]),
        h('label', { class: 'field' }, [h('span', { class: 'label', text: '重要公告滚动时长（分钟）' }), mins]),
        h('label', { class: 'chk' }, [pinned, h('span', { text: '置顶' })]),
        h('span', { style: { flex: '1 1 auto' } }),
        h('button', {
          class: 'btn btn-primary', type: 'button', text: '发布（暂存）',
          onclick: () => {
            if (!text.value.trim()) { A.toast('公告内容不能为空', 'warn'); return; }
            A.cmd('notice.add', {
              text: text.value.trim(), level: level.value,
              pinned: pinned.checked, durationMin: Number(mins.value) || 10,
            }).then(() => { text.value = ''; A.refresh(); });
          },
        }),
      ]));
      box.appendChild(body);
      pane.appendChild(box);
    } else {
      text = box.querySelector('textarea');
    }
    void text;

    // 已有公告列表：整块只建一次，条目按 id 对齐
    let box2 = pane.querySelector('[data-part="list"]');
    let b2 = null;
    if (!box2) {
      box2 = h('div', { class: 'box', 'data-part': 'list' });
      box2.appendChild(h('div', { class: 'box-head' }, [
        h('div', { class: 'box-title', 'data-part': 'cnt' }),
        h('div', { class: 'box-note', text: '标「自动」的是检录时系统自己写的' }),
      ]));
      b2 = h('div', { class: 'box-body', id: 'noticeList' });
      box2.appendChild(b2);
      pane.appendChild(box2);
    } else {
      b2 = box2.querySelector('#noticeList');
    }

    const notices = snap.notices || [];
    App.dom.setText(box2.querySelector('[data-part="cnt"]'), '已有公告（' + notices.length + ' 条）');

    const items = notices.length ? notices : [{ __empty: true }];
    App.dom.reconcile(b2, items, n => (n.__empty ? '__empty' : 'n:' + n.id), (n, node) => {
      if (n.__empty) {
        if (!node) node = h('div', { class: 'empty' });
        App.dom.setText(node, '还没有公告');
        return node;
      }
      if (!node) {
        node = h('div', { class: 'ev-row' }, [
          h('div', { class: 'grow' }, [
            h('div', { class: 'name' }),
            h('div', { class: 'meta' }, [
              h('span', { class: 'pill' }),        // 普通/重要
              h('span', { class: 'pill pill-ok', 'data-cell': 'pin', text: '置顶' }),
              h('span', { class: 'pill pill-auto', 'data-cell': 'auto', text: '检录自动生成' }),
              h('span', { class: 'box-note', 'data-cell': 'at' }),
              h('span', { class: 'box-note', 'data-cell': 'until' }),
            ]),
          ]),
          h('div', { class: 'acts' }, [
            h('button', { class: 'btn btn-sm', type: 'button', 'data-act': 'level' }),
            h('button', { class: 'btn btn-sm', type: 'button', 'data-act': 'pin' }),
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: '删除', 'data-act': 'del' }),
          ]),
        ]);
        // 事件委托：条目是复用的，不能把 n 闭包进去（否则会操作到旧公告）
        node.querySelector('[data-act="level"]').addEventListener('click', () => {
          const cur = curNoticeOf(node);
          if (cur) A.cmd('notice.update', { id: cur.id, level: cur.level === 'important' ? 'normal' : 'important' }).then(() => A.refresh());
        });
        node.querySelector('[data-act="pin"]').addEventListener('click', () => {
          const cur = curNoticeOf(node);
          if (cur) A.cmd('notice.update', { id: cur.id, pinned: !cur.pinned }).then(() => A.refresh());
        });
        node.querySelector('[data-act="del"]').addEventListener('click', () => {
          const cur = curNoticeOf(node);
          if (!cur) return;
          A.ask({ title: '删除公告', text: '删除这条公告？', okText: '删除', danger: true })
            .then((r) => { if (r.ok) A.cmd('notice.del', { id: cur.id }).then(() => A.refresh()); });
        });
      }
      noticeData.set(node, n);
      App.dom.setText(node.querySelector('.name'), n.text);
      const pill0 = node.querySelector('.meta .pill');
      App.dom.setClass(pill0, 'pill ' + (n.level === 'important' ? 'pill-danger' : 'pill-dim'));
      App.dom.setText(pill0, n.level === 'important' ? '重要' : '普通');
      const pin = node.querySelector('[data-cell="pin"]');
      pin.hidden = !n.pinned;
      const auto = node.querySelector('[data-cell="auto"]');
      auto.hidden = !n.auto;
      App.dom.setText(node.querySelector('[data-cell="at"]'), App.fmtTime(n.createdAt, true));
      const until = node.querySelector('[data-cell="until"]');
      App.dom.setText(until, n.until ? ('大字滚动到 ' + App.fmtTime(n.until, true)) : '');
      until.hidden = !n.until;
      App.dom.setText(node.querySelector('[data-act="level"]'), n.level === 'important' ? '改成普通' : '改成重要');
      App.dom.setText(node.querySelector('[data-act="pin"]'), n.pinned ? '取消置顶' : '置顶');
      return node;
    });
  });

  /* ══════════════════════════════════════════════════════════════════════
   * 聊天室
   * ══════════════════════════════════════════════════════════════════════ */

  A.register('chat', function renderChat() {
    const S = A.S;
    const pane = el('paneChat');
    if (!pane) return;

    /* 【原地更新】聊天框、按钮、消息列表都只建一次。
       原来每次数据更新都 clear(pane) —— **正在打的那句话会被清掉**，
       光标也没了（发消息前先被自己的重画吃掉，现场很难受）。 */
    let box = pane.querySelector('[data-part="chat"]');
    let list = null;
    if (!box) {
      clear(pane);
      box = h('div', { class: 'box', 'data-part': 'chat' });
      box.appendChild(h('div', { class: 'box-head' }, [
        h('div', { class: 'box-title', text: '现场聊天室' }),
        h('div', { class: 'box-note', text: '用来在现场喊话（"800 米开始检录""跳远还差一人"）。内容不进大屏；可以发图片，不支持语音。' }),
      ]));

      const wrap = h('div', { class: 'chat' });
      list = h('div', { class: 'chat-list', id: 'chatList' });
      wrap.appendChild(list);

      const input = h('textarea', { class: 'textarea input-editable', placeholder: '说点什么…（回车发送，Shift+回车换行）' });
      const send = () => {
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        App.op('chat.send', { text, clientUuid: App.reqId() }).then((r) => {
          if (!r.ok) A.toast(r.error || '发送失败', 'bad');
          else A.loadChat();
        });
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      });

      /* 【只收图片，不做语音】
         原来这里有个「按住说话」按钮用 MediaRecorder 录音。去掉了，原因：
         浏览器要求 getUserMedia() 跑在**安全上下文**里，而现场是
         `http://192.168.x.x` 这种普通局域网地址 —— 手机上根本拿不到麦克风
         （localhost 是例外，所以服务器本机能录、手机不能，最容易误判成"能用"）。
         与其放一个现场按下去只会弹错的按钮，不如不做。
         要用语音得先给局域网配 HTTPS 证书，那是另一件事了。 */
      const fileInput = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
      fileInput.addEventListener('change', () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        uploadAndSend(f, '');
        fileInput.value = '';
      });

      wrap.appendChild(h('div', { class: 'chat-input' }, [
        input, fileInput,
        h('button', { class: 'btn btn-sm', type: 'button', text: '发图片', onclick: () => fileInput.click() }),
        h('button', { class: 'btn btn-primary', type: 'button', text: '发送', onclick: send }),
      ]));
      box.appendChild(wrap);
      pane.appendChild(box);
    } else {
      list = box.querySelector('#chatList');
    }

    // 消息列表按 id 对齐（新消息追加、撤回就地改文字，不重建整列）
    const msgs = S.chat || [];
    const items = msgs.length ? msgs : [{ __empty: true, id: '__empty' }];
    App.dom.reconcile(list, items, m => (m.__empty ? '__empty' : 'm:' + m.id), (m, node) => {
      if (m.__empty) {
        if (!node) node = h('div', { class: 'empty' });
        App.dom.setText(node, '还没有人说话。用这个页面在现场喊话（内容不进大屏）。');
        return node;
      }
      /* 消息内容可能变（撤回），所以已有的节点也要重建内容 ——
         但**只重建这一条**，别的消息节点不动。
         代价很小：一条消息就几个节点。 */
      const fresh = chatItem(m);
      if (node) { node.innerHTML = ''; while (fresh.firstChild) node.appendChild(fresh.firstChild); return node; }
      return fresh;
    });

    // 有新消息时滚到底（只在"本来就在底部附近"时才滚，免得上翻看历史被拽回来）
    if (list) {
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      if (nearBottom) setTimeout(() => { list.scrollTop = list.scrollHeight; }, 40);
    }
  });

  function chatItem(m) {
    const initial = String(m.userName || '?').slice(0, 1);
    const main = h('div', { class: 'chat-main' });
    main.appendChild(h('div', { class: 'chat-meta' }, [
      h('span', { class: 'nm', text: m.userName || '（已删除账号）' }),
      h('span', { text: m.role === 'admin' ? '管理员' : m.role === 'operator' ? '操作员' : '只读' }),
      h('span', { text: App.fmtTime(m.createdAt, true) }),
      h('span', { style: { flex: '1 1 auto' } }),
      !m.deleted ? h('button', {
        class: 'btn btn-sm btn-ghost', type: 'button', text: '撤回',
        onclick: () => App.op('chat.delete', { id: m.id }).then(() => A.loadChat()),
      }) : null,
    ]));
    if (m.deleted) {
      main.appendChild(h('div', { class: 'chat-text is-deleted', text: '（这条消息已撤回）' }));
    } else {
      if (m.text) main.appendChild(h('div', { class: 'chat-text', text: m.text }));
      if (m.attachId) {
        const url = '/uploads/' + m.attachId;
        const box = h('div', { class: 'chat-attach' });
        /* 附件只可能是图片（语音功能已去掉，见 renderChat 里的注释）。
           老数据里万一有 audio 类型，也不给它渲染播放器 ——
           服务端上传白名单现在只收图片，不会再产生音频。 */
        box.appendChild(h('img', { src: url, alt: '图片', loading: 'lazy' }));
        main.appendChild(box);
      }
    }
    return h('div', { class: 'chat-item' }, [h('div', { class: 'chat-avatar', text: initial }), main]);
  }

  function uploadAndSend(file, caption) {
    const maxMB = 12;
    if (file.size > maxMB * 1024 * 1024) {
      A.toast('文件太大了（上限 ' + maxMB + ' MB）', 'warn');
      return;
    }
    A.toast('正在上传 ' + file.name + '（' + Math.round(file.size / 1024) + ' KB）…', 'ok', 1800);
    // 只发图片（语音已去掉，见 renderChat 的注释）；服务端也只收图片
    const kind = /^image\//.test(file.type) ? 'image' : 'file';
    fetch('/api/upload?kind=' + kind + '&name=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-CSRF': App.getCsrf() },
      credentials: 'same-origin',
      body: file,
    }).then(r => r.json()).then((res) => {
      if (!res.ok) { A.toast(res.message || '上传失败', 'bad'); return; }
      return App.op('chat.send', {
        text: caption || '', kind: res.data.kind, attachId: res.data.id, clientUuid: App.reqId(),
      }).then(() => A.loadChat());
    }).catch(() => A.toast('上传失败，检查网络', 'bad'));
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 设置
   * ══════════════════════════════════════════════════════════════════════ */

  /**
   * "设置"三块（运动会信息 / 计分规则 / 大屏设置）的实际渲染。
   * 挂载位置：现在由「导入与设置」页签（renderImport 末尾）直接调用，
   * 不再单独占一个页签 —— 页签太多反而不好找。
   */
  function renderSettingsInto(pane) {
    const S = A.S;
    const meet = S.snap.meet || {};
    const rule = meet.rule || {};
    const screen = meet.screen || {};

    /* 运动会信息 */
    const box = h('div', { class: 'box' });
    box.appendChild(h('div', { class: 'box-head' }, [h('div', { class: 'box-title', text: '运动会信息（大屏抬头）' })]));
    const body = h('div', { class: 'box-body' });
    const grid = h('div', { class: 'form-grid' });
    const fName = editable('meet', meet.id || 'meet', 'name', meet.name, '运动会名称', (v) => A.cmd('meet.update', { name: v }));
    const fSub = editable('meet', meet.id || 'meet', 'subtitle', meet.subtitle, '副标题（如：实时成绩发布）', (v) => A.cmd('meet.update', { subtitle: v }));
    const fHost = editable('meet', meet.id || 'meet', 'host', meet.host, '主办单位（如：校体育运动委员会）', (v) => A.cmd('meet.update', { host: v }));
    const fDate = editable('meet', meet.id || 'meet', 'holdDate', meet.holdDate, '举办日期（如：2026 年 9 月 24 日 — 25 日）', (v) => A.cmd('meet.update', { holdDate: v }));
    [['运动会名称', fName], ['副标题', fSub], ['主办单位', fHost], ['举办日期', fDate]].forEach(([label, input]) => {
      grid.appendChild(h('label', { class: 'field' }, [h('span', { class: 'label', text: label }), input]));
    });
    body.appendChild(grid);
    box.appendChild(body);
    pane.appendChild(box);

    /* 计分规则 */
    const box2 = h('div', { class: 'box' });
    box2.appendChild(h('div', { class: 'box-head' }, [
      h('div', { class: 'box-title', text: '计分规则（班级总分榜）' }),
      h('div', { class: 'box-note', text: '默认取前六名，分数 7 / 5 / 4 / 3 / 2 / 1（第 2 名是 5 分，不是连续递减）' }),
    ]));
    const b2 = h('div', { class: 'box-body' });
    const tableInput = h('input', { class: 'input', value: (rule.table || [7, 5, 4, 3, 2, 1]).join(','), placeholder: '7,5,4,3,2,1' });
    const advInput = h('input', { class: 'input', type: 'number', min: '1', max: '20', value: String(rule.advanceCount || 6), style: { width: 'min(90px, 100%)' } });
    const onlyFin = h('input', { type: 'checkbox' });
    onlyFin.checked = rule.onlyFinished !== false;
    const relayScored = h('input', { type: 'checkbox' });
    relayScored.checked = rule.relayScored !== false;
    /* 【接力翻倍】接力是一个班 4 个人一起挣的分，报名的门槛和参与人数都比
       单项高（一个项目只算一条成绩，却要出动 4 名队员），所以名次分按倍数给。
       默认 2 = 翻倍。用下拉而不是输入框：现场只需要"翻不翻倍"，少一个能填错的地方。 */
    const relayMult = h('select', { class: 'select', style: { width: 'min(220px, 100%)' } }, [
      h('option', { value: '2', text: '接力分翻倍（第 1 名 7×2 = 14 分）' }),
      h('option', { value: '1', text: '接力和单项一样（不翻倍）' }),
      h('option', { value: '3', text: '接力分 ×3（第 1 名 21 分）' }),
    ]);
    relayMult.value = String(Number(rule.relayMultiplier) > 0 ? Number(rule.relayMultiplier) : 2);
    /* 内联宽度写成 min(…, 100%)：宽屏照旧，窄屏跟着容器缩。
       写死 220px 在 392px 的手机上会顶破所在格子（实测超出 47px）。 */
    const tieSel = h('select', { class: 'select', style: { width: 'min(220px, 100%)' } }, [
      h('option', { value: 'full', text: '并列各得该名次全额分（7,5,5,3）' }),
      h('option', { value: 'avg', text: '并列取所占名次的平均分（7,6,6,4）' }),
    ]);
    tieSel.value = rule.tie || 'full';

    b2.appendChild(h('div', { class: 'form-grid' }, [
      h('label', { class: 'field' }, [
        h('span', { class: 'label', text: '名次分表（按第 1 名到最后一名，逗号分隔）' }), tableInput,
        h('span', { class: 'hint', text: '改完点到别处就暂存' }),
      ]),
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '预赛录取人数（默认）' }), advInput]),
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '并列怎么给分' }), tieSel]),
      h('label', { class: 'field' }, [
        h('span', { class: 'label', text: '接力怎么给分' }), relayMult,
        h('span', { class: 'hint', text: '接力按班级成队，一条成绩算一个班的分' }),
      ]),
      h('label', { class: 'field' }, [
        h('span', { class: 'label', text: '其它' }),
        h('label', { class: 'chk' }, [onlyFin, h('span', { text: '只统计已结束的项目' })]),
        h('label', { class: 'chk' }, [relayScored, h('span', { text: '接力也计分' })]),
      ]),
    ]));

    function saveRule() {
      const table = tableInput.value.split(/[,，\s]+/).map(x => Number(x)).filter(x => Number.isFinite(x));
      if (!table.length) { A.toast('名次分表不能为空', 'warn'); return; }
      A.setLocal('meet', meet.id || 'meet', 'rule', table.join(','));
      A.cmd('meet.rule', {
        rule: {
          table, tie: tieSel.value,
          advanceCount: Number(advInput.value) || 6,
          onlyFinished: onlyFin.checked,
          relayScored: relayScored.checked,
          /* 一定要提交它：meet.rule 是"部分合并"，不提交就等于不改。
             不提交的后果是"界面上选了翻倍、其实没生效"，而且不报错。 */
          relayMultiplier: Number(relayMult.value) || 2,
        },
      }).then(() => A.refresh());
    }
    tableInput.classList.add('input-editable');
    tableInput.addEventListener('change', saveRule);
    tableInput.addEventListener('blur', saveRule);
    advInput.classList.add('input-editable');
    advInput.addEventListener('change', saveRule);
    tieSel.addEventListener('change', saveRule);
    onlyFin.addEventListener('change', saveRule);
    relayScored.addEventListener('change', saveRule);
    relayMult.addEventListener('change', saveRule);
    box2.appendChild(b2);
    pane.appendChild(box2);

    /* 大屏设置 */
    const box3 = h('div', { class: 'box' });
    box3.appendChild(h('div', { class: 'box-head' }, [
      h('div', { class: 'box-title', text: '大屏设置' }),
      h('div', { class: 'box-note', text: '大屏上也能自己切显示模式（标准 / 户外大 / 户外特大）' }),
    ]));
    const b3 = h('div', { class: 'box-body' });
    const showCk = h('input', { type: 'checkbox' });
    showCk.checked = screen.showCheckin !== false;
    const modeSel = h('select', { class: 'select', style: { width: 'min(180px, 100%)' } }, [
      h('option', { value: 'standard', text: '标准（室内屏幕）' }),
      h('option', { value: 'large', text: '户外大（推荐）' }),
      h('option', { value: 'huge', text: '户外特大（强光下）' }),
    ]);
    modeSel.value = screen.mode || 'large';
    const maxCol = h('input', { class: 'input', type: 'number', min: '1', max: '4', value: String(screen.maxColumns || 4), style: { width: 'min(90px, 100%)' } });

    function saveScreen() {
      A.cmd('meet.screen', {
        screen: {
          showCheckin: showCk.checked, mode: modeSel.value,
          maxColumns: Number(maxCol.value) || 4,
        },
      }).then(() => A.refresh());
    }
    showCk.addEventListener('change', saveScreen);
    modeSel.addEventListener('change', saveScreen);
    maxCol.classList.add('input-editable');
    maxCol.addEventListener('change', saveScreen);

    b3.appendChild(h('div', { class: 'form-grid' }, [
      h('label', { class: 'field' }, [
        h('span', { class: 'label', text: '默认显示模式' }), modeSel,
      ]),
      h('label', { class: 'field' }, [
        h('span', { class: 'label', text: '最多并排几栏' }), maxCol,
        h('span', { class: 'hint', text: '超宽屏可以放到 4；屏幕小就设 2，避免每栏太窄' }),
      ]),
      h('label', { class: 'field' }, [
        h('span', { class: 'label', text: '栏目开关' }),
        h('label', { class: 'chk' }, [showCk, h('span', { text: '显示检录栏（大屏默认三栏：成绩 / 公告 / 班级总分榜）' })]),
      ]),
    ]));
    box3.appendChild(b3);
    pane.appendChild(box3);
  }

  /** 「改完离开就暂存」的输入框（设置页用） */
  function editable(kind, id, field, value, placeholder, commit) {
    const input = h('input', { class: 'input input-editable', type: 'text', placeholder: placeholder || '' });
    const v = A.val(kind, id, field, value === null || value === undefined ? '' : value);
    input.value = v === null || v === undefined ? '' : String(v);
    let last = input.value;
    const fire = () => {
      if (input.value === last) return;
      last = input.value;
      A.setLocal(kind, id, field, input.value);
      commit(input.value);
    };
    input.addEventListener('change', fire);
    input.addEventListener('blur', fire);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    return input;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 备份与导出
   * ══════════════════════════════════════════════════════════════════════ */

  A.register('backup', function renderBackup() {
    const S = A.S;
    const pane = el('paneBackup');
    clear(pane);
    const info = S.backups || {};

    const box = h('div', { class: 'box' });
    box.appendChild(h('div', { class: 'box-head' }, [
      h('div', { class: 'box-title', text: '备份' }),
      h('div', { class: 'box-note', text: '每 ' + (info.everyMin || 30) + ' 分钟自动备份一次（有改动才备），只保留最近 ' + (info.keep || 30) + ' 份；服务启动时与恢复前也会各备一份' }),
    ]));
    const body = h('div', { class: 'box-body' });
    body.appendChild(h('div', { class: 'toolbar' }, [
      h('button', {
        class: 'btn btn-primary', type: 'button', text: '立即备份',
        onclick: () => App.api('/api/backups', { method: 'POST', body: {} }).then((r) => {
          if (r.ok) { A.toast('已备份：' + r.data.data.name, 'ok'); A.loadBackups(); }
          else A.toast((r.data && r.data.message) || r.error || '备份失败', 'bad');
        }),
      }),
      h('button', {
        class: 'btn', type: 'button', text: '导出全量数据（JSON，给换机器用）',
        onclick: () => { location.href = '/api/export?what=all&format=csv'; },
      }),
      h('button', {
        class: 'btn', type: 'button', text: '刷新列表',
        onclick: () => A.loadBackups(),
      }),
    ]));
    body.appendChild(h('div', { class: 'box-note', style: { marginTop: '8px' }, text: '备份目录：' + (info.dir || '') + '（整个 data 目录复制走就是完整备份）' }));
    box.appendChild(body);
    pane.appendChild(box);

    const box2 = h('div', { class: 'box' });
    box2.appendChild(h('div', { class: 'box-head' }, [
      h('div', { class: 'box-title', text: '备份文件（' + ((info.backups || []).length) + ' 份）' }),
      h('div', { class: 'box-note', text: '恢复会**覆盖当前全部数据**，且需要输入「恢复」两个字确认；恢复前系统会自动把当前数据再备一份' }),
    ]));
    const b2 = h('div', { class: 'box-body', id: 'backupList' });
    if (!(info.backups || []).length) b2.appendChild(h('div', { class: 'empty', text: '还没有备份文件' }));
    (info.backups || []).forEach((bk) => {
      b2.appendChild(h('div', { class: 'ev-row' }, [
        h('div', { class: 'grow' }, [
          h('div', { class: 'name', text: bk.name }),
          h('div', { class: 'meta' }, [
            h('span', { class: 'box-note', text: App.fmtTime(bk.at, true) }),
            h('span', { class: 'box-note', text: Math.round(bk.size / 1024) + ' KB' }),
          ]),
        ]),
        h('div', { class: 'acts' }, [
          h('button', {
            class: 'btn btn-sm btn-danger', type: 'button', text: '恢复这一份',
            onclick: () => {
              A.ask({
                title: '从备份恢复',
                text: '将用「' + bk.name + '」覆盖当前全部数据。\n\n恢复前系统会自动把当前数据备份成一份新的（万一恢复错了还能回来）。\n恢复后所有人需要重新登录。',
                confirmText: '恢复', okText: '确认恢复', danger: true,
              }).then((r) => {
                if (!r.ok) return;
                App.api('/api/backups/restore', { method: 'POST', body: { name: bk.name, confirmText: '恢复' } }).then((res) => {
                  if (res.ok) {
                    A.toast('已恢复，正在重新加载…', 'ok', 4000);
                    setTimeout(() => location.reload(), 1200);
                  } else {
                    A.toast((res.data && res.data.message) || res.error || '恢复失败', 'bad', 6000);
                  }
                });
              });
            },
          }),
          h('button', {
            class: 'btn btn-sm btn-ghost', type: 'button', text: '删除',
            onclick: () => A.ask({ title: '删除备份', text: '删除备份文件「' + bk.name + '」？', okText: '删除', danger: true })
              .then((r) => {
                if (!r.ok) return;
                App.api('/api/backups/delete', { method: 'POST', body: { name: bk.name } }).then(() => A.loadBackups());
              }),
          }),
        ]),
      ]));
    });
    box2.appendChild(b2);
    pane.appendChild(box2);

    /* 数据导出 */
    const box3 = h('div', { class: 'box' });
    box3.appendChild(h('div', { class: 'box-head' }, [h('div', { class: 'box-title', text: '导出 Excel / CSV' })]));
    const b3 = h('div', { class: 'box-body toolbar' });
    [
      ['成绩总表', 'results', 'xls'],
      ['排名表（张贴用）', 'rank', 'xls'],
      ['班级总分榜', 'team', 'xls'],
      ['名单', 'roster', 'xls'],
      ['秩序册', 'program', 'xls'],
      ['检录单', 'checkin', 'xls'],
      ['成绩总表 CSV', 'results', 'csv'],
    ].forEach(([label, what, format]) => {
      b3.appendChild(h('button', {
        class: 'btn btn-sm', type: 'button', text: label,
        onclick: () => { location.href = '/api/export?what=' + what + '&format=' + format; },
      }));
    });
    box3.appendChild(b3);
    pane.appendChild(box3);

    /* 危险操作 */
    const box4 = h('div', { class: 'box' });
    box4.appendChild(h('div', { class: 'box-head' }, [h('div', { class: 'box-title', text: '危险操作' })]));
    const b4 = h('div', { class: 'box-body toolbar' }, [
      h('button', {
        class: 'btn btn-sm btn-danger', type: 'button', text: '清空全部成绩（保留名单与项目）',
        onclick: () => doClear('results', '将删除所有已录成绩与检录记录，名单和项目保留。赛前重来一遍时用这个。'),
      }),
      h('button', {
        class: 'btn btn-sm btn-danger', type: 'button', text: '清空成绩与项目',
        onclick: () => doClear('events', '将删除所有成绩、报名、项目。运动员名单保留。'),
      }),
      h('button', {
        class: 'btn btn-sm btn-danger', type: 'button', text: '清空全部数据（连名单）',
        onclick: () => doClear('all', '将删除本届的全部数据：成绩、报名、项目、运动员、班级、公告、聊天记录。这个操作不可撤销。'),
      }),
      h('button', {
        class: 'btn btn-sm', type: 'button', text: '载入演示数据',
        onclick: () => {
          A.ask({
            title: '载入演示数据',
            text: '会用一套演示数据**替换掉现有全部数据**（12 个班 / 48 名运动员 / 11 个项目）。\n\n这个操作不可撤销，建议先点「立即备份」。',
            confirmText: '演示', okText: '载入演示', danger: true,
          }).then((r) => {
            if (!r.ok) return;
            App.op('data.demo', { confirmText: '演示' }).then((res) => {
              if (res.ok) { A.toast('演示数据已载入', 'ok'); setTimeout(() => location.reload(), 900); }
              else A.toast((res.data && res.data.message) || res.error || '失败', 'bad', 5000);
            });
          });
        },
      }),
    ]);
    function doClear(scope, text) {
      A.ask({ title: '清空数据', text: text + '\n\n请在下面输入「清空」两个字以确认。', confirmText: '清空', okText: '确认清空', danger: true })
        .then((r) => {
          if (!r.ok) return;
          App.op('data.clear', { scope, confirmText: '清空' }).then((res) => {
            if (res.ok) { A.toast('已清空', 'ok'); A.refresh(); }
            else A.toast((res.data && res.data.message) || res.error || '失败', 'bad');
          });
        });
    }
    box4.appendChild(b4);
    pane.appendChild(box4);
  });

  /* ══════════════════════════════════════════════════════════════════════
   * 在线会话（"多地登录"看得见、能踢）
   *
   * 【为什么要有这个】系统允许同一账号在多台设备、多个地点同时登录，
   * 而且会话**不绑 IP**（现场手机+电脑同时用是常态，绑 IP 会把人踢下线）。
   * 代价是：账号被盗后从别处登录，界面上原来只显示一个"在线"，
   * 根本看不出"这个账号现在有几个地方在登"。
   *
   * 这个弹窗把每个会话的 **IP / 设备 / 最后活跃时间** 列出来，
   * 新出现的 IP 会标黄 —— 一眼能看出"有个我没见过的地方在登"，
   * 并且能**单独把那一处踢掉**（其它设备不受影响）。
   * ══════════════════════════════════════════════════════════════════════ */

  /** 打开某个账号的登录情况 */
  function showSessions(u) {
    /* 【用 A.modal 画自己的弹窗，别"借 A.ask 的壳"】
       我第一版是 A.ask() 打开壳、然后 clear(askField) 塞自己的内容 ——
       结果把 `#askInput` 从文档里删掉了，而 A.ask 在点"确定"时会读
       `input.value`，于是抛 `Cannot read properties of null (reading 'value')`，
       **整个踢人流程静默中断**（弹窗关了、请求一个都没发、也没提示）。
       查了很久才定位到。A.modal 会留着一个画布给你画，不碰 ask 依赖的元素。 */
    const m = A.modal({
      title: '「' + (u.displayName || u.username) + '」的登录',
      text: '正在读取…',
    });
    const listBox = h('div', { class: 'sess-list' });
    m.canvas.appendChild(listBox);

    function paint() {
      App.api('/api/sessions', { query: { userId: u.id } }).then((r) => {
        clear(listBox);
        if (!r.ok || !r.data || !r.data.ok) {
          listBox.appendChild(h('div', { class: 'empty', text: '读不到登录列表：'
            + ((r.data && r.data.message) || r.error || '网络错误') }));
          return;
        }
        const d2 = r.data.data;
        const ss = d2.sessions || [];
        const multi = !!d2.multiDevice;
        el('askText').textContent = multi
          ? '当前设置为**允许多设备登录**（config.js 的 allowMultiDeviceLogin）。'
            + '下面每一行是一次登录，可以把某一处单独踢掉。'
          : '一个账号同一时间只能在一台设备上登录。在别处登录时，原来那台会被立刻顶下线。'
            + '下面这台就是它现在登录的机器。';
        listBox.appendChild(h('div', { class: 'box-note', style: { marginBottom: '8px' },
          text: ss.length ? ('当前 ' + ss.length + ' 处登录') : '当前没有登录' }));
        if (!ss.length) {
          listBox.appendChild(h('div', { class: 'empty', text: '这个账号当前没有登录' }));
          return;
        }
        ss.forEach((s) => {
          listBox.appendChild(h('div', { class: 'sess-row' + (s.newIp ? ' is-new' : '') }, [
            h('div', { class: 'grow' }, [
              h('div', { class: 'sess-ip' }, [
                h('span', { text: s.ip }),
                s.current ? h('span', { class: 'pill pill-ok', text: '就是你现在这条' }) : null,
                s.newIp ? h('span', { class: 'pill pill-warn', text: '这个 IP 以前没登录过' }) : null,
              ]),
              h('div', { class: 'meta' }, [
                h('span', { class: 'box-note', text: s.agent }),
                h('span', { class: 'box-note', text: '最后活跃 ' + App.fmtTime(s.lastSeenAt, true) }),
                h('span', { class: 'box-note', text: '登录于 ' + App.fmtTime(s.createdAt, true) }),
              ]),
            ]),
            h('div', { class: 'acts' }, [
              s.current
                ? h('span', { class: 'box-note', text: '（要退出请点右上角「退出」）' })
                : h('button', {
                  class: 'btn btn-sm btn-danger', type: 'button', text: '踢掉这一处',
                  onclick: () => {
                    /* 嵌套确认框：用 suspend 临时借用弹窗外壳。
                       不用 A.ask —— 它假定输入区是它的，会把我们的会话列表盖掉/弄坏。 */
                    A.modal({
                      suspend: true,
                      title: '踢掉这一处登录',
                      text: '把 ' + s.ip + '（' + s.agent + '）上的登录踢掉？\n\n'
                        + '那一台设备会立刻掉线，需要重新登录才能继续用；'
                        + '其它设备（包括你自己现在这台）不受影响。',
                      okText: '踢掉', danger: true,
                      onOk: () => {
                        App.api('/api/sessions/kick', { method: 'POST', body: { id: s.id } }).then((res) => {
                          if (res.ok) { A.toast('已踢掉 ' + s.ip + ' 上的登录', 'ok'); paint(); }
                          else A.toast((res.data && res.data.message) || '踢不掉', 'bad', 4000);
                        });
                      },
                    });
                  },
                }),
            ]),
          ]));
        });
        // 一键"踢掉其它所有设备"（保留自己这条）—— 怀疑被盗时最省事
        const others = ss.filter(x => !x.current);
        if (others.length) {
          listBox.appendChild(h('div', { class: 'toolbar', style: { marginTop: '10px' } }, [
            h('span', { style: { flex: '1 1 auto' } }),
            h('button', {
              class: 'btn btn-sm btn-danger', type: 'button',
              text: '踢掉其它全部 ' + others.length + ' 处',
              onclick: () => A.modal({
                suspend: true,
                title: '踢掉其它全部登录',
                text: '把除了你当前这条之外的 ' + others.length + ' 处登录全部踢掉？\n\n'
                  + '如果这个账号可能被盗了，这是最省事的做法。'
                  + '被踢的设备需要重新登录。',
                okText: '全部踢掉', danger: true,
                onOk: () => {
                  let done = 0;
                  let i = 0;
                  const step = () => {
                    if (i >= others.length) {
                      A.toast('已踢掉 ' + done + ' 处登录', done ? 'ok' : 'warn');
                      paint();
                      return;
                    }
                    App.api('/api/sessions/kick', { method: 'POST', body: { id: others[i++].id } })
                      .then((res) => { if (res.ok) done++; step(); });
                  };
                  step();
                },
              }),
            }),
          ]));
        }
      });
    }
    paint();
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 账号
   * ══════════════════════════════════════════════════════════════════════ */

  A.register('accounts', function renderAccounts() {
    const S = A.S;
    const pane = el('paneAccounts');
    clear(pane);
    if (!S.users) { pane.appendChild(h('div', { class: 'empty', text: '正在读取账号…' })); A.loadAccounts(); return; }

    const box = h('div', { class: 'box' });
    box.appendChild(h('div', { class: 'box-head' }, [
      h('div', { class: 'box-title', text: '账号与权限' }),
      h('div', { class: 'box-note', text: '管理员：全部权限　·　操作员：录成绩/检录/公告/聊天　·　只读：只能看' }),
      h('span', { style: { flex: '1 1 auto' } }),
      h('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '新增账号', onclick: () => addUser() }),
    ]));
    const wrap = h('div', { class: 'table-wrap' });
    const table = h('table', { class: 'grid' });
    table.appendChild(h('thead', {}, [h('tr', {}, [
      h('th', { text: '账号' }), h('th', { text: '显示名' }), h('th', { text: '角色' }),
      h('th', { text: '登录情况' }), h('th', { text: '创建时间' }), h('th', { text: '操作' }),
    ])]));
    const tb = h('tbody');
    (S.users || []).forEach((u) => {
      const roleSel = h('select', { class: 'select', style: { width: 'min(120px, 100%)' } }, [
        h('option', { value: 'admin', text: '管理员' }),
        h('option', { value: 'operator', text: '操作员' }),
        h('option', { value: 'viewer', text: '只读' }),
      ]);
      roleSel.value = u.role;
      roleSel.addEventListener('change', () => {
        App.op('user.update', { id: u.id, role: roleSel.value }).then((r) => {
          if (r.ok) A.loadAccounts(); else A.toast((r.data && r.data.message) || '改不了', 'bad');
        });
      });
      const nameInput = h('input', { class: 'input input-editable', value: u.displayName, style: { width: 'min(120px, 100%)' } });
      nameInput.addEventListener('change', () => {
        App.op('user.update', { id: u.id, displayName: nameInput.value }).then(() => A.loadAccounts());
      });
      tb.appendChild(h('tr', {}, [
        h('td', { text: u.username }),
        h('td', {}, [nameInput]),
        h('td', {}, [roleSel]),
        h('td', {}, [
          /* 登录情况：分三种状态显示 ——
               · 在线：这条会话自己的客户端还在打心跳（每 30 秒一次）
               · 已离线：会话还在，但人已经关掉页面了
                 ★ 这就是"打开过一次就一直显示已登录"的修正：
                   判据是**最近还在活动**（90 秒内有心跳），
                   不是"会话表里有没有记录"。
               · 未登录：压根没有会话
             点开能看到 IP / 设备 / 最后活跃时间，并把它踢下线。 */
          u.online
            ? h('button', {
              class: 'btn btn-sm', type: 'button',
              text: '在线' + (u.sessionIp ? ('（' + u.sessionIp + '）') : ''),
              title: '点开看是哪台设备、什么时候登录的；也可以把它踢下线',
              onclick: () => showSessions(u),
            })
            : (u.loggedIn
              ? h('button', {
                class: 'btn btn-sm btn-ghost', type: 'button',
                text: '已离线（还留着登录）',
                title: '这个人已经关掉页面了，只是登录记录还在。点开可以把它踢掉。',
                onclick: () => showSessions(u),
              })
              : h('span', { class: 'box-note', text: '未登录' })),
          h('button', {
            class: 'btn btn-sm ' + (u.disabled ? 'btn-danger' : ''), type: 'button',
            style: { marginLeft: '6px' },
            text: u.disabled ? '已停用（点启用）' : '正常（点停用）',
            onclick: () => App.op('user.update', { id: u.id, disabled: !u.disabled }).then((r) => {
              if (r.ok) A.loadAccounts(); else A.toast((r.data && r.data.message) || '改不了', 'bad', 4000);
            }),
          }),
        ]),
        h('td', { text: App.fmtTime(u.createdAt, true) }),
        h('td', {}, [
          h('button', {
            class: 'btn btn-sm', type: 'button', text: '重置口令',
            onclick: () => {
              A.ask({ title: '重置口令', text: '给「' + u.username + '」设一个新口令（至少 6 位）。', input: true });
              const field = el('askField');
              const modal = el('askModal');
              const input = h('input', { class: 'input', type: 'text', placeholder: '新口令' });
              el('askTitle').textContent = '重置口令';
              el('askText').textContent = '给「' + u.username + '」设一个新口令（至少 6 位，别全是数字）。设完后他的登录会失效，需要用新口令重新登录。';
              field.hidden = false; clear(field); field.appendChild(input);
              el('askOk').textContent = '重置'; el('askOk').className = 'btn btn-primary';
              modal.hidden = false;
              const finish = () => {
                modal.hidden = true;
                el('askOk').onclick = null; el('askCancel').onclick = null; el('askClose').onclick = null;
                clear(field); field.hidden = true;
                field.appendChild(h('span', { class: 'label', id: 'askLabel' }));
                field.appendChild(h('input', { class: 'input', id: 'askInput', type: 'text', autocomplete: 'off' }));
              };
              el('askCancel').onclick = finish; el('askClose').onclick = finish;
              el('askOk').onclick = () => {
                if (input.value.length < 6) { A.toast('口令至少 6 位', 'warn'); return; }
                App.op('user.pwd', { id: u.id, newPassword: input.value }).then((r) => {
                  if (r.ok) { A.toast('口令已重置', 'ok'); finish(); }
                  else A.toast((r.data && r.data.message) || '失败', 'bad');
                });
              };
            },
          }),
          h('button', {
            class: 'btn btn-sm btn-ghost', type: 'button', text: '删除',
            onclick: () => A.ask({ title: '删除账号', text: '删除「' + u.username + '」？他的登录会立即失效。', okText: '删除', danger: true })
              .then((r) => {
                if (!r.ok) return;
                App.op('user.del', { id: u.id }).then((res) => {
                  if (res.ok) A.loadAccounts(); else A.toast((res.data && res.data.message) || '删不掉', 'bad', 4000);
                });
              }),
          }),
        ]),
      ]));
    });
    table.appendChild(tb);
    wrap.appendChild(table);
    box.appendChild(h('div', { class: 'box-body' }, [wrap]));
    pane.appendChild(box);
  });

  function addUser() {
    const username = h('input', { class: 'input', placeholder: '账号，如 judge1（小写字母数字）' });
    const displayName = h('input', { class: 'input', placeholder: '显示名，如 终点裁判' });
    const password = h('input', { class: 'input', type: 'text', placeholder: '初始口令（至少 6 位）' });
    const role = h('select', { class: 'select' }, [
      h('option', { value: 'operator', text: '操作员（录成绩、检录、发公告、聊天）' }),
      h('option', { value: 'admin', text: '管理员（全部权限）' }),
      h('option', { value: 'viewer', text: '只读（只能看）' }),
    ]);
    const field = el('askField');
    const modal = el('askModal');
    el('askTitle').textContent = '新增账号';
    el('askText').textContent = '把账号与口令当面告诉那位老师，让他用自己的账号登录（操作记录里就能看出是谁改的）。';
    field.hidden = false;
    clear(field);
    field.appendChild(h('div', { class: 'form-grid' }, [
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '账号' }), username]),
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '显示名' }), displayName]),
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '初始口令' }), password]),
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '角色' }), role]),
    ]));
    el('askOk').textContent = '创建';
    el('askOk').className = 'btn btn-primary';
    modal.hidden = false;
    setTimeout(() => username.focus(), 40);
    const finish = () => {
      modal.hidden = true;
      el('askOk').onclick = null; el('askCancel').onclick = null; el('askClose').onclick = null;
      clear(field); field.hidden = true;
      field.appendChild(h('span', { class: 'label', id: 'askLabel' }));
      field.appendChild(h('input', { class: 'input', id: 'askInput', type: 'text', autocomplete: 'off' }));
    };
    el('askCancel').onclick = finish; el('askClose').onclick = finish;
    el('askOk').onclick = () => {
      App.op('user.add', {
        username: username.value.trim(), displayName: displayName.value.trim(),
        password: password.value, role: role.value,
      }).then((r) => {
        if (r.ok) { A.toast('账号已创建', 'ok'); finish(); A.loadAccounts(); }
        else A.toast((r.data && r.data.message) || '创建失败', 'bad', 5000);
      });
    };
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 操作记录
   * ══════════════════════════════════════════════════════════════════════ */

  A.register('audit', function renderAudit() {
    const S = A.S;
    const pane = el('paneAudit');
    clear(pane);
    if (!S.audit) { pane.appendChild(h('div', { class: 'empty', text: '正在读取操作记录…' })); A.loadAudit(); return; }

    const box = h('div', { class: 'box' });
    box.appendChild(h('div', { class: 'box-head' }, [
      h('div', { class: 'box-title', text: '操作记录（最近 ' + (S.audit || []).length + ' 条）' }),
      h('div', { class: 'box-note', text: '谁在什么时候改了什么' }),
      h('span', { style: { flex: '1 1 auto' } }),
      h('button', { class: 'btn btn-sm', type: 'button', text: '刷新', onclick: () => A.loadAudit() }),
    ]));
    const wrap = h('div', { class: 'table-wrap' });
    const table = h('table', { class: 'grid' });
    table.appendChild(h('thead', {}, [h('tr', {}, [
      h('th', { text: '时间' }), h('th', { text: '操作人' }), h('th', { text: '做了什么' }),
      h('th', { text: '对象' }), h('th', { text: '说明' }),
    ])]));
    const tb = h('tbody');
    (S.audit || []).forEach((l) => {
      tb.appendChild(h('tr', {}, [
        h('td', { class: 'num', text: App.fmtTime(l.createdAt, true) }),
        h('td', { text: l.userName || '系统' }),
        h('td', { text: actionLabel(l.action) }),
        h('td', { text: l.target || '' }),
        h('td', {}, [h('span', { class: 'box-note', text: l.detail || '' })]),
      ]));
    });
    table.appendChild(tb);
    wrap.appendChild(table);
    box.appendChild(h('div', { class: 'box-body' }, [wrap]));
    pane.appendChild(box);
  });

  function actionLabel(a) {
    const map = {
      'user.login': '登录', 'user.logout': '退出', 'user.login.fail': '登录失败',
      'user.add': '新增账号', 'user.update': '修改账号', 'user.pwd': '重置口令', 'user.del': '删除账号',
      'session.kick': '踢掉登录',
      'staged.confirm': '确认并推送', 'backup.create': '创建备份', 'backup.restore': '从备份恢复',
      'backup.delete': '删除备份', 'audit.undo': '回滚操作',
      'result.set': '录入成绩', 'result.batch': '批量录入成绩',
      'athlete.import': '导入名单',
    };
    return map[a] || a;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 版面体检
   *   说明：以前这里是一个"体检"页签，现在**从界面上撤掉了**（页签太多不好找，
   *   而且老师平时不需要看这些）。
   *   体检本身没丢：
   *     · 每个页签渲染完都会自动跑一次 App.checkLayout()，结果写进 #layout-report
   *       并回报服务端（日志里搜 [页面问题]），自动化测试也靠它断言
   *     · 想看细节时在浏览器控制台执行：  App.checkLayout('admin')
   *   这段代码保留在这里，就是为了以后想在界面上恢复时不用重写。
   * ══════════════════════════════════════════════════════════════════════ */

  function renderDiagPane(pane) {
    const box = h('div', { class: 'box' });
    box.appendChild(h('div', { class: 'box-head' }, [h('div', { class: 'box-title', text: '这台设备的显示信息' })]));
    const body = h('div', { class: 'box-body' });
    const s = App.screen();
    body.appendChild(h('div', { class: 'stats' }, [
      card('屏幕', window.innerWidth + ' × ' + window.innerHeight, ''),
      card('长宽比', s.aspect.toFixed(3), s.aspect >= 2.2 ? '超宽屏' : s.aspect >= 1.55 ? '常规' : s.aspect >= 1.15 ? '4:3' : '竖屏'),
      card('缩放系数 --s', s.s.toFixed(3), '设计像素 × 这个数 = 实际像素'),
      card('建议栏数', s.columns, '实际由大屏按内容量试算'),
    ]));
    box.appendChild(body);
    pane.appendChild(box);

    const box2 = h('div', { class: 'box' });
    box2.appendChild(h('div', { class: 'box-head' }, [
      h('div', { class: 'box-title', text: '本页版面体检' }),
      h('div', { class: 'box-note', text: '文字重叠、内容溢出、被裁切都会被列出来' }),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'btn btn-sm', type: 'button', text: '现在体检一次',
        onclick: () => { runDiag(); },
      }),
    ]));
    const b2 = h('div', { class: 'box-body', id: 'diagOut' });
    box2.appendChild(b2);
    pane.appendChild(box2);
    runDiag();

    function runDiag() {
      const out = el('diagOut');
      if (!out) return;
      clear(out);
      const issues = App.checkLayout('admin');
      if (!issues.length) {
        out.appendChild(h('div', { class: 'empty', text: '✓ 这一页没有发现版面问题' }));
        return;
      }
      const table = h('table', { class: 'grid' });
      table.appendChild(h('thead', {}, [h('tr', {}, [
        h('th', { text: '类型' }), h('th', { text: '元素' }), h('th', { text: '超出' }), h('th', { text: '内容' }),
      ])]));
      const tb = h('tbody');
      issues.slice(0, 60).forEach((i) => {
        tb.appendChild(h('tr', {}, [
          h('td', { text: { overlap: '文字重叠', overflow: '内容溢出', clipped: '被裁切', outside: '跑出屏幕', error: '脚本出错' }[i.kind] || i.kind }),
          h('td', {}, [h('code', { text: i.sel || '' })]),
          h('td', { class: 'num', text: i.by ? (i.by + 'px') : '' }),
          h('td', {}, [h('span', { class: 'box-note', text: i.text || '' })]),
        ]));
      });
      table.appendChild(tb);
      out.appendChild(h('div', { class: 'table-wrap' }, [table]));
    }
  }

  A.register('diag', function renderDiag() {
    // 界面上已经撤掉"体检"页签，所以这个容器**可能是没有的** —— 这是有意的
    // 可选查找，不是漏写。工具检查时看到这行末尾的标记会跳过。
    const pane = el('paneDiag');   // #id-optional
    if (!pane) return;
    clear(pane);
    renderDiagPane(pane);
  });
})();
