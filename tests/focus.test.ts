import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ctx } from "../src/agent.ts";
import { candidates, ensureToday, focusCallback, maybeShutdown, streak, weekScore } from "../src/focus.ts";
import { Telegram } from "../src/telegram.ts";
import { ENV, fakeFetch, makeDb, sent } from "./shim.ts";

const OWNER = 100200300;
const DAY = 86400000;
const T0 = Date.UTC(2026, 10, 4, 5, 0); // Wed 04-11-2026 08:00 EAT
const fmt = (ms: number): string => { const d = new Date(ms + 180 * 60000); return `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`; };

function setup() {
  const db = makeDb();
  const fx = fakeFetch([]);
  const ctx = (n = T0): Ctx => ({ db, env: ENV, f: fx.f, now: n, off: 180 });
  return { db, fx, ctx, tg: new Telegram(ENV.TELEGRAM_BOT_TOKEN, fx.f) };
}
const day = async (db: ReturnType<typeof makeDb>, daysAgo: number, state: string): Promise<void> => { await db.prepare("INSERT INTO focus (day, ts, text, state) VALUES (?, ?, 'x', ?)").bind(fmt(T0 - daysAgo * DAY), T0 - daysAgo * DAY, state).run(); };

test("the One: picked from the plate with nothing to choose, overdue first, then today's reminders, tasks, a goal step", async () => {
  const s = setup();
  await s.db.prepare("INSERT INTO goals (ts, text) VALUES (?, 'Reach 250K a month')").bind(T0).run();
  await s.db.prepare("INSERT INTO tasks (ts, text) VALUES (?, 'Draft the proposal')").bind(T0).run();
  await s.db.prepare("INSERT INTO reminders (ts, text, due_ts) VALUES (?, 'Call the bank', ?)").bind(T0, T0 + 3600000).run();
  await s.db.prepare("INSERT INTO reminders (ts, text, due_ts, state) VALUES (?, 'Pay KPLC', ?, 'flagged')").bind(T0, T0 - DAY).run();
  assert.deepEqual((await candidates(s.db, T0, 180)).map((c) => c.text), ["Overdue, still open: Pay KPLC", "Call the bank", "Draft the proposal", "One step on: Reach 250K a month"]);
  const f = await ensureToday(s.db, T0, 180);
  assert.equal(f!.text, "Overdue, still open: Pay KPLC");
  assert.equal((await ensureToday(s.db, T0 + 3600000, 180))!.text, f!.text, "once picked, it stays for the day");
});

test("the One: done closes the underlying reminder; swap offers the next three; a pick replaces it", async () => {
  const s = setup();
  await s.db.prepare("INSERT INTO reminders (ts, text, due_ts) VALUES (?, 'Call the bank', ?)").bind(T0, T0 + 3600000).run();
  await s.db.prepare("INSERT INTO tasks (ts, text) VALUES (?, 'Draft the proposal')").bind(T0).run();
  await focusCallback(s.ctx(), s.tg, OWNER, "f:swap");
  assert.match(sent(s.fx.tg).pop()!, /Swap today's One for/);
  await focusCallback(s.ctx(), s.tg, OWNER, "f:pick:0");
  assert.match(sent(s.fx.tg).pop()!, /Today's One is now: Draft the proposal/);
  await focusCallback(s.ctx(), s.tg, OWNER, "f:done");
  assert.match(sent(s.fx.tg).pop()!, /Done: Draft the proposal\. That's the day won\. If you have energy left: Call the bank\./);
  assert.equal((s.db.raw.prepare("SELECT state FROM tasks").get() as { state: string }).state, "done");
});

test("streak: consecutive done days count, one missed day a week is forgiven, a second one breaks it", async () => {
  const s = setup();
  for (const [ago, st] of [[1, "done"], [2, "done"], [3, "open"], [4, "done"], [5, "done"], [6, "done"], [7, "moved"], [8, "done"]] as const) await day(s.db, ago, st);
  const r = await streak(s.db, T0, 180);
  assert.equal(r.days, 5, "1, 2, rest on 3, then 4, 5, 6; 7 is a second miss within the week, so it stops");
  assert.equal(r.restUsed, true);
  await day(s.db, 0, "done");
  assert.equal((await streak(s.db, T0, 180)).days, 6, "today counts once done");
});

test("evening close: once, in its window, only for an open One, and it respects the nudge budget", async () => {
  const s = setup();
  const evening = T0 + 10.6 * 3600000; // 18:36 EAT
  assert.equal(await maybeShutdown(s.ctx(evening), s.tg, OWNER), false, "no One, nothing to ask");
  await s.db.prepare("INSERT INTO tasks (ts, text) VALUES (?, 'Draft the proposal')").bind(T0).run();
  await ensureToday(s.db, T0, 180);
  assert.equal(await maybeShutdown(s.ctx(T0), s.tg, OWNER), false, "08:00 is not the evening");
  assert.equal(await maybeShutdown(s.ctx(evening), s.tg, OWNER), true);
  assert.match(sent(s.fx.tg).pop()!, /Did today's One happen\? Draft the proposal/);
  assert.equal(await maybeShutdown(s.ctx(evening + 600000), s.tg, OWNER), false, "once a day");
  await focusCallback(s.ctx(evening), s.tg, OWNER, "f:tmr");
  assert.equal((s.db.raw.prepare("SELECT text FROM focus WHERE day = ?").get(fmt(T0 + DAY)) as { text: string }).text, "Draft the proposal");
});

test("week score: Ones done out of Ones set, as a bar, for the Monday check", async () => {
  const s = setup();
  for (const [ago, st] of [[1, "done"], [2, "done"], [3, "open"], [4, "done"]] as const) await day(s.db, ago, st);
  assert.match((await weekScore(s.db, T0, 180))!, /^Last week: 3 of 4 Ones done ▓▓▓░/);
});
