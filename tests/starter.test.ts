import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { handleUpdate, type Deps } from "../src/handler.ts";
import { STARTER_SKILLS } from "../src/starter.gen.ts";
import { importSkill, installStarter, parseSkill, restoreStarter } from "../src/skills.ts";
import { getSetting } from "../src/db.ts";
import type { TgUpdate } from "../src/telegram.ts";
import { ENV, fakeFetch, makeDb, sent } from "./shim.ts";

const T0 = Date.UTC(2026, 10, 3, 5, 0);
let uid = 20000;
const msg = (text: string): TgUpdate => ({ update_id: ++uid, message: { message_id: uid, from: { id: 100200300, first_name: "Sam" }, chat: { id: 100200300 }, text } });
const tap = (data: string): TgUpdate => ({ update_id: ++uid, callback_query: { id: `c${uid}`, from: { id: 100200300, first_name: "Sam" }, data, message: { message_id: 9, chat: { id: 100200300 } } } });
const names = (db: ReturnType<typeof makeDb>): string[] => (db.raw.prepare("SELECT name FROM skills ORDER BY name").all() as { name: string }[]).map((r) => r.name);

test("starter pack: the generated module matches the files, every skill parses, and none carries personal detail", () => {
  const files = readdirSync(new URL("../skills/starter/", import.meta.url)).filter((f) => f.endsWith(".md")).sort();
  assert.deepEqual(STARTER_SKILLS.map(([f]) => f), files, "run `npm run gen` if this fails");
  for (const [f, text] of STARTER_SKILLS) {
    assert.equal(text, readFileSync(new URL(`../skills/starter/${f}`, import.meta.url), "utf8"));
    const sk = parseSkill(f, text);
    assert.ok(sk.name && sk.description && sk.sections.length >= 2, f);
    assert.equal(sk.flags, 0, `${f} must not read as an instruction aimed at the model`);
    assert.ok(!text.includes("—"), `${f} has an em dash`);
    assert.ok(!/\bKES\b|\bNairobi\b|\b\d{9,}\b|@[a-z0-9_]+\.(com|org)/i.test(text), `${f} carries a personal detail`);
  }
  assert.equal(STARTER_SKILLS.length, 7);
});

async function owned() {
  const db = makeDb();
  const fx = fakeFetch([]);
  const deps: Deps = { db, env: ENV, f: fx.f, now: T0 };
  await handleUpdate(deps, msg("/start claim123"));
  return { db, fx, deps };
}

test("claiming the bot installs the starter pack; /skills marks them; an upload with the same name replaces one", async () => {
  const s = await owned();
  assert.equal(names(s.db).length, 7);
  await handleUpdate(s.deps, msg("/skills"));
  assert.match(sent(s.fx.tg).at(-1)!, /- coach v1\.0 \[starter\]/);
  const mine = "---\nname: coach\ndescription: My own coaching rules\nversion: 2.0\n---\n# Style\nBe blunt.\n# Never\nNo pep talks.\n";
  const r = await importSkill(s.db, T0, "my-coach.md", mine);
  assert.ok(r.ok && r.status === "updated");
  await handleUpdate(s.deps, msg("/skills"));
  const text = sent(s.fx.tg).at(-1)!;
  assert.match(text, /- coach v2\.0: My own coaching rules/);
  assert.ok(!/coach v2\.0 \[starter\]/.test(text), "no longer a starter skill");
  assert.equal(await installStarter(s.db, T0 + 1), 0, "a replaced skill is never overwritten by the pack");
  assert.match((s.db.raw.prepare("SELECT description FROM skills WHERE name = 'coach'").get() as { description: string }).description, /My own/);
});

test("removing a starter skill keeps it removed until the owner restores it; restore returns only the missing ones", async () => {
  const s = await owned();
  await handleUpdate(s.deps, msg("/skill remove weekly-review"));
  assert.match(sent(s.fx.tg).at(-1)!, /Removed weekly-review\. It stays removed until you tap Restore starter skills/);
  assert.equal(names(s.db).includes("weekly-review"), false);
  assert.equal(await installStarter(s.db, T0 + 1), 0);
  assert.equal(names(s.db).includes("weekly-review"), false, "still removed");
  await handleUpdate(s.deps, tap("sk:restore"));
  assert.match(sent(s.fx.tg).at(-1)!, /Restored 1 starter skill\./);
  assert.equal(names(s.db).includes("weekly-review"), true);
  assert.equal(await getSetting(s.db, "starter_removed"), "[]");
  assert.equal(await restoreStarter(s.db, T0 + 2), 0);
});

test("starter skills reach the model: a coaching question retrieves the coach playbook", async () => {
  const s = await owned();
  const { recallSkills } = await import("../src/skills.ts");
  const hits = await recallSkills(s.db, "coach me on what keeps getting postponed", '"coach" OR "postponed"');
  assert.ok(hits.some((h) => /coach/i.test(h.name)));
});
