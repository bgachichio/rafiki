// Minimal Telegram Bot API client. One HTTP POST per call, no SDK.
export type Fetch = typeof fetch;
export interface Button { text: string; data: string; url?: string; copy?: string }

export interface TgUser { id: number; first_name?: string; language_code?: string }
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number };
  text?: string;
  caption?: string;
  reply_markup?: { inline_keyboard?: { text: string; callback_data?: string; url?: string }[][] };
  voice?: TgFile; audio?: TgFile; video_note?: TgFile; video?: TgFile;
  photo?: TgFile[]; document?: TgFile; sticker?: unknown; animation?: TgFile;
  location?: TgLocation; venue?: { title?: string; location?: TgLocation }; contact?: { phone_number?: string; first_name?: string; last_name?: string }; poll?: unknown; dice?: unknown;
  forward_origin?: { type?: string; sender_user?: { first_name?: string; last_name?: string }; sender_user_name?: string; chat?: { title?: string }; date?: number };
  reply_to_message?: TgMessage;
  forward_date?: number; forward_from?: { first_name?: string; last_name?: string }; forward_sender_name?: string;
}
export type AttachKind = "document" | "photo" | "voice" | "audio" | "video";
export interface Attach { kind: AttachKind; fileId: string; name: string }
/** The file, photo or voice note a message carries, if any, as something a reminder can send back later. */
export function attachOf(m?: TgMessage): Attach | null {
  if (!m) return null;
  if (m.document) return { kind: "document", fileId: m.document.file_id, name: m.document.file_name ?? "file" };
  if (m.photo?.length) return { kind: "photo", fileId: m.photo[m.photo.length - 1]!.file_id, name: "photo" };
  if (m.voice) return { kind: "voice", fileId: m.voice.file_id, name: "voice note" };
  if (m.audio) return { kind: "audio", fileId: m.audio.file_id, name: m.audio.file_name ?? "audio" };
  if (m.video) return { kind: "video", fileId: m.video.file_id, name: m.video.file_name ?? "video" };
  return null;
}
export interface TgLocation { latitude: number; longitude: number; live_period?: number }
export interface TgFile { file_id: string; file_size?: number; mime_type?: string; file_name?: string }
export interface TgCallback { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgPollAnswer { poll_id: string; user?: TgUser; option_ids: number[] }
export interface TgUpdate { update_id: number; message?: TgMessage; edited_message?: TgMessage; callback_query?: TgCallback; poll_answer?: TgPollAnswer }

export const MENU = {
  keyboard: [[{ text: "Today" }, { text: "Money" }], [{ text: "Coach" }, { text: "Business" }], [{ text: "Settings" }]],
  resize_keyboard: true,
  is_persistent: true,
};

/** Rafiki never sends an em dash: "a — b" becomes "a, b". En dashes in ranges (09:00–10:00) stay. */
export const noEmDash = (t: string): string => t.replace(/\s*—\s*/g, ", ").replace(/,\s*,/g, ",");
export const SKIN: Record<string, string> = { light: "\u{1F3FB}", "medium-light": "\u{1F3FC}", medium: "\u{1F3FD}", "medium-dark": "\u{1F3FE}", dark: "\u{1F3FF}" };
/** Give people and hand emoji the owner's skin tone, unless they already carry one. */
export const withSkin = (t: string, tone: string | null): string => {
  const mod = tone ? SKIN[tone] : undefined;
  return mod ? t.replace(/(\p{Emoji_Modifier_Base})(?![\u{1F3FB}-\u{1F3FF}])(\uFE0F)?/gu, (_m, base: string) => `${base}${mod}`) : t;
};

export class Telegram {
  /** Set per update: how to read the owner's emoji skin tone (read only when a message carries such an emoji). */
  skin?: () => Promise<string | null>;
  private async tidy(t: string): Promise<string> {
    const out = noEmDash(t);
    return this.skin && /\p{Emoji_Modifier_Base}/u.test(out) ? withSkin(out, await this.skin()) : out;
  }
  private token: string;
  private f: Fetch;
  constructor(token: string, f: Fetch) {
    this.token = token;
    this.f = f;
  }

  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const f = this.f; // call detached: Workers' fetch throws "Illegal invocation" if invoked with another object as this
    const res = await f(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || out.ok === false) console.error(`telegram ${method} failed: ${res.status} ${out.description ?? ""}`); // never log the token
    return out;
  }

  async send(chatId: number, text: string, buttons?: Button[][], keyboard = false): Promise<unknown> {
    const body: Record<string, unknown> = { chat_id: chatId, text: (await this.tidy(text)).slice(0, 3900), link_preview_options: { is_disabled: true } }; // no big link cards from maps or X links
    if (buttons && buttons.length) {
      const label = async (t: string): Promise<string> => this.tidy(t);
      const rows = await Promise.all(buttons.map((row) => Promise.all(row.map(async (b) => ({ ...b, text: await label(b.text) })))));
      body.reply_markup = { inline_keyboard: rows.map((row) => row.map((b) => (b.copy ? { text: b.text, copy_text: { text: b.copy } } : b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data.slice(0, 64) }))) };
    } else if (keyboard) {
      body.reply_markup = MENU;
    }
    return this.call("sendMessage", body);
  }
  /** Send back a file Telegram already holds, by its id: no download, no upload. */
  async sendStored(chatId: number, a: Attach, caption?: string, buttons?: Button[][]): Promise<boolean> {
    const method = { document: "sendDocument", photo: "sendPhoto", voice: "sendVoice", audio: "sendAudio", video: "sendVideo" }[a.kind];
    const markup = buttons?.length ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data.slice(0, 64) }))) } } : {};
    const r = (await this.call(method, { chat_id: chatId, [a.kind]: a.fileId, ...(caption ? { caption: (await this.tidy(caption)).slice(0, 1000) } : {}), ...markup })) as { ok?: boolean };
    return r.ok === true;
  }
  /** Resolve a file id, then download it. Returns null on any failure. */
  async download(fileId: string): Promise<Uint8Array | null> {
    const info = (await this.call("getFile", { file_id: fileId })) as { ok?: boolean; result?: { file_path?: string } };
    const path = info.result?.file_path;
    if (!info.ok || !path) return null;
    const f = this.f;
    const res = await f(`https://api.telegram.org/file/bot${this.token}/${path}`);
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  }
  async sendPoll(chatId: number, question: string, options: string[], multiple = false): Promise<string | null> {
    const r = (await this.call("sendPoll", { chat_id: chatId, question: question.slice(0, 255), options: options.map((o) => ({ text: o.slice(0, 100) })), is_anonymous: false, allows_multiple_answers: multiple })) as { ok?: boolean; result?: { poll?: { id?: string } } };
    return r.ok ? (r.result?.poll?.id ?? null) : null;
  }
  react(chatId: number, messageId: number, emoji: string): Promise<unknown> {
    return this.call("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji }] });
  }
  typing(chatId: number): Promise<unknown> { return this.call("sendChatAction", { chat_id: chatId, action: "typing" }); }
  answer(callbackId: string, text?: string): Promise<unknown> { return this.call("answerCallbackQuery", { callback_query_id: callbackId, text }); }
  /** Replace a message's inline buttons (an empty list removes them). */
  setButtons(chatId: number, messageId: number, rows: { text: string; callback_data?: string; url?: string }[][]): Promise<unknown> {
    return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } });
  }
  /** Send text as a file. Used by /export. Returns true when Telegram accepted it. */
  async sendDocument(chatId: number, filename: string, content: string, caption?: string): Promise<boolean> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", caption.slice(0, 1000));
    form.append("document", new Blob([content], { type: "application/octet-stream" }), filename);
    const f = this.f;
    const res = await f(`https://api.telegram.org/bot${this.token}/sendDocument`, { method: "POST", body: form });
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || out.ok === false) console.error(`telegram sendDocument failed: ${res.status} ${out.description ?? ""}`);
    return res.ok && out.ok !== false;
  }
  /** The method behind /setup: each of these is one call to Telegram, and each reports whether it was accepted. */
  async api(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string }> {
    return (await this.call(method, body)) as { ok: boolean; result?: unknown; description?: string };
  }
  async setProfilePhoto(png: Uint8Array): Promise<boolean> {
    const form = new FormData();
    form.append("photo", JSON.stringify({ type: "static", photo: "attach://mark" }));
    form.append("mark", new Blob([png], { type: "image/png" }), "mark.png");
    const f = this.f;
    const res = await f(`https://api.telegram.org/bot${this.token}/setMyProfilePhoto`, { method: "POST", body: form });
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return res.ok && out.ok === true;
  }
  clearButtons(chatId: number, messageId: number): Promise<unknown> {
    return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  }
}
