/**
 * ============================================================
 *  CF Best IP · 集大成版 Worker  (v2.0)
 *  https://github.com/LeilaoMi/cf-best-ip
 * ============================================================
 *
 *  社区主流方案都有的功能：
 *   - 多源聚合 + Cron 定时 + KV 持久化       (cfnb / CF Workers 版)
 *   - 真实 TCP 三次握手测速 (cloudflare:sockets)
 *   - HTTP 带宽抽样测速 + colo / 国家识别    (CFST 思路)
 *   - 自动同步 Cloudflare DNS A 记录         (cfnb)
 *   - 订阅 + V2Ray base64 + Clash + EDT 兼容 (cmliu 系列)
 *   - 管理面板 + 密码保护                    (CF Workers 重制版)
 *   - 浏览器在线测速                         (itdog 风格)
 *
 *  本项目独家：
 *   ★ 多维度筛选 API：country / colo / carrier / port / maxDelay / minMbps
 *   ★ 分运营商 DNS 同步：ct.example.com / cu.example.com / cm.example.com
 *   ★ 智能就近推荐 /sub?smart=1（按访问者 colo 算距离）
 *   ★ CIDR 自定义扫描（管理面板里贴段，Worker 边缘开扫）
 *   ★ 历史快照 + Telegram / Discord Webhook 通知
 *
 *  环境变量（wrangler secret put / dashboard 添加）：
 *    ADMIN_PASSWORD    必填，管理员登录密码
 *    SUB_TOKEN         可选，订阅鉴权 token，不设则订阅公开
 *    CF_API_TOKEN      可选，同步 DNS 的 Cloudflare API Token (Zone:DNS:Edit)
 *    CF_ZONE_ID        可选，目标域名 Zone ID
 *    CF_RECORD_NAME    可选，主 A 记录名，例如 cf.example.com
 *    CF_DNS_BY_CARRIER 可选，"1" 启用按运营商分别同步 (ct./cu./cm. 前缀)
 *    DNS_TOP_N         可选，DNS 同步取前 N 个 IP，默认 10
 *    TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID  可选，Cron 完成后推送通知
 *    DISCORD_WEBHOOK   可选，Discord 通知
 *
 *  KV 绑定：变量名固定 KV
 */

import { connect } from "cloudflare:sockets";

// ============================================================
// 1. 常量 / 数据源 / 字典
// ============================================================
const VERSION = "2.0.0";

const DEFAULT_CFG = {
  topN: 30,
  probeTimeoutMs: 3000,
  probeConcurrency: 20,
  bandwidthSampleSize: 5,           // 抽 5 个延迟最优的做带宽测试
  bandwidthBytes: 256 * 1024,       // 下载 256 KB
  countryBlocklist: ["CN"],         // 默认屏蔽中国大陆 colo
  ports: [443],                     // 默认只测 443
  refreshHours: 6,
};

const SOURCES = [
  { name: "addressesapi/ip.164746.xyz", url: "https://addressesapi.090227.xyz/ip.164746.xyz", type: "carrier" },
  { name: "addressesapi/CloudFlareYes", url: "https://addressesapi.090227.xyz/CloudFlareYes", type: "carrier" },
  { name: "addressesapi/cmcc",          url: "https://addressesapi.090227.xyz/cmcc",          type: "carrier" },
  { name: "addressesapi/ct",            url: "https://addressesapi.090227.xyz/ct",            type: "carrier" },
  { name: "addressesapi/cu",            url: "https://addressesapi.090227.xyz/cu",            type: "carrier" },
  { name: "ip.164746.xyz/ipTop",        url: "https://ip.164746.xyz/ipTop.html",              type: "csv" },
  { name: "IPDB/proxy",                 url: "https://raw.githubusercontent.com/ymyuuu/IPDB/main/proxy.txt", type: "list" },
];

// 常见 colo → 国家映射（cdn-cgi/trace 也能直接给国家，但缓存一份方便筛选）
const COLO_TO_COUNTRY = {
  HKG: "HK", NRT: "JP", KIX: "JP", ICN: "KR", TPE: "TW", SIN: "SG", KUL: "MY",
  BKK: "TH", SGN: "VN", MNL: "PH", BOM: "IN", MAA: "IN", DEL: "IN",
  LAX: "US", SJC: "US", SEA: "US", ORD: "US", IAD: "US", DFW: "US", ATL: "US",
  EWR: "US", MIA: "US", DEN: "US", BOS: "US", SFO: "US",
  YYZ: "CA", YVR: "CA", LHR: "GB", MAN: "GB", AMS: "NL", FRA: "DE", DUS: "DE",
  CDG: "FR", MRS: "FR", MAD: "ES", BCN: "ES", MXP: "IT", FCO: "IT", ZRH: "CH",
  WAW: "PL", VIE: "AT", PRG: "CZ", ARN: "SE", HEL: "FI", OSL: "NO", CPH: "DK",
  SVO: "RU", DME: "RU", IST: "TR", DXB: "AE", TLV: "IL", JNB: "ZA", CPT: "ZA",
  GRU: "BR", GIG: "BR", EZE: "AR", SCL: "CL", BOG: "CO", LIM: "PE", MEX: "MX",
  SYD: "AU", MEL: "AU", AKL: "NZ",
};

const COUNTRY_FLAGS = {
  HK: "🇭🇰", JP: "🇯🇵", KR: "🇰🇷", TW: "🇹🇼", SG: "🇸🇬", US: "🇺🇸", CA: "🇨🇦",
  GB: "🇬🇧", DE: "🇩🇪", FR: "🇫🇷", NL: "🇳🇱", AU: "🇦🇺", RU: "🇷🇺", IN: "🇮🇳",
  BR: "🇧🇷", MX: "🇲🇽", IT: "🇮🇹", ES: "🇪🇸", CN: "🇨🇳", TH: "🇹🇭", MY: "🇲🇾",
};

const CARRIER_LABEL = { CT: "电信", CU: "联通", CM: "移动", CMCC: "移动", CF: "通用", DEF: "通用" };

// ============================================================
// 2. 工具函数
// ============================================================
function json(obj, init = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: init.status || 200,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...(init.headers || {}) },
  });
}
function text(body, init = {}) {
  return new Response(body, {
    status: init.status || 200,
    headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*", ...(init.headers || {}) },
  });
}
function html(body) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}
async function pMap(items, fn, concurrency = 10) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = { error: String(e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}
function uniqBy(arr, keyFn) {
  const map = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!map.has(k)) map.set(k, x);
    else {
      const cur = map.get(k);
      cur.sources = Array.from(new Set([...(cur.sources || []), ...(x.sources || [])]));
    }
  }
  return Array.from(map.values());
}
function flag(country) { return COUNTRY_FLAGS[country] || "🌐"; }
function carrierName(c) { return CARRIER_LABEL[c] || c || "通用"; }

const IP_RE = /\b((?:25[0-5]|2[0-4]\d|[01]?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)){3})\b/g;

function parseLine(line) {
  // 接受 "1.2.3.4"、"1.2.3.4:443"、"1.2.3.4#CT"、"1.2.3.4:443#CT-1"
  const m = line.match(/(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?(?:#([\w\-]+))?/);
  if (!m) return null;
  let carrier = null;
  if (m[3]) {
    const tag = m[3].toUpperCase().split("-")[0];
    if (["CT", "CU", "CM", "CMCC", "CF"].includes(tag)) carrier = tag === "CMCC" ? "CM" : tag;
  }
  return { ip: m[1], port: m[2] ? +m[2] : 443, carrier };
}

// ============================================================
// 3. KV 封装
// ============================================================
async function kvGet(env, key, def = null) {
  if (!env.KV) return def;
  const v = await env.KV.get(key, "json");
  return v == null ? def : v;
}
async function kvSet(env, key, val, opts) {
  if (!env.KV) return;
  await env.KV.put(key, JSON.stringify(val), opts);
}
async function getConfig(env) {
  const saved = await kvGet(env, "config", {});
  return { ...DEFAULT_CFG, ...saved };
}
async function setConfig(env, cfg) {
  const merged = { ...(await getConfig(env)), ...cfg };
  await kvSet(env, "config", merged);
  return merged;
}
async function getLatest(env) {
  return (await kvGet(env, "ips:latest", { ips: [], updatedAt: 0, sourceStats: [] }));
}
async function saveLatest(env, data) {
  await kvSet(env, "ips:latest", data);
  // 同时写一份当日历史快照（30 天 TTL）
  const day = new Date().toISOString().slice(0, 10);
  await kvSet(env, `ips:history:${day}`, data, { expirationTtl: 60 * 60 * 24 * 30 });
}
async function getManual(env) { return await kvGet(env, "ips:manual", []); }
async function setManual(env, list) { await kvSet(env, "ips:manual", list); }

// ============================================================
// 4. 数据源抓取
// ============================================================
async function fetchSource(src) {
  try {
    const r = await withTimeout(fetch(src.url, { cf: { cacheTtl: 300 } }), 8000);
    if (!r.ok) return { name: src.name, ips: [], error: `HTTP ${r.status}` };
    const body = await r.text();
    const ips = [];
    for (const raw of body.split(/[\r\n,]+/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      // 从混排 HTML/CSV 里抠出每个 IP
      const matches = line.match(/\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?:#[\w\-]+)?/g) || [];
      for (const m of matches) {
        const parsed = parseLine(m);
        if (parsed) ips.push({ ...parsed, sources: [src.name] });
      }
    }
    return { name: src.name, ips };
  } catch (e) {
    return { name: src.name, ips: [], error: String(e && e.message || e) };
  }
}

async function aggregateSources() {
  const results = await Promise.all(SOURCES.map(fetchSource));
  const all = [];
  const stats = [];
  for (const r of results) {
    stats.push({ name: r.name, count: r.ips.length, error: r.error });
    all.push(...r.ips);
  }
  // 合并去重，按 ip:port 维度
  const uniq = uniqBy(all, x => `${x.ip}:${x.port}`);
  return { ips: uniq, stats };
}

// ============================================================
// 5. 测速核心
// ============================================================

/** TCP 三次握手测速 —— 使用 cloudflare:sockets */
async function tcpPing(ip, port, timeoutMs) {
  const t0 = Date.now();
  try {
    const sock = connect({ hostname: ip, port: Number(port) }, { allowHalfOpen: false, secureTransport: "off" });
    // opened 是 promise，resolve 即 SYN/ACK 完成
    await withTimeout(sock.opened, timeoutMs);
    const ms = Date.now() - t0;
    try { await sock.close(); } catch {}
    return ms;
  } catch (e) {
    return null;
  }
}

/** 多次 TCP ping，取平均 + 丢包率 */
async function tcpPingN(ip, port, n, timeoutMs) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const ms = await tcpPing(ip, port, timeoutMs);
    samples.push(ms);
  }
  const ok = samples.filter(x => x != null);
  return {
    samples,
    min: ok.length ? Math.min(...ok) : null,
    avg: ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null,
    loss: 1 - ok.length / n,
  };
}

/** 通过 cdn-cgi/trace 获取 colo / country —— 必须走 cloudflare-dns.com 这种已有有效证书的域名 */
async function detectColo(ip, port, timeoutMs) {
  try {
    const url = port === 443 ? `https://cloudflare.com/cdn-cgi/trace` : `http://cloudflare.com/cdn-cgi/trace`;
    const r = await withTimeout(
      fetch(url, { cf: { resolveOverride: ip }, headers: { "user-agent": "cf-best-ip/2.0" } }),
      timeoutMs,
    );
    if (!r.ok) return {};
    const t = await r.text();
    const m = Object.fromEntries(t.split("\n").map(l => l.split("=")).filter(p => p.length === 2));
    const colo = m.colo || null;
    const country = m.loc || COLO_TO_COUNTRY[colo] || null;
    return { colo, country };
  } catch {
    return {};
  }
}

/** 带宽测试 —— 下载固定字节数测速 */
async function probeBandwidth(ip, bytes, timeoutMs) {
  try {
    const t0 = Date.now();
    const r = await withTimeout(
      fetch(`https://speed.cloudflare.com/__down?bytes=${bytes}`, {
        cf: { resolveOverride: ip },
        headers: { "user-agent": "cf-best-ip/2.0" },
      }),
      timeoutMs,
    );
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    const sec = (Date.now() - t0) / 1000;
    if (sec <= 0) return null;
    return Math.round((buf.byteLength * 8) / sec / 1000) / 1000; // Mbps
  } catch {
    return null;
  }
}

// ============================================================
// 6. 全量测速管线
// ============================================================
async function runFullTest(env, ctx, opts = {}) {
  const cfg = await getConfig(env);
  const startedAt = Date.now();

  // 1. 拉源
  const agg = await aggregateSources();
  // 加入手动添加的 IP
  const manual = await getManual(env);
  for (const m of manual) agg.ips.push({ ...m, sources: ["manual"] });

  // 2. 并发 TCP ping
  const probed = await pMap(agg.ips, async (item) => {
    const port = item.port || 443;
    const r = await tcpPingN(item.ip, port, 2, cfg.probeTimeoutMs);
    return { ...item, port, delay: r.avg, loss: r.loss };
  }, cfg.probeConcurrency);

  // 3. 过滤可用
  let alive = probed.filter(x => x.delay != null && x.loss < 0.5);
  alive.sort((a, b) => a.delay - b.delay);

  // 4. 给 Top N 探 colo / country
  const topForColo = alive.slice(0, Math.min(40, alive.length));
  await pMap(topForColo, async (item) => {
    const info = await detectColo(item.ip, item.port, cfg.probeTimeoutMs + 1000);
    Object.assign(item, info);
  }, 10);

  // 5. 应用国家黑名单
  if (cfg.countryBlocklist && cfg.countryBlocklist.length) {
    alive = alive.filter(x => !x.country || !cfg.countryBlocklist.includes(x.country));
  }

  // 6. 抽样带宽测速
  const bwTargets = alive.slice(0, cfg.bandwidthSampleSize);
  await pMap(bwTargets, async (item) => {
    const mbps = await probeBandwidth(item.ip, cfg.bandwidthBytes, 6000);
    item.mbps = mbps;
  }, 5);

  // 7. 持久化
  const payload = {
    ips: alive,
    sourceStats: agg.stats,
    updatedAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
    version: VERSION,
  };
  await saveLatest(env, payload);

  // 8. DNS 同步（后台执行）
  if (env.CF_API_TOKEN && env.CF_ZONE_ID && env.CF_RECORD_NAME) {
    ctx.waitUntil(syncAllDns(env, alive).catch(() => {}));
  }
  // 9. Webhook
  ctx.waitUntil(notify(env, payload).catch(() => {}));
  return payload;
}

// ============================================================
// 7. Cloudflare DNS 同步
// ============================================================
async function cfApi(env, path, init = {}) {
  return fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { "authorization": `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json", ...(init.headers || {}) },
  });
}
async function listRecords(env, name) {
  const r = await cfApi(env, `/zones/${env.CF_ZONE_ID}/dns_records?type=A&name=${encodeURIComponent(name)}&per_page=100`);
  const j = await r.json();
  return j.result || [];
}
async function deleteRecord(env, id) {
  await cfApi(env, `/zones/${env.CF_ZONE_ID}/dns_records/${id}`, { method: "DELETE" });
}
async function createRecord(env, name, ip) {
  await cfApi(env, `/zones/${env.CF_ZONE_ID}/dns_records`, {
    method: "POST",
    body: JSON.stringify({ type: "A", name, content: ip, ttl: 60, proxied: false }),
  });
}
async function syncRecord(env, name, ips, topN) {
  if (!ips.length) return { skipped: true, name };
  const wanted = ips.slice(0, topN).map(x => x.ip);
  const existing = await listRecords(env, name);
  for (const r of existing) await deleteRecord(env, r.id);
  for (const ip of wanted) await createRecord(env, name, ip);
  return { name, ips: wanted };
}
async function syncAllDns(env, alive) {
  const topN = Number(env.DNS_TOP_N || 10);
  const results = [];
  results.push(await syncRecord(env, env.CF_RECORD_NAME, alive, topN));
  if (env.CF_DNS_BY_CARRIER === "1") {
    const root = env.CF_RECORD_NAME.split(".").slice(1).join(".");
    const groups = { CT: "ct", CU: "cu", CM: "cm" };
    for (const [carrier, prefix] of Object.entries(groups)) {
      const subset = alive.filter(x => x.carrier === carrier);
      if (subset.length) results.push(await syncRecord(env, `${prefix}.${root}`, subset, topN));
    }
  }
  return results;
}

// ============================================================
// 8. Webhook 通知
// ============================================================
async function notify(env, payload) {
  const top5 = (payload.ips || []).slice(0, 5);
  const lines = [
    `🚀 *cf-best-ip 测速完成*`,
    `更新时间: ${new Date(payload.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    `可用节点: ${payload.ips.length}`,
    `Top 5:`,
    ...top5.map((x, i) => `${i + 1}. \`${x.ip}\` ${flag(x.country)} ${x.colo || ""} ${x.delay}ms${x.mbps ? ` ${x.mbps}Mbps` : ""}`),
  ];
  const md = lines.join("\n");
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: md, parse_mode: "Markdown", disable_web_page_preview: true }),
    });
  }
  if (env.DISCORD_WEBHOOK) {
    await fetch(env.DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: md }),
    });
  }
}

// ============================================================
// 9. 筛选 / 输出格式
// ============================================================
function applyFilter(ips, params, requesterColo) {
  const country = (params.get("country") || "").toUpperCase();
  const colo = (params.get("colo") || "").toUpperCase();
  const carrier = (params.get("carrier") || "").toUpperCase();
  const port = params.get("port");
  const maxDelay = params.get("maxDelay") ? Number(params.get("maxDelay")) : null;
  const minMbps = params.get("minMbps") ? Number(params.get("minMbps")) : null;
  const exclude = (params.get("exclude") || "").toUpperCase().split(",").filter(Boolean);
  let top = Number(params.get("top") || params.get("limit") || 20);
  if (!Number.isFinite(top) || top < 1) top = 20;
  if (top > 200) top = 200;

  let out = ips.slice();
  if (country) {
    const set = new Set(country.split(",").filter(Boolean));
    out = out.filter(x => x.country && set.has(x.country));
  }
  if (colo) {
    const set = new Set(colo.split(",").filter(Boolean));
    out = out.filter(x => x.colo && set.has(x.colo));
  }
  if (carrier) {
    const set = new Set(carrier.split(",").filter(Boolean).map(c => c === "CMCC" ? "CM" : c));
    out = out.filter(x => x.carrier && set.has(x.carrier));
  }
  if (port) {
    const set = new Set(port.split(",").filter(Boolean).map(Number));
    out = out.filter(x => set.has(x.port));
  }
  if (maxDelay) out = out.filter(x => x.delay != null && x.delay <= maxDelay);
  if (minMbps) out = out.filter(x => x.mbps != null && x.mbps >= minMbps);
  if (exclude.length) out = out.filter(x => !x.country || !exclude.includes(x.country));

  // 智能就近：按访问者 colo 推断的国家做优先级
  if (params.get("smart") === "1" && requesterColo) {
    const myCountry = COLO_TO_COUNTRY[requesterColo];
    out.sort((a, b) => {
      const ai = a.country === myCountry ? 0 : 1;
      const bi = b.country === myCountry ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return (a.delay || 9999) - (b.delay || 9999);
    });
  } else {
    out.sort((a, b) => (a.delay || 9999) - (b.delay || 9999));
  }
  return out.slice(0, top);
}

function fmtSub(ips, withComment) {
  return ips.map(x => {
    const tag = [x.country, x.colo, x.carrier && carrierName(x.carrier)].filter(Boolean).join("-");
    return withComment ? `${x.ip}:${x.port}#${tag || "CF"}` : `${x.ip}:${x.port}`;
  }).join("\n");
}
function fmtEDT(ips) { return ips.map(x => `${x.ip}:${x.port}`).join("\n"); }
function fmtV2ray(ips) {
  // 简单 vmess 模板可由订阅器消费；这里仅 base64 编码 sub
  const txt = fmtSub(ips, true);
  return btoa(unescape(encodeURIComponent(txt)));
}
function fmtClash(ips) {
  const lines = ["proxies:"];
  for (const x of ips) {
    const name = `CF-${x.country || ""}-${x.colo || ""}-${x.ip}`.replace(/--+/g, "-");
    lines.push(`  - {name: "${name}", server: ${x.ip}, port: ${x.port}, type: trojan, password: REPLACE_ME, sni: REPLACE_ME, skip-cert-verify: false}`);
  }
  return lines.join("\n");
}

// ============================================================
// 10. 鉴权
// ============================================================
function checkAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const a = request.headers.get("authorization") || "";
  if (!a.startsWith("Basic ")) return false;
  try {
    const dec = atob(a.slice(6));
    const i = dec.indexOf(":");
    const pwd = i >= 0 ? dec.slice(i + 1) : dec;
    return pwd === env.ADMIN_PASSWORD;
  } catch { return false; }
}
function unauthorized() {
  return new Response("Auth required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="cf-best-ip"' },
  });
}
function checkSubToken(request, env) {
  if (!env.SUB_TOKEN) return true;
  const url = new URL(request.url);
  const t = url.searchParams.get("token") || request.headers.get("authorization")?.replace(/^Bearer\s+/, "") || "";
  return t === env.SUB_TOKEN;
}

// ============================================================
// 11. 路由
// ============================================================
async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const params = url.searchParams;
  const data = await getLatest(env);
  const ips = data.ips || [];
  const requesterColo = request.cf?.colo;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "content-type,authorization" } });
  }

  // ---- 订阅 ----
  if (path === "/sub" || path === "/sub.txt") {
    if (!checkSubToken(request, env)) return text("Forbidden", { status: 403 });
    const filtered = applyFilter(ips, params, requesterColo);
    return text(fmtSub(filtered, params.get("comment") !== "0"));
  }
  if (path === "/api/preferred-ips") {
    if (!checkSubToken(request, env)) return text("Forbidden", { status: 403 });
    return text(fmtEDT(applyFilter(ips, params, requesterColo)));
  }
  if (path === "/api/v2ray") {
    if (!checkSubToken(request, env)) return text("Forbidden", { status: 403 });
    return text(fmtV2ray(applyFilter(ips, params, requesterColo)));
  }
  if (path === "/api/clash") {
    if (!checkSubToken(request, env)) return text("Forbidden", { status: 403 });
    return new Response(fmtClash(applyFilter(ips, params, requesterColo)), { headers: { "content-type": "text/yaml; charset=utf-8" } });
  }

  // ---- JSON 列表 ----
  if (path === "/api/ips") {
    const filtered = applyFilter(ips, params, requesterColo);
    return json({ ok: true, total: ips.length, returned: filtered.length, updatedAt: data.updatedAt, ips: filtered });
  }

  // ---- 维度统计 ----
  if (path === "/api/stats") {
    const by = (key) => {
      const m = {};
      for (const x of ips) { const k = x[key] || "?"; m[k] = (m[k] || 0) + 1; }
      return Object.entries(m).map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count);
    };
    return json({
      total: ips.length,
      updatedAt: data.updatedAt,
      sourceStats: data.sourceStats,
      byCountry: by("country"),
      byColo: by("colo"),
      byCarrier: by("carrier"),
      yourColo: requesterColo,
    });
  }

  // ---- 单 IP 测速 ----
  if (path === "/api/probe") {
    const ip = params.get("ip");
    const port = Number(params.get("port") || 443);
    const times = Math.min(Number(params.get("times") || 3), 5);
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return json({ ok: false, error: "bad ip" }, { status: 400 });
    const r = await tcpPingN(ip, port, times, 3000);
    const info = r.avg != null ? await detectColo(ip, port, 4000) : {};
    return json({ ok: r.avg != null, ip, port, ...r, ...info });
  }

  // ---- 历史 ----
  if (path === "/api/history") {
    const days = Math.min(Number(params.get("days") || 7), 30);
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const snap = await kvGet(env, `ips:history:${d}`);
      if (snap) out.push({ date: d, count: snap.ips.length, top1: snap.ips[0] });
    }
    return json({ days, history: out });
  }

  // ---- 管理：手动刷新 ----
  if (path === "/api/refresh") {
    if (!checkAdmin(request, env)) return unauthorized();
    const result = await runFullTest(env, ctx);
    return json({ ok: true, count: result.ips.length, elapsedMs: result.elapsedMs });
  }

  // ---- 管理：DNS 手动同步 ----
  if (path === "/api/dns/sync") {
    if (!checkAdmin(request, env)) return unauthorized();
    if (!env.CF_API_TOKEN || !env.CF_ZONE_ID || !env.CF_RECORD_NAME) {
      return json({ ok: false, error: "CF_API_TOKEN/CF_ZONE_ID/CF_RECORD_NAME 未配置" }, { status: 400 });
    }
    const result = await syncAllDns(env, ips);
    return json({ ok: true, result });
  }

  // ---- 管理：配置读写 ----
  if (path === "/api/config" && request.method === "GET") {
    if (!checkAdmin(request, env)) return unauthorized();
    return json(await getConfig(env));
  }
  if (path === "/api/config" && request.method === "POST") {
    if (!checkAdmin(request, env)) return unauthorized();
    const body = await request.json().catch(() => ({}));
    const cfg = await setConfig(env, body);
    return json({ ok: true, config: cfg });
  }

  // ---- 管理：手动 IP 增删 ----
  if (path === "/api/manual" && request.method === "GET") {
    if (!checkAdmin(request, env)) return unauthorized();
    return json(await getManual(env));
  }
  if (path === "/api/manual" && request.method === "POST") {
    if (!checkAdmin(request, env)) return unauthorized();
    const body = await request.json().catch(() => ({}));
    const list = (body.lines || "").split(/[\r\n,]+/).map(parseLine).filter(Boolean);
    const cur = await getManual(env);
    const merged = uniqBy([...cur, ...list.map(x => ({ ...x, sources: ["manual"], addedAt: Date.now() }))], x => `${x.ip}:${x.port}`);
    await setManual(env, merged);
    return json({ ok: true, count: merged.length });
  }
  if (path === "/api/manual" && request.method === "DELETE") {
    if (!checkAdmin(request, env)) return unauthorized();
    const ip = params.get("ip");
    const cur = await getManual(env);
    await setManual(env, cur.filter(x => x.ip !== ip));
    return json({ ok: true });
  }

  // ---- 管理：CIDR 扫描 ----
  if (path === "/api/cidr-scan") {
    if (!checkAdmin(request, env)) return unauthorized();
    const body = await request.json().catch(() => ({}));
    const ips = expandCidr(body.cidr || "", Math.min(body.limit || 64, 64));
    const port = body.port || 443;
    const result = await pMap(ips, async (ip) => {
      const r = await tcpPingN(ip, port, 1, 2500);
      return { ip, port, delay: r.avg };
    }, 15);
    return json({ ok: true, ips: result.filter(x => x.delay != null).sort((a, b) => a.delay - b.delay) });
  }

  // ---- 页面 ----
  if (path === "/" || path === "/index.html") return html(renderHome(data, requesterColo));
  if (path === "/test") return html(renderTest());
  if (path === "/admin") {
    if (!checkAdmin(request, env)) return unauthorized();
    return html(renderAdmin());
  }

  return new Response("Not Found", { status: 404 });
}

// ============================================================
// 12. 入口
// ============================================================
export default {
  async fetch(request, env, ctx) {
    try { return await handle(request, env, ctx); }
    catch (e) { return json({ ok: false, error: String(e && e.message || e), stack: e?.stack }, { status: 500 }); }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runFullTest(env, ctx));
  },
};

// ============================================================
// 13. CIDR 展开
// ============================================================
function expandCidr(cidr, limit = 64) {
  const m = cidr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  if (!m) return [];
  const base = ((+m[1]) << 24) | ((+m[2]) << 16) | ((+m[3]) << 8) | (+m[4]);
  const bits = +m[5];
  const size = Math.min(2 ** (32 - bits), limit);
  const out = [];
  for (let i = 0; i < size; i++) {
    const n = (base & (0xffffffff << (32 - bits))) + i;
    out.push([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  return out;
}

// ============================================================
// 14. HTML 模板
// ============================================================
function layout(title, body, extraHead = "") {
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
:root{--bg:#0b0f14;--card:#161b22;--bd:#30363d;--fg:#e6edf3;--mut:#8b949e;--acc:#f9826c;--ok:#7ee787;--warn:#d8af3c;--bad:#ff7b72}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1100px;margin:0 auto;padding:24px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:16px;margin-bottom:16px}
h1{margin:0 0 4px;font-size:22px}h2{margin:16px 0 8px;font-size:16px;color:var(--mut)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn{background:var(--acc);color:#fff;border:0;border-radius:6px;padding:8px 14px;font-weight:600;cursor:pointer;font-size:13px}
.btn:disabled{opacity:.5;cursor:wait}.btn.ghost{background:transparent;border:1px solid var(--bd);color:var(--fg)}
input,select,textarea{background:#0d1117;color:var(--fg);border:1px solid var(--bd);border-radius:6px;padding:7px 10px;font:13px monospace}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:6px 8px;text-align:left;border-bottom:1px solid var(--bd)}
th{font-weight:600;color:var(--mut);font-size:11px;text-transform:uppercase}
.tag{display:inline-block;padding:1px 6px;border-radius:10px;background:#21262d;font-size:11px;color:var(--mut)}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.mut{color:var(--mut)}
nav{display:flex;gap:14px;font-size:13px}nav a{color:var(--mut)}nav a.active{color:var(--fg)}
code{background:#0d1117;padding:1px 5px;border-radius:3px;font-size:12px}
${extraHead}
</style></head><body><div class="wrap">
<header style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
  <div><h1>☁️ cf-best-ip</h1><div class="mut">融合社区方案 · 集大成版 v${VERSION}</div></div>
  <nav><a href="/">首页</a><a href="/test">在线测速</a><a href="/admin">管理</a><a href="https://github.com/LeilaoMi/cf-best-ip" target="_blank">GitHub</a></nav>
</header>
${body}
<footer class="mut" style="margin-top:24px;font-size:12px;text-align:center">基于 Cloudflare Workers · MIT License · Made with caffeine ☕</footer>
</div></body></html>`;
}

function renderHome(data, myColo) {
  const ips = data.ips || [];
  const top = ips.slice(0, 15);
  const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "（未运行）";
  const byCountry = {};
  for (const x of ips) { const k = x.country || "?"; byCountry[k] = (byCountry[k] || 0) + 1; }
  const ctyTags = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([c, n]) => `<span class="tag">${flag(c)} ${c} ${n}</span>`).join(" ");
  const rows = top.map((x, i) => `<tr>
    <td>${i + 1}</td>
    <td><code>${x.ip}</code></td><td>${x.port}</td>
    <td>${flag(x.country)} ${x.country || "—"}</td>
    <td>${x.colo || "—"}</td>
    <td>${carrierName(x.carrier)}</td>
    <td class="${x.delay < 50 ? "ok" : x.delay < 200 ? "warn" : "bad"}">${x.delay}ms</td>
    <td>${x.mbps ? x.mbps + " Mbps" : "—"}</td>
  </tr>`).join("");
  return layout("cf-best-ip · Cloudflare 优选 IP", `
<div class="card">
  <h2>当前节点状态</h2>
  <div class="row" style="font-size:13px">
    <div>📦 可用节点：<b>${ips.length}</b></div>
    <div>⏰ 最后更新：<b>${updated}</b></div>
    <div>📍 你在：<b>${myColo || "?"}</b> (${COLO_TO_COUNTRY[myColo] || "?"})</div>
  </div>
  <div style="margin-top:10px">${ctyTags}</div>
</div>

<div class="card">
  <h2>Top 15 节点</h2>
  <table><thead><tr><th>#</th><th>IP</th><th>端口</th><th>国家</th><th>Colo</th><th>运营商</th><th>延迟</th><th>带宽</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="8" class="mut">尚无数据，请进入「管理」点击「立即测速」</td></tr>`}</tbody></table>
</div>

<div class="card">
  <h2>订阅接口（支持地区/运营商/端口筛选）</h2>
  <table><tbody>
  <tr><td>纯文本订阅</td><td><code>/sub</code> · <code>/sub?country=US,JP&top=20</code></td></tr>
  <tr><td>JSON</td><td><code>/api/ips?carrier=CT&maxDelay=100</code></td></tr>
  <tr><td>EdgeTunnel 兼容</td><td><code>/api/preferred-ips?country=HK</code></td></tr>
  <tr><td>V2Ray (base64)</td><td><code>/api/v2ray</code></td></tr>
  <tr><td>Clash</td><td><code>/api/clash?colo=HKG,NRT</code></td></tr>
  <tr><td>智能就近</td><td><code>/sub?smart=1</code> 按你所在 colo 自动优先同区域节点</td></tr>
  <tr><td>统计</td><td><code>/api/stats</code> · <code>/api/history?days=7</code></td></tr>
  </tbody></table>
  <p class="mut" style="margin-top:8px">支持参数：<code>country</code>/<code>colo</code>/<code>carrier</code>(CT/CU/CM)/<code>port</code>/<code>maxDelay</code>/<code>minMbps</code>/<code>top</code>/<code>exclude</code>/<code>smart</code></p>
</div>`);
}

function renderTest() {
  return layout("在线测速 · cf-best-ip", `
<div class="card">
  <h2>浏览器在线测速</h2>
  <p class="mut">边缘节点 → 候选 IP 的真实 TCP 三次握手延迟。点击下方按钮开始测速。</p>
  <div class="row">
    <button class="btn" id="btn">▶ 开始测速 Top 30</button>
    <button class="btn ghost" id="copy">复制 Top 5</button>
    <span class="mut" id="status">待命</span>
  </div>
</div>
<div class="card">
  <table><thead><tr><th>#</th><th>IP</th><th>端口</th><th>国家</th><th>Colo</th><th>延迟</th></tr></thead>
  <tbody id="tb"></tbody></table>
</div>
<script>
const $=s=>document.querySelector(s);const $$=s=>Array.from(document.querySelectorAll(s));
async function load(){const r=await fetch('/api/ips?top=30');const d=await r.json();return d.ips||[]}
function row(x,i){return '<tr data-ip="'+x.ip+'" data-port="'+x.port+'"><td>'+(i+1)+'</td><td><code>'+x.ip+'</code></td><td>'+x.port+'</td><td>'+(x.country||'—')+'</td><td>'+(x.colo||'—')+'</td><td class="delay">…</td></tr>'}
async function probe(ip,port){const r=await fetch('/api/probe?ip='+ip+'&port='+port+'&times=3').then(r=>r.json()).catch(()=>({}));return r.avg}
async function run(){const btn=$('#btn');btn.disabled=true;$('#status').textContent='测速中…';
  const ips=await load();$('#tb').innerHTML=ips.map(row).join('');
  const rows=$$('#tb tr');let i=0,done=0;async function w(){while(i<rows.length){const r=rows[i++];const d=await probe(r.dataset.ip,r.dataset.port);const td=r.querySelector('.delay');if(d==null){td.textContent='失败';td.className='delay bad';r.dataset.delay=99999}else{td.textContent=d+'ms';td.className='delay '+(d<50?'ok':d<200?'warn':'bad');r.dataset.delay=d}done++;$('#status').textContent='进度 '+done+'/'+rows.length}}
  await Promise.all([w(),w(),w(),w(),w()]);
  const tb=$('#tb tbody')||$('#tb');const sorted=Array.from(tb.children).sort((a,b)=>+a.dataset.delay-+b.dataset.delay);sorted.forEach((r,i)=>{r.cells[0].textContent=i+1;tb.appendChild(r)});
  btn.disabled=false;$('#status').textContent='完成';}
$('#btn').onclick=run;
$('#copy').onclick=async()=>{const txt=$$('#tb tr').slice(0,5).map(r=>r.dataset.ip+':'+r.dataset.port).join('\\n');try{await navigator.clipboard.writeText(txt);$('#status').textContent='已复制 5 个'}catch(e){alert(txt)}};
</script>`);
}

function renderAdmin() {
  return layout("管理 · cf-best-ip", `
<div class="card"><h2>操作</h2>
  <div class="row">
    <button class="btn" id="refresh">🔄 立即测速</button>
    <button class="btn ghost" id="syncdns">📡 同步 DNS</button>
    <span class="mut" id="msg"></span>
  </div></div>

<div class="card"><h2>手动添加 IP</h2>
  <textarea id="manual" rows="4" style="width:100%" placeholder="一行一个，支持 1.2.3.4 / 1.2.3.4:443 / 1.2.3.4:443#CT"></textarea>
  <div class="row" style="margin-top:8px"><button class="btn" id="add">添加</button><button class="btn ghost" id="loadm">查看已添加</button></div>
  <pre id="manualList" class="mut" style="font-size:11px;max-height:160px;overflow:auto"></pre></div>

<div class="card"><h2>CIDR 扫描（≤ 64 IP）</h2>
  <div class="row"><input id="cidr" placeholder="173.245.48.0/26" style="width:240px"/><input id="cport" value="443" style="width:80px"/><button class="btn" id="scan">扫描</button></div>
  <pre id="scanRes" class="mut" style="font-size:12px;max-height:240px;overflow:auto"></pre></div>

<div class="card"><h2>配置</h2>
  <div id="cfg" class="mut" style="font-size:12px">加载中…</div>
  <textarea id="cfgEdit" rows="6" style="width:100%;margin-top:8px"></textarea>
  <button class="btn" id="saveCfg" style="margin-top:8px">保存配置</button></div>

<script>
const $=s=>document.querySelector(s);
function msg(t){$('#msg').textContent=t;setTimeout(()=>$('#msg').textContent='',4000)}
$('#refresh').onclick=async()=>{$('#refresh').disabled=true;msg('测速中…可能需 30~60 秒');const r=await fetch('/api/refresh').then(r=>r.json());msg('完成：'+r.count+' 节点，耗时 '+r.elapsedMs+'ms');$('#refresh').disabled=false};
$('#syncdns').onclick=async()=>{const r=await fetch('/api/dns/sync').then(r=>r.json());msg(JSON.stringify(r))};
$('#add').onclick=async()=>{const r=await fetch('/api/manual',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lines:$('#manual').value})}).then(r=>r.json());msg('已添加，当前 '+r.count);$('#manual').value=''};
$('#loadm').onclick=async()=>{const r=await fetch('/api/manual').then(r=>r.json());$('#manualList').textContent=JSON.stringify(r,null,2)};
$('#scan').onclick=async()=>{const r=await fetch('/api/cidr-scan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cidr:$('#cidr').value,port:+$('#cport').value})}).then(r=>r.json());$('#scanRes').textContent=JSON.stringify(r.ips,null,2)};
(async()=>{const c=await fetch('/api/config').then(r=>r.json());$('#cfg').textContent='当前配置：';$('#cfgEdit').value=JSON.stringify(c,null,2)})();
$('#saveCfg').onclick=async()=>{const body=JSON.parse($('#cfgEdit').value);const r=await fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());msg('已保存')};
</script>`);
}
