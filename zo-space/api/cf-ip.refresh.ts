// zo.space 路由：POST /api/cf-ip/refresh
// 从公开数据源聚合候选 IP 并保存到 data/ips.json
import type { Context } from "hono";
import { readFile, writeFile } from "node:fs/promises";

const DATA_FILE = "/home/workspace/Projects/cf-best-ip/data/ips.json";

const IP_SOURCES = [
  { name: "addressesapi/ip.164746.xyz", url: "https://addressesapi.090227.xyz/ip.164746.xyz", type: "text" as const },
  { name: "addressesapi/CloudFlareYes", url: "https://addressesapi.090227.xyz/CloudFlareYes", type: "text" as const },
  { name: "addressesapi/cmcc", url: "https://addressesapi.090227.xyz/cmcc", type: "text" as const },
  { name: "addressesapi/ct", url: "https://addressesapi.090227.xyz/ct", type: "text" as const },
  { name: "addressesapi/cu", url: "https://addressesapi.090227.xyz/cu", type: "text" as const },
  { name: "ip.164746.xyz/ipTop", url: "https://ip.164746.xyz/ipTop.html", type: "text" as const },
  { name: "IPDB/proxy", url: "https://raw.githubusercontent.com/ymyuuu/IPDB/main/proxy.txt", type: "text" as const },
];

const IPV4_RE = /\b((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?::(\d{2,5}))?(?:\s*[#|]\s*([A-Z]{2,}))?/g;

function parseText(text: string) {
  const out: { ip: string; port: number; colo: string | null }[] = [];
  let m: RegExpExecArray | null;
  while ((m = IPV4_RE.exec(text)) !== null) {
    const ip = m[1];
    const first = parseInt(ip.split(".")[0], 10);
    if (first === 0 || first === 10 || first === 127 || first >= 224) continue;
    if (ip.startsWith("192.168.") || ip.startsWith("172.16.") || ip.startsWith("169.254.")) continue;
    out.push({ ip, port: m[2] ? Number(m[2]) : 443, colo: m[3] || null });
  }
  return out;
}

function parseHtml(html: string) {
  return parseText(html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "));
}

async function fetchOne(src: typeof IP_SOURCES[number]) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(src.url, {
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 cf-best-ip-zo" },
    });
    if (!res.ok) throw new Error(`${src.name} HTTP ${res.status}`);
    const text = await res.text();
    return src.type === "html" ? parseHtml(text) : parseText(text);
  } finally {
    clearTimeout(timer);
  }
}

export default async (c: Context) => {
  const t0 = Date.now();
  const results = await Promise.allSettled(IP_SOURCES.map(fetchOne));
  const map = new Map<string, { ip: string; port: number; colo: string | null; sources: string[] }>();
  const sourceStats: { name: string; count: number; error?: string }[] = [];

  results.forEach((r, i) => {
    const src = IP_SOURCES[i];
    if (r.status !== "fulfilled") {
      sourceStats.push({ name: src.name, count: 0, error: String((r as any).reason?.message || r.reason).slice(0, 200) });
      return;
    }
    sourceStats.push({ name: src.name, count: r.value.length });
    for (const item of r.value) {
      const key = `${item.ip}:${item.port}`;
      const prev = map.get(key);
      if (prev) {
        prev.sources.push(src.name);
        if (item.colo && !prev.colo) prev.colo = item.colo;
      } else {
        map.set(key, { ...item, sources: [src.name] });
      }
    }
  });

  const ips = Array.from(map.values())
    .sort((a, b) => b.sources.length - a.sources.length)
    .slice(0, 50);

  const payload = {
    ips,
    updatedAt: Date.now(),
    elapsedMs: Date.now() - t0,
    sourceStats,
  };
  await writeFile(DATA_FILE, JSON.stringify(payload, null, 2), "utf-8");
  return c.json({ ok: true, count: ips.length, ...payload });
};
