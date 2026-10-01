/* ============================================================================
 * admin-roster.js —— 名单页签
 *
 * 需求里点名的几件事，都在这里：
 *   · 搜索（姓名/号码）+ 组别/年级/班级**三重筛选**
 *   · 排序：组别 → 年级 → 班级 → 号码 → 姓名
 *   · **同班成块显示并带班级小标题**（现场按班核对最顺手）
 *   · 行内可直接改（改完离开就暂存，没有保存按钮）
 *   · 从 Excel 整块粘贴导入，或选择 .csv/.tsv/.txt 文件
 * ========================================================================== */
'use strict';

(function () {
  const A = window.Admin;
  const h = A.h, el = A.el, clear = A.clear;
  const App = window.App;

  const IMPORTER = { open: false };

  /* 解析与列名识别统一在 public/roster-import.js（前后端共用同一套规则）。
     这里以前有一份自己的 ALIAS + pick + parseTable，已经删掉 ——
     留着两份实现，迟早会出现"这里认得、那里不认得"。 */

  /* ── 渲染 ────────────────────────────────────────────────────────────── */

  function render() {
    const S = A.S;
    const pane = el('paneRoster');
    if (!pane) return;
    const snap = S.snap;

    const f = S.filters.roster;

    /* 【原地更新】工具条（含搜索框和三个筛选下拉）只建一次。
       原来每次数据更新都 clear(pane) —— 搜索框里打的字被清掉、焦点也没了，
       下拉框展开状态同样会丢。 */
    let box = pane.querySelector('[data-part="roster"]');
    let search = null, gsel = null, grsel = null, csel = null, esel = null;
    if (!box) {
      clear(pane);
      box = h('div', { class: 'box', 'data-part': 'roster' });
      box.appendChild(h('div', { class: 'box-head' }, [
        h('div', { class: 'box-title', text: '名单' }),
        h('div', { class: 'box-note', text: '排序：组别 → 年级 → 班级 → 号码 → 姓名；同班成块显示' }),
      ]));

      const bar = h('div', { class: 'box-body toolbar' });
      search = h('input', {
        class: 'input grow', type: 'search', placeholder: '搜姓名或号码', value: f.search,
      });
      search.addEventListener('input', () => { f.search = search.value.trim(); renderList(); });
      bar.appendChild(search);

      gsel = h('select', { class: 'select', 'data-part': 'gsel' });
      gsel.addEventListener('change', () => { f.groupId = gsel.value; renderList(); });
      bar.appendChild(gsel);

      grsel = h('select', { class: 'select', 'data-part': 'grsel' });
      grsel.addEventListener('change', () => { f.grade = grsel.value; renderList(); });
      bar.appendChild(grsel);

      csel = h('select', { class: 'select', 'data-part': 'csel' });
      csel.addEventListener('change', () => { f.className = csel.value; renderList(); });
      bar.appendChild(csel);

      /* 第四个筛选项：**按项目**。
         现场用途：核对/打印某个项目的名单，或看"这个项目都有谁"。
         只列个人项目 —— 接力是一个班一条报名记录，队员存在 legsJson 里（姓名文本），
         没有对应的运动员，按人筛不出来。 */
      esel = h('select', { class: 'select', 'data-part': 'esel', title: '按项目筛：只看报了某个项目的人' });
      esel.addEventListener('change', () => { f.eventId = esel.value; renderList(); });
      bar.appendChild(esel);

      bar.appendChild(h('button', {
        class: 'btn btn-sm', type: 'button', text: '清空筛选',
        onclick: () => {
          f.search = ''; f.groupId = ''; f.grade = ''; f.className = ''; f.eventId = '';
          // 输入框/下拉的值也要跟着复位（它们现在是常驻节点，不重建了）
          if (search) search.value = '';
          if (gsel) gsel.value = ''; if (grsel) grsel.value = ''; if (csel) csel.value = '';
          if (esel) esel.value = '';
          renderList();
        },
      }));
      bar.appendChild(h('button', {
        class: 'btn btn-sm', type: 'button', text: '加一名运动员',
        onclick: () => addOne(),
      }));
      bar.appendChild(h('button', {
        class: 'btn btn-sm btn-primary', type: 'button', text: '导入名单（Excel 粘贴 / 选文件）',
        onclick: () => openImporter(),
      }));
      box.appendChild(bar);

      /* 说明行**必须放在 rosterList 外面**：
         rosterList 的整个内容归 reconcile 管（它会把"不在列表里"的子节点删掉），
         把说明行塞进去就会被当成没用的节点删掉 —— 我第一版就是这么写的，
         结果说明行永远不显示。班级总分页的 meta/foot 也是同样的道理。 */
      box.appendChild(h('div', { class: 'box-note', 'data-part': 'info', style: { padding: '8px 14px' } }));
      box.appendChild(h('div', { class: 'box-body', id: 'rosterList', style: { padding: '0' } }));
      pane.appendChild(box);
    } else {
      search = box.querySelector('input[type="search"]');
      gsel = box.querySelector('[data-part="gsel"]');
      grsel = box.querySelector('[data-part="grsel"]');
      csel = box.querySelector('[data-part="csel"]');
      esel = box.querySelector('[data-part="esel"]');
    }

    // 四个下拉的选项原地对齐（含"全部…"那一项）
    const fillSel = (sel, allLabel, items, cur) => {
      if (!sel) return;
      App.dom.reconcile(sel, [{ id: '', text: allLabel }].concat(items),
        it => it.id, (it, node) => {
          if (!node) node = h('option', {});
          node.value = it.id;
          App.dom.setText(node, it.text);
          return node;
        });
      if (sel.value !== cur) sel.value = cur;
    };
    fillSel(gsel, '全部组别', (snap.groups || []).map(g => ({ id: g.id, text: g.name })), f.groupId);
    /* 年级/班级下拉的候选值来自**名单接口**（快照里已经不带名单了，见第 3 趟改造）。
       拉回来之前先用空列表，拉回来之后 render() 会再画一次。 */
    fillSel(grsel, '全部年级', (ROSTER.grades || []).map(g => ({ id: g, text: g })), f.grade);
    fillSel(csel, '全部班级', (ROSTER.classes || []).map(c => ({ id: c, text: c })), f.className);
    /* 项目下拉也来自名单接口。文案带上报名人数，方便挑（"男子100米决赛（20 人）"）。 */
    fillSel(esel, '全部项目',
      (ROSTER.events || []).map(e => ({
        id: e.id,
        text: e.name + (e.regs ? ('（' + e.regs + ' 人）') : '（0 人）'),
      })), f.eventId);
    if (search && search.value !== f.search) search.value = f.search;

    // 名单数据是懒加载的：第一次进来（或筛选变了）时才去拉
    ensureRoster();

    // 导入面板：只在打开时存在
    const oldImp = pane.querySelector('[data-part="importer"]');
    if (IMPORTER.open) {
      if (!oldImp) pane.appendChild(importerBox());
    } else if (oldImp) {
      oldImp.remove();
    }

    renderRelayBox(pane);

    renderList();
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 接力队伍（按班级成队：新建 / 填改队员 / 按班级自动补齐 / 删队）
   *
   * 【为什么单独一块】接力不是"某个人报名"，而是**一个班一条报名记录**，
   *   队员是 legsJson 里的姓名文本。所以它进不了上面那份运动员名单，
   *   原来在名单页里**只能看不能管**（个人项目那个"加入这个项目"下拉
   *   显式排除了接力，见 e.isRelay 那行）——
   *   而「详细设置」里的说明却写着"到名单页点队员/按班级自动补齐"，
   *   **那两个按钮当时根本不存在**。这块就是把它补上。
   *
   * 数据来自服务端的 relayTeams（跟名单一起回，见 server.js）。
   * 后端操作：reg.add（不传 athleteId 就是建队）、reg.legs（手填/自动）、reg.del。
   * ══════════════════════════════════════════════════════════════════════ */

  /** 改完队伍后：名单作废、刷新快照、等新数据回来再重画这一块 */
  function afterTeamChange() {
    invalidateRoster();
    A.refresh().then(() => ensureRoster(true));
  }

  function renderRelayBox(pane) {
    const S = A.S;
    let box = pane.querySelector('[data-part="relay"]');
    if (!box) {
      box = h('div', { class: 'box', 'data-part': 'relay' });
      box.appendChild(h('div', { class: 'box-head' }, [
        h('div', { class: 'box-title', text: '接力队伍' }),
        h('div', { class: 'box-note', text: '接力按班级成队 —— 一个班一条报名记录，队员是姓名文本' }),
        h('span', { class: 'grow', style: { flex: '1 1 auto' } }),
        h('button', {
          class: 'btn btn-sm btn-primary', type: 'button', text: '添加队伍',
          dataset: { needWrite: '1' },
          onclick: () => addTeamDialog(),
        }),
      ]));
      box.appendChild(h('div', { class: 'box-body', 'data-part': 'relaybody' }));
      /* 插在名单那块**前面** —— 接力队伍是"编排类"的东西，
         老师通常是先把队伍建好，再逐个人核对名单。 */
      const rosterBox = pane.querySelector('[data-part="roster"]');
      if (rosterBox && rosterBox.parentNode === pane) pane.insertBefore(box, rosterBox);
      else pane.appendChild(box);
    }

    const body = box.querySelector('[data-part="relaybody"]');
    const groups = ROSTER.relayTeams || [];

    if (!ROSTER.loaded) {
      App.dom.setText(body, '正在读取…');
      return;
    }
    if (!groups.length) {
      App.dom.setText(body, '这一届还没有接力项目。到「赛程编排」新建项目时勾上「是接力」即可。');
      return;
    }

    /* 整块重建（队数很少，几十行；不用 reconcile 那套原地更新） */
    clear(body);
    groups.forEach((g) => {
      const sec = h('div', { class: 'relay-group' });
      const head = h('div', { class: 'relay-head' }, [
        h('span', { class: 'relay-name', text: g.eventName }),
        h('span', { class: 'relay-sub', text: g.groupName + '　每队 ' + g.legs + ' 人　共 ' + g.teams.length + ' 队' }),
      ]);
      sec.appendChild(head);

      if (!g.teams.length) {
        sec.appendChild(h('div', { class: 'relay-empty', text: '还没有队伍。点右上角「添加队伍」按班级建队。' }));
      } else {
        g.teams.forEach((t) => {
          const row = h('div', { class: 'relay-row' });
          row.appendChild(h('span', { class: 'relay-team', text: t.teamName || '（无队名）' }));
          if (!t.className) {
            row.appendChild(h('span', {
              class: 'relay-warn', title: '没绑定班级时，这个队的分数不会算进任何班级，也没法自动补齐队员',
              text: '⚠ 未绑班级',
            }));
          }
          row.appendChild(h('span', {
            class: 'relay-legs' + (t.legs.length === g.legs ? '' : ' is-short'),
            text: t.legs.length ? t.legs.join('、') : '（还没填队员）',
          }));
          if (t.hasResult) row.appendChild(h('span', { class: 'relay-warn', text: '已有成绩' }));

          const acts = h('span', { class: 'relay-acts' });
          acts.appendChild(h('button', {
            class: 'btn btn-xs', type: 'button', text: '填改队员',
            dataset: { needWrite: '1' },
            onclick: () => legsDialog(g, t),
          }));
          if (t.classId) {
            acts.appendChild(h('button', {
              class: 'btn btn-xs', type: 'button', text: '按班级补齐',
              title: '取这个班号码最靠前的 ' + g.legs + ' 名运动员（会覆盖现在的队员）',
              dataset: { needWrite: '1' },
              onclick: () => {
                A.ask({
                  title: '按班级自动补齐',
                  text: '把「' + (t.teamName || '') + '」的队员换成该班号码最靠前的 ' + g.legs
                    + ' 名运动员？\n现在填的是：' + (t.legs.length ? t.legs.join('、') : '（空）'),
                  okText: '补齐',
                }).then((r) => {
                  if (!r.ok) return;
                  A.cmd('reg.legs', { id: t.id, auto: true }).then(afterTeamChange);
                });
              },
            }));
          }
          const del = h('button', {
            class: 'btn btn-xs btn-ghost', type: 'button', text: '×',
            hidden: !!t.hasResult,
            title: t.hasResult ? '这个队已经录了成绩，先清掉成绩才能删' : '删掉这个队（连同它的报名）',
            dataset: { needWrite: '1' },
            onclick: () => {
              A.ask({
                title: '删除队伍',
                text: '把「' + (t.teamName || '') + '」从「' + g.eventName + '」的名单里删掉？',
                okText: '删除', danger: true,
              }).then((r) => {
                if (!r.ok) return;
                A.cmd('reg.del', { id: t.id }).then(afterTeamChange);
              });
            },
          });
          acts.appendChild(del);
          row.appendChild(acts);
          sec.appendChild(row);
        });
      }
      body.appendChild(sec);
    });
  }

  /**
   * 添加队伍。
   *
   * ⚠ 这里**不发送 `athleteId`** —— `reg.add` 靠这个区分两条路：
   *   传 athleteId  = 个人报名（会查重"这个人已经报过了"）
   *   不传 athleteId = 按班级建接力队（用 teamName 查重）
   * 传错了会把"队"建到某个人头上，或者报"这位运动员已经在这个项目的名单里了"。
   */
  function addTeamDialog() {
    const S = A.S;
    const groups = (ROSTER.relayTeams || []).filter(g => g.status !== 'done');
    if (!groups.length) {
      A.toast(ROSTER.relayTeams && ROSTER.relayTeams.length
        ? '接力项目都已经结束了，不用再建队'
        : '这一届还没有接力项目', 'warn');
      return;
    }
    const evSel = h('select', { class: 'select' });
    groups.forEach(g => evSel.appendChild(h('option', {
      value: g.eventId, text: g.eventName + (g.teams.length ? ('（已有 ' + g.teams.length + ' 队）') : '（还没有队）'),
    })));

    const clsSel = h('select', { class: 'select' });
    clsSel.appendChild(h('option', { value: '', text: '（不绑班级 · 只填队名）' }));
    (S.snap.classes || []).forEach(c => clsSel.appendChild(h('option', { value: c.id, text: c.label })));

    const teamName = h('input', { class: 'input', placeholder: '队名（选班级会自动填成班级名）' });
    const legsInput = h('input', { class: 'input', placeholder: '队员姓名，用顿号或逗号分隔（可留空，之后补）' });
    const autoFill = h('input', { type: 'checkbox' });
    const errBox = h('div', { class: 'ask-text', style: { color: 'var(--red, #d24b3e)', display: 'none' } });
    const showErr = (msg) => { errBox.textContent = msg || ''; errBox.style.display = msg ? '' : 'none'; };

    /* 选了班级就把队名自动填成班级名（现场口诀：队名就是班级名） */
    clsSel.addEventListener('change', () => {
      const c = (S.snap.classes || []).filter(x => x.id === clsSel.value)[0];
      if (c && !teamName.value.trim()) teamName.value = c.label;
    });

    const cur = () => groups.filter(g => g.eventId === evSel.value)[0] || groups[0];
    const body = h('div', { class: 'form-grid' }, [
      h('label', { class: 'field field-wide' }, [h('span', { class: 'label', text: '接力项目' }), evSel]),
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '班级' }), clsSel]),
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '队名' }), teamName]),
      h('label', { class: 'field field-wide' }, [
        h('span', { class: 'label', text: '队员' }), legsInput,
        h('span', { class: 'hint', text: '留空也行，之后点「填改队员」或「按班级补齐」' }),
      ]),
      h('label', { class: 'field field-wide' }, [
        h('span', { class: 'label', text: '队员自动补齐' }),
        h('label', { class: 'chk' }, [autoFill, h('span', { text: '建队时自动取该班号码最靠前的几名运动员（要先选班级）' })]),
      ]),
      errBox,
    ]);

    const modal = el('askModal');
    el('askTitle').textContent = '添加接力队伍';
    el('askText').textContent = '接力是一队一条报名记录，队员只是姓名文本。'
      + '建好后是暂存状态，点右上角「确认并推送」才正式生效。';
    const field = el('askField');
    field.hidden = false;
    clear(field);
    field.appendChild(body);
    el('askOk').textContent = '建队';
    el('askOk').className = 'btn btn-primary';
    modal.hidden = false;
    showErr('');
    setTimeout(() => teamName.focus(), 40);

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
      const g = cur();
      const name = teamName.value.trim();
      if (!name) { showErr('队名不能为空（选个班级就会自动填）'); teamName.focus(); return; }
      if (autoFill.checked && !clsSel.value) { showErr('要自动补齐队员，必须先选班级'); return; }
      const payload = { eventId: evSel.value, teamName: name };
      if (clsSel.value) payload.classId = clsSel.value;
      const legs = legsInput.value.split(/[、,，;；\s]+/).map(x => x.trim()).filter(Boolean);
      if (legs.length) payload.legs = legs;

      A.cmd('reg.add', payload).then((res) => {
        if (res && res.failed) { showErr(res.error || '建队失败'); return; }
        const regId = res && res.data && res.data.id;
        finish();
        if (autoFill.checked && regId) {
          /* 建队 + 自动补齐要**分两步**：reg.add 里没法同时"按班级取人"，
             取人的逻辑在 reg.legs 的 auto 分支。第二步失败也不回滚建队 ——
             队已经建好了，队员可以再点「按班级补齐」，比整条撤掉更省事。 */
          A.cmd('reg.legs', { id: regId, auto: true }).then((r2) => {
            if (r2 && r2.failed) A.toast('队建好了，但自动补齐队员失败：' + (r2.error || ''), 'warn', 6000);
            afterTeamChange();
          });
        } else {
          afterTeamChange();
        }
      });
    };
  }

  /** 填改队员（手填；也能一键按班级补齐） */
  function legsDialog(g, t) {
    const legsInput = h('input', {
      class: 'input',
      value: (t.legs || []).join('、'),
      placeholder: '队员姓名，用顿号或逗号分隔',
    });
    const errBox = h('div', { class: 'ask-text', style: { color: 'var(--red, #d24b3e)', display: 'none' } });
    const showErr = (msg) => { errBox.textContent = msg || ''; errBox.style.display = msg ? '' : 'none'; };
    const body = h('div', { class: 'form-grid' }, [
      h('label', { class: 'field field-wide' }, [
        h('span', { class: 'label', text: g.eventName + '　·　' + (t.teamName || '') }),
        legsInput,
        h('span', { class: 'hint', text: '这个项目每队 ' + g.legs + ' 人；多填的会被截掉，少填也能存（之后再补）' }),
      ]),
      errBox,
    ]);
    const modal = el('askModal');
    el('askTitle').textContent = '填改队员';
    el('askText').textContent = '队员是**姓名文本**（存快照）—— 之后删掉某个运动员也不影响这张历史成绩单。';
    const field = el('askField');
    field.hidden = false;
    clear(field);
    field.appendChild(body);
    el('askOk').textContent = '保存队员';
    el('askOk').className = 'btn btn-primary';
    modal.hidden = false;
    showErr('');
    setTimeout(() => legsInput.focus(), 40);

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
      const legs = legsInput.value.split(/[、,，;；\s]+/).map(x => x.trim()).filter(Boolean);
      A.cmd('reg.legs', { id: t.id, legs: legs }).then((res) => {
        if (res && res.failed) { showErr(res.error || '保存失败'); return; }
        finish();
        afterTeamChange();
      });
    };
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 名单数据的懒加载（第 3 趟改造）
   *
   * 【为什么】905 名运动员的完整明细约 209 KB，而后台快照原来总共 296 KB ——
   * 每次录成绩、每次检录都要把这份名单推给所有后台客户端，而它们多数时候
   * 根本不在看名单页。现在名单改由 GET /api/roster 按需拉：
   *   · 进名单页时才拉；筛选条件变化时用**服务端筛选**再拉
   *   · 拉回来的名单记在 ROSTER 里，同时记住"按什么条件拉的"
   * ══════════════════════════════════════════════════════════════════════ */

  const ROSTER = {
    list: [],            // 当前这一页的运动员
    total: 0,            // 全库总数（"共 N 名"用这个）
    count: 0,            // 符合当前筛选的总数
    grades: [], classes: [],
    events: [],          // 项目下拉的候选（服务端给的，只含个人项目）
    /* 接力队伍（服务端在名单接口里一起给的，见 server.js 的 relayTeams 说明）。
       形如 [{ eventId, eventName, groupName, legs, status, teams:[{id,teamName,classId,className,legs,hasResult}] }] */
    relayTeams: [],
    eventFilter: null,   // 当前按哪个项目筛（{id,name}），没筛时为 null
    key: '',             // 当前数据对应的筛选条件签名（变了才重新拉）
    rev: 0,              // 拉回来的数据对应哪个版本
    loaded: false,       // 是否成功拉到过（区别于"拉过但结果是空的"）
    loading: false,
    error: '',
    waiters: [],         // 同时在等名单的调用方
  };

  /** 当前筛选条件的签名：条件变了才需要重新问服务端 */
  function rosterKey() {
    const f = A.S.filters.roster;
    /* ⚠ 新增筛选项**必须加进这个签名**，否则切了条件却用缓存不重拉，
       界面看着"没反应"（而且不报错，最难查）。
       eventId 是按项目筛，忘了加就表现为"选了项目名单不变"。 */
    return [f.groupId, f.grade, f.className, f.eventId, f.search].join('\u0001');
  }

  /**
   * 拿名单（条件没变、数据版本也没变，就不重复请求）。
   *
   * 【为什么还要比版本】名单不在快照里了，所以"别处改了运动员"不会体现在
   * 本地快照上。用 rev 判断：本地快照的 rev 比名单新 → 说明中间有改动 → 重拉。
   * 这样就不用去每个改动点手动写"作废名单"（漏一处就显示旧数据）。
   *
   * @returns {Promise} 名单就位后 resolve —— 要"等新数据到手"的调用方接它
   *   （报名数刚改过时就得等，否则读到的是旧数字）
   */
  function ensureRoster(force) {
    const key = rosterKey();
    const rev = Number((A.S.snap && A.S.snap.rev) || 0);
    // 数据版本比名单新 → 名单作废
    if (ROSTER.loaded && rev && ROSTER.rev && rev > ROSTER.rev) ROSTER.key = '';
    if (!force && ROSTER.loaded && key === ROSTER.key) return Promise.resolve(ROSTER.list);
    if (ROSTER.loading) {
      // 已经有一个请求在飞：等它的结果，不要再发一个
      ROSTER.waiters = ROSTER.waiters || [];
      return new Promise((resolve) => { ROSTER.waiters.push(resolve); });
    }
    ROSTER.key = key;
    ROSTER.loading = true;
    ROSTER.error = '';
    const f = A.S.filters.roster;
    const q = { limit: 2000 };
    if (f.groupId) q.groupId = f.groupId;
    if (f.grade) q.grade = f.grade;
    if (f.className) q.className = f.className;
    if (f.eventId) q.eventId = f.eventId;
    if (f.search) q.search = f.search;

    return App.api('/api/roster', { query: q }).then((r) => {
      ROSTER.loading = false;
      if (!r.ok || !r.data || !r.data.ok) {
        ROSTER.error = '名单读取失败（' + ((r.data && r.data.message) || r.status || '网络错误') + '）';
        renderList();
        flushWaiters();
        return ROSTER.list;
      }
      const d = r.data.data;
      ROSTER.list = d.athletes || [];
      ROSTER.total = d.total || 0;
      ROSTER.count = d.count || 0;
      ROSTER.grades = d.grades || [];
      ROSTER.classes = d.classes || [];
      ROSTER.events = d.events || [];
      ROSTER.relayTeams = d.relayTeams || [];
      ROSTER.eventFilter = d.eventFilter || null;
      ROSTER.rev = d.rev || 0;
      ROSTER.loaded = true;
      render();                    // 下拉的候选值也要跟着更新，所以整页重画
      flushWaiters();
      return ROSTER.list;
    });
  }

  /** 唤醒所有在等名单的调用方 */
  function flushWaiters() {
    const ws = ROSTER.waiters || [];
    ROSTER.waiters = [];
    ws.forEach(fn => { try { fn(ROSTER.list); } catch (e) { /* ignore */ } });
  }

  /** 别处改了运动员 → 名单作废，下次进页面重拉。
   *  （平时不用手动调：ensureRoster 里会拿快照的 rev 自动判断。） */
  function invalidateRoster() { ROSTER.key = ''; }

  function renderList() {
    const box = el('rosterList');
    if (!box) return;

    /* 先把数据准备好再画。
       这一行**必须在 renderList 里**、不能只放在 render() 里 ——
       改筛选时走的是 renderList()（不经过 render()），
       少了这一行就会出现"筛选值改了、界面却没重新拉数据"（我第一版就是这样，
       表现是选了年级之后还是显示全部 905 人，而且不报任何错）。 */
    ensureRoster();

    /* 名单已经是服务端按条件筛好的 —— 这里**不再前端过滤一遍**。
       两边都筛会出现"服务端筛了、前端又筛"的口径不一致。 */
    const list = ROSTER.list || [];

    /* 【原地更新】说明行只建一次，之后只改文字。
       ⚠ 注意它不在 box（= #rosterList）里，而在**外层** —— 见 render() 里的注释：
       rosterList 的内容归 reconcile 管，塞进去会被删掉。
       所以这里要从 pane 里找，不能从 box 里找。
       （我第一版就是写成 box.querySelector，结果 info 永远是 null，
        setText 遇到 null 会**静默返回**，于是说明行一直是空的、还不报错。） */
    const info = document.querySelector('#paneRoster [data-part="info"]');
    if (ROSTER.error) {
      App.dom.setText(info, ROSTER.error + '　·　换个筛选条件或切走再回来可重试');
    } else if (ROSTER.loading && !list.length) {
      App.dom.setText(info, '正在读取名单…');
    } else if (ROSTER.eventFilter) {
      /* 按项目筛时，说清"这是这个项目的报名名单"，并提示每人还兼了什么项
         —— 现场核对名单时最容易出的问题就是兼项撞车（同一时段两个项目）。 */
      App.dom.setText(info, '项目名单：' + ROSTER.eventFilter.name
        + '　·　共 ' + list.length + ' 人'
        + '　·　「还报了」列是他兼的其它项目；点「报名 N 项」可增删');
    } else {
      App.dom.setText(info, '共 ' + ROSTER.total + ' 名运动员，当前显示 ' + list.length + ' 名'
        + '　·　点「报名 N 项」展开看报了哪些项目，可以直接增删');
    }
    const blocks = [];
    /* 按项目筛时多一列"还报了" —— 列数变了必须让 reconcile 重建块
       （key 里带上它，否则表头 7 列、数据 8 格，整张表错位）。 */
    const showOther = !!ROSTER.eventFilter;
    if (!list.length) {
      blocks.push({ key: 'empty', empty: true });
    } else {
      // 同班成块
      list.forEach((a) => {
        const label = a.team || ((a.grade || '') + (a.className ? '(' + a.className + ')' : '')) || '未分班';
        let b = blocks.find(x => x.label === label);
        if (!b) { b = { key: 'b:' + (showOther ? 'o|' : 'n|') + label, label, people: [] }; blocks.push(b); }
        b.people.push(a);
      });
    }

    /* 每个班一块（块头 + 一张表），块内行按运动员 id 对齐。
       块头/表格/表头只在第一次出现这个班时建；之后只更新行。 */
    App.dom.reconcile(box, blocks, b => b.key, (b, node) => {
      if (b.empty) {
        if (!node) node = h('div', { class: 'empty' });
        App.dom.setText(node, ROSTER.total
          ? '没有符合筛选条件的运动员'
          : '还没有运动员。点上面「导入名单」从 Excel 粘贴，或「加一名运动员」。');
        return node;
      }
      if (!node) {
        node = h('div', { class: 'class-block' }, [
          h('div', { class: 'class-head' }, [h('span', { 'data-cell': 'label' }), h('span', { class: 'n' })]),
          h('div', { class: 'table-wrap' }, [
            h('table', { class: 'grid' }, [
              h('thead', {}, [h('tr', {}, [
                h('th', { text: '组别' }), h('th', { text: '年级' }), h('th', { text: '班级' }),
                h('th', { text: '号码' }), h('th', { text: '姓名' }),
                /* 按项目筛时多一列"还报了"：看这个人还兼了什么项，
                   现场核对名单时最容易出问题的就是兼项撞车。 */
                showOther ? h('th', { text: '还报了' }) : null,
                h('th', { text: '报名' }),
                h('th', { text: '操作' }),
              ])]),
              h('tbody'),
            ]),
          ]),
        ]);
      }
      App.dom.setText(node.querySelector('[data-cell="label"]'), b.label);
      App.dom.setText(node.querySelector('.class-head .n'), b.people.length + ' 人');
      const tb = node.querySelector('tbody');
      App.dom.reconcile(tb, b.people, a => 'a:' + a.id, (a, tr) => athleteRow(tr, a, showOther));
      return node;
    });
  }

  /**
   * 建/更新一个运动员行（含下面那行"报名明细"）。
   * 行内所有可编辑格子用 editCell 生成，它的值只在"不在输入状态"时才回写 ——
   * 否则会把正在改的内容冲掉。
   */
  function athleteRow(tr, a, showOther) {
    if (!tr) {
      tr = h('tr', {}, [
        h('td', { 'data-cell': 'group' }),
        h('td', {}, [editCell('athlete', a.id, 'grade', a.grade, '年级')]),
        h('td', {}, [editCell('athlete', a.id, 'className', a.className, '班级')]),
        h('td', { class: 'num' }, [editCell('athlete', a.id, 'bib', a.bib, '号码')]),
        h('td', {}, [editCell('athlete', a.id, 'name', a.name, '姓名')]),
        showOther ? h('td', { 'data-cell': 'other', class: 'box-note' }) : null,
        h('td', { class: 'num' }, [h('button', {
          class: 'btn btn-sm btn-ghost reg-toggle', type: 'button',
          text: (a.regCount || 0) + ' 项 ▾',
        })]),
        h('td', {}, [
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: '删除' }),
        ]),
      ]);
      tr.setAttribute('data-athlete', a.id);
      // 报名明细行（默认收起）
      const detailTr = h('tr', { class: 'reg-detail', hidden: true },
        [h('td', { colspan: showOther ? '8' : '7' })]);
      /* 用 tbody 把"运动员行 + 明细行"绑成一组，reconcile 以组为单位对齐。
         一行一个节点不好表达"两行一组"，而表格里又不能塞 div。 */
      const pair = h('tbody', { 'data-pair': a.id });
      pair.appendChild(tr);
      pair.appendChild(detailTr);
      tr.__pair = pair;
      tr.__detail = detailTr;
      tr.__detailTd = detailTr.firstChild;
      bindAthleteRow(tr);
      return pair;
    }
    // 已存在：只更新组别文字（其余格子是输入框，值由 bindEditable 自己管）
    App.dom.setText(tr.querySelector('[data-cell="group"]'), a.groupName || '');
    const oc = tr.querySelector('[data-cell="other"]');
    if (oc) App.dom.setText(oc, (a.otherEvents || []).join('、'));
    return tr;
  }

  /**
   * 给一个运动员行绑事件（**只绑一次**，行会被复用）。
   *
   * 【为什么用 id 现查而不用闭包】行是原地复用的：第一次建行时闭包里的 a
   * 是当时的快照对象；之后再收到新数据，那个 a 已经过期了 ——
   * 点"删除"会删掉旧信息、点"报名 N 项"会用旧数据去查。
   * 所以回调里一律 athleteById(当前行 id) 现取。
   */
  function athleteById(id) {
    // 名单现在存在 ROSTER 里（第 3 趟改造：快照里不再带名单）
    const list = ROSTER.list || [];
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function bindAthleteRow(tr) {
    const regBtn = tr.querySelector('.reg-toggle');
    const delBtn = tr.querySelector('td:last-child button');
    const detailTr = tr.__detail;
    const detailTd = tr.__detailTd;

    let opened = false;
    regBtn.title = '看这个运动员报了哪些项目（可增删）';
    regBtn.addEventListener('click', () => {
      const a = athleteById(tr.getAttribute('data-athlete'));
      if (!a) return;
      opened = !opened;
      detailTr.hidden = !opened;
      App.dom.setText(regBtn, (a.regCount || 0) + ' 项 ' + (opened ? '▴' : '▾'));
      if (opened) loadRegs(a, detailTd, regBtn);
    });

    delBtn.addEventListener('click', () => {
      const a = athleteById(tr.getAttribute('data-athlete'));
      if (!a) return;
      A.ask({
        title: '删除运动员',
        text: '将删除「' + a.name + '」及其全部报名与成绩记录（接力队员姓名是快照，不受影响）。',
        okText: '删除', danger: true,
      }).then((r) => {
        if (!r.ok) return;
        A.cmd('athlete.del', { id: a.id }).then(() => A.refresh());
      });
    });
  }

  /* ── 报名明细：看得到、能删、能加 ────────────────────────────────────── */

  /**
   * 读取某个运动员的报名明细并画在展开行里。
   *
   * 为什么不直接用快照里的 athletes：快照只带 regCount（省流量），
   * 具体报了哪些项目要单独问服务端 —— 900 人的报名明细全塞进快照会很大。
   */
  function loadRegs(a, holder, btn) {
    clear(holder);
    holder.appendChild(h('div', { class: 'empty', text: '正在读取报名明细…' }));
    A.api('/api/athlete/' + encodeURIComponent(a.id) + '/regs').then((r) => {
      if (!r.ok || !r.data || !r.data.ok) {
        clear(holder);
        holder.appendChild(h('div', { class: 'empty', text: (r.data && r.data.message) || r.error || '读取失败' }));
        return;
      }
      drawRegs(a, holder, btn, (r.data.data && r.data.data.regs) || []);
    });
  }

  function drawRegs(a, holder, btn, regs) {
    clear(holder);
    const box = h('div', { class: 'reg-box' });

    const head = h('div', { class: 'reg-head' });
    head.appendChild(h('b', { text: a.name + '（' + (a.bib || '无号码') + '）的报名项目' }));
    head.appendChild(h('span', { class: 'box-note', text: '共 ' + regs.length + ' 项' }));
    box.appendChild(head);

    if (!regs.length) {
      box.appendChild(h('div', { class: 'empty', text: '这个运动员还没有报名任何项目' }));
    } else {
      const chips = h('div', { class: 'reg-chips' });
      regs.forEach((rg) => {
        const chip = h('span', { class: 'reg-chip' + (rg.isRelay ? ' is-relay' : '') });
        chip.appendChild(h('span', { class: 't', text: rg.eventName + (rg.stage === 'heat' ? '（预赛）' : '') }));
        if (rg.isRelay) {
          chip.appendChild(h('span', { class: 'n', text: '队：' + (rg.teamName || a.className || '') }));
          if (rg.legs && rg.legs.length) chip.appendChild(h('span', { class: 'n', text: rg.legs.join('、') }));
        }
        if (rg.hasResult) chip.appendChild(h('span', { class: 'n pill pill-ok', text: '已有成绩' }));
        // 已有成绩的不让删（会把成绩一起删掉，风险大）
        chip.appendChild(h('button', {
          class: 'x', type: 'button', text: '×',
          hidden: !!rg.hasResult,
          title: rg.hasResult ? '已经录了成绩，先清掉成绩再取消报名' : '取消这个项目的报名',
          dataset: { needWrite: '1' },
          onclick: () => {
            A.ask({
              title: '取消报名',
              text: '把「' + a.name + '」从「' + rg.eventName + '」的名单里去掉？',
              okText: '取消报名', danger: true,
            }).then((res) => {
              if (!res.ok) return;
              A.cmd('reg.del', { id: rg.id }).then(() => {
                A.refresh().then(() => loadRegs(a, holder, btn));
              });
            });
          },
        }));
        chips.appendChild(chip);
      });
      box.appendChild(chips);
    }

    /* 加一个项目：只列出"这个组别 + 同性别的个人项目，且还没报的" */
    const myEvents = (A.S.snap.events || []).filter((e) =>
      e.groupId === a.groupId && !e.isRelay
      && !regs.some(rg => rg.eventId === e.id));
    const bar = h('div', { class: 'reg-add' });
    if (myEvents.length) {
      const sel = h('select', { class: 'select' });
      myEvents.forEach(e => sel.appendChild(h('option', { value: e.id, text: e.name })));
      bar.appendChild(sel);
      bar.appendChild(h('button', {
        class: 'btn btn-sm btn-primary', type: 'button', text: '加入这个项目',
        dataset: { needWrite: '1' },
        onclick: () => {
          A.cmd('reg.add', { eventId: sel.value, athleteId: a.id }).then(() => {
            /* 报名数变了：名单作废 → 重拉 → **等它回来**再更新按钮文字。
               不等的话读到的是旧数字（第一版就踩了这个坑）。
               名单现在走 /api/roster（第 3 趟改造），不再是快照的一部分。 */
            invalidateRoster();
            A.refresh();
            ensureRoster(true).then(() => {
              const fresh = athleteById(a.id) || a;
              btn.textContent = (fresh.regCount || 0) + ' 项 ▴';
              loadRegs(fresh, holder, btn);
            });
          });
        },
      }));
    } else {
      bar.appendChild(h('span', { class: 'box-note', text: '这个组别里能报的项目都已经报过了' }));
    }
    box.appendChild(bar);

    // 接力项目单独说明：接力按班级成队，不按人报
    const relayEvs = (A.S.snap.events || []).filter(e => e.isRelay && e.groupId === a.groupId);
    if (relayEvs.length) {
      box.appendChild(h('div', {
        class: 'box-note',
        text: '接力（' + relayEvs.map(e => e.name).join('、') + '）是按班级成队报名的，'
          + '队员姓名在「赛程编排 → 名单/录入」里维护，不在这里单人报名。',
      }));
    }

    holder.appendChild(box);
  }

  /** 行内可编辑单元格：改完离开就暂存 */
  function editCell(kind, id, field, value, placeholder) {
    const input = h('input', {
      class: 'input input-editable', type: 'text', placeholder: placeholder,
    });
    input.style.minWidth = field === 'name' ? '110px' : '72px';
    input.style.width = field === 'name' ? '110px' : '72px';
    const current = A.val(kind, id, field, value);
    A.bindEditable(input, {
      value: current === null || current === undefined ? '' : String(current),
      onCommit: (v) => {
        const payload = { id };
        payload[field] = v;
        A.setLocal(kind, id, field, v);
        A.cmd('athlete.update', payload).then(() => A.refresh());
      },
    });
    return input;
  }

  /* gradeRank / classRank 原来在这里，用来给两个下拉的候选值排序。
     第 3 趟改造后年级/班级候选值改由 /api/roster 返回（服务端已经排好序），
     这两个函数就没人用了 —— 删掉，免得留着让人以为改这里有用。 */

  /* ── 手动加一个人 ────────────────────────────────────────────────────── */

  function addOne() {
    const S = A.S;
    const snap = S.snap;
    const name = h('input', { class: 'input', placeholder: '姓名（必填）' });

    /* ── 年级 → 组别 联动 ──────────────────────────────────────────────────
     * 【这里原来是个会静默出错的 BUG】
     *   以前弹窗里既有"组别"下拉、又有"年级"输入框，老师只填年级，
     *   组别下拉就取默认值 —— 而服务端在组别为空时返回 groups[0]（初一组），
     *   于是**新加的人全被归到初一组**，还不报错。
     *
     * 现在的做法：**年级说了算**，组别由年级推出来、只读显示。
     *   这样错的组合根本选不出来，也不会再有"默认落进初一组"这回事。
     */
    const groups = snap.groups || [];
    const bare = (s) => String(s || '').replace(/组$/, '').trim();

    /** 与后端 groupFromGrade 同一套口径：去"组"后全等 → 再按包含匹配 */
    function groupForGrade(g) {
      const gb = bare(g);
      if (!gb) return null;
      let hit = groups.filter(x => bare(x.name) === gb);
      if (hit.length === 1) return hit[0];
      if (hit.length > 1) return null;
      hit = groups.filter(x => gb.indexOf(bare(x.name)) >= 0 && bare(x.name).length >= 2);
      return hit.length === 1 ? hit[0] : null;
    }

    /* 可选的年级：用名单里已有的（统一写法），也允许自己填新的 */
    const grades = (ROSTER.grades || []).slice();
    const grade = h('select', { class: 'select' });
    grades.forEach(g => grade.appendChild(h('option', { value: g, text: g })));
    grade.appendChild(h('option', { value: '__custom__', text: '（其它年级…）' }));
    const gradeFree = h('input', { class: 'input', placeholder: '年级，如 高一', hidden: true });
    if (!grades.length) { grade.hidden = true; gradeFree.hidden = false; }

    const groupHint = h('span', { class: 'hint' });
    function syncGroup() {
      const g = gradeFree.hidden ? grade.value : gradeFree.value.trim();
      const grp = groupForGrade(g);
      if (!g) {
        App.dom.setText(groupHint, '先选年级');
        groupHint.style.color = '';
      } else if (grp) {
        App.dom.setText(groupHint, '将归入「' + grp.name + '」');
        groupHint.style.color = '';
      } else {
        App.dom.setText(groupHint, '认不出该归哪个组别（现有：'
          + groups.map(x => x.name).join('、') + '）—— 请改用上面的写法');
        groupHint.style.color = 'var(--red, #d24b3e)';
      }
    }
    grade.addEventListener('change', () => {
      const custom = grade.value === '__custom__';
      gradeFree.hidden = !custom;
      if (custom) setTimeout(() => gradeFree.focus(), 30);
      syncGroup();
    });
    gradeFree.addEventListener('input', syncGroup);

    const cls = h('input', { class: 'input', placeholder: '班级，如 3班' });
    const bib = h('input', { class: 'input', placeholder: '号码（建议填，不能与别人重复）' });
    /* 【性别要能填】它是"这个人能报哪些项目"的依据 —— 男子项目 vs 女子项目，
       接力也按男女分开组队。以前这个框没有性别，加完只能再去名单里补一遍。 */
    const gender = h('select', { class: 'select' }, [
      h('option', { value: '', text: '（不填）' }),
      h('option', { value: '男', text: '男' }),
      h('option', { value: '女', text: '女' }),
    ]);
    const team = h('input', { class: 'input', placeholder: '单位/班级显示名，可空' });

    const errBox = h('div', { class: 'ask-text', style: { color: 'var(--red, #d24b3e)', display: 'none' } });

    const body = h('div', { class: 'form-grid' }, [
      h('label', { class: 'field field-wide' }, [h('span', { class: 'label', text: '姓名' }), name]),
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '年级' }), grade, gradeFree]),
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '性别' }), gender]),
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '班级' }), cls]),
      h('label', { class: 'field' }, [h('span', { class: 'label', text: '号码' }), bib]),
      h('label', { class: 'field field-wide' }, [h('span', { class: 'label', text: '单位（大屏"班级"列显示的字，可空）' }), team]),
      h('label', { class: 'field field-wide' }, [h('span', { class: 'label', text: '归入组别' }), groupHint]),
      errBox,
    ]);

    const modal = el('askModal');
    el('askTitle').textContent = '加一名运动员';
    el('askText').textContent = '加了之后是暂存状态，点右上角"确认并推送"才正式生效。'
      + '组别由年级自动决定（本届组别就是按年级分的），号码不能与别人重复。';
    const field = el('askField');
    field.hidden = false;
    clear(field);
    field.appendChild(body);
    el('askOk').textContent = '加入';
    el('askOk').className = 'btn btn-primary';
    modal.hidden = false;
    syncGroup();
    setTimeout(() => name.focus(), 40);

    const showErr = (msg) => {
      errBox.textContent = msg || '';
      errBox.style.display = msg ? '' : 'none';
    };

    const finish = () => {
      modal.hidden = true;
      el('askOk').onclick = null;
      el('askCancel').onclick = null;
      el('askClose').onclick = null;
      clear(field); field.hidden = true;
      field.appendChild(h('span', { class: 'label', id: 'askLabel' }));
      field.appendChild(h('input', { class: 'input', id: 'askInput', type: 'text', autocomplete: 'off' }));
    };
    el('askCancel').onclick = finish;
    el('askClose').onclick = finish;
    el('askOk').onclick = () => {
      showErr('');
      if (!name.value.trim()) { showErr('姓名不能为空'); name.focus(); return; }
      const g = (gradeFree.hidden ? grade.value : gradeFree.value.trim());
      if (!g || g === '__custom__') {
        showErr('请选择或填写年级 —— 组别要按年级来定');
        if (!gradeFree.hidden) gradeFree.focus(); else grade.focus();
        return;
      }
      const grp = groupForGrade(g);
      if (!grp) {
        showErr('年级「' + g + '」认不出该归哪个组别。'
          + '现有组别：' + groups.map(x => x.name).join('、')
          + '。请用上面的写法（如「高一」）。');
        return;
      }
      /* 只提交年级，**组别由服务端按同一个规则推**（不信任前端算的结果，
         免得两边口径漂移）。服务端也认 grade，推不出来会明确报错。 */
      A.cmd('athlete.add', {
        name: name.value.trim(), gender: gender.value,
        grade: g, className: cls.value.trim(),
        bib: bib.value.trim(), team: team.value.trim(),
      }).then((res) => {
        if (res && res.failed) {
          /* 服务端会给出具体原因（号码重复 / 同班同名…），直接显示在框里，
             别关掉弹窗让人重填一遍。 */
          showErr(res.error || '加入失败');
          return;
        }
        finish();
        /* 【必须手动让名单作废重拉】名单不在快照里（第 3 趟改造改成按需拉了），
           所以 A.refresh() 只更新快照，名单列表不会变 —— 表现就是"加了人但列表里没有"。
           这里照 reg.add 那边的做法：invalidateRoster() + ensureRoster(true)。 */
        invalidateRoster();
        A.refresh();
        ensureRoster(true);
      });
    };
  }

  /* ── 导入名单 ────────────────────────────────────────────────────────── */

  function openImporter() {
    IMPORTER.open = true;
    render();
    setTimeout(() => { const t = el('importText'); if (t) t.focus(); }, 40);
  }

  /**
   * 导入面板。解析与列名识别统一走 public/roster-import.js ——
   * 这里原来有一份自己的 ALIAS + parseTable，和"导入与设置"页签那份会慢慢走偏，
   * 所以收敛成一个模块（前后端也共用同一套规则）。
   */
  function importerBox() {
    const RI = window.RosterImport;
    const box = h('div', { class: 'box' });
    box.appendChild(h('div', { class: 'box-head' }, [
      h('div', { class: 'box-title', text: '导入名单' }),
      h('div', { class: 'box-note', text: '从 Excel 选中整块（含表头）复制粘贴即可；也可选 .csv / .tsv / .txt（GBK 中文 CSV 也能读）' }),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm', type: 'button', text: '关闭', onclick: () => { IMPORTER.open = false; render(); } }),
    ]));
    const body = h('div', { class: 'box-body' });

    body.appendChild(h('div', { class: 'field' }, [
      h('span', { class: 'label', text: '认这些列名（第一行是表头；只有「姓名」是必须的）' }),
      h('div', { class: 'hint', text: '姓名（必填）、组别、年级、班级、号码、单位、性别、备注　——　别名、全角、空格、括号都能认' }),
    ]));

    const ta = h('textarea', {
      class: 'textarea', id: 'importText', rows: '10', style: { minHeight: '200px', fontFamily: 'Consolas, monospace', fontSize: '13px' },
      placeholder: '姓名\t组别\t年级\t班级\t号码\n张三\t男子组\t高一\t1班\t101\n李四\t男子组\t高一\t2班\t102\n（直接从 Excel 复制整块粘进来；制表符、逗号、分号分隔都能认）',
    });
    ta.addEventListener('input', () => { IMPORTER.text = ta.value; });
    ta.value = IMPORTER.text || '';
    body.appendChild(h('label', { class: 'field' }, [h('span', { class: 'label', text: '粘贴数据' }), ta]));

    const fileInput = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/plain', style: { display: 'none' } });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (/\.xlsx?$/i.test(file.name)) {
        A.ask({
          title: '这个文件读不了（.xlsx 是压缩包）',
          text: '程序不引第三方库，读不了 .xlsx。两个办法：\n\n'
            + '① 打开这个 Excel，选中名单那一块（连表头）→ Ctrl+C → 粘到上面的框里（最省事）\n'
            + '② 在 Excel 里「另存为 → CSV UTF-8(逗号分隔)」，再选那个 .csv 文件',
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
          IMPORTER.text = dec.text;
          if (dec.warning) A.toast('已读入 ' + file.name + '：' + dec.warning, 'warn', 8000);
          else A.toast('已读入 ' + file.name + '（' + Math.round(file.size / 1024) + ' KB，编码 ' + dec.encoding + '）', 'ok');
        } catch (e) {
          A.toast('读文件出错：' + (e && e.message), 'bad', 6000);
        }
      };
      reader.readAsArrayBuffer(file);      // 自己按字节判编码（GBK 的中文 CSV 也能读）
    });

    const row = h('div', { class: 'toolbar', style: { marginTop: '10px' } }, [
      h('button', { class: 'btn', type: 'button', text: '选择文件…', onclick: () => fileInput.click() }),
      fileInput,
      h('button', {
        class: 'btn btn-sm', type: 'button', text: '看看能认出哪些列',
        onclick: () => {
          const parsed = RI.parseTable(ta.value);
          if (parsed.error) { A.toast(parsed.error, 'warn', 6000); return; }
          const known = (parsed.columns || []).filter(c => c.label).map(c => c.head + '→' + c.label);
          const unknown = (parsed.columns || []).filter(c => !c.label).map(c => c.head);
          A.ask({
            title: '列名识别结果',
            text: '读到 ' + parsed.rows.length + ' 行数据，表头在第 ' + (parsed.headerLine + 1) + ' 行。\n\n'
              + '认出的列：' + (known.join('、') || '（无）')
              + '\n没认出的列（会被忽略）：' + (unknown.join('、') || '（无）'),
            okText: '知道了',
          });
        },
      }),
      h('button', {
        class: 'btn btn-sm', type: 'button', text: '填示例',
        onclick: () => { ta.value = RI.templateText(); IMPORTER.text = ta.value; },
      }),
      h('span', { class: 'grow' }),
      h('button', {
        class: 'btn btn-primary', type: 'button', text: '导入（先暂存，确认后生效）',
        onclick: () => {
          const parsed = RI.parseTable(ta.value);
          if (parsed.error) { A.toast(parsed.error, 'warn', 6000); return; }
          const rows = parsed.rows;
          if (!rows.length) { A.toast('没有读到数据行', 'warn'); return; }
          const preview = rows.slice(0, 5).map(r => [
            RI.pick(r, parsed.map, 'name') || '（无姓名）', RI.pick(r, parsed.map, 'group'),
            RI.pick(r, parsed.map, 'grade'), RI.pick(r, parsed.map, 'className'),
            RI.pick(r, parsed.map, 'bib'),
          ].join(' / ')).join('\n');
          A.ask({
            title: '导入 ' + rows.length + ' 行名单',
            text: '前几行预览（姓名 / 组别 / 年级 / 班级 / 号码）：\n' + preview
              + '\n\n导入后是**暂存**状态，点顶部「确认修改并推送大屏」才正式生效。\n同一个人（同组别+同名+同号码）会被更新，不会重复添加。',
            okText: '导入',
          }).then((r) => {
            if (!r.ok) return;
            // 把列映射一起送去：前后端用同一份识别结果
            A.cmd('athlete.import', { rows, map: parsed.map }).then((res) => {
              const d = (res && res.data) || {};
              if (d.errors && d.errors.length) {
                A.ask({ title: '导入完成，但有几行被跳过', text: d.errors.join('\n'), okText: '知道了' });
              }
              IMPORTER.open = false;
              IMPORTER.text = '';
              A.refresh();
            });
          });
        },
      }),
    ]);
    body.appendChild(row);
    box.appendChild(body);
    return box;
  }

  /**
   * 诊断用：把名单的加载状态暴露出去（自动化验收要读它，现场排查也用得上）。
   * 单独一个函数而不是让测试去猜内部变量 —— 猜变量名是最容易写错的。
   */
  A.rosterDiag = function () {
    return {
      loaded: ROSTER.loaded,
      loading: ROSTER.loading,
      error: ROSTER.error,
      count: ROSTER.count,
      total: ROSTER.total,
      shown: ROSTER.list.length,
      key: ROSTER.key,
      rev: ROSTER.rev,
      grades: ROSTER.grades.length,
      classes: ROSTER.classes.length,
    };
  };

  A.register('roster', render);
})();
