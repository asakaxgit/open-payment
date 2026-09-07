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
  const key = process.env.LEMON_SQUEEZY_API_KEY;
  if (!key) {
    throw new PaymentProviderError('LEMON_SQUEEZY_API_KEY is not set', 'NOT_CONFIGURED');
  }
  return key;
}

function storeId(): string {
  const id = process.env.LEMON_SQUEEZY_STORE_ID;
  if (!id) {
    throw new PaymentProviderError('LEMON_SQUEEZY_STORE_ID is not set', 'NOT_CONFIGURED');
  }
  return id;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${requireApiKey()}`,
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
  };
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

export function verifyLemonSqueezySignature(
  rawBody: string | Buffer,
  signatureHeader: string,
): void {
  const secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
  if (!secret) {
    throw new PaymentProviderError('LEMON_SQUEEZY_WEBHOOK_SECRET is not set', 'NOT_CONFIGURED');
  }
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const digest = createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(signatureHeader, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new PaymentProviderError('Invalid Lemon Squeezy webhook signature', 'INVALID_WEBHOOK');
  }
}

export function lemonSqueezyPayloadToBillingEvents(payload: unknown): BillingEvent[] {
  const root = asRecord(payload);
  const meta = asRecord(root.meta);
  const eventName = String(meta.event_name ?? '');
  const custom = asRecord(meta.custom_data);
  const data = asRecord(root.data);
  const attrs = asRecord(data.attributes);

  const accountId =
    accountIdFromCustomData(custom) ??
    accountIdFromCustomData(asRecord(attrs.custom_data));
  if (!accountId) return [];

  const variantId = String(attrs.variant_id ?? '');
  const planKey: string =
    resolvePlanKeyFromProviderPriceId('lemon_squeezy', variantId) ??
    planKeyFromCustomData(custom) ??
    planKeyFromCustomData(asRecord(attrs.custom_data)) ??
    'free';
  const customerId = String(attrs.customer_id ?? '') || null;

  switch (eventName) {
    case 'subscription_created':
      return [
        {
          type: 'subscription.activated',
          accountId,
          planKey,
          providerCustomerId: customerId,
          provider: 'lemon_squeezy',
        },
      ];
    case 'subscription_updated': {
      const status = String(attrs.status ?? '');
      if (status === 'cancelled' || status === 'expired') {
        return [{ type: 'subscription.canceled', accountId, provider: 'lemon_squeezy' }];
      }
      return [
        {
          type: 'subscription.updated',
          accountId,
          planKey,
          providerCustomerId: customerId,
          provider: 'lemon_squeezy',
        },
      ];
    }
    case 'subscription_cancelled':
    case 'subscription_expired':
      return [{ type: 'subscription.canceled', accountId, provider: 'lemon_squeezy' }];
    case 'subscription_payment_failed':
      return [
        {
          type: 'invoice.payment_failed',
          accountId,
          invoiceId: String(data.id ?? 'lemon_payment_failed'),
          provider: 'lemon_squeezy',
        },
      ];
    default:
      return [];
  }
}

export class LemonSqueezyPaymentProvider implements PaymentProvider {
  readonly id = 'lemon_squeezy' as const;

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const variantId = getProviderPriceId('lemon_squeezy', input.planKey);
    if (!variantId) {
      throw new PaymentProviderError(
        `Lemon Squeezy variant not configured for plan ${input.planKey}`,
        'NOT_CONFIGURED',
      );
    }

    const custom = checkoutCustomData({ accountId: input.accountId,
      planKey: input.planKey,
    });

    const result = await jsonHttp<{
      data?: { attributes?: { url?: string } };
    }>('https://api.lemonsqueezy.com/v1/checkouts', {
      headers: authHeaders(),
      body: {
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              email: input.customerEmail ?? undefined,
              custom,
              name: input.accountName,
            },
            product_options: {
              redirect_url: input.successUrl,
            },
          },
          relationships: {
            store: { data: { type: 'stores', id: storeId() } },
            variant: { data: { type: 'variants', id: String(variantId) } },
          },
        },
      },
    });

    const url = result.data?.attributes?.url;
    if (!url) {
      throw new PaymentProviderError(
        'Lemon Squeezy checkout URL missing',
        'CHECKOUT_URL_MISSING',
      );
    }
    return { url, providerCustomerId: input.accountId };
  }

  async createCustomerPortal(input: CreatePortalInput): Promise<{ url: string }> {
    const customerId =
      process.env[`LEMON_SQUEEZY_CUSTOMER_${input.accountId}`] ??
      process.env.LEMON_SQUEEZY_DEFAULT_CUSTOMER_ID;
    if (!customerId) {
      throw new PaymentProviderError(
        'Lemon Squeezy customer id not found for workspace',
        'CUSTOMER_NOT_FOUND',
      );
    }

    const result = await jsonHttp<{
      data?: { attributes?: { urls?: { customer_portal?: string } } };
    }>(`https://api.lemonsqueezy.com/v1/customers/${encodeURIComponent(customerId)}`, {
      method: 'GET',
      headers: authHeaders(),
    });

    const url = result.data?.attributes?.urls?.customer_portal;
    if (!url) {
      throw new PaymentProviderError(
        'Lemon Squeezy customer portal URL missing',
        'CHECKOUT_URL_MISSING',
      );
    }
    return { url };
  }

  async listInvoices(_workspaceId: string, _limit = 12): Promise<BillingInvoice[]> {
    return [];
  }

  async getSubscriptionInfo(accountId: string): Promise<SubscriptionInfo> {
    try {
      const result = await jsonHttp<{ data?: Array<Record<string, unknown>> }>(
        'https://api.lemonsqueezy.com/v1/subscriptions',
        { method: 'GET', headers: authHeaders() },
      );
      const match = (result.data ?? []).find((row) => {
        const attrs = asRecord(row.attributes);
        return accountIdFromCustomData(asRecord(attrs.custom_data)) === accountId;
      });
      if (!match) return { renewalDate: null, status: null, providerCustomerId: null };
      const attrs = asRecord(match.attributes);
      return {
        renewalDate: attrs.renews_at ? new Date(String(attrs.renews_at)) : null,
        status: String(attrs.status ?? '') || null,
        providerCustomerId: String(attrs.customer_id ?? '') || null,
      };
    } catch {
      return { renewalDate: null, status: null, providerCustomerId: null };
    }
  }

  async verifyAndParseWebhook(input: {
    rawBody: string | Buffer;
    headers: Headers | Record<string, string | null | undefined>;
  }): Promise<BillingEvent[]> {
    const signature = headerGet(input.headers, 'x-signature');
    if (!signature) {
      throw new PaymentProviderError('Missing X-Signature', 'INVALID_WEBHOOK');
    }
    verifyLemonSqueezySignature(input.rawBody, signature);
    const payload = JSON.parse(
      typeof input.rawBody === 'string' ? input.rawBody : input.rawBody.toString('utf8'),
    ) as unknown;
    return lemonSqueezyPayloadToBillingEvents(payload);
  }
}

export function createLemonSqueezyPaymentProvider(): PaymentProvider {
  return new LemonSqueezyPaymentProvider();
}
