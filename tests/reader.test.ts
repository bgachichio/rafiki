import assert from "node:assert/strict";
import { test } from "node:test";
import { handleUpdate, type Deps } from "../src/handler.ts";
import { htmlToText, linkToRead, readUrl } from "../src/reader.ts";
import type { TgUpdate } from "../src/telegram.ts";
import { ENV, agentJson, fakeFetch, makeDb, sent } from "./shim.ts";

const OWNER = 100200300;
const T0 = Date.UTC(2026, 10, 3, 5, 0);
let uid = 50000;
const msg = (text: string): TgUpdate => ({ update_id: ++uid, message: { message_id: uid, from: { id: OWNER, first_name: "Sam" }, chat: { id: OWNER }, text } });
const PAGE = `<!doctype html><html><head><title>Why bees dance &amp; how</title><meta name="description" content="A short study."></head><body>
<nav>Home | About | Subscribe</nav><script>track()</script>
<article><h1>Why bees dance</h1><p>Honeybees tell each other where food is by dancing. The angle of the waggle run points to the food relative to the sun.</p>
<p>A one-second waggle means roughly 1 km of flight. Scientists decoded this in the 1940s; Karl von Frisch won a Nobel Prize for it in 1973.</p>
<p>${"More detail about the waggle dance and its uses. ".repeat(40)}</p></article><footer>© 2026 Bee News</footer></body></html>`;

test("reader: a link on its own, or with a short ask, is read; a link inside a long message is not", () => {
  assert.equal(linkToRead("https://example.com/a"), "https://example.com/a");
  assert.equal(linkToRead("summarise this https://example.com/a."), "https://example.com/a");
  assert.equal(linkToRead("Explain it like I'm ten: https://x.com/u/status/1"), "https://x.com/u/status/1");
  assert.equal(linkToRead(`I was thinking about our launch and how the team should handle the press list next week, see https://example.com/a for the notes we wrote, and tell me who to call first`), null);
  assert.equal(linkToRead("compare https://a.com and https://b.com"), null);
});

test("reader: page furniture and scripts are dropped, the article is kept, entities are decoded", () => {
  const r = htmlToText(PAGE);
  assert.equal(r.title, "Why bees dance & how");
  assert.match(r.text, /waggle run points to the food/);
  assert.doesNotMatch(r.text, /Subscribe|track\(\)|Bee News/);
});

test("reader: private addresses are refused, and a blocked site says so plainly", async () => {
  const ctx = { db: makeDb(), env: ENV, f: fakeFetch([]).f, now: T0, off: 180 } as never;
  assert.equal(((await readUrl(ctx, "http://192.168.1.1/admin")) as { why: string }).why, "I only read public web links.");
  assert.match(((await readUrl(ctx, "https://blocked.example/x")) as { why: string }).why, /answered 404/);
});

test("reader: an X post is read through the public FxTwitter API, including a long-form article", async () => {
  const fx = fakeFetch([], {}, { "https://api.fxtwitter.com/2/thread/42": JSON.stringify({ thread: [{ text: "x.com/i/article/9", author: { name: "Ki", screen_name: "undefinedKi" }, created_at: "Mon Sep 28", article: { title: "The 5 levels of AI agents", content: { blocks: [{ text: "Context is what is on the desk." }, { text: "Evals are the same test every month." }] } } }] }) });
  const r = await readUrl({ db: makeDb(), env: ENV, f: fx.f, now: T0, off: 180 } as never, "https://x.com/undefinedKi/status/42?s=20");
  assert.ok(r.ok);
  assert.equal(r.title, "The 5 levels of AI agents");
  assert.match(r.text, /same test every month/);
});

test("reader: sending a link gets an explanation in the professor style, and the page is kept in searchable memory", async () => {
  const db = makeDb();
  const fx = fakeFetch([agentJson({ reply: "Big idea: bees dance to give directions.", actions: [] })], {}, { "https://bees.example/dance": PAGE });
  const deps: Deps = { db, env: ENV, f: fx.f, now: T0 };
  await db.prepare("INSERT INTO settings (key, value) VALUES ('owner_chat_id', ?), ('ob_step', 'done')").bind(String(OWNER)).run();
  await handleUpdate(deps, msg("https://bees.example/dance"));
  const call = fx.llm[0]!;
  const msgs = call.body.messages as { content: string }[];
  assert.match(msgs.at(-1)!.content, /\[Link: Why bees dance & how \| bees\.example\]/);
  assert.match(msgs.at(-1)!.content, /maths professor explains an idea to a bright 10-year-old/);
  assert.ok(sent(fx.tg).some((t) => /Big idea: bees dance/.test(t)));
  const doc = db.raw.prepare("SELECT name FROM docs").get() as { name: string };
  assert.match(doc.name, /Why bees dance/);
  const stored = db.raw.prepare("SELECT text FROM messages WHERE role = 'user'").get() as { text: string };
  assert.equal(stored.text, "https://bees.example/dance", "memory keeps the link, not the whole page, as the owner's message");
});
