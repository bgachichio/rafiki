import assert from "node:assert/strict";
import { test } from "node:test";
import { handleUpdate, type Deps } from "../src/handler.ts";
import { mediaTick } from "../src/mediacheck.ts";
import { executeActions, validateActions } from "../src/actions.ts";
import { googleLink, icsFile } from "../src/cal_link.ts";
import { Telegram, type TgUpdate } from "../src/telegram.ts";
import { getSetting, setSetting } from "../src/db.ts";
import { ACTION_GATE } from "../src/gates.ts";
import type { Ctx } from "../src/agent.ts";
import { ENV, agentJson, fakeFetch, makeDb, sent } from "./shim.ts";

const T0 = Date.UTC(2026, 10, 3, 5, 0);
let uid = 18000;
const msg = (text: string): TgUpdate => ({ update_id: ++uid, message: { message_id: uid, from: { id: 100200300, first_name: "Sam" }, chat: { id: 100200300 }, text } });
const loc = (): TgUpdate => ({ update_id: ++uid, message: { message_id: uid, from: { id: 100200300, first_name: "Sam" }, chat: { id: 100200300 }, location: { latitude: -1.29, longitude: 36.82 } } });

async function setup(queue: ReturnType<typeof agentJson>[] = []) {
  const db = makeDb();
  const fx = fakeFetch(queue);
  const deps: Deps = { db, env: ENV, f: fx.f, now: T0 };
  await handleUpdate(deps, msg("/start claim123"));
  await setSetting(db, "ob_step", "done");
  fx.tg.length = 0;
  const ctx: Ctx = { db, env: ENV, f: fx.f, now: T0, off: 180, tg: new Telegram(ENV.TELEGRAM_BOT_TOKEN, fx.f), chatId: 100200300 };
  return { db, fx, deps, ctx };
}

test("media check: each kind ticks once, in any order, and the last one ends the check; nothing happens when no check is running", async () => {
  const s = await setup();
  await mediaTick(s.ctx, s.ctx.tg!, 100200300, "voice");
  assert.equal(sent(s.fx.tg).length, 0, "no check running, so no message");
  await handleUpdate(s.deps, msg("/check"));
  assert.match(sent(s.fx.tg).at(-1)!, /· a voice note\n· a photo\n· a file\n· your location/);
  await mediaTick(s.ctx, s.ctx.tg!, 100200300, "photo");
  assert.match(sent(s.fx.tg).at(-1)!, /Got a photo\.\n\n· a voice note\n✓ a photo/);
  await handleUpdate(s.deps, loc());
  assert.match(sent(s.fx.tg).at(-1)!, /✓ your location/);
  await mediaTick(s.ctx, s.ctx.tg!, 100200300, "voice");
  await mediaTick(s.ctx, s.ctx.tg!, 100200300, "file");
  assert.match(sent(s.fx.tg).at(-1)!, /All four reached me/);
  assert.equal(await getSetting(s.db, "mc"), "");
  const n = sent(s.fx.tg).length;
  await mediaTick(s.ctx, s.ctx.tg!, 100200300, "voice");
  assert.equal(sent(s.fx.tg).length, n, "finished checks stay finished");
});

test("calendar link: the action builds a Google link and an .ics file, writes to no calendar, and past or untitled events are dropped", async () => {
  assert.equal(ACTION_GATE.calendar_link, "G1");
  assert.deepEqual(validateActions([{ type: "calendar_link", title: "x", start: "2026-11-02T09:00" }], T0, 180), [], "in the past");
  assert.deepEqual(validateActions([{ type: "calendar_link", start: "2026-11-05T09:00" }], T0, 180), [], "no title");
  const [a] = validateActions([{ type: "calendar_link", title: "Dinner, with Jo", start: "2026-11-05T19:00", location: "Café; Westlands" }], T0, 180);
  assert.ok(a && a.type === "calendar_link");
  assert.equal(a.endMs - a.startMs, 3600000, "an hour by default");
  const link = googleLink(a);
  assert.match(link, /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&text=Dinner%2C\+with\+Jo&dates=20261105T160000Z%2F20261105T170000Z&location=/);
  const ics = icsFile(a, T0);
  assert.match(ics, /BEGIN:VEVENT\r\n.*DTSTART:20261105T160000Z\r\nDTEND:20261105T170000Z\r\nSUMMARY:Dinner\\, with Jo\r\nLOCATION:Café\; Westlands\r\nEND:VEVENT/s);
  assert.ok(ics.includes("\r\n") && ics.endsWith("END:VCALENDAR\r\n"));
});

test("calendar link: asking in chat sends the button and the file, and says what was prepared", async () => {
  const s = await setup([agentJson({ reply: "Here you go.", actions: [{ type: "calendar_link", title: "Rafiki demo", start: "2026-11-05T15:00", location: "Zoom" }] })]);
  await handleUpdate(s.deps, msg("put the Rafiki demo in my calendar on Thursday at 3pm"));
  const card = s.fx.tg.filter((c) => c.method === "sendMessage").find((c) => String(c.body.text).startsWith("Add to your calendar: Rafiki demo"))!;
  assert.ok(card, "the add button message");
  const urlBtn = (card.body.reply_markup as { inline_keyboard: { url?: string }[][] }).inline_keyboard.flat().find((b) => b.url)!;
  assert.match(urlBtn.url!, /calendar\.google\.com\/calendar\/render\?action=TEMPLATE&text=Rafiki\+demo/);
  const file = s.fx.tg.find((c) => c.method === "sendDocument")!;
  assert.equal(file.body.filename, "event.ics");
  assert.match(String(file.body.content), /SUMMARY:Rafiki demo/);
  assert.ok(sent(s.fx.tg).some((t) => /Add-to-calendar link ready: Rafiki demo/.test(t)));
  void executeActions;
});
