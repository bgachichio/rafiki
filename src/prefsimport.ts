// preferences.md from another assistant: read it, use it as an unconfirmed starting point, then confirm each choice with a card.
import type { Ctx } from "./agent.ts";
import { SPECS } from "./decisions.ts";
import { getSetting, setSetting } from "./db.ts";
import { looksInjected } from "./skills.ts";
import { setPolicyKey } from "./policy.ts";
import { setPref } from "./prefs.ts";

export interface PrefsParsed { values: Record<string, string>; settings: Record<string, string>; rules: string[]; dropped: number }

/** Split a paste or file into memory.md and preferences.md. Markers win; otherwise the headings decide. */
export function splitFiles(text: string, source = ""): { memory: string; preferences: string } {
  const clean = text.replace(/```[a-z]*/gi, "");
  const re = /^[ \t]*#{1,3}[ \t]*(memory|preferences)(?:\.md)?[ \t]*$/gim;
  const marks = [...clean.matchAll(re)].map((m) => ({ kind: m[1]!.toLowerCase(), at: m.index!, end: m.index! + m[0].length }));
  if (marks.length) {
    let memory = "", preferences = "";
    marks.forEach((m, i) => { const body = clean.slice(m.end, marks[i + 1]?.at ?? clean.length); if (m.kind === "memory") memory += `\n${body}`; else preferences += `\n${body}`; });
    return { memory, preferences };
  }
  const prefHeads = /^[ \t]*#{1,3}[ \t]*(call me|replies|reminders|languages?|daily rhythm|rules)\b/im.test(clean);
  const memHeads = /^[ \t]*#{1,3}[ \t]*(identity|career|projects|people|goals|routines)\b/im.test(clean);
  if (/preference/i.test(source) || (prefHeads && !memHeads)) return { memory: "", preferences: clean };
  return { memory: clean, preferences: "" };
}

const bullets = (lines: string[]): string[] => lines.map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/\*\*/g, "").trim()).filter((l) => l.length > 1 && !/^\[?(unknown|none|n\/a)\]?\.?$/i.test(l));
const timeIn = (t: string): string | null => { const m = /(\d{1,2}(?::|\.)\d{2}|\d{1,2}\s*(?:am|pm))/i.exec(t); return m ? SPECS["remind.morning"]!.parse!(m[1]!.replace(".", ":")) : null; };

export function parsePreferences(text: string): PrefsParsed {
  const out: PrefsParsed = { values: {}, settings: {}, rules: [], dropped: 0 };
  const secs: { head: string; lines: string[] }[] = [];
  for (const raw of text.replace(/```[a-z]*/gi, "").split(/\r?\n/)) {
    const h = /^\s*#{1,4}\s*(.+?)\s*:?\s*$/.exec(raw);
    if (h) { secs.push({ head: h[1]!.toLowerCase(), lines: [] }); continue; }
    if (raw.trim() && secs.length) secs.at(-1)!.lines.push(raw);
  }
  for (const s of secs) {
    const items = bullets(s.lines);
    if (!items.length) continue;
    if (/call me|my name|address me|name i/.test(s.head)) out.values.call_me = items[0]!.replace(/^["'“]|["'”]$/g, "").slice(0, 40);
    else if (/repl|style|tone|length|format/.test(s.head)) {
      for (const it of items) {
        const low = it.toLowerCase();
        const style = /\b(very short|brief|short|concise|terse)\b/.test(low) ? "brief" : /\bdirect|blunt|straight\b/.test(low) ? "direct" : /\bwarm|friendly|encouraging\b/.test(low) ? "warm" : /\b(thorough|detailed|in depth|in-depth|long)\b/.test(low) ? "detailed" : null;
        if (style && !out.values.style) out.values.style = style;
        if (!style || it.length > 40) out.rules.push(it);
      }
    } else if (/remind/.test(s.head)) {
      for (const it of items) {
        const low = it.toLowerCase();
        if (!out.values["remind.mode"]) {
          if (/\b(once|one and done|just one|single reminder)\b/.test(low) && !/\b(tap|click)\b.*\bdone\b|stay on my list|keep it on/.test(low)) out.values["remind.mode"] = "once";
          else if (/\b(tap|click)\b.*\bdone\b|thumbs|stay on my list|keep it on my list|confirm/.test(low)) out.values["remind.mode"] = "confirm";
          else if (/\b(chase|keep reminding|nag|until i)\b/.test(low)) out.values["remind.mode"] = "chase";
        }
        if (/before|lead|ahead|in advance/.test(low)) { const v = SPECS["remind.event_leads"]!.parse!(it); if (v && !out.values["remind.event_leads"]) out.values["remind.event_leads"] = v; }
        if (/tomorrow|no time|default time|morning/.test(low)) { const t = timeIn(it); if (t) out.values["remind.morning"] = t; }
      }
    } else if (/language/.test(s.head)) {
      const langs = items.join(", ").split(/[,;/]|\band\b/i).map((x) => x.replace(/\(.*?\)/g, "").trim()).filter((x) => x.length > 1 && x.length < 25).slice(0, 8).map((x) => x[0]!.toUpperCase() + x.slice(1));
      if (langs.length) out.values.lang = [...new Set(langs)].join(", ");
    } else if (/rhythm|schedule|daily|routine|hours|quiet|brief/.test(s.head)) {
      for (const it of items) {
        const low = it.toLowerCase();
        const b = /brief[^0-9]*(\d{1,2}(?::|\.)\d{2}|\d{1,2}\s*(?:am|pm))/i.exec(it);
        if (b) { const t = SPECS.brief_time!.parse!(b[1]!.replace(".", ":")); if (t) out.settings.brief_time = t; }
        if (/quiet|do not disturb|don'?t message|no messages/.test(low)) { const q = SPECS.quiet!.parse!(it); if (q) out.settings.quiet = q; }
        const w = /work days?[:\s-]+(.+)/i.exec(it); if (w) out.values.work_days = w[1]!.slice(0, 80);
      }
    } else if (/rule|instruction|always|never|boundar|do not|don'?t/.test(s.head)) {
      for (const it of items) { if (looksInjected(it) || /never (disagree|question|push back)|always agree|do not (question|challenge)|validate (me|everything)/i.test(it)) out.dropped++; else out.rules.push(it.slice(0, 300)); }
    }
  }
  return out;
}

/** Use what was found as an unconfirmed starting point. A choice the owner has already confirmed is never overwritten. Returns the card keys to confirm. */
export async function applyPreferences(ctx: Ctx, p: PrefsParsed): Promise<{ keys: string[]; lines: string[]; kept: string[] }> {
  const status = new Map((await ctx.db.prepare("SELECT key, status FROM pref_state").bind().all<{ key: string; status: string }>()).results.map((r) => [r.key, r.status]));
  const keys: string[] = [], lines: string[] = [], kept: string[] = [];
  const take = async (cardKey: string, stateKey: string, value: string, write: () => Promise<void>): Promise<void> => {
    const spec = SPECS[cardKey]!;
    if (status.get(stateKey) === "confirmed" || status.get(cardKey) === "confirmed") { kept.push(spec.label); return; }
    await write();
    await ctx.db.prepare("INSERT INTO pref_state (key, status, ts) VALUES (?, 'imported', ?) ON CONFLICT(key) DO UPDATE SET status = 'imported', ts = excluded.ts").bind(stateKey, ctx.now).run();
    keys.push(cardKey); lines.push(`${spec.label}: ${spec.show(value)}`);
  };
  for (const [k, v] of Object.entries(p.values)) {
    if (k === "work_days") { await setPref(ctx.db, ctx.now, "work_days", v, "import"); continue; }
    if (SPECS[k]) await take(k, k, v, () => setPolicyKey(ctx.db, ctx.now, k, v, "imported", "import"));
  }
  if (p.settings.brief_time) await take("brief_time", "setting.brief_time", p.settings.brief_time, () => setSetting(ctx.db, "brief_time", p.settings.brief_time!));
  if (p.settings.quiet) {
    const q = p.settings.quiet;
    await take("quiet", "setting.quiet", q, async () => { const [a, b] = q.split("-"); await setSetting(ctx.db, "quiet_start", a!); await setSetting(ctx.db, "quiet_end", b!); });
  }
  return { keys, lines, kept };
}

export async function stashPreferences(ctx: Ctx, p: PrefsParsed): Promise<void> { await setSetting(ctx.db, "import_prefs", JSON.stringify(p)); }
export async function takeStashed(ctx: Ctx): Promise<PrefsParsed | null> {
  const raw = await getSetting(ctx.db, "import_prefs");
  if (!raw) return null;
  await setSetting(ctx.db, "import_prefs", "");
  try { return JSON.parse(raw) as PrefsParsed; } catch { return null; }
}
