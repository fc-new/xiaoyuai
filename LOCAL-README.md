# xiaoyu AI 本机预览

当前首页已改为外部卡密兑换，先到 `/admin` 的「卡密管理」生成演示卡密，再到首页校验并点击「填入演示 session」体验。演示不实际扣款或开通订阅。

本机开发首次执行 `npm ci --include=dev`、`npm run setup`、`npm run dev`，打开 `http://localhost:5173`。管理员随机密码在本机私有 `.local/admin-credentials.txt`。

macOS 一键启动仍可双击 `start-macos.command`，或执行 `node scripts/local.mjs`。启动器绑定 `127.0.0.1:17860`–`17879` 中一个可用端口并打开浏览器；保持终端窗口运行。预览密码在 `.local/preview-admin.txt`，数据库和加密配置独立保存于 `.local/`，不会借用云端数据库或覆盖正式配置。启动器仅在缺少构建时自动构建；更新源代码后先运行 `npm run build`。

数据库与原始加密密钥应一起备份，不要删除 `.env`、`.local/preview-config.json` 中的密钥后为旧数据库重新生成。不要在演示中提交真实 session 或银行卡信息。

云环境工具不能替你启动个人电脑。网站已部署时可直接访问 https://xiaoyuai.onrender.com，无须本机运行。项目详情见 [README](README.md)。
