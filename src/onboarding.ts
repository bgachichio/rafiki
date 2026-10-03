// Chat onboarding: a handful of short turns, each producing something useful. Script in 10-ux-and-user-journey.md.
import { runAgent, type Ctx } from "./agent.ts";
import { getSetting, setSetting } from "./db.ts";
import { KM } from "./knowme.ts";
import { ONBOARD_GREETING } from "./prompts.ts";
import type { Telegram } from "./telegram.ts";
import { parseHM } from "./time.ts";

const HANDSHAKE = "Here's how I work. I read, think, remind and draft freely. Anything sent in your name, or that spends money, waits for your tap, and I never touch your payments. /pause stops me any time. OK?";
const MORE = "In short: I can record reminders, tasks, goals, your customer ledger and spend. I cannot message other people, move money or delete anything. Everything I do is listed in /log, and /why explains my last decision. Mail and calendar come in a later release.";

export async function startOnboarding(ctx: Ctx, tg: Telegram, chatId: number, name: string): Promise<void> {
  if (!(await getSetting(ctx.db, "brief_time"))) await setSetting(ctx.db, "brief_time", "08:00");
  await setSetting(ctx.db, "ob_step", "help");
  await tg.send(chatId, ONBOARD_GREETING(name), [
    [{ text: "Run my week", data: "ob:r:week" }, { text: "My money", data: "ob:r:money" }],
    [{ text: "My goals", data: "ob:r:goals" }, { text: "My business", data: "ob:r:business" }],
    [{ text: "Just talk", data: "ob:r:talk" }],
  ], true);
}

async function askSlip(ctx: Ctx, tg: Telegram, chatId: number, role: string): Promise<void> {
  await setSetting(ctx.db, "ob_step", "slip");
  const q: Record<string, string> = {
    week: "Got it. What's one thing slipping right now?",
    money: "Let's start with money. What's one money thing slipping or on your mind?",
    goals: "Good. What's one thing you keep meaning to do towards your goals and haven't?",
    business: "Good. What's the one customer or business thing that's slipping right now?",
    talk: "Go ahead. What's on your mind?",
  };
  await tg.send(chatId, q[role] ?? q.week!);
}

async function askGoal(ctx: Ctx, tg: Telegram, chatId: number): Promise<void> {
  await setSetting(ctx.db, "ob_step", "goal");
  await tg.send(chatId, "What are you working toward this year? One line is fine.");
}

/** Returns true when the text was consumed by an onboarding step. */
export async function onboardingText(ctx: Ctx, tg: Telegram, chatId: number, text: string): Promise<boolean> {
  const step = await getSetting(ctx.db, "ob_step");
  if (step === "help" || step === "slip") {
    await tg.typing(chatId);
    const r = await runAgent(ctx, text, "onboarding: the owner has just told you something that is slipping. Record a reminder and a task if a time or action is implied, and give a short, concrete first step. Keep the reply under 5 lines.");
    await tg.send(chatId, r.text, r.buttons);
    await askGoal(ctx, tg, chatId);
    return true;
  }
  if (step === "goal") {
    await tg.typing(chatId);
    const r = await runAgent(ctx, text, "onboarding: the owner has just told you a goal. Save it with goal_add, restated as X to Y by when. If the number or the date is missing, ask ONE short question. Keep the reply under 5 lines.");
    await tg.send(chatId, r.text, r.buttons);
    await setSetting(ctx.db, "ob_step", "km");
    await tg.send(chatId, `Want to tell me more about you? It is ${KM.length} short questions, about four minutes, and you can skip any of them. The more I know, the better I am from the first day.`, [[{ text: "Yes, let's go", data: "km:start" }, { text: "Later", data: "km:later" }]]);
    return true;
  }
  if (step === "time_other") {
    const m = parseHM(text);
    if (m === null) { await tg.send(chatId, "Write the time like 07:15."); return true; }
    await setSetting(ctx.db, "brief_time", text.trim().padStart(5, "0"));
    await setSetting(ctx.db, "ob_step", "done");
    await tg.send(chatId, `Set. Your brief arrives at ${text.trim().padStart(5, "0")}. Tell me anything else any time, or use the menu below.`, undefined, true);
    await tg.send(chatId, "One more thing, and it makes me much more useful: nine quick taps to say how I should remind you, how long my replies should be, and when to stay quiet. You can skip any.", [[{ text: "Set up how I work", data: "dc:seq" }], [{ text: "Check voice, photos and files", data: "mc:start" }, { text: "Later", data: "ob:ok" }]]);
    return true;
  }
  return false;
}

/** Returns true when the callback belonged to onboarding. */
export async function onboardingCallback(ctx: Ctx, tg: Telegram, chatId: number, data: string): Promise<boolean> {
  if (!data.startsWith("ob:")) return false;
  const parts = data.split(":");
  if (parts[1] === "r") { await askSlip(ctx, tg, chatId, parts[2] ?? "week"); return true; }
  if (parts[1] === "more") { await tg.send(chatId, MORE, [[{ text: "Sounds good", data: "ob:ok" }]]); return true; }
  if (parts[1] === "ok") {
    await setSetting(ctx.db, "ob_step", "time");
    const t = (await getSetting(ctx.db, "brief_time")) ?? "08:00";
    await tg.send(chatId, `Done. Your first brief arrives tomorrow at ${t}. Change it?`, [[{ text: "08:00", data: "ob:t:08:00" }, { text: "06:30", data: "ob:t:06:30" }, { text: "Other", data: "ob:t:other" }]]);
    return true;
  }
  if (parts[1] === "t") {
    const v = parts.slice(2).join(":");
    if (v === "other") { await setSetting(ctx.db, "ob_step", "time_other"); await tg.send(chatId, "What time? Write it like 07:15."); return true; }
    if (parseHM(v) !== null) await setSetting(ctx.db, "brief_time", v);
    await setSetting(ctx.db, "ob_step", "done");
    await tg.send(chatId, `Set for ${v}. I'll also tell you what I can look at next when you ask. Mail and calendar come in a later release. Use the menu below any time.`, undefined, true);
    await tg.send(chatId, "One more thing, and it makes me much more useful: nine quick taps to say how I should remind you, how long my replies should be, and when to stay quiet. You can skip any.", [[{ text: "Set up how I work", data: "dc:seq" }], [{ text: "Check voice, photos and files", data: "mc:start" }, { text: "Later", data: "ob:ok" }]]);
    return true;
  }
  return false;
}
