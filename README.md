<p align="center"><img src="brand/logo.svg" alt="Rafiki" width="220"></p>

# Rafiki

**[rafiki.gachichio.org](https://rafiki.gachichio.org)** · [Learn more](https://gachichio.org/rafiki/) · [Set up your own](https://gachichio.org/rafiki/setup/)

**A personal agent on Telegram.** It acts as your chief of staff, adviser, coach and business adviser. It remembers everything you tell it, reminds and chases until you tap Done, sends a morning brief, reads your calendar, and asks before it acts. You run your own copy, with your own bot, your own AI key and your own data. *Rafiki* is Swahili for "friend".

**Status: early (MVP 1).** It works and one person uses it daily. Setup is still done from a terminal. The one-click installer and the guided five-step setup page are in progress (see the roadmap).

## What it does today
- **Reminders that chase.** "Remind me in 10 minutes", "tomorrow at 9am". It sends the reminder, then chases every two hours, up to three times, until you tap Done.
- **Memory that lasts.** Every message is kept and searchable until you erase it. Each night it writes a summary and pulls out the facts worth keeping. `/memory` and `/preferences` show and edit what it holds.
- **Morning brief and Monday customer check**, with a 👍 / 👎 under each so you can say what lands.
- **Calendar (read-only).** Connect Google Calendar and ask "what's on tomorrow?" or send `/agenda`.
- **Voice notes, photos, files, video, locations, contacts and polls**, read by a model that accepts them. Size limits apply on the free hosting plan.
- **Context import.** Paste or upload an export from another assistant, upload your own skill files, or answer a short "Know me" interview.
- **Your choice of models** through OpenRouter, changed with `/model`.
- **You own your data.** `/export` sends it all as plain files. `/forget` removes one fact. `/erase everything` wipes the lot after a typed confirmation.

## What Rafiki cannot do
This list is generated from [`src/limits.ts`](src/limits.ts) and is the same one `/limits` shows in the bot. It changes whenever a new ability ships.

<!-- limits:start -->
**It cannot act for you outside this chat.**
- Send anything to anyone but you. No emails, texts, messages or calendar invites go out. It only writes to your own Telegram chat.
- Move, spend or hold money. It logs spends you tell it about and adds fees from your own fee table. It has no access to M-PESA, cards or bank accounts.
- Buy, book, sign or submit anything: forms, waivers and payments are yours to complete.
- Change your calendar. Calendars are read-only, so it cannot add, move or delete events. It can hand you an Add to calendar button or file, which you tap yourself.
- Browse the web, open apps or use your phone or computer.

**It cannot see what you have not given it.**
- Read your email, WhatsApp, SMS or notes. None are connected. It knows what you tell it, send it, import or share, plus the calendars you leave switched on.
- Read a calendar you switched off with /calendars, or a calendar link you removed.
- Keep passwords, card numbers or API keys. They are stripped before anything is stored or sent to an AI model.

**It cannot keep your data against your wishes.**
- Delete anything on its own. Only you can: /forget removes one fact, /erase everything wipes the lot, and /export gives you a copy first.
- Erase your Telegram chat history, or what Telegram, Cloudflare's short-lived database backups or an AI provider already hold. It tells you this before you erase.

**It cannot overstep.**
- Talk to anyone else. It answers only the Telegram account that claimed it, and strangers get no reply.
- Interrupt you more than your daily limit unprompted (3 unless you change it), or at all during your quiet hours. Reminders you set and your morning brief are not counted.
- Act while paused. Type /pause and it stops until you /resume.
- Keep thinking once the day's model budget is used (USD 1.00 by default, changeable with /cap). Reminders and logging still work.

**It cannot handle big files yet.**
- Voice notes over 400 KB, photos or PDFs over 600 KB, videos over 1.5 MB, or text files over 200 KB. These are limits of the free hosting plan, and it tells you when a file is too big. Telegram itself caps downloads at 20 MB.

**It cannot be right every time.**
- It can misread, mis-hear or misremember. Check anything you will act on. It is not a licensed financial, medical or legal adviser.
<!-- limits:end -->

## Install it yourself
Five steps, about 12 minutes the first time. You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up), a Telegram account, and an [OpenRouter](https://openrouter.ai) account with a little credit. Your bot, your AI key and your data stay yours: nothing passes through the author.

1. **Name it and create its bot.** Open [@BotFather](https://t.me/BotFather), send `/newbot`, choose the name you want to call your Rafiki and a username ending in `bot`, and copy the token it gives you.
2. **Get an AI key.** At [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) create a key just for Rafiki and give it a credit limit.
3. **Install.** Tap the button, sign in to Cloudflare, and paste the bot token, the AI key and a setup word you invent when it asks:

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bgachichio/rafiki)

   Then open your new address followed by `/setup`, type your setup word, and the page connects Telegram, sets the mandrill as your bot's photo, and gives you a link.
4. **Say hello.** Open the link, press Start, and answer a few questions. Rafiki asks what to call you and offers to read your calendar and contacts.
5. **Bring your memory and preferences.** Send `/import`, paste the prompt into the assistant you already use, and send back the two files (`memory.md`, `preferences.md`). Rafiki shows what it found and asks you to confirm each choice.

*The one-click route is new and has not yet been run end to end by anyone but its author. If it trips, the terminal route below always works.*

**From a terminal instead** (Node 20 or newer):
```bash
git clone https://github.com/bgachichio/rafiki.git
cd rafiki
./deploy.sh
```
The script runs the tests, creates the database, deploys the Worker, connects Telegram, and stores your secrets in Cloudflare. Typing is hidden and nothing is written to disk. `./deploy.sh google` adds Google Calendar later (a one-time Google Cloud setup). `./deploy.sh webhook` refreshes the Telegram connection and menu.

Defaults are East Africa Time and Kenyan shillings (`TZ_OFFSET_MIN` in `wrangler.toml`). A timezone and currency question is on the roadmap. If you keep private settings (your database id, your Worker address), put them in `wrangler.local.toml`, which Git ignores, and run `WRANGLER_CONFIG=wrangler.local.toml ./deploy.sh`.

## Commands
`/today /rules /agenda /calendars /memory /preferences /search /remember /forget /export /erase /skills /import /model /connect /place /where /brief /goals /ledger /money /fees /settings /cap /log /why /pause /resume /limits /about`

## Develop
```bash
npm ci
npm run check     # type check and tests (no network, no secrets)
npm run dev       # local Worker
```
The model is only ever called through `src/llm.ts`. Only low-consequence actions exist (`src/gates.ts`): Rafiki cannot send, spend or delete. Never commit a secret; a pre-commit hook runs gitleaks.

## Roll back
If an update misbehaves, `npx wrangler rollback` returns the Worker to the previous version in seconds, and your data stays as it is. `/pause` stops Rafiki acting while you look, and `/export` takes a copy first.

## Roadmap
Done: decision cards and a preferences engine for reminder behaviour, the two-file memory import, the `/setup` page and one-click deploy. Next: iCal calendars and contacts import, a Starter Pack of generalised skills, a guided setup page on the website, and an optional Telegram Mini App dashboard. Not promised until shipped.

## Support
Rafiki is free and has no ads. If it saved you time, you can help keep it that way. Payments leave Rafiki only when you tap.

| Option | Details |
|---|---|
| Card or M-Pesa | [paystack.shop/pay/gachichio](https://paystack.shop/pay/gachichio) |
| Bitcoin, Lightning | `gachichio@walletofsatoshi.com` |
| Bitcoin, on-chain (Taproot) | `bc1ptrd8ykgu046nkwjml4kvtke0vz6ga0cmhccmgkpspwuswrasjspqq6yfu6` |

Inside the bot, `/about` shows the same options with copy buttons.

## Licence
[GNU AGPL-3.0](LICENSE) with an attribution term ([NOTICE](NOTICE)): copies, modified or not, keep the credit below. If you run a modified version for other people, the AGPL requires you to share your changes.

---
Made with ❤️ by [Brian Gachichio](https://x.com/b_gachichio) · [@b_gachichio](https://x.com/b_gachichio) · [github.com/bgachichio/rafiki](https://github.com/bgachichio/rafiki) · [rafiki.gachichio.org](https://rafiki.gachichio.org)
