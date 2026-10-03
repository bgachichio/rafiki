// The preferences engine: how reminders, the brief, nudges and replies behave for this owner.
// Values live in the prefs table, each with a status (default, imported, confirmed) in pref_state. Nothing is ever
// silently promoted to confirmed: only a tap or a direct statement from the owner does that.
import type { Db } from "./db.ts";
import { getSetting } from "./db.ts";
import { loadPrefs, setPref } from "./prefs.ts";

export type RemindMode = "once" | "chase" | "confirm";
export interface Policy {
  mode: RemindMode;
  gapH: number;
  max: number;
  eventLeads: number[]; // minutes before an event, largest first; 0 is "at the time"
  morning: string; // what "tomorrow" means as a time
  briefItems: 1 | 3 | 5;
  nudgesMax: number;
}
export const DEFAULT_POLICY: Policy = { mode: "chase", gapH: 2, max: 3, eventLeads: [60, 0], morning: "09:00", briefItems: 3, nudgesMax: 3 };

export const MODE_TEXT: Record<RemindMode, string> = {
  once: "One reminder, then I leave it",
  chase: "Chase me until I tap Done",
  confirm: "One reminder, then keep it on my list until I tap Done",
};

export type Status = "default" | "imported" | "confirmed";

export function parseLeads(text: string): number[] | null {
  const t = text.toLowerCase();
  if (/^\s*(none|no|nothing|at the time|at time|only at the time)\s*$/.test(t)) return [0];
  const out = new Set<number>();
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b/g)) {
    const n = Number(m[1]);
    const u = m[2]![0]!;
    const mult = u === "m" ? 1 : u === "h" ? 60 : u === "d" ? 1440 : 10080;
    if (n > 0 && n * mult <= 20160) out.add(Math.round(n * mult));
  }
  if (/\b(at the time|on the day|when it starts|at start)\b/.test(t)) out.add(0);
  return out.size ? [...out].sort((a, b) => b - a) : null;
}
export const leadsText = (l: number[]): string =>
  l.map((m) => (m === 0 ? "at the time" : m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? "" : "s"} before` : m % 60 === 0 ? `${m / 60} hour${m === 60 ? "" : "s"} before` : `${m} minutes before`)).join(", ");

const num = (v: string | undefined, d: number, lo: number, hi: number): number => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };

export async function loadPolicy(db: Db): Promise<{ policy: Policy; status: Record<string, Status> }> {
  const p = await loadPrefs(db);
  const st = (await db.prepare("SELECT key, status FROM pref_state").bind().all<{ key: string; status: Status }>()).results;
  const status: Record<string, Status> = Object.fromEntries(st.map((s) => [s.key, s.status]));
  const leads = p["remind.event_leads"] ? p["remind.event_leads"].split(",").map(Number).filter((n) => Number.isFinite(n) && n >= 0) : DEFAULT_POLICY.eventLeads;
  const items = Number(p["brief.items"]);
  return {
    status,
    policy: {
      mode: p["remind.mode"] === "once" || p["remind.mode"] === "confirm" || p["remind.mode"] === "chase" ? p["remind.mode"] : DEFAULT_POLICY.mode,
      gapH: num(p["remind.gap_h"], DEFAULT_POLICY.gapH, 0.25, 72),
      max: num(p["remind.max"], DEFAULT_POLICY.max, 0, 10),
      eventLeads: leads.length ? [...new Set(leads)].sort((a, b) => b - a) : DEFAULT_POLICY.eventLeads,
      morning: /^\d{2}:\d{2}$/.test(p["remind.morning"] ?? "") ? p["remind.morning"]! : DEFAULT_POLICY.morning,
      briefItems: items === 1 || items === 5 ? items : 3,
      nudgesMax: num(p["nudges.max"], DEFAULT_POLICY.nudgesMax, 0, 20),
    },
  };
}

/** Store a preference and its status. Only call with "confirmed" from a tap or a direct statement. */
export async function setPolicyKey(db: Db, now: number, key: string, value: string, status: Status, source = "card"): Promise<void> {
  await setPref(db, now, key, value, source);
  await db.prepare("INSERT INTO pref_state (key, status, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET status = excluded.status, ts = excluded.ts").bind(key, status, now).run();
}
export async function markConfirmed(db: Db, now: number, key: string): Promise<void> {
  await db.prepare("INSERT INTO pref_state (key, status, ts) VALUES (?, 'confirmed', ?) ON CONFLICT(key) DO UPDATE SET status = 'confirmed', ts = excluded.ts").bind(key, now).run();
}

export async function recordSignal(db: Db, now: number, kind: string, ref?: string): Promise<void> {
  await db.prepare("INSERT INTO signals (ts, kind, ref) VALUES (?, ?, ?)").bind(now, kind, ref ?? null).run();
}
export async function countSignals(db: Db, kind: string, since: number): Promise<number> {
  return Number((await db.prepare("SELECT COUNT(*) AS n FROM signals WHERE kind = ? AND ts >= ?").bind(kind, since).first<{ n: number }>())?.n ?? 0);
}

/** One line for the model's context, so it can answer questions about the rules and mark events correctly. */
export function policyLine(p: Policy): string {
  const how = p.mode === "chase" ? `chase every ${p.gapH} hours up to ${p.max} times until they tap Done` : p.mode === "once" ? "send once and leave it" : "send once and keep it on their list until they tap Done";
  return `REMINDER RULES: ${how}. For an event (a meeting, dinner, flight, appointment) set kind "event" and the system adds the owner's lead times (${leadsText(p.eventLeads)}). For a task or errand set kind "task".`;
}
export async function briefTimeOf(db: Db): Promise<string> { return (await getSetting(db, "brief_time")) ?? "08:00"; }
