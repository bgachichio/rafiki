// /connect: one screen that shows every connection, what it gives, and the one tap or line that adds it.
import type { Ctx } from "./agent.ts";
import { inboundKey, type BridgeEnv } from "./bridge.ts";
import { getSetting, setSetting } from "./db.ts";
import { gmailConnected, SCOPE_GMAIL, unreadPrimary } from "./gmail.ts";
import { authUrl, googleConfigured, makeState, redirectUri } from "./google.ts";
import { randomHex } from "./crypto.ts";
import type { Button, Telegram } from "./telegram.ts";
import { fmtDateTime } from "./time.ts";

export async function inboundUrl(ctx: Ctx): Promise<string> {
  return `${ctx.env.PUBLIC_URL}/in/${await inboundKey(ctx.env as unknown as BridgeEnv, (await getSetting(ctx.db, "inbound_salt")) ?? "")}`;
}

async function googleLink(ctx: Ctx, gmail: boolean): Promise<string> {
  const { state, nonce } = await makeState(ctx.env, ctx.now);
  await setSetting(ctx.db, "oauth_nonce", nonce);
  await setSetting(ctx.db, "oauth_scopes", gmail ? "calendar.readonly gmail.readonly" : "calendar.readonly");
  return authUrl(ctx.env, state, gmail ? [SCOPE_GMAIL] : []);
}

export async function connectHub(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  const lines = ["Connections. Everything is read-only unless it says otherwise, and each one can be removed."];
  const rows: Button[][] = [];
  if (!googleConfigured(ctx.env)) {
    lines.push(`\nGoogle Calendar and Gmail: not set up. Once, about 8 minutes: in Google Cloud Console enable the Calendar API (and the Gmail API for mail), create an OAuth client (web application) with redirect URI ${redirectUri(ctx.env)}, publish the app to Production (Testing mode signs you out every 7 days), then run ./deploy.sh google.`);
  } else {
    const cred = await ctx.db.prepare("SELECT ts FROM credentials WHERE provider = 'google'").bind().first<{ ts: number }>();
    const gm = cred ? await gmailConnected(ctx) : false;
    const last = Number((await getSetting(ctx.db, "cal_last_sync")) ?? 0);
    lines.push(cred ? `\nGoogle Calendar: connected${last ? `, last synced ${fmtDateTime(last, ctx.off)}` : ""}.` : "\nGoogle Calendar: not connected. One tap, one consent screen.");
    lines.push(gm ? "Gmail: connected. Unread mail in Primary shows in your brief; /inbox lists it." : "Gmail: not connected. Adds one line to your brief with the unread mail that needs you. Read-only: I never send, delete or label.");
    if (cred) rows.push([{ text: "Sync calendar", data: "cal:sync" }, { text: "Disconnect Google", data: "cal:disc" }]);
    else rows.push([{ text: "Connect Google Calendar", data: "x", url: await googleLink(ctx, false) }]);
    if (!gm) rows.push([{ text: cred ? "Add Gmail (read-only)" : "Calendar + Gmail", data: "x", url: await googleLink(ctx, true) }]);
  }
  const feeds = await ctx.db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE provider LIKE 'ical:%'").bind().first<{ n: number }>().catch(() => null);
  lines.push(`\nCalendar links (iCloud, Outlook, Google, any app): ${Number(feeds?.n ?? 0)} added. Paste a private iCal link here any time; /calendars manages them.`);
  const url = await inboundUrl(ctx);
  lines.push(`\nAutomations (Zapier, Make, n8n, IFTTT, Apple Shortcuts, Google Apps Script): send a POST with JSON {"title","text","from","url"} to your private address. I read each item, tell you what needs you, and can propose a reminder or task. Keep the address secret; "New address" replaces it.`);
  rows.push([{ text: "Copy automation address", data: "x", copy: url }, { text: "New address", data: "in:rotate" }]);
  const allow = (await getSetting(ctx.db, "email_allow")) ?? "";
  lines.push(`\nEmail in: forward mail to the address you route to this Worker in Cloudflare Email Routing. I only read mail from senders you allow (${allow ? allow : "none yet"}): /email allow you@gmail.com`);
  const env = ctx.env as unknown as BridgeEnv;
  lines.push(env.CLAUDE_ROUTINE_ID && env.CLAUDE_ROUTINE_TOKEN ? "\nClaude Code: connected. /code <task> starts a cloud session after you confirm." : "\nClaude Code: not set up. /code shows the 5-minute set-up.");
  await tg.send(chatId, lines.join("\n"), rows);
}

export async function connectCallback(ctx: Ctx, tg: Telegram, chatId: number, data: string): Promise<boolean> {
  if (data !== "in:rotate") return false;
  await setSetting(ctx.db, "inbound_salt", randomHex(8));
  await tg.send(chatId, "New automation address made. The old one stops working now. Update your automations:", [[{ text: "Copy new address", data: "x", copy: await inboundUrl(ctx) }]]);
  return true;
}

export async function emailCommand(ctx: Ctx, tg: Telegram, chatId: number, args: string): Promise<void> {
  const m = /^(allow|remove)\s+(\S+)$/i.exec(args.trim());
  const list = new Set(((await getSetting(ctx.db, "email_allow")) ?? "").split(/[,\s]+/).filter(Boolean));
  if (m && /^(@[\w.-]+\.[a-z]{2,}|[^@\s]+@[\w.-]+\.[a-z]{2,})$/i.test(m[2]!)) {
    const a = m[2]!.toLowerCase();
    if (m[1]!.toLowerCase() === "allow") list.add(a); else list.delete(a);
    await setSetting(ctx.db, "email_allow", [...list].join(","));
  }
  await tg.send(chatId, `I read forwarded mail only from: ${list.size ? [...list].join(", ") : "nobody yet"}.\n/email allow you@gmail.com adds an address; /email allow @yourcompany.com adds a whole domain; /email remove ... takes one away. Gmail's forwarding confirmation always gets through, so you can finish set-up.`);
}

export async function inboxCommand(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  try {
    const u = await unreadPrimary(ctx, 6);
    if (!u) { await tg.send(chatId, "Gmail isn't connected. /connect adds it, read-only."); return; }
    if (!u.total) { await tg.send(chatId, "Nothing unread in Primary from the last two days."); return; }
    await tg.send(chatId, [`Unread in Primary (last two days): ${u.total}${u.total >= 20 ? "+" : ""}`, ...u.mails.map((m, i) => `${i + 1}. ${m.from}: ${m.subject}\n   ${m.snippet}`), "Forward me any one (or tell me which) and I'll draft the reply for you to send."].join("\n"));
  } catch {
    await tg.send(chatId, "I couldn't read Gmail just now. If it keeps failing, /connect and reconnect Google.");
  }
}
