# 小鱼 AI · XiaoyuAI

一个可以实际运行的 ChatGPT 订阅**人工协助开通平台**。原创的墨绿、奶油白和珊瑚橙视觉，包含响应式前台、套餐选择、下单、模拟付款、私密订单查询、订单时间线与管理员履约工作台。没有抓取或复制参考网站的源码；本环境无法访问提供的两个参考链接。

在自己的电脑上先看效果，请阅读 [本地运行说明](LOCAL-README.md)。macOS 可运行 `start-macos.command`，自动准备 Node.js 并打开本机页面；本地预览使用独立演示数据库，不扣款，不修改正式商户配置。

无需购买服务器的在线预览，见 [Render + Neon 部署说明](DEPLOY-RENDER.md)。仓库包含免费 Web Service 的 `render.yaml`，支持外部 PostgreSQL 持久化订单；该部署配置明确选择演示付款。

## 一键运行

需要 Node.js **24.13+** 和 npm。在仓库目录运行：

```bash
bash scripts/start.sh
```

前端端口为 `5173`，API 端口为 `3001`；前端通过 Vite 代理访问 API。管理界面路径是 `/admin`。首次启动自动安装锁定依赖、创建 SQLite 数据库目录和私有配置。管理员的随机密码在 `.local/admin-credentials.txt`，请在本机编辑器中查看；不会写入源码或在安装日志中打印。

后续可直接 `npm run dev`。脚本会保留已有 `.env`，不会重置密码或订单。

开发环境支持通过 `localhost`、`127.0.0.1` 或 IPv6 回环地址访问同一前端端口；经开发反向代理访问时，只转发与页面主机一致的浏览器来源。生产环境仍严格校验 `APP_ORIGIN`。

如果页面加载不完整，等待提示出现后点击“重新加载页面”；如果套餐加载失败，点击“重新加载套餐”。脚本加载失败有独立于 React 的恢复页面，接口异常也不会直接导致整页空白。“正在准备收款服务”表示商户资料尚未补全，页面仍可正常浏览，开通收款后才能购买。

## 已实现的业务闭环

1. 客户选择套餐，填写联系邮箱和联系方式，阅读条款后创建订单。
2. 服务端决定套餐与金额；创建后只显示一次可恢复查询权限的查询码，请客户自行保存。当前**不会发送邮件**。
3. 默认 `PAYMENT_MODE=merchant`，接入微信支付 Native 扫码和支付宝官方收银台。缺少商户资料或正式 HTTPS 域名时停止接收新订单。开发测试可明确设置 `PAYMENT_MODE=demo`；Stripe 作为可选通道保留。
4. 客户使用订单号和查询码查询付款及履约记录；查询码在数据库中仅保存 SHA-256 哈希。
5. 管理员登录工作台，搜索/筛选订单，查看联系方式，按“已付款 → 开通中 → 已完成”逐步处理，填写客户可见说明。
6. 未生成支付会话的未付款订单可取消。已付订单不允许从后台伪造收款或跳过履约步骤。真实收款统计排除演示数据。

**人工履约**意味着运营者联系客户，核实官方账号与地区资格后，通过官方支持的流程协助操作。本系统不自动向 OpenAI 充值，不接收 ChatGPT 密码、会话令牌、OTP 或银行卡信息，也没有自动发送兑换码的功能。

## 关于你的万事达卡

你的万事达卡属于人工履约时使用的付款工具；平台向客户收款属于另一个流程。请直接在官方付款页或支付服务商的安全界面填写银行卡信息，不要发到聊天中，也不要写入项目、数据库或 `.env`。本项目没有“绑定个人银行卡即可收取客户款项”的功能。

平台当前选择微信支付／支付宝官方商户收款，商户的结算账户在对应商户平台配置。你的万事达卡用于后续人工履约付款，不是接通微信／支付宝收款的替代凭据。能否收款、能否使用某张卡以及能否开通官方订阅，以相关服务商实际支持情况为准。

## 微信／支付宝真实商户接入

代码接入已完成，但当前没有真实商户凭据与公网域名，**真实交易尚未激活和验证**。安装脚本不会生成商户密钥，也不会把模拟订单当作真实付款。先在对应平台完成商户签约及产品开通，再通过服务器私有 `.env`／部署平台安全配置补充资料；不要在聊天、Git 或日志中发送私钥、API v3 密钥或银行卡信息。

在 `.env` 中设置：

```dotenv
PAYMENT_MODE=merchant
APP_ORIGIN=https://你的正式域名
```

可先接通其中一个通道。另一个通道配置不完整时不会显示给客户。管理后台显示各通道的缺失项及通知地址；只显示名称和状态，不返回密钥内容。运行 `npm run payments:check` 可以检查本地配置，退出码 `2` 表示没有完整通道，属于待配置状态。

### 微信支付 Native（商户直连、公钥模式）

在微信支付商户平台开通 Native 支付，确认 AppID 与商户号已绑定；下载商户 API 私钥并准备官方微信支付公钥。本实现使用 API v3、公钥 ID 验签和 AES-256-GCM 通知解密。

| 私有配置名称 | 内容 |
| --- | --- |
| `WECHATPAY_APP_ID` | 与商户绑定的 AppID |
| `WECHATPAY_MCH_ID` | 真实商户号 |
| `WECHATPAY_CERT_SERIAL` | 商户 API 证书序列号，用于请求签名标识 |
| `WECHATPAY_PRIVATE_KEY_PATH` | 商户 API 私钥 PEM 文件路径，默认 `.local/keys/wechat-merchant-private.pem` |
| `WECHATPAY_API_V3_KEY` | 32 字节 API v3 原始密钥，用于服务器本地解密回调 |
| `WECHATPAY_PLATFORM_KEY_ID` | 微信支付公钥 ID，例如商户平台分配的 `PUB_KEY_ID_…` |
| `WECHATPAY_PLATFORM_PUBLIC_KEY_PATH` | 官方微信支付公钥 PEM 文件路径，默认 `.local/keys/wechat-platform-public.pem` |

通知地址为正式域名下 `/api/payments/wechat/notify`。服务器发起 `POST /v3/pay/transactions/native`，使用商户私钥签名，并对微信支付响应验签；客户只扫描官方返回的付款码。回调先校验微信公钥 ID、RSA 签名和时间戳，再解密并核对商户、AppID、订单号、币种、金额。金额来自官方交易总额，不使用客户端提交的金额。

付款码可以使用另一台设备扫描，或保存后在微信中识别。页面每 15 秒主动查询付款状态，也可以手动刷新；查询响应同样验签。公钥轮换时应更新平台公钥与 ID，不得关闭签名校验。API v3 原始密钥参与本地解密，不能用网络代理占位符代替。

### 支付宝电脑网站支付（RSA2 公钥模式）

在支付宝开放平台创建并上线自研应用、签约电脑网站支付，配置应用公钥并取得支付宝公钥。本实现使用支付宝官方 `alipay/alipay-sdk-nodejs-all` SDK，暂不提供服务商代接入或证书模式自动配置。

| 私有配置名称 | 内容 |
| --- | --- |
| `ALIPAY_APP_ID` | 已签约并上线的应用 AppID |
| `ALIPAY_SELLER_ID` | 该商户的支付宝用户 ID（用于核对收款主体） |
| `ALIPAY_PRIVATE_KEY_PATH` | 应用 RSA 私钥 PEM 路径，默认 `.local/keys/alipay-app-private.pem` |
| `ALIPAY_PUBLIC_KEY_PATH` | 支付宝 RSA 公钥 PEM 路径，默认 `.local/keys/alipay-public.pem` |

通知地址为正式域名下 `/api/payments/alipay/notify`。服务端生成签名的 `alipay.trade.page.pay` 官方跳转地址，收银台订单有效期为 30 分钟；回跳页面不代表付款成功。异步通知使用 RSA2 验签，核对应用、收款方、金额及交易号后才入账；主动调用 `alipay.trade.query` 时强制校验官方响应签名。金额使用整数分核算，避免浮点金额比较。

私钥文件应限制为服务进程可读。文件路径默认在 Git 忽略目录 `.local/keys/` 下，请自行安全放置实际文件，不要提交仓库。两种渠道均支持重复回调幂等处理；同一个交易号不能给多个订单记账。一个订单首次发起付款后锁定支付渠道，不能在微信和支付宝之间重复发起收款。

### 正式联调

1. 配置真实域名、HTTPS 反向代理和持久化数据库，使两个通知路径能被支付平台从公网访问；代理必须保留请求原文和签名头。
2. 在商户平台完成产品、域名及回调相关配置，运行 `npm run payments:check`，重启服务使私有配置生效。
3. 经运营者确认后，用实际销售套餐完成一笔授权交易，核对官方商户账单、服务端订单金额、回调及重复通知；当前没有执行真实扣款。
4. 如回调延迟，在订单页主动查询；不要仅凭客户付款截图或回跳参数确认收款。退款与争议当前在官方商户后台处理，不自动同步退款状态；需要运营人工对账。

本地配置齐全只代表代码可以发起接口调用，不代表产品签约、商户权限、回调可达或真实到账已验证。开发测试仍可显式使用 `PAYMENT_MODE=demo`，生产默认不会退回模拟付款。原有演示订单在真实模式下无法继续模拟付款。

## 可选：Stripe 托管收款

演示价格在 `server/catalog.ts` 中，正式经营前需由运营者确认并修改为实际可履约的价格。`Plus 季度` 是人工协助服务周期，不代表 OpenAI 提供季度套餐。

在私有 `.env` 或部署服务的安全环境变量中配置，**不要提交密钥**：

```dotenv
PAYMENT_MODE=stripe
APP_ORIGIN=https://your-domain.example
STRIPE_SECRET_KEY=<商户账户的 Stripe 密钥>
STRIPE_WEBHOOK_SECRET=<对应 webhook 的签名密钥>
```

1. 先使用 Stripe 测试模式的密钥和测试收银台，完成一笔端到端测试；本仓库的自动测试不连接真实 Stripe。
2. 在 Stripe 设置 webhook，指向你的 HTTPS 域名下 `/api/payments/webhook`，订阅 `checkout.session.completed` 和 `checkout.session.async_payment_succeeded`。
3. Stripe 回调的原始请求体、签名、订单关联、币种、总金额均会校验，重复事件不会重复记账。返回成功页本身**不会**把订单改成已付款。
4. 退款由运营人员在 Stripe 后台执行并与客户沟通。当前不自动同步退款/争议状态，不提供自动退款或自动订阅续费；正式上线前应补齐所需的退款对账流程。

签名密钥或支付密钥未配置时，真实支付模式会停止接收新订单。支付会话使用 Stripe 默认的 24 小时有效期；未付款订单最多可在创建后 24 小时内发起支付。发起过真实支付会话的订单不能直接在本后台取消，避免付款与取消竞态。

## 验证

```bash
npm ci --cache /tmp/xiaoyuai-npm-cache --no-audit --no-fund
npm run setup
npm run build
npm test
npm run test:e2e
```

API 测试覆盖价格篡改、查询授权、CSRF、模拟支付、防重复付款、后台认证和状态机、持久化、Stripe 回调，以及微信请求/响应签名、AES-GCM 回调解密、支付宝签名跳转和通知验签、商户/金额校验、重复交易、主动查单及缺失配置时停止收款。测试使用本地生成的临时 RSA 密钥和响应夹具，不连接真实商户。

浏览器测试覆盖桌面下单到后台交付完整闭环、移动端、FAQ、键盘关闭弹窗、横向溢出、微信付款码展示及真实通道未配置时禁止下单。浏览器中的商户收银台展示使用接口契约夹具，不执行真实付款。

浏览器测试默认使用环境里的 `/usr/bin/chromium`。其他机器可指定 `CHROMIUM_PATH`；也可安装 Playwright 支持的 Chromium 并指向其可执行文件。测试使用独立的 `15173/13001` 端口和临时数据库，不修改实际订单，也不需要停止正在运行的开发服务。可用 `E2E_WEB_PORT`、`E2E_API_PORT` 覆盖测试端口。

## 部署

```bash
npm ci --cache /tmp/xiaoyuai-npm-cache --no-audit --no-fund
npm run setup
npm run build
# Set APP_ORIGIN to your actual HTTPS domain in .env first.
npm start
```

生产进程在 `PORT`（默认 `3001`）同时提供构建后的静态前端和 API，应放在 HTTPS 反向代理后。设置 `DATABASE_URL` 时使用 PostgreSQL；未设置时使用本地 SQLite，需持久化保存并备份 `data/`。Render 或设置 `REQUIRE_DATABASE_URL=1` 的环境会强制要求 PostgreSQL，防止在临时磁盘存储订单。两种数据库均使用事务，PostgreSQL 更新订单时使用行锁。进程内限流仍要求单实例部署。生产必须设置 HTTPS `APP_ORIGIN`，Render 默认读取其自动提供的 `RENDER_EXTERNAL_URL`；管理 Cookie 使用 HttpOnly、SameSite=Strict 和 Secure。反向代理层数用 `TRUST_PROXY_HOPS` 配置（Render 默认 1，其他环境默认 0）。

正式经营前补充真实客服渠道、运营主体、售后/退款政策和适用的法定网站信息；校验价格、官方服务条款和可履约性。本仓库没有部署到公网、绑定银行卡或完成真实收款。

## 配置与目录

| 配置 | 用途 |
| --- | --- |
| `APP_ORIGIN` | 浏览器访问的唯一来源，用于 CSRF 校验与支付返回 |
| `PORT` | API/生产服务端口，默认 3001 |
| `DATABASE_PATH` | SQLite 数据库路径，默认 `data/xiaoyuai.sqlite` |
| `DATABASE_URL` | 可选 PostgreSQL 连接字符串；有值时优先使用，远程连接验证 TLS 证书 |
| `REQUIRE_DATABASE_URL` | `1` 时禁止回退至 SQLite；Render 自动强制此要求 |
| `PAYMENT_MODE` | 默认 `merchant`（微信／支付宝），可选 `demo` 或 `stripe` |
| `ADMIN_PASSWORD_HASH` | `salt:scrypt-hash` 格式的管理密码哈希 |
| `ADMIN_PASSWORD` | 部署平台私有配置的 16–256 位管理密码，启动时派生哈希；与 `ADMIN_PASSWORD_HASH` 二选一 |
| `TRUST_PROXY_HOPS` | 可信反向代理层数；Render 默认 1，其他环境默认 0 |
| `STRIPE_SECRET_KEY` | Stripe 服务端密钥，仅真实支付需要 |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook 签名密钥，仅真实支付需要 |

- `client/src/`：React + TypeScript 前台、后台和品牌样式。
- `server/`：Express API、SQLite／PostgreSQL 存储、套餐目录及支付处理。
- `scripts/`：可重复执行的初始化与一键开发启动。
- `tests/`：API 集成测试与真实 Chromium 浏览器测试。

没有 Docker、外部数据库或 Redis 的强制依赖。首次安装与刷新依赖需要访问 `registry.npmjs.org`；微信支付需要 `api.mch.weixin.qq.com`，支付宝需要 `openapi.alipay.com`，可选 Stripe 需要 `api.stripe.com`。接口遵循现有 HTTPS 代理设置，保留 TLS 和支付签名验证。
