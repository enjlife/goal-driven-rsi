import type { AgentEvent, AssistantMessage, Message, ToolDef } from './types.js';
import type { ChatProvider } from './providers/provider.js';
import type { ToolContext } from './tools/registry.js';
import { runAgent } from './loop.js';

export interface RunEnv {
  provider: ChatProvider;
  tools: ToolDef[];
  toolContext: ToolContext;
  maxTurns: number;
  systemPrompt: string;
}

/** Fresh conversation state: a single system message. */
export function newMessages(env: RunEnv): Message[] {
  return [{ role: 'system', content: env.systemPrompt }];
}

/** Run one user turn to completion; mutates `messages` and emits events. */
export async function runTurn(
  env: RunEnv,
  messages: Message[],
  content: string,
  onEvent?: (e: AgentEvent) => void,
): Promise<AssistantMessage> {
  onEvent?.({ type: 'request', role: 'user', content });
  messages.push({ role: 'user', content });
  const { message } = await runAgent(env.provider, env.tools, messages, {
    maxTurns: env.maxTurns,
    toolContext: env.toolContext,
    onEvent,
  });
  return message;
}

/**
 * Render events for a human at a terminal: assistant text to `out`, tool activity
 * and errors to `err` (so `agent -p "..."` keeps its stdout clean for piping).
 */
export function printHuman(
  e: AgentEvent,
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
): void {
  switch (e.type) {
    case 'assistant':
      if (e.tool_calls.length === 0 && e.content) out.write(e.content + '\n');
      break;
    case 'tool_call':
      err.write(`[tool] ${e.name} ${e.arguments}\n`);
      break;
    case 'tool_result':
      err.write(`[tool:${e.name}] ${e.ok ? 'ok' : 'error'}: ${e.output.slice(0, 200)}\n`);
      break;
    case 'error':
      err.write(`[error] ${e.message}\n`);
      break;
    case 'request':
    case 'done':
      break;
  }
}
