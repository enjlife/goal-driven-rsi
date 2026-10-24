import { readSync } from 'node:fs';
import readline from 'node:readline';
import { highlightInput } from './tty.js';

function printQuestion(question: string, options?: string[]): void {
  process.stderr.write(`[ask_user] ${question}\n`);
  if (options && options.length > 0) {
    options.forEach((o, i) => process.stderr.write(`  ${i + 1}. ${o}\n`));
    process.stderr.write('  （可多选，逗号分隔；也可直接输入文本）\n');
  }
}

/**
 * Build an ask-user callback with its own readline (for one-shot `-p`, where stdin
 * is not otherwise being consumed).
 */
export function makeAskUser(): (question: string, options?: string[]) => Promise<string> {
  return (question, options) =>
    Promise.resolve().then(() => {
      printQuestion(question, options);
      process.stderr.write('> ');
      return readStdinLine();
    });
}

/** Synchronously read one line from stdin (works for both TTY and pipes). */
function readStdinLine(): string {
  const buf = Buffer.alloc(65536);
  let n = 0;
  try {
    n = readSync(0, buf, 0, buf.length, null);
  } catch {
    return '';
  }
  if (n <= 0) return '';
  return buf.subarray(0, n).toString('utf8').replace(/\r?\n$/, '');
}

/**
 * A single, persistent line reader over a readline interface. Both the REPL loop
 * and the ask_user tool read from it, so lines are never lost between listeners.
 */
export class LineReader {
  private queue: string[] = [];
  private waiters: { resolve: (line: string | null) => void; prompt?: string }[] = [];
  private closed = false;

  constructor(rl: readline.Interface) {
    rl.on('line', (line) => this.push(line));
    rl.on('close', () => {
      this.closed = true;
      while (this.waiters.length > 0) this.waiters.shift()!.resolve(null);
    });
  }

  private push(line: string): void {
    const w = this.waiters.shift();
    if (w) {
      if (w.prompt !== undefined && line.trim()) highlightInput(w.prompt, line);
      w.resolve(line);
    } else this.queue.push(line);
  }

  /**
   * Next line (or null once closed). Given the `prompt` shown before it, the
   * submitted line is repainted with a dark background (TTY only).
   */
  next(prompt?: string): Promise<string | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push({ resolve, prompt }));
  }
}

/** ask-user callback that reads through an existing LineReader (for the REPL). */
export function askUserVia(reader: LineReader): (question: string, options?: string[]) => Promise<string> {
  return async (question, options) => {
    printQuestion(question, options);
    process.stderr.write('> ');
    const answer = await reader.next('> ');
    return (answer ?? '').trim();
  };
}
