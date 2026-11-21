/**
 * dsh-approval-bubble —— 宿主半侧。
 *
 * 拦截 DSH 的 `approval/request` 瀑布，把「这次要放行什么」交给浏览器浮层气泡去问；
 * 用户点「允许一次 / 拒绝」后由 `POST /dsh-approval-bubble/answer` 结算。
 *
 * 设计约束：
 * - 没有客户端（页面没开、或轮询不上）时不能把任务焊死：超时后调用 next() 退回 DSH 原生面板。
 * - 审批请求本身不带工具参数，所以额外监听 `session/event` 的 tool/call，按 callId 补具体命令。
 * - 一次只问一个：串行队列；结算幂等。
 *
 * @module dsh-approval-bubble
 */

export const name = 'dsh-approval-bubble';
export const inject = ['webServer'];

/** 路由前缀（客户端按同一常量拼 URL）。 */
const ROUTE_PREFIX = '/dsh-approval-bubble';
/** 默认兜底超时：浮层没人点就退回原生面板，避免任务永久卡住。 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 工具调用缓存上限。 */
const MAX_CALL_CACHE = 200;
/** 气泡正文里「具体操作」的最大长度。 */
const DETAIL_MAX = 72;

/** 沙箱模式 → 中文权限名。 */
const PERMISSION_TEXT = {
  'danger-full-access': '完全访问权限',
  'workspace-write': '工作区写入权限',
  'read-only': '只读权限',
};

/**
 * @param {string | undefined} mode 沙箱模式
 * @returns {string} 给人看的权限名
 */
function permissionName(mode) {
  if (!mode) return '更高权限';
  return PERMISSION_TEXT[mode] ?? `${mode} 权限`;
}

/**
 * 从 approval 的 reason 里认出沙箱升级：`escalate sandbox to <mode>: <justification>`。
 * @param {unknown} reason
 * @returns {{ mode: string, justification: string } | null}
 */
export function parseEscalation(reason) {
  const raw = typeof reason === 'string' ? reason.trim() : '';
  const match = /^escalate sandbox to ([a-z-]+)\s*:?\s*([\s\S]*)$/i.exec(raw);
  if (!match) return null;
  return { mode: match[1], justification: (match[2] ?? '').trim() };
}

/**
 * 从工具调用的 arguments 里取「最像在干什么」的一段文本。
 * @param {string} toolName
 * @param {unknown} rawArguments JSON 字符串或对象
 * @returns {string}
 */
export function describeCall(toolName, rawArguments) {
  let args = rawArguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = null;
    }
  }
  if (!args || typeof args !== 'object') return '';
  const pick = (keys) => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
    return '';
  };
  const commandTools = ['pwsh', 'bash', 'terminal', 'shell', 'shell_command', 'terminal_run'];
  const raw = commandTools.includes(String(toolName))
    ? pick(['command', 'cmd', 'script', 'input'])
    : pick(['path', 'file_path', 'filePath', 'url', 'query', 'pattern', 'directory', 'command']);
  const flat = String(raw).replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX)}…` : flat;
}

/**
 * 拼气泡的两段文案。
 * @param {{ toolName?: string, reason?: string }} request
 * @param {{ name?: string, arguments?: unknown } | null} call
 * @returns {{ text: string, action: string }}
 */
export function bubbleParts(request, call) {
  const tool = typeof request?.toolName === 'string' && request.toolName ? request.toolName : '工具';
  const escalation = parseEscalation(request?.reason);
  const detail = describeCall(call?.name ?? tool, call?.arguments);
  if (escalation) {
    return {
      text: detail ? `要执行：${detail}` : `要提升到${permissionName(escalation.mode)}`,
      action: `${tool} · ${permissionName(escalation.mode)}`,
    };
  }
  const reason = typeof request?.reason === 'string' ? request.reason.replace(/\s+/g, ' ').trim() : '';
  return {
    text: detail ? `要执行：${detail}` : reason ? `要越权：${reason}` : '有一项操作需要你点头',
    action: `${tool} · 需要授权`,
  };
}

/**
 * 读请求体（带体积上限）。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8192) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 写 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 插件主体。
 * @param {any} ctx Cordis 上下文
 * @param {{ timeoutMs?: number }} [config] 插件配置
 */
export function apply(ctx, config) {
  const timeoutMs =
    typeof config?.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs >= 1000
      ? Math.min(config.timeoutMs, 6 * 3600 * 1000)
      : DEFAULT_TIMEOUT_MS;

  /** @type {Map<string, any>} */
  const pending = new Map();
  /** @type {Map<string, { name: string, arguments: unknown, ts: number }>} */
  const calls = new Map();
  /** @type {Map<string, { name: string, arguments: unknown, ts: number }>} */
  const lastCallBySession = new Map();
  let seq = 0;
  let chain = Promise.resolve();
  let current = null;
  let disposed = false;

  /** 本轮调用的具体参数（按 callId，查不到退到同会话最近一次）。 */
  function findCall(request) {
    const callId = typeof request?.callId === 'string' ? request.callId : '';
    if (callId && calls.has(callId)) return calls.get(callId);
    const sessionId = String(request?.agent?.session?.id ?? request?.agent?.session?.header?.id ?? '');
    const last = sessionId ? lastCallBySession.get(sessionId) : null;
    if (last && Date.now() - last.ts < 120_000) return last;
    return null;
  }

  /** 当前要展示给客户端的那一条。 */
  function visible() {
    return current && !current.settled
      ? {
          id: current.id,
          text: current.text,
          action: current.action,
          toolName: current.toolName,
          createdAt: current.createdAt,
          deadline: current.deadline,
          timeoutMs,
        }
      : null;
  }

  /**
   * 问一次。
   * @param {any} request approval 请求
   * @returns {Promise<'allowed-once' | 'rejected' | 'cancelled' | null>} null = 交还原生面板
   */
  function ask(request) {
    const run = () =>
      new Promise((resolve) => {
        seq += 1;
        const id = `approval-bubble-${Date.now()}-${seq}`;
        const parts = bubbleParts(request, findCall(request));
        const item = {
          id,
          text: parts.text,
          action: parts.action,
          toolName: typeof request?.toolName === 'string' ? request.toolName : '',
          createdAt: Date.now(),
          deadline: timeoutMs > 0 ? Date.now() + timeoutMs : null,
          resolve,
          settled: false,
          timer: null,
          signal: request?.signal,
          onAbort: null,
        };
        const finish = (outcome) => {
          if (item.settled) return;
          item.settled = true;
          pending.delete(id);
          if (current === item) current = null;
          if (item.timer !== null) clearTimeout(item.timer);
          if (item.onAbort && typeof item.signal?.removeEventListener === 'function') {
            item.signal.removeEventListener('abort', item.onAbort);
          }
          ctx.logger?.info?.(`[dsh-approval-bubble] settled ${id}: ${outcome === null ? 'delegated' : outcome}`);
          resolve(outcome);
        };
        item.finish = finish;
        pending.set(id, item);
        current = item;
        if (item.signal && typeof item.signal.addEventListener === 'function') {
          item.onAbort = () => finish('cancelled');
          item.signal.addEventListener('abort', item.onAbort, { once: true });
          if (item.signal.aborted) {
            finish('cancelled');
            return;
          }
        }
        ctx.logger?.info?.(`[dsh-approval-bubble] asked ${id} tool=${item.toolName} detail=${JSON.stringify(item.text)}`);
        item.timer = setTimeout(() => finish(null), timeoutMs);
        // 兜底定时器不该把宿主进程钉在退出上（等待审批时宿主仍有服务器句柄保活）
        item.timer.unref?.();
      });
    const started = chain.then(run, run);
    chain = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  }

  /** 结算一条待答请求（幂等；未知 id 报错）。 */
  function answer(rawId, rawDecision) {
    const item = pending.get(String(rawId ?? ''));
    if (!item || item.settled) {
      return { ok: false, reason: 'unknown-approval', message: '这条审批已结束或已超时' };
    }
    const decision = rawDecision === 'deny' || rawDecision === 'rejected' ? 'rejected' : 'allowed-once';
    item.finish(decision);
    return { ok: true };
  }

  // 工具调用缓存：审批请求只给工具名与原因，具体参数得从 tool/call 事件里补。
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'tool/call') return;
    const data = event.data ?? {};
    const record = {
      name: typeof data.name === 'string' ? data.name : '',
      arguments: data.arguments,
      ts: Date.now(),
    };
    const callId = typeof data.callId === 'string' ? data.callId : '';
    if (callId) {
      calls.set(callId, record);
      if (calls.size > MAX_CALL_CACHE) {
        const oldest = calls.keys().next().value;
        if (oldest !== undefined) calls.delete(oldest);
      }
    }
    const sessionId = String(session?.header?.id ?? session?.id ?? '');
    if (sessionId) lastCallBySession.set(sessionId, record);
  });

  // 抢在 DSH 内置审批 UI 之前：prepend 让本监听排在瀑布最前面。
  ctx.on(
    'approval/request',
    (request, next) => {
      if (disposed) return next();
      try {
        return ask(request).then(
          (outcome) => (outcome === null ? next() : outcome),
          (error) => {
            ctx.logger?.warn?.(`[dsh-approval-bubble] failed: ${error instanceof Error ? error.message : String(error)}`);
            return next();
          },
        );
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-approval-bubble] threw: ${error instanceof Error ? error.message : String(error)}`);
        return next();
      }
    },
    { prepend: true },
  );

  ctx.effect(
    () => () => {
      disposed = true;
      for (const item of [...pending.values()]) item.finish(null);
    },
    'dsh-approval-bubble: dispose',
  );

  // 客户端轮询与作答：一个 GET 拿当前待答项，一个 POST 结算。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const rest = url.pathname.slice(ROUTE_PREFIX.length + 1);
          if (req.method === 'GET' && (rest === 'pending' || rest === '')) {
            sendJson(res, 200, { ok: true, pending: visible() });
            return;
          }
          if (req.method === 'POST' && rest === 'answer') {
            let body;
            try {
              body = JSON.parse((await readBody(req)) || 'null');
            } catch {
              sendJson(res, 400, { ok: false, reason: 'invalid-json', message: 'invalid JSON body' });
              return;
            }
            const parsed = body && typeof body === 'object' ? body : {};
            const result = answer(parsed.id, parsed.decision);
            sendJson(res, 200, result);
            return;
          }
          sendJson(res, 404, { ok: false, reason: 'not-found', message: 'dsh-approval-bubble: not found' });
        },
      }),
    'dsh-approval-bubble: routes',
  );

  ctx.logger?.info?.('[dsh-approval-bubble] ready: 审批请求会先问浏览器浮层气泡');
}
