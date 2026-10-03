import assert from "node:assert/strict";
import { test } from "node:test";
import { handleUpdate, type Deps } from "../src/handler.ts";
import { executeActions, validateActions } from "../src/actions.ts";
import { maybeAskPreference } from "../src/learn.ts";
import { loadPolicy, parseLeads, DEFAULT_POLICY } from "../src/policy.ts";
import { afterSend, buildBrief, sweepReminders } from "../src/schedule.ts";
import { loadPrefs } from "../src/prefs.ts";
import { Telegram, type TgUpdate } from "../src/telegram.ts";
import type { Ctx } from "../src/agent.ts";
import { getSetting, setSetting } from "../src/db.ts";
import { ENV, agentJson, fakeFetch, makeDb, sent } from "./shim.ts";

const OWNER = 100200300;
const T0 = Date.UTC(2026, 10, 3, 9, 0); // 12:00 EAT
let uid = 9000;
const msg = (text: string): TgUpdate => ({ update_id: ++uid, message: { message_id: uid, from: { id: OWNER, first_name: "Sam" }, chat: { id: OWNER }, text } });
const tap = (data: string): TgUpdate => ({ update_id: ++uid, callback_query: { id: `c${uid}`, from: { id: OWNER, first_name: "Sam" }, data, message: { message_id: 9, chat: { id: OWNER } } } });
const pollAns = (poll_id: string, ids: number[]): TgUpdate => ({ update_id: ++uid, poll_answer: { poll_id, user: { id: OWNER, first_name: "Sam" }, option_ids: ids } });

async function setup(queue = [] as ReturnType<typeof agentJson>[], now = T0) {
  const db = makeDb();
  const fx = fakeFetch(queue);
  const deps: Deps = { db, env: ENV, f: fx.f, now };
  await handleUpdate(deps, msg("/start claim123"));
  await setSetting(db, "ob_step", "done");
  fx.tg.length = 0;
  const ctx = (n = now): Ctx => ({ db, env: ENV, f: fx.f, now: n, off: 180 });
  return { db, fx, deps, ctx, tg: new Telegram(ENV.TELEGRAM_BOT_TOKEN, fx.f), at: (n: number): Deps => ({ ...deps, now: n }) };
}
type S = Awaited<ReturnType<typeof setup>>;
const lastMsg = (s: S) => s.fx.tg.filter((c) => c.method === "sendMessage").at(-1)!;
const btns = (c: { body: Record<string, unknown> }) => ((c.body.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] } | undefined)?.inline_keyboard ?? []).flat();
const cardId = (s: S) => Number(btns(lastMsg(s))[0]!.callback_data!.split(":")[1]);
const pol = async (s: S) => (await loadPolicy(s.db));

test("cards: a preset tap applies the choice, marks it confirmed and stores what was offered", async () => {
  const s = await setup();
  await handleUpdate(s.deps, msg("/rules"));
  assert.ok(sent(s.fx.tg).some((t) => t.startsWith("9 quick questions")));
  // first card is "what to call you" with the Telegram name as the only preset
  assert.match(String(lastMsg(s).body.text), /What should I call you\?/);
  await handleUpdate(s.deps, tap(`dc:${cardId(s)}:0`));
  assert.equal((await loadPrefs(s.db)).call_me, "Sam");
  // second card: reminder behaviour, with the current default suggested first
  const card = lastMsg(s);
  assert.match(String(card.body.text), /how should I behave/);
  assert.ok(btns(card)[1]!.text.includes("Chase me") || btns(card).some((b) => b.text.startsWith("✅") && b.text.includes("Chase me")));
  const id = cardId(s);
  await handleUpdate(s.deps, tap(`dc:${id}:0`)); // "One reminder, then I leave it"
  assert.equal((await pol(s)).policy.mode, "once");
  assert.equal((await pol(s)).status["remind.mode"], "confirmed");
  const row = await s.db.prepare("SELECT state, chosen, options FROM decisions WHERE id = ?").bind(id).first<{ state: string; chosen: string; options: string }>();
  assert.equal(row?.state, "confirmed");
  assert.equal(row?.chosen, "once");
  assert.equal((JSON.parse(row!.options) as unknown[]).length, 3);
});

test("cards: 'my own' is read, repeated back, and applied only after a tap; unreadable text is asked again", async () => {
  const s = await setup();
  await handleUpdate(s.deps, msg("/rules"));
  for (let i = 0; i < 2; i++) await handleUpdate(s.deps, tap(`dc:${cardId(s)}:later`)); // skip to the event-leads card
  assert.match(String(lastMsg(s).body.text), /For events/);
  const id = cardId(s);
  await handleUpdate(s.deps, tap(`dc:${id}:own`));
  await handleUpdate(s.deps, msg("whenever"));
  assert.match(sent(s.fx.tg).at(-1)!, /I couldn't read that/);
  await handleUpdate(s.deps, msg("2 days and 30 minutes before"));
  assert.match(String(lastMsg(s).body.text), /I'll set reminders before events to: 2 days before, 30 minutes before\. Use it\?/);
  assert.deepEqual((await pol(s)).policy.eventLeads, DEFAULT_POLICY.eventLeads, "nothing is applied yet");
  await handleUpdate(s.deps, tap(`dc:${id}:yes`));
  assert.deepEqual((await pol(s)).policy.eventLeads, [2880, 30]);
  assert.equal(s.fx.llm.length, 0, "no model call while answering cards");
});

test("cards: 'decide later' keeps the default unconfirmed; 'use the defaults for the rest' ends the walk-through with a summary", async () => {
  const s = await setup();
  await handleUpdate(s.deps, msg("/rules"));
  await handleUpdate(s.deps, tap(`dc:${cardId(s)}:skip`));
  const sum = lastMsg(s);
  assert.match(String(sum.body.text), /Here is how I will work for you/);
  assert.match(String(sum.body.text), /· How I remind you: Chase me until I tap Done \(not confirmed\)/);
  assert.equal((await pol(s)).status["remind.mode"], undefined);
  await handleUpdate(s.deps, tap("dc:sum:all"));
  assert.equal((await pol(s)).status["remind.mode"], "confirmed");
  assert.equal((await pol(s)).policy.mode, "chase");
});

test("cards: a multi-choice card is a poll, and the answer is saved as the owner's languages", async () => {
  const s = await setup();
  await setSetting(s.db, "dc_seq", JSON.stringify(["lang"]));
  await handleUpdate(s.deps, msg("/rules"));
  s.fx.tg.length = 0;
  const { askDecision } = await import("../src/cards.ts");
  await askDecision(s.ctx(), s.tg, OWNER, "lang");
  const poll = s.fx.tg.find((c) => c.method === "sendPoll")!;
  assert.equal(poll.body.allows_multiple_answers, true);
  assert.equal(poll.body.is_anonymous, false);
  const pollId = (await s.db.prepare("SELECT poll_id FROM decisions WHERE key = 'lang' AND state = 'open'").bind().first<{ poll_id: string }>())!.poll_id;
  assert.equal(await handleUpdate(s.deps, pollAns(pollId, [0, 1])), "card-poll");
  assert.equal((await loadPrefs(s.db)).lang, "English, Swahili");
  assert.equal(s.fx.llm.length, 0);
});

test("policy: leads parse from plain words", () => {
  assert.deepEqual(parseLeads("1 day and 1 hour before"), [1440, 60]);
  assert.deepEqual(parseLeads("at the time"), [0]);
  assert.deepEqual(parseLeads("30 min, and on the day"), [30, 0]);
  assert.equal(parseLeads("whenever"), null);
});

test("reminders: an event gets the owner's lead times, a task gets one; each keeps the rule it was made under", async () => {
  const s = await setup();
  const due = T0 + 26 * 3600000;
  const [ev] = validateActions([{ type: "reminder", text: "Dinner with Jo", due: "2026-11-04T15:00", kind: "event" }], T0, 180);
  const [tk] = validateActions([{ type: "reminder", text: "Call Otieno", due: "2026-11-04T09:00" }], T0, 180);
  assert.equal(tk?.type === "reminder" && tk.kind, "task");
  const pl = { ...DEFAULT_POLICY, eventLeads: [1440, 60, 0], mode: "confirm" as const };
  const done = await executeActions(s.db, [ev!, tk!], T0, 180, undefined, pl);
  assert.match(done[0]!, /^Reminders set for .*, .*, .*: Dinner with Jo$/);
  assert.match(done[1]!, /^Reminder set for .*: Call Otieno$/);
  const rows = (await s.db.prepare("SELECT r.text, r.due_ts, p.mode FROM reminders r JOIN reminder_policy p ON p.reminder_id = r.id ORDER BY r.due_ts").bind().all<{ text: string; due_ts: number; mode: string }>()).results;
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.mode), ["once", "confirm", "once", "confirm"], "heads-ups are sent once; the main reminder follows the owner's rule");
  assert.ok(rows.some((r) => r.text === "Coming up in 1 day: Dinner with Jo"));
  void due;
});

test("reminders: 'once' sends and stops; 'confirm' sends once and stays on the brief until Done; chase is unchanged", async () => {
  const s = await setup();
  const mk = async (text: string, mode: string) => {
    const r = await s.db.prepare("INSERT INTO reminders (ts, text, due_ts) VALUES (?, ?, ?) RETURNING id").bind(T0, text, T0 - 1000).first<{ id: number }>();
    await s.db.prepare("INSERT INTO reminder_policy (reminder_id, mode, gap_ms, max_chase) VALUES (?, ?, 3600000, 2)").bind(r!.id, mode).run();
    return r!.id;
  };
  const a = await mk("rule once", "once"), b = await mk("rule confirm", "confirm"), c = await mk("rule chase", "chase");
  await s.db.prepare("INSERT INTO reminders (ts, text, due_ts) VALUES (?, 'legacy', ?)").bind(T0, T0 - 500).run();
  await sweepReminders(s.ctx(), s.tg, OWNER);
  const state = async (id: number) => (await s.db.prepare("SELECT state, due_ts FROM reminders WHERE id = ?").bind(id).first<{ state: string; due_ts: number }>())!;
  assert.equal((await state(a)).state, "sent");
  assert.equal((await state(b)).state, "awaiting");
  const ch = await state(c);
  assert.equal(ch.state, "open");
  assert.equal(ch.due_ts, T0 + 3600000, "the chase uses the gap the reminder was made with");
  const later = T0 + 5 * 3600000;
  await sweepReminders({ ...s.ctx(later) }, s.tg, OWNER);
  assert.equal((await state(a)).state, "sent");
  assert.equal((await state(b)).state, "awaiting", "not pinged again");
  assert.match(await buildBrief(s.ctx(later)), /Overdue, still open: rule confirm/);
  assert.ok(!(await buildBrief(s.ctx(later))).includes("rule once"));
  assert.deepEqual(afterSend({ id: 1, text: "x", due_ts: 0, chase_count: 2, repeat: "none", max_chase: 2 }, 5), { state: "flagged", due_ts: 0, chase_count: 3 });
  await handleUpdate(s.deps, tap(`r:d:${b}`));
  assert.equal((await state(b)).state, "done");
});

test("brief: the length follows the owner's rule", async () => {
  const s = await setup();
  for (const t of ["one", "two", "three", "four"]) await s.db.prepare("INSERT INTO tasks (ts, text) VALUES (?, ?)").bind(T0, `task ${t}`).run();
  assert.equal((await buildBrief(s.ctx())).split("\n").filter((l) => /^\d\. /.test(l)).length, 3);
  await s.db.prepare("INSERT INTO prefs (key, value, ts) VALUES ('brief.items', '1', 1)").bind().run();
  assert.equal((await buildBrief(s.ctx())).split("\n").filter((l) => /^\d\. /.test(l)).length, 1);
});

test("learning: three ignored chases lead to one question, once a day, in the daytime, with evidence and a suggestion", async () => {
  const s = await setup();
  for (let i = 0; i < 3; i++) await s.db.prepare("INSERT INTO signals (ts, kind) VALUES (?, 'chase_ignored')").bind(T0 - i * 1000).run();
  assert.equal(await maybeAskPreference(s.ctx(Date.UTC(2026, 10, 3, 1, 0)), s.tg, OWNER), false, "04:00 local: quiet");
  assert.equal(await maybeAskPreference(s.ctx(), s.tg, OWNER), true);
  const q = lastMsg(s);
  assert.match(String(q.body.text), /I chased you 3 times about things you left open/);
  assert.ok(btns(q).some((b) => b.text.startsWith("✅") && b.text.includes("keep it on my list")), "the suggestion is ticked");
  assert.equal(await maybeAskPreference(s.ctx(), s.tg, OWNER), false, "not twice in a day");
  assert.equal(await getSetting(s.db, "pref_asked_date"), "03-11-2026");
  assert.equal((await pol(s)).policy.mode, "chase", "asking changes nothing");
  assert.equal(s.fx.llm.length, 0);
});

test("learning: two thumbs down on briefs, or two 'shorter' requests, each lead to their own question; an unanswered question blocks the next", async () => {
  const s = await setup();
  await s.db.prepare("INSERT INTO signals (ts, kind) VALUES (?, 'brief_down'), (?, 'brief_down')").bind(T0 - 10, T0 - 20).run();
  assert.equal(await maybeAskPreference(s.ctx(), s.tg, OWNER), true);
  assert.match(String(lastMsg(s).body.text), /thumbs down 2 times/);
  await s.db.prepare("INSERT INTO signals (ts, kind) VALUES (?, 'shorter'), (?, 'shorter')").bind(T0 - 10, T0 - 20).run();
  assert.equal(await maybeAskPreference(s.ctx(T0 + 86400000), s.tg, OWNER), false, "the first question is still waiting");
  await handleUpdate(s.at(T0 + 86400000), tap(`dc:${cardId(s)}:later`));
  assert.equal(await maybeAskPreference(s.ctx(T0 + 86400000), s.tg, OWNER), true);
  assert.match(String(lastMsg(s).body.text), /asked me twice to be shorter/);
});

test("learning: asking respects the owner's nudge limit and pause", async () => {
  const s = await setup();
  for (let i = 0; i < 3; i++) await s.db.prepare("INSERT INTO signals (ts, kind) VALUES (?, 'chase_ignored')").bind(T0 - i).run();
  await s.db.prepare("INSERT INTO prefs (key, value, ts) VALUES ('nudges.max', '0', 1)").bind().run();
  assert.equal(await maybeAskPreference(s.ctx(), s.tg, OWNER), false);
  await s.db.prepare("DELETE FROM prefs WHERE key = 'nudges.max'").bind().run();
  await setSetting(s.db, "paused", "1");
  assert.equal(await maybeAskPreference(s.ctx(), s.tg, OWNER), false);
});

test("signals: a thumbs down on the brief and 'make it shorter' are recorded", async () => {
  const s = await setup([agentJson({ reply: "Okay.", actions: [] })]);
  await handleUpdate(s.deps, tap("fb:d:brief"));
  await handleUpdate(s.deps, msg("that was too long, be brief"));
  const kinds = (await s.db.prepare("SELECT kind FROM signals ORDER BY id").bind().all<{ kind: string }>()).results.map((r) => r.kind);
  assert.deepEqual(kinds, ["brief_down", "shorter"]);
});

test("onboarding: finishing it offers the walk-through", async () => {
  const s = await setup();
  await setSetting(s.db, "ob_step", "time");
  await handleUpdate(s.deps, tap("ob:t:07:00"));
  const offer = s.fx.tg.filter((c) => c.method === "sendMessage").find((c) => String(c.body.text).startsWith("One more thing"))!;
  assert.ok(btns(offer).some((b) => b.callback_data === "dc:seq"));
});
