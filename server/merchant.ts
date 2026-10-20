import { createDecipheriv, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AlipaySdk, ProxyAgent } from 'alipay-sdk';

export type MerchantChannel = 'wechat' | 'alipay';
export interface WechatConfig {
  appId: string; mchId: string; certSerial: string; privateKey: string; apiV3Key: string;
  platformKeyId: string; platformPublicKey: string;
}
export interface AlipayConfig { appId: string; sellerId: string; privateKey: string; publicKey: string }
export interface MerchantStatus {
  provider: MerchantChannel; label: string; configured: boolean; missing: string[]; notifyUrl: string | null;
}
export interface MerchantConfig { origin: string; wechat?: WechatConfig; alipay?: AlipayConfig; statuses: MerchantStatus[] }
export interface PayableOrder { id: string; amount: number; plan_name: string; created_at: string }
export interface VerifiedPayment { channel: MerchantChannel; orderId: string; transactionId: string; amount: number }
export class PaymentError extends Error { constructor(message: string, public status = 503) { super(message); } }

const fields = {
  wechat: ['WECHATPAY_APP_ID', 'WECHATPAY_MCH_ID', 'WECHATPAY_CERT_SERIAL', 'WECHATPAY_PRIVATE_KEY_PATH', 'WECHATPAY_API_V3_KEY', 'WECHATPAY_PLATFORM_KEY_ID', 'WECHATPAY_PLATFORM_PUBLIC_KEY_PATH'],
  alipay: ['ALIPAY_APP_ID', 'ALIPAY_SELLER_ID', 'ALIPAY_PRIVATE_KEY_PATH', 'ALIPAY_PUBLIC_KEY_PATH'],
};
const callbackPaths = { wechat: '/api/payments/wechat/notify', alipay: '/api/payments/alipay/notify' };
const labels = { wechat: '微信支付', alipay: '支付宝' };
const shanghaiDate = (date: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);

function readKey(path: string, privateKey: boolean) {
  const pem = readFileSync(path, 'utf8');
  const key = privateKey ? createPrivateKey(pem) : createPublicKey(pem);
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error('RSA 2048+ required');
  return privateKey ? key.export({ type: 'pkcs8', format: 'pem' }).toString() : key.export({ type: 'spki', format: 'pem' }).toString();
}

// Reads only the named requirements. Never log key contents or the full process environment.
export function loadMerchantConfig(env: NodeJS.ProcessEnv, origin: string): MerchantConfig {
  const url = new URL(origin);
  const https = url.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const statuses: MerchantStatus[] = (['wechat', 'alipay'] as const).map(provider => ({
    provider, label: labels[provider], configured: false,
    missing: [...fields[provider].filter(name => !env[name]?.trim()), ...(!https ? ['APP_ORIGIN（可公开访问的 HTTPS 域名）'] : [])],
    notifyUrl: https ? `${url.origin}${callbackPaths[provider]}` : null,
  }));
  const result: MerchantConfig = { origin: url.origin, statuses };
  for (const channel of ['wechat', 'alipay'] as const) {
    const status = statuses.find(s => s.provider === channel)!;
    const loadedKeys = new Map<string, string>();
    for (const name of fields[channel].filter(name => name.endsWith('_KEY_PATH'))) {
      if (!env[name]) continue;
      try { loadedKeys.set(name, readKey(env[name]!, name.includes('PRIVATE'))); }
      catch { status.missing.push(`${name}（文件缺失或 RSA 密钥格式不正确）`); }
    }
    if (channel === 'wechat' && env.WECHATPAY_API_V3_KEY && Buffer.byteLength(env.WECHATPAY_API_V3_KEY, 'utf8') !== 32) status.missing.push('WECHATPAY_API_V3_KEY（必须是 32 字节的原始密钥）');
    if (status.missing.length) continue;
    try {
      if (channel === 'wechat') {
        if (Buffer.byteLength(env.WECHATPAY_API_V3_KEY!, 'utf8') !== 32) throw new Error('API v3 key must be 32 bytes');
        result.wechat = {
          appId: env.WECHATPAY_APP_ID!, mchId: env.WECHATPAY_MCH_ID!, certSerial: env.WECHATPAY_CERT_SERIAL!,
          privateKey: loadedKeys.get('WECHATPAY_PRIVATE_KEY_PATH')!, apiV3Key: env.WECHATPAY_API_V3_KEY!,
          platformKeyId: env.WECHATPAY_PLATFORM_KEY_ID!, platformPublicKey: loadedKeys.get('WECHATPAY_PLATFORM_PUBLIC_KEY_PATH')!,
        };
      } else {
        result.alipay = { appId: env.ALIPAY_APP_ID!, sellerId: env.ALIPAY_SELLER_ID!, privateKey: loadedKeys.get('ALIPAY_PRIVATE_KEY_PATH')!, publicKey: loadedKeys.get('ALIPAY_PUBLIC_KEY_PATH')! };
      }
      status.configured = true;
    } catch { status.missing.push('商户密钥文件无法读取、RSA 密钥格式不正确，或 API v3 密钥不是 32 字节'); }
  }
  return result;
}

export function yuanToCents(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) throw new PaymentError('支付金额格式不正确。', 400);
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export class MerchantPayments {
  private alipay?: AlipaySdk;
  private proxyAgent?: ProxyAgent;
  constructor(public readonly config: MerchantConfig, private readonly fetcher: typeof fetch = fetch, alipaySdk?: AlipaySdk) {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (proxy) this.proxyAgent = new ProxyAgent(proxy);
    if (config.alipay) {
      this.alipay = alipaySdk || new AlipaySdk({ appId: config.alipay.appId, privateKey: config.alipay.privateKey,
        alipayPublicKey: config.alipay.publicKey, keyType: 'PKCS8', signType: 'RSA2', camelcase: false,
        gateway: 'https://openapi.alipay.com/gateway.do', timeout: 15000,
        proxyAgent: this.proxyAgent });
    }
  }
  get channels() { return this.config.statuses.filter(s => s.configured).map(s => ({ id: s.provider, label: s.label })); }
  private ensure(channel: MerchantChannel) {
    if (!this.channels.some(c => c.id === channel)) throw new PaymentError('此收款通道尚未配置完成，请稍后再试。');
  }
  private wechatVerify(body: string, headers: Headers) {
    const config = this.config.wechat;
    const timestamp = headers.get('wechatpay-timestamp');
    const nonce = headers.get('wechatpay-nonce');
    const signature = headers.get('wechatpay-signature');
    if (!config || headers.get('wechatpay-serial') !== config.platformKeyId || !timestamp || !/^\d+$/.test(timestamp) || !nonce || !signature || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new PaymentError('微信支付签名无效或已过期。', 400);
    if (!verify('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), config.platformPublicKey, Buffer.from(signature, 'base64'))) throw new PaymentError('微信支付签名无效。', 400);
  }
  private async wechatRequest(method: 'GET' | 'POST', path: string, payload?: unknown) {
    const config = this.config.wechat!;
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const signature = sign('RSA-SHA256', Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`), config.privateKey).toString('base64');
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${config.certSerial}",signature="${signature}"`;
    const response = await this.fetcher(`https://api.mch.weixin.qq.com${path}`, { method,
      headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'xiaoyuai/1.0', 'Wechatpay-Serial': config.platformKeyId },
      ...(body ? { body } : {}), signal: AbortSignal.timeout(15000),
      ...(this.proxyAgent ? { dispatcher: this.proxyAgent } : {}) } as RequestInit);
    const text = await response.text();
    // Verify even error replies; never accept an unsigned successful result.
    this.wechatVerify(text, response.headers);
    if (!response.ok) throw new PaymentError('微信支付暂时无法创建或查询交易，请在商户平台核对权限与配置。');
    return JSON.parse(text);
  }
  async checkout(channel: MerchantChannel, order: PayableOrder): Promise<{ mode: 'merchant'; channel: MerchantChannel; qrCode?: string; url?: string }> {
    this.ensure(channel);
    try {
      if (channel === 'wechat') {
        const c = this.config.wechat!;
        const response = await this.wechatRequest('POST', '/v3/pay/transactions/native', {
          appid: c.appId, mchid: c.mchId, description: `xiaoyu AI · ${order.plan_name}开通协助`, out_trade_no: order.id,
          notify_url: `${this.config.origin}${callbackPaths.wechat}`, time_expire: new Date(Date.parse(order.created_at) + 24 * 60 * 60000).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
          amount: { total: order.amount, currency: 'CNY' },
        });
        if (typeof response.code_url !== 'string' || !response.code_url.startsWith('weixin://wxpay/')) throw new PaymentError('微信支付未返回有效的付款码。');
        return { mode: 'merchant', channel, qrCode: response.code_url };
      }
      const url = this.alipay!.pageExecute('alipay.trade.page.pay', 'GET', {
        timestamp: shanghaiDate(new Date()), notifyUrl: `${this.config.origin}${callbackPaths.alipay}`,
        returnUrl: `${this.config.origin}/?payment=success&order=${encodeURIComponent(order.id)}`,
        bizContent: { outTradeNo: order.id, totalAmount: (order.amount / 100).toFixed(2), subject: `xiaoyu AI · ${order.plan_name}开通协助`, productCode: 'FAST_INSTANT_TRADE_PAY', timeoutExpress: '30m' },
      });
      const target = new URL(url);
      if (target.protocol !== 'https:' || target.hostname !== 'openapi.alipay.com') throw new PaymentError('支付宝收银台地址无效。');
      return { mode: 'merchant', channel, url };
    } catch (error) { if (error instanceof PaymentError) throw error; throw new PaymentError('支付通道暂时不可用，请稍后重试。'); }
  }
  verifyWechatNotification(raw: string, headers: Headers): VerifiedPayment | null {
    this.ensure('wechat'); this.wechatVerify(raw, headers);
    const notice = JSON.parse(raw);
    if (notice.event_type !== 'TRANSACTION.SUCCESS') return null;
    const resource = notice.resource;
    if (resource?.algorithm !== 'AEAD_AES_256_GCM' || resource.original_type !== 'transaction') throw new PaymentError('微信通知类型不正确。', 400);
    const ciphertext = Buffer.from(resource.ciphertext, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(this.config.wechat!.apiV3Key), Buffer.from(resource.nonce));
    decipher.setAuthTag(ciphertext.subarray(-16)); decipher.setAAD(Buffer.from(resource.associated_data || ''));
    const transaction = JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString('utf8'));
    return this.wechatTransaction(transaction);
  }
  private wechatTransaction(transaction: Record<string, any>): VerifiedPayment | null {
    if (transaction.trade_state !== 'SUCCESS') return null;
    const c = this.config.wechat!;
    if (transaction.appid !== c.appId || transaction.mchid !== c.mchId || transaction.amount?.currency !== 'CNY' || !Number.isSafeInteger(transaction.amount.total) || typeof transaction.out_trade_no !== 'string' || typeof transaction.transaction_id !== 'string' || !transaction.transaction_id) throw new PaymentError('微信交易商户或金额信息不匹配。', 400);
    return { channel: 'wechat', orderId: transaction.out_trade_no, transactionId: transaction.transaction_id, amount: transaction.amount.total };
  }
  verifyAlipayNotification(body: unknown): VerifiedPayment | null {
    this.ensure('alipay');
    if (!body || typeof body !== 'object' || Object.values(body).some(v => typeof v !== 'string')) throw new PaymentError('支付宝通知格式无效。', 400);
    const p = body as Record<string, string>;
    if (p.sign_type !== 'RSA2' || !this.alipay!.checkNotifySignV2(p)) throw new PaymentError('支付宝通知签名无效。', 400);
    if (p.app_id !== this.config.alipay!.appId || p.seller_id !== this.config.alipay!.sellerId) throw new PaymentError('支付宝通知商户不匹配。', 400);
    if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(p.trade_status)) return null;
    if (!p.out_trade_no || !p.trade_no) throw new PaymentError('支付宝交易信息缺失。', 400);
    return { channel: 'alipay', orderId: p.out_trade_no, transactionId: p.trade_no, amount: yuanToCents(p.total_amount) };
  }
  // Read-only reconciliation. Refunds themselves are initiated in the merchant console.
  async queryRefund(channel: MerchantChannel, order: PayableOrder, transactionId: string, reference: string) {
    this.ensure(channel);
    try {
      if (channel === 'wechat') {
        const result = await this.wechatRequest('GET', `/v3/refund/domestic/refunds/${encodeURIComponent(reference)}`);
        if (result.out_trade_no !== order.id || result.transaction_id !== transactionId || result.out_refund_no !== reference || result.amount?.currency !== 'CNY' || result.amount.total !== order.amount) throw new PaymentError('退款结果与原支付交易不匹配。', 409);
        if (result.status !== 'SUCCESS') return null;
        if (!result.refund_id || !Number.isSafeInteger(result.amount.refund)) throw new PaymentError('退款凭据不完整。', 409);
        return { orderId: order.id, amount: result.amount.refund, reference: `wechat:${result.refund_id}` };
      }
      const result = await this.alipay!.exec('alipay.trade.fastpay.refund.query', {
        timestamp: shanghaiDate(new Date()), bizContent: { outTradeNo: order.id, outRequestNo: reference },
      }, { validateSign: true });
      if (result.code !== '10000' || result.refund_status !== 'REFUND_SUCCESS') return null;
      if (result.out_trade_no !== order.id || result.trade_no !== transactionId || result.out_request_no !== reference || yuanToCents(result.total_amount) !== order.amount) throw new PaymentError('退款结果与原支付交易不匹配。', 409);
      return { orderId: order.id, amount: yuanToCents(result.refund_amount), reference: `alipay:${transactionId}:${reference}` };
    } catch (error) { if (error instanceof PaymentError) throw error; throw new PaymentError('退款结果尚无法核实，请稍后查询。'); }
  }
  async query(channel: MerchantChannel, orderId: string): Promise<VerifiedPayment | null> {
    this.ensure(channel);
    try {
      if (channel === 'wechat') {
        const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderId)}?mchid=${encodeURIComponent(this.config.wechat!.mchId)}`;
        return this.wechatTransaction(await this.wechatRequest('GET', path));
      }
      const result = await this.alipay!.exec('alipay.trade.query', { timestamp: shanghaiDate(new Date()), bizContent: { outTradeNo: orderId } }, { validateSign: true });
      if (result.code === '40004' && result.sub_code === 'ACQ.TRADE_NOT_EXIST') return null;
      if (result.code !== '10000') throw new PaymentError('支付宝交易查询暂未成功，请稍后刷新。');
      if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(result.trade_status)) return null;
      if (result.out_trade_no !== orderId || !result.trade_no) throw new PaymentError('支付宝交易与订单不匹配。', 400);
      return { channel, orderId: result.out_trade_no, transactionId: result.trade_no, amount: yuanToCents(result.total_amount) };
    } catch (error) { if (error instanceof PaymentError) throw error; throw new PaymentError('付款结果暂未确认，请稍后刷新；请勿重复付款。'); }
  }
}
