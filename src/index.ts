#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

import { loadDotEnv, loadConfig, type ProviderKind } from './config.js';
import { buildEnv } from './env.js';
import { newMessages, runTurn, printHuman, type RunEnv } from './run.js';
import { runRepl } from './repl.js';
import { Transcript, writeEventTo, parseIncomingLine } from './jsonl.js';
import { strictInt } from './util.js';
import type { AgentEvent, Message } from './types.js';

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
  --resume               continue the last saved conversation (per --agent)
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

async function runJsonl(env: RunEnv, transcript: Transcript | null, messages: Message[]): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });

  const onEvent = (e: AgentEvent): void => {
    writeEventTo(process.stdout, e);
    transcript?.write(e);
  };

  for await (const line of rl) {
    const parsed = parseIncomingLine(line);
    if (parsed.kind === 'skip') continue;
    if (parsed.kind === 'reset') {
      messages = newMessages(env);
      continue;
    }
    if (parsed.kind === 'invalid') {
      onEvent({ type: 'error', message: parsed.error });
      continue;
    }
    try {
      await runTurn(env, messages, parsed.content, onEvent);
    } catch (e) {
      onEvent({ type: 'error', message: (e as Error).message });
    }
  }
  transcript?.close();
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

  // Start from the previous conversation when --resume is given (per-agent namespace).
  let messages: Message[];
  if (args.resume) {
    const loaded = env.memory.loadSession();
    if (loaded && loaded.length > 0) {
      messages = loaded;
      process.stderr.write(`[resume] restored ${loaded.length} previous messages\n`);
    } else {
      messages = newMessages(env);
      process.stderr.write('[resume] no previous session found; starting fresh\n');
    }
  } else {
    messages = newMessages(env);
  }

  if (args.jsonl) {
    const transcript = openTranscript(args, false);
    await runJsonl(env, transcript, messages);
    return;
  }

  const transcript = openTranscript(args, true);
  const onEvent = (e: AgentEvent): void => {
    printHuman(e);
    transcript?.write(e);
  };

  if (args.prompt !== undefined) {
    try {
      await runTurn(env, messages, args.prompt, onEvent);
    } catch (e) {
      printHuman({ type: 'error', message: (e as Error).message });
      process.exitCode = 1;
    }
    transcript?.close();
    return;
  }

  await runRepl(env, transcript, messages);
}

main().catch((e) => {
  console.error(`[fatal] ${(e as Error).message}`);
  process.exit(1);
});
