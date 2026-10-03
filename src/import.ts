// Memory import from another assistant. The paste is DATA. Parse, show a plan, file only after the owner confirms. Additive, with undo.
import type { Db } from "./db.ts";
import { classify } from "./gates.ts";
import type { Category } from "./memory.ts";
import { looksInjected } from "./skills.ts";

export const MAX_ITEMS = 200;
export const EXPORT_PROMPT = `Export everything you have stored about me and everything you have learned about me from our past conversations. Keep my own words wherever possible, especially for instructions and preferences.

Use these headings, in this order:
1. Instructions: rules I have asked you to follow (tone, format, "always", "never", corrections).
2. Identity: name, location, family and relationships, languages, interests.
3. Career: current and past roles, organisations, skills.
4. Projects: things I built or committed to; one entry per project with purpose, status and key decisions.
5. People: the people who matter to me, with their relationship to me.
6. Goals: what I am working toward, with numbers and dates where I gave them.
7. Routines and preferences: habits, schedule, tastes, how I like to work.
8. Money and health context I chose to share (short, factual).

One entry per line, oldest first, in the form:
[YYYY-MM-DD] - entry
Use [unknown] when you do not know the date. Put the whole export in one code block, and say after it whether this is the complete set.`;

export interface Item { section: string; category: Category; text: string; goal: boolean }
export interface Parsed { items: Item[]; dropped: number; private: number; truncated: boolean }

const SECTION_MAP: [RegExp, Category, boolean][] = [
  [/instruction/i, "instructions", false], [/identity|about me|personal/i, "other", false], [/career|work|employ|role/i, "work", false],
  [/project/i, "projects", false], [/people|relationship|family|contacts/i, "people", false], [/goal|ambition|aim/i, "projects", true],
  [/routine|habit|schedule/i, "routines", false], [/preference|taste|style/i, "preferences", false], [/money|financ/i, "money", false], [/health|fitness|wellbeing/i, "health", false],
];
function sectionOf(line: string): { name: string; category: Category; goal: boolean } | null {
  const t = line.replace(/[*#`_]/g, "").replace(/^\s*\d+[.)]\s*/, "").replace(/:\s*$/, "").trim();
  if (!t || t.length > 60 || /^\[/.test(t) || /^-/.test(t)) return null;
  for (const [re, category, goal] of SECTION_MAP) if (re.test(t) && t.split(/\s+/).length <= 7) return { name: t, category, goal };
  return null;
}

export function parseExport(text: string): Parsed {
  const items: Item[] = [];
  let cur: { name: string; category: Category; goal: boolean } = { name: "Other", category: "other", goal: false };
  let dropped = 0, priv = 0, truncated = false;
  for (const raw of text.replace(/```[a-z]*/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sec = sectionOf(line);
    if (sec && !/^\[\d{4}|^\[unknown\]/i.test(line)) { cur = sec; continue; }
    const m = /^(?:[-*•]\s*)?(?:\[(\d{4}-\d{2}-\d{2}|\d{4}-\d{2}|unknown)\]\s*[-–:]?\s*)?(.+)$/i.exec(line);
    if (!m) continue;
    const body = (m[2] ?? "").trim();
    if (body.length < 6 || /^(this is|that is|here is|here's|the above|complete set|more remain)/i.test(body)) continue;
    if (looksInjected(body) || /never (disagree|question|push back)|always agree|do not (question|challenge)|validate (me|everything)/i.test(body)) { dropped++; continue; }
    if (items.length >= MAX_ITEMS) { truncated = true; break; }
    const date = m[1] && m[1].toLowerCase() !== "unknown" ? ` (as of ${m[1]})` : "";
    if (classify(body) === "S2") priv++;
    items.push({ section: cur.name, category: cur.category, text: `${body}${date}`.slice(0, 300), goal: cur.goal });
  }
  return { items, dropped, private: priv, truncated };
}

export function planText(p: Parsed): string {
  const by: Record<string, number> = {};
  for (const i of p.items) by[i.category] = (by[i.category] ?? 0) + 1;
  const lines = [`I found ${p.items.length} entries${p.truncated ? ` (I took the first ${MAX_ITEMS}; send the rest as a second import)` : ""}:`, Object.entries(by).map(([k, v]) => `${v} ${k}`).join(", ") + "."];
  if (p.private) lines.push(`${p.private} touch money, health or family. I keep them all, as private.`);
  if (p.dropped) lines.push(`I dropped ${p.dropped} line${p.dropped === 1 ? "" : "s"} that read as instructions aimed at me, not facts about you.`);
  lines.push("Nothing is filed until you tap File it. Anything already known is skipped, and you can undo the whole import.");
  return lines.join("\n");
}

/** File the plan in a few multi-row statements (D1 allows 100 bound parameters and 50 queries per request). */
export async function fileImport(db: Db, now: number, source: string, p: Parsed): Promise<{ id: number; added: number }> {
  const imp = await db.prepare("INSERT INTO imports (ts, source, status, counts) VALUES (?, ?, 'filed', ?) RETURNING id").bind(now, source, JSON.stringify({ items: p.items.length, dropped: p.dropped })).first<{ id: number }>();
  const id = Number(imp?.id);
  let added = 0;
  const src = `import:${id}`;
  for (let i = 0; i < p.items.length; i += 20) {
    const slice = p.items.slice(i, i + 20);
    const rows = await db.prepare(`INSERT INTO facts (ts, text, category, source, pinned) VALUES ${slice.map(() => "(?, ?, ?, ?, 0)").join(", ")} ON CONFLICT DO NOTHING RETURNING id, text`)
      .bind(...slice.flatMap((it) => [now, it.goal ? `Goal: ${it.text}` : it.text, it.category, src])).all<{ id: number; text: string }>();
    added += rows.results.length;
    for (let j = 0; j < rows.results.length; j += 30) {
      const part = rows.results.slice(j, j + 30);
      await db.prepare(`INSERT INTO memory_fts (kind, ref_id, text) VALUES ${part.map(() => "('fact', ?, ?)").join(", ")}`).bind(...part.flatMap((r) => [r.id, r.text])).run();
    }
  }
  await db.prepare("UPDATE imports SET counts = ? WHERE id = ?").bind(JSON.stringify({ items: p.items.length, added, dropped: p.dropped }), id).run();
  return { id, added };
}

export async function undoImport(db: Db, id: number): Promise<number> {
  const imp = await db.prepare("SELECT status FROM imports WHERE id = ?").bind(id).first<{ status: string }>();
  if (!imp || imp.status === "undone") return -1;
  await db.prepare("DELETE FROM memory_fts WHERE kind = 'fact' AND ref_id IN (SELECT id FROM facts WHERE source = ?)").bind(`import:${id}`).run();
  const r = await db.prepare("DELETE FROM facts WHERE source = ? RETURNING id").bind(`import:${id}`).all<{ id: number }>();
  await db.prepare("UPDATE imports SET status = 'undone' WHERE id = ?").bind(id).run();
  return r.results.length;
}
