// The gate ladder and sensitivity routing (controls note section 0). Pure functions, no I/O.

export type Sens = "S0" | "S1" | "S2" | "S3";
export type Gate = "G0" | "G1" | "G2" | "G3" | "G4";

/** Every action type the agent may execute, and its gate. An unknown type is refused. */
export const ACTION_GATE: Readonly<Record<string, Gate>> = {
  reminder: "G1",
  task_add: "G1",
  goal_add: "G1",
  ledger_set: "G1",
  note: "G0",
  spend: "G1",
  set_setting: "G1",
  poll: "G1", // sent only to the owner's own chat
  react: "G1",
};
/** G2 and above need an approval tap. No such action exists in this release, so none is executable. */
export function mayExecute(type: string): boolean {
  const g = ACTION_GATE[type];
  return g === "G0" || g === "G1";
}

interface SecretRule { name: string; re: RegExp }
const SECRET_RULES: SecretRule[] = [
  { name: "telegram-token", re: /\b\d{8,10}:[A-Za-z0-9_-]{30,60}\b/g },
  { name: "api-key", re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}\b/g },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { name: "password", re: /\b(?:password|passcode|passphrase|pin|otp|cvv)\s*(?:is|:|=)\s*\S+/gi },
];

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** S3 handling: remove secrets and card numbers before the text is stored or sent anywhere. */
export function redactSecrets(text: string): { text: string; found: string[] } {
  const found: string[] = [];
  let out = text;
  for (const r of SECRET_RULES) {
    out = out.replace(r.re, () => { found.push(r.name); return "[REDACTED]"; });
  }
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const digits = m.replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) { found.push("card-number"); return "[REDACTED]"; }
    return m;
  });
  return { text: out, found };
}

const S2_WORDS = /\b(salary|income|bonus|loan|debt|mortgage|mpesa|m-pesa|bank|balance|savings?|invest\w*|mmf|sacco|budget|spend|spent|expenses?|kes|ksh|tax|kra|rent|doctor|clinic|hospital|diagnos\w*|medic\w*|therapy|therapist|prescription|pregnan\w*|wife|husband|partner|girlfriend|boyfriend|son|daughter|baby|divorce|funeral|diary|journal)\b/i;
const PERSONAL = /\b(my|me|i|i'm|i've|we|our|mine)\b/i;

/** S0 public or low-stakes, S1 personal working data, S2 intimate (money, health, family). S3 is removed by redaction. */
export function classify(text: string): Sens {
  if (S2_WORDS.test(text)) return "S2";
  if (PERSONAL.test(text)) return "S1";
  return "S0";
}

/** Names the owner has declared confidential (an employer or client), from the CONFIDENTIAL_TERMS setting: comma separated, empty by default. */
export const termsOf = (v?: string): string[] => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** Employer or client confidential material does not enter this agent (gate G4). Off unless the owner declares terms. */
export function employerBlock(text: string, terms: string[]): boolean {
  if (!terms.length) return false;
  const names = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`\\b(${names})\\b`, "i").test(text) && /\b(confidential|board paper|customer data|client data|account number|customer list|internal memo|non-public)\b/i.test(text);
}

export function isMenuWord(text: string): string | null {
  const t = text.trim().toLowerCase();
  return ["today", "money", "coach", "business", "settings"].includes(t) ? t : null;
}
