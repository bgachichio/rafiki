// The five-minute cron, one step at a time: a failing step never stops the next, and the owner hears about it once a day.
import type { Ctx } from "./agent.ts";
import { maybeSync, meetingNudges } from "./calendar.ts";
import { nightly } from "./consolidate.ts";
import { getSetting, setSetting } from "./db.ts";
import { redactSecrets } from "./gates.ts";
import { maybeAskPreference } from "./learn.ts";
import { maybeBrief, maybeMonday, sweepReminders } from "./schedule.ts";
import type { Telegram } from "./telegram.ts";

const ALERT_EVERY_MS = 24 * 3600000;

export async function runJobs(c: Ctx, tg: Telegram, chatId: number): Promise<string[]> {
  const steps: [string, () => Promise<unknown>][] = [
    ["reminders", () => sweepReminders(c, tg, chatId)],
    ["brief", () => maybeBrief(c, tg, chatId)],
    ["monday check", () => maybeMonday(c, tg, chatId)],
    ["calendar sync", () => maybeSync(c, tg, chatId)],
    ["meeting heads-ups", () => meetingNudges(c, tg, chatId)],
    ["preference question", () => maybeAskPreference(c, tg, chatId)],
    ["nightly memory", () => nightly(c)],
  ];
  const failed: string[] = [];
  for (const [name, run] of steps) {
    try { await run(); } catch (e) { failed.push(`${name}: ${redactSecrets(e instanceof Error ? e.message : String(e)).text.slice(0, 120)}`); }
  }
  if (failed.length) {
    console.error("jobs failed:", failed.join(" | "));
    const last = Number((await getSetting(c.db, "job_alert_ts").catch(() => null)) ?? 0);
    if (c.now - last >= ALERT_EVERY_MS) {
      await setSetting(c.db, "job_alert_ts", String(c.now)).catch(() => undefined);
      await tg.send(chatId, `Part of my background work failed: ${failed[0]}. Nothing is lost and I will try again in five minutes. If you see this again tomorrow, check /log.`);
    }
  }
  return failed;
}
