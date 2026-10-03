import assert from "node:assert/strict";
import { test } from "node:test";
import { agendaText, briefLine, conflicts, getEvents, maybeSync, meetingNudges, parseEvent, syncCalendar, type CalEvent } from "../src/calendar.ts";
import { decrypt, encrypt, hmacHex } from "../src/crypto.ts";
import { handleUpdate, type Deps, type Env } from "../src/handler.ts";
import { authUrl, checkState, makeState } from "../src/google.ts";
import { handleGoogleCallback } from "../src/oauth.ts";
import { buildBrief, maybeBrief } from "../src/schedule.ts";
import { Telegram, type TgUpdate } from "../src/telegram.ts";
import type { Ctx } from "../src/agent.ts";
import { ENV, agentJson, fakeFetch, makeDb, sent, type Call, type LlmReply } from "./shim.ts";

const OWNER = 100200300;
const T0 = Date.UTC(2026, 10, 3, 5, 0); // Tue 03-11-2026 08:00 EAT
const GENV: Env = { ...ENV, GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "gsecret", ENCRYPTION_KEY: "k".repeat(64), PUBLIC_URL: "https://rafiki.example.workers.dev" };
let uid = 9000;
const msg = (text: string): TgUpdate => ({ update_id: ++uid, message: { message_id: uid, from: { id: OWNER, first_name: "Sam" }, chat: { id: OWNER }, text } });
const tap = (data: string): TgUpdate => ({ update_id: ++uid, callback_query: { id: `c${uid}`, from: { id: OWNER, first_name: "Sam" }, data, message: { message_id: 3, chat: { id: OWNER } } } });
const iso = (h: number, m = 0, dayOffset = 0) => new Date(T0 + dayOffset * 86400000 + (h - 8) * 3600000 + m * 60000).toISOString();

interface GoogleWorld { calendars: unknown[]; events: Record<string, unknown[]>; tokenError?: string; failCal?: string; calls: Call[] }
function world(llm: LlmReply[] = [], gw: Partial<GoogleWorld> = {}) {
  const base = fakeFetch(llm);
  const w: GoogleWorld = { calendars: [{ id: "primary", summary: "Sam", selected: true, accessRole: "owner" }], events: {}, calls: [], ...gw };
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      w.calls.push({ url: u, method: "token", body: Object.fromEntries(new URLSearchParams(String(init?.body))) });
      if (w.tokenError) return new Response(JSON.stringify({ error: w.tokenError }), { status: 400 });
      return new Response(JSON.stringify({ access_token: "at-1", refresh_token: "rt-secret-xyz", expires_in: 3600 }), { status: 200 });
    }
    if (u.startsWith("https://oauth2.googleapis.com/revoke")) { w.calls.push({ url: u, method: "revoke", body: Object.fromEntries(new URLSearchParams(String(init?.body))) }); return new Response("{}", { status: 200 }); }
    if (u.includes("/calendarList")) return new Response(JSON.stringify({ items: w.calendars }), { status: 200 });
    const m = /\/calendars\/([^/]+)\/events/.exec(u);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      if (w.failCal === id) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ items: w.events[id] ?? [] }), { status: 200 });
    }
    return base.f(url, init);
  }) as typeof fetch;
  return { base, w, f };
}
function setup(llm: LlmReply[] = [], gw: Partial<GoogleWorld> = {}, now = T0) {
  const db = makeDb();
  const wd = world(llm, gw);
  const deps: Deps = { db, env: GENV, f: wd.f, now };
  const ctx = (n = now): Ctx => ({ db, env: GENV, f: wd.f, now: n, off: 180 });
  const tg = new Telegram(GENV.TELEGRAM_BOT_TOKEN, wd.f);
  return { db, wd, deps, ctx, tg, tgCalls: wd.base.tg, llm: wd.base.llm };
}
const owned = async (s: ReturnType<typeof setup>) => { await s.db.prepare("INSERT INTO settings (key, value) VALUES ('owner_chat_id', ?), ('ob_step', 'done')").bind(String(OWNER)).run(); };
async function connect(s: ReturnType<typeof setup>) {
  await s.db.prepare("INSERT INTO credentials (provider, enc, ts) VALUES ('google', ?, ?)").bind(await encrypt(GENV.ENCRYPTION_KEY!, JSON.stringify({ refresh_token: "rt-secret-xyz" })), T0).run();
}
const ev = (id: string, title: string, s: string, e: string, extra: Record<string, unknown> = {}) => ({ id, summary: title, start: { dateTime: s }, end: { dateTime: e }, ...extra });

test("crypto: AES-GCM round trip, random IV, tamper and wrong key fail; signatures are keyed", async () => {
  const a = await encrypt("secret", "hello");
  const b = await encrypt("secret", "hello");
  assert.notEqual(a, b);
  assert.equal(await decrypt("secret", a), "hello");
  await assert.rejects(() => decrypt("other", a));
  const flipped = a.slice(0, -4) + (a.endsWith("AAAA") ? "BBBB" : "AAAA");
  await assert.rejects(() => decrypt("secret", flipped));
  assert.notEqual(await hmacHex("k1", "m"), await hmacHex("k2", "m"));
});

test("oauth state: signed, expiring, tamper-proof", async () => {
  const { state, nonce } = await makeState(GENV, T0);
  assert.equal(await checkState(GENV, state, T0 + 1000), nonce);
  assert.equal(await checkState(GENV, state, T0 + 11 * 60000), null, "expired");
  assert.equal(await checkState(GENV, state.replace(/.$/, (c) => (c === "0" ? "1" : "0")), T0), null, "tampered signature");
  assert.equal(await checkState({ ...GENV, ENCRYPTION_KEY: "z".repeat(64) }, state, T0), null, "wrong key");
  assert.equal(await checkState(GENV, "junk", T0), null);
  const url = new URL(authUrl(GENV, state));
  assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/calendar.readonly");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("redirect_uri"), "https://rafiki.example.workers.dev/oauth/google/callback");
});

test("events: timed, all-day, cancelled and declined are handled", () => {
  const t = parseEvent(ev("1", "Standup", iso(9), iso(9, 30), { location: "Zoom", attendees: [{ self: true, responseStatus: "accepted" }, { responseStatus: "accepted" }] }), "Work", 180)!;
  assert.equal(t.title, "Standup"); assert.equal(t.attendees, 2); assert.equal(t.declined, false); assert.equal(t.allDay, false);
  const d = parseEvent({ id: "2", summary: "Holiday", start: { date: "2026-11-03" }, end: { date: "2026-11-04" } }, "Work", 180)!;
  assert.equal(d.allDay, true); assert.equal(d.start, Date.UTC(2026, 10, 2, 21, 0));
  assert.equal(parseEvent({ id: "3", status: "cancelled", start: { dateTime: iso(9) } }, "Work", 180), null);
  assert.equal(parseEvent(ev("4", "Nope", iso(9), iso(10), { attendees: [{ self: true, responseStatus: "declined" }] }), "Work", 180)!.declined, true);
  assert.equal(parseEvent({ summary: "no id" }, "Work", 180), null);
});

test("agenda: overlaps are flagged; all-day and declined events never clash", () => {
  const mk = (id: string, s: string, e: string, o: Partial<CalEvent> = {}): CalEvent => ({ id, cal: "c", title: id, start: Date.parse(s), end: Date.parse(e), allDay: false, location: null, attendees: 0, declined: false, ...o });
  const a = mk("Planning", iso(9), iso(10)), b = mk("Call", iso(9, 30), iso(10, 30)), c = mk("Lunch", iso(12), iso(13)), allday = mk("Offsite", iso(0), iso(23), { allDay: true }), dec = mk("Declined", iso(9, 15), iso(9, 45), { declined: true });
  assert.equal(conflicts([a, b, c, allday, dec]).length, 1);
  const text = agendaText([a, b, c, allday], T0, 180);
  assert.match(text, /^Today 03-11-2026/);
  assert.match(text, /09:00-10:00 Planning/);
  assert.match(text, /Heads up: Planning overlaps Call at 09:30\./);
  assert.match(text, /Tomorrow 04-11-2026\nNo events\./);
  assert.match(briefLine([a, b, c], T0, 180)!, /^Calendar: 09:00 Planning \| 09:30 Call \| 12:00 Lunch$/);
  assert.equal(briefLine([], T0, 180), null);
});

test("oauth callback: only a valid, unused state works; the token is stored encrypted; first sync runs; owner is told", async () => {
  const s = setup([], { events: { primary: [ev("e1", "Standup", iso(9), iso(9, 30))] } });
  await owned(s);
  const { state, nonce } = await makeState(GENV, T0);
  await s.db.prepare("INSERT INTO settings (key, value) VALUES ('oauth_nonce', ?)").bind(nonce).run();
  const bad = await handleGoogleCallback(s.ctx(), s.tg, new URL("https://x/oauth/google/callback?code=abc&state=nope"));
  assert.equal(bad.status, 400);
  assert.equal(s.wd.w.calls.filter((c) => c.method === "token").length, 0, "no code exchange for a bad state");
  const ok = await handleGoogleCallback(s.ctx(), s.tg, new URL(`https://x/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`));
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Rafiki can now read your calendar/);
  const row = s.db.raw.prepare("SELECT enc FROM credentials WHERE provider='google'").get() as { enc: string };
  assert.ok(!row.enc.includes("rt-secret-xyz"), "the refresh token is not stored in plain text");
  assert.equal(JSON.parse(await decrypt(GENV.ENCRYPTION_KEY!, row.enc)).refresh_token, "rt-secret-xyz");
  assert.ok(sent(s.tgCalls).some((t) => /Google Calendar connected\. I can see 1 events across 1 calendars/.test(t)));
  const again = await handleGoogleCallback(s.ctx(), s.tg, new URL(`https://x/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`));
  assert.equal(again.status, 400, "a state can be used once");
  assert.equal((await handleGoogleCallback(s.ctx(), s.tg, new URL("https://x/oauth/google/callback?error=access_denied"))).status, 400);
});

test("sync: holiday and contact calendars are skipped, events cached, a failing calendar keeps its last good copy, gone calendars are removed", async () => {
  const s = setup([], {
    calendars: [{ id: "primary", summary: "Sam", selected: true }, { id: "work", summary: "Work", selected: true }, { id: "x#holiday@group.v.calendar.google.com", summary: "Holidays", selected: true }, { id: "off", summary: "Off", selected: false }],
    events: { primary: [ev("a", "Gym", iso(6), iso(7))], work: [ev("b", "Board prep", iso(10), iso(11)), ev("c", "Offsite", iso(9), iso(10))] },
  });
  await connect(s);
  const r = await syncCalendar(s.ctx());
  assert.deepEqual(r, { status: "ok", calendars: 2, events: 3 });
  assert.equal((await getEvents(s.db, T0 - 2 * 3600000, T0 + 86400000)).length, 3);
  s.wd.w.failCal = "work";
  const later = T0 + 20 * 60000;
  assert.equal((await syncCalendar(s.ctx(later))).status, "ok");
  assert.equal((await getEvents(s.db, T0 - 2 * 3600000, T0 + 86400000)).length, 3, "work kept its last good copy");
  s.wd.w.calendars = [{ id: "primary", summary: "Sam", selected: true }];
  s.wd.w.failCal = undefined;
  await syncCalendar(s.ctx(later + 20 * 60000));
  assert.equal((await getEvents(s.db, T0 - 2 * 3600000, T0 + 86400000)).length, 1, "the removed calendar is gone");
});

test("sync: an expired Google grant is reported once, not every tick; healthy syncs are throttled to 5 minutes", async () => {
  const s = setup([], { tokenError: "invalid_grant" });
  await owned(s); await connect(s);
  assert.equal((await maybeSync(s.ctx(), s.tg, OWNER))?.status, "expired");
  assert.equal((await maybeSync(s.ctx(T0 + 6 * 60000), s.tg, OWNER))?.status, "expired");
  assert.equal(sent(s.tgCalls).filter((t) => /connection has expired/.test(t)).length, 1);
  const h = setup([], { events: { primary: [] } });
  await owned(h); await connect(h);
  assert.equal((await maybeSync(h.ctx(), h.tg, OWNER))?.status, "ok");
  assert.equal(await maybeSync(h.ctx(T0 + 2 * 60000), h.tg, OWNER), null, "throttled");
  assert.equal((await maybeSync(h.ctx(T0 + 6 * 60000), h.tg, OWNER))?.status, "ok");
  assert.equal(await maybeSync(setup().ctx(), setup().tg, OWNER), null, "not connected, nothing to do");
});

test("nudges: a meeting with people or a place gets one heads-up 10 to 20 minutes before, inside the interrupt budget", async () => {
  const s = setup([], { events: { primary: [
    ev("m1", "Board call", iso(8, 15), iso(9), { attendees: [{ self: true }, { responseStatus: "accepted" }] }),
    ev("m2", "Solo focus", iso(8, 15), iso(9)),
    ev("m3", "Coffee", iso(8, 15), iso(9), { location: "Java Westlands" }),
    ev("m4", "Declined meeting", iso(8, 15), iso(9), { attendees: [{ self: true, responseStatus: "declined" }, {}] }),
  ] } });
  await owned(s); await connect(s);
  await syncCalendar(s.ctx());
  assert.equal(await meetingNudges(s.ctx(), s.tg, OWNER), 2);
  assert.equal(await meetingNudges(s.ctx(T0 + 60000), s.tg, OWNER), 0, "once per meeting");
  const out = sent(s.tgCalls).join("\n");
  assert.match(out, /In 15 minutes: 08:15-09:00 Board call \(2 people\)/);
  assert.match(out, /Coffee @ Java Westlands/);
  assert.ok(!/Solo focus|Declined meeting/.test(out));
  const q = setup([], { events: { primary: [ev("n", "Late call", iso(22, 15), iso(23), { attendees: [{}, {}] })] } });
  await owned(q); await connect(q);
  const night = T0 + 14 * 3600000 + 0; // 22:00 EAT
  await syncCalendar(q.ctx(night));
  assert.equal(await meetingNudges(q.ctx(night), q.tg, OWNER), 0, "quiet hours");
  await q.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('meeting_nudges','0')").bind().run();
  assert.equal(await meetingNudges(q.ctx(T0), q.tg, OWNER), 0, "switched off");
});

test("brief: shows the day's calendar and a clash warning, still within eight lines", async () => {
  const s = setup([], { events: { primary: [ev("a", "Planning", iso(9), iso(10)), ev("b", "Call", iso(9, 30), iso(10, 30)), ev("c", "Lunch", iso(12), iso(13)), ev("d", "Gym", iso(17), iso(18))] } });
  await owned(s); await connect(s);
  await syncCalendar(s.ctx());
  await s.db.prepare("INSERT INTO tasks (ts, text) VALUES (?, 'Draft the Otieno nudge')").bind(T0).run();
  assert.equal(await maybeBrief(s.ctx(T0 + 60000), s.tg, OWNER), true);
  const brief = sent(s.tgCalls).find((t) => /^Morning\./.test(t))!;
  assert.match(brief, /Calendar: 09:00 Planning \| 09:30 Call \| 12:00 Lunch \(\+1 more\)/);
  assert.match(brief, /Heads up: Planning overlaps Call at 09:30\./);
  assert.ok(brief.split("\n").length <= 8);
  assert.match(await buildBrief(s.ctx()), /Draft the Otieno nudge/);
});

test("agent context: the model sees the next seven days of calendar as data, labelled", async () => {
  const s = setup([agentJson({ reply: "You have a call at 09:30.", actions: [] })], { events: { primary: [ev("a", "Otieno call", iso(9, 30), iso(10, 30), { attendees: [{}, {}] }), ev("far", "Next month thing", iso(9, 0, 12), iso(10, 0, 12))] } });
  await owned(s); await connect(s);
  await syncCalendar(s.ctx());
  await handleUpdate(s.deps, msg("what does my day look like, do I have time for my goals?"));
  const ctx = (s.llm[0]!.body.messages as { content: string }[])[1]!.content;
  assert.match(ctx, /CALENDAR, next 7 days \(data\): .*09:30-10:30 Otieno call \(2 people\)/);
  assert.ok(!/Next month thing/.test(ctx), "events beyond 7 days are left out of the prompt");
});

test("commands: /connect without setup explains; with setup gives a URL button; connected shows status; /agenda; /disconnect revokes and clears", async () => {
  const none = setup();
  await owned(none);
  await handleUpdate({ ...none.deps, env: { ...ENV } }, msg("/connect"));
  assert.ok(sent(none.tgCalls).some((t) => /not set up yet/.test(t) && /oauth\/google\/callback/.test(t)));

  const s = setup([], { events: { primary: [ev("a", "Standup", iso(9), iso(9, 30))] } });
  await owned(s);
  await handleUpdate(s.deps, msg("/agenda"));
  assert.ok(sent(s.tgCalls).some((t) => /No calendar is connected yet/.test(t)));
  await handleUpdate(s.deps, msg("/connect"));
  const btn = s.tgCalls.filter((c) => c.method === "sendMessage").pop()!.body.reply_markup as { inline_keyboard: { text: string; url?: string }[][] };
  assert.equal(btn.inline_keyboard[0]![0]!.text, "Connect Google Calendar");
  assert.match(btn.inline_keyboard[0]![0]!.url!, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.ok((s.db.raw.prepare("SELECT value FROM settings WHERE key='oauth_nonce'").get() as { value: string }).value.length > 8);

  await connect(s);
  await handleUpdate(s.deps, tap("cal:sync"));
  assert.ok(sent(s.tgCalls).some((t) => /Synced 1 events from 1 calendars/.test(t)));
  await handleUpdate(s.deps, msg("/agenda"));
  assert.ok(sent(s.tgCalls).some((t) => /09:00-09:30 Standup/.test(t)));
  await handleUpdate(s.deps, msg("/connect"));
  assert.ok(sent(s.tgCalls).some((t) => /Google Calendar is connected, last synced/.test(t)));
  await handleUpdate(s.deps, msg("/disconnect"));
  assert.ok(sent(s.tgCalls).some((t) => /Disconnected, and Google has been told to revoke/.test(t)));
  assert.equal(s.wd.w.calls.filter((c) => c.method === "revoke")[0]!.body.token, "rt-secret-xyz");
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM credentials").get() as { n: number }).n, 0);
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM cal_cache").get() as { n: number }).n, 0);
});

test("freshness: a calendar question re-syncs first, so an event added a minute ago is seen", async () => {
  const s = setup([agentJson({ reply: "You have dinner at 20:00.", actions: [] })], { events: { primary: [] } });
  await owned(s); await connect(s);
  await syncCalendar(s.ctx(T0 - 10 * 60000)); // an old copy with no events
  s.wd.w.events = { primary: [ev("d", "Dinner", iso(20), iso(21), { location: "Nairobi" })] }; // added in Google since
  await handleUpdate(s.deps, msg("what's on my calendar today?"));
  const c = (s.llm[0]!.body.messages as { content: string }[])[1]!.content;
  assert.match(c, /CALENDAR, next 7 days \(data\): .*20:00-21:00 Dinner @ Nairobi/);
  // a non-calendar question does not trigger a sync
  const before = s.wd.w.calls.length;
  const t = setup([agentJson({ reply: "ok", actions: [] })], { events: { primary: [] } });
  await owned(t); await connect(t);
  await syncCalendar(t.ctx(T0 - 10 * 60000));
  const n0 = t.llm.length;
  await handleUpdate(t.deps, msg("help me draft a note to my team"));
  assert.equal(t.wd.w.calls.filter((c2) => c2.method === "token").length, 1, "only the first sync refreshed a token");
  void before; void n0;
});

test("calendars: noise calendars such as Phases of the Moon are off by default, and /calendars switches any calendar on or off", async () => {
  const s = setup([], { calendars: [{ id: "primary", summary: "BGK", selected: true }, { id: "moon@group", summary: "Phases of the Moon", selected: true }, { id: "fam@group", summary: "Family", selected: true }], events: { primary: [ev("a", "Standup", iso(9), iso(10))], "moon@group": [ev("m", "Full Moon", iso(12), iso(13))], "fam@group": [ev("f", "School concert", iso(15), iso(16))] } });
  await owned(s); await connect(s);
  const r = await syncCalendar(s.ctx());
  assert.deepEqual(r, { status: "ok", calendars: 2, events: 2 });
  assert.equal((await getEvents(s.db, T0 - 3600000, T0 + 86400000)).some((e) => e.title === "Full Moon"), false);
  await handleUpdate(s.deps, msg("/calendars"));
  assert.match(sent(s.tgCalls).pop()!, /BGK: on\n- Phases of the Moon: off\n- Family: on/);
  const keyboard = JSON.stringify(s.tgCalls.filter((c) => c.method === "sendMessage").pop()!.body.reply_markup);
  assert.match(keyboard, /Turn off: Family/);
  await handleUpdate(s.deps, tap("cal:t:2")); // Family
  const names = (await getEvents(s.db, T0 - 3600000, T0 + 86400000)).map((e) => e.title);
  assert.ok(!names.includes("School concert"));
  assert.match(sent(s.tgCalls).pop()!, /Family is now off/);
  // a calendar switched off stays in the list, so it can be switched back on (found in live testing)
  await handleUpdate(s.deps, msg("/calendars"));
  assert.match(sent(s.tgCalls).pop()!, /- Family: off/);
  await handleUpdate(s.deps, tap("cal:t:2"));
  assert.match(sent(s.tgCalls).pop()!, /Family is now on/);
  assert.ok((await getEvents(s.db, T0 - 3600000, T0 + 86400000)).some((e) => e.title === "School concert"));
  await handleUpdate(s.deps, tap("cal:t:1")); // the Moon, hidden as noise, can be turned on
  assert.ok((await getEvents(s.db, T0 - 3600000, T0 + 86400000)).some((e) => e.title === "Full Moon"));
});
