// Gmail, read-only and opt-in: the brief says what in the Primary inbox needs the owner, and /inbox lists it.
// It rides on the same Google sign-in as the calendar, with one extra read-only permission the owner chooses to add.
import type { Ctx } from "./agent.ts";
import { decrypt, keyOf } from "./crypto.ts";
import { AuthExpired, accessToken, googleConfigured } from "./google.ts";

export const SCOPE_GMAIL = "https://www.googleapis.com/auth/gmail.readonly";
export interface Mail { id: string; from: string; subject: string; snippet: string }

export async function gmailConnected(ctx: Ctx): Promise<boolean> {
  const c = await ctx.db.prepare("SELECT meta FROM credentials WHERE provider = 'google'").bind().first<{ meta: string | null }>();
  return !!c?.meta && /gmail/.test(c.meta);
}

const header = (h: { name?: string; value?: string }[] | undefined, n: string): string => h?.find((x) => x.name?.toLowerCase() === n)?.value ?? "";
const who = (from: string): string => (/^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1] ?? from).trim().slice(0, 40);

/** Unread mail in Primary from the last two days, newest first, as sender, subject and snippet. Null if Gmail is not connected. */
export async function unreadPrimary(ctx: Ctx, max = 5): Promise<{ total: number; mails: Mail[] } | null> {
  if (!googleConfigured(ctx.env) || !(await gmailConnected(ctx))) return null;
  const cred = await ctx.db.prepare("SELECT enc FROM credentials WHERE provider = 'google'").bind().first<{ enc: string }>();
  if (!cred) return null;
  const refresh = (JSON.parse(await decrypt(await keyOf(ctx.env), cred.enc)) as { refresh_token: string }).refresh_token;
  const token = await accessToken(ctx.env, ctx.f, refresh);
  const get = async <T>(u: string): Promise<T> => {
    const r = await ctx.f(`https://gmail.googleapis.com/gmail/v1/users/me/${u}`, { headers: { authorization: `Bearer ${token}` } });
    if (r.status === 401) throw new AuthExpired("gmail token rejected");
    if (!r.ok) throw new Error(`gmail ${r.status}`);
    return (await r.json()) as T;
  };
  const list = await get<{ messages?: { id: string }[]; resultSizeEstimate?: number }>(`messages?${new URLSearchParams({ q: "is:unread category:primary newer_than:2d -from:me", maxResults: "20" })}`);
  const ids = (list.messages ?? []).slice(0, max);
  const mails: Mail[] = [];
  for (const m of ids) {
    const d = await get<{ snippet?: string; payload?: { headers?: { name?: string; value?: string }[] } }>(`messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
    mails.push({ id: m.id, from: who(header(d.payload?.headers, "from")), subject: header(d.payload?.headers, "subject").slice(0, 90) || "(no subject)", snippet: (d.snippet ?? "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").slice(0, 160) });
  }
  return { total: list.messages?.length ?? 0, mails };
}

/** One line for the morning brief, or null. A failure never blocks the brief. */
export async function inboxLine(ctx: Ctx): Promise<string | null> {
  try {
    const u = await unreadPrimary(ctx, 3);
    if (!u || !u.total) return null;
    return `Inbox: ${u.total}${u.total >= 20 ? "+" : ""} unread in Primary. Latest: ${u.mails.map((m) => `${m.from} (${m.subject})`).join("; ")}. /inbox to triage.`;
  } catch { return null; }
}
