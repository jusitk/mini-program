/* ============================================================================
 * common.js —— 前端公共库（大屏 / 后台 / 录入 / 登录 共用）
 *
 * 零框架、零构建、零外部资源。所有页面都先引 base.css + common.js。
 *
 * 内容分七块，按顺序读：
 *   1. 缩放与多比例屏幕适配   —— 这是"不同比例屏幕都要好看"的地基
 *   2. DOM 小工具
 *   3. 与服务器通信（API / SSE / 离线队列 / 冲突）
 *   4. 排版体检（页面自己发现"文字重叠/溢出/被裁切"）
 *   5. 时间与格式化
 *   6. 本地存储（草稿、队列、筛选条件）
 *   7. 面板布局引擎（大屏用：试出能放下的列数，量出每张卡能放几行）
 *
 * 【绝对不要做的两件事，历史上都塌过版面】
 *   · 不要用 getComputedStyle 去读自定义属性：未注册或含 clamp() 时返回的是文本，
 *     parseFloat 会得到 NaN。要数值就在 JS 里用同一套公式重算（本文件的 pxScale）。
 *   · 网格轨道里不要写 calc(数字 * var(--s))：会被当成"数字×数字"，
 *     整条 grid-template-columns 失效 → 网格塌成一列。用预算好的 --sp* 变量。
 * ========================================================================== */
'use strict';

(function (global) {
  const App = {};

  /* ══════════════════════════════════════════════════════════════════════
   * 1. 缩放与多比例屏幕适配
   * ══════════════════════════════════════════════════════════════════════ */

  const DESIGN = {
    base: 1080,   // 设计稿基准：按 1920×1080 画，1080p 上 1 设计像素 = 1 CSS 像素
    refW: 1920,
  };

  /** 户外模式倍数（数字越大字越大） */
  const MODES = {
    standard:  { scale: 1.00, cls: '' },
    large:     { scale: 1.12, cls: 'mode-outdoor' },      // 户外大
    huge:      { scale: 1.26, cls: 'mode-outdoor mode-huge' }, // 户外特大
  };

  /** 屏幕信息（每次 resize 重算） */
  let screenInfo = null;

  /**
   * 计算 --s 与全部 --sp* 变量，写到 documentElement 上。
   *
   * 为什么要"长宽比补偿"：
   *   只按高度缩放在两种屏上会失手 ——
   *   · 21:9 超宽屏：按高度算出的字相对整个宽度显得小，横向大片留白；
   *   · 竖屏/拼接墙（9:16）：按高度算出的字又过大，横向直接撑爆。
   *   所以按 aspect 再乘一个补偿系数，并且**限制在合理区间**，避免走极端。
   *
   * @param {string} mode standard | large | huge
   * @returns {{w:number,h:number,aspect:number,s:number,mode:string,columns:number}}
   */
  function pxScale(mode) {
    const w = Math.max(1, global.innerWidth || 1920);
    const h = Math.max(1, global.innerHeight || 1080);
    const aspect = w / h;                       // 16:9 ≈ 1.778
    const m = MODES[mode] || MODES.standard;

    const baseS = h / DESIGN.base;              // 高度决定主缩放
    // 长宽比补偿：以 16:9 为 1.0，超宽略放大、竖屏略缩小；指数 0.34 是手调出来的
    const aspectK = Math.pow(aspect / (16 / 9), 0.34);
    let s = baseS * aspectK * m.scale;
    s = Math.min(4.2, Math.max(0.42, s));       // 兜底夹紧，防止极端屏算出荒唐值

    const root = document.documentElement;
    root.style.setProperty('--s', String(Math.round(s * 10000) / 10000));

    /* 预算好带单位的间距变量（避免在 CSS 里出现 calc(数字 * 变量)）。
     *
     * 【为什么必须这样做 —— 2026-09 实测的严重问题】
     *   原来 CSS 里到处写 `calc(74 * var(--s))` 这种"数字 × 无单位变量"。
     *   在 **Chrome 153** 上这类声明会被**整条丢弃**：
     *       --s = 1.0483
     *       body 字号 calc(16 * var(--s)) → 计算值 16px（本该 16.77）
     *       .brand-meet 字号 calc(40 * var(--s)) → 16px（本该 41.9）
     *       某个 div 的 height: calc(20 * var(--s)) → 0px
     *   也就是**整个 --s 缩放体系全灭**：字号退回 16px、元素高度塌成 0。
     *   换成带单位的形式就正常：
     *       var(--sp16)            → 16.77px   ✔
     *       calc(16px * var(--s))  → 16.77px   ✔
     *   所以这里把 **CSS 里实际用到的每一个倍数**都生成成带 px 的变量，
     *   CSS 侧一律写 var(--spN)。
     *
     * 【命名】整数 → --sp74；小数 → --sp11_5（点换成下划线，免得变量名里带点）。
     * 【取值】整数 1 … 480 全生成；小数倍在下面单独列（CSS 里实际用到的那几个）。
     */
    for (let i = 1; i <= 480; i++) {
      root.style.setProperty('--sp' + i, (i * s).toFixed(2) + 'px');
    }
    // 小数倍：CSS 里写过 calc(11.5 * var(--s)) 这类，--spN 的循环生成不到
    [11.5, 12.5, 13.5, 16.5].forEach((v) => {
      root.style.setProperty('--sp' + String(v).replace('.', '_'), (v * s).toFixed(2) + 'px');
    });
    const ctl = Math.max(40, Math.round(40 * s)); // 触屏最小可点高度 40 CSS 像素
    root.style.setProperty('--ctl-h', ctl + 'px');

    /**
     * 表格/网格里的固定列宽，直接写成**像素值**。
     * 绝对不要写成 calc(30 * var(--s)) 存进自定义属性再放进 grid-template-columns ——
     * 那样有概率被判为无效，整条声明失效、名次行塌成一列（本项目真踩过这个坑）。
     */
    const colVars = { '--col-rank': 28, '--col-team': 130, '--col-score': 110, '--col-pts': 64, '--col-time': 64 };
    Object.keys(colVars).forEach((k) => {
      root.style.setProperty(k, Math.round(colVars[k] * s) + 'px');
    });

    // 户外模式 class（提亮对比度、加粗、加大安全边距）
    root.classList.toggle('mode-outdoor', !!m.cls);
    root.classList.toggle('mode-huge', m.cls.indexOf('huge') >= 0);

    screenInfo = {
      w, h, aspect, s, mode: m.cls ? mode : 'standard',
      shortEdge: Math.min(w, h), longEdge: Math.max(w, h),
      /** 建议栏数：超宽屏多排一栏 */
      columns: suggestColumns(aspect),
      scale01: (v) => v * s,
      scalePx: (v) => Math.round(v * s) + 'px',
      scalePx1: (v) => (v * s).toFixed(1) + 'px',
    };
    root.setAttribute('data-aspect',
      aspect >= 2.2 ? 'ultrawide' : aspect >= 1.55 ? 'wide' : aspect >= 1.15 ? 'classic' : 'portrait');
    return screenInfo;
  }

  /** 按长宽比给个"建议栏数"（真正的列数由布局引擎按实测尺寸试出来） */
  function suggestColumns(aspect) {
    if (aspect >= 3.2) return 4;   // 三联屏 / 超宽拼接
    if (aspect >= 2.2) return 4;   // 21:9
    if (aspect >= 1.55) return 3;  // 16:9 / 16:10
    if (aspect >= 1.15) return 2;  // 4:3
    return 1;                      // 竖屏
  }

  App.pxScale = pxScale;
  App.MODES = MODES;
  App.DESIGN = DESIGN;
  App.screen = function () { return screenInfo || pxScale('standard'); };

  /** 屏幕尺寸变化时重算（去抖 120ms；大屏会在回调里重排版面） */
  App.onResize = function (mode, fn) {
    let timer = null;
    const run = () => {
      pxScale(mode);
      if (typeof fn === 'function') fn(screenInfo);
    };
    global.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 120);
    });
    global.addEventListener('orientationchange', () => setTimeout(run, 200));
  };

  /* ══════════════════════════════════════════════════════════════════════
   * 2. DOM 小工具
   * ══════════════════════════════════════════════════════════════════════ */

  /**
   * 建元素：h('div', {class:'x', text:'字'}, [子元素...])
   * 属性里 on* 当事件、style 支持对象或字符串、dataset 支持对象。
   */
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class' || k === 'className') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'style') {
          if (typeof v === 'string') el.setAttribute('style', v);
          else for (const sk in v) el.style.setProperty(sk, v[sk]);
        } else if (k === 'dataset') {
          for (const dk in v) el.dataset[dk] = v[dk];
        } else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === 'value') {
          el.value = v;
        } else if (v === true) {
          el.setAttribute(k, '');
        } else {
          el.setAttribute(k, v);
        }
      }
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    if (children === null || children === undefined || children === false) return el;
    if (Array.isArray(children)) { children.forEach(c => append(el, c)); return el; }
    el.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
    return el;
  }

  function el(id) { return document.getElementById(id); }

  function clear(node) {
    if (!node) return node;
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /** 转义 HTML（只在必须用 innerHTML 时用） */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  App.h = h; App.el = el; App.clear = clear; App.esc = esc; App.append = append;

  /* ══════════════════════════════════════════════════════════════════════
   * 3. 与服务器通信
   * ══════════════════════════════════════════════════════════════════════ */

  let csrf = '';
  App.setCsrf = function (v) { csrf = v || ''; };
  App.getCsrf = function () { return csrf; };

  function reqId() {
    // 客户端唯一 id：服务端用它做幂等去重（断网重发不会录成两条）
    const rnd = (global.crypto && global.crypto.getRandomValues)
      ? Array.from(global.crypto.getRandomValues(new Uint8Array(9))).map(b => b.toString(16).padStart(2, '0')).join('')
      : Math.random().toString(16).slice(2) + Date.now().toString(16);
    return 'c_' + Date.now().toString(36) + '_' + rnd;
  }
  App.reqId = reqId;

  /**
   * 统一请求。写操作自动带 X-CSRF 与 clientUuid。
   * 返回 { ok, status, data, error, offline }
   */
  App.api = function (path, opts) {
    opts = opts || {};
    const init = {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: { 'Accept': 'application/json' },
      credentials: 'same-origin',
    };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    if (csrf && init.method !== 'GET') init.headers['X-CSRF'] = csrf;
    if (opts.headers) Object.assign(init.headers, opts.headers);

    const url = path + (opts.query ? ('?' + new URLSearchParams(opts.query).toString()) : '');
    const timeoutMs = opts.timeout || 20000;

    let timer = null;
    const ctrl = global.AbortController ? new AbortController() : null;
    if (ctrl) init.signal = ctrl.signal;

    return new Promise((resolve) => {
      if (ctrl) timer = setTimeout(() => ctrl.abort(), timeoutMs);
      fetch(url, init).then(async (res) => {
        clearTimeout(timer);
        let data = null;
        const text = await res.text();
        if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text }; } }
        // 写操作成功后通知后台主动拉一次最新数据 —— 见 App.onWrite
        if (res.ok && init.method !== 'GET' && typeof App.onWrite === 'function') {
          try { App.onWrite(path, data); } catch (e) { /* 通知失败不影响主流程 */ }
        }
        if (!res.ok) {
          resolve({
            ok: false, status: res.status, data,
            error: (data && (data.message || data.error)) || ('请求失败（HTTP ' + res.status + '）'),
            code: (data && data.code) || '',
          });
        } else {
          resolve({ ok: true, status: res.status, data });
        }
      }).catch((err) => {
        clearTimeout(timer);
        resolve({
          ok: false, status: 0, data: null, offline: true,
          error: (err && err.name === 'AbortError') ? '请求超时，请检查网络' : '网络连接失败，请检查网络或服务器',
        });
      });
    });
  };

  /** 发一条指令（写操作统一走这里） */
  App.op = function (op, payload, extra) {
    return App.api('/api/op', {
      method: 'POST',
      body: Object.assign({ op, payload: payload || {}, clientUuid: reqId() }, extra || {}),
    });
  };

  /** 批量指令（只推送一次大屏、只涨一个版本号） */
  App.opBatch = function (items) {
    return App.api('/api/op/batch', { method: 'POST', body: { items } });
  };

  /* ── SSE 实时推送：首包就是完整快照，客户端别把它当"一次变更"来计数 ───── */

  /**
   * 订阅实时数据。
   * @param {string} kind screen | admin | entry
   * @param {(snapshot:object, meta:object)=>void} onData
   * @param {(state:string, text:string)=>void} onStatus  state: ok|off|bad|poll
   * @param {(reason:string)=>void} [onBye] 服务端主动断开时调用
   *        （会话被顶下线 / 退出 / 改密 / 停用）。不传的话就当普通断线。
   * @returns {{close:Function, poll:Function}}
   */
  App.stream = function (kind, onData, onStatus, onBye) {
    // 静态体检模式：不建长连接（无头浏览器的 --dump-dom 会一直等页面安静，永远拿不到 DOM）
    if (App.isStaticMode && App.isStaticMode()) {
      if (typeof onStatus === 'function') onStatus('ok', '静态体检模式（未连实时通道）');
      App.api('/api/snapshot', { query: { kind } }).then((r) => {
        if (r.ok && r.data && typeof onData === 'function') onData(r.data, { via: 'static' });
      });
      return { close() {}, poll() {}, lastAt: () => Date.now() };
    }
    let es = null, closed = false, retry = 0, pollTimer = null, lastAt = 0;
    const setStatus = (s, t) => { if (typeof onStatus === 'function') onStatus(s, t); };

    function startPolling() {
      if (pollTimer || closed) return;
      setStatus('poll', '已切换为轮询（每 3 秒）');
      const tick = () => {
        App.api('/api/snapshot', { query: { kind } }).then(r => {
          if (closed) return;
          if (r.ok && r.data) { lastAt = Date.now(); onData(r.data, { via: 'poll' }); setStatus('ok', '已连接（轮询）'); }
          else setStatus('bad', '连接中断');
        });
      };
      tick();
      pollTimer = setInterval(tick, 3000);
    }

    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function connect() {
      if (closed) return;
      try { es = new EventSource('/api/stream/' + kind); }
      catch (e) { setStatus('bad', '连接中断'); startPolling(); return; }

      es.onopen = () => { retry = 0; setStatus('ok', '已连接'); };

      es.onmessage = (ev) => {
        if (closed) return;
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.type === 'ping' || msg.type === 'hello') {
          if (msg.type === 'hello') { retry = 0; stopPolling(); setStatus('ok', '已连接'); }
          return;
        }
        /* 服务端主动说"再见"：会话没了（被顶下线 / 退出 / 改密 / 停用）。
           【为什么必须处理】原来这里不看 bye —— 服务端把连接关了，
           客户端只当成"网络断了"，于是**不停重连**，页面还停在原地，
           用户完全不知道发生了什么（实测过：被顶下线后页面一直"正在重连"）。
           现在直接交给上层处理（一般是提示一句然后跳登录页）。 */
        if (msg.type === 'bye') {
          closed = true;
          clearInterval(watchdog);
          stopPolling();
          if (es) { try { es.close(); } catch (e) { /* ignore */ } es = null; }
          setStatus('off', msg.reason || '登录状态已失效');
          if (typeof onBye === 'function') onBye(msg.reason || '登录状态已失效');
          return;
        }
        lastAt = Date.now();
        stopPolling();
        if (msg.data) onData(msg.data, { via: 'sse' });
      };

      es.onerror = () => {
        if (closed) return;
        try { es.close(); } catch (e) { /* ignore */ }
        es = null;
        retry++;
        if (retry <= 3) setStatus('off', '连接不稳，正在重连…');
        else { setStatus('bad', '连接中断，正在重试'); startPolling(); }
        setTimeout(connect, Math.min(8000, 600 * Math.pow(1.6, retry)));
      };
    }

    connect();

    // 心跳看门狗：SSE 静默太久也认为断了（反代可能悄悄掐掉长连接）
    const watchdog = setInterval(() => {
      if (closed) return;
      if (lastAt && Date.now() - lastAt > 25000 && !pollTimer) {
        setStatus('bad', '连接中断，正在重试');
        startPolling();
      }
    }, 5000);

    return {
      close() {
        closed = true;
        clearInterval(watchdog);
        stopPolling();
        if (es) { try { es.close(); } catch (e) { /* ignore */ } es = null; }
      },
      poll: startPolling,
      lastAt: () => lastAt,
    };
  };

  /* ══════════════════════════════════════════════════════════════════════
   * 离线队列：断网时先把成绩存在本机，联网后自动补交
   *
   * 【为什么必须做真的】原来录入页在断网时提示"先存在本机，联网后自动补交"，
   * 但**根本没有入队**（只加了个样式类）—— 而且这个队列的 flush()
   * 在整个前端**从没被调用过**。裁判以为成绩保住了，一刷新就没了。
   * 现场断网是常事（操场 WiFi 覆盖差），这是最不能骗人的一处。
   *
   * 【三条设计要点】
   *   ① 按「账号 + 届次」隔离：同一个浏览器上换个账号登录，
   *      不该看到/补交别人的待提交记录。
   *   ② 补交靠 clientUuid：服务端有幂等表，同一条重发多少次都只生效一次。
   *      所以"其实服务器收到了、只是响应没回来"这种情况不会录成两条。
   *   ③ **被明确拒绝的（409 冲突 / 403 没权限 / 400 数据不合法）不能悄悄丢掉** ——
   *      原来是 `left.shift()` 无条件移除，等于把冲突默默扔了。
   *      现在留在队列里并标记出来，让人自己决定。
   * ══════════════════════════════════════════════════════════════════════ */

  const QUEUE_KEY = 'sports.queue.v3';
  const LEGACY_QUEUE_KEY = 'sports.queue.v2';

  /** 队列按 账号|届次 分桶 */
  function bucketKey() {
    const uid = (App.S && App.S.user && App.S.user.id) || 'anonymous';
    const meetId = (App.S && App.S.meetId) || 'default';
    return uid + '|' + meetId;
  }

  function readAll() {
    let obj = {};
    try { obj = JSON.parse(localStorage.getItem(QUEUE_KEY) || '{}') || {}; } catch (e) { obj = {}; }
    if (typeof obj !== 'object' || Array.isArray(obj)) obj = {};
    // 顺手把老版本的裸数组并进来（升版本时不能把裁判待提交的成绩弄丢）
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_QUEUE_KEY) || 'null');
      if (Array.isArray(legacy) && legacy.length) {
        const k = bucketKey();
        obj[k] = (obj[k] || []).concat(legacy);
        localStorage.setItem(QUEUE_KEY, JSON.stringify(obj));
        localStorage.removeItem(LEGACY_QUEUE_KEY);
      }
    } catch (e) { /* ignore */ }
    return obj;
  }

  function writeAll(obj) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(obj)); } catch (e) {
      // 本地存储满了：这是严重问题，必须让用户知道（否则又变成"以为存住了"）
      if (App.toast) App.toast('本机存储已满，断网成绩可能存不下，请尽快连上网络', 'bad', 8000);
    }
  }

  let flushing = false;

  App.queue = {
    /** 当前账号+届次的待提交条目 */
    all() {
      const all = readAll();
      return all[bucketKey()] || [];
    },
    /** 所有账号的待提交总数（换账号时提示用） */
    totalAll() {
      const all = readAll();
      return Object.keys(all).reduce((n, k) => n + (all[k] || []).length, 0);
    },
    size() { return App.queue.all().length; },
    /** 有待人工处理的（被服务端拒绝过的） */
    stuck() { return App.queue.all().filter(x => x.rejected); },

    push(item) {
      const all = readAll();
      const k = bucketKey();
      const list = all[k] || [];
      // 同一个 clientUuid 只留一条（用户重复点不算两条）
      const idx = list.findIndex(x => x.body && x.body.clientUuid && x.body.clientUuid === item.body.clientUuid);
      const rec = Object.assign({ at: Date.now(), tries: 0 }, item);
      if (idx >= 0) list[idx] = Object.assign({}, list[idx], rec); else list.push(rec);
      all[k] = list.slice(-500);
      writeAll(all);
      App.queue.notify();
      return all[k].length;
    },

    /** 把一条标记成"服务端明确拒绝了，等人处理" */
    markRejected(clientUuid, reason) {
      const all = readAll();
      const k = bucketKey();
      const list = all[k] || [];
      const i = list.findIndex(x => x.body && x.body.clientUuid === clientUuid);
      if (i >= 0) { list[i].rejected = reason || '服务端拒绝了这条改动'; list[i].at = Date.now(); }
      all[k] = list;
      writeAll(all);
      App.queue.notify();
    },

    /** 丢掉某一条（人工处理完之后） */
    drop(clientUuid) {
      const all = readAll();
      const k = bucketKey();
      all[k] = (all[k] || []).filter(x => !(x.body && x.body.clientUuid === clientUuid));
      writeAll(all);
      App.queue.notify();
    },

    clear() {
      const all = readAll();
      all[bucketKey()] = [];
      writeAll(all);
      App.queue.notify();
    },

    /** 订阅队列变化（页面顶部显示"待补交 N 条"用） */
    onChange(fn) {
      App.queue._subs = App.queue._subs || [];
      App.queue._subs.push(fn);
      return () => {
        App.queue._subs = (App.queue._subs || []).filter(f => f !== fn);
      };
    },
    notify() {
      (App.queue._subs || []).forEach((fn) => { try { fn(App.queue.size(), App.queue.stuck().length); } catch (e) { /* ignore */ } });
    },

    /**
     * 依次补交。
     *
     * 判定规则（这是原来最容易错的地方）：
     *   · 成功                     → 出队
     *   · 还是网络不通（offline）  → **停下**，剩下的留到下次（别把队列掏空）
     *   · 409 冲突                 → 留在队列里并标记，等人决定；**不自动重发**
     *   · 其它明确拒绝（403/400）  → 同样留下并标记（可能是账号权限变了、数据不合法）
     *
     * @param {(info:{sent:number,left:number,stuck:number})=>void} onProgress
     */
    async flush(onProgress) {
      if (flushing) return { sent: 0, left: App.queue.size(), busy: true };
      flushing = true;
      let sent = 0;
      try {
        let list = App.queue.all();
        if (!list.length) return { sent: 0, left: 0, stuck: 0 };
        while (list.length) {
          if (!navigator.onLine) break;                  // 浏览器自己说没网，别白试
          const item = list[0];
          // 已经标记为"被拒绝"的不自动重发（否则会一直撞同一堵墙）
          if (item.rejected) break;
          const r = await App.api(item.path, { method: 'POST', body: item.body });
          if (r.ok) {
            App.queue.drop(item.body.clientUuid);
            sent++;
          } else if (r.offline) {
            break;                                       // 还是断网
          } else if (r.status === 409 && r.data && r.data.code === 'CONFLICT') {
            /* 冲突：可能是"我这条其实已经生效了"（响应丢了之后我重发，
               而服务端记录已被别人改成了同样的值）。这种情况直接出队，
               不然会永远卡着一条其实已经生效的记录。 */
            const srv = r.data.detail && r.data.detail.server;
            const want = String(item.body.payload && item.body.payload.value);
            const serverVal = srv ? String(srv.raw === undefined ? srv.value : srv.raw) : '';
            if (item.sameValueAsk !== undefined && serverVal === want) {
              App.queue.drop(item.body.clientUuid);
              sent++;
            } else {
              App.queue.markRejected(item.body.clientUuid, r.error || '这条成绩在断网期间被别人改过');
              App.queue._conflicts = (App.queue._conflicts || []).concat([{
                item: item, server: srv, message: r.error,
              }]);
            }
          } else {
            // 其它明确拒绝：403 没权限、400 数据不合法等
            App.queue.markRejected(item.body.clientUuid, r.error || ('服务端拒绝（HTTP ' + r.status + '）'));
          }
          list = App.queue.all();
          if (onProgress) onProgress({ sent, left: list.length, stuck: App.queue.stuck().length });
          // 遇到被拒绝的就停下手上的循环，把决定权交给用户
          if (App.queue.stuck().length) break;
        }
        return { sent, left: App.queue.size(), stuck: App.queue.stuck().length };
      } finally {
        flushing = false;
        App.queue.notify();
      }
    },

    /** 最近一次补交里遇到的冲突（界面要弹出来让人选） */
    takeConflicts() {
      const c = App.queue._conflicts || [];
      App.queue._conflicts = [];
      return c;
    },
  };

  /** 判定要不要进离线队列：只有"网络不通"才排队；被服务端明确拒绝不算 */
  App.shouldQueue = function (resp) {
    return !!(resp && !resp.ok && resp.offline);
  };

  /**
   * 把一条写操作"先存本机"。
   * 这是录入页断网时该调用的函数 —— 调用它才算真的保住了。
   */
  App.queueWrite = function (path, body, meta) {
    return App.queue.push(Object.assign({ path: path, body: body }, meta || {}));
  };

  /** 页面启动时挂一次：恢复网络 / 定时 / 启动时各补交一次 */
  App.startQueueFlush = function (opts) {
    const o = opts || {};
    const run = () => {
      if (!App.queue.size()) return;
      App.queue.flush(o.onProgress).then((res) => {
        if (res.sent && o.onSent) o.onSent(res);
        // 有冲突：交回页面去弹窗（这里不擅自决定用谁的值）
        const cf = App.queue.takeConflicts();
        if (cf.length && o.onConflict) o.onConflict(cf);
        App.queue.notify();
      });
    };
    window.addEventListener('online', () => { setTimeout(run, 800); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });
    setInterval(() => { if (navigator.onLine) run(); }, 30000);
    setTimeout(run, 1500);                     // 启动时先试一次
  };

  /* ══════════════════════════════════════════════════════════════════════
   * 4. 排版体检
   *    大屏挂在电视上，出问题时开发者工具够不着，所以页面自己量：
   *    文字是否重叠、是否溢出容器、是否被裁切。结果写进 #layout-report（给自动化断言）
   *    并回报服务端（日志里搜 [页面问题]）。
   * ══════════════════════════════════════════════════════════════════════ */

  function layoutIssues(root) {
    root = root || document.body;
    const issues = [];
    const vw = global.innerWidth, vh = global.innerHeight;
    const MARGIN = 2;   // 容差：亚像素与圆角会带来 1~2px 误差，别误报

    /** SVG 内部的图形（circle/path/g）没有布局意义，跳过不计 */
    function inSvg(e) {
      const t = e.tagName ? e.tagName.toLowerCase() : '';
      if (t === 'svg') return false;                       // svg 本身要查（可能真的超出）
      return !!(e.ownerSVGElement);
    }

    /**
     * 这个元素是不是落在"可横向滚动"的祖先里（宽表外套的 .table-wrap、
     * 手机上横滑的页签栏）。是的话，"跑到视口右边"就是设计如此，不该报问题。
     * 只看元素自己不够 —— 它自己不滚动，是**祖先**在滚。
     */
    function hasScrollableXAncestor(e) {
      let p = e.parentElement;
      while (p && p !== document.body) {
        const ox = getComputedStyle(p).overflowX;
        if ((ox === 'auto' || ox === 'scroll') && p.clientWidth > 0 && p.scrollWidth > p.clientWidth + 1) {
          return true;
        }
        p = p.parentElement;
      }
      return false;
    }

    // 1) 内容比容器宽/高（出现滚动条或被隐藏）
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      if (e.closest('#layout-report')) continue;
      if (e.id === 'layout-report' || e.id === 'diagPlan') continue;   // 体检容器自己不算
      if (e.classList.contains('sr-only')) continue;                   // 隐藏文本天生裁切
      if (e.classList.contains('no-check')) continue;
      if (inSvg(e)) continue;                              // svg 内部图形跳过
      // 标了 data-allow-overflow 的整棵子树都不查：那是**有意**的溢出
      // （卡片内滚动、公告跑马灯、按算好列宽排的卡片区）
      if (e.closest('[data-allow-overflow]')) continue;
      if (e.hasAttribute('data-allow-overflow')) continue;
      const cs = global.getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;

      const overflowX = e.scrollWidth - e.clientWidth;
      const overflowY = e.scrollHeight - e.clientHeight;
      const canScrollX = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
      const canScrollY = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
      const clipsX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
      const clipsY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
      // 故意用省略号截断的（长项目名、长单位名）不算版面问题：
      // 排版上是"有意为之"，且缩写后仍然可读。真问题是没有省略号却把内容藏掉。
      const ellipsis = cs.textOverflow === 'ellipsis';

      if (overflowX > MARGIN && !canScrollX && !ellipsis) {
        issues.push({ kind: clipsX ? 'clipped' : 'overflow', axis: 'x', sel: sel(e), by: overflowX, text: brief(e) });
      }
      if (overflowY > MARGIN && !canScrollY && !clipsY) {
        // 纵向"内容比容器高"但容器没藏它（overflow:visible）= 页面可以往下滚，正常；
        // 只有真的被 hidden 藏掉了才算问题，交给下面这条判断。
        if (clipsY) {
          issues.push({ kind: 'clipped', axis: 'y', sel: sel(e), by: overflowY, text: brief(e) });
        }
      }

      // 2) 跑出屏幕：**只看水平方向**。
      //    垂直方向超出是"页面可以往下滚"，属正常（后台/录入页很长）；
      //    只有整页禁止滚动（大屏 body{overflow:hidden}）时纵向超出才是真问题，
      //    那种情况由上面的 clipped 检查兜住。
      //
      //    例外：元素落在**可横向滚动的容器**里（表格外面套的 .table-wrap、
      //    手机上横滑的页签栏）时不算问题 —— 那正是"宽表在小屏上横向滚"的设计，
      //    内容本来就会超出可视区。只看元素自己是不够的，要看祖先链。
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && !e.closest('[data-allow-overflow]')
        && !hasScrollableXAncestor(e)) {
        if (r.left < -MARGIN || r.right > vw + MARGIN) {
          issues.push({
            kind: 'outside', axis: 'x', sel: sel(e), text: brief(e),
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
            by: Math.round(r.right > vw ? (r.right - vw) : (0 - r.left)),
          });
        }
      }
    }

    // 3) 同级文本行重叠（只抽查带 data-row 的行，避免 O(n²) 把大屏拖卡）
    const rows = root.querySelectorAll('[data-row]');
    const byParent = new Map();
    for (let i = 0; i < rows.length; i++) {
      const p = rows[i].parentElement;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(rows[i]);
    }
    byParent.forEach((list) => {
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1].getBoundingClientRect();
        const b = list[i].getBoundingClientRect();
        if (b.top < a.bottom - 1.5 && b.top >= a.top && a.height > 0 && b.height > 0) {
          issues.push({
            kind: 'overlap', sel: sel(list[i]), text: brief(list[i]),
            by: Math.round(a.bottom - b.top),
          });
        }
      }
    });

    return issues;

    function sel(e) {
      if (!e || e === document.body) return 'body';
      const id = e.id ? '#' + e.id : '';
      const cls = e.className && typeof e.className === 'string'
        ? '.' + e.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
      return e.tagName.toLowerCase() + id + cls;
    }
    function brief(e) {
      const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
      return t.slice(0, 40);
    }
  }

  /**
   * 跑体检并把结果写进 #layout-report（同时回报服务端）。
   * @param {string} page 页面名（screen/admin/login/print）
   */
  App.checkLayout = function (page) {
    const box = el('layout-report');
    let issues = [];
    try { issues = layoutIssues(document.body); } catch (e) { issues = [{ kind: 'error', text: String(e && e.message) }]; }

    if (box) {
      box.textContent = issues.length
        ? ('版面问题 ' + issues.length + ' 处：' + issues.slice(0, 6).map(i => i.kind + ' ' + i.sel + (i.by ? '(' + i.by + 'px)' : '')).join('；'))
        : '版面检查通过';
      box.setAttribute('data-count', String(issues.length));
    }

    if (issues.length && global.__SPORTS_REPORT_LAYOUT__ !== false) {
      // 回报给服务端，现场不用开发者工具也能在日志里看到
      try {
        App.api('/api/diag/layout', {
          method: 'POST',
          body: { page, url: location.pathname, issues: issues.slice(0, 40), w: global.innerWidth, h: global.innerHeight },
        });
      } catch (e) { /* 体检本身不能把页面搞挂 */ }
    }
    return issues;
  };

  /** 埋一个全局错误上报（现场白屏时能查到原因） */
  App.installErrorReporting = function (page) {
    global.addEventListener('error', (ev) => {
      try {
        App.api('/api/diag/error', {
          method: 'POST',
          body: {
            page, message: String(ev.message || ''), source: String(ev.filename || ''),
            line: ev.lineno || 0, col: ev.colno || 0,
            stack: (ev.error && ev.error.stack) ? String(ev.error.stack).slice(0, 1200) : '',
          },
        });
      } catch (e) { /* ignore */ }
    });
    global.addEventListener('unhandledrejection', (ev) => {
      try {
        App.api('/api/diag/error', {
          method: 'POST',
          body: {
            page, message: 'Promise 未捕获：' + String((ev.reason && ev.reason.message) || ev.reason || ''),
            stack: (ev.reason && ev.reason.stack) ? String(ev.reason.stack).slice(0, 1200) : '',
          },
        });
      } catch (e) { /* ignore */ }
    });
  };

  /* ══════════════════════════════════════════════════════════════════════
   * 5. 时间与格式化
   * ══════════════════════════════════════════════════════════════════════ */

  const pad2 = (n) => String(n).padStart(2, '0');

  /** 成绩的规范显示：径赛秒数 → 12.35 / 2:15.30；田赛 → 5.67（由服务端给 display，这里是兜底） */
  App.fmtResult = function (value, kind) {
    if (value === null || value === undefined || value === '') return '';
    const v = Number(value);
    if (!isFinite(v)) return String(value);
    if (kind === 'field') return v.toFixed(2);
    if (v < 60) return v.toFixed(2);
    const m = Math.floor(v / 60);
    const s = v - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  };

  App.fmtTime = function (iso, withDate) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const t = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return withDate ? (d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + t) : t;
  };

  App.fmtDate = function (iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  };

  /* ── 项目时刻：只存 "HH:MM"（本届就一天，日期是多余的）──────────────────
   *
   * 【为什么不复用 fmtTime】项目时刻现在存的是 "07:40" 这种**纯时刻串**，
   *   而 `new Date("07:40")` 是**无效日期** —— 直接套 fmtTime 会返回空字符串，
   *   界面上什么都不显示（我实测过）。所以单独一套，认三种输入：
   *     "07:40"                  → 就是它
   *     "2026-09-30T07:40"       → 取 07:40（旧数据）
   *     "2026-09-30"             → 取 00:00 之外没有意义，按空处理
   *   旧的 ISO 值要能继续显示，否则历史数据会变成一片空白。
   */

  /** 项目时刻 → 显示用的 "H:MM"（没设返回 ''） */
  App.fmtClock = function (v) {
    const c = App.toClock(v);
    if (!c) return '';
    const m = c.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return '';
    return String(Number(m[1])) + ':' + m[2];
  };

  /** 任意历史值 → 规范成 "HH:MM"（拿不准返回 ''） */
  App.toClock = function (v) {
    if (!v) return '';
    const s = String(v).trim();
    // 已经是 HH:MM
    let m = s.match(/^(\d{1,2}):(\d{2})/);
    if (m) {
      const h = Number(m[1]), mi = Number(m[2]);
      if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) return pad2(h) + ':' + pad2(mi);
      return '';
    }
    // 旧的 ISO / 带日期的串 → 用 Date 解出时刻
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const d = new Date(s);
      if (isNaN(d.getTime())) return '';
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
    return '';
  };

  /** 输入框的值（time 类型要的就是 "HH:MM"）→ 提交给服务端的值 */
  App.fromClock = function (v) {
    const c = App.toClock(v);
    return c || null;         // 留空 = 不设
  };

  /* ── 并列精度（与后端 src/parse.js 同一套口径） ────────────────────────
   *
   * 判并列靠的是"成绩按这个精度取整后是否相同"，不是"差不超过某个数"。
   * 这里放一份是为了让管理界面能显示中文说法、并把老师选的档位规格化。
   * ⚠ 改这里的时候**必须同步改 src/parse.js**（那边才是真正算名次的地方）。
   *   tools/check-consistency.js 会核对两边的档位与说法是否一致。
   */
  App.precision = {
    PRESETS: [0.001, 0.01, 0.1, 1],
    LABEL: {
      0.001: '千分位（0.001 秒，终点摄像）',
      0.01: '百分位（0.01 秒，电子计时）',
      0.1: '十分位（0.1 秒，手工计时）',
      1: '整秒（1 秒）',
    },
    /** 田赛量具精度：1 厘米 */
    FIELD: 0.01,
    defaultFor(kind) { return kind === 'field' ? 0.01 : 0.01; },
    /** 把任意历史值归到最近的档位（与后端 normTol 一致） */
    norm(tol, kind) {
      const t = Number(tol);
      if (!Number.isFinite(t) || t <= 0) return this.defaultFor(kind);
      if (t >= 0.5) return 1;
      if (t >= 0.05) return 0.1;
      if (t >= 0.005) return 0.01;
      return 0.001;
    },
    decimals(tol) {
      const t = this.norm(tol);
      if (t >= 1) return 0;
      if (t >= 0.1) return 1;
      if (t >= 0.01) return 2;
      return 3;
    },
  };

  App.fmtClockSec = function (d) {
    d = d || new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  };

  /** 相对时间："3 分钟前" */
  App.fmtAgo = function (iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms)) return '';
    if (ms < 0) return '刚刚';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + ' 秒前';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' 分钟前';
    const hh = Math.floor(m / 60);
    if (hh < 24) return hh + ' 小时前';
    return Math.floor(hh / 24) + ' 天前';
  };

  /** 本地 datetime-local 值 → ISO（服务端按本地时区解释不带时区的串，这里直接给完整 ISO 更稳） */
  App.localInputToIso = function (v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  };

  App.isoToLocalInput = function (iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  };

  /* ══════════════════════════════════════════════════════════════════════
   * 6. 本地存储（草稿、筛选条件）
   * ══════════════════════════════════════════════════════════════════════ */

  App.store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem('sports.' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('sports.' + key, JSON.stringify(value)); } catch (e) { /* 满了就算了 */ }
    },
    del(key) { try { localStorage.removeItem('sports.' + key); } catch (e) { /* ignore */ } },
  };

  /* ══════════════════════════════════════════════════════════════════════
   * 7. 面板布局引擎（大屏核心）
   *
   * 目标：不同比例屏幕都好看，且**绝不裁切、绝不重叠**。
   * 做法（"量出来再排版"，不写死断点）：
   *   ① 先量出一行的实际高度（拿一张卡试排，读真实 offsetHeight），
   *      避免"写死的行高 × 缩放"在超宽/竖屏上估错。
   *   ② 从"理想列数"往下试：每一列按顺序填满行数，填不下的挪到下一列；
   *      只要有一列的行数放不下、或者总列数超过可用宽度，就减一列重试。
   *   ③ 试到 1 列一定能放下 —— 那时宁可少显示几行（列内滚动），也不重叠。
   * ══════════════════════════════════════════════════════════════════════ */

  /**
   * 计算栏数。
   * @param {object} o
   *   @param {Array}  o.items      面板数组（按优先级排序，越靠前越先放）
   *   @param {Array}  o.rows       每个面板需要的行数（与 items 等长）
   *   @param {number} o.cardW      单栏最小宽度（CSS 像素，已含缩放）
   *   @param {number} o.rowH       行高（CSS 像素，已含缩放）
   *   @param {number} o.contentW   可用宽度
   *   @param {number} o.contentH   可用高度（放头尾之后）
   *   @param {number} o.gap        栏间距
   *   @param {number} o.minRows    每栏最少要有的行数（标题/边框占位）
   * @returns {{columns:number, rowCap:number, filled:number, total:number}}
   */
  App.fitColumns = function (o) {
    const items = o.items || [];
    const rows = o.rows || [];
    const n = items.length;
    if (!n) return { columns: 1, rowCap: 1, filled: 0, total: 0 };

    const cardW = Math.max(120, o.cardW);
    const rowH = Math.max(10, o.rowH);
    const gap = o.gap || 0;
    const contentW = Math.max(1, o.contentW);
    const contentH = Math.max(1, o.contentH);
    const minRows = Math.max(1, o.minRows || 1);

    // 宽度上最多能排几列
    const maxByWidth = Math.max(1, Math.floor((contentW + gap) / (cardW + gap)));

    // 一栏里能放几行（行数上限）——这是"量"出来的，不是估的
    const rowCap = Math.max(minRows, Math.floor((contentH + gap) / (rowH + gap)));

    for (let cols = maxByWidth; cols >= 1; cols--) {
      if (cols === 1) return { columns: 1, rowCap, filled: Math.min(n, rowCap), total: n };
      // 单栏宽度（按等比分配，避免最后一栏被拉得很宽）
      const cw = (contentW - gap * (cols - 1)) / cols;
      if (cw < cardW - 0.5) continue;        // 排不下这么宽
      if (Math.ceil(n / cols) > rowCap) continue;  // 行数不够，减列
      return { columns: cols, rowCap, filled: n, total: n };
    }
    return { columns: 1, rowCap, filled: Math.min(n, rowCap), total: n };
  };

  /**
   * 把一个数组按"每页 rows 行、共 columns 列"切页。
   * 切页规则与布局引擎一致：按列填满，列的先后顺序 = 数组顺序（先上后下、先左后右）。
   * @returns {Array<Array>} pages，每页是 columns 个"列数组"
   */
  App.paginateColumns = function (list, columns, rows) {
    const perPage = columns * rows;
    const pages = [];
    const arr = list || [];
    for (let i = 0; i < arr.length; i += perPage) {
      const slice = arr.slice(i, i + perPage);
      const cols = [];
      for (let c = 0; c < columns; c++) cols.push(slice.slice(c * rows, (c + 1) * rows));
      pages.push(cols);
    }
    if (!pages.length) pages.push(new Array(columns).fill(null).map(() => []));
    return pages;
  };

  /**
   * 量一张"样板卡"的真实高度，用来算 rowCap。
   * 做法：把样板卡放进与真实栏位同宽的容器里，读 offsetHeight。
   * @param {HTMLElement} probe  已经渲染好内容的样板卡（或它的容器）
   * @param {number} perRow      这张卡一行的高度已经包含在内
   * @returns {number} 单行高度（CSS 像素）
   */
  App.measureRowHeight = function (probe) {
    if (!probe) return 0;
    const first = probe.querySelector('[data-row]');
    if (first) {
      const r = first.getBoundingClientRect();
      if (r.height > 1) return r.height;
    }
    const r2 = probe.getBoundingClientRect();
    return r2.height > 1 ? r2.height : 0;
  };

  /** 鼠标/触摸静止若干毫秒后回调（大屏控件自动隐藏用） */
  App.autoHideControls = function (idleMs, cb) {
    let timer = null;
    let hidden = false;
    const show = () => {
      if (hidden) { hidden = false; cb(false); }
      clearTimeout(timer);
      timer = setTimeout(() => { hidden = true; cb(true); }, idleMs || 5000);
    };
    ['mousemove', 'mousedown', 'touchstart', 'keydown', 'wheel'].forEach((ev) => {
      global.addEventListener(ev, show, { passive: true });
    });
    timer = setTimeout(() => { hidden = true; cb(true); }, idleMs || 5000);
    return { poke: show, isHidden: () => hidden };
  };

  /* ══════════════════════════════════════════════════════════════════════
   * 导出
   * ══════════════════════════════════════════════════════════════════════ */

  App.version = '2.0.0';

  /**
   * 「静态体检模式」：给自动化版面体检用。
   *
   * 为什么需要：大屏与后台都挂了 SSE 长连接，浏览器（无头模式的 --dump-dom）
   * 会一直等页面"安静下来"，结果永远不返回。所以体检时用 localStorage 打开这个开关，
   * 页面就只拉一次快照、不建长连接，DOM 立刻稳定，`node tools/browser-check.js` 才能拿到结果。
   *
   * 打开方式：localStorage.setItem('sports.staticMode','1') 然后刷新页面。
   * 现场遇到疑难版面问题时也可以这样开着看。
   *
   * 静态模式下还支持两个参数（浏览器体检脚本用）：
   *   ?_staticuser=admin&_staticpass=xxx  页面自己先调一次登录接口（同源，Cookie 会留下），
   *                                       这样就不需要"跳板页再跳转"（虚拟时间预算不够跳两次）
   *   ?static=1                           只用静态模式，不登录（大屏本来免登录）
   */
  App.isStaticMode = function () {
    try {
      if (global.localStorage.getItem('sports.staticMode') === '1') return true;
      const q = new URLSearchParams(global.location.search || '');
      return q.get('static') === '1' || q.get('_staticpass') !== null;
    } catch (e) { return false; }
  };
  App.setStaticMode = function (on) {
    try {
      if (on) global.localStorage.setItem('sports.staticMode', '1');
      else global.localStorage.removeItem('sports.staticMode');
    } catch (e) { /* ignore */ }
  };

  /**
   * 「可选图片」加载失败就隐藏。
   *
   * 【为什么需要】开源版不带任何单位标识（`public/img/school-logo.webp`），
   *   而三个页面（大屏 / 后台 / 登录）都有这个 `<img>`。图不在时浏览器会显示
   *   一个破图标、还可能占位把抬头挤歪。
   *   给这些 img 标上 `data-optional-img`，就在这里统一挂 onerror → 隐藏它。
   *
   * 为什么不用 `hidden` 属性：本系统多处 CSS 用 `display: flex` 布局，
   *   而 `hidden` 只对应 `display: none` 的**默认**样式，一旦有更高优先级的
   *   display 规则就会失效。所以直接写内联 `display: none`，最稳。
   */
  function hideOptionalImages() {
    try {
      const list = document.querySelectorAll('img[data-optional-img]');
      Array.prototype.forEach.call(list, (img) => {
        const hide = () => { img.style.display = 'none'; };
        /* 图已经加载失败过（缓存/早于本脚本执行）→ complete 且 naturalWidth 为 0 */
        if (img.complete && img.naturalWidth === 0) { hide(); return; }
        img.addEventListener('error', hide);
        if (!img.getAttribute('alt')) img.setAttribute('alt', '');   // 装饰性图片，读屏跳过
      });
    } catch (e) { /* 不影响页面 */ }
  }

  /**
   * 页面引导：静态模式下先（同步）登录，再执行真正的启动函数。
   * 用**同步 XHR** 是有意的：这样启动函数里发出的任何请求都天然带上了会话 Cookie，
   * 不需要把每个页面的启动流程改成异步（改动面最小、最不容易出错）。
   */
  App.bootstrap = function (bootFn) {
    let logged = false;
    try {
      const q = new URLSearchParams(global.location.search || '');
      const user = q.get('_staticuser');
      const pass = q.get('_staticpass');
      if (user && pass) {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/login', false);          // false = 同步
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify({ username: user, password: pass }));
        logged = xhr.status === 200;
      }
    } catch (e) { /* 登录失败就照常启动，页面自己会跳登录页 */ }
    void logged;
    hideOptionalImages();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootFn);
    else bootFn();
  };

  /** 页面诊断：把关键状态写进 #diagUi（自动化测试与现场排查都能读） */
  App.diag = function (page, data) {
    try {
      let box = document.getElementById('diagUi');
      if (!box) {
        box = document.createElement('div');
        box.setAttribute('id', 'diagUi');
        box.className = 'sr-only';
        box.setAttribute('aria-hidden', 'true');
        document.body.appendChild(box);
      }
      box.textContent = JSON.stringify(Object.assign({ page, at: Date.now() }, data || {}));
    } catch (e) { /* 诊断不能影响页面 */ }
  };

  /** 元素命中测试（排查"这里怎么有块奇怪的东西"用） */
  App.whatsAt = function (x, y) {
    try {
      return Array.prototype.slice.call(document.elementsFromPoint(x, y)).slice(0, 4).map((e) => {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return (e.tagName.toLowerCase() + '.' + String(e.className || '').split(' ').join('.'))
          + '[' + Math.round(r.width) + 'x' + Math.round(r.height)
          + ' bg=' + cs.backgroundColor + ' border=' + cs.borderLeftColor + ']';
      });
    } catch (e) { return []; }
  };

  global.App = App;
})(window);
