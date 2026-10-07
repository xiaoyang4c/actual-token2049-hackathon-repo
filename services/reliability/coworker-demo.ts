/** Read the same public demo records that the hosted Coworker uses. */
export async function readHostedDemo(url: URL, baseUrl: string, fetcher: typeof fetch = fetch): Promise<Response|null> {
  if (!url.pathname.startsWith('/reliability/')) return null;
  const target = new URL(url.pathname + url.search, baseUrl);
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
