import { test, expect } from '@playwright/test';

test('desktop purchase, payment, admin fulfillment and private order lookup', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('让灵感');
  await expect(page.locator('.plan-card')).toHaveCount(3);
  await page.screenshot({ path: 'test-results/home-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '选择这个套餐' }).nth(1).click();
  await page.getByLabel('联系邮箱').fill('customer@example.com');
  await page.getByLabel('微信号或其他联系方式').fill('xiaoyu-test');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /创建订单/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Plus 季度');
  const orderId = await page.locator('.receipt-box code').nth(0).innerText();
  const accessCode = await page.locator('.receipt-box code').nth(1).innerText();
  await page.getByRole('button', { name: '模拟付款（不扣款）' }).click();
  await expect(page.locator('.order-top .status-badge')).toHaveText('已付款');
  await page.getByRole('button', { name: '关闭窗口' }).click();
  await page.getByRole('link', { name: '管理后台' }).click();
  await page.getByLabel('管理密码').fill('e2e-password');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByRole('heading', { name: /小鱼工作台/ })).toBeVisible();
  await page.getByRole('button', { name: '查看详情' }).first().click();
  await page.getByLabel('客户可见的处理说明').fill('专员已联系客户，开始演示开通。');
  await page.getByRole('button', { name: '更新订单状态' }).click();
  await expect(page.locator('.order-top .status-badge')).toHaveText('协助开通中');
  await page.getByLabel('客户可见的处理说明').fill('演示交付完成，账号未实际充值。');
  await page.getByRole('button', { name: '更新订单状态' }).click();
  await expect(page.locator('.order-top .status-badge')).toHaveText('已完成');
  await page.getByRole('button', { name: '关闭窗口' }).click();
  await page.screenshot({ path: 'test-results/admin-desktop.png', fullPage: true });
  await page.getByRole('link', { name: '返回前台' }).click();
  await page.getByRole('button', { name: '查询订单' }).first().click();
  await page.getByRole('textbox', { name: '订单号', exact: true }).fill(orderId);
  await page.getByLabel('专属查询码').fill(accessCode);
  await page.getByRole('button', { name: '查询进度', exact: true }).click();
  await expect(page.locator('.order-top .status-badge')).toHaveText('已完成');
  await expect(page.locator('.timeline')).toContainText('演示交付完成');
  await page.screenshot({ path: 'test-results/order-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('mobile layout, navigation, FAQ and keyboard-accessible dialogs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.plan-card')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '展开导航' }).click();
  await page.getByRole('link', { name: '常见问题', exact: true }).click();
  await page.getByRole('button', { name: /需要提供账号密码吗/ }).click();
  await expect(page.locator('#faq-1')).toBeVisible();
  await page.getByRole('button', { name: '查询订单', exact: true }).first().click();
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
  await expect(page.locator('.announcement')).toContainText('收款通道配置中');
  const buttons = page.getByRole('button', { name: '收款开通中' });
  await expect(buttons).toHaveCount(3);
  for (const button of await buttons.all()) await expect(button).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('正在准备收款服务');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /模拟付款/ })).toHaveCount(0);
});

test('a non-JSON catalog response shows a retry action and recovers without a blank page', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let unavailable = true;
  await page.route('**/api/catalog', route => unavailable ? route.fulfill({ contentType: 'text/html', body: '<html>Temporary upstream error</html>' }) : route.continue());
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('让灵感');
  await expect(page.getByRole('alert')).toContainText('服务响应异常');
  unavailable = false;
  await page.getByRole('button', { name: '重新加载套餐' }).click();
  await expect(page.locator('.plan-card')).toHaveCount(3);
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
  await expect(page.locator('.plan-card')).toHaveCount(3);
});

test('opening the same development site by IP keeps browser actions working', async ({ page, baseURL }) => {
  const ipOrigin = baseURL!.replace('localhost', '127.0.0.1');
  await page.goto(`${ipOrigin}/admin`);
  await page.getByLabel('管理密码').fill('e2e-password');
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByRole('heading', { name: /小鱼工作台/ })).toBeVisible();
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
  await page.getByRole('button', { name: '选择这个套餐' }).first().click();
  await page.getByLabel('联系邮箱').fill('fixture@example.com');
  await page.getByLabel('微信号或其他联系方式').fill('fixture-customer');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /创建订单/ }).click();
  await expect(page.getByRole('radio', { name: /微信支付/ })).toBeChecked();
  await page.getByRole('button', { name: '微信扫码付款' }).click();
  const qr = page.getByRole('img', { name: '此订单的微信支付二维码' });
  await expect(qr).toBeVisible(); await expect(qr).toHaveAttribute('src', /^data:image\/png;base64,/);
  await page.screenshot({ path: 'test-results/wechat-checkout.png', fullPage: true });
  await page.getByRole('button', { name: '我已付款，查询结果' }).click();
  await expect(page.locator('.order-top .status-badge')).toHaveText('已付款');
  await expect(qr).toHaveCount(0);
});
