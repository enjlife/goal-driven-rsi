import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { strictInt } from './util.js';

export type ProviderKind = 'openai' | 'anthropic' | 'mock';

export interface Config {
  provider: ProviderKind;
  /** Name of the selected model profile from models.json (unset = env-only config). */
  modelName?: string;
  workdir: string;
  memoryDir: string;
  skillsDir: string;
  agentId: string;
  maxTurns: number;
  shellTimeoutMs: number;
  systemPrompt: string;
  retry: { maxRetries: number; baseMs: number };
  maxContextTokens: number;
  maxToolResultChars: number;
  openai: { apiKey?: string; baseUrl: string; model: string };
  anthropic: { apiKey?: string; authToken?: string; baseUrl: string; model: string; maxTokens: number };
}

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful terminal agent. You have tools available to run shell commands and read/write files. ' +
  'Use a tool when it helps complete the user goal; otherwise answer directly. Be concise. ' +
  'You also have long-term memory (remember/recall) and reusable skills (list_skills/read_skill/create_skill); use them when they help. ' +
  'If the request is ambiguous or needs the user to choose a direction, ask the user with the ask_user tool first, then continue; do not over-ask.';

/** Parse a `.env`-style file into a map (missing file -> empty map). */
function parseEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
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
    out[key] = val;
  }
  return out;
}

/** User-level config file (shared across all projects), or AGENT_CONFIG override. */
function userConfigEnvPath(): string {
  if (process.env.AGENT_CONFIG) return process.env.AGENT_CONFIG;
  return join(userConfigDir(), '.env');
}

/**
 * A named model profile from `models.json`. Unset fields fall back to the
 * provider's env settings (`*_BASE_URL`, `*_API_KEY`, ...). If the profile sets any
 * credential, the provider's env credentials are ignored.
 */
export interface ModelProfile {
  provider: ProviderKind;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** Read the API key from this env var instead of storing it in the file. */
  apiKeyEnv?: string;
  /** Anthropic only: bearer token (Authorization header) instead of x-api-key. */
  authToken?: string;
  authTokenEnv?: string;
  /** Anthropic only: max_tokens. */
  maxTokens?: number;
  maxContextTokens?: number;
}

export interface ModelCatalog {
  default?: string;
  models: Record<string, ModelProfile>;
  /** Files the catalog was read from (lowest precedence first). */
  sources: string[];
}

function userConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'goal-driven-rsi');
}

function parseProfile(name: string, raw: unknown, path: string): ModelProfile {
  const where = `${path}: model "${name}"`;
  if (!raw || typeof raw !== 'object') throw new Error(`${where} must be an object`);
  const r = raw as Record<string, unknown>;
  const provider = r.provider;
  if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'mock') {
    throw new Error(`${where} has invalid "provider" (expected openai|anthropic|mock)`);
  }
  const model = typeof r.model === 'string' ? r.model.trim() : '';
  if (!model && provider !== 'mock') throw new Error(`${where} missing "model"`);
  const str = (k: string): string | undefined => {
    if (r[k] === undefined) return undefined;
    if (typeof r[k] !== 'string') throw new Error(`${where}: "${k}" must be a string`);
    return r[k] as string;
  };
  const int = (k: string): number | undefined => {
    if (r[k] === undefined) return undefined;
    if (!Number.isInteger(r[k]) || (r[k] as number) < 1) throw new Error(`${where}: "${k}" must be a positive integer`);
    return r[k] as number;
  };
  return {
    provider,
    model: model || 'mock',
    baseUrl: str('baseUrl'),
    apiKey: str('apiKey'),
    apiKeyEnv: str('apiKeyEnv'),
    authToken: str('authToken'),
    authTokenEnv: str('authTokenEnv'),
    maxTokens: int('maxTokens'),
    maxContextTokens: int('maxContextTokens'),
  };
}

/**
 * Load model profiles. `AGENT_MODELS_FILE` names a single file; otherwise the user
 * file `~/.config/goal-driven-rsi/models.json` and project `./models.json` are merged
 * by name (project wins, including its `default`). Missing files are skipped.
 */
export function loadModelCatalog(): ModelCatalog {
  const paths = process.env.AGENT_MODELS_FILE
    ? [resolve(process.env.AGENT_MODELS_FILE)]
    : [join(userConfigDir(), 'models.json'), resolve('models.json')];
  const catalog: ModelCatalog = { models: {}, sources: [] };
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      if (process.env.AGENT_MODELS_FILE) throw new Error(`AGENT_MODELS_FILE not readable: ${path}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(`invalid ${path}: ${(e as Error).message}`);
    }
    const c = (parsed ?? {}) as Record<string, unknown>;
    if (!c.models || typeof c.models !== 'object') throw new Error(`${path} missing "models" object`);
    for (const [name, raw] of Object.entries(c.models as Record<string, unknown>)) {
      catalog.models[name] = parseProfile(name, raw, path);
    }
    if (c.default !== undefined) {
      if (typeof c.default !== 'string') throw new Error(`${path}: "default" must be a string`);
      catalog.default = c.default;
    }
    catalog.sources.push(path);
  }
  if (catalog.default !== undefined && !catalog.models[catalog.default]) {
    throw new Error(`default model "${catalog.default}" is not defined in ${catalog.sources.join(', ')}`);
  }
  return catalog;
}

/** Read a credential from the profile itself or the env var it names. */
function profileSecret(value: string | undefined, envName: string | undefined, label: string): string | undefined {
  if (value) return value;
  if (!envName) return undefined;
  const v = process.env[envName];
  if (!v) throw new Error(`model profile ${label} reads ${envName}, but it is not set.`);
  return v;
}

/**
 * Minimal `.env` loader (zero dependencies). Precedence (highest first):
 * already-exported env vars > project `./.env` > user config `~/.config/goal-driven-rsi/.env`.
 */
export function loadDotEnv(path = '.env'): void {
  const user = parseEnvFile(userConfigEnvPath());
  const project = parseEnvFile(path);
  for (const [key, val] of Object.entries({ ...user, ...project })) {
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/** Read an integer env var; unset/empty falls back, otherwise must be a valid int >= min. */
function intEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return strictInt(raw.trim(), name, min);
}

export interface ConfigOverrides {
  provider?: ProviderKind;
  /** A model profile name from models.json, or a raw model id. */
  model?: string;
  maxTurns?: number;
  agentId?: string;
  noTools?: boolean;
  apiKey?: string;
  baseUrl?: string;
  workdir?: string;
  memoryDir?: string;
  skillsDir?: string;
  systemPrompt?: string;
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

/**
 * Pick the model profile: explicit `model` override (if it names a profile) >
 * `AGENT_MODEL` > the catalog default (only when no provider was forced).
 * An override that is not a profile name is treated as a raw model id.
 */
function selectProfile(catalog: ModelCatalog, overrides: ConfigOverrides): { name: string; profile: ModelProfile } | undefined {
  if (overrides.model !== undefined) {
    const profile = catalog.models[overrides.model];
    return profile ? { name: overrides.model, profile } : undefined;
  }
  const envName = process.env.AGENT_MODEL?.trim();
  if (envName) {
    const profile = catalog.models[envName];
    if (!profile) throw new Error(`AGENT_MODEL "${envName}" is not a model profile (${Object.keys(catalog.models).join(', ') || 'no models.json'})`);
    return { name: envName, profile };
  }
  if (catalog.default !== undefined && !overrides.provider) {
    return { name: catalog.default, profile: catalog.models[catalog.default] };
  }
  return undefined;
}

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const selected = selectProfile(loadModelCatalog(), overrides);
  const profile = selected?.profile;
  if (profile && overrides.provider && overrides.provider !== profile.provider) {
    throw new Error(`model "${selected!.name}" uses provider "${profile.provider}", not "${overrides.provider}"`);
  }
  const provider = profile?.provider ?? resolveProvider(overrides.provider);
  const modelId = profile ? profile.model : overrides.model;
  const workdirRaw = process.env.AGENT_WORKDIR;
  const openai = {
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: modelId || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  };
  const anthropic = {
    apiKey: process.env.ANTHROPIC_API_KEY,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN,
    baseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/$/, ''),
    model: modelId || process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    maxTokens: intEnv('ANTHROPIC_MAX_TOKENS', 16000, 1),
  };

  // A profile overrides the env settings of its provider.
  if (profile) {
    const label = `"${selected!.name}"`;
    const apiKey = profileSecret(profile.apiKey, profile.apiKeyEnv, label);
    const authToken = profileSecret(profile.authToken, profile.authTokenEnv, label);
    const baseUrl = profile.baseUrl?.replace(/\/$/, '');
    if (provider === 'openai') {
      if (apiKey) openai.apiKey = apiKey;
      if (baseUrl) openai.baseUrl = baseUrl;
    } else if (provider === 'anthropic') {
      if (apiKey || authToken) {
        anthropic.apiKey = apiKey;
        anthropic.authToken = authToken;
      }
      if (baseUrl) anthropic.baseUrl = baseUrl;
      if (profile.maxTokens) anthropic.maxTokens = profile.maxTokens;
    }
  }

  // Programmatic overrides take precedence over env (applied before validation).
  if (overrides.apiKey) {
    if (provider === 'openai') openai.apiKey = overrides.apiKey;
    else if (provider === 'anthropic') anthropic.apiKey = overrides.apiKey;
  }
  if (overrides.baseUrl) {
    const url = overrides.baseUrl.replace(/\/$/, '');
    if (provider === 'openai') openai.baseUrl = url;
    else if (provider === 'anthropic') anthropic.baseUrl = url;
  }

  if (provider === 'openai' && !openai.apiKey) {
    throw new Error('provider "openai" selected but OPENAI_API_KEY is not set.');
  }
  if (provider === 'anthropic' && !anthropic.apiKey && !anthropic.authToken) {
    throw new Error('provider "anthropic" selected but ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN is not set.');
  }

  return {
    provider,
    modelName: selected?.name,
    workdir: overrides.workdir ? resolve(overrides.workdir) : workdirRaw ? resolve(workdirRaw) : process.cwd(),
    memoryDir: resolve(overrides.memoryDir || process.env.AGENT_MEMORY_DIR || 'memory'),
    skillsDir: resolve(overrides.skillsDir || process.env.AGENT_SKILLS_DIR || 'skills'),
    agentId: overrides.agentId || process.env.AGENT_ID || 'main',
    maxTurns: overrides.maxTurns ?? intEnv('AGENT_MAX_TURNS', 50, 1),
    shellTimeoutMs: intEnv('AGENT_SHELL_TIMEOUT_MS', 30000, 1),
    systemPrompt: overrides.systemPrompt || process.env.AGENT_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
    retry: {
      maxRetries: intEnv('AGENT_MAX_RETRIES', 3, 0),
      baseMs: intEnv('AGENT_RETRY_BASE_MS', 1000, 0),
    },
    maxContextTokens: profile?.maxContextTokens ?? intEnv('AGENT_MAX_CONTEXT_TOKENS', 128000, 1),
    maxToolResultChars: intEnv('AGENT_MAX_TOOL_RESULT_CHARS', 8000, 1),
    openai,
    anthropic,
  };
}

/** The model id actually sent to the provider. */
export function activeModelId(config: Config): string {
  if (config.provider === 'openai') return config.openai.model;
  if (config.provider === 'anthropic') return config.anthropic.model;
  return 'mock';
}

/** Human-readable label for the active model, e.g. `opus (anthropic/claude-opus-5-5)`. */
export function describeModel(config: Config): string {
  const id = `${config.provider}/${activeModelId(config)}`;
  return config.modelName ? `${config.modelName} (${id})` : id;
}
