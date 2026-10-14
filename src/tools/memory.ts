import type { ToolResult } from '../types.js';
import type { MemoryStore } from '../memory/store.js';

/** `remember` tool: write a curated insight (self) or shared knowledge note (shared). */
export function remember(store: MemoryStore, args: Record<string, unknown>): ToolResult {
  const scope = args.scope === 'shared' ? 'shared' : 'self';
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const content = typeof args.content === 'string' ? args.content : '';
  if (!title) return { ok: false, error: 'missing "title"' };
  if (!content.trim()) return { ok: false, error: 'missing "content"' };
  const tags = Array.isArray(args.tags) ? args.tags.filter((t): t is string => typeof t === 'string') : undefined;

  if (scope === 'shared') {
    store.appendShared(title, content, tags);
    return { ok: true, output: `recorded shared note to ${store.sharedPath()}` };
  }
  store.appendInsight(title, content, tags);
  return { ok: true, output: `recorded insight to ${store.insightsPath()}` };
}

/** `recall` tool: search memory, or list recent journal entries when query is empty. */
export function recall(store: MemoryStore, args: Record<string, unknown>): ToolResult {
  const query = typeof args.query === 'string' ? args.query : undefined;
  const maxResults = typeof args.max_results === 'number' ? Math.max(1, Math.floor(args.max_results)) : 5;
  return { ok: true, output: store.recall(query, maxResults) };
}
