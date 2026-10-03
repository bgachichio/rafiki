// The "Know me" interview, the "bring your context" menu, and editing preferences later. One question at a time, every one skippable.
import { runAgent, type Ctx } from "./agent.ts";
import { getSetting, setSetting } from "./db.ts";
import { EXPORT_PROMPT } from "./import.ts";
import { setPref, STYLE_TEXT } from "./prefs.ts";
import type { Button, Telegram } from "./telegram.ts";

export interface KmQ { key: string; q: string; kind: "text" | "single" | "multi"; options?: string[]; editable: boolean }
export const KM: KmQ[] = [
  { key: "call_me", q: "What should I call you?", kind: "text", editable: true },
  { key: "work", q: "What do you do? Work, business, studies, anything that fills your week.", kind: "text", editable: true },
  { key: "areas", q: "Which parts of life should I watch most closely? Tap all that apply, then Done.", kind: "multi", options: ["Family", "Money", "Health", "Business", "Career", "Learning", "Faith", "Friends", "Fitness"], editable: true },
  { key: "style", q: "How do you like me to talk? Pick one, or describe it in your own words.", kind: "single", options: ["Brief", "Direct", "Warm", "Detailed"], editable: true },
  { key: "rhythm", q: "When does your day start and end? Pick one, or type it like 06:00-22:00.", kind: "single", options: ["05:30-21:00", "06:30-22:00", "07:00-23:00"], editable: true },
  { key: "work_days", q: "Which days are work days?", kind: "single", options: ["Mon-Fri", "Mon-Sat", "Every day"], editable: true },
  { key: "people", q: "Who are the people I should know about? Name and who they are to you, as many as you like in one message.", kind: "text", editable: false },
  { key: "rules", q: "Anything I should always or never do? In your own words.", kind: "text", editable: false },
  { key: "money", q: "Your money picture, if you want to share it: income, regular commitments, savings or debt goals. I keep it private and use it only to help you.", kind: "text", editable: false },
  { key: "health", q: "Health, family and routines that would help me help you. Skip if you prefer.", kind: "text", editable: false },
];
const EXTRACT_HINT: Record<string, string> = {
  people: "Save each person as a separate note action with category people (or family for relatives): their name and who they are to the owner.",
  rules: "Save each rule as a separate note action with category instructions, in the owner's words.",
  money: "Save each distinct money fact as a separate note action with category money. Do not add numbers the owner did not give.",
  health: "Save each distinct fact as a separate note action, with category health, family or routines as fits.",
};

const rows = (labels: string[], data: (i: number) => string, per = 2): Button[][] => {
  const out: Button[][] = [];
  for (let i = 0; i < labels.length; i += per) out.push(labels.slice(i, i + per).map((t, j) => ({ text: t, data: data(i + j) })));
  return out;
};

export async function kmAsk(ctx: Ctx, tg: Telegram, chatId: number, idx: number, edit = false): Promise<void> {
  const q = KM[idx];
  if (!q) return;
  await setSetting(ctx.db, "km_idx", String(idx));
  await setSetting(ctx.db, "km_mode", edit ? "edit" : "");
  const lines: Button[][] = [];
  if (q.options) {
    const base = rows(q.options, (i) => `km:${q.kind === "multi" ? "m" : "o"}:${idx}:${i}`, q.kind === "multi" ? 3 : 2);
    lines.push(...base);
  }
  if (q.kind === "multi") { await setSetting(ctx.db, "km_multi", "[]"); lines.push([{ text: "Done", data: `km:d:${idx}` }]); }
  lines.push(edit ? [{ text: "Cancel", data: "km:c" }] : [{ text: "Skip", data: `km:s:${idx}` }, { text: "Skip the rest", data: "km:x" }]);
  await tg.send(chatId, `${edit ? "" : `${idx + 1} of ${KM.length}. `}${q.q}`, lines);
}

async function afterAnswer(ctx: Ctx, tg: Telegram, chatId: number, idx: number, edit: boolean, note?: string): Promise<void> {
  if (note) await tg.send(chatId, note);
  if (edit) { await setSetting(ctx.db, "km_idx", ""); await setSetting(ctx.db, "km_mode", ""); await tg.send(chatId, "Updated. /preferences shows everything."); return; }
  if (idx + 1 >= KM.length) { await finishKm(ctx, tg, chatId); return; }
  await kmAsk(ctx, tg, chatId, idx + 1);
}

export async function finishKm(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  await setSetting(ctx.db, "km_idx", "");
  await setSetting(ctx.db, "ob_step", "bring");
  await tg.send(chatId, "Thank you. I know you much better now. You can see and change everything any time with /memory and /preferences.");
  await bringMenu(tg, chatId);
}

async function apply(ctx: Ctx, tg: Telegram, chatId: number, idx: number, value: string, edit: boolean): Promise<void> {
  const q = KM[idx]!;
  const v = value.trim();
  if (q.key === "rhythm") {
    const m = /^(\d{1,2}:\d{2})\s*(?:-|–|to)\s*(\d{1,2}:\d{2})$/.exec(v);
    if (!m) { await tg.send(chatId, "Please write it like 06:00-22:00."); return; }
    const [a, b] = [m[1]!.padStart(5, "0"), m[2]!.padStart(5, "0")];
    await setPref(ctx.db, ctx.now, "day_start", a, "knowme");
    await setPref(ctx.db, ctx.now, "day_end", b, "knowme");
    await setSetting(ctx.db, "quiet_start", b);
    await setSetting(ctx.db, "quiet_end", a);
    return afterAnswer(ctx, tg, chatId, idx, edit, `Got it. I won't interrupt you between ${b} and ${a}.`);
  }
  if (q.key === "style") {
    const k = v.toLowerCase();
    if (STYLE_TEXT[k]) await setPref(ctx.db, ctx.now, "style", k, "knowme");
    else { await setPref(ctx.db, ctx.now, "style", "direct", "knowme"); await setPref(ctx.db, ctx.now, "style_note", v, "knowme"); }
    return afterAnswer(ctx, tg, chatId, idx, edit);
  }
  if (EXTRACT_HINT[q.key]) {
    await tg.typing(chatId);
    const r = await runAgent(ctx, `My answer to "${q.q}": ${v}`, `Know-me interview. ${EXTRACT_HINT[q.key]} Reply with one short line saying what you saved. Ask no question.`);
    return afterAnswer(ctx, tg, chatId, idx, edit, r.text);
  }
  await setPref(ctx.db, ctx.now, q.key, v, "knowme");
  return afterAnswer(ctx, tg, chatId, idx, edit);
}

/** Free-text answer to the current question. Returns true when consumed. */
export async function kmText(ctx: Ctx, tg: Telegram, chatId: number, text: string): Promise<boolean> {
  const idxS = await getSetting(ctx.db, "km_idx");
  if (!idxS) return false;
  const idx = Number(idxS);
  const q = KM[idx];
  if (!q || q.kind === "multi") return false;
  await apply(ctx, tg, chatId, idx, text, (await getSetting(ctx.db, "km_mode")) === "edit");
  return true;
}

export async function kmCallback(ctx: Ctx, tg: Telegram, chatId: number, data: string): Promise<boolean> {
  if (!data.startsWith("km:")) return false;
  const [, act, a, b] = data.split(":");
  const idx = Number(a);
  const edit = (await getSetting(ctx.db, "km_mode")) === "edit";
  if (act === "start") { await kmAsk(ctx, tg, chatId, 0); return true; }
  if (act === "later") { await setSetting(ctx.db, "ob_step", "bring"); await bringMenu(tg, chatId); return true; }
  if (act === "x") { await finishKm(ctx, tg, chatId); return true; }
  if (act === "c") { await setSetting(ctx.db, "km_idx", ""); await setSetting(ctx.db, "km_mode", ""); await tg.send(chatId, "Cancelled."); return true; }
  const q = KM[idx];
  if (!q) return true;
  if (act === "s") { await afterAnswer(ctx, tg, chatId, idx, edit); return true; }
  if (act === "o") { await apply(ctx, tg, chatId, idx, q.options?.[Number(b)] ?? "", edit); return true; }
  if (act === "m") {
    const sel = new Set<number>(JSON.parse((await getSetting(ctx.db, "km_multi")) ?? "[]") as number[]);
    const i = Number(b);
    if (sel.has(i)) sel.delete(i); else sel.add(i);
    await setSetting(ctx.db, "km_multi", JSON.stringify([...sel]));
    await tg.send(chatId, `Selected: ${[...sel].sort().map((n) => q.options?.[n]).join(", ") || "none yet"}. Tap more, or Done.`);
    return true;
  }
  if (act === "d") {
    const sel = (JSON.parse((await getSetting(ctx.db, "km_multi")) ?? "[]") as number[]).sort();
    await apply(ctx, tg, chatId, idx, sel.map((n) => q.options?.[n]).join(", ") || "none", edit);
    return true;
  }
  return false;
}

// ---- bring your context ----------------------------------------------------------------------------------------------
export async function bringMenu(tg: Telegram, chatId: number): Promise<void> {
  await tg.send(chatId, "Want to bring in what other assistants and your own files already know? Each is optional.", [
    [{ text: "Paste from Claude, ChatGPT or Gemini", data: "ctx:paste" }],
    [{ text: "Upload skills files (.md)", data: "ctx:skills" }],
    [{ text: "Send my writing", data: "ctx:writing" }],
    [{ text: "Continue", data: "ctx:done" }],
  ]);
}

export async function startPaste(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  await setSetting(ctx.db, "import_wait", "1");
  await setSetting(ctx.db, "import_buf", "");
  await tg.send(chatId, "Copy the next message and paste it into Gemini, Claude, Perplexity, ChatGPT, Grok or any other assistant. It will give you two files, memory.md and preferences.md. Send me the answer as text, or save the two files and upload them here (.md is best). If it is long, send it in parts and then say done. I'll show you a plan before I file anything, and I'll confirm each preference with you.");
  await tg.send(chatId, EXPORT_PROMPT);
}
export async function startSkills(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  await setSetting(ctx.db, "skills_wait", "1");
  await setSetting(ctx.db, "skills_batch", "0");
  await tg.send(chatId, "Send me up to 30 skills files at once, as .md or .txt (you can select several in the file picker). I read them and keep them as my playbooks, and I never change your originals. Say done when you have finished. Skills shape how I advise you; they can't change what I'm allowed to do.");
}
export async function startWriting(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  await setSetting(ctx.db, "writing_wait", "1");
  await setSetting(ctx.db, "writing_n", "0");
  await tg.send(chatId, "Send me three to five things you wrote yourself (posts, emails, notes), as messages or files, then say done. I'll learn how you write so my drafts sound like you.");
}

export async function bringCallback(ctx: Ctx, tg: Telegram, chatId: number, data: string): Promise<boolean> {
  if (!data.startsWith("ctx:")) return false;
  const act = data.slice(4);
  if (act === "paste") await startPaste(ctx, tg, chatId);
  else if (act === "skills") await startSkills(ctx, tg, chatId);
  else if (act === "writing") await startWriting(ctx, tg, chatId);
  else if (act === "done") await continueOnboarding(ctx, tg, chatId);
  return true;
}

/** From the bring-context step to the rest of onboarding. */
export async function continueOnboarding(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  await setSetting(ctx.db, "ob_step", "how");
  await tg.send(chatId, "Here's how I work. I read, think, remind and draft freely. Anything sent in your name, or that spends money, waits for your tap, and I never touch your payments. /pause stops me any time. OK?", [[{ text: "Sounds good", data: "ob:ok" }, { text: "Show me more", data: "ob:more" }]]);
}
