# Cloudflare 优选 IP 项目调研与对比

> 收集了网络上较活跃的几类 CF 优选 IP 项目，归纳其架构、优点与短板，最终融合出本项目的设计。

## 1. 主流项目盘点

### 1.1 [XIU2/CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest)（CFST）—— 鼻祖工具

- **形态**：Go 语言命令行（Win/Linux/Mac/路由器都能跑）
- **核心流程**：扫描 Cloudflare 官方 IP 段 → TCPing 延迟 → HTTPing 校验 → 下载测速 → 输出 `result.csv`
- **优点**
  - 真实下载测速，结果最贴近实际体验
  - 跨平台、参数丰富、社区生态完整（OpenWrt 插件、安卓 APP）
- **短板**
  - 只能本地跑，无法"托管"
  - 一次性脚本，不会自动同步到 DNS / 订阅
  - 在国内运行需要规避代理污染测速

### 1.2 [xinyitang3/cfnb](https://github.com/xinyitang3/cfnb) —— 全自动化集大成者

- **形态**：Python 程序 + cron / 计划任务
- **核心三步**
  1. 从多个公开数据源聚合候选节点
  2. TCP 延迟筛选 + IP 可用性二次检测 + 真实带宽测速
  3. 自动写入 Cloudflare DNS A 记录、推送到 GitHub 仓库、WxPusher 通知
- **优点**
  - 闭环：从抓取 → 测速 → 落地 DNS → 推送通知
  - 多源聚合策略成熟
- **短板**
  - 仍然依赖一台能跑 Python 的服务器
  - 用户量大时容易把带宽测速搞成"DDoS 自己"

### 1.3 Cloudflare Workers 版（"CF Workers 优选 IP 重制版"等）

- **形态**：单文件 Worker + KV
- **核心**：抓公开源 → 存 KV → 提供网页 + 订阅接口
- **优点**
  - 零服务器，跑在 CF 边缘
  - 部署只要复制粘贴
- **短板**
  - 多数版本只做"中转"，没有自己的测速 / 校验
  - 没有 DNS 同步

### 1.4 [cmliu/edgetunnel (EDT 2.0)](https://github.com/cmliu/edgetunnel) —— 节点协议生态

- **形态**：Worker，主打 vless / trojan over WebSocket
- **核心**：把优选 IP 作为节点配置的一部分，提供 `/api/preferred-ips` 让客户端自取
- **优点**
  - 大量翻墙客户端原生支持其 API 格式
  - 自带订阅生成
- **短板**
  - 测速逻辑较弱，更多依赖外部源
  - 单 Worker 文件 4000+ 行，二次开发门槛高

### 1.5 [ymyuuu/IPDB](https://github.com/ymyuuu/IPDB)

- **形态**：GitHub Pages + 定时 Action
- **核心**：每天测速并发布 `bestcf.txt` / `proxy.txt` 等纯文本，供其他项目直接消费
- **优点**：人人都能 `curl` 拿数据
- **短板**：作为消费方时无法选地区 / 自定义

### 1.6 hostmonit / stock.hostmonit.com 等"网页榜单"

- **形态**：纯网页榜单，每小时自动测速
- **优点**：开箱即用，可直接复制 IP
- **短板**：商业站，依赖人家不挂

## 2. 对照表

| 项目 | 部署 | 多源聚合 | 自带测速 | 订阅 | DNS 同步 | 网页 UI |
|---|---|---|---|---|---|---|
| CFST | 本地 CLI | ❌ | ✅ 下载测速 | ❌ | ❌ | ❌ |
| cfnb | Python 服务 | ✅ | ✅ TCP + 带宽 | ✅ | ✅ | ❌ |
| CF Workers 重制版 | Workers | ✅ | ⚠️ 弱 | ✅ | ❌ | ✅ |
| EdgeTunnel | Workers | ⚠️ 简 | ❌ | ✅ | ❌ | ⚠️ |
| IPDB | GitHub Action | ✅ | ✅ | ✅ | ❌ | ❌ |
| **本项目 (cf-best-ip)** | **Workers / zo.space** | ✅ 7 源 | ✅ TCP 三次握手 | ✅ txt + JSON + EDT | ✅ CF API batch | ✅ 一键测速 |

## 3. 本项目的设计取舍

| 我们参考自 | 决策 |
|---|---|
| CFST | 用 **TCP 三次握手**（不是 ICMP）做延迟测，因为 HTTPS 也是 TCP 握手起步 |
| cfnb | 抄"多源聚合 + 命中次数加权"的去重思路 |
| CF Workers 重制版 | Worker + KV 托管 + 网页 UI，零服务器 |
| EdgeTunnel | 提供 `/api/preferred-ips` 兼容端点，方便接入老客户端 |
| IPDB | 直接消费它的 `proxy.txt` 作为其中一个源 |

**额外加了什么**：

- Worker 用 `cf.resolveOverride` 让 subrequest 走指定 IP，相当于"在边缘做 HTTPing"，比 GitHub Action 跑得稳；
- DNS 同步用 CF `dns_records/batch` 原子接口，没有"刚删完旧的、新的没写上"的窗口期；
- 同一份逻辑提供 **Cloudflare Workers** 和 **zo.space (Hono + React)** 两种部署形态，按需选。
