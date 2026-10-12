import { createWriteStream, type WriteStream } from 'node:fs';
import type { AgentEvent } from './types.js';

/** Serialize one event as a single JSON line with a timestamp. */
export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify({ ts: new Date().toISOString(), ...e });
}

/** Append-only JSONL transcript writer backed by a file. */
export class Transcript {
  private stream: WriteStream;

  constructor(path: string) {
    this.stream = createWriteStream(path, { flags: 'a' });
  }

  write(e: AgentEvent): void {
    this.stream.write(encodeEvent(e) + '\n');
  }

  close(): void {
    this.stream.end();
  }
}

/** Write one event to a stream as a JSON line (for the stdout JSONL protocol). */
export function writeEventTo(stream: NodeJS.WritableStream, e: AgentEvent): void {
  stream.write(encodeEvent(e) + '\n');
}

/**
 * Parse one line of the stdin JSONL protocol. Returns a user message, a reset
 * signal, or null to skip blank lines.
 */
export function parseIncomingLine(line: string):
  | { kind: 'user'; content: string }
  | { kind: 'reset' }
  | { kind: 'invalid'; error: string }
  | { kind: 'skip' } {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'skip' };
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { kind: 'invalid', error: 'line is not valid JSON' };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { kind: 'invalid', error: 'line must be a JSON object' };
  }
  const o = obj as Record<string, unknown>;
  if (o.reset === true) return { kind: 'reset' };
  if (typeof o.content === 'string') return { kind: 'user', content: o.content };
  return { kind: 'invalid', error: 'expected {"content":"..."} or {"reset":true}' };
}
