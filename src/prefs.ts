// Structured preferences: small, named, always visible and editable with /preferences.
import type { Db } from "./db.ts";

export const PREF_LABELS: Record<string, string> = {
  call_me: "What I call you",
  work: "What you do",
  areas: "Life areas I watch",
  style: "How I talk to you",
  style_note: "Style, in your words",
  day_start: "Your day starts",
  day_end: "Your day ends",
  work_days: "Work days",
  voice_card: "Your writing voice",
};
export const STYLE_TEXT: Record<string, string> = {
  brief: "Keep replies very short: two to four lines.",
  direct: "Be direct: lead with the answer, no hedging, no padding.",
  warm: "Be warm and encouraging, while staying concise.",
  detailed: "Be thorough and structured, showing the reasoning.",
};

export async function loadPrefs(db: Db): Promise<Record<string, string>> {
  const r = await db.prepare("SELECT key, value FROM prefs").bind().all<{ key: string; value: string }>();
  return Object.fromEntries(r.results.map((x) => [x.key, x.value]));
}
export async function setPref(db: Db, now: number, key: string, value: string, source = "chat"): Promise<void> {
  await db.prepare("INSERT INTO prefs (key, value, source, ts) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, ts = excluded.ts").bind(key, value.slice(0, 1500), source, now).run();
}
export async function clearPref(db: Db, key: string): Promise<void> {
  await db.prepare("DELETE FROM prefs WHERE key = ?").bind(key).run();
}

/** Lines for the model's context: who to call the owner, and how to talk. */
export function prefsLines(p: Record<string, string>): string[] {
  const out: string[] = [];
  const who = [p.call_me ? `Call the owner ${p.call_me}.` : "", p.work ? `They do: ${p.work}.` : "", p.areas ? `Life areas they care most about: ${p.areas}.` : "", p.work_days ? `Work days: ${p.work_days}.` : "", p.day_start && p.day_end ? `Their day runs ${p.day_start} to ${p.day_end}.` : ""].filter(Boolean).join(" ");
  if (who) out.push(`OWNER PROFILE: ${who}`);
  const style = [p.style ? STYLE_TEXT[p.style] ?? p.style : "", p.style_note ?? "", p.voice_card ? `When drafting for them, write in their voice: ${p.voice_card}` : ""].filter(Boolean).join(" ");
  if (style) out.push(`HOW TO TALK TO THE OWNER: ${style}`);
  return out;
}
