# cf-best-ip 产品级优选域名方案

## 目标

把 `cf-best-ip` 从“技术脚本/展示页”升级成一个更好用、更稳定、更容易排障的优选域名产品。

核心原则：

1. **入口和优选池分离**：Worker 管理页/API 不再使用会被同步成 Cloudflare 优选 IP 的域名。
2. **新手只记一个域名**：默认推荐 `auto.leilaomi.cc.cd`。
3. **高级用户有明确分流**：电信/联通/移动分别使用 `ct/cu/cm.leilaomi.cc.cd`。
4. **不追求每次最快，优先稳定**：避免 DNS 每次刷新大幅波动；数据源异常时保留上一批可用结果。
5. **状态透明**：页面直接显示刷新状态、DNS 同步状态、各池数量和失败原因。

## 推荐域名体系

| 域名 | 角色 | 是否作为优选 IP A 记录池 | 推荐使用者 |
|---|---|---:|---|
| `bestip.leilaomi.cc.cd` | Worker 管理页 / API / 状态页 | 否 | 管理员、查看状态的人 |
| `auto.leilaomi.cc.cd` | 默认自动推荐池 | 是 | 新手、默认推荐 |
| `cf.leilaomi.cc.cd` | 通用优选池 | 是 | 不区分运营商的客户端 |
| `ct.leilaomi.cc.cd` | 电信优选池 | 是 | 中国电信线路 |
| `cu.leilaomi.cc.cd` | 联通优选池 | 是 | 中国联通线路 |
| `cm.leilaomi.cc.cd` | 移动优选池 | 是 | 中国移动线路 |
| `backup.leilaomi.cc.cd` | 备用池（后续） | 是 | 故障兜底 |

## 第一阶段实现

本阶段优先解决当前线上 Error 1000 和误删风险，不引入复杂功能。

### 1. 域名角色分离

新增配置：

- `SERVICE_HOSTNAME=bestip.leilaomi.cc.cd`：仅用于页面展示和生成 API/订阅链接。
- `AUTO_RECORD_NAME=auto.leilaomi.cc.cd`：默认推荐池。
- `CF_RECORD_NAME=cf.leilaomi.cc.cd`：通用优选池。

Worker 自身应绑定到 `bestip.leilaomi.cc.cd`，不要绑定到 `cf.leilaomi.cc.cd`。

### 2. DNS 同步安全保护

只允许同步白名单里的记录：

- `auto.leilaomi.cc.cd`
- `cf.leilaomi.cc.cd`
- `ct.leilaomi.cc.cd`
- `cu.leilaomi.cc.cd`
- `cm.leilaomi.cc.cd`

不再自动删除 `proxy.*`、`proxyip.*`、`pNN.*` 这类历史记录，避免误删用户另有用途的 DNS。

### 3. 数据源异常保护

如果某次刷新没有拿到可用 IP：

- 不覆盖 KV 里的上一批 `ips:latest`
- 不清空 DNS
- 返回明确错误，页面/API 可显示“继续使用上一批稳定 IP”

### 4. 页面体验

首页顶部直接给推荐：

- 检测运营商后推荐 `ct/cu/cm`
- 检测不到时推荐 `auto`
- 提供一键复制域名、订阅链接、API 链接
- 显示最近刷新、DNS 同步状态、各池数量

## 后续阶段

### 第二阶段：稳定分

为每个 IP 增加稳定评分：

- 连续出现次数
- 来源数量
- hostmonit 延迟/丢包/速度
- 最近 N 次是否波动
- 运营商匹配度

DNS 同步按稳定分排序，而不是只看单次排序。

### 第三阶段：更多地域池

可选新增：

- `hk.leilaomi.cc.cd`
- `jp.leilaomi.cc.cd`
- `sg.leilaomi.cc.cd`
- `us.leilaomi.cc.cd`

但这一步不建议一开始做，避免 DNS 和页面复杂度过高。

## 部署注意事项

部署或修改 Cloudflare DNS/Worker 自定义域名前，必须二次确认。

建议最终 Cloudflare 侧设置：

- `bestip.leilaomi.cc.cd` → Worker 自定义域名 / route
- `auto/cf/ct/cu/cm.leilaomi.cc.cd` → DNS only A 记录，由 Worker 自动维护

如果 `bestip.leilaomi.cc.cd` 使用 Cloudflare 托管，应避免让 DNS 同步逻辑触碰它。


## 已实现的稳定性提升

### 稳定分排序

刷新后会为每个 IP 计算稳定分，排序时优先考虑：

- 上一批是否出现过
- 是否来自真实测速源
- 来源数量
- 延迟、丢包、速度

目的不是每次追求绝对最快，而是减少 DNS 大换血，让客户端连接更稳定。

### 质量下降保护

如果上一批数据足够大，但本次结果明显缩水，Worker 会：

1. 保留上一批 `ips:latest`
2. 写入 `refresh:lastError`
3. 跳过 DNS 同步

触发条件包括：

- 总池低于上一批 60%
- 某个三网池低于上一批 40%

### DNS 生效检查

DNS 同步后会通过 Cloudflare DoH 和 Google DoH 检查托管域名是否已有期望 A 记录。结果写入 `dns:lastSync.verification`，并在首页“最近一次 DNS 同步”区域展示。


### 管理控制台

`/admin` 已提供：

- 手动刷新
- 最近错误
- DNS 同步详情
- 7 天趋势
- 稳定分 Top 20
- 数据源健康

### DNS 变更阈值

默认 `DNS_MAX_CHANGE_RATIO=0.3`。如果某个域名已经有 A 记录，每次刷新优先保留仍在候选池中的旧记录，并最多替换约 30%，避免客户端连接目标频繁大换血。

### 使用指南

首页已增加“怎么用”区域：新手用 `auto`，三网用户按 `ct/cu/cm`，高级用户用 `/sub` 或 `/api/preferred-ips`。


### 健康检查与诊断

新增：

- `/health`：轻量探活，数据陈旧或 DNS 同步失败时返回非健康状态。
- `/api/diagnostics`：导出诊断快照，包含节点数、三网分布、数据源健康、陈旧状态、DNS 同步和最近错误。
- `/robots.txt`：允许首页，禁止 admin/API/订阅被索引。

### 陈旧数据告警

如果 `ips:latest.updatedAt` 距今超过 8 小时，首页和 `/admin` 会显示告警，便于发现 Cron 或数据源异常。

### 响应头

HTML/API 默认 `no-store`，并添加 `x-content-type-options`、`referrer-policy`、`x-frame-options`，避免缓存旧状态并提升基础安全性。


### 管理权限保护

`/admin` 和 `/api/diagnostics` 已使用 `ADMIN_TOKEN` 保护。`/api/refresh` 同时接受 `REFRESH_TOKEN` 或 `ADMIN_TOKEN`。

首次进入可使用 `/admin?token=<ADMIN_TOKEN>`，页面会把 token 保存在当前浏览器 sessionStorage，并移除地址栏中的 token。

### 外部健康监控

已新增 GitHub Actions 工作流 `.github/workflows/health-check.yml`，每 30 分钟请求 `/health`。如果健康检查返回非 2xx 或 `.ok != true`，工作流会失败。
