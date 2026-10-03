// Worker entry: Telegram webhook, health check, and the 5-minute cron for reminders, the brief and the Monday check.
import type { Ctx } from "./agent.ts";
import { getSetting } from "./db.ts";
import { handleUpdate, offsetOf, type Env } from "./handler.ts";
import { maybeSync, meetingNudges } from "./calendar.ts";
import { maybeAskPreference } from "./learn.ts";
import { ensureSchema, handleSetup, webhookSecret } from "./setup.ts";
import { nightly } from "./consolidate.ts";
import { handleGoogleCallback } from "./oauth.ts";
import { maybeBrief, maybeMonday, sweepReminders } from "./schedule.ts";
import { Telegram, type TgUpdate } from "./telegram.ts";

interface WorkerEnv extends Env { DB: D1Database }

// Never pass the global fetch around bare: Workers requires it to be called with the global as this.
const netFetch = ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof fetch;

export default {
  async fetch(req: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      try {
        await env.DB.prepare("SELECT 1").bind().first();
        return Response.json({ ok: true, service: "rafiki" });
      } catch {
        return Response.json({ ok: false }, { status: 503 });
      }
    }
    if (url.pathname === "/setup" && (req.method === "GET" || req.method === "POST")) return handleSetup(req, env, env.DB, netFetch);
    if (req.method === "GET" && url.pathname === "/") return new Response("Rafiki is running. Open /setup on this address to finish installing.", { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (req.method === "GET" && url.pathname === "/oauth/google/callback") {
      const c: Ctx = { db: env.DB, env: { ...env, PUBLIC_URL: env.PUBLIC_URL || (await getSetting(env.DB, "public_url")) || "" }, f: netFetch, now: Date.now(), off: offsetOf(env) };
      return handleGoogleCallback(c, new Telegram(env.TELEGRAM_BOT_TOKEN, netFetch), url);
    }
    if (req.method === "POST" && url.pathname === "/tg") {
      const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
      const want = env.TELEGRAM_BOT_TOKEN && (env.TELEGRAM_WEBHOOK_SECRET || env.CLAIM_CODE) ? await webhookSecret(env) : "";
      if (!want || secret !== want) return new Response("unauthorized", { status: 401 });
      let update: TgUpdate;
      try { update = (await req.json()) as TgUpdate; } catch { return new Response("bad request", { status: 400 }); }
      // Acknowledge at once; the work continues after the response so Telegram never times out.
      ctx.waitUntil(handleUpdate({ db: env.DB, env, f: netFetch, now: Date.now() }, update).then(() => undefined, (e: unknown) => console.error("update failed:", e instanceof Error ? e.message : String(e))));
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(_ev: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      await ensureSchema(env.DB, 20).catch(() => undefined); // keeps the database current after an upgrade
      const owner = await getSetting(env.DB, "owner_chat_id").catch(() => null);
      if (!owner) return;
      const c: Ctx = { db: env.DB, env, f: netFetch, now: Date.now(), off: offsetOf(env) };
      const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, netFetch);
      const chatId = Number(owner);
      await sweepReminders(c, tg, chatId);
      await maybeBrief(c, tg, chatId);
      await maybeMonday(c, tg, chatId);
      await maybeSync(c, tg, chatId);
      await meetingNudges(c, tg, chatId);
      await maybeAskPreference(c, tg, chatId);
      await nightly(c);
    })().catch(() => undefined));
  },
};
