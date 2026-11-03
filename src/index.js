/**
 * dsh-plugin-grok-bot — hand a task to Grok Bot over a crosswalk channel and
 * pull the result back.
 *
 * Design notes:
 * - The plugin talks to the crosswalk MCP server directly (Streamable HTTP). It
 *   cannot reuse the model-facing `mcp__crosswalk__*` tools: those belong to the
 *   model, not to plugin code.
 * - Everything is bounded. One call never waits longer than crosswalk's own
 *   `wait` ceiling (45s) and nothing polls in the background: Grok Bot cannot be
 *   woken by DSH, so an asynchronous submit/poll design is the only honest one.
 * - The key comes from `CROSSWALK_KEY` first, then plugin config.
 *
 * @module dsh-plugin-grok-bot
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { Crosswalk, asJson, textOf } from './crosswalk.js';

export const name = 'grok-bot';
export const inject = ['tools'];

/** Crosswalk's own ceiling for a blocking read. */
const WAIT_CEILING_S = 45;
/** Poll interval while `grok_result` waits. */
const POLL_INTERVAL_MS = 5_000;

export const Config = z.object({
  /** Bearer key for the crosswalk server; `CROSSWALK_KEY` wins when set. */
  key: z.string().default(''),
  /** MCP endpoint. */
  baseUrl: z.string().default('https://mcp.crosswalk.to'),
  /** Private crosswalk used as the channel. */
  crosswalk: z.string().default('grokdsh'),
  /** The peer agent's crosswalk name. */
  grokName: z.string().default('Grok Bot'),
  /** An open task older than this many minutes gets a nudge in grok_status. */
  staleMinutes: z.number().default(30),
});

/** Depth-first search for a short string id field. */
function findId(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findId(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  for (const key of ['id', 'taskId', 'task_id']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 40) return candidate;
  }
  for (const child of Object.values(value)) {
    const found = findId(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * Collect task-like objects from any of crosswalk's task response shapes: a bare
 * task, `{ task }`, `{ open, done }`, or a list under an arbitrary key.
 */
function collectTasks(value) {
  const tasks = [];
  const seen = new Set();
  const push = (item) => {
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    if (typeof item.id !== 'string') return;
    if (typeof item.title !== 'string' && typeof item.status !== 'string') return;
    seen.add(item);
    tasks.push(item);
  };
  const visit = (node, depth) => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    push(node);
    for (const child of Object.values(node)) visit(child, depth + 1);
  };
  visit(value, 0);
  return tasks;
}

/** Whether a task reads as completed. */
function isDone(task) {
  if (!task || typeof task !== 'object') return false;
  const status = String(task.status ?? task.state ?? '').toLowerCase();
  return status === 'done' || status === 'completed' || status === 'closed' || task.done === true;
}

/** First timestamp-looking field, in ms, for an age estimate. */
function timestampOf(task) {
  for (const key of ['created', 'created_at', 'createdAt', 'posted', 'opened_at', 'at']) {
    const raw = task?.[key];
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw);
      if (!Number.isNaN(parsed)) return parsed;
    }
    if (typeof raw === 'number' && raw > 1_000_000_000) return raw * 1000;
  }
  return undefined;
}

/** Abortable sleep; rejects with `aborted` when the caller cancels. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** Register the three tools and the `/grok` command against one channel. */
export function apply(ctx, config) {
  const key = (process.env.CROSSWALK_KEY ?? '').trim() || (config.key ?? '').trim();
  if (!key) {
    throw new Error(
      'dsh-plugin-grok-bot: no crosswalk key — set the CROSSWALK_KEY environment variable or the plugin config key',
    );
  }
  const cw = new Crosswalk(config.baseUrl, key);
  const channel = { crosswalk: config.crosswalk, for: config.grokName };

  /** Submit one task and report its id; never waits for the peer. */
  const submit = async (task, context, signal) => {
    const result = await cw.call(
      'tasks',
      { action: 'add', crosswalk: channel.crosswalk, title: task, details: context?.trim() ? context : task, for: channel.for },
      signal,
    );
    const text = textOf(result);
    // `tasks add` answers either JSON or prose ("Task #w9ikm6 for ...").
    const id = findId(asJson(result)) ?? /#([A-Za-z0-9_-]{4,16})/.exec(text)?.[1];
    const head = id
      ? `已交给 ${config.grokName}（任务 ${id}）。Grok Bot 读到后才会处理，不是实时返回；之后用 grok_result 取回。`
      : `已交给 ${config.grokName}。Grok Bot 读到后才会处理，不是实时返回；之后用 grok_status / grok_result 取回。`;
    return `${head}\n\n${text}`;
  };

  /** Summarize the channel's task board and flag stale open tasks. */
  const status = async (signal) => {
    const result = await cw.call('tasks', { action: 'list', crosswalk: channel.crosswalk, status: 'all' }, signal);
    const text = textOf(result);
    const tasks = collectTasks(asJson(result));
    if (tasks.length === 0) return `${config.crosswalk} 任务板：没有任务。\n\n${text}`;
    const stale = tasks.filter((task) => {
      if (isDone(task)) return false;
      const at = timestampOf(task);
      return at !== undefined && Date.now() - at > config.staleMinutes * 60_000;
    });
    const lines = [`${config.crosswalk} 任务板（共 ${tasks.length} 条）：`];
    for (const task of tasks) {
      lines.push(`- ${isDone(task) ? '[done]' : '[open]'} ${task.id ?? '(no id)'} ${task.title ?? ''}`.trim());
    }
    if (stale.length > 0) {
      lines.push(
        '',
        `其中 ${stale.length} 条开放任务已超过 ${config.staleMinutes} 分钟：可以去 Grok Bot 里叫一下 ${config.grokName}，它不处理是不会自己跑起来的。`,
      );
    }
    return `${lines.join('\n')}\n\n--- 原始返回 ---\n${text}`;
  };

  /** Poll one task up to `waitSeconds`, then attach the peer's reply post. */
  const resultTool = async (taskId, waitSeconds, signal) => {
    const deadline = Date.now() + Math.min(Math.max(waitSeconds ?? 0, 0), WAIT_CEILING_S) * 1000;
    let taskText = '';
    for (;;) {
      const got = await cw.call('tasks', { action: 'get', id: taskId }, signal);
      const parsed = asJson(got);
      taskText = textOf(got);
      const task = collectTasks(parsed)[0] ?? parsed;
      if (isDone(task)) break;
      if (Date.now() >= deadline) {
        return `任务 ${taskId} 仍在处理中（Grok Bot 未标记完成）。它只能由 Grok Bot 主动读取后才推进，必要时去 Grok Bot 里叫一下。\n\n${taskText}`;
      }
      if (deadline - Date.now() < 1000) break;
      await sleep(Math.min(POLL_INTERVAL_MS, deadline - Date.now()), signal);
    }

    let reply = '';
    try {
      const listed = await cw.call('read', { action: 'all', crosswalk: channel.crosswalk, limit: 20 }, signal);
      const parsed = asJson(listed);
      // `read new` answers `posts`, `read all` answers `feed`.
      const posts = Array.isArray(parsed?.posts) ? parsed.posts : Array.isArray(parsed?.feed) ? parsed.feed : [];
      const mentioning = posts.filter(
        (post) => typeof post?.brief === 'string' && post.brief.includes(String(taskId)),
      );
      // Prefer the peer's own reply; fall back to anything citing the task id.
      const fromPeer = mentioning.filter((post) => post?.via === config.grokName);
      const hits = fromPeer.length > 0 ? fromPeer : mentioning;
      if (hits.length > 0) {
        const opened = await cw.call('open', { ids: hits.slice(0, 3).map((post) => post.id) }, signal);
        reply = `\n\n--- 相关回复 ---\n${textOf(opened)}`;
      }
    } catch (error) {
      reply = `\n\n（查找相关回复失败：${String(error?.message ?? error)}）`;
    }
    return `任务 ${taskId} 已完成。\n\n${taskText}${reply}`;
  };

  const disposers = [
    ctx.tools.register(
      defineTool({
        name: 'grok_submit',
        description:
          '把一项任务交给 Grok Bot（crosswalk 私有频道），立即返回任务 id，不等结果。Grok Bot 无法被实时唤醒：它读到任务后才处理，因此用 grok_result 取回结果。适合网页研究、浏览器操作、邮件草拟、文件生成、定时任务等它擅长的活。',
        parameters: {
          task: { type: 'string', required: true, description: '一句话任务描述，作为任务标题' },
          context: { type: 'string', description: '完整上下文与期望产出格式；省略时用任务描述本身' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        timeoutMs: 30_000,
        execute: (args, exec) => submit(args.task, args.context, exec.signal),
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'grok_status',
        description: '列出该通道里发给 Grok Bot 的任务（open/done），并对超时未完成的任务提示去 Grok Bot 里催一下。',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        timeoutMs: 30_000,
        execute: (_args, exec) => status(exec.signal),
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: 'grok_result',
        description:
          '取回一项任务的结果：先查任务状态，未完成时最多等待 waitSeconds（上限 45 秒）；完成后连同 Grok Bot 的相关回复帖一并返回。不阻塞超过 45 秒。',
        parameters: {
          taskId: { type: 'string', required: true, description: 'grok_submit 返回的任务 id' },
          waitSeconds: { type: 'number', description: '愿意等待的秒数（0-45），默认 0 只查一次' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        timeoutMs: 90_000,
        execute: (args, exec) => resultTool(args.taskId, args.waitSeconds, exec.signal),
      }),
    ),
  ];

  const commands = ctx.get('commands');
  if (commands !== undefined) {
    disposers.push(
      commands.register({
        name: 'grok',
        description: `把一句话任务交给 ${config.grokName}（crosswalk: ${config.crosswalk}）`,
        input: { hint: '任务描述' },
        handler: async (invocation) => {
          const task = invocation.rawInput.trim();
          if (!task) return { kind: 'error', text: '用法：/grok <任务描述>' };
          try {
            return { kind: 'success', text: await submit(task, undefined, invocation.signal) };
          } catch (error) {
            return { kind: 'error', text: String(error?.message ?? error) };
          }
        },
      }),
    );
  }

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose();
  }, 'grok-bot.registrations');
}
