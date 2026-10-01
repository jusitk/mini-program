'use strict';
/**
 * status.js —— 赛事状态的定义（**唯一一处**）
 *
 * 状态机：
 *   pending  未开始
 *   checking 检录中   ← 裁判点「开始检录」进入（手动，不按时间自动改）
 *   live     进行中   ← 人齐自动进入；或按开始时间自动；或手动
 *   done     已结束
 *
 * 为什么单独一个文件：
 *   这个表 ops.js（改状态）、scoreboard.js（把文案发给前端）、xport.js（导出）都要用，
 *   而它们之间不能互相 require（会成环）。放这里谁都能引，也不会重复写两套文案。
 */

const STATUS_ORDER = ['pending', 'checking', 'live', 'done'];

const STATUS_LABEL = {
  pending: '未开始',
  checking: '检录中',
  live: '进行中',
  done: '已结束',
};

/** 状态对应的界面语气（前端用它选颜色） */
const STATUS_TONE = {
  pending: 'dim',
  checking: 'warn',
  live: 'ok',
  done: 'done',
};

/** 是不是"还没开始比赛"（未开始 / 检录中） */
const isBeforeStart = (status) => status === 'pending' || status === 'checking';

module.exports = { STATUS_ORDER, STATUS_LABEL, STATUS_TONE, isBeforeStart };
