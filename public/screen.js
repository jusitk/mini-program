/* ============================================================================
 * screen.js —— 大屏（免登录只读，挂在电视/拼接屏上全天无人值守）
 *
 * 版面（参照学校官方颁奖屏）：
 *   顶部：校徽 + 会名 ｜ 中间"正在进行"条 ｜ 右侧大时钟与连接状态
 *   主体：左侧「成绩公告」多张项目卡片；右侧「赛程安排 / 检录 / 班级总分」
 *   底部：公告横幅 + 控制条（鼠标静止自动隐藏）
 *
 * 【三条必须守住的规则】
 *  1. 一屏放不下时**只有那张卡自己滚**名次，绝不裁切、绝不重叠；
 *     卡片高度按实际可用空间分配（量出来再排版，不靠估）。
 *  2. 每栏翻页时间互相错开；卡片正在滚名次时，该栏的翻页要等它滚完。
 *  3. 名次一律用服务端算好的快照（前端不算名次，四端口径才统一）。
 * ========================================================================== */
'use strict';

(function () {
  const App = window.App;
  const h = App.h, el = App.el, clear = App.clear;

  /* ── 节奏参数（现场觉得快慢不合适，只改这里）────────────────────────────
   *
   * 现场口径：**都调快**。原来一套 8~12 秒，户外大屏前的人根本等不到第二页
   * （看两眼就走了），信息等于没展示。现在的取值：
   *
   *   rotate     整栏翻页间隔（换一批项目/换一个年级）
   *   stagger    各栏起跑的错开量 —— 不能是 0，否则几栏同时翻页像"整屏闪一下"
   *   pageHold   卡片内每滚一屏停多久
   *   scrollMs   滚动动画时长（**要和 screen.css 里 .card-track 的 transition 对齐**）
   *
   * 三档显示模式（标准/户外大/户外特大）会在此基础上再乘一个系数，
   * 见 speedFactor()：字越大、看得越慢，停留时间相应放长一点。
   * ────────────────────────────────────────────────────────────────────── */
  const TIMING = {
    rotate: { score: 7000, schedule: 5500, classPoints: 5000, live: 5000 },
    stagger: { score: 0, schedule: 1500, classPoints: 3000 },
    pageHold: 2600,      // 卡片内每滚一屏停多久
    scrollMs: 420,       // 滚动动画时长（与 screen.css 的 transition 对齐）
    /* 栏目翻页前最多等卡片滚多久（毫秒）。
       实测老算法会算出 20.6 秒，成绩栏 3 页 → 一轮 60 秒，现场就是"不翻页"。
       封顶之后：等卡片把没显示过的屏滚一遍，但绝不长时间占着栏目。 */
    panelMaxHold: 8000,
  };

  /**
   * 显示模式对节奏的微调：字越大越难扫读，停留时间放长；
   * 但**不能把"快"又抵消掉**，所以系数只在 1.0~1.25 之间。
   */
  function speedFactor() {
    if (G.mode === 'huge') return 1.25;
    if (G.mode === 'standard') return 0.9;
    return 1;                       // 户外大（默认）
  }
  const tickMs = (key) => Math.round((TIMING.rotate[key] || 7000) * speedFactor());

  /* ── 全局状态 ────────────────────────────────────────────────────────── */
  const G = {
    snap: null,               // 最近一次快照（断网时保留，绝不白屏）
    lastUpdate: 0,
    mode: App.store.get('screenMode', 'large'),   // 默认"户外大"（大屏多在户外）
    plan: null,               // 布局计划
    panels: {},               // key → 面板实例
    marqueeUntil: 0,
    livePage: 0,
    noticePage: 0,
    pausedAll: false,
  };

  /* ══════════════════════════════════════════════════════════════════════
   * 快照读取（字段容错，缺什么都不崩）
   * ══════════════════════════════════════════════════════════════════════ */

  const P = (name, fallback) => (G.snap && G.snap.panels && G.snap.panels[name]) || fallback || [];
  /**
   * 左侧「成绩公告」要显示的卡片，**已结束的排在前面、聚在一起**。
   *
   * 【为什么要这样分】原来是 `live.concat(done)` —— 进行中的和已结束的混在
   *   一个列表里，翻页时同一页可能既有"刚比完、名次已定"的、又有"还在比"的，
   *   现场观感是"名次一会儿全一会儿不全"，分不清哪些是最终名次。
   *
   * 现在的口径：
   *   · **已结束（有最终名次）的在前**，最近的排最前 —— 同页上都是"定局"
   *   · 进行中的排最后，单独占页
   *   这样翻到前面几页就是在看**已经出完成绩的项目**，不会被"还在比"的打断；
   *   正在比赛的项目也不会被挤到看不见（它固定落在最后一页）。
   *
   * 注：分页是"这一列表按每页容量切"（见 renderScore），所以只要同类的连在
   *   一起，就不会出现"一半定局一半未定"同页的情况。
   */
  const eventList = () => {
    const done = doneList().slice();      // 服务端已按"最近结束"倒序给了
    const live = liveList().slice().sort((a, b) => {
      const ta = atMs(a.startAt), tb = atMs(b.startAt);
      if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
      if (!Number.isFinite(ta)) return 1;
      if (!Number.isFinite(tb)) return -1;
      return ta - tb;
    });
    return done.concat(live);
  };
  const liveList = () => P('live', []);
  const doneList = () => P('done', []);
  const noticeList = () => P('notice', []);
  const teamList = () => P('team', []);
  const teamMeta = () => (G.snap && G.snap.panels && G.snap.panels.teamMeta) || {};
  /**
   * 检录栏数据（`panels.checkin`）。
   * 大屏没有独立的"检录栏"了，但**赛程栏要用它**：服务端把"检录中"并进了
   * `panels.pending`、没放进 `panels.live`，所以赛程栏要显示检录中的项目
   * 只能从这里取（见 scheduleList）。
   */
  const checkinList = () => P('checkin', []);
  const cfg = () => (G.snap && G.snap.screen) || {};

  /** 班级总分按年级分组，顺序固定 初一 初二 初三 高一 高二 高三 */
  const GRADE_SEQ = ['初一', '初二', '初三', '高一', '高二', '高三'];

  /**
   * 每个年级内部**自己排一次序**，不复用"全校排序后的顺序" ——
   * 复用看着也对，但上游排序口径一变（加字段、改并列规则），
   * 大屏的名次就跟着安静地变。这里显式排，口径与服务端 teamTotals 一致：
   * 总分降序 → 金牌 → 银牌 → 铜牌 → 班级名（中文顺序）。
   */
  function gradePages() {
    const cmp = (a, b) => (b.points || 0) - (a.points || 0)
      || (b.gold || 0) - (a.gold || 0) || (b.silver || 0) - (a.silver || 0)
      || (b.bronze || 0) - (a.bronze || 0)
      || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
    const map = new Map();
    for (const t of teamList()) {
      const g = t.grade || '其它';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(t);
    }
    const known = GRADE_SEQ.filter(g => map.has(g));
    const extra = Array.from(map.keys()).filter(g => GRADE_SEQ.indexOf(g) < 0).sort();
    const order = known.concat(extra);
    if (!order.length) return [];
    return order.map(g => ({ grade: g, rows: map.get(g).slice().sort(cmp) }));
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 面板：一栏一个实例，各自翻页、各自暂停
   * ══════════════════════════════════════════════════════════════════════ */

  function createPanel(key, render) {
    const root = document.querySelector('[data-panel="' + key + '"]');
    const pause = root ? root.querySelector('[data-pause="' + key + '"]') : null;
    const inst = {
      key, root, pauseBtn: pause, render,
      page: 0, pages: 1,
      paused: !!((cfg().pause || {})[key]),
      scrollHoldUntil: 0,
      scrollers: [],
      timer: null,
      dueAt: 0,                     // 已排的下次翻页时刻（用来判"该不该重排"）
      /* 已经到点（或没排过）→ 可以接受重排；还没到点 → 不要往后推 */
      isDue() { return !this.dueAt || Date.now() >= this.dueAt; },
      lastSig: null,                // 上一次画出来的内容指纹（见 panelSig）
      body: el('body-' + key),
    };
    if (pause) {
      pause.addEventListener('click', () => {
        inst.paused = !inst.paused;
        syncPausedUI(inst);
        if (!inst.paused) schedulePanel(inst, 300);
      });
    }
    syncPausedUI(inst);
    return inst;
  }

  function syncPausedUI(inst) {
    if (!inst.root) return;
    inst.root.classList.toggle('is-paused', inst.paused);
    const b = inst.pauseBtn;
    if (b) {
      b.title = inst.paused ? '继续这一栏的翻页' : '暂停这一栏的翻页（不影响其它栏）';
      b.textContent = inst.paused ? '▶' : '❚❚';
      b.setAttribute('aria-pressed', inst.paused ? 'true' : 'false');
    }
  }

  /**
   * 排下一次翻页。
   *
   * 【为什么带"到期时刻"判重】**这个函数以前无条件重排** —— 每次收到数据
   *   （applySnapshot → relayout/refresh）都把"下次翻页"再往后推一整个周期。
   *   比赛期间数据来得很密，每来一条就推一次 → **永远轮不到翻页**。
   *   这就是"成绩公告栏长时间不翻页"的一半原因（另一半是滚动被重置，见 refresh）。
   *
   * 现在的口径：
   *   · 新到期时刻 **不晚于** 已排的那个 → 重排（内容变多了、要提前翻）
   *   · 新到期时刻更晚，但**这一轮还没到点** → 不重排（避免把翻页越推越远）
   *   · 已经在等滚动（`scrollHoldUntil`）→ 换成等滚动，否则"还没滚完就翻页"
   *   · 没有排过 → 正常排
   */
  function schedulePanel(inst, delay) {
    const want = Date.now() + Math.max(200, delay);
    if (inst.dueAt && !inst.isDue()) {
      const holdDue = inst.scrollHoldUntil || 0;
      if (holdDue > Date.now() && holdDue + 80 > inst.dueAt) {
        // 滚动还没完，翻页得往后等
      } else if (want >= inst.dueAt) {
        return;                       // 不值得为更晚的时刻重排
      }
    }
    clearTimeout(inst.timer);
    inst.dueAt = want;
    inst.timer = setTimeout(() => {
      inst.timer = null;
      if (G.pausedAll || inst.paused) { schedulePanel(inst, 900); return; }
      // 「滚完才翻页」：卡片还在滚名次时，等它滚完再翻
      const now = Date.now();
      if (inst.scrollHoldUntil > now) { schedulePanel(inst, inst.scrollHoldUntil - now + 80); return; }
      const total = Math.max(1, inst.pages);
      inst.page = (inst.page + 1) % total;
      paint(inst);
      schedulePanel(inst, tickMs(inst.key));
    }, Math.max(200, want - Date.now()));
  }

  /** 只有翻页时才重建 DOM（滚动过程里不动 DOM，避免闪） */
  function paint(inst) {
    if (!G.snap || !inst.body) return;
    stopScrollers(inst);
    try { inst.render(inst); } catch (err) {
      console.error('渲染栏目出错：' + inst.key, err);
    }
    /* 【必须重算指纹】画完之后的 DOM 对应的是"现在的数据"，
       指纹要跟着更新 —— 否则下一次 refresh 会认为"变了"，
       每来一条数据都重画，等于白做（而且滚动照样被重置）。 */
    try { inst.lastSig = panelSig(inst); } catch (e) { inst.lastSig = null; }
    syncPausedUI(inst);
    const pager = el('pager-' + inst.key);
    if (pager) {
      clear(pager);
      for (let i = 0; i < Math.max(1, inst.pages); i++) {
        pager.appendChild(h('i', { class: i === inst.page ? 'on' : '' }));
      }
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 卡片内自动滚动
   *   一屏放不下时只有这张卡自己滚，并把"滚完还要多久"写进 inst.scrollHoldUntil，
   *   让栏目翻页等它 —— 这就是"栏目翻页要等这张卡的名次都显示过"。
   *
   * 实现用**滚动容器的原生 scrollTop**，不用 transform 位移轨道：
   *   位移轨道能做出平滑动画，但内容会画到卡片外面 —— 实测卡片之间出现残影，
   *   加 overflow:hidden、contain:paint 都拦不住（那是绘制层的问题，不是布局问题）。
   *   滚动容器的滚动端口由浏览器保证裁剪，可视区外的行根本不参与绘制，才稳。
   *   代价是没有过渡动画；户外大屏上"看得清、不闪烁"比那点动画重要。
   * ══════════════════════════════════════════════════════════════════════ */

  function attachScroller(inst, card, scroller, track, totalRows, visibleRows) {
    if (totalRows <= visibleRows || visibleRows < 1 || !track.firstElementChild) return null;
    const rowH = track.firstElementChild.getBoundingClientRect().height;
    if (!rowH) return null;
    const pages = Math.ceil(totalRows / visibleRows);
    const sc = { card, scroller, track, rowH, visibleRows, pages, at: 0, timer: null, hint: null };
    // 提示挂在卡片上（classPoints 传进来的就是它的面板容器，同样有定位上下文）
    card.classList.add('has-scroll');

    const hint = h('div', { class: 'scroll-hint' }, [
      h('span', { text: '▼ 还有 ' + (totalRows - visibleRows) + ' 条，本栏自动滚动' }),
    ]);
    hint.dataset.row = '1';
    card.appendChild(hint);
    sc.hint = hint;

    /* 卡片内滚动的停留时间也跟着显示模式走（字越大停得稍久一点） */
    const holdMs = Math.round(TIMING.pageHold * speedFactor());
    const step = () => {
      if (G.pausedAll || inst.paused) { sc.timer = setTimeout(step, 900); return; }
      sc.at = (sc.at + 1) % pages;
      smoothScrollTo(scroller, sc.at * visibleRows * rowH);   // 动起来才看得出在滚
      sc.timer = setTimeout(step, holdMs);
    };
    sc.timer = setTimeout(step, holdMs);

    /* ── 告诉栏目"翻页前要等多久" ──────────────────────────────────────────
     * 这一栏翻页前要等这张卡把名次滚完（现场要求"卡片自己滚完再翻页"）。
     *
     * 【为什么以前会等 20 秒】老算法是 `pages * (holdMs + scrollMs)`：
     *   按"滚完**整轮**（所有屏）"算。一页 3~4 张卡都取 max，
     *   实测 `等滚动 20.6s`，而成绩栏共 3 页 → 一轮 60 秒，
     *   现场感觉就是"长时间不翻页"。
     *   而且卡片是**从第 1 屏开始显示**的（sc.at 初始为 0），
     *   本来就不需要等它回到第 1 屏 —— 那一段纯属白等。
     *
     * 现在的算法：
     *   · 只需 `pages - 1` 次滚动就能把**没显示过的**那些屏看完
     *   · 再**加一屏停留**，让最后一屏也看清
     *   · 封顶 `maxHoldMs`：宁可偶尔少看一屏，也不能让栏目卡住不翻
     *     （比赛期间大家盯着的是"哪个项目出成绩了"，不是同一张卡的第 5 屏）
     *   · 滚不动（只有一屏）就不设等待
     */
    const maxHoldMs = TIMING.panelMaxHold || 8000;
    const needMs = Math.max(0, pages - 1) * (holdMs + TIMING.scrollMs) + holdMs;
    if (needMs > 0) {
      inst.scrollHoldUntil = Math.max(inst.scrollHoldUntil || 0,
        Date.now() + Math.min(needMs, maxHoldMs));
    }
    return sc;
  }

  /**
   * 平滑滚到指定位置。
   *
   * 【为什么要自己写】原来直接 `el.scrollTop = y` 是**瞬间跳**，配合 96px 高的
   * 可视区，观感上像"闪了一下就没了"，现场反馈是"滚动没生效"。
   * CSS 的 `scroll-behavior: smooth` 在部分浏览器里对这种定时触发的滚动不生效
   * （而且没法控制时长），所以用 requestAnimationFrame 自己插值 ——
   * 时长就是 TIMING.scrollMs，改那个数就改了滚动手感。
   *
   * 尊重系统的"减弱动态效果"：那种情况直接跳到位（不插值）。
   */
  const reduceMotion = (function () {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  })();

  function smoothScrollTo(box, to) {
    if (!box) return;
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    const target = Math.max(0, Math.min(to, max));
    if (reduceMotion || TIMING.scrollMs <= 0) { box.scrollTop = target; return; }
    const from = box.scrollTop;
    if (Math.abs(target - from) < 1) return;
    const t0 = performance.now();
    const dur = Math.max(80, TIMING.scrollMs);
    const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);  // easeInOutQuad
    const frame = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      box.scrollTop = from + (target - from) * ease(p);
      if (p < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  function stopScrollers(inst) {
    (inst.scrollers || []).forEach(sc => {
      clearTimeout(sc.timer);
      sc.timer = null;
      // 提示要跟着一起撤掉：这张卡可能因为重排而不需要滚了，
      // 留着"▼ 还有 3 条"而实际上一条不少会让人以为漏了数据。
      if (sc.hint && sc.hint.parentNode) sc.hint.parentNode.removeChild(sc.hint);
      if (sc.card) sc.card.classList.remove('has-scroll');
    });
    inst.scrollers = [];
    inst.scrollHoldUntil = 0;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 成绩行与项目卡片
   * ══════════════════════════════════════════════════════════════════════ */

  function resultText(row) {
    // 显示文字以服务端给的 row.display 为准 —— 它已经把"犯规 / 弃权 / 成绩"分好了。
    // 这里以前先判 row.dnf 就 return '弃权'，于是"三次试跳全犯规"的人在大屏上
    // 被显示成"弃权"（名次表里 display 本来是对的，被这行覆盖掉了）。
    if (row.display) return row.display;
    if (row.dnf) return '弃权';
    const v = Number(row.value);
    if (!isFinite(v)) return '—';
    if (row.kind === 'field') return v.toFixed(2);
    if (v < 60) return v.toFixed(2);
    const m = Math.floor(v / 60), s = v - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }

  /**
   * 一条名次行：名次徽标 / 姓名(+号码) / 单位 / 成绩
   * 接力项目：姓名位显示班级名，下面用小字列出本班参赛的 4 名队员。
   */
  function resultRow(row) {
    const cls = ['row'];
    if (row.rank && row.rank <= 3 && !row.dnf) cls.push('top' + row.rank);

    const main = h('div', { class: 'who' }, [
      row.bib ? h('span', { class: 'bib', text: row.bib }) : null,
      h('span', { class: 'name', text: row.name || '' }),
    ]);
    if (row.isRelay && row.legs && row.legs.length) {
      main.appendChild(h('div', { class: 'legs', text: '参赛：' + row.legs.join('、') }));
    }

    const line = h('div', { class: cls.join(' ') }, [
      h('div', { class: 'rank', text: row.rank ? String(row.rank) : '—' }),
      main,
      h('div', { class: 'team', text: row.isRelay ? '' : (row.team || '') }),
      h('div', { class: 'score' + (row.dnf ? ' is-dnf' : ''), text: resultText(row) }),
    ]);
    line.dataset.row = '1';
    return line;
  }

  /** 项目卡片外壳（只有标题行；名次稍后填，这样能量到真实可用高度） */
  function eventCardShell(ev) {
    const head = h('div', { class: 'event-head' }, [
      h('div', { class: 'event-name', text: ev.name || '' }),
      h('div', { class: 'event-kind', text: ev.isRelay ? '接力' : (ev.kind === 'field' ? '田赛' : '径赛') }),
    ]);
    head.dataset.row = '1';
    const card = h('div', { class: 'event-card' }, [head]);
    if (ev.meta) card.appendChild(h('div', { class: 'event-meta', text: ev.meta }));
    const scroller = h('div', { class: 'card-scroller' });
    scroller.dataset.allowOverflow = '1';
    card.appendChild(scroller);
    return card;
  }

/**
 * 填一张卡的名次：按卡片**实际**可用高度决定显示几行，多的自己滚。
 * planH：这张卡被分配的高度（由 renderScore 算好）。
 *   一定要用传进来的 planH，不要回读 card.clientHeight —— 刚设完 style.height 时
 *   布局还没刷新，clientHeight 会返回旧值（很小），结果一屏只显示一行名次（踩过）。
 *   用 planH 也能顺带强制刷一次布局，后面量行高才是准的。
 * 返回这张卡实际显示了几行（show）—— renderScore 用它把卡片高度收紧到内容，
 *   否则项目少的时候每张卡会被拉满整页，中间一大块空白。
 */
function fillCard(inst, ev, card, planH) {
    const rows = ev.rows || [];
    const scroller = card.querySelector('.card-scroller');
    if (!scroller) return 0;
    clear(scroller);

    // 先读一次卡片真实高度：这一读会强制刷新布局，之后量的行高才准
    const cardH = planH || card.getBoundingClientRect().height || card.clientHeight;

    const track = h('div', { class: 'card-track' });
    /* 【录全了才展示名次】一个项目 20 人只录了 3 个就把名次挂出去，
       看着像最终结果、其实是半成品 —— 大屏前的观众会当成定局。
       所以没录全时**不显示名次行**，改显示"录到第几个了"。
       （老快照没有 resultsReady 字段时按"可以展示"处理，不至于白屏。） */
    const notReady = ev.resultsReady === false;
    if (notReady) {
      const done = Math.min(ev.recorded || 0, ev.total || 0);
      const box = h('div', { class: 'recording' }, [
        h('div', { class: 'rec-title', text: '成绩录入中' }),
        h('div', { class: 'rec-num', text: done + ' / ' + (ev.total || 0) }),
        h('div', { class: 'rec-hint', text: '录满后自动出榜' }),
      ]);
      box.dataset.row = '1';
      track.appendChild(box);
    } else if (!rows.length) {
      const e = h('div', { class: 'empty', text: '还没有录入成绩' });
      e.dataset.row = '1';
      track.appendChild(e);
    } else {
      rows.forEach(r => track.appendChild(resultRow(r)));
    }
    scroller.appendChild(h('div', { class: 'event-body' }, [track]));

    /* 量出"卡片里还剩多少高度给名次行"。
       这里全部用**实际测量**，不再用写死的常数（18/4 那类）—— 字号、间距一改就错。
       注意读 clientHeight 前先 getBoundingClientRect() 强制刷一次布局，
       否则刚设完 style.height 时读到的是旧值（很小）。 */
    void card.getBoundingClientRect();
    const chromeH = card.clientHeight || cardH;               // 卡片内可绘制高度（不含边框）
    const headH = card.querySelector('.event-head').getBoundingClientRect().height;
    const metaEl = card.querySelector('.event-meta');
    const metaH = metaEl ? metaEl.getBoundingClientRect().height : 0;
    // 底部"还有 N 条名次"是悬浮层，压在名次行上面，所以只预留一行字高
    const hintReserve = Math.round(App.screen().scale01(18));
    const listH = Math.max(12, chromeH - headH - metaH - hintReserve);
    const firstRow = track.firstElementChild;
    const rowH = firstRow ? firstRow.getBoundingClientRect().height : 0;
    if (!rowH) { scroller.style.maxHeight = listH + 'px'; return 0; }

    // 行高兜底：万一被压缩，按"设计最小行高"算，避免一屏只显示一行
    const minRowH = App.screen().scale01(30);
    const useRowH = Math.max(rowH, minRowH);
    const fits = Math.max(1, Math.floor((listH + 2) / (useRowH + 2)));
    const show = Math.min(rows.length, fits);
    // 行高被压过就显式写回，保证名次行看起来是正常的一行
    if (useRowH > rowH) {
      Array.from(track.children).forEach((r) => { r.style.height = useRowH + 'px'; });
    }
    scroller.style.height = (useRowH * show + 2) + 'px';   // 写死高度（不用 max-height，避免内容把它顶开）
    scroller.style.maxHeight = (useRowH * show + 2) + 'px';
    // 诊断（自动化与现场排查都靠它）：把这张卡的实测数字写出来
    logCardDiag({
      ev: ev.name, planH: Math.round(planH || 0), cardH: Math.round(cardH),
      actual: Math.round(card.getBoundingClientRect().height), chromeH: Math.round(chromeH),
      headH: Math.round(headH), metaH: Math.round(metaH), hintReserve,
      listH: Math.round(listH), rowH: Math.round(rowH), minRowH: Math.round(minRowH),
      useRowH: Math.round(useRowH), fits, show, rows: rows.length,
      bodyH: Math.round((plan0() || {}).bodyH || 0), rowCap: (plan0() || {}).rowCap,
      cardCols: (plan0() || {}).cardCols,
    });
    if (show < rows.length) {
      const sc = attachScroller(inst, card, scroller, track, rows.length, show);
      if (sc) inst.scrollers.push(sc);
    }
    return show;
  }

  /**
   * 把卡片高度收紧到"内容真正需要的高度"。
   *
   * 【为什么要这一步】computePlan 算出的槽位高度是为了**尽量多塞内容**
   * （bodyH / 行数），项目少的时候这个高度远大于实际内容 ——
   * 实测只有 1 个项目 6 条成绩时，卡片被拉成 500+px，卡里一大块空白，
   * 名次挤在顶上，看着像"版面没排好"。
   * 做法：先按槽位高度填一次，问出实际显示了几行，再把高度改成
   * 骨架 + 行数×行高；然后**原地重填一次**（行数只会变多不会变少，不会来回抖）。
   */
  function tightenCard(inst, ev, card, planH) {
    const show = fillCard(inst, ev, card, planH);
    if (!show) return;
    const scroller = card.querySelector('.card-scroller');
    if (!scroller) return;
    // 直接量：卡片高度 - 滚动区高度 = 骨架（标题 + 副信息 + 上下内边距）。
    // 想要的高度 = 骨架 + 滚动区实际高度（它已经按 show 行写死了）。
    const actualH = card.getBoundingClientRect().height;
    const scH = scroller.getBoundingClientRect().height;
    const frameH = Math.max(0, actualH - scH);
    const want = Math.round(frameH + scH + 4);
    if (!(want > 0) || want >= planH - 4) return;             // 本来就贴满，别动
    card.style.height = want + 'px';
    fillCard(inst, ev, card, want);                           // 重填：矮了以后行数只会变多
  }

  function plan0() { return G.plan || null; }

  /** 把每张卡的排版数字拼进 #diagCard（只保留最近 12 张，避免无限增长） */
  function logCardDiag(o) {    try {
      const box = el('diagCard');
      if (!box) return;
      const arr = box.textContent ? JSON.parse(box.textContent) : [];
      arr.push(o);
      while (arr.length > 12) arr.shift();
      box.textContent = JSON.stringify(arr);
    } catch (e) { /* 诊断不能影响渲染 */ }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ① 成绩公告（左侧主体）
   * ══════════════════════════════════════════════════════════════════════ */

  /**
   * 一栏"当前显示的东西"的指纹。
   *
   * 【为什么要这个 —— 修的是"成绩公告栏长时间不翻页"】
   *   大屏每次收到数据（别人录一条成绩就推一次）都会走
   *   `applySnapshot → relayout() → paint() → stopScrollers()`，
   *   把**所有**翻页计时器和卡片滚动计时器清掉重建。
   *   而成绩卡一旦放不下就要滚，每张卡会往 `scrollHoldUntil` 写
   *   "滚完要 X 秒"（6 屏 ≈ 6×(2.6+0.42) ≈ 18 秒），栏目翻页必须等它。
   *
   *   比赛期间数据来得很密 → 每来一条就重置一次 → 那 18 秒**永远等不到头**
   *   → 成绩公告栏看起来就是"死在那儿不翻页"。
   *
   * 有了指纹就能判断：**这一页要显示的内容没变，就别重建 DOM、别动滚动**。
   *   只有内容真的变了（新项目上榜、名次变了、页容量变了、翻页了）才重画。
   *
   * 指纹只包含**显示得出来的**字段：内部计数器变化（有人报名但还没成绩之类）
   *   不会触发重画 —— 这正是我们要的，那些变化在大屏上看不见。
   */
  function panelSig(inst) {
    const plan = G.plan || {};
    const head = (G.snap && G.snap.rev !== undefined ? G.snap.rev : '?') + '|'
      + inst.page + '|' + inst.pages + '|'
      + (plan.rowCap || 0) + '|' + (plan.cardCols || 0);

    if (inst.key === 'score') {
      const all = eventList();
      const rows = Math.max(1, plan.rowCap || 2);
      const cols = Math.max(1, plan.cardCols || 1);
      const perPage = Math.max(1, rows * cols);
      return head + '#' + all.slice(inst.page * perPage, (inst.page + 1) * perPage)
        .map(ev => ev.id + ':' + ev.status + ':' + (ev.recorded || 0) + '/' + (ev.total || 0)
          + ':' + (ev.rows || []).map(r => r.rank + ',' + r.display + ',' + (r.name || '')
            + ',' + (r.bib || '') + ',' + ((r.legs || []).join('/'))).join(';'))
        .join('||');
    }
    if (inst.key === 'schedule') {
      return head + '#' + scheduleList().map(e => e.id + ':' + e.status + ':' + (e.name || '')).join('||');
    }
    if (inst.key === 'classPoints') {
      /* 只把**当前这一页**（一个年级）的班算进指纹 —— 渲染只看 pages[inst.page]，
         别的年级变了不影响屏幕上的东西。 */
      const pages = gradePages();
      const g = pages[inst.page];
      return head + '#' + (g ? (g.grade + '=' + g.rows
        .map(t => t.name + ',' + t.points + ',' + (t.classRank || t.rank)
          + ',' + (t.gold || 0) + ',' + (t.silver || 0) + ',' + (t.bronze || 0)).join(';')) : '');
    }
    // 认不出的栏目：不缓存（每次都重画），宁可多画也别显示旧数据
    return null;
  }

  /**
   * 数据变了之后的刷新。
   *
   * 【和 paint 的分工】
   *   `paint`  = 强制重画（翻页、切显示模式、点刷新时用）—— 会重建 DOM、重置滚动
   *   `refresh`= 数据驱动的刷新 —— **内容没变就不动 DOM**
   *
   * 两者最终都会把翻页计时器重新排上，但 refresh 在"内容没变"时
   * **保留正在进行的卡片滚动**（不重置 scrollHoldUntil），这样翻页才等得到头。
   */
  function refresh(inst) {
    if (inst.page >= Math.max(1, inst.pages)) inst.page = 0;
    const sig = panelSig(inst);

    if (sig === null || sig !== inst.lastSig) {
      paint(inst);                 // 内容真的变了 → 重画（paint 会顺带更新 lastSig）
    } else {
      // 内容没变：不动 DOM，也不动正在跑的滚动计时器
      reflowForSure(inst);
      syncPausedUI(inst);
    }
    /* 【不要无条件重排】重排会把"下次翻页"再往后推一整个周期。
       schedulePanel 自己会判重（新到期时刻更晚且还没到点就不重排），
       所以这里直接调它就行 —— 内容变多了它会提前翻，没变就不动。 */
    schedulePanel(inst, tickMs(inst.key));
  }

  /** 贴一下"确定要重算布局"：某些栏目（班级总分）滚动区高度依赖面板实高 */
  function reflowForSure(inst) {
    try {
      if (inst.key === 'classPoints') {
        const sideH = planSideHeights();
        if (sideH && sideH.classPoints) {
          const sec = document.querySelector('[data-panel="classPoints"]');
          if (sec) sec.style.height = sideH.classPoints + 'px';
        }
      }
    } catch (e) { /* 不影响渲染 */ }
  }

  function renderScore(inst) {
    const all = eventList();
    const plan = G.plan || {};
    const rows = Math.max(1, plan.rowCap || 2);
    const cols = Math.max(1, plan.cardCols || 1);
    const perPage = Math.max(1, rows * cols);
    inst.pages = Math.max(1, Math.ceil(all.length / perPage));
    if (inst.page >= inst.pages) inst.page = 0;

    const slice = all.slice(inst.page * perPage, (inst.page + 1) * perPage);
    clear(inst.body);
    if (!slice.length) {
      inst.body.appendChild(h('div', { class: 'empty', text: '还没有项目数据' }));
      el('scoreSub').textContent = '';
      return;
    }

    const gap = plan.gap || 10;
    const cs = window.getComputedStyle(inst.body);
    const bodyW = inst.body.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
    const bodyH = inst.body.clientHeight - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0);
    const usedCols = Math.max(1, Math.min(cols, Math.ceil(slice.length / rows)));
    const colW = Math.max(160, Math.floor((bodyW - gap * (usedCols - 1)) / usedCols));
    const cardH = Math.max(60, Math.floor((bodyH - gap * (rows - 1)) / rows));

    const grid = h('div', { class: 'grid-cards' });
    grid.dataset.allowOverflow = '1';
    const cards = [];
    for (let c = 0; c < usedCols; c++) {
      const col = h('div', { class: 'grid-col' });
      col.style.flex = '0 0 ' + colW + 'px';
      col.style.width = colW + 'px';
      slice.slice(c * rows, (c + 1) * rows).forEach((ev) => {
        const card = eventCardShell(ev);
        card.style.height = cardH + 'px';
        col.appendChild(card);
        cards.push({ ev, card });
      });
      grid.appendChild(col);
    }
    inst.body.appendChild(grid);
    cards.forEach(({ ev, card }) => tightenCard(inst, ev, card, cardH));

    const live = P('live', []).length, done = doneList().length;
    el('scoreSub').textContent = '共 ' + all.length + ' 个项目　·　进行中 ' + live + '　已结束 ' + done
      + '　第 ' + (inst.page + 1) + '/' + inst.pages + ' 页';
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ② 赛程安排（右侧上）
   *
   * 【只显示"正在检录"和"正在进行"的项目】现场口径：
   *   这一栏是**看当下**的 —— 正在检录的（该去报到了）、正在比赛的（成绩马上来）。
   *   已经结束的不用再挂着（成绩已经进左边卡片了），
   *   还没开始的也不用提前占地方（要看整体安排的人看秩序册更合适）。
   *
   * 【走过的弯路】中间版本为了"信息全"，还列了"刚结束的 3 个"和
   *   "接下来 6 个马上要上的"。实际站在大屏前看：结束的那几条没人看
   *   （成绩在左边），下面那几条又一直在变、反而干扰"现在到底在比什么"。
   *   所以就留"正在发生"的，一屏放得下、也不用翻页。
   *
   * 判据只用 **status**（checking / live），不靠起止时间推算 ——
   *  项目状态现在全靠人工/检录结果，时间只用于显示与排序（见 admin-events.js）。
   * ══════════════════════════════════════════════════════════════════════ */

  /**
   * 把一个时刻值换算成毫秒时间戳。
   *
   * 【为什么要单独处理 "HH:MM"】项目现在只存时刻（如 "07:40"），
   * 而 `new Date("07:40")` 是**无效日期** —— 直接套会返回 NaN，
   * 于是所有按时刻排序的地方都会静默失效。
   * 这里把纯时刻补上"今天"，得到一个真实时间戳。
   *
   * 跨零点不用操心：一届比赛是同一天、从早开到下午。
   */
  function atMs(s) {
    if (!s) return NaN;
    const str = String(s).trim();
    const m = str.match(/^(\d{1,2}):(\d{2})/);
    if (m) {
      const d = new Date();
      d.setHours(Number(m[1]), Number(m[2]), 0, 0);
      return d.getTime();
    }
    const t = new Date(str).getTime();
    return Number.isFinite(t) ? t : NaN;
  }

  /**
   * 赛程要展示的条目 —— **只保留"正在检录"和"正在进行"的**。
   *
   * 【数据从哪来（这里踩过一次坑）】
   *   `panels.live` 里**只有 status==='live'** —— 检录中的项目不在里面，
   *   服务端把 checking 并进了 `panels.pending`（见 scoreboard.js 的
   *   `pendingEvents = pending || checking`）。
   *   所以"检录中"必须从 `panels.checkin` 取（那是检录栏的权威来源，
   *   含所有"检录开关开着"的项目）。只用 panels.live 会漏掉检录中的项目。
   *
   * 排序：正在比赛的排前面（成绩马上要出，更要紧），然后按开始时间。
   */
  function scheduleList() {
    const now = Date.now();

    /** 从检录栏条目转成赛程条目要的样子（它带了整份名单，这里用不上，丢掉） */
    function fromCheckin(c) {
      const people = c.people || [];
      const total = c.total === undefined ? people.length : c.total;
      const arrived = c.arrived === undefined
        ? people.filter(p => p && p.arrived).length : c.arrived;
      return {
        id: c.id,
        name: c.name,
        status: c.status === 'live' ? 'live' : 'checking',
        startAt: null,
        endAt: null,
        meta: total ? ('检录 ' + arrived + '/' + total + ' 人') : '',
      };
    }

    const byId = new Map();
    // ① 进行中的（panels.live 里全是 status==='live'）
    liveList().forEach((e) => {
      if (!e || !e.id) return;
      byId.set(e.id, {
        id: e.id, name: e.name, status: 'live',
        startAt: e.startAt, endAt: e.endAt, meta: e.meta || '',
      });
    });
    // ② 检录中的（检录栏里那些还没变成"进行中"的）
    checkinList().forEach((c) => {
      if (!c || !c.id) return;
      if (byId.has(c.id)) return;                  // 进行中的已经在上面了
      if (c.open === false && c.status !== 'checking') return;
      byId.set(c.id, fromCheckin(c));
    });

    const all = Array.from(byId.values())
      /* 显式只留这两种状态 —— 待进行(pending)和已结束(done)一律不展示。
         写在这里而不是靠"上游没给"，是为了让规则一眼看得见：
         上游以后若往 panels.live / panels.checkin 里多塞了别的状态，
         这一行也能兜住，不会悄悄漏到赛程栏。 */
      .filter(e => e.status === 'checking' || e.status === 'live');
    const live = all.filter(e => e.status === 'live');
    const checking = all.filter(e => e.status === 'checking');
    return live.concat(checking)
      .sort((a, b) => {
        const ta = atMs(a.startAt), tb = atMs(b.startAt);
        if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
        if (!Number.isFinite(ta)) return 1;
        if (!Number.isFinite(tb)) return -1;
        return ta - tb;
      })
      .map(e => Object.assign({}, e, { _now: now }));
  }

  function renderSchedule(inst) {
    const list = scheduleList();
    const perPage = Math.max(1, inst.rowCap || 5);
    inst.pages = Math.max(1, Math.ceil(list.length / perPage));
    if (inst.page >= inst.pages) inst.page = 0;

    clear(inst.body);
    const slice = list.slice(inst.page * perPage, (inst.page + 1) * perPage);
    if (!slice.length) {
      // 一屏都没有"正在发生"的项目 —— 说清是"现在没有"，不是"系统坏了"
      inst.body.appendChild(h('div', { class: 'empty', text: '现在没有正在检录或比赛的项目' }));
      el('scheduleSub').textContent = '';
      return;
    }
    slice.forEach((ev, i) => {
      const isNext = inst.page === 0 && i === 0;
      const isChecking = ev.status === 'checking';
      /* 【左边不再显示时刻】按用户要求，项目上不出现任何时间标签。
         原来这一列是"07:40 / 还有 12 分钟"，现在整列只剩一个状态小签
         （检录 / 进行中）—— 一行里最要紧的本来就是"现在能不能去看"。
         时刻仍然存在库里（用于排序），只是不显示。 */
      const left = isChecking
        ? h('span', { class: 'sched-flag is-checking', text: '检录' })
        : h('span', { class: 'sched-flag is-live', text: '进行中' });
      const item = h('div', { class: 'sched-item' + (isNext ? ' is-next' : '') }, [
        h('div', { class: 'sched-time' }, [left]),
        h('div', { class: 'sched-main' }, [
          h('div', { class: 'sched-name', text: ev.name || '' }),
          h('div', { class: 'sched-meta', text: ev.meta || '' }),
        ]),
      ]);
      item.dataset.row = '1';
      inst.body.appendChild(item);
    });
    const liveN = list.filter(e => e.status === 'live').length;
    const ckN = list.filter(e => e.status === 'checking').length;
    el('scheduleSub').textContent = '进行中 ' + liveN + (ckN ? ('　·　检录中 ' + ckN) : '')
      + (inst.pages > 1 ? ('　·　第 ' + (inst.page + 1) + '/' + inst.pages + ' 页') : '');
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ③ 检录栏 —— 已从大屏去掉
   *
   * 原来右侧是三栏（赛程 / 检录 / 班级总分），各占三分之一高度：
   *   · 两栏都被压扁，赛程只显示 2~3 条、班级总分一个年级都放不下
   *   · 检录信息本身是"给检录台用"的（谁没到、到几个），
   *     现场那台电脑和后台的「检录」页签看得更清楚
   * 所以大屏不再展示检录，把整列让给赛程与班级总分。
   * 检录的**数据**照旧在快照里（`panels.checkin`），后台/手机端仍在用；
   * 只是大屏不画它了。
   * ══════════════════════════════════════════════════════════════════════ */

  /* ══════════════════════════════════════════════════════════════════════
   * ④ 班级总分（右侧下）：按年级翻页（初一→初二→初三→高一→高二→高三）
   * ══════════════════════════════════════════════════════════════════════ */

  /**
   * 班级总分：按年级翻页（初一→初二→初三→高一→高二→高三）。
   *
   * 【名次口径】显示的是**本年级名次**（`classRank`），不是全校总名次。
   * 初一和初三的班拿同样的分数含金量完全不同（人多人少、项目多少不一样），
   * 混在一起排出来的"第 7 名"没有意义，也没有对应的名次分。
   * 现场关心的就是"我们在本年级排第几"，所以这里按年级分组排。
   * 全校总名次（`rank`）仍然保留 —— 导出"总榜"和后台排序用的还是它。
   *
   * 【为什么这里也要能滚】一个年级的班可能很多（实测高一/高二各 10 个班，
   * 再加上"其它"能到十几行），而面板只放得下 9 行。
   * 原来超出部分**直接不渲染**，只留一句"▼ 还有 N 个班级" ——
   * 那 N 个班的名次在大屏上根本看不到。现在改成滚动显示，一个都不少。
   */
  function renderClassPoints(inst) {
    const pages = gradePages();
    inst.pages = Math.max(1, pages.length);
    if (inst.page >= inst.pages) inst.page = 0;

    clear(inst.body);
    if (!pages.length) {
      inst.body.appendChild(h('div', { class: 'empty', text: '还没有可统计的已结束项目' }));
      el('classSub').textContent = '';
      return;
    }
    const g = pages[inst.page];
    const gradeLine = h('div', { class: 'grade-line' }, [
      h('span', { text: g.grade }),
      h('span', { class: 'n', text: '共 ' + g.rows.length + ' 个班级　·　本年级排名' }),
    ]);
    inst.body.appendChild(gradeLine);

    // 可滚动区：高度 = 面板可用高度 - 年级标题行，用普通块级元素包轨道
    const scroller = h('div', { class: 'card-scroller' });
    scroller.dataset.allowOverflow = '1';
    inst.body.appendChild(scroller);

    const track = h('div', { class: 'pts-track' });
    g.rows.forEach((t) => {
      // 用本年级名次；老快照没有这个字段时退回总名次（不至于显示空）
      const r = t.classRank || t.rank;
      const cls = ['pts-row'];
      if (r && r <= 3) cls.push('top' + r);
      const row = h('div', { class: cls.join(' ') }, [
        h('div', { class: 'rank', text: r ? String(r) : '—' }),
        h('div', { class: 'cls', text: t.name || '' }),
        h('div', { class: 'medals' }, [
          h('i', { class: 'm1', text: String(t.gold || 0) }),
          h('i', { class: 'm2', text: String(t.silver || 0) }),
          h('i', { class: 'm3', text: String(t.bronze || 0) }),
        ]),
        h('div', { class: 'pts', text: String(t.points === undefined ? 0 : t.points) }),
      ]);
      row.dataset.row = '1';
      track.appendChild(row);
    });
    scroller.appendChild(track);

    // 量出"还剩多少高度给名次行"，写死滚动区高度（不靠 max-height，免得被内容顶开）
    void inst.body.getBoundingClientRect();
    const bodyCs = window.getComputedStyle(inst.body);
    const availH = Math.max(60,
      (inst._planH || inst.body.clientHeight) - parseFloat(bodyCs.paddingTop || 0)
      - parseFloat(bodyCs.paddingBottom || 0)
      - gradeLine.getBoundingClientRect().height);
    const firstRow = track.firstElementChild;
    const rowH = firstRow ? firstRow.getBoundingClientRect().height : 0;
    if (!rowH) { scroller.style.maxHeight = availH + 'px'; return; }
    const show = Math.max(1, Math.floor((availH + 2) / (rowH + 2)));
    scroller.style.height = (rowH * show + 2) + 'px';
    scroller.style.maxHeight = (rowH * show + 2) + 'px';
    if (g.rows.length > show) {
      const sc = attachScroller(inst, inst.body, scroller, track, g.rows.length, show);
      if (sc) inst.scrollers.push(sc);
    }

    const meta = teamMeta();
    el('classSub').textContent = (meta.scoredEvents ? meta.scoredEvents + ' 个项目计分' : '')
      + '　' + g.rows.length + ' 个班'
      + (inst.pages > 1 ? ('　·　第 ' + (inst.page + 1) + '/' + inst.pages + ' 页') : '');
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 布局：量出来再排版
   * ══════════════════════════════════════════════════════════════════════ */

  /* ══════════════════════════════════════════════════════════════════════
   * 排版计划：这屏放几张卡、放几行
   *
   * 【实测记录（1920×1080、户外大模式，改动前）】
   *   cardCols=3 → 每张卡只有 182px 高，可视区 96px，名次行 25px
   *   一屏只显示 3 行，而一个项目有 20 人 → 要滚 7 屏才看得完
   *   ⇒ 现场观感就是"卡片太小、滚动像没生效"（其实在滚，只是慢得看不出来）
   *
   * 对症的三件事：
   *   ① 行数上限 4 → 6：每张卡多摆几行，少滚几屏（卡片高了一倍多）
   *   ② 列数上限 3 → 2：宁可少一列也要每张卡够高，名字与名次才看得清
   *   ③ 滚动频率调快 + 加平滑动画（见 TIMING 与 smoothScrollTo）
   *
   * 注意：**不能在网格轨道里写 calc(数字 * var(--s))**，
   * 列宽必须在这里算成 px 写进去（历史上踩过，整个 grid 声明会失效）。
   * ══════════════════════════════════════════════════════════════════════ */

  function computePlan() {
    const body = el('body-score');
    if (!body) return null;
    const cs = window.getComputedStyle(body);
    const bodyW = body.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
    const bodyH = body.clientHeight - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0);
    if (bodyW < 200 || bodyH < 120) return null;

    const gap = Math.round(App.screen().scale01(10));
    // 卡片目标宽度 520 左右最舒服（再窄名字就挤了）；最多 2 列 ——
    // 3 列时每张卡太窄太矮，名次行被压成细条，反而看不清。
    const target = Math.round(App.screen().scale01(520));
    let cardCols = Math.max(1, Math.min(2, Math.round((bodyW + gap) / (target + gap))));
    const minW = Math.round(App.screen().scale01(380));
    while (cardCols > 1 && (bodyW - gap * (cardCols - 1)) / cardCols < minW) cardCols--;
    const colW = Math.floor((bodyW - gap * (cardCols - 1)) / cardCols);

    // 一张卡的"骨架高度" = 标题 + 副信息 + 底部提示 + 内边距。
    // 这个必须量出来：以前用写死的常数，卡片一改样式就估错，
    // 直接把槽位切得太矮（实测 118px），一屏只显示 1 行名次。
    const m = measure(colW);
    const CHROME = Math.round(App.screen().scale01(30));   // 卡片上下内边距 + 边框
    const cardSkeleton = (m.headH || 34) + (m.metaH || 22)
      + Math.round(App.screen().scale01(20))               // 底部"还有 N 条"提示占一行
      + CHROME;
    const perCard = cardSkeleton + (m.rowH || 38) * 3;     // 按"至少能显示 3 行名次"定槽位
    // 行数上限 6：再多每张卡就太矮（名次挤成细条），不如让卡片自己滚。
    // 下限保证至少 2 行 —— 只显示 1 行等于没显示。
    const rowCap = Math.max(2, Math.min(6, Math.floor((bodyH + gap) / (perCard + gap))));

    return {
      cardCols, colW, rowCap, gap, bodyW, bodyH,
      rowH: m.rowH, headH: m.headH, metaH: m.metaH, cardSkeleton,
    };
  }

  /** 量一张样板卡的真实高度（不在网格轨道里用 calc，直接在 JS 里算好 px） */
  function measure(probeW) {
    const head = h('div', { class: 'event-head' }, [
      h('div', { class: 'event-name', text: '样板项目名称' }),
      h('div', { class: 'event-kind', text: '径赛' }),
    ]);
    const meta = h('div', { class: 'event-meta', text: '男子组 · 第1天 · 田径场 · 共 10 人' });
    const track = h('div', { class: 'card-track' }, [
      resultRow({ rank: 1, bib: '001', name: '样板运动员', team: '高一(1)班', value: 12.34, kind: 'track' }),
      resultRow({ rank: 2, bib: '002', name: '样板运动员', team: '高一(2)班', value: 12.5, kind: 'track' }),
    ]);
    const probe = h('div', { class: 'event-card', id: 'probe' }, [
      head, meta, h('div', { class: 'card-scroller' }, [h('div', { class: 'event-body' }, [track])]),
    ]);
    probe.style.position = 'absolute';
    probe.style.left = '-99999px';
    probe.style.top = '0';
    probe.style.width = probeW + 'px';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    const rowEl = track.firstElementChild;
    const out = {
      headH: head.getBoundingClientRect().height,
      metaH: meta.getBoundingClientRect().height,
      rowH: rowEl ? rowEl.getBoundingClientRect().height : 0,
    };
    probe.remove();
    return out;
  }

  /**
   * 侧栏每一块各占多高 —— **直接算成 px 写上去**，不靠 flex 分空间。
   *
   * 【为什么不用 flex】`.side-card { flex: 1 1 0 }` 看着简单，实测不可靠：
   *   内容少的那块（班级总分）只拿到 99px，一屏显示 1 行，其余被 overflow:hidden 藏掉；
   *   而内容多的那块（赛程）却撑到 300px。原因是弹性项的基础尺寸受内容影响，
   *   两个面板"按内容比例"分而不是"按可用空间平分"。
   * 写死 px 之后，每块拿到多少是一定的，想调比例就改下面的 weight。
   */
  const SIDE_WEIGHT = { schedule: 1.15, classPoints: 1 };   // 赛程略高一点（条目更密）

  function planSideHeights() {
    const side = document.querySelector('.side');
    if (!side) return null;
    const gap = parseFloat(window.getComputedStyle(side).rowGap || '0') || 0;
    const total = side.clientHeight - gap * Math.max(0, Object.keys(SIDE_WEIGHT).length - 1);
    if (total < 160) return null;                     // 太矮就别硬撑，交给原来的按内容走
    const sum = Object.keys(SIDE_WEIGHT).reduce((a, k) => a + SIDE_WEIGHT[k], 0);
    const out = {};
    Object.keys(SIDE_WEIGHT).forEach((k) => {
      out[k] = Math.max(96, Math.floor(total * SIDE_WEIGHT[k] / sum));
    });
    return out;
  }

  /**
   * 侧栏各块能放几条。
   *
   * 【为什么要兜底】`.side-card` 是弹性项且 min-height:0，**内容为空时会塌掉**。
   * relayout() 在第一次画之前就调这里，那时量到的是塌陷后的几十像素
   * （实测赛程 50px、班级总分 74px），rowCap 于是算成 1 —— 一屏只显示 1 条。
   * 所以：高度已经由 planSideHeights() 写死了，这里只需按写死的值算条数；
   * 万一还是量到很小，就用"侧栏高度 ÷ 面板数"兜底。
   */
  function planSidePanel(inst, perItemPx) {
    const body = inst.body;
    if (!body) return;
    const cs = window.getComputedStyle(body);
    let hh = body.clientHeight - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0);

    if (hh < 120) {
      const side = document.querySelector('.side');
      if (side && side.clientHeight > 160) {
        const n = Math.max(1, side.querySelectorAll('.side-card').length);
        const gap = parseFloat(window.getComputedStyle(side).rowGap || '0') || 0;
        hh = Math.max(60, (side.clientHeight - gap * (n - 1)) / n - Math.round(App.screen().scale01(34)) - 12);
      }
    }
    inst.rowCap = Math.max(1, Math.floor(hh / Math.max(18, perItemPx)));
    inst._planH = Math.round(hh);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 顶部（会名 / 正在进行 / 时钟）与底部（公告 / 控制）
   * ══════════════════════════════════════════════════════════════════════ */

  function renderTop() {
    const meet = (G.snap && G.snap.meet) || {};
    el('meetName').textContent = meet.name || '运动会成绩发布';
    const sub = [];
    if (meet.subtitle) sub.push(meet.subtitle);
    if (meet.holdDate) sub.push(meet.holdDate);
    if (meet.host) sub.push(meet.host);
    el('meetSub').textContent = sub.join('　·　');
    document.title = (meet.name || '运动会') + ' · 成绩大屏';

    const st = (G.snap && G.snap.stats) || {};
    const parts = [];
    if (st.athletes !== undefined) parts.push('运动员 ' + st.athletes);
    if (st.events !== undefined) parts.push('项目 ' + st.events);
    if (st.results !== undefined) parts.push('已录成绩 ' + st.results);
    el('topStat').textContent = parts.join('　·　');
  }

  /** 中间"正在进行"条：多个进行中的项目轮流显示 */
  function renderLiveBar() {
    const live = P('live', []);
    const nameEl = el('liveName'), metaEl = el('liveMeta'), pager = el('livePager');
    if (!live.length) {
      nameEl.textContent = '暂无进行中的项目';
      metaEl.textContent = '';
      clear(pager);
      return;
    }
    if (G.livePage >= live.length) G.livePage = 0;
    const ev = live[G.livePage];
    nameEl.textContent = ev.name || '';
    metaEl.textContent = ev.meta || '';
    clear(pager);
    if (live.length > 1) {
      live.forEach((_, i) => pager.appendChild(h('i', {
        style: {
          width: '6px', height: '6px', borderRadius: '50%', display: 'inline-block',
          background: i === G.livePage ? 'var(--gold)' : 'rgba(255,255,255,.25)',
        },
      })));
    }
  }

  function tickClock() {
    const d = new Date();
    el('clockTime').textContent = App.fmtClockSec(d);
    const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    el('clockDate').textContent = d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 '
      + d.getDate() + ' 日 星期' + week;
    /* 顺手刷一下翻页诊断。挂在这个每秒的时钟上最省事 ——
       它已经在跑，不必为诊断再加一个定时器（大屏上定时器越少越好）。 */
    reportPageTiming();
  }

  /** 底部公告横幅：多条轮流；太长就滚动显示 */
  function renderNoticeBar() {
    const list = noticeList();
    const textEl = el('noticeText');
    const idxEl = el('noticeIdx');
    if (!list.length) {
      textEl.classList.remove('is-scrolling');
      textEl.removeAttribute('data-allow-overflow');   // 不滚了就把"允许溢出"摘掉
      textEl.style.removeProperty('--nq-dur');
      textEl.textContent = '欢迎参加本届运动会　·　各项目成绩以本屏公告为准';
      idxEl.textContent = '';
      return;
    }
    if (G.noticePage >= list.length) G.noticePage = 0;
    const n = list[G.noticePage];
    const txt = n.text || '';
    textEl.textContent = txt;
    idxEl.textContent = (G.noticePage + 1) + ' / ' + list.length;
    // 超过 46 个字就改成滚动显示（现场公告常常很长）
    if (txt.length > 46) {
      const dur = Math.max(14, Math.min(46, Math.round(txt.length * 0.42) + 8));
      textEl.style.setProperty('--nq-dur', dur + 's');
      textEl.classList.add('is-scrolling');
      /* 跑马灯**就是要溢出**（overflow:hidden 把它藏起来，再用 transform 推出来）。
         而滚动状态把 text-overflow 从 ellipsis 改成了 clip，
         于是"内容比容器宽"就被版面体检工具当成问题了 —— 这是**误报**。
         标上 data-allow-overflow，体检工具会跳过它（公共约定见 common.js 的注释）。
         以前公告短，走的都是 ellipsis 那条路所以看不出来；加了长公告才暴露。 */
      textEl.setAttribute('data-allow-overflow', '');
      // 顺便把"要推多远"算准：正好推到尾巴露出来
      const track = textEl.parentElement;
      if (track) {
        const shift = Math.max(0, textEl.scrollWidth - track.clientWidth);
        textEl.style.setProperty('--nq-shift', shift + 'px');
      }
    } else {
      textEl.classList.remove('is-scrolling');
      textEl.removeAttribute('data-allow-overflow');
      textEl.style.removeProperty('--nq-dur');
      textEl.style.removeProperty('--nq-shift');
    }
  }

  /** 重要公告 → 顶部大字滚动条；到 until 时间自动回落 */
  function renderMarquee() {
    const box = el('marquee');
    const now = Date.now();
    const active = noticeList().filter(n => n.level === 'important')
      .find(n => !n.until || new Date(n.until).getTime() > now);
    if (!active) {
      if (G.marqueeUntil && now < G.marqueeUntil) return;
      box.hidden = true;
      // 没有重要公告时，抬头不用给顶部横幅留空位
      document.body.classList.add('no-marquee');
      return;
    }
    document.body.classList.remove('no-marquee');
    const txt = active.text || '';
    if (box.hidden || el('marqueeText').textContent !== txt) {
      el('marqueeText').textContent = txt;
      const dur = Math.max(12, Math.min(40, Math.round(txt.length * 0.42) + 8));
      el('marqueeText').style.setProperty('--mq-dur', dur + 's');
      box.hidden = false;
    }
    // 跑马灯天生越过容器滚动，别让版面体检当成"内容被裁切"
    const track = box.querySelector('.marquee-track');
    if (track) track.dataset.allowOverflow = '1';
    el('marqueeText').dataset.allowOverflow = '1';
  }

  function setConn(state, text) {
    const box = el('conn');
    if (!box) return;
    box.classList.toggle('is-off', state === 'off' || state === 'poll');
    box.classList.toggle('is-bad', state === 'bad');
    el('connText').textContent = text || (state === 'ok' ? '已连接' : '连接中断');
    document.body.classList.toggle('is-offline', state === 'bad');
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 重排与数据流
   * ══════════════════════════════════════════════════════════════════════ */

  function buildPanels() {
    if (Object.keys(G.panels).length) return;
    G.panels.score = createPanel('score', renderScore);
    G.panels.schedule = createPanel('schedule', renderSchedule);
    G.panels.classPoints = createPanel('classPoints', renderClassPoints);
  }

  /**
   * 重算版面几何（**轻量**）：每屏放几张卡、几张卡放几行、侧栏两块各多高。
   *
   * 这一步每次收到数据都要做 —— 数据一变，"一屏放得下几条"就可能变。
   * 但它**不动 DOM**，所以不会打断卡片滚动。
   * 【这里原来和画 DOM 混在 relayout 里】导致每来一条数据都把滚动重置一次。
   */
  function layoutGeometry() {
    if (!G.snap) return false;
    buildPanels();
    const plan = computePlan();
    if (plan) G.plan = plan;

    // 侧栏两块（赛程 / 班级总分）各自按实际高度决定放几条。
    // 先把两块的高度**算成 px 写死**，再算条数 —— 顺序不能反：
    // 不先定高度，量到的就是"内容为空时塌陷"的几十像素，条数会算成 1。
    const sideH = planSideHeights();
    if (sideH) {
      Object.keys(sideH).forEach((k) => {
        const sec = document.querySelector('[data-panel="' + k + '"]');
        if (sec) sec.style.height = sideH[k] + 'px';
      });
    }
    const sched = G.panels.schedule, pts = G.panels.classPoints;
    if (sched) planSidePanel(sched, Math.round(App.screen().scale01(52)));
    if (pts) planSidePanel(pts, Math.round(App.screen().scale01(34)));

    // 诊断（排查版面问题用）
    try {
      const dbg = el('diagPlan');
      if (dbg && G.plan) {
        dbg.textContent = JSON.stringify({
          cardCols: G.plan.cardCols, rowCap: G.plan.rowCap, colW: G.plan.colW,
          bodyW: Math.round(G.plan.bodyW), bodyH: Math.round(G.plan.bodyH),
          rowH: G.plan.rowH,
          panels: Object.keys(G.panels).map(k => ({
            k, pages: G.panels[k].pages, rows: G.panels[k].rowCap,
          })),
        });
      }
    } catch (e) { /* 诊断不影响渲染 */ }
    return true;
  }

  /**
   * 强制重画所有栏目（**重**）：切显示模式、点刷新、起始时用。
   * 会重建 DOM 并重置卡片滚动，所以**不要**在每次数据更新时走这里。
   */
  function relayout() {
    if (!layoutGeometry()) return;
    Object.keys(G.panels).forEach((k) => {
      const inst = G.panels[k];
      paint(inst);
      // 起始错开：各栏第一次翻页时间不一样，避免整屏同时跳
      schedulePanel(inst, (TIMING.stagger[k] || 0) + tickMs(k) + 200);
    });
  }

  /**
   * 数据驱动的刷新（**轻量**）：几何照算，**内容没变就不重建 DOM**。
   * 这样正在进行的卡片滚动不会被重置，成绩公告栏的翻页才等得到头。
   */
  function refreshPanels() {
    if (!layoutGeometry()) return;
    Object.keys(G.panels).forEach((k) => refresh(G.panels[k]));
  }


  /**
   * 收到数据：可能是全量快照，也可能是增量（第 2 趟改造）。
   *
   * 增量合并用一个纯函数（public/snapshot-merge.js），
   * 它里面校验 `base`（这条补丁基于哪个版本）：
   *   对不上就返回 false —— 说明中间漏过消息（断线重连、切后台），
   *   此时**重新拉一次全量**，绝不硬套补丁（硬套会得到错的数据，而且不报错）。
   */
  function applySnapshot(snap) {
    if (!snap) return;
    if (App.merge && App.merge.isPatch(snap)) {
      if (!App.merge.merge(G.snap, snap)) {
        // 版本对不上 → 退回全量（大屏是只读的，直接重新拉一次即可）
        App.api('/api/snapshot', { query: { kind: 'screen' } }).then((r) => {
          if (r.ok && r.data && !(App.merge && App.merge.isPatch(r.data))) applySnapshot(r.data);
        });
        return;
      }
    } else {
      G.snap = snap;
    }
    G.lastUpdate = Date.now();
    if (G.snap.screen && G.snap.screen.mode && !App.store.get('screenModeManual', false)) {
      G.mode = G.snap.screen.mode;
    }
    renderTop();
    renderLiveBar();
    renderNoticeBar();
    renderMarquee();
    /* 【用 refreshPanels，不要用 relayout】
       数据更新时走"轻量"这条路：几何照算，但**内容没变就不重建 DOM**，
       于是正在进行的卡片滚动不会被重置。
       以前这里调 relayout() → paint() → stopScrollers()，
       每收到一条成绩就把所有滚动计时器清掉重来，
       而卡片要滚 6 屏（≈18 秒）才轮到栏目翻页 ——
       比赛期间数据来得很密，那 18 秒**永远等不到头**，
       表现就是"成绩公告栏长时间不翻页"。
       需要强制重画的地方（切显示模式、点刷新、翻页）仍然走 relayout/paint。 */
    refreshPanels();
    reportHeaderMetrics();
    reportCardGeometry();
  }

  /** 诊断：把顶部各块的真实尺寸写进 #diagHeader（排查"抬头被撑爆"这类问题用） */
  function reportHeaderMetrics() {
    try {
      const dbg = el('diagHeader');
      if (!dbg) return;
      const pick = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        const cs = window.getComputedStyle(e);
        return {
          w: Math.round(r.width), h: Math.round(r.height),
          left: Math.round(r.left), right: Math.round(r.right),
          width: cs.width, height: cs.height, flex: cs.flex, maxW: cs.maxWidth,
        };
      };
      const logo = document.querySelector('.brand-logo');
      const lcs = logo ? window.getComputedStyle(logo) : null;
      const row = document.querySelector('.event-card .card-track > .row');
      const rowInfo = row ? (() => {
        const r = row.getBoundingClientRect();
        const cs2 = window.getComputedStyle(row);
        const kids = Array.from(row.children).map(k => {
          const kr = k.getBoundingClientRect();
          return k.className + '=' + Math.round(kr.width) + 'x' + Math.round(kr.height) + '@' + Math.round(kr.left);
        });
        return {
          h: Math.round(r.height), w: Math.round(r.width),
          display: cs2.display, cols: cs2.gridTemplateColumns, minH: cs2.minHeight,
          kids,
        };
      })() : null;
      dbg.textContent = JSON.stringify({
        s: document.documentElement.style.getPropertyValue('--s'),
        vw: window.innerWidth, vh: window.innerHeight,
        top: pick('#top'), topLeft: pick('.top-left'), brand: pick('.brand'),
        logo: pick('.brand-logo'), btn: pick('.brand-meet'), mid: pick('.top-mid'),
        logoCss: lcs ? {
          width: lcs.width, height: lcs.height, maxWidth: lcs.maxWidth, maxHeight: lcs.maxHeight,
          flex: lcs.flex, alignSelf: lcs.alignSelf, display: lcs.display,
          sp56: getComputedStyle(document.documentElement).getPropertyValue('--sp56'),
        } : null,
        row: rowInfo,
      });
    } catch (e) { /* 诊断不能影响渲染 */ }
  }

  /**
   * 诊断：翻页节奏写进 #diagPage。
   *
   * 【为什么要有这个】"某栏长时间不翻页"这种问题**眼睛看不出来是卡住了还是本来就
   *   只有一页**。这里把每栏的 `第几页/共几页`、`下次翻页还有几秒`、`在等哪张卡滚完`
   *   都写出来，现场 F12 一搜就知道卡在哪一环，自动化也能断言。
   */
  function reportPageTiming() {
    try {
      const box = el('diagPage');
      if (!box) return;
      const now = Date.now();
      box.textContent = JSON.stringify({
        at: new Date(now).toISOString().slice(11, 19),
        pausedAll: !!G.pausedAll,
        panels: Object.keys(G.panels).map((k) => {
          const p = G.panels[k];
          return {
            k,
            page: p.page + 1,
            pages: Math.max(1, p.pages),
            paused: !!p.paused,
            // 还有几秒到点（负数=已经过点，正被"等滚动"挡着）
            dueIn: p.dueAt ? Math.round((p.dueAt - now) / 100) / 10 : null,
            // 还有几秒在等卡片滚完（null = 没在等）
            holdIn: p.scrollHoldUntil > now ? Math.round((p.scrollHoldUntil - now) / 100) / 10 : null,
            scrollers: (p.scrollers || []).length,
            sigLen: p.lastSig ? p.lastSig.length : 0,
          };
        }),
      });
    } catch (e) { /* 诊断不能影响渲染 */ }
  }

  /** 诊断：把每张卡的几何量出来写进 #diagGeom（排查"名次溢出卡片"这类问题） */
  function reportCardGeometry() {
    try {
      const box = el('diagGeom');
      if (!box) return;
      const out = [];
      // ① 每张卡的几何
      Array.prototype.slice.call(document.querySelectorAll('.event-card')).slice(0, 4).forEach((card) => {
        const sc = card.querySelector('.card-scroller');
        const track = card.querySelector('.card-track');
        const cr = card.getBoundingClientRect();
        out.push({
          t: 'card', name: (card.querySelector('.event-name') || {}).textContent,
          cardH: Math.round(cr.height), cardTop: Math.round(cr.top), cardBottom: Math.round(cr.bottom),
          scTop: sc ? Math.round(sc.getBoundingClientRect().top) : null,
          scBottom: sc ? Math.round(sc.getBoundingClientRect().bottom) : null,
          scHeight: sc ? sc.style.height : null,
          trackBottom: track ? Math.round(track.getBoundingClientRect().bottom) : null,
          contain: card ? window.getComputedStyle(card).contain : null,
        });
      });
      // ② 全局断言：有没有名次行画到了所属卡片外面（这是"鬼影"的来源）
      let outside = 0; const samples = [];
      Array.prototype.slice.call(document.querySelectorAll('.event-card')).forEach((card) => {
        const cr = card.getBoundingClientRect();
        Array.prototype.slice.call(card.querySelectorAll('.row')).forEach((r) => {
          const rr = r.getBoundingClientRect();
          if (rr.top < cr.top - 1 || rr.bottom > cr.bottom + 1) {
            outside++;
            if (samples.length < 4) {
              samples.push({ card: Math.round(cr.top) + '-' + Math.round(cr.bottom),
                row: Math.round(rr.top) + '-' + Math.round(rr.bottom) });
            }
          }
        });
      });
      out.push({ t: 'outsideRows', count: outside, samples });
      // ③ 关键坐标命中测试：截图里"鬼影"出现的那个位置到底画的是什么元素
      out.push({ t: 'at(300,368)', els: App.whatsAt(300, 368) });
      out.push({ t: 'at(700,368)', els: App.whatsAt(700, 368) });
      box.textContent = JSON.stringify(out);
    } catch (e) { /* 诊断不能影响渲染 */ }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 启动
   * ══════════════════════════════════════════════════════════════════════ */

  function boot() {
    App.pxScale(G.mode);
    App.installErrorReporting('screen');
    // 静态帧模式：?nofx=1 时停掉所有动画（抓图/录屏/自动化断言用，避免抓到半帧）
    if (/[?&]nofx=1/.test(location.search)) document.body.classList.add('is-static-frame');
    tickClock();
    setInterval(tickClock, 1000);

    // 显示模式切换
    const seg = el('modeSeg');
    function syncSeg() {
      Array.from(seg.children).forEach(b => b.classList.toggle('is-on', b.dataset.mode === G.mode));
    }
    seg.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-mode]');
      if (!b) return;
      G.mode = b.dataset.mode;
      App.store.set('screenMode', G.mode);
      App.store.set('screenModeManual', true);
      App.pxScale(G.mode);
      syncSeg();
      relayout();
    });
    syncSeg();

    // 悬浮控件自动隐藏（鼠标静止 5 秒）：平时不占版面，动一下鼠标才出现
    const dock = el('dock');
    App.autoHideControls(5000, (hidden) => {
      dock.classList.toggle('is-hidden-by-idle', hidden);
    });

    // 各栏翻页按钮
    document.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-page]');
      if (!b) return;
      const inst = G.panels[b.dataset.for];
      if (!inst) return;
      const total = Math.max(1, inst.pages);
      inst.page = b.dataset.page === 'next'
        ? (inst.page + 1) % total
        : (inst.page - 1 + total) % total;
      paint(inst);
      schedulePanel(inst, tickMs(inst.key));
    });

    el('btnRefresh').addEventListener('click', () => {
      App.api('/api/snapshot', { query: { kind: 'screen' } }).then((r) => {
        if (r.ok && r.data) applySnapshot(r.data);
      });
    });
    el('btnResumeAll').addEventListener('click', () => {
      G.pausedAll = false;
      Object.values(G.panels).forEach(p => { p.paused = false; syncPausedUI(p); schedulePanel(p, 400); });
    });
    el('btnFull').addEventListener('click', () => {
      if (!document.fullscreenElement) {
        (document.documentElement.requestFullscreen || function () {}).call(document.documentElement);
      } else {
        (document.exitFullscreen || function () {}).call(document);
      }
    });
    el('marqueeClose').addEventListener('click', () => {
      el('marquee').hidden = true;
      G.marqueeUntil = Date.now() + 120000;   // 手动关掉后 2 分钟内不再弹同一条
    });

    // 尺寸/比例变化 → 重算缩放与版面
    App.onResize(G.mode, () => { relayout(); });

    // 首屏
    App.api('/api/snapshot', { query: { kind: 'screen' } }).then((r) => {
      if (r.ok && r.data) applySnapshot(r.data);
      else {
        setConn('bad', '无法连接主机');
        el('body-score').appendChild(h('div', {
          class: 'empty',
          text: '无法连接主机：' + (r.error || '')
            + '　请检查这台电脑是否连上了学校局域网，以及主机上的服务是否在运行。',
        }));
      }
    });

    if (App.isStaticMode()) {
      setConn('ok', '静态体检模式（未连实时通道）');
    } else {
      App.stream('screen', applySnapshot, setConn);
    }

    // 进行中条与底部公告各自轮流换（也跟着显示模式的节奏走）
    setInterval(() => {
      if (!G.snap || G.pausedAll) return;
      if (P('live', []).length > 1) { G.livePage++; renderLiveBar(); }
    }, tickMs('live'));
    setInterval(() => {
      if (!G.snap || G.pausedAll) return;
      G.noticePage++; renderNoticeBar();
    }, Math.round(4200 * speedFactor()));

    // 兜底体检：数据稳定后量一次版面
    setTimeout(() => { if (G.snap) App.checkLayout('screen'); }, 1200);
    setInterval(() => { if (G.snap) App.checkLayout('screen'); }, 15000);
  }

  App.bootstrap(boot);
})();
