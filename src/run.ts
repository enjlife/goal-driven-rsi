import type { AgentEvent, AssistantMessage, Message, ToolDef } from './types.js';
import type { ChatProvider } from './providers/provider.js';
import type { ToolContext } from './tools/registry.js';
import { runAgent } from './loop.js';
import { truncate } from './util.js';

export interface RunEnv {
  provider: ChatProvider;
  tools: ToolDef[];
  toolContext: ToolContext;
  maxTurns: number;
  maxContextTokens: number;
  maxToolResultChars: number;
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
    maxContextTokens: env.maxContextTokens,
    maxToolResultChars: env.maxToolResultChars,
    onEvent,
  });
  return message;
}

/**
 * Render events for a human at a terminal: assistant text to `out`, tool activity
 * and errors to `err` (so `agent -p "..."` keeps its stdout clean for piping).
 */
const MAX_RESULT_CHARS = 500;

function isColor(stream: NodeJS.WritableStream): boolean {
  return (stream as { isTTY?: boolean }).isTTY === true;
}

export function printHuman(
  e: AgentEvent,
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
): void {
  const color = isColor(err);
  const toolTag = color ? '\x1b[1;30;46m[tool]\x1b[0m' : '[tool]';
  const errorTag = color ? '\x1b[1;31m[error]\x1b[0m' : '[error]';
  const dim = (s: string): string => (color ? `\x1b[2m${s}\x1b[0m` : s);

  switch (e.type) {
    case 'assistant':
      if (e.tool_calls.length === 0 && e.content) out.write(e.content + '\n');
      break;
    case 'tool_call':
      err.write(`${toolTag} ${e.name} ${dim(e.arguments)}\n`);
      break;
    case 'tool_result': {
      const resultTag = e.ok
        ? (color ? '\x1b[1;30;42m[tool result]\x1b[0m' : '[tool result]')
        : (color ? '\x1b[1;37;41m[tool result]\x1b[0m' : '[tool result]');
      err.write(`${resultTag} ${e.name} ${dim(e.arguments)}\n`);
      const body = truncate(e.output, MAX_RESULT_CHARS)
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n');
      err.write(`${dim(body)}\n`);
      break;
    }
    case 'error':
      err.write(`${errorTag} ${e.message}\n`);
      break;
    case 'request':
    case 'done':
      break;
  }
}
