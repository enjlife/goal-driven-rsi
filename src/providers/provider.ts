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
      return new OpenAIProvider(config.openai, config.retry);
    case 'anthropic':
      return new AnthropicProvider(config.anthropic, config.retry);
    case 'mock':
      return new MockProvider();
  }
}
