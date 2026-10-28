import type { AgentEvent, AssistantMessage, Message, ToolDef } from './types.js';
import type { ChatProvider } from './providers/provider.js';
import { executeTool, type ToolContext } from './tools/registry.js';
import { COMPACT_RATIO, compactHistory, estimateTokens, trimHistory } from './context.js';
import { truncate } from './util.js';

export interface LoopOptions {
  maxTurns: number;
  toolContext: ToolContext;
  maxContextTokens: number;
  maxToolResultChars: number;
  onEvent?: (e: AgentEvent) => void;
  /** Called with every message the loop appends (for the uncompacted session history). */
  onMessage?: (m: Message) => void;
}

export interface LoopOutcome {
  message: AssistantMessage;
  turns: number;
  /** Tokens in the model context after the final reply (provider-reported when available). */
  contextTokens: number;
  /** True when `contextTokens` is a local estimate rather than provider usage. */
  contextEstimated: boolean;
  /** Set when the loop stopped early for a non-fatal reason (soft budget / loop). */
  stopped?: 'max_turns' | 'loop';
}

const WRAP_UP =
  'You are at your step limit. Stop calling tools and give your final answer now.';

function toolSignature(calls: { name: string; arguments: string }[]): string {
  return calls.map((c) => `${c.name}\u0000${c.arguments}`).sort().join('\n');
}

/**
 * Tracks how many tokens are in the context: the provider's usage for the last call
 * (prompt + reply) plus an estimate for messages appended since. Falls back to a
 * pure estimate when no usage is known (mock provider, or right after compaction).
 */
class ContextMeter {
  private anchor: { tokens: number; index: number } | null = null;

  constructor(private readonly messages: Message[]) {}

  /** Record usage for the reply just appended as the last message. */
  measured(reply: AssistantMessage): void {
    this.anchor = reply.usage
      ? { tokens: reply.usage.inputTokens + reply.usage.outputTokens, index: this.messages.length }
      : null;
  }

  /** History was rewritten (compacted/trimmed); old usage no longer applies. */
  reset(): void {
    this.anchor = null;
  }

  get estimated(): boolean {
    return this.anchor === null;
  }

  tokens(): number {
    if (!this.anchor) return estimateTokens(this.messages);
    return this.anchor.tokens + estimateTokens(this.messages.slice(this.anchor.index));
  }
}

/**
 * Summarize older turns once the context reaches COMPACT_RATIO of the window.
 * A failed summary is reported and left to the sliding-window trim as a fallback.
 */
async function maybeCompact(
  provider: ChatProvider,
  messages: Message[],
  meter: ContextMeter,
  opts: LoopOptions,
): Promise<void> {
  const before = meter.tokens();
  if (before < opts.maxContextTokens * COMPACT_RATIO) return;
  try {
    const summarize = async (prompt: Message[]): Promise<string | null> => (await provider.chat(prompt, [])).content;
    if (!(await compactHistory(messages, summarize))) return;
    meter.reset();
    opts.onEvent?.({ type: 'compact', before, after: meter.tokens() });
  } catch (e) {
    opts.onEvent?.({ type: 'error', message: `context compaction failed: ${(e as Error).message}` });
  }
}

/**
 * The agent loop: ask the model, run any tool calls it returns (in parallel), feed
 * results back, and repeat until the model answers without tool calls. Soft stop
 * conditions (step budget exhausted, or the model repeating the exact same tool
 * calls) return a graceful outcome instead of throwing.
 */
export async function runAgent(
  provider: ChatProvider,
  tools: ToolDef[],
  messages: Message[],
  opts: LoopOptions,
): Promise<LoopOutcome> {
  let prevSignature: string | null = null;
  const meter = new ContextMeter(messages);
  const push = (m: Message): void => {
    messages.push(m);
    opts.onMessage?.(m);
  };
  const finish = (message: AssistantMessage, turns: number, stopped?: LoopOutcome['stopped']): LoopOutcome => ({
    message,
    turns,
    contextTokens: meter.tokens(),
    contextEstimated: meter.estimated,
    ...(stopped ? { stopped } : {}),
  });

  for (let turn = 0; turn < opts.maxTurns; turn++) {
    await maybeCompact(provider, messages, meter, opts);
    const count = messages.length;
    trimHistory(messages, opts.maxContextTokens);
    if (messages.length !== count) meter.reset();

    // On the final turn, nudge the model to wrap up (transient: popped after the call).
    const isLast = turn === opts.maxTurns - 1;
    if (isLast) messages.push({ role: 'system', content: WRAP_UP });
    let reply: AssistantMessage;
    try {
      reply = await provider.chat(messages, tools);
    } finally {
      if (isLast) messages.pop();
    }

    opts.onEvent?.({ type: 'assistant', content: reply.content, tool_calls: reply.tool_calls });
    push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls, raw: reply.raw });
    meter.measured(reply);

    if (reply.tool_calls.length === 0) {
      await maybeCompact(provider, messages, meter, opts);
      opts.onEvent?.({ type: 'done', content: reply.content });
      return finish(reply, turn + 1);
    }

    // Non-progress loop: the exact same tool calls as the previous turn.
    const signature = toolSignature(reply.tool_calls);
    if (signature === prevSignature) {
      const message: AssistantMessage = { content: '(stopped: tool calls are repeating without progress)', tool_calls: [] };
      opts.onEvent?.({ type: 'done', content: message.content });
      return finish(message, turn + 1, 'loop');
    }
    prevSignature = signature;

    // Run all tool calls concurrently, then report each call with its result (in order).
    const results = await Promise.all(
      reply.tool_calls.map(async (call) => {
        const result = await executeTool(call, opts.toolContext);
        return { call, result };
      }),
    );

    for (const { call, result } of results) {
      opts.onEvent?.({ type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments });
      const output = truncate(result.ok ? result.output : result.error, opts.maxToolResultChars);
      opts.onEvent?.({ type: 'tool_result', id: call.id, name: call.name, ok: result.ok, arguments: call.arguments, output });
      push({ role: 'tool', tool_call_id: call.id, content: output, tool_error: !result.ok });
    }
  }

  const message: AssistantMessage = {
    content: `(stopped: reached step limit of ${opts.maxTurns}; increase --max-turns if needed)`,
    tool_calls: [],
  };
  opts.onEvent?.({ type: 'done', content: message.content });
  return finish(message, opts.maxTurns, 'max_turns');
}
