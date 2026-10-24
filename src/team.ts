import { resolve } from 'node:path';
import { loadDotEnv, type Config } from './config.js';
import { Agent, type AgentOptions } from './agent.js';
import { MemoryStore } from './memory/store.js';

export interface TeamMember {
  id: string;
  systemPrompt: string;
}

export interface TeamOptions {
  goal: string;
  members: TeamMember[];
  /** Discussion rounds after the initial propose (default 1). */
  maxRounds?: number;
  /** Shared provider/model/apiKey/... for every member; falls back to env. */
  base?: AgentOptions;
}

export interface Proposal {
  agentId: string;
  content: string;
}

export interface TeamResult {
  goal: string;
  proposals: Proposal[];
  review: string;
  boardPath: string;
}

/** Shared base config for a team/planner, derived from a resolved Config. */
export function teamBase(config: Config): AgentOptions {
  const model = config.provider === 'openai' ? config.openai.model : config.anthropic.model;
  return { provider: config.provider, model, memoryDir: config.memoryDir };
}

/**
 * A coordinator that spawns multiple sub-agents (each an `Agent` with its own
 * agentId but a shared memory root) to optimize toward a goal. Members propose in
 * parallel, discuss/refine for `maxRounds` rounds, a reviewer agent scores them,
 * and everything is written to the shared board so other agents can recall it.
 */
export class Team {
  private readonly goal: string;
  private readonly maxRounds: number;
  private readonly members: { member: TeamMember; agent: Agent }[];
  private readonly memory: MemoryStore;

  constructor(private readonly opts: TeamOptions) {
    loadDotEnv();
    this.goal = opts.goal;
    this.maxRounds = opts.maxRounds ?? 1;
    this.members = opts.members.map((m) => ({
      member: m,
      agent: new Agent({ ...(opts.base ?? {}), agentId: m.id, systemPrompt: m.systemPrompt }),
    }));
    const memoryDir = resolve(opts.base?.memoryDir || process.env.AGENT_MEMORY_DIR || 'memory');
    this.memory = new MemoryStore(memoryDir, 'orchestrator');
  }

  async run(): Promise<TeamResult> {
    let proposals = await this.round(undefined);

    for (let r = 0; r < this.maxRounds; r++) {
      proposals = await this.round(proposals);
    }

    const review = await this.review(proposals);

    for (const p of proposals) {
      this.memory.appendBoard({ from: p.agentId, kind: 'proposal', goal: this.goal, content: p.content });
    }
    this.memory.appendBoard({ from: 'reviewer', kind: 'review', goal: this.goal, content: review });

    return { goal: this.goal, proposals, review, boardPath: this.memory.boardPath() };
  }

  /** One round: run every member in parallel; `prior` drives the discuss prompt. */
  private async round(prior: Proposal[] | undefined): Promise<Proposal[]> {
    return Promise.all(
      this.members.map(async ({ member, agent }) => {
        const mine = prior?.find((p) => p.agentId === member.id)?.content ?? '';
        const others = prior?.filter((p) => p.agentId !== member.id) ?? [];
        const prompt = prior ? discussPrompt(this.goal, mine, others) : proposePrompt(this.goal);
        const { content } = await agent.run(prompt);
        return { agentId: member.id, content: content ?? '' };
      }),
    );
  }

  /** A dedicated reviewer agent scores and ranks the proposals. */
  private async review(proposals: Proposal[]): Promise<string> {
    const grader = new Agent({
      ...(this.opts.base ?? {}),
      agentId: 'reviewer',
      systemPrompt: '你是一位客观的评审专家，负责对多个方案打分并排序，并说明理由。',
    });
    const { content } = await grader.run(reviewPrompt(this.goal, proposals));
    return content ?? '';
  }
}

function proposePrompt(goal: string): string {
  return `目标：${goal}\n\n请提出你的解决方案。要求：1) 方案名称；2) 具体方案内容；3) 这样做的理由。`;
}

function discussPrompt(goal: string, mine: string, others: Proposal[]): string {
  const othersText = others.map((p) => `【${p.agentId}】\n${p.content}`).join('\n\n');
  return [
    `目标：${goal}`,
    '',
    '你上一轮的方案：',
    mine || '(无)',
    '',
    '其他成员的方案：',
    othersText,
    '',
    '请指出各方案的问题，并综合优点改进你自己的方案，输出最终方案。',
  ].join('\n');
}

function reviewPrompt(goal: string, proposals: Proposal[]): string {
  const list = proposals.map((p, i) => `方案${i + 1}（来自 ${p.agentId}）：\n${p.content}`).join('\n\n');
  return [
    `目标：${goal}`,
    '',
    '以下是各成员提出的方案：',
    list,
    '',
    '请给每个方案打分（1-10），按得分排序，说明每个方案的优缺点和最终推荐。',
  ].join('\n');
}

/**
 * Ask a planner agent to propose `count` candidate directions for a goal.
 * Returns the parsed list (best-effort; JSON array preferred, numbered lines as fallback).
 */
export async function planDirections(goal: string, count: number, base: AgentOptions = {}): Promise<string[]> {
  const planner = new Agent({
    ...base,
    agentId: 'planner',
    noTools: true,
    systemPrompt: '你是一个规划者。给定目标，提出若干个不同的可行方向/策略供选择。只输出 JSON 字符串数组。',
  });
  const prompt = `目标：${goal}\n\n请给出 ${count} 个不同的可行方向，每个用一句话概括。严格只输出 JSON 数组，例如 ["方向一", "方向二", "方向三"]。`;
  const { content } = await planner.run(prompt);
  return parseDirections(content ?? '');
}

/**
 * Ask a clarifier to propose candidate clarifications for ambiguous parts of a task.
 * Returns the parsed list (JSON array preferred; numbered lines fallback).
 */
export async function clarifyOptions(task: string, count: number, base: AgentOptions = {}): Promise<string[]> {
  const clarifier = new Agent({
    ...base,
    agentId: 'clarifier',
    noTools: true,
    systemPrompt: '你负责澄清需求。识别需求中模糊、需要用户确认的地方，给出候选的澄清方向。只输出 JSON 字符串数组。',
  });
  const prompt =
    `需求：${task}\n\n` +
    `这个需求有哪些模糊/需要确认的地方？请给出 ${count} 个候选的澄清方向（每个是一个可选的解释或方向，用一句话）。` +
    '严格只输出 JSON 数组，例如 ["方向一", "方向二", "方向三"]。';
  const { content } = await clarifier.run(prompt);
  return parseDirections(content ?? '');
}

/** Fan out one sub-agent per selected option, each implementing its option (parallel). */
export async function runFanOut(
  task: string,
  options: string[],
  base: AgentOptions = {},
): Promise<{ option: string; content: string }[]> {
  return Promise.all(
    options.map(async (option, i) => {
      const agent = new Agent({
        ...base,
        agentId: `worker-${i + 1}`,
        systemPrompt: '你是一个实现者。根据需求和选定方向，给出具体实现方案或产出。',
      });
      const { content } = await agent.run(`需求：${task}\n\n选定方向：${option}\n\n请实现这个方向，给出具体方案或产出。`);
      return { option, content: content ?? '' };
    }),
  );
}

/** Default role roster used when auto-planning a team without an explicit config. */
export const AUTO_PLAN_ROLES: TeamMember[] = [
  { id: 'strategist', systemPrompt: '你负责制定整体策略与方案。' },
  { id: 'implementer', systemPrompt: '你负责实现步骤与细节。' },
  { id: 'critic', systemPrompt: '你负责风险评审与质疑。' },
];

/** Run a team with the default roles, each anchored to the chosen direction. */
export async function runAutoTeam(goal: string, direction: string, base: AgentOptions, maxRounds = 1): Promise<TeamResult> {
  const members = AUTO_PLAN_ROLES.map((r) => ({ id: r.id, systemPrompt: `${r.systemPrompt}\n\n当前选定方向：${direction}` }));
  const team = new Team({ goal, members, maxRounds, base });
  return team.run();
}

export type PlanDecision = { mode: 'direct' } | { mode: 'plan'; directions: string[] };

/**
 * Auto-dispatch: ask a planner whether a task needs candidate directions.
 * Trivial/clear tasks return { mode: 'direct' }; otherwise return the directions.
 */
export async function planOrDirect(task: string, base: AgentOptions = {}): Promise<PlanDecision> {
  const planner = new Agent({
    ...base,
    agentId: 'planner',
    noTools: true,
    systemPrompt: '你是任务分派器。判断任务是否需要先提出多个方向供用户选择。只输出一个 JSON 对象。',
  });
  const prompt =
    `任务：${task}\n\n` +
    '如果任务明确、只有一个合理做法（简单问答、明确指令、单一操作），输出 {"direct":true}。\n' +
    '否则输出 {"direct":false,"directions":["方向1","方向2",...]}，给 2-4 个不同方向，每个用一句话。';
  const { content } = await planner.run(prompt);
  const obj = extractJsonObject(content ?? '');
  if (obj && obj.direct === true) return { mode: 'direct' };
  if (obj && Array.isArray(obj.directions) && obj.directions.every((d) => typeof d === 'string') && obj.directions.length > 0) {
    return { mode: 'plan', directions: obj.directions as string[] };
  }
  return { mode: 'direct' }; // fail-safe: just do it directly
}

function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function parseDirections(text: string): string[] {
  const trimmed = text.trim();
  const tryArr = (s: string): string[] | undefined => {
    try {
      const arr = JSON.parse(s) as unknown;
      if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) return arr as string[];
    } catch {
      // fall through
    }
    return undefined;
  };
  return tryArr(trimmed) ?? tryArr(trimmed.match(/\[[\s\S]*\]/)?.[0] ?? '') ?? numberedFallback(trimmed);
}

function numberedFallback(text: string): string[] {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\s*\d+[.)、]\s*/, '').trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : [text.trim()];
}
