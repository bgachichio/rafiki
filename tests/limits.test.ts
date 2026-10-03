import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { LIMITS, limitsText } from "../src/limits.ts";
import { ACTION_GATE } from "../src/gates.ts";
import { TARGETS, replaceBlock } from "../scripts/sync-limits.ts";

test("limits: every group has items, no em dashes, and the text lists all of them", () => {
  const text = limitsText();
  for (const g of LIMITS) {
    assert.ok(g.items.length > 0);
    for (const i of g.items) { assert.ok(!i.includes("—"), i); assert.ok(text.includes(i)); }
  }
});

test("limits: no executable action can send, buy, delete or erase, matching what the list promises", () => {
  for (const bad of ["send", "email", "message", "pay", "transfer", "purchase", "buy", "delete", "erase", "forget", "export", "calendar_write", "event_create"]) assert.equal(ACTION_GATE[bad], undefined, bad);
});

test("limits: every page that carries the list has the current one (run `npm run limits` if this fails)", () => {
  for (const t of TARGETS) {
    if (t.optional && !existsSync(t.path)) continue;
    const text = readFileSync(t.path, "utf8");
    const want = replaceBlock(text, t.wrap[0], t.wrap[1], t.render());
    assert.ok(want !== null, `${t.path} is missing its limits markers`);
    assert.equal(text, want, `${t.path} is stale: run npm run limits`);
  }
});
