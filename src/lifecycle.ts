// Goals and tasks do not stay live forever. A goal past its date is no longer a priority, a task untouched for a week is
// parked, and the owner can close either by chat or in /tasks and /goals. The brief and the One both read from here, so a
// dead target cannot come back through a second list. Pure database helpers: no Telegram, no model.
import type { Db } from "./db.ts";
import { fmtDate } from "./time.ts";

export const STALE_TASK_DAYS = 7;
export const DAY_MS = 86400000;

/** The local date as sortable YYYYMMDD. */
export function todayKey(now: number, off: number): string {
  const [d, m, y] = fmtDate(now, off).split(" ").pop()!.split("-");
  return `${y}${m}${d}`;
}
/** A DD-MM-YYYY goal date as sortable YYYYMMDD, or null when it is not one. */
export function dmyKey(s: string | null | undefined): string | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s ?? "");
  return m ? `${m[3]}${m[2]}${m[1]}` : null;
}
/** True when the goal has a date and that date is before today. Goals with no date are never lapsed. */
export function isLapsed(by: string | null | undefined, now: number, off: number): boolean {
  const k = dmyKey(by);
  return k !== null && k < todayKey(now, off);
}
/** SQL for "not past its date", for one bound YYYYMMDD (today). by_date is DD-MM-YYYY text. */
export const LIVE_GOAL_SQL = "(by_date IS NULL OR by_date = '' OR substr(by_date, 7, 4) || substr(by_date, 4, 2) || substr(by_date, 1, 2) >= ?)";
export const staleBefore = (now: number): number => now - STALE_TASK_DAYS * DAY_MS;
export const ageDays = (ts: number, now: number): number => Math.max(0, Math.floor((now - ts) / DAY_MS));
/** A date N days ahead, as DD-MM-YYYY (the format goals use). */
export const dateAhead = (now: number, off: number, days: number): string => fmtDate(now + days * DAY_MS, off).split(" ").pop()!;

const STOP = new Set(["the", "and", "for", "with", "that", "this", "about", "from", "your", "you", "our", "to", "of", "in", "on", "my", "it"]);
const words = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w));

export type CloseKind = "task" | "goal" | "reminder";
const TABLE: Record<CloseKind, { sql: string; open: string }> = {
  task: { sql: "tasks", open: "state = 'open'" },
  goal: { sql: "goals", open: "state = 'open'" },
  reminder: { sql: "reminders", open: "state IN ('open', 'flagged', 'awaiting')" },
};

/** Close every open task, goal or reminder that matches the owner's words (all distinctive words present, or the phrase
 *  itself), at most five. Only the state changes: nothing is deleted. Returns the texts closed. */
export async function closeMatching(db: Db, kind: CloseKind, match: string, state: "done" | "dropped"): Promise<string[]> {
  const q = words(match);
  const phrase = match.toLowerCase().trim();
  if (!q.length) return [];
  const t = TABLE[kind];
  const rows = (await db.prepare(`SELECT id, text FROM ${t.sql} WHERE ${t.open} ORDER BY id LIMIT 60`).bind().all<{ id: number; text: string }>()).results;
  const hits = rows.filter((r) => { const w = new Set(words(r.text)); return q.every((x) => w.has(x)) || r.text.toLowerCase().includes(phrase); }).slice(0, 5);
  for (const h of hits) await db.prepare(`UPDATE ${t.sql} SET state = ? WHERE id = ?`).bind(state, h.id).run();
  return hits.map((h) => h.text);
}

// ---- closed items are history: keep them out of what the model reads ------------------------------------------------------
// A dropped goal still lives in older facts, nightly summaries, recalled messages and Rafiki's own earlier replies, and the
// model re-reads all four every turn. Telling it to ignore them was not enough (2026-10-16: it kept leading with a target the
// owner had dropped), so what restates a closed item is taken out before the model sees it.

export interface ClosedItem { kind: string; text: string; state: string }
export const CLOSED_SQL = "SELECT 'goal' AS k, text, state FROM (SELECT text, state FROM goals WHERE state != 'open' ORDER BY id DESC LIMIT 8) UNION ALL SELECT 'task', text, state FROM (SELECT text, state FROM tasks WHERE state != 'open' ORDER BY id DESC LIMIT 14) UNION ALL SELECT 'reminder', text, state FROM (SELECT text, state FROM reminders WHERE state IN ('done', 'dropped') AND text NOT LIKE 'Coming up %' ORDER BY id DESC LIMIT 8)";
export async function loadClosed(db: Db): Promise<ClosedItem[]> {
  return (await db.prepare(CLOSED_SQL).bind().all<{ k: string; text: string; state: string }>()).results.map((r) => ({ kind: r.k, text: r.text, state: r.state }));
}

/** True when the text shares at least three distinctive words with a closed item: it is talking about the same thing. */
export function retiredBy(text: string, closed: readonly string[]): boolean {
  const w = new Set(words(text));
  return closed.some((c) => { let n = 0; for (const x of new Set(words(c))) if (w.has(x) && ++n >= 3) return true; return false; });
}
/** The sentences of a summary that do not restate a closed item. */
export function dropRetiredSentences(text: string, closed: readonly string[]): string {
  if (!closed.length) return text;
  return text.split(/(?<=[.!?])\s+/).filter((s) => !retiredBy(s, closed)).join(" ").trim();
}
/** Rafiki's own earlier replies that restate a closed item are left out of the recent conversation, so it does not echo itself. */
export function scrubHistory<T extends { role: string; text: string }>(history: readonly T[], closed: readonly string[]): T[] {
  return history.map((m) => (m.role === "assistant" && retiredBy(m.text, closed) ? { ...m, text: "[an earlier reply is left out: it mentioned items the owner has since closed]" } : m));
}
/** Facts about a project or piece of work that restate a closed item are history. Routines, rules and preferences are kept. */
export const FILTERED_FACT_CATEGORIES = new Set(["projects", "work", "other", "people", "money", "family"]);
