# cf-best-ip · Cloudflare 优选 IP

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)
[![Version](https://img.shields.io/badge/version-3.0-blue)]()

> 纯 Cloudflare 自家 IP 优选服务,运行在 Cloudflare Workers 上,**不掺反代 IP**。  
> 思路对齐社区主流方案:[uouin.com](https://api.uouin.com/cloudflare.html) / [ipdb.030101.xyz/bestcfv4](https://ipdb.030101.xyz/bestcfv4/) / [cfnb](https://github.com/xinyitang3/cfnb) / [XIU2/CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest)

## 🆚 这是什么,不是什么

| | 是 | 不是 |
|---|---|---|
| IP 来源 | **只**来自 Cloudflare 官方 IPv4 anycast 段(AS13335)| Oracle/Alibaba/AWS 等第三方反代 IP |
| 用途 | 给你的 CF CDN/Pages/Workers 找一组延迟最低的入口 IP | 给被封 CF 的网络做反向代理(那是另一类项目)|
| 测速口径 | hostmonit 在国内三大运营商节点的真实测速(延迟/丢包/速度) | 你本地访问的实际速度(用了之后才知道)|

## ✨ 功能

| | |
|---|---|
| 数据源 | 14 个社区高星 CF 优选源(见下方) |
| 二次校验 | 所有 IP 用 Cloudflare 官方公开 CIDR 段做位运算过滤,非 CF 的丢弃 |
| 测速数据 | hostmonit 在 CT/CU/CM 三大运营商节点的真实延迟、丢包、速度 |
| 三网分类 | 自动按运营商最优路由分组展示 |
| Cron | 默认每 6 小时自动刷新一次,可改 |
| DNS 自动同步 | 推 top-N 到 `cf./ct./cu./cm.<你的域>` 四个子域 A 记录 |
| 公开展示页 | uouin / ipdb 风格的简洁表格,移动端响应式 |
| 订阅接口 | 纯文本 / V2RayN base64 / Clash YAML |
| 通知 | Telegram(可选)|

## 🌐 在线演示

> 部署后的样子可参考社区 [api.uouin.com/cloudflare.html](https://api.uouin.com/cloudflare.html)

## 📡 数据源列表

| 名称 | 类型 | 频率 | 说明 |
|---|---|---|---|
| `hostmonit/三网实测` | POST JSON | 实时 | uouin/ipdb 同款源,带 latency/loss/speed/colo |
| `joname1/BestCFip` | GitHub raw | 每日 | ~100 个,99% 在 CF CIDR 内 |
| `KafeMars/cloudflare_ips` | GitHub raw | 不定期 | 20 个,100% CF |
| `KafeMars/{US,HK,JP,SG,EU}_IP4` | GitHub raw | 不定期 | 按国家/地区分组 |
| `addressesapi/{ip.164746.xyz,CloudFlareYes,cmcc,ct}` | HTTPS | 实时 | 090227.xyz 系列(其 `cu` 端点已停服)|
| `uouin.com/cloudflare` | HTML 抓取 | 实时 | uouin 网页爬取 |
| `ip.164746.xyz/ipTop` | HTTPS | 实时 | 经典最快 IP 列表 |
| `IPDB/bestcf` | GitHub raw | 30 分钟 | ymyuuu/IPDB 的 bestcf.txt(030101.xyz 镜像)|

> 所有来自上面源的 IP **必须**通过 Cloudflare 官方公开的 15 个 IPv4 CIDR 段位运算校验才会入池;
> 落不进 CF anycast 段的(即使来源标了"CF")也会被丢掉。

## 🎯 优选与排序逻辑

1. 拉取 → 解析(自适应识别 emoji 国旗、中文国名、`#CC` 后缀、`#运营商-XX` 等)
2. 去重(同 IP 多 carrier 各保留一行,以便分别上 ct/cu/cm DNS)
3. **CIDR 二次校验** —— 这是核心安全网,把 countrymerge 等混合源里的非-CF IP 全删
4. 排序:`tested=true`(有 hostmonit 测速数据)优先 → `delay` 升序 → 出现源数降序
5. 顶部 N 推 DNS,前 30 在网页展示

## 🚀 部署

### 方式一:Workers Builds(推荐 · 我用的)

1. Fork 本仓库到你的 GitHub
2. 在 Cloudflare 控制台 **Workers & Pages → 创建 Worker → 从 Git 导入**
3. 选你刚 fork 的仓库,构建命令留空
4. 在 Worker 的 **Settings → Variables and Secrets** 加入:

| 变量名 | 类型 | 说明 |
|---|---|---|
| `CF_API_TOKEN` | 密钥 | 创建 token:Zone → DNS → Edit,scope 选你的域 |
| `CF_ZONE_ID` | 文本 | 你的域的 Zone ID(Cloudflare 域名 Overview 页右下角)|
| `CF_RECORD_NAME` | 文本 | 主子域,比如 `cf.yourdomain.com` |
| `CF_DNS_BY_CARRIER` | 文本 | `1` = 同时写 ct./cu./cm. 子域;空 = 只写主子域 |
| `DNS_TOP_N` | 文本 | 每个子域写几条 A 记录,推荐 10 |
| `TELEGRAM_BOT_TOKEN` | 密钥 | 可选,留空就不发 TG |
| `TELEGRAM_CHAT_ID` | 密钥 | 可选 |

5. 添加 **Cron 触发器**: `0 */6 * * *`(每 6 小时)

每次 `git push main` Cloudflare 自动构建并替换 Worker。

### 方式二:wrangler

```bash
git clone https://github.com/LeilaoMi/cf-best-ip.git
cd cf-best-ip
npm i -g wrangler
wrangler login
wrangler kv:namespace create cf_best_ip
# 把返回的 id 填到 wrangler.toml
# secrets:
wrangler secret put CF_API_TOKEN
wrangler secret put TELEGRAM_BOT_TOKEN  # 可选
wrangler secret put TELEGRAM_CHAT_ID    # 可选
wrangler deploy
```

## 📑 路由一览

| 路径 | 用途 |
|---|---|
| `/` | 公开展示页(全部 / 电信 / 联通 / 移动 四个 tab)|
| `/api/ips` | JSON 列表,支持 `?carrier=CT&top=10` 等过滤参数 |
| `/api/stats` | 池子统计(总数、按 carrier 分布、各源拉取情况)|
| `/api/refresh` | POST 触发立即抓取(60 秒冷却)|
| `/api/probe?ip=` | 单 IP TCP 测速(注意:Workers 不能连 CF IP,只对非-CF 有意义)|
| `/api/dns/current` | 查 CF 上当前 4 个子域的 A 记录 |
| `/sub` | 纯文本订阅 |
| `/sub/edt` | EdgeTunnel 兼容格式 |

## 🌐 子域名(部署后会自动同步)

| 子域 | 内容 |
|---|---|
| `cf.<你的域>` | 全部 CF 优选 top N |
| `ct.<你的域>` | 电信 top N(hostmonit 的 CT 数据)|
| `cu.<你的域>` | 联通 top N(hostmonit 的 CU 数据)|
| `cm.<你的域>` | 移动 top N(hostmonit 的 CM 数据)|

> **不再有 `proxy.` 子域** —— 反代 IP 是另一类项目,本仓库不再混在一起。从 v2.x 升级时会自动删除遗留的 `proxy.*` A 记录。

## 🌐 关于 IP 国家

页面**不显示** IP 国家列,因为 Cloudflare 是 anycast 网络:同一个 IP 同时在全球数据中心广播。不同 GeoIP 服务商对同一个 IP 给出不同国家答案是常态,显示反而误导。延迟和速度才是与你网络相关的可信指标。

## 🙏 致谢

- [xinyitang3/cfnb](https://github.com/xinyitang3/cfnb) - 三网分类思路 / 国家过滤 / CIDR 列表参考
- [ymyuuu/IPDB](https://github.com/ymyuuu/IPDB) - bestcf 数据源
- [joname1/BestCFip](https://github.com/joname1/BestCFip) - 日更 CF 优选 IP
- [KafeMars/best-ips-domains](https://github.com/KafeMars/best-ips-domains) - 多区域 CF IP 池
- [api.hostmonit.com](https://stock.hostmonit.com/) - 真实三网测速数据
- [api.uouin.com](https://api.uouin.com/cloudflare.html) - UI 设计参考
- [ipdb.030101.xyz](https://ipdb.030101.xyz/bestcfv4/) - UI 设计参考
- [XIU2/CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest) - 测速思路启蒙

## 📄 License

MIT
