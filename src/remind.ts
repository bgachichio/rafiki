// Reminder workflows beyond the first send: repeats that carry on by themselves (daily, weekly, weekdays, monthly), a list the
// owner can act on (/reminders), a reschedule by words, and one-tap moves. Nothing here deletes: cancelling sets a state.
import type { Ctx } from "./agent.ts";
import type { Db } from "./db.ts";
import { loadPolicy } from "./policy.ts";
import type { Button, Telegram } from "./telegram.ts";
import { fmtDate, fmtTime, parseHM, startOfLocalDay } from "./time.ts";

export const REPEATS = ["none", "daily", "weekly", "weekdays", "monthly"] as const;
export type Repeat = (typeof REPEATS)[number];
export const isRepeat = (v: unknown): v is Repeat => typeof v === "string" && (REPEATS as readonly string[]).includes(v);
/** A monthly reminder is stored as "monthly:31" so a short month never moves it for good (31 January, 28 February, 31 March). */
export const monthlyAnchor = (dueMs: number, off: number): string => `monthly:${new Date(dueMs + off * 60000).getUTCDate()}`;
const DAY = 86400000;

/** The next occurrence after `due` that is still ahead of `now`, keeping the local time of day. Monthly keeps the day of the
 *  month (clamped to the month's length: the 31st becomes the 30th, or the 28th in February). */
export function nextRepeat(due: number, repeat: string, off: number, now: number): number | null {
  if (repeat !== "daily" && repeat !== "weekly" && repeat !== "weekdays" && !/^monthly(:\d{1,2})?$/.test(repeat)) return null;
  // Always at least one step: a reminder being chased has a due time in the near future that is not its next occurrence.
  let next = stepOnce(due, repeat, off);
  for (let i = 0; i < 800 && next <= now; i++) next = stepOnce(next, repeat, off);
  return next > now ? next : null;
}
function stepOnce(t: number, repeat: string, off: number): number {
  if (repeat === "daily") return t + DAY;
  if (repeat === "weekly") return t + 7 * DAY;
  if (repeat === "weekdays") {
    let n = t + DAY;
    for (let i = 0; i < 3; i++) { const wd = new Date(n + off * 60000).getUTCDay(); if (wd >= 1 && wd <= 5) break; n += DAY; }
    return n;
  }
  const l = new Date(t + off * 60000);
  const y = l.getUTCFullYear(), m = l.getUTCMonth() + 1;
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const anchor = Number(/:(\d{1,2})$/.exec(repeat)?.[1]) || l.getUTCDate();
  return Date.UTC(y, m, Math.min(anchor, days), l.getUTCHours(), l.getUTCMinutes()) - off * 60000;
}

export const repeatText = (r: string): string => (r === "daily" ? "every day" : r === "weekly" ? "every week" : r === "weekdays" ? "every weekday" : r.startsWith("monthly") ? "every month" : "");

/** A reminder with a warning ahead has separate "Coming up ...: <text>" copies. Cancelling or closing the reminder must take them too,
 *  or the warning still fires for something the owner has cancelled. */
export async function dropHeadsUps(db: Db, text: string): Promise<void> {
  await db.prepare("UPDATE reminders SET state = 'dropped' WHERE state = 'open' AND text LIKE 'Coming up %' AND substr(text, instr(text, ': ') + 2) = ?").bind(text).run();
}

interface RepRow { id: number; text: string; due_ts: number; repeat: string }

/** Make sure a repeating reminder has its next occurrence waiting, whether or not the owner ever taps Done. It is created when
 *  the reminder is first sent, so a repeat never ends because a tap was missed; asking twice never creates two. */
export async function ensureNext(db: Db, r: RepRow, now: number, off: number): Promise<number | null> {
  const next = nextRepeat(r.due_ts, r.repeat, off, now);
  if (next === null) return null;
  // The successor is the one due around `next`. An earlier occurrence still being chased is due soon too, but it is not the successor.
  const have = await db.prepare("SELECT id FROM reminders WHERE text = ? AND repeat = ? AND state = 'open' AND due_ts BETWEEN ? AND ? AND id != ? LIMIT 1").bind(r.text, r.repeat, next - 43200000, next + 43200000, r.id).first<{ id: number }>();
  if (have) return null;
  const nr = await db.prepare("INSERT INTO reminders (ts, text, due_ts, repeat) VALUES (?, ?, ?, ?) RETURNING id").bind(now, r.text, next, r.repeat).first<{ id: number }>();
  const id = Number(nr?.id);
  await db.prepare("INSERT OR IGNORE INTO reminder_policy (reminder_id, mode, gap_ms, max_chase) SELECT ?, mode, gap_ms, max_chase FROM reminder_policy WHERE reminder_id = ?").bind(id, r.id).run();
  await db.prepare("INSERT OR IGNORE INTO reminder_attach (reminder_id, kind, file_id, name) SELECT ?, kind, file_id, name FROM reminder_attach WHERE reminder_id = ?").bind(id, r.id).run();
  return id;
}

/** "Tomorrow" and "next week" as moments, using the owner's own morning time. */
export async function snoozeTarget(ctx: Ctx, which: "tomorrow" | "week"): Promise<number> {
  const morning = parseHM((await loadPolicy(ctx.db)).policy.morning) ?? 540;
  const today = startOfLocalDay(ctx.now, ctx.off);
  if (which === "tomorrow") return today + DAY + morning * 60000;
  const wd = new Date(ctx.now + ctx.off * 60000).getUTCDay(); // next Monday
  const ahead = ((1 - wd + 7) % 7) || 7;
  return today + ahead * DAY + morning * 60000;
}

/** The open reminders that match the owner's words (all distinctive words present, or the phrase). Used to move one by words. */
const WORD = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !["the", "my", "to", "a", "an", "of", "reminder", "reminders"].includes(w));
export async function rescheduleMatching(db: Db, match: string, dueMs: number): Promise<{ moved: string[]; ambiguous: string[] }> {
  const q = WORD(match);
  const phrase = match.toLowerCase().trim();
  if (!q.length) return { moved: [], ambiguous: [] };
  const rows = (await db.prepare("SELECT id, text FROM reminders WHERE state IN ('open', 'flagged', 'awaiting') AND text NOT LIKE 'Coming up %' ORDER BY due_ts LIMIT 60").bind().all<{ id: number; text: string }>()).results;
  const hits = rows.filter((r) => { const w = new Set(WORD(r.text)); return q.every((x) => w.has(x)) || r.text.toLowerCase().includes(phrase); });
  if (hits.length > 1) return { moved: [], ambiguous: hits.map((h) => h.text) }; // a vague word moves nothing
  for (const h of hits) {
    const old = await db.prepare("SELECT due_ts FROM reminders WHERE id = ?").bind(h.id).first<{ due_ts: number }>();
    await db.prepare("UPDATE reminders SET state = 'open', due_ts = ?, chase_count = 0 WHERE id = ?").bind(dueMs, h.id).run();
    // The warning copies move by the same amount, so they still come the same time ahead of the new moment.
    if (old) await db.prepare("UPDATE reminders SET due_ts = due_ts + ? WHERE state = 'open' AND text LIKE 'Coming up %' AND substr(text, instr(text, ': ') + 2) = ?").bind(dueMs - Number(old.due_ts), h.text).run();
  }
  return { moved: hits.map((h) => h.text), ambiguous: [] };
}

// ---- /reminders ---------------------------------------------------------------------------------------------------------

export async function remindersPanel(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  const rows = (await ctx.db.prepare("SELECT id, text, due_ts, repeat, state FROM reminders WHERE state IN ('open', 'flagged', 'awaiting') AND text NOT LIKE 'Coming up %' ORDER BY due_ts LIMIT 8").bind().all<{ id: number; text: string; due_ts: number; repeat: string; state: string }>()).results;
  if (!rows.length) { await tg.send(chatId, "No reminders waiting. Tell me one, like: remind me to pay rent on the 28th, every month."); return; }
  const lines = rows.map((r, i) => `${i + 1}. ${fmtDate(r.due_ts, ctx.off)} ${fmtTime(r.due_ts, ctx.off)} ${r.text}${r.repeat !== "none" ? ` (${repeatText(r.repeat)})` : ""}${r.state === "flagged" || r.state === "awaiting" ? " (waiting on you)" : ""}`);
  const buttons: Button[][] = rows.map((r, i) => [{ text: `Tomorrow ${i + 1}`, data: `rm:t:${r.id}` }, { text: `Next week ${i + 1}`, data: `rm:w:${r.id}` }, { text: `Cancel ${i + 1}`, data: `rm:x:${r.id}` }]);
  await tg.send(chatId, `Your reminders. Tomorrow and Next week move one; Cancel stops it (and any repeat).\n${lines.join("\n")}`, buttons);
}

export async function remindersCallback(ctx: Ctx, tg: Telegram, chatId: number, data: string): Promise<boolean> {
  const m = /^rm:([twx]):(\d+)$/.exec(data);
  if (!m) return false;
  const id = Number(m[2]);
  if (m[1] === "x") {
    const row = await ctx.db.prepare("UPDATE reminders SET state = 'dropped' WHERE id = ? AND state IN ('open', 'flagged', 'awaiting') RETURNING text, repeat").bind(id).first<{ text: string; repeat: string }>();
    if (row && row.repeat !== "none") await ctx.db.prepare("UPDATE reminders SET state = 'dropped' WHERE text = ? AND repeat = ? AND state = 'open'").bind(row.text, row.repeat).run(); // the waiting next occurrence goes too
    if (row) await dropHeadsUps(ctx.db, row.text);
    await tg.send(chatId, row ? `Cancelled: ${row.text}${row.repeat !== "none" ? ` (and its repeat)` : ""}.` : "That reminder is already closed.");
  } else {
    const at = await snoozeTarget(ctx, m[1] === "t" ? "tomorrow" : "week");
    const row = await ctx.db.prepare("UPDATE reminders SET state = 'open', due_ts = ?, chase_count = 0 WHERE id = ? AND state IN ('open', 'flagged', 'awaiting') RETURNING text").bind(at, id).first<{ text: string }>();
    await tg.send(chatId, row ? `Moved to ${fmtDate(at, ctx.off)} ${fmtTime(at, ctx.off)}: ${row.text}` : "That reminder is already closed.");
  }
  await remindersPanel(ctx, tg, chatId);
  return true;
}
