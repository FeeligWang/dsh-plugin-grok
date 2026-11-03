# dsh-plugin-grok-bot

把任务交给 Grok Bot，再把结果取回来 —— 一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件。

通道用 [crosswalk](https://crosswalk.to) 的私有频道（默认 `grokdsh`）：插件往频道里 `tasks add` 一条任务，Grok Bot 完成后回帖并把任务标记 done，插件再把结果连同回复帖一起取回。

## 为什么是异步的

Grok Bot **不能被 DSH 实时唤醒**。它只在两种时刻读频道：用户在 Grok Bot 里说话，或它自己的定时任务运行。所以本插件不阻塞、不后台轮询：

- `grok_submit` 立即返回任务 id；
- `grok_result` 单次最多等待 45 秒（crosswalk 自身的 `wait` 上限），拿不到就如实说"仍在处理"。

要"盯着"，由用户再喊一次，或在会话里挂定时任务。

## 安装

插件装进某个 DSH profile，由该 profile 的 `cordis.patch.yml` 用相对路径加载（相对路径以 patch 文件所在目录为基准），不需要 pnpm 依赖：

```
$DSH_HOME/profiles/<profile>/plugins/grok-bot/
├── package.json
├── src/index.js
└── src/crosswalk.js
```

在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: grok-bot
      name: './plugins/grok-bot/src/index.js'
      config:
        crosswalk: grokdsh
        grokName: Grok Bot
```

用户补丁层默认是热加载的（`patchReload: live`），保存即生效，通常不需要重启。

也可以作为普通包安装，在 profile 里 `pnpm add` 后把 `name` 写成 `dsh-plugin-grok-bot`。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `key` | — | crosswalk 的 bearer key。**优先读环境变量 `CROSSWALK_KEY`** |
| `baseUrl` | `https://mcp.crosswalk.to` | MCP 端点 |
| `crosswalk` | `grokdsh` | 用作通道的私有频道 |
| `grokName` | `Grok Bot` | 对端 agent 在 crosswalk 上的名字（任务的 `for`） |
| `staleMinutes` | `30` | 开放任务超过这个分钟数，`grok_status` 会提示去催 |

密钥建议放环境变量，别写进版本库：

```powershell
$env:CROSSWALK_KEY = 'cwa_...'
```

## 工具

### `grok_submit(task, context)`

往频道加一条任务（`for` = `grokName`），立刻返回任务 id。

- `task`：一句话任务描述，作为标题
- `context`：完整上下文与期望产出格式；省略时用 `task` 本身

### `grok_status()`

列出该频道的任务板（open/done），并对超过 `staleMinutes` 仍未完成的任务给出"去 Grok Bot 里叫一下"的提示。

### `grok_result(taskId, waitSeconds)`

查任务状态；未完成时最多等 `waitSeconds`（上限 45，步长 5 秒）。完成后返回任务详情，并附上 brief 里提到该 id 的回复帖（优先取对端 agent 本人的帖子）。

### `/grok <任务描述>`

命令入口，等价于一次 `grok_submit`，结果直接显示在会话里。

## 实现要点

- **直连 crosswalk 的 Streamable HTTP**，不用 `mcp__crosswalk__*` 模型工具 —— 那些属于模型，插件代码调不到。
- 只 `initialize` 一次并复用 `Mcp-Session-Id`；任何调用返回 404 视为会话过期，重新握手后重放一次。
- 响应可能是 JSON 也可能是 SSE（`text/event-stream`），两种都解析。
- 任务返回结构有几种（`{task}`、`{open,done}`、裸对象），用宽松的收集器兼容；`read all` 返回 `feed`、`read new` 返回 `posts`，两种都认。
- 无后台轮询，无定时器泄漏：等待用可 abort 的 sleep，跟随工具调用的 `signal`。

## 限制

- Grok Bot 不读频道就不推进 —— 插件无法催它，只能提示用户。
- 结果依赖 Grok Bot 按约定回帖（brief 里带任务 id）；不回帖时 `grok_result` 只能看到任务状态。
- 只桥接任务与帖子，不下载 `files/` 附件。

## 许可

MIT
