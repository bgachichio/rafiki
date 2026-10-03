// Decision cards: every choice is one message the owner answers with a tap (the proposal first), a preset, "my own", or "decide later".
// A multi-choice card is a poll. Each answer is stored with the options offered, the choice, any custom text and the time.
import type { Ctx } from "./agent.ts";
import { getSetting, setSetting } from "./db.ts";
import { SEQ, SPECS, type Opt, type Spec } from "./decisions.ts";
import { DEFAULT_MODELS, modelLabel, proposeModels, type ModelKind } from "./models.ts";
import { loadPolicy, markConfirmed } from "./policy.ts";
import { loadPrefs } from "./prefs.ts";
import type { Button, Telegram } from "./telegram.ts";

interface Row { id: number; key: string; options: string; proposed: string | null; chosen: string | null; custom: string | null; state: string; multi: number; poll_id: string | null; seq: number }

export interface AskOpts { intro?: string; proposed?: string; seq?: boolean }

const optRows = (opts: Opt[], proposed: string | null, id: number): Button[][] => opts.map((o, i) => [{ text: o.id === proposed ? `✅ ${o.label} (suggested)` : o.label, data: `dc:${id}:${i}` }]);

/** Put one decision to the owner. Any earlier open card for the same decision is retired. */
export async function askDecision(ctx: Ctx, tg: Telegram, chatId: number, key: string, o: AskOpts = {}): Promise<boolean> {
  const spec = SPECS[key];
  if (!spec) return false;
  const opts = await spec.options(ctx);
  const prop = JSON.parse((await getSetting(ctx.db, "dc_prop")) || "{}") as Record<string, string>;
  const proposed = o.proposed ?? prop[key] ?? (await spec.effective(ctx));
  await ctx.db.prepare("UPDATE decisions SET state = 'superseded' WHERE key = ? AND state IN ('open', 'review')").bind(key).run();
  const row = await ctx.db.prepare("INSERT INTO decisions (ts, key, question, options, proposed, multi, seq) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id").bind(ctx.now, key, spec.question, JSON.stringify(opts), proposed, spec.multi ? 1 : 0, o.seq ? 1 : 0).first<{ id: number }>();
  const id = Number(row?.id);
  const head = `${o.intro ? `${o.intro}\n\n` : ""}${spec.question}`;
  const extras: Button[][] = [spec.noCustom ? [{ text: "Decide later", data: `dc:${id}:later` }] : [{ text: "✏️ My own", data: `dc:${id}:own` }, { text: "Decide later", data: `dc:${id}:later` }]];
  if (o.seq) extras.push([{ text: "Use the defaults for the rest", data: `dc:${id}:skip` }]);
  if (spec.multi) {
    await tg.send(chatId, `${head}\n\nTick the languages in the poll below. You can also tap "My own" to type them.`, extras);
    const pollId = await tg.sendPoll(chatId, spec.question, opts.map((x) => x.label), true);
    if (pollId) await ctx.db.prepare("UPDATE decisions SET poll_id = ? WHERE id = ?").bind(pollId, id).run();
    return true;
  }
  const cur = proposed && spec.show(proposed) ? `\nNow: ${spec.show(await spec.effective(ctx))}` : "";
  await tg.send(chatId, `${head}${cur}`, [...optRows(opts, proposed, id), ...extras]);
  return true;
}

async function load(ctx: Ctx, id: number): Promise<{ row: Row; spec: Spec; opts: Opt[] } | null> {
  const row = await ctx.db.prepare("SELECT id, key, options, proposed, chosen, custom, state, multi, poll_id, seq FROM decisions WHERE id = ?").bind(id).first<Row>();
  const spec = row ? SPECS[row.key] : undefined;
  return row && spec ? { row, spec, opts: JSON.parse(row.options) as Opt[] } : null;
}

async function finish(ctx: Ctx, tg: Telegram, chatId: number, d: { row: Row; spec: Spec }, chosen: string, custom: string | null, value: string, how: "preset" | "custom" | "poll"): Promise<void> {
  if (how === "custom" && d.spec.applyCustom && !d.spec.parse) await d.spec.applyCustom(ctx, value);
  else await d.spec.apply(ctx, value);
  await ctx.db.prepare("UPDATE decisions SET state = 'confirmed', chosen = ?, custom = ?, done_ts = ? WHERE id = ?").bind(chosen, custom, ctx.now, d.row.id).run();
  await markConfirmed(ctx.db, ctx.now, d.row.key);
  await tg.send(chatId, `Saved. ${d.spec.label}: ${d.spec.show(value)}.`, d.spec.noCustom && d.row.key.startsWith("contacts.") ? undefined : [[{ text: "Change", data: `dc:${d.row.id}:redo` }]]);
  await d.spec.after?.(ctx, tg, chatId);
  await afterCard(ctx, tg, chatId, d.row.seq === 1);
}

async function afterCard(ctx: Ctx, tg: Telegram, chatId: number, seq: boolean): Promise<void> {
  if (!seq) return;
  const rest = JSON.parse((await getSetting(ctx.db, "dc_seq")) || "[]") as string[];
  const next = rest.shift();
  await setSetting(ctx.db, "dc_seq", JSON.stringify(rest));
  if (next) await askDecision(ctx, tg, chatId, next, { seq: true });
  else await endSequence(ctx, tg, chatId);
}

async function endSequence(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  await summaryCard(ctx, tg, chatId);
  if ((await getSetting(ctx.db, "dc_after")) === "models") { await setSetting(ctx.db, "dc_after", ""); await modelProposal(ctx, tg, chatId); }
}

export async function startSequence(ctx: Ctx, tg: Telegram, chatId: number, keys: string[] = SEQ, o: { models?: boolean } = {}): Promise<void> {
  const [first, ...rest] = keys;
  await setSetting(ctx.db, "dc_after", o.models ? "models" : "");
  if (!first) { if (o.models) await endSequence(ctx, tg, chatId); return; }
  await tg.send(chatId, `${keys.length} quick ${keys.length === 1 ? "question" : "questions"} about how I should work for you. Each is one tap. Anything you skip keeps a sensible default, and you can change any of it later in /preferences.`);
  await setSetting(ctx.db, "dc_seq", JSON.stringify(rest));
  await askDecision(ctx, tg, chatId, first, { seq: true });
}

/** What is in force for each rule, and whether the owner has confirmed it. */
export async function rulesLines(ctx: Ctx): Promise<string[]> {
  const { status } = await loadPolicy(ctx.db);
  const out: string[] = [];
  for (const k of SEQ) {
    const spec = SPECS[k]!;
    const conf = status[k] === "confirmed" || status[`setting.${k}`] === "confirmed";
    out.push(`${conf ? "✓" : "·"} ${spec.label}: ${spec.show(await spec.effective(ctx))}${conf ? "" : " (not confirmed)"}`);
  }
  return out;
}

export async function summaryCard(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  await tg.send(chatId, ["Here is how I will work for you:", ...(await rulesLines(ctx)), "", "✓ confirmed by you, · a default I am using until you say otherwise."].join("\n"), [[{ text: "Confirm all", data: "dc:sum:all" }, { text: "Review one by one", data: "dc:sum:review" }]]);
}

export async function cardCallback(ctx: Ctx, tg: Telegram, chatId: number, data: string): Promise<boolean> {
  if (await modelCardCallback(ctx, tg, chatId, data)) return true;
  if (data === "dc:seq") { await startSequence(ctx, tg, chatId); return true; }
  if (data === "dc:sum:all") {
    for (const k of SEQ) { const spec = SPECS[k]!; const st = await ctx.db.prepare("SELECT status FROM pref_state WHERE key = ? OR key = ?").bind(k, `setting.${k}`).first<{ status: string }>(); if (st?.status !== "confirmed") await spec.apply(ctx, await spec.effective(ctx)); }
    await tg.send(chatId, "All confirmed. I'll ask again only if what I see you do suggests a change, and never more than one question a day.");
    return true;
  }
  if (data === "dc:sum:review") { await startSequence(ctx, tg, chatId); return true; }
  const m = /^dc:(\d+):(\d+|own|later|skip|yes|redo)$/.exec(data);
  if (!m) return false;
  const d = await load(ctx, Number(m[1]));
  if (!d) { await tg.send(chatId, "I can't find that question any more. /preferences shows where things stand."); return true; }
  const act = m[2]!;
  if (act === "redo") { await askDecision(ctx, tg, chatId, d.row.key); return true; }
  if (d.row.state !== "open" && d.row.state !== "review") { await tg.send(chatId, "That one is already answered. Tap Change under my reply, or open /preferences."); return true; }
  if (act === "own") { await setSetting(ctx.db, "dc_wait", String(d.row.id)); await tg.send(chatId, `${d.spec.hint} (Send /cancel to stop.)`); return true; }
  if (act === "later") {
    await ctx.db.prepare("UPDATE decisions SET state = 'deferred', done_ts = ? WHERE id = ?").bind(ctx.now, d.row.id).run();
    await tg.send(chatId, `Okay. I'll keep using ${d.spec.show(await d.spec.effective(ctx))} for ${d.spec.label.toLowerCase()} until you decide.`);
    await afterCard(ctx, tg, chatId, d.row.seq === 1);
    return true;
  }
  if (act === "skip") { await setSetting(ctx.db, "dc_seq", "[]"); await ctx.db.prepare("UPDATE decisions SET state = 'deferred', done_ts = ? WHERE id = ?").bind(ctx.now, d.row.id).run(); await endSequence(ctx, tg, chatId); return true; }
  if (act === "yes") { if (!d.row.custom) return true; await finish(ctx, tg, chatId, d, "custom", d.row.custom, d.row.custom, "custom"); return true; }
  const opt = d.opts[Number(act)];
  if (!opt) return true;
  await finish(ctx, tg, chatId, d, opt.id, null, opt.id, "preset");
  return true;
}

/** Free text while a "my own" answer is awaited. Returns true when the message belonged to the card. */
export async function cardText(ctx: Ctx, tg: Telegram, chatId: number, text: string): Promise<boolean> {
  const wait = Number((await getSetting(ctx.db, "dc_wait")) || 0);
  if (!wait) return false;
  if (text.trim().startsWith("/")) { await setSetting(ctx.db, "dc_wait", ""); return false; }
  const d = await load(ctx, wait);
  if (!d) { await setSetting(ctx.db, "dc_wait", ""); return false; }
  const value = d.spec.parse ? d.spec.parse(text) : text.trim().slice(0, 200);
  if (!value) { await tg.send(chatId, `I couldn't read that. ${d.spec.hint}`); return true; }
  await setSetting(ctx.db, "dc_wait", "");
  await ctx.db.prepare("UPDATE decisions SET state = 'review', custom = ? WHERE id = ?").bind(value, d.row.id).run();
  await tg.send(chatId, `I'll set ${d.spec.label.toLowerCase()} to: ${d.spec.show(value)}. Use it?`, [[{ text: "Yes, use it", data: `dc:${d.row.id}:yes` }, { text: "Change it", data: `dc:${d.row.id}:own` }]]);
  return true;
}

/** A poll answer for a multi-choice card. Returns true when it was one. */
export async function cardPoll(ctx: Ctx, tg: Telegram, chatId: number, pollId: string, optionIds: number[]): Promise<boolean> {
  const row = await ctx.db.prepare("SELECT id FROM decisions WHERE poll_id = ? AND state = 'open'").bind(pollId).first<{ id: number }>();
  if (!row) return false;
  const d = await load(ctx, row.id);
  if (!d) return false;
  const picked = optionIds.map((i) => d.opts[i]?.id).filter((x): x is string => !!x);
  if (!picked.length) return true; // a retracted vote changes nothing
  await finish(ctx, tg, chatId, d, picked.join(","), null, picked.join(", "), "poll");
  return true;
}

/** Propose the three models from what the owner shared. Nothing applies until a tap. */
export async function modelProposal(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  const facts = (await ctx.db.prepare("SELECT text FROM facts ORDER BY id DESC LIMIT 200").bind().all<{ text: string }>()).results.map((f) => f.text).join("\n").slice(0, 20000);
  const prefs = await loadPrefs(ctx.db);
  const p = proposeModels(`${facts}\n${prefs.style_note ?? ""}`, prefs.lang ?? "");
  await setSetting(ctx.db, "dc_prop", JSON.stringify({ "model.fast": p.fast, "model.smart": p.smart, "model.media": p.media }));
  const same = (["fast", "smart", "media"] as ModelKind[]).every((k) => p[k] === DEFAULT_MODELS[k]);
  await tg.send(chatId, [same ? "On the AI models, I suggest keeping the defaults:" : "Based on what you shared, I suggest these AI models:", `- Everyday: ${modelLabel("fast", p.fast)}`, `- Deep thinking: ${modelLabel("smart", p.smart)}`, `- Voice, photos, files: ${modelLabel("media", p.media)}`, "", ...p.reasons].join("\n"),
    [[{ text: "Use these", data: "dc:models:use" }, { text: "Review each", data: "dc:models:review" }], [{ text: "Keep what I have", data: "dc:models:keep" }]]);
}

export async function modelCardCallback(ctx: Ctx, tg: Telegram, chatId: number, data: string): Promise<boolean> {
  const m = /^dc:models:(use|review|keep)$/.exec(data);
  if (!m) return false;
  const keys = ["model.fast", "model.smart", "model.media"];
  if (m[1] === "review") { await startSequence(ctx, tg, chatId, keys); return true; }
  const prop = JSON.parse((await getSetting(ctx.db, "dc_prop")) || "{}") as Record<string, string>;
  const lines: string[] = [];
  for (const k of keys) {
    const spec = SPECS[k]!;
    const v = m[1] === "use" ? (prop[k] ?? await spec.effective(ctx)) : await spec.effective(ctx);
    await spec.apply(ctx, v);
    await ctx.db.prepare("INSERT INTO decisions (ts, key, question, options, proposed, chosen, state, done_ts) VALUES (?, ?, ?, '[]', ?, ?, 'confirmed', ?)").bind(ctx.now, k, spec.question, prop[k] ?? null, v, ctx.now).run();
    lines.push(`${spec.label}: ${spec.show(v)}`);
  }
  await setSetting(ctx.db, "dc_prop", "");
  await tg.send(chatId, `Saved. ${lines.join("; ")}. Change any time with /model.`);
  return true;
}
