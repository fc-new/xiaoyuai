# Render + Neon 部署

复用现有免费 Render 服务 `srv-dbbkfq4s728c738oia70` 和 Neon 项目 `billowing-mode-33898462`。不要创建重复或付费资源。

- 网站：https://xiaoyuai.onrender.com
- 后台：https://xiaoyuai.onrender.com/admin
- Render 设置：https://dashboard.render.com/web/srv-dbbkfq4s728c738oia70/settings
- Neon 设置：https://console.neon.tech/app/projects/billowing-mode-33898462/settings

## 必要配置

Node 24.19.0；构建命令 `npm ci --include=dev --no-audit --no-fund && npm run build`；启动命令 `npm start`；健康检查 `/api/health`。保留 `NODE_ENV=production`、`REQUIRE_DATABASE_URL=1`、`TRUST_PROXY_HOPS=1` 和正式 HTTPS 域名。

私有环境变量：

- `DATABASE_URL`：原 Neon pooled PostgreSQL URL，使用验证 TLS，不打印、不放 Git。
- `ADMIN_PASSWORD`：保留 Render 中现有值，不同时配置 `ADMIN_PASSWORD_HASH`。管理员可以在 Render 私有 Environment 中查看。
- `VOUCHER_SECRET`：保留原 64 位十六进制值，不使用另一个随机值覆盖；它保护已有卡密及临时 session。新建环境可在本机安全生成 32 随机字节的 hex，再配置到 Render 私有环境，不通过聊天传递。

首次启动使用增量建表，保护原 purchase_orders、vouchers、redemptions、退款与订单记录，增加 activation_codes、activation_jobs、activation_events 和独立密钥指纹表。无须手工执行 SQL。启动时密钥指纹不匹配会失败，需要恢复原值。

`render.yaml` 保持免费计划，不包含付费磁盘或数据库。Neon 与 Render 免费服务可能休眠；休眠时临时凭据过期后仍不可读取，密文字段在恢复后清理。生产运营前需确认可用性符合实际服务要求。

## 本次流程

新首页为外部卡密兑换入口，不接受新购买订单。先登录后台，在「卡密管理」生成或导入卡密，再交给外部销售渠道。正式/演示类型按卡密配置，与保留的 `PAYMENT_MODE=demo` 历史收款设置无关。

用户提交后进入履约队列；Mastercard 实际扣款尚未自动对接，运营方在官方支持的结算流程中付款，凭真实结果确认交付。不要因为页面能提交、密文已保存或卡密有效，就宣布订阅已成功开通。

## 发布检查

1. 先运行构建、SQLite/PostgreSQL 接口与浏览器检查。
2. 推送 main 后等待 Render 对该提交部署成功，验证 `/api/health` 的 `workflowVersion=external-code-session-v1` 和 `databaseType=postgres`。
3. 验证首页、后台、静态资源与响应安全头。
4. 生成明确标为演示的卡密，用 `DEMO_SESSION` 跑一次兑换→领取→演示交付→私有查询，确认临时密文已清空。
5. 保留原有用户订单；演示测试不得进行实际扣款或提交真实账号 session。

历史记录通过 `/orders`、`/redeem` 和 `/admin/orders` 访问。新配置不删除原数据，不轮换管理员、数据库或原加密密钥。
