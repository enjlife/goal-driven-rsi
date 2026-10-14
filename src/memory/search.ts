// Zero-dependency full-text search over memory documents.

export interface Doc {
  path: string;
  text: string;
  ts?: string;
}

export interface SearchHit {
  path: string;
  score: number;
  snippet: string;
  ts?: string;
}

function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function makeSnippet(text: string, terms: string[], max = 200): string {
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  const start = pos === -1 ? 0 : Math.max(0, pos - 60);
  const clean = text.slice(start, start + max).replace(/\s+/g, ' ').trim();
  const prefix = start > 0 ? '…' : '';
  const suffix = start + max < text.length ? '…' : '';
  return `${prefix}${clean}${suffix}`;
}

/** Rank docs by keyword occurrence count and return the top `maxResults`. */
export function rank(docs: Doc[], query: string, maxResults: number): SearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const doc of docs) {
    const lower = doc.text.toLowerCase();
    let score = 0;
    for (const t of terms) score += occurrences(lower, t);
    if (score > 0) {
      hits.push({ path: doc.path, score, snippet: makeSnippet(doc.text, terms), ts: doc.ts });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, maxResults);
}
