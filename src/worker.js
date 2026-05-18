/**
 * CF Best IP — 优选 IP 一站式 Worker
 * ------------------------------------------------------------
 * 功能：
 *  - 多源聚合候选 IP（cf.090227.xyz、ipdb、cmliu 源、hostmonit 等）
 *  - Worker subrequest 可用性二次校验（cdn-cgi/trace）
 *  - 浏览器一键测速 + 排序
 *  - KV 持久化 + Cron 定时刷新
 *  - 订阅接口：/sub（txt）、/api/ips（JSON）、/api/preferred-ips（EDT 兼容）
 *  - 自动同步到 Cloudflare DNS（可选）
 *  - 管理面板 /admin（密码保护）
 *
 * 部署：见 README.md
 *
 * 必填环境变量：
 *   ADMIN_PASSWORD   管理员登录密码
 * 可选环境变量：
 *   SUB_TOKEN        订阅鉴权 token（不设置则订阅公开）
 *   CF_API_TOKEN     用于同步 DNS 的 Cloudflare API Token（Zone:DNS:Edit）
 *   CF_ZONE_ID       同步目标域名所在 Zone
 *   CF_RECORD_NAME   同步目标 A 记录（如 cf.example.com）
 *   DNS_TOP_N        DNS 同步取前 N 个 IP（默认 10）
 *
 * KV 绑定：
 *   KV               命名空间名固定为 KV
 */

// ============================================================
// 1. 默认配置 & 数据源
// ============================================================
const DEFAULT_CONFIG = {
  // 默认拉取前 N 个 IP 作为优选结果
  topN: 30,
  // 每个 IP 做可用性校验时的超时（ms）
  probeTimeoutMs: 4000,
  // Worker 端校验并发数
  probeConcurrency: 30,
  // 国家黑名单（去掉 CN/HK 等高污染地区，可在管理面板改）
  countryBlocklist: ["CN"],
};

/** 公开 IP 数据源列表 —— 失败的源会被自动跳过 */
const IP_SOURCES = [
  { name: "addressesapi/ip.164746.xyz", url: "https://addressesapi.090227.xyz/ip.164746.xyz", type: "text" },
  { name: "addressesapi/CloudFlareYes", url: "https://addressesapi.090227.xyz/CloudFlareYes", type: "text" },
  { name: "addressesapi/cmcc", url: "https://addressesapi.090227.xyz/cmcc", type: "text" },
  { name: "addressesapi/ct", url: "https://addressesapi.090227.xyz/ct", type: "text" },
  { name: "ip.164746.xyz/ipTop", url: "https://ip.164746.xyz/ipTop.html", type: "text" },
  { name: "IPDB/proxy", url: "https://raw.githubusercontent.com/ymyuuu/IPDB/main/proxy.txt", type: "text" },
];

// ============================================================
// 2. 入口
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      return await route(request, env, ctx, url);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },

  // Cron 定时刷新（在 wrangler.toml 配置）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAll(env, "[cron]"));
  },
};

async function route(request, env, ctx, url) {
  const { pathname, searchParams } = url;

  // 公开接口
  if (pathname === "/" || pathname === "/index.html") return homePage(env);
  if (pathname === "/sub") return subEndpoint(request, env);
  if (pathname === "/api/ips") return jsonIps(env, searchParams);
  if (pathname === "/api/preferred-ips") return edtCompatibleIps(env, searchParams);
  if (pathname === "/api/sources") return json({ sources: IP_SOURCES });

  // 管理面板
  if (pathname === "/admin") return adminPage(request, env);
  if (pathname === "/admin/refresh") return adminRefresh(request, env, ctx);
  if (pathname === "/admin/save-config") return adminSaveConfig(request, env);
  if (pathname === "/admin/sync-dns") return adminSyncDns(request, env, ctx);

  // 浏览器端测速辅助：返回 cdn-cgi/trace 的 colo 信息
  if (pathname === "/cdn-cgi/trace") return cgiTrace(request);

  return new Response("Not Found", { status: 404 });
}

// ============================================================
// 3. 数据源抓取 & 解析
// ============================================================
async function fetchSources() {
  const results = await Promise.allSettled(IP_SOURCES.map(fetchOneSource));
  const ips = new Map(); // ip -> { ip, port, sources: [], colo?: }
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    for (const item of r.value) {
      const key = `${item.ip}:${item.port}`;
      const prev = ips.get(key);
      if (prev) {
        prev.sources.push(IP_SOURCES[i].name);
        if (item.colo && !prev.colo) prev.colo = item.colo;
      } else {
        ips.set(key, { ...item, sources: [IP_SOURCES[i].name] });
      }
    }
  });
  return Array.from(ips.values());
}

async function fetchOneSource(src) {
  const res = await fetch(src.url, {
    cf: { cacheTtl: 600 },
    headers: { "user-agent": "Mozilla/5.0 cf-best-ip-worker" },
  });
  if (!res.ok) throw new Error(`${src.name} ${res.status}`);
  const text = await res.text();
  return src.type === "html" ? parseHtml(text) : parseText(text);
}

const IPV4_RE = /\b((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?::(\d{2,5}))?(?:\s*[#|]\s*([A-Z]{2,}))?/g;
function parseText(text) {
  const out = [];
  let m;
  while ((m = IPV4_RE.exec(text)) !== null) {
    out.push({ ip: m[1], port: m[2] ? Number(m[2]) : 443, colo: m[3] || null });
  }
  return out;
}

function parseHtml(html) {
  // 把 HTML 里的标签剥掉再扔给 parseText
  const stripped = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  return parseText(stripped);
}

// ============================================================
// 4. Worker 端可用性 / 延迟校验
// ============================================================
async function probeIp(candidate) {
  const { ip, port } = candidate;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_CONFIG.probeTimeoutMs);
  const t0 = Date.now();
  try {
    // resolveOverride 是 Workers 提供的 cf 选项，
    // 让 fetch 走我们指定的 IP 而不是 DNS 解析结果。
    const res = await fetch(`https://cloudflare.com/cdn-cgi/trace`, {
      signal: ctrl.signal,
      cf: { resolveOverride: ip },
    });
    const delay = Date.now() - t0;
    if (!res.ok) return null;
    const text = await res.text();
    const colo = (text.match(/colo=([A-Z]{2,})/) || [])[1] || null;
    const loc = (text.match(/loc=([A-Z]{2,})/) || [])[1] || null;
    return { ip, port, delay, colo, loc };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function probeAll(candidates, concurrency = DEFAULT_CONFIG.probeConcurrency) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < candidates.length) {
      const cur = candidates[i++];
      const r = await probeIp(cur);
      if (r) out.push(r);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  out.sort((a, b) => a.delay - b.delay);
  return out;
}

// ============================================================
// 5. 主流程 / KV 持久化
// ============================================================
const KV_KEYS = {
  ips: "best_ips",            // JSON 数组 [{ ip, port, delay, colo, loc }]
  updatedAt: "best_ips_at",
  config: "config",
  lastError: "last_error",
};

async function loadConfig(env) {
  const raw = await env.KV.get(KV_KEYS.config);
  if (!raw) return { ...DEFAULT_CONFIG };
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}

async function loadIps(env) {
  const raw = await env.KV.get(KV_KEYS.ips);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function refreshAll(env, tag = "[manual]") {
  const config = await loadConfig(env);
  const startedAt = Date.now();
  try {
    const candidates = await fetchSources();
    // 去重 & 过滤黑名单（按 colo 国家前缀简单识别，不严格）
    const filtered = candidates.filter((c) => {
      if (!c.colo) return true;
      const country = c.colo.slice(0, 2);
      return !config.countryBlocklist.includes(country);
    });

    // 校验
    const probed = await probeAll(filtered, DEFAULT_CONFIG.probeConcurrency);

    // 二次国家过滤（来自 Worker 探针的真实 colo）
    const final = probed
      .filter((p) => !config.countryBlocklist.includes((p.colo || "").slice(0, 2)))
      .slice(0, config.topN);

    await env.KV.put(KV_KEYS.ips, JSON.stringify(final));
    await env.KV.put(KV_KEYS.updatedAt, String(Date.now()));
    await env.KV.delete(KV_KEYS.lastError);

    // 如果配了 DNS 同步，顺便同步
    if (env.CF_API_TOKEN && env.CF_ZONE_ID && env.CF_RECORD_NAME) {
      await syncDns(env, final.slice(0, Number(env.DNS_TOP_N || 10)));
    }
    return { ok: true, count: final.length, candidates: candidates.length, ms: Date.now() - startedAt, tag };
  } catch (e) {
    await env.KV.put(KV_KEYS.lastError, `${tag} ${e.message || e} @ ${new Date().toISOString()}`);
    return { ok: false, error: String(e.message || e), ms: Date.now() - startedAt, tag };
  }
}

// ============================================================
// 6. Cloudflare DNS 同步
// ============================================================
async function syncDns(env, ips) {
  if (!ips.length) return { ok: false, reason: "no_ip" };
  const api = "https://api.cloudflare.com/client/v4";
  const headers = {
    "Authorization": `Bearer ${env.CF_API_TOKEN}`,
    "Content-Type": "application/json",
  };

  // 拉取该记录名下所有 A 记录
  const listRes = await fetch(`${api}/zones/${env.CF_ZONE_ID}/dns_records?type=A&name=${encodeURIComponent(env.CF_RECORD_NAME)}&per_page=100`, { headers });
  const listJson = await listRes.json();
  if (!listJson.success) return { ok: false, reason: "list_failed", detail: listJson.errors };

  const oldIds = (listJson.result || []).map((r) => r.id);
  const deletes = oldIds.map((id) => ({ id }));
  const posts = ips.map((it) => ({
    type: "A",
    name: env.CF_RECORD_NAME,
    content: it.ip,
    ttl: 60,
    proxied: false,
    comment: `cf-best-ip ${it.colo || ""} ${it.delay}ms`.trim(),
  }));

  // 原子批量
  const batchRes = await fetch(`${api}/zones/${env.CF_ZONE_ID}/dns_records/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ deletes, posts }),
  });
  const batchJson = await batchRes.json();
  return { ok: !!batchJson.success, detail: batchJson };
}

// ============================================================
// 7. 路由处理
// ============================================================
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" },
  });
}

function checkSubToken(request, env) {
  if (!env.SUB_TOKEN) return true;
  const url = new URL(request.url);
  return url.searchParams.get("token") === env.SUB_TOKEN
      || request.headers.get("authorization") === `Bearer ${env.SUB_TOKEN}`;
}

async function subEndpoint(request, env) {
  if (!checkSubToken(request, env)) return text("Forbidden", 403);
  const url = new URL(request.url);
  const port = url.searchParams.get("port"); // 强制端口
  const limit = Number(url.searchParams.get("limit") || 0);
  let ips = await loadIps(env);
  if (limit > 0) ips = ips.slice(0, limit);
  const lines = ips.map((it) => {
    const p = port ? Number(port) : (it.port || 443);
    const tag = it.colo ? `#${it.colo}-${it.delay}ms` : `#${it.delay}ms`;
    return `${it.ip}:${p}${tag}`;
  });
  return text(lines.join("\n") + "\n");
}

async function jsonIps(env, searchParams) {
  const ips = await loadIps(env);
  const updatedAt = Number(await env.KV.get(KV_KEYS.updatedAt) || 0);
  return json({ ok: true, updatedAt, count: ips.length, ips });
}

async function edtCompatibleIps(env, searchParams) {
  // 兼容 EdgeTunnel / CFnew 的 /api/preferred-ips 格式
  const ips = await loadIps(env);
  return json(ips.map((it) => ({
    ip: it.ip,
    port: it.port || 443,
    country: (it.colo || "").slice(0, 2),
    colo: it.colo || null,
    delay: it.delay,
  })));
}

async function cgiTrace(request) {
  const cf = request.cf || {};
  const body = [
    `colo=${cf.colo || ""}`,
    `loc=${cf.country || ""}`,
    `ts=${Date.now()/1000}`,
  ].join("\n");
  return text(body);
}

// ============================================================
// 8. 管理面板（密码保护）
// ============================================================
function unauthorized() {
  return new Response("Auth required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="cf-best-ip"' },
  });
}

function checkAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Basic ")) return false;
  try {
    const decoded = atob(auth.slice(6));
    const [, pwd] = decoded.split(":");
    return pwd === env.ADMIN_PASSWORD;
  } catch { return false; }
}

async function adminPage(request, env) {
  if (!checkAdmin(request, env)) return unauthorized();
  const config = await loadConfig(env);
  const ips = await loadIps(env);
  const updatedAt = Number(await env.KV.get(KV_KEYS.updatedAt) || 0);
  const lastError = await env.KV.get(KV_KEYS.lastError);

  const updatedStr = updatedAt ? new Date(updatedAt).toISOString() : "(never)";
  const dnsReady = !!(env.CF_API_TOKEN && env.CF_ZONE_ID && env.CF_RECORD_NAME);

  const html = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>cf-best-ip · 管理面板</title>
<style>
  body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",Helvetica,Arial,sans-serif;background:#0b0f14;color:#e6edf3;margin:0;padding:24px;max-width:1100px;margin:auto}
  h1{font-size:22px;margin:0 0 16px}
  h2{font-size:16px;margin:24px 0 8px;color:#7ee787}
  .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px}
  button{background:#238636;color:#fff;border:0;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:14px;margin-right:6px}
  button.secondary{background:#30363d}
  button.danger{background:#da3633}
  input,textarea{background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:6px 8px;width:100%;box-sizing:border-box;font:13px monospace}
  table{width:100%;border-collapse:collapse;font:12px monospace}
  th,td{padding:4px 8px;text-align:left;border-bottom:1px solid #21262d}
  th{color:#8b949e;font-weight:600}
  .muted{color:#8b949e}
  .badge{display:inline-block;padding:2px 6px;border-radius:4px;background:#30363d;font-size:11px;color:#8b949e;margin-left:6px}
  .err{color:#ff7b72}
  pre{white-space:pre-wrap;word-break:break-all;background:#0d1117;padding:8px;border-radius:6px}
</style></head>
<body>
<h1>☁️ cf-best-ip <span class="badge">v1.0</span></h1>

<div class="card">
  <h2 style="margin-top:0">当前状态</h2>
  <p>共 <b>${ips.length}</b> 个优选 IP，最后更新：<span class="muted">${updatedStr}</span></p>
  <p>DNS 自动同步：<b>${dnsReady ? "✅ 已配置" : "⚠️ 未配置（缺 CF_API_TOKEN / CF_ZONE_ID / CF_RECORD_NAME）"}</b></p>
  ${lastError ? `<p class="err">⚠️ ${escapeHtml(lastError)}</p>` : ""}
  <div>
    <button onclick="run('/admin/refresh')">🔄 立即刷新</button>
    ${dnsReady ? `<button class="secondary" onclick="run('/admin/sync-dns')">📡 仅同步 DNS</button>` : ""}
    <a href="/" target="_blank"><button class="secondary">🏠 首页</button></a>
    <a href="/sub" target="_blank"><button class="secondary">📋 订阅(txt)</button></a>
    <a href="/api/ips" target="_blank"><button class="secondary">🔧 API(JSON)</button></a>
  </div>
  <pre id="result" class="muted" style="display:none"></pre>
</div>

<div class="card">
  <h2 style="margin-top:0">配置</h2>
  <form onsubmit="event.preventDefault();saveConfig(this)">
    <p>每次刷新保留前 N 个 IP（topN）<br>
       <input name="topN" type="number" min="1" max="200" value="${config.topN}"></p>
    <p>国家黑名单（colo 前缀，逗号分隔；CN 表示中国大陆）<br>
       <input name="countryBlocklist" value="${config.countryBlocklist.join(',')}"></p>
    <button>保存配置</button>
  </form>
</div>

<div class="card">
  <h2 style="margin-top:0">当前优选 IP 列表</h2>
  <table>
    <thead><tr><th>#</th><th>IP</th><th>端口</th><th>colo</th><th>延迟(ms)</th></tr></thead>
    <tbody>
      ${ips.map((it,i) => `<tr>
        <td>${i+1}</td>
        <td>${it.ip}</td>
        <td>${it.port}</td>
        <td>${it.colo || ""}</td>
        <td>${it.delay}</td>
      </tr>`).join("")}
    </tbody>
  </table>
</div>

<script>
async function run(path){
  const r = document.getElementById('result');
  r.style.display='block'; r.textContent='执行中…';
  const res = await fetch(path,{method:'POST'});
  r.textContent = await res.text();
  if (res.ok) setTimeout(()=>location.reload(), 1500);
}
async function saveConfig(form){
  const data = Object.fromEntries(new FormData(form));
  data.topN = Number(data.topN);
  data.countryBlocklist = data.countryBlocklist.split(',').map(s=>s.trim()).filter(Boolean);
  const res = await fetch('/admin/save-config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  alert(await res.text()); location.reload();
}
</script>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(s){return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c])}

async function adminRefresh(request, env, ctx) {
  if (!checkAdmin(request, env)) return unauthorized();
  const r = await refreshAll(env, "[manual]");
  return json(r);
}

async function adminSaveConfig(request, env) {
  if (!checkAdmin(request, env)) return unauthorized();
  const body = await request.json().catch(() => ({}));
  const cur = await loadConfig(env);
  const next = { ...cur, ...body };
  await env.KV.put(KV_KEYS.config, JSON.stringify(next));
  return text("配置已保存");
}

async function adminSyncDns(request, env, ctx) {
  if (!checkAdmin(request, env)) return unauthorized();
  if (!(env.CF_API_TOKEN && env.CF_ZONE_ID && env.CF_RECORD_NAME)) return text("DNS 同步未配置", 400);
  const ips = (await loadIps(env)).slice(0, Number(env.DNS_TOP_N || 10));
  const r = await syncDns(env, ips);
  return json(r);
}

// ============================================================
// 9. 首页（含浏览器测速）
// ============================================================
async function homePage(env) {
  const ips = await loadIps(env);
  const updatedAt = Number(await env.KV.get(KV_KEYS.updatedAt) || 0);
  const updatedStr = updatedAt ? new Date(updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "(尚未刷新)";

  const html = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>☁️ Cloudflare 优选 IP</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",Helvetica,Arial,sans-serif;background:#0b0f14;color:#e6edf3;min-height:100vh}
  .wrap{max-width:980px;margin:0 auto;padding:24px}
  h1{font-size:28px;margin:0 0 4px;background:linear-gradient(90deg,#f9826c,#7ee787);-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:700}
  .subtitle{color:#8b949e;margin-bottom:20px}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px}
  button{background:#238636;color:#fff;border:0;padding:9px 16px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600}
  button:disabled{opacity:.6;cursor:wait}
  button.ghost{background:#21262d;color:#e6edf3}
  table{width:100%;border-collapse:collapse;font:13px monospace;background:#161b22;border-radius:8px;overflow:hidden}
  th,td{padding:8px 12px;border-bottom:1px solid #21262d;text-align:left}
  th{background:#0d1117;color:#8b949e;font-weight:600}
  tr.testing td{opacity:.5}
  tr.fast td:nth-child(5){color:#7ee787}
  tr.mid td:nth-child(5){color:#d8af3c}
  tr.slow td:nth-child(5){color:#ff7b72}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;background:#30363d;color:#8b949e;margin-left:6px}
  .links{font-size:13px;color:#8b949e;margin-top:24px;border-top:1px solid #21262d;padding-top:16px}
  .links a{color:#58a6ff;margin-right:14px;text-decoration:none}
  .links a:hover{text-decoration:underline}
  .empty{padding:40px;text-align:center;color:#8b949e}
  code{background:#21262d;padding:2px 6px;border-radius:4px;font-size:12px}
</style></head>
<body>
<div class="wrap">
  <h1>☁️ Cloudflare 优选 IP</h1>
  <div class="subtitle">最后更新 <code>${updatedStr}</code>，共 <b>${ips.length}</b> 个候选。点击「在线测速」用你的网络重新排序。</div>

  <div class="row">
    <button id="btnTest">⚡ 在线测速</button>
    <button class="ghost" onclick="copyTop(5)">📋 复制前 5</button>
    <button class="ghost" onclick="copyTop(10)">📋 复制前 10</button>
    <button class="ghost" onclick="exportTxt()">💾 导出 txt</button>
    <span id="status" class="pill">就绪</span>
  </div>

  ${ips.length === 0 ? `<div class="empty">还没有数据。请管理员访问 <code>/admin</code> 点击「立即刷新」。</div>` : `
  <table id="tb">
    <thead><tr><th>#</th><th>IP</th><th>端口</th><th>来源 colo</th><th>本机延迟</th></tr></thead>
    <tbody>
      ${ips.map((it,i) => `<tr data-ip="${it.ip}" data-port="${it.port}">
        <td>${i+1}</td>
        <td>${it.ip}</td>
        <td>${it.port}</td>
        <td>${it.colo || "-"}</td>
        <td>—</td>
      </tr>`).join("")}
    </tbody>
  </table>`}

  <div class="links">
    📚 接口：
    <a href="/sub" target="_blank">/sub</a>
    <a href="/api/ips" target="_blank">/api/ips</a>
    <a href="/api/preferred-ips" target="_blank">/api/preferred-ips</a>
    <a href="/admin">/admin</a>
  </div>
</div>

<script>
const $ = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>Array.from(r.querySelectorAll(s));

// 浏览器测速：对每个 IP 用 https://[ip]/cdn-cgi/trace 测量 fetch 耗时
async function probe(ip, port){
  const url = 'https://' + ip + '/cdn-cgi/trace';
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), 5000);
  const t0 = performance.now();
  try{
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store', mode: 'no-cors' });
    return Math.round(performance.now() - t0);
  }catch(e){ return null; }
  finally{ clearTimeout(timer); }
}

async function test(){
  const btn = $('#btnTest'); const status = $('#status');
  btn.disabled = true; status.textContent = '测试中…';
  const rows = $$('#tb tbody tr');
  rows.forEach(r=>r.classList.add('testing'));

  // 并发 6 个
  const queue = rows.slice();
  let done = 0;
  async function worker(){
    while(queue.length){
      const row = queue.shift();
      const ip = row.dataset.ip;
      const ms = await probe(ip);
      row.classList.remove('testing');
      const cell = row.cells[4];
      if (ms === null){ cell.textContent = '✗'; row.classList.add('slow'); }
      else {
        cell.textContent = ms + ' ms';
        row.classList.add(ms < 200 ? 'fast' : ms < 500 ? 'mid' : 'slow');
      }
      row.dataset.delay = ms === null ? 99999 : ms;
      done++;
      status.textContent = done + '/' + rows.length;
    }
  }
  await Promise.all(Array.from({length:6}, worker));

  // 按本机延迟重新排序
  const tbody = $('#tb tbody');
  const sorted = Array.from(tbody.children).sort((a,b)=> Number(a.dataset.delay) - Number(b.dataset.delay));
  sorted.forEach((r,i)=>{ r.cells[0].textContent = i+1; tbody.appendChild(r); });

  status.textContent = '完成';
  btn.disabled = false;
}

document.getElementById('btnTest')?.addEventListener('click', test);

function topRows(n){
  const rows = $$('#tb tbody tr').slice(0, n);
  return rows.map(r=>{
    const ip = r.dataset.ip, port = r.dataset.port || 443;
    const d = r.dataset.delay ? (' #' + r.dataset.delay + 'ms') : '';
    return ip + ':' + port + d;
  }).join('\\n');
}
async function copyTop(n){
  try{ await navigator.clipboard.writeText(topRows(n)); $('#status').textContent='已复制前'+n; }
  catch(e){ alert(topRows(n)); }
}
function exportTxt(){
  const blob = new Blob([topRows(999)], {type:'text/plain'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'cf-best-ip.txt'; a.click();
}
</script>
</body></html>`;

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
