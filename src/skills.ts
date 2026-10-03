// Skills files: the owner's own playbooks. Imported by upload only, split by heading, indexed, and retrieved by section.
// A skill shapes how Rafiki advises. It can never add a tool or widen what Rafiki may do: actions are validated in code.
import type { Db } from "./db.ts";
import { getSetting, setSetting } from "./db.ts";
import { STARTER_SKILLS } from "./starter.gen.ts";

export const MAX_PER_BATCH = 30;
export const MAX_TOTAL = 100;
export const MAX_FILE_BYTES = 200_000;

const INJECTION = /ignore (all |any |your |the )?(previous|prior|above|earlier) (instructions|rules|messages)|reveal (your |the )?system prompt|you must (always )?(obey|comply)|disregard (your|the) (rules|instructions)|jailbreak|developer mode|do anything now/i;
export const looksInjected = (line: string): boolean => INJECTION.test(line);

export interface ParsedSkill { name: string; description: string; version: string | null; sections: { heading: string; body: string }[]; flags: number }

export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!.toLowerCase()] = (kv[2] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: text.slice(m[0].length) };
}
export const hasSkillFrontmatter = (text: string): boolean => {
  const { meta } = parseFrontmatter(text);
  return !!meta.name && !!meta.description;
};

export async function sha256(text: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseSkill(filename: string, text: string): ParsedSkill {
  const { meta, body } = parseFrontmatter(text);
  const base = filename.replace(/\.[A-Za-z0-9]+$/, "").replace(/-?SKILL$/i, "").trim();
  const sections: { heading: string; body: string }[] = [];
  let heading = "Overview";
  let buf: string[] = [];
  let fence = false;
  let firstHeading: string | null = null;
  const flush = (): void => {
    const b = buf.join("\n").trim();
    if (b && sections.length < 150) sections.push({ heading, body: b.slice(0, 6000) });
    buf = [];
  };
  for (const line of body.split(/\r?\n/)) {
    if (/^```/.test(line.trim())) fence = !fence;
    const h = fence ? null : /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (h) {
      if (!firstHeading && h[1] === "#") firstHeading = h[2]!;
      flush();
      heading = h[2]!.slice(0, 120);
    } else buf.push(line);
  }
  flush();
  return {
    name: (meta.name || base || firstHeading || "skill").slice(0, 80),
    description: (meta.description ?? "").slice(0, 600),
    version: meta.version ? meta.version.slice(0, 20) : null,
    sections,
    flags: body.split(/\r?\n/).filter(looksInjected).length,
  };
}

export type ImportResult = { ok: true; name: string; sections: number; status: "added" | "updated" | "same"; flags: number } | { ok: false; why: string };

/** Add or update one skill. Re-importing an unchanged file is a no-op; a changed file replaces the old sections. */
export async function importSkill(db: Db, now: number, filename: string, text: string): Promise<ImportResult> {
  if (text.length > MAX_FILE_BYTES) return { ok: false, why: `${filename} is over ${MAX_FILE_BYTES / 1000} KB. Split it into smaller files.` };
  const sk = parseSkill(filename, text);
  if (!sk.sections.length) return { ok: false, why: `${filename} has no readable content.` };
  const hash = await sha256(text);
  const existing = await db.prepare("SELECT id, hash FROM skills WHERE name = ?").bind(sk.name).first<{ id: number; hash: string }>();
  if (existing && existing.hash === hash) return { ok: true, name: sk.name, sections: sk.sections.length, status: "same", flags: sk.flags };
  if (!existing) {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM skills").bind().first<{ n: number }>();
    if (Number(n?.n ?? 0) >= MAX_TOTAL) return { ok: false, why: `You already have ${MAX_TOTAL} skills, the most I hold. Remove one with /skill remove <name> first.` };
  }
  let id: number;
  if (existing) {
    id = existing.id;
    await removeSections(db, id);
    await db.prepare("UPDATE skills SET description = ?, version = ?, source = ?, hash = ?, ts = ?, nsections = ? WHERE id = ?").bind(sk.description, sk.version, filename, hash, now, sk.sections.length, id).run();
  } else {
    const r = await db.prepare("INSERT INTO skills (name, description, version, source, hash, ts, nsections) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id").bind(sk.name, sk.description, sk.version, filename, hash, now, sk.sections.length).first<{ id: number }>();
    id = Number(r?.id);
  }
  for (let i = 0; i < sk.sections.length; i += 30) {
    const slice = sk.sections.slice(i, i + 30);
    const rows = await db.prepare(`INSERT INTO skill_sections (skill_id, heading, body) VALUES ${slice.map(() => "(?, ?, ?)").join(", ")} RETURNING id`).bind(...slice.flatMap((s) => [id, s.heading, s.body])).all<{ id: number }>();
    const ids = rows.results.map((r) => r.id);
    await db.prepare(`INSERT INTO memory_fts (kind, ref_id, text) VALUES ${slice.map(() => "('skill', ?, ?)").join(", ")}`).bind(...slice.flatMap((s, j) => [ids[j] ?? 0, `${sk.name} > ${s.heading}: ${s.body.slice(0, 3000)}`])).run();
  }
  return { ok: true, name: sk.name, sections: sk.sections.length, status: existing ? "updated" : "added", flags: sk.flags };
}

async function removeSections(db: Db, skillId: number): Promise<void> {
  await db.prepare("DELETE FROM memory_fts WHERE kind = 'skill' AND ref_id IN (SELECT id FROM skill_sections WHERE skill_id = ?)").bind(skillId).run();
  await db.prepare("DELETE FROM skill_sections WHERE skill_id = ?").bind(skillId).run();
}
export async function removeSkill(db: Db, name: string): Promise<boolean> {
  const s = await db.prepare("SELECT id FROM skills WHERE lower(name) = lower(?)").bind(name.trim()).first<{ id: number }>();
  if (!s) return false;
  await removeSections(db, s.id);
  await db.prepare("DELETE FROM skills WHERE id = ?").bind(s.id).run();
  return true;
}
export async function setSkillEnabled(db: Db, name: string, on: boolean): Promise<boolean> {
  const r = await db.prepare("UPDATE skills SET enabled = ? WHERE lower(name) = lower(?) RETURNING id").bind(on ? 1 : 0, name.trim()).first();
  return !!r;
}

export interface SkillHit { name: string; heading: string; body: string }
/** The best matching sections of enabled skills for this question, trimmed to a token budget. */
export async function recallSkills(db: Db, query: string, ftsQ: string | null, limit = 3, maxChars = 4000): Promise<SkillHit[]> {
  if (!ftsQ) return [];
  const r = await db.prepare(
    `SELECT s.name AS name, sec.heading AS heading, sec.body AS body, bm25(memory_fts) AS rank
       FROM memory_fts
       JOIN skill_sections sec ON memory_fts.kind = 'skill' AND sec.id = memory_fts.ref_id
       JOIN skills s ON s.id = sec.skill_id AND s.enabled = 1
      WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?`,
  ).bind(ftsQ, limit).all<SkillHit>();
  const out: SkillHit[] = [];
  let used = 0;
  for (const h of r.results) {
    const body = h.body.slice(0, Math.max(400, Math.floor(maxChars / limit)));
    if (used + body.length > maxChars) break;
    used += body.length;
    out.push({ ...h, body });
  }
  void query;
  return out;
}

// ---- the Starter Pack: general playbooks that ship with Rafiki. The owner's own skills replace them by name. ---------------------

export const isStarter = (source: string): boolean => source.startsWith("starter/");

/** Put the Starter Pack in place. A skill the owner removed stays removed, and one they replaced is left alone; an unchanged-by-owner one is refreshed when the pack improves. */
export async function installStarter(db: Db, now: number): Promise<number> {
  const removed = new Set(JSON.parse((await getSetting(db, "starter_removed")) || "[]") as string[]);
  let n = 0;
  for (const [file, text] of STARTER_SKILLS) {
    const name = parseSkill(file, text).name;
    if (removed.has(name)) continue;
    const have = await db.prepare("SELECT source FROM skills WHERE name = ?").bind(name).first<{ source: string }>();
    if (have && !isStarter(have.source)) continue; // the owner replaced it
    const r = await importSkill(db, now, `starter/${file}`, text);
    if (r.ok && r.status !== "same") n++;
  }
  return n;
}

export async function markStarterRemoved(db: Db, name: string): Promise<void> {
  const removed = new Set(JSON.parse((await getSetting(db, "starter_removed")) || "[]") as string[]);
  removed.add(name);
  await setSetting(db, "starter_removed", JSON.stringify([...removed]));
}
export async function restoreStarter(db: Db, now: number): Promise<number> {
  await setSetting(db, "starter_removed", "[]");
  // restoring also puts back a starter skill the owner replaced? No: a replacement is theirs. Only missing ones return.
  return installStarter(db, now);
}
