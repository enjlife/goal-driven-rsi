import type { ToolResult } from '../types.js';
import type { SkillStore } from '../skills/store.js';

/** `list_skills` tool: list available skills (name + one-line description). */
export function listSkills(store: SkillStore): ToolResult {
  const skills = store.list();
  if (skills.length === 0) return { ok: true, output: '(no skills yet)' };
  return { ok: true, output: skills.map((s) => `- ${s.name}: ${s.description}`).join('\n') };
}

/** `read_skill` tool: load a skill's full instructions by name. */
export function readSkill(store: SkillStore, args: Record<string, unknown>): ToolResult {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) return { ok: false, error: 'missing "name"' };
  const skill = store.read(name);
  if (!skill) return { ok: false, error: `skill not found: ${name}` };
  const header = skill.description ? `# ${skill.name}\n\n${skill.description}\n\n` : `# ${skill.name}\n\n`;
  return { ok: true, output: `${header}${skill.content}` };
}

/** `create_skill` tool: create (or overwrite) a reusable skill. */
export function createSkill(store: SkillStore, args: Record<string, unknown>): ToolResult {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const description = typeof args.description === 'string' ? args.description.trim() : '';
  const content = typeof args.content === 'string' ? args.content : '';
  if (!name) return { ok: false, error: 'missing "name"' };
  if (!description) return { ok: false, error: 'missing "description"' };
  if (!content.trim()) return { ok: false, error: 'missing "content"' };
  const path = store.create(name, description, content);
  return { ok: true, output: `created skill "${name}" at ${path}` };
}
