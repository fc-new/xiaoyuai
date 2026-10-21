import { test, expect } from '@playwright/test';

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`${viewport.name} purchase → issue → redeem → fulfill → private progress`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/');
    await expect(page.locator('.reference-product-card')).toHaveCount(3);
    await expect(page.getByRole('status')).toContainText('当前为演示购买流程');
    await page.screenshot({ path: `test-results/home-${viewport.name}.png`, fullPage: true });
    await page.getByRole('button', { name: '查看详情' }).first().click();
    await page.getByRole('button', { name: '增加数量' }).click();
    await page.getByLabel('接收订单信息的邮箱').fill(`${viewport.name}@example.com`);
    await page.getByLabel('联系方式').fill('e2e-contact');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '确认支付' }).click();
    const orderId = await page.locator('.receipt-box code').nth(0).innerText();
    const accessCode = await page.locator('.receipt-box code').nth(1).innerText();
    await expect(page.locator('.order-top')).toContainText('336');
    await page.getByRole('button', { name: '模拟付款（不扣款）' }).click();
    await expect(page.locator('.order-top .status-badge')).toHaveText('已付款');
    await page.getByRole('button', { name: '查看可兑换卡密' }).click();
    await expect(page.locator('.voucher-code code')).toHaveCount(2);
    const code = await page.locator('.voucher-code code').first().innerText();
    await page.locator('.order-actions .reference-blue-button').click();
    await page.getByRole('textbox', { name: '卡密', exact: true }).fill(code);
    await page.getByRole('button', { name: '验证并继续' }).click();
    await page.getByLabel('ChatGPT 账号邮箱').fill(`${viewport.name}-target@example.com`);
    await page.getByLabel('联系方式').fill('target-contact');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '确认兑换，进入队列' }).click();
    await expect(page.locator('.reference-result .status-badge')).toHaveText('待处理');
    const id = await page.getByTestId('redemption-id').innerText();
    const key = await page.getByTestId('redemption-key').innerText();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/redemption-${viewport.name}.png`, fullPage: true });
    await page.goto('/admin');
    await page.getByLabel('管理密码').fill('e2e-password');
    await page.getByRole('button', { name: '进入工作台' }).click();
    await expect(page.getByRole('heading', { name: /xiaoyu AI 工作台/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: '微信 · 支付宝收款配置' })).toBeVisible();
    await expect(page.getByText('演示模式', { exact: true })).toBeVisible();
    await page.getByRole('row').filter({ hasText: id }).getByRole('button', { name: '打开记录' }).click();
    await page.getByLabel('负责人', { exact: true }).fill('演示专员');
    await page.getByLabel('客户可见说明', { exact: true }).fill('已核对目标账号，开始演示处理。');
    await page.getByRole('button', { name: '保存处理结果' }).click();
    await expect(page.getByTestId('admin-commerce-status')).toHaveText('处理中');
    await page.getByLabel('履约操作').selectOption('completed');
    await page.getByLabel('交付或核查凭据编号').fill(`DEMO-${viewport.name}`);
    await page.getByRole('checkbox').check();
    await page.getByLabel('客户可见说明', { exact: true }).fill('演示交付已核实，不开通真实订阅。');
    await page.getByRole('button', { name: '保存处理结果' }).click();
    await expect(page.getByTestId('admin-commerce-status')).toHaveText('已完成');
    await page.getByRole('button', { name: '关闭窗口' }).click();
    await page.screenshot({ path: `test-results/admin-${viewport.name}.png`, fullPage: true });
    await page.goto('/redeem');
    await page.getByRole('button', { name: '查询已有兑换进度', exact: true }).click();
    await page.getByLabel('兑换编号', { exact: true }).fill(id);
    await page.getByLabel('兑换查询码', { exact: true }).fill(key);
    await page.locator('form').getByRole('button', { name: '查询进度', exact: true }).click();
    await expect(page.locator('.reference-result .status-badge')).toHaveText('已完成');
    await expect(page.locator('.timeline')).toContainText('演示交付已核实');
    await page.goto('/');
    await page.getByRole('button', { name: '订单查询' }).first().click();
    await page.getByRole('textbox', { name: '订单号', exact: true }).fill(orderId);
    await page.getByLabel('查询码', { exact: true }).fill(accessCode);
    await page.getByRole('button', { name: '查询付款与卡密', exact: true }).click();
    await expect(page.locator('.order-top .status-badge')).toHaveText('已付款');
    await expect(page.locator('.voucher-row').first()).toContainText('已兑换');
    await expect(page.locator('.voucher-row').last()).toContainText('待兑换');
    expect(errors).toEqual([]);
  });
}

test('mobile layout, navigation, FAQ and keyboard-accessible dialogs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.reference-product-card')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '展开导航' }).click();
  await page.getByRole('link', { name: '服务帮助', exact: true }).click();
  await page.getByRole('button', { name: /需要提供密码或 session 吗/ }).click();
  await expect(page.locator('#faq')).toBeVisible();
  await page.getByRole('button', { name: '订单查询', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: 'test-results/home-mobile.png', fullPage: true });
});

test('merchant storefront shows ordering closed when no official channel is configured', async ({ page }) => {
  const catalog = await page.request.get('/api/catalog').then(r => r.json());
  await page.route('**/api/catalog', route => route.fulfill({ json: { ...catalog, paymentMode: 'merchant', paymentReady: false, paymentChannels: [] } }));
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('收款通道配置中');
  const buttons = page.getByRole('button', { name: '查看详情' });
  await expect(buttons).toHaveCount(3);
  for (const button of await buttons.all()) await expect(button).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /模拟付款/ })).toHaveCount(0);
});

test('a non-JSON catalog response shows a retry action and recovers without a blank page', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let unavailable = true;
  await page.route('**/api/catalog', route => unavailable ? route.fulfill({ contentType: 'text/html', body: '<html>Temporary upstream error</html>' }) : route.continue());
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('会员服务卡密');
  await expect(page.getByRole('alert')).toContainText('服务响应异常');
  unavailable = false;
  await page.getByRole('button', { name: '重新加载套餐' }).click();
  await expect(page.locator('.reference-product-card')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('failed entry script displays a recovery page and reload resumes normal rendering', async ({ page }) => {
  let unavailable = true;
  await page.route('**/src/main.tsx*', route => unavailable ? route.abort('failed') : route.continue());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '页面暂时没有加载完成' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新加载页面' })).toBeVisible();
  unavailable = false;
  await page.getByRole('button', { name: '重新加载页面' }).click();
  await expect(page.locator('.reference-product-card')).toHaveCount(3);
});

test('opening the same development site by IP keeps browser actions working', async ({ page, baseURL }) => {
  const ipOrigin = baseURL!.replace('localhost', '127.0.0.1');
  await page.goto(`${ipOrigin}/admin`);
  await page.getByLabel('管理密码').fill('e2e-password');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByRole('heading', { name: /xiaoyu AI 工作台/ })).toBeVisible();
});

test('merchant UI selects WeChat, renders a local QR image and refreshes confirmed payment', async ({ page }) => {
  // Browser-only contract fixtures: no live merchant account or charge.
  const catalog = await page.request.get('/api/catalog').then(r => r.json());
  const order = { id: 'XYBROWSERFIXTURE', email: 'fixture@example.com', contact: 'fixture-customer', planId: 'plus-month', planName: 'Plus 月度',
    amount: 16800, currency: 'cny', status: 'pending_payment', statusLabel: '待付款', paymentMode: 'merchant', paymentChannel: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [{ id: 1, status: 'pending_payment', message: '订单已创建，请完成付款。', createdAt: new Date().toISOString() }] };
  await page.route('**/api/catalog', route => route.fulfill({ json: { ...catalog, paymentMode: 'merchant', paymentReady: true, paymentChannels: [{ id: 'wechat', label: '微信支付' }, { id: 'alipay', label: '支付宝' }] } }));
  await page.route('**/api/orders', route => route.fulfill({ status: 201, json: { order, accessCode: 'BROWSERFIXTURE123' } }));
  await page.route('**/api/orders/checkout', route => {
    expect(route.request().postDataJSON().channel).toBe('wechat');
    return route.fulfill({ json: { mode: 'merchant', channel: 'wechat', qrCode: 'weixin://wxpay/bizpayurl?pr=browser-fixture' } });
  });
  await page.route('**/api/orders/lookup', route => route.fulfill({ json: { order: { ...order, paymentChannel: 'wechat' } } }));
  await page.route('**/api/orders/payment-status', route => route.fulfill({ json: { order: { ...order, status: 'paid', statusLabel: '已付款', paymentChannel: 'wechat' } } }));
  await page.goto('/');
  await page.getByRole('button', { name: '查看详情' }).first().click();
  await page.getByLabel('接收订单信息的邮箱').fill('fixture@example.com');
  await page.getByLabel('联系方式').fill('fixture-customer');
  await page.getByRole('checkbox').check();
  await page.getByRole('radio', { name: /微信支付/ }).check();
  await page.getByRole('button', { name: '确认支付' }).click();
  const qr = page.getByRole('img', { name: '此订单的微信支付二维码' });
  await expect(qr).toBeVisible(); await expect(qr).toHaveAttribute('src', /^data:image\/png;base64,/);
  await page.screenshot({ path: 'test-results/wechat-checkout.png', fullPage: true });
  await page.getByRole('button', { name: '我已付款，查询进度' }).click();
  await expect(page.locator('.order-top .status-badge')).toHaveText('已付款');
  await expect(qr).toHaveCount(0);
});
