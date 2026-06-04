# cf-best-ip 续接记录（2026-06-05 host/root-domain 候选项）

## 任务目标
用户说“继续”。在 v3.8.0 已部署、HEAD 已包含 next-round 文档/verify/DNS-only UI 改动的基础上，继续推进一个默认不改变线上行为的低风险候选项：显式 ROOT_DOMAIN / host 白名单保护。

## 项目路径
`/home/workspace/Projects/cf-best-ip`

## 当前状态
- 分支：`main`
- 当前 HEAD：`b23b79f docs: document API parameters and DNS-only status`
- `origin/main` 已对齐当前 HEAD。
- 工作区起始状态干净。

## 已完成复检
本地验证通过：
```bash
node -c src/cidr.js
node -c src/scoring.js
node -c src/dns.js
node -c src/worker.js
node --test              # 13 passed / 0 failed
node scripts/verify-worker.mjs
 git diff --check
```

线上只读复检通过（未触发刷新、未部署、未改 DNS）：
```text
/health: ok=true,status=ok,reasons=[],total=331,dnsOk=true,criticalSourcesOk=true,lastErrorAt=1780596925208
/api/stats: ok=true,version=3.8.0,total=331,publicRefreshEnabled=false,qualityStats.tested=15,sourceOnly=316,lastDnsSync.ok=true,topN=10
```

## 当前决策
继续做可选保护：新增 `ROOT_DOMAIN` / `ALLOWED_HOSTS` 之类配置时才启用；默认未配置时保持现有线上行为不变。仅本地改代码、README、verify 和必要测试，不部署 Cloudflare、不触发刷新、不改 DNS。

## 下一步准确操作
1. 阅读 `src/worker.js` 中 request host 处理、DNS 根域推断、环境变量解析附近代码。
2. 最小实现：
   - `ROOT_DOMAIN`：DNS carrier 记录派生优先从显式根域生成，避免由错误 `CF_RECORD_NAME` 误推断。
   - `ALLOWED_HOSTS`：如果配置，则非白名单 Host 直接 421/403；未配置则保持兼容。
3. 同步 README 环境变量说明和 `scripts/verify-worker.mjs` 漂移检查。
4. 运行：`node -c ...`、`node --test`、`node scripts/verify-worker.mjs`、`git diff --check`。

## 注意事项
- 不记录任何 token/secret。
- 不执行部署、DNS、刷新等线上变更，除非用户明确确认。
