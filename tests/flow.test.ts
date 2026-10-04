import assert from "node:assert/strict";
import { test } from "node:test";
import { handleUpdate, type Deps } from "../src/handler.ts";
import worker from "../src/index.ts";
import { maybeBrief, maybeMonday, sweepReminders } from "../src/schedule.ts";
import { Telegram, type TgUpdate } from "../src/telegram.ts";
import type { Ctx } from "../src/agent.ts";
import { ENV, agentJson, fakeFetch, makeDb, sent, type LlmReply } from "./shim.ts";

const OWNER = 100200300;
const T0 = Date.UTC(2026, 10, 3, 5, 0); // Tue 03-11-2026 08:00 EAT
let uid = 1000;
const msg = (text: string, from = OWNER): TgUpdate => ({ update_id: ++uid, message: { message_id: uid, from: { id: from, first_name: "Sam" }, chat: { id: from }, text } });
const tap = (data: string, from = OWNER): TgUpdate => ({ update_id: ++uid, callback_query: { id: `cb${uid}`, from: { id: from, first_name: "Sam" }, data, message: { message_id: 7, chat: { id: from } } } });

function setup(queue: LlmReply[] = [], now = T0) {
  const db = makeDb();
  const fx = fakeFetch(queue);
  const deps: Deps = { db, env: ENV, f: fx.f, now };
  const at = (n: number): Deps => ({ ...deps, now: n });
  const ctx = (n = now): Ctx => ({ db, env: ENV, f: fx.f, now: n, off: 180 });
  return { db, fx, deps, at, ctx, tg: new Telegram(ENV.TELEGRAM_BOT_TOKEN, fx.f) };
}
async function claim(s: ReturnType<typeof setup>): Promise<void> {
  assert.equal(await handleUpdate(s.deps, msg("/start claim123")), "claimed");
}

test("ownership: strangers and wrong claim codes are ignored; the right claim binds the owner", async () => {
  const s = setup();
  assert.equal(await handleUpdate(s.deps, msg("hello", 111)), "ignored");
  assert.equal(await handleUpdate(s.deps, msg("/start wrongcode", 111)), "ignored");
  assert.equal(await handleUpdate(s.deps, msg("/start claim123", 222)), "claimed"); // first valid claim wins
  assert.equal(await handleUpdate(s.deps, msg("/start claim123", 333)), "not-owner");
  assert.equal(await handleUpdate(s.deps, msg("anything", 333)), "not-owner");
  assert.equal(s.fx.llm.length, 0);
  assert.equal(sent(s.fx.tg).length, 1, "only the owner's greeting was sent");
});

test("ownership: a stranger's message after claim gets no reply and no model call", async () => {
  const s = setup();
  await claim(s);
  const before = s.fx.tg.length;
  assert.equal(await handleUpdate(s.deps, msg("what are my goals?", 999)), "not-owner");
  assert.equal(await handleUpdate(s.deps, tap("cmd:pause", 999)), "not-owner");
  assert.equal(s.fx.tg.length, before);
  assert.equal(s.fx.llm.length, 0);
});

test("dedupe: the same update_id is processed once", async () => {
  const s = setup();
  await claim(s);
  const u = msg("/help");
  assert.equal(await handleUpdate(s.deps, u), "handled");
  assert.equal(await handleUpdate(s.deps, u), "duplicate");
});

test("webhook: wrong or missing secret gets 401; right secret gets 200 and processes; health and 404", async () => {
  const s = setup();
  const waits: Promise<unknown>[] = [];
  const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
  const env = { ...ENV, DB: s.db } as never;
  const post = (secret?: string) => new Request("https://x/tg", { method: "POST", headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {}, body: JSON.stringify(msg("/start claim123")) });
  assert.equal((await worker.fetch(post(), env, ectx)).status, 401);
  assert.equal((await worker.fetch(post("nope"), env, ectx)).status, 401);
  assert.equal(waits.length, 0, "nothing runs for an unauthenticated request");
  assert.equal((await worker.fetch(new Request("https://x/health"), env, ectx)).status, 200);
  assert.equal((await worker.fetch(new Request("https://x/other"), env, ectx)).status, 404);
  const bad = new Request("https://x/tg", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "whsec" }, body: "{not json" });
  assert.equal((await worker.fetch(bad, env, ectx)).status, 400);
});

test("onboarding: from claim to done in a few turns, with useful output at each step and a measured first value", async () => {
  const s = setup([
    agentJson({ role: "chief_of_staff", reply: "Reminder set and a nudge drafted.", actions: [{ type: "reminder", text: "Follow up with Otieno", due: "2026-11-04T09:00", repeat: "none" }, { type: "task_add", text: "Draft nudge to Otieno" }] }),
    agentJson({ role: "coach", reply: "Saved. By when?", actions: [{ type: "goal_add", text: "Launch my first product", metric: "first paying customer", target: "1 customer", by: "31-12-2026" }] }),
  ]);
  await claim(s);
  await handleUpdate(s.deps, tap("ob:r:week"));
  await handleUpdate(s.deps, msg("I never followed up on the Otieno quote"));
  await handleUpdate(s.deps, msg("Launch my first product by December"));
  await handleUpdate(s.deps, tap("km:later"));
  await handleUpdate(s.deps, tap("ctx:done"));
  await handleUpdate(s.deps, tap("ob:ok"));
  await handleUpdate(s.deps, tap("ob:t:06:30"));
  const out = sent(s.fx.tg);
  assert.match(out[0]!, /chief of staff, adviser, coach and business partner/);
  assert.ok(out.some((t) => /one thing slipping/i.test(t)));
  assert.ok(out.some((t) => /Reminder set for Wed 04-11-2026 09:00/.test(t)));
  assert.ok(out.some((t) => /working toward this year/i.test(t)));
  assert.ok(out.some((t) => /short questions, about four minutes/.test(t)));
  assert.ok(out.some((t) => /bring in what other assistants and your own files/.test(t)));
  assert.ok(out.some((t) => /sent in your name, or that spends money, waits for your tap/.test(t)));
  assert.ok(out.some((t) => /Your first brief arrives tomorrow/.test(t)));
  assert.equal((s.db.raw.prepare("SELECT value FROM settings WHERE key='brief_time'").get() as { value: string }).value, "06:30");
  assert.equal((s.db.raw.prepare("SELECT value FROM settings WHERE key='ob_step'").get() as { value: string }).value, "done");
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM reminders").get() as { n: number }).n, 1);
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM goals").get() as { n: number }).n, 1);
  // UX-01/UX-05 proxy: the first reply after Start is immediate, and first value arrives within 3 owner turns.
  assert.ok(sent(s.fx.tg).length >= 6);
});

test("agent: a model that proposes send, pay or delete actions gets none executed and none claimed", async () => {
  const s = setup([agentJson({ role: "chief_of_staff", reply: "I have emailed Otieno and paid the invoice.", actions: [{ type: "send_email", to: "otieno@example.com" }, { type: "pay", amount: 5000 }, { type: "delete_all" }] })]);
  await claim(s);
  await handleUpdate(s.deps, msg("please chase Otieno for me"));
  const rows = s.db.raw.prepare("SELECT trace FROM runs").all() as { trace: string }[];
  assert.deepEqual((JSON.parse(rows[0]!.trace) as { actions: string[] }).actions, []);
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM reminders").get() as { n: number }).n, 0);
});

test("privacy: secrets never reach the model or the message log; S2 text asks for zdr; S0 asks for nothing", async () => {
  const s = setup([agentJson({ reply: "ok", actions: [] }), agentJson({ reply: "ok", actions: [] }), agentJson({ reply: "ok", actions: [] })]);
  await claim(s);
  await handleUpdate(s.deps, msg("my openrouter key is sk-abcdefghijklmnopqrstuvwxyz123456 please remember it"));
  assert.ok(!JSON.stringify(s.fx.llm[0]!.body).includes("sk-abcdefghij"));
  const stored = JSON.stringify(s.db.raw.prepare("SELECT text FROM messages").all());
  assert.ok(!stored.includes("sk-abcdefghij"));
  assert.ok(sent(s.fx.tg).some((t) => /removed what looked like a secret/.test(t)));
  await handleUpdate(s.deps, msg("my salary went up, what should I do with the bonus?"));
  assert.deepEqual(s.fx.llm[1]!.body.provider, { zdr: true });
  await handleUpdate(s.deps, msg("what is a sinking fund"));
  assert.equal(s.fx.llm[2]!.body.provider, undefined);
  assert.ok(!JSON.stringify(s.fx.llm[2]!.body.messages).includes("GOALS"), "S0 questions carry no personal context");
});

test("privacy: employer confidential material is refused before any model call", async () => {
  const s = setup();
  await claim(s);
  await handleUpdate(s.deps, msg("Here is the Acme customer list with account number details, summarise it"));
  assert.equal(s.fx.llm.length, 0);
  assert.ok(sent(s.fx.tg).some((t) => /Acme and other employer or client confidential/.test(t)));
});

test("pause: /pause stops thinking and cron sends; /resume restores; the flag persists in the database", async () => {
  const s = setup();
  await claim(s);
  await handleUpdate(s.deps, msg("/pause"));
  await handleUpdate(s.deps, msg("can you help me plan my week"));
  assert.equal(s.fx.llm.length, 0);
  assert.ok(sent(s.fx.tg).some((t) => /I'm paused/.test(t)));
  await s.db.prepare("INSERT INTO reminders (ts, text, due_ts) VALUES (?,?,?)").bind(T0, "x", T0 - 1000).run();
  const before = s.fx.tg.length;
  assert.equal(await sweepReminders(s.ctx(), s.tg, OWNER), 0);
  assert.equal(await maybeBrief(s.ctx(), s.tg, OWNER), false);
  assert.equal(s.fx.tg.length, before);
  await handleUpdate(s.deps, msg("/resume"));
  assert.equal(await sweepReminders(s.ctx(), s.tg, OWNER), 1);
});

test("spend: quick path uses no model; fee comes from the user's table; totals add up", async () => {
  const s = setup();
  await claim(s);
  await handleUpdate(s.deps, msg("/fees mpesa 1-100=0 101-1000=13"));
  await handleUpdate(s.deps, msg("lunch 650 mpesa"));
  await handleUpdate(s.deps, msg("fuel 2,000 cash"));
  assert.equal(s.fx.llm.length, 0);
  const out = sent(s.fx.tg);
  assert.ok(out.some((t) => /Logged: Food, KES 650, M-PESA\.\nFee KES 13 \(your table\)\./.test(t)));
  assert.ok(out.some((t) => /Today: KES 2,650 spent, fees KES 13/.test(t)));
});

test("spend: without a fee table the fee is not invented", async () => {
  const s = setup();
  await claim(s);
  await handleUpdate(s.deps, msg("lunch 650 mpesa"));
  assert.ok(sent(s.fx.tg).some((t) => /No fee table for mpesa yet/.test(t)));
  assert.equal((s.db.raw.prepare("SELECT fee_cents FROM spends").get() as { fee_cents: number }).fee_cents, 0);
});

test("cap: when the daily model budget is spent, no model call is made", async () => {
  const s = setup();
  await claim(s);
  await s.db.prepare("INSERT INTO runs (ts, cost_usd, status) VALUES (?,?,?)").bind(T0 - 1000, 1.5, "ok").run();
  await handleUpdate(s.deps, msg("help me think about my week"));
  assert.equal(s.fx.llm.length, 0);
  assert.ok(sent(s.fx.tg).some((t) => /model budget .* is used up/.test(t)));
  await handleUpdate(s.deps, msg("/cap 3"));
  assert.ok(sent(s.fx.tg).some((t) => /set to USD 3.00/.test(t)));
});

test("reminders: sent when due, chased every 2 hours up to 3 times, flagged, then shown in the brief; Done stops it", async () => {
  const s = setup();
  await claim(s);
  await s.db.prepare("INSERT INTO reminders (ts, text, due_ts) VALUES (?,?,?)").bind(T0, "Call Otieno", T0).run();
  const gap = 2 * 3600000;
  assert.equal(await sweepReminders(s.ctx(T0), s.tg, OWNER), 1);
  assert.equal(await sweepReminders(s.ctx(T0 + 1000), s.tg, OWNER), 0, "not again before the gap");
  assert.equal(await sweepReminders(s.ctx(T0 + gap), s.tg, OWNER), 1);
  assert.equal(await sweepReminders(s.ctx(T0 + 2 * gap), s.tg, OWNER), 1);
  assert.equal(await sweepReminders(s.ctx(T0 + 3 * gap), s.tg, OWNER), 1);
  assert.equal(await sweepReminders(s.ctx(T0 + 4 * gap), s.tg, OWNER), 0, "flagged after the final chase");
  assert.equal((s.db.raw.prepare("SELECT state FROM reminders").get() as { state: string }).state, "flagged");
  assert.ok(sent(s.fx.tg).some((t) => t === "Reminder: Call Otieno"));
  assert.ok(sent(s.fx.tg).some((t) => t === "Still open: Call Otieno"));
  // chat out tomorrow's brief shows the flagged item
  await s.db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('brief_time','08:00')").bind().run();
  const next = T0 + 24 * 3600000;
  assert.equal(await maybeBrief(s.ctx(next), s.tg, OWNER), true);
  assert.ok(sent(s.fx.tg).some((t) => /Overdue, still open: Call Otieno/.test(t)));
  await handleUpdate({ ...s.deps, now: next }, tap("r:d:1"));
  assert.equal((s.db.raw.prepare("SELECT state FROM reminders").get() as { state: string }).state, "done");
});

test("reminders: a daily repeat is recreated when marked done; snooze moves it an hour", async () => {
  const s = setup();
  await claim(s);
  await s.db.prepare("INSERT INTO reminders (ts, text, due_ts, repeat) VALUES (?,?,?,?)").bind(T0, "Stand-up", T0, "daily").run();
  await handleUpdate(s.deps, tap("r:d:1"));
  const rows = s.db.raw.prepare("SELECT state, due_ts FROM reminders ORDER BY id").all() as { state: string; due_ts: number }[];
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.due_ts, T0 + 86400000);
  await handleUpdate(s.deps, tap("r:s:2"));
  assert.equal((s.db.raw.prepare("SELECT due_ts FROM reminders WHERE id=2").get() as { due_ts: number }).due_ts, T0 + 3600000);
});

test("quiet hours: first delivery of a user-set reminder still goes out; chases wait for the morning", async () => {
  const night = Date.UTC(2026, 10, 3, 19, 30); // 22:30 EAT
  const s = setup([], night);
  await claim(s);
  await s.db.prepare("INSERT INTO reminders (ts, text, due_ts) VALUES (?,?,?)").bind(night, "Take medicine", night).run();
  assert.equal(await sweepReminders(s.ctx(night), s.tg, OWNER), 1);
  assert.equal(await sweepReminders(s.ctx(night + 2 * 3600000 + 1000), s.tg, OWNER), 0, "chase suppressed in quiet hours");
});

test("brief: sent once a day at the chosen time, inside a one-hour window, with at most eight lines", async () => {
  const s = setup();
  await claim(s);
  await s.db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('brief_time','08:00')").bind().run();
  await s.db.prepare("INSERT INTO tasks (ts, text) VALUES (?,?)").bind(T0, "Draft the Otieno nudge").run();
  await s.db.prepare("INSERT INTO goals (ts, text, by_date) VALUES (?,?,?)").bind(T0, "Launch my first product", "31-12-2026").run();
  assert.equal(await maybeBrief(s.ctx(T0 - 10 * 60000), s.tg, OWNER), false, "too early");
  assert.equal(await maybeBrief(s.ctx(T0 + 5 * 60000), s.tg, OWNER), true);
  assert.equal(await maybeBrief(s.ctx(T0 + 10 * 60000), s.tg, OWNER), false, "once per day");
  const brief = sent(s.fx.tg).find((t) => /^Morning\./.test(t))!;
  assert.ok(brief.split("\n").length <= 8);
  assert.match(brief, /Draft the Otieno nudge/);
  assert.match(brief, /Rafiki cost yesterday/);
  assert.equal(await maybeBrief(s.ctx(T0 + 24 * 3600000 + 90 * 60000), s.tg, OWNER), false, "outside the window");
});

test("monday ledger check: Mondays only, once, within the interrupt budget and quiet hours", async () => {
  const mon = Date.UTC(2026, 10, 2, 5, 0); // Mon 02-11-2026 08:00 EAT
  const s = setup([], mon);
  await claim(s);
  await s.db.prepare("INSERT INTO ledger (prospect, rung, next_ask, last_move_ts) VALUES (?,?,?,?)").bind("Otieno", 3, "deposit", mon).run();
  assert.equal(await maybeMonday(s.ctx(mon - 86400000), s.tg, OWNER), false, "not on Sunday");
  assert.equal(await maybeMonday(s.ctx(mon), s.tg, OWNER), true);
  assert.equal(await maybeMonday(s.ctx(mon + 60000), s.tg, OWNER), false, "once");
  assert.ok(sent(s.fx.tg).some((t) => /Monday check/.test(t) && /Otieno: rung 3/.test(t)));
  const s2 = setup([], mon);
  await claim(s2);
  for (let i = 0; i < 3; i++) await s2.db.prepare("INSERT INTO outbound (ts, kind, unsolicited) VALUES (?,?,1)").bind(mon, "x").run();
  assert.equal(await maybeMonday(s2.ctx(mon), s2.tg, OWNER), false, "interrupt budget exhausted");
});

test("model failure: the user gets a plain message, not a crash, and the failure is logged", async () => {
  const s = setup([{ status: 500 }, { status: 500 }]);
  await claim(s);
  await handleUpdate(s.deps, msg("help me plan the quarter"));
  assert.ok(sent(s.fx.tg).some((t) => /Something went wrong on my side while thinking/.test(t)));
  assert.equal((s.db.raw.prepare("SELECT status FROM runs").get() as { status: string }).status, "error");
});

test("commands: /log and /why report the last decision from the audit trail", async () => {
  const s = setup([agentJson({ role: "advisor", reply: "Here is a view.", actions: [{ type: "note", text: "Prefers short answers" }] })]);
  await claim(s);
  await handleUpdate(s.deps, msg("should I take this contract? my rate is fixed"));
  await handleUpdate(s.deps, msg("/why"));
  await handleUpdate(s.deps, msg("/log"));
  const out = sent(s.fx.tg).join("\n");
  assert.match(out, /Role: advisor/);
  assert.match(out, /Actions taken: Noted\./);
  assert.match(out, /advisor S1 model|advisor S\d model/);
});

test("reminders: when the model gets a relative time wrong, the owner's own words win", async () => {
  const bad = agentJson({ reply: "Set.", actions: [{ type: "reminder", text: "Call Otieno", due: "2026-11-04T08:02" }] }); // a day late
  const s = setup([bad]);
  await claim(s);
  await handleUpdate(s.deps, tap("km:later")); // leave onboarding out of the way
  await s.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ob_step', 'done')").bind().run();
  await handleUpdate(s.deps, msg("remind me in 2 minutes to call Otieno"));
  const r = s.db.raw.prepare("SELECT due_ts FROM reminders").get() as { due_ts: number };
  assert.equal(r.due_ts, T0 + 120000);
  assert.ok(sent(s.fx.tg).some((t) => /Reminder set for Tue 03-11-2026 08:02: Call Otieno/.test(t)));
  const trace = JSON.parse((s.db.raw.prepare("SELECT trace FROM runs ORDER BY id DESC LIMIT 1").get() as { trace: string }).trace) as { reminder_time_adjusted?: boolean };
  assert.equal(trace.reminder_time_adjusted, true);
});
