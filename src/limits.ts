// What Rafiki cannot do: the single source for the /limits command and the public pages.
// Keep it true. Whenever a capability or limit changes, edit this file and run `npm run limits`;
// `npm run check` fails while the vault copies are stale (tests/limits.test.ts).
import { UNSOLICITED_PER_DAY } from "./budget.ts";
import { BASE_LIMITS } from "./media.ts";

export interface LimitGroup { title: string; items: string[] }

const kb = (n: number): string => `${Math.round(n / 1000)} KB`;

export const LIMITS: readonly LimitGroup[] = [
  {
    title: "It cannot act for you outside this chat",
    items: [
      "Send anything to anyone but you. No emails, texts, messages or calendar invites go out. It only writes to your own Telegram chat.",
      "Move, spend or hold money. It logs spends you tell it about and adds fees from your own fee table. It has no access to M-PESA, cards or bank accounts.",
      "Buy, book, sign or submit anything: forms, waivers and payments are yours to complete.",
      "Change your calendar. Google Calendar is connected read-only, so it cannot add, move or delete events.",
      "Browse the web, open apps or use your phone or computer.",
    ],
  },
  {
    title: "It cannot see what you have not given it",
    items: [
      "Read your email, WhatsApp, SMS or notes. None are connected. It knows what you tell it, send it, import or share, plus the calendars you leave switched on.",
      "Read a calendar you switched off with /calendars.",
      "Keep passwords, card numbers or API keys. They are stripped before anything is stored or sent to an AI model.",
    ],
  },
  {
    title: "It cannot keep your data against your wishes",
    items: [
      "Delete anything on its own. Only you can: /forget removes one fact, /erase everything wipes the lot, and /export gives you a copy first.",
      "Erase your Telegram chat history, or what Telegram, Cloudflare's short-lived database backups or an AI provider already hold. It tells you this before you erase.",
    ],
  },
  {
    title: "It cannot overstep",
    items: [
      "Talk to anyone else. It answers only the Telegram account that claimed it, and strangers get no reply.",
      `Interrupt you more than ${UNSOLICITED_PER_DAY} times a day unprompted, or at all during your quiet hours. Reminders you set and your morning brief are not counted.`,
      "Act while paused. Type /pause and it stops until you /resume.",
      "Keep thinking once the day's model budget is used (USD 1.00 by default, changeable with /cap). Reminders and logging still work.",
    ],
  },
  {
    title: "It cannot handle big files yet",
    items: [
      `Voice notes over ${kb(BASE_LIMITS.voice)}, photos or PDFs over ${kb(BASE_LIMITS.photo)}, videos over ${(BASE_LIMITS.video / 1_000_000).toFixed(1)} MB, or text files over ${kb(BASE_LIMITS.text)}. These are limits of the free hosting plan, and it tells you when a file is too big. Telegram itself caps downloads at 20 MB.`,
    ],
  },
  {
    title: "It cannot be right every time",
    items: ["It can misread, mis-hear or misremember. Check anything you will act on. It is not a licensed financial, medical or legal adviser."],
  },
];

export function limitsText(): string {
  return ["What I cannot do", ...LIMITS.flatMap((g) => ["", g.title, ...g.items.map((i) => `- ${i}`)])].join("\n");
}

export function limitsMarkdown(): string {
  return LIMITS.map((g) => `**${g.title}.**\n${g.items.map((i) => `- ${i}`).join("\n")}`).join("\n\n");
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function limitsHtml(): string {
  return LIMITS.map((g) => `<article class="card" style="background:var(--md-surface-lowest)"><h3>${esc(g.title)}</h3><ul>${g.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></article>`).join("\n      ");
}
