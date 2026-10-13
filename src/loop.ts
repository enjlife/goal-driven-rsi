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
}

/**
 * The agent loop: ask the model, run any tool calls it returns (in parallel), feed
 * results back, and repeat until the model answers without tool calls or the turn
 * budget is spent. `messages` is mutated in place so callers can continue.
 */
export async function runAgent(
  provider: ChatProvider,
  tools: ToolDef[],
  messages: Message[],
  opts: LoopOptions,
): Promise<LoopOutcome> {
  for (let turn = 0; turn < opts.maxTurns; turn++) {
    trimHistory(messages, opts.maxContextTokens);

    const reply = await provider.chat(messages, tools);
    opts.onEvent?.({ type: 'assistant', content: reply.content, tool_calls: reply.tool_calls });

    messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls, raw: reply.raw });

    if (reply.tool_calls.length === 0) {
      opts.onEvent?.({ type: 'done', content: reply.content });
      return { message: reply, turns: turn + 1 };
    }

    // Run all tool calls concurrently, then report each call together with its
    // result (in original order) so the display and the JSONL stream pair them up.
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
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: output,
        tool_error: !result.ok,
      });
    }
  }

  throw new Error(`agent exceeded maxTurns=${opts.maxTurns}`);
}
