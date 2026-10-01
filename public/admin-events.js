/* ============================================================================
 * admin-events.js —— 赛程页签
 *
 * 需求里点名的两件事：
 *   · **每个赛事项目后面都要有「名单/录入」入口**，点了直接跳到该项目的成绩录入界面
 *   · 项目上**不出现任何与时间有关的东西**（见下）
 *
 * 【界面上的项目时间已全部去掉】用户要求："把所有和项目开始时间结束时间有关系的
 *   按钮显示的数据去掉"。所以：项目行、弹窗、录入页、打印单、大屏 —— 都不显示时刻，
 *   连「开始时刻/结束时刻」两个输入框和「全部按时间归位」按钮也一并撤了。
 *   **库里那 107 个项目的时刻也已清空**（实测它们全是 `"2026-09-30"` 这种纯日期，
 *   一个真的钟点都没有 —— 是早期 datetime-local 时代留下的废值，清掉最干净）。
 *   后端 `event.autoAll` 操作保留着，哪天要恢复这个入口，加回一行按钮即可。
 *
 * 【状态不再自动切换】原来有个 10 秒定时器，到点把项目自动推成"进行中/已结束"。
 *   现场反应是"没人操作却像开始了"，所以按用户要求去掉了（见 server.js 的 startTimers）。
 *   现在项目状态**全靠人工**：录入页/本页的状态按钮，或检录结果（人齐自动进"进行中"）。
 * 另外还有：新增项目（含接力、田赛试跳次数）、上下移动排序、录取决赛。
 *
 * 【录取决赛是手动的】点「录取决赛」只会**建出决赛项目 + 按预赛名次预填一份起点名单**，
 *   谁最终进决赛由老师在「名单」页增删 —— 现场常有例外（有人预赛完就走了、
 *   接力要换棒次），自动定死反而更慢。名次照旧只按**决赛**成绩算。
 * ========================================================================== */
'use strict';

(function () {
  const A = window.Admin;
  const h = A.h, el = A.el, clear = A.clear;
  const App = window.App;

  /**
   * 状态文案与语气统一走 A.statusText / A.statusTone（admin-core.js 里按服务端快照取）。
   * 本地这份只在快照还没到、或极端情况下服务端没给文案时兜底。
   */
  const STATUS = { pending: '未开始', checking: '检录中', live: '进行中', done: '已结束' };
  function statusText(st) { return A.statusText ? A.statusText(st) : (STATUS[st] || st); }
  function statusTone(st) { return A.statusTone ? A.statusTone(st) : 'dim'; }

  /** 语气 → 现有 pill 样式类（快照里给的 tone 是 dim/warn/ok/done） */
  function toneClass(tone) {
    if (tone === 'ok') return 'pill-ok';
    if (tone === 'warn') return 'pill-warn';
    if (tone === 'dim') return 'pill-dim';
    return 'pill-auto';
  }

  function render() {
    const S = A.S;
    const pane = el('paneEvents');
    if (!pane) return;
    const snap = S.snap;

    /* 【原地更新】两块骨架（项目列表 / 组别）都只建一次。
       原来每次收到数据就 clear(pane) —— 140 个项目、1.9 万节点全部重造，
       正在改的项目名会被冲掉、滚动位置也跳。 */
    let box = pane.querySelector('[data-part="evlist"]');
    let list = null;
    if (!box) {
      clear(pane);
      box = h('div', { class: 'box', 'data-part': 'evlist' });
      box.appendChild(h('div', { class: 'box-head' }, [
        h('div', { class: 'box-title', text: '赛程与项目' }),
        h('div', { class: 'box-note', text: '项目状态**全靠人工**：在录入页或下面每行的状态按钮里切换（不再按时间自动开始）' }),
        h('span', { class: 'grow', style: { flex: '1 1 auto' } }),
        /* 【「全部按时间归位」按钮已按用户要求去掉】
           它做的是一次性重算：拿各项目的起止时刻，把手动切过的状态重新算一遍。
           现在界面上不再出现任何与项目时间有关的东西，所以这个入口也一并撤了。
           后端 `event.autoAll` 操作**保留**（还在 ops.js 里，测试也还在跑），
           哪天真需要了，加回这一行按钮就能用：
             h('button', { class: 'btn btn-sm', type: 'button', text: '全部按时间归位', … }) */
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '新增项目', onclick: () => editEvent(null) }),
      ]));
      list = h('div', { class: 'box-body flush', 'data-part': 'evrows' });
      box.appendChild(list);
      pane.appendChild(box);
    } else {
      list = box.querySelector('[data-part="evrows"]');
    }

    const events = (snap.events || []).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
    const items = events.length ? events : [{ __empty: true, id: '__empty' }];
    App.dom.reconcile(list, items, ev => (ev.__empty ? '__empty' : 'e:' + ev.id), (ev, node) => {
      if (ev.__empty) {
        if (!node) node = h('div', { class: 'empty' });
        App.dom.setText(node, '还没有项目。点右上角「新增项目」开始编排赛程。');
        return node;
      }
      if (!node) return eventRow(ev, events.indexOf(ev), events.length);
      return updateEventRow(node, ev, events.indexOf(ev));
    });

    /* 组别管理 */

    let gbox = pane.querySelector('[data-part="groups"]');
    let gbody = null;
    if (!gbox) {
      gbox = h('div', { class: 'box', 'data-part': 'groups' });
      gbox.appendChild(h('div', { class: 'box-head' }, [
        h('div', { class: 'box-title', text: '组别' }),
        h('div', { class: 'box-note', text: '项目与运动员都归属于某个组别（通常是男子组 / 女子组）' }),
        h('span', { style: { flex: '1 1 auto' } }),
        h('button', { class: 'btn btn-sm', type: 'button', text: '加组别', onclick: () => addGroup() }),
      ]));
      gbody = h('div', { class: 'box-body', 'data-part': 'grows' });
      gbox.appendChild(gbody);
      pane.appendChild(gbox);
    } else {
      gbody = gbox.querySelector('[data-part="grows"]');
    }

    const groups = snap.groups || [];
    App.dom.reconcile(gbody, groups, g => 'g:' + g.id, (g, node) => {
      /* 人数用快照里带的 athleteCount（第 3 趟改造后快照里不再有完整名单）。
         老快照保留一条回退路径，免得部署到一半时页面显示 0。 */
      const n = g.athleteCount !== undefined
        ? g.athleteCount
        : (snap.athletes || []).filter(a => a.groupId === g.id).length;
      const ne = (snap.events || []).filter(e => e.groupId === g.id).length;
      if (!node) {
        const nmInput = h('input', { class: 'input input-editable', style: { width: 'min(140px, 100%)' } });
        A.bindEditable(nmInput, {
          value: g.name,
          onCommit: (v) => { A.setLocal('group', g.id, 'name', v); A.cmd('group.update', { id: g.id, name: v }).then(() => A.refresh()); },
        });
        node = h('div', { class: 'ev-row' }, [
          h('div', { class: 'grow', style: { flex: '0 1 auto' } }, [nmInput]),
          h('span', { class: 'pill pill-dim' }),
          h('span', { class: 'box-note', 'data-cell': 'cnt' }),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', {
            class: 'btn btn-sm btn-ghost', type: 'button', text: '删除',
            onclick: () => {
              // 按 id 现查（行会被复用，不能闭包住建行时的 g）
              const cur = (A.S.snap.groups || []).find(x => x.id === node.getAttribute('data-group'));
              if (!cur) return;
              A.ask({ title: '删除组别', text: '只有组别下面没有运动员和项目时才能删除。', okText: '删除', danger: true })
                .then((r) => { if (r.ok) A.cmd('group.del', { id: cur.id }).then(() => A.refresh()); });
            },
          }),
        ]);
        node.setAttribute('data-group', g.id);
      }
      const pill = node.querySelector('.pill');
      App.dom.setText(pill, g.kind === 'male' ? '男' : g.kind === 'female' ? '女' : '混合');
      App.dom.setText(node.querySelector('[data-cell="cnt"]'), '运动员 ' + n + ' 名 · 项目 ' + ne + ' 个');
      return node;
    });
  }

  /** 「加组别」弹窗（抽出来是因为按钮现在在骨架里、只绑一次） */
  function addGroup() {
    A.ask({ title: '新增组别', text: '例如：男子组 / 女子组 / 混合组', input: true });
    const field = el('askField');
    const modal = el('askModal');
    const input = h('input', { class: 'input', placeholder: '组别名称' });
    el('askTitle').textContent = '新增组别';
    el('askText').textContent = '加了之后是暂存状态，确认后才生效。';
    field.hidden = false;
    clear(field);
    field.appendChild(input);
    el('askOk').textContent = '添加';
    el('askOk').className = 'btn btn-primary';
    modal.hidden = false;
    const finish = () => {
      modal.hidden = true;
      el('askOk').onclick = null; el('askCancel').onclick = null; el('askClose').onclick = null;
      clear(field); field.hidden = true;
      field.appendChild(h('span', { class: 'label', id: 'askLabel' }));
      field.appendChild(h('input', { class: 'input', id: 'askInput', type: 'text', autocomplete: 'off' }));
    };
    el('askCancel').onclick = finish;
    el('askClose').onclick = finish;
    el('askOk').onclick = () => {
      if (!input.value.trim()) { A.toast('组别名不能为空', 'warn'); return; }
      A.cmd('group.add', { name: input.value.trim() }).then(() => { finish(); A.refresh(); });
    };
  }

  /**
   * 一个项目行。
   * 【为什么要"建一次 + 原地更新"分两步】这一页有 140 个项目、1.9 万节点，
   * 原来每次收到数据就 clear(pane) 全重建 —— 正在改的项目名会被冲掉、
   * 滚动位置也跳。
   *
   * 行内的 pill（状态/田赛径赛/预赛决赛/接力/手动自动…）大约 15 个，
   * 逐个原地更新太啰嗦且容易漏，所以**元信息区整块重建**（它里面没有输入框，
   * 重建无副作用），但**行节点本身、姓名输入框、按钮都保留**。
   * 这是"够用就好"的取舍：保住输入框和滚动位置，就是现场感受得到的那部分。
   */
  function eventRow(ev, index, total) {
    const S = A.S;
    const row = h('div', { class: 'ev-row' });
    row.setAttribute('data-event', ev.id);

    row.appendChild(h('div', { class: 'idx' }));

    const nameInput = h('input', { class: 'input input-editable', style: { width: '100%', maxWidth: '320px' } });
    A.bindEditable(nameInput, {
      value: ev.name,
      onCommit: (v) => { A.setLocal('event', ev.id, 'name', v); A.cmd('event.update', { id: ev.id, name: v }).then(() => A.refresh()); },
    });

    const meta = h('div', { class: 'meta' });
    const grow = h('div', { class: 'grow' }, [nameInput, meta]);
    row.appendChild(grow);
    row.appendChild(h('div', { class: 'acts' }));

    bindEventRow(row);
    updateEventRow(row, ev, index);
    void total;
    return row;
  }

  /** 行上按钮的事件（只绑一次；回调按行上的 data-event 现查当前数据） */
  function bindEventRow(row) {
    row.querySelector('.acts').addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      actOnEvent(row, btn.dataset.act);
    });
  }

  /** 从当前快照里按 id 找项目（**不要用建行时的闭包 ev**：行会被复用） */
  function eventById(id) {
    const list = (A.S.snap && A.S.snap.events) || [];
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function actOnEvent(row, act) {
    const id = row.getAttribute('data-event');
    const ev = eventById(id);
    if (!ev) return;
    if (act === 'entry') return A.entryJump(ev.id);
    if (act === 'edit') return editEvent(ev);
    if (act === 'status') {
      const p = ev.status === 'done'
        ? App.op('event.statusAuto', { id: ev.id })
        : App.op('event.status', { id: ev.id, status: 'done' });
      p.then((r) => { if (!r.ok) A.toast(r.error || '操作失败', 'bad'); else A.refresh(); });
      return;
    }
    if (act === 'up' || act === 'down') {
      App.op('event.move', { id: ev.id, dir: act }).then(() => A.refresh());
      return;
    }
    if (act === 'del') {
      A.ask({
        title: '删除项目',
        text: '将删除「' + ev.name + '」及其名单与成绩（已录 ' + ev.recorded + ' 条）。'
          + (ev.finalName ? '\n注意：它已生成决赛，删除会一并影响决赛的关联。' : ''),
        okText: '删除', danger: true,
      }).then((r) => {
        if (!r.ok) return;
        A.cmd('event.del', { id: ev.id, force: true }).then(() => A.refresh());
      });
      return;
    }
    if (act === 'final') {
      /* 【手动录取决赛】系统只做"建出决赛项目 + 按预赛名次预填一份起点名单"，
         最终谁进决赛由老师在「名单」页增删 —— 现场常有例外
         （有人预赛完就走了、有人要换接力棒次），自动定死反而更慢。
         注意：以前这里调的是 `event.final`，**后端没有这个操作**，
         点了一直是"未知操作"——这次一并修掉了。 */
      const n = ev.advanceCount || 6;
      A.ask({
        title: ev.finalName ? '重做决赛' : '录取决赛',
        text: ev.finalName
          ? ('已经有一个决赛「' + ev.finalName + '」了。\n'
            + '重做会**删掉那个决赛**并重新生成（它还没录成绩才行）。\n'
            + '新决赛的名单仍按现在的预赛名次预填前 ' + n + ' 名。')
          : ('将生成决赛项目「' + String(ev.name).replace(/预赛/g, '决赛') + '」，\n'
            + '名单先按现在的预赛名次**预填前 ' + n + ' 名**（并列跨线的一起进）。\n\n'
            + '这只是起点 —— 建好后到「名单」页把不该进的删掉、该进的补上就行。'),
        okText: ev.finalName ? '重做' : '生成决赛',
        danger: !!ev.finalName,
      }).then((r) => {
        if (!r.ok) return;
        A.cmd('event.makeFinal', { eventId: ev.id, force: !!ev.finalName }).then((res) => {
          // 失败时 A.cmd 已经弹过 toast 了（带服务端的原话，比如"已经录了 N 条成绩"）
          if (res.failed) return;
          const dd = res.data || {};
          A.toast('已生成决赛「' + (dd.finalName || '') + '」，预填 ' + (dd.qualified || 0)
            + ' 人' + (dd.note ? ('（' + dd.note + '）') : '')
            + '。名单请到「名单」页确认后增删。', 'ok', 7000);
          A.refresh();
        });
      });
      return;
    }
  }

  /** 原地更新一行：序号、姓名框、状态与操作按钮 */
  function updateEventRow(row, ev, index) {
    App.dom.setText(row.querySelector('.idx'), String(index + 1));
    const nameInput = row.querySelector('input.input-editable');
    // 只在"不是正在输入的那个框"时才回写，否则会冲掉用户正在改的名字
    if (nameInput && document.activeElement !== nameInput && nameInput.value !== ev.name) {
      nameInput.value = ev.name == null ? '' : String(ev.name);
      nameInput.dataset.last = nameInput.value;
    }

    // 元信息区整块重建（里面没有输入框，重建无副作用）
    const meta = row.querySelector('.meta');
    clear(meta);
    const stText = statusText(ev.status);
    /* 【项目行不再显示时刻】按用户要求，项目上任何地方都不显示时间标签。
       时刻仍然**存着**（数据库里 94 个项目有真实开赛时刻），
       详细设置里也还能填 —— 只是不再印在项目行上。
       留着它的唯一用处是"同刻并列时排在前面"，那个在下面 pill 里不体现。 */
    [
      h('span', { class: 'pill pill-dim', text: ev.groupName }),
      h('span', { class: 'pill ' + (ev.kind === 'field' ? 'pill-auto' : 'pill-dim'), text: ev.kind === 'field' ? '田赛（大者优先）' : '径赛（小者优先）' }),
      h('span', { class: 'pill ' + (ev.stage === 'heat' ? 'pill-auto' : 'pill-dim'), text: ev.stage === 'heat' ? '预赛' : '决赛' }),
      ev.isRelay ? h('span', { class: 'pill pill-ok', text: '接力 ' + (ev.relayLegs || 4) + ' 人（按班级排名）' }) : null,
      ev.attempts > 1 ? h('span', { class: 'pill pill-dim', text: '记 ' + ev.attempts + ' 次试跳' }) : null,
      /* 【这个 pill 的语义变了】原来显示"按时间自动"，因为有个定时器会到点自动改状态。
         现在**没有定时器了**，状态全靠人工（或检录结果），所以"按时间自动"这个说法会误导。
         改成只区分"这个状态是不是人手动锁过"。
         （statusMode 这个字段还留着，因为它就是"是否手动锁定"的意思，用起来仍准确。） */
      h('span', { class: 'pill ' + (ev.statusMode === 'auto' ? 'pill-dim' : 'pill-manual'),
        text: ev.statusMode === 'auto' ? '状态可重算' : '状态已手动锁定' }),
      h('span', { class: 'pill ' + toneClass(statusTone(ev.status)), text: stText }),
      h('span', { class: 'box-note', text: '名单 ' + ev.regCount + ' 人 · 已录 ' + ev.recorded }),
      ev.venue ? h('span', { class: 'box-note', text: ev.venue }) : null,
      ev.advanceFromName ? h('span', { class: 'pill pill-auto', text: '由「' + ev.advanceFromName + '」录取' }) : null,
      ev.finalName ? h('span', { class: 'pill pill-ok', text: '已生成决赛：' + ev.finalName }) : null,
      ev.checkinOpen ? h('span', { class: 'pill pill-warn', text: '检录中 ' + ev.arrived + '/' + ev.regCount }) : null,
      ev.topRows && ev.topRows.length
        ? h('span', { class: 'box-note', text: '前三：' + ev.topRows.map(r => r.rank + ' ' + r.name + ' ' + r.display).join('　') })
        : null,
    ].forEach(n => { if (n) meta.appendChild(n); });

    // 操作区：内容随状态变，整块重建（按钮用的是委托，重建不影响点击）
    const acts = row.querySelector('.acts');
    clear(acts);
    acts.appendChild(h('button', {
      class: 'btn btn-sm btn-primary', type: 'button', 'data-act': 'entry',
      text: '名单/录入', title: '跳到「成绩录入」并选中这个项目',
    }));
    acts.appendChild(h('button', {
      class: 'btn btn-sm', type: 'button', 'data-act': 'status',
      /* 措辞跟着改：不再有"自动开始"，所以"恢复自动"这个说法会让人以为
         "放着不管它自己会开始"。现在它就是"按时间重算一次"。 */
      text: ev.status === 'done' ? '按时间重算' : '标记已结束',
      title: ev.status === 'done' ? '按这个项目的起止时间重新算一次状态' : '手动标记为已结束（会锁定为手动）',
    }));
    acts.appendChild(h('button', {
      class: 'btn btn-sm', type: 'button', 'data-act': 'edit', text: '详细设置',
    }));
    if (ev.stage === 'heat') {
      acts.appendChild(h('button', {
        class: 'btn btn-sm', type: 'button', 'data-act': 'final',
        text: ev.finalName ? '重做决赛' : '录取决赛',
        title: '生成决赛项目；名单先按预赛名次预填前 ' + (ev.advanceCount || 6) + ' 名，之后由你增删',
      }));
    }
    acts.appendChild(h('button', {
      class: 'btn btn-sm btn-ghost', type: 'button', 'data-act': 'up', text: '↑', title: '上移',
    }));
    acts.appendChild(h('button', {
      class: 'btn btn-sm btn-ghost', type: 'button', 'data-act': 'down', text: '↓', title: '下移',
    }));
    acts.appendChild(h('button', {
      class: 'btn btn-sm btn-ghost', type: 'button', 'data-act': 'del', text: '删', title: '删除项目',
    }));
  }

  /* ── 新增 / 详细设置 ─────────────────────────────────────────────────── */

  function editEvent(ev) {
    const S = A.S;
    const snap = S.snap;
    const isNew = !ev;
    const base = ev || {
      id: '', name: '', groupId: (snap.groups[0] || {}).id, kind: 'track', stage: 'final',
      isRelay: false, relayLegs: 4, attempts: 1, tol: 0.01, advanceCount: 6, sort: 0,
      venue: '', unit: '', startAt: null, endAt: null, day: 1,
    };

    const name = h('input', { class: 'input', value: base.name, placeholder: '如：男子 100 米决赛' });
    const group = h('select', { class: 'select' });
    (snap.groups || []).forEach(g => group.appendChild(h('option', { value: g.id, text: g.name })));
    group.value = base.groupId;

    const kind = h('select', { class: 'select' }, [
      h('option', { value: 'track', text: '径赛（成绩越小越靠前）' }),
      h('option', { value: 'field', text: '田赛（成绩越大越靠前）' }),
    ]);
    kind.value = base.kind;

    const stage = h('select', { class: 'select' }, [
      h('option', { value: 'final', text: '决赛（直接出成绩）' }),
      h('option', { value: 'heat', text: '预赛（可录取出决赛）' }),
    ]);
    stage.value = base.stage;

    const isRelay = h('input', { type: 'checkbox' });
    isRelay.checked = !!base.isRelay;
    const relayLegs = h('input', { class: 'input', type: 'number', min: '2', max: '8', value: String(base.relayLegs || 4), style: { width: 'min(80px, 100%)' } });

    const attempts = h('input', { class: 'input', type: 'number', min: '1', max: '10', value: String(base.attempts || 1), style: { width: 'min(80px, 100%)' } });
    /* 【并列按计时精度判，不是一个"容差数值"】
       原来是让老师填一个 0.01 这样的数，还写着"相差不超过这个值就算并列" ——
       那是把**浮点误差容忍值**当成了竞赛规则，会出现
       "12.01 和 12.02 并列第 1"这种事（两个不同的成绩）。
       现在改成选**这个项目量到什么精度**，判等就是"显示出来的读数是否相同"：
       百分位下 12.34 只和 12.34 并列；千分位下 12.341 和 12.342 是两个人。 */
    const tol = h('select', { class: 'select', style: { width: 'min(260px, 100%)' } });
    App.precision.PRESETS.forEach((v) => {
      tol.appendChild(h('option', { value: String(v), text: App.precision.LABEL[v] }));
    });
    // 田赛的量具精度是 1 厘米，径赛通常电子计时到百分位
    const tolHint = h('span', { class: 'hint' });
    function tolValue() { return App.precision.norm(base.tol, kind.value); }
    tol.value = String(tolValue());
    function syncTolHint() {
      const t = App.precision.norm(Number(tol.value), kind.value);
      tolHint.textContent = kind.value === 'field'
        ? '田赛按量到的厘米数判：' + App.precision.decimals(t === 0.001 ? 0.001 : 0.01)
          + ' 位小数读数相同的算并列（一般用百分位）'
        : '读数相同的算并列；并列后名次跳号（1、2、2、4）';
    }
    tol.addEventListener('change', syncTolHint);
    syncTolHint();
    const advanceCount = h('input', { class: 'input', type: 'number', min: '1', max: '20', value: String(base.advanceCount || 6), style: { width: 'min(80px, 100%)' } });
    const venue = h('input', { class: 'input', value: base.venue || '', placeholder: '如：田径场 / 田赛区 A' });
    /* 【开始/结束时刻的输入框已按用户要求去掉】
       界面上不再出现任何与项目时间有关的东西（列表、打印单、大屏、本弹窗都去掉了）。

       ⚠ 但**数据库里的时刻不能丢**：赛程的显示顺序（`sort`）和部分排序仍会用到它，
         库里 94 个项目存着真实开赛时刻。所以：
           · 不提交 startAt / endAt（见下面 payload 里的说明）→ 服务端保持原值不变
           · 一旦提交成空值，项目的时刻就被清零了，排序会跟着乱
       想改某个项目的时刻，目前只能改库（`UPDATE event SET startAt='07:40' WHERE …`）。 */

    // 田赛才允许多次试跳；径赛固定一次
    function syncKind() {
      const field = kind.value === 'field';
      attempts.disabled = !field;
      if (!field) attempts.value = '1';
    }
    kind.addEventListener('change', syncKind);
    syncKind();

    // 报错显示区（服务端拒绝时把原因留在弹窗里，不丢已填内容）
    const errBox = h('div', { class: 'ask-text', style: { color: 'var(--red, #d24b3e)', display: 'none' } });
    const showErr = (msg) => { errBox.textContent = msg || ''; errBox.style.display = msg ? '' : 'none'; };

    const body = h('div', { class: 'form-grid' }, [
      h('label', { class: 'field field-wide' }, [h('span', { class: 'label', text: '项目名称' }), name]),
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '组别' }), group]),
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '类型' }), kind]),
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '阶段' }), stage]),
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '场地' }), venue]),
      /* 「开始时刻」「结束时刻」两栏已去掉（见上面那段说明）。 */
      h('label', { class: 'field' }, [
        h('span', { class: 'label', text: '计时/计量精度（决定什么算并列）' }), tol, tolHint,
      ]),
      h('label', { class: 'field' }, [
        h('span', { class: 'label', text: '预赛录取人数（进决赛）' }), advanceCount,
        h('span', { class: 'hint', text: '点赛程里的「录取决赛」时，预填这么多名（之后可增删）' }),
      ]),
      h('label', { class: 'field' }, [
        h('span', { class: 'label', text: '田赛试跳次数' }), attempts,
        h('span', { class: 'hint', text: '3 表示每次试跳各填一格，名次取最好的一次（径赛固定 1 次）' }),
      ]),
      h('label', { class: 'field' }, [
        h('span', { class: 'label', text: '接力项目' }),
        h('span', { class: 'chk' }, [isRelay, h('span', { text: '是接力（按班级排名，并显示参赛队员）' })]),
      ]),
      h('label', { class: 'field' }, [
        h('span', { class: 'label', text: '接力棒数 / 每队人数' }), relayLegs,
      ]),
      errBox,
    ]);

    const modal = el('askModal');
    el('askModal').querySelector('.modal-box').classList.add('wide');
    el('askTitle').textContent = isNew ? '新增项目' : ('设置：' + base.name);
    el('askText').textContent = isNew
      ? '新建后是暂存状态，确认后才正式生效。'
      : '改完后是暂存状态，点右上角「确认并推送大屏」才正式生效。';
    const field = el('askField');
    field.hidden = false;
    clear(field);
    field.appendChild(body);
    el('askOk').textContent = isNew ? '新增' : '保存改动';
    el('askOk').className = 'btn btn-primary';
    modal.hidden = false;
    showErr('');
    setTimeout(() => name.focus(), 40);

    const finish = () => {
      modal.hidden = true;
      el('askModal').querySelector('.modal-box').classList.remove('wide');
      el('askOk').onclick = null; el('askCancel').onclick = null; el('askClose').onclick = null;
      clear(field); field.hidden = true;
      field.appendChild(h('span', { class: 'label', id: 'askLabel' }));
      field.appendChild(h('input', { class: 'input', id: 'askInput', type: 'text', autocomplete: 'off' }));
    };
    el('askCancel').onclick = finish;
    el('askClose').onclick = finish;
    el('askOk').onclick = () => {
      if (!name.value.trim()) { A.toast('项目名称不能为空', 'warn'); return; }
      const payload = {
        name: name.value.trim(), groupId: group.value, kind: kind.value, stage: stage.value,
        isRelay: isRelay.checked, relayLegs: Number(relayLegs.value) || 4,
        attempts: Number(attempts.value) || 1,
        // 精度档位要规格化后再提交（下拉里是固定四档，这里再兜一道底）
        tol: App.precision.norm(Number(tol.value), kind.value),
        advanceCount: Number(advanceCount.value) || 6,
        venue: venue.value.trim(),
        /* 【绝对不要在这里提交 startAt / endAt】
           界面上已经没有时刻输入框了，提交就等于把值写成空 ——
           而 event.update 走的是 normalizeEventFields，它把"没传"当成"保持原值"、
           把"传了空"当成"清空"。一旦提交空串，库里那 94 个项目的真实开赛时刻
           会被**一次性清零**，赛程排序跟着乱。
           这里**整段不写**这两个字段，服务端就原样保留。
           （原来的写法 `startAt: App.fromClock(startAt.value)` 在输入框被删掉后
             会直接 ReferenceError —— 因为 startAt 这个变量已经不存在了。） */
      };
      if (!isNew) payload.id = ev.id;
      A.cmd(isNew ? 'event.add' : 'event.update', payload).then((res) => {
        /* 【失败时不要关弹窗】原来这里无条件 finish() —— 服务端拒绝（比如
           同名、名字为空）之后，老师刚填的一整屏内容全丢了，得从头再填一遍。
           现在失败就把原因显示在弹窗里，留着已填内容让人改。 */
        if (res && res.failed) { showErr(res.error || '保存失败'); return; }
        finish();
        A.refresh();
      });
    };

    /* 接力项目：队伍与队员都在「名单」页的「接力队伍」那块管
       （新建 / 填改队员 / 按班级补齐 / 删队）。
       ⚠ 这段说明以前**指向不存在的按钮** —— 写着"到名单页点「队员」或「按班级自动补齐」"，
         而那两个按钮当时根本没做出来（名单页把接力显式排除在个人报名之外，
         全前端也没有调用 reg.legs 的地方）。现在真做出来了，说明也跟着改成实话。 */
    if (!isNew && base.isRelay) {
      const relayBox = h('div', { class: 'box', style: { marginTop: '12px' } });
      relayBox.appendChild(h('div', { class: 'box-head' }, [
        h('div', { class: 'box-title', text: '接力队伍怎么建' }),
      ]));
      const rb = h('div', { class: 'box-body' });
      rb.appendChild(h('div', {
        class: 'hint',
        text: '接力按班级成队，一队一条成绩；队员姓名在大屏上用**小字**显示在班级名下面。'
          + '做法：到「运动员名单」页最上面那块「接力队伍」→ 点「添加队伍」选班级建队'
          + '（队名会自动填成班级名，勾上"自动补齐"就取本班号码最靠前的 '
          + (base.relayLegs || 4) + ' 人）；之后每队可「填改队员」或「按班级补齐」。'
          + '建好是暂存状态，点右上角「确认并推送」才正式生效。',
      }));
      relayBox.appendChild(rb);
      body.appendChild(relayBox);
    }
  }

  A.register('events', render);
})();
