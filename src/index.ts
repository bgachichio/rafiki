// Worker entry: Telegram webhook, health check, and the 5-minute cron for reminders, the brief and the Monday check.
import { withModelOverrides, type Ctx } from "./agent.ts";
import { getSetting } from "./db.ts";
import { handleUpdate, offsetOf, skinReader, type Env } from "./handler.ts";
import { runJobs } from "./jobs.ts";
import { ensureSchema, handleSetup, timingSafeEqual, webhookSecret } from "./setup.ts";
import { handleGoogleCallback } from "./oauth.ts";
import { Telegram, type TgUpdate } from "./telegram.ts";
import { handleEmail, handleInboundHttp, inboundKey, type EmailMsg } from "./bridge.ts";

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
      if (!want || !timingSafeEqual(secret, want)) return new Response("unauthorized", { status: 401 });
      let update: TgUpdate;
      try { update = (await req.json()) as TgUpdate; } catch { return new Response("bad request", { status: 400 }); }
      // Do the work before answering. Work left to waitUntil is cut off 30 seconds after the response, which silently killed
      // voice notes and files (download, transcribe, think, reply). Telegram waits; a retried update is dropped by markSeen.
      try { await handleUpdate({ db: env.DB, env, f: netFetch, now: Date.now() }, update); } catch (e) { console.error("update failed:", e instanceof Error ? e.message : String(e)); }
      return new Response("ok");
    }
    const inbound = /^\/in\/([0-9a-f]{32})$/.exec(url.pathname);
    if (req.method === "POST" && inbound) {
      const owner = await getSetting(env.DB, "owner_chat_id").catch(() => null);
      const want = await inboundKey(env, (await getSetting(env.DB, "inbound_salt").catch(() => null)) ?? "");
      if (!owner || !timingSafeEqual(inbound[1]!, want)) return new Response("not found", { status: 404 });
      const c: Ctx = { db: env.DB, env: await withModelOverrides(env.DB, env), f: netFetch, now: Date.now(), off: offsetOf(env) };
      return handleInboundHttp(req, c, new Telegram(env.TELEGRAM_BOT_TOKEN, netFetch), Number(owner));
    }
    return new Response("not found", { status: 404 });
  },

  /** Mail routed to this Worker by Cloudflare Email Routing. Only senders the owner allowed are read. */
  async email(message: EmailMsg, env: WorkerEnv): Promise<void> {
    const owner = await getSetting(env.DB, "owner_chat_id").catch(() => null);
    if (!owner) return;
    const c: Ctx = { db: env.DB, env: await withModelOverrides(env.DB, env), f: netFetch, now: Date.now(), off: offsetOf(env) };
    await handleEmail(message, c, new Telegram(env.TELEGRAM_BOT_TOKEN, netFetch), Number(owner)).catch((e: unknown) => console.error("email failed:", e instanceof Error ? e.message : String(e)));
  },

  async scheduled(_ev: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      await ensureSchema(env.DB, 20).catch(() => undefined); // keeps the database current after an upgrade
      const owner = await getSetting(env.DB, "owner_chat_id").catch(() => null);
      if (!owner) return;
      const c: Ctx = { db: env.DB, env, f: netFetch, now: Date.now(), off: offsetOf(env) };
      const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, netFetch);
      tg.skin = skinReader(env.DB);
      await runJobs(c, tg, Number(owner));
    })().catch(() => undefined));
  },
};
