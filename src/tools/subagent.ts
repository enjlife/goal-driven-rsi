import type { ToolResult } from '../types.js';
import { truncate } from '../util.js';

/** Hard cap on tasks per `spawn_agents` call. */
export const MAX_SUBAGENT_TASKS = 8;

export interface SubagentTask {
  id: string;
  task: string;
  systemPrompt?: string;
}

/** One `spawn_agents` call: siblings share a batch id that scopes their board posts. */
export interface SubagentBatch {
  id: string;
  /** Task ids of every sub-agent in the batch (including the current one). */
  members: string[];
}

/** Runtime hooks for `spawn_agents`, wired by buildEnv (absent = unavailable). */
export interface SubagentRuntime {
  /** Run one sub-agent to completion in a fresh conversation; returns its final answer. */
  run: (task: SubagentTask, batch: SubagentBatch) => Promise<string>;
  /** Max sub-agents running at the same time. */
  concurrency: number;
  /** Total output budget shared by all results (split evenly per task). */
  maxOutputChars: number;
}

function parseTasks(args: Record<string, unknown>): SubagentTask[] {
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) throw new Error('missing "tasks"');
  if (args.tasks.length > MAX_SUBAGENT_TASKS) throw new Error(`too many tasks (max ${MAX_SUBAGENT_TASKS})`);
  const seen = new Set<string>();
  return args.tasks.map((raw, i) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    const task = typeof t.task === 'string' ? t.task.trim() : '';
    if (!task) throw new Error(`tasks[${i}] missing "task"`);
    // Ids become memory namespaces: keep them filesystem-safe and unique.
    let id = (typeof t.id === 'string' ? t.id.trim() : '').replace(/[^\w-]/g, '-') || `sub-${i + 1}`;
    if (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const systemPrompt = typeof t.system_prompt === 'string' && t.system_prompt.trim() ? t.system_prompt.trim() : undefined;
    return { id, task, systemPrompt };
  });
}

/** Run `items` through `fn` with at most `limit` in flight; results keep input order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** `spawn_agents` tool: delegate independent sub-tasks to parallel sub-agents. */
export async function spawnAgents(rt: SubagentRuntime | undefined, args: Record<string, unknown>): Promise<ToolResult> {
  if (!rt) return { ok: false, error: 'spawn_agents is not available here (sub-agents cannot spawn further sub-agents)' };
  const tasks = parseTasks(args);
  const batch: SubagentBatch = { id: `b-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, members: tasks.map((t) => t.id) };
  const results = await pool(tasks, Math.max(1, rt.concurrency), async (t) => {
    try {
      return { id: t.id, ok: true, text: (await rt.run(t, batch)) || '(no answer)' };
    } catch (e) {
      // One failing sub-agent must not sink the batch.
      return { id: t.id, ok: false, text: (e as Error).message };
    }
  });
  const budget = Math.max(200, Math.floor(rt.maxOutputChars / tasks.length) - 50);
  const output = `batch ${batch.id} (results also on the board: read_board scope "all")\n\n` + results
    .map((r) => `## [${r.id}] ${r.ok ? 'ok' : 'failed'}\n${truncate(r.text, budget)}`)
    .join('\n\n');
  return results.some((r) => r.ok) ? { ok: true, output } : { ok: false, error: output };
}
