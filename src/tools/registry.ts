import type { ToolCall, ToolDef, ToolResult } from '../types.js';
import { runShell } from './shell.js';
import { readFile, writeFile } from './files.js';

export interface ToolContext {
  cwd: string;
  shellTimeoutMs: number;
}

export function toolDefs(): ToolDef[] {
  return [
    {
      name: 'run_shell',
      description:
        'Run a single shell command in the working directory and return its stdout, stderr and exit code. ' +
        'Not interactive: no PTY, no state between calls.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
          timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file within the working directory and return its contents.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the working directory.' },
          max_bytes: { type: 'number', description: 'Optional size limit in bytes (default 1 MiB).' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 text file within the working directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the working directory.' },
          content: { type: 'string', description: 'File contents to write.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  ];
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.arguments || '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('arguments must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(`invalid arguments for ${call.name}: ${(e as Error).message}`);
  }
}

export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  try {
    const args = parseArgs(call);
    switch (call.name) {
      case 'run_shell': {
        const command = typeof args.command === 'string' ? args.command : '';
        if (!command) throw new Error('missing "command"');
        const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : ctx.shellTimeoutMs;
        const r = await runShell(command, { cwd: ctx.cwd, timeoutMs });
        const output = [
          r.stdout ? `[stdout]\n${r.stdout}` : '',
          r.stderr ? `[stderr]\n${r.stderr}` : '',
          r.timed_out ? '[timed out]' : '',
        ]
          .filter(Boolean)
          .join('\n');
        return { ok: true, output: output || `[exit ${r.exit_code}]` };
      }
      case 'read_file': {
        const path = typeof args.path === 'string' ? args.path : '';
        if (!path) throw new Error('missing "path"');
        const maxBytes = typeof args.max_bytes === 'number' ? args.max_bytes : undefined;
        return { ok: true, output: readFile(path, ctx.cwd, maxBytes) };
      }
      case 'write_file': {
        const path = typeof args.path === 'string' ? args.path : '';
        const content = typeof args.content === 'string' ? args.content : '';
        if (!path) throw new Error('missing "path"');
        const target = writeFile(path, content, ctx.cwd);
        return { ok: true, output: `wrote ${target}` };
      }
      default:
        return { ok: false, error: `unknown tool: ${call.name}` };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
