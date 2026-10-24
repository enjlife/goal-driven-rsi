import type { AssistantMessage, Message, ToolDef } from '../types.js';
import type { ChatProvider } from './provider.js';

/**
 * Deterministic offline provider for testing the loop, tools, and JSONL plumbing
 * without an API key. Triggers a tool call based on the user text (run_shell /
 * ask_user), then answers with fixed text that echoes the last tool result.
 */
export class MockProvider implements ChatProvider {
  readonly name = 'mock';

  async chat(messages: Message[], tools: ToolDef[]): Promise<AssistantMessage> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const text = lastUser?.content ?? '';
    const toolRan = messages.some((m) => m.role === 'tool');
    const hasShell = tools.some((t) => t.name === 'run_shell');
    const hasAsk = tools.some((t) => t.name === 'ask_user');

    if (!toolRan && hasAsk && /ask|confirm|clarify|choose|选择|确认|澄清/i.test(text)) {
      return {
        content: null,
        tool_calls: [
          { id: 'mock-1', name: 'ask_user', arguments: JSON.stringify({ question: '请选择一个方向', options: ['方向A', '方向B', '方向C'] }) },
        ],
      };
    }

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

    const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
    const toolEcho = lastTool ? ` (tool result: ${lastTool.content})` : '';
    return { content: `mock reply to: ${text.slice(0, 200) || '(empty)'}${toolEcho}`, tool_calls: [] };
  }
}
