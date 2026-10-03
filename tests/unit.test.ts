import assert from "node:assert/strict";
import { test } from "node:test";
import { executeActions, validateActions } from "../src/actions.ts";
import { classify, employerBlock, mayExecute, redactSecrets } from "../src/gates.ts";
import { chat, CreditError, LlmError } from "../src/llm.ts";
import { parseAgentJson } from "../src/agent.ts";
import { afterSend, MAX_CHASES } from "../src/schedule.ts";
import { feeFor, kes, parseFees, parseSpendLine } from "../src/spend.ts";
import { fmtDate, fmtDateTime, inQuietHours, parseHM, parseLocalIso, startOfLocalDay } from "../src/time.ts";
import { ENV, fakeFetch, makeDb } from "./shim.ts";

const OFF = 180;

test("time: EAT formatting, DD-MM-YYYY, parsing", () => {
  const ms = Date.UTC(2026, 9, 2, 6, 5); // 02-10-2026 06:05 UTC = 09:05 EAT
  assert.equal(fmtDate(ms, OFF), "02-10-2026");
  assert.equal(fmtDateTime(ms, OFF), "Fri 02-10-2026 09:05");
  assert.equal(parseLocalIso("2026-10-03T09:00", OFF), Date.UTC(2026, 9, 3, 6, 0));
  assert.equal(parseLocalIso("2026-13-03T09:00", OFF), null);
  assert.equal(parseHM("08:00"), 480);
  assert.equal(parseHM("25:00"), null);
  assert.equal(startOfLocalDay(ms, OFF), Date.UTC(2026, 9, 1, 21, 0));
});

test("time: quiet hours wrap midnight", () => {
  const at = (h: number, m: number) => Date.UTC(2026, 9, 2, h - 3, m);
  assert.equal(inQuietHours(at(22, 0), OFF), true);
  assert.equal(inQuietHours(at(3, 0), OFF), true);
  assert.equal(inQuietHours(at(5, 29), OFF), true);
  assert.equal(inQuietHours(at(5, 30), OFF), false);
  assert.equal(inQuietHours(at(12, 0), OFF), false);
  assert.equal(inQuietHours(at(21, 0), OFF), true);
});

test("gates: secrets are redacted (S3), never sent on", () => {
  const r = redactSecrets("my key is sk-abcdefghijklmnopqrstuvwxyz123 and password: hunter2 and 4111 1111 1111 1111");
  assert.ok(!r.text.includes("sk-abc") && !r.text.includes("hunter2") && !r.text.includes("4111"));
  assert.ok(r.found.length >= 3);
  const fakeToken = ["123456789", "AAEhBOweikSdasdfghjklQWERTYUIOPzxcv1"].join(":"); // assembled at runtime so scanners see no literal
  const tg = redactSecrets(`token ${fakeToken}`);
  assert.ok(tg.text.includes("[REDACTED]"));
  assert.equal(redactSecrets("call me at 0712345678 about 12345").found.length, 0);
});

test("gates: sensitivity classes", () => {
  assert.equal(classify("what is a sinking fund"), "S0");
  assert.equal(classify("remind me to call Otieno"), "S1");
  assert.equal(classify("my salary is going up"), "S2");
  assert.equal(classify("lunch 650 mpesa"), "S2");
  assert.equal(classify("the doctor said rest"), "S2");
});

test("gates: employer confidential material is blocked, benign mention is not", () => {
  assert.equal(employerBlock("Here is the Acme customer list and account number data", ["acme"]), true);
  assert.equal(employerBlock("Lunch with the Acme team on Friday", ["acme"]), false);
});

test("gates: only G0 and G1 actions are executable", () => {
  for (const t of ["reminder", "task_add", "goal_add", "ledger_set", "spend", "note", "set_setting"]) assert.equal(mayExecute(t), true);
  for (const t of ["send_email", "pay", "delete", "share", "transfer"]) assert.equal(mayExecute(t), false);
});

test("actions: validation drops unknown, malformed, past and over-long items", () => {
  const now = Date.UTC(2026, 9, 2, 6, 0);
  const a = validateActions([
    { type: "reminder", text: "Call Otieno", due: "2026-10-03T09:00", repeat: "daily" },
    { type: "reminder", text: "Past", due: "2026-09-01T09:00" },
    { type: "send_email", to: "x@y.z" },
    { type: "pay", amount: 100 },
    { type: "ledger_set", prospect: "Otieno", rung: 9 },
    { type: "ledger_set", prospect: "Otieno", rung: 3, next_ask: "deposit" },
    { type: "spend", amount: -5 },
    "nonsense",
  ], now, OFF);
  assert.deepEqual(a.map((x) => x.type), ["reminder", "ledger_set"]);
  const b = validateActions([
    { type: "spend", amount: 650, channel: "mpesa", category: "Food", note: "lunch" },
    { type: "set_setting", key: "owner_chat_id", value: "1" },
    { type: "set_setting", key: "brief_time", value: "07:15" },
    { type: "set_setting", key: "brief_time", value: "99:99" },
    { type: "goal_add", text: "Save 500k", by: "31-12-2026" },
  ], now, OFF);
  assert.deepEqual(b.map((x) => x.type), ["spend", "set_setting", "goal_add"]);
  assert.equal(validateActions("not an array", now, OFF).length, 0);
  assert.equal(validateActions(Array.from({ length: 20 }, () => ({ type: "task_add", text: "x" })), now, OFF).length, 8);
});

test("actions: execution writes rows and reports only what happened", async () => {
  const db = makeDb();
  const now = Date.UTC(2026, 9, 2, 6, 0);
  await db.prepare("INSERT INTO fee_tiers (channel, min_cents, max_cents, fee_cents, set_ts) VALUES (?,?,?,?,?)").bind("mpesa", 10000, 50099, 700, now).run();
  const acts = validateActions([
    { type: "reminder", text: "Call Otieno", due: "2026-10-03T09:00" },
    { type: "ledger_set", prospect: "Otieno", rung: 2, next_ask: "book a call" },
    { type: "ledger_set", prospect: "Otieno", rung: 4, next_ask: "pay deposit" },
    { type: "spend", amount: 300, channel: "mpesa", category: "Food", note: "lunch" },
  ], now, OFF);
  const done = await executeActions(db, acts, now, OFF);
  assert.equal(done.length, 4);
  assert.match(done[0]!, /Sat 03-10-2026 09:00/);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM ledger").get() as { n: number }).n, 1);
  assert.equal((db.raw.prepare("SELECT rung FROM ledger").get() as { rung: number }).rung, 4);
  assert.equal((db.raw.prepare("SELECT fee_cents FROM spends").get() as { fee_cents: number }).fee_cents, 700);
});

test("spend: parsing, categories, fees, formatting", () => {
  assert.deepEqual(parseSpendLine("lunch 650 mpesa"), { amountCents: 65000, category: "Food", channel: "mpesa", note: "lunch" });
  assert.equal(parseSpendLine("spent 1,200 on fuel cash")?.category, "Transport");
  assert.equal(parseSpendLine("650 lunch")?.amountCents, 65000);
  assert.equal(parseSpendLine("remind me to pay rent 5000"), null);
  assert.equal(parseSpendLine("what should I do 5"), null);
  assert.equal(parseSpendLine("/fees mpesa 1-100=0"), null);
  const p = parseFees("mpesa 1-100=0 101-500=7 501-1000=13")!;
  assert.equal(p.tiers.length, 3);
  assert.equal(feeFor(p.tiers, "mpesa", 30000), 700);
  assert.equal(feeFor(p.tiers, "mpesa", 50000), 700);
  assert.equal(feeFor(p.tiers, "mpesa", 99999999), null);
  assert.equal(feeFor(p.tiers, "cash", 100), null);
  assert.equal(parseFees("mpesa nonsense"), null);
  assert.equal(kes(125000), "KES 1,250");
  assert.equal(kes(65050), "KES 650.50");
});

test("schedule: chase logic ends in flagged after the maximum chases", () => {
  const now = 1_000_000;
  let r = { id: 1, text: "x", due_ts: now, chase_count: 0, repeat: "none" };
  for (let i = 0; i < MAX_CHASES; i++) {
    const n = afterSend(r, now);
    assert.equal(n.state, "open");
    assert.equal(n.due_ts, now + 2 * 3600000);
    r = { ...r, chase_count: n.chase_count };
  }
  assert.equal(afterSend(r, now).state, "flagged");
});

test("agent json: tolerant parsing and fallback", () => {
  assert.equal(parseAgentJson('Sure! {"role":"coach","reply":"Hi","actions":[],"buttons":[["Yes","yes"]]} done').role, "coach");
  assert.equal(parseAgentJson("plain text only").reply, "plain text only");
  assert.equal(parseAgentJson('{"role":"hacker","reply":"x"}').role, "chief_of_staff");
  assert.equal(parseAgentJson('{"reply":""}').role, "chief_of_staff");
});

test("llm routing: S0 plain, S1 data_collection deny, S2 zdr then degrade, S3 refused, credit rules", async () => {
  const msgs = [{ role: "user" as const, content: "hi" }];
  let q = fakeFetch([{ content: "a" }]);
  await chat(ENV, q.f, { messages: msgs, sens: "S0", deep: false });
  assert.equal(q.llm[0]!.body.provider, undefined);
  assert.equal(q.llm[0]!.body.model, "fast/model");

  q = fakeFetch([{ content: "a" }]);
  await chat(ENV, q.f, { messages: msgs, sens: "S1", deep: true });
  assert.deepEqual(q.llm[0]!.body.provider, { data_collection: "deny" });
  assert.equal(q.llm[0]!.body.model, "smart/model");

  q = fakeFetch([{ content: "a" }]);
  const r = await chat(ENV, q.f, { messages: msgs, sens: "S2", deep: false });
  assert.deepEqual(q.llm[0]!.body.provider, { zdr: true });
  assert.equal(r.providerPref, "zdr");

  q = fakeFetch([{ status: 404 }, { content: "b" }]);
  const d = await chat(ENV, q.f, { messages: msgs, sens: "S2", deep: false });
  assert.deepEqual(q.llm[1]!.body.provider, { data_collection: "deny" });
  assert.equal(d.providerPref, "data_collection=deny");

  await assert.rejects(() => chat(ENV, fakeFetch([]).f, { messages: msgs, sens: "S3", deep: false }), LlmError);

  q = fakeFetch([{ status: 402 }, { content: "free" }]);
  const s0 = await chat(ENV, q.f, { messages: msgs, sens: "S0", deep: false });
  assert.equal(s0.model, "free/model:free");

  q = fakeFetch([{ status: 402 }]);
  await assert.rejects(() => chat(ENV, q.f, { messages: msgs, sens: "S1", deep: false }), CreditError);
  assert.equal(q.llm.length, 1, "S1 must never fall back to a free model");
});

test("telegram client: works with a fetch that, like Workers' fetch, refuses to run with another object as this", async () => {
  const { Telegram } = await import("../src/telegram.ts");
  const strict = function (this: unknown, _u: string | URL | Request): Promise<Response> {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  } as unknown as typeof fetch;
  const tg = new Telegram("1:abc", strict);
  assert.deepEqual(await tg.send(1, "hi"), { ok: true });
  assert.deepEqual(await tg.typing(1), { ok: true });
});

test("goals are not duplicated when the model restates one; buttons never carry identifiers", async () => {
  const db = makeDb();
  const now = Date.UTC(2026, 9, 2, 6, 0);
  const g = validateActions([{ type: "goal_add", text: "Make 250K KES", by: "06-10-2026" }], now, OFF);
  await executeActions(db, g, now, OFF);
  const again = validateActions([{ type: "goal_add", text: "make 250k kes", target: "KES 250,000", by: "06-10-2026" }], now, OFF);
  const done = await executeActions(db, again, now, OFF);
  assert.match(done[0]!, /Goal updated/);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM goals").get() as { n: number }).n, 1);
  assert.equal((db.raw.prepare("SELECT target FROM goals").get() as { target: string }).target, "KES 250,000");
  const p = parseAgentJson('{"reply":"x","buttons":[["View pipeline","view_pipeline"],["Add prospect","Add a prospect to my ledger"]]}');
  assert.deepEqual(p.buttons, [["View pipeline", "View pipeline"], ["Add prospect", "Add a prospect to my ledger"]]);
});

test("when: relative reminder times are computed by code, not guessed", async () => {
  const { parseWhen } = await import("../src/when.ts");
  const now = Date.UTC(2026, 9, 2, 19, 58); // Fri 02-10-2026 22:58 EAT
  assert.equal(parseWhen("remind me in 2 minutes to call Otieno", now, 180), now + 120000);
  assert.equal(parseWhen("Remind me to fart in 2 minutes", now, 180), now + 120000);
  assert.equal(parseWhen("ping me in an hour", now, 180), now + 3600000);
  assert.equal(parseWhen("in 3 days check the quote", now, 180), now + 3 * 86400000);
  assert.equal(parseWhen("in half an hour", now, 180), now + 1800000);
  assert.equal(parseWhen("tomorrow at 9am call Otieno", now, 180), Date.UTC(2026, 9, 3, 6, 0));
  assert.equal(parseWhen("tomorrow 14:30 meeting", now, 180), Date.UTC(2026, 9, 3, 11, 30));
  assert.equal(parseWhen("tomorrow at 9pm", now, 180), Date.UTC(2026, 9, 3, 18, 0));
  assert.equal(parseWhen("tomorrow at 12am", now, 180), Date.UTC(2026, 9, 2, 21, 0));
  assert.equal(parseWhen("remind me about the quote", now, 180), null);
  assert.equal(parseWhen("tomorrow", now, 180), null);
  assert.equal(parseWhen("in 9999 days", now, 180), null);
});
