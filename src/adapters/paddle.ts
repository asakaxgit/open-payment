import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  checkoutCustomData,
  getProviderPriceId,
  planKeyFromCustomData,
  resolvePlanKeyFromProviderPriceId,
  accountIdFromCustomData,
} from '../catalog.js';
import { jsonHttp } from '../http.js';
import { PaymentProviderError, type PaymentProvider } from '../provider.js';
import type {
  BillingEvent,
  BillingInvoice,
  CreateCheckoutInput,
  CreateCheckoutResult,
  CreatePortalInput,
  SubscriptionInfo,
} from '../types.js';

function requireApiKey(): string {
  const key = process.env.PADDLE_API_KEY;
  if (!key) throw new PaymentProviderError('PADDLE_API_KEY is not set', 'NOT_CONFIGURED');
  return key;
}

function apiBase(): string {
  return process.env.PADDLE_API_BASE?.replace(/\/$/, '') ?? 'https://api.paddle.com';
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${requireApiKey()}` };
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

export function verifyPaddleSignature(rawBody: string | Buffer, signatureHeader: string): void {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) {
    throw new PaymentProviderError('PADDLE_WEBHOOK_SECRET is not set', 'NOT_CONFIGURED');
  }
  const parts = Object.fromEntries(
    signatureHeader.split(';').map((part) => {
      const [k, v] = part.split('=');
      return [k?.trim() ?? '', v?.trim() ?? ''] as const;
    }),
  );
  if (!parts.ts || !parts.h1) {
    throw new PaymentProviderError('Invalid Paddle-Signature header', 'INVALID_WEBHOOK');
  }
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = createHmac('sha256', secret).update(`${parts.ts}:${body}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(parts.h1, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new PaymentProviderError('Invalid Paddle webhook signature', 'INVALID_WEBHOOK');
  }
}

export function paddlePayloadToBillingEvents(payload: unknown): BillingEvent[] {
  const root = asRecord(payload);
  const eventType = String(root.event_type ?? '');
  const data = asRecord(root.data);
  const custom = asRecord(data.custom_data);
  const accountId = accountIdFromCustomData(custom);
  if (!accountId) return [];

  const firstItem = Array.isArray(data.items) ? asRecord(data.items[0]) : {};
  const priceId = String(asRecord(firstItem.price).id ?? '');
  const planKey: string =
    resolvePlanKeyFromProviderPriceId('paddle', priceId) ??
    planKeyFromCustomData(custom) ??
    'free';
  const customerId = String(data.customer_id ?? '') || null;

  switch (eventType) {
    case 'subscription.created':
    case 'subscription.activated':
      return [
        {
          type: 'subscription.activated',
          accountId,
          planKey,
          providerCustomerId: customerId,
          provider: 'paddle',
        },
      ];
    case 'subscription.updated':
      if (String(data.status ?? '') === 'canceled') {
        return [{ type: 'subscription.canceled', accountId, provider: 'paddle' }];
      }
      return [
        {
          type: 'subscription.updated',
          accountId,
          planKey,
          providerCustomerId: customerId,
          provider: 'paddle',
        },
      ];
    case 'subscription.canceled':
      return [{ type: 'subscription.canceled', accountId, provider: 'paddle' }];
    case 'subscription.past_due':
    case 'transaction.payment_failed':
      return [
        {
          type: 'invoice.payment_failed',
          accountId,
          invoiceId: String(data.id ?? 'paddle_payment_failed'),
          provider: 'paddle',
        },
      ];
    default:
      return [];
  }
}

export class PaddlePaymentProvider implements PaymentProvider {
  readonly id = 'paddle' as const;

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const priceId = getProviderPriceId('paddle', input.planKey);
    if (!priceId) {
      throw new PaymentProviderError(
        `Paddle price not configured for plan ${input.planKey}`,
        'NOT_CONFIGURED',
      );
    }

    const result = await jsonHttp<{ data: { id: string; checkout?: { url?: string } } }>(
      `${apiBase()}/transactions`,
      {
        headers: authHeaders(),
        body: {
          items: [{ price_id: priceId, quantity: 1 }],
          custom_data: checkoutCustomData({ accountId: input.accountId,
            planKey: input.planKey,
          }),
          ...(input.customerEmail ? { customer: { email: input.customerEmail } } : {}),
        },
      },
    );

    const url =
      result.data.checkout?.url ??
      (result.data.id ? `https://pay.paddle.com/transaction/${result.data.id}` : null);
    if (!url) {
      throw new PaymentProviderError('Paddle checkout URL missing', 'CHECKOUT_URL_MISSING');
    }
    return { url, providerCustomerId: input.accountId };
  }

  async createCustomerPortal(input: CreatePortalInput): Promise<{ url: string }> {
    const customerId =
      process.env[`PADDLE_CUSTOMER_${input.accountId}`] ??
      process.env.PADDLE_DEFAULT_CUSTOMER_ID;
    if (!customerId) {
      throw new PaymentProviderError(
        'Paddle customer id not found for workspace',
        'CUSTOMER_NOT_FOUND',
      );
    }

    const result = await jsonHttp<{
      data: { urls?: { general?: { overview?: string } } };
    }>(`${apiBase()}/customers/${encodeURIComponent(customerId)}/portal-sessions`, {
      headers: authHeaders(),
      body: {},
    });

    const url = result.data.urls?.general?.overview;
    if (!url) {
      throw new PaymentProviderError('Paddle portal URL missing', 'CHECKOUT_URL_MISSING');
    }
    return { url };
  }

  async listInvoices(accountId: string, limit = 12): Promise<BillingInvoice[]> {
    try {
      const result = await jsonHttp<{ data: Array<Record<string, unknown>> }>(
        `${apiBase()}/transactions?order_by=created_at[DESC]&per_page=${limit}`,
        { headers: authHeaders() },
      );
      return (result.data ?? [])
        .filter((tx) => accountIdFromCustomData(asRecord(tx.custom_data)) === accountId)
        .map((tx) => ({
          id: String(tx.id ?? ''),
          date: tx.created_at ? new Date(String(tx.created_at)) : null,
          amount: Number(asRecord(asRecord(tx.details).totals).grand_total ?? 0),
          currency: String(tx.currency_code ?? 'usd').toLowerCase(),
          status: String(tx.status ?? 'unknown'),
          pdfUrl: null,
        }));
    } catch {
      return [];
    }
  }

  async getSubscriptionInfo(accountId: string): Promise<SubscriptionInfo> {
    try {
      const result = await jsonHttp<{ data: Array<Record<string, unknown>> }>(
        `${apiBase()}/subscriptions?per_page=50`,
        { headers: authHeaders() },
      );
      const sub = (result.data ?? []).find(
        (row) => accountIdFromCustomData(asRecord(row.custom_data)) === accountId,
      );
      if (!sub) return { renewalDate: null, status: null, providerCustomerId: null };
      const endsAt = asRecord(sub.current_billing_period).ends_at;
      return {
        renewalDate: endsAt ? new Date(String(endsAt)) : null,
        status: String(sub.status ?? '') || null,
        providerCustomerId: String(sub.customer_id ?? '') || null,
      };
    } catch {
      return { renewalDate: null, status: null, providerCustomerId: null };
    }
  }

  async verifyAndParseWebhook(input: {
    rawBody: string | Buffer;
    headers: Headers | Record<string, string | null | undefined>;
  }): Promise<BillingEvent[]> {
    const signature = headerGet(input.headers, 'paddle-signature');
    if (!signature) {
      throw new PaymentProviderError('Missing Paddle-Signature', 'INVALID_WEBHOOK');
    }
    verifyPaddleSignature(input.rawBody, signature);
    const payload = JSON.parse(
      typeof input.rawBody === 'string' ? input.rawBody : input.rawBody.toString('utf8'),
    ) as unknown;
    return paddlePayloadToBillingEvents(payload);
  }
}

export function createPaddlePaymentProvider(): PaymentProvider {
  return new PaddlePaymentProvider();
}
