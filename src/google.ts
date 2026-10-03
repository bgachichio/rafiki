// Google sign-in for the owner's own calendar, read-only. One tap in Telegram, one consent screen, tokens encrypted at rest.
import { hmacHex, randomHex, safeEqual } from "./crypto.ts";
import type { Fetch } from "./telegram.ts";

export interface GoogleEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ENCRYPTION_KEY?: string;
  PUBLIC_URL?: string;
}
export const SCOPE_CALENDAR = "https://www.googleapis.com/auth/calendar.readonly";
export class AuthExpired extends Error {}

export const googleConfigured = (e: GoogleEnv): boolean => !!(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET && e.ENCRYPTION_KEY && e.PUBLIC_URL);
export const redirectUri = (e: GoogleEnv): string => `${e.PUBLIC_URL}/oauth/google/callback`;

const STATE_TTL_MS = 10 * 60000;

/** A signed, expiring, single-use state value ties the consent screen to the owner's request. */
export async function makeState(e: GoogleEnv, now: number): Promise<{ state: string; nonce: string }> {
  const nonce = randomHex(12);
  const payload = `${nonce}.${now + STATE_TTL_MS}`;
  return { state: `${payload}.${await hmacHex(e.ENCRYPTION_KEY ?? "", payload)}`, nonce };
}
export async function checkState(e: GoogleEnv, state: string, now: number): Promise<string | null> {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [nonce, exp, sig] = parts as [string, string, string];
  const good = await hmacHex(e.ENCRYPTION_KEY ?? "", `${nonce}.${exp}`);
  if (!safeEqual(good, sig)) return null;
  if (!(Number(exp) > now)) return null;
  return nonce;
}
export function authUrl(e: GoogleEnv, state: string): string {
  const q = new URLSearchParams({
    client_id: e.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri(e),
    response_type: "code",
    scope: SCOPE_CALENDAR,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}

async function tokenCall(f: Fetch, params: Record<string, string>): Promise<Record<string, unknown> & { status: number }> {
  const res = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ...j, status: res.status };
}

export async function exchangeCode(e: GoogleEnv, f: Fetch, code: string): Promise<{ refreshToken: string; accessToken: string }> {
  const j = await tokenCall(f, { code, client_id: e.GOOGLE_CLIENT_ID ?? "", client_secret: e.GOOGLE_CLIENT_SECRET ?? "", redirect_uri: redirectUri(e), grant_type: "authorization_code" });
  if (typeof j.refresh_token !== "string" || typeof j.access_token !== "string") throw new Error(`google token exchange failed (${j.status})`);
  return { refreshToken: j.refresh_token, accessToken: j.access_token };
}
export async function accessToken(e: GoogleEnv, f: Fetch, refreshToken: string): Promise<string> {
  const j = await tokenCall(f, { refresh_token: refreshToken, client_id: e.GOOGLE_CLIENT_ID ?? "", client_secret: e.GOOGLE_CLIENT_SECRET ?? "", grant_type: "refresh_token" });
  if (j.error === "invalid_grant") throw new AuthExpired("google refresh token no longer valid");
  if (typeof j.access_token !== "string") throw new Error(`google refresh failed (${j.status})`);
  return j.access_token;
}
export async function revoke(f: Fetch, token: string): Promise<void> {
  await f("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() }).catch(() => undefined);
}

async function api<T>(f: Fetch, token: string, url: string): Promise<T> {
  const res = await f(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new AuthExpired("access token rejected");
  if (!res.ok) throw new Error(`google api ${res.status}`);
  return (await res.json()) as T;
}

export interface CalListItem { id: string; summary?: string; selected?: boolean; accessRole?: string }
export async function listCalendars(f: Fetch, token: string): Promise<CalListItem[]> {
  const j = await api<{ items?: CalListItem[] }>(f, token, "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&fields=items(id,summary,selected,accessRole)");
  return j.items ?? [];
}

export interface RawEvent {
  id?: string;
  status?: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; responseStatus?: string; self?: boolean }[];
}
export async function listEvents(f: Fetch, token: string, calId: string, minIso: string, maxIso: string): Promise<RawEvent[]> {
  const q = new URLSearchParams({ timeMin: minIso, timeMax: maxIso, singleEvents: "true", orderBy: "startTime", maxResults: "150", fields: "items(id,status,summary,location,start,end,attendees(responseStatus,self))" });
  const j = await api<{ items?: RawEvent[] }>(f, token, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${q.toString()}`);
  return j.items ?? [];
}
