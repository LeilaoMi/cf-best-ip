# cf-best-ip 下一轮安全增强计划（2026-06-05）

> 基于上一轮剩余项继续推进。  
> 本轮原则：只做低风险安全增强；不部署 Cloudflare、不改 DNS、不触发线上刷新。

## 阶段 A：域名边界保护（优先）

### 目标
避免配置错误时误同步到非目标域名，降低误删/误写 DNS 记录风险。

### 任务
- 新增 `ROOT_DOMAIN` 可选变量，用于显式声明托管根域。
- DNS 同步前校验所有托管记录必须属于 `ROOT_DOMAIN`。
- 若未配置 `ROOT_DOMAIN`，保持旧逻辑：从 `CF_RECORD_NAME` 推导根域，避免破坏现有部署。

### 验收
- `getManagedDnsNames()` 只返回根域下的 `auto/cf/ct/cu/cm`。
- 配置错误时返回明确错误，不进入批量 DNS 写入。

## 阶段 B：访问 Host 白名单（低风险可选）

### 目标
限制 Worker 只响应预期入口域名，减少被随机域名/预览域名扫到的风险。

### 任务
- 新增 `ALLOWED_HOSTS` 可选变量，逗号分隔。
- 若配置了 `ALLOWED_HOSTS`，请求 `Host` 不在白名单时返回 `421 host-not-allowed`。
- 未配置时保持现状，避免影响 Cloudflare 默认域或调试入口。

### 验收
- 不配置 `ALLOWED_HOSTS` 时完全兼容旧行为。
- 配置后只允许指定域名访问。

## 阶段 C：敏感 DNS 诊断接口鉴权

### 目标
`/api/dns/current` 会暴露托管 DNS 记录和同步状态，改为管理接口更安全。

### 任务
- `/api/dns/current` 增加 `ADMIN_TOKEN` Bearer 鉴权。
- README 明确该接口需要管理 token。
- verify 脚本加入漂移检查。

### 验收
- 无 `Authorization: Bearer <ADMIN_TOKEN>` 时返回 401。
- 管理控制台仍可查看 DNS 状态。

## 阶段 D：验证与提交

### 必跑验证
```bash
node -c src/cidr.js
node -c src/scoring.js
node -c src/dns.js
node -c src/worker.js
node --test
node scripts/verify-worker.mjs
git diff --check
```

### 不做事项
- 不部署线上 Worker。
- 不改 Cloudflare DNS。
- 不触发 `/api/refresh`。
- 不改 GitHub Actions 触发策略。
