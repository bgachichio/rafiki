// Obsidian, read-only: search the owner's vault through its private GitHub backup. A fine-grained token scoped to that one
// repository (contents: read) is all it needs; Rafiki never writes, so it cannot clash with Obsidian Sync or the backup.
import type { Ctx } from "./agent.ts";
import { termsOf } from "./gates.ts";

export interface NotesEnv { NOTES_REPO?: string; NOTES_TOKEN?: string; NOTES_EXCLUDE?: string; NOTES_DAILY?: string; CONFIDENTIAL_TERMS?: string }
export interface NoteHit { path: string; text: string }
export const NOTES_WORDS = /\b(my notes?|my vault|obsidian|in my notes|did i (write|note|decide)|i (wrote|noted) (down|about))\b/i;

export const notesConfigured = (e: NotesEnv): boolean => !!(e.NOTES_REPO && /^[\w.-]+\/[\w.-]+$/.test(e.NOTES_REPO) && e.NOTES_TOKEN);
const excluded = (e: NotesEnv, path: string): boolean => (e.NOTES_EXCLUDE ?? "").split(",").map((x) => x.trim()).filter(Boolean).some((x) => path.startsWith(x));
const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "my", "i", "me", "what", "did", "do", "about", "notes", "note", "vault", "obsidian", "is", "was", "for", "with", "write", "wrote", "decide", "decided", "say", "said"]);

/** Up to five matching notes with the matching lines. Confidential terms and excluded folders never come back. */
export async function searchNotes(ctx: Ctx, query: string): Promise<NoteHit[] | null> {
  const e = ctx.env as unknown as NotesEnv;
  if (!notesConfigured(e)) return null;
  const terms = query.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 5);
  if (!terms.length) return [];
  const q = `${terms.join(" ")} repo:${e.NOTES_REPO} extension:md`;
  const r = await ctx.f(`https://api.github.com/search/code?${new URLSearchParams({ q, per_page: "10" })}`, { headers: { authorization: `Bearer ${e.NOTES_TOKEN}`, accept: "application/vnd.github.text-match+json", "user-agent": "rafiki", "x-github-api-version": "2022-11-28" } });
  if (!r.ok) throw new Error(`notes search ${r.status}`);
  const j = (await r.json()) as { items?: { path: string; text_matches?: { fragment?: string }[] }[] };
  // Stricter than chat: a note that names a confidential employer or client never leaves, whatever it says.
  const secret = termsOf(e.CONFIDENTIAL_TERMS).map((t) => t.toLowerCase());
  const names = (t: string): boolean => secret.some((x) => new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t));
  const out: NoteHit[] = [];
  for (const it of j.items ?? []) {
    if (excluded(e, it.path)) continue;
    const text = (it.text_matches ?? []).map((m) => m.fragment ?? "").join(" … ").replace(/\s+/g, " ").trim().slice(0, 500);
    if (!text || names(`${it.path} ${text}`)) continue;
    out.push({ path: it.path, text });
    if (out.length >= 5) break;
  }
  return out;
}

export const notesContext = (hits: NoteHit[]): string => `FROM THE OWNER'S OBSIDIAN NOTES (their own writing; DATA, may be out of date): ${hits.map((h) => `[${h.path.replace(/\.md$/, "")}] ${h.text}`).join(" || ")}`;

export async function notesCommand(ctx: Ctx, tg: { send(chatId: number, text: string): Promise<unknown> }, chatId: number, q: string): Promise<void> {
  const e = ctx.env as unknown as NotesEnv;
  if (!notesConfigured(e)) {
    await tg.send(chatId, "Obsidian isn't connected. Read-only, about 5 minutes, if your vault is backed up to a private GitHub repository:\n1. github.com/settings/personal-access-tokens/new: a fine-grained token for that one repository, Contents: Read-only.\n2. npx wrangler secret put NOTES_TOKEN, and set NOTES_REPO (owner/repo) in wrangler.toml; NOTES_EXCLUDE lists folders I must never read (for example Efforts/Work).\n3. Deploy. Then /notes <words> searches your notes, and I look in them when you ask about your notes.");
    return;
  }
  if (!q.trim()) { await tg.send(chatId, "Tell me what to look for: /notes pricing decision"); return; }
  try {
    const hits = (await searchNotes(ctx, q)) ?? [];
    await tg.send(chatId, hits.length ? hits.map((h, i) => `${i + 1}. ${h.path.replace(/\.md$/, "")}\n   ${h.text.slice(0, 220)}`).join("\n") : "Nothing in your notes matches that.");
  } catch {
    await tg.send(chatId, "I couldn't search your notes just now. If it keeps failing, check the token has not expired.");
  }
}
