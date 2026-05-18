// zo.space 路由：GET /api/cf-ip[?format=txt|edt]
import type { Context } from "hono";
import { readFile } from "node:fs/promises";

const DATA_FILE = "/home/workspace/Projects/cf-best-ip/data/ips.json";

async function loadData() {
  try {
    const raw = await readFile(DATA_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { ips: [], updatedAt: 0 };
  }
}

export default async (c: Context) => {
  const url = new URL(c.req.url);
  const fmt = url.searchParams.get("format");
  const port = url.searchParams.get("port");
  const limit = Number(url.searchParams.get("limit") || 0);
  const data = await loadData();
  let ips = data.ips || [];
  if (limit > 0) ips = ips.slice(0, limit);

  if (fmt === "txt" || fmt === "sub") {
    const lines = ips.map((it: any) => {
      const p = port ? Number(port) : it.port || 443;
      const tag = it.colo ? `#${it.colo}` : "";
      return `${it.ip}:${p}${tag}`;
    });
    return new Response(lines.join("\n") + "\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (fmt === "edt" || fmt === "preferred") {
    return c.json(
      ips.map((it: any) => ({
        ip: it.ip,
        port: it.port || 443,
        country: (it.colo || "").slice(0, 2),
        colo: it.colo || null,
      })),
    );
  }

  return c.json({ ok: true, updatedAt: data.updatedAt, count: ips.length, ips, sourceStats: data.sourceStats });
};
