// Thumbs up or down under every brief and nudge. Votes are stored so the owner can see what lands and what does not.
import type { Db } from "./db.ts";
import { recordSignal } from "./policy.ts";
import type { Button } from "./telegram.ts";

export const FEEDBACK_KINDS = ["brief", "monday", "meeting", "chase"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** The two buttons, as one inline row. */
export const feedbackRow = (kind: FeedbackKind): Button[] => [{ text: "👍", data: `fb:u:${kind}` }, { text: "👎", data: `fb:d:${kind}` }];
export const isFeedback = (data: string): boolean => /^fb:[ud]:[a-z]+$/.test(data);

/** Record a vote. Returns the thank-you line, or null if the data was not a feedback tap. */
export async function recordFeedback(db: Db, now: number, data: string, msgId: number | undefined, text: string | undefined): Promise<string | null> {
  const m = /^fb:([ud]):([a-z]+)$/.exec(data);
  if (!m || !(FEEDBACK_KINDS as readonly string[]).includes(m[2] ?? "")) return null;
  const vote = m[1] === "u" ? 1 : -1;
  await db.prepare("INSERT INTO feedback (ts, kind, vote, msg_id, excerpt) VALUES (?, ?, ?, ?, ?)").bind(now, m[2], vote, msgId ?? null, (text ?? "").slice(0, 160)).run();
  if (vote < 0) await recordSignal(db, now, `${m[2]}_down`);
  return vote > 0 ? "Thanks, glad it helped." : "Noted. If you tell me what was off, I'll remember it.";
}

export async function feedbackSummary(db: Db, since: number): Promise<string> {
  const r = await db.prepare("SELECT kind, SUM(CASE WHEN vote > 0 THEN 1 ELSE 0 END) AS up, SUM(CASE WHEN vote < 0 THEN 1 ELSE 0 END) AS down FROM feedback WHERE ts >= ? GROUP BY kind ORDER BY kind").bind(since).all<{ kind: string; up: number; down: number }>();
  if (!r.results.length) return "";
  return "Feedback, last 30 days: " + r.results.map((x) => `${x.kind} ${x.up}👍 ${x.down}👎`).join(", ");
}
export const thirtyDaysAgo = (now: number): number => now - 30 * 86400000;
