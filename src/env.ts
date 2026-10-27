import type { Config } from './config.js';
import { createProvider } from './providers/provider.js';
import { toolDefs } from './tools/registry.js';
import type { SubagentBatch, SubagentRuntime, SubagentTask } from './tools/subagent.js';
import { MemoryStore } from './memory/store.js';
import { SkillStore } from './skills/store.js';
import { newSession, runTurn, type RunEnv } from './run.js';

const SUBAGENT_SYSTEM_PROMPT =
  'You are a sub-agent working on one delegated task. You have tools to run shell commands and read/write files, ' +
  'plus long-term memory and skills. Complete the task on your own (you cannot ask the user), ' +
  'then reply with a concise, self-contained final answer: what you did, what you found, and any open issues.';

/**
 * Assemble a RunEnv (provider + tools + stores + loop options) from a Config.
 * Top-level envs get `spawn_agents`; the sub-agents it creates do not (depth 1).
 */
export function buildEnv(config: Config, opts: { noTools?: boolean; batch?: string } = {}): RunEnv {
  const provider = createProvider(config.provider, config);
  const isSub = opts.batch !== undefined;
  const tools = opts.noTools ? [] : toolDefs({ subagents: !isSub, askUser: !isSub });
  const memory = new MemoryStore(config.memoryDir, config.agentId);
  const skills = new SkillStore(config.skillsDir);
  const subagents = opts.noTools || isSub ? undefined : subagentRuntime(config);
  return {
    provider,
    tools,
    toolContext: { cwd: config.workdir, shellTimeoutMs: config.shellTimeoutMs, memory, skills, subagents, batch: opts.batch },
    memory,
    maxTurns: config.maxTurns,
    maxContextTokens: config.maxContextTokens,
    maxToolResultChars: config.maxToolResultChars,
    systemPrompt: config.systemPrompt,
  };
}

/** Sub-agents inherit the parent's model/workdir/memory root under a child agentId. */
function subagentRuntime(parent: Config): SubagentRuntime {
  return {
    concurrency: parent.subagentConcurrency,
    maxOutputChars: parent.maxToolResultChars,
    run: async (task: SubagentTask, batch: SubagentBatch) => {
      const agentId = `${parent.agentId}.${task.id}`;
      const prompt = [task.systemPrompt, SUBAGENT_SYSTEM_PROMPT, batchPrompt(parent.agentId, agentId, batch)].filter(Boolean).join('\n\n');
      const env = buildEnv({ ...parent, agentId, systemPrompt: prompt }, { batch: batch.id });
      try {
        const { message } = await runTurn(env, newSession(env), task.task);
        const content = message.content ?? '';
        env.memory.appendBoard({ from: agentId, kind: 'result', batch: batch.id, goal: task.task, content: content || '(no answer)' });
        return content;
      } catch (e) {
        env.memory.appendBoard({ from: agentId, kind: 'result', batch: batch.id, goal: task.task, content: `(failed) ${(e as Error).message}` });
        throw e;
      }
    },
  };
}

/** Tell a sub-agent who it is and who its siblings are, so it can coordinate via the board. */
function batchPrompt(parentId: string, self: string, batch: SubagentBatch): string {
  const siblings = batch.members.map((m) => `${parentId}.${m}`).filter((id) => id !== self);
  return [
    `Your agent id is "${self}" (batch ${batch.id}).`,
    siblings.length > 0
      ? `Sibling sub-agents working in parallel on related tasks: ${siblings.join(', ')}. ` +
        'Use read_board to see what they have posted (their final results appear there when they finish) and ' +
        'post_board to share findings or decisions they may need. Do not wait or poll repeatedly for them.'
      : 'You are the only sub-agent in this batch; post_board is still useful for leaving findings for later agents.',
  ].join(' ');
}
