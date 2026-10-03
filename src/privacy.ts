// Owning your data: /export hands over a copy, /erase everything wipes it. Both are commands only the owner can type;
// the model has no action that reaches either (see ACTION_GATE in gates.ts).
import type { Ctx } from "./agent.ts";
import { decrypt, keyOf } from "./crypto.ts";
import { getSetting, setSetting } from "./db.ts";
import { revoke } from "./google.ts";
import type { Telegram } from "./telegram.ts";
import { fmtDate, fmtDateTime } from "./time.ts";

export const FILES_PER_CALL = 8;
const BATCH_BYTES = 250_000;
const ERASE_WINDOW_MS = 10 * 60000;
export const ERASE_PHRASE = "ERASE EVERYTHING";
/** Settings that are the owner's own choices. Everything else (tokens, nonces, work in progress) is left out of an export. */
const EXPORT_SETTINGS = ["owner_name", "brief_time", "quiet_start", "quiet_end", "daily_cap_usd", "meeting_nudges", "cal_disabled", "paused"];

type Stage = "core" | "messages" | "docs" | "skills" | "done";
interface State { stage: Stage; cursor: number; n: number; day: string }

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "file";

async function coreFile(ctx: Ctx): Promise<string> {
  const { db, off } = ctx;
  const all = async (sql: string): Promise<Record<string, unknown>[]> => (await db.prepare(sql).bind().all<Record<string, unknown>>()).results;
  const withWhen = (rows: Record<string, unknown>[]): Record<string, unknown>[] => rows.map((r) => ({ when: fmtDateTime(Number(r.ts), off), ...r }));
  const settings: Record<string, string> = {};
  for (const k of EXPORT_SETTINGS) { const v = await getSetting(db, k); if (v !== null && v !== "") settings[k] = v; }
  const body = {
    exported_at: fmtDateTime(ctx.now, off),
    about: "Everything Rafiki holds about you except the conversation, files and skills, which come as their own files. Credentials (such as the Google connection) are never exported.",
    settings,
    prefs: await all("SELECT key, value, source FROM prefs ORDER BY key"),
    facts: withWhen(await all("SELECT id, ts, text, category, source, pinned FROM facts ORDER BY id")),
    summaries: withWhen(await all("SELECT id, ts, kind, period, text FROM summaries ORDER BY id")),
    goals: await all("SELECT * FROM goals ORDER BY id"),
    tasks: await all("SELECT * FROM tasks ORDER BY id"),
    reminders: await all("SELECT id, ts, text, due_ts, state, repeat FROM reminders ORDER BY id"),
    customer_ledger: await all("SELECT * FROM ledger ORDER BY id"),
    spends: withWhen(await all("SELECT * FROM spends ORDER BY id")),
    fee_tables: await all("SELECT * FROM fee_tiers ORDER BY id"),
    notes: withWhen(await all("SELECT * FROM notes ORDER BY id")),
    places: await all("SELECT * FROM places ORDER BY name"),
    locations: withWhen(await all("SELECT * FROM locations ORDER BY id DESC LIMIT 5000")),
    imports: await all("SELECT * FROM imports ORDER BY id"),
    feedback: withWhen(await all("SELECT * FROM feedback ORDER BY id")),
    decisions: await all("SELECT id, ts, key, question, options, proposed, chosen, custom, state FROM decisions ORDER BY id"),
    preference_status: await all("SELECT key, status, ts FROM pref_state ORDER BY key"),
  };
  return JSON.stringify(body, null, 1);
}

async function nextFile(ctx: Ctx, st: State): Promise<{ st: State; file?: { name: string; content: string } }> {
  const { db, off } = ctx;
  const base = `rafiki-export-${st.day}`;
  if (st.stage === "core") return { st: { ...st, stage: "messages", cursor: 0, n: st.n + 1 }, file: { name: `${base}-${st.n + 1}-core.json`, content: await coreFile(ctx) } };
  if (st.stage === "messages") {
    const rows = (await db.prepare("SELECT id, ts, role, text FROM messages WHERE id > ? ORDER BY id LIMIT 1500").bind(st.cursor).all<{ id: number; ts: number; role: string; text: string }>()).results;
    if (!rows.length) return { st: { ...st, stage: "docs", cursor: 0 } };
    const out: unknown[] = [];
    let bytes = 0, last = st.cursor;
    for (const r of rows) {
      bytes += r.text.length + 80;
      if (out.length && bytes > BATCH_BYTES) break;
      out.push({ id: r.id, when: fmtDateTime(r.ts, off), role: r.role, text: r.text });
      last = r.id;
    }
    return { st: { ...st, cursor: last, n: st.n + 1 }, file: { name: `${base}-${st.n + 1}-messages.json`, content: JSON.stringify(out, null, 1) } };
  }
  if (st.stage === "docs") {
    const rows = (await db.prepare("SELECT id, ts, name, mime, bytes, text FROM docs WHERE id > ? ORDER BY id LIMIT 200").bind(st.cursor).all<{ id: number; ts: number; name: string; mime: string | null; bytes: number | null; text: string }>()).results;
    if (!rows.length) return { st: { ...st, stage: "skills", cursor: 0 } };
    const out: unknown[] = [];
    let bytes = 0, last = st.cursor;
    for (const r of rows) {
      bytes += r.text.length + 120;
      if (out.length && bytes > BATCH_BYTES) break;
      out.push({ id: r.id, when: fmtDateTime(r.ts, off), name: r.name, mime: r.mime, bytes: r.bytes, text: r.text });
      last = r.id;
    }
    return { st: { ...st, cursor: last, n: st.n + 1 }, file: { name: `${base}-${st.n + 1}-files.json`, content: JSON.stringify(out, null, 1) } };
  }
  if (st.stage === "skills") {
    const s = await db.prepare("SELECT id, name, description, version FROM skills WHERE id > ? ORDER BY id LIMIT 1").bind(st.cursor).first<{ id: number; name: string; description: string; version: string | null }>();
    if (!s) return { st: { ...st, stage: "done" } };
    const secs = (await db.prepare("SELECT heading, body FROM skill_sections WHERE skill_id = ? ORDER BY id").bind(s.id).all<{ heading: string; body: string }>()).results;
    const md = [`# ${s.name}`, s.description, ...secs.map((x) => `${x.heading}\n\n${x.body}`)].filter(Boolean).join("\n\n");
    return { st: { ...st, cursor: s.id, n: st.n + 1 }, file: { name: `${base}-${st.n + 1}-skill-${slug(s.name)}.md`, content: md } };
  }
  return { st };
}

/** Send up to FILES_PER_CALL files, then offer the rest. The place reached is kept, so a retry resumes. */
export async function exportNext(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  let st = JSON.parse((await getSetting(ctx.db, "export_state")) || "null") as State | null;
  if (!st || st.stage === "done") { await tg.send(chatId, "No export is waiting. /export starts a new one."); return; }
  let sent = 0;
  while (st.stage !== "done" && sent < FILES_PER_CALL) {
    const r = await nextFile(ctx, st);
    st = r.st;
    if (!r.file) continue;
    const ok = await tg.sendDocument(chatId, r.file.name, r.file.content, sent === 0 && st.n === 1 ? "Your Rafiki export. Plain text you can open anywhere." : undefined);
    if (!ok) { await tg.send(chatId, "Telegram would not take a file just now. Tap /export again later; I'll start again from the top."); await setSetting(ctx.db, "export_state", ""); return; }
    sent++;
    await setSetting(ctx.db, "export_state", JSON.stringify(st));
  }
  await setSetting(ctx.db, "export_state", JSON.stringify(st));
  if (st.stage === "done") {
    await tg.send(chatId, `That is everything: ${st.n} file${st.n === 1 ? "" : "s"}. Your Google connection is not included, by design. If you want it all gone from me, /erase everything.`);
  } else {
    await tg.send(chatId, `Sent ${sent} file${sent === 1 ? "" : "s"} so far (${st.stage} next).`, [[{ text: "Send the next files", data: "ex:next" }]]);
  }
}

export async function exportStart(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  await setSetting(ctx.db, "export_state", JSON.stringify({ stage: "core", cursor: 0, n: 0, day: fmtDate(ctx.now, ctx.off) } satisfies State));
  await tg.send(chatId, "Putting your export together. Everything I hold about you comes as plain text files: your facts, summaries, goals, spends and settings, then the full conversation, your files and skills.");
  await exportNext(ctx, tg, chatId);
}

/** Revoke and delete the Google connection. Returns whether one existed. */
export async function dropGoogle(ctx: Ctx): Promise<boolean> {
  const cred = await ctx.db.prepare("SELECT enc FROM credentials WHERE provider = 'google'").bind().first<{ enc: string }>();
  if (!cred) return false;
  try { await revoke(ctx.f, (JSON.parse(await decrypt(await keyOf(ctx.env), cred.enc)) as { refresh_token: string }).refresh_token); } catch { /* revoking is best effort */ }
  await ctx.db.prepare("DELETE FROM credentials WHERE provider = 'google'").bind().run();
  await ctx.db.prepare("DELETE FROM cal_cache").bind().run();
  return true;
}

const count = async (ctx: Ctx, table: string): Promise<number> => Number((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).bind().first<{ n: number }>())?.n ?? 0);

export async function eraseWarning(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  await setSetting(ctx.db, "erase_wait", String(ctx.now));
  const [m, f, d, s] = await Promise.all([count(ctx, "messages"), count(ctx, "facts"), count(ctx, "docs"), count(ctx, "skills")]);
  await tg.send(chatId, [
    `This wipes everything I know about you, and it cannot be undone: ${m} messages, ${f} facts, ${d} stored file parts, ${s} skills, plus summaries, goals, tasks, reminders, your customer ledger, spends, places, locations, preferences and your calendar connection.`,
    "",
    "It does not reach your Telegram chat (clear that in Telegram), the short-lived database backups Cloudflare keeps (up to 7 days on the free plan), or anything an AI provider has already received. I keep a cost log with its content blanked, so the daily budget still holds.",
    "",
    `I would export first. If you are sure, type ${ERASE_PHRASE} within 10 minutes. Anything else cancels.`,
  ].join("\n"), [[{ text: "Export first", data: "ex:start" }, { text: "Cancel", data: "er:cancel" }]]);
}

/** Called for every text message. Returns true when the message was consumed by the erase flow. */
export async function eraseText(ctx: Ctx, tg: Telegram, chatId: number, text: string): Promise<boolean> {
  const wait = Number((await getSetting(ctx.db, "erase_wait")) || 0);
  if (!wait) return false;
  await setSetting(ctx.db, "erase_wait", "");
  if (text.trim().toUpperCase() === ERASE_PHRASE && ctx.now - wait <= ERASE_WINDOW_MS) { await eraseNow(ctx, tg, chatId); return true; }
  if (text.trim().startsWith("/")) return false; // any other command carries on, and the erase is off
  await tg.send(chatId, "Cancelled. Nothing was erased.");
  return true;
}

/** Tables wiped by /erase everything. Settings and the cost log are handled separately. */
export const ERASED_TABLES = ["messages", "memory_fts", "facts", "summaries", "notes", "goals", "tasks", "reminders", "ledger", "spends", "fee_tiers", "docs", "locations", "places", "polls", "prefs", "imports", "skill_sections", "skills", "feedback", "decisions", "pref_state", "reminder_policy", "signals", "cal_cache", "credentials"] as const;

export async function eraseNow(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  await dropGoogle(ctx);
  for (const t of ERASED_TABLES) await ctx.db.prepare(`DELETE FROM ${t}`).bind().run();
  await ctx.db.prepare("DELETE FROM outbound WHERE kind LIKE 'meeting:%'").bind().run();
  await ctx.db.prepare("UPDATE runs SET trace = '', agent_role = ''").bind().run();
  await ctx.db.prepare("DELETE FROM settings WHERE key NOT IN ('owner_chat_id', 'daily_cap_usd', 'paused')").bind().run();
  await setSetting(ctx.db, "ob_step", "new");
  await tg.send(chatId, "Done. I now hold nothing about you. I will still answer only you. Send /start to set up again, and clear this chat in Telegram if you want it gone from there too.");
}
