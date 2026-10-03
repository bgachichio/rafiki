import assert from "node:assert/strict";
import { test } from "node:test";
import { handleUpdate, type Deps } from "../src/handler.ts";
import { sweepReminders, maybeBrief, maybeMonday } from "../src/schedule.ts";
import { addFact } from "../src/memory.ts";
import { addMessage, setSetting, getSetting } from "../src/db.ts";
import { FILES_PER_CALL } from "../src/privacy.ts";
import { Telegram, type TgUpdate } from "../src/telegram.ts";
import type { Ctx } from "../src/agent.ts";
import { ENV, agentJson, fakeFetch, makeDb, sent } from "./shim.ts";

const OWNER = 100200300;
const T0 = Date.UTC(2026, 10, 3, 5, 0);
let uid = 5000;
const msg = (text: string): TgUpdate => ({ update_id: ++uid, message: { message_id: uid, from: { id: OWNER, first_name: "Sam" }, chat: { id: OWNER }, text } });
const tap = (data: string, markup?: { text: string; callback_data?: string }[][], text = "Morning."): TgUpdate => ({ update_id: ++uid, callback_query: { id: `cb${uid}`, from: { id: OWNER, first_name: "Sam" }, data, message: { message_id: 9, chat: { id: OWNER }, text, reply_markup: markup ? { inline_keyboard: markup } : undefined } } });

async function setup(queue = [] as ReturnType<typeof agentJson>[], now = T0) {
  const db = makeDb();
  const fx = fakeFetch(queue);
  const deps: Deps = { db, env: ENV, f: fx.f, now };
  assert.equal(await handleUpdate(deps, msg("/start claim123")), "claimed");
  await setSetting(db, "ob_step", "done");
  fx.tg.length = 0;
  const ctx: Ctx = { db, env: ENV, f: fx.f, now, off: 180 };
  return { db, fx, deps, ctx, tg: new Telegram(ENV.TELEGRAM_BOT_TOKEN, fx.f), at: (n: number): Deps => ({ ...deps, now: n }) };
}
const buttons = (call: { body: Record<string, unknown> }): { text: string; callback_data?: string }[][] => ((call.body.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] } | undefined)?.inline_keyboard ?? []);
const docs = (s: { fx: { tg: { method: string; body: Record<string, unknown> }[] } }) => s.fx.tg.filter((c) => c.method === "sendDocument");

test("feedback: brief, Monday check, chase and meeting nudge each carry a thumbs row", async () => {
  const s = await setup();
  await setSetting(s.db, "brief_time", "08:00");
  assert.equal(await maybeBrief(s.ctx, s.tg, OWNER), true);
  const brief = s.fx.tg.filter((c) => c.method === "sendMessage").at(-1)!;
  assert.ok(buttons(brief).some((r) => r.some((b) => b.callback_data === "fb:u:brief")) && buttons(brief).some((r) => r.some((b) => b.callback_data === "fb:d:brief")));

  const mon = Date.UTC(2026, 10, 9, 5, 30); // Mon 09-11-2026 08:30 EAT
  const c2: Ctx = { ...s.ctx, now: mon };
  assert.equal(await maybeMonday(c2, s.tg, OWNER), true);
  assert.ok(buttons(s.fx.tg.filter((c) => c.method === "sendMessage").at(-1)!).flat().some((b) => b.callback_data === "fb:d:monday"));

  // a first reminder is yours, so it is not rated; the chase is a nudge, so it is
  await s.db.prepare("INSERT INTO reminders (ts, text, due_ts, chase_count) VALUES (?, 'ring Otieno', ?, 0)").bind(T0, T0 - 1000).run();
  await sweepReminders(s.ctx, s.tg, OWNER);
  const first = s.fx.tg.filter((c) => c.method === "sendMessage").at(-1)!;
  assert.ok(!buttons(first).flat().some((b) => b.callback_data?.startsWith("fb:")));
  await s.db.prepare("UPDATE reminders SET due_ts = ? WHERE text = 'ring Otieno'").bind(T0).run();
  await sweepReminders({ ...s.ctx, now: T0 + 1000 }, s.tg, OWNER);
  const chase = s.fx.tg.filter((c) => c.method === "sendMessage").at(-1)!;
  assert.ok(String(chase.body.text).startsWith("Still open"));
  assert.ok(buttons(chase).flat().some((b) => b.callback_data === "fb:u:chase"));
});

test("feedback: a tap is stored, thanked, and removes only the rating row", async () => {
  const s = await setup();
  const markup = [[{ text: "Plan my day", callback_data: "say:Plan my day" }], [{ text: "👍", callback_data: "fb:u:brief" }, { text: "👎", callback_data: "fb:d:brief" }]];
  assert.equal(await handleUpdate(s.deps, tap("fb:u:brief", markup, "Morning. Top three today")), "callback");
  const row = await s.db.prepare("SELECT kind, vote, msg_id, excerpt FROM feedback").bind().first<{ kind: string; vote: number; msg_id: number; excerpt: string }>();
  assert.deepEqual({ ...row }, { kind: "brief", vote: 1, msg_id: 9, excerpt: "Morning. Top three today" });
  const edit = s.fx.tg.find((c) => c.method === "editMessageReplyMarkup")!;
  assert.deepEqual(buttons(edit).flat().map((b) => b.callback_data), ["say:Plan my day"], "the other button stays");
  assert.equal(s.fx.llm.length, 0, "no model call for a vote");

  await handleUpdate(s.deps, tap("fb:d:monday", [[{ text: "👍", callback_data: "fb:u:monday" }, { text: "👎", callback_data: "fb:d:monday" }]]));
  assert.ok(sent(s.fx.tg).some((t) => t.startsWith("Noted. If you tell me what was off")));
  await handleUpdate(s.deps, tap("fb:u:bogus"));
  assert.equal(Number((await s.db.prepare("SELECT COUNT(*) AS n FROM feedback").bind().first<{ n: number }>())?.n), 2, "unknown kinds are not stored");
  await handleUpdate(s.deps, msg("/log"));
  assert.ok(sent(s.fx.tg).at(-1)!.includes("brief 1👍 0👎"));
});

test("export: sends the facts, the whole conversation and skills as files, without credentials", async () => {
  const s = await setup();
  await addFact(s.db, T0, "Ava's school fees are due in January", "family", "owner", true);
  for (let i = 0; i < 40; i++) await addMessage(s.db, T0 + i, i % 2 ? "assistant" : "user", `message number ${i}`);
  await s.db.prepare("INSERT INTO credentials (provider, enc, ts) VALUES ('google', 'SECRETBLOB', ?)").bind(T0).run();
  await setSetting(s.db, "oauth_nonce", "NONCE123");
  await s.db.prepare("INSERT INTO skills (name, description, source, hash, ts, nsections) VALUES ('pricing', 'How to price', 'upload', 'h', ?, 1)").bind(T0).run();
  await s.db.prepare("INSERT INTO skill_sections (skill_id, heading, body) VALUES (1, '## Rule', 'Charge more.')").bind().run();
  await handleUpdate(s.deps, msg("/export"));
  const files = docs(s);
  assert.ok(files.length >= 3, "core, messages, skill");
  const all = files.map((f) => String(f.body.content)).join("\n");
  assert.ok(all.includes("Ava's school fees"));
  assert.ok(all.includes("message number 39") && all.includes("message number 0"));
  assert.ok(all.includes("Charge more."));
  assert.ok(!all.includes("SECRETBLOB") && !all.includes("NONCE123"), "credentials and nonces never leave");
  assert.ok(files.every((f) => /^rafiki-export-03-11-2026-\d+-/.test(String(f.body.filename))));
  assert.ok(sent(s.fx.tg).at(-1)!.startsWith("That is everything"));
});

test("export: a long history is split, and 'Send the next files' resumes where it stopped", async () => {
  const s = await setup();
  for (let i = 0; i < 12; i++) await s.db.prepare("INSERT INTO messages (ts, role, text) VALUES (?, 'user', ?)").bind(T0 + i, "x".repeat(200_000)).run(); // 12 messages of 200 KB, two per file
  await handleUpdate(s.deps, msg("/export"));
  assert.equal(docs(s).length, FILES_PER_CALL);
  assert.ok(docs(s).every((f) => String(f.body.content).length < 600_000), "no file is huge");
  const more = s.fx.tg.filter((c) => c.method === "sendMessage").at(-1)!;
  assert.ok(buttons(more).flat().some((b) => b.callback_data === "ex:next"));
  await handleUpdate(s.deps, tap("ex:next"));
  assert.ok(docs(s).length > FILES_PER_CALL);
  assert.ok(sent(s.fx.tg).at(-1)!.startsWith("That is everything"));
  const text = docs(s).filter((f) => String(f.body.filename).includes("messages")).map((f) => (JSON.parse(String(f.body.content)) as unknown[]).length).reduce((a, b) => a + b, 0);
  assert.equal(text, 12, "no message dropped or repeated across files");
});

test("erase: needs the exact phrase, and anything else cancels", async () => {
  const s = await setup();
  await addFact(s.db, T0, "keep me", "other", "owner", true);
  await addMessage(s.db, T0, "user", "hello");
  await handleUpdate(s.deps, msg("/erase"));
  assert.ok(sent(s.fx.tg).at(-1)!.includes("/erase everything"));
  await handleUpdate(s.deps, msg("/erase everything"));
  const warn = sent(s.fx.tg).at(-1)!;
  assert.ok(warn.includes("cannot be undone") && warn.includes("ERASE EVERYTHING") && warn.includes("1 messages"));
  await handleUpdate(s.deps, msg("yes"));
  assert.ok(sent(s.fx.tg).at(-1)!.startsWith("Cancelled"));
  await handleUpdate(s.deps, msg("ERASE EVERYTHING")); // no longer armed
  assert.equal(Number((await s.db.prepare("SELECT COUNT(*) AS n FROM facts").bind().first<{ n: number }>())?.n), 1);
  assert.equal(s.fx.llm.length, 1, "the stray phrase went to the agent as ordinary text, not to the eraser");
});

test("erase: the phrase wipes everything, revokes Google, keeps the owner and the cost log without content", async () => {
  const s = await setup();
  await addFact(s.db, T0, "keep me", "other", "owner", true);
  await addMessage(s.db, T0, "user", "hello secret-ish thing");
  await s.db.prepare("INSERT INTO goals (ts, text) VALUES (?, 'earn 250K')").bind(T0).run();
  await s.db.prepare("INSERT INTO docs (ts, name, text) VALUES (?, 'a.txt', 'file body')").bind(T0).run();
  await s.db.prepare("INSERT INTO credentials (provider, enc, ts) VALUES ('google', 'x', ?)").bind(T0).run();
  await s.db.prepare("INSERT INTO feedback (ts, kind, vote) VALUES (?, 'brief', 1)").bind(T0).run();
  await s.db.prepare("INSERT INTO runs (ts, agent_role, model, cost_usd, trace) VALUES (?, 'coach', 'm', 0.5, '{\"x\":1}')").bind(T0).run();
  await setSetting(s.db, "brief_time", "06:30");
  await setSetting(s.db, "daily_cap_usd", "2");
  await handleUpdate(s.deps, msg("/erase everything"));
  await handleUpdate(s.at(T0 + 5 * 60000), msg("erase everything"));
  assert.ok(sent(s.fx.tg).at(-1)!.startsWith("Done. I now hold nothing"));
  for (const t of ["messages", "facts", "goals", "docs", "credentials", "feedback", "summaries", "memory_fts", "skills"]) assert.equal(Number((await s.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).bind().first<{ n: number }>())?.n), 0, t);
  assert.equal(await getSetting(s.db, "owner_chat_id"), String(OWNER));
  assert.equal(await getSetting(s.db, "daily_cap_usd"), "2");
  assert.equal(await getSetting(s.db, "brief_time"), null);
  const run = await s.db.prepare("SELECT cost_usd, trace FROM runs").bind().first<{ cost_usd: number; trace: string }>();
  assert.deepEqual({ ...run }, { cost_usd: 0.5, trace: "" });
  // still the owner's bot, and /start begins onboarding again
  assert.equal(await handleUpdate(s.deps, msg("/start")), "start");
});

test("erase: the phrase typed too late does nothing", async () => {
  const s = await setup();
  await addFact(s.db, T0, "keep me", "other", "owner", true);
  await handleUpdate(s.deps, msg("/erase everything"));
  await handleUpdate(s.at(T0 + 11 * 60000), msg("ERASE EVERYTHING"));
  assert.equal(Number((await s.db.prepare("SELECT COUNT(*) AS n FROM facts").bind().first<{ n: number }>())?.n), 1);
});

test("erase: the model cannot do it, whatever it proposes or is told", async () => {
  const s = await setup([agentJson({ role: "chief_of_staff", reply: "Erasing now.", actions: [{ type: "erase", scope: "everything" }, { type: "delete_all" }] })]);
  await addFact(s.db, T0, "keep me", "other", "owner", true);
  await handleUpdate(s.deps, msg("please delete everything you know about me"));
  assert.equal(Number((await s.db.prepare("SELECT COUNT(*) AS n FROM facts").bind().first<{ n: number }>())?.n), 1);
});

test("erase: the cancel button disarms it", async () => {
  const s = await setup();
  await addFact(s.db, T0, "keep me", "other", "owner", true);
  await handleUpdate(s.deps, msg("/erase everything"));
  await handleUpdate(s.deps, tap("er:cancel"));
  await handleUpdate(s.deps, msg("ERASE EVERYTHING"));
  assert.equal(Number((await s.db.prepare("SELECT COUNT(*) AS n FROM facts").bind().first<{ n: number }>())?.n), 1);
});

test("limits: /limits lists what Rafiki cannot do, and /help names the new commands", async () => {
  const s = await setup();
  await handleUpdate(s.deps, msg("/limits"));
  assert.ok(sent(s.fx.tg).at(-1)!.includes("Send anything to anyone but you"));
  await handleUpdate(s.deps, msg("/help"));
  assert.ok(["/export", "/erase", "/limits"].every((c) => sent(s.fx.tg).at(-1)!.includes(c)));
});
