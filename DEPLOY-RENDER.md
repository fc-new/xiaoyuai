# Render + Neon 免费预览部署

前端和 API 放在一个 Render Web Service；订单、履约记录和后台会话放在 Neon PostgreSQL。无需购买服务器或域名。免费套餐有额度和休眠限制，具体以平台创建时显示为准。以下配置明确选择演示付款，不产生真实扣款。

## 1. 准备 Neon

1. 登录 <https://console.neon.tech/>，在 **Free** 套餐下新建项目 `xiaoyuai`。如可选，选择与 Render 接近的区域（配置默认 Singapore）。不要选择付费升级。
2. 在项目 **Connect** 中选择数据库和角色，开启 **Connection pooling**，复制 PostgreSQL 连接字符串。通常主机含 `-pooler`，字符串含 `sslmode=require`。
3. 此字符串包含数据库密码，只粘贴到下一步 Render 的 `DATABASE_URL` 私有环境变量。不要发到聊天、提交 Git 或写入公开日志。

应用首次启动会自动创建所需表，并用事务和 PostgreSQL advisory lock 保护初始化。无需手动运行 SQL。应用会验证远程数据库的 TLS 证书。

## 2. 创建 Render 免费服务

登录 <https://dashboard.render.com/>，连接有权读取 `fc-new/xiaoyuai` 的 GitHub 账号。

仓库 `main` 分支包含本文件及 `render.yaml` 后，可使用：

[从此仓库部署到 Render](https://render.com/deploy?repo=https://github.com/fc-new/xiaoyuai)

也可以在 Render 选择 **New → Blueprint**，选择此仓库的 `main` 分支。私有仓库必须先授权 Render GitHub App 访问。

创建前确认只有一个 **Free Web Service**，没有付费数据库、磁盘或其他付费资源。Blueprint 会提示填写两个私有变量：

| 名称 | 填写内容 |
| --- | --- |
| `DATABASE_URL` | Neon 的池化连接字符串 |
| `ADMIN_PASSWORD` | 你自行生成并保存的 16–256 位高强度管理密码；推荐密码管理器生成随机密码 |

不要填写固定示例密码。管理员密码仅在启动时转换为 scrypt 哈希，不返回给浏览器或写入日志。Render 中不要同时设置 `ADMIN_PASSWORD` 和 `ADMIN_PASSWORD_HASH`。

`render.yaml` 已配置 Node 24、锁定依赖安装、构建、启动、健康检查、单层代理和 `PAYMENT_MODE=demo`。无需运行 `npm run setup`，也不需要上传本地 `.env`、`.local/` 或 SQLite 文件。

如果无法使用 Blueprint，手动新建 **Web Service** 并选择此仓库：

| 设置 | 值 |
| --- | --- |
| Branch / Runtime / Instance | `main` / Node / **Free** |
| Build Command | `npm ci --include=dev --no-audit --no-fund && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |
| `NODE_VERSION` | `24.19.0` |
| `NODE_ENV` | `production` |
| `PAYMENT_MODE` | `demo` |
| `REQUIRE_DATABASE_URL` | `1` |
| `TRUST_PROXY_HOPS` | `1` |
| `DATABASE_URL` / `ADMIN_PASSWORD` | 上表中的私有值 |

## 3. 打开与验证

Render 状态变成 **Live** 后，使用它实际显示的 `https://…onrender.com` 地址。此文档没有预设或声称已创建任何域名。默认读取 Render 自动提供的 `RENDER_EXTERNAL_URL`；无需猜测 `APP_ORIGIN`。

1. 打开首页，确认有三个套餐并有演示说明。
2. 用测试邮箱创建订单，保存订单号和查询码，完成模拟付款。
3. 打开该网址的 `/admin`，用你设置的管理密码登录，按顺序处理为开通中、已完成，再查订单时间线。
4. 在 Render 执行一次重新部署，用原查询码确认订单仍然存在。
5. `/api/health` 应返回 `status=ok`、`database=ok`、`databaseType=postgres`、`paymentMode=demo`。

不要用真实客户资料测试。免费实例休眠后首次打开可能较慢；连接数据库失败时，健康检查会失败，应用不会悄悄使用临时 SQLite。查看 Render 和 Neon 的状态、连接字符串、数据库角色权限及区域设置。

## 后续正式收款

当前预览不收取真实款项。需要正式收款时，再按 README 配置微信／支付宝商户信息，将 `PAYMENT_MODE` 改为 `merchant`，确认 HTTPS 回调、价格和真实到账。商户私钥可使用 Render Secret Files，环境变量指向对应私有文件；不要放进 Git。

如绑定自定义域名，将 `APP_ORIGIN` 设置为该域名的完整 HTTPS 来源，然后重新部署。更换管理密码后，可在专用数据库执行 `DELETE FROM admin_sessions` 撤销既有会话。进程内限流仍要求单个 Web Service；本配置不承诺免费服务可用于持续稳定的正式收款。

原有本地 SQLite 数据不会自动迁入 Neon。这次部署使用新数据库；如本地已有真实订单，应单独备份并安排导入。

## 开发验证

`npm test` 验证 SQLite。对本机一次性 PostgreSQL 实例，可使用 `TEST_DATABASE_URL=postgresql://…@127.0.0.1:5432/… npm test` 复用整套 API／支付测试。测试只接受回环地址，并为每个夹具建立独立临时 schema；不要提供正式数据库地址。GitHub Actions 同时配置 SQLite 和 PostgreSQL 两套验证。
