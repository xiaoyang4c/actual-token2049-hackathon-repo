/** Read the same public demo records that the hosted Coworker uses. */
export async function readHostedDemo(url: URL, baseUrl?: string, fetcher: typeof fetch = fetch): Promise<Response|null> {
  if (!url.pathname.startsWith('/reliability/') || !baseUrl?.trim()) return null;
  const target = new URL(url.pathname + url.search, baseUrl);
  // Retired endpoints must not receive data, even through an old env setting.
  const hostname = target.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === 'sslip.io' || hostname.endsWith('.sslip.io')) return null;
  try {
    const response = await fetcher(target, {
      method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    // The paper seed remains usable while the hosted services are offline.
    if (response.status >= 500) return null;
    return new Response(await response.text(), {
      status: response.status,
      headers: {'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store'},
    });
  } catch {
    return null;
  }
}
