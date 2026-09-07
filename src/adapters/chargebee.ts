import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  checkoutCustomData,
  getProviderPriceId,
  planKeyFromCustomData,
  resolvePlanKeyFromProviderPriceId,
  accountIdFromCustomData,
} from '../catalog.js';
import { PaymentProviderError, type PaymentProvider } from '../provider.js';
import type {
  BillingEvent,
  BillingInvoice,
  CreateCheckoutInput,
  CreateCheckoutResult,
  CreatePortalInput,
  SubscriptionInfo,
} from '../types.js';

function site(): string {
  const value = process.env.CHARGEBEE_SITE;
  if (!value) throw new PaymentProviderError('CHARGEBEE_SITE is not set', 'NOT_CONFIGURED');
  return value;
}

function apiKey(): string {
  const key = process.env.CHARGEBEE_API_KEY;
  if (!key) throw new PaymentProviderError('CHARGEBEE_API_KEY is not set', 'NOT_CONFIGURED');
  return key;
}

function apiBase(): string {
  return `https://${site()}.chargebee.com/api/v2`;
}

function basicAuthHeader(): string {
  return `Basic ${Buffer.from(`${apiKey()}:`).toString('base64')}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function headerGet(
  headers: Headers | Record<string, string | null | undefined>,
  name: string,
): string | null {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string | null | undefined>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}

async function chargebeeForm<T>(path: string, data: Record<string, string>): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(data),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new PaymentProviderError(
      `Chargebee HTTP ${res.status}: ${text.slice(0, 300)}`,
      res.status === 401 || res.status === 403 ? 'NOT_CONFIGURED' : 'UNAVAILABLE',
    );
  }
  return (await res.json()) as T;
}

export function verifyChargebeeWebhook(
  rawBody: string | Buffer,
  headers: Headers | Record<string, string | null | undefined>,
): void {
  const username = process.env.CHARGEBEE_WEBHOOK_USERNAME;
  const password = process.env.CHARGEBEE_WEBHOOK_PASSWORD;
  if (username && password) {
    const auth = headerGet(headers, 'authorization');
    if (!auth?.startsWith('Basic ')) {
      throw new PaymentProviderError('Missing Chargebee basic auth', 'INVALID_WEBHOOK');
    }
    const decoded = Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8');
    const expected = `${username}:${password}`;
    const a = Buffer.from(decoded, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new PaymentProviderError('Invalid Chargebee basic auth', 'INVALID_WEBHOOK');
    }
  }

  const hmacSecret = process.env.CHARGEBEE_WEBHOOK_HMAC_SECRET;
  if (hmacSecret) {
    const signature = headerGet(headers, 'chargebee-webhook-signature');
    if (!signature) {
      throw new PaymentProviderError('Missing Chargebee HMAC signature', 'INVALID_WEBHOOK');
    }
    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const digest = createHmac('sha256', hmacSecret).update(body).digest('hex');
    const a = Buffer.from(digest, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new PaymentProviderError('Invalid Chargebee HMAC signature', 'INVALID_WEBHOOK');
    }
  }

  if (!username && !password && !hmacSecret) {
    throw new PaymentProviderError(
      'Configure CHARGEBEE_WEBHOOK_USERNAME/PASSWORD or CHARGEBEE_WEBHOOK_HMAC_SECRET',
      'NOT_CONFIGURED',
    );
  }
}

export function chargebeePayloadToBillingEvents(payload: unknown): BillingEvent[] {
  const root = asRecord(payload);
  const eventType = String(root.event_type ?? '');
  const content = asRecord(root.content);
  const subscription = asRecord(content.subscription);
  const customer = asRecord(content.customer);
  const invoice = asRecord(content.invoice);

  const accountId =
    accountIdFromCustomData(asRecord(subscription.meta_data)) ??
    accountIdFromCustomData(asRecord(customer.meta_data)) ??
    (typeof subscription.cf_account_id === 'string' ? subscription.cf_account_id : null) ??
    (typeof customer.cf_account_id === 'string' ? customer.cf_account_id : null);

  if (!accountId) return [];

  const itemPriceId = String(
    asRecord(
      Array.isArray(subscription.subscription_items)
        ? subscription.subscription_items[0]
        : {},
    ).item_price_id ?? '',
  );
  const planKey: string =
    resolvePlanKeyFromProviderPriceId('chargebee', itemPriceId) ??
    planKeyFromCustomData(asRecord(subscription.meta_data)) ??
    planKeyFromCustomData(asRecord(customer.meta_data)) ??
    'free';
  const customerId = String(customer.id ?? subscription.customer_id ?? '') || null;

  switch (eventType) {
    case 'subscription_created':
    case 'subscription_started':
      return [
        {
          type: 'subscription.activated',
          accountId,
          planKey,
          providerCustomerId: customerId,
          provider: 'chargebee',
        },
      ];
    case 'subscription_changed':
      if (String(subscription.status ?? '') === 'cancelled') {
        return [{ type: 'subscription.canceled', accountId, provider: 'chargebee' }];
      }
      return [
        {
          type: 'subscription.updated',
          accountId,
          planKey,
          providerCustomerId: customerId,
          provider: 'chargebee',
        },
      ];
    case 'subscription_cancelled':
    case 'subscription_deleted':
      return [{ type: 'subscription.canceled', accountId, provider: 'chargebee' }];
    case 'payment_failed':
      return [
        {
          type: 'invoice.payment_failed',
          accountId,
          invoiceId: String(invoice.id ?? root.id ?? 'chargebee_payment_failed'),
          provider: 'chargebee',
        },
      ];
    case 'invoice_updated':
      if (String(invoice.status ?? '') !== 'not_paid') return [];
      return [
        {
          type: 'invoice.payment_failed',
          accountId,
          invoiceId: String(invoice.id ?? 'chargebee_invoice_not_paid'),
          provider: 'chargebee',
        },
      ];
    default:
      return [];
  }
}

export class ChargebeePaymentProvider implements PaymentProvider {
  readonly id = 'chargebee' as const;

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const itemPriceId = getProviderPriceId('chargebee', input.planKey);
    if (!itemPriceId) {
      throw new PaymentProviderError(
        `Chargebee item price not configured for plan ${input.planKey}`,
        'NOT_CONFIGURED',
      );
    }

    const custom = checkoutCustomData({ accountId: input.accountId,
      planKey: input.planKey,
    });

    const result = await chargebeeForm<{ hosted_page?: { url?: string } }>(
      '/hosted_pages/checkout_new_for_items',
      {
        'subscription_items[item_price_id][0]': itemPriceId,
        'subscription_items[quantity][0]': '1',
        'customer[email]': input.customerEmail ?? '',
        'customer[company]': input.accountName,
        'customer[cf_account_id]': input.accountId,
        'customer[meta_data]': JSON.stringify(custom),
        redirect_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
    );

    const url = result.hosted_page?.url;
    if (!url) {
      throw new PaymentProviderError('Chargebee hosted page URL missing', 'CHECKOUT_URL_MISSING');
    }
    return { url, providerCustomerId: input.accountId };
  }

  async createCustomerPortal(input: CreatePortalInput): Promise<{ url: string }> {
    const customerId =
      process.env[`CHARGEBEE_CUSTOMER_${input.accountId}`] ??
      process.env.CHARGEBEE_DEFAULT_CUSTOMER_ID;
    if (!customerId) {
      throw new PaymentProviderError(
        'Chargebee customer id not found for workspace',
        'CUSTOMER_NOT_FOUND',
      );
    }

    const result = await chargebeeForm<{ portal_session?: { access_url?: string } }>(
      '/portal_sessions',
      {
        'customer[id]': customerId,
        redirect_url: input.returnUrl,
      },
    );

    const url = result.portal_session?.access_url;
    if (!url) {
      throw new PaymentProviderError('Chargebee portal URL missing', 'CHECKOUT_URL_MISSING');
    }
    return { url };
  }

  async listInvoices(accountId: string, limit = 12): Promise<BillingInvoice[]> {
    try {
      const customerId =
        process.env[`CHARGEBEE_CUSTOMER_${accountId}`] ??
        process.env.CHARGEBEE_DEFAULT_CUSTOMER_ID;
      if (!customerId) return [];

      const res = await fetch(
        `${apiBase()}/invoices?customer_id[is]=${encodeURIComponent(customerId)}&limit=${limit}`,
        { headers: { Authorization: basicAuthHeader() } },
      );
      if (!res.ok) return [];
      const json = (await res.json()) as {
        list?: Array<{ invoice?: Record<string, unknown> }>;
      };
      return (json.list ?? []).map((row) => {
        const invoice = asRecord(row.invoice);
        return {
          id: String(invoice.id ?? ''),
          date: invoice.date ? new Date(Number(invoice.date) * 1000) : null,
          amount: Number(invoice.total ?? 0),
          currency: String(invoice.currency_code ?? 'USD').toLowerCase(),
          status: String(invoice.status ?? 'unknown'),
          pdfUrl: null,
        };
      });
    } catch {
      return [];
    }
  }

  async getSubscriptionInfo(accountId: string): Promise<SubscriptionInfo> {
    try {
      const customerId =
        process.env[`CHARGEBEE_CUSTOMER_${accountId}`] ??
        process.env.CHARGEBEE_DEFAULT_CUSTOMER_ID;
      if (!customerId) {
        return { renewalDate: null, status: null, providerCustomerId: null };
      }
      const res = await fetch(
        `${apiBase()}/subscriptions?customer_id[is]=${encodeURIComponent(customerId)}&limit=1`,
        { headers: { Authorization: basicAuthHeader() } },
      );
      if (!res.ok) return { renewalDate: null, status: null, providerCustomerId: null };
      const json = (await res.json()) as {
        list?: Array<{ subscription?: Record<string, unknown> }>;
      };
      const sub = asRecord(json.list?.[0]?.subscription);
      return {
        renewalDate: sub.next_billing_at
          ? new Date(Number(sub.next_billing_at) * 1000)
          : null,
        status: String(sub.status ?? '') || null,
        providerCustomerId: customerId,
      };
    } catch {
      return { renewalDate: null, status: null, providerCustomerId: null };
    }
  }

  async verifyAndParseWebhook(input: {
    rawBody: string | Buffer;
    headers: Headers | Record<string, string | null | undefined>;
  }): Promise<BillingEvent[]> {
    verifyChargebeeWebhook(input.rawBody, input.headers);
    const payload = JSON.parse(
      typeof input.rawBody === 'string' ? input.rawBody : input.rawBody.toString('utf8'),
    ) as unknown;
    return chargebeePayloadToBillingEvents(payload);
  }
}

export function createChargebeePaymentProvider(): PaymentProvider {
  return new ChargebeePaymentProvider();
}
