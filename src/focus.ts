// The One: the chief-of-staff loop that keeps priorities in sight without adding decisions. Each morning Rafiki picks one
// focus from what is already on the owner's plate, so there is nothing to choose; one tap swaps or finishes it. An evening
// check closes the day. A streak rewards consistency but forgives one missed day a week, so it never becomes a stick.
import type { Ctx } from "./agent.ts";
import { canNudge, isPaused, logOut } from "./budget.ts";
import { getSetting, setSetting, type Db } from "./db.ts";
import { recordSignal } from "./policy.ts";
import type { Button, Telegram } from "./telegram.ts";
import { fmtDate, minutesOfDay, parseHM, startOfLocalDay, weekday } from "./time.ts";

export interface Candidate { text: string; ref: string }
const DAY = 86400000;
const dayKey = (ms: number, off: number): string => fmtDate(ms, off).split(" ").pop()!; // "Sat 10-10-2026" -> "10-10-2026"

/** What could be today's One, best first: overdue, then due today, then the oldest open task, then a step on a goal. */
export async function candidates(db: Db, now: number, off: number): Promise<Candidate[]> {
  const end = startOfLocalDay(now, off) + DAY;
  const out: Candidate[] = [];
  const over = await db.prepare("SELECT id, text FROM reminders WHERE state IN ('flagged','awaiting') ORDER BY due_ts LIMIT 2").bind().all<{ id: number; text: string }>();
  for (const r of over.results) out.push({ text: `Overdue, still open: ${r.text}`, ref: `r:${r.id}` });
  const today = await db.prepare("SELECT id, text FROM reminders WHERE state = 'open' AND due_ts < ? AND text NOT LIKE 'Coming up %' ORDER BY due_ts LIMIT 3").bind(end).all<{ id: number; text: string }>();
  for (const r of today.results) out.push({ text: r.text, ref: `r:${r.id}` });
  const tasks = await db.prepare("SELECT id, text FROM tasks WHERE state = 'open' ORDER BY id LIMIT 3").bind().all<{ id: number; text: string }>();
  for (const t of tasks.results) out.push({ text: t.text, ref: `t:${t.id}` });
  const goal = await db.prepare("SELECT id, text FROM goals WHERE state = 'open' ORDER BY id LIMIT 1").bind().first<{ id: number; text: string }>();
  if (goal) out.push({ text: `One step on: ${goal.text}`, ref: `g:${goal.id}` });
  // Anything the owner dropped as the One in the last 30 days is not offered again, whatever list it still sits on.
  const dropped = new Set((await db.prepare("SELECT text, ref FROM focus WHERE state = 'dropped' AND ts >= ?").bind(now - 30 * DAY).all<{ text: string; ref: string | null }>()).results.flatMap((r) => [r.text, r.ref ?? ""]).filter(Boolean));
  const seen = new Set<string>();
  return out.filter((c) => !dropped.has(c.text) && !dropped.has(c.ref) && (seen.has(c.text) ? false : (seen.add(c.text), true)));
}

export interface Focus { day: string; text: string; ref: string | null; state: string }
export async function todays(db: Db, now: number, off: number): Promise<Focus | null> {
  return db.prepare("SELECT day, text, ref, state FROM focus WHERE day = ?").bind(dayKey(now, off)).first<Focus>();
}

/** Today's One, picked now if there is none yet. Null only when the owner has nothing on their plate at all. */
export async function ensureToday(db: Db, now: number, off: number): Promise<Focus | null> {
  const have = await todays(db, now, off);
  if (have) return have;
  const c = (await candidates(db, now, off))[0];
  if (!c) return null;
  await db.prepare("INSERT OR IGNORE INTO focus (day, ts, text, ref) VALUES (?, ?, ?, ?)").bind(dayKey(now, off), now, c.text, c.ref).run();
  return { day: dayKey(now, off), text: c.text, ref: c.ref, state: "open" };
}

/** Consecutive days with the One done, walking back from today. Days with no One are neutral, and one missed day in any
 *  seven is forgiven (a "rest day"), so a single bad day never wipes out a run. Today counts only once it is done. */
export async function streak(db: Db, now: number, off: number): Promise<{ days: number; restUsed: boolean }> {
  const rows = (await db.prepare("SELECT day, state FROM focus WHERE ts >= ?").bind(now - 70 * DAY).all<{ day: string; state: string }>()).results;
  const by = new Map(rows.map((r) => [r.day, r.state]));
  let days = 0, lastRest = -99, restUsed = false;
  for (let i = 0; i < 70; i++) {
    const st = by.get(dayKey(now - i * DAY, off));
    if (st === undefined) continue;
    if (st === "done") { days++; continue; }
    if (i === 0) continue; // today is still open
    if (i - lastRest >= 7) { lastRest = i; restUsed = true; continue; }
    break;
  }
  return { days, restUsed };
}

export async function focusLines(db: Db, now: number, off: number): Promise<string[]> {
  const f = await ensureToday(db, now, off);
  if (!f) return [];
  const s = await streak(db, now, off);
  const lines = [`Today's One: ${f.text}${f.state === "done" ? " (done)" : ""}`];
  if (s.days >= 2) lines.push(`Focus streak: ${s.days} days.`);
  return lines;
}
export const FOCUS_BUTTONS: Button[] = [{ text: "One done", data: "f:done" }, { text: "Swap it", data: "f:swap" }];

/** Close the underlying reminder or task too, so nothing chases what is already finished. */
async function closeRef(db: Db, ref: string | null, state: "done" | "dropped" = "done"): Promise<void> {
  const m = /^([rt]):(\d+)$/.exec(ref ?? "");
  if (!m) return;
  await db.prepare(m[1] === "r" ? "UPDATE reminders SET state = ? WHERE id = ?" : "UPDATE tasks SET state = ? WHERE id = ?").bind(state, Number(m[2])).run();
}

export async function focusCallback(ctx: Ctx, tg: Telegram, chatId: number, data: string): Promise<boolean> {
  if (!data.startsWith("f:")) return false;
  const { db, now, off } = ctx;
  const key = dayKey(now, off);
  const f = await ensureToday(db, now, off);
  if (!f) { await tg.send(chatId, "Nothing is on your plate yet. Tell me the one thing that would make today a good day, and I'll hold it."); return true; }
  if (data === "f:done") {
    await db.prepare("UPDATE focus SET state = 'done', done_ts = ? WHERE day = ?").bind(now, key).run();
    await closeRef(db, f.ref);
    const s = await streak(db, now, off);
    const next = (await candidates(db, now, off)).find((c) => c.ref !== f.ref);
    await tg.send(chatId, `Done: ${f.text}. ${s.days >= 2 ? `That's ${s.days} days in a row.` : "That's the day won."}${next ? ` If you have energy left: ${next.text}.` : ""}`);
    return true;
  }
  if (data === "f:swap") {
    const opts = (await candidates(db, now, off)).filter((c) => c.text !== f.text).slice(0, 3);
    const rows: Button[][] = opts.map((c, i) => [{ text: c.text.slice(0, 40), data: `f:pick:${i}` }]);
    await setSetting(db, "focus_opts", JSON.stringify(opts));
    await tg.send(chatId, opts.length ? "Swap today's One for:" : "There's nothing else on your list. Tell me the one thing you'd rather do, starting with: one:", rows);
    return true;
  }
  const pick = /^f:pick:(\d)$/.exec(data);
  if (pick) {
    const c = (JSON.parse((await getSetting(db, "focus_opts")) || "[]") as Candidate[])[Number(pick[1])];
    if (!c) { await tg.send(chatId, "That choice has expired. Tap Swap it again."); return true; }
    await db.prepare("UPDATE focus SET text = ?, ref = ?, state = 'open' WHERE day = ?").bind(c.text, c.ref, key).run();
    await tg.send(chatId, `Today's One is now: ${c.text}`, [FOCUS_BUTTONS]);
    return true;
  }
  if (data === "f:tmr") {
    await db.prepare("UPDATE focus SET state = 'moved' WHERE day = ?").bind(key).run();
    await db.prepare("INSERT OR REPLACE INTO focus (day, ts, text, ref) VALUES (?, ?, ?, ?)").bind(dayKey(now + DAY, off), now + DAY, f.text, f.ref).run();
    await tg.send(chatId, "Moved to tomorrow's One. Rest well.");
    return true;
  }
  if (data === "f:drop") {
    // Dropping the One drops the thing itself: the reminder or task behind it is closed, so it cannot come back tomorrow.
    await db.prepare("UPDATE focus SET state = 'dropped' WHERE day = ?").bind(key).run();
    await closeRef(db, f.ref, "dropped");
    await recordSignal(db, now, "one_dropped", f.ref ?? f.text.slice(0, 80));
    await tg.send(chatId, `Dropped for good: ${f.text.replace(/^Overdue, still open: /, "")}. It won't come back as your One. Not everything deserves doing; that was a decision, not a failure.`);
    return true;
  }
  return false;
}

/** "one: finish the deck" (or /one finish the deck) sets today's One in the owner's own words. */
export async function setOwnFocus(ctx: Ctx, tg: Telegram, chatId: number, text: string): Promise<void> {
  const t = text.trim().slice(0, 200);
  if (!t) {
    const lines = await focusLines(ctx.db, ctx.now, ctx.off);
    await tg.send(chatId, lines.length ? lines.join("\n") : "No One yet today. Send one: <the thing that would make today a good day>.", lines.length ? [FOCUS_BUTTONS] : undefined);
    return;
  }
  await ctx.db.prepare("INSERT INTO focus (day, ts, text, ref, state) VALUES (?, ?, ?, NULL, 'open') ON CONFLICT(day) DO UPDATE SET text = excluded.text, ref = NULL, state = 'open'").bind(dayKey(ctx.now, ctx.off), ctx.now, t).run();
  await tg.send(chatId, `Today's One: ${t}. I'll check in this evening.`, [FOCUS_BUTTONS]);
}

/** The evening close: one question, three taps, then silence. Weekends are skipped unless the owner set a One themselves. */
export async function maybeShutdown(ctx: Ctx, tg: Telegram, chatId: number): Promise<boolean> {
  if (await isPaused(ctx)) return false;
  const want = parseHM((await getSetting(ctx.db, "shutdown_time")) || "18:30") ?? 1110;
  const m = minutesOfDay(ctx.now, ctx.off);
  if (m < want || m >= want + 90) return false;
  const key = dayKey(ctx.now, ctx.off);
  if ((await getSetting(ctx.db, "shutdown_sent")) === key) return false;
  const f = await todays(ctx.db, ctx.now, ctx.off);
  if (!f || f.state !== "open") return false;
  const wd = weekday(ctx.now, ctx.off);
  if ((wd === 0 || wd === 6) && f.ref !== null) return false;
  if (!(await canNudge(ctx))) return false;
  await setSetting(ctx.db, "shutdown_sent", key);
  await tg.send(chatId, `Closing the day. Did today's One happen? ${f.text}`, [[{ text: "Done", data: "f:done" }, { text: "Tomorrow", data: "f:tmr" }, { text: "Drop it", data: "f:drop" }]]);
  await logOut(ctx, "shutdown", true);
  return true;
}

/** Last week's score for the Monday check: Ones done out of Ones set, and the streak. */
export async function weekScore(db: Db, now: number, off: number): Promise<string | null> {
  const from = startOfLocalDay(now, off) - 7 * DAY;
  const r = await db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(state = 'done'), 0) AS d FROM focus WHERE ts >= ? AND ts < ?").bind(from, startOfLocalDay(now, off)).first<{ n: number; d: number }>();
  if (!r || !Number(r.n)) return null;
  const s = await streak(db, now - DAY, off);
  const n = Number(r.n), d = Number(r.d);
  const bar = "▓".repeat(d) + "░".repeat(Math.max(0, n - d));
  return `Last week: ${d} of ${n} Ones done ${bar}${s.days >= 2 ? `, streak ${s.days}` : ""}.`;
}
