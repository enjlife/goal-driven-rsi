import type { ToolCall, ToolDef, ToolResult } from '../types.js';
import type { MemoryStore } from '../memory/store.js';
import type { SkillStore } from '../skills/store.js';
import { runShell } from './shell.js';
import { readFile, writeFile } from './files.js';
import { remember, recall } from './memory.js';
import { listSkills, readSkill, createSkill } from './skill.js';
import { readBoard, postBoard } from './board.js';
import { spawnAgents, MAX_SUBAGENT_TASKS, type SubagentRuntime } from './subagent.js';

export interface ToolContext {
  cwd: string;
  shellTimeoutMs: number;
  memory: MemoryStore;
  skills: SkillStore;
  /** Interactive user-input callback for the `ask_user` tool (undefined = unavailable). */
  askUser?: (question: string, options?: string[]) => Promise<string>;
  /** Sub-agent runtime for the `spawn_agents` tool (undefined = unavailable). */
  subagents?: SubagentRuntime;
  /** spawn_agents batch this agent runs in (sub-agents only); scopes the board tools. */
  batch?: string;
}

/** All tool definitions; `spawn_agents` is opt-in so sub-agents never see it. */
export function toolDefs(opts: { subagents?: boolean; askUser?: boolean } = {}): ToolDef[] {
  const defs = baseToolDefs().filter((d) => opts.askUser !== false || d.name !== 'ask_user');
  return opts.subagents ? [...defs, SPAWN_AGENTS_DEF] : defs;
}

const SPAWN_AGENTS_DEF: ToolDef = {
  name: 'spawn_agents',
  description:
    'Delegate independent sub-tasks to sub-agents that run in parallel, each in a fresh conversation with the same tools ' +
    '(except spawn_agents and ask_user). Returns each sub-agent\'s final answer. Use for work that splits cleanly ' +
    '(e.g. investigate several modules, try alternative approaches); do the work yourself for small or tightly coupled tasks. ' +
    'Sub-agents see nothing of this conversation, so each `task` must be self-contained.',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        maxItems: MAX_SUBAGENT_TASKS,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short role/name, e.g. "researcher"; also the sub-agent memory namespace.' },
            task: { type: 'string', description: 'Self-contained instructions, including all needed context and the expected output.' },
            system_prompt: { type: 'string', description: 'Optional role prompt for this sub-agent.' },
          },
          required: ['task'],
          additionalProperties: false,
        },
        description: `1-${MAX_SUBAGENT_TASKS} sub-tasks to run in parallel.`,
      },
    },
    required: ['tasks'],
    additionalProperties: false,
  },
};

function baseToolDefs(): ToolDef[] {
  return [
    {
      name: 'run_shell',
      description:
        'Run a single shell command in the working directory and return its stdout, stderr and exit code. ' +
        'Not interactive: no PTY, no state between calls.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
          timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file within the working directory and return its contents.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the working directory.' },
          max_bytes: { type: 'number', description: 'Optional size limit in bytes (default 1 MiB).' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 text file within the working directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the working directory.' },
          content: { type: 'string', description: 'File contents to write.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    {
      name: 'remember',
      description:
        'Record a long-term memory. scope "self" appends a curated insight to your own notes; ' +
        'scope "shared" appends cross-agent shared knowledge. Use for lessons learned, decisions, and reusable findings.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['self', 'shared'], description: 'self = your own insights; shared = shared knowledge.' },
          title: { type: 'string', description: 'Short title for the memory.' },
          content: { type: 'string', description: 'The memory content.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for search.' },
        },
        required: ['scope', 'title', 'content'],
        additionalProperties: false,
      },
    },
    {
      name: 'recall',
      description:
        'Search long-term memory across all agents\' insights, shared knowledge, and journals. ' +
        'Omit query to list your most recent journal entries (what you did recently).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms; omit to list recent entries.' },
          max_results: { type: 'number', description: 'Max results to return (default 5).' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'read_board',
      description:
        'Read the shared board where agents post findings and results. As a sub-agent, defaults to posts from your batch ' +
        '(your sibling sub-agents, including their final results once they finish); scope "all" reads the whole board.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Only posts by this agent (full id like "main.alpha", or just "alpha").' },
          scope: { type: 'string', enum: ['batch', 'all'], description: 'batch (default for sub-agents) or all.' },
          limit: { type: 'number', description: 'Max most-recent posts to return (default 20).' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'post_board',
      description:
        'Post an interim finding, decision or question to the shared board so other agents (e.g. sibling sub-agents working in parallel) can read it.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'What to share; make it understandable without your conversation.' },
        },
        required: ['content'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_skills',
      description:
        'List available reusable skills (name + one-line description). Use to discover skills before calling read_skill.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'read_skill',
      description: 'Read the full instructions of a skill by name so you can follow its procedure.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the skill to read.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    {
      name: 'create_skill',
      description:
        'Create (or overwrite) a reusable skill: a named procedure with a one-line description of when to use it, plus step-by-step instructions.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name (e.g. "report-issue").' },
          description: { type: 'string', description: 'One line: when to use this skill.' },
          content: { type: 'string', description: 'Step-by-step instructions / procedure.' },
        },
        required: ['name', 'description', 'content'],
        additionalProperties: false,
      },
    },
    {
      name: 'ask_user',
      description:
        'Ask the user a question to clarify the request. Use when the request is ambiguous or needs the user to pick a direction/option. ' +
        '`options` is an optional list of choices; the user can pick one, several (comma-separated), or type free text.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask the user.' },
          options: { type: 'array', items: { type: 'string' }, description: 'Optional choices to offer.' },
        },
        required: ['question'],
        additionalProperties: false,
      },
    },
  ];
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.arguments || '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('arguments must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(`invalid arguments for ${call.name}: ${(e as Error).message}`);
  }
}

export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  try {
    const args = parseArgs(call);
    switch (call.name) {
      case 'run_shell': {
        const command = typeof args.command === 'string' ? args.command : '';
        if (!command) throw new Error('missing "command"');
        const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : ctx.shellTimeoutMs;
        const r = await runShell(command, { cwd: ctx.cwd, timeoutMs });
        const parts: string[] = [];
        if (r.stdout) parts.push(`[stdout]\n${r.stdout.trimEnd()}`);
        if (r.stderr) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
        parts.push(r.timed_out ? '[timed out]' : `[exit ${r.exit_code}]`);
        const output = parts.join('\n');
        const failed = r.timed_out || r.exit_code !== 0;
        return failed ? { ok: false, error: output } : { ok: true, output };
      }
      case 'read_file': {
        const path = typeof args.path === 'string' ? args.path : '';
        if (!path) throw new Error('missing "path"');
        const maxBytes = typeof args.max_bytes === 'number' ? args.max_bytes : undefined;
        return { ok: true, output: readFile(path, ctx.cwd, maxBytes) };
      }
      case 'write_file': {
        const path = typeof args.path === 'string' ? args.path : '';
        const content = typeof args.content === 'string' ? args.content : '';
        if (!path) throw new Error('missing "path"');
        const target = writeFile(path, content, ctx.cwd);
        return { ok: true, output: `wrote ${target}` };
      }
      case 'remember':
        return remember(ctx.memory, args);
      case 'recall':
        return recall(ctx.memory, args);
      case 'read_board':
        return readBoard(ctx.memory, args, ctx.batch);
      case 'post_board':
        return postBoard(ctx.memory, args, ctx.batch);
      case 'list_skills':
        return listSkills(ctx.skills);
      case 'read_skill':
        return readSkill(ctx.skills, args);
      case 'create_skill':
        return createSkill(ctx.skills, args);
      case 'ask_user': {
        const question = typeof args.question === 'string' ? args.question.trim() : '';
        if (!question) return { ok: false, error: 'missing "question"' };
        const options = Array.isArray(args.options)
          ? args.options.filter((o): o is string => typeof o === 'string')
          : undefined;
        if (!ctx.askUser) return { ok: false, error: 'ask_user is not available in this (non-interactive) mode' };
        const answer = await ctx.askUser(question, options);
        return { ok: true, output: answer || '(no answer)' };
      }
      case 'spawn_agents':
        return spawnAgents(ctx.subagents, args);
      default:
        return { ok: false, error: `unknown tool: ${call.name}` };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
