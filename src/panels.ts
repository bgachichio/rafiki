// /tasks and /goals: see what is open, and close any of it with one tap. Also the one-time card for a goal that has passed
// its date, and the weekly line about parked tasks. Nothing here deletes; a close only changes the state.
import type { Ctx } from "./agent.ts";
import { getSetting, setSetting, type Db } from "./db.ts";
import { ageDays, dateAhead, DAY_MS, isLapsed, STALE_TASK_DAYS, staleBefore } from "./lifecycle.ts";
import type { Button, Telegram } from "./telegram.ts";

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}...` : s);

export async function tasksPanel(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  const rows = (await ctx.db.prepare("SELECT id, text, ts FROM tasks WHERE state = 'open' ORDER BY id LIMIT 8").bind().all<{ id: number; text: string; ts: number }>()).results;
  if (!rows.length) { await tg.send(chatId, "No open tasks. Tell me one, or leave it clear."); return; }
  const lines = rows.map((t, i) => {
    const age = ageDays(t.ts, ctx.now);
    return `${i + 1}. ${t.text} (${age === 0 ? "today" : `${age} day${age === 1 ? "" : "s"} old`}${age >= STALE_TASK_DAYS ? ", parked: not on your list or your One" : ""})`;
  });
  const buttons: Button[][] = rows.map((t, i) => [{ text: `Done ${i + 1}`, data: `tk:d:${t.id}` }, { text: `Drop ${i + 1}`, data: `tk:x:${t.id}` }]);
  await tg.send(chatId, `Open tasks. Done finishes it; Drop means it no longer matters, and it never comes back.\n${lines.join("\n")}`, buttons);
}

export async function goalsPanel(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  const rows = (await ctx.db.prepare("SELECT id, text, target, by_date FROM goals WHERE state = 'open' ORDER BY id").bind().all<{ id: number; text: string; target: string | null; by_date: string | null }>()).results;
  if (!rows.length) { await tg.send(chatId, "No goals yet. Tell me one: what you want, how much, by when."); return; }
  const lines = rows.map((g, i) => `${i + 1}. ${g.text}${g.target ? ` (${g.target})` : ""}${g.by_date ? ` by ${g.by_date}` : ""}${isLapsed(g.by_date, ctx.now, ctx.off) ? " - date passed, not on your list" : ""}`);
  const buttons: Button[][] = rows.map((g, i) => [{ text: `Hit ${i + 1}`, data: `gl:hit:${g.id}` }, { text: `+30 days ${i + 1}`, data: `gl:ext:${g.id}` }, { text: `Drop ${i + 1}`, data: `gl:drop:${g.id}` }]);
  await tg.send(chatId, `Your goals. Hit means you did it; +30 days moves the date; Drop closes it for good.\n${lines.join("\n")}`, buttons);
}

/** One goal that has passed its date, asked about at most once a week, right after the brief: hit, move it, or close it. */
export async function maybeGoalReview(ctx: Ctx, tg: Telegram, chatId: number): Promise<boolean> {
  const rows = (await ctx.db.prepare("SELECT id, text, by_date FROM goals WHERE state = 'open' AND by_date IS NOT NULL ORDER BY id").bind().all<{ id: number; text: string; by_date: string }>()).results;
  for (const g of rows) {
    if (!isLapsed(g.by_date, ctx.now, ctx.off)) continue;
    const key = `goal_review_${g.id}`;
    if (ctx.now - Number((await getSetting(ctx.db, key)) || 0) < 7 * DAY_MS) continue;
    await setSetting(ctx.db, key, String(ctx.now));
    await tg.send(chatId, `"${g.text}" passed its date (${g.by_date}). I have taken it off your list and your One. What happened?`, [[{ text: "I hit it", data: `gl:hit:${g.id}` }, { text: "+30 days", data: `gl:ext:${g.id}` }, { text: "Close it", data: `gl:drop:${g.id}` }]]);
    return true;
  }
  return false;
}

/** At most once a week: how many tasks are parked, and where to tidy them. Null when there are none or it was said recently. */
export async function staleNudge(db: Db, now: number): Promise<string | null> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE state = 'open' AND ts <= ?").bind(staleBefore(now)).first<{ n: number }>();
  const n = Number(r?.n ?? 0);
  if (!n || now - Number((await getSetting(db, "stale_nudge")) || 0) < 7 * DAY_MS) return null;
  await setSetting(db, "stale_nudge", String(now));
  return `${n} task${n === 1 ? " is" : "s are"} over a week old and left off your list. /tasks to tidy.`;
}

export async function panelCallback(ctx: Ctx, tg: Telegram, chatId: number, data: string): Promise<boolean> {
  const t = /^tk:([dx]):(\d+)$/.exec(data);
  if (t) {
    const row = await ctx.db.prepare("UPDATE tasks SET state = ?, done_ts = ? WHERE id = ? AND state = 'open' RETURNING text").bind(t[1] === "d" ? "done" : "dropped", ctx.now, Number(t[2])).first<{ text: string }>();
    await tg.send(chatId, row ? (t[1] === "d" ? `Done: ${row.text}.` : `Dropped for good: ${row.text}.`) : "That task is already closed.");
    await tasksPanel(ctx, tg, chatId);
    return true;
  }
  const g = /^gl:(hit|ext|drop):(\d+)$/.exec(data);
  if (!g) return false;
  const id = Number(g[2]);
  if (g[1] === "ext") {
    const by = dateAhead(ctx.now, ctx.off, 30);
    const row = await ctx.db.prepare("UPDATE goals SET by_date = ? WHERE id = ? AND state = 'open' RETURNING text").bind(by, id).first<{ text: string }>();
    await tg.send(chatId, row ? `New date for "${row.text}": ${by}. Tell me if you want a different one.` : "That goal is already closed.");
  } else {
    const row = await ctx.db.prepare("UPDATE goals SET state = ? WHERE id = ? AND state = 'open' RETURNING text").bind(g[1] === "hit" ? "done" : "dropped", id).first<{ text: string }>();
    await tg.send(chatId, row ? (g[1] === "hit" ? `Goal hit: ${row.text}. Tell me the next one when you are ready.` : `Closed for good: ${row.text}. It won't come back.`) : "That goal is already closed.");
  }
  return true;
}
