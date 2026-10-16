import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, Message } from '../types.js';
import { displayPath, truncate } from '../util.js';
import { rank, type Doc } from './search.js';

export interface JournalEntry {
  ts: string;
  agent: string;
  kind: 'task' | 'outcome' | 'error';
  summary: string;
}

/**
 * File-based long-term memory. Three layers, all under a root directory:
 *   agents/<id>/journal.jsonl  — auto-appended task-level log (harness-driven)
 *   agents/<id>/insights.md    — curated learnings (agent writes via `remember`)
 *   shared/notes.md            — cross-agent shared knowledge (agent writes via `remember`)
 */
export class MemoryStore {
  constructor(
    private readonly root: string,
    private readonly agentId: string,
  ) {
    mkdirSync(this.selfDir(), { recursive: true });
    mkdirSync(this.sharedDir(), { recursive: true });
  }

  private agentsDir(): string {
    return join(this.root, 'agents');
  }
  private selfDir(): string {
    return join(this.agentsDir(), this.agentId);
  }
  private sharedDir(): string {
    return join(this.root, 'shared');
  }

  journalPath(): string {
    return join(this.selfDir(), 'journal.jsonl');
  }
  insightsPath(): string {
    return join(this.selfDir(), 'insights.md');
  }
  sharedPath(): string {
    return join(this.sharedDir(), 'notes.md');
  }

  private sessionsDir(): string {
    return join(this.selfDir(), 'sessions');
  }

  /** Generate a timestamped session id (also usable as a filename). */
  newSessionId(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  private sessionPath(id: string): string {
    return join(this.sessionsDir(), `${id}.json`);
  }

  /** Persist a conversation under its session id so `--resume` can restore it. */
  saveSession(id: string, messages: Message[]): void {
    mkdirSync(this.sessionsDir(), { recursive: true });
    writeFileSync(this.sessionPath(id), JSON.stringify(messages), 'utf8');
  }

  /** Load a saved conversation by id (undefined if none / corrupt). */
  loadSession(id: string): Message[] | undefined {
    const path = this.sessionPath(id);
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as Message[]) : undefined;
    } catch {
      return undefined;
    }
  }

  /** List saved sessions, newest first, with a preview of the first user message. */
  listSessions(): { id: string; preview: string }[] {
    const dir = this.sessionsDir();
    if (!existsSync(dir)) return [];
    const out: { id: string; preview: string }[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const firstUser = (this.loadSession(id) ?? []).find((m) => m.role === 'user');
      out.push({ id, preview: truncate((firstUser?.content ?? '').trim() || '(empty)', 60) });
    }
    return out.sort((a, b) => (a.id < b.id ? 1 : -1)); // ISO ids sort newest-first lexicographically
  }

  appendJournal(entry: { kind: JournalEntry['kind']; summary: string }): void {
    const full: JournalEntry = { ts: new Date().toISOString(), agent: this.agentId, ...entry };
    appendFileSync(this.journalPath(), `${JSON.stringify(full)}\n`, 'utf8');
  }

  private appendMarkdown(path: string, title: string, content: string, tags?: string[]): void {
    const date = new Date().toISOString().slice(0, 10);
    let section = `## ${date} — ${title}\n\n${content.trim()}\n`;
    if (tags && tags.length > 0) section += `\n<!-- tags: ${tags.join(', ')} -->\n`;
    appendFileSync(path, `${existsSync(path) ? '\n' : ''}${section}\n`, 'utf8');
  }

  appendInsight(title: string, content: string, tags?: string[]): void {
    this.appendMarkdown(this.insightsPath(), title, content, tags);
  }

  appendShared(title: string, content: string, tags?: string[]): void {
    this.appendMarkdown(this.sharedPath(), title, content, tags);
  }

  /** Map loop events onto journal entries (task / outcome / error). */
  record(e: AgentEvent): void {
    switch (e.type) {
      case 'request':
        this.appendJournal({ kind: 'task', summary: e.content });
        break;
      case 'done':
        this.appendJournal({ kind: 'outcome', summary: e.content ?? '(no text)' });
        break;
      case 'error':
        this.appendJournal({ kind: 'error', summary: e.message });
        break;
      default:
        break;
    }
  }

  /** Recall memory: empty query -> recent journal entries; otherwise search everything. */
  recall(query?: string, maxResults = 5): string {
    const q = (query ?? '').trim();
    return q ? this.formatSearch(q, maxResults) : this.formatRecent(maxResults);
  }

  private parseJournalFile(path: string): JournalEntry[] {
    const entries: JournalEntry[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as JournalEntry);
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  }

  private readJournal(): JournalEntry[] {
    const path = this.journalPath();
    return existsSync(path) ? this.parseJournalFile(path) : [];
  }

  private formatRecent(n: number): string {
    const entries = this.readJournal();
    if (entries.length === 0) return '(no journal entries yet)';
    return entries
      .slice(-n)
      .reverse()
      .map((e) => `[${e.ts}] (${e.kind}) ${e.summary}`)
      .join('\n');
  }

  private collectDocs(): Doc[] {
    const docs: Doc[] = [];
    const agentsDir = this.agentsDir();
    if (existsSync(agentsDir)) {
      for (const name of readdirSync(agentsDir)) {
        const dir = join(agentsDir, name);
        const insights = join(dir, 'insights.md');
        if (existsSync(insights)) {
          for (const s of splitSections(readFileSync(insights, 'utf8'))) {
            docs.push({ path: displayPath(insights), text: s.text, ts: s.ts });
          }
        }
        const journal = join(dir, 'journal.jsonl');
        if (existsSync(journal)) {
          for (const e of this.parseJournalFile(journal)) {
            docs.push({ path: displayPath(journal), text: e.summary, ts: e.ts });
          }
        }
      }
    }
    for (const f of readdirSync(this.sharedDir())) {
      if (!f.endsWith('.md')) continue;
      const p = join(this.sharedDir(), f);
      for (const s of splitSections(readFileSync(p, 'utf8'))) {
        docs.push({ path: displayPath(p), text: s.text, ts: s.ts });
      }
    }
    return docs;
  }

  private formatSearch(query: string, maxResults: number): string {
    const hits = rank(this.collectDocs(), query, maxResults);
    if (hits.length === 0) return '(no matches)';
    return hits
      .map((h, i) => `[${i + 1}] ${h.path}${h.ts ? ` @ ${h.ts}` : ''}\n    ${h.snippet}`)
      .join('\n');
  }
}

/** Split markdown into `## heading` sections; extract a leading ISO date if present. */
function splitSections(md: string): { text: string; ts?: string }[] {
  const sections: { text: string; ts?: string }[] = [];
  for (const part of md.split(/(?=^## )/m)) {
    const text = part.trim();
    if (!text) continue;
    const m = text.match(/^##\s+(\d{4}-\d{2}-\d{2})/);
    sections.push({ text, ts: m ? m[1] : undefined });
  }
  return sections;
}
