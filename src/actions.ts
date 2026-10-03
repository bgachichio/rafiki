// Validate and execute the actions a model proposes. Only gate G0 and G1 actions exist; anything else is dropped.
import type { Db } from "./db.ts";
import { mayExecute } from "./gates.ts";
import { addFact, isCategory, type Category } from "./memory.ts";
import { feeFor, kes, type Tier } from "./spend.ts";
import { fmtDateTime, parseHM, parseLocalIso } from "./time.ts";

export type Action =
  | { type: "reminder"; text: string; dueMs: number; repeat: "none" | "daily" | "weekly" }
  | { type: "task_add"; text: string }
  | { type: "goal_add"; text: string; metric: string | null; target: string | null; by: string | null }
  | { type: "ledger_set"; prospect: string; rung: number; nextAsk: string | null }
  | { type: "spend"; amountCents: number; category: string; channel: string | null; note: string }
  | { type: "note"; text: string; category: Category }
  | { type: "set_setting"; key: "brief_time" | "quiet_start" | "quiet_end"; value: string }
  | { type: "poll"; question: string; options: string[] }
  | { type: "react"; emoji: string };

export interface ActionIO { poll?: (q: string, options: string[]) => Promise<string | null>; react?: (emoji: string) => Promise<void> }
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
        const repeat = o.repeat === "daily" || o.repeat === "weekly" ? o.repeat : "none";
        out.push({ type, text, dueMs: due, repeat });
        break;
      }
      case "task_add": {
        const text = str(o.text, 300);
        if (text) out.push({ type, text });
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

/** Execute and return one plain line per thing actually done, so the reply never claims more than happened. */
export async function executeActions(db: Db, actions: Action[], now: number, off: number, io?: ActionIO): Promise<string[]> {
  const done: string[] = [];
  for (const a of actions) {
    switch (a.type) {
      case "reminder":
        await db.prepare("INSERT INTO reminders (ts, text, due_ts, repeat) VALUES (?, ?, ?, ?)").bind(now, a.text, a.dueMs, a.repeat).run();
        done.push(`Reminder set for ${fmtDateTime(a.dueMs, off)}: ${a.text}`);
        break;
      case "task_add":
        await db.prepare("INSERT INTO tasks (ts, text) VALUES (?, ?)").bind(now, a.text).run();
        done.push(`Task added: ${a.text}`);
        break;
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
