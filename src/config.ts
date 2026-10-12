import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type ProviderKind = 'openai' | 'anthropic' | 'mock';

export interface Config {
  provider: ProviderKind;
  workdir: string;
  maxTurns: number;
  shellTimeoutMs: number;
  systemPrompt: string;
  openai: { apiKey?: string; baseUrl: string; model: string };
  anthropic: { apiKey?: string; authToken?: string; baseUrl: string; model: string; maxTokens: number };
}

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful terminal agent. You have tools available to run shell commands and read/write files. ' +
  'Use a tool when it helps complete the user goal; otherwise answer directly. Be concise.';

/** Minimal .env loader (zero dependencies). Does not override already-set vars. */
export function loadDotEnv(path = '.env'): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // no .env file
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (val.length >= 2 && ((val[0] === '"' && val[val.length - 1] === '"') || (val[0] === "'" && val[val.length - 1] === "'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface ConfigOverrides {
  provider?: ProviderKind;
  model?: string;
  maxTurns?: number;
  noTools?: boolean;
}

/** Resolve provider: explicit flag > AGENT_PROVIDER > whichever key is set > error. */
function resolveProvider(override?: ProviderKind): ProviderKind {
  if (override) return override;
  const env = process.env.AGENT_PROVIDER;
  if (env === 'openai' || env === 'anthropic' || env === 'mock') return env;
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  throw new Error(
    'No provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or pass --provider mock.',
  );
}

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const provider = resolveProvider(overrides.provider);
  const workdirRaw = process.env.AGENT_WORKDIR;
  const openai = {
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: overrides.model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  };
  const anthropic = {
    apiKey: process.env.ANTHROPIC_API_KEY,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN,
    baseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/$/, ''),
    model: overrides.model || process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    maxTokens: intEnv('ANTHROPIC_MAX_TOKENS', 16000),
  };

  if (provider === 'openai' && !openai.apiKey) {
    throw new Error('provider "openai" selected but OPENAI_API_KEY is not set.');
  }
  if (provider === 'anthropic' && !anthropic.apiKey && !anthropic.authToken) {
    throw new Error('provider "anthropic" selected but ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN is not set.');
  }

  return {
    provider,
    workdir: workdirRaw ? resolve(workdirRaw) : process.cwd(),
    maxTurns: overrides.maxTurns ?? intEnv('AGENT_MAX_TURNS', 8),
    shellTimeoutMs: intEnv('AGENT_SHELL_TIMEOUT_MS', 30000),
    systemPrompt: process.env.AGENT_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
    openai,
    anthropic,
  };
}
