import { test } from "node:test";
import assert from "node:assert/strict";
import { chat } from "../src/llm.ts";

const env = { OPENROUTER_API_KEY: "k", MODEL_FAST: "m", MODEL_SMART: "m2", MODEL_FREE: "f" } as never;
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }), { status: 200 });
const msgs = [{ role: "user", content: "x" }] as never;

test("retries once on a 503 then succeeds", async () => {
  let n = 0;
  const f = (async () => (++n === 1 ? new Response("", { status: 503 }) : ok())) as never;
  const r = await chat(env, f, { messages: msgs, sens: "S0", deep: false });
  assert.equal(r.text, "hi");
  assert.equal(n, 2);
});
test("retries once on a network error", async () => {
  let n = 0;
  const f = (async () => { if (++n === 1) throw new TypeError("fetch failed"); return ok(); }) as never;
  assert.equal((await chat(env, f, { messages: msgs, sens: "S0", deep: false })).text, "hi");
});
test("gives up after one retry", async () => {
  let n = 0;
  const f = (async () => { n++; return new Response("", { status: 502 }); }) as never;
  await assert.rejects(chat(env, f, { messages: msgs, sens: "S0", deep: false }));
  assert.equal(n, 2);
});
