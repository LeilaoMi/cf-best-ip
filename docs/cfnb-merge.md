# cf-best-ip ⇄ cfnb 对比 & 融合方案

> 对比对象:
> - 本项目:[LeilaoMi/cf-best-ip](https://github.com/LeilaoMi/cf-best-ip) — Cloudflare Workers + KV(JS,1818 行)
> - 参照:[xinyitang3/cfnb](https://github.com/xinyitang3/cfnb) — 本地 Python 工具(409 ⭐,日更)

---

## 1. 架构上的根本差异(理解清楚再融合)

| 维度 | cf-best-ip | cfnb |
|---|---|---|
| 运行环境 | **Cloudflare Workers**(边缘,无状态,KV 持久化) | **本地 Python**(常驻进程 / cron 每 5 分钟) |
| 测速主体 | Worker 内 `cloudflare:sockets` 三次 TCP 握手 | 本地 socket TCP + 本地 curl 实际下载带宽 |
| 测速视角 | "Cloudflare 数据中心 ↔ 各 CF IP"(注意:Worker **禁止连 CF 自家 IP**,这条线天然受限) | "你的本地网络 ↔ CF IP"(真实可达性) |
| 用户访问 | 浏览器直接打开 Worker 域名,网页内 JS 测速 | 跑完写 `ip.txt`,推 GitHub 当订阅链 |
| 部署 | `git push main` → Cloudflare 自动构建(你已配置) | `setup.sh` + cron |

**关键认知:** cfnb 的某些功能在 Worker 上不能 1:1 照搬(比如本地 curl 测带宽、Python 多线程),但**它的筛选/解析/数据源策略可以完美移植**。

---

## 2. 功能对比矩阵

✅ = 已有 / 🟡 = 部分实现 / ❌ = 缺失但值得加 / ⛔ = 平台不适合

| 功能 | cf-best-ip | cfnb | 应该融合? |
|---|:---:|:---:|---|
| 多源聚合 | ✅(6 源) | ✅(3 源) | **合并源** |
| TCP 三次握手测速 | ✅ | ✅ | — |
| **TCP 成功率阈值过滤** | 🟡 单次失败即丢 | ✅ `MIN_SUCCESS_RATE` | **加** |
| **IP 可用性二次检测** (`api.090227.xyz/check`) | ❌ | ✅ | **必加** ★ |
| **IP 风险等级过滤** (`ipapi.is`) | ❌ | ✅(纯净/轻微/高/极度危险) | **必加** ★ |
| 真实带宽测速 | 🟡 Worker 内抽样 256KB | ✅ 本地 curl 500KB | **保持现状** |
| **自适应国家解析** (emoji 国旗 / 中文名 / 混合) | 🟡 仅 colo→country 映射 | ✅ 强大 | **必加** ★ |
| 国家黑名单 (前置) | ✅ `countryBlocklist` | ✅ `PRE_FILTER_BLOCKED_COUNTRIES` | — |
| 国家白名单 | ❌ | ✅ `ALLOWED_COUNTRIES` | **加** |
| **DNS 阶段黑名单** (28 个高风险国家默认屏蔽) | ❌ | ✅ | **加** |
| **IPv6 落地过滤** | ❌ | ✅ | 加(锦上添花) |
| 全局 Top N | ✅ | ✅ | — |
| **分国家 Top N 模式** | ❌ | ✅ `PER_COUNTRY_TOP_N` | **加** |
| Cron 定时 | ✅ 每 6h | ✅ 每 5min | 已差异化 |
| DNS 自动同步 | ✅ + 分运营商 (ct./cu./cm.) | ✅ 原子批量替换 | — |
| 微信通知 (WxPusher) | ❌ | ✅ | **加**(中国用户最实用) |
| Telegram / Discord 通知 | ✅ | ❌ | — |
| GitHub 自动同步 `ip.txt` | ❌(代码在 GitHub,但结果不回写) | ✅ `git_sync.sh/ps1` | 看需求 |
| 订阅格式 V2Ray / Clash / EDT | ✅ | ❌ | — |
| 管理面板 | ✅ 密码保护 | ❌ | — |
| 浏览器在线测速 | ✅ p01-p50 探针槽 | ❌ | — |
| CIDR 扫描 | ✅ | ❌ | — |
| **广告位 / 推广行植入** | ❌ | ✅ header/footer/perline | 看需求(运营用) |
| **ip.txt 携带延迟/带宽** | ❌ | ✅ `IP_TXT_SHOW_BANDWIDTH/LATENCY` | 加(可选开关) |

★ = 强烈建议合入,实质性提升优选质量。

---

## 3. 数据源对照(可立刻合并)

**cf-best-ip 当前 7 个源**(在 `worker.js` `SOURCES` 里):
- `addressesapi.090227.xyz/ip.164746.xyz` `/CloudFlareYes` `/cmcc` `/ct` `/cu`
- `ip.164746.xyz/ipTop.html`
- `api.uouin.com/cloudflare.html`
- `IPDB/proxy`(github raw)

**cfnb 新增 3 个源**(`config.json` `ADDITIONAL_SOURCES`):
- ✨ `https://zip.cm.edu.kg/all.txt` — 教育网视角,带国家代码
- ✨ `https://countrymerge.pages.dev/all.txt` — 分国家合并源
- ✨ `https://wtf-359.pages.dev/wtf.txt` — 多平台聚合,emoji 国旗格式

→ 这 3 个直接加进 `SOURCES`,parser 用新的 adaptive 解析器即可。

---

## 4. 推荐落地优先级

**P0(本轮做)——核心质量提升:**

1. **加 3 个新数据源** + 自适应解析器(emoji 国旗 + 中文名 → 国家代码)
2. **加 IP 可用性二次检测**(`api.090227.xyz/check`):TCP 通过的 IP 再过一遍,确认真能反代
3. **加 IP 风险等级过滤**(`ipapi.is`):DNS 同步前剔除高风险 IP
4. **加 TCP 成功率阈值**:多次探测,成功率 < 阈值的直接淘汰
5. **加 DNS 阶段独立黑名单**(cfnb 默认那 28 个国家)

**P1(下一轮):**

6. 分国家 Top N 模式(切换开关)
7. WxPusher 微信通知(`wxpusher.zjiecode.com/api/send/message`)
8. `ip.txt` 携带延迟/带宽信息开关
9. 国家白名单(默认 OFF,管理面板可开)

**P2(可选):**

10. IPv6 落地过滤
11. 广告位行植入

---

## 5. 在 Workers 环境下的 *不能/不必* 照搬

- ⛔ **本地 curl 带宽**:Worker 没有 curl,不能 `--resolve` SNI 重定向;现有 `cloudflare:sockets` 的 5 KB 抽样测速继续用
- ⛔ **真实带宽 (`speed.cloudflare.com/__down`)**:从 Worker 出口 fetch 这个域,走的是 CF 内网,数据失真;浏览器端在线测速已经覆盖这一项
- ⛔ **subprocess / threading**:Worker 单线程,用 `Promise.all` 并发即可,已在做

---

## 6. 部署影响评估

你的 Worker 已经接上 GitHub:**push 到 main 会触发自动重新构建发布**。所以:

- 改完先在**本地 workspace 里 review**(`/home/workspace/Projects/cf-best-ip-clone/`)
- 确认没问题后,**新建分支** `feat/cfnb-merge` push,在 GitHub 上看 diff 后 merge to main
- 不要直接 push main,避免坏代码瞬间上线

> ⚠️ 现在 gh CLI **未授权**(你之前那个 token 已经泄露,我没用),push 这一步需要你这边:
> - 撤销旧 token: https://github.com/settings/tokens
> - 在 Zo 里点 [Connect GitHub](/?t=settings&s=integrations) 用一次性 code 授权(不需要再贴 token)
