const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];

export function allowedOrigins(configuredOrigin: string, production: boolean, developmentApiPort?: number): Set<string> {
  const canonical = new URL(configuredOrigin);
  const allowed = new Set([canonical.origin]);
  if (production || canonical.protocol !== 'http:' || !loopbackHosts.includes(canonical.hostname)) return allowed;
  const ports = new Set([canonical.port || '80']);
  if (developmentApiPort) ports.add(String(developmentApiPort));
  for (const host of loopbackHosts) for (const port of ports) allowed.add(new URL(`http://${host}:${port}`).origin);
  return allowed;
}

// Vite may sit behind an HTTPS development proxy. Translate only requests made
// by the page to the exact host serving that page; cross-site origins stay intact.
export function sameSiteDevelopmentOrigin(requestOrigin: string | undefined, host: string | undefined, fetchSite?: string): boolean {
  if (!requestOrigin || !host || fetchSite === 'cross-site') return false;
  try {
    const source = new URL(requestOrigin);
    return ['http:', 'https:'].includes(source.protocol) && source.origin === requestOrigin && source.host === host;
  } catch { return false; }
}
