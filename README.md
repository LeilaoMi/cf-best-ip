# cf-best-ip · Cloudflare 优选 IP

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)
[![Version](https://img.shields.io/badge/version-3.8.0-blue)]()

> 在 Cloudflare Worker 上跑的 **CF 自家 IP 优选服务**:聚合社区主流数据源,经官方 CIDR 校验,按运营商 / 全局展示,自动同步到自定义子域 A 记录。

---

## ⚠️ 重要声明 (Cloudflare ToS 风险)

Cloudflare 在 [2024 年 12 月声明](https://www.landiannews.com/archives/107037.html) 中明确**禁止"优选 IP"行为**(刻意绕过 GeoIP 调度连接非分配数据中心)。`ddgth/cf2dns`(本项目主要数据源 hostmonit 的母项目)README 也明确写:

> "cloudflare 明文禁止:优选 IP 和 CF 代理节点。使用本服务造成账号封禁,本人概不负责。"

**使用本项目的风险由你自己承担**,本仓库仅作技术研究用途。

---

## 🎯 它做什么

| 模块 | 行为 |
|---|---|
| **聚合** | 每 6 小时 Cron 从 18 个社区源拉取候选 IP |
| **校验** | 用 Cloudflare 官方 [`ips-v4`](https://www.cloudflare.com/ips-v4) 的 15 个 CIDR 段做位运算判定,**非 AS13335 段全部丢弃** |
| **测速可信度** | 明确区分 `hostmonit` 来源实测与普通来源推荐；普通来源不冒充 Worker 实测 |
| **展示** | 在 `bestip.<你的域名>` 显示产品化首页，`/admin` 提供管理控制台 |
| **同步** | 自动写入优选池 A 记录:`auto.` `cf.` `ct.` `cu.` `cm.`；按托管域名查询 DNS，减少大 Zone API 压力 |
| **通知** | Telegram(可选)，失败会记录到 `notify:lastError` |

---

## 📡 数据源

按信号质量排序:

| # | 源 | 类型 | 说明 |
|---|---|---|---|
| 1 | **`hostmonit/三网实测`** | POST API | [ddgth/cf2dns](https://github.com/ddgth/cf2dns) 5.1K⭐ 项目作者运营的 `api.hostmonit.com`,后端在三网 VPS 上**真实**ping/curl 测速,提供 CT/CU/CM 各 5 个最优 IP + 延迟/丢包/速度 |
| 2 | `joname1/BestCFip` | GitHub raw | 每日自动更新的 100+ CF anycast IPs |
| 3 | `KafeMars/cloudflare_ips` 等 6 个 | GitHub raw | 多地域分类(US/HK/JP/SG/EU/CF) |
| 4 | `addressesapi.090227.xyz/*` 4 个 | API | CMLiussss 老 API:`ip.164746.xyz` / `CloudFlareYes` / `cmcc` / `ct` |
| 5 | `cf.090227.xyz/{cmcc,cu,ct}` | API | CMLiussss 新免费子域,三网分类 |
| 6 | `wetest.vip` | HTML scrape | 微测网公开页面,通用 CF IP |
| 7 | `ip.164746.xyz/ipTop` | CSV | CFST 数据 |
| 8 | `IPDB/bestcf` (`ymyuuu/IPDB`) | GitHub raw | 备份镜像(API 被 CF 数据中心 IP 屏蔽) |

参考:[DustinWin/BestCF 索引](https://github.com/DustinWin/BestCF)、[xinyitang3/cfnb](https://github.com/xinyitang3/cfnb)。

---

## 🏗️ 架构

```
18 个社区源 → 并发拉取 → 解析 IP/carrier
       ↓
CF 官方 CIDR 二次校验(只留 AS13335)
       ↓
按 (ip,port,carrier) 去重 + 多源合并
       ↓
排序:tested(hostmonit)优先 → delay 升序 → 来源数降序
       ↓
┌────────────────────────────────────────────┐
│ 网页(/)展示                                 │
│ 全部 30 / CT 10 / CU 10 / CM 10 / 通用 30  │
└────────────────────────────────────────────┘
       ↓
DNS 同步(diff-based,只动托管白名单记录)
auto.<域名> / cf.<域名> / ct. / cu. / cm. 各 top N
```

---

## 🚀 部署

### Wrangler 部署（推荐）

```bash
npm i -g wrangler
wrangler kv namespace create cf-best-ip-kv
wrangler secret put CF_API_TOKEN
wrangler secret put REFRESH_TOKEN
wrangler deploy
```

部署前请把 `wrangler.toml` 里的 KV namespace id、`CF_ZONE_ID`、`SERVICE_HOSTNAME`、`AUTO_RECORD_NAME`、`CF_RECORD_NAME` 改成你自己的值。

建议域名角色分离：`SERVICE_HOSTNAME` 只作为 Worker 管理页/API 入口，例如 `bestip.example.com`；`AUTO_RECORD_NAME` / `CF_RECORD_NAME` / `ct.` / `cu.` / `cm.` 才作为 DNS only 的优选 IP 池。不要把 Worker 入口和优选 IP 池设成同一个域名。

### Cloudflare Dashboard / Git 部署（可选）

1. Fork 本仓库
2. Cloudflare Dashboard → Workers & Pages → 创建 Worker → 连接到 Git → 选你 fork 的仓库
3. 绑定 KV namespace，变量名必须叫 `KV`
4. 添加下方变量 / secret
5. 在 Worker → Settings → Triggers → Cron `15 */6 * * *`
6. main 分支 push 后自动部署

### 必填环境变量

| 名 | 说明 | 示例 |
|---|---|---|
| `KV` (binding) | KV namespace 绑定，变量名必须叫 `KV` | wrangler 创建后绑定 |
| `CF_API_TOKEN` | CF API Token（只给目标 Zone 的 DNS Edit 权限） | 在 [profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) 生成 |
| `CF_ZONE_ID` | 你域名的 Zone ID | dashboard 域名概览页右下角 |
| `SERVICE_HOSTNAME` | Worker 管理页 / API 入口，不参与优选 IP DNS 同步 | `bestip.example.com` |
| `AUTO_RECORD_NAME` | 默认推荐优选池，会同步成 A 记录 | `auto.example.com` |
| `CF_RECORD_NAME` | 通用优选池，会同步成 A 记录 | `cf.example.com` |
| `REFRESH_TOKEN` | 手动刷新 Bearer token | `openssl rand -hex 32` |
| `ADMIN_TOKEN` | 管理控制台和诊断接口 Bearer token，也可触发刷新 | `openssl rand -hex 32` |

### 可选环境变量

| 名 | 说明 |
|---|---|
| `CF_DNS_BY_CARRIER` | 设 `1` 启用三网分流（ct./cu./cm. 加上 auto./cf.） |
| `DNS_TOP_N` | 每子域最多写多少条 A 记录，默认 10 |
| `DNS_MAX_CHANGE_RATIO` | 每个域名单次最多替换比例，默认 0.3 |
| `ALLOW_PUBLIC_REFRESH` | 设 `1` 才允许无 token 手动刷新；不推荐公开使用 |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Telegram 通知 |

---

## 🔌 接口

默认公开只读；刷新接口需要鉴权：

| 路径 | 说明 |
|---|---|
| `/` | 公开 IP 展示页（uouin 风格）；`?plain=1` 返回极简页 |
| `POST /api/refresh` | 触发一次重新抓取（60s 冷却），需要 `Authorization: Bearer <REFRESH_TOKEN>`，除非显式设置 `ALLOW_PUBLIC_REFRESH=1` |
| `/api/ips` | JSON 全量列表，每条带 `quality.testedBy/confidence`；参数见下表 |
| `/api/stats` | 池子统计 + 最近一次 DNS 同步结果 + `publicRefreshEnabled` / `notifyLastError` |
| `/health` | 轻量健康检查，返回 `status`、`reasons`、`lastErrorAt`、`criticalSourcesOk`，适合外部监控探活 |
| `/api/diagnostics` | 诊断快照：节点数、三网分布、数据源健康、陈旧状态、DNS 同步、最近错误；需要 `ADMIN_TOKEN` |
| `/api/config` | 运行时配置查看/修改（GET 默认脱敏 / `raw=1` 需确认头 / POST 写入需类型校验），需 `Authorization: Bearer <ADMIN_TOKEN>` |
| `/api/dns/current` | 当前托管子域的 DNS only A 记录 + 最近一次同步结果 |
| `/api/history?days=7` | 过去 N 天的快照 |
| `/sub` | 订阅输出；公开缓存 300 秒降低重复抓取，支持 `format=plain/csv/jsonl` |
| `/api/preferred-ips` | EDT 格式订阅（Karing 等客户端适用） |

常用查询参数：

| 参数 | 适用接口 | 说明 |
|---|---|---|
| `carrier=CT,CU,CM` | `/api/ips`、`/sub` | 按电信/联通/移动筛选，`CMCC` 会归一为 `CM` |
| `country=US,JP` | `/api/ips`、`/sub` | 按国家代码筛选，多个用逗号分隔 |
| `colo=LAX,SJC` | `/api/ips`、`/sub` | 按 Cloudflare colo 筛选 |
| `family=v4/v6` | `/api/ips`、`/sub` | 只返回 IPv4 或 IPv6 |
| `port=443` | `/api/ips`、`/sub` | 按端口筛选 |
| `maxDelay=300` | `/api/ips`、`/sub` | 只返回延迟不高于该值的节点 |
| `minMbps=10` | `/api/ips`、`/sub` | 只返回速度不低于该值的节点 |
| `exclude=1.1.1.1,2.2.2.2` | `/api/ips`、`/sub` | 排除指定 IP |
| `smart=1` | `/api/ips`、`/sub` | 按访问者网络自动偏向推荐线路 |
| `perCountry=1` | `/api/ips`、`/sub` | 每个国家最多取 N 个，避免单一国家占满结果 |
| `perCountryN=2` | `/api/ips`、`/sub` | 配合 `perCountry=1` 使用 |
| `top=50` / `limit=50` | `/api/ips`、`/sub` | 限制返回数量 |
| `format=plain/csv/jsonl` | `/sub` | 订阅输出格式，默认 `plain` |
| `comment=0` | `/sub` | 纯文本订阅不输出注释 |

手动刷新示例：

```bash
curl -X POST \
  -H "Authorization: Bearer $REFRESH_TOKEN" \
  https://bestip.example.com/api/refresh
```

---

## 🔧 技术细节

- **CIDR 判定**:`isCfNativeIp()` 把 CF 官方 15 个 CIDR 段预转成 `(network, mask)` 元组,每个 IP 做 1 次位与即判定,O(15) 常数时间。
- **去重 key**:`(ip, port, carrier)` —— 同一 IP 在三网下可作 3 条独立记录(hostmonit 同 IP 同时为 CT 和 CM 最优时不会丢失数据)。
- **稳定分排序**：优先保留上一批出现过的 IP，并综合 tested、来源数、延迟、丢包、速度排序，减少 DNS 大换血。
- **质量下降保护**：如果本次总池、三网池、真实测速池明显缩水，或核心测速源异常导致线路池减少，保留上一批稳定结果并跳过 DNS 同步，避免错误数据污染线上域名。
- **diff-based DNS sync**：已存在且仍在 wanted 中的记录**不动**，只删托管白名单记录中多余的 A 记录、创建缺失记录，并把最近一次同步结果写入 KV 的 `dns:lastSync`，方便 `/api/stats` 和 `/api/dns/current` 排查。
- **DNS 生效验证**：同步后通过 Cloudflare / Google DoH 检查 `auto/cf/ct/cu/cm` 是否已解析到期望 IP，结果显示在首页、`/admin` 和 `/api/stats`；`dns:lastSync.cfApiRequests` 会记录本次 DNS 查询/写入大致 API 请求量。
- **变更阈值控制**：默认每个域名单次最多替换约 30% 记录，优先保留当前仍可用 A 记录，降低客户端连接波动。
- **管理控制台**：`/admin` 需要 `ADMIN_TOKEN`，可查看 DNS 同步详情、最近错误、7 天趋势、稳定分 Top 20、数据源健康，并支持手动刷新。
- **陈旧数据告警**：超过 8 小时未刷新时，首页、`/admin`、`/health`、`/api/diagnostics` 会明确提示。
- **安全与缓存头**：HTML/API 响应默认 no-store，并带基础安全响应头；`/robots.txt` 避免索引 admin/API。
- **Worker 平台限制**：Cloudflare Workers 禁止从 Worker 出口连接 CF 自家 IP（`connect()` 会失败），所以**本项目不在 Worker 内做 TCP 测速**。`hostmonit 实测` 才代表来源带延迟/丢包/速度；`来源推荐未测` 只代表通过 CF CIDR、地理与稳定分过滤。页面客户端测速只自动测当前线路前 10 个，移动端降低并发，页面隐藏时暂停。
- **手动刷新保护**：`/api/refresh` 默认只接受 `POST + Bearer token`。`ALLOW_PUBLIC_REFRESH=1` 仅建议临时调试；启用后首页和 `/api/stats` 会明确显示公开刷新风险。
- **地理信息补全**：通过 ipwho.is（HTTPS，免费无 key）批量查询 IP 国家/城市/ASN，失败时自动回退到 ip-api.com；补全后会再次执行国家黑名单，未识别国家的 IP 不会被丢弃。
- **DNS 同步历史**：`dns:lastSync` 记录最近一次同步结果，`dns:history:YYYY-MM-DD` 保留 7 天快照，方便 `/api/history` 追踪。
- **运行时配置管理**：`/api/config`（需 `Authorization: Bearer <ADMIN_TOKEN>`）支持 GET 查看、POST 更新运行时配置；GET 默认脱敏，`raw=1` 需要 `X-Config-Raw-Confirm: I_UNDERSTAND`，POST 会校验类型和范围，开启可用性/风险检测等危险项需要 `confirm: "I_UNDERSTAND"`。
- **自适应深色/浅色主题**：首页自动跟随系统 `prefers-color-scheme`，暗色模式为默认，亮色模式自动切换配色。
- **基础 CSP 安全头**：响应头包含 `content-security-policy`，限制 `default-src 'self'`、`script-src 'unsafe-inline'`、`img-src * data:`，防范 XSS。
- **源去重标记**：部分数据源（如 `CMLiussss/*` 与 `addressesapi/*`）属于同一上游但子域不同，`aliasOf/signal` 字段用于统计独立信号；`hostmonit` 标记为核心源，失败时 `/health` 会进入 degraded。

---

## 运维建议

- 正常运行靠 Cron 自动刷新；公开页面上的手动刷新只给持有 `REFRESH_TOKEN` 的管理员使用。管理接口只接受 `Authorization: Bearer ...`，不要把 token 放进 URL 查询参数。
- `CF_API_TOKEN` 只给目标域名 Zone 的 DNS Edit 权限，不要给 Account 全局权限，也不要写进 `wrangler.toml`；只能通过 Cloudflare secret 配置。
- `robots.txt` 只能减少搜索引擎索引，不是访问控制；真正敏感的接口必须依赖 Bearer token 鉴权。
- 如果某个子域 A 记录少于 `DNS_TOP_N`，先看 `/api/dns/current` 的 `lastSync`：没有错误通常代表该运营商候选不足或被 DNS 黑名单过滤。
- 本项目只同步 `auto.`、`cf.`、`ct.`、`cu.`、`cm.` 这组托管白名单 DNS only A 记录，不再自动清理 `proxy.`、`proxyip.`、`pNN.` 等可能被其他服务使用的历史记录。
- 如果某次刷新没有拿到可用 IP，或候选池相比上一批明显变差，Worker 会保留上一批稳定结果，跳过 DNS 同步，避免把可用域名清空或污染。

---

## 📂 项目结构

```
cf-best-ip/
├── src/worker.js   # Worker 入口（模块化，约 2K 行）
├── src/cidr.js     # Cloudflare CIDR 判断纯逻辑
├── src/scoring.js  # 节点质量保护与评分纯逻辑
├── src/dns.js      # DNS diff 计划纯逻辑
├── wrangler.toml   # Cloudflare Workers 配置
├── README.md
└── LICENSE         # MIT
```

---

## 📜 License

MIT

## 验证

```bash
node --test
node scripts/verify-worker.mjs
```

会检查：
- `ipwho.is` HTTPS 替代
- CSP 头
- 管理接口不再接受 URL token
- Cron 偏移
- README 关键说明与代码一致
- 500 响应不暴露 stack
- `/health` 包含 `status/reasons`
- 版本号

## 📖 延伸阅读

- [docs/product-domain-plan.md](docs/product-domain-plan.md) — 产品域名架构规划
- [docs/audit-2026-06-04.md](docs/audit-2026-06-04.md) — 改进建议审计（v3.6.0，58 条）

## 监控

仓库包含 `.github/workflows/health-check.yml`，每 30 分钟请求 `https://bestip.leilaomi.cc.cd/health`，用于发现 Worker、Cron 或数据源异常。
