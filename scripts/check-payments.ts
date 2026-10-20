import 'dotenv/config';
import { loadMerchantConfig } from '../server/merchant.js';

const config = loadMerchantConfig(process.env, process.env.APP_ORIGIN || 'http://localhost:5173');
console.log('收款模式：', process.env.PAYMENT_MODE || 'merchant');
for (const status of config.statuses) {
  console.log(`${status.label}：${status.configured ? '本地配置已齐全' : '等待配置'}`);
  for (const name of status.missing) console.log(`  - 缺少或不可用：${name}`);
  if (status.notifyUrl) console.log(`  - 官方回调地址：${status.notifyUrl}`);
}
console.log('此检查不发起交易、不扣款，也不代表商户签约或回调公网访问已验证。');
if (!config.statuses.some(s => s.configured)) process.exitCode = 2;
