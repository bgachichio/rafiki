import assert from "node:assert/strict";
import { test } from "node:test";
import { executeActions, validateActions } from "../src/actions.ts";
import { buildContext, type Ctx } from "../src/agent.ts";
import { candidates, ensureToday, focusCallback } from "../src/focus.ts";
import { closeMatching, dmyKey, isLapsed } from "../src/lifecycle.ts";
import { goalsPanel, maybeGoalReview, panelCallback, staleNudge, tasksPanel } from "../src/panels.ts";
import { buildBrief, maybeBrief } from "../src/schedule.ts";
import { Telegram } from "../src/telegram.ts";
import { ENV, fakeFetch, makeDb, sent } from "./shim.ts";

const OWNER = 100200300;
const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 16, 5, 0); // Fri 16-10-2026 08:00 EAT
const btns = (c: { body: Record<string, unknown> }): { text: string; callback_data?: string }[] => ((c.body.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] } | undefined)?.inline_keyboard ?? []).flat();

function setup() {
  const db = makeDb();
  const fx = fakeFetch([]);
  const ctx = (n = T0): Ctx => ({ db, env: ENV, f: fx.f, now: n, off: 180 });
  return { db, fx, ctx, tg: new Telegram(ENV.TELEGRAM_BOT_TOKEN, fx.f) };
}
type S = ReturnType<typeof setup>;
const goal = (s: S, text: string, by: string | null): Promise<unknown> => s.db.prepare("INSERT INTO goals (ts, text, by_date) VALUES (?, ?, ?)").bind(T0 - 14 * DAY, text, by).run();
const task = (s: S, text: string, ageDays: number): Promise<unknown> => s.db.prepare("INSERT INTO tasks (ts, text) VALUES (?, ?)").bind(T0 - ageDays * DAY, text).run();
const state = (s: S, table: string, id = 1): string => (s.db.raw.prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;

test("dates: a goal date is lapsed only when it is before today; no date is never lapsed", () => {
  assert.equal(dmyKey("06-10-2026"), "20261006");
  assert.equal(dmyKey("2026-10-06"), null);
  assert.ok(isLapsed("06-10-2026", T0, 180));
  assert.ok(!isLapsed("16-10-2026", T0, 180), "today is not yet lapsed");
  assert.ok(!isLapsed("31-03-2027", T0, 180));
  assert.ok(!isLapsed(null, T0, 180));
  assert.ok(!isLapsed("soon", T0, 180));
});

test("the 250K case: a goal ten days past its date is neither the One nor in the brief, and a live goal still is", async () => {
  const s = setup();
  await goal(s, "Make 250K KES", "06-10-2026");
  assert.equal(await ensureToday(s.db, T0, 180), null, "a lapsed goal alone gives no One");
  assert.ok(!(await buildBrief(s.ctx())).includes("250K"));
  await goal(s, "Reach 2,000,000 KES per month", "31-03-2027");
  assert.deepEqual((await candidates(s.db, T0, 180)).map((c) => c.text), ["One step on: Reach 2,000,000 KES per month"]);
  assert.match(await buildBrief(s.ctx()), /Reach 2,000,000 KES per month/);
  assert.ok(!(await buildBrief(s.ctx())).includes("250K"));
});

test("tasks untouched for a week are parked: out of the One and the brief, still listed in /tasks", async () => {
  const s = setup();
  await task(s, "List prospects who can buy 250K worth of offers by Tuesday", 5 + 2);
  await task(s, "Draft the proposal", 1);
  assert.deepEqual((await candidates(s.db, T0, 180)).map((c) => c.text), ["Draft the proposal"]);
  const brief = await buildBrief(s.ctx());
  assert.match(brief, /Today's One: Draft the proposal/);
  assert.ok(!brief.includes("prospects"));
  await tasksPanel(s.ctx(), s.tg, OWNER);
  const msg = sent(s.fx.tg).pop()!;
  assert.match(msg, /List prospects who can buy 250K worth of offers by Tuesday \(7 days old, parked/);
  assert.match(msg, /Draft the proposal \(1 day old\)/);
});

test("the brief and the One share one list: something dropped as the One cannot return in 'Also on your plate'", async () => {
  const s = setup();
  await task(s, "Message top 3 past clients with upfront cash offer", 1);
  await task(s, "Draft the proposal", 1);
  await s.db.prepare("INSERT INTO focus (day, ts, text, ref, state) VALUES ('13-10-2026', ?, 'Message top 3 past clients with upfront cash offer', NULL, 'dropped')").bind(T0 - 3 * DAY).run();
  const brief = await buildBrief(s.ctx());
  assert.match(brief, /Today's One: Draft the proposal/);
  assert.ok(!brief.includes("Message top 3"), "dropped text is gone from the whole brief");
});

test("a morning brief offers Drop it beside One done and Swap it", async () => {
  const s = setup();
  await task(s, "Draft the proposal", 1);
  await maybeBrief(s.ctx(), s.tg, OWNER);
  const brief = s.fx.tg.filter((c) => c.method === "sendMessage").pop()!;
  assert.deepEqual(btns(brief).map((b) => b.text).slice(0, 3), ["One done", "Swap it", "Drop it"]);
});

test("Drop it on a goal step closes the goal for good; One done on a goal step does not finish the goal", async () => {
  const s = setup();
  await goal(s, "Reach 2,000,000 KES per month", "31-03-2027");
  await ensureToday(s.db, T0, 180);
  await focusCallback(s.ctx(), s.tg, OWNER, "f:done");
  assert.equal(state(s, "goals"), "open");
  s.db.raw.prepare("UPDATE focus SET state = 'open'").run();
  await focusCallback(s.ctx(), s.tg, OWNER, "f:drop");
  assert.equal(state(s, "goals"), "dropped");
  assert.deepEqual(await candidates(s.db, T0 + DAY, 180), []);
});

test("goal review: asked once a week after the brief with three real choices; Hit, +30 days and Close all work", async () => {
  const s = setup();
  await goal(s, "Make 250K KES", "06-10-2026");
  assert.ok(await maybeGoalReview(s.ctx(), s.tg, OWNER));
  const card = s.fx.tg.filter((c) => c.method === "sendMessage").pop()!;
  assert.match(String(card.body.text), /"Make 250K KES" passed its date \(06-10-2026\)\. I have taken it off your list and your One\./);
  assert.deepEqual(btns(card).map((b) => b.text), ["I hit it", "+30 days", "Close it"]);
  assert.ok(!(await maybeGoalReview(s.ctx(T0 + 3 * DAY), s.tg, OWNER)), "not asked again within the week");
  assert.ok(await maybeGoalReview(s.ctx(T0 + 8 * DAY), s.tg, OWNER), "asked again after a week if still open");
  await panelCallback(s.ctx(), s.tg, OWNER, "gl:ext:1");
  assert.match(sent(s.fx.tg).pop()!, /New date for "Make 250K KES": 15-11-2026\./);
  assert.ok(!isLapsed((s.db.raw.prepare("SELECT by_date FROM goals").get() as { by_date: string }).by_date, T0, 180));
  await panelCallback(s.ctx(), s.tg, OWNER, "gl:hit:1");
  assert.equal(state(s, "goals"), "done");
  await goal(s, "Another", "01-01-2027");
  await panelCallback(s.ctx(), s.tg, OWNER, "gl:drop:2");
  assert.equal(state(s, "goals", 2), "dropped");
  await panelCallback(s.ctx(), s.tg, OWNER, "gl:drop:2");
  assert.match(sent(s.fx.tg).pop()!, /already closed/, "a second tap changes nothing");
});

test("the brief carries the goal review right after it, and the parked-tasks line once a week", async () => {
  const s = setup();
  await goal(s, "Make 250K KES", "06-10-2026");
  await task(s, "An old task", 9);
  await maybeBrief(s.ctx(), s.tg, OWNER);
  const texts = sent(s.fx.tg);
  assert.match(texts[0]!, /1 task is over a week old and left off your list\. \/tasks to tidy\./);
  assert.match(texts[1]!, /passed its date/);
  assert.equal(await staleNudge(s.db, T0 + DAY), null, "said once a week, not daily");
  assert.match((await staleNudge(s.db, T0 + 8 * DAY))!, /1 task is over a week old/);
});

test("/tasks and /goals panels: one tap closes, the list comes back without it", async () => {
  const s = setup();
  await task(s, "First", 1);
  await task(s, "Second", 1);
  await tasksPanel(s.ctx(), s.tg, OWNER);
  const first = s.fx.tg.filter((c) => c.method === "sendMessage").pop()!;
  assert.deepEqual(btns(first).map((b) => b.callback_data), ["tk:d:1", "tk:x:1", "tk:d:2", "tk:x:2"]);
  await panelCallback(s.ctx(), s.tg, OWNER, "tk:x:1");
  const texts = sent(s.fx.tg);
  assert.equal(texts[texts.length - 2], "Dropped for good: First.");
  assert.ok(!texts[texts.length - 1]!.includes("First"));
  assert.equal(state(s, "tasks", 1), "dropped");
  await goal(s, "Make 250K KES", "06-10-2026");
  await goalsPanel(s.ctx(), s.tg, OWNER);
  assert.match(sent(s.fx.tg).pop()!, /Make 250K KES by 06-10-2026 - date passed, not on your list/);
});

test("closing by chat: the close action finds items by their words, reports what it closed, never deletes", async () => {
  const s = setup();
  await goal(s, "Make 250K KES", "06-10-2026");
  await task(s, "List prospects who can buy 250K worth of offers by Tuesday", 5);
  await task(s, "Message top 3 past clients with upfront cash offer", 5);
  await s.db.prepare("INSERT INTO reminders (ts, text, due_ts, state) VALUES (?, 'Review 250K goal progress', ?, 'flagged')").bind(T0, T0 - DAY).run();
  const acts = validateActions([
    { type: "close", kind: "goal", match: "Make 250K", state: "dropped" },
    { type: "close", kind: "task", match: "list prospects 250K", state: "dropped" },
    { type: "close", kind: "reminder", match: "250K goal progress", state: "done" },
    { type: "close", kind: "task", match: "passport", state: "done" },
    { type: "close", kind: "thing", match: "x" },
    { type: "close", kind: "task", match: "" },
  ], T0, 180);
  assert.equal(acts.length, 4, "an unknown kind and an empty match are refused");
  const done = await executeActions(s.db, acts, T0, 180);
  assert.deepEqual(done, ["Closed for good: Make 250K KES", "Closed for good: List prospects who can buy 250K worth of offers by Tuesday", "Marked done: Review 250K goal progress", 'No open task matches "passport".']);
  assert.equal(state(s, "goals"), "dropped");
  assert.equal(state(s, "reminders"), "done");
  assert.equal(state(s, "tasks", 2), "open", "an unrelated task is untouched");
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n, 2, "nothing is deleted");
  assert.deepEqual(await closeMatching(s.db, "task", "the and", "done"), [], "only stop words matches nothing");
});

test("text from outside (mail, automations) cannot close anything", async () => {
  const { ACTION_GATE } = await import("../src/gates.ts");
  assert.equal(ACTION_GATE.close, "G1");
  const src = (await import("node:fs")).readFileSync(new URL("../src/agent.ts", import.meta.url), "utf8");
  assert.ok(/!ctx\.untrusted \|\| a\.type === "reminder" \|\| a\.type === "task_add" \|\| a\.type === "calendar_link"/.test(src), "outside text is limited to reminders, tasks and calendar links; close is not among them");
});

test("the model is told what is stale: a lapsed goal and a parked task are marked in its context", async () => {
  const s = setup();
  await goal(s, "Make 250K KES", "06-10-2026");
  await task(s, "Old thing", 9);
  await task(s, "Fresh thing", 1);
  const c = await buildContext(s.db, T0, 180, false);
  assert.match(c, /Make 250K KES by 06-10-2026 \[DATE PASSED: not a live priority/);
  assert.match(c, /Old thing \[9 days old, parked: not a priority\]/);
  assert.match(c, /Fresh thing(?! \[)/);
});
