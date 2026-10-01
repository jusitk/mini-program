/* ============================================================================
 * admin-results.js —— 成绩与名次页签
 *   按项目查看已录成绩与名次；导出、打印入口；清空某个项目的成绩（重录）
 *
 * 【这一页只做"看和导出"】
 *   成绩录入在「成绩录入」页，检录在「检录」页 —— 所以这里**不再放**
 *   「名单/录入」和「开始检录/停止检录」这两个按钮（它们只是跳到别处，
 *   在只看名次的页面里属于重复入口，容易让人以为要在这里录）。
 * ========================================================================== */
'use strict';

(function () {
  const A = window.Admin;
  const h = A.h, el = A.el, clear = A.clear;
  const App = window.App;

  function render() {
    const S = A.S;
    const pane = el('paneResults');
    if (!pane) return;
    const snap = S.snap;
    const f = S.filters.results;

    const events = (snap.events || []).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
    if (!f.eventId && events.length) f.eventId = events[0].id;
    const ev = events.find(e => e.id === f.eventId) || events[0];

    /* 当前项目：按钮的 onclick 里要读"最新"的项目，所以不能闭包住建按钮时的 ev。
       这个对象在每次 render 时更新，按钮只建一次、永远作用于当前项目。
       声明必须放在建按钮**之前**（否则读起来像在用未初始化的变量）。 */
    const cur = ev || {};

    /* 【原地更新】整个页签的骨架只建一次（标题条 / 项目下拉 / 表头）。
       原来这里 clear(pane) 全重建 —— 每次数据更新都把下拉框和按钮重新造一遍，
       下拉框一被重建，正展开的选项就收起来了，鼠标点在按钮上也会失效。 */
    let box = pane.querySelector('[data-part="head"]');
    if (!box) {
      clear(pane);
      box = h('div', { class: 'box', 'data-part': 'head' });
      box.appendChild(h('div', { class: 'box-head' }, [
        h('div', { class: 'box-title', text: '成绩与名次' }),
        h('div', { class: 'box-note', text: '名次由服务端实时算：径赛小者优先、田赛大者优先、并列用 1,2,2,4、弃权排最后' }),
      ]));

      const bar = h('div', { class: 'box-body toolbar' });
      const sel = h('select', { class: 'select grow', 'data-part': 'evsel' });
      // 状态文案用框架的 A.statusText（来自快照下发的 statusLabel）——
      // 以前这里自己写三元链，加了"检录中"之后下拉里就显示不出这个状态
      sel.addEventListener('change', () => { f.eventId = sel.value; render(); });
      bar.appendChild(sel);
      /* 【这里原来有个「名单/录入」按钮，已去掉】
         它只是跳到「成绩录入」页签的同一个项目，属于重复入口 ——
         要看名单/录成绩，左侧点「成绩录入」就行（赛程编排页里那个入口保留）。 */
      bar.appendChild(h('button', {
        class: 'btn btn-sm', type: 'button', text: '导出这个项目的 Excel',
        onclick: () => { location.href = '/api/export?what=results&format=xls&eventId=' + encodeURIComponent(cur.id); },
      }));
      bar.appendChild(h('button', {
        class: 'btn btn-sm', type: 'button', text: '导出排名表（全部已结束项目）',
        onclick: () => { location.href = '/api/export?what=rank&format=xls'; },
      }));
      bar.appendChild(h('a', {
        class: 'btn btn-sm', 'data-part': 'printlink', href: '#', target: '_blank',
        text: '打印成绩单（A4）',
      }));
      bar.appendChild(h('button', {
        class: 'btn btn-sm btn-danger', type: 'button', text: '清空这个项目的成绩',
        onclick: () => {
          A.ask({
            title: '清空项目成绩',
            text: '将删除「' + (cur.name || '') + '」已录的全部成绩，名单保留。这个操作会直接生效（不进暂存区），无法撤销。',
            okText: '确认清空', danger: true,
          }).then((r) => {
            if (!r.ok) return;
            App.op('result.clearEvent', { eventId: cur.id }).then((res) => {
              if (res.ok) { A.toast('已清空 ' + (res.data.data && res.data.data.removed) + ' 条成绩', 'ok'); A.refresh(); }
              else A.toast(res.error || '清空失败', 'bad');
            });
          });
        },
      }));
      box.appendChild(bar);
      pane.appendChild(box);
    }

    // 下拉选项：原地对齐（改文字、加/删 option），用户展开时不会被关掉
    const sel = box.querySelector('[data-part="evsel"]');
    if (sel) {
      App.dom.reconcile(sel, events, e2 => e2.id, (e2, node) => {
        if (!node) node = h('option', {});
        node.value = e2.id;
        App.dom.setText(node, e2.name + '（' + e2.groupName + ' · ' + A.statusText(e2.status)
          + ' · 已录 ' + e2.recorded + '/' + e2.regCount + '）');
        return node;
      });
      const want = ev ? ev.id : '';
      if (sel.value !== want) sel.value = want;
    }
    const pl = box.querySelector('[data-part="printlink"]');
    if (pl) pl.setAttribute('href', '/print?eventId=' + encodeURIComponent(cur.id || ''));

    if (!ev) {
      let e0 = pane.querySelector('[data-part="noev"]');
      if (!e0) { e0 = h('div', { class: 'empty', 'data-part': 'noev', text: '还没有项目' }); pane.appendChild(e0); }
      return;
    }
    const noev = pane.querySelector('[data-part="noev"]');
    if (noev) noev.remove();

    /* 成绩表：直接读大屏算好的名次（口径完全一致） */
    let boardBox = pane.querySelector('[data-part="board"]');
    if (!boardBox) {
      boardBox = h('div', { class: 'box', 'data-part': 'board' });
      boardBox.appendChild(h('div', { class: 'box-head' }, [
        h('div', { class: 'box-title', 'data-part': 'bname' }),
        h('div', { class: 'box-note', 'data-part': 'bmeta' }),
        /* 【这里原来有个「开始检录/停止检录」按钮，已去掉】
           检录该在「检录」页做，成绩与名次页只负责看名次和导出。 */
      ]));
      boardBox.appendChild(h('div', { class: 'box-body', id: 'resultsBody' }));
      pane.appendChild(boardBox);
    }
    App.dom.setText(boardBox.querySelector('[data-part="bname"]'), ev.name);
    App.dom.setText(boardBox.querySelector('[data-part="bmeta"]'), ev.groupName + ' · '
      + (ev.kind === 'field' ? '田赛' : '径赛') + ' · ' + (ev.stage === 'heat' ? '预赛' : '决赛')
      + (ev.attempts > 1 ? (' · ' + ev.attempts + ' 次试跳') : ''));

    loadBoard(ev);
  }

  /** 单项目成绩板：/api/events/:id/board（含次数明细、名次、得分）
   *
   * 【原地更新】这里原来每次都 clear(body) 整块重建（统计卡 + 表头 + 整张表）。
   * 一有别的设备录成绩、或自己刷新，整页就在脚下重画一遍。
   * 现在：统计卡与表格骨架只建一次，之后按 regId 对齐表格行、只改变化的格子。
   * 表头在"试跳次数变了"（田赛 3 次）时才重建 —— 那是列数真的变了。
   */
  function loadBoard(ev) {
    const body = el('resultsBody');
    if (!body) return;

    App.api('/api/events/' + ev.id + '/board').then((r) => {
      if (el('resultsBody') !== body) return;          // 已经切到别的项目了
      if (!r.ok || !r.data || !r.data.ok) {
        clear(body);
        body.appendChild(h('div', { class: 'empty', text: (r.data && r.data.message) || r.error || '读取失败' }));
        return;
      }
      const data = r.data.data;
      const rows = data.rows || [];
      const entries = data.entries || [];

      // 统计卡：只建一次
      let stats = body.querySelector('[data-part="stats"]');
      if (!stats) {
        stats = h('div', { class: 'stats', 'data-part': 'stats', style: { marginBottom: '12px' } });
        clear(body);
        body.appendChild(stats);
      }
      const statVals = [
        ['报名人数', entries.length, '人'],
        ['已录成绩', entries.filter(e => (e.attempts || []).length).length, '人'],
        ['检录已到', data.checkin.arrived + '/' + data.checkin.total, data.checkin.open ? '（检录中）' : ''],
        ['弃权', rows.filter(x => x.dnf).length, '人'],
      ];
      App.dom.reconcile(stats, statVals, it => it[0], (it, node) => {
        if (!node) {
          node = h('div', { class: 'stat' }, [
            h('div', { class: 'k' }), h('div', { class: 'v' }), h('div', { class: 'x' }),
          ]);
        }
        App.dom.setText(node.querySelector('.k'), it[0]);
        App.dom.setText(node.querySelector('.v'), String(it[1]));
        App.dom.setText(node.querySelector('.x'), it[2] || '');
        return node;
      });

      /* 【录全了才对外展示名次，这里给个明确提示】
         大屏在没录全时**不显示名次**（只显示录入进度）。
         后台是拿来核对和补录的，所以名次照常显示，但必须让人一眼看出
         "这个还没录完、大屏上现在是空着的" —— 否则会以为大屏坏了。 */
      const recDone = entries.filter(e => (e.attempts || []).length).length;
      const recReady = entries.length > 0 && recDone >= entries.length;
      let banner = body.querySelector('[data-part="recbanner"]');
      if (entries.length && !recReady) {
        if (!banner) {
          banner = h('div', { class: 'notice-bar', 'data-part': 'recbanner' });
          body.insertBefore(banner, stats.nextSibling);
        }
        clear(banner);
        banner.appendChild(h('span', { text: '还没录全：' + recDone + ' / ' + entries.length
          + ' 人 —— **大屏上这个项目暂时不显示名次**（只显示"成绩录入中"），录满后自动出榜。' }));
      } else if (banner) {
        banner.remove();
      }

      if (!entries.length) {
        let e0 = body.querySelector('[data-part="noentry"]');
        if (!e0) {
          e0 = h('div', { class: 'empty', 'data-part': 'noentry', text: '这个项目还没有报名名单。到「赛程」或「名单」里把运动员加进来。' });
          body.appendChild(e0);
        }
        const w0 = body.querySelector('[data-part="wrap"]');
        if (w0) w0.hidden = true;
        return;
      }
      const ne = body.querySelector('[data-part="noentry"]');
      if (ne) ne.remove();

      const attempts = ev.attempts || 1;
      const head = ['名次', '号码', '姓名', '班级/单位'];
      if (ev.isRelay) head.push('参赛队员');
      head.push('道次');
      for (let k = 1; k <= attempts; k++) head.push('第 ' + k + ' 次');
      head.push('最好成绩', '得分');

      // 表头：列数/列名变了才重建
      const headSig = head.join('|');
      let wrap = body.querySelector('[data-part="wrap"]');
      let table = wrap ? wrap.querySelector('table') : null;
      if (wrap && wrap.getAttribute('data-headsig') !== headSig) { wrap.remove(); wrap = null; table = null; }
      if (!wrap) {
        table = h('table', { class: 'grid' });
        table.appendChild(h('thead', {}, [h('tr', {}, head.map((t, i) => h('th', { class: i >= 6 ? 'num' : '', text: t })))]));
        table.appendChild(h('tbody'));
        wrap = h('div', { class: 'table-wrap', 'data-part': 'wrap' }, [table]);
        wrap.setAttribute('data-headsig', headSig);
        body.appendChild(wrap);
      } else {
        wrap.hidden = false;
      }
      const tbody = table.querySelector('tbody');

      // 行：按 regId 对齐（服务端已按名次排好序，顺序变了只是移动）
      const byReg = new Map(entries.map(e => [e.regId, e]));
      const list = rows.map((row) => ({ row: row, en: byReg.get(row.regId) || {} }));
      App.dom.reconcile(tbody, list, it => it.row.regId, (it, node) => {
        const row = it.row, en = it.en;
        const isRelay = !!ev.isRelay;
        // 列数变了（田赛 3 次试跳）时节点复用会串列，所以把列签名记在行上
        const sig = attempts + '|' + (isRelay ? 'r' : '-');
        if (node && node.getAttribute('data-sig') !== sig) node = null;
        if (!node) {
          node = h('tr', {});
          for (let i = 0; i < head.length; i++) node.appendChild(h('td', {}));
          node.setAttribute('data-sig', sig);
        }
        const tds = node.children;
        const cls = row.rank <= 3 && !row.dnf ? 'top' + row.rank : '';
        App.dom.setClass(node, cls);
        let c = 0;
        App.dom.setClass(tds[c], 'rank'); App.dom.setText(tds[c++], row.rank ? String(row.rank) : '—');
        App.dom.setClass(tds[c], 'num'); App.dom.setText(tds[c++], row.bib || en.bib || '');
        App.dom.setClass(tds[c], ''); App.dom.setText(tds[c++], isRelay ? (row.teamName || row.name || '') : (row.name || en.name));
        App.dom.setClass(tds[c], ''); App.dom.setText(tds[c++], en.team || '');
        if (isRelay) { App.dom.setClass(tds[c], ''); App.dom.setText(tds[c++], (row.legs || []).join('、')); }
        App.dom.setClass(tds[c], 'num');
        App.dom.setText(tds[c++], en.lane === null || en.lane === undefined ? '' : String(en.lane));
        for (let k = 1; k <= attempts; k++) {
          const at = (en.attempts || []).find(x => x.attempt === k);
          // 显示文字一律用服务端给的（犯规/弃权/成绩都算好了），前端别自己判
          App.dom.setClass(tds[c], 'num');
          App.dom.setText(tds[c++], at ? (at.display || at.editText || '') : '');
        }
        // row.display 已经区分了"犯规"和"弃权"，不要再自己拼 row.dnf ? 弃权
        App.dom.setClass(tds[c], 'num'); App.dom.setText(tds[c++], row.display || '');
        App.dom.setClass(tds[c], 'num'); App.dom.setText(tds[c++], row.points ? String(row.points) : '');
        return node;
      });

      // 两句说明：只在需要时出现（用固定位置的两个节点，避免反复增删）
      let note1 = body.querySelector('[data-part="note1"]');
      const note1Text = (data.event && data.event.kind === 'field' && attempts > 1)
        ? '田赛按「最好的一次」排名；犯规的那次只有记录、没有成绩。' : '';
      if (note1Text) {
        if (!note1) { note1 = h('div', { class: 'box-note', 'data-part': 'note1', style: { marginTop: '8px' } }); body.appendChild(note1); }
        App.dom.setText(note1, note1Text);
      } else if (note1) { note1.remove(); }

      // 让没进榜的报名（比如只有犯规记录）也能看到
      const missing = entries.filter(e => !rows.some(x => x.regId === e.regId));
      let note2 = body.querySelector('[data-part="note2"]');
      const note2Text = missing.length
        ? ('另有 ' + missing.length + ' 人还没有任何有效成绩：' + missing.map(m => m.name).join('、')) : '';
      if (note2Text) {
        if (!note2) { note2 = h('div', { class: 'box-note', 'data-part': 'note2', style: { marginTop: '8px' } }); body.appendChild(note2); }
        App.dom.setText(note2, note2Text);
      } else if (note2) { note2.remove(); }
    });
  }

  A.register('results', render);
})();
