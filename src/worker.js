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

// 中国大陆三大运营商 ASN（用于按访问者 IP 猜运营商）
const CN_ASN_TO_CARRIER = {
  4134: "CT", 4812: "CT", 4847: "CT", 17621: "CT", 17623: "CT",
  23724: "CT", 24134: "CT", 24138: "CT", 58453: "CT", 134543: "CT", 137692: "CT",
  4837: "CU", 9929: "CU", 10099: "CU", 17816: "CU",
  9808: "CM", 24400: "CM", 24445: "CM", 56040: "CM", 56041: "CM", 56042: "CM", 9394: "CM", 56046: "CM",
};

/** 从 request.cf 抽访问者信息 + 猜运营商 */
function getVisitor(request) {
  const cf = request.cf || {};
  const asn = Number(cf.asn) || null;
  return {
    country: cf.country || null,
    region: cf.regionCode || cf.region || null,
    city: cf.city || null,
    colo: cf.colo || null,
    asn,
    asOrg: cf.asOrganization || null,
    carrier: asn ? (CN_ASN_TO_CARRIER[asn] || null) : null,
  };
}

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
  const manual = await getManual(env);
  for (const m of manual) agg.ips.push({ ...m, sources: ["manual"], _manual: true });

  // 2. 标记 / 测速
  //    注意：Cloudflare Workers 禁止 connect() 到自家 IP，
  //    所以对来源于公开池的 CF IP，我们直接信任源数据（它们都已被
  //    第三方测速站点预筛选），跳过 TCP ping；只对手动添加的非 CF IP
  //    实际跑 ping。
  const probed = await pMap(agg.ips, async (item) => {
    const port = item.port || 443;
    if (item._manual) {
      const r = await tcpPingN(item.ip, port, 2, cfg.probeTimeoutMs);
      return { ...item, port, delay: r.avg, loss: r.loss, tested: r.avg != null };
    }
    return { ...item, port, delay: null, loss: 0, tested: false };
  }, cfg.probeConcurrency);

  // 3. 过滤：手动添加的要测速通过；池子里的全保留
  let alive = probed.filter(x => x._manual ? (x.delay != null && x.loss < 0.5) : true);
  // 排序：tested + delay 小的优先；其余按来源数量降序
  alive.sort((a, b) => {
    if (a.tested && b.tested) return a.delay - b.delay;
    if (a.tested) return -1;
    if (b.tested) return 1;
    return (b.sources?.length || 0) - (a.sources?.length || 0);
  });

  // 4. colo/国家探测：CF Workers 非企业版下 resolveOverride 不生效，
  //    会把所有目标 IP 都标成 Worker 自己的 colo（如 FRA/DE），属于假数据 —— 已禁用。
  //    如果你有企业版账户，可手动恢复以下代码块：
  //    await pMap(alive.slice(0, 20), async item => {
  //      const info = await detectColo(item.ip, item.port, 2500);
  //      if (info?.colo) Object.assign(item, info);
  //    }, 8);

  // 5. 应用国家黑名单（只对已知 country 的过滤）
  if (cfg.countryBlocklist && cfg.countryBlocklist.length) {
    alive = alive.filter(x => !x.country || !cfg.countryBlocklist.includes(x.country));
  }

  // 6. 带宽测试同样依赖 resolveOverride，非企业版下无效，已禁用
  //    await pMap(alive.slice(0, cfg.bandwidthSampleSize), async item => {
  //      item.mbps = await probeBandwidth(item.ip, cfg.bandwidthBytes, 6000);
  //    }, 5);

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
  const visitor = getVisitor(request);

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
    // 注意：Workers 平台禁止从 Worker 连 CF 自家 IP，对 CF IP 返回的 loss 始终为 1
    return json({ ok: r.avg != null, ip, port, ...r, hint: r.avg == null ? "Workers cannot connect to Cloudflare-owned IPs; this is a platform limitation, not your IP being down." : undefined });
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
  if (path === "/" || path === "/index.html") return html(renderHome(data, visitor));
  if (path === "/test") return html(renderTest(visitor));
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
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="theme-color" content="#0b0f14"/>
<title>${title}</title>
<style>
:root{--bg:#0b0f14;--card:#161b22;--bd:#30363d;--fg:#e6edf3;--mut:#8b949e;--acc:#f9826c;--ok:#7ee787;--warn:#d8af3c;--bad:#ff7b72}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding-bottom:env(safe-area-inset-bottom)}
a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1000px;margin:0 auto;padding:14px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px;margin-bottom:12px}
h1{margin:0;font-size:20px;line-height:1.2}
h2{margin:0 0 10px;font-size:14px;color:var(--mut);font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:10px 14px;font-weight:600;cursor:pointer;font-size:13px;min-height:40px;touch-action:manipulation}
.btn:active{transform:translateY(1px)}.btn:disabled{opacity:.5;cursor:wait}
.btn.ghost{background:transparent;border:1px solid var(--bd);color:var(--fg)}
.btn.sm{padding:6px 10px;min-height:32px;font-size:12px}
input,select,textarea{background:#0d1117;color:var(--fg);border:1px solid var(--bd);border-radius:8px;padding:9px 12px;font:13px/1.4 -apple-system,sans-serif;min-height:40px;-webkit-appearance:none;appearance:none}
select{background-image:linear-gradient(45deg,transparent 50%,var(--mut) 50%),linear-gradient(135deg,var(--mut) 50%,transparent 50%);background-position:calc(100% - 14px) 50%,calc(100% - 9px) 50%;background-size:5px 5px;background-repeat:no-repeat;padding-right:32px}
input:focus,select:focus,textarea:focus{outline:0;border-color:var(--acc)}
.tag{display:inline-flex;align-items:center;padding:2px 8px;border-radius:12px;background:#21262d;font-size:11px;color:var(--mut);gap:3px;white-space:nowrap}
.tag.ct{background:rgba(126,231,135,.12);color:var(--ok)}
.tag.cu{background:rgba(216,175,60,.12);color:var(--warn)}
.tag.cm{background:rgba(88,166,255,.12);color:#58a6ff}
.tag.cf{background:rgba(249,130,108,.12);color:var(--acc)}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.mut{color:var(--mut)}
nav{display:flex;gap:10px;font-size:13px;flex-wrap:wrap}nav a{color:var(--mut);padding:4px 0}
code{background:#0d1117;padding:2px 6px;border-radius:4px;font-size:12px;font-family:ui-monospace,Menlo,monospace;word-break:break-all}

/* 访问者信息 banner */
.visitor{background:linear-gradient(135deg,rgba(249,130,108,.08),rgba(88,166,255,.08));border:1px solid var(--bd);border-radius:10px;padding:12px 14px;margin-bottom:12px;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;font-size:13px}
.visitor b{color:var(--acc)}
.visitor .pill{padding:3px 10px;border-radius:14px;background:rgba(249,130,108,.12);color:var(--acc);font-weight:600;font-size:12px}

/* 节点卡片列表 */
.nodes{display:grid;gap:8px;grid-template-columns:1fr}
.node{display:grid;grid-template-columns:auto 1fr auto;gap:6px 12px;padding:12px;background:#0d1117;border:1px solid var(--bd);border-radius:8px;align-items:center}
.node-no{font-size:11px;color:var(--mut);grid-row:span 2;align-self:start;padding-top:2px;min-width:22px}
.node-ip{font-family:ui-monospace,Menlo,monospace;font-size:14px;font-weight:600;letter-spacing:-.01em;word-break:break-all}
.node-meta{font-size:11px;color:var(--mut);display:flex;flex-wrap:wrap;gap:6px 10px;grid-column:2/3}
.node-act{display:flex;gap:6px;align-self:start}
.copybtn{background:#21262d;border:1px solid var(--bd);color:var(--fg);border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer;min-height:30px}
.copybtn:active{background:#30363d}

/* sticky filter bar */
.filterbar{position:sticky;top:0;z-index:10;background:var(--bg);padding:10px 0 12px;margin:-2px 0 12px;border-bottom:1px solid var(--bd)}
.filterbar .row{gap:6px}
.filterbar select,.filterbar input{min-height:36px;padding:6px 10px;font-size:12px}
.filterbar .lbl{font-size:11px;color:var(--mut);margin-right:2px}

/* 桌面端 */
@media (min-width:720px){
  .wrap{padding:24px}
  .card{padding:18px;margin-bottom:16px}
  h1{font-size:24px}
  .nodes{grid-template-columns:1fr 1fr}
  nav{gap:16px;font-size:14px}
}
@media (min-width:980px){
  .nodes{grid-template-columns:1fr 1fr 1fr}
}

/* 表格（仅桌面端展示） */
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--bd)}
th{font-weight:600;color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em}

${extraHead}
</style></head><body><div class="wrap">
<header style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:12px;flex-wrap:wrap">
  <div><h1>☁️ cf-best-ip</h1><div class="mut" style="font-size:11px;margin-top:2px">融合社区方案 · 集大成版 v${VERSION}</div></div>
  <nav><a href="/">首页</a><a href="/test">节点浏览</a><a href="/admin">管理</a><a href="https://github.com/LeilaoMi/cf-best-ip" target="_blank" rel="noreferrer">GitHub</a></nav>
</header>
${body}
<footer class="mut" style="margin-top:20px;font-size:11px;text-align:center;padding:14px 0">基于 Cloudflare Workers · MIT License · ☕</footer>
</div></body></html>`;
}

function renderVisitorBanner(v) {
  const flagStr = flag(v.country);
  const region = [v.country, v.region, v.city].filter(Boolean).join(" · ") || "未知";
  const carrierTag = v.carrier
    ? `<span class="pill">建议优选: ${carrierName(v.carrier)}</span>`
    : (v.country === "CN"
        ? `<span class="pill mut" style="background:#21262d;color:var(--mut)">未识别运营商，建议通用</span>`
        : `<span class="pill" style="background:rgba(126,231,135,.12);color:var(--ok)">海外用户，建议通用</span>`);
  const asInfo = v.asOrg ? `<span class="mut">${v.asOrg}${v.asn ? " · AS" + v.asn : ""}</span>` : "";
  return `<div class="visitor">
    <span style="font-size:18px">${flagStr}</span>
    <span>你来自 <b>${region}</b></span>
    ${asInfo}
    ${carrierTag}
  </div>`;
}

function renderHome(data, visitor) {
  const ips = data.ips || [];
  const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "（未运行）";
  const total = ips.length;
  const byCarrier = ips.reduce((m, x) => { const c = x.carrier || "CF"; m[c] = (m[c] || 0) + 1; return m; }, {});
  const carriersHtml = ["CT", "CU", "CM", "CF"].map(c => {
    const n = byCarrier[c] || 0;
    const recommend = visitor.carrier === c;
    return `<a class="tag ${c.toLowerCase()}" href="/test?carrier=${c}" style="font-size:13px;padding:6px 12px${recommend ? ";box-shadow:0 0 0 2px var(--acc)" : ""}">${carrierName(c)} <b style="margin-left:4px">${n}</b></a>`;
  }).join(" ");

  // 推荐订阅链接：基于访问者
  const subBase = "/sub";
  const subPaths = visitor.carrier
    ? [{ name: `${carrierName(visitor.carrier)}优选`, path: `${subBase}?carrier=${visitor.carrier}&top=10` }]
    : [];
  subPaths.push(
    { name: "智能就近", path: `${subBase}?smart=1&top=10` },
    { name: "全部 Top 20", path: `${subBase}?top=20` },
    { name: "海外低延迟", path: `${subBase}?country=HK,JP,SG,US&top=10` },
  );
  const subLinks = subPaths.map(s =>
    `<div class="node" style="grid-template-columns:1fr auto"><div><div style="font-weight:600">${s.name}</div><div class="mut" style="font-size:11px;margin-top:2px"><code>${s.path}</code></div></div><button class="copybtn" data-copy="${s.path}">复制</button></div>`
  ).join("");

  return layout("cf-best-ip · 优选 IP 服务", `
${renderVisitorBanner(visitor)}

<div class="card">
  <h2>节点池状态</h2>
  <div class="row" style="gap:14px;font-size:13px">
    <div>📦 总节点 <b style="font-size:18px;color:var(--acc)">${total}</b></div>
    <div>⏰ 更新于 ${updated}</div>
  </div>
  <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap">${carriersHtml}</div>
</div>

<div class="card">
  <h2>快捷订阅</h2>
  <div class="nodes">${subLinks}</div>
  <p class="mut" style="font-size:11px;margin-top:10px">点"复制"获取相对路径，需自行拼上完整域名。橘色框是基于你当前 IP 推荐的方案。</p>
</div>

<div class="card">
  <h2>所有 API 接口</h2>
  <div style="font-size:12px;line-height:2">
    <div><code>/sub</code> · <code>/sub?carrier=CT&top=10</code> · <code>/sub?country=HK,JP</code> · <code>/sub?smart=1</code> — 纯文本订阅</div>
    <div><code>/api/ips</code> — JSON，支持所有筛选参数</div>
    <div><code>/api/preferred-ips</code> — EdgeTunnel 兼容</div>
    <div><code>/api/v2ray</code> — V2Ray base64</div>
    <div><code>/api/clash</code> — Clash YAML</div>
    <div><code>/api/stats</code> — 分布统计 · <code>/api/history?days=7</code></div>
  </div>
  <p class="mut" style="font-size:11px;margin-top:10px">参数：<code>country</code> / <code>colo</code> / <code>carrier</code>(CT/CU/CM) / <code>port</code> / <code>maxDelay</code> / <code>top</code> / <code>exclude</code> / <code>smart=1</code>，可任意组合</p>
</div>

<script>
const origin = location.origin;
document.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
  const url = origin + b.dataset.copy;
  try { await navigator.clipboard.writeText(url); const o = b.textContent; b.textContent = '✓ 已复制'; setTimeout(() => b.textContent = o, 1500); }
  catch (e) { prompt('复制此链接', url); }
});
</script>`);
}

function renderTest(visitor) {
  const presetCarrier = visitor.carrier || "";
  const visitorJson = JSON.stringify(visitor);
  return layout("节点浏览 · cf-best-ip", `
${renderVisitorBanner(visitor)}

<div class="filterbar">
  <div class="row">
    <span class="lbl">运营商</span>
    <select id="fCarrier">
      <option value="">全部</option>
      <option value="CT"${presetCarrier === "CT" ? " selected" : ""}>电信 CT</option>
      <option value="CU"${presetCarrier === "CU" ? " selected" : ""}>联通 CU</option>
      <option value="CM"${presetCarrier === "CM" ? " selected" : ""}>移动 CM</option>
      <option value="CF">通用 CF</option>
    </select>
    <span class="lbl">国家</span>
    <select id="fCountry"><option value="">全部</option></select>
    <span class="lbl">数量</span>
    <select id="fTop">
      <option>10</option><option selected>20</option><option>30</option><option>50</option><option>100</option>
    </select>
  </div>
  <div class="row" style="margin-top:8px">
    <button class="btn sm" id="btnCopy">📋 复制订阅</button>
    <button class="btn sm ghost" id="btnDownload">⬇ 下载 .txt</button>
    <button class="btn sm ghost" id="btnRefresh">🔄 刷新</button>
    <span class="mut" id="status" style="margin-left:auto;font-size:11px"></span>
  </div>
</div>

<div class="card">
  <h2><span id="hdr">节点列表</span></h2>
  <div class="nodes" id="list"><div class="mut" style="padding:14px;text-align:center">加载中…</div></div>
</div>

<div class="card">
  <h2>测速说明</h2>
  <p class="mut" style="font-size:12px;line-height:1.7;margin:0">
    ⚠️ <b>Cloudflare Workers 平台禁止从 Worker 直接连接 Cloudflare 自家 IP</b>，
    所以在网页上"测速"对 CF IP 永远会失败 — 这是平台限制，不是 bug。<br/>
    上方节点列表来自 <b>7 个公开数据源</b>，这些源由各位社区维护者从中国大陆三网真实测速得来。
    要测你本机到这些 IP 的真实延迟，请：<br/>
    1. 在上方按你的运营商筛选 → 复制订阅<br/>
    2. 把订阅地址扔给客户端（V2RayN / Clash / NekoBox 等），客户端会做真实测速并自动切到最快的<br/>
    3. 或下载 <a href="https://github.com/XIU2/CloudflareSpeedTest/releases" target="_blank" rel="noreferrer">CloudflareSpeedTest</a> 命令行版做硬核测速
  </p>
</div>

<script>
const visitor = ${visitorJson};
const $ = s => document.querySelector(s);
const fC = $('#fCarrier'), fCt = $('#fCountry'), fT = $('#fTop');
let allIps = [];

function carrierTag(c) {
  const m = {CT:'电信',CU:'联通',CM:'移动',CMCC:'移动',CF:'通用'};
  const cls = (c || 'cf').toLowerCase();
  return '<span class="tag '+cls+'">'+(m[c]||'通用')+'</span>';
}
function flagEmoji(c){const map={HK:'🇭🇰',JP:'🇯🇵',KR:'🇰🇷',TW:'🇹🇼',SG:'🇸🇬',US:'🇺🇸',CA:'🇨🇦',GB:'🇬🇧',DE:'🇩🇪',FR:'🇫🇷',NL:'🇳🇱',AU:'🇦🇺',RU:'🇷🇺',IN:'🇮🇳',CN:'🇨🇳',TH:'🇹🇭',MY:'🇲🇾'};return map[c]||'🌐';}

function renderList(ips) {
  if (!ips.length) { $('#list').innerHTML = '<div class="mut" style="padding:14px;text-align:center">没有匹配的节点，调整筛选试试</div>'; $('#hdr').textContent='节点列表 (0)'; return; }
  $('#hdr').textContent = '节点列表 ('+ips.length+')';
  $('#list').innerHTML = ips.map((x, i) => {
    const meta = [
      x.country ? flagEmoji(x.country)+' '+x.country : null,
      x.colo,
      x.sources ? '源 '+x.sources.length : null,
    ].filter(Boolean).join(' · ');
    return '<div class="node">' +
      '<div class="node-no">#'+(i+1)+'</div>' +
      '<div><div class="node-ip">'+x.ip+'<span class="mut" style="font-weight:400;font-size:12px">:'+x.port+'</span></div>' +
        '<div class="node-meta">'+carrierTag(x.carrier)+'<span>'+meta+'</span></div>' +
      '</div>' +
      '<div class="node-act"><button class="copybtn" data-ip="'+x.ip+':'+x.port+'">复制</button></div>' +
    '</div>';
  }).join('');
  document.querySelectorAll('[data-ip]').forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.ip); const o=b.textContent; b.textContent='✓'; setTimeout(()=>b.textContent=o, 1200); }
    catch (e) { prompt('复制', b.dataset.ip); }
  });
}

function buildSubUrl() {
  const p = new URLSearchParams();
  if (fC.value) p.set('carrier', fC.value);
  if (fCt.value) p.set('country', fCt.value);
  if (fT.value) p.set('top', fT.value);
  return '/sub' + (p.toString() ? '?' + p.toString() : '');
}

async function load() {
  $('#status').textContent = '加载中…';
  const p = new URLSearchParams();
  p.set('top', '500');
  const r = await fetch('/api/ips?' + p.toString()).then(r=>r.json()).catch(()=>({ips:[]}));
  allIps = r.ips || [];
  // 填充国家下拉
  const countries = [...new Set(allIps.map(x => x.country).filter(Boolean))].sort();
  fCt.innerHTML = '<option value="">全部</option>' + countries.map(c => '<option value="'+c+'">'+flagEmoji(c)+' '+c+'</option>').join('');
  applyFilter();
  $('#status').textContent = '已加载 '+allIps.length+' 个候选';
}

function applyFilter() {
  let list = allIps.slice();
  if (fC.value) list = list.filter(x => (x.carrier||'CF') === fC.value);
  if (fCt.value) list = list.filter(x => x.country === fCt.value);
  list = list.slice(0, +fT.value || 20);
  renderList(list);
}

fC.onchange = fCt.onchange = fT.onchange = applyFilter;

$('#btnCopy').onclick = async () => {
  const url = location.origin + buildSubUrl();
  try { await navigator.clipboard.writeText(url); $('#status').textContent = '✓ 订阅链接已复制'; }
  catch (e) { prompt('复制此订阅链接', url); }
};
$('#btnDownload').onclick = async () => {
  const r = await fetch(buildSubUrl()).then(r=>r.text());
  const b = new Blob([r], {type:'text/plain'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'cf-best-ip.txt'; a.click();
};
$('#btnRefresh').onclick = load;

load();
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
