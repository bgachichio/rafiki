// The decisions Rafiki puts to the owner as cards. Each has a proposal, presets, and a way to say "my own".
import type { Ctx } from "./agent.ts";
import { getSetting, setSetting } from "./db.ts";
import { loadPrefs } from "./prefs.ts";
import { STYLE_TEXT } from "./prefs.ts";
import { MODE_TEXT, leadsText, loadPolicy, parseLeads, setPolicyKey } from "./policy.ts";
import { PRESETS, modelLabel, type ModelKind } from "./models.ts";
import { parseHM } from "./time.ts";

export interface Opt { id: string; label: string }
export interface Spec {
  key: string;
  label: string; // short name for summaries
  question: string;
  options: (ctx: Ctx) => Promise<Opt[]> | Opt[];
  effective: (ctx: Ctx) => Promise<string>; // the value in force now (a default counts)
  show: (value: string) => string;
  apply: (ctx: Ctx, value: string) => Promise<void>; // writes the value as confirmed
  applyCustom?: (ctx: Ctx, text: string) => Promise<void>; // when a custom answer is not a value of this kind (a style note)
  parse?: (text: string) => string | null; // turns what they typed into a value; null means unreadable
  hint: string; // what to type for "my own"
  multi?: boolean;
}

const hm = (v: string): string => { const m = parseHM(v); return m === null ? v : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
const pref = (key: string, d: string) => async (ctx: Ctx): Promise<string> => (await loadPrefs(ctx.db))[key] ?? d;
const write = (key: string) => (ctx: Ctx, v: string): Promise<void> => setPolicyKey(ctx.db, ctx.now, key, v, "confirmed");
const hmParse = (t: string): string | null => { const m = /^\s*(\d{1,2})(?::|\.|h)?(\d{2})?\s*(am|pm)?\s*$/i.exec(t); if (!m) return null; let h = Number(m[1]); const mi = Number(m[2] ?? 0); if (m[3]) { const pm = m[3].toLowerCase() === "pm"; if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; } return h < 24 && mi < 60 ? `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}` : null; };
const settingTime = (key: string, def: string): Pick<Spec, "effective" | "apply" | "parse" | "show"> => ({
  effective: async (ctx) => (await getSetting(ctx.db, key)) ?? def,
  apply: async (ctx, v) => { await setSetting(ctx.db, key, v); await setPolicyKey(ctx.db, ctx.now, `setting.${key}`, v, "confirmed"); },
  parse: hmParse,
  show: hm,
});
const QUIET: Opt[] = [{ id: "21:00-05:30", label: "21:00 to 05:30" }, { id: "22:00-06:00", label: "22:00 to 06:00" }, { id: "23:00-07:00", label: "23:00 to 07:00" }, { id: "00:00-06:00", label: "Midnight to 06:00" }];
const LANGS = ["English", "Swahili", "French", "Arabic", "Hindi", "Spanish", "Portuguese", "German"];

export const SPECS: Record<string, Spec> = {
  call_me: {
    key: "call_me", label: "What I call you", question: "What should I call you?",
    options: async (ctx) => { const n = await getSetting(ctx.db, "owner_name"); return n ? [{ id: n, label: n }] : []; },
    effective: async (ctx) => (await loadPrefs(ctx.db)).call_me ?? (await getSetting(ctx.db, "owner_name")) ?? "",
    show: (v) => v || "not set", apply: write("call_me"), parse: (t) => (t.trim().length > 0 && t.trim().length <= 40 ? t.trim() : null), hint: "Type the name you want me to use.",
  },
  "remind.mode": {
    key: "remind.mode", label: "How I remind you", question: "When I remind you of something, how should I behave?",
    options: () => (Object.keys(MODE_TEXT) as (keyof typeof MODE_TEXT)[]).map((id) => ({ id, label: MODE_TEXT[id] })),
    effective: async (ctx) => (await loadPolicy(ctx.db)).policy.mode, show: (v) => MODE_TEXT[v as keyof typeof MODE_TEXT] ?? v, apply: write("remind.mode"),
    parse: (t) => (/\b(once|one and done|just once)\b/i.test(t) ? "once" : /\b(chase|keep (reminding|asking)|until)\b/i.test(t) ? "chase" : /\b(done|thumbs|confirm|list)\b/i.test(t) ? "confirm" : null),
    hint: "Say it in your words, for example \"remind me once, then leave it\" or \"keep chasing me\".",
  },
  "remind.event_leads": {
    key: "remind.event_leads", label: "Reminders before events", question: "For events (meetings, dinners, flights), when should I remind you?",
    options: () => [{ id: "60", label: "1 hour before" }, { id: "1440,60", label: "1 day and 1 hour before" }, { id: "60,0", label: "1 hour before and at the time" }, { id: "0", label: "Only at the time" }],
    effective: async (ctx) => (await loadPolicy(ctx.db)).policy.eventLeads.join(","), show: (v) => leadsText(v.split(",").map(Number)), apply: write("remind.event_leads"),
    parse: (t) => parseLeads(t)?.join(",") ?? null, hint: "For example: \"2 days and 30 minutes before\", or \"at the time\".",
  },
  "remind.morning": {
    key: "remind.morning", label: "What \"tomorrow\" means", question: "When you say \"tomorrow\" with no time, what time do you mean?",
    options: () => ["08:00", "09:00", "12:00", "18:00"].map((id) => ({ id, label: id })),
    effective: async (ctx) => (await loadPolicy(ctx.db)).policy.morning, show: hm, apply: write("remind.morning"), parse: hmParse, hint: "Type a time, for example 07:30 or 5pm.",
  },
  "remind.gap_h": {
    key: "remind.gap_h", label: "Gap between chases", question: "When I chase, how long should I wait between reminders?",
    options: () => [{ id: "1", label: "1 hour" }, { id: "2", label: "2 hours" }, { id: "4", label: "4 hours" }, { id: "24", label: "Next day" }],
    effective: async (ctx) => String((await loadPolicy(ctx.db)).policy.gapH), show: (v) => `${v} hours`, apply: write("remind.gap_h"),
    parse: (t) => { const n = Number(/(\d+(?:\.\d+)?)/.exec(t)?.[1]); return n > 0 && n <= 72 ? String(n) : null; }, hint: "Type the number of hours.",
  },
  "remind.max": {
    key: "remind.max", label: "How many chases", question: "How many times should I chase before I give up and flag it?",
    options: () => ["1", "2", "3", "5"].map((id) => ({ id, label: `${id} time${id === "1" ? "" : "s"}` })),
    effective: async (ctx) => String((await loadPolicy(ctx.db)).policy.max), show: (v) => `${v} time${v === "1" ? "" : "s"}`, apply: write("remind.max"),
    parse: (t) => { const n = Number(/(\d+)/.exec(t)?.[1]); return Number.isInteger(n) && n >= 0 && n <= 10 ? String(n) : null; }, hint: "Type a number from 0 to 10.",
  },
  style: {
    key: "style", label: "How I talk to you", question: "How should my replies read?",
    options: () => [{ id: "brief", label: "Very short" }, { id: "direct", label: "Direct, answer first" }, { id: "warm", label: "Warm and encouraging" }, { id: "detailed", label: "Thorough, with reasoning" }],
    effective: pref("style", "direct"), show: (v) => (STYLE_TEXT[v] ? v : `in your words: ${v}`), apply: write("style"),
    applyCustom: (ctx, text) => setPolicyKey(ctx.db, ctx.now, "style_note", text, "confirmed"), hint: "Describe it in your own words and I'll follow that.",
  },
  brief_time: { key: "brief_time", label: "Morning brief", question: "What time should your morning brief arrive?", options: () => ["06:30", "07:00", "08:00", "09:00"].map((id) => ({ id, label: id })), hint: "Type a time, for example 06:45.", ...settingTime("brief_time", "08:00") },
  "brief.items": {
    key: "brief.items", label: "Brief length", question: "How many priorities should the brief list?",
    options: () => [{ id: "1", label: "Just the top one" }, { id: "3", label: "Top three" }, { id: "5", label: "Top five" }],
    effective: async (ctx) => String((await loadPolicy(ctx.db)).policy.briefItems), show: (v) => (v === "1" ? "the top one" : `top ${v}`), apply: write("brief.items"),
    parse: (t) => { const n = Number(/(\d+)/.exec(t)?.[1]); return n === 1 || n === 3 || n === 5 ? String(n) : null; }, hint: "Type 1, 3 or 5.",
  },
  quiet: {
    key: "quiet", label: "Quiet hours", question: "When should I stay quiet (no nudges, no chasing)?", options: () => QUIET,
    effective: async (ctx) => `${(await getSetting(ctx.db, "quiet_start")) ?? "21:00"}-${(await getSetting(ctx.db, "quiet_end")) ?? "05:30"}`,
    show: (v) => v.replace("-", " to "),
    apply: async (ctx, v) => { const [a, b] = v.split("-"); await setSetting(ctx.db, "quiet_start", a!); await setSetting(ctx.db, "quiet_end", b!); await setPolicyKey(ctx.db, ctx.now, "setting.quiet", v, "confirmed"); },
    parse: (t) => { const m = /(\d{1,2})(?::(\d{2}))?\s*(?:-|to|until)\s*(\d{1,2})(?::(\d{2}))?/i.exec(t); if (!m) return null; const a = hmParse(`${m[1]}:${m[2] ?? "00"}`), b = hmParse(`${m[3]}:${m[4] ?? "00"}`); return a && b ? `${a}-${b}` : null; },
    hint: "Type it like 22:00 to 06:00.",
  },
  "nudges.max": {
    key: "nudges.max", label: "Unprompted nudges a day", question: "How many times a day may I message you unprompted (beyond reminders you set and your brief)?",
    options: () => [{ id: "0", label: "None" }, { id: "1", label: "One" }, { id: "3", label: "Up to three" }, { id: "5", label: "Up to five" }],
    effective: async (ctx) => String((await loadPolicy(ctx.db)).policy.nudgesMax), show: (v) => (v === "0" ? "none" : `up to ${v}`), apply: write("nudges.max"),
    parse: (t) => { const n = Number(/(\d+)/.exec(t)?.[1]); return Number.isInteger(n) && n >= 0 && n <= 20 ? String(n) : null; }, hint: "Type a number.",
  },
  lang: {
    key: "lang", label: "Languages", question: "Which languages do you write in? I'll reply in the one you write in. Pick all that apply.", multi: true,
    options: () => LANGS.map((l) => ({ id: l, label: l })), effective: async (ctx) => (await loadPrefs(ctx.db)).lang ?? "", show: (v) => v || "not set", apply: write("lang"),
    parse: (t) => (t.trim().length > 0 ? t.trim().slice(0, 100) : null), hint: "Type the languages, separated by commas.",
  },
};

/** The order of the "how I work" walk-through. */
export const SEQ = ["call_me", "remind.mode", "remind.event_leads", "remind.morning", "style", "brief_time", "quiet", "nudges.max", "lang"];

const modelSpec = (kind: ModelKind, label: string, question: string): Spec => ({
  key: `model.${kind}`, label, question,
  options: () => PRESETS[kind].map(([l, id]) => ({ id, label: l.replace(/ \((default|cheapest)\)$/, "") })),
  effective: async (ctx) => (await getSetting(ctx.db, `model_${kind}`)) || (kind === "fast" ? ctx.env.MODEL_FAST : kind === "smart" ? ctx.env.MODEL_SMART : ctx.env.MODEL_MEDIA ?? ctx.env.MODEL_FAST),
  show: (v) => modelLabel(kind, v),
  apply: async (ctx, v) => { await setSetting(ctx.db, `model_${kind}`, v); await setPolicyKey(ctx.db, ctx.now, `setting.model.${kind}`, v, "confirmed"); },
  parse: (t) => (/^[\w.-]+\/[\w.:-]+$/.test(t.trim()) ? t.trim() : null), hint: "Type the OpenRouter model id, for example google/gemini-3.8-flash.",
});
SPECS["model.fast"] = modelSpec("fast", "Everyday model", "Which model should handle everyday chat, reminders and summaries?");
SPECS["model.smart"] = modelSpec("smart", "Deep-thinking model", "Which model should handle advice, plans and decisions?");
SPECS["model.media"] = modelSpec("media", "Voice, photo and file model", "Which model should read voice notes, photos, files and video?");
