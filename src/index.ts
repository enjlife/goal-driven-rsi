#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

import { loadDotEnv, loadConfig, loadModelCatalog, describeModel, type ProviderKind } from './config.js';
import { buildEnv } from './env.js';
import { newSession, runTurn, printHuman, type RunEnv, type Session } from './run.js';
import { runRepl } from './repl.js';
import { Transcript, writeEventTo, parseIncomingLine } from './jsonl.js';
import { Team, planDirections, type TeamResult } from './team.js';
import type { AgentOptions } from './agent.js';
import { makeAskUser } from './ask.js';
import { strictInt, truncate } from './util.js';
import type { AgentEvent, Message } from './types.js';

const HELP = `goal-driven-rsi — minimal local terminal agent

Usage:
  agent                            interactive REPL
  agent -p "prompt"                one-shot (prints final answer to stdout)
  agent --jsonl                    JSONL protocol: read lines from stdin, emit events to stdout
  agent --team team.json           run a team of sub-agents toward a goal
  agent --plan plan.json           plan directions, pick one, then run a team

Options:
  -p, --prompt <text>    run a single prompt and exit
  --jsonl                stdin/stdout JSONL line protocol
  --team <config.json>   run a multi-agent team (goal + members defined in the JSON)
  --plan <config.json>   plan directions -> choose one -> allocate a team (goal + roles)
  --direction <n>        with --plan: pick the n-th direction (1-based, non-interactive)
  --provider <name>      openai | anthropic | mock (default: auto-detect from keys)
  -m, --model <name>     model profile from models.json, or a raw model id
                         (default: models.json "default", else env settings)
  --models               list model profiles from models.json and exit
  --max-turns <n>        max model<->tool round-trips per turn (default 50; soft limit)
  --agent <id>           agent identity for long-term memory (default: main)
  --no-tools             disable tool calling (pure chat)
  --session <path>       transcript JSONL path (default: sessions/<timestamp>.jsonl in human modes)
  --no-session           disable transcript
  --resume               list saved sessions and pick one to continue (per --agent)
  --resume-id <id>       resume a specific saved session by id
  -h, --help             show this help

JSONL protocol (stdin, one JSON object per line):
  {"content":"..."}      user message -> runs the agent
  {"reset":true}         clear conversation state
Events are emitted to stdout, one JSON object per line with a "type" field.`;

interface CliArgs {
  prompt?: string;
  jsonl: boolean;
  provider?: ProviderKind;
  model?: string;
  maxTurns?: number;
  agent?: string;
  noTools: boolean;
  session?: string;
  noSession: boolean;
  resume: boolean;
  resumeId?: string;
  team?: string;
  plan?: string;
  direction?: string;
  models: boolean;
  help: boolean;
}

function parseCli(): CliArgs {
  const { values } = parseArgs({
    options: {
      prompt: { type: 'string', short: 'p' },
      jsonl: { type: 'boolean' },
      provider: { type: 'string' },
      model: { type: 'string', short: 'm' },
      'max-turns': { type: 'string' },
      agent: { type: 'string' },
      'no-tools': { type: 'boolean' },
      session: { type: 'string' },
      'no-session': { type: 'boolean' },
      resume: { type: 'boolean' },
      'resume-id': { type: 'string' },
      team: { type: 'string' },
      plan: { type: 'string' },
      direction: { type: 'string' },
      models: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const provider = values.provider as ProviderKind | undefined;
  if (provider && provider !== 'openai' && provider !== 'anthropic' && provider !== 'mock') {
    throw new Error(`unknown --provider "${provider}" (expected openai|anthropic|mock)`);
  }
  const maxTurns = values['max-turns'] !== undefined
    ? strictInt(values['max-turns'] as string, '--max-turns', 1)
    : undefined;

  return {
    prompt: values.prompt as string | undefined,
    jsonl: values.jsonl === true,
    provider,
    model: values.model as string | undefined,
    maxTurns,
    agent: values.agent as string | undefined,
    noTools: values['no-tools'] === true,
    session: values.session as string | undefined,
    noSession: values['no-session'] === true,
    resume: values.resume === true,
    resumeId: values['resume-id'] as string | undefined,
    team: values.team as string | undefined,
    plan: values.plan as string | undefined,
    direction: values.direction as string | undefined,
    models: values.models === true,
    help: values.help === true,
  };
}

function defaultTranscriptPath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return join('sessions', `${ts}.jsonl`);
}

function openTranscript(args: CliArgs, humanMode: boolean): Transcript | null {
  if (args.noSession) return null;
  const path = args.session ?? (humanMode ? defaultTranscriptPath() : null);
  if (!path) return null;
  mkdirSync(dirname(path), { recursive: true });
  return new Transcript(path);
}

async function runJsonl(env: RunEnv, transcript: Transcript | null, initial: Session): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  let session = initial;

  const onEvent = (e: AgentEvent): void => {
    writeEventTo(process.stdout, e);
    transcript?.write(e);
  };

  for await (const line of rl) {
    const parsed = parseIncomingLine(line);
    if (parsed.kind === 'skip') continue;
    if (parsed.kind === 'reset') {
      session = newSession(env);
      continue;
    }
    if (parsed.kind === 'invalid') {
      onEvent({ type: 'error', message: parsed.error });
      continue;
    }
    try {
      await runTurn(env, session, parsed.content, onEvent);
    } catch (e) {
      onEvent({ type: 'error', message: (e as Error).message });
    }
  }
  transcript?.close();
}

/** A short recap of the most recent turns, for showing what a resume continues from. */
function recap(messages: Message[], maxTurns = 3): string {
  let start = 0;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && ++count === maxTurns) {
      start = i;
      break;
    }
  }
  const lines: string[] = [];
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'system' || m.role === 'tool') continue;
    if (m.role === 'user') {
      lines.push(`> ${truncate(m.content ?? '', 120)}`);
    } else if (m.tool_calls && m.tool_calls.length > 0 && !m.content) {
      lines.push(`  [tools: ${m.tool_calls.map((t) => t.name).join(', ')}]`);
    } else if (m.content) {
      lines.push(`  ${truncate(m.content.replace(/\s+/g, ' ').trim(), 120)}`);
    }
  }
  return lines.join('\n');
}

/** Interactively pick a session index; non-TTY resumes the latest (0). */
async function pickSession(count: number): Promise<number | null> {
  if (!process.stdin.isTTY) return 0;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`resume which? [1-${count}, Enter = latest, q = quit] `, resolve);
    });
    const t = answer.trim();
    if (t === 'q' || t === 'Q') return null;
    if (t === '') return 0;
    const n = Number.parseInt(t, 10);
    return Number.isFinite(n) && n >= 1 && n <= count ? n - 1 : 0;
  } finally {
    rl.close();
  }
}

/** Resolve the starting session from --resume / --resume-id (or a fresh one). */
async function resolveSession(env: RunEnv, args: CliArgs): Promise<Session | null> {
  if (args.resumeId) {
    const messages = env.memory.loadSession(args.resumeId);
    if (messages) {
      process.stderr.write(`[resume] restored session ${args.resumeId} (${messages.length} messages)\n${recap(messages)}\n`);
      return { id: args.resumeId, messages };
    }
    process.stderr.write(`[resume] session not found: ${args.resumeId}; starting fresh\n`);
    return newSession(env);
  }

  if (args.resume) {
    const sessions = env.memory.listSessions();
    if (sessions.length === 0) {
      process.stderr.write('[resume] no saved sessions; starting fresh\n');
      return newSession(env);
    }
    for (let i = 0; i < sessions.length; i++) {
      process.stderr.write(`  ${i + 1}. ${sessions[i].id}  ${sessions[i].preview}\n`);
    }
    const pick = await pickSession(sessions.length);
    if (pick === null) return null;
    const chosen = sessions[pick];
    const messages = env.memory.loadSession(chosen.id)!;
    process.stderr.write(`[resume] restored ${chosen.id}\n${recap(messages)}\n`);
    return { id: chosen.id, messages };
  }

  return newSession(env);
}

interface TeamConfig {
  goal: string;
  members: { id: string; systemPrompt: string }[];
  maxRounds?: number;
}

function parseTeamConfig(path: string): TeamConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`invalid team config: ${(e as Error).message}`);
  }
  const c = parsed as Record<string, unknown>;
  const goal = typeof c.goal === 'string' ? c.goal.trim() : '';
  if (!goal) throw new Error('team config missing "goal"');
  if (!Array.isArray(c.members) || c.members.length === 0) throw new Error('team config missing "members"');
  const members = c.members.map((m) => {
    const mm = m as Record<string, unknown>;
    const id = typeof mm.id === 'string' ? mm.id.trim() : '';
    const systemPrompt = typeof mm.systemPrompt === 'string' ? mm.systemPrompt.trim() : '';
    if (!id || !systemPrompt) throw new Error('each team member needs "id" and "systemPrompt"');
    return { id, systemPrompt };
  });
  return { goal, members, maxRounds: typeof c.maxRounds === 'number' ? c.maxRounds : undefined };
}

function printTeamResult(result: TeamResult): void {
  console.log(`目标：${result.goal}\n`);
  for (const p of result.proposals) {
    console.log(`### ${p.agentId}\n${p.content}\n`);
  }
  console.log(`### 评审\n${result.review}\n`);
  console.log(`[board] ${result.boardPath}`);
}

async function runTeam(args: CliArgs): Promise<void> {
  const config = parseTeamConfig(args.team!);
  const team = new Team({
    goal: config.goal,
    members: config.members,
    maxRounds: config.maxRounds,
    base: { provider: args.provider, model: args.model },
  });
  printTeamResult(await team.run());
}

interface PlanConfig {
  goal: string;
  directions: number;
  maxRounds?: number;
  roles: { id: string; systemPrompt: string }[];
  base: AgentOptions;
}

function parsePlanConfig(path: string): PlanConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`invalid plan config: ${(e as Error).message}`);
  }
  const c = parsed as Record<string, unknown>;
  const goal = typeof c.goal === 'string' ? c.goal.trim() : '';
  if (!goal) throw new Error('plan config missing "goal"');
  if (!Array.isArray(c.roles) || c.roles.length === 0) throw new Error('plan config missing "roles"');
  const roles = c.roles.map((r) => {
    const rr = r as Record<string, unknown>;
    const id = typeof rr.id === 'string' ? rr.id.trim() : '';
    const systemPrompt = typeof rr.systemPrompt === 'string' ? rr.systemPrompt.trim() : '';
    if (!id || !systemPrompt) throw new Error('each role needs "id" and "systemPrompt"');
    return { id, systemPrompt };
  });
  return {
    goal,
    directions: typeof c.directions === 'number' && c.directions >= 1 ? Math.floor(c.directions) : 3,
    maxRounds: typeof c.maxRounds === 'number' ? c.maxRounds : undefined,
    roles,
    base: (c.base && typeof c.base === 'object' ? c.base : {}) as AgentOptions,
  };
}

/** Print a numbered list and prompt the user to pick one; non-TTY picks the first. */
async function choose(options: string[], question: string): Promise<number | null> {
  for (let i = 0; i < options.length; i++) process.stderr.write(`  ${i + 1}. ${options[i]}\n`);
  if (!process.stdin.isTTY) return 0;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    const t = answer.trim();
    if (t === 'q' || t === 'Q') return null;
    if (t === '') return 0;
    const n = Number.parseInt(t, 10);
    return Number.isFinite(n) && n >= 1 && n <= options.length ? n - 1 : 0;
  } finally {
    rl.close();
  }
}

async function runPlan(args: CliArgs): Promise<void> {
  const config = parsePlanConfig(args.plan!);
  const base: AgentOptions = { ...config.base };
  if (args.provider) base.provider = args.provider;
  if (args.model) base.model = args.model;

  process.stderr.write('规划方向候选...\n');
  const directions = await planDirections(config.goal, config.directions, base);
  if (directions.length === 0) throw new Error('planner returned no directions');

  let chosen: string;
  if (args.direction !== undefined) {
    const n = Number.parseInt(args.direction, 10);
    chosen = directions[Number.isFinite(n) ? n - 1 : 0] ?? directions[0];
  } else {
    process.stderr.write('方向候选：\n');
    const idx = await choose(directions, '选择方向 [1-N, Enter=第一个, q=退出]: ');
    if (idx === null) return;
    chosen = directions[idx];
  }
  process.stderr.write(`选定方向：${chosen}\n\n`);

  const members = config.roles.map((r) => ({ id: r.id, systemPrompt: `${r.systemPrompt}\n\n当前选定方向：${chosen}` }));
  const team = new Team({ goal: config.goal, members, maxRounds: config.maxRounds, base });
  printTeamResult(await team.run());
}

function printModels(): void {
  const catalog = loadModelCatalog();
  const names = Object.keys(catalog.models);
  if (names.length === 0) {
    console.log('(no model profiles; create models.json — see models.example.json)');
    return;
  }
  for (const name of names) {
    const p = catalog.models[name];
    const mark = name === catalog.default ? '*' : ' ';
    console.log(`${mark} ${name}  ${p.provider}/${p.model}${p.baseUrl ? `  ${p.baseUrl}` : ''}`);
  }
  console.log(`\n(* = default) from ${catalog.sources.join(', ')}`);
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = parseCli();
  if (args.help) {
    console.log(HELP);
    return;
  }

  if (args.models) {
    printModels();
    return;
  }

  if (args.team) {
    await runTeam(args);
    return;
  }

  if (args.plan) {
    await runPlan(args);
    return;
  }

  const config = loadConfig({ provider: args.provider, model: args.model, maxTurns: args.maxTurns, agentId: args.agent });
  const env: RunEnv = buildEnv(config, { noTools: args.noTools });
  if (args.prompt !== undefined) {
    // one-shot mode: ask_user reads from stdin (the REPL wires its own readline)
    env.toolContext.askUser = makeAskUser();
  }

  const session = await resolveSession(env, args);
  if (session === null) return; // user quit the resume picker
  // Resuming with an explicit model: the saved raw blocks may belong to another model.
  if (args.model) for (const m of session.messages) delete m.raw;
  if (!args.jsonl) process.stderr.write(`[model] ${describeModel(config)}\n`);

  if (args.jsonl) {
    const transcript = openTranscript(args, false);
    await runJsonl(env, transcript, session);
    return;
  }

  const transcript = openTranscript(args, true);
  const onEvent = (e: AgentEvent): void => {
    printHuman(e);
    transcript?.write(e);
  };

  if (args.prompt !== undefined) {
    try {
      await runTurn(env, session, args.prompt, onEvent);
    } catch (e) {
      printHuman({ type: 'error', message: (e as Error).message });
      process.exitCode = 1;
    }
    transcript?.close();
    return;
  }

  await runRepl(env, transcript, session, config, { maxTurns: args.maxTurns, agentId: args.agent });
}

main().catch((e) => {
  console.error(`[fatal] ${(e as Error).message}`);
  process.exit(1);
});
