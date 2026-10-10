// Deterministic reading of the times people use for reminders. Language models are unreliable at date arithmetic
// (one put "in 1 minute" a day late), so when the owner's own words contain a clear time, code decides the moment.
// Ambiguous text (two days or two clock times) returns null and the model's reading stands.
import { startOfLocalDay } from "./time.ts";

const UNIT_MS: Record<string, number> = { second: 1000, sec: 1000, minute: 60000, min: 60000, hour: 3600000, hr: 3600000, day: 86400000, week: 7 * 86400000 };
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** Parts of the day, in minutes after midnight. "Morning" uses the owner's own morning time. */
const PART: Record<string, number> = { afternoon: 14 * 60, evening: 18 * 60, tonight: 20 * 60, night: 20 * 60, noon: 12 * 60, midday: 12 * 60, lunchtime: 13 * 60, lunch: 13 * 60, "end of day": 17 * 60, eod: 17 * 60 };
const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, couple: 2, few: 3 };

/** Minutes after midnight for a clock time ("5pm", "17:30", "at 9", "9.30am"), and how many distinct clock times appear. */
export function clockOf(t: string): { min: number | null; count: number } {
  const hits: number[] = [];
  const add = (h: number, m: number, ap?: string): void => {
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h <= 23 && m <= 59) hits.push(h * 60 + m);
  };
  for (const x of t.matchAll(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/g)) add(Number(x[1]), Number(x[2] ?? 0), x[3]!.replace(/\./g, ""));
  for (const x of t.matchAll(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b(?!\s*(?:am|pm|a\.m|p\.m))/g)) add(Number(x[1]), Number(x[2]));
  // A bare hour needs "at": "at 9" is 09:00; "at 5" means 17:00 because nobody sets a 05:00 reminder by saying "at 5".
  for (const x of t.matchAll(/\b(?:at|by|around)\s+(\d{1,2})\b(?![:.]\d|\s*(?:am|pm|a\.m|p\.m|minutes?|mins?|hours?|hrs?|days?|weeks?))/g)) { const h = Number(x[1]); add(h >= 1 && h <= 6 ? h + 12 : h, 0); }
  const uniq = [...new Set(hits)];
  return { min: uniq.length === 1 ? uniq[0]! : null, count: uniq.length };
}

/** The reminder moment (epoch ms) when the text says a clear time; null when it does not, or is ambiguous. */
export function parseWhen(text: string, now: number, off: number, morning = 540): number | null {
  const t = ` ${text.toLowerCase().replace(/[’']/g, "")} `;
  const today = startOfLocalDay(now, off);
  const clock = clockOf(t);
  if (clock.count > 1) return null;
  let part: number | null = null;
  for (const [k, v] of Object.entries(PART)) if (new RegExp(`\\b${k}\\b`).test(t)) { part = v; break; }
  if (/\bmornings?\b|\bmorning hours\b|\bfirst thing\b/.test(t)) part = morning;
  const timeOfDay = clock.min ?? part;

  // "in 20 minutes", "in an hour", "in 2 days" (a pure offset), or "in 2 days, morning" (a day plus a time of day).
  const rel = /\bin\s+(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|ten|a couple of|a few|half an?)\s*(second|sec|minute|min|hour|hr|day|week)s?\b/.exec(t);
  if (rel) {
    const raw = rel[1]!;
    const n = raw.startsWith("half") ? 0.5 : raw.startsWith("a couple") ? 2 : raw.startsWith("a few") ? 3 : NUM[raw] ?? Number(raw);
    const unit = rel[2]!;
    const ms = UNIT_MS[unit];
    if (!ms || !Number.isFinite(n) || n <= 0 || n * ms > 400 * 86400000) return null;
    if ((unit === "day" || unit === "week") && timeOfDay !== null && Number.isInteger(n)) return today + Math.round(n * ms) + timeOfDay * 60000;
    return now + Math.round(n * ms);
  }

  // A named day: today, tonight, tomorrow, the day after tomorrow, or a weekday.
  let day: number | null = null;
  let named = 0;
  if (/\bday after tomorrow\b/.test(t)) { day = today + 2 * 86400000; named++; }
  else if (/\b(tomorrow|tmrw|tmr|2moro)\b/.test(t)) { day = today + 86400000; named++; }
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(t)) { if (day === null) day = today; named++; }
  const wdHits = new Set<number>();
  for (let i = 0; i < 7; i++) if (new RegExp(`\\b(${DAYS[i]}|${SHORT[i]})\\b`).test(t)) wdHits.add(i);
  if (wdHits.size > 1) return null;
  if (wdHits.size === 1) {
    named++;
    const want = [...wdHits][0]!;
    const cur = new Date(now + off * 60000).getUTCDay();
    let ahead = (want - cur + 7) % 7;
    const at = timeOfDay ?? morning;
    if (ahead === 0 && (/\bnext\s+\w+day\b/.test(t) || today + at * 60000 <= now)) ahead = 7;
    day = today + ahead * 86400000;
  }
  if (named > 1) return null;

  if (day !== null) {
    const at = timeOfDay ?? (day === today ? null : morning);
    if (at === null) return null;
    const ms = day + at * 60000;
    return ms > now + 60000 ? ms : null; // "this afternoon" said at night is not a time code should guess
  }
  // Only a time of day: today if it is still ahead, otherwise tomorrow.
  if (clock.min !== null || (part !== null && /\b(this|at|by|around|in the)\s+(morning|afternoon|evening|night)|\btonight\b|\bat noon\b|\bat lunch(time)?\b/.test(t))) {
    const at = (clock.min ?? part)!;
    const cand = today + at * 60000;
    return cand > now + 60000 ? cand : cand + 86400000;
  }
  return null;
}
