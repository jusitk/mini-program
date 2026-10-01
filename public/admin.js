/* ============================================================================
 * admin.js —— 后台入口（各页签的逻辑在 admin-*.js 里，这里只负责启动）
 * ========================================================================== */
'use strict';

(function () {
  const A = window.Admin;
  if (!A) {
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="padding:24px;color:#e2564f">后台脚本加载失败（admin-core.js 没装上）。请刷新页面；'
      + '如果一直这样，检查 public 目录里的文件是否完整。</div>');
    return;
  }
  App.bootstrap(() => A.boot());
})();
