# goal-driven-rsi

Minimal goal-driven **single agent** for the local terminal, in TypeScript + Node.js. It has a hand-written agent loop (no framework), speaks to both **OpenAI** and **Anthropic** through a common provider interface, and exposes a **JSONL** interface for scripting.

This is the foundation for later goal-driven recursive self-improvement: the agent already has the tools it would need to act on and modify its own environment.

## Quick start

```bash
npm install
npm run build

# interactive REPL (auto-detects provider from the key you set)
npm start

# one-shot — prints the final answer to stdout, tool activity to stderr
node dist/index.js -p "list files in the current directory"

# offline, no API key (deterministic mock provider, for testing)
node dist/index.js -p "run a shell test" --provider mock
```

Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (see `.env.example`; a `.env` file is auto-loaded). Default model: `claude-opus-5-5` (Anthropic) / `gpt-4o-mini` (OpenAI) — override with `-m` / `ANTHROPIC_MODEL` / `OPENAI_MODEL`.

## Tools

Three minimal tools, defined with JSON Schema and dispatched by the loop:

| Tool | What it does |
|---|---|
| `run_shell` | Run a single shell command in `AGENT_WORKDIR`; returns stdout/stderr/exit code. No PTY, no state between calls, `AGENT_SHELL_TIMEOUT_MS` default 30s. |
| `read_file` | Read a UTF-8 text file (relative to workdir, `..` escapes rejected, 1 MiB cap). |
| `write_file` | Create/overwrite a UTF-8 text file (relative to workdir, `..` escapes rejected). |

Disable tools entirely with `--no-tools`.

## CLI

```
agent                            interactive REPL (/reset, /exit)
agent -p "prompt"                one-shot
agent --jsonl                    JSONL protocol on stdin/stdout

-p, --prompt <text>    run a single prompt and exit
--jsonl                stdin/stdout JSONL line protocol
--provider <name>      openai | anthropic | mock  (default: auto-detect)
-m, --model <id>       model id override
--max-turns <n>        max model<->tool round-trips per turn (default 8)
--no-tools             pure chat, no tools
--session <path>       transcript JSONL path (default sessions/<ts>.jsonl in human modes)
--no-session           disable transcript
-h, --help
```

## JSONL interface

Two flavours, sharing one event schema:

1. **Protocol mode** (`--jsonl`): read one JSON object per line from stdin, emit one event per line to stdout. Drive it from a shell pipeline or another program.
2. **Transcript**: every turn is appended as JSONL. Human modes default to `sessions/<timestamp>.jsonl`; override with `--session` or disable with `--no-session`.

### stdin requests

```json
{"content":"list files and summarize"}
{"reset":true}
```

### event schema (each line has a `ts` timestamp plus a `type`)

```json
{"type":"request","role":"user","content":"..."}
{"type":"assistant","content":"...","tool_calls":[{"id":"...","name":"run_shell","arguments":"{\"command\":\"...\"}"}]}
{"type":"tool_call","id":"...","name":"run_shell","arguments":"..."}
{"type":"tool_result","id":"...","name":"run_shell","ok":true,"output":"..."}
{"type":"done","content":"final answer or null"}
{"type":"error","message":"..."}
```

### pipeline example

```bash
printf '%s\n' '{"content":"run echo hello"}' | node dist/index.js --jsonl --provider mock
```

## Configuration (env vars)

See `.env.example` for the full annotated list:

- Provider: `AGENT_PROVIDER`, `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`, `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL`/`ANTHROPIC_MAX_TOKENS`
- Behaviour: `AGENT_WORKDIR`, `AGENT_MAX_TURNS`, `AGENT_SHELL_TIMEOUT_MS`, `AGENT_SYSTEM_PROMPT`
- Retry & context: `AGENT_MAX_RETRIES`, `AGENT_RETRY_BASE_MS`, `AGENT_MAX_CONTEXT_TOKENS`, `AGENT_MAX_TOOL_RESULT_CHARS`

`OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` let you point at compatible endpoints (e.g. a local or proxied gateway).

## Project layout

```
src/
  index.ts          CLI entry: arg parsing, mode dispatch (REPL / -p / --jsonl)
  config.ts         env + .env resolution
  types.ts          Message / ToolCall / ToolDef / AgentEvent
  run.ts            shared turn runner + human-readable event rendering
  loop.ts           the agent loop (model <-> tools until done or maxTurns)
  jsonl.ts          event encode/decode + transcript writer
  repl.ts           readline REPL
  context.ts        token estimation + sliding-window history trimming
  retry.ts          exponential-backoff retry for retryable provider errors
  errors.ts         ProviderError (status + retryable classification)
  util.ts           truncate / sleep helpers
  providers/        provider.ts (interface+factory), openai.ts, anthropic.ts, mock.ts
  tools/            registry.ts, shell.ts, files.ts
```

## Notes

- Zero runtime dependencies: native `fetch`, `node:child_process`, `node:readline`, `node:util.parseArgs`.
- Non-streaming requests (one HTTP call per turn) for minimalism; streaming is a later enhancement.
- Multiple tool calls in one turn run **in parallel** (`Promise.all`); results are fed back in order.
- Retryable API errors (429/5xx/network) retry with exponential backoff + jitter; non-retryable errors (400/401/403) fail fast.
- History is trimmed with a sliding window (drop oldest user-turns) once the approximate token count nears the context budget; oversized `tool_result` output is truncated before reaching the model.
- The Anthropic provider preserves and echoes back thinking blocks so multi-turn history stays append-only.
