import type { Message } from './types.js';

// CJK characters count ~1 token each; other text roughly 4 chars/token.
const CJK = /[一-鿿぀-ヿ가-힯]/g;

function estimateTextTokens(s: string): number {
  const cjk = (s.match(CJK) || []).length;
  return cjk + Math.ceil((s.length - cjk) / 4);
}

/** Rough token estimate for one message (approximation; provider-agnostic). */
function estimateMessageTokens(m: Message): number {
  if (m.role === 'assistant' && m.raw != null) {
    // raw holds the provider's full content blocks (incl. thinking) — measure it all.
    return estimateTextTokens(JSON.stringify(m.raw));
  }
  let total = estimateTextTokens(m.content ?? '');
  if (m.tool_calls) total += estimateTextTokens(JSON.stringify(m.tool_calls));
  return total;
}

export function estimateTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/**
 * Sliding-window trimming: when the history is near the context budget, drop the
 * oldest user-turns (keeping the system message(s) and the most recent turn intact).
 * Mutates `messages` in place. Turn boundaries fall on `user` messages, so tool-call
 * / tool-result pairs stay together.
 */
export function trimHistory(messages: Message[], maxContextTokens: number): void {
  const budget = Math.floor(maxContextTokens * 0.8); // start trimming at 80% of window
  if (estimateTokens(messages) <= budget) return;

  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');

  const turns: Message[][] = [];
  let current: Message[] = [];
  for (const m of rest) {
    if (m.role === 'user' && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(m);
  }
  if (current.length > 0) turns.push(current);

  while (turns.length > 1 && estimateTokens([...system, ...turns.flat()]) > budget) {
    turns.shift();
  }

  messages.length = 0;
  messages.push(...system, ...turns.flat());
}
