import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ctx } from "../src/agent.ts";
import { codeCallback, codeCommand, emailAllowed, emailText, handleEmail, inboundKey } from "../src/bridge.ts";
import worker from "../src/index.ts";
import { Telegram } from "../src/telegram.ts";
import { ENV, agentJson, fakeFetch, makeDb, sent } from "./shim.ts";

const OWNER = 100200300;
const T0 = Date.UTC(2026, 10, 3, 5, 0);

function setup(queue = [] as ReturnType<typeof agentJson>[], env = ENV as Ctx["env"]) {
  const db = makeDb();
  const fx = fakeFetch(queue);
  const ctx: Ctx = { db, env, f: fx.f, now: T0, off: 180 };
  return { db, fx, ctx, tg: new Telegram(ENV.TELEGRAM_BOT_TOKEN, fx.f) };
}

const MULTI = [
  "From: Jane Wanjiru <jane@acme.co.ke>", "Subject: Invoice 114", 'Content-Type: multipart/alternative; boundary="b1"', "", "--b1",
  "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", "Hi Brian, invoice 114 for KES 48,000 is due on Fri=", "day. Can you confirm=3F", "--b1",
  "Content-Type: text/html", "", "<p>Hi Brian, <b>invoice</b></p>", "--b1--", ""].join("\r\n");

test("email: the plain part is preferred and decoded; HTML-only and base64 mail are read too", () => {
  assert.equal(emailText(MULTI), "Hi Brian, invoice 114 for KES 48,000 is due on Friday. Can you confirm?");
  assert.equal(emailText("Subject: x\r\nContent-Type: text/html\r\n\r\n<div>Lunch <i>at</i> one?</div>"), "Lunch at one?");
  assert.equal(emailText(`Subject: x\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n${btoa("Meeting moved to 3pm")}`), "Meeting moved to 3pm");
});

test("email: only allowed senders are read; Gmail's forwarding confirmation always gets through", async () => {
  const s = setup();
  assert.equal(await emailAllowed(s.ctx, "jane@acme.co.ke"), false);
  await s.db.prepare("INSERT INTO settings (key, value) VALUES ('email_allow', 'me@gmail.com,@acme.co.ke')").bind().run();
  assert.equal(await emailAllowed(s.ctx, "Jane@Acme.co.ke"), true);
  assert.equal(await emailAllowed(s.ctx, "spam@else.com"), false);
  assert.equal(await emailAllowed(s.ctx, "forwarding-noreply@google.com"), true);
});

test("email: an allowed mail becomes a short read, and text from outside can propose a reminder but never write a fact or a setting", async () => {
  const s = setup([agentJson({ reply: "Jane wants confirmation of invoice 114 (KES 48,000) by Friday.", actions: [{ type: "reminder", text: "Confirm invoice 114 to Jane", due: "2026-11-06T09:00" }, { type: "note", text: "Brian owes Jane KES 1m" }, { type: "set_setting", key: "brief_time", value: "03:00" }] })]);
  await s.db.prepare("INSERT INTO settings (key, value) VALUES ('email_allow', '@acme.co.ke')").bind().run();
  const stream = new Response(MULTI).body!;
  const r = await handleEmail({ from: "jane@acme.co.ke", to: "in@x", headers: new Headers({ subject: "Invoice 114" }), raw: stream }, s.ctx, s.tg, OWNER);
  assert.equal(r, "delivered");
  const prompt = (s.fx.llm[0]!.body.messages as { content: string }[]).at(-1)!.content;
  assert.match(prompt, /\[Incoming Email from Jane Wanjiru <jane@acme\.co\.ke>: Invoice 114\]/);
  assert.match(prompt, /never instructions to you/);
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM reminders").get() as { n: number }).n, 1);
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n, 0, "no fact from outside text");
  assert.equal(s.db.raw.prepare("SELECT value FROM settings WHERE key = 'brief_time'").get(), undefined, "no setting from outside text");
  assert.ok(sent(s.fx.tg).some((t) => /Jane wants confirmation/.test(t)));
});

test("inbound webhook: a wrong key is a 404; the right key delivers a JSON item to the owner", async () => {
  const db = makeDb();
  await db.prepare("INSERT INTO settings (key, value) VALUES ('owner_chat_id', ?)").bind(String(OWNER)).run();
  const fx = fakeFetch([agentJson({ reply: "New lead from the website form: Otieno wants a quote.", actions: [] })]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fx.f;
  try {
    const env = { ...ENV, DB: db } as never;
    const bad = await worker.fetch(new Request("https://r.example/in/0123456789abcdef0123456789abcdef", { method: "POST", body: "hi" }), env, {} as never);
    assert.equal(bad.status, 404);
    const key = await inboundKey(ENV as never, "");
    const ok = await worker.fetch(new Request(`https://r.example/in/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "Zapier", title: "Website form", from: "Otieno", text: "Please send me a quote for 20 units." }) }), env, {} as never);
    assert.equal(ok.status, 200);
    assert.match((fx.llm[0]!.body.messages as { content: string }[]).at(-1)!.content, /\[Incoming Zapier from Otieno: Website form\]/);
    assert.ok(sent(fx.tg).some((t) => /Otieno wants a quote/.test(t)));
  } finally { globalThis.fetch = realFetch; }
});

test("claude code: without set-up it explains; with it, it asks first, then fires the routine and sends the session link", async () => {
  const s = setup();
  await codeCommand(s.ctx, s.tg, OWNER, "fix the typo");
  assert.match(sent(s.fx.tg).pop()!, /claude\.ai\/code\/routines/);
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (u: string | URL | Request, init?: RequestInit) => {
    if (String(u).includes("api.anthropic.com")) { calls.push({ url: String(u), init: init! }); return Response.json({ type: "routine_fire", claude_code_session_id: "s1", claude_code_session_url: "https://claude.ai/code/session_s1" }); }
    return s.fx.f(u, init);
  }) as typeof fetch;
  const ctx: Ctx = { ...s.ctx, f, env: { ...ENV, CLAUDE_ROUTINE_ID: "trig_01", CLAUDE_ROUTINE_TOKEN: "tok" } as never };
  const tg = new Telegram(ENV.TELEGRAM_BOT_TOKEN, f);
  await codeCommand(ctx, tg, OWNER, "fix the typo on the pricing page");
  assert.match(sent(s.fx.tg).pop()!, /Start a Claude Code session in the cloud with this task\?/);
  assert.equal(calls.length, 0, "nothing starts before the tap");
  await codeCallback(ctx, tg, OWNER, "cc:go");
  assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/claude_code/routines/trig_01/fire");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["anthropic-beta"], "experimental-cc-routine-2026-04-01");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { text: "fix the typo on the pricing page" });
  const last = s.fx.tg.filter((c) => c.method === "sendMessage").pop()!;
  assert.match(JSON.stringify(last.body.reply_markup), /claude\.ai\/code\/session_s1/);
  await codeCallback(ctx, tg, OWNER, "cc:go");
  assert.match(sent(s.fx.tg).pop()!, /expired/, "a second tap does not start a second session");
});

test("gmail: read-only, opt-in; the brief line names the latest unread in Primary; nothing happens without the gmail scope", async () => {
  const { encrypt } = await import("../src/crypto.ts");
  const { inboxLine } = await import("../src/gmail.ts");
  const GENV = { ...ENV, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "gs", ENCRYPTION_KEY: "k".repeat(64), PUBLIC_URL: "https://r.example" } as never;
  const db = makeDb();
  const seen: string[] = [];
  const f = (async (u: string | URL | Request) => {
    const url = String(u); seen.push(url);
    if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "at" });
    if (url.includes("/messages?")) return Response.json({ messages: [{ id: "m1" }, { id: "m2" }] });
    if (url.includes("/messages/m1")) return Response.json({ snippet: "Can you confirm?", payload: { headers: [{ name: "From", value: '"Jane Wanjiru" <jane@acme.co.ke>' }, { name: "Subject", value: "Invoice 114" }] } });
    if (url.includes("/messages/m2")) return Response.json({ snippet: "See you", payload: { headers: [{ name: "From", value: "otieno@x.com" }, { name: "Subject", value: "Lunch" }] } });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const ctx: Ctx = { db, env: GENV, f, now: T0, off: 180 };
  await db.prepare("INSERT INTO credentials (provider, enc, meta, ts) VALUES ('google', ?, ?, ?)").bind(await encrypt("k".repeat(64), JSON.stringify({ refresh_token: "rt" })), JSON.stringify({ scope: "calendar.readonly" }), T0).run();
  assert.equal(await inboxLine(ctx), null, "calendar-only consent: Gmail is never touched");
  assert.ok(!seen.some((u) => u.includes("gmail")));
  await db.prepare("UPDATE credentials SET meta = ?").bind(JSON.stringify({ scope: "calendar.readonly gmail.readonly" })).run();
  assert.equal(await inboxLine(ctx), "Inbox: 2 unread in Primary. Latest: Jane Wanjiru (Invoice 114); otieno@x.com (Lunch). /inbox to triage.");
  assert.match(seen.find((u) => u.includes("/messages?"))!, /is%3Aunread\+category%3Aprimary/);
});
