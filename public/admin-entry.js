/* ============================================================================
 * admin-entry.js —— 后台「成绩录入」页签（默认首页）
 *
 * 布局参照学校录入后台：
 *   左：项目列表，按"进行中 / 未开始 / 已结束"分组，点一下切换
 *   右：项目标题 + 状态按钮 + 进度条 + 录入表（按班级分块）
 *       每行：名次 / 姓名 / 班级 / 成绩输入框 / 清空
 *
 * 录入行为与现场口径一致：
 *   · 输入框**失焦即提交**（不用找保存按钮）；回车也提交并跳到下一个空框
 *   · 田赛多次试跳：一行里并排几个小输入框
 *   · 填「弃权」标记弃权；**清空输入框 = 删除这条成绩**
 * ========================================================================== */
'use strict';

(function () {
  const A = window.Admin;
  const h = A.h, el = A.el, clear = A.clear;
  const App = window.App;

  const S = {
    eventId: '',
    search: '',
    onlyEmpty: false,
    /** 左列表的"找项目"关键词（只过滤列表，不影响右边录入区） */
    evSearch: '',
    drafts: {},        // regId#attempt → 正在输入的原样文本
    versions: {},      // regId#attempt → 服务器版本（乐观锁）
    lastSaved: {},     // regId#attempt → 上次提交成功的值
  };
  const KEY = (regId, at) => regId + '#' + at;

  /** 调试用：把焦点丢失的调用栈记下来（在开发者工具里敲 A.entry.focusLog 看） */
  const focusLog = [];
  document.addEventListener('focusout', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('score-input')) {
      focusLog.push({
        at: new Date().toISOString(),
        from: t.dataset.regId + '#' + t.dataset.attempt,
        to: e.relatedTarget ? (e.relatedTarget.tagName + '.' + e.relatedTarget.className) : '(null)',
        stack: String(new Error().stack || '').split('\n').slice(1, 6).join(' ← '),
      });
      if (focusLog.length > 30) focusLog.shift();
    }
  }, true);

  /* ── 渲染 ────────────────────────────────────────────────────────────── */

  /**
   * 整页重画（切页签、数据变化时用）。
   *
   * 【滚动位置保护】整块 clear + 重建会让浏览器把滚动位置丢掉：
   *   · 左列表（.ev-list 自己会滚）会跳回第一条
   *   · 整页也会跳回顶部
   * 现场录成绩时这最烦（140 个项目，点一下就得重新滚），所以重建前后
   * 把两处滚动位置都记下来再还原；顺带让"当前项目"始终留在可见范围内。
   */
  function render() {
    const pane = el('paneEntry');
    if (!pane || !A.S.snap) return;
    const snap = A.S.snap;
    const events = (snap.events || []).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));

    if (!events.length) {
      clear(pane);
      pane.appendChild(h('div', { class: 'box' }, [
        h('div', { class: 'box-body' }, [
          h('div', { class: 'empty', text: '还没有项目。到「赛程编排」页签里添加项目。' }),
        ]),
      ]));
      return;
    }
    if (!S.eventId || !events.some(e => e.id === S.eventId)) S.eventId = pickDefault(events);

    // 记下重建前的滚动位置
    const oldList = pane.querySelector('.ev-list');
    const listTop = oldList ? oldList.scrollTop : 0;
    const pageTop = window.scrollY || document.documentElement.scrollTop || 0;

    /* 【原地更新】整个页签的骨架只建一次。
       原来这里 clear(pane) 把"左项目列表（140 项）+ 右录入面板"整个重建 ——
       每录一条成绩都重建 140 个按钮加整张表，输入焦点、草稿、滚动位置全丢。
       现在：布局、项目列表、录入面板都留着，只把数据对齐进去。 */
    let layout = pane.querySelector('.entry-layout');
    let listBox = layout ? layout.querySelector('[data-part="list"]') : null;
    let panelBox = layout ? layout.querySelector('[data-part="panel"]') : null;

    if (!layout || !listBox || !panelBox) {
      clear(pane);
      layout = h('div', { class: 'entry-layout' });
      listBox = projectList(events);
      panelBox = entryPanel(events.find(e => e.id === S.eventId));
      // 标出来，下一轮才能找到它们做原地更新
      listBox.setAttribute('data-part', 'list');
      panelBox.setAttribute('data-part', 'panel');
      layout.appendChild(listBox);
      layout.appendChild(panelBox);
      pane.appendChild(layout);
    } else {
      if (listBox.__paintList) listBox.__paintList(events);
      if (panelBox.__paintPanel) panelBox.__paintPanel(events.find(e => e.id === S.eventId));
    }

    const ev = events.find(e => e.id === S.eventId);
    // 注意顺序：必须等整块**插入 DOM 之后**再加载名单。
    // 在 entryPanel() 里加载会拿到 null —— 那时 #entryTable 只是刚创建、
    // 还没挂到 document 上，getElementById 找不到（这个坑真踩过）。
    if (ev) loadBoard(ev);

    // 还原滚动位置（下一帧再设：等刚插入的内容完成布局才生效）
    requestAnimationFrame(() => restoreScroll(listTop, pageTop));
  }

  /**
   * 把左侧列表与整页的滚动位置还原回去。
   *
   * 两个坑：
   *   ① 还原整页位置前必须**先强制一次布局**。右面板换项目后表格会变矮，
   *      浏览器随即把 scrollY 夹到新的最大值（实测从 260 掉到 118）。
   *      如果这时立刻 scrollTo(0,260)，因为文档还没重排，260 仍然超出范围、会被再夹一次。
   *      读一次 scrollHeight 触发重排，再设就稳了。
   *   ② 不要在这里调 keepSelectedVisible —— 用户滚到中间时，选中项常常只露出一半，
   *      "强制露全"会自己把列表推动十几像素（实测 -16px）。还原位置优先，
   *      选中项的可见性只在**首次渲染**时才需要照顾。
   */
  function restoreScroll(listTop, pageTop) {
    const pane = el('paneEntry');
    const list = pane ? pane.querySelector('.ev-list') : null;
    if (list && listTop) list.scrollTop = listTop;
    if (pageTop) {
      void document.documentElement.scrollHeight;      // 强制重排，拿到新的可滚动范围
      window.scrollTo(0, pageTop);
      void document.documentElement.scrollHeight;
      if (Math.abs((window.scrollY || 0) - pageTop) > 2) window.scrollTo(0, pageTop);
    }
  }

  /** 让"当前选中"的项目留在列表可见范围内（本来就看得见就不动它） */
  function keepSelectedVisible(list) {
    const on = list.querySelector('.ev-pick.is-on');
    if (!on) return;
    const lr = list.getBoundingClientRect();
    const br = on.getBoundingClientRect();
    if (br.top < lr.top) list.scrollTop -= (lr.top - br.top) + 8;
    else if (br.bottom > lr.bottom) list.scrollTop += (br.bottom - lr.bottom) + 8;
  }

  /**
   * 只切换右侧录入区 —— **不重建左侧列表**。
   *
   * 这是"点一下总是跳到最上面"的根治办法：以前每次点击都 clear(pane) 整块重建，
   * 左侧列表（自己会滚）与整页的滚动位置都会被丢掉。
   * 现在左边只改高亮、右边换内容，滚动位置天然不动。
   */
  function selectEvent(id, btn) {
    if (!id || id === S.eventId) return;
    S.eventId = id;

    // 只改左列表的高亮（不重建）
    const pane = el('paneEntry');
    if (pane) {
      Array.prototype.forEach.call(pane.querySelectorAll('.ev-pick'), (b) => {
        b.classList.toggle('is-on', b.dataset.eventId === id);
      });
      if (btn && btn.blur) btn.blur();      // 去掉按钮聚焦框
    }

    // 换右侧面板
    const layout = pane ? pane.querySelector('.entry-layout') : null;
    const old = el('entryBox');
    const ev = (A.S.snap.events || []).find(e => e.id === id);
    if (layout && old && ev) {
      const pageTop = window.scrollY || 0;
      const list = pane.querySelector('.ev-list');
      const listTop = list ? list.scrollTop : 0;
      // 量**替换之前**的表格高度：新面板刚插进来时里面只是"正在读取名单…"，
      // 那时再量就只有几十像素，挡不住页面变矮（踩过这个坑）。
      const t = el('entryTable');
      const floorH = t ? t.getBoundingClientRect().height : 0;
      layout.replaceChild(entryPanel(ev), old);
      loadBoard(ev, floorH);
      requestAnimationFrame(() => restoreScroll(listTop, pageTop));
    } else {
      render();                             // 兜底：结构不完整时走整页重画
    }
  }

  /** 默认选中：进行中的第一个，其次检录中，再次未开始，最后已结束 */
  function pickDefault(events) {
    const order = ['live', 'checking', 'pending'];
    for (const st of order) {
      const hit = events.find(e => e.status === st);
      if (hit) return hit.id;
    }
    return events[events.length - 1].id;
  }

  /* ── 左：项目列表 ────────────────────────────────────────────────────── */

  /**
   * 项目列表。
   *
   * 【为什么要搜索框】一共 140 个项目，虽然按"进行中/检录中/未开始/已结束"分了组，
   * 但"未开始"里就有 140 个 —— 现场找"高二女子800米"要滚半天。
   * 搜索框只过滤这个列表，不影响右边录入区。
   */
  function projectList(events) {
    const box = h('div', { class: 'box' });
    box.appendChild(h('div', { class: 'box-head' }, [
      h('div', { class: 'box-title', text: '比赛项目' }),
      h('div', { class: 'box-note', text: '点项目切换' }),
    ]));

    // 搜索框放在列表上方（吸在列表顶部，滚列表时也看得到）
    const searchWrap = h('div', { class: 'ev-search' });
    const search = h('input', {
      class: 'input', type: 'search', placeholder: '找项目：输入名字/组别，如 高二 800',
      autocomplete: 'off', value: S.evSearch || '',
    });
    searchWrap.appendChild(search);
    const clearBtn = h('button', {
      class: 'ev-search-clear', type: 'button', text: '×',
      title: '清空', hidden: !S.evSearch,
    });
    searchWrap.appendChild(clearBtn);
    box.appendChild(searchWrap);

    const list = h('div', { class: 'ev-list' });
    const countNote = h('div', { class: 'ev-search-count' });
    box.appendChild(countNote);

    const body = h('div', { class: 'box-body flush' });
    body.appendChild(list);
    box.appendChild(body);

    // 分组顺序 = 现场关心的顺序：正在进行的在最上面，检录中的次之
    const groups = [
      { key: 'live', label: '进行中', cls: 'live' },
      { key: 'checking', label: '检录中', cls: 'checking' },
      { key: 'pending', label: '未开始', cls: '' },
      { key: 'done', label: '已结束', cls: 'done' },
    ];

    /* 点项目：用**事件委托**挂在 list 上，不给每个按钮单独绑。
       原因：列表现在是"原地更新"的、按钮会被复用 ——
       若每个按钮各绑一个 onclick（闭包里关着建按钮时的那个 e），
       复用后点它会切到**旧的那个项目**。委托只绑一次，永远读当前的 dataset。 */
    list.addEventListener('click', (evt) => {
      const btn = evt.target && evt.target.closest ? evt.target.closest('.ev-pick') : null;
      if (btn && btn.dataset.eventId) selectEvent(btn.dataset.eventId, btn);
    });

    /**
     * 把列表对齐到当前数据。
     * **原地更新**：同一个项目复用同一个按钮节点，只改文字与选中态。
     * 原来这里是 clear(list) 全删重建 —— 140 个项目每次推送重建 140 个按钮，
     * 而且列表滚动位置会丢。
     */
    let curEvents = events || [];
    function paint(nextEvents) {
      if (nextEvents) curEvents = nextEvents;
      const q = String(S.evSearch || '').trim().toLowerCase();
      const hit = (e) => {
        if (!q) return true;
        // 项目名里已经含组别与性别（如"高二组女子800米决赛"），
        // 所以直接搜名字就能覆盖"高二""女子""800""决赛"这些常见输入
        const hay = [e.name, e.groupName, e.stage === 'heat' ? '预赛' : '决赛',
          e.kind === 'field' ? '田赛' : '径赛', e.venue].join(' ').toLowerCase();
        // 空格分隔的多个词要全部命中（"高二 女子 800" 这种写法现场很自然）
        return q.split(/\s+/).every(w => hay.indexOf(w) >= 0);
      };

      // 摊平成"分组头 + 项目按钮"一串，交给 reconcile 按 key 对齐
      const flat = [];
      let shown = 0;
      groups.forEach((g) => {
        const items = curEvents.filter(e => e.status === g.key && hit(e));
        if (!items.length) return;
        shown += items.length;
        flat.push({ kind: 'head', key: 'h:' + g.key, label: g.label, n: items.length });
        items.forEach(e => flat.push({ kind: 'ev', key: 'e:' + e.id, ev: e, cls: g.cls }));
      });
      if (!shown) flat.push({ kind: 'empty', key: 'empty', text: '没有匹配的项目：' + S.evSearch });

      App.dom.reconcile(list, flat, it => it.key, (it, node) => {
        if (it.kind === 'head') {
          if (!node) {
            node = h('div', { class: 'ev-group-head' }, [
              h('span', { 'data-cell': 'label' }), h('span', { class: 'n' }),
            ]);
          }
          App.dom.setText(node.querySelector('[data-cell="label"]'), it.label);
          App.dom.setText(node.querySelector('.n'), '（' + it.n + '）');
          return node;
        }
        if (it.kind === 'empty') {
          if (!node) node = h('div', { class: 'empty' });
          App.dom.setText(node, it.text);
          return node;
        }
        if (!node) {
          /* 【项目选择列表不再带时刻】按用户要求去掉时间标签。
             原来这里还有个 `<span class="tm">07:40</span>`，现在只留状态点 + 名字。 */
          node = h('button', { class: 'ev-pick', type: 'button' }, [
            h('span', { class: 'dot' }),
            h('span', { class: 'nm' }),
          ]);
        }
        node.dataset.eventId = it.ev.id;
        App.dom.setClass(node, 'ev-pick' + (it.ev.id === S.eventId ? ' is-on' : ''));
        App.dom.setClass(node.querySelector('.dot'), 'dot ' + (it.cls || ''));
        App.dom.setText(node.querySelector('.nm'), it.ev.name || '');
        return node;
      });

      countNote.textContent = q
        ? ('匹配 ' + shown + ' / ' + curEvents.length + ' 个项目')
        : ('共 ' + curEvents.length + ' 个项目');
      clearBtn.hidden = !q;
    }

    search.addEventListener('input', () => {
      S.evSearch = search.value;
      paint();
    });
    // 键盘：回车跳到第一个匹配项（现场少点一次）；Esc 清空
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = list.querySelector('.ev-pick');
        if (first) selectEvent(first.dataset.eventId, first);
      } else if (e.key === 'Escape') {
        search.value = ''; S.evSearch = ''; paint();
      }
    });
    clearBtn.addEventListener('click', () => {
      search.value = ''; S.evSearch = ''; paint(); search.focus();
    });

    paint();
    box.__paintList = paint;          // 供 render() 原地更新列表用
    return box;
  }

  /* ── 右：录入区 ──────────────────────────────────────────────────────── */

  function entryPanel(ev) {
    const box = h('div', { class: 'box', id: 'entryBox' });
    const body = h('div', { class: 'box-body' });
    box.appendChild(body);

    /* 面板里#entryTable 那一块由 loadBoard/drawBoard 负责原地更新。
       所以**换项目时绝不能把整个 body 清掉** —— 清掉就等于把表格连根拔了，
       录入到一半的输入框、焦点、滚动位置全没（这是"每录一条闪一下"的真正来源，
       我第一版就是这么写的，靠浏览器里挂钩 clear() 打出调用栈才找到）。

       现在按"事件 id"判断：
         · 还是同一个项目 → 一个 DOM 都不动（数据更新交给 drawBoard）
         · 换到别的项目 → 重建头部/提示/工具条，表格换成新容器（内容由 drawBoard 填） */
    let curId = null;
    function paint(e) {
      if (e && e.id === curId) return;          // 同一个项目：什么都不用做
      curId = e ? e.id : null;
      clear(body);
      if (!e) {
        body.appendChild(h('div', { class: 'empty', text: '请选择项目' }));
        return;
      }
      body.appendChild(entryHead(e));
      body.appendChild(entryTip(e));
      body.appendChild(toolbar());
      body.appendChild(h('div', { id: 'entryTable' }, [h('div', { class: 'empty', text: '正在读取名单…' })]));
    }

    paint(ev);
    box.__paintPanel = paint;
    return box;
  }

  function entryHead(ev) {
    const wrap = h('div', { class: 'entry-head' });

    const info = h('div', {}, [
      h('div', { class: 'entry-title', text: ev.name }),
      h('div', { class: 'entry-info' }, [
        h('span', { text: (ev.groupName || '') + ' · ' + (ev.kind === 'field' ? '田赛（越大越靠前）' : '径赛（越小越靠前）') }),
        h('br'),
        h('span', {}, [
          /* 不显示时刻了（按用户要求去掉时间标签）；场地与状态照旧 */
          document.createTextNode(ev.venue ? ('场地：' + ev.venue + '　') : ''),
          document.createTextNode('状态：'),
          h('b', { text: A.statusText(ev.status) }),
          /* 措辞跟着"去掉定时自动开始"改：原来写"按时间自动"会让人以为
             放着不管它自己会开始。现在状态全靠这里手动切。 */
          document.createTextNode('（' + (ev.statusMode === 'auto' ? '未手动锁定' : '已手动锁定') + '）'),
        ]),
      ]),
    ]);
    wrap.appendChild(info);

    const acts = h('div', { class: 'entry-actions' });
    /* 项目状态**全靠这里手动切**（不再有定时器到点自动改）。
       手动切过会锁定为"手动"，避免「按时间重算」把它冲掉。 */
    [['pending', '未开始'], ['checking', '检录中'], ['live', '进行中'], ['done', '已结束']].forEach(([st, label]) => {
      acts.appendChild(h('button', {
        class: 'state-btn' + (ev.status === st && ev.statusMode === 'manual' ? ' is-on' : ''),
        type: 'button', text: label,
        title: '手动切换状态（切换后锁定为手动，不会被"按时间重算"改掉）',
        onclick: () => App.op('event.status', { id: ev.id, status: st }).then((r) => {
          if (r.ok) A.refresh(); else A.toast(r.error || '操作失败', 'bad');
        }),
      }));
    });
    acts.appendChild(h('button', {
      class: 'state-btn' + (ev.statusMode === 'auto' ? ' is-on' : ''),
      type: 'button', text: '按时间重算',
      title: '按这个项目的起止时间算一次状态，并解除手动锁定',
      onclick: () => App.op('event.statusAuto', { id: ev.id }).then(() => A.refresh()),
    }));
    /* 【这里原来有个「开始检录/停止检录」按钮，已去掉】
       检录统一到「检录」页做，录入页专心录成绩。
       （状态按钮那排仍然有「检录中」，需要时照样能把项目标成检录中。） */
    wrap.appendChild(acts);
    return wrap;
  }

  function entryTip(ev) {
    const fieldMulti = ev.kind === 'field' && ev.attempts > 1;
    return h('div', { class: 'tip' }, [
      h('div', {}, [
        document.createTextNode('在成绩框里填好后按回车保存，并自动跳到下一人（Tab 也可以）。径赛填秒数，例如 '),
        h('code', { text: '12.35' }), document.createTextNode('；超过 1 分钟可以写 '),
        h('code', { text: '2:15.30' }), document.createTextNode('。把框清空再回车表示删除该成绩。'),
      ]),
      // 两个"没成绩"的标记要写清楚区别，否则现场会混着用
      h('div', {}, [
        document.createTextNode('没成绩时填 '),
        h('code', { text: '犯规' }), document.createTextNode('（或 '),
        h('code', { text: '×' }), document.createTextNode('）→ 大屏和成绩单显示「犯规」，排在榜尾、不计分；填 '),
        h('code', { text: '弃权' }), document.createTextNode('（请假/没来）→ 显示「弃权」，同样排榜尾、不计分。'),
        fieldMulti
          ? document.createTextNode('田赛是**每次试跳单独判**：某一次犯规就在那一格填「犯规」，其余照填成绩。')
          : null,
      ]),
      fieldMulti
        ? h('div', {}, [document.createTextNode('田赛：一行里有 ' + ev.attempts + ' 个框（每次试跳一个），名次取最好的一次；三次全犯规就是「犯规」。')])
        : null,
      h('div', { class: 'muted', text: '改动会立即生效并推送到大屏（成绩不进暂存区，现场多人同时录入才不打架）。' }),
    ]);
  }

  /** 取单项目成绩板（服务端已算好名次） */
  /** 取单项目成绩板（服务端已算好名次）
   *  floorH：换表格期间要保住的最小高度（由调用方在**替换 DOM 之前**量好传进来） */
  function loadBoard(ev, floorH) {
    const holder = el('entryTable');
    if (!holder) return;
    holder.setAttribute('data-loading', ev.id);
    if (floorH > 0) holder.style.minHeight = Math.round(floorH) + 'px';
    // 整个渲染过程包一层 try：出错时把原因写进诊断，页面不会只剩"正在读取名单…"
    try {
      renderBoard(ev, holder);
    } catch (err) {
      if (window.App && App.diag) {
        App.diag('admin-entry', { phase: 'renderBoard', error: String(err && err.message), stack: String(err && err.stack || '').slice(0, 300) });
      }
      clear(holder);
      holder.appendChild(h('div', { class: 'empty', text: '名单渲染出错：' + (err && err.message) }));
      holder.style.minHeight = '';
    }
  }

  function renderBoard(ev, holder) {
    /* 清空表格前先记下"地板高度"：clear 的一瞬间页面会明显变矮，
       浏览器随即把 scrollY 夹到新的最大值 —— 表现就是"点一下项目页面就跳上去"
       （实测文档高 1021 → 723，scrollY 被从 260 夹成 118，夹过就回不来）。
       地板其实在 loadBoard 里就按**替换前的旧高度**设好了，这里只是兜底。 */
    const pageTop = window.scrollY || document.documentElement.scrollTop || 0;
    if (!holder.style.minHeight) {
      const floor = holder.getBoundingClientRect().height;
      if (floor > 0) holder.style.minHeight = Math.round(floor) + 'px';
    }

    App.api('/api/events/' + ev.id + '/board').then((r) => {
      if (!el('entryTable') || el('entryTable') !== holder) return;   // 已切到别的项目
      /* 这里**不再** clear(holder)！
         原来先清空再重画，清空那一瞬间页面变矮、浏览器把 scrollY 夹小
         （夹过就回不来），表现就是"录一条成绩页面跳一下"。
         现在交给 drawBoard 原地更新；只有"读取失败/渲染出错"这种
         确实需要推倒重来的情况才清。 */
      if (!r.ok || !r.data || !r.data.ok) {
        if (window.App && App.diag) {
          App.diag('admin-entry', { phase: 'fetch', status: r.status, error: r.error || (r.data && r.data.message) });
        }
        clear(holder);
        holder.appendChild(h('div', { class: 'empty', text: (r.data && r.data.message) || r.error || '读取失败' }));
        holder.style.minHeight = '';
        return;
      }
      try {
        drawBoard(ev, holder, r.data.data);
      } catch (err) {
        if (window.App && App.diag) {
          App.diag('admin-entry', { phase: 'draw', error: String(err && err.message), stack: String(err && err.stack || '').slice(0, 300) });
        }
        clear(holder);
        holder.appendChild(h('div', { class: 'empty', text: '名单渲染出错：' + (err && err.message) }));
      }

      /* 收尾：撤掉"地板高度"。
         撤掉前先试着量一次：如果撤掉后页面仍然够高（或本来就是顶部），
         就撤掉、不留空白；撤掉会让页面变矮时，浏览器会把 scrollY 夹小
         （夹过就回不来），那就把地板放回去，宁可留点空白也不让视线跳走。 */
      requestAnimationFrame(() => {
        const floor = parseInt(holder.style.minHeight, 10) || 0;
        if (!floor) return;
        holder.style.minHeight = '';
        void document.documentElement.scrollHeight;          // 强制重排，拿到真实高度
        const max = document.documentElement.scrollHeight - window.innerHeight;
        if (max >= pageTop) {
          window.scrollTo(0, pageTop);                       // 放得下，撤掉地板
        } else {
          holder.style.minHeight = floor + 'px';             // 放不下，地板放回去
          void document.documentElement.scrollHeight;
          window.scrollTo(0, pageTop);
        }
      });
    });
  }

  /**
   * 画成绩录入表。
   *
   * 【重要】这个函数现在支持"原地更新"：第二次调用时**不会**把表格拆了重建，
   * 只改动真正变了的格子。原因见 entryRow 的注释 ——
   * 重建会把正在输入的框换掉，导致焦点丢、草稿丢、滚动跳。
   *
   * 做法：表格骨架（进度条 / 表头 / 表格容器）只建一次，
   * 之后每轮只 reconcile 两样东西：班级分块行、以及每块里的运动员行。
   */
  function drawBoard(ev, holder, data) {
      const rows = new Map((data.rows || []).map(x => [x.regId, x]));
      const entries = data.entries || [];

      // 记下版本号（提交时带上，才能发现别人改过）
      entries.forEach((en) => {
        (en.attempts || []).forEach((at) => { S.versions[KEY(en.regId, at.attempt)] = at.version; });
      });

      // 进度条：只建一次，之后更新文字
      const recorded = entries.filter(e => (e.attempts || []).length).length;
      let progWrap = holder.querySelector('[data-part="prog"]');
      if (!progWrap) {
        progWrap = h('div', { class: 'prog-wrap', 'data-part': 'prog' }, [
          h('div', { class: 'prog-bar' }, [h('i', {})]),
          h('div', { class: 'prog-text' }),
        ]);
        holder.appendChild(progWrap);
      }
      App.dom.setStyle(progWrap.querySelector('.prog-bar > i'), 'width',
        (entries.length ? Math.round(recorded / entries.length * 100) : 0) + '%');
      const progText = progWrap.querySelector('.prog-text');
      const progStr = '已录入 ' + recorded + ' / ' + entries.length + ' 人'
        + (data.checkin && data.checkin.open ? ('　·　检录中，已到 ' + data.checkin.arrived + ' 人') : '');
      // 进度条文字里有 <b>，所以用 innerHTML 重建这一小块（它不含输入框，重建无副作用）
      if (progText.getAttribute('data-txt') !== progStr) {
        progText.setAttribute('data-txt', progStr);
        clear(progText);
        progText.appendChild(document.createTextNode('已录入 '));
        progText.appendChild(h('b', { text: recorded + ' / ' + entries.length }));
        progText.appendChild(document.createTextNode(' 人'
          + (data.checkin && data.checkin.open ? ('　·　检录中，已到 ' + data.checkin.arrived + ' 人') : '')));
      }

      if (!entries.length) {
        let empty = holder.querySelector('[data-part="noentry"]');
        if (!empty) {
          empty = h('div', { class: 'empty', 'data-part': 'noentry', text: '这个项目还没有报名名单。到「运动员名单」或「赛程编排」里把运动员加进来。' });
          holder.appendChild(empty);
        }
        const tw0 = holder.querySelector('[data-part="tablewrap"]');
        if (tw0) tw0.hidden = true;
        return;
      }
      const noEntry = holder.querySelector('[data-part="noentry"]');
      if (noEntry) noEntry.remove();

      // 按班级分块（现场按班录入最顺手）
      const blocks = [];
      entries.forEach((en) => {
        const label = en.team || '未分班';
        let b = blocks.find(x => x.label === label);
        if (!b) { b = { label, people: [] }; blocks.push(b); }
        b.people.push(en);
      });

      const filtered = (en) => {
        if (S.onlyEmpty && (en.attempts || []).length) return false;
        if (S.search) {
          const q = S.search.toLowerCase();
          if (String(en.name || '').toLowerCase().indexOf(q) < 0
            && String(en.bib || '').toLowerCase().indexOf(q) < 0) return false;
        }
        return true;
      };

      // 表格骨架只建一次
      let tableWrap = holder.querySelector('[data-part="tablewrap"]');
      let tbody = holder.querySelector('[data-part="tbody"]');
      if (!tableWrap || !tbody) {
        const table = h('table', { class: 'entry-table' });
        table.appendChild(h('thead', {}, [h('tr', {}, [
          h('th', { text: '名次' }),
          h('th', { text: '姓名' }),
          h('th', { text: '班级/单位' }),
          h('th', { text: ev.kind === 'field' && ev.attempts > 1 ? '成绩（每次试跳一个框）' : '成绩' }),
          h('th', { text: '' }),
        ])]));
        tbody = h('tbody', { 'data-part': 'tbody' });
        table.appendChild(tbody);
        // 表格必须包在可横向滚动的容器里：表格有 min-width（32rem），
        // 直接塞进内容区在手机/窄屏上会撑破版面（实测 390 宽时有几十处溢出）。
        tableWrap = h('div', { class: 'table-wrap', 'data-part': 'tablewrap' }, [table]);
        holder.appendChild(tableWrap);
      } else {
        tableWrap.hidden = false;
      }
      // 表头文字随项目类型变（田赛多试跳时不一样）
      const thScore = tableWrap.querySelectorAll('thead th')[3];
      if (thScore) App.dom.setText(thScore, ev.kind === 'field' && ev.attempts > 1 ? '成绩（每次试跳一个框）' : '成绩');

      /* 用一串"行描述"喂给 reconcile：班级分块头 + 该块的运动员行按顺序摊平。
         每项都有稳定 key（块用 'b:'+班级，人用 'p:'+regId），
         于是顺序变化只是移动、内容变化只是原地更新。 */
      let shown = 0;
      const flat = [];
      blocks.forEach((b) => {
        const people = b.people.filter(filtered);
        if (!people.length) return;
        shown += people.length;
        flat.push({ kind: 'block', key: 'b:' + b.label, label: b.label, count: people.length });
        people.forEach((en) => flat.push({ kind: 'person', key: 'p:' + en.regId, en: en }));
      });

      App.dom.reconcile(tbody, flat,
        (it) => it.key,
        (it, node) => {
          if (it.kind === 'block') {
            if (!node) {
              node = h('tr', { class: 'class-row' }, [h('td', { colspan: '5' }, [
                h('span', { 'data-cell': 'label' }),
                h('span', { class: 'cnt' }),
              ])]);
            }
            App.dom.setText(node.querySelector('[data-cell="label"]'), it.label);
            App.dom.setText(node.querySelector('.cnt'), it.count + ' 人');
            return node;
          }
          // 运动员行：复用已有的 tr，只更新内容
          const rk = rows.get(it.en.regId);
          if (!node) return entryRow(ev, it.en, rk);
          return updateEntryRow(node, ev, it.en, rk);
        });

      // "没有符合筛选条件的运动员"
      let noMatch = holder.querySelector('[data-part="nomatch"]');
      if (!shown) {
        if (!noMatch) {
          noMatch = h('div', { class: 'empty', 'data-part': 'nomatch', text: '没有符合筛选条件的运动员' });
          holder.appendChild(noMatch);
        }
      } else if (noMatch) {
        noMatch.remove();
      }

      // 名单是异步加载的：等它画完再跑一次版面体检，
      // 否则截图/体检拿到的是"正在读取名单…"那一帧（自动化看到的也是半成品）
      setTimeout(() => App.checkLayout('admin'), 250);
  }

  /**
   * 点「犯规 / 弃权」快捷标记。
   * 再点一次同一个标记 = 取消（把框清空），这样现场点错了不用手删。
   */
  function markSlot(input, ev, en, attempt, at, word) {
    const wasFoul = !!(at && at.foul);
    const wasDnf = !!(at && at.dnf);
    const already = (word === '犯规' && wasFoul) || (word === '弃权' && wasDnf);
    const key = KEY(en.regId, attempt);
    const value = already ? '' : word;
    input.value = value;
    S.drafts[key] = value;
    input.classList.toggle('has-value', !!value);
    if (window.App && App.queue) { /* 提示：成绩走的是即时提交，不进离线队列 */ }
    submit(input, ev, en, attempt, at ? at.version : 0);
  }

  /**
   * 建一行（**只在第一次建**，之后靠 updateEntryRow 原地更新）。
   *
   * 【为什么不让整行重建】原来每次拉到新数据就把整张表 clear() 重建，
   * 结果：正在输入的框被换掉 → 焦点丢、草稿丢、滚动位置跳。
   * 现在节点留着，只改文字/样式/属性（见 updateEntryRow）。
   *
   * 行里各单元格用 data-cell 标出来，更新时按名字取，不靠下标 —— 下标一改就错位。
   * 事件监听器只挂一次，回调里读取**当前**的 en/at（不是建行时的闭包值），
   * 否则数据变了以后点按钮用的还是旧数据。
   */
  function entryRow(ev, en, rankRow) {
    const attempts = (ev.kind === 'field' && ev.attempts > 1) ? ev.attempts : 1;
    const isField = attempts > 1;

    const tr = h('tr', {}, [
      h('td', { class: 'rank-cell', 'data-cell': 'rank' }),
      h('td', {}, [
        h('div', { class: 'name-cell', 'data-cell': 'name' }),
        h('div', { class: 'sub-cell', 'data-cell': 'legs' }),
      ]),
      h('td', { class: 'sub-cell', 'data-cell': 'team' }),
      h('td', { class: 'slot-cell' }, [h('div', { class: 'slots', 'data-cell': 'slots' })]),
      h('td', {}, [
        h('button', {
          class: 'ck-btn', type: 'button', 'data-cell': 'ck',
          onclick: () => {
            const cur = currentOf(tr, ev);
            if (!cur) return;
            App.op('checkin.mark', { regId: cur.en.regId, arrived: !cur.en.arrived })
              .then(() => loadBoard(ev));
          },
        }),
        document.createTextNode(' '),
        h('button', {
          class: 'clear-btn', type: 'button', text: '清空',
          onclick: () => {
            const cur = currentOf(tr, ev);
            if (!cur) return;
            const inputs = tr.querySelectorAll('.score-input');
            inputs.forEach((x) => {
              x.value = '';
              x.classList.remove('has-value');
              S.drafts[KEY(cur.en.regId, Number(x.dataset.attempt))] = '';
            });
            if (inputs.length) submit(inputs[0], ev, cur.en, 1, 0);
          },
        }),
        /* ── 屏蔽 / 取消屏蔽 ──────────────────────────────────────────────
         * 【为什么放在录入页】现场就是"录到一半发现这个人上不了场"。
         *   跑到名单页去找人太慢，这里一行一个按钮最顺手。
         * 【为什么不删】删了报名和成绩一起没，号码也可能还印在秩序册上。
         *   屏蔽只影响**展示**：人还在、成绩还在、还能取消。
         * 按钮文字和样式跟着当前状态走（见 updateEntryRow 的第 ⑧ 步）。 */
        document.createTextNode(' '),
        h('button', {
          class: 'block-btn', type: 'button', 'data-cell': 'block',
          onclick: () => {
            const cur = currentOf(tr, ev);
            if (!cur) return;
            const en2 = cur.en;
            const nowBlocked = !en2.blocked;
            A.ask({
              title: nowBlocked ? '屏蔽这名运动员' : '取消屏蔽',
              text: nowBlocked
                ? ('把「' + (en2.name || '') + '」屏蔽？\n\n'
                  + '屏蔽后**成绩展示页不再显示他**（大屏、成绩与名次、打印单都不显示），\n'
                  + '名次按剩下的人重排。\n\n'
                  + '人不会被删除：报名和成绩都还在，这里随时能取消屏蔽。')
                : ('把「' + (en2.name || '') + '」恢复显示？\n\n恢复后他的成绩会重新出现在展示页上。'),
              okText: nowBlocked ? '屏蔽' : '恢复显示',
              danger: nowBlocked,
            }).then((r) => {
              if (!r.ok) return;
              App.op('athlete.block', { id: en2.athleteId, blocked: nowBlocked }).then((res) => {
                if (res && res.ok === false) { A.toast(res.error || '操作失败', 'bad'); return; }
                A.toast(nowBlocked ? ('已屏蔽「' + (en2.name || '') + '」') : ('已恢复「' + (en2.name || '') + '」'),
                  'ok', 2600);
                loadBoard(ev);          // 重新拉这个项目的板（名次、屏蔽数都会变）
                A.refresh();
              });
            });
          },
        }),
      ]),
    ]);
    tr.dataset.regId = en.regId;

    // 成绩输入框与「犯规/弃权」按钮按试跳次数建一次
    const slots = tr.querySelector('[data-cell="slots"]');
    for (let k = 1; k <= attempts; k++) {
      const input = h('input', {
        class: 'score-input',
        type: 'text', inputmode: 'text', autocomplete: 'off',
        placeholder: isField ? ('第' + k + '次') : '成绩',
        dataset: { regId: en.regId, attempt: String(k) },
      });
      input.addEventListener('input', () => {
        const key = KEY(en.regId, k);
        S.drafts[key] = input.value;
        input.classList.toggle('has-value', !!input.value.trim());
      });
      input.addEventListener('change', () => {
        const cur = currentOf(tr, ev);
        if (!cur) return;
        S.drafts[KEY(en.regId, k)] = input.value;
        submit(input, ev, cur.en, k, cur.attemptOf(k));
      });
      input.addEventListener('focus', () => input.select());
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          input.blur();
          setTimeout(() => focusNext(input), 60);
        } else if (e.key === 'Escape') {
          const key = KEY(en.regId, k);
          input.value = S.lastSaved[key] || '';
          S.drafts[key] = input.value;
          input.classList.toggle('has-value', !!input.value.trim());
          input.blur();
        }
      });

      const mkMark = (word, tip) => h('button', {
        class: 'mark-btn', type: 'button', text: word, title: tip,
        'data-mark': word,
        onclick: () => {
          const cur = currentOf(tr, ev);
          if (!cur) return;
          markSlot(input, ev, cur.en, k, cur.attemptOf(k), word);
        },
      });

      const slot = h('div', { class: 'slot' });
      slot.appendChild(input);
      /* 每个框旁边一对快捷标记：现场打「犯规」两个字容易打成"犯规了""犯规 "，
         而且手机上切输入法麻烦。点一下等于把这两个字填进去并立刻保存。
         两个标记是**互斥**的：犯规和弃权不可能同时成立。 */
      slot.appendChild(mkMark('犯规', '这一次判犯规（大屏显示「犯规」，排在榜尾、不计分）'));
      slot.appendChild(mkMark('弃权', '这个人弃权/请假（大屏显示「弃权」，排在榜尾、不计分）'));
      slots.appendChild(slot);
    }

    updateEntryRow(tr, ev, en, rankRow);
    return tr;
  }

  /** 行上挂的"当前数据"，供事件回调读取（避免闭包拿到建行时的旧值） */
  const rowData = new WeakMap();
  function currentOf(tr, ev) {
    const cur = rowData.get(tr);
    if (!cur) return null;
    return {
      en: cur.en,
      attemptOf: (k) => {
        const at = (cur.en.attempts || []).find(x => x.attempt === k);
        return at || null;
      },
    };
    void ev;
  }

  /**
   * 原地更新一行。**每一处都只在"真的变了"时才写 DOM** ——
   * 写 textContent / className 会让浏览器重排，写多了连录时就会卡。
   */
  function updateEntryRow(tr, ev, en, rankRow) {
    rowData.set(tr, { en: en });
    const at = (k) => (en.attempts || []).find(x => x.attempt === k) || null;

    // ① 名次
    const rank = rankRow ? rankRow.rank : null;
    const rankCls = 'rank-cell' + (rank && rank <= 3 && !(rankRow && rankRow.dnf) ? ' top' + rank : '');
    const rankCell = tr.querySelector('[data-cell="rank"]');
    App.dom.setClass(rankCell, rankCls);
    App.dom.setText(rankCell, rank ? String(rank) : '—');

    // ② 姓名（号码 + 姓名）
    App.dom.setText(tr.querySelector('[data-cell="name"]'),
      (en.bib ? en.bib + ' ' : '') + (en.name || ''));

    // ③ 接力队员（没有就留空，节点仍在，避免反复增删）
    App.dom.setText(tr.querySelector('[data-cell="legs"]'),
      (en.legs && en.legs.length) ? '参赛：' + en.legs.join('、') : '');

    // ④ 班级
    App.dom.setText(tr.querySelector('[data-cell="team"]'), en.team || '');

    // ⑤ 成绩框：**只有"服务端的值"跟本地草稿都变了才动 input.value**。
    //    正在输入的框绝不能被覆盖 —— 这是丢字的主要来源。
    const inputs = tr.querySelectorAll('.score-input');
    inputs.forEach((input) => {
      const k = Number(input.dataset.attempt);
      const a = at(k);
      const key = KEY(en.regId, k);
      const serverText = a ? (a.editText || a.display || a.raw || '') : '';
      const draft = S.drafts[key];
      const want = draft !== undefined ? draft : serverText;
      // 只有"输入框当前值 != 期望值"、且"不是正在输入的这一个框"时才写
      if (input.value !== want && document.activeElement !== input) input.value = want;
      App.dom.setClass(input, 'score-input' + (input.value ? ' has-value' : ''));
      input.placeholder = (ev.kind === 'field' && ev.attempts > 1) ? ('第' + k + '次') : '成绩';

      // ⑥ 犯规/弃权标记的选中态
      const slot = input.parentNode;
      const foulBtn = slot && slot.querySelector('[data-mark="犯规"]');
      const dnfBtn = slot && slot.querySelector('[data-mark="弃权"]');
      if (foulBtn) App.dom.setClass(foulBtn, 'mark-btn' + (a && a.foul ? ' is-on' : ''));
      if (dnfBtn) App.dom.setClass(dnfBtn, 'mark-btn' + (a && a.dnf ? ' is-on' : ''));
    });

    // ⑦ 检录按钮
    const ck = tr.querySelector('[data-cell="ck"]');
    if (ck) {
      App.dom.setClass(ck, 'ck-btn' + (en.arrived ? ' is-on' : ''));
      App.dom.setText(ck, en.arrived ? '✓' : '○');
      ck.title = en.arrived ? '点一下改成"未到"' : '点一下标记"已到"';
    }

    /* ⑧ 屏蔽状态（按钮文字 + 整行灰掉 + 提示）
       【为什么录入页还要显示被屏蔽的人】现场要能**取消**屏蔽，藏起来就找不到了。
       所以这里只是把他"灰掉"，让人一眼看出"这个人不参加展示"。 */
    const bbtn = tr.querySelector('[data-cell="block"]');
    if (bbtn) {
      /* 接力报名没有 athleteId（整队一条），没有"某个人"可屏蔽 → 不显示这个按钮 */
      bbtn.hidden = !en.athleteId;
      App.dom.setText(bbtn, en.blocked ? '取消屏蔽' : '屏蔽');
      App.dom.setClass(bbtn, 'block-btn' + (en.blocked ? ' is-on' : ''));
      bbtn.title = en.blocked
        ? '已屏蔽：成绩展示页不显示他。点一下恢复显示'
        : '屏蔽：成绩展示页不显示他（人不会被删除，随时能取消）';
    }
    App.dom.setClass(tr, en.blocked ? 'is-blocked' : '');
    return tr;
  }

  /** 回车后跳到下一个还空着的输入框（现场一个接一个录） */
  function focusNext(from) {
    const all = Array.from(document.querySelectorAll('#entryTable .score-input'));
    const i = all.indexOf(from);
    for (let k = i + 1; k < all.length; k++) if (!all[k].value.trim()) return all[k].focus();
    for (let k = 0; k < i; k++) if (!all[k].value.trim()) return all[k].focus();
    if (all[i + 1]) all[i + 1].focus();
  }

  /* ── 提交一条成绩 ────────────────────────────────────────────────────── */

  function submit(input, ev, en, attempt, version) {
    const key = KEY(en.regId, attempt);
    const raw = input.value;
    if (S.lastSaved[key] === raw) return;

    input.classList.remove('is-bad');
    const body = {
      op: 'result.set',
      payload: {
        eventId: ev.id, regId: en.regId, attempt,
        value: raw,
        version: S.versions[key] !== undefined ? S.versions[key] : version,
      },
      clientUuid: App.reqId(),
    };
    App.api('/api/op', { method: 'POST', body }).then((r) => {
      if (r.ok && r.data && r.data.ok) {
        const d = r.data.data || {};
        S.versions[key] = d.version;
        S.lastSaved[key] = raw;
        delete S.drafts[key];
        input.classList.toggle('has-value', !!raw.trim());
        if (d.warning) A.toast(d.warning, 'warn', 4000);
        loadBoard(ev);
        return;
      }
      if (r.offline) {
        /* 【这里原来是假的】只加了个 is-queued 样式 + 提示"先存在本机"，
           但**没有入队** —— 裁判以为成绩保住了，一刷新就没了。
           现在真的写进本机队列（按账号+届次隔离），联网后由
           App.startQueueFlush 自动补交；服务端有幂等表，
           重发不会录成两条。 */
        const n = App.queueWrite('/api/op', body, {
          label: ev.name + '　' + (en.name || '') + '　第' + attempt + '次',
          eventId: ev.id, regId: en.regId, attempt: attempt,
        });
        input.classList.add('is-queued');
        S.lastSaved[key] = raw;            // 免得同一个值反复入队
        delete S.drafts[key];
        A.toast('网络不通：这条成绩已存到本机（待补交 ' + n + ' 条），联网后自动补交', 'warn', 4200);
        return;
      }
      if (r.status === 409 && r.data && r.data.code === 'CONFLICT') {
        const srv = r.data.detail && r.data.detail.server;
        A.ask({
          title: '这条成绩刚被别人改过',
          text: '服务器现在是「' + ((srv && srv.display) || '（空）') + '」'
            + (srv && srv.byName ? ('（由 ' + srv.byName + ' 修改）') : '')
            + '，你填的是「' + (raw || '清空') + '」。\n\n请选择保留哪一个。',
          okText: '用我的（覆盖）',
        }).then((ans) => {
          if (!ans.ok) { loadBoard(ev); return; }
          App.api('/api/op', {
            method: 'POST',
            body: {
              op: 'result.set',
              payload: {
                eventId: ev.id, regId: en.regId, attempt,
                value: raw, force: true, version: null,
              },
              clientUuid: App.reqId(),
            },
          }).then(() => loadBoard(ev));
        });
        return;
      }
      input.classList.add('is-bad');
      A.toast((r.data && r.data.message) || r.error || '提交失败', 'bad', 4200);
    });
  }

  /* ── 筛选工具条（放在录入表上方） ────────────────────────────────────── */

  function toolbar() {
    const bar = h('div', { class: 'toolbar', style: { marginBottom: '10px' } });
    const search = h('input', {
      class: 'input grow', type: 'search', placeholder: '在这个项目的名单里搜姓名或号码',
      value: S.search,
    });
    search.addEventListener('input', () => {
      S.search = search.value.trim();
      const ev = A.S.snap.events.find(e => e.id === S.eventId);
      if (ev) loadBoard(ev);
    });
    const only = h('input', { type: 'checkbox' });
    only.checked = S.onlyEmpty;
    only.addEventListener('change', () => {
      S.onlyEmpty = only.checked;
      const ev = A.S.snap.events.find(e => e.id === S.eventId);
      if (ev) loadBoard(ev);
    });
    bar.appendChild(search);
    bar.appendChild(h('label', { class: 'chk' }, [only, h('span', { text: '只看未录' })]));
    return bar;
  }

  /* ── 对外：从别的页签跳过来 ──────────────────────────────────────────── */

  /**
   * 「赛程编排」页里每个项目后面的「名单/录入」按钮用它跳过来。
   * （成绩与名次页里原来也有一个入口，已去掉。）
   *
   * 关键顺序：要跳的项目**必须先写进 S.eventId**，再切页签 ——
   * switchTab 里的 render 会按 S.eventId 决定画哪个项目，
   * 先切过去再设就晚了（会先画错一次，还白跑一次请求）。
   * 手机录入页已经去掉，所以这里就是"跳页签"而不是"开新页面"。
   */
  function jumpTo(eventId) {
    if (eventId) {
      S.eventId = eventId;
      S.search = '';
      S.onlyEmpty = false;
    }
    A.switchTab('entry');
  }

  /* ── 导出 ────────────────────────────────────────────────────────────── */

  A.entry = { render, jumpTo, loadBoard, selectEvent, focusLog };

  A.register('entry', render);
})();
