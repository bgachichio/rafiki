// Deterministic reading of the relative times people use for reminders. Language models are unreliable at date arithmetic
// (one put "in 1 minute" a day late), so when the owner's own words contain a clear relative time, code decides the moment.
import { startOfLocalDay } from "./time.ts";

const UNIT_MS: Record<string, number> = { second: 1000, sec: 1000, minute: 60000, min: 60000, hour: 3600000, hr: 3600000, day: 86400000, week: 7 * 86400000 };

/** The reminder moment (epoch ms) when the text says "in N minutes/hours/days" or "tomorrow at 9am"; null when it does not. */
export function parseWhen(text: string, now: number, off: number): number | null {
  const t = text.toLowerCase();
  const rel = /\bin\s+(\d+(?:\.\d+)?|an?|half an?)\s*(second|sec|minute|min|hour|hr|day|week)s?\b/.exec(t);
  if (rel) {
    const raw = rel[1]!;
    const n = raw === "a" || raw === "an" ? 1 : raw.startsWith("half") ? 0.5 : Number(raw);
    const ms = UNIT_MS[rel[2]!];
    if (ms && Number.isFinite(n) && n > 0 && n * ms <= 400 * 86400000) return now + Math.round(n * ms);
  }
  const tom = /\btomorrow(?:\s+(?:at|by|around))?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(t);
  if (tom) {
    let h = Number(tom[1]);
    const m = tom[2] ? Number(tom[2]) : 0;
    if (tom[3] === "pm" && h < 12) h += 12;
    if (tom[3] === "am" && h === 12) h = 0;
    if (h <= 23 && m <= 59) return startOfLocalDay(now, off) + 86400000 + h * 3600000 + m * 60000;
  }
  return null;
}
