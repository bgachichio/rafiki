// The /setup page: runs once after the Deploy button, and again any time to refresh. It is served by the customer's own Worker,
// so the bot token and AI key never pass through anyone else. It needs the setup word the customer chose (CLAIM_CODE).
import { getSetting, setSetting, type Db } from "./db.ts";
import { ALLOWED_UPDATES, BOT_DESCRIPTION, BOT_SHORT, COMMANDS } from "./commands.ts";
import { MARK_PNG_BASE64 } from "./assets/mark.gen.ts";
import { SCHEMA_SQL } from "./schema.gen.ts";
import { AUTHOR } from "./support.ts";
import { Telegram, type Fetch } from "./telegram.ts";

export interface SetupEnv { TELEGRAM_BOT_TOKEN: string; OPENROUTER_API_KEY?: string; CLAIM_CODE: string; TELEGRAM_WEBHOOK_SECRET?: string }

const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (t: string): Promise<string> => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
export function timingSafeEqual(a: string, b: string): boolean { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

/** The header Telegram must send. An explicit secret (the owner's own deployment) wins; otherwise it is derived from the token and setup word. */
export async function webhookSecret(env: SetupEnv): Promise<string> {
  return env.TELEGRAM_WEBHOOK_SECRET || (await sha(`rafiki-webhook|${env.TELEGRAM_BOT_TOKEN}|${env.CLAIM_CODE}`)).slice(0, 48);
}

export function splitSql(sql: string): string[] {
  return sql.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join("\n").split(/;[ \t]*\n/).map((s) => s.trim().replace(/;$/, "")).filter(Boolean);
}
export const SCHEMA_STATEMENTS = splitSql(SCHEMA_SQL);
export const schemaHash = async (): Promise<string> => (await sha(SCHEMA_SQL)).slice(0, 16);

/** Apply schema.sql a chunk at a time (D1 allows 50 queries per request on the free plan). Safe to repeat. */
export async function ensureSchema(db: Db, max = 20): Promise<{ done: boolean; at: number; of: number }> {
  const of = SCHEMA_STATEMENTS.length;
  let at = 0;
  try {
    if ((await getSetting(db, "schema_hash")) === (await schemaHash())) return { done: true, at: of, of };
    at = Number((await getSetting(db, "schema_pos")) ?? 0) || 0;
  } catch { at = 0; } // the settings table does not exist yet: the first statement creates it
  const end = Math.min(of, at + max);
  for (let i = at; i < end; i++) await db.prepare(SCHEMA_STATEMENTS[i]!).bind().run();
  if (end >= of) { await setSetting(db, "schema_hash", await schemaHash()); await setSetting(db, "schema_pos", "0"); return { done: true, at: of, of }; }
  await setSetting(db, "schema_pos", String(end));
  return { done: false, at: end, of };
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'", "x-frame-options": "DENY", "referrer-policy": "no-referrer" };

function page(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
:root{--bg:#f6f7f4;--fg:#1c2421;--mut:#5a665f;--card:#fff;--acc:#2f6f5e;--bad:#a33}
@media(prefers-color-scheme:dark){:root{--bg:#121816;--fg:#e8ede9;--mut:#9aa7a0;--card:#1b2320;--acc:#6fbf9f;--bad:#f08080}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:34rem;margin:0 auto;padding:2rem 1rem}img.mark{width:84px;height:84px;border-radius:20px;display:block;margin:0 auto 1rem}
h1{font-size:1.5rem;text-align:center;margin:.2rem 0 1rem}.card{background:var(--card);border-radius:14px;padding:1rem 1.2rem;margin:1rem 0}
input[type=password],input[type=text]{width:100%;box-sizing:border-box;padding:.7rem;border-radius:10px;border:1px solid var(--mut);background:var(--bg);color:var(--fg);font-size:1rem}
button,a.btn{display:inline-block;margin-top:.8rem;padding:.7rem 1.1rem;border-radius:999px;border:0;background:var(--acc);color:#fff;font-size:1rem;text-decoration:none;cursor:pointer}
li{margin:.3rem 0;list-style:none}.ok::before{content:"✓ ";color:var(--acc)}.no::before{content:"✗ ";color:var(--bad)}footer{text-align:center;color:var(--mut);font-size:.85rem;margin-top:2rem}footer a{color:var(--mut)}
</style></head><body><main><img class="mark" alt="" src="data:image/png;base64,${MARK_PNG_BASE64}"><h1>${esc(title)}</h1>${body}<footer>Made with ❤️ by <a href="${AUTHOR.x}">${esc(AUTHOR.name)}</a> · <a href="${AUTHOR.github}">GitHub</a></footer></main></body></html>`, { status, headers: HEADERS });
}
const form = (note = "", word = ""): string => `<div class="card">${note ? `<p>${note}</p>` : ""}<form method="post" action="/setup"><p><label for="w">Your setup word</label></p><input id="w" name="word" type="password" autocomplete="off" required value="${esc(word)}"><button>${word ? "Continue" : "Set up my Rafiki"}</button></form></div>`;

export async function handleSetup(req: Request, env: SetupEnv, db: Db, f: Fetch): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "POST") return page("Set up your Rafiki", `<p>Type the setup word you chose when you deployed. It proves this Rafiki is yours. Nothing you type here leaves your own Cloudflare account.</p>${form()}`);
  const data = await req.formData().catch(() => null);
  const word = String(data?.get("word") ?? "");
  await ensureSchema(db, 1).catch(() => undefined); // the first statement creates the settings table, so failed attempts can be counted
  const [n, ts] = String((await getSetting(db, "setup_fail").catch(() => null)) ?? "0,0").split(",").map(Number) as [number, number];
  const now = Date.now();
  if (n >= 5 && now - ts < 10 * 60000) return page("Too many tries", `<div class="card"><p>Please wait ten minutes and try again.</p></div>`, 429);
  if (!env.CLAIM_CODE || !timingSafeEqual(word, env.CLAIM_CODE)) {
    await setSetting(db, "setup_fail", `${n >= 5 && now - ts >= 10 * 60000 ? 1 : n + 1},${now}`).catch(() => undefined);
    return page("Set up your Rafiki", form("That is not the setup word. Use the one you typed when you deployed."), 403);
  }
  await setSetting(db, "setup_fail", "0,0");
  const steps: { ok: boolean; text: string }[] = [];
  const schema = await ensureSchema(db, 20).then((r) => (r.done ? r : ensureSchema(db, 20))).catch((e: unknown) => ({ done: false, at: -1, of: 0, err: e instanceof Error ? e.message : "error" }));
  if (!schema.done) {
    return page("Almost there", `<div class="card"><p>${"err" in schema ? "The database could not be prepared. Try again in a minute." : `Preparing your database (${schema.at} of ${schema.of}).`}</p>${form("", word)}</div>`);
  }
  steps.push({ ok: true, text: "Your private database is ready" });
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, f);
  const me = await tg.api("getMe", {});
  const bot = me.ok ? (me.result as { username?: string; first_name?: string }) : null;
  steps.push({ ok: !!bot, text: bot ? `Telegram accepted your bot token (@${bot.username})` : "Telegram did not accept the bot token. Copy it again from BotFather and redeploy." });
  const orOk = env.OPENROUTER_API_KEY ? await f("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` } }).then((r) => r.ok).catch(() => false) : false;
  steps.push({ ok: orOk, text: orOk ? "OpenRouter accepted your AI key" : "OpenRouter did not accept the AI key. Create a new one at openrouter.ai/settings/keys and redeploy." });
  if (bot) {
    const hook = await tg.api("setWebhook", { url: `${url.origin}/tg`, secret_token: await webhookSecret(env), allowed_updates: ALLOWED_UPDATES });
    steps.push({ ok: hook.ok, text: hook.ok ? "Telegram is connected to your Worker" : "Telegram would not connect to your Worker" });
    await tg.api("setMyCommands", { commands: COMMANDS });
    await tg.api("setMyShortDescription", { short_description: BOT_SHORT });
    await tg.api("setMyDescription", { description: BOT_DESCRIPTION });
    steps.push({ ok: true, text: "The command menu and the credits are in place" });
    if ((await getSetting(db, "setup_photo")) !== "1") {
      const png = Uint8Array.from(atob(MARK_PNG_BASE64), (c) => c.charCodeAt(0));
      const ok = await tg.setProfilePhoto(png).catch(() => false);
      if (ok) await setSetting(db, "setup_photo", "1");
      steps.push({ ok, text: ok ? "The mandrill is now your bot's photo" : "I could not set the bot's photo. You can upload it in BotFather with /setuserpic." });
    }
    await setSetting(db, "bot_name", bot.first_name ?? "Rafiki");
    await setSetting(db, "bot_username", bot.username ?? "");
    await setSetting(db, "public_url", url.origin);
  }
  const good = steps.every((s) => s.ok) && !!bot;
  const owned = !!(await getSetting(db, "owner_chat_id"));
  const link = bot ? `https://t.me/${bot.username}?start=${encodeURIComponent(env.CLAIM_CODE)}` : "";
  return page(good ? "Your Rafiki is ready" : "Nearly there", `<div class="card"><ul>${steps.map((s) => `<li class="${s.ok ? "ok" : "no"}">${esc(s.text)}</li>`).join("")}</ul></div>${good ? `<div class="card"><p>${owned ? "This Rafiki is already yours. Everything above is refreshed." : "Last step: open Telegram and press Start. That makes you the owner, and nobody else can use your bot."}</p><a class="btn" href="${esc(link)}">Open Telegram and say hello</a></div>` : `<div class="card"><p>Fix what is marked ✗, then try again.</p><a class="btn" href="/setup">Try again</a></div>`}`);
}
