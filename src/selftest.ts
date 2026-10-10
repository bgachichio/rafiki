// /selftest: proves, on the owner's own deployment, that each model path works end to end, with timings and the real error
// when one fails. It uses a bundled voice clip and the bundled mascot image, so it needs nothing from the owner's phone.
import type { Ctx } from "./agent.ts";
import { SAMPLE_VOICE_OGG_BASE64, SAMPLE_VOICE_TEXT } from "./assets/voice.gen.ts";
import { MARK_PNG_BASE64 } from "./assets/mark.gen.ts";
import { chat, creditLeft } from "./llm.ts";
import { seeBytes, transcribeBytes } from "./media.ts";

export interface Check { name: string; ok: boolean; ms: number; detail: string }

const bytesOf = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const words = (t: string): string[] => t.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
/** Share of the expected words that were heard, so small punctuation or casing changes still pass. */
export function heardShare(expected: string, got: string): number {
  const want = words(expected);
  const have = new Set(words(got));
  return want.length ? want.filter((w) => have.has(w)).length / want.length : 0;
}

async function timed(name: string, fn: () => Promise<{ ok: boolean; detail: string }>): Promise<Check> {
  const t0 = Date.now();
  try { const r = await fn(); return { name, ...r, ms: Date.now() - t0 }; }
  catch (e) { return { name, ok: false, ms: Date.now() - t0, detail: e instanceof Error ? e.message.slice(0, 160) : String(e) }; }
}

export async function runSelfTest(ctx: Ctx): Promise<Check[]> {
  const out: Check[] = [];
  out.push(await timed("Thinking (everyday model)", async () => {
    const r = await chat(ctx.env, ctx.f, { sens: "S0", deep: false, maxTokens: 10, messages: [{ role: "user", content: "Reply with the single word OK." }] });
    return { ok: /ok/i.test(r.text), detail: `${r.model}, USD ${r.costUsd.toFixed(5)}` };
  }));
  out.push(await timed("Hearing (voice note)", async () => {
    const r = await transcribeBytes(ctx, bytesOf(SAMPLE_VOICE_OGG_BASE64), "ogg");
    if (!r.ok) return { ok: false, detail: r.why };
    const share = heardShare(SAMPLE_VOICE_TEXT, r.text);
    return { ok: share >= 0.7, detail: `heard "${r.text.slice(0, 80)}"` };
  }));
  out.push(await timed("Seeing (photo)", async () => {
    const r = await seeBytes(ctx, bytesOf(MARK_PNG_BASE64), "image/png");
    return r.ok ? { ok: r.text.length > 20, detail: `"${r.text.slice(0, 70).replace(/\s+/g, " ")}..."` } : { ok: false, detail: r.why };
  }));
  out.push(await timed("Model credit (OpenRouter)", async () => {
    const left = await creditLeft(ctx.env, ctx.f);
    return left === null ? { ok: true, detail: "the account does not report a balance" } : { ok: left >= 1, detail: `USD ${left.toFixed(2)} left${left < 1 ? ": top up at openrouter.ai/settings/credits" : ""}` };
  }));
  return out;
}

export function selfTestText(checks: Check[]): string {
  const lines = ["Self-test (each path run end to end just now):"];
  for (const c of checks) lines.push(`${c.ok ? "✅" : "❌"} ${c.name}: ${(c.ms / 1000).toFixed(1)} s, ${c.detail}`);
  lines.push(checks.every((c) => c.ok) ? "All working." : "Something failed. The detail above is the real error; /log shows every attempt.");
  return lines.join("\n");
}
