import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { displayPath } from '../util.js';

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

export interface Skill extends SkillInfo {
  content: string;
}

/**
 * Reusable skills stored as `skills/<slug>/SKILL.md` with a leading `---`
 * frontmatter block (`name`, `description`) followed by the instruction body.
 */
export class SkillStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  private slug(name: string): string {
    const s = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return s || 'skill';
  }

  list(): SkillInfo[] {
    if (!existsSync(this.root)) return [];
    const out: SkillInfo[] = [];
    for (const dir of readdirSync(this.root)) {
      const file = join(this.root, dir, 'SKILL.md');
      if (!existsSync(file)) continue;
      const parsed = parseSkill(readFileSync(file, 'utf8'));
      out.push({
        name: parsed.name || dir,
        description: parsed.description || '',
        path: displayPath(file),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  read(name: string): Skill | undefined {
    for (const dir of readdirSync(this.root)) {
      const file = join(this.root, dir, 'SKILL.md');
      if (!existsSync(file)) continue;
      const parsed = parseSkill(readFileSync(file, 'utf8'));
      const skillName = parsed.name || dir;
      if (skillName === name || dir === name || this.slug(skillName) === name) {
        return {
          name: skillName,
          description: parsed.description || '',
          content: parsed.body,
          path: displayPath(file),
        };
      }
    }
    return undefined;
  }

  create(name: string, description: string, content: string): string {
    const dir = join(this.root, this.slug(name));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'SKILL.md');
    const md = `---\nname: ${name}\ndescription: ${description}\n---\n\n${content.trim()}\n`;
    writeFileSync(file, md, 'utf8');
    return displayPath(file);
  }
}

function parseSkill(md: string): { name?: string; description?: string; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { body: md.trim() };
  return {
    name: extractField(m[1], 'name'),
    description: extractField(m[1], 'description'),
    body: m[2].trim(),
  };
}

function extractField(frontmatter: string, key: string): string | undefined {
  const line = frontmatter.split('\n').find((l) => l.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}
