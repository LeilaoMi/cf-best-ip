# cf-best-ip · Cloudflare 优选 IP 服务

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)
[![Version](https://img.shields.io/badge/version-3.9.1-blue)]()

一个跑在 Cloudflare Worker 上的优选 IP 聚合服务：定时从 23 个社区数据源拉取 Cloudflare IP，只保留 Cloudflare 官方网段内的地址，按稳定分排序，然后：

- 在网页上按 **电信 / 联通 / 移动 / 通用** 分栏展示；
- 输出订阅（`/sub`），供 edgetunnel、Karing 等客户端使用；
- 自动把每条线路前 10 个 IP 同步到你自己域名下的 DNS only A 记录（`auto.` `cf.` `ct.` `cu.` `cm.`）。

> ⚠️ **风险声明**：Cloudflare 服务条款不鼓励"优选 IP"（刻意绕过 GeoIP 调度）。主要上游 [ddgth/cf2dns](https://github.com/ddgth/cf2dns) 也明确提示可能导致账号封禁。本项目仅作技术研究，风险自负。

---

## 工作流程

```
Cron（每 6 小时，UTC 第 15 分钟）
   │
   ▼
并发拉取 23 个数据源（失败源自动退避，别名源命中即跳过）
   │
   ▼
解析 ── 丢弃聚合页标题/占位行（BestCF.pages.dev 等）
   │
   ▼
Cloudflare 官方 CIDR 校验（只留 AS13335 网段，反代 IP 全部丢弃）
   │
   ▼
按 (ip, port, 运营商) 去重合并，多源出现累计来源数
   │
   ▼
稳定分排序（上一批延续 + 国内实测 + 来源数 + 延迟/丢包/速度）
   │
   ▼
质量保护：池子明显缩水 → 保留上一批，跳过 DNS 同步
   │
   ├──► KV 保存快照 → 网页 / 订阅 / API
   └──► DNS 差量同步 → auto. cf. ct. cu. cm.（每次每个域名最多换 30%）
```

Worker 本身**不测速**：Cloudflare 禁止 Worker 连接 Cloudflare 自家 IP，所以延迟数据全部来自上游。

---

## 数据源

| 来源 | 数量级 | 测速数据 | 说明 |
|---|---|---|---|
| `hostmonit/三网实测` | ~15 | ✅ 国内三网 | ddgth/cf2dns 作者运营；带延迟/丢包/速度，时有超时 |
| `uouin/麒麟优选`（经 bestcf.pages.dev） | ~40 | ✅ 国内三网 | 带运营商、延迟、速度 |
| `nirevil`（经 bestcf.pages.dev） | ~35 | 海外（MSP 等） | 延迟只作参考 `refDelay`，不参与排序 |
| `IPDB/bestcf-csv`（ymyuuu/IPDB） | ~10 | 海外 | 同上，只作参考 |
| `addressesapi.090227.xyz` × 4 | 少量 | — | CMLiussss 老 API，带运营商标签 |
| `cf.090227.xyz/{cmcc,cu,ct}` | 少量 | — | CMLiussss 三网分类；`cm` 与 `addressesapi/cmcc` 视为同一信号 |
| `joname1/BestCFip` v4 / v6 | ~100 / ~25 | — | 每日更新 |
| `KafeMars/*` × 5 | 10–30 | — | 按地区分类 |
| `ip.164746.xyz/ipTop` | 少量 | — | CFST 结果页 |
| `wetest.vip` | ~10 | — | 微测网公开页面 |
| `s5gy` `lzj` `xinyitang3`（经 bestcf.pages.dev） | 量大 | — | 大部分是反代 IP，CIDR 校验后只剩少量 |

**只有国内三网实测的数据才算"实测"**（`quality.testedBy = hostmonit / uouin`）。海外测出的延迟对国内线路没有参考意义，只保存在 `refDelay` 字段。

---

## 排序规则

每个 IP 的稳定分（`_score`）由以下部分相加：

| 项 | 分值 |
|---|---|
| 上一批也出现过 | +40 |
| 国内实测 | +30 |
| 来源数 × 6 | 最多 +30 |
| 国内实测延迟 | 最多 +30（越低越高） |
| 丢包率 | 最多 +20 |
| 速度 | 最多 +15 |

网页、`/sub`、`/api/ips` 和 DNS 同步都按稳定分排序；同分时国内实测延迟低的在前。优先保留上一批的 IP，可以避免 DNS 每 6 小时大换血。

### 质量保护

以下任一情况，本次结果作废，继续使用上一批，**不同步 DNS**：

- 本次 IP 总数低于上一批的 60%；
- 国内实测 IP 数低于上一批的 50%（上一批 ≥ 10 个时）；
- 任一运营商池低于上一批的 40%（上一批 ≥ 10 个时）；
- 一个可用 IP 都没拿到。

---

## DNS 同步

- 托管名单固定：`AUTO_RECORD_NAME`、`CF_RECORD_NAME`，开启三网分流后加上 `ct.` `cu.` `cm.`（相对 `ROOT_DOMAIN`）。名单外的记录一律不动。
- 每个域名最多 `DNS_TOP_N`（默认 10）条 A 记录，DNS only，TTL 60。
- 差量更新：仍在候选里的记录保留，每次每个域名最多替换 `DNS_MAX_CHANGE_RATIO`（默认 30%）。
- 所有域名的改动合并成**一次** `dns_records/batch` 调用；无变化时跳过。
- 遇到 Cloudflare API 限流，30 分钟内不再尝试，并发 Telegram 告警。
- 写入后用 Cloudflare / Google DoH 验证是否生效，结果记录在 `dns:lastSync`。
- IPv6（AAAA）同步默认关闭，设 `CF_DNS_IPV6=1` 开启，只同步 `auto.` 和 `cf.`。

`CF_API_TOKEN` 必须是**只授权目标域名的"编辑区域 DNS"Token**。如果 `/health` 长期显示 `dnsRateLimited: true`，先换一个新的专用 Token。

---

## 部署

本仓库**推送后不会自动部署**，需要手动用 Wrangler 发布：

```bash
npm i -g wrangler
wrangler kv namespace create cf-best-ip-kv     # 把返回的 id 填进 wrangler.toml
wrangler secret put CF_API_TOKEN               # 编辑区域 DNS，只授权你的域名
wrangler secret put REFRESH_TOKEN              # openssl rand -hex 32
wrangler secret put ADMIN_TOKEN                # openssl rand -hex 32
wrangler deploy
```

部署前把 `wrangler.toml` 里的 KV id、`CF_ZONE_ID`、`SERVICE_HOSTNAME`、`ROOT_DOMAIN`、`ALLOWED_HOSTS`、`AUTO_RECORD_NAME`、`CF_RECORD_NAME` 改成自己的。

**域名分工**：`SERVICE_HOSTNAME`（如 `bestip.example.com`）是 Worker 的网页和 API 入口；`auto.` `cf.` `ct.` `cu.` `cm.` 是 DNS only 的优选 IP 池。两者不能是同一个域名。

### 环境变量

| 名称 | 必填 | 说明 |
|---|---|---|
| `KV`（绑定） | ✅ | KV namespace，变量名必须是 `KV` |
| `CF_API_TOKEN`（secret） | ✅ | 编辑区域 DNS Token |
| `CF_ZONE_ID` | ✅ | 域名的 Zone ID |
| `CF_RECORD_NAME` | ✅ | 通用池，如 `cf.example.com` |
| `AUTO_RECORD_NAME` | 推荐 | 默认推荐池，如 `auto.example.com` |
| `ROOT_DOMAIN` | 推荐 | 限制 DNS 只能写在这个根域下 |
| `SERVICE_HOSTNAME` | 推荐 | Worker 入口域名 |
| `ALLOWED_HOSTS` | 可选 | 入口 host 白名单，逗号分隔（`/health` 不受限） |
| `REFRESH_TOKEN`（secret） | 推荐 | 手动刷新用 |
| `ADMIN_TOKEN`（secret） | 推荐 | 管理页和管理接口用，也可触发刷新 |
| `CF_DNS_BY_CARRIER` | 可选 | `1` = 同步 `ct.` `cu.` `cm.` |
| `CF_DNS_IPV6` | 可选 | `1` = 同步 AAAA，默认关闭 |
| `DNS_TOP_N` | 可选 | 每个域名的记录数，默认 10 |
| `DNS_MAX_CHANGE_RATIO` | 可选 | 每次最多替换比例，默认 0.3 |
| `API_IPS_RATE_LIMIT` | 可选 | `/api/ips` 每 IP 每分钟次数，默认 60，`0` 关闭 |
| `SUB_RATE_LIMIT` | 可选 | 订阅接口每 IP 每分钟次数，默认 120，`0` 关闭 |
| `API_IPS_REQUIRE_TOKEN` + `API_IPS_TOKEN` | 可选 | `1` = `/api/ips` 需要 Bearer Token |
| `ALLOW_PUBLIC_REFRESH` | 可选 | `1` = 允许无 Token 刷新，不推荐 |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | 可选 | 刷新结果和告警推送 |

`wrangler.toml` 里声明了 `REFRESH_LOCK` Durable Object 作为刷新锁；没有绑定时自动退回 KV 锁。

---

## 接口

| 路径 | 鉴权 | 说明 |
|---|---|---|
| `/` | — | 展示页，四种主题；`?plain=1` 极简页 |
| `/sub`（`/sub.txt` `/ips.txt` `/api/ips.txt`） | 限流 | 订阅，默认 `IP:端口#colo-运营商`，支持 `format=plain/csv/jsonl` |
| `/api/preferred-ips` | — | 纯 `IP:端口` 列表（Karing 等） |
| `/api/ips` | 限流，可选 Token | JSON 列表，含 `_score`、`quality`、`refDelay` |
| `/api/stats` | — | 池子统计、数据源状态、最近一次 DNS 同步 |
| `/api/history?days=7` | — | 每日快照，最多 30 天 |
| `/health` | — | 健康检查：`status`、`reasons`、`dnsOk`、`dnsRateLimited`、`sourceHealth` |
| `POST /api/refresh` | `REFRESH_TOKEN` / `ADMIN_TOKEN` | 立即刷新，60 秒冷却 |
| `/admin` | `ADMIN_TOKEN` | 管理控制台 |
| `/api/diagnostics` | `ADMIN_TOKEN` | 诊断快照 |
| `/api/dns/current` | `ADMIN_TOKEN` | 当前托管 DNS 记录 |
| `/api/config` | `ADMIN_TOKEN` | 运行时配置查看/修改/导入/导出 |

Token 只接受 `Authorization: Bearer ...` 请求头，不接受 URL 参数。

### 筛选参数（`/sub`、`/api/ips`、`/api/preferred-ips`）

| 参数 | 说明 |
|---|---|
| `carrier=CT,CU,CM` | 按运营商筛选（`CMCC` 等同 `CM`） |
| `colo=HKG,NRT` | 按 Cloudflare 机房筛选（只有部分来源带 colo） |
| `family=v4` / `v6` | 只要 IPv4 / IPv6 |
| `port=443` | 按端口 |
| `maxDelay=200` | 只要国内实测延迟不高于该值的 |
| `minMbps=10` | 只要速度不低于该值的 |
| `exclude=1.1.1.1,2.2.2.2` | 排除指定 IP |
| `top=50` / `limit=50` | 返回数量，默认 20，最多 200 |
| `comment=0` | 订阅不带 `#备注` |

示例：

```bash
# 联通前 10 个
curl "https://bestip.example.com/sub?carrier=CU&top=10"

# 手动刷新
curl -X POST -H "Authorization: Bearer $REFRESH_TOKEN" https://bestip.example.com/api/refresh
```

---

## 监控与告警

- **GitHub Actions `Health Check`**：每 30 分钟请求一次 `/health`，失败重试 3 次。可在仓库变量 `HEALTH_URL` 里改地址。
- **GitHub Actions `Scheduled Test`**：运行单元测试和 `scripts/verify-worker.mjs`。
- **Telegram**（可选）：每次刷新推送结果；另外以下情况告警，24 小时内同类只发一次：
  - 某个数据源连续失败 3 次；
  - DNS 同步被限流；
  - 某个运营商池少于 5 个。
- 数据超过 8 小时未更新，网页、`/admin`、`/health` 都会标记为陈旧。

---

## 已知局限

- **没有自测延迟**：Worker 不能连 Cloudflare 自家 IP，国内实测数据只来自 hostmonit 和 uouin，这两个源不稳定时实测池会变小。
- **地理位置没意义**：Cloudflare 是任播网络，IP 地理库几乎都显示美国或加拿大。地理信息只在页面展示，不参与排序，也不写进订阅备注。
- **上游会变**：社区源随时可能改格式或下线。失败的源会自动退避，`/api/stats` 的 `sourceStats` 可以看到每个源的数量和错误。
- **KV 限额**：限流计数用 KV 实现，每次订阅请求写一次 KV。免费版每天只有 1000 次写入，订阅被高频拉取时注意用量。

---

## 本地验证

```bash
node --test                      # 单元测试：CIDR、DNS 差量计划、评分与质量保护
node scripts/verify-worker.mjs   # 静态检查：安全头、鉴权、版本号、README 与配置一致
```

## 项目结构

```
src/worker.js    Worker 入口：数据源、聚合、接口、页面、DNS 同步
src/cidr.js      Cloudflare 官方 CIDR 判断
src/scoring.js   稳定分、质量保护、源健康统计
src/dns.js       DNS 差量计划
scripts/verify-worker.mjs
test/
wrangler.toml
```

## License

MIT
