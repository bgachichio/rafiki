// Encryption at rest and request signing, on Web Crypto only. The key comes from a Worker secret, never from the database.
const te = new TextEncoder();
const td = new TextDecoder();

function toB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function aesKey(secret: string): Promise<CryptoKey> {
  const h = await crypto.subtle.digest("SHA-256", te.encode(`rafiki-aes:${secret}`));
  return crypto.subtle.importKey("raw", h, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM. Output is base64 of iv (12 bytes) followed by ciphertext. */
export async function encrypt(secret: string, plain: string): Promise<string> {
  if (!secret) throw new Error("no encryption key");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), te.encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toB64(out);
}
export async function decrypt(secret: string, token: string): Promise<string> {
  const raw = fromB64(token);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await aesKey(secret), raw.slice(12));
  return td.decode(pt);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", te.encode(`rafiki-hmac:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
export async function hmacHex(secret: string, msg: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), te.encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The key for data at rest: ENCRYPTION_KEY if the owner set one, otherwise derived from the bot token (a secret only this Worker holds). */
export async function keyOf(env: { ENCRYPTION_KEY?: string; TELEGRAM_BOT_TOKEN?: string }): Promise<string> {
  if (env.ENCRYPTION_KEY) return env.ENCRYPTION_KEY;
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(`rafiki-key:${env.TELEGRAM_BOT_TOKEN ?? ""}`)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}
