// Learn from behaviour, ask rarely. At most one preference question a day, only when something the owner did suggests a change,
// and never while an earlier question is still waiting. A preference changes only when the owner taps a card.
import type { Ctx } from "./agent.ts";
import { canNudge, isPaused, logOut } from "./budget.ts";
import { askDecision } from "./cards.ts";
import { getSetting, setSetting } from "./db.ts";
import { countSignals, loadPolicy } from "./policy.ts";
import type { Telegram } from "./telegram.ts";
import { fmtDate, minutesOfDay } from "./time.ts";

const WINDOW_MS = 14 * 86400000;
const CONFIRMED_SNOOZE_MS = 30 * 86400000;

interface Trigger { signal: string; need: number; key: string; proposed: string; says: (n: number) => string }
export const TRIGGERS: Trigger[] = [
  { signal: "chase_ignored", need: 3, key: "remind.mode", proposed: "confirm", says: (n) => `I chased you ${n} times about things you left open, and you did not answer.` },
  { signal: "brief_down", need: 2, key: "brief.items", proposed: "1", says: (n) => `You gave my morning brief a thumbs down ${n} times recently.` },
  { signal: "shorter", need: 2, key: "style", proposed: "brief", says: () => "You have asked me twice to be shorter." },
];

export const SHORTER = /\b(too long|shorter|be brief|less detail|keep it short|too wordy|too much text)\b/i;

export async function maybeAskPreference(ctx: Ctx, tg: Telegram, chatId: number): Promise<boolean> {
  if (await isPaused(ctx)) return false;
  const nowM = minutesOfDay(ctx.now, ctx.off);
  if (nowM < 10 * 60 || nowM >= 18 * 60) return false; // daytime only
  const today = fmtDate(ctx.now, ctx.off);
  if ((await getSetting(ctx.db, "pref_asked_date")) === today) return false;
  const open = await ctx.db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE state = 'open' AND ts >= ?").bind(ctx.now - 3 * 86400000).first<{ n: number }>();
  if (Number(open?.n ?? 0) > 0) return false; // an earlier question has not been answered
  if (!(await canNudge(ctx))) return false;
  const { status } = await loadPolicy(ctx.db);
  for (const t of TRIGGERS) {
    const n = await countSignals(ctx.db, t.signal, ctx.now - WINDOW_MS);
    if (n < t.need) continue;
    const recent = await ctx.db.prepare("SELECT ts FROM pref_state WHERE key = ? AND status = 'confirmed'").bind(t.key).first<{ ts: number }>();
    if (status[t.key] === "confirmed" && recent && ctx.now - recent.ts < CONFIRMED_SNOOZE_MS) continue; // they decided this recently
    await setSetting(ctx.db, "pref_asked_date", today);
    await askDecision(ctx, tg, chatId, t.key, { intro: `${t.says(n)} Want to change how I work?`, proposed: t.proposed });
    await logOut(ctx, "pref-question", true);
    await ctx.db.prepare("DELETE FROM signals WHERE kind = ?").bind(t.signal).run(); // count afresh after asking
    return true;
  }
  return false;
}
