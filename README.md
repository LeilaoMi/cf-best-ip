# cf-best-ip · Cloudflare 优选 IP

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)
[![Version](https://img.shields.io/badge/version-3.4-blue)]()

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
| **聚合** | 每 6 小时 Cron 从 19 个社区源拉取候选 IP |
| **校验** | 用 Cloudflare 官方 [`ips-v4`](https://www.cloudflare.com/ips-v4) 的 15 个 CIDR 段做位运算判定,**非 AS13335 段全部丢弃** |
| **测速** | 主数据源 `hostmonit` 在国内三大运营商 VPS 实测延迟+丢包+速度,直接复用 |
| **展示** | 在 `cfip.<你的域名>` 显示 5 个 tab:全部 / 电信 / 联通 / 移动 / 通用 |
| **同步** | 自动写入 4 个子域 A 记录:`cf.` `ct.` `cu.` `cm.` |
| **通知** | Telegram(可选)|

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
19 个社区源 → 并发拉取 → 解析 IP/carrier
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
DNS 同步(diff-based,只动有变化的记录)
cf.<域名> / ct. / cu. / cm. 各 top N
```

---

## 🚀 部署

### 一键(推荐:GitHub Actions 自动)

1. Fork 本仓库
2. Cloudflare Dashboard → Workers & Pages → 创建 Worker → **连接到 Git** → 选你 fork 的仓库
3. 在 Worker → Settings → Variables 添加(下文)
4. 在 Worker → Settings → Triggers → Cron `0 */6 * * *`
5. main 分支任何 push 都会自动重新部署

### 必填环境变量

| 名 | 说明 | 示例 |
|---|---|---|
| `KV` (binding) | KV namespace 绑定,变量名必须叫 `KV` | wrangler 创建后绑定 |
| `CF_API_TOKEN` | CF API Token(Zone:DNS:Edit) | 在 [profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) 生成 |
| `CF_ZONE_ID` | 你域名的 Zone ID | dashboard 域名概览页右下角 |
| `CF_RECORD_NAME` | 主子域名,会同步成 A 记录 | `cf.example.com` |

### 可选环境变量

| 名 | 说明 |
|---|---|
| `CF_DNS_BY_CARRIER` | 设 `1` 启用三网分流(ct./cu./cm./cf. 四子域) |
| `DNS_TOP_N` | 每子域最多写多少条 A 记录,默认 10 |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Telegram 通知 |

---

## 🔌 接口

全部公开,无鉴权:

| 路径 | 说明 |
|---|---|
| `/` | 公开 IP 展示页(uouin 风格) |
| `/api/refresh` | POST 触发一次重新抓取(60s 冷却) |
| `/api/ips` | JSON 全量列表,支持 `?carrier=CT/CU/CM&top=N` |
| `/api/stats` | 池子统计 |
| `/api/dns/current` | 当前 4 子域的 DNS 记录 |
| `/api/history?days=7` | 过去 N 天的快照 |
| `/sub` | 纯文本订阅:`IP:port` 一行一条,可作 DDNS 用 |
| `/api/preferred-ips` | EDT 格式订阅（Karing 等客户端适用） |

---

## 🔧 技术细节

- **CIDR 判定**:`isCfNativeIp()` 把 CF 官方 15 个 CIDR 段预转成 `(network, mask)` 元组,每个 IP 做 1 次位与即判定,O(15) 常数时间。
- **去重 key**:`(ip, port, carrier)` —— 同一 IP 在三网下可作 3 条独立记录(hostmonit 同 IP 同时为 CT 和 CM 最优时不会丢失数据)。
- **diff-based DNS sync**:已存在且仍在 wanted 中的记录**不动**,只删多余/创建缺失,把 Worker 子请求数从 100+ 降到 ~10,避开 Free 计划 50 限制。
- **Worker 平台限制**:Cloudflare Workers 禁止从 Worker 出口连接 CF 自家 IP(`connect()` 会失败),所以**本项目不在 Worker 内做 TCP 测速**,完全依赖 hostmonit 等后端测速数据。

---

## 📂 项目结构

```
cf-best-ip/
├── src/worker.js   # 整个项目的全部代码 (~1580 行,单文件 Worker)
├── wrangler.toml   # Cloudflare Workers 配置
├── README.md
└── LICENSE         # MIT
```

---

## 📜 License

MIT
