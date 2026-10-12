import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB

/** Resolve `p` against `cwd`, refusing paths that escape it (e.g. `..`). */
function safeResolve(cwd: string, p: string): string {
  const base = resolve(cwd);
  const target = resolve(base, p);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`path escapes working directory: ${p}`);
  }
  return target;
}

export function readFile(p: string, cwd: string, maxBytes = DEFAULT_MAX_BYTES): string {
  const target = safeResolve(cwd, p);
  const stat = statSync(target);
  if (!stat.isFile()) throw new Error(`not a regular file: ${p}`);
  if (stat.size > maxBytes) throw new Error(`file too large (${stat.size} bytes, max ${maxBytes}): ${p}`);
  return readFileSync(target, 'utf8');
}

export function writeFile(p: string, content: string, cwd: string): string {
  const target = safeResolve(cwd, p);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
}
