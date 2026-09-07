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

function requireAccessToken(): string {
  const token = process.env.POLAR_ACCESS_TOKEN;
  if (!token) {
    throw new PaymentProviderError('POLAR_ACCESS_TOKEN is not set', 'NOT_CONFIGURED');
  }
  return token;
}

function apiBase(): string {
  return process.env.POLAR_API_BASE?.replace(/\/$/, '') ?? 'https://api.polar.sh';
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${requireAccessToken()}` };
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

export function verifyPolarSignature(
  rawBody: string | Buffer,
  headers: Headers | Record<string, string | null | undefined>,
): void {
  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret) {
    throw new PaymentProviderError('POLAR_WEBHOOK_SECRET is not set', 'NOT_CONFIGURED');
  }

  const msgId = headerGet(headers, 'webhook-id');
  const timestamp = headerGet(headers, 'webhook-timestamp');
  const signature = headerGet(headers, 'webhook-signature');
  if (!msgId || !timestamp || !signature) {
    throw new PaymentProviderError('Missing Polar webhook signing headers', 'INVALID_WEBHOOK');
  }

  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const signedContent = `${msgId}.${timestamp}.${body}`;
  const key = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret, 'utf8');
  const expected = createHmac('sha256', key).update(signedContent).digest('base64');
  const candidates = signature.split(' ').map((part) => part.replace(/^v1,/, ''));
  const ok = candidates.some((candidate) => {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(candidate, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  });
  if (!ok) {
    throw new PaymentProviderError('Invalid Polar webhook signature', 'INVALID_WEBHOOK');
  }
}

export function polarPayloadToBillingEvents(payload: unknown): BillingEvent[] {
  const root = asRecord(payload);
  const type = String(root.type ?? '');
  const data = asRecord(root.data);
  const metadata = asRecord(data.metadata);
  const accountId = accountIdFromCustomData(metadata);
  if (!accountId) return [];

  const productId = String(data.product_id ?? asRecord(data.product).id ?? '');
  const planKey: string =
    resolvePlanKeyFromProviderPriceId('polar', productId) ??
    planKeyFromCustomData(metadata) ??
    'free';
  const customerId =
    String(data.customer_id ?? asRecord(data.customer).id ?? '') || null;

  switch (type) {
    case 'subscription.created':
    case 'subscription.active':
      return [
        {
          type: type === 'subscription.created' ? 'subscription.activated' : 'subscription.updated',
          accountId,
          planKey,
          providerCustomerId: customerId,
          provider: 'polar',
        },
      ];
    case 'checkout.updated':
      if (String(data.status ?? '') !== 'succeeded') return [];
      return [
        {
          type: 'subscription.activated',
          accountId,
          planKey,
          providerCustomerId: customerId,
          provider: 'polar',
        },
      ];
    case 'subscription.updated':
      if (String(data.status ?? '') === 'canceled') {
        return [{ type: 'subscription.canceled', accountId, provider: 'polar' }];
      }
      return [
        {
          type: 'subscription.updated',
          accountId,
          planKey,
          providerCustomerId: customerId,
          provider: 'polar',
        },
      ];
    case 'subscription.revoked':
    case 'subscription.canceled':
      return [{ type: 'subscription.canceled', accountId, provider: 'polar' }];
    default:
      if (type.includes('payment_failed')) {
        return [
          {
            type: 'invoice.payment_failed',
            accountId,
            invoiceId: String(data.id ?? 'polar_payment_failed'),
            provider: 'polar',
          },
        ];
      }
      return [];
  }
}

export class PolarPaymentProvider implements PaymentProvider {
  readonly id = 'polar' as const;

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const productId = getProviderPriceId('polar', input.planKey);
    if (!productId) {
      throw new PaymentProviderError(
        `Polar product not configured for plan ${input.planKey}`,
        'NOT_CONFIGURED',
      );
    }

    const result = await jsonHttp<{ url?: string }>(`${apiBase()}/v1/checkouts/`, {
      headers: authHeaders(),
      body: {
        product_id: productId,
        success_url: input.successUrl,
        customer_email: input.customerEmail ?? undefined,
        metadata: checkoutCustomData({ accountId: input.accountId,
          planKey: input.planKey,
        }),
      },
    });

    if (!result.url) {
      throw new PaymentProviderError('Polar checkout URL missing', 'CHECKOUT_URL_MISSING');
    }
    return { url: result.url, providerCustomerId: input.accountId };
  }

  async createCustomerPortal(input: CreatePortalInput): Promise<{ url: string }> {
    const customerId =
      process.env[`POLAR_CUSTOMER_${input.accountId}`] ??
      process.env.POLAR_DEFAULT_CUSTOMER_ID;
    if (!customerId) {
      throw new PaymentProviderError(
        'Polar customer id not found for workspace',
        'CUSTOMER_NOT_FOUND',
      );
    }

    const result = await jsonHttp<{ customer_portal_url?: string; url?: string }>(
      `${apiBase()}/v1/customer-sessions/`,
      {
        headers: authHeaders(),
        body: { customer_id: customerId },
      },
    );
    const url = result.customer_portal_url ?? result.url;
    if (!url) {
      throw new PaymentProviderError('Polar portal URL missing', 'CHECKOUT_URL_MISSING');
    }
    return { url };
  }

  async listInvoices(_workspaceId: string, _limit = 12): Promise<BillingInvoice[]> {
    return [];
  }

  async getSubscriptionInfo(accountId: string): Promise<SubscriptionInfo> {
    try {
      const result = await jsonHttp<{ items?: Array<Record<string, unknown>> }>(
        `${apiBase()}/v1/subscriptions/?limit=50`,
        { method: 'GET', headers: authHeaders() },
      );
      const match = (result.items ?? []).find(
        (row) => accountIdFromCustomData(asRecord(row.metadata)) === accountId,
      );
      if (!match) return { renewalDate: null, status: null, providerCustomerId: null };
      return {
        renewalDate: match.current_period_end
          ? new Date(String(match.current_period_end))
          : null,
        status: String(match.status ?? '') || null,
        providerCustomerId: String(match.customer_id ?? '') || null,
      };
    } catch {
      return { renewalDate: null, status: null, providerCustomerId: null };
    }
  }

  async verifyAndParseWebhook(input: {
    rawBody: string | Buffer;
    headers: Headers | Record<string, string | null | undefined>;
  }): Promise<BillingEvent[]> {
    verifyPolarSignature(input.rawBody, input.headers);
    const payload = JSON.parse(
      typeof input.rawBody === 'string' ? input.rawBody : input.rawBody.toString('utf8'),
    ) as unknown;
    return polarPayloadToBillingEvents(payload);
  }
}

export function createPolarPaymentProvider(): PaymentProvider {
  return new PolarPaymentProvider();
}
