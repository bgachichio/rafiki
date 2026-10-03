// The model presets, and a rule-based proposal from what the owner has shared. The rules are plain so they can be tested.
export type ModelKind = "fast" | "smart" | "media";
export const PRESETS: Record<ModelKind, [string, string][]> = {
  fast: [["Claude Haiku 4.5 (default)", "anthropic/claude-haiku-4.5"], ["Gemini 3.8 Flash", "google/gemini-3.8-flash"], ["Gemini 3.5 Flash-Lite (cheapest)", "google/gemini-3.5-flash-lite"], ["GPT-5 mini", "openai/gpt-5-mini"]],
  smart: [["Claude Sonnet 5.5 (default)", "anthropic/claude-sonnet-5.5"], ["Claude Opus 5.5", "anthropic/claude-opus-5.5"], ["Gemini 3.8 Flash", "google/gemini-3.8-flash"]],
  media: [["Gemini 3.8 Flash (default)", "google/gemini-3.8-flash"], ["Gemini 3.5 Flash-Lite (cheapest)", "google/gemini-3.5-flash-lite"]],
};
export const DEFAULT_MODELS: Record<ModelKind, string> = { fast: "anthropic/claude-haiku-4.5", smart: "anthropic/claude-sonnet-5.5", media: "google/gemini-3.8-flash" };
export const modelLabel = (kind: ModelKind, id: string): string => PRESETS[kind].find(([, v]) => v === id)?.[0].replace(/ \((default|cheapest)\)$/, "") ?? id;

export interface ModelProposal { fast: string; smart: string; media: string; reasons: string[] }

/** Propose the three models from the owner's shared memory and preferences text. Nothing is applied here. */
export function proposeModels(text: string, langs: string): ModelProposal {
  const t = `${text}\n${langs}`.toLowerCase();
  const out: ModelProposal = { ...DEFAULT_MODELS, reasons: [] };
  const cheap = /\b(cheap|cheaper|keep costs? low|save money|tight budget|low cost|small budget|as little as possible)\b/.test(t);
  const nonEnglish = /\b(swahili|kiswahili|sheng|french|fran[cç]ais|arabic|hindi|spanish|portuguese|german|yoruba|amharic|zulu|twi|hausa)\b/.test(t);
  const voicey = /\b(voice notes?|dictat\w+|audio|speak to you|talk to you)\b/.test(t);
  if (cheap) {
    out.fast = "google/gemini-3.5-flash-lite"; out.smart = "google/gemini-3.8-flash"; out.media = "google/gemini-3.5-flash-lite";
    out.reasons.push("You said you want to keep costs low, so I chose the cheapest capable model for each job.");
    return out;
  }
  if (nonEnglish) { out.fast = "google/gemini-3.8-flash"; out.reasons.push("You write in more than English, so I chose an everyday model that handles other languages well."); }
  if (voicey) out.reasons.push("You use voice notes, so I kept the stronger media model for hearing them accurately.");
  if (/\b(advice|decision|strategy|plan|forecast|contract|legal|research|long (reports?|drafts?))\b/.test(t)) out.reasons.push("You ask for advice and plans, so deep thinking stays on the strongest balanced model.");
  if (!out.reasons.length) out.reasons.push("Nothing you shared points away from the defaults, so I kept them.");
  return out;
}
