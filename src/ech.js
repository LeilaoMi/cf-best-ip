// ECH 可用性打标：部分 Cloudflare IP 在客户端带 ECH 访问 Free 计划站点时返回
// 1034 "Edge IP Restricted"，不带 ECH 正常。外部探测器（tools/ech-probe）定时上报，
// Worker 只做校验 / 合并 / 打标，不从池子里删除任何 IP。

export const ECH_STATUS_KEY = "ech:status";
export const ECH_STATUSES = ["ok", "restricted", "unknown"];
export const ECH_MAX_RESULTS = 2000;
export const ECH_MAX_BODY_BYTES = 256 * 1024;
export const ECH_MAX_SENTINELS = 16;
export const ECH_FRESH_MS = 36 * 60 * 60 * 1000;      // /api/ips 只信 36 小时内的结论
export const ECH_RETAIN_MS = 7 * 24 * 60 * 60 * 1000; // 7 天未更新的条目清理掉
export const ECH_MAX_STORED = 10000;                  // ech:status 总条目上限，超出时丢弃最旧的

const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const HOST_LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HEXTET_RE = /^[0-9a-f]{1,4}$/;

/**
 * 把（已小写的）IPv6 文本解析成 8 个 16 位整数；不接受内嵌 IPv4、zone id 或多个 "::"。
 * @param {string} ip
 * @returns {number[] | null} 非法时返回 null
 */
function parseIpv6Hextets(ip) {
  if (ip.length < 2 || ip.length > 39) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (![...head, ...tail].every(h => HEXTET_RE.test(h))) return null;
  if (halves.length === 1) return head.length === 8 ? head.map(h => Number.parseInt(h, 16)) : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array(missing).fill("0"), ...tail].map(h => Number.parseInt(h, 16));
}

/**
 * 按 RFC 5952 输出 IPv6 规范写法。
 * @param {number[]} hextets 8 个 16 位整数
 * @returns {string}
 */
function formatIpv6(hextets) {
  // RFC 5952：小写、去前导零、最长（≥2 个）零段压缩为 ::，并列取最左
  let bestStart = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (hextets[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && hextets[j] === 0) j++;
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = hextets.map(h => h.toString(16));
  if (bestLen < 2) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLen).join(":")}`;
}

/**
 * 严格校验 IPv4 / IPv6 并返回规范写法（IPv4 不允许前导零，IPv6 按 RFC 5952）。
 * @param {unknown} value
 * @returns {string | null} 非法返回 null
 */
export function canonicalIp(value) {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  if (IPV4_RE.test(s)) return s;
  if (!s.includes(":")) return null;
  const hextets = parseIpv6Hextets(s);
  return hextets ? formatIpv6(hextets) : null;
}

/**
 * 池子里的地址 → ech:status 的 key。先走严格的 canonicalIp；不通过时再把带前导零的点分十进制 IPv4
 * （如 `104.16.00.1`，按十进制而非八进制理解）规范成 `104.16.0.1`，让它也能匹配到上报结论。
 * 只用于查询，上报校验仍用严格的 canonicalIp。
 * @param {unknown} value
 * @returns {string | null}
 */
export function lookupIpKey(value) {
  const strict = canonicalIp(value);
  if (strict || typeof value !== "string") return strict;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every(n => n <= 255) ? parts.join(".") : null;
}

/**
 * 校验并规范化哨兵主机名：小写、去掉结尾的点、至少两段、每段符合 LDH 规则。
 * @param {unknown} value
 * @returns {string | null}
 */
function canonicalHostname(value) {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase().replace(/\.$/, "");
  if (!s || s.length > 253) return null;
  const labels = s.split(".");
  if (labels.length < 2 || !labels.every(l => HOST_LABEL_RE.test(l))) return null;
  return s;
}

const STATUS_RANK = { unknown: 0, ok: 1, restricted: 2 };

/**
 * 校验上报 body（已 JSON.parse）。成功返回 { ok: true, report }，失败返回 { ok: false, error }。
 * 同一次上报里同一 IP 出现多次时取最保守的结论：restricted > ok > unknown。
 * @param {unknown} body
 * @returns {{ok: true, report: {runId: string, sentinels: string[], results: {ip: string, status: string}[]}} | {ok: false, error: string}}
 */
export function validateEchReport(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const { runId, sentinels, results } = body;
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) return { ok: false, error: "runId must match [A-Za-z0-9._:-]{1,128}" };
  if (!Array.isArray(sentinels) || sentinels.length < 1 || sentinels.length > ECH_MAX_SENTINELS) {
    return { ok: false, error: `sentinels must be an array of 1-${ECH_MAX_SENTINELS} hostnames` };
  }
  const hosts = [];
  for (const h of sentinels) {
    const host = canonicalHostname(h);
    if (!host) return { ok: false, error: "invalid sentinel hostname" };
    if (!hosts.includes(host)) hosts.push(host);
  }
  if (!Array.isArray(results)) return { ok: false, error: "results must be an array" };
  if (results.length > ECH_MAX_RESULTS) return { ok: false, error: `too many results (max ${ECH_MAX_RESULTS})` };
  const byIp = new Map();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, error: `results[${i}] must be an object` };
    const ip = canonicalIp(r.ip);
    if (!ip) return { ok: false, error: `results[${i}].ip is not a valid IPv4/IPv6 address` };
    if (!ECH_STATUSES.includes(r.status)) return { ok: false, error: `results[${i}].status must be one of ${ECH_STATUSES.join("/")}` };
    const prev = byIp.get(ip);
    if (!prev || STATUS_RANK[r.status] > STATUS_RANK[prev]) byIp.set(ip, r.status);
  }
  return { ok: true, report: { runId, sentinels: hosts, results: [...byIp].map(([ip, status]) => ({ ip, status })) } };
}

/**
 * 判断 KV 中单个 IP 条目 `{s, t}` 是否结构合法。
 * @param {unknown} e
 * @returns {boolean}
 */
function isEntry(e) {
  return e && typeof e === "object" && ECH_STATUSES.includes(e.s) && Number.isFinite(e.t);
}

/**
 * 把一次（已校验的）上报合并进 KV 里的 ech:status。
 * - ok / restricted 覆盖旧值；
 * - unknown 不覆盖已有的确定结论（ok/restricted），只在无记录（或旧记录本身就是 unknown）时写入；
 * - 清理 retainMs 内未更新的条目（以及结构损坏的条目）；
 * - 总条目超过 maxStored 时按更新时间丢弃最旧的（计入 pruned）。
 * @param {object | null} prev KV 中现有的 ech:status
 * @param {{runId: string, sentinels: string[], results: {ip: string, status: string}[]}} report validateEchReport 的结果
 * @param {number} [now]
 * @param {number} [retainMs]
 * @param {number} [maxStored]
 * @returns {{next: object, accepted: number, counts: {ok: number, restricted: number, unknown: number}, pruned: number}}
 */
export function mergeEchStatus(prev, report, now = Date.now(), retainMs = ECH_RETAIN_MS, maxStored = ECH_MAX_STORED) {
  const ips = {};
  const prevIps = prev && typeof prev.ips === "object" && prev.ips ? prev.ips : {};
  let pruned = 0;
  for (const [ip, e] of Object.entries(prevIps)) {
    if (isEntry(e) && now - e.t <= retainMs) ips[ip] = { s: e.s, t: e.t };
    else pruned++;
  }
  const counts = { ok: 0, restricted: 0, unknown: 0 };
  let accepted = 0;
  for (const { ip, status } of report.results) {
    counts[status]++;
    const cur = ips[ip];
    if (status === "unknown" && cur && cur.s !== "unknown") continue;
    ips[ip] = { s: status, t: now };
    accepted++;
  }
  // 总量上限：多次上报互不相交的 IP 集合时 ech:status 不会无限增长（/api/ips 每次都要读它）
  let kept = ips;
  const entries = Object.entries(ips);
  if (entries.length > maxStored) {
    entries.sort((a, b) => b[1].t - a[1].t);
    pruned += entries.length - maxStored;
    kept = Object.fromEntries(entries.slice(0, maxStored));
  }
  return {
    next: { updatedAt: now, runId: report.runId, sentinels: report.sentinels, ips: kept },
    accepted,
    counts,
    pruned,
  };
}

/**
 * /api/ips 用的打标：新鲜的 ok → true，新鲜的 restricted → false，其余（unknown、过期、未来时间戳、损坏）→ null。
 * @param {{s: string, t: number} | undefined} entry
 * @param {number} [now]
 * @param {number} [freshMs]
 * @returns {boolean | null}
 */
export function echFlag(entry, now = Date.now(), freshMs = ECH_FRESH_MS) {
  if (!isEntry(entry) || now - entry.t > freshMs || entry.t > now + 5 * 60 * 1000) return null;
  if (entry.s === "ok") return true;
  if (entry.s === "restricted") return false;
  return null;
}

/**
 * 根据 ech:status 生成 ip → true/false/null 查询函数；status 缺失/损坏时一律 null。
 * @param {{ips?: Record<string, {s: string, t: number}>} | null} status
 * @param {number} [now]
 * @returns {(ip: string) => boolean | null}
 */
export function makeEchLookup(status, now = Date.now()) {
  const ips = status && typeof status.ips === "object" && status.ips ? status.ips : null;
  if (!ips) return () => null;
  return (ip) => {
    const key = lookupIpKey(ip);
    return key && Object.prototype.hasOwnProperty.call(ips, key) ? echFlag(ips[key], now) : null;
  };
}

/**
 * 读取请求 body，超过 maxBytes 抛出 { code: "body-too-large" }。
 * 先看 Content-Length，再流式计数，防止分块上传绕过；非 UTF-8 内容抛 TypeError。
 * @param {Request} request
 * @param {number} [maxBytes]
 * @returns {Promise<string>}
 */
export async function readBodyLimited(request, maxBytes = ECH_MAX_BODY_BYTES) {
  const tooLarge = () => Object.assign(new Error("body too large"), { code: "body-too-large" });
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw tooLarge();
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(buf);
}
