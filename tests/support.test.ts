import assert from "node:assert/strict";
import { test } from "node:test";
import { handleUpdate, type Deps } from "../src/handler.ts";
import { AUTHOR, SIGN_OFF, SUPPORT, bech32mValid } from "../src/support.ts";
import { ENV, fakeFetch, makeDb } from "./shim.ts";

test("support: every value is present, the on-chain address passes its Bech32m checksum, a typo does not", () => {
  for (const v of [...Object.values(SUPPORT), ...Object.values(AUTHOR)]) assert.ok(v.length > 5);
  assert.ok(bech32mValid(SUPPORT.bitcoin));
  assert.ok(!bech32mValid(SUPPORT.bitcoin.slice(0, -1) + "q"));
  assert.equal(SIGN_OFF, "Made with ❤️ by Brian Gachichio");
  assert.equal(AUTHOR.x, "https://x.com/b_gachichio");
});

test("about: /about shows the sign-off, the X and GitHub links, and the three support options with copy buttons", async () => {
  const db = makeDb();
  const fx = fakeFetch([]);
  const deps: Deps = { db, env: ENV, f: fx.f, now: Date.UTC(2026, 10, 3, 5, 0) };
  await handleUpdate(deps, { update_id: 1, message: { message_id: 1, from: { id: 100200300 }, chat: { id: 100200300 }, text: "/start claim123" } });
  fx.tg.length = 0;
  await handleUpdate(deps, { update_id: 2, message: { message_id: 2, from: { id: 100200300 }, chat: { id: 100200300 }, text: "/about" } });
  const call = fx.tg.find((c) => c.method === "sendMessage")!;
  const text = String(call.body.text);
  assert.ok(text.includes(SIGN_OFF) && text.includes(AUTHOR.x) && text.includes(AUTHOR.github));
  const rows = (call.body.reply_markup as { inline_keyboard: Record<string, unknown>[][] }).inline_keyboard.flat();
  assert.ok(rows.some((b) => b.url === SUPPORT.card));
  assert.ok(rows.some((b) => (b.copy_text as { text: string } | undefined)?.text === SUPPORT.lightning));
  assert.ok(rows.some((b) => (b.copy_text as { text: string } | undefined)?.text === SUPPORT.bitcoin));
});
