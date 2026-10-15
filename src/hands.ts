// Setting up hands (/hands), the end of onboarding (a short checklist), and /abilities: what this owner's Rafiki can and
// cannot do, written from what is actually connected, never from a brochure.
import type { Ctx } from "./agent.ts";
import { getSetting, setSetting } from "./db.ts";
import { gmailConnected } from "./gmail.ts";
import { googleConfigured } from "./google.ts";
import { notesConfigured, type NotesEnv } from "./notes.ts";
import type { BridgeEnv } from "./bridge.ts";
import type { Button, Telegram } from "./telegram.ts";
import { budget, dropHands, loadCatalogue, saveToken, syncCatalogue, zapToken, ZapAuthError, type Catalogue } from "./zapier.ts";

export const HANDS_HELP = `Hands let me act in your other apps (Gmail, Google Docs, Sheets, Tasks, Zoom, GitHub and thousands more) through Zapier. Zapier keeps your app logins; I only ever hold one connection token, and I never change anything without your tap.

About three minutes:
1. Open mcp.zapier.com and sign in. The free plan gives 100 tasks a month; I use at most 80 of them (40 actions) and stop there.
2. Add the apps you want me to use, and their actions. Start with finding and drafting; add sending later if you like.
3. Open Connect, choose "Other", generate a connection token and copy it.
4. Paste it here as your next message. I store it encrypted and delete your message.`;

export async function handsCommand(ctx: Ctx, tg: Telegram, chatId: number, args: string): Promise<void> {
  const a = args.trim();
  const bm = /^budget\s+(\d{1,4})$/i.exec(a);
  if (bm) { await setSetting(ctx.db, "zap_budget", bm[1]!); const b = await budget(ctx); await tg.send(chatId, `My Zapier budget is now ${b.max * 2} tasks a month (${b.max} actions). I warn you at ${b.warnAt} and stop at ${b.max}.`); return; }
  if (/^(off|disconnect|remove)$/i.test(a)) { await dropHands(ctx); await tg.send(chatId, "Hands disconnected. I deleted the token. Revoke it in Zapier too: mcp.zapier.com, Connect, rotate."); return; }
  if (a && !/^(sync|refresh)$/i.test(a)) { await takeToken(ctx, tg, chatId, a); return; }
  if (!(await zapToken(ctx))) {
    await setSetting(ctx.db, "zap_wait", "1");
    await tg.send(chatId, HANDS_HELP, [[{ text: "Open Zapier MCP", data: "x", url: "https://mcp.zapier.com" }], [{ text: "Not now", data: "hd:skip" }]]);
    return;
  }
  try {
    const cat = /^(sync|refresh)$/i.test(a) || !(await loadCatalogue(ctx)) ? await syncCatalogue(ctx) : (await loadCatalogue(ctx))!;
    const b = await budget(ctx);
    await tg.send(chatId, `${handsSummary(cat)}\n\nZapier actions used this month: ${b.used} of ${b.max} (${b.max * 2} tasks). /hands sync after you add apps in Zapier; /hands budget <tasks> changes my share; /hands off disconnects.`);
  } catch (e) {
    await tg.send(chatId, e instanceof ZapAuthError ? "Zapier refused my token. Generate a new one (mcp.zapier.com, Connect, Other) and send /hands <token>." : "I couldn't reach Zapier just now. Try /hands again in a minute.");
  }
}

/** A pasted token: kept encrypted, the message deleted, the catalogue learned, and the owner told what they now have. */
export async function takeToken(ctx: Ctx, tg: Telegram, chatId: number, token: string): Promise<void> {
  const t = token.trim();
  if (ctx.msgId) await tg.api("deleteMessage", { chat_id: chatId, message_id: ctx.msgId }).catch(() => undefined);
  if (t.length < 20 || /\s/.test(t)) { await tg.send(chatId, "That doesn't look like a Zapier connection token. Copy it again from mcp.zapier.com, Connect, Other."); return; }
  await setSetting(ctx.db, "zap_wait", "");
  await saveToken(ctx, t);
  await tg.typing(chatId);
  try {
    const cat = await syncCatalogue(ctx);
    await tg.send(chatId, `Hands connected. I deleted your message with the token.\n\n${handsSummary(cat)}`);
    await setSetting(ctx.db, "ob_connect", "1");
    if ((await getSetting(ctx.db, "ob_step")) === "done" && (await getSetting(ctx.db, "ob_finished")) !== "1") await nextSteps(ctx, tg, chatId);
  } catch (e) {
    await dropHands(ctx);
    await tg.send(chatId, e instanceof ZapAuthError ? "Zapier refused that token, so I didn't keep it. Generate a fresh one and paste it again." : "I couldn't reach Zapier with that token, so I didn't keep it. Try again in a minute.");
  }
}

const VERB = (name: string): string => name.toLowerCase().replace(/\b(google|gmail|zoom|github|zoho|linkedin|canva|buffer|whatsapp)\b/g, (m) => m[0]!.toUpperCase() + m.slice(1));

/** Per app: what I can look up straight away, and what I can do after your tap. */
export function handsSummary(cat: Catalogue): string {
  const by = new Map<string, { r: string[]; w: string[] }>();
  for (const a of cat.actions) { const e = by.get(a.app) ?? { r: [], w: [] }; (a.write ? e.w : e.r).push(VERB(a.name)); by.set(a.app, e); }
  const lines = [...by.entries()].map(([app, e]) => `• ${app}: ${[e.r.length ? `look up (${e.r.slice(0, 4).join(", ")}${e.r.length > 4 ? "…" : ""})` : "", e.w.length ? `after your tap: ${e.w.slice(0, 5).join(", ")}${e.w.length > 5 ? ` and ${e.w.length - 5} more` : ""}` : ""].filter(Boolean).join("; ")}`);
  return [`Through Zapier I can reach ${by.size} apps:`, ...lines, "I never delete anything or make raw API calls, even where Zapier could."].join("\n");
}

// ---- the end of onboarding ---------------------------------------------------------------------------------------------
const STEPS: [string, string, string][] = [
  ["ob_cards", "Calibrate how I work (ten taps)", "dc:seq"],
  ["ob_media", "Test my ears and eyes (voice, photo, file, location)", "mc:start"],
  ["ob_connect", "Connect your world: calendar, mail and hands", "hd:connect"],
];

/** A short checklist after the first chat. Every step is optional; the last one shows what this Rafiki can and cannot do. */
export async function nextSteps(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  const done: boolean[] = [];
  for (const [k] of STEPS) done.push((await getSetting(ctx.db, k)) === "1");
  const rows: Button[][] = STEPS.filter((_, i) => !done[i]).map(([, label, data]) => [{ text: label.split(" (")[0]!.split(":")[0]!, data }]);
  rows.push([{ text: "What can my Rafiki do?", data: "hd:abilities" }]);
  const left = done.filter((d) => !d).length;
  await tg.send(chatId, [left ? `${left === 3 ? "Three" : left === 2 ? "Two" : "One"} short step${left === 1 ? "" : "s"} left, each optional:` : "All set up.", ...STEPS.map(([, label], i) => `${done[i] ? "✓" : "○"} ${label}`), "", "Then I'll show you exactly what your Rafiki can and can't do."].join("\n"), rows);
}

/** "Connect your world": calendar, mail and hands on one screen, each one tap or one paste. */
export async function connectWorld(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  const { connectHub } = await import("./connections.ts");
  await connectHub(ctx, tg, chatId);
  const hands = !!(await zapToken(ctx));
  await tg.send(chatId, hands ? "Hands are connected. /hands shows what I can do in your apps." : `Hands: let me act in your apps through Zapier, always after your tap.\n\n${HANDS_HELP.split("\n\n")[1]}`, hands ? [[{ text: "Done connecting", data: "hd:connected" }]] : [[{ text: "Open Zapier MCP", data: "x", url: "https://mcp.zapier.com" }], [{ text: "I'll paste a token", data: "hd:wait" }, { text: "Skip for now", data: "hd:connected" }]]);
}

export async function handsCallback(ctx: Ctx, tg: Telegram, chatId: number, data: string): Promise<boolean> {
  if (!data.startsWith("hd:")) return false;
  if (data === "hd:connect") { await connectWorld(ctx, tg, chatId); return true; }
  if (data === "hd:wait") { await setSetting(ctx.db, "zap_wait", "1"); await tg.send(chatId, "Paste the connection token as your next message."); return true; }
  if (data === "hd:skip") { await setSetting(ctx.db, "zap_wait", ""); await tg.send(chatId, "OK. /hands any time."); return true; }
  if (data === "hd:connected") { await setSetting(ctx.db, "ob_connect", "1"); await setSetting(ctx.db, "zap_wait", ""); await nextSteps(ctx, tg, chatId); return true; }
  if (data === "hd:abilities") { await setSetting(ctx.db, "ob_finished", "1"); await tg.send(chatId, await abilitiesText(ctx)); return true; }
  return false;
}

// ---- /abilities ----------------------------------------------------------------------------------------------------------
export async function abilitiesText(ctx: Ctx): Promise<string> {
  const cred = await ctx.db.prepare("SELECT provider FROM credentials").bind().all<{ provider: string }>();
  const has = (p: string): boolean => cred.results.some((r) => r.provider === p || r.provider.startsWith(p));
  const google = googleConfigured(ctx.env) && has("google");
  const gmail = google && (await gmailConnected(ctx));
  const cat = (await zapToken(ctx)) ? await loadCatalogue(ctx) : null;
  const apps = cat ? [...new Set(cat.actions.map((a) => a.app))] : [];
  const can = [
    "Remember what you tell me, search it, and forget anything you ask",
    "Remind you in plain words (\"in 2 days, morning hours\"), with a file attached if you like, and chase until Done",
    "Keep one priority in front of you each day, and close the day with you",
    "Hear voice notes, read photos, PDFs, files and links, and explain them simply",
  ];
  if (google || has("ical")) can.push(`Read your calendar${google ? " (Google)" : ""}${has("ical") ? " and your calendar links" : ""}, warn you of clashes and meetings`);
  if (gmail) can.push("Read unread mail in your Gmail Primary inbox (brief line and /inbox)");
  if (notesConfigured(ctx.env as unknown as NotesEnv)) can.push("Search your Obsidian notes");
  const env = ctx.env as unknown as BridgeEnv;
  if (env.CLAUDE_ROUTINE_ID && env.CLAUDE_ROUTINE_TOKEN) can.push("Hand a coding task to Claude Code after you confirm");
  const lines = ["What your Rafiki can do, as set up today:", ...can.map((c) => `✓ ${c}`)];
  if (cat) { const b = await budget(ctx); lines.push("", handsSummary(cat), `Zapier actions used this month: ${b.used} of ${b.max}.`); }
  const cannot = [
    "Send, post, change or create anything in another app without your tap" + (cat ? "" : " (and without hands it cannot act in other apps at all)"),
    "Delete anything in your apps, or move or spend money",
    "See apps you haven't connected" + (apps.length ? ` (connected through Zapier: ${apps.length})` : "") + ", your WhatsApp or SMS",
    "Take instructions from emails, web pages or files: they are information, never orders",
  ];
  if (!google && !has("ical")) cannot.push("See your calendar yet: /connect");
  if (!gmail) cannot.push("Read your email yet" + (google ? ": /connect, Add Gmail" : ": /connect"));
  lines.push("", "What it can't do:", ...cannot.map((c) => `✗ ${c}`), "", "Try one:");
  const tries = ["\"remind me to call John in 2 days, morning hours\"", "send me any link and ask \"explain this\""];
  if (cat?.actions.some((a) => a.tool === "gmail_create_draft")) tries.unshift("\"draft an email to ... saying ...\" (you approve before it saves)");
  if (cat?.actions.some((a) => a.tool === "google_tasks_create_task")) tries.push("\"add 'renew passport' to my Google Tasks\"");
  lines.push(...tries.slice(0, 3).map((t) => `• ${t}`), "", "The full list of limits is in /limits. /abilities shows this again.");
  return lines.join("\n");
}
