// Read a link the owner sends: an article, an X post or thread, a PDF or a YouTube video. The page is turned into plain text
// here, kept in searchable memory, and explained in the owner's chat. Everything fetched is DATA, never instructions.
import type { Ctx } from "./agent.ts";
import { pdfBytesText, storeDoc } from "./media.ts";

export const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
const ASK_WORDS = /\b(summar\w*|explain\w*|tl;?dr|what('?s| is) (this|it)|read (this|it)|break (this|it) down|key points|gist)\b/i;

/** The link to read when the message is a link (with at most a short note), or asks to summarise or explain one. */
export function linkToRead(text: string): string | null {
  const urls = text.match(URL_RE) ?? [];
  if (urls.length !== 1) return null;
  const rest = text.replace(urls[0]!, "").trim();
  return rest.length <= 80 || ASK_WORDS.test(rest) ? urls[0]!.replace(/[.,;:!?]+$/, "") : null;
}

export type Read = { ok: true; title: string; text: string; source: string } | { ok: false; why: string };
const MAX_HTML = 900_000;
const MAX_TEXT = 60_000;

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: "...", copy: "©" };
export const decode = (s: string): string => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m));
const meta = (html: string, key: string): string | null => {
  const m = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, "i").exec(html);
  return m ? decode(m[1] ?? m[2] ?? "").trim() : null;
};

/** Main text of an HTML page: drop scripts, styles and page furniture, prefer <article> or <main>, keep paragraph breaks. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim()) || meta(html, "og:title") || "";
  let body = html.replace(/<(script|style|noscript|svg|template|iframe|form|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const main = /<article\b[\s\S]*?<\/article>/i.exec(body)?.[0] ?? /<main\b[\s\S]*?<\/main>/i.exec(body)?.[0];
  if (main && main.length > 1500) body = main;
  const text = decode(body.replace(/<(br|\/p|\/h[1-6]|\/li|\/tr|\/div|\/blockquote)\b[^>]*>/gi, "\n").replace(/<li\b[^>]*>/gi, "- ").replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
  const desc = meta(html, "og:description") ?? meta(html, "description");
  return { title, text: text.length < 200 && desc ? `${desc}\n\n${text}` : text };
}

async function readX(ctx: Ctx, id: string): Promise<Read> {
  const r = await ctx.f(`https://api.fxtwitter.com/2/thread/${id}`, { headers: { "user-agent": "Rafiki/1.0" } });
  if (!r.ok) return { ok: false, why: "I couldn't open that post. It may be private or deleted." };
  type Post = { text?: string; author?: { name?: string; screen_name?: string }; created_at?: string; article?: { title?: string; content?: { blocks?: { text?: string }[] } }; quote?: Post };
  const j = (await r.json()) as { status?: Post; thread?: Post[] };
  const posts = j.thread?.length ? j.thread : j.status ? [j.status] : [];
  if (!posts.length) return { ok: false, why: "I couldn't read that post." };
  const a = posts[0]!.author;
  const parts = posts.map((p) => {
    const art = p.article ? `${p.article.title ?? ""}\n${(p.article.content?.blocks ?? []).map((b) => b.text ?? "").join("\n")}` : "";
    const q = p.quote?.text ? `\n[Quoting @${p.quote.author?.screen_name ?? "someone"}: ${p.quote.text}]` : "";
    return `${art || p.text || ""}${q}`;
  });
  return { ok: true, title: posts[0]!.article?.title || `Post by ${a?.name ?? "someone"} (@${a?.screen_name ?? "?"})`, text: parts.join("\n\n").slice(0, MAX_TEXT), source: `X, @${a?.screen_name ?? "?"}, ${posts[0]!.created_at ?? ""}`.trim() };
}

export async function readUrl(ctx: Ctx, url: string): Promise<Read> {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, why: "That link doesn't look complete." }; }
  if (!/^https?:$/.test(u.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) return { ok: false, why: "I only read public web links." };
  const x = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i.test(u.hostname) ? /\/status\/(\d+)/.exec(u.pathname)?.[1] : undefined;
  if (x) return readX(ctx, x);
  if (/(^|\.)youtube\.com$|^youtu\.be$/i.test(u.hostname)) {
    const o = await ctx.f(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`).catch(() => null);
    const t = o && o.ok ? ((await o.json()) as { title?: string; author_name?: string }) : {};
    return { ok: true, title: t.title ?? "YouTube video", text: `[YouTube video${t.author_name ? ` by ${t.author_name}` : ""}. Only the title is available to me here, not the transcript.]`, source: `YouTube${t.author_name ? `, ${t.author_name}` : ""}` };
  }
  let res: Response;
  try {
    res = await ctx.f(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; Rafiki/1.0; personal assistant reading a link for its owner)", accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5" }, redirect: "follow" });
  } catch { return { ok: false, why: "I couldn't reach that site." }; }
  if (!res.ok) return { ok: false, why: `That site answered ${res.status}${res.status === 403 || res.status === 401 ? ": it blocks readers like me or needs a login" : ""}.` };
  const type = res.headers.get("content-type") ?? "";
  if (/pdf/i.test(type) || /\.pdf$/i.test(u.pathname)) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    const r = await pdfBytesText(ctx, bytes, u.pathname.split("/").pop() || "document.pdf");
    return r.ok ? { ok: true, title: u.pathname.split("/").pop() || "PDF", text: r.text, source: u.hostname } : r;
  }
  if (!/html|text\/plain|xml/i.test(type)) return { ok: false, why: `That link is a ${type.split(";")[0] || "file"} I can't read. Send me the file itself.` };
  const raw = (await res.text()).slice(0, MAX_HTML);
  const { title, text } = /html|xml/i.test(type) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : { title: u.hostname, text: raw };
  if (text.length < 120) return { ok: false, why: "That page has almost no readable text for me (it may need a login or build itself in the browser). Paste the text, or send it as a PDF." };
  return { ok: true, title: title || u.hostname, text: text.slice(0, MAX_TEXT), source: u.hostname.replace(/^www\./, "") };
}

/** Keep what was read in searchable memory, so "what did that article say about X" works later. */
export async function keepRead(ctx: Ctx, url: string, r: Extract<Read, { ok: true }>): Promise<void> {
  await storeDoc(ctx, `${r.title} (${url})`.slice(0, 120), "text/x-link", r.text.length, r.text);
}
