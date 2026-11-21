/**
 * dsh-approval-bubble —— 浏览器浮层半侧。
 *
 * 轮询宿主 `/dsh-approval-bubble/pending`，有待答审批就在右下角弹一张卡片：
 * 「要执行：<具体命令>」+「pwsh · 完全访问权限」+ 拒绝/允许一次。
 * 点击 → POST /dsh-approval-bubble/answer。
 *
 * 用 Shadow DOM 隔离样式，避免和 DSH 自身 CSS 打架；不依赖 React 或任何客户端服务。
 */
window.__ModuleLoader__.load({
  id: 'dsh-approval-bubble',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var POLL_MS = 800;
    var STYLE = [
      ':host{all:initial}',
      '.root{position:fixed;right:24px;bottom:24px;z-index:2147483000;font-family:"Microsoft YaHei","PingFang SC","Segoe UI",system-ui,sans-serif;pointer-events:none}',
      '.root[data-on="1"]{pointer-events:auto}',
      '.card{display:none;width:340px;max-width:calc(100vw - 48px);box-sizing:border-box;padding:16px 18px 14px;border-radius:16px;background:#fff;color:#1f2328;box-shadow:0 18px 48px rgba(0,0,0,.22),0 2px 8px rgba(0,0,0,.08);border:1px solid rgba(0,0,0,.06)}',
      '.root[data-on="1"] .card{display:block;animation:dab-in .18s ease-out}',
      '@keyframes dab-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
      '.head{display:flex;align-items:center;gap:8px;font-size:13px;color:#b26a00;margin-bottom:8px}',
      '.dot{width:8px;height:8px;border-radius:50%;background:#f5a623;box-shadow:0 0 0 3px rgba(245,166,35,.18)}',
      '.text{font-size:14px;line-height:1.5;word-break:break-all}',
      '.action{margin-top:6px;font-size:12px;color:#6b7280}',
      '.row{display:flex;gap:10px;margin-top:14px}',
      'button{flex:1;height:34px;border-radius:9px;font-size:13px;font-family:inherit;cursor:pointer;border:1px solid rgba(0,0,0,.14);background:#fff;color:#1f2328;transition:background .15s}',
      'button:disabled{opacity:.6;cursor:default}',
      '.allow{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600}',
      '.allow:hover:not(:disabled){background:#1d4ed8}',
      '.deny:hover:not(:disabled){background:#fef2f2;border-color:#fca5a5;color:#b91c1c}',
      '.hint{margin-top:10px;font-size:11px;color:#9ca3af}',
      '.err{color:#b91c1c}',
      '.card[data-busy="1"] .row{pointer-events:none}',
      '@media (prefers-color-scheme:dark){.card{background:#1f2328;color:#e5e7eb;border-color:rgba(255,255,255,.08)}.action{color:#9ca3af}button{background:#111827;border-color:rgba(255,255,255,.18);color:#e5e7eb}.deny:hover:not(:disabled){background:#3f1d1d;border-color:#b91c1c;color:#fca5a5}.hint{color:#6b7280}}',
    ].join('\n');

    /**
     * @param {string} path 相对路径
     * @returns {string} 绝对地址
     */
    function apiUrl(path) {
      return new URL(path, document.baseURI).toString();
    }

    /**
     * 启动浮层。
     * @param {any} ctx 客户端上下文（只用可选的 effect 做清理）
     * @returns {() => void} 停止函数
     */
    function mount(ctx) {
      if (document.querySelector('dsh-approval-bubble-root')) return function () {};

      var host = document.createElement('dsh-approval-bubble-root');
      document.body.appendChild(host);
      var shadow = host.attachShadow({ mode: 'open' });
      var style = document.createElement('style');
      style.textContent = STYLE;
      var root = document.createElement('div');
      root.className = 'root';
      root.innerHTML =
        '<div class="card" role="dialog" aria-live="polite">' +
        '<div class="head"><span class="dot"></span><span>需要你授权</span></div>' +
        '<div class="text"></div>' +
        '<div class="action"></div>' +
        '<div class="row"><button class="deny" type="button">拒绝</button><button class="allow" type="button">允许一次</button></div>' +
        '<div class="hint"></div>' +
        '</div>';
      shadow.appendChild(style);
      shadow.appendChild(root);

      var card = root.querySelector('.card');
      var textEl = root.querySelector('.text');
      var actionEl = root.querySelector('.action');
      var hintEl = root.querySelector('.hint');
      var denyBtn = root.querySelector('.deny');
      var allowBtn = root.querySelector('.allow');

      var shownId = null;
      var busy = false;
      var failed = false;
      var deadline = null;
      var stopped = false;
      var pollTimer = null;
      var tickTimer = null;

      function setHint() {
        if (failed) {
          hintEl.textContent = '没送达 DSH，再点一次';
          hintEl.className = 'hint err';
          return;
        }
        hintEl.className = 'hint';
        if (!deadline) {
          hintEl.textContent = '点一下就行';
          return;
        }
        var left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        hintEl.textContent = left > 0 ? '还剩 ' + left + ' 秒，无人处理会转回 DSH 面板' : '正在转回 DSH 面板…';
      }

      function render(item) {
        if (!item) {
          if (shownId !== null) {
            shownId = null;
            root.dataset.on = '0';
            deadline = null;
            if (tickTimer) {
              clearInterval(tickTimer);
              tickTimer = null;
            }
          }
          return;
        }
        if (item.id !== shownId) {
          shownId = item.id;
          busy = false;
          failed = false;
          deadline = typeof item.deadline === 'number' ? item.deadline : null;
          textEl.textContent = item.text || '有一项操作需要你点头';
          actionEl.textContent = item.action || '';
          allowBtn.disabled = false;
          denyBtn.disabled = false;
          card.dataset.busy = '0';
          setHint();
          if (tickTimer) clearInterval(tickTimer);
          tickTimer = setInterval(setHint, 500);
        }
        root.dataset.on = '1';
      }

      function answer(decision) {
        if (busy || !shownId) return;
        busy = true;
        failed = false;
        card.dataset.busy = '1';
        allowBtn.disabled = true;
        denyBtn.disabled = true;
        var id = shownId;
        fetch(apiUrl('dsh-approval-bubble/answer'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: id, decision: decision }),
        })
          .then(function (res) {
            return res.json().catch(function () {
              return null;
            });
          })
          .then(function (data) {
            if (data && data.ok) return; // 等下一拍 pending 变空，卡片自己收
            busy = false;
            failed = true;
            card.dataset.busy = '0';
            allowBtn.disabled = false;
            denyBtn.disabled = false;
            setHint();
          })
          .catch(function () {
            busy = false;
            failed = true;
            card.dataset.busy = '0';
            allowBtn.disabled = false;
            denyBtn.disabled = false;
            setHint();
          });
      }

      allowBtn.addEventListener('click', function () {
        answer('allow');
      });
      denyBtn.addEventListener('click', function () {
        answer('deny');
      });

      async function poll() {
        if (stopped) return;
        try {
          var res = await fetch(apiUrl('dsh-approval-bubble/pending'), { cache: 'no-store' });
          var data = await res.json();
          if (!stopped) render(data && data.pending);
        } catch (error) {
          /* 宿主暂时不可达：保持现状，下一拍再试 */
        }
        if (!stopped) pollTimer = setTimeout(poll, POLL_MS);
      }

      poll();

      return function stop() {
        stopped = true;
        if (pollTimer) clearTimeout(pollTimer);
        if (tickTimer) clearInterval(tickTimer);
        host.remove();
      };
    }

    /**
     * 客户端插件入口。
     * @param {any} ctx
     */
    function apply(ctx) {
      var stop = mount(ctx);
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return stop;
        }, 'dsh-approval-bubble: floating bubble');
      }
    }

    exports.apply = apply;
    exports.inject = [];
    exports.name = 'dsh-approval-bubble';
    return module.exports;
  },
});
