import assert from "node:assert/strict";
import { test } from "node:test";
import { executeActions, validateActions } from "../src/actions.ts";
import { runAgent, type Ctx } from "../src/agent.ts";
import { reminderCallback } from "../src/callbacks.ts";
import { parseWhen } from "../src/when.ts";
import { nextRepeat, remindersCallback, remindersPanel } from "../src/remind.ts";
import { sweepReminders } from "../src/schedule.ts";
import { Telegram } from "../src/telegram.ts";
import { ENV, agentJson, fakeFetch, makeDb, sent } from "./shim.ts";

const OWNER = 100200300;
const DAY = 86400000;
const OFF = 180;
const eat = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi) - OFF * 60000;
const T0 = eat(2026, 10, 16, 12); // Fri 16-10-2026 12:00 EAT
const btns = (c: { body: Record<string, unknown> }): { text: string; callback_data?: string }[] => ((c.body.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] } | undefined)?.inline_keyboard ?? []).flat();

function setup() {
  const db = makeDb();
  const fx = fakeFetch([]);
  const ctx = (n = T0): Ctx => ({ db, env: ENV, f: fx.f, now: n, off: OFF });
  return { db, fx, ctx, tg: new Telegram(ENV.TELEGRAM_BOT_TOKEN, fx.f) };
}
type S = ReturnType<typeof setup>;
const rem = (s: S, text: string, due: number, repeat = "none", state = "open", mode: string | null = "once"): number => {
  const id = Number((s.db.raw.prepare("INSERT INTO reminders (ts, text, due_ts, repeat, state) VALUES (?, ?, ?, ?, ?) RETURNING id").get(T0 - DAY, text, due, repeat, state) as { id: number }).id);
  if (mode) s.db.raw.prepare("INSERT INTO reminder_policy (reminder_id, mode, gap_ms, max_chase) VALUES (?, ?, 7200000, 3)").run(id, mode);
  return id;
};
const all = (s: S): { id: number; text: string; due_ts: number; state: string; repeat: string }[] => s.db.raw.prepare("SELECT id, text, due_ts, state, repeat FROM reminders ORDER BY id").all() as never;

test("repeats: daily, weekly, weekdays and monthly keep the local time; the 31st becomes the month's last day; the year rolls over", () => {
  assert.equal(nextRepeat(eat(2026, 10, 16, 9), "daily", OFF, T0), eat(2026, 10, 17, 9));
  assert.equal(nextRepeat(eat(2026, 10, 16, 9), "weekly", OFF, T0), eat(2026, 10, 23, 9));
  assert.equal(nextRepeat(eat(2026, 10, 16, 9), "weekdays", OFF, T0), eat(2026, 10, 19, 9), "Friday's next weekday is Monday");
  assert.equal(nextRepeat(eat(2026, 10, 14, 9), "weekdays", OFF, T0), eat(2026, 10, 19, 9), "Wednesday's occurrences already past skip ahead");
  assert.equal(nextRepeat(eat(2026, 10, 28, 9), "monthly", OFF, eat(2026, 10, 28, 10)), eat(2026, 11, 28, 9));
  assert.equal(nextRepeat(eat(2027, 1, 31, 9), "monthly", OFF, eat(2027, 1, 31, 10)), eat(2027, 2, 28, 9), "31 January then 28 February");
  assert.equal(nextRepeat(eat(2026, 12, 15, 9), "monthly", OFF, eat(2026, 12, 15, 10)), eat(2027, 1, 15, 9), "December rolls into January");
  assert.equal(nextRepeat(eat(2026, 10, 16, 9), "none", OFF, T0), null);
  assert.equal(nextRepeat(eat(2026, 9, 1, 9), "monthly", OFF, T0), eat(2026, 11, 1, 9), "a long-missed monthly skips to the next one still ahead");
});

test("a repeating reminder carries on by itself: sent once, its next occurrence waits, even when the owner never taps Done", async () => {
  const s = setup();
  rem(s, "Pay rent", eat(2026, 10, 16, 11), "monthly", "open", "once");
  await sweepReminders(s.ctx(), s.tg, OWNER);
  const rows = all(s);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.state, "sent");
  assert.deepEqual([rows[1]!.text, rows[1]!.state, rows[1]!.repeat, rows[1]!.due_ts], ["Pay rent", "open", "monthly", eat(2026, 11, 16, 11)]);
  assert.equal((s.db.raw.prepare("SELECT mode FROM reminder_policy WHERE reminder_id = ?").get(rows[1]!.id) as { mode: string }).mode, "once", "the next occurrence keeps the rule");
  await sweepReminders(s.ctx(T0 + 3 * 3600000), s.tg, OWNER);
  assert.equal(all(s).length, 2, "sweeping again creates no second copy");
});

test("Done on a repeating reminder does not double it; a pre-existing one with no successor still gets one", async () => {
  const s = setup();
  const a = rem(s, "Weekly review", eat(2026, 10, 16, 11), "weekly", "open", "chase");
  await sweepReminders(s.ctx(), s.tg, OWNER); // creates the next occurrence
  await reminderCallback(s.ctx(T0 + 3600000), s.tg, OWNER, `r:d:${a}`);
  assert.equal(all(s).filter((r) => r.text === "Weekly review").length, 2, "still two: one done, one waiting");
  const b = rem(s, "Old repeater", eat(2026, 10, 15, 9), "daily", "open", null); // made before this change, no successor
  await reminderCallback(s.ctx(), s.tg, OWNER, `r:d:${b}`);
  const olds = all(s).filter((r) => r.text === "Old repeater");
  assert.equal(olds.length, 2);
  assert.equal(olds[1]!.due_ts, eat(2026, 10, 17, 9));
});

test("a reminder message offers Done, In 1 hour, Tomorrow, Next week and Cancel (or Stop repeating); Next week and Cancel work", async () => {
  const s = setup();
  const once = rem(s, "Call the bank", eat(2026, 10, 16, 11));
  const rep = rem(s, "Water the plants", eat(2026, 10, 16, 11), "weekly");
  await sweepReminders(s.ctx(), s.tg, OWNER);
  const sends = s.fx.tg.filter((c) => c.method === "sendMessage");
  assert.deepEqual(btns(sends[0]!).map((b) => b.text), ["Done", "In 1 hour", "Tomorrow", "Next week", "Cancel"]);
  assert.deepEqual(btns(sends[1]!).map((b) => b.text), ["Done", "In 1 hour", "Tomorrow", "Next week", "Stop repeating"]);
  await reminderCallback(s.ctx(), s.tg, OWNER, `r:n:${once}`);
  assert.match(sent(s.fx.tg).pop()!, /^Moved to Mon 19-10-2026 09:00\.$|^Moved to 19-10-2026 09:00\.$/);
  assert.equal(all(s).find((r) => r.id === once)!.due_ts, eat(2026, 10, 19, 9), "next week means next Monday morning");
  await reminderCallback(s.ctx(), s.tg, OWNER, `r:x:${rep}`);
  assert.match(sent(s.fx.tg).pop()!, /Stopped: Water the plants\. It will not repeat\./);
  assert.ok(all(s).filter((r) => r.text === "Water the plants").every((r) => r.state === "dropped"), "the waiting next occurrence is dropped too");
});

test("/reminders lists what is waiting with its repeat, hides heads-ups, and Tomorrow, Next week and Cancel act and redraw", async () => {
  const s = setup();
  rem(s, "Pay rent", eat(2026, 10, 28, 9), "monthly");
  rem(s, "Coming up in 1 day: Pay rent", eat(2026, 10, 27, 9));
  const call = rem(s, "Call John", eat(2026, 10, 17, 10));
  await remindersPanel(s.ctx(), s.tg, OWNER);
  const first = s.fx.tg.filter((c) => c.method === "sendMessage").pop()!;
  const text = String(first.body.text);
  assert.match(text, /1\. 17-10-2026 10:00 Call John/);
  assert.match(text, /2\. 28-10-2026 09:00 Pay rent \(every month\)/);
  assert.ok(!text.includes("Coming up"), "heads-up copies are not listed");
  assert.deepEqual(btns(first).map((b) => b.callback_data), [`rm:t:${call}`, `rm:w:${call}`, `rm:x:${call}`, "rm:t:1", "rm:w:1", "rm:x:1"]);
  await remindersCallback(s.ctx(), s.tg, OWNER, `rm:t:${call}`);
  assert.equal(all(s).find((r) => r.id === call)!.due_ts, eat(2026, 10, 17, 9));
  await remindersCallback(s.ctx(), s.tg, OWNER, `rm:x:${call}`);
  assert.equal(all(s).find((r) => r.id === call)!.state, "dropped");
  const last = String(s.fx.tg.filter((c) => c.method === "sendMessage").pop()!.body.text);
  assert.ok(!last.includes("Call John") && last.includes("Pay rent"), "the list redraws without it");
  await remindersCallback(s.ctx(), s.tg, OWNER, `rm:x:${call}`);
  assert.ok(sent(s.fx.tg).some((t) => /already closed/.test(t)), "a second tap changes nothing");
});

test("the model can move a reminder by words (never a second one), and a deadline gets a warning a day ahead", async () => {
  const s = setup();
  rem(s, "Send the invoice to Acme", eat(2026, 10, 16, 15));
  const acts = validateActions([
    { type: "reschedule", match: "invoice Acme", due: "2026-10-16T17:00" },
    { type: "reschedule", match: "invoice Acme", due: "2020-01-01T10:00" },
    { type: "reschedule", match: "", due: "2026-10-16T17:00" },
    { type: "reminder", text: "School fees due", due: "2026-10-30T09:00", repeat: "monthly", kind: "deadline" },
    { type: "reminder", text: "Standup", due: "2026-10-19T09:00", repeat: "weekdays" },
    { type: "reminder", text: "Odd repeat", due: "2026-10-20T09:00", repeat: "yearly" },
  ], T0, OFF);
  assert.equal(acts.length, 4, "a past time and an empty match are refused");
  assert.deepEqual(acts.filter((a) => a.type === "reminder").map((a) => (a.type === "reminder" ? a.repeat : "")), ["monthly", "weekdays", "none"]);
  const done = await executeActions(s.db, acts, T0, OFF);
  assert.match(done[0]!, /^Moved to Fri 16-10-2026 17:00: Send the invoice to Acme$/);
  assert.equal(all(s).find((r) => r.text === "Send the invoice to Acme")!.due_ts, eat(2026, 10, 16, 17));
  assert.equal(all(s).filter((r) => r.text === "Send the invoice to Acme").length, 1, "no duplicate");
  const fees = all(s).filter((r) => /School fees due/.test(r.text));
  assert.equal(fees.length, 2);
  assert.deepEqual(fees.map((r) => [r.text, r.due_ts]), [["Coming up in 1 day: School fees due", eat(2026, 10, 29, 9)], ["School fees due", eat(2026, 10, 30, 9)]]);
  const none = await executeActions(s.db, validateActions([{ type: "reschedule", match: "passport", due: "2026-10-16T18:00" }], T0, OFF), T0, OFF);
  assert.deepEqual(none, ['No open reminder matches "passport".']);
});

// Found live on 2026-10-17: "the 28th at 9am every month" was set for tomorrow, because a bare time of day overrode the date.
test("a date the time reader does not understand is left to the model: 'the 28th at 9am' is never tomorrow", async () => {
  for (const t of ["Remind me on the 28th at 9am every month to pay rent", "remind me 28/10 at 9am to call", "remind me on 28 October at 9 to renew", "remind me next month at 9am to pay", "remind me on the 1st of each month at 8am", "remind me at 9am on 2026-10-28"]) {
    assert.equal(parseWhen(t, T0, OFF), null, t);
  }
  // times and days it does understand are unchanged, including "9.30am", which is a time and not a date
  assert.equal(parseWhen("remind me tomorrow at 9.30am to call", T0, OFF), eat(2026, 10, 17, 9, 30));
  assert.equal(parseWhen("remind me at 5pm to call", T0, OFF), eat(2026, 10, 16, 17));
  assert.equal(parseWhen("remind me in 2 days, morning hours", T0, OFF), eat(2026, 10, 18, 9));
});

test("end to end: a monthly reminder the model dates to the 28th stays on the 28th, with the 28 kept as its monthly day", async () => {
  const s = setup();
  const fx = fakeFetch([agentJson({ reply: "Set.", actions: [{ type: "reminder", text: "Pay rent", due: "2026-10-28T09:00", repeat: "monthly", kind: "deadline" }], buttons: [] })]);
  const ctx: Ctx = { db: s.db, env: ENV, f: fx.f, now: T0, off: OFF };
  await runAgent(ctx, "Remind me on the 28th at 9am every month to pay rent");
  const rows = all(s);
  assert.deepEqual(rows.map((r) => [r.text, r.due_ts, r.repeat]), [["Coming up in 1 day: Pay rent", eat(2026, 10, 27, 9), "none"], ["Pay rent", eat(2026, 10, 28, 9), "monthly:28"]]);
});

test("cancelling or closing a reminder takes its warning copies too; moving it moves them by the same amount", async () => {
  const s = setup();
  const run = async (): Promise<void> => { await executeActions(s.db, validateActions([{ type: "reminder", text: "Pay the levy", due: "2026-10-30T09:00", repeat: "none", kind: "deadline" }], T0, OFF), T0, OFF); };
  await run();
  const warn = () => all(s).filter((r) => r.text.startsWith("Coming up"));
  assert.equal(warn().length, 1);
  const main = all(s).find((r) => r.text === "Pay the levy")!;
  // move the reminder by an hour: the warning moves with it
  await executeActions(s.db, validateActions([{ type: "reschedule", match: "levy", due: "2026-10-30T10:00" }], T0, OFF), T0, OFF);
  assert.equal(warn()[0]!.due_ts, eat(2026, 10, 29, 10));
  // cancel with the button: the warning is dropped, not left to fire
  await reminderCallback(s.ctx(), s.tg, OWNER, `r:x:${main.id}`);
  assert.equal(warn().filter((r) => r.state === "open").length, 0);
  // the close action does the same
  await run();
  await executeActions(s.db, validateActions([{ type: "close", kind: "reminder", match: "levy", state: "dropped" }], T0, OFF), T0, OFF);
  assert.equal(all(s).filter((r) => r.state === "open").length, 0, "nothing of it is left open");
});
