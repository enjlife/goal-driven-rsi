import type { ToolResult } from '../types.js';
import type { MemoryStore } from '../memory/store.js';
import { truncate } from '../util.js';

const MAX_POST_CHARS = 1500;

/** `read_board` tool: read shared board posts, scoped to the current batch by default. */
export function readBoard(store: MemoryStore, args: Record<string, unknown>, batch?: string): ToolResult {
  const scope = args.scope === 'all' || !batch ? 'all' : 'batch';
  const from = typeof args.from === 'string' && args.from.trim() ? args.from.trim() : undefined;
  const limit = typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : 20;
  const posts = store.readBoard(limit, { batch: scope === 'batch' ? batch : undefined, from });
  if (posts.length === 0) return { ok: true, output: scope === 'batch' ? '(no posts in this batch yet)' : '(board is empty)' };
  const output = posts
    .map((p) => `[${p.ts}] ${p.from} (${p.kind}${p.batch && scope === 'all' ? `, batch ${p.batch}` : ''}):\n${truncate(p.content.trim(), MAX_POST_CHARS)}`)
    .join('\n\n');
  return { ok: true, output };
}

/** `post_board` tool: share an interim finding/decision on the board (tagged with the batch). */
export function postBoard(store: MemoryStore, args: Record<string, unknown>, batch?: string): ToolResult {
  const content = typeof args.content === 'string' ? args.content : '';
  if (!content.trim()) return { ok: false, error: 'missing "content"' };
  const post = store.appendBoard({ from: store.agentId, kind: 'note', batch, content });
  return { ok: true, output: `posted ${post.id} to the board${batch ? ` (batch ${batch})` : ''}` };
}
