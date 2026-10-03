import assert from "node:assert/strict";
import { test } from "node:test";
import { handleUpdate, type Deps } from "../src/handler.ts";
import { buildBrief } from "../src/schedule.ts";
import { birthdayLine, fileContacts, parseVcf, type Contact } from "../src/vcard.ts";
import { recall } from "../src/memory.ts";
import { setSetting } from "../src/db.ts";
import type { Ctx } from "../src/agent.ts";
import type { TgUpdate } from "../src/telegram.ts";
import { ENV, fakeFetch, makeDb, sent } from "./shim.ts";

const VCF = `BEGIN:VCARD
VERSION:3.0
FN:Wanjiru Otieno
N:Otieno;Wanjiru;;;
ORG:Acme Ltd;Sales
TITLE:Head of Sales
TEL;TYPE=CELL:+254 700 111 222
EMAIL:wanjiru@acme.example
BDAY:1990-11-03
END:VCARD
BEGIN:VCARD
VERSION:3.0
N:Mwangi;Peter;;;
BDAY:--11-04
NOTE:Met at a long
 folded note line
END:VCARD
BEGIN:VCARD
VERSION:3.0
ORG:Nameless Co
END:VCARD
BEGIN:VCARD
VERSION:3.0
FN:Ann Lee
BDAY:19850230
END:VCARD
`;
const T0 = Date.UTC(2026, 10, 3, 5, 0); // 03-11-2026, 08:00 EAT
let uid = 16000;
const msg = (text: string): TgUpdate => ({ update_id: ++uid, message: { message_id: uid, from: { id: 100200300, first_name: "Sam" }, chat: { id: 100200300 }, text } });
const tap = (data: string): TgUpdate => ({ update_id: ++uid, callback_query: { id: `c${uid}`, from: { id: 100200300, first_name: "Sam" }, data, message: { message_id: 9, chat: { id: 100200300 } } } });
const doc = (file_id: string, file_name: string): TgUpdate => ({ update_id: ++uid, message: { message_id: uid, from: { id: 100200300, first_name: "Sam" }, chat: { id: 100200300 }, document: { file_id, file_name, file_size: 900, mime_type: "text/vcard" } } });
const lastCall = (fx: { tg: { method: string; body: Record<string, unknown> }[] }) => fx.tg.filter((c) => c.method === "sendMessage").at(-1)!;
const btns = (c: { body: Record<string, unknown> }) => ((c.body.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] } | undefined)?.inline_keyboard ?? []).flat();

test("vcard: names, organisations, birthdays and phone numbers are read; a card with no name is skipped; folded lines and odd birthdays are handled", () => {
  const p = parseVcf(VCF);
  assert.equal(p.contacts.length, 3);
  assert.equal(p.skipped, 1);
  const [w, pe, ann] = p.contacts as [Contact, Contact, Contact];
  assert.deepEqual([w.name, w.org, w.title, w.tel, w.email], ["Wanjiru Otieno", "Acme Ltd", "Head of Sales", "+254700111222", "wanjiru@acme.example"]);
  assert.deepEqual(w.bday, { md: "11-03", year: 1990 });
  assert.equal(pe.name, "Peter Mwangi");
  assert.deepEqual(pe.bday, { md: "11-04", year: null });
  assert.equal(ann.name, "Ann Lee");
  assert.equal(ann.bday, null, "30 February does not exist, so it is not kept");
});

async function setup() {
  const db = makeDb();
  const fx = fakeFetch([], { v1: new TextEncoder().encode(VCF) });
  const deps: Deps = { db, env: ENV, f: fx.f, now: T0 };
  await handleUpdate(deps, msg("/start claim123"));
  await setSetting(db, "ob_step", "done");
  fx.tg.length = 0;
  const ctx = (): Ctx => ({ db, env: ENV, f: fx.f, now: T0, off: 180 });
  return { db, fx, deps, ctx };
}

test("flow: a contacts file asks what to keep; names-only keeps out phone numbers and emails; the people are searchable; birthdays reach the brief", async () => {
  const s = await setup();
  await handleUpdate(s.deps, doc("v1", "contacts.vcf"));
  const card = lastCall(s.fx);
  assert.match(String(card.body.text), /I found 3 contacts, 2 with a birthday, and skipped 1 with no name/);
  assert.ok(btns(card).some((b) => b.text.includes("Names and birthdays only")));
  assert.ok(!btns(card).some((b) => b.text.includes("My own")), "no free-text answer for this choice");
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM facts WHERE source LIKE 'contacts:%'").get() as { n: number }).n, 0, "nothing filed before the tap");
  await handleUpdate(s.deps, tap(btns(card).find((b) => b.text.startsWith("✅ Names and birthdays only"))!.callback_data!));
  const fact = (s.db.raw.prepare("SELECT text FROM facts WHERE source LIKE 'contacts:%'").all() as { text: string }[]).map((f) => f.text).join(" ");
  assert.match(fact, /Wanjiru Otieno \(birthday 03-11-1990\)/);
  assert.ok(!fact.includes("+254") && !fact.includes("acme.example") && !fact.includes("Acme Ltd"), "no phone, email or company by default");
  assert.equal((await recall(s.db, "Wanjiru", 3)).length > 0, true);
  const next = lastCall(s.fx);
  assert.match(String(next.body.text), /2 of your contacts have a birthday/);
  await handleUpdate(s.deps, tap(btns(next).find((b) => b.text.includes("Yes, on the day"))!.callback_data!));
  const brief = await buildBrief(s.ctx());
  assert.match(brief, /Birthdays: Wanjiru Otieno today; Peter Mwangi tomorrow/);
  assert.equal(s.fx.llm.length, 0);
});

test("flow: 'everything' keeps companies, phone numbers and emails; a second file replaces the first; 'no' keeps birthdays out of the brief", async () => {
  const s = await setup();
  await handleUpdate(s.deps, doc("v1", "contacts.vcf"));
  await handleUpdate(s.deps, tap(btns(lastCall(s.fx)).find((b) => b.text.includes("Everything"))!.callback_data!));
  const fact = (s.db.raw.prepare("SELECT text FROM facts WHERE source LIKE 'contacts:%'").all() as { text: string }[]).map((f) => f.text).join(" ");
  assert.match(fact, /Wanjiru Otieno \(Acme Ltd; Head of Sales; birthday 03-11-1990; \+254700111222; wanjiru@acme\.example\)/);
  await handleUpdate(s.deps, tap(btns(lastCall(s.fx)).find((b) => b.text.includes("No, keep them"))!.callback_data!));
  assert.ok(!(await buildBrief(s.ctx())).includes("Birthdays:"));
  assert.equal((await birthdayLine(s.ctx())) !== null, true, "they are still there when asked for");
  await handleUpdate(s.deps, doc("v1", "contacts.vcf"));
  await handleUpdate(s.deps, tap(btns(lastCall(s.fx)).find((b) => b.text.includes("Names and birthdays only"))!.callback_data!));
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM facts WHERE source LIKE 'contacts:%'").get() as { n: number }).n, 1, "replaced, not doubled");
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM birthdays").get() as { n: number }).n, 2, "birthdays replaced too");
});

test("limits: 2,000 contacts fit well inside D1's 50 queries per request", async () => {
  const db = makeDb();
  let queries = 0;
  const counted = { ...db, prepare: (sql: string) => { queries++; return db.prepare(sql); } };
  const contacts: Contact[] = Array.from({ length: 2000 }, (_, i) => ({ name: `Person Number ${i}`, org: "Org", title: "", bday: i % 5 === 0 ? { md: "05-17", year: null } : null, tel: "", email: "" }));
  const ctx = { db: counted, env: ENV, f: fetch, now: T0, off: 180 } as Ctx;
  const r = await fileContacts(ctx, contacts, "names_org");
  assert.ok(queries <= 40, `${queries} queries`);
  assert.ok(r.facts > 100 && r.birthdays === 300, `${r.facts} facts, ${r.birthdays} birthdays`);
});
