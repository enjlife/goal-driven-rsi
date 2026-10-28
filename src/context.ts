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

/** Compact the conversation once the context reaches this share of the window. */
export const COMPACT_RATIO = 0.7;

const SUMMARY_PROMPT = [
  'You compress an agent conversation so it can continue in a smaller context. The agent will see only your summary',
  'plus the latest user turn, so keep everything needed to carry on. Write in the user\'s language, using exactly these',
  'sections (write "none" for an empty one):',
  '',
  '## Goals',
  'Every goal and requirement the user stated, including constraints and preferences; keep them faithful, not reworded away.',
  '## Approach',
  'The chosen solution/plan and key decisions with their reasons; alternatives that were rejected and why.',
  '## Conclusions',
  'What has been done and established: results, findings, verified facts, plus the concrete details needed to continue',
  '(file paths, commands, identifiers, error messages).',
  '## TODO',
  'A checklist of remaining work and open questions: "- [ ] item" for pending, "- [x] item" for done in this span.',
  '',
  'If a [previous summary] is included, merge it: keep its goals, update its approach and conclusions, and carry its',
  'TODO items forward, ticking off the ones now done. Output only the summary.',
].join('\n');

const SUMMARY_HEADER = '[Summary of the earlier conversation (compacted to save context)]\n';

/** Max chars per message when serializing old turns for the summarizer. */
const SUMMARY_MESSAGE_CHARS = 2000;

/** Plain-text rendering of messages for the summarizer (tool output clipped). */
function renderForSummary(messages: Message[]): string {
  const clip = (s: string): string => (s.length > SUMMARY_MESSAGE_CHARS ? `${s.slice(0, SUMMARY_MESSAGE_CHARS)}…` : s);
  return messages
    .map((m) => {
      if (m.summary) return `[previous summary]\n${m.content ?? ''}`;
      if (m.role === 'tool') return `[tool result${m.tool_error ? ' (error)' : ''}]\n${clip(m.content ?? '')}`;
      const calls = (m.tool_calls ?? []).map((c) => `\n[tool call] ${c.name} ${clip(c.arguments)}`).join('');
      return `[${m.role}]\n${clip(m.content ?? '')}${calls}`;
    })
    .join('\n\n');
}

/**
 * Summarize every turn except the latest one into a single system message, keeping
 * the base system prompt(s) and the latest user turn verbatim. Mutates `messages`
 * in place; returns false when there is nothing older than the latest turn.
 * `summarize` receives the summarizer prompt plus the rendered transcript.
 */
export async function compactHistory(
  messages: Message[],
  summarize: (prompt: Message[]) => Promise<string | null>,
): Promise<boolean> {
  const base = messages.filter((m) => m.role === 'system' && !m.summary);
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  if (lastUser < 0) return false;
  const older = messages.slice(0, lastUser).filter((m) => m.role !== 'system' || m.summary);
  if (!older.some((m) => !m.summary)) return false;

  const text = await summarize([
    { role: 'system', content: SUMMARY_PROMPT },
    { role: 'user', content: renderForSummary(older) },
  ]);
  if (!text?.trim()) throw new Error('summarizer returned an empty summary');

  const latest = messages.slice(lastUser).filter((m) => m.role !== 'system');
  messages.length = 0;
  messages.push(...base, { role: 'system', content: SUMMARY_HEADER + text.trim(), summary: true }, ...latest);
  return true;
}
