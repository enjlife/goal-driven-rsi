import readline from 'node:readline';
import type { AgentEvent } from './types.js';
import { newSession, runTurn, printHuman, type RunEnv, type Session } from './run.js';
import type { Transcript } from './jsonl.js';
import { planOrDirect, runAutoTeam, teamBase } from './team.js';
import type { Config } from './config.js';
import type { TeamResult } from './team.js';

function printTeam(result: TeamResult): void {
  console.log(`目标：${result.goal}\n`);
  for (const p of result.proposals) {
    console.log(`### ${p.agentId}\n${p.content}\n`);
  }
  console.log(`### 评审\n${result.review}\n`);
}

export async function runRepl(env: RunEnv, transcript: Transcript | null, initial: Session, config: Config): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'agent> ' });
  rl.on('SIGINT', () => {
    // Ctrl+C on an empty line exits; otherwise it just cancels the current line.
    if ((rl.line ?? '').trim() === '') rl.close();
    else rl.write(null, { ctrl: true, name: 'u' });
  });
  let session = initial;
  let pending: { task: string; directions: string[] } | null = null;

  const onEvent = (e: AgentEvent): void => {
    printHuman(e);
    transcript?.write(e);
  };

  console.log('Minimal agent REPL. Type a message, /reset to clear, /exit to quit.');
  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }

    // Resolve a pending direction choice (from auto-plan).
    if (pending) {
      const task = pending.task;
      if (trimmed === 'q' || trimmed === 'Q') {
        pending = null;
        console.log('[cancel]');
      } else if (trimmed === '0') {
        pending = null;
        await runTurn(env, session, task, onEvent);
      } else {
        const n = Number.parseInt(trimmed, 10);
        const idx = Number.isFinite(n) && n >= 1 && n <= pending.directions.length ? n - 1 : 0;
        const chosen = pending.directions[idx];
        pending = null;
        console.log(`选定方向：${chosen}\n`);
        printTeam(await runAutoTeam(task, chosen, teamBase(config)));
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

    try {
      if (config.autoPlan) {
        console.log('自动规划方向...');
        const decision = await planOrDirect(trimmed, teamBase(config));
        if (decision.mode === 'direct') {
          await runTurn(env, session, trimmed, onEvent);
        } else {
          console.log('方向候选：\n  0. 直接执行（不选方向）');
          decision.directions.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
          pending = { task: trimmed, directions: decision.directions };
          console.log('选择方向 [0-N, q=取消]：');
        }
      } else {
        await runTurn(env, session, trimmed, onEvent);
      }
    } catch (e) {
      const err = { type: 'error' as const, message: (e as Error).message };
      printHuman(err);
      transcript?.write(err);
    }
    rl.prompt();
  }

  rl.close();
}
