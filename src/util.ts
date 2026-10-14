import { relative } from 'node:path';

/** Truncate `s` to at most `max` characters, marking the cut. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… (truncated)`;
}

/** Path shown to the model, relative to cwd when possible. */
export function displayPath(abs: string): string {
  const rel = relative(process.cwd(), abs);
  return rel.startsWith('..') ? abs : rel;
}

/** Parse a strict integer, throwing on non-integers or values below `min`. */
export function strictInt(value: string, name: string, min = 0): number {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new Error(`invalid ${name}: "${value}" is not an integer`);
  }
  if (n < min) {
    throw new Error(`invalid ${name}: ${n} is below the minimum ${min}`);
  }
  return n;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
