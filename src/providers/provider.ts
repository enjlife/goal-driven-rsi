import type { AssistantMessage, Message, ToolDef } from '../types.js';
import type { Config, ProviderKind } from '../config.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { MockProvider } from './mock.js';

export interface ChatProvider {
  readonly name: string;
  chat(messages: Message[], tools: ToolDef[]): Promise<AssistantMessage>;
}

export function createProvider(kind: ProviderKind, config: Config): ChatProvider {
  switch (kind) {
    case 'openai':
      return new OpenAIProvider(config.openai);
    case 'anthropic':
      return new AnthropicProvider(config.anthropic);
    case 'mock':
      return new MockProvider();
  }
}
