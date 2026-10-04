import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { validateActions, executeActions } from "../src/actions.ts";
import { addMessage } from "../src/db.ts";
import { consolidateDay, nightly } from "../src/consolidate.ts";
import { handleUpdate, type Deps } from "../src/handler.ts";
import { addFact, forgetFact, ftsQuery, recall } from "../src/memory.ts";
import type { Ctx } from "../src/agent.ts";
import type { TgUpdate } from "../src/telegram.ts";
import { ENV, agentJson, fakeFetch, makeDb, sent, type LlmReply } from "./shim.ts";

const OWNER = 100200300;
const T0 = Date.UTC(2026, 10, 3, 5, 0); // Tue 03-11-2026 08:00 EAT
let uid = 5000;
const msg = (text: string): TgUpdate => ({ update_id: ++uid, message: { message_id: uid, from: { id: OWNER, first_name: "Sam" }, chat: { id: OWNER }, text } });
const tap = (data: string): TgUpdate => ({ update_id: ++uid, callback_query: { id: `c${uid}`, from: { id: OWNER, first_name: "Sam" }, data, message: { message_id: 3, chat: { id: OWNER } } } });

function setup(queue: LlmReply[] = [], now = T0) {
  const db = makeDb();
  const fx = fakeFetch(queue);
  const deps: Deps = { db, env: ENV, f: fx.f, now };
  const ctx = (n = now): Ctx => ({ db, env: ENV, f: fx.f, now: n, off: 180 });
  return { db, fx, deps, ctx };
}
async function owned(s: ReturnType<typeof setup>) {
  await s.db.prepare("INSERT INTO settings (key, value) VALUES ('owner_chat_id', ?), ('ob_step', 'done')").bind(String(OWNER)).run();
}

test("memory: search is safe against odd input and ignores filler words", () => {
  assert.equal(ftsQuery("the and what"), null);
  assert.equal(ftsQuery("12 345"), null);
  assert.equal(ftsQuery('school "fees" NEAR(a b) * ) ('), '"school" OR "fees" OR "near"');
  assert.ok((ftsQuery("one two three four five six seven eight nine ten eleven twelve")!.match(/OR/g) ?? []).length <= 9);
});

test("memory: an old message far beyond the last 8 is found by meaning-adjacent words, with stemming", async () => {
  const s = setup();
  const old = Date.UTC(2026, 8, 10);
  const id = await addMessage(s.db, old, "user", "Ava's school fees are 150K and due in January");
  for (let i = 0; i < 40; i++) await addMessage(s.db, T0 - i * 1000, i % 2 ? "assistant" : "user", `filler message number ${i}`);
  const hits = await recall(s.db, "what were the fee amounts for school?", 5);
  assert.equal(hits[0]!.refId, id);
  assert.equal(hits[0]!.kind, "message");
  assert.equal((await recall(s.db, "school fees", 5, new Set([id]))).length, 0, "excluded ids are skipped");
});

test("memory: a personal question carries recalled older items into the model prompt, dated", async () => {
  const s = setup([agentJson({ reply: "It is 150K, due January.", actions: [] })]);
  await owned(s);
  await addMessage(s.db, Date.UTC(2026, 8, 10), "user", "Ava's school fees are 150K and due in January");
  for (let i = 0; i < 30; i++) await addMessage(s.db, T0 - 60000 + i, i % 2 ? "assistant" : "user", `unrelated chatter ${i}`);
  await handleUpdate(s.deps, msg("what did I say about my school fees?"));
  const ctxMsg = (s.fx.llm[0]!.body.messages as { content: string }[])[1]!.content;
  assert.match(ctxMsg, /RECALLED FROM OLDER MEMORY/);
  assert.match(ctxMsg, /10-09-2026 you said: Ava's school fees are 150K/);
  const hist = (s.fx.llm[0]!.body.messages as { content: string }[]).filter((m) => /unrelated chatter/.test(m.content));
  assert.ok(hist.length <= 8, "the live history is still capped at 8");
});

test("memory: general questions carry no personal memory at all", async () => {
  const s = setup([agentJson({ reply: "A sinking fund is...", actions: [] })]);
  await owned(s);
  await addFact(s.db, T0, "Owner has two sons", "family");
  await handleUpdate(s.deps, msg("what is a sinking fund"));
  assert.ok(!JSON.stringify(s.fx.llm[0]!.body.messages).includes("two sons"));
});

test("facts: saved with a category, de-duplicated, shown in the prompt, forgettable, and removed from search", async () => {
  const s = setup();
  const now = T0;
  const acts = validateActions([{ type: "note", text: "Jo prefers calls to messages", category: "people" }, { type: "note", text: "Bad category", category: "nonsense" }], now, 180);
  assert.deepEqual(acts.map((a) => (a as { category: string }).category), ["people", "other"]);
  assert.deepEqual(await executeActions(s.db, acts, now, 180), ["Noted.", "Noted."]);
  assert.deepEqual(await executeActions(s.db, acts.slice(0, 1), now, 180), ["Already knew that."]);
  const id = (s.db.raw.prepare("SELECT id FROM facts WHERE text LIKE 'Jo%'").get() as { id: number }).id;
  assert.equal((await recall(s.db, "Jo calls", 3)).length, 1);
  assert.equal(await forgetFact(s.db, id), true);
  assert.equal((await recall(s.db, "Jo calls", 3)).length, 0);
  assert.equal(await forgetFact(s.db, id), false);
});

test("commands: /remember, /memory, /search, /forget with buttons", async () => {
  const s = setup();
  await owned(s);
  await handleUpdate(s.deps, msg("/remember Ava's birthday is 08-11-2026"));
  await handleUpdate(s.deps, msg("/remember ava's birthday is 08-11-2026"));
  await handleUpdate(s.deps, msg("/memory"));
  await handleUpdate(s.deps, msg("/search birthday"));
  await handleUpdate(s.deps, tap("mem:c:other:0"));
  await handleUpdate(s.deps, msg("/forget birthday"));
  const out = sent(s.fx.tg);
  assert.ok(out.some((t) => /Remembered/.test(t)));
  assert.ok(out.some((t) => /I already knew that/.test(t)));
  assert.ok(out.some((t) => /Memory, kept forever/.test(t) && /1 facts/.test(t)));
  assert.ok(out.some((t) => /^other\n#1 \(pinned\) Ava's birthday/.test(t)));
  assert.ok(out.some((t) => /fact: Ava's birthday/.test(t)));
  const forgetPrompt = s.fx.tg.filter((c) => c.method === "sendMessage").pop()!;
  const btn = JSON.stringify(forgetPrompt.body.reply_markup);
  assert.match(btn, /fg:1/);
  await handleUpdate(s.deps, tap("fg:1"));
  assert.ok(sent(s.fx.tg).some((t) => t === "Forgotten."));
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n, 0);
});

test("consolidation: a day becomes a summary and facts, once, using zero-retention routing", async () => {
  const day = Date.UTC(2026, 10, 1, 21, 0); // 02-11-2026 00:00 EAT
  const s = setup([agentJson({ summary: "Sam planned Ava's school fees and chased Otieno.", facts: [{ text: "Ava's school fees are 150K, due January", category: "family" }, { text: "Otieno owes a quote reply", category: "people" }, { text: "", category: "other" }] })], day + 30 * 3600000);
  await addMessage(s.db, day + 3600000, "user", "School fees for Ava are 150K");
  await addMessage(s.db, day + 3700000, "assistant", "Noted the fees.");
  const r = await consolidateDay(s.ctx(day + 30 * 3600000), day);
  assert.deepEqual([r.status, r.facts, r.period], ["ok", 2, "02-11-2026"]);
  assert.deepEqual(s.fx.llm[0]!.body.provider, { zdr: true });
  assert.equal(s.fx.llm[0]!.body.model, ENV.MODEL_SMART, "the nightly summary uses the smart model");
  assert.equal((await recall(s.db, "chased Otieno", 3))[0]!.kind, "summary");
  assert.equal((await consolidateDay(s.ctx(day + 31 * 3600000), day)).status, "skip");
  assert.equal(s.fx.llm.length, 1);
  assert.equal((s.db.raw.prepare("SELECT status FROM runs WHERE agent_role='memory'").get() as { status: string }).status, "ok");
});

test("consolidation: thin days are skipped; a model failure is logged and does not throw", async () => {
  const day = Date.UTC(2026, 10, 1, 21, 0);
  const s = setup([{ status: 500 }, { status: 500 }], day + 30 * 3600000);
  await addMessage(s.db, day + 1000, "user", "hi");
  assert.equal((await consolidateDay(s.ctx(day + 30 * 3600000), day)).status, "skip");
  await addMessage(s.db, day + 2000, "assistant", "hello");
  assert.equal((await consolidateDay(s.ctx(day + 30 * 3600000), day)).status, "error");
  assert.equal((s.db.raw.prepare("SELECT status FROM runs WHERE agent_role='memory'").get() as { status: string }).status, "error");
});

test("nightly: runs only 02:00 to 04:00, newest unsummarised past day first, never today", async () => {
  const day1 = Date.UTC(2026, 10, 1, 21, 0); // 02-11 00:00 EAT
  const night = day1 + 26 * 3600000; // 03-11 02:00 EAT
  const s = setup([agentJson({ summary: "Day one.", facts: [] }), agentJson({ summary: "Day two.", facts: [] })], night);
  await addMessage(s.db, day1 + 3600000, "user", "first day message");
  await addMessage(s.db, day1 + 3700000, "assistant", "reply");
  await addMessage(s.db, night + 600000, "user", "today in progress");
  await addMessage(s.db, night + 700000, "assistant", "ok");
  assert.equal(await nightly(s.ctx(night - 3 * 3600000)), null, "outside the window");
  const r = await nightly(s.ctx(night));
  assert.equal(r?.period, "02-11-2026");
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM summaries").get() as { n: number }).n, 1);
  assert.equal(await nightly(s.ctx(night + 60000)), null, "nothing left but today");
});

test("persistence: no code path deletes conversation history", () => {
  for (const f of readdirSync(new URL("../src/", import.meta.url), { recursive: true }).map(String).filter((x) => x.endsWith(".ts"))) {
    const txt = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    assert.ok(!/DELETE\s+FROM\s+messages/i.test(txt), `${f} must not delete messages`);
    assert.ok(!/DROP\s+TABLE/i.test(txt), `${f} must not drop tables`);
  }
});

test("budget: a full personal turn stays well under D1's 50 queries per invocation", async () => {
  const s = setup([agentJson({ reply: "ok", actions: [{ type: "task_add", text: "x" }, { type: "note", text: "fact one", category: "other" }] })]);
  await owned(s);
  for (let i = 0; i < 12; i++) await addFact(s.db, T0, `fact number ${i}`, "other");
  let n = 0;
  const counted = {
    prepare: (sql: string) => ({ bind: (...v: unknown[]) => { const b = s.db.prepare(sql).bind(...v); return { first: <T,>() => { n++; return b.first<T>(); }, all: <T,>() => { n++; return b.all<T>(); }, run: () => { n++; return b.run(); } }; } }),
  };
  await handleUpdate({ ...s.deps, db: counted as never }, msg("plan my week around my school fees and money"));
  assert.ok(n <= 35, `used ${n} queries`);
});
