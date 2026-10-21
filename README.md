# xiaoyu AI · 卡密兑换与授权履约

当前首页只接收**外部卡密 + 用户主动授权的 session**。购买和发卡由第三方平台或运营方完成，本站不开放新购买订单。用户兑换后获得独立查询凭据，后台负责核实账号条件、执行官方结算及记录交付结果。

**实际 Mastercard 扣款尚未自动接入。** 本系统不把卡密校验、session 格式检查或任务提交当成充值成功。运营方须在官方支持的结算页面完成实际付款，再凭可核验的官方订单号或交付编号确认完成。不会通过用户 session 自动调用猜测的私有支付接口，不保存银行卡号、CVV 或验证码。

## 运行

需要 Node.js 24.13+。开发启动：

```bash
npm ci --include=dev --no-audit --no-fund
npm run setup
npm run dev
```

本机开发页 `http://localhost:5173`，API 为 `3001`。管理员密码由首次 setup 随机生成，保存在私有 `.local/admin-credentials.txt`；页面 `/admin`。macOS 一键预览仍支持 `start-macos.command`，详见 [本地说明](LOCAL-README.md)。云端 localhost 不等于用户电脑的 localhost。

生产：

```bash
npm run build
npm start
```

生产静态页面与 API 共用 `PORT`。必须使用 HTTPS，设置管理员密码、数据库和原有加密密钥。当前部署为 [xiaoyuai.onrender.com](https://xiaoyuai.onrender.com)，[后台](https://xiaoyuai.onrender.com/admin)。部署说明见 [DEPLOY-RENDER.md](DEPLOY-RENDER.md)。

## 运营流程

1. 后台「卡密管理」选择套餐、正式/演示类型、来源和有效期。可生成 1–500 张卡密，或导入第三方平台的卡密，每行一张。
2. 生成卡密只在创建响应中显示完整明文，请立即下载 TXT 并交给外部销售渠道；列表和数据库只保留哈希与尾号。导入要求规范化后 12–96 位字母/数字，忽略大小写、空格和连字符。
3. 导入整批使用事务；批内、库存或历史购买系统中已有同一张卡密时整批回滚。导入不是向第三方平台验证库存，运营方需保证卡密的合法发行与销售状态。
4. 用户校验卡密，阅读授权说明后主动粘贴自己的 session JSON 并提交。演示卡密只接受 `DEMO_SESSION`，不接受真实凭据。
5. 系统原子占用卡密，创建唯一任务。并发兑换只成功一次，同一个私有请求键重试可恢复原任务；网络中断后，同一浏览器重新校验卡密可恢复申请。
6. 后台领取任务，重新验证管理员密码后按需读取临时 accessToken。读取动作在客户进度中留档。实际官方结算由运营方执行。
7. 完成需要处理说明、官方订单号或交付编号，以及运营方确认。任务完成或失败后清空 session 密文字段。session 过期可为原账号更新，不能切换成其他账号；失败任务不能重新消费原卡密。

任务状态：`queued → processing → completed`。无法确定交付结果时进入 `needs_review`；缺失或过期凭据进入 `needs_session`，更新后回到队列；无法履约可结束为 `failed`。售后和退款由原发卡商家处理，本站不会替外部平台自动退款。

## session 与数据保护

- 仅接收用户明确授权的 session JSON；检查结构、邮箱、token 格式和声明的有效期，**没有声称验证 OpenAI 签名、账号资格或真实订阅状态**。
- 不存完整 JSON、用户 profile 或 Cookie，只将 accessToken 使用 AES-256-GCM 加密，任务编号作为认证附加数据。凭据不写日志、不放 URL、不存浏览器 localStorage/sessionStorage。
- 可读取期限取声明期限与 30 分钟的较早者。过期后接口拒绝读取；运行时每分钟及请求前清理，服务休眠后在恢复时补清理。用户可主动删除临时副本。此操作不撤销官方凭据，备份密文仍受原备份策略约束。
- 管理列表和普通详情从不返回密文或 token；读取需已登录、已领取任务、重新验证密码，响应不缓存，浏览器显示最多 60 秒。
- 卡密、查询码只保存 SHA-256 哈希。默认生成卡密含 128 位随机量；导入的外部卡密强度由发卡方负责。查询凭据仅在当前浏览器会话中保存，用户需另行保存。
- `VOUCHER_SECRET` 必须是 32 随机字节的 64 位十六进制字符串。应和数据库备份一起妥善保管，普通部署不得替换。密钥指纹不一致会拒绝启动，避免静默丢失既有卡密及临时凭据。已有历史系统使用同一原始密钥，新凭据加密采用独立用途派生。
- 使用 HttpOnly、SameSite=Strict、生产 Secure 管理 Cookie，来源校验、请求限流、参数化 SQL、事务和 PostgreSQL 行锁/原子更新。

## 配置

| 变量 | 用途 |
| --- | --- |
| `VOUCHER_SECRET` | 必填、64 位十六进制加密密钥，保持原值 |
| `ADMIN_PASSWORD` / `ADMIN_PASSWORD_HASH` | 只设置一种；Render 已有私有密码需保留 |
| `DATABASE_URL` | PostgreSQL 优先，远程连接验证 TLS；Render 必填 |
| `DATABASE_PATH` | 本地 SQLite 默认 `data/xiaoyuai.sqlite` |
| `APP_ORIGIN` | 正式 HTTPS 域名；Render 可读取 `RENDER_EXTERNAL_URL` |
| `PORT` | 默认 3001 |
| `TRUST_PROXY_HOPS` | Render 默认 1，其他环境默认 0 |
| `PAYMENT_MODE` | 只影响保留的历史收款/退款代码，不控制新外部卡密是否为演示 |

正式/演示类型逐张卡密明确配置。新购买接口默认关闭，运行入口没有重新开启的环境变量。`purchasesEnabled` 只供历史接口回归测试显式使用。

## 兼容历史版本

已合并的购买卡密、人工兑换、退款核验和数据表均保留，没有删除或迁移用户订单：

- `/orders`：历史购买订单页面，新下单关闭。
- `/redeem`：原购买系统卡密兑换与查询。
- `/admin/orders`：历史订单、原履约与退款工作台。

历史接口及官方微信/支付宝验签与补偿任务仍保留，参考 [原卡密流程](docs/VOUCHER-FLOW.md)。新外部卡密库存与历史库存隔离，已存在于历史库存的卡密不能重复导入。

## 验证

```bash
npm run build
npm test
CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e
```

接口测试默认用临时 SQLite；`TEST_DATABASE_URL` 只允许一次性回环 PostgreSQL，各测试使用独立 schema。浏览器测试使用独立端口和数据库，全部是演示或伪造的测试凭据，不发生真实付款。持续集成保留 SQLite/PostgreSQL 两组接口测试。
