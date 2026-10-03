// Time helpers. Kenya is UTC+3 all year (no daylight saving), but the offset is configurable.
export const DEFAULT_OFFSET_MIN = 180;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const pad = (n: number): string => String(n).padStart(2, "0");
const local = (ms: number, off: number): Date => new Date(ms + off * 60000);

export function fmtDate(ms: number, off = DEFAULT_OFFSET_MIN): string {
  const d = local(ms, off);
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`; // DD-MM-YYYY
}
export function fmtTime(ms: number, off = DEFAULT_OFFSET_MIN): string {
  const d = local(ms, off);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function fmtDateTime(ms: number, off = DEFAULT_OFFSET_MIN): string {
  return `${DAYS[local(ms, off).getUTCDay()]} ${fmtDate(ms, off)} ${fmtTime(ms, off)}`;
}
export function weekday(ms: number, off = DEFAULT_OFFSET_MIN): number {
  return local(ms, off).getUTCDay(); // 0 = Sunday
}
/** Start of the local day containing ms, as a UTC epoch. */
export function startOfLocalDay(ms: number, off = DEFAULT_OFFSET_MIN): number {
  const d = local(ms, off);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - off * 60000;
}
/** "2026-10-03T09:00" in local time to epoch ms; null if malformed. */
export function parseLocalIso(s: string, off = DEFAULT_OFFSET_MIN): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  return Date.UTC(y, mo - 1, d, h, mi) - off * 60000;
}
/** "08:00" to minutes since midnight; null if malformed. */
export function parseHM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
export function minutesOfDay(ms: number, off = DEFAULT_OFFSET_MIN): number {
  const d = local(ms, off);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
/** Quiet hours may wrap midnight (21:00 to 05:30). */
export function inQuietHours(ms: number, off = DEFAULT_OFFSET_MIN, start = "21:00", end = "05:30"): boolean {
  const s = parseHM(start) ?? 1260;
  const e = parseHM(end) ?? 330;
  const m = minutesOfDay(ms, off);
  return s <= e ? m >= s && m < e : m >= s || m < e;
}
