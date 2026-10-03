// Memory that lasts. Every message, fact and summary is kept forever and searchable; nothing is deleted unless the owner says so.
import type { Db } from "./db.ts";
import { fmtDate } from "./time.ts";

export const CATEGORIES = ["people", "preferences", "routines", "projects", "money", "health", "family", "work", "instructions", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
export const isCategory = (v: unknown): v is Category => typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);

const STOP = new Set("the and for are but not you your with this that have has had was were will would could should can what when where which who whom how why from they them their there here about into over out our any all just now then than also too very been being its it's i'm i've don't didn't doesn't isn't can't won't let me my mine yes yeah okay ok please thanks thank hello".split(" "));

/** Turn free text into a safe FTS5 query: quoted tokens joined by OR. Null when nothing searchable remains. */
export function ftsQuery(text: string): string | null {
  const seen = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]{3,}/gu)) {
    const t = m[0];
    if (!STOP.has(t) && !/^\d+$/.test(t)) seen.add(t);
    if (seen.size >= 10) break;
  }
  return seen.size ? [...seen].map((t) => `"${t}"`).join(" OR ") : null;
}

export async function indexText(db: Db, kind: string, refId: number, text: string): Promise<void> {
  await db.prepare("INSERT INTO memory_fts (kind, ref_id, text) VALUES (?, ?, ?)").bind(kind, refId, text.slice(0, 4000)).run();
}

export interface Hit { kind: string; refId: number; ts: number; text: string; role: string | null }

/** Search all of memory. `excludeMessageIds` keeps recent history (already in the prompt) out of the recalled block. */
export async function recall(db: Db, query: string, limit = 6, excludeMessageIds: ReadonlySet<number> = new Set()): Promise<Hit[]> {
  const q = ftsQuery(query);
  if (!q) return [];
  const r = await db.prepare(
    `SELECT memory_fts.kind AS kind, memory_fts.ref_id AS ref_id, memory_fts.text AS text, bm25(memory_fts) AS rank,
            COALESCE(m.ts, fa.ts, s.ts, d.ts) AS ts, m.role AS role
       FROM memory_fts
       LEFT JOIN messages m ON memory_fts.kind = 'message' AND m.id = memory_fts.ref_id
       LEFT JOIN facts fa ON memory_fts.kind = 'fact' AND fa.id = memory_fts.ref_id
       LEFT JOIN summaries s ON memory_fts.kind = 'summary' AND s.id = memory_fts.ref_id
       LEFT JOIN docs d ON memory_fts.kind = 'doc' AND d.id = memory_fts.ref_id
      WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?`,
  ).bind(q, limit + excludeMessageIds.size + 6).all<{ kind: string; ref_id: number; text: string; ts: number | null; role: string | null }>();
  const out: Hit[] = [];
  for (const h of r.results) {
    if (h.kind === "message" && excludeMessageIds.has(Number(h.ref_id))) continue;
    if (h.ts === null) continue; // a deleted source row
    out.push({ kind: h.kind, refId: Number(h.ref_id), ts: Number(h.ts), text: h.text, role: h.role });
    if (out.length >= limit) break;
  }
  return out;
}

export function fmtHit(h: Hit, off: number, max = 220): string {
  const who = h.kind === "message" ? (h.role === "assistant" ? "Rafiki said" : "you said") : h.kind === "summary" ? "summary" : h.kind === "doc" ? "file" : "fact";
  const t = h.text.replace(/\s+/g, " ").trim();
  return `${fmtDate(h.ts, off)} ${who}: ${t.length > max ? `${t.slice(0, max)}...` : t}`;
}

/** Add a durable fact. Returns the id, or null if the same fact already exists. */
export async function addFact(db: Db, now: number, text: string, category: Category = "other", source = "chat", pinned = false): Promise<number | null> {
  const t = text.trim().slice(0, 300);
  if (!t) return null;
  const r = await db.prepare("INSERT INTO facts (ts, text, category, source, pinned) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id")
    .bind(now, t, category, source, pinned ? 1 : 0).first<{ id: number }>();
  if (!r) return null;
  await indexText(db, "fact", r.id, t);
  return r.id;
}

export async function forgetFact(db: Db, id: number): Promise<boolean> {
  const r = await db.prepare("DELETE FROM facts WHERE id = ? RETURNING id").bind(id).first<{ id: number }>();
  if (!r) return false;
  await db.prepare("DELETE FROM memory_fts WHERE kind = 'fact' AND ref_id = ?").bind(id).run();
  return true;
}

export async function findFacts(db: Db, words: string): Promise<{ id: number; text: string; category: string }[]> {
  const q = ftsQuery(words);
  if (!q) return [];
  const r = await db.prepare("SELECT fa.id AS id, fa.text AS text, fa.category AS category FROM memory_fts JOIN facts fa ON memory_fts.kind = 'fact' AND fa.id = memory_fts.ref_id WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT 5").bind(q).all<{ id: number; text: string; category: string }>();
  return r.results;
}

export async function memoryStats(db: Db): Promise<{ messages: number; facts: number; summaries: number; oldest: number | null }> {
  const r = await db.prepare("SELECT (SELECT COUNT(*) FROM messages) AS m, (SELECT COUNT(*) FROM facts) AS f, (SELECT COUNT(*) FROM summaries) AS s, (SELECT MIN(ts) FROM messages) AS o").bind().first<{ m: number; f: number; s: number; o: number | null }>();
  return { messages: Number(r?.m ?? 0), facts: Number(r?.f ?? 0), summaries: Number(r?.s ?? 0), oldest: r?.o ?? null };
}
