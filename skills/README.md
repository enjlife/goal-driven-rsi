# Skills

Reusable procedures the agent can create and invoke. Each skill lives in its own
directory as `skills/<name>/SKILL.md`, with a small frontmatter header:

```markdown
---
name: report-issue
description: When reporting a bug or unexpected behavior, follow this checklist.
---

1. Reproduce the issue with a minimal command.
2. Capture the exact error output and exit code.
3. Note the environment (Node version, OS).
4. Summarize expected vs actual behavior.
```

## Conventions

- `name` — short, kebab-case identifier (also the directory name).
- `description` — one line stating **when** to use the skill (this is what the
  agent matches against via `list_skills`).
- Body — the step-by-step instructions the agent follows after `read_skill`.

## Tools

- `list_skills` — list available skills and their descriptions.
- `read_skill <name>` — load a skill's full instructions.
- `create_skill` — write a new skill (or overwrite an existing one).

Skills are committed to git so they are shared across agents and machines.
