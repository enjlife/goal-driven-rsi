import readline from 'node:readline';
import type { AgentEvent } from './types.js';
import { newSession, runTurn, printHuman, type RunEnv, type Session } from './run.js';
import type { Transcript } from './jsonl.js';
import { clarifyOptions, runFanOut, teamBase } from './team.js';
import { loadConfig, loadModelCatalog, describeModel, type Config, type ConfigOverrides } from './config.js';
import { createProvider } from './providers/provider.js';
import { LineReader, askUserVia } from './ask.js';

const DIRECTION_COUNT = 3;

interface Pending {
  task: string;
  options: string[];
  mode: 'goal' | 'directions';
}

/** Parse a multi-select input ("1,3", "1 2", "1-3", "all") into 0-based indices; null = cancel. */
function parseSelection(input: string, max: number): number[] | null {
  const t = input.trim().toLowerCase();
  if (t === '' || t === 'q') return null;
  if (t === 'all' || t === 'a') return Array.from({ length: max }, (_, i) => i);
  const indices = new Set<number>();
  for (const part of t.split(/[,，\s]+/)) {
    if (!part) continue;
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
          if (i >= 1 && i <= max) indices.add(i - 1);
        }
      }
    } else {
      const n = Number(part);
      if (Number.isFinite(n) && n >= 1 && n <= max) indices.add(n - 1);
    }
  }
  return [...indices].sort((a, b) => a - b);
}

/** `/model` with no argument: list profiles, marking the active one. */
function printModelList(config: Config): void {
  const catalog = loadModelCatalog();
  const names = Object.keys(catalog.models);
  console.log(`当前模型：${describeModel(config)}`);
  if (names.length === 0) {
    console.log('(models.json 中没有模型配置)');
    return;
  }
  for (const name of names) {
    const p = catalog.models[name];
    const mark = name === config.modelName ? '>' : ' ';
    const def = name === catalog.default ? ' (default)' : '';
    console.log(`${mark} ${name}  ${p.provider}/${p.model}${def}`);
  }
  console.log('切换：/model <name>');
}

/**
 * Switch the session to another model profile in place. Provider-specific raw
 * blocks (e.g. Anthropic thinking signatures) are dropped, since another model
 * would reject them; the plain history is kept.
 */
function switchModel(env: RunEnv, session: Session, name: string, base: ConfigOverrides): Config {
  const known = Object.keys(loadModelCatalog().models);
  if (known.length > 0 && !known.includes(name)) {
    throw new Error(`未知模型 "${name}"，可选：${known.join(', ')}`);
  }
  const next = loadConfig({ ...base, model: name });
  env.provider = createProvider(next.provider, next);
  env.maxContextTokens = next.maxContextTokens;
  for (const m of session.messages) delete m.raw;
  return next;
}

export async function runRepl(
  env: RunEnv,
  transcript: Transcript | null,
  initial: Session,
  initialConfig: Config,
  overrides: ConfigOverrides = {},
): Promise<void> {
  let config = initialConfig;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'agent> ' });
  rl.on('SIGINT', () => {
    // Ctrl+C on an empty line exits; otherwise it just cancels the current line.
    if ((rl.line ?? '').trim() === '') rl.close();
    else rl.write(null, { ctrl: true, name: 'u' });
  });
  // A single reader for both the REPL loop and ask_user (no line is lost between them).
  const reader = new LineReader(rl);
  env.toolContext.askUser = askUserVia(reader);

  let session = initial;
  let pending: Pending | null = null;

  const onEvent = (e: AgentEvent): void => {
    printHuman(e);
    transcript?.write(e);
  };

  console.log('REPL. /goal <task> 澄清+多子agent · /directions <task> 选单个方向 · /model [name] 查看/切换模型 · /reset · /exit');
  rl.prompt();

  for (;;) {
    const line = await reader.next(rl.getPrompt());
    if (line === null) break;
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }

    // Resolve a pending direction choice.
    if (pending) {
      const { task, options, mode } = pending;
      if (trimmed === 'q' || trimmed === 'Q') {
        pending = null;
        console.log('[cancel]');
      } else if (mode === 'goal') {
        const sel = parseSelection(trimmed, options.length);
        pending = null;
        if (sel === null || sel.length === 0) {
          console.log('(未选择，取消)');
        } else {
          console.log(`选定 ${sel.length} 个方向，派发子 agent 并行实现...\n`);
          const results = await runFanOut(task, sel.map((i) => options[i]), teamBase(config));
          for (const r of results) {
            console.log(`### 方向：${r.option}\n${r.content}\n`);
          }
        }
      } else {
        const n = Number.parseInt(trimmed, 10);
        pending = null;
        if (trimmed === '0') {
          await runTurn(env, session, task, onEvent);
        } else {
          const idx = Number.isFinite(n) && n >= 1 && n <= options.length ? n - 1 : 0;
          const chosen = options[idx];
          console.log(`选定方向：${chosen}\n`);
          await runTurn(env, session, `选定方向：${chosen}\n\n${task}`, onEvent);
        }
      }
      rl.prompt();
      continue;
    }

    if (trimmed === '/exit' || trimmed === '/quit' || trimmed === 'exit') break;
    if (trimmed === '/reset') {
      session = newSession(env);
      console.log('[reset] conversation cleared');
      rl.prompt();
      continue;
    }

    if (trimmed === '/model' || trimmed.startsWith('/model ')) {
      const name = trimmed.slice('/model'.length).trim();
      try {
        if (!name) {
          printModelList(config);
        } else {
          config = switchModel(env, session, name, overrides);
          console.log(`[model] 已切换到 ${describeModel(config)}`);
        }
      } catch (e) {
        console.log(`[error] ${(e as Error).message}`);
      }
      rl.prompt();
      continue;
    }

    if (trimmed.startsWith('/goal ') || trimmed.startsWith('/directions ')) {
      const isGoal = trimmed.startsWith('/goal ');
      const task = trimmed.slice(isGoal ? '/goal '.length : '/directions '.length).trim();
      if (!task) {
        console.log('用法：/goal <task> 或 /directions <task>');
        rl.prompt();
        continue;
      }
      try {
        console.log('澄清需求...');
        const options = await clarifyOptions(task, DIRECTION_COUNT, teamBase(config));
        if (options.length === 0) {
          console.log('(未识别出模糊点，改为直接执行)');
          await runTurn(env, session, task, onEvent);
        } else if (isGoal) {
          console.log('方向候选（可多选，逗号分隔如 1,3；all 全选）：');
          options.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
          pending = { task, options, mode: 'goal' };
          console.log('选择 [1-N / all, q=取消]：');
        } else {
          console.log('方向候选：\n  0. 直接执行（不选方向）');
          options.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
          pending = { task, options, mode: 'directions' };
          console.log('选择方向 [0-N, q=取消]：');
        }
      } catch (e) {
        console.log(`[error] ${(e as Error).message}`);
      }
      rl.prompt();
      continue;
    }

    try {
      await runTurn(env, session, trimmed, onEvent);
    } catch (e) {
      const err = { type: 'error' as const, message: (e as Error).message };
      printHuman(err);
      transcript?.write(err);
    }
    rl.prompt();
  }

  rl.close();
}
