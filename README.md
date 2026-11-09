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
| `ECH_REPORT_TOKEN`（secret） | 可选 | ECH 探测器上报 `POST /api/ech-report` 的独立 Token；不配置则该接口返回 503（禁用）。也让探测器读 `/api/ips` 时放宽到 2000 行（见下文） |
| `ECH_REPORT_RATE_LIMIT` | 可选 | `/api/ech-report` 每 IP 每分钟次数，默认 10，`0` 关闭 |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | 可选 | 刷新结果和告警推送 |

`wrangler.toml` 里声明了 `REFRESH_LOCK` Durable Object 作为刷新锁；没有绑定时自动退回 KV 锁。

---

## 接口

| 路径 | 鉴权 | 说明 |
|---|---|---|
| `/` | — | 展示页，四种主题；`?plain=1` 极简页 |
| `/sub`（`/sub.txt` `/ips.txt` `/api/ips.txt`） | 限流 | 订阅，默认 `IP:端口#colo-运营商`，支持 `format=plain/csv/jsonl` |
| `/api/preferred-ips` | — | 纯 `IP:端口` 列表（Karing 等） |
| `/api/ips` | 限流，可选 Token | JSON 列表，含 `_score`、`quality`、`refDelay`、`ech`；`?ech=1` 排除 ECH 受限 IP |
| `/api/stats` | — | 池子统计、数据源状态、最近一次 DNS 同步 |
| `/api/history?days=7` | — | 每日快照，最多 30 天 |
| `/health` | — | 健康检查：`status`、`reasons`、`dnsOk`、`dnsRateLimited`、`sourceHealth` |
| `POST /api/refresh` | `REFRESH_TOKEN` / `ADMIN_TOKEN` | 立即刷新，60 秒冷却 |
| `POST /api/ech-report` | `ECH_REPORT_TOKEN` | ECH 探测器上报结果，见下文「ECH 可用性打标」 |
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
| `top=50` / `limit=50` | 返回数量，默认 20，最多 200（仅 `/api/ips` 带有效 `ECH_REPORT_TOKEN` 时最多 2000） |
| `comment=0` | 订阅不带 `#备注` |
| `ech=1` | 仅 `/api/ips`：排除 `ech === false` 的 IP（`true` 与 `null` 保留），在 `limit` 之前生效 |

示例：

```bash
# 联通前 10 个
curl "https://bestip.example.com/sub?carrier=CU&top=10"

# 手动刷新
curl -X POST -H "Authorization: Bearer $REFRESH_TOKEN" https://bestip.example.com/api/refresh
```

---

## ECH 可用性打标

池子里约 10% 的 Cloudflare IP（常见于 `108.162.198.x`、`162.159.x`、`198.41.208-209.x`）在客户端**带 ECH** 访问 Free 计划站点时返回 Cloudflare `1034 Edge IP Restricted`，不带 ECH 则正常。这些 IP 对非 ECH 用户仍然可用，所以**不从池子删除，只打标**。

- 外部探测器（GitHub Actions）定期带 ECH 实测每个 IP，把结果 `POST` 到 `/api/ech-report`；Worker 合并进 KV 键 `ech:status`。
- `/api/ips` 每行增加 `ech` 字段：
  - `true`：36 小时内实测带 ECH 可用；
  - `false`：36 小时内实测带 ECH 会被 1034 拒绝；
  - `null`：没有记录、结果为 unknown、或已超过 36 小时（KV 读取失败时也一律为 `null`，接口不会因此报错）。
- `/api/ips?ech=1` 排除 `ech === false` 的行，适合给开了 ECH 的客户端用。通用池、DNS 同步、评分、`/sub` 系订阅都不受影响。
- 探测器取全池：`/api/ips` 请求带 `Authorization: Bearer <ECH_REPORT_TOKEN>`（常量时间比较）时，`limit` 上限从 200 放宽到 2000，例如 `/api/ips?limit=2000&perCountry=0`。
  - 只放宽行数：限流（`API_IPS_RATE_LIMIT`）、筛选参数、输出格式都不变；`/sub` 系订阅和 `/api/preferred-ips` 仍最多 200。
  - 默认（未开 `API_IPS_REQUIRE_TOKEN`）：Token 错误、为空或用 `?token=` 传入时**按公共请求处理**（最多 200 行，不返回 401）；未配置 `ECH_REPORT_TOKEN` 时没有任何请求能放宽。
  - 开了 `API_IPS_REQUIRE_TOKEN=1` 时：`ECH_REPORT_TOKEN` 也可用来读 `/api/ips`（只读）；缺失或错误的 Token 仍按该开关返回 `401`（不会退化成公共请求）。

### `POST /api/ech-report`

```bash
wrangler secret put ECH_REPORT_TOKEN   # 随机长串；与 GitHub Actions secret ECH_REPORT_TOKEN 同值
```

- 鉴权：`Authorization: Bearer <ECH_REPORT_TOKEN>`（常量时间比较）。这是独立 secret，`ADMIN_TOKEN` / `REFRESH_TOKEN` **不能**用于此接口；未配置时接口返回 `503 ech-report-disabled`。
- 同样受 `ALLOWED_HOSTS` 限制，并按 `ECH_REPORT_RATE_LIMIT` 限流（鉴权通过后才计数）。
- Body（JSON，最大 256 KB，`results` 最多 2000 条）：

```json
{
  "runId": "123456789",
  "sentinels": ["doh.example.com", "www.cloudflare.com"],
  "results": [
    { "ip": "162.159.136.89", "status": "restricted" },
    { "ip": "104.16.0.195", "status": "ok" },
    { "ip": "2606:4700::1", "status": "unknown" }
  ]
}
```

- `ip` 严格校验 IPv4 / IPv6（IPv6 按 RFC 5952 规范化）；`status` 只能是 `ok` / `restricted` / `unknown`；`runId` 为 `[A-Za-z0-9._:-]`，最长 128。
- 合并规则（KV `ech:status` = `{updatedAt, runId, sentinels, ips: {"<ip>": {s, t}}}`，`t` 为毫秒时间戳）：
  - `ok` / `restricted` 覆盖旧结论；
  - `unknown` 不覆盖已有的 `ok` / `restricted`，只在没有记录时写入；
  - 7 天未更新的条目自动清理；总条目超过 10000 时丢弃最旧的（多次上报不相交的 IP 集合也不会让 `ech:status` 无限增长）。
- 返回：`{"ok": true, "accepted": 2, "counts": {"ok": 1, "restricted": 1, "unknown": 1}, "stored": 280, "pruned": 0}`。
- KV 读取失败返回 `503 kv-read-failed`；写入失败（如两次上报间隔不足 1 秒触发 KV 同 key 写入限制）返回 `503 kv-write-failed` 并带 `retry-after: 2`，这次上报**未**写入，稍后重试即可；不会返回 500，也不会在未写入时报成功。

### 探测器：`tools/ech-probe` + Actions `ECH Probe`

Go 程序（Go ≥ 1.24，只用标准库，`crypto/tls` 的 `EncryptedClientHelloConfigList`），由 `.github/workflows/ech-probe.yml` 每 6 小时 UTC 第 45 分钟运行（池子 :15 刷新后 30 分钟），也可手动运行（可勾选 `dry_run`）。

流程：

1. （HTTP 客户端拒绝任何跳出 https 的重定向，Token 不会明文外泄）带 `Authorization: Bearer <ECH_REPORT_TOKEN>` 一次请求 `/api/ips?limit=2000&perCountry=0` 取全池（不带 `ech` 过滤），只留 IPv4、去重。Worker 只对有效 Token 放宽到 2000 行；不带 Token（如本地 dry-run）或 Worker 尚未部署这项改动时最多 200 行。返回行数少于池子总数、或正好达到 2000 行上限时会打印 `warn:`，未取到的 IP 本轮不探测（它们的旧标记 36 小时后变回 `null`）。
2. 对每个哨兵主机名经 DoH（`https://cloudflare-dns.com/dns-query`，RFC 8484 wireformat，TYPE65）取 HTTPS 记录里的 `ech` 配置；哨兵本身没发布 ECH 时（如 `www.cloudflare.com`）借用 `cloudflare-ech.com` 的配置（Cloudflare 全网共用这一把 ECH key）。
   - 每个哨兵都必须取到 ECH 配置（自身或 `-ech-fallback` 借用）；任一哨兵取不到时整次运行失败、不上报（少了最严格的哨兵会把受限 IP 误判成 `ok`）。
3. 对每个 IP × 哨兵：TCP 连 `IP:443`，SNI = 哨兵，带 ECH 做 TLS 1.3 握手，`GET /cdn-cgi/trace`：
   - 响应体匹配带单词边界的 `error code: 1034`（`10345` 不算）或含 `Edge IP Restricted` → `restricted`；
   - 403 且响应体匹配带单词边界的 `Error 1034` / `error code: 1034`（不区分大小写）→ `restricted`；仅在 Ray ID 等位置出现数字 `1034` **不算**；
   - 拿到其它任何 HTTP 响应 → `ok`；
   - 超时 / 连接 / 握手错误重试 1 次仍失败 → `unknown`（网络错误永远不会判成 `restricted`）。
4. 单 IP 结论：任一哨兵 `restricted` → `restricted`；全部 `ok` → `ok`；否则 `unknown`。并发 16，单次 8 秒超时。
5. 护栏：`restricted` 占比 > 50% 或 `unknown` 占比 > 30% 视为探测环境异常，非零退出、不上报。否则带 `runId = GITHUB_RUN_ID` 上报。

需要的设置：

| 位置 | 名称 | 说明 |
|---|---|---|
| Actions variable | `ECH_API_BASE` | **必填**，你自建 Worker 的 HTTPS 地址（如 `https://bestip.example.com`，不带路径）。取池子和上报都用它，上报会带 Token，所以**没有默认值**；未设置或不是 `https://` 时工作流（含 dry-run）直接失败并提示 |
| Actions secret | `ECH_REPORT_TOKEN` | 必填，与 Worker secret `ECH_REPORT_TOKEN` 同值；缺失时工作流直接失败并提示。勾选 dry_run 时可不填，但只能取到 200 行；若 Worker 开了 `API_IPS_REQUIRE_TOKEN=1`，无 Token 读 `/api/ips` 会 401，dry-run 也必须提供 |
| Actions variable | `ECH_SENTINELS` | 可选，逗号分隔的哨兵主机名；默认 `doh.leilaomi.ccwu.cc,www.cloudflare.com`。哨兵应选**开着 ECH 的 Free 计划站点**（最严格），`www.cloudflare.com` 只作补充 |

> **Cloudflare 安全功能可能拦截 Actions 的上报**（403 / 质询页，工作流会以 `report HTTP 403` 失败；连续失败超过 36 小时后 `ech` 标记会全部变回 `null`）。按 Worker 域名所在 zone 开启的功能分别处理：
>
> - **Bot Fight Mode**（免费版「机器人攻击模式」）：WAF 自定义规则**无法**跳过它（[Cloudflare 文档](https://developers.cloudflare.com/waf/custom-rules/skip/options/)）。如果它拦截了上报，只能在「安全性 → 机器人」里关闭 Bot Fight Mode，或升级到 Super Bot Fight Mode 后用下面的 Skip 规则。
> - **Super Bot Fight Mode**：加一条 WAF 自定义规则，表达式 `(http.host eq "bestip.example.com" and http.request.uri.path eq "/api/ech-report" and http.request.method eq "POST")`（`bestip.example.com` 换成你的 Worker 主机名，避免同 zone 其它站点的同名路径也被匹配），动作 **Skip**，只勾选「All Super Bot Fight Mode rules」。
> - **WAF 托管规则误拦**：**不要**勾选「All managed rules」（那会让匹配的请求跳过全部攻击检测）。在「安全性 → 事件」里找到拦截它的具体托管规则 ID，只为这些规则 ID 在托管规则集上加例外（Skip 指定规则），条件同样带上 `http.host` + 路径 + 方法。
> - **取池子的 `GET /api/ips` 也被拦**（工作流在上报前就以 `fetch pool: ... HTTP 403` 失败）：确认是 bot 类误拦后，把上面的表达式扩成 `http.host eq "bestip.example.com" and ((http.request.uri.path eq "/api/ech-report" and http.request.method eq "POST") or (http.request.uri.path eq "/api/ips" and http.request.method eq "GET"))`，跳过范围同样只限上面两类（Super Bot Fight Mode、具体误拦的托管规则 ID）。`/api/ips` 是公开读接口，Worker 内限流（`API_IPS_RATE_LIMIT`）照常生效。
> - **速率限制规则：不要跳过。** 上面的表达式只按路径和方法匹配，任何人都能构造出这样的请求，跳过速率限制等于让未鉴权的请求绕过边缘限流。探测器每 6 小时只发 1 次上报（取池子 1 次），正常的边缘限流不会挡住它；如果确实被限流，请放宽该规则的阈值，而不是对这条路径整体 Skip。
> - **Browser Integrity Check / Security Level** 等非规则引擎产品：同一条 Skip 规则里在「More components to skip」中勾选对应产品（同样只为 bot 类误拦）。
>
> 接口本身仍有独立 Token 鉴权（`ECH_REPORT_TOKEN`）和 Worker 内限流，并保留边缘限流与其余托管规则；只跳过 bot 类检查和具体误拦的规则，不会让它变成公开写入口。

本地运行：

```bash
cd tools/ech-probe
go test ./...
go run . -dry-run -v -ips 162.159.136.89,104.16.0.195   # 指定 IP，打印每次握手结果（不需要 -api）
go run . -dry-run -api https://bestip.example.com       # 取池子探测，只打印汇总（无 Token 时最多 200 行；Worker 开了 API_IPS_REQUIRE_TOKEN=1 时会 401，需带 Token）
ECH_REPORT_TOKEN=... go run . -dry-run -api https://bestip.example.com   # 带 Token 取全池，只打印汇总
ECH_REPORT_TOKEN=... go run . -api https://bestip.example.com            # 探测全池并上报
```

`-api`（或环境变量 `ECH_API_BASE`）**没有默认值**，必须是你自建 Worker 的 `https://` 地址；只有「`-dry-run` + `-ips`」这种既不取池子也不上报的用法可以省略。

其它参数：`-sentinels`、`-path`（默认 `/cdn-cgi/trace`）、`-concurrency`、`-timeout`、`-doh`、`-ech-fallback`、`-max-restricted`、`-max-unknown`，见 `go run . -h`。

---

## 监控与告警

- **GitHub Actions `Health Check`**：每 30 分钟请求一次 `/health`，失败重试 3 次。可在仓库变量 `HEALTH_URL` 里改地址。
- **GitHub Actions `Scheduled Test`**：运行单元测试和 `scripts/verify-worker.mjs`。
- **GitHub Actions `ECH Probe`**：每 6 小时带 ECH 探测池子并上报 `/api/ech-report`，汇总写在运行页的 Summary 里。
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
node --test                      # 单元测试：CIDR、DNS 差量计划、评分与质量保护、ECH 打标
node scripts/verify-worker.mjs   # 静态检查：安全头、鉴权、版本号、README 与配置一致
```

## 项目结构

```
src/worker.js    Worker 入口：数据源、聚合、接口、页面、DNS 同步
src/cidr.js      Cloudflare 官方 CIDR 判断
src/scoring.js   稳定分、质量保护、源健康统计
src/dns.js       DNS 差量计划
src/ech.js       ECH 打标：上报校验、合并、/api/ips 的 ech 字段
tools/ech-probe/ ECH 探测器（Go，GitHub Actions 定时运行）
scripts/verify-worker.mjs
test/
wrangler.toml
```

## License

MIT
