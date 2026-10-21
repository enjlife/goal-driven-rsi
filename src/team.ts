import { resolve } from 'node:path';
import { loadDotEnv } from './config.js';
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
