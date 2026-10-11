// What Rafiki cannot do: the single source for the /limits command and the public pages.
// Keep it true. Whenever a capability or limit changes, edit this file and run `npm run limits`;
// `npm run check` fails while the vault copies are stale (tests/limits.test.ts).
import { DEFAULT_POLICY } from "./policy.ts";
import { BASE_LIMITS } from "./media.ts";

export interface LimitGroup { title: string; items: string[] }

const kb = (n: number): string => `${Math.round(n / 1000)} KB`;

export const LIMITS: readonly LimitGroup[] = [
  {
    title: "It cannot act for you without your tap",
    items: [
      "Send, post, create or change anything in another app on its own. Without hands it only writes to your own Telegram chat. With hands (your own Zapier, /hands), each send, post, draft or change is shown to you first and happens only when you tap Do it.",
      "Delete anything in your apps, or make raw API calls, even where your Zapier could. Those actions are never offered to it.",
      "Move, spend or hold money. It logs spends you tell it about and adds fees from your own fee table. It has no access to M-PESA, cards or bank accounts.",
      "Buy, book, sign or submit anything: forms, waivers and payments are yours to complete.",
      "Change your calendar on its own. Calendars it reads are read-only; it can hand you an Add to calendar button or file, or, with hands, create an event after your tap.",
      "Browse the web, open apps or use your phone or computer. It reads a public link you send it (an article, an X post, a PDF), and nothing behind a login.",
      "Run code or change a repository by itself. /code hands a task you confirm to your own Claude Code routine, which works on its own branch.",
    ],
  },
  {
    title: "It cannot see what you have not given it",
    items: [
      "Read your WhatsApp or SMS, notes you have not connected, or any email you have not connected. Obsidian, if you connect it, is searched read-only and never written to. Gmail, if you add it, is read-only: it sees unread mail in Primary and never sends, deletes or labels. Forwarded mail is read only from senders you allow.",
      "Turn text from outside into memory or settings. Mail, automations and links can only lead to a reminder or task suggestion; they never write facts, goals, money or settings.",
      "Read a calendar you switched off with /calendars, or a calendar link you removed.",
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
      `Interrupt you more than your daily limit unprompted (${DEFAULT_POLICY.nudgesMax} unless you change it), or at all during your quiet hours. Reminders you set and your morning brief are not counted.`,
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
