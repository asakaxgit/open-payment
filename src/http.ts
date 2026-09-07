import { PaymentProviderError } from './provider.js';

export type JsonHttpOptions = {
  method?: 'GET' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
};

export async function jsonHttp<T>(url: string, options: JsonHttpOptions = {}): Promise<T> {
  const hasBody = options.body !== undefined;
  const res = await fetch(url, {
    method: options.method ?? (hasBody ? 'POST' : 'GET'),
    headers: {
      Accept: 'application/json',
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new PaymentProviderError(
      `Payment HTTP ${res.status} for ${url}: ${text.slice(0, 300)}`,
      res.status === 401 || res.status === 403 ? 'NOT_CONFIGURED' : 'UNAVAILABLE',
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
