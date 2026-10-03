// Everything that is not plain text: voice notes, photos, files, video, locations, contacts. Each is turned into text first,
// then handled by the normal agent turn, so memory, search, privacy routing and actions work exactly as for typed text.
import type { Ctx } from "./agent.ts";
import { addFact } from "./memory.ts";
import { chat, CreditError, LlmError, type Part } from "./llm.ts";
import type { Telegram, TgFile, TgMessage } from "./telegram.ts";
import { fmtDate } from "./time.ts";

/** Free-plan Workers allow about 10 ms of CPU per request, and base64 encoding costs CPU. These caps keep each request inside it.
 *  Set MEDIA_SCALE (for example 10) in wrangler.toml after moving to the paid Workers plan to lift them. */
export const BASE_LIMITS = { voice: 400_000, photo: 600_000, pdf: 600_000, video: 1_500_000, text: 200_000 } as const;
export type MediaKind = keyof typeof BASE_LIMITS;
export function limit(env: { MEDIA_SCALE?: string }, k: MediaKind): number {
  const s = Number(env.MEDIA_SCALE);
  return BASE_LIMITS[k] * (Number.isFinite(s) && s >= 1 ? Math.min(s, 40) : 1);
}

export function b64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

export const AUDIO_FORMAT: Record<string, string> = { "audio/ogg": "ogg", "audio/opus": "ogg", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/flac": "flac" };

export interface MediaEnv { MODEL_MEDIA?: string; MODEL_FAST: string; MEDIA_SCALE?: string; AI?: { run(model: string, input: unknown): Promise<{ text?: string }> } }
const mediaModel = (env: MediaEnv): string => env.MODEL_MEDIA ?? env.MODEL_FAST;

type Got = { ok: true; bytes: Uint8Array } | { ok: false; why: string };
async function fetchFile(ctx: Ctx, tg: Telegram, f: TgFile, kind: MediaKind, label: string): Promise<Got> {
  const max = limit(ctx.env as MediaEnv, kind);
  if ((f.file_size ?? 0) > 20_000_000) return { ok: false, why: "Telegram only lets bots download files up to 20 MB." };
  if ((f.file_size ?? 0) > max) return { ok: false, why: `That ${label} is ${Math.round((f.file_size ?? 0) / 1000)} KB, over the ${Math.round(max / 1000)} KB I can handle on my current hosting plan. Send a shorter one, or move Rafiki to the paid Cloudflare Workers plan and set MEDIA_SCALE to lift the limit.` };
  const bytes = await tg.download(f.file_id);
  if (!bytes) return { ok: false, why: `I could not download that ${label} from Telegram. Please try again.` };
  if (bytes.length > max) return { ok: false, why: `That ${label} is over the ${Math.round(max / 1000)} KB I can handle right now.` };
  return { ok: true, bytes };
}

async function ask(ctx: Ctx, parts: Part[], maxTokens = 900): Promise<string> {
  const r = await chat(ctx.env, ctx.f, { sens: "S2", deep: false, maxTokens, model: mediaModel(ctx.env as MediaEnv), messages: [{ role: "user", content: parts }] });
  return r.text.trim();
}

export type Out = { ok: true; text: string } | { ok: false; why: string };
const fail = (e: unknown, what: string): Out => ({ ok: false, why: e instanceof CreditError ? "I'm out of model credit, so I can't process that right now." : e instanceof LlmError ? `I couldn't process that ${what} just now. Please try again, or type it.` : `Something went wrong reading that ${what}.` });

/** Voice notes and audio files: transcribe verbatim. Tries the media model first, then Workers AI Whisper if configured. */
export async function transcribe(ctx: Ctx, tg: Telegram, f: TgFile): Promise<Out> {
  const got = await fetchFile(ctx, tg, f, "voice", "voice note");
  if (!got.ok) return { ok: false, why: got.why };
  const format = AUDIO_FORMAT[f.mime_type ?? "audio/ogg"] ?? "ogg";
  try {
    const text = await ask(ctx, [{ type: "text", text: "Transcribe this audio verbatim in its original language. Output only the transcript, with no commentary." }, { type: "input_audio", input_audio: { data: b64(got.bytes), format } }], 1200);
    if (text) return { ok: true, text };
  } catch (e) {
    if (e instanceof CreditError) return fail(e, "voice note");
  }
  const ai = (ctx.env as MediaEnv).AI;
  if (ai) {
    try {
      const r = await ai.run("@cf/openai/whisper-large-v3-turbo", { audio: b64(got.bytes) });
      if (r.text?.trim()) return { ok: true, text: r.text.trim() };
    } catch { /* fall through */ }
  }
  return { ok: false, why: "I couldn't make out that voice note. Please try again, or type it." };
}

export async function seeImage(ctx: Ctx, tg: Telegram, photo: TgFile[]): Promise<Out> {
  // Telegram sends several sizes; take the largest that fits the cap.
  const max = limit(ctx.env as MediaEnv, "photo");
  const pick = [...photo].reverse().find((p) => (p.file_size ?? 0) <= max) ?? photo[0];
  if (!pick) return { ok: false, why: "I couldn't read that photo." };
  const got = await fetchFile(ctx, tg, pick, "photo", "photo");
  if (!got.ok) return { ok: false, why: got.why };
  try {
    const text = await ask(ctx, [{ type: "text", text: "Describe this image precisely and extract every piece of readable text and every number (for a receipt: merchant, date, items, total, payment method). Be factual. If it is a screenshot of a conversation, transcribe the messages." }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64(got.bytes)}` } }]);
    return text ? { ok: true, text } : { ok: false, why: "I couldn't read anything in that image." };
  } catch (e) { return fail(e, "image"); }
}

export async function seeVideo(ctx: Ctx, tg: Telegram, f: TgFile): Promise<Out> {
  const got = await fetchFile(ctx, tg, f, "video", "video");
  if (!got.ok) return { ok: false, why: got.why };
  try {
    const text = await ask(ctx, [{ type: "text", text: "Describe what happens in this video and transcribe any speech verbatim. Be factual and brief." }, { type: "video_url", video_url: { url: `data:video/mp4;base64,${b64(got.bytes)}` } }], 1200);
    return text ? { ok: true, text } : { ok: false, why: "I couldn't make anything out in that video." };
  } catch (e) { return fail(e, "video"); }
}

const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|log|yaml|yml|xml|html?|rtf)$/i;
export const isTextFile = (f: TgFile): boolean => (f.mime_type ?? "").startsWith("text/") || f.mime_type === "application/json" || TEXT_EXT.test(f.file_name ?? "");
export const isPdf = (f: TgFile): boolean => f.mime_type === "application/pdf" || /\.pdf$/i.test(f.file_name ?? "");

/** Text-like files are read directly (no model). PDFs go to the media model. Other formats get a clear answer. */
export async function readFile(ctx: Ctx, tg: Telegram, f: TgFile): Promise<Out> {
  if (isTextFile(f)) {
    const got = await fetchFile(ctx, tg, f, "text", "file");
    if (!got.ok) return { ok: false, why: got.why };
    return { ok: true, text: new TextDecoder("utf-8").decode(got.bytes) };
  }
  if (isPdf(f)) {
    const got = await fetchFile(ctx, tg, f, "pdf", "PDF");
    if (!got.ok) return { ok: false, why: got.why };
    try {
      const text = await ask(ctx, [{ type: "text", text: "Extract the text of this document faithfully, keeping headings and any tables as simple lines. If it is longer than about 5,000 words, give the full text of the first part and then a summary of the rest." }, { type: "file", file: { filename: f.file_name ?? "document.pdf", file_data: `data:application/pdf;base64,${b64(got.bytes)}` } }], 4000);
      return text ? { ok: true, text } : { ok: false, why: "I couldn't read any text in that PDF." };
    } catch (e) { return fail(e, "PDF"); }
  }
  return { ok: false, why: "I can read text files (.md, .txt, .csv, .json) and PDFs. For Word or Excel files, please save as PDF or paste the text." };
}

/** Keep a file's text in permanent, searchable memory (chunked). Returns the chunk count. */
export async function storeDoc(ctx: Ctx, name: string, mime: string | undefined, bytes: number, text: string): Promise<number> {
  const body = text.slice(0, 200_000);
  const r = await ctx.db.prepare("INSERT INTO docs (ts, name, mime, bytes, text) VALUES (?, ?, ?, ?, ?) RETURNING id").bind(ctx.now, name.slice(0, 120), mime ?? null, bytes, body).first<{ id: number }>();
  if (!r) return 0;
  const chunks: string[] = [];
  for (let i = 0; i < body.length && chunks.length < 60; i += 1200) chunks.push(`${name}: ${body.slice(i, i + 1200)}`);
  for (let i = 0; i < chunks.length; i += 30) {
    const slice = chunks.slice(i, i + 30);
    await ctx.db.prepare(`INSERT INTO memory_fts (kind, ref_id, text) VALUES ${slice.map(() => "('doc', ?, ?)").join(", ")}`).bind(...slice.flatMap((c) => [r.id, c])).run();
  }
  return chunks.length;
}

// ---- location ----------------------------------------------------------------------------------------------------------
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000, rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
export interface Pt { lat: number; lng: number }
export function nearest(p: Pt, places: { name: string; lat: number; lng: number }[]): { name: string; m: number } | null {
  let best: { name: string; m: number } | null = null;
  for (const pl of places) { const m = haversineM(p, pl); if (!best || m < best.m) best = { name: pl.name, m }; }
  return best;
}
export function describePlace(p: Pt, places: { name: string; lat: number; lng: number }[]): string {
  const n = nearest(p, places);
  if (!n) return `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
  return n.m <= 150 ? `at ${n.name}` : `${n.m < 1000 ? `${Math.round(n.m)} m` : `${(n.m / 1000).toFixed(1)} km`} from ${n.name}`;
}
/** Store a position. A new row is written only if it moved more than 100 m or 10 minutes passed, so live location stays cheap. */
export async function recordLocation(ctx: Ctx, lat: number, lng: number, live: boolean): Promise<boolean> {
  const last = await ctx.db.prepare("SELECT ts, lat, lng FROM locations ORDER BY id DESC LIMIT 1").bind().first<{ ts: number; lat: number; lng: number }>();
  if (last && haversineM({ lat, lng }, last) < 100 && ctx.now - last.ts < 600000) return false;
  await ctx.db.prepare("INSERT INTO locations (ts, lat, lng, live) VALUES (?, ?, ?, ?)").bind(ctx.now, lat, lng, live ? 1 : 0).run();
  return true;
}
export async function savePlace(ctx: Ctx, name: string): Promise<string> {
  const last = await ctx.db.prepare("SELECT lat, lng FROM locations ORDER BY id DESC LIMIT 1").bind().first<{ lat: number; lng: number }>();
  if (!last) return "Share your location with me first (paperclip, then Location), then send /place home.";
  const n = name.trim().toLowerCase().slice(0, 40);
  await ctx.db.prepare("INSERT INTO places (name, lat, lng, ts) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, ts = excluded.ts").bind(n, last.lat, last.lng, ctx.now).run();
  return `Saved "${n}" at your last shared location. I'll recognise when you're there.`;
}

export const LOCATION_WORDS = /\b(where|near|nearby|here|home|office|distance|drive|driving|travel|commute|trip|airport|location|route|far)\b/i;

export async function saveContact(ctx: Ctx, c: NonNullable<TgMessage["contact"]>): Promise<string> {
  const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || "unnamed";
  const id = await addFact(ctx.db, ctx.now, `Contact: ${name}${c.phone_number ? `, phone ${c.phone_number}` : ""} (shared from Telegram on ${fmtDate(ctx.now, ctx.off)})`, "people", "telegram contact");
  return id === null ? `I already have ${name}.` : `Saved ${name}. Tell me who they are to you and I'll remember it.`;
}
