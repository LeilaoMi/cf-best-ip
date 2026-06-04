# CHANGELOG 3.7.0

## 架构与测试

- 将 Cloudflare CIDR 判断拆到 `src/cidr.js`，导出 IPv4/IPv6 纯函数，便于单元测试。
- 将评分、稳定性排序、质量保护和 source health 逻辑拆到 `src/scoring.js`。
- 新增 `test/cidr.test.mjs`，覆盖 IPv4 边界、非法 IP、IPv6 CIDR 和 BigInt 转换。
- 新增 `test/scoring.test.mjs`，覆盖 carrier 归一化、稳定性排序、质量保护、核心源降级和独立信号统计。
- GitHub Actions 的 scheduled test 增加 `node --test`，不再只做字符串 verify。

## 验证

```bash
node -c src/cidr.js
node -c src/scoring.js
node -c src/worker.js
node --test
node scripts/verify-worker.mjs
git diff --check
```
