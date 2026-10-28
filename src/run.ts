import type { AgentEvent, Message, ToolDef } from './types.js';
import type { ChatProvider } from './providers/provider.js';
import type { ToolContext } from './tools/registry.js';
import type { MemoryStore } from './memory/store.js';
import { runAgent, type LoopOutcome } from './loop.js';
import { truncate } from './util.js';

export interface RunEnv {
  provider: ChatProvider;
  tools: ToolDef[];
  toolContext: ToolContext;
  memory: MemoryStore;
  maxTurns: number;
  maxContextTokens: number;
  maxToolResultChars: number;
  systemPrompt: string;
}

/**
 * A named, resumable conversation. `messages` is the working context sent to the
 * model (may be compacted); `history` is the full, never-compacted record.
 */
export interface Session {
  id: string;
  messages: Message[];
  history: Message[];
}

/** Fresh conversation state: a single system message. */
export function newMessages(env: RunEnv): Message[] {
  return [{ role: 'system', content: env.systemPrompt }];
}

/** Start a new session with a fresh (timestamped) id. */
export function newSession(env: RunEnv, id?: string): Session {
  const messages = newMessages(env);
  return { id: id ?? env.memory.newSessionId(), messages, history: [...messages] };
}

/** Run one user turn to completion; mutates the session and emits events. */
export async function runTurn(
  env: RunEnv,
  session: Session,
  content: string,
  onEvent?: (e: AgentEvent) => void,
): Promise<LoopOutcome> {
  const emit = (e: AgentEvent): void => {
    onEvent?.(e);
    env.memory.record(e);
  };
  emit({ type: 'request', role: 'user', content });
  const user: Message = { role: 'user', content };
  session.messages.push(user);
  session.history.push(user);
  try {
    const outcome = await runAgent(env.provider, env.tools, session.messages, {
      maxTurns: env.maxTurns,
      toolContext: env.toolContext,
      maxContextTokens: env.maxContextTokens,
      maxToolResultChars: env.maxToolResultChars,
      onEvent: emit,
      onMessage: (m) => session.history.push(m),
    });
    emit({ type: 'context', tokens: outcome.contextTokens, maxTokens: env.maxContextTokens, estimated: outcome.contextEstimated });
    return outcome;
  } finally {
    env.memory.saveSession(session.id, session);
  }
}

/**
 * Render events for a human at a terminal: assistant text to `out`, tool activity
 * and errors to `err` (so `agent -p "..."` keeps its stdout clean for piping).
 */
const MAX_RESULT_CHARS = 500;

function isColor(stream: NodeJS.WritableStream): boolean {
  return (stream as { isTTY?: boolean }).isTTY === true;
}

function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/** Local wall-clock time as YYYY-MM-DD HH:mm:ss. */
function formatTime(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
    case 'compact':
      err.write(dim(`[compact] context ${formatTokens(e.before)} -> ${formatTokens(e.after)} tokens (full history kept in the session file)`) + '\n');
      break;
    case 'context': {
      const pct = e.maxTokens > 0 ? Math.round((e.tokens / e.maxTokens) * 100) : 0;
      const approx = e.estimated ? '~' : '';
      err.write(dim(`[${formatTime(new Date())}] context ${approx}${formatTokens(e.tokens)} / ${formatTokens(e.maxTokens)} tokens (${pct}%)`) + '\n');
      break;
    }
    case 'request':
    case 'done':
      break;
  }
}
