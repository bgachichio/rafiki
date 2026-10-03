// The only file that names OpenRouter. App code calls chat() and never names a vendor or URL (builder 2.5, v3.19).
import type { Sens } from "./gates.ts";
import type { Fetch } from "./telegram.ts";

export interface LlmEnv {
  OPENROUTER_API_KEY: string;
  MODEL_FAST: string;
  MODEL_SMART: string;
  MODEL_FREE: string;
  MODEL_MEDIA?: string;
}
export type Part =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } }
  | { type: "file"; file: { filename: string; file_data: string } }
  | { type: "video_url"; video_url: { url: string } };
export interface Msg { role: "system" | "user" | "assistant"; content: string | Part[] }
export interface LlmResult {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  providerPref: string;
}
export class CreditError extends Error {}
export class LlmError extends Error {}

const URL = "https://openrouter.ai/api/v1/chat/completions";
// Used only if the response carries no cost. USD per million tokens (input, output).
const PRICE_FALLBACK: Record<string, [number, number]> = {
  "google/gemini-3.5-flash-lite": [0.3, 2.5],
  "anthropic/claude-haiku-4.5": [1, 5],
  "anthropic/claude-sonnet-5.5": [2, 10],
};

type Pref = { data_collection?: "deny"; zdr?: boolean } | undefined;

function prefFor(sens: Sens, degrade: boolean): Pref {
  if (sens === "S0") return undefined;
  if (sens === "S2" && !degrade) return { zdr: true };
  return { data_collection: "deny" };
}
function prefLabel(p: Pref): string {
  return p ? (p.zdr ? "zdr" : "data_collection=deny") : "none";
}

async function once(env: LlmEnv, f: Fetch, model: string, messages: Msg[], pref: Pref, maxTokens: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 28000);
  try {
    return await f(URL, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "http-referer": "https://gachichio.org/rafiki",
        "x-title": "Rafiki",
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.4, usage: { include: true }, ...(pref ? { provider: pref } : {}) }),
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function chat(env: LlmEnv, f: Fetch, opts: { messages: Msg[]; sens: Sens; deep: boolean; maxTokens?: number; model?: string }): Promise<LlmResult> {
  if (opts.sens === "S3") throw new LlmError("S3 content must never reach a model");
  const maxTokens = opts.maxTokens ?? 900;
  let model = opts.model ?? (opts.deep ? env.MODEL_SMART : env.MODEL_FAST);
  let pref = prefFor(opts.sens, false);
  let res = await once(env, f, model, opts.messages, pref, maxTokens);

  // S2 prefers zero retention; if no such endpoint exists for this model, degrade to data_collection=deny, never to nothing.
  if (!res.ok && opts.sens === "S2" && (res.status === 404 || res.status === 400)) {
    pref = prefFor("S2", true);
    res = await once(env, f, model, opts.messages, pref, maxTokens);
  }
  // Out of credit: only low-stakes (S0) text may fall back to a free model.
  if (res.status === 402) {
    if (opts.sens !== "S0" || opts.model) throw new CreditError("credit exhausted"); // media and personal content never fall back to a free model
    model = env.MODEL_FREE;
    pref = undefined;
    res = await once(env, f, model, opts.messages, pref, maxTokens);
  }
  if (!res.ok) throw new LlmError(`model request failed (${res.status})`);

  const j = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  const text = j.choices?.[0]?.message?.content ?? "";
  const tin = j.usage?.prompt_tokens ?? 0;
  const tout = j.usage?.completion_tokens ?? 0;
  let cost = j.usage?.cost;
  if (typeof cost !== "number") {
    const p = PRICE_FALLBACK[model] ?? [0, 0];
    cost = (tin * p[0] + tout * p[1]) / 1e6;
  }
  return { text, model, tokensIn: tin, tokensOut: tout, costUsd: cost, providerPref: prefLabel(pref) };
}
