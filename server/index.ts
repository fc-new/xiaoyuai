import 'dotenv/config';
import { createApp } from './app.js';
import { loadMerchantConfig, MerchantPayments } from './merchant.js';
import { runtimeConfig } from './config.js';

async function main() {
  const config = runtimeConfig(process.env);
  const { app, db } = await createApp({ ...config,
    stripeSecret: process.env.STRIPE_SECRET_KEY, stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET, serveStatic: true,
    merchantPayments: new MerchantPayments(loadMerchantConfig(process.env, config.origin)),
    developmentApiPort: config.port,
  });
  const server = app.listen(config.port, process.env.BIND_ADDRESS || '0.0.0.0', () => {
    console.log(`xiaoyuai API listening on port ${config.port}; payment mode: ${config.mode}; database: ${db.dialect}`);
  });
  const localPreview = process.env.XIAOYUAI_LOCAL_PREVIEW === '1';
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10000);
    deadline.unref();
    server.close(async () => {
      try { await db.close(); clearTimeout(deadline); process.exit(0); }
      catch { process.exit(1); }
    });
    if (localPreview) server.closeAllConnections();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  if (localPreview && process.send) {
    process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'xiaoyuai-local-stop') shutdown(); });
    process.on('disconnect', shutdown);
  }
}
main().catch(() => {
  // Do not expose connection URLs, passwords or private-key contents in logs.
  console.error('Startup failed. Check HTTPS origin, administrator configuration, DATABASE_URL, database connectivity and migration permissions.');
  process.exitCode = 1;
});
