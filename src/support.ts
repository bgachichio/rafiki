// Credits and the Support sheet. Values are copied from the author's published details; the build refuses empty ones.
export const AUTHOR = { name: "Brian Gachichio", x: "https://x.com/b_gachichio", github: "https://github.com/bgachichio/rafiki", site: "https://rafiki.gachichio.org" } as const;
export const SUPPORT = {
  card: "https://paystack.shop/pay/gachichio",
  lightning: "gachichio@walletofsatoshi.com",
  bitcoin: "bc1ptrd8ykgu046nkwjml4kvtke0vz6ga0cmhccmgkpspwuswrasjspqq6yfu6",
} as const;

export const SIGN_OFF = `Made with ❤️ by ${AUTHOR.name}`;

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const polymod = (values: number[]): number => {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i]!;
  }
  return chk >>> 0;
};
/** Bech32m checksum check (BIP-350), so a typo in the on-chain address fails the build. */
export function bech32mValid(addr: string): boolean {
  const s = addr.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length || s.length > 90) return false;
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => CHARSET.indexOf(c));
  if (data.some((d) => d < 0)) return false;
  const expand = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  return polymod([...expand, ...data]) === 0x2bc830a3;
}

export function aboutText(): string {
  return [
    `Rafiki is a personal agent for Telegram. It is free, open source (AGPL-3.0) and has no ads.`,
    `${SIGN_OFF}`,
    `${AUTHOR.x}\n${AUTHOR.github}\n${AUTHOR.site}`,
    `If it saved you time, you can help keep it that way. Payments leave Rafiki only when you tap.`,
  ].join("\n\n");
}
