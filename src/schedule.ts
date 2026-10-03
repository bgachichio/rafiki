// Proactive behaviour: reminder sweep with chasing, the morning brief, the Monday customer check.
// Interrupt budget: user-set reminders and the user-scheduled brief are exempt; unsolicited nudges are counted.
import { capUsd, dailyCost, type Ctx } from "./agent.ts";
import { briefLine, getEvents, conflicts } from "./calendar.ts";
import { canNudge, isPaused, logOut } from "./budget.ts";
import { feedbackRow } from "./feedback.ts";
import { getSetting, setSetting } from "./db.ts";
import { kes } from "./spend.ts";
import type { Telegram } from "./telegram.ts";
import { fmtDate, fmtDateTime, fmtTime, inQuietHours, minutesOfDay, parseHM, startOfLocalDay, weekday } from "./time.ts";

export { canNudge, isPaused };

export const CHASE_GAP_MS = 2 * 3600000;
export const MAX_CHASES = 3;

export interface Rem { id: number; text: string; due_ts: number; chase_count: number; repeat: string }

/** Pure: what happens to a reminder after it is sent. */
export function afterSend(r: Rem, now: number): { state: "open" | "flagged"; due_ts: number; chase_count: number } {
  const chase = r.chase_count + 1;
  if (chase > MAX_CHASES) return { state: "flagged", due_ts: r.due_ts, chase_count: chase };
  return { state: "open", due_ts: now + CHASE_GAP_MS, chase_count: chase };
}


export async function sweepReminders(ctx: Ctx, tg: Telegram, chatId: number): Promise<number> {
  if (await isPaused(ctx)) return 0;
  const qs = (await getSetting(ctx.db, "quiet_start")) ?? "21:00";
  const qe = (await getSetting(ctx.db, "quiet_end")) ?? "05:30";
  const quiet = inQuietHours(ctx.now, ctx.off, qs, qe);
  const due = await ctx.db.prepare("SELECT id, text, due_ts, chase_count, repeat FROM reminders WHERE state = 'open' AND due_ts <= ? ORDER BY due_ts LIMIT 5").bind(ctx.now).all<Rem>();
  let sent = 0;
  for (const r of due.results) {
    if (quiet && r.chase_count > 0) continue; // first delivery always goes out; chases wait for the morning
    const label = r.chase_count > 0 ? `Still open: ${r.text}` : `Reminder: ${r.text}`;
    const rows = [[{ text: "Done", data: `r:d:${r.id}` }, { text: "In 1 hour", data: `r:s:${r.id}` }, { text: "Tomorrow", data: `r:t:${r.id}` }]];
    if (r.chase_count > 0) rows.push(feedbackRow("chase")); // a reminder you set is not rated; a chase is a nudge
    await tg.send(chatId, label, rows);
    const next = afterSend(r, ctx.now);
    await ctx.db.prepare("UPDATE reminders SET state = ?, due_ts = ?, chase_count = ?, last_sent_ts = ? WHERE id = ?").bind(next.state, next.due_ts, next.chase_count, ctx.now, r.id).run();
    await logOut(ctx, "reminder", false);
    sent++;
  }
  return sent;
}

export async function buildBrief(ctx: Ctx): Promise<string> {
  const { db, now, off } = ctx;
  const dayStart = startOfLocalDay(now, off);
  const dayEnd = dayStart + 86400000;
  const items: string[] = [];
  const flagged = await db.prepare("SELECT text FROM reminders WHERE state = 'flagged' ORDER BY due_ts LIMIT 3").bind().all<{ text: string }>();
  for (const f of flagged.results) items.push(`Overdue, still open: ${f.text}`);
  const today = await db.prepare("SELECT text, due_ts FROM reminders WHERE state = 'open' AND due_ts < ? ORDER BY due_ts LIMIT 5").bind(dayEnd).all<{ text: string; due_ts: number }>();
  for (const t of today.results) items.push(`${fmtTime(t.due_ts, off)} ${t.text}`);
  const tasks = await db.prepare("SELECT text FROM tasks WHERE state = 'open' ORDER BY id LIMIT 5").bind().all<{ text: string }>();
  for (const t of tasks.results) items.push(t.text);
  const goal = await db.prepare("SELECT text, by_date FROM goals WHERE state = 'open' ORDER BY id LIMIT 1").bind().first<{ text: string; by_date: string | null }>();
  if (items.length < 3 && goal) items.push(`Move your goal forward: ${goal.text}${goal.by_date ? ` (by ${goal.by_date})` : ""}`);
  const top = items.slice(0, 3);

  const lines = [`Morning. ${fmtDateTime(now, off).split(" ").slice(0, 2).join(" ")}`];
  if (top.length) { lines.push("Top three today:"); top.forEach((t, i) => lines.push(`${i + 1}. ${t}`)); }
  else lines.push("Nothing on your list yet. Tell me one thing that matters today.");
  const evs = await getEvents(db, dayStart, dayEnd + 86400000);
  const cal = briefLine(evs, now, off);
  if (cal) lines.push(cal);
  const clash = conflicts(evs.filter((e) => e.start < dayEnd))[0];
  if (clash) lines.push(`Heads up: ${clash[0].title} overlaps ${clash[1].title} at ${fmtTime(clash[1].start, off)}.`);
  const y = await db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS a, COALESCE(SUM(fee_cents),0) AS f FROM spends WHERE ts >= ? AND ts < ?").bind(dayStart - 86400000, dayStart).first<{ a: number; f: number }>();
  if (y && Number(y.a) > 0) lines.push(`Spent yesterday: ${kes(Number(y.a))} (fees ${kes(Number(y.f))})`);
  const spentModel = await dailyCost(db, dayStart - 1, off);
  lines.push(`Rafiki cost yesterday: USD ${spentModel.toFixed(2)} of USD ${(await capUsd(ctx)).toFixed(2)} a day`);
  return lines.slice(0, 8).join("\n");
}

export async function maybeBrief(ctx: Ctx, tg: Telegram, chatId: number): Promise<boolean> {
  if (await isPaused(ctx)) return false;
  const want = parseHM((await getSetting(ctx.db, "brief_time")) ?? "08:00") ?? 480;
  const nowM = minutesOfDay(ctx.now, ctx.off);
  const today = fmtDate(ctx.now, ctx.off);
  if (nowM < want || nowM >= want + 60) return false; // a one-hour window so a missed cron tick still delivers
  if ((await getSetting(ctx.db, "brief_sent_date")) === today) return false;
  await setSetting(ctx.db, "brief_sent_date", today);
  await tg.send(chatId, await buildBrief(ctx), [[{ text: "Plan my day", data: "say:Plan my day" }], feedbackRow("brief")]);
  await logOut(ctx, "brief", false);
  return true;
}

export async function maybeMonday(ctx: Ctx, tg: Telegram, chatId: number): Promise<boolean> {
  if (await isPaused(ctx)) return false;
  if (weekday(ctx.now, ctx.off) !== 1) return false;
  const nowM = minutesOfDay(ctx.now, ctx.off);
  if (nowM < 7 * 60 + 30 || nowM >= 10 * 60) return false;
  const today = fmtDate(ctx.now, ctx.off);
  if ((await getSetting(ctx.db, "monday_sent_date")) === today) return false;
  if (!(await canNudge(ctx))) return false;
  await setSetting(ctx.db, "monday_sent_date", today);
  const led = await ctx.db.prepare("SELECT prospect, rung, next_ask FROM ledger ORDER BY rung DESC, last_move_ts DESC LIMIT 5").bind().all<{ prospect: string; rung: number; next_ask: string | null }>();
  const lines = ["Monday check: who moved a rung this week?"];
  if (led.results.length) for (const l of led.results) lines.push(`- ${l.prospect}: rung ${l.rung}${l.next_ask ? `, next ask: ${l.next_ask}` : ""}`);
  else lines.push("Your customer ledger is empty. Name one person to approach this week and what you would ask them for.");
  await tg.send(chatId, lines.join("\n"), [[{ text: "Update ledger", data: "say:Update my customer ledger" }], feedbackRow("monday")]);
  await logOut(ctx, "monday-ledger", true);
  return true;
}
