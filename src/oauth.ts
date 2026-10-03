// The Google sign-in return trip. The only public GET route; it accepts nothing without a valid, unused, unexpired state.
import type { Ctx } from "./agent.ts";
import { syncCalendar } from "./calendar.ts";
import { encrypt, keyOf } from "./crypto.ts";
import { getSetting, setSetting } from "./db.ts";
import { checkState, exchangeCode, googleConfigured } from "./google.ts";
import { Telegram } from "./telegram.ts";

const page = (title: string, body: string, status = 200): Response =>
  new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem"><h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });

export async function handleGoogleCallback(ctx: Ctx, tg: Telegram, url: URL): Promise<Response> {
  const { db, env, f, now } = ctx;
  if (!googleConfigured(env)) return page("Not set up", "Google sign-in is not configured for Rafiki.", 404);
  if (url.searchParams.get("error")) return page("Not connected", "Google sign-in was cancelled. Go back to Telegram and send /connect to try again.", 400);
  const code = url.searchParams.get("code") ?? "";
  const nonce = await checkState(env, url.searchParams.get("state") ?? "", now);
  const expected = await getSetting(db, "oauth_nonce");
  if (!code || !nonce || !expected || nonce !== expected) return page("Link expired", "This sign-in link is not valid any more. Go back to Telegram and send /connect for a new one.", 400);
  await setSetting(db, "oauth_nonce", ""); // single use
  try {
    const t = await exchangeCode(env, f, code);
    const enc = await encrypt(await keyOf(env), JSON.stringify({ refresh_token: t.refreshToken }));
    await db.prepare("INSERT INTO credentials (provider, enc, meta, ts) VALUES ('google', ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET enc = excluded.enc, meta = excluded.meta, ts = excluded.ts").bind(enc, JSON.stringify({ scope: "calendar.readonly" }), now).run();
    const r = await syncCalendar(ctx);
    const owner = Number((await getSetting(db, "owner_chat_id")) ?? 0);
    if (owner) {
      await tg.send(owner, r.status === "ok"
        ? `Google Calendar connected. I can see ${r.events} events across ${r.calendars} calendars for the next two weeks. Try /agenda. I read your calendar only, and I'll warn you before meetings that have people or a place.`
        : "Google Calendar is connected, but the first sync did not complete. I'll retry in a few minutes.");
    }
    return page("Connected", "Rafiki can now read your calendar. You can close this tab and go back to Telegram.");
  } catch {
    return page("Something went wrong", "Google did not complete the sign-in. Go back to Telegram and send /connect to try again.", 502);
  }
}
