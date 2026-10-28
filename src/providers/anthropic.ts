import type { AssistantMessage, Message, ToolCall, ToolDef } from '../types.js';
import type { ChatProvider } from './provider.js';
import { ProviderError, isRetryableStatus, parseRetryAfterMs } from '../errors.js';
import { withRetry, type RetryOptions } from '../retry.js';

interface AnthropicConfig {
  apiKey?: string;
  authToken?: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/**
 * Convert internal messages to the Anthropic Messages wire format.
 * - `system` messages collapse into the top-level `system` string.
 * - Consecutive `tool` messages group into a single `user` message of `tool_result` blocks.
 * - Assistant messages carrying `raw` content blocks are echoed back verbatim so
 *   thinking blocks stay preserved across turns (append-only history).
 */
function toAnthropicMessages(messages: Message[]): { system: string; msgs: Record<string, unknown>[] } {
  const systemParts: string[] = [];
  const msgs: Record<string, unknown>[] = [];
  let i = 0;

  while (i < messages.length) {
    const m = messages[i];

    if (m.role === 'system') {
      systemParts.push(m.content ?? '');
      i++;
      continue;
    }

    if (m.role === 'tool') {
      const blocks: Record<string, unknown>[] = [];
      while (i < messages.length && messages[i].role === 'tool') {
        const t = messages[i];
        const block: Record<string, unknown> = {
          type: 'tool_result',
          tool_use_id: t.tool_call_id,
          content: t.content ?? '',
        };
        if (t.tool_error) block.is_error = true;
        blocks.push(block);
        i++;
      }
      msgs.push({ role: 'user', content: blocks });
      continue;
    }

    if (m.role === 'assistant') {
      if (m.raw) {
        msgs.push({ role: 'assistant', content: m.raw });
      } else if (m.tool_calls && m.tool_calls.length > 0) {
        // No raw blocks (e.g. history from another provider): rebuild tool_use blocks.
        const blocks: Record<string, unknown>[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const tc of m.tool_calls) {
          let input: unknown = {};
          try {
            input = JSON.parse(tc.arguments || '{}');
          } catch {
            // keep {} for malformed arguments
          }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
        }
        msgs.push({ role: 'assistant', content: blocks });
      } else {
        msgs.push({ role: 'assistant', content: m.content ?? '' });
      }
      i++;
      continue;
    }

    // user
    msgs.push({ role: 'user', content: m.content ?? '' });
    i++;
  }

  return { system: systemParts.join('\n\n'), msgs };
}

export class AnthropicProvider implements ChatProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly cfg: AnthropicConfig,
    private readonly retry: RetryOptions,
  ) {}

  async chat(messages: Message[], tools: ToolDef[]): Promise<AssistantMessage> {
    return withRetry(() => this.request(messages, tools), this.retry);
  }

  private async request(messages: Message[], tools: ToolDef[]): Promise<AssistantMessage> {
    const { system, msgs } = toAnthropicMessages(messages);

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      max_tokens: this.cfg.maxTokens,
      messages: msgs,
    };
    if (system) body.system = system;
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (this.cfg.apiKey) headers['x-api-key'] = this.cfg.apiKey;
    else if (this.cfg.authToken) headers['authorization'] = `Bearer ${this.cfg.authToken}`;

    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new ProviderError(`network error: ${(e as Error).message}`, { retryable: true });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new ProviderError(`Anthropic HTTP ${res.status}: ${text.slice(0, 500)}`, {
        status: res.status,
        retryable: isRetryableStatus(res.status),
        retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
      });
    }

    let data: {
      content: AnthropicContentBlock[];
      usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    };
    try {
      data = (await res.json()) as typeof data;
    } catch (e) {
      throw new ProviderError(`Anthropic returned invalid JSON: ${(e as Error).message}`, { retryable: false });
    }

    const contentParts: string[] = [];
    const tool_calls: ToolCall[] = [];

    for (const block of data.content ?? []) {
      if (block.type === 'text' && block.text != null) contentParts.push(block.text);
      else if (block.type === 'tool_use') {
        tool_calls.push({
          id: block.id ?? '',
          name: block.name ?? '',
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
      // thinking / redacted_thinking blocks are preserved via `raw`, not rendered.
    }

    const u = data.usage;
    return {
      content: contentParts.length > 0 ? contentParts.join('') : null,
      tool_calls,
      raw: data.content,
      usage: u && {
        inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
      },
    };
  }
}
