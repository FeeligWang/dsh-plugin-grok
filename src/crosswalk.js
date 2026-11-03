/**
 * Minimal MCP client over Streamable HTTP for the crosswalk server.
 *
 * One instance = one server + one bearer key. The session id is captured from
 * `initialize` and reused; a 404 from any later call means the server dropped
 * the session, so we re-initialize once and replay the call.
 *
 * @module dsh-plugin-grok-bot/crosswalk
 */

/** JSON-RPC message carried by a plain JSON or `text/event-stream` response. */
export function parseRpcBody(text, contentType) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return undefined;
  const looksLikeSse =
    (contentType ?? '').includes('text/event-stream') ||
    trimmed.startsWith('event:') ||
    trimmed.startsWith('data:');
  if (!looksLikeSse) return JSON.parse(trimmed);
  const payload = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .pop();
  return payload ? JSON.parse(payload) : undefined;
}

/** Join an MCP result's text blocks into one string. */
export function textOf(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks
    .map((block) =>
      block?.type === 'text' && typeof block.text === 'string' ? block.text : `[${block?.type ?? 'unknown'} block]`,
    )
    .join('\n');
}

/** Parse a tool's text payload as JSON; undefined when the payload is prose. */
export function asJson(result) {
  try {
    return JSON.parse(textOf(result));
  } catch {
    return undefined;
  }
}

export class Crosswalk {
  #seq = 0;
  #sessionId;
  #ready;

  /**
   * @param baseUrl - MCP endpoint, e.g. `https://mcp.crosswalk.to`.
   * @param key - bearer key; the client adds the `Bearer ` prefix itself.
   */
  constructor(baseUrl, key) {
    this.baseUrl = baseUrl;
    this.key = key;
  }

  #headers() {
    const headers = {
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.#sessionId) headers['Mcp-Session-Id'] = this.#sessionId;
    return headers;
  }

  async #post(payload, signal) {
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(payload),
      signal,
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.#sessionId = sid;
    const text = await res.text();
    return { status: res.status, body: parseRpcBody(text, res.headers.get('content-type')) };
  }

  async #initialize(signal) {
    const res = await this.#post(
      {
        jsonrpc: '2.0',
        id: ++this.#seq,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'dsh-plugin-grok-bot', version: '0.1.0' },
        },
      },
      signal,
    );
    if (res.body?.error) throw new Error(`crosswalk initialize failed: ${JSON.stringify(res.body.error)}`);
    if (res.status !== 200) throw new Error(`crosswalk initialize returned HTTP ${res.status}`);
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal).catch(() => {});
  }

  /** Initialize once; concurrent callers share the same handshake. */
  async ensure(signal) {
    if (!this.#ready) {
      this.#ready = this.#initialize(signal).catch((error) => {
        this.#ready = undefined;
        throw error;
      });
    }
    await this.#ready;
  }

  /**
   * Call one MCP tool and return its raw `CallToolResult`.
   * @throws when the transport fails or the tool reports `isError`.
   */
  async call(toolName, args, signal) {
    await this.ensure(signal);
    const send = () =>
      this.#post(
        { jsonrpc: '2.0', id: ++this.#seq, method: 'tools/call', params: { name: toolName, arguments: args } },
        signal,
      );
    let res = await send();
    if (res.status === 404) {
      this.#sessionId = undefined;
      this.#ready = undefined;
      await this.ensure(signal);
      res = await send();
    }
    if (res.body?.error) throw new Error(`crosswalk ${toolName} failed: ${JSON.stringify(res.body.error)}`);
    if (res.status !== 200) throw new Error(`crosswalk ${toolName} returned HTTP ${res.status}`);
    const result = res.body?.result;
    if (result?.isError === true) throw new Error(textOf(result) || `crosswalk ${toolName} reported an error`);
    return result;
  }
}
