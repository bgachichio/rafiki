// Thin typed helpers over D1. Everything is parameterised. Tests run the same SQL on node:sqlite through a shim.
import { indexText } from "./memory.ts";

export interface Db {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  };
}

export async function getSetting(db: Db, key: string): Promise<string | null> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r ? r.value : null;
}
export async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}
export async function markSeen(db: Db, updateId: number, now: number): Promise<boolean> {
  const r = await db.prepare("INSERT INTO seen_updates (update_id, ts) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING update_id").bind(updateId, now).first();
  if (!r) return false;
  if (updateId % 50 === 0) await db.prepare("DELETE FROM seen_updates WHERE ts < ?").bind(now - 7 * 86400000).run();
  return true;
}
/** Every message is kept forever and indexed for search. */
export async function addMessage(db: Db, ts: number, role: "user" | "assistant", text: string): Promise<number> {
  const t = text.slice(0, 4000);
  const r = await db.prepare("INSERT INTO messages (ts, role, text) VALUES (?, ?, ?) RETURNING id").bind(ts, role, t).first<{ id: number }>();
  const id = Number(r?.id ?? 0);
  if (id) await indexText(db, "message", id, t);
  return id;
}
export async function recentMessages(db: Db, n: number): Promise<{ id: number; role: string; text: string }[]> {
  const r = await db.prepare("SELECT id, role, text FROM messages ORDER BY id DESC LIMIT ?").bind(n).all<{ id: number; role: string; text: string }>();
  return r.results.reverse();
}
