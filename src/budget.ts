// Interrupt budget and pause state, shared by the scheduler and the calendar nudges.
import type { Ctx } from "./agent.ts";
import { getSetting } from "./db.ts";
import { loadPolicy } from "./policy.ts";
import { inQuietHours, startOfLocalDay } from "./time.ts";

export async function isPaused(ctx: Ctx): Promise<boolean> {
  return (await getSetting(ctx.db, "paused")) === "1";
}
export async function canNudge(ctx: Ctx): Promise<boolean> {
  const qs = (await getSetting(ctx.db, "quiet_start")) ?? "21:00";
  const qe = (await getSetting(ctx.db, "quiet_end")) ?? "05:30";
  if (inQuietHours(ctx.now, ctx.off, qs, qe)) return false;
  const r = await ctx.db.prepare("SELECT COUNT(*) AS n FROM outbound WHERE unsolicited = 1 AND ts >= ?").bind(startOfLocalDay(ctx.now, ctx.off)).first<{ n: number }>();
  return Number(r?.n ?? 0) < (await loadPolicy(ctx.db)).policy.nudgesMax;
}
export async function logOut(ctx: Ctx, kind: string, unsolicited: boolean): Promise<void> {
  await ctx.db.prepare("INSERT INTO outbound (ts, kind, unsolicited) VALUES (?, ?, ?)").bind(ctx.now, kind, unsolicited ? 1 : 0).run();
}
