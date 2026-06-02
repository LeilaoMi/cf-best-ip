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
