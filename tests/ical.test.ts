import assert from "node:assert/strict";
import { test } from "node:test";
import { handleUpdate, type Deps } from "../src/handler.ts";
import { getEvents, syncIfStale } from "../src/calendar.ts";
import { looksLikeFeed, normaliseFeedUrl, parseIcs, zonedToUtc, calendarName, listFeeds } from "../src/ical.ts";
import { getSetting, setSetting } from "../src/db.ts";
import type { Ctx } from "../src/agent.ts";
import type { TgUpdate } from "../src/telegram.ts";
import { ENV, fakeFetch, makeDb, sent } from "./shim.ts";

const OFF = 180;
const FROM = Date.UTC(2026, 9, 31); // 31-10-2026
const TO = Date.UTC(2026, 10, 14);
const wrap = (...events: string[]): string => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Family\r\n${events.map((e) => `BEGIN:VEVENT\r\n${e}\r\nEND:VEVENT\r\n`).join("")}END:VCALENDAR\r\n`;
const titles = (evs: { title: string }[]): string[] => evs.map((e) => e.title);

test("ics: a UTC event, a zoned event, an all-day event and a cancelled one", () => {
  const ics = wrap("UID:a\r\nDTSTART:20261103T060000Z\r\nDTEND:20261103T070000Z\r\nSUMMARY:UTC call", "UID:b\r\nDTSTART;TZID=Africa/Nairobi:20261104T090000\r\nDTEND;TZID=Africa/Nairobi:20261104T100000\r\nSUMMARY:Nairobi stand-up\\, weekly\r\nLOCATION:Office\r\nATTENDEE:mailto:a@x.com\r\nATTENDEE:mailto:b@x.com", "UID:c\r\nDTSTART;VALUE=DATE:20261105\r\nDTEND;VALUE=DATE:20261106\r\nSUMMARY:Holiday", "UID:d\r\nDTSTART:20261106T060000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:Cancelled");
  const ev = parseIcs(ics, "Family", FROM, TO, OFF);
  assert.deepEqual(titles(ev), ["UTC call", "Nairobi stand-up, weekly", "Holiday"]);
  assert.equal(ev[0]!.start, Date.UTC(2026, 10, 3, 6));
  assert.equal(ev[1]!.start, Date.UTC(2026, 10, 4, 6), "09:00 in Nairobi is 06:00 UTC");
  assert.equal(ev[1]!.attendees, 2);
  assert.equal(ev[1]!.location, "Office");
  assert.equal(ev[2]!.allDay, true);
  assert.equal(ev[2]!.start, Date.UTC(2026, 10, 5) - OFF * 60000, "all-day starts at local midnight");
  assert.equal(calendarName(ics), "Family");
});

test("ics: a zone with daylight saving is converted correctly, and folded lines are joined", () => {
  assert.equal(zonedToUtc(2026, 7, 1, 9, 0, 0, "Europe/London"), Date.UTC(2026, 6, 1, 8));
  assert.equal(zonedToUtc(2026, 12, 1, 9, 0, 0, "Europe/London"), Date.UTC(2026, 11, 1, 9));
  const ev = parseIcs(wrap("UID:f\r\nDTSTART:20261103T060000Z\r\nSUMMARY:A very long title that the calendar app has\r\n  folded over two lines"), "X", FROM, TO, OFF);
  assert.equal(ev[0]!.title, "A very long title that the calendar app has folded over two lines");
});

test("ics: weekly events expand on the right days, honour EXDATE and COUNT, and an edited occurrence replaces the original", () => {
  const weekly = "UID:w\r\nDTSTART;TZID=Africa/Nairobi:20261102T090000\r\nDTEND;TZID=Africa/Nairobi:20261102T093000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE\r\nEXDATE;TZID=Africa/Nairobi:20261104T090000\r\nSUMMARY:Gym";
  const moved = "UID:w\r\nRECURRENCE-ID;TZID=Africa/Nairobi:20261109T090000\r\nDTSTART;TZID=Africa/Nairobi:20261109T150000\r\nDTEND;TZID=Africa/Nairobi:20261109T153000\r\nSUMMARY:Gym (moved)";
  const ev = parseIcs(wrap(weekly, moved), "X", FROM, TO, OFF);
  const days = ev.map((e) => `${new Date(e.start + OFF * 60000).toISOString().slice(5, 16)} ${e.title}`);
  assert.ok(days.includes("11-02T09:00 Gym"));
  assert.ok(!days.includes("11-04T09:00 Gym"), "excluded date");
  assert.ok(days.includes("11-09T15:00 Gym (moved)"));
  assert.ok(!days.includes("11-09T09:00 Gym"), "the original was replaced");
  assert.ok(days.includes("11-11T09:00 Gym") && days.includes("11-13T09:00 Gym") === false);
  const counted = parseIcs(wrap("UID:c\r\nDTSTART:20261101T060000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Pill"), "X", FROM, TO, OFF);
  assert.equal(counted.length, 3);
  const monthly = parseIcs(wrap("UID:m\r\nDTSTART;VALUE=DATE:20260805\r\nRRULE:FREQ=MONTHLY\r\nSUMMARY:Rent"), "X", FROM, TO, OFF);
  assert.equal(monthly.length, 1);
  assert.equal(new Date(monthly[0]!.start + OFF * 60000).toISOString().slice(0, 10), "2026-11-05");
  const until = parseIcs(wrap("UID:u\r\nDTSTART:20261101T060000Z\r\nRRULE:FREQ=DAILY;UNTIL=20261103T060000Z\r\nSUMMARY:Short"), "X", FROM, TO, OFF);
  assert.equal(until.length, 2);
});

test("feeds: link detection and normalisation", () => {
  assert.ok(looksLikeFeed("webcal://p01-caldav.icloud.com/published/2/abc"));
  assert.ok(looksLikeFeed("https://calendar.google.com/calendar/ical/x%40gmail.com/private-abc/basic.ics"));
  assert.ok(!looksLikeFeed("https://example.com/article about calendars"));
  assert.ok(!looksLikeFeed("what is on my calendar"));
  assert.equal(normaliseFeedUrl("webcal://host/x.ics"), "https://host/x.ics");
  assert.equal(normaliseFeedUrl("http://host/x.ics"), null);
});

const URL1 = "https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc123/basic.ics";
const T0 = Date.UTC(2026, 10, 3, 5, 0);
const ICS = wrap("UID:a\r\nDTSTART:20261103T090000Z\r\nDTEND:20261103T100000Z\r\nSUMMARY:Board meeting\r\nLOCATION:Room 4\r\nATTENDEE:mailto:a@x\r\nATTENDEE:mailto:b@x");
let uid = 14000;
const msg = (text: string): TgUpdate => ({ update_id: ++uid, message: { message_id: uid, from: { id: 100200300, first_name: "Sam" }, chat: { id: 100200300 }, text } });
const tap = (data: string): TgUpdate => ({ update_id: ++uid, callback_query: { id: `c${uid}`, from: { id: 100200300, first_name: "Sam" }, data, message: { message_id: 9, chat: { id: 100200300 } } } });

async function setup(web: Record<string, string> = { [URL1]: ICS }) {
  const db = makeDb();
  const fx = fakeFetch([], {}, web);
  const deps: Deps = { db, env: ENV, f: fx.f, now: T0 };
  await handleUpdate(deps, msg("/start claim123"));
  await setSetting(db, "ob_step", "done");
  fx.tg.length = 0;
  const ctx = (n = T0): Ctx => ({ db, env: ENV, f: fx.f, now: n, off: OFF });
  return { db, fx, deps, ctx, web };
}

test("flow: pasting a private link adds a read-only calendar, deletes the message, stores the link encrypted, and /agenda shows its events", async () => {
  const s = await setup();
  await handleUpdate(s.deps, msg(URL1));
  assert.match(sent(s.fx.tg).at(-1)!, /Added Family: 1 event in the next two weeks\. I can only read it\. I deleted your message/);
  assert.ok(s.fx.tg.some((c) => c.method === "deleteMessage"), "the link does not stay in the chat");
  const cred = await s.db.prepare("SELECT enc FROM credentials WHERE provider LIKE 'ical:%'").bind().first<{ enc: string }>();
  assert.ok(cred && !cred.enc.includes("calendar.google.com") && !cred.enc.includes("abc123"), "stored encrypted");
  assert.equal(s.fx.llm.length, 0, "no model call, and the link was never stored as a message");
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE text LIKE '%abc123%'").get() as { n: number }).n, 0);
  await handleUpdate(s.deps, msg("/agenda"));
  assert.match(sent(s.fx.tg).at(-1)!, /Board meeting @ Room 4 \(2 people\)/);
  await handleUpdate(s.deps, msg("/calendars"));
  assert.match(sent(s.fx.tg).at(-1)!, /- Family: on \(link\)/);
});

test("flow: a bad link is explained, a non-calendar page is refused, and a seventh link is refused", async () => {
  const s = await setup({ [URL1]: ICS, "https://example.com/notacal.ics": "<html>hello</html>" });
  await handleUpdate(s.deps, msg("https://nowhere.example/missing.ics"));
  assert.match(sent(s.fx.tg).at(-1)!, /could not open that link/);
  await handleUpdate(s.deps, msg("https://example.com/notacal.ics"));
  assert.match(sent(s.fx.tg).at(-1)!, /not a calendar feed/);
  assert.equal((await listFeeds(s.ctx())).length, 0);
});

test("flow: a feed refreshes with the others, can be switched off and on, removed, and a failing feed keeps its last copy", async () => {
  const s = await setup();
  await handleUpdate(s.deps, msg(URL1));
  s.web[URL1] = wrap("UID:n\r\nDTSTART:20261103T120000Z\r\nDTEND:20261103T130000Z\r\nSUMMARY:Added later");
  await setSetting(s.db, "cal_last_sync", String(T0 - 10 * 60000));
  await syncIfStale(s.ctx(T0));
  assert.deepEqual(titles(await getEvents(s.db, T0 - 3600000, T0 + 86400000)), ["Added later"]);
  delete s.web[URL1];
  await setSetting(s.db, "cal_last_sync", String(T0 - 10 * 60000));
  await syncIfStale(s.ctx(T0));
  assert.deepEqual(titles(await getEvents(s.db, T0 - 3600000, T0 + 86400000)), ["Added later"], "the feed went away, the last good copy stays");
  await handleUpdate(s.deps, msg("/calendars"));
  await handleUpdate(s.deps, tap("cal:t:0"));
  assert.match(sent(s.fx.tg).at(-1)!, /Family is now off/);
  assert.deepEqual(await getEvents(s.db, T0 - 3600000, T0 + 86400000), []);
  s.web[URL1] = ICS;
  await handleUpdate(s.deps, tap("cal:t:0"));
  assert.match(sent(s.fx.tg).at(-1)!, /Family is now on/);
  assert.deepEqual(titles(await getEvents(s.db, T0 - 3600000, T0 + 86400000)), ["Board meeting"]);
  await handleUpdate(s.deps, tap("cal:rm:0"));
  assert.match(sent(s.fx.tg).at(-1)!, /Removed Family/);
  assert.equal((await listFeeds(s.ctx())).length, 0);
  assert.deepEqual(await getEvents(s.db, T0 - 3600000, T0 + 86400000), []);
  assert.equal(await getSetting(s.db, "cal_disabled") !== null, true);
});

test("flow: with no calendar yet, /agenda and /calendars say how to add one", async () => {
  const s = await setup();
  await handleUpdate(s.deps, msg("/agenda"));
  assert.match(sent(s.fx.tg).at(-1)!, /Secret address in iCal format/);
  await handleUpdate(s.deps, msg("/calendars"));
  assert.match(sent(s.fx.tg).at(-1)!, /I can only read it; I cannot change your calendar/);
});
