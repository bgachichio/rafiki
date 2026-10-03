// Deterministic spend parsing and fee lookup. No model involved: the maths is plain code.
export interface ParsedSpend { amountCents: number; category: string; channel: string | null; note: string }
export interface Tier { channel: string; min_cents: number; max_cents: number; fee_cents: number }

const CATS: [string, RegExp][] = [
  ["Food", /\b(lunch|dinner|breakfast|food|coffee|tea|groceries|snack|restaurant|nyama|supper|juice)\b/i],
  ["Transport", /\b(fuel|petrol|diesel|uber|bolt|matatu|taxi|fare|parking|boda|toll)\b/i],
  ["Bills", /\b(rent|kplc|electricity|water|wifi|internet|airtime|data|bundles|insurance|subscription)\b/i],
  ["Health", /\b(doctor|clinic|pharmacy|medicine|hospital|dentist)\b/i],
  ["Family", /\b(mum|mama|mom|dad|school|fees|sister|brother|kids?)\b/i],
  ["Fun", /\b(movie|beer|drinks?|netflix|games?|concert|outing)\b/i],
];
const NOT_A_SPEND = /\b(remind|goal|plan|should|how|what|why|when|can you|help|advise|budget|ledger|task)\b|\?/i;

export function categorise(desc: string): string {
  for (const [name, re] of CATS) if (re.test(desc)) return name;
  return "Other";
}
function toCents(s: string): number {
  return Math.round(Number(s.replace(/,/g, "")) * 100);
}
function chan(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.toLowerCase();
  return t === "m-pesa" || t === "mpesa" ? "mpesa" : t;
}

/** "lunch 650 mpesa", "650 lunch", "spent 1,200 on fuel cash". Returns null when it does not look like a spend. */
export function parseSpendLine(line: string): ParsedSpend | null {
  const t = line.trim();
  if (t.length === 0 || t.length > 70 || t.startsWith("/") || NOT_A_SPEND.test(t)) return null;
  const num = String.raw`(?:kes|ksh)?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(?:kes|ksh)?`;
  const ch = String.raw`(mpesa|m-pesa|cash|card|bank)`;
  const a = new RegExp(String.raw`^(?:spent|paid|bought)?\s*${num}\s*(?:on|for)?\s*([a-z][a-z' -]{0,30}?)\s*(?:via|on|by|using)?\s*${ch}?$`, "i").exec(t);
  const b = new RegExp(String.raw`^([a-z][a-z' -]{1,30}?)\s+${num}\s*${ch}?$`, "i").exec(t);
  let amount: string | undefined;
  let desc: string | undefined;
  let channel: string | undefined;
  if (b) { desc = b[1]; amount = b[2]; channel = b[3]; }
  else if (a) { amount = a[1]; desc = a[2]; channel = a[3]; }
  if (!amount || !desc) return null;
  const cents = toCents(amount);
  if (!(cents > 0)) return null;
  const note = desc.trim();
  return { amountCents: cents, category: categorise(note), channel: chan(channel), note };
}

export function feeFor(tiers: Tier[], channel: string | null, amountCents: number): number | null {
  if (!channel) return null;
  const t = tiers.find((x) => x.channel === channel && amountCents >= x.min_cents && amountCents <= x.max_cents);
  return t ? t.fee_cents : null;
}

/** "mpesa 1-100=0 101-500=7" to tiers (whole shillings in, cents out). Null on malformed input. */
export function parseFees(args: string): { channel: string; tiers: Tier[] } | null {
  const parts = args.trim().split(/\s+/);
  const channel = chan(parts.shift());
  if (!channel || !["mpesa", "cash", "card", "bank"].includes(channel) || parts.length === 0) return null;
  const tiers: Tier[] = [];
  for (const p of parts) {
    const m = /^(\d+)-(\d+)=(\d+(?:\.\d+)?)$/.exec(p);
    if (!m) return null;
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (hi < lo) return null;
    tiers.push({ channel, min_cents: lo * 100, max_cents: hi * 100 + 99, fee_cents: Math.round(Number(m[3]) * 100) });
  }
  return { channel, tiers };
}

export function kes(cents: number): string {
  const v = cents / 100;
  return `KES ${v.toLocaleString("en-US", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
