const YOCTO = 10n ** 24n;

/** "10000000000000000000000" -> "0.01". Keeps up to `max` decimals, trims zeros. */
export function near(yocto: string | bigint, max = 4): string {
  const y = typeof yocto === "bigint" ? yocto : BigInt(yocto || "0");
  const whole = y / YOCTO;
  const frac = (y % YOCTO).toString().padStart(24, "0").slice(0, max).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** "1.5" -> yocto string. Throws on anything that is not a plain positive decimal. */
export function toYocto(nearAmount: string): string {
  const s = nearAmount.trim();
  if (!/^\d+(\.\d{1,24})?$/.test(s)) throw new Error("Enter an amount like 1 or 0.25");
  const [w, f = ""] = s.split(".");
  return (BigInt(w) * YOCTO + BigInt(f.padEnd(24, "0"))).toString();
}

export function shortAccount(id: string): string {
  return id.length > 26 ? `${id.slice(0, 10)}…${id.slice(-10)}` : id;
}

export function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const explorerTx = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
export const explorerAccount = (id: string) => `https://testnet.nearblocks.io/address/${id}`;
