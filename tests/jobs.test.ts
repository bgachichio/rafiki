import assert from "node:assert/strict";
import { test } from "node:test";
import { runJobs } from "../src/jobs.ts";
import { Telegram } from "../src/telegram.ts";
import { getSetting, setSetting } from "../src/db.ts";
import type { Ctx } from "../src/agent.ts";
import { ENV, fakeFetch, makeDb, sent } from "./shim.ts";

const T0 = Date.UTC(2026, 10, 3, 5, 0); // 08:00 EAT, inside the brief window
const OWNER = 100200300;

function setup() {
  const db = makeDb();
  const fx = fakeFetch([]);
  const tg = new Telegram(ENV.TELEGRAM_BOT_TOKEN, fx.f);
  const ctx = (now = T0): Ctx => ({ db, env: ENV, f: fx.f, now, off: 180, tg, chatId: OWNER });
  return { db, fx, tg, ctx };
}

test("jobs: a failing step does not stop the next, and the owner is told once a day", async () => {
  const s = setup();
  await setSetting(s.db, "brief_time", "08:00");
  s.db.raw.exec("DROP TABLE reminder_policy"); // only the reminder sweep reads it, so only that step fails
  const failed = await runJobs(s.ctx(), s.tg, OWNER);
  assert.equal(failed.length, 1);
  assert.match(failed[0]!, /^reminders: /);
  const texts = sent(s.fx.tg);
  assert.ok(texts.some((t) => t.startsWith("Morning.")), "the brief still went out");
  assert.ok(texts.some((t) => /Part of my background work failed: reminders:/.test(t)), "the owner heard about it");
  const n = texts.length;
  await runJobs(s.ctx(T0 + 5 * 60000), s.tg, OWNER);
  assert.equal(sent(s.fx.tg).filter((t) => t.startsWith("Part of my background work failed")).length, 1, "not again within a day");
  assert.equal(sent(s.fx.tg).length >= n, true);
  await runJobs(s.ctx(T0 + 25 * 3600000), s.tg, OWNER);
  assert.equal(sent(s.fx.tg).filter((t) => t.startsWith("Part of my background work failed")).length, 2, "a day later it tells you again");
  assert.ok(Number(await getSetting(s.db, "job_alert_ts")) > T0);
});

test("jobs: a healthy run raises no alert, and an error message never carries a secret", async () => {
  const s = setup();
  assert.deepEqual(await runJobs(s.ctx(), s.tg, OWNER), []);
  assert.ok(!sent(s.fx.tg).some((t) => t.startsWith("Part of my background work failed")));
  const t2 = setup();
  t2.db.raw.exec("DROP TABLE reminders");
  const bad = { ...t2.db, prepare: (sql: string) => { if (/FROM reminders/.test(sql)) throw new Error("boom sk-or-v1-abcdefghijklmnopqrstuvwx and more"); return t2.db.prepare(sql); } };
  const failed = await runJobs({ ...t2.ctx(), db: bad } as Ctx, t2.tg, OWNER);
  assert.ok(failed[0]!.includes("[REDACTED]") && !failed[0]!.includes("sk-or-v1-abcdef"));
});
