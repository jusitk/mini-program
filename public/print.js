/* ============================================================================
 * print.js —— 成绩单打印
 *   一页一个项目：名次 / 号码 / 姓名 / 班级 / 成绩 / 得分，底部留裁判长与记录员签字位
 *   数据走 /api/events/:id/board，与后台、大屏同一份口径
 * ========================================================================== */
'use strict';

(function () {
  const App = window.App;
  const h = App.h, el = App.el, clear = App.clear;

  const S = { events: [], meet: null, eventId: '', all: false, sign: true, statusLabel: null };

  /**
   * 状态文案。
   *
   * 打印页的数据来自 `/api/roster`（不是主快照），所以拿不到 statusLabel。
   * 这里保留一份**完整**的兜底（四种状态都写到），而不是像以前那样只写三个 ——
   * 漏掉"检录中"正是当初大屏和下拉框出问题的方式。
   * 真要彻底统一，应该让 `/api/roster` 也带上 statusLabel（见改动指南）。
   */
  const STATUS_TEXT = { pending: '未开始', checking: '检录中', live: '进行中', done: '已结束' };
  function stText(st) { return (S.statusLabel && S.statusLabel[st]) || STATUS_TEXT[st] || st || ''; }

  /**
   * 成绩单底部那句"同名次怎么判"的说明。
   *
   * 【为什么不能写"相差不超过 0.01"】那会让人以为 12.01 和 12.02 并列 ——
   * 而它们是两个不同的成绩。判等是**按计时精度**：读数取整后相同才算并列。
   * 说法与后端 src/parse.js 的 tieRuleText 保持一致（那边是真正算名次的地方）。
   */
  function tieText(tol) {
    const t = App.precision ? App.precision.norm(tol) : 0.01;
    const lbl = (App.precision && App.precision.LABEL[t]) || (t + ' 秒');
    return '成绩按' + lbl + '取整后相同的，名次并列；并列后名次跳号（如 1、2、2、4）';
  }

  function boot() {
    App.pxScale('standard');
    App.installErrorReporting('print');

    const url = new URL(location.href);
    S.eventId = url.searchParams.get('eventId') || '';

    el('btnPrint').addEventListener('click', () => window.print());
    el('btnReload').addEventListener('click', () => load(true));
    el('selEvent').addEventListener('change', (e) => { S.eventId = e.target.value; S.all = false; el('ckAll').checked = false; render(); });
    el('ckAll').addEventListener('change', (e) => { S.all = e.target.checked; render(); });
    el('ckSign').addEventListener('change', (e) => { S.sign = e.target.checked; render(); });

    App.api('/api/me').then((r) => {
      if (!r.ok || !r.data || !r.data.user) { location.replace('/login?next=/print'); return; }
      App.setCsrf(r.data.csrf);
      load();
    });
  }

  function load(reload) {
    App.api('/api/snapshot?kind=admin').then((r) => {
      if (!r.ok || !r.data) {
        el('printArea').innerHTML = '';
        el('printArea').appendChild(h('div', { class: 'empty', text: '读取失败：' + (r.error || '') }));
        return;
      }
      S.meet = r.data.meet;
      S.events = (r.data.events || []).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
      const sel = el('selEvent');
      const cur = S.eventId;
      clear(sel);
      S.events.forEach(e => sel.appendChild(h('option', {
        value: e.id,
        text: e.name + '（' + e.groupName + ' · ' + stText(e.status) + '）',
      })));
      if (!cur || !S.events.some(e => e.id === cur)) S.eventId = (S.events[0] || {}).id || '';
      sel.value = S.eventId;
      render();
      // 版面体检（自动化测试读 #layout-report；现场也可用它排查）
      setTimeout(() => App.checkLayout('print'), 800);
      if (reload) App.toastDone = true;
    });
  }

  function render() {
    const area = el('printArea');
    clear(area);
    const list = S.all
      ? S.events.filter(e => e.status === 'done')
      : S.events.filter(e => e.id === S.eventId);
    if (!list.length) {
      area.appendChild(h('div', { class: 'empty', text: S.all ? '还没有已结束的项目' : '请选择要打印的项目' }));
      return;
    }
    // 逐个项目取成绩板（顺序请求，避免同时打太多请求）
    let i = 0;
    const next = () => {
      if (i >= list.length) return;
      const ev = list[i++];
      App.api('/api/events/' + ev.id + '/board').then((r) => {
        if (r.ok && r.data && r.data.ok) area.appendChild(sheet(ev, r.data.data));
        next();
      });
    };
    next();
  }

  function sheet(ev, data) {
    const meet = S.meet || {};
    const rows = data.rows || [];
    const meta = data.event || {};

    const box = h('section', { class: 'sheet' });
    box.appendChild(h('div', { class: 'sheet-head' }, [
      h('div', { class: 'sheet-meet', text: meet.name || '运动会' }),
      meet.holdDate || meet.host ? h('div', { class: 'sheet-sub', text: [meet.host, meet.holdDate].filter(Boolean).join('　·　') }) : null,
      h('div', { class: 'sheet-title', text: '成　绩　单' }),
      h('div', { class: 'sheet-meta' }, [
        h('span', { text: '项目：' + ev.name }),
        h('span', { text: '组别：' + ev.groupName }),
        h('span', { text: '类型：' + (ev.kind === 'field' ? '田赛' : '径赛') }),
        h('span', { text: '阶段：' + (ev.stage === 'heat' ? '预赛' : '决赛') }),
        ev.venue ? h('span', { text: '场地：' + ev.venue }) : null,
        /* 打印单上也不再印时刻（项目上不出现时间标签） */
        h('span', { text: '报名 ' + (data.entries || []).length + ' 人' }),
      ]),
    ]));

    const attempts = meta.attempts || 1;
    const table = h('table', { class: 'sheet-table' });
    const head = ['名次', '号码', '姓名', '班级/单位'];
    if (ev.isRelay) head.push('参赛队员');
    for (let k = 1; k <= attempts; k++) head.push('第' + k + '次');
    head.push('成绩', '得分', '备注');
    table.appendChild(h('thead', {}, [h('tr', {}, head.map(t => h('th', { text: t })))]));

    const byReg = new Map((data.entries || []).map(e => [e.regId, e]));
    const tb = h('tbody');
    if (!rows.length) {
      tb.appendChild(h('tr', {}, [h('td', { colspan: String(head.length), style: { textAlign: 'center', color: '#666' }, text: '没有成绩记录' })]));
    }
    rows.forEach((row) => {
      const en = byReg.get(row.regId) || {};
      const tr = h('tr', { class: row.rank <= 3 && !row.dnf ? 'medal' + row.rank : '' });
      tr.appendChild(h('td', { class: 'rank', text: row.rank ? String(row.rank) : '—' }));
      tr.appendChild(h('td', { class: 'num', text: row.bib || en.bib || '' }));
      tr.appendChild(h('td', { class: 'name', text: row.isRelay ? (row.teamName || row.name || '') : (row.name || en.name || '') }));
      tr.appendChild(h('td', { text: en.team || '' }));
      if (ev.isRelay) tr.appendChild(h('td', { class: 'legs', text: (row.legs || []).join('、') }));
      for (let k = 1; k <= attempts; k++) {
        const at = (en.attempts || []).find(x => x.attempt === k);
        // 显示文字一律用服务端给的（犯规/弃权/成绩都算好了），前端别自己判
        tr.appendChild(h('td', { class: 'num', text: at ? (at.display || at.editText || '') : '' }));
      }
      // row.display 已经区分了"犯规"和"弃权"（foulOnly），别在这里覆盖
      tr.appendChild(h('td', { class: 'score' + (row.dnf ? ' dnf' : ''), text: row.display || '' }));
      tr.appendChild(h('td', { class: 'num', text: row.points ? String(row.points) : '' }));
      tr.appendChild(h('td', { text: row.dnf ? (row.display || '') : '' }));
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    box.appendChild(table);

    box.appendChild(h('div', { class: 'sheet-note' }, [
      /* 并列规则的说法按"计时精度"写 —— 与 src/parse.js 的 tieRuleText 同一口径。
         原来写的是"相差不超过 0.01"，那会让人以为 12.01 和 12.02 并列。 */
      h('div', { text: '说明：' + (ev.kind === 'field' ? '田赛成绩大者名次列前' : '径赛成绩小者名次列前')
        + '；' + tieText(meta.tol) + '。' }),
      ev.isRelay ? h('div', { text: '接力项目按班级（队）排名，班级后面的小字为本次参赛队员。' }) : null,
      attempts > 1 ? h('div', { text: '田赛取最好一次成绩排名；犯规的那次只有记录、不计成绩。' }) : null,
    ]));

    if (S.sign) {
      box.appendChild(h('div', { class: 'sheet-foot' }, [
        h('div', { class: 'sig', text: '裁判长（签字）：' }),
        h('div', { class: 'sig', text: '记录员（签字）：' }),
        h('div', { class: 'sig', text: '日期：　　年　　月　　日' }),
      ]));
    }
    return box;
  }

  App.bootstrap(boot);
})();
