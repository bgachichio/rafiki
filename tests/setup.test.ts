import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import worker from "../src/index.ts";
import { COMMANDS } from "../src/commands.ts";
import { SCHEMA_SQL } from "../src/schema.gen.ts";
import { MARK_PNG_BASE64 } from "../src/assets/mark.gen.ts";
import { SCHEMA_STATEMENTS, ensureSchema, splitSql, webhookSecret } from "../src/setup.ts";
import { getSetting } from "../src/db.ts";
import { ENV, fakeFetch, makeDb } from "./shim.ts";
import { DatabaseSync } from "node:sqlite";

const OWN = { ...ENV, TELEGRAM_WEBHOOK_SECRET: undefined, CLAIM_CODE: "my-setup-word", TELEGRAM_BOT_TOKEN: "123456789:TESTTOKENTESTTOKENTESTTOKENTESTTOKEN1", OPENROUTER_API_KEY: "or-test" };
const post = (path: string, body: Record<string, string>): Request => { const f = new FormData(); for (const [k, v] of Object.entries(body)) f.append(k, v); return new Request(`https://rafiki.example.workers.dev${path}`, { method: "POST", body: f }); };
const env = (db: ReturnType<typeof makeDb>, e = OWN) => ({ ...e, DB: db as unknown as D1Database });
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

test("generated files: schema.gen.ts matches schema.sql and the photo is a PNG (run `npm run gen` if this fails)", () => {
  assert.equal(SCHEMA_SQL, readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  assert.equal(Buffer.from(MARK_PNG_BASE64, "base64").subarray(1, 4).toString(), "PNG");
  assert.ok(Buffer.from(MARK_PNG_BASE64, "base64").length < 200_000);
});

test("schema: splits into statements that run on an empty database, in chunks, and are safe to repeat", async () => {
  assert.ok(SCHEMA_STATEMENTS.length > 30 && SCHEMA_STATEMENTS.length < 120);
  assert.ok(SCHEMA_STATEMENTS.every((s) => !s.endsWith(";") && !s.startsWith("--")));
  const raw = new DatabaseSync(":memory:");
  const db = { prepare: (sql: string) => ({ bind: (...v: unknown[]) => ({ first: async () => (raw.prepare(sql).get(...(v as never[])) as never) ?? null, all: async () => ({ results: raw.prepare(sql).all(...(v as never[])) as never[] }), run: async () => { raw.prepare(sql).run(...(v as never[])); } }) }) };
  let r = await ensureSchema(db, 7);
  let calls = 1;
  while (!r.done && calls < 30) { r = await ensureSchema(db, 7); calls++; }
  assert.ok(r.done && calls > 3, "needed several chunks");
  assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'decisions'").get());
  const again = await ensureSchema(db, 7);
  assert.equal(again.done, true);
  assert.equal(calls > 0 && (raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get() as { n: number }).n > 25, true);
  assert.equal(splitSql("-- c\nCREATE TABLE a (x);\nINSERT INTO a VALUES (1);\n").length, 2);
});

test("webhook secret: an explicit one wins; otherwise it is derived from the token and setup word and differs when either changes", async () => {
  assert.equal(await webhookSecret({ ...OWN, TELEGRAM_WEBHOOK_SECRET: "fixed" }), "fixed");
  const a = await webhookSecret(OWN);
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notEqual(a, await webhookSecret({ ...OWN, CLAIM_CODE: "other-word" }));
  assert.notEqual(a, await webhookSecret({ ...OWN, TELEGRAM_BOT_TOKEN: "987654321:OTHEROTHEROTHEROTHEROTHEROTHEROTHER1" }));
});

test("/tg: the derived secret is accepted, a wrong one and a missing one are not, and the owner's explicit secret still works", async () => {
  const db = makeDb();
  const body = JSON.stringify({ update_id: 1 });
  const hit = async (secret: string | null, e = OWN) => (await worker.fetch(new Request("https://x.workers.dev/tg", { method: "POST", body, headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {} }), env(db, e), ctx)).status;
  assert.equal(await hit(await webhookSecret(OWN)), 200);
  assert.equal(await hit("wrong"), 401);
  assert.equal(await hit(null), 401);
  assert.equal(await hit("whsec", ENV as typeof OWN), 200);
  assert.equal(await hit(await webhookSecret(OWN), { ...OWN, CLAIM_CODE: "" }), 401);
});

test("/setup: asks for the setup word; a wrong word is refused and counted; five wrong words lock it for ten minutes", async () => {
  const db = makeDb();
  const e = env(db);
  const get = await worker.fetch(new Request("https://x.workers.dev/setup"), e, ctx);
  assert.equal(get.status, 200);
  assert.match(await get.text(), /Your setup word/);
  for (let i = 0; i < 5; i++) assert.equal((await worker.fetch(post("/setup", { word: "nope" }), e, ctx)).status, 403);
  assert.equal((await worker.fetch(post("/setup", { word: OWN.CLAIM_CODE }), e, ctx)).status, 429, "even the right word waits once locked");
});

test("/setup: the right word registers the webhook, commands, credits and photo, shows the start link, and never prints a secret", async () => {
  const db = makeDb();
  const fx = fakeFetch([]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fx.f;
  try {
    const res = await worker.fetch(post("/setup", { word: OWN.CLAIM_CODE }), env(db), ctx);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Your Rafiki is ready/);
    assert.match(html, /Telegram accepted your bot token \(@test_rafiki_bot\)/);
    assert.match(html, /OpenRouter accepted your AI key/);
    assert.match(html, /https:\/\/t\.me\/test_rafiki_bot\?start=my-setup-word/);
    assert.ok(!html.includes(OWN.TELEGRAM_BOT_TOKEN) && !html.includes("or-test"), "no token or key in the page");
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const calls = fx.tg;
    const hook = calls.find((c) => c.method === "setWebhook")!;
    assert.equal(hook.body.url, "https://rafiki.example.workers.dev/tg");
    assert.equal(hook.body.secret_token, await webhookSecret(OWN));
    assert.deepEqual(hook.body.allowed_updates, ["message", "edited_message", "callback_query", "poll_answer"]);
    assert.equal((calls.find((c) => c.method === "setMyCommands")!.body.commands as unknown[]).length, COMMANDS.length);
    assert.match(String(calls.find((c) => c.method === "setMyDescription")!.body.description), /Made with ❤️ by Brian Gachichio/);
    assert.ok(calls.some((c) => c.method === "setMyProfilePhoto"));
    assert.equal(await getSetting(db, "public_url"), "https://rafiki.example.workers.dev");
    assert.equal(await getSetting(db, "bot_name"), "Test Rafiki");
    // running it again refreshes everything but does not re-upload the photo
    calls.length = 0;
    await worker.fetch(post("/setup", { word: OWN.CLAIM_CODE }), env(db), ctx);
    assert.ok(!calls.some((c) => c.method === "setMyProfilePhoto"));
    assert.ok(calls.some((c) => c.method === "setWebhook"));
  } finally { globalThis.fetch = realFetch; }
});

test("/setup: a bad AI key is reported plainly and the page does not claim success", async () => {
  const db = makeDb();
  const fx = fakeFetch([]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fx.f;
  try {
    const res = await worker.fetch(post("/setup", { word: OWN.CLAIM_CODE }), env(db, { ...OWN, OPENROUTER_API_KEY: "nope" }), ctx);
    const html = await res.text();
    assert.match(html, /OpenRouter did not accept the AI key/);
    assert.match(html, /Nearly there/);
    assert.ok(!html.includes("Open Telegram and say hello"));
  } finally { globalThis.fetch = realFetch; }
});

test("the command menu: deploy.sh and the code carry the same commands", () => {
  const sh = readFileSync(new URL("../deploy.sh", import.meta.url), "utf8");
  for (const c of COMMANDS) assert.ok(sh.includes(`command: "${c.command}"`), `deploy.sh is missing /${c.command}`);
});

test("bot name: what the owner called their bot is used in the greeting and the system prompt", async () => {
  const { systemPromptFor, ONBOARD_GREETING, SYSTEM_PROMPT } = await import("../src/prompts.ts");
  assert.equal(systemPromptFor("Rafiki"), SYSTEM_PROMPT);
  assert.match(systemPromptFor("Juma"), /You are Juma \(the assistant software is called Rafiki\), a personal agent on Telegram/);
  assert.match(ONBOARD_GREETING("Sam", "Juma"), /Hi Sam, I'm Juma\./);
  assert.match(ONBOARD_GREETING("Sam"), /I'm Rafiki\./);
});
