import { loadDotEnv, loadConfig, type ConfigOverrides, type ProviderKind } from './config.js';
import { buildEnv } from './env.js';
import { newMessages, runTurn, type RunEnv } from './run.js';
import type { AgentEvent, Message } from './types.js';

export type { ProviderKind } from './config.js';
export type { AgentEvent, Message, ToolCall, ToolDef } from './types.js';

/** Programmatic options; unset fields fall back to env vars / defaults. */
export interface AgentOptions extends ConfigOverrides {}

export interface RunResult {
  content: string | null;
  turns: number;
  /** Set when the agent stopped early (soft step budget or a tool-call loop). */
  stopped?: 'max_turns' | 'loop';
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
    const { message, turns, stopped } = await runTurn(this.env, newMessages(this.env), prompt, onEvent);
    return { content: message.content, turns, stopped };
  }

  /** Start a stateful multi-turn conversation. */
  session(): Session {
    return new Session(this.env, newMessages(this.env));
  }
}

/** A stateful conversation; `ask()` keeps context across calls. */
export class Session {
  constructor(
    private readonly env: RunEnv,
    private readonly messages: Message[],
  ) {}

  async ask(content: string, onEvent?: (e: AgentEvent) => void): Promise<RunResult> {
    const { message, turns, stopped } = await runTurn(this.env, this.messages, content, onEvent);
    return { content: message.content, turns, stopped };
  }
}
