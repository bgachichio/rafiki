// Structured preferences: small, named, always visible and editable with /preferences.
import type { Db } from "./db.ts";

export const PREF_LABELS: Record<string, string> = {
  call_me: "What I call you",
  work: "What you do",
  areas: "Life areas I watch",
  style: "How I talk to you",
  style_note: "Style, in your words",
  day_start: "Your day starts",
  day_end: "Your day ends",
  work_days: "Work days",
  voice_card: "Your writing voice",
  "emoji.level": "Emoji",
  "reply.lang": "Reply language",
};
export const STYLE_TEXT: Record<string, string> = {
  brief: "Keep replies very short: two to four lines.",
  direct: "Be direct: lead with the answer, no hedging, no padding.",
  warm: "Be warm and encouraging, while staying concise.",
  detailed: "Be thorough and structured, showing the reasoning.",
};

export const EMOJI_TEXT: Record<string, string> = {
  none: "Use no emoji.",
  few: "Use at most one emoji in a reply, and only where it adds warmth.",
  balanced: "Use a few emoji where they help the tone: one or two in a short reply, up to three in a long one.",
  lots: "Use emoji freely to keep the tone light and lively, without replacing words.",
};

/** The reply languages the owner can fix. Anything else (or "match") follows the language of the message. */
export const REPLY_LANG_TEXT: Record<string, string> = {
  English: "The owner chose English. Reply in English even when they write in Swahili or Sheng.",
  Swahili: "The owner chose Swahili. Reply in clear, friendly Swahili even when they write in English or Sheng.",
  Sheng: "The owner chose Sheng, the Nairobi street speech that blends Swahili and English. Reply in light, natural Sheng, never forced or mocking, even when they write in English or Swahili. Use plain English or Swahili for anything where a slip would cost money or safety: amounts, deadlines, legal, health and security.",
};
const REPLY_LANG_DEFAULT = "LANGUAGE: Reply in the language of the owner's message: English, Swahili or Sheng (the Nairobi blend of Swahili and English). If they mix, mix the same way. Keep names, amounts, dates and times exact in any language.";

export async function loadPrefs(db: Db): Promise<Record<string, string>> {
  const r = await db.prepare("SELECT key, value FROM prefs").bind().all<{ key: string; value: string }>();
  return Object.fromEntries(r.results.map((x) => [x.key, x.value]));
}
export async function setPref(db: Db, now: number, key: string, value: string, source = "chat"): Promise<void> {
  await db.prepare("INSERT INTO prefs (key, value, source, ts) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, ts = excluded.ts").bind(key, value.slice(0, 1500), source, now).run();
}
export async function clearPref(db: Db, key: string): Promise<void> {
  await db.prepare("DELETE FROM prefs WHERE key = ?").bind(key).run();
}

/** Lines for the model's context: who to call the owner, and how to talk. */
export function prefsLines(p: Record<string, string>): string[] {
  const out: string[] = [];
  const who = [p.call_me ? `Call the owner ${p.call_me}.` : "", p.work ? `They do: ${p.work}.` : "", p.areas ? `Life areas they care most about: ${p.areas}.` : "", p.work_days ? `Work days: ${p.work_days}.` : "", p.day_start && p.day_end ? `Their day runs ${p.day_start} to ${p.day_end}.` : ""].filter(Boolean).join(" ");
  if (who) out.push(`OWNER PROFILE: ${who}`);
  if (p.lang) out.push(`LANGUAGES: the owner writes in ${p.lang}.`);
  const fixed = REPLY_LANG_TEXT[p["reply.lang"] ?? ""];
  out.push(fixed ? `REPLY LANGUAGE (the owner's saved choice, which overrides the language of their message): ${fixed} Only a clear request in the current message for another language comes first, and only for that reply. Keep names, amounts, dates and times exact in any language.` : REPLY_LANG_DEFAULT);
  const style = [p.style ? STYLE_TEXT[p.style] ?? p.style : "", p.style_note ?? "", p.voice_card ? `When drafting for them, write in their voice: ${p.voice_card}` : ""].filter(Boolean).join(" ");
  if (style) out.push(`HOW TO TALK TO THE OWNER: ${style}`);
  if (p["emoji.level"]) out.push(`EMOJI: ${EMOJI_TEXT[p["emoji.level"]] ?? EMOJI_TEXT.none}`);
  return out;
}
