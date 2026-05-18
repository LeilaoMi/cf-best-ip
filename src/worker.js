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
const VERSION = "2.1.0";

const DEFAULT_CFG = {
  topN: 30,
  probeTimeoutMs: 3000,
  probeConcurrency: 20,
  bandwidthSampleSize: 5,           // 抽 5 个延迟最优的做带宽测试
  bandwidthBytes: 256 * 1024,       // 下载 256 KB
  countryBlocklist: ["CN"],         // 默认屏蔽中国大陆 colo
  ports: [443],                     // 默认只测 443
  refreshHours: 6,
  // ===== v2.1 cfnb 融合新增 =====
  // 可用性二次检测：用 api.090227.xyz/check 验证 IP 真能反代
  availabilityCheckEnabled: false,
  availabilityCheckApi: "https://api.090227.xyz/check",
  availabilityCheckTimeoutMs: 4000,
  availabilityCheckConcurrency: 16,
  // DNS 同步阶段独立黑名单（默认 cfnb 28 国）
  dnsBlocklistEnabled: true,
  dnsBlocklist: ["BD","BI","BY","CD","CF","CN","CU","DE","ET","HK","IR","KP","LY","MO","NG","NL","PK","RU","SD","SO","SY","TH","TW","UA","VE","VN","YE","ZW"],
  // IP 风险等级过滤（DNS 阶段）
  dnsRiskFilterEnabled: false,
  dnsRiskMaxLevel: "高风险",     // 极度纯净/纯净/轻微风险/高风险/极度危险
  riskCheckApi: "https://api.ipapi.is/",
  riskCheckTimeoutMs: 4000,
  // 分国家 TopN 模式（off = 全局 TopN）
  perCountryMode: false,
  perCountryTopN: 1,
  // WxPusher 微信通知（用 env.WXPUSHER_TOKEN / WXPUSHER_UIDS）
  wxpusherApi: "https://wxpusher.zjiecode.com/api/send/message",
};

const SOURCES = [
  { name: "addressesapi/ip.164746.xyz", url: "https://addressesapi.090227.xyz/ip.164746.xyz", type: "carrier" },
  { name: "addressesapi/CloudFlareYes", url: "https://addressesapi.090227.xyz/CloudFlareYes", type: "carrier" },
  { name: "addressesapi/cmcc",          url: "https://addressesapi.090227.xyz/cmcc",          type: "carrier" },
  { name: "addressesapi/ct",            url: "https://addressesapi.090227.xyz/ct",            type: "text" },
  { name: "uouin.com/cloudflare", url: "https://api.uouin.com/cloudflare.html", type: "uouin_html" },
  { name: "ip.164746.xyz/ipTop",        url: "https://ip.164746.xyz/ipTop.html",              type: "text" },
  { name: "IPDB/proxy",                 url: "https://raw.githubusercontent.com/ymyuuu/IPDB/main/proxy.txt", type: "list" },
  { name: "zip.cm.edu.kg/all",          url: "https://zip.cm.edu.kg/all.txt",                 type: "text" },
  // ===== v2.1 cfnb 新增源 =====
  { name: "countrymerge/all",           url: "https://countrymerge.pages.dev/all.txt",        type: "text" },
  { name: "wtf-359/wtf",                url: "https://wtf-359.pages.dev/wtf.txt",             type: "text" },
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
  const asn = cf.asn || null;
  const asOrg = cf.asOrganization || "";
  let carrier = CN_ASN_TO_CARRIER[asn] || null;
  if (!carrier && asOrg) {
    const o = asOrg.toLowerCase();
    if (o.includes("unicom") || o.includes("cnc") || o.includes("cncgroup")) carrier = "CU";
    else if (o.includes("china telecom") || o.includes("chinanet")) carrier = "CT";
    else if (o.includes("china mobile") || o.includes("cmcc") || o.includes("cmnet")) carrier = "CM";
  }
  return {
    country: cf.country || null,
    region: cf.regionCode || null,
    city: cf.city || null,
    asn,
    asOrg: asOrg || null,
    colo: cf.colo || null,
    carrier,
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
  const m = line.match(/(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?(?:#([\w\-]+))?/);
  if (!m) return null;
  let carrier = null;
  let country = null;
  if (m[3]) {
    const tag = m[3].toUpperCase().split("-")[0];
    if (["CT", "CU", "CM", "CMCC", "CF"].includes(tag)) {
      carrier = tag === "CMCC" ? "CM" : tag;
    } else if (/^[A-Z]{2}$/.test(tag)) {
      country = tag;
    }
  }
  return { ip: m[1], port: m[2] ? +m[2] : 443, carrier, country };
}

// ============================================================
// 2b. cfnb 融合：自适应国家解析 + 可用性二次检测 + IP 风险等级
// ============================================================

// 中文国名 → 国家代码（来自 cfnb，全球覆盖）
const CN_TO_CODE = {
  "阿富汗":"AF","奥兰群岛":"AX","阿尔巴尼亚":"AL","阿尔及利亚":"DZ","美属萨摩亚":"AS","安道尔":"AD",
  "安哥拉":"AO","安圭拉":"AI","南极洲":"AQ","安提瓜和巴布达":"AG","阿根廷":"AR","亚美尼亚":"AM",
  "阿鲁巴":"AW","澳大利亚":"AU","奥地利":"AT","阿塞拜疆":"AZ","巴哈马":"BS","巴林":"BH",
  "孟加拉国":"BD","孟加拉":"BD","巴巴多斯":"BB","白俄罗斯":"BY","比利时":"BE","伯利兹":"BZ",
  "贝宁":"BJ","百慕大":"BM","不丹":"BT","玻利维亚":"BO","波黑":"BA","博茨瓦纳":"BW","巴西":"BR",
  "文莱":"BN","保加利亚":"BG","布基纳法索":"BF","布隆迪":"BI","柬埔寨":"KH","喀麦隆":"CM",
  "加拿大":"CA","佛得角":"CV","开曼群岛":"KY","中非":"CF","乍得":"TD","智利":"CL","中国":"CN",
  "圣诞岛":"CX","哥伦比亚":"CO","科摩罗":"KM","刚果(布)":"CG","刚果(金)":"CD","库克群岛":"CK",
  "哥斯达黎加":"CR","科特迪瓦":"CI","克罗地亚":"HR","古巴":"CU","塞浦路斯":"CY","捷克":"CZ",
  "丹麦":"DK","吉布提":"DJ","多米尼克":"DM","多米尼加":"DO","厄瓜多尔":"EC","埃及":"EG",
  "萨尔瓦多":"SV","赤道几内亚":"GQ","厄立特里亚":"ER","爱沙尼亚":"EE","埃塞俄比亚":"ET",
  "斐济":"FJ","芬兰":"FI","法国":"FR","加蓬":"GA","冈比亚":"GM","格鲁吉亚":"GE","德国":"DE",
  "加纳":"GH","希腊":"GR","格陵兰":"GL","格林纳达":"GD","关岛":"GU","危地马拉":"GT","几内亚":"GN",
  "几内亚比绍":"GW","圭亚那":"GY","海地":"HT","梵蒂冈":"VA","洪都拉斯":"HN","香港":"HK",
  "匈牙利":"HU","冰岛":"IS","印度":"IN","印度尼西亚":"ID","伊朗":"IR","伊拉克":"IQ","爱尔兰":"IE",
  "以色列":"IL","意大利":"IT","牙买加":"JM","日本":"JP","约旦":"JO","哈萨克斯坦":"KZ","肯尼亚":"KE",
  "基里巴斯":"KI","朝鲜":"KP","韩国":"KR","科威特":"KW","吉尔吉斯斯坦":"KG","老挝":"LA","拉脱维亚":"LV",
  "黎巴嫩":"LB","莱索托":"LS","利比里亚":"LR","利比亚":"LY","列支敦士登":"LI","立陶宛":"LT",
  "卢森堡":"LU","澳门":"MO","马其顿":"MK","马达加斯加":"MG","马拉维":"MW","马来西亚":"MY",
  "马尔代夫":"MV","马里":"ML","马耳他":"MT","马绍尔群岛":"MH","毛里塔尼亚":"MR","毛里求斯":"MU",
  "墨西哥":"MX","密克罗尼西亚":"FM","摩尔多瓦":"MD","摩纳哥":"MC","蒙古":"MN","黑山":"ME",
  "摩洛哥":"MA","莫桑比克":"MZ","缅甸":"MM","纳米比亚":"NA","瑙鲁":"NR","尼泊尔":"NP","荷兰":"NL",
  "新喀里多尼亚":"NC","新西兰":"NZ","尼加拉瓜":"NI","尼日尔":"NE","尼日利亚":"NG","纽埃":"NU",
  "挪威":"NO","阿曼":"OM","巴基斯坦":"PK","帕劳":"PW","巴勒斯坦":"PS","巴拿马":"PA","巴布亚新几内亚":"PG",
  "巴拉圭":"PY","秘鲁":"PE","菲律宾":"PH","波兰":"PL","葡萄牙":"PT","波多黎各":"PR","卡塔尔":"QA",
  "罗马尼亚":"RO","俄罗斯":"RU","卢旺达":"RW","萨摩亚":"WS","圣马力诺":"SM","沙特阿拉伯":"SA","沙特":"SA",
  "塞内加尔":"SN","塞尔维亚":"RS","塞舌尔":"SC","塞拉利昂":"SL","新加坡":"SG","斯洛伐克":"SK",
  "斯洛文尼亚":"SI","所罗门群岛":"SB","索马里":"SO","南非":"ZA","南苏丹":"SS","西班牙":"ES",
  "斯里兰卡":"LK","苏丹":"SD","苏里南":"SR","斯威士兰":"SZ","瑞典":"SE","瑞士":"CH","叙利亚":"SY",
  "台湾":"TW","塔吉克斯坦":"TJ","坦桑尼亚":"TZ","泰国":"TH","东帝汶":"TL","多哥":"TG","托克劳":"TK",
  "汤加":"TO","特立尼达和多巴哥":"TT","突尼斯":"TN","土耳其":"TR","土库曼斯坦":"TM","图瓦卢":"TV",
  "乌干达":"UG","乌克兰":"UA","阿联酋":"AE","英国":"GB","美国":"US","乌拉圭":"UY","乌兹别克斯坦":"UZ",
  "瓦努阿图":"VU","委内瑞拉":"VE","越南":"VN","西撒哈拉":"EH","也门":"YE","赞比亚":"ZM","津巴布韦":"ZW",
};

/**
 * 从任意标签提取标准两位国家代码
 * 支持 4 种格式：纯代码 (US)、中文名 (美国)、emoji 国旗 (🇺🇸)、混合 (🇺🇸 美国 LAX)
 * @param {string} label
 * @returns {string|null}
 */
function extractCountryCode(label) {
  if (!label) return null;
  const s = String(label).trim();
  if (!s) return null;

  // 运营商标签不是国家代码，提前排除
  const CARRIER_TOKENS = new Set(["CT", "CU", "CM", "CMCC", "CF", "DEF"]);

  // 1) 标准两位大写
  const tokens = s.split(/[\s,;|/_\-]+/);
  for (const tk of tokens) {
    const cleaned = tk.replace(/^[\d\s\-_.|#]+/, "").trim();
    if (/^[A-Z]{2}$/.test(cleaned) && !CARRIER_TOKENS.has(cleaned)) return cleaned;
  }
  // 2) 中文名
  for (const tk of tokens) {
    const noEmoji = tk.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "").replace(/[（()）]/g, "").replace(/\d+$/, "").trim();
    if (CN_TO_CODE[noEmoji]) return CN_TO_CODE[noEmoji];
  }
  // 3) emoji 国旗（两个 regional indicator 字符）
  const emojis = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x1F1E6 && cp <= 0x1F1FF) emojis.push(cp);
  }
  if (emojis.length >= 2) {
    const a = emojis[0] - 0x1F1E6;
    const b = emojis[1] - 0x1F1E6;
    if (a >= 0 && a < 26 && b >= 0 && b < 26) {
      return String.fromCharCode(65 + a) + String.fromCharCode(65 + b);
    }
  }
  return null;
}

/**
 * 强化版 parseLine：兼容 emoji / 中文 / 任意混合标签。
 * 老 parseLine 只认 [A-Z]{2}，新源（wtf-359/countrymerge）大量使用 emoji 国旗，必须升级。
 */
function parseLineAdaptive(line) {
  const m = line.match(/(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?(?:[#@\s]+(.*))?/);
  if (!m) return null;
  const ip = m[1];
  const port = m[2] ? +m[2] : 443;
  const tail = (m[3] || "").trim();
  let carrier = null;
  let country = null;
  if (tail) {
    // 先看 carrier 关键词
    const upper = tail.toUpperCase();
    if (/\b(CT|CHINANET|TELECOM|电信)\b/.test(upper) || /电信/.test(tail)) carrier = "CT";
    else if (/\b(CU|UNICOM|联通)\b/.test(upper) || /联通/.test(tail)) carrier = "CU";
    else if (/\b(CM|CMCC|MOBILE|移动)\b/.test(upper) || /移动/.test(tail)) carrier = "CM";
    else if (/\bCF\b/.test(upper)) carrier = "CF";
    // 再抽国家
    country = extractCountryCode(tail);
  }
  return { ip, port, carrier, country };
}

/**
 * IP 可用性二次检测 —— 来源 cfnb：调用 api.090227.xyz/check 验证 IP 真能反代
 * 只在 cfg.availabilityCheckEnabled = true 时启用，避免烧第三方配额。
 * 返回 { passed: [...], stats: { total, ok, fail } }
 */
async function applyAvailabilityFilter(ips, cfg) {
  if (!cfg.availabilityCheckEnabled || !ips.length) {
    return { passed: ips, stats: { total: ips.length, ok: ips.length, fail: 0, skipped: true } };
  }
  const concurrency = cfg.availabilityCheckConcurrency || 16;
  const timeoutMs = cfg.availabilityCheckTimeoutMs || 4000;
  const api = cfg.availabilityCheckApi || "https://api.090227.xyz/check";

  const checkOne = async (item) => {
    try {
      const u = new URL(api);
      u.searchParams.set("proxyip", `${item.ip}:${item.port || 443}`);
      const r = await withTimeout(fetch(u.toString(), { cf: { cacheTtl: 60 } }), timeoutMs);
      if (!r.ok) return { ...item, _availability: false };
      const data = await r.json().catch(() => ({}));
      const ok = data && data.success === true;
      const stack = data?.inferred_stack || null;
      return { ...item, _availability: ok, _stack: stack };
    } catch {
      return { ...item, _availability: false };
    }
  };

  const checked = await pMap(ips, checkOne, concurrency);
  const passed = checked.filter(x => x._availability);
  return {
    passed,
    stats: { total: ips.length, ok: passed.length, fail: ips.length - passed.length },
  };
}

/**
 * IP 风险等级查询 —— 来源 cfnb：调用 ipapi.is 综合打分
 * 返回 "极度纯净" / "纯净" / "轻微风险" / "高风险" / "极度危险" / "未知"
 */
const RISK_LEVELS = ["极度纯净", "纯净", "轻微风险", "高风险", "极度危险"];
async function getIpRiskLevel(ip, cfg) {
  try {
    const api = cfg.riskCheckApi || "https://api.ipapi.is/";
    const r = await withTimeout(
      fetch(`${api}?q=${encodeURIComponent(ip)}`, { cf: { cacheTtl: 86400 } }),
      cfg.riskCheckTimeoutMs || 4000
    );
    if (!r.ok) return "未知";
    const data = await r.json();
    const parseScore = (s) => {
      if (!s) return 0;
      const m = String(s).match(/([\d.]+)/);
      return m ? parseFloat(m[1]) : 0;
    };
    const companyScore = parseScore(data?.company?.abuser_score);
    const asnScore = parseScore(data?.asn?.abuser_score);
    const base = ((companyScore + asnScore) / 2) * 5;
    const flags = ["is_crawler", "is_proxy", "is_vpn", "is_tor", "is_abuser"];
    const flagCount = flags.reduce((a, k) => a + (data?.[k] ? 1 : 0), 0);
    let final = base + flagCount * 0.15;
    if (data?.is_bogon) final += 1.0;
    const pct = final * 100;
    if (pct >= 100) return "极度危险";
    if (pct >= 20)  return "高风险";
    if (pct >= 5)   return "轻微风险";
    if (pct >= 0.25) return "纯净";
    return "极度纯净";
  } catch {
    return "未知";
  }
}

/** 给定 alive 列表筛掉风险高于阈值的 IP（cap 控制扫描总量避免烧配额） */
async function applyRiskFilter(ips, cfg, cap = 60) {
  if (!cfg.dnsRiskFilterEnabled || !ips.length) return ips;
  const maxIdx = RISK_LEVELS.indexOf(cfg.dnsRiskMaxLevel);
  if (maxIdx < 0) return ips;
  const head = ips.slice(0, cap);
  const tail = ips.slice(cap);
  const scored = await pMap(head, async (x) => {
    const lvl = await getIpRiskLevel(x.ip, cfg);
    const idx = RISK_LEVELS.indexOf(lvl);
    // 未知（idx=-1）保留；不超过 max 阈值的保留
    const passes = idx < 0 || idx <= maxIdx;
    return { item: { ...x, _risk: lvl }, passes };
  }, 8);
  return scored.filter(r => r.passes).map(r => r.item).concat(tail);
}

/**
 * WxPusher 微信通知（cfnb 风格），需要 env.WXPUSHER_TOKEN + env.WXPUSHER_UIDS（逗号分隔）
 */
async function notifyWxPusher(env, content, summary, cfg) {
  if (!env.WXPUSHER_TOKEN || !env.WXPUSHER_UIDS) return;
  const uids = String(env.WXPUSHER_UIDS).split(/[,\s]+/).filter(Boolean);
  if (!uids.length) return;
  try {
    await withTimeout(fetch(cfg.wxpusherApi || "https://wxpusher.zjiecode.com/api/send/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appToken: env.WXPUSHER_TOKEN,
        content,
        summary: (summary || "cf-best-ip 通知").slice(0, 100),
        contentType: 1,
        uids,
      }),
    }), 5000);
  } catch {}
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

    if (src.type === "uouin_html") {
      // uouin 页面 IP 周围用中文标签标注 carrier
      const carrierMap = { "电信": "CT", "联通": "CU", "移动": "CM" };
      const seen = new Set();
      const re = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
      let m;
      while ((m = re.exec(body)) !== null) {
        const ip = m[0];
        if (seen.has(ip)) continue;
        seen.add(ip);
        const before = body.slice(Math.max(0, m.index - 500), m.index);
        const tags = before.match(/电信|联通|移动/g) || [];
        const last = tags[tags.length - 1];
        ips.push({ ip, port: 443, carrier: carrierMap[last] || null, sources: [src.name] });
      }
      return { name: src.name, ips };
    }

    // v2.1：新源用 emoji/中文标签，需要自适应解析
    const adaptiveSources = new Set(["countrymerge/all", "wtf-359/wtf", "zip.cm.edu.kg/all"]);
    const useAdaptive = adaptiveSources.has(src.name);

    for (const raw of body.split(/[\r\n,]+/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      if (useAdaptive) {
        // 自适应：整行解析,标签可能含 emoji/中文/空格
        const parsed = parseLineAdaptive(line);
        if (parsed) ips.push({ ...parsed, sources: [src.name] });
        continue;
      }
      const matches = line.match(/\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?:#[\w\-]+)?/g) || [];
      for (const mm of matches) {
        const parsed = parseLine(mm);
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

/** 通过 ip-api.com 批量补全 IP 的地理位置 */
async function enrichGeo(ips) {
  if (!ips.length) return ips;
  // 只查询 country 字段缺失的 IP（zip.cm.edu.kg 等源已自带国家代码）
  const needed = ips.filter(x => !x.country);
  if (!needed.length) return ips;
  const batchSize = 100;
  for (let i = 0; i < needed.length; i += batchSize) {
    const batch = needed.slice(i, i + batchSize);
    try {
      const r = await withTimeout(
        fetch("http://ip-api.com/batch?fields=status,country,countryCode,city,regionName,as,isp,query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(batch.map(x => ({ query: x.ip }))),
        }),
        12000,
      );
      if (!r.ok) continue;
      const arr = await r.json();
      const byIp = new Map();
      for (const it of arr) if (it && it.query) byIp.set(it.query, it);
      for (const item of batch) {
        const hit = byIp.get(item.ip);
        if (hit && hit.status === "success") {
          item.country = hit.countryCode || item.country;
          item.countryName = hit.country || item.countryName;
          item.region = hit.regionName || item.region;
          item.city = hit.city || item.city;
          item.asn = hit.as || item.asn;
          item.isp = hit.isp || item.isp;
        }
      }
    } catch {}
  }
  return ips;
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

  const enriched = await enrichGeo(alive);
  alive = enriched.filter(x => x.country);

  // 6b. v2.1 cfnb：可用性二次检测（默认 off,需在 /api/config 打开 availabilityCheckEnabled）
  let availabilityStats = { skipped: true, total: alive.length, ok: alive.length };
  if (cfg.availabilityCheckEnabled) {
    const r = await applyAvailabilityFilter(alive, cfg);
    alive = r.passed;
    availabilityStats = r.stats;
  }

  // 7. 持久化
  const payload = {
    ips: alive,
    sourceStats: agg.stats,
    availabilityStats,
    updatedAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
    version: VERSION,
  };
  await saveLatest(env, payload);

  // 8. DNS 同步（后台执行）
  if (env.CF_API_TOKEN && env.CF_ZONE_ID && env.CF_RECORD_NAME) {
    ctx.waitUntil(syncAllDns(env, alive).catch(() => {}));
    ctx.waitUntil(syncProbeSlots(env, alive).catch(() => {}));
  }
  // 9. Webhook
  ctx.waitUntil(notify(env, payload).catch(() => {}));
  // 9b. v2.1 cfnb：WxPusher 微信通知
  ctx.waitUntil(notifyWxPusher(
    env,
    `节点池更新完成 共 ${alive.length} 个 · 耗时 ${payload.elapsedMs}ms · 数据源 ${agg.stats.filter(s=>!s.error&&s.count>0).length}/${agg.stats.length} 健康` +
    (availabilityStats.skipped ? "" : ` · 可用性 ${availabilityStats.ok}/${availabilityStats.total}`),
    `cf-best-ip · ${alive.length} 个节点`,
    cfg
  ).catch(() => {}));
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
  const cfg = await getConfig(env);
  // v2.1 cfnb：DNS 阶段独立黑名单（与前置 countryBlocklist 区分,默认 28 国）
  let pool = alive.slice();
  if (cfg.dnsBlocklistEnabled && cfg.dnsBlocklist?.length) {
    const block = new Set(cfg.dnsBlocklist);
    pool = pool.filter(x => !x.country || !block.has(x.country));
  }
  // v2.1 cfnb：IP 风险等级过滤（默认 off,需打开 dnsRiskFilterEnabled）
  if (cfg.dnsRiskFilterEnabled) {
    pool = await applyRiskFilter(pool, cfg, Math.max(60, topN * 4));
  }
  const results = [];
  results.push(await syncRecord(env, env.CF_RECORD_NAME, pool, topN));
  if (env.CF_DNS_BY_CARRIER === "1") {
    const root = env.CF_RECORD_NAME.split(".").slice(1).join(".");
    const groups = { CT: "ct", CU: "cu", CM: "cm" };
    for (const [carrier, prefix] of Object.entries(groups)) {
      const subset = pool.filter(x => x.carrier === carrier);
      if (subset.length) results.push(await syncRecord(env, `${prefix}.${root}`, subset, topN));
    }
  }
  return results;
}

// ============================================================
// 7b. 探针子域池 —— 让任意访问者在自己网络下测真实 IP 延迟
// ============================================================
function pickDiverse(ips, n) {
  const buckets = { CT: [], CU: [], CM: [], CF: [] };
  for (const ip of ips) {
    const k = (ip.carrier === "CMCC" ? "CM" : ip.carrier) || "CF";
    if (!buckets[k]) buckets[k] = [];
    buckets[k].push(ip);
  }
  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => (b.sources?.length || 0) - (a.sources?.length || 0));
  }
  // 三网每个先来 8 个，剩下从 CF 桶补
  const out = [];
  for (const k of ["CT", "CU", "CM"]) {
    for (let i = 0; i < 8 && buckets[k].length; i++) out.push(buckets[k].shift());
  }
  while (out.length < n) {
    let added = false;
    for (const k of ["CF", "CT", "CU", "CM"]) {
      if (out.length >= n) break;
      if (buckets[k] && buckets[k].length) { out.push(buckets[k].shift()); added = true; }
    }
    if (!added) break;
  }
  return out.slice(0, n);
}

async function syncProbeSlots(env, ips, slotCount = 50, prefix = "p") {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) return { ok: false, reason: "no CF_API_TOKEN/CF_ZONE_ID" };
  const zone = env.CF_ZONE_ID;
  const rec = env.CF_RECORD_NAME || "";
  const root = rec.includes(".") ? rec.split(".").slice(1).join(".") : rec;
  if (!root) return { ok: false, reason: "cannot derive root from CF_RECORD_NAME" };

  // 1. 先构建 slots 数组并保存到 KV（不依赖 DNS 状态，前端立刻可用）
  const top = pickDiverse(ips, slotCount);
  const slots = top.map((t, i) => {
    const slot = prefix + String(i + 1).padStart(2, "0");
    return {
      slot,
      host: `${slot}.${root}`,
      ip: t.ip,
      port: t.port || 443,
      carrier: t.carrier || "CF",
      country: t.country || null,
      countryName: t.countryName || null,
      city: t.city || null,
    };
  });
  await kvSet(env, "slots:current", { slots, root, prefix, updatedAt: Date.now() });

  // 2. DNS 操作 best-effort（任何子操作失败都不影响 KV 已保存的 slots）
  const tok = env.CF_API_TOKEN;
  const auth = { Authorization: `Bearer ${tok}` };
  let created = 0, updated = 0, deleted = 0;
  const errors = [];

  try {
    const listResp = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/dns_records?type=A&per_page=500`, { headers: auth });
    const listData = await listResp.json();
    const reName = new RegExp(`^${prefix}\\d+\\.${root.replace(/\./g, "\\.")}$`);
    const curByName = {};
    for (const r of (listData.result || [])) {
      if (reName.test(r.name)) curByName[r.name] = r;
    }

    for (const s of slots) {
      const existing = curByName[s.host];
      try {
        if (existing) {
          if (existing.content !== s.ip) {
            await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/dns_records/${existing.id}`, {
              method: "PUT",
              headers: { ...auth, "content-type": "application/json" },
              body: JSON.stringify({ type: "A", name: s.host, content: s.ip, ttl: 60, proxied: false }),
            });
            updated++;
          }
          delete curByName[s.host];
        } else {
          await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/dns_records`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ type: "A", name: s.host, content: s.ip, ttl: 60, proxied: false }),
          });
          created++;
        }
      } catch (e) {
        errors.push(`${s.host}: ${e.message || e}`);
      }
    }

    // 删除剩余多余的
    for (const name in curByName) {
      try {
        await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/dns_records/${curByName[name].id}`, {
          method: "DELETE", headers: auth,
        });
        deleted++;
      } catch (e) {
        errors.push(`del ${name}: ${e.message || e}`);
      }
    }
  } catch (e) {
    errors.push(`list: ${e.message || e}`);
  }

  return { ok: true, total: slots.length, created, updated, deleted, errors };
}

// ============================================================
// 8. Webhook 通知
// ============================================================
async function notify(env, payload) {
  if (!env.TELEGRAM_BOT_TOKEN && !env.DISCORD_WEBHOOK) return;
  const ips = payload.ips || [];
  const total = ips.length;
  // 按运营商分布
  const byCarrier = {};
  for (const x of ips) { const k = x.carrier || "CF"; byCarrier[k] = (byCarrier[k] || 0) + 1; }
  // 国家 top 5
  const byCountry = {};
  for (const x of ips) { if (x.country) byCountry[x.country] = (byCountry[x.country] || 0) + 1; }
  const topCountries = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 5);
  // 槽位数
  const slots = await kvGet(env, "slots:current", { slots: [] });
  const slotCount = slots.slots?.length || 0;
  // 域名
  const root = env.CF_RECORD_NAME ? env.CF_RECORD_NAME.split(".").slice(1).join(".") : "";
  const homeUrl = root ? `https://cfip.${root}/` : "";
  const lines = [
    `🚀 *cf-best-ip 测速完成*`,
    `时间: ${new Date(payload.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    `节点池: *${total}* 个`,
    `运营商: 电信 ${byCarrier.CT || 0} · 联通 ${byCarrier.CU || 0} · 移动 ${byCarrier.CM || 0} · 通用 ${byCarrier.CF || 0}`,
    `国家 Top: ${topCountries.map(([c, n]) => `${flag(c)}${c}×${n}`).join(" ")}`,
    `探针槽位: *${slotCount}* (${root ? `p01-p${String(slotCount).padStart(2, "0")}.${root}` : "未配置"})`,
    homeUrl ? `🌐 ${homeUrl}test` : "",
  ].filter(Boolean);
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
  if (env.CF_RECORD_NAME && env.CF_RECORD_NAME.includes(".")) {
    visitor.root = env.CF_RECORD_NAME.split(".").slice(1).join(".");
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "content-type,authorization" } });
  }

  // ---- 订阅 ----
  if (path === "/sub" || path === "/sub.txt" || path === "/api/ips.txt" || path === "/ips.txt") {
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

  // ---- 真订阅：V2RayN/Shadowrocket 用的 vless:// 列表（base64） ----
  if (path === "/sub/vless" || path === "/api/sub/vless") {
    if (!checkSubToken(request, env)) return text("Forbidden", { status: 403 });
    const cfg = await getConfig(env);
    const tpl = cfg.vlessTemplate || "";
    if (!tpl.startsWith("vless://")) {
      return text(
        "尚未配置 vless 节点模板。\n" +
        "请进入 /admin 在【订阅模板】区域填一条完整的 vless:// URI（含你的 UUID/SNI/path），" +
        "本接口会用它生成 V2RayN/Sing-box 能直接订阅的 base64 节点列表。",
        { status: 412 }
      );
    }
    const list = applyFilter(ips, params, requesterColo);
    // 解析模板：vless://<uuid>@<host>:<port>?<query>#<remark>
    const tplMatch = tpl.match(/^vless:\/\/([^@]+)@([^:/?#]+)(?::(\d+))?(\?[^#]*)?(?:#(.*))?$/);
    if (!tplMatch) return text("vless 模板格式错误", { status: 400 });
    const [, uuid, , tplPort, tplQuery] = tplMatch;
    const tplPortNum = tplPort ? +tplPort : 443;
    const lines = list.map((x) => {
      const port = x.port || tplPortNum;
      const tag = [carrierName(x.carrier || "CF"), x.country || "", x.ip].filter(Boolean).join("-");
      return `vless://${uuid}@${x.ip}:${port}${tplQuery || ""}#${encodeURIComponent(tag)}`;
    });
    const out = lines.join("\n");
    const fmt = params.get("format") || "base64";
    if (fmt === "raw") return text(out);
    // base64：V2RayN 订阅要求 base64
    return text(btoa(unescape(encodeURIComponent(out))));
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

  // ---- 公开：手动刷新（60s 冷却）----
  if (path === "/api/refresh") {
    const prevRaw = await env.KV?.get("refresh:cooldown");
    const prev = prevRaw ? Number(prevRaw) : 0;
    const remain = 60 - Math.floor((Date.now() - prev) / 1000);
    if (remain > 0) {
      return json({ ok: false, error: "rate-limited", retryAfter: remain, hint: `请 ${remain} 秒后再试` }, { status: 429 });
    }
    await env.KV?.put("refresh:cooldown", String(Date.now()), { expirationTtl: 120 });
    const result = await runFullTest(env, ctx);
    return json({ ok: true, count: result.ips.length, elapsedMs: result.elapsedMs, sourceStats: result.sourceStats });
  }

  // ---- 管理：DNS 手动同步 ----
  if (path === "/api/dns/sync") {
    if (!checkAdmin(request, env)) return unauthorized();
    const data = await getLatest(env);
    const ips = data.ips || [];
    const result = await syncAllDns(env, ips);
    return json({ ok: true, result });
  }
  if (path === "/api/dns/current") {
    if (!env.CF_API_TOKEN || !env.CF_ZONE_ID || !env.CF_RECORD_NAME) {
      return json({ ok: false, error: "DNS sync not configured" });
    }
    const root = env.CF_RECORD_NAME.split(".").slice(1).join(".");
    const main = env.CF_RECORD_NAME;
    const names = [main, `ct.${root}`, `cu.${root}`, `cm.${root}`];
    const result = [];
    for (const n of names) {
      try {
        const recs = await listRecords(env, n);
        result.push({ name: n, records: recs.map(r => r.content) });
      } catch (e) {
        result.push({ name: n, records: [], error: String(e).slice(0, 80) });
      }
    }
    return json({ ok: true, dns: result });
  }
  if (path === "/api/probe-slots") {
    const cur = await kvGet(env, "slots:current", { slots: [], updatedAt: 0 });
    return json({ ok: true, ...cur });
  }
  if (path === "/api/sync-slots" && request.method === "POST") {
    if (!checkAdmin(request, env)) return unauthorized();
    const data = await getLatest(env);
    const result = await syncProbeSlots(env, data.ips || []);
    return json(result);
  }
  if (path === "/api/cache/clear" && request.method === "POST") {
    if (!checkAdmin(request, env)) return unauthorized();
    await kvSet(env, "ips:latest", { ips: [], sourceStats: [], updatedAt: 0 });
    return json({ ok: true });
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
  <h2>🌍 在你当前网络下优选 Top IP（专属于你的网络）</h2>
  <p class="mut" style="font-size:12px;line-height:1.6;margin:0 0 10px">
    浏览器并发对 <b>50 个不同的真实 CF IP</b>（藏在 <code>p01-p50.${visitor.root || 'leilaomi.cc.cd'}</code> 这些子域里）测 TLS 握手延迟，<b style="color:var(--warn)">关代理后再开始最准</b>。
    结果只反映你的网络，刷新一次自动同步一次。
  </p>
  <div class="row" style="margin-bottom:10px;gap:6px;flex-wrap:wrap">
    <select id="probeKeep" style="min-width:90px"><option value="10">保留 Top 10</option><option value="20">保留 Top 20</option><option value="30">保留 Top 30</option><option value="50">全部 50</option></select>
    <select id="probeReps" style="min-width:90px"><option value="3">每 IP 测 3 次</option><option value="5" selected>每 IP 测 5 次</option><option value="8">每 IP 测 8 次</option></select>
    <button class="btn" id="btnProbe">▶ 开始优选</button>
    <span class="mut" id="probeStatus" style="font-size:11px"></span>
  </div>
  <div id="probeResult" class="mut" style="font-size:12px">点 "▶ 开始优选" 后这里出现你专属的 Top IP 列表</div>
  <div class="row" id="probeActions" style="margin-top:10px;display:none;gap:6px">
    <button class="btn sm ghost" id="copyTop">复制 IP 列表 (txt)</button>
    <button class="btn sm ghost" id="dlTop">下载 best-for-me.txt</button>
  </div>
  <details style="margin-top:12px"><summary class="mut" style="font-size:11px;cursor:pointer">🔧 站长域名套测试（cf./ct./cu./cm.${visitor.root || 'leilaomi.cc.cd'}）</summary>
    <div class="row" style="margin-top:10px;gap:6px">
      <input id="customHost" placeholder="可选：自定义域名一起测" style="flex:1;min-width:160px"/>
      <button class="btn sm" id="btnLocalCarrier">测 4 个套</button>
      <span class="mut" id="localStatus" style="font-size:11px"></span>
    </div>
    <div id="localRes" style="font-size:12px;line-height:1.8;margin-top:8px" class="mut"></div>
  </details>
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

// ===== 浏览器优选探针 —— 在用户网络下测真实 IP 延迟 =====
async function _probeOne(host, n = 5, timeoutMs = 4000) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = performance.now();
    try {
      await fetch('https://' + host + '/cdn-cgi/trace?_=' + Math.random(), { cache: 'no-store', signal: ctrl.signal, mode: 'no-cors' });
      samples.push(performance.now() - t0);
    } catch (e) {
      samples.push(null);
    }
    clearTimeout(timer);
  }
  const ok = samples.filter(x => x != null);
  return {
    samples,
    min: ok.length ? Math.round(Math.min(...ok)) : null,
    avg: ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null,
    loss: 1 - ok.length / n,
  };
}

let _slots = [];
let _probeResults = [];

async function _loadSlots() {
  try {
    const r = await fetch('/api/probe-slots').then(r => r.json());
    _slots = r.slots || [];
    return _slots.length;
  } catch (e) { return 0; }
}

function _ipDelayColor(ms) {
  if (ms == null) return '#8b949e';
  if (ms < 80) return '#7ee787';
  if (ms < 200) return '#d8af3c';
  return '#ff7b72';
}

function _carrierTag(c) {
  const m = { CT: '电信', CU: '联通', CM: '移动', CMCC: '移动', CF: '通用' };
  const cls = (c || 'cf').toLowerCase();
  return '<span class="tag ' + cls + '">' + (m[c] || '通用') + '</span>';
}

function _renderProbeResults(results, keep) {
  const top = results.slice(0, keep);
  const html = top.map((r, i) => {
    const color = _ipDelayColor(r.avg);
    const sign = r.avg == null ? '不通' : (r.avg + 'ms');
    const flag = ({HK:'🇭🇰',JP:'🇯🇵',KR:'🇰🇷',TW:'🇹🇼',SG:'🇸🇬',US:'🇺🇸',CA:'🇨🇦',GB:'🇬🇧',DE:'🇩🇪',FR:'🇫🇷',NL:'🇳🇱',AU:'🇦🇺',RU:'🇷🇺',IN:'🇮🇳',CN:'🇨🇳',TH:'🇹🇭',MY:'🇲🇾',HU:'🇭🇺',IT:'🇮🇹',CH:'🇨🇭'}[r.country]) || '🌐';
    return '<div style="display:grid;grid-template-columns:30px 1fr auto;gap:8px;align-items:center;padding:8px;border:1px solid var(--bd);border-radius:6px;margin-bottom:4px"><div class="mut" style="font-size:11px">#' + (i+1) + '</div><div><div style="font-family:monospace;font-size:13px"><b>' + r.ip + '</b>:' + (r.port||443) + '</div><div style="font-size:11px;color:var(--mut);margin-top:2px">' + _carrierTag(r.carrier) + ' ' + flag + ' ' + (r.country||'') + (r.city?' · '+r.city:'') + '</div></div><div style="text-align:right"><b style="color:' + color + ';font-size:14px">' + sign + '</b><br/><button class="copybtn" data-cp="' + r.ip + '" style="margin-top:4px">复制</button></div></div>';
  }).join('');
  document.getElementById('probeResult').innerHTML = html;
  document.querySelectorAll('[data-cp]').forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.cp); b.textContent = '✓'; setTimeout(()=>b.textContent='复制', 1500); }
    catch(e) { prompt('复制', b.dataset.cp); }
  });
}

const _btnProbe = document.getElementById('btnProbe');
if (_btnProbe) {
  _btnProbe.onclick = async () => {
    _btnProbe.disabled = true;
    const st = document.getElementById('probeStatus');
    const keep = +document.getElementById('probeKeep').value;
    const reps = +document.getElementById('probeReps').value;
    if (!_slots.length) {
      st.textContent = '⏳ 加载探针槽…';
      await _loadSlots();
    }
    if (!_slots.length) {
      document.getElementById('probeResult').innerHTML = '<span style="color:#ff7b72">探针槽尚未生成。请管理员先去 /admin 点"立即抓取"刷新一次（会自动创建子域槽）</span>';
      _btnProbe.disabled = false;
      return;
    }
    st.textContent = '⏳ 0 / ' + _slots.length;
    document.getElementById('probeResult').innerHTML = '<div class="mut">测试中…</div>';
    let done = 0;
    const concurrency = 8;
    const queue = [..._slots];
    const results = [];
    async function worker() {
      while (queue.length) {
        const s = queue.shift();
        const r = await _probeOne(s.host, reps);
        results.push({ ...s, ...r });
        done++;
        st.textContent = '⏳ ' + done + ' / ' + _slots.length;
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, _slots.length) }, worker));
    results.sort((a, b) => (a.avg == null ? 99999 : a.avg) - (b.avg == null ? 99999 : b.avg));
    _probeResults = results;
    _renderProbeResults(results, keep);
    const best = results.find(r => r.avg != null);
    st.textContent = best ? ('✅ 完成 · 你的最快: ' + best.ip + ' (' + best.avg + 'ms · ' + (best.carrier||'CF') + ')') : '⚠️ 全部不通，可能在墙后或正在用代理';
    document.getElementById('probeActions').style.display = 'flex';
    _btnProbe.disabled = false;
  };
}

document.getElementById('copyTop')?.addEventListener('click', async () => {
  const keep = +document.getElementById('probeKeep').value;
  const txt = _probeResults.slice(0, keep).filter(r => r.avg != null).map(r => r.ip + ':' + (r.port||443) + '#' + (r.carrier||'CF') + '-' + r.avg + 'ms').join('\\n');
  try { await navigator.clipboard.writeText(txt); document.getElementById('probeStatus').textContent = '已复制 ' + txt.split('\\n').length + ' 个'; }
  catch(e) { prompt('复制', txt); }
});

document.getElementById('dlTop')?.addEventListener('click', () => {
  const keep = +document.getElementById('probeKeep').value;
  const txt = _probeResults.slice(0, keep).filter(r => r.avg != null).map(r => r.ip + ':' + (r.port||443) + '#' + (r.carrier||'CF') + '-' + r.avg + 'ms').join('\\n');
  const blob = new Blob([txt], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'best-for-me.txt';
  a.click();
});

// 旧的 cf./ct./cu./cm. 4 个套测试 - 站长域名调试用
function _defaultCarrierHosts() {
  const h = location.hostname;
  const parts = h.split('.');
  if (parts.length < 2) return [];
  const root = parts.slice(1).join('.');
  return [
    { tag: '通用 cf.', host: 'cf.' + root },
    { tag: '电信 ct.', host: 'ct.' + root },
    { tag: '联通 cu.', host: 'cu.' + root },
    { tag: '移动 cm.', host: 'cm.' + root },
  ];
}

const _btnLocalCarrier = document.getElementById('btnLocalCarrier');
if (_btnLocalCarrier) {
  _btnLocalCarrier.onclick = async () => {
    _btnLocalCarrier.disabled = true;
    const st = document.getElementById('localStatus');
    const res = document.getElementById('localRes');
    res.innerHTML = '<div class="mut">⏳ 测试中…</div>';
    const targets = _defaultCarrierHosts();
    const custom = (document.getElementById('customHost').value || '').trim();
    if (custom) targets.push({ tag: '自定义', host: custom });
    st.textContent = '测试 ' + targets.length + ' 个域…';
    const results = await Promise.all(targets.map(t => _probeOne(t.host).then(r => ({ ...t, ...r }))));
    results.sort((a, b) => (a.avg == null ? 99999 : a.avg) - (b.avg == null ? 99999 : b.avg));
    res.innerHTML = results.map(r => {
      const c = _ipDelayColor(r.avg);
      const lossPct = Math.round(r.loss * 100);
      const sign = r.avg == null ? '✗ 不通' : ('✓ 平均 ' + r.avg + 'ms · 最低 ' + r.min + 'ms');
      const tail = lossPct > 0 ? ' · 丢包 ' + lossPct + '%' : '';
      return '<div style="display:flex;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px solid #21262d"><span><b>' + r.tag + '</b> ' + r.host + '</span><b style="color:' + c + ';white-space:nowrap">' + sign + tail + '</b></div>';
    }).join('');
    const best = results.find(r => r.avg != null);
    st.textContent = best ? '✅ 你这网络下最快: ' + best.host + ' (' + best.avg + 'ms)' : '⚠️ 全部不通';
    _btnLocalCarrier.disabled = false;
  };
}

// 启动时预拉 slots
_loadSlots().then(n => {
  if (!n) document.getElementById('probeResult').innerHTML = '<span class="mut">探针槽尚未生成。管理员去 /admin 点"立即抓取"会自动创建 50 个 p01-p50 子域槽</span>';
});
</script>`);
}

function renderAdmin() {
  return layout("管理 · cf-best-ip", `
<div class="card" id="kpi">
  <div class="kpis">
    <div class="kpi"><div class="kpi-label">节点池</div><div class="kpi-value" id="kTotal">—</div></div>
    <div class="kpi"><div class="kpi-label">最后更新</div><div class="kpi-value" id="kUpdated" style="font-size:14px">—</div></div>
    <div class="kpi"><div class="kpi-label">下次 Cron</div><div class="kpi-value" id="kCron" style="font-size:14px">—</div></div>
    <div class="kpi"><div class="kpi-label">数据源</div><div class="kpi-value" id="kSrc">—</div></div>
  </div>
</div>

<div class="card">
  <h2>📊 运营商分布</h2>
  <div id="bars" class="mut" style="font-size:12px">加载中…</div>
</div>

<div class="card">
  <div class="row" style="justify-content:space-between"><h2 style="margin:0">📡 DNS 实时状态</h2>
    <div class="row" style="gap:6px">
      <button class="btn sm" id="syncdns">同步 DNS</button>
      <button class="btn sm ghost" id="reloadDns">刷新</button>
    </div></div>
  <div id="dnsList" class="mut" style="font-size:12px;margin-top:10px">加载中…</div>
  <span class="mut" id="dnsMsg" style="font-size:11px"></span>
</div>

<div class="card">
  <div class="row" style="justify-content:space-between"><h2 style="margin:0">📥 数据源健康</h2>
    <button class="btn sm ghost" id="refreshNow">立即抓取并测速</button></div>
  <div id="srcList" style="font-size:12px;margin-top:10px">加载中…</div>
  <span class="mut" id="refreshMsg" style="font-size:11px"></span>
</div>

<div class="card">
  <h2>🔗 订阅链接生成器</h2>
  <div class="row">
    <select id="gCarrier"><option value="">全部运营商</option><option value="CT">电信</option><option value="CU">联通</option><option value="CM">移动</option><option value="CF">通用</option></select>
    <select id="gCountry"><option value="">全部国家</option></select>
    <select id="gTop"><option>5</option><option>10</option><option selected>20</option><option>50</option><option>100</option></select>
    <select id="gFmt"><option value="/sub">纯文本</option><option value="/api/v2ray">V2Ray base64</option><option value="/api/clash">Clash YAML</option><option value="/api/preferred-ips">EdgeTunnel</option><option value="/api/ips">JSON</option></select>
    <label class="row" style="gap:4px;font-size:12px"><input type="checkbox" id="gSmart"/> 智能就近</label>
  </div>
  <div style="margin-top:10px;padding:10px;background:#0a0d12;border:1px solid var(--bd);border-radius:6px;font-family:monospace;font-size:12px;word-break:break-all" id="genUrl">—</div>
  <div class="row" style="margin-top:8px">
    <button class="btn sm" id="copyUrl">复制</button>
    <button class="btn sm ghost" id="testUrl">在新标签打开</button>
    <span class="mut" id="genMsg" style="font-size:11px"></span>
  </div>
</div>

<div class="card">
  <h2>📋 节点列表</h2>
  <div class="row" style="gap:8px;margin-bottom:10px">
    <input id="nSearch" placeholder="搜 IP / 端口 / 国家 / 来源…" style="flex:1;min-width:180px"/>
    <select id="nCarrier"><option value="">全部</option><option value="CT">电信</option><option value="CU">联通</option><option value="CM">移动</option><option value="CF">通用</option></select>
    <select id="nLimit"><option>20</option><option selected>50</option><option>100</option><option>500</option></select>
  </div>
  <div id="nodeTable" style="font-size:12px;max-height:520px;overflow:auto">加载中…</div>
</div>

<div class="card">
  <h2>➕ 手动添加 IP / CIDR 扫描</h2>
  <textarea id="manual" rows="3" style="width:100%" placeholder="一行一个，支持 1.2.3.4 / 1.2.3.4:443 / 1.2.3.4:443#CT"></textarea>
  <div class="row" style="margin-top:8px"><button class="btn sm" id="add">添加</button><button class="btn sm ghost" id="loadm">查看已添加</button></div>
  <pre id="manualList" class="mut" style="font-size:11px;max-height:120px;overflow:auto;margin-top:8px"></pre>
  <hr style="border:0;border-top:1px solid var(--bd);margin:14px 0"/>
  <div class="row"><input id="cidr" placeholder="173.245.48.0/26" style="flex:1;min-width:160px"/><input id="cport" value="443" style="width:80px"/><button class="btn sm" id="scan">扫描</button></div>
  <pre id="scanRes" class="mut" style="font-size:12px;max-height:160px;overflow:auto;margin-top:8px"></pre>
</div>

<div class="card">
  <h2>🔑 V2Ray / Sing-box 真订阅模板</h2>
  <p class="mut" style="font-size:12px;line-height:1.6;margin:0 0 8px">
    粘贴一条<b>完整的 vless:// 节点 URI</b>（含你 UUID/SNI/path），Worker 会用候选 IP 自动替换 host:port 字段，生成 V2RayN/Sing-box 直接订阅的 base64 节点列表。<br/>
    示例：<code>vless://uuid@a.example.com:443?type=ws&security=tls&sni=a.example.com&host=a.example.com&path=%2F&encryption=none#sample</code>
  </p>
  <textarea id="vlessTpl" rows="3" placeholder="vless://uuid@host:443?type=ws&security=tls&sni=..." style="width:100%;font-family:monospace;font-size:11px"></textarea>
  <div class="row" style="margin-top:8px"><button class="btn sm" id="saveVless">保存模板</button><span class="mut" id="vlessMsg" style="font-size:11px"></span></div>
  <div class="mut" style="margin-top:10px;font-size:12px">
    订阅地址（粘到 V2RayN / Sing-box / Shadowrocket）：<br/>
    <code id="vlessSubUrl"></code>
  </div>
</div>

<div class="card">
  <h2>⚙️ 配置</h2>
  <div class="row" style="flex-direction:column;align-items:stretch;gap:8px">
    <label class="row" style="gap:8px;align-items:center"><span style="width:140px;font-size:13px">每次返回数量 topN</span><input id="cTopN" type="number" min="1" max="200" style="width:100px"/></label>
    <label class="row" style="gap:8px;align-items:center"><span style="width:140px;font-size:13px">自动刷新间隔（小时）</span><input id="cRefresh" type="number" min="1" max="48" style="width:100px"/></label>
    <label class="row" style="gap:8px;align-items:center"><span style="width:140px;font-size:13px">屏蔽国家 (逗号)</span><input id="cBlock" placeholder="CN,IR" style="flex:1;min-width:120px"/></label>
    <label class="row" style="gap:8px;align-items:center"><span style="width:140px;font-size:13px">端口列表 (逗号)</span><input id="cPorts" placeholder="443,2053" style="flex:1;min-width:120px"/></label>
  </div>
  <div class="row" style="margin-top:10px"><button class="btn sm" id="saveCfg">保存配置</button><span class="mut" id="cfgMsg" style="font-size:11px"></span></div>
  <details style="margin-top:12px"><summary class="mut" style="font-size:11px;cursor:pointer">高级：JSON 编辑器</summary>
    <textarea id="cfgEdit" rows="6" style="width:100%;margin-top:8px;font-family:monospace;font-size:11px"></textarea>
    <button class="btn sm ghost" id="saveCfgRaw" style="margin-top:8px">保存原始 JSON</button>
  </details>
</div>

<div class="card" style="border-color:#5a2a2a">
  <details>
    <summary style="cursor:pointer;color:#f85149">⚠️ 危险操作</summary>
    <div style="margin-top:10px">
      <button class="btn sm" id="clearCache" style="background:#3a1212;border:1px solid #5a2a2a;color:#f85149">清空 KV 缓存（节点池清零，下次 Cron 重新填）</button>
    </div>
  </details>
</div>

<style>
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.kpi{padding:10px 12px;background:#0a0d12;border:1px solid var(--bd);border-radius:8px}
.kpi-label{font-size:11px;color:var(--mut);margin-bottom:4px}
.kpi-value{font-size:22px;font-weight:600;color:var(--fg)}
.bar-row{display:grid;grid-template-columns:60px 1fr 50px;gap:10px;align-items:center;margin:4px 0}
.bar-bg{height:14px;background:#0a0d12;border:1px solid var(--bd);border-radius:7px;overflow:hidden}
.bar-fill{height:100%;border-radius:7px;transition:width .3s}
.dns-block{padding:10px;background:#0a0d12;border:1px solid var(--bd);border-radius:6px;margin-bottom:8px}
.dns-name{display:flex;justify-content:space-between;align-items:center}
.dns-ips{font-family:monospace;font-size:11px;color:var(--mut);margin-top:6px;line-height:1.6;word-break:break-all}
.src-row{display:grid;grid-template-columns:1fr 50px;gap:6px;padding:6px 8px;border-bottom:1px solid #1a1f26;align-items:center}
.src-row:last-child{border-bottom:0}
.src-bad{color:#f85149}
.src-ok{color:var(--ok,#7ee787)}
.ntbl{width:100%;border-collapse:collapse;font-size:11px}
.ntbl th,.ntbl td{padding:5px 6px;text-align:left;border-bottom:1px solid #1a1f26}
.ntbl th{background:#0a0d12;font-weight:500;color:var(--mut);position:sticky;top:0}
.ntbl td.ip{font-family:monospace}
</style>

<script>
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const CARRIER_LABEL = {CT:'电信',CU:'联通',CM:'移动',CMCC:'移动',CF:'通用'};
const CARRIER_COLOR = {CT:'#7ee787',CU:'#a78bfa',CM:'#79b8ff',CMCC:'#79b8ff',CF:'#f9826c'};
const FLAGS = {HK:'🇭🇰',JP:'🇯🇵',KR:'🇰🇷',TW:'🇹🇼',SG:'🇸🇬',US:'🇺🇸',CA:'🇨🇦',GB:'🇬🇧',DE:'🇩🇪',FR:'🇫🇷',NL:'🇳🇱',AU:'🇦🇺',RU:'🇷🇺',IN:'🇮🇳',CN:'🇨🇳'};

function flash(el, msg, ok=true){el.textContent=msg;el.style.color=ok?'var(--ok,#7ee787)':'#f85149';setTimeout(()=>{el.textContent='';el.style.color=''},4000)}

async function loadStats(){
  const s = await fetch('/api/stats').then(r=>r.json());
  $('#kTotal').textContent = s.total;
  $('#kUpdated').textContent = s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}).slice(5) : '—';
  // 下次 Cron：每 6 小时整 (0,6,12,18 UTC)
  const now = new Date();
  const utcH = now.getUTCHours();
  const nextH = Math.ceil((utcH+0.001)/6)*6 % 24;
  const next = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+(nextH===0&&utcH>=18?1:0), nextH, 0, 0));
  const mins = Math.round((next - now)/60000);
  $('#kCron').textContent = (mins>60?Math.floor(mins/60)+'h':'')+(mins%60)+'m 后';
  const okCount = (s.sourceStats||[]).filter(x=>!x.error && x.count>0).length;
  const totalSrc = (s.sourceStats||[]).length;
  $('#kSrc').textContent = okCount+'/'+totalSrc;
  // 运营商分布
  const carriers = ['CT','CU','CM','CF'];
  const max = Math.max(...carriers.map(c=>(s.byCarrier.find(x=>x.key===c)||{count:0}).count), 1);
  $('#bars').innerHTML = carriers.map(c=>{
    const n = (s.byCarrier.find(x=>x.key===c)||{count:0}).count;
    const w = Math.max(2, Math.round(n/max*100));
    return '<div class="bar-row"><span>'+CARRIER_LABEL[c]+'</span><div class="bar-bg"><div class="bar-fill" style="width:'+w+'%;background:'+CARRIER_COLOR[c]+'"></div></div><b>'+n+'</b></div>';
  }).join('');
  // 数据源健康
  $('#srcList').innerHTML = (s.sourceStats||[]).map(x=>{
    const cls = (x.error || !x.count) ? 'src-bad' : 'src-ok';
    const sign = (x.error || !x.count) ? '✗' : '✓';
    return '<div class="src-row"><div><span class="'+cls+'">'+sign+'</span> '+x.name+(x.error?' <span class="mut" style="font-size:10px">('+x.error+')</span>':'')+'</div><b>'+(x.count||0)+'</b></div>';
  }).join('') || '<div class="mut">无数据</div>';
  // 填充国家下拉
  const cs = (s.byCountry||[]).filter(x=>x.key && x.key!=='?');
  $('#gCountry').innerHTML = '<option value="">全部国家</option>' + cs.map(c=>'<option value="'+c.key+'">'+(FLAGS[c.key]||'🌐')+' '+c.key+' ('+c.count+')</option>').join('');
  return s;
}

async function loadDns(){
  const r = await fetch('/api/dns/current').then(r=>r.json());
  if (!r.ok) { $('#dnsList').innerHTML = '<span class="mut">DNS 未配置：需要在环境变量里设置 CF_API_TOKEN / CF_ZONE_ID / CF_RECORD_NAME</span>'; return; }
  $('#dnsList').innerHTML = (r.dns||[]).map(d=>{
    const records = d.records && d.records.length ? d.records : (d.error ? ['<span class="src-bad">'+d.error+'</span>'] : ['<span class="mut">尚无记录</span>']);
    return '<details class="dns-block"><summary class="dns-name"><b>'+d.name+'</b><span class="mut">'+(d.records||[]).length+' 条 A 记录</span></summary><div class="dns-ips">'+records.join(' · ')+'</div></details>';
  }).join('') || '<span class="mut">无</span>';
}

async function loadNodes(){
  const lim = $('#nLimit').value || 50;
  const r = await fetch('/api/ips?top='+lim).then(r=>r.json());
  const q = ($('#nSearch').value||'').toLowerCase();
  const carrier = $('#nCarrier').value;
  let list = r.ips || [];
  if (carrier) list = list.filter(x=>(x.carrier||'CF')===carrier);
  if (q) list = list.filter(x=>JSON.stringify(x).toLowerCase().includes(q));
  if (!list.length) { $('#nodeTable').innerHTML = '<div class="mut" style="padding:14px;text-align:center">无匹配</div>'; return; }
  $('#nodeTable').innerHTML =
    '<table class="ntbl"><thead><tr><th>#</th><th>IP</th><th>端口</th><th>运营商</th><th>国家</th><th>来源</th><th></th></tr></thead><tbody>' +
    list.map((x,i)=>{
      const isManual = (x.sources||[]).includes('manual');
      return '<tr><td>'+(i+1)+'</td><td class="ip">'+x.ip+'</td><td>'+x.port+'</td><td>'+CARRIER_LABEL[x.carrier||'CF']+'</td><td>'+(FLAGS[x.country]||'🌐')+' '+(x.country||'-')+'</td><td>'+((x.sources||[]).length||0)+'</td><td>'+
        (isManual?'<button class="copybtn" data-del="'+x.ip+'">删</button>':'')+
        '</td></tr>';
    }).join('') + '</tbody></table>';
  $$('[data-del]').forEach(b=>b.onclick=async()=>{
    if(!confirm('删除手动添加的 '+b.dataset.del+'?')) return;
    await fetch('/api/manual?ip='+encodeURIComponent(b.dataset.del),{method:'DELETE'});
    loadNodes();
  });
}

function buildUrl(){
  const path = $('#gFmt').value;
  const p = new URLSearchParams();
  if ($('#gCarrier').value) p.set('carrier', $('#gCarrier').value);
  if ($('#gCountry').value) p.set('country', $('#gCountry').value);
  if ($('#gTop').value) p.set('top', $('#gTop').value);
  if ($('#gSmart').checked) p.set('smart', '1');
  const url = location.origin + path + (p.toString()?'?'+p.toString():'');
  $('#genUrl').textContent = url;
}

['gCarrier','gCountry','gTop','gFmt','gSmart'].forEach(id=>$('#'+id).addEventListener('change', buildUrl));

$('#copyUrl').onclick = async ()=>{
  const u = $('#genUrl').textContent;
  try { await navigator.clipboard.writeText(u); flash($('#genMsg'),'已复制'); }
  catch(e){ prompt('复制此链接', u); }
};
$('#testUrl').onclick = ()=> window.open($('#genUrl').textContent, '_blank');

$('#syncdns').onclick = async ()=>{
  $('#syncdns').disabled = true;
  flash($('#dnsMsg'), '同步中…');
  const r = await fetch('/api/dns/sync').then(r=>r.json()).catch(e=>({error:e}));
  flash($('#dnsMsg'), r.ok?'同步完成':'失败: '+JSON.stringify(r), r.ok);
  $('#syncdns').disabled = false;
  await loadDns();
};
$('#reloadDns').onclick = loadDns;

$('#refreshNow').onclick = async ()=>{
  $('#refreshNow').disabled = true;
  flash($('#refreshMsg'), '抓取测速中…可能需 20-40 秒');
  const r = await fetch('/api/refresh').then(r=>r.json());
  flash($('#refreshMsg'), r.ok ? ('完成：'+r.count+' 节点 · '+r.elapsedMs+'ms') : ('失败: '+(r.error||'unknown')), r.ok);
  $('#refreshNow').disabled = false;
  await Promise.all([loadStats(), loadNodes()]);
};

['nSearch','nCarrier','nLimit'].forEach(id=>$('#'+id).addEventListener('input', loadNodes));

$('#add').onclick = async ()=>{
  const r = await fetch('/api/manual',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lines:$('#manual').value})}).then(r=>r.json());
  alert('已添加，当前手动节点 '+r.count);
  $('#manual').value=''; loadNodes();
};
$('#loadm').onclick = async ()=>{
  const r = await fetch('/api/manual').then(r=>r.json());
  $('#manualList').textContent = JSON.stringify(r, null, 2);
};
$('#scan').onclick = async ()=>{
  $('#scan').disabled = true;
  $('#scanRes').textContent = '扫描中…';
  const r = await fetch('/api/cidr-scan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cidr:$('#cidr').value,port:+$('#cport').value})}).then(r=>r.json());
  $('#scanRes').textContent = JSON.stringify(r.ips, null, 2);
  $('#scan').disabled = false;
};

// 配置面板
async function loadCfg(){
  const c = await fetch('/api/config').then(r=>r.json());
  $('#cTopN').value = c.topN ?? 30;
  $('#cRefresh').value = c.refreshHours ?? 6;
  $('#cBlock').value = (c.countryBlocklist||[]).join(',');
  $('#cPorts').value = (c.ports||[443]).join(',');
  $('#cfgEdit').value = JSON.stringify(c, null, 2);
  if ($('#vlessTpl')) $('#vlessTpl').value = c.vlessTemplate || '';
  if ($('#vlessSubUrl')) $('#vlessSubUrl').textContent = location.origin + '/sub/vless?top=30';
}
$('#saveCfg').onclick = async ()=>{
  const body = {
    topN: +$('#cTopN').value || 30,
    refreshHours: +$('#cRefresh').value || 6,
    countryBlocklist: $('#cBlock').value.split(',').map(s=>s.trim()).filter(Boolean),
    ports: $('#cPorts').value.split(',').map(s=>+s.trim()).filter(Boolean),
  };
  await fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  flash($('#cfgMsg'), '已保存');
};
$('#saveCfgRaw').onclick = async ()=>{
  try {
    const body = JSON.parse($('#cfgEdit').value);
    await fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    flash($('#cfgMsg'), '已保存 JSON');
    loadCfg();
  } catch(e) { flash($('#cfgMsg'), '解析失败: '+e.message, false); }
};

// 危险操作
$('#clearCache').onclick = async ()=>{
  if (!confirm('确认清空 KV 节点池？下次 Cron 自动刷新（最长 6 小时后），或点"立即抓取"立刻填充')) return;
  await fetch('/api/cache/clear',{method:'POST'});
  alert('已清空');
  loadStats(); loadNodes();
};

$('#saveVless') && ($('#saveVless').onclick = async () => {
  await fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({vlessTemplate: $('#vlessTpl').value.trim()})});
  flash($('#vlessMsg'), '已保存模板，订阅地址立即生效');
});

(async ()=>{
  await loadStats();
  await Promise.all([loadDns(), loadNodes(), loadCfg()]);
  buildUrl();
})();
</script>`);
}