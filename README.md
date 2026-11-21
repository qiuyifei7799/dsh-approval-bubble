# dsh-approval-bubble

**给 DeepSeek Harness 的审批气泡：Agent 想越权时，右下角弹一张卡片，写清楚它要跑什么命令，你点「允许一次」或「拒绝」就完事。**

不依赖任何桌宠插件，纯网页浮层；不接管时自动退回 DSH 原生审批面板。

## 它长什么样

```
┌──────────────────────────────────────┐
│ ● 需要你授权                          │
│ 要执行：Get-Content "C:\Windows\win.ini" -TotalCount 3 │
│ pwsh · 完全访问权限                   │
│ [ 拒绝 ]            [ 允许一次 ]      │
│ 还剩 96 秒，无人处理会转回 DSH 面板    │
└──────────────────────────────────────┘
```

- 第一行是**这次要执行的具体命令 / 路径 / URL**（从工具的 `tool/call` 事件按 callId 取）；
- 第二行是**哪只工具、要多高权限**（`danger-full-access` → 完全访问权限，`workspace-write` → 工作区写入权限，`read-only` → 只读权限）；
- 点「允许一次」/「拒绝」立即生效；
- 默认 **120 秒**没人处理就转回 DSH 原生面板，避免页面关掉时任务卡死；
- 停掉这一轮（Stop / Esc）时请求中止，卡片自动收起。

## 安装

### 从市场安装

在 DSH 的 **插件 → 发现** 里搜 `dsh-approval-bubble`（需要已收录到 awesome-dsh-plugin），或：

```bash
dsh plugin install dsh-approval-bubble
```

### 本地开发安装

```bash
cd ~/.dsh/profiles/desktop
pnpm add "link:<本目录绝对路径>"
```

然后在 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: dsh-approval-bubble
      name: 'dsh-approval-bubble'
```

重启 DSH。宿主日志里会出现：

```
[dsh-approval-bubble] ready: 审批请求会先问浏览器浮层气泡
[dsh-approval-bubble] asked approval-bubble-... tool=pwsh detail="要执行：..."
[dsh-approval-bubble] settled ...: allowed-once
```

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `timeoutMs` | `120000` | 无人处理多久后退回 DSH 原生面板；`1000`–6 小时之间生效 |

```yaml
- name: 'dsh-approval-bubble'
  config:
    timeoutMs: 300000   # 5 分钟
```

## 和别的审批 UI 共存吗

DSH 的审批是 `approval/request` 瀑布：**第一个不调用 `next()` 的应答者赢**。本插件用 `prepend` 排在 DSH 内置审批 UI 之前，所以：

- 装了本插件 → 由它问；超时或异常时才轮到内置面板；
- 不要再同时装「把审批画在桌宠气泡里」的补丁/插件（例如 dsh-pet 的审批补丁），两者都抢第一位，谁最后注册谁生效，行为不确定。

## 安全说明

- 审批请求只在本机浏览器与宿主之间传递；接口不鉴权，和 DSH 其他插件路由一致——本机进程可以调用，介意的话别在多人共用账号的机器上开。
- 插件不会替你自动批准任何东西：只有你点「允许一次」才会返回 `allowed-once`，且只对当次调用有效。

## 实现备注

- 宿主：`lib/index.js`，监听 `approval/request`（prepend）与 `session/event`（tool/call），路由 `GET /dsh-approval-bubble/pending`、`POST /dsh-approval-bubble/answer`。
- 浏览器：`lib/client.js`，Shadow DOM 浮层 + 800ms 轮询，不依赖 React。
- 自测：`node test/host.test.mjs`（假 ctx 驱动，覆盖允许/拒绝/超时/中止/文案）。

## License

MIT
