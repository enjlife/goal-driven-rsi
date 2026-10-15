import type { AgentEvent, AssistantMessage, Message, ToolDef } from './types.js';
import type { ChatProvider } from './providers/provider.js';
import { executeTool, type ToolContext } from './tools/registry.js';
import { trimHistory } from './context.js';
import { truncate } from './util.js';

export interface LoopOptions {
  maxTurns: number;
  toolContext: ToolContext;
  maxContextTokens: number;
  maxToolResultChars: number;
  onEvent?: (e: AgentEvent) => void;
}

export interface LoopOutcome {
  message: AssistantMessage;
  turns: number;
  /** Set when the loop stopped early for a non-fatal reason (soft budget / loop). */
  stopped?: 'max_turns' | 'loop';
}

const WRAP_UP =
  'You are at your step limit. Stop calling tools and give your final answer now.';

function toolSignature(calls: { name: string; arguments: string }[]): string {
  return calls.map((c) => `${c.name}\u0000${c.arguments}`).sort().join('\n');
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

  for (let turn = 0; turn < opts.maxTurns; turn++) {
    trimHistory(messages, opts.maxContextTokens);

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
    messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls, raw: reply.raw });

    if (reply.tool_calls.length === 0) {
      opts.onEvent?.({ type: 'done', content: reply.content });
      return { message: reply, turns: turn + 1 };
    }

    // Non-progress loop: the exact same tool calls as the previous turn.
    const signature = toolSignature(reply.tool_calls);
    if (signature === prevSignature) {
      const message: AssistantMessage = { content: '(stopped: tool calls are repeating without progress)', tool_calls: [] };
      opts.onEvent?.({ type: 'done', content: message.content });
      return { message, turns: turn + 1, stopped: 'loop' };
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
      messages.push({ role: 'tool', tool_call_id: call.id, content: output, tool_error: !result.ok });
    }
  }

  const message: AssistantMessage = {
    content: `(stopped: reached step limit of ${opts.maxTurns}; increase --max-turns if needed)`,
    tool_calls: [],
  };
  opts.onEvent?.({ type: 'done', content: message.content });
  return { message, turns: opts.maxTurns, stopped: 'max_turns' };
}
