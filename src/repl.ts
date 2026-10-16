import readline from 'node:readline';
import type { AgentEvent } from './types.js';
import { newSession, runTurn, printHuman, type RunEnv, type Session } from './run.js';
import type { Transcript } from './jsonl.js';

export async function runRepl(env: RunEnv, transcript: Transcript | null, initial: Session): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'agent> ' });
  rl.on('SIGINT', () => {
    // Ctrl+C on an empty line exits; otherwise it just cancels the current line.
    if ((rl.line ?? '').trim() === '') rl.close();
    else rl.write(null, { ctrl: true, name: 'u' });
  });
  let session = initial;

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
    if (trimmed === '/exit' || trimmed === '/quit' || trimmed === 'exit') {
      break;
    }
    if (trimmed === '/reset') {
      session = newSession(env);
      console.log('[reset] conversation cleared');
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
