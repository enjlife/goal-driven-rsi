// Core shared types: messages, tool calls, tool definitions, and loop events.

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments string. */
  arguments: string;
}

export interface Message {
  role: Role;
  content: string | null;
  /** Present on assistant messages that call tools. */
  tool_calls?: ToolCall[];
  /** Present on tool messages; id of the tool call being answered. */
  tool_call_id?: string;
  /** Present on tool messages that failed; marks the result as an error. */
  tool_error?: boolean;
  /**
   * Provider-specific raw assistant representation, echoed back verbatim on
   * subsequent turns. Used by the Anthropic provider to preserve thinking blocks
   * (required for multi-turn history to stay append-only).
   */
  raw?: unknown;
  /** Marks a system message holding the summary of compacted earlier turns. */
  summary?: boolean;
}

/** Token usage reported by the provider for one call. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface AssistantMessage {
  content: string | null;
  tool_calls: ToolCall[];
  raw?: unknown;
  usage?: Usage;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema object describing the tool's arguments. */
  parameters: Record<string, unknown>;
}

export type ToolResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

/**
 * Events emitted by the agent loop. This is the single source of truth for both
 * the human-readable terminal output and the JSONL interface.
 */
export type AgentEvent =
  | { type: 'request'; role: 'user' | 'system'; content: string }
  | { type: 'assistant'; content: string | null; tool_calls: ToolCall[] }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; arguments: string; output: string }
  | { type: 'done'; content: string | null }
  /** Context size after a reply: tokens currently in the model context vs. the window. */
  | { type: 'context'; tokens: number; maxTokens: number; estimated: boolean }
  /** Earlier turns were summarized to shrink the context (the session file keeps the originals). */
  | { type: 'compact'; before: number; after: number }
  | { type: 'error'; message: string };
