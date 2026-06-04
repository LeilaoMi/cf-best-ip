# CHANGELOG 3.8.3

## 安全增强包 2

- 新增 `ROOT_DOMAIN` 可选变量，显式限制所有托管 DNS 名称必须位于目标根域下。
- 新增 `ALLOWED_HOSTS` 可选变量，限制页面/API 入口 host；`/health` 保持放行，便于监控。
- `/api/dns/current` 改为需要 `ADMIN_TOKEN`，避免公开暴露当前 DNS 池明细。
- README 和 verify 同步上述安全策略。
