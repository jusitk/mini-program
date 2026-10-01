/* ============================================================================
 * snapshot-merge.js —— 把服务端推来的"增量"合并进本地快照（纯函数）
 *
 * 【为什么单独一个文件、而且是纯函数】
 *   增量推送是这一版改动里唯一"出错会静默丢数据"的地方：合并错了页面不会报错，
 *   只会少显示一条成绩 —— 这种 bug 到现场才发现就晚了。
 *   所以合并逻辑必须能**脱离浏览器直接跑测试**：
 *   验收标准是「旧快照 + 增量」必须与「服务端新生成的全量快照」逐字段一致
 *   （见 test/snapshot-merge.test.js）。
 *   放在 public/ 下用 UMD 导出，浏览器和 Node 都能 require
 *   （跟 roster-import.js、dom.js 一个路子）。
 *
 * 【安全绳】patch.base 是"这条增量基于哪个版本"。
 *   它必须等于本地快照当前的 rev；对不上说明中间漏过消息
 *   （断线重连、手机切后台、SSE 掉线），此时**必须退回全量** —— 绝不能硬套。
 * ========================================================================== */
'use strict';

(function (global) {
  const has = (a) => Array.isArray(a) && a.length > 0;

  /** 按 id 把一批新条目替换/追加进数组（返回新数组） */
  function upsertById(list, fresh, idOf) {
    const out = (list || []).slice();
    (fresh || []).forEach((item) => {
      const id = idOf(item);
      const i = out.findIndex(x => idOf(x) === id);
      if (i >= 0) out[i] = item; else out.push(item);
    });
    return out;
  }

  /** 按 id 去掉若干条。list 为空/未定义时返回空数组（**不要返回 undefined**，
   *  否则下面 applyPositions 里的 .slice() 会炸 —— 测试抓到过） */
  function removeByIds(list, ids, idOf) {
    const src = Array.isArray(list) ? list : [];
    if (!has(ids)) return src.slice();
    const kill = new Set(ids.map(String));
    return src.filter(x => !kill.has(String(idOf(x))));
  }

  /**
   * 判断这份数据是"增量"还是"全量"。
   * 判据用 base 字段：全量快照永远不会带 base。
   */
  function isPatch(data) {
    return !!(data && data.base !== undefined && data.patch);
  }

  /**
   * 按"全量里的位置"把受影响的项目插回列表。
   *
   * 光把旧条目摘掉、新的追加到末尾是不够的：列表顺序也会因为这次改动而变。
   * 服务端在增量里给了每个受影响项目在**全量列表**里的下标，
   * 这里按这些下标插回去，合并结果与全量完全一致。
   *
   * @param {Array} list  已经摘掉受影响项目的列表
   * @param {Array} pairs [{ item, at }]，at 是全量里的下标（-1 表示位置未知 → 追加到末尾）
   */
  function applyPositions(list, pairs) {
    const out = list.slice();
    const tail = [];
    // 有位置的**从后往前**插（前面插入不会把后面的下标挤偏）；
    // 位置未知的追加到末尾，保证至少不会丢
    const known = (pairs || []).filter(x => x.at >= 0).sort((a, b) => b.at - a.at);
    (pairs || []).forEach((x) => { if (!(x.at >= 0)) tail.push(x); });
    known.forEach((pr) => {
      const at = Math.max(0, Math.min(pr.at, out.length));
      out.splice(at, 0, pr.item);
    });
    tail.forEach(pr => out.push(pr.item));
    return out;
  }

  /**
   * 合并。**会直接改 local**（调用方持有它的引用，改完就地生效）。
   * @returns {boolean} true = 成功；false = base 对不上（调用方应退回全量）
   */
  function merge(local, patchMsg) {
    if (!local || !patchMsg || !isPatch(patchMsg)) return false;
    if (String(patchMsg.base) !== String(local.rev)) return false;

    const p = patchMsg.patch || {};

    if (local.kind === 'screen') {
      const panels = local.panels = local.panels || {};
      const ids = p.eventIds || [];

      /* 先从 live/done/pending 三个列表里把受影响的项目**全部摘掉**，
         再按它现在的状态、**按服务端给的位置**插回去 ——
         这样"进行中 → 已结束"能正确搬家，列表顺序也和全量一致。
         （少摘一个就会出现"同一条成绩既在 live 又在 done 里"的重复。） */
      const live = removeByIds(panels.live, ids, x => x.id);
      const done = removeByIds(panels.done, ids, x => x.id);
      const pending = removeByIds(panels.pending, ids, x => x.id);

      /* 把受影响的项目按"新状态"分流，并各自成对带上它在全量里的位置。
         注意 ids 与 pos 必须**成对**走 —— 中间过滤过一次的话对应关系就错位了
         （我第一版就是把全集 ids 配了子集 pos，纯属自己给自己挖坑）。 */
      const toLive = [], toDone = [], toPend = [];
      const fresh = new Map();
      (p.events || []).forEach(c => fresh.set(String(c.id), c));
      const freshPend = new Map();
      (p.pending || []).forEach(c => freshPend.set(String(c.id), c));

      ids.forEach((id, i) => {
        const c = fresh.get(String(id));
        if (c) {
          // 与大屏全量快照同一个口径：done 是"最近结束的排最前"
          if (c.status === 'done') toDone.push({ id: id, item: c, at: p.donePos ? p.donePos[i] : -1 });
          else toLive.push({ id: id, item: c, at: p.livePos ? p.livePos[i] : -1 });
          return;
        }
        const pc = freshPend.get(String(id));
        if (pc) toPend.push({ id: id, item: pc, at: p.pendingPos ? p.pendingPos[i] : -1 });
        // 两边都没有 → 项目被删了，上面已经摘掉
      });

      panels.live = applyPositions(live, toLive);
      panels.done = applyPositions(done, toDone);
      panels.pending = applyPositions(pending, toPend);

      if (p.checkin) panels.checkin = p.checkin;
      if (p.team) panels.team = p.team;
      if (p.teamMeta) panels.teamMeta = p.teamMeta;
      if (p.notice) panels.notice = p.notice;      // 开始/停止检录会自动写一条公告
      if (p.stats) local.stats = Object.assign({}, local.stats, p.stats);
    } else {
      // 后台快照
      if (p.events) local.events = upsertById(local.events, p.events, x => x.id);
      if (p.team) local.team = p.team;
      if (p.teamMeta) local.teamMeta = p.teamMeta;
      if (p.notices) local.notices = p.notices;
      if (p.stats) local.stats = Object.assign({}, local.stats, p.stats);
    }

    local.rev = patchMsg.rev;          // 合并成功才推进版本
    local.at = patchMsg.at;
    return true;
  }

  const api = { merge, isPatch, upsertById, removeByIds };

  if (global.App) global.App.merge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
