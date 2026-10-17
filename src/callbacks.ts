import type { Ctx } from "./agent.ts";
import { setSetting } from "./db.ts";
import { calendarChoices, syncCalendar } from "./calendar.ts";
import { removeFeed, syncIcal } from "./ical.ts";
import { ensureNext, snoozeTarget } from "./remind.ts";
import type { Telegram } from "./telegram.ts";
import { fmtDate, fmtTime } from "./time.ts";
import { disconnect } from "./slash.ts";

// Button taps for calendars and reminders.
export async function calendarCallback(ctx: Ctx, tg: Telegram, chatId: number, data: string): Promise<boolean> {
  const tg2 = /^cal:t:(\d+)$/.exec(data);
  if (tg2) {
    const ch = await calendarChoices(ctx);
    const c = ch[Number(tg2[1])];
    if (!c) return true;
    const off2 = new Set(ch.filter((x) => !x.on).map((x) => x.id));
    if (c.on) { off2.add(c.id); await setSetting(ctx.db, "cal_disabled", JSON.stringify([...off2])); await setSetting(ctx.db, `cal_on:${c.id}`, ""); await ctx.db.prepare("DELETE FROM cal_cache WHERE cal_id = ?").bind(c.id).run(); }
    else { off2.delete(c.id); await setSetting(ctx.db, "cal_disabled", JSON.stringify([...off2])); await setSetting(ctx.db, `cal_on:${c.id}`, "1"); }
    await syncCalendar(ctx);
    await syncIcal(ctx);
    await tg.send(chatId, `${c.name} is now ${c.on ? "off" : "on"}.`);
    return true;
  }
  const rm = /^cal:rm:(\d+)$/.exec(data);
  if (rm) {
    const c = (await calendarChoices(ctx))[Number(rm[1])];
    if (!c || !c.id.startsWith("ical:")) return true;
    await removeFeed(ctx, c.id);
    await tg.send(chatId, `Removed ${c.name}. I no longer read it, and I deleted the stored link.`);
    return true;
  }
  if (data === "cal:disc") { await disconnect(ctx, tg, chatId); return true; }
  if (data === "cal:sync") {
    const r = await syncCalendar(ctx);
    await tg.send(chatId, r.status === "ok" ? `Synced ${r.events} events from ${r.calendars} calendars.` : "I couldn't sync just now. If it keeps failing, send /connect to reconnect.");
    return true;
  }
  return false;
}

export async function reminderCallback(ctx: Ctx, tg: Telegram, chatId: number, data: string): Promise<boolean> {
  const m = /^r:([dstnx]):(\d+)$/.exec(data);
  if (!m) return false;
  const id = Number(m[2]);
  const r = await ctx.db.prepare("SELECT id, text, due_ts, repeat FROM reminders WHERE id = ?").bind(id).first<{ id: number; text: string; due_ts: number; repeat: string }>();
  if (!r) { await tg.send(chatId, "I can't find that reminder."); return true; }
  if (m[1] === "d") {
    await ctx.db.prepare("UPDATE reminders SET state = 'done' WHERE id = ?").bind(id).run();
    await ctx.db.prepare("UPDATE focus SET state = 'done', done_ts = ? WHERE ref = ? AND state = 'open'").bind(ctx.now, `r:${id}`).run(); // finishing the reminder finishes the One
    if (r.repeat !== "none") await ensureNext(ctx.db, r, ctx.now, ctx.off); // already waiting if it was created when this one was sent
    await tg.send(chatId, "Done.");
  } else if (m[1] === "s") {
    await ctx.db.prepare("UPDATE reminders SET state = 'open', due_ts = ?, chase_count = 0 WHERE id = ?").bind(ctx.now + 3600000, id).run();
    await tg.send(chatId, "I'll remind you again in an hour.");
  } else if (m[1] === "x") {
    await ctx.db.prepare("UPDATE reminders SET state = 'dropped' WHERE id = ?").bind(id).run();
    if (r.repeat !== "none") await ctx.db.prepare("UPDATE reminders SET state = 'dropped' WHERE text = ? AND repeat = ? AND state = 'open'").bind(r.text, r.repeat).run(); // the waiting next occurrence goes too
    await tg.send(chatId, r.repeat !== "none" ? `Stopped: ${r.text}. It will not repeat.` : `Cancelled: ${r.text}.`);
  } else {
    const at = await snoozeTarget(ctx, m[1] === "t" ? "tomorrow" : "week");
    await ctx.db.prepare("UPDATE reminders SET state = 'open', due_ts = ?, chase_count = 0 WHERE id = ?").bind(at, id).run();
    await tg.send(chatId, m[1] === "t" ? `Moved to tomorrow ${fmtTime(at, ctx.off)}.` : `Moved to ${fmtDate(at, ctx.off)} ${fmtTime(at, ctx.off)}.`);
  }
  return true;
}
