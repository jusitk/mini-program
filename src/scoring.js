'use strict';
/**
 * scoring.js —— 名次、并列、计分、班级总分榜（业务核心，改之前先读注释）
 *
 * 【现场定下来的规则，一条都不能错】
 *  1. 径赛（track）成绩**越小越靠前**；田赛（field）**越大越靠前**
 *  2. 并列名次用**标准竞技排名**：1,2,2,4（不是 1,2,2,3）。成绩差 ≤ tol（默认 0.01）视为并列
 *  3. 并列时排序必须**稳定**：先比号码（小的在前、没号码的排后），再比姓名。
 *     否则同成绩的人每次刷新都会换位置，大屏上看着像在跳
 *  4. 弃权 / 受伤 / 退赛 / 犯规统一排在**所有有成绩的人之后**，显示"弃权"，人仍留在榜上
 *  5. 田赛多次试跳取**最好一次**（径赛同理取最快一次）；犯规的那次有记录但没有成绩
 *  6. 接力（isRelay）**按班级/队**排名，一条成绩对应一个班，分数记到班级
 *  7. 计分表默认 [7,5,4,3,2,1]（取前六名，第 2 名是 5 分不是 6 分，别"顺手改顺"）；
 *     并列者**各得该名次的全额分**（1,2,2,4 → 7,5,5,3）
 *  8. 班级总分榜：把各项目得分累加到班级；只有**已结束**的项目才计分
 *
 * 【名次为什么每次现算】
 *   名次是派生数据。存库的话，改一条成绩要连带改几十行名次，漏一处大屏就错。
 *   所以全部实时算，代价是每次查询多算一点 —— 本项目规模（几百人、几十项）完全够。
 */

const { formatResult, DNF_LABEL, FOUL_LABEL, isTie, normTol } = require('./parse');

/** 默认计分规则（可在后台改；改的是 meet.ruleJson） */
const DEFAULT_RULE = {
  /** 名次分表：第 1 名 7 分、第 2 名 5 分 … 第 6 名 1 分 */
  table: [7, 5, 4, 3, 2, 1],
  /** 并列怎么给分：full = 各得该名次全额分（现场口径） */
  tie: 'full',
  /** 决赛录取人数（预赛取前几名进决赛） */
  advanceCount: 6,
  /** 只统计已结束的项目（现场口径：进行中的项目名次还会变） */
  onlyFinished: true,
  /** 分数是否算接力（现场口径：算） */
  relayScored: true,
  /**
   * 接力的分值倍数。**现在默认 2 = 接力得分翻倍**（现场口径）。
   *
   * 【为什么接力翻倍】接力是一个班 4 个人一起挣的分，报名门槛和参与人数都比
   *   单项高（一个项目只算一条成绩、却要出动 4 名队员）。所以名次分按 2 倍给，
   *   让它跟单项的分量相匹配。改成 1 就是不翻倍。
   *
   * 这个字段本来就存在、计分时也一直会乘它（见 teamTotals 里的 mult），
   * 只是以前默认 1（不翻倍）。现在按现场要求改成 2。
   */
  relayMultiplier: 2,
};

/** 合并用户配置与默认规则 */
function mergeRule(rule) {
  const r = Object.assign({}, DEFAULT_RULE, rule || {});
  if (!Array.isArray(r.table) || !r.table.length) r.table = DEFAULT_RULE.table.slice();
  r.table = r.table.map(n => Number(n) || 0);
  /* 倍数必须是正数：0 或负数会让接力一分不给（而且不报错，最难查）。
     认不出的值退回默认（2）。 */
  const mult = Number(r.relayMultiplier);
  r.relayMultiplier = Number.isFinite(mult) && mult > 0 ? mult : DEFAULT_RULE.relayMultiplier;
  return r;
}

/** 名次分表里"第 rank 名"值多少分；超出表长 → 0 分 */
function pointsForRank(rule, rank) {
  if (!rank || rank < 1) return 0;
  const table = rule.table || DEFAULT_RULE.table;
  return rank <= table.length ? table[rank - 1] : 0;
}

/** 从 ruleJson 文本安全解析出规则 */
function ruleFromMeet(meet) {
  if (!meet) return mergeRule(null);
  let raw = null;
  try { raw = JSON.parse(meet.ruleJson || 'null'); } catch (e) { raw = null; }
  return mergeRule(raw);
}

/* ══════════════════════════════════════════════════════════════════════
 * 一、把"成绩行"汇总成"每条报名的最终成绩"
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 汇总一条报名的最终成绩。
 * @param {object} reg     报名行（含 id / athleteId / classId / teamName / legsJson / lane）
 * @param {Array}  rows    这条报名的所有成绩行（含 attempt / value / dnf / foul）
 * @param {object} ev      项目行（kind / attempts / tol / isRelay）
 * @returns {object} 汇总结果
 */
function bestOf(reg, rows, ev) {
  const dir = ev.kind === 'field' ? 'max' : 'min';
  const list = (rows || []).slice().sort((a, b) => (a.attempt || 1) - (b.attempt || 1));

  let best = null;         // 最好的一次成绩值
  let bestAttempt = null;
  let bestRow = null;
  let dnf = false;
  let anyFoul = false;
  let fouls = 0;
  let attemptsWithValue = 0;
  let lastAt = '';

  for (const r of list) {
    if (r.recordedAt && r.recordedAt > lastAt) lastAt = r.recordedAt;
    if (r.dnf) { dnf = true; continue; }
    if (r.foul || r.value === null || r.value === undefined) { anyFoul = true; fouls++; continue; }
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    attemptsWithValue++;
    if (best === null
      || (dir === 'max' ? v > best : v < best)
      || (v === best && bestAttempt !== null && (r.attempt || 1) < bestAttempt)) {
      best = v;
      bestAttempt = r.attempt || 1;
      bestRow = r;
    }
  }

  // 一次有效成绩都没有 → 视作"没有成绩"，名次排最后。
  //
  // 【犯规 ≠ 弃权】这两种情况都是"没成绩"，但**显示必须分开**：
  //   · 三次试跳全犯规（或径赛被判犯规）→ 显示"犯规"
  //   · 请假/没来/明确写了弃权        → 显示"弃权"
  // 所以额外给一个 foulOnly：没有有效成绩、且原因是犯规、而且没写过弃权。
  // 名次上两者一样（都排最后、都不计分），只有文字不同。
  const foulOnly = best === null && !list.some(r => r.dnf) && list.some(r => r.foul);
  if (best === null) dnf = list.length ? true : dnf;

  return {
    regId: reg.id,
    athleteId: reg.athleteId || null,
    classId: reg.classId || null,
    teamName: reg.teamName || null,
    legs: safeLegs(reg.legsJson),
    lane: reg.lane === null || reg.lane === undefined ? null : reg.lane,
    best,
    bestAttempt,
    bestRow,
    dnf: !!dnf,
    foul: anyFoul,
    foulOnly,
    fouls,
    attemptsWithValue,
    attempts: list.length,
    value: best,
    dir,
    recordedAt: lastAt || (list.length ? list[0].recordedAt : ''),
    rows: list,
  };
}

/** legsJson 解析（英文数组的 JSON 文本；坏数据不能把整页拖垮） */
function safeLegs(json) {
  if (!json) return [];
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) ? a.map(x => String(x)).filter(Boolean) : [];
  } catch (e) { return []; }
}

/* ══════════════════════════════════════════════════════════════════════
 * 二、一个项目的名次
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 给一组"最好成绩"排名次。
 * @param {Array} entries bestOf() 的结果数组（会被排序，调用方介意就先自行复制）
 * @param {object} ev 项目行
 * @param {object} rule 计分规则
 * @param {object} [extra] { nameOf(entry) → 姓名, bibOf(entry) → 号码 }
 * @returns {{rows:Array, groups:Array}} rows 带 rank/points
 */
function rankEntries(entries, ev, rule, extra) {
  extra = extra || {};
  const r = mergeRule(rule);
  /* 并列容差 = 该项目的**计时精度**（见 parse.js 顶部那段说明）。
     坏值/历史遗留值由 normTol 归到最近的档位，不让判等逻辑拿到没意义的值。 */
  const tol = normTol(ev.tol, ev.kind);
  const dir = ev.kind === 'field' ? 'max' : 'min';

  const nameOf = extra.nameOf || (e => e.teamName || '');
  const bibOf = extra.bibOf || (() => '');

  const valid = [];
  const dnfList = [];
  for (const e of entries || []) {
    if (e.dnf || e.best === null || !Number.isFinite(Number(e.best))) dnfList.push(e);
    else valid.push(e);
  }

  // 排序：先按成绩（径赛升序/田赛降序）；并列时按号码、再按姓名、最后按 regId 兜底
  valid.sort((a, b) => {
    const va = Number(a.best), vb = Number(b.best);
    if (va !== vb) return dir === 'max' ? vb - va : va - vb;
    return stableCompare(a, b, bibOf, nameOf);
  });

  // 弃权也排个稳定顺序（榜尾内部先按号码再按姓名），免得每次刷新跳来跳去
  dnfList.sort((a, b) => stableCompare(a, b, bibOf, nameOf));

  const rows = [];
  const groups = [];
  let i = 0;

  while (i < valid.length) {
    // 把"成绩差 ≤ 容差"的人归成一组（并列）
    let j = i;
    while (j + 1 < valid.length
      && isTie(Number(valid[j + 1].best), Number(valid[i].best), tol)) {
      j++;
    }
    const rank = i + 1;                 // 标准竞技排名：并列后跳号（1,2,2,4）
    const members = valid.slice(i, j + 1);
    const pts = pointsForRank(r, rank);  // 并列各得该名次的全额分
    const group = { rank, points: pts, members: [], value: Number(valid[i].best) };
    for (const e of members) {
      const row = decorate(e, ev, rank, pts, r);
      rows.push(row);
      group.members.push(row);
    }
    groups.push(group);
    i = j + 1;
  }

  // 没成绩的（弃权 / 全部犯规）：名次一律排在最后（并列于同一个"最后名次"）
  if (dnfList.length) {
    const lastRank = rows.length + 1;
    const group = { rank: lastRank, points: 0, members: [], dnf: true };
    for (const e of dnfList) {
      const row = decorate(e, ev, lastRank, 0, r);
      row.dnf = true;
      // display 已由 decorate 按"犯规/弃权"分好，别在这里覆盖成"弃权"
      rows.push(row);
      group.members.push(row);
    }
    groups.push(group);
  }

  return { rows, groups };
}

/** 稳定兜底比较：号码小在前（没号码排后）→ 姓名 → regId */
function stableCompare(a, b, bibOf, nameOf) {
  const ba = String(bibOf(a) || ''), bb = String(bibOf(b) || '');
  const na = ba === '' ? 1 : 0, nb = bb === '' ? 1 : 0;
  if (na !== nb) return na - nb;                       // 有号码的在前
  if (ba !== bb) {
    const x = Number(ba), y = Number(bb);
    if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;  // 号码按数字比，001 < 010
    if (ba !== bb) return ba < bb ? -1 : 1;
  }
  const sa = String(nameOf(a) || ''), sb = String(nameOf(b) || '');
  if (sa !== sb) return sa.localeCompare(sb, 'zh-Hans-CN');
  return String(a.regId || '').localeCompare(String(b.regId || ''));
}

/** 给一条结果补上显示字段 */
/**
 * 给一行加上名次/得分/显示文本。
 *
 * display 的优先级（**犯规和弃权必须分开显示**，以前这里只判断 dnf，
 * 结果"三次试跳全犯规"的人在大屏上显示成了"弃权"，老师一眼就看出不对）：
 *   弃权 → "弃权"；只有犯规没有成绩 → "犯规"；否则显示成绩
 */
function decorate(e, ev, rank, points, rule) {
  const isRelay = !!ev.isRelay;
  let display;
  if (e.foulOnly) display = FOUL_LABEL;
  else if (e.dnf) display = DNF_LABEL;
  else display = formatResult(e.best, ev.kind);
  return Object.assign({}, e, {
    rank,
    points,
    display,
    kind: ev.kind,
    isRelay,
    eventId: ev.id,
    eventName: ev.name,
    targetType: isRelay ? 'class' : 'athlete',
  });
}

/* ══════════════════════════════════════════════════════════════════════
 * 三、预赛 → 决赛的自动录取
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 从预赛名次里取出"该进决赛的人"。
 * 并列跨录取线的处理（现场最容易吵的点）：
 *   如果第 6 名和第 7 名成绩相同（并列），**两个都进** —— 不能靠抽签把人挤掉。
 *
 * @param {Array} rows rankEntries() 出来的行（已带 rank）
 * @param {number} count 录取人数
 * @returns {{rows:Array, expandNote:string}} rows 是要录取的报名行
 */
function qualifiers(rows, count) {
  const n = Math.max(1, Number(count) || DEFAULT_RULE.advanceCount);
  const ranked = (rows || []).filter(r => !r.dnf && r.rank && r.best !== null && r.best !== undefined)
    .slice().sort((a, b) => a.rank - b.rank);
  if (!ranked.length) return { rows: [], expandNote: '' };

  const picked = [];
  let lastRank = 0;
  for (const r of ranked) {
    if (picked.length >= n && r.rank > lastRank) break;
    picked.push(r);
    lastRank = r.rank;
  }
  const expanded = picked.length > n;
  return {
    rows: picked,
    expandNote: expanded
      ? ('第 ' + n + ' 名出现并列，实际录取 ' + picked.length + ' 人（并列不淘汰）')
      : '',
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 四、班级总分榜
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 一条名次该把分记给谁。
 *  · 个人项目 → 该运动员所属班级
 *  · 接力项目 → 报名时就挂在班级/队上（一条成绩 = 一个班）
 * 返回 { classId, grade, className, label, key }
 */
function pointsTarget(entry, ctx) {
  const cls = entry.classId ? ctx.classById.get(entry.classId) : null;
  if (cls) {
    return {
      classId: cls.id, grade: cls.grade, className: cls.className,
      label: cls.label, key: cls.id,
    };
  }
  // 没有班级（接力队只填了队名，或运动员没分班）：用队名当独立的一行
  const name = entry.teamName || ctx.athleteName(entry) || '未分班';
  return { classId: null, grade: entry.grade || '其它', className: entry.className || name, label: name, key: 'name:' + name };
}

/**
 * 算班级总分。
 * @param {object} o
 *   @param {Array} o.events      项目行（含 id/name/kind/isRelay/stage/status）
 *   @param {Map}   o.boardByEvent eventId → { rows }（已算好名次的榜）
 *   @param {object} o.rule
 *   @param {Map}   o.classById
 *   @param {function} o.athleteName
 *   @param {Map}   [o.finalsOf]  heatEventId → finalEventId（有决赛的预赛，预赛分数不计）
 * @returns {{teams:Array, scoredEvents:Array, ruleText:string}}
 */
function teamTotals(o) {
  const rule = mergeRule(o.rule);
  const teams = new Map();      // key → 累计
  const scoredEvents = [];

  const ensure = (t) => {
    if (!teams.has(t.key)) {
      teams.set(t.key, {
        key: t.key, classId: t.classId, grade: t.grade, className: t.className,
        name: t.label, points: 0, gold: 0, silver: 0, bronze: 0, details: [],
      });
    }
    return teams.get(t.key);
  };

  for (const ev of o.events || []) {
    if (rule.onlyFinished && ev.status !== 'done') continue;
    if (ev.isRelay && !rule.relayScored) continue;
    // 预赛如果已经有决赛，名次分只算决赛那场（否则同一个人被算两次）
    if (o.finalsOf && o.finalsOf.has(ev.id)) continue;

    const board = o.boardByEvent.get(ev.id);
    // 注意层级：eventBoard() 返回 { event, entries, board:{rows,groups}, checkin }，
    // 名次行在 board.board.rows（这里取错过一次，表现是班级总分榜永远是空的）
    const rows = board && board.board && board.board.rows;
    if (!rows || !rows.length) continue;

    let scored = false;
    for (const row of rows) {
      if (!row.points || row.dnf) continue;
      const t = pointsTarget(row, o);
      const team = ensure(t);
      /* 接力按 relayMultiplier 倍给分（默认 2 = 翻倍）。
         这里的 `|| 1` 是兜底：万一有人绕过 mergeRule 直接塞了个残缺的 rule，
         也不至于把接力算成 0 分（算 0 分不报错，最难查）。 */
      const mult = ev.isRelay ? (rule.relayMultiplier || DEFAULT_RULE.relayMultiplier) : 1;
      const pts = Math.round(row.points * mult * 100) / 100;
      team.points = Math.round((team.points + pts) * 100) / 100;
      if (row.rank === 1) team.gold++;
      else if (row.rank === 2) team.silver++;
      else if (row.rank === 3) team.bronze++;
      team.details.push({
        eventId: ev.id, eventName: ev.name, rank: row.rank, points: pts,
        name: row.isRelay ? (row.teamName || '') : o.athleteName(row),
      });
      scored = true;
    }
    if (scored) scoredEvents.push(ev.id);
  }

  // 排序：总分降序 → 金牌多 → 银牌多 → 铜牌多 → 班级名（中文顺序）
  const list = Array.from(teams.values()).sort((a, b) =>
    b.points - a.points
    || b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze
    || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));

  // 名次：总分相同则**并列**（1,2,2,4），与项目名次口径一致
  let lastPts = null, lastRank = 0;
  list.forEach((t, i) => {
    if (lastPts === null || Math.abs(t.points - lastPts) > 0.001) { lastRank = i + 1; lastPts = t.points; }
    t.rank = lastRank;
  });

  /* ── 本年级名次（classRank）────────────────────────────────────────────
   *
   * 【为什么还要一个】初一和初三的班拿同样的分数，含金量完全不同（初一人少、
   * 初三项目多），混在一起排出来的"第 7 名"没有意义，也没有对应的名次分。
   * 现场关心的是"我们在**本年级**排第几"，所以每个年级内部单独排一次名次。
   *
   * 口径与总名次**完全一致**（分数相同并列、1,2,2,4），只是分组。
   * 注意：两个名次都要留着 ——
   *   rank       全校总名次（导出总榜、后台排序用）
   *   classRank  本年级名次（大屏按年级分页展示时用）
   * 名字叫 classRank 而不是 gradeRank：util.js 里已经有个 gradeRank(年级)
   * 是"年级排序权重"，两者完全不是一回事，重名会让人读错。
   */
  const byGrade = new Map();
  list.forEach((t) => {
    const g = t.grade || '其它';
    if (!byGrade.has(g)) byGrade.set(g, []);
    byGrade.get(g).push(t);
  });
  byGrade.forEach((arr) => {
    let gp = null, gr = 0;
    arr.forEach((t, i) => {
      if (gp === null || Math.abs(t.points - gp) > 0.001) { gr = i + 1; gp = t.points; }
      t.classRank = gr;
    });
  });

  return {
    teams: list,
    scoredEvents,
    /* 规则说明：把"接力翻倍"也写进去。不写的话，老师看到接力第 1 名
       拿了 14 分会以为算错了 —— 名次分表明明写着第 1 名 7 分。 */
    ruleText: '前六名 ' + rule.table.join('-')
      + (rule.relayScored && rule.relayMultiplier !== 1
        ? (' · 接力 ×' + rule.relayMultiplier) : '')
      + (rule.onlyFinished ? ' · 只算已结束项目' : ''),
  };
}

module.exports = {
  DEFAULT_RULE, mergeRule, ruleFromMeet, pointsForRank,
  bestOf, rankEntries, safeLegs, stableCompare, decorate,
  qualifiers, pointsTarget, teamTotals,
};
