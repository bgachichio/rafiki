// Read-only calendar feeds (iCal / ICS): Google's "secret address in iCal format", an iCloud public calendar, Outlook and others.
// A feed can only be read. Rafiki cannot create, change or delete events through it.
import type { Ctx } from "./agent.ts";
import type { CalEvent } from "./calendar.ts";
import { decrypt, encrypt, keyOf } from "./crypto.ts";
import { getSetting, setSetting } from "./db.ts";

const MAX_BYTES = 2_000_000;
const WINDOW_BACK_MS = 2 * 86400000;
const WINDOW_FWD_MS = 14 * 86400000;

interface Prop { name: string; params: Record<string, string>; value: string }

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}
function parseLine(line: string): Prop | null {
  const i = line.indexOf(":");
  if (i < 1) return null;
  const [name, ...ps] = line.slice(0, i).split(";");
  const params: Record<string, string> = {};
  for (const p of ps) { const [k, v] = p.split("="); if (k && v !== undefined) params[k.toUpperCase()] = v.replace(/^"|"$/g, ""); }
  return { name: name!.toUpperCase(), params, value: line.slice(i + 1) };
}
const unesc = (s: string): string => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

/** Milliseconds for a local wall-clock time in an IANA zone. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number | null {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const shown = (t: number): number => { const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value])); return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)); };
    let t = guess - (shown(guess) - guess);
    t = guess - (shown(t) - t);
    return t;
  } catch { return null; }
}

interface When { ms: number; allDay: boolean; date: [number, number, number] }
function parseWhen(p: Prop, off: number): When | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/.exec(p.value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
  if (p.params.VALUE === "DATE" || m[4] === undefined) return { ms: Date.UTC(y, mo - 1, d) - off * 60000, allDay: true, date: [y, mo, d] };
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)] as [number, number, number];
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false, date: [y, mo, d] };
  const ms = p.params.TZID ? zonedToUtc(y, mo, d, h, mi, s, p.params.TZID) : null;
  return { ms: ms ?? Date.UTC(y, mo - 1, d, h, mi, s) - off * 60000, allDay: false, date: [y, mo, d] };
}
function parseDuration(v: string): number | null {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  return m ? (Number(m[1] ?? 0) * 7 * 86400 + Number(m[2] ?? 0) * 86400 + Number(m[3] ?? 0) * 3600 + Number(m[4] ?? 0) * 60 + Number(m[5] ?? 0)) * 1000 : null;
}

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
interface Rule { freq: string; interval: number; count: number | null; until: number | null; byday: number[]; bymonthday: number[] }
function parseRule(v: string, off: number): Rule | null {
  const o: Record<string, string> = {};
  for (const part of v.split(";")) { const [k, val] = part.split("="); if (k && val) o[k.toUpperCase()] = val; }
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(o.FREQ ?? "")) return null;
  const until = o.UNTIL ? parseWhen({ name: "UNTIL", params: {}, value: o.UNTIL }, off)?.ms ?? null : null;
  return {
    freq: o.FREQ!, interval: Math.max(1, Number(o.INTERVAL ?? 1) || 1), count: o.COUNT ? Number(o.COUNT) : null, until: until === null ? null : (o.UNTIL!.length === 8 ? until + 86400000 : until),
    byday: (o.BYDAY ?? "").split(",").map((d) => DAYS.indexOf(d.slice(-2))).filter((i) => i >= 0), bymonthday: (o.BYMONTHDAY ?? "").split(",").map(Number).filter((n) => n >= 1 && n <= 31),
  };
}

/** Starts of each occurrence between from and to, in the event's own wall-clock time, stepping from the first one. */
function occurrences(first: When, r: Rule, from: number, to: number, off: number, tz: string | undefined): number[] {
  const out: number[] = [];
  const [y0, m0, d0] = first.date;
  const timeOfDay = first.allDay ? 0 : first.ms - (zonedMidnight(y0, m0, d0, off, tz));
  const at = (y: number, mo: number, d: number): number => (first.allDay ? Date.UTC(y, mo - 1, d) - off * 60000 : (tz ? zonedToUtc(y, mo, d, Math.floor(timeOfDay / 3600000), Math.floor((timeOfDay % 3600000) / 60000), 0, tz) : null) ?? zonedMidnight(y, mo, d, off, tz) + timeOfDay);
  let n = 0;
  const push = (ms: number): boolean => { if (r.until !== null && ms >= r.until) return false; n++; if (r.count !== null && n > r.count) return false; if (ms + 86400000 >= from && ms <= to) out.push(ms); return ms <= to; };
  if (r.freq === "WEEKLY") {
    const days = r.byday.length ? r.byday : [new Date(Date.UTC(y0, m0 - 1, d0)).getUTCDay()];
    const startWeek = Date.UTC(y0, m0 - 1, d0) - new Date(Date.UTC(y0, m0 - 1, d0)).getUTCDay() * 86400000;
    for (let w = 0, guard = 0; guard < 600; w += r.interval, guard++) {
      for (const dow of [...days].sort((a, b) => a - b)) {
        const day = new Date(startWeek + (w * 7 + dow) * 86400000);
        const ms = at(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
        if (ms < first.ms) continue;
        if (!push(ms)) return out;
      }
    }
    return out;
  }
  for (let i = 0, guard = 0; guard < 800; i += r.interval, guard++) {
    let y = y0, mo = m0, d = d0;
    if (r.freq === "DAILY") { const t = new Date(Date.UTC(y0, m0 - 1, d0 + i)); y = t.getUTCFullYear(); mo = t.getUTCMonth() + 1; d = t.getUTCDate(); }
    else if (r.freq === "MONTHLY") { const t = new Date(Date.UTC(y0, m0 - 1 + i, 1)); y = t.getUTCFullYear(); mo = t.getUTCMonth() + 1; d = r.bymonthday[0] ?? d0; if (new Date(Date.UTC(y, mo - 1, d)).getUTCMonth() !== mo - 1) continue; }
    else { y = y0 + i; if (new Date(Date.UTC(y, m0 - 1, d0)).getUTCMonth() !== m0 - 1) continue; }
    const ms = at(y, mo, d);
    if (ms < first.ms) continue;
    if (!push(ms)) break;
  }
  return out;
}
function zonedMidnight(y: number, mo: number, d: number, off: number, tz?: string): number { return (tz ? zonedToUtc(y, mo, d, 0, 0, 0, tz) : null) ?? Date.UTC(y, mo - 1, d) - off * 60000; }

export function calendarName(text: string): string | null {
  const m = /^X-WR-CALNAME(?:;[^:]*)?:(.+)$/im.exec(text.replace(/\r\n/g, "\n"));
  return m ? unesc(m[1]!).slice(0, 60) : null;
}

/** Events between from and to, with recurring events expanded. */
export function parseIcs(text: string, calName: string, from: number, to: number, off: number): CalEvent[] {
  const lines = unfold(text);
  const blocks: Prop[][] = [];
  let cur: Prop[] | null = null;
  for (const l of lines) {
    if (/^BEGIN:VEVENT/i.test(l)) cur = [];
    else if (/^END:VEVENT/i.test(l)) { if (cur) blocks.push(cur); cur = null; }
    else if (cur) { const p = parseLine(l); if (p) cur.push(p); }
  }
  const overrides = new Map<string, Set<number>>();
  const evs: { uid: string; props: Prop[]; recId: When | null }[] = blocks.map((b) => ({ uid: b.find((p) => p.name === "UID")?.value ?? "", props: b, recId: (() => { const r = b.find((p) => p.name === "RECURRENCE-ID"); return r ? parseWhen(r, off) : null; })() }));
  for (const e of evs) if (e.recId) { const s = overrides.get(e.uid) ?? new Set<number>(); s.add(e.recId.ms); overrides.set(e.uid, s); }
  const out: CalEvent[] = [];
  for (const e of evs) {
    const get = (n: string): Prop | undefined => e.props.find((p) => p.name === n);
    if (/CANCELLED/i.test(get("STATUS")?.value ?? "")) continue;
    const sp = get("DTSTART"); if (!sp) continue;
    const start = parseWhen(sp, off); if (!start) continue;
    const ep = get("DTEND");
    const dur = get("DURATION") ? parseDuration(get("DURATION")!.value) : null;
    const end = ep ? parseWhen(ep, off)?.ms ?? null : dur !== null ? start.ms + dur : null;
    const length = (end ?? (start.allDay ? start.ms + 86400000 : start.ms + 3600000)) - start.ms;
    const title = unesc(get("SUMMARY")?.value ?? "(no title)").slice(0, 100) || "(no title)";
    const location = get("LOCATION") ? unesc(get("LOCATION")!.value).slice(0, 80) || null : null;
    const attendees = e.props.filter((p) => p.name === "ATTENDEE").length;
    const base = { cal: calName, title, allDay: start.allDay, location, attendees, declined: false };
    const rule = get("RRULE") ? parseRule(get("RRULE")!.value, off) : null;
    const emit = (ms: number): void => { if (ms < to && ms + length > from) out.push({ ...base, id: `${e.uid || title}:${ms}`.slice(0, 120), start: ms, end: ms + length }); };
    if (!rule || e.recId) { emit(start.ms); continue; }
    const skip = new Set<number>(overrides.get(e.uid) ?? []);
    for (const ex of e.props.filter((p) => p.name === "EXDATE")) for (const v of ex.value.split(",")) { const w = parseWhen({ ...ex, value: v }, off); if (w) skip.add(w.ms); }
    for (const ms of occurrences(start, rule, from - length, to, off, sp.params.TZID)) if (!skip.has(ms)) emit(ms);
  }
  return out.sort((a, b) => a.start - b.start).slice(0, 500);
}

// ---- feeds the owner has added ------------------------------------------------------------------------------------------------

export const normaliseFeedUrl = (u: string): string | null => {
  const t = u.trim().replace(/^webcal:\/\//i, "https://");
  try { const x = new URL(t); return x.protocol === "https:" ? x.toString() : null; } catch { return null; }
};
export const looksLikeFeed = (t: string): boolean => /^(webcal|https?):\/\/\S+$/i.test(t.trim()) && /(\.ics\b|\/ical\b|\/ical\/|webcal:|calendar)/i.test(t);

async function fetchFeed(f: typeof fetch, url: string): Promise<string | null> {
  try {
    const res = await f(url, { headers: { accept: "text/calendar, text/plain, */*" }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return null;
    return new TextDecoder().decode(buf);
  } catch { return null; }
}

export const FEED_HELP = [
  "Paste the private calendar link (an iCal link) and I will read it. I can only read it; I cannot change your calendar.",
  "Google Calendar on a laptop: open calendar settings for the calendar, find Integrate calendar, and copy Secret address in iCal format.",
  "iCloud: in the Calendar app tap the i next to the calendar, turn on Public Calendar and copy the link. That link is public to anyone who has it, so only share it with me.",
  "Outlook and others have a similar Publish or Subscribe link.",
].join("\n");

export interface FeedRow { id: string; name: string }
export async function listFeeds(ctx: Ctx): Promise<FeedRow[]> {
  const r = await ctx.db.prepare("SELECT provider, meta FROM credentials WHERE provider LIKE 'ical:%' ORDER BY ts").bind().all<{ provider: string; meta: string | null }>();
  return r.results.map((x) => ({ id: x.provider, name: (() => { try { return (JSON.parse(x.meta ?? "{}") as { name?: string }).name ?? "Calendar"; } catch { return "Calendar"; } })() }));
}

/** Add a feed: fetch it once to prove it reads, then store the address encrypted and cache its events. */
export async function addFeed(ctx: Ctx, rawUrl: string): Promise<{ ok: true; name: string; events: number } | { ok: false; why: string }> {
  const url = normaliseFeedUrl(rawUrl);
  if (!url) return { ok: false, why: "That does not look like a calendar link. It should start with https:// or webcal://." };
  const text = await fetchFeed(ctx.f, url);
  if (text === null) return { ok: false, why: "I could not open that link. Check it is the private iCal link, and that the calendar is shared." };
  if (!/BEGIN:VCALENDAR/i.test(text)) return { ok: false, why: "That link opened but it is not a calendar feed. Look for the one called iCal or ICS." };
  const existing = await listFeeds(ctx);
  if (existing.length >= 6) return { ok: false, why: "You already have six calendar links. Remove one in /calendars first." };
  const id = `ical:${(await keyOf({ ENCRYPTION_KEY: url })).slice(0, 10)}`;
  let name = calendarName(text) ?? `Calendar ${existing.length + 1}`;
  if (existing.some((e) => e.name === name && e.id !== id)) name = `${name} (${existing.length + 1})`;
  await ctx.db.prepare("INSERT INTO credentials (provider, enc, meta, ts) VALUES (?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET enc = excluded.enc, meta = excluded.meta, ts = excluded.ts").bind(id, await encrypt(await keyOf(ctx.env), url), JSON.stringify({ name }), ctx.now).run();
  const events = parseIcs(text, name, ctx.now - WINDOW_BACK_MS, ctx.now + WINDOW_FWD_MS, ctx.off);
  await ctx.db.prepare("INSERT INTO cal_cache (cal_id, name, json, ts) VALUES (?, ?, ?, ?) ON CONFLICT(cal_id) DO UPDATE SET name = excluded.name, json = excluded.json, ts = excluded.ts").bind(id, name, JSON.stringify(events), ctx.now).run();
  await setSetting(ctx.db, "cal_last_sync", String(ctx.now));
  return { ok: true, name, events: events.length };
}

export async function removeFeed(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.prepare("DELETE FROM credentials WHERE provider = ?").bind(id).run();
  await ctx.db.prepare("DELETE FROM cal_cache WHERE cal_id = ?").bind(id).run();
}

/** Refresh every feed. A feed that fails keeps its last good copy. */
export async function syncIcal(ctx: Ctx): Promise<{ feeds: number; events: number }> {
  const rows = (await ctx.db.prepare("SELECT provider, enc, meta FROM credentials WHERE provider LIKE 'ical:%'").bind().all<{ provider: string; enc: string; meta: string | null }>()).results;
  let events = 0;
  const key = await keyOf(ctx.env);
  let off2: string[] = [];
  try { off2 = JSON.parse((await getSetting(ctx.db, "cal_disabled")) ?? "[]") as string[]; } catch { /* none */ }
  for (const r of rows) {
    if (off2.includes(r.provider)) continue; // switched off in /calendars
    try {
      const url = await decrypt(key, r.enc);
      const text = await fetchFeed(ctx.f, url);
      if (text === null || !/BEGIN:VCALENDAR/i.test(text)) { await ctx.db.prepare("UPDATE cal_cache SET ts = ? WHERE cal_id = ?").bind(ctx.now, r.provider).run(); continue; }
      const name = (JSON.parse(r.meta ?? "{}") as { name?: string }).name ?? "Calendar";
      const evs = parseIcs(text, name, ctx.now - WINDOW_BACK_MS, ctx.now + WINDOW_FWD_MS, ctx.off);
      events += evs.length;
      await ctx.db.prepare("INSERT INTO cal_cache (cal_id, name, json, ts) VALUES (?, ?, ?, ?) ON CONFLICT(cal_id) DO UPDATE SET name = excluded.name, json = excluded.json, ts = excluded.ts").bind(r.provider, name, JSON.stringify(evs), ctx.now).run();
    } catch { /* keep the last good copy */ }
  }
  return { feeds: rows.length, events };
}
