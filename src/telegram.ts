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
  forward_date?: number; forward_from?: { first_name?: string; last_name?: string }; forward_sender_name?: string;
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

export class Telegram {
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

  send(chatId: number, text: string, buttons?: Button[][], keyboard = false): Promise<unknown> {
    const body: Record<string, unknown> = { chat_id: chatId, text: text.slice(0, 3900) };
    if (buttons && buttons.length) {
      body.reply_markup = { inline_keyboard: buttons.map((row) => row.map((b) => (b.copy ? { text: b.text, copy_text: { text: b.copy } } : b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data.slice(0, 64) }))) };
    } else if (keyboard) {
      body.reply_markup = MENU;
    }
    return this.call("sendMessage", body);
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
  clearButtons(chatId: number, messageId: number): Promise<unknown> {
    return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  }
}
