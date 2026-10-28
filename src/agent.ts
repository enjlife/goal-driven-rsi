import { loadDotEnv, loadConfig, type ConfigOverrides, type ProviderKind } from './config.js';
import { buildEnv } from './env.js';
import { newSession, runTurn, type RunEnv } from './run.js';
import type { AgentEvent, Message } from './types.js';

export type { ProviderKind } from './config.js';
export type { AgentEvent, Message, ToolCall, ToolDef } from './types.js';
export { Team, planDirections, planOrDirect, clarifyOptions, runFanOut, runAutoTeam, AUTO_PLAN_ROLES, type TeamOptions, type TeamMember, type TeamResult, type Proposal, type PlanDecision } from './team.js';

/** Programmatic options; unset fields fall back to env vars / defaults. */
export interface AgentOptions extends ConfigOverrides {}

export interface RunResult {
  content: string | null;
  turns: number;
  /** Set when the agent stopped early (soft step budget or a tool-call loop). */
  stopped?: 'max_turns' | 'loop';
}

/** A saved-session summary, for listing and resuming. */
export interface SessionInfo {
  id: string;
  preview: string;
}

/** A library entry point: construct once, then `run()` one-shot prompts. */
export class Agent {
  private readonly env: RunEnv;

  constructor(options: AgentOptions = {}) {
    loadDotEnv();
    this.env = buildEnv(loadConfig(options), { noTools: options.noTools ?? false });
  }

  /** Run a single prompt to completion in a fresh conversation. */
  async run(prompt: string, onEvent?: (e: AgentEvent) => void): Promise<RunResult> {
    const { message, turns, stopped } = await runTurn(this.env, newSession(this.env), prompt, onEvent);
    return { content: message.content, turns, stopped };
  }

  /** Start a stateful multi-turn conversation. */
  session(): Session {
    return Session.start(this.env);
  }

  /** List saved sessions (newest first). */
  listSessions(): SessionInfo[] {
    return this.env.memory.listSessions();
  }

  /** Resume a saved session by id; undefined if it does not exist. */
  resume(id: string): Session | undefined {
    return Session.resume(this.env, id);
  }
}

/** A stateful, named conversation; `ask()` keeps context across calls. */
export class Session {
  private constructor(
    private readonly env: RunEnv,
    readonly id: string,
    private readonly messages: Message[],
    private readonly history: Message[],
  ) {}

  static start(env: RunEnv, id?: string): Session {
    const s = newSession(env, id);
    return new Session(env, s.id, s.messages, s.history);
  }

  static resume(env: RunEnv, id: string): Session | undefined {
    const saved = env.memory.loadSession(id);
    return saved ? new Session(env, id, saved.messages, saved.history) : undefined;
  }

  async ask(content: string, onEvent?: (e: AgentEvent) => void): Promise<RunResult> {
    const session = { id: this.id, messages: this.messages, history: this.history };
    const { message, turns, stopped } = await runTurn(this.env, session, content, onEvent);
    return { content: message.content, turns, stopped };
  }
}
