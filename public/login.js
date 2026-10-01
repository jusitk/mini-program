/* ============================================================================
 * login.js —— 登录页逻辑
 * ========================================================================== */
'use strict';

(function () {
  const App = window.App;
  const el = App.el;

  function show(text, ok) {
    const box = el('loginMsg');
    box.textContent = text || '';
    box.classList.toggle('is-ok', !!ok);
  }

  function boot() {
    App.pxScale('standard');           // 登录页不用户外模式，标准档更合适
    App.installErrorReporting('login');

    /* 【先处理"被顶下线"的提示】
       一个账号只能在一台设备登录，所以从别处登录会把这里顶掉。
       顶掉时 admin-core 会把原因写进 localStorage 再跳过来 ——
       必须先看这个，再看"有没有会话"：因为这时候会话恰好是"没有"，
       不先处理的话用户只会看到干巴巴一个登录框，不知道发生了什么。 */
    let kicked = '';
    try {
      kicked = localStorage.getItem('sports.kicked') || '';
      if (kicked) localStorage.removeItem('sports.kicked');
    } catch (e) { /* 隐私模式 */ }
    const qs = new URLSearchParams(location.search);
    if (!kicked && qs.get('kicked')) {
      kicked = '这个账号在另一台设备上登录了，你已被下线。';
    }
    if (kicked) {
      /* 原因那句话本身已经把话说全了（谁顶的、从哪个 IP、该怎么办），
         所以这里只补一句"请重新登录"就行 —— 别再重复一遍"多人一起录…"。 */
      show(kicked + '　请重新登录。', false);
    }

    /* 已有会话就直接进后台（省一步点击）。
       注意：被顶下线时 /api/me 会返回 user:null + invalidReason，
       那时候**不能**跳后台，要把原因显示出来。 */
    App.api('/api/me').then((r) => {
      const d = (r && r.data) || {};
      if (d.user) { location.replace('/admin'); return; }
      if (d.invalidReason && !kicked) {
        show(d.invalidReason + '　请重新登录。', false);
      }
    });

    // 顶部显示本届名称
    App.api('/api/info').then((r) => {
      if (r.ok && r.data && r.data.meet && r.data.meet.name) {
        el('meetName').textContent = r.data.meet.name;
      }
    });

    const form = el('loginForm');
    const nameInput = el('username');
    const pwdInput = el('password');
    const btn = el('btnLogin');

    // 记住上次的账号（口令绝不记住）
    const last = App.store.get('lastUser', '');
    if (last) { nameInput.value = last; pwdInput.focus(); } else { nameInput.focus(); }

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const username = nameInput.value.trim();
      const password = pwdInput.value;
      if (!username || !password) { show('账号和口令都要填'); return; }

      btn.disabled = true;
      btn.textContent = '登录中…';
      show('');

      App.api('/api/login', { method: 'POST', body: { username, password } }).then((r) => {
        btn.disabled = false;
        btn.textContent = '登 录';
        if (r.ok && r.data && r.data.ok) {
          App.setCsrf(r.data.csrf);
          App.store.set('lastUser', username);
          show('登录成功，正在进入…', true);
          location.replace('/admin');
        } else if (r.offline) {
          show('连不上服务器：这台设备是否连上了学校局域网？服务器上的服务是否在运行？');
        } else {
          show((r.data && r.data.message) || r.error || '登录失败');
          pwdInput.select();
        }
      });
    });

    App.checkLayout('login');
  }

  App.bootstrap(boot);
})();
