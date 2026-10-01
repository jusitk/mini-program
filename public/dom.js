/* ============================================================================
 * dom.js —— DOM 打补丁小工具（不带框架，纯原生）
 *
 * 【为什么需要】
 *   后台原来每收到一次新数据就把整个页签 clear() 再重建。录入页上这意味着：
 *   成绩表整张重建 → 正在输入的框被换掉 → 焦点丢失、草稿丢失、滚动位置跳。
 *   服务端每次推 296KB、客户端每次重建上万节点，现场就是"每录一条闪一下"。
 *
 *   改成"原地打补丁"：节点留着，只改真正变了的文字/属性/样式；
 *   列表按**稳定 id** 对齐，行顺序变了也只移动不重建。
 *   这样输入框、光标、滚动位置天然保住，不用再靠"存草稿再填回去"打补丁。
 *
 * 【三个函数】
 *   reconcile(container, items, keyOf, buildOrUpdate, tagName?)
 *      按 key 把 items 对齐到容器子节点上。
 *   setText(node, text)     文字变了才写（不变就不动 DOM，省掉重排）
 *   setClass(node, cls)     类名变了才写
 *   setStyle(node, k, v)    样式变了才写
 *
 * 【约定】buildOrUpdate(item, node)
 *   node === null → 新建一个节点返回
 *   node !== null → 就地更新它并返回（同一个节点或换一个都行）
 * ========================================================================== */
'use strict';

(function (global) {
  /** 文字：只在真的不同时才写（写 textContent 会让浏览器重排该节点） */
  function setText(node, text) {
    if (!node) return;
    const t = text === null || text === undefined ? '' : String(text);
    if (node.textContent !== t) node.textContent = t;
  }

  /** 类名：只在不同时才写 */
  function setClass(node, cls) {
    if (!node) return;
    const c = cls || '';
    if (node.className !== c) node.className = c;
  }

  /** 属性：只在不同时才写。value === null/false 表示移除 */
  function setAttr(node, name, value) {
    if (!node) return;
    if (value === null || value === undefined || value === false) {
      if (node.hasAttribute(name)) node.removeAttribute(name);
      return;
    }
    const v = value === true ? '' : String(value);
    if (node.getAttribute(name) !== v) node.setAttribute(name, v);
  }

  /** 行内样式：只在不同时才写 */
  function setStyle(node, prop, value) {
    if (!node) return;
    if (value === null || value === undefined || value === '') {
      if (node.style.getPropertyValue(prop)) node.style.removeProperty(prop);
      return;
    }
    const v = String(value);
    if (node.style.getPropertyValue(prop) !== v) node.style.setProperty(prop, v);
  }

  /**
   * 按 key 把 items 对齐到 container 的子节点上。
   *
   * @param {Element} container 容器（它的子节点会被对齐；顺序也按 items 调整）
   * @param {Array} items       数据数组
   * @param {Function} keyOf    item → 稳定 id（字符串）。返回 null/undefined 的项不参与复用
   * @param {Function} buildOrUpdate (item, node|null) → Element
   * @param {string} [tagName]  新建时用的标签名（仅用于核对节点类型，可选）
   * @returns {{created:number, updated:number, removed:number}}
   */
  function reconcile(container, items, keyOf, buildOrUpdate, tagName) {
    const stats = { created: 0, updated: 0, removed: 0 };
    if (!container) return stats;
    const list = items || [];

    // ① 现有子节点按 key 建索引。同 key 出现多次时留第一个（正常情况下 key 是唯一的）。
    //    initial 记下"这一轮开始时就存在的节点"，第 ④ 步只删它们 ——
    //    绝不能按"现在容器里有什么"来删：新节点在下面就已经挂进去了，
    //    会被当成"没用到"一起删掉（这个 bug 是单测抓出来的，表现是列表整个空掉）。
    const initial = new Set(Array.prototype.slice.call(container.childNodes));
    const existing = new Map();
    const leftovers = [];
    initial.forEach((node) => {
      if (node.nodeType !== 1) { leftovers.push(node); return; }        // 文本节点等，稍后清掉
      const k = node.__key;
      if (k === undefined || k === null || existing.has(k)) { leftovers.push(node); return; }
      existing.set(k, node);
    });

    // ② 逐个对齐
    let cursor = container.firstChild;
    list.forEach((item) => {
      const key = keyOf(item);
      let node = (key === null || key === undefined) ? null : (existing.get(key) || null);
      if (node) existing.delete(key);

      const isNew = !node;
      node = buildOrUpdate(item, node);
      if (!node) return;
      if (isNew) stats.created++; else stats.updated++;
      node.__key = key;                       // 记在节点上，下一轮才能按 key 找到它

      // ③ 摆到正确位置：把 node 放到 cursor 之前（cursor 为 null 表示放到末尾）。
      //
      // 【必须判 node.parentNode === container】踩过的坑：
      //   原来写的是 `node.previousSibling === cursor` 就算"已经在位"。
      //   但**新建的节点还没进容器**时，它的 previousSibling 和此时的 cursor
      //   都可能是 null —— 两个 null 相等 → 判定成"已经在位" → 节点根本没插进去，
      //   表现是整个列表永远是空的（单测抓出来的，不是靠眼睛看出来的）。
      //   所以"已经在位"的前提是：它确实已经是容器的子节点。
      const inPosition = node.parentNode === container
        && (cursor === node || (node.nextSibling === cursor && node.previousSibling !== node));
      if (inPosition) {
        // 已经在正确位置，什么都不用做
      } else if (cursor) {
        container.insertBefore(node, cursor);
      } else {
        container.appendChild(node);
      }
      if (cursor === node) cursor = cursor.nextSibling;
      void tagName;
    });

    // ④ 这一轮没用上的**旧**节点（这一轮消失的项、以及多余的文本节点）删掉。
    //    必须用 container.removeChild（而不是直接改 childNodes），
    //    这样节点的 parentNode 会被正确置空。
    existing.forEach((node) => { if (node.parentNode === container) { container.removeChild(node); stats.removed++; } });
    leftovers.forEach((node) => { if (node.parentNode === container) { container.removeChild(node); stats.removed++; } });

    return stats;
  }

  /** 标签名核对：新建/复用时保证类型对得上，对不上就当新节点 */
  function isTag(node, tagName) {
    if (!node || !tagName) return !!node;
    return node.tagName && node.tagName.toLowerCase() === String(tagName).toLowerCase();
  }

  const api = { reconcile, setText, setClass, setAttr, setStyle, isTag };

  if (global.App) global.App.dom = api;      // 浏览器里挂在 App 下
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // Node 里可直接 require（自检用）
})(typeof window !== 'undefined' ? window : globalThis);
