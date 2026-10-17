// Proactive behaviour: reminder sweep with chasing, the morning brief, the Monday customer check.
// Interrupt budget: user-set reminders and the user-scheduled brief are exempt; unsolicited nudges are counted.
import { capUsd, dailyCost, type Ctx } from "./agent.ts";
import { briefLine, getEvents, conflicts } from "./calendar.ts";
import { canNudge, isPaused, logOut } from "./budget.ts";
import { feedbackRow } from "./feedback.ts";
import { candidates, FOCUS_BUTTONS, focusLines, todays, weekScore } from "./focus.ts";
import { maybeGoalReview, staleNudge } from "./panels.ts";
import { ensureNext } from "./remind.ts";
import { getSetting, setSetting } from "./db.ts";
import { loadPolicy, recordSignal } from "./policy.ts";
import { loadPrefs } from "./prefs.ts";
import { birthdayLine } from "./vcard.ts";
import { creditLeft } from "./llm.ts";
import { inboxLine } from "./gmail.ts";
import { kes } from "./spend.ts";
import type { Attach, Telegram } from "./telegram.ts";
import { fmtDate, fmtDateTime, fmtTime, inQuietHours, minutesOfDay, parseHM, startOfLocalDay, weekday } from "./time.ts";

export { canNudge, isPaused };

export const CHASE_GAP_MS = 2 * 3600000;
export const MAX_CHASES = 3;

export interface Rem { id: number; text: string; due_ts: number; chase_count: number; repeat: string; mode?: string | null; gap_ms?: number | null; max_chase?: number | null; a_kind?: string | null; a_file?: string | null; a_name?: string | null }

/** Pure: what happens to a reminder after it is sent, under the rule it was created with (older reminders chase as before). */
export function afterSend(r: Rem, now: number): { state: "open" | "flagged" | "sent" | "awaiting"; due_ts: number; chase_count: number } {
  const chase = r.chase_count + 1;
  if (r.mode === "once") return { state: "sent", due_ts: r.due_ts, chase_count: chase };
  if (r.mode === "confirm") return { state: "awaiting", due_ts: r.due_ts, chase_count: chase };
  if (chase > (r.max_chase ?? MAX_CHASES)) return { state: "flagged", due_ts: r.due_ts, chase_count: chase };
  return { state: "open", due_ts: now + (r.gap_ms ?? CHASE_GAP_MS), chase_count: chase };
}

export async function sweepReminders(ctx: Ctx, tg: Telegram, chatId: number): Promise<number> {
  if (await isPaused(ctx)) return 0;
  const qs = (await getSetting(ctx.db, "quiet_start")) ?? "21:00";
  const qe = (await getSetting(ctx.db, "quiet_end")) ?? "05:30";
  const quiet = inQuietHours(ctx.now, ctx.off, qs, qe);
  const due = await ctx.db.prepare("SELECT r.id, r.text, r.due_ts, r.chase_count, r.repeat, p.mode, p.gap_ms, p.max_chase, a.kind AS a_kind, a.file_id AS a_file, a.name AS a_name FROM reminders r LEFT JOIN reminder_policy p ON p.reminder_id = r.id LEFT JOIN reminder_attach a ON a.reminder_id = r.id WHERE r.state = 'open' AND r.due_ts <= ? ORDER BY r.due_ts LIMIT 5").bind(ctx.now).all<Rem>();
  let sent = 0;
  for (const r of due.results) {
    if (quiet && r.chase_count > 0) continue; // first delivery always goes out; chases wait for the morning
    const label = r.chase_count > 0 ? `Still open: ${r.text}` : `Reminder: ${r.text}`;
    const rows = [[{ text: "Done", data: `r:d:${r.id}` }, { text: "In 1 hour", data: `r:s:${r.id}` }, { text: "Tomorrow", data: `r:t:${r.id}` }], [{ text: "Next week", data: `r:n:${r.id}` }, { text: r.repeat !== "none" ? "Stop repeating" : "Cancel", data: `r:x:${r.id}` }]];
    if (r.chase_count > 0) rows.push(feedbackRow("chase")); // a reminder you set is not rated; a chase is a nudge
    // The attachment comes back with the first delivery, as one message: the file, the reminder as its caption, and the buttons.
    // If Telegram refuses the stored file, the plain reminder still goes out.
    const att = r.a_kind && r.a_file && r.chase_count === 0 ? { kind: r.a_kind as Attach["kind"], fileId: r.a_file, name: r.a_name ?? "file" } : null;
    if (!att || !(await tg.sendStored(chatId, att, label, rows))) await tg.send(chatId, label, rows);
    if (r.repeat !== "none" && r.chase_count === 0) await ensureNext(ctx.db, r, ctx.now, ctx.off); // a repeat carries on even if Done is never tapped
    const next = afterSend(r, ctx.now);
    await ctx.db.prepare("UPDATE reminders SET state = ?, due_ts = ?, chase_count = ?, last_sent_ts = ? WHERE id = ?").bind(next.state, next.due_ts, next.chase_count, ctx.now, r.id).run();
    if (next.state === "flagged") await recordSignal(ctx.db, ctx.now, "chase_ignored", String(r.id));
    await logOut(ctx, "reminder", false);
    sent++;
  }
  return sent;
}

/** The morning brief. Its list is the same one the One is picked from (focus.ts candidates), so anything dropped, parked or
 *  past its date is out of both. `scheduled` adds the once-a-week line about parked tasks. */
export async function buildBrief(ctx: Ctx, scheduled = false): Promise<string> {
  const { db, now, off } = ctx;
  const dayStart = startOfLocalDay(now, off);
  const dayEnd = dayStart + 86400000;
  const lines = [`Morning. ${fmtDateTime(now, off).split(" ").slice(0, 2).join(" ")}`];
  // The One leads; the rest of the list is there, but smaller, so the day has one clear priority.
  const one = await focusLines(db, now, off);
  lines.push(...one);
  const f = await todays(db, now, off);
  const rest = (await candidates(db, now, off)).filter((c) => !f || (c.ref !== f.ref && c.text !== f.text)).map((c) => c.label ?? c.text)
    .slice(0, Math.max(0, (await loadPolicy(db)).policy.briefItems - (one.length ? 1 : 0)));
  if (rest.length) { lines.push(one.length ? "Also on your plate:" : "Top of your list:"); rest.forEach((t) => lines.push(`- ${t}`)); }
  if (!one.length && !rest.length) lines.push("Nothing on your list yet. Tell me one thing that matters today.");
  const stale = scheduled ? await staleNudge(db, now) : null;
  if (stale) lines.push(stale);
  const evs = await getEvents(db, dayStart, dayEnd + 86400000);
  const cal = briefLine(evs, now, off);
  if (cal) lines.push(cal);
  const bday = (await loadPrefs(db))["birthdays.brief"] === "none" ? null : await birthdayLine(ctx);
  if (bday) lines.push(bday);
  const clash = conflicts(evs.filter((e) => e.start < dayEnd))[0];
  if (clash) lines.push(`Heads up: ${clash[0].title} overlaps ${clash[1].title} at ${fmtTime(clash[1].start, off)}.`);
  const y = await db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS a, COALESCE(SUM(fee_cents),0) AS f FROM spends WHERE ts >= ? AND ts < ?").bind(dayStart - 86400000, dayStart).first<{ a: number; f: number }>();
  if (y && Number(y.a) > 0) lines.push(`Spent yesterday: ${kes(Number(y.a))} (fees ${kes(Number(y.f))})`);
  const inbox = await inboxLine(ctx);
  if (inbox) lines.push(inbox);

  return lines.slice(0, 10).join("\n");
}

export async function maybeBrief(ctx: Ctx, tg: Telegram, chatId: number): Promise<boolean> {
  if (await isPaused(ctx)) return false;
  const want = parseHM((await getSetting(ctx.db, "brief_time")) ?? "08:00") ?? 480;
  const nowM = minutesOfDay(ctx.now, ctx.off);
  const today = fmtDate(ctx.now, ctx.off);
  if (nowM < want || nowM >= want + 60) return false; // a one-hour window so a missed cron tick still delivers
  if ((await getSetting(ctx.db, "brief_sent_date")) === today) return false;
  await setSetting(ctx.db, "brief_sent_date", today);
  const brief = await buildBrief(ctx, true); // picks today's One if there is none yet
  await tg.send(chatId, brief, [...((await todays(ctx.db, ctx.now, ctx.off)) ? [FOCUS_BUTTONS] : []), [{ text: "Plan my day", data: "say:Plan my day" }], feedbackRow("brief")]);
  await logOut(ctx, "brief", false);
  await maybeGoalReview(ctx, tg, chatId); // a goal past its date is asked about once a week, right after the brief
  await creditAlert(ctx, tg, chatId);
  return true;
}

/** OpenRouter balance: said once when it drops below USD 2, once when it runs out, and again only after a top-up. */
export async function creditAlert(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  const left = await creditLeft(ctx.env, ctx.f);
  if (left === null) return;
  const stage = left < 0.05 ? "out" : left < 2 ? "low" : "ok";
  const was = (await getSetting(ctx.db, "credit_alert")) ?? "ok";
  if (stage === was) return;
  await setSetting(ctx.db, "credit_alert", stage);
  if (stage === "low") await tg.send(chatId, `Model credit is getting low: USD ${left.toFixed(2)} left on OpenRouter. Top up at openrouter.ai/settings/credits when convenient.`);
  if (stage === "out") await tg.send(chatId, "Model credit has run out on OpenRouter, so I can only do simple things. Top up at openrouter.ai/settings/credits.");
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
  const score = await weekScore(ctx.db, ctx.now, ctx.off);
  const lines = [...(score ? [score] : []), "Monday check: who moved a rung this week?"];
  if (led.results.length) for (const l of led.results) lines.push(`- ${l.prospect}: rung ${l.rung}${l.next_ask ? `, next ask: ${l.next_ask}` : ""}`);
  else lines.push("Your customer ledger is empty. Name one person to approach this week and what you would ask them for.");
  await tg.send(chatId, lines.join("\n"), [[{ text: "Update ledger", data: "say:Update my customer ledger" }], feedbackRow("monday")]);
  await logOut(ctx, "monday-ledger", true);
  return true;
}
