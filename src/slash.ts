// Slash commands, in five small groups. Each group returns true when it handled the command.
import { capUsd, dailyCost, runAgent, type Ctx } from "./agent.ts";
import { loadTiers } from "./actions.ts";
import { getSetting, setSetting } from "./db.ts";
import { agendaText, calendarChoices, getEvents, syncIfStale } from "./calendar.ts";
import { FEED_HELP } from "./ical.ts";
import { consolidateDay } from "./consolidate.ts";
import { authUrl, googleConfigured, makeState, redirectUri } from "./google.ts";
import { addFact, findFacts, fmtHit, recall } from "./memory.ts";
import { describePlace, savePlace } from "./media.ts";
import { startPaste, startWriting } from "./knowme.ts";
import { eraseWarning, dropGoogle, exportStart } from "./privacy.ts";
import { feedbackSummary, thirtyDaysAgo } from "./feedback.ts";
import { limitsText } from "./limits.ts";
import { AUTHOR, SUPPORT, aboutText } from "./support.ts";
import { startMediaCheck } from "./mediacheck.ts";
import { startSequence } from "./cards.ts";
import { importsList, memoryHome, modelCommand, prefsHome, skillCommand, skillsHome, undoCommand } from "./ui.ts";
import { buildBrief, isPaused } from "./schedule.ts";
import { feeFor, kes, parseFees, parseSpendLine } from "./spend.ts";
import { Telegram } from "./telegram.ts";
import { fmtDate, fmtDateTime, fmtTime, startOfLocalDay } from "./time.ts";

const HELP = [
  "Talk to me like a person. Examples:",
  "- remind me to call Sam tomorrow 9am",
  "- lunch 650 mpesa (logs a spend)",
  "- what should I do first today?",
  "- send me a voice note, a photo, a file or your location",
  "- advise me on pricing for X",
  "Commands: /today /agenda /memory /search /remember /forget /rules /check /export /erase /limits /about /calendars /memory /preferences /skills /import /model /connect /place /where /brief /goals /ledger /money /fees /settings /cap /log /why /pause /resume /menu",
].join("\n");

export async function recordSpend(ctx: Ctx, tg: Telegram, chatId: number, text: string): Promise<boolean> {
  const p = parseSpendLine(text);
  if (!p) return false;
  const tiers = await loadTiers(ctx.db);
  const fee = feeFor(tiers, p.channel, p.amountCents);
  await ctx.db.prepare("INSERT INTO spends (ts, amount_cents, fee_cents, category, channel, note) VALUES (?, ?, ?, ?, ?, ?)").bind(ctx.now, p.amountCents, fee ?? 0, p.category, p.channel, p.note).run();
  const t = await ctx.db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS a, COALESCE(SUM(fee_cents),0) AS f FROM spends WHERE ts >= ?").bind(startOfLocalDay(ctx.now, ctx.off)).first<{ a: number; f: number }>();
  const lines = [`Logged: ${p.category}, ${kes(p.amountCents)}${p.channel ? `, ${p.channel === "mpesa" ? "M-PESA" : p.channel}` : ""}.`];
  if (p.channel && fee === null) lines.push(`No fee table for ${p.channel} yet, so no fee added. Set one with /fees ${p.channel} 1-100=0 101-500=7 ...`);
  else if (fee !== null) lines.push(`Fee ${kes(fee)} (your table).`);
  lines.push(`Today: ${kes(Number(t?.a ?? 0))} spent, fees ${kes(Number(t?.f ?? 0))}.`);
  await tg.send(chatId, lines.join("\n"));
  return true;
}

export async function moneySummary(ctx: Ctx): Promise<string> {
  const day = startOfLocalDay(ctx.now, ctx.off);
  const t = await ctx.db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS a, COALESCE(SUM(fee_cents),0) AS f FROM spends WHERE ts >= ?").bind(day).first<{ a: number; f: number }>();
  const m = await ctx.db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS a, COALESCE(SUM(fee_cents),0) AS f FROM spends WHERE ts >= ?").bind(day - 29 * 86400000).first<{ a: number; f: number }>();
  const last = await ctx.db.prepare("SELECT ts, amount_cents, category, note FROM spends ORDER BY id DESC LIMIT 5").bind().all<{ ts: number; amount_cents: number; category: string; note: string }>();
  const lines = [`Today: ${kes(Number(t?.a ?? 0))} (fees ${kes(Number(t?.f ?? 0))})`, `Last 30 days: ${kes(Number(m?.a ?? 0))} (fees ${kes(Number(m?.f ?? 0))})`];
  for (const s of last.results) lines.push(`- ${fmtDate(s.ts, ctx.off)} ${s.category} ${kes(s.amount_cents)} ${s.note}`);
  lines.push("Log a spend by typing it, like: lunch 650 mpesa");
  return lines.join("\n");
}

async function settingsText(ctx: Ctx): Promise<string> {
  const bt = (await getSetting(ctx.db, "brief_time")) ?? "08:00";
  const qs = (await getSetting(ctx.db, "quiet_start")) ?? "21:00";
  const qe = (await getSetting(ctx.db, "quiet_end")) ?? "05:30";
  const paused = await isPaused(ctx);
  return [`Settings`, `Brief: ${bt}`, `Quiet hours: ${qs} to ${qe}`, `Model budget: USD ${(await capUsd(ctx)).toFixed(2)} a day (used today: USD ${(await dailyCost(ctx.db, ctx.now, ctx.off)).toFixed(2)})`, `Status: ${paused ? "paused" : "running"}`].join("\n");
}

async function systemCommand(ctx: Ctx, tg: Telegram, chatId: number, cmd: string, args: string): Promise<boolean> {
  switch (cmd) {
    case "/menu": await tg.send(chatId, "Menu is below. Or just tell me what you need.", undefined, true); return true;
    case "/help": await tg.send(chatId, HELP, undefined, true); return true;
    case "/pause": await setSetting(ctx.db, "paused", "1"); await tg.send(chatId, "Paused. I won't act or send anything until you /resume."); return true;
    case "/resume": await setSetting(ctx.db, "paused", "0"); await tg.send(chatId, "Back on. I'm listening."); return true;
    case "/settings": await tg.send(chatId, await settingsText(ctx), [[{ text: "Brief 06:30", data: "set:brief:06:30" }, { text: "Brief 08:00", data: "set:brief:08:00" }], [{ text: "Pause", data: "cmd:pause" }]]); return true;
    case "/cap": {
      const v = Number(args);
      if (!Number.isFinite(v) || v <= 0 || v > 50) { await tg.send(chatId, `Daily model budget is USD ${(await capUsd(ctx)).toFixed(2)}. Change it with /cap 2`); return true; }
      await setSetting(ctx.db, "daily_cap_usd", String(v));
      await tg.send(chatId, `Daily model budget set to USD ${v.toFixed(2)}.`);
      return true;
    }
    case "/model": await modelCommand(ctx, tg, chatId, args); return true;
    case "/cancel": {
      for (const k of ["pending_edit", "import_wait", "import_buf", "import_plan", "skills_wait", "writing_wait", "km_idx", "km_mode", "dc_wait", "dc_seq", "mc", "import_seen", "import_prefs", "dc_after", "dc_prop"]) await setSetting(ctx.db, k, "");
      await tg.send(chatId, "Cancelled. Nothing is waiting on you now.");
      return true;
    }
    case "/check": await startMediaCheck(ctx, tg, chatId); return true;
    case "/rules": await startSequence(ctx, tg, chatId); return true;
    case "/nudges": {
      const on = args.trim().toLowerCase() !== "off";
      await setSetting(ctx.db, "meeting_nudges", on ? "1" : "0");
      await tg.send(chatId, on ? "Meeting heads-ups are on: about 15 minutes before meetings with people or a place." : "Meeting heads-ups are off.");
      return true;
    }
    default: return false;
  }
}

async function dataCommand(ctx: Ctx, tg: Telegram, chatId: number, cmd: string, args: string): Promise<boolean> {
  switch (cmd) {
    case "/export": await exportStart(ctx, tg, chatId); return true;
    case "/erase": {
      if (args.trim().toLowerCase() !== "everything") { await tg.send(chatId, "/erase everything wipes all I hold about you, after a warning and a typed confirmation. To remove one thing, use /forget. To keep a copy first, use /export."); return true; }
      await eraseWarning(ctx, tg, chatId);
      return true;
    }
    case "/limits": await tg.send(chatId, limitsText()); return true;
    case "/about": case "/support": await tg.send(chatId, aboutText(), [
      [{ text: "☕ Card or M-Pesa", data: "x", url: SUPPORT.card }],
      [{ text: "Copy Lightning address", data: "x", copy: SUPPORT.lightning }, { text: "Copy Bitcoin address", data: "x", copy: SUPPORT.bitcoin }],
      [{ text: "Brian on X", data: "x", url: AUTHOR.x }, { text: "GitHub", data: "x", url: AUTHOR.github }, { text: "Website", data: "x", url: AUTHOR.site }],
    ]); return true;
    case "/log": {
      const r = await ctx.db.prepare("SELECT ts, agent_role, model, sens, cost_usd, status FROM runs ORDER BY id DESC LIMIT 10").bind().all<{ ts: number; agent_role: string; model: string; sens: string; cost_usd: number; status: string }>();
      const fb = await feedbackSummary(ctx.db, thirtyDaysAgo(ctx.now));
      await tg.send(chatId, (r.results.length ? r.results.map((x) => `${fmtDate(x.ts, ctx.off).slice(0, 5)} ${fmtTime(x.ts, ctx.off)} ${x.agent_role} ${x.sens} ${(x.model || "-").split("/").pop()} $${Number(x.cost_usd).toFixed(4)} ${x.status}`).join("\n") : "Nothing logged yet.") + (fb ? `\n\n${fb}` : ""));
      return true;
    }
    case "/why": {
      const r = await ctx.db.prepare("SELECT ts, model, tokens_in, tokens_out, cost_usd, trace FROM runs ORDER BY id DESC LIMIT 1").bind().first<{ ts: number; model: string; tokens_in: number; tokens_out: number; cost_usd: number; trace: string }>();
      if (!r) { await tg.send(chatId, "Nothing to explain yet."); return true; }
      const t = JSON.parse(r.trace || "{}") as Record<string, unknown>;
      await tg.send(chatId, [`Last decision, ${fmtDateTime(r.ts, ctx.off)}`, `Role: ${String(t.role)}`, `Data class: ${String(t.sens)} (privacy setting sent to the model: ${String(t.provider_pref)})`, `Model: ${r.model}${t.deep ? " (deeper thinking)" : ""}`, `Actions taken: ${Array.isArray(t.actions) && t.actions.length ? (t.actions as string[]).join("; ") : "none"}`, `Tokens: ${r.tokens_in} in, ${r.tokens_out} out, cost USD ${Number(r.cost_usd).toFixed(4)}`, `Prompt version: ${String(t.prompt_version)}`].join("\n"));
      return true;
    }
    default: return false;
  }
}

async function memoryCommand(ctx: Ctx, tg: Telegram, chatId: number, cmd: string, args: string): Promise<boolean> {
  switch (cmd) {
    case "/memory": {
      if (args.trim().toLowerCase() === "consolidate") { await tg.typing(chatId); await tg.send(chatId, await consolidateNow(ctx)); return true; }
      await memoryHome(ctx, tg, chatId);
      return true;
    }
    case "/preferences": case "/prefs": await prefsHome(ctx, tg, chatId); return true;
    case "/skills": await skillsHome(ctx, tg, chatId); return true;
    case "/skill": await skillCommand(ctx, tg, chatId, args); return true;
    case "/import": await startPaste(ctx, tg, chatId); return true;
    case "/imports": await importsList(ctx, tg, chatId); return true;
    case "/undo": await undoCommand(ctx, tg, chatId, args); return true;
    case "/writing": await startWriting(ctx, tg, chatId); return true;
    case "/remember": {
      if (!args.trim()) { await tg.send(chatId, "Tell me what to remember, for example: /remember the rent is due on the 5th"); return true; }
      const id = await addFact(ctx.db, ctx.now, args, "other", "owner", true);
      await tg.send(chatId, id === null ? "I already knew that." : "Remembered. It's permanent until you /forget it.");
      return true;
    }
    case "/forget": {
      const hits = await findFacts(ctx.db, args);
      if (!hits.length) { await tg.send(chatId, "I hold no facts matching that. Conversation history is kept as your permanent record; a fact is what I remember about you." ); return true; }
      await tg.send(chatId, "Which should I forget?\n" + hits.map((h, i) => `${i + 1}. ${h.text}`).join("\n"), [hits.map((h, i) => ({ text: `Forget ${i + 1}`, data: `fg:${h.id}` }))]);
      return true;
    }
    case "/search": {
      if (!args.trim()) { await tg.send(chatId, "Search everything I remember, for example: /search school fees"); return true; }
      const hits = await recall(ctx.db, args, 8);
      await tg.send(chatId, hits.length ? hits.map((h) => `- ${fmtHit(h, ctx.off, 180)}`).join("\n") : "Nothing found. Try other words.");
      return true;
    }
    default: return false;
  }
}

async function calendarCommand(ctx: Ctx, tg: Telegram, chatId: number, cmd: string, args: string): Promise<boolean> {
  switch (cmd) {
    case "/agenda": {
      if (!(await hasCalendar(ctx))) { await tg.send(chatId, `No calendar is connected yet.\n\n${FEED_HELP}`); return true; }
      await syncIfStale(ctx);
      const day0 = startOfLocalDay(ctx.now, ctx.off);
      await tg.send(chatId, agendaText(await getEvents(ctx.db, day0, day0 + 2 * 86400000), ctx.now, ctx.off));
      return true;
    }
    case "/calendars": {
      const ch = await calendarChoices(ctx);
      if (!ch.length) { await tg.send(chatId, `No calendar is connected yet.\n\n${FEED_HELP}\n\nFor two-way Google sign-in instead, send /connect.`); return true; }
      const rows = ch.map((c, i) => [{ text: `${c.on ? "Turn off" : "Turn on"}: ${c.name}`.slice(0, 40), data: `cal:t:${i}` }, ...(c.id.startsWith("ical:") ? [{ text: "Remove", data: `cal:rm:${i}` }] : [])]);
      await tg.send(chatId, "Calendars I read (tap to switch one on or off):\n" + ch.map((c) => `- ${c.name}: ${c.on ? "on" : "off"}${c.id.startsWith("ical:") ? " (link)" : ""}`).join("\n") + "\n\nTo add another, paste its private iCal link here.", rows);
      return true;
    }
    case "/connect": {
      if (!googleConfigured(ctx.env)) { await tg.send(chatId, `Google sign-in is not set up yet. It takes about 8 minutes, once:\n1. In Google Cloud Console enable the Google Calendar API.\n2. Create an OAuth client (web application) with the redirect URI ${redirectUri(ctx.env)}\n3. Run ./deploy.sh google and paste the client id and secret.\nFull steps are in the vault under Rafiki - Personal Agent, 14-calendar-setup.`); return true; }
      const cred = await ctx.db.prepare("SELECT ts FROM credentials WHERE provider = 'google'").bind().first<{ ts: number }>();
      if (cred) {
        const last = Number((await getSetting(ctx.db, "cal_last_sync")) ?? 0);
        await tg.send(chatId, `Google Calendar is connected${last ? `, last synced ${fmtDateTime(last, ctx.off)}` : ""}. I sync every 15 minutes and read only.`, [[{ text: "Sync now", data: "cal:sync" }, { text: "Disconnect", data: "cal:disc" }]]);
        return true;
      }
      const { state, nonce } = await makeState(ctx.env, ctx.now);
      await setSetting(ctx.db, "oauth_nonce", nonce);
      await tg.send(chatId, "Tap to connect your Google Calendar. I only ask to read it, and you can disconnect any time with /disconnect.", [[{ text: "Connect Google Calendar", data: "x", url: authUrl(ctx.env, state) }]]);
      return true;
    }
    case "/disconnect": { await disconnect(ctx, tg, chatId); return true; }
    default: return false;
  }
}

async function lifeCommand(ctx: Ctx, tg: Telegram, chatId: number, cmd: string, args: string): Promise<boolean> {
  switch (cmd) {
    case "/place": { await tg.send(chatId, args.trim() ? await savePlace(ctx, args) : "Name a place after sharing your location, for example: /place home"); return true; }
    case "/places": {
      const pl = await ctx.db.prepare("SELECT name, lat, lng FROM places ORDER BY name").bind().all<{ name: string; lat: number; lng: number }>();
      await tg.send(chatId, pl.results.length ? "Places I know:\n" + pl.results.map((p) => `- ${p.name}`).join("\n") : "No places yet. Share your location, then send /place home.");
      return true;
    }
    case "/where": {
      const last = await ctx.db.prepare("SELECT ts, lat, lng FROM locations ORDER BY id DESC LIMIT 1").bind().first<{ ts: number; lat: number; lng: number }>();
      if (!last) { await tg.send(chatId, "I haven't had your location yet. Share it from the paperclip menu, or start live location."); return true; }
      const pl = (await ctx.db.prepare("SELECT name, lat, lng FROM places").bind().all<{ name: string; lat: number; lng: number }>()).results;
      await tg.send(chatId, `Last location, ${fmtDateTime(last.ts, ctx.off)}: ${describePlace(last, pl)}`);
      return true;
    }
    case "/brief": await tg.send(chatId, await buildBrief(ctx)); return true;
    case "/today": { await tg.typing(chatId); const r = await runAgent(ctx, "What are my top three for today, and which do I do first?"); await tg.send(chatId, r.text, r.buttons); return true; }
    case "/goals": {
      const g = await ctx.db.prepare("SELECT text, target, by_date FROM goals WHERE state = 'open' ORDER BY id").bind().all<{ text: string; target: string | null; by_date: string | null }>();
      await tg.send(chatId, g.results.length ? g.results.map((x, i) => `${i + 1}. ${x.text}${x.target ? ` (${x.target})` : ""}${x.by_date ? ` by ${x.by_date}` : ""}`).join("\n") : "No goals yet. Tell me one: what you want, how much, by when.");
      return true;
    }
    case "/ledger": {
      const l = await ctx.db.prepare("SELECT prospect, rung, next_ask FROM ledger ORDER BY rung DESC, last_move_ts DESC").bind().all<{ prospect: string; rung: number; next_ask: string | null }>();
      await tg.send(chatId, l.results.length ? "Customer ledger (rung 5 paid, 4 deposit, 3 commitment, 2 interest, 1 applause, 0 not a problem)\n" + l.results.map((x) => `- ${x.prospect}: rung ${x.rung}${x.next_ask ? `, next: ${x.next_ask}` : ""}`).join("\n") : "The ledger is empty. Tell me who you'll approach and what you'll ask for.");
      return true;
    }
    case "/money": await tg.send(chatId, await moneySummary(ctx)); return true;
    case "/fees": {
      if (!args.trim()) {
        const t = await loadTiers(ctx.db);
        await tg.send(chatId, t.length ? "Fee tables:\n" + t.map((x) => `- ${x.channel} ${x.min_cents / 100}-${Math.floor(x.max_cents / 100)}: ${kes(x.fee_cents)}`).join("\n") : "No fee tables yet. Set one from your own tariff, for example:\n/fees mpesa 1-100=0 101-500=7 501-1000=13");
        return true;
      }
      const p = parseFees(args);
      if (!p) { await tg.send(chatId, "I couldn't read that. Use: /fees mpesa 1-100=0 101-500=7 501-1000=13"); return true; }
      await ctx.db.prepare("DELETE FROM fee_tiers WHERE channel = ?").bind(p.channel).run();
      for (const t of p.tiers) await ctx.db.prepare("INSERT INTO fee_tiers (channel, min_cents, max_cents, fee_cents, set_ts) VALUES (?, ?, ?, ?, ?)").bind(t.channel, t.min_cents, t.max_cents, t.fee_cents, ctx.now).run();
      await tg.send(chatId, `Saved ${p.tiers.length} ${p.channel} fee bands, dated ${fmtDate(ctx.now, ctx.off)}. Fees are added to new entries only.`);
      return true;
    }
    default: return false;
  }
}

export async function command(ctx: Ctx, tg: Telegram, chatId: number, cmd: string, args: string): Promise<void> {
  for (const run of [systemCommand, dataCommand, memoryCommand, calendarCommand, lifeCommand]) if (await run(ctx, tg, chatId, cmd, args)) return;
  await tg.send(chatId, "I don't know that command. /help lists what I can do.");
}

export async function hasCalendar(ctx: Ctx): Promise<boolean> {
  const r = await ctx.db.prepare("SELECT COUNT(*) AS n FROM cal_cache").bind().first<{ n: number }>();
  return Number(r?.n ?? 0) > 0;
}
export async function consolidateNow(ctx: Ctx): Promise<string> {
  const res = await consolidateDay(ctx, startOfLocalDay(ctx.now, ctx.off));
  if (res.status === "ok") return `Summarised today and saved ${res.facts} new fact${res.facts === 1 ? "" : "s"}. This happens every night on its own.`;
  if (res.status === "skip") return "Nothing to summarise yet, or today is already summarised.";
  return "I could not write the summary just now. It will be retried tonight.";
}
export async function disconnect(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  const had = await dropGoogle(ctx);
  await tg.send(chatId, had ? "Disconnected, and Google has been told to revoke my access. I keep the summaries I already wrote." : "No calendar was connected.");
}
