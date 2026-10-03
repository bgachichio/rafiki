// A one-minute check, offered during onboarding, that voice, photos, files and locations all reach Rafiki from this phone.
import type { Ctx } from "./agent.ts";
import { getSetting, setSetting } from "./db.ts";
import type { Telegram } from "./telegram.ts";

export type MediaKind = "voice" | "photo" | "file" | "location";
const LABEL: Record<MediaKind, string> = { voice: "a voice note", photo: "a photo", file: "a file", location: "your location" };
const KINDS = Object.keys(LABEL) as MediaKind[];

const board = (m: Record<string, number>): string => KINDS.map((k) => `${m[k] ? "✓" : "·"} ${LABEL[k]}`).join("\n");

export async function startMediaCheck(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  await setSetting(ctx.db, "mc", JSON.stringify({}));
  await tg.send(chatId, `Let's check my ears and eyes. Send me each of these once, in any order:\n\n${board({})}\n\nA voice note is the microphone button. A photo, a file and your location are under the paperclip. /cancel stops the check.`);
}

/** Called after any voice note, photo, file or location arrives. Does nothing unless a check is running. */
export async function mediaTick(ctx: Ctx, tg: Telegram, chatId: number, kind: MediaKind): Promise<void> {
  const raw = await getSetting(ctx.db, "mc");
  if (!raw) return;
  const m = JSON.parse(raw) as Record<string, number>;
  m[kind] = 1;
  if (KINDS.every((k) => m[k])) {
    await setSetting(ctx.db, "mc", "");
    await tg.send(chatId, `${board(m)}\n\nAll four reached me. Voice, photos, files and locations work from this phone.`);
    return;
  }
  await setSetting(ctx.db, "mc", JSON.stringify(m));
  await tg.send(chatId, `Got ${LABEL[kind]}.\n\n${board(m)}`);
}
