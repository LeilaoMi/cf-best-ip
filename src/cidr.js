export const CF_IPV4_CIDRS = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

const CF_RANGES = CF_IPV4_CIDRS.map(c => {
  const [base, bits] = c.split("/");
  const m = base.split(".").map(Number);
  const baseInt = ((m[0] << 24) | (m[1] << 16) | (m[2] << 8) | m[3]) >>> 0;
  const bitsN = +bits;
  const mask = bitsN === 0 ? 0 : (0xffffffff << (32 - bitsN)) >>> 0;
  return [baseInt & mask, mask];
});

export function ipToInt(ip) {
  const m = String(ip).split(".");
  if (m.length !== 4) return null;
  let v = 0;
  for (let i = 0; i < 4; i++) {
    const n = +m[i];
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    v = ((v << 8) | n) >>> 0;
  }
  return v;
}

export function isCfNativeIp(ip) {
  if (ip == null) return false;
  if (typeof ip === "string" && ip.includes(":")) return isCfNativeIpV6(ip);
  const v = ipToInt(ip);
  if (v == null) return false;
  for (const [net, mask] of CF_RANGES) {
    if ((v & mask) === net) return true;
  }
  return false;
}

export const CF_IPV6_CIDRS = [
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

export function ipv6ToBigInt(ip) {
  const parts = ip.split(":");
  let full = [];
  if (parts.includes("")) {
    const idx = parts.indexOf("");
    const before = parts.slice(0, idx).filter(p => p !== "");
    const after = parts.slice(idx + 1).filter(p => p !== "");
    const zeros = 8 - before.length - after.length;
    full = [...before, ...Array(zeros).fill("0"), ...after];
  } else {
    full = parts;
  }
  if (full.length !== 8) throw new Error("invalid IPv6 address");
  let v = 0n;
  for (const p of full) {
    const n = parseInt(p || "0", 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error("invalid IPv6 address");
    v = (v << 16n) | BigInt(n);
  }
  return v;
}

const CF_RANGES_V6 = CF_IPV6_CIDRS.map(c => {
  const [addr, bits] = c.split("/");
  const net = ipv6ToBigInt(addr);
  const bitsN = BigInt(+bits);
  const mask = bitsN === 0n ? 0n : (0xffffffffffffffffffffffffffffffffn << (128n - bitsN));
  return [net & mask, mask];
});

export function isCfNativeIpV6(ip) {
  try {
    const v = ipv6ToBigInt(ip);
    for (const [net, mask] of CF_RANGES_V6) {
      if ((v & mask) === net) return true;
    }
  } catch {}
  return false;
}
