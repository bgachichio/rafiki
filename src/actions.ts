// Validate and execute the actions a model proposes. Only gate G0 and G1 actions exist; anything else is dropped.
import type { Db } from "./db.ts";
import { mayExecute } from "./gates.ts";
import { addFact, isCategory, isHedged, type Category } from "./memory.ts";
import { DEFAULT_POLICY, type Policy } from "./policy.ts";
import { closeMatching, type CloseKind } from "./lifecycle.ts";
import { isRepeat, rescheduleMatching, type Repeat } from "./remind.ts";
import { feeFor, kes, type Tier } from "./spend.ts";
import { fmtDateTime, parseHM, parseLocalIso } from "./time.ts";

export type Action =
  | { type: "reminder"; text: string; dueMs: number; repeat: Repeat; kind: "event" | "task" | "deadline" }
  | { type: "reschedule"; match: string; dueMs: number }
  | { type: "task_add"; text: string }
  | { type: "close"; kind: CloseKind; match: string; state: "done" | "dropped" }
  | { type: "goal_add"; text: string; metric: string | null; target: string | null; by: string | null }
  | { type: "ledger_set"; prospect: string; rung: number; nextAsk: string | null }
  | { type: "spend"; amountCents: number; category: string; channel: string | null; note: string }
  | { type: "note"; text: string; category: Category }
  | { type: "set_setting"; key: "brief_time" | "quiet_start" | "quiet_end"; value: string }
  | { type: "poll"; question: string; options: string[] }
  | { type: "react"; emoji: string }
  | { type: "calendar_link"; title: string; startMs: number; endMs: number; location: string | null }
  | { type: "zap"; tool: string; goal: string };

export interface ActionIO { attach?: { kind: string; fileId: string; name: string }; calendarLink?: (e: { title: string; startMs: number; endMs: number; location: string | null }) => Promise<void>; poll?: (q: string, options: string[]) => Promise<string | null>; react?: (emoji: string) => Promise<void> }
const REACTIONS = ["👍", "❤", "🔥", "🙏", "🎉", "👀"];

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, max) : null);

export function validateActions(raw: unknown, now: number, off: number): Action[] {
  if (!Array.isArray(raw)) return [];
  const out: Action[] = [];
  for (const a of raw.slice(0, 8)) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    const type = typeof o.type === "string" ? o.type : "";
    if (!mayExecute(type)) continue;
    switch (type) {
      case "reminder": {
        const text = str(o.text, 300);
        const due = typeof o.due === "string" ? parseLocalIso(o.due, off) : null;
        if (!text || due === null || due < now - 60000) break;
        const repeat: Repeat = isRepeat(o.repeat) ? o.repeat : "none";
        out.push({ type, text, dueMs: due, repeat, kind: o.kind === "event" ? "event" : o.kind === "deadline" ? "deadline" : "task" });
        break;
      }
      case "reschedule": {
        const match = str(o.match, 120);
        const due = typeof o.due === "string" ? parseLocalIso(o.due, off) : null;
        if (match && due !== null && due > now + 60000) out.push({ type, match, dueMs: due });
        break;
      }
      case "task_add": {
        const text = str(o.text, 300);
        if (text) out.push({ type, text });
        break;
      }
      case "close": {
        const match = str(o.match, 120);
        const kind = o.kind === "goal" || o.kind === "reminder" || o.kind === "task" ? o.kind : null;
        if (match && kind) out.push({ type, kind, match, state: o.state === "done" ? "done" : "dropped" });
        break;
      }
      case "goal_add": {
        const text = str(o.text, 300);
        const by = str(o.by, 10);
        if (text) out.push({ type, text, metric: str(o.metric, 80), target: str(o.target, 80), by: by && /^\d{2}-\d{2}-\d{4}$/.test(by) ? by : null });
        break;
      }
      case "ledger_set": {
        const prospect = str(o.prospect, 80);
        const rung = typeof o.rung === "number" ? Math.trunc(o.rung) : NaN;
        if (prospect && rung >= 0 && rung <= 5) out.push({ type, prospect, rung, nextAsk: str(o.next_ask, 200) });
        break;
      }
      case "spend": {
        const amt = typeof o.amount === "number" ? o.amount : NaN;
        const ch = typeof o.channel === "string" && ["mpesa", "cash", "card", "bank"].includes(o.channel) ? o.channel : null;
        if (amt > 0 && amt < 1e9) out.push({ type, amountCents: Math.round(amt * 100), category: str(o.category, 40) ?? "Other", channel: ch, note: str(o.note, 100) ?? "" });
        break;
      }
      case "note": {
        const text = str(o.text, 300);
        if (text) out.push({ type, text, category: isCategory(o.category) ? o.category : "other" });
        break;
      }
      case "poll": {
        const question = str(o.question, 255);
        const options = Array.isArray(o.options) ? o.options.map((x) => str(x, 100)).filter((x): x is string => x !== null) : [];
        if (question && options.length >= 2 && options.length <= 10) out.push({ type, question, options });
        break;
      }
      case "calendar_link": {
        const title = str(o.title, 100);
        const start = typeof o.start === "string" ? parseLocalIso(o.start, off) : null;
        const end = typeof o.end === "string" ? parseLocalIso(o.end, off) : null;
        if (!title || start === null || start < now - 60000) break;
        out.push({ type, title, startMs: start, endMs: end !== null && end > start ? end : start + 3600000, location: str(o.location, 100) });
        break;
      }
      case "zap": {
        const tool = str(o.tool, 120);
        const goal = str(o.goal, 1500);
        if (tool && goal && /^[\w.-]+$/.test(tool)) out.push({ type, tool, goal });
        break;
      }
      case "react": {
        if (typeof o.emoji === "string" && REACTIONS.includes(o.emoji)) out.push({ type, emoji: o.emoji });
        break;
      }
      case "set_setting": {
        const key = o.key;
        const value = str(o.value, 5);
        if ((key === "brief_time" || key === "quiet_start" || key === "quiet_end") && value && parseHM(value) !== null) out.push({ type, key, value });
        break;
      }
    }
  }
  return out;
}

export async function loadTiers(db: Db): Promise<Tier[]> {
  const r = await db.prepare("SELECT channel, min_cents, max_cents, fee_cents FROM fee_tiers").bind().all<Tier>();
  return r.results;
}

const inText = (l: number): string => (l % 1440 === 0 ? `in ${l / 1440} day${l === 1440 ? "" : "s"}` : l % 60 === 0 ? `in ${l / 60} hour${l === 60 ? "" : "s"}` : `in ${l} minutes`);

/** Execute and return one plain line per thing actually done, so the reply never claims more than happened. */
export async function executeActions(db: Db, actions: Action[], now: number, off: number, io?: ActionIO, policy: Policy = DEFAULT_POLICY): Promise<string[]> {
  const done: string[] = [];
  for (const a of actions) {
    switch (a.type) {
      case "reminder": {
        // An event gets the owner's lead times (a heads-up each, sent once); a task gets one reminder with the owner's chase rules.
        // A deadline (a bill, a fee, a filing) also gets a warning a day ahead; a plain task gets one reminder.
        const leads = a.kind === "event" ? policy.eventLeads : a.kind === "deadline" ? [1440, 0] : [0];
        const slots = leads.map((l) => ({ lead: l, due: a.dueMs - l * 60000 })).filter((x) => x.lead === 0 || x.due > now + 60000);
        if (!slots.some((x) => x.lead === 0) && !slots.length) slots.push({ lead: 0, due: a.dueMs });
        for (const x of slots) {
          const main = x.lead === 0;
          const r = await db.prepare("INSERT INTO reminders (ts, text, due_ts, repeat) VALUES (?, ?, ?, ?) RETURNING id").bind(now, main ? a.text : `Coming up ${inText(x.lead)}: ${a.text}`, x.due, main ? a.repeat : "none").first<{ id: number }>();
          const mode = main ? policy.mode : "once";
          await db.prepare("INSERT INTO reminder_policy (reminder_id, mode, gap_ms, max_chase) VALUES (?, ?, ?, ?)").bind(Number(r?.id), mode, Math.round(policy.gapH * 3600000), policy.max).run();
          if (main && io?.attach) await db.prepare("INSERT OR REPLACE INTO reminder_attach (reminder_id, kind, file_id, name) VALUES (?, ?, ?, ?)").bind(Number(r?.id), io.attach.kind, io.attach.fileId, io.attach.name).run();
        }
        if (io?.attach) a.text = `${a.text} (with ${io.attach.name})`;
        done.push(slots.length === 1 ? `Reminder set for ${fmtDateTime(slots[0]!.due, off)}: ${a.text}` : `Reminders set for ${slots.map((x) => fmtDateTime(x.due, off)).join(", ")}: ${a.text}`);
        break;
      }
      case "task_add":
        await db.prepare("INSERT INTO tasks (ts, text) VALUES (?, ?)").bind(now, a.text).run();
        done.push(`Task added: ${a.text}`);
        break;
      case "reschedule": {
        const hit = await rescheduleMatching(db, a.match, a.dueMs);
        done.push(hit.length ? `Moved to ${fmtDateTime(a.dueMs, off)}: ${hit.join("; ")}` : `No open reminder matches "${a.match}".`);
        break;
      }
      case "close": {
        const hit = await closeMatching(db, a.kind, a.match, a.state);
        done.push(hit.length ? `${a.state === "done" ? "Marked done" : "Closed for good"}: ${hit.join("; ")}` : `No open ${a.kind} matches "${a.match}".`);
        break;
      }
      case "goal_add": {
        // The model sometimes restates a goal it already holds: update it instead of saving a duplicate.
        const same = await db.prepare("SELECT id FROM goals WHERE state = 'open' AND lower(text) = lower(?)").bind(a.text).first<{ id: number }>();
        if (same) {
          await db.prepare("UPDATE goals SET metric = COALESCE(?, metric), target = COALESCE(?, target), by_date = COALESCE(?, by_date) WHERE id = ?").bind(a.metric, a.target, a.by, same.id).run();
          done.push(`Goal updated: ${a.text}${a.by ? ` by ${a.by}` : ""}`);
        } else {
          await db.prepare("INSERT INTO goals (ts, text, metric, target, by_date) VALUES (?, ?, ?, ?, ?)").bind(now, a.text, a.metric, a.target, a.by).run();
          done.push(`Goal saved: ${a.text}${a.by ? ` by ${a.by}` : ""}`);
        }
        break;
      }
      case "ledger_set":
        await db.prepare("INSERT INTO ledger (prospect, rung, next_ask, last_move_ts) VALUES (?, ?, ?, ?) ON CONFLICT(prospect) DO UPDATE SET rung = excluded.rung, next_ask = excluded.next_ask, last_move_ts = excluded.last_move_ts").bind(a.prospect, a.rung, a.nextAsk, now).run();
        done.push(`Ledger: ${a.prospect} at rung ${a.rung}`);
        break;
      case "spend": {
        const fee = feeFor(await loadTiers(db), a.channel, a.amountCents) ?? 0;
        await db.prepare("INSERT INTO spends (ts, amount_cents, fee_cents, category, channel, note) VALUES (?, ?, ?, ?, ?, ?)").bind(now, a.amountCents, fee, a.category, a.channel, a.note).run();
        done.push(`Logged ${kes(a.amountCents)} ${a.category}${fee ? ` (fee ${kes(fee)})` : ""}`);
        break;
      }
      case "note":
        if (isHedged(a.text)) { done.push("Not saved: that was a guess, not something you told me."); break; }
        done.push((await addFact(db, now, a.text, a.category, "chat")) !== null ? "Noted." : "Already knew that.");
        break;
      case "poll": {
        const id = io?.poll ? await io.poll(a.question, a.options) : null;
        if (id) {
          await db.prepare("INSERT INTO polls (poll_id, question, options, ts) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(id, a.question, JSON.stringify(a.options), now).run();
          done.push(`Poll sent: ${a.question}`);
        }
        break;
      }
      case "calendar_link":
        if (io?.calendarLink) { await io.calendarLink(a); done.push(`Add-to-calendar link ready: ${a.title}, ${fmtDateTime(a.startMs, off)}`); }
        break;
      case "react":
        if (io?.react) await io.react(a.emoji);
        break;
      case "set_setting":
        await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(a.key, a.value).run();
        done.push(`Setting ${a.key} is now ${a.value}`);
        break;
    }
  }
  return done;
}
