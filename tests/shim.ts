// Test helpers: an in-memory SQLite database with the D1 call shape, and a fake fetch for Telegram and OpenRouter.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "../src/db.ts";
import type { Env } from "../src/handler.ts";

export function makeDb(): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return {
    raw,
    prepare(sql: string) {
      // D1 differs from plain SQLite: at most 5 terms in a compound SELECT and 100 bound parameters per statement.
      if ((sql.match(/\bUNION\s+ALL\b|\bUNION\b/gi) ?? []).length + 1 > 5) throw new Error("too many terms in compound SELECT: SQLITE_ERROR");
      if ((sql.match(/\?/g) ?? []).length > 100) throw new Error("too many SQL variables: SQLITE_ERROR");
      return {
        bind(...v: unknown[]) {
          const args = v as never[];
          return {
            first: async <T,>() => ((raw.prepare(sql).get(...args) as T | undefined) ?? null),
            all: async <T,>() => ({ results: raw.prepare(sql).all(...args) as T[] }),
            run: async () => { raw.prepare(sql).run(...args); },
          };
        },
      };
    },
  };
}

export const ENV: Env = {
  TELEGRAM_BOT_TOKEN: "123456789:TESTTOKENTESTTOKENTESTTOKENTESTTOKEN1",
  TELEGRAM_WEBHOOK_SECRET: "whsec",
  OPENROUTER_API_KEY: "or-test",
  CLAIM_CODE: "claim123",
  MODEL_FAST: "fast/model",
  MODEL_SMART: "smart/model",
  MODEL_FREE: "free/model:free",
  DEFAULT_CAP_USD: "1.00",
  TZ_OFFSET_MIN: "180",
  CONFIDENTIAL_TERMS: "Acme",
};

export interface Call { url: string; method: string; body: Record<string, unknown> }
export type LlmReply = { status?: number; content?: string; cost?: number };

/** Fake fetch. Telegram calls are recorded; OpenRouter calls pop replies from the queue. */
export function fakeFetch(queue: LlmReply[], files: Record<string, Uint8Array> = {}, web: Record<string, string> = {}): { f: typeof fetch; tg: Call[]; llm: Call[] } {
  const tg: Call[] = [];
  const llm: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (web[u] !== undefined) return new Response(web[u], { status: 200 });
    let body: Record<string, unknown> = {};
    if (init?.body instanceof FormData) {
      const file = init.body.get("document");
      body = { chat_id: init.body.get("chat_id"), caption: init.body.get("caption"), filename: file instanceof File ? file.name : "", content: file instanceof Blob ? await file.text() : "", photo_field: init.body.get("photo") };
    } else if (init?.body) body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (u.includes("api.telegram.org/file/bot")) {
      const id = u.split("/files/").pop() ?? "";
      const bytes = files[id];
      return bytes ? new Response(bytes, { status: 200 }) : new Response("missing", { status: 404 });
    }
    if (u.includes("api.telegram.org")) {
      const method = u.split("/").pop() ?? "";
      tg.push({ url: u, method, body });
      if (method === "getFile") return new Response(JSON.stringify(files[String(body.file_id)] ? { ok: true, result: { file_path: `files/${String(body.file_id)}` } } : { ok: false }), { status: 200 });
      if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 1, username: "test_rafiki_bot", first_name: "Test Rafiki" } }), { status: 200 });
      if (method === "sendPoll") return new Response(JSON.stringify({ ok: true, result: { poll: { id: `poll-${tg.length}` } } }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.includes("openrouter.ai/api/v1/key")) return new Response(JSON.stringify({ data: { label: "k" } }), { status: (init?.headers as Record<string, string> | undefined)?.authorization === "Bearer or-test" ? 200 : 401 });
    if (u.includes("openrouter.ai") && u.includes("/endpoints")) return new Response("{}", { status: u.includes("nonexistent") ? 404 : 200 });
    if (u.includes("openrouter.ai")) {
      llm.push({ url: u, method: "chat", body });
      const r = queue.shift() ?? { content: JSON.stringify({ role: "chief_of_staff", reply: "ok", actions: [] }) };
      if (r.status && r.status !== 200) return new Response("{}", { status: r.status });
      return new Response(JSON.stringify({ choices: [{ message: { content: r.content } }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: r.cost ?? 0.001 } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { f, tg, llm };
}

export const sent = (calls: Call[]): string[] => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
export const agentJson = (o: Record<string, unknown>): LlmReply => ({ content: JSON.stringify(o) });
