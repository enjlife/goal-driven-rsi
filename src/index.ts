#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

import { loadDotEnv, loadConfig, type ProviderKind } from './config.js';
import { buildEnv } from './env.js';
import { newSession, runTurn, printHuman, type RunEnv, type Session } from './run.js';
import { runRepl } from './repl.js';
import { Transcript, writeEventTo, parseIncomingLine } from './jsonl.js';
import { strictInt } from './util.js';
import type { AgentEvent } from './types.js';

const HELP = `goal-driven-rsi — minimal local terminal agent

Usage:
  agent                            interactive REPL
  agent -p "prompt"                one-shot (prints final answer to stdout)
  agent --jsonl                    JSONL protocol: read lines from stdin, emit events to stdout

Options:
  -p, --prompt <text>    run a single prompt and exit
  --jsonl                stdin/stdout JSONL line protocol
  --provider <name>      openai | anthropic | mock (default: auto-detect from keys)
  -m, --model <id>       model id override
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
      process.stderr.write(`[resume] restored session ${args.resumeId} (${messages.length} messages)\n`);
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
    process.stderr.write(`[resume] restored ${chosen.id}\n`);
    return { id: chosen.id, messages: env.memory.loadSession(chosen.id)! };
  }

  return newSession(env);
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = parseCli();
  if (args.help) {
    console.log(HELP);
    return;
  }

  const config = loadConfig({ provider: args.provider, model: args.model, maxTurns: args.maxTurns, agentId: args.agent });
  const env: RunEnv = buildEnv(config, { noTools: args.noTools });

  const session = await resolveSession(env, args);
  if (session === null) return; // user quit the resume picker

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

  await runRepl(env, transcript, session);
}

main().catch((e) => {
  console.error(`[fatal] ${(e as Error).message}`);
  process.exit(1);
});
