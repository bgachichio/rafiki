#!/usr/bin/env bash
# Rafiki: one command, three pastes. Safe to re-run. Secrets are read without echo, passed to Wrangler on stdin
# and to Node through the environment, and are never written to a file, an argument list or the screen.
set -euo pipefail
cd "$(dirname "$0")"
CFG="${WRANGLER_CONFIG:-wrangler.toml}" # a private config (database id, address) can live in an ignored file such as wrangler.local.toml
WR="npx --no-install wrangler -c $CFG"
step() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }

# Node helper for every Telegram and OpenRouter call. Secrets arrive through the environment only.
tgjs() { node --input-type=module -e '
const mode = process.argv[1];
const TG = process.env.TG_TOKEN, OR = process.env.OR_KEY;
const j = async (u, o) => {
  let err;
  for (let i = 0; i < 5; i++) {
    try { const r = await fetch(u, { ...o, signal: AbortSignal.timeout(20000) }); return await r.json().catch(() => ({})); }
    catch (e) { err = e; await new Promise((res) => setTimeout(res, 4000)); }
  }
  console.error("network problem reaching " + new URL(u).host + ": " + (err && err.cause && err.cause.code || err)); process.exit(3);
};
const api = (m, body) => j(`https://api.telegram.org/bot${TG}/${m}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
if (mode === "getme") { const r = await api("getMe"); if (!r.ok) { console.log("FAIL"); process.exit(2); } console.log(r.result.username); }
else if (mode === "orkey") { const r = await j("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${OR}` } }); if (!r.data) { console.log("FAIL"); process.exit(2); } const d = r.data; console.log(`limit=${d.limit ?? "none"} used=${d.usage ?? 0} remaining=${d.limit_remaining ?? "n/a"} free_tier=${d.is_free_tier ?? "n/a"}`); }
else if (mode === "webhook") {
  const r = await api("setWebhook", { url: process.env.HOOK_URL, secret_token: process.env.HOOK_SECRET, allowed_updates: ["message", "edited_message", "callback_query", "poll_answer"], drop_pending_updates: true });
  if (!r.ok) { console.log("FAIL " + JSON.stringify(r)); process.exit(2); }
  await api("setMyCommands", { commands: [
    { command: "today", description: "Top three for today" }, { command: "memory", description: "See and change what I remember" }, { command: "preferences", description: "See and change your preferences" }, { command: "skills", description: "Your skills files" }, { command: "model", description: "Choose the AI model" }, { command: "agenda", description: "Today and tomorrow" }, { command: "calendars", description: "Choose which calendars I read" }, { command: "where", description: "Your last shared location" }, { command: "place", description: "Name your last location" }, { command: "import", description: "Bring in context from another AI" }, { command: "export", description: "Download everything I hold about you" }, { command: "erase", description: "Wipe everything I hold (asks first)" }, { command: "limits", description: "What I cannot do" }, { command: "about", description: "Credits and support" }, { command: "brief", description: "Your brief now" }, { command: "goals", description: "Your goals" },
    { command: "ledger", description: "Customer ledger" }, { command: "money", description: "Spend summary" }, { command: "fees", description: "Set your transaction fee tables" },
    { command: "settings", description: "Brief time, quiet hours, budget" }, { command: "log", description: "What I did, and what it cost" }, { command: "why", description: "Why I did my last thing" },
    { command: "pause", description: "Stop me acting" }, { command: "resume", description: "Start me again" }, { command: "help", description: "What I can do" } ] });
  await api("setMyShortDescription", { short_description: "Your chief of staff, adviser, coach and business partner. It asks before it acts." });
  await api("setMyDescription", { description: "Rafiki is a personal agent. Tell it what is slipping and what you are working toward. It reminds, drafts, plans and coaches, and it asks before it acts.\n\nMade with ❤️ by Brian Gachichio (x.com/b_gachichio). Open source: github.com/bgachichio/rafiki" });
  console.log("ok");
}
else if (mode === "info") { const r = await api("getWebhookInfo"); const i = r.result || {}; console.log(`url_set=${!!i.url} pending=${i.pending_update_count ?? 0} last_error=${i.last_error_message ?? "none"}`); }
' "$1"; }


URL_BASE=$(grep -E '^PUBLIC_URL' "$CFG" | sed -E 's/.*"(.*)".*/\1/')
google_setup() {
  step "Google Calendar (optional; press Enter at the first prompt to skip)"
  echo "Redirect URI to register on your Google OAuth client: $URL_BASE/oauth/google/callback"
  GJSON=$(ls -t "$HOME"/Downloads/client_secret*.json 2>/dev/null | head -1 || true)
  GID=""; GSEC=""
  if [ -n "$GJSON" ]; then
    read -rp "Found $GJSON. Use it? [Y/n] " use
    if [[ "${use:-Y}" != [nN]* ]]; then
      GID=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const w=j.web||j.installed||{};process.stdout.write(w.client_id||"")' "$GJSON")
      GSEC=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const w=j.web||j.installed||{};process.stdout.write(w.client_secret||"")' "$GJSON")
    fi
  fi
  if [ -z "$GID" ]; then
    read -rp "Google OAuth Client ID (Enter to skip): " GID
    [ -n "$GID" ] || { echo "skipped"; return 0; }
    read -rsp "Google OAuth Client secret (hidden): " GSEC; echo
  fi
  [ -n "$GSEC" ] || die "No client secret found."
  printf '%s' "$GID" | $WR secret put GOOGLE_CLIENT_ID >/dev/null
  printf '%s' "$GSEC" | $WR secret put GOOGLE_CLIENT_SECRET >/dev/null
  if ! $WR secret list --format json 2>/dev/null | grep -q '"ENCRYPTION_KEY"'; then
    openssl rand -hex 32 | tr -d '\n' | $WR secret put ENCRYPTION_KEY >/dev/null
    echo "encryption key created (it protects stored Google tokens; do not rotate it casually)"
  fi
  if [ -n "${GJSON:-}" ] && [ -f "$GJSON" ]; then shred -u "$GJSON" 2>/dev/null && echo "The downloaded client file was securely deleted (the secret now lives only in Cloudflare)."; fi
  unset GID GSEC
  echo "Google settings stored. In Telegram, send /connect."
}

if [ "${1:-}" = "webhook" ]; then
  [ -d node_modules ] || npm ci --silent
  [ -n "$URL_BASE" ] || read -rp "Your Worker address (for example https://rafiki.yourname.workers.dev): " URL_BASE
  read -rsp "Paste the Telegram bot token, then Enter: " TG_TOKEN; echo
  BOT=$(TG_TOKEN="$TG_TOKEN" tgjs getme) || die "Telegram rejected that token."
  HOOK_SECRET=$(openssl rand -hex 24)
  # Register with Telegram first. If that fails nothing has changed, so the bot keeps working. Only then store the matching secret.
  TG_TOKEN="$TG_TOKEN" HOOK_URL="$URL_BASE/tg" HOOK_SECRET="$HOOK_SECRET" tgjs webhook | grep -q '^ok' || die "Telegram did not accept the webhook. Nothing was changed; run ./deploy.sh webhook again."
  printf '%s' "$HOOK_SECRET" | $WR secret put TELEGRAM_WEBHOOK_SECRET >/dev/null || die "Webhook registered but the secret was not stored. Run ./deploy.sh webhook again now."
  TG_TOKEN="$TG_TOKEN" tgjs info
  unset TG_TOKEN HOOK_SECRET
  echo "Webhook and command list refreshed for @$BOT. Nothing else changed."
  exit 0
fi

if [ "${1:-}" = "google" ]; then
  [ -d node_modules ] || npm ci --silent
  $WR deploy >/dev/null 2>&1 || die "Deploy failed; run: npx wrangler deploy"
  google_setup
  exit 0
fi

step "1/8 Preflight"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || die "Node 20 or newer is required."
[ -d node_modules ] || npm ci --silent
$WR whoami 2>&1 | grep -iE "account name|@|\│ .*Account" | head -4 || true
read -rp "Deploy Rafiki to the Cloudflare account above? [y/N] " ok; [[ "$ok" == [yY]* ]] || die "Cancelled."
step "2/8 Tests (must pass before anything is deployed)"
npm run check --silent || die "Tests or type check failed. Nothing was deployed."

step "3/8 Database"
d1id() { $WR d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const x=JSON.parse(s).find(d=>d.name==="rafiki");console.log(x?(x.uuid||x.id||""):"")}catch{console.log("")}})'; }
DBID=$(d1id)
if [ -z "$DBID" ]; then $WR d1 create rafiki >/dev/null; DBID=$(d1id); fi
[ -n "$DBID" ] || die "Could not find or create the database."
if grep -q '^database_id' "$CFG"; then sed -i -E "s/^database_id = \"[^\"]*\"/database_id = \"$DBID\"/" "$CFG"; else sed -i -E "s/^(database_name = .*)$/\1\ndatabase_id = \"$DBID\"/" "$CFG"; fi
$WR d1 execute rafiki --remote --yes --file=schema.sql >/dev/null
echo "database ready ($DBID)"

step "4/8 Your two keys (typing is hidden; nothing is saved to disk)"
read -rsp "Paste the Telegram bot token from BotFather, then Enter: " TG_TOKEN; echo
BOT=$(TG_TOKEN="$TG_TOKEN" tgjs getme) || die "Telegram rejected that token."
echo "Bot found: @$BOT"
HAVE_OR=$($WR secret list --format json 2>/dev/null | grep -c '"OPENROUTER_API_KEY"' || true)
OR_KEY=""
if [ "$HAVE_OR" != "0" ]; then
  read -rp "An OpenRouter key is already stored. Keep it? [Y/n] " keep
  [[ "${keep:-Y}" == [nN]* ]] && HAVE_OR=0
fi
if [ "$HAVE_OR" = "0" ]; then
  read -rsp "Paste your OpenRouter API key, then Enter: " OR_KEY; echo
  OR_KEY="$OR_KEY" tgjs orkey || die "OpenRouter rejected that key."
fi

step "5/8 Deploy the Worker"
OUT=$($WR deploy 2>&1 | tee /dev/stderr)
URL=$(printf '%s' "$OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1)
[ -n "$URL" ] || die "Could not find the Worker URL in the deploy output."

step "6/8 Connect Telegram to the Worker (first, so a network failure changes nothing)"
HOOK_SECRET=$(openssl rand -hex 24)
CLAIM=$(openssl rand -hex 8)
TG_TOKEN="$TG_TOKEN" HOOK_URL="$URL/tg" HOOK_SECRET="$HOOK_SECRET" tgjs webhook | grep -q '^ok' || die "Telegram did not accept the webhook. Secrets were not changed; run ./deploy.sh again."
echo "webhook set"

step "7/8 Store secrets in Cloudflare (fresh webhook secret and claim code every run)"
printf '%s' "$TG_TOKEN" | $WR secret put TELEGRAM_BOT_TOKEN >/dev/null
printf '%s' "$HOOK_SECRET" | $WR secret put TELEGRAM_WEBHOOK_SECRET >/dev/null
printf '%s' "$CLAIM" | $WR secret put CLAIM_CODE >/dev/null
[ -n "$OR_KEY" ] && printf '%s' "$OR_KEY" | $WR secret put OPENROUTER_API_KEY >/dev/null
echo "secrets stored"

step "8/8 Smoke tests"
H=$(curl -s -o /dev/null -w '%{http_code}' "$URL/health"); echo "health: $H (want 200)"
A=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/tg" -d '{}'); echo "no secret: $A (want 401)"
B=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/tg" -H "x-telegram-bot-api-secret-token: $HOOK_SECRET" -H 'content-type: application/json' -d '{"update_id":1}'); echo "right secret: $B (want 200)"
TG_TOKEN="$TG_TOKEN" tgjs info
[ "$H" = "200" ] && [ "$A" = "401" ] && [ "$B" = "200" ] || die "A smoke test failed. See DEPLOY.md, Troubleshooting."

google_setup

LINK="https://t.me/$BOT?start=$CLAIM"
unset TG_TOKEN OR_KEY HOOK_SECRET
printf '\nRafiki is live.\n\nTap this link on your phone (or click it here) and press START:\n\n    %s\n\n' "$LINK"
printf 'It binds you as the owner and starts onboarding. The code works once; re-running this script makes a new one.\nRollback: npx wrangler rollback   |   Silence: send /pause in the chat.\n'
