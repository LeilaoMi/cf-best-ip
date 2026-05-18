// zo.space 路由：GET /api/cf-ip/probe?ip=...&port=443&times=3
// 后端 TCP 三次握手测速
import type { Context } from "hono";
import net from "node:net";

function tcpPing(ip: string, port: number, timeoutMs = 3000): Promise<number | null> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const sock = new net.Socket();
    const finish = (v: number | null) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(Date.now() - t0));
    sock.once("timeout", () => finish(null));
    sock.once("error", () => finish(null));
    sock.connect(port, ip);
  });
}

export default async (c: Context) => {
  const ip = c.req.query("ip");
  const port = Number(c.req.query("port") || 443);
  const times = Math.min(5, Math.max(1, Number(c.req.query("times") || 3)));
  if (!ip || (!/^[\d.]+$/.test(ip) && !/^[\da-f:]+$/i.test(ip))) {
    return c.json({ ok: false, error: "invalid ip" }, 400);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return c.json({ ok: false, error: "invalid port" }, 400);
  }

  const samples: (number | null)[] = [];
  for (let i = 0; i < times; i++) {
    samples.push(await tcpPing(ip, port));
  }
  const ok = samples.filter((s) => s !== null) as number[];
  const loss = (times - ok.length) / times;
  const min = ok.length ? Math.min(...ok) : null;
  const avg = ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null;

  return c.json({ ok: ok.length > 0, ip, port, times, min, avg, loss, samples });
};
