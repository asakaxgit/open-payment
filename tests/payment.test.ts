import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SUPPORTED_PAYMENT_PROVIDERS,
  configurePriceCatalog,
  getPaymentProvider,
  getProviderPriceId,
  isPaymentProviderId,
  listPaymentProviders,
  resolvePlanKeyFromProviderPriceId,
  setPaymentProviderOverride,
  type PaymentProvider,
} from '../src/index.js';
import { verifyChargebeeWebhook } from '../src/adapters/chargebee.js';

describe('open-payment registry', () => {
  afterEach(() => {
    setPaymentProviderOverride(null);
    configurePriceCatalog({});
    delete process.env.PAYMENT_PROVIDER;
  });

  it('lists major SaaS billing providers', () => {
    expect(listPaymentProviders()).toEqual([
      'stripe',
      'paddle',
      'lemon_squeezy',
      'polar',
      'chargebee',
    ]);
    expect(SUPPORTED_PAYMENT_PROVIDERS).toEqual(listPaymentProviders());
    expect(isPaymentProviderId('stripe')).toBe(true);
    expect(isPaymentProviderId('paypal')).toBe(false);
  });

  it('constructs an adapter for each provider id', () => {
    for (const id of listPaymentProviders()) {
      expect(getPaymentProvider(id).id).toBe(id);
    }
  });

  it('rejects unknown PAYMENT_PROVIDER', () => {
    process.env.PAYMENT_PROVIDER = 'not-a-psp';
    expect(() => getPaymentProvider()).toThrow(/Unsupported PAYMENT_PROVIDER/);
  });

  it('resolves price ids from configurePriceCatalog', () => {
    configurePriceCatalog({
      stripe: { pro: 'price_pro', business: 'price_biz' },
    });
    expect(getProviderPriceId('stripe', 'pro')).toBe('price_pro');
    expect(resolvePlanKeyFromProviderPriceId('stripe', 'price_biz')).toBe('business');
  });

  it('accepts overrides', () => {
    const fake: PaymentProvider = {
      id: 'stripe',
      createCheckout: vi.fn(),
      createCustomerPortal: vi.fn(),
      listInvoices: vi.fn(),
      getSubscriptionInfo: vi.fn(),
      verifyAndParseWebhook: vi.fn(),
    };
    setPaymentProviderOverride(fake);
    expect(getPaymentProvider()).toBe(fake);
  });
});

describe('chargebee webhook verification', () => {
  const ENV_KEYS = [
    'CHARGEBEE_WEBHOOK_USERNAME',
    'CHARGEBEE_WEBHOOK_PASSWORD',
    'CHARGEBEE_WEBHOOK_HMAC_SECRET',
  ] as const;

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  const body = '{"event_type":"subscription_created"}';

  function basicHeader(user: string, pass: string): Record<string, string> {
    return { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
  }

  it('fails closed when only the username is configured', () => {
    process.env.CHARGEBEE_WEBHOOK_USERNAME = 'hook-user';
    expect(() => verifyChargebeeWebhook(body, {})).toThrow(/Set both CHARGEBEE_WEBHOOK/);
  });

  it('fails closed when only the password is configured', () => {
    process.env.CHARGEBEE_WEBHOOK_PASSWORD = 'hook-pass';
    expect(() => verifyChargebeeWebhook(body, {})).toThrow(/Set both CHARGEBEE_WEBHOOK/);
  });

  it('rejects when nothing is configured', () => {
    expect(() => verifyChargebeeWebhook(body, {})).toThrow(/Configure CHARGEBEE_WEBHOOK/);
  });

  it('accepts a correct basic auth pair and rejects a wrong one', () => {
    process.env.CHARGEBEE_WEBHOOK_USERNAME = 'hook-user';
    process.env.CHARGEBEE_WEBHOOK_PASSWORD = 'hook-pass';
    expect(() => verifyChargebeeWebhook(body, basicHeader('hook-user', 'hook-pass'))).not.toThrow();
    expect(() => verifyChargebeeWebhook(body, basicHeader('hook-user', 'nope'))).toThrow(
      /Invalid Chargebee basic auth/,
    );
    expect(() => verifyChargebeeWebhook(body, {})).toThrow(/Missing Chargebee basic auth/);
  });

  it('verifies the hmac signature when configured alone', () => {
    process.env.CHARGEBEE_WEBHOOK_HMAC_SECRET = 'shhh';
    const digest = createHmac('sha256', 'shhh').update(body).digest('hex');
    expect(() =>
      verifyChargebeeWebhook(body, { 'chargebee-webhook-signature': digest }),
    ).not.toThrow();
    expect(() =>
      verifyChargebeeWebhook(body, { 'chargebee-webhook-signature': 'a'.repeat(64) }),
    ).toThrow(/Invalid Chargebee HMAC signature/);
  });
});
