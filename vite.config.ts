import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { sameSiteDevelopmentOrigin } from './server/origins';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'APP_ORIGIN');
  const canonicalOrigin = new URL(process.env.APP_ORIGIN || env.APP_ORIGIN || 'http://localhost:5173').origin;
  return {
  plugins: [react()],
  root: 'client',
  build: { outDir: '../dist', emptyOutDir: true },
  server: { port: Number(process.env.WEB_PORT || 5173), strictPort: true, proxy: { '/api': {
    target: `http://127.0.0.1:${process.env.PORT || 3001}`,
    configure(proxy) {
      proxy.on('proxyReq', (proxyReq, req) => {
        const source = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
        if (sameSiteDevelopmentOrigin(source, req.headers.host, req.headers['sec-fetch-site'] as string | undefined)) proxyReq.setHeader('origin', canonicalOrigin);
      });
    },
  } } },
};
});
