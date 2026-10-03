// Calendar: sync into a per-calendar cache, read it for the brief, the agent and /agenda, and warn before meetings.
import type { Ctx } from "./agent.ts";
import { decrypt, keyOf } from "./crypto.ts";
import type { Db } from "./db.ts";
import { getSetting, setSetting } from "./db.ts";
import { AuthExpired, accessToken, googleConfigured, listCalendars, listEvents, type RawEvent } from "./google.ts";
import { feedbackRow } from "./feedback.ts";
import { canNudge } from "./schedule.ts";
import type { Telegram } from "./telegram.ts";
import { fmtDate, fmtTime, parseLocalIso, startOfLocalDay } from "./time.ts";

export interface CalEvent { id: string; cal: string; title: string; start: number; end: number; allDay: boolean; location: string | null; attendees: number; declined: boolean }
const SYNC_EVERY_MS = 5 * 60000; // every cron tick
const FRESH_MS = 60000; // a calendar question re-syncs first if the copy is older than this
const WINDOW_BACK_MS = 2 * 86400000;
const WINDOW_FWD_MS = 14 * 86400000;

export function parseEvent(item: RawEvent, calName: string, off: number): CalEvent | null {
  if (!item.id || item.status === "cancelled") return null;
  const allDay = !item.start?.dateTime && !!item.start?.date;
  const start = allDay ? parseLocalIso(`${item.start!.date}T00:00`, off) : item.start?.dateTime ? Date.parse(item.start.dateTime) : null;
  const endRaw = allDay ? (item.end?.date ? parseLocalIso(`${item.end.date}T00:00`, off) : null) : item.end?.dateTime ? Date.parse(item.end.dateTime) : null;
  if (start === null || Number.isNaN(start)) return null;
  const end = endRaw !== null && !Number.isNaN(endRaw) ? endRaw : start + 3600000;
  const declined = (item.attendees ?? []).some((a) => a.self && a.responseStatus === "declined");
  return { id: item.id, cal: calName, title: (item.summary ?? "(no title)").trim().slice(0, 100), start, end, allDay, location: item.location ? item.location.trim().slice(0, 80) : null, attendees: (item.attendees ?? []).length, declined };
}

export async function getEvents(db: Db, fromMs: number, toMs: number): Promise<CalEvent[]> {
  const r = await db.prepare("SELECT json FROM cal_cache").bind().all<{ json: string }>();
  const out: CalEvent[] = [];
  for (const row of r.results) {
    try { for (const e of JSON.parse(row.json) as CalEvent[]) if (!e.declined && e.start < toMs && e.end > fromMs) out.push(e); } catch { /* skip a corrupt row */ }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Overlapping timed events. All-day events and declined events never conflict. */
export function conflicts(events: CalEvent[]): [CalEvent, CalEvent][] {
  const timed = events.filter((e) => !e.allDay && !e.declined).sort((a, b) => a.start - b.start);
  const out: [CalEvent, CalEvent][] = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      if (timed[j]!.start >= timed[i]!.end) break;
      out.push([timed[i]!, timed[j]!]);
    }
  }
  return out;
}

export function evLine(e: CalEvent, off: number, withDate = false): string {
  const when = e.allDay ? "all day" : `${fmtTime(e.start, off)}-${fmtTime(e.end, off)}`;
  return `${withDate ? `${fmtDate(e.start, off).slice(0, 5)} ` : ""}${when} ${e.title}${e.location ? ` @ ${e.location}` : ""}${e.attendees > 1 ? ` (${e.attendees} people)` : ""}`;
}

export function agendaText(events: CalEvent[], now: number, off: number, days = 2): string {
  const lines: string[] = [];
  const day0 = startOfLocalDay(now, off);
  const names = ["Today", "Tomorrow"];
  for (let d = 0; d < days; d++) {
    const from = day0 + d * 86400000;
    const todays = events.filter((e) => e.start < from + 86400000 && e.end > from);
    lines.push(`${names[d] ?? fmtDate(from, off)} ${fmtDate(from + 3600000, off)}`);
    if (!todays.length) lines.push("No events.");
    for (const e of todays) lines.push(evLine(e, off));
  }
  for (const [a, b] of conflicts(events.filter((e) => e.start < day0 + days * 86400000))) lines.push(`Heads up: ${a.title} overlaps ${b.title} at ${fmtTime(b.start, off)}.`);
  return lines.join("\n");
}

/** One line for the brief: the next few events today, plus a count of the rest. */
export function briefLine(events: CalEvent[], now: number, off: number): string | null {
  const day0 = startOfLocalDay(now, off);
  const today = events.filter((e) => e.start >= day0 && e.start < day0 + 86400000 && e.end > now - 3600000);
  if (!today.length) return null;
  const shown = today.slice(0, 3).map((e) => `${e.allDay ? "all day" : fmtTime(e.start, off)} ${e.title}`);
  return `Calendar: ${shown.join(" | ")}${today.length > 3 ? ` (+${today.length - 3} more)` : ""}`;
}

export const NOISE_CAL = /phases of the moon|week numbers?|holidays? in|^holidays$|contacts/i;
export async function disabledCals(db: Db): Promise<Set<string>> {
  try { return new Set(JSON.parse((await getSetting(db, "cal_disabled")) ?? "[]") as string[]); } catch { return new Set(); }
}

export type SyncResult = { status: "ok"; calendars: number; events: number } | { status: "not_connected" | "expired" | "error" };

export async function syncCalendar(ctx: Ctx): Promise<SyncResult> {
  const { db, env, f, now, off } = ctx;
  if (!googleConfigured(env)) return { status: "not_connected" };
  const cred = await db.prepare("SELECT enc FROM credentials WHERE provider = 'google'").bind().first<{ enc: string }>();
  if (!cred) return { status: "not_connected" };
  try {
    const refresh = (JSON.parse(await decrypt(await keyOf(env), cred.enc)) as { refresh_token: string }).refresh_token;
    const token = await accessToken(env, f, refresh);
    const off2 = await disabledCals(db);
    const listed = await listCalendars(f, token);
    // Every calendar the account lists stays choosable in /calendars, including ones switched off or hidden as noise.
    await setSetting(db, "cal_list", JSON.stringify(listed.filter((c) => c.selected !== false && !/#(holiday|contacts)@/.test(c.id)).slice(0, 30).map((c) => ({ id: c.id, name: c.summary ?? c.id }))));
    const cals: typeof listed = [];
    for (const c of listed) {
      if (c.selected === false || /#(holiday|contacts)@/.test(c.id) || off2.has(c.id)) continue;
      if (NOISE_CAL.test(c.summary ?? "") && !(await getSetting(db, `cal_on:${c.id}`))) continue; // noise calendars are off unless the owner turned them on
      cals.push(c);
    }
    cals.splice(6);
    const min = new Date(now - WINDOW_BACK_MS).toISOString();
    const max = new Date(now + WINDOW_FWD_MS).toISOString();
    let total = 0;
    for (const c of cals) {
      const name = c.summary ?? c.id;
      try {
        const events = (await listEvents(f, token, c.id, min, max)).map((i) => parseEvent(i, name, off)).filter((e): e is CalEvent => e !== null);
        total += events.length;
        await db.prepare("INSERT INTO cal_cache (cal_id, name, json, ts) VALUES (?, ?, ?, ?) ON CONFLICT(cal_id) DO UPDATE SET name = excluded.name, json = excluded.json, ts = excluded.ts").bind(c.id, name, JSON.stringify(events), now).run();
      } catch (e) {
        if (e instanceof AuthExpired) throw e;
        await db.prepare("UPDATE cal_cache SET ts = ? WHERE cal_id = ?").bind(now, c.id).run(); // keep the last good copy
      }
    }
    await db.prepare("DELETE FROM cal_cache WHERE ts < ?").bind(now).run(); // calendars that are gone
    await setSetting(db, "cal_last_sync", String(now));
    await setSetting(db, "cal_expired_notified", "0");
    return { status: "ok", calendars: cals.length, events: total };
  } catch (e) {
    return { status: e instanceof AuthExpired ? "expired" : "error" };
  }
}

/** Cron entry: sync every 15 minutes; tell the owner once if the connection has expired. */
export async function maybeSync(ctx: Ctx, tg: Telegram, chatId: number): Promise<SyncResult | null> {
  if (!googleConfigured(ctx.env)) return null;
  const last = Number((await getSetting(ctx.db, "cal_last_sync")) ?? 0);
  if (ctx.now - last < SYNC_EVERY_MS) return null;
  const r = await syncCalendar(ctx);
  if (r.status === "not_connected") return null; // nothing connected yet: no retry timer, no noise
  if (r.status === "expired" && (await getSetting(ctx.db, "cal_expired_notified")) !== "1") {
    await setSetting(ctx.db, "cal_expired_notified", "1");
    await tg.send(chatId, "Your Google Calendar connection has expired, so I can't see your schedule. Send /connect to reconnect.");
  }
  if (r.status !== "ok") await setSetting(ctx.db, "cal_last_sync", String(ctx.now - SYNC_EVERY_MS + 5 * 60000)); // retry in 5 minutes
  return r;
}

/** A heads-up 10 to 20 minutes before a meeting with other people or a place. Counts against the interrupt budget. */
export async function meetingNudges(ctx: Ctx, tg: Telegram, chatId: number): Promise<number> {
  if ((await getSetting(ctx.db, "paused")) === "1" || (await getSetting(ctx.db, "meeting_nudges")) === "0") return 0;
  const soon = (await getEvents(ctx.db, ctx.now + 10 * 60000, ctx.now + 20 * 60000)).filter((e) => !e.allDay && e.start >= ctx.now + 10 * 60000 && (e.attendees > 1 || e.location));
  let sent = 0;
  for (const e of soon) {
    const kind = `meeting:${e.cal}:${e.id}:${e.start}`.slice(0, 200);
    const seen = await ctx.db.prepare("SELECT COUNT(*) AS n FROM outbound WHERE kind = ?").bind(kind).first<{ n: number }>();
    if (Number(seen?.n ?? 0) > 0) continue;
    if (!(await canNudge(ctx))) break;
    await tg.send(chatId, `In ${Math.round((e.start - ctx.now) / 60000)} minutes: ${evLine(e, ctx.off)}`, [feedbackRow("meeting")]);
    await ctx.db.prepare("INSERT INTO outbound (ts, kind, unsolicited) VALUES (?, ?, 1)").bind(ctx.now, kind).run();
    sent++;
  }
  return sent;
}

/** Re-sync first when the copy is stale, so a question about the calendar sees an event added a minute ago. */
export async function syncIfStale(ctx: Ctx, maxAgeMs = FRESH_MS): Promise<SyncResult | null> {
  if (!googleConfigured(ctx.env)) return null;
  const last = Number((await getSetting(ctx.db, "cal_last_sync")) ?? 0);
  if (!last || ctx.now - last < maxAgeMs) return null;
  return syncCalendar(ctx);
}
export const CALENDAR_WORDS = /\b(calendar|agenda|schedule|meetings?|appointments?|events?|diary|free|busy|available|tomorrow|today|this week|next week|dinner|lunch)\b/i;

/** The calendars Google lists for this account, with whether Rafiki uses each one. */
export async function calendarChoices(ctx: Ctx): Promise<{ id: string; name: string; on: boolean }[]> {
  let list: { id: string; name: string }[] = [];
  try { list = JSON.parse((await getSetting(ctx.db, "cal_list")) ?? "[]") as { id: string; name: string }[]; } catch { /* fall back below */ }
  if (!list.length) list = (await ctx.db.prepare("SELECT cal_id AS id, name FROM cal_cache").bind().all<{ id: string; name: string }>()).results;
  const off2 = await disabledCals(ctx.db);
  const out: { id: string; name: string; on: boolean }[] = [];
  for (const c of list) {
    const noiseOff = NOISE_CAL.test(c.name ?? "") && !(await getSetting(ctx.db, `cal_on:${c.id}`));
    out.push({ id: c.id, name: c.name, on: !off2.has(c.id) && !noiseOff });
  }
  return out;
}
