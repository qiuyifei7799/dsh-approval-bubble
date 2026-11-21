// 宿主半侧自测：用假 ctx / webServer 驱动审批桥，不启动 DSH。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply, parseEscalation, describeCall, bubbleParts } from '../lib/index.js';

/** 造一个最小 ctx，记录监听器与路由。 */
function makePlugin(config) {
  const listeners = new Map();
  const routes = [];
  const logs = [];
  const ctx = {
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    on(name, fn, opts) {
      listeners.set(name, { fn, opts });
    },
    effect(fn) {
      fn();
    },
    webServer: {
      register(route) {
        routes.push(route);
      },
    },
  };
  apply(ctx, config);
  return { listeners, routes, logs };
}

/** 调一次路由，返回解析后的响应体。 */
function callRoute(route, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.url = path;
    req.method = method;
    req.destroy = () => {};
    const res = {
      status: 0,
      writeHead(status) {
        this.status = status;
      },
      end(chunk) {
        try {
          resolve({ status: this.status, body: chunk ? JSON.parse(chunk) : null });
        } catch (error) {
          reject(error);
        }
      },
    };
    Promise.resolve(route.handler(req, res)).catch(reject);
    if (body !== undefined) {
      setImmediate(() => {
        req.emit('data', Buffer.from(body));
        req.emit('end');
      });
    }
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function routeOf({ routes }) {
  const route = routes.find((r) => r.path === '/dsh-approval-bubble');
  assert.ok(route, 'route registered');
  return route;
}

async function main() {
  // 插件里的兜底超时是 unref 的（生产里靠宿主服务器保活）；测试进程自己要有个 ref 句柄，
  // 否则 test 3 里那个 50ms 超时还没来得及触发，进程就退出了。
  const keepAlive = setInterval(() => {}, 100);

  // 1. 具体命令 + 允许
  {
    const plugin = makePlugin();
    assert.equal(plugin.listeners.get('approval/request').opts.prepend, true, 'prepend');
    plugin.listeners.get('session/event').fn({ header: { id: 's1' } }, {
      type: 'tool/call',
      data: { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'Get-Item C:\\Windows\\win.ini' }) },
    });

    const pending = plugin.listeners.get('approval/request').fn(
      { toolName: 'pwsh', callId: 'c1', reason: 'escalate sandbox to danger-full-access: 读文件' },
      () => 'native',
    );
    await tick();

    const route = routeOf(plugin);
    const got = await callRoute(route, 'GET', '/dsh-approval-bubble/pending');
    assert.equal(got.status, 200);
    assert.equal(got.body.pending.text, '要执行：Get-Item C:\\Windows\\win.ini');
    assert.equal(got.body.pending.action, 'pwsh · 完全访问权限');
    assert.ok(got.body.pending.deadline > Date.now(), 'deadline in future');

    const answered = await callRoute(
      route,
      'POST',
      '/dsh-approval-bubble/answer',
      JSON.stringify({ id: got.body.pending.id, decision: 'allow' }),
    );
    assert.equal(answered.body.ok, true);
    assert.equal(await pending, 'allowed-once');

    const after = await callRoute(route, 'GET', '/dsh-approval-bubble/pending');
    assert.equal(after.body.pending, null);
  }

  // 2. 拒绝 + 未知 id
  {
    const plugin = makePlugin();
    const pending = plugin.listeners.get('approval/request').fn({ toolName: 'bash' }, () => 'native');
    await tick();
    const route = routeOf(plugin);
    const got = await callRoute(route, 'GET', '/dsh-approval-bubble/pending');
    assert.equal(got.body.pending.text, '有一项操作需要你点头');
    assert.equal(got.body.pending.action, 'bash · 需要授权');
    const unknown = await callRoute(route, 'POST', '/dsh-approval-bubble/answer', JSON.stringify({ id: 'nope' }));
    assert.equal(unknown.body.ok, false);
    assert.equal(unknown.body.reason, 'unknown-approval');
    await callRoute(route, 'POST', '/dsh-approval-bubble/answer', JSON.stringify({ id: got.body.pending.id, decision: 'deny' }));
    assert.equal(await pending, 'rejected');
  }

  // 3. 超时 → 退回原生面板（插件把 timeoutMs 下限钳在 1000ms）
  {
    const plugin = makePlugin({ timeoutMs: 1000 });
    let native = 0;
    const pending = plugin.listeners.get('approval/request').fn({ toolName: 'pwsh' }, () => {
      native += 1;
      return 'native';
    });
    assert.equal(await pending, 'native');
    assert.equal(native, 1);
    const route = routeOf(plugin);
    const got = await callRoute(route, 'GET', '/dsh-approval-bubble/pending');
    assert.equal(got.body.pending, null);
  }

  // 4. 中止 → cancelled
  {
    const plugin = makePlugin();
    const controller = new AbortController();
    const pending = plugin.listeners.get('approval/request').fn({ toolName: 'pwsh', signal: controller.signal }, () => 'native');
    await tick();
    controller.abort();
    assert.equal(await pending, 'cancelled');
  }

  // 5. 文案工具函数
  {
    assert.deepEqual(parseEscalation('escalate sandbox to danger-full-access: 读文件'), {
      mode: 'danger-full-access',
      justification: '读文件',
    });
    assert.equal(parseEscalation('other reason'), null);
    assert.equal(describeCall('pwsh', JSON.stringify({ command: '  ls   -la ' })), 'ls -la');
    assert.equal(describeCall('file_tool', JSON.stringify({ path: 'C:\\tmp\\a.txt' })), 'C:\\tmp\\a.txt');
    assert.equal(describeCall('pwsh', JSON.stringify({ command: 'x'.repeat(200) })).length, 73);
    assert.deepEqual(bubbleParts({ toolName: 'pwsh', reason: 'escalate sandbox to read-only: x' }, null), {
      text: '要提升到只读权限',
      action: 'pwsh · 只读权限',
    });
  }

  clearInterval(keepAlive);
  console.log('dsh-approval-bubble host tests: OK');
  // 测试进程显式收尾：插件里的兜底定时器是 unref 的，但测试环境里可能仍有宿主式句柄
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
