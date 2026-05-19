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
 *    CF_API_TOKEN      可选，同步 DNS 的 Cloudflare API Token (Zone:DNS:Edit)
 *    CF_ZONE_ID        可选，目标域名 Zone ID
 *    CF_RECORD_NAME    可选，主 A 记录名，例如 cf.example.com
 *    CF_DNS_BY_CARRIER 可选，"1" 启用按运营商分别同步 (ct./cu./cm. 前缀)
 *    DNS_TOP_N         可选，DNS 同步取前 N 个 IP，默认 10
 *    TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID  可选，Cron 完成后推送通知
 *
 *  KV 绑定：变量名固定 KV
 */

import { connect } from "cloudflare:sockets";

// ============================================================
// 1. 常量 / 数据源 / 字典
// ============================================================
const VERSION = "3.0.0";

// ===== v2.3: Cloudflare 公开 IPv4 anycast CIDR (官方 ips-v4) =====
// 用 IP 段精确判定 cf-native vs cf-proxy,不再依赖 source 元数据
// 来源: https://www.cloudflare.com/ips-v4
const CF_IPV4_CIDRS = [
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

// 预编译为 [network, mask] 整数对，方便 O(1) 段查
const CF_RANGES = CF_IPV4_CIDRS.map(c => {
  const [base, bits] = c.split("/");
  const m = base.split(".").map(Number);
  const baseInt = ((m[0] << 24) | (m[1] << 16) | (m[2] << 8) | m[3]) >>> 0;
  const bitsN = +bits;
  const mask = bitsN === 0 ? 0 : (0xffffffff << (32 - bitsN)) >>> 0;
  return [baseInt & mask, mask];
});

function ipToInt(ip) {
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

function isCfNativeIp(ip) {
  const v = ipToInt(ip);
  if (v == null) return false;
  for (const [net, mask] of CF_RANGES) {
    if ((v & mask) === net) return true;
  }
  return false;
}

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
};

const SOURCES = [
  // ===== v2.4 hostmonit (uouin.com / ipdb.030101.xyz 同款源):带真实延迟/丢包/速度 =====
  {
    name: "hostmonit/三网实测",
    url: "https://api.hostmonit.com/get_optimization_ip",
    type: "hostmonit_json",
    method: "POST",
    body: { key: "o1zrmHAF" },
    category: "cf-native",
  },
  // ===== v2.6 社区高星 CF native 源(纯 CF 段,大幅提升 cf-native 数量) =====
  { name: "joname1/BestCFip",           url: "https://raw.githubusercontent.com/joname1/BestCFip/main/ipv4.txt", type: "text", category: "cf-native" },
  { name: "KafeMars/cloudflare_ips",    url: "https://raw.githubusercontent.com/KafeMars/best-ips-domains/main/cloudflare_ips.txt", type: "text", category: "cf-native" },
  { name: "KafeMars/US_IP4",            url: "https://raw.githubusercontent.com/KafeMars/best-ips-domains/main/US_IP4", type: "text", category: "cf-native" },
  { name: "KafeMars/HK_IP4",            url: "https://raw.githubusercontent.com/KafeMars/best-ips-domains/main/HK_IP4", type: "text", category: "cf-native" },
  { name: "KafeMars/JP_IP4",            url: "https://raw.githubusercontent.com/KafeMars/best-ips-domains/main/JP_IP4", type: "text", category: "cf-native" },
  { name: "KafeMars/SG_IP4",            url: "https://raw.githubusercontent.com/KafeMars/best-ips-domains/main/SG_IP4", type: "text", category: "cf-native" },
  { name: "KafeMars/EU_IP4",            url: "https://raw.githubusercontent.com/KafeMars/best-ips-domains/main/EU_IP4", type: "text", category: "cf-native" },
  { name: "addressesapi/ip.164746.xyz", url: "https://addressesapi.090227.xyz/ip.164746.xyz", type: "carrier", category: "cf-native" },
  { name: "addressesapi/CloudFlareYes", url: "https://addressesapi.090227.xyz/CloudFlareYes", type: "carrier", category: "cf-native" },
  { name: "addressesapi/cmcc",          url: "https://addressesapi.090227.xyz/cmcc", type: "carrier", category: "cf-native" },
  { name: "addressesapi/ct",            url: "https://addressesapi.090227.xyz/ct",   type: "carrier", category: "cf-native" },
  { name: "ip.164746.xyz/ipTop",        url: "https://ip.164746.xyz/ipTop10.html",   type: "html", category: "cf-native" },
  // ===== v2.1 cfnb 新增源 =====
  // wtf-359 已并入 countrymerge，下行保留注释仅作历史记录

  // ===== v2.2 IPDB by ymyuuu/030101.xyz：用 GitHub raw 镜像绕开 CF 出站黑名单 =====
  // 030101.xyz 的 API 把 Cloudflare 数据中心 IP 段拉黑了，从 Worker 直接调会 403。
  // 但同作者把数据自动同步到了 github.com/ymyuuu/IPDB 仓库，raw 链路畅通。
  // ===== v3.2 DustinWin/BestCF 索引裡入 CMLiussss 全免费子域 + wetest 微测网 =====
  { name: "CMLiussss/cm", url: "https://cf.090227.xyz/cmcc", type: "carrier", category: "cf-native" },
  { name: "CMLiussss/cu", url: "https://cf.090227.xyz/cu",   type: "carrier", category: "cf-native" },
  { name: "CMLiussss/ct", url: "https://cf.090227.xyz/ct",   type: "carrier", category: "cf-native" },
  { name: "wetest.vip/cloudflare", url: "https://www.wetest.vip/page/cloudflare/address_v4.html", type: "uouin_html", category: "cf-native" },
  { name: "IPDB/bestcf",                url: "https://raw.githubusercontent.com/ymyuuu/IPDB/main/bestcf.txt", type: "text", category: "cf-native" },
  // 注：IPDB/proxy（上面已配置 proxy.txt）已对应 030101.xyz?type=proxy，不再重复配置
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
    if (!map.has(k)) map.set(k, { ...x });
    else {
      const cur = map.get(k);
      cur.sources = Array.from(new Set([...(cur.sources || []), ...(x.sources || [])]));
      // 如果新进来的 IP 有 tested 数据而当前的没,接管 delay/loss/mbps/colo/tested
      if (x.tested && !cur.tested) {
        cur.delay = x.delay;
        cur.loss = x.loss;
        cur.mbps = x.mbps;
        cur.colo = x.colo;
        cur.tested = true;
      }
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
    const fetchOpts = {
      cf: { cacheTtl: 300 },
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "accept": "text/plain,text/html,application/json,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    };
    if (src.method) fetchOpts.method = src.method;
    if (src.body) {
      fetchOpts.body = JSON.stringify(src.body);
      fetchOpts.headers["content-type"] = "application/json";
    }
    const r = await withTimeout(fetch(src.url, fetchOpts), 8000);
    if (!r.ok) return { name: src.name, ips: [], error: `HTTP ${r.status}` };

    // hostmonit JSON 分支:带真实延迟/丢包/速度/colo
    if (src.type === "hostmonit_json") {
      const j = await r.json();
      const out = [];
      for (const line of ["CT", "CU", "CM"]) {
        for (const x of (j?.info?.[line] || [])) {
          out.push({
            ip: x.ip,
            port: 443,
            carrier: line,
            // hostmonit 的 IP 是 CF anycast，真实地理位置在 US/HK 等,
            // line:CT/CU/CM 只表示"最优运营商路由"，不是 IP 所在国。
            // 设 country:null 让 enrichGeo 查真实国家，避免被默认 CN blocklist 误杀。
            country: null,
            delay: x.latency,
            loss: x.loss,
            mbps: x.speed,
            colo: x.colo && x.colo !== "Default" ? x.colo : undefined,
            node: x.node,
            tested: true,
            category: "cf-native",
          });
        }
      }
      return { name: src.name, ips: out };
    }

    const body = await r.text();
    const ips = [];
    const category = src.category || "cf-native";

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
        ips.push({ ip, port: 443, carrier: carrierMap[last] || null, category, sources: [src.name] });
      }
      return { name: src.name, ips };
    }

    // v2.1：新源用 emoji/中文标签，需要自适应解析
    // v2.2：扩大自适应名单（IPDB/bestproxy 同样带 country 标签）
    const adaptiveSources = new Set([
      "countrymerge/all",
      "zip.cm.edu.kg/all",
      "CMLiussss/cm",
      "CMLiussss/cu",
      "CMLiussss/ct",
    ]);
    const useAdaptive = adaptiveSources.has(src.name);

    for (const raw of body.split(/[\r\n,]+/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      if (useAdaptive) {
        const parsed = parseLineAdaptive(line);
        if (parsed) ips.push({ ...parsed, category, sources: [src.name] });
        continue;
      }
      const matches = line.match(/\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?:#[\w\-]+)?/g) || [];
      for (const mm of matches) {
        const parsed = parseLine(mm);
        if (parsed) ips.push({ ...parsed, category, sources: [src.name] });
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
  const uniq = uniqBy(all, x => `${x.ip}:${x.port}:${x.carrier || ""}`);
  // v3.0: 严格只保留落在 CF 官方 CIDR 段的 IP,反代 IP 完全丢弃
  const cfOnly = uniq.filter(x => isCfNativeIp(x.ip));
  return { ips: cfOnly, stats };
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
    // 已有预测速数据（如 hostmonit）则保留;否则填空
    if (item.tested) return { ...item, port };
    return { ...item, port, delay: null, loss: 0, tested: false };
  }, cfg.probeConcurrency);

  // 3. 过滤：手动添加的要测速通过；池子里的全保留
  let alive = probed.filter(x => x._manual ? (x.delay != null && x.loss < 0.5) : true);
  // 排序:tested + delay 小的优先,其余按 source 计数降序
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
  const wantedSet = new Set(wanted);
  const existing = await listRecords(env, name);
  const existingMap = new Map(existing.map(r => [r.content, r.id]));
  // 1) 删除不再需要的
  let removed = 0, added = 0, kept = 0;
  for (const r of existing) {
    if (!wantedSet.has(r.content)) {
      await deleteRecord(env, r.id);
      removed++;
    } else {
      kept++;
    }
  }
  // 2) 创建新增的
  for (const ip of wanted) {
    if (!existingMap.has(ip)) {
      await createRecord(env, name, ip);
      added++;
    }
  }
  return { name, ips: wanted, kept, added, removed };
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
  // v3.0: 纯 CF 优选,只同步 cf./ct./cu./cm.,并清理历史的 proxy. 记录
  const results = [];
  const root = env.CF_RECORD_NAME.split(".").slice(1).join(".");
  // 主域:全 CF native top N
  results.push(await syncRecord(env, env.CF_RECORD_NAME, pool, topN));
  // 显式删除遗留 proxy.* 记录(从 v2.x 升级时清理)
  try {
    const stale = await listRecords(env, `proxy.${root}`);
    for (const r of stale) await deleteRecord(env, r.id);
    if (stale.length) results.push({ name: `proxy.${root}`, removed: stale.length, ips: [] });
  } catch {}
  if (env.CF_DNS_BY_CARRIER === "1") {
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
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
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
}

// ============================================================
// 9. 筛选 / 输出格式
// ============================================================
function applyFilter(ips, params, requesterColo, cfg) {
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

  // 分国家 top-N 模式（来自 cfnb）：?perCountry=1 或 cfg.perCountryMode
  const perCountryQuery = params.get("perCountry");
  const perCountryEnabled = perCountryQuery
    ? ["1", "true", "yes"].includes(perCountryQuery.toLowerCase())
    : !!(cfg && cfg.perCountryMode);
  const perCountryN = Math.max(
    1,
    Number(params.get("perCountryN")) || (cfg && cfg.perCountryTopN) || 1,
  );

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

  // 分国家模式：每国最多取 perCountryN 个，再按国家总量降序铺开
  if (perCountryEnabled) {
    const byC = new Map();
    for (const x of out) {
      const k = x.country || "??";
      if (!byC.has(k)) byC.set(k, []);
      byC.get(k).push(x);
    }
    const countries = [...byC.entries()].sort((a, b) => b[1].length - a[1].length);
    const merged = [];
    let depth = 0;
    while (merged.length < top && depth < perCountryN) {
      for (const [, arr] of countries) {
        if (arr[depth]) merged.push(arr[depth]);
        if (merged.length >= top) break;
      }
      depth++;
    }
    return merged;
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

// ============================================================
// 10. 鉴权
// ============================================================

// ============================================================
// 11. 路由
// ============================================================
async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const params = url.searchParams;
  const data = await getLatest(env);
  const ips = data.ips || [];
  const cfg = await getConfig(env);
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
    const filtered = applyFilter(ips, params, requesterColo, cfg);
    return text(fmtSub(filtered, params.get("comment") !== "0"));
  }
  if (path === "/api/preferred-ips") {
    return text(fmtEDT(applyFilter(ips, params, requesterColo, cfg)));
  }

  // ---- JSON 列表 ----
  if (path === "/api/ips") {
    const filtered = applyFilter(ips, params, requesterColo, cfg);
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
  // ---- 页面 ----
  if (path === "/" || path === "/index.html") return html(renderHome(data, visitor));
  if (path === "/test") return html(renderTest(visitor));

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
  <nav><a href="/">首页</a><a href="/test">节点浏览</a><a href="https://github.com/LeilaoMi/cf-best-ip" target="_blank" rel="noreferrer">GitHub</a></nav>
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

  const flagOf = (cc) => cc && cc.length === 2
    ? String.fromCodePoint(...cc.toUpperCase().split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65))
    : "🌐";

  // 取每类 top 30；hostmonit 来的有真实 delay/loss/mbps/colo，会优先排在前面
  const sortFn = (a, b) => {
    // 先 tested 优先（hostmonit 数据）
    if (a.tested && !b.tested) return -1;
    if (!a.tested && b.tested) return 1;
    if (a.tested && b.tested) return (a.delay || 9999) - (b.delay || 9999);
    return (b.sources || []).length - (a.sources || []).length;
  };
  const ct = ips.filter(x => x.carrier === "CT").sort(sortFn).slice(0, 30);
  const cu = ips.filter(x => x.carrier === "CU").sort(sortFn).slice(0, 30);
  const cm = ips.filter(x => x.carrier === "CM" || x.carrier === "CMCC").sort(sortFn).slice(0, 30);
  const allNative = ips.filter(x => !["CT","CU","CM","CMCC"].includes(x.carrier)).sort(sortFn).slice(0, 30);

  const nativeCount = ips.length;

  const fmtDelay = (x) => x.delay != null ? `${x.delay}ms` : "—";
  const fmtSpeed = (x) => x.mbps != null ? `${x.mbps}M` : "—";
  const fmtColo = (x) => x.colo || x.node || "—";

  const renderRow = (x, i) => `<tr>
    <td class="num">${i + 1}</td>
    <td><span class="badge badge-${(x.carrier || "CF").toLowerCase()}">${carrierName(x.carrier || "CF")}</span></td>
    <td class="ipcell"><span class="ip" data-ip="${x.ip}">${x.ip}</span></td>
    <td class="cell-loss">${x.loss != null ? (x.loss * 100).toFixed(0) + "%" : "—"}</td>
    <td class="cell-delay">${fmtDelay(x)}</td>
    <td class="cell-speed">${fmtSpeed(x)}</td>
    <td><button class="copybtn" data-copy="${x.ip}">📋</button></td>
  </tr>`;

  const renderTable = (rows) => rows.length
    ? `<table class="iptbl"><thead><tr>
        <th>#</th><th>线路</th><th>IP</th>
        <th class="cell-loss">丢包</th>
        <th class="cell-delay">延迟</th>
        <th class="cell-speed">速度</th>
        <th>复制</th>
      </tr></thead><tbody>${rows.map(renderRow).join("")}</tbody></table>`
    : `<div class="empty">⏳ 该分类暂无数据，等待下次刷新…</div>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>CloudFlare 优选 IP · ${visitor.root || ""}</title>
<meta name="description" content="电信、联通、移动 优质 Cloudflare 节点 IP,真实测速数据,每 6 小时自动刷新">
<style>
:root { --bg:#0a0d12; --card:#11161d; --bd:#1f2630; --fg:#e6edf3; --mut:#8b949e;
  --ct:#3fb950; --cu:#a371f7; --cm:#388bfd; --cf:#f9826c; --pr:#d29922; }
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0}
.hero{padding:36px 16px;background:linear-gradient(180deg,#000 0%,#0a0d12 100%);text-align:center;border-bottom:1px solid var(--bd)}
.hero h1{margin:0 0 8px;font-size:30px;letter-spacing:1px}
.hero .sub{color:var(--mut);font-size:13px;margin-bottom:18px;line-height:1.7;padding:0 8px}
.hero-stats{display:flex;flex-wrap:wrap;gap:8px 24px;justify-content:center;font-size:12px;color:var(--mut)}
.hero-stats b{color:var(--fg);font-size:16px;font-weight:600;margin-left:4px}
.wrap{max-width:1100px;margin:0 auto;padding:16px}
.tabs{display:flex;gap:6px;margin-bottom:14px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px}
.tab{flex-shrink:0;padding:9px 14px;background:var(--card);border:1px solid var(--bd);border-radius:8px;cursor:pointer;color:var(--mut);font-size:13px;white-space:nowrap}
.tab.active{background:#1f6feb;border-color:#1f6feb;color:#fff;font-weight:600}
.tab .n{margin-left:4px;font-size:11px;opacity:.8}
.refresh-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;font-size:12px;color:var(--mut);margin-bottom:10px}
.refresh-bar button{background:var(--card);border:1px solid var(--bd);color:var(--fg);padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px}
.refresh-bar button:hover{background:#1f6feb;border-color:#1f6feb;color:#fff}
.iptbl{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--bd);border-radius:10px;overflow:hidden;font-size:13px}
.iptbl th,.iptbl td{padding:11px 8px;text-align:left;border-bottom:1px solid var(--bd)}
.iptbl th{background:#0d1117;font-size:12px;color:var(--mut);font-weight:500}
.iptbl tr:last-child td{border-bottom:0}
.iptbl tr:hover td{background:rgba(31,111,235,.06)}
.iptbl .num{color:var(--mut);width:40px;text-align:center}
.iptbl .ip{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#79c0ff;cursor:pointer;font-size:13px}
.iptbl .ip:hover{text-decoration:underline}
.iptbl .ipcell{min-width:120px}
.iptbl .flagcc{white-space:nowrap}
.badge{display:inline-block;padding:3px 9px;border-radius:5px;font-size:11px;font-weight:600;letter-spacing:.3px;color:#fff;white-space:nowrap}
.badge-ct{background:var(--ct)}.badge-cu{background:var(--cu)}.badge-cm{background:var(--cm)}.badge-cmcc{background:var(--cm)}.badge-cf{background:var(--cf)}.badge-def{background:#6e7681}
.copybtn{background:transparent;border:1px solid var(--bd);color:var(--mut);padding:4px 9px;border-radius:5px;cursor:pointer;font-size:11px;white-space:nowrap}
.copybtn:hover{background:#1f6feb;border-color:#1f6feb;color:#fff}
.copybtn.ok{background:var(--ct);border-color:var(--ct);color:#fff}
.empty{padding:36px;text-align:center;color:var(--mut);background:var(--card);border:1px solid var(--bd);border-radius:10px;font-size:13px}
.subs{margin:20px 0;display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.subcard{padding:14px;background:var(--card);border:1px solid var(--bd);border-radius:10px}
.subcard .sublabel{color:var(--mut);font-size:11px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}
.subcard .subhost{font-family:ui-monospace,monospace;font-size:13px;color:#79c0ff;word-break:break-all;line-height:1.5}
.footer{text-align:center;padding:24px 16px;color:var(--mut);font-size:11px}
.footer a{color:var(--mut);text-decoration:none}
.footer a:hover{color:#79c0ff}
/* 移动端：6.6 寸屏 (≈ 400px wide) */
@media (max-width: 720px) {
  .hero{padding:24px 14px}
  .hero h1{font-size:22px}
  .hero .sub{font-size:11px}
  .hero-stats{gap:6px 16px;font-size:11px}
  .hero-stats b{font-size:14px}
  .wrap{padding:10px}
  .iptbl{font-size:12px;border-radius:8px}
  .iptbl th,.iptbl td{padding:8px 5px}
  .iptbl .num{width:26px}
  .iptbl .ip{font-size:12px}
  /* 移动端紧凑展示：所有列都显示，padding/字号缩小 */
  .iptbl th,.iptbl td{padding:7px 3px;font-size:11px}
  .cell-loss{text-align:center;min-width:30px}
  .cell-delay{min-width:46px}
  .cell-speed{min-width:42px;color:var(--ct)}
  .badge{padding:2px 6px;font-size:10px}
  .iptbl .ip{font-size:11px}
  .tabs{margin-bottom:10px}
  .tab{padding:7px 11px;font-size:12px}
  .copybtn{padding:3px 7px;font-size:10px}
  .subcard{padding:11px}
}
/* 极小屏：< 360px */
@media (max-width: 380px) {
  .hero h1{font-size:18px}
  .iptbl .num{display:none}
  .iptbl th:first-child{display:none}
  .iptbl th,.iptbl td{padding:6px 2px;font-size:10.5px}
  .iptbl .ip{font-size:10.5px}
}
</style>

<div class="hero">
  <h1>☁️ CloudFlare 优选 IP</h1>
  <p class="sub">电信、联通、移动 优质 Cloudflare 节点 IP<br>聚合 18 个公开源 · 全部经 CF 官方 CIDR 段二次校验 · 真实测速数据 · 每 6 小时自动刷新</p>
  <div class="hero-stats">
    <div>总节点 <b>${total}</b></div>
    <div>CF 自家 <b>${nativeCount}</b></div>
    
    <div>更新于 <b id="upd">${updated}</b></div>
  </div>
</div>

<div class="wrap">
  <div class="tabs" id="tabs">
    <div class="tab active" data-tab="ct">📡 电信<span class="n">${ct.length}</span></div>
    <div class="tab" data-tab="cu">📶 联通<span class="n">${cu.length}</span></div>
    <div class="tab" data-tab="cm">📲 移动<span class="n">${cm.length}</span></div>
    <div class="tab" data-tab="cf">☁️ 通用<span class="n">${allNative.length}</span></div>
    
  </div>

  <div class="refresh-bar">
    <div>下次自动刷新倒计时 <b id="cd" style="color:var(--fg)">--:--</b></div>
    <button id="manualRefresh">🔄 立即刷新</button>
  </div>

  <div id="pane-ct" class="pane">${renderTable(ct)}</div>
  <div id="pane-cu" class="pane" style="display:none">${renderTable(cu)}</div>
  <div id="pane-cm" class="pane" style="display:none">${renderTable(cm)}</div>
  <div id="pane-cf" class="pane" style="display:none">${renderTable(allNative)}</div>
  

  <div class="subs">
    <div class="subcard">
      <div class="sublabel"><span>📡 电信</span><button class="copybtn" data-copy="ct.${(visitor.root || "你的域名")}">复制域名</button></div>
      <div class="subhost">ct.${(visitor.root || "你的域名")}</div>
    </div>
    <div class="subcard">
      <div class="sublabel"><span>📶 联通</span><button class="copybtn" data-copy="cu.${(visitor.root || "你的域名")}">复制域名</button></div>
      <div class="subhost">cu.${(visitor.root || "你的域名")}</div>
    </div>
    <div class="subcard">
      <div class="sublabel"><span>📲 移动</span><button class="copybtn" data-copy="cm.${(visitor.root || "你的域名")}">复制域名</button></div>
      <div class="subhost">cm.${(visitor.root || "你的域名")}</div>
    </div>
    <div class="subcard">
      <div class="sublabel"><span>☁️ 主域</span><button class="copybtn" data-copy="cf.${(visitor.root || "你的域名")}">复制域名</button></div>
      <div class="subhost">cf.${(visitor.root || "你的域名")}</div>
    </div>
    
  </div>

  <div class="footer">
    数据源:hostmonit · IPDB/bestcf · joname1/BestCFip · KafeMars · 164746.xyz · addressesapi<br>
    <a href="https://github.com/LeilaoMi/cf-best-ip" target="_blank">📦 GitHub</a> · 基于 Cloudflare Workers
  </div>
</div>

<script>
const tabs = document.querySelectorAll('.tab');
const panes = document.querySelectorAll('.pane');
tabs.forEach(t => t.onclick = () => {
  tabs.forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  panes.forEach(p => p.style.display = 'none');
  document.getElementById('pane-' + t.dataset.tab).style.display = '';
});

document.body.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copybtn');
  const ipEl = e.target.closest('.ip');
  const text = btn ? btn.dataset.copy : (ipEl ? ipEl.dataset.ip : null);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const old = btn.textContent;
      btn.textContent = '✓ 已复制';
      btn.classList.add('ok');
      setTimeout(() => { btn.textContent = old; btn.classList.remove('ok'); }, 1500);
    }
  } catch { prompt('复制此内容', text); }
});

// 倒计时 (下次 Cron: 每 6 小时整 UTC)
function tickCountdown() {
  const now = new Date();
  const u = now.getUTCHours();
  const nh = Math.ceil((u + 0.001) / 6) * 6 % 24;
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(),
    now.getUTCDate() + (nh === 0 && u >= 18 ? 1 : 0),
    nh, 0, 0
  ));
  const s = Math.max(0, Math.floor((next - now) / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  document.getElementById('cd').textContent = h + ':' + m + ':' + sec;
}
tickCountdown();
setInterval(tickCountdown, 1000);

document.getElementById('manualRefresh').onclick = async (e) => {
  const btn = e.target;
  btn.disabled = true; btn.textContent = '⏳ 抓取中…';
  try {
    const r = await fetch('/api/refresh').then(r => r.json());
    if (r.ok) { btn.textContent = '✓ 完成，刷新页面'; setTimeout(() => location.reload(), 800); }
    else { btn.textContent = '✗ ' + (r.hint || r.error || '失败'); setTimeout(() => { btn.disabled = false; btn.textContent = '🔄 立即刷新'; }, 3000); }
  } catch (err) { btn.textContent = '✗ ' + err.message; btn.disabled = false; }
};
</script>

</body></html>`;
}