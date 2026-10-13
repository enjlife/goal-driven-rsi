import type { AssistantMessage, Message, ToolDef } from '../types.js';
import type { ChatProvider } from './provider.js';

/**
 * Deterministic offline provider for testing the loop, tools, and JSONL plumbing
 * without an API key. When the latest user message looks like a shell request and
 * no tool has run yet, it emits a single `run_shell` tool call; otherwise it answers
 * with fixed text.
 */
export class MockProvider implements ChatProvider {
  readonly name = 'mock';

  async chat(messages: Message[], tools: ToolDef[]): Promise<AssistantMessage> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const text = lastUser?.content ?? '';
    const toolRan = messages.some((m) => m.role === 'tool');
    const hasShell = tools.some((t) => t.name === 'run_shell');

    if (!toolRan && hasShell && /parallel/i.test(text)) {
      return {
        content: null,
        tool_calls: [
          { id: 'mock-1', name: 'run_shell', arguments: JSON.stringify({ command: 'echo first' }) },
          { id: 'mock-2', name: 'run_shell', arguments: JSON.stringify({ command: 'echo second' }) },
        ],
      };
    }

    if (!toolRan && hasShell && /shell|run|echo|command/i.test(text)) {
      return {
        content: null,
        tool_calls: [{ id: 'mock-1', name: 'run_shell', arguments: JSON.stringify({ command: 'echo mock-ok' }) }],
      };
    }

    return { content: `mock reply to: ${text.slice(0, 200) || '(empty)'}`, tool_calls: [] };
  }
}
