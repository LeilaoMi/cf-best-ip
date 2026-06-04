# CHANGELOG 3.8.1

## 安全增强包 1

- `/api/refresh` 增加 `refresh:running` 运行锁，降低并发重复刷新风险。
- 管理页和首页手动刷新 token 不再写入 `sessionStorage`，仅保存在当前页面 JS 内存。
- `/api/config` 支持 `export=1` 导出配置；POST 可直接写 patch，也可提交 `{ config: { ... } }` 导入配置，仍保留类型校验和危险项确认。
- README 与 verify 同步安全增强项。

## 验证

```bash
node -c src/cidr.js
node -c src/scoring.js
node -c src/dns.js
node -c src/worker.js
node --test
node scripts/verify-worker.mjs
git diff --check
```
