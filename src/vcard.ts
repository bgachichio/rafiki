// Contacts from a .vcf file (Google Contacts and iCloud both export it). Names and birthdays by default; phone numbers and emails only if the owner says so.
import type { Ctx } from "./agent.ts";
import { setSetting } from "./db.ts";
import type { Telegram } from "./telegram.ts";
import { fmtDate } from "./time.ts";

export const MAX_CONTACTS = 2000;
export interface Contact { name: string; org: string; title: string; bday: { md: string; year: number | null } | null; tel: string; email: string }

function unfold(text: string): string[] { return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n"); }
const unesc = (s: string): string => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

function bday(v: string): Contact["bday"] {
  const m = /^(?:(\d{4})-?(\d{2})-?(\d{2})|--(\d{2})-?(\d{2}))/.exec(v.trim());
  if (!m) return null;
  const [y, mo, d] = m[1] ? [Number(m[1]), m[2]!, m[3]!] : [null, m[4]!, m[5]!];
  const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(mo) - 1];
  if (!maxDay || Number(d) < 1 || Number(d) > maxDay) return null; // a date that does not exist is not kept
  return { md: `${mo}-${d}`, year: y && y > 1900 ? y : null };
}

export function parseVcf(text: string): { contacts: Contact[]; skipped: number; truncated: boolean } {
  const out: Contact[] = [];
  let cur: Contact | null = null, skipped = 0, truncated = false;
  for (const line of unfold(text)) {
    const u = line.toUpperCase();
    if (u.startsWith("BEGIN:VCARD")) { cur = { name: "", org: "", title: "", bday: null, tel: "", email: "" }; continue; }
    if (u.startsWith("END:VCARD")) {
      if (cur) {
        if (cur.name) { if (out.length >= MAX_CONTACTS) truncated = true; else out.push(cur); } else skipped++;
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const i = line.indexOf(":");
    if (i < 1) continue;
    const key = line.slice(0, i).split(";")[0]!.toUpperCase().replace(/^ITEM\d+\./, "");
    const val = line.slice(i + 1);
    if (key === "FN") cur.name = unesc(val).slice(0, 80);
    else if (key === "N" && !cur.name) { const [fam, giv] = val.split(";"); cur.name = unesc(`${giv ?? ""} ${fam ?? ""}`).slice(0, 80); }
    else if (key === "ORG") cur.org = unesc(val.split(";")[0] ?? "").slice(0, 60);
    else if (key === "TITLE") cur.title = unesc(val).slice(0, 60);
    else if (key === "BDAY") cur.bday = bday(val);
    else if (key === "TEL" && !cur.tel) cur.tel = val.replace(/[^\d+]/g, "").slice(0, 20);
    else if (key === "EMAIL" && !cur.email) cur.email = unesc(val).slice(0, 80);
  }
  return { contacts: out, skipped, truncated };
}

export type Keep = "names" | "names_org" | "all";
const line = (c: Contact, keep: Keep, off: number): string => {
  const extra = [keep !== "names" && c.org ? c.org : "", keep !== "names" && c.title ? c.title : "", c.bday ? `birthday ${c.bday.md.split("-").reverse().join("-")}${c.bday.year ? `-${c.bday.year}` : ""}` : "", keep === "all" && c.tel ? c.tel : "", keep === "all" && c.email ? c.email : ""].filter(Boolean);
  void off;
  return `${c.name}${extra.length ? ` (${extra.join("; ")})` : ""}`;
};

/** Replace the earlier contacts import with this one: people as searchable facts, birthdays in their own table. */
export async function fileContacts(ctx: Ctx, contacts: Contact[], keep: Keep): Promise<{ facts: number; birthdays: number }> {
  const { db, now, off } = ctx;
  await db.prepare("DELETE FROM memory_fts WHERE kind = 'fact' AND ref_id IN (SELECT id FROM facts WHERE source LIKE 'contacts:%')").bind().run();
  await db.prepare("DELETE FROM facts WHERE source LIKE 'contacts:%'").bind().run();
  await db.prepare("DELETE FROM birthdays").bind().run();
  const sorted = [...contacts].sort((a, b) => a.name.localeCompare(b.name));
  const chunks: string[] = [];
  for (let i = 0; i < sorted.length; i += 12) chunks.push(`People in the owner's contacts: ${sorted.slice(i, i + 12).map((c) => line(c, keep, off)).join("; ")}`.slice(0, 1500));
  let facts = 0;
  for (let i = 0; i < chunks.length; i += 20) {
    const slice = chunks.slice(i, i + 20);
    const rows = await db.prepare(`INSERT INTO facts (ts, text, category, source, pinned) VALUES ${slice.map(() => "(?, ?, 'people', 'contacts:import', 0)").join(", ")} ON CONFLICT DO NOTHING RETURNING id, text`).bind(...slice.flatMap((t) => [now, t])).all<{ id: number; text: string }>();
    facts += rows.results.length;
    for (let j = 0; j < rows.results.length; j += 30) {
      const part = rows.results.slice(j, j + 30);
      await db.prepare(`INSERT INTO memory_fts (kind, ref_id, text) VALUES ${part.map(() => "('fact', ?, ?)").join(", ")}`).bind(...part.flatMap((r) => [r.id, r.text])).run();
    }
  }
  const withBday = sorted.filter((c) => c.bday).slice(0, 300);
  for (let i = 0; i < withBday.length; i += 33) {
    const slice = withBday.slice(i, i + 33);
    await db.prepare(`INSERT INTO birthdays (name, md, year) VALUES ${slice.map(() => "(?, ?, ?)").join(", ")} ON CONFLICT DO NOTHING`).bind(...slice.flatMap((c) => [c.name, c.bday!.md, c.bday!.year])).run();
  }
  return { facts, birthdays: withBday.length };
}

/** "Birthdays: Wanjiru today; Otieno tomorrow", or null. */
export async function birthdayLine(ctx: Ctx): Promise<string | null> {
  const today = fmtDate(ctx.now, ctx.off).slice(0, 5).split("-").reverse().join("-"); // DD-MM-YYYY -> MM-DD
  const tomorrow = fmtDate(ctx.now + 86400000, ctx.off).slice(0, 5).split("-").reverse().join("-");
  const r = await ctx.db.prepare("SELECT name, md FROM birthdays WHERE md IN (?, ?) ORDER BY name LIMIT 8").bind(today, tomorrow).all<{ name: string; md: string }>();
  if (!r.results.length) return null;
  const t = r.results.filter((b) => b.md === today).map((b) => `${b.name} today`);
  const n = r.results.filter((b) => b.md === tomorrow).map((b) => `${b.name} tomorrow`);
  return `Birthdays: ${[...t, ...n].join("; ")}`;
}

/** A contacts file arrived: keep the parsed list aside, and ask what to keep. */
export async function offerContacts(ctx: Ctx, tg: Telegram, chatId: number, text: string): Promise<void> {
  const { contacts, skipped, truncated } = parseVcf(text);
  if (!contacts.length) { await tg.send(chatId, "I could not find any contacts with a name in that file."); return; }
  await setSetting(ctx.db, "vc_pending", JSON.stringify(contacts.map((c) => [c.name, c.org, c.title, c.bday?.md ?? "", c.bday?.year ?? 0, c.tel, c.email])));
  const withB = contacts.filter((c) => c.bday).length;
  const { askDecision } = await import("./cards.ts");
  await askDecision(ctx, tg, chatId, "contacts.keep", { intro: `I found ${contacts.length} contacts${withB ? `, ${withB} with a birthday` : ""}${skipped ? `, and skipped ${skipped} with no name` : ""}${truncated ? ` (I took the first ${MAX_CONTACTS})` : ""}. A new file replaces the contacts I took from an earlier one.` });
}
