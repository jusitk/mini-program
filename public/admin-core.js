/* ============================================================================
 * admin-core.js —— 后台公共骨架
 *
 * 这里放所有页签都要用的东西：
 *   · 全局状态 S 与四个通用 UI（toast / 询问框 / 弹层）
 *   · 暂存机制：cmd() 代替直接写数据 —— 后台改任何东西都先进暂存区
 *   · 输入框"改完离开就暂存"（没有零散的保存按钮）
 *   · 连接状态、快照推送、页签切换
 *
 * 【暂存机制怎么工作】
 *   1. 页面上的改动调 Admin.cmd(op, payload) → 先进服务端暂存区（不落正式数据）
 *   2. 右上角暂存条显示"待确认 N 项"
 *   3. 点"预览效果" → 服务端在**数据副本**上试跑，返回"确认后会变成什么样"
 *   4. 点"确认并推送大屏" → 单事务落盘 + 推一次大屏；任一条失败则整体回滚
 *   5. 界面在本地把暂存的改动叠加上去显示（所见即"确认后的样子"）
 * ========================================================================== */
'use strict';

window.Admin = (function () {
  const App = window.App;
  const h = App.h, el = App.el, clear = App.clear;
  /* 【注意】本文件里没有 `A` 这个变量！
     其他文件（admin-events.js / admin-roster.js …）开头都写 `const A = window.Admin;`，
     但本文件是**定义** Admin 的地方，没有那一行。
     历史坑：「赛程编排」里那个「名单/录入」按钮点了没反应，
       就是因为 entryJump 里写了 `A.entry.jumpTo(...)` ——
       一调就抛 `ReferenceError: A is not defined`（错误栈精确指向本文件那一行），
       按钮看起来像"坏了"。
     下面这个 self 指向正在构造的这个对象本身：本文件里要用到 Admin 的成员时用它，
     不要用 A（会抛）。 */
  const self = window.Admin;

  /* ── 全局状态 ────────────────────────────────────────────────────────── */
  const S = {
    snap: null,                 // 服务端快照（真实数据）
    staged: [],                 // 暂存区（未确认的改动）
    tab: App.store.get('adminTab', 'entry'),
    me: null,
    chat: [],
    chatLastId: '',
    unread: 0,
    filters: {
      /* 名单页四个筛选项：搜索 / 组别 / 年级 / 班级 / **按项目** */
      roster: { search: '', groupId: '', grade: '', className: '', eventId: '' },
      results: { eventId: '' },
      team: { grade: '' },
    },
    /** 本地乐观覆盖：key → 值。让界面立刻显示"改完的样子"（确认前的预览感） */
    local: new Map(),
    connOk: true,
    /** 用户正在输入时来了新数据 → 记一个"欠一次重画"，等失焦补上 */
    pendingRender: false,
  };

  /* ── 通用 UI ─────────────────────────────────────────────────────────── */

  function toast(text, kind, ms) {
    const wrap = el('toastWrap');
    if (!wrap) return;
    const t = h('div', { class: 'toast' + (kind ? ' is-' + kind : ''), text: text });
    wrap.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; }, (ms || 2800) - 320);
    setTimeout(() => t.remove(), ms || 2800);
  }

  /**
   * 询问框。危险操作要求输入指定文字（防误点）。
   * @returns {Promise<{ok:boolean, text:string}>}
   */
  function ask(opts) {
    return new Promise((resolve) => {
      const modal = el('askModal');
      el('askTitle').textContent = opts.title || '确认';
      el('askText').textContent = opts.text || '';
      const need = opts.confirmText || '';
      const field = el('askField');
      const input = el('askInput');
      field.hidden = !need;
      if (need) {
        el('askLabel').textContent = '请输入「' + need + '」以确认';
        input.value = '';
        input.placeholder = need;
      }
      el('askOk').textContent = opts.okText || '确定';
      el('askOk').className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
      modal.hidden = false;
      if (need) setTimeout(() => input.focus(), 30);

      const done = (ok) => {
        modal.hidden = true;
        el('askOk').onclick = null;
        el('askCancel').onclick = null;
        el('askClose').onclick = null;
        resolve({ ok, text: input.value.trim() });
      };
      el('askOk').onclick = () => {
        if (need && input.value.trim() !== need) {
          input.classList.add('is-bad');
          toast('请照原样输入「' + need + '」两个字', 'warn');
          return;
        }
        done(true);
      };
      el('askCancel').onclick = () => done(false);
      el('askClose').onclick = () => done(false);
    });
  }

  function openModal(id) { el(id).hidden = false; }
  function closeModal(id) { el(id).hidden = true; }

  /* ══════════════════════════════════════════════════════════════════════
   * 自定义弹窗（复用 ask 弹窗的那层壳，但内容自己画）
   *
   * 【为什么需要它】`ask()` 内部会 `resolve({ ok, text: input.value.trim() })` ——
   * 它**假定 `#askInput` 一直存在**。如果调用方把这个输入区当成自己的画布
   * 用 `clear()` 清掉，`input` 就变成了脱离文档的 null，`ask` 的确认处理会抛
   * `Cannot read properties of null (reading 'value')`，
   * 而且是**静默中断整个流程**（弹窗关了、后面的动作一个都不执行）。
   *   我写「在线会话」弹窗时就是这么踩的：点"踢掉"之后请求根本发不出去、
   *   也没有任何报错提示，查了半天才定位到。
   *
   * 所以：要画自己的内容，就用这个 —— 它把 `#askInput` **留在文档里**（只是藏起来），
   * 关掉时恢复原样。以后别再"借 ask 的壳"了。
   *
   * @param {object} opts { title, text, okText?, onOk?, suspend? }
   *   不传 onOk 就不显示确定按钮（纯展示型，比如会话列表）。
   *   suspend=true 表示"临时借用"这层壳（用于嵌套确认框）：
   *     借用期间会保存当前内容，close() 时**自动还原**，调用方不用管。
   * @returns {{ close:Function, canvas:Element, box:Element }}
   * ══════════════════════════════════════════════════════════════════════ */
  function modal(opts) {
    const o = opts || {};
    const box = el('askModal');
    const field = el('askField');
    const input = el('askInput');
    const label = el('askLabel');
    const btnOk = el('askOk');
    const btnCancel = el('askCancel');
    const titleEl = el('askTitle');
    const textEl = el('askText');

    /* 嵌套确认框：把当前弹窗的样子存下来，close() 时还原。
       不这么做的话，"点踢掉 → 弹确认"会把会话列表那层的内容整个盖掉，
       而且两边都往 askCancel 上挂关闭钩子，互相踩。 */
    let saved = null;
    /* 认一下"是不是同一块画布"用（见下面 attachRestore 的说明） */
    const canvasNow = () => el('askCanvas');
    const myCanvas = canvasNow();
    if (o.suspend) {
      saved = {
        title: titleEl.textContent, text: textEl.textContent,
        okHidden: btnOk.hidden, okText: btnOk.textContent, okClass: btnOk.className,
        cancelText: btnCancel.textContent,
        /* ⚠ 存的是**元素本身**，不是 innerHTML —— 这一点很关键：
           用 innerHTML 存/还原会把画布里的节点全部**重建**一遍，
           而调用方（比如会话列表）还握着原来那些节点的引用，
           它之后对旧节点的更新（清空、重画）就全都写进了脱离文档的角落里 ——
           表现是"数据变了、提示也弹了，但弹窗里显示的还是老列表"。
           我第一版就是 innerHTML，踩了这个坑：踢人明明成功了，
           列表却一条不少，看起来像没踢掉。搬节点就不会有这个问题。 */
        canvasEl: myCanvas,
        canvasHidden: myCanvas.hidden,
        labelHidden: label.hidden, inputHidden: input.hidden, fieldHidden: field.hidden,
        okOnclick: btnOk.onclick, cancelOnclick: btnCancel.onclick, closeOnclick: el('askClose').onclick,
        /* 调用方如果实现了 restore，就让它借这次机会重画一遍内层内容
           （纯粹为了"立刻显示最新状态"，不依赖也没关系，节点还在） */
        afterRestore: null,
      };
      saved.afterRestore = o.onRestore || null;
    }

    titleEl.textContent = o.title || '';
    textEl.textContent = o.text || '';

    /* 输入区变成"画布"：只藏输入框本身，**不删**它（见上面那段注释）。
       画布挂在输入框前面，调用方往画布里塞自己的东西。
       注意：suspend（借壳）模式**不清空**画布 —— 外层的内容得原样留着。 */
    const canvas = canvasOf(field, input);
    if (!o.suspend) { clear(canvas); canvas.hidden = false; }
    label.hidden = true;
    input.hidden = true;
    field.hidden = false;
    btnOk.hidden = !o.onOk;
    btnOk.textContent = o.okText || '确定';
    btnOk.className = 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary');
    btnCancel.textContent = o.cancelText || '关闭';
    box.hidden = false;

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      box.hidden = true;
      btnOk.onclick = null;
      btnCancel.onclick = null;
      el('askClose').onclick = null;
      // 恢复成 ask() 期望的样子，免得影响它下次使用
      btnOk.hidden = false;
      btnOk.textContent = '确定';
      btnOk.className = 'btn btn-primary';
      btnCancel.textContent = '取消';
      if (saved) {
        // 还原被借用的那层（把**活着的节点**搬回去，不重建 —— 见上面 saved 那段说明）
        titleEl.textContent = saved.title; textEl.textContent = saved.text;
        btnOk.hidden = saved.okHidden; btnOk.textContent = saved.okText; btnOk.className = saved.okClass;
        btnCancel.textContent = saved.cancelText;
        const cur = canvasNow();
        if (cur && saved.canvasEl && cur !== saved.canvasEl) {
          cur.parentNode.replaceChild(saved.canvasEl, cur);
        }
        if (saved.canvasEl) saved.canvasEl.hidden = saved.canvasHidden;
        label.hidden = saved.labelHidden; input.hidden = saved.inputHidden; field.hidden = saved.fieldHidden;
        btnOk.onclick = saved.okOnclick; btnCancel.onclick = saved.cancelOnclick;
        el('askClose').onclick = saved.closeOnclick;
        box.hidden = false;      // 外层弹窗还要继续显示
        if (saved.afterRestore) { try { saved.afterRestore(); } catch (e) { /* ignore */ } }
      } else {
        clear(canvas); canvas.hidden = true;
        label.hidden = false;
        input.hidden = false;
        field.hidden = true;
      }
      if (o.onClose) { try { o.onClose(); } catch (e) { /* ignore */ } }
    };
    btnCancel.onclick = close;
    el('askClose').onclick = close;
    if (o.onOk) {
      btnOk.onclick = () => {
        if (o.onOk() !== false) close();
      };
    }
    return { close: close, canvas: canvas, box: box };
  }

  /** 弹窗里那块"画布"（没有就建一个，挂在输入框前面） */
  function canvasOf(field, input) {
    let canvas = el('askCanvas');
    if (!canvas) {
      canvas = h('div', { id: 'askCanvas' });
      field.insertBefore(canvas, input);
    }
    return canvas;
  }

  /* ── 暂存机制 ────────────────────────────────────────────────────────── */

  /** 拿一个值：优先本地暂存覆盖（"确认后会变成什么样"），否则用服务端的真实值 */
  function val(kind, id, field, fallback) {
    const k = kind + ':' + id + ':' + field;
    if (S.local.has(k)) return S.local.get(k);
    return fallback;
  }

  function setLocal(kind, id, field, value) {
    S.local.set(kind + ':' + id + ':' + field, value);
    renderStageBar();
  }

  /**
   * 提交一条改动到暂存区。
   *
   * 【改完立刻重画】以前这里只更新了顶部"待确认 N 项"的计数，内容区不重画，
   * 所以界面上看不出变化、要按 F5 —— 现在写完就 render(true)。
   * 操作员（非管理员）提交的会**直接生效**，服务器会回 applied:true，
   * 这种情况要先 refresh() 拿新快照再重画，否则画出来的还是旧数据。
   */
  /**
   * 执行一个"编排类"操作（走暂存）。
   *
   * 【返回值为什么要带上数据】以前成功时只返回 `{staged:true}` 或
   * `{direct:true}`，**服务端算出来的东西全丢了** —— 调用方想知道
   * "新建的决赛叫什么名字、预填了几个人"就没办法，只能自己瞎猜。
   * 现在把 `/api/staged` 的 `data` 原样带回来。
   *
   * 失败时返回 `{failed:true, error:'…'}`（并已经弹过 toast），
   * 调用方判 `res.failed` 即可 —— 别再判 `res.ok`，那个字段从来没有过。
   */
  function cmd(op, payload, opts) {
    opts = opts || {};
    return App.api('/api/staged', { method: 'POST', body: { op, payload } }).then((r) => {
      if (r.ok && r.data && r.data.ok) {
        const info = r.data.data || {};
        if (info.direct) {
          // 成绩/检录类是直接生效的（实时协同，不走暂存）
          if (info.applied) {
            // 操作员：编排类改动直接落库了，必须重新拉快照
            return refresh().then(() => { render(true); return { direct: true, applied: true, data: info }; });
          }
          return { direct: true, data: info };
        }
        if (!opts.quiet) toast('已暂存：' + (info.label || op) + '（还没推送到大屏，确认后才生效）', 'warn', 2600);
        return loadStaged().then(() => { render(true); return { staged: true, data: info }; });
      }
      const msg = (r.data && (r.data.message || r.data.error)) || r.error || '暂存失败';
      toast(msg, 'bad', 3600);
      return { failed: true, error: msg };
    });
  }

  function loadStaged() {
    return App.api('/api/staged').then((r) => {
      if (r.ok && r.data && r.data.ok) {
        S.staged = (r.data.data && r.data.data.items) || [];
        renderStageBar();
      }
      return S.staged;
    });
  }

  function renderStageBar() {
    const bar = el('stageBar');
    const n = S.staged.length;
    el('stageCount').textContent = String(n);
    bar.classList.toggle('has-items', n > 0);
    const text = el('stageText');
    if (!n) {
      text.textContent = '没有任何未确认的改动（改动会自动暂存，最后统一确认）';
    } else {
      const labels = S.staged.slice(0, 3).map(x => x.label).filter(Boolean);
      text.textContent = '待确认 ' + n + ' 项：' + labels.join('、')
        + (n > 3 ? (' 等 ' + n + ' 项') : '') + '　——　确认后才会推送大屏并落盘';
    }
    el('btnConfirm').disabled = n === 0;
    el('btnDiscard').disabled = n === 0;
    el('btnPreview').disabled = n === 0;
  }

  /** 预览：服务端在数据副本上试跑，返回"确认后会变成什么样" */
  function doPreview() {
    openModal('previewModal');
    const body = el('previewBody');
    clear(body);
    body.appendChild(h('div', { class: 'empty', text: '正在生成预览…' }));
    App.api('/api/preview').then((r) => {
      clear(body);
      if (!r.ok || !r.data || !r.data.ok) {
        body.appendChild(h('div', { class: 'empty', text: (r.data && r.data.message) || r.error || '预览失败' }));
        return;
      }
      const pv = r.data.data || {};
      if (pv.empty) {
        body.appendChild(h('div', { class: 'empty', text: '当前没有待确认的改动' }));
        return;
      }
      // 会失败的先摆出来
      if (pv.failed && pv.failed.length) {
        const box = h('div', { class: 'box' });
        box.appendChild(h('div', { class: 'box-head' }, [
          h('div', { class: 'box-title', text: '这些改动现在无法生效（确认会被整体取消）' }),
        ]));
        const b = h('div', { class: 'box-body' });
        pv.failed.forEach(f => b.appendChild(h('div', { class: 'ask-text', text: '· ' + (f.label || f.op) + '：' + f.error })));
        box.appendChild(b);
        body.appendChild(box);
      }

      const before = S.snap || {};
      const after = pv.snapshot || {};
      const afterScreen = pv.screen || {};
      const grid = h('div', { class: 'pv-cmp' });

      grid.appendChild(pvColumn('现在（大屏上看到的）', 'now', [
        pvLine('运动员', (before.stats || {}).athletes),
        pvLine('项目', (before.stats || {}).events),
        pvLine('已录成绩', (before.stats || {}).results),
        pvLine('公告', ((before.notices || []).length)),
      ], (before.notices || []).slice(0, 5).map(n => ({ r: n.level === 'important' ? '!' : '', n: n.text, s: '' }))));

      grid.appendChild(pvColumn('确认后（会变成这样）', 'after', [
        pvLine('运动员', (after.stats || {}).athletes),
        pvLine('项目', (after.stats || {}).events),
        pvLine('已录成绩', (after.stats || {}).results),
        pvLine('公告', ((after.notices || []).length)),
      ], (after.notices || []).slice(0, 5).map(n => ({ r: n.level === 'important' ? '!' : '', n: n.text, s: '' }))));

      body.appendChild(grid);

      const listBox = h('div', { class: 'box', style: { marginTop: '14px' } });
      listBox.appendChild(h('div', { class: 'box-head' }, [h('div', { class: 'box-title', text: '本次要确认的 ' + (pv.staged || []).length + ' 项改动' })]));
      const lb = h('div', { class: 'box-body' });
      (pv.staged || []).forEach((it, i) => {
        const res = (pv.results || []).find(x => x.id === it.id);
        lb.appendChild(h('div', { class: 'stage-item' }, [
          h('span', { class: 'seq', text: String(i + 1) }),
          h('span', { class: 'lb', text: it.label || it.op }),
          h('span', { class: 'by', text: (it.byName || '') + ' ' + App.fmtTime(it.createdAt) }),
          res && !res.ok ? h('span', { class: 'pill pill-danger', text: '会失败：' + res.error }) : h('span', { class: 'pill pill-ok', text: '可生效' }),
        ]));
      });
      listBox.appendChild(lb);
      body.appendChild(listBox);

      // 大屏预览：班级总分榜变化（现场最关心这个）
      // 名次用 classRank（本年级名次）—— 大屏就是按年级展示的，
      // 预览要跟大屏看到的一致，否则老师会发现"预览里的名次和大屏不一样"。
      const rk = (t) => (t.classRank || t.rank);
      const t1 = ((before.team || []).slice(0, 8));
      const t2 = (((afterScreen.panels || {}).team) || []).slice(0, 8);
      if (t1.length || t2.length) {
        const tb = h('div', { class: 'box', style: { marginTop: '14px' } });
        tb.appendChild(h('div', { class: 'box-head' }, [h('div', { class: 'box-title', text: '大屏「班级总分榜」变化' })]));
        const g = h('div', { class: 'pv-cmp' });
        g.appendChild(pvColumn('现在', 'now', [], t1.map(t => ({ r: rk(t), n: t.name + '（' + t.grade + '）', s: t.points + ' 分' }))));
        g.appendChild(pvColumn('确认后', 'after', [], t2.map(t => ({ r: rk(t), n: t.name + '（' + t.grade + '）', s: t.points + ' 分' }))));
        tb.appendChild(g);
        body.appendChild(tb);
      }

      el('previewNote').textContent = '预览是在数据副本上试跑的，关闭预览不会改动任何真实数据。';
    });
  }

  function pvColumn(title, cls, stats, rows) {
    const col = h('div', { class: 'pv-col ' + cls });
    col.appendChild(h('h4', { text: title }));
    const body = h('div', { class: 'pv-list' });
    stats.forEach(s => body.appendChild(h('div', { class: 'pv-row' }, [
      h('span', { class: 'n', text: s.k }), h('span', { class: 's', text: String(s.v === undefined ? '—' : s.v) }),
    ])));
    rows.forEach(r => body.appendChild(h('div', { class: 'pv-row' }, [
      h('span', { class: 'r', text: r.r === undefined || r.r === null ? '' : String(r.r) }),
      h('span', { class: 'n', text: r.n }),
      h('span', { class: 's', text: r.s }),
    ])));
    col.appendChild(body);
    return col;
  }
  function pvLine(k, v) { return { k, v }; }

  function doConfirm() {
    const n = S.staged.length;
    if (!n) return;
    ask({
      title: '确认并推送大屏',
      text: '将把 ' + n + ' 项改动一次性写入正式数据，并立刻推送到大屏。\n'
        + '如果其中任何一项无法生效（例如同名冲突、记录已被别人删除），会**整体取消**，数据不会变成半成品。',
      okText: '确认并推送',
    }).then((r) => {
      if (!r.ok) return;
      App.api('/api/confirm', { method: 'POST', body: {} }).then((res) => {
        if (res.ok && res.data && res.data.ok) {
          S.local.clear();
          toast('已确认 ' + ((res.data.data && res.data.data.applied) || 0) + ' 项改动，大屏已更新', 'ok', 3600);
          loadStaged();
          return refresh();
        }
        const failed = res.data && res.data.data && res.data.data.failed;
        if (failed && failed.length) {
          const lines = failed.map(f => '· ' + (f.label || f.op) + '：' + f.error).join('\n');
          ask({ title: '有改动无法生效，已整体取消', text: (res.data.message || '') + '\n\n' + lines, okText: '知道了' });
        } else {
          toast((res.data && res.data.message) || res.error || '确认失败', 'bad', 4200);
        }
        loadStaged();
      });
    });
  }

  function doDiscard() {
    ask({ title: '放弃全部改动', text: '将丢弃当前 ' + S.staged.length + ' 项未确认的改动，正式数据不受影响。', okText: '放弃', danger: true })
      .then((r) => {
        if (!r.ok) return;
        App.api('/api/staged/drop', { method: 'POST', body: { all: true } }).then(() => {
          S.local.clear();
          toast('已放弃全部未确认改动', 'ok');
          loadStaged();
          refresh();
        });
      });
  }

  /**
   * 「改完离开就暂存」的输入框。
   * 不用零散的保存按钮：change 事件（失焦/回车）就提交。
   */
  function bindEditable(input, opts) {
    input.classList.add('input-editable');
    const fire = () => {
      flushPendingRender();            // 离开输入框：把欠的那次重画补上
      if (input.dataset.last === input.value) return;
      input.dataset.last = input.value;
      opts.onCommit(input.value);
    };
    input.addEventListener('change', fire);
    input.addEventListener('blur', fire);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    if (opts.value !== undefined) { input.value = opts.value; input.dataset.last = opts.value; }
    return input;
  }

  /* ── 页签切换 ────────────────────────────────────────────────────────── */

  function switchTab(tab) {
    /* 顺序很讲究，错一步草稿就丢（踩过两次）：
     *   ① 在**还没换 pane 可见性**时，按旧页签把草稿抓下来
     *      （captureFields 只扫"当前可见的 pane"，所以要赶在切换前抓）
     *   ② 换 pane 可见性（这会儿 DOM 里可见的才是新页签）
     *   ③ 画新页签 —— render 内部会"抓新页签的草稿 → 画 → 填回去"，
     *      抓到的和填回去的是同一个页签，不会串
     */
    if (tab !== S.tab) stashDrafts(S.tab);
    S.tab = tab;
    App.store.set('adminTab', tab);
    Array.from(document.querySelectorAll('.tab')).forEach(b => b.classList.toggle('is-on', b.dataset.tab === tab));
    Array.from(document.querySelectorAll('.pane')).forEach(p => p.classList.toggle('is-on', p.dataset.pane === tab));
    // 切页签一定要重画：这个页签可能是几分钟前画的，直接显示旧数据会被当成"没生效"
    render(true, tab);
    // 需要额外拉数据的页签（聊天/记录/备份/账号不在主快照里）
    if (tab === 'chat') { S.unread = 0; renderBadge(); loadChat(); }
    if (tab === 'audit') loadAudit().then(() => render(true));
    if (tab === 'backup') loadBackups().then(() => render(true));
    if (tab === 'accounts') loadAccounts().then(() => render(true));
    /* 注：原来这里还有 `if (tab === 'checkin') render(true);` ——
       「检录」页签已按用户要求去掉，那行一并删掉（render(true, tab) 已经画过了，
       那一行本来就是重复的）。 */
  }

  function renderBadge() {
    const b = el('chatBadge');
    if (!b) return;
    b.hidden = S.unread <= 0;
    b.textContent = String(S.unread);
  }

  /* ── 连接 ────────────────────────────────────────────────────────────── */

  function setConn(state, text) {
    S.connOk = state === 'ok' || state === 'poll';
    renderPendingHint();
    const box = el('conn');
    if (!box) return;
    box.classList.toggle('is-off', state === 'off' || state === 'poll');
    box.classList.toggle('is-bad', state === 'bad');
    el('connText').textContent = text || (state === 'ok' ? '已连接主机' : '连接中断');
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 重画时保住用户正在输入的内容
   *
   * 【踩过的坑】现场反馈两条，其实是同一个 bug：
   *   ① "每次检录修改，屏幕都会刷新一下"
   *      —— 点检录按钮 → onWrite 里 render(true) → 整页 DOM 被 clear 重建，
   *         屏幕闪一下，而且**正在聊天框里打的字全没了**
   *   ② "在聊天室打字时也会刷新，打字内容丢失"
   *      —— 聊天每 6 秒 loadChat() 一次，拉到新消息就 renderChatOnly() 重画聊天面板；
   *         就算没有新消息，**任何**一次快照重画也会把它清掉
   *
   * 根因不是"必须定时刷新"，而是**重画等于把 DOM 全拆了重建**，
   * 重建后输入框自然是空的。
   *
   * 两层防护：
   *   甲、整页不要重画 —— 用户正在输入时挂起重画，等失焦再补（见 applySnapshot）
   *   乙、真要重画时，先把输入内容/光标/滚动位置存下来，画完再填回去
   *       （下面这几个函数）。只靠甲不够：用户可能刚点完按钮，
   *       焦点在按钮上但聊天框里有草稿，这种情况也得保住。
   * ══════════════════════════════════════════════════════════════════════ */

  /** 会被"重画"影响的输入元素。text/textarea 一律算，
   *  checkbox/radio/file/button 这类没有"草稿"语义的不算。 */
  const FIELD_SEL = [
    'input[type="text"]', 'input[type="number"]', 'input[type="search"]',
    'input[type="date"]', 'input[type="time"]', 'input:not([type])',
    'textarea', '[contenteditable="true"]',
  ].join(',');

  const fieldKey = (e) => (e.id || '') + '|' + (e.name || '') + '|'
    + (e.dataset ? (e.dataset.k || e.dataset.field || '') : '');

  /**
   * 把当前页面上所有输入框的"草稿状态"记下来。
   * 每画一个页签就存一份（按页签分开），这样切来切去也不会丢。
   *
   * 同时记下"抓取这一刻焦点在哪个元素上"，供 restoreFields 判断
   * 要不要把焦点抢回来（见那边的注释）。
   */
  function captureFields() {
    const box = document.querySelector('.pane.is-on') || document.body;
    const out = [];
    Array.prototype.slice.call(box.querySelectorAll(FIELD_SEL)).forEach((e) => {
      out.push({
        key: fieldKey(e), value: e.value,
        focused: document.activeElement === e,
        ss: typeof e.selectionStart === 'number' ? e.selectionStart : null,
        se: typeof e.selectionEnd === 'number' ? e.selectionEnd : null,
        st: e.scrollTop,
      });
    });
    out.wasActive = document.activeElement || null;
    return out;
  }

  /**
   * 画完把草稿填回去。
   *
   * 【焦点只在"该抢"的时候才抢】踩过的坑：
   *   原来只要记到某个框当时有焦点，就无条件 e.focus() 把焦点设回去。
   *   在"重画=重建 DOM"的年代这是对的 —— 反正原来的框已经被销毁了。
   *   但改成"原地打补丁"以后节点都活着，浏览器**自己就把焦点保住了**；
   *   这时再强制 focus 反而会把焦点从用户刚点的那个框**抢走**
   *   （实测：录入页提交一条成绩，焦点被拽到左边的"找项目"搜索框）。
   *   所以判据改成：只有"重画前那个有焦点的元素**已经不在文档里了**"
   *   才需要把焦点还回去。
   */
  function restoreFields(saved) {
    if (!saved || !saved.length) return false;
    const box = document.querySelector('.pane.is-on') || document.body;
    // 重画前有焦点的元素还活着（且在文档里）→ 浏览器已经替我们保住了，别动
    const wasActive = saved.wasActive;
    if (wasActive && wasActive.isConnected && document.contains(wasActive)) return false;

    let restoredFocus = false;
    saved.forEach((s) => {
      // 先按 key 找，找不到再退化成"第 n 个同类元素"（列表重排时位置会变）
      let e = null;
      const all = box.querySelectorAll(FIELD_SEL);
      for (let i = 0; i < all.length; i++) { if (fieldKey(all[i]) === s.key) { e = all[i]; break; } }
      if (!e) return;
      if (s.value !== e.value) e.value = s.value;
      try { e.scrollTop = s.st; } catch (err) { /* 忽略 */ }
      if (s.focused && !restoredFocus) {
        e.focus({ preventScroll: true });
        restoredFocus = true;
        if (s.ss !== null && typeof e.setSelectionRange === 'function') {
          try { e.setSelectionRange(s.ss, s.se); } catch (err) { /* 某些类型不支持 */ }
        }
      }
    });
    return restoredFocus;
  }

  /**
   * 草稿池：按页签存。重画前 capture，画完 restore。
   *
   * 【踩过的坑】原来 stashDrafts() 固定按"当前页签"存，而 render() 里读的也是
   * 当前页签 —— 切页签时 S.tab 已经改成新页签了，于是把**旧页签的草稿存到了新页签名下**，
   * 切回去草稿就没了。所以这里收一个 tab 参数，由调用方明确指定"这是哪个页签的草稿"。
   */
  const fieldDrafts = {};
  function stashDrafts(tab) {
    const k = tab || S.tab;
    try { fieldDrafts[k] = captureFields(); } catch (e) { /* 忽略 */ }
  }
  function unstashDrafts(tab) {
    const k = tab || S.tab;
    try { return restoreFields(fieldDrafts[k]); } catch (e) { return false; }
  }

  /**
   * 用户此刻是不是正在输入（任何可编辑框有焦点，或里面还有没提交的内容）。
   * 用于"收到新快照时先别重画"的判断。
   */
  function isUserTyping() {
    const a = document.activeElement;
    if (a && a.matches && a.matches(FIELD_SEL)) {
      // 有焦点就算在输入；只读的搜索框也算（重画一样会打断打字）
      return true;
    }
    return false;
  }

  /* ── 各页签的渲染函数（由各自的文件注册进来） ────────────────────────── */

  const RENDER = {};
  /** 记录每个页签上次是用哪个快照版本画的 —— 版本变了才需要重画（避免无谓重画） */
  const paintedRev = {};

  /**
   * 注册一个页签的渲染函数。
   *
   * 【关键】这里统一包一层"保草稿"，而不是让每个调用点自己记得调：
   *   踩过的坑：先在 render() 里做了"抓草稿→画→填回"，结果
   *   `renderChatOnly()` 直接调 `RENDER.chat()`，**绕过了那层保护**，
   *   于是聊天每 6 秒自动刷新一次就把打字内容清掉了。
   *   这类"每个调用点都要记得做同一件事"的写法迟早会漏，
   *   所以改成**在注册处包一次**：以后不管谁怎么调，草稿都保住。
   */
  function register(tab, fn) {
    RENDER[tab] = function wrappedRender() {
      stashDrafts(tab);
      const r = fn.apply(null, arguments);
      unstashDrafts(tab);
      return r;
    };
  }

  /**
   * 重画"当前页签"。
   *
   * 【为什么以前会"改一次要刷新一次"】
   *   编辑框改完只往暂存区发了一条，然后只更新了顶部那个"待确认 N 项"的计数，
   *   **内容区没有重画** —— 所以界面上看不出变化，非得按 F5 才看到。
   *   现在两处兜住：
   *     · 写操作成功后主动 render()（见 markDirty / cmd / op）
   *     · 收到新快照（SSE/轮询）后 render()
   */
  /**
   * 重画"当前页签"。
   *
   * 【为什么以前会"改一次要刷新一次"】
   *   编辑框改完只往暂存区发了一条，然后只更新了顶部那个"待确认 N 项"的计数，
   *   **内容区没有重画** —— 所以界面上看不出变化，非得按 F5 才看到。
   *   现在两处兜住：
   *     · 写操作成功后主动 render()（见 markDirty / cmd / op）
   *     · 收到新快照（SSE/轮询）后 render()
   *
   * tab 参数：切页签时要画的是**新页签**，而此时 S.tab 刚改完没问题；
   *   但草稿要按旧页签存，所以切页签时显式把新页签传进来，避免这两件事互相干扰。
   */
  function render(force, tabArg) {
    // 快照还没到就渲染会读空对象（历史上这里报过 "Cannot read properties of null"）
    if (!S.snap) return;
    const tab = tabArg || S.tab;
    const rev = String(S.snap.rev === undefined ? '' : S.snap.rev);
    // 版本没变、又不是强制，就跳过 —— 但"本地乐观覆盖"生效时必须重画
    if (!force && paintedRev[tab] === rev && !S.local.size) return;
    const fn = RENDER[tab];
    if (typeof fn === 'function') {
      try {
        // 注意：fn 在 register() 里已经被包了"抓草稿→画→填回"，这里不用再管
        fn();
        paintedRev[tab] = rev;
      } catch (err) {
        toast('这一页渲染出错：' + (err && err.message), 'bad', 5000);
        console.error(err);
      }
    }
    renderHeader();
    renderPendingHint();
  }

  /** 下一次 render 一定重画（本地改过东西、或明确知道数据变了就调它） */
  function markDirty() {
    Object.keys(paintedRev).forEach((k) => { delete paintedRev[k]; });
  }

  /**
   * 把每个页签都标脏 —— 收到新快照时用。
   * 只重画当前页签也够用，但"切过去还是旧内容"会被当成没生效，
   * 所以切页签时按需重画（见 switchTab）。
   */
  function markAllDirty() { markDirty(); }

  function renderHeader() {
    if (!S.snap) return;      // 同上：没有数据时不渲染头部
    const meet = (S.snap && S.snap.meet) || {};
    // 新版顶栏：标题固定，旁边显示本届名称
    if (el('navMeet')) {
      const parts = [];
      if (meet.name) parts.push(meet.name);
      if (meet.holdDate) parts.push(meet.holdDate);
      el('navMeet').textContent = parts.join('　·　');
    }
    document.title = (meet.name || '运动会') + ' · 录入后台';
    if (S.me && el('whoami')) {
      el('whoami').textContent = (S.me.displayName || S.me.username)
        + '（' + (S.me.roleLabel || S.me.role) + '）';
    }
    renderQueueBadge();
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 待补交提示条
   *
   * 【为什么必须有】断网时成绩先存在本机，如果界面上不显示"还有 N 条没交上去"，
   * 裁判就会以为全都录好了 —— 这正是审计报告指出的"提示已保存但实际没保存"
   * 那个坑的另一半。宁可显眼一点，也不能让人误判。
   * ══════════════════════════════════════════════════════════════════════ */

  function renderQueueBadge() {
    const box = el('queueHint');
    if (!box) return;
    if (!App.queue) { box.hidden = true; return; }
    const n = App.queue.size();
    const stuck = App.queue.stuck().length;
    if (!n) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    if (stuck) {
      box.className = 'queue-hint is-bad';
      box.textContent = '⚠ 有 ' + stuck + ' 条成绩没交上去（被服务端拒绝，需要你处理）　·　点这里查看';
      box.onclick = () => showQueueDialog();
    } else {
      box.className = 'queue-hint';
      box.textContent = '⏳ 待补交 ' + n + ' 条（本机已存，联网自动补交）';
      box.onclick = () => {
        App.queue.flush().then(() => renderQueueBadge());
      };
    }
  }

  /** 待补交详情：列出每一条，能重试、能丢弃 */
  function showQueueDialog() {
    const list = App.queue.all();
    if (!list.length) { self.toast('没有待补交的记录', 'ok'); renderQueueBadge(); return; }
    const lines = list.slice(0, 20).map((x, i) => {
      const when = App.fmtTime(x.at, true);
      const st = x.rejected ? ('　✘ ' + x.rejected) : '　（等待补交）';
      return (i + 1) + '. ' + (x.label || x.body.op) + '　' + when + st;
    });
    self.ask({
      title: '待补交的成绩（' + list.length + ' 条）',
      text: lines.join('\n')
        + (list.length > 20 ? ('\n…还有 ' + (list.length - 20) + ' 条') : '')
        + '\n\n「重试补交」会现在再试一次；被拒绝的那些需要你先弄清楚原因'
        + '（比如成绩已经被别人改过），点「丢弃」才会从本机删掉。',
      okText: '重试补交',
    }).then((r) => {
      if (!r.ok) return;
      App.queue.flush().then((res) => {
        if (res.stuck) {
          self.toast('还有 ' + res.stuck + ' 条被服务端拒绝，请看提示', 'bad', 6000);
        } else if (res.left) {
          self.toast('还是连不上，' + res.left + ' 条仍留在本机', 'warn', 5000);
        } else {
          self.toast('已全部补交', 'ok');
        }
        renderQueueBadge();
      });
    });
  }

  /* ── 刷新 ────────────────────────────────────────────────────────────── */

  /* ══════════════════════════════════════════════════════════════════════
   * 增量合并（第 2 趟改造）
   *
   * 【服务端现在会推两种东西】
   *   全量快照：带 kind/rev/panels（或 athletes/events/…），没有 base
   *   增量：带 base + rev + patch，只有"变了的那些东西"
   *
   * 合并逻辑本身在 public/snapshot-merge.js（**纯函数**，能脱离浏览器单测）——
   * 为什么单独放：这是全项目唯一"合并错了会静默丢数据"的地方，
   * 页面不会报错，只会少显示一条成绩。所以它必须能被自动化测试逐字段比对。
   * ══════════════════════════════════════════════════════════════════════ */

  let patchFallbackPending = false;

  /**
   * 收到一份数据（全量或增量）。
   *
   * 【"正在打字就先不重画"的坑】原来只判断 `activeElement` 有没有 `.input-editable`
   * 这个 class，于是：
   *   · 聊天框是普通 textarea，**没有这个 class** → 判定为"没在打字" → 照样重画 → 草稿没了
   *   · 就算判对了，也只更新头部，**再也不补画**，后台会停在旧数据上不动
   * 现在改成：
   *   · 判据统一用 isUserTyping()（任何输入框有焦点就不再整页重画）
   *   · 重画一律经 render() → 里面有"存草稿/填回去"的兜底
   *   · 挂起期间在连接状态旁显示「↑ 有更新待显示」，并设一个兜底闹钟
   */
  function applySnapshot(snap, meta) {
    if (!snap) return;
    let data = snap;

    if (App.merge && App.merge.isPatch(snap)) {
      const okMerge = App.merge.merge(S.snap, snap);
      if (!okMerge) {
        /* 版本对不上 → 退回全量。
           为什么必须退：增量是"基于某版本的补丁"，我手里版本不对时硬套会得到错数据。
           退的方式是重新拉一次全量（自己这次不应用），拉回来走的是全量分支。
           加个在途标记，避免连续几条对不上的增量把请求打爆。 */
        if (!patchFallbackPending) {
          patchFallbackPending = true;
          refresh().then(() => { patchFallbackPending = false; });
        }
        return;
      }
      data = S.snap;
    } else {
      S.snap = data;
    }

    markAllDirty();                      // 数据变了：所有页签都该重画
    if (isUserTyping() && meta && (meta.via === 'sse' || meta.via === 'poll')) {
      // 正在输入：先只更新头部，别打断打字；等失焦后补画
      S.pendingRender = true;
      S.pendingSince = Date.now();
      renderHeader();
      renderPendingHint();
      schedulePendingFallback();
      return;
    }
    S.pendingRender = false;
    render(true);
  }

  /**
   * 挂起重画时的兜底：最长 15 秒补画一次。
   * 为什么需要：用户可能一直把光标停在输入框里（比如聊天框开着），
   * 那样永远不触发 focusout，页面就永远停在旧数据上。
   */
  let pendingTimer = null;
  function schedulePendingFallback() {
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (!S.pendingRender) return;
      // 还在打字就再等一轮；不打了就补画
      if (isUserTyping() && Date.now() - (S.pendingSince || 0) < 60000) {
        schedulePendingFallback();
        return;
      }
      flushPendingRender();
    }, 15000);
  }

  /** 在连接状态旁边显示"有更新待显示"，让用户知道不是卡住了 */
  function renderPendingHint() {
    const box = el('updateHint');
    if (!box) return;
    if (!S.pendingRender) { box.hidden = true; return; }
    box.hidden = false;
    box.textContent = '↑ 有更新待显示';
    box.title = '你正在输入，为了不打断你，页面暂时没重画；离开输入框就会立刻更新';
  }

  /** 用户离开输入框时把"欠的那次重画"补上 */
  function flushPendingRender() {
    if (!S.pendingRender) return;
    S.pendingRender = false;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    render(true);
  }

  /**
   * 写操作成功后主动重新拉数据（由 common.js 的 App.api 在写请求成功后回调）。
   *
   * 【为什么需要】改了东西之后，界面上必须马上看到结果：
   *   · 管理员：改动进了暂存区 → 快照本身没变，但要重画（先按本地乐观值显示）
   *   · 操作员：改动**直接落库** → 快照变了，必须重新拉一次才画得对
   * 光等 SSE 推送会有延迟，而且推送被"正在打字"挡住时会一直停在旧数据上。
   */
  let writeRefreshTimer = null;
  function onWrite(path, data) {
    // 只关心会改动数据的写接口：提交改动、直接执行、确认、放弃、上传
    if (!/^\/api\/(staged|op|confirm|staged\/drop)/.test(String(path || ''))) return;
    const info = (data && data.data) || {};
    // 进了暂存区（还没落库）：只需重画，让本地乐观值显示出来
    if (info && info.id && info.seq !== undefined && !info.direct) {
      markAllDirty();
      render(true);
      return;
    }
    // 直接生效 / 确认落库：合并成一拍去拉最新快照，避免连点按钮时拉爆
    if (writeRefreshTimer) clearTimeout(writeRefreshTimer);
    writeRefreshTimer = setTimeout(() => {
      writeRefreshTimer = null;
      refresh().then(() => render(true));
    }, 120);
  }

  function refresh() {
    return App.api('/api/snapshot?kind=admin').then((r) => {
      if (r.ok && r.data) applySnapshot(r.data, { via: 'manual' });
      return r;
    });
  }

  function loadAccounts() {
    // 账号列表是单独接口（不在快照里，避免把账号信息推给所有人）
    return App.api('/api/users').then((r) => {
      if (r.ok && r.data && r.data.ok) {
        S.users = (r.data.data && r.data.data.users) || [];
        if (S.tab === 'accounts') render();
      }
    });
  }

  function loadAudit() {
    return App.api('/api/audit', { query: { limit: 150 } }).then((r) => {
      if (r.ok && r.data && r.data.ok) {
        S.audit = (r.data.data && r.data.data.logs) || [];
        if (S.tab === 'audit') render();
      }
    });
  }

  function loadBackups() {
    return App.api('/api/backups').then((r) => {
      if (r.ok && r.data && r.data.ok) {
        S.backups = r.data.data;
        if (S.tab === 'backup') render();
      }
    });
  }

  function loadChat() {
    return App.api('/api/chat', { query: { limit: 80 } }).then((r) => {
      if (r.ok && r.data && r.data.ok) {
        const list = (r.data.data && r.data.data.messages) || [];
        if (S.chatLastId && list.length) {
          const idx = list.findIndex(m => m.id === S.chatLastId);
          const fresh = idx >= 0 ? list.slice(idx + 1) : list;
          if (S.tab !== 'chat') { S.unread += fresh.filter(m => m.kind !== 'system').length; renderBadge(); }
        } else if (list.length && S.tab !== 'chat') {
          S.unread = list.length; renderBadge();
        }
        S.chat = list;
        if (list.length) S.chatLastId = list[list.length - 1].id;
        if (S.tab === 'chat') renderChatOnly();
      }
    });
  }

  /**
   * 只重画聊天面板（每 6 秒自动拉一次新消息时用）。
   * 不用再担心打断打字 —— register() 里那层包装会把草稿和光标原样填回去。
   */
  function renderChatOnly() { if (RENDER.chat) RENDER.chat(); }

  /* ── 按角色区分界面 ──────────────────────────────────────────────────── */

  /** 管理员专属页签（操作员/只读看不到） */
  const ADMIN_TABS = ['settings', 'backup', 'accounts', 'audit'];

  /**
   * 按登录角色决定显示哪些页签与功能。
   *
   * 【为什么要有这个】三种人干的事不一样：
   *   · 管理员：全都能干，而且**改动要确认**（暂存条 + 预览/确认/放弃）
   *   · 操作员：录成绩、检录、改名单项目、发公告 —— **改动直接生效，不用确认**
   *   · 只读：只能看（成绩/公告/聊天/总分），写的东西一个都不显示
   * 页签少一半，现场更容易点对；也不用给用不上的按钮配权限提示。
   *
   * 这只是**显示口径**，真正的拦截在服务端（Auth.ACTION_ROLE / can()）——
   * 就算有人在控制台把按钮改出来，服务端照样拒。
   */
  function applyRoleUI() {
    const me = S.me;
    if (!me) return;
    const role = me.role || 'viewer';
    const roleLabel = me.roleLabel || role;
    const tabs = (S.perms && S.perms.tabs && S.perms.tabs.length)
      ? S.perms.tabs
      : (role === 'admin' ? null : (role === 'operator'
        ? ['entry', 'results', 'notice', 'chat', 'events', 'roster', 'team']
        : ['results', 'notice', 'chat', 'team']));

    // 1) 页签：不在名单里的直接隐藏
    Array.from(document.querySelectorAll('.tab')).forEach((b) => {
      const show = !tabs || tabs.indexOf(b.dataset.tab) >= 0;
      b.hidden = !show;
      b.classList.toggle('is-hidden', !show);
    });

    // 2) 当前停在的页签如果被藏了，换到第一个可见的
    if (tabs && tabs.indexOf(S.tab) < 0) {
      const first = document.querySelector('.tab:not([hidden])');
      if (first) S.tab = first.dataset.tab;
    }

    // 3) 暂存条：只有管理员需要"确认后推送"
    const stagebar = el('stageBar');
    if (stagebar) {
      stagebar.hidden = role !== 'admin';
      stagebar.classList.toggle('is-hidden', role !== 'admin');
    }

    // 4) 大屏按钮谁都留着（都要看大屏）；改口令谁都留着
    // 5) 顶栏给个角色色标，现场一眼看出"我现在是谁"
    const badge = el('roleBadge');
    if (badge) {
      badge.textContent = roleLabel;
      badge.className = 'role-badge role-' + role;
      badge.title = role === 'admin'
        ? '管理员：改动需要「确认修改并推送大屏」才生效'
        : (role === 'operator' ? '操作员：改动立即生效（不用确认）' : '只读：只能查看，不能修改');
    }
    // 6) 只读账号：把明显是写操作的按钮藏掉，省得点了报错
    if (role === 'viewer') {
      Array.from(document.querySelectorAll('[data-need-write]')).forEach((n) => { n.hidden = true; });
    }
  }

  /** 这个角色能不能做某个动作（前端用；服务端仍会再拦一次） */
  function canRole(action) {
    const role = (S.me && S.me.role) || 'viewer';
    if (action === 'admin') return role === 'admin';
    if (action === 'write') return role !== 'viewer';
    if (role === 'admin') return true;
    if (action === 'stage') return false;      // 只有管理员走暂存确认
    return role === 'operator';
  }

  /* ── 状态文案（以服务端下发的为准） ──────────────────────────────────── */

  /**
   * 状态文案与语气都从快照里取（服务端 src/status.js 是唯一一处定义）。
   * 以前各个前端文件各写一份 "进行中/已结束/未开始"，加了"检录中"就漏了 ——
   * 现在只有这里的兜底是本地写死的，而且只在新快照还没到时才用得上。
   */
  const STATUS_FALLBACK = { pending: '未开始', checking: '检录中', live: '进行中', done: '已结束' };
  const TONE_FALLBACK = { pending: 'dim', checking: 'warn', live: 'ok', done: 'done' };

  function statusText(st) {
    const m = (S.snap && S.snap.statusLabel) || STATUS_FALLBACK;
    return m[st] || STATUS_FALLBACK[st] || st || '未开始';
  }
  function statusTone(st) {
    const m = (S.snap && S.snap.statusTone) || TONE_FALLBACK;
    return m[st] || 'dim';
  }

  /**
   * 跳到「成绩录入」并选中某个项目 —— **「赛程编排」页里每个项目后面那个按钮**用
   * （成绩与名次页里原来也有一个，已去掉：那一页只看名次和导出）。
   * 具体实现放在 admin-entry.js（它才知道录入页的状态），这里只做转发，
   * 免得两个文件互相引用对方的内部状态。
   */
  function entryJump(eventId) {
    /* 用 self，不要用 A —— 本文件里 A 根本没定义（见文件头的说明）。
       这是「名单/录入」按钮点了没反应的根因。 */
    if (self && self.entry && typeof self.entry.jumpTo === 'function') {
      return self.entry.jumpTo(eventId || '');
    }
    return switchTab('entry');
  }

  /* ── 启动 ────────────────────────────────────────────────────────────── */

  function boot() {
    App.pxScale('standard');
    App.installErrorReporting('admin');

    applyRoleUI();     // 按账号角色决定显示哪些页签与按钮

    /* 断网时录的成绩存在本机，这里负责把它交上去：
       启动时、恢复网络时、页面回到前台时、每 30 秒各试一次。
       有冲突就弹出来让人选，绝不擅自决定用谁的值。 */
    if (App.startQueueFlush) {
      App.startQueueFlush({
        onProgress: () => renderQueueBadge(),
        onSent: (res) => {
          self.toast('已补交 ' + res.sent + ' 条断网期间录的成绩', 'ok', 4000);
          App.refresh && App.refresh();
        },
        onConflict: (cf) => {
          cf.slice(0, 5).forEach((c) => {
            const srv = c.server || {};
            self.ask({
              title: '补交时发现冲突',
              text: '「' + (c.item.label || '一条成绩') + '」在断网期间被别人改过。\n\n'
                + '服务器现在是「' + (srv.display || '（空）') + '」'
                + (srv.byName ? ('（由 ' + srv.byName + ' 修改）') : '')
                + '，你当时录的是「' + (c.item.body.payload && c.item.body.payload.value) + '」。\n\n'
                + '选「用我的」会以你的值为准覆盖；选「用服务器的」就把本机这条丢掉。',
              okText: '用我的（覆盖）',
            }).then((ans) => {
              if (ans.ok) {
                // 明确选择覆盖：force 重发一次
                App.api('/api/op', {
                  method: 'POST',
                  body: {
                    op: 'result.set', payload: Object.assign({}, c.item.body.payload, { force: true, version: null }),
                    clientUuid: App.reqId(),
                  },
                }).then(() => { App.queue.drop(c.item.body.clientUuid); renderQueueBadge(); });
              } else {
                App.queue.drop(c.item.body.clientUuid);
                renderQueueBadge();
              }
            });
          });
        },
      });
    }
    App.queue && App.queue.onChange(() => renderQueueBadge());

    // 用户离开任何输入框就把"欠的那次重画"补上 ——
    // 少了这一步，只要光标停在编辑框里，后台就会一直停在旧数据上
    document.addEventListener('focusout', () => setTimeout(flushPendingRender, 0), true);
    // 兜底：万一 focusout 没触发（比如输入框被重画掉了），每秒查一次
    setInterval(() => { if (S.pendingRender && !isUserTyping()) flushPendingRender(); }, 1000);

    document.querySelectorAll('.tab').forEach((b) => {
      b.addEventListener('click', () => switchTab(b.dataset.tab));
    });
    el('btnPreview').addEventListener('click', doPreview);
    el('btnConfirm').addEventListener('click', doConfirm);
    el('btnDiscard').addEventListener('click', doDiscard);
    el('btnStageList').addEventListener('click', () => {
      openModal('stageModal');
      const body = el('stageBody');
      clear(body);
      if (!S.staged.length) { body.appendChild(h('div', { class: 'empty', text: '没有待确认的改动' })); return; }
      S.staged.forEach((it, i) => {
        body.appendChild(h('div', { class: 'stage-item' }, [
          h('span', { class: 'seq', text: String(i + 1) }),
          h('span', { class: 'lb', text: it.label || it.op }),
          h('span', { class: 'by', text: (it.byName || '') + ' ' + App.fmtTime(it.createdAt) }),
          h('button', {
            class: 'btn btn-sm btn-ghost', type: 'button', text: '撤销这一项',
            onclick: () => App.api('/api/staged/drop', { method: 'POST', body: { id: it.id } }).then(() => {
              loadStaged().then(() => { openModal('stageModal'); el('stageModal').hidden = true; el('btnStageList').click(); });
            }),
          }),
        ]));
      });
    });
    el('stageClose').addEventListener('click', () => closeModal('stageModal'));
    el('stageClose2').addEventListener('click', () => closeModal('stageModal'));
    el('previewClose').addEventListener('click', () => closeModal('previewModal'));
    el('previewClose2').addEventListener('click', () => closeModal('previewModal'));

    el('btnLogout').addEventListener('click', () => {
      App.api('/api/logout', { method: 'POST', body: {} }).then(() => location.replace('/login'));
    });
    el('btnPwd').addEventListener('click', changeMyPassword);

    // 写操作成功后主动刷新（common.js 的 App.api 会回调这里）
    App.onWrite = onWrite;

    // 当前登录人
    App.api('/api/me').then((r) => {
      if (!r.ok || !r.data || !r.data.user) { location.replace('/login?next=/admin'); return; }
      S.me = r.data.user;
      S.perms = r.data.perms || {};
      App.setCsrf(r.data.csrf);
      applyRoleUI();
      renderHeader();
      startData();
    });
  }

  function changeMyPassword() {
    const box = h('div', { class: 'form-grid' }, [
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '原口令' }), h('input', { class: 'input', id: 'pwOld', type: 'password', autocomplete: 'current-password' })]),
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '新口令（至少 6 位，别全是数字）' }), h('input', { class: 'input', id: 'pwNew', type: 'password', autocomplete: 'new-password' })]),
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '再输一遍新口令' }), h('input', { class: 'input', id: 'pwNew2', type: 'password', autocomplete: 'new-password' })]),
    ]);
    const modal = el('askModal');
    el('askTitle').textContent = '修改我的口令';
    el('askText').textContent = '改完之后当前登录会失效，需要用新口令重新登录。';
    const field = el('askField');
    field.hidden = false;
    el('askLabel').textContent = '';
    clear(field);
    field.appendChild(box);
    el('askOk').textContent = '修改';
    el('askOk').className = 'btn btn-primary';
    modal.hidden = false;

    const finish = (ok) => {
      modal.hidden = true;
      el('askOk').onclick = null;
      el('askCancel').onclick = null;
      el('askClose').onclick = null;
      // 还原询问框结构，免得影响后面的普通询问
      clear(field); field.hidden = true;
      field.appendChild(h('span', { class: 'label', id: 'askLabel' }));
      field.appendChild(h('input', { class: 'input', id: 'askInput', type: 'text', autocomplete: 'off' }));
      void ok;
    };
    el('askCancel').onclick = () => finish(false);
    el('askClose').onclick = () => finish(false);
    el('askOk').onclick = () => {
      const oldP = el('pwOld').value, n1 = el('pwNew').value, n2 = el('pwNew2').value;
      if (!oldP || !n1) { toast('原口令与新口令都要填', 'warn'); return; }
      if (n1 !== n2) { toast('两次输入的新口令不一致', 'warn'); return; }
      if (n1.length < 6) { toast('新口令至少 6 位', 'warn'); return; }
      App.op('me.pwd', { oldPassword: oldP, newPassword: n1 }).then((r) => {
        if (r.ok) { toast('口令已修改，请用新口令重新登录', 'ok', 4000); setTimeout(() => location.replace('/login'), 1200); }
        else toast((r.data && r.data.message) || r.error || '修改失败', 'bad');
      });
    };
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 被顶下线时的处理
   *
   * 【背景】一个账号只能在一台设备登录。从新设备登录时，旧设备会被顶掉。
   * 旧设备必须**说得出为什么**，否则老师看到的是"怎么突然不能用了/
   * 是不是系统坏了/是不是被盗号了"。
   *
   * 两条路都会走到这里：
   *   · SSE 还连着 → 服务端断开前推一条 `bye`（带原因）
   *   · SSE 已断或页面刚刷新 → 主动问 `/api/session/note`
   *
   * 【为什么要立即 close 连接、并停掉各种定时器】
   * 那一刻会话已经不存在了，任何后续请求都会 401。
   * 不关掉的话页面会一边弹提示一边刷一堆 401，日志和界面都很乱。
   * ══════════════════════════════════════════════════════════════════════ */

  let kicked = false;

  /**
   * 处理"被顶下线"。
   *
   * 导出成 A.handleKicked(reason) 有两个原因：
   *   1. 回归测试可以直接调它，不用去等 8 秒轮询（无头浏览器里
   *      虚拟时间会让定时器不按时触发，那种测法又慢又不稳）；
   *   2. "被顶下线该做什么"本来就该是一处明确的逻辑，而不是藏在定时器里。
   */
  function onKicked(reason) {
    if (kicked) return;          // 可能 bye 和轮询同时报到，只处理一次
    kicked = true;
    const text = reason || '这个账号在另一台设备上登录了，你已被下线';
    try { if (S.stream && S.stream.close) S.stream.close(); } catch (e) { /* ignore */ }
    /* 把原因写进 localStorage 再跳 —— 登录页要读它。
       为什么不塞 URL 参数：这句话挺长，塞进去又长又容易被截；
       localStorage 是同源共享的，跳过去还在。 */
    try { localStorage.setItem('sports.kicked', text); } catch (e) { /* 隐私模式写不了就算了 */ }
    // 先让用户看清提示，再跳登录页（直接跳会让人一头雾水）
    try { toast(text, 'warn', 6000); } catch (e) { /* ignore */ }
    try { alert(text + '\n\n点“确定”后回到登录页。'); } catch (e) { /* ignore */ }
    try { location.replace('/login?next=/admin&kicked=1'); } catch (e) { /* ignore */ }
  }

  /** 定期问一句"我这条会话还在吗"——SSE 断了的时候靠它发现被顶下线 */
  function watchSession() {
    setInterval(() => {
      if (kicked) return;
      if (document.hidden) return;      // 页面不在前台就别问了
      App.api('/api/session/note').then((r) => {
        if (r.ok && r.data && r.data.reason) onKicked(r.data.reason);
      });
    }, 8000);
  }

  function startData() {
    refresh().then(() => {
      switchTab(S.tab);
      App.checkLayout('admin');
    });
    loadStaged();
    // 聊天与待确认这类"次要数据"延后 2.5 秒再拉：
    // 首屏只抢最关键的快照，后台在无人值守大屏/慢机器上打开更快
    setTimeout(() => { loadChat(); }, 2500);
    S.stream = App.stream('admin', (snap, meta) => {
      applySnapshot(snap, meta);
      loadStaged();
    }, setConn, onKicked);

    // 聊天：开着页面就能收未读
    setInterval(loadChat, 6000);
    /* 账号页的"在线/离线"要自己更新 —— 否则得手动切页签才看到变化，
       而"在线状态"恰恰是那种"放着不管就会过期"的信息。
       30 秒刷一次：离线窗口是 90 秒，够及时，也不至于一直请求。 */
    setInterval(() => {
      if (kicked) return;
      if (document.hidden) return;
      if (S.tab !== 'accounts') return;      // 只有停在账号页才刷，别白跑
      loadAccounts();
    }, 30000);
    watchSession();
    heartbeat();
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 心跳与"在线"状态
   *
   * 【为什么需要】账号页要显示"谁现在在线"。服务端靠 `session.lastSeenAt`
   * 判断（90 秒内活动过 = 在线），而 lastSeenAt 是"带 Cookie 的请求"刷新的
   * —— 所以要有人定时打一下。原来没有这个：老师早上登录、中午关掉网页，
   * 账号页到明天都还显示"已登录"，既没意义也容易误判。
   *
   * 30 秒一次：离线判定窗口是 90 秒，比心跳宽 3 倍 ——
   * 偶尔卡一下、手机切个网，都不会被人看成"掉线了"。
   *
   * 顺手让它把"会话已失效"也带回来（401）：SSE 断了的时候，
   * 这是发现自己被顶下线的另一条路（见 watchSession / onKicked）。
   * ══════════════════════════════════════════════════════════════════════ */

  function heartbeat() {
    setInterval(() => {
      if (kicked) return;
      if (document.hidden) return;      // 页面不在前台就别打，省电省流量
      App.api('/api/ping').then((r) => {
        if (r.status === 401 && !kicked) {
          // 会话没了：问一句为什么（被顶下线 / 过期 / 被停用）
          App.api('/api/session/note').then((n) => {
            onKicked((n.ok && n.data && n.data.reason) || '登录状态已失效，请重新登录');
          });
        }
      });
    }, 30000);
  }

  /* ── 导出 ────────────────────────────────────────────────────────────── */

  return {
    S, h, el, clear,
    toast, ask, openModal, closeModal,
    cmd, loadStaged, renderStageBar, val, setLocal,
    doPreview, doConfirm, doDiscard,
    bindEditable, switchTab, register, render, refresh,
    loadAccounts, loadAudit, loadBackups, loadChat, renderBadge,
    setConn, boot,
    applyRoleUI, canRole, flushPendingRender, markDirty, entryJump,
    statusText, statusTone,
    isUserTyping, captureFields, restoreFields, renderPendingHint,
    applySnapshot,
    modal,
    /* 被顶下线时的处理，单独暴露出来好测（也更好读） */
    handleKicked: onKicked,
    isKicked: () => kicked,
    api: App.api, op: App.op,
    fmtTime: App.fmtTime, fmtResult: App.fmtResult,
  };
})();
