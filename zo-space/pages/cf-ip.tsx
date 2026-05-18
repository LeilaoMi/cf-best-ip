// zo.space 路由：/cf-ip （页面）
import { useEffect, useState, useRef } from "react";
import { Cloud, Zap, RefreshCw, Copy, Download, ExternalLink, AlertCircle, Loader2 } from "lucide-react";

type IpItem = {
  ip: string;
  port: number;
  colo: string | null;
  sources?: string[];
  delay?: number | null;
  tested?: boolean;
};

type SourceStat = { name: string; count: number; error?: string };

const theme = {
  bg: "#0b0f14",
  card: "#161b22",
  border: "#30363d",
  text: "#e6edf3",
  muted: "#8b949e",
  accent: "#f9826c",
  good: "#7ee787",
  warn: "#d8af3c",
  bad: "#ff7b72",
};

async function probeIp(ip: string, port: number): Promise<{ avg: number | null; loss: number }> {
  try {
    const res = await fetch(`/api/cf-ip/probe?ip=${encodeURIComponent(ip)}&port=${port}&times=3`, {
      cache: "no-store",
    });
    if (!res.ok) return { avg: null, loss: 1 };
    const data = await res.json();
    return { avg: data.avg, loss: data.loss ?? (data.ok ? 0 : 1) };
  } catch {
    return { avg: null, loss: 1 };
  }
}

export default function CfIpPage() {
  const [ips, setIps] = useState<IpItem[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number>(0);
  const [sourceStats, setSourceStats] = useState<SourceStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const concurrencyRef = useRef(8);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/cf-ip", { headers: { accept: "application/json" } });
      const data = await res.json();
      setIps((data.ips || []).map((it: IpItem) => ({ ...it, delay: null, tested: false })));
      setUpdatedAt(data.updatedAt || 0);
      setSourceStats(data.sourceStats || []);
    } catch (e: any) {
      setError(`加载失败：${e.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    setError("");
    setStatus("正在从公开数据源拉取候选 IP…");
    try {
      const res = await fetch("/api/cf-ip/refresh", { method: "POST", headers: { accept: "application/json" } });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "刷新失败");
      setStatus(`已聚合 ${data.count} 个候选 IP（${data.elapsedMs} ms）`);
      await load();
    } catch (e: any) {
      setError(`刷新失败：${e.message || e}`);
    } finally {
      setRefreshing(false);
    }
  }

  async function testAll() {
    if (!ips.length) return;
    setTesting(true);
    setStatus("浏览器测速中…");
    setProgress({ done: 0, total: ips.length });

    const queue = [...ips.keys()];
    let done = 0;
    const next: IpItem[] = ips.map((it) => ({ ...it, delay: null, tested: false }));

    async function worker() {
      while (queue.length) {
        const idx = queue.shift()!;
        const { avg } = await probeIp(next[idx].ip, next[idx].port);
        next[idx] = { ...next[idx], delay: avg, tested: true };
        done++;
        setProgress({ done, total: ips.length });
        if (done % 3 === 0 || done === ips.length) {
          setIps([...next]);
        }
      }
    }

    await Promise.all(Array.from({ length: concurrencyRef.current }, worker));

    next.sort((a, b) => {
      const da = a.delay == null ? Infinity : a.delay;
      const db = b.delay == null ? Infinity : b.delay;
      return da - db;
    });
    setIps(next);
    setStatus(`测速完成 · ${next.filter((x) => x.delay != null).length}/${next.length} 可用`);
    setTesting(false);
  }

  function topText(n: number, opts: { withTag?: boolean } = {}) {
    return ips
      .slice(0, n)
      .map((it) => {
        const tag = opts.withTag && it.delay != null
          ? `#${it.colo || ""}${it.colo ? "-" : ""}${it.delay}ms`
          : it.colo ? `#${it.colo}` : "";
        return `${it.ip}:${it.port}${tag}`;
      })
      .join("\n");
  }

  async function copyTop(n: number) {
    const txt = topText(n, { withTag: true });
    try {
      await navigator.clipboard.writeText(txt);
      setStatus(`已复制前 ${n} 个 IP`);
    } catch {
      window.prompt("复制下方文本：", txt);
    }
  }

  function exportTxt() {
    const blob = new Blob([topText(999, { withTag: true })], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cf-best-ip-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  useEffect(() => { load(); }, []);

  const updatedStr = updatedAt > 0
    ? new Date(updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
    : "尚未刷新";

  return (
    <div
      style={{
        "--bg": theme.bg, "--card": theme.card, "--border": theme.border,
        "--text": theme.text, "--muted": theme.muted, "--accent": theme.accent,
        "--good": theme.good, "--warn": theme.warn, "--bad": theme.bad,
      } as React.CSSProperties}
      className="min-h-screen bg-[var(--bg)] text-[var(--text)]"
    >
      <div className="max-w-5xl mx-auto px-5 py-8">
        <header className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <Cloud className="w-7 h-7" style={{ color: theme.accent }} />
            <h1 className="text-2xl font-bold bg-gradient-to-r from-[#f9826c] via-[#d2a8ff] to-[#7ee787] bg-clip-text text-transparent">
              Cloudflare 优选 IP · 在线版
            </h1>
          </div>
          <p className="text-sm" style={{ color: theme.muted }}>
            聚合 7 个公开源 · 后端 TCP 三次握手测速 · 一键导出订阅
          </p>
        </header>

        <div className="flex flex-wrap items-center gap-2 mb-4 p-3 rounded-lg" style={{ background: theme.card, border: `1px solid ${theme.border}` }}>
          <button onClick={refresh} disabled={refreshing || testing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md font-semibold text-sm transition disabled:opacity-50 disabled:cursor-wait"
            style={{ background: refreshing ? theme.border : "#238636", color: "#fff" }}>
            {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {refreshing ? "拉取中…" : "刷新候选"}
          </button>
          <button onClick={testAll} disabled={!ips.length || testing || refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md font-semibold text-sm transition disabled:opacity-50 disabled:cursor-wait"
            style={{ background: testing ? theme.border : theme.accent, color: "#fff" }}>
            {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {testing ? `测速 ${progress.done}/${progress.total}` : "在线测速"}
          </button>
          <button onClick={() => copyTop(5)} disabled={!ips.length}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition disabled:opacity-40"
            style={{ background: theme.border, color: theme.text }}>
            <Copy className="w-4 h-4" /> 复制前 5
          </button>
          <button onClick={() => copyTop(10)} disabled={!ips.length}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition disabled:opacity-40"
            style={{ background: theme.border, color: theme.text }}>
            <Copy className="w-4 h-4" /> 复制前 10
          </button>
          <button onClick={exportTxt} disabled={!ips.length}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition disabled:opacity-40"
            style={{ background: theme.border, color: theme.text }}>
            <Download className="w-4 h-4" /> 导出 txt
          </button>
          <div className="ml-auto text-xs" style={{ color: theme.muted }}>
            最后更新：<code style={{ color: theme.text }}>{updatedStr}</code> · 共 <b>{ips.length}</b> 个
          </div>
        </div>

        {status && (<div className="mb-3 text-xs px-3 py-2 rounded" style={{ background: theme.card, color: theme.muted }}>{status}</div>)}
        {error && (<div className="mb-3 text-xs px-3 py-2 rounded flex items-center gap-2" style={{ background: "#2d1418", color: theme.bad }}><AlertCircle className="w-4 h-4" /> {error}</div>)}

        <div className="rounded-lg overflow-hidden" style={{ background: theme.card, border: `1px solid ${theme.border}` }}>
          {loading ? (
            <div className="p-12 text-center" style={{ color: theme.muted }}>
              <Loader2 className="w-6 h-6 mx-auto animate-spin mb-2" />加载中…
            </div>
          ) : ips.length === 0 ? (
            <div className="p-12 text-center" style={{ color: theme.muted }}>
              <p className="mb-3">还没有候选 IP，点击「刷新候选」开始</p>
            </div>
          ) : (
            <table className="w-full text-sm font-mono">
              <thead>
                <tr style={{ background: theme.bg, color: theme.muted }}>
                  <th className="text-left px-3 py-2 w-12">#</th>
                  <th className="text-left px-3 py-2">IP</th>
                  <th className="text-left px-3 py-2 w-20">端口</th>
                  <th className="text-left px-3 py-2 w-20">colo</th>
                  <th className="text-left px-3 py-2 w-24">命中</th>
                  <th className="text-left px-3 py-2 w-28">节点延迟</th>
                </tr>
              </thead>
              <tbody>
                {ips.map((it, i) => {
                  const d = it.delay;
                  const cls = d == null ? "" : d < 200 ? "good" : d < 500 ? "warn" : "bad";
                  const color = cls === "good" ? theme.good : cls === "warn" ? theme.warn : cls === "bad" ? theme.bad : theme.muted;
                  return (
                    <tr key={`${it.ip}:${it.port}`} style={{ borderTop: `1px solid ${theme.bg}` }}>
                      <td className="px-3 py-1.5" style={{ color: theme.muted }}>{i + 1}</td>
                      <td className="px-3 py-1.5">{it.ip}</td>
                      <td className="px-3 py-1.5" style={{ color: theme.muted }}>{it.port}</td>
                      <td className="px-3 py-1.5" style={{ color: theme.muted }}>{it.colo || "-"}</td>
                      <td className="px-3 py-1.5" style={{ color: theme.muted }}>{it.sources?.length ?? 1}×</td>
                      <td className="px-3 py-1.5" style={{ color }}>
                        {it.tested ? (d == null ? "✗ 失败" : `${d} ms`) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {sourceStats.length > 0 && (
          <details className="mt-5 text-xs" style={{ color: theme.muted }}>
            <summary className="cursor-pointer mb-2">数据源统计 ({sourceStats.length})</summary>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {sourceStats.map((s) => (
                <div key={s.name} className="px-3 py-2 rounded" style={{ background: theme.card, border: `1px solid ${theme.border}` }}>
                  <code style={{ color: s.error ? theme.bad : theme.text }}>{s.name}</code>
                  <span className="ml-2">{s.error ? `✗ ${s.error}` : `${s.count} 个`}</span>
                </div>
              ))}
            </div>
          </details>
        )}

        <footer className="mt-8 text-xs flex flex-wrap gap-4" style={{ color: theme.muted }}>
          <span>接口：</span>
          <a href="/api/cf-ip" target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "#58a6ff" }}><ExternalLink className="w-3 h-3 inline mr-0.5" />/api/cf-ip</a>
          <a href="/api/cf-ip?format=txt" target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "#58a6ff" }}><ExternalLink className="w-3 h-3 inline mr-0.5" />/api/cf-ip?format=txt</a>
          <a href="/api/cf-ip?format=edt" target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "#58a6ff" }}><ExternalLink className="w-3 h-3 inline mr-0.5" />/api/cf-ip?format=edt</a>
        </footer>

        <details className="mt-4 text-xs px-3 py-2 rounded" style={{ background: theme.card, color: theme.muted, border: `1px solid ${theme.border}` }}>
          <summary className="cursor-pointer">⚠️ 测速结果含义说明</summary>
          <p className="mt-2 leading-relaxed">
            点击"在线测速"会让 <b>服务器</b> 对每个 IP 做 3 次 TCP 三次握手，
            反映的是 <b>服务器 → CF 节点</b> 的延迟，用作 <b>节点健康度筛选</b>。
            <br />
            如果你想测「本地家庭网络 → CF 节点」的真实速度，请下载
            <a className="underline mx-1" style={{ color: "#58a6ff" }} target="_blank" rel="noreferrer" href="https://github.com/XIU2/CloudflareSpeedTest/releases">CloudflareSpeedTest</a>
            把导出的 txt 喂给它。
          </p>
        </details>
      </div>
    </div>
  );
}
