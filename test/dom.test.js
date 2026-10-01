'use strict';
/* ============================================================================
 * test-dom.js —— dom.js（DOM 打补丁）的纯逻辑测试
 *
 * 为什么单独一个文件：test/run.js 的 API 断言用的是"每个套件起一个服务"的重量级
 * 结构，而这里测的是**纯函数**，不需要服务、不需要浏览器。
 * 用 node:test 自带的能力（test runner 是 Node 内置的，不引入任何依赖）。
 *
 * 运行：node --no-warnings --test test/dom.test.js     （或 node --test test/）
 * 也被 test/run.js 的 dom 套件调用（见那边）。
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');

/* ── 极简 DOM 桩：只实现 dom.js 用到的那几个 API ────────────────────────
 * 为什么要桩而不是拉 jsdom：本项目零依赖，不能为了测试引入一个几 MB 的库。
 * 这里只需要 nodeType / childNodes / firstChild / appendChild / insertBefore /
 * removeChild / parentNode / previousSibling / nextSibling / textContent / className
 * / style / getAttribute / setAttribute / hasAttribute / removeAttribute。
 */
function makeNode(tag) {
  const n = {
    nodeType: 1,
    tagName: String(tag || 'div').toUpperCase(),
    childNodes: [],
    parentNode: null,
    textContent: '',
    className: '',
    __attrs: {},
    style: (function () {
      // 真 DOM 的 style 是"属性名 → 值"的对象：getPropertyValue('width') 返回 '50%'。
      // 我第一版把 setProperty 写成了把整串 'width: 50%' 存成键，测试立刻报错 ——
      // 桩写错会让人以为是被测代码坏了，所以这里按真 API 写。
      const v = {};
      return {
        getPropertyValue(k) { return v[k] || ''; },
        setProperty(k, val) {
          if (val === undefined) { const i = String(k).indexOf(':'); v[String(k).slice(0, i).trim()] = String(k).slice(i + 1).trim(); return; }
          v[k] = String(val);
        },
        removeProperty(k) { delete v[k]; },
      };
    })(),
    get firstChild() { return this.childNodes[0] || null; },
    get previousSibling() {
      if (!this.parentNode) return null;
      const i = this.parentNode.childNodes.indexOf(this);
      return i > 0 ? this.parentNode.childNodes[i - 1] : null;
    },
    get nextSibling() {
      if (!this.parentNode) return null;
      const i = this.parentNode.childNodes.indexOf(this);
      return i >= 0 && i < this.parentNode.childNodes.length - 1
        ? this.parentNode.childNodes[i + 1] : null;
    },
    appendChild(c) {
      if (c.parentNode) c.parentNode.removeChild(c);
      this.childNodes.push(c);
      c.parentNode = this;
      return c;
    },
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.removeChild(c);
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
      c.parentNode = this;
      return c;
    },
    removeChild(c) {
      const i = this.childNodes.indexOf(c);
      if (i >= 0) this.childNodes.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.__attrs, k) ? this.__attrs[k] : null; },
    setAttribute(k, v) { this.__attrs[k] = String(v); },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.__attrs, k); },
    removeAttribute(k) { delete this.__attrs[k]; },
    /** 测试辅助：把直接子节点的 (key) 列出来，方便断言顺序 */
    keys() { return this.childNodes.map(c => c.__key); },
    texts() { return this.childNodes.map(c => c.textContent); },
  };
  return n;
}

const Dom = require('../public/dom.js');

test('setText：文字相同就不写 DOM（避免无谓重排）', () => {
  const n = makeNode('div');
  n.textContent = '甲';
  let writes = 0;
  Object.defineProperty(n, 'textContent', {
    get() { return this.__t || ''; },
    set(v) { writes++; this.__t = v; },
  });
  n.textContent = '甲';                 // 初始化
  const before = writes;
  Dom.setText(n, '甲');
  assert.strictEqual(writes, before, '同样是"甲"不该再写一次');
  Dom.setText(n, '乙');
  assert.strictEqual(writes, before + 1, '变了才写');
  // null/undefined 当空串
  Dom.setText(n, null);
  assert.strictEqual(n.textContent, '');
});

test('setClass / setAttr / setStyle：都只在"真的变了"时才写', () => {
  const n = makeNode('div');
  Dom.setClass(n, 'a b');
  assert.strictEqual(n.className, 'a b');
  Dom.setClass(n, 'a b');
  assert.strictEqual(n.className, 'a b');

  Dom.setAttr(n, 'title', '提示');
  assert.strictEqual(n.getAttribute('title'), '提示');
  Dom.setAttr(n, 'title', null);
  assert.strictEqual(n.hasAttribute('title'), false, 'null 应当移除属性');
  Dom.setAttr(n, 'hidden', true);
  assert.strictEqual(n.getAttribute('hidden'), '', 'true 写成空属性');

  Dom.setStyle(n, 'width', '50%');
  assert.strictEqual(n.style.getPropertyValue('width'), '50%');
  Dom.setStyle(n, 'width', '');
  assert.strictEqual(n.style.getPropertyValue('width'), '', '空值应当移除');
});

test('reconcile：节点数目对了，且同 key 的节点被复用（不是重建）', () => {
  const box = makeNode('div');
  const items1 = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  Dom.reconcile(box, items1, it => it.id, (it, node) => {
    if (!node) node = makeNode('li');
    Dom.setText(node, it.id.toUpperCase());
    return node;
  });
  assert.deepStrictEqual(box.keys(), ['a', 'b', 'c']);
  assert.deepStrictEqual(box.texts(), ['A', 'B', 'C']);

  const firstA = box.childNodes[0];
  // 第二轮：b 消失、d 新增，a/c 顺序不变
  const items2 = [{ id: 'a' }, { id: 'c' }, { id: 'd' }];
  const stats = Dom.reconcile(box, items2, it => it.id, (it, node) => {
    if (!node) node = makeNode('li');
    Dom.setText(node, it.id.toUpperCase());
    return node;
  });
  assert.deepStrictEqual(box.keys(), ['a', 'c', 'd']);
  assert.strictEqual(box.childNodes[0], firstA, 'a 的节点必须是**同一个**（复用了）');
  assert.strictEqual(stats.created, 1, '只新建 1 个（d）');
  assert.strictEqual(stats.removed, 1, '只删 1 个（b）');
  assert.strictEqual(stats.updated, 2, 'a/c 是更新');
});

test('reconcile：顺序颠倒时只移动节点，不重建', () => {
  const box = makeNode('div');
  const mk = (items) => Dom.reconcile(box, items, it => it.id, (it, node) => {
    if (!node) node = makeNode('li');
    node.textContent = it.id;
    return node;
  });
  mk([{ id: '1' }, { id: '2' }, { id: '3' }]);
  const nodes = box.childNodes.slice();
  mk([{ id: '3' }, { id: '2' }, { id: '1' }]);
  assert.deepStrictEqual(box.keys(), ['3', '2', '1']);
  assert.strictEqual(box.childNodes[0], nodes[2], '原来的 3 号节点被移到最前');
  assert.strictEqual(box.childNodes[2], nodes[0], '原来的 1 号节点被移到最后');
});

test('reconcile：容器里的"野"节点（没有 key）会被清掉', () => {
  const box = makeNode('div');
  box.appendChild(makeNode('div'));            // 没打过 __key 的遗留节点
  Dom.reconcile(box, [{ id: 'x' }], it => it.id, (it, node) => {
    if (!node) node = makeNode('li');
    node.textContent = it.id;
    return node;
  });
  assert.deepStrictEqual(box.keys(), ['x']);
  assert.strictEqual(box.childNodes.length, 1);
});

test('reconcile：空列表把容器清空', () => {
  const box = makeNode('div');
  Dom.reconcile(box, [{ id: 'a' }, { id: 'b' }], it => it.id, (it, node) => node || makeNode('li'));
  assert.strictEqual(box.childNodes.length, 2);
  const st = Dom.reconcile(box, [], it => it.id, (it, node) => node || makeNode('li'));
  assert.strictEqual(box.childNodes.length, 0);
  assert.strictEqual(st.removed, 2);
});

test('reconcile：key 为 null 的项每次都新建（不复用，避免串数据）', () => {
  const box = makeNode('div');
  const items = [{ id: null }, { id: null }];
  Dom.reconcile(box, items, it => it.id, (it, node) => {
    if (!node) node = makeNode('li');
    return node;
  });
  assert.strictEqual(box.childNodes.length, 2);
  const keep = box.childNodes[0];
  Dom.reconcile(box, items, it => it.id, (it, node) => node || makeNode('li'));
  assert.notStrictEqual(box.childNodes[0], keep, '无 key 的项应当被换掉，不能复用');
});

test('reconcile 的返回值统计正确（新建/更新/删除）', () => {
  const box = makeNode('div');
  const build = (it, node) => { if (!node) node = makeNode('li'); node.textContent = it.id; return node; };
  const s1 = Dom.reconcile(box, [{ id: 'a' }], it => it.id, build);
  assert.deepStrictEqual(s1, { created: 1, updated: 0, removed: 0 });
  const s2 = Dom.reconcile(box, [{ id: 'a' }, { id: 'b' }], it => it.id, build);
  assert.deepStrictEqual(s2, { created: 1, updated: 1, removed: 0 });
  const s3 = Dom.reconcile(box, [{ id: 'b' }], it => it.id, build);
  assert.deepStrictEqual(s3, { created: 0, updated: 1, removed: 1 });
});

test('isTag：类型对不上时应当判为 false（避免复用错节点）', () => {
  assert.strictEqual(Dom.isTag(makeNode('tr'), 'tr'), true);
  assert.strictEqual(Dom.isTag(makeNode('div'), 'tr'), false);
  assert.strictEqual(Dom.isTag(null, 'tr'), false);
});
