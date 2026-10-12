import type { AssistantMessage, Message, ToolCall, ToolDef } from '../types.js';
import type { ChatProvider } from './provider.js';

interface OpenAIConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
}

/** Convert internal messages to the OpenAI chat-completions wire format. */
function toOpenAIMessages(messages: Message[]): Record<string, unknown>[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
      case 'user':
        return { role: m.role, content: m.content ?? '' };
      case 'assistant':
        if (m.tool_calls && m.tool_calls.length > 0) {
          return {
            role: 'assistant',
            content: m.content ?? null,
            tool_calls: m.tool_calls.map((tc: ToolCall) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          };
        }
        return { role: 'assistant', content: m.content ?? '' };
      case 'tool':
        return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content ?? '' };
    }
  });
}

export class OpenAIProvider implements ChatProvider {
  readonly name = 'openai';

  constructor(private readonly cfg: OpenAIConfig) {}

  async chat(messages: Message[], tools: ToolDef[]): Promise<AssistantMessage> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: toOpenAIMessages(messages),
    };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }

    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey ?? ''}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = (await res.json()) as {
      choices: { message: { content?: string | null; tool_calls?: unknown[] } }[];
    };
    const msg = data.choices[0]?.message;
    if (!msg) throw new Error('OpenAI response missing choices[0].message');

    const tool_calls: ToolCall[] = (msg.tool_calls ?? []).map((tc) => {
      const t = tc as { id: string; function: { name: string; arguments: string } };
      return { id: t.id, name: t.function.name, arguments: t.function.arguments };
    });

    return { content: msg.content ?? null, tool_calls };
  }
}
