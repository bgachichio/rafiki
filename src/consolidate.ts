// Nightly consolidation: yesterday becomes a summary and a few durable facts, kept forever and searchable.
import { logRun, type Ctx } from "./agent.ts";
import { getEvents, evLine } from "./calendar.ts";
import { chat, CreditError } from "./llm.ts";
import { addFact, indexText, isCategory } from "./memory.ts";
import { fmtDate } from "./time.ts";

const DAY_PROMPT = `You keep the owner's private, permanent memory. From one day of conversation and calendar, return ONE JSON object and nothing else:
{"summary":"at most 120 words: what happened, what was decided, what is still open","facts":[{"text":"a durable fact about the owner or people in their life","category":"people|preferences|routines|projects|money|health|family|work|instructions|other"}]}
Include a fact only if it will still matter in a year (not one-off tasks or moods). At most 6 facts. Never include passwords, keys or card numbers. UK English, dates DD-MM-YYYY.`;

const WEEK_PROMPT = `Combine these daily summaries into one weekly summary of at most 150 words: themes, decisions, progress against goals, and open threads. Return ONE JSON object: {"summary":"..."}. UK English.`;

function parse(text: string): { summary?: unknown; facts?: unknown } | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)) as { summary?: unknown; facts?: unknown }; } catch { return null; }
}

export type Consolidation = { status: "ok" | "skip" | "error"; facts: number; period: string };

/** Summarise one local day (dayStart is its midnight in epoch ms). Safe to call twice: an existing summary is left alone. */
export async function consolidateDay(ctx: Ctx, dayStart: number): Promise<Consolidation> {
  const { db, env, f, now, off } = ctx;
  const period = fmtDate(dayStart + 3600000, off);
  const have = await db.prepare("SELECT id FROM summaries WHERE kind = 'day' AND period = ?").bind(period).first();
  if (have) return { status: "skip", facts: 0, period };
  const msgs = await db.prepare("SELECT role, text FROM messages WHERE ts >= ? AND ts < ? ORDER BY id").bind(dayStart, dayStart + 86400000).all<{ role: string; text: string }>();
  if (msgs.results.length < 2) return { status: "skip", facts: 0, period };
  const evs = await getEvents(db, dayStart, dayStart + 86400000);
  const convo = msgs.results.map((m) => `${m.role === "assistant" ? "Rafiki" : "Owner"}: ${m.text.slice(0, 500)}`).join("\n").slice(0, 9000);
  const cal = evs.length ? `\n\nCALENDAR THAT DAY:\n${evs.slice(0, 12).map((e) => evLine(e, off)).join("\n")}` : "";
  const started = Date.now();
  try {
    const r = await chat(env, f, { sens: "S2", deep: true, maxTokens: 600, messages: [{ role: "system", content: DAY_PROMPT }, { role: "user", content: `DAY ${period}\n\n${convo}${cal}` }] });
    const j = parse(r.text);
    const summary = j && typeof j.summary === "string" ? j.summary.trim().slice(0, 1200) : "";
    let facts = 0;
    if (summary) {
      const ins = await db.prepare("INSERT INTO summaries (ts, kind, period, text) VALUES (?, 'day', ?, ?) ON CONFLICT DO NOTHING RETURNING id").bind(now, period, summary).first<{ id: number }>();
      if (ins) await indexText(db, "summary", ins.id, summary);
      if (Array.isArray(j?.facts)) {
        for (const x of (j.facts as { text?: unknown; category?: unknown }[]).slice(0, 6)) {
          if (typeof x?.text === "string" && (await addFact(db, now, x.text, isCategory(x.category) ? x.category : "other", `summary ${period}`)) !== null) facts++;
        }
      }
    }
    await logRun(db, { now, role: "memory", model: r.model, sens: "S2", pref: r.providerPref, tin: r.tokensIn, tout: r.tokensOut, cost: r.costUsd, ms: Date.now() - started, status: summary ? "ok" : "empty", trace: { job: "consolidate-day", period, facts } });
    return { status: summary ? "ok" : "error", facts, period };
  } catch (e) {
    await logRun(db, { now, role: "memory", model: "", sens: "S2", pref: "", tin: 0, tout: 0, cost: 0, ms: Date.now() - started, status: e instanceof CreditError ? "credit" : "error", trace: { job: "consolidate-day", period } });
    return { status: "error", facts: 0, period };
  }
}

/** Combine the last seven daily summaries into a weekly one. */
export async function consolidateWeek(ctx: Ctx): Promise<Consolidation> {
  const { db, env, f, now, off } = ctx;
  const period = `week to ${fmtDate(now, off)}`;
  const days = await db.prepare("SELECT period, text FROM summaries WHERE kind = 'day' ORDER BY id DESC LIMIT 7").bind().all<{ period: string; text: string }>();
  if (days.results.length < 3) return { status: "skip", facts: 0, period };
  const started = Date.now();
  try {
    const r = await chat(env, f, { sens: "S2", deep: true, maxTokens: 500, messages: [{ role: "system", content: WEEK_PROMPT }, { role: "user", content: days.results.reverse().map((d) => `${d.period}: ${d.text}`).join("\n") }] });
    const summary = (() => { const j = parse(r.text); return j && typeof j.summary === "string" ? j.summary.trim().slice(0, 1500) : ""; })();
    if (summary) {
      const ins = await db.prepare("INSERT INTO summaries (ts, kind, period, text) VALUES (?, 'week', ?, ?) ON CONFLICT DO NOTHING RETURNING id").bind(now, period, summary).first<{ id: number }>();
      if (ins) await indexText(db, "summary", ins.id, summary);
    }
    await logRun(db, { now, role: "memory", model: r.model, sens: "S2", pref: r.providerPref, tin: r.tokensIn, tout: r.tokensOut, cost: r.costUsd, ms: Date.now() - started, status: summary ? "ok" : "empty", trace: { job: "consolidate-week", period } });
    return { status: summary ? "ok" : "error", facts: 0, period };
  } catch {
    return { status: "error", facts: 0, period };
  }
}

/** Cron entry, 02:00 to 04:00 local: summarise at most one unsummarised recent day per tick (newest first), then the week on Mondays. */
export async function nightly(ctx: Ctx): Promise<Consolidation | null> {
  const { db, now, off } = ctx;
  const m = ((now + off * 60000) / 60000) % 1440;
  if (m < 120 || m >= 240) return null;
  const today = Math.floor((now + off * 60000) / 86400000);
  const rows = await db.prepare("SELECT DISTINCT CAST((ts + ?) / 86400000 AS INTEGER) AS d FROM messages WHERE ts >= ? ORDER BY d DESC").bind(off * 60000, now - 8 * 86400000).all<{ d: number }>();
  for (const r of rows.results) {
    if (r.d >= today) continue; // today is still in progress
    const dayStart = r.d * 86400000 - off * 60000;
    const res = await consolidateDay(ctx, dayStart);
    if (res.status !== "skip") return res;
  }
  if (new Date(now + off * 60000).getUTCDay() === 1) {
    const done = await db.prepare("SELECT id FROM summaries WHERE kind = 'week' AND period = ?").bind(`week to ${fmtDate(now, off)}`).first();
    if (!done) return consolidateWeek(ctx);
  }
  return null;
}
