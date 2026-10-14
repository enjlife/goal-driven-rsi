import type { Config } from './config.js';
import { createProvider } from './providers/provider.js';
import { toolDefs } from './tools/registry.js';
import { MemoryStore } from './memory/store.js';
import { SkillStore } from './skills/store.js';
import type { RunEnv } from './run.js';

/** Assemble a RunEnv (provider + tools + stores + loop options) from a Config. */
export function buildEnv(config: Config, opts: { noTools?: boolean } = {}): RunEnv {
  const provider = createProvider(config.provider, config);
  const tools = opts.noTools ? [] : toolDefs();
  const memory = new MemoryStore(config.memoryDir, config.agentId);
  const skills = new SkillStore(config.skillsDir);
  return {
    provider,
    tools,
    toolContext: { cwd: config.workdir, shellTimeoutMs: config.shellTimeoutMs, memory, skills },
    memory,
    maxTurns: config.maxTurns,
    maxContextTokens: config.maxContextTokens,
    maxToolResultChars: config.maxToolResultChars,
    systemPrompt: config.systemPrompt,
  };
}
