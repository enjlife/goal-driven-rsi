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
| `run_shell` | Run a single shell command in `AGENT_WORKDIR`; returns stdout/stderr/exit code. A non-zero exit code or timeout is reported as a tool failure. No PTY, no state between calls, `AGENT_SHELL_TIMEOUT_MS` default 30s. |
| `read_file` | Read a UTF-8 text file (relative to workdir, `..` escapes rejected, 1 MiB cap). |
| `write_file` | Create/overwrite a UTF-8 text file (relative to workdir, `..` escapes rejected). |
| `remember` | Write a long-term memory: a curated insight (`scope: "self"`) or cross-agent shared knowledge (`scope: "shared"`). |
| `recall` | Search long-term memory across all agents' insights, shared knowledge and journals; omit the query to list your recent journal entries. |
| `ask_user` | Ask the user a clarifying question (with optional choices) when the request is ambiguous; the user can pick one, several, or type free text. |

Disable tools entirely with `--no-tools`.

## Long-term memory

Every agent keeps a persistent, file-based memory under `AGENT_MEMORY_DIR` (default `./memory`, gitignored), namespaced by `AGENT_ID` (or `--agent <id>`):

```
memory/
  agents/<id>/journal.jsonl   # auto-appended task log (task / outcome / error)
  agents/<id>/insights.md     # curated learnings (written via `remember`, scope "self")
  agents/<id>/sessions/*.json # full conversation history, one per session (for --resume)
  shared/notes.md             # cross-agent shared knowledge (via `remember`, scope "shared")
```

- The **journal** is written automatically by the harness each turn, so records survive even if the agent never calls `remember`.
- **insights** and **shared** are written by the agent and are what other agents "借鉴" via `recall`.
- `recall` searches everything (all agents' insights + journals + shared notes) and returns ranked snippets; an empty query returns the current agent's recent journal entries for resuming work.
- The full conversation is saved to a per-session file after every turn. `--resume` lists the saved sessions and lets you pick one to continue; `--resume-id <id>` resumes a specific session.

Give each sub-agent its own id in a multi-agent setup: `node dist/index.js --agent researcher …`

## CLI

```
agent                            interactive REPL (/reset, /exit)
agent -p "prompt"                one-shot
agent --jsonl                    JSONL protocol on stdin/stdout
agent --team team.json           run a team of sub-agents toward a goal
agent --plan plan.json           plan directions -> choose -> allocate a team

-p, --prompt <text>    run a single prompt and exit
--jsonl                stdin/stdout JSONL line protocol
--team <config.json>   run a multi-agent team (goal + members defined in the JSON)
--plan <config.json>   plan directions -> choose one -> allocate a team (goal + roles)
--direction <n>        with --plan: pick the n-th direction (1-based, non-interactive)
--provider <name>      openai | anthropic | mock  (default: auto-detect)
-m, --model <id>       model id override
--max-turns <n>        max model<->tool round-trips per turn (default 50; soft limit)
--agent <id>           agent identity for long-term memory (default: main)
--no-tools             pure chat, no tools
--session <path>       transcript JSONL path (default sessions/<ts>.jsonl in human modes)
--no-session           disable transcript
--resume               list saved sessions and pick one to continue (per --agent)
--resume-id <id>       resume a specific saved session by id
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

## Use as a library (npm)

Publish and install as a dependency, then import the `Agent` class:

```ts
import { Agent } from 'goal-driven-rsi';

const agent = new Agent({ provider: 'anthropic' }); // or pass apiKey/baseUrl/model/agentId/...
const { content, turns } = await agent.run('列出当前目录');

// stateful multi-turn
const session = agent.session();
await session.ask('先看看有哪些文件');
await session.ask('读第一个文件');
```

Options (all optional; unset fields fall back to env vars / defaults):
`provider`, `model`, `apiKey`, `baseUrl`, `agentId`, `workdir`, `memoryDir`, `skillsDir`, `systemPrompt`, `maxTurns`, `noTools`.

Pass `onEvent` to `run()` / `ask()` to observe `request / assistant / tool_call / tool_result / done / error` events.

Publish:

```bash
npm login       # once
npm publish     # runs prepublishOnly -> build, then publishes dist/
```

The package is ESM-only (`"type": "module"`), requires Node >= 18, and the unscoped name must be free on npm — scope it (`@yourname/goal-driven-rsi`) if `goal-driven-rsi` is taken.

## Multi-agent team

Run a team of sub-agents toward a goal: members propose in parallel, discuss/refine,
then a reviewer agent scores the results. Each member is an `Agent` with its own
`agentId` but a shared memory root, so proposals are written to the shared board
(`memory/shared/board.jsonl`) and are recallable by any agent via `recall`.

CLI:

```bash
goal-driven-rsi --team team.json
```

`team.json`:

```json
{
  "goal": "让这个 CLI 工具支持流式输出，说明关键步骤和权衡",
  "maxRounds": 1,
  "members": [
    { "id": "architect", "systemPrompt": "你是资深软件架构师，擅长系统设计与权衡。" },
    { "id": "engineer", "systemPrompt": "你是资深工程师，擅长实现细节与性能优化。" }
  ]
}
```

Library:

```ts
import { Team } from 'goal-driven-rsi';

const team = new Team({ goal, members, maxRounds: 1, base: { provider: 'anthropic' } });
const { proposals, review, boardPath } = await team.run();
```

- `maxRounds` — discussion rounds after the initial propose (default 1); set 0 for propose→review only.
- `base` — shared provider/model/apiKey/etc. for every member (falls back to env). Set `base: { noTools: true, maxTurns: 8 }` to keep members lean for brainstorming (avoids heavy tool exploration).

### REPL: `/goal` and `/directions`

Normal mode runs a single agent directly. Two commands add clarification-based
direction selection — they detect the ambiguous parts of a request and offer options:

- `/goal <task>` — goal mode: pick **one or more** options (comma/range/`all`);
  each selected option is implemented by a sub-agent, in parallel.
- `/directions <task>` — normal mode: pick **one** direction (or `0` = run directly); the single agent follows it.

```
agent> /goal 让 CLI 支持流式输出
澄清需求...
方向候选（可多选，逗号分隔如 1,3；all 全选）：
  1. …方向一…
  2. …方向二…
  3. …方向三…
选择 [1-N / all, q=取消]：1,3
选定 2 个方向，派发子 agent 并行实现...
```

### Dynamic planning (`--plan`)

Let a planner agent propose candidate directions, you pick one, then it allocates a team:

```bash
goal-driven-rsi --plan plan.json            # interactive pick
goal-driven-rsi --plan plan.json --direction 2   # non-interactive: pick the 2nd
```

`plan.json`:

```json
{
  "goal": "让这个 CLI 工具支持流式输出",
  "directions": 3,
  "maxRounds": 1,
  "roles": [
    { "id": "strategist", "systemPrompt": "你负责整体策略与方案。" },
    { "id": "implementer", "systemPrompt": "你负责实现步骤与细节。" },
    { "id": "critic", "systemPrompt": "你负责风险评审与质疑。" }
  ],
  "base": { "noTools": true, "maxTurns": 8 }
}
```

Library: `import { planDirections } from 'goal-driven-rsi'` to get the candidate list programmatically.

## Configuration (env vars)

See `.env.example` for the full annotated list:

- Provider: `AGENT_PROVIDER`, `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`, `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL`/`ANTHROPIC_MAX_TOKENS`
- Behaviour: `AGENT_WORKDIR`, `AGENT_MAX_TURNS`, `AGENT_SHELL_TIMEOUT_MS`, `AGENT_SYSTEM_PROMPT`
- Memory: `AGENT_MEMORY_DIR`, `AGENT_ID`
- Skills: `AGENT_SKILLS_DIR`
- Retry & context: `AGENT_MAX_RETRIES`, `AGENT_RETRY_BASE_MS`, `AGENT_MAX_CONTEXT_TOKENS`, `AGENT_MAX_TOOL_RESULT_CHARS`

`OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` let you point at compatible endpoints (e.g. a local or proxied gateway).

### Config precedence (highest first)

1. Exported environment variables (e.g. in your shell profile)
2. Project `./.env` (the current directory)
3. User-level config `~/.config/goal-driven-rsi/.env` (or `$XDG_CONFIG_HOME/goal-driven-rsi/.env`, or override its path with `AGENT_CONFIG`)
4. Built-in defaults

Put your API key once in the user-level config and every project (and the global `goal-driven-rsi` command) shares it, unless a project exports its own key or `.env`:

```bash
mkdir -p ~/.config/goal-driven-rsi
cp .env.example ~/.config/goal-driven-rsi/.env   # then edit it
```

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
  util.ts           truncate / sleep / strictInt helpers
  memory/           store.ts (MemoryStore) + search.ts (zero-dep keyword ranking)
  providers/        provider.ts (interface+factory), openai.ts, anthropic.ts, mock.ts
  tools/            registry.ts, shell.ts, files.ts, memory.ts
```

## Notes

- Zero runtime dependencies: native `fetch`, `node:child_process`, `node:readline`, `node:util.parseArgs`.
- Non-streaming requests (one HTTP call per turn) for minimalism; streaming is a later enhancement.
- Multiple tool calls in one turn run **in parallel** (`Promise.all`); results are fed back in order.
- The turn budget is a **soft limit**: the model is nudged to wrap up on the final turn, repeated identical tool calls stop the loop early, and hitting the limit returns a graceful note instead of throwing.
- Retryable API errors (429/5xx/network) retry with exponential backoff + jitter; non-retryable errors (400/401/403) fail fast.
- History is trimmed with a sliding window (drop oldest user-turns) once the approximate token count nears the context budget; oversized `tool_result` output is truncated before reaching the model.
- The Anthropic provider preserves and echoes back thinking blocks so multi-turn history stays append-only.
